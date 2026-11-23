# Config & Providers

Where MiniCode settings and data live, how untrusted local files are treated, and which providers you can use.

## `.minicode/config.json` schema

```json
{
  "providers": [{
    "id": "my-provider", "baseUrl": "...", "apiKey": "...",
    "models": ["gpt-4o"], "contextWindows": { "gpt-4o": 128000, "*": 32000 }
  }],
  "mcpServers": [
    { "id": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
    { "id": "remote", "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer xxx" } }
  ],
  "lspServers": [{ "ext": ".ts", "command": "typescript-language-server", "args": ["--stdio"] }],
  "verifyCommand": "bun run typecheck",
  "bashAllowlist": ["git status*", "bun test*", "npm run build*"]
}
```

- `providers` — can also be filled via the wizard/`minicode config add`/`/provider`; see the preset list below.
- `providers[].contextWindows` — the context limit in tokens per model; an exact model ID wins, then the `"*"` key acts as the provider fallback. The value may be a **number** (`128000`) or a **preset string** (`"128k"`, `"1m"`, `"1024x1024"`, `"auto"`); `"auto"` means remove the value and return to automatic detection. Because gateways use model aliases, MiniCode uses a **conservative 128K default** for generic aliases (`auto`/`best`/...) and **32K** for other unknown models; exact windows come from the built-in catalogue (common families), the `minicode pricing sync` overlay (models.dev), and **on-demand precise tokenizers** from HuggingFace for open models. `--context-window` overrides the config value for that session.

  **Providers that do not report capacity** (local gateways, compatible endpoints, aliases): set it manually — the stored value is labelled `user` so `minicode sync` does **not** overwrite it:

  ```bash
  minicode config context-window                        # list every explicit value
  minicode config context-window <provider>             # one provider's values
  minicode config context-window <provider> <model> 128k
  minicode config context-window <provider> <model> 1024x1024
  minicode config context-window <provider> <model> auto   # back to automatic detection
  ```

  Inside a session the same capability is `/context`:

  ```
  /context              # table of effective windows per model + where each value came from
  /context 200k         # set it for the active model (used by the very next turn)
  /context auto         # back to automatic detection
  ```

  The `/context` table uses the same resolution chain as the router, so the
  number shown cannot differ from the one actually used. The **Origin** column
  says who decided: `manual` (your choice, locked against `sync`), `endpoint`
  (metadata from `/models`, may be overwritten), `katalog`, `models.dev`, `flag`
  (`--context-window`), or `default aman`. A `/context` change applies to the
  running session immediately — no restart needed.

  Accepted choices follow sizes actually used by production models: `16K`, `32K`, `64K`, `128K`, `200K`, `256K`, `400K`, `500K`, `1M`, `1M (1024^2)`, `1.05M`, `2M`, `4M`, `10M`, plus exact numbers. The **three 1M variants** are deliberate because they really differ: `1000000` (Anthropic/DeepSeek/Qwen), `1048576` (Google/Gemini, Kimi, GLM), `1050000` (OpenAI) — a gap of up to ~50K tokens.
- `mcpServers` — two forms: stdio (`command`+`args`) and HTTP (`url`+optional `headers`). Transport details in [MCP & LSP](mcp-lsp.md).
- `verifyCommand` — used by `--verify` when auto-detection finds nothing (detection order: `typecheck` -> `test` -> `tsconfig`).
- `bashAllowlist` — comma/glob patterns of bash commands considered safe (`allowlist` mode). Precedence: env `MINICODE_BASH_ALLOWLIST` > `bashAllowlist` (config) > built-in defaults. It **replaces the entire** narrow list (it adds to the developer list), so when an override is active the built-in additions (e.g. `tree`/`du`/`df`/`date`/`uname`) are not used — include the patterns you need yourself.

## 15 gateway presets (including Custom URL)

`Gateway >` shows only `[0] Label` without the URL (minimal, no endpoint leak).

| id | Label | Notes |
|---|---|---|
| `openai` | OpenAI | gpt, o-series |
| `anthropic` | Anthropic | Claude, streaming `tool_use` |
| `openrouter` | OpenRouter | Gateway with 75+ models |
| `deepseek` | DeepSeek | chat/reasoner |
| `opencode-zen` | OpenCode Zen | Gateway |
| `google` | Google Gemini | 1M context, `thought_signature` pass-through |
| `ollama` | Ollama | Local, free, no key |
| `qwen` | Qwen | Alibaba Qwen3-Coder (the only one with a registered OAuth spec) |
| `groq` | Groq | Fast inference |
| `together` | Together AI | Open models |
| `fireworks` | Fireworks AI | — |
| `mistral` | Mistral AI | — |
| `cohere` | Cohere | — |
| `generic` | Generic OpenAI-compatible | vLLM / LM Studio |
| `custom` | Custom URL | Pseudo-preset for your own baseUrl |

Flow: wizard & `/provider` (add `[0] OpenAI` ... `[14] Custom URL`) -> masked API key -> auto-detect models via `GET /models` with a 4 s timeout -> the provider switches automatically when you pick a model from a different provider (no restart, via `reloadProviders()` after `Gateway > 2`).

## Two authentication paths

```bash
# 1. API key
minicode config add --baseUrl https://api.openai.com/v1 --apiKey sk-...

# 2. OAuth device-code (no API key, no credit card) — RFC 8628
minicode auth list            # providers that support it
minicode auth login qwen      # short code -> open the URL -> wait for approval
minicode auth status          # credentials + when they expire
minicode auth logout qwen
```

Tokens live in `~/.minicode/auth.json` (chmod 600), not `config.json`. Automatic refresh with a 60 s margin. An OAuth provider that is not yet logged in is dropped from the list with a warning rather than sent with an empty header.

> Honesty: the device flow is fully tested against a local OAuth server (pending/slow_down/denied/expired/clamp), but not every provider endpoint/clientId has been confirmed live. `auth login chatgpt` fails fast on non-TTY. Do not read another person's desktop app token — that is credential theft.

## OS keyring (replace plaintext config)

```bash
minicode config set-key openrouter      # move the API key to the OS store, config keeps only a reference
minicode config delete-key openrouter   # forget it (the provider is inactive until set again)
```

Windows uses user-scoped DPAPI (only this user can open it); elsewhere it is a chmod 600 file with the honest label `plain-file` (not a keyring). A missing/corrupt reference means the provider is skipped with a warning (fail-closed, like OAuth). Force-disable with `MINICODE_KEYSTORE_DISABLE=1`.

## Models & thinking effort

```
/model [search]   -> provider::model picker, filterable
Enter             -> select the model (+ effort picker when the model supports it)
Esc               -> cancel entirely
```

Effort is stored in `ProviderEntry.reasoningEffort`, applies to the next session, and shows a `[low|medium|high]` badge. **Universal default = omit** (no thinking param): each model's own default is tuned by its vendor. The knob is only sent to proven families, in their native language: OpenAI reasoning (`o1`/`o3`/`o4`, `gpt-5`/`gpt-6` -> `reasoning_effort`, with levels validated per model — pro = high only); Claude <=4.5 -> budget `1024/2048/4096`; Claude >=4.6/5 -> adaptive + `output_config.effort`. **Everything else is never sent a thinking param** (DeepSeek, Gemini, Groq, Ollama, free tier, custom). If a model rejects the param (400/500), the request is retried once without it, remembered per session, and logged as `[thinking]` on stderr. The effort picker only appears for supported models; others select directly without touching the stored effort. `detectAndSave`/`auth login` preserve effort (no silent reset). Mutations are written to the scope file they came from (not the merged result) to avoid duplication/shadowing.

One-off model override:

```bash
minicode --model providerId::modelName "prompt"
minicode --provider openai "prompt"
minicode models --match gemini
```

`MINICODE_PROVIDER_ORDER=openai,anthropic,deepseek` orders agnostic providers without editing config.

## Explicit `provider::model` pin (contract)

A model in `providerId::modelName` form is a PIN: the request goes only to that
provider — **no cross-provider fallback and no silent substitution**. Failure
means an honest error from the chosen provider (limit/balance/server error) and
the user picks the next model themselves via `/model`. Reason: automatic
fallback once moved a user from a free model to a paid model on another
provider (an unexpected bill). A bare model (no `::`) keeps the old behaviour
(first-match + substitution + rate_limit/server/network fallback).

## Build & router

Provider building is centralised in `src/providers/build.ts`. The fallback router covers rate_limit/server/network (clone-error + base64 fix + retryAfter cap). The wire protocol is detected from the `/responses` probe path -> `responses` hint; host substrings are only a fallback. `max_tokens` is 8192; a `length` stop is an explicit warning, not silent text.

Responses API: `/v1/responses`, `previous_response_id` chaining per model, `store:false` by default.

## Global vs local

| File | Location | Notes |
|---|---|---|
| Global | `~/.minicode/config.json` | Applies to every workspace |
| Local | `.minicode/config.json` | Per repo; **ignored by default** — enabled with `--allow-local-config` / `MINICODE_ALLOW_LOCAL_CONFIG=1` |

Merged with **local taking priority**. Mutations (add/update provider, MCP, LSP) are written to the scope file they came from — not the merged result — to avoid duplication/shadowing. Every config write is atomic (tmp+rename randomUUID) + chmod 600.

**Why local config is ignored by default:** `.minicode/config.json` is often committed; a repo you clone could register MCP servers or hijack the prompt through config. Trust it only in a workspace you own.

## OAuth tokens are not in config

OAuth credentials live in `~/.minicode/auth.json` (chmod 600) — separate from config because local config is prone to being committed while secret tokens are short-lived. An OAuth provider stores `apiKey: ""` in config and fetches the token at runtime.

## Data locations

| Path | Contents |
|---|---|
| `~/.minicode/config.json` | Global config |
| `~/.minicode/auth.json` | OAuth tokens (chmod 600) |
| `.minicode/config.json` | Local config (ignored by default) |
| `.minicode/sessions.db` or `~/.minicode/sessions.db` | Sessions SQLite (WAL, capped + busy-retry); the location is chosen by `resolveDbPath` based on the presence of the workspace `.minicode/` |
| `.minicode/vector.db` or `~/.minicode/vector.db` | Hybrid vector memory index; uses the same database-location rule as sessions |
| `.minicode/tasks.db` | TaskGraph and scheduler; always local to the workspace |
| `.minicode/repomap.json` | Repo-map cache (mtime signature) |
| `.minicode/traces.jsonl` | Per-run telemetry (prompt scrubbed) |
| `.minicode/step-traces.jsonl` | Tool decision traces (the source for `minicode stats`) |
| `.minicode/checkpoints/` | Checkpoint manifests (newest 20) |
| `.minicode/todos/<id>.json` + `.minicode/plans/<id>.md` | Per-session todos and plan artefacts |
| `.minicode/.trash/` | `delete_file` soft-deletes (cap 100, gitignored) |
| `.minicode/MEMORY.md` + hierarchy | Memory files (global -> local -> root) |

Override the home for every local/global DB: `MINICODE_HOME` (especially for keeping tests hermetic on POSIX, where `homedir()` ignores `$HOME`).

## Next

- [Environment Variables](environment.md) — every `MINICODE_*`.
- [Memory & Sessions](memory-sessions.md) — the contents of `vector.db`, sessions, checkpoints.
- [Policy & Sandbox](policy-sandbox.md) — why config writes are always atomic + chmod 600.