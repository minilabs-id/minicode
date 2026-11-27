// Satu sumber marker/status/warna untuk baris ledger tool — dipakai TUI
// (transcript.ts) dan printer linier (simple.ts) supaya glyph, kata status,
// warna, dan label run sub-agent tidak divergen. Sebelumnya logika ini
// diduplikasi di kedua berkas (dan mudah drift — kelas OAP-001).
//
// Murni & tanpa IO: hanya memetakan status → kata/glyph/warna; sanitasi dan
// pemotongan lebar tetap di sisi pemanggil.
import type { UiToolStatus } from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "./sanitize.ts"
import { c } from "./theme.ts"
import { truncateToWidth } from "./width.ts"

/** Kata status lokal ("completed"/"failed"/dst.) — fallback non-warna. */
export function statusWord(status: UiToolStatus): string {
  if (status === "completed") return t("ts.statusCompleted")
  if (status === "failed") return t("ts.statusFailed")
  if (status === "denied") return t("ts.statusDenied")
  if (status === "cancelled") return t("ts.statusCancelled")
  if (status === "interrupted") return t("ts.statusInterrupted")
  return t("ts.statusRunning")
}

/** Warna baris ledger berdasar status terminal (sukses/error/denied/lain). */
export function paintLedger(status: UiToolStatus, line: string): string {
  // v7.42: awali dengan reset penuh supaya baris proses/tool tidak mewarisi
  // SGR dari baris sebelumnya (keluhan "warna/font bocor ke teks sekitar").
  // `c.*` memakai `\x1b[39m` (reset foreground) — itu mengembalikan ke warna
  // DEFAULT terminal, bukan ke warna induk, sehingga teks tetangga berubah.
  // `\x1b[0m` di awal mengisolasi setiap baris secara deterministik; saat mono
  // (NO_COLOR/MINICODE_COLOR=0) c.* jadi identitas & reset pun tak bermasalah.
  const painted =
    status === "failed"
      ? c.error(line)
      : status === "denied"
        ? c.warning(line)
        : status === "completed"
          ? c.success(line)
          : c.gray(line)
  return process.env.MINICODE_COLOR === "0" || process.env.NO_COLOR ? painted : `\x1b[0m${painted}`
}

/**
 * Label run pendek untuk identitas sub-agent.
 *
 * Prioritas: `label` manusiawi (`explore-1`, `plan-2`, atau nama dari model),
 * lalu fallback code-derived (`run_<8>` | `sub_<8>`) bila label absen (event lama).
 * Nama model = teks tak-terpercaya, jadi WAJIB lewat `sanitizeAnsiLine` dan
 * dipotong per lebar kolom sebelum dipampilkan di baris ledger satu-baris.
 */
export function runMarker(
  activity: { runId?: string; childSessionId?: string; label?: string } | undefined,
): string {
  const label = activity?.label
  if (label) {
    const clean = sanitizeAnsiLine(label).trim()
    if (clean) return truncateToWidth(clean, 24, "…")
  }
  const id = activity?.runId ?? activity?.childSessionId
  if (!id) return ""
  const prefix = id.startsWith("run_") ? "run_" : id.startsWith("sub_") ? "sub_" : ""
  const bare = id.slice(prefix.length).replace(/-/g, "")
  return prefix + bare.slice(0, 8)
}
