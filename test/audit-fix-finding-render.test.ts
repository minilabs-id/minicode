// finding.detected ([EVALUATE] / temuan anak) adalah catatan diagnostik antar-agen,
// bukan narasi percakapan: TIDAK dirender ke chat utama TUI (live maupun
// replayHistory), melainkan disalurkan ke `/logs` di cli/tui.ts + tetap durable
// di SQLite & ACP.
import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import type { UiPresentationEvent } from "../src/ui/contract.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
})

function setup() {
  const bus = createFakeBus()
  let handler: ((e: unknown) => void) | undefined
  const t = new Transcript(bus as never, {
    onPresentationEvent: (h) => {
      handler = h as (e: unknown) => void
      return () => {
        handler = undefined
      }
    },
  })
  return { t, emit: (e: unknown) => handler?.(e), view: () => t.view(80, 12, 0).join("\n") }
}

const finding = (text: string, id = "child-report:sub1:1") => ({
  type: "finding.detected" as const,
  findingId: id,
  category: "child-report",
  severity: "warning" as const,
  text,
  turnId: 1,
})

test("[EVALUATE] / finding.detected tidak tumpah ke chat utama (live maupun replay)", () => {
  const { t, emit, view } = setup()
  emit(finding("[EVALUATE] high | src/x.ts:12 | policy bypass"))
  t.replayHistory([finding("[EVALUATE] medium | src/y.ts:9 | replay lama", "child-report:sub2:1")])
  expect(view()).not.toContain("[EVALUATE]")
  expect(view()).not.toContain("policy bypass")
  expect(view()).not.toContain("replay lama")
  expect(t.size()).toBe(0)
})

test("finding tanpa text diabaikan (tak ada baris kosong / 'undefined')", () => {
  const { t, emit, view } = setup()
  emit({ type: "finding.detected", findingId: "f", summary: { unused: true }, turnId: 1 })
  expect(view()).not.toContain("undefined")
  expect(t.size()).toBe(0)
})

test("TUI menyalurkan finding.detected ke /logs utuh (sanitasi + dedup), chat tetap bersih", async () => {
  const bus = createFakeBus()
  let presHandler: ((e: UiPresentationEvent) => void) | undefined
  const session = {
    bus,
    session: { events: bus, contextTokens: 0 },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "finding-logs-test",
    modelRef: {},
    permissionMode: "auto",
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    usage: {
      get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      modelUsed: () => ({}),
      reset: () => {},
    },
    budgetStrict: false,
    persistCurrent: async () => {},
    runPromptWithVerify: async () => {},
    getPresentationSnapshot: () => ({
      activities: [{ toolCallId: "dt_1", name: "delegate_task", label: "Audit scheduler" }],
      turns: [],
    }),
    onPresentationEvent: (h: (e: UiPresentationEvent) => void) => {
      presHandler = h
      return () => {
        presHandler = undefined
      }
    },
    close: async () => {},
  } as unknown as CliSession

  const runP = runTui(session)
  tty = installFakeTty({ columns: 100, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    const ev: UiPresentationEvent = {
      type: "finding.detected",
      findingId: "child-report:sub1:1",
      category: "child-report",
      severity: "warning",
      parentToolCallId: "dt_1",
      text: "[EVALUATE] low | \x1b[2J docs/x.md:3 | temuan lengkap",
      turnId: 1,
    }
    presHandler?.(ev)
    presHandler?.(ev) // duplikat id harus ter-dedup

    await tty.send("/logs")
    await tty.send(KEY.enter)
    const frame = await tty.waitForScreen((f) => f.some((l) => l.includes("temuan lengkap")))
    const joined = frame.join("\n")
    expect(joined).toContain("[finding:Audit scheduler]")
    expect(joined).not.toContain("\x1b[2J")
    expect(joined.split("temuan lengkap").length - 1).toBe(1)

    await tty.send(KEY.esc, 90)
    await tty.waitForScreen((f) => !f.some((l) => l.includes("temuan lengkap")))
    // Chat utama di belakang jendela /logs tetap bersih dari [EVALUATE].
    expect(tty.screen().join("\n")).not.toContain("[EVALUATE]")
  } finally {
    await tty.send(KEY.ctrlD)
    await runP
  }
})
