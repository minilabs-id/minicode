// v7.33 — perbaikan pola "false-confidence" pada test tool.
// Dua pengganti behavioral/terlihat untuk test yang dulu diam-diam lolos:
//  1. code_run timeout: helper error diekspor, diuji tanpa backend sandbox.
//  2. delegate_task REFUSED_: diuji lewat perilaku, bukan regex ejaan sumber.
// Hermetic: tanpa jaringan, tanpa TTY, tanpa sandbox backend nyata.

import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as verification from "../src/session/verification.ts"
import { codeRunTimeoutError } from "../src/tools/code_run.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "audit-tool-quality-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  mock.restore()
  clearSubAgentSessionFactory()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ── 1. code_run: kontrak pesan timeout tanpa backend ─────────────────────────

test("code_run: codeRunTimeoutError() memproduksi pesan TIMEOUT tanpa backend", () => {
  // Jalur execute() code_run butuh backend sandbox nyata (bwrap/seatbelt/docker)
  // dan TIDAK punya seam injeksi runner — tanpa backend tool fail-closed lebih
  // awal, jadi timeout wall-clock tak bisa dipicu hermetik di sini (jangan
  // fake-execute). Helper yang diekspor ini adalah kontrak pesan yang SAMA
  // dengan yang dilempar execute() saat settled.code === null.
  const err = codeRunTimeoutError(500, "sebagian output")
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain("state=UNKNOWN reason=TIMEOUT")
  expect(err.message).toContain("timeout_ms=500")
  expect(err.message).toContain("--- partial output ---\nsebagian output")
})

// ── 2. delegate_task: REFUSED_ sebagai error, bukan string sukses ────────────

test("delegate_task: evidence intent tak durabel → melempar REFUSED_, bukan string sukses", async () => {
  // v7.33: menggantikan source-regex test lama di audit-fix-tool-errors.test.ts
  // yang hanya memeriksa ejaan return/throw di src/tools/task.ts. Di sini yang
  // diuji ialah PERILAKU delegate saat verifikasi gagal.
  //
  // Catatan jujur: persistEffectIntent dipanggil di LUAR try/catch di task.ts,
  // jadi memaksanya "throw" hanya akan meneruskan error milik mock (bukan
  // REFUSED_ milik delegate) — itu justru false-confidence baru. Karena itu
  // mock mengembalikan { durable: false }, sinyal yang memicu cabang
  // REFUSED_VERIFICATION_EVIDENCE asli di dalam delegate.
  const dir = tmp()
  const savedKey = process.env.OPENAI_API_KEY
  if (!savedKey) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  setSubAgentSessionFactory(async () => ({
    events: { on: () => () => {} },
    run: async () => ({ finalText: "unused", usage: { steps: 1 } }),
  }))
  spyOn(verification, "persistEffectIntent").mockResolvedValue({ durable: false } as never)

  let returned: unknown = null
  let errMsg = ""
  try {
    const ctx = { signal: new AbortController().signal, cwd: dir, emit: () => {} } as never
    try {
      returned = await delegateTaskTool.execute({ prompt: "x" }, ctx)
    } catch (e) {
      errMsg = (e as Error).message
    }
    // Kunci: kegagalan verifikasi HARUS jadi error (isError), bukan ringkasan
    // sukses berbentuk string. `null` berarti execute() tak pernah resolve.
    expect(returned).toBeNull()
    expect(errMsg).toMatch(/REFUSED_VERIFICATION_EVIDENCE/)
    expect(errMsg).toMatch(/REFUSED_/)
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
  }
})
