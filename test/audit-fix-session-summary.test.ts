// v7.44 (audit) — helper murni untuk cap sesi, bar progres, dan blok penutup.
// Semua hermetik: tanpa TTY/SQLite/provider; logo diambil dari grid asli
// `renderLogoRows()` supaya test tak pernah memakai contoh gambar tangan yang
// bisa beda dari apa yang benar-benar dirender.

import { expect, test } from "bun:test"
import { renderLogoRows } from "../src/ui/render/logo.ts"
import {
  buildClosingBlock,
  buildProgressLine,
  buildSessionStamp,
  progressPercent,
  type SessionSummaryInfo,
} from "../src/ui/tui/session-summary.ts"

const base: SessionSummaryInfo = {
  stamp: "minicode19112026131130",
  turns: 4,
  tools: 18,
  files: 3,
  other: 9,
  tokens: 12_555,
  cost: 4.65,
  duration: 18 * 60_000 + 23_000,
  version: "0.31.1",
}

test("buildSessionStamp: cap WAKTU PENUTUPAN lokal, dua digit, empat digit tahun", () => {
  expect(buildSessionStamp(new Date(2026, 10, 19, 13, 11, 30))).toBe("minicode19112026131130")
  expect(buildSessionStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("minicode02012026030405")
  expect(buildSessionStamp(new Date(1999, 11, 31, 23, 59, 59))).toBe("minicode31121999235959")
})

test("buildProgressLine: prefix start/update dan clamp 0..100", () => {
  expect(buildProgressLine("start", 57)).toBe("start 57%")
  expect(buildProgressLine("update", 57)).toBe("update 57%")
  expect(buildProgressLine("start", -5)).toBe("start 0%")
  expect(buildProgressLine("start", 150)).toBe("start 100%")
  expect(buildProgressLine("update", 55.6)).toBe("update 56%")
})

test("progressPercent: fase 5 dari 9 = 55%, deret bersih, clamp", () => {
  expect(progressPercent(5, 9)).toBe(55)
  expect(progressPercent(1, 9)).toBe(11)
  expect(progressPercent(8, 9)).toBe(88)
  expect(progressPercent(9, 9)).toBe(100)
  expect(progressPercent(12, 9)).toBe(100)
  expect(progressPercent(0, 9)).toBe(0)
  expect(progressPercent(1, 0)).toBe(0)
})

test("buildClosingBlock: baris persis, logo asli, rata kiri", () => {
  const logo = renderLogoRows()
  expect(logo.length).toBe(5)
  const lines = buildClosingBlock(logo, base)
  expect(lines).toEqual([
    ...logo,
    "",
    "Minicode",
    "Session : minicode19112026131130",
    "4 turn   18 tool   3 file   9 other",
    "12.555 tok   $4.65   18m23s",
    "version 0.31.1",
  ])
  // Semua baris logo dipakai apa adanya — tak ada center/indentasi.
  expect(lines.slice(0, logo.length)).toEqual(logo)
})

test("buildClosingBlock: biaya tak tersedia = $—, angka tak tersedia = 0 (jujur)", () => {
  const lines = buildClosingBlock(["<logo>"], {
    ...base,
    turns: 0,
    tools: 0,
    files: 0,
    other: 0,
    tokens: 0,
    cost: null,
    duration: 0,
    version: "?",
  })
  expect(lines).toContain("<logo>")
  expect(lines).toContain("Session : minicode19112026131130")
  expect(lines).toContain("0 turn   0 tool   0 file   0 other")
  expect(lines).toContain("0 tok   $—   0m0s")
  expect(lines).toContain("version ?")
})
