# Automation & CI

## Three non-interactive modes

| Form | When to use it |
|---|---|
| `minicode "prompt"` | One-shot; model text output + ledger to the terminal |
| `echo "prompt" \| minicode` | The prompt comes from a pipeline/another tool |
| `minicode exec "prompt" --json` | CI: `minicode.output.v1` JSONL envelope on stdout + a final versioned `{"type":"summary"}` line |

`exec --json` emits one JSON per canonical lifecycle event (tool step, output, error) with the `minicode.output.v1` envelope, including `source` and `visibility`; the full schema is in [Output Protocol Spec](OUTPUT_PROTOCOL_SPEC.md). A structured, versioned **summary** appears at the end. Even a *setup* failure (e.g. no provider) carries one `{"type":"summary","ok":false,...}` line on stdout — the stream is never empty; human messages stay on stderr, exit `1`. Model text flows as separate `{type:"text",delta}` records that are already scrubbed and ANSI-free.

## Machine summary: the optional `verify` field

A **success** summary from `exec --json` may carry the last verification result (opt-in
`--verify`) as an optional field:

```json
{
  "schema": "minicode.output.v1",
  "type": "summary",
  "ok": true,
  "verify": { "active": true, "ok": false, "command": "bun run lint" }
}
```

- `verify` appears **only in a success summary** and **only when verification
  actually ran** in this run; without `--verify` (or without an effective verify
  command) the key is **absent** from the summary (not `null`).
- `verify.ok` states the operator's verification result (pass/fail) and is **not**
  a replacement for the top-level `ok`. They are independent: a summary can be
  `"ok":true` (exit `0`) while `verify.ok:false`.
- `verify.command` is the operator-authorised verification command
  (`MINICODE_VERIFY_CMD`, config, or detection output) — not the verifier's output.

**Failure summaries do not include `verify`.** When the process fails (e.g. budget
exhausted, stale writer, stopping error) — **including when verification already
ran before the failure** — the terminal record uses the designated error envelope
(`schema`, `type`, `ok:false`, `error`, `prompt`) and carries no `verify` field.
The last verification result **cannot** be relied on through the summary on this
path because the field genuinely is not there.

This success/failure asymmetry is the **current contract deliberately accepted for
P11** (owner decision on finding N-1): implementation and output shape are
unchanged, only made explicit in the documentation. It is **not** a promise of
permanent design — extending `verify` to failure summaries (carrying the
verification that already ran, plus its contract tests) needs a separate protocol
decision outside P11. Evidence scope: the combination "verification already ran
then the process failed" is **not** claimed to be tested across every failure path.

## JSON-RPC server for IDEs: `minicode acp`

`minicode acp` reads one JSON per line on stdin and writes one JSON response/notification per line on stdout (stderr is purely human diagnostics). The minimal Phase 5 subset — **not a claim of full ACP compatibility**:

| Method | Params | Reply |
|---|---|---|
| `initialize` | `{client}` | `{server:"minicode-acp", capabilities:{run, streamText, cancel, approval:"deny-headless"}}` |
| `run` | `{prompt*, cwd?, model?, maxSteps?, timeoutMs?, budget?, mode?, workMode?:"DISCUSS"\|"PLAN"\|"BUILD"}` | Lifecycle notifications (`turn.*`, `tool.*`, `approval.*`, `file.changed`, `test.completed`, `diagnostic.raised`, `checkpoint.created`, `plan.updated`, `finding.detected`, `result.produced`, `context.compacted`) + `{type:"text",delta}`, then `{ok,tokens,steps,turns,text}` or `{error}` (`{type:"tool",name}` is legacy only when the lifecycle is absent). `workMode` is separate from `mode`; see [CLI](cli.md). |
| `cancel` | — | `{cancelled:true/false}` (discards the running run) |
| `shutdown` | — | exits 0 |

Honest v1 limits: each `run` = a NEW session (no thread/resume); ONE run in flight (a second run is rejected, not queued); gated tools are DENIED without a TTY (fail-closed, same as CI) — an IDE that needs write/execute uses auto mode with an allowlist or a self-contained prompt.

```bash
printf '%s\n' '{"id":1,"method":"initialize"}' '{"id":2,"method":"shutdown"}' | minicode acp
```

## Structured results: `submit_result`

The `submit_result` tool produces final structured JSON, called at most once per run, in `NO_PROMPT` mode (no confirmation requested). In `exec --json` the result content is forwarded **verbatim** — an API-style replacement for `response_format`. When `result.findings` holds an explicit list of `{category, severity, summary, evidence?}`, those findings are also projected as `finding.detected` events. Suited to tasks whose results are consumed by another program rather than a human.

`--json` mode uses the lifecycle envelope and summary described above and in [Output Protocol Spec](OUTPUT_PROTOCOL_SPEC.md); model text remains separate `{type:"text",delta}` records. A setup failure always carries one summary line with `ok:false`.

## Mid-run clarification: `ask_user`

`ask_user` asks a human mid-run. Gated + rendered through the `promptAskText` injection; **fail-closed on non-TTY** — in CI without a TTY the question will not hang the build without a trace, and the tool is denied with a clear message. CI design: do not depend on `ask_user`; write a self-contained prompt.

## Runtime limits

| Control | Default | Note |
|---|---|---|
| `--max-steps <n>` | 50 | Tool step limit per run |
| `--timeout <ms>` | 900000 (15 minutes) | Hard deadline per run; `0` = Infinity |
| `--ratelimit <rpm>` | — | LLM request token bucket per minute |
| `--budget <usd>` | — | Warn at 80%; exceeded -> one-shot `exit(1)`, TUI breaks the loop; `exec` enforces it the same way as one-shot |

`MINICODE_TIMEOUT_MS` supplies the default when `--timeout` is not set.

## CI pipeline examples

```bash
# PR gate: verify + strict budget + JSON results
minicode exec --work-mode BUILD --verify --json --budget 0.50 --budget-strict --max-steps 40 \
  "fix lint in src/ then run bun run lint"

# use a specific provider without touching config
minicode exec "summarise this diff" --json --provider openai --model gpt-4o

# prompt from a file
minicode exec "$(cat task.md)" --json
```

## Security notes for CI

- Local config `.minicode/config.json` **is ignored by default** (`--allow-local-config` to trust it) — a cloned repo cannot spawn MCP servers or hijack the prompt. On a runner you fully control, enabling it is fine.
- `git_commit` and all MCP tools are **gated**: they are always denied on non-TTY. CI that needs a commit must use another path (e.g. a git workflow, not the agent).
- Credential env vars are scrubbed from subprocesses; `GITHUB_TOKEN` and friends do not leak into the `bash` tool. Details in [Security](security.md).

## Next

- [CLI](cli.md) — all flags.
- [Verify & Benchmark](verify-benchmark.md) — `--verify` + self-heal for pipelines.
- [Environment Variables](environment.md) — the full `MINICODE_*` reference.