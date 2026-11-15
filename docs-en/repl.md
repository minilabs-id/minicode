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
| `/help keys` | Complete keyboard shortcuts (alias `/help tombol`) |
| `/provider` | Manage providers: popup — preset picker + form (URL/key/scope/override), delete (`d`, states how many models are lost), edit (`e`) |
| `/model [search]` | Popup of all `provider::model` (argument = initial filter; type inside to search live, Ctrl+U clears, Esc leaves the filter). Del = delete (confirm). Enter = select + set thinking effort (`default/low/medium/high`, stored on the provider, applies to the next session; Esc = cancel entirely). Non-default effort shows a `[low\|medium\|high]` badge |
| `/sync` | Refresh the model list of every provider (only says restart when there really are new models) |
| `/undo` | Revert the last turn's file changes |
| `/redo` | Re-apply what was reverted |
| `/sessions` | With no argument = resume picker popup; `/sessions <id>` = resume directly |
| `/status` | Runtime + **cumulative session** usage & cost |
| `/mode [AUTO\|ASK]` | Change approval supervision; with no argument it toggles AUTO/ASK |
| `/work-mode [DISCUSS\|PLAN\|BUILD]` | WorkMode bounds how the agent works. `DISCUSS` is read-only, `PLAN` uses the plan ceiling, `BUILD` adds no ceiling (internal identity `EXECUTE`). With no argument it shows the active mode + usage; an invalid value is rejected and the active mode is unchanged. Tab and `/work-mode` change WorkMode; Shift+Tab and `/mode` change PermissionMode. |
| `/lang [en\|id]` | UI language; with no argument it shows the active one |
| `/init` | Create `AGENTS.md` for this project |
| `/copy [n]` | Copy the last `n` turns (default `1`, maximum `10`) via OSC 52 |
| `/clear` | Clear the transcript (the viewport goes empty) |
| `/expand` | Open the content of tool/thinking hidden by the compact ledger (one-shot, drains it all) |
| `/history` | The last 20 prompt entries |
| `/exit` | Quit (the only exit; `/quit` alias). After exiting, a session summary header is printed: the `minicode` wordmark + Session/Model/Usage (tokens, cost, duration) |
| `/scheduler [status\|run\|stop]` | Production scheduler control. **Off by default** in every session (needs the `--enable-scheduler` flag); without the flag the command answers "not enabled". It stays visible in `/help` so an operator who enabled the flag can find it. |

Aliases (work, not advertised in `/help`): `/models` -> `/model`, `/providers` -> `/provider`, `/usage` & `/cost` -> `/status`, `/resume [id]` -> `/sessions [id]`, `/compact`, `/thinking`, `/minimize`, `/quit`.

Hidden commands (deliberately absent from `/help`/the dropdown, per session): `/unrestric` — the out-of-workspace jail + bash-guard + allowlist bridge is opened, narrow git credentials are forwarded, but sensitive files/MiniCode state are still denied; the gate is operator trust (toggle; the footer shows a red `o`). Details in [Security](security.md).

Did-you-mean: the typo `/sessoons` yields `Did you mean /sessions?` (distance <= 2).

## Keyboard

| Key | Function |
|---|---|
| `enter` | Send the prompt (in a picker/form: select/save; empty = cancel in a picker) |
| `tab` | Cycle WorkMode (`DISCUSS` -> `PLAN` -> `BUILD`) |
| `shift+tab` | Toggle PermissionMode (`AUTO` <-> `ASK`) |
| `Up` / `Down` | Prompt history, or item navigation in a picker/manager/form |
| `pgup` / `pgdn` | Scroll the transcript one page; with `shift`: half a page (in pickers/managers: scroll the list) |
| `mouse drag` | Select transcript text; `Ctrl+C` copies the app-level selection |
| `mouse wheel` | Scroll the transcript; clicking the prompt moves the cursor |
| `home` / `end` | Start/end of line; on an empty line with no dropdown: jump to the top of the transcript / back to the tail (in pickers/managers: jump to the top/bottom of the list) |
| `Left` / `Right` | Move the cursor (in a select/confirm form: change the option/value) |
| `ctrl+a` / `ctrl+e` | Start / end of line |
| `delete` / `backspace` | Delete a character (in a filter: trim the query; in `/model` browse: Del = delete a model with confirmation) |
| `ctrl+r` | Search prompt history (prefix) |
| `ctrl+j` | New line (multiline; Enter still submits) |
| `ctrl+w` | Delete one word before the cursor |
| `ctrl+u` | Clear the line (in a filter: clear the query) |
| `ctrl+o` | Cycle tool call compact/expanded (also `/compact`) |
| `ctrl+t` | Toggle thinking expanded/minimized (also `/thinking`) |
| `esc` | Close a dropdown/picker; two-stage in a form (press 1 clears the field, press 2 cancels); while busy = cancel the turn |
| `ctrl+c` | Copy the selection (TUI); with no selection it is a no-op. Abort a turn with `Esc` (double `Esc` within 1.5 s, or `Ctrl+D` on an empty line, when the abort stalls) |
| `ctrl+d` | Quit on an empty line; while busy on an empty line = abort the turn then quit |

## Consistency rules (contract I25)

- Two-stage `Esc` in EVERY text input: content is never lost on a single press.
- `backspace`/`delete` always edit text; data-deletion actions always require
  confirmation (inside a popup) and are recorded in the transcript.
- List navigation = `Up/Down` + `pgup/pgdn` + `home/end` in every list popup.
- Every surface shows a footer hint matching the keys that actually apply there.