# Architecture

This document is the active map of structure and runtime flow for contributors.

The owner's phase roadmap is not available in this checkout; do not infer phase
status or next actions from the changelog or the code. [Terminal Contract](../docs/TERMINAL_CONTRACT.md) is
the FROZEN terminal contract — read it before changing output; behaviour changes
require a contract update and a protection test map. The active output contracts
live in the [event model](../docs/OUTPUT_EVENT_MODEL.md), [protocol](../docs/OUTPUT_PROTOCOL_SPEC.md),
[rendering](../docs/OUTPUT_RENDERING_SPEC.md), and [UX rules](../docs/OUTPUT_UX_RULES.md). The
rendering flow map is in [UI Render Pipeline](../docs/UI_RENDER_PIPELINE.md).

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
`tool -> narration -> recap(tools before that narration)` — the recap row lands
right after the narration and counts the tools that happened **before** it. The
**final recap of a turn** is cumulative for **all** tools in that turn (not a
per-segment slice that resets), formatted as one line:
`2 command · 118 read · 1 other` (no symbol prefix since v0.41). The older
clauses — a two-line live recap,
a net-zero `flushActivityFold`, `liveSummaryRows()` following the tail, and a
floating separator row between narrations — are **v0.33/v7.x archive material overridden by v0.35**; see [Terminal Contract](../docs/TERMINAL_CONTRACT.md) for
precedence.

```text
tool done -> model narration -> recap(tools before narration)     [committed, static]
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

Task state is **not** chat history and **not** a tool trace. The durable source of truth is `TaskStore` in the workspace SQLite database (`.minicode/tasks.db`, `src/task/store.ts` + `src/task/db/{types,schema}.ts`), while `src/tools/todo.ts` acts as the model/tool adapter (updating `.minicode/todos/<id>.json` + syncing to `TaskStore` via `synchronizeCanonicalTasks` in `src/task/sync.ts`), and `plan.updated` (the durable event for ACP/`exec --json`) is a downstream projection (`syncTodoViewsFromTaskStore`).

```text
todo_write (model) -> normalizeTodos -> .minicode/todos/<id>.json (projection snapshot)
                            |                    |
                            |                    v
                            |         synchronizeCanonicalTasks -> .minicode/tasks.db (TaskStore: authority)
                            |                                            ^
                            v                                            | setCompletionEvidence
                     plan.updated (downstream projection AFTER success) -┘
```

Three rules hold this domain together:

1. **Canonical session identity (P2.1) & canonical `TaskStore` IDs (P4A).** Todos are bound to the canonical `sid` from `resolveSessionIdentity` (`src/session/identity.ts`), not the volatile process id (`bootId`). `--resume` without `--session` no longer forges a random id; an unknown `--resume` fails explicitly (`SESSION_NOT_FOUND`). Canonical `taskId` allocation belongs exclusively to `TaskStore`.
2. **Completion needs evidence.** `setCompletionEvidence()` injects a verdict (`unverified` | `passed` | `failed` | `stale`) from the composition root. `failed` refuses `completed` -> the task becomes `blocked` + its reason, and the result is reported to the model; `requireVerified && unverified` holds claims in `VERIFYING` or downgrades per the verification gate. The `unverified` default keeps usage without `--verify` possible; what is forbidden is silent completion without a trace.
3. **One status authority, one projection path.** `TaskStore` is the single authority for mutation/reconciliation/claim (`TaskAuthority`: `LEGACY` vs `SCHEDULER`), while `TaskGraph` and `ProductionScheduler` in `src/task/` operate over `.minicode/tasks.db`; `todo_write` and `/openwork` read and sync through `src/task/sync.ts` and `syncTodoViewsFromTaskStore` — and `plan.updated` is emitted only at `execution:completed`, not before the tool runs. (`/undo` restores files and conversation via a branch session, leaving durable task status untouched.)

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
Since v0.43/v0.51 the composer is framed in a rounded thin-line box of **1–2 dynamic rows** without an inner prefix (longer drafts scroll in a sliding window — no added lines and no transcript shift); symmetrical 3-column left/right frame padding yields `contentCols = chatCols - 6` wrapped once; the `/` and `@mention` dropdown is an **overlay inside the same frame**, without reducing `viewH` (no separate `paintRegion()`, avoiding a second write and flicker on steer); prompt/cursor width comes from the single helper `composerWidth()` using the progressive cap `min(contentCols, 100 + floor(max(0, contentCols-100)/4))`; bracketed paste, `{paste text N lines}` placeholders, composer drag/`Ctrl+A`/`Ctrl+C`, and a resize stabiliser are active; and live tool rows use adaptive tail quota `max(3, floor(viewH * 0.5))` with human intent/auto labels.
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
`retry-visibility`, `perf-no-quadratic`, `shell-tokenize`, `subagent-budget`) live in
[Terminal Contract](../docs/TERMINAL_CONTRACT.md). The old `sidebar-invariants`,
`sidebar-model`, `sidebar-width` and `thinking-truncation` claims were revoked
with the sidebar. That contract also carries a **protection gap map** — claims
whose implementation is correct but lacks a guarding assertion yet (a work list,
not a green list).

Seven display primitives (all inside the fullscreen TUI when interactive): the
`minicode >` transcript shown at boot/idle and returning automatically after a
turn — chat carries narration, a category recap (e.g.
`3 command · 2 read · 5 subagent`, cumulative with turn duration at turn end),
tool lines, the `✦` aggregate, findings (`[EVALUATE]` notes go to `/logs`), the
`+ thinking` marker (back in v0.34), and the final answer; a one-line status bar
(`✦ 00.00.00 Discuss  model  cwd ... context  Auto ●`, with new sessions starting
in `DISCUSS`+`AUTO`, timer dim when idle and brighter when active); a single-box
composite popup (`/model`, `/provider`, `/sessions`, forms, approvals) via
`openAltScreen`/`paintRegion`; thinking via `+ thinking` in chat
(`MINICODE_SHOW_THINKING`); an actionable error message once per failure
(`takePendingError`); the centred chat column (`cols ≥ 120 && rows ≥ 20` ->
`chatCols = floor(cols/2)`, full width below threshold, computed in
`src/ui/render/chat-column.ts`); colour-only command statuses; and one footer
micro-toast `retry n/total · Ns` (4 s TTL, live counter).

Since v0.36–v0.43: `composerWidth()` and `chatWidth()` come from **one geometry
source** in `src/ui/render/chat-column.ts`. Chat and composer share 3+3
symmetrical frame padding (`contentCols = chatCols - 6`) with progressive cap
`min(w, 100 + floor(max(0, w - 100) / 4))`. Rounded thin-line 1–2 row dynamic
composer box, overlay `/` dropdown within the same `paint()` frame (I1),
bracketed paste (`?2004h`/`?2004l` outside the frame), `{paste text N lines}`
placeholders, `Ctrl+A`/`Ctrl+C` selection, resize stabiliser, and per-turn
`scrollBack` ratchet for transient live tool rows follow [Terminal Contract](../docs/TERMINAL_CONTRACT.md).

## Key modules

- `src/session/verification.ts` + `src/tools/evidence.ts`: application-owned invocation identity, awaited intent/receipt, explicit observation, idempotency, and child-effect correlation — all in the same mutation journal.

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`, level-aware 16/256/truecolor palette), `width.ts` (columns), `sanitize.ts` (only SGR passes), `ledger.ts`, `hint.ts`, `list.ts`, `notice.ts`, `markdown.ts`, `markdown-layout.ts`, `markdown-table.ts`, `table-grid.ts`, `cells.ts`, `composer-wrap.ts`, `chat-column.ts` (centred chat-column and progressive `composerWidth(contentCols)` geometry), `agent-progress.ts` (`✦` sub-agent aggregate), `tool-label.ts` (OS locale activity labels + human auto-labels shared across TUI and `simple.ts`), `highlight.ts`, `diff.ts`, `table.ts`, `wrap.ts`, `money.ts`, `errors.ts` (`formatLabeledToolFailure` & `friendlyToolFailureTag`). Legacy sidebar modules were removed in v0.34; incremental reasoning parsing is guarded by `test/perf-no-quadratic.test.ts`.
- `src/presentation/`: `events.ts`, `adapter.ts`, `reducer.ts`/`model.ts`, `store.ts`, `projection.ts` (`minicode.output.v1` envelope and machine error categories). `src/session/persistence.ts` with `src/session/db/{schema,runs}.ts` stores `presentation_events`, `runs`, and `messages` with `reasoning`/`is_error` fidelity; `src/session/rewind.ts` coordinates checkpoint restore + `branchSession` + rewind records; `src/task/store.ts` with `src/task/db/{types,schema}.ts` manages `.minicode/tasks.db`. `cli/setup.ts` (`cli/bootstrap/presentation-bridge.ts`) owns the exhaustive `toPresentationEvent()` bridge and injects `PresentationPolicy`.
- `src/policy/`: `context.ts`, `context-window.ts` + `context-window-catalog.ts`, `bpe.ts` + `tokenizer-registry.ts`, `compaction.ts`, `autonomous-loop.ts`, `recovery-budget.ts`, `usage.ts`/`pricing.ts`, `shell-tokenize.ts` + `subagent-budget.ts`.
- `src/lib/`: UI-independent core utilities including `liveness-clock.ts` (`setSafeTimeout`, `createActivityDeadline`) and `safe-open.ts` (`createSafeScanReader` with cached parent `realpath` and `lstat`/`O_NOFOLLOW`/`fstat` verification).
- `src/repo/`: `repomap.ts` (`git ls-files` discovery, quick-stamp cache, <20 ms ranking + LSP fallback) and `dep-graph.ts` (hybrid static dependency engine: `Bun.Transpiler.scan`, masked type/re-export pass, polyglot imports, alias resolver, Tarjan SCC cycles, non-test centrality, BFS impact).
- `src/tools/`: file/shell/memory/task tools plus `dep_graph.ts` (#42 read-only graph tool), `lsp.ts` (7 LSP tools with `(ext, projectRoot)` monorepo isolation and `lsp_rename`), `move_file.ts`/`delete_file.ts` (graph importer warning + `didClose` + cache invalidation), and `grep.ts`.
- `src/task/`: `store.ts`/`scheduler.ts`/`trigger.ts`, `autonomous-policy.ts`, `autonomous-build-policy.ts`, `autonomous-context.ts`, `autonomous-adapter.ts`, and `production-scheduler.ts`.
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + wheel; app-level selection in the TUI; no pane shortcuts).
- `src/ui/screens/`: pure views `picker/wizard/model-manager/provider-manager/form/dialog/output-window`; `output-window.ts` is the scrollable command readout above the chat (v7.18).
- `src/ui/assistant/simple.ts`: linear printer + OSC52 clipboard. `turn-status.ts`: the transient line. `approval/prompt.ts`: `promptAsk/promptAskText`.
- `src/daemon/`: hosted-session runtime, discovery, framed IPC/capabilities, replay, approval brokerage, child supervision, and ordered shutdown; composition via `cli/commands/daemon.ts`.
- `src/runtime/`: application admission and execution kernel (`dispatch.ts`, `execution-kernel.ts`, `production-execution.ts`) plus recovery (`recovery.ts`).
- Quality: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).