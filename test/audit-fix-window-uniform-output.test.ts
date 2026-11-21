// Audit v0.33 —frame jendela wizard & output wajib satu aturan: lebar, footer,
// dan judul identik pada cols/rows yang sama. Test ini mengunci seam spec agar
// regresi "popup welcome lebar 48, output 72" tak masuk lagi. Bukan pengganti
// test interaktif (wizard.test / output-window.test), melengkapi mereka.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { t } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { outputWindowSpec } from "../src/ui/screens/output-window.ts"
import { windowFooter, windowMaxHeight, windowWidth } from "../src/ui/screens/window.ts"
import { wizardWindowSpec } from "../src/ui/screens/wizard.ts"

const COLS = 88
const ROWS = 30
const wizardSrc = () => readFileSync(join(__dirname, "../src/ui/screens/wizard.ts"), "utf8")

describe("audit v0.33: frame wizard & output window seragam", () => {
  test("lebar frame identik dan mengikuti windowWidth(cols)", () => {
    const wiz = wizardWindowSpec({ body: ["isian"], cols: COLS, rows: ROWS })
    const out = outputWindowSpec({ title: "Help", body: ["isian"], cols: COLS, rows: ROWS })

    expect(wiz.minWidth).toBe(windowWidth(COLS))
    expect(wiz.maxWidth).toBe(windowWidth(COLS))
    expect(out.minWidth).toBe(windowWidth(COLS))
    expect(out.maxWidth).toBe(windowWidth(COLS))
    expect(wiz.minWidth).toBe(out.minWidth)
    expect(wiz.maxWidth).toBe(out.maxWidth)
  })

  test("footer selalu windowFooter — extraHints jadi tambahan, bukan pengganti", () => {
    const outHints = [{ key: "c", label: t("hint.copy") }]
    const wizHints = [{ key: "Enter", label: t("hint.close") }]
    const out = outputWindowSpec({
      title: "Status",
      body: [],
      cols: COLS,
      rows: ROWS,
      extraHints: outHints,
    })
    const wiz = wizardWindowSpec({
      body: ["gagal"],
      cols: COLS,
      rows: ROWS,
      extraHints: wizHints,
    })

    expect(out.footer).toBe(windowFooter(outHints))
    expect(wiz.footer).toBe(windowFooter(wizHints))
    // Footer baku tetap memuat navigasi + Esc batal pada kedua jendela.
    for (const frame of [out, wiz]) {
      const plain = stripAnsi(frame.footer ?? "")
      expect(plain).toContain(t("hint.move"))
      expect(plain).toContain(t("hint.cancel"))
    }
    expect(stripAnsi(out.footer ?? "")).toContain(t("hint.copy"))
    expect(stripAnsi(wiz.footer ?? "")).toContain(t("hint.close"))
  })

  test("judul selalu ada: wizard memakai wiz.title, output memakai judul caller", () => {
    const wiz = wizardWindowSpec({ body: [], cols: COLS, rows: ROWS })
    const out = outputWindowSpec({ title: "History", body: [], cols: COLS, rows: ROWS })

    expect(wiz.title).toBe(t("wiz.title"))
    expect(wiz.title.length).toBeGreaterThan(0)
    expect(out.title).toBe("History")
    expect(out.title.length).toBeGreaterThan(0)
  })

  test("di cols/rows berapa pun, kedua frame memakai rumus yang sama", () => {
    const sizes: ReadonlyArray<readonly [number, number]> = [
      [40, 20],
      [60, 24],
      [100, 30],
      [200, 40],
    ]
    for (const [cols, rows] of sizes) {
      const wiz = wizardWindowSpec({ body: [], cols, rows })
      const out = outputWindowSpec({ title: "X", body: [], cols, rows })
      expect(wiz.maxWidth).toBe(out.maxWidth)
      expect(wiz.footer).toBe(out.footer)
      expect(out.maxHeight).toBe(windowMaxHeight(rows) + 4)
    }
  })

  test("wizard tidak lagi memakai lebar ad-hoc", () => {
    // Kerangka lama (statusWidth/doneWidth/popupBoxWidth) bikin tiap langkah
    // punya lebar sendiri — cached di sini supaya tak muncul kembali.
    const src = wizardSrc()
    expect(src).not.toContain("statusWidth")
    expect(src).not.toContain("doneWidth")
    expect(src).not.toContain("popupBoxWidth")
    expect(src).toContain("wizardWindowSpec(")
    expect(src).toContain("windowSpec(")
  })
})
