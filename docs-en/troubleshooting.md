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
- **The chat looks narrow / centred:** that is v0.34's chat column, not a missing sidebar. With `cols ≥ 120 && rows ≥ 20` the chat is `floor(cols/2)` wide (max 50% of the terminal) with left/right padding and a centred footer/composer; below that threshold it uses the full width. Popups/modals stay centred on the full terminal width.
- **`/view expand` no longer works:** that action was removed. Reasoning uses the `+ thinking` marker in the chat (hidden by default; `MINICODE_SHOW_THINKING=1` shows it, or use `/view thinking`), the full detail stays in the journal, and `/view` now accepts only `thinking`. `MINICODE_ACTIVITY_PANEL` is legacy/deprecated (D3) and no longer affects the display.
- **Retry messages piling up:** retries now appear as a single footer micro-toast `retry n/total · Ns` with a 4 s TTL and a live counter, overwritten on each attempt — stacked lines mean an older build.
- **A sub-agent stalls instead of escalating:** pass `scope` (`file`/`dir`/`subtree`/`repo`) — budgets 12/18/26/36 (`plan` ×1.5, clamped to `[8,50]`) escalate through `[8,12,20,32,50]`. **Do not set `maxSteps` yourself:** an explicit value disables escalation; without `scope` the fallback is 5/15. For wide fan-out, split 2–3 agents per turn and tune `MINICODE_SUB_AGENT_POOL_SIZE` (1..16, default 3) and `MINICODE_SUB_AGENT_TIMEOUT_MS` (default 300000 ms).
- **`Ctrl+A` no longer goes to the start of the line?** Since v0.37 `Ctrl+A` selects the whole transcript when the composer is empty and the dropdown is closed. With a draft or an open `/` menu it stays `Home` — the old behaviour is preserved. `Ctrl+E` is still end of line.
- **One multiline paste submits several turns?** It should not since v0.37: bracketed paste (`?2004h`/`?2004l`, outside the frame) reads CR as a draft newline, not a submit. If it still stacks, check that your terminal sends the bracketed-paste sequences correctly.
- **Selection jumps after a resize / a click lands wrong?** Since v0.37 resize stops auto-scroll, cancels the drag, resets the cursor column, and rebases the anchor even with an active selection; a post-resize click uses the new geometry. The dropdown also closes on a busy/abort transition.

## Further help

- [CLI](cli.md) for the `--sandbox --budget --tool-scope` flags.
- [Policy & Sandbox](policy-sandbox.md) for the limits of static analysis.
- [Memory & Sessions](memory-sessions.md) for resume/undo/journal.
- Report a bug: include `doctor --json`, OS, `bun --version`, and a minimal reproduction.