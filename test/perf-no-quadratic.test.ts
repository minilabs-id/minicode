// v0.33 (audit sesi 91681815): pengaman REGRESI untuk pola O(n²) pada buffer
// streaming. Test ini memindai SUMBER (seperti writer-inventory / ui-boundary
// tests di repo ini) — bukan mengukur waktu, yang bisa flake di CI.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

test("SidebarModel.ingestThinking TIDAK mengArray.from seluruh buffer tiap chunk", () => {
  const src = read("src/ui/render/sidebar-model.ts")
  // Pola lama: `Array.from(this.thinkingRaw + text)` → array 200k tiap delta.
  expect(src).not.toMatch(/Array\.from\(this\.thinkingRaw\s*\+\s*text\)/)
  // Harus ada hitungan inkremental + konversi hanya saat memangkas.
  expect(src).toContain("thinkingCodePoints")
  expect(src).toMatch(/Array\.from\(chunk\)/)
})

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
