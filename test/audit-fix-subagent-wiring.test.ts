// Audit sub-agent wiring: empat cacat yang dikonfirmasi read-only.
//
//   1. Fan-out paralel 3 delegate_task dulu kehilangan parentsemua temuan awal
//      (heuristik "tepat satu pending"). Kini hint eksplisit child→parent.
//   2. Kegagalan anak pulang sebagai string sukses → tool.completed. Kontrak
//      direct-call sengaja dipertahankan (byte-identik), jadi adaptor yang
//      mengenali awalan failure summary dan memancarkan tool.failed.
//   3. Adapter/jurnal anak bocor saat turn:interrupted (abort/timeout).
//   4. Kunci riwayat FNV-1a 32-bit rawan tabrakan → dua seed + panjang.

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPresentationAdapter, disposeOnTerminal } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  delegationKey,
  type SubAgentSpec,
  setActiveDelegateCallId,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

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

function providerEnv(): () => void {
  const key = process.env.OPENAI_API_KEY
  const agent = process.env.AGENT_API_KEY
  if (!key && !agent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
    if (agent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = agent
  }
}

function started(callId: string, name: string, args: unknown = {}): Record<string, unknown> {
  return {
    type: "execution:started",
    execution: { call: { id: callId, name, args }, result: {} },
  }
}

afterEach(() => {
  clearSubAgentSessionFactory()
})

test("paralel 3 delegate_task: setiap finding punya parentToolCallId (hint eksplisit)", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "parent" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))

  // Tiga call induk pending BERSAMAAN — persis kondisi yang dulu memecah
  // resolveChildLink (pendingDelegateCalls.length === 3 → orphan).
  bus.emit("execution:started", started("dt_1", "delegate_task", { prompt: "a" }))
  bus.emit("execution:started", started("dt_2", "delegate_task", { prompt: "b" }))
  bus.emit("execution:started", started("dt_3", "delegate_task", { prompt: "c" }))

  // Hint yang dipancarkan task.ts saat tiap sesi anak lahir.
  const children: Array<[string, string]> = [
    ["sub_a", "dt_1"],
    ["sub_b", "dt_2"],
    ["sub_c", "dt_3"],
  ]
  for (const [childId, parentToolCallId] of children) {
    bus.emit("provider:extension", {
      type: "provider:extension",
      kind: "minicode:child-link",
      data: { forwardedChild: childId, parentToolCallId, childLabel: childId },
    })
  }
  // [FINDING] awal tiba sebelum anak selesai — dulu jadi yatim.
  for (const [childId] of children) {
    bus.emit("provider:extension", {
      type: "provider:extension",
      kind: "minicode:child-report",
      data: { forwardedChild: childId, finding: `temuan ${childId}`, needsEvaluation: true },
    })
  }

  const findings = events.filter((e) => e.type === "finding.detected")
  expect(findings).toHaveLength(3)
  for (const [childId, parentToolCallId] of children) {
    const f = findings.find((e) => e.type === "finding.detected" && e.sessionId === childId) as
      | Extract<DomainEvent, { type: "finding.detected" }>
      | undefined
    expect(f).toBeTruthy()
    expect(f?.parentLink?.parentToolCallId).toBe(parentToolCallId)
    expect(f?.parentLink?.childSessionId).toBe(childId)
    expect(f?.summary).toContain("[EVALUATE]")
  }
  // Taut eksplisit menggantikan fallback: tak ada anak yatim.
  expect(adapter.getDiagnostics().orphanChild).toBe(0)
  adapter.dispose()
})

test("task: hint child-link membawa id induk yang ditangkap sinkron di awal execute", async () => {
  const restore = providerEnv()
  const dir = mkdtempSync(join(tmpdir(), "mc-wiring-hint-"))
  const emitted: any[] = []
  // Tanpa adapter, set penunjuk langsung — menyamakan efeksaat kernel menemit
  // `execution:started` tepat sebelum `tool.execute` (satu tick sinkron).
  setActiveDelegateCallId("dt_capture")
  const factory = async (spec: SubAgentSpec) => ({
    events: { on: () => () => {} },
    run: async () => ({
      finalText: "ok",
      usage: { steps: 1, turns: 1, inputTokens: 0, outputTokens: 0 },
    }),
    sessionId: spec.sessionId,
  })
  setSubAgentSessionFactory(factory as never)
  try {
    await delegateTaskTool.execute({ prompt: "captured parent", mode: "explore" }, {
      signal: new AbortController().signal,
      cwd: dir,
      emit: (e: unknown) => emitted.push(e),
    } as never)
    const hints = emitted.filter((e) => e?.kind === "minicode:child-link")
    expect(hints).toHaveLength(1)
    expect(hints[0]?.data?.parentToolCallId).toBe("dt_capture")
    expect(typeof hints[0]?.data?.forwardedChild).toBe("string")
    expect(hints[0]?.data?.forwardedChild).toBeTruthy()
  } finally {
    restore()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("delegate gagal/timeout → tool.failed, bukan tool.completed (string tetap byte-identik)", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "parent" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))

  const failure = "[sub-agent explore error] step limit reached (5/5)"
  bus.emit("execution:started", started("dt_fail", "delegate_task", { prompt: "x" }))
  bus.emit("execution:completed", {
    type: "execution:completed",
    execution: {
      call: { id: "dt_fail", name: "delegate_task", args: {} },
      result: { isError: false, content: failure },
    },
  })
  // Dua format failure lain yang dipancarkan task.ts.
  bus.emit("execution:started", started("dt_err", "delegate_task", { prompt: "y" }))
  bus.emit("execution:completed", {
    type: "execution:completed",
    execution: {
      call: { id: "dt_err", name: "delegate_task", args: {} },
      result: { isError: false, content: "[sub-agent error] session factory not configured" },
    },
  })
  // Jalur sukses TIDAK boleh ikut terkena.
  bus.emit("execution:started", started("dt_ok", "delegate_task", { prompt: "z" }))
  bus.emit("execution:completed", {
    type: "execution:completed",
    execution: {
      call: { id: "dt_ok", name: "delegate_task", args: {} },
      result: { isError: false, content: "sub-agent (explore) done: all clear [steps 2]" },
    },
  })

  const failed = events.filter(
    (e) => e.type === "tool.failed" && (e.toolCallId === "dt_fail" || e.toolCallId === "dt_err"),
  )
  expect(failed).toHaveLength(2)
  expect(failed.every((e) => e.type === "tool.failed" && e.cause === "agent")).toBe(true)
  expect(events.some((e) => e.type === "tool.completed" && e.toolCallId === "dt_fail")).toBe(false)
  expect(events.some((e) => e.type === "tool.completed" && e.toolCallId === "dt_err")).toBe(false)
  expect(events.some((e) => e.type === "tool.completed" && e.toolCallId === "dt_ok")).toBe(true)
  adapter.dispose()
})

test("child adapter dibuang pada turn:interrupted dan idempoten", () => {
  const bus = fakeBus()
  let disposed = 0
  const stop = disposeOnTerminal(bus, () => {
    disposed++
  })

  // Kernel memancarkan interrupted pada abort/timeout, TANPA completed.
  bus.emit("turn:interrupted", {})
  expect(disposed).toBe(1)
  bus.emit("turn:completed", {})
  bus.emit("turn:failed", {})
  expect(disposed).toBe(1)

  // Terminal lain duluan juga idempoten, dan stop() langsung aman dipanggil.
  const bus2 = fakeBus()
  let disposed2 = 0
  const stop2 = disposeOnTerminal(bus2, () => {
    disposed2++
  })
  bus2.emit("turn:completed", {})
  bus2.emit("turn:interrupted", {})
  expect(disposed2).toBe(1)
  stop2()
  bus2.emit("turn:interrupted", {})
  expect(disposed2).toBe(1)
  stop()
})

test("delegationKey beda untuk ekor/awalan sama (64 char) dan panjang beda", () => {
  const prefix = "q".repeat(64)
  const a = delegationKey("explore", `${prefix}AAAAAAAA`)
  const b = delegationKey("explore", `${prefix}BBBBBBBB`)
  expect(a).not.toBe(b)

  // Lipatan panjang: dua seed saja masih bisa tabrakan, panjang mengunci.
  const short = delegationKey("explore", `${prefix}A`)
  const long = delegationKey("explore", `${prefix}AA`)
  expect(short).not.toBe(long)

  expect(delegationKey("explore", "same")).toBe(delegationKey("explore", "same"))
  expect(delegationKey("plan", "same")).not.toBe(delegationKey("explore", "same"))
  // Tak menyimpan prompt mentah (bisa berisi data sensitif).
  expect(delegationKey("explore", "super-secret-token-xyz")).not.toContain("secret")
  expect(delegationKey("explore", "super-secret-token-xyz")).not.toContain("token")
})
