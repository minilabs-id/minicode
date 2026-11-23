# Policy & Sandbox

WorkMode, approval, tool access policy, shell command guards, and execution isolation are different controls. Hard denies for the path jail, sensitive files (`.env`, `auth.json`), and `.minicode/hooks/**` still apply on top — since the owner decision of 2026-11-23, `.minicode/` itself is writable by the agent and via shell.

## Three control axes

| Axis | Values | Function |
|---|---|---|
| **WorkMode** | `DISCUSS` / `BUILD` (internal `EXECUTE`) | Bounds how the agent works. `DISCUSS` is read-only (plus plan artefacts); `BUILD` adds no ceiling. The legacy `PLAN` value normalises to `DISCUSS`. WorkMode only narrows access. |
| **PermissionMode** | `AUTO` / `ASK` | Determines human supervision. `AUTO` runs authorised capability without routine approval; `ASK` requests approval for gated actions. Hard denies still apply. |
| **Tool Access Policy** | read-only capability, plan, allowlist, legacy access profiles | Determines the available capability. The internal values `readonly`, `plan`, `allowlist`, and `allow-all` are still used for compatibility and access limits, not as supervision choices. |

The internal `PermissionMode` remains a compatibility union that also carries legacy access profiles. For user-facing mode choices, flags, and combinations, see [Choosing a Mode](choosing-mode.md) and [CLI](cli.md). Delegation also inherits the parent's limits; see [Sub-Agents & Tasks](agents.md).

Related sets: `INTERNAL_WRITE_TOOLS`, `FILE_WRITE_TOOLS`, `GATED_TOOLS` (+ `*.*` MCP), `NO_PROMPT_TOOLS`. `move_file`/`delete_file` are jailed in the permission layer (all modes including `--allow-all`).

## Normalised bash-guard

`src/policy/bash-guard.ts`: quote separators are removed and simple assignments substituted **before** inspection. A platform-aware tokenizer (`src/policy/shell-tokenize.ts`) splits arguments by the shell's own rules — POSIX `'` / backslash, Windows caret `^`, literal single quotes — then a **mutating-verb denylist** runs ahead of the allowlist.

| Used to pass | Now |
|---|---|
| `cat .e""nv` | denied |
| `X=.env; cat $X` | denied |
| `p=python3; $p -c 1` | denied |
| `node --eval "1"` | denied |
| `env`, `set`, `export -p` | denied |
| `curl -F file=@~/.ssh/id_rsa` | denied |
| `echo x > ..\evil` (redirect out of the workspace) | denied; the redirect target is resolved against cwd before the allowlist |
| `echo x > "%TEMP%\evil"` | denied; a target containing `%NAME%` expansion cannot be proven safe statically |
| `py -c ...`, `python3.14 -c ...` | denied along with launcher and version variants |
| `type ..\..\windows\system32\config\sam`, `Get-Content .../ntds.dit` | denied (Windows hives + `reg save|export` hives + `vssadmin create|delete shadow` + `ntdsutil`; plain `reg query`, `vssadmin list`, `system.txt` still pass) |
| `write_file .minicode/<anything>` | **allowed** since the owner decision of 2026-11-23 (the full-segment lock was lifted, including via shell); only `.minicode/hooks/**` + sensitive files (`.env`, `auth.json`) remain denied. Avoid overwriting `sessions.db`/config carelessly — see [Security](security.md) |
| `bash <(curl x)` | denied |
| `rm -rf ..`, `rm --recursive --force /`, `rm -rf /; :` | denied |
| `command env`, `nice env`, etc. (wrappers) | env-dump detection is anchored to the start | denied via `stripCommandWrappers` (strip layered wrappers) |
| Reading through a hardlink pointing outside the workspace | denied when the opened handle has `nlink > 1`; the check uses `fstat` |
| `type .e^nv`, `ty^pe .env` (cmd.exe caret escapes) | denied after carets are normalised before name/jail rules |
| `type %USERPROFILE%\notes.txt` | denied; reader arguments shaped like `%NAME%` cannot be proven safe |
| `for /f %i in (.env) do @echo %i` | denied; the file set of a `for /f` loop is inspected too |
| `cat${IFS}.env`, `cat$IFS.env`, `cat${IFS:0:1}.env` (audit 2026-11-12) | denied; `$IFS` is a word separator, normalised to a space before name rules |
| `cat .?nv`, `cat .[e]nv` | denied; `?`/`[]` globs expand to other names just like `*` |
| `cat .{env,}`, `cat {.env,x}` | denied; brace expansion happens before inspection |
| `cat$(printf ' ').env` | denied; reader arguments shaped like command substitution cannot be proven static |
| `echo "rm -rf /"`, `git commit -m "docs: sudo rm"` | pass (over-block direction); quoted content of echo/printf/grep/git `-m` is DATA, not a command — unless it contains `$(`, a backtick, or `$VAR`, which are still executed |
| `echo hi ' & del x '` (cmd.exe) | denied; the tokenizer treats the single quote as literal, so `&` inside it is not a separator, and the verb `del` then hits the denylist |
| `cat .e\nv` (POSIX backslash-quote) | denied; the backslash escapes the character into `.env`, after which the name/jail rules still apply |
| `del x`, `mv a b`, `Remove-Item -Force x` | denied; mutating verbs hit the denylist before the allowlist and cannot be smuggled through quoting or wrappers |

Allowlist (permitted command shapes; checked AFTER the bash-guard). Before the allowlist, the platform-aware tokenizer splits arguments and the mutating-verb denylist (`del`/`mv`/`Remove-Item`/`rm` …) rejects dangerous commands first (see the table above). `bashAllowlist` in config **replaces the entire** narrow list (it adds to the developer list); env `MINICODE_BASH_ALLOWLIST` takes precedence over both. Operational note: when an override is active, the built-ins — including the added `tree`/`du`/`df`/`date`/`uname` — are not used; include the patterns you need in the override. Two lists:
- **Narrow** (`--allowlist`, untrusted tasks): `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm/bun/pnpm/yarn install|add`, `npm run/exec/install/ci/test/start`, `node`, `npx`, `ls dir cat type head tail wc grep rg find which echo pwd tree du df date uname` (the `tree`/`du` readers remain bounded by ROOT_SCAN: `tree /`/`du /` are denied). Shell writes (`mkdir cp mv rm touch`) are withheld — use the jailed `write_file`/`edit`. Since 2026-11-23 `.minicode/` itself is writable via file tools and shell redirection, except `.minicode/hooks/**`. Browser via bash (`agent-browser`) is explicitly allowed for the narrow subcommands `open`, `snapshot`, `click`, `fill`, `errors`, `console`, `network`, `get`, `close`, `skills get core`, `--version`, `install`, `eval`, `mcp` (owner decision 2026-11-23; a fresh profile is still recommended). `--auto-connect` is **withdrawn** — not used; the browser is always fresh or uses the profile from `.minicode` settings. The `npx *` pattern covers every npx form including `npx agent-browser ...`, so no dedicated entry is needed.
- **Developer** (fallback without an OS sandbox — `restrictBash`; a trusted session on your own machine): narrow + broad runtimes/interpreters (`python`/`node`/`ruby`/`php`/`perl`/`lua`/`julia`/`elixir`/`groovy`/`scala`/`java`/`dotnet`/`swift`/`dart`...), package managers (`pip`/`pip3`/`uv`/`pipx`/`poetry`/`pipenv`/`gem`/`bundle`/`composer`/`cargo`/`go`/`nuget`...), frameworks/bundlers (`vite`/`next`/`nuxt`/`webpack`/`esbuild`/`rollup`...), test/lint/build (`pytest`/`ruff`/`mypy`/`jest`/`vitest`/`eslint`/`tsc`/`mvn`/`gradle`/`dotnet`/`make`/`cmake`/`gcc`...), DB CLIs (`psql`/`mysql`/`sqlite3`/`prisma`...), containers (`docker`/`podman`).

`npm exec`/`npx`/`bun run`/`bun x` may not use shell expansion (`$`, backticks) or redirection. Runtimes only run script files — inline eval (`-e`/`--eval`/`-c`/`-r`/`--require`) is filtered by the guard first for EVERY interpreter (including newer ones: `lua -e`, `julia -e`, ...). **Registry-release verbs** (`npm publish`, `cargo publish`/`login`, `gem push`, `docker push`, `mvn deploy`, `dart pub publish`, `twine upload`...) are denied by the guard in ALL modes. Package managers run lifecycle scripts (postinstall/setup.py = arbitrary code from the registry), so both lists are "trusted", not a substitute for isolation — real isolation is still `--sandbox docker`.

Measure, do not claim — run it yourself for current figures:

```bash
bun run gate:bash        # manual corpus of attack patterns + legitimate commands (0 bypass / 0 over-block = pass)
```

Fuzzing generates variants from transformations the shell considers equivalent (quote-split by POSIX/Windows rules via the tokenizer, backslash-quote, caret, indirection, wrappers, long flags, chaining); findings are locked in as regression tests.

> Honest limit: static analysis over a Turing-complete language. Dynamic `$(curl ...)` cannot be resolved without execution — that is what the OS sandbox is for.

## Automatic sandbox

| Condition | What happens |
|---|---|
| bwrap (Linux) / seatbelt (macOS) available | Bash runs inside it, without a flag |
| Not available (including all of Windows) | Default drops to restrictBash (the **developer** allowlist, trusted session); no `[sandbox]` message — that message appears only for an explicit `--sandbox` request |
| `--allow-all` / `--ask` / `--plan` / `--allowlist` given | The choice is honoured, with no warning |
| `--sandbox none` | Deliberate opt-out; no downgrade |
| `--sandbox docker` | Ephemeral container (`--network none`, 512m, 1 CPU, `node:22-alpine`) |
| `--sandbox docker` but the daemon is down | REFUSED before starting (fail-closed) + how to explicitly opt into the fallback; no pretending to be isolated |

The container gets a random name per run. On timeout or tool cancellation, the
runner asks the daemon to run `docker rm --force` with a 5 s cleanup timeout
before stopping the CLI waiter. Output distinguishes cleanup confirmed by the
daemon from unconfirmed cleanup. This does not undo workspace effects that
already happened before the container was stopped.

`MINICODE_SANDBOX_STRICT=1` = never fall back to the host (redundant with the fail-closed default for an explicit request, still honoured). `MINICODE_SANDBOX_ALLOW_FALLBACK=1` = the only deliberate host-fallback path when the backend is unavailable. `MINICODE_SANDBOX_IMAGE` replaces the image (default `node:22-alpine` brings node only). `code_run` always goes through the sandbox runner and refuses when the backend is unavailable.

## Other layers

- **Path jail** realpath-based + `realpath` symlink checks in the permission layer; `.env`/`.git/config`/`node_modules`/Windows hives denied; since 2026-11-23 `.minicode/` itself is **writable** by the agent via file tools and shell — only `.minicode/hooks/**` (double string + realpath lock via `isOwnedHook`/`isOwnedHookReal`, closing junctions that disguise the hook target) + sensitive files remain denied. `isOwnedState()`/`isOwnedStateReal()` are now used for detection/filtering, not as a write lock; the workspace jail and secret rules still apply to the REAL target. The bash-guard blocks CREATING links whose operands are sensitive. For reads, `safeOpenRead` re-checks the boundary after stat and matches `dev+ino` from the opened handle; `O_NOFOLLOW` is used on POSIX too. The symlink stress test stays skipped when the host does not grant permission to create symlinks.
- **Env scrub** `sanitizeSpawnEnv`: strips credential keywords from the final merge; `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` remain, `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` are stripped.
- **web_fetch/web_search**: manual 5-hop redirects + uncached DNS resolve per hop (anti-rebinding) + 2 MB body. Pricing uses `fetchPinnedUrl` (resolved IP pinned to the socket, strict/noCache DNS, private hosts and redirects denied, 2 MB cap); the OpenAI-compatible summarizer still uses the global `fetch` (residual).
- **Secret scrubber**: `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` redacted before reaching the LLM (read_file/bash/grep) — no word whitelist.
- **Config/allowlist**: atomic randomUUID tmp+rename + chmod 600. MCP serve with curated tools + permission active.