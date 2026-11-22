// A-P0: jalur scroll WAJIB memakai lebar CHAT (kolom tengah v0.34), bukan lebar
// terminal. Dulu `wrappedLength(process.stdout.columns)` bikin cache proyeksi
// miss terus dan End mendarat di offset yang salah.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
let app: TuiApp | null = null

beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  app?.requestQuit()
  app = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
})

test("fake TTY 120×40: End → scrollBack = wrappedLength(chatCols) − viewH", async () => {
  tty = installFakeTty({ columns: 120, rows: 40 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  const host: TuiHost = {
    bus: bus as never,
    getStatus: (): TuiStatusSnapshot => ({
      footer: { mode: "auto", model: "m", cwd: "/w", context: "1k" },
      busy: false,
    }),
    listCommands: () => [],
    submit: async () => undefined,
    abort: () => {},
    copySelection: () => true,
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  app = new TuiApp(transcript, host)
  const runP = app.run()
  await tty.ready()
  await tty.waitForOutput((o) => o.includes("00.00.00"))

  // Cukup konten supaya transkrip jauh lebih panjang dari viewport.
  for (let i = 0; i < 200; i++) {
    bus.emit("provider:text", { text: `baris-${i}\n` })
    bus.emit("turn:completed", {})
  }
  await new Promise((r) => setTimeout(r, 30))

  // PgUp dulu: End hanya memanggil jumpEdge bila scrollBack !== 0
  // (Home justru meng-set scrollBack = 0 sehingga End jadi editing caret).
  await tty.send(KEY.pgUp)
  await tty.send(KEY.end)

  const layout = (app as unknown as { lastLayout: { chatCols: number; viewH: number } }).lastLayout
  const scrollBack = (app as unknown as { scrollBack: number }).scrollBack
  expect(layout).not.toBeNull()
  // 120 kolom → kolom tengah aktif → chatCols = floor(120/2) < 120.
  expect(layout.chatCols).toBeLessThan(120)
  expect(scrollBack).toBe(Math.max(0, transcript.wrappedLength(layout.chatCols) - layout.viewH))
  await tty.send(KEY.ctrlD)
  await runP
})

test("source-scan: tidak ada wrappedLength(process.stdout.columns)", () => {
  const src = readFileSync(new URL("../src/ui/tui/app.ts", import.meta.url), "utf8")
  // Comment pun tak boleh menyisakan pola lama (raw source scan).
  expect(src).not.toContain("wrappedLength(process.stdout.columns)")
  expect(src).not.toMatch(/wrappedLength\(cols\)/)
  expect(src).toContain("wrappedLength(this.chatWidth())")
})
