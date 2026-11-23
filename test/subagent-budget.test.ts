// v0.33: budget sub-agent adaptif — scope-aware + tangga eskalasi khusus.
// Murni, tanpa TTY/provider.
import { expect, test } from "bun:test"
import { LIMITS } from "../src/constants.ts"
import {
  budgetForScope,
  inferScope,
  nextSubAgentStepLimit,
  SUB_AGENT_STEP_LADDER,
} from "../src/policy/subagent-budget.ts"

test("scope menaikkan budget sesuai luas (plan ×1,5, clamp 600)", () => {
  expect(budgetForScope("file", "explore")).toBe(16)
  expect(budgetForScope("dir", "explore")).toBe(24)
  expect(budgetForScope("subtree", "explore")).toBe(40)
  expect(budgetForScope("repo", "explore")).toBe(64)
  expect(budgetForScope("repo", "plan")).toBe(96)
  for (const s of ["file", "dir", "subtree", "repo"] as const) {
    expect(budgetForScope(s, "plan")).toBeGreaterThanOrEqual(budgetForScope(s, "explore"))
    expect(budgetForScope(s, "plan")).toBeLessThanOrEqual(LIMITS.SUB_AGENT_MAX_STEPS)
  }
})

test("inferScope: konservatif, default dir", () => {
  expect(inferScope("baca src/x.ts")).toBe("file")
  expect(inferScope("audit seluruh repo ini")).toBe("repo")
  expect(inferScope("jelajahi subtree src/ui")).toBe("subtree")
  expect(inferScope("lakukan audit tanpa ubah kode")).toBe("dir")
})

test("tangga sub-agent bertahap (tidak loncat 5 → ceiling)", () => {
  expect(SUB_AGENT_STEP_LADDER).toEqual([8, 12, 20, 32, 50, 75, 100, 150, 250, 400, 600])
  expect(nextSubAgentStepLimit(5, 5)).toBe(8)
  expect(nextSubAgentStepLimit(8, 8)).toBe(12)
  expect(nextSubAgentStepLimit(12, 12)).toBe(20)
  expect(nextSubAgentStepLimit(20, 20)).toBe(32)
  expect(nextSubAgentStepLimit(32, 32)).toBe(50)
  expect(nextSubAgentStepLimit(50, 50)).toBe(75)
  expect(nextSubAgentStepLimit(75, 75)).toBe(100)
  expect(nextSubAgentStepLimit(100, 100)).toBe(150)
  expect(nextSubAgentStepLimit(150, 150)).toBe(250)
  expect(nextSubAgentStepLimit(250, 250)).toBe(400)
  expect(nextSubAgentStepLimit(400, 400)).toBe(600)
  expect(nextSubAgentStepLimit(600, 600)).toBeUndefined()
  // Observasi MELEBIHI ceiling = tanda agent berputar → berhenti, bukan naik.
  // (99 kini masih di bawah cap 600, jadi naik ke 100 — bukan kasus ini.)
  expect(nextSubAgentStepLimit(5, 999)).toBeUndefined()
})
