// Grammar hint minimalis: `kunci label  kunci label` — pemisah HANYA spasi,
// tanpa `·`/titik dua. Kunci accent, label dim; align baris daftar memakai
// kolom marker tetap (listRow) agar label tidak bergeser saat seleksi pindah.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { hintLine } from "../src/ui/render/hint.ts"
import { listRow } from "../src/ui/render/list.ts"
import { glyphs, stripAnsi } from "../src/ui/render/theme.ts"

beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

describe("hintLine", () => {
  test("id: hanya spasi, tanpa separator dekoratif", () => {
    setSessionLocale("id")
    const line = stripAnsi(
      hintLine([
        { key: glyphs.upDown, label: t("hint.move") },
        { key: "Enter", label: t("hint.select") },
        { key: "Esc", label: t("hint.cancel") },
      ]),
    )
    expect(line).toBe(`${glyphs.upDown} pindah  Enter pilih  Esc batal`)
    expect(line).not.toContain("·")
    expect(line).not.toContain(":")
  })

  test("en: label konsisten", () => {
    const line = stripAnsi(
      hintLine([
        { key: glyphs.upDown, label: t("hint.move") },
        { key: "Enter", label: t("hint.select") },
        { key: "Esc", label: t("hint.cancel") },
      ]),
    )
    expect(line).toBe(`${glyphs.upDown} move  Enter select  Esc cancel`)
  })
})

describe("listRow", () => {
  test("label mulai di kolom yang sama baik terpilih maupun tidak", () => {
    const selected = stripAnsi(listRow("model-a", true))
    const plain = stripAnsi(listRow("model-b", false))
    expect(selected.indexOf("model-a")).toBe(plain.indexOf("model-b"))
    expect(selected).toContain(glyphs.arrow)
  })
})
