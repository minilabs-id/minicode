# MiniCode Documentation

MiniCode is a terminal coding agent built on the MiniCore kernel: the interactive path uses a fullscreen TUI with a centred chat column and no right sidebar; one-shot/automated paths write to the scrollback or a machine-readable stream. Current behaviour (live tool rows stay transient and follow the tail, with a per-turn `scrollBack` ratchet keeping committed rows in place while committed chat history stays intact; static recap without a `└` marker, OS-locale activity labels, two-row composer, bracketed paste, diagnostic auto-update) is recorded in the [Terminal Contract](../docs/TERMINAL_CONTRACT.md).

## Start here

1. Follow the [installation guide](getting-started.md). Package metadata and the Bun runtime floor live in `package.json` at the repository root.
2. Use the [quickstart](getting-started.md) to configure a provider and run your first prompt.
3. Read [choosing a mode](choosing-mode.md) before granting the agent write or execution access.

## Limits worth knowing

- Prompts and context are sent to the provider you configure. Configured MCP and LSP servers may also receive data or perform external effects.
- The path jail, bash guard (platform-aware shell tokenizer + mutation-verb denylist), WorkMode, PermissionMode, and tool access policy constrain execution; they do not guarantee that model output is correct.
- `fetchPinnedUrl` pins addresses to prevent SSRF on pricing, DNS strict/noCache is used during compaction, the verifier caps `maxBuffer` at 32 MB and classifies infrastructure failures, and undo/restore is fail-closed (a failed `rm` is recorded as `skipped`).
- Operational limits and contracts are described in the active guides in this directory. Dated audit reports have been trimmed from the documentation baseline.

## Documentation map

`SUMMARY.md` is the navigation list; the minilabs build reads it to construct the page index. The page count is kept small and free of duplication — one topic, one page. The published version is available at [minilabs.id/en/projects/minicode/docs](https://minilabs.id/en/projects/minicode/docs/); the Indonesian set lives at [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). [Architecture](architecture.md) holds the structure map and runtime flow.

## Development

Contributor guide, gates, and layer boundaries: [contributing.md](contributing.md). Agent rules live in `AGENTS.md` at the repository root. The master roadmap is owned by the repository owner and is not available in this checkout.
