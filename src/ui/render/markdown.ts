// Markdown decoration - Ubuntu Server style.
// Heading -> bold, bullet -> indentasi, code fence -> indentasi + syntax highlight.
// Inline: **bold**, *italic*, `code`, ~~strike~~, [text](url) -> teks accent (no underline).

import { highlightCode } from "./highlight.ts"
import { effectiveAssistantMargin, formatAssistantSpacing, parseFence } from "./markdown-layout.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "./markdown-table.ts"
import { sanitizeAnsi } from "./sanitize.ts"
import { renderMarkdownTable } from "./table-grid.ts"
import { c, glyphs } from "./theme.ts"

export { type FenceMatch, parseFence } from "./markdown-layout.ts"
export { renderMarkdownTable, renderMarkdownTableLines } from "./table-grid.ts"

// ── Inline markdown -> ANSI ──
// Urutan replace lama: `code` diganti dulu jadi `c.brightCyan(...)`, lalu
// regex **bold** masih menemukan `**` DI DALAM hasil cyan → `` `**a**` ``
// menjadi bold+cyan ganda. Isi inline code tidak boleh di-dekorasi lagi.
const CODE_PLACEHOLDER = "\u0000"
export function renderInline(text: string): string {
  // Simpan isi `code` dulu, restore TERAKHIR supaya bold/italic/strike tidak
  // menyentuhnya. Placeholder ASCII-null tidak mungkin muncul di teks model
  // (sanitizeAnsi membuang semua C0 termasuk null).
  const codes: string[] = []
  let t = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return CODE_PLACEHOLDER
  })
  // [text](url) -> accent bold text (url hidden, no underline - terminal can't click)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string) => c.accent(c.bold(label)))
  // **bold**
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => c.bold(bold))
  // *italic*
  t = t.replace(
    /(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g,
    (_m, pre: string, ital: string) => `${pre}${c.italic(ital)}`,
  )
  // __bold__
  t = t.replace(/__([^_]+)__/g, (_m, bold: string) => c.bold(bold))
  // ~~strike~~
  t = t.replace(/~~([^~]+)~~/g, (_m, del: string) => c.muted(del))
  // Restore code blocks (bisa memuat * _ ~ ` → lindungi dari regex di atas).
  let ci = 0
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder internal (ASCII null)
  return t.replace(/\u0000/g, () => c.brightCyan(codes[ci++] ?? ""))
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
        if (fenceLang) out.push(`${margin}${c.dim(`${glyphs.vLine} ${fenceLang}`)}`)
      } else {
        if (fence.char === fenceChar && fence.len >= fenceLen) {
          inFence = false
          fenceChar = ""
          fenceLen = 0
          fenceLang = ""
        } else {
          // fence di dalam fence dengan char/len berbeda → anggap konten
          const bar = fenceLang ? c.dim(glyphs.vLine) : glyphs.vLine
          out.push(`${margin}${bar} ${fenceLang ? highlightCode(line, fenceLang) : line}`)
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
      const bar = fenceLang ? c.dim(glyphs.vLine) : glyphs.vLine
      out.push(`${margin}${bar} ${fenceLang ? highlightCode(line, fenceLang) : line}`)
      continue
    }

    if (line.trim() === "") {
      out.push("")
      continue
    }

    // Headings (# .. ######) -> bold dengan margin area teks.
    if (/^#{1,6}\s/.test(line)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("")
      out.push(`${margin}${c.bold(line)}`)
      continue
    }

    // Daftar (bullet `-`/`*`/`+` atau bernomor `1.`/`2)`) — pertahankan indentasi
    // sumber bersarang relatif di atas margin terluar agar sub-item tetap sejajar
    // tepat di bawah teks induknya saat di-wrap.
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listItem) {
      const sourceIndent = listItem[1]!.slice(0, 16)
      out.push(`${margin}${sourceIndent}${listItem[2]} ${renderInline(listItem[3] ?? "")}`)
      continue
    }

    // Kutipan (`> `) atau paragraf biasa / berindentasi multi-tingkat.
    const blockquote = /^(\s*(?:>\s*)+)(.*)$/.exec(line)
    if (blockquote) {
      out.push(`${margin}${blockquote[1]}${renderInline(blockquote[2] ?? "")}`)
      continue
    }

    out.push(`${margin}${renderInline(line)}`)
  }
  return out.join("\n")
}
