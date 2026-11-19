// [AUDIT v7.40] Pinjaman kontrak untuk empat bug terkonfirmasi di lapisan
// app/task/runtime. Komentar menjelaskan MENGAPA pagar/filter/terjemahan ini
// ada, supaya perubahan berikutnya tidak mengembalikan perilaku lama.
//
//  1. sync.ts   — todo_write tidak boleh membebaskan ownership eksekusi live
//                (COMPLETED/CANCELLED/BLOCKED/PENDING) milik Scheduler.
//  2. scheduler — stop saat dispatch gagal tak boleh sama dengan hand-off sukses.
//  3. execution-backend — docker harus meneruskan AbortSignal; exit bukan nol
//                wajib jadi observasi gagal (parity result-envelope tools).
//  4. session   — liveToolSchemas harus membuang hiddenWireTools seperti stream().
//
// SAFETY: satu mkdtemp per test, dihapus lewat path absolutnya sendiri.

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateTools } from "#minicore/core/tokens.ts"
import { visibleWireToolSchemas } from "../src/app/session.ts"
import { minicodeEstimator } from "../src/policy/context.ts"
import {
  dockerRunOptionsFromRequest,
  shimCompletionToObservation,
} from "../src/runtime/execution-backend.ts"
import { TaskError } from "../src/task/model.ts"
import { Scheduler, type SchedulerEvent, type SchedulerWorkItem } from "../src/task/scheduler.ts"
import { resetSessionOwnershipForTests } from "../src/task/session-ownership.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { synchronizeCanonicalTasks } from "../src/task/sync.ts"

const owned: string[] = []
async function ownedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mc-audit-deep-app-task-"))
  owned.push(dir)
  return dir
}
afterEach(async () => {
  resetSessionOwnershipForTests()
  try {
    resetTaskStoreHandles()
  } catch {}
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

const S = "audit-deep-app-task"
const prov = { origin: "runtime", source: "audit-deep-app-task" } as const

// ── FIX 1: pagar authority sinkronisasi todo_write ───────────────────────────

test("FIX1: task live milik Scheduler — PENDING/COMPLETED/CANCELLED/BLOCKED ditolak", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const t = store.createTask(S, { title: "A", status: "PENDING", order: 0, provenance: prov })
  const claim = store.claimTask(S, t.id, t.revision)
  expect(claim.outcome).toBe("CLAIM_ACCEPTED")
  // Pra-syarat: status live dan kepemilikan scheduler benar-benar terpasang.
  expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
  expect(store.getExecutionOwnership(S, t.id)?.executionOwner).toBe("scheduler")
  const claimedRevision = store.getTask(S, t.id)!.revision

  // patchTask (store.ts) mengosongkan execution_owner saat status keluar dari
  // IN_PROGRESS/VERIFYING. TASK_EDGES mengizinkan semua target ini, jadi tanpa
  // pagar yang diperluas masing-masing akan meng-yatim-kan eksekusi live.
  for (const status of ["pending", "completed", "cancelled", "blocked"] as const) {
    let code: string | undefined
    try {
      synchronizeCanonicalTasks({
        cwd: dir,
        sessionId: S,
        declared: [{ taskId: t.id, title: "A", status }],
      })
    } catch (e) {
      code = e instanceof TaskError ? e.code : undefined
    }
    expect(code, `target ${status} wajib ditolak`).toBe("TASK_AUTHORITY_VIOLATION")
    // Fail-closed: pagar melempar SEBELUM patch → status, revisi, owner utuh.
    expect(store.getTask(S, t.id)?.status).toBe("IN_PROGRESS")
    expect(store.getTask(S, t.id)?.revision).toBe(claimedRevision)
    expect(store.getExecutionOwnership(S, t.id)?.executionOwner).toBe("scheduler")
  }
})

test("FIX1: target yang TIDAK melepaskan ownership (in_progress) tetap diizinkan", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const t = store.createTask(S, { title: "A", status: "PENDING", order: 0, provenance: prov })
  expect(store.claimTask(S, t.id, t.revision).outcome).toBe("CLAIM_ACCEPTED")

  // IN_PROGRESS ada di RECONCILABLE_STATUSES: cursor plan agent, bukan akhir
  // eksekusi. Pagar tidak boleh menolak self-loop ini.
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [{ taskId: t.id, title: "A", status: "in_progress" }],
    }),
  ).not.toThrow()
  expect(store.getExecutionOwnership(S, t.id)?.executionOwner).toBe("scheduler")
})

test("FIX1: task tanpa owner scheduler boleh dinyatakan completed", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  const t = store.createTask(S, { title: "A", status: "PENDING", order: 0, provenance: prov })

  // Pagar hanya untuk klaim live. Task PENDING biasa (owner null) tidak terkunci.
  expect(() =>
    synchronizeCanonicalTasks({
      cwd: dir,
      sessionId: S,
      declared: [{ taskId: t.id, title: "A", status: "completed" }],
    }),
  ).not.toThrow()
  expect(store.getTask(S, t.id)?.status).toBe("COMPLETED")
})

// ── FIX 2: stop reason saat dispatch gagal ───────────────────────────────────

function schedulerHarness(runTurn: (w: SchedulerWorkItem) => never, store: TaskStore) {
  const events: SchedulerEvent[] = []
  const sc = new Scheduler(S, {
    store,
    runTurn,
    instruction: "do the work",
    onEvent: (e) => events.push(e),
  })
  return { sc, events }
}

test("FIX2: bridge melempar → stop = dispatch-failed (bukan already-dispatched)", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, { title: "A", status: "PENDING", order: 0, provenance: prov })

  const { sc } = schedulerHarness(() => {
    throw new Error("bridge down")
  }, store)
  sc.start()
  try {
    const result = await sc.cycle()
    expect(result.stop).toBe("dispatch-failed")
    expect(result.dispatched?.ok).toBe(false)
    expect(result.dispatched?.failure).toBe("bridge-threw")
  } finally {
    await sc.stop()
  }
})

test("FIX2: hand-off sukses tetap already-dispatched", async () => {
  const dir = await ownedDir()
  const store = new TaskStore(dir)
  store.createTask(S, { title: "A", status: "PENDING", order: 0, provenance: prov })

  const events: SchedulerEvent[] = []
  const sc = new Scheduler(S, {
    store,
    runTurn: () => ({ kind: "returned", ok: true }),
    instruction: "do the work",
    onEvent: (e) => events.push(e),
  })
  sc.start()
  try {
    const result = await sc.cycle()
    expect(result.stop).toBe("already-dispatched")
    expect(result.dispatched?.ok).toBe(true)
  } finally {
    await sc.stop()
  }
})

// ── FIX 3: execution-backend sandbox shim ────────────────────────────────────

test("FIX3: dockerRunOptionsFromRequest meneruskan AbortSignal", () => {
  const ac = new AbortController()
  const opts = dockerRunOptionsFromRequest({
    cmd: "x",
    signal: ac.signal,
    timeoutMs: 1234,
    env: { KEY: "val" },
  })
  // start() shim menunggu penuh; satu-satunya cancel mid-flight adalah signal
  // yang diteruskan ke runner. bwrap/seatbelt sudah melakukannya, docker dulu tidak.
  expect(opts.signal).toBe(ac.signal)
  expect(opts.timeoutMs).toBe(1234)
  expect(opts.env).toEqual({ KEY: "val" })

  const tanpa = dockerRunOptionsFromRequest({ cmd: "x" })
  expect("signal" in tanpa).toBe(false)
})

test("FIX3: exit code bukan nol jadi observasi failed (parity isError)", () => {
  // Runner run-to-completion yang gagal TIDAK boleh dilaporkan "exited" —
  // kalau tidak, result-envelope tools kehilangan penanda isError.
  expect(shimCompletionToObservation(0, "ok")).toEqual({ status: "exited", exitCode: 0 })
  expect(shimCompletionToObservation(null, "")).toEqual({ status: "exited", exitCode: null })
  expect(shimCompletionToObservation(7, "boom")).toEqual({
    status: "failed",
    exitCode: 7,
    error: "boom",
  })
  expect(shimCompletionToObservation(-1, "killed by signal").status).toBe("failed")
})

// ── FIX 4: liveToolSchemas menyaring hiddenWireTools ─────────────────────────

type WireTool = Parameters<typeof estimateTools>[0][number]

test("FIX4: estimasi wire berubah HANYA untuk tool yang disembunyikan", () => {
  const tools: WireTool[] = [
    { name: "bash", description: "shell", parameters: { type: "object" } },
    { name: "read", description: "read file", parameters: { type: "object" } },
    { name: "code_run", description: "run code", parameters: { type: "object" } },
    { name: "mcp_github", description: "github", parameters: { type: "object" } },
    { name: "ask_user", description: "ask", parameters: { type: "object" } },
  ]
  const hidden = new Set(["code_run", "mcp_github", "ask_user"])

  // Tanpa hidden set: tidak ada tool yang gugur (perilaku lama dipertahankan).
  expect(visibleWireToolSchemas(tools).map((t) => t.name)).toEqual(tools.map((t) => t.name))
  expect(visibleWireToolSchemas(tools, new Set()).map((t) => t.name)).toEqual(
    tools.map((t) => t.name),
  )

  const visible = visibleWireToolSchemas(tools, hidden)
  expect(visible.map((t) => t.name)).toEqual(["bash", "read"])

  // stream() memakai filter yang sama; endpoint token estimate dulu over-count.
  const fullTokens = estimateTools(visibleWireToolSchemas(tools), minicodeEstimator)
  const visibleTokens = estimateTools(visible, minicodeEstimator)
  const hiddenOnly = tools.filter((t) => hidden.has(t.name))
  const hiddenTokens = estimateTools(hiddenOnly, minicodeEstimator)
  expect(visibleTokens).toBe(fullTokens - hiddenTokens)
  expect(visibleTokens).toBeLessThan(fullTokens)
})
