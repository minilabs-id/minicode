// v0.43 — `/copy` menyalin YANG TERENDER (narasi + rekap), bukan buffer tool output.
//
// Dua lapis yang diuji:
//  1. `Transcript.copyTurnTexts()` — unit, grup per turn & filter baris.
//  2. `runTui` + fake TTY — payload OSC 52 hasil decode base64, urutan grup,
//     dan pembuktian bahwa `#lastTurnText` (tool output mentah) tak dipakai.

import { afterEach, describe, expect, test } from "bun:test"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
let detachLogger: (() => void) | null = null
let runP: Promise<void> | null = null

afterEach(async () => {
  if (tty && runP) {
    try {
      await tty.send("\x15/exit")
      await tty.send(KEY.enter)
      await runP
    } catch {}
  }
  detachLogger?.()
  detachLogger = null
  tty?.restore()
  tty = null
  runP = null
})

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    target: "a.ts",
    status: "completed",
    tsStart: Date.now(),
    ...overrides,
  }
}

type Emit = (type: string, payload: Record<string, unknown>) => void

/** Transcript dengan bus live DAN kanal presentation event, memakai activities mutable. */
function setupCopy(activities: UiPresentationActivity[]) {
  const bus = createFakeBus()
  let handler: ((event: never) => void) | undefined
  const snapshot: UiPresentationSnapshot = { activities, turns: [] }
  const t = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    onPresentationEvent: (next) => {
      handler = next as (event: never) => void
      return () => {
        handler = undefined
      }
    },
  })
  const emit: Emit = (type, payload) => handler?.({ type, ...payload } as never)
  return { t, bus, emit }
}

function decodeOsc52(out: string): string {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  const m = new RegExp(`${ESC}\\]52;c;([A-Za-z0-9+/=]+)${BEL}`).exec(out)
  if (!m) throw new Error("payload OSC 52 tidak ditemukan")
  return Buffer.from(m[1]!, "base64").toString("utf8")
}

type TestSession = CliSession & { bus: ReturnType<typeof createFakeBus> }

function fakeSession(uiState: UiSessionState): TestSession {
  const bus = createFakeBus()
  const noop = async () => {}
  return {
    bus,
    uiState,
    session: { events: bus, contextTokens: 0 },
    cfg: { providers: [] },
    cwd: process.cwd(),
    sessionId: "copy-test",
    modelRef: {},
    permissionMode: "auto",
    permissions: undefined,
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    usage: {
      get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      modelUsed: () => ({}),
      reset: () => {},
    },
    budget: undefined,
    budgetStrict: false,
    persistCurrent: noop,
    runPromptWithVerify: noop,
    close: noop,
  } as unknown as TestSession
}

async function startTui(s: TestSession): Promise<void> {
  tty = installFakeTty({ columns: 100, rows: 30 })
  runP = runTui(s)
  await tty.ready()
  await tty.waitForOutput((o) => o.includes("00.00.00"))
}

describe("v0.43 — copyTurnTexts: narasi + rekap saja", () => {
  test("turn terakhir: narasi & rekap ikut, gema/ledger/diagnostic tidak", () => {
    const acts = [activity({ toolCallId: "c1", name: "read_file", target: "a.ts" })]
    const { t, bus, emit } = setupCopy(acts)

    t.pushUser("pertanyaan satu")
    bus.emit("provider:text", { text: "Narasi SATU" })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    bus.emit("turn:completed", {})

    t.pushUser("pertanyaan dua")
    bus.emit("provider:text", { text: "Narasi DUA" })
    // toolCallId beda: `presentedTerminals` dedup per id, bukan per turn.
    acts.push(
      activity({
        toolCallId: "c2",
        name: "read_file",
        target: "a.ts",
        status: "failed",
      }),
    )
    emit("tool.failed", {
      seq: 2,
      turnId: 2,
      toolCallId: "c2",
      status: "failed",
      message: "duplicate idempotency key abc-123",
    })
    // Diagnostic tak boleh ikut tersalin walau tampil di transkrip.
    emit("finding.detected", { findingId: "f1", text: "[EVALUATE] temuan rahasia" })
    bus.emit("turn:completed", {})

    const turns = t.copyTurnTexts(1)
    expect(turns).toHaveLength(1)
    const payload = turns[0]!
    expect(payload).toContain("Narasi DUA")
    expect(payload).not.toContain("Narasi SATU")
    expect(payload).not.toContain("minicode")
    expect(payload).not.toContain("pertanyaan dua")
    expect(payload).not.toContain("›")
    expect(payload).not.toContain("duplicate idempotency key")
    expect(payload).not.toContain("EVALUATE")
    expect(payload).not.toContain("\x1b")
    // Rekap (baris kategori) tetap bagian dari laporan.
    expect(payload).toMatch(/\d+\s+\p{L}/u)
  })

  test("2 turn terakhir urut oldest→newest; count di-clamp ke MAX_COPY_TURNS", () => {
    const { t, bus } = setupCopy([])
    for (const [i, text] of ["satu", "dua", "tiga"].entries()) {
      t.pushUser(`prompt ${i + 1}`)
      bus.emit("provider:text", { text: `Narasi ${text}` })
      bus.emit("turn:completed", {})
    }
    expect(t.copyTurnTexts(2)).toEqual(["Narasi dua", "Narasi tiga"])
    expect(t.copyTurnTexts(99)).toEqual(["Narasi satu", "Narasi dua", "Narasi tiga"])
  })

  test("rekap kumulatif hasil replaceEntry ikut tersalin (meta & sourceText sinkron)", () => {
    const acts = [
      activity({ toolCallId: "r1", name: "read_file", target: "a.ts" }),
      activity({ toolCallId: "r2", name: "read_file", target: "b.ts" }),
      activity({ toolCallId: "r3", name: "read_file", target: "c.ts" }),
    ]
    const { t, bus, emit } = setupCopy(acts)
    t.pushUser("prompt")
    bus.emit("provider:text", { text: "NARASI-A" })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "r1", status: "completed" })
    // Narasi baru menandai ujung segmen; tool.started mem-flush rekap segmen
    // ("1 read"). Dua tool berikut membuat kumulatif ("3 read") yang menimpa
    // baris yang SAMA lewat replaceEntry.
    bus.emit("provider:text", { text: "NARASI-B" })
    emit("tool.started", { seq: 2, turnId: 1, toolCallId: "r2", status: "running" })
    emit("tool.completed", { seq: 3, turnId: 1, toolCallId: "r2", status: "completed" })
    emit("tool.completed", { seq: 4, turnId: 1, toolCallId: "r3", status: "completed" })
    bus.emit("turn:completed", {})

    const payload = t.copyTurnTexts(1)[0]!
    expect(payload).toContain("NARASI-A")
    expect(payload).toContain("NARASI-B")
    // Segmen awal ("1 read") tetap sah; yang ditimpa adalah rekap SEGMEN
    // terakhir ("2 read") → kumulatif "3 read". Tanpa sinkron sourceText di
    // replaceEntry(), payload akan memuat "2 read" yang basi.
    expect(payload).toMatch(/\b3\s+\p{L}/u)
    expect(payload).not.toMatch(/\b2\s+\p{L}/u)
  })

  test("pembaca murni: size/total/view tak berubah setelah copyTurnTexts", () => {
    const { t, bus } = setupCopy([])
    t.pushUser("prompt")
    bus.emit("provider:text", { text: "Narasi" })
    bus.emit("turn:completed", {})
    const before = {
      size: t.size(),
      total: t.total(),
      view: t.view(80, 6, 0).join("\n"),
    }
    t.copyTurnTexts(3)
    expect(t.size()).toBe(before.size)
    expect(t.total()).toBe(before.total)
    expect(t.view(80, 6, 0).join("\n")).toBe(before.view)
  })
})

describe("v0.43 — /copy lewat OSC 52", () => {
  test("payload = persis narasi+rekap, baris panjang tak dipaksa ≤120 kolom", async () => {
    const uiState = new UiSessionState()
    const s = fakeSession(uiState)
    detachLogger = attachSimpleLogger(s.bus as never, { quiet: true })
    const longLine = `Narasi DUA ${"P".repeat(160)}`
    await startTui(s)

    const active = tty!
    for (const [i, narrative] of ["Narasi SATU", longLine, "Narasi TIGA"].entries()) {
      await active.send(`prompt ${i + 1}`)
      await active.send(KEY.enter)
      await active.waitForScreen((f) => f.some((l) => l.includes(`prompt ${i + 1}`)))
      s.bus.emit("provider:text", { text: `${narrative}\n` })
      s.bus.emit("turn:completed", {})
    }

    active.clear()
    await active.send("/copy 2")
    await active.send(KEY.enter)
    await active.waitForOutput((o) => o.includes("\x1b]52;c;"))
    const payload = decodeOsc52(active.all())

    expect(payload).toContain(longLine)
    expect(payload).toContain("Narasi TIGA")
    expect(payload).not.toContain("Narasi SATU")
    expect(payload.indexOf(longLine)).toBeLessThan(payload.indexOf("Narasi TIGA"))
    expect(payload).toContain("\n\n") // dua grup digabung dengan blank
    expect(payload).not.toContain("prompt 2")
    expect(payload).not.toContain("prompt 3")
    expect(payload).not.toContain("minicode ›")
    expect(payload).not.toContain("\x1b")
    // Teks bebas, BUKAN ledger: 171 kolom utuh, tanpa wrap/potong 120 kolom.
    const longest = payload.split("\n").reduce((a, b) => (b.length > a.length ? b : a), "")
    expect(longest.length).toBeGreaterThan(120)
  })

  test("output tool >20.000 char di #lastTurnText TIDAK ikut tersalin", async () => {
    const uiState = new UiSessionState()
    const s = fakeSession(uiState)
    detachLogger = attachSimpleLogger(s.bus as never, { quiet: true })
    const huge = "X".repeat(21000)
    uiState.appendTurnText(`tool output mentah:\n${huge}\n`)
    expect(uiState.getLastTurnText()).toContain(huge) // buffer lama memang terisi

    await startTui(s)
    const active = tty!
    await active.send("prompt aman")
    await active.send(KEY.enter)
    await active.waitForScreen((f) => f.some((l) => l.includes("prompt aman")))
    s.bus.emit("provider:text", { text: "Narasi AMAN" })
    s.bus.emit("turn:completed", {})

    active.clear()
    await active.send("/copy")
    await active.send(KEY.enter)
    await active.waitForOutput((o) => o.includes("\x1b]52;c;"))
    const payload = decodeOsc52(active.all())

    expect(payload).toContain("Narasi AMAN")
    expect(payload).not.toContain("tool output mentah")
    expect(payload).not.toContain("X".repeat(50))
    expect(payload.length).toBeLessThan(500)
  })
})

describe("v0.43 — regresi redaksi error ledger", () => {
  test("error tanpa pola kanonik: tidak ada `: <raw>`; deny reason tetap tampil", () => {
    const acts = [
      activity({
        toolCallId: "deny-1",
        name: "bash",
        target: undefined,
        status: "denied",
        denyReason: "read-only mode",
      }),
    ]
    const { t, emit } = setupCopy(acts)
    emit("tool.denied", {
      seq: 1,
      turnId: 1,
      toolCallId: "deny-1",
      status: "denied",
      reason: "read-only mode",
      message: "boom mentah yang tak dikenali",
    })
    const out = t.view(120, 6, 0).join("\n")
    expect(out).not.toContain("boom mentah")
    expect(out).toContain("read-only mode")
  })

  test("sub-agent error tetap memakai tSystem(msg.subagentFailed)", () => {
    const acts = [
      activity({
        toolCallId: "delegate-1",
        name: "delegate_task",
        label: "delegate_task",
        target: undefined,
        status: "failed",
      }),
    ]
    const { t, emit } = setupCopy(acts)
    emit("tool.failed", {
      seq: 1,
      turnId: 1,
      toolCallId: "delegate-1",
      status: "failed",
      message: "[sub-agent error] turn exceeded 180000ms",
    })
    const out = t.view(120, 6, 0).join("\n")
    expect(out).toContain(tSystem("msg.subagentFailed"))
    expect(out).not.toContain("180000ms")
  })
})
