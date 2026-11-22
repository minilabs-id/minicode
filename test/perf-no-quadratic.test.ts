// v0.33 (audit sesi 91681815): pengaman REGRESI untuk pola O(n²) pada buffer
// streaming. Test ini memindai SUMBER (seperti writer-inventory / ui-boundary
// tests di repo ini) — bukan mengukur waktu, yang bisa flake di CI.
// Test yang memindai sidebar-model.ts dihapus bersama sidebar (v0.34).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

test("accumulator streaming lain punya batas atau inkremental", () => {
  const transcript = read("src/ui/tui/transcript.ts")
  // pending text dibatasi maxPendingChars; thinkingTail dipecah per newline.
  expect(transcript).toMatch(/remaining|maxPendingChars/)
  const simple = read("src/ui/assistant/simple.ts")
  expect(simple).toMatch(/ANSWER_BUF_MAX|THINKING_BUF_MAX/)
  const task = read("src/tools/task.ts")
  // findingLineBuffer dipop per newline → hanya menyimpan baris incomplete.
  expect(task).toMatch(/findingLineBuffer = parts\.pop\(\)/)
})

test("transcript: viewport tak lagi memanggil projectAll penuh per frame", () => {
  const src = read("src/ui/tui/transcript.ts")
  // Struktural: cache proyeksi sekarang multi-lebar & inkremental.
  expect(src).toContain("committedByWidth")
  expect(src).toContain("projectedBaseByWidth")
  expect(src).toContain("interface WidthProjection")
  expect(src).toContain("applyAppend")
  expect(src).toContain("applyEvict")
  // `viewport()` HARUS mengambil slice dari `proj.rows`, bukan projectAll().
  const viewport = src.slice(
    src.indexOf("viewport(width: number"),
    src.indexOf("view(width: number"),
  )
  expect(viewport).not.toContain("projectAll(")
  expect(viewport).toContain("proj.rows.slice(")
})

test("instrumentasi: 5000 baris × 120 frame tidak menambah rebuild proyeksi", () => {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  for (let i = 0; i < 5000; i++) {
    bus.emit("provider:text", { text: `baris-${i}\n` })
    bus.emit("turn:completed", {})
  }
  // Cold build satu kali untuk lebar ini.
  expect(t.wrappedLength(120)).toBeGreaterThan(0)
  const baseline = t.projectionRebuilds
  for (let frame = 0; frame < 120; frame++) {
    t.viewport(120, 36, frame)
    t.wrappedLength(120)
  }
  expect(t.projectionRebuilds - baseline).toBe(0)
})
