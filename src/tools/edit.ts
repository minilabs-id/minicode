import type { Tool } from "#minicore"
import { commitSafeTextEdit, readSafeTextForEdit } from "./context.ts"
import { applyHashline } from "./hashline.ts"

function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n")
}

function stripTrailingWhitespace(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
}

// Petakan index di string ternormalisasi (LF) kembali ke index string asli.
function mapOriginalIndex(original: string, nIdx: number): number {
  let oi = 0,
    ni = 0
  while (ni < nIdx && oi < original.length) {
    if (original[oi] === "\r" && original[oi + 1] === "\n")
      oi += 2 // \r\n = 1 unit LF
    else oi += 1
    ni += 1
  }
  return oi
}

export interface MatchResult {
  start: number
  end: number
  mode: "exact" | "crlf" | "trimmed" | "fuzzy"
}

// Helper: hitung range byte di cLf dari indeks baris — dipakai trimmed & fuzzy
function lineRange(
  cLfLines: string[],
  startLine: number,
  lineCount: number,
  content: string,
): { start: number; end: number } {
  const startInLf = cLfLines.slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0)
  const endInLf = startInLf + cLfLines.slice(startLine, startLine + lineCount).join("\n").length
  return { start: mapOriginalIndex(content, startInLf), end: mapOriginalIndex(content, endInLf) }
}

// Search needle dengan toleransi bertingkat:
// 1. Exact match
// 2. CRLF vs LF match
// 3. Trimmed trailing whitespace line match
// 4. Line-by-line normalized whitespace match
export function flexibleMatch(content: string, needle: string): MatchResult | null {
  // 1. Exact match
  const direct = content.indexOf(needle)
  if (direct !== -1) return { start: direct, end: direct + needle.length, mode: "exact" }

  const cLf = normalizeLf(content)
  const nLf = normalizeLf(needle)

  // 2. CRLF vs LF match
  const nStart = cLf.indexOf(nLf)
  if (nStart !== -1)
    return {
      start: mapOriginalIndex(content, nStart),
      end: mapOriginalIndex(content, nStart + nLf.length),
      mode: "crlf",
    }

  const cLfLines = cLf.split("\n")
  // 3. Trailing whitespace tolerance — hanya terima kecocokan yang menempel di
  // batas baris utuh, karena lineRange() mengganti seluruh baris awal..akhir.
  // Match substring di tengah baris bisa menelan token sebelum/sesudah match.
  const cTrimmed = stripTrailingWhitespace(cLf)
  const nTrimmed = stripTrailingWhitespace(nLf)
  if (nTrimmed.length > 0) {
    let searchFrom = 0
    while (searchFrom <= cTrimmed.length - nTrimmed.length) {
      const trimStart = cTrimmed.indexOf(nTrimmed, searchFrom)
      if (trimStart === -1) break
      const trimEnd = trimStart + nTrimmed.length
      const atLineStart = trimStart === 0 || cTrimmed[trimStart - 1] === "\n"
      const atLineEnd = trimEnd === cTrimmed.length || cTrimmed[trimEnd] === "\n"
      if (atLineStart && atLineEnd) {
        const lineCountBefore =
          trimStart === 0 ? 0 : cTrimmed.slice(0, trimStart).split("\n").length - 1
        const needleLineCount = nTrimmed.split("\n").length
        if (lineCountBefore + needleLineCount <= cLfLines.length) {
          const r = lineRange(cLfLines, lineCountBefore, needleLineCount, content)
          return { ...r, mode: "trimmed" }
        }
      }
      searchFrom = trimStart + 1
    }
  }

  // 4. Fuzzy line-by-line match (ignoring leading/trailing whitespace per line)
  const cLines = cLfLines
  const nLines = nLf.split("\n")
  if (nLines.length > 0 && nLines.length <= cLines.length) {
    const nStripped = nLines.map((l) => l.trim())
    let matchLineIdx = -1
    for (let i = 0; i <= cLines.length - nLines.length; i++) {
      let ok = true
      for (let j = 0; j < nLines.length; j++)
        if (cLines[i + j]?.trim() !== nStripped[j]) {
          ok = false
          break
        }
      if (ok) {
        if (matchLineIdx !== -1) return null // ambiguous
        matchLineIdx = i
      }
    }
    if (matchLineIdx !== -1) {
      const r = lineRange(cLfLines, matchLineIdx, nLines.length, content)
      return { ...r, mode: "fuzzy" }
    }
  }
  return null
}

// Aturan uniqueness: `needle` harus menunjuk SATU tempat di `content` menurut
// matcher yang sama dengan flexibleMatch (exact → crlf → trimmed → fuzzy).
// Satu aturan untuk DUA jalur edit (hashline cepat & fallback) — sebelumnya
// jalur hashline hanya mencari duplikat SUBSTRING PERSIS, sehingga needle yang
// unik-persis tapi ambigu-fuzzy lolos dan blok PERTAMA diedit diam-diam.
// `first` dipakai kalau pemanggil sudah punya hasil flexibleMatch (jalur
// fallback); kalau tidak, dihitung di sini.
function isAmbiguousMatch(content: string, needle: string, first?: MatchResult | null): boolean {
  const m = first ?? flexibleMatch(content, needle)
  if (!m) return false
  return flexibleMatch(content.slice(m.end), needle) !== null
}

/**
 * Buat petunjuk diagnostik ketika `oldString` gagal cocok agar model cukup
 * membaca ulang bagian terkait lewat `read_file` alih-alih panik memakai
 * skrip python/node lewat `bash`.
 */
export function buildEditNotFoundHint(content: string, needle: string, pathLabel: string): string {
  const contentLines = normalizeLf(content).split("\n")
  const needleLines = normalizeLf(needle)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  const anchor = needleLines.find((l) => l.length >= 4) ?? needleLines[0] ?? ""
  if (!anchor) {
    return `\nTip: the file may have changed — call read_file on ${pathLabel} to inspect the exact current text and punctuation.`
  }
  const anchorTokens = new Set(anchor.match(/[A-Za-z0-9_]+/g) ?? [])
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < contentLines.length; i++) {
    const t = contentLines[i]!.trim()
    if (!t) continue
    let score = 0
    if (t === anchor) {
      score = 1
    } else if (t.length >= 6 && anchor.length >= 6 && (t.includes(anchor) || anchor.includes(t))) {
      score = 0.8
    } else if (anchorTokens.size > 0) {
      const tokens = t.match(/[A-Za-z0-9_]+/g)
      if (tokens && tokens.length > 0) {
        const lineSet = new Set(tokens)
        let shared = 0
        for (const tok of anchorTokens) {
          if (lineSet.has(tok)) shared++
        }
        score = (shared / anchorTokens.size) * 0.75
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestIdx === -1 || bestScore < 0.4) {
    return `\nTip: the file may have changed — call read_file on ${pathLabel} to inspect the exact current text and punctuation.`
  }
  const start = Math.max(0, bestIdx - 1)
  const end = Math.min(contentLines.length, bestIdx + 4)
  const snippetLines: string[] = []
  let totalChars = 0
  for (let i = start; i < end; i++) {
    const rawLine = contentLines[i]!.replace(/\r$/, "")
    const formatted = `  ${i + 1}: ${rawLine.length > 120 ? `${rawLine.slice(0, 119)}…` : rawLine}`
    if (totalChars + formatted.length + 1 > 550 && snippetLines.length > 0) break
    snippetLines.push(formatted)
    totalChars += formatted.length + 1
  }
  const offset = Math.max(1, bestIdx - 2)
  return `\nClosest match around line ${bestIdx + 1}:\n${snippetLines.join("\n")}\nTip: call read_file on ${pathLabel} with offset=${offset} to verify the exact current lines.`
}

export const editTool: Tool = {
  name: "edit",
  // v7.33: satu aturan keputusan Yang SAMA di edit/apply_patch/write_file.
  // Sebelumnya tiap deskripsi saling mengarahkan secara melingkar ("prefer edit
  // for small", "prefer apply_patch for multiple", "prefer edit for small"),
  // sehingga model tak punya aturan deterministik saat memilih tool.
  description:
    "FILE EDIT: Replace an exact string with another in one file. 1 change → edit; ≥2 changes in one file → apply_patch; full rewrite/new file → write_file. Every search block must match exactly once — add surrounding lines if ambiguous. Whitespace/indentation mismatch is tolerated (fuzzy). Cannot edit outside the workspace or secrets (.env, .ssh, node_modules). Editing .minicode/ state is ALLOWED by owner decision (2026-11-23) — be careful not to overwrite sessions.db or config; .minicode/hooks/ stays blocked.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace (e.g. src/a.ts)" },
      oldString: {
        type: "string",
        description: "exact existing text to be replaced (must match once)",
      },
      newString: {
        type: "string",
        description: "replacement text (empty string deletes the matched text)",
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  async execute({ path, oldString, newString }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const { root, realAbs, content } = await readSafeTextForEdit(p, ctx)
    const oldS = oldString as string
    const newS = newString as string
    if (oldS === newS) throw new Error("oldString == newString (no change)")
    // Hashline fast path: hanya bila line endings konsisten (CRLF vs LF dijaga flexibleMatch).
    const canHashline = content.includes("\r\n") === oldS.includes("\r\n")
    if (canHashline) {
      const hunk = applyHashline(content, oldS, newS)
      if (hunk !== null) {
        const first = flexibleMatch(content, oldS)
        if (!first)
          throw new Error(`oldString not found in ${p}${buildEditNotFoundHint(content, oldS, p)}`)
        if (isAmbiguousMatch(content, oldS, first)) {
          throw new Error(
            `oldString found multiple times in ${p} — provide more surrounding lines to make it unique`,
          )
        }
        return await commitSafeTextEdit(
          realAbs,
          root,
          hunk,
          `edited ${realAbs} (hashline match) (${oldS.length} → ${newS.length} chars)`,
        )
      }
    }
    const match = flexibleMatch(content, oldS)
    if (!match)
      throw new Error(`oldString not found in ${p}${buildEditNotFoundHint(content, oldS, p)}`)
    if (isAmbiguousMatch(content, oldS, match)) {
      throw new Error(
        `oldString found multiple times in ${p} — provide more surrounding lines to make it unique`,
      )
    }
    const next = content.slice(0, match.start) + newS + content.slice(match.end)
    const note = match.mode !== "exact" ? ` (${match.mode} match)` : ""
    return await commitSafeTextEdit(
      realAbs,
      root,
      next,
      `edited ${realAbs}${note} (${oldS.length} → ${newS.length} chars)`,
    )
  },
}
