// Wrap composer INKREMENTAL, word-wrap komposer, dan placeholder paste.
//
// Kenapa ada: `chunkByWidth` adalah O(panjang baris). Mengetik satu huruf di
// prompt 5.000 karakter berarti membungkus ulang 5.000 karakter tiap ketukan —
// biaya itulah yang membuat ketikan panjang terasa berat. Karena composer
// menambah/menghapus SELALU di ujung baris, jalur inkremental hanya mengubah
// baris visual TERAKHIR bila kata tidak pindah ke/dari baris sebelumnya.
//
// Kontrak: helper inkremental mengembalikan `null` bila pola tak didukung
// supaya pemanggil jatuh balik ke wrap penuh (jawaban aman, bukan jawaban
// salah). Teks composer tak memuat SGR (engine membuang byte kontrol), jadi
// varian tanpa riwayat SGR cukup — SGR apa pun memicu fallback.
import { chunkByWidth, displayWidth, segmentGraphemes } from "./width.ts"

/** Tabel kelipatan lebar tab, sinkron dengan `chunkByWidth`. */
const TAB_WIDTH = 8

export const PASTE_COLLAPSE_MIN_LINES = 2
export const PASTE_COLLAPSE_MIN_CHARS = 160

function graphemeColumns(g: string): number {
  if (g === "\t") return TAB_WIDTH
  // Kolom lanjutan grapheme lebar: dihitung per grapheme (bukan per sel).
  return displayWidth(g)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

interface WrapToken {
  isSpace: boolean
  text: string
  graphemes: string[]
  width: number
}

function tokenizeBodyForWrap(
  body: string,
  atomicTokens?: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): WrapToken[] {
  const atomicKeys = atomicTokens
    ? Array.from(atomicTokens.keys())
        .filter((k) => k.length > 0)
        .sort((a, b) => b.length - a.length)
    : []
  const tokens: WrapToken[] = []
  let pos = 0

  while (pos < body.length) {
    let matchedAtomic = ""
    for (const key of atomicKeys) {
      if (body.startsWith(key, pos)) {
        matchedAtomic = key
        break
      }
    }
    if (matchedAtomic) {
      const graphemes = segmentGraphemes(matchedAtomic)
      let width = 0
      for (const g of graphemes) width += graphemeColumns(g)
      tokens.push({ isSpace: false, text: matchedAtomic, graphemes, width })
      pos += matchedAtomic.length
      continue
    }

    let nextMatch = body.length
    for (const key of atomicKeys) {
      const idx = body.indexOf(key, pos)
      if (idx >= 0 && idx < nextMatch) nextMatch = idx
    }
    const plainSlice = body.slice(pos, nextMatch)
    pos = nextMatch

    const gs = segmentGraphemes(plainSlice)
    let wordGs: string[] = []
    let wordText = ""
    let wordWidth = 0
    const flushWord = () => {
      if (!wordGs.length) return
      tokens.push({ isSpace: false, text: wordText, graphemes: wordGs, width: wordWidth })
      wordGs = []
      wordText = ""
      wordWidth = 0
    }

    for (const g of gs) {
      if (g === " " || g === "\t") {
        flushWord()
        tokens.push({ isSpace: true, text: g, graphemes: [g], width: graphemeColumns(g) })
      } else {
        wordGs.push(g)
        wordText += g
        wordWidth += graphemeColumns(g)
      }
    }
    flushWord()
  }

  return tokens
}

/**
 * Bungkus satu baris logis composer berbasis batas KATA (` ` / `\t`), tetap
 * mempertahankan setiap grapheme agar `rows.join("") === prefix + body` selalu
 * terpenuhi untuk pemetaan kursor dan klik mouse.
 *
 * Prefix pada baris pertama (`minicode ›`) dan token placeholder paste aktif
 * diperlakukan atomik agar tidak terpecah antarbaris. Kata tunggal yang lebih
 * panjang dari `width` tetap dipotong per grapheme agar tidak meluap.
 */
export function wrapComposerLine(
  prefix: string,
  body: string,
  width: number,
  atomicTokens?: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): string[] {
  if (!body) return [prefix]
  if (width <= 0) return chunkByWidth(`${prefix}${body}`, 1)
  const prefixW = displayWidth(prefix)
  if (prefixW >= width) return chunkByWidth(`${prefix}${body}`, width)

  const tokens = tokenizeBodyForWrap(body, atomicTokens)
  const rows: string[] = []
  let row = prefix
  let rowW = prefixW
  let hasBody = false

  for (const tok of tokens) {
    if (tok.isSpace) {
      if (rowW + tok.width <= width) {
        row += tok.text
        rowW += tok.width
        hasBody = true
      } else {
        rows.push(row)
        row = tok.text
        rowW = tok.width
        hasBody = true
      }
      continue
    }

    if (rowW + tok.width <= width) {
      row += tok.text
      rowW += tok.width
      hasBody = true
    } else if (hasBody && tok.width <= width) {
      rows.push(row)
      row = tok.text
      rowW = tok.width
      hasBody = true
    } else {
      // Kata/token melampaui lebar kotak, atau belum ada badan setelah prefix
      // di baris pertama: isi sisa baris dulu lalu pecah per grapheme agar
      // baris pertama tidak tertinggal sebagai prefix kosong sendirian.
      if (hasBody && row !== "") {
        rows.push(row)
        row = ""
        rowW = 0
      }
      for (const g of tok.graphemes) {
        const gw = graphemeColumns(g)
        if (gw <= 0) {
          row += g
          continue
        }
        if (rowW + gw > width && row !== "") {
          rows.push(row)
          row = ""
          rowW = 0
        }
        row += g
        rowW += gw
      }
      hasBody = true
    }
  }

  rows.push(row)
  return rows
}

/**
 * Jalur cepat penambahan karakter di akhir baris untuk mode word-wrap. Hanya
 * menerima kasus yang masih muat di baris terakhir agar paritas dengan
 * `wrapComposerLine` tetap 100% identik; selebihnya mengembalikan `null`.
 */
export function appendWordWrapped(
  rows: string[],
  appended: string,
  width: number,
): string[] | null {
  if (!rows.length || width <= 0) return null
  if (appended.includes("\n") || appended.includes("\r") || appended.includes("\x1b")) return null
  const last = rows[rows.length - 1]!
  const lastW = displayWidth(last)
  if (lastW > width) return null
  let appendedW = 0
  for (const g of segmentGraphemes(appended)) appendedW += graphemeColumns(g)
  if (lastW + appendedW > width) return null
  const out = rows.slice(0, -1)
  out.push(last + appended)
  return out
}

/**
 * Jalur cepat penghapusan karakter di akhir baris untuk mode word-wrap. Bila
 * baris menjadi kosong atau berpotensi menarik kata pertama kembali ke baris
 * sebelumnya, mengembalikan `null` supaya pemanggil membungkus ulang penuh.
 */
export function shaveWordWrapped(rows: string[], removed: string, width: number): string[] | null {
  if (!rows.length || width <= 0 || !removed) return null
  if (removed.includes("\x1b") || removed.includes("\n") || removed.includes("\r")) return null
  const last = rows[rows.length - 1]!
  if (!last.endsWith(removed)) return null
  const trimmed = last.slice(0, last.length - removed.length)
  if (trimmed === "" || displayWidth(trimmed) > width) return null
  if (rows.length === 1) return [trimmed]
  // Bila masih ada spasi/tab di baris terakhir, kata pertama tidak ikut mengecil
  // sehingga tidak mungkin tertarik naik ke baris sebelumnya.
  if (trimmed.includes(" ") || trimmed.includes("\t")) {
    const out = rows.slice(0, -1)
    out.push(trimmed)
    return out
  }
  return null
}

/**
 * Normalisasi teks hasil bracketed paste: satukan akhir baris (`\n`), jaga tab
 * indentasi (`\t`), dan buang byte kontrol C0/C1 lain agar aman di composer.
 */
export function cleanPastedText(raw: string): string {
  return (
    raw
      .replace(/\r\n|\r|[\u2028\u2029]/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: membuang byte kontrol dari paste
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/[\u0080-\u009f]/g, "")
  )
}

/** Hitung jumlah baris logis pada teks paste (abaikan paling banyak satu `\n` ekor). */
export function countPastedLines(cleaned: string): number {
  if (!cleaned) return 0
  const body = cleaned.endsWith("\n") ? cleaned.slice(0, -1) : cleaned
  if (!body) return 1
  return Math.max(1, body.split("\n").length)
}

/** Tentukan apakah payload paste perlu diringkas menjadi placeholder ringkas. */
export function shouldCollapsePaste(cleaned: string): boolean {
  return (
    cleaned.length > 0 &&
    (countPastedLines(cleaned) >= PASTE_COLLAPSE_MIN_LINES ||
      cleaned.length >= PASTE_COLLAPSE_MIN_CHARS)
  )
}

/** Alokasikan token placeholder unik seperti `{paste text 19 lines}`. */
export function allocatePasteToken(
  lineCount: number,
  existing: ReadonlyMap<string, string>,
): string {
  const unit = lineCount === 1 ? "line" : "lines"
  const base = `{paste text ${lineCount} ${unit}}`
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`{paste text ${lineCount} ${unit} #${n}}`)) n++
  return `{paste text ${lineCount} ${unit} #${n}}`
}

function pasteTokenRegex(keys: Iterable<string>): RegExp | null {
  const sorted = Array.from(keys)
    .filter((k) => k.length > 0)
    .sort((a, b) => b.length - a.length)
  if (!sorted.length) return null
  return new RegExp(sorted.map(escapeRegex).join("|"), "g")
}

/**
 * Ekspansikan seluruh token placeholder paste dalam satu lintasan tunggal
 * agar isi paste yang kebetulan memuat teks mirip placeholder tidak ter-ekspansi ganda.
 */
export function expandPasteTokens(text: string, pastes: ReadonlyMap<string, string>): string {
  if (!pastes.size || !text) return text
  const re = pasteTokenRegex(pastes.keys())
  if (!re) return text
  return text.replace(re, (match) => pastes.get(match) ?? match)
}

/** Warnai token placeholder paste yang masih berada di segmen baris tampil. */
export function highlightPasteTokens(
  segment: string,
  pastes: ReadonlyMap<string, string>,
  paint: (s: string) => string,
): string {
  if (!pastes.size || !segment) return segment
  const re = pasteTokenRegex(pastes.keys())
  if (!re) return segment
  return segment.replace(re, (match) => paint(match))
}

export interface PasteTokenMatch {
  utfStart: number
  utfEnd: number
  gStart: number
  gEnd: number
  token: string
}

/** Cari seluruh token paste `{paste ...}` beserta rentang UTF-16 dan grapheme-nya. */
export function findPasteTokenSpans(
  line: string,
  pastes: ReadonlyMap<string, string>,
): PasteTokenMatch[] {
  if (!pastes.size || !line) return []
  const re = pasteTokenRegex(pastes.keys())
  if (!re) return []
  const out: PasteTokenMatch[] = []
  for (const match of line.matchAll(re)) {
    const token = match[0]
    const utfStart = match.index ?? -1
    if (utfStart < 0) continue
    const utfEnd = utfStart + token.length
    const gStart = segmentGraphemes(line.slice(0, utfStart)).length
    const gEnd = gStart + segmentGraphemes(token).length
    out.push({ utfStart, utfEnd, gStart, gEnd, token })
  }
  return out
}

/**
 * Cari token placeholder paste yang terkena Backspace (tepat di kanan atau di
 * dalam token) atau Delete (tepat di kiri atau di dalam token) agar terhapus
 * secara atomik.
 */
export function findPasteTokenAtCursor(
  line: string,
  cursor: number,
  pastes: ReadonlyMap<string, string>,
  mode: "backspace" | "delete",
): PasteTokenMatch | null {
  for (const span of findPasteTokenSpans(line, pastes)) {
    const hit =
      mode === "backspace"
        ? cursor > span.gStart && cursor <= span.gEnd
        : cursor >= span.gStart && cursor < span.gEnd
    if (hit) return span
  }
  return null
}

/**
 * Jepit posisi kursor grapheme agar tidak berhenti di tengah placeholder paste
 * atomik (supaya navigasi horizontal/vertikal/klik mouse melompati token utuh).
 */
export function snapCursorOutOfPasteToken(
  line: string,
  cursor: number,
  pastes: ReadonlyMap<string, string>,
  bias: "left" | "right" | "nearest" = "nearest",
): number {
  for (const span of findPasteTokenSpans(line, pastes)) {
    if (cursor > span.gStart && cursor < span.gEnd) {
      if (bias === "left") return span.gStart
      if (bias === "right") return span.gEnd
      return cursor - span.gStart <= span.gEnd - cursor ? span.gStart : span.gEnd
    }
  }
  return cursor
}

/** Perluas rentang seleksi grapheme [start, end] agar tidak membelah token paste. */
export function expandRangeToPasteTokens(
  line: string,
  start: number,
  end: number,
  pastes: ReadonlyMap<string, string>,
): { start: number; end: number } {
  let lo = Math.min(start, end)
  let hi = Math.max(start, end)
  if (lo === hi) return { start: lo, end: hi }
  for (const span of findPasteTokenSpans(line, pastes)) {
    if (lo > span.gStart && lo < span.gEnd) lo = span.gStart
    if (hi > span.gStart && hi < span.gEnd) hi = span.gEnd
  }
  return { start: lo, end: hi }
}

/**
 * Deteksi apakah Ctrl+W di `cursor` menyentuh placeholder paste atomik (baik
 * tepat di ujung kanan token maupun setelah spasi/tab di kanannya) karena token
 * `{paste ...}` memuat spasi sehingga regex `\S+\s*$` akan merobeknya.
 */
export function findPasteTokenBeforeWordDelete(
  line: string,
  cursor: number,
  pastes: ReadonlyMap<string, string>,
): PasteTokenMatch | null {
  if (!pastes.size || !line || cursor <= 0) return null
  const graphemes = segmentGraphemes(line)
  let nonSpaceEnd = Math.min(cursor, graphemes.length)
  while (
    nonSpaceEnd > 0 &&
    (graphemes[nonSpaceEnd - 1] === " " || graphemes[nonSpaceEnd - 1] === "\t")
  ) {
    nonSpaceEnd--
  }
  if (nonSpaceEnd <= 0) return null
  for (const span of findPasteTokenSpans(line, pastes)) {
    if (nonSpaceEnd > span.gStart && nonSpaceEnd <= span.gEnd) {
      return span
    }
  }
  return null
}

/**
 * Perluas `rows` (hasil `chunkByWidth` untuk teks sebelumnya) dengan `appended`
 * di UJUNG, mempertahankan wrap greedy. `null` bila tak bisa (baris kosong,
 * lebar ≤ 0, atau ada newline/SGR) — pemanggil membungkus ulang penuh.
 */
export function appendWrapped(rows: string[], appended: string, width: number): string[] | null {
  if (!rows.length || width <= 0) return null
  if (appended.includes("\n") || appended.includes("\r") || appended.includes("\x1b")) return null
  const out = rows.slice(0, -1)
  let buf = rows[rows.length - 1]!
  for (const g of segmentGraphemes(appended)) {
    const gw = graphemeColumns(g)
    if (gw <= 0) {
      // Grapheme nol-lebar menempel ke buf tanpa menghabiskan kolom.
      buf += g
      continue
    }
    if (displayWidth(buf) + gw > width && buf !== "") {
      out.push(buf)
      buf = ""
    }
    buf += g
  }
  out.push(buf)
  return out
}

/**
 * Buang `removed` (UTF-16, harus menjadi AKHIR baris visual terakhir) dari
 * `rows`. `null` bila baris terakhir tak diakhiri `removed` (mis. batas
 * grapheme berbeda) — pemanggil membungkus ulang penuh.
 */
export function shaveWrapped(rows: string[], removed: string, width: number): string[] | null {
  if (!rows.length || width <= 0 || !removed) return null
  if (removed.includes("\x1b")) return null
  const last = rows[rows.length - 1]!
  if (!last.endsWith(removed)) return null
  const trimmed = last.slice(0, last.length - removed.length)
  if (trimmed === "") {
    // Baris terakhir habis. Baris sebelumnya jenuh, jadi cukup pop — tapi bila
    // ini satu-satunya baris, serahkan ke pemanggil (prefix prompt bisa hilang
    // saat baris jadi kosong dan special-case `!line` yang menanganinya).
    if (rows.length === 1) return null
    return rows.slice(0, -1)
  }
  const out = rows.slice(0, -1)
  out.push(trimmed)
  return out
}
