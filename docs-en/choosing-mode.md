# Choosing a Mode

Three separate axes determine what the agent can and cannot do:

1. **WorkMode** (operating mode) — *how* the agent works: `DISCUSS` (read-only investigation & planning; legacy `PLAN` maps here) or `BUILD` (implementation).
2. **PermissionMode** (approval) — *whether* human permission is needed: `AUTO` (autonomous) or `ASK` (supervised).
3. **Tool Access Policy** — *what* is available (read-only set, bash allowlist, delegation, MCP, scope).

Hard security (path jail outside the workspace, sensitive files, `.minicode/hooks/**`, bash-guard) always applies on top of all three — **except in `unrestricted` mode**, which lifts the out-of-workspace path jail, the bash-guard, and the allowlist, while sensitive files (`.env`, `.ssh`) and hook scripts (`.minicode/hooks/**`) are still denied. Since the owner decision of 2026-11-23, `.minicode/` itself is writable by the agent (see the last row of the table).

## If your goal is X, use Y

| I want to... | Use | Because |
|---|---|---|
| Understand a repo without changing anything | `--work-mode DISCUSS` | Local read-only ceiling; network reads denied; write/bash/commit/delegation denied at the gate |
| Have the agent make changes | `--work-mode BUILD` + `AUTO` (default PermissionMode) | Jailed writes + bash + commit + delegation + authorised MCP run autonomously; hard denies still apply |
| Approve every change | `--work-mode BUILD --ask` (`BUILD` + `ASK`) | Every non-trivial tool waits for an answer; reads/bookkeeping are not asked |
| Understand a repo or draft a plan without mutations | `--work-mode DISCUSS` | Local read-only ceiling + plan artefacts (`todo_write`) + read-only delegation; workspace/git writes denied at the gate |
| Automation/CI without a human | One-shot/`exec` + default `DISCUSS` for reads; add `--work-mode BUILD` when mutation is needed | `AUTO` deterministically denies `ask_user` (BLOCKED) on non-TTY; unconfigured MCP is denied; no prompt can hang |
| Full autonomy on your own machine | `--work-mode BUILD` + `AUTO` + `--sandbox docker` (or OS) + `--budget` | No prompts, BUT path jail + bash-guard stay active; the sandbox adds real isolation |
| Unrestricted access (trusted VM/VPN) | `/unrestric` (hidden TUI command, per session) | Lifts the out-of-workspace path jail + bash-guard + allowlist/sandbox; narrow git credentials (`GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`) are forwarded only in this mode; sensitive files and `.minicode/hooks/**` are still denied (`.minicode/` itself is writable since 2026-11-23); the footer shows a red `o` |

## Rule of thumb

1. **A new session starts in `DISCUSS`+`AUTO`** for read-only investigation/planning without touching files or git; choose `BUILD` explicitly when you want implementation. `AUTO` governs approval and does not grant capability by itself.
2. **Legacy `--work-mode PLAN`** normalises to `DISCUSS` (with plan artefacts and read-only delegation); only `BUILD` modifies files, git, or memory.
3. **`ASK` for unfamiliar territory** — someone else's repo, commands you do not yet understand. Answer `always` only for the specific tool+args pair you have assessed.
4. **AUTO is not allow-all.** Unauthorised capabilities (e.g. unconfigured MCP, `ask_user` under AUTO, unsandboxed code) are *denied* with a reason, not prompted.
5. **Legacy `--allow-all`/`--allowlist`** map to access profiles; path jail + bash-guard still deny.
6. **`/unrestric` only in environments you genuinely trust** — the model can touch any file on the host (except sensitive files/`.minicode/hooks/**`), run a shell with no allow-list, and `git_push` to a remote. `BUILD`+`AUTO`+sandbox is usually enough.

## Honest trade-offs

- More autonomy means faster work and a larger blast radius when the model misunderstands. No mode makes the model wiser — a mode only governs **what is allowed to happen**.
- `allowlist` (automatic when there is no OS sandbox) is the strictest option for the shell, but the model can still write files through jailed tools — understand the difference: the allowlist constrains *commands*, the jail constrains *files*.
- Change modes any time: a start flag, `Tab`/`Shift+Tab`, or `/mode` (two-axis popup) while the TUI is running.

## Next

- [Security](security.md) — what each mode enforces.
- [Policy & Sandbox](policy-sandbox.md) — the precise semantics table + guard evidence.
- [Automation & CI](exec.md) — headless limits.
- [CLI](cli.md) — WorkMode/PermissionMode flag reference.