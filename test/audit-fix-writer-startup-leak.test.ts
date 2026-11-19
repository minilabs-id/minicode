// v7.40 (audit) — writer startup leak: lease + renew timer bocor saat
// `createCliSession` melempar setelah admission tetapi sebelum `close()`
// terdaftar. Dua lapis pertahanan diuji:
//   1. helper cleanup-on-throw (unit, spy — tanpa provider/sesi nyata);
//   2. jalur nyata: `onPhase` melempar di phase `provider-layer`, lalu
//      safety-net `exit` dipanggil untuk mensimulasikan proses berakhir.
// Hermetic: tasks.db/sessions.db di temp root, tak ada jaringan/kernel.

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createCliSession,
  installBackgroundJobExitCleanup,
  releaseWriterLeaseAfterStartupThrow,
  type WriterStartupCleanupState,
} from "../cli/setup.ts"
import {
  acquireSessionWriter,
  describeSessionHolder,
  releaseSessionWriter,
  writerTokenFor,
} from "../src/session/authority.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

isolateHomeForTests()

// Pasang dulu listener cleanup background supaya snapshot `exit` di bawah
// hanya berisi listener milik sesi yang sedang diuji.
installBackgroundJobExitCleanup()

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-writer-leak-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    resetTaskStoreHandles()
  } catch {
    // abai: hanya guard handle SQLite antar-test.
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows bisa menahan handle sebentar; OS membersihkan temp root.
  }
}

function spyState() {
  let closed = false
  let stopped = 0
  let marked = 0
  let released = 0
  const state: WriterStartupCleanupState = {
    isClosed: () => closed,
    markClosed: () => {
      closed = true
      marked++
    },
    stopRenewTimer: () => {
      stopped++
    },
    release: () => {
      released++
    },
  }
  return { state, counts: () => ({ stopped, marked, released }), isClosed: () => closed }
}

test("cleanup-on-throw: timer dimatikan, lease dilepas sekali, idempoten", () => {
  const spy = spyState()
  releaseWriterLeaseAfterStartupThrow(spy.state)
  expect(spy.counts()).toEqual({ stopped: 1, marked: 1, released: 1 })
  expect(spy.isClosed()).toBe(true)

  // Safety-net `exit` bisa terbangun SETELAH cleanup phase startup; flag
  // `writerClosed` yang sama harus membuat pelepasan kedua jadi no-op.
  releaseWriterLeaseAfterStartupThrow(spy.state)
  expect(spy.counts()).toEqual({ stopped: 2, marked: 1, released: 1 })
})

test("cleanup-on-throw: sesi sudah ditutup → lease tak dilepas ulang", () => {
  const spy = spyState()
  spy.state.markClosed()
  releaseWriterLeaseAfterStartupThrow(spy.state)
  expect(spy.counts()).toEqual({ stopped: 1, marked: 1, released: 0 })
})

test("cleanup-on-throw: pelemparan gagal tak menimpa galat asli (best-effort)", () => {
  const spy = spyState()
  const throwing: WriterStartupCleanupState = {
    ...spy.state,
    release: () => {
      throw new Error("release-gagal")
    },
  }
  let caught: unknown
  try {
    releaseWriterLeaseAfterStartupThrow(throwing)
  } catch (e) {
    caught = e
  }
  // Helper sengaja TIDAK menelan — pemanggil (startupPhase/exit) yang
  // memutuskan. Yang diuji di sini: closure produksi memakai
  // `releaseSessionWriter` yang tak pernah melempar (lihat authority.ts).
  expect((caught as Error).message).toBe("release-gagal")
})

test("createCliSession: throw pasca-admission melepas lease & mengizinkan re-acquire", async () => {
  const dir = ws()
  const sid = "audit-fix-writer-startup-leak"
  try {
    const before = process.listeners("exit")
    let err: unknown
    try {
      await createCliSession({
        cwd: dir,
        sessionId: sid,
        prompt: "hi",
        enterRepl: false,
        verbose: false,
        allowAll: false,
        ask: false,
        allowlist: false,
        verify: false,
        // Seam injeksi: `onPhase` dipanggil oleh startupPhase SETELAH
        // admission + renew timer menyala, sebelum close() terdaftar.
        onPhase: (name) => {
          if (name === "provider-layer") throw new Error("boom-provider-layer")
        },
      })
    } catch (e) {
      err = e
    }
    expect((err as Error)?.message).toBe("boom-provider-layer")

    // Cleanup phase startup sudah melepas lease lebih awal — inilah yang
    // mencegah WRITER_REFUSED pada host panjang-usia (ACP/daemon).
    expect(describeSessionHolder(sid, dir).active).toBe(false)

    // Safety-net `exit` tetap terpasang dan idempoten saat proses berakhir.
    const added = process.listeners("exit").filter((l) => !before.includes(l))
    expect(added.length).toBe(1)
    const safetyNet = added[0] as () => void
    try {
      safetyNet()
    } finally {
      process.removeListener("exit", safetyNet)
    }
    expect(describeSessionHolder(sid, dir).active).toBe(false)

    // Gejala aslinya hilang: penulis baru bisa mengambil lease sesi yang sama.
    const retryToken = writerTokenFor("audit-fix-retry-boot")
    const re = acquireSessionWriter({
      sessionId: sid,
      cwd: dir,
      bootId: "audit-fix-retry-boot",
      token: retryToken,
    })
    expect(re.ok).toBe(true)
    if (re.ok) releaseSessionWriter(sid, retryToken, dir)
  } finally {
    cleanup(dir)
  }
})
