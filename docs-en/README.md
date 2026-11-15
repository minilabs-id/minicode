# MiniCode Documentation

MiniCode is a terminal coding agent built on the MiniCore kernel. The interactive path uses a fullscreen TUI; one-shot and automated paths write to the scrollback or to a machine-readable stream according to their contract.

## Start here

1. Follow the [installation guide](getting-started.md). Package metadata and the Bun runtime floor live in `package.json` at the repository root.
2. Use the [quickstart](getting-started.md) to configure a provider and run your first prompt.
3. Read [choosing a mode](choosing-mode.md) before granting the agent write or execution access.

## Limits worth knowing

- Prompts and context are sent to the provider you configure. Configured MCP and LSP servers may also receive data or perform external effects.
- The path jail, bash guard, WorkMode, PermissionMode, and tool access policy constrain execution; they do not guarantee that model output is correct.
- Operational limits and contracts are described in the active guides in this directory. Dated audit reports have been trimmed from the documentation baseline.

## Documentation map

`SUMMARY.md` is the navigation list; the minilabs build reads it to construct the page index. The page count is kept small and free of duplication — one topic, one page. The published version is available at [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). [Architecture](architecture.md) holds the structure map and runtime flow.

## Development

Contributor guide, gates, and layer boundaries: [contributing.md](contributing.md). Agent rules live in `AGENTS.md` at the repository root. The master roadmap is owned by the repository owner and is not available in this checkout.
