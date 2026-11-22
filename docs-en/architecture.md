# Architecture

This document is the active map of structure and runtime flow for contributors.

The owner's phase roadmap is not available in this checkout; do not infer phase
status or next actions from the changelog or the code. `TERMINAL_CONTRACT.md` is
the FROZEN terminal contract — read it before changing output; behaviour changes
require a contract update and a protection test map. The active output contracts
live in the [event model](../OUTPUT_EVENT_MODEL.md), [protocol](../OUTPUT_PROTOCOL_SPEC.md),
[rendering](../OUTPUT_RENDERING_SPEC.md), and [UX rules](../OUTPUT_UX_RULES.md). The
rendering flow map is in [UI Render Pipeline](../UI_RENDER_PIPELINE.md).

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
- DI from the composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer -> loadLastModel -> createRagLayer -> resume presentation-events + planRecovery + reconcileUndoRedo -> setupToolLayer + setAskTextFn -> createMinicodeSession -> journal + checkpoint + semantic event sink + step-trace + runPromptWithVerify (baseline-first + 3-cycle self-heal + hooks) -> logger + turn-status + usage/pricing -> persist/finalize -> close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` before dispatch so TUI/one-shot/`mcp serve` are all covered. There is no `SidebarModel` DI any more: since v0.34 the sidebar is gone entirely, and the centred chat-column geometry is computed from the terminal width in `src/ui/render/chat-column.ts` and consumed by the TUI painter inside the same frame.
- `providers -> config` one-way (`src/providers/provision.ts` provisioning, `src/config.ts` pure IO).

## The flow of one prompt

Steering: `Session.steer(text)` (called by the host when the user presses Enter
while a turn runs) places the text in a kernel queue, and the loop injects it as
a `user` message at a **step boundary** — before the next provider request, never
mid-stream. With no active turn `steer()` returns `false` (it never buffers
silently); the host then runs the text as the next turn.

`prompt -> permission check -> validateArgs (kernel) -> executor (order/cap/abort-aware) -> P2.10 canonical tool wrapper (await EffectIntent -> execute -> await EffectReceipt) -> realpath+atomic tool -> checkpoint shadow-git + journal + step-trace -> compaction (synchronous mechanical; async LLM via the `compactAsync` seam) -> usage/pricing per-segment longest-key -> trace`.

## Footer recap & tool activity labels (v0.35)

Since v0.35 the tool recap is **not live state**: it is written as a **static
committed row** in the transcript, not a transient row that changes as tools
arrive. The footer of each narration follows
`tool -> narration -> └ recap(tools before that narration)` — the `└` row lands
right after the narration and counts the tools that happened **before** it. The
**final recap of a turn** is cumulative for **all** tools in that turn (not a
per-segment slice that resets), formatted as one line:
`└ 2 command · 118 read · 1 other`. The older clauses — a two-line live recap,
a net-zero `flushActivityFold`, `liveSummaryRows()` following the tail, and a
floating separator row between narrations — are **v0.33/v7.x archive material
overridden by v0.35**; see the [Terminal Contract](../TERMINAL_CONTRACT.md) for
precedence.

```text
tool done -> model narration -> └ recap(tools before narration)   [committed, static]
                                     |
                                     └- end of turn: cumulative for all tools
```

Tool activity labels `› …` use the **system/OS language** — locale resolved
through `Intl`, mapped to `id`/`en` — on **every surface**: the TUI painter, the
`src/ui/assistant/simple.ts` linear printer for one-shot/`exec`, and ACP.
Narration/progress/final model answers still use the user's language
(`/lang`, with `MINICODE_LANG` as fallback). This is a narrow exception to the
old i18n precedence (`/lang` > `MINICODE_LANG` > state.json > OS > en): for the
`› …` label only, the **OS locale wins**, so tool vocabulary stays consistent
across surfaces. Resolution lives in `src/ui/render/tool-label.ts`, shared by
the TUI and `simple.ts` rather than duplicated.

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
`TodoItem`, no user surface (`/tasks`), `/undo` restores files and conversation via a branch session but leaves todo status untouched, and no TTL/GC for todo files outside SQLite. Dependencies/graph and
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
bar + composite popups on top of the still-visible (dimmed) transcript. Since
v0.34 the **right sidebar is removed**: the chat is a centred middle column —
`cols ≥ 120 && rows ≥ 20` gives `chatCols = floor(cols/2)` (max 50% of the
terminal) with left/right padding and a centred footer/composer; below that
threshold the chat uses the full width. Popups/modals remain full-screen centred
on `cols` (I20 unchanged), and one frame / one `stdout.write` (I1) is unchanged.
Since v0.36 the composer is capped at **2 lines** (long drafts use a sliding
window — no added lines and no transcript shift); the `/` dropdown is an
**overlay inside the same frame**, without reducing `viewH` (no separate
`paintRegion()`, avoiding a second write and flicker on steer); prompt/cursor
width comes from the single helper `composerWidth()` (v0.36 cap
`min(100, chatWidth())`, **superseded in v0.37** by the progressive cap
`min(chatCols, 100 + floor(max(0, chatCols-100)/4))`); the prefix adapts —
`minicode › ` when the content room `w−14 ≥ 24` (v0.37; v0.36 used ≥60 columns),
else `› `, with `· ` for continuation rows. Since v0.37 bracketed paste is active
and `Ctrl+A` = select-all with an empty composer and closed dropdown, with a
resize stabiliser.
The non-interactive path (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`,
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
paint. The startup progress line (`MINICODE_STARTUP_PROGRESS=0` disables it) is now a
single `start NN%` line — `update NN%` for auto-update — overwritten in place with
`\r`, without a logo, using real figures from the 9 phases of `createCliSession`
and closing with `start 100%`. The startup loading bar (`src/ui/runtime/loading-bar.ts`)
is the second kind of transient painter: a single-line `▓░` block + percent + label,
redrawn only when `update(label, percent)` is called, TTY-only (non-TTY = zero
bytes, a no-op), label sanitised. Startup-phase diagnostics
(identity/writer/resume/recovery/context) are deferred to `ctx.startupNotices` for
the REPL and flushed into the TUI transcript; non-interactive still prints them
directly. 37 invariants (I1–I37; I36 = command output window, I37 = recovery/approval —
neither is a sidebar invariant) + the test map (`tui-app`, `screen-buffer`,
`tui-popup`, `transient-arbitration`, `loading-bar`, `input-resize`, `exit-codes`,
`acp`, `ui-boundary`, `chat-column` for v0.34 centred-column geometry, plus
`retry-visibility`, `perf-no-quadratic`, `shell-tokenize`, `subagent-budget`) are in
`TERMINAL_CONTRACT.md`. The old `sidebar-invariants`, `sidebar-model`,
`sidebar-width` and `thinking-truncation` claims were revoked with the sidebar.
That contract also carries a **protection gap map** — claims whose implementation
is correct but has no guarding assertion yet; that is a work list, not a green list.

Seven display primitives (all inside the fullscreen TUI when interactive): the
`minicode >` transcript shown at boot/idle and returning automatically after a
turn — chat carries narration, a category recap (e.g.
`3 command · 2 read · 5 subagent`), tool lines, the `✦` aggregate, findings,
the `+ thinking` marker (back in v0.34), and the final answer; the per-tool
ledger, `✦`, and `finding.detected` returned to the chat (v0.33 moved them to a
sidebar — now revoked); the `Tool:` line and folded buffers stay removed; a
one-line status bar (`✦ 00.00.00 Discuss  model  cwd ... context  Auto ●` — mode
values only, product labels `Work Mode:`/`Permission Mode:` removed in v0.24; the
`●` dot is yellow = allow-list active, grey = inactive, red `○` = unrestricted, a
`◷ N` badge when background jobs are alive), with new sessions at `DISCUSS`+`AUTO`,
Work Mode choices only Discuss/Build and Permission Mode only Auto/Ask; Work
Mode on the left and Permission Mode in cyan right-aligned near the context (timer
dim when idle, only seconds white when active, minutes light up after 60 s, hours
after 1 h; process sparkle; no bullet separator; `src/ui/tui/app.ts` renders the
composer dots and one spacer above the footer per frame); a single-box composite
popup (`/model`, `/provider`, `/sessions`, forms, approvals) via
`openAltScreen`/`paintRegion`; thinking uses the `+ thinking` marker in the chat (composer
dots; controlled by `MINICODE_SHOW_THINKING`, full reasoning stays in the journal;
`MINICODE_ACTIVITY_PANEL` is legacy/deprecated (D3), `MINICODE_MINIMIZE_ACTIVITY`
still folds); an actionable error message in red once per
failure (`takePendingError`); a centred chat column (v0.34) — `cols ≥ 120 && rows ≥
20` gives `chatCols = floor(cols/2)` with left/right padding, a centred
footer/composer, full width below the threshold, computed in
`src/ui/render/chat-column.ts` and part of the same `paint()` frame (never
scrollback, I1 unchanged). Pane shortcuts (`Alt/Ctrl+PgUp/PgDn`, per-pane wheel,
`Ctrl+O` Live detail) are removed. Command status/confirmation (sync, auth,
config, spinner) uses colour only, without icons; retry appears as one footer
micro-toast `retry n/total · Ns` with a 4 s TTL and a live counter.

Composer/menu flow since v0.36–v0.37: `composerWidth()` and `chatWidth()` are
two helpers from **one geometry source** in `src/ui/render/chat-column.ts` —
`composerWidth()` is used by the composer painter, `composer-wrap.ts`, and
cursor/click mapping. The v0.37 prompt cap is progressive:
`min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (100→100, 200→125,
300→150, 500→200; replacing `min(100, chatWidth())`); the prefix is `minicode › `
when the content room `w−14 ≥ 24` (`w ≥ 38`), else `› `, with `· ` for
continuation rows. The composer is at most 2 rows — a long draft uses a sliding
window without changing the frame height or transcript position. The `/`
dropdown is not a `paintRegion()` popup: it is drawn inside the same `paint()`
frame (one `stdout.write`, I1), overlaying the lower transcript rows without
reducing `viewH`, and a click in the dropdown area maps to a menu item, not a
transcript selection; since v0.37 the dropdown closes on a busy/abort
transition. See invariants I14/I17/I19/I1 and the `## Perubahan v0.37` entry
(which overrides the v0.36 cap/threshold) in `TERMINAL_CONTRACT.md`.

## Paste & selection flow (v0.37)

Three new input flows touch the controller/painter boundary:
`src/ui/input/{ask-line,prompt-engine}.ts` enables **bracketed paste**
(`?2004h` on entry / `?2004l` on exit) in the TUI, `askLine`/`askSecret`, and
`src/ui/screens/output-window.ts`. Those sequences are written **outside the
`paint()` frame** — not grid cells, not per-repaint diffs — so I1 (one `write`
per frame) still holds; a CR inside a paste becomes a draft newline, never a
stacked submit (reason: multiline paste corrupts the draft). `src/ui/tui/app.ts`
maps `Ctrl+A` to `selectAll` with an empty composer and closed dropdown (select
every logical transcript row via `src/ui/tui/transcript.ts`), and keeps `Home`
when a draft/menu is present; `Ctrl+C` finalises an active drag into a selection
first, then copies via OSC 52. Resize stabilises state: auto-scroll stops, drag
is cancelled, the cursor column preference is reset, and the scroll anchor is
rebased even with an active selection; a click after resize uses the new geometry
from `chat-column.ts`. The echoed user prompt is stored as one logical row and
wrapped once to the chat column width in the projector (not the full terminal
width — centred padding can double-wrap it).

## Key modules

- `src/session/verification.ts` + `src/tools/evidence.ts`: application-owned invocation identity, awaited intent/receipt, explicit observation, idempotency, and child-effect correlation — all in the same mutation journal.

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`, level-aware 16/256/truecolor palette), `width.ts` (columns), `sanitize.ts` (only SGR passes), `ledger.ts` (status word/glyph/paint + shared run marker for TUI & linear), `hint.ts` (`key label` grammar hints, space-only), `list.ts` (`›` row marker + fixed columns), `notice.ts` (success/error/info notices), `markdown.ts`, `markdown-layout.ts` (markdown layout for the centred chat column), `markdown-table.ts` (streaming pipe-table parser), `table-grid.ts` (terminal grid budget), `cells.ts` (grapheme+SGR framebuffer + a "rewrite the tail" diff for incremental writes), `composer-wrap.ts` (incremental composer wrap), `chat-column.ts` (v0.34 centred-column geometry: `chatCols = floor(cols/2)` when `cols ≥ 120 && rows ≥ 20`, padding, full width below the threshold, footer/composer follow; since v0.36 the single source of `composerWidth()`/`chatWidth()` for prompt width, cursor, and the adaptive prefix — v0.37 cap `min(chatCols, 100 + floor(max(0, chatCols-100)/4))`, prefix `minicode › ` when `w−14 ≥ 24`), `agent-progress.ts` (the `✦` sub-agent aggregate in chat), `tool-label.ts` (resolves the OS locale via `Intl` into the `› …` tool activity label; single source shared by the TUI and `src/ui/assistant/simple.ts`, while narration/model answers keep using `/lang`), `highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`. The old `sidebar-layout.ts`, `sidebar.ts`, `sidebar-model.ts`, `activity-format.ts` and the `window.ts` readout view are no longer used for a side panel since v0.34; incremental reasoning parsing is still guarded by `test/perf-no-quadratic.test.ts`.
- `src/presentation/`: `events.ts` defines presentation events and the durability registry; `adapter.ts` maps runtime to `DomainEvent`; `reducer.ts`/`model.ts` build replayable state and derived summaries; `store.ts` stores content references; `projection.ts` forms the `minicode.output.v1` envelope and machine error categories. `src/session/persistence.ts` stores the `presentation_events` and `messages` logs with `reasoning`/`is_error` fidelity. `cli/setup.ts` owns the exhaustive `toPresentationEvent()` bridge; the TUI/linear/machine renderers use policy decisions via `PresentationPolicy` injection.
- `src/policy/`: `context.ts` (density-aware code/JSON estimator + usage calibration), `context-window.ts` + `context-window-catalog.ts` (window resolution: config -> catalogue -> models.dev -> 128K alias default -> 32K), `bpe.ts` + `tokenizer-registry.ts` (on-demand precise BPE tokenizers from HuggingFace, local cache, density fallback), `compaction.ts` (LLM + mechanical compaction, anti-drift/anti-thrash, prefers the session provider), `usage.ts`/`pricing.ts` (cost estimates + models.dev), `shell-tokenize.ts` + `subagent-budget.ts` (platform-aware shell tokenizer and sub-agent step-budget resolution).
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + normalised wheel; app-level selection in the TUI). Since v0.37 bracketed paste is active (`?2004h`/`?2004l`, outside the frame per I1) in the TUI, `askLine`/`askSecret`, and the output window; `Ctrl+A` = `selectAll` with an empty composer and closed dropdown (else `Home`); `Ctrl+C` copies even while a drag is active.
- `src/ui/screens/`: pure views `picker/wizard/model-manager/provider-manager/form/dialog/output-window`; `output-window.ts` is the scrollable command readout above the chat (v7.18).
- `src/ui/assistant/simple.ts`: linear printer + OSC52 clipboard. `turn-status.ts`: the transient line. `approval/prompt.ts`: `promptAsk/promptAskText`.
- `src/daemon/`: hosted-session runtime, discovery, framed IPC/capabilities, replay, approval brokerage, child supervision, and ordered shutdown; composition via `cli/commands/daemon.ts`.
- `src/runtime/`: application admission and execution kernel (`dispatch.ts`, `execution-kernel.ts`, `production-execution.ts`) plus recovery (`recovery.ts`).
- Quality: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).