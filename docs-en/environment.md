# Environment Variables

The variables that most determine behaviour (the rest are referenced below):

- **Autonomy limits on your own machine:** `MINICODE_SANDBOX` + `MINICODE_SANDBOX_STRICT=1` (deny bash when isolation is absent) + `MINICODE_BUDGET_STRICT=1` (unknown cost = over budget).
- **Privacy/minimal footprint:** `MINICODE_TELEMETRY=0` (no traces), `MINICODE_AUTO_MEMORY=0` (no automatic memory saving).
- **Unfamiliar repo:** do NOT set `MINICODE_ALLOW_LOCAL_CONFIG=1` unless the workspace is yours.
- **Legacy consoles/accessibility:** `MINICODE_ASCII=1`, `MINICODE_A11Y=1`, `MINICODE_BELL=0`, `NO_COLOR`.

## Runtime & limits

| Variable | Function |
|---|---|
| `MINICODE_TIMEOUT_MS` | Default timeout (ms) when `--timeout` is not set; `0` = Infinity |
| `NO_UPDATE_CHECK` | `1` -> skip the update check at startup |
| `MINICODE_AUTO_UPDATE` | `0`/`false`/`off` -> disable the automatic update check and install |
| `MINICODE_PLAN` | `1` -> legacy alias for `--work-mode PLAN` (without `--plan`) |
| `MINICODE_PERMISSION` | `allowlist` -> bash tool-access policy (legacy profile) |
| `MINICODE_TOOL_SCOPE` | `explore` -> read-only subset of 12 tools (same as `--tool-scope explore`) |
| `MINICODE_WORK_MODE` | `DISCUSS` \| `PLAN` \| `BUILD` -> operating mode (same as `--work-mode`; default `DISCUSS`; `BUILD` maps to the internal `EXECUTE`; the flag beats the env var; an unknown value falls back to `DISCUSS` with a warning) |
| `MINICODE_HOOKS` | `1` -> run `pre/post-run` hooks from `~/.minicode/hooks/*.js` & `.minicode/hooks/*.js` (context in the `MINICODE_HOOK_CTX` env; hook env is sanitised without secrets; skipped when the session is cancelled) |
| `MINICODE_SESSION_TTL_DAYS` | Session TTL (default 30; `0` = forever) |
| `MINICODE_HOME` | Override the home for local/global DBs (sessions + vector); default `~` |
| `MINICODE_TOKENIZERS` | `0`/`off` -> disable on-demand precise tokenizer downloads from HuggingFace (fall back to the density estimator). Default: enabled for open models (deepseek/qwen/mistral/gemma/phi); vocabularies are cached in `~/.minicode/tokenizers/` and not re-downloaded |
| `MINICODE_TELEMETRY` | `0`/`false`/`off` -> disable writing traces.jsonl |
| `MINICODE_VERIFY_CMD` | Custom verify command (replaces `detectVerifyCommand`) |
| `MINICODE_ACE_ENABLED` | `0`/`false`/`off`/`no` -> disable the ACE-Lite consequence engine (instant rollback to the pure baseline, no self-heal loop). Default `true`. Hard safety/tamper guard & permission policy STAY active — this switch only disables consequence evaluation, not security boundaries |
| `MINICODE_BASH_ALLOWLIST` | Custom bash allowlist (comma-separated, replaces the DEFAULT) |

## Language, diagnostics & keys

| Variable | Function |
|---|---|
| `MINICODE_LANG` | `en`/`id` -> UI language (full precedence in the terminal contract, i18n section: `/lang` > this env > state.json > OS locale > en) |
| `MINICODE_DEBUG_BUS` | `1` -> print one event-bus diagnostic line per turn to stderr (`src/ui/runtime/bus-debug.ts`; diagnostics only, not behaviour) |
| `MINICODE_DEBUG_STARTUP` | `1` -> print the duration of each session setup stage to stderr (diagnosing slow startup; diagnostics only, not behaviour) |
| `MINICODE_MINIMIZE_ANSWER` | `1` -> minimize the model answer section (default: not minimized). Only effective on a TTY and when not `--verbose` |
| `MINICODE_KEYSTORE_DISABLE` | `1` -> disable the OS keystore entirely (falls back to file storage; for CI/headless without a keychain/DPAPI) |
| `MINICODE_KEYSTORE_FORCE_DPAPI` | `1`/`true` -> force the DPAPI/Windows path even on non-Windows (portability testing only; not a production setting) |
| `MINICODE_MINIMIZE_TOOL` | The tool section is minimized by default in the TUI (equivalent to `1`); set to any value other than `1` (e.g. `0`) -> show it fully |

## Sandbox

| Variable | Function |
|---|---|
| `MINICODE_SANDBOX` | `docker` \| `os` (aliases `bwrap`/`seatbelt`) \| `none` |
| `MINICODE_SANDBOX_STRICT` | `1` -> never fall back to the host (redundant with the fail-closed default for an explicit request, still honoured) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK` | `1` -> the only deliberate host-fallback path when the backend is unavailable |
| `MINICODE_SANDBOX_IMAGE` | Docker image (default `node:22-alpine` — node only; python needs its own image) |
| `MINICODE_SANDBOX_MEMORY` | Memory cap (default `512m`) |
| `MINICODE_GREP_ENGINE` | `js` -> force the internal walker, do not use ripgrep |

## Providers & memory

| Variable | Function |
|---|---|
| `MINICODE_PROVIDER_ORDER` | Order agnostic providers without editing config: `openai,anthropic,deepseek` |
| `MINICODE_EMBED_MODEL` | Embedding model for memory/vector (default `text-embedding-3-small`) |
| `MINICODE_COMPACT_KEEP_TURNS` | Override the compaction keepRecentTurns (integer >= 1; invalid -> kernel default + warning) |
| `MINICODE_MICROCOMPACT` | `0` -> disable trimming the content of old tool results (the cheapest layer before full compaction). Enabled by default; disable when a session needs every tool output verbatim |
| `MINICODE_PROMPT_CACHE` | `0` -> disable prompt caching (Anthropic `cache_control: ephemeral`). Enabled by default; a runtime kill-switch for gateways that reject the cache header or for hit-rate diagnostics (pairs with the cache metrics in the session summary/`/status`) |
| `MINICODE_CONTEXT_PROBE` | `0` -> disable adaptive context-window escalation (a reactive probe after a verified overflow). Enabled by default; the probe is also budget-limited per model/per process regardless of this value |
| `MINICODE_MEMORY_SCOPE` | Memory read scope: `cwd` (default) \| `global` \| `all` (merged, no silent shadowing) |
| `MINICODE_AUTO_MEMORY` | `0` -> disable automatically saving summaries/snippets to memory (opt-out) |
| `MINICODE_READ_VOLUME_GUARD` | `1` -> enable a once-per-turn warning when read volume (tool result chars) crosses a threshold — a marker for "read a lot without compaction" (working-memory degradation risk, not the token window); off by default |
| `MINICODE_REPOMAP` | `regex` -> force the regex repo-map (skip LSP) |
| `TAVILY_API_KEY` | API key for the Tavily web_search (falls back to DuckDuckGo when empty) |

## Budget & config

| Variable | Function |
|---|---|
| `MINICODE_BUDGET_STRICT` | `1` -> explicit fail-closed assertion (unknown cost + usage = over; now also the `--budget` default) |
| `MINICODE_MAX_TURNS` | Hard cap on the maximum number of turns per session (including carry-forward across `--resume`; integer >= 1) |
| `MINICODE_AUTO_CONTINUE` | `1` -> on `exec`, when a turn ends with `max_steps_exceeded`, continue the turn in the same session (partial progress is already durable) instead of failing; bounded by `--max-turns` (default 3) |
| `MINICODE_ALLOW_LOCAL_CONFIG` | `1` -> trust the workspace local config (default: ignored) |

## Terminal & accessibility

| Variable | Function |
|---|---|
| `MINICODE_ASCII` | `1` -> force ASCII glyphs (`[OK]`, `>`, `.`) for consoles without UTF-8 |
| `MINICODE_BOX` | popup box corner style: default **rounded** (`+`-style curves); `square` -> sharp; `ascii` -> `+-|` (same as `MINICODE_ASCII=1`). For terminals that render rounded glyphs badly |
| `MINICODE_SCRIM` | `none` -> force the backdrop scrim to `faint` only (no dark `48;5;236` background) — diagnostics/terminals that map 256-colour oddly |
| `MINICODE_COMPACT` | `1` -> compact tool calls, `0` -> expanded. Default: compact in the TUI, expanded in one-shot/exec (also `/compact`, Ctrl+O) |
| `MINICODE_JUSTIFY` | `1` -> enable justified model text output. Default: off (opt-in) — justification injects spaces that change the original text when copied/piped |
| `MINICODE_DROPDOWN` | `0` -> disable the floating dropdown, use inline hints (legacy consoles) |
| `MINICODE_MOUSE_SELECTION` | `0`/`false`/`off`/`no` -> disable TUI mouse tracking; default `1` for drag selection + wheel |
| `MINICODE_MOTION` | `0` -> disable status animation (the pulse spark while a turn runs becomes a static glyph) — accessibility/screen recording/slow SSH |
| `MINICODE_BELL` | `0` -> disable the `\x07` bell on approval (accessibility) |
| `MINICODE_STATUSLINE` | `rich` -> the turn status line also shows cumulative tokens + session cost (thrifty by default) |
| `MINICODE_A11Y` | `1` -> live-region approval for screen readers (plain lines without ANSI) |
| `MINICODE_SHOW_THINKING` | model reasoning is visible BY DEFAULT; `0` -> minimized (marker only), `1` -> force visible |
| `MINICODE_MINIMIZE_ACTIVITY` | ON by default in the TUI; `0` -> transparent (one line per tool). Folds per-turn tool activity into one summary (details via `/expand`) |
| `MINICODE_ACTIVITY_PANEL` | `0` -> disable the activity panel (ACTIVE by default in the TUI; `/fold` toggles); `1` -> force it on in the linear/one-shot path too |
| `MINICODE_AUTORESUME_BG` | `0` -> disable TUI turn auto-resume when a background job finishes (enabled by default; once per job, only when no turn is running) |
| `MINICODE_TURN_AUTO_RESUME` | `0` -> disable automatic turn resume after a **transient** provider failure (`server`/`network`; enabled by default). Provider retry and turn resume share **one recovery budget** (`src/policy/recovery-budget.ts`): 45 s total and a quota of 6 attempts for one logical call, with full jitter and `Retry-After` as a floor. Sharing one budget prevents *retry amplification* (separate per-layer counts multiply the cost: ~82 s for a dead provider). Terminal failures are not recovered: `rate_limit` (a permanent 429/spend-cap does not recover), `auth`, `invalid_request`, `context_length_exceeded`, `budget_exceeded`, `max_steps_exceeded`, and user abort |
| `MINICORE_THINKING` | `off` -> send `enable_thinking:false` to OpenAI-compat (DeepSeek). The old `MINICODE_THINKING` alias is still honoured |
| `NO_COLOR` | Any value other than `0` -> disable all colour |

## API key fallback

| Variable | Function |
|---|---|
| `AGENT_API_KEY`, `AGENT_BASE_URL`, `AGENT_MODEL` | Generic OpenAI-compat fallback (used by the provider layer, memory, tasks) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | API key fallbacks |
| `DEEPSEEK_BASE_URL` | DeepSeek base URL (default `https://api.deepseek.com/v1`, for compaction) |
| `ANTHROPIC_MODEL` | Anthropic model when not set explicitly |

## Next

- [CLI](cli.md) — the `--` flag equivalents.
- [Config](config.md) — config file + data locations.
- [Security](security.md) — subprocess env scrubbing.