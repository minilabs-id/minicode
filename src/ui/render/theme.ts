import { sanitizeAnsiLine } from "./sanitize.ts"
import { displayWidth, truncateToWidth } from "./width.ts"

// Semantic color system - Ubuntu Server style.
// Warna by function, bukan appearance. Satu palet (dark); NO_COLOR > truecolor
// > 256 > 16 > mono tetap auto-detect. Fitur tema (--theme, /theme, preset)
// dihapus: tampilan tunggal, tidak ada state tema mutable.

const isWindows = process.platform === "win32"

/**
 * Apakah terminal menampilkan karakter Unicode non-ASCII dengan benar?
 *
 * Dievaluasi LAZY (bukan saat import) supaya perubahan env di runtime dan di
 * test tetap berpengaruh — sama alasannya dengan deteksi warna di bawah.
 * Sebelumnya dibekukan saat import, jadi `glyphs` selalu memakai nilai yang
 * ditentukan oleh env pada saat modul pertama dimuat.
 */
export function supportsUtf8(): boolean {
  if (process.env.MINICODE_ASCII === "1") return false
  if (!isWindows) return true
  const term = (process.env.TERM ?? "").toLowerCase()
  const locale = `${process.env.LC_ALL ?? ""} ${process.env.LANG ?? ""}`
  return (
    process.env.WT_SESSION != null ||
    process.env.TERM_PROGRAM != null ||
    process.env.ConEmuANSI === "ON" ||
    process.env.ANSICON != null ||
    process.env.MSYSTEM != null ||
    /(?:xterm|screen|tmux|kitty|alacritty|wezterm|vt\d)/i.test(term) ||
    /utf-?8/i.test(locale)
  )
}

// ── Color support detection ──
// Dievaluasi LAZY (bukan saat import) supaya perubahan NO_COLOR/COLORTERM di
// runtime dan pengujian tetap berpengaruh; hasilnya murah karena hanya baca env.
function noColorEnv(): boolean {
  // NO_COLOR="0" SENGAJA dianggap "warna nyala" (kill-switch terbalik) — berbeda
  // dari no-color.org yang menyatakan kehadiran apa pun = mati. Keputusan product:
  // "0" adalah nilai eksplisit "jangan matikan" yang dipakai sebagian tooling;
  // nilai lain (termasuk kosong) mematikan warna. Didokumentasikan juga di
  // docs/environment.md. Jangan "perbaiki" jadi === null tanpa keputusan owner.
  return process.env.NO_COLOR != null && process.env.NO_COLOR !== "0"
}
function hasTruecolorEnv(): boolean {
  return process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit"
}
/** 0=mono, 1=16-color, 2=256-color, 3=truecolor */
function colorLevel(): number {
  if (noColorEnv()) return 0
  // Determinisme Unix: output ke pipe/redirect/file tidak boleh memuat ANSI,
  // apa pun TERM/COLORTERM di env (env sesi interaktif sering bocor ke proses
  // yang di-pipe). Warna hanya untuk stdout yang benar-benar terminal.
  if (!process.stdout.isTTY || process.env.TERM?.toLowerCase() === "dumb") return 0
  if (hasTruecolorEnv()) return 3
  if (process.env.TERM?.includes("256color")) return 2
  // Terminal/ConPTY sering tak mengisi TERM; env eksplisit di atas tetap menang.
  try {
    const depth = (
      process.stdout as NodeJS.WriteStream & { getColorDepth?: () => number }
    ).getColorDepth?.()
    if (depth != null && depth >= 24) return 3
    if (depth != null && depth >= 8) return 2
  } catch {}
  return 1
}

export type ScrimMode = "bg" | "faint" | "none"

/** Mode scrim (lazy); tak menambah byte di pipe. */
export function scrimMode(): ScrimMode {
  if (noColorEnv() || !process.stdout.isTTY || process.env.TERM?.toLowerCase() === "dumb")
    return "none"
  if (process.env.MINICODE_SCRIM === "none") return "faint"
  return colorLevel() >= 2 ? "bg" : colorLevel() === 1 ? "faint" : "none"
}

/** SGR pembuka scrim; pemanggil menjaga efek tetap hidup melewati reset konten. */
export function scrimSgr(mode: ScrimMode): string {
  if (mode === "bg") return "\x1b[2;48;5;236m"
  if (mode === "faint") return "\x1b[2m"
  return ""
}

/**
 * Kunci kapabilitas tampilan (level warna + glyph UTF-8) untuk cache render.
 *
 * Dievaluasi LAZY tiap panggilan: NO_COLOR/TERM/COLORTERM dan deteksi UTF-8
 * bisa berubah di runtime (dan antar test). Konsumen yang meng-cache string
 * berwarna WAJIB menyertakan kunci ini; tanpa itu output mono bisa tersaji ke
 * terminal berwarna (atau sebaliknya) setelah env berubah.
 */
export function themeCapabilityKey(): string {
  return `${colorLevel()}:${hasTruecolorEnv() ? 1 : 0}:${supportsUtf8() ? 1 : 0}`
}

type Paint = (s: string) => string
const identity: Paint = (s) => s

function wrap(open: number | string, close: number | string): Paint {
  if (colorLevel() === 0) return identity
  const o = `\x1b[${open}m`
  const cl =
    typeof close === "number"
      ? `\x1b[${close}m`
      : String(close).startsWith("\x1b[")
        ? String(close)
        : `\x1b[${close}m`
  return (s: string) => `${o}${s}${cl}`
}

/** Warna token sesuai level terminal: 16 / 256 / truecolor. */
function paintToken(token: ColorToken): Paint {
  const level = colorLevel()
  if (level === 0) return identity
  const code = level === 1 ? token.c16 : level === 2 ? token.c256 : token.rgb
  return (s: string) => `\x1b[${code}m${s}\x1b[39m`
}

/** Token + bold (untuk accent judul/terpilih). */
function paintTokenBold(token: ColorToken): Paint {
  const level = colorLevel()
  if (level === 0) return identity
  const code = level === 1 ? token.c16 : level === 2 ? token.c256 : token.rgb
  return (s: string) => `\x1b[1;${code}m${s}\x1b[39m`
}

// ── Token palet tunggal (VS Code Dark+ inspired) ──
//
// Tiap token punya representasi 16-warna, 256-warna, dan truecolor. Sebelumnya
// semua token semantik selalu memancarkan `38;2;...` walau terminal hanya
// mengaku 16 warna — level deteksi jadi tidak bermakna dan warna status bisa
// hilang/diabaikan. `paintToken` memilih representasi sesuai `colorLevel()`.
interface ColorToken {
  /** SGR 16-warna (mis. "32"). */
  c16: string
  /** SGR 256-warna (mis. "38;5;114"). */
  c256: string
  /** SGR truecolor (mis. "38;2;137;209;133"). */
  rgb: string
}

const TOKENS = {
  success: { c16: "32", c256: "38;5;114", rgb: "38;2;137;209;133" },
  error: { c16: "31", c256: "38;5;210", rgb: "38;2;244;135;113" },
  warning: { c16: "33", c256: "38;5;178", rgb: "38;2;204;167;0" },
  info: { c16: "36", c256: "38;5;75", rgb: "38;2;117;190;255" },
  accent: { c16: "94", c256: "38;5;69", rgb: "38;2;74;144;226" },
  // String literal kode (VS Code Dark+ `string` #CE9178) — sengaja terpisah dari
  // `success` (green): string harus tampak jingga-salm ala VS Code, sementara
  // status sukses tetap hijau. Alias lama `green` tetap menyasar success.
  string: { c16: "33", c256: "38;5;173", rgb: "38;2;206;145;120" },
  // Thinking/reasoning: abu-kebiruan yang tetap terbaca nyaman (bukan `dim` yang
  // meredupkan seluruh teks) — jelas sekunder dari jawaban model tapi tak silau.
  thinking: { c16: "90", c256: "38;5;246", rgb: "38;2;135;146;160" },
  // Faint: abu gelap untuk garis footer — lebih redup dari `gray` (bright-black)
  // dan dari `muted` (dim). Dipakai elemen yang harus ada tapi hampir tak
  // terlihat, seperti separator baris dasar.
  faint: { c16: "90", c256: "38;5;238", rgb: "38;2;72;72;72" },
} satisfies Record<string, ColorToken>

const GRAY_TOKEN: ColorToken = { c16: "90", c256: "38;5;245", rgb: "90" }
const ACCENT_ALT_TOKEN: ColorToken = { c16: "95", c256: "38;5;141", rgb: TOKENS.info.rgb }
const MAGENTA_TOKEN: ColorToken = { c16: "35", c256: "38;5;141", rgb: "35" }
const WHITE_TOKEN: ColorToken = { c16: "37", c256: "37", rgb: "37" }
const BRIGHT_YELLOW_TOKEN: ColorToken = {
  c16: "93",
  c256: "38;5;179",
  rgb: "38;2;215;186;125",
}
const BRIGHT_MAGENTA_TOKEN: ColorToken = {
  c16: "95",
  c256: "38;5;176",
  rgb: "38;2;197;134;192",
}
const BRIGHT_CYAN_TOKEN: ColorToken = {
  c16: "96",
  c256: "38;5;80",
  rgb: "38;2;78;201;176",
}

// ── Slot warna ──
//
// PENTING: slot ini WAJIB dievaluasi saat dipanggil, bukan saat modul di-import.
// Versi sebelumnya menulis `success: trueWrap(tk("success"))` di module scope,
// sehingga token warna dibekukan pada import pertama — termasuk warna `mono`
// yang seharusnya menjadi jalur aksesibilitas. Slot kini getter dengan hasil
// di-cache per level warna supaya jalur render panas tidak mengalokasi closure
// tiap panggilan.
interface Palette {
  success: Paint
  error: Paint
  warning: Paint
  info: Paint
  accent: Paint
  accentAlt: Paint
  accentBold: Paint
  gray: Paint
  faint: Paint
  red: Paint
  green: Paint
  yellow: Paint
  cyan: Paint
  blue: Paint
  magenta: Paint
  white: Paint
  brightYellow: Paint
  brightMagenta: Paint
  brightCyan: Paint
  string: Paint
  thinking: Paint
}

const paletteCache = new Map<string, Palette>()

function buildPalette(): Palette {
  const mono = colorLevel() === 0
  return {
    success: paintToken(TOKENS.success),
    error: paintToken(TOKENS.error),
    warning: paintToken(TOKENS.warning),
    info: paintToken(TOKENS.info),
    accent: paintToken(TOKENS.accent),
    accentAlt: paintToken(ACCENT_ALT_TOKEN),
    accentBold: paintTokenBold(TOKENS.accent),
    // Saat mono, `gray` memakai dim (SGR 2) alih-alih bright-black (SGR 90):
    // 90 adalah warna, dan mono adalah jalur aksesibilitas yang seharusnya
    // monokrom. Dim tetap memberi hierarki visual tanpa memakai kanal warna.
    gray: mono ? attr(2, 22) : paintToken(GRAY_TOKEN),
    // Faint: garis footer hampir tak terlihat. Mono (aksesibilitas) jatuh ke
    // dim agar tetap ada hierarki tanpa kanal warna.
    faint: mono ? attr(2, 22) : paintToken(TOKENS.faint),
    // Alias legacy: dipetakan ke token, bukan hex hardcoded.
    red: paintToken(TOKENS.error),
    green: paintToken(TOKENS.success),
    yellow: paintToken(TOKENS.warning),
    cyan: paintToken(TOKENS.info),
    blue: paintToken(TOKENS.accent),
    magenta: mono ? identity : paintToken(MAGENTA_TOKEN),
    white: mono ? identity : paintToken(WHITE_TOKEN),
    // Slot syntax highlight — saat mono semuanya jadi teks biasa.
    brightYellow: mono ? identity : paintToken(BRIGHT_YELLOW_TOKEN),
    brightMagenta: mono ? identity : paintToken(BRIGHT_MAGENTA_TOKEN),
    brightCyan: mono ? identity : paintToken(BRIGHT_CYAN_TOKEN),
    string: paintToken(TOKENS.string),
    thinking: paintToken(TOKENS.thinking),
  }
}

function palette(): Palette {
  // Kunci cache memuat level warna: NO_COLOR / COLORTERM bisa berubah antar
  // proses (dan antar test), dan palette mono vs truecolor berbeda isi.
  const key = `${colorLevel()}:${hasTruecolorEnv() ? 1 : 0}`
  const cached = paletteCache.get(key)
  if (cached) return cached
  const built = buildPalette()
  paletteCache.set(key, built)
  return built
}

// Atribut non-warna (dim/bold/italic) tetap lazy juga: NO_COLOR harus
// mematikannya, dan itu dievaluasi saat pakai.
const attrCache = new Map<string, Paint>()
function attr(open: number, close: number): Paint {
  const key = `${open}:${close}:${colorLevel()}`
  const hit = attrCache.get(key)
  if (hit) return hit
  const built = wrap(open, close)
  attrCache.set(key, built)
  return built
}

/**
 * Slot warna semantik.
 *
 * GETTER — JANGAN simpan ke `const` di module scope; lihat PLAN.md P0.1.
 * Setiap properti membaca level warna saat DIPANGGIL. Menulis
 * `const HEADER = c.dim(...)` di module scope membekukan hasilnya pada import
 * pertama (NO_COLOR, COLORTERM tidak lagi berpengaruh). Kesalahan ini sudah
 * terjadi dua kali (V6, V8). Dijaga oleh
 * `test/no-frozen-runtime-value.test.ts`.
 *
 * Benar: `() => c.dim(x)`, `get header() { return c.dim(x) }`, atau baca di
 * dalam fungsi render.
 */
export const c = {
  // Text hierarchy — tidak bergantung warna.
  text: identity,
  get muted() {
    return attr(2, 22) // dim - secondary info, borders
  },
  get bold() {
    return attr(1, 22)
  },
  get italic() {
    return attr(3, 23)
  },
  get dim() {
    return attr(2, 22)
  },

  // Status
  get success() {
    return palette().success
  },
  get error() {
    return palette().error
  },
  get warning() {
    return palette().warning
  },
  get info() {
    return palette().info
  },

  // Accent
  get accent() {
    return palette().accent
  },
  get accentAlt() {
    return palette().accentAlt
  },
  get accentBold() {
    return palette().accentBold
  },
  get gray() {
    return palette().gray
  },
  get faint() {
    return palette().faint
  },

  // Legacy compat (dipakai renderer lama) — kini mengikuti token.
  get red() {
    return palette().red
  },
  get green() {
    return palette().green
  },
  get yellow() {
    return palette().yellow
  },
  get cyan() {
    return palette().cyan
  },
  get blue() {
    return palette().blue
  },
  get magenta() {
    return palette().magenta
  },
  get white() {
    return palette().white
  },

  // Syntax highlight
  get brightYellow() {
    return palette().brightYellow
  },
  get brightMagenta() {
    return palette().brightMagenta
  },
  get brightCyan() {
    return palette().brightCyan
  },
  get string() {
    return palette().string
  },
  get thinking() {
    return palette().thinking
  },
}

// ── Glyphs - minimal, Ubuntu Server style ──
//
// GETTER — JANGAN simpan ke `const` di module scope; lihat PLAN.md P0.1.
// `supportsUtf8()` dievaluasi saat dipakai supaya `MINICODE_ASCII=1` dan
// perubahan env di test langsung berlaku. `const OK = glyphs.check` di
// `cli/commands.ts` pernah membekukannya (V8) sehingga fallback ASCII tidak
// pernah aktif. Dijaga oleh `test/no-frozen-runtime-value.test.ts`.
export const glyphs = {
  // A2 — status disampaikan lewat WARNA + kata, bukan glyph. Ikon sukses/gagal/
  // ditolak/dibatalkan (✓/✗/⊘/○) dihapus karena bising & tak konsisten antar
  // terminal; getter tetap "" agar semua pemanggil tak perlu diubah satu-satu.
  get check() {
    return ""
  },
  get cross() {
    return ""
  },
  get denied() {
    return ""
  },
  get circle() {
    return ""
  },
  get arrow() {
    return supportsUtf8() ? "›" : ">"
  },
  get prompt() {
    return supportsUtf8() ? "❯" : ">"
  },
  /** Pasangan kunci panah untuk hint — ASCII fallback agar kill-switch tetap utuh. */
  get upDown() {
    return supportsUtf8() ? "↑↓" : "Up/Down"
  },
  get leftRight() {
    return supportsUtf8() ? "←→" : "Left/Right"
  },
  /** Chevron pemilih nilai (form select) dengan fallback ASCII. */
  get chevronLeft() {
    return supportsUtf8() ? "‹" : "<"
  },
  get chevronRight() {
    return supportsUtf8() ? "›" : ">"
  },
  /** Caret blok di baris pencarian. */
  get caret() {
    return supportsUtf8() ? "█" : "#"
  },
  get down() {
    return supportsUtf8() ? "↓" : "v"
  },
  get dot() {
    return supportsUtf8() ? "·" : "."
  },
  get bullet() {
    return supportsUtf8() ? "●" : "*"
  },
  get ellipsis() {
    return supportsUtf8() ? "…" : "..."
  },
  get sparkle() {
    return supportsUtf8() ? "✦" : "*"
  },
  get spinnerFrames() {
    return supportsUtf8() ? ["·", "··", "···"] : [".", "..", "..."]
  },
  /** Karakter mask field secret (form & prompt inline) — satu sumber.
   * Sengaja getter (bukan const): MINICODE_ASCII bisa berubah saat runtime. */
  get mask() {
    return supportsUtf8() ? "•" : "*"
  },
  // Blok progress bar loading (baris tunggal). Fallback ASCII untuk terminal
  // tanpa UTF-8 (MINICODE_ASCII / konsol Windows legacy).
  get blockFilled() {
    return supportsUtf8() ? "▓" : "#"
  },
  get blockEmpty() {
    return supportsUtf8() ? "░" : "-"
  },
  get thinkingIcon() {
    // Sparkle ✦ (bintang) — indikator thinking yang "kelip-kelip": glyph
    // monokrom, jadi warna ANSI (putih ↔ abu di turn-status) terlihat.
    // Fallback * untuk terminal tanpa UTF-8.
    return supportsUtf8() ? "✦" : "*"
  },
  // Badge bash allow-list (footer): titik monokrom, bukan emoji gembok —
  // emoji berwarna dan lebarnya beda antar-font (kolom footer bergeser).
  // ●/○ satu kolom dan tetap terbaca saat diwarnai; fallback teks ASCII.
  get lock() {
    return supportsUtf8() ? "●" : "[LOCK]"
  },
  get unlock() {
    return supportsUtf8() ? "○" : "[OPEN]"
  },
  /** Garis horizontal & vertikal konsisten untuk divider dan penanda blok kode. */
  get hLine() {
    return supportsUtf8() ? "─" : "-"
  },
  get vLine() {
    return supportsUtf8() ? "│" : "|"
  },
}

// ── Section separator ──
export function section(title: string): string {
  const width = getTerminalWidth()
  // Judul bisa berasal dari model/berkas: sanitasi satu-baris agar `\n`/ANSI
  // tak memecah separator menjadi multi-baris atau menyuntik kontrol.
  const clean = sanitizeAnsiLine(title)
  // Label lebih panjang dari terminal (judul CJK/emoji panjang): potong dulu
  // per kolom — tanpa ini dashes jatuh ke 4 dan total label+4 tetap meluap.
  const label =
    displayWidth(` ${clean} `) > Math.max(4, width - 4)
      ? truncateToWidth(` ${clean} `, Math.max(4, width - 4), glyphs.ellipsis)
      : ` ${clean} `
  // Lebar pemisah dihitung per KOLOM terminal: CJK/emoji bisa 2 kolom.
  // Clamp agar garis tak memicu wrap sendiri di terminal sempit.
  const dashes = Math.min(Math.max(4, width - displayWidth(label)), Math.max(4, width - 4))
  return c.dim(label + glyphs.hLine.repeat(dashes))
}

export function getTerminalWidth(): number {
  return process.stdout.columns || 80
}

// Satu sumber pola ANSI. Dibangun via `new RegExp` dari String.fromCharCode(27)
// alih-alih literal /\x1b…/ supaya tidak menyisipkan control character mentah ke
// source (lint/suspicious/noControlCharactersInRegex) — perilaku identik.
export const ESC = String.fromCharCode(27)
// CSI dengan parameter privat (`?`, `<`, `=`, `>`) juga harus tertangkap:
// ESC[?25l, ESC[?2026h, ESC[?1049h dipakai untuk kursor/sync/alternate-screen.
// Tanpa itu sekuens kontrol lolos ke teks yang seharusnya sudah bersih —
// terlihat saat output ditangkap/disanitasi untuk tampilan.
// Final CSI = 0x40–0x7E (`[@-~]`), bukan hanya huruf — tanpanya `ESC[3~`
// menyisakan `~` dan merusak hitungan kolom. DCS/APC/PM/SOS = `ESC` + satu
// huruf `P/_/^/X` (BUKAN `ESC[` + kelas karakter) — pola lama `\[P_\^X]`
// hanya cocok untuk `ESC[P`/`ESC[_` dst. sehingga payload DCS bocor.
export const ANSI_PATTERN = `${ESC}(?:\\[[0-9;?<=>]*[@-~]|\\[[0-9;?<=>]*|\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|(?:P|_|\\^|X)[^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|[()#][0-~]|[0-~])`

/** Regex bersama untuk stripAnsi.
 *
 * Dulu `new RegExp(...)` dibuat tiap panggilan — meski hasilnya benar (lastIndex
 * `replace` selalu di-reset), ini hot path yang dipanggil per baris. Regex
 * global dicomile sekali; `String.replace` dengan flag `g` mereset `lastIndex`
 * sendiri sehingga aman dipakai bersama antar pemanggil (audit 2026-11-12).
 */
const ANSI_STRIP = new RegExp(ANSI_PATTERN, "g")

export function stripAnsi(str: string): string {
  return str.replace(ANSI_STRIP, "")
}
