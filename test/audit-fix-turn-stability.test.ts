// v7.41 — Audit turn-stability (#1–#4). Empat bug yang sudah dikonfirmasi di
// loop turn TUI, dengan fokus pada interaksi fitur auto-recap dengan job
// background. Semua perbaikan ada di cli/tui.ts; file ini menguji:
//
//  #1 abort tetap non-null sampai SELURUH runTurnOnce (persist termasuk)
//     selesai — diuji lewat AbortSignal yang ditangkap saat persist berjalan.
//  #2 early-return budget melepas abortRequested + flag recap — diuji dengan
//     rangkaian turn: abort → budget over → turn sah → steering diterima.
//  #3 notifikasi job saat turn aktif DITUNDA — diuji lewat helper murni
//     `createBgNoticeQueue` + `isTurnIdleForBackground`.
//  #4 jendela "Esc lagi = quit" dimatikan sebelum auto-resume — diuji lewat
//     helper murni `disarmAbortQuitIfAvailable`.
//
// Yang TIDAK dicakup: pemanggilan `onBackgroundJobFinished` sungguhan butuh
// menjalankan proses background melalui src/tools/bash.ts (di luar ownership
// test ini) — jadi keputusan deferral diuji di helper, bukan lewat job nyata.
// Demikian pula method privat `TuiApp.disarmAbortQuit()` dipanggil lewat cast
// struktural; test memastikan helper memanggilnya bila tersedia dan fail-closed
// bila tidak. Tidak ada klaim bahwa grid terminal/suspend popup diverifikasi.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { CliSession } from "../cli/setup.ts"
import {
  createBgNoticeQueue,
  createDeferredBgJobs,
  createTurnStateGuard,
  disarmAbortQuitIfAvailable,
  isAppBusy,
  isTurnIdleForBackground,
  liveToolsCount,
  runTui,
} from "../cli/tui.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null

beforeEach(() => {
  resetLocaleState()
  setSessionLocale("en")
  delete process.env.MINICODE_AUTORESUME_BG
})

afterEach(() => {
  tty?.restore()
  tty = null
  delete process.env.MINICODE_AUTORESUME_BG
  resetLocaleState()
})

async function waitFor(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`${what} tidak terjadi dalam batas waktu`)
}

// ── #1/#3: keputusan idle + antrean notifikasi (murni) ──────────────────────

describe("turn stability: bg-finished idle guard & deferral (#1/#3)", () => {
  test("idle hanya bila tak ada turn aktif, popup, DAN app busy", () => {
    expect(isTurnIdleForBackground({ abortActive: false, suspended: false, busy: false })).toBe(
      true,
    )
    expect(isTurnIdleForBackground({ abortActive: true, suspended: false, busy: false })).toBe(
      false,
    )
    expect(isTurnIdleForBackground({ abortActive: false, suspended: true, busy: false })).toBe(
      false,
    )
    // Batch 3 #2: jendela @-mention — abort masih null tapi app busy.
    expect(isTurnIdleForBackground({ abortActive: false, suspended: false, busy: true })).toBe(
      false,
    )
  })

  test("notifikasi saat sibuk ditunda, saat idle langsung tampil, lalu di-drain", () => {
    const notices = createBgNoticeQueue()
    const busy = isTurnIdleForBackground({ abortActive: true, suspended: false, busy: false })
    const idle = isTurnIdleForBackground({ abortActive: false, suspended: false, busy: false })

    expect(notices.offer("job A selesai", busy)).toBeUndefined()
    expect(notices.offer("job B selesai", idle)).toBe("job B selesai")
    expect(notices.pendingCount).toBe(1)
    // flush di batas turn (runTurnOnce) → satu commit, bukan di tengah streaming.
    expect(notices.drain()).toEqual(["job A selesai"])
    expect(notices.pendingCount).toBe(0)
    expect(notices.drain()).toEqual([])
  })
})

// ── Batch 3: @-mention race & job tertunda (murni) ──────────────────────────

describe("turn stability: batch 3 (bg finish)", () => {
  test("isAppBusy fail-closed saat method absen / melempar", () => {
    expect(isAppBusy({ isBusy: () => true })).toBe(true)
    expect(isAppBusy({ isBusy: () => false })).toBe(false)
    expect(isAppBusy({})).toBe(true)
    expect(isAppBusy(null)).toBe(true)
    expect(
      isAppBusy({
        isBusy: () => {
          throw new Error("stub")
        },
      }),
    ).toBe(true)
  })

  test("job yang selesai saat turn aktif ditunda, bukan langsung di-mark resumed", () => {
    const jobs = createDeferredBgJobs(2)
    expect(jobs.defer({ id: "j1", code: 0 })).toBe(true)
    expect(jobs.defer({ id: "j2", code: 1 })).toBe(true)
    // Bounded: penuh → tolak (fail-closed, tak tumbuh tanpa batas).
    expect(jobs.defer({ id: "j3", code: 0 })).toBe(false)
    expect(jobs.count).toBe(2)
    // Resume terjadi di batas turn: drain, lalu tandai resumed saat enqueue.
    const drained = jobs.drain()
    expect(drained.map((j) => j.id)).toEqual(["j1", "j2"])
    expect(jobs.count).toBe(0)
  })
})

// ── Batch 2 #2: /status toolsCount mengikuti array live ─────────────────────

describe("turn stability: toolsCount live (#2 batch 2)", () => {
  test("mengikuti array `visible` yang dimutasi in-place (WorkMode toggle)", () => {
    const visible = ["bash", "read_file", "edit"]
    expect(liveToolsCount(visible)).toBe(3)
    // DISCUSS → array SAMA dipangkas (setToolWorkMode mutasi in-place).
    visible.length = 0
    visible.push("bash")
    expect(liveToolsCount(visible)).toBe(1)
  })
})

// ── #2: flag lintas-turn punya satu pemilik (murni) ─────────────────────────

describe("turn stability: turn-state reset (#2)", () => {
  test("beginTurn melepas abortRequested & flag recap di SEMUA jalur", () => {
    const g = createTurnStateGuard()
    g.markAbortRequested()
    g.markChildRecapPromptPending()
    expect(g.abortRequested).toBe(true)
    expect(g.childRecapPromptPending).toBe(true)

    const first = g.beginTurn()
    expect(first.isChildRecapTurn).toBe(true)
    expect(g.abortRequested).toBe(false)
    expect(g.childRecapPromptPending).toBe(false)

    // BeginTurn berikutnya (turn user sah) tak mewarisi flag recap.
    expect(g.beginTurn().isChildRecapTurn).toBe(false)
  })
})

// ── #4: disarm jendela Esc-quit (murni, seam privat di app.ts) ───────────────

describe("turn stability: disarm auto-resume (#4)", () => {
  test("memanggil disarmAbortQuit bila ada, fail-closed bila tidak", () => {
    let calls = 0
    disarmAbortQuitIfAvailable({
      disarmAbortQuit: () => {
        calls++
      },
    })
    expect(calls).toBe(1)
    expect(() => disarmAbortQuitIfAvailable({})).not.toThrow()
    expect(() => disarmAbortQuitIfAvailable(null)).not.toThrow()
    expect(() =>
      disarmAbortQuitIfAvailable({
        disarmAbortQuit: () => {
          throw new Error("stub gagal")
        },
      }),
    ).not.toThrow()
  })
})

// ── Integrasi ringan untuk #1 & #2 ──────────────────────────────────────────

function harness(opts: { budget?: number } = {}) {
  const bus = createFakeBus()
  const submitted: string[] = []
  const turnGates: (() => void)[] = []
  const persistGates: (() => void)[] = []
  let capturedSignal: AbortSignal | undefined
  let persistCount = 0
  let resets = 0
  let cost = 0
  const noop = async () => {}
  const session = {
    bus,
    session: { events: bus, contextTokens: 0, steer: () => false },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "turn-stability-test",
    modelRef: {},
    permissionMode: "auto",
    permissions: undefined,
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    budget: opts.budget,
    budgetStrict: false,
    usage: {
      get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost }),
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost }),
      modelUsed: () => ({}),
      // Dipanggil sekali per turn yang benar-benar berjalan → penanda selesai.
      reset: () => {
        resets++
      },
    },
    // Persist ditahan supaya jendela "abort masih non-null" bisa diamati.
    persistCurrent: async () => {
      persistCount++
      await new Promise<void>((resolve) => persistGates.push(resolve))
    },
    runPromptWithVerify: async (prompt: string, signal: AbortSignal) => {
      submitted.push(prompt)
      capturedSignal = signal
      await new Promise<void>((resolve) => turnGates.push(resolve))
    },
    isWriterStale: () => false,
    writerStaleNote: () => "",
    close: noop,
  } as unknown as CliSession
  return {
    session,
    submitted,
    releaseTurn: () => turnGates.shift()?.(),
    releasePersist: () => persistGates.shift()?.(),
    get capturedSignal() {
      return capturedSignal
    },
    get persistCount() {
      return persistCount
    },
    get resets() {
      return resets
    },
    setCost: (v: number) => {
      cost = v
    },
  }
}

test("integrasi #1: Esc saat persist menjangkau turn (abort belum null), tanpa turn kedua", async () => {
  const h = harness()
  const runP = runTui(h.session)
  tty = installFakeTty({ columns: 80, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("prompt-1")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 1, "turn pertama mulai")

    // Badan turn selesai → persist mulai dan ditahan. Di kode lama, `abort`
    // sudah null di titik ini; di kode baru masih menunjuk ctrl.
    h.releaseTurn()
    await waitFor(() => h.persistCount === 1, "persist mulai")

    await tty.send(KEY.esc)
    await waitFor(() => h.capturedSignal?.aborted === true, "abort menjangkau turn saat persist")

    // Tak ada runTurn kedua yang balapan menguras antrean yang sama.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.submitted.length).toBe(1)
  } finally {
    h.releasePersist()
    h.releaseTurn()
    try {
      await tty!.send(KEY.ctrlD)
    } catch {}
    await runP
  }
})

test("integrasi F1: baris antre yang dibuang saat abort tak pernah digema", async () => {
  const h = harness()
  const runP = runTui(h.session)
  tty = installFakeTty({ columns: 80, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))

    // Turn 1 berjalan; Enter mengantrekan baris (steer ditolak di fixture).
    await tty.send("turn-1")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 1, "turn 1 mulai")
    await tty.send("info tambahan")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f.some((line) => line.includes("queued #1")))
    // Gema DITUNDA: baris belum boleh tampil sebagai prompt user.
    await tty.waitForScreen((f) => !f.some((line) => line.includes("info tambahan")))

    // Abort → baris antre dibuang; tetap tak ada prompt hantu.
    await tty.send(KEY.esc)
    // Tunggu abort terproses (toast setelah host.abort()) sebelum gate dilepas.
    await tty.waitForScreen((f) => f.some((line) => line.includes(tSystem("msg.abortedHint"))))
    h.releaseTurn()
    // Toast queueDropped muncul di inner finally, tepat setelah gate dilepas.
    await tty.waitForScreen((f) => f.some((line) => line.includes("queued dropped")))
    await waitFor(() => h.persistCount === 1, "persist turn 1 mulai")
    h.releasePersist()
    await waitFor(() => h.resets === 1, "turn 1 selesai")
    expect(
      await tty.waitForScreen((f) => !f.some((line) => line.includes("info tambahan"))),
    ).toBeTruthy()

    // Turn sah berikutnya digema normal (konfirmasi bukan karena echo mati total).
    await new Promise((r) => setTimeout(r, 0))
    await tty.send("turn-2")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 2, "turn 2 mulai")
    await tty.waitForScreen((f) =>
      f.some((line) => line.includes("minicode") && line.includes("turn-2")),
    )
    h.releaseTurn()
    h.releasePersist()
  } finally {
    h.releasePersist()
    h.releaseTurn()
    try {
      await tty!.send(KEY.ctrlD)
    } catch {}
    await runP
  }
})

test("integrasi #2: abort → budget early-return → steering diterima lagi", async () => {
  const h = harness({ budget: 1 })
  const runP = runTui(h.session)
  tty = installFakeTty({ columns: 80, rows: 24 })
  try {
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))

    // Turn A jalan lalu di-abort → abortRequested=true.
    await tty.send("turn-a")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 1, "turn A mulai")
    await tty.send(KEY.esc)
    await waitFor(() => h.capturedSignal?.aborted === true, "abort turn A")
    h.releaseTurn()
    await waitFor(() => h.persistCount === 1, "persist turn A mulai")
    h.releasePersist()
    await waitFor(() => h.resets === 1, "turn A selesai")
    await new Promise((r) => setTimeout(r, 0)) // lepas mikrotugas host.submit → idle

    // Turn B: budget over → early-return. Guard di awal harus melepas flag.
    h.setCost(2)
    await tty.send("turn-b")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f.some((line) => line.includes("over budget")))

    // Turn C sah → steering (Enter saat busy) harus diterima, bukan ditolak.
    h.setCost(0)
    await tty.send("turn-c")
    await tty.send(KEY.enter)
    await waitFor(() => h.submitted.length === 2, "turn C mulai")
    await tty.send("info tambahan")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f.some((line) => line.includes("queued #1")))
  } finally {
    h.releasePersist()
    h.releaseTurn()
    try {
      await tty!.send(KEY.ctrlD)
    } catch {}
    await runP
  }
})
