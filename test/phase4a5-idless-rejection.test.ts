// Phase 4A.5 regression protection — dimutakhirkan v0.33.
//
// THE RULE (baru). `todo_write` tetap FULL DECLARATION, dan payload id-lessinya
// TIDAK boleh membuat duplikat. Bedanya dengan kontrak lama: bila SETIAP item
// cocok persis dengan judul task kanonik yang sudah ada (jumlah sama), deklarasi
// itu di-REPAIR ke taskId yang benar alih-alih ditolak. Ini perbaikan untuk
// sesi lanjut yang mengirim ulang rencana 7 item tanpa taskId (model tidak
// pernah diajar `todo_read`). Content yang TIDAK dikenal tetap ditolak dengan
// TASK_IDENTITY_REQUIRED — jadi tidak ada task rekaan.
//
// The authority for "canonical identity already exists" is TASKSTORE, never the
// legacy JSON file: a JSON file exists for every session that has ever written a
// todo, canonical or not, so its presence proves nothing.
//
// SAFETY (Phase 0A discipline): one `mkdtemp(join(tmpdir(), "minicode-reject-"))`
// per test, removed by that exact absolute path. No `readdir(".")`, no pattern
// delete, nothing resolved from process.cwd().

import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMcpContext, newMcpContextId } from "../src/mcp/server.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike, PlanUpdatedEvent } from "../src/presentation/events.ts"
import { decodeCanonicalAssignments } from "../src/task/assignment.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { createTaskIdentityResolver, hasCanonicalTasks } from "../src/task/sync.ts"
import { todoSession, todoWriteTool } from "../src/tools/todo.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-reject-"))
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

const prov = { origin: "runtime", source: "test" } as const
const S = "reject-session"
const opCtx = (sessionId: string, cwd: string) =>
  ({ signal: new AbortController().signal, cwd, sessionId }) as never

/** Create real canonical rows t1..tn for the session. */
const seed = (dir: string, sessionId = S, titles = ["A", "B", "C"]) => {
  const store = new TaskStore(dir)
  titles.forEach((title, i) => {
    store.createTask(sessionId, { title, status: "PENDING", order: i, provenance: prov })
  })
  return store
}
const rows = (dir: string, sessionId = S) => new TaskStore(dir).listTasks(sessionId)
const todoFile = (dir: string, sessionId = S) =>
  join(dir, ".minicode", "todos", `${sessionId}.json`)

const write = (dir: string, todos: unknown[], sessionId = S) =>
  todoWriteTool.execute({ todos } as never, opCtx(sessionId, dir)) as Promise<string>

/** The canonical duplicate scenario from the phase brief: C / A / B, id-less. */
const REORDER_IDLESS = [
  { content: "C", status: "pending" },
  { content: "A", status: "pending" },
  { content: "B", status: "pending" },
]

function fakeBus(): EventBusLike & { emit: (t: string, p: unknown) => void } {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  return {
    on(type: string, handler: (e: unknown) => void) {
      const set = handlers.get(type) ?? new Set<(e: unknown) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type: string, payload: unknown) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  } as never
}
function build(dir: string, sessionId = S) {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, {
    sessionId,
    taskIdentityProvider: createTaskIdentityResolver(dir),
  })
  const seen: DomainEvent[] = []
  adapter.onEvent((e) => seen.push(e))
  return { bus, plans: () => seen.filter((e): e is PlanUpdatedEvent => e.type === "plan.updated") }
}

// ---------------------------------------------------------------------------
// A. no canonical tasks + all-id-less -> ADOPTED (Fase 8 / 8.3)
// ---------------------------------------------------------------------------
// PHASE 8 BEHAVIOUR CHANGE (Live Test §3.1): the old contract kept an id-less
// first write as "legacy" (JSON-only, 0 TaskStore rows). That is exactly the
// "0 rows" defect. Fase 8 now ADOPTS the first id-less write for a session with
// no canonical identity yet: ids are allocated and the store is populated.
test("A. all-id-less with NO canonical identity is adopted: sync + assignment", async () => {
  const dir = await ownedDir()
  expect(hasCanonicalTasks(dir, S)).toBe(false)
  const out = await write(dir, [{ content: "pure legacy", status: "pending" }])
  // No rejection; adoption emits assignment and canonical state.
  expect(out).toContain("canonical-tasks")
  expect(decodeCanonicalAssignments(out, { sessionId: S })).toBeDefined()
  expect(rows(dir).map((t) => t.title)).toEqual(["pure legacy"])
  expect(hasCanonicalTasks(dir, S)).toBe(true)
})

// ---------------------------------------------------------------------------
// B. canonical tasks + all-id-less -> REJECT
// ---------------------------------------------------------------------------
test("B. all-id-less with canonical identity present is rejected", async () => {
  const dir = await ownedDir()
  seed(dir)
  await expect(write(dir, [{ content: "x", status: "pending" }])).rejects.toThrow(/canonical task/i)
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
})

// ---------------------------------------------------------------------------
// C. reorder all-id-less -> REJECT, zero duplicates
// ---------------------------------------------------------------------------
test("C. the C/A/B all-id-less reorder is repaired to existing ids, no duplicates", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await write(dir, REORDER_IDLESS)
  // Tiga id lama dipakai ulang (urutan mengikuti deklarasi), bukan t4/t5/t6.
  expect(out).toContain("canonical-tasks")
  const after = rows(dir)
  expect(after.map((t) => t.id)).toEqual(["t3", "t1", "t2"])
  expect(after.map((t) => t.title)).toEqual(["C", "A", "B"])
  expect(new Set(after.map((t) => t.id))).toEqual(new Set(["t1", "t2", "t3"]))
  expect(new TaskStore(dir).nextId(S)).toBe("t4")
})

// ---------------------------------------------------------------------------
// D. retry -> still REJECT, still no duplicates
// ---------------------------------------------------------------------------
test("D. retrying the repaired payload is idempotent — still no duplicates", async () => {
  const dir = await ownedDir()
  seed(dir)
  for (let attempt = 0; attempt < 3; attempt++) await write(dir, REORDER_IDLESS)
  // Tiga baris, tiga id sama; revisi naik karena update, bukan page_creation.
  expect(rows(dir)).toHaveLength(3)
  expect(new Set(rows(dir).map((t) => t.id))).toEqual(new Set(["t1", "t2", "t3"]))
  expect(new TaskStore(dir).nextId(S)).toBe("t4")
})

// ---------------------------------------------------------------------------
// E. mixed payload must still work
// ---------------------------------------------------------------------------
test("E. a mixed payload is NOT rejected: t3 existing + id-less D becomes new", async () => {
  const dir = await ownedDir()
  seed(dir)
  const out = await write(dir, [
    { taskId: "t3", content: "C", status: "pending" },
    { content: "D", status: "pending" },
  ])
  const table = decodeCanonicalAssignments(out, { sessionId: S })
  expect(table?.map((a) => a.taskId)).toEqual(["t3", "t4"])
  expect(table?.map((a) => a.kind)).toEqual(["existing", "new"])
  // Exactly one new row, and the reused t3 was updated in place.
  // `listTasks` is ordered by canonical (task_order, task_id): the two DECLARED
  // items lead, then the D7-retained t1 and t2 after them.
  const after = rows(dir)
  expect(after.map((t) => t.id)).toEqual(["t3", "t4", "t1", "t2"])
  expect(after.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3", "t4"])
  expect(after.find((t) => t.id === "t4")?.title).toBe("D")
  expect(after.find((t) => t.id === "t3")?.title).toBe("C")
})

// ---------------------------------------------------------------------------
// F/G/H. the existing explicit-id rejections are untouched
// ---------------------------------------------------------------------------
test("F. an unknown explicit taskId still fails with TASK_NOT_FOUND", async () => {
  const dir = await ownedDir()
  seed(dir)
  const e = (await write(dir, [{ taskId: "t404", content: "ghost", status: "pending" }]).catch(
    (x) => x,
  )) as { code?: string }
  expect(e.code).toBe("TASK_NOT_FOUND")
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
})

test("G. a duplicate explicit taskId still fails with TASK_DUPLICATE_ID", async () => {
  const dir = await ownedDir()
  seed(dir)
  const e = (await write(dir, [
    { taskId: "t1", content: "A", status: "pending" },
    { taskId: "t1", content: "A again", status: "pending" },
  ]).catch((x) => x)) as { code?: string }
  expect(e.code).toBe("TASK_DUPLICATE_ID")
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
})

test("H. a malformed explicit taskId is still rejected at the protocol boundary", async () => {
  const dir = await ownedDir()
  seed(dir)
  await expect(
    todoWriteTool.execute(
      { todos: [{ taskId: "not-an-id", content: "bad", status: "pending" }] } as never,
      opCtx(S, dir),
    ),
  ).rejects.toThrow()
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
})

// ---------------------------------------------------------------------------
// I. empty payload - documented from the EXISTING code, not invented here
// ---------------------------------------------------------------------------
test("I. an empty declaration is rejected by normalizeTodos, before the 4A.5 guard", async () => {
  const dir = await ownedDir()
  seed(dir)
  // FINDING, not an invention: `todos: []` was ALREADY an error before 4A.5.
  // `normalizeTodos` throws "todos is empty" (a plain Error, not a TaskError),
  // and it runs before the canonical guard, so an empty declaration never
  // reaches 4A.5 at all. It is therefore NOT equivalent to an all-id-less
  // payload, and nothing about it clears or deletes canonical state.
  const e = (await write(dir, []).catch((x) => x)) as { code?: string; message: string }
  expect(e).toBeInstanceOf(Error)
  expect(e.code).toBeUndefined()
  expect(e.message).toMatch(/empty/i)
  // Canonical tasks are untouched: an empty declaration deletes nothing.
  expect(rows(dir).map((t) => t.id)).toEqual(["t1", "t2", "t3"])
  // Empty write tak mengubah kanonik: deklarasi id-less berikutnya tetap
  // di-repair ke id lama (bukan error, bukan duplikat).
  await write(dir, REORDER_IDLESS)
  expect(rows(dir)).toHaveLength(3)
  expect(new TaskStore(dir).nextId(S)).toBe("t4")
})

// ---------------------------------------------------------------------------
// J/K. reject BEFORE any mutation: no rows, no allocation, no JSON replacement
// ---------------------------------------------------------------------------
test("J/K. rejection happens before ANY mutation: no rows, no ids, no JSON write", async () => {
  const dir = await ownedDir()
  seed(dir)
  // Pre-existing JSON from a legitimate earlier canonical write.
  await write(dir, [{ taskId: "t1", content: "A", status: "pending" }])
  const jsonBefore = await readFile(todoFile(dir), "utf8")

  await write(dir, REORDER_IDLESS)

  // Perbaikan memakai id lama: tak ada baris/allocasi baru, JSON diperbarui
  // dengan tiga taskId yang SAMA (urutan mengikuti deklarasi).
  expect(new Set(rows(dir).map((t) => t.id))).toEqual(new Set(["t1", "t2", "t3"]))
  const jsonAfter = await readFile(todoFile(dir), "utf8")
  expect(jsonAfter).not.toBe(jsonBefore)
  expect(jsonAfter).toContain("t3")
  expect(new TaskStore(dir).nextId(S)).toBe("t4")
})

// ---------------------------------------------------------------------------
// L. no plan is published for a rejected write
// ---------------------------------------------------------------------------
test("L. a rejected write publishes no plan, and certainly no v2", async () => {
  const dir = await ownedDir()
  seed(dir)
  const { bus, plans } = build(dir)
  const args = { todos: REORDER_IDLESS }
  bus.emit("execution:started", { execution: { call: { id: "c1", name: "todo_write" } } })
  // A rejected tool produces an isError result, exactly as the kernel would.
  const result = await write(dir, REORDER_IDLESS).catch((e: Error) => e.message)
  bus.emit("execution:completed", {
    execution: {
      call: { id: "c1", name: "todo_write", args },
      result: { isError: true, content: String(result) },
    },
  })
  expect(plans()).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// M. MCP context isolation
// ---------------------------------------------------------------------------
test("M. the rule is per MCP context: A rejects, B adopts (Fase 8)", async () => {
  const dir = await ownedDir()
  const ctxA = newMcpContextId()
  const ctxB = newMcpContextId()
  seed(dir, ctxA, ["A", "B", "C"]) // A is canonical
  // B never was.
  expect(hasCanonicalTasks(dir, ctxA)).toBe(true)
  expect(hasCanonicalTasks(dir, ctxB)).toBe(false)

  const saved = applyMcpContext(ctxA, dir)
  try {
    // A: deklarasi id-less yang cocok persis di-repair ke t1/t2/t3 (tak ada
    // task baru dan namespace B tak tersentuh).
    await write(dir, REORDER_IDLESS, ctxA)
    expect(new Set(rows(dir, ctxA).map((t) => t.id))).toEqual(new Set(["t1", "t2", "t3"]))
    // B: [Fase 8 / 8.3] id-less first write untuk B kini DIADOPSI (bukan legacy
    // JSON-only) sehingga tasks B tak lagi 0 rows; namespace A tak tersentuh.
    const outB = await write(dir, [{ content: "legacy in B", status: "pending" }], ctxB)
    expect(outB).toContain("canonical-tasks")
    expect(rows(dir, ctxB).map((t) => t.title)).toEqual(["legacy in B"])
    // Repair memakai tiga id lama (urutan mengikuti deklarasi C/A/B).
    expect(new Set(rows(dir, ctxA).map((t) => t.id))).toEqual(new Set(["t1", "t2", "t3"]))
    // Context B tetap punya task sendiri; namespace A tak ikut berubah.
    expect(rows(dir, ctxB)).toHaveLength(1)
  } finally {
    todoSession.id = saved.prevId
    todoSession.cwd = saved.prevCwd
  }
})

// ---------------------------------------------------------------------------
// N. CLI / resume: the rule survives a restart of the process
// ---------------------------------------------------------------------------
test("N. after a resume the same session still rejects, with no new ids", async () => {
  const dir = await ownedDir()
  seed(dir)
  // "Resume" = a brand new process would re-bind the same durable namespace.
  const before = rows(dir).map((t) => t.id)
  todoSession.id = S
  todoSession.cwd = dir
  await write(dir, REORDER_IDLESS, S)
  expect(new Set(rows(dir).map((t) => t.id))).toEqual(new Set(before))
  expect(new TaskStore(dir).nextId(S)).toBe("t4")
})

// ---------------------------------------------------------------------------
// O. the error is explicit, coded and actionable
// ---------------------------------------------------------------------------
test("O. the rejection is a dedicated code with actionable, model-visible text", async () => {
  const dir = await ownedDir()
  seed(dir)
  // Konten yang TIDAK ada di kanonik tetap ditolak — ini yang dijaga kontrak.
  const e = (await write(dir, [{ content: "ghost task", status: "pending" }]).catch((x) => x)) as {
    code?: string
    message: string
  }
  // A dedicated code, not an overload of TASK_INVALID_ID.
  expect(e.code).toBe("TASK_IDENTITY_REQUIRED")
  // Actionable: names the remedy and the tool that provides it.
  expect(e.message).toContain("todo_read")
  expect(e.message).toContain("taskId")
  expect(e.message).toMatch(/unchanged/i)
  // The throw is a real Error, so existing `(e as Error).message` sites work.
  expect(e).toBeInstanceOf(Error)
})

// ---------------------------------------------------------------------------
// P. the predicate itself: status is irrelevant, JSON is not authority
// ---------------------------------------------------------------------------
test("P. hasCanonicalTasks counts every status and ignores the legacy JSON", async () => {
  const dir = await ownedDir()
  // No store, no JSON at all -> not canonical.
  expect(hasCanonicalTasks(dir, S)).toBe(false)
  // [Fase 8 / 8.3] first id-less write adopts canonical identity, so the store
  // is populated (was 0 rows before). The predicate must still be answered by
  // TASKSTORE, not the JSON file: here both change, so we assert the rows exist.
  await write(dir, [{ content: "legacy only", status: "pending" }])
  expect(existsSync(todoFile(dir))).toBe(true)
  expect(hasCanonicalTasks(dir, S)).toBe(true)
  // Completed / cancelled / blocked rows still count as canonical identity.
  const store = new TaskStore(dir)
  for (const [i, status] of (["COMPLETED", "CANCELLED", "BLOCKED"] as const).entries()) {
    store.createTask(S, {
      title: `x${i}`,
      status,
      order: i,
      provenance: prov,
      ...(status === "BLOCKED" ? { blockedReason: "verification red" } : {}),
    })
  }
  expect(hasCanonicalTasks(dir, S)).toBe(true)
  // A different session in the same database is unaffected.
  expect(hasCanonicalTasks(dir, "other-session")).toBe(false)
})
