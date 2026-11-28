# Concepts & Design

What MiniCode is, why it is built this way, and why some things are deliberately absent. This page is the background; practical steps live in [Installation](getting-started.md).

## Two things, two roles

| Name | What it is |
|---|---|
| **MiniCore** | The `STATE / MODEL / ACTION / LOOP` runtime kernel. Zero-dependency, vendored into `vendor/minicore`; host-editable since v0.16.0 (the historical provenance figures are recorded in `vendor/minicore/VENDOR.md`). Not a dependency — resolved through the `#minicore` subpath import |
| **MiniCode** | The agent-code layer on top: tools, sub-agents, skills, hooks, policy/sandbox, providers, MCP/LSP, memory, sessions, repo-map, verifier, and a CLI with an interactive TUI plus a shell-first non-interactive path |

## The ReAct loop

Every prompt runs as a `Thought -> Action -> Observation` loop until a final answer, the `--max-steps` limit (default 200; 600 is only the sub-agent hard cap), or `--timeout` (default 1 hour). The model receives a system prompt containing `# Environment` (cwd + platform), a condensed repo-map, and relevant memory — then selects a tool, observes the result, and picks the next step. There is no hidden flow graph: whatever the agent does shows up as a ledger on screen. Details of the two-row rounded composer, dropdown overlay, bracketed paste, static category recap, and OS-locale activity labels live in [TUI](repl.md) and [Terminal Contract](../docs/TERMINAL_CONTRACT.md).

## Shell-first: plain non-interactive, fullscreen interactive

MiniCode deliberately uses **no third-party TUI library** (no Ink/React; the TUI
is hand-written) and splits the two paths sharply:

- **Non-interactive** (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`):
  output flows **append-only into the scrollback** — the agent's result is an
  ordinary terminal artifact you can pipe, grep, and keep in your own scrollback.
- **Interactive** (capable TTY): a single **fullscreen alternate-screen TUI** —
  shell-like transcript + one-line status bar + composite popups. Since v0.34
  there is no right sidebar: the chat is a centred middle column — `cols ≥ 120
  && rows ≥ 20` gives `chatCols = floor(cols/2)` (max 50% of the terminal) with
  padding and a centred footer/composer, full width below that threshold; popups
  stay centred on the full terminal width. It is all one paint frame, not
  scrollback.
  Exiting restores the primary buffer exactly (the transcript is not dumped to
  scrollback).
- Colour only on a TTY; `NO_COLOR` always wins; program output stays free of cursor control when piped.

Full details and their FROZEN contract: [Terminal Contract](../docs/TERMINAL_CONTRACT.md).

## Honesty as a feature

Several design decisions come from refusing to pretend:

- **Numbers are not written permanently** in the docs — run `bun test` / `bun run gate:coverage` / check CI. A page claiming a test count goes stale the moment it is pushed.
- **Failures are reported as they are**: `auth login` shows the raw server error; `minicode sync`/`/provider sync` honestly returns `{updated, failed}`; an unavailable sandbox is **not** labelled safe — the default falls back to `allowlist` and the reason is printed once.
- **Measure, do not claim**: bash-guard is validated against an attack corpus plus legitimate commands (run `bun run gate:bash`). See [Security](security.md).
- **Benchmark scores are reported as-is** with their validity limits (environment, sample size). See [Verify & Benchmark](verify-benchmark.md).

## Runtime with no third-party production dependencies

Production runtime has zero third-party packages in `dependencies` (`package.json` keeps test/lint tooling in `devDependencies`); the only hard requirement is **Bun** `>= 1.1.13` (`bun:sqlite` is used directly — it does not run on Node.js). The markdown parser, table/diff renderers, and highlighting are also hand-built without external UI libraries, keeping the audit surface and supply chain small.

## Language

Source documentation and code comments are written in **Indonesian** with technical terms kept in English (`provider`, `checkpoint`, `sandbox`, `jail`). The Indonesian `docs/` tree is **authoritative**; this English edition is a full translation and may drift behind it on details — where they disagree, trust the Indonesian source. Both are generated into the website from the same repository.

## Glossary

MiniCode terms with a specific meaning.

| Term | Meaning |
|---|---|
| **MiniCore** | The `STATE / MODEL / ACTION / LOOP` runtime kernel vendored into `vendor/minicore` (host-editable since v0.16.0), zero-dep, resolved via `#minicore` |
| **MiniCode** | The agent-code layer above MiniCore: tools, agents, policy, providers, memory, sessions, CLI |
| **Tool** | A capability the model selects inside the ReAct loop; MCP tools are added dynamically as `serverId.toolName` |
| **Tool scope** | `full` or a read-only `explore` subset — `--tool-scope` |
| **WorkMode** | How the agent works: `DISCUSS` or `BUILD` (product alias for the internal `EXECUTE` identity); legacy `PLAN` normalises to `DISCUSS` |
| **PermissionMode** | The supervision choice: `AUTO` runs authorised capabilities; `ASK` requests approval for gated actions |
| **Tool Access Policy** | The available capability boundary, such as read-only, allowlist, or the legacy `--allow-all` access profile |
| **Gate** | A tool requiring human approval on a TTY; non-TTY always denies (e.g. `git_commit`, MCP, `delegate_task`) |
| **Path jail** | Restricting file access to the workspace (realpath + symlink; `O_NOFOLLOW` on POSIX and `dev+ino` handle-identity matching on all platforms); active even under `--allow-all` |
| **Bash-guard** | Normalisation + blocking of dangerous bash patterns before execution (quote-split, indirection, wrappers); a platform-aware tokenizer (`shell-tokenize.ts`) splits arguments before a mutating-verb denylist runs ahead of the allowlist |
| **OS sandbox** | bubblewrap (Linux) / seatbelt (macOS) — automatic when available |
| **Docker sandbox** | Ephemeral container `--network none`, 512m, 1 CPU, `node:22-alpine` |
| **Checkpoint** | A per-turn snapshot via shadow-git: tree SHA under `refs/minicode/...` (O(delta), HEAD/index untouched) |
| **Recovery journal** | `journal-<session>.jsonl`: `pending` -> `committed`/`failed`/`unknown`; finalisation marks which turns are already durable |
| **Session** | History stored in `.minicode/sessions.db` (SQLite WAL); compaction may replace older parts with a summary + tail |
| **Two-tier memory** | Hierarchical `MEMORY.md` (always in the system prompt) + hybrid vector RAG (injected when the score clears the threshold) |
| **Hybrid RAG** | Memory search with cosine 0.7 + keyword 0.3, MMR ranking (lambda 0.7), dedup >0.92 |
| **Repo-map** | Per-file symbols (9-language regex, LSP fallback) injected into the system prompt |
| **Skill** | A packaged prompt `.minicode/skills/*.md` with `name`/`description` frontmatter |
| **Hook** | `pre/post-run` scripts from `~/.minicode/hooks` + `.minicode/hooks`; off by default, `MINICODE_HOOKS=1` |
| **Env scrub** | `sanitizeSpawnEnv` strips credential keywords from subprocess env |
| **Secret scrubber** | Redacts `sk-`/`ghp_`/`AKIA`/PEM/JWT/Bearer before text reaches the LLM |
| **Ledger** | Lines `  > name target` / `  > name: ...` on stderr — the trace of agent actions |
| **Category recap** | Since v0.35: a static committed row at the footer of each narration (`tool -> narration -> recap(tools before that narration)`, e.g. `2 command · 118 read · 1 other` since v0.41 without a symbol prefix); the final turn recap is cumulative for every tool. Replaces the two-line live recap / net-zero `flushActivityFold` / tail-following `liveSummaryRows` of archived v0.33/v7.x |
| **Tool activity label** | The `› …` prefix (tool name/status), which uses the **OS locale** via `Intl` (id/en) on every surface (TUI, one-shot/`exec`, ACP via `simple.ts`) — distinct from narration/model answers, which keep `/lang`. Single resolver: `src/ui/render/tool-label.ts` |
| **Composer (v0.36–v0.37)** | The TUI input area, at most **2 rows** tall; a long draft uses a sliding window that adds no rows and does not shift the transcript. `composerWidth()`/`chatWidth()` share one source in `chat-column.ts`; v0.37 cap = `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (100→100, 200→125, 300→150, 500→200); prefix `minicode › ` when `w−14 ≥ 24` / else `› `, continuation `· ` |
| **Bracketed paste & select-all (v0.37)** | `?2004h`/`?2004l` in the TUI/`askLine`/`askSecret`/output window, written outside the frame (I1 intact); a paste CR is not a submit. `Ctrl+A` = `selectAll` with an empty composer and closed dropdown (else `Home`); `Ctrl+C` copies even while a drag is active; resize rebases the scroll anchor even with an active selection |
| **Dropdown overlay (v0.36)** | The `/` menu drawn inside the same `paint()` frame (one `stdout.write`, I1), covering the lower transcript rows without reducing `viewH` — not a separate `paintRegion()`; a click in the dropdown area selects a menu item |
| **Scrollback** | Terminal screen history; the non-interactive MiniCode path appends there (interactive uses the alternate screen) |
| **Transient** | A show-once UI element that erases itself (spinner, turn status line) — unlike the persistent transcript |
| **Composition root** | `cli/index.ts` + `cli/setup.ts`: the single place where DI is wired (provider, RAG, session, tools) |
| **Additive seam** | The only patches allowed into the frozen kernel: `compactAsync`, `initialMessages`, `cwd` |
| **Self-contained** | No other repo clone needed — kernel vendored, zero-dep runtime, requires Bun >= 1.1.13 |

## Next

- [Architecture](architecture.md) — three layers, boundaries, one prompt's flow.
- [Installation & Quickstart](getting-started.md) — from zero to a verified first prompt.