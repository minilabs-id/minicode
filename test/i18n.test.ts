// Infrastruktur i18n (src/ui/i18n/): resolusi berlapis, fallback, interpolasi,
// kelengkapan dict (tsc mengawal id, test mengawal pemakaian).
import { afterEach, describe, expect, test } from "bun:test"
import { en } from "../src/ui/i18n/en.ts"
import { id } from "../src/ui/i18n/id.ts"
import {
  currentLocale,
  resetLocaleState,
  setConfigLocale,
  setSessionLocale,
  t,
} from "../src/ui/i18n/locale.ts"

afterEach(() => {
  resetLocaleState()
  delete process.env.MINICODE_LANG
  delete process.env.LANG
  delete process.env.LC_ALL
})

describe("resolusi locale", () => {
  test("default en bila tak ada sinyal", () => {
    expect(currentLocale()).toBe("en")
  })
  test("locale OS id_* → id", () => {
    process.env.LANG = "id_ID.UTF-8"
    expect(currentLocale()).toBe("id")
    process.env.LANG = "en_US.UTF-8"
    expect(currentLocale()).toBe("en")
  })
  test("config mengalahkan sistem", () => {
    process.env.LANG = "id_ID.UTF-8"
    setConfigLocale("en")
    expect(currentLocale()).toBe("en")
  })
  test("MINICODE_LANG mengalahkan config", () => {
    setConfigLocale("id")
    process.env.MINICODE_LANG = "en"
    expect(currentLocale()).toBe("en")
  })
  test("sesi (/lang) mengalahkan semua", () => {
    process.env.MINICODE_LANG = "en"
    setConfigLocale("en")
    setSessionLocale("id")
    expect(currentLocale()).toBe("id")
    setSessionLocale(null)
    expect(currentLocale()).toBe("en")
  })
  test("nilai asing diabaikan (fallback rantai)", () => {
    process.env.MINICODE_LANG = "xx"
    process.env.LANG = "id_ID.UTF-8"
    expect(currentLocale()).toBe("id")
  })
  test("LC_ALL mengalahkan LANG (urutan POSIX, F-06)", () => {
    process.env.LANG = "en_US.UTF-8"
    process.env.LC_ALL = "id_ID.UTF-8"
    expect(currentLocale()).toBe("id")
  })
  test("LANG kosong tak memblokir LC_ALL (F-06)", () => {
    process.env.LANG = ""
    process.env.LC_ALL = "id_ID.UTF-8"
    expect(currentLocale()).toBe("id")
  })
})

describe("t()", () => {
  test("mengambil sesuai locale + interpolasi", () => {
    expect(t("form.required")).toBe("required")
    setSessionLocale("id")
    expect(t("form.required")).toBe("wajib diisi")
    expect(t("app.newBelow", { n: 3 })).toBe("↓ 3 baru · PgDn")
    setSessionLocale("en")
    expect(t("app.newBelow", { n: 3 })).toBe("↓ 3 new · PgDn")
  })
  test("param tak dikenal dibiarkan (bukan crash)", () => {
    expect(t("app.newBelow", {})).toBe("↓ {n} new · PgDn")
  })
  test("dict id lengkap (kunci = en)", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort())
  })
  test("nilai id diterjemahkan (bukan copy-paste en), kecuali netral-locale", () => {
    // String netral-locale: label teknis universal (st.model, st.budget, tui.modeLine,
    // tui.langLine), nama perintah (help.cMore), nilai dinamis (tui.modelSet,
    // tui.thinkingSet).
    const NEUTRAL = new Set([
      "st.model",
      "st.budget",
      // Label kop sesi: "Model" adalah istilah teknis yang sama di id.
      "summary.model",
      // Kepala kolom tabel /context: "Model" juga istilah teknis.
      "ctx.colModel",
      "help.cMore",
      "help.gModel",
      "help.gMode",
      "tui.modelSet",
      "tui.thinkingSet",
      "tui.modeLine",
      "tui.langLine",
      // Judul popup /mode: "Mode" adalah istilah teknis yang sama di id.
      "tui.modeTitle",
      // "Turn" adalah istilah produk yang dipakai konsisten di id/en.
      "one.turnHead",
      "ts.turnHead",
      // "ckpt" singkatan teknis checkpoint — sama di dua locale.
      "ts.turnCkpt",
      // "Tool" adalah istilah produk (bukan diterjemahkan menjadi Alat).
      "appr.tool",
      // v7.35: kategori tool adalah label teknis dari wire contract tool —
      // sengaja identik di en/id supaya mapping kategori tak bergeser saat
      // locale berubah (dipakai sebagai kunci, bukan teks yang dibaca user).
      "ts.toolCategory.command",
      "ts.toolCategory.edit",
      "ts.toolCategory.read",
      "ts.toolCategory.subagent",
      "ts.toolCategory.thought",
      "ts.toolCategory.other",
      // Alasan kegagalan agent adalah token teknis (abort/timeout/error) —
      // sengaja identik di en/id supaya ringkasan stabil saat locale berubah.
      "ts.agentReason.aborted",
      "ts.agentReason.timeout",
      "ts.agentReason.error",
    ])
    const same = (Object.keys(en) as (keyof typeof en)[]).filter(
      (k) => id[k] === en[k] && !NEUTRAL.has(k),
    )
    expect(same).toEqual([])
  })
})
