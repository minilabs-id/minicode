# CLI — Modes & Flags

Every way to run MiniCode: interactive, one-shot, pipe, and CI automation — plus flags and environment variables.

## Modes

| Command | Function |
|---|---|
| `minicode` | Interactive mode (fullscreen TUI) + wizard when no provider exists |
| `minicode "prompt"` | One-shot (headless) |
| `echo "prompt" \| minicode` | Via pipe |
| `minicode exec "prompt" [--json]` | Headless CI — JSONL events + a `{"type":"summary"}` line on stdout |
| `minicode acp` | JSON-RPC stdio server for IDEs (minimal subset: initialize/run/cancel/shutdown) |
| `minicode daemon <start\|status\|stop\|issue\|sessions>` | Local daemon: host processes, status, stop, issue commands, list child sessions |
| `minicode --interactive` | Force the interactive TUI |
| `minicode --provider <id> "prompt"` | Force an agnostic provider without touching config (or `provider::model`) |
| `minicode config add --baseUrl <url> --apiKey <key>` | Add an LLM provider |
| `minicode config mcp add <id> --command <cmd> --args "<a1,a2>"` | Register a stdio MCP server |
| `minicode config mcp add <id> --url <https://...>` | Register an HTTP MCP server |
| `minicode config lsp add <ext> --command <cmd> --args "<a1,a2>"` | Register an LSP server |
| `minicode auth login [provider]` | OAuth device-code login |
| `minicode auth status\|logout\|list` | Manage OAuth credentials |
| `minicode pricing status\|sync\|show <model>\|clear` | Estimated cost table |
| `minicode skills list` | List installed skills |
| `minicode sessions list` | Session history |
| `minicode memory status [--json]` | Vector RAG statistics (rows, size, hit-rate) |
| `minicode memory reconcile [--json] [--cwd PATH]` | Reconcile `vector.db` with `.minicode/MEMORY.md` (adopt vector-only entries, add file-only rows, clean superseded rows; the root/`CLAUDE.md` `MEMORY.md` hierarchy is untouched) |
| `minicode doctor [--json]` | Local diagnosis |
| `minicode mcp serve` | Expose MiniCode as an MCP server |
| `minicode openwork [inventory\|context\|export\|merge]` | Read, assemble context for, export, or deduplicate work across sessions; no action runs a task |

Subcommands are routed in `cli/router.ts` (`stats`, `sessions`, `mcp`, `config`, `skills`, `providers`/`models`/`sync`, `auth`, `pricing`, `exec`, `daemon`, `memory`, `doctor`, `acp`, `openwork`).

## Flags

| Flag | Description |
|---|---|
| `--verbose` | Show reasoning & usage |
| `--verify` | Auto-verify + self-heal (detect: typecheck -> test -> tsconfig) |
| `--sandbox docker` | Bash in an ephemeral container (`--network none`) |
| `--sandbox none` | Disable the automatic sandbox (deliberate opt-out) |
| `--sandbox os` | Force OS-native (bwrap/seatbelt). Already automatic when available |
| `--ratelimit <rpm>` | LLM request limit per minute |
| `--budget <usd>` | Session cost cap; warn at 80%, exit/break when exceeded; unknown cost + usage = over (fail-closed default) |
| `--budget-strict` | Explicit fail-closed assertion on top of the above (back-compat) |
| `--tool-scope <s>` | `full` (default) \| `explore` = read-only subset of 12 tools |
| `--plan` | **Deprecated** — alias for `--work-mode PLAN` (read-only planning) |
| `--allowlist` | Bash safe commands only (legacy tool-access policy) |
| `--ask` | Request approval for gated calls (human-supervised) |
| `--allow-all` | Privileged access profile (path jail + bash-guard still active) |
| `--model <name>` | Override the model (`providerId::model` forces a provider) |
| `--provider <id>` | Force an agnostic provider id |
| `--resume <id>` | Continue stored history; after compaction, older parts may be a summary + tail |
| `--timeout <ms>` | Hard deadline per prompt (default 3600000 = 1 hour; `0` = Infinity; the `exec` path stays at 15 minutes). An idle session does not consume the next prompt's deadline. |
| `--cwd <path>` | Workspace root for file tools and the jail |
| `--allow-local-config` | Trust `.minicode/config.json` + the local allowlist (default: ignored) |
| `--max-steps <n>` | Tool step limit (default 200; 50 is the sub-agent cap, not the global default) |
| `--context-window <n>` | Context window size (tokens) |
| `--session <id>` | Session ID (random by default, sanitised) |
| `--work-mode <m>` | `DISCUSS` \| `BUILD` (default: `DISCUSS`). **Work Mode**: `DISCUSS` = read-only investigation & planning, `BUILD` = implementation. Approval is only `AUTO`/`ASK` (default `AUTO`). See [TUI](repl.md) for `/mode` |
| `--enable-scheduler` | Opt-in autonomous scheduler (default **off**). Without this flag the scheduler is not built at all and `/scheduler` answers "not enabled". Execution is manual only via `/scheduler run` — no timers; autonomous turns are read-only. See `/scheduler status` and `/scheduler stop` |
| `--runtime <mode>` | `off` (default) \| `constructed` \| `owned`. Execution architecture: `off` = current behaviour, unchanged; `constructed` = runtime + durable journal built, turns still run the old path; `owned` = every turn is admitted through the runtime (kernel + durable journal) and a rejected admission runs nothing. Unknown value = `off` |

Without the flag, MiniCode uses `providers[].contextWindows` from configuration.
If the model/gateway has no such metadata, MiniCode uses a 32,000-token fallback
(unknown model) or a conservative 128K default for router aliases
(`auto`/`best`/...), then warns at session start. Use the model's real limit in
config or via the flag; too small a limit triggers early compaction, while too
large a limit risks provider rejection. The limit changes automatically when
`/model` switches models. MiniCode also caps streamed output by the space left
after the system prompt, tools, and history are counted.

In the TUI, **Tab** cycles Work Mode (`Discuss` -> `Build`) and **Shift+Tab** toggles Permission Mode (`Auto` <-> `Ask`). `/mode auto|ask` changes approval; `/mode discuss|build` changes the operating mode. The footer shows Work Mode on the left and Permission Mode in cyan on the right, near context usage; on narrow terminals the labels are condensed.

Since v0.34 the right sidebar is gone: the chat is a centred middle column (at most 50% of terminal width, footer/composer centred with it). Tool lines, the `✦` aggregate, findings, and the `+ thinking` marker live in the chat; the old pane shortcuts (`Alt/Ctrl+PgUp/PgDn`, `Ctrl+O`) are unbound. Since v0.37 bracketed paste is active, `Ctrl+A` = select-all with an empty composer and closed dropdown (else `Home`), `Ctrl+C` copies even while a drag is active, resize stabilises auto-scroll/drag/cursor/anchor, and the prompt cap is progressive `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (the 2-row composer stays). The shortcuts that remain are listed in [TUI — Slash Commands & Keyboard](repl.md).

## When to use what

| Goal | Use |
|---|---|
| Understand a repo without changes | Default (`DISCUSS` + `AUTO`) — local read-only investigation |
| Request changes | `--work-mode BUILD` (`AUTO` default for approval) — write/execute tools still obey policy |
| Unfamiliar repo / commands you do not understand | `--ask` (`BUILD` + `ASK`), answer `always` only for assessed tool+args pairs |
| Review/analysis without execution | `--work-mode PLAN` (or `--work-mode DISCUSS` for pure read-only investigation) |
| CI without a human | `exec --json` + `--budget`/`--max-steps`; `AUTO` denies `ask_user` deterministically |
| Full autonomy on your own machine | `--work-mode BUILD` + `AUTO`; extra isolation via `--sandbox docker` (or OS) + `--budget` |
| Runaway expensive model | `--budget 0.50` + `--budget-strict` + `pricing sync` |

The reasoning behind each mode is in [Choosing a Mode](choosing-mode.md).

## Environment variables (summary)

The full table is in [Environment Variables](environment.md); the most used:

| Variable | Function |
|---|---|
| `MINICODE_VERIFY_CMD` | Custom verify command |
| `MINICODE_SANDBOX` | `docker` \| `os` \| `none` |
| `MINICODE_SANDBOX_STRICT=1` | Never fall back to the host (an explicit default request is already fail-closed) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK=1` | Explicitly allow host fallback when the backend is unavailable |
| `MINICODE_BUDGET_STRICT=1` | Same as `--budget-strict` |
| `MINICODE_ALLOW_LOCAL_CONFIG=1` | Same as `--allow-local-config` |
| `MINICODE_WORK_MODE` | `DISCUSS` / `PLAN` / `BUILD` — default WorkMode; precedence in [Environment Variables](environment.md) |
| `MINICODE_TOOL_SCOPE=explore` | Read-only subset |
| `MINICODE_SUB_AGENT_POOL_SIZE` | Parallel sub-agent execution slots (1..16, default 3); raise for fan-out of 5+ agents |
| `MINICODE_GREP_ENGINE=js` | Force the internal walker |
| `MINICODE_MEMORY_SCOPE` | `cwd` \| `global` \| `all` |
| `MINICODE_AUTO_MEMORY=0` | Disable auto-saving summaries/snippets |
| `MINICODE_TELEMETRY=0` | Disable `traces.jsonl` |
| `MINICODE_HOME` | Override the home used for local/global DBs |
| `TAVILY_API_KEY` | Tavily web_search (falls back to keyless Firecrawl/Mwmbl/Marginalia when empty) |
| `MINICODE_ALLOW_DDG=1` | Enable the DDG HTML fallback (off by default; DDG is blocked in Indonesia) |
| `NO_COLOR` | Disable colour (wins over TTY) |
| `MINICODE_COLOR=0` | Force monochrome (same as `NO_COLOR`); otherwise colour is on by default in a TTY |
| `MINICODE_ASCII=1` | ASCII glyphs for consoles without UTF-8 |
| `MINICODE_STATUSLINE=rich` | Spinner also shows session tokens + cost |
| `MINICODE_STARTUP_PROGRESS=0` | Disable the startup progress line (on by default); a single `start N%` line overwritten with `\r` |
| `MINICODE_SESSION_SUMMARY=0` | Disable the closing session block (on by default), written to scrollback after the alternate screen is closed |

## Config

Schema, examples, global/local scope, and all data locations are in [Config — Files & Data Locations](config.md). Local config stays ignored unless the operator chooses `--allow-local-config` or `MINICODE_ALLOW_LOCAL_CONFIG=1`.

## Flag injection defence

`cli/args.ts` (`hasFlag`/`getArg`) stops at the first prompt word: the prompt `"review --allow-all"` does not enable a flag. `--cwd`/value flags after a subcommand name are parsed per subcommand so they cannot cross the prompt boundary.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, or help that was explicitly requested |
| `1` | Runtime failure: provider error, budget exceeded, failed turn, failed setup |
| `2` | Misuse: missing/malformed argument, unknown nested subcommand (an unknown top-level token becomes a one-shot prompt instead) |

A failed lookup (unknown provider/skill/session) = `1`: that is an operation failure, not misuse. Scripts can check `!= 0` for failure; check `== 2` for misuse specifically.