// v7.30: kwitansi UI (salin, /mode, /view, steering) BUKAN giliran bicara.
// Transkrip boleh berisi percakapan saja; semua umpan balik perintah harus
// tampil di footer lewat `TuiApp.showToast`. Test ini mengunci kedua sisi:
// pesan benar-benar muncul di baris footer DAN tidak disisipkan ke transkrip.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
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

/** Baris terakhir frame = footer (`indicatorLine`), tempat toast dirender. */
function footerRow(): string {
  return tty!.screen()[tty!.screen().length - 1] ?? ""
}

/** Semua baris selain footer = badan transkrip (+ composer, yang bukan kwitansi). */
function transcriptText(): string {
  return tty!.screen().slice(0, -1).join("\n")
}

async function waitFor(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`${what} tidak terjadi dalam batas waktu`)
}

describe("v7.30: kwitansi perintah di footer, bukan transkrip", () => {
  test("Ctrl+C menyalin selection: toast terlihat, transkrip tak menambah baris", async () => {
    tty = installFakeTty({ columns: 80, rows: 16 })
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never)
    const copied: string[] = []
    const host: TuiHost = {
      bus: bus as never,
      getStatus: () => ({
        footer: { mode: "auto", model: "m", cwd: "/", context: "1k" },
        busy: false,
      }),
      listCommands: () => [],
      submit: async () => undefined,
      copySelection: (text) => {
        copied.push(text)
        return true
      },
      abort: () => {},
      cycleWorkMode: () => {},
      togglePermissionMode: () => {},
      toggleCompact: () => {},
      toggleReasoning: () => {},
    }
    const app = new TuiApp(transcript, host)
    // Spy instance: buktikan pesan benar-benar lewat showToast, bukan pushInfo.
    const seen: string[] = []
    const original = app.showToast.bind(app)
    app.showToast = (text, ms) => {
      seen.push(text)
      original(text, ms)
    }

    const runP = app.run()
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty.send("x")
    await tty.waitForScreen((frame) => frame.some((line) => line.includes("baris-29")))
    const visible = tty
      .screen()
      .map((line, index) => ({ line, row: index + 1 }))
      // v0.43: margin 3 milik frame — transkrip mulai di kolom 4 layar.
      .filter((item) => item.line.trimStart().startsWith("baris-"))
    const start = visible[0]!.row
    const picked = visible[Math.min(2, visible.length - 1)]!
    const endX = picked.line.length + 1
    await tty.send(`\x1b[<0;4;${start}M`)
    await tty.send(`\x1b[<32;${endX};${picked.row}M`)
    await tty.send(`\x1b[<0;${endX};${picked.row}m`)
    await tty.send(KEY.ctrlC)

    const msg = tSystem("msg.copied")
    expect(copied).toHaveLength(1)
    expect(seen).toContain(msg)
    expect(footerRow()).toContain(msg)
    expect(transcriptText()).not.toContain(msg)
    await tty.send(KEY.backspace) // kosongkan draft "x" supaya Ctrl+D quit, bukan hapus char
    await tty.send(KEY.ctrlD)
    await runP
  })

  function sessionHarness() {
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
          steered.push(text)
          return true
        },
      },
      cfg: { providers: [] },
      cwd: tmpdir(),
      sessionId: "footer-receipts",
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
      // Turn "berjalan" sampai release() dipanggil — perlu untuk steering.
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
      session,
      submitted,
      steered,
      release: () => {
        const g = gate
        gate = null
        g?.()
      },
    }
  }

  test("/mode bogus: pesan 'unknown mode' di footer, bukan transkrip", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const runP = runTui(sessionHarness().session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("/mode bogus")
      await tty.send(KEY.enter)
      const msg = tSystem("tui.unknownMode", { a: "bogus", modes: "DISCUSS, BUILD, AUTO, ASK" })
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(msg))
      expect(footerRow()).toContain("unknown mode")
      expect(transcriptText()).not.toContain(msg)
    } finally {
      await tty.send(KEY.ctrlD)
      await runP
    }
  })

  test("/view thinking ON: kwitansi 'thinking' di footer, bukan transkrip", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const runP = runTui(sessionHarness().session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("/view thinking ON")
      await tty.send(KEY.enter)
      const msg = t("tui.thinkingSet", { v: t("state.expanded") })
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(msg))
      expect(footerRow()).toContain("thinking:")
      expect(transcriptText()).not.toContain(msg)
    } finally {
      await tty.send(KEY.ctrlD)
      await runP
    }
  })

  test("steer saat busy: kwitansi 'steered' di footer, bukan transkrip", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const h = sessionHarness()
    const runP = runTui(h.session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("prompt-pertama")
      await tty.send(KEY.enter)
      await waitFor(() => h.submitted.length === 1, "turn pertama mulai")
      await tty.send("tambahan")
      await tty.send(KEY.enter)
      const msg = tSystem("tui.steered")
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(msg))
      expect(h.steered).toEqual(["tambahan"])
      expect(footerRow()).toContain(msg)
      // Entri user asli BOLEH di transkrip; kwitansinya TIDAK.
      expect(transcriptText()).not.toContain(msg)
      h.release()
    } finally {
      h.release()
      await tty.send(KEY.ctrlD)
      await runP
    }
  })
})
