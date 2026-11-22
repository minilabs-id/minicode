// Instrumentasi performa (audit F-02/F-03/F-04, 2026-11-22).
// Flag `MINICODE_DEBUG_PERF` dibaca SEKALI saat modul diimpor, jadi untuk
// menguji dua kondisi kita memakai dynamic import dengan query berbeda —
// Bun memperlakukan tiap query sebagai instance modul baru.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

type PerfModule = typeof import("../src/lib/perf-debug.ts")

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

let saved: string | undefined
let seq = 0

beforeEach(() => {
  saved = process.env.MINICODE_DEBUG_PERF
})

afterEach(() => {
  if (saved === undefined) delete process.env.MINICODE_DEBUG_PERF
  else process.env.MINICODE_DEBUG_PERF = saved
})

async function loadPerf(active: boolean): Promise<PerfModule> {
  process.env.MINICODE_DEBUG_PERF = active ? "1" : "0"
  seq++
  return await import(`../src/lib/perf-debug.ts?perf-test=${seq}`)
}

test("(a) env aktif: perfCount mengumpulkan sampel & perfReport berisi nama/count", async () => {
  const perf = await loadPerf(true)
  expect(perf.perfEnabled()).toBe(true)
  perf.perfReset()
  perf.perfCount("alpha", 1.5, 7)
  perf.perfCount("alpha", 2.5, 9)
  perf.perfCount("beta", 10, 0)
  const snap = perf.perfSnapshot()
  expect(snap.alpha?.count).toBe(2)
  expect(snap.alpha?.totalMs).toBe(4)
  expect(snap.alpha?.maxMs).toBe(2.5)
  expect(snap.alpha?.lastN).toBe(9)
  expect(snap.beta?.count).toBe(1)
  const report = perf.perfReport()
  expect(report).toContain("alpha")
  expect(report).toContain("count=2")
  expect(report).toContain("beta")
  expect(report).toContain("p50=")
  expect(report).toContain("p95=")
  expect(report).not.toContain("NaN")
  perf.perfReset()
  expect(perf.perfSnapshot()).toEqual({})
})

test("(a2) env aktif: ring buffer membatasi sampel, agregat tetap deterministik", async () => {
  const perf = await loadPerf(true)
  perf.perfReset()
  for (let i = 1; i <= 300; i++) perf.perfCount("ring", i)
  const snap = perf.perfSnapshot()
  expect(snap.ring?.count).toBe(300)
  expect(snap.ring?.maxMs).toBe(300)
  const report = perf.perfReport()
  expect(report).toMatch(/ring count=300/)
  expect(report).not.toContain("NaN")
  perf.perfReset()
})

test("(b) tanpa env: no-op & perfSnapshot kosong", async () => {
  const perf = await loadPerf(false)
  expect(perf.perfEnabled()).toBe(false)
  expect(Object.keys(perf.perfSnapshot()).length).toBe(0)
  perf.perfCount("ghost", 100, 5)
  expect(perf.perfSnapshot()).toEqual({})
  expect(perf.perfReport()).toContain("no samples")
})

test("(c) persistensi: tiap fungsi yang di-instrumentasi tetap satu transaksi & SQL utuh", () => {
  const src = read("src/session/persistence.ts")

  const fn = (name: string): string => {
    const start = src.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    // Fungsi-fungsi ini diakhiri baris `}` di kolom 0 sebelum komentar berikutnya.
    const end = src.indexOf("\n}\n", start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  // Timer membungkus fungsi, TIDAK menambah transaksi: satu `db.transaction`
  // per fungsi, seperti sebelum instrumentasi.
  const cases: { name: string; sql: string[] }[] = [
    {
      name: "appendPresentationEvents",
      sql: ["INSERT OR IGNORE INTO presentation_events"],
    },
    { name: "saveSession", sql: ["INSERT INTO sessions", "INSERT INTO messages"] },
    {
      name: "shrinkThreadHistory",
      sql: ["DELETE FROM messages", "INSERT INTO messages"],
    },
  ]
  for (const { name, sql } of cases) {
    const body = fn(name)
    expect((body.match(/db\.transaction\(/g) ?? []).length).toBe(1)
    for (const stmt of sql) expect(body).toContain(stmt)
  }
})
