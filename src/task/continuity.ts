// Klasifikasi kontinuitas task durable (murni, tanpa I/O).
// "Tanpa completion marker" BUKAN bukti aman retry: eksekusi bisa menulis berkas
// atau menjalankan perintah, sehingga attempt baru mengulang efek eksternal.
// Scheduler memisahkan "stranded?" (TaskStore) dari "boleh dijalankan ulang?" (di sini).
// Hanya SAFE_TO_RETRY kembali ke siklus otomatis; REQUIRES_VERIFIER/HOLD menahan record.
// Semua fakta masuk lewat argumen agar keputusan deterministik, tanpa sumber kebenaran kedua.

import { classifyTool } from "./autonomous-policy.ts"
import type { TaskStatus } from "./model.ts"

/**
 * Bukti cakupan tool yang menentukan keselamatan retry.
 *
 * READ_ONLY_TOOL_SCOPE bukan tebakan: nilainya hanya boleh dipakai bila
 * SELURUH tool yang bisa dipanggil bridge berasal dari matriks 6S dan
 * berkemampuan READ_ONLY. Untuk bridge otonom produksi, `AUTONOMOUS_TOOL_NAMES`
 * adalah output matriks itu sendiri (lihat `retrySafetyForToolScope`).
 */
export type RetrySafety =
  /** Tool bridge terbukti read-only: attempt baru tidak bisa mengulang efek tulis. */
  | "READ_ONLY_TOOL_SCOPE"
  /** Tidak ada bukti yang menutup efek eksternal; retry butuh verifier. */
  | "UNPROVEN"

export type ContinuityClass = "SAFE_TO_RETRY" | "REQUIRES_VERIFIER" | "HOLD"

/** Fakta task yang dibaca dari TaskStore. Bukan status presentasi. */
export interface ContinuityFacts {
  readonly status: TaskStatus
  readonly executionOwner: "scheduler" | null
  readonly execGeneration: number
  /** `null` = belum ada attempt yang mencatat akhir untuk generasi ini. */
  readonly attemptGeneration: number | null
  /** Ownership proses-lokal masih milik instance ini. */
  readonly ownsSession: boolean
  /** Lease/authority lintas-proses masih valid untuk token instance ini. */
  readonly authorityHeld: boolean
  /** Incarnation sesi persisten masih sama dengan yang dipegang instance. */
  readonly incarnationMatches: boolean
}

/**
 * Bukti tambahan yang datang dari luar lapisan task.
 *
 * `resume`/`missing` adalah hasil `evaluateResume` (runtime-status.ts), bukan
 * evaluasi ulang di sini: aturan empat-bukti tetap milik satu fungsi. Modul ini
 * hanya memutuskan apakah bukti itu cukup untuk MENJALANKAN ULANG.
 */
export interface ContinuityEvidence {
  readonly resume: boolean
  readonly missing: readonly string[]
  readonly admission: "ALLOW" | "SCOPED" | "REFUSE"
  readonly retrySafety: RetrySafety
}

export interface ContinuityVerdict {
  readonly class: ContinuityClass
  readonly reason: string
  /** Hanya true untuk SAFE_TO_RETRY. Keputusan revert tetap milik TaskStore. */
  readonly mayReconcile: boolean
}

/** Fakta yang hanya diketahui Scheduler saat reconcile berjalan. */
export interface ContinuityContext {
  readonly ownsSession: boolean
  readonly authorityHeld: boolean
  readonly incarnationMatches: boolean
}

/**
 * Sumber bukti kontinuitas. Composition root yang memasangnya; Scheduler tidak
 * menebak apakah bridge-nya read-only.
 */
export interface ContinuityGate {
  readonly evidence: (ctx: ContinuityContext) => ContinuityEvidence
}

/**
 * Marker kompletion = attempt generasi berjalan sudah mencatat akhir.
 * `>=` sengaja, bukan `===`: attempt lebih baru dari exec = korupsi, ditahan (bukan retry).
 */
export function hasCompletionMarker(generations: {
  readonly execGeneration: number
  readonly attemptGeneration: number | null
}): boolean {
  const attempt = generations.attemptGeneration
  return attempt !== null && attempt >= generations.execGeneration
}

/**
 * Turunkan retry safety dari NAMA tool yang benar-benar dipegang bridge.
 *
 * Fail-closed:
 * - daftar kosong = tidak ada bukti cakupan (bisa berarti miswiring) -> UNPROVEN;
 * - satu tool saja yang tidak ada di matriks, tidak autonomous, atau bukan
 *   READ_ONLY -> UNPROVEN. Tidak ada "sebagian besar read-only".
 */
export function retrySafetyForToolScope(toolNames: readonly string[]): RetrySafety {
  if (toolNames.length === 0) return "UNPROVEN"
  for (const name of toolNames) {
    const tool = classifyTool(name)
    if (!tool.autonomous || tool.capability !== "READ_ONLY") return "UNPROVEN"
  }
  return "READ_ONLY_TOOL_SCOPE"
}

/**
 * Satu-satunya klasifikasi recovery untuk task durable.
 *
 * Urutan pemeriksaan disengaja: otoritas/identitas lebih dulu (tanpa itu tak
 * ada yang boleh disentuh), lalu marker (attempt sudah berakhir -> bukan urusan
 * scheduler), lalu bukti resume/admission, terakhir keselamatan retry.
 *
 * "Marker tidak ada" TIDAK pernah menjadi bukti keselamatan. Keselamatan hanya
 * datang dari `retrySafety` yang dibuktikan sumbernya (mis. cakupan tool).
 */
export function classifyContinuity(
  facts: ContinuityFacts,
  evidence: ContinuityEvidence,
): ContinuityVerdict {
  const hold = (reason: string): ContinuityVerdict => ({
    class: "HOLD",
    reason,
    mayReconcile: false,
  })
  const verifier = (reason: string): ContinuityVerdict => ({
    class: "REQUIRES_VERIFIER",
    reason,
    mayReconcile: false,
  })

  // Status terminal/operator tidak pernah jadi target (pengulangan sengaja kontrak TaskStore).
  if (facts.status !== "IN_PROGRESS" && facts.status !== "VERIFYING") {
    return hold("not-in-flight")
  }
  if (!facts.ownsSession) return hold("ownership-not-held")
  if (!facts.authorityHeld) return hold("authority-lost")
  if (!facts.incarnationMatches) return hold("session-superseded")
  if (facts.executionOwner !== "scheduler") return hold("not-scheduler-owned")
  if (facts.execGeneration <= 0) return hold("no-claim")

  // Marker menahan lebih awal; ketiadaannya bukan bukti tidak ada efek, bukan izin retry.
  if (hasCompletionMarker(facts)) return hold("attempt-completed")

  if (!evidence.resume) {
    const missing = evidence.missing.length > 0 ? evidence.missing.join(",") : "unknown"
    return hold(`resume-missing:${missing}`)
  }
  if (evidence.admission !== "ALLOW") {
    return hold(`admission-${evidence.admission.toLowerCase()}`)
  }
  if (evidence.retrySafety !== "READ_ONLY_TOOL_SCOPE") {
    return verifier("retry-safety-unproven")
  }
  return { class: "SAFE_TO_RETRY", reason: "eligible", mayReconcile: true }
}
