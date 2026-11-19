// Audit fix: SATU baris progres live selama turn (step.started / plan.updated).
// Fokus di sini adalah RANTAI event, bukan rendering TUI (diuji tui-app.test.ts):
// kernel step:started → DomainEvent durable → bridge → UiPresentationEvent.
// Hermetic: fake bus lokal, tanpa TTY/jaringan.

import { describe, expect, test } from "bun:test"
import { toPresentationEvent } from "../cli/bootstrap/presentation-bridge.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import { type DomainEvent, DURABILITY, type EventBusLike } from "../src/presentation/events.ts"
import { createInitialState, reduce } from "../src/presentation/reducer.ts"

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

function collect(adapter: ReturnType<typeof createPresentationAdapter>): DomainEvent[] {
  const out: DomainEvent[] = []
  adapter.onEvent((e) => out.push(e))
  return out
}

describe("live progress — rantai step.started", () => {
  test("adapter menerbitkan step.started durable dari step:started kernel", () => {
    const bus = fakeBus()
    const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
    const events = collect(adapter)

    bus.emit("turn:started", { turn: 1 })
    // Kernel mengirim indeks 0-based dan TIDAK punya `total` — jalur ini wajib
    // jujur (tanpa pecahan) alih-alih mengarang angka.
    bus.emit("step:started", { step: { index: 1, toolCalls: [], results: [] } })

    // Emit bus = sinkron; handler adapter langsung publish DomainEvent.
    const steps = events.filter((e) => e.type === "step.started")
    expect(steps).toHaveLength(1)
    const step = steps[0]
    expect(step?.type).toBe("step.started")
    expect(step).toMatchObject({ step: 1, sessionId: "s1", turnId: 1 })
    if (step?.type !== "step.started") throw new Error("unreachable")
    expect(step.total).toBeUndefined()
    expect(step.label).toBe("step 2") // 0-based → tampil 1-based
    expect(DURABILITY["step.started"]).toEqual({ durable: true, replayable: true })

    // Jalur dengan total (additive) tetap diteruskan apa adanya.
    bus.emit("step:started", { step: { index: 2, total: 5, toolCalls: [], results: [] } })
    const withTotal = events.filter((e) => e.type === "step.started").at(-1)
    expect(withTotal).toMatchObject({ step: 2, total: 5, label: "step 3/5" })
    adapter.dispose()
  })

  test("step informatif saja: tak mengubah konsentrasi tool/activities", () => {
    const bus = fakeBus()
    const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
    const events = collect(adapter)
    bus.emit("turn:started", { turn: 1 })
    bus.emit("step:started", { step: { index: 0, toolCalls: [], results: [] } })

    const state = createInitialState("s1")
    for (const e of events) reduce(state, e)

    // Durable → seq naik (cache snapshot UI ter-invalidasi), TANPA entry tool.
    const step = events.find((e) => e.type === "step.started")
    if (!step) throw new Error("step.started tidak terbit")
    expect(state.seq).toBe(step.eventSeq)
    expect(state.activities.size).toBe(0)
    adapter.dispose()
  })

  test("bridge memetakan step.started tanpa drop", () => {
    const bus = fakeBus()
    const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
    const events = collect(adapter)
    bus.emit("turn:started", { turn: 1 })
    bus.emit("step:started", { step: { index: 3, total: 7, toolCalls: [], results: [] } })
    const step = events.find((e) => e.type === "step.started")
    if (!step) throw new Error("step.started tidak terbit")

    const projected = toPresentationEvent(step)
    expect(projected).not.toBeNull()
    expect(projected?.type).toBe("step.started")
    expect(projected).toMatchObject({ step: 3, total: 7, sessionId: "s1" })
    adapter.dispose()
  })

  test("step.started bertahan di decode replay persistence (v7.27)", async () => {
    // Event durable yang tak bisa di-decode saat replay = baris hilang di resume.
    // decodePresentationEvent memakai isValidEventShape dengan default false.
    const raw = {
      eventSeq: 7,
      ts: 1000,
      sessionId: "s1",
      turnId: 1,
      v: 1,
      type: "step.started",
      step: 2,
      total: 5,
      label: "step 3/5",
    }
    // isValidEventShape adalah validator yang dipakai decodePresentationEvent;
    // test ini mengunci kontrak shape-nya lewat healthy vs corrupt variants.
    const { isValidEventShapeForTest } = await import("../src/session/persistence.ts")
    expect(isValidEventShapeForTest(raw)).toBe(true)
    expect(isValidEventShapeForTest({ ...raw, step: -1 })).toBe(false)
    expect(isValidEventShapeForTest({ ...raw, total: 0 })).toBe(false)
  })
})
