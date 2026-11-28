// Sinkronisasi tugas kanonikal produksi untuk `todo_write`.
// Urutan eksekusi: tulis JSON persisten lebih dulu -> sinkronkan state ke
// TaskStore -> publikasikan rencana di adapter (`src/presentation/adapter.ts`).
// Jika penulisan persisten gagal, pembaruan rencana ikut ditahan.
//
// CLASSIFICATION (the approved distinction)
//   mixed payload (>=1 taskId)  -> id-bearing items are EXISTING, id-less items
//                                  are genuinely NEW
//   all-id-less payload         -> NOT synchronized. The legacy JSON path stays
//                                  exactly as it was; no automatic adoption, no
//                                  id allocation, no manifest. Rejecting that
//                                  case is Phase 4A.5's decision, not this one's.
//
// IDENTITY RULES
//   - an explicit taskId is resolved directly through TaskStore. NEVER by array
//     position, content, title or ordinal.
//   - the WHOLE payload is validated before the first mutation (the Phase 3A
//     resolve-before-mutate invariant, preserved).
//   - only TaskStore allocates ids, via `createTask`. This module never formats
//     one.
//   - one `todo_write` is one `withTransaction`: every update, creation, order
//     change and metadata write either all commit or all roll back.

import type { CanonicalAssignment, CanonicalAssignmentTable } from "./assignment.ts"
import { type DeclaredTask, planTaskIdentities, todoStatusToTask } from "./identity.ts"
import { isTaskId, isTerminalTaskStatus, type Task, TaskError, type TaskStatus } from "./model.ts"
import { type PatchOptions, TaskStore, type VerificationGateOutcome } from "./store.ts"

/** One declared item, already mapped out of the legacy `TodoItem` shape.
 *  `content` is mapped to `title` by the caller - the store requires `title`,
 *  and passing `content` straight through was measured to fail NOT NULL. */
export interface CanonicalTaskInput {
  taskId?: string
  title: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked"
  blockedReason?: string
  /**
   * [Fase 3 / LOOP-INV-12, LOOP-G20] Klaim `completed` saat `requireVerified`
   * aktif namun hasil verifikasi belum tersedia (`unverified`): task ditahan di
   * status `VERIFYING` alih-alih diloloskan ke `COMPLETED` palsu.
   */
  holdVerifying?: boolean
}

export interface CanonicalSyncResult {
  /** False when the payload was all-id-less and therefore left legacy. */
  applied: boolean
  reason?: "legacy-idless-payload"
  changed: Task[]
  created: Task[]
  /** D7 survivors: declared in an earlier turn, omitted now, kept anyway. */
  retained: Task[]
  /**
   * PHASE 4A.4A — one entry per DECLARED item, in declaration order: the
   * canonical id that item now has, and whether it already existed or this
   * operation minted it. Absent for the legacy all-id-less path, which performs
   * no synchronization and therefore has nothing to assign.
   *
   * Built INSIDE the transaction from the ids `createTask` returned, so it is
   * exactly the committed result and never a later reconstruction. A rollback
   * throws, so no assignment can be published for a transaction that did not
   * commit — that is a structural guarantee, not a check.
   */
  assignment?: CanonicalAssignmentTable
}

/** True when at least one item carries an identity. Mirrors the recovered
 *  artifact's `hasAnyId` switch (`store.orig.ts:480`). */
export function hasCanonicalIdentity(items: readonly { taskId?: string }[]): boolean {
  return items.some((i) => typeof i.taskId === "string" && i.taskId !== "")
}

/**
 * PHASE 4A.5 — does this session ALREADY have canonical identity?
 *
 * AUTHORITY. This asks TaskStore, and nothing else. The legacy JSON file is NOT
 * consulted, on purpose:
 *   - a JSON file exists for every session that has ever written a todo, canonical
 *     or not, so its presence says nothing about canonical identity;
 *   - conversely, a canonical session can have its JSON rewritten by a rejected
 *     write, so the JSON can be a poor predictor in the other direction too.
 *   The duplication this guards against is duplicate DURABLE tasks, so the
 * predicate has to be answered by the store that holds them.
 *
 * STATUS IS DELIBERATELY IGNORED. Every row counts, whatever its status. A
 * session whose tasks are all COMPLETED, CANCELLED or BLOCKED still has canonical
 * identity: its ids are allocated, its orders are meaningful, and an identity-blind
 * re-declaration would duplicate them. Filtering by status would silently reopen
 * the duplication bug the moment a todo list finished.
 *
 * `task_meta` (the dormant migration substrate from Phase 0C/1) is also NOT
 * consulted: nothing in production writes it, and no task means no identity to
 * protect. A future bootstrap must therefore CREATE tasks, not merely write a
 * stamp, or this guard would not see it - see the report.
 */
export function hasCanonicalTasks(cwd: string, sessionId: string): boolean {
  try {
    return new TaskStore(cwd).listTasks(sessionId).length > 0
  } catch (e) {
    // A store we cannot open cannot be proven canonical, and claiming otherwise
    // would either invent identity or block a legitimate legacy write. Fail open
    // to LEGACY and let the legacy path behave exactly as it always has.
    if (e instanceof TaskError) throw e
    return false
  }
}

export function synchronizeCanonicalTasks(opts: {
  cwd: string
  sessionId: string
  declared: readonly CanonicalTaskInput[]
  /**
   * [Fase 3 / LOOP-INV-12] Bukti verifikasi terstruktur bila tersedia. Saat
   * klaim `completed` didasari verifikasi yang lulus, transisi melalui
   * `VERIFYING -> COMPLETED` dan menyimpan `evidence_json`.
   */
  verificationOutcome?: VerificationGateOutcome
  /**
   * [Fase 8 / 8.3] Izinkan payload all-id-less di-adopsi sebagai canonical
   * saat sesi BELUM punya identitas kanonik sama sekali (belum ada baris
   * tasks). Tanpa ini, `todo_write` pertama yang memakai payload tanpa `taskId`
   * tidak pernah masuk `tasks.db` → Live Test §3.1 (`0 rows`). Setiap item
   * id-less dianggap task baru dan id dialokasikan oleh TaskStore.
   */
  adoptIdlessAsNew?: boolean
}): CanonicalSyncResult {
  const { cwd, sessionId, declared, verificationOutcome, adoptIdlessAsNew } = opts

  // All-id-less: legacy behaviour, untouched — KECUALI caller meminta adopsi
  // (first canonical write). No adoption, no allocation bila tidak diminta.
  if (!hasCanonicalIdentity(declared) && !adoptIdlessAsNew) {
    return {
      applied: false,
      reason: "legacy-idless-payload",
      changed: [],
      created: [],
      retained: [],
    }
  }

  const store = new TaskStore(cwd)

  // Pure planning + validation. Throws on a malformed or duplicated id BEFORE
  // any statement runs, so a bad payload cannot half-apply.
  const asDeclared: DeclaredTask[] = declared.map((d) => ({
    ...(d.taskId ? { taskId: d.taskId } : {}),
    title: d.title,
    status: d.status,
    ...(d.blockedReason ? { blockedReason: d.blockedReason } : {}),
  }))
  const plan = planTaskIdentities(asDeclared)

  // [P1-4b] Ambil snapshot revisi SEBELUM kunci tulis diambil. Ini bukan
  // pembacaan di dalam transaksi: jeda antara snapshot dan `withTransaction`
  // adalah jendela yang dipakai penulis lain (mis. Scheduler yang claim task)
  // untuk memajukan revisi. Dengan `expectedRevision` dari snapshot lama,
  // `patchTask` menolak CAS alih-alih diam-diam menimpa eksekusi live.
  const revisions = new Map<string, number>()
  for (const t of store.listTasks(sessionId)) revisions.set(t.id, t.revision)
  const revOpts = (id: string): PatchOptions => {
    const expectedRevision = revisions.get(id)
    return expectedRevision === undefined ? {} : { expectedRevision }
  }

  // [P1-4a] IMMEDIATE, bukan DEFERRED: transaksi ini membaca lalu menulis lintas
  // koneksi, jadi lock tulis harus diambil di awal agar upgrade kunci SQLite
  // tidak deadlock saat penulis lain menunggu. Tidak ada perubahan status/order
  // selain timing lock.
  return store.withTransaction((tx) => {
    // Resolve-before-mutate, second leg: every claimed id must already exist.
    // An unknown id is a hard failure - never a silent "treat as new".
    for (const id of plan.requiredExisting) {
      if (!tx.getTask(sessionId, id)) {
        throw new TaskError("TASK_NOT_FOUND", `declared unknown task ${id}`)
      }
    }

    // [P1-4b] Pagar authority: model todo_write TIDAK boleh mengubah task yang
    // sedang diklaim Scheduler menjadi status apa pun yang melepaskan ownership.
    // [AUDIT] Dulu pagar hanya menolak target PENDING. Itu lubang: patchTask
    // (store.ts) mengosongkan `execution_owner` SETIAP KALI status keluar dari
    // IN_PROGRESS/VERIFYING, dan TASK_EDGES mengizinkan IN_PROGRESS→COMPLETED/
    // CANCELLED/BLOCKED. Jadi todo_write yang menyatakan task live "selesai"/
    // "batal"/"blocked" lewat pagar lama dan meng-yatim-kan eksekusi yang masih
    // jalan. Oleh karena itu tolak SEMUA target yang melepaskan ownership,
    // bukan hanya PENDING.
    const refuseSchedulerRequeue = (id: string, target: TaskStatus): void => {
      // IN_PROGRESS/VERIFYING ada di RECONCILABLE_STATUSES: tidak melepaskan
      // ownership (itu cursor plan agent di atas klaim live, bukan akhir eksekusi).
      // Setiap status lain melepaskan ownership → wajib ditolak saat owner scheduler.
      if (target === "IN_PROGRESS" || target === "VERIFYING") return
      const current = tx.getTask(sessionId, id)
      if (!current || (current.status !== "IN_PROGRESS" && current.status !== "VERIFYING")) return
      if (tx.getExecutionOwnership(sessionId, id)?.executionOwner !== "scheduler") return
      throw new TaskError(
        "TASK_AUTHORITY_VIOLATION",
        `${id} is claimed by the scheduler (${current.status}); a model todo_write cannot move a live execution to ${target} (that would release execution ownership and orphan the run). ` +
          `Let the scheduler finish or reconcile it first, then call todo_read and re-send.`,
      )
    }

    const seen = new Set<string>()
    const changed: Task[] = []
    const created: Task[] = []
    // PHASE 4A.4A — pushed in `plan.entries` order, which IS declaration order,
    // so index i of this table always describes declared item i.
    const assignment: CanonicalAssignment[] = []

    plan.entries.forEach((entry, index) => {
      const decl = declared[index]
      const holdVerifying = decl?.holdVerifying === true
      if (entry.kind === "existing") {
        const id = entry.taskId as string
        seen.add(id)
        assignment.push({ taskId: id, kind: "existing" })
        // [P1-4b] tolak requeue eksekusi live SEBELUM patch apa pun.
        refuseSchedulerRequeue(id, entry.status)
        // [P1-4b] CAS memakai revisi snapshot; patch di bawah gagal bila ada
        // penulis lain yang memajukan revisi di jendela sebelum lock diambil.
        const opts = revOpts(id)
        if (holdVerifying) {
          changed.push(
            tx.patchTask(
              sessionId,
              id,
              {
                title: entry.title,
                status: "VERIFYING",
                order: entry.order,
                blockedReason: null,
              },
              opts,
            ),
          )
        } else if (entry.status === "COMPLETED" && verificationOutcome?.ok === true) {
          const cur = tx.getTask(sessionId, id)!
          if (cur.status !== "COMPLETED") {
            tx.patchTask(
              sessionId,
              id,
              {
                title: entry.title,
                status: "VERIFYING",
                order: entry.order,
                blockedReason: null,
              },
              opts,
            )
            changed.push(tx.completeTaskVerification(sessionId, id, verificationOutcome))
          } else {
            changed.push(
              tx.patchTask(
                sessionId,
                id,
                {
                  title: entry.title,
                  status: entry.status,
                  order: entry.order,
                  blockedReason: entry.blockedReason,
                },
                opts,
              ),
            )
          }
        } else {
          changed.push(
            tx.patchTask(
              sessionId,
              id,
              {
                title: entry.title,
                status: entry.status,
                // `order` is the declared position. It is display/execution order,
                // never identity.
                order: entry.order,
                blockedReason: entry.blockedReason,
              },
              opts,
            ),
          )
        }
      } else {
        // Only TaskStore allocates. `input` was built by planTaskIdentities with
        // provenance { origin: "model", source: "todo_write" }.
        const baseInput = entry.input!
        const createInput = holdVerifying
          ? { ...baseInput, status: "VERIFYING" as const, blockedReason: null }
          : entry.status === "COMPLETED" && verificationOutcome?.ok === true
            ? {
                ...baseInput,
                status: "VERIFYING" as const,
                blockedReason: null,
              }
            : baseInput
        let t = tx.createTask(sessionId, createInput as never)
        if (!holdVerifying && entry.status === "COMPLETED" && verificationOutcome?.ok === true) {
          t = tx.completeTaskVerification(sessionId, t.id, verificationOutcome)
        }
        seen.add(t.id)
        // The id the allocator actually returned, captured here and now — never
        // re-derived from position, title or content afterwards.
        assignment.push({ taskId: t.id, kind: "new" })
        created.push(t)
      }
    })

    // D7 — omission is NOT deletion. A task the model did not mention this turn
    // is retained: not deleted, not cancelled, not reset. The canonical payload
    // is a full DECLARATION, not a replacement.
    //
    // Retained tasks are placed after the declared range so that
    // (task_order, task_id) stays a total, collision-free ordering key. The
    // recovered artifact instead renumbered survivors to 0..n-1, which could
    // collide with a declared item's own order; this is a deliberate difference.
    const retained: Task[] = []
    tx.listTasks(sessionId)
      .filter((t) => !seen.has(t.id))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .forEach((t, i) => {
        const order = plan.entries.length + i
        retained.push(t.order === order ? t : tx.patchTask(sessionId, t.id, { order }))
      })

    return { applied: true, changed, created, retained, assignment }
  }, true)
}

/** Resolve canonical identity for a plan projection.
 *
 *  Authority: TaskStore. An id is reported ONLY when the store actually holds
 *  that row for this session. Anything else is `null`, which makes the plan
 *  fall back to the positional legacy shape rather than emit a false `v2`.
 */
export function createTaskIdentityResolver(cwd: string) {
  return (input: { sessionId: string; declared: readonly { taskId?: string }[] }) => {
    try {
      const store = new TaskStore(cwd)
      return input.declared.map((d) => {
        if (!d.taskId || !isTaskId(d.taskId)) return null
        return store.getTask(input.sessionId, d.taskId) ? d.taskId : null
      })
    } catch {
      return undefined
    }
  }
}

/** Exported for the mapping the caller performs; kept here so the status
 *  vocabulary has a single owner. */
export { todoStatusToTask }

/**
 * [Fase 3 / LOOP-INV-12] Pindahkan task kandidat sesi ke status `VERIFYING`
 * tepat sebelum verifier dieksekusi. Hanya menyentuh task non-terminal yang
 * diminta eksplisit (`candidateTaskIds`).
 */
export function beginSessionTasksVerification(
  cwd: string,
  sessionId: string,
  candidateTaskIds: readonly string[],
): Task[] {
  if (candidateTaskIds.length === 0) return []
  const store = new TaskStore(cwd)
  return store.withTransaction((tx) => {
    const out: Task[] = []
    for (const id of candidateTaskIds) {
      if (!isTaskId(id)) continue
      const cur = tx.getTask(sessionId, id)
      if (!cur || isTerminalTaskStatus(cur.status) || cur.status === "VERIFYING") {
        if (cur?.status === "VERIFYING") out.push(cur)
        continue
      }
      out.push(tx.beginTaskVerification(sessionId, id))
    }
    return out
  }, true)
}

/**
 * [Fase 3 / LOOP-INV-12] Selesaikan seluruh task sesi yang sedang berada di
 * `VERIFYING` berdasarkan hasil verifikasi aktual (`VERIFYING -> COMPLETED`
 * bila `outcome.ok === true`, atau `VERIFYING -> BLOCKED` bila gagal).
 * Task dalam status lain (`PENDING`, `IN_PROGRESS`, `BLOCKED`) tidak disentuh.
 */
export function settleSessionVerifyingTasks(
  cwd: string,
  sessionId: string,
  outcome: VerificationGateOutcome,
): Task[] {
  const store = new TaskStore(cwd)
  return store.withTransaction((tx) => {
    const verifying = tx.listTasks(sessionId).filter((t) => t.status === "VERIFYING")
    return verifying.map((t) => tx.completeTaskVerification(sessionId, t.id, outcome))
  }, true)
}
