// Audit F3/F5/F6/F7: pembersihan dokumen & UI yang tak punya konsumen.
// - F6: kunci i18n `app.idleHint` dihapus dari kedua locale (tak ada pemakai),
//   dan parity kunci en/id dikunci eksplisit (tsc menjaga lewat
//   Record<MsgKey, string>; test ini mengunci niatnya agar tak ada kunci yang
//   "hidup" di satu locale saja).
// - F3/F5/F7: kontrak terminal tidak boleh lagi mengklaim perilaku lama
//   (FORCE_MONO / zero-state logo+hint) sebagai keadaan saat ini.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { en } from "../src/ui/i18n/en.ts"
import { id } from "../src/ui/i18n/id.ts"

const enKeys = Object.keys(en)
const idKeys = Object.keys(id)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const contract = readFileSync(join(ROOT, "docs", "TERMINAL_CONTRACT.md"), "utf8")

describe("audit F6: kamus i18n bersih & seimbang", () => {
  test("parity kunci en/id — tak ada kunci di satu locale saja", () => {
    const onlyEn = enKeys.filter((k) => !idKeys.includes(k))
    const onlyId = idKeys.filter((k) => !enKeys.includes(k))
    expect(onlyEn, "kunci hanya di en.ts").toEqual([])
    expect(onlyId, "kunci hanya di id.ts").toEqual([])
  })

  test("app.idleHint sudah dihapus (dulu definisi tanpa konsumen)", () => {
    expect(enKeys).not.toContain("app.idleHint")
    expect(idKeys).not.toContain("app.idleHint")
  })
})

describe("audit F3/F5/F7: kontrak terminal jujur", () => {
  test("arsip versi v7.x hadir dengan aturan presedensi", () => {
    // v7.40: yang dijaga adalah MARKER struktural, bukan kalimat persis —
    // prose boleh dirapikan selama heading versi + aturan presedensi ada.
    // Tanpa aturan ini, entri v7.22 (historis) terbaca sebagai keadaan kini.
    expect(contract).toMatch(/^Perubahan v7\.\d+/m)
    expect(contract).toMatch(/Status & presedensi/m)
    expect(contract).toMatch(/Aturan presedensi:/m)
  })

  test("peta proteksi zero-state: KOSONG tanpa logo (bukan 'logo+hint')", () => {
    // tui-app.test.ts:1413 menegaskan transkrip awal KOSONG.
    expect(contract).not.toMatch(/zero-state\s+logo\s*\+\s*hint/i)
    expect(contract).toMatch(/zero-state\s+kosong\s+tanpa\s+logo/i)
  })

  test("v7.35 mencatat unifikasi scrollBy ke viewH", () => {
    expect(contract).toMatch(/^Perubahan v7\.35/m)
    expect(contract).toMatch(/scrollBy/)
    expect(contract).toMatch(/wrapped\s*-\s*viewH/)
  })
})
