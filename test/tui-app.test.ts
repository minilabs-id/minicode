// Integrasi TuiApp di atas FakeTty — proteksi kontrak I17-I20.
// Tiap test gagal-di-kode-lama: tanpa App, tak ada frame fullscreen,
// pairing alt-screen, viewport scroll, maupun status bar.
//
// Catatan timing: repaint App sinkron di dalam handler key, jadi setelah
// `await tty.send(...)` frame SUDAH final dan `tty.screen()` menegaskan
// state — bukan race. Hanya paint awal & submit async yang butuh
// waitForOutput/waitForScreen. Sejak diff per sel, teks yang tak berubah tidak
// ditulis ulang, jadi tunggu ISI LAYAR (waitForScreen), bukan byte mentah.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationEvent } from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { altScreenDepth, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import {
  dropdownWindowStart,
  formatTimer,
  TuiApp,
  type TuiHost,
  type TuiStatusSnapshot,
  thinkingDots,
  timerHighlight,
} from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const origMinicodeColor = process.env.MINICODE_COLOR

beforeEach(() => {
  setSessionLocale("en")
  // v7.29: warna nyala by default di TTY. Test "monokrom" menyalakan flag
  // sendiri; pastikan env tiap test mulai bersih.
  delete process.env.MINICODE_COLOR
})

/**
 * [P0 UI Security] Sentinel PALSU untuk uji redaksi credential di jalur TUI.
 * Bukan credential nyata — hanya nilai yang harus TERHAPUS dari layar.
 */
const SENTINEL_BEARER = "SENTINEL-BEARER-abcdef123456"

let tty: ReturnType<typeof installFakeTty> | null = null
let lastApp: TuiApp | null = null
afterEach(() => {
  // Pastikan TuiApp yang gagal sebelum Ctrl+D tidak membocorkan listener
  // SIGTERM/SIGHUP ke berkas test berikutnya dalam proses yang sama.
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
  if (origMinicodeColor == null) delete process.env.MINICODE_COLOR
  else process.env.MINICODE_COLOR = origMinicodeColor
})

/** Ambil nama command dari baris overlay (border/padding/marker dibuang). */
function menuNames(text: string): string[] {
  return text.split("\n").map((line) =>
    line
      .replace(/^\s*[│|]\s*/, "")
      .replace(/\s*[│|]$/, "")
      .replace(/^\s*›\s*/, "")
      .trim(),
  )
}

function setup(
  opts: {
    columns?: number
    rows?: number
    isTTY?: boolean
    getStatus?: () => TuiStatusSnapshot
    cycleWorkMode?: () => void
    togglePermissionMode?: () => void
    initialDraft?: string
  } = {},
) {
  const columns = opts.columns ?? 60
  const rows = opts.rows ?? 14
  tty = installFakeTty({ columns, rows, isTTY: opts.isTTY })
  const bus = createFakeBus()
  let presentationHandler: ((event: UiPresentationEvent) => void) | undefined
  const transcript = new Transcript(bus as never, {
    onPresentationEvent: (handler) => {
      presentationHandler = handler
      return () => {
        presentationHandler = undefined
      }
    },
  })
  const calls: string[] = []
  const enqueued: string[] = []
  const copied: string[] = []
  let abortCalls = 0
  let slowGate: (() => void) | null = null
  let pinnedActivity: UiPresentationActivity | undefined
  const host: TuiHost = {
    bus: bus as never,
    getStatus:
      opts.getStatus ??
      (() => ({
        footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
        busy: false,
        ...(pinnedActivity ? { pinnedActivity } : {}),
      })),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    submit: async (text) => {
      calls.push(text)
      if (text === "/exit") return { quit: true }
      if (text === "/boom") throw new Error("gagal disengaja")
      // [P0 UI Security] Error yang memuat credential — jalur TUI TAK BOLEH
      // menampilkannya mentah (values = sentinel palsu, bukan credential nyata).
      if (text === "/leak")
        throw new Error(`proxy menolak: Authorization: Bearer ${SENTINEL_BEARER}`)
      if (text === "/slow") await new Promise<void>((r) => (slowGate = r))
    },
    enqueue: (text) => {
      enqueued.push(text)
      return true
    },
    copySelection: (text) => {
      copied.push(text)
      return true
    },
    abort: () => {
      abortCalls++
    },
    cycleWorkMode: opts.cycleWorkMode ?? (() => {}),
    togglePermissionMode: opts.togglePermissionMode ?? (() => {}),
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  const app = new TuiApp(transcript, host, { initialDraft: opts.initialDraft })
  lastApp = app
  const screenText = () => tty!.screen().join("\n")
  // Lepaskan turn lambat + beri kesempatan microtask finally (busy=false)
  // jalan SEBELUM key berikutnya diproses. Tanpa flush, send() harness
  // dispatch SINKRON sementara continuation promise masih antre → Ctrl+D
  // tiba saat busy=true dan diabakan (race, bukan bug App).
  const releaseSlow = async () => {
    slowGate?.()
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    bus,
    transcript,
    app,
    calls,
    enqueued,
    copied,
    abortCalls: () => abortCalls,
    releaseSlow,
    screenText,
    setPinnedActivity: (next: UiPresentationActivity | undefined) => {
      pinnedActivity = next
    },
    emitPresentation: (event: UiPresentationEvent) => presentationHandler?.(event),
  }
}
/**
 * Tunggu host menerima submit. Sejak diff per sel, perintah slash tidak punya
 * jejak byte "› /slow" (composer hanya menulis sel yang berubah lalu dibersihkan
 * saat submit); yang benar-benar dibuktikan test adalah turn mulai di host.
 */
async function waitForCall(calls: string[], text: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!calls.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`fake tty: submit "${text}" tidak diterima host dalam batas waktu`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("TuiApp", () => {
  test("Esc Esc idle membuka undo tanpa menambah command; mengetik membatalkan gesture", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.send(KEY.esc, 90)
    expect(calls).toEqual([])
    await tty!.send("x")
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    expect(calls).toEqual([])
    await tty!.send(KEY.esc, 90)
    await waitForCall(calls, "/undo")
    expect(calls).toEqual(["/undo"])
    app.requestQuit()
    await runP
  })

  test("draft awal multiline tetap literal, tidak otomatis submit atau membuka menu", async () => {
    const draft = "/help\nconst pesan = '中文';\nbaris terakhir"
    const { app, calls } = setup({ initialDraft: draft })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("baris terakhir")))
    expect(calls).toEqual([])
    await tty!.send(KEY.enter)
    await waitForCall(calls, draft)
    expect(calls).toEqual([draft])
    app.requestQuit()
    await runP
  })

  test("draft awal membuang escape terminal tanpa menghapus newline", async () => {
    const { app, calls } = setup({ initialDraft: "\x1b[31mmerah\x1b[0m\n\x1b]52;c;evil\x07aman" })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("aman")))
    await tty!.send(KEY.enter)
    await waitForCall(calls, "merah\naman")
    expect(tty!.all()).not.toContain("52;c;evil")
    app.requestQuit()
    await runP
  })

  test("boot: frame penuh tepat rows + enter/exit berpasangan (I17)", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(tty!.screen()).toHaveLength(14)
    expect(tty!.screen()[12]).toBe("") // spacer memisahkan composer dan footer
    expect(tty!.all()).toContain("\x1b[?1049h")
    expect(tty!.all()).toContain("\x1b[?1002h")
    expect(tty!.all()).toContain("\x1b[?1006h")
    expect(tty!.allErr()).toBe("")
    await tty!.send(KEY.ctrlD)
    const res = await runP
    expect(res.started).toBe(true)
    expect(res.frames).toBeGreaterThan(0)
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.all()).toContain("\x1b[?1006l")
    expect(tty!.all()).toContain("\x1b[?1002l")
    expect(tty!.all()).toContain("\x1b[?1000l")
  })
  test("initial paint exception memulihkan layar, raw mode, listeners, dan timer", async () => {
    const failure = new Error("status awal gagal")
    const { app, bus } = setup({
      getStatus: () => {
        throw failure
      },
    })
    const signalListeners = ["SIGTERM", "SIGHUP", "SIGINT", "exit"].map((event) =>
      process.listenerCount(event),
    )
    const busListeners = bus.listenerCount("turn:started")

    await expect(app.run()).rejects.toBe(failure)

    expect(tty!.all()).toContain("\x1b[?1049h")
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.all()).toContain("\x1b[?1006l")
    expect(tty!.isRaw()).toBe(false)
    expect(tty!.promptListeners()).toBe(0)
    expect(altScreenDepth()).toBe(0)
    expect(bus.listenerCount("turn:started")).toBe(busListeners)
    expect(
      ["SIGTERM", "SIGHUP", "SIGINT", "exit"].map((event) => process.listenerCount(event)),
    ).toEqual(signalListeners)
    const output = tty!.all()
    tty!.resize(61, 14)
    expect(tty!.all()).toBe(output)
    expect(tty!.failures()).toEqual([])
  })
  test("writer gagal di tengah frame: sync-update ditutup dan layar dipulihkan", async () => {
    const { app } = setup()
    const output = process.stdout as unknown as { write(chunk: string | Uint8Array): boolean }
    const originalWrite = output.write
    let failOnce = true
    output.write = (chunk) => {
      // Frame kini satu string; pembuka sync-update ada di dalamnya.
      if (failOnce && String(chunk).includes("\x1b[?2026h")) {
        failOnce = false
        throw new Error("stdout putus saat frame")
      }
      return originalWrite.call(process.stdout, chunk)
    }

    try {
      await expect(app.run()).rejects.toThrow("stdout putus saat frame")
    } finally {
      output.write = originalWrite
    }

    expect(tty!.all()).toContain("\x1b[?2026l")
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.isRaw()).toBe(false)
    expect(altScreenDepth()).toBe(0)
  })
  test("event repaint exception stops the app and performs full teardown", async () => {
    let fail = false
    const failure = new Error("status saat repaint gagal")
    const { app, bus } = setup({
      getStatus: () => {
        if (fail) throw failure
        return {
          footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
          busy: false,
        }
      },
    })
    const busListeners = bus.listenerCount("turn:started")
    const run = app.run()
    await tty!.ready()
    await tty!.waitForOutput((output) => output.includes("00.00.00"))
    fail = true
    bus.emit("turn:started", { turn: 1 })

    await expect(run).rejects.toBe(failure)

    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.isRaw()).toBe(false)
    expect(tty!.promptListeners()).toBe(0)
    expect(altScreenDepth()).toBe(0)
    expect(bus.listenerCount("turn:started")).toBe(busListeners)
    expect(tty!.failures()).toEqual([])
  })
  test("resize repaint exception memulihkan layar dan melepas listener", async () => {
    let fail = false
    const failure = new Error("status saat resize gagal")
    const { app, bus } = setup({
      getStatus: () => {
        if (fail) throw failure
        return {
          footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
          busy: false,
        }
      },
    })
    const busListeners = bus.listenerCount("turn:started")
    const run = app.run()
    await tty!.ready()
    await tty!.waitForOutput((output) => output.includes("00.00.00"))
    fail = true
    tty!.resize(61, 14)

    await expect(run).rejects.toBe(failure)

    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.isRaw()).toBe(false)
    expect(tty!.promptListeners()).toBe(0)
    expect(altScreenDepth()).toBe(0)
    expect(bus.listenerCount("turn:started")).toBe(busListeners)
    expect(tty!.failures()).toEqual([])
  })
  test("MINICODE_MOUSE_SELECTION=0 mematikan tracking TUI", async () => {
    const previous = process.env.MINICODE_MOUSE_SELECTION
    process.env.MINICODE_MOUSE_SELECTION = "0"
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    expect(tty!.all()).not.toContain("\x1b[?1002h")
    await tty!.send(KEY.ctrlD)
    await runP
    if (previous === undefined) delete process.env.MINICODE_MOUSE_SELECTION
    else process.env.MINICODE_MOUSE_SELECTION = previous
  })
  test("satu chunk input = satu paint (burst tidak melukis per karakter)", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const paints = () => tty!.all().split("\x1b[?2026h").length - 1
    const before = paints()
    await tty!.send("x".repeat(40))
    // Gagal-di-kode-lama: 40 karakter dalam satu chunk = 40 paint.
    expect(paints() - before).toBe(1)
    // v7.42: prompt diawali margin kiri 3 kolom (ASSISTANT_LEFT_MARGIN) mengikuti
    // teks asisten; spasi trailing & caret tetap seperti sebelumnya.
    expect(screenText()).toContain(`   minicode › ${"x".repeat(40)}`)
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("ketik + Enter: submit terpanggil + prompt menjadi history di transkrip", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("halo")
    await tty!.send(KEY.enter)
    // v7.29: prompt submit adalah history biasa — gema inline `minicode › halo`
    // di badan viewport, bukan card melayang di atas composer seperti v7.23.
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("minicode › halo")))
    expect(calls).toEqual(["halo"])
    const rows = tty!.screen()
    const echoIdx = rows.findIndex((line) => line.includes("minicode › halo"))
    expect(echoIdx).toBeGreaterThanOrEqual(0)
    // Tak ada band card terpisah: prompt hanya muncul SEKALI, tanpa baris
    // indented (`  halo`) dan tanpa box outline yang mengapitnya.
    expect(rows.filter((line) => line.includes("halo"))).toHaveLength(1)
    expect(rows).not.toContain("  halo")
    // v7.42: baris composer (dan gema transkrip) kini diawali 3 spasi margin;
    // lookup eksplisit memakai margin penuh agar tak tertukar dengan baris lain.
    const composerIdx = rows.indexOf("   minicode ›")
    expect(composerIdx).toBeGreaterThan(echoIdx)
    // Pemisah kosong pasca-gema tetap satu baris (bukan dua tepi card).
    expect(rows[echoIdx + 1]).toBe("")
    await new Promise((r) => setTimeout(r, 20))
    // v7.42: jangkar regex mengikuti margin baru — anchor ^…$ tetap utuh.
    expect(screenText()).toMatch(/^ {3}minicode ›$/m)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("slash command tetap dijalankan tetapi tak masuk transcript", async () => {
    const { app, calls, transcript, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/help")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(["/help"])
    expect(transcript.size()).toBe(0)
    // v7.42: cek ketiadaan gema slash memakai baris prompt bermargin 3 kolom.
    expect(screenText()).not.toContain("   minicode › /help")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("submit melempar → baris error tampil, sesi lanjut (tak ada jalur diam)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/boom")
    await tty!.send(KEY.enter)
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("gagal disengaja")))
    expect(calls).toEqual(["/boom"])
    await tty!.send(KEY.ctrlD)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("[P0] error memuat credential → TUI tak menampilkan tokennya", async () => {
    // Jalur TUI NYATA (App.doSubmit → host.submit melempar). Kode lama
    // pushing `e.message` mentah → bearer token tampil utuh di layar.
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/leak")
    await tty!.send(KEY.enter)
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("proxy menolak")))
    // Yang diuji adalah APA YANG TERLIHAT, bukan byte mentah: diff per sel
    // boleh memecah teks menjadi beberapa run CUP tanpa mengubah layar.
    const shown = screenText()
    expect(shown).not.toContain(SENTINEL_BEARER)
    expect(shown).toContain("[redacted]")
    // Bagian yang aman tetap tampil — pesan error tak jadi generik.
    expect(shown).toContain("proxy menolak")
    expect(calls).toEqual(["/leak"])
    await tty!.send(KEY.ctrlD)
    for (let i = 0; i < 5; i++) await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("/exit via submit {quit} keluar + layar dikembalikan", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/exit")
    await tty!.send(KEY.enter)
    const res = await runP
    expect(res.started).toBe(true)
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("Ctrl+D baris berisi diabaikan; baris kosong keluar (I19)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("x")
    await tty!.send(KEY.ctrlD)
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(calls).toEqual([])
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("timer monokrom: format HH.MM.SS tetap, tanpa perbedaan warna idle vs busy", async () => {
    // v7.29: warna nyala by default — paksa MINICODE_COLOR=0 supaya assertions
    // "tak ada SGR redup/putih" tetap menguji jalur mono.
    process.env.MINICODE_COLOR = "0"
    try {
      const { app, calls, releaseSlow } = setup()
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      // Idle: timer konstan. Tak ada SGR redup (90) yang dulu menandai idle.
      expect(tty!.all()).toContain("00.00.00")
      expect(tty!.all()).not.toContain("\x1b[90m")
      expect(formatTimer(0)).toBe("00.00.00")

      await tty!.send("/slow")
      await tty!.send(KEY.enter)
      await waitForCall(calls, "/slow")
      // Busy: format timer berjalan menurut elapsed, tapi tanpa SGR putih (37).
      expect(formatTimer(42_000)).toBe("00.00.42")
      expect(timerHighlight(42_000)).toBe("seconds")
      expect(tty!.screen().join("\n")).toContain("00.00.")
      expect(tty!.all()).not.toContain("\x1b[37m")
      expect(tty!.all()).not.toContain("\x1b[90m")
      await releaseSlow()
      await tty!.send(KEY.ctrlD)
      await runP
    } finally {
      delete process.env.MINICODE_COLOR
    }
  })
  test("status bar: kedua mode + konteks di baris dasar (I13)", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const frame = tty!.screen()
    const last = frame[frame.length - 1]!
    // [mode-architecture] footer menampilkan kedua mode dengan label proper.
    expect(last).toContain("Discuss")
    expect(last).toContain("Auto")
    expect(last).toContain("1k")
    expect(last.indexOf("1k")).toBeLessThan(last.lastIndexOf("Auto"))
    expect(frame[frame.length - 2]).toBe("")
    expect(last).toContain("00.00.00")
    expect(last).not.toContain("•")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("busy tanpa event: composer bersih (prompt saja), timer di footer tanpa dots", async () => {
    // v7.29 (clean composer): status kerja TIDAK lagi disuntik ke composer.
    // Yang boleh tampil di sana hanya prompt/draft; timer + spark pindah ke
    // footer. Test lama mengunci dots di slot composer — dots itu kini dihapus,
    // jadi yang dijaga adalah invariant baru: composer tetap bersih saat busy.
    const { app, calls, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    const composer = () => tty!.screen().find((line) => line.includes("minicode ›")) ?? ""
    const footer = () => tty!.screen().find((line) => /\d{2}\.\d{2}\.\d{2}/.test(line)) ?? ""
    // v7.42: margin 3 kolom mengikuti promptFirst(); composer TETAP bersih —
    // tanpa dots/label/elapsed. Hanya leading margin baris prompt yang berubah.
    expect(composer()).toBe("   minicode ›")
    expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(false)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    expect(footer()).not.toMatch(/\.{1,3}\s+00.00.00/)
    await new Promise((r) => setTimeout(r, 1100))
    // Timer berjalan di footer dengan format tetap HH.MM.SS; composer tak berubah.
    expect(footer()).toMatch(/\d{2}\.\d{2}\.\d{2}/)
    expect(footer()).not.toMatch(/\d+s/)
    // v7.42: samakan margin prompt dengan layout baru; invariant bersih dipertahankan.
    expect(composer()).toBe("   minicode ›")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("timer format fixed HH.MM.SS", () => {
    expect(formatTimer(0)).toBe("00.00.00")
    expect(formatTimer(1_999)).toBe("00.00.01")
    expect(formatTimer(60_000)).toBe("00.01.00")
    expect(formatTimer(3_600_000)).toBe("01.00.00")
  })
  test("thinking dots mengikuti clock, bukan paint count", () => {
    expect(thinkingDots(0, 0, false)).toBe("...")
    expect(thinkingDots(200, 0, false)).toBe("..")
    expect(thinkingDots(400, 0, false)).toBe(".")
    expect(thinkingDots(600, 0, false)).toBe("..")
    expect(thinkingDots(800, 0, false)).toBe("...")
    expect(thinkingDots(9999, 0, true)).toBe("...")
  })
  test("busy + motion off: composer tanpa dots, footer tetap tampil", async () => {
    // v7.29: motion off hanya membekukan animasi spark di footer. Ia TIDAK
    // boleh mengembalikan dots ke composer — dots sudah dihapus total dari
    // jalur status. Yang dijaga: composer tetap bersih dan footer tetap ada.
    const previous = process.env.MINICODE_MOTION
    process.env.MINICODE_MOTION = "0"
    try {
      const { app, bus, calls, releaseSlow, screenText } = setup()
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      await tty!.send("/slow")
      await tty!.send(KEY.enter)
      await waitForCall(calls, "/slow")
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm" } })
      await new Promise((r) => setTimeout(r, 40))
      const composer = () => tty!.screen().find((line) => line.includes("minicode ›")) ?? ""
      const first = composer()
      // v7.42: margin 3 kolom pada prompt; composer tanpa dots tetap dijaga.
      expect(first).toBe("   minicode ›")
      expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(false)
      await new Promise((r) => setTimeout(r, 500))
      expect(composer()).toBe(first)
      // Footer (timer + mode) tetap tampil walau spark dibekukan motion off.
      expect(tty!.screen().some((line) => /\d{2}\.\d{2}\.\d{2}/.test(line))).toBe(true)
      expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
      await releaseSlow()
      await tty!.send(KEY.ctrlD)
      await runP
    } finally {
      if (previous === undefined) delete process.env.MINICODE_MOTION
      else process.env.MINICODE_MOTION = previous
    }
  })
  test("reasoning dan text: composer tak berubah, label tak pernah tampil", async () => {
    // v7.29: reasoning/text tak punya jalur ke composer lagi. Reasoning
    // diproses Transcript sendiri; provider:text hanya mengukur jeda antar
    // chunk untuk kecepatan spark (streamIntervalMs, tersimpan di footer).
    const { app, bus, calls, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    const composer = () => tty!.screen().find((line) => line.includes("minicode ›")) ?? ""

    bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm" } })
    await new Promise((r) => setTimeout(r, 40))
    const before = composer()
    // v7.42: prompt bermargin 3 kolom; reasoning/text tak menyusup ke composer.
    expect(before).toBe("   minicode ›")
    expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(false)
    expect(screenText()).not.toContain("… thinking")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)

    // Jangan `tty.clear()` di sini: dengan diff per sel, clear membuat frame
    // baru hanya berisi sel yang berubah (composer tak ditulis ulang), sehingga
    // assertion "composer tetap ada" jadi artefak harness. Tunggu konten baru.
    bus.emit("provider:text", { text: "jawaban" })
    // Diff per sel hanya menulis ulang sel yang berubah, jadi footer "00" yang
    // sudah ada di layar tidak muncul lagi di byte baru. Tunggu konten barunya.
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("jawaban")))
    // Teks masuk transkrip, tapi composer tetap bersih — tak ada dots/label.
    expect(composer()).toBe(before)
    expect(tty!.screen().some((line) => /^\s*\.{1,3}\s*$/.test(line))).toBe(false)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("activity snapshot tak merender di composer; tool hanya dari event presentasi", async () => {
    // v7.29: pinnedActivity sudah TIDAK dipakai App untuk menggambar composer.
    // Baris tool lahir dari presentation event di Transcript, bukan dari
    // snapshot getStatus — jadi composer tetap bersih walau snapshot berisi tool.
    const { app, calls, releaseSlow, screenText, setPinnedActivity } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    setPinnedActivity({
      toolCallId: "call-1",
      name: "read_file",
      target: "src/server.ts",
      status: "running",
      tsStart: Date.now() - 3000,
    })
    app.repaint()
    const composer = tty!.screen().find((line) => line.includes("minicode ›")) ?? ""
    // v7.42: margin 3 kolom pada prompt; snapshot tool tetap tak merender di sini.
    expect(composer).toBe("   minicode ›")
    expect(composer).not.toContain("read_file")
    expect(composer).not.toMatch(/\(\d+s\)/)
    const footer = tty!.screen().find((line) => /\d{2}\.\d{2}\.\d{2}/.test(line)) ?? ""
    expect(footer).toMatch(/\d{2}\.\d{2}\.\d{2}/)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b|\d+s/)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("PgUp/PgDn scroll viewport; ketikan baru kembali ke ekor (I18)", async () => {
    const { app, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("baris-29")))
    expect(screenText()).not.toContain("baris-0")
    // Satu halaman ke atas: ekor hilang, baris tengah tampil.
    await tty!.send(KEY.pgUp)
    expect(screenText()).not.toContain("baris-29")
    expect(screenText()).toContain("baris-20")
    // Dua halaman lagi → kepala terlihat.
    await tty!.send(KEY.pgUp)
    await tty!.send(KEY.pgUp)
    expect(screenText()).toContain("baris-0")
    // Satu halaman ke bawah menjauhi kepala…
    await tty!.send(KEY.pgDown)
    expect(screenText()).not.toContain("baris-0")
    // …ketikan baru kembali ke ekor.
    await tty!.send("y")
    expect(screenText()).toContain("baris-29")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("PgDn mencapai ekor sejati tanpa langkah no-op (v7.35)", async () => {
    const { app, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const TOTAL = 34
    transcript.pushInfo(
      Array.from({ length: TOTAL }, (_, i) => `baris-${String(i).padStart(2, "0")}`),
    )
    await tty!.send("x") // ketikan → followTail, ekor tampil
    await tty!.waitForScreen((frame) => frame.some((l) => l.includes("baris-33")))
    // viewH = jumlah baris transkrip terlihat saat ekor (viewport penuh).
    const viewH = (screenText().match(/baris-\d+/g) ?? []).length
    expect(viewH).toBeGreaterThan(1)
    const maxTail = TOTAL - viewH
    const steps = Math.ceil(maxTail / viewH)
    // Konfigurasi ini sengaja membedakan page baru (viewH) dari lama (viewH-1):
    // dengan page lama, `steps` kali PgDn baru maju steps*(viewH-1) < maxTail,
    // sehingga ekor tak tercapai pada langkah terakhir (off-by-one).
    expect(steps * (viewH - 1)).toBeLessThan(maxTail)
    await tty!.send(KEY.backspace) // prompt kosong → Home = kepala
    await tty!.send(KEY.home)
    expect(screenText()).toContain("baris-00")
    for (let i = 0; i < steps; i++) await tty!.send(KEY.pgDown)
    // Tepat sejumlah langkah penuh ekor HARUS tampil — bukan satu langkah lagi.
    expect(screenText()).toContain("baris-33")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("mouse wheel scroll transkrip tanpa memindahkan histori", async () => {
    const { app, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("baris-29")))
    await tty!.send(KEY.mouseWheelUpSgr)
    expect(screenText()).not.toContain("baris-29")
    // v7.42: baris prompt kini diawali margin 3 kolom.
    expect(screenText()).toContain("   minicode › x")
    await tty!.send(KEY.mouseWheelDownSgr)
    expect(screenText()).toContain("baris-29")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("history ↑ melompati entri command tanpa tersangkut (menu tak terbuka saat recall)", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const submit = async (text: string) => {
      await tty!.send(text)
      await tty!.send(KEY.enter)
    }
    await submit("alpha")
    await submit("/help")
    await submit("omega")
    // Ketiganya masuk (perintah juga masuk composer history — komentar app.ts:750).
    expect(calls).toEqual(["alpha", "/help", "omega"])

    // ↑×3: omega → /help → alpha. Bug awal: recall "/help" membuka menu command
    // (withLine menyetel menuOpen = line.startsWith("/")), lalu ↑↓ berikutnya
    // memindah SELEKSI menu, bukan history → user terkunci tak bisa menyeberang.
    await tty!.send(KEY.up)
    await tty!.send(KEY.up)
    await tty!.send(KEY.up)

    // "/help" adalah command, sehingga TIDAK di-echo ke transkrip — satu-satunya
    // kemunculan "minicode › /help" adalah composer. Absennya berarti navigasi
    // sukses menyeberangi entri command menuju prompt terlama (bukan tersangkut).
    // v7.42: samakan dengan margin 3 kolom pada baris prompt composer.
    expect(screenText()).not.toContain("   minicode › /help")
    await tty!.send(KEY.esc) // kosongkan baris recall agar Ctrl+D (baris kosong) bisa quit
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag transcript + Ctrl+C menyalin selection logis", async () => {
    const { app, transcript, copied } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x")
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("baris-29")))
    const screen = tty!.screen()
    const visible = screen
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((item) => item.line.startsWith("baris-"))
    expect(visible.length).toBeGreaterThan(1)
    const start = visible[0]!.row
    const end = visible[Math.min(2, visible.length - 1)]!.row
    const endX = (visible[Math.min(2, visible.length - 1)]!.line.length ?? 0) + 1
    await tty!.send(`\x1b[<0;1;${start}M`)
    await tty!.send(`\x1b[<32;${endX};${end}M`)
    await tty!.send(`\x1b[<0;${endX};${end}m`)
    expect(tty!.all()).toContain("\x1b[7m")
    await tty!.send(KEY.ctrlC)
    expect(copied[0]).toBe("baris-21\nbaris-22\nbaris-23")
    // v7.30: kwitansi salin di footer (toast), BUKAN baris transkrip permanen.
    const rows = tty!.screen()
    expect(rows[rows.length - 1]).toContain("selection copied")
    expect(rows.slice(0, -1).join("\n")).not.toContain("selection copied")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag selection tetap bisa dipakai saat turn busy", async () => {
    const { app, transcript, calls, copied, releaseSlow } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `busy-${i}`))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    const visible = tty!
      .screen()
      .map((line, index) => ({ line, row: index + 1 }))
      .filter((item) => item.line.startsWith("busy-"))
    const start = visible[0]!.row
    const end = visible[1]!.row
    const endX = visible[1]!.line.length + 1
    await tty!.send(`\x1b[<0;1;${start}M`)
    await tty!.send(`\x1b[<32;${endX};${end}M`)
    await tty!.send(`\x1b[<0;${endX};${end}m`)
    await tty!.send(KEY.ctrlC)
    expect(copied[0]).toContain("busy-")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("klik prompt memindahkan kursor tanpa mengubah histori", async () => {
    const { app, copied } = setup({ rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("hello")
    // v7.42: prefix prompt kini 14 kolom (3 margin + `minicode › ` 11 kolom).
    // Klik kolom 17 = tepat di antara "he" dan "llo" — grapheme yang sama seperti
    // kolom 14 pada layout lama (geser +3 mengikuti displayWidth margin).
    const promptRow = tty!.screen().findIndex((line) => line.includes("minicode › hello")) + 1
    expect(promptRow).toBeGreaterThan(0)
    await tty!.send(`\x1b[<0;17;${promptRow}M\x1b[<0;17;${promptRow}m`)
    await tty!.send("X")
    expect(tty!.screen().join("\n")).toContain("   minicode › heXllo")
    expect(copied).toEqual([])
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Up/Down = histori (bukan scroll) (I18)", async () => {
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("satu")
    await tty!.send(KEY.enter)
    // v7.29: gema prompt kini baris transkrip `minicode › satu`, bukan card
    // indented `  satu` — tunggu kemunculannya sebelum menekan Up.
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("minicode › satu")))
    expect(calls).toEqual(["satu"])
    await tty!.send(KEY.up)
    await tty!.send(KEY.enter)
    // Polling calls (gema "› satu" tak bisa dibedakan di byte).
    const deadline = Date.now() + 2000
    while (calls.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(calls).toEqual(["satu", "satu"])
    await tty!.send(KEY.ctrlD)
    await runP
  })
  describe("dropdownWindowStart (A1: jendela menu mengikuti sel)", () => {
    test("selapapun dalam [0,total) selalu tampil saat total > visible", () => {
      const visible = 8
      const total = 24
      for (let sel = 0; sel < total; sel++) {
        const start = dropdownWindowStart(sel, visible, total)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(start + visible).toBeLessThanOrEqual(total)
        expect(sel).toBeGreaterThanOrEqual(start)
        expect(sel).toBeLessThan(start + visible)
      }
    })
    test("total <= visible → start 0 (semua tampil)", () => {
      expect(dropdownWindowStart(3, 8, 5)).toBe(0)
    })
    test("sel terakhir tampil di baris terakhir jendela", () => {
      const start = dropdownWindowStart(23, 8, 24)
      expect(start).toBe(16)
      expect(23).toBeLessThan(start + 8)
    })
    test("sel = -1 (belum ada pilihan) → jendela di atas", () => {
      expect(dropdownWindowStart(-1, 8, 24)).toBe(0)
    })
  })

  test("dropdown / hanya menampilkan nama command, tanpa slash atau judul (I16)", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/")
    // Overlay memakai border/padding; marker `›` di kolom tetap, nama tanpa slash.
    const menu = menuNames(screenText())
    expect(menu).toContain("model")
    expect(menu).toContain("help")
    expect(menu).toContain("exit")
    expect(menu).not.toContain("/model")
    expect(screenText()).not.toContain("commands")
    // Esc butuh flush lone-ESC (~50ms) — settle pendek membuatnya hilang.
    await tty!.send(KEY.esc, 90)
    expect(screenText().split("\n")).not.toContain("model")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("turn berjalan: ketikan tampil, Enter mengantri (bukan submit kedua)", async () => {
    const { app, calls, enqueued, releaseSlow, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    // Busy: composer hidup — draft terlihat di layar selagi model bekerja.
    await tty!.send("kedua")
    expect(screenText()).toContain("kedua")
    await tty!.send(KEY.enter)
    // Antre lewat host.enqueue: TIDAK ada turn kedua yang balapan dengan yang
    // sedang jalan (calls tetap satu), dan draft dibersihkan.
    expect(calls).toEqual(["/slow"])
    expect(enqueued).toEqual(["kedua"])
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("busy + draft: composer tetap bersih, progres tak ada di composer", async () => {
    // v7.29: draf dan status dulu berbagi satu baris composer. Kini statusnya
    // DIHAPUS total — yang tampil cuma `minicode › draf`. Tinggi frame stabil
    // dan indikator busy pindah ke footer (timer berjalan).
    const { app, calls, enqueued, releaseSlow, screenText, emitPresentation } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const rowsBefore = tty!.screen().length

    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    emitPresentation({ type: "step.started", seq: 1, turnId: 1, step: 1, total: 5 })

    await tty!.send("draf")
    await new Promise((r) => setTimeout(r, 40))
    const frame = tty!.screen()
    expect(frame).toHaveLength(rowsBefore)
    const draftRow = frame.find((line) => line.includes("minicode › draf")) ?? ""
    // v7.42: margin 3 kolom mengikuti promptFirst(); draf & larangan progres
    // ("step 2/5") tetap diuji persis seperti sebelumnya.
    expect(draftRow).toBe("   minicode › draf")
    // Tak ada progres "step 2/5" di composer maupun di layar.
    expect(screenText()).not.toContain("step 2/5")
    // Indikator busy ada di footer: timer berjalan (bukan di composer).
    expect(frame.at(-1) ?? "").toMatch(/\d{2}\.\d{2}\.\d{2}/)

    // Steering tetap jalan: Enter mengantri draft, bukan submit kedua.
    await tty!.send(KEY.enter)
    expect(enqueued).toEqual(["draf"])
    expect(calls).toEqual(["/slow"])

    await releaseSlow()
    await new Promise((r) => setTimeout(r, 20))
    expect(screenText()).not.toContain("step 2/5")
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("busy + draft: tool/elapsed tak masuk composer (tetap bersih)", async () => {
    // v7.29: snapshot tool (pinnedActivity) tak pernah menggambar baris progres
    // di composer. Draf tetap SATU baris; nama tool dan elapsed tak menyusup.
    const { app, calls, releaseSlow, setPinnedActivity, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const rowsBefore = tty!.screen().length
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    setPinnedActivity({
      toolCallId: "call-1",
      name: "read_file",
      target: "src/server.ts",
      status: "running",
      tsStart: Date.now() - 3000,
    })
    await tty!.send("draf")
    await new Promise((r) => setTimeout(r, 40))
    const frame = tty!.screen()
    expect(frame).toHaveLength(rowsBefore)
    const draftRow = frame.find((line) => line.includes("minicode › draf")) ?? ""
    // v7.42: margin 3 kolom pada baris prompt; larangan tool/elapsed tetap utuh.
    expect(draftRow).toBe("   minicode › draf")
    // Nama tool dan elapsed TIDAK boleh muncul di baris draft.
    expect(draftRow).not.toContain("read_file")
    expect(draftRow).not.toMatch(/\(\d+s\)/)
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    await tty!.send(KEY.ctrlU)
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("turn berjalan: Escape tetap abort, bukan membersihkan draft", async () => {
    const { app, calls, enqueued, abortCalls, releaseSlow } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    await tty!.send("draf")
    await tty!.send(KEY.esc, 90)
    expect(abortCalls()).toBe(1)
    expect(enqueued).toEqual([])
    await releaseSlow()
    // Draft sengaja TIDAK dibuang oleh Esc (Esc = abort turn, bukan editor):
    // jadi ia masih ada saat idle → hapus dulu sebelum Ctrl+D keluar.
    for (let i = 0; i < "draf".length; i++) await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("non-TTY → started:false (fallback jujur, tanpa alt-screen)", async () => {
    const { app } = setup({ isTTY: false })
    const res = await app.run()
    expect(res.started).toBe(false)
    expect(tty!.all()).not.toContain("\x1b[?1049h")
  })
  test("terminal sempit (rows<10) → started:false", async () => {
    const { app } = setup({ rows: 8 })
    const res = await app.run()
    expect(res.started).toBe(false)
    expect(tty!.all()).not.toContain("\x1b[?1049h")
  })
  test("suspend menahan flush lone-ESC: popup tak tertimpa full-paint", async () => {
    // Gagal-di-kode-lama: timer 50ms lone-ESC yang dipersenjatai SEBELUM
    // suspend menembak sesudah popup terbuka → paintCurrent menimpa region
    // popup + memutasi state. Settle 10ms < flush 50ms: timer masih pending
    // saat suspend() dipanggil sinkron sesudahnya.
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("x")
    await tty!.send(KEY.esc, 10)
    app.suspend()
    await new Promise((r) => setTimeout(r, 120))
    app.resume()
    expect(screenText()).toContain("› x")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("suspend: input dibekukan tanpa scrim warna; resume: kembali normal", async () => {
    // v7.29: di mode warna scrimMode() = "bg", jadi test "tanpa scrim" ini
    // dijalankan dengan MINICODE_COLOR=0. Yang dijaga: pembekuan input.
    process.env.MINICODE_COLOR = "0"
    try {
      const { app, screenText } = setup()
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      expect(app.isSuspended()).toBe(false)
      app.suspend()
      expect(app.isSuspended()).toBe(true)
      const dimmedFrame = tty!.screen()
      expect(dimmedFrame[dimmedFrame.length - 2]).toBe("")
      expect(dimmedFrame[dimmedFrame.length - 1]).toContain("Discuss")
      expect(dimmedFrame[dimmedFrame.length - 1]).toContain("Auto")
      // Mono: scrimMode() = "none", jadi tak ada SGR redup/backdrop.
      expect(tty!.all()).not.toContain("\x1b[2m")
      // Ketikan selama suspend TIDAK masuk baris input (anti double-handling
      // dengan view popup yang memegang stdin).
      await tty!.send("x")
      expect(screenText()).not.toContain("› x")
      app.resume()
      expect(app.isSuspended()).toBe(false)
      await tty!.send("y")
      expect(screenText()).toContain("› y")
      await tty!.send(KEY.backspace)
      await tty!.send(KEY.ctrlD)
      await runP
    } finally {
      delete process.env.MINICODE_COLOR
    }
  })
  test("suspend berlebih/resume berlebih idempoten", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    app.suspend()
    app.suspend()
    expect(app.isSuspended()).toBe(true)
    app.resume()
    expect(app.isSuspended()).toBe(true)
    app.resume()
    expect(app.isSuspended()).toBe(false)
    // Resume tanpa suspend sebelumnya = no-op, sesi jalan terus.
    app.resume()
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("busy: Tab/Shift+Tab tetap ditahan, tapi ketikan hidup & Enter antre", async () => {
    let cycles = 0
    const { app, calls, enqueued, releaseSlow, screenText } = setup({
      cycleWorkMode: () => {
        cycles++
      },
    })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    // Tab (ganti WorkMode) tetap ditahan saat busy: memutasi mode di tengah
    // turn = keputusan yang tak boleh terjadi tanpa turn berhenti dulu.
    await tty!.send(KEY.tab)
    await new Promise((r) => setTimeout(r, 60))
    expect(cycles).toBe(0)
    // Ketikan hidup (draft terlihat) dan Enter mengantri, bukan submit kedua.
    await tty!.send("zzz")
    expect(screenText()).toContain("zzz")
    await tty!.send(KEY.enter)
    expect(enqueued).toEqual(["zzz"])
    expect(calls).toEqual(["/slow"])
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("busy + Ctrl+D baris-kosong = abort + quit (jalan keluar abort macet)", async () => {
    // Gagal-di-kode-lama: busy memblokir SEMUA termasuk Ctrl+D — provider
    // non-kooperatif = sesi hanya bisa dibunuh kill -9.
    const { app, calls } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    expect(calls).toEqual(["/slow"])
    await tty!.send(KEY.ctrlD)
    const res = await runP
    expect(res.started).toBe(true)
    expect(tty!.all()).toContain("\x1b[?1049l")
    void app
  })
  test("busy + Esc ganda = abort lalu quit; tunggal = abort saja", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    // Esc pertama: abort, tetap hidup (tanpa EXIT).
    await tty!.send(KEY.esc, 90)
    await new Promise((r) => setTimeout(r, 100))
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(screenText()).toContain("abort sent")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running|Stopping)\b/)
    // Esc kedua <1.5 dtk: quit.
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("H4: turn abort selesai cepat → Esc kedua tetap quit, bukan /undo", async () => {
    // Gagal-di-kode-lama: requestAbort() early-return saat !isBusy(), jadi Esc
    // kedua jatuh ke cabang idle dan tak pernah mengakhiri sesi (bisa memicu
    // gesture /undo). Jendela 1.5 dtk harus dicek SEBELUM split busy/idle.
    const { app, calls, releaseSlow } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    // Esc pertama mengirim abort.
    await tty!.send(KEY.esc, 90)
    // Turn selesai LEBIH CEPAT dari jari user menekan Esc kedua.
    await releaseSlow()
    await new Promise((r) => setTimeout(r, 20))
    // Esc kedua masih dalam jendela abort → quit.
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(calls).toEqual(["/slow"]) // tak ada /undo yang ikut terkirim
  })
  test("busy + Ctrl+C diabaikan; Esc yang abort", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    await tty!.send(KEY.ctrlC, 90)
    expect(screenText()).not.toContain("abort sent")
    await tty!.send(KEY.esc, 90)
    expect(screenText()).toContain("abort sent")
    expect(screenText()).not.toMatch(/\b(Working|Thinking|Running|Stopping)\b/)
    await tty!.send(KEY.esc, 90)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })

  test("terminal 40 kolom: hint abort (id 51 kolom) dipotong, frame tetap <= cols", async () => {
    // Gagal-di-kode-lama: baris indikator tak dipotong → lebih lebar dari
    // terminal → auto-wrap → frame rows+1 → seluruh diff CUP meleset.
    const { app, calls, screenText } = setup({ columns: 40, rows: 12 })
    // installFakeTty mereset locale ke en → set SESUDAH setup.
    setSessionLocale("id")
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    await tty!.send(KEY.esc, 90)
    expect(screenText()).toContain("abort terkirim")
    for (const line of tty!.screen()) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    await tty!.send(KEY.esc, 90)
    await runP
  })

  test("repaint() selama suspend tidak menimpa region popup", async () => {
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const before = tty!.screen().join("\n")
    app.suspend()
    app.repaint()
    await new Promise((r) => setTimeout(r, 40))
    expect(tty!.screen().join("\n")).toBe(before)
    app.resume()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("stream bus me-repaint live tanpa keypress (layar tak buta saat turn)", async () => {
    const { app, bus } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    tty!.clear()
    bus.emit("provider:text", { text: "token-live" })
    bus.emit("turn:completed", {})
    // Tanpa satu pun keypress: teks sudah di layar (coalesce 30ms).
    await tty!.waitForOutput((o) => o.includes("token-live"), 2000)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("scroll ke atas + stream = indikator, ketikan kembali ke ekor", async () => {
    const { app, bus, transcript, screenText } = setup({ rows: 12 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `lama-${i}`))
    await tty!.send("x")
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("lama-19")))
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.pgUp)
    expect(screenText()).not.toContain("lama-19")
    bus.emit("provider:text", { text: "baru-0" })
    bus.emit("turn:completed", {})
    await tty!.waitForScreen((frame) => frame.some((line) => line.includes("below")))
    expect(screenText()).toContain("PgDn")
    // Ketikan baru kembali ke ekor + indikator hilang.
    await tty!.send("y")
    expect(screenText()).not.toContain("below")
    expect(screenText()).toContain("baru-0")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("kursor baris-wrap tengah: kolom tepat, bukan EOL", async () => {
    // Gagal-di-kode-lama: baris tengah selalu diparkir di ujung baris.
    // v7.42: prefix 14 kolom (3 margin + "minicode › " 11) + 50 "a" pada
    // terminal 30 kolom → baris 30/30/4; prefix mengisi 14 kolom di baris 0,
    // sehingga 20 'left' dari ekor mendarat di grapheme ke-30 pada baris visual 1.
    // Kolom kursor = 0 (tanpa prefix lanjutan) + 14 grapheme + 1 = 15, baris 11.
    const { app } = setup({ columns: 30, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    await tty!.send("a".repeat(50))
    for (let i = 0; i < 20; i++) await tty!.send(KEY.left)
    expect(tty!.all()).toContain("\x1b[11;15H")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("input panjang: jendela mengikuti kursor (bukan ekor buta)", async () => {
    // 8 baris logis > MAX 5: ekor tampil; Home → kursor ke atas → jendela
    // gulir ke atas. Gagal-di-kode-lama: kursor diparkir di baris salah.
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7")
    expect(screenText()).toContain("l7")
    expect(screenText()).toContain("l3")
    expect(screenText()).not.toContain("l0")
    await tty!.send(KEY.home)
    expect(screenText()).toContain("l0")
    expect(screenText()).not.toContain("l7")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
    void app
  })
  test("idle awal: prompt tampil; Esc membersihkan isi, prompt tetap tampil", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    // v7.42: anchor ^…$ kini menyertakan margin 3 kolom; prompt idle tetap ada.
    expect(screenText()).toMatch(/^ {3}minicode ›$/m)
    expect(screenText()).toContain("00.00.00")
    await tty!.send(KEY.left)
    expect(screenText()).toMatch(/^ {3}minicode ›$/m)
    // Audit 2026-11-12 (I13): prompt idle TIDAK boleh hilang setelah Esc —
    // layar tanpa prompt terbaca sebagai sesi mati.
    await tty!.send(KEY.esc, 90)
    expect(screenText()).toMatch(/^ {3}minicode ›$/m)
    await tty!.send("a")
    // v7.42: baris prompt diawali 3 spasi margin.
    expect(screenText()).toContain("   minicode › a")
    await tty!.send(KEY.backspace)
    expect(screenText()).toContain("   minicode ›")
    expect(screenText()).not.toContain("ask anything")
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("resume merebut raw mode: dropdown / muncul setelah popup tutup", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    // Simulasi view popup tutup: cleanup view mematikan raw mode.
    app.suspend()
    ;(process.stdin as unknown as { setRawMode(v: boolean): void }).setRawMode(false)
    app.resume()
    // Mekanisme: listener App terpasang saat raw (bukan cooked). Tanpa
    // rebut-raw ini 0 — di terminal nyata ketikan ditahan sampai Enter.
    expect(tty!.promptListeners()).toBe(1)
    // Ujung-ke-ujung: ketik "/" → dropdown rekomendasi muncul lagi.
    await tty!.send("/")
    const menu = menuNames(screenText())
    expect(menu).toContain("model")
    expect(menu).not.toContain("/model")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
  test("terminal menciut tengah sesi: bingkai jujur + hanya Ctrl+D jalan", async () => {
    // Gagal-di-kode-lama: layout rusak (wrap pecah, kursor liar) tanpa jalan
    // keluar yang terlihat.
    const { app } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    tty!.resize(60, 5)
    await tty!.waitForOutput((o) => o.includes("too small"))
    // Ketikan normal diabakan saat menciut.
    await tty!.send("zzz")
    // Ctrl+D tetap keluar.
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("terminal menciut saat busy: PgUp mempertahankan posisi baca dan Esc abort", async () => {
    const { app, transcript, calls, releaseSlow, screenText, abortCalls } = setup({ rows: 14 })
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `history-${i}`))
    const run = app.run()
    await tty!.ready()
    await tty!.waitForOutput((output) => output.includes("history-29"))
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    // Marker transkrip yang sama sempat muncul saat teks masih di composer;
    // tunggu bukti submit host agar abort menguji turn yang benar-benar aktif.
    await Bun.sleep(0)
    expect(calls).toContain("/slow")

    tty!.resize(60, 5)
    await tty!.waitForOutput((output) => output.includes("too small"))
    for (let i = 0; i < 5; i++) await tty!.send(KEY.pgUp)
    await tty!.send(KEY.esc, 90)
    expect(abortCalls()).toBeGreaterThan(0)
    expect(tty!.all()).not.toContain("\x1b[?1049l")

    tty!.resize(60, 14)
    expect(screenText()).not.toContain("history-29")
    await tty!.send(KEY.ctrlD)
    await releaseSlow()
    await run
    expect(tty!.all()).toContain("\x1b[?1049l")
  })
  test("releaseTerminal keluar alt-screen + cooked; reacquire hidup lagi", async () => {
    // Gagal-di-kode-lama: spawn anak mewarisi buffer ?1049h + raw mode
    // (double-ENTER, EXIT anak merobek buffer parent, stdin macet).
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    app.suspend()
    app.releaseTerminal()
    expect(tty!.all()).toContain("\x1b[?1049l")
    expect(tty!.promptListeners()).toBe(0)
    // Hidup lagi (jalur spawn gagal): ENTER baru + input jalan.
    expect(app.reacquireTerminal()).toBe(true)
    app.resume()
    expect(tty!.promptListeners()).toBe(1)
    await tty!.send("/")
    const menu = menuNames(screenText())
    expect(menu).toContain("model")
    expect(menu).not.toContain("/model")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })

  test("zero-state: transkrip kosong tanpa logo/hint; composer + footer tetap tampil", async () => {
    const { app, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const rows = tty!.screen()
    const bodyText = rows.slice(0, -2).join("\n")
    // Renderer flat: logo 14x9 dan hint idle dihapus — transkrip awalnya polos.
    expect(bodyText).not.toContain("▄▄▄")
    expect(bodyText).not.toContain("██▀▀█▄")
    expect(bodyText).not.toContain("▀▀▀")
    expect(bodyText).not.toContain("type a message to start")
    expect(bodyText).not.toContain("/help for commands")
    expect(bodyText).not.toContain("Shift+Tab")
    // v7.42: composer tetap hidup; baris prompt kini diawali margin 3 kolom.
    expect(rows.some((r) => r.includes("   minicode ›"))).toBe(true)
    expect(rows[rows.length - 1]).toContain("Discuss")
    expect(rows[rows.length - 1]).toContain("Auto")
    expect(rows[rows.length - 1]).toContain("00.00.00")
    await tty!.send("a")
    // v7.42: margin 3 kolom pada prompt composer.
    expect(screenText()).toContain("   minicode › a")
    expect(screenText()).not.toContain("██▀▀█▄")
    expect(screenText()).not.toContain("type a message to start")
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Tab melengkapi dropdown / saat terbuka dan memutar WorkMode saat tertutup", async () => {
    let cycles = 0
    const { app, calls, screenText } = setup({
      cycleWorkMode: () => {
        cycles++
      },
    })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("/")
    await tty!.send(KEY.down) // model
    await tty!.send(KEY.tab)
    expect(cycles).toBe(0)
    expect(calls).toEqual([])
    // v7.42: prompt bermargin 3 kolom setelah pelengkapan slash.
    expect(screenText()).toContain("   minicode › /model")
    // Dropdown sudah tertutup -> Tab berikutnya memutar WorkMode.
    await tty!.send(KEY.tab)
    expect(cycles).toBe(1)
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("klik pada baris composer kedua hasil wrap menempatkan kursor di baris yang diklik", async () => {
    const { app } = setup({ columns: 30, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    // v7.42: prefix 14 kolom (3 margin + `minicode › ` 11) menggeser wrap.
    // 25 'a' → baris 0 berisi 16 'a' (14+16 = 30), baris lanjutan berisi 9 'a'.
    await tty!.send("a".repeat(25))
    const row2Index = tty!.screen().indexOf("aaaaaaaaa")
    expect(row2Index).toBeGreaterThan(0)
    // Klik kolom ke-3 pada baris lanjutan (tanpa prefix → tak bergeser): sesudah
    // 2 karakter 'aa'. Grapheme target sama; hanya sisa barisnya yang bertambah.
    await tty!.send(`\x1b[<0;3;${row2Index + 1}M\x1b[<0;3;${row2Index + 1}m`)
    await tty!.send("X")
    const joined = tty!.screen().join("\n")
    expect(joined).toContain("aaXaaaaaaa")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("I5: submit gagal dan cancel turn tidak meninggalkan popup / yatim atau membocorkan input", async () => {
    const { app, calls, screenText } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    // Buka dropdown `/`, ketik `/boom` (melempar error), submit: menu tertutup, error tampil, composer siap terima input bersih.
    await tty!.send("/")
    expect(screenText()).toContain("    model")
    await tty!.send("boom")
    await tty!.send(KEY.enter)
    await tty!.waitForScreen((rows) => rows.some((l) => l.includes("gagal disengaja")))
    expect(screenText()).not.toContain("    model")
    await tty!.send("abc")
    // v7.42: baris prompt diawali margin 3 kolom.
    expect(screenText()).toContain("   minicode › abc")
    await tty!.send(KEY.ctrlU)

    // Masuk turn `/slow` lalu batalkan via Esc: tidak ada popup sisa, input berikutnya utuh.
    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")
    await tty!.send(KEY.esc, 90)
    expect(screenText()).toContain("abort sent")
    expect(screenText()).not.toContain("    model")
    await tty!.send(KEY.ctrlD)
    await runP
    expect(tty!.all()).toContain("\x1b[?1049l")
  })

  test("Tab dan Shift+Tab memperbarui teks WorkMode & PermissionMode langsung di footer tanpa toast", async () => {
    let workMode: "DISCUSS" | "EXECUTE" = "DISCUSS"
    let mode: "auto" | "ask" = "auto"
    const { app } = setup({
      getStatus: () => ({
        footer: { workMode, mode, model: "test-model", cwd: "/kerja", context: "1k" },
        busy: false,
      }),
      cycleWorkMode: () => {
        workMode = workMode === "DISCUSS" ? "EXECUTE" : "DISCUSS"
      },
      togglePermissionMode: () => {
        mode = mode === "auto" ? "ask" : "auto"
      },
    })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const footerRow = () => tty!.screen()[tty!.screen().length - 1] ?? ""

    expect(footerRow()).toContain("Discuss")
    expect(footerRow()).toContain("Auto")

    await tty!.send(KEY.tab)
    expect(footerRow()).toContain("Build")
    expect(footerRow()).toContain("test-model")
    expect(footerRow()).not.toContain("work mode:")

    await tty!.send(KEY.shiftTab)
    expect(footerRow()).toContain("Ask")
    expect(footerRow()).toContain("Build")
    expect(footerRow()).toContain("test-model")
    expect(footerRow()).not.toContain("mode:")

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("panah Up/Down menavigasi baris visual paragraf prompt panjang dan menjaga kolom", async () => {
    const { app, calls } = setup({ columns: 30, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    // Isi histori agar fallback Up di baris visual pertama tetap teruji.
    await tty!.send("histori-lama")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "histori-lama")
    // v7.29: echo histori lama adalah baris transkrip `minicode › histori-lama`,
    // bukan card indented — tunggu itu sebelum mengisi prompt panjang.
    await tty!.waitForScreen((rows) => rows.some((l) => l.includes("minicode › histori-lama")))

    // v7.42: prefix 14 kolom (3 margin + `minicode › ` 11) menggeser wrap.
    // Baris visual 0: prefix 14 + 16 'a'; baris 1: 3 'a' + 27 'b'; baris 2: 3 'b' + 14 'c'.
    await tty!.send("a".repeat(19) + "b".repeat(30) + "c".repeat(14))
    // Up dari baris 2 → baris 1 mendarat di grapheme 'b' yang sama (bukan histori).
    // Karena baris 1 kini diawali 3 'a', sisa 'b' setelah kursor tinggal 12.
    await tty!.send(KEY.up)
    await tty!.send("Y")
    expect(tty!.screen().join("\n")).toContain(`${"b".repeat(14)}Y${"b".repeat(12)}`)

    // Down kembali ke baris 2: kini 3 'b' + 14 'c' (18 col), Z tetap di ujung kanan.
    await tty!.send(KEY.down)
    await tty!.send("Z")
    expect(tty!.screen().join("\n")).toContain(`${"b".repeat(4)}${"c".repeat(14)}Z`)

    // Up dua kali ke baris 0: desiredCol terjaga, X tetap di grapheme 'a' ke-6;
    // baris 0 sekarang hanya punya 16 'a' (prefix 14) → 10 'a' setelah X.
    await tty!.send(KEY.up)
    await tty!.send(KEY.up)
    await tty!.send("X")
    expect(tty!.screen().join("\n")).toContain("   minicode › aaaaaXaaaaaaaaaa")

    // Sudah di baris visual paling atas → Up berikutnya memanggil histori lama.
    // v7.29: gema lama sudah ada di transkrip, jadi yang dibuktikan harus
    // baris COMPOSER (terakhir), bukan kemunculan pasif di viewport.
    await tty!.send(KEY.up)
    const composerRow =
      tty!
        .screen()
        .filter((l) => l.startsWith("   minicode ›"))
        .at(-1) ?? ""
    // v7.42: gema histori memakai margin 3 kolom yang sama dengan prompt.
    expect(composerRow).toContain("   minicode › histori-lama")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("klik mouse pada paragraf prompt panjang (>5 baris wrap) menempatkan kursor tepat pada baris target", async () => {
    const { app } = setup({ columns: 30, rows: 16 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("minicode"))
    // v7.42: prefix 14 kolom menggeser wrap. 6 baris visual (> MAX_INPUT_ROWS 5)
    // tetap menyembunyikan baris 0; tiap baris kini diawali 3 digit sisa baris
    // sebelumnya, mis. "111" + 27 '2'. Jendela menampilkan baris 1..5.
    await tty!.send(
      "0".repeat(19) +
        "1".repeat(30) +
        "2".repeat(30) +
        "3".repeat(30) +
        "4".repeat(30) +
        "5".repeat(8),
    )
    const screen = tty!.screen()
    const row2 = screen.findIndex((l) => l.startsWith("111"))
    expect(row2).toBeGreaterThan(0)
    // Klik kolom ke-6 pada baris lanjutan itu -> menyisip di baris yang diklik
    // (bukan baris 0). Grapheme target sama; isi barisnya yang bergeser 3 digit.
    await tty!.send(`\x1b[<0;6;${row2 + 1}M\x1b[<0;6;${row2 + 1}m`)
    await tty!.send("M")
    expect(tty!.screen().join("\n")).toContain("11122M222")

    // Navigasi panah Up menggulir jendela ke baris 0 ("000..."), klik tetap akurat.
    for (let i = 0; i < 4; i++) await tty!.send(KEY.up)
    const row0 = tty!.screen().findIndex((l) => l.includes("   minicode › 000"))
    expect(row0).toBeGreaterThanOrEqual(0)
    // v7.42: prefix 14 → kolom ke-18 = sesudah 3 digit '0' (dulu kolom 15).
    // Sengaja dijaga agar M dan A mendarat pada grapheme yang sama dengan layout lama.
    await tty!.send(`\x1b[<0;18;${row0 + 1}M\x1b[<0;18;${row0 + 1}m`)
    await tty!.send("A")
    expect(tty!.screen().join("\n")).toContain("   minicode › 000A000")
    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag seleksi melintasi jeda paragraf, border tabel, header kode, dan tepi layar tetap kontinu", async () => {
    const { app, bus, copied } = setup({ rows: 18, columns: 60 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    bus.emit("provider:text", {
      text: [
        "Paragraf pertama teks panjang",
        "",
        "| KolomA | KolomB |",
        "| --- | --- |",
        "| isiSatu | isiDua |",
        "",
        "```ts",
        "const akhir = 42",
        "```",
      ].join("\n"),
    })
    bus.emit("turn:completed", {})
    await tty!.waitForScreen((rows) => rows.some((l) => l.includes("const akhir = 42")))

    const screen = tty!.screen()
    const startIdx = screen.findIndex((l) => l.includes("Paragraf pertama"))
    // Renderer flat: tabel tak punya border — pakai Konten header sbg penanda.
    const borderIdx = screen.findIndex((l) => l.includes("KolomA"))
    const endIdx = screen.findIndex((l) => l.includes("const akhir = 42"))
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(borderIdx).toBeGreaterThan(startIdx)
    expect(endIdx).toBeGreaterThan(borderIdx)

    // Tekan di baris paragraf 1, drag melewati border tabel & jeda kosong, bahkan
    // turun keluar batas transkrip menuju area composer/footer sebelum release.
    await tty!.send(`\x1b[<0;4;${startIdx + 1}M`)
    await tty!.send(`\x1b[<32;12;${borderIdx + 1}M`)
    await tty!.send(`\x1b[<32;25;18M`)
    await tty!.send(`\x1b[<0;25;18m`)

    expect(tty!.all()).toContain("\x1b[7m")
    await tty!.send(KEY.ctrlC)
    expect(copied[0]).toContain("Paragraf pertama teks panjang")
    expect(copied[0]).toContain("KolomA\tKolomB")
    expect(copied[0]).toContain("const akhir = 42")
    // v7.30: bukti toast — pesan HANYA di baris footer, bukan di badan transkrip.
    const rows = tty!.screen()
    expect(rows[rows.length - 1]).toContain("selection copied")
    expect(rows.slice(0, -1).join("\n")).not.toContain("selection copied")

    // v7.28 anchor atas: baris padding kosong kini ada DI BAWAH konten
    // (bukan di atas). Klik sekali pada padding bawah membatalkan seleksi
    // secara bersih — tak boleh menyalin lagi.
    const bottomPadIdx = screen.findIndex((l, i) => i > endIdx && l.trim() === "")
    expect(bottomPadIdx).toBeGreaterThan(endIdx)
    await tty!.send(`\x1b[<0;1;${bottomPadIdx + 1}M\x1b[<0;1;${bottomPadIdx + 1}m`)
    await tty!.send(KEY.ctrlC)
    expect(copied.length).toBe(1)

    await tty!.send(KEY.ctrlD)
    await runP
  })
})
