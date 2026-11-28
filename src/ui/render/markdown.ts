// Markdown decoration - Ubuntu Server style.
// Heading -> bold, bullet -> indentasi, code fence -> indentasi + syntax highlight.
// Inline: **bold**, *italic*, `code`, ~~strike~~, [text](url) -> teks accent (no underline).

import { highlightCode } from "./highlight.ts"
import {
  effectiveAssistantMargin,
  formatAssistantSpacing,
  isHorizontalRule,
  parseFence,
} from "./markdown-layout.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "./markdown-table.ts"
import { sanitizeAnsi } from "./sanitize.ts"
import { renderMarkdownTable } from "./table-grid.ts"
import { c, glyphs } from "./theme.ts"

export { type FenceMatch, parseFence } from "./markdown-layout.ts"
export { renderMarkdownTable, renderMarkdownTableLines } from "./table-grid.ts"

// ── Inline markdown -> ANSI ──
// Placeholder C0 internal tidak mungkin hadir sesudah `sanitizeAnsi`; literal
// yang kebetulan masuk lewat pemanggil langsung dibersihkan terlebih dahulu.
const CODE_MARK = String.fromCharCode(0)
const LINK_MARK = String.fromCharCode(1)
const CODE_TOKEN_RE = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g")
const LINK_TOKEN_RE = new RegExp(`${LINK_MARK}(\\d+)${LINK_MARK}`, "g")
const WS_RE = /\s/
const PUNCT_RE = /[\p{P}\p{S}]/u
const MAX_INLINE_DEPTH = 8
const DEFAULT_HR_WIDTH = 20

function isWhitespaceChar(ch: string): boolean {
  return ch !== CODE_MARK && ch !== LINK_MARK && WS_RE.test(ch)
}

function isPunctuationChar(ch: string): boolean {
  return ch !== CODE_MARK && ch !== LINK_MARK && PUNCT_RE.test(ch)
}

/**
 * Ekstrak span inline code (`...`, ``...``, ```...```) dengan aturan jumlah
 * backtick penutup yang persis sama agar kode bersarang terlindungi penuh
 * sebelum parsing tautan maupun penekanan `*`/`_` berjalan.
 */
function extractCodeSpans(text: string): { masked: string; codes: string[] } {
  const codes: string[] = []
  let masked = ""
  let i = 0
  while (i < text.length) {
    if (text[i] !== "`") {
      const nextTick = text.indexOf("`", i)
      if (nextTick < 0) {
        masked += text.slice(i)
        break
      }
      masked += text.slice(i, nextTick)
      i = nextTick
      continue
    }
    let openEnd = i + 1
    while (openEnd < text.length && text[openEnd] === "`") openEnd++
    const openLen = openEnd - i

    let j = openEnd
    let closeStart = -1
    let closeEnd = -1
    while (j < text.length) {
      if (text[j] === "\n" && text[j + 1] === "\n") break
      if (text[j] !== "`") {
        j++
        continue
      }
      let runEnd = j + 1
      while (runEnd < text.length && text[runEnd] === "`") runEnd++
      if (runEnd - j === openLen) {
        closeStart = j
        closeEnd = runEnd
        break
      }
      j = runEnd
    }

    if (closeStart >= 0) {
      let code = text.slice(openEnd, closeStart)
      // CommonMark: buang satu spasi pengapit jika isi non-kosong (mis. `` `a` ``).
      if (
        code.length >= 2 &&
        code.startsWith(" ") &&
        code.endsWith(" ") &&
        code.trim().length > 0
      ) {
        code = code.slice(1, -1)
      }
      const idx = codes.length
      codes.push(code)
      masked += `${CODE_MARK}${idx}${CODE_MARK}`
      i = closeEnd
    } else {
      masked += text.slice(i, openEnd)
      i = openEnd
    }
  }
  return { masked, codes }
}

/**
 * Ganti `[label](url)` menjadi placeholder tautan sebelum delimiter `*`/`_`
 * dipindai, supaya tanda `*`/`_` di dalam URL tidak membocorkan penekanan.
 */
function extractLinks(text: string, links: string[]): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] !== "[") {
      const next = text.indexOf("[", i)
      if (next < 0) {
        out += text.slice(i)
        break
      }
      out += text.slice(i, next)
      i = next
      continue
    }

    let j = i + 1
    let bracketDepth = 1
    let closeBracket = -1
    while (j < text.length) {
      const ch = text[j]!
      if (ch === "\n") break
      if (ch === CODE_MARK) {
        const end = text.indexOf(CODE_MARK, j + 1)
        if (end < 0) break
        j = end + 1
        continue
      }
      if (ch === "[") bracketDepth++
      else if (ch === "]") {
        bracketDepth--
        if (bracketDepth === 0) {
          closeBracket = j
          break
        }
      }
      j++
    }

    if (closeBracket > i + 1 && text[closeBracket + 1] === "(") {
      let k = closeBracket + 2
      let parenDepth = 1
      let closeParen = -1
      while (k < text.length) {
        const ch = text[k]!
        if (ch === "\n") break
        if (ch === CODE_MARK) {
          const end = text.indexOf(CODE_MARK, k + 1)
          if (end < 0) break
          k = end + 1
          continue
        }
        if (ch === "(") parenDepth++
        else if (ch === ")") {
          parenDepth--
          if (parenDepth === 0) {
            closeParen = k
            break
          }
        }
        k++
      }
      if (closeParen >= 0) {
        const idx = links.length
        links.push(text.slice(i + 1, closeBracket))
        out += `${LINK_MARK}${idx}${LINK_MARK}`
        i = closeParen + 1
        continue
      }
    }

    out += "["
    i++
  }
  return out
}

type InlineNode =
  | { kind: "resolved"; text: string }
  | {
      kind: "delim"
      ch: "*" | "_" | "~"
      count: number
      origLen: number
      canOpen: boolean
      canClose: boolean
    }

function tokenizeEmphasis(segment: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let literalStart = 0
  let i = 0

  const flushLiteral = (end: number): void => {
    if (end > literalStart) nodes.push({ kind: "resolved", text: segment.slice(literalStart, end) })
  }

  while (i < segment.length) {
    const ch = segment[i]!
    if (ch === CODE_MARK || ch === LINK_MARK) {
      const end = segment.indexOf(ch, i + 1)
      i = end < 0 ? i + 1 : end + 1
      continue
    }
    if (ch !== "*" && ch !== "_" && ch !== "~") {
      i++
      continue
    }
    let end = i + 1
    while (end < segment.length && segment[end] === ch) end++
    const len = end - i
    if (ch === "~" && len !== 2) {
      i = end
      continue
    }

    const before = i === 0 ? " " : segment[i - 1]!
    const after = end >= segment.length ? " " : segment[end]!
    const wsBefore = isWhitespaceChar(before)
    const wsAfter = isWhitespaceChar(after)
    const punctBefore = isPunctuationChar(before)
    const punctAfter = isPunctuationChar(after)
    const leftFlanking = !wsAfter && (!punctAfter || wsBefore || punctBefore)
    const rightFlanking = !wsBefore && (!punctBefore || wsAfter || punctAfter)
    // CommonMark: `_` intraword tidak memicu italic/bold supaya identifier snake_case aman.
    const canOpen = ch === "_" ? leftFlanking && (!rightFlanking || punctBefore) : leftFlanking
    const canClose = ch === "_" ? rightFlanking && (!leftFlanking || punctAfter) : rightFlanking

    if (!canOpen && !canClose) {
      i = end
      continue
    }

    flushLiteral(i)
    nodes.push({ kind: "delim", ch, count: len, origLen: len, canOpen, canClose })
    i = end
    literalStart = end
  }
  flushLiteral(segment.length)
  return nodes
}

function resolveSegmentTokens(
  nodes: readonly InlineNode[],
  codes: readonly string[],
  links: string[],
  depth: number,
): string {
  let raw = ""
  for (const node of nodes) {
    raw += node.kind === "resolved" ? node.text : node.count > 0 ? node.ch.repeat(node.count) : ""
  }
  if (raw.includes(LINK_MARK) && depth < MAX_INLINE_DEPTH) {
    raw = raw.replace(LINK_TOKEN_RE, (_m, id: string) => {
      const label = links[Number(id)] ?? ""
      const renderedLabel = renderInlineSegment(label, codes, links, depth + 1)
      return paintWithRestore(c.accent, renderedLabel)
    })
  }
  if (raw.includes(CODE_MARK)) {
    raw = raw.replace(CODE_TOKEN_RE, (_m, id: string) => c.brightCyan(codes[Number(id)] ?? ""))
  }
  return raw
}

function renderInlineSegment(
  input: string,
  codes: readonly string[],
  links: string[],
  depth: number,
): string {
  const withLinks = depth < MAX_INLINE_DEPTH ? extractLinks(input, links) : input
  const nodes = tokenizeEmphasis(withLinks)

  // Stack delimiter CommonMark: pasang closer ke opener terdekat dari kanan ke
  // kiri sehingga nested `**... *...* ...**`, `***...***`, dan `~~...~~` tuntas.
  let curr = 0
  while (curr < nodes.length) {
    const closer = nodes[curr]
    if (closer?.kind !== "delim" || !closer.canClose || closer.count <= 0) {
      curr++
      continue
    }

    let openerIdx = -1
    for (let j = curr - 1; j >= 0; j--) {
      const cand = nodes[j]
      if (cand?.kind !== "delim" || !cand.canOpen || cand.count <= 0) continue
      if (cand.ch !== closer.ch) continue
      if (
        closer.ch !== "~" &&
        (cand.canClose || closer.canOpen) &&
        closer.origLen % 3 !== 0 &&
        (cand.origLen + closer.origLen) % 3 === 0
      ) {
        continue
      }
      openerIdx = j
      break
    }

    if (openerIdx < 0) {
      curr++
      continue
    }

    const opener = nodes[openerIdx] as Extract<InlineNode, { kind: "delim" }>
    const use = closer.ch === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1
    const paint = closer.ch === "~" ? c.muted : use === 2 ? c.bold : c.italic
    const innerRaw = resolveSegmentTokens(nodes.slice(openerIdx + 1, curr), codes, links, depth)
    const wrapped = paintWithRestore(paint, innerRaw)
    nodes.splice(openerIdx + 1, curr - openerIdx - 1, { kind: "resolved", text: wrapped })
    curr = openerIdx + 2
    opener.count -= use
    closer.count -= use
    if (closer.count <= 0) curr++
  }

  return resolveSegmentTokens(nodes, codes, links, depth)
}

export function renderInline(text: string): string {
  const safe =
    text.includes(CODE_MARK) || text.includes(LINK_MARK)
      ? text.replaceAll(CODE_MARK, "").replaceAll(LINK_MARK, "")
      : text
  const { masked, codes } = extractCodeSpans(safe)
  const links: string[] = []
  return renderInlineSegment(masked, codes, links, 0)
}

function stripAtxClosingHashes(raw: string): string {
  return raw.replace(/^(.*?\S)[ \t]+#+[ \t]*$/, "$1").replace(/^[ \t]*#+[ \t]*$/, "")
}

/**
 * Renderer baris markdown tunggal di luar code fence dan tabel — dipakai bersama
 * oleh `decorateMarkdown` (printer linier) dan `Transcript.renderAssistantLine`
 * (TUI) supaya heading berindentasi, heading di list/kutipan, dan garis pemisah
 * horizontal tidak pernah meninggalkan `#`/`***` mentah.
 */
export function renderMarkdownContentLine(
  line: string,
  opts: { listIndentCap?: number; hrWidth?: number } = {},
): string {
  if (line.trim() === "") return ""

  if (isHorizontalRule(line)) {
    const w = Math.max(3, Math.min(24, opts.hrWidth ?? DEFAULT_HR_WIDTH))
    return c.dim(glyphs.hLine.repeat(w))
  }

  const heading = /^(\s*)(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    const indent =
      opts.listIndentCap !== undefined ? heading[1]!.slice(0, opts.listIndentCap) : heading[1]!
    const title = stripAtxClosingHashes(heading[3] ?? "")
    return `${indent}${paintMarkdownHeading(heading[2]!.length, renderInline(title))}`
  }

  const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (listItem) {
    const indent =
      opts.listIndentCap !== undefined ? listItem[1]!.slice(0, opts.listIndentCap) : listItem[1]!
    const body = listItem[3] ?? ""
    const subHeading = /^(#{1,6})\s+(.*)$/.exec(body)
    const rendered = subHeading
      ? paintMarkdownHeading(
          subHeading[1]!.length,
          renderInline(stripAtxClosingHashes(subHeading[2] ?? "")),
        )
      : renderInline(body)
    return `${indent}${listItem[2]} ${rendered}`
  }

  const blockquote = /^(\s*(?:>\s*)+)(.*)$/.exec(line)
  if (blockquote) {
    const prefix = blockquote[1] ?? ""
    const body = blockquote[2] ?? ""
    const subHeading = /^(#{1,6})\s+(.*)$/.exec(body)
    if (subHeading) {
      return `${c.accent(prefix)}${paintMarkdownHeading(
        subHeading[1]!.length,
        renderInline(stripAtxClosingHashes(subHeading[2] ?? "")),
      )}`
    }
    return paintMarkdownBlockquote(prefix, renderInline(body))
  }

  return renderInline(line)
}

export function decorateMarkdown(text: string): string {
  // Teks model tak-terpercaya: sanitasi SEKALI di hulu agar fence-content,
  // renderInline, dan highlight tak pernah melihat escape mentah. Urutan ini
  // juga melindungi placeholder `\u0000` (sanitize membuang null model).
  const sanitized = sanitizeAnsi(text)
  const spaced = sanitized.includes("\n") ? formatAssistantSpacing(sanitized) : sanitized
  const lines = spaced.split("\n")
  const cols = process.stdout.columns || 80
  const margin = " ".repeat(effectiveAssistantMargin(cols))
  const tableStarts = new Map<number, MarkdownTable>()
  for (const block of parseMarkdownBlocks(lines.join("\n"))) {
    if (block.type === "table") tableStarts.set(block.startLine, block.table)
  }
  const out: string[] = []
  let inFence = false
  let fenceLang = ""
  let fenceChar = ""
  let fenceLen = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const table = tableStarts.get(lineIndex)
    if (table) {
      if (process.stdout.isTTY)
        out.push(...renderMarkdownTable(table, cols, renderInline).split("\n"))
      else
        for (let tableLine = lineIndex; tableLine <= table.endLine; tableLine++)
          out.push(lines[tableLine]!)
      lineIndex = table.endLine
      continue
    }
    const line = lines[lineIndex]!
    // Code fence handling — catat char & panjang pembuka, hanya tutup bila cocok.
    const fence = parseFence(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence.char
        fenceLen = fence.len
        fenceLang = fence.lang
        // Bar yang sama dengan isi blok: `· ts` terbaca seperti poin daftar.
        // Renderer flat: tanpa header bahasa — blok kode cukup indentasi.
      } else {
        if (fence.char === fenceChar && fence.len >= fenceLen) {
          inFence = false
          fenceChar = ""
          fenceLen = 0
          fenceLang = ""
        } else {
          // fence di dalam fence dengan char/len berbeda → anggap konten
          out.push(`${margin}  ${fenceLang ? highlightCode(line, fenceLang) : line}`)
          continue
        }
      }
      continue
    }

    // Di DALAM fence: isi kode tidak boleh disentuh markdown.
    //
    // Sebelumnya hanya fence BERBAHASA yang dilindungi (`if (inFence && fenceLang)`),
    // sehingga fence tanpa bahasa jatuh ke renderInline di bawah dan
    // `npm run build -- --flag=*value*` kehilangan bintangnya karena dianggap
    // italic. Fence tanpa bahasa justru bentuk paling umum untuk perintah shell.
    if (inFence) {
      if (line.trim() === "") {
        out.push("")
        continue
      }
      out.push(`${margin}  ${fenceLang ? highlightCode(line, fenceLang) : line}`)
      continue
    }

    if (line.trim() === "") {
      out.push("")
      continue
    }

    // v0.33: heading mengikuti TUI — tanda `#` DIBUANG dan isi memakai
    // renderInline, supaya tidak ada artefak markdown mentah di jawaban.
    // Dua baris kosong sebelum bab juga disamakan dengan formatAssistantSpacing.
    const heading = /^\s*(#{1,6})\s/.exec(line)
    if (heading && heading[1]!.length <= 3 && out.length > 0) {
      let blanks = 0
      for (let i = out.length - 1; i >= 0 && out[i] === ""; i--) blanks++
      for (let i = blanks; i < 2; i++) out.push("")
    }

    const hrWidth = Math.max(3, Math.min(24, cols - margin.length))
    out.push(`${margin}${renderMarkdownContentLine(line, { listIndentCap: 16, hrWidth })}`)
  }
  return out.join("\n")
}

/** Terapkan pembungkus ANSI dan pulihkan atribut/warnanya sesudah SGR penutup di isi. */
function paintWithRestore(paint: (s: string) => string, s: string): string {
  const [open, close] = paint(CODE_MARK).split(CODE_MARK)
  if (!open || !close) return paint(s)
  if (!s.includes("\x1b[")) return `${open}${s}${close}`
  const resetsFg = close === "\x1b[39m" || close.includes(";39m")
  const resetsIntensity = close === "\x1b[22m" || close.includes("22;") || close.includes(";22m")
  const resetsItalic = close === "\x1b[23m" || close.includes("23")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deteksi SGR penutup di teks berdekorasi
  const body = s.replace(/\x1b\[[0-9;]*m/g, (seq) => {
    if (seq === close || seq === "\x1b[0m") return `${seq}${open}`
    const params = seq.slice(2, -1).split(";")
    if (
      (resetsFg && params.includes("39")) ||
      (resetsIntensity && params.includes("22")) ||
      (resetsItalic && params.includes("23"))
    ) {
      return `${seq}${open}`
    }
    return seq
  })
  return `${open}${body}${close}`
}

/** Pewarnaan heading markdown terpusat tanpa artefak `#` agar hierarki TUI & non-TUI seragam. */
export function paintMarkdownHeading(level: number, renderedText: string): string {
  // # = accent bold, ## = info bold (terang), ### = bold polos, ####+ = thinking bold agar sub-bab tetap jelas terbaca.
  if (level <= 1) return paintWithRestore(c.accentBold, renderedText)
  if (level === 2) return paintWithRestore(c.bold, paintWithRestore(c.info, renderedText))
  if (level === 3) return paintWithRestore(c.bold, renderedText)
  return paintWithRestore(c.thinking, paintWithRestore(c.bold, renderedText))
}

/** Pewarnaan kutipan markdown agar prefix `>` beraksen dan isi kutipan bernuansa redup lembut. */
export function paintMarkdownBlockquote(prefix: string, renderedBody: string): string {
  if (!prefix && !renderedBody) return ""
  return `${c.accent(prefix)}${renderedBody ? c.thinking(renderedBody) : ""}`
}
