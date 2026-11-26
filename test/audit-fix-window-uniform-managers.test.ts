// v0.33 — audit: /model & /provider memakai SATU aturan jendela (window.ts).
// Mengunci tiga hal yang sebelumnya bisa menyimpang: (1) lebar/tinggi/judul/
// footer berasal dari windowSpec yang sama, (2) kedua manager benar-benar
// merender frame dengan ukuran itu pada cols/rows identik, (3) ikon kategori
// baris daftar 1 kolom dengan fallback ASCII (getter glyph, bukan const beku).

import { afterEach, describe, expect, test } from "bun:test"
import { t } from "../src/ui/i18n/locale.ts"
import { glyphs, stripAnsi, supportsUtf8 } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { runModelManagerView } from "../src/ui/screens/model-manager.ts"
import { runProviderManagerView } from "../src/ui/screens/provider-manager.ts"
import { windowFooter, windowMaxHeight, windowSpec, windowWidth } from "../src/ui/screens/window.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
  // Isolasi antar-file: test yang gagal di tengah bisa menyisakan depth > 0.
  resetAltScreenDepth()
})

/** Sudut kotak mengikuti kapabilitas/kill-switch saat dipanggil (bukan const). */
function boxGlyphs(): { tl: string; v: string } {
  const style = (process.env.MINICODE_BOX ?? "").toLowerCase()
  if (process.env.MINICODE_ASCII === "1" || style === "ascii" || !supportsUtf8())
    return { tl: "+", v: "|" }
  return { tl: style === "square" ? "┌" : "╭", v: "│" }
}

interface FrameMetrics {
  width: number
  height: number
  title: string
  footer: string
}

/** Ukur frame kotak dari grid layar yang sudah di-parse harness. */
function readFrame(frame: string[], g = boxGlyphs()): FrameMetrics {
  const { tl, v } = g
  const top = frame.findIndex((line) => line.includes(tl))
  if (top < 0) throw new Error("kotak manager tak ditemukan di frame")
  const width = displayWidth((frame[top] ?? "").trimStart())
  let body = 0
  for (let i = top + 1; i < frame.length; i++) {
    if ((frame[i] ?? "").trimStart().startsWith(v)) body++
    else break
  }
  // border atas + baris isi (termasuk footer) + border bawah.
  const height = 1 + body + 1
  return {
    width,
    height,
    title: stripAnsi(frame[top + 1] ?? ""),
    footer: stripAnsi(frame.slice(top).find((l) => stripAnsi(l).includes(t("hint.cancel"))) ?? ""),
  }
}

interface OpenedManager {
  done: Promise<void>
}

async function openModel(): Promise<OpenedManager> {
  const rowsData = [{ id: "prov::m1", active: true }]
  const done = runModelManagerView({
    initialRows: rowsData,
    onSelect: () => {},
    loadRows: async () => rowsData,
    onDelete: async () => rowsData,
  })
  await tty!.ready()
  // Bungkus dalam objek: mengembalikan Promise langsung dari async flatten
  // → await helper menunggu manager tutup, padahal penutup butuh handle ini.
  return { done }
}

async function openProvider(): Promise<OpenedManager> {
  const rowsData = [{ id: "gw", baseUrl: "https://gw.test/v1", models: 2 }]
  const done = runProviderManagerView({
    initialRows: rowsData,
    presets: [],
    askScope: false,
    onSelect: () => {},
    loadRows: async () => rowsData,
    onAdd: async () => ({}),
    onDelete: async () => ({}),
    onEditDefaults: async () => null,
    onEditSave: async () => ({}),
  })
  await tty!.ready()
  return { done }
}

describe("jendela seragam: windowSpec", () => {
  test("satu rumus lebar/tinggi/footer untuk kedua manager di semua ukuran", () => {
    for (const cols of [40, 60, 100, 160]) {
      for (const rows of [10, 16, 24, 40]) {
        const model = windowSpec({
          title: t("out.titleModels"),
          body: ["x"],
          cols,
          rows,
          extraHints: [{ key: "Tab", label: t("hint.effort") }],
        })
        const provider = windowSpec({
          title: t("out.titleProviders"),
          body: ["x"],
          cols,
          rows,
          extraHints: [{ key: "a", label: t("hint.add") }],
        })
        expect(model.minWidth).toBe(windowWidth(cols))
        expect(provider.minWidth).toBe(windowWidth(cols))
        expect(model.maxWidth).toBe(provider.maxWidth)
        expect(model.maxHeight).toBe(windowMaxHeight(rows))
        expect(provider.maxHeight).toBe(model.maxHeight)
        expect(model.title).toBeTruthy()
        expect(provider.title).toBeTruthy()
        const base = stripAnsi(windowFooter([]))
        expect(stripAnsi(model.footer ?? "")).toContain(base)
        expect(stripAnsi(provider.footer ?? "")).toContain(base)
        expect(stripAnsi(model.footer ?? "")).toContain(t("hint.effort"))
        expect(stripAnsi(provider.footer ?? "")).toContain(t("hint.add"))
      }
    }
  })
})

describe("jendela seragam: frame hasil render", () => {
  test("model & provider memakai lebar/judul/footer/tinggi yang sama pada cols/rows identik", async () => {
    const cols = 100
    const rows = 24

    tty = installFakeTty({ columns: cols, rows })
    const modelGlyphs = boxGlyphs()
    const { done: modelDone } = await openModel()
    const modelFrame = tty.screen()
    // Tangkap string locale saat fake TTY aktif — restore() me-reset locale.
    const modelTitle = t("out.titleModels")
    const effortHint = t("hint.effort")
    const baseFooter = stripAnsi(windowFooter([]))
    await tty.send(KEY.esc, 30)
    await modelDone
    tty.restore()
    tty = undefined

    tty = installFakeTty({ columns: cols, rows })
    const providerGlyphs = boxGlyphs()
    const { done: providerDone } = await openProvider()
    const providerFrame = tty.screen()
    const providerTitle = t("out.titleProviders")
    const addHint = t("hint.add")
    const editHint = t("hint.edit")
    const deleteHint = t("hint.delete")
    await tty.send(KEY.esc, 30)
    await providerDone
    tty.restore()
    tty = undefined

    const m = readFrame(modelFrame, modelGlyphs)
    const p = readFrame(providerFrame, providerGlyphs)
    // Lebar: aturan yang sama, terlihat sama di kedua frame.
    expect(m.width).toBe(windowWidth(cols))
    expect(p.width).toBe(windowWidth(cols))
    expect(m.width).toBe(p.width)
    // Judul selalu hadir.
    expect(m.title).toContain(modelTitle)
    expect(p.title).toContain(providerTitle)
    // Footer: navigasi baku identik; aksi khusus tetap sebagai extraHints.
    expect(m.footer).toContain(baseFooter)
    expect(p.footer).toContain(baseFooter)
    expect(m.footer).toContain(effortHint)
    expect(p.footer).toContain(addHint)
    expect(p.footer).toContain(editHint)
    expect(p.footer).toContain(deleteHint)
    // Tinggi: keduanya tunduk pada budget windowMaxHeight yang sama.
    expect(m.height).toBeLessThanOrEqual(windowMaxHeight(rows))
    expect(p.height).toBeLessThanOrEqual(windowMaxHeight(rows))
  }, 15000)
})

describe("ikon kategori: 1 kolom + fallback ASCII", () => {
  const savedAscii = process.env.MINICODE_ASCII
  const savedTerm = process.env.TERM
  const savedWt = process.env.WT_SESSION
  afterEach(() => {
    if (savedAscii == null) delete process.env.MINICODE_ASCII
    else process.env.MINICODE_ASCII = savedAscii
    if (savedTerm == null) delete process.env.TERM
    else process.env.TERM = savedTerm
    if (savedWt == null) delete process.env.WT_SESSION
    else process.env.WT_SESSION = savedWt
  })

  test("modelIcon ✦/* dan providerIcon ●/o selalu 1 kolom", () => {
    process.env.MINICODE_ASCII = "1"
    expect(glyphs.modelIcon).toBe("*")
    expect(glyphs.providerIcon).toBe("o")
    expect(displayWidth(glyphs.modelIcon)).toBe(1)
    expect(displayWidth(glyphs.providerIcon)).toBe(1)

    delete process.env.MINICODE_ASCII
    process.env.TERM = "xterm-256color"
    process.env.WT_SESSION = "fake-tty-icon"
    expect(glyphs.modelIcon).toBe("✦")
    expect(glyphs.providerIcon).toBe("●")
    expect(displayWidth(glyphs.modelIcon)).toBe(1)
    expect(displayWidth(glyphs.providerIcon)).toBe(1)
  })

  test("baris daftar menampilkan ikon kategori (UTF-8 maupun ASCII)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const { done: modelDone } = await openModel()
    const modelIcon = glyphs.modelIcon
    expect(stripAnsi(tty.screen().join("\n"))).toContain(`${modelIcon} prov::m1`)
    await tty.send(KEY.esc, 30)
    await modelDone
    tty.restore()
    tty = undefined

    tty = installFakeTty({ columns: 100, rows: 24 })
    const { done: providerDone } = await openProvider()
    const providerIcon = glyphs.providerIcon
    expect(stripAnsi(tty.screen().join("\n"))).toContain(`${providerIcon} gw`)
    await tty.send(KEY.esc, 30)
    await providerDone
    tty.restore()
    tty = undefined
  }, 15000)
})
