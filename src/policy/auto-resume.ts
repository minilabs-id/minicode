/**
 * Resume turn otomatis setelah turn gagal karena penyedia.
 *
 * ── Kenapa dulu dipisah, sekarang tidak ─────────────────────────────────────
 * Versi pertama modul ini punya angka sendiri (`MAX_AUTO_RESUMES = 2`, jeda
 * 3 dtk + 10 dtk) dan angka itu TERPISAH dari anggaran retry provider. Hasilnya
 * biaya BERKALI: 5 percobaan retry × 3 percobaan turn ≈ 82 detik penundaan untuk
 * provider yang mati permanen, karena tiap resume mengulang seluruh retry dari
 * nol. Itulah *retry amplification* — anti-pattern yang sama yang membuat
 * insiden awal terasa seperti "provider rusak".
 *
 * Karena itu keputusan di sini TIDAK lagi punya angka sendiri: seluruhnya
 * didelegasikan ke {@link planRecovery} di `recovery-budget.ts`, yang memegang
 * SATU anggaran waktu dan SATU kuota percobaan untuk retry provider maupun
 * resume turn. Satu panggilan logis, satu anggaran.
 *
 * Yang tetap milik modul ini hanyalah makna: resume hanya masuk akal bila turn
 * punya prompt untuk dilanjutkan, dan bila kegagalannya memang datang dari
 * penyedia (bukan pagar lokal seperti anggaran biaya atau batas langkah).
 */

export {
  type FailureSignal,
  isRecoverable,
  planRecovery,
  RECOVERY_ATTEMPT_QUOTA,
  RECOVERY_BUDGET_MS,
  type RecoveryDecision,
  type RecoveryState,
  type RecoveryStopReason,
} from "./recovery-budget.ts"

import { type FailureSignal, planRecovery, type RecoveryDecision } from "./recovery-budget.ts"

/**
 * Putuskan apakah turn yang gagal boleh dicoba ulang otomatis.
 *
 * Kompatibilitas bentuk: `attempt` (jumlah resume yang sudah dilakukan) dipakai
 * menurunkan `attemptsUsed`. Pemanggil yang memegang anggaran lengkap sebaiknya
 * memanggil {@link planRecovery} langsung agar percobaan retry provider ikut
 * terhitung dalam kuota yang sama — itulah inti perbaikannya.
 *
 * @param failure sinyal kegagalan (kategori/kind/abort/Retry-After)
 * @param attempt resume yang sudah dilakukan untuk prompt ini (0 pada kegagalan pertama)
 * @param opts.hasPrompt turn hanya bisa dilanjutkan bila ada prompt
 * @param opts.budgetExhausted anggaran BIAYA model sudah habis (bukan gangguan)
 */
export function decideAutoResume(
  failure: FailureSignal,
  attempt: number,
  opts: { hasPrompt: boolean; budgetExhausted?: boolean } = { hasPrompt: true },
): RecoveryDecision {
  return planRecovery(
    failure,
    // Tanpa konteks waktu, resume dipandang sebagai percobaan tambahan dari nol;
    // pagar waktu tetap berlaku di pemanggil yang memegang jam sebenarnya.
    { startedAtMs: 0, nowMs: 0, attemptsUsed: attempt },
    {
      hasPrompt: opts.hasPrompt,
      costBudgetExhausted: opts.budgetExhausted === true,
    },
  )
}
