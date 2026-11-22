// Geometri chat ter-centre: murni (helper) + kontrak frame/CUP/mouse di TuiApp.
// Proteksi untuk ambang 120×20, batas 50%, dan tak adanya separator panel.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import {
  CHAT_COLUMN_MAX_RATIO,
  CHAT_COLUMN_MIN_COLS,
  CHAT_COLUMN_MIN_ROWS,
  chatColumnGeometry,
  chatWidth,
  composerWidth,
} from "../src/ui/render/chat-column.ts"
import { stripSgr } from "../src/ui/render/sanitize.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { windowWidth } from "../src/ui/screens/window.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
let lastApp: TuiApp | null = null

beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

function setup(columns: number, rows: number, line?: string) {
  tty = installFakeTty({ columns, rows })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never, {})
  const copied: string[] = []
  const status: TuiStatusSnapshot = {
    footer: { mode: "auto", model: "m", cwd: "/w", context: "1k" },
    busy: false,
  }
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => status,
    listCommands: () => [],
    submit: async () => undefined,
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
  if (line) transcript.pushInfo([line])
  return { app, transcript, copied }
}

/** Baris frame mentah dari paint PENUH terakhir (sebelum diff/CUP). */
function rawFrameLines(stream: string): string[] {
  const at = stream.lastIndexOf("\x1b[2J")
  if (at < 0) return []
  const tail = stream.slice(at + "\x1b[2J".length)
  // RegExp dibangun dari string agar tidak memakai literal kontrol di source.
  const resetTail = new RegExp(`${"\\x1b"}\\[0m$`)
  return (tail.split("\x1b[?25l")[0] ?? "").replace(resetTail, "").split("\r\n")
}

/** Kolom CUP absolut yang diparkir screen.paint untuk kursor composer. */
function cupCol(stream: string): number {
  const cup = new RegExp(`${"\\x1b"}\\[\\d+;(\\d+)H`)
  // CUP kursor adalah CUP terakhir yang dipancarkan painter; CUP lain bisa
  // berasal dari repaint footer/diff dan bukan posisi caret composer.
  const all = stream.match(new RegExp(cup.source, "g"))
  const last = all?.at(-1)
  if (!last) return -1
  const m = cup.exec(last)
  return m ? Number(m[1]) : -1
}

describe("chatColumnGeometry (murni)", () => {
  test("konstanta ambang sesuai kontrak", () => {
    expect(CHAT_COLUMN_MIN_COLS).toBe(120)
    expect(CHAT_COLUMN_MIN_ROWS).toBe(20)
    expect(CHAT_COLUMN_MAX_RATIO).toBe(0.5)
  })

  test("119 kolom tetap penuh; 120/200 ter-centre maksimal 50%", () => {
    expect(chatColumnGeometry(30, 119)).toEqual({
      centered: false,
      cols: 119,
      rows: 30,
      chatCols: 119,
      padLeft: 0,
      padRight: 0,
    })
    expect(chatColumnGeometry(30, 120)).toEqual({
      centered: true,
      cols: 120,
      rows: 30,
      chatCols: 60,
      padLeft: 30,
      padRight: 30,
    })
    expect(chatColumnGeometry(30, 200)).toEqual({
      centered: true,
      cols: 200,
      rows: 30,
      chatCols: 100,
      padLeft: 50,
      padRight: 50,
    })
    // Ganjil: padLeft membulatkan ke bawah, sisa ke kanan.
    expect(chatColumnGeometry(30, 121)).toEqual({
      centered: true,
      cols: 121,
      rows: 30,
      chatCols: 60,
      padLeft: 30,
      padRight: 31,
    })
  })

  test("tinggi <20 memaksa chat penuh walau cols ≥120", () => {
    expect(chatColumnGeometry(19, 200)).toEqual({
      centered: false,
      cols: 200,
      rows: 19,
      chatCols: 200,
      padLeft: 0,
      padRight: 0,
    })
    expect(chatColumnGeometry(20, 200).centered).toBe(true)
    expect(chatColumnGeometry(19, 120).chatCols).toBe(120)
  })

  test("popup tak ikut menyusut: windowWidth(200) tetap 88", () => {
    expect(windowWidth(200)).toBe(88)
    expect(windowWidth(120)).toBe(88)
  })
})

describe("satu sumber geometri: chatWidth/composerWidth", () => {
  test("chatWidth = turunan ChatColumnGeometry", () => {
    expect(chatWidth(chatColumnGeometry(30, 60))).toBe(60)
    expect(chatWidth(chatColumnGeometry(30, 120))).toBe(60)
    expect(chatWidth(chatColumnGeometry(30, 300))).toBe(150)
    expect(chatWidth(chatColumnGeometry(30, 500))).toBe(250)
  })

  test("cap progresif: 100→100, 200→125, 300→150, 500→200", () => {
    expect(composerWidth(20)).toBe(20)
    expect(composerWidth(60)).toBe(60)
    expect(composerWidth(100)).toBe(100)
    expect(composerWidth(120)).toBe(105)
    expect(composerWidth(200)).toBe(125)
    expect(composerWidth(300)).toBe(150)
    expect(composerWidth(500)).toBe(200)
    // Lantai 10 untuk geometri degenerat.
    expect(composerWidth(0)).toBe(10)
  })

  test("cap dipakai composer sungguhan: draft 130 kolom muat di 1000, tidak di 400", async () => {
    const trace = async (columns: number): Promise<string[]> => {
      const { app } = setup(columns, 30)
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      await tty!.send("z".repeat(130))
      const lines = tty!.screen().filter((l) => l.includes("z"))
      await tty!.send(KEY.ctrlU)
      await tty!.send(KEY.ctrlD)
      await runP
      tty!.restore()
      tty = null
      return lines
    }
    // chatCols 500 → composer 200 → ruang isi 186 ≥ 130: satu baris visual.
    const wide = await trace(1000)
    expect(wide.some((l) => l.includes("z".repeat(130)))).toBe(true)
    // chatCols 200 → composer 125 → ruang isi 111 < 130: dua baris visual.
    const wrapped = await trace(400)
    expect(wrapped.some((l) => l.includes("z".repeat(130)))).toBe(false)
    expect(wrapped.reduce((n, l) => n + (l.match(/z/g)?.length ?? 0), 0)).toBe(130)
  })
})

describe("TuiApp frame ter-centre", () => {
  test("cols=200: tiap baris tepat 200 kolom, 50/100/50, tanpa separator", async () => {
    const { app } = setup(200, 30)
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    const raw = rawFrameLines(tty!.all())
    expect(raw).toHaveLength(30)
    for (const line of raw) {
      expect(displayWidth(stripSgr(line))).toBe(200)
      expect(line.startsWith(" ".repeat(50))).toBe(true)
      expect(line.endsWith(" ".repeat(50))).toBe(true)
    }
    const text = tty!.screen().join("\n")
    expect(text).not.toContain("│")
    expect(text).not.toContain("Thinking")
    expect(text).not.toContain("Activity")
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("CUP kursor memuat padLeft (selisih 50 antara cols=60 dan 200)", async () => {
    const trace = async (columns: number): Promise<number> => {
      const { app } = setup(columns, 30)
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      const col = cupCol(tty!.all())
      await tty!.send(KEY.ctrlD)
      await runP
      tty!.restore()
      tty = null
      return col
    }
    const narrow = await trace(60)
    const wide = await trace(200)
    expect(narrow).toBeGreaterThan(0)
    expect(wide - narrow).toBe(50)
  })
})

describe("TuiApp mouse ter-translasi", () => {
  test("wheel di padding tetap menggulir chat", async () => {
    const { app, transcript } = setup(200, 24)
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    transcript.pushInfo(Array.from({ length: 30 }, (_, i) => `baris-${i}`))
    await tty!.send("x") // ketikan → followTail + repaint, ekor tampil
    expect(tty!.screen().some((l) => l.includes("baris-29"))).toBe(true)
    // x=padLeft (50) adalah kolom padding terakhir — bukan area chat.
    await tty!.send("\x1b[<64;50;10M")
    await new Promise((r) => setTimeout(r, 40))
    const afterUp = tty!.screen().filter((l) => l.includes("baris-"))
    expect(
      afterUp.some((l) => l.includes("baris-29")),
      `afterUp=${afterUp.join("|")}`,
    ).toBe(false)
    await tty!.send("\x1b[<65;50;10M")
    await new Promise((r) => setTimeout(r, 40))
    expect(tty!.screen().some((l) => l.includes("baris-29"))).toBe(true)
    await tty!.send(KEY.backspace) // prompt kosong → Ctrl+D = quit
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("klik x=padLeft+k setara x=k pada layout penuh", async () => {
    const sentinel = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    const trace = async (columns: number, padLeft: number) => {
      const { app, copied } = setup(columns, 24, sentinel)
      const runP = app.run()
      await tty!.ready()
      await tty!.waitForOutput((o) => o.includes("00.00.00"))
      // Pastikan baris sentinel terlihat (baris terakhir transkrip).
      await tty!.waitForScreen((rows) => rows.some((l) => l.includes(sentinel)))
      const y = tty!.screen().findIndex((l) => l.includes(sentinel)) + 1
      expect(y).toBeGreaterThan(0)
      // k=4 = awal teks setelah margin 3 kolom; k=10 = tengah teks.
      await tty!.send(`\x1b[<0;${padLeft + 4};${y}M`)
      await tty!.send(`\x1b[<32;${padLeft + 10};${y}M`)
      await tty!.send(`\x1b[<0;${padLeft + 10};${y}m`)
      await tty!.send(KEY.ctrlC)
      const selected = [...copied]
      // Klik di padding kiri membatalkan seleksi (tak menyalin lagi).
      await tty!.send(`\x1b[<0;${Math.max(1, padLeft)};${y}M`)
      await tty!.send(`\x1b[<0;${Math.max(1, padLeft)};${y}m`)
      await tty!.send(KEY.ctrlC)
      expect(copied.length).toBe(selected.length)
      await tty!.send(KEY.ctrlD)
      await runP
      tty!.restore()
      tty = null
      return selected
    }
    const narrow = await trace(100, 0)
    const wide = await trace(200, 50)
    expect(narrow).toHaveLength(1)
    expect(wide).toEqual(narrow)
    expect(wide[0]).toContain("ABCDEF")
  })
})
