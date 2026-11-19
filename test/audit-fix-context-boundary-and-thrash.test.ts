// Audit-fix P1-5 / P1-6 — batas cakupan aman & progres kompaksi berbasis token.
//
// Dua regresi yang dulu terjadi senyap:
//   P1-5: `safeBaseSeq` menggeser batas MAJU sehingga baris [B, b) jatuh celah
//         antara ringkasan [0,B) dan ekor [b,head] → tool-result hilang.
//   P1-6: progres thrash diukur dari cacah pesan, jadi kompaksi konten (jumlah
//         pesan sama, token turun) terlihat 0% dan dua kejadian mematikan LLM.

import { expect, test } from "bun:test"
import { estimateMessages } from "#minicore/core/tokens.ts"
import type { Message } from "#minicore/core/types.ts"
import { createLlmCompaction, isSyntheticSummary } from "../src/policy/compaction.ts"
import { minicodeEstimator } from "../src/policy/context.ts"
import { type SelectableRow, safeBaseSeq, selectContext } from "../src/session/context-selector.ts"

const u = (c: string): Message => ({ role: "user", content: c })
const a = (c: string): Message => ({ role: "assistant", content: c })
const tool = (id: string, c: string): Message =>
  ({ role: "tool", toolCallId: id, name: "read_file", content: c }) as Message
const withCalls = (id: string): Message =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", args: {} }] }) as Message

const rowsOf = (msgs: readonly Message[]): SelectableRow[] =>
  msgs.map((m, i) => ({ seq: i, message: m }))

const storeOf = (messages: Message[]) => ({ messages }) as never
const sig = () => new AbortController().signal

/** Provider kecil yang mengembalikan satu teks ringkasan tetap. */
function scripted(text: string) {
  return {
    id: "scripted",
    models: ["m"],
    async *stream() {
      if (text) yield { type: "text" as const, text }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  } as never
}

const convo = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push(u(`q${i}`))
    out.push(a(`a${i}`))
  }
  return out
}

// ── P1-5: batas cakupan ────────────────────────────────────────────────────────

test("P1-5: batas tak aman di tengah histori ditolak (mundur penuh), bukan digeser maju", () => {
  // Kasus audit persis: [user@0, assistant(toolCalls)@1, tool@2, user@3],
  // baseSeq=2. Geser maju ke 3 membuat tool@2 keluar dari ekor (>=3) dan tak
  // tercakup ringkasan [0,2) → bukti hilang. Batas 2 memang tak aman
  // (lastCovered @1 punya toolCalls), jadi jawaban yang benar adalah 0.
  const rows = rowsOf([u("A"), withCalls("c1"), tool("c1", "EVIDEN-PENTING"), u("B")])
  expect(safeBaseSeq(rows, 2)).toBe(0)
})

test("P1-5: selectContext pada batas tak aman memakai histori penuh, tool row tidak hilang", () => {
  const messages = [u("A"), withCalls("c1"), tool("c1", "EVIDEN-PENTING"), u("B")]
  const sel = selectContext({
    sessionId: "s",
    threadId: "t",
    rows: rowsOf(messages),
    revision: 0,
    projection: { baseSeq: 2, summaryText: "ringkas [0,2)" },
    policy: { budgetTokens: 100_000 },
  })
  // Bukan summary-plus-tail/budget-tail yang bisa membuang baris @2.
  expect(sel.selectionBasis).toBe("full-history")
  expect(sel.coveredSeq).toBe(0)
  expect(sel.messages).toHaveLength(4)
  expect(sel.messages.map((m) => (m as { content?: unknown }).content)).toContain("EVIDEN-PENTING")
  expect(sel.messages.find((m) => m.role === "tool")).toBeDefined()
  expect(sel.contextOnly).toBeUndefined()
})

test("P1-5: batas AMAN tetap menghasilkan summary-plus-tail (regresi jalur aman)", () => {
  const sel = selectContext({
    sessionId: "s",
    threadId: "t",
    rows: rowsOf([u("A"), a("B"), u("C"), a("D"), u("E")]),
    revision: 0,
    projection: { baseSeq: 3, summaryText: "ringkas [0,3)" },
    policy: { budgetTokens: 100_000 },
  })
  expect(safeBaseSeq(rowsOf([u("A"), a("B"), u("C"), a("D"), u("E")]), 3)).toBe(3)
  expect(sel.selectionBasis).toBe("summary-plus-tail")
  expect(sel.coveredSeq).toBe(3)
  expect(sel.messages.slice(1).map((m) => (m as { content: unknown }).content)).toEqual(["D", "E"])
})

// ── P1-6: progres kompaksi ─────────────────────────────────────────────────────

test("P1-6: kompaksi konten (jumlah pesan sama, token turun) tidak memicu thrash", async () => {
  // [user BESAR@0, user@1, assistant@2, assistant@3], keep=1 → prefix satu
  // pesan diganti ringkasan pendek: out tetap 4 pesan, namun token anjlok.
  // Kode lama menganggapnya no-op (early-return `out.length === before`) lalu
  // membuang hasil LLM dan memakai fallback mekanikal.
  const big = "x".repeat(4_000)
  const beforeMsgs: Message[] = [u(big), u("lanjut"), a("oke"), a("siap")]
  const store = () => storeOf([...beforeMsgs])
  const beforeTokens = estimateMessages(beforeMsgs, minicodeEstimator)
  const s = createLlmCompaction({ provider: scripted("RINGKASAN-PENDEK") })
  for (let i = 0; i < 3; i++) {
    const out = await s.compactAsync!(store(), { keepRecentTurns: 1 }, sig())
    // Token benar-benar turun meski jumlah pesan identik.
    expect(estimateMessages(out, minicodeEstimator)).toBeLessThan(beforeTokens)
    expect(out).toHaveLength(4)
    // Jalur LLM tetap hidup DAN hasilnya dipakai (bukan fallback mekanikal).
    expect(isSyntheticSummary(out[0]!)).toBe(true)
    expect(String(out[0]!.content)).toContain("RINGKASAN-PENDEK")
  }
})

test("P1-6: thrash asli (token & jumlah pesan tak turun) tetap mematikan jalur LLM", async () => {
  // Penjaga agar perbaikan tidak melemahkan fungsi anti-thrash: satu reduksi
  // kecil (1/20 pesan) berulang dua kali tetap mematikan LLM sesi-ini.
  const s = createLlmCompaction({ provider: scripted("RINGKASAN") })
  const narrow = () => storeOf(convo(10))
  await s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())
  await s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())
  await expect(s.compactAsync!(narrow(), { keepRecentTurns: 9 }, sig())).rejects.toThrow(
    /disabled after thrash/,
  )
})
