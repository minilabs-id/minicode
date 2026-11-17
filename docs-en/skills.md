# Skills & Hooks

## Skills

A skill is a markdown file with `name` + `description` frontmatter, placed in `.minicode/skills/*.md` (recursive; `**/*.md` is also supported):

```markdown
---
name: review
description: Review code changes
---
Review this diff: {{args}}
```

- Body placeholders: `{{args}}` or `$ARGUMENTS` — receives the arguments after the skill name.
- Automatic slug: `My Skill` -> `my-skill`.
- Call it from the TUI or a one-shot prompt: `/review src/a.ts` or `minicode "/review src/a.ts"`.
- Skills appear in the `/` dropdown (grouped with slash commands) and `minicode skills list` shows what is installed.
- **`disable-model-invocation: true`** in the frontmatter = the skill is available ONLY via an explicit `/name` and is excluded from the auto-pick catalogue in the system prompt. For workflows that must not be triggered by the model itself (deploy/release).
- **Sibling assets** (optional, Zed style): the folder `.minicode/skills/<name>/` may hold `scripts/` and `references/` — listed as reading hints in the catalogue (`scripts: check.sh; refs: guide.md`), read by the model via `read_file` when needed, NOT executed automatically.

Important behaviour:

- A skill is **not a tool** — it extends the first prompt, so it is still subject to the same permission mode.
- The `/` dropdown offers builtin commands, driver commands (`/view`/`/mode`/`/undo`/...), and installed skills. `Tab` is NOT autocomplete — it cycles WorkMode (`Shift+Tab` cycles PermissionMode).

## AGENTS.md: project instructions

`/init` creates an `AGENTS.md` for the project you are working on. This file (together with the hierarchical `MEMORY.md`) goes into the system prompt on every run — the right place for build conventions, lint rules, and "do not touch X". Order and details in [Memory](memory-sessions.md).

## Hooks

Hooks are off by default; enable them with `MINICODE_HOOKS=1`.

| Item | Detail |
|---|---|
| Location | Global `~/.minicode/hooks/*.js` + local `.minicode/hooks/*.js` |
| Trigger points | `pre-run` and `post-run` |
| Context | `MINICODE_HOOK_CTX` env (the run's JSON) |
| Sanitisation | Hook env is sanitised without secrets; hooks are skipped when the session is cancelled |

Global + local hooks are merged (they do not pass through an allowlist). Because a hook is arbitrary code outside the permission system, it only runs when `MINICODE_HOOKS=1` and WorkMode is `EXECUTE` (not in `DISCUSS`/`PLAN`); every hook has a 5 s timeout and its env is sanitised. File tools must **not** write into `.minicode/hooks/` (audit 2026-11-12) — hook scripts are created by the operator outside the session, so the model cannot plant a hook that runs immediately. A cloned repo that already contains `.minicode/hooks/*.js` is still untrusted: inspect it before enabling `MINICODE_HOOKS=1` (see [Security](security.md)).

## Next

- [TUI](repl.md) — dropdown + slash commands.
- [Config](config.md) — file locations & config schema.
- [Tools](tools.md) — the capabilities available to skills.
