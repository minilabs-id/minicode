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
  expect(budgetForScope("file", "explore")).toBe(24)
  expect(budgetForScope("dir", "explore")).toBe(40)
  expect(budgetForScope("subtree", "explore")).toBe(64)
  expect(budgetForScope("repo", "explore")).toBe(100)
  expect(budgetForScope("repo", "plan")).toBe(150)
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

test("inferScope: multi-area direktori naik ke subtree/repo tanpa false positive URL atau slash prosa", () => {
  expect(
    inferScope("Perinci UI, Kontrak & Test pada src/ui/, cli/, docs/TERMINAL_CONTRACT.md, test/"),
  ).toBe("repo")
  expect(inferScope("Cek sinkronisasi src/ui/app.ts dan cli/setup.ts")).toBe("subtree")
  expect(inferScope("Bandingkan src/tools/grep.ts dan src/tools/glob.ts")).toBe("dir")
  expect(
    inferScope(
      "Evaluasi transisi pending/in_progress dan read/write pada https://example.com/a/b/c",
    ),
  ).toBe("dir")
})

test("tangga sub-agent bertahap (selaras dengan SCOPE_BASE hingga 600)", () => {
  expect(SUB_AGENT_STEP_LADDER).toEqual([24, 40, 64, 100, 150, 250, 400, 600])
  expect(nextSubAgentStepLimit(16, 16)).toBe(24)
  expect(nextSubAgentStepLimit(24, 24)).toBe(40)
  expect(nextSubAgentStepLimit(40, 40)).toBe(64)
  expect(nextSubAgentStepLimit(64, 64)).toBe(100)
  expect(nextSubAgentStepLimit(100, 100)).toBe(150)
  expect(nextSubAgentStepLimit(150, 150)).toBe(250)
  expect(nextSubAgentStepLimit(250, 250)).toBe(400)
  expect(nextSubAgentStepLimit(400, 400)).toBe(600)
  expect(nextSubAgentStepLimit(600, 600)).toBeUndefined()
  expect(nextSubAgentStepLimit(24, 999)).toBeUndefined()
})
