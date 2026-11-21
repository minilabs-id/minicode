# Concepts & Design

What MiniCode is, why it is built this way, and why some things are deliberately absent. This page is the background; practical steps live in [Installation](getting-started.md).

## Two things, two roles

| Name | What it is |
|---|---|
| **MiniCore** | The `STATE / MODEL / ACTION / LOOP` runtime kernel. Zero-dependency, vendored into `vendor/minicore`; host-editable since v0.16.0 (the historical provenance figures are recorded in `vendor/minicore/VENDOR.md`). Not a dependency — resolved through the `#minicore` subpath import |
| **MiniCode** | The agent-code layer on top: tools, sub-agents, skills, hooks, policy/sandbox, providers, MCP/LSP, memory, sessions, repo-map, verifier, and a CLI with an interactive TUI plus a shell-first non-interactive path |

## The ReAct loop

Every prompt runs as a `Thought -> Action -> Observation` loop until a final answer, the `--max-steps` limit (default 200; the 50 figure is only the sub-agent cap), or `--timeout` (default 1 hour). The model receives a system prompt containing `# Environment` (cwd + platform), a condensed repo-map, and relevant memory — then selects a tool, observes the result, and picks the next step. There is no hidden flow graph: whatever the agent does shows up as a ledger on screen.

## Shell-first: plain non-interactive, fullscreen interactive

MiniCode deliberately uses **no third-party TUI library** (no Ink/React; the TUI
is hand-written) and splits the two paths sharply:

- **Non-interactive** (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`):
  output flows **append-only into the scrollback** — the agent's result is an
  ordinary terminal artifact you can pipe, grep, and keep in your own scrollback.
- **Interactive** (capable TTY): a single **fullscreen alternate-screen TUI** —
  shell-like transcript + one-line status bar + composite popups + an adaptive
  right sidebar (Thinking/Activity/Live) when `cols ≥ 100` **and** `rows ≥ 20`;
  the sidebar lives in the same paint frame as the chat, not in scrollback.
  Exiting restores the primary buffer exactly (the transcript is not dumped to
  scrollback).
- Colour only on a TTY; `NO_COLOR` always wins; program output stays free of cursor control when piped.

Full details and their FROZEN contract: [Terminal Contract](../TERMINAL_CONTRACT.md).

## Honesty as a feature

Several design decisions come from refusing to pretend:

- **Numbers are not written permanently** in the docs — run `bun test` / `bun run gate:coverage` / check CI. A page claiming a test count goes stale the moment it is pushed.
- **Failures are reported as they are**: `auth login` shows the raw server error; `minicode sync`/`/provider sync` honestly returns `{updated, failed}`; an unavailable sandbox is **not** labelled safe — the default falls back to `allowlist` and the reason is printed once.
- **Measure, do not claim**: bash-guard is validated against an attack corpus plus legitimate commands (run `bun run gate:bash`). See [Security](security.md).
- **Benchmark scores are reported as-is** with their validity limits (environment, sample size). See [Verify & Benchmark](verify-benchmark.md).

## Zero-dependency runtime

A runtime with no third-party dependencies; the only hard requirement is **Bun** (`bun:sqlite` is used directly — it does not run on Node.js). The markdown web parser, table/diff renderers, and highlighting are also hand-built miniatures, not libraries. The payoff: a smaller audit surface, fast installs, and a supply chain you can read in one sitting.

## Language

Source documentation and code comments are written in **Indonesian** with technical terms kept in English (`provider`, `checkpoint`, `sandbox`, `jail`). The Indonesian `docs/` tree is **authoritative**; this English edition is a full translation and may drift behind it on details — where they disagree, trust the Indonesian source. Both are generated into the website from the same repository.

## Glossary

MiniCode terms with a specific meaning.

| Term | Meaning |
|---|---|
| **MiniCore** | The `STATE / MODEL / ACTION / LOOP` runtime kernel vendored into `vendor/minicore`; frozen core, zero-dep, resolved via `#minicore` |
| **MiniCode** | The agent-code layer above MiniCore: tools, agents, policy, providers, memory, sessions, CLI |
| **Tool** | A capability the model selects inside the ReAct loop; MCP tools are added dynamically as `serverId.toolName` |
| **Tool scope** | `full` or a read-only `explore` subset — `--tool-scope` |
| **WorkMode** | How the agent works: `DISCUSS`, `PLAN`, or `BUILD` (product alias for the internal `EXECUTE` identity) |
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
| **Scrollback** | Terminal screen history; the non-interactive MiniCode path appends there (interactive uses the alternate screen) |
| **Transient** | A show-once UI element that erases itself (spinner, turn status line) — unlike the persistent transcript |
| **Composition root** | `cli/index.ts` + `cli/setup.ts`: the single place where DI is wired (provider, RAG, session, tools) |
| **Additive seam** | The only patches allowed into the frozen kernel: `compactAsync`, `initialMessages`, `cwd` |
| **Self-contained** | No other repo clone needed — kernel vendored, zero-dep runtime, requires Bun >= 1.1.13 |

## Next

- [Architecture](architecture.md) — three layers, boundaries, one prompt's flow.
- [Installation & Quickstart](getting-started.md) — from zero to a verified first prompt.