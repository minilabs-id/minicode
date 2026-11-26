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
import { glyphs } from "../render/theme.ts"
import type { DialogSpec } from "./dialog.ts"

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

/** Footer baku: navigasi → pilih → tutup, plus aksi khusus jendela (opsional). */
export function windowFooter(extra: readonly HintItem[] = []): string {
  const extraKeys = new Set(extra.map((h) => h.key))
  const nav: HintItem[] = [
    { key: glyphs.upDown, label: t("hint.move") },
    { key: "Enter", label: t("hint.select") },
    { key: "Esc", label: t("hint.cancel") },
  ].filter((item) => !extraKeys.has(item.key))
  return hintLine([...nav, ...extra])
}

export interface WindowSpecOptions {
  title: string
  body: string[]
  cols: number
  rows: number
  focusRow?: number
  /** Aksi tambahan di footer (mis. `a add`, `d delete`). */
  extraHints?: readonly HintItem[]
}

/** Satu `DialogSpec` untuk semua jendela — pemanggil tinggal kasih konten. */
export function windowSpec(opts: WindowSpecOptions): DialogSpec {
  const w = windowWidth(opts.cols)
  return {
    title: opts.title,
    body: opts.body,
    footer: windowFooter(opts.extraHints),
    minWidth: w,
    maxWidth: w,
    maxHeight: windowMaxHeight(opts.rows),
    ...(opts.focusRow !== undefined ? { focusRow: opts.focusRow } : {}),
  }
}
