// Geometri kolom chat ter-centre — modul MURNI: tanpa I/O, ANSI, atau TTY.
// sengaja tak mengimpor theme.ts: `c`/`glyphs` di sana adalah getter runtime
// yang membeku bila disimpan di module scope, dan helper ini tak butuh warna.

export const CHAT_COLUMN_MIN_COLS = 120
export const CHAT_COLUMN_MIN_ROWS = 20
export const CHAT_COLUMN_MAX_RATIO = 0.5

export interface ChatColumnGeometry {
  centered: boolean
  cols: number
  rows: number
  chatCols: number
  padLeft: number
  padRight: number
}

/**
 * Chat ter-centre maksimal 50% lebar terminal, tapi HANYA bila ada ruang.
 *
 * Kenapa cols=80 tetap chat penuh (bukan 40): memotong jadi 40 kolom merusak
 * wrap transkrip/composer dan kontrak narrow (30/60 kolom) yang sudah dijaga
 * test. Centre adalah peningkatan layout, bukan pengecilan: bila terminal
 * terlalu sempit/pendek, satu-satunya pilihan jujur adalah memakai semua kolom.
 */
export function chatColumnGeometry(rows: number, cols: number): ChatColumnGeometry {
  const r = Math.max(0, Math.floor(rows))
  const c = Math.max(0, Math.floor(cols))
  const centered = c >= CHAT_COLUMN_MIN_COLS && r >= CHAT_COLUMN_MIN_ROWS
  const chatCols = centered ? Math.floor(c * CHAT_COLUMN_MAX_RATIO) : c
  const padLeft = Math.floor((c - chatCols) / 2)
  const padRight = c - chatCols - padLeft
  return { centered, cols: c, rows: r, chatCols, padLeft, padRight }
}

/**
 * Lebar area transkrip (= lebar kolom chat). Satu sumber untuk scroll,
 * indikator, wrap composer DAN gema prompt: memakai `chatCols` mentah
 * daripada `cols` layar bikin cache proyeksi miss saat chat ter-centre.
 */
export function chatWidth(geo: ChatColumnGeometry): number {
  return Math.max(10, geo.chatCols)
}

/**
 * Lebar wrap composer — cap progresif, bukan baku 100.
 *
 * Kenapa progresif: pada terminal sangat lebar chat bisa 200–500 kolom;
 * memotong composer ke 100 menyisakan ruang kosong yang tak berguna, tapi
 * membiarkannya mengikuti chat penuh membuat baris prompt terlalu panjang
 * untuk dibaca. tiap 4 kolom di atas 100 menambah 1 kolom composer:
 * 100→100, 200→125, 300→150, 500→200. Lantai 10 menjaga narrow terminal.
 */
export function composerWidth(width: number): number {
  const w = Math.max(10, Math.floor(width))
  return Math.max(10, Math.min(w, 100 + Math.floor(Math.max(0, w - 100) / 4)))
}
