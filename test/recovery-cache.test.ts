// E-12: cache idempotensi recovery dibatasi LRU + TTL (dulu tanpa eviksi).
import { expect, test } from "bun:test"
import type { JournalRecord } from "../src/runtime/execution-journal.ts"
import { createRecoveryEngine, type RecoveryContext } from "../src/runtime/recovery.ts"

function ctx(): RecoveryContext {
  return {
    authorityHeld: true,
    budgetRemaining: 100,
    deadlineRemainingMs: 60_000,
    idempotent: false,
    dedupeKeyPresent: false,
    dedupeCheckPass: false,
  }
}

function rec(executionId: string, seq: number): JournalRecord {
  return {
    journalSequence: seq,
    schemaVersion: 1,
    recordHash: "h",
    executionId,
    lineageRootId: executionId,
    executionVersion: 1,
    timestamp: seq,
    reason: "r",
    source: "kernel",
    metadataJson: "{}",
    kind: "intent",
    intentId: `i${seq}`,
  } as never
}

test("600 insiden berbeda → cache dibatasi, idempotensi insiden terakhir tetap", () => {
  const engine = createRecoveryEngine()
  for (let i = 0; i < 600; i++) {
    const id = `exec_${String(i).padStart(12, "0")}`
    engine.recoverExecution(id, [rec(id, i + 1)], ctx())
  }
  expect(engine.cacheSize()).toBeLessThanOrEqual(512)
  expect(engine.cacheSize()).toBeGreaterThan(0)

  const before = engine.metrics().recoveries
  const last = `exec_${String(599).padStart(12, "0")}`
  const r1 = engine.recoverExecution(last, [rec(last, 600)], ctx())
  const r2 = engine.recoverExecution(last, [rec(last, 600)], ctx())
  expect(r1).toBe(r2)
  expect(engine.metrics().recoveries).toBe(before)
})

test("insiden paling tua ter-eviksi (dihitung ulang)", () => {
  const engine = createRecoveryEngine()
  const first = "exec_000000000000"
  engine.recoverExecution(first, [rec(first, 1)], ctx())
  for (let i = 1; i <= 520; i++) {
    const id = `exec_${String(i).padStart(12, "0")}`
    engine.recoverExecution(id, [rec(id, i + 1)], ctx())
  }
  const before = engine.metrics().recoveries
  engine.recoverExecution(first, [rec(first, 1)], ctx())
  expect(engine.metrics().recoveries).toBe(before + 1)
})
