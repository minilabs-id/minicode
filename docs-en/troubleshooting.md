# Troubleshooting

Always start from:

```bash
minicode doctor [--json]   # runtime, provider, pricing, memory, sandbox, config
```

`doctor` gives a warn (not a fake ok) for a provider with 0 models + a `sync` suggestion.

## FAQ

- **LSP not working:** `minicode config lsp add .ts --command typescript-language-server --args --stdio`. Make sure the server is installed.
- **Docker sandbox:** `docker pull node:22-alpine`. If the daemon is down while `--sandbox docker` is set, the run is **REFUSED** (fail-closed), not silently downgraded; set `MINICODE_SANDBOX_ALLOW_FALLBACK=1` for a deliberate host fallback.
- **A safe command was denied?** Probably the default `allowlist` because there is no OS sandbox. The `[sandbox]` message is printed only for an explicit `--sandbox` request — the implicit fallback is silent. Choose `--allow-all`/`--ask`, or run `bun experiments/bash-bypass-probe.ts` to see what counts as legitimate.
- **`--sandbox os` has no effect:** bwrap/seatbelt do not exist on Windows. Use `--sandbox docker`.
- **Env missing in a subprocess:** only credential keywords are stripped. `GITHUB_WORKSPACE`/`REDIS_HOST`/`AWS_REGION` remain; `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` are stripped. If a non-secret disappears too, that is a bug — report the variable name.
- **`grep` is slow:** install `rg`. Compare with `MINICODE_GREP_ENGINE=js`.
- **`/undo` did not restore a file:** that file is probably in `.gitignore` (shadow-git only snapshots what git tracks).
- **MCP HTTP "private host":** requires `--allow-private` when adding. This is an SSRF guard.
- **MCP "redirect not followed":** fix the URL; redirects are deliberately not followed.
- **`auth login` failed:** the server error is shown as-is. Check `minicode auth list`.
- **An OAuth provider disappeared:** not logged in / refresh failed. `minicode auth status` -> `auth login <id>`.
- **`git_commit` refused:** it is gated. Denied on non-TTY, and under `ASK`/`readonly`/`plan`/`allowlist`; in an authorised `AUTO` it runs without a prompt, and under `ASK`+TTY it asks once. That is the intended behaviour.
- **Cost shows N/A:** `minicode pricing sync` -> `pricing show <model>`.
- **A large file will not read:** use `offset`/`limit` (`read_file` really refuses >2 MB without them).
- **Background job will not run:** `background:true` is refused while `--sandbox` is active.
- **Verify does not run:** set `MINICODE_VERIFY_CMD` / `verifyCommand`.
- **Budget is inaccurate:** prices are estimates; the real cost depends on the provider.
- **`bun install` cannot find minicore:** make sure `vendor/minicore` exists (it ships with the repo). Re-syncing needs a sibling `../minicore` + `bun run vendor:minicore`.
- **`/provider sync` says restart?** Only when there really are new models (sync honestly reports `{updated,failed}`).
- **`models --match` is empty?** Header noise is already cleaned; empty means genuinely no match.
- **Colour leaking into a pipe?** Colour is gated on `stdout.isTTY`; `NO_COLOR` wins; `TERM`/`COLORTERM` do not turn colour on in a pipe.

## Further help

- [CLI](cli.md) for the `--sandbox --budget --tool-scope` flags.
- [Policy & Sandbox](policy-sandbox.md) for the limits of static analysis.
- [Memory & Sessions](memory-sessions.md) for resume/undo/journal.
- Report a bug: include `doctor --json`, OS, `bun --version`, and a minimal reproduction.