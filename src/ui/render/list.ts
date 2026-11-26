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
 * Sorot kecocokan sub-string case-insensitive pada `label` secara aman-grapheme
 * (emoji/surrogate/UTF-8 tak terbelah), plus akhiran `suffix` tak tersorot.
 */
export function highlightMatch(
  label: string,
  query: string,
  selected: boolean,
  suffix = "",
): string {
  if (!query) return listRow(`${label}${suffix}`, selected)
  const paintBase = (s: string): string => (selected ? c.accent(c.bold(s)) : c.dim(s))
  const paintHit = (s: string): string => (selected ? c.brightCyan(c.bold(s)) : c.dim(c.info(s)))
  const prefix = selected ? `  ${c.accent(glyphs.arrow)} ` : "    "
  const qLower = query.toLowerCase()
  const graphemes = segmentGraphemes(label)
  const lowerParts = graphemes.map((g) => g.toLowerCase())
  const matchStart = lowerParts.join("").indexOf(qLower)
  if (matchStart < 0) return `${prefix}${paintBase(`${label}${suffix}`)}`
  const matchEnd = matchStart + qLower.length
  let pos = 0
  let before = ""
  let hit = ""
  let after = ""
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]!
    const len = lowerParts[i]!.length
    const gEnd = pos + len
    if (gEnd <= matchStart) before += g
    else if (pos >= matchEnd) after += g
    else hit += g
    pos = gEnd
  }
  const tail = `${after}${suffix}`
  return `${prefix}${before ? paintBase(before) : ""}${hit ? paintHit(hit) : ""}${tail ? paintBase(tail) : ""}`
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
