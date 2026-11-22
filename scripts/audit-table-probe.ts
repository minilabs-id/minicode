// probe audit TABEL — mengukur biaya render + menangkap output nyata.
// Jalankan: bun run scripts/audit-table-probe.ts

import { parseMarkdownBlocks } from "../src/ui/render/markdown-table.ts"
import { stripSgr } from "../src/ui/render/sanitize.ts"
import { renderMarkdownTable } from "../src/ui/render/table-grid.ts"
import { displayWidth } from "../src/ui/render/width.ts"

/** alias lokal: lebar teks setelah SGR dibuang */
const stripSgrWidth = (s: string): string => stripSgr(s)

import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "../test/helpers/tui-harness.ts"

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i] ?? 0
}
const r3 = (n: number) => Math.round(n * 1000) / 1000

function measure(name: string, iters: number, fn: () => void): void {
  for (let i = 0; i < Math.min(3, iters); i++) fn()
  const times: number[] = []
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(
    `${name.padEnd(46)}p50 ${r3(pct(times, 50)).toFixed(3).padStart(8)}ms  p95 ${r3(pct(times, 95)).toFixed(3).padStart(8)}ms  max ${r3(
      times[times.length - 1] ?? 0,
    )
      .toFixed(3)
      .padStart(8)}ms`,
  )
}

// ── Data uji ────────────────────────────────────────────────────────────────
function mdTable(headers: string[], rows: string[][], aligns?: string[]): string {
  const sep = headers.map((_, i) => (aligns?.[i] === "right" ? "---:" : "---")).join(" | ")
  return [
    `| ${headers.join(" | ")} |`,
    `| ${sep} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n")
}

const small = mdTable(
  ["Name", "Type", "Default"],
  [
    ["`model`", "string", "deepseek-v4.1"],
    ["`maxTokens`", "number", "8192"],
  ],
)

const medium = mdTable(
  ["File", "Baris", "Perubahan"],
  Array.from({ length: 12 }, (_, i) => [
    `src/ui/tui/app-${i}.ts`,
    String(100 + i),
    "Menambahkan guard saat kolom chat menyempit",
  ]),
)

const wide = mdTable(
  ["Lokasi", "Masalah", "Dampak", "Saran"],
  [
    [
      "`src/ui/tui/transcript.ts:1731`",
      "wrappedLength memakai lebar terminal pada jalur navigasi sehingga cache proyeksi satu-slot selalu meleset",
      "frame 300–850 ms di terminal lebar",
      "pakai chatCols konsisten",
    ],
    [
      "https://contoh.example.com/docs/very/long/path/without/any/spaces/at/all/really",
      "URL panjang tanpa spasi",
      "kolom meluber",
      "ellipsis, jangan pecah token",
    ],
  ],
)

const cjk = mdTable(
  ["串", "説明", "🚀"],
  [
    ["中文测试", "データベース接続の設定についての長い説明", "✅"],
    ["漢字", "テスト", "🚀🚀"],
  ],
)

const long = mdTable(
  ["id", "payload"],
  Array.from({ length: 60 }, (_, i) => [`row-${i}`, `payload-${i}-${"x".repeat(30)}`]),
)

const single = mdTable(["only"], [["value"]])

// ── 1. Biaya render ─────────────────────────────────────────────────────────
function benchRender(): void {
  console.log("== biaya renderMarkdownTable(width, table) ==")
  const cases: Array<[string, string]> = [
    ["kecil 2 baris × 3 kolom", small],
    ["sedang 12 baris × 3 kolom (sel prosa)", medium],
    ["lebar 2 baris × 4 kolom (prosa panjang)", wide],
    ["CJK+emoji 2 baris × 3 kolom", cjk],
    ["besar 60 baris × 2 kolom", long],
  ]
  for (const width of [120, 81, 60, 40, 30]) {
    for (const [name, md] of cases) {
      const block = parseMarkdownBlocks(md).find((b) => b.type === "table")
      if (block?.type !== "table") {
        console.log(`${name}: tidak ter-parse sebagai tabel`)
        continue
      }
      measure(`  w=${width} ${name}`, 200, () => void renderMarkdownTable(block.table, width))
    }
  }
}

// ── 2. Biaya proyeksi lewat Transcript (jalur frame nyata) ──────────────────
function benchProjection(): void {
  console.log("\n== biaya proyeksi tabel via Transcript.projectTable (jalur frame) ==")
  for (const width of [120, 81, 80]) {
    for (const [name, md] of [
      ["sedang", medium],
      ["besar 60×2", long],
    ] as Array<[string, string]>) {
      const t = new Transcript(createFakeBus() as never)
      t.push(md, { kind: "assistant" })
      measure(`  w=${width} ${name}: wrappedLength`, 60, () => void t.wrappedLength(width))
      // proyeksi ULANG (cache dibuang lewat width bergantian)
      measure(`  w=${width} ${name}: wrappedLength bergantian`, 60, () => {
        void t.wrappedLength(width === 120 ? 81 : 120)
        void t.wrappedLength(width)
      })
    }
  }
}

// ── 3. Invariant geometri ───────────────────────────────────────────────────
function checkGeometry(): void {
  console.log("\n== invariant lebar: setiap baris harus ≤ width ==")
  const cases: Array<[string, string]> = [
    ["kecil", small],
    ["sedang", medium],
    ["lebar", wide],
    ["CJK", cjk],
    ["satu kolom", single],
  ]
  for (const width of [120, 81, 60, 50, 40, 35, 30, 24, 16]) {
    for (const [name, md] of cases) {
      const block = parseMarkdownBlocks(md).find((b) => b.type === "table")
      if (block?.type !== "table") continue
      const out = renderMarkdownTable(block.table, width)
      const lines = out.split("\n")
      const widths = lines.map((l) => displayWidth(stripSgrWidth(l)))
      const maxW = Math.max(...widths)
      const over = maxW > width
      console.log(
        `  w=${String(width).padStart(3)} ${name.padEnd(11)} baris=${String(lines.length).padStart(3)} lebar maks=${String(maxW).padStart(3)} ${over ? "OVERFLOW ✗" : "ok"}`,
      )
    }
  }
}

// ── 3b. Biaya STREAMING tabel (pending, memo per baris TIDAK berlaku) ───────
function benchStreaming(): void {
  console.log("\n== biaya streaming tabel: biaya per delta saat tabel tumbuh ==")
  const rowsN = 12
  const text = medium
  const t = new Transcript(createFakeBus() as never)
  const deltas = text.match(/[\s\S]{1,8}/g) ?? []
  // biarkan state pending, jangan commit: tiap delta menaikkan pendingVersion
  for (const d of deltas.slice(0, 3)) t.stream(d)
  const times: number[] = []
  for (const d of deltas.slice(3)) {
    const t0 = performance.now()
    t.stream(d)
    void t.wrappedLength(81)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(
    `  tabel ${rowsN} baris, ${deltas.length} delta: p50 ${r3(pct(times, 50)).toFixed(3)} ms  p95 ${r3(pct(times, 95)).toFixed(3)} ms  total ${r3(times.reduce((a, b) => a + b, 0)).toFixed(1)} ms`,
  )

  const t2 = new Transcript(createFakeBus() as never)
  const d2 = long.match(/[\s\S]{1,8}/g) ?? []
  for (const d of d2.slice(0, 3)) t2.stream(d)
  const times2: number[] = []
  for (const d of d2.slice(3)) {
    const t0 = performance.now()
    t2.stream(d)
    void t2.wrappedLength(81)
    times2.push(performance.now() - t0)
  }
  times2.sort((a, b) => a - b)
  console.log(
    `  tabel 60 baris, ${d2.length} delta: p50 ${r3(pct(times2, 50)).toFixed(3)} ms  p95 ${r3(pct(times2, 95)).toFixed(3)} ms  total ${r3(times2.reduce((a, b) => a + b, 0)).toFixed(1)} ms`,
  )
}

// ── 3c. Lebar dihitung SEBELUM formatCell (backtick/link) ───────────────────
function checkFormatWidth(): void {
  console.log("\n== lebar kolom dihitung dari teks MENTAH (backtick/link belum didekorasi) ==")
  const md = mdTable(
    ["Kolom kode", "Link"],
    [
      ["`a`", "[docs](https://example.com/x)"],
      ["`b`", "[home](https://example.com/y)"],
    ],
  )
  const block = parseMarkdownBlocks(md).find((b) => b.type === "table")
  if (block?.type !== "table") return
  const plain = renderMarkdownTable(block.table, 81)
  const decorated = renderMarkdownTable(block.table, 81, (v) =>
    v.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1"),
  )
  const w = (out: string) => Math.max(...out.split("\n").map((l) => displayWidth(stripSgr(l))))
  console.log(`  tanpa formatCell : lebar tabel = ${w(plain)}`)
  console.log(
    `  dengan formatCell: lebar tabel = ${w(decorated)}  (kolom yang sama, isi lebih pendek)`,
  )
  for (const line of decorated.split("\n")) console.log(`  |${stripSgr(line)}|`)
}

// ── 4. Tangkapan visual ─────────────────────────────────────────────────────
function show(md: string, widths: number[]): void {
  const block = parseMarkdownBlocks(md).find((b) => b.type === "table")
  if (block?.type !== "table") return
  for (const w of widths) {
    console.log(`\n----- width=${w} -----`)
    const out = renderMarkdownTable(block.table, w)
    for (const line of out.split("\n")) {
      console.log(`|${stripSgrWidth(line)}|  (${displayWidth(stripSgrWidth(line))})`)
    }
  }
}

benchRender()
benchProjection()
checkGeometry()
benchStreaming()
checkFormatWidth()

console.log("\n== TANGKAPAN: tabel kecil pada 120 / 81 / 40 / 30 kolom ==")
show(small, [120, 81, 40, 30])

console.log("\n== TANGKAPAN: tabel 4 kolom prosa panjang pada 120 / 81 kolom ==")
show(wide, [120, 81])

console.log("\n== TANGKAPAN: tabel 3 kolom pada 81 / 45 kolom (sel prosa) ==")
show(medium, [81, 45])

console.log("\n== TANGKAPAN: CJK + emoji pada 81 / 40 kolom ==")
show(cjk, [81, 40])

console.log("\n== TANGKAPAN: tabel 4 kolom pada 30 kolom (jalur VERTIKAL) ==")
show(wide, [30])
