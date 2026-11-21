// Regresi temuan audit VERIFIED (F1–F4) pada TuiApp.
// Fokus: state pasca-abort, card steering, kemurnian buildLayout saat popup,
// dan kebocoran hint abort ke turn berikutnya.
//
// Pola harness sama seperti test/tui-app.test.ts: repaint sinkron per keypress,
// jadi setelah `tty.send()` frame sudah final (kecuali repaint bus 30ms).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

beforeEach(() => setSessionLocale("en"))

let tty: ReturnType<typeof installFakeTty> | null = null
let lastApp: TuiApp | null = null
afterEach(() => {
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

function setup(opts: { columns?: number; rows?: number } = {}) {
  tty = installFakeTty({ columns: opts.columns ?? 60, rows: opts.rows ?? 14 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  const calls: string[] = []
  const enqueued: string[] = []
  let slowGate: (() => void) | null = null
  let abortCalls = 0
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({
      footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
      busy: false,
    }),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    // Semua submit ditahan sampai gate dilepas — pola test lama.
    submit: async (text) => {
      calls.push(text)
      await new Promise<void>((r) => (slowGate = r))
      return undefined
    },
    // Tiru `cli/tui.ts`: steer HANYA push ke transcript (App tak boleh menyentuh
    // cli). Sejak v7.29 prompt tampil langsung sebagai history, tanpa card.
    enqueue: (text) => {
      enqueued.push(text)
      transcript.pushUser(text)
      return true
    },
    copySelection: () => true,
    abort: () => {
      abortCalls++
    },
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  const app = new TuiApp(transcript, host)
  lastApp = app
  const boot = async () => {
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    return { runP }
  }
  const releaseSlow = async () => {
    slowGate?.()
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    app,
    bus,
    transcript,
    calls,
    enqueued,
    boot,
    releaseSlow,
    abortCalls: () => abortCalls,
    screenText: () => tty!.screen().join("\n"),
  }
}

describe("F1: jendela quit pasca-abort diprogram flag eksplisit", () => {
  test("draft baru setelah abort: Esc menghapus draft, BUKAN quit", async () => {
    const { boot, releaseSlow, screenText, abortCalls } = setup()
    const { runP } = await boot()
    await tty!.send("awal")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 10))
    // Esc pertama = abort (hint + jendela 1,5 dtk diprogram).
    await tty!.send(KEY.esc, 60)
    expect(abortCalls()).toBe(1)
    await releaseSlow()
    // Masih dalam jendela: ketik draft baru → flag quit harus mati.
    await tty!.send("drafbaru")
    expect(screenText()).toContain("drafbaru")
    await tty!.send(KEY.esc, 90)
    // Gagal-di-kode-lama: lastAbortAt basi mengira ini double-Esc → EXIT.
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(screenText()).not.toContain("drafbaru")
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Esc dua kali idle (500ms) tetap membuka /undo setelah disarm", async () => {
    const { boot, releaseSlow, calls } = setup()
    const { runP } = await boot()
    await tty!.send("awal")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 10))
    await tty!.send(KEY.esc, 60)
    await releaseSlow()
    // First Esc after abort clears the freshly typed draft (and disarms quit).
    await tty!.send("x")
    await tty!.send(KEY.esc, 90)
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    // Gesture idle lama tak berubah: dua Esc berikutnya dalam 500ms = /undo.
    await tty!.send(KEY.esc, 90)
    await tty!.send(KEY.esc, 90)
    const deadline = Date.now() + 2000
    while (!calls.includes("/undo") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(calls).toContain("/undo")
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("F2: prompt steer menjadi history di transkrip", () => {
  test("Enter saat busy mendorong teks ke transkrip sebagai gema baru", async () => {
    const { boot, releaseSlow, enqueued, screenText } = setup()
    const { runP } = await boot()
    await tty!.send("pertama")
    await tty!.send(KEY.enter)
    await tty!.waitForScreen((f) => f.some((l) => l.includes("minicode") && l.includes("pertama")))
    // Steer: App mengosongkan draft + host.enqueue() yang pushUser("kedua").
    await tty!.send("kedua")
    await tty!.send(KEY.enter)
    await tty!.waitForScreen((f) => f.some((l) => l.includes("minicode") && l.includes("kedua")))
    expect(enqueued).toEqual(["kedua"])
    // v7.29: prompt lama TETAP ada sebagai history (bukan ditimpa card).
    expect(screenText()).toContain("pertama")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("F3: buildLayout murni saat backdrop popup di-resize", () => {
  test("resize backdrop tak menggeser scroll/seleksi di belakang modal", async () => {
    // Baris 65 kolom: di 60 kolom ter-wrap jadi 2 baris visual, di 70 kolom
    // jadi 1 baris — jadi `lastWrapped` berubah bila buildLayout dipanggil saat
    // resize (dulu terjadi di balik modal → scrollBack ikut bergeser).
    const long = (i: number) => `${"L".repeat(65)}-${i}`
    const { app, transcript, boot, screenText } = setup({ columns: 60, rows: 14 })
    const { runP } = await boot()
    transcript.pushInfo(Array.from({ length: 20 }, (_, i) => long(i)))
    await tty!.send("k")
    await tty!.waitForScreen((f) => f.some((l) => l.includes("L".repeat(30))))
    // Gulir ke atas dulu supaya scrollBack > 0 & lastWrapped > 0.
    await tty!.send(KEY.pgUp)
    const before = screenText()
    expect(before).not.toContain("-19")
    // Suspend → backdrop aktif. Resize + paintRegion memicu callback backdrop.
    app.suspend()
    tty!.resize(70, 16)
    app.paintRegion(["popup"], 4)
    tty!.resize(60, 14)
    app.resume()
    // Gagal-di-kode-lama: callback backdrop memanggil buildLayout(16,70) yang
    // memutasi scrollBack/lastWrapped → frame setelah resume bergeser.
    expect(screenText()).toBe(before)
    await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("F4: hint abort tak bocor ke turn berikutnya", () => {
  test("turn:started membersihkan hint 'Esc lagi = quit'", async () => {
    const { bus, boot, releaseSlow, screenText } = setup()
    const { runP } = await boot()
    await tty!.send("awal")
    await tty!.send(KEY.enter)
    await new Promise((r) => setTimeout(r, 10))
    await tty!.send(KEY.esc, 90)
    await new Promise((r) => setTimeout(r, 60))
    expect(screenText()).toContain("Esc again = quit")
    // Turn BARU (mis. antrean yang diproses controller) → hint harus hilang.
    bus.emit("turn:started", { turn: 2 })
    await new Promise((r) => setTimeout(r, 70))
    expect(screenText()).not.toContain("Esc again = quit")
    await releaseSlow()
    await tty!.send(KEY.ctrlD)
    await runP
  })
})
