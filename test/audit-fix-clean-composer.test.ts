// Audit v7.29 — composer BERSIH saat busy.
//
// Sebelum v7.29, TuiApp menyuntik baris status/progres (dots, "step 2/5",
// nama tool + elapsed) ke dalam composer. Kini kolom chat HANYA memuat
// prompt/draft; status kerja pindah ke footer (timer + spark). Berkas ini
// menjaga invariant itu end-to-end lewat TuiApp + fake TTY — terpisah dari
// tui-app.test.ts yang menguji skenario per-event.
//
// Warna nyala by default di TTY (v7.29), jadi assertions teks memakai
// `screen()` (parser membuang SGR). Test warna di bawah menguji kedua mode
// secara jujur: SGR saat color-on, polos saat MINICODE_COLOR=0.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationEvent } from "../src/ui/contract.ts"
import { c, stripAnsi } from "../src/ui/render/theme.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const origColor = process.env.MINICODE_COLOR
let tty: ReturnType<typeof installFakeTty> | null = null
let app: TuiApp | null = null

beforeEach(() => {
  // v7.29: mulai dari env bersih; test warna mengatur flag-nya sendiri.
  delete process.env.MINICODE_COLOR
})

afterEach(() => {
  app?.requestQuit()
  app = null
  tty?.restore()
  tty = null
  if (origColor == null) delete process.env.MINICODE_COLOR
  else process.env.MINICODE_COLOR = origColor
})

function mount() {
  tty = installFakeTty({ columns: 60, rows: 14 })
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
  let release: (() => void) | undefined
  let pinnedActivity: UiPresentationActivity | undefined

  const host: TuiHost = {
    bus: bus as never,
    getStatus: (): TuiStatusSnapshot => ({
      footer: { mode: "auto", model: "test-model", cwd: "/k", context: "1k" },
      busy: false,
      ...(pinnedActivity ? { pinnedActivity } : {}),
    }),
    listCommands: () => [],
    submit: async (text) => {
      if (text === "/slow") await new Promise<void>((r) => (release = r))
      return undefined
    },
    enqueue: () => true,
    abort: () => {},
    copySelection: () => true,
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }

  app = new TuiApp(transcript, host)
  return {
    run: () => app!.run(),
    ready: () => tty!.ready(),
    send: (key: string) => tty!.send(key),
    release: () => release?.(),
    screen: () => tty!.screen(),
    text: () => tty!.screen().join("\n"),
    emit: (event: UiPresentationEvent) => presentationHandler?.(event),
    setPinned: (a: UiPresentationActivity | undefined) => {
      pinnedActivity = a
    },
    repaint: () => app!.repaint(),
  }
}

async function startSlow(m: ReturnType<typeof mount>): Promise<{ runP: Promise<unknown> }> {
  const runP = m.run()
  await m.ready()
  await tty!.waitForOutput((o) => o.includes("00.00.00"))
  await m.send("/slow")
  await m.send(KEY.enter)
  // Bungkus dalam objek: `await` pada promise yang resolve ke promise lain
  // akan mengadopsi thenable-nya (dan menunggu App keluar) — bukan itu yang
  // dimau di sini. Test akan await `runP` secara eksplisit di akhir.
  return { runP }
}

describe("audit v7.29 — clean composer", () => {
  test("composer hanya prompt/draft walau busy + step + activity", async () => {
    const m = mount()
    const { runP } = await startSlow(m)
    const rowsBefore = m.screen().length

    m.emit({ type: "step.started", seq: 1, turnId: 1, step: 1, total: 5 })
    m.setPinned({
      toolCallId: "c1",
      name: "read_file",
      target: "src/server.ts",
      status: "running",
      tsStart: Date.now() - 3000,
    })
    m.repaint()
    await m.send("draf")
    await new Promise((r) => setTimeout(r, 40))

    const frame = m.screen()
    // Tinggi frame tak berubah: tak ada baris progres yang disuntik.
    expect(frame).toHaveLength(rowsBefore)
    // v0.43: composer tanpa prefix `minicode ›` di dalam kotak tipis sudut
    // lengkung (default 1 baris isi: [len-4] atas, [len-3] isi, [len-2] bawah).
    const draftRow = frame[frame.length - 3] ?? ""
    expect(draftRow).toMatch(/^ {3}│ draf +│$/)
    expect(m.text()).not.toContain("minicode ›")
    // Tak ada status/progres/tool/elapsed yang bocor ke composer.
    expect(draftRow).not.toMatch(/step \d|\.{1,3}|read_file|\(\d+s\)/)
    expect(m.text()).not.toMatch(/\b(Working|Thinking|Running)\b/)
    // Indikator busy ada di footer (timer), bukan di composer.
    expect(frame.at(-1) ?? "").toMatch(/\d{2}\.\d{2}\.\d{2}/)

    await m.send(KEY.ctrlU)
    m.release()
    await new Promise((r) => setTimeout(r, 20))
    await m.send(KEY.ctrlD)
    await runP
  })

  test("turn usai: draft diantrikan, composer kembali ke prompt kosong", async () => {
    const m = mount()
    const { runP } = await startSlow(m)
    await m.send("draf")
    await new Promise((r) => setTimeout(r, 20))
    // Enter saat busy = steering (antre), bukan submit kedua; draft dibersihkan.
    await m.send(KEY.enter)
    m.release()
    await new Promise((r) => setTimeout(r, 20))
    // v0.43: composer kosong kembali ke default 1 baris isi (atas / 1 isi / bawah).
    const frame = m.screen()
    expect(frame[frame.length - 4] ?? "").toMatch(/^ {3}╭─+╮$/)
    expect(frame[frame.length - 3] ?? "").toMatch(/^ {3}│ +│$/)
    expect(frame[frame.length - 2] ?? "").toMatch(/^ {3}╰─+╯$/)
    await m.send(KEY.ctrlD)
    await runP
  })

  test("warna prompt composer: accent saat color-on, polos via MINICODE_COLOR=0", () => {
    // v7.29: prompt composer memakai c.accent(pf) di app.ts. Warna nyala by
    // default; MINICODE_COLOR=0 = monokrom eksplisit. Kedua jalur diuji jujur —
    // test mono lama tidak dihapus, dipindah ke mode yang memang monokrom.
    // Pasang fake TTY: tanpa isTTY, colorLevel() jadi 0 (pipe) dan warna tak
    // menyala — ini mekanisme, bukan perilaku yang diuji di sini.
    tty = installFakeTty({ columns: 60, rows: 14 })
    // v7.42: sampel prompt memakai margin kiri 3 kolom yang sama dengan prompt
    // composer baru; round-trip warna (accent → stripAnsi) tetap diuji setara.
    const prompt = "   minicode ›"
    delete process.env.MINICODE_COLOR
    const colored = c.accent(prompt)
    expect(colored).toContain("\x1b[")
    expect(stripAnsi(colored)).toBe(prompt)

    process.env.MINICODE_COLOR = "0"
    try {
      expect(c.accent(prompt)).toBe(prompt)
    } finally {
      delete process.env.MINICODE_COLOR
    }
  })
})
