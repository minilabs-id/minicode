// BUG-8 + false-tamper: cache baseline sesi dibebaskan (LRU/TTL) dan kegagalan
// git saat capture TIDAK membuat semua path kotor vonis tamper.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JournalRecord } from "../src/session/journal.ts"
import {
  __clearSessionBaselineCacheForTest,
  __sessionBaselineCacheSizeForTest,
  __setEvaluationDirtyScanForTest,
  captureSessionEvaluationBaseline,
  collectSessionModifiedFiles,
} from "../src/session/verification.ts"

const dirs: string[] = []
afterEach(() => {
  __clearSessionBaselineCacheForTest()
  __setEvaluationDirtyScanForTest(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-verify-cache-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

function rec(session: string, tool: string, cwd: string): JournalRecord {
  return {
    v: 1,
    id: `${session}:0`,
    session,
    seq: 0,
    tool,
    cwd,
    ts: Date.now(),
    state: "committed",
  } as never
}

test("300 sesi → cache baseline dibatasi (LRU ≤256)", async () => {
  const root = tmpRoot()
  __clearSessionBaselineCacheForTest()
  __setEvaluationDirtyScanForTest(() => ({ ok: false, paths: [] }))
  for (let i = 0; i < 300; i++) await captureSessionEvaluationBaseline(`sid-${i}`, root)
  expect(__sessionBaselineCacheSizeForTest()).toBeLessThanOrEqual(256)
  expect(__sessionBaselineCacheSizeForTest()).toBeGreaterThan(0)
})

test("git gagal saat capture → path kotor tidak ditandai tamper", async () => {
  const root = tmpRoot()
  const sid = "git-failed-session"
  __setEvaluationDirtyScanForTest(() => ({ ok: false, paths: [] }))
  await captureSessionEvaluationBaseline(sid, root)

  // Saat collect git sukses melihat path kotor — tapi baseline tak bisa dibuat.
  __setEvaluationDirtyScanForTest(() => ({ ok: true, paths: ["test/eval.ts"] }))
  const modified = await collectSessionModifiedFiles(sid, root, [rec(sid, "bash", root)])
  expect(modified).not.toContain("test/eval.ts")
})

test("baseline benar-benar tidak ada → fail-closed tetap menandai path", async () => {
  const root = tmpRoot()
  const sid = "no-baseline-session"
  __setEvaluationDirtyScanForTest(() => ({ ok: true, paths: ["test/eval.ts"] }))
  const modified = await collectSessionModifiedFiles(sid, root, [rec(sid, "bash", root)])
  expect(modified).toContain("test/eval.ts")
})
