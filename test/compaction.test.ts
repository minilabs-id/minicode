// Test kompaksi LLM: jalur yang berjalan saat konteks penuh — paling jarang
// terlihat manual, paling mahal saat salah (fakta hilang dari ringkasan).

import { describe, expect, test } from "bun:test"
import { estimateMessages } from "#minicore/core/tokens.ts"
import type { Message } from "#minicore/core/types.ts"
import { LIMITS } from "../src/constants.ts"
import {
  compactWithLlm,
  composeBoundedSummary,
  createLlmCompaction,
  mechanicalKeepResults,
  parseCompactKeepTurns,
  summaryCharBudgetForWindow,
  summaryInputCharBudget,
} from "../src/policy/compaction.ts"
import { minicodeEstimator } from "../src/policy/context.ts"

/** ContextStore tiruan: hanya `messages` yang dibaca kompaksi. */
const storeOf = (messages: Message[]) => ({ messages }) as never

/** Provider tiruan yang mengembalikan teks tetap sebagai ringkasan. */
function fakeProvider(text: string, opts: { fail?: boolean; empty?: boolean } = {}) {
  return {
    id: "fake",
    models: ["m"],
    async *stream() {
      if (opts.fail) throw new Error("provider meledak")
      if (!opts.empty) yield { type: "text" as const, text }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  } as never
}

const convo = (n: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: "user", content: `pertanyaan ${i}` })
    out.push({ role: "assistant", content: `jawaban ${i}` })
  }
  return out
}

describe("mechanical compaction keeps tool results (Q1)", () => {
  test("fallback mekanikal menyimpan isi hasil tool, bukan `<result omitted>`", () => {
    const messages: Message[] = [
      { role: "user", content: "baca file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "ISI FILE PENTING abcdef" },
      { role: "user", content: "lanjut" },
      { role: "assistant", content: "jawaban akhir" },
    ]
    const s = createLlmCompaction({ getContextWindowTokens: () => 16_000 })
    const out = s.compact(storeOf(messages), { keepRecentTurns: 1 })
    const summary = String(out[0]!.content as string)
    expect(summary).toContain("Previous context")
    expect(summary).toContain("ISI FILE PENTING")
    expect(summary).not.toContain("<result omitted>")
  })

  test("tool pembawa fakta (grep) dipertahankan lebih panjang dari tool lain (T5)", () => {
    // Penanda diletakkan jauh di belakang (posisi ~700) supaya beda head panjang
    // (800) vs prosa (260) kelihatan: fakta selamat, non-fakta terpotong.
    const factOut = `${"x".repeat(700)}SELAMAT_FAKTA`
    const nonFactOut = `${"y".repeat(700)}HILANG_NONFAKTA`
    const messages: Message[] = [
      { role: "user", content: "audit" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "grep", args: {} },
          { id: "c2", name: "unknown_tool", args: {} },
        ],
      },
      { role: "tool", toolCallId: "c1", name: "grep", content: factOut },
      { role: "tool", toolCallId: "c2", name: "unknown_tool", content: nonFactOut },
      { role: "user", content: "lanjut" },
      { role: "assistant", content: "selesai" },
    ]
    const s = createLlmCompaction({ getContextWindowTokens: () => 16_000 })
    const out = s.compact(storeOf(messages), { keepRecentTurns: 1 })
    const summary = String(out[0]!.content as string)
    expect(summary).toContain("SELAMAT_FAKTA")
    expect(summary).not.toContain("HILANG_NONFAKTA")
  })
})

describe("compactWithLlm", () => {
  test("ringkasan LLM menggantikan prefix, pesan terbaru dipertahankan", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("RINGKASAN FAKTA"),
    })
    expect(out.length).toBeLessThan(messages.length)
    expect(String(out[0]!.content)).toContain("RINGKASAN FAKTA")
    // Pesan terakhir asli tetap utuh — bukan diringkas.
    expect(out[out.length - 1]).toEqual(messages[messages.length - 1]!)
  })

  test("riwayat lebih pendek dari yang dipertahankan → tidak diubah", async () => {
    const messages = convo(1)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 5,
      provider: fakeProvider("x"),
    })
    expect(out).toEqual(messages)
  })

  test("ringkasan kosong → fallback mekanis (bukan konteks kosong)", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("", { empty: true }),
    })
    expect(out.length).toBeGreaterThan(0)
    expect(String(out[0]!.content)).not.toContain("LLM summarized")
  })

  test("provider melempar → fallback mekanis", async () => {
    const messages = convo(6)
    const out = await compactWithLlm(storeOf(messages), {
      keepRecentTurns: 2,
      provider: fakeProvider("x", { fail: true }),
    })
    expect(out.length).toBeGreaterThan(0)
  })

  test("noFallback + provider gagal → melempar (loop yang memutuskan)", async () => {
    await expect(
      compactWithLlm(
        storeOf(convo(6)),
        { keepRecentTurns: 2, provider: fakeProvider("x", { fail: true }) },
        undefined,
        true,
      ),
    ).rejects.toThrow()
  })

  test("abort saat ringkasan berjalan diteruskan, bukan ditelan jadi fallback", async () => {
    const ac = new AbortController()
    const slow = {
      id: "slow",
      models: ["m"],
      async *stream(_req: unknown, signal: AbortSignal) {
        ac.abort()
        if (signal.aborted) {
          const err = new Error("Aborted")
          err.name = "AbortError"
          throw err
        }
        yield { type: "text" as const, text: "x" }
      },
    } as never
    await expect(
      compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 2, provider: slow }, ac.signal, true),
    ).rejects.toThrow()
  })

  test("hasil tool sukses ikut masuk prompt ringkasan (sumber fakta)", async () => {
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const messages: Message[] = [
      { role: "user", content: "baca berkas" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "read_file", args: { path: "src/a.ts" } }],
      } as Message,
      {
        role: "tool",
        name: "read_file",
        content: "export const x = 1",
        toolCallId: "1",
      } as Message,
      { role: "user", content: "sekarang ubah" },
      { role: "assistant", content: "selesai" },
      { role: "user", content: "terakhir" },
      { role: "assistant", content: "ya" },
    ]
    await compactWithLlm(storeOf(messages), { keepRecentTurns: 1, provider: spy })
    expect(seenPrompt).toContain("read_file")
    expect(seenPrompt).toContain("export const x = 1")
    expect(seenPrompt).toContain("<files>")
    expect(seenPrompt).toContain("<observations>")
    expect(seenPrompt).toContain("Quote file paths, numbers, identifiers")
  })

  test("hasil tool ERROR ditandai di ringkasan", async () => {
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const messages: Message[] = [
      { role: "user", content: "jalankan" },
      {
        role: "tool",
        name: "bash",
        content: "gagal total",
        isError: true,
        toolCallId: "1",
      } as Message,
      { role: "user", content: "lagi" },
      { role: "assistant", content: "ya" },
    ]
    await compactWithLlm(storeOf(messages), { keepRecentTurns: 1, provider: spy })
    expect(seenPrompt).toContain("ERROR")
    expect(seenPrompt).toContain("gagal total")
  })

  test("F6: active-turn fold mempertahankan request terkini verbatim di input summarizer", async () => {
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    // Satu turn aktif didominasi hasil tool (keep >= panjang → activeTurn).
    const messages: Message[] = [
      { role: "user", content: "Buat jadwal lembur dari data acuan ini" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "read_file", args: { path: "acuan.docx" } }],
      } as Message,
      {
        role: "tool",
        name: "read_file",
        content: `data ${"x".repeat(8_000)}`,
        toolCallId: "1",
      } as Message,
    ]
    await compactWithLlm(storeOf(messages), { keepRecentTurns: 1, provider: spy })
    expect(seenPrompt).toContain("Current request (verbatim):")
    expect(seenPrompt).toContain("Buat jadwal lembur dari data acuan ini")
  })

  // `String.slice` memotong per code unit UTF-16 sehingga bisa menyisakan
  // surrogate TUNGGAL, yang tidak valid di JSON provider (risiko 400) dan
  // berubah jadi U+FFFD. Sweep seluruh posisi batas yang mungkin, langsung ke
  // fungsi murni (lewat compactWithLlm 101× menembus batas 5 dtk).
  test("pemotongan pagu tidak pernah menyisakan surrogate tunggal", () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (let pad = 1300; pad <= 1400; pad++) {
      const fresh = `${"a".repeat(pad)}${"👍👍👍👍👍"}${"b".repeat(200)}`
      for (const composed of [
        composeBoundedSummary("", fresh),
        composeBoundedSummary("PRIOR ".repeat(300), fresh),
      ]) {
        expect(composed.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
        expect(LONE.test(composed)).toBe(false)
      }
    }
  })

  // Penjaga: pagu yang berlaku di jalur nyata, bukan hanya fungsi murni.
  test("jalur compactWithLlm juga bebas surrogate tunggal", async () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const summary = `${"a".repeat(1326)}${"👍👍👍👍👍"}${"b".repeat(200)}`
    const out = await compactWithLlm(storeOf(convo(6)), {
      keepRecentTurns: 1,
      provider: fakeProvider(summary),
    })
    const head = String(out[0]!.content)
    expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(LONE.test(head)).toBe(false)
  })

  test("anggaran di prompt = pagu simpan, bukan angka lepas", async () => {
    // Kalau prompt minta lebih dari yang composeBoundedSummary simpan, sisanya
    // dibuang diam-diam: token terbuang tanpa manfaat. Keduanya harus-bind ke
    // konstanta yang sama.
    let seenPrompt = ""
    const spy = {
      id: "spy",
      models: ["m"],
      async *stream(req: { messages: Message[] }) {
        seenPrompt = String(req.messages[0]?.content ?? "")
        yield { type: "text" as const, text: "ok" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    await compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 1, provider: spy })
    const asked = Number(/max (\d+) tokens/.exec(seenPrompt)?.[1])
    expect(Number.isFinite(asked)).toBe(true)
    // Estimasi 4 char/token; angka yang diminta harus muat di bawah pagu,
    // bukan 600 token lepas yang sebagian besar dibuang.
    expect(asked * 4).toBeLessThan(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(seenPrompt).toContain("discarded")
  })

  test("apiKey membangun provider openai-compat tanpa provider eksplisit", async () => {
    // Tanpa apiKey maupun provider: fallback mekanis, tidak melempar.
    const out = await compactWithLlm(storeOf(convo(6)), { keepRecentTurns: 2 })
    expect(out.length).toBeGreaterThan(0)
  })

  // Regresi P0 long-horizon: prior summary di-carried verbatim lalu
  // digabung dengan summary baru. Tanpa pagu, tiap siklus menambah
  // ~2.400 char ke pesan pertama yang SELALU ikut dikirim ke model — setelah
  // 12 siklus summary itu sendiri jadi sumber context overflow.
  test(
    "berulang kali dikompaksi: summary tak tumbuh tanpa batas",
    async () => {
      // Panjang summary realistis (LLM diminta "max 600 tokens" ≈ 2.400 char).
      const realistic = (cycle: number) =>
        `FAKTA siklus ${cycle}: berkas diubah, tes lulus. ${"detail penting. ".repeat(160)}`
      // Guard P0-2: ringkasan ≥ input ditolak. Fixture memakai prefix panjang
      // (percakapan nyata yang memicu kompaksi), bukan convo(6) yang pendek,
      // supaya ringkasan uji tetap sah sebagai hasil kompresi.
      const verbose = (): Message[] => {
        const out: Message[] = []
        for (let i = 0; i < 20; i++) {
          out.push({ role: "user", content: `pertanyaan ${i} ${"x".repeat(300)}` })
          out.push({ role: "assistant", content: `jawaban ${i} ${"y".repeat(300)}` })
        }
        return out
      }
      let history: Message[] = verbose()
      for (let cycle = 0; cycle < 12; cycle++) {
        history = [
          ...(await compactWithLlm(storeOf(history), {
            keepRecentTurns: 1,
            provider: fakeProvider(realistic(cycle)),
          })),
          // Tiap siklus menyisipkan percakapan baru: prior ringkasan sengaja
          // TIDAK masuk prefix, jadi prefix harus panjang sendiri agar guard
          // anti-echo tak salah menolak ringkasan uji.
          ...verbose(),
          { role: "user", content: `lanjutan ${cycle}` },
          { role: "assistant", content: `jawaban lanjutan ${cycle}` },
        ]
      }
      const head = String(history[0]!.content)
      expect(head).toContain("Previous context")
      expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
      // Fakta siklus TERAKHIR harus selamat walau yang lama dipangkas.
      expect(head).toContain("siklus 11")
      // Pemangkasan bersifat eksplisit, bukan diam-diam: model tak boleh
      // menyimpulkan ringkasan ini lengkap. Marker gabungan prior memakai
      // "omitted" (SUMMARY_ELISION), bukan "elided" (yang hanya muncul saat
      // response provider melebihi jendela stream).
      expect(head).toContain("omitted")
    },
    { timeout: 15_000 },
  )

  test("summary pendek tetap digabung dengan prior di bawah pagu", async () => {
    let history: Message[] = convo(6)
    for (let cycle = 0; cycle < 6; cycle++) {
      history = [
        ...(await compactWithLlm(storeOf(history), {
          keepRecentTurns: 1,
          provider: fakeProvider(`FAKTA ${cycle}`),
        })),
        { role: "user", content: `lanjutan ${cycle}` },
        { role: "assistant", content: `jawaban lanjutan ${cycle}` },
      ]
    }
    const head = String(history[0]!.content)
    expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    // Prior dipangkas dari head (fresh terakhir), jadi fakta siklus pertama
    // (paling tua) boleh hilang sementara siklus terbaru pasti ada.
    expect(head).toContain("FAKTA 5")
    expect(head).not.toContain("FAKTA 0\n")
  })

  // Regresi P1-1: compose dulu menambah SUMMARY_HEADER tiap siklus dan mengambil
  // EKOR prior. Simulasi 3 siklus: header dobel, f2 hilang, f1 (paling tua) justru
  // bertahan. Sekarang header ditambahkan pemanggil sekali dan prior dipangkas dari
  // HEAD, sehingga f3 + f2 selamat dan f1 dibuang.
  test("3 siklus: header sekali, siklus terbaru menang, yang tua dibuang", async () => {
    const fact = (n: number) => `FAKTA-F${n} ${"detail penting. ".repeat(160)}`
    const texts = [fact(1), fact(2), fact(3)]
    let call = 0
    const provider = {
      id: "cycle",
      models: ["m"],
      async *stream() {
        yield { type: "text" as const, text: texts[Math.min(call++, texts.length - 1)]! }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    // Prefix panjang diperlukan agar guard "ringkasan < input" tak menolak fixture.
    const verbose = (): Message[] => {
      const out: Message[] = []
      for (let i = 0; i < 20; i++) {
        out.push({ role: "user", content: `pertanyaan ${i} ${"x".repeat(300)}` })
        out.push({ role: "assistant", content: `jawaban ${i} ${"y".repeat(300)}` })
      }
      return out
    }
    let history: Message[] = verbose()
    for (let cycle = 0; cycle < 3; cycle++) {
      history = [
        ...(await compactWithLlm(storeOf(history), { keepRecentTurns: 1, provider })),
        ...verbose(),
        { role: "user", content: `lanjutan ${cycle}` },
        { role: "assistant", content: `jawaban lanjutan ${cycle}` },
      ]
    }
    const head = String(history[0]!.content)
    expect(head).toContain("FAKTA-F3")
    expect(head).toContain("FAKTA-F2")
    expect(head).not.toContain("FAKTA-F1")
    // Marker utama tepat satu: header tak boleh ikut tersalin lewat prior.
    expect(head.match(/Previous context \(/g) ?? []).toHaveLength(1)
    expect(head.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
  })
})

describe("createLlmCompaction", () => {
  test("compact sinkron selalu memakai fallback mekanis", () => {
    const s = createLlmCompaction()
    const out = s.compact(storeOf(convo(6)), { keepRecentTurns: 2 })
    expect(out.length).toBeGreaterThan(0)
    expect(s.kind).toBe("llm-mechanical")
  })

  test("compactAsync memakai provider bila diberikan", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("HASIL") })
    const out = await s.compactAsync!(
      storeOf(convo(6)),
      { keepRecentTurns: 2 },
      new AbortController().signal,
    )
    expect(String(out[0]!.content)).toContain("HASIL")
  })

  // Regresi lapangan: 503 `overloaded` sesaat pada panggilan pertama dulu
  // langsung membuang jalur LLM (ringkasan mekanikal yang jauh kurang
  // informatif). Sekarang anggaran pemulihan bersama mencoba ulang.
  test("compactAsync mencoba ulang 503 sesaat lalu memakai ringkasan LLM", async () => {
    let calls = 0
    const provider = {
      name: "flaky",
      stream: async function* () {
        calls++
        if (calls === 1) {
          const err = new Error("server error (503): overloaded") as Error & { category: string }
          err.category = "server"
          throw err
        }
        yield { type: "text", text: "RINGKASAN-LLM" }
        yield { type: "finish" }
      },
    } as never
    const s = createLlmCompaction({ provider, model: "m", maxSummaryTokens: 200 })
    const out = await s.compactAsync!(
      storeOf(convo(12)),
      { keepRecentTurns: 1 },
      new AbortController().signal,
    )
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(String(out[0]!.content)).toContain("RINGKASAN-LLM")
  })

  test("compactAsync menolak tanpa provider (loop yang fallback)", async () => {
    const s = createLlmCompaction()
    await expect(
      s.compactAsync!(storeOf(convo(6)), { keepRecentTurns: 2 }, new AbortController().signal),
    ).rejects.toThrow()
  })

  test("fallback kustom dipakai oleh compact sinkron", () => {
    let dipakai = false
    const s = createLlmCompaction({
      fallback: {
        kind: "kustom",
        compact: () => {
          dipakai = true
          return []
        },
      },
    })
    s.compact(storeOf(convo(4)), { keepRecentTurns: 1 })
    expect(dipakai).toBe(true)
  })

  test("signal luar diteruskan ke provider", async () => {
    // Provider yang menghormati signal akan melempar; compactAsync memakai
    // noFallback sehingga error itu naik ke loop (bukan diam-diam mekanis).
    const respectful = {
      id: "r",
      models: ["m"],
      async *stream(_req: unknown, signal: AbortSignal) {
        if (signal.aborted) {
          const err = new Error("Aborted")
          err.name = "AbortError"
          throw err
        }
        yield { type: "text" as const, text: "x" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const s = createLlmCompaction({ provider: respectful })
    const ac = new AbortController()
    ac.abort()
    await expect(
      s.compactAsync!(storeOf(convo(6)), { keepRecentTurns: 2 }, ac.signal),
    ).rejects.toThrow()
  })

  test("R9: ringkasan LLM TIDAK di-clamp balik ke 4k pada jendela besar", async () => {
    // Regresi F1: ringkasan yang SUDAH diproduksi dengan budget jendela
    // (summaryCharBudgetForWindow ≈ 32k untuk 1M token) dulu di-truncate ulang
    // ke COMPACTION_SUMMARY_MAX_CHARS (4k) oleh boundCompactionResult, sehingga
    // model 1M over-discard fakta lama. Provider mengembalikan ringkasan panjang
    // (~40k char) dan compactAsync harus mempertahankan > lantai 4k.
    const window = 1_000_000
    const budget = summaryCharBudgetForWindow(window)
    expect(budget).toBeGreaterThan(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    const big = `RINGKASAN-PANJANG-${"S".repeat(40_000)}`
    // Prefix harus lebih panjang dari ringkasan uji (guard anti-echo P0-2):
    // pakai percakapan panjang seperti kondisi nyata saat jendela 1M penuh.
    const verbose: Message[] = []
    for (let i = 0; i < 140; i++) {
      verbose.push({ role: "user", content: `pertanyaan ${i} ${"x".repeat(300)}` })
      verbose.push({ role: "assistant", content: `jawaban ${i} ${"y".repeat(300)}` })
    }
    const s = createLlmCompaction({
      provider: fakeProvider(big),
      getContextWindowTokens: () => window,
    })
    const out = await s.compactAsync!(
      storeOf(verbose),
      { keepRecentTurns: 2 },
      new AbortController().signal,
    )
    const summaryLen = String(out[0]!.content).length
    expect(summaryLen).toBeGreaterThan(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(summaryLen).toBeLessThanOrEqual(budget)
  })

  test("P1-3: ringkasan LLM melewati target dipangkas, bukan diganti mekanikal", async () => {
    // target = 0.5 × 2000 = 1000 token. Teks bergaya kode ≈ 2,4 char/token,
    // jadi ~4k char > target: memicu cabang fit di boundCompactionResult.
    const window = 2_000
    const denseSummary = "const x = { a: 1, b: [2, 3] }; ".repeat(140)
    const verbose: Message[] = []
    for (let i = 0; i < 80; i++) {
      verbose.push(
        { role: "user", content: `pertanyaan ${i} ${"const y = [1,2]; ".repeat(30)}` },
        { role: "assistant", content: `jawaban ${i} ${"x".repeat(200)}` },
      )
    }
    const s = createLlmCompaction({
      provider: fakeProvider(denseSummary),
      getContextWindowTokens: () => window,
    })
    const out = await s.compactAsync!(
      storeOf(verbose),
      { keepRecentTurns: 1 },
      new AbortController().signal,
    )
    const target = Math.floor(window * LIMITS.COMPACTION_SUMMARY_TARGET_RATIO)
    expect(estimateMessages(out, minicodeEstimator)).toBeLessThanOrEqual(target)
    // Isi LLM tetap dipakai (bukan dump mekanikal).
    expect(String(out[0]!.content)).toContain("const x = { a: 1")
    expect(String(out[0]!.content)).not.toContain("[mechanical summary;")
    // Penanda ringan hanya di bukti, ikut ke kompaksi mekanikal berikutnya.
    const next = mechanicalKeepResults(storeOf([...out, { role: "user", content: "lanjut" }]), 1)
    expect(String(next[0]!.content)).toContain("[token-fitted]")
  })
})

test("kompaksi mekanis merangkum tool output di dalam satu turn aktif", () => {
  const messages: Message[] = [
    { role: "user", content: "Audit source files read-only and report findings." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "read-1", name: "read_file", args: { path: "src/core.ts" } }],
    } as Message,
    {
      role: "tool",
      toolCallId: "read-1",
      name: "read_file",
      content: `source evidence ${"x".repeat(8_000)}`,
    },
  ]
  const compacted = createLlmCompaction({ getContextWindowTokens: () => 16_000 }).compact(
    storeOf(messages),
    { keepRecentTurns: 1 },
  )
  expect(compacted).toHaveLength(2)
  expect(compacted[1]).toBe(messages[0]!)
  expect(String(compacted[0]!.content)).toContain("Current task/request")
  expect(String(compacted[0]!.content)).toContain("read_file")
  expect(String(compacted[0]!.content).length).toBeLessThanOrEqual(
    LIMITS.COMPACTION_SUMMARY_MAX_CHARS,
  )
})

describe("F3.1 anti-thrash kompaksi LLM", () => {
  const sig = () => new AbortController().signal
  test("2× tak berprogres beruntun → jalur LLM mati sesi-ini (lempar ke mekanikal)", async () => {
    // P1-2: progres kini diukur dari prefix (scope yang dikirim ke LLM), bukan
    // seluruh store. `convo(10)` + keep=9 dulu dianggap thrash karena 1/20 dari
    // store <10%; dengan denominator prefix, 2→1 = 50% → justru sehat. Thrash
    // asli: prefix SATU pesan diganti ringkasan hampir sepanjang itu — cacah
    // tetap dan token tak turun, dua kali berturut.
    const s = createLlmCompaction({ provider: fakeProvider("S".repeat(110)) })
    const stuck = () => storeOf([{ role: "user", content: "P".repeat(120) }, ...convo(5)])
    await s.compactAsync!(stuck(), { keepRecentTurns: 5 }, sig())
    await s.compactAsync!(stuck(), { keepRecentTurns: 5 }, sig())
    await expect(s.compactAsync!(stuck(), { keepRecentTurns: 5 }, sig())).rejects.toThrow(
      /disabled after thrash/,
    )
  })
  test("P1-2: prefix kecil di store besar tak memicu thrash (denominator = prefix)", async () => {
    // convo(65) = 130 pesan, keep=64 → prefix 2 pesan, ringkasan menggantinya
    // jadi 1. Terhadap store progres cuma ~0,8% (BUG lama → LLM dimatikan),
    // terhadap prefix progres 1/2 = 50% > ambang → LLM tetap aktif 3×.
    const s = createLlmCompaction({ provider: fakeProvider("RINGKASAN PADAT") })
    const big = () => storeOf(convo(65))
    for (let i = 0; i < 3; i++) {
      const out = await s.compactAsync!(big(), { keepRecentTurns: 64 }, sig())
      expect(String(out[0]!.content)).toContain("RINGKASAN PADAT")
      expect(out).toHaveLength(129)
    }
  })
  test("ringkasan jauh lebih pendek dari prefix → progres token me-reset streak", async () => {
    // Prefix satu pesan besar (30 token estimator) → ringkasan pendek + header
    // (~24 token). Urutan: rendah → TINGGI → rendah. Kalau streak tak di-reset,
    // putaran ketiga membuat 2× rendah dan LLM mati; dengan reset tetap hidup.
    let call = 0
    const provider = {
      id: "seq",
      models: ["m"],
      async *stream() {
        const texts = ["S".repeat(110), "RINGKASAN", "S".repeat(110)]
        yield { type: "text" as const, text: texts[Math.min(call++, texts.length - 1)]! }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never
    const s = createLlmCompaction({ provider })
    const small = () => storeOf([{ role: "user", content: "P".repeat(120) }, ...convo(5)])
    await s.compactAsync!(small(), { keepRecentTurns: 5 }, sig())
    await s.compactAsync!(small(), { keepRecentTurns: 5 }, sig())
    const out = await s.compactAsync!(small(), { keepRecentTurns: 5 }, sig())
    expect(String(out[0]!.content)).toContain("S".repeat(110))
  })
  test("kompaksi berprogres me-reset streak (tak pernah dimatikan)", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("RINGKASAN PADAT") })
    const wide = () => storeOf(convo(6))
    // progres 6/12 = 50% tiap kali → streak tak pernah mencapai 2.
    for (let i = 0; i < 4; i++) {
      const out = await s.compactAsync!(wide(), { keepRecentTurns: 2 }, sig())
      expect(String(out[0]!.content)).toContain("RINGKASAN PADAT")
    }
  })
  test("no-op (tak ada yang bisa dibuang) bukan thrash", async () => {
    const s = createLlmCompaction({ provider: fakeProvider("TAK DIPAKAI") })
    // keep ≥ isi → early-return tanpa panggilan LLM, berulang-ulang aman.
    for (let i = 0; i < 4; i++) {
      const out = await s.compactAsync!(storeOf(convo(1)), { keepRecentTurns: 5 }, sig())
      expect(out.length).toBe(2)
    }
  })
})

describe("F3.2 parseCompactKeepTurns", () => {
  test("bilangan ≥1 dipakai; kosong/invalid → undefined (default kernel)", () => {
    expect(parseCompactKeepTurns(undefined)).toBeUndefined()
    expect(parseCompactKeepTurns("")).toBeUndefined()
    expect(parseCompactKeepTurns("  ")).toBeUndefined()
    expect(parseCompactKeepTurns("4")).toBe(4)
    expect(parseCompactKeepTurns(" 7 ")).toBe(7)
    expect(parseCompactKeepTurns("0")).toBeUndefined()
    expect(parseCompactKeepTurns("-2")).toBeUndefined()
    expect(parseCompactKeepTurns("2.5")).toBeUndefined()
    expect(parseCompactKeepTurns("banyak")).toBeUndefined()
    expect(parseCompactKeepTurns("Infinity")).toBeUndefined()
  })
})

describe("R9 summaryCharBudgetForWindow (pagu ringkasan ikut jendela)", () => {
  test("nilai tak-terdefinisi/negatif → lantai (perilaku lama)", () => {
    expect(summaryCharBudgetForWindow(undefined)).toBe(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(summaryCharBudgetForWindow(0)).toBe(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(summaryCharBudgetForWindow(-1)).toBe(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    expect(summaryCharBudgetForWindow(Number.NaN)).toBe(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
  })
  test("jendela kecil tetap di lantai, jendela besar naik hingga atap", () => {
    const min = LIMITS.COMPACTION_SUMMARY_MAX_CHARS
    const max = LIMITS.COMPACTION_SUMMARY_SCALED_MAX_CHARS
    // 32K token → 1.280 char → diklem lantai.
    expect(summaryCharBudgetForWindow(32_000)).toBe(min)
    // 128K → 5.120 char (naik dari lantai).
    expect(summaryCharBudgetForWindow(131_072)).toBeGreaterThan(min)
    // 1M → 40.000 → diklem atap.
    expect(summaryCharBudgetForWindow(1_000_000)).toBe(max)
  })
  test("hasil selalu di dalam [min, max] untuk rentang jendela", () => {
    const min = LIMITS.COMPACTION_SUMMARY_MAX_CHARS
    const max = LIMITS.COMPACTION_SUMMARY_SCALED_MAX_CHARS
    for (const w of [1, 10_000, 32_000, 100_000, 200_000, 1_000_000, 2_000_000]) {
      const b = summaryCharBudgetForWindow(w)
      expect(b).toBeGreaterThanOrEqual(min)
      expect(b).toBeLessThanOrEqual(max)
    }
  })
})

describe("R10 summaryInputCharBudget (input summarizer ikut jendela)", () => {
  test("nilai tak-terdefinisi/negatif → lantai 6k (perilaku lama)", () => {
    expect(summaryInputCharBudget(undefined)).toBe(LIMITS.COMPACTION_LLM_INPUT_MIN_CHARS)
    expect(summaryInputCharBudget(0)).toBe(LIMITS.COMPACTION_LLM_INPUT_MIN_CHARS)
    expect(summaryInputCharBudget(-1)).toBe(LIMITS.COMPACTION_LLM_INPUT_MIN_CHARS)
    expect(summaryInputCharBudget(Number.NaN)).toBe(LIMITS.COMPACTION_LLM_INPUT_MIN_CHARS)
  })
  test("jendela kecil tetap di lantai, jendela besar naik hingga atap", () => {
    const min = LIMITS.COMPACTION_LLM_INPUT_MIN_CHARS
    const max = LIMITS.COMPACTION_LLM_INPUT_SCALED_MAX_CHARS
    expect(summaryInputCharBudget(32_000)).toBe(min)
    expect(summaryInputCharBudget(131_072)).toBeGreaterThan(min)
    expect(summaryInputCharBudget(1_000_000)).toBe(max)
  })
  test("input selalu ≥ output (summarizer membaca lebih banyak dari yang diminta)", () => {
    for (const w of [32_000, 100_000, 131_072, 200_000, 1_000_000, 2_000_000]) {
      expect(summaryInputCharBudget(w)).toBeGreaterThanOrEqual(summaryCharBudgetForWindow(w))
    }
  })
})
