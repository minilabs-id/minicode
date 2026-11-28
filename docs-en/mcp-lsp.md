# MCP & LSP

Connect MiniCode to external tool servers (MCP) and language servers (LSP) for capabilities beyond the built-ins.

## MCP — two transports

```bash
# stdio — a local server spawned by minicode
minicode config mcp add fs --command npx --args "-y,@modelcontextprotocol/server-filesystem,."

# Streamable HTTP — a remote server (spec 2025-03-26, SSE also handled)
minicode config mcp add ctx7 --url https://mcp.example.com/mcp --header "authorization=Bearer xxx"

# localhost needs an explicit opt-in (anti-SSRF)
minicode config mcp add lokal --url http://127.0.0.1:3000/mcp --allow-private
```

Once registered, `mcp_list` shows **tools, resources, prompts** together:

| Tool | Spec | Notes |
|---|---|---|
| `mcp_list` | `tools/list` + `resources/list` + `prompts/list` | read-only, not gated |
| `mcp_call` | `tools/call` | gated |
| `mcp_read` | `resources/read` | gated (third-party content is a prompt-injection path). Binaries are replaced with a size marker |
| `mcp_prompt` | `prompts/get` | gated, the server renders the arguments |

Dynamic `serverId.toolName` tools appear automatically. `resources`/`prompts` are optional in the spec: a server answering "Method not found" still connects with its tools intact.

HTTP security: private hosts are denied unless `--allow-private` (the same guard as `web_fetch` with strict/no-cache DNS and private-host rejection; pricing sync uses `fetchPinnedUrl` with socket IP pinning and a 12 MiB cap). Redirects are not followed. Sizes are bounded. Responses are matched by request id. The `Authorization` header never reaches the logs.

Permissions: every dotted MCP tool is always gated. Under `ASK`, a call asks for confirmation once per server+tool+args triple (`[a] Always` persists to the allowlist); under `AUTO`, registered/authorised tools run without a prompt while unknown ones are *denied* (not prompted). `readonly`/`plan`/`allowlist` deny. There is no auto-allow wildcard (supply-chain protection).

Trust model: permissions only control *invocation*. The capability behind a server (filesystem, network, processes, APIs) cannot be known statically — treat every `mcp_call` as arbitrary external capability. Cancellation stops the local wait but does not prove the server stopped or abandoned effects it already accepted. If the connection drops after the request was sent, the tool returns an `outcome unknown` error; check the remote state before trying again.

Expose MiniCode back out (stdio only — no HTTP mode, so no network surface):

```bash
minicode mcp serve                            # curated tools + active permission
minicode mcp serve --cwd <dir>                # workspace root (jail + execution + journal share the same root)
minicode mcp serve --allow-all                # no prompts, but jail + bash-guard stay enforced
minicode mcp serve --all-tools                # includes delegate/memory/internal MCP (operator opt-in)
```

Server-mode semantics: each `tools/call` goes through kernel validateArgs -> permission (`auto` mode, or `allow-all` with the flag) -> execution -> mutation journal (`mcp-server`) -> response. Invalid arguments are rejected before execution; errors are scrubbed; output is capped and marked when truncated. The JSON-RPC request id provides idempotency: a concurrent duplicate executes once, a same-id retry replays the result (live process) or an explicit `already executed`/`failed`/`unknown` error (across restarts, from journal evidence) — it never blindly re-executes. `notifications/cancelled` cancels individual requests; at most 32 in flight. With no kernel turn/session there is no conversation persistence, checkpoint, or undo for server operations.

## LSP

```bash
minicode config lsp add .ts --command typescript-language-server --args --stdio
```

Once registered: `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols` (supporting hierarchical `DocumentSymbol` and `SymbolInformation`), `lsp_workspace_symbols`, and `lsp_rename` (seven tools). Diagnostics run automatically on `edit`/`write_file` when a server is configured, and all LSP tools take a `path` argument (v7.38+, replacing `file`).

- **Monorepo isolation & cache accuracy:** LSP instances are partitioned per `(ext, projectRoot)` using the nearest project root marker (`package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). Sending `didChange` clears stale diagnostics for modified contents, and read queries fail closed symmetrically if no server handles the extension.
- **Lifecycle & wire hiding:** `move_file` and `delete_file` trigger automatic `didClose` cleanup (and emit a pre-mutation `[dep-graph] warning:` if the target is still imported). When no LSP server is configured, all seven LSP tools are hidden automatically from the model's wire schema (`hiddenWireTools`) across main sessions, sub-agents, the autonomous scheduler, and `minicode mcp serve` (unless `--all-tools`).

`lsp_rename` (v7.38) is the **only LSP tool that writes** the workspace (via `atomicWriteText`), so it is **gated** like git-write (`path` + `symbol` or 0-based `line`/`character` + `newName`; fail-closed on missing server, empty edits, invalid `newName`, overlapping edits, or targets outside the workspace jail).

If LSP does not run: make sure the server is installed and the command is right (check `minicode doctor`). Even without active LSP, static dependency mapping runs via `dep_graph` (`src/repo/dep-graph.ts`), and the regex repo-map remains available (`MINICODE_REPOMAP=regex`).