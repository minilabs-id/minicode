// Wrap composer inkremental (src/ui/render/composer-wrap.ts): jalur ketik
// panjang. Test ini membuktikan PARITAS dengan `chunkByWidth` penuh — helper
// boleh memilih fallback, tapi bila ia mengembalikan hasil, hasilnya harus
// identik dengan membungkus ulang seluruh baris dari nol.
import { describe, expect, test } from "bun:test"
import {
  allocatePasteToken,
  appendWordWrapped,
  appendWrapped,
  cleanPastedText,
  countPastedLines,
  expandPasteTokens,
  expandRangeToPasteTokens,
  findPasteTokenAtCursor,
  findPasteTokenBeforeWordDelete,
  highlightPasteTokens,
  shaveWordWrapped,
  shaveWrapped,
  shouldCollapsePaste,
  snapCursorOutOfPasteToken,
  wrapComposerLine,
} from "../src/ui/render/composer-wrap.ts"
import { chunkByWidth } from "../src/ui/render/width.ts"

const P1 = "minicode › "
const P2 = "  · "

/** Bangun rows composer persis seperti app: prefix per baris logis. */
function buildRows(line: string, w: number): string[] {
  const logical = line.split("\n")
  const rows: string[] = []
  for (let i = 0; i < logical.length; i++) {
    const prefix = i === 0 ? P1 : P2
    rows.push(...chunkByWidth(`${prefix}${logical[i] ?? ""}`, w))
  }
  return rows
}

describe("appendWrapped: paritas dengan chunkByWidth penuh", () => {
  test("ASCII acak: setiap penambahan sama dengan wrap ulang", () => {
    for (const w of [12, 20, 40]) {
      let line = ""
      let rows = buildRows(line, w)
      let seed = 12345
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed / 0x7fffffff
      }
      for (let step = 0; step < 300; step++) {
        const ch = String.fromCharCode(97 + Math.floor(rnd() * 26))
        line += ch
        const next = appendWrapped(rows, ch, w)
        expect(next).not.toBeNull()
        expect(next).toEqual(buildRows(line, w))
        rows = next!
      }
    }
  })

  test("glyph lebar (CJK) tak terbelah di batas kolom", () => {
    const w = 10
    let line = ""
    let rows = buildRows(line, w)
    for (const ch of "你好世界abcdef你好") {
      line += ch
      const next = appendWrapped(rows, ch, w)
      expect(next).not.toBeNull()
      expect(next).toEqual(buildRows(line, w))
      rows = next!
    }
  })

  test("multiline: hanya baris terakhir yang berubah", () => {
    const w = 14
    let line = "halo dunia\nbaris kedua yang panjang"
    let rows = buildRows(line, w)
    for (const ch of " terus") {
      line += ch
      const next = appendWrapped(rows, ch, w)
      expect(next).toEqual(buildRows(line, w))
      rows = next!
    }
  })

  test("menolak pola tak didukung (fallback), bukan menebak", () => {
    expect(appendWrapped([], "a", 10)).toBeNull()
    expect(appendWrapped(["x"], "a\nb", 10)).toBeNull()
    expect(appendWrapped(["x"], "a\x1b[31mb", 10)).toBeNull()
    expect(appendWrapped(["x"], "a", 0)).toBeNull()
  })
})

describe("shaveWrapped: paritas dengan chunkByWidth penuh", () => {
  test("ASCII acak: setiap backspace sama dengan wrap ulang", () => {
    for (const w of [12, 20, 40]) {
      let line = "abcdefghijklmnopqrstuvwxyz0123456789 aaa bbb ccc ddd"
      let rows = buildRows(line, w)
      while (line.length > 0) {
        const removed = line.slice(-1)
        const next = shaveWrapped(rows, removed, w)
        line = line.slice(0, -1)
        if (line === "") break
        expect(next).not.toBeNull()
        expect(next).toEqual(buildRows(line, w))
        rows = next!
      }
    }
  })

  test("baris terakhir kosong → pop, baris sebelumnya utuh", () => {
    const w = 6
    const rows = buildRows("abcdefghijkl", w) // beberapa baris penuh
    const next = shaveWrapped(rows, "l", w)
    expect(next).toEqual(buildRows("abcdefghijk", w))
  })

  test("menolak bila ekor tak cocok (fallback)", () => {
    expect(shaveWrapped(["abc"], "z", 10)).toBeNull()
    expect(shaveWrapped([], "a", 10)).toBeNull()
    expect(shaveWrapped(["abc"], "", 10)).toBeNull()
    expect(shaveWrapped(["abc"], "a\x1b[0m", 10)).toBeNull()
  })
})

describe("wrapComposerLine: word-wrap & konservasi grapheme", () => {
  test("kata utuh pindah ke baris berikut tanpa terpotong di tengah", () => {
    const rows = wrapComposerLine("minicode ›", "saya mau menulis kalimat panjang sekali", 24)
    expect(rows).toEqual(["minicode ›saya mau ", "menulis kalimat panjang ", "sekali"])
    expect(rows.join("")).toBe("minicode ›saya mau menulis kalimat panjang sekali")
  })

  test("prefix panjang tidak terbelah di spasi antara minicode dan panah", () => {
    const rows = wrapComposerLine("minicode ›", "contoh", 13)
    expect(rows[0]).toBe("minicode ›con")
    expect(rows[1]).toBe("toh")
    expect(rows.join("")).toBe("minicode ›contoh")
  })

  test("token paste atomik tidak terpecah bila muat di satu baris", () => {
    const pastes = new Map([["{paste text 19 lines}", "isi"]])
    const body = "tolong cek {paste text 19 lines} ini"
    const rows = wrapComposerLine("›", body, 26, pastes)
    expect(rows).toEqual(["›tolong cek ", "{paste text 19 lines} ini"])
    expect(rows.some((r) => r.includes("{paste text 19 lines}"))).toBe(true)
    expect(rows.join("")).toBe(`›${body}`)
  })

  test("kata tunggal / URL lebih panjang dari width dipecah per grapheme tanpa meluap", () => {
    const url = "https://contoh.example.com/jalur/sangat/panjang"
    const rows = wrapComposerLine("›", `buka ${url}`, 16)
    expect(rows[0]).toBe("›buka ")
    expect(rows[1]).toBe("https://contoh.e")
    expect(rows.join("")).toBe(`›buka ${url}`)
  })

  test("konservasi grapheme untuk CJK, emoji keluarga, dan combining marks", () => {
    const samples = [
      "halo 你好世界 😀 👨‍👩‍👧 kaki",
      "kataa\u0301 kata2 kata3",
      "   spasi banyak   di tengah  ",
      "satu\tdeskripsi\tdengan\ttab",
    ]
    for (const w of [12, 18, 25, 40]) {
      for (const s of samples) {
        const rows = wrapComposerLine("›", s, w)
        expect(rows.join("")).toBe(`›${s}`)
        expect(rows.length).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test("appendWordWrapped / shaveWordWrapped paritas 100% dengan wrapComposerLine saat non-null", () => {
    const w = 18
    const text = "satu dua tiga empat lima enam"
    let built = ""
    let rows = wrapComposerLine("›", built, w)
    for (const ch of text) {
      built += ch
      const full = wrapComposerLine("›", built, w)
      const inc = appendWordWrapped(rows, ch, w)
      if (inc !== null) {
        expect(inc).toEqual(full)
        rows = inc
      } else {
        rows = full
      }
    }
    while (built.length > 0) {
      const removed = built.slice(-1)
      const next = built.slice(0, -1)
      const full = wrapComposerLine("›", next, w)
      const inc = shaveWordWrapped(rows, removed, w)
      if (inc !== null) {
        expect(inc).toEqual(full)
        rows = inc
      } else {
        rows = full
      }
      built = next
    }
    // Saat melampaui lebar kotak, jalur inkremental mengembalikan null agar kata dipindah penuh.
    expect(appendWordWrapped(["›kata satu"], "x".repeat(15), 18)).toBeNull()
    expect(shaveWordWrapped(["›kata ", "dua"], "a", 18)).toBeNull()
  })
})

describe("helper placeholder paste", () => {
  test("cleanPastedText normalisasi newline, pertahankan tab, dan buang kontrol", () => {
    expect(cleanPastedText("a\r\nb\r\tc\x00\x1b[31m\u009bX\u2028d")).toBe("a\nb\n\tc[31mX\nd")
  })

  test("countPastedLines & shouldCollapsePaste", () => {
    const lines19 = Array.from({ length: 19 }, (_, i) => `baris ${i + 1}`).join("\n")
    expect(countPastedLines(`${lines19}\n`)).toBe(19)
    expect(countPastedLines("satu baris")).toBe(1)
    expect(shouldCollapsePaste("pendek")).toBe(false)
    expect(shouldCollapsePaste("a\nb")).toBe(true)
    expect(shouldCollapsePaste("x".repeat(160))).toBe(true)
  })

  test("allocatePasteToken, expandPasteTokens (satu lintasan), dan highlightPasteTokens", () => {
    const map = new Map<string, string>()
    const t1 = allocatePasteToken(19, map)
    expect(t1).toBe("{paste text 19 lines}")
    map.set(t1, "A -> {paste text 19 lines #2}")
    const t2 = allocatePasteToken(19, map)
    expect(t2).toBe("{paste text 19 lines #2}")
    map.set(t2, "ISI_KEDUA")
    const t3 = allocatePasteToken(1, map)
    expect(t3).toBe("{paste text 1 line}")
    map.set(t3, "PANJANG")

    // Satu lintasan: kemunculan string "{paste text 19 lines #2}" di dalam isi t1 TIDAK ikut ter-ekspansi!
    const expanded = expandPasteTokens(`cek ${t1} + ${t2} + ${t3}`, map)
    expect(expanded).toBe("cek A -> {paste text 19 lines #2} + ISI_KEDUA + PANJANG")
    expect(highlightPasteTokens(`x ${t1} y`, map, (s) => `[${s}]`)).toBe(
      "x [{paste text 19 lines}] y",
    )
  })

  test("findPasteTokenAtCursor mendukung backspace & delete atomik dengan prefix emoji", () => {
    const token = "{paste text 19 lines}"
    const map = new Map([[token, "isi"]])
    const line = `😀 ${token}!`
    // "😀" (1 grapheme) + " " (1 grapheme) = index 2..23 (token panjang 21 grapheme)
    expect(findPasteTokenAtCursor(line, 2, map, "backspace")).toBeNull()
    expect(findPasteTokenAtCursor(line, 23, map, "backspace")?.token).toBe(token)
    expect(findPasteTokenAtCursor(line, 2, map, "delete")?.token).toBe(token)
    expect(findPasteTokenAtCursor(line, 23, map, "delete")).toBeNull()
    expect(findPasteTokenAtCursor(line, 10, map, "backspace")?.gStart).toBe(2)
  })

  test("snapCursorOutOfPasteToken, expandRangeToPasteTokens, dan findPasteTokenBeforeWordDelete menjaga keutuhan token", () => {
    const token = "{paste text 19 lines}"
    const map = new Map([[token, "isi"]])
    const line = `hai ${token} ok`
    // gStart = 4, gEnd = 25
    expect(snapCursorOutOfPasteToken(line, 10, map, "left")).toBe(4)
    expect(snapCursorOutOfPasteToken(line, 10, map, "right")).toBe(25)
    expect(snapCursorOutOfPasteToken(line, 4, map, "nearest")).toBe(4)
    expect(expandRangeToPasteTokens(line, 2, 12, map)).toEqual({ start: 2, end: 25 })
    expect(expandRangeToPasteTokens(line, 12, 27, map)).toEqual({ start: 4, end: 27 })
    expect(findPasteTokenBeforeWordDelete(line, 25, map)?.gStart).toBe(4)
    expect(findPasteTokenBeforeWordDelete(line, 26, map)?.gStart).toBe(4)
    expect(findPasteTokenBeforeWordDelete(line, 28, map)).toBeNull()
  })
})
