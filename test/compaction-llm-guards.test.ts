// Penjaga jalur ringkasan LLM.
//
// Regresi nyata (sesi `1bfbcc50`): 7 dari 7 kompaksi LLM gagal — 6 timeout
// karena batas 10 dtk untuk seluruh percobaan, 1 "empty summary" yang langsung
// menjatuhkan siklus ke ringkasan mekanikal 4k. Dua penyebab di kode:
//   (a) request summarizer tidak pernah mengirim pagu output, jadi provider
//       bebas mengalirkan teks jauh melewati anggaran yang sudah dihitung;
//   (b) balasan kosong tidak pernah dicoba ulang.
// Test ini mengunci kedua perbaikan plus penerusan pagu ke wire.

import { expect, test } from "bun:test"
import type { Message } from "#minicore/core/types.ts"
import {
  compactWithLlm,
  isSyntheticSummary,
  registerCompactionSummary,
} from "../src/policy/compaction.ts"

type Seen = { req: { maxTokens?: number; messages: { content?: unknown }[] }; text: string }

const storeOf = (messages: Message[]) => ({ messages }) as never

const convo = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `pertanyaan ${i} ${"x".repeat(200)}` })
    out.push({ role: "assistant", content: `jawaban ${i} ${"y".repeat(200)}` })
  }
  return out
}

function scriptedProvider(seen: Seen[], outputs: string[]) {
  let call = 0
  return {
    id: "scripted",
    models: ["m"],
    async *stream(req: Seen["req"]) {
      const text = outputs[Math.min(call, outputs.length - 1)] ?? ""
      seen.push({ req, text })
      call++
      if (text) yield { type: "text" as const, text }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  } as never
}

test("summarizer meneruskan pagu output ke provider (maxTokens)", async () => {
  const seen: Seen[] = []
  const out = await compactWithLlm(storeOf(convo(4)), {
    keepRecentTurns: 1,
    provider: scriptedProvider(seen, ["RINGKASAN"]),
    maxSummaryTokens: 700,
    maxSummaryChars: 4_000,
  })
  expect(seen.length).toBe(1)
  expect(seen[0]!.req.maxTokens).toBe(700)
  expect(String(out[0]!.content)).toContain("RINGKASAN")
})

test("balasan kosong dicoba ulang sekali dengan input lebih pendek", async () => {
  const seen: Seen[] = []
  const out = await compactWithLlm(storeOf(convo(12)), {
    keepRecentTurns: 1,
    provider: scriptedProvider(seen, ["", "RINGKASAN-KEDUA"]),
    // Pagu input eksplisit supaya "setengah input" benar-benar lebih pendek
    // dari percobaan pertama (default 6k char lebih besar dari percakapan uji).
    maxInputChars: 1_200,
  })
  expect(seen.length).toBe(2)
  // Percobaan kedua memakai prompt yang lebih pendek (setengah input).
  expect(String(seen[1]!.req.messages[0]?.content).length).toBeLessThan(
    String(seen[0]!.req.messages[0]?.content).length,
  )
  expect(String(out[0]!.content)).toContain("RINGKASAN-KEDUA")
})

test("isSyntheticSummary hanya benar untuk ringkasan yang didaftarkan", () => {
  const plain: Message = { role: "user", content: "Previous context: bukan ringkasan kita" }
  expect(isSyntheticSummary(plain)).toBe(false)
  const registered = registerCompactionSummary(plain, "bukti")
  expect(isSyntheticSummary(registered)).toBe(true)
})

test("kosong dua kali tetap jatuh ke ringkasan mekanikal (tidak menggantung)", async () => {
  const seen: Seen[] = []
  const out = await compactWithLlm(storeOf(convo(4)), {
    keepRecentTurns: 1,
    provider: scriptedProvider(seen, [""]),
  })
  expect(seen.length).toBe(2)
  expect(String(out[0]!.content)).toContain("Previous context")
})
