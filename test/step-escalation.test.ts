// [T-008 OBSERVATION.md] Eskalasi adaptif batas langkah per turn.
//
// Bug asli: `DEFAULT_MAX_STEPS = 50` membuat turn terputus di tengah kerja —
// pada sesi 17b6a5ff, 4 dari 5 `turn.failed` adalah `exceeded 50 steps`.
// Kontrak baru: mulai dari 200 (sesi utama) / 50 (sub-agent), lalu naik satu
// tangga saat sesi terbukti mentok. Bounded oleh STEP_LIMIT_CEILING.

import { describe, expect, test } from "bun:test"
import { LIMITS } from "../src/constants.ts"
import {
  DEFAULT_SESSION_MAX_STEPS,
  DEFAULT_SUB_AGENT_MAX_STEPS,
  nextStepLadderStep,
  nextStepLimit,
  STEP_LIMIT_CEILING,
  STEP_LIMIT_LADDER,
} from "../src/policy/step-escalation.ts"

describe("T-008: tangga batas langkah", () => {
  test("default sesi utama 200, sub-agent 50 (terpisah)", () => {
    expect(DEFAULT_SESSION_MAX_STEPS).toBe(200)
    // Default kontrak lama tetap 50; hard-cap delegasi naik 100 → 600 (riset +
    // persetujuan owner). Keduanya sengaja berbeda: default = fallback tanpa
    // scope, hard-cap = atap eskalasi.
    expect(DEFAULT_SUB_AGENT_MAX_STEPS).toBe(50)
    expect(LIMITS.DEFAULT_MAX_STEPS).toBe(200)
    expect(LIMITS.SUB_AGENT_MAX_STEPS).toBe(600)
  })

  test("tangga menaik ketat dan berakhir di ceiling", () => {
    for (let i = 1; i < STEP_LIMIT_LADDER.length; i++) {
      expect(STEP_LIMIT_LADDER[i]!).toBeGreaterThan(STEP_LIMIT_LADDER[i - 1]!)
    }
    expect(STEP_LIMIT_LADDER[STEP_LIMIT_LADDER.length - 1]).toBe(STEP_LIMIT_CEILING)
  })

  test("nextStepLadderStep tidak melompat: satu anak tangga per kejadian", () => {
    expect(nextStepLadderStep(0)).toBe(200)
    expect(nextStepLadderStep(200)).toBe(400)
    expect(nextStepLadderStep(201)).toBe(400)
    expect(nextStepLadderStep(400)).toBe(800)
    expect(nextStepLadderStep(6_400)).toBeUndefined()
    expect(nextStepLadderStep(99_999)).toBeUndefined()
  })

  test("nextStepLimit naik dari batas yang berlaku, bukan dari pengamatan terpencil", () => {
    // Sesi utama mentok di 200 → 400.
    expect(nextStepLimit(200, 200)).toBe(400)
    // Pengamatan lebih kecil dari batas tidak menurunkan apa pun.
    expect(nextStepLimit(200, 17)).toBe(400)
  })

  test("pengamatan yang melampaui batas dipakai sebagai titik naik", () => {
    // Operator menaikkan batas manual, atau hitungan terpakai sudah melewati
    // batas lama: tangga harus mulai dari kebutuhan NYATA, bukan batas lama.
    expect(nextStepLimit(200, 900)).toBe(1_600)
  })

  test("batas tak valid tetap menghasilkan tangga yang aman", () => {
    expect(nextStepLimit(Number.NaN, 0)).toBe(200)
    expect(nextStepLimit(-5, -5)).toBe(200)
    expect(nextStepLimit(0, 0)).toBe(200)
  })

  test("di puncak: undefined (pemanggil wajib berhenti, bukan lanjut tanpa batas)", () => {
    expect(nextStepLimit(STEP_LIMIT_CEILING, STEP_LIMIT_CEILING)).toBeUndefined()
    expect(nextStepLimit(6_400, 10_000)).toBeUndefined()
  })

  test("eskalasi berulang berhenti tepat di ceiling (bounded)", () => {
    let limit = DEFAULT_SESSION_MAX_STEPS
    let steps = 0
    while (steps < 50) {
      const next = nextStepLimit(limit, limit)
      if (next === undefined) break
      expect(next).toBeGreaterThan(limit)
      expect(next).toBeLessThanOrEqual(STEP_LIMIT_CEILING)
      limit = next
      steps++
    }
    expect(limit).toBe(STEP_LIMIT_CEILING)
    // Berhenti: bukan loop tak terbatas.
    expect(steps).toBeLessThan(10)
  })
})
