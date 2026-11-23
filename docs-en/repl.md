# TUI — Slash Commands & Keyboard (one fullscreen view)

Type `/` at the prompt to open a plain dropdown (no frame; max 8 rows, long lists
are cut without an `... N more` row — that row exists only in `askLine`/linear
dialogs). `Up`/`Down` navigate, `Enter` completes + submits, `Esc` closes. Since
v0.36 the dropdown is drawn as an **overlay inside the same `paint()` frame**
(one `stdout.write`, I1) and **does not reduce `viewH`** — it covers the lower
transcript rows instead of shifting them, and uses no separate `paintRegion()`
(avoiding a second write and flicker on steer). A mouse click in the dropdown
area maps to a menu item, not a transcript selection. All interactive surfaces
live inside the fullscreen TUI; a terminal without ANSI/alt-screen gets a
one-line message and exits (interactive requires a TTY of at least 10 rows).

UI language: `/lang` (session, stored in state.json) > `MINICODE_LANG` > state.json `lang` >
OS locale > en. `/lang` with no argument shows the active one. Every string goes
through the i18n dictionary (`src/ui/i18n/`); hardcoded Indonesian literals
outside the dictionary fail the test. **v0.35 exception:** the tool activity
label `› …` uses the **OS locale** (`Intl`, id/en), not `/lang` — see the section
below. Narration and model answers still use the user's language (`/lang`).

## Slash commands

| Command | Function |
|---|---|
| `/help` | Short command list, grouped by category (Session/Model/Mode/View/Task) |
| `/help full` | Full grouped list with descriptions (alias `/help all`); a bare `/help` from non-TTY also shows this |
| `/help keys` | Complete keyboard shortcuts (pane shortcuts were removed with the sidebar in v0.34; alias `/help tombol`) |
| `/provider [sync]` | Manage providers: popup — preset picker + form (URL/key/scope/override), delete (`d`, states how many models are lost), edit (`e`). `sync` refreshes the model list of every provider (only says restart when there really are new models) |
| `/model [search]` | Popup of all `provider::model` (argument = initial filter; type inside to search live, Ctrl+U clears, Esc leaves the filter). Del = delete (confirm). Enter = select + set thinking effort (`default/low/medium/high`, stored on the provider, applies to the next session; Esc = cancel entirely). Non-default effort shows a `[low\|medium\|high]` badge |
| `/context [value]` | Table of the effective context window per model plus where each value came from (`manual`/`endpoint`/`catalog`/`models.dev`/`flag`/`safe default`). With an argument: set it for the active model (`128k`, `1m`, `1024x1024`, `auto`) — effective on the next turn. Details in [Configuration](config.md) |
| `/undo [n\|list]` | Undo conversation **and** files back to before turn `n` (no argument: newest-first picker; `last`: the last turn). `Esc Esc` with an empty composer opens the picker. The original session stays intact; the target prompt opens as a draft in the branch session. `list` shows turn numbers. In DISCUSS, undo that touches files is refused; conversation-only undo remains allowed |
| `/redo` | Return to the source session after `/undo` and restore the workspace to its pre-undo state; refused if a new turn already exists in the branch |
| `/sessions [id\|history\|branches]` | With no argument = resume picker popup; `<id>` = resume directly; `history` = the last 20 prompt entries; `branches` = undo branch list |
| `/status` | Runtime + **cumulative session** usage & cost |
| `/mode [discuss\|build\|auto\|ask]` | With no argument = two-axis popup: WorkMode (`discuss`/`build`) + PermissionMode (`auto`/`ask`). WorkMode bounds how the agent works: `DISCUSS` is read-only investigation/planning, `BUILD` adds no ceiling (internal identity `EXECUTE`). An invalid value is rejected and the active mode is unchanged. Tab/Shift+Tab remain quick shortcuts. |
| `/lang [en\|id]` | UI language; with no argument it shows the active one |
| `/init` | Create `AGENTS.md` for this project |
| `/copy [n]` | Copy the last `n` turns (default `1`, maximum `10`) via OSC 52 |
| `/clear` | Clear the transcript (the viewport goes empty) |
| `/view [thinking]` | Only `thinking` is accepted (shows/hides the `+ thinking` marker in the chat); with no argument = a single-action picker. The old `compact`/`minimize`/`fold`/`expand` actions are **rejected** — full reasoning stays in the journal, not in a sidebar pane |
| `/exit` | Quit (the only exit; `/quit` alias). After exiting, a closing block goes to the scrollback: the `minicode` wordmark + Session/Model/Mode + Usage (tokens in/out, cost, duration) + a per-category tool breakdown + agent count. Disable with `MINICODE_SESSION_SUMMARY=0` |
| `/scheduler [status\|run\|stop]` | Production scheduler control. **Off by default** in every session (needs the `--enable-scheduler` flag); without the flag the command answers "not enabled". It stays visible in `/help` so an operator who enabled the flag can find it. |
| `/update` (v0.41) | Update MiniCode to an **exact verified version**. **Interactive TUI only**: safe handoff — release the alt-screen → install → spawn a restart with `MINICODE_AUTO_UPDATE_DONE=1` → exit; if already latest, opted out, or failed, the terminal is re-acquired and the result is shown. Non-TTY/one-shot/`exec`/pipe/ACP answer "not available" (fail-closed, never spawn npm from a pipe/CI). Manual instruction: see [manual installation](getting-started.md). |

Aliases (work, not advertised in `/help`): `/models` -> `/model`, `/providers` -> `/provider`, `/usage` & `/cost` -> `/status`, `/resume [id]` -> `/sessions [id]`, `/quit`. The old names `/sync`, `/work-mode`, `/history`, `/compact`, `/thinking`, `/expand`, `/minimize`, and `/fold` are retired (no alias) — `/help` and did-you-mean point to their replacements.

Hidden commands (deliberately absent from `/help`/the dropdown, per session): `/unrestric` — the out-of-workspace jail + bash-guard + allowlist bridge is opened, narrow git credentials are forwarded, but sensitive files (`.env`/`auth.json`/daemon credentials) and `.minicode/hooks/**` remain denied — `.minicode/` state itself is writable since 2026-11-23; the gate is operator trust (toggle; the footer shows a red `o`). Details in [Security](security.md).

Did-you-mean: the typo `/sessoons` yields `Did you mean /sessions?` (distance <= 2).

## Keyboard

| Key | Function |
|---|---|
| `enter` | Send the prompt (in a picker/form: select/save; empty = cancel in a picker) |
| `tab` | Toggle WorkMode (`DISCUSS` ↔ `BUILD`); the legacy `PLAN` value normalises to `DISCUSS` |
| `shift+tab` | Toggle PermissionMode (`AUTO` <-> `ASK`) |
| `Up` / `Down` | Prompt history, or item navigation in a picker/manager/form. In a long/multiline draft: move between visual rows using `composerWidth()` (sliding window, correct at terminals ≥120 columns), then to history at the first/last row |
| `pgup` / `pgdn` | Scroll the chat one page; with `shift`: half a page (in pickers/managers: scroll the list) |
| `alt+pgup` / `alt+pgdn` | Removed in v0.34 (used to scroll two sidebar panes); unbound |
| `ctrl+pgup` / `ctrl+pgdn` | Removed in v0.34 (used to change the sidebar pane-height ratio); unbound |
| `mouse drag` | Select transcript text; `Ctrl+C` copies the app-level selection |
| `mouse wheel` | Scroll the chat (there are no panes since v0.34); clicking the prompt moves the cursor. With the `/` dropdown open, a click/wheel in the dropdown area selects a menu item rather than scrolling the transcript |
| `home` / `end` | Start/end of line; on an empty line with no dropdown: jump the chat to the top edge / back to the tail (in pickers/managers: jump to the top/bottom of the list) |
| `Left` / `Right` | Move the cursor (in a select/confirm form: change the option/value) |
| `ctrl+a` / `ctrl+e` | Start / end of line. **Since v0.37:** `ctrl+a` maps to the `selectAll` key — with an empty composer and a closed dropdown it selects **every logical transcript row**; with a draft or an open menu it stays `Home` (compatible). `ctrl+e` remains end of line |
| `delete` / `backspace` | Delete a character (in a filter: trim the query; in `/model` browse: Del = delete a model with confirmation) |
| `ctrl+r` | Search prompt history (prefix) |
| `ctrl+j` | New line (multiline; Enter still submits) |
| `ctrl+w` | Delete one word before the cursor |
| `ctrl+u` | Clear the line (in a filter: clear the query) |
| `ctrl+o` | Removed in v0.34 (used to open the sidebar Live detail modal); unbound |
| `esc` | Close a dropdown/picker; two-stage in a form (press 1 clears the field, press 2 cancels); while busy = cancel the turn; idle with an empty composer: two Esc within 500 ms opens the `/undo` picker |
| `ctrl+c` | Copy the selection (TUI), **including while a drag is still active** — the drag is finalised into a selection first (not a no-op/abort, since v0.37); with no selection it is a no-op. Abort a turn with `Esc` (double `Esc` within 1.5 s, or `Ctrl+D` on an empty line, when the abort stalls) |
| `paste` (multiline) | Bracketed paste is on since v0.37: `?2004h` on entry, `?2004l` on exit — in the TUI, `askLine`/`askSecret`, and the output window. The sequences are written **outside the frame** (I1: one `write` per frame still holds). A CR inside a paste is read as a draft newline, **not a submit** — no stacked submissions |
| `ctrl+d` | Quit on an empty line; while busy on an empty line = abort the turn then quit |
| `/update` (handoff, v0.41) | Terminal handoff for auto-update in the TUI: release the alt-screen → install → restart with `MINICODE_AUTO_UPDATE_DONE=1` → exit. If latest/opted out/failed, the terminal is re-acquired and the result is shown. Non-TTY/one-shot/ACP: "not available", no npm spawn. A failed install reports the step and redacted reason (ANSI/token/credential URLs stripped, <=300 chars), not a generic message |
| `resize` (v0.37) | Stops **auto-scroll**, cancels the **drag** state, resets the **cursor column preference**, and **rebases the scroll anchor** even when a selection is active — so the selection does not jump to stale rows. The `/` dropdown closes on a busy/abort transition. A click after a resize maps to the **new** geometry, not the old coordinates |
| `enter` while a turn runs | **Steered in as additional information**: the line joins the ACTIVE turn's context at the next step boundary — before the next model request — so the model reads it within the same turn without discarding the work in flight (the transcript marks it `steered into the running turn`). If the turn already finished first, the line falls into the next-turn queue (`queued #n`) so it is never lost. A `/command` line is refused with a reason because UI commands need an idle prompt. `Esc` cancels the turn and drops the fallback queue (with a notice) |

While a turn runs the composer stays live: the draft being typed replaces the
activity status row whenever it is non-empty, so corrections or extra context can
be prepared without stopping the turn. `Tab`, `Shift+Tab`, and `Ctrl+R` remain
blocked until the turn ends. `Ctrl+T` and `Ctrl+O` have no binding at all (the
latter lost its v0.33 Live-detail exception when the sidebar was removed).

## Chat column (v0.34)

The right sidebar was removed entirely. The chat is a centred middle column in
the **same `paint()` frame** — never scrollback: with `cols ≥ 120` **and**
`rows ≥ 20`, `chatCols = floor(cols/2)` (at most 50% of the terminal) with left
and right padding, and the footer/composer centred with it; below that threshold
the chat uses the full width. Popups/modals remain full-screen centred on `cols`
(I20 unchanged), and one frame / one `stdout.write` (I1) is unchanged.

Tool lines, the `✦` agent aggregate, `finding.detected` events, and the
`+ thinking` marker appear in the chat (the linear path already did so). The
chat also carries narration and a category recap (e.g.
`3 command · 2 read · 5 subagent`) plus the final answer. Reasoning is hidden by
default (`MINICODE_SHOW_THINKING=1` shows the `+ thinking` marker; full detail is
in the journal). `MINICODE_ACTIVITY_PANEL` is legacy/deprecated (D3) and no
longer changes the display; `MINICODE_MINIMIZE_ACTIVITY` still folds per-turn
tool activity. Wheel scrolls the chat; `PgUp`/`PgDn` and `Home`/`End` act on the
chat only. The pane shortcuts (`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, per-pane wheel,
`Ctrl+O`) are unbound.

## Composer & dropdown (v0.36–v0.37)

- **Composer height is at most 2 rows** (previously up to 5; v0.36 is not
  revoked). A longer draft uses a **sliding window** that follows the cursor —
  it adds no rows to the frame and **does not shift the transcript**. The single
  blank separator row between the composer and the footer remains (I13/I17).
- **One prompt geometry (v0.37):** `composerWidth()` and `chatWidth()` come from
  a single source in `src/ui/render/chat-column.ts`. All composer, wrap, cursor
  `Up`/`Down`, `Home`/`End`, and click-to-move calculations use `composerWidth()`
  (I14). Its cap is now **progressive**:
  `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` — `100→100`, `200→125`,
  `300→150`, `500→200` (replacing the old `min(100, chatWidth())` cap).
- **Adaptive prefix (v0.37):** `minicode › ` when the content room
  `w−14 ≥ 24` (i.e. `w ≥ 38`), else `› `; continuation rows use `· `. The old
  "≥60 columns" threshold is superseded.
- **Dropdown `/` = overlay inside the same frame** (I19/I1): it does not reduce
  `viewH`, covers the lower transcript rows, and uses no separate `paintRegion()`.
  A click in the dropdown area selects a menu item, not a transcript selection.
  Since v0.37 the dropdown **closes on a busy/abort transition**.
- **Prompt echo (v0.37):** the echoed user prompt is stored as **one logical row**
  and wrapped **once** by the projector to the **chat column width**, not the
  full terminal width — avoiding the double-wrap caused by centred padding.

The older clauses about a composer up to 5 rows, a dropdown that reduced the
transcript height, the `min(100, chatWidth())` cap, the "≥60 columns" prefix
threshold, and a cursor following the full `chatWidth()` are archive material
overridden by v0.36/v0.37 — see the precedence rule in `TERMINAL_CONTRACT.md`.

## Footer recap & tool activity labels (v0.35)

The tool recap is not live state. It is written as a **static committed row**
that acts as the footer of each narration:

```text
tool -> narration -> recap(tools before that narration)
2 command · 118 read · 1 other
```

The recap row counts the tools that happened **before** that narration (no symbol
prefix since v0.41). The
**final recap of a turn** is cumulative for all tools in the turn (not a
per-segment slice). The older clauses — a two-line live recap, a net-zero
`flushActivityFold`, `liveSummaryRows()` following the tail, and a floating
separator row between narrations — are v0.33/v7.x archive material overridden
by v0.35.

The activity label `› …` (tool name/status) uses the **system/OS language**
via `Intl` (id/en) on every surface — TUI, one-shot/`exec`, and ACP through
`src/ui/assistant/simple.ts`. Narration/progress/final model answers still use
the user's language (`/lang`, with `MINICODE_LANG` as fallback). So changing
`/lang` does not change the `› …` label: the OS locale wins for that label
alone, for consistency across surfaces. The single resolver is
`src/ui/render/tool-label.ts`.

## Live tool row (v0.43 — amendment to v0.42)

The **live** tool activity row (root or child) is transient again, as in
v0.40.0: it appears while a tool runs, follows the transcript tail, and
disappears once the tool finishes — with no new committed entry. When the live
row appears, `total` grows and sticky-tail shifts the window, so history may
move up. When the live row disappears and `total` shrinks, the window **does not
shift back**: committed rows keep their on-screen position and the space below
may be empty.

The mechanism is a **per-turn `scrollBack` ratchet** — it only ever grows, never
shrinks — reset on `turn:started`, a new prompt, or `/clear`. The live row is
not an overlay, not a `liveRegion`, and not a commit-in-place; I1 (one
`stdout.write` per frame) holds, with no new writer or region.

What must not disappear is **already-committed chat history** — that has held
since v0.42. The v0.42 "commit-in-place / never-shrink by id" clause is
**overridden only on the transience of the live row**; other v0.42 clauses
(concise failure text, recap without `└`) still apply. Archives are neither
deleted nor renumbered — see the `## Perubahan v0.43` entry in
`TERMINAL_CONTRACT.md`.

## Consistency rules (contract I25)

- Two-stage `Esc` in EVERY text input: content is never lost on a single press.
- `backspace`/`delete` always edit text; data-deletion actions always require
  confirmation (inside a popup) and are recorded in the transcript.
- List navigation = `Up/Down` + `pgup/pgdn` + `home/end` in every list popup.
- Every surface shows a footer hint matching the keys that actually apply there.