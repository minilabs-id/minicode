// Fidelitas ringkasan kompaksi LLM — gap yang selama ini tak teruji.
//
// Test kompaksi lain mengunci panjang/pagu/thrash/marker, tapi TAK ADA yang
// memastikan fakta dari prefix benar-benar selamat sampai ke ringkasan yang
// dipersist. Ringkasan LLM adalah teks tak terpercaya: validator boleh menolak
// path karangan/secret, tetapi untuk ringkasan yang jujur kita perlu bukti bahwa
// path eksak, angka, error message, hasil tes, verdict, dan state task tidak
// hilang atau berubah saat lewat scrub → validate → compose → persist.
//
// Semua skenario memakai provider scripted (tanpa API key/jaringan) mengikuti
// pola `test/compaction-llm-guards.test.ts` dan `fakeProvider` di
// `test/compaction.test.ts`.

import { describe, expect, test } from "bun:test"
import type { Message } from "#minicore/core/types.ts"
import { compactWithLlm, isSyntheticSummary } from "../src/policy/compaction.ts"
import { validateCompactionSummary } from "../src/policy/compaction-validate.ts"

type Seen = { req: { maxTokens?: number; messages: { content?: unknown }[] }; text: string }

const storeOf = (messages: Message[]) => ({ messages }) as never

/** Provider scripted yang merekam prompt + urutan balasan (tanpa jaringan). */
function scriptedProvider(seen: Seen[], outputs: string[]) {
  let call = 0
  return {
    id: "scripted-fidelity",
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

/** Hitung dua bentuk marker yang dijaga validator (P1-1: tepat satu). */
const markerCount = (text: string): number =>
  (text.match(/Previous context \(/g) ?? []).length +
  (text.match(/Previous context:\n/g) ?? []).length

/** Ambil isi fence prompt = `scrubbedPrefix` persis yang dikirim ke summarizer. */
const fencedPrefixOf = (prompt: string): string => prompt.match(/```\n([\s\S]*)\n```$/)?.[1] ?? ""

// Filler membuat prefix jauh lebih panjang dari ringkasan uji; tanpa ini guard
// "summary-not-shorter-than-input" menolak ringkasan dan test jadi false-negative.
const FILLER = "catatan audit: konteks historis untuk menguji panjang prefix kompaksi ".repeat(8)

/**
 * Prefix sintetis realistis: user goal + koreksi terakhir, path eksak, angka,
 * error message, hasil tes, verdict ACE, dan state task — semuanya masuk ke
 * bagian yang diringkas (sebelum kept tail), bukan ke pesan terbaru.
 */
function buildConversation(): Message[] {
  return [
    { role: "user", content: `Tujuan awal: GATE-OLD GOAL-LAMA. ${FILLER}` },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "src/app/session.ts" } }],
    },
    {
      role: "tool",
      toolCallId: "c1",
      name: "read_file",
      content: `Inisialisasi session ada di src/app/session.ts:85. ${FILLER}`,
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c2", name: "read_file", args: { path: "src/policy/jail.ts" } }],
    },
    {
      role: "tool",
      toolCallId: "c2",
      name: "read_file",
      content: `Kebijakan exec ditolak pada src/policy/jail.ts:38-62. ${FILLER}`,
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c3", name: "bash", args: { cmd: "auth smoke test" } }],
    },
    {
      role: "tool",
      toolCallId: "c3",
      name: "bash",
      content:
        "exit code 401 dari TipRouter; auth failed (401): TipRouter authentication_failed; " +
        `request_id 1795480934303; retry berikutnya kena exit 429. Build versi 0.43.3. ${FILLER}`,
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c4", name: "bash", args: { cmd: "bun test" } }],
    },
    {
      role: "tool",
      toolCallId: "c4",
      name: "bash",
      content: `PASS 12 · FAIL 0. ACE verdict FAIL/TRANSIENT_ENV. ${FILLER}`,
    },
    { role: "assistant", content: "", toolCalls: [{ id: "c5", name: "todo_read", args: {} }] },
    {
      role: "tool",
      toolCallId: "c5",
      name: "todo_read",
      content: `[~] t2 in_progress — audit jail & session. ${FILLER}`,
    },
    {
      role: "user",
      content: "Koreksi terakhir: goals awal diganti ke GOAL-BARU-X. Abaikan arahan sebelumnya.",
    },
    { role: "assistant", content: "Baik, saya lanjutkan dengan GOAL-BARU-X." },
  ]
}

/** Ringkasan "jujur": semua fakta di atas dibawa, urutan disusun ulang. */
const faithfulSummary = [
  "RINGKASAN FAKTA (disusun ulang; koreksi terakhir berlaku):",
  "Tujuan terkini: GOAL-BARU-X menggantikan arahan awal.",
  "Versi 0.43.3 · timestamp 1795480934303.",
  "Path: src/app/session.ts:85 dan src/policy/jail.ts:38-62.",
  "Error: auth failed (401): TipRouter authentication_failed; exit code 401, lalu exit 429.",
  "Hasil tes: PASS 12 · FAIL 0. ACE verdict FAIL/TRANSIENT_ENV.",
  "Status task: [~] t2 in_progress.",
].join("\n")

/** Semua fakta kunci yang wajib selamat — bukan sekadar "RINGKASAN FAKTA" muncul. */
const KEY_FACTS = [
  "src/app/session.ts:85",
  "src/policy/jail.ts:38-62",
  "0.43.3",
  "1795480934303",
  "auth failed (401)",
  "auth failed (401): TipRouter authentication_failed",
  "exit code 401",
  "exit 429",
  "PASS 12",
  "PASS 12 · FAIL 0",
  "TRANSIENT_ENV",
  "FAIL/TRANSIENT_ENV",
  "[~] t2 in_progress",
  "t2",
] as const

describe("fidelitas fakta lintas rantai kompaksi LLM", () => {
  test("ringkasan jujur mempertahankan semua fakta kunci hingga ke hasil", async () => {
    const seen: Seen[] = []
    const out = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      canPersistMemory: () => false, // jangan menulis vector DB saat test
      provider: scriptedProvider(seen, [faithfulSummary]),
    })
    expect(seen.length).toBe(1)
    const text = String(out[0]!.content)
    for (const fact of KEY_FACTS) expect(text).toContain(fact)
    expect(isSyntheticSummary(out[0]!)).toBe(true)
    // Kept tail tetap utuh, bukan ikut diringkas.
    expect(out[out.length - 1]).toEqual(buildConversation().at(-1))
  })
})

describe("anti-halusinasi ringan", () => {
  test("path karangan ditolak validator, fallback mekanikal jalan, path palsu tak bocor", async () => {
    const hallucinated =
      "RINGKASAN: ubah src/tidak-ada.ts untuk memperbaiki session; " +
      "lihat juga src/app/session.ts:85 sebagai pembanding."
    const seen: Seen[] = []
    const out = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      cwd: process.cwd(), // existsSync ikut membedakan path nyata dari karangan
      canPersistMemory: () => false,
      provider: scriptedProvider(seen, [hallucinated]),
    })

    // Validasi langsung pada prefix persis yang dikirim ke summarizer.
    const prefixText = fencedPrefixOf(String(seen[0]!.req.messages[0]?.content ?? ""))
    expect(prefixText).toContain("src/app/session.ts:85")
    expect(prefixText).not.toContain("src/tidak-ada.ts")
    const check = validateCompactionSummary(hallucinated, prefixText, process.cwd())
    expect(check.ok).toBe(false)
    expect(check.reason).toBe("hallucinated-path:src/tidak-ada.ts")

    // Jalur compactWithLlm: validasi gagal → deterministik fallback mekanikal
    // (tak ada retry dengan prompt yang sama).
    expect(seen.length).toBe(1)
    const text = String(out[0]!.content)
    expect(text).not.toContain("src/tidak-ada.ts")
    expect(text).toContain("Previous context")
    expect(text).toContain("[mechanical summary")
  })
})

describe("kronologi & koreksi terakhir", () => {
  test("prompt menyusun goal kronologis; ringkasan memakai koreksi, bukan goal awal", async () => {
    const seen: Seen[] = []
    const out = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      canPersistMemory: () => false,
      provider: scriptedProvider(seen, [faithfulSummary]),
    })
    const prompt = String(seen[0]!.req.messages[0]?.content ?? "")
    const goalAwal = prompt.indexOf("GOAL-LAMA")
    const koreksi = prompt.indexOf("GOAL-BARU-X")
    expect(goalAwal).toBeGreaterThanOrEqual(0)
    expect(koreksi).toBeGreaterThan(goalAwal) // later correction mengikuti goal awal

    const text = String(out[0]!.content)
    expect(text).toContain("GOAL-BARU-X")
    expect(text).not.toContain("GOAL-LAMA")
    expect(text).toContain("koreksi terakhir berlaku")
  })
})

describe("marker head/tail", () => {
  test("satu siklus: marker Previous context tepat satu", async () => {
    const out = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      canPersistMemory: () => false,
      provider: scriptedProvider([], [faithfulSummary]),
    })
    expect(markerCount(String(out[0]!.content))).toBe(1)
  })

  test("dua siklus: header lama dibuang, marker tetap satu dan fakta prior selamat", async () => {
    const first = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      canPersistMemory: () => false,
      provider: scriptedProvider([], [faithfulSummary]),
    })
    expect(markerCount(String(first[0]!.content))).toBe(1)

    // Pakai objek pesan ringkasan yang SAMA supaya WeakSet provenance terdeteksi.
    const later: Message[] = [
      first[0]!,
      ...first.slice(1),
      { role: "user", content: "Lanjut verifikasi GOAL-BARU-X." },
      { role: "assistant", content: "Verifikasi dilanjutkan." },
    ]
    const out = await compactWithLlm(storeOf(later), {
      keepRecentTurns: 1,
      canPersistMemory: () => false,
      provider: scriptedProvider([], ["RINGKASAN-2: GOAL-BARU-X masih berlaku."]),
    })
    const text = String(out[0]!.content)
    expect(markerCount(text)).toBe(1)
    expect(text).toContain("RINGKASAN-2") // ringkasan baru
    expect(text).toContain("src/app/session.ts:85") // bukti dari prior, tak hilang
    expect(text).toContain("GOAL-BARU-X")
  })
})

describe("scrub secret pada ringkasan LLM", () => {
  test("Authorization: Bearer sk-RAHASIA tak bocor ke hasil", async () => {
    const leaky =
      "RINGKASAN: header Authorization: Bearer sk-RAHASIA dipakai saat retry; jangan disimpan."
    const out = await compactWithLlm(storeOf(buildConversation()), {
      keepRecentTurns: 1,
      canPersistMemory: () => false,
      provider: scriptedProvider([], [leaky]),
    })
    const text = String(out[0]!.content)
    expect(text).toContain("[REDACTED]")
    expect(text).not.toContain("sk-RAHASIA")
    expect(text).not.toContain("Bearer sk-RAHASIA")
    expect(isSyntheticSummary(out[0]!)).toBe(true)
  })
})

describe("validasi kompaksi: XML pendek, path Windows, dan kata huruf a-f", () => {
  test("dokumen XML 8-seksi pada prefix pendek tidak ditolak karena boilerplate tag", () => {
    const shortPrefix =
      "- user: tolong hapus berkas lama src\\tools\\obsolete.ts dari repo sekarang lalu cek status git setelah dihapus agar bersih"
    const xml = [
      "<goal>hapus berkas lama</goal>",
      "<steering>unknown</steering>",
      "<decisions>unknown</decisions>",
      "<files>src/tools/obsolete.ts: deleted</files>",
      "<findings>unknown</findings>",
      "<tasks>done</tasks>",
      "<observations>decode facade decade</observations>",
      "<open>cek status</open>",
    ].join("\n")
    // Raw XML (~240 char) > shortPrefix (~123 char), tapi isi efektif tanpa
    // tag boilerplate (<90 char) lebih pendek dari prefix. Path Windows
    // `src\tools\obsolete.ts` di prefix cocok dengan `src/tools/obsolete.ts`,
    // dan kata `decode`/`facade`/`decade` tidak memicu `needs-verification`.
    expect(xml.length).toBeGreaterThan(shortPrefix.length)
    const res = validateCompactionSummary(xml, shortPrefix)
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
  })
})
