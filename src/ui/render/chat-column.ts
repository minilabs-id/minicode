// Geometri kolom chat ter-centre — murni, tanpa I/O/ANSI/TTY/warna.

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

/** Centre maks 50% hanya bila ada ruang; di bawah ambang tetap lebar penuh
 * (memotong ke 40 kolom merusak wrap & kontrak narrow yang dijaga test). */
export function chatColumnGeometry(rows: number, cols: number): ChatColumnGeometry {
  const r = Math.max(0, Math.floor(rows))
  const c = Math.max(0, Math.floor(cols))
  const centered = c >= CHAT_COLUMN_MIN_COLS && r >= CHAT_COLUMN_MIN_ROWS
  const chatCols = centered ? Math.floor(c * CHAT_COLUMN_MAX_RATIO) : c
  const padLeft = Math.floor((c - chatCols) / 2)
  const padRight = c - chatCols - padLeft
  return { centered, cols: c, rows: r, chatCols, padLeft, padRight }
}

/** Lebar transkrip = chatCols; satu sumber untuk scroll/wrap/gema prompt
 * (memakai `cols` layar bikin cache proyeksi miss saat chat ter-centre). */
export function chatWidth(geo: ChatColumnGeometry): number {
  return Math.max(10, geo.chatCols)
}

/** Cap progresif: tiap 4 kolom di atas 100 menambah 1 (200→125, 500→200).
 * Cap baku 100 menyisakan ruang kosong; chat penuh membuat prompt terlalu
 * panjang. Lantai 10 menjaga narrow terminal. */
export function composerWidth(width: number): number {
  const w = Math.max(10, Math.floor(width))
  return Math.max(10, Math.min(w, 100 + Math.floor(Math.max(0, w - 100) / 4)))
}
