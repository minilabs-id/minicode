// v7.44 (audit) — helper murni untuk dua jejak teks baru di layar interaktif:
//   - baris progres startup (`start 57%\r`), satu baris yang ditimpa sendiri;
//   - blok penutup sesi di scrollback (logo asli + statistik) setelah
//     alt-screen ditutup supaya bisa disalin.
//
// Semua fungsi di sini TANPA I/O dan TANPA state: waktu (Date), daftar baris
// logo, dan angka disuntikkan pemanggil. Ini yang membuatnya bisa diuji
// hermetik tanpa TTY, SQLite, maupun provider — dan mencegah helper diam-diam
// membaca `process.cwd()`/`Date.now()` (sumber flake lintas-proses).
//
// Batas lapisan: modul `src/ui/` hanya boleh impor sesama `src/ui/`, jadi
// `renderLogoRows()` TIDAK dipanggil di sini — pemanggil (`cli/tui.ts`) yang
// menyuntik baris logo nyata dari grid pemilik.

import { formatUsd } from "../render/money.ts"

/** Data statistik sesi untuk blok penutup. `null` = data memang tak tersedia. */
export interface SessionSummaryInfo {
  readonly stamp: string
  readonly turns: number
  readonly tools: number
  readonly files: number
  readonly other: number
  readonly tokens: number
  readonly cost: number | null | undefined
  /** Milidetik (difmt di sini) atau string siap pakai (format sudah dipilih caller). */
  readonly duration: number | string
  readonly version: string
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/**
 * Cap sesi = WAKTU PENUTUPAN saja (bukan rentang mulai→selesai), lokal,
 * zero-padded: 19 Nov 2026 13:11:30 → `minicode19112026131130`.
 *
 * Kenapa inject `Date`: cap dihitung sekali saat blok penutup disusun. Kalau
 * helper membaca jam sendiri, test tak bisa memverifikasi formatnya dan
 * pemanggil bisa tanpa sengaja memakai dua waktu yang berbeda.
 */
export function buildSessionStamp(date: Date): string {
  const d = date.getDate()
  const m = date.getMonth() + 1
  const y = date.getFullYear()
  const hh = date.getHours()
  const mm = date.getMinutes()
  const ss = date.getSeconds()
  return `minicode${pad2(d)}${pad2(m)}${y}${pad2(hh)}${pad2(mm)}${pad2(ss)}`
}

/**
 * Persen fase startup. `Math.floor` sengaja dipakai, bukan `Math.round`:
 * 5/9 → 55% (bukan 56%) sesuai kontrak, dan 9 fase menghasilkan deret bersih
 * 11,22,…,88,100. Fase ke-N dihitung 1-based; total ≤ 0 = 0 (fail-closed).
 */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)))
}

/**
 * Satu baris progres. `\r` dan `\n` sengaja TIDAK disertakan di sini —
 * pemanggil yang memutuskan menimpa (`\r`) atau menutup (`\n`), supaya helper
 * tetap murni dan test bisa memeriksa isi baris tanpa escape terminal.
 * Clamp 0..100 + bulatkan: angka desimal dari kalkulasi tak boleh bocor.
 */
export function buildProgressLine(prefix: "start" | "update", percent: number): string {
  const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0
  return `${prefix} ${p}%`
}

/** Rupiah/token pakai pemisah ribuan Indonesia (titik), bukan koma. */
function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  return String(Math.floor(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
}

function formatDuration(duration: number | string): string {
  if (typeof duration === "string") return duration
  if (!Number.isFinite(duration) || duration <= 0) return "0m0s"
  const totalSeconds = Math.floor(duration / 1000)
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`
}

/**
 * Blok penutup persis seperti kontrak: logo (atau apa pun baris yang
 * disuntikkan) → satu baris kosong → judul → cap → empat metrik → versi.
 * Rata kiri: logo TIDAK di-center supaya seluruh blok bisa disalin rapi.
 * Label "Session"/"version" sengaja literal (token teknis stabil); judul
 * "Minicode" adalah brand, bukan terjemahan. Biaya tak tersedia = `$—`,
 * jangan mengarang `$0.00`.
 */
export function buildClosingBlock(logoRows: readonly string[], info: SessionSummaryInfo): string[] {
  const cost = info.cost == null ? "$—" : formatUsd(info.cost)
  return [
    ...logoRows,
    "",
    "Minicode",
    `Session : ${info.stamp}`,
    `${info.turns} turn   ${info.tools} tool   ${info.files} file   ${info.other} other`,
    `${formatTokens(info.tokens)} tok   ${cost}   ${formatDuration(info.duration)}`,
    `version ${info.version}`,
  ]
}
