# Installation & Quickstart

From zero to a verified first prompt: install, set up a provider, run it, verify.

Single prerequisite: **`bun >= 1.1.13`** — the MiniCode runtime, not Node.js. `npm` is only used for distribution, not for running. (Version floor: the code uses `AbortSignal.any()`, which is absent from Bun 1.0.x; `minicode` fails fast with a clear message on older versions.)

> The MiniCore kernel ships inside this repository under `vendor/minicore`, so **no extra clone is needed**. A sibling `../minicore` clone is only required when you want to re-sync the kernel via `bun run vendor:minicore`.

## Install (for newcomers — even without Node or Bun)

**Step 1 — Install Bun** (once; close and reopen your terminal afterwards):

```powershell
# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
# if ExecutionPolicy blocks it, try:
npm install -g bun
```

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Check: `bun --version` must print >= `1.1.13` (for example `1.4.x`). If you still get `command not found`, close and reopen the terminal (the new PATH only loads after a restart).

**Step 2 — Install MiniCode:**

```bash
bun add -g minicode-ai
# bin: minicode
minicode --version  # confirm the latest version is installed
```

MiniCode is a Bun package — installing it with `bun add -g` uses the same runtime that executes it, with no Node intermediary. Without Bun on PATH, `minicode` fails with `'bun' is not recognized`.

Still using npm? It is supported and produces the same binary:

```bash
npm install -g minicode-ai
```

For contributors (working from source):

```bash
git clone https://github.com/minilabs-id/minicode && cd minicode
bun install && bun link
```

Optional but recommended: `rg` (ripgrep) on PATH speeds up the `grep` tool. Without `rg`, an internal walker is used with identical results (force that path for testing with `MINICODE_GREP_ENGINE=js`).

Verify:

```bash
minicode doctor        # runtime, provider, pricing, memory, sandbox, config
bun test               # offline/hermetic; live and docker tests skip automatically
```

The setup wizard runs automatically on first `minicode` when no provider exists yet.

## First prompt

Goal: from zero to a verified first prompt without reading the whole manual.

## 1. First run (1 minute)

```bash
minicode
```

If no provider is configured yet, the setup wizard appears. Fill it in order: pick a gateway -> paste the API key (masked) -> auto-detect models. The wizard uses a picker (arrows + filter) rather than numbered `readline` — out-of-range input no longer silently selects `[0]`.

Alternative without an API key:

```bash
minicode auth login          # device-code: short code + URL, approve in the browser
minicode auth status         # show credentials and when they expire
```

## 2. First prompt (2 minutes)

```bash
minicode --work-mode BUILD "create a hello world http server in server.ts" --verbose
```

What happens: the model receives a system prompt containing `# Environment` (cwd + platform) plus a condensed repo-map, then a ReAct loop `Thought -> Action -> Observation` until a final answer or a limit (`--max-steps` default 200 — 600 is only the sub-agent hard cap — and `--timeout` default 1 hour).

Try interactive mode:

```bash
minicode --interactive
# minicode > explain the contents of src/tools/index.ts
# /model   -> provider::model picker, Enter selects and sets effort
# /status  -> session token usage + cumulative cost
# /exit    -> quit (double Esc during an abort also works)
```

## 3. Automatic verify (2 minutes)

```bash
minicode --work-mode BUILD --verify "fix bugs then typecheck"
```

Before the agent runs, the baseline is tested first. If the baseline is already red, a Health-Check note is attached to the initial prompt so the agent fixes it first. After the run, verify executes; on failure the agent self-heals for up to 3 cycles. Error output is wrapped in a fence so it cannot become prompt injection. Custom command via `MINICODE_VERIFY_CMD` or `verifyCommand` in config.

## Everyday patterns

```bash
minicode --ask "deploy script"          # human-in-loop confirmation card
minicode --sandbox docker "task"        # bash in an ephemeral container
minicode --budget 0.50 "large task"     # warn at 80%; over the cap -> new prompts refused + running turn discarded
minicode exec "prompt" --json           # headless CI: JSONL stream + summary
minicode "/review src/a.ts"             # skill slash-command
```

## OS matrix

| OS | Automatic sandbox | Default permission | Notes |
|---|---|---|---|
| Linux + bubblewrap | Yes, no flag needed | `auto` | Strongest isolation for `bash` |
| macOS + seatbelt | Yes, no flag needed | `auto` | Same, via seatbelt |
| Windows (all) / no bwrap-seatbelt | Not available | `auto` (bash `restrictBash` allow-list automatically) | Better to restrict commands than to fake a safe label. Choose yourself with `--allow-all` / `--ask`, disable with `--sandbox none`, or use `--sandbox docker` |

Docker is **not** used automatically even when available — pulling an image unasked is too invasive for a default.

## Update & uninstall

Opening interactive `minicode` (TTY) always checks the registry for a newer
version: the exact SemVer version found is verified first via a temporary
install and `npm audit signatures` (registry signature + provenance). Package
install scripts are disabled; only a dependency-free runtime graph is accepted.
Then the same version is installed from the official registry, the version in
the installed package is re-read, and minicode restarts itself. A mismatch
attempts to restore the previous version; if restoration fails, the process
stops so it never runs a mixed installation. This only applies to an installed
copy (source checkouts are untouched).

Since v0.41 a failed install no longer prints a generic message: it reports the
**step and redacted reason** (ANSI sequences, tokens/credentials, and URLs
carrying credentials are stripped; one line of at most 300 characters). The
**redaction boundary is only those three categories plus the length/line limit**
— not a general secret scrubber. On Windows the npm runner picks `npm_execpath` /
`npm.cmd` with a 60-second timeout; the signature-verification order stays
fail-closed. Old npm, packages without signature/provenance evidence, or offline
mode still block auto-update.

In the interactive TUI, the `/update` slash command performs the update through
a safe terminal handoff: release the alt-screen → install → spawn a restart with
`MINICODE_AUTO_UPDATE_DONE=1` → exit. If it is already latest, opted out, or the
update fails, the terminal is re-acquired and the result is shown. The command
exists **only in the TUI**; one-shot, `exec`, pipe, and ACP are fail-closed — they
answer "not available" and never spawn npm from a pipe/CI.

> Verification uses npm's capability, not the bundled Sigstore verifier.
> Verification failure always stops auto-update. Owners can still disable this
> path (`MINICODE_AUTO_UPDATE=0`) and manage updates manually per their
> organisation's policy.

The manual instruction uses an **exact verified version** — use
`npm install -g minicode-ai@<version>`, **not** `npm update -g minicode-ai`
(`npm update` bypasses signature verification):

```bash
npm install -g minicode-ai@<version>   # manual; npm update is not used
# Bun equivalent: bun add -g minicode-ai@<version>
minicode sync          # refresh new models from all providers
minicode pricing sync  # refresh the price cache from models.dev
```

Opt-out: `NO_UPDATE_CHECK=1`, `MINICODE_AUTO_UPDATE=0|false|off`, or `CI=1`.
The internal guard `MINICODE_AUTO_UPDATE_DONE=1` marks the restart produced by
an update so it does not trigger another check/install.

Contributor clone: `cd minicode && git pull && bun install`.

Uninstall = `npm uninstall -g minicode-ai` (or delete the clone + `bun unlink` if you used a link). Global config stays in `~/.minicode/` until you delete it manually; local config lives in `.minicode/` per repository. Uninstalling never removes state, sessions, memory, or your project files.

## Data locations

- Global config `~/.minicode/config.json` + local `.minicode/config.json` (merged, local wins, atomic write + chmod 600).
- OAuth tokens in `~/.minicode/auth.json` (chmod 600) — **not** in `config.json`, because local config is often committed.
- Sessions `.minicode/sessions.db` (WAL), vector memory `vector.db`, repo-map `.minicode/repomap.json`, traces `.minicode/traces.jsonl`, checkpoints `.minicode/checkpoints/`, trash `.minicode/.trash/`.
- Override the DB home with `MINICODE_HOME` (useful for keeping tests hermetic on POSIX).

## Next

- [Troubleshooting](troubleshooting.md) — when `doctor` is red or the sandbox will not run.