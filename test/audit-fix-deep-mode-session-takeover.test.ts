// Audit deep-mode — `--session <id>` yang menimpa baris lama harus memulihkan
// WorkMode tersimpan, bukan menimpa EXECUTE dengan default DISCUSS CLI.
//
// `identity.resumed` sengaja tetap false untuk `--session` (histori tidak
// di-load — itu bedanya dengan --resume). Penanda baru `hasStoredSession`
// yang dipakai composition root untuk memilih WorkMode efektif.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveWorkModeForIdentity } from "../cli/setup.ts"
import { resolveSessionIdentity } from "../src/session/identity.ts"
import { loadSessionWorkMode, saveSession } from "../src/session/persistence.ts"

function ws(tag: string): string {
  return mkdtempSync(join(tmpdir(), `mc-deep-takeover-${tag}-`))
}

describe("audit deep-mode — takeover WorkMode", () => {
  test("--session <id> pada sesi tersimpan EXECUTE → efektif EXECUTE (tak ditimpa)", async () => {
    const cwd = ws("execute")
    try {
      await saveSession("takeover-exec", cwd, undefined, [], {}, { workMode: "EXECUTE" })
      const identity = resolveSessionIdentity({ sessionFlag: "takeover-exec", cwd })
      expect(identity.resumed).toBe(false)
      expect(identity.hasStoredSession).toBe(true)

      const resolved = resolveWorkModeForIdentity(identity, "DISCUSS", false, cwd)
      expect(resolved.persistedWorkMode).toBe("EXECUTE")
      expect(resolved.effectiveWorkMode).toBe("EXECUTE")
      // Nilai durable tetap utuh (bukan sekadar label di memori).
      expect(loadSessionWorkMode("takeover-exec", cwd)).toBe("EXECUTE")

      // Sinyal eksplisit operator tetap menang (kontrak --work-mode lama).
      const overridden = resolveWorkModeForIdentity(identity, "DISCUSS", true, cwd)
      expect(overridden.effectiveWorkMode).toBe("DISCUSS")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("sid benar-benar baru → tak ada pulihan WorkMode", () => {
    const cwd = ws("fresh")
    try {
      const identity = resolveSessionIdentity({ sessionFlag: "brand-new", cwd })
      expect(identity.hasStoredSession).toBe(false)
      const resolved = resolveWorkModeForIdentity(identity, "DISCUSS", false, cwd)
      expect(resolved.persistedWorkMode).toBeUndefined()
      expect(resolved.effectiveWorkMode).toBe("DISCUSS")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
