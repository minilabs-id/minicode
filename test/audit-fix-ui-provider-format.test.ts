// Audit finding 2: formatArgsPreview harus memotong path/pattern/query seperti
// command/cmd/prompt. Jalur one-shot simple.ts menulis preview ini ke stderr
// tanpa batas, sehingga nilai 500-char dari model/MCP harus dipangkas di sini.

import { expect, test } from "bun:test"
import { formatArgsPreview } from "../src/ui/render/format.ts"

test("path 500 char dipotong ke 60 code point (bukan UTF-16 mentah)", () => {
  const panjang = formatArgsPreview({ path: "a".repeat(500) })
  expect(panjang.length).toBe(60)
  expect(panjang).toBe("a".repeat(60))
})

test("pattern dan query panjang juga dipotong ke 60", () => {
  expect(formatArgsPreview({ pattern: "p".repeat(500) }).length).toBe(60)
  expect(formatArgsPreview({ query: "q".repeat(500) }).length).toBe(60)
})

test("path pendek dan emoji tidak berubah / tak membelah surrogate", () => {
  expect(formatArgsPreview({ path: "src/a.ts" })).toBe("src/a.ts")
  const emoji = "😀".repeat(80)
  const hasil = formatArgsPreview({ path: emoji })
  expect(Array.from(hasil).length).toBe(60)
  expect(hasil.includes("\uFFFD")).toBe(false)
})
