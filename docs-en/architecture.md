# Architecture

This document is the active map of structure and runtime flow for contributors.

The owner's phase roadmap is not available in this checkout; do not infer phase
status or next actions from the changelog or the code. `TERMINAL_CONTRACT.md` is
the FROZEN terminal contract — read it before changing output; behaviour changes
require a contract update and a protection test map. The active output contracts
live in the [event model](OUTPUT_EVENT_MODEL.md), [protocol](OUTPUT_PROTOCOL_SPEC.md),
[rendering](OUTPUT_RENDERING_SPEC.md), and [UX rules](OUTPUT_UX_RULES.md). The
rendering flow map is in [UI Render Pipeline](UI_RENDER_PIPELINE.md).

## Three layers

```
L1 cli/ + src/ui/   -> thin controller + self-contained presentation
L2 src/ non-ui      -> agent: tools, agents, hooks, policy, providers, mcp, lsp, session, skills
L3 vendor/minicore  -> kernel STATE/MODEL/ACTION/LOOP (vendored, host-editable, zero-dep, via #minicore)
```

The kernel is vendored and **host-editable** since v0.16.0 (see the
[MiniCore vendor note](https://github.com/minilabs-id/minicode/blob/main/vendor/minicore/VENDOR.md));
source commit `0d33571` is only a historical provenance reference, not a hard
invariant. Application kernel imports go only through `#minicore`.

Host patches the runtime needs live in `scripts/vendor-overlays/` and are applied
during vendor sync. `bun run vendor:check` is still usable as a provenance
diagnostic tool, but not as a gate: the hash recorded in `VENDOR.md` is a
historical checkpoint and does not change when the kernel is edited on the host.

- `cli/` may import `src/ui/` + `src/`; non-ui `src/` is forbidden to import `src/ui/`; `src/ui/` is forbidden to import `cli/`, non-ui `src/`, `#minicore`. Enforced by `test/ui-boundary.test.ts`.
- The single UI<->outside window: `src/ui/contract.ts` (`UiEvent/UiBus/UiStep/UiExecution`).
- DI from the composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer -> loadLastModel -> createRagLayer -> resume presentation-events + planRecovery + reconcileUndoRedo -> setupToolLayer + setAskTextFn -> createMinicodeSession -> journal + checkpoint + semantic event sink + step-trace + runPromptWithVerify (baseline-first + 3-cycle self-heal + hooks) -> logger + turn-status + usage/pricing -> persist/finalize -> close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` before dispatch so TUI/one-shot/`mcp serve` are all covered.
- `providers -> config` one-way (`src/providers/provision.ts` provisioning, `src/config.ts` pure IO).

## The flow of one prompt

`prompt -> permission check -> validateArgs (kernel) -> executor (order/cap/abort-aware) -> P2.10 canonical tool wrapper (await EffectIntent -> execute -> await EffectReceipt) -> realpath+atomic tool -> checkpoint shadow-git + journal + step-trace -> compaction (synchronous mechanical; async LLM via the `compactAsync` seam) -> usage/pricing per-segment longest-key -> trace`.

## Context & durable state

Model context is **working memory**, not state. Three layers with different
owners:

| Layer | Contents | Authoritative for |
|---|---|---|
| Kernel `ContextStore` | the history sent to the model, possibly lossy after compaction | the running window |
| `messages` table (durable) | `role, content, toolCalls, toolCallId, name, reasoning, is_error`; may be replaced during compaction shrink | continuity/resume from the currently stored shape |
| Vector memory + `presentation_events` | best-effort memory summaries and selected semantic events | RAG & UI audit; not a full copy of the conversation |

Compaction is lossy, including after a restart. `persistCurrent` sends the
compacted history to `shrinkThreadHistory`, which deletes and rewrites `messages`
rows; the mechanical fold summarises old messages while **preserving** tool
results (head-truncated per role) — not discarding them. The summary to vector
memory is only created on the LLM path, bounded, opt-out, and best-effort. So do
not assume every old fact remains recoverable from the session or the vector
store; important state must be recorded in tasks, files, or authoritative
verification artefacts.

Resume fidelity: `reasoning` (thinking) and `is_error` (failed tool) are kernel
`Message` fields carried into history. Originally neither had a column, so resume
produced blind context. Both are now `messages` columns and **must be included in
the prefix comparison** in `saveSession` — otherwise a change only in
`reasoning`/`is_error` is seen as "unchanged" and the incremental append skips it
(the F-05 bug class). The columns are additive, so old DBs still read and old
turns resume with the field absent.

Writes stay incremental: `saveSession` only inserts new rows when the prefix
matches, instead of rewriting the whole history. This is why a per-turn JSON
sidecar was rejected — a 400-message history measured 62 ms encode + 53 ms blob
write per turn (O(history)), so ~115 ms per turn, while the shared `messages`
path with prefix-compare is 10 ms.

## Task system (durable work state)

Task state is **not** chat history and **not** a tool trace. Its semantic owner is
`src/tools/todo.ts`; `.minicode/todos/<id>.json` is the only source of truth, and
`plan.updated` (the durable event for ACP/`exec --json`) is only a **projection**
of that file.

```text
todo_write (model) -> normalizeTodos -> .minicode/todos/<id>.json   (state)
                            |                    ^
                            |                    | setCompletionEvidence
                            |            last verify evidence
                            v
                     plan.updated (projection, emitted AFTER the tool succeeds)
```

Three rules hold this domain together:

1. **Canonical session identity (P2.1).** Todos are bound to the canonical `sid`
   from `resolveSessionIdentity` (`src/session/identity.ts`), not the volatile
   process id (`bootId`). `--resume` without `--session` no longer forges a random
   id; an unknown `--resume` fails explicitly (`SESSION_NOT_FOUND`).
2. **Completion needs evidence.** `setCompletionEvidence()` injects a verdict
   (`unverified` | `passed` | `failed`) from the composition root. `failed` refuses
   `completed` -> the task becomes `blocked` + its reason, and the result is
   reported to the model. The `unverified` default keeps usage without `--verify`
   POSSIBLE; what is forbidden is silent completion without a trace.
3. **One normaliser, two stores.** `planFromTodos` (the adapter) calls the same
   `normalizeTodos` as the file, so status/cap/`blocked` cannot diverge — and the
   plan event is emitted at `execution:completed`, not from the arguments before
   the tool runs.

Boundary of the **todo** subsystem: todo files stay flat — no dependency field in
`TodoItem`, no user surface (`/tasks`), `/undo` only reverts the file (todos stay
`completed`), and no TTL/GC for todo files outside SQLite. Dependencies/graph and
scheduling **do exist**, but in a separate subsystem: the TaskGraph + Scheduler in
`src/task/` operate on the TaskStore (`.minicode/tasks.db`), not on todo files;
`todo_write` may only touch it through a canonical `taskId` (`src/tools/todo.ts`),
and its control surface is `/scheduler` (off by default).

## Verification evidence (P2.10)

`src/session/verification.ts` + `src/tools/evidence.ts` write the invocation
identity, pre-effect intent, post-execution receipt, and explicit observation into
the same mutation journal (`src/session/journal.ts`). `committed` means an
observed tool return, not a proven external effect; `pending` remains UNKNOWN.
Verification writes no `messages`, projections, presentation, Run, or cursor.

## Terminal UI/UX (FROZEN contract)

An interactive session (`minicode` on a capable TTY) ALWAYS opens the
**fullscreen alternate-screen** TUI: a shell-like transcript + a one-line status
bar + composite popups on top of the still-visible (dimmed) transcript. The
non-interactive path (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`,
screens under 10 lines) stays shell-first: plain append-only output to the
scrollback with no cursor control.

| Stream | Contents |
|---|---|
| stdout | Program output: model text, change receipts (`> write_file ...`), command listings/artefacts. Free of cursor control when non-TTY |
| stderr | Progress/diagnostics: the tool ledger (`> ...` green/red), reasoning (verbose), warnings, errors. May be transient on a TTY |
| Both | Colour only on a TTY (`stdout.isTTY`); `NO_COLOR` wins; `TERM`/`COLORTERM` do not turn colour on in a pipe |

The single transient arbitrator: `src/ui/runtime/statusline.ts`
(`acquireTransientPaint` + `paintWrite`). Active painters (turn status line vs
wizard spinner vs loading bar) are mutually exclusive; overlap = a
`[transient-paint]` signal, not a crash. A foreign stderr writer (non-UI) may write
raw — the arbitrator commits it as a clean permanent line.
`beginInteractiveScreen` holds all those painters while the interactive screen owns
the terminal; a foreign write while alt-screen is live also marks the terminal
"dirty" (`consumeScreenDrift`) so the screen forces a full repaint on the next
paint. The startup loading bar (`src/ui/runtime/loading-bar.ts`) is the second kind
of transient painter: a single-line `▓░` block + percent + label, redrawn only when
`update(label, percent)` is called, TTY-only (non-TTY = zero bytes, a no-op), label
sanitised. Startup-phase diagnostics (identity/writer/resume/recovery/context) are
deferred to `ctx.startupNotices` for the REPL and flushed into the TUI transcript;
non-interactive still prints them directly. 35 invariants (I1-I35) + the test map
(`tui-app`, `screen-buffer`, `tui-popup`, `transient-arbitration`, `loading-bar`,
`input-resize`, `exit-codes`, `acp`, `ui-boundary`) are in `TERMINAL_CONTRACT.md`.
That contract also carries a **protection gap map** — claims whose implementation
is correct but has no guarding assertion yet; that is a work list, not a green list.

Six display primitives (all inside the fullscreen TUI when interactive): the
`minicode >` transcript shown at boot/idle and returning automatically after a
turn + model answer + ledger `  > name target` green / `  > name: ...` red; a
one-line status bar (`✦ 00.00.00 Discuss  model  cwd ... context  Auto ●` — mode
values only, product labels `Work Mode:`/`Permission Mode:` removed in v0.24; the
`●` dot is yellow = allow-list active, grey = inactive, red `○` = unrestricted, a
`◷ N` badge when background jobs are alive), with new sessions at `DISCUSS`+`AUTO`,
Work Mode choices only Discuss/Plan/Build and Permission Mode only Auto/Ask; Work
Mode on the left and Permission Mode in cyan right-aligned near the context (timer
dim when idle, only seconds white when active, minutes light up after 60 s, hours
after 1 h; process sparkle; no bullet separator; `src/ui/tui/app.ts` renders the
composer dots and one spacer above the footer per frame); a single-box composite
popup (`/model`, `/provider`, `/sessions`, forms, approvals) via
`openAltScreen`/`paintRegion`; dimmed thinking without a transcript marker (composer
dots; content via `/expand`); an actionable error message in red once per failure
(`takePendingError`). Command status/confirmation (sync, auth, config, spinner) uses
colour only, without icons.

## Key modules

- `src/session/verification.ts` + `src/tools/evidence.ts`: application-owned invocation identity, awaited intent/receipt, explicit observation, idempotency, and child-effect correlation — all in the same mutation journal.

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`), `width.ts` (columns), `sanitize.ts` (only SGR passes), `ledger.ts` (status word/glyph/paint + shared run marker for TUI & linear), `markdown.ts`, `markdown-table.ts` (streaming pipe-table parser), `table-grid.ts` (terminal grid budget), `cells.ts` (grapheme+SGR framebuffer + a "rewrite the tail" diff for incremental writes), `composer-wrap.ts` (incremental composer wrap), `highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`.
- `src/presentation/`: `events.ts` defines presentation events and the durability registry; `adapter.ts` maps runtime to `DomainEvent`; `reducer.ts`/`model.ts` build replayable state and derived summaries; `store.ts` stores content references; `projection.ts` forms the `minicode.output.v1` envelope and machine error categories. `src/session/persistence.ts` stores the `presentation_events` and `messages` logs with `reasoning`/`is_error` fidelity. `cli/setup.ts` owns the exhaustive `toPresentationEvent()` bridge; the TUI/linear/machine renderers use policy decisions via `PresentationPolicy` injection.
- `src/policy/`: `context.ts` (density-aware code/JSON estimator + usage calibration), `context-window.ts` + `context-window-catalog.ts` (window resolution: config -> catalogue -> models.dev -> 128K alias default -> 32K), `bpe.ts` + `tokenizer-registry.ts` (on-demand precise BPE tokenizers from HuggingFace, local cache, density fallback), `compaction.ts` (LLM + mechanical compaction, anti-drift/anti-thrash, prefers the session provider), `usage.ts`/`pricing.ts` (cost estimates + models.dev).
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + normalised wheel; app-level selection in the TUI).
- `src/ui/screens/`: pure views `picker/wizard/model-manager/provider-manager`.
- `src/ui/assistant/simple.ts`: linear printer + OSC52 clipboard. `turn-status.ts`: the transient line. `approval/prompt.ts`: `promptAsk/promptAskText`.
- `src/daemon/`: hosted-session runtime, discovery, framed IPC/capabilities, replay, approval brokerage, child supervision, and ordered shutdown; composition via `cli/commands/daemon.ts`.
- `src/runtime/`: application admission and execution kernel (`dispatch.ts`, `execution-kernel.ts`, `production-execution.ts`) plus recovery (`recovery.ts`).
- Quality: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).