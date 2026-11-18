// Reklasifikasi 400 generik → context overflow.
//
// Regresi nyata (sesi `1bfbcc50`): gateway membalas 400 biasa, tetapi karena
// estimasi lokal ≥ 50k token, minicode menganggapnya konteks kepanjangan:
// jendela dinaikkan 1M→2M ("observed 525754"), kompaksi dipaksa, dan
// diagnostiknya menulis "input 334644 + 0 exceeds 2097152" — angka yang
// mustahil. Test ini mengunci syarat barunya: butuh BUKTI (teks provider
// menyebut konteks, atau estimasi sudah melewati titik kompaksi).

import { expect, test } from "bun:test"
import { contextBudgetFor, shouldReclassifyAsOverflow } from "../src/policy/context-budget.ts"

test("400 generik pada prompt besar TIDAK lagi dianggap overflow", () => {
  // 500k token di jendela 1M: dulu lolos ambang 50k → salah klasifikasi.
  expect(
    shouldReclassifyAsOverflow({
      localInputTokens: 500_000,
      windowTokens: 1_048_576,
      message: "invalid request: unsupported parameter 'reasoning'",
    }),
  ).toBe(false)
})

test("400 yang menyebut konteks tetap direklasifikasi", () => {
  for (const message of [
    "maximum context length exceeded",
    "prompt is too long: 210000 tokens",
    "too many tokens",
    "context_window_exceeded",
  ]) {
    expect(
      shouldReclassifyAsOverflow({
        localInputTokens: 1_000,
        windowTokens: 1_048_576,
        message,
      }),
    ).toBe(true)
  }
})

test("tanpa petunjuk teks, hanya estimasi di/pastikan titik kompaksi yang lolos", () => {
  const window = 32_768
  const trigger = contextBudgetFor(window).compactTrigger
  expect(
    shouldReclassifyAsOverflow({
      localInputTokens: trigger - 1,
      windowTokens: window,
      message: "bad request",
    }),
  ).toBe(false)
  expect(
    shouldReclassifyAsOverflow({
      localInputTokens: trigger,
      windowTokens: window,
      message: "bad request",
    }),
  ).toBe(true)
})
