// Renderer sidebar kanan — helper MURNI (tanpa I/O, tanpa state).
//
// v0.33: dua jendela bertumpuk (thinking atas, aktivitas bawah) dikomposisi
// SEBAGAI KOLOM KANAN dari frame yang sama dengan chat. TANPA kotak/bingkai —
// hanya SATU garis vertikal abu di batas chat↔sidebar (digambar App), judul
// polos, dan jarak 3 baris antar jendela. Semua baris tepat `width` kolom.

import { t } from "../i18n/locale.ts"
import type { SidebarGeometry } from "./sidebar-layout.ts"
import { c, supportsUtf8 } from "./theme.ts"
import { padToWidth, truncateToWidth } from "./width.ts"

export interface SidebarRenderInput {
  readonly geom: SidebarGeometry
  readonly viewH: number
  readonly thinking: readonly string[]
  readonly activity: readonly string[]
  /** Baris Live (tool in-flight) — dipakai saat activitySplit aktif. */
  readonly live?: readonly string[]
  readonly thinkingOffset?: number
  readonly activityOffset?: number
  readonly thinkingFollow?: boolean
  readonly activityFollow?: boolean
  readonly liveOffset?: number
  readonly liveFollow?: boolean
  /** Jendela yang baru saja menerima data — judulnya sedikit lebih terang. */
  readonly activePane?: "thinking" | "activity" | "live"
  /** Saat idle, thinking hanya menampilkan ekor 3 baris (tanpa scroll manual). */
  readonly thinkingCollapsed?: boolean
}

function fit(value: string, width: number): string {
  return truncateToWidth(padToWidth(value, Math.max(1, width)), Math.max(1, width))
}

/** Judul: 1 spasi dari separator. Jendela aktif memakai `gray` (lebih terang
 *  dari `dim`) — auto-focus tanpa menambah garis atau teks. */
function titleRow(title: string, meta: string, width: number, active: boolean): string {
  const text = meta ? `${title}  ${meta}` : title
  const paint = active ? c.gray : c.dim
  return paint(padToWidth(` ${text}`, Math.max(1, width)))
}

/** Indikator posisi berupa garis/batang tipis, bukan angka `n/total live`. */
function positionBar(lines: readonly string[], offset: number, capacity: number): string {
  if (lines.length <= capacity) return ""
  const from = Math.max(0, Math.min(Math.floor(offset), Math.max(0, lines.length - 1)))
  const progress = Math.min(1, (from + capacity) / lines.length)
  const filled = Math.max(1, Math.round(progress * 6))
  const utf = supportsUtf8()
  return (utf ? "▰" : "=").repeat(filled) + (utf ? "▱" : "-").repeat(6 - filled)
}

function pane(
  lines: readonly string[],
  height: number,
  title: string,
  width: number,
  offset = 0,
  following = true,
  dimContent = false,
  active = false,
  collapseTail = false,
): string[] {
  const capacity = Math.max(0, Math.max(1, height) - 1)
  const bar = positionBar(lines, offset, capacity)
  const out: string[] = [titleRow(title, bar, width, active)]
  // Idle + mengikuti ekor → cuma ekor 3 baris. Begitu user menggulir
  // (following=false), riwayat penuh kembali tersedia seperti semula.
  const forced =
    collapseTail && following && lines.length > 3 ? Math.max(0, lines.length - 3) : null
  const from = Math.max(
    forced ?? 0,
    Math.min(Math.floor(offset), Math.max(forced ?? 0, lines.length - 1)),
  )
  const slice = lines.slice(from, from + capacity)
  const hiddenBefore = from
  const hiddenAfter = Math.max(0, lines.length - from - slice.length)
  const shown = [
    ...(hiddenBefore > 0 ? [`${t("panel.moreLines", { n: hiddenBefore })} ↑`] : []),
    ...slice,
    ...(hiddenAfter > 0 && !following ? [`↓ ${t("panel.moreLines", { n: hiddenAfter })}`] : []),
  ].slice(0, capacity)
  for (let i = 0; i < capacity; i++) {
    const line = fit(` ${shown[i] ?? ""}`, width)
    // Riset legibilitas (base16 / Textual): SGR `dim` menurunkan kontras teks
    // di latar gelap. `c.thinking` = abu-kebiruan sekunder yang TETAP terbaca
    // nyaman — tetap redup, tapi tidak menyiksa mata saat dibaca lama.
    out.push(dimContent ? c.thinking(line) : line)
  }
  return out.slice(0, Math.max(1, height))
}

/** Susun tepat `viewH` baris sidebar; padding baris kosong menjaga tinggi stabil. */
export function renderSidebar(input: SidebarRenderInput): string[] {
  const { geom, viewH } = input
  if (!geom.active || geom.width <= 0) return []
  const thinking = input.thinking
  const activity = input.activity
  const thinkingFollow = input.thinkingFollow ?? true
  const activityFollow = input.activityFollow ?? true
  const activePane = input.activePane
  const top = pane(
    thinking,
    geom.topHeight,
    t("sidebar.thinking"),
    geom.width,
    input.thinkingOffset,
    thinkingFollow,
    true,
    activePane === "thinking",
    input.thinkingCollapsed ?? false,
  )
  // Activity: satu jendela penuh, ATAU dua jendela berdampingan di layar lebar.
  const livePane = geom.activitySplit
    ? pane(
        input.live ?? [],
        geom.bottomHeight,
        t("sidebar.livePane"),
        geom.liveWidth,
        input.liveOffset ?? 0,
        input.liveFollow ?? true,
        false,
        activePane === "live",
      )
    : []
  const bottom = pane(
    activity,
    geom.bottomHeight,
    t("sidebar.activity"),
    geom.activitySplit ? geom.logWidth : geom.width,
    input.activityOffset,
    activityFollow,
    false,
    activePane === "activity",
  )
  // Gabungkan Live + 2 spasi + Log per baris (gutter horizontal = 2× vertikal 1).
  const activityRows =
    geom.activitySplit && livePane.length > 0
      ? livePane.map((line, i) => {
          const other = bottom[i] ?? " ".repeat(geom.logWidth)
          return `${line}${" ".repeat(geom.splitGap)}${other}`
        })
      : bottom
  const out: string[] = []
  for (let r = 0; r < Math.max(1, viewH); r++) {
    if (r < top.length) out.push(top[r]!)
    else if (r < geom.bottomRow) out.push(" ".repeat(geom.width))
    else if (r - geom.bottomRow < activityRows.length) out.push(activityRows[r - geom.bottomRow]!)
    else out.push(" ".repeat(geom.width))
  }
  return out.slice(0, Math.max(1, viewH))
}
