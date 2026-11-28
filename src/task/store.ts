// TaskStore — durable authority for task state (Phase 1).
//
// RECOVERY NOTE. This file is reconstructed from
// `store.orig.ts`, an actual recovered snapshot of the pre-wipe uncommitted
// tree. It is NOT a redesign. Deviations from the artifact, and only these:
//
//   D1. `synchronizeTasks()` / `upsertTasks()` / `UpsertResult` are NOT here.
//       DEFERRED to Phase 3. They read `item.taskId` off the output of
//       `normalizeTodos()`, and no surviving module has a `TodoItem.taskId`
//       (see `todo.orig.ts` and baseline `src/tools/todo.ts` — neither has
//       one). Recovering them would require inventing Phase 3 addressing.
//       Every other artifact member is preserved verbatim.
//   D2. `CREATE TABLE` is wrapped in a bounded busy-retry (artifact line 137 ran
//       a bare `db.exec(DDL)`). The artifact therefore still carries the exact
//       SQLITE_BUSY gap that Phase 0C closed in `persistence.ts`. Reintroducing
//       it is forbidden, so it is fixed here. The retry is reimplemented locally
//       rather than imported, leaving Phase 0C code untouched.
//
// Database: a SEPARATE `tasks.db` at `<cwd>/.minicode/tasks.db`, reached through
// `resolveLocalDbPath` (Phase 0B, N1). NOT `sessions.db`, because that resolves
// via `resolveDbPath` which may fall back to the shared `~/.minicode/` — which
// violates D2 ("MUST NOT silently fall back to a global/shared database path").
// A separate file also keeps this table clear of `sessions.db`, which already
// carries 11 additive migrations and its own concurrency tests.
//
// All SQL lives here. Other subsystems may only use the domain API.

import { randomUUID } from "node:crypto"
import {
  closeTaskStoreHandle,
  dbFile,
  handle,
  j,
  legacyDigest,
  parseStringArrayStrict,
  resetTaskStoreHandles,
  rowToTask,
  txDepth,
} from "./db/schema.ts"
import {
  ADOPTABLE_STATUS_SET,
  ADOPTABLE_STATUSES,
  type AttemptRecordOutcome,
  buildVerificationTaskEvidence,
  CLAIMABLE_STATUSES,
  type ExecutionLineage,
  type ExecutionOwner,
  type ExecutionOwnership,
  emitTaskTransition,
  type LineageReconcileOutcome,
  MAX_DEPENDS_ON,
  MAX_EVIDENCE,
  type NewTaskInput,
  nowIso,
  type PatchOptions,
  setTaskTransitionSink,
  sqlList,
  TASK_DATA_VERSION,
  type TaskAuthorityMode,
  type TaskDuplicateOutcome,
  type TaskDuplicateRequest,
  type TaskDuplicateResult,
  type TaskMerge,
  type TaskPatch,
  type TaskRow,
  type TaskStoreOptions,
  type TaskTransfer,
  type TaskTransferOutcome,
  type TaskTransferRequest,
  type TaskTransferResult,
  type TaskTransition,
  type TaskTransitionKind,
  type UnfinishedWorkItem,
  type UpsertOptions,
  type VerificationGateOutcome,
} from "./db/types.ts"
import {
  type ClaimOutcome,
  IllegalTaskTransitionError,
  isLegalTaskTransition,
  isTaskId,
  isTaskStatus,
  isTerminalTaskStatus,
  type ReconcileOutcome,
  type Task,
  TaskAuthorityLostError,
  TaskError,
  type TaskSnapshot,
  type TaskStatus,
  type TaskVerification,
  taskIdFromIndex,
} from "./model.ts"
import type { SessionAuthority } from "./session-authority.ts"

export type {
  AttemptRecordOutcome,
  ExecutionLineage,
  ExecutionOwner,
  ExecutionOwnership,
  LineageReconcileOutcome,
  NewTaskInput,
  PatchOptions,
  TaskAuthorityMode,
  TaskDuplicateOutcome,
  TaskDuplicateRequest,
  TaskDuplicateResult,
  TaskMerge,
  TaskPatch,
  TaskStoreOptions,
  TaskTransfer,
  TaskTransferOutcome,
  TaskTransferRequest,
  TaskTransferResult,
  TaskTransition,
  TaskTransitionKind,
  UnfinishedWorkItem,
  UpsertOptions,
  VerificationGateOutcome,
}
export { buildVerificationTaskEvidence, legacyDigest, resetTaskStoreHandles, setTaskTransitionSink }

const incarnationKey = (sessionId: string): string => `session_incarnation:${sessionId}`

/**
 * PHASE 6B: the only statuses reconciliation may revert.
 *
 * `IN_PROGRESS` and `VERIFYING` assert in-flight activity with no durable proof
 * of liveness. `COMPLETED` / `CANCELLED` / `FAILED` are irreversible facts and
 * are never targets. `PAUSED` does not exist in `TaskStatus` and is never
 * introduced here.
 */
const RECONCILABLE_STATUSES: readonly TaskStatus[] = ["IN_PROGRESS", "VERIFYING"]

export class TaskStore {
  readonly cwd: string

  /**
   * PHASE 6B. Defaults to `"LEGACY"`, so every existing construction site keeps
   * its exact current behaviour. Per-instance, never a module singleton.
   */
  readonly authorityMode: TaskAuthorityMode

  constructor(cwd?: string, opts: TaskStoreOptions = {}) {
    this.cwd = cwd ?? process.cwd()
    this.authorityMode = opts.authority ?? "LEGACY"
  }

  /** Prepare the schema. Idempotent; safe to call repeatedly. */
  initialize(): void {
    handle(this.cwd)
  }

  // ── read ──────────────────────────────────────────────────────────────────

  getTask(sessionId: string, taskId: string): Task | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND task_id = ?")
      .get(sessionId, taskId) as TaskRow | null
    return row ? rowToTask(row) : null
  }

  listTasks(sessionId: string): Task[] {
    const db = handle(this.cwd)
    const rows = db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY task_order, task_id")
      .all(sessionId) as TaskRow[]
    return rows.map(rowToTask)
  }

  getSnapshot(sessionId: string): TaskSnapshot {
    return { sessionId, tasks: this.listTasks(sessionId) }
  }

  /** The next id that is DEFINITELY unused. Uses `max`, not `count`, so that
   *  `t1,t2,t5` yields `t6` — not a `t3` that would collide. */
  nextId(sessionId: string): string {
    const tasks = this.listTasks(sessionId)
    let max = 0
    for (const t of tasks) {
      const n = Number(t.id.slice(1))
      if (Number.isFinite(n) && n > max) max = n
    }
    return taskIdFromIndex(max)
  }

  // ── validation ────────────────────────────────────────────────────────────

  /**
   * Validate blocker/verification/dependency BEFORE persisting.
   *
   * Rules enforced:
   *  - `BLOCKED` requires a `blockedReason` (PF-04, second rail — the first is
   *    already in `normalizeTodos`).
   *  - `dependsOn` may only contain canonical ids that EXIST in this session, may
   *    not point at itself, and may not duplicate.
   *  - `COMPLETED` is never rejected here. The "completed needs evidence" gate
   *    runs in `normalizeTodos` (red evidence -> BLOCKED), and duplicating that
   *    logic in a second place is precisely what the brief forbids.
   */
  private validate(sessionId: string, input: NewTaskInput, selfId: string): void {
    if (input.status === "BLOCKED" && !input.blockedReason?.trim()) {
      throw new TaskError("TASK_INVALID_TRANSITION", "BLOCKED requires blockedReason")
    }
    const deps = input.dependsOn ?? []
    if (deps.length > MAX_DEPENDS_ON) {
      throw new TaskError("TASK_INVALID_DEPENDENCY", `dependsOn exceeds ${MAX_DEPENDS_ON}`)
    }
    const seen = new Set<string>()
    for (const d of deps) {
      if (!isTaskId(d)) throw new TaskError("TASK_INVALID_DEPENDENCY", `bad id: ${d}`)
      if (d === selfId) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", "task cannot depend on itself")
      }
      if (seen.has(d)) throw new TaskError("TASK_INVALID_DEPENDENCY", `duplicate dependency: ${d}`)
      seen.add(d)
      const exists = this.getTask(sessionId, d)
      if (!exists) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", `unknown dependency: ${d}`)
      }
    }
    if (input.parentId != null) {
      if (!isTaskId(input.parentId)) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", `bad parentId: ${input.parentId}`)
      }
      if (input.parentId === selfId) {
        throw new TaskError("TASK_INVALID_DEPENDENCY", "task cannot be its own parent")
      }
    }
  }

  // ── write ─────────────────────────────────────────────────────────────────

  createTask(sessionId: string, input: NewTaskInput): Task {
    // PHASE 6B authority guard. Creating a task directly in `IN_PROGRESS` is an
    // authoritative claim just as much as patching one into that status, so the
    // guard must cover creation as well. LEGACY is untouched.
    if (this.authorityMode === "SCHEDULER" && input.status === "IN_PROGRESS") {
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `IN_PROGRESS may only be authored by claimTask while Scheduler authority is active (${sessionId})`,
      )
    }
    const db = handle(this.cwd)
    const id = this.nextId(sessionId)
    const created = db.transaction(() => {
      // `nextId` is recomputed INSIDE the transaction so two concurrent writers
      // cannot be handed the same id.
      const chosen = db
        .prepare("SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(sessionId, id)
        ? (() => {
            let max = 0
            for (const t of this.listTasks(sessionId)) {
              const n = Number(t.id.slice(1))
              if (Number.isFinite(n) && n > max) max = n
            }
            return taskIdFromIndex(max)
          })()
        : id
      this.validate(sessionId, input, chosen)
      const ts = nowIso()
      try {
        db.prepare(
          `INSERT INTO tasks (session_id, task_id, title, status, task_order, parent_id, depends_on_json, blocked_reason, verification_json, evidence_json, acceptance_json, provenance_json, created_at, updated_at, revision, exec_generation, attempt_generation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)`,
        ).run(
          sessionId,
          chosen,
          input.title,
          input.status,
          input.order,
          input.parentId ?? null,
          j(input.dependsOn ?? []),
          input.blockedReason ?? null,
          j(input.verification ?? null),
          j((input.evidence ?? []).slice(0, MAX_EVIDENCE)),
          j(input.acceptance ?? null),
          j(input.provenance),
          ts,
          ts,
        )
      } catch (e) {
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      return this.getTask(sessionId, chosen)!
    })()
    emitTaskTransition("created", created, null)
    return created
  }

  /**
   * Apply a patch to one task. Optimistic: if `expectedRevision` is supplied and
   * does not match, the mutation is REFUSED and the revision does not advance.
   *
   * [Fase 1 / LOOP-INV-01] `expectedRevision` is now a REAL compare-and-swap:
   * the read, the validation and the write share one transaction, and the
   * UPDATE carries `AND revision = ?`. Two concurrent writers can no longer
   * both pass it — the loser gets TASK_STALE_REVISION and writes nothing.
   * (The previous PHASE 6B note above described the old read-then-write shape;
   * that shape no longer exists.)
   *
   * [Fase 1 / LOOP-INV-02] From-state gate: `TASK_EDGES` rejects illegal
   * transitions, and terminal states (COMPLETED/CANCELLED) can only be left
   * with the explicit permit `allowReopen`.
   *
   * [Fase 1 / LOOP-INV-13] Lease fencing: when `authorityToken` is supplied and
   * no longer holds `session_authority`, the write is refused without touching
   * the row. Callers without a token (interactive operator) behave as before.
   *
   * PHASE 6B authority guard: when `authorityMode === "SCHEDULER"`, a patch may
   * not author `IN_PROGRESS` — only `claimTask` may. This is the fail-closed
   * door that stops model-facing `todo_write` from creating a claim.
   */
  patchTask(sessionId: string, taskId: string, patch: TaskPatch, opts: PatchOptions = {}): Task {
    if (this.authorityMode === "SCHEDULER" && patch.status === "IN_PROGRESS") {
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `IN_PROGRESS may only be authored by claimTask while Scheduler authority is active (${sessionId}/${taskId})`,
      )
    }
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    // [Fase 1 / LOOP-INV-01] READ -> VALIDATE -> WRITE is ONE transaction, and
    // the UPDATE carries `AND revision = ?`. That makes it a true CAS: a caller
    // passing `expectedRevision` that loses the race gets TASK_STALE_REVISION
    // and writes nothing, and even a caller that passes no revision cannot
    // silently overwrite a row whose revision moved underneath the read.
    let transitionPrevious: TaskStatus | null = null
    const patched = db.transaction(() => {
      const current = this.getTask(sessionId, taskId)
      if (!current) throw new TaskError("TASK_NOT_FOUND", `no task ${taskId} in ${sessionId}`)
      transitionPrevious = current.status
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== current.revision) {
        throw new TaskError(
          "TASK_STALE_REVISION",
          `${taskId} is at revision ${current.revision}, got ${opts.expectedRevision}`,
        )
      }
      // [Fase 1 / LOOP-INV-13] Lease fencing for callers that present an
      // identity. No token = interactive/operator path (unchanged behaviour);
      // a token that is no longer current = fail-closed, because a displaced
      // worker must not write after losing authority.
      if (
        opts.authorityToken !== undefined &&
        !this.holdsSessionAuthority(sessionId, opts.authorityToken)
      ) {
        throw new TaskAuthorityLostError(sessionId)
      }
      const nextStatus: TaskStatus = patch.status ?? current.status
      // [Fase 1 / LOOP-INV-02] From-state gate. A self-write (title/order edit)
      // keeps the same status and therefore always passes. Leaving a terminal
      // state requires the explicit permit `allowReopen`.
      if (
        nextStatus !== current.status &&
        !isLegalTaskTransition(current.status, nextStatus) &&
        !(opts.allowReopen === true && isTerminalTaskStatus(current.status))
      ) {
        throw new IllegalTaskTransitionError(current.status, nextStatus)
      }
      const next: NewTaskInput = {
        title: patch.title ?? current.title,
        status: nextStatus,
        order: patch.order ?? current.order,
        parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
        dependsOn: patch.dependsOn ?? current.dependsOn,
        blockedReason:
          patch.blockedReason === undefined ? current.blockedReason : patch.blockedReason,
        verification: patch.verification === undefined ? current.verification : patch.verification,
        evidence: patch.evidence ?? current.evidence,
        acceptance: patch.acceptance === undefined ? current.acceptance : patch.acceptance,
        provenance: current.provenance,
      }
      // [PHASE 6P] EXECUTION OWNERSHIP IS RELEASED ONLY WHEN THE TASK LEAVES THE
      // SCHEDULER-OWNED IN-FLIGHT STATES.
      //
      // `patchTask` is every non-claim status writer: the model-facing
      // `synchronizeCanonicalTasks` path and any operator edit. Two rules, and the
      // difference between them is the whole point of the 6O history table:
      //
      //   status STAYS inside RECONCILABLE_STATUSES -> ownership is KEPT.
      //     A user writing IN_PROGRESS is the agent's plan cursor (todo.ts:15-19)
      //     laid on top of a live claim. It does not end the stranded execution
      //     (6O H3/H6), and only a legitimate authority may end a Scheduler
      //     execution. Releasing here would strand the generation forever.
      //
      //   status LEAVES RECONCILABLE_STATUSES       -> ownership is CLEARED.
      //     The row is no longer a Scheduler execution in flight, so leaving
      //     `scheduler` on it would be STALE ownership that a later reconcile
      //     could still match. This is what stops an interactive completion,
      //     failure, cancellation, block or requeue from being reverted later.
      //
      // Non-status writes (title, order, dependsOn, evidence, …) never touch the
      // column: editing a title must not end an execution claim.
      //
      // The release is computed in SQL (a CASE over the RESULTING status), so it
      // needs no extra read and stays inside the same transaction as the write.
      // [Fase 1] The whole read-validate-write now lives inside that transaction
      // and the UPDATE is revision-guarded (CAS), so the ownership CASE, the
      // status gate and the mutation observe one consistent snapshot.
      this.validate(sessionId, next, taskId)
      let changes = 0
      try {
        changes = db
          .prepare(
            `UPDATE tasks SET title = ?, status = ?, task_order = ?, parent_id = ?, depends_on_json = ?, blocked_reason = ?,
              verification_json = ?, evidence_json = ?, acceptance_json = ?, updated_at = ?, revision = revision + 1,
              execution_owner = CASE WHEN ? IN (${sqlList(RECONCILABLE_STATUSES)}) THEN execution_owner ELSE NULL END
             WHERE session_id = ? AND task_id = ? AND revision = ?`,
          )
          .run(
            next.title,
            next.status,
            next.order,
            next.parentId ?? null,
            j(next.dependsOn ?? []),
            next.blockedReason ?? null,
            j(next.verification ?? null),
            j((next.evidence ?? []).slice(0, MAX_EVIDENCE)),
            j(next.acceptance ?? null),
            nowIso(),
            next.status,
            sessionId,
            taskId,
            current.revision,
          ).changes
      } catch (e) {
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      if (changes !== 1) {
        // The predicate matched a revision read in this same transaction, so a
        // zero here means the row vanished under us (session deleted). Never a
        // silent success, and never a second write attempt.
        throw new TaskError(
          "TASK_STALE_REVISION",
          `${taskId} changed while the patch was being applied (expected revision ${current.revision})`,
        )
      }
      return this.getTask(sessionId, taskId)!
    })()
    // Emit setelah commit: event mencerminkan baris yang benar-benar durable.
    emitTaskTransition("updated", patched, transitionPrevious)
    return patched
  }
  /** Readable alias for the layer above. */
  updateTask(sessionId: string, taskId: string, patch: TaskPatch, opts: PatchOptions = {}): Task {
    return this.patchTask(sessionId, taskId, patch, opts)
  }

  // ── [Fase 3 / LOOP-INV-12, LOOP-G20, LOOP-G21] siklus VERIFYING ────────────
  //
  // Transisi eksplisit menuju `VERIFYING` dan penyelesaiannya ke `COMPLETED`
  // (bila bukti terverifikasi) atau `BLOCKED` (bila verifikasi / Tier 1 gagal),
  // sambil merekam bukti terstruktur pada `evidence_json`.

  /**
   * Masuk ke status `VERIFYING` sebelum/selama verifikasi berjalan.
   * Mematuhi `TASK_EDGES`, CAS `expectedRevision`, dan lease `authorityToken`.
   */
  beginTaskVerification(sessionId: string, taskId: string, opts: PatchOptions = {}): Task {
    return this.patchTask(sessionId, taskId, { status: "VERIFYING", blockedReason: null }, opts)
  }

  /**
   * Selesaikan verifikasi sebuah task dalam satu transaksi atomik:
   * - Jika task belum di `VERIFYING` (mis. `IN_PROGRESS`/`PENDING`) dan belum
   *   terminal, transisikan dulu ke `VERIFYING` agar jalur siklus tetap utuh.
   * - Jika `outcome.ok === true`: `VERIFYING -> COMPLETED` + bukti `"verify"`.
   * - Jika `outcome.ok === false`: `VERIFYING -> BLOCKED` + alasan + bukti.
   */
  completeTaskVerification(
    sessionId: string,
    taskId: string,
    outcome: VerificationGateOutcome,
    opts: PatchOptions = {},
  ): Task {
    return this.withTransaction(() => {
      const current = this.getTask(sessionId, taskId)
      if (!current) throw new TaskError("TASK_NOT_FOUND", `no task ${taskId} in ${sessionId}`)
      let base = current
      let nextOpts = opts
      if (base.status !== "VERIFYING" && !isTerminalTaskStatus(base.status)) {
        base = this.patchTask(sessionId, taskId, { status: "VERIFYING", blockedReason: null }, opts)
        // Setelah langkah masuk VERIFYING menggunakan expectedRevision pemanggil,
        // langkah kedua mengunci revisi baru yang baru saja ditulis dalam txn ini.
        nextOpts = {
          ...opts,
          expectedRevision: base.revision,
        }
      }
      const ev = buildVerificationTaskEvidence(outcome)
      const mergedEvidence = [...(base.evidence ?? []).slice(-(MAX_EVIDENCE - 1)), ev]
      const verification: TaskVerification = {
        verdict:
          outcome.verdict === "passed"
            ? "passed"
            : outcome.verdict === "failed" || outcome.verdict === "stale"
              ? "failed"
              : "unverified",
        ...(ev.detail ? { detail: ev.detail } : {}),
        checkedAt: ev.at,
      }
      if (outcome.ok) {
        return this.patchTask(
          sessionId,
          taskId,
          {
            status: "COMPLETED",
            blockedReason: null,
            verification,
            evidence: mergedEvidence,
          },
          nextOpts,
        )
      }
      const reason =
        outcome.summary?.trim().slice(0, 300) ||
        (outcome.verdict === "stale" ? "verification stale" : "verification failed")
      return this.patchTask(
        sessionId,
        taskId,
        {
          status: "BLOCKED",
          blockedReason: reason,
          verification,
          evidence: mergedEvidence,
        },
        nextOpts,
      )
    }, true)
  }

  // ── PHASE 6B: scheduler substrate ──────────────────────────────────────────
  //
  // P1 (claim) and P3 (reconciliation) live here, inside the TaskStore
  // persistence boundary, for one reason: both need the revision predicate to be
  // part of the SQL mutation itself. Emulating either with
  // read -> compare in application code -> write without the predicate is
  // explicitly NOT a compare-and-swap and is not done.
  //
  // Neither primitive accepts a `TaskGraph`, a plan revision, a presentation
  // revision, or a timestamp as currency. The only currency is the per-task
  // `revision` column.

  /**
   * P1: atomically claim one task for execution.
   *
   * The revision predicate and the claimable-status predicate are INSIDE the
   * single UPDATE statement, so SQLite decides the winner. This is the property
   * `patchTask`'s `expectedRevision` lacks.
   *
   * Claim contract (6A S4/S7): durable, revision-advancing, atomic, TaskStore
   * adjudicated, valid only from `CLAIMABLE_STATUSES`, never silently retried,
   * and never based on `TaskGraph.sourceMaxRevision`.
   *
   * A zero-rows-affected result is disambiguated with a follow-up READ so the
   * caller learns *which* precondition failed. That read is classification only
   * — it cannot turn a lost race into a win, because the mutation already
   * happened and already failed.
   */
  claimTask(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    /**
     * [PHASE 6T] `exclusive` adds the CAPACITY PREDICATE to the same statement
     * that performs the claim.
     *
     * [DESIGN DECISION] 6O selected this shape and it was never built: contention
     * was detected AFTER the claim, so a turn that never ran still consumed an
     * execution generation and left the task `IN_PROGRESS` and stranded. The fix
     * has to be atomic for the reason 6O gave — `exec_generation` is the unit that
     * must not be spent on a non-attempt, and a read-then-write check outside the
     * UPDATE would reopen exactly the window the revision predicate closes.
     *
     * The predicate is "no OTHER task in this session holds a LIVE Scheduler
     * execution", which is the Scheduler's own serial guarantee expressed durably,
     * so it holds across processes and not merely within one.
     *
     * [PHASE 6T][DESIGN DECISION] "LIVE" is not the same as "IN_PROGRESS", and
     * conflating them is a bug this predicate was written and then caught with.
     * After every completed turn the task deliberately REMAINS `IN_PROGRESS`
     * awaiting a verifier that does not exist yet (6N's "no verifier" limit), so
     * a naive `IN_PROGRESS` test finds a live execution forever and the Scheduler
     * can never run a second task. Live means the current generation's attempt has
     * not ended:
     *
     *     attempt_generation IS NULL OR attempt_generation < exec_generation
     *
     * which is exactly the condition reconciliation already uses to tell a
     * crashed execution (REVERT) from finished work (LEAVE). Capacity and
     * recovery therefore read one fact, and cannot disagree.
     *
     * A crashed execution still occupies capacity until a cycle reconciles it —
     * which is correct: an execution of unknown liveness is not free capacity,
     * and `runCycle` reconciles before it selects.
     *
     * Off by default: every existing caller keeps its exact behaviour, and only a
     * caller that means to be exclusive asks for it.
     */
    opts: { readonly exclusive?: boolean } = {},
  ): {
    outcome: ClaimOutcome
    task: Task | null
    execGeneration: number
    /** [PHASE 6Q] Incarnation the claim was made under. 1 for an undeleted session. */
    sessionIncarnation: number
  } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const statuses = sqlList(CLAIMABLE_STATUSES)

    // THE revision predicate lives here, in SQL. One statement = one atomic
    // decision; there is no read-then-write window.
    //
    // [PHASE 6I] The execution generation is created by the SAME statement that
    // accepts the claim, so the two can never disagree and a rejected claim
    // cannot advance it. It is the only place in the entire store that
    // increments `exec_generation` - see the invariant at the column DDL.
    //
    // [PHASE 6P] `execution_owner = 'scheduler'` is set by that same statement,
    // for the same reason. The three facts that define a Scheduler execution -
    // accepted revision, new generation, durable ownership - are therefore
    // ATOMIC. There is no interleaving in which the row says "generation N
    // exists" while ownership still says "interactive/unknown", or vice versa,
    // and a rejected claim writes none of the three.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'IN_PROGRESS', updated_at = ?, revision = revision + 1,
                exec_generation = exec_generation + 1,
                execution_owner = 'scheduler'
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})${
            opts.exclusive === true
              ? `
            AND NOT EXISTS (
              SELECT 1 FROM tasks AS busy
               WHERE busy.session_id = tasks.session_id
                 AND busy.execution_owner = 'scheduler'
                 AND busy.status = 'IN_PROGRESS'
                 AND busy.exec_generation > 0
                 AND (busy.attempt_generation IS NULL
                      OR busy.attempt_generation < busy.exec_generation)
                 AND busy.task_id <> tasks.task_id
            )`
              : ""
          }`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      const lineage = this.getExecutionLineage(sessionId, taskId)
      const claimed = this.getTask(sessionId, taskId)
      emitTaskTransition("claimed", claimed!, "PENDING")
      return {
        outcome: "CLAIM_ACCEPTED",
        task: claimed,
        execGeneration: lineage?.execGeneration ?? 0,
        // [PHASE 6Q] Read inside the same call so the Scheduler can present this
        // incarnation back at lineage-write time. A deletion between claim and
        // write moves it, and the write is then refused.
        sessionIncarnation: this.getSessionIncarnation(sessionId),
      }
    }

    // Lost the race, or never was claimable. Classify for the caller. A rejected
    // claim creates NO generation: execGeneration reports the unchanged current
    // value so a caller can never mistake a rejection for a claim.
    const current = this.getTask(sessionId, taskId)
    const sessionIncarnation = this.getSessionIncarnation(sessionId)
    if (current === null) {
      return { outcome: "NOT_FOUND", task: null, execGeneration: 0, sessionIncarnation }
    }
    const lineage = this.getExecutionLineage(sessionId, taskId)
    const execGeneration = lineage?.execGeneration ?? 0
    if (current.revision !== expectedRevision) {
      return { outcome: "CLAIM_REJECTED_STALE", task: current, execGeneration, sessionIncarnation }
    }
    // [PHASE 6T] The row is claimable and the revision matched, so the ONLY
    // reason the UPDATE did not land is the capacity predicate. Classify it as
    // contention rather than lumping it in with WRONG_STATE: the caller must be
    // able to tell "someone else is running" (skip, no state spent) from
    // "this task is not claimable" (a different question entirely).
    if (opts.exclusive === true && this.hasLiveSchedulerClaim(sessionId, taskId)) {
      return { outcome: "CLAIM_REJECTED_BUSY", task: current, execGeneration, sessionIncarnation }
    }
    return { outcome: "WRONG_STATE", task: current, execGeneration, sessionIncarnation }
  }

  /**
   * [PHASE 6T] Does another task in this session hold a LIVE Scheduler execution?
   *
   * "Live" means the current generation's attempt has not ended — see the note on
   * the capacity predicate. A task still `IN_PROGRESS` after a completed attempt
   * is awaiting verification, not occupying capacity.
   *
   * The read side of that predicate. It classifies a REJECTION; it is never used
   * to decide whether to attempt a claim, because only the atomic statement can
   * make that decision safely.
   */
  private hasLiveSchedulerClaim(sessionId: string, excludeTaskId: string): boolean {
    const row = handle(this.cwd)
      .prepare(
        `SELECT 1 FROM tasks
          WHERE session_id = ? AND execution_owner = 'scheduler'
            AND status = 'IN_PROGRESS' AND exec_generation > 0
            AND (attempt_generation IS NULL OR attempt_generation < exec_generation)
            AND task_id <> ?
          LIMIT 1`,
      )
      .get(sessionId, excludeTaskId)
    return row !== undefined && row !== null
  }

  /**
   * P3: revert ONE stranded in-flight task, revision-safely.
   *
   * Deliberately single-task rather than bulk: a bulk revert cannot be made
   * atomic across rows, so a per-row revision predicate is the only way to
   * guarantee a newer writer is never clobbered (6B S-race case A/C).
   *
   * The caller MUST hold session ownership (see `task/session-ownership.ts`).
   * When `ownsSession` is false this returns `REFUSED_NO_OWNERSHIP` and mutates
   * nothing — reconciliation fails closed rather than guessing.
   *
   * Never deletes. Never touches `parentId` / `dependsOn` / `order`. Never
   * manufactures `verification` or `evidence`. Never reads a graph. Never
   * inspects message history or presentation events.
   */
  reconcileStranded(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    opts: { ownsSession: boolean },
  ): { outcome: ReconcileOutcome; task: Task | null } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!opts.ownsSession) {
      // Fail closed. Uncertainty about ownership is not permission to act.
      return { outcome: "REFUSED_NO_OWNERSHIP", task: null }
    }
    const db = handle(this.cwd)
    const statuses = sqlList(RECONCILABLE_STATUSES)

    // Sets status AND clears blockedReason is deliberately NOT done: a stranded
    // task's blockedReason is not the property being reconciled, and rewriting
    // it would destroy information the operator may need.
    // [PHASE 6P] Same contract as `reconcileIfNoCompletedAttempt` for ownership:
    // only durably Scheduler-owned in-flight state may be reverted, and
    // reverting releases ownership. This is the path `Scheduler.releaseClaim`
    // uses for a claim whose dispatch never established, so requiring ownership
    // here also stops this method from reverting a task whose claim has already
    // been released or was never ours.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'PENDING', updated_at = ?, revision = revision + 1,
                execution_owner = NULL
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})
            AND execution_owner = 'scheduler' AND exec_generation > 0`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      return { outcome: "RECONCILED", task: this.getTask(sessionId, taskId) }
    }

    const current = this.getTask(sessionId, taskId)
    if (current === null) return { outcome: "NOT_FOUND", task: null }
    if (current.revision !== expectedRevision) {
      // Someone else moved it. Do not overwrite newer state.
      return { outcome: "REJECTED_STALE", task: current }
    }
    return { outcome: "NOT_STRANDED", task: current }
  }

  /**
   * [PHASE 6I] Read the execution lineage of one task.
   *
   * Deliberately NOT part of the public `Task` shape: execution provenance is
   * not task state, and exposing it on `Task` would let it leak into TaskGraph,
   * readiness and presentation. It is reachable only through these accessors.
   *
   * Returns `null` for a task that does not exist. `attemptGeneration === null`
   * means "no attempt of the current generation has completed" - a meaningful
   * value, not an error.
   */
  getExecutionLineage(sessionId: string, taskId: string): ExecutionLineage | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare(
        `SELECT exec_generation, attempt_generation FROM tasks WHERE session_id = ? AND task_id = ?`,
      )
      .get(sessionId, taskId) as
      | { exec_generation: number; attempt_generation: number | null }
      | null
      | undefined
    if (row === null || row === undefined) return null
    return { execGeneration: row.exec_generation, attemptGeneration: row.attempt_generation }
  }

  /**
   * [PHASE 6P] Read EXECUTION OWNERSHIP for one task.
   *
   * Deliberately a SEPARATE accessor from `getExecutionLineage`, so the four
   * facts stay four facts: task state, execution ownership, execution generation,
   * attempt generation. Folding ownership into the lineage object would invite
   * exactly the collapse 6O rejected.
   *
   * Returns `null` for a task that does not exist (same convention as
   * `getExecutionLineage`). `executionOwner === null` on an existing task is a
   * MEANINGFUL value - "no Scheduler execution owns this task" - not an error.
   *
   * Reachable only here: ownership is execution state and must not leak into
   * `Task`, TaskGraph, readiness or presentation.
   */
  getExecutionOwnership(sessionId: string, taskId: string): ExecutionOwnership | null {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    const row = db
      .prepare(`SELECT execution_owner FROM tasks WHERE session_id = ? AND task_id = ?`)
      .get(sessionId, taskId) as { execution_owner: ExecutionOwner | null } | null | undefined
    if (row === null || row === undefined) return null
    return { executionOwner: row.execution_owner }
  }

  // ── [PHASE 6Q] SESSION INCARNATION ──────────────────────────────────────────

  /**
   * [PHASE 6Q] A durable, monotonically increasing counter identifying WHICH
   * INCARNATION of a session id is current.
   *
   * WHY IT EXISTS (6N F2). `taskId` is allocated PER SESSION and restarts at `t1`,
   * so deleting a session and recreating it with the same id produces a session
   * whose task rows are *indistinguishable by id* from the deleted ones. An
   * execution that was still running against the DELETED incarnation therefore
   * holds a `(taskId, execGeneration)` pair that a FRESH claim in the RECREATED
   * session can legitimately match:
   *
   *   delete session A  -> recreate A  -> new Scheduler claims new t1 (exec=1)
   *   -> the OLD execution returns with (t1, execGeneration=1)
   *   -> `WHERE exec_generation = 1` MATCHES THE NEW ROW
   *
   * Without a discriminator the old execution would stamp `attempt_generation` on
   * the new row, and that new claim would be treated as "already completed" and
   * never recovered. That is exactly the cross-generation effect 6Q must forbid.
   *
   * THE MINIMUM GUARD. The Scheduler reads the incarnation at CLAIM time and
   * passes it back at lineage-write time; the write is refused if the current
   * incarnation has moved. Deletion bumps the counter, which invalidates every
   * in-flight execution of that session id at once, in one durable write, with no
   * coordination and no cross-process signalling.
   *
   * Stored in `task_meta` in THIS database, so the counter and the task rows it
   * protects share a persistence domain and can be read and written under one
   * handle. It is NOT session state: it deliberately SURVIVES the session's own
   * deletion, because its entire job is to remember that a deletion happened.
   *
   * It is NOT a lease, lock, heartbeat, priority or completion claim. It grants no
   * authority; it only lets a late writer recognise that it is late.
   */
  getSessionIncarnation(sessionId: string): number {
    const db = handle(this.cwd)
    const row = db
      .prepare(`SELECT value FROM task_meta WHERE key = ?`)
      .get(incarnationKey(sessionId)) as { value: string } | null | undefined
    if (row === null || row === undefined) return 1
    const n = Number(row.value)
    return Number.isSafeInteger(n) && n > 0 ? n : 1
  }

  /**
   * [PHASE 6Q] Invalidate every in-flight execution of this session id.
   *
   * Called by the canonical deletion operation BEFORE any row is removed, so that
   * an execution which returns after this point is refused rather than allowed to
   * write into a session that no longer exists - or into a later recreation of it.
   *
   * Idempotent-safe: bumping an already-bumped counter is harmless, and a session
   * that was never deleted keeps incarnation 1.
   */
  bumpSessionIncarnation(sessionId: string): number {
    const db = handle(this.cwd)
    const next = this.getSessionIncarnation(sessionId) + 1
    db.prepare(
      `INSERT INTO task_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(incarnationKey(sessionId), String(next))
    return next
  }

  /**
   * [PHASE 6I] Record that the execution attempt for one generation ended.
   *
   * This is the ONE durable fact the lineage design adds. It answers exactly one
   * question: "did the attempt for generation `execGeneration` reach its end?" It
   * is deliberately NOT:
   *
   *   - a task status. `IN_PROGRESS` stays `IN_PROGRESS`; a returned turn is not
   *     a verdict. EXECUTION != VERIFICATION != COMPLETION.
   *   - a completion claim, a lock, a lease, a heartbeat, a retry counter, or an
   *     attempt history. One generation is retained per task and nothing here
   *     expires on a clock.
   *   - a revision. `execGeneration` comes from the claim that ran, never from
   *     the task's current revision - that conflation is 6G defect D1.
   *
   * The write is GUARDED on `exec_generation = ?`. If the generation moved while
   * the attempt was in flight the record would be misleading, so it is refused
   * rather than written.
   *
   * The task's durable status is NOT touched, and no other column is written.
   */
  recordAttemptReturned(
    sessionId: string,
    taskId: string,
    execGeneration: number,
    /**
     * [PHASE 6Q] The incarnation the caller claimed under. Omitted = "assume the
     * current one", which preserves the pre-6Q behaviour for any caller that does
     * not track incarnations; the Scheduler always supplies it.
     */
    sessionIncarnation?: number,
  ): AttemptRecordOutcome {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!Number.isSafeInteger(execGeneration) || execGeneration < 1) {
      throw new TaskError(
        "TASK_INVALID_ID",
        `execution generation must be a positive integer: ${execGeneration}`,
      )
    }
    const db = handle(this.cwd)

    // [PHASE 6Q] THE INCARNATION GUARD MUST PRECEDE THE WRITE.
    //
    // Checking it afterwards is not a weaker check, it is a wrong one: the guarded
    // UPDATE can MATCH A ROW THAT BELONGS TO A DIFFERENT SESSION LIFETIME, because
    // `taskId` restarts at `t1` for every incarnation and a fresh claim also
    // starts at `exec_generation = 1`. Observed during 6Q: with the check after
    // the write, a delete + recreate + re-claim sequence returned RECORDED and
    // stamped `attempt_generation` onto the RECREATED row.
    //
    // The check and the write share one transaction, so no other process can bump
    // the incarnation between them.
    return db.transaction((): AttemptRecordOutcome => {
      if (sessionIncarnation !== undefined) {
        if (this.getSessionIncarnation(sessionId) !== sessionIncarnation) {
          return "SESSION_SUPERSEDED"
        }
      }
      let changes = 0
      try {
        changes = db
          .prepare(
            `UPDATE tasks
                SET attempt_generation = ?
              WHERE session_id = ? AND task_id = ? AND exec_generation = ?`,
          )
          .run(execGeneration, sessionId, taskId, execGeneration).changes
      } catch (e) {
        // Evidence that cannot be persisted is NOT a returned attempt. Never
        // swallow: converting this into "execution succeeded" would turn the crash
        // window into a silent permanent strand.
        throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
      }
      if (changes === 1) return "RECORDED"
      // The guard did not match. Nothing was written, so 6I's protection holds:
      // an outcome is never attributed to a generation that is not current. These
      // are results, not throws, because a throw is what wedged the Scheduler
      // (6N F2).
      const current = this.getTask(sessionId, taskId)
      if (current === null) return "TASK_GONE"
      return "SUPERSEDED"
    })()
  }

  /**
   * [PHASE 6I] Revert a stranded in-flight task, deciding strandedness by
   * EXECUTION LINEAGE rather than by revision.
   *
   * This replaces the 6F `reconcileStranded`-after-marker-read sequence. The
   * lineage predicate and the revert are ONE statement, so there is no
   * read-then-write window: a concurrent completion record cannot slip between
   * the decision and the mutation. That property was 6B's and 6G re-confirmed it
   * must not be regressed.
   *
   * The rule, exactly as 6H specified it:
   *
   *   attempt_generation IS NULL            -> STRANDED  (never completed)
   *   attempt_generation <  exec_generation -> STRANDED  (a later generation
   *                                               superseded an earlier one; the
   *                                               current one has no record)
   *   attempt_generation =  exec_generation -> not stranded
   *   attempt_generation >  exec_generation -> impossible -> THROW
   *
   * The `IS NULL` disjunct is explicit rather than a comparison because
   * `NULL < 0` is NULL, not true: a LEGACY-created `IN_PROGRESS` row that was
   * never claimed (`exec_generation = 0`, no attempt) must be reconciled.
   *
   * The relation is STRICTLY `<`, and that strictness is load-bearing twice over.
   * `<>` would wrongly match the impossible `attempt > exec` and silently revert
   * a row on corrupt data; `<` excludes it, so the row is left alone, `changes`
   * is 0, and the classification below raises instead of guessing. `<=` would be
   * worse still: it would match `attempt = exec`, i.e. a COMPLETED generation,
   * and reintroduce the 6D livelock in lineage form.
   *
   * Because `exec_generation` advances ONLY on an accepted claim, NO ordinary
   * mutation - title, order, dependency, parent, blockedReason, evidence,
   * verification, or status - can change the outcome of this rule. That is the
   * structural end of 6G D1.
   *
   * The caller MUST hold session ownership; without it this refuses and mutates
   * nothing (6B, unchanged). Never deletes. Never writes lineage. Never
   * manufactures verification or evidence. Never reads a graph.
   */
  reconcileIfNoCompletedAttempt(
    sessionId: string,
    taskId: string,
    expectedRevision: number,
    opts: { ownsSession: boolean },
  ): { outcome: LineageReconcileOutcome; task: Task | null } {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    if (!opts.ownsSession) {
      // Fail closed. Uncertainty about ownership is not permission to act.
      return { outcome: "REFUSED_NO_OWNERSHIP", task: null }
    }
    const db = handle(this.cwd)
    const statuses = sqlList(RECONCILABLE_STATUSES)

    // [PHASE 6P] `execution_owner = 'scheduler'` is a REQUIRED condition, and
    // `exec_generation > 0` is retained beside it as a co-condition.
    //
    // The owner condition is what makes 6N F1 impossible: a task the model marked
    // IN_PROGRESS without a claim is not Scheduler execution state, so it is
    // never reverted (6O H1). The exec condition is redundant while the column
    // exists - only `claimTask` sets ownership, and it always advances the
    // generation in the same statement - and is kept deliberately as a cheap
    // invariant: if a future writer ever sets ownership without a generation, this
    // still refuses rather than reverting.
    //
    // Reverting RELEASES ownership in the same statement, which is what makes
    // 6O H5 work: after this runs, the row is interactive state, and a later
    // user IN_PROGRESS write must survive the next reconcile.
    const result = db
      .prepare(
        `UPDATE tasks
            SET status = 'PENDING', updated_at = ?, revision = revision + 1,
                execution_owner = NULL
          WHERE session_id = ? AND task_id = ? AND revision = ? AND status IN (${statuses})
            AND execution_owner = 'scheduler' AND exec_generation > 0
            AND (attempt_generation IS NULL OR attempt_generation < exec_generation)`,
      )
      .run(nowIso(), sessionId, taskId, expectedRevision)

    if (result.changes === 1) {
      return { outcome: "RECONCILED", task: this.getTask(sessionId, taskId) }
    }

    // Zero changes: the lineage predicate said "not stranded", or the row moved
    // under us, or it is gone. One read classifies, exactly as 6B did.
    const current = this.getTask(sessionId, taskId)
    if (current === null) return { outcome: "NOT_FOUND", task: null }
    if (current.revision !== expectedRevision) {
      // Someone else moved it. Do not overwrite newer state.
      return { outcome: "REJECTED_STALE", task: current }
    }
    const lineage = this.getExecutionLineage(sessionId, taskId)
    if (lineage !== null && lineage.attemptGeneration !== null) {
      if (lineage.attemptGeneration > lineage.execGeneration) {
        // The recorded attempt names a generation NEWER than the current one.
        // No legitimate sequence produces this. Do not guess which side is wrong:
        // guessing either strands live work or re-runs finished work.
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `attempt generation ${lineage.attemptGeneration} exceeds execution generation ${lineage.execGeneration} for ${sessionId}/${taskId}`,
        )
      }
      return { outcome: "NOT_STRANDED", task: current }
    }
    // In flight with no completion record, yet the update matched nothing: the
    // row is not in a reconcilable status. Leave it alone.
    return { outcome: "NOT_STRANDED", task: current }
  }

  /**
   * Delete one task. Used ONLY by compatibility: `deleteSession`.
   *
   * The model has no way to delete in Phase 1 (D7: explicit deletion is
   * deferred; cancellation happens through the `CANCELLED` status instead).
   */
  deleteTask(sessionId: string, taskId: string): boolean {
    if (!isTaskId(taskId)) throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${taskId}`)
    const db = handle(this.cwd)
    try {
      const r = db
        .prepare("DELETE FROM tasks WHERE session_id = ? AND task_id = ?")
        .run(sessionId, taskId)
      return r.changes > 0
    } catch (e) {
      throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
    }
  }

  /** Drop every task in one session. For `deleteSession`. */
  deleteSessionTasks(sessionId: string): number {
    const db = handle(this.cwd)
    try {
      return db.prepare("DELETE FROM tasks WHERE session_id = ?").run(sessionId).changes
    } catch (e) {
      throw new TaskError("TASK_PERSISTENCE_FAILURE", (e as Error).message)
    }
  }

  // ── [P14] CROSS-SESSION UNFINISHED WORK ─────────────────────────────────────
  //
  // Dua operasi, satu batas: discovery READ-ONLY, dan transfer yang menuntut
  // otoritas eksplisit di KEDUA sesi. Keduanya hidup di TaskStore karena
  // TaskStore adalah satu-satunya otoritas status task; modul orkestrasi di
  // atasnya hanya mengakuisisi lease dan menerjemahkan hasil.

  /**
   * [P14] Inventaris pekerjaan belum selesai di seluruh sesi WORKSPACE INI.
   *
   * Batas cakupan bukan pilihan bebas: `tasks.db` memang per-workspace
   * (`resolveLocalDbPath`), jadi query ini tidak bisa melihat sesi proyek lain.
   * Itu juga yang membuatnya aman dijalankan tanpa aturan merge lintas proyek.
   *
   * Operasi ini TIDAK PERNAH:
   *   - mengakuisisi lease/otoritas,
   *   - menulis baris, revisi, generasi, atau status,
   *   - menyimpulkan bahwa item "boleh dilanjutkan" (itu keputusan scheduler
   *     dengan continuity gate, bukan discovery).
   *
   * `transferredFromSessionId` diambil dari ledger agar operator bisa melihat
   * asal item yang sudah berpindah, tanpa menjadikan ledger sebagai otoritas
   * status kedua.
   */
  listUnfinishedWork(sessionId?: string): UnfinishedWorkItem[] {
    const db = handle(this.cwd)
    const statuses = sqlList(ADOPTABLE_STATUSES)
    const filter = sessionId === undefined ? "" : " AND t.session_id = ?"
    type OpenRow = TaskRow & {
      transferred_from_session_id: string | null
      transferred_at: string | null
    }
    const rows = db
      .prepare(
        `SELECT t.*,
                (SELECT tr.from_session_id
                   FROM task_transfers tr
                  WHERE tr.to_session_id = t.session_id AND tr.task_id = t.task_id
                  ORDER BY tr.transferred_at DESC, tr.rowid DESC
                  LIMIT 1) AS transferred_from_session_id,
                (SELECT tr.transferred_at
                   FROM task_transfers tr
                  WHERE tr.to_session_id = t.session_id AND tr.task_id = t.task_id
                  ORDER BY tr.transferred_at DESC, tr.rowid DESC
                  LIMIT 1) AS transferred_at
           FROM tasks t
          WHERE t.status IN (${statuses})${filter}
          ORDER BY t.session_id, t.task_order, t.task_id`,
      )
      .all(...(sessionId === undefined ? [] : [sessionId])) as OpenRow[]

    const incarnations = new Map<string, number>()
    return rows.map((r) => {
      let incarnation = incarnations.get(r.session_id)
      if (incarnation === undefined) {
        incarnation = this.getSessionIncarnation(r.session_id)
        incarnations.set(r.session_id, incarnation)
      }
      return {
        sessionId: r.session_id,
        sessionIncarnation: incarnation,
        task: rowToTask(r),
        execGeneration: r.exec_generation,
        attemptGeneration: r.attempt_generation,
        // Nilai asing TIDAK dipromosikan menjadi "scheduler": discovery harus
        // gagal-jujur, bukan menciptakan pemilik yang tidak ada.
        executionOwner: r.execution_owner === "scheduler" ? "scheduler" : null,
        transferredFromSessionId: r.transferred_from_session_id ?? null,
        transferredAt: r.transferred_at ?? null,
      }
    })
  }

  /**
   * [P14.0] Seluruh baris task lintas sesi — READ-ONLY, untuk inventaris.
   *
   * Tidak dipakai untuk keputusan status: TaskStore tetap satu-satunya
   * otoritas; inventaris hanya MENGHITUNG. Hasilnya tidak pernah menjadi
   * input jalur tulis, dan tidak menimpa semantik `listUnfinishedWork`
   * (yang tetap satu-satunya definisi "open").
   */
  listAllTasks(): { sessionId: string; task: Task }[] {
    const db = handle(this.cwd)
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY session_id, task_order, task_id")
      .all() as TaskRow[]
    return rows.map((r) => ({ sessionId: r.session_id, task: rowToTask(r) }))
  }

  /**
   * [P14] Baca ledger transfer. Append-only dan read-only; dipakai audit/CLI.
   *
   * Tidak ada `DELETE`/`UPDATE` ledger di API publik: satu-satunya penulis
   * adalah `transferTaskAuthority`, di dalam transaksi yang sama dengan
   * perpindahan baris.
   */
  listTaskTransfers(
    filter: { fromSessionId?: string; toSessionId?: string; taskId?: string } = {},
  ): TaskTransfer[] {
    const db = handle(this.cwd)
    const clauses: string[] = []
    const params: string[] = []
    if (filter.fromSessionId !== undefined) {
      clauses.push("from_session_id = ?")
      params.push(filter.fromSessionId)
    }
    if (filter.toSessionId !== undefined) {
      clauses.push("to_session_id = ?")
      params.push(filter.toSessionId)
    }
    if (filter.taskId !== undefined) {
      clauses.push("task_id = ?")
      params.push(filter.taskId)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const rows = db
      .prepare(
        `SELECT transfer_id        AS transferId,
                task_id            AS taskId,
                from_session_id    AS fromSessionId,
                from_incarnation   AS fromIncarnation,
                to_session_id      AS toSessionId,
                to_incarnation     AS toIncarnation,
                expected_revision  AS expectedRevision,
                new_revision       AS newRevision,
                status             AS status,
                exec_generation    AS execGeneration,
                attempt_generation AS attemptGeneration,
                execution_owner    AS executionOwner,
                transferred_at     AS transferredAt
           FROM task_transfers${where}
          ORDER BY transferred_at, rowid`,
      )
      .all(...params) as Array<{
      transferId: string
      taskId: string
      fromSessionId: string
      fromIncarnation: number
      toSessionId: string
      toIncarnation: number
      expectedRevision: number
      newRevision: number
      status: string
      execGeneration: number
      attemptGeneration: number | null
      executionOwner: string | null
      transferredAt: string
    }>
    return rows.map((r) => ({
      ...r,
      executionOwner: r.executionOwner === "scheduler" ? "scheduler" : null,
    }))
  }

  /**
   * [P14] Pindahkan SATU task unfinished ke sesi lain, dengan bukti otoritatif.
   *
   * Kontrak yang membuat operasi ini aman:
   *
   *   1. SATU transaksi. Pemeriksaan revisi/inkarnasi/status/relasi, UPDATE
   *      baris, dan INSERT ledger berbagi transaksi yang sama. Kegagalan
   *      ledger tidak boleh meninggalkan task sudah berpindah tanpa bukti.
   *   2. KEDUA lease harus dipegang token yang diberikan, diperiksa DI DALAM
   *      transaksi. Lease sumber yang sudah diambil alih proses lain membuat
   *      transfer gagal, bukan menebak bahwa pemilik lama sudah mati.
   *   3. Revisi + inkarnasi + generasi diperiksa ulang. Revisi TIDAK dipakai
   *      sebagai pengganti lineage; `exec_generation`/`attempt_generation`
   *      dipindahkan APA ADANYA sehingga target mewarisi bukti yang jujur.
   *   4. Task terminal/UNKNOWN tidak pernah diadopsi.
   *   5. Relasi hanya boleh menunjuk task yang SUDAH lebih dulu diadopsi dari
   *      sesi sumber yang sama (dibuktikan ledger). Menunjuk id yang kebetulan
   *      ada di target akan menyatukan dua tugas berbeda — dilarang.
   *   6. Task id TIDAK PERNAH diganti. Tabrakan id di target = tolak eksplisit,
   *      bukan renumber diam-diam.
   *
   * Yang TIDAK dilakukan: tidak membuat generasi baru, tidak menandai selesai,
   * tidak menghapus attempt marker, tidak menyentuh jurnal runtime/child run.
   * Eksekusi baru hanya lahir dari claim baru di sesi tujuan, setelah
   * continuity gate memutuskan apakah retry aman.
   */
  transferTaskAuthority(req: TaskTransferRequest): TaskTransferResult {
    if (!isTaskId(req.taskId)) {
      throw new TaskError("TASK_INVALID_ID", `not a canonical id: ${req.taskId}`)
    }
    const refuse = (
      outcome: TaskTransferOutcome,
      detail: string,
      task: Task | null = null,
      unresolvedRelations: readonly string[] = [],
    ): TaskTransferResult => ({ outcome, task, transfer: null, detail, unresolvedRelations })

    if (req.fromSessionId.length === 0 || req.toSessionId.length === 0) {
      return refuse("NOT_FOUND", "source and target session ids must be non-empty")
    }
    if (req.fromSessionId === req.toSessionId) {
      return refuse("REFUSED_SELF_TRANSFER", "source and target sessions are identical")
    }

    const db = handle(this.cwd)
    const now = req.now ?? Date.now()
    return db.transaction((): TaskTransferResult => {
      const sourceIncarnation = this.getSessionIncarnation(req.fromSessionId)
      if (sourceIncarnation !== req.fromIncarnation) {
        return refuse(
          "REJECTED_STALE_SOURCE_INCARNATION",
          `source incarnation moved: expected ${req.fromIncarnation}, found ${sourceIncarnation}`,
        )
      }
      const targetIncarnation = this.getSessionIncarnation(req.toSessionId)
      if (targetIncarnation !== req.toIncarnation) {
        return refuse(
          "REJECTED_STALE_TARGET_INCARNATION",
          `target incarnation moved: expected ${req.toIncarnation}, found ${targetIncarnation}`,
        )
      }

      const raw = db
        .prepare("SELECT * FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(req.fromSessionId, req.taskId) as TaskRow | null
      if (raw === null) {
        return refuse("NOT_FOUND", `no task ${req.taskId} in ${req.fromSessionId}`)
      }
      if (raw.revision !== req.expectedRevision) {
        return refuse(
          "REJECTED_STALE_REVISION",
          `${req.taskId} is at revision ${raw.revision}, expected ${req.expectedRevision}`,
          rowToTask(raw),
        )
      }

      // Urutan sengaja: revisi dulu (murah, menentukan), lalu otoritas. Token
      // yang tidak memegang lease tidak boleh belajar status task lewat pesan
      // yang lebih spesifik.
      if (!this.holdsSessionAuthority(req.fromSessionId, req.sourceOwnerToken, now)) {
        return refuse(
          "REFUSED_NO_SOURCE_AUTHORITY",
          `source lease for ${req.fromSessionId} is not held by the presented token`,
        )
      }
      if (!this.holdsSessionAuthority(req.toSessionId, req.targetOwnerToken, now)) {
        return refuse(
          "REFUSED_NO_TARGET_AUTHORITY",
          `target lease for ${req.toSessionId} is not held by the presented token`,
        )
      }

      if (!isTaskStatus(raw.status)) {
        return refuse("REFUSED_CORRUPT_STATE", `unknown task status: ${raw.status}`, rowToTask(raw))
      }
      if (!ADOPTABLE_STATUS_SET.has(raw.status)) {
        return refuse(
          "REFUSED_STATUS",
          `status ${raw.status} is terminal and cannot be adopted`,
          rowToTask(raw),
        )
      }

      // Lineage yang tidak mungkin = HOLD, bukan tebakan. Sama seperti
      // reconcile: attempt > exec tidak punya penafsiran yang aman.
      if (!Number.isSafeInteger(raw.exec_generation) || raw.exec_generation < 0) {
        return refuse("REFUSED_CORRUPT_STATE", "exec_generation is not a non-negative integer")
      }
      if (
        raw.attempt_generation !== null &&
        (!Number.isSafeInteger(raw.attempt_generation) || raw.attempt_generation < 0)
      ) {
        return refuse("REFUSED_CORRUPT_STATE", "attempt_generation is not a non-negative integer")
      }
      if (raw.attempt_generation !== null && raw.attempt_generation > raw.exec_generation) {
        return refuse(
          "REFUSED_CORRUPT_STATE",
          `attempt_generation ${raw.attempt_generation} exceeds exec_generation ${raw.exec_generation}`,
        )
      }
      if (raw.attempt_generation !== null && raw.exec_generation === 0) {
        return refuse(
          "REFUSED_CORRUPT_STATE",
          "attempt marker exists without an execution generation",
        )
      }
      if (raw.execution_owner !== null && raw.execution_owner !== "scheduler") {
        return refuse("REFUSED_CORRUPT_STATE", `unknown execution_owner: ${raw.execution_owner}`)
      }
      if (raw.execution_owner === "scheduler") {
        if (raw.status !== "IN_PROGRESS" && raw.status !== "VERIFYING") {
          return refuse(
            "REFUSED_CORRUPT_STATE",
            `scheduler ownership is inconsistent with status ${raw.status}`,
          )
        }
        if (raw.exec_generation < 1) {
          return refuse("REFUSED_CORRUPT_STATE", "scheduler ownership without a claim generation")
        }
      }

      // Relasi harus menunjuk task yang SUDAH berpindah dari sumber yang sama.
      // Keberadaan id semata tidak cukup: id task berulang per sesi, jadi id
      // yang sama di target bisa merupakan tugas yang sama sekali berbeda.
      const deps = parseStringArrayStrict(raw.depends_on_json)
      if (deps === null) {
        return refuse("REFUSED_CORRUPT_STATE", "depends_on_json is not a string array")
      }
      const relations = new Set<string>()
      if (raw.parent_id !== null) relations.add(raw.parent_id)
      for (const d of deps) relations.add(d)
      const unresolved: string[] = []
      const relationExistsInTarget = db.prepare(
        "SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?",
      )
      const relationWasAdopted = db.prepare(
        `SELECT 1 FROM task_transfers
          WHERE from_session_id = ? AND to_session_id = ? AND task_id = ?
          LIMIT 1`,
      )
      for (const relation of relations) {
        if (!isTaskId(relation) || relation === req.taskId) {
          return refuse("REFUSED_CORRUPT_STATE", `invalid or self relation: ${relation}`)
        }
        const exists = relationExistsInTarget.get(req.toSessionId, relation)
        if (exists === undefined || exists === null) {
          unresolved.push(relation)
          continue
        }
        const adopted = relationWasAdopted.get(req.fromSessionId, req.toSessionId, relation)
        if (adopted === undefined || adopted === null) unresolved.push(relation)
      }
      if (unresolved.length > 0) {
        return refuse(
          "REFUSED_UNRESOLVED_RELATION",
          `relations must be adopted first from ${req.fromSessionId}: ${unresolved.join(", ")}`,
          rowToTask(raw),
          unresolved,
        )
      }

      // Tabrakan id adalah penolakan eksplisit. Renumber akan mengubah identitas
      // yang dipegang evidence/dependency dan menyembunyikan konflik.
      const collision = db
        .prepare("SELECT 1 FROM tasks WHERE session_id = ? AND task_id = ?")
        .get(req.toSessionId, req.taskId)
      if (collision !== undefined && collision !== null) {
        return refuse(
          "REFUSED_TARGET_ID_CONFLICT",
          `${req.taskId} already exists in ${req.toSessionId}; ids are never renumbered`,
          rowToTask(raw),
        )
      }

      // Posisi tampilan di target: append. Urutan bukan identitas dan bukan
      // dependency; menyalin urutan sumber bisa membuat dua baris berbagi
      // nomor yang sama tanpa alasan.
      const maxRow = db
        .prepare("SELECT MAX(task_order) AS m FROM tasks WHERE session_id = ?")
        .get(req.toSessionId) as { m: number | null } | null
      const nextOrder = (maxRow?.m ?? 0) + 1
      const transferredAt = nowIso()

      // SATU UPDATE: seluruh kolom dipertahankan; hanya namespace, posisi
      // tampilan, revisi (mutasi nyata), dan timestamp yang berubah. Lineage
      // dan status TIDAK disentuh.
      const moved = db
        .prepare(
          `UPDATE tasks
              SET session_id = ?, task_order = ?, revision = revision + 1, updated_at = ?
            WHERE session_id = ? AND task_id = ? AND revision = ?`,
        )
        .run(
          req.toSessionId,
          nextOrder,
          transferredAt,
          req.fromSessionId,
          req.taskId,
          req.expectedRevision,
        )
      if (moved.changes !== 1) {
        // Normalnya mustahil di dalam transaksi; tetap ditangani sebagai
        // klasifikasi, bukan dianggap sukses.
        return refuse("REJECTED_STALE_REVISION", "task moved while transfer was being prepared")
      }

      const transfer: TaskTransfer = {
        transferId: randomUUID(),
        taskId: req.taskId,
        fromSessionId: req.fromSessionId,
        fromIncarnation: req.fromIncarnation,
        toSessionId: req.toSessionId,
        toIncarnation: req.toIncarnation,
        expectedRevision: req.expectedRevision,
        newRevision: req.expectedRevision + 1,
        status: raw.status,
        execGeneration: raw.exec_generation,
        attemptGeneration: raw.attempt_generation,
        executionOwner: raw.execution_owner === "scheduler" ? "scheduler" : null,
        transferredAt,
      }
      try {
        db.prepare(
          `INSERT INTO task_transfers
             (transfer_id, task_id, from_session_id, from_incarnation, to_session_id,
              to_incarnation, expected_revision, new_revision, status, exec_generation,
              attempt_generation, execution_owner, transferred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          transfer.transferId,
          transfer.taskId,
          transfer.fromSessionId,
          transfer.fromIncarnation,
          transfer.toSessionId,
          transfer.toIncarnation,
          transfer.expectedRevision,
          transfer.newRevision,
          transfer.status,
          transfer.execGeneration,
          transfer.attemptGeneration,
          transfer.executionOwner,
          transfer.transferredAt,
        )
      } catch (e) {
        // Jangan telan: transaksi akan rollback, dan pesan ini adalah bukti
        // bahwa transfer TIDAK berlaku.
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `transfer ledger write failed: ${(e as Error).message}`,
        )
      }

      return {
        outcome: "TRANSFERRED",
        task: this.getTask(req.toSessionId, req.taskId),
        transfer,
        detail: `moved ${req.taskId} from ${req.fromSessionId} to ${req.toSessionId}`,
        unresolvedRelations: [],
      }
    })()
  }

  /**
   * [P14.3] Baca ledger dedup. Append-only dan read-only; dipakai audit/CLI.
   */
  listTaskMerges(
    filter: { sessionId?: string; survivorId?: string; duplicateId?: string } = {},
  ): TaskMerge[] {
    const db = handle(this.cwd)
    const clauses: string[] = []
    const params: string[] = []
    if (filter.sessionId !== undefined) {
      clauses.push("session_id = ?")
      params.push(filter.sessionId)
    }
    if (filter.survivorId !== undefined) {
      clauses.push("survivor_id = ?")
      params.push(filter.survivorId)
    }
    if (filter.duplicateId !== undefined) {
      clauses.push("duplicate_id = ?")
      params.push(filter.duplicateId)
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const rows = db
      .prepare(
        `SELECT merge_id          AS mergeId,
                session_id        AS sessionId,
                survivor_id       AS survivorId,
                duplicate_id      AS duplicateId,
                evidence          AS evidence,
                survivor_status   AS survivorStatus,
                duplicate_status  AS duplicateStatus,
                duplicate_revision AS duplicateRevision,
                merged_at         AS mergedAt
           FROM task_merges${where}
          ORDER BY merged_at, rowid`,
      )
      .all(...params) as TaskMerge[]
    return rows
  }

  /**
   * [P14.3] Deklarasikan EKSPLISIT bahwa satu task adalah duplikat unit kerja
   * dari task lain di SESI YANG SAMA, lalu tutup duplikat sebagai CANCELLED.
   *
   * Kontrak yang membuat operasi ini aman:
   *
   *   1. EVIDENCE WAJIB. Kemiripan judul bukan bukti — operator menulis
   *      alasannya dan teks itu masuk ledger utuh. Tidak ada jalur otomatis
   *      ke fungsi ini (proyeksi hanya MENANDAI kandidat serupa sebagai
   *      UNPROVEN; ia tidak pernah menyatukan).
   *   2. Duplikat ditutup CANCELLED, BUKAN COMPLETED. "Sudah dikerjakan di
   *      task lain" adalah keputusan operator; menulis COMPLETED akan menjadi
   *      inferisi penyelesaian yang dilarang P14. CANCELLED = unit ini
   *      ditarik sebagai kerja terpisah, status kanonik tetap jujur.
   *   3. Penulisan status lewat `patchTask` — penulis lifecycle yang SAMA
   *      dengan jalur model/operator (revisi maju, ownership dilepas saat
   *      keluar dari status in-flight). Tidak ada jalur tulis kedua.
   *   4. SATU transaksi (`withTransaction`): patch + INSERT ledger berjalan
   *      bersama. Kegagalan ledger = status duplikat ikut rollback.
   *   5. Duplikat terminal ditolak: pekerjaan yang sudah ditutup tidak
   *      dibuka ulang hanya untuk ditutup lagi. Survivor BOLEH terminal —
   *      kasus klasik dedup adalah "task pending ini ternyata sudah
   *      dikerjakan task yang selesai".
   *   6. Antar-sesi ditolak: pindahkan otoritasnya dulu lewat
   *      `transferTaskAuthority` (adopsi), baru merge di satu namespace.
   *
   * Pembalikan kesalahan tetap jujur: ledger append-only (deklarasi tetap
   * tercatat selamanya), dan status kini-duplikat boleh dibuka kembali
   * operator lewat penulisan lifecycle biasa — status saat itulah kebenaran,
   * ledger hanyalah sejarah keputusan.
   */
  declareTaskDuplicate(req: TaskDuplicateRequest): TaskDuplicateResult {
    const refuse = (
      outcome: TaskDuplicateOutcome,
      detail: string,
      survivor: Task | null = null,
    ): TaskDuplicateResult => ({
      outcome,
      detail,
      duplicate: null,
      survivor,
      merge: null,
    })

    if (!isTaskId(req.survivorId) || !isTaskId(req.duplicateId)) {
      throw new TaskError(
        "TASK_INVALID_ID",
        `not canonical ids: ${req.survivorId}/${req.duplicateId}`,
      )
    }
    if (req.survivorId === req.duplicateId) {
      return refuse("REFUSED_SELF_MERGE", "a task cannot be a duplicate of itself")
    }
    const evidence = req.evidence.trim()
    if (evidence.length === 0) {
      return refuse(
        "REFUSED_NO_EVIDENCE",
        "dedup requires operator evidence — similar wording is not proof",
      )
    }
    const survivor = this.getTask(req.sessionId, req.survivorId)
    if (survivor === null) {
      return refuse("NOT_FOUND", `no task ${req.survivorId} in ${req.sessionId}`)
    }
    const duplicate = this.getTask(req.sessionId, req.duplicateId)
    if (duplicate === null) {
      return refuse("NOT_FOUND", `no task ${req.duplicateId} in ${req.sessionId}`, survivor)
    }
    if (duplicate.status === "COMPLETED" || duplicate.status === "CANCELLED") {
      return refuse(
        "REFUSED_TERMINAL_DUPLICATE",
        `${req.duplicateId} is already ${duplicate.status} — closed work is never reopened to be closed again`,
        survivor,
      )
    }
    if (req.expectedRevision !== undefined && req.expectedRevision !== duplicate.revision) {
      return refuse(
        "REJECTED_STALE_REVISION",
        `${req.duplicateId} is at revision ${duplicate.revision}, expected ${req.expectedRevision}`,
        survivor,
      )
    }

    // SATU transaksi: patchTask (penulis lifecycle yang sudah ada) + ledger
    // digabung oleh boundary Phase 4A.2 — nested db.transaction di bun adalah
    // savepoint yang bergabung, bukan transaksi terpisah.
    return this.withTransaction((): TaskDuplicateResult => {
      // Baca ulang DI DALAM transaksi: dunia boleh bergerak antara
      // pemeriksaan di atas dan titik tulis.
      const current = this.getTask(req.sessionId, req.duplicateId)
      if (current === null) {
        return refuse("NOT_FOUND", `${req.duplicateId} vanished while merge was prepared`)
      }
      if (current.status === "COMPLETED" || current.status === "CANCELLED") {
        return refuse(
          "REFUSED_TERMINAL_DUPLICATE",
          `${req.duplicateId} became ${current.status} while merge was prepared`,
        )
      }
      const survivorNow = this.getTask(req.sessionId, req.survivorId)
      if (survivorNow === null) {
        return refuse("NOT_FOUND", `${req.survivorId} vanished while merge was prepared`)
      }
      let patched: Task
      try {
        patched = this.patchTask(
          req.sessionId,
          req.duplicateId,
          { status: "CANCELLED" },
          req.expectedRevision !== undefined ? { expectedRevision: req.expectedRevision } : {},
        )
      } catch (e) {
        // Stale di jendela race = klasifikasi, bukan crash. Error TaskStore
        // lain (persistence, dependency) tetap dilempar — jangan ditelan.
        if (e instanceof TaskError && e.code === "TASK_STALE_REVISION") {
          return refuse(
            "REJECTED_STALE_REVISION",
            `${req.duplicateId} moved while merge was being prepared`,
            survivorNow,
          )
        }
        throw e
      }

      const merge: TaskMerge = {
        mergeId: randomUUID(),
        sessionId: req.sessionId,
        survivorId: req.survivorId,
        duplicateId: req.duplicateId,
        evidence,
        survivorStatus: survivorNow.status,
        duplicateStatus: patched.status,
        duplicateRevision: patched.revision,
        mergedAt: patched.updatedAt,
      }
      const db = handle(this.cwd)
      try {
        db.prepare(
          `INSERT INTO task_merges
             (merge_id, session_id, survivor_id, duplicate_id, evidence,
              survivor_status, duplicate_status, duplicate_revision, merged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          merge.mergeId,
          merge.sessionId,
          merge.survivorId,
          merge.duplicateId,
          merge.evidence,
          merge.survivorStatus,
          merge.duplicateStatus,
          merge.duplicateRevision,
          merge.mergedAt,
        )
      } catch (e) {
        throw new TaskError(
          "TASK_PERSISTENCE_FAILURE",
          `merge ledger write failed: ${(e as Error).message}`,
        )
      }
      return {
        outcome: "DECLARED",
        duplicate: patched,
        survivor: this.getTask(req.sessionId, req.survivorId),
        merge,
        detail: `closed ${req.duplicateId} as duplicate of ${req.survivorId} (CANCELLED, not COMPLETED)`,
      }
    }, true)
  }

  // ── meta / migration ──────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const db = handle(this.cwd)
    const row = db.prepare("SELECT value FROM task_meta WHERE key = ?").get(key) as {
      value: string
    } | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    const db = handle(this.cwd)
    db.prepare("INSERT OR REPLACE INTO task_meta (key, value) VALUES (?, ?)").run(key, value)
  }

  /** Sessions whose data has already been imported from a legacy file,
   *  together with the source fingerprint used. Used by migration idempotency. */
  migrationStamp(sessionId: string): string | null {
    return this.getMeta(`migrated:${sessionId}`)
  }

  markMigrated(sessionId: string, digest: string): void {
    this.setMeta(`migrated:${sessionId}`, digest)
  }

  dataVersion(): number {
    const raw = this.getMeta("data_version")
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : 0
  }

  ensureDataVersion(): number {
    const v = this.dataVersion()
    if (v === 0) this.setMeta("data_version", String(TASK_DATA_VERSION))
    if (v > TASK_DATA_VERSION) {
      throw new TaskError(
        "TASK_MIGRATION_FAILURE",
        `data written by newer version (${v} > ${TASK_DATA_VERSION}); refusing to downgrade`,
      )
    }
    return TASK_DATA_VERSION
  }

  /** Close the handle. For tests and explicit shutdown only. */
  static close(cwd?: string): void {
    closeTaskStoreHandle(cwd)
  }

  // ── transaction boundary (Phase 4A.2) ─────────────────────────────────────

  /**
   * Run `fn` inside a single SQLite transaction owned by THIS TaskStore.
   *
   * WHY THIS EXISTS. A caller could previously open its own `db.transaction()`
   * and call TaskStore methods inside it, and get atomicity that was silently
   * false: TaskStore holds its own cached `Database` handle, so the caller's
   * transaction and TaskStore's writes were two different connections and
   * committed independently. Measured: a forced throw rolled back nothing.
   *
   * WHY THE CALLBACK RECEIVES `this`. The transaction is opened on the very same
   * cached handle that every TaskStore method obtains from `handle(cwd)`, so
   * there is exactly ONE authoritative connection per path. Every method called
   * on `tx` therefore participates in this transaction by construction - there
   * is no "escaped" path, and no second allocator or duplicated SQL.
   *
   * NESTING. `bun:sqlite` implements a nested `db.transaction` as a savepoint
   * that joins the enclosing transaction rather than committing independently
   * (measured). So `createTask`/`patchTask`, which each open their own
   * transaction, compose correctly inside this one with no extra machinery.
   *
   * BUSY HANDLING. Deliberately unchanged: this adds no new retry. Contention
   * is handled by the connection's existing `busy_timeout` pragma, and the
   * bounded per-statement retry remains scoped to schema DDL exactly as in
   * Phase 1. No unbounded retry is introduced here.
   *
   * Errors from `fn` propagate unchanged after rollback.
   */
  withTransaction<T>(fn: (tx: TaskStore) => T, immediate = false): T {
    const p = dbFile(this.cwd)
    const db = handle(this.cwd)
    const depth = txDepth.get(p) ?? 0
    txDepth.set(p, depth + 1)
    try {
      const txn = db.transaction(() => fn(this))
      // IMMEDIATE mengambil lock tulis sejak awal agar pola baca-lalu-tulis lintas koneksi tidak terkena deadlock upgrade SQLite.
      return immediate && depth === 0 ? txn.immediate() : txn()
    } finally {
      const d = (txDepth.get(p) ?? 1) - 1
      if (d <= 0) txDepth.delete(p)
      else txDepth.set(p, d)
    }
  }

  /** True when a `withTransaction` is currently in flight for this store's
   *  database. Diagnostics only; the guard above is what enforces safety. */
  inTransaction(): boolean {
    return (txDepth.get(dbFile(this.cwd)) ?? 0) > 0
  }
  // â”€â”€ [PHASE 6X] session-level autonomous authority (6W ADR-20/21) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // [DESIGN DECISION] The lease is a SESSION fact, kept deliberately separate from
  // the tasks table and from 6Q's per-task lineage. The two layers never read each
  // other, so authority can never be half-updated alongside a task row.
  //
  // Its existence is NOT evidence of liveness - it is a bounded claim on the right
  // to schedule. That distinction is the whole fix for 6V FINDING-02, which needed
  // two reconcilers to coexist on one session so one could revert the other's live
  // execution. Exactly one of them can hold this row at a time.

  /**
   * Read the authority record for a session's current incarnation, or null.
   *
   * [DESIGN DECISION] Fail-closed on an undecodable row: it reads as "no authority
   * exists", the safe direction for a caller deciding whether it may schedule. It is
   * NOT treated as free for a *renewal*, which additionally requires our own token.
   */
  getSessionAuthority(sessionId: string, incarnation?: number): SessionAuthority | null {
    const inc = incarnation ?? this.getSessionIncarnation(sessionId)
    const row = handle(this.cwd)
      .prepare(
        `SELECT owner_token AS ownerToken,
                owner_pid AS ownerPid,
                acquired_at AS acquiredAt,
                lease_expires_at AS leaseExpiresAt,
                incarnation
           FROM session_authority
          WHERE session_id = ? AND incarnation = ?`,
      )
      .get(sessionId, inc) as Record<string, unknown> | undefined | null
    if (row === undefined || row === null) return null
    return {
      sessionId,
      incarnation: Number(row.incarnation),
      ownerToken: String(row.ownerToken),
      ownerPid: Number(row.ownerPid),
      acquiredAt: Number(row.acquiredAt),
      leaseExpiresAt: Number(row.leaseExpiresAt),
    }
  }

  /**
   * Take the lease, or renew it, in ONE atomic statement.
   *
   * [DESIGN DECISION] This is the mutual-exclusion primitive, so it must be one SQL
   * statement. Split into a read-then-write it would reintroduce precisely the race
   * F02 needed, and a concurrent pair of acquirers would then have two winners.
   *
   * The `ON CONFLICT ... WHERE` clause is the whole trick: the upsert lands only when
   * no row exists, or when the existing row is still OURS. A live lease belonging to
   * somebody else fails the WHERE, is left untouched, and `changes` reports 0.
   */
  acquireSessionAuthority(
    sessionId: string,
    ownerToken: string,
    leaseMs: number,
    now = Date.now(),
  ): "ACQUIRED" | "REFUSED_LEASE_HELD" {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `INSERT INTO session_authority
           (session_id, incarnation, owner_token, owner_pid, acquired_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, incarnation) DO UPDATE SET
           -- [PHASE 6X] owner_token MUST be updated here, not just the deadline.
           -- On a takeover the new owner has to become the recorded owner, or the
           -- row would keep naming the previous owner while its lease was extended -
           -- so the old token would still pass holdsSessionAuthority and both
           -- parties would believe they were authoritative.
           owner_token      = excluded.owner_token,
           owner_pid        = excluded.owner_pid,
           acquired_at      = excluded.acquired_at,
           lease_expires_at = excluded.lease_expires_at
         WHERE session_authority.owner_token = excluded.owner_token
            OR session_authority.lease_expires_at <= ?`,
      )
      .run(sessionId, inc, ownerToken, process.pid, now, now + leaseMs, now)
    return result.changes === 1 ? "ACQUIRED" : "REFUSED_LEASE_HELD"
  }

  /**
   * Extend OUR lease. Refused when the token is not the current owner's, which is
   * what stops a paused or partitioned process from reclaiming a session whose lease
   * has already been taken over.
   */
  renewSessionAuthority(
    sessionId: string,
    ownerToken: string,
    leaseMs: number,
    now = Date.now(),
  ): "AUTHORITY_HELD" | "AUTHORITY_LOST" {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `UPDATE session_authority
            SET lease_expires_at = ?
          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`,
      )
      .run(now + leaseMs, sessionId, inc, ownerToken)
    return result.changes === 1 ? "AUTHORITY_HELD" : "AUTHORITY_LOST"
  }

  /**
   * Give the lease back.
   *
   * [DESIGN DECISION] A clean stop is an unambiguous handover, so the row is DELETED
   * rather than left to expire. Keeping it would leave a released session with an
   * "authority record" a later reader could mistake for a live owner. The EXPIRY
   * path is the one that preserves the row, so a crashed owner's takeover history
   * stays inspectable.
   *
   * Token-guarded, so a stale instance can only ever fail to release - never evict
   * the successor that holds the session now.
   */
  releaseSessionAuthority(sessionId: string, ownerToken: string): boolean {
    const inc = this.getSessionIncarnation(sessionId)
    const result = handle(this.cwd)
      .prepare(
        `DELETE FROM session_authority
          WHERE session_id = ? AND incarnation = ? AND owner_token = ?`,
      )
      .run(sessionId, inc, ownerToken)
    return result.changes === 1
  }

  /**
   * Is OUR authority still valid right now?
   *
   * The single predicate every scheduling boundary consults. A lease is ACTIVE while
   * `lease_expires_at > now`; the strict inequality means an expired row is already
   * free, so expiry and takeover can never both succeed at the same instant.
   */
  holdsSessionAuthority(sessionId: string, ownerToken: string, now = Date.now()): boolean {
    const a = this.getSessionAuthority(sessionId)
    return a !== null && a.ownerToken === ownerToken && a.leaseExpiresAt > now
  }
}
