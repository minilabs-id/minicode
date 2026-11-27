import { expect, test } from "bun:test"
import { highlightCode } from "../src/ui/render/highlight.ts"
import { highlightMatch } from "../src/ui/render/list.ts"
import {
  decorateMarkdown,
  paintMarkdownBlockquote,
  paintMarkdownHeading,
} from "../src/ui/render/markdown.ts"
import { c, glyphs, section, stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"

function withTruecolorTty<T>(fn: () => T): T {
  const prevIsTty = process.stdout.isTTY
  const prevColorterm = process.env.COLORTERM
  const prevNoColor = process.env.NO_COLOR
  const prevMinicodeColor = process.env.MINICODE_COLOR
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR
  delete process.env.MINICODE_COLOR
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: prevIsTty, configurable: true })
    if (prevColorterm === undefined) delete process.env.COLORTERM
    else process.env.COLORTERM = prevColorterm
    if (prevNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNoColor
    if (prevMinicodeColor === undefined) delete process.env.MINICODE_COLOR
    else process.env.MINICODE_COLOR = prevMinicodeColor
  }
}

test("theme: stripAnsi removes escape codes cleanly", () => {
  const colored = c.info(c.bold("hello world"))
  expect(stripAnsi(colored)).toBe("hello world")
})

test("theme: glyphs contain valid characters", () => {
  expect(glyphs.check).toBeDefined()
  expect(glyphs.cross).toBeDefined()
})

test("highlight: TypeScript keywords and strings", () => {
  const code = `const greeting = "hello";\nfunction test() { return 42; }`
  const highlighted = highlightCode(code, "typescript")
  // Content must be preserved exactly (colors may be stripped in non-TTY)
  expect(stripAnsi(highlighted)).toBe(code)
})

test("highlight: Python code and comments", () => {
  const code = `def calculate():\n    # inline comment\n    return 100`
  const highlighted = highlightCode(code, "python")
  expect(stripAnsi(highlighted)).toBe(code)
})

test("highlight: JSON strings, keys and numbers", () => {
  const code = `{\n  "name": "minicode",\n  "version": 1,\n  "active": true\n}`
  const highlighted = highlightCode(code, "json")
  expect(stripAnsi(highlighted)).toBe(code)
})

test("markdown: decorates code fences with indentation", () => {
  const md = "intro\n```typescript\nconst x = 1;\n```\noutro"
  const out = decorateMarkdown(md)
  expect(out).not.toContain("```")
  // Sibling test di atas selalu stripAnsi dulu: warna aktif/nonaktif
  // tergantung terminal (gagal di env truecolor — ditemukan saat run WSL).
  expect(stripAnsi(out)).toContain("const x = 1;")
})

test("markdown: plain text without fences gets outer left margin", () => {
  expect(decorateMarkdown("just text")).toBe("   just text")
})

test("theme: section separator uses display width for CJK/emoji", () => {
  const orig = process.stdout.columns
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true })
  const line = stripAnsi(section("状态😀"))
  expect(displayWidth(line)).toBeGreaterThanOrEqual(40)
  Object.defineProperty(process.stdout, "columns", { value: orig, configurable: true })
})

test("theme: section() sanitasi judul tak-terpercaya satu-baris (F-04)", () => {
  const line = stripAnsi(section("a\nb\x1b[2Jc"))
  expect(line).not.toContain("\n")
  expect(line).not.toContain("\x1b[2J")
  expect(line).toContain("a b")
})

test("markdown: escape model dibuang di hulu (F-04)", () => {
  const out = decorateMarkdown("halo\x1b[2Jdunia\n```ts\nkode\x1b[?1049hx\n```")
  expect(out).not.toContain("\x1b[2J")
  expect(out).not.toContain("?1049h")
  expect(stripAnsi(out)).toContain("halodunia")
})

test("markdown: hierarki H1-H4, tautan non-bold, dan kutipan memakai warna berbeda", () => {
  withTruecolorTty(() => {
    const h1 = paintMarkdownHeading(1, "Bab")
    const h2 = paintMarkdownHeading(2, "Sub")
    const h3 = paintMarkdownHeading(3, "Poin")
    const h4 = paintMarkdownHeading(4, "Detail")
    expect(h1).toBe(c.accentBold("Bab"))
    expect(h2).toBe(c.bold(c.info("Sub")))
    expect(h3).toBe(c.bold("Poin"))
    expect(h4).toBe(c.thinking(c.bold("Detail")))
    expect(new Set([h1, h2, h3, h4]).size).toBe(4)

    const mdLink = decorateMarkdown("Baca [docs](https://example.com) dulu")
    expect(mdLink).toContain(c.accent("docs"))
    expect(mdLink).not.toContain("\x1b[1;")
    expect(stripAnsi(mdLink)).toBe("   Baca docs dulu")

    const quote = paintMarkdownBlockquote("> ", "catatan")
    expect(quote).toBe(`${c.accent("> ")}${c.thinking("catatan")}`)
    const mdQuote = decorateMarkdown("> catatan")
    expect(mdQuote).toContain(quote)
    expect(stripAnsi(mdQuote)).toBe("   > catatan")
  })
})

test("highlightCode: JSON bool/null terpisah dari angka dan flag shell memakai info", () => {
  withTruecolorTty(() => {
    const json = '{"ok": true, "n": 42}'
    const hlJson = highlightCode(json, "json")
    expect(hlJson).toContain(c.brightMagenta("true"))
    expect(hlJson).toContain(c.brightYellow("42"))
    expect(stripAnsi(hlJson)).toBe(json)

    const sh = "bun test --watch"
    const hlSh = highlightCode(sh, "sh")
    expect(hlSh).toContain(c.info("--watch"))
    expect(hlSh).not.toContain(c.yellow("--watch"))
    expect(stripAnsi(hlSh)).toBe(sh)
  })
})

test("list highlightMatch: kecocokan baris tak terpilih tetap terbaca tanpa c.dim", () => {
  withTruecolorTty(() => {
    const row = highlightMatch("theme-dark", "dark", false)
    expect(row).toContain(c.info("dark"))
    expect(row).not.toContain(c.dim(c.info("dark")))
    expect(stripAnsi(row).trim()).toBe("theme-dark")
  })
})
