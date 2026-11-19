// AUDIT-FIX — sub-agent robustness & human-readable names.
//
// Dua temuan yang diuji di sini:
//   1. "turn exceeded 120000ms" pada 5-way fan-out → default timeout naik jadi
//      300s, bisa di-override per delegate, env-overridable, dan teks partial
//      tidak lagi terbuang saat timeout.
//   2. Marker ledger `run_<8>`/`sub_<8>` tak bermakna → label manusiawi
//      (`explore-1`, `plan-2`, atau nama caller) dibawa end-to-end.
//
// Hermetik: tmpdir, fake factory + fake bus, tanpa provider/jaringan asli.

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError } from "#minicore/core/errors.ts"
import { LIMITS } from "../src/constants.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike, ToolStartedEvent } from "../src/presentation/events.ts"
import { type JournalRecord, loadJournal } from "../src/session/journal.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-audit-sub-"))
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

const ctxFor = (cwd: string, permissionMode = "auto") =>
  ({
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode,
  }) as never

// Handler mengikuti kontrak `SubAgentSession.events.on` (event: never).
type Handler = (e: never) => void

/** Factory yang memancarkan event dari dalam run() lalu melempar timeout. */
function emittingFactory(seen: SubAgentSpec[]) {
  return async (spec: SubAgentSpec) => {
    seen.push(spec)
    const handlers = new Map<string, Set<Handler>>()
    return {
      events: {
        on: (type: string, h: Handler) => {
          const set = handlers.get(type) ?? new Set<Handler>()
          set.add(h)
          handlers.set(type, set)
          return () => {
            set.delete(h)
          }
        },
      },
      run: async () => {
        const fire = (type: string, e: unknown) => {
          for (const h of handlers.get(type) ?? []) h(e as never)
        }
        // Provider text + extension text = jawaban yang sempat mengalir.
        fire("provider:text", { type: "provider:text", text: "partial answer " })
        fire("provider:extension", {
          type: "provider:extension",
          kind: "text",
          data: { text: "from extension" },
        })
        // reasoning = pikiran privat, tak boleh ikut ke pesan error parent.
        fire("provider:extension", {
          type: "provider:extension",
          kind: "reasoning",
          data: { text: "RAHASIA" },
        })
        throw new AgentError("timeout", "child turn timed out")
      },
    }
  }
}

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

// ── A. Konstanta & derivasi ─────────────────────────────────────────────────

test("A1 default timeout dinaikkan & lease tetap 2.5x (turunan, bukan angka lepas)", () => {
  // Env bisa meng-override; yang dijamin = minimal 300s dan lease 2.5x-nya.
  expect(LIMITS.SUB_AGENT_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000)
  expect(LIMITS.SUB_AGENT_TIMEOUT_MS).toBeLessThanOrEqual(LIMITS.MAX_TIMER_DELAY_MS)
  expect(SESSION_LEASE_MS).toBe(Math.ceil(LIMITS.SUB_AGENT_TIMEOUT_MS * 2.5))
  if (!process.env.MINICODE_SUB_AGENT_POOL_SIZE) expect(LIMITS.SUB_AGENT_POOL_SIZE).toBe(3)
})

// ── B. Timeout + partial text ───────────────────────────────────────────────

test("B1 timeout menyelamatkan partial text ke string parent & receipt, status/ACE utuh", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "audit-sub-b1"
  try {
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(emittingFactory(seen))
    const out = (await delegateTaskTool.execute({ prompt: "scan" }, ctxFor(dir))) as string
    // Status & kontrak string lama tetap ada; partial ditambahkan di belakang.
    expect(out).toContain("[sub-agent explore error] child turn timed out")
    expect(out).toContain("partial: partial answer from extension")
    expect(out).not.toContain("RAHASIA") // reasoning tak bocor

    const term = (await loadJournal(todoSession.id, dir)).records.filter(
      (r: JournalRecord) => r.tool === "delegate_task" && r.state === "committed",
    )
    expect(term).toHaveLength(1)
    const env = term[0]!.outcome?.childResult
    expect(env?.childStatus).toBe("timeout")
    expect(env?.resultSummary).toContain("partial: partial answer from extension")
    expect(env?.aceVerdict?.verdict === "FAIL" || env?.aceVerdict?.verdict === "BLOCKED").toBe(true)
    // Timeout = turn dipotong → Run INTERRUPTED, bukan COMPLETED.
    expect(term[0]!.outcome?.timeout).toBe(true)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── C. 5-way fan-out: label + timeout per caller ────────────────────────────

test("C1 lima delegate paralel dapat label explore-N unik & timeout masing-masing", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "audit-sub-c1"
  try {
    const seen: SubAgentSpec[] = []
    // Factory instan; pool (default 3) mengantre 2 anak tanpa mengubah timeout.
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const timeouts = [180_000, 210_000, 240_000, 270_000, 300_000]
    await Promise.all(
      timeouts.map((timeoutMs) =>
        delegateTaskTool.execute({ prompt: "scan", mode: "explore", timeoutMs }, ctxFor(dir)),
      ),
    )
    expect(seen).toHaveLength(5)
    const nums = seen.map((s) => {
      expect(s.label).toMatch(/^explore-\d+$/)
      return Number(s.label!.slice("explore-".length))
    })
    expect(new Set(nums).size).toBe(5)
    expect(Math.max(...nums) - Math.min(...nums)).toBe(4)
    expect(seen.map((s) => s.timeoutMs).sort((a, b) => a - b)).toEqual(
      [...timeouts].sort((a, b) => a - b),
    )
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── D. Label mengalir ke presentation adapter ──────────────────────────────

test("D1 childLabel dari event forward masuk ke parentLink.label di tool.started", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "parent-1" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))
  bus.emit("execution:started", {
    execution: { call: { id: "dt_1", name: "delegate_task", args: {} }, result: {} },
  })
  bus.emit("execution:started", {
    execution: { call: { id: "child_1", name: "read_file", args: { path: "a.ts" } }, result: {} },
    forwardedChild: "sub_aa11",
    childRunId: "run_abcdef01",
    childLabel: "explore-1",
  })
  const started = events.find(
    (e): e is ToolStartedEvent => e.type === "tool.started" && e.toolCallId === "child_1",
  )
  expect(started?.parentLink?.label).toBe("explore-1")
  expect(started?.parentLink?.runId).toBe("run_abcdef01")
  adapter.dispose()
})

// ── E. Self-title gagal → fail-soft ─────────────────────────────────────────

test("E1 judul gagal: nama sementara eksplisit tetap, tanpa event judul", async () => {
  const restore = providerEnv()
  const dir = tmpRoot()
  const prevTodo = todoSession.id
  todoSession.id = "audit-sub-e1"
  const emitted: Array<{ kind?: unknown }> = []
  const seen: SubAgentSpec[] = []
  try {
    setSubAgentSessionFactory(async (spec) => {
      seen.push(spec)
      // Router dipakai anak; provider judulnya sengaja gagal.
      const router = spec.provider as {
        updateProviders?: (
          list: Array<{
            id: string
            models: string[]
            stream: () => AsyncIterable<never>
          }>,
        ) => void
      }
      router.updateProviders?.([
        {
          id: "broken-title",
          models: ["broken-title"],
          // Provider sengaja gagal sebelum menghasilkan token apa pun.
          // biome-ignore lint/correctness/useYield: kegagalan memang di titik ini
          async *stream() {
            throw new Error("title provider down")
          },
        },
      ])
      return {
        events: { on: () => () => {} },
        run: async () => {
          await new Promise((r) => setTimeout(r, 60))
          return { finalText: "ok", usage: { steps: 1 } }
        },
      }
    })
    const ctx = {
      signal: new AbortController().signal,
      emit: (e: { kind?: unknown }) => {
        emitted.push(e)
      },
      cwd: dir,
      permissionMode: "auto",
    } as never
    const out = (await delegateTaskTool.execute(
      { prompt: "scan", name: "custom-name" },
      ctx,
    )) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(seen[0]!.label).toBe("custom-name")
    expect(emitted.some((e) => e.kind === "minicode:child-label")).toBe(false)
  } finally {
    todoSession.id = prevTodo
    clearSubAgentSessionFactory()
    restore()
  }
})
