// Audit #1 — regresi kebocoran entri map lock checkpoint.
// Kode lama menyimpan rantai `prev.then(() => next)` di map, lalu di finally
// membandingkan dengan `next` (bukan rantai) sehingga entri tak pernah dihapus.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointLockCountForTest, recordCheckpointFromTrees } from "../src/session/checkpoint.ts"

describe("audit #1: lock checkpoint dilepas setelah operasi", () => {
  test("entri map kembali ke baseline setelah operasi berurutan", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mc-cp-lock-seq-"))
    const baseline = checkpointLockCountForTest()
    try {
      const id = "audit-lock-seq"
      for (let i = 0; i < 6; i++) {
        await recordCheckpointFromTrees(id, i + 1, `before-${i}`, `after-${i}`, "seq", cwd)
        // Rantai harus dilepas setiap selesai — tak boleh tumbuh per checkpoint.
        expect(checkpointLockCountForTest()).toBe(baseline)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("entri map kembali ke baseline setelah operasi paralel pada path sama", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mc-cp-lock-par-"))
    const baseline = checkpointLockCountForTest()
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          recordCheckpointFromTrees("audit-lock-par", i + 1, `b-${i}`, `a-${i}`, "par", cwd),
        ),
      )
      expect(checkpointLockCountForTest()).toBe(baseline)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
