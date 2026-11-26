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

  test("footer mengikuti peran jendela — extraHints ditambahkan tanpa hint palsu", () => {
    const outHints = [{ key: "c", label: t("hint.copy") }]
    const wizHints = [{ key: "r/Enter", label: t("hint.retry") }]
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

    expect(out.footer).toBe(
      windowFooter(outHints, { role: "viewer", maxWidth: windowWidth(COLS) - 4 }),
    )
    expect(wiz.footer).toBe(
      windowFooter(wizHints, { role: "progress", maxWidth: windowWidth(COLS) - 4 }),
    )
    expect(out.escHint).toBe(true)
    expect(wiz.escHint).toBeUndefined()
    expect(stripAnsi(out.footer ?? "")).toContain(t("hint.copy"))
    expect(stripAnsi(out.footer ?? "")).not.toContain(t("hint.close"))
    expect(stripAnsi(out.footer ?? "")).not.toContain(t("hint.select"))
    expect(stripAnsi(wiz.footer ?? "")).toContain(t("hint.retry"))
    // Kotak progres pasif tanpa extraHints tidak memajang hint navigasi.
    const passive = wizardWindowSpec({ body: ["loading"], cols: COLS, rows: ROWS })
    expect(passive.footer).toBeUndefined()
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
      expect(wiz.maxHeight).toBe(out.maxHeight)
      expect(wiz.footer).toBeUndefined()
      expect(out.footer).toBeUndefined()
      expect(wiz.escHint).toBeUndefined()
      expect(out.escHint).toBe(true)
      expect(out.maxHeight).toBe(windowMaxHeight(rows))
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
