// Peta kebutuhan kapabilitas runtime per jenis kerja (`background`, `child`,
// `turn`). Jenis kerja lain (mis. `task` yang belum memiliki producer) tidak
// dipetakan sehingga ditolak secara fail-closed. `durable-journal` tidak
// diwajibkan karena mode runtime `constructed` dapat berjalan tanpa jurnal.

import {
  createRequirementMap,
  type DurableWorkRequirementMap,
  type RuntimeCapability,
} from "./runtime-capabilities.ts"
import { type AdmissionDecision, admitDurableWork, type RuntimeView } from "./runtime-status.ts"

/**
 * Peta kebutuhan kapabilitas per jenis kerja.
 *
 * Dibuat dari `createRequirementMap` (P13.1) supaya bentuknya persis bentuk
 * yang dipakai `admitDurableWork` — tak ada daftar kedua yang bisa berbeda.
 */
export const TASK_WORK_REQUIREMENTS: DurableWorkRequirementMap = createRequirementMap([
  {
    // Claim atomik di TaskStore (otoritas task) + pemilik siklus (scheduler).
    workKind: "background",
    requiredCapabilities: ["durable-task-store", "task-scheduler"],
  },
  {
    // Sesi anak: TIDAK ada claim TaskStore (anak bukan task otonom) dan TIDAK ada
    // siklus scheduler — history-nya milik store sesi, bukan TaskStore.
    workKind: "child",
    requiredCapabilities: [],
  },
  {
    // Turn interaktif: sama — bukan task otonom, jadi tak butuh TaskStore/scheduler.
    workKind: "turn",
    requiredCapabilities: [],
  },
])

/** Jenis kerja yang punya peta. "task" TIDAK termasuk (tak ada producer-nya). */
export const MAPPED_WORK_KINDS: readonly string[] = ["background", "child", "turn"]

/**
 * Keputusan admission untuk satu jenis kerja nyata.
 *
 * Fail-closed di setiap celah:
 * - Jenis tak dikenal / tak dipetakan ⇒ REFUSE (nama tak pernah jadi izin).
 * - Kapabilitas yang dibutuhkan tak tersedia ⇒ REFUSE, dan disebut mana.
 * - Bukti runtime tak lengkap/basi ⇒ REFUSE (dari `admitDurableWork`).
 *
 * Tidak ada jalur yang "menerka" allowlist dari nama jenis kerja.
 */
export function admitTaskWork(view: RuntimeView, workKind: string): AdmissionDecision {
  return admitDurableWork(view, { workKind, requirements: TASK_WORK_REQUIREMENTS })
}

/** Bukti kebutuhan kapabilitas untuk satu jenis kerja (untuk diagnostik/test). */
export function requiredCapabilitiesFor(workKind: string): readonly RuntimeCapability[] {
  const entry = TASK_WORK_REQUIREMENTS.get(workKind)
  return entry ? entry.requiredCapabilities : []
}
