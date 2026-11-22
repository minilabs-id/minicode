# MiniCode Documentation

MiniCode is a terminal coding agent built on the MiniCore kernel. The interactive path uses a fullscreen TUI with the chat as a centred middle column (at most 50% of terminal width, footer/composer centred with it; full width below the threshold) — there is no right sidebar. Tool lines, the `✦` agent aggregate, findings, and the `+ thinking` marker appear in the chat; one-shot and automated paths write to the scrollback or to a machine-readable stream according to their contract. Since v0.35 the tool recap is a static committed row `└ …` at the footer of each narration (cumulative at the end of a turn), and the `› …` activity label uses the OS locale via `Intl` — narration/model answers still use the user's `/lang` language. Since v0.36 the TUI composer is at most 2 rows tall (a long draft uses a sliding window, without shifting the transcript), the `/` dropdown is an overlay inside the same frame without reducing `viewH`, and prompt/cursor width uses `composerWidth() = min(100, chatWidth())` with an adaptive prefix `minicode › `/`› ` plus `· ` for continuation rows (that v0.36 cap/threshold is superseded by v0.37). Since v0.37 bracketed paste is active (`?2004h`/`?2004l` outside the frame), `Ctrl+A` selects the whole transcript when the composer is empty and the dropdown is closed, resize stabilises auto-scroll/drag/cursor/anchor, the echoed prompt is wrapped once to the chat width, and the prompt cap is progressive `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (prefix `minicode › ` when `w−14 ≥ 24`) — the 2-row composer and one-frame dropdown are not revoked.

## Start here

1. Follow the [installation guide](getting-started.md). Package metadata and the Bun runtime floor live in `package.json` at the repository root.
2. Use the [quickstart](getting-started.md) to configure a provider and run your first prompt.
3. Read [choosing a mode](choosing-mode.md) before granting the agent write or execution access.

## Limits worth knowing

- Prompts and context are sent to the provider you configure. Configured MCP and LSP servers may also receive data or perform external effects.
- The path jail, bash guard, WorkMode, PermissionMode, and tool access policy constrain execution; they do not guarantee that model output is correct.
- Operational limits and contracts are described in the active guides in this directory. Dated audit reports have been trimmed from the documentation baseline.

## Documentation map

`SUMMARY.md` is the navigation list; the minilabs build reads it to construct the page index. The page count is kept small and free of duplication — one topic, one page. The published version is available at [minilabs.id/en/projects/minicode/docs](https://minilabs.id/en/projects/minicode/docs/); the Indonesian set lives at [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). [Architecture](architecture.md) holds the structure map and runtime flow.

## Development

Contributor guide, gates, and layer boundaries: [contributing.md](contributing.md). Agent rules live in `AGENTS.md` at the repository root. The master roadmap is owned by the repository owner and is not available in this checkout.
