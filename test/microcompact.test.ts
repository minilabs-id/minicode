// Test microcompact — pemangkasan ISI hasil tool lama.
//
// Empat invariant yang dijaga (semuanya universal, tanpa menyebut model):
// 1. Pasangan `assistant(toolCalls)` → `tool` tidak boleh terpisah/rusak.
// 2. Hasil tool terbaru tetap utuh.
// 3. Tool kontrol-sesi (tak dapat dipulihkan) tak pernah dipangkas.
// 4. Pemangkasan hanya terjadi bila hematnya berarti (gating tiga syarat).
import { describe, expect, test } from "bun:test"
import { createLlmCompaction } from "../src/policy/compaction.ts"
import {
  applyMicrocompact,
  MICROCOMPACT_RECOVERABLE_TOOLS,
  MICROCOMPACT_SENTINEL_PREFIX,
} from "../src/policy/microcompact.ts"
import type { Message } from "../vendor/minicore/src/core/types.ts"

const est = (text: string) => Math.ceil(text.length / 4)

/** Bangun percakapan: satu user, N pasang assistant(toolCalls)+tool. */
function buildTurns(
  count: number,
  opts: { toolName?: string; payloadChars?: number } = {},
): Message[] {
  const name = opts.toolName ?? "read_file"
  const chars = opts.payloadChars ?? 40_000
  const out: Message[] = [{ role: "user", content: "mulai" }]
  for (let i = 0; i < count; i++) {
    const id = `call-${i}`
    out.push({
      role: "assistant",
      content: `langkah ${i}`,
      toolCalls: [{ id, name, args: { path: `f${i}.txt` } }],
    })
    out.push({ role: "tool", toolCallId: id, name, content: "x".repeat(chars) })
  }
  return out
}

describe("applyMicrocompact: jumlah yang dipertahankan", () => {
  test("hasil tool terbaru (keepRecent=5) tetap utuh", () => {
    const messages = buildTurns(12)
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    expect(r.clearedCount).toBeGreaterThan(0)
    // Lima hasil tool terakhir harus masih berisi payload asli.
    const tools = r.messages.filter((m) => m.role === "tool")
    for (const m of tools.slice(-5)) {
      expect(String(m.content).startsWith(MICROCOMPACT_SENTINEL_PREFIX)).toBe(false)
    }
  })

  test("hasil tool lama diganti sentinel yang menyebut cara mengambil ulang", () => {
    const messages = buildTurns(12)
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    const first = r.messages.filter((m) => m.role === "tool")[0]!
    expect(String(first.content).startsWith(MICROCOMPACT_SENTINEL_PREFIX)).toBe(true)
    expect(String(first.content)).toMatch(/Jalankan ulang/)
  })

  test("idempoten: menjalankan ulang tidak memangkas sentinel lagi", () => {
    const messages = buildTurns(12)
    const once = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    const twice = applyMicrocompact(once.messages, { estimateTokens: est, keepRecent: 5 })
    expect(twice.clearedCount).toBe(0)
  })

  test("input tidak dimutasi", () => {
    const messages = buildTurns(12)
    const snapshot = messages.map((m) => String(m.content).length)
    applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    expect(messages.map((m) => String(m.content).length)).toEqual(snapshot)
  })
})

describe("applyMicrocompact: pasangan assistant→tool tidak rusak", () => {
  test("setiap toolCallId tetap punya pesan tool setelah pemangkasan", () => {
    const messages = buildTurns(12)
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    const callIds = new Set<string>()
    for (const m of r.messages) {
      if (m.role === "assistant") for (const c of m.toolCalls ?? []) callIds.add(c.id)
    }
    const resultIds = new Set(r.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId))
    expect(resultIds.size).toBe(callIds.size)
    for (const id of callIds) expect(resultIds.has(id)).toBe(true)
  })

  test("jumlah pesan tidak berubah (memangkas ISI, bukan membuang pesan)", () => {
    const messages = buildTurns(12)
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    expect(r.messages.length).toBe(messages.length)
  })

  test("batch tool aktif (grup tool terakhir) tak dipangkas", () => {
    const messages = buildTurns(10)
    // Tambah satu assistant terakhir dengan 3 tool call, dua sudah punya hasil.
    messages.push({
      role: "assistant",
      content: "batch aktif",
      toolCalls: [
        { id: "live-1", name: "grep", args: {} },
        { id: "live-2", name: "grep", args: {} },
      ],
    })
    messages.push({ role: "tool", toolCallId: "live-1", name: "grep", content: "y".repeat(40_000) })
    messages.push({ role: "tool", toolCallId: "live-2", name: "grep", content: "y".repeat(40_000) })
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 1 })
    for (const id of ["live-1", "live-2"]) {
      const msg = r.messages.find((m) => m.role === "tool" && m.toolCallId === id)
      expect(String(msg?.content).startsWith(MICROCOMPACT_SENTINEL_PREFIX)).toBe(false)
    }
  })
})

describe("applyMicrocompact: tool kontrol tak pernah dipangkas", () => {
  test("daftar tool yang dapat dipulihkan tidak memuat tool kontrol-sesi", () => {
    for (const control of ["todo", "memory", "memory_search", "todo_write"]) {
      expect(MICROCOMPACT_RECOVERABLE_TOOLS.has(control)).toBe(false)
    }
  })

  test("hasil tool kontrol tetap utuh meski tua dan besar", () => {
    const messages: Message[] = [{ role: "user", content: "mulai" }]
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: "assistant",
        content: `s${i}`,
        toolCalls: [{ id: `t${i}`, name: "todo", args: {} }],
      })
      messages.push({
        role: "tool",
        toolCallId: `t${i}`,
        name: "todo",
        content: "z".repeat(40_000),
      })
    }
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 1 })
    expect(r.clearedCount).toBe(0)
    expect(r.skippedReason).toBe("no-candidates")
  })
})

describe("applyMicrocompact: gating tiga syarat", () => {
  test("hemat di bawah minSaving → batal (tak membuang fakta demi sedikit token)", () => {
    // 8 hasil tool kecil: kandidat ada, tapi hematnya jauh di bawah 20k token.
    const messages = buildTurns(8, { payloadChars: 200 })
    const r = applyMicrocompact(messages, {
      estimateTokens: est,
      keepRecent: 2,
      minSavingTokens: 20_000,
    })
    expect(r.clearedCount).toBe(0)
    expect(r.skippedReason).toBe("below-saving")
    expect(r.messages).toBe(messages)
  })

  test("hasil tool tidak mendominasi budget → batal", () => {
    const messages = buildTurns(12, { payloadChars: 40_000 })
    const r = applyMicrocompact(messages, {
      estimateTokens: est,
      keepRecent: 5,
      budgetTokens: 10_000_000, // budget raksasa: tool hanya sebagian kecil
      minToolShare: 0.4,
    })
    expect(r.clearedCount).toBe(0)
    expect(r.skippedReason).toBe("below-share")
  })

  test("semua syarat terpenuhi → benar-benar hemat token", () => {
    const messages = buildTurns(12, { payloadChars: 40_000 })
    const before = messages.reduce((s, m) => s + est(String(m.content)), 0)
    const r = applyMicrocompact(messages, {
      estimateTokens: est,
      keepRecent: 5,
      budgetTokens: 200_000,
    })
    const after = r.messages.reduce((s, m) => s + est(String(m.content)), 0)
    expect(r.clearedCount).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
    expect(r.savedTokens).toBeGreaterThan(0)
  })
})

// Celah yang ditemukan saat remediasi OBSERVATION.md: sentinel selalu
// menyuruh "jalankan ulang", padahal `bash` dapat memutasi workspace.
// Mengulang perintah yang sudah dieksekusi bisa menduplikasi efek destructif.
describe("applyMicrocompact: instruksi sentinel sadar-mutasi", () => {
  test("tool baca tetap menyuruh menjalankan ulang (aman, idempoten)", () => {
    const messages = buildTurns(12, { toolName: "read_file" })
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    const first = r.messages.filter((m) => m.role === "tool")[0]!
    expect(String(first.content)).toMatch(/Jalankan ulang/)
    expect(String(first.content)).not.toMatch(/JANGAN jalankan ulang/)
  })

  test("bash TIDAK menyuruh menjalankan ulang: verifikasi state lebih dulu", () => {
    const messages = buildTurns(12, { toolName: "bash" })
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    expect(r.clearedCount).toBeGreaterThan(0)
    const first = r.messages.filter((m) => m.role === "tool")[0]!
    const text = String(first.content)
    expect(text.startsWith(MICROCOMPACT_SENTINEL_PREFIX)).toBe(true)
    expect(text).toMatch(/JANGAN jalankan ulang/)
    expect(text).not.toMatch(/Jalankan ulang tool ini bila isinya masih dibutuhkan/)
  })

  test("bash yang gagal tetap memperingatkan duplikasi efek", () => {
    const messages = buildTurns(12, { toolName: "bash" })
    // Tandai semua hasil bash lama sebagai gagal.
    for (const m of messages) {
      if (m.role === "tool") (m as { isError?: boolean }).isError = true
    }
    const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
    const first = r.messages.filter((m) => m.role === "tool")[0]!
    const text = String(first.content)
    expect(text).toMatch(/gagal/)
    expect(text).toMatch(/JANGAN jalankan ulang/)
  })

  test("tool baca yang terdaftar kontrak tetap aman diulang", () => {
    // Hanya tool yang TERDAFTAR di registry kontrak dengan journalMutation=false
    // yang dijamin idempoten. `list_dir` sengaja tidak diuji di sini: ia tidak
    // ada di registry, jadi klasifikasinya `unknown` → fail-closed → dianggap
    // bisa memutasi. Itu perilaku yang benar, bukan celah.
    for (const name of ["grep", "glob", "read_file", "web_search"]) {
      const messages = buildTurns(12, { toolName: name })
      const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
      const first = r.messages.filter((m) => m.role === "tool")[0]!
      expect(String(first.content)).toMatch(/Jalankan ulang/)
    }
  })

  test("tool tak terdaftar di daftar recoverable tidak pernah dipangkas", () => {
    // `list_dir`/`view_file` dulu ada di daftar manual sebagai tool FIKTIF
    // (tidak pernah ada di registry). Sekarang daftar diturunkan dari kontrak,
    // jadi nama asing tidak lagi dianggap dapat dipulihkan.
    for (const name of ["list_dir", "view_file", "tidak_ada_tool"]) {
      expect(MICROCOMPACT_RECOVERABLE_TOOLS.has(name)).toBe(false)
      const messages = buildTurns(12, { toolName: name })
      const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
      expect(r.clearedCount).toBe(0)
      expect(r.skippedReason).toBe("no-candidates")
    }
  })

  test("tool baca yang dulu hilang dari daftar kini ikut dipangkas", () => {
    // `git_diff` bisa 500k karakter; sebelumnya tak pernah menyusut karena
    // daftar manualnya tidak memuatnya.
    for (const name of ["git_diff", "git_log", "git_status", "read_image"]) {
      expect(MICROCOMPACT_RECOVERABLE_TOOLS.has(name)).toBe(true)
      const messages = buildTurns(12, { toolName: name })
      const r = applyMicrocompact(messages, { estimateTokens: est, keepRecent: 5 })
      expect(r.clearedCount).toBeGreaterThan(0)
    }
  })

  test("createLlmCompaction.microcompact menyusutkan jendela 32k (skala budgetTokens)", () => {
    // 8 tool result * 12k char (~3k token/hasil = ~24k token) pada jendela 32k:
    // keepRecent=5 menyisakan 3 kandidat (~9k token saving < 20k konstanta keras).
    const messages = buildTurns(8, { toolName: "read_file", payloadChars: 12_000 })
    const strategy = createLlmCompaction()
    const trimmed = strategy.microcompact!({ messages } as never, { budgetTokens: 32_000 })
    expect(trimmed).not.toBe(messages)
    const prunedCount = trimmed.filter(
      (m) => m.role === "tool" && String(m.content).startsWith(MICROCOMPACT_SENTINEL_PREFIX),
    ).length
    // keepRecent=5 + 1 hasil pada batch assistant terakhir = 2 kandidat lama dipangkas.
    expect(prunedCount).toBe(2)
  })
})
