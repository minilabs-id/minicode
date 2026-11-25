// [Fase 6A / ACE-01] Pilar 1 ACE-Lite — Deterministic Consequence Controller.
//
// Menerjemahkan bukti eksekusi (verifikasi, jenis kegagalan, jumlah percobaan,
// kesegaran bukti baru) menjadi verdict + kelas kegagalan + tindakan pemulihan
// berikutnya. Modul ini PURE dan deterministik: tanpa I/O, tanpa clock, tanpa
// jaringan — masukan yang sama selalu menghasilkan keputusan yang sama.
//
// Modul ini PURE (tanpa IO/clock/network) dan hanya impor tipe Node +
// `./tool-contract.ts`. Karena itu tipe ACE diimpor oleh session/runtime-header.ts
// dan composition root, bukan sebaliknya.
//
// [ACE-INV-01] HARD CONSTRAINT: percobaan manipulasi evaluator SELALU
// mengalahkan metrik lain. Tidak ada kombinasi input yang boleh mengubah
// EVALUATOR_TAMPER_ATTEMPT menjadi PASS — verdict-nya BLOCKED, dan satu-satunya
// tindakan legal adalah STOP_AND_REPORT.

export type AceVerdict = "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE"

export type AceFailureClass =
  | "NONE"
  | "TRANSIENT_ENV"
  | "FUNCTIONAL_TEST_FAIL"
  | "REGRESSION_DETECTED"
  | "REPEATED_NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "PERMISSION_OR_EXTERNAL_BLOCKER"
  | "EVALUATOR_TAMPER_ATTEMPT"

export type AceNextAction =
  | "COMPLETE_AFTER_VERIFICATION"
  | "RETRY_TRANSIENT"
  | "ANALYZE_FAILURE"
  | "REVISE_HYPOTHESIS"
  | "GATHER_EVIDENCE"
  | "CHANGE_STRATEGY"
  | "REQUEST_HUMAN"
  | "STOP_AND_REPORT"

export type AceFailureType =
  | "network_error"
  | "rate_limit"
  | "timeout"
  | "functional"
  | "regression"
  | null

// [Fase 9 / 9.1] Operational Rollback Switch — `MINICODE_ACE_ENABLED`.
//
// Operator harus bisa menonaktifkan ACE-Lite secara bersih (rollback instan
// atau baseline murni) tanpa mengubah kode. Default `true` (aktif) agar seluruh
// test `p18` dan `p19` tetap hijau tanpa env var. Nilai yang dianggap "off"
// (case-insensitive, di-trim): "0", "false", "off", "no". Selain itu → aktif.
//
// PENTING: sakelar ini TIDAK menyentuh hard-safety/permission policy maupun
// Evaluator Tamper Guard — keduanya tetap berjalan apa pun nilainya (safety
// constraint tidak boleh dimatikan oleh sakelar fitur).
const ACE_DISABLE_VALUES = new Set(["0", "false", "off", "no"])

export function isAceEnabled(env?: Record<string, string | undefined>): boolean {
  const raw = (env?.MINICODE_ACE_ENABLED ?? process.env.MINICODE_ACE_ENABLED)?.trim().toLowerCase()
  if (raw === undefined || raw === "") return true
  return !ACE_DISABLE_VALUES.has(raw)
}

export interface ConsequenceDecision {
  readonly verdict: AceVerdict
  readonly failureClass: AceFailureClass
  readonly nextAction: AceNextAction
  readonly rationale: string
  readonly newEvidenceSinceLastAttempt?: boolean
}

export interface ConsequenceEvaluationInput {
  /** Verifikasi berbasis bukti sudah lulus sepenuhnya. */
  readonly verificationPassed?: boolean
  /** Bukti upaya manipulasi evaluator (edit gate test / injeksi .skip/.todo). */
  readonly evaluatorTamperAttempt?: boolean
  /** Jenis kegagalan yang teramati. */
  readonly failureType?: AceFailureType
  /** Error sementara (jaringan/rate-limit/timeout) yang aman diulang. */
  readonly isTransientError?: boolean
  /** Berapa kali kegagalan identik terjadi berturut-turut SEBELUM percobaan ini. */
  readonly repeatedFailureCount?: number
  /** Pagar PEMANGGIL: retry pada scope yang sama sudah mencapai batas
   * (mis. 3 retry + 1 attempt awal = 4 attempt untuk delegasi sub-agent).
   * Bukan state global — pemanggil yang menghitung dari riwayatnya sendiri. */
  readonly retryLimitReached?: boolean
  /** Agen membaca bukti diagnostik baru sejak kegagalan terakhir. */
  readonly newEvidenceSinceLastAttempt?: boolean
  /** Terhalang izin/approval atau dependensi eksternal yang tak bisa dipulihkan agen. */
  readonly blockedByPermissionOrExternalBlocker?: boolean
  /** Budget turn/USD habis. */
  readonly budgetExhausted?: boolean
  /** Belum ada bukti yang cukup untuk memutuskan. */
  readonly insufficientEvidence?: boolean
  /** Baseline/evaluator berubah sehingga kegagalan fungsional = regresi. */
  readonly baselineContentChanged?: boolean
}

const TRANSIENT_TYPES = new Set<AceFailureType>(["network_error", "rate_limit", "timeout"])

/**
 * [v0.43.2 audit] Pagar ENGINE untuk kegagalan identik berulang tanpa bukti baru.
 *
 * KENAPA 5 (bukan 2): ambang 2 di rule lama sengaja dipertahankan untuk
 * `CHANGE_STRATEGY` (ganti cara, masih boleh mencoba), tapi sebagai pagar
 * `REQUEST_HUMAN` angka 2 terlalu ketat — gangguan provider nyata sering pulih
 * pada percobaan ke-3. Lima kegagalan tanpa satu pun bukti baru sudah cukup
 * menjadi pola "tak membaik", tapi masih memberi ruang retry wajar.
 */
export const ACE_REPEATED_FAILURE_LIMIT = 5

/**
 * Evaluasi deterministik. Urutan aturan adalah kontrak — jangan diubah tanpa
 * memperbarui test/p18-ace-lite-engine.test.ts karena tiap cabang diuji
 * eksplisit.
 */
export function evaluateConsequence(input: ConsequenceEvaluationInput): ConsequenceDecision {
  const newEvidence = input.newEvidenceSinceLastAttempt === true

  // 1. HARD CONSTRAINT — manipulasi evaluator tidak pernah bisa lolos.
  if (input.evaluatorTamperAttempt === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "EVALUATOR_TAMPER_ATTEMPT",
      nextAction: "STOP_AND_REPORT",
      rationale: "evaluator tamper attempt detected — refusing every verified claim",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 2. Bukti verifikasi lengkap dan sah.
  if (input.verificationPassed === true) {
    return {
      verdict: "PASS",
      failureClass: "NONE",
      nextAction: "COMPLETE_AFTER_VERIFICATION",
      rationale: "all verification criteria satisfied with fresh evidence",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 3. Budget habis = berhenti, bukan retry tanpa batas.
  if (input.budgetExhausted === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "INSUFFICIENT_EVIDENCE",
      nextAction: "STOP_AND_REPORT",
      rationale: "budget exhausted before verification completed",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 4. Blocker eksternal/izin — agen tidak bisa menyelesaikan sendiri.
  if (input.blockedByPermissionOrExternalBlocker === true) {
    return {
      verdict: "BLOCKED",
      failureClass: "PERMISSION_OR_EXTERNAL_BLOCKER",
      nextAction: "REQUEST_HUMAN",
      rationale: "permission denied or external dependency unavailable",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 4a. [v0.43.2 audit] Dua pagar retry yang sengaja LONGGAR. Keduanya
  // didahulukan atas cabang transient supaya provider 401/429 yang gagal terus
  // tidak berubah menjadi retry buta tanpa batas:
  //   • retryLimitReached — pagar pemanggil (sub-agent: 3 retry + 1 attempt
  //     awal = 4 attempt per scope delegasi). Dihitung pemanggil, bukan engine.
  //   • repeatedFailureCount >= 5 — pagar engine untuk kegagalan identik tanpa
  //     bukti baru. Ambang lama 2 tetap dipakai rule 6 untuk CHANGE_STRATEGY.
  // Keduanya → REQUEST_HUMAN, BUKAN STOP_AND_REPORT: agen masih boleh
  // menyertakan temuan partial; manusia yang memutuskan lanjut atau berhenti.
  // EVALUATOR_TAMPER_ATTEMPT sudah ditangani rule 1 dan tak bisa ditimpa.
  if (
    input.retryLimitReached === true ||
    ((input.repeatedFailureCount ?? 0) >= ACE_REPEATED_FAILURE_LIMIT && !newEvidence)
  ) {
    return {
      verdict: "BLOCKED",
      failureClass: "REPEATED_NO_EVIDENCE",
      nextAction: "REQUEST_HUMAN",
      rationale: `retry limit reached or ${input.repeatedFailureCount ?? 0} repeated failures without new evidence — request human`,
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 5. Error sementara yang aman diulang.
  const functionalFailure = input.failureType === "functional" || input.failureType === "regression"
  const transient =
    !functionalFailure &&
    (input.isTransientError === true || TRANSIENT_TYPES.has(input.failureType ?? null))
  if (transient) {
    return {
      verdict: "FAIL",
      failureClass: "TRANSIENT_ENV",
      nextAction: "RETRY_TRANSIENT",
      rationale: `transient environment failure (${input.failureType ?? "unknown"}) — safe to retry`,
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 6. Kegagalan berulang tanpa bukti baru → ganti strategi, bukan ulang buta.
  if ((input.repeatedFailureCount ?? 0) >= 2 && !newEvidence) {
    return {
      verdict: "FAIL",
      failureClass: "REPEATED_NO_EVIDENCE",
      nextAction: "CHANGE_STRATEGY",
      rationale: `repeated failure count ${input.repeatedFailureCount} without new evidence`,
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 7. Regresi: kegagalan fungsional setelah baseline berubah.
  if (
    input.failureType === "regression" ||
    (input.baselineContentChanged === true && input.failureType === "functional")
  ) {
    return {
      verdict: "FAIL",
      failureClass: "REGRESSION_DETECTED",
      nextAction: "REVISE_HYPOTHESIS",
      rationale: "baseline changed and functional evidence now fails — regression suspected",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 8. Kegagalan fungsional pertama → analisis dulu.
  if (input.failureType === "functional") {
    return {
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
      rationale: "first functional failure — inspect evidence before changing code",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 9. Bukti belum cukup (tanpa jenis kegagalan konkret).
  if (input.insufficientEvidence === true || input.failureType == null) {
    return {
      verdict: "INCONCLUSIVE",
      failureClass: "INSUFFICIENT_EVIDENCE",
      nextAction: "GATHER_EVIDENCE",
      rationale: "no decisive failure evidence yet — gather diagnostics",
      newEvidenceSinceLastAttempt: newEvidence,
    }
  }

  // 10. Fallback fail-closed: jangan pernah mengarang PASS.
  return {
    verdict: "INCONCLUSIVE",
    failureClass: "INSUFFICIENT_EVIDENCE",
    nextAction: "GATHER_EVIDENCE",
    rationale: "unclassified state — more evidence required",
    newEvidenceSinceLastAttempt: newEvidence,
  }
}
