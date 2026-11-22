# Environment Variables

The variables that most determine behaviour (the rest are referenced below):

- **Autonomy limits on your own machine:** `MINICODE_SANDBOX` + `MINICODE_SANDBOX_STRICT=1` (deny bash when isolation is absent) + `MINICODE_BUDGET_STRICT=1` (unknown cost = over budget).
- **Privacy/minimal footprint:** `MINICODE_TELEMETRY=0` (no traces), `MINICODE_AUTO_MEMORY=0` (no automatic memory saving).
- **Unfamiliar repo:** do NOT set `MINICODE_ALLOW_LOCAL_CONFIG=1` unless the workspace is yours.
- **Legacy consoles/accessibility:** `MINICODE_ASCII=1`, `MINICODE_A11Y=1`, `MINICODE_BELL=0`, `NO_COLOR`.

## Runtime & limits

| Variable | Function |
|---|---|
| `MINICODE_TIMEOUT_MS` | Default timeout (ms) when `--timeout` is not set; `0` = Infinity. This is the **total** budget for one prompt (default 1 hour for interactive sessions) |
| `MINICODE_DEBUG` | `1` -> print the full stack trace when the process fails fatally (default: one line with the cause only) |
| `NO_UPDATE_CHECK` | `1` -> skip the update check at startup |
| `MINICODE_AUTO_UPDATE` | `0`/`false`/`off` -> disable the automatic update check and install |
| `MINICODE_PERMISSION` | `allowlist` -> bash tool-access policy (legacy profile) |
| `MINICODE_TOOL_SCOPE` | `explore` -> read-only subset of 12 tools (same as `--tool-scope explore`) |
| `MINICODE_WORK_MODE` | `DISCUSS` \| `PLAN` \| `BUILD` -> operating mode (same as `--work-mode`; default `DISCUSS`; `BUILD` maps to the internal `EXECUTE`; the flag beats the env var; an unknown value falls back to `DISCUSS` with a warning) |
| `MINICODE_HOOKS` | `1` -> run `pre/post-run` hooks from `~/.minicode/hooks/*.js` & `.minicode/hooks/*.js` (context in the `MINICODE_HOOK_CTX` env; hook env is sanitised without secrets; skipped when the session is cancelled) |
| `MINICODE_SESSION_TTL_DAYS` | Session TTL (default 30; `0` = forever) |
| `MINICODE_REWIND_DRAFT` | Internal `/undo` handoff: `1` -> the TUI loads the target prompt from the rewind record into the branch composer |
| `MINICODE_REWIND_NOTICE` | Internal `/undo`/`/redo` handoff: base64 notice shown once in the child session transcript |
| `MINICODE_SUB_AGENT_TIMEOUT_MS` | Default per-delegation sub-agent timeout (ms, finite >0; default 300000 / 5 minutes). Overridable per delegation with the `timeoutMs` argument of `delegate_task` |
| `MINICODE_SUB_AGENT_POOL_SIZE` | Number of parallel sub-agent execution slots (1..16, default 3). Raise it when you routinely fan out to 5+ agents at once |
| `MINICODE_REWIND_LOCK_MAX_AGE_MS` | Maximum age of the rewind `operation.lock` before it is treated as stale (default 600000 ms / 10 minutes). Operators may extend it when rewind is often interrupted on a slow machine |
| `MINICODE_BOOT_ID` | Machine boot marker for cross-restart rewind-lock validation. When unset it is derived from `hostname` + `Date.now() - os.uptime()`; set it explicitly for determinism when the NTP clock shifts |
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

> **v0.35 note — tool activity labels:** `MINICODE_LANG`/`/lang` controls the UI
> language and narration/model answers, but **not** the `› …` activity label.
> For that label alone the **OS locale** (`Intl`, id/en) wins on every surface —
> TUI, one-shot/`exec`, and ACP via `src/ui/assistant/simple.ts` — so tool
> vocabulary stays consistent across surfaces. There is no env var to override
> this; see the v0.35 entry in `TERMINAL_CONTRACT.md`.

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
| `TAVILY_API_KEY` | API key for Tavily web_search (falls back to keyless Firecrawl/Mwmbl/Marginalia when empty) |
| `BRAVE_API_KEY` | Brave Search API key (second fallback after Tavily) |
| `MINICODE_ALLOW_DDG` | `1` -> enable the DDG HTML fallback. Off by default because DuckDuckGo is blocked in Indonesia |

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
| `MINICODE_COMPACT` | `1` -> compact tool calls, `0` -> expanded. Default: compact in the TUI, expanded in one-shot/exec |
| `MINICODE_JUSTIFY` | `1` -> enable justified model text output. Default: off (opt-in) — justification injects spaces that change the original text when copied/piped |
| `MINICODE_DROPDOWN` | `0` -> disable the dropdown, use inline hints (legacy consoles). Since v0.36 the dropdown (when active) is drawn as an **overlay inside the same `paint()` frame**, not a separate `paintRegion()`, and does not reduce `viewH` — prompt/cursor width uses `composerWidth()` with a progressive cap (100->100, 200->125, 300->150, 500->200; since v0.37) |
| `MINICODE_MOUSE_SELECTION` | `0`/`false`/`off`/`no` -> disable TUI mouse tracking; default `1` for drag selection + wheel |
| `MINICODE_MOTION` | `0` -> disable status animation (the pulse spark while a turn runs becomes a static glyph) — accessibility/screen recording/slow SSH |
| `MINICODE_BELL` | `0` -> disable the `\x07` bell on approval (accessibility) |
| `MINICODE_STATUSLINE` | `rich` -> the turn status line also shows cumulative tokens + session cost (thrifty by default) |
| `MINICODE_A11Y` | `1` -> live-region approval for screen readers (plain lines without ANSI) |
| `MINICODE_SHOW_THINKING` | model reasoning is **hidden by default**; `1` -> show the `+ thinking` marker in the chat (same as `/view thinking` or `--verbose`), `0` -> force hidden. There is no `Ctrl+T` binding; the full reasoning stays in the journal |
| `MINICODE_MINIMIZE_ACTIVITY` | ON by default in the TUI; `0` -> transparent (one line per tool). Folds per-turn tool activity into one summary in the chat — this fold toggle still applies in v0.34. Tool/`✦`/finding lines themselves returned to the chat (v0.33 routed them to a Live panel + `Ctrl+O`, now revoked), not to `/view expand` |
| `MINICODE_ACTIVITY_PANEL` | **Legacy/deprecated (D3)** since v0.34: `0`/`1` are still accepted so old configs do not error, but the value no longer changes the display. It used to control the sidebar Activity/Live panel (active when `cols ≥ 100` and `rows ≥ 20`); the sidebar has been removed entirely |
| `MINICODE_AUTORESUME_BG` | `0` -> disable TUI turn auto-resume when a background job finishes (enabled by default; once per job, only when no turn is running) |
| `MINICODE_TURN_AUTO_RESUME` | `0` -> disable automatic turn resume after a **transient** provider failure (`server`/`network`; enabled by default). Provider retry and turn resume share **one recovery budget** (`src/policy/recovery-budget.ts`): 45 s total and a quota of 6 attempts for one logical call, with full jitter and `Retry-After` as a floor. Sharing one budget prevents *retry amplification* (separate per-layer counts multiply the cost: ~82 s for a dead provider). Terminal failures are not recovered: `rate_limit` (a permanent 429/spend-cap does not recover), `auth`, `invalid_request`, `context_length_exceeded`, `budget_exceeded`, `max_steps_exceeded`, and user abort |
| `MINICORE_THINKING` | `off` -> send `enable_thinking:false` to OpenAI-compat (DeepSeek). The old `MINICODE_THINKING` alias is still honoured |
| `MINICODE_STARTUP_PROGRESS` | `0` -> disable the startup progress line (ACTIVE by default). Without a logo: one `start NN%` line overwritten with `\r`, using real figures from the 9 phases of `createCliSession`; `update NN%` for auto-update. Closes with `start 100%` once the session is ready |
| `MINICODE_SESSION_SUMMARY` | `0` -> disable the closing session block (ACTIVE by default). Written to the scrollback AFTER the alt-screen closes: the `minicode` wordmark + `Session : minicode<DDMMYYYYHHMMSS>` + turn/tool/file/other counts + tokens/cost/duration + version, with the model, mode, per-category tool breakdown, agent count, and token in/out. Unavailable data is reported honestly (`0` / `$—`); the transcript stays intact |
| `MINICODE_COLOR` | `0` -> force monochrome (identical to `NO_COLOR`); any other value or absent -> colour on by default on a TTY (v7.29+). `TERM=dumb` / non-TTY stay monochrome for determinism |
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