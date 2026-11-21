// [AUDIT-FIX / todo] Deklarasi penuh tanpa taskId pada turn lanjutan harus
// dipulihkan dari teks `content` yang persis sama, bukan membuat rencana hilang.
//
// Sesi audit nyata: resume mengirim 7 item baru tanpa taskId → guard 4A.5
// melempar TASK_IDENTITY_REQUIRED → model lanjut tanpa rencana. Di sini diuji
// tiga sisi: (a) mapping eksak berhasil, (b) konflik tetap ditolak, (c) item
// benar-benar baru tetap diterima. Semua memakai TaskStore asli di temp dir.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"
import { type Task, TaskError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { repairIdlessFullDeclaration, todoSession, todoWriteTool } from "../src/tools/todo.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "audit-todo-repair-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  todoSession.id = "default"
  todoSession.cwd = undefined
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const S = "audit-repair-session"
const prov = { origin: "runtime", source: "test" } as const
const ctx = (dir: string) =>
  ({ signal: new AbortController().signal, cwd: dir, sessionId: S }) as never
const write = (dir: string, todos: unknown[]) =>
  todoWriteTool.execute({ todos } as never, ctx(dir)) as Promise<string>
const store = (dir: string) => new TaskStore(dir)
function seed(dir: string, titles: readonly string[]): void {
  const s = store(dir)
  titles.forEach((title, i) => {
    s.createTask(S, { title, status: "PENDING", order: i, provenance: prov })
  })
}
function rows(dir: string): Task[] {
  return store(dir).listTasks(S)
}

test("a. all-id-less declaration with exactly matching content is repaired, not rejected", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  // Sama persis dengan C/A/B di phase4a5 — kini dipetakan ke t3/t1/t2.
  const out = await write(dir, [
    { content: "C", status: "in_progress" },
    { content: "A", status: "pending" },
    { content: "B", status: "pending" },
  ])
  const assignment = decodeCanonicalAssignments(out, { sessionId: S })
  expect(assignment?.map((a) => a.taskId)).toEqual(["t3", "t1", "t2"])
  expect(assignment?.every((a) => a.kind === "existing")).toBe(true)
  // Tak ada baris baru: t4 tak pernah dialokasikan.
  expect(
    rows(dir)
      .map((t) => t.id)
      .sort(),
  ).toEqual(["t1", "t2", "t3"])
  expect(store(dir).nextId(S)).toBe("t4")
  // Update benar-benar diterapkan pada task yang sudah ada.
  expect(rows(dir).find((t) => t.id === "t3")?.status).toBe("IN_PROGRESS")
})

test("a2. resume-style 7-item full redeclaration maps by stable content", async () => {
  const dir = await ownedDir()
  const content = Array.from({ length: 7 }, (_, i) => `langkah ${i + 1}`)
  seed(dir, content)
  const out = await write(
    dir,
    content.map((c, i) => ({
      content: c,
      status: i === 0 ? "completed" : i === 1 ? "in_progress" : "pending",
    })),
  )
  const assignment = decodeCanonicalAssignments(out, { sessionId: S })
  expect(assignment).toHaveLength(7)
  expect(assignment?.map((a) => a.taskId)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"])
  expect(rows(dir)).toHaveLength(7)
  expect(rows(dir).find((t) => t.id === "t1")?.status).toBe("COMPLETED")
  expect(rows(dir).find((t) => t.id === "t2")?.status).toBe("IN_PROGRESS")
})

test("b. conflicting content is still rejected with TASK_IDENTITY_REQUIRED", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = rows(dir).map((t) => `${t.id}:${t.title}:${t.revision}`)
  const err = (await write(dir, [
    { content: "A", status: "pending" },
    { content: "B", status: "pending" },
    { content: "item asing", status: "pending" },
  ]).catch((e) => e)) as TaskError
  expect(err).toBeInstanceOf(TaskError)
  expect(err.code).toBe("TASK_IDENTITY_REQUIRED")
  expect(err.message).toContain("todo_read")
  expect(rows(dir).map((t) => `${t.id}:${t.title}:${t.revision}`)).toEqual(before)
  expect(store(dir).nextId(S)).toBe("t4")
})

test("b2. a count mismatch is rejected — work is never silently dropped", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B", "C"])
  const before = rows(dir).map((t) => `${t.id}:${t.title}`)
  const err = (await write(dir, [
    { content: "A", status: "pending" },
    { content: "B", status: "pending" },
  ]).catch((e) => e)) as TaskError
  expect(err.code).toBe("TASK_IDENTITY_REQUIRED")
  expect(rows(dir).map((t) => `${t.id}:${t.title}`)).toEqual(before)
})

test("helper is fail-closed on unknown items but deterministic on duplicate titles", () => {
  const mk = (id: string, title: string): Task =>
    ({ id, title, order: Number(id.slice(1)) - 1 }) as Task
  expect(
    repairIdlessFullDeclaration(
      [{ content: "A", status: "pending" }],
      [mk("t1", "A"), mk("t2", "B")],
    ),
  ).toBeNull()
  const dup = repairIdlessFullDeclaration(
    [
      { content: "A", status: "completed" },
      { content: "A", status: "pending" },
    ],
    [mk("t1", "A"), mk("t2", "A")],
  )
  expect(dup?.map((t) => t.taskId)).toEqual(["t1", "t2"])
  // Payload yang sudah punya id tak pernah di-remap.
  expect(
    repairIdlessFullDeclaration(
      [{ content: "A", status: "pending", taskId: "t9" }],
      [mk("t1", "A")],
    ),
  ).toBeNull()
})

test("c. a genuinely new item in a mixed payload is still accepted as new", async () => {
  const dir = await ownedDir()
  seed(dir, ["A", "B"])
  const out = await write(dir, [
    { taskId: "t1", content: "A", status: "in_progress" },
    { content: "item baru", status: "pending" },
  ])
  const assignment = decodeCanonicalAssignments(out, { sessionId: S })
  expect(assignment?.map((a) => a.taskId)).toEqual(["t1", "t3"])
  expect(assignment?.map((a) => a.kind)).toEqual(["existing", "new"])
  expect(rows(dir).find((t) => t.id === "t3")?.title).toBe("item baru")
})

test("c2. a fresh session's all-id-less declaration is still adopted", async () => {
  const dir = await ownedDir()
  // Tanpa canonical task, guard tidak jalan: adopsi pertama tetap seperti dulu.
  const out = await write(dir, [
    { content: "pertama", status: "pending" },
    { content: "kedua", status: "pending" },
  ])
  expect(out).toContain("canonical-tasks")
  expect(rows(dir).map((t) => t.title)).toEqual(["pertama", "kedua"])
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2"])
})
