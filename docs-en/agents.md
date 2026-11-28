# Sub-Agents & Tasks

## Concept

A sub-agent is an agent instance with **separate context** from the parent: its own memory, signal, and budget. The concurrency pool is **5** by default — at most five live sub-agents at a time — and it is abort-aware (it inherits the parent's AbortSignal; a cancelled parent stops the child). Raise it, when a larger fan-out is genuinely needed, with `MINICODE_SUB_AGENT_POOL_SIZE` (1..16).

**Budgets & child display.** `delegate_task` accepts an optional per-delegation `timeoutMs` (finite, >0, bounded by the internal timer limit); the default comes from `MINICODE_SUB_AGENT_TIMEOUT_MS` = **3,600,000 ms (1 hour)** — raised from 300,000 ms because four parallel explorers using ~38–51 tool calls still ran out of time (short prompts get a 0.6 ratio ⇒ 180 s). Wait-free liveness watchdog kills a genuinely silent child within 120 s, so the higher cap only helps slow healthy runs. On timeout the child status is `timeout`, the ACE verdict is FAIL/BLOCKED, and text that already streamed is returned as **part of the result** (fail-soft, no rollback of file effects). Give the child a `name` for a human-readable label (`explore-1`, `plan-2`, … when omitted) in the transcript instead of the `run_<8>`/`sub_<8>` code; model-supplied names are still sanitised before display. For wide fan-out, split the scope per agent (**2–5** when scopes are genuinely separate). Pass `scope` (`file`|`dir`|`subtree`|`repo`) — the runtime sets budgets **24/40/64/100** (`plan` ×1.5, clamped to **`[24,600]`**, so `repo`+`plan` = 150) and escalates through the ladder **`[24,40,64,100,150,250,400,600]`** when a child stalls. **Do not set `maxSteps` yourself:** an explicit value disables escalation. Without `scope`, the legacy 5/15 fallback applies. After `max_steps_exceeded`, re-delegating the same scope is the supported way to use adaptive escalation — do not blindly repeat an unchanged scope.

`delegate_task` requests approval under **ASK** (TTY); non-TTY denies even when the daemon's approval broker is injected — the `allowNonTtyAsk` exception applies only to non-gated tools. Under **AUTO**, delegation runs without a prompt when the capability is authorised. A child inherits the parent's WorkMode; `DISCUSS` restricts child tools to the read-only exploration subset (under `BUILD`, a `plan` child keeps the available base tools). **One approval under ASK covers exactly one delegation:** the "Always" option is deliberately unavailable for `delegate_task`, so the next identical delegation needs a fresh approval.

## Child modes: `explore` / `plan`

| Child mode | Capability |
|---|---|
| `explore` | Read-only exploration tool subset for finding and understanding code |
| `plan` | Does not get `todo_write`, memory mutations, commit, nesting, or background jobs. A parent PermissionMode of `ASK`, `plan`, or `readonly` forces the child mode to `explore`. A parent WorkMode of `DISCUSS` likewise restricts the child tool list to the exploration subset (the legacy `PLAN` value normalises to `DISCUSS`); under `BUILD`, `plan` mode may use the available base tools, still subject to the child's PermissionMode |

Restrictions on a child that **always** apply: `delegate_task`, `git_commit`, memory/todo writes, `submit_result`, `bash_output`, and `bash_kill` are unavailable. Background shells are rejected so no orphan job is created. The dynamic MCP tool list is not forwarded to children. WorkMode `BUILD` is the product label for the runtime identity `EXECUTE`.

## Why it is restricted

A sub-agent runs a task with nobody watching. That is why commit and dynamic MCP tools are not forwarded; `explore` mode and strict WorkModes give only exploration tools (even built-in MCP tools are filtered out). `plan` mode under `BUILD` can still modify files, run base tools, and use built-in MCP tools when authorised, so the parent must review its results.

## Incremental reporting & parent evaluation

Since v7.35, a child **streams findings while it works**, not a single string at the end. The built-in instruction asks for `[FINDING] <severity> | <file:line> | <summary>` lines; the first line is sent early, before deep reads. Each finding appears immediately in the parent transcript as an `[EVALUATE]` entry (`finding.detected`) and is persisted even if the child times out — so long-running work is not lost just because of the opening sentence. The parent **must evaluate** each finding (a hypothesis, not a conclusion) before acting on it; the `delegate_task` description states this explicitly.

**Reproducible self-repo audits.** Before delegating an audit, pin `git rev-parse HEAD` and `git diff --stat` in the prompt/report. Without that, findings can go stale when another session or process changes the working tree — exactly what happened in session `ef40d265`, where parallel changes triggered `EVALUATOR_TAMPER_ATTEMPT` on a read-only audit. The guard now blames only sessions that actually used a mutating tool (`write_file`, `edit`, `bash`, `code_run`, …), but recording a checkpoint remains good practice.

## Recovery

If the parent turn fails **after** a child `committed`: the journal marks the delegation; a `[recovery]` warning (child status + validated summary) is emitted both on a one-shot failure and on an interactive/TUI turn failure before the next turn starts, so the model does not blindly re-delegate (the child's effects already happened — the right move is to verify the result). See [Security](security.md) for the full recovery journal.

## Next

- [Tools](tools.md) — every tool a child may use.
- [Policy & Sandbox](policy-sandbox.md) — parent vs child permission modes.
- [Automation & CI](exec.md) — delegation on non-TTY (denied, fail-closed).