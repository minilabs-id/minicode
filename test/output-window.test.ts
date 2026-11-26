// Jendela output command: readout tampil sebagai overlay di atas chat, punya
// judul + hint seragam, bisa scroll, dan fail-closed (false) di non-TTY agar
// pemanggil fallback ke transkrip.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MAX_CLIPBOARD_BYTES } from "../src/ui/assistant/simple.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { outputWindowWidth, runOutputWindow } from "../src/ui/screens/output-window.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

describe("runOutputWindow", () => {
  test("merender kotak + judul + isi + hint, lalu Esc menutup", async () => {
    tty = installFakeTty({ columns: 90, rows: 24 })
    const p = runOutputWindow({ title: "Help", lines: ["Commands:", "  /model", "  /status"] })
    await tty.ready()
    const frame = await tty.waitForScreen((f) => f.some((l) => l.includes("Help")))
    const text = frame.join("\n")
    expect(text).toContain("Commands:")
    expect(text).toContain("/model")
    expect(text).toContain("Esc close")
    expect(text).not.toContain("scroll")
    await tty.send(KEY.esc, 90)
    expect(await p).toBe(true)
  })

  test("scroll: ↓/j/wheel menampilkan baris berikut serta counter di judul", async () => {
    tty = installFakeTty({ columns: 80, rows: 10 })
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
    const p = runOutputWindow({ title: "History", lines })
    await tty.ready()
    // v0.33: aturan tinggi jendela seragam mengubah jumlah baris isi yang
    // muat — yang dijaga adalah counter BERGERAK, bukan angka tetapnya.
    const counter = (frame: string[]): string =>
      frame.find((l) => l.includes("History ("))?.trim() ?? ""
    await tty.waitForScreen((f) => f.some((l) => l.includes("History (1-")))
    const awal = counter(tty.screen())
    for (let i = 0; i < 10; i++) await tty.send(KEY.down)
    await tty.waitForScreen((f) =>
      f.some((l) => l.includes("History (")) ? counter(f) !== awal : false,
    )
    await tty.send("\x1b[<65;1;1M")
    await tty.waitForScreen((f) =>
      f.some((l) => l.includes("History (")) ? counter(f) !== awal : false,
    )
    const setelahWheel = counter(tty.screen())
    await tty.send("k")
    await tty.waitForScreen((f) =>
      f.some((l) => l.includes("History (")) ? counter(f) !== setelahWheel : false,
    )
    await tty.send(KEY.esc, 90)
    expect(await p).toBe(true)
  })

  test("salin isi dengan c lewat callback onCopy dan tampilkan konfirmasi", async () => {
    tty = installFakeTty({ columns: 90, rows: 24 })
    let copied = ""
    const p = runOutputWindow({
      title: "Status",
      lines: ["  Model: test-a", "  Context: 12k"],
      onCopy: (text) => {
        copied = text
        return true
      },
    })
    await tty.ready()
    await tty.waitForScreen((f) => f.some((l) => l.includes("c copy")))
    await tty.send("c")
    await tty.waitForScreen((f) => f.some((l) => l.includes(tSystem("msg.copied"))))
    expect(copied).toBe("  Model: test-a\n  Context: 12k")
    await tty.send(KEY.esc, 90)
    expect(await p).toBe(true)
  })

  test("payload besar: c menolak salin (guard byte sama dengan /copy) + pesan tooLarge", async () => {
    tty = installFakeTty({ columns: 90, rows: 24 })
    let called = false
    const p = runOutputWindow({
      title: "Big",
      lines: ["x".repeat(MAX_CLIPBOARD_BYTES + 1)],
      onCopy: () => {
        called = true
        return true
      },
    })
    await tty.ready()
    await tty.waitForScreen((f) => f.some((l) => l.includes("c copy")))
    await tty.send("c")
    await tty.waitForScreen((f) => f.some((l) => l.includes(tSystem("msg.copyTooLarge"))))
    // Callback TAK dipanggil sama sekali, bukan sekadar gagal "butuh TTY".
    expect(called).toBe(false)
    await tty.send(KEY.esc, 90)
    expect(await p).toBe(true)
  })

  test("non-TTY: return false tanpa membuka layar (caller fallback)", async () => {
    tty = installFakeTty({ isTTY: false })
    expect(await runOutputWindow({ title: "Status", lines: ["x"] })).toBe(false)
  })

  test("lebar jendela output lega tetapi tidak melebihi terminal", () => {
    expect(outputWindowWidth(80)).toBe(72)
    expect(outputWindowWidth(60)).toBe(56)
    expect(outputWindowWidth(200)).toBe(96)
  })
})
