// v7.41 — Rekap otomatis sub-agent `delegate_task` (design "A + B terbatas").
//
// Fokus: model induk harus NARRATE saat anak selesai (sebelumnya diam), tanpa
// menyela user, tanpa loop, dan bounded. Logika inti sengaja diekspos sebagai
// helper murni dari cli/tui.ts supaya bisa diuji tanpa harness TTY yang rapuh.
// Satu test integrasi ringan memastikan prompt rekap BENAR-BENAR masuk antrean
// `runTurn` (bukan cuma dibangun).
//
// Yang TIDAK dicakup di sini: perilaku TuiApp saat popup/suspend sungguhan dan
// urutan paint layar — guard-nya diuji lewat `shouldFireChildRecap` (suspended,
// abort, antrean user), bukan lewat grid terminal. Itu disengaja: state machine
// recap sudah sepenuhnyadeterministik di helper, jadi test grid tak menambah
// keyakinan, hanya menambah flake lintas-proses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { CliSession } from "../cli/setup.ts"
import {
  buildChildRecapPrompt,
  CHILD_RECAP_MAX_ENTRIES,
  CHILD_RECAP_SUMMARY_MAX_CHARS,
  type ChildRecapFireInput,
  type ChildRecapTracker,
  createChildRecapTracker,
  createTurnStateGuard,
  isChildRecapEnabled,
  runTui,
  shouldFireChildRecap,
} from "../cli/tui.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null

beforeEach(() => {
  resetLocaleState()
  setSessionLocale("en")
  delete process.env.MINICODE_AUTORESUME_CHILD
})

afterEach(() => {
  tty?.restore()
  tty = null
  delete process.env.MINICODE_AUTORESUME_CHILD
  resetLocaleState()
})

/** Input idle "normal": guard semua lolos kecuali di-override. */
function idle(
  tracker: ChildRecapTracker,
  overrides: Partial<ChildRecapFireInput> = {},
): ChildRecapFireInput {
  return {
    enabled: tracker.enabled,
    pendingCount: tracker.pendingCount,
    queuedCount: 0,
    suspended: false,
    abortActive: false,
    aborted: false,
    inRecapTurn: tracker.inRecapTurn,
    ...overrides,
  }
}

describe("child recap: koleksi dari domain event", () => {
  test("delegate_task selesai saat idle → SATU ringkasan, SATU prompt berisi ringkasan", () => {
    const tracker = createChildRecapTracker(true)
    tracker.noteStarted("call-1", "delegate_task")
    expect(tracker.noteCompleted("call-1", "riset selesai: 3 temuan")).toBe(true)
    expect(tracker.pendingCount).toBe(1)
    expect(shouldFireChildRecap(idle(tracker))).toBe(true)

    const prompt = buildChildRecapPrompt(tracker.drain())
    expect(prompt).toContain("1")
    expect(prompt).toContain("riset selesai: 3 temuan")
    expect(prompt).toMatch(/sub-agent|Evaluasi|report/i)
    // Habis di-drain → tak boleh menyala lagi (batas "satu recap per turn").
    expect(tracker.pendingCount).toBe(0)
    expect(shouldFireChildRecap(idle(tracker))).toBe(false)
  })

  test("beberapa anak selesai dalam satu turn → SATU rekap berisi semua ringkasan", () => {
    const tracker = createChildRecapTracker(true)
    const children: [string, string][] = [
      ["a", "Riset A: 5 source"],
      ["b", "Riset B: celah keamanan"],
      ["c", "Riset C: rekomendasi"],
    ]
    for (const [id, summary] of children) {
      tracker.noteStarted(id, "delegate_task")
      tracker.noteCompleted(id, summary)
    }
    expect(tracker.pendingCount).toBe(children.length)

    const prompt = buildChildRecapPrompt(tracker.drain())
    expect(prompt).toContain(String(children.length))
    for (const [, summary] of children) expect(prompt).toContain(summary)
  })

  test("tool biasa (bukan delegate_task) tak dikumpulkan", () => {
    const tracker = createChildRecapTracker(true)
    tracker.noteStarted("x", "bash")
    expect(tracker.noteCompleted("x", "ls -la")).toBe(false)
    tracker.noteStarted("y", "read_file")
    expect(tracker.noteCompleted("y", "isi file")).toBe(false)
    expect(tracker.pendingCount).toBe(0)
  })

  test("id dibersihkan saat tool berakhir tanpa summary (failed/denied/cancelled)", () => {
    const tracker = createChildRecapTracker(true)
    tracker.noteStarted("a", "delegate_task")
    tracker.noteTerminal("a")
    expect(tracker.noteCompleted("a", "summary terlambat")).toBe(false)
    expect(tracker.pendingCount).toBe(0)
  })
})

describe("child recap: guard fire", () => {
  test("turn aktif / dibatalkan / suspend / ada antrean user → TAK fire (dan tak hilang)", () => {
    const tracker = createChildRecapTracker(true)
    tracker.noteStarted("a", "delegate_task")
    tracker.noteCompleted("a", "R")

    expect(shouldFireChildRecap(idle(tracker, { abortActive: true }))).toBe(false)
    expect(shouldFireChildRecap(idle(tracker, { aborted: true }))).toBe(false)
    expect(shouldFireChildRecap(idle(tracker, { suspended: true }))).toBe(false)
    expect(shouldFireChildRecap(idle(tracker, { queuedCount: 2 }))).toBe(false)
    // Semua guard gagal tapi data tetap tertahan untuk turn berikutnya.
    expect(tracker.pendingCount).toBe(1)
    expect(shouldFireChildRecap(idle(tracker))).toBe(true)
  })

  test("MINICODE_AUTORESUME_CHILD=0 → nonaktif, tak mengumpulkan & tak fire", () => {
    expect(isChildRecapEnabled({})).toBe(true)
    expect(isChildRecapEnabled({ MINICODE_AUTORESUME_CHILD: "1" })).toBe(true)
    expect(isChildRecapEnabled({ MINICODE_AUTORESUME_CHILD: "0" })).toBe(false)

    const tracker = createChildRecapTracker(isChildRecapEnabled({ MINICODE_AUTORESUME_CHILD: "0" }))
    tracker.noteStarted("a", "delegate_task")
    expect(tracker.noteCompleted("a", "R")).toBe(false)
    expect(tracker.pendingCount).toBe(0)
    expect(shouldFireChildRecap(idle(tracker))).toBe(false)
  })

  test("anti-loop: turn recap abaikan tool.completed dan tak memicu recap lanjutan", () => {
    const tracker = createChildRecapTracker(true)
    tracker.setInRecapTurn(true)
    tracker.noteStarted("a", "delegate_task")
    // Anak yang (hipotetis) selesai DALAM turn recap tak boleh masuk koleksi.
    expect(tracker.noteCompleted("a", "dari dalam recap")).toBe(false)
    expect(tracker.pendingCount).toBe(0)
    // Bahkan bila ada sisa pending, guard inRecapTurn menolak fire.
    expect(shouldFireChildRecap(idle(tracker, { pendingCount: 2, inRecapTurn: true }))).toBe(false)
    tracker.setInRecapTurn(false)
    expect(shouldFireChildRecap(idle(tracker))).toBe(false)
  })

  test("handoff flag recap (audit #2): beginTurn → inRecapTurn → tak bocor ke turn sah", () => {
    const turnState = createTurnStateGuard()
    const tracker = createChildRecapTracker(true)
    turnState.markAbortRequested()
    turnState.markChildRecapPromptPending()

    const { isChildRecapTurn } = turnState.beginTurn()
    expect(isChildRecapTurn).toBe(true)
    expect(turnState.childRecapPromptPending).toBe(false)
    expect(turnState.abortRequested).toBe(false)

    if (isChildRecapTurn) tracker.setInRecapTurn(true)
    expect(tracker.inRecapTurn).toBe(true)
    tracker.noteStarted("a", "delegate_task")
    expect(tracker.noteCompleted("a", "dari recap")).toBe(false)
    tracker.setInRecapTurn(false)

    // Turn user sah berikutnya harus bersih — tak dianggap recap.
    expect(turnState.beginTurn().isChildRecapTurn).toBe(false)
  })

  test("audit: anak di-abort → ringkasan error dibuang, tak bocor ke turn bersih", () => {
    const tracker = createChildRecapTracker(true)
    tracker.noteStarted("c1", "delegate_task")
    // task.ts mengembalikan abort sebagai STRING lewat tool.completed.
    tracker.noteCompleted("c1", "[sub-agent c1 error] aborted by parent")
    expect(tracker.pendingCount).toBe(1)

    // Saat induk di-abort, guard fire memang menolak (tak ada drain).
    expect(shouldFireChildRecap(idle(tracker, { aborted: true }))).toBe(false)
    expect(tracker.pendingCount).toBe(1)

    // Perbaikan: inner finally memanggil clear() → entry hilang permanen.
    tracker.clear()
    expect(tracker.pendingCount).toBe(0)
    expect(shouldFireChildRecap(idle(tracker))).toBe(false)
  })
})

describe("child recap: batas ukuran", () => {
  test("maksimal 8 entri, ringkasan dipotong 300 char, kontrol berbahaya dibuang", () => {
    const capped = createChildRecapTracker(true)
    for (let i = 0; i < CHILD_RECAP_MAX_ENTRIES + 5; i++) {
      const id = `c${i}`
      capped.noteStarted(id, "delegate_task")
      capped.noteCompleted(id, `summary-${i}`)
    }
    expect(capped.pendingCount).toBe(CHILD_RECAP_MAX_ENTRIES)

    const clipped = createChildRecapTracker(true)
    clipped.noteStarted("s", "delegate_task")
    clipped.noteCompleted("s", "x".repeat(CHILD_RECAP_SUMMARY_MAX_CHARS + 50))
    expect(clipped.drain()[0]?.length).toBe(CHILD_RECAP_SUMMARY_MAX_CHARS)

    const scrubbed = createChildRecapTracker(true)
    scrubbed.noteStarted("e", "delegate_task")
    // OSC, C0, dan bidi override harus hilang; SGR warna sengaja dipertahankan
    // sanitizer kanonik (lihat src/ui/render/sanitize.ts) — itu bukan ancaman.
    scrubbed.noteCompleted("e", "ama\x01n\x1b]0;title\x07\x0e\u202eteks")
    const clean = scrubbed.drain()[0] ?? ""
    expect(clean).not.toContain("\x01")
    expect(clean).not.toContain("\x1b")
    expect(clean).not.toContain("\u202e")
    expect(clean).toContain("ama")
    expect(clean).toContain("teks")
  })
})

// ---------------------------------------------------------------------------
// Integrasi ringan: pastikan prompt rekap benar-benar DIENQUEUE oleh runTurnOnce
// (bukan cuma dibangun oleh helper). Memakai harness fake-tty yang sama dengan
// test antrean TUI lainnya, tanpa terminal sungguhan.
// ---------------------------------------------------------------------------

async function waitFor(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`${what} tidak terjadi dalam batas waktu`)
}

function integrationHarness() {
  const bus = createFakeBus()
  const submitted: string[] = []
  const gates: (() => void)[] = []
  let domainHandler: ((e: DomainEvent) => void) | null = null
  let resets = 0
  const noop = async () => {}
  const session = {
    bus,
    session: { events: bus, contextTokens: 0, steer: () => false },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "child-recap-test",
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
      reset: () => {
        resets++
      },
    },
    budget: undefined,
    budgetStrict: false,
    persistCurrent: noop,
    // Tiap turn menahan gate dilepas manual → kita kontrol kapan turn "selesai".
    runPromptWithVerify: async (prompt: string) => {
      submitted.push(prompt)
      await new Promise<void>((resolve) => gates.push(resolve))
    },
    isWriterStale: () => false,
    writerStaleNote: () => "",
    onDomainEvent: (h: (e: DomainEvent) => void) => {
      domainHandler = h
      return () => {
        domainHandler = null
      }
    },
    close: noop,
  } as unknown as CliSession
  return {
    session,
    submitted,
    emit: (e: unknown) => domainHandler?.(e as DomainEvent),
    release: () => gates.shift()?.(),
    hasHandler: () => domainHandler !== null,
    get resets() {
      return resets
    },
  }
}

test("integrasi: turn idle → satu prompt rekap dienqueue, anti-loop, tanpa menyela", async () => {
  const h = integrationHarness()
  const runP = runTui(h.session)
  tty = installFakeTty({ columns: 80, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    expect(h.hasHandler()).toBe(true)

    await tty.send("jalankan riset")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 1, "turn pertama mulai")

    // Anak delegate_task selesai SELAGI turn pertama aktif.
    h.emit({
      type: "tool.started",
      toolCallId: "c1",
      stepId: 1,
      identity: { origin: "builtin", name: "delegate_task", qualified: "delegate_task" },
      argsSummary: { text: "" },
    })
    h.emit({
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 1,
      summary: "Riset: 3 temuan penting",
      expandRef: { toolCallId: "c1", idx: 0 },
    })

    // Turn masih aktif → recap belum boleh keluar.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.submitted.length).toBe(1)

    // Selesaikan turn pertama → recap jadi turn kedua (dienqueue, bukan rekursi).
    h.release()
    await waitFor(() => h.submitted.length === 2, "turn rekap mulai")
    expect(h.submitted[1]).toContain("Riset: 3 temuan penting")
    expect(h.submitted[1]).toMatch(/sub-agent|Evaluasi|report/i)

    // Anti-loop: turn rekap tak memicu turn ketiga.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.submitted.length).toBe(2)
    h.release()
  } finally {
    await tty.send(KEY.ctrlD)
    await runP
  }
})

test("integrasi: induk abort setelah anak selesai → recap tak bocor ke turn berikutnya", async () => {
  const h = integrationHarness()
  const runP = runTui(h.session)
  tty = installFakeTty({ columns: 80, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("turn-1")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 1, "turn 1 mulai")

    // Anak "selesai" dengan STRING error (kasus abort task.ts).
    h.emit({
      type: "tool.started",
      toolCallId: "c1",
      stepId: 1,
      identity: { origin: "builtin", name: "delegate_task", qualified: "delegate_task" },
      argsSummary: { text: "" },
    })
    h.emit({
      type: "tool.completed",
      toolCallId: "c1",
      durationMs: 1,
      summary: "[sub-agent c1 error] aborted by parent",
      expandRef: { toolCallId: "c1", idx: 0 },
    })

    // Abort induk → inner finally harus membuang ringkasan tadi.
    await tty.send(KEY.esc)
    // Tunggu abort benar-benar diproses (toast muncul SETELAH host.abort()) —
    // kalau gate dilepas lebih dulu, turn selesai sebelum sinyal abort terbaca.
    await tty.waitForScreen((f) => f.some((line) => line.includes(tSystem("msg.abortedHint"))))
    h.release()
    await waitFor(() => h.resets === 1, "turn 1 selesai")
    await new Promise((r) => setTimeout(r, 0))

    // Turn user sah berikutnya: harus benar-benar "turn-2", bukan recap error.
    await tty.send("turn-2")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 2, "turn 2 mulai")
    expect(h.submitted[1]).toBe("turn-2")
    expect(h.submitted[1]).not.toContain("sub-agent")
  } finally {
    h.release()
    await tty.send(KEY.ctrlD)
    await runP
  }
})
