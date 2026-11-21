// Geometri sidebar kanan — helper MURNI (tanpa I/O, tanpa ANSI, tanpa TTY).
//
// v0.33: satu aturan untuk area transkrip & dua kotak sidebar. Diseimpan di
// `src/ui/render` supaya `src/ui/tui/app.ts` (satu-satunya pemilik frame)
// memanggilnya dari satu tempat; `viewportHeight`, `buildLayout`, dan indikator
// "new lines below" akan memakai helper yang sama — menghilangkan drift viewH
// yang dulu dihitung di tiga tempat.
//
// Sidebar memakai SETENGAH layar (keputusan pemilik), tetapi chat tidak boleh
// lebih sempit dari 36 kolom (lantai margin-3 `effectiveAssistantMargin`).
// Jika syarat itu tak terpenuhi, sidebar mati dan seluruh lebar kembali ke chat.

export const SIDEBAR_MIN_COLS = 100
export const SIDEBAR_MIN_ROWS = 20
export const SIDEBAR_MIN_CHAT_COLS = 36
/** Split Activity jadi Live|Log saat jendela ~70% desktop (≥168 kolom).
 *  Perkiraan: 70% × 1920 px ÷ ~8 px/karakter = 168 kolom. */
export const SIDEBAR_SPLIT_COLS = 168
/** Jarak horizontal antar dua sub-jendela Activity (2× gutter vertikal 1 baris). */
export const SIDEBAR_SPLIT_GAP = 2
/**
 * Jarak antara chat & sidebar: 3–5 kolom, elastis mengikuti lebar jendela.
 * Sengaja SPAASI (bukan garis `│`) — juga menyamakan napas dengan margin kiri
 * chat yang 3 kolom; di layar lebar jaraknya ikut membesar sampai 5.
 */
export function sidebarGap(cols: number): number {
  return Math.max(3, Math.min(5, Math.round(Math.max(1, cols) / 40)))
}

export interface SidebarGeometry {
  readonly active: boolean
  /** Lebar total sidebar termasuk border/padding (0 saat nonaktif). */
  readonly width: number
  /** Lebar area chat = cols - width - gap (gap = spasi, bukan glyph separator). */
  readonly chatCols: number
  /** Jarak spasi antara chat & sidebar (3–5 kolom). */
  readonly gap: number
  /** Baris 0-based tempat kotak atas mulai. */
  readonly topRow: number
  readonly topHeight: number
  /** Baris 0-based tempat grup Activity mulai. */
  readonly bottomRow: number
  readonly bottomHeight: number
  /** Activity dibagi Live|Log berdampingan (jendela sangat lebar). */
  readonly activitySplit: boolean
  /** Lebar sub-jendela Live (0 bila tak split). */
  readonly liveWidth: number
  /** Lebar sub-jendela Log (0 bila tak split). */
  readonly logWidth: number
  /** Jarak antar Live|Log (0 bila tak split). */
  readonly splitGap: number
}

/**
 * Hitung geometri sidebar untuk frame yang TEPAT `rows` baris.
 * Tinggi kotak diambil dari `viewH` (area transkrip) yang dipanggil dengan
 * `viewH` nyata oleh pemanggil — helper ini hanya membagi area tersebut.
 */
export function sidebarGeometry(
  rows: number,
  cols: number,
  viewH: number,
  thinkingRatio = 0.6,
): SidebarGeometry {
  const safeCols = Math.max(1, Math.floor(cols))
  const safeRows = Math.max(1, Math.floor(rows))
  const safeViewH = Math.max(1, Math.floor(viewH))

  // v0.33: lebar adaptif — 30% di ≤150 kolom, naik LINEAR ke 50% di ≥160.
  // SATU rumus tanpa cabang: cabang lama bikin rasio diskontinuitas di 160.
  const ratio = Math.min(0.5, Math.max(0.3, 0.3 + ((safeCols - 150) / 10) * 0.2))
  const gap = sidebarGap(safeCols)
  const room = safeCols - SIDEBAR_MIN_CHAT_COLS - gap
  const width = Math.max(0, Math.min(Math.floor(safeCols * ratio), room))
  const active = safeCols >= SIDEBAR_MIN_COLS && safeRows >= SIDEBAR_MIN_ROWS && width > 0
  const chatCols = active ? safeCols - width - gap : safeCols

  if (!active) {
    return {
      active: false,
      width: 0,
      chatCols,
      gap,
      topRow: 0,
      topHeight: 0,
      bottomRow: 0,
      bottomHeight: 0,
      activitySplit: false,
      liveWidth: 0,
      logWidth: 0,
      splitGap: 0,
    }
  }

  // Dua jendela + jarak 3 baris di dalam viewH (permintaan pemilik).
  // Jangan pernah menambah baris frame — kontrak I1: tepat `rows`.
  // Pakai viewH NYATA (bukan dibesarkan ke 9) — kalau tidak, untuk viewH<9
  // jumlah baris kotak melebihi frame dan merusak kontrak I1.
  const available = safeViewH
  const divider = Math.max(0, Math.min(3, available - 4))
  const splitRatio = Math.max(0.3, Math.min(0.8, thinkingRatio))
  const topHeight = Math.max(2, Math.floor((available - divider) * splitRatio))
  const bottomHeight = Math.max(2, available - divider - topHeight)
  return {
    active: true,
    width,
    chatCols,
    gap,
    topRow: 0,
    topHeight,
    bottomRow: topHeight + divider,
    bottomHeight,
    activitySplit: safeCols >= SIDEBAR_SPLIT_COLS,
    liveWidth: safeCols >= SIDEBAR_SPLIT_COLS ? Math.floor((width - SIDEBAR_SPLIT_GAP) / 2) : 0,
    logWidth:
      safeCols >= SIDEBAR_SPLIT_COLS
        ? width - Math.floor((width - SIDEBAR_SPLIT_GAP) / 2) - SIDEBAR_SPLIT_GAP
        : 0,
    splitGap: safeCols >= SIDEBAR_SPLIT_COLS ? SIDEBAR_SPLIT_GAP : 0,
  }
}
