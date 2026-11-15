# Security

## Principle

MiniCode controls **layered capability**, not model intent. The model may
misunderstand; what determines what actually happens is the deterministic gate
beneath it: permission -> jail -> guard -> validation -> execution -> evidence.

1. **Fail-closed on uncertain paths**: a tool with no available backend refuses (`code_run`), a requested-but-unavailable sandbox is rejected (fail-closed; host fallback only via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`), an OAuth provider not yet logged in is dropped from the list, non-TTY auth fails fast.
2. **Measure, do not claim**: the bash-guard is validated against a manual corpus of attack patterns + legitimate commands — run `bun run gate:bash` for current figures (exit 0 = 0 bypass / 0 over-block).
3. **External text is untrusted**: tool output, MCP, web, and even verify output are fenced; `sanitizeAnsi` filters ANSI escapes from model/tool text before rendering.
4. **Permission controls invocation, not capability**: under ASK, one approval covers only a server+tool+args triple (MCP); the capability behind a server cannot be known statically.

## Execution chain

Every tool call passes through this chain, in order:

```
Permission -> Jail -> Bash Guard -> Argument Validation -> Executor -> Journal / Recovery
```

| Stage | Function |
|---|---|
| **Permission** | The permission mode (`src/policy/permission.ts`) decides allow/deny/ask per tool+args pair. Applies BEFORE any effect. |
| **Jail** | Paths outside the workspace, escaping symlinks, sensitive files (`.env`, `.git/config`), and MiniCode-owned state (`.minicode/*.db`, todos, journal, config) are denied — **even under `--allow-all`** (except `unrestricted` mode, see the mode and access section below). |
| **Bash Guard** | The shell command is normalised first (strip quotes/wrappers/simple variables), then pattern-checked. Denies env dumps, upload exfiltration, inline interpreters, wide destruction. |
| **Argument Validation** | The argument schema is validated by the kernel before execution; invalid arguments are rejected with no effect. |
| **Executor** | Runs what passed: reads in parallel, writes with bounded concurrency, abort-aware, output truncated with a marker (never silently). |
| **Journal / Recovery** | Every mutation is recorded as `pending` then `committed`/`failed`/`unknown`; finalisation marks which turn scope is durable. Resume never repeats blindly (see [Recovery](#recovery)). |

## Modes and access

Mode control has three axes: **WorkMode** (`DISCUSS`/`PLAN`/`BUILD`) bounds how the agent works; **PermissionMode** (`AUTO`/`ASK`) decides when human approval is required; **Tool Access Policy** determines the available capability. The internal values `readonly`, `plan`, `allowlist`, and `allow-all` still exist for access limits and compatibility, but they are not four additional supervision modes. Hard denies for the path jail, owned state, and bash-guard still apply. Combination details and the interface are in [Choosing a Mode](choosing-mode.md) and [Policy & Sandbox](policy-sandbox.md).

## Bash protection layers

1. **Normalised bash-guard** (`src/policy/bash-guard.ts`) normalises the command before rules apply. The bypass table including redirects, Windows env expansion, hardlinks, caret escapes, and `for /f` readers lives in [Policy & Sandbox](policy-sandbox.md) as the single source of examples. `bun run gate:bash` measures regressions.

2. **Allowlist** — permitted command shapes; checked AFTER the bash-guard. Two lists: **narrow** (`--allowlist`, untrusted tasks): `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm/bun/pnpm/yarn install|add`, `npm run/exec/install/ci/test/start`, `node`, `npx`, `ls dir cat type head tail wc grep rg find which echo pwd` — shell writes are withheld (use `write_file`/`edit`). **Developer** (fallback without an OS sandbox, `restrictBash` — a trusted session on your own machine): narrow + broad runtimes/interpreters (`python`/`node`/`ruby`/`php`/`perl`/`lua`/`julia`/`elixir`/`groovy`/`scala`/`java`/`dotnet`/`swift`/`dart`...), package managers (`pip`/`uv`/`poetry`/`pipenv`/`composer`/`gem`/`bundle`/`cargo`/`go`/`nuget`...), frameworks/bundlers (`vite`/`next`/`nuxt`/`webpack`/`esbuild`/`rollup`...), test/lint/build (`pytest`/`ruff`/`mypy`/`jest`/`vitest`/`eslint`/`tsc`/`mvn`/`gradle`/`dotnet`/`make`/`cmake`/`gcc`...), DB CLIs (`psql`/`mysql`/`sqlite3`/`prisma`...), containers (`docker`/`podman`). `npm exec`/`npx`/`bun run`/`bun x` may not use shell expansion/redirection. Runtimes only run script files — **inline eval** (`-e`/`--eval`/`-c`/`-r`/`--require`) is denied by the guard for EVERY interpreter, including newer ones (`lua -e`, `julia -e`, `elixir -e`, ...). **Registry-release verbs** (`npm publish`, `cargo publish`/`login`, `gem push`, `dotnet nuget push`, `docker push`/`login`, `mvn deploy`, `gradle publish`, `dart pub publish`, `twine upload`...) are denied by the guard in ALL modes (irreversible actions need credentials) — so the developer list can be broad without silently opening a publish path. Package managers run lifecycle scripts (postinstall/setup.py = arbitrary code from the registry), so both are "trusted project", not a substitute for isolation — real isolation is still `--sandbox docker`. `git --no-index/--exec-path/--upload-pack/--receive-pack`, the `ext::` transport, and inline `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` are denied by the guard (git as a jail escape).
3. **Path jail** realpath-based + symlink check; readers open the canonical target, use `O_NOFOLLOW` on POSIX, then match `dev+ino` between the pre-open stat and the post-open handle (including Windows). `.env`/`.git/config`/`node_modules`/Windows hives (`system32\config\sam|system|security|software`, `ntds.dit`) are denied; applies even under `--allow-all`.
4. **Env scrub** `sanitizeSpawnEnv`: strips credential keywords from the final merge. `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` **remain** (they were once stripped and broke CI builds), while `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` are stripped. If a non-secret disappears too, that is a bug — report the variable name.
5. **web_fetch/web_search**: manual redirects up to 5 hops + uncached DNS resolve per hop (anti-rebinding) + 2 MB body cap. Private hosts are denied (same as MCP HTTP).

`grep` uses ripgrep when available. The binary is resolved from an absolute
trusted PATH, the child environment is sanitised, and external config is
disabled (`--no-config`, no `RIPGREP_CONFIG_PATH`). Ripgrep config supports
preprocessors that execute a program per file, which is why the search tool does
not inherit that configuration.

## Prompt injection

- Verify output is fenced so the model does not follow instructions embedded in a build error.
- `mcp_read`/`mcp_prompt` are gated even though read-only — third-party content straight into context is an injection path; "read-only is not safe".
- The secret scrubber redacts `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` before text reaches the LLM (read_file/bash/grep), with no word whitelist.
- Bypass corpus: `bun run gate:bash`. Honest limit: static analysis over a Turing-complete language; dynamic `$(curl ...)` needs an OS/docker sandbox.

## Local file trust model

The agent runs AS the user — there is no privilege boundary between the agent
and the machine owner. What the guards protect is **operator intent**, not
capability: content the agent reads can influence decisions and is sent to a
third-party model provider.

- `MEMORY.md` (.minicode/, root, home), `AGENTS.md`, `rules/`, skills: **trusted input a human may edit** — including direct file edits. Out-of-band writes (outside `write_memory`) are loaded verbatim on the next retrieval. Do not place instructions from an unknown repo without reading them; `forget_memory` reaches the vector store + `.minicode/MEMORY.md` in local AND global scope (both are searched) — the root `MEMORY.md`/`CLAUDE.md` read hierarchy is not deleted.
- `sessions.db` + journal: session transcripts stored in plaintext in the workspace (readable by any agent in that workspace). A 0-byte journal = an attached session that has not mutated yet (by design, not corruption).
- Runtime-owned state (`.minicode/` — DBs, todos, plans, checkpoints, journal, traces, allowlist, config, + ANY other file beneath it): writes via file tools are denied fail-closed (the only exception: restoring `.minicode/.trash/` -> workspace); reads are still allowed (observability). Write your own notes into the workspace, not into `.minicode/`.
- `.minicode/hooks/` scripts are likewise locked for writing (audit 2026-11-12). A hook is arbitrary code outside the permission system that executes AUTOMATICALLY via a directory scan when `MINICODE_HOOKS=1` is opted in (only WorkMode `EXECUTE`, 5 s timeout, sanitised env). If file tools could write there, the model/prompt injection could plant a hook and run it in the same session — so hook scripts are created by the operator outside the session. A cloned repo that already contains `.minicode/hooks/*.js` must still be treated as untrusted local config: inspect it before enabling `MINICODE_HOOKS=1`.

## Local config & supply chain

- Local `.minicode/config.json` + allowlist are **ignored by default** — a cloned repo cannot spawn MCP servers, hijack the prompt, or install hooks. Trust it with `--allow-local-config`.
- Registered MCP servers get no auto-allow wildcard. Capability must still be authorised; under ASK a gated call requests approval per server+tool+args triple, while AUTO runs authorised capability without routine prompts. `[a] Always` stores the approved scope in the allowlist.
- Config/allowlist/auth are written atomically + chmod 600; OAuth tokens are separate in `~/.minicode/auth.json` (not in a config prone to being committed).
- The daemon places its `bootstrap` secret in `<cwd>/.minicode/daemon-endpoint.json` (`0600`). On Windows POSIX modes are ignored, so that file's ACL is stripped of inheritance and limited to the owning user via `icacls` (best-effort). Residual: on a multi-user Windows machine where `icacls` fails, another user who can read the repo folder can still read the secret and issue daemon capability (loopback, not remote).
- `mcp serve` is stdio-only (no HTTP mode -> no network surface), curated tools, permission active; `--all-tools` is an operator opt-in.

## Checkpoints & recovery

Every turn checkpoints shadow-git + a recovery journal `.minicode/journal-<session>.jsonl` (`pending` -> `committed`/`failed`/`unknown`; finalisation marks which turn scope is durable). On resume: a `committed` entry whose turn is gone is not repeated; `pending`/`failed`/`unknown` -> a verification directive, blind redo forbidden; a `committed` MCP entry = externally acknowledged and must be read back. Details in [Memory & Sessions](memory-sessions.md).

## Dangerous capabilities

MiniCode **provides no tool** for (verified in `src/tools/`):

- `git fetch`, `pull`, `clone` — no network-reading git tool
- `git reset`, `amend`, `rebase`, `checkout`, `branch -D`, `stash drop`
- Remote execution / built-in deploy

The only network git operation is `git_push` (gated like `git_commit`: TTY asks once, non-TTY denies, `readonly/plan/allowlist` deny, sub-agents do not get it). It uses `GIT_SAFE_BASE` hardening and in `unrestricted` mode receives narrow git credentials (see the mode and access section).

Honest note: other operations can still be TYPED through `bash` (subject to the bash-guard + jail, NOT prohibited). `git` via bash executes the repo's configuration as-is (the repo's hooks/filters/drivers). The read tools `git_*` are neutralised; `git_push` neutralises hooks/filters via `GIT_SAFE_BASE`; `git_commit` refuses before staging when a Git filter is configured. In an untrusted repo, prefer the read tools and review the configuration before using manual Git.

## Limitations

- **Repo hooks/filters/drivers:** `git` via bash executes them (stock-git semantics); the read tools `git_*` neutralise filters, while `git_commit` refuses when it finds a configured filter.
- **Arbitrary bash:** the guard is static analysis; dynamic substitution (`$(curl ...)`) needs an OS/docker sandbox for real isolation.
- **External MCP effects:** once they happen, they cannot be undone from here.
- **Provider/network:** data passes through your chosen provider; MiniCode adds no transmission of its own.
- **Model behaviour:** tool selection, success claims, and intent compliance are model properties — orchestration guarantees evidence and boundaries, not wisdom.
- **LSP servers:** spawned from the command in your config; only register servers you trust.
- **Untrusted repos:** treat them like running `git`/`bash` manually there — because that is literally what happens behind the tools.

## Security contact

There is no private security contact yet. Report issues via [GitHub Issues](https://github.com/minilabs-id/minicode/issues) **without including credentials, tokens, or sensitive data** — a minimal reproduction plus `minicode doctor` output is enough.

## Next

- [Policy & Sandbox](policy-sandbox.md) — modes, tool access policy, and guard details.
- [Terminal Contract](TERMINAL_CONTRACT.md) — why colour is gated on a TTY.
- [Automation & CI](exec.md) — agent limits in CI (fail-closed non-TTY).