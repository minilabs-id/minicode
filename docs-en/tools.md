# Tools

The complete MiniCode tool reference: filesystem, search, exec, git, web, memory, plan, agents, MCP, LSP.

Choose these tools when: **file** for precise reads/writes (not `cat` via bash); **search** to find code (not `grep` via bash); **bash** for commands that genuinely need a shell; **git tool** for status/diff/log/commit (not raw `git` — read operations are neutralised and commit refuses custom repo filters); **web** for public sources; **memory** for cross-session facts (not prompt stuffing); **delegate** for parallel investigation whose results the parent verifies.

The authoritative list at any time:

```bash
bun -e "import {allTools} from './src/tools/index.ts'; console.log(allTools.map(t=>t.name))"
```

The file tools' `cwd` **must** come from `ToolContext.cwd`, never `process.cwd()` (the `cwd?: string` seam in the kernel + `resolve(sessionRoot, raw)` + a per-cwd file lock).

## Filesystem

| Tool | Function | Notes |
|---|---|---|
| `read_file` | Read text + line numbers, `offset/limit` chunks | The footer gives the next offset. >2 MB requires `offset/limit` rather than a silent truncation. Realpath jail + secret scrub. Output `12: const x = 1` so `edit` references are accurate |
| `write_file` | Create/overwrite, auto-create parents | Atomic tmp->rename + mkdir. Automatic LSP diagnostics when a server is configured |
| `edit` | Replace a string (must match exactly once) | Unique + atomic, fuzzy CRLF/whitespace + deterministic hashline (`src/tools/hashline.ts`) |
| `apply_patch` | Multi-hunk Aider-style SEARCH/REPLACE blocks | Many patches in one call |
| `move_file` | Atomic move/rename | An existing destination is first backed up to trash (the path is recorded). Jailed in the permission layer too |
| `delete_file` | Soft-delete into `.minicode/.trash/` | Undo via `move_file`. Capped at the newest 100, gitignored. Shared helper `src/lib/trash.ts` |
| `read_image` | Image -> model context | Full base64 + reports `(bytes mime, tokens)` via `estimateImageTokens`. Opening checks the canonical target, a boundary re-check, `dev+ino` handle identity, and hardlinks (`safeOpenRead`). A 2 MB file-size guard applies, but the effective limit is stricter: base64 is bounded by the kernel truncation budget (`toolResultMaxTokens` 4096x4-200 ~ 16 KB) so images are not corrupted mid-truncation |

Paging examples:

```
read_file({ path: "src/big.ts" })
read_file({ path: "src/big.ts", offset: 2001 })
read_file({ path: "src/big.ts", offset: 500, limit: 50 })
```

## Search

| Tool | Function | Notes |
|---|---|---|
| `glob` | Find `**/*.ts` patterns | Supports `{a,b}`, cwd jail |
| `grep` | Cross-file regex | `rg --vimgrep --no-follow` when on PATH, otherwise an internal walker fallback. Both use the same jail + secret scrub and produce identical results. `MINICODE_GREP_ENGINE=js` forces the fallback. If `rg` fails (different regex flavour), it falls back automatically with a warning |

## Exec

| Tool | Function | Notes |
|---|---|---|
| `bash` | Shell, 30 s SIGTERM->SIGKILL | Without `MINICODE_SANDBOX` it runs on the HOST (network not isolated, audited in step-traces). A platform-aware tokenizer (`src/policy/shell-tokenize.ts`: POSIX quotes/backslash, Windows caret, literal single quotes) splits arguments before a **mutating-verb denylist** runs ahead of the allowlist. cwd jail (= execution cwd, not process.cwd), credential env stripped (`sanitizeSpawnEnv`), streaming progress, `background:true` + `bash_output`/`bash_kill`, optional docker/os sandbox. An explicit sandbox request without a backend is REJECTED (fail-closed); host fallback only via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`. `background:true` is rejected while `--sandbox` is active and inside sub-agents |
| `bash_output` | NEW output since the last read | + exit status |
| `bash_kill` | Stop the job | SIGTERM then SIGKILL; tree-kill (`taskkill /T /F` on Windows, process group on POSIX) |
| `code_run` | Python/node snippet without a shell | Spawns argv directly (no shell, so `$(...)` is not shell-expanded first). Requires an `os|docker` sandbox (aliases `bwrap`/`seatbelt`), network-isolated, cwd = session root. Fail-closed when the backend is unavailable. The default `node:22-alpine` image ships only node — python needs a `MINICODE_SANDBOX_IMAGE` that provides it |

Background:

```
bash({ cmd: "bun run dev", background: true })  # -> bg_xxxxxxxx
bash_output({ id: "bg_xxxxxxxx" })
bash_kill({ id: "bg_xxxxxxxx" })
```

Bounded by `BASH_BACKGROUND_MAX_JOBS`; every job dies when the CLI exits.

## Git (read + a single writer)

| Tool | Function | Notes |
|---|---|---|
| `git_status` | `status --porcelain + diff --stat + log -10` | cwd jail |
| `git_diff` | Unstaged `diff` or `--staged` | — |
| `git_log` | `log --oneline -n` | — |
| `git_commit` | Commit only | **Gated** like `delegate_task` (TTY asks once, non-TTY denies; `readonly/plan/allowlist` deny). Refuses before staging if the effective Git config carries a custom filter; review trusted filters then commit manually. Sub-agents do not get it. Deliberately absent: amend/reset/rebase/checkout/branch -D/stash drop. The message goes through a single `-m` so `$()`/backticks are not expanded; `git add -- <paths>` so a file named `-weird.txt` is not treated as a flag |
| `git_push` | Push a local branch to a remote | **Gated** like `git_commit`; requires an explicit branch/remote or `setUpstream`. `GIT_SAFE_BASE` hardening neutralises pre-push hooks + repo filters. In `unrestricted` mode, narrow git credentials (`GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`) are forwarded to the subprocess; in other modes the push only succeeds when credentials are already available on the machine (e.g. an OS credential helper). Sub-agents do not get it |

## Web

| Tool | Function | Notes |
|---|---|---|
| `web_fetch` | GET a public URL, 10 s, max 50k chars | SSRF guard + DNS pinning, manual redirects up to 5 hops, 2 MB hard body cap |
| `web_search` | Search web or developer sources | Web: `TAVILY_API_KEY` -> `BRAVE_API_KEY` -> Firecrawl keyless -> Mwmbl -> Marginalia -> DDG opt-in (`MINICODE_ALLOW_DDG=1`). Coding: `source=stackoverflow|hn|github|github-issues|grep|wikipedia|arxiv|crossref|openalex|papers|dev` (no key; per-source rate limits) |

`source=dev` combines Stack Overflow + Hacker News + GitHub repos/issues + grep.app. `source=papers` combines OpenAlex + arXiv + Crossref. Keyless quotas: Stack Exchange 300 requests/day per IP, GitHub 60 requests/hour unauthenticated (search endpoints are stricter), HN/arXiv/Crossref/OpenAlex/grep.app have no published limit (use politely). All results are still fenced as untrusted output.

For JavaScript-rendered pages or UI clicks/forms/verification, `agent-browser` via bash is an optional route (not a built-in tool): detect it with `where.exe agent-browser`, or `npx --yes agent-browser open <url>` if not yet installed. Prefer the Chrome already on the system — agent-browser uses it automatically, and a fresh browser profile is still recommended. Since the owner decision of 2026-11-23, the subcommands `install`, `eval`, and `mcp` are **explicitly allowed** (no longer denied); `agent-browser install` downloads hundreds of MB of Chrome for Testing, so use it only when needed — OS-level Chrome updates are preferable. `--auto-connect` is **withdrawn** — not used; the browser is always fresh or uses the profile from `.minicode` settings. The allowlisted subcommands are: `open`, `snapshot`, `click`, `fill`, `errors`, `console`, `network`, `get`, `close`, `skills get core`, `--version`, `install`, `eval`, `mcp`; every `npx ...` form (including `npx agent-browser ...`) is already covered by the `npx *` pattern. The global skill `~/.minicode/skills/agent-browser.md` holds the token-efficient sequence and safety flags; the light `--engine obscura` option without Chrome is experimental. If the browser is not ready, fall back to `web_fetch`/`web_search` and do not claim UI interaction.

## Memory & plan

| Tool | Function | Notes |
|---|---|---|
| `read_memory` | Read `MEMORY.md` + hybrid vector RAG | — |
| `write_memory` | Write + vector store | `{category?, tags?}`, default `fact`. Categories `fact\|decision\|preference\|snippet\|summary`, `decision` gets +0.1 boost |
| `forget_memory` | Delete matches for a query | Deletes the vector + file rows in both local AND global scope (both are searched; root `MEMORY.md`/`CLAUDE.md` are excluded). Count-first-then-DELETE (the FTS trigger confuses `sqlite3_changes`) |
| `todo_write` / `todo_read` | Per-session plan (3+ steps) | Send the **whole list** every time. Status `pending\|in_progress\|completed\|cancelled`, exactly one `in_progress` is maintained. Stored in `.minicode/todos/<session>.json` + an artefact `.minicode/plans/<id>.md` |
| `submit_result` | Final structured JSON result, once | NO_PROMPT, `exec --json` verbatim. An explicit `result.findings` is projected as `finding.detected`. A replacement for `response_format` |
| `ask_user` | Ask for mid-run clarification | Gated + rendered via the `promptAskText` injection (fail-closed on non-TTY) |

## Agents

| Tool | Function | Notes |
|---|---|---|
| `delegate_task` | Isolated `explore`/`plan` sub-agent | Pool of 3 by default (`MINICODE_SUB_AGENT_POOL_SIZE`, 1..16), separate context/memory/signal/budget, abort-aware. Pass `scope` (`file`/`dir`/`subtree`/`repo`) for budgets 12/18/26/36 steps (`plan` ×1.5, clamped to `[8,50]`), escalated through `[8,12,20,32,50]` when stalled — do **not** set `maxSteps` yourself (it disables escalation); without `scope`, the 5/15 fallback applies. Split wide fan-out into 2–3 per turn and give children a `name` for human labels. `timeoutMs` overrides the 300,000 ms default (`MINICODE_SUB_AGENT_TIMEOUT_MS`); on timeout streamed text is kept and file effects are not rolled back. Under ASK a TTY requests approval and non-TTY denies (even with the daemon approval broker injected — `allowNonTtyAsk` is only for non-gated tools); AUTO runs without a prompt when authorised. A parent PermissionMode of `ASK`/`plan`/`readonly` forces `explore`; WorkMode `DISCUSS` restricts child tools to the exploration subset, while `BUILD` lets a `plan` child keep the available base tools. Children get no commit, no memory/todo writes, no nesting, no background jobs; built-in MCP tools (`mcp_call`/`mcp_read`/`mcp_prompt`) are included only in a child `plan` mode under `BUILD`. One approval covers one delegation (no "Always" option); a turn that fails after the child committed yields a `[recovery]` warning |

## MCP

| Tool | Spec | Notes |
|---|---|---|
| `mcp_list` | `tools/list` + `resources/list` + `prompts/list` | Read-only, not gated. Call this first |
| `mcp_call` | `tools/call` | Gated. 1 approval = 1 call. Runs outside MiniCode's policy. An abort/timeout after the request was sent is reported as `outcome unknown`; check the server state before retrying |
| `mcp_read` | `resources/read` | Gated **even though read-only** (third-party content is a prompt-injection path). Binaries are replaced with a size marker |
| `mcp_prompt` | `prompts/get` | Gated, the server renders the arguments |

Plus dynamic `serverId.toolName` tools. Anything dotted is always gated (no auto-allow wildcard). Transport details in [MCP & LSP](mcp-lsp.md).

## LSP

Requires `minicode config lsp add` first. Once registered:

| Tool | Function |
|---|---|
| `lsp_diagnostics` | Diagnostics for one file |
| `lsp_definition` | Definition location (`file+symbol` or `line/character`) |
| `lsp_references` | All references repo-wide |
| `lsp_hover` | Type information |
| `lsp_symbols` | Document outline |
| `lsp_workspace_symbols` | Workspace-wide search; an empty query returns popular symbols |

`didClose` cleanup is automatic.

## The check chain

`PermissionHandler -> validateArgs (kernel) -> executor (order/cap/abort-aware) -> tool realpath+atomic(O_EXCL) -> execute`. The executor is order-preserving: mixed steps run sequentially, pure reads in parallel, writes are capped, and the queue is abort-aware.