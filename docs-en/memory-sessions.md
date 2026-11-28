# Memory & Sessions

## Two-tier memory

1. The hierarchical `MEMORY.md` (global -> local -> root -> `CLAUDE.md` -> `.minicode/rules/*.md`) is always loaded into the system prompt.
2. The hybrid vector index (`vector.db`, cosine 0.7 + keyword 0.3) is injected as `# Relevant memory` when the score clears the threshold (0.20 hybrid / 0.25 keyword-only). MMR ranking (lambda 0.7) + cosine dedup >0.92 keep the prompt free of paraphrase. Entries over 2000 chars are split into chunks with 200-char overlap.

Categories: `fact|decision|preference|snippet|summary` + `tags`. Default `fact`; `decision` gets a +0.1 boost when the query matches. `write_memory {category?, tags?}`.

Read scope: `cwd` (default) | `global` | `all` (merged, no silent shadowing). Set via `MINICODE_MEMORY_SCOPE`.

Hierarchical retention per category: `fact`/`decision`/`preference` 180 days, `summary` 90 days, `snippet` 14 days; maximum 5000 rows, periodic prune + `VACUUM` on every write. `access_count` per row.

```bash
minicode memory status [--json]   # rows, DB/WAL/SHM bytes, model/dim spread, RAG hit-rate
minicode memory reconcile [--json] [--cwd PATH]   # align vector.db <-> MEMORY.md
```

`reconcile` adopts vector-only entries into `MEMORY.md` and adds file-only rows
to the index (it never deletes facts); run it when `write_memory` reports
"vector index unavailable".

Auto-save: persistent summaries + verified snippets. Opt out with `MINICODE_AUTO_MEMORY=0`.

Embedding: default `text-embedding-3-small` (`MINICODE_EMBED_MODEL`). A dimension mismatch warns once and falls back to keyword-only. FTS5 (`porter unicode61`) + sync triggers; LIKE fallback when MATCH fails.

## Sessions

Sessions live in `.minicode/sessions.db` (WAL, capped + async busy-retry). `--resume <id>` continues the history stored at that moment, including `toolCallId`/`name`; after compaction the older history may already be replaced by a summary + tail, so it is not a full copy of the original conversation. The workspace is compared against the last checkpoint and divergence is reported (not a blind replay). TTL 30 days (`MINICODE_SESSION_TTL_DAYS=0` = forever). `minicode sessions purge` removes them manually. Branch via `branchSession` (fork from stored history + turns).

One writer per session (P2.2): the composition acquires the authority lease (`tasks.db: session_authority`) at start and releases it on close; a second process on the same session is refused (`REFUSED_LEASE_HELD`). Every session mutation carries a `writer_epoch` that is CAS-checked inside the same SQLite transaction — a writer that goes stale after a takeover is refused (`REFUSED_STALE_EPOCH`), with no partial write. Three concepts stay distinct: **lease** = admission (may write), **writer_epoch** = mutation guard (is this write still valid), **incarnation** = identity generation across delete/recreate.

## Checkpoints & Undo

Every turn is checkpointed automatically. Two automatic modes:

**Git repo (primary).** Snapshots as **git tree SHAs** — O(delta), no file-count cap. Index/`HEAD` are never touched (no add/commit/checkout/reset/stash on user state). Refs under `refs/minicode/<session>/...` point at *trees* so they do not show up in `git log`. Safe from `gc` (refs pin objects). `core.autocrlf=false` is forced. Restore only touches differing paths.

Limit: snapshots use `git add -A`, so `.gitignore`d files are excluded (deliberate, so `node_modules` is not included).

**Non-repo (fallback).** File-content snapshots with a `WORKSPACE_SNAPSHOT_LIMIT` cap.

`/undo [n|list]` restores files AND conversation as one operation: files return to the first checkpoint at/after the turn boundary, then a branch session is created from the prefix before the target prompt; the original session stays intact and the target prompt opens as a composer draft. `/redo` restores the workspace to the pre-undo snapshot and opens the original session; redo is refused when the branch already has a new turn. Manual file edits outside turns are not detected — redo restores the pre-undo snapshot. Manifests in `.minicode/checkpoints/` are capped at the newest 20. Checkpoints are recorded for successful, failed, and cancelled turns; failed prompts remain durable as presentation events (the kernel discards no-progress input from messages) so they stay undoable. A turn with no changes creates no checkpoint. The pointer comes from a journal marker (not absolute truth) — a crash mid-way is adopted from the next valid marker. Restore is fail-closed: a failed diff read throws (it is not treated as "identical"), and a failed `rm` is recorded as `skipped: remove failed: <code>` (not `(removed)`) — do not assume the file was really deleted.

## Recovery journal

Every mutation (write/edit/delete, `bash`, `git_commit`, `mcp_call`, `code_run`, `delegate_task`, memory write/delete) is recorded in `.minicode/journal-<session>.jsonl` — called the *mutation journal* in the code: `pending` -> `committed`/`failed`/`unknown`; finalisation marks which turns are already durable in SQLite. On resume it is read **before** the kernel is seeded:

- A `committed` entry whose turn is gone -> not repeated; the model gets a narrative note.
- `pending`/`failed`/`unknown` -> a verification directive; blind redo is forbidden.
- A `committed` MCP entry = *externally acknowledged*, so it must be read back.

The journal is not an atomic transaction; `pending` means ambiguous (the effect may already have happened). Only hashes + relative paths (no content, no credentials). The file is created eagerly when the session attaches. A child's journal is separate per child session. `sessions purge` also removes stale journals.

## Context & compaction

The model only sees a bounded history window (**context**). When the conversation presses against that window, MiniCode **compacts**: older turns are replaced with a single summary while recent turns stay intact. You see it as a `… compacted: <reason>` line in the output (`… dipadatkan: <reason>` in the `id` locale), with variants such as `nothing evictable`, `target unreachable with only N messages left`, and `LLM summary failed (…), using mechanical summary`.

The context limit is read per model from `providers[].contextWindows` (exact model ID, then `"*"`); `--context-window` overrides config for that session. Without metadata, an unknown model gets a 32,000-token fallback (with a warning), and router aliases (`auto`/`best`/...) get a conservative 128K default so compaction is not premature. The estimator is **density-aware** — code/JSON counts at ~2.4 chars/token and CJK/emoji at ~1 — and is calibrated per provider/model after actual usage; open models (deepseek/qwen/mistral/gemma/phi) can use an **on-demand precise tokenizer** from HuggingFace.

- **When it happens:** automatically under context pressure, before the request is sent. Resume bounds the projection and history; the kernel counts the system prompt and tool schema before admission. Model output is stopped when the remaining budget runs out. If the current prompt/instructions themselves do not fit, the run fails with a reason and next steps.
- **What is kept:** factual summary — file paths, signatures, important snippets, tool results, errors, next steps. Old and new summaries are size-bounded; if the summary projection is too large, the old part is explicitly truncated or the selector picks the history tail that fits.
- **What may be lost:** the full text of old turns (prose is cut at ~250 chars/line; **fact-bearing** tool results — grep/bash/read/test/fetch — are kept longer, ~800 chars/line), tool output detail beyond that head budget, the exact conversation order.
- **The original history is not stored twice:** the running and stored sessions follow the latest state (summary + new turns). Anything that must survive across sessions should be written explicitly with `write_memory`.
- **Smarter summaries when a DeepSeek key is present** (`DEEPSEEK_API_KEY`) **or the session provider is available**: the summary is LLM-made (60 s total timeout, 25 s to first byte, 15 s idle) — a cheap DeepSeek summarizer when its key exists, otherwise the session router/provider is reused; without either, a mechanical summary is used. Compaction requests use strict/noCache DNS resolution against rebinding, but the OpenAI-compatible summarizer still goes through the global `fetch` (residual). Both fence untrusted content as data + secret-scrub before summarising.
- **How it differs from memory:** the context summary lives in the running session; `write_memory`/vector lives across sessions and can be retrieved. Summaries are also stored as `summary`-category memory — disable with `MINICODE_AUTO_MEMORY=0` if unwanted.

## Repo intelligence & telemetry

The system prompt carries a regex repo-map (9 languages) + LSP `workspace/symbol` fallback. Cache in `.minicode/repomap.json` (mtime signature). Files are ordered by import graph (60 files, 2.5k chars). `MINICODE_REPOMAP=regex` skips LSP. Tree-sitter is deliberately not used (notes in `src/repo/repomap.ts`).

Telemetry `.minicode/traces.jsonl` — one line per run (tokens, steps, cost, duration); prompt scrubbed; chmod 600; rotated at 1000 lines. Opt out with `MINICODE_TELEMETRY=0`. `minicode stats` shows the deny rate from `step-traces.jsonl`.