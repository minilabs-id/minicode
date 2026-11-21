# TUI — Slash Commands & Keyboard (one fullscreen view)

Type `/` at the prompt to open a plain dropdown (no frame; max 8 rows, long lists
are cut without an `... N more` row — that row exists only in `askLine`/linear
dialogs). `Up`/`Down` navigate, `Enter` completes + submits, `Esc` closes. All
interactive surfaces live inside the fullscreen TUI; a terminal without
ANSI/alt-screen gets a one-line message and exits (interactive requires a TTY of
at least 10 rows).

UI language: `/lang` (session, stored in state.json) > `MINICODE_LANG` > state.json `lang` >
OS locale > en. `/lang` with no argument shows the active one. Every string goes
through the i18n dictionary (`src/ui/i18n/`); hardcoded Indonesian literals
outside the dictionary fail the test.

## Slash commands

| Command | Function |
|---|---|
| `/help` | Short command list, grouped by category (Session/Model/Mode/View/Task) |
| `/help full` | Full grouped list with descriptions (alias `/help all`); a bare `/help` from non-TTY also shows this |
| `/help keys` | Complete keyboard shortcuts, including the sidebar shortcuts (alias `/help tombol`) |
| `/provider [sync]` | Manage providers: popup — preset picker + form (URL/key/scope/override), delete (`d`, states how many models are lost), edit (`e`). `sync` refreshes the model list of every provider (only says restart when there really are new models) |
| `/model [search]` | Popup of all `provider::model` (argument = initial filter; type inside to search live, Ctrl+U clears, Esc leaves the filter). Del = delete (confirm). Enter = select + set thinking effort (`default/low/medium/high`, stored on the provider, applies to the next session; Esc = cancel entirely). Non-default effort shows a `[low\|medium\|high]` badge |
| `/context [value]` | Table of the effective context window per model plus where each value came from (`manual`/`endpoint`/`katalog`/`models.dev`/`flag`/`default aman`). With an argument: set it for the active model (`128k`, `1m`, `1024x1024`, `auto`) — effective on the next turn. Details in [Configuration](config.md) |
| `/undo [n\|list]` | Undo conversation **and** files back to before turn `n` (no argument: newest-first picker; `last`: the last turn). `Esc Esc` with an empty composer opens the picker. The original session stays intact; the target prompt opens as a draft in the branch session. `list` shows turn numbers. In DISCUSS, undo that touches files is refused; conversation-only undo remains allowed |
| `/redo` | Return to the source session after `/undo` and restore the workspace to its pre-undo state; refused if a new turn already exists in the branch |
| `/sessions [id\|history\|branches]` | With no argument = resume picker popup; `<id>` = resume directly; `history` = the last 20 prompt entries; `branches` = undo branch list |
| `/status` | Runtime + **cumulative session** usage & cost |
| `/mode [discuss\|build\|auto\|ask]` | With no argument = two-axis popup: WorkMode (`discuss`/`build`) + PermissionMode (`auto`/`ask`). WorkMode bounds how the agent works: `DISCUSS` is read-only investigation/planning, `BUILD` adds no ceiling (internal identity `EXECUTE`). An invalid value is rejected and the active mode is unchanged. Tab/Shift+Tab remain quick shortcuts. |
| `/lang [en\|id]` | UI language; with no argument it shows the active one |
| `/init` | Create `AGENTS.md` for this project |
| `/copy [n]` | Copy the last `n` turns (default `1`, maximum `10`) via OSC 52 |
| `/clear` | Clear the transcript (the viewport goes empty) |
| `/view [thinking]` | Only `thinking` is accepted (shows/hides reasoning); with no argument = a single-action picker. The old `compact`/`minimize`/`fold`/`expand` actions are **rejected** — full history lives in the right sidebar Thinking/Activity panes (mouse wheel, Alt+PgUp/PgDn, Ctrl+O) |
| `/exit` | Quit (the only exit; `/quit` alias). After exiting, a closing block goes to the scrollback: the `minicode` wordmark + Session/Model/Mode + Usage (tokens in/out, cost, duration) + a per-category tool breakdown + agent count. Disable with `MINICODE_SESSION_SUMMARY=0` |
| `/scheduler [status\|run\|stop]` | Production scheduler control. **Off by default** in every session (needs the `--enable-scheduler` flag); without the flag the command answers "not enabled". It stays visible in `/help` so an operator who enabled the flag can find it. |

Aliases (work, not advertised in `/help`): `/models` -> `/model`, `/providers` -> `/provider`, `/usage` & `/cost` -> `/status`, `/resume [id]` -> `/sessions [id]`, `/quit`. The old names `/sync`, `/work-mode`, `/history`, `/compact`, `/thinking`, `/expand`, `/minimize`, and `/fold` are retired (no alias) — `/help` and did-you-mean point to their replacements.

Hidden commands (deliberately absent from `/help`/the dropdown, per session): `/unrestric` — the out-of-workspace jail + bash-guard + allowlist bridge is opened, narrow git credentials are forwarded, but sensitive files/MiniCode state are still denied; the gate is operator trust (toggle; the footer shows a red `o`). Details in [Security](security.md).

Did-you-mean: the typo `/sessoons` yields `Did you mean /sessions?` (distance <= 2).

## Keyboard

| Key | Function |
|---|---|
| `enter` | Send the prompt (in a picker/form: select/save; empty = cancel in a picker) |
| `tab` | Toggle WorkMode (`DISCUSS` ↔ `BUILD`); the legacy `PLAN` value normalises to `DISCUSS` |
| `shift+tab` | Toggle PermissionMode (`AUTO` <-> `ASK`) |
| `Up` / `Down` | Prompt history, or item navigation in a picker/manager/form |
| `pgup` / `pgdn` | Scroll the **chat only** one page — the sidebar does not move; with `shift`: half a page (in pickers/managers: scroll the list) |
| `alt+pgup` / `alt+pgdn` | Scroll **both** panes (chat + sidebar) together and move the Live selection |
| `ctrl+pgup` / `ctrl+pgdn` | Change the sidebar Thinking:Activity height ratio (30–80%, in 10% steps) |
| `mouse drag` | Select transcript text; `Ctrl+C` copies the app-level selection |
| `mouse wheel` | Scroll the pane under the cursor (chat or sidebar); clicking the prompt moves the cursor |
| `home` / `end` | Start/end of line; on an empty line with no dropdown: jump chat **and** sidebar to the top edge / back to both tails (in pickers/managers: jump to the top/bottom of the list) |
| `Left` / `Right` | Move the cursor (in a select/confirm form: change the option/value) |
| `ctrl+a` / `ctrl+e` | Start / end of line |
| `delete` / `backspace` | Delete a character (in a filter: trim the query; in `/model` browse: Del = delete a model with confirmation) |
| `ctrl+r` | Search prompt history (prefix) |
| `ctrl+j` | New line (multiline; Enter still submits) |
| `ctrl+w` | Delete one word before the cursor |
| `ctrl+u` | Clear the line (in a filter: clear the query) |
| `ctrl+o` | Open the live-tool detail modal when the sidebar is active |
| `esc` | Close a dropdown/picker; two-stage in a form (press 1 clears the field, press 2 cancels); while busy = cancel the turn; idle with an empty composer: two Esc within 500 ms opens the `/undo` picker |
| `ctrl+c` | Copy the selection (TUI); with no selection it is a no-op. Abort a turn with `Esc` (double `Esc` within 1.5 s, or `Ctrl+D` on an empty line, when the abort stalls) |
| `ctrl+d` | Quit on an empty line; while busy on an empty line = abort the turn then quit |
| `enter` while a turn runs | **Steered in as additional information**: the line joins the ACTIVE turn's context at the next step boundary — before the next model request — so the model reads it within the same turn without discarding the work in flight (the transcript marks it `steered into the running turn`). If the turn already finished first, the line falls into the next-turn queue (`queued #n`) so it is never lost. A `/command` line is refused with a reason because UI commands need an idle prompt. `Esc` cancels the turn and drops the fallback queue (with a notice) |

While a turn runs the composer stays live: the draft being typed replaces the
activity status row whenever it is non-empty, so corrections or extra context can
be prepared without stopping the turn. `Tab`, `Shift+Tab`, and `Ctrl+R` remain
blocked until the turn ends; `Ctrl+O` stays available for the live-tool detail
modal. `Ctrl+T` has no binding at all.

## Sidebar

The right sidebar is part of the **same `paint()` frame** as the chat — never
scrollback. It is active only when `cols ≥ 100` **and** `rows ≥ 20`, and is
hidden on narrower or shorter terminals; no flag forces it onto a small screen.
Its width is 30% at ≤150 columns and grows linearly to 50% at ≥160, with a
36-column chat floor. Thinking:Activity height is 60:40 by default (30–80% via
`Ctrl+PgUp`/`Ctrl+PgDn`); at ≥168 columns Live and Log sit side by side. The
panes use a single dim vertical separator, a 3-row gap, and 1-space padding —
no box borders. Reasoning is hidden by default (`MINICODE_SHOW_THINKING=1` forces
it visible) and the full history is kept in the Thinking pane. `finding.detected`
events appear in the sidebar Activity log (or the transcript on the linear path),
while the chat itself carries only narration, a category recap (e.g.
`3 command · 2 read · 5 subagent`), and the final answer. Wheel scrolls the pane
under the cursor, `Alt+PgUp`/`PgDn` scroll both panes and move the Live selection,
`Home`/`End` bring chat **and** sidebar to the edges, `PgUp`/`PgDn` stay chat-only,
and `Ctrl+O` opens the live-tool detail modal.

## Consistency rules (contract I25)

- Two-stage `Esc` in EVERY text input: content is never lost on a single press.
- `backspace`/`delete` always edit text; data-deletion actions always require
  confirmation (inside a popup) and are recorded in the transcript.
- List navigation = `Up/Down` + `pgup/pgdn` + `home/end` in every list popup.
- Every surface shows a footer hint matching the keys that actually apply there.