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

test("scope menaikkan budget sesuai luas (plan ×1,5, clamp 50)", () => {
  expect(budgetForScope("file", "explore")).toBe(12)
  expect(budgetForScope("dir", "explore")).toBe(18)
  expect(budgetForScope("subtree", "explore")).toBe(26)
  expect(budgetForScope("repo", "explore")).toBe(36)
  expect(budgetForScope("repo", "plan")).toBe(50)
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

test("tangga sub-agent bertahap (tidak loncat 5 → 50)", () => {
  expect(SUB_AGENT_STEP_LADDER).toEqual([8, 12, 20, 32, 50])
  expect(nextSubAgentStepLimit(5, 5)).toBe(8)
  expect(nextSubAgentStepLimit(8, 8)).toBe(12)
  expect(nextSubAgentStepLimit(12, 12)).toBe(20)
  expect(nextSubAgentStepLimit(20, 20)).toBe(32)
  expect(nextSubAgentStepLimit(32, 32)).toBe(50)
  expect(nextSubAgentStepLimit(50, 50)).toBeUndefined()
  // Observasi jauh di atas cap = tanda agent berputar → berhenti, bukan naik.
  expect(nextSubAgentStepLimit(5, 99)).toBeUndefined()
})
