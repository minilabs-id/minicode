// AUDIT-FIX — adaptivitas sub-agent "hidup": riwayat anak per-delegasi.
//
// Dua temuan MEDIUM yang diuji di sini:
//   1. Cabang `prior` di `resolveSubAgentTimeout` dulu MATI di produksi — tak
//      ada yang pernah mengisi `prior`. Kini riwayat anak terakhir (kunci
//      mode+prompt) diumpankan, memotong pagu saat anak terbukti sukses cepat.
//   2. `nextStepLimit` dulu hanya dipakai sesi UTAMA. Setiap delegate membuat
//      sesi anak baru, jadi anak yang mati `max_steps_exceeded` dan didelegasi
//      ulang mendapat cap yang SAMA. Kini kegagalan terakhir per kunci
//      menaikkan cap anak berikutnya (terklem 600), tanpa failure → tanpa naik.
//
// Hermetik: tmpdir + fake factory, tanpa provider/jaringan asli.

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import { LIMITS } from "../src/constants.ts"
import { resolveSubAgentTimeout, SUB_AGENT_TIMEOUT_MIN_MS } from "../src/policy/subagent-timeout.ts"
import {
  clearSubAgentHistory,
  clearSubAgentSessionFactory,
  delegateTaskTool,
  readSubAgentHistory,
  recordSubAgentHistory,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-adapt-hist-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  clearSubAgentSessionFactory()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function providerEnv(): () => void {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = savedAgent
  }
}

const ctxFor = (cwd: string) =>
  ({
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode: "auto",
  }) as never

// ── 1. Timeout adaptif dari prior ────────────────────────────────────────────

test("dua delegasi kunci sama: sukses cepat → timeout kedua lebih pendek (prior hidup)", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adapt-hist-timeout"
  clearSubAgentHistory()
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => {
          // Pastikan durasi > 0 ms supaya `boundedNumber` policy menerimanya,
          // tapi tetap jauh di bawah ambang "cepat" 60 detik.
          await Bun.sleep(5)
          return { finalText: "ok", usage: { steps: 3 } }
        },
      }
    })

    await delegateTaskTool.execute({ prompt: "prior-key" }, ctxFor(dir))
    await delegateTaskTool.execute({ prompt: "prior-key" }, ctxFor(dir))

    expect(seen).toHaveLength(2)
    const baseline = resolveSubAgentTimeout({ promptLength: "prior-key".length })
    // Pertama: riwayat kosong → tangga murni, tanpa pemotongan.
    expect(seen[0]!.timeoutMs).toBe(baseline)
    // Kedua: kunci sama, prior sukses+steps>0+cepat → policy memotong pagu.
    expect(seen[1]!.timeoutMs).toBeLessThan(seen[0]!.timeoutMs)
    expect(seen[1]!.timeoutMs).toBeGreaterThanOrEqual(SUB_AGENT_TIMEOUT_MIN_MS)
    // Tanpa kegagalan, cap TIDAK naik (tetap mengikuti inferScope dir = 40).
    expect(seen[1]!.maxSteps).toBe(40)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── 2. Eskalasi cap langkah per-delegasi ─────────────────────────────────────

test("max_steps_exceeded → cap naik di delegasi berikutnya; di ceiling berhenti", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adapt-hist-steps"
  clearSubAgentHistory()
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      const cap = spec.maxSteps
      return {
        events: { on: () => () => {} },
        run: async () => {
          // Simulasikan anak mentok tepat di cap yang diterimanya.
          throw new AgentError("max_steps_exceeded", "exceeded", {
            details: { steps: cap, maxSteps: cap },
          })
        },
      }
    })

    await delegateTaskTool.execute({ prompt: "steps-key" }, ctxFor(dir))
    expect(seen[0]!.maxSteps).toBe(40) // inferScope dir default

    await delegateTaskTool.execute({ prompt: "steps-key" }, ctxFor(dir))
    // Tangga KHUSUS sub-agent [24,40,64,100,150,250,400,600] — naik ke 64 lalu 100.
    expect(seen[1]!.maxSteps).toBe(64)
    expect(seen[1]!.maxSteps).toBeGreaterThan(seen[0]!.maxSteps)

    await delegateTaskTool.execute({ prompt: "steps-key" }, ctxFor(dir))
    expect(seen[2]!.maxSteps).toBe(100)

    // Parafrase prompt di scope sama tetap naik tangga (tidak reset ke 40).
    await delegateTaskTool.execute({ prompt: "steps-key-lanjutan-putaran-2" }, ctxFor(dir))
    expect(seen[3]!.maxSteps).toBe(150)

    // Terus naik sampai hard-cap 600, lalu BERHENTI (tak naik lagi).
    let last = seen[2]!.maxSteps
    for (let i = 0; i < 10; i++) {
      await delegateTaskTool.execute({ prompt: "steps-key" }, ctxFor(dir))
      const next = seen.at(-1)!.maxSteps
      expect(next).toBeGreaterThanOrEqual(last)
      expect(next).toBeLessThanOrEqual(LIMITS.SUB_AGENT_MAX_STEPS)
      last = next
    }
    expect(last).toBe(LIMITS.SUB_AGENT_MAX_STEPS)
    await delegateTaskTool.execute({ prompt: "steps-key" }, ctxFor(dir))
    expect(seen.at(-1)!.maxSteps).toBe(LIMITS.SUB_AGENT_MAX_STEPS)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

test("maxSteps eksplisit caller menang atas eskalasi riwayat", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adapt-hist-override"
  clearSubAgentHistory()
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      const cap = spec.maxSteps
      return {
        events: { on: () => () => {} },
        run: async () => {
          throw new AgentError("max_steps_exceeded", "exceeded", {
            details: { steps: cap, maxSteps: cap },
          })
        },
      }
    })

    await delegateTaskTool.execute({ prompt: "override-key" }, ctxFor(dir))
    // Riwayat sekarang berisi max_steps_exceeded → eskalasi akan memberi 50.
    // Tapi caller memberi 9 → niat sadar menang.
    await delegateTaskTool.execute({ prompt: "override-key", maxSteps: 9 }, ctxFor(dir))
    expect(seen[1]!.maxSteps).toBe(9)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── 3. Fallback saat riwayat absen/korup ─────────────────────────────────────

test("riwayat absen atau korup → fallback ke timeout/cap default, tanpa throw", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adapt-hist-fallback"
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 2 } }),
      }
    })

    // Absen: kunci belum pernah dipakai.
    clearSubAgentHistory()
    await delegateTaskTool.execute({ prompt: "absen-key" }, ctxFor(dir))
    expect(seen[0]!.timeoutMs).toBe(resolveSubAgentTimeout({ promptLength: "absen-key".length }))
    expect(seen[0]!.maxSteps).toBe(40)

    // Korup: steps = NaN ditolak readSubAgentHistory → anggap tak ada riwayat.
    clearSubAgentHistory()
    recordSubAgentHistory("explore:korup-key", {
      steps: Number.NaN,
      durationMs: 5,
      success: true,
    })
    expect(readSubAgentHistory("explore:korup-key")).toBeUndefined()
    await delegateTaskTool.execute({ prompt: "korup-key" }, ctxFor(dir))
    expect(seen[1]!.timeoutMs).toBe(resolveSubAgentTimeout({ promptLength: "korup-key".length }))
    expect(seen[1]!.maxSteps).toBe(40)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── 4. Eviksi bounded ────────────────────────────────────────────────────────

test("riwayat dibatasi 32 entri: yang terlama dieviksi, yang terbaru tetap ada", () => {
  clearSubAgentHistory()
  const total = 40
  for (let i = 0; i < total; i++)
    recordSubAgentHistory(`k${i}`, {
      steps: 1,
      durationMs: 5,
      success: true,
    })

  // Hitung yang masih terbaca → persis kap (32), bukan 40.
  let present = 0
  for (let i = 0; i < total; i++) if (readSubAgentHistory(`k${i}`)) present++
  expect(present).toBe(32)

  // 8 terlama hilang, yang terbaru masih ada.
  for (let i = 0; i < total - 32; i++) expect(readSubAgentHistory(`k${i}`)).toBeUndefined()
  expect(readSubAgentHistory(`k${total - 1}`)).toBeDefined()
})
