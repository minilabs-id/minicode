// Baris daftar pilihan: kolom marker SELALU dicadangkan agar label tidak
// bergeser satu kolom saat seleksi berpindah. Satu sumber untuk picker,
// manager model/provider, dan modal approval — sebelumnya prefix selected
// 4 kolom vs unselected 3 kolom (jitter) dan approval tanpa marker `›`.
import { sanitizeAnsiLine } from "./sanitize.ts"
import { c, glyphs } from "./theme.ts"
import { displayWidth, segmentGraphemes } from "./width.ts"

export function listRow(label: string, selected: boolean): string {
  return selected ? `  ${c.accent(glyphs.arrow)} ${c.accent(c.bold(label))}` : `    ${c.dim(label)}`
}

/**
 * Ambil akhiran query agar muat dalam `maxCols` saat diketik panjang di kotak
 * filter (picker & model-manager), sehingga kursor tetap berada di dalam kotak.
 */
export function tailFilterWindow(text: string, maxCols: number): string {
  const clean = sanitizeAnsiLine(text)
  if (displayWidth(clean) <= maxCols) return clean
  const ell = glyphs.ellipsis
  const budget = Math.max(1, maxCols - displayWidth(ell))
  const pts = segmentGraphemes(clean)
  const kept: string[] = []
  let w = 0
  for (let i = pts.length - 1; i >= 0; i--) {
    const gw = displayWidth(pts[i] ?? "")
    if (w + gw > budget) break
    kept.unshift(pts[i]!)
    w += gw
  }
  return `${ell}${kept.join("")}`
}
