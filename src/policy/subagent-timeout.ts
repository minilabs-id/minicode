/**
 * Timeout adaptif untuk satu turn sub-agent.
 *
 * KENAPA adaptif: satu angka tetap (dulu 120s, kini 300s) salah di dua arah
 * sekaligus. Prompt pendek ("cari file X") tak perlu menunggu 5 menit penuh
 * sebelum watchdog sempat mengambil alih; sebaliknya prompt panjang (banyak
 * file, konteks besar) sering memang butuh lebih dari 5 menit. Tangga yang
 * mengikuti ukuran prompt + pengalaman anak sebelumnya memberi pagu yang
 * proporsional TANPA menghapus backstop.
 *
 * KENAPA basisnya `LIMITS.SUB_AGENT_TIMEOUT_MS`, bukan literal 300_000: env
 * `MINICODE_SUB_AGENT_TIMEOUT_MS` sudah di-resolve di `constants.ts`. Memakai
 * konstanta itu sebagai basis membuat override operator tetap dihormati —
 * tangga diskalakan relatif terhadapnya, bukan menimpaannya.
 *
 * Modul ini MURNI (tanpa I/O, tanpa state global) supaya bisa diuji langsung
 * dan dipakai ulang, mengikuti gaya `src/policy/step-escalation.ts`.
 */

import { LIMITS } from "../constants.ts"

/** Lantai absolut: di bawah ini anak tak sempat menyelesaikan satu langkah. */
export const SUB_AGENT_TIMEOUT_MIN_MS = 30_000

/** Ambang panjang prompt (code-unit UTF-16, sama dengan `String.length`). */
const SHORT_PROMPT_CHARS = 2_000
const LONG_PROMPT_CHARS = 10_000

/**
 * Faktor tangga terhadap basis. 0.6/1.6 memberi 180s/480s saat basis 300s,
 * tapi ikut naik-turun saat operator meng-override env — itulah yang dimaksud
 * "env override tetap dihormati".
 */
const SHORT_PROMPT_RATIO = 0.6
const LONG_PROMPT_RATIO = 1.6

/** Anak yang sudah sukses cepat tak perlu pagu penuh di pemanggilan berikutnya. */
const FAST_PRIOR_MS = 60_000
const FAST_PRIOR_FACTOR = 2

/** Observasi dari pemanggilan anak sebelumnya (opsional). */
export interface SubAgentTimeoutPrior {
  steps: number
  durationMs: number
  success: boolean
}

export interface ResolveSubAgentTimeoutInput {
  promptLength: number
  /** Nilai eksplisit dari caller (`timeoutMs`); menang atas tangga bila valid. */
  explicitMs?: number
  prior?: SubAgentTimeoutPrior
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * Hitung timeout turn sub-agent dalam ms, selalu terkurung di
 * `[SUB_AGENT_TIMEOUT_MIN_MS, LIMITS.MAX_TIMER_DELAY_MS]`.
 *
 * Urutan prioritas: `explicitMs` yang valid > tangga panjang prompt > basis
 * env. Pembatasan `prior` (sukses cepat) diterapkan terakhir dan TIDAK pernah
 * menaikkan nilai — hanya memotong pagu yang terlalu longgar.
 */
export function resolveSubAgentTimeout(input: ResolveSubAgentTimeoutInput): number {
  const base = boundedNumber(LIMITS.SUB_AGENT_TIMEOUT_MS) ?? 300_000
  const explicit = boundedNumber(input.explicitMs)
  let candidate: number

  if (explicit !== undefined) {
    // Caller boleh memperpanjang explorer lambat — tapi tetap tak boleh
    // melewati batas timer JS (di bawah ini timer berubah jadi 1 ms).
    candidate = explicit
  } else {
    const len = boundedNumber(input.promptLength) ?? 0
    const ratio =
      len < SHORT_PROMPT_CHARS
        ? SHORT_PROMPT_RATIO
        : len > LONG_PROMPT_CHARS
          ? LONG_PROMPT_RATIO
          : 1
    candidate = Math.round(base * ratio)
  }

  const prior = input.prior
  if (
    prior?.success === true &&
    // `steps > 0` menjaga agar "sukses" tanpa satu langkah pun (data rusak)
    // tak memotong pagu secara absolut — hasil tanpa kerja bukan bukti cepat.
    (boundedNumber(prior.steps) ?? 0) > 0
  ) {
    const fast = boundedNumber(prior.durationMs)
    if (fast !== undefined && fast < FAST_PRIOR_MS)
      candidate = Math.min(candidate, Math.round(fast * FAST_PRIOR_FACTOR))
  }

  return Math.min(Math.max(candidate, SUB_AGENT_TIMEOUT_MIN_MS), LIMITS.MAX_TIMER_DELAY_MS)
}
