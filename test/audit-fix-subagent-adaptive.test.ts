// AUDIT-FIX — sub-agent robustness: timeout adaptif, heartbeat/liveness,
// kill seam per-anak, dan outcome `max_steps_exceeded`.
//
// Hermetik: tmpdir + fake factory (tanpa provider/jaringan asli). Watchdog
// dipercepat lewat seam konstanta (pola `audit-fix-subagent-self-title.test.ts`).

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import { LIMITS } from "../src/constants.ts"
import { resolveSubAgentTimeout, SUB_AGENT_TIMEOUT_MIN_MS } from "../src/policy/subagent-timeout.ts"
import { type JournalRecord, loadJournal } from "../src/session/journal.ts"
import { listSessionRuns } from "../src/session/persistence.ts"
import { childStatusOutcomeFlags } from "../src/session/verification.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-adaptive-"))
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

const ctxFor = (cwd: string, signal?: AbortSignal, emitted: unknown[] = []) =>
  ({
    signal: signal ?? new AbortController().signal,
    emit: (e: unknown) => {
      emitted.push(e)
    },
    cwd,
    permissionMode: "auto",
  }) as never

type MutableLimits = {
  SUB_AGENT_TIMEOUT_MS: number
  SUB_AGENT_HEARTBEAT_INTERVAL_MS: number
  SUB_AGENT_IDLE_BUDGET_CAP_MS: number
}
const mutableLimits = LIMITS as unknown as MutableLimits

// ── A. Policy murni ─────────────────────────────────────────────────────────

test("A1 tangga prompt: pendek 180s, sedang 300s, panjang 480s (basis default)", () => {
  const saved = mutableLimits.SUB_AGENT_TIMEOUT_MS
  mutableLimits.SUB_AGENT_TIMEOUT_MS = 300_000
  try {
    expect(resolveSubAgentTimeout({ promptLength: 100 })).toBe(180_000)
    expect(resolveSubAgentTimeout({ promptLength: 5_000 })).toBe(300_000)
    expect(resolveSubAgentTimeout({ promptLength: 20_000 })).toBe(480_000)
  } finally {
    mutableLimits.SUB_AGENT_TIMEOUT_MS = saved
  }
})

test("A2 prior sukses cepat memotong pagu maksimal 2x durasinya", () => {
  const saved = mutableLimits.SUB_AGENT_TIMEOUT_MS
  mutableLimits.SUB_AGENT_TIMEOUT_MS = 300_000
  try {
    const fast = resolveSubAgentTimeout({
      promptLength: 5_000,
      prior: { steps: 2, durationMs: 20_000, success: true },
    })
    expect(fast).toBe(40_000)
    // Sukses lambat atau gagal TIDAK memotong pagu.
    expect(
      resolveSubAgentTimeout({
        promptLength: 5_000,
        prior: { steps: 8, durationMs: 120_000, success: true },
      }),
    ).toBe(300_000)
    expect(
      resolveSubAgentTimeout({
        promptLength: 5_000,
        prior: { steps: 3, durationMs: 10_000, success: false },
      }),
    ).toBe(300_000)
    // 2x durasi sangat cepat tetap tak boleh turun di bawah lantai.
    expect(
      resolveSubAgentTimeout({
        promptLength: 5_000,
        prior: { steps: 1, durationMs: 1_000, success: true },
      }),
    ).toBe(SUB_AGENT_TIMEOUT_MIN_MS)
  } finally {
    mutableLimits.SUB_AGENT_TIMEOUT_MS = saved
  }
})

test("A3 explicit menang, invalid jatuh ke tangga, bounds selalu dihormati", () => {
  const saved = mutableLimits.SUB_AGENT_TIMEOUT_MS
  mutableLimits.SUB_AGENT_TIMEOUT_MS = 300_000
  try {
    expect(resolveSubAgentTimeout({ promptLength: 100, explicitMs: 450_000 })).toBe(450_000)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveSubAgentTimeout({ promptLength: 100, explicitMs: bad })).toBe(180_000)
    }
    expect(resolveSubAgentTimeout({ promptLength: 100, explicitMs: 1 })).toBe(
      SUB_AGENT_TIMEOUT_MIN_MS,
    )
    expect(
      resolveSubAgentTimeout({
        promptLength: 100,
        explicitMs: LIMITS.MAX_TIMER_DELAY_MS + 10_000,
      }),
    ).toBe(LIMITS.MAX_TIMER_DELAY_MS)
  } finally {
    mutableLimits.SUB_AGENT_TIMEOUT_MS = saved
  }
})

test("A4 env override jadi basis: tangga ikut naik, bukan menimpa", () => {
  const saved = mutableLimits.SUB_AGENT_TIMEOUT_MS
  mutableLimits.SUB_AGENT_TIMEOUT_MS = 900_000
  try {
    expect(resolveSubAgentTimeout({ promptLength: 5_000 })).toBe(900_000)
    expect(resolveSubAgentTimeout({ promptLength: 100 })).toBe(540_000)
    expect(resolveSubAgentTimeout({ promptLength: 20_000 })).toBe(1_440_000)
  } finally {
    mutableLimits.SUB_AGENT_TIMEOUT_MS = saved
  }
})

// ── B. Watchdog liveness ────────────────────────────────────────────────────

function fastWatchdog(interval: number, cap: number): () => void {
  const savedInterval = mutableLimits.SUB_AGENT_HEARTBEAT_INTERVAL_MS
  const savedCap = mutableLimits.SUB_AGENT_IDLE_BUDGET_CAP_MS
  mutableLimits.SUB_AGENT_HEARTBEAT_INTERVAL_MS = interval
  mutableLimits.SUB_AGENT_IDLE_BUDGET_CAP_MS = cap
  return () => {
    mutableLimits.SUB_AGENT_HEARTBEAT_INTERVAL_MS = savedInterval
    mutableLimits.SUB_AGENT_IDLE_BUDGET_CAP_MS = savedCap
  }
}

test("B1 anak diam di-abort watchdog, signal parent TAK tersentuh", async () => {
  const restoreEnv = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adaptive-b1"
  const restoreWatchdog = fastWatchdog(10, 30)
  const parent = new AbortController()
  const reasons: string[] = []
  let finishRun: (() => void) | undefined
  try {
    setSubAgentSessionFactory(async () => ({
      // Sengaja TANPA step event → dianggap diam.
      events: { on: () => () => {} },
      abort: (reason?: string) => {
        reasons.push(reason ?? "")
        finishRun?.()
      },
      run: async (_prompt, opts) => {
        await new Promise<void>((resolve) => {
          finishRun = resolve
          opts.signal.addEventListener("abort", () => resolve(), { once: true })
          setTimeout(resolve, 2_000) // pengaman agar test tak menggantung
        })
        throw new AgentError("aborted", "stalled")
      },
    }))
    const out = (await delegateTaskTool.execute(
      { prompt: "stall" },
      ctxFor(dir, parent.signal),
    )) as string
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons[0]).toBe("stalled")
    expect(parent.signal.aborted).toBe(false)
    expect(out).toContain("[sub-agent explore error]")
  } finally {
    restoreWatchdog()
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restoreEnv()
  }
})

test("B2 step event menyetel ulang watchdog: anak sehat tak di-abort", async () => {
  const restoreEnv = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adaptive-b2"
  // v7.44: jendela 30ms + heartbeat 10ms terlalu ketat di bawah beban
  // 6568 test ter-instrumentasi (timer drift → abort palsu). Cap 80ms tetap
  // JAUH di bawah durasi anak 200ms, jadi bila reset watchdog rusak test
  // ini GAGAL — asersi tidak dilonggarkan, hanya toleransi jitter dinaikkan.
  const restoreWatchdog = fastWatchdog(10, 80)
  let aborted = false
  try {
    setSubAgentSessionFactory(async () => {
      const handlers = new Map<string, Set<(e: never) => void>>()
      return {
        events: {
          on: (type: string, h: (e: never) => void) => {
            const set = handlers.get(type) ?? new Set<(e: never) => void>()
            set.add(h)
            handlers.set(type, set)
            return () => {
              set.delete(h)
            }
          },
        },
        abort: () => {
          aborted = true
        },
        run: async () => {
          const beat = setInterval(() => {
            for (const h of handlers.get("step:started") ?? []) h(undefined as never)
          }, 5)
          await new Promise((r) => setTimeout(r, 200))
          clearInterval(beat)
          return { finalText: "ok", usage: { steps: 3 } }
        },
      }
    })
    const out = (await delegateTaskTool.execute({ prompt: "healthy" }, ctxFor(dir))) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(aborted).toBe(false)
  } finally {
    restoreWatchdog()
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restoreEnv()
  }
})

test("B3 tanpa seam abort: watchdog diagnostik, tak crash, signal parent aman", async () => {
  const restoreEnv = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adaptive-b3"
  const restoreWatchdog = fastWatchdog(10, 30)
  const parent = new AbortController()
  const emitted: unknown[] = []
  try {
    setSubAgentSessionFactory(async () => ({
      events: { on: () => () => {} }, // diam, TANPA method abort
      run: async () => {
        await new Promise((r) => setTimeout(r, 120))
        return { finalText: "ok", usage: { steps: 1 } }
      },
    }))
    const out = (await delegateTaskTool.execute(
      { prompt: "no-seam" },
      ctxFor(dir, parent.signal, emitted),
    )) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(parent.signal.aborted).toBe(false)
    expect(
      emitted.some((e) => (e as { kind?: unknown })?.kind === "minicode:sub-agent-stall"),
    ).toBe(true)
  } finally {
    restoreWatchdog()
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restoreEnv()
  }
})

// ── C. Outcome max_steps_exceeded ───────────────────────────────────────────

test("C1 flag max_steps_exceeded = failure (bukan COMPLETED)", () => {
  expect(childStatusOutcomeFlags("max_steps_exceeded")).toEqual({ maxStepsExceeded: true })
  expect(childStatusOutcomeFlags("timeout")).toEqual({ timeout: true })
  expect(childStatusOutcomeFlags("aborted")).toEqual({ aborted: true })
  expect(childStatusOutcomeFlags("returned")).toEqual({})
})

test("C2 pesan parent memuat N/M & Run anak jadi INTERRUPTED", async () => {
  const restoreEnv = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "adaptive-c2"
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => {
          throw new AgentError("max_steps_exceeded", "exceeded 5 steps", {
            details: { steps: 5, maxSteps: 5 },
          })
        },
      }
    })
    const out = (await delegateTaskTool.execute(
      { prompt: "x", maxSteps: 5 },
      ctxFor(dir),
    )) as string
    expect(out).toContain("[sub-agent explore error] step limit reached (5/5)")
    const term = (await loadJournal(todoSession.id, dir)).records.filter(
      (r: JournalRecord) => r.tool === "delegate_task" && r.state === "committed",
    )
    expect(term).toHaveLength(1)
    expect(term[0]!.outcome?.childResult?.childStatus).toBe("max_steps_exceeded")
    const childId = seen[0]!.journal!.sessionId
    const runs = listSessionRuns(childId, dir)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe("INTERRUPTED")
    expect(runs[0]!.recovery_status).toBe("UNKNOWN")
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restoreEnv()
  }
})
