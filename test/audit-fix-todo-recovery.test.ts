// [P0-1 / P1-4a / P1-4b] TaskStore seam recovery — verified audit fixes.
//
// Fokus: kegagalan sinkronisasi kanonik TIDAK boleh membiarkan JSON dan
// TaskStore tidak konsisten, dan model todo_write TIDAK boleh me-requeue task
// yang sedang diklaim Scheduler. Semua id di sini berasal dari TaskStore, bukan
// dari JSON lama, supaya jalur perbaikan yang disarankan benar-benar bekerja.
//
// SAFETY (Phase 0A): satu mkdtemp per test, dihapus lewat path absolutnya sendiri.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type PatchOptions,
  resetTaskStoreHandles,
  type TaskPatch,
  TaskStore,
} from "../src/task/store.ts"
import { synchronizeCanonicalTasks } from "../src/task/sync.ts"
import {
  loadTodos,
  restoreTodoViewFromStore,
  saveTodos,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mc-audit-todo-recovery-"))
  owned.push(dir)
  return dir
}
const prevId = todoSession.id
const prevCwd = todoSession.cwd
afterEach(async () => {
  todoSession.id = prevId
  todoSession.cwd = prevCwd
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const S = "audit-recovery"
const prov = { origin: "runtime", source: "test" } as const
const ctx = (cwd: string, sessionId = S) =>
  ({ signal: new AbortController().signal, cwd, sessionId }) as never

function seed(cwd: string, sessionId = S): TaskStore {
  const store = new TaskStore(cwd)
  for (const [i, title] of ["A", "B", "C"].entries()) {
    store.createTask(sessionId, { title, status: "PENDING", order: i, provenance: prov })
  }
  return store
}

// ── P0-1: sinkronisasi gagal → JSON di-derive ulang dari TaskStore ───────────
test("P0-1: phantom taskId tidak bertahan; error menyebut id asli + jalur perbaikan", async () => {
  const dir = await ownedDir()
  todoSession.id = S
  todoSession.cwd = dir
  seed(dir)
  // Tulis dulu tampilan sah agar jelas bahwa tulisan berikutnya yang gagal
  // tidak boleh merusaknya.
  await saveTodos(
    S,
    [
      { content: "A", status: "pending", taskId: "t1" },
      { content: "B", status: "pending", taskId: "t2" },
      { content: "C", status: "pending", taskId: "t3" },
    ],
    dir,
  )

  let err: { code?: string; message?: string } | undefined
  try {
    await todoWriteTool.execute(
      { todos: [{ taskId: "t99", content: "ghost", status: "pending" }] },
      ctx(dir),
    )
  } catch (e) {
    err = e as { code?: string; message?: string }
  }
  expect(err?.code).toBe("TASK_NOT_FOUND")
  expect(err?.message).toContain("t1, t2, t3")
  expect(err?.message).toContain("todo_read")
  // JSON mengikuti TaskStore (otoritas), bukan payload yang gagal.
  const view = await loadTodos(S, dir)
  expect(view.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"])
  expect(view.some((t) => t.taskId === "t99")).toBe(false)
  expect(new TaskStore(dir).getTask(S, "t99")).toBeNull()

  // Jalur perbaikan yang diiklankan error benar-benar bekerja.
  const out = (await todoWriteTool.execute(
    {
      todos: [
        { taskId: "t1", content: "A", status: "pending" },
        { taskId: "t2", content: "B", status: "pending" },
        { taskId: "t3", content: "C", status: "pending" },
      ],
    },
    ctx(dir),
  )) as string
  expect(out).toContain("todos 0/3")
})

// ── P0-1: TaskStore rollback ke kosong → pulihkan tampilan lama, bukan phantom
test("P0-1: tanpa canonical task, rollback memulihkan daftar legacy dan saran cocok", async () => {
  const dir = await ownedDir()
  todoSession.id = S
  todoSession.cwd = dir
  // Sesi legacy: ada JSON id-less, tapi belum ada baris kanonik sama sekali.
  await saveTodos(S, [{ content: "legacy step", status: "pending" }], dir)

  let err: { code?: string; message?: string } | undefined
  try {
    // taskId t1 tidak ada di TaskStore → sinkronisasi gagal sebelum commit.
    await todoWriteTool.execute(
      { todos: [{ taskId: "t1", content: "ghost", status: "pending" }] },
      ctx(dir),
    )
  } catch (e) {
    err = e as { code?: string; message?: string }
  }
  expect(err?.code).toBe("TASK_NOT_FOUND")
  expect(err?.message).toContain("no taskId")
  expect(new TaskStore(dir).listTasks(S)).toHaveLength(0)
  const view = await loadTodos(S, dir)
  expect(view.map((t) => t.content)).toEqual(["legacy step"])
  expect(view[0]?.taskId).toBeUndefined()

  // Saran "fresh full list with no taskId" berujung pada adopsi yang sukses.
  const out = (await todoWriteTool.execute(
    { todos: [{ content: "fresh", status: "pending" }] },
    ctx(dir),
  )) as string
  expect(out).toContain("canonical-tasks")
  expect(new TaskStore(dir).listTasks(S).map((t) => t.id)).toEqual(["t1"])
})

// ── P0-1: helper dapat dipanggil ulang (idempoten) dari jalur recovery ──────
test("P0-1: restoreTodoViewFromStore idempoten dan mengembalikan id TaskStore", async () => {
  const dir = await ownedDir()
  seed(dir)
  await saveTodos(S, [{ content: "stale", status: "pending", taskId: "t99" }], dir)
  const ids = await restoreTodoViewFromStore(S, dir, [])
  expect(ids).toEqual(["t1", "t2", "t3"])
  expect((await loadTodos(S, dir)).map((t) => t.taskId)).toEqual(["t1", "t2", "t3"])
  const again = await restoreTodoViewFromStore(S, dir, [])
  expect(again).toEqual(ids)
})

// ── P1-4b: todo_write tidak boleh me-requeue eksekusi Scheduler ─────────────
test("P1-4b: task claimed Scheduler tidak bisa diset PENDING oleh todo_write", async () => {
  const dir = await ownedDir()
  todoSession.id = S
  todoSession.cwd = dir
  const store = seed(dir)
  const claim = store.claimTask(S, "t1", 1)
  expect(claim.outcome).toBe("CLAIM_ACCEPTED")

  let err: { code?: string } | undefined
  try {
    await todoWriteTool.execute(
      { todos: [{ taskId: "t1", content: "A", status: "pending" }] },
      ctx(dir),
    )
  } catch (e) {
    err = e as { code?: string }
  }
  expect(err?.code).toBe("TASK_AUTHORITY_VIOLATION")
  // Status, revisi, dan kepemilikan tidak berubah; JSON mengikuti TaskStore.
  const after = new TaskStore(dir)
  expect(after.getTask(S, "t1")?.status).toBe("IN_PROGRESS")
  expect(after.getExecutionOwnership(S, "t1")?.executionOwner).toBe("scheduler")
  expect((await loadTodos(S, dir))[0]?.status).toBe("in_progress")
})

// ── P1-4a: transaksi sinkronisasi memakai IMMEDIATE ─────────────────────────
test("P1-4a: synchronizeCanonicalTasks meminta withTransaction(..., true)", async () => {
  const dir = await ownedDir()
  seed(dir)
  const original = TaskStore.prototype.withTransaction
  let seenImmediate: boolean | undefined
  TaskStore.prototype.withTransaction = function <T>(
    this: TaskStore,
    fn: (tx: TaskStore) => T,
    immediate?: boolean,
  ): T {
    seenImmediate = immediate
    return original.call(this, fn, immediate) as T
  }
  try {
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [{ taskId: "t1", title: "A", status: "pending" }],
    })
  } finally {
    TaskStore.prototype.withTransaction = original
  }
  expect(seenImmediate).toBe(true)
})

// ── P1-4b: patch existing memakai expectedRevision dari snapshot ────────────
test("P1-4b: patch task existing membawa expectedRevision (CAS)", async () => {
  const dir = await ownedDir()
  seed(dir)
  const original = TaskStore.prototype.patchTask
  const seenOpts: PatchOptions[] = []
  TaskStore.prototype.patchTask = function (
    this: TaskStore,
    sessionId: string,
    taskId: string,
    patch: TaskPatch,
    opts: PatchOptions = {},
  ) {
    seenOpts.push(opts)
    return original.call(this, sessionId, taskId, patch, opts)
  }
  try {
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [{ taskId: "t1", title: "renamed", status: "pending" }],
    })
  } finally {
    TaskStore.prototype.patchTask = original
  }
  expect(seenOpts).toHaveLength(1)
  expect(seenOpts[0]?.expectedRevision).toBe(1)
})
