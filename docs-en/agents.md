# Sub-Agents & Tasks

## Concept

A sub-agent is an agent instance with **separate context** from the parent: its own memory, signal, and budget. The concurrency pool is 3 — at most three live sub-agents at a time — and it is abort-aware (it inherits the parent's AbortSignal; a cancelled parent stops the child).

`delegate_task` requests approval under **ASK** (TTY); non-TTY denies. Under **AUTO**, delegation runs without a prompt when the capability is authorised. A child inherits the parent's WorkMode; `DISCUSS`/`PLAN` restrict child tools to the read-only exploration subset. **One approval under ASK covers exactly one delegation.**

## Child modes: `explore` / `plan`

| Child mode | Capability |
|---|---|
| `explore` | Read-only exploration tool subset for finding and understanding code |
| `plan` | Does not get `todo_write`, memory mutations, commit, nesting, or background jobs. A parent PermissionMode of `ASK`, `plan`, or `readonly` forces the child mode to `explore`. A parent WorkMode of `DISCUSS`/`PLAN` likewise restricts the child tool list to the exploration subset; under `BUILD`, `plan` mode may use the available base tools, still subject to the child's PermissionMode |

Restrictions on a child that **always** apply: `delegate_task`, `git_commit`, memory/todo writes, `submit_result`, `bash_output`, and `bash_kill` are unavailable. Background shells are rejected so no orphan job is created. The dynamic MCP tool list is not forwarded to children. WorkMode `BUILD` is the product label for the runtime identity `EXECUTE`.

## Why it is restricted

A sub-agent runs a task with nobody watching. That is why commit and dynamic MCP tools are not forwarded; `explore` mode and strict WorkModes give only exploration tools (even built-in MCP tools are filtered out). `plan` mode under `BUILD` can still modify files, run base tools, and use built-in MCP tools when authorised, so the parent must review its results.

## Recovery

If the parent turn fails **after** a child `committed`: the journal marks the delegation; on resume the model gets a `[recovery]` warning so it does not blindly re-delegate (the child's effects already happened — the right move is to verify the result). See [Security](security.md) for the full recovery journal.

## Next

- [Tools](tools.md) — every tool a child may use.
- [Policy & Sandbox](policy-sandbox.md) — parent vs child permission modes.
- [Automation & CI](exec.md) — delegation on non-TTY (denied, fail-closed).