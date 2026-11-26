// Satu aturan jendela untuk SEMUA popup interaktif (picker, form, model,
// provider, wizard, output window, approval, input). v0.33 — pemilik meminta
// satu format & satu aturan ukuran supaya hierarki jendela terbaca konsisten.
//
// Prinsip:
// - SATU aturan ukuran, bukan satu angka kaku: lebar = clamp(cols-4, 56, 88)
//   lalu dibatasi ruang nyata terminal. Daftar model / output panjang tetap
//   bernapas, tapi setiap jendela memakai RUMUS yang sama.
// - SATU format: judul selalu ada, footer selalu sama, isi 1 baris = 1 item.
// - Ikon hanya penanda KATEGORI/NAVIGASI (flat, 1 kolom, fallback ASCII).
//   Status tetap warna + kata — kontrak A2 tidak dibatalkan.

import { t } from "../i18n/locale.ts"
import { type HintItem, hintLine } from "../render/hint.ts"
import { c, glyphs } from "../render/theme.ts"
import { truncateToWidth } from "../render/width.ts"
import type { DialogSpec } from "./dialog.ts"

export type WindowRole = "list" | "form" | "viewer" | "progress"

export const WINDOW_MIN_COLS = 56
export const WINDOW_MAX_COLS = 88
export const WINDOW_MARGIN = 4

/** Lebar jendela seragam: clamp(cols-4, 56, 88), dibatasi ruang terminal. */
export function windowWidth(cols: number): number {
  const room = Math.max(10, Math.floor(cols) || 80)
  const withMargin = Math.max(10, room - WINDOW_MARGIN)
  return Math.min(withMargin, Math.max(WINDOW_MIN_COLS, Math.min(WINDOW_MAX_COLS, withMargin)))
}

/**
 * Tinggi TOTAL kotak maksimum = tinggi terminal. Empat baris chrome
 * (2 border + judul + footer) dikurangi `dialogBox`, sehingga anggaran isi
 * = `rows - 4`. Pemanggil yang butuh anggaran isi memakai
 * `windowMaxHeight(rows) - 4`, bukan menurunkan nilai ini — dulu nilai ini
 * dikurangi 4 di hulu sehingga isi jendela kehilangan 4 baris lagi (clipped).
 */
export function windowMaxHeight(rows: number): number {
  return Math.max(5, Math.floor(rows))
}

/** Gabungkan daftar hint menjadi satu baris footer; pemotongan lebar dilakukan `dialogBox`. */
function fitHints(items: readonly HintItem[]): string {
  return items.length ? hintLine(items) : ""
}

/** Footer baku: menyesuaikan peran jendela (list/form/viewer/progress) + extraHints. */
export function windowFooter(
  extra: readonly HintItem[] = [],
  opts?: { role?: WindowRole; maxWidth?: number },
): string {
  // Peringatan idle darurat (`!`) memprioritaskan seluruh lebar footer agar
  // tidak terpotong di belakang navigasi pada terminal 80–120 kolom.
  const urgent = extra.find((h) => h.key === "!")
  if (urgent) {
    const text = `! ${urgent.label}`
    return c.error(
      opts?.maxWidth != null ? truncateToWidth(text, opts.maxWidth, glyphs.ellipsis) : text,
    )
  }
  const role = opts?.role ?? "list"
  // Esc pindah ke pojok kanan atas dialog (redup tanpa keterangan), sehingga
  // footer bawah fokus ke navigasi & aksi isi saja.
  if (role === "progress" || role === "form" || role === "viewer") {
    return fitHints(extra)
  }
  const extraKeys = new Set(extra.map((h) => h.key))
  const nav: HintItem[] = [
    { key: glyphs.upDown, label: t("hint.move") },
    { key: "Enter", label: t("hint.select") },
  ].filter((item) => !extraKeys.has(item.key))
  return fitHints([...nav, ...extra])
}

export interface WindowSpecOptions {
  title: string
  body: string[]
  cols: number
  rows: number
  focusRow?: number
  /** Peran jendela agar hint footer sesuai interaksi nyata. Default `"list"`. */
  role?: WindowRole
  /** Aksi tambahan di footer (mis. `a add`, `d delete`). */
  extraHints?: readonly HintItem[]
  /** Override footer penuh bila pemanggil membangun hint khusus (mis. approval). */
  footerOverride?: string
  /** Tampilkan `Esc` redup di pojok kanan atas judul. Default aktif selain `progress`. */
  escHint?: boolean
}

/** Satu `DialogSpec` untuk semua jendela — pemanggil tinggal kasih konten. */
export function windowSpec(opts: WindowSpecOptions): DialogSpec {
  const w = windowWidth(opts.cols)
  const innerW = Math.max(10, w - 4)
  const escHint = opts.escHint ?? opts.role !== "progress"
  const footer =
    opts.footerOverride !== undefined
      ? opts.footerOverride
      : windowFooter(opts.extraHints, {
          ...(opts.role !== undefined ? { role: opts.role } : {}),
          maxWidth: innerW,
        })
  return {
    title: opts.title,
    body: opts.body,
    ...(footer ? { footer } : {}),
    ...(escHint ? { escHint } : {}),
    minWidth: w,
    maxWidth: w,
    maxHeight: windowMaxHeight(opts.rows),
    ...(opts.focusRow !== undefined ? { focusRow: opts.focusRow } : {}),
  }
}
