// [T-009 OBSERVATION.md] Kebijakan pemulihan provider.
//
// Riwayat penting: versi pertama perbaikan memberi ANGKA SENDIRI pada retry
// provider (5 percobaan) dan pada resume turn (2 resume, 3+10 dtk). Karena
// keduanya lapisan berbeda, biayanya BERKALI — provider yang mati menahan user
// ~82 dtk, padahal sebelum perubahan hanya 7 dtk. Tes di bawah mengunci desain
// penggantinya: SATU anggaran waktu + SATU kuota percobaan untuk keduanya.

import { describe, expect, test } from "bun:test"
import { ProviderError } from "#minicore"
import {
  cappedRecovery,
  createRecoveryLedger,
  createSessionRecoveryPolicy,
  RATE_LIMIT_RETRY_ATTEMPTS,
} from "../src/app/session.ts"
import { decideAutoResume } from "../src/policy/auto-resume.ts"
import {
  fullJitterDelay,
  isRecoverable,
  planRecovery,
  RECOVERY_ATTEMPT_QUOTA,
  RECOVERY_BASE_DELAY_MS,
  RECOVERY_BUDGET_MS,
  RECOVERY_MAX_DELAY_MS,
  RECOVERY_MIN_DELAY_MS,
  recoveryDelay,
} from "../src/policy/recovery-budget.ts"

/** Jam palsu agar uji deterministik (modul ini tidak boleh membaca Date.now). */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

describe("klasifikasi: apa yang layak dipulihkan", () => {
  test("5xx dan gangguan jaringan layak; 529 overload dipetakan ke server", () => {
    expect(isRecoverable({ category: "server" })).toBe(true)
    expect(isRecoverable({ category: "network" })).toBe(true)
  })

  test("kegagalan terminal TIDAK layak, dan itu keputusan yang disengaja", () => {
    for (const category of ["auth", "invalid_request", "context_length_exceeded"]) {
      expect(isRecoverable({ category })).toBe(false)
    }
  })

  test("429 tidak dipulihkan di lapisan ini: dua wajahnya tidak bisa dibedakan", () => {
    // Wajah pertama: rate limit biasa, sudah ditangani retry yang menghormati
    // Retry-After. Wajah kedua: spend cap permanen (Anthropic tanpa header,
    // OpenAI credit_balance_exhausted). Mengulang tidak menolong keduanya.
    expect(isRecoverable({ category: "rate_limit" })).toBe(false)
  })

  test("abort user dan pagar lokal tidak pernah dipulihkan", () => {
    expect(isRecoverable({ category: "server", abortedByUser: true })).toBe(false)
    for (const kind of ["aborted", "budget_exceeded", "max_turns", "max_steps_exceeded"]) {
      expect(isRecoverable({ kind })).toBe(false)
    }
  })

  test("kategori menang atas kind=provider", () => {
    // `kind:"provider"` hanya bilang "dari penyedia", bukan "sementara".
    // HTTP 400 juga provider-kind; mengulangnya hanya menggandakan ongkos.
    expect(isRecoverable({ category: "invalid_request", kind: "provider" })).toBe(false)
    // Kind tetap berguna bila kategori tidak terbawa sama sekali.
    expect(isRecoverable({ kind: "provider" })).toBe(true)
  })
})

describe("jeda: jitter dan plafon", () => {
  test("full jitter berada dalam [min, cap]", () => {
    for (const r of [0, 0.25, 0.5, 1]) {
      const d = fullJitterDelay(4_000, () => r)
      expect(d).toBeGreaterThanOrEqual(RECOVERY_MIN_DELAY_MS)
      expect(d).toBeLessThanOrEqual(4_000)
    }
  })

  test("jitter menghasilkan sebaran, bukan nilai pasti (anti thundering herd)", () => {
    const values = new Set<number>()
    for (const r of [0.1, 0.3, 0.55, 0.9]) values.add(fullJitterDelay(8_000, () => r))
    expect(values.size).toBe(4)
  })

  test("backoff eksponensial tumbuh lalu di-cap", () => {
    // Tanpa jitter (random = 1) agar nilai batas atasnya bisa diperiksa.
    const one = () => 1
    expect(recoveryDelay(1, undefined, one)).toBe(RECOVERY_BASE_DELAY_MS)
    expect(recoveryDelay(2, undefined, one)).toBe(RECOVERY_BASE_DELAY_MS * 2)
    expect(recoveryDelay(9, undefined, one)).toBe(RECOVERY_MAX_DELAY_MS)
  })

  test("Retry-After diperlakukan sebagai FLOOR, bukan target", () => {
    // Provider minta 5 dtk sementara backoff menebak 500 ms → tunggu 5 dtk.
    expect(recoveryDelay(1, 5_000, () => 1)).toBe(5_000)
    // Provider minta lebih cepat dari backoff → backoff yang dipakai, karena
    // jitter tidak boleh membuat kita lebih cepat daripada perhitungan sendiri.
    expect(recoveryDelay(4, 100, () => 1)).toBeGreaterThan(100)
  })
})

describe("anggaran bersama: biaya tidak boleh BERKALI antar lapisan", () => {
  test("kuota membatasi jumlah percobaan total", () => {
    const clock = fakeClock()
    const state = { startedAtMs: clock.now(), nowMs: clock.now(), attemptsUsed: 0 }
    let attempts = 0
    for (;;) {
      const d = planRecovery({ category: "server" }, state, { hasPrompt: true, random: () => 0 })
      if (d.action === "stop") {
        expect(d.reason).toBe("attempts-exhausted")
        break
      }
      attempts = d.attempt
      state.attemptsUsed = d.attempt
      clock.advance(d.delayMs)
      state.nowMs = clock.now()
    }
    expect(attempts).toBe(RECOVERY_ATTEMPT_QUOTA)
  })

  test("anggaran waktu menghentikan walau kuota masih tersisa", () => {
    const d = planRecovery(
      { category: "server" },
      { startedAtMs: 0, nowMs: RECOVERY_BUDGET_MS, attemptsUsed: 1 },
      { hasPrompt: true, random: () => 1 },
    )
    expect(d).toEqual({ action: "stop", reason: "budget-exhausted" })
  })

  test("pemulihan total SELALU di bawah anggaran waktu", () => {
    // Inti perbaikan: apa pun urutan kwitansi/retry-nya, total jeda tidak bisa
    // melewati anggaran. Inilah yang membuat biaya konstan (bukan 82 dtk).
    const clock = fakeClock()
    const state = { startedAtMs: clock.now(), nowMs: clock.now(), attemptsUsed: 0 }
    let total = 0
    for (;;) {
      const d = planRecovery({ category: "network" }, state, {
        hasPrompt: true,
        random: () => 1,
      })
      if (d.action === "stop") break
      total += d.delayMs
      state.attemptsUsed = d.attempt
      clock.advance(d.delayMs)
      state.nowMs = clock.now()
    }
    expect(total).toBeLessThanOrEqual(RECOVERY_BUDGET_MS)
  })

  test("ledger dipakai bersama: retry dan resume berbagi kuota yang sama", () => {
    // Skenario nyata yang dulu menghasilkan 82 dtk: beberapa retry provider
    // lalu resume turn. Dengan ledger bersama, keduanya memotong kuota yang
    // sama sehingga total percobaan tetap ≤ kuota.
    const clock = fakeClock()
    const ledger = createRecoveryLedger(clock.now)
    let used = 0
    for (;;) {
      const next = ledger.nextDelay({ category: "server" })
      if (next === null) break
      used = next.attempt
      clock.advance(next.delayMs)
      if (used > RECOVERY_ATTEMPT_QUOTA + 1) throw new Error("kuota bocor")
    }
    expect(used).toBe(RECOVERY_ATTEMPT_QUOTA)
    expect(ledger.attemptsUsed()).toBe(RECOVERY_ATTEMPT_QUOTA)
  })

  test("ledger berhenti cepat saat provider mati: jauh di bawah anggaran penuh", () => {
    // Provider yang mati permanen harus gagal CEPAT. Versi lama menahan 82 dtk;
    // sekarang dibatasi kuota (jitter = 0 agar angka deterministik).
    const clock = fakeClock()
    const ledger = createRecoveryLedger(clock.now)
    let waited = 0
    for (;;) {
      const next = ledger.nextDelay({ category: "server" })
      if (next === null) break
      waited += next.delayMs
      clock.advance(next.delayMs)
    }
    expect(waited).toBeLessThanOrEqual(RECOVERY_BUDGET_MS)
    expect(waited).toBeLessThan(30_000)
  })

  test("Retry-After besar yang melebihi sisa anggaran langsung berhenti", () => {
    expect(
      planRecovery(
        { category: "server", retryAfterMs: RECOVERY_MAX_DELAY_MS },
        { startedAtMs: 0, nowMs: RECOVERY_BUDGET_MS - 1_000, attemptsUsed: 1 },
        { hasPrompt: true, random: () => 1 },
      ),
    ).toEqual({ action: "stop", reason: "budget-exhausted" })
  })
})

describe("planRecovery: urutan pemeriksaan", () => {
  const fresh = (): { startedAtMs: number; nowMs: number; attemptsUsed: number } => ({
    startedAtMs: 0,
    nowMs: 0,
    attemptsUsed: 0,
  })

  test("tanpa prompt tidak ada yang bisa dilanjutkan", () => {
    expect(planRecovery({ category: "server" }, fresh(), { hasPrompt: false })).toEqual({
      action: "stop",
      reason: "no-prompt",
    })
  })

  test("abort user mengalahkan segalanya", () => {
    expect(
      planRecovery({ category: "server", abortedByUser: true }, fresh(), { hasPrompt: true }),
    ).toEqual({ action: "stop", reason: "user-abort" })
    expect(planRecovery({ kind: "aborted" }, fresh(), { hasPrompt: true })).toEqual({
      action: "stop",
      reason: "user-abort",
    })
  })

  test("anggaran BIAYA habis bukan gangguan: berhenti sebelum menghitung waktu", () => {
    expect(
      planRecovery({ category: "server" }, fresh(), {
        hasPrompt: true,
        costBudgetExhausted: true,
      }),
    ).toEqual({ action: "stop", reason: "cost-budget" })
  })

  test("diagnosis terminal berhenti sebelum kuota diperiksa", () => {
    expect(
      planRecovery(
        { category: "auth" },
        { startedAtMs: 0, nowMs: 0, attemptsUsed: 99 },
        {
          hasPrompt: true,
        },
      ),
    ).toEqual({ action: "stop", reason: "not-transient" })
  })
})

describe("retry provider (cappedRecovery) memakai anggaran yang sama", () => {
  test("5xx di-retry dengan jeda ber-jitter yang berhingga", () => {
    for (let attempt = 1; attempt <= RECOVERY_ATTEMPT_QUOTA; attempt++) {
      const action = cappedRecovery.onError(new ProviderError("server", "503"), attempt)
      expect(action.type).toBe("retry")
      if (action.type === "retry") {
        expect(action.delayMs).toBeGreaterThanOrEqual(RECOVERY_MIN_DELAY_MS)
        expect(action.delayMs).toBeLessThanOrEqual(RECOVERY_MAX_DELAY_MS)
      }
    }
  })

  test("kuota benar-benar menghentikan retry (fail fast)", () => {
    const over = cappedRecovery.onError(
      new ProviderError("server", "503"),
      RECOVERY_ATTEMPT_QUOTA + 1,
    )
    expect(over.type).toBe("throw")
  })

  test("429 memakai plafon lebih ketat dan menghormati Retry-After", () => {
    const first = cappedRecovery.onError(new ProviderError("rate_limit", "429", 2_000), 1)
    expect(first.type).toBe("retry")
    if (first.type === "retry") expect(first.delayMs).toBeGreaterThanOrEqual(2_000)
    const over = cappedRecovery.onError(
      new ProviderError("rate_limit", "429"),
      RATE_LIMIT_RETRY_ATTEMPTS + 1,
    )
    expect(over.type).toBe("throw")
  })

  test("retryAfter Infinity/NaN/negatif tidak menjadi hot retry", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const action = cappedRecovery.onError(new ProviderError("server", "503", bad), 1)
      expect(action.type).toBe("retry")
      if (action.type === "retry") {
        expect(Number.isFinite(action.delayMs)).toBe(true)
        expect(action.delayMs).toBeGreaterThan(0)
      }
    }
  })

  test("kegagalan terminal tidak di-retry", () => {
    expect(cappedRecovery.onError(new ProviderError("auth", "401"), 1).type).toBe("throw")
    expect(cappedRecovery.onError(new ProviderError("invalid_request", "400"), 1).type).toBe(
      "throw",
    )
  })

  test("konteks kehabisan tetap lewat jalur compaction", () => {
    const action = cappedRecovery.onError(new ProviderError("context_length_exceeded", "full"), 1)
    expect(action.type).toBe("force_compact_and_retry")
  })

  test("session recovery policy berbagi kuota & jam 45 dtk dengan RecoveryLedger luar", () => {
    let clock = 1_000
    const ledger = createRecoveryLedger(() => clock)
    const policy = createSessionRecoveryPolicy(() => ledger)

    // 3 percobaan retry provider mengonsumsi kuota ledger yang sama.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const a = policy.onError(new ProviderError("server", "503"), attempt)
      expect(a.type).toBe("retry")
    }
    expect(ledger.attemptsUsed()).toBe(3)

    // Lewati anggaran waktu 45 dtk -> retry berikutnya dan decideAutoResume/ledger
    // langsung berhenti (tidak ada retry wave kedua).
    clock += RECOVERY_BUDGET_MS + 1
    expect(policy.onError(new ProviderError("server", "503"), 4).type).toBe("throw")
    expect(ledger.nextDelay({ category: "server" })).toBeNull()

    // Non-recoverable (context_length_exceeded) tetap dialihkan ke compaction.
    expect(policy.onError(new ProviderError("context_length_exceeded", "full"), 1).type).toBe(
      "force_compact_and_retry",
    )
  })
})

describe("decideAutoResume: pembungkus tipis, tanpa angka sendiri", () => {
  test("tidak ada lagi konstanta jumlah resume terpisah", () => {
    // Pagar lama (MAX_AUTO_RESUMES = 2) itulah yang mengalikan biaya dengan
    // kuota retry. Sekarang seluruh keputusan didelegasikan ke anggaran bersama.
    const mod = require("../src/policy/auto-resume.ts") as Record<string, unknown>
    expect(mod.MAX_AUTO_RESUMES).toBeUndefined()
    expect(mod.AUTO_RESUME_DELAYS_MS).toBeUndefined()
  })

  test("kegagalan transien di-resume", () => {
    const d = decideAutoResume({ category: "server" }, 0)
    expect(d.action).toBe("retry")
  })

  test("kuota bersama berlaku juga untuk resume", () => {
    expect(decideAutoResume({ category: "server" }, RECOVERY_ATTEMPT_QUOTA)).toEqual({
      action: "stop",
      reason: "attempts-exhausted",
    })
  })

  test("anggaran biaya dan abort tidak pernah di-resume", () => {
    expect(
      decideAutoResume({ category: "server" }, 0, { hasPrompt: true, budgetExhausted: true }),
    ).toEqual({ action: "stop", reason: "cost-budget" })
    expect(decideAutoResume({ category: "server", abortedByUser: true }, 0)).toEqual({
      action: "stop",
      reason: "user-abort",
    })
  })
})
