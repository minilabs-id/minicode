// Integrasi TuiApp — word-wrap composer, blok sudut bulat berlatar gelap,
// dan placeholder paste `{paste text N lines}` end-to-end lewat fake TTY.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const origColor = process.env.MINICODE_COLOR
const origNoColor = process.env.NO_COLOR
const origColorTerm = process.env.COLORTERM
const origTerm = process.env.TERM
const origAscii = process.env.MINICODE_ASCII
const origBox = process.env.MINICODE_BOX
const depthDesc = Object.getOwnPropertyDescriptor(process.stdout, "getColorDepth")

let tty: ReturnType<typeof installFakeTty> | null = null
let lastApp: TuiApp | null = null

beforeEach(() => {
  setSessionLocale("en")
  delete process.env.MINICODE_COLOR
  delete process.env.NO_COLOR
  delete process.env.MINICODE_ASCII
  delete process.env.MINICODE_BOX
})

afterEach(() => {
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
  if (depthDesc) Object.defineProperty(process.stdout, "getColorDepth", depthDesc)
  else delete (process.stdout as { getColorDepth?: unknown }).getColorDepth
  if (origColor == null) delete process.env.MINICODE_COLOR
  else process.env.MINICODE_COLOR = origColor
  if (origNoColor == null) delete process.env.NO_COLOR
  else process.env.NO_COLOR = origNoColor
  if (origColorTerm == null) delete process.env.COLORTERM
  else process.env.COLORTERM = origColorTerm
  if (origTerm == null) delete process.env.TERM
  else process.env.TERM = origTerm
  if (origAscii == null) delete process.env.MINICODE_ASCII
  else process.env.MINICODE_ASCII = origAscii
  if (origBox == null) delete process.env.MINICODE_BOX
  else process.env.MINICODE_BOX = origBox
})

function setup(opts: { columns?: number; rows?: number; gateText?: string } = {}) {
  tty = installFakeTty({ columns: opts.columns ?? 60, rows: opts.rows ?? 14 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never, {})
  const calls: string[] = []
  const enqueued: string[] = []
  const enqueuedDisplay: Array<string | undefined> = []
  const copied: string[] = []
  let releaseGate: (() => void) | undefined

  const host: TuiHost = {
    bus: bus as never,
    getStatus: (): TuiStatusSnapshot => ({
      footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
      busy: false,
    }),
    listCommands: () => [],
    submit: async (text) => {
      calls.push(text)
      if (text === (opts.gateText ?? "/slow")) {
        await new Promise<void>((r) => (releaseGate = r))
      }
      return undefined
    },
    enqueue: (text, displayText) => {
      enqueued.push(text)
      enqueuedDisplay.push(displayText)
      return true
    },
    abort: () => {},
    copySelection: (text) => {
      copied.push(text)
      return true
    },
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }

  const app = new TuiApp(transcript, host)
  lastApp = app
  return {
    app,
    transcript,
    calls,
    enqueued,
    enqueuedDisplay,
    copied,
    releaseSlow: async () => {
      releaseGate?.()
      await new Promise((r) => setTimeout(r, 20))
    },
  }
}

// v0.43: composer dibingkai kotak tipis bersudut lengkung. Margin 3 adalah
// padding FRAME (kiri & kanan, simetris); chrome kotak 2 kolom kiri (`│ `) +
// 2 kolom kanan (` │`). Lebar teks interior = lebar blok − 4.
const FRAME_MARGIN = 3
const BOX_CHROME_COLS = 4
/** Lebar teks interior composer pada `cols` layar (rows < 20 → chat tak ter-centre). */
function innerW(cols: number): number {
  return cols - 2 * FRAME_MARGIN - BOX_CHROME_COLS
}
/** Baris interior composer persis seperti yang dirakit frame. */
function boxRow(text: string, cols: number): string {
  return `   │ ${text.padEnd(innerW(cols))} │`
}
/** Teks interior satu baris composer (chrome kotak dibuang). */
function boxText(row: string): string {
  return row.slice(5, row.length - 2)
}

async function waitForCall(calls: string[], needle: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!calls.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`submit "${needle}" tidak diterima tepat waktu`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("word-wrap composer end-to-end", () => {
  test("kata panjang berpindah utuh ke baris ke-2 dan tertarik balik saat dihapus", async () => {
    const { app } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    // innerW = 50 (60 - 3 - 3 margin frame - 4 chrome kotak), tanpa prefix;
    // kalimat 44 kolom + "terpotong" (9 col) = 53 > 50 sehingga "terpotong"
    // berpindah utuh ke baris ke-2.
    const longBase = "contoh kalimat panjang yang sudah nyaris pas "
    await tty!.send(longBase)
    for (const ch of "terpotong") await tty!.send(ch)

    const wRows = tty!.screen()
    expect(boxText(wRows[10]!)).toBe(longBase.trimEnd().padEnd(innerW(60)))
    expect(boxText(wRows[10]!)).not.toContain("terpo")
    expect(boxText(wRows[11]!)).toBe("terpotong".padEnd(innerW(60)))

    // Hapus 4 huruf di ujung ("tong") → sisa "terpo" (5 col, total 45+5=50 ≤ 50)
    // tertarik balik ke baris tunggal sehingga kotak menyusut kembali ke 1 baris isi.
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.backspace)
    const pulled = tty!.screen()
    expect(pulled[10]).toMatch(/^ {3}╭─+╮$/)
    expect(boxText(pulled[11]!)).toContain("terpo")
    expect(pulled[12]).toMatch(/^ {3}╰─+╯$/)

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("navigasi Up/Down & klik mouse tetap akurat pada kalimat ter-word-wrap", async () => {
    const { app } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("contoh kalimat panjang yang sudah hampir penuh terpotong")
    // Pindah ke awal "terpotong", lalu Up untuk mendarat di baris pertama di kolom awal.
    for (let i = 0; i < "terpotong".length; i++) await tty!.send(KEY.left)
    await tty!.send(KEY.up)
    await tty!.send("*")
    expect(tty!.screen()[10]).toStartWith("   │ *contoh")

    // Klik tepat di atas huruf 'p' pada "terpotong" (interior ke-3 baris 1 →
    // screen x = margin 3 + chrome 2 + interior 3 + 1 = 9).
    await tty!.send(`\x1b[<0;9;12M\x1b[<0;9;12m`)
    await tty!.send("!")
    expect(boxText(tty!.screen()[11]!)).toBe("ter!potong".padEnd(innerW(60)))

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("kotak tipis sudut lengkung keliling composer (tanpa blok warna)", () => {
  test("truecolor: kotak tipis `╭─╮`/`│ │`/`╰─╯` tanpa bg/prefix, I1 & viewH tetap", async () => {
    process.env.COLORTERM = "truecolor"
    const { app, transcript } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const beforeChunks = tty!.chunks().length
    app.repaint()
    expect(tty!.chunks().length - beforeChunks).toBe(1) // I1: 1 write per frame

    const frame = tty!.screen()
    expect(frame).toHaveLength(14)
    // Default 1 baris isi saat kosong: [10] atas, [11] isi tunggal, [12] bawah.
    expect(frame[10]).toMatch(/^ {3}╭─+╮$/)
    expect(frame[11]).toBe(boxRow("", 60))
    expect(frame[12]).toMatch(/^ {3}╰─+╯$/)
    const joined = frame.join("\n")
    // Blok warna (▗▄▖▝▀▘) tidak boleh dipakai — hanya garis tipis.
    expect(joined).not.toMatch(/[▗▄▖▝▀▘]/)
    expect(joined).not.toContain("minicode ›")
    // Warna bingkai: truecolor `#36383E`, tanpa latar.
    expect(tty!.all()).toContain("\x1b[38;2;54;56;62m")
    expect(tty!.all()).not.toContain("\x1b[48;")

    // viewH transkrip = 10 saat composer 1 baris isi.
    transcript.pushInfo(Array.from({ length: 10 }, (_, i) => `V-${i}`))
    await tty!.send("a")
    await tty!.waitForScreen((f) => f.some((l) => l.includes("V-9")))
    const withTranscript = tty!.screen()
    expect(withTranscript[0]).toContain("V-0")
    expect(withTranscript[9]).toContain("V-9")
    expect(withTranscript[10]).toMatch(/^ {3}╭─+╮$/)
    expect(boxText(withTranscript[11]!)).toBe("a".padEnd(innerW(60)))

    // Saat draft > 1 baris, kotak melebar jadi 2 baris isi ([9] atas, [10..11] isi, [12] bawah);
    // bila > 2 baris, indikator ↑/↓ muncul di sisi kanan baris composer.
    await tty!.send(KEY.ctrlU)
    await tty!.send("l0\nl1\nl2\nl3")
    expect(tty!.screen()[9]).toMatch(/^ {3}╭─+╮$/)
    expect(tty!.screen()[10]).toContain("↑")
    await tty!.send(KEY.home)
    expect(tty!.screen()[11]).toContain("↓")

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("256-warna memakai warna bingkai 236 tanpa truecolor dan tanpa latar", async () => {
    const { app } = setup({ columns: 60, rows: 14 })
    // `installFakeTty` menyalakan COLORTERM=truecolor by default; matikan setelah setup().
    delete process.env.COLORTERM
    process.env.TERM = "xterm-256color"
    Object.defineProperty(process.stdout, "getColorDepth", {
      value: () => 8,
      configurable: true,
    })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    expect(tty!.screen()[10]).toMatch(/^ {3}╭─+╮$/)
    expect(tty!.all()).toContain("\x1b[38;5;236m")
    expect(tty!.all()).not.toContain("\x1b[48;")
    expect(tty!.all()).not.toContain("\x1b[38;2;")
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("MINICODE_COLOR=0 mematikan warna SGR namun kotak tipis tetap tampil polos", async () => {
    process.env.COLORTERM = "truecolor"
    process.env.MINICODE_COLOR = "0"
    const { app } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const frame = tty!.screen()
    expect(frame[10]).toMatch(/^ {3}╭─+╮$/)
    expect(frame[12]).toMatch(/^ {3}╰─+╯$/)
    expect(tty!.all()).not.toContain("\x1b[48;")
    expect(tty!.all()).not.toContain("\x1b[38;")
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("MINICODE_ASCII=1 memakai bingkai '+'/'-'/'|' dan indikator ^/v", async () => {
    process.env.MINICODE_ASCII = "1"
    const { app } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("l0\nl1\nl2\nl3")
    const atBottom = tty!.screen()
    expect(atBottom[9]).toMatch(/^ {3}\+-+\+$/)
    expect(atBottom[12]).toMatch(/^ {3}\+-+\+$/)
    expect(atBottom.join("\n")).not.toMatch(/[─▗▄▖▝▀▘╭╮╰╯│]/)
    expect(atBottom[10]).toContain("^")

    await tty!.send(KEY.home)
    const atTop = tty!.screen()
    expect(atTop[11]).toContain("v")

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("placeholder paste ringkas {paste text N lines}", () => {
  test("paste 19 baris tampil ringkas di composer, tapi terbuka penuh di transkrip chat & submit", async () => {
    const { app, transcript, calls } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const lines19 = Array.from({ length: 19 }, (_, i) => `baris-rahasia-${i + 1}`).join("\n")
    await tty!.send(KEY.paste(`${lines19}\n`))

    const composed = tty!.screen().join("\n")
    expect(composed).toContain("{paste text 19 lines}")
    expect(composed).not.toContain("baris-rahasia-1")
    expect(composed).not.toContain("baris-rahasia-19")

    await tty!.send(KEY.enter)
    await waitForCall(calls, lines19)
    expect(calls).toEqual([lines19])

    await tty!.waitForScreen((f) => f.some((l) => l.includes("baris-rahasia-19")))
    expect(tty!.screen().join("\n")).not.toContain("{paste text 19 lines}")
    const view = stripAnsi(transcript.view(70, 30, 0).join("\n"))
    expect(view).toContain("minicode › baris-rahasia-1")
    expect(view).toContain("baris-rahasia-19")
    expect(view).not.toContain("{paste text 19 lines}")

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("paste pendek 1 baris tetap inline; paste 1 baris panjang ≥160 char jadi {paste text 1 line}", async () => {
    const { app, calls } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send(KEY.paste("npm test"))
    expect(tty!.screen().join("\n")).toContain("   │ npm test")
    await tty!.send(KEY.ctrlU)

    const long160 = "x".repeat(160)
    await tty!.send(KEY.paste(long160))
    expect(tty!.screen().join("\n")).toContain("{paste text 1 line}")
    await tty!.send(KEY.enter)
    await waitForCall(calls, long160)

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("dua paste 19 baris dalam satu prompt memakai #2 dan keduanya ter-ekspansi penuh", async () => {
    const { app, calls } = setup({ columns: 80, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const blockA = Array.from({ length: 19 }, (_, i) => `A-${i + 1}`).join("\n")
    const blockB = Array.from({ length: 19 }, (_, i) => `B-${i + 1}`).join("\n")
    await tty!.send(KEY.paste(blockA))
    await tty!.send(" dan ")
    await tty!.send(KEY.paste(blockB))

    const view = tty!.screen().join("\n")
    expect(view).toContain("{paste text 19 lines}")
    expect(view).toContain("{paste text 19 lines #2}")

    await tty!.send(KEY.enter)
    const expected = `${blockA} dan ${blockB}`
    await waitForCall(calls, expected)
    expect(calls).toEqual([expected])

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Backspace dan Delete menghapus token placeholder secara atomik", async () => {
    const { app, calls } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("halo ")
    await tty!.send(KEY.paste("satu\ndua\ntiga"))
    expect(tty!.screen().join("\n")).toContain("halo {paste text 3 lines}")

    // 1× Backspace langsung membuang seluruh placeholder, menyisakan "halo".
    await tty!.send(KEY.backspace)
    expect(tty!.screen()[11]).toBe(boxRow("halo", 70))
    expect(tty!.screen().join("\n")).not.toContain("{paste text")

    // Uji Delete dari kiri placeholder: spasi setelah "halo" masih ada dari input
    // awal, jadi kursor indeks 5 mendarat tepat sebelum token dan 1× Delete
    // langsung membuang seluruh token placeholder.
    await tty!.send(KEY.paste("empat\nlima"))
    await tty!.send(KEY.home)
    for (let i = 0; i < 5; i++) await tty!.send(KEY.right)
    await tty!.send(KEY.del)
    expect(tty!.screen().join("\n")).not.toContain("{paste text")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "halo")

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("histori ↑ memulihkan token paste beserta payload penuh saat submit ulang", async () => {
    const { app, transcript, calls } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const payload = Array.from({ length: 5 }, (_, i) => `hist-${i + 1}`).join("\n")
    await tty!.send(KEY.paste(payload))
    await tty!.send(KEY.enter)
    await waitForCall(calls, payload)
    await tty!.waitForScreen((f) => f.some((l) => l.includes("hist-5")))
    expect(transcript.view(70, 20, 0).join("\n")).not.toContain("{paste text 5 lines}")

    await tty!.send(KEY.up)
    expect(tty!.screen()[11] ?? "").toContain("{paste text 5 lines}")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toEqual([payload, payload])

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("paste bracketed saat busy (antre steering) tetap ter-ekspansi penuh ke model & gema transkrip", async () => {
    const { app, calls, enqueued, enqueuedDisplay, releaseSlow } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("/slow")
    await tty!.send(KEY.enter)
    await waitForCall(calls, "/slow")

    const queuedPayload = "baris-antre-1\nbaris-antre-2\nbaris-antre-3"
    await tty!.send(KEY.paste(queuedPayload))
    expect(tty!.screen().join("\n")).toContain("{paste text 3 lines}")
    await tty!.send(KEY.enter)
    expect(enqueued).toEqual([queuedPayload])
    expect(enqueuedDisplay).toEqual([queuedPayload])

    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("paste 9 baris ringkas di composer dan terbuka lengkap di history chat setelah Enter", async () => {
    const { app, transcript, calls } = setup({ columns: 80, rows: 20 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    const lines9 = Array.from(
      { length: 9 },
      (_, i) => `✦ 1 sub agent · ${20 + i} tool · 0 failed`,
    ).join("\n")
    await tty!.send(KEY.paste(lines9))
    expect(tty!.screen().join("\n")).toContain("{paste text 9 lines}")

    await tty!.send(KEY.enter)
    await waitForCall(calls, lines9)
    expect(calls).toEqual([lines9])

    await tty!.waitForScreen((f) =>
      f.some((l) => l.includes("minicode › ✦ 1 sub agent · 20 tool · 0 failed")),
    )
    const screen = tty!.screen().join("\n")
    expect(screen).toContain("28 tool · 0 failed")
    expect(screen).not.toContain("{paste text 9 lines}")
    const log = stripAnsi(transcript.view(80, 20, 0).join("\n"))
    expect(log).toContain("minicode › ✦ 1 sub agent · 20 tool · 0 failed")
    expect(log).toContain("28 tool · 0 failed")

    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("seleksi teks di dalam blok composer (Ctrl+A & drag mouse)", () => {
  test("Ctrl+A memilih seluruh teks draft, Ctrl+C menyalin (+ ekspansi paste), ketik menimpa, Esc membatalkan", async () => {
    const { app, copied } = setup({ columns: 70, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("cek ")
    const pasted = "baris-1\nbaris-2\nbaris-3"
    await tty!.send(KEY.paste(pasted))
    await tty!.send(KEY.ctrlA)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: verifikasi SGR reverse-video ANSI
    expect(tty!.all()).toMatch(/\x1b\[(?:[0-9;]*;)?7(?:;[0-9;]*)?m/)

    // Ctrl+C menyalin seluruh isi draft dengan placeholder ter-ekspansi penuh, draft tetap utuh.
    await tty!.send(KEY.ctrlC)
    expect(copied).toEqual([`cek ${pasted}`])
    expect(tty!.screen()[11]).toContain("cek {paste text 3 lines}")

    // Esc saat idle membatalkan seleksi tanpa menghapus draft.
    await tty!.send(KEY.esc, 90)
    await tty!.send("!")
    expect(tty!.screen()[11]).toContain("cek {paste text 3 lines}!")

    // Ctrl+A lalu ketik langsung mengganti seluruh isi draft.
    await tty!.send(KEY.ctrlA)
    await tty!.send("ganti")
    expect(tty!.screen()[11]).toBe(boxRow("ganti", 70))

    // Ctrl+A lalu Backspace menghapus seluruh draft.
    await tty!.send(KEY.ctrlA)
    await tty!.send(KEY.backspace)
    expect(tty!.screen()[11]).toBe(boxRow("", 70))

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("drag mouse di composer menyalin substring tepat dan menimpa hanya bagian terpilih", async () => {
    const { app, copied } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    await tty!.send("halo dunia baru")
    // Default 1 baris isi berada di index 11 → y=12 (1-based).
    // Teks mulai di kolom 0 interior = screen x 5+1 (margin 3 + `│ ` 2 kolom).
    // Drag "dunia" (offset 5..10 → x=11..16) di baris 12.
    await tty!.send("\x1b[<0;11;12M")
    await tty!.send("\x1b[<32;16;12M")
    await tty!.send("\x1b[<0;16;12m")
    await tty!.send(KEY.ctrlC)
    expect(copied).toEqual(["dunia"])

    // Ketik "kawan" menimpa "dunia" saja → "halo kawan baru".
    await tty!.send("kawan")
    expect(boxText(tty!.screen()[11]!)).toBe("halo kawan baru".padEnd(innerW(60)))

    // Uji drag melintasi 2 baris logis composer (`satu\ndua` → kotak melebar 2 baris).
    await tty!.send(KEY.ctrlU)
    await tty!.send("satu\ndua")
    // Baris 0 = y=11 ("satu"), baris 1 = y=12 ("dua"): drag dari 't' baris 0
    // (indeks 2 → x = 3+2+2+1 = 8) ke setelah 'u' baris 1 (indeks 2 → x = 8).
    await tty!.send("\x1b[<0;8;11M")
    await tty!.send("\x1b[<32;8;12M")
    await tty!.send("\x1b[<0;8;12m")
    await tty!.send(KEY.ctrlC)
    expect(copied[1]).toBe("tu\ndu")

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("tinggi dinamis 1–2 baris dan scroll internal composer (>2 baris)", () => {
  test("default 1 baris, otomatis melebar ke 2 baris saat >1 baris, dan menyusut lagi saat ≤1 baris", async () => {
    const { app } = setup({ columns: 60, rows: 14 })
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))

    // Idle / kosong: 1 baris isi ([10] atas, [11] isi, [12] bawah).
    expect(tty!.screen()[10]).toMatch(/^ {3}╭─+╮$/)
    expect(tty!.screen()[11]).toBe(boxRow("", 60))
    expect(tty!.screen()[12]).toMatch(/^ {3}╰─+╯$/)

    // 1 baris teks: tetap 1 baris isi.
    await tty!.send("baris tunggal")
    expect(tty!.screen()[10]).toMatch(/^ {3}╭─+╮$/)
    expect(boxText(tty!.screen()[11]!)).toBe("baris tunggal".padEnd(innerW(60)))

    // Tambah baris kedua: otomatis melebar ke 2 baris isi ([9] atas, [10..11] isi, [12] bawah).
    await tty!.send("\nbaris kedua")
    expect(tty!.screen()[9]).toMatch(/^ {3}╭─+╮$/)
    expect(boxText(tty!.screen()[10]!)).toBe("baris tunggal".padEnd(innerW(60)))
    expect(boxText(tty!.screen()[11]!)).toBe("baris kedua".padEnd(innerW(60)))
    expect(tty!.screen()[12]).toMatch(/^ {3}╰─+╯$/)

    // Bersihkan (Ctrl+U): menyusut kembali ke 1 baris isi.
    await tty!.send(KEY.ctrlU)
    expect(tty!.screen()[10]).toMatch(/^ {3}╭─+╮$/)
    expect(tty!.screen()[11]).toBe(boxRow("", 60))
    expect(tty!.screen()[12]).toMatch(/^ {3}╰─+╯$/)

    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("mouse wheel di atas kotak composer menggulir draft >2 baris tanpa menggeser transkrip", async () => {
    const { app, transcript } = setup({ columns: 60, rows: 14 })
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => `CHAT-${String(i).padStart(2, "0")}`))
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForScreen((f) => f.some((l) => l.includes("CHAT-19")))

    // 5 baris draft di dalam kotak maks 2 baris: awalnya menampilkan baris 3..4 + indikator ↑.
    await tty!.send("baris-0\nbaris-1\nbaris-2\nbaris-3\nbaris-4")
    expect(tty!.screen()[9]).toMatch(/^ {3}╭─+╮$/)
    expect(tty!.screen()[10]).toContain("baris-3")
    expect(tty!.screen()[10]).toContain("↑")
    expect(tty!.screen()[11]).toContain("baris-4")

    // Wheel-up di atas kotak composer (x=10, y=11): geser 1 baris ke baris-2..baris-3 (tampil ↑ dan ↓),
    // sementara ekor transkrip CHAT-19 tetap diam.
    await tty!.send("\x1b[<64;10;11M")
    expect(tty!.screen()[10]).toContain("baris-2")
    expect(tty!.screen()[10]).toContain("↑")
    expect(tty!.screen()[11]).toContain("baris-3")
    expect(tty!.screen()[11]).toContain("↓")
    expect(tty!.screen().slice(0, 9).join("\n")).toContain("CHAT-19")

    // Wheel-up dua kali lagi mencapai paling atas (baris-0..baris-1, hanya ↓).
    await tty!.send("\x1b[<64;10;11M")
    await tty!.send("\x1b[<64;10;11M")
    expect(tty!.screen()[10]).toContain("baris-0")
    expect(tty!.screen()[10]).not.toContain("↑")
    expect(tty!.screen()[11]).toContain("baris-1")
    expect(tty!.screen()[11]).toContain("↓")

    // Wheel-down di atas kotak composer kembali ke bawah (baris-1..baris-2).
    await tty!.send("\x1b[<65;10;11M")
    expect(tty!.screen()[10]).toContain("baris-1")
    expect(tty!.screen()[11]).toContain("baris-2")
    expect(tty!.screen().slice(0, 9).join("\n")).toContain("CHAT-19")

    await tty!.send(KEY.ctrlU)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})
