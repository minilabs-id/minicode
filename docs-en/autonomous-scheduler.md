# Autonomous Scheduler & Open Work (experimental)

> **Experimental.** Opt-in per invocation, off by default, and manually triggered.
> There is no background timer. Nothing runs unless you ask for it.

The scheduler evaluates your task graph and, when a task is ready, hands it to
an autonomous MiniCode session that does the work without you.

## 1. Enable

Add the flag to any invocation:

```bash
minicode --enable-scheduler
```

That is the only way to turn it on. There is no config key, no environment
variable, and no way to inherit it from a parent process — the flag typed on the
command line is the only mechanism. `--enable-scheduler=false` does **not**
enable it; the flag has no value form, and the bare flag is the only form that
counts.

When starting with the flag, the process acquires an exclusive lease on your
session. If another process already holds that lease, startup fails clearly
instead of running a second scheduler over the same session.

## 2. Trigger

Scheduling is **manual**. Nothing runs on its own:

```text
/scheduler run
```

This runs exactly one scheduling cycle:

- re-read the task graph,
- pick one ready task (if any),
- claim it durably,
- run one autonomous turn on it,
- report the result.

When nothing is ready, the cycle ends with `no task was ready` and no work is
created. If a task becomes ready *after* that, it stays pending until you run
`/scheduler run` again. No polling, no timer, and no background loop — this is
the current contract, not an oversight.

The command waits for the cycle to finish, then prints the result.

## 3. Observe

```text
/scheduler status
```

Reports the current state, the session it owns, whether the lease is held, the
counters for this process, and the last five lifecycle events.

You will see one of five states:

| State | Meaning |
| --- | --- |
| `scheduler OFF` | The flag was not given. There is no scheduler. |
| `scheduler ON, idle` | Active, holding the lease, waiting for `/scheduler run`. |
| `scheduler ON, executing` | A cycle is running. |
| `scheduler ON but STOPPED` | Stopped, shut down, or its lease was lost. It will not schedule again in this process. |
| `scheduler ON, last cycle failed` | The cycle failed. The reason is on the next line. |

Lifecycle events also appear inline in the transcript as `[scheduler] ...` lines.
Those are system entries, not conversation — never sent to the model and never
appearing as tool output.

Activity is in-memory and resets when the process exits. Durable task state
persists; diagnostics do not.

## 4. Stop

```text
/scheduler stop
```

This prevents the next trigger, prevents new claims, cancels an autonomous turn
still running, and releases the session lease so another process can take it.

Stopping twice is fine — the second call says so and does nothing.

Once stopped, the scheduler cannot be restarted. **Exit and start a new process**
with the flag to schedule again. There is no in-app toggle for the same reason
`/scheduler stop` is one-way: stopping a running turn is a shutdown, not a
setting.

## 5. Recover

If a process dies while holding the lease, the lease is not released. A
successor just waits:

- the lease lasts 5 minutes
- it is renewed every minute while the process is alive

So a crashed scheduler frees its session automatically within 5 minutes. To
recover immediately, delete the session (`/sessions`), which cancels it at once.

If the lease is lost while running (another process took over, or the session was
deleted), the scheduler **self-disposes**. It will never claim or execute
anything again, and the reason shows in `/scheduler status`. This is deliberate: a
scheduler that cannot prove session ownership is better off doing nothing than
racing a process that can.

## 6. Disable

Nothing needs to be turned off. Drop the flag and the next process has no
scheduler at all — no lease, no store handle, no background resources. To stop a
running one: `/scheduler stop`, or simply exit.

## What an autonomous session may do

The autonomous turn runs under a **read-only** policy. The tool set is a fixed
allow-list of read-only capability — read files, search, inspect git, query LSP.
Writes, edits, execution, and anything touching the network are denied, and
nothing can widen it on the trigger path: the allow-list is enforced when the
executor is built, so a config that tries to widen it fails at startup instead of
running with more power.

The autonomous turn asks for no approval. There is no operator in the loop, which
is exactly why its policy is narrow rather than permissive.

## Limits

- One cycle per `/scheduler run`; no recurring schedule.
- No approval step between claim and execution. The read-only policy is the boundary.
- Per-process diagnostics that vanish on exit.
- Two processes cannot schedule the same session at once; the second fails closed.
- Experimental. The interface may change.

## Open Work across sessions

```
minicode openwork                        1 DISCOVER (read-only, cross-session)
minicode openwork inventory              1b AUDIT   (P14.0 inventory across sources)
minicode openwork context --session S --task tN
                                         1c BUILD CONTEXT (P14.5, no execution)
minicode --session <target> \
  --adopt-task <source>/<taskId> "..."   2 ADOPT    (explicit, dual authority)
/scheduler run                           3 CONTINUE (manual, through the continuity gate)
(at least one turn)                      4 WORK     (claim = a NEW generation)
minicode openwork --closed               5 CLOSE    (provenance-carrying feedback)
minicode openwork export --out FILE      5b EXPORT  (json/md, atomic)
minicode openwork merge ...              6 DEDUP    (explicit + evidence)
```

### 1 Discovering: `minicode openwork`

A read-only portfolio of every non-terminal task in **this workspace** (tasks.db
is per-workspace — other projects' sessions are genuinely not visible, that is the
correct boundary, not a bug), **plus** structured intent candidates from history
(see "Intent candidates" below).

```
Open Work — 1 item(s) · 1 intent · 1 stale · 0 unknown-provenance
workspace: D:\proyek · stale after 7d · TaskStore remains the sole status authority

p14ow-source/t1 · IN_PROGRESS · PARTIAL · P2 · 2d old
  title: Fix login bug
  flags: STALE · FROM:p14ow-source · SIMILAR×2(UNPROVEN)
  blockers: TASK_BLOCKED: API key rotated
  depends on: t2 (PENDING, unsatisfied)
  next: resume: rebuild context from provenance, then continue via TaskStore/Scheduler
```

Field meanings:

| Field | Meaning |
|---|---|
| `status` | canonical TaskStore status — the **only authority** |
| state (4th column) | evidence-based P14.1 state: `OPEN/PARTIAL/BLOCKED/WAITING_FOR_USER/DELEGATED/FAILED_NEEDS_FOLLOWUP/UNKNOWN`; failed verification -> FAILED_NEEDS_FOLLOWUP, unsatisfied dependencies -> BLOCKED |
| `P0..P3` | presentation priority: BLOCKED/FAILED=P0, WAITING/DELEGATED/UNKNOWN=P1, PARTIAL=P2, OPEN=P3; STALE items move up one level — an age signal, not evidence |
| `blockers:` | explicit blockers (TASK_BLOCKED / DEPENDENCY / VERIFICATION); empty = nothing claimed |
| `depends on:` | canonical dependencies reconciled against status at read time; only COMPLETED is *satisfied* |
| `next:` | an explicit follow-up — always through the existing authority path; openwork NEVER executes |

Marker meanings:

| Marker | Meaning | Follow-up |
|---|---|---|
| `STALE` | the row has not moved for >= the threshold (default 7 days, `--stale-days <n>`) | a priority hint, not an authority decision |
| `PROVENANCE-UNKNOWN` | no session row in sessions.db — the origin cannot be traced | inspect manually; do not assume corruption |
| `FROM:<session>` | this task was MOVED from another session (the `task_transfers` ledger) | explicit origin provenance |
| `SIMILAR×N(UNPROVEN)` | N tasks share a normalised title | **not evidence of duplication** — see 6 |
| `DUP-GROUP×N(UNPROVEN)` | a **cross-session** duplicate group (task + intent) with N members | see the cross-session duplicate groups section |

Filters: `--session <id>`, `--status <S>`, `--state <S>`, `--priority <P0..P3>`,
`--min-age-days <n>`, `--blocked`, `--depends-on <taskId>`, `--closed`,
`--json` (a single machine JSON object on stdout). Exit: `0` success (including an
empty list), `1` runtime/lookup failure, `2` misuse (including an unknown enum value).

**Honesty boundary:** `openwork` never writes anything — it does not acquire a
lease, does not create sessions.db, does not write a corrupt-manifest backup, and
does not trigger the scheduler. It is an index, not an authority. (Enforced by an
architecture guard + zero-mutation tests, now including the inventory path.)

### Intent candidates: structured history, WITHOUT guessing at prose

The portfolio also shows **open intent candidates** from structured, durable
history:

| Source | When it becomes a candidate | State |
|---|---|---|
| `plan.updated` | a plan step is `pending`/`active`/`blocked` **without** a canonical task (or its task row is gone) | OPEN / PARTIAL / BLOCKED |
| `approval.requested` | no `approval.settled` yet | WAITING_FOR_USER |
| sub-agent child session | no terminal result yet | DELEGATED |
| child session + `turn.failed` | the delegation failed | FAILED_NEEDS_FOLLOWUP |
| a run marked `INTERRUPTED` | interrupted execution (restart/kill) | FAILED_NEEDS_FOLLOWUP |

What it deliberately does NOT do: scan the content of free-form user messages. A
promise in prose ("we'll fix login later") NEVER becomes a task — roadmap P14
forbids treating brainstorming as a task, and deciding when prose intent becomes
a commitment is a product decision the owner has not made.

Extra extraction honesty rules (enforced by tests):

1. A plan step pointing at a canonical task that is still OPEN **attaches as
   evidence** to the task entry (`plan evidence`), not as a duplicate item.
2. A plan step claiming `active` over an ALREADY terminal task is not revived —
   it goes into closure with the reason "canonical task <status> supersedes plan
   claim", and the conflict is disclosed, not hidden.
3. An **allowed** approval is not evidence the work finished — it produces no
   candidate at all (only a denial produces DECLINED).
4. A `RUNNING` run is not an open loop — a live runtime is a normal condition.
5. Search scope is bounded by the session row's `cwd` binding; **a child session
   inherits its originating ancestor's scope** (sub-agent results stay visible);
   an unbound session is labelled UNBOUND and excluded — nothing is guessed.
6. `plan.updated` is a **snapshot**, not a delta: the adapter emits it on every
   successful `todo_write` with the ENTIRE step list. Only the LAST snapshot per
   **session** is read (not per `planId` — `planId` carries the turn number,
   whereas the todo list belongs to the session). Consequently old
   pending/active versions do not show up as a second open loop, steps removed
   from the list are not revived, and steps still open are not duplicated on
   every turn.

### Cross-session duplicate groups (full P14.3)

Candidates with the same normalised title **across sessions** (including task vs
plan step) are grouped and disclosed:

```
Similar groups — 1 (UNPROVEN, never auto-merged)
  "fix login bug" ×2 across 2 session(s) · DIVERGENT states
  sessions: p14fs-a · p14fs-b
```

Groups whose states contradict each other are marked `DIVERGENT` (the count also
appears in the header + `counts.conflicts`). A group **never** unifies anything:
moving authority still requires explicit adoption (2), and merging stays
single-session (6). Intentionally independent repeat tasks may share a group —
that is a marker to inspect, not a verdict.

### 1b Inventory: `minicode openwork inventory [--json]`

A read-only P14.0 inventory across sources: session counts (in-scope / foreign /
unbound / child), tasks (total/open/terminal), presentation events per type, runs,
checkpoint manifests (including **corrupt** ones — labelled, not backed up by the
projection), plan steps, approvals, and sub-agent results. Excluded sessions are
listed **with their reason**. Events that fail to decode are reported as
"unreadable", not hidden.

### 1c Context: `minicode openwork context --session <id> --task <taskId>`

A P14.5 context pack for one task: canonical fields (status/revision/
verification/dependsOn/evidence), state + priority + blockers + next action, plan
step evidence, checkpoint availability (including corrupt), transfer/merge
provenance, freshness, and a **resume checklist**. The pack is purely read-only —
the checklist points at paths that ENFORCE authority during resume (P12 ceiling,
P13.3 continuity gate, the TaskStore claim generation, P12/P13 budget/cancellation);
openwork itself neither checks nor executes. Exit `1` when the task is not found,
`2` for a malformed id.

### 2 Adopting: `--adopt-task <source>/<taskId>`

One task per invocation, ONLY at destination session startup, before the first turn:

```
minicode --session target --adopt-task p14ow-source/t1 "continue this work"
```

What happens (one TaskStore transaction, re-checked inside the transaction):
source+destination incarnation, revision, **both leases** (source and destination
token), non-terminal status, lineage consistency, destination id collision, and
relation provenance. A **live** writer of the source session = `REFUSED_SOURCE_BUSY`
(no forced takeover). An expired source lease = takeover + **epoch fence** — the
old process can no longer renew/release/write to/schedule the source session.

What does NOT happen: it does not copy the task, does not create a new generation,
does not mark anything complete, does not touch the runtime journal/child
runs/approvals, and **does not trigger the scheduler**. An adopted in-flight task
stays `IN_PROGRESS` with its original lineage — whether it may continue is the
gate's decision (3), not adoption's.

The relation chain is adopted **in order** (parent/dependency first, then
children); a rejection names the id that has not been adopted yet. Task ids are
never renumbered.

### 3 Continuing: `/scheduler run` (manual, supervised)

Adoption does not turn the scheduler on. Continuation still goes through the
existing manual trigger (`/scheduler run` in the DESTINATION session; it needs
`--enable-scheduler` when starting the CLI session, whereas a hosted daemon
session gets it via `--runtime owned`). Reconciliation evaluates the adopted
in-flight task through the **P13.3 continuity gate** — its contract does not change:

- `SAFE_TO_RETRY` (resume evidence + admission + the **entire** autonomous
  read-only tool scope) -> revert to PENDING -> **claim a NEW generation** ->
  serial dispatch.
- Anything else -> `HOLD` / `REQUIRES_VERIFIER`, the row is untouched, zero
  dispatch. No gate = HOLD (fail-closed).

**There is never a replay of journaled old tool instructions** — the work item
only carries `(taskId, title, instruction, sessionId)`; new execution is born from
a new claim. The P12 permission ceiling, budget, cancellation, and P13 stop
criteria apply exactly as in a normal session.

### 4 Closing: the normal lifecycle

Completion goes through the existing canonical path (verifier / `todo_write` /
operator) — P14 has no closing path of its own and never writes `COMPLETED` on
the operator's behalf.

### 5 Closure feedback: `minicode openwork --closed`

Closure feedback is a **re-read of canonical status + ledger**, not a conclusion:
a task that is terminal and carries P14 provenance (transfer or merge) appears
with `status`, `closed`, `FROM <session>`, `duplicate-of <task>`, and operator
evidence. A duplicate reopened by the operator automatically reappears in the open
section — the status at that moment is the truth.

Since the full-scope delivery, closure also covers **terminal intent artefacts**
(`kind INTENT`) with a mandatory **claim label**:

| `claim` | Meaning |
|---|---|
| `verified` | a canonical terminal task with `verification.verdict = passed` |
| `unverified` | a completion claim by the artefact (e.g. a `completed` plan step) **without** verification — shown as-is, NOT hidden, NOT treated as proven |
| `not-applicable` | DECLINED/CANCELLED — there is no completion claim to verify |

This includes a user-denied approval -> `DECLINED` (terminal, never alive again as
an open loop), and a plan step claiming `active` over a terminal task -> closure
with the reason "canonical task `<status>` supersedes plan claim" — the claim
conflict is disclosed, not swallowed.

### 5b Export: `minicode openwork export --out <path> [--format json|md] [--force]`

- `json` (default) — the complete portfolio object (always including the P14.0
  inventory), indented 2 spaces.
- `md` — a sanitised human report (titles/evidence free of ANSI sequences).
- Written **atomically** (`atomicWriteText`); **refuses to overwrite** an existing
  file unless `--force`; a write failure = exit `1` with no leftover `.tmp.*` file.

### 6 Explicit dedup: `openwork merge`

```
minicode openwork merge --session target --keep t1 --drop t2 \
  --evidence "one unit of work: both fix the login bug"
```

Rules (enforced by tests + guards):

1. **Evidence is MANDATORY** and is recorded verbatim in the append-only
   `task_merges` ledger. Title similarity is NEVER evidence; `SIMILAR×N(UNPROVEN)`
   is only a marker. There is no automatic merge from the projection.
2. The duplicate is closed as **`CANCELLED`, not `COMPLETED`** — declaring "it was
   done in another task" must not infer completion.
3. The status write goes through `patchTask` (the normal lifecycle: revision
   advances, in-flight ownership released) + the ledger INSERT in **ONE
   transaction** — a ledger failure rolls the status back too.
4. A terminal duplicate is refused (closed work is not reopened to be closed
   again). A terminal survivor IS allowed (the classic case: a pending task turns
   out to have been done by a completed task — the duplicate is still CANCELLED).
5. **Cross-session is refused**: a merge is one namespace. A cross-session
   duplicate must be adopted first (2), then merged in the destination session.
6. Reversal = a normal lifecycle write (patch the status back). The append-only
   ledger still records the declaration — a historical audit; status = the truth.

### Evidence map

| Claim | Evidence |
|---|---|
| Read-only projection (zero mutations) | `test/p14-open-work.test.ts` (zero-mutation projection) |
| Zero mutations on the FULL path (history + inventory covered too; no corrupt-manifest backup) | `test/p14-full-scope.test.ts` (full-projection zero mutations) |
| UNKNOWN/stale honestly labelled | `test/p14-open-work.test.ts` (UNKNOWN provenance without creating sessions.db; injected STALE threshold) |
| Similarity is not identity | idem (SIMILAR UNPROVEN, ambiguous stays separate) |
| CROSS-SESSION duplicate groups + divergent conflicts, no automatic merge | `test/p14-full-scope.test.ts` (P14.3 cross-session groups) |
| P14.1 contract: state/priority/next action pure + fail-closed | idem (P14.1 pure contract) |
| Intent extraction: allowed approval != COMPLETED; free messages unscanned; lineage scope | idem (P14.2 extractIntentCandidates) |
| Plan claim over a terminal task: not revived, conflict disclosed, verified/unverified claim label | idem (P14.2 history projection) |
| P14.0 inventory across sources + excluded sessions with reasons | idem (P14.0 inventory) |
| Forensic matrix: restart/interrupted/cancellation/stale | idem (P14.6 forensic matrix) |
| Portfolio: blockers/dependencies/verification/next action | idem (P14.4 portfolio fields) |
| CLI: new filters, inventory, context, atomic + sanitised export | idem (full-scope CLI; exit 0/1/2 per I28) |
| Safe/auditable/atomic merge | `test/p14-open-work.test.ts` (DECLARED/refusal/terminal/stale/atomic-rollback/reversal) |
| The whole 1->5 flow, new generation, no replay | idem (P14.5 operator flow) |
| Adoption: dual authority, fence, transfer ledger | `test/p14-cross-session-adoption.test.ts` (14 scenarios) |
| "Not a second TaskStore/scheduler" guard + pure projection | `test/p2-architecture-guards.test.ts` |
| CLI writer contract (OAP-008) | `test/writer-inventory.test.ts` (per-writer declaration) |
| `plan.updated` snapshots collapsed per session (no history duplication) | `test/p14-full-scope.test.ts` (5 plan-snapshot tests) |

### Scope limits that are NOT claimed

This document deliberately promises none of the following; they are all P14 scope
exclusions approved by the owner on 2026-10-26, not deferred work:

| Not present | Reason |
|---|---|
| Intent extraction from free prose | Explicitly forbidden by the roadmap ("do not treat every brainstorming message as a task") |
| A `/openwork` TUI readout | The milestone text only says "show/export"; a new TUI surface needs its own terminal contract |
| Merge with lease/admission | Outside the milestone text; a merge stays one transaction + an audit ledger |
| Cross-session merge without explicit adoption | The roadmap's authority model: the portfolio is a projection, task changes go through the authority path |
| A release-ready claim | P14 closure only covers the structured-evidence contract; P13 limitations still apply. Pin `git rev-parse HEAD` and `git diff --stat` as the checkpoint and re-run all gates on the same candidate before declaring green — historical figures are not current results |

## Related

- [CLI](cli.md) — the complete flag reference.
- [Architecture](architecture.md) — where the scheduler sits.