// Audit v0.33 — SATU format jendela untuk picker & form.
//
// Sebelumnya picker menyembunyikan judul (showTitle=false), memakai footer
// ad-hoc, dan lebar `popupBoxWidth`; form punya footer sendiri. Keduanya kini
// wajib lewat `windowSpec` → judul selalu ada, footer dari `windowFooter`, dan
// lebar = `windowWidth(cols)`. Test ini mengunci keseragaman itu PLUS fallback
// ASCII (kontrak MINICODE_ASCII / MINICODE_BOX tak boleh regress).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { openAltScreen, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { runForm } from "../src/ui/screens/form.ts"
import { runPicker } from "../src/ui/screens/picker.ts"
import { windowFooter, windowSpec, windowWidth } from "../src/ui/screens/window.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null

beforeEach(() => setSessionLocale("en"))
afterEach(() => {
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
})

/** Lebar border atas kotak diukur per KOLOM (bukan grapheme). */
function topBorderWidth(frame: readonly string[]): number {
  const top = frame.map(stripAnsi).find((l) => /^[╭┌+]/.test(l.trimStart()))
  if (!top) throw new Error("border atas jendela tidak ditemukan")
  return displayWidth(top.trimStart())
}

/** Baris judul = baris yang diawali border vertikal dan memuat `title`. */
function titleLine(frame: readonly string[], title: string): string | undefined {
  return frame.map(stripAnsi).find((l) => /^[│|]/.test(l.trimStart()) && l.includes(title))
}

/** Footer baku memuat nav/pilih/batal (label bergantung locale). */
function footerLine(frame: readonly string[]): string | undefined {
  return frame
    .map(stripAnsi)
    .find(
      (l) =>
        l.includes(t("hint.move")) &&
        (l.includes(t("hint.select")) || l.includes(t("hint.save"))) &&
        l.includes(t("hint.cancel")),
    )
}

async function pickerFrame(cols: number, rows: number, ascii = false): Promise<string[]> {
  tty = installFakeTty({ columns: cols, rows, ascii })
  const done = runPicker({
    title: "Sesi",
    items: [{ name: "s1", provider: "p", value: "s1", category: "session" }],
    onPick: () => {},
    onCancel: () => {},
  })
  await tty!.ready()
  await tty!.waitForScreen((f) => f.some((l) => l.includes("s1")))
  const frame = [...tty!.screen()]
  await tty!.send(KEY.esc, 90)
  await done
  tty!.restore()
  tty = null
  return frame
}

async function formFrame(cols: number, rows: number, ascii = false): Promise<string[]> {
  tty = installFakeTty({ columns: cols, rows, ascii })
  const screen = openAltScreen()
  const done = runForm({ title: "Sesi", fields: [{ id: "a", label: "A", kind: "text" }] }, screen)
  await tty!.ready()
  await tty!.waitForScreen((f) => f.some((l) => l.includes("A:")))
  const frame = [...tty!.screen()]
  // Field kosong → Esc pertama langsung batal (tak ada draft untuk di-revert).
  await tty!.send(KEY.esc, 90)
  await done
  screen.close()
  tty!.restore()
  tty = null
  return frame
}

describe("format jendela seragam v0.33", () => {
  test("windowSpec: picker & form identik di cols/rows sama", () => {
    const cols = 82
    const rows = 21
    const p = windowSpec({ title: "Sesi", body: ["  item"], cols, rows })
    const f = windowSpec({ title: "Sesi", body: ["  field"], cols, rows, focusRow: 0 })

    expect(p.title).toBe("Sesi")
    expect(f.title).toBe("Sesi")
    // Footer satu sumber: baku nav/pilih/tutup, tanpa aksi tambahan.
    expect(p.footer).toBe(windowFooter())
    expect(f.footer).toBe(p.footer)
    // Satu rumus ukuran untuk semua jendela.
    expect(p.minWidth).toBe(windowWidth(cols))
    expect(f.minWidth).toBe(windowWidth(cols))
    expect(p.maxWidth).toBe(f.maxWidth)
    expect(p.maxHeight).toBe(f.maxHeight)
    expect(p.focusRow).toBeUndefined()
    expect(f.focusRow).toBe(0)
  })

  test("picker & form: lebar frame = windowWidth, judul & footer hadir", async () => {
    const cols = 82
    const rows = 21

    const pf = await pickerFrame(cols, rows)
    const ff = await formFrame(cols, rows)

    expect(topBorderWidth(pf)).toBe(windowWidth(cols))
    expect(topBorderWidth(ff)).toBe(windowWidth(cols))
    // Keduanya punya judul (dulu picker bisa menyembunyikannya).
    expect(titleLine(pf, "Sesi")).toBeTruthy()
    expect(titleLine(ff, "Sesi")).toBeTruthy()
    // Keduanya memakai footer baku yang sama (dulu form punya footer sendiri).
    const fp = footerLine(pf)
    const ffLine = footerLine(ff)
    expect(fp).toBeTruthy()
    expect(ffLine).toBeTruthy()
    expect(fp).toContain(t("hint.select"))
    expect(ffLine).toContain(t("hint.save"))
    for (const label of [t("hint.move"), t("hint.cancel")]) {
      expect(fp).toContain(label)
      expect(ffLine).toContain(label)
    }
  })

  test("fallback ASCII tetap jalan di kedua jendela", async () => {
    const cols = 82
    const rows = 21

    const pf = await pickerFrame(cols, rows, true)
    const ff = await formFrame(cols, rows, true)

    for (const frame of [pf, ff]) {
      expect(topBorderWidth(frame)).toBe(windowWidth(cols))
      // Sudut/border ASCII, bukan box Unicode.
      expect(frame.map(stripAnsi).some((l) => l.trimStart().startsWith("+"))).toBe(true)
      expect(frame.join("\n")).not.toContain("╭")
      expect(frame.join("\n")).not.toContain("│")
      // Nav fallback ↑↓ → "Up/Down" (bukan glyph Unicode).
      expect(frame.join("\n")).toContain("Up/Down")
    }
    // Ikon kategori sesi memakai fallback ">" — 1 kolom, label tetap terbaca.
    expect(pf.join("\n")).toContain("> p::s1")
    // ASCII tak mengubah isi form.
    expect(ff.join("\n")).toContain("A:")
  })
})
