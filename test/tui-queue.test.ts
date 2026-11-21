// Integrasi "informasi tambahan" saat turn berjalan (driver cli/tui.ts + TuiApp):
// Enter menyelipkan baris ke TURN AKTIF lewat `session.steer()` (kernel
// menambahkannya pada batas step berikutnya). Bila turn ternyata sudah selesai
// (balapan), baris jatuh ke antrean turn berikutnya — pesan tidak boleh hilang.
//
// Gagal-di-kode-lama: busy membekukan input total, jadi baris kedua tak pernah
// sampai ke model sama sekali.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { ToolContext } from "#minicore"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { createBashJobTools, killAllBackgroundJobs } from "../src/tools/bash.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null

beforeEach(() => {
  resetLocaleState()
  setSessionLocale("en")
})

afterEach(() => {
  tty?.restore()
  tty = null
  resetLocaleState()
})

type Harness = {
  submitted: string[]
  steered: string[]
  release: () => void
  session: CliSession
}

/** `steerAccepted` = kernel melaporkan ada turn aktif untuk diselipi. */
function harness(opts: { steerAccepted?: boolean } = {}): Harness {
  const steerAccepted = opts.steerAccepted ?? true
  const bus = createFakeBus()
  const submitted: string[] = []
  const steered: string[] = []
  let gate: (() => void) | null = null
  const noop = async () => {}
  const session = {
    bus,
    session: {
      events: bus,
      contextTokens: 0,
      steer: (text: string) => {
        if (!steerAccepted) return false
        steered.push(text)
        return true
      },
    },
    cfg: { providers: [] },
    cwd: tmpdir(),
    sessionId: "queue-test",
    modelRef: {} as { current?: string },
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
    // Turn "berjalan" sampai release() dipanggil.
    runPromptWithVerify: async (prompt: string) => {
      submitted.push(prompt)
      await new Promise<void>((resolve) => {
        gate = resolve
      })
    },
    isWriterStale: () => false,
    writerStaleNote: () => "",
    close: noop,
  } as unknown as CliSession
  return {
    submitted,
    steered,
    release: () => {
      const g = gate
      gate = null
      g?.()
    },
    session,
  }
}

async function waitFor(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`${what} tidak terjadi dalam batas waktu`)
}

async function startBusy(h: Harness, prompt = "prompt-pertama"): Promise<void> {
  tty = installFakeTty({ columns: 80, rows: 24 })
  await tty.ready()
  await tty.waitForOutput((o) => o.includes("00.00.00"))
  await tty.send(prompt)
  await tty.send(KEY.enter)
  await waitFor(() => h.submitted.length === 1, "turn pertama mulai")
}

describe("TUI: informasi tambahan saat turn berjalan", () => {
  test("Enter saat busy menyelipkan ke turn aktif, bukan turn kedua", async () => {
    const h = harness()
    const runP = runTui(h.session)
    try {
      await startBusy(h)
      // Turn masih berjalan: ketik tambahan lalu Enter → steering.
      await tty!.send("pakai jalur B")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("steered into turn")))
      expect(h.steered).toEqual(["pakai jalur B"])
      // Tidak ada turn kedua yang balapan dengan yang sedang jalan.
      expect(h.submitted).toEqual(["prompt-pertama"])
      h.release()
    } finally {
      await tty!.send(KEY.ctrlD)
      await runP
    }
  })

  test("steer ditolak kernel (turn sudah selesai) → fallback antrean, tetap terkirim", async () => {
    const h = harness({ steerAccepted: false })
    const runP = runTui(h.session)
    try {
      await startBusy(h)
      await tty!.send("info tambahan")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("queued #1")))
      expect(h.submitted).toEqual(["prompt-pertama"])
      h.release()
      await waitFor(() => h.submitted.length === 2, "pesan antre dikirim")
      expect(h.submitted).toEqual(["prompt-pertama", "info tambahan"])
      h.release()
    } finally {
      await tty!.send(KEY.ctrlD)
      await runP
    }
  })

  test("perintah slash saat busy ditolak dengan alasan, bukan diselipkan", async () => {
    const h = harness()
    const runP = runTui(h.session)
    try {
      await startBusy(h, "jalan")
      await tty!.send("/clear")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("busy · Esc to stop")))
      expect(h.steered).toEqual([])
      expect(h.submitted).toEqual(["jalan"])
      h.release()
    } finally {
      await tty!.send(KEY.ctrlD)
      await runP
    }
  })

  test("abort membuang antrean fallback dengan pemberitahuan", async () => {
    const h = harness({ steerAccepted: false })
    const runP = runTui(h.session)
    try {
      await startBusy(h, "jalan")
      await tty!.send("jangan kirim")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("queued #1")))
      // Esc saat busy = abort; niat user yang dibatalkan tak boleh dieksekusi.
      await tty!.send(KEY.esc, 90)
      h.release()
      await tty!.waitForScreen((f) => f.some((line) => line.includes("queued dropped")))
      expect(h.submitted).toEqual(["jalan"])
    } finally {
      await tty!.send(KEY.ctrlD)
      await runP
    }
  })

  test("M2: celah abort→submit tak boleh mengisi ulang antrean (turn hantu)", async () => {
    const h = harness({ steerAccepted: false })
    const runP = runTui(h.session)
    try {
      await startBusy(h, "jalan")
      await tty!.send("dulu")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("queued #1")))
      // Turn masih terblokir di gate, jadi App tetap busy setelah abort,
      // dan Enter berikutnya lewat jalur host.enqueue (bukan submit baru).
      await tty!.send(KEY.esc, 90)
      await tty!.send("setelah abort")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("Enter to start")))
      expect(h.steered).toEqual([])
      h.release()
      await new Promise((r) => setTimeout(r, 30))
      // Antre lama dibuang, antre baru ditolak → tak ada turn kedua.
      expect(h.submitted).toEqual(["jalan"])
    } finally {
      await tty!.send(KEY.ctrlD)
      await runP
    }
  })
})

describe("TUI: abortRequested & footer live mode (audit deep-mode)", () => {
  test("auto-resume job background setelah abort menerima steering (flag di-clear di turn baru)", async () => {
    const savedAuto = process.env.MINICODE_AUTORESUME_BG
    process.env.MINICODE_AUTORESUME_BG = "1"
    const h = harness()
    const runP = runTui(h.session)
    try {
      await startBusy(h, "pertama")
      // Esc = abort: abortRequested=true, niat lama dibatalkan.
      await tty!.send(KEY.esc, 90)
      h.release()
      await tty!.waitForScreen((f) => f.some((line) => line.includes("(stopped)")))

      // Job background selesai → onBackgroundJobFinished memanggil runTurn()
      // LANGSUNG (tak lewat submit()). Sebelum fix, turn baru ini mewarisi
      // abortRequested=true sehingga semua steering ditolak.
      const { bash } = createBashJobTools("deep-autoresume")
      const ctx = {
        signal: new AbortController().signal,
        cwd: tmpdir(),
        emit() {},
      } as unknown as ToolContext
      await bash.execute({ cmd: "echo deep-done", background: true }, ctx)
      await waitFor(() => h.submitted.length === 2, "turn auto-resume mulai")

      await tty!.send("lanjutan setelah resume")
      await tty!.send(KEY.enter)
      await tty!.waitForScreen((f) => f.some((line) => line.includes("steered into turn")))
      expect(h.steered).toContain("lanjutan setelah resume")
      h.release()
    } finally {
      h.release()
      killAllBackgroundJobs()
      await tty?.send(KEY.ctrlD)
      await runP
      if (savedAuto === undefined) delete process.env.MINICODE_AUTORESUME_BG
      else process.env.MINICODE_AUTORESUME_BG = savedAuto
    }
  })

  test("footer membaca permissions.getMode() live, bukan snapshot mode", async () => {
    const h = harness()
    h.session.permissions = {
      getMode: () => "ask",
      getRestrictBash: () => false,
      setMode: () => {},
    } as never
    const runP = runTui(h.session)
    try {
      tty = installFakeTty({ columns: 90, rows: 24 })
      await tty.ready()
      // `permissionMode` di fixture = "auto"; kalau footer masih memakai mode
      // basi, labelnya "Auto" dan assertion ini gagal.
      await tty.waitForScreen((f) => f.some((line) => line.includes("Ask")))
    } finally {
      await tty?.send(KEY.ctrlD)
      await runP
    }
  })
})
