// Prompt engine - PURE functions untuk logika input interaktif.
// Sama sekali tidak menyentuh stdin/stdout - hanya data -> data.
// Dipakai askLine (src/ui/input/input.ts) + unit test.

import { displayWidth } from "../render/width.ts"

export interface PromptState {
  line: string
  /**
   * Posisi kursor dalam satuan CODE POINT (bukan UTF-16 unit), 0..len.
   * Tanpa ini tidak ada editing di tengah baris: user harus menghapus seluruh
   * sisa prompt untuk memperbaiki satu kata.
   */
  cursor: number
  sel: number // index seleksi dropdown, -1 = tidak ada
  menuOpen: boolean
}

export const MAX_VISIBLE = 10

// Hasil render satu frame - pure spec, renderer (input.ts) yang menulis ke stdout.
export interface RenderSpec {
  inputLine: string // prompt + line (baris 1)
  /** Kolom kursor (0-based) relatif awal inputLine — untuk ESC[<n>G. */
  cursorCol: number
  rows: { kind: "header" | "item"; text: string; picked: boolean }[] // baris dropdown
  moreCount: number // jumlah item tersembunyi (0 = tidak ada)
  totalRows: number // jumlah baris dropdown termasuk baris "more"
}

export function createState(): PromptState {
  return { line: "", cursor: 0, sel: -1, menuOpen: false }
}

// Keypress ter-normalisasi (hasil decode binari stdin).
export type PromptKey =
  | { type: "char"; ch: string }
  | { type: "backspace" }
  | { type: "delete" } // hapus karakter DI kursor (Del)
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "up" }
  | { type: "down" }
  | { type: "pageup"; modifier?: number }
  | { type: "pagedown"; modifier?: number }
  | { type: "wheelup"; x?: number; y?: number }
  | { type: "wheeldown"; x?: number; y?: number }
  | {
      type: "mouse"
      action: "press" | "release" | "drag" | "move"
      button: 0 | 1 | 2 | null
      x: number
      y: number
      modifiers: number
    }
  | { type: "tab" }
  | { type: "enter" }
  | { type: "esc" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-u" } // clear line
  | { type: "ctrl-w" } // delete previous word
  | { type: "ctrl-o" } // expand detail (TUI)
  | { type: "ctrl-r" } // reverse-i-search history
  | { type: "ctrl-t" } // toggle expand/minimize reasoning (TUI)
  | { type: "ctrl-n" } // tambah (model-manager: Ctrl+N = add model)
  | { type: "ctrl-j" } // sisipkan newline (multiline opt-in; Enter=\r tetap submit)
  | { type: "shift-tab" } // toggle permission mode (TUI) — ESC[Z didekode decodeKey
  | { type: "ignore" } // sekuens yang sengaja dibuang (mis. byte mouse)

// Terapkan satu keypress -> state baru + render spec + action (submit/cancel).
export type PromptAction = "none" | "render" | "submit" | "cancel"

// ── Helper grapheme ──
// String JS diindeks per UTF-16 unit; emoji memakai dua. Array.from memecah per
// code point, tapi grapheme cluster (ZWJ 👨‍👩‍👧, flag 🇮🇩, emoji + VS16 ❤️) tetap
// terbelah — backspace lalu menyisakan setengah. Intl.Segmenter membagi di
// batas grapheme sungguhan (Node 16+ / Bun tersedia); fallback ke code point
// di runtime tanpa dukungan.
let segmenter: Intl.Segmenter | undefined
/**
 * Pisah string menjadi grapheme. ASCII murni dilewati cepat (satu char = satu
 * grapheme) dan hasilnya di-memo satu entri: satu paint memanggil ini berkali-
 * kali untuk baris yang SAMA (layout, posisi kursor, dsb.), dan `Intl.Segmenter`
 * adalah biaya terbesar di jalur ketik. Pemanggil MENGUBAH array hasil
 * (splice), jadi cache selalu disalin keluar — bukan dikembalikan langsung.
 */
function segmentInto(s: string): string[] {
  let ascii = true
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false
      break
    }
  }
  if (ascii) return s.split("")
  try {
    segmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" })
    return [...segmenter.segment(s)].map((seg) => seg.segment)
  } catch {
    return Array.from(s)
  }
}

let memoInput: string | null = null
let memoOutput: string[] | null = null

export function toGraphemes(s: string): string[] {
  if (memoInput === s && memoOutput !== null) return memoOutput.slice()
  const out = segmentInto(s)
  memoInput = s
  memoOutput = out
  return out.slice()
}

/** Panjang dalam satuan grapheme (bukan code point / UTF-16 unit). */
export function pointLength(s: string): number {
  return toGraphemes(s).length
}

/** Menghitung jumlah baris logis dalam teks prompt (berdasarkan separator \n). */
export function countLogicalLines(text: string): number {
  return text.split("\n").length
}

/** Menghitung indeks baris kursor (0-based) dan offset kolom dalam baris tersebut. */
export function cursorLineIndex(text: string, cursor: number): { lineIdx: number; colIdx: number } {
  const units = toGraphemes(text)
  const before = units.slice(0, Math.max(0, Math.min(cursor, units.length))).join("")
  const lines = before.split("\n")
  const lineIdx = lines.length - 1
  const colIdx = toGraphemes(lines[lineIdx] ?? "").length
  return { lineIdx, colIdx }
}

// Tanda diakritik Thai/Lao yang menempel: satu grapheme Thai bisa terdiri
// dari konsonan + 1-2 tanda (mis. U+0E19 U+0E49 U+0E33 = satu suku kata).
// Menghapus per grapheme (aturan emoji ZWJ) membuat satu backspace menelan
// SELURUH suku kata sekaligus — platform menghapus per code point untuk
// aksara ini (bug Claude #83449). deletePrevUnit memilih satuan hapus yang
// benar: diakritik terakhir dulu, lalu bertahap.
// (Range ditulis \u eksplisit — literal combining char pernah rusak jadi U+FFFD
// oleh pipeline PowerShell tanpa encoding, dijaga test/import-convention.)
const THAI_DEPENDENT = new RegExp(
  `[${String.fromCharCode(0x0e31)}-${String.fromCharCode(0x0e4e)}${String.fromCharCode(0x0ec8)}-${String.fromCharCode(0x0ecd)}]`,
)
export function deletePrevUnit(line: string, cursor: number): { line: string; cursor: number } {
  if (cursor <= 0) return { line, cursor }
  const pts = toGraphemes(line)
  const target = pts[cursor - 1] ?? ""
  if (THAI_DEPENDENT.test(target)) {
    // Potong satu code point terakhir cluster via indeks UTF-16 mentah.
    // Sisa cluster tetap 1 grapheme di posisi sama, jadi kursor BERTAHAN
    // (bukan mundur): backspace berikut menghapus diakritik berikutnya —
    // persis perilaku platform (satu suku kata butuh N kali tekan).
    // clampCursor menangani kasus sisa kosong (cluster tinggal 1 tanda).
    const at = unitIndex(line, cursor)
    const cps = Array.from(target)
    const lastLen = cps[cps.length - 1]?.length ?? 1
    const next = line.slice(0, at - lastLen) + line.slice(at)
    return { line: next, cursor: clampCursor(next, cursor) }
  }
  pts.splice(cursor - 1, 1)
  return { line: pts.join(""), cursor: cursor - 1 }
}

/** Konversi indeks grapheme -> indeks UTF-16, untuk slice(). */
function unitIndex(s: string, point: number): number {
  const pts = toGraphemes(s)
  let units = 0
  for (let i = 0; i < point && i < pts.length; i++) units += pts[i]!.length
  return units
}

function clampCursor(line: string, cursor: number): number {
  const max = pointLength(line)
  return cursor < 0 ? 0 : cursor > max ? max : cursor
}

/** Sisipkan `ins` pada posisi kursor; kursor maju sepanjang teks yang disisipkan. */
function insertAt(line: string, cursor: number, ins: string): { line: string; cursor: number } {
  const at = unitIndex(line, cursor)
  return {
    line: line.slice(0, at) + ins + line.slice(at),
    cursor: cursor + pointLength(ins),
  }
}

export function applyKey(
  state: PromptState,
  key: PromptKey,
  hints: (line: string) => string[],
): { state: PromptState; action: PromptAction } {
  const countOf = (line: string): number => hints(line).length
  const pickSelected = (line: string) => {
    const rows = hints(line)
    if (!rows.length) return null
    return state.sel >= 0 && state.sel < rows.length ? rows[state.sel]! : null
  }

  // Setiap perubahan baris memakai aturan menu yang sama: menu terbuka bila
  // baris dimulai "/", dan seleksi dijepit ke jumlah hint yang baru.
  const withLine = (line: string, cursor: number): PromptState => {
    const menuOpen = line.startsWith("/")
    return {
      line,
      cursor: clampCursor(line, cursor),
      sel: menuOpen ? Math.min(Math.max(state.sel, -1), countOf(line) - 1) : -1,
      menuOpen,
    }
  }
  // Melengkapi baris dari dropdown: kursor selalu ke ujung teks hasil.
  const completeTo = (text: string): PromptState => ({
    line: text,
    cursor: pointLength(text),
    sel: -1,
    menuOpen: false,
  })

  switch (key.type) {
    case "char": {
      // Paste bisa memuat newline/tab/kontrol. Dulu "\n" digepeng jadi spasi
      // agar tidak melebihi tinggi terminal, tapi itu membuat copas code
      // multilines cuma baris pertama (keluhan nyata). Sekarang "\n" dipertahankan
      // sebagai baris baru — renderer `buildRenderSpec` sudah memperhitungkan
      // tinggi (`maxVisible`) sehingga tidak
      // menabrak footer. Tab jadi spasi; kontrol lain dibuang.
      const ins = key.ch
        .replace(/\r\n|\r/g, "\n")
        .replace(/\t/g, " ")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: membuang byte kontrol dari paste
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
        // C1 (0x80–0x9F) juga dibuang: U+009B bertindak sebagai CSI di banyak
        // terminal, jadi paste bisa menyuntik escape TANPA byte ESC — melewati
        // filter di atas dan gate sanitize (buffer composer dilukis apa adanya).
        .replace(/[\u0080-\u009f]/g, "")
        // Separator garis/paragraf Unicode = pindah baris di sebagian terminal.
        .replace(/[\u2028\u2029]/g, "\n")
      if (!ins) return { state, action: "none" }
      const { line, cursor } = insertAt(state.line, state.cursor, ins)
      return { state: withLine(line, cursor), action: "render" }
    }
    case "ctrl-j": {
      // Multiline opt-in eksplisit — BERBEDA dari paste yang digepeng jadi
      // spasi: keypress sadar user boleh membawa newline mentah. Render dan
      // history menanganinya per baris visual.
      const ins = insertAt(state.line, state.cursor, "\n")
      return { state: withLine(ins.line, ins.cursor), action: "render" }
    }
    case "backspace": {
      if (state.cursor === 0) return { state, action: "none" }
      const { line, cursor } = deletePrevUnit(state.line, state.cursor)
      return { state: withLine(line, cursor), action: "render" }
    }
    case "delete": {
      const pts = toGraphemes(state.line)
      if (state.cursor >= pts.length) return { state, action: "none" }
      pts.splice(state.cursor, 1)
      return { state: withLine(pts.join(""), state.cursor), action: "render" }
    }
    case "left": {
      if (state.cursor === 0) return { state, action: "none" }
      return { state: { ...state, cursor: state.cursor - 1 }, action: "render" }
    }
    case "right": {
      if (state.cursor >= pointLength(state.line)) return { state, action: "none" }
      return { state: { ...state, cursor: state.cursor + 1 }, action: "render" }
    }
    case "home": {
      if (state.cursor === 0) return { state, action: "none" }
      return { state: { ...state, cursor: 0 }, action: "render" }
    }
    case "end": {
      const max = pointLength(state.line)
      if (state.cursor === max) return { state, action: "none" }
      return { state: { ...state, cursor: max }, action: "render" }
    }
    case "up": {
      if (!state.menuOpen) return { state, action: "none" }
      const n = countOf(state.line)
      if (!n) return { state, action: "none" }
      return {
        state: { ...state, sel: state.sel <= 0 ? n - 1 : (((state.sel - 1) % n) + n) % n },
        action: "render",
      }
    }
    case "down": {
      if (!state.menuOpen) return { state, action: "none" }
      const n = countOf(state.line)
      if (!n) return { state, action: "none" }
      return { state: { ...state, sel: (state.sel + 1) % n }, action: "render" }
    }
    case "tab": {
      if (!state.menuOpen) return { state, action: "none" }
      // Lengkapi item terpilih (atau saran teratas jika sel=-1) tanpa langsung
      // mengeksekusi agar operator masih bisa menambah argumen atau Enter.
      const pick = pickSelected(state.line) ?? hints(state.line)[0]
      if (!pick) return { state, action: "none" }
      return { state: completeTo(pick), action: "render" }
    }
    case "enter": {
      const pick = pickSelected(state.line)
      const finalLine = pick ?? state.line
      return { state: completeTo(finalLine), action: "submit" }
    }
    case "esc": {
      if (!state.menuOpen) return { state, action: "none" }
      return { state: { ...state, sel: -1, menuOpen: false }, action: "render" }
    }
    case "ctrl-c":
    case "ctrl-d":
      return { state, action: "cancel" }
    case "ctrl-o": // toggle compact — ditangani host TUI (app.ts)
    case "ctrl-r": // reverse-i-search — ditangani askLine (input.ts) sebelum applyKey
    case "ctrl-t": // toggle expand/minimize reasoning — ditangani host TUI (app.ts)
    case "ctrl-n": // tambah model — ditangani view yang membutuhkan (model-manager); di prompt teks diabaikan
    case "shift-tab": // toggle permission mode — ditangani host TUI (app.ts)
    case "ignore":
      return { state, action: "none" }
    case "ctrl-u": {
      if (!state.line.length) return { state, action: "none" }
      return { state: createState(), action: "render" }
    }
    // PgUp/PgDn: scroll viewport transkrip — ditangani App TUI SEBELUM
    // applyKey; engine netral (tanpa ini switch tak exhaustive → tsc merah).
    case "pageup":
    case "pagedown":
    case "wheelup":
    case "wheeldown":
    case "mouse":
      return { state, action: "none" }
    case "ctrl-w": {
      if (state.cursor === 0) return { state, action: "none" }
      const at = unitIndex(state.line, state.cursor)
      const before = state.line.slice(0, at)
      const trimmed = before.replace(/\S+\s*$/, "")
      const line = trimmed + state.line.slice(at)
      return { state: withLine(line, pointLength(trimmed)), action: "render" }
    }
  }
}

// Pure render - spec yang digambar renderer.
// `groupOf` opsional: menandai item sebagai command/skill -> header grup dinamis.
export function buildRenderSpec(
  state: PromptState,
  prompt: string,
  hints: string[],
  groupOf?: (text: string) => string,
  maxVisible = MAX_VISIBLE,
): RenderSpec {
  // Dropdown tidak boleh melebihi tinggi terminal sungguhan. MAX_VISIBLE=10
  // konstan membuat overlay 11 baris di terminal 8 baris (dulu membungkus).
  const limit = Math.max(1, maxVisible)
  const inputLine = `${prompt}${state.line}`
  const visible = hints.slice(0, limit)
  const moreCount = Math.max(0, hints.length - limit)
  const rows: RenderSpec["rows"] = []
  let lastGroup: string | undefined
  for (const text of visible) {
    const group = groupOf?.(text)
    if (group !== undefined && group !== lastGroup) {
      lastGroup = group
      rows.push({ kind: "header", text: group.toUpperCase(), picked: false })
    }
    rows.push({ kind: "item", text, picked: text === visible[state.sel] })
  }
  // Kolom kursor diukur dalam KOLOM terminal: sekuens ANSI pada prompt tidak
  // menempati kolom, dan CJK/emoji menempati dua. Menghitung panjang string
  // mentah membuat kursor terminal salah posisi begitu prompt diwarnai.
  const cursorPoints = toGraphemes(state.line)
    .slice(0, clampCursor(state.line, state.cursor))
    .join("")
  return {
    inputLine,
    cursorCol: displayWidth(prompt) + displayWidth(cursorPoints),
    rows,
    moreCount,
    totalRows: rows.length + (moreCount > 0 ? 1 : 0),
  }
}

// ── Binari dari chunk stdin -> keystroke stream ──
// Rust-style manual parsing: ESC [ A/B/C/D = arrows, ESC = esc, dsb.
export function decodeKeys(buf: Uint8Array): DecodedKey[] {
  return decodeKeysStream(buf, createDecoderState()).map((decoded) => ({
    ...decoded,
    width: Math.max(1, decoded.width),
  }))
}

export interface DecodedKey {
  key: PromptKey
  width: number
}

// ── Streaming decoder ──
// `decodeKeys` di atas bekerja pada SATU chunk utuh. Data stdin datang per
// chunk (Bun/Node tidak menjamin batas UTF-8, bracketed paste, atau byte mouse
// jatuh di satu event). Decoder di bawah memakai buffer byte agar emoji yang
// terbelah 2+2, paste `ESC[200~…` yang terbelah, dan `ESC[M`/`ESC[<…M` yang
// terpotong tidak bocor jadi karakter pengganti/teks (dulu: emoji rusak, paste
// jadi teks "200~", mouse jadi "00").
export interface DecoderState {
  /** Byte yang belum lengkap jadi satu key (tail dari chunk sebelumnya). */
  pending: number[]
  /** Overlong sequences retain only their termination rule, never their payload. */
  discard?: "csi" | "sgr"
  /**
   * ESC tunggal yang mengendap di `pending` dari chunk SEBELUMNYA (belum sempat
   * di-flush timer). Tanpa flag eksplisit ini, Alt+Enter yang terbelah
   * ([0x1b] lalu [0x0d]) salah dibaca sebagai esc+enter — guard lama
   * `i >= pendingCount` mengira ESC dari chunk lama bukan pasangan Alt+Enter.
   */
  pendingLoneEsc?: boolean
  /**
   * Payload bracketed paste MELEWATI batas `MAX_PASTE_BYTES` sebelum terminator
   * ESC[201~ tiba. Sisa byte harus tetap dibaca sebagai teks literal: kalau
   * didekode normal, CR di tail jadi Enter (submit) dan 0x03 jadi Ctrl-C
   * (cancel) — audit VERIFIED. Flag ini bertahan lintas chunk sampai terminator.
   */
  pasteOverflow?: boolean
}

export function createDecoderState(): DecoderState {
  return { pending: [], pendingLoneEsc: false, pasteOverflow: false }
}

// Bound incomplete control sequences independently of bracketed paste payloads.
const MAX_CONTROL_SEQUENCE_BYTES = 64
/** Batas aman payload bracketed paste bila terminator ESC[201~ tidak kunjung tiba. */
const MAX_PASTE_BYTES = 512 * 1024

function isCsiParam(b: number): boolean {
  return b >= 0x30 && b <= 0x3f
}

function isCsiFinal(b: number): boolean {
  return b >= 0x40 && b <= 0x7e
}

function utf8CharLen(b: number): number {
  if (b < 0x80) return 1
  if ((b & 0xe0) === 0xc0) return 2
  if ((b & 0xf0) === 0xe0) return 3
  if ((b & 0xf8) === 0xf0) return 4
  return 1
}

function decodeUtf8(bytes: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/**
 * Batas code point Utf-8 terakhir yang UTUH dalam [start, end). Saat payload
 * paste dipaksa keluar karena melewati batas ukuran, memotong di tengah emoji
 * membuat TextDecoder memancarkan U+FFFD. Mundur ke batas aman dan serahkan
 * sisa byte ke chunk berikutnya.
 */
function lastUtf8Boundary(bytes: number[], start: number, end: number): number {
  let i = start
  while (i < end) {
    const n = utf8CharLen(bytes[i]!)
    if (i + n > end) break
    // Awalnya `valid = n === 1` lalu loop `valid && k < n`: untuk code point
    // multibyte valid selalu FALSE sejak awal, loop tak pernah jalan, dan
    // fungsi berhenti di byte LEAD-nya — termasuk ketika sekuensnya LENGKAP.
    // Itu membuat chunk lanjutan paste emoji terdekode jadi U+FFFD. Mulai dari
    // true lalu periksa continuation byte satu per satu (audit L3).
    let valid = true
    for (let k = 1; k < n; k++) {
      if ((bytes[i + k]! & 0xc0) !== 0x80) {
        valid = false
        break
      }
    }
    if (!valid) break
    i += n
  }
  return i
}

/**
 * Apakah [start, end) adalah AWALAN code point Utf-8 yang belum lengkap —
 * BUKAN byte cacat? Dipakai jalur overflow paste: bila chunk berakhir di tengah
 * emoji, byte itu WAJIB ditahan di `pending` untuk disambung chunk berikutnya.
 * Mendekodenya sekarang memancarkan U+FFFD dan menghilangkan karakter asli
 * (emoji 4-byte yang hanya 2 byte pertamanya masuk chunk). Byte invalid tetap
 * dipancarkan U+FFFD + maju satu byte agar loop tidak mandek.
 */
function isIncompleteUtf8Prefix(bytes: number[], start: number, end: number): boolean {
  const b = bytes[start]!
  const n = utf8CharLen(b)
  if (n <= 1) return false // continuation yatim / ASCII: bukan awalan multibyte
  // Lead byte harus sah: 0xC0/0xC1 (overlong) dan 0xF5..0xFF bukan awal valid.
  if (n === 2 && (b < 0xc2 || b > 0xdf)) return false
  if (n === 3 && (b < 0xe0 || b > 0xef)) return false
  if (n === 4 && (b < 0xf0 || b > 0xf4)) return false
  const avail = end - (start + 1)
  if (avail >= n - 1) return false // sekuens sudah lengkap, bukan awalan
  for (let k = 1; k <= avail; k++) {
    const c = bytes[start + k]!
    if ((c & 0xc0) !== 0x80) return false
    // Batas byte kedua menjaga overlong/surrogate: walau chunk berikutnya
    // melengkapi continuation-nya, awalan ini tak akan jadi code point valid.
    if (k === 1) {
      if (b === 0xe0 && c < 0xa0) return false
      if (b === 0xed && c >= 0xa0) return false
      if (b === 0xf0 && c < 0x90) return false
      if (b === 0xf4 && c >= 0x90) return false
    }
  }
  return true
}

/** Cari byte dalam rentang [from, to) — jangan menjangkau event berikutnya. */
function indexOfByte(bytes: number[], needle: number, from: number, to: number): number {
  for (let k = from; k < to; k++) if (bytes[k] === needle) return k
  return -1
}

/** Cari char dalam rentang [from, to) (varian string untuk `decodeKey`). */
function indexOfChar(s: string, needle: string, from: number, to: number): number {
  const at = s.indexOf(needle, from)
  return at >= 0 && at < to ? at : -1
}

/** Byte terminator ESC[201~ (dipakai untuk deteksi penuh maupun paruh). */
const PASTE_END_BYTES = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]

/** Indeks awal terminator ESC[201~ di `buf` mulai `from`, atau -1 bila belum tiba. */
function findPasteEnd(buf: number[], from: number): number {
  for (let j = from; j + 5 < buf.length; j++) {
    let match = true
    for (let k = 0; k < PASTE_END_BYTES.length; k++) {
      if (buf[j + k] !== PASTE_END_BYTES[k]) {
        match = false
        break
      }
    }
    if (match) return j
  }
  return -1
}

/**
 * Indeks awal AWALAN terminator ESC[201~ yang menggantung di ekor `buf`.
 * Potongan seperti `ESC[` harus ditahan di pending, bukan dibuang sebagai
 * teks literal — kalau tidak, terminator yang terbelah jadi karakter nyasar.
 */
function trailingPasteEndPrefix(buf: number[]): number {
  const max = Math.min(PASTE_END_BYTES.length - 1, buf.length)
  for (let k = max; k >= 1; k--) {
    let match = true
    for (let t = 0; t < k; t++) {
      if (buf[buf.length - k + t] !== PASTE_END_BYTES[t]) {
        match = false
        break
      }
    }
    if (match) return buf.length - k
  }
  return buf.length
}

/** Pemetaan byte ASCII/control → key; null bila printable biasa. */
function asciiKey(b: number): DecodedKey | null {
  switch (b) {
    case 0x01:
      return { key: { type: "home" }, width: 0 }
    case 0x05:
      return { key: { type: "end" }, width: 0 }
    case 0x0f:
      return { key: { type: "ctrl-o" }, width: 0 }
    case 0x12:
      return { key: { type: "ctrl-r" }, width: 0 }
    case 0x14:
      return { key: { type: "ctrl-t" }, width: 0 }
    case 0x0e:
      return { key: { type: "ctrl-n" }, width: 0 }
    case 0x7f:
    case 0x08:
      return { key: { type: "backspace" }, width: 0 }
    // LF (Ctrl+J) BUKAN submit: ia menyisipkan newline (multiline opt-in).
    // Hanya CR (tombol Enter) yang submit. Paste bracketed tak tersentuh
    // (segelintir chunk → char) sehingga perilaku paste lama tidak berubah.
    case 0x0a:
      return { key: { type: "ctrl-j" }, width: 0 }
    case 0x0d:
      return { key: { type: "enter" }, width: 0 }
    case 0x09:
      return { key: { type: "tab" }, width: 0 }
    case 0x03:
      return { key: { type: "ctrl-c" }, width: 0 }
    case 0x04:
      return { key: { type: "ctrl-d" }, width: 0 }
    case 0x15:
      return { key: { type: "ctrl-u" }, width: 0 }
    case 0x17:
      return { key: { type: "ctrl-w" }, width: 0 }
    default:
      if (b < 0x20) return { key: { type: "ignore" }, width: 0 }
      return null
  }
}

/**
 * Dekode chunk stdin streaming: konsumsi key yang LENGKAP, sisanya disimpan
 * di `state.pending` untuk chunk berikutnya. Key dikembalikan berurutan.
 */
export function decodeKeysStream(chunk: Uint8Array, state: DecoderState): DecodedKey[] {
  const pendingCount = state.pending.length
  // Rekonstruksi flag lintas-chunk dari pending yang memang bertahan antar
  // pemanggilan. ESC tunggal dari chunk sebelumnya + CR di chunk ini = Alt+Enter.
  const loneEscPending = pendingCount === 1 && state.pending[0] === 0x1b
  state.pendingLoneEsc = loneEscPending
  const buf = state.pending.concat([...chunk])
  const out: DecodedKey[] = []
  let i = 0
  while (i < buf.length) {
    const b = buf[i]!
    if (state.pasteOverflow) {
      // Mode overflow paste: semua byte sebelum ESC[201~ = char LITERAL.
      // Jangan biarkan CR/0x03/C1 didekode jadi enter/cancel/escape (audit).
      const term = findPasteEnd(buf, i)
      if (term === -1) {
        // Tahan awalan terminator yang terpotong di ujung chunk.
        const hold = trailingPasteEndPrefix(buf)
        if (hold === i) break
        const end = lastUtf8Boundary(buf, i, hold)
        if (end > i) {
          out.push({ key: { type: "char", ch: decodeUtf8(buf.slice(i, end)) }, width: 0 })
          i = end
        } else if (isIncompleteUtf8Prefix(buf, i, hold)) {
          // Chunk berakhir di tengah code point: tahan ekornya di `pending`.
          // Kalau dipancarkan U+FFFD di sini, emoji yang terbelah batas
          // MAX_PASTE_BYTES hilang permanen (regresi audit L3).
          break
        } else {
          // Byte tak valid di awal: pancarkan U+FFFD satu byt dan maju supaya
          // loop tak mandek; sisa disambung chunk berikutnya.
          out.push({ key: { type: "char", ch: "\ufffd" }, width: 0 })
          i++
        }
        continue
      }
      const end = lastUtf8Boundary(buf, i, term)
      if (end > i) {
        out.push({ key: { type: "char", ch: decodeUtf8(buf.slice(i, end)) }, width: 0 })
        i = end
        continue
      }
      if (i < term && isIncompleteUtf8Prefix(buf, i, term)) {
        // Code point terbelah tepat sebelum terminator: jangan dibuang bersama
        // terminator — tahan dulu, lengkapi dengan chunk berikutnya.
        break
      }
      // end === i → tepat di terminator: konsumsi dan keluar dari mode overflow.
      i = term + 6
      state.pasteOverflow = false
      continue
    }
    if (state.discard) {
      if (b < 0x20 || b >= 0x7f) {
        // Recover at an independent byte without consuming it (including ESC).
        state.discard = undefined
      } else {
        const final = state.discard === "sgr" ? b === 0x4d || b === 0x6d : isCsiFinal(b)
        if (final) state.discard = undefined
        i++
        continue
      }
    }
    if (b === 0x1b) {
      const n1 = buf[i + 1]
      // ESC di ujung chunk = awal sekuens yang terbelah (panah ESC[A jadi
      // [0x1b]+[0x5b,0x41]) ATAU Esc tunggal. Tak bisa dibedakan sinkron —
      // TAHAN di pending; pemanggil (input.ts) flush sebagai esc bila tak ada
      // byte lanjutan dalam ~50ms (pola lone-ESC yang sama saat busy).
      // Emisi langsung di sini mengubah panah split jadi esc+"[A" (batal prompt
      // + teks nyasar).
      if (n1 === undefined) break
      // Bracketed paste start: ESC[200~ … ESC[201~ — tahan sampai penutup.
      if (
        n1 === 0x5b &&
        buf[i + 2] === 0x32 &&
        buf[i + 3] === 0x30 &&
        buf[i + 4] === 0x30 &&
        buf[i + 5] === 0x7e
      ) {
        const term = findPasteEnd(buf, i + 6)
        if (term === -1) {
          // Batas defensif bila terminal crash sebelum mengirim penutup ESC[201~:
          // jangan tahan buffer tanpa batas sampai membekukan seluruh input.
          if (buf.length - (i + 6) > MAX_PASTE_BYTES) {
            // Jangan decode sampai ujung chunk: byte terakhir bisa berada di
            // tengah code point multibyte. Mundur ke batas Utf-8 terakhir;
            // sisanya tetap di pending dan disambung chunk berikutnya.
            const start = i + 6
            const end = lastUtf8Boundary(buf, start, buf.length)
            if (end > start) {
              out.push({ key: { type: "char", ch: decodeUtf8(buf.slice(start, end)) }, width: 0 })
            }
            // Tandai mode overflow supaya sisa payload (termasuk CR/Ctrl-C)
            // tetap dibaca literal sampai terminator tiba (audit VERIFIED).
            state.pasteOverflow = true
            i = end
            continue
          }
          break // penutup belum tiba — tahan
        }
        out.push({ key: { type: "char", ch: decodeUtf8(buf.slice(i + 6, term)) }, width: 0 })
        i = term + 6
        continue
      }
      // Mouse X10: ESC[M + 3 byte koordinat MENTAH (bukan UTF-8).
      if (n1 === 0x5b && buf[i + 2] === 0x4d) {
        if (i + 6 > buf.length) break
        const button = buf[i + 3]! - 0x20
        const x = buf[i + 4]! - 31
        const y = buf[i + 5]! - 31
        out.push({
          key: mouseKeyForReport(button, mouseActionForButton(button), x, y),
          width: 6,
        })
        i += 6
        continue
      }
      if (n1 === 0x5b && buf[i + 2] === 0x3c) {
        let j = i + 3
        while (
          j < buf.length &&
          j - i < MAX_CONTROL_SEQUENCE_BYTES &&
          buf[j]! >= 0x20 &&
          buf[j]! < 0x7f &&
          buf[j] !== 0x4d &&
          buf[j] !== 0x6d
        ) {
          j++
        }
        if (
          j - i >= MAX_CONTROL_SEQUENCE_BYTES ||
          (j < buf.length && (buf[j]! < 0x20 || buf[j]! >= 0x7f))
        ) {
          if (j - i >= MAX_CONTROL_SEQUENCE_BYTES) state.discard = "sgr"
          out.push({ key: { type: "ignore" }, width: j - i })
          i = j
          continue
        }
        if (j >= buf.length) break
        // Batasi pencarian ke [i+3, j): semicolon di EVENT SGR berikutnya
        // tak boleh merusak parsing event ini (audit VERIFIED).
        const first = indexOfByte(buf, 0x3b, i + 3, j)
        const second = first >= 0 ? indexOfByte(buf, 0x3b, first + 1, j) : -1
        const valid =
          first > i + 3 && second > first + 1 && !buf.slice(second + 1, j).includes(0x3b)
        const button = valid ? parseDecimalBytes(buf, i + 3, first) : null
        const x = valid ? parseDecimalBytes(buf, first + 1, second) : null
        const y = valid ? parseDecimalBytes(buf, second + 1, j) : null
        const key =
          button === null || x === null || y === null
            ? ({ type: "ignore" } as const)
            : mouseKeyForReport(button, mouseActionForButton(button, buf[j] === 0x6d), x, y)
        out.push({ key, width: j - i + 1 })
        i = j + 1
        continue
      }
      // CSI (ESC[) / SS3 (ESC O): sekuens ASCII sampai byte final.
      if (n1 === 0x5b || n1 === 0x4f) {
        let j = i + 2
        while (
          j < buf.length &&
          j - i < MAX_CONTROL_SEQUENCE_BYTES &&
          !isCsiFinal(buf[j]!) &&
          (isCsiParam(buf[j]!) || (buf[j]! >= 0x20 && buf[j]! <= 0x2f))
        ) {
          j++
        }
        if (j - i >= MAX_CONTROL_SEQUENCE_BYTES) {
          state.discard = "csi"
          out.push({ key: { type: "ignore" }, width: j - i })
          i = j
          continue
        }
        if (j < buf.length && isCsiFinal(buf[j]!)) {
          const seq = String.fromCharCode(...buf.slice(i, j + 1))
          const d = decodeKey(seq, 0)
          out.push(d ?? { key: { type: "ignore" }, width: 0 })
          i = j + 1
          continue
        }
        if (j === buf.length) break // Valid incomplete prefix: wait for the next chunk.
        // Drop only the malformed prefix; decode the independent byte next
        // (especially Ctrl+C, Enter, or ESC starting a fresh sequence).
        out.push({ key: { type: "ignore" }, width: j - i })
        i = j
        continue
      }
      // Alt+Enter: ESC + CR (`\x1b\r`) → sisip newline, bukan batal/Esc.
      // `loneEscPending` menangkap ESC yang tertahan di ujung chunk SEBELUMNYA:
      // guard lama `i >= pendingCount` menolak kasus itu dan menghasilkan
      // esc+enter (abort + submit) saat Alt+Enter terbelah antar chunk.
      if (n1 === 0x0d && (i >= pendingCount || loneEscPending)) {
        out.push({ key: { type: "ctrl-j" }, width: 2 })
        i += 2
        continue
      }
      // Alt+<printable> (termasuk byte awal Utf-8) BUKAN Esc. Kode lama
      // memancarkan `esc` untuk setiap ESC+byte non-CSI, jadi Alt+b mengabort
      // turn yang sedang berjalan. Buang ESC-nya saja; byte berikutnya tetap
      // didekode normal. Lone-ESC (flush timer) dan ESC+CR di atas tak tersentuh.
      if (n1 >= 0x20) {
        out.push({ key: { type: "ignore" }, width: 1 })
        i += 1
        continue
      }
      // ESC + byte kontrol tak dikenal: pertahankan perilaku esc lama.
      out.push({ key: { type: "esc" }, width: 0 })
      i += 1
      continue
    }
    if (b < 0x80) {
      const d = asciiKey(b)
      out.push(d ?? { key: { type: "char", ch: String.fromCharCode(b) }, width: 0 })
      i += 1
      continue
    }
    // Multi-byte UTF-8 — pastikan seluruh sekuens sudah tiba.
    const n = utf8CharLen(b)
    if (i + n > buf.length) break
    const bytes = buf.slice(i, i + n)
    const contOk = bytes.slice(1).every((x) => (x & 0xc0) === 0x80)
    if (!contOk) {
      out.push({ key: { type: "char", ch: "\ufffd" }, width: 0 })
      i += 1
      continue
    }
    out.push({ key: { type: "char", ch: decodeUtf8(bytes) }, width: 0 })
    i += n
  }
  state.pending = buf.slice(i)
  return out
}

/**
 * Pending berupa Esc tunggal yang tertahan di ujung chunk ([0x1b])?
 * Hanya kasus ini yang di-flush via timer ~50ms oleh pemanggil: sekuens lain
 * yang tertahan (UTF-8/paste/mouse/CSI berparameter) menunggu chunk berikut
 * dan tak boleh dipaksa jadi esc.
 */
export function hasPendingLoneEsc(state: DecoderState): boolean {
  return state.pending.length === 1 && state.pending[0] === 0x1b
}

/**
 * Paksa pending Esc tunggal menjadi key esc (dipanggil timer pemanggil bila
 * tak ada byte lanjutan). No-op bila pending bukan Esc tunggal.
 */
export function flushLoneEsc(state: DecoderState): DecodedKey[] {
  if (!hasPendingLoneEsc(state)) return []
  state.pending = []
  state.pendingLoneEsc = false
  return [{ key: { type: "esc" }, width: 0 }]
}

// ── Pompa key stream + flush lone-ESC ──
//
// Decoder menahan ESC di ujung chunk (tak bisa bedakan Esc tunggal vs paruh
// panah split secara sinkron). Pompa ini membungkus pola yang dipakai SEMUA
// konsumen interaktif (askLine/askSecret/picker/manager): decode chunk →
// teruskan key sinkron → bila pending Esc tunggal, tunggu ~50ms (pola
// lone-ESC yang sama saat busy di TUI, `src/ui/tui/app.ts`); byte lanjutan membatalkan
// timer dan melengkapi sekuens, sunyi berarti Esc asli → flush sebagai esc.
//
// Tanpa pompa tiap konsumen harus menulis timer sendiri (duplikasi 5× dan
// drift); tanpa timer panah split jadi esc+"[A" (batal prompt + teks nyasar).
// Timer di-unref agar tak menahan exit proses/test.
export interface KeyStreamPump {
  /** Decode chunk + kirim key sinkron; arm flush bila Esc tertahan. */
  push(chunk: Uint8Array): void
  /** Matikan timer (panggil di cleanup agar flush tak jalan setelah selesai). */
  dispose(): void
}

export function createKeyStreamPump(opts: {
  state: DecoderState
  /** Dipanggil untuk key sinkron maupun hasil flush; return true = selesai. */
  onKeys: (keys: DecodedKey[]) => boolean
  escMs?: number
}): KeyStreamPump {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return {
    push(chunk: Uint8Array): void {
      clear()
      const done = opts.onKeys(decodeKeysStream(chunk, opts.state))
      if (done) return
      if (hasPendingLoneEsc(opts.state)) {
        timer = setTimeout(() => {
          timer = undefined
          const flushed = flushLoneEsc(opts.state)
          if (flushed.length) opts.onKeys(flushed)
        }, opts.escMs ?? 50)
        try {
          ;(timer as unknown as { unref?: () => void }).unref?.()
        } catch {}
      }
    },
    dispose(): void {
      clear()
    },
  }
}

type MouseAction = Extract<PromptKey, { type: "mouse" }>["action"]

function mouseActionForButton(button: number, release = false): MouseAction {
  if (release) return "release"
  if ((button & 0x20) !== 0) return (button & 0x03) <= 2 ? "drag" : "move"
  return (button & 0x03) <= 2 ? "press" : "move"
}

function mouseKeyForReport(button: number, action: MouseAction, x: number, y: number): PromptKey {
  if (
    !Number.isSafeInteger(button) ||
    button < 0 ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 1 ||
    y < 1
  ) {
    return { type: "ignore" }
  }
  const modifiers = button & 0x1c
  if ((button & 0xc0) === 0x40) {
    const vertical = button & 0x1f
    // v0.33: koordinat DISERTAIkan supaya App bisa menggulir pane yang sedang
    // disorot mouse (chat / thinking / aktivitas), bukan selalu chat.
    if (vertical === 0) return { type: "wheelup", x, y }
    if (vertical === 1) return { type: "wheeldown", x, y }
    return { type: "ignore" }
  }
  const rawButton = button & 0x03
  const normalizedButton = rawButton <= 2 ? (rawButton as 0 | 1 | 2) : null
  if (action === "release") {
    return { type: "mouse", action, button: normalizedButton, x, y, modifiers }
  }
  if (action === "drag" || action === "move") {
    return { type: "mouse", action, button: normalizedButton, x, y, modifiers }
  }
  if (normalizedButton === null) return { type: "ignore" }
  return { type: "mouse", action: "press", button: normalizedButton, x, y, modifiers }
}

function parseDecimalBytes(bytes: number[], from: number, to: number): number | null {
  if (from >= to) return null
  let value = 0
  for (let i = from; i < to; i++) {
    const digit = bytes[i]! - 0x30
    if (digit < 0 || digit > 9) return null
    value = value * 10 + digit
    if (!Number.isSafeInteger(value)) return null
  }
  return value
}

export function decodeKey(s: string, i: number): DecodedKey | null {
  const c = s[i]!
  const code = c.charCodeAt(0)
  if (code === 0x1b) {
    // Bracketed paste: ESC[200~ … ESC[201~ — emit satu char "paste" per segmen
    if (
      s[i + 1] === "[" &&
      s[i + 2] === "2" &&
      s[i + 3] === "0" &&
      s[i + 4] === "0" &&
      s[i + 5] === "~"
    ) {
      const endIdx = s.indexOf("\x1b[201~", i + 6)
      if (endIdx !== -1) {
        return { key: { type: "char", ch: s.slice(i + 6, endIdx) }, width: endIdx + 6 - i }
      }
    }
    if (s[i + 1] === "[" && s[i + 2] === "M") {
      const button = s.charCodeAt(i + 3) - 0x20
      const x = s.charCodeAt(i + 4) - 31
      const y = s.charCodeAt(i + 5) - 31
      return {
        key: mouseKeyForReport(button, mouseActionForButton(button), x, y),
        width: 6,
      }
    }
    if (s[i + 1] === "[" && s[i + 2] === "<") {
      let j = i + 3
      while (j < s.length && s[j] !== "M" && s[j] !== "m") j++
      // Sama seperti jalur stream: hanya scan sampai `j` agar event SGR
      // berikutnya tak menyisipkan semicolon ke event ini.
      const first = indexOfChar(s, ";", i + 3, j)
      const second = first >= 0 ? indexOfChar(s, ";", first + 1, j) : -1
      const valid = first > i + 3 && second > first + 1 && !s.slice(second + 1, j).includes(";")
      const button = valid ? Number.parseInt(s.slice(i + 3, first), 10) : Number.NaN
      const x = valid ? Number.parseInt(s.slice(first + 1, second), 10) : Number.NaN
      const y = valid ? Number.parseInt(s.slice(second + 1, j), 10) : Number.NaN
      const release = s[j] === "m"
      return {
        key: mouseKeyForReport(button, mouseActionForButton(button, release), x, y),
        width: j - i + 1,
      }
    }
    if (s[i + 1] === "[" || s[i + 1] === "O") {
      const kind = s[i + 2]
      if (kind === "A") return { key: { type: "up" }, width: 3 }
      if (kind === "B") return { key: { type: "down" }, width: 3 }
      if (kind === "C") return { key: { type: "right" }, width: 3 }
      if (kind === "D") return { key: { type: "left" }, width: 3 }
      if (kind === "H") return { key: { type: "home" }, width: 3 }
      if (kind === "F") return { key: { type: "end" }, width: 3 }
      // Varian VT: ESC[1~ Home, ESC[4~ End, ESC[3~ Delete, ESC[7~/[8~ Home/End
      if (kind === "1" && s[i + 3] === "~") return { key: { type: "home" }, width: 4 }
      if (kind === "7" && s[i + 3] === "~") return { key: { type: "home" }, width: 4 }
      if (kind === "4" && s[i + 3] === "~") return { key: { type: "end" }, width: 4 }
      if (kind === "8" && s[i + 3] === "~") return { key: { type: "end" }, width: 4 }
      if (kind === "3" && s[i + 3] === "~") return { key: { type: "delete" }, width: 4 }
      // PgUp/PgDn — App TUI memakainya untuk scroll transkrip (I18).
      // Dua varian sah: polos ESC[5~ (4 byte) dan bermodifier ESC[5;<m>~
      // (modifier bisa multi-digit: 2=shift, 5=ctrl, 3=alt, kombinasi >9
      // seperti 23). HANYA terminator '~' yang dianggap PgUp/PgDn — response
      // DSR kursor (ESC[5;34R) dsb. harus jatuh ke catch-all ignore di bawah;
      // tanpa guard ini, response DSR baris-5/6 dibajak jadi pageup + residu
      // char bocor ke prompt (bug ditemukan audit typing, probe ESC[5;34R).
      // Width dihitung dari posisi terminator — width tetap 5 membuat sisa
      // '~' ter-decode jadi keystroke char (prompt tiba-tiba berisi '~').
      if (kind === "5" || kind === "6") {
        const type = kind === "5" ? "pageup" : "pagedown"
        if (s[i + 3] === "~") return { key: { type, modifier: 0 }, width: 4 }
        if (s[i + 3] === ";") {
          let j = i + 4
          let ch: string | undefined = s[j]
          while (ch !== undefined && ch >= "0" && ch <= "9") {
            j++
            ch = s[j]
          }
          if (ch === "~") {
            const mod = Number.parseInt(s.slice(i + 4, j), 10) || 0
            return { key: { type, modifier: mod }, width: j + 1 - i }
          }
        }
        // selain itu (ESC[5;34R, ESC[5x, …) → catch-all ignore di bawah
      }
      // Shift+Tab (backtab) ESC [ Z — dipakai TUI untuk toggle permission mode.
      // Tanpa cabang eksplisit ini ia jatuh ke catch-all "esc" di bawah,
      // sehingga tipe "shift-tab" tidak pernah dihasilkan decodeKeys.
      if (kind === "Z") return { key: { type: "shift-tab" }, width: 3 }
      // Shift+Enter / Alt+Enter modern: CSI-u (`\x1b[13;2u` / `\x1b[13;3u`) atau
      // modifyOtherKeys (`\x1b[27;2;13~` / `\x1b[27;3;13~`) → sisip newline.
      const csiWidth = scanCsi(s, i)
      if (/^(?:13;[23]u|27;[23];13~)$/.test(s.slice(i + 2, i + csiWidth))) {
        return { key: { type: "ctrl-j" }, width: csiWidth }
      }
      // ESC [ … lainnya -> konsumsi saja
      return { key: { type: "ignore" }, width: csiWidth }
    }
    if (s[i + 1] === "\r") return { key: { type: "ctrl-j" }, width: 2 }
    return { key: { type: "esc" }, width: 1 }
  }
  if (code === 0x01) return { key: { type: "home" }, width: 1 } // Ctrl+A
  if (code === 0x05) return { key: { type: "end" }, width: 1 } // Ctrl+E
  // Ctrl+O (15) & Ctrl+R (18) sebagai key types sendiri
  if (code === 0x0f) return { key: { type: "ctrl-o" }, width: 1 }
  if (code === 0x12) return { key: { type: "ctrl-r" }, width: 1 }
  if (code === 0x14) return { key: { type: "ctrl-t" }, width: 1 }
  if (code === 0x0e) return { key: { type: "ctrl-n" }, width: 1 } // Ctrl+N
  if (code === 0x7f || code === 0x08) return { key: { type: "backspace" }, width: 1 }
  // Sinkron dengan asciiKey di atas: LF = newline, CR = submit.
  if (c === "\n") return { key: { type: "ctrl-j" }, width: 1 }
  if (c === "\r") return { key: { type: "enter" }, width: 1 }
  if (c === "\t") return { key: { type: "tab" }, width: 1 }
  if (code === 0x03) return { key: { type: "ctrl-c" }, width: 1 }
  if (code === 0x04) return { key: { type: "ctrl-d" }, width: 1 }
  if (code === 0x15) return { key: { type: "ctrl-u" }, width: 1 }
  if (code === 0x17) return { key: { type: "ctrl-w" }, width: 1 }
  // Kontrol C0 lain yang tidak punya arti di sini (Ctrl+L, Ctrl+K, Ctrl+Z,
  // dst.) DIBUANG, bukan diteruskan sebagai karakter.
  //
  // Sebelumnya semuanya jatuh ke cabang "char" di bawah dan masuk ke baris
  // input sebagai byte tak tampak — Ctrl+L+Ctrl+K+Ctrl+T pada "teks"
  // mengirimkan "teks\f\u000b\u0014" ke model. Tidak terlihat di layar, tapi
  // ikut terkirim dan bisa membingungkan model atau merusak render.
  if (code < 0x20 || code === 0x7f) return { key: { type: "ignore" }, width: 1 }
  // Multi-byte: s sudah decoded UTF-16 - ukur unit per code point.
  const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1
  const ch = s.slice(i, i + width)
  return { key: { type: "char", ch }, width }
}

function scanCsi(s: string, i: number): number {
  // CSI finals include punctuation such as '~', not only letters.
  let j = i + 2
  while (j < s.length && !isCsiFinal(s.charCodeAt(j))) j++
  return Math.min(j + 1, s.length) - i
}
