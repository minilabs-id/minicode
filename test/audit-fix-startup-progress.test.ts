// v7.44 (audit) — bar progres startup satu-baris. Yang diuji:
//   1. `createStartupProgress()` (dari cli/tui.ts) = callback `onPhase` untuk
//      jalur interaktif: satu write per fase, `\r` di akhir, prefix update
//      saat resume, dan OPT-OUT `MINICODE_STARTUP_PROGRESS=0` = nol byte.
//   2. `createCliSession` benar-benar memanggil `opts.onPhase` (seam yang
//      dipakai callback di atas), dibuktikan lewat throw deterministik di
//      fase pertama — tanpa provider/network.
//
// TIDAK dicakup di sini: integrasi TTY penuh (alt-screen + scrollback). Itu
// butuh harness pseudo-terminal; yang dijamin oleh test ini adalah pure
// callback + kontrak barisnya, sedangkan penulisan blok penutup diverifikasi
// lewat helper murni di test/audit-fix-session-summary.test.ts.

import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backgroundJobExitCleanup, createCliSession } from "../cli/setup.ts"
import { createStartupProgress, STARTUP_PHASE_NAMES } from "../cli/tui.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

isolateHomeForTests()

function spy(opts?: Parameters<typeof createStartupProgress>[0]) {
  const writes: string[] = []
  const progress = createStartupProgress({
    ...opts,
    write: (s: string) => writes.push(s),
  })
  return { progress, writes }
}

test("createStartupProgress: satu write per fase, CR di akhir, hanya angka berubah", () => {
  const { progress, writes } = spy({ env: {} })
  expect(progress.enabled).toBe(true)
  for (const phase of STARTUP_PHASE_NAMES) progress.onPhase(phase)
  expect(writes).toEqual([
    "start 11%\r",
    "start 22%\r",
    "start 33%\r",
    "start 44%\r",
    "start 55%\r",
    "start 66%\r",
    "start 77%\r",
    "start 88%\r",
  ])
  progress.finish()
  expect(writes.at(-1)).toBe("start 100%\n")
  // Idempoten: newline penutup hanya ditulis sekali meski finish dipanggil lagi.
  progress.finish()
  expect(writes.filter((w) => w.endsWith("100%\n"))).toHaveLength(1)
})

test("createStartupProgress: prefix 'update' saat resume", () => {
  const { progress, writes } = spy({ env: {}, resume: true })
  progress.onPhase("provider-layer")
  progress.onPhase("rag-layer")
  expect(writes).toEqual(["update 11%\r", "update 22%\r"])
  progress.finish()
  expect(writes.at(-1)).toBe("update 100%\n")
})

test("createStartupProgress: MINICODE_STARTUP_PROGRESS=0 = nol byte, callback no-op", () => {
  const { progress, writes } = spy({ env: { MINICODE_STARTUP_PROGRESS: "0" } })
  expect(progress.enabled).toBe(false)
  for (const phase of STARTUP_PHASE_NAMES) progress.onPhase(phase)
  progress.finish()
  expect(writes).toEqual([])
})

test("createCliSession: opts.onPhase menerima nama fase (seam callback)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-startup-progress-"))
  const before = process.listeners("exit")
  const names: string[] = []
  try {
    try {
      await createCliSession({
        cwd: dir,
        sessionId: "audit-fix-startup-progress",
        prompt: "hi",
        enterRepl: false,
        verbose: false,
        allowAll: false,
        ask: false,
        allowlist: false,
        verify: false,
        // Lempar di fase pertama: deterministik, tak butuh provider/network.
        onPhase: (name) => {
          names.push(name)
          throw new Error("stop-after-first-phase")
        },
      })
    } catch (e) {
      expect((e as Error)?.message).toBe("stop-after-first-phase")
    }
    expect(names).toEqual(["provider-layer"])
  } finally {
    // v0.32.1: JANGAN hapus `backgroundJobExitCleanup` — ia dipasang
    // sekali oleh createCliSession lewat flag idempoten di cli/setup.ts.
    // Menghapusnya di sini membuat test deep-mode later melihat listener
    // absen sementara flag masih true → install() jadi no-op → assertion
    // gagal di suite penuh (CI). Hapus HANYA listener milik test ini.
    const added = process
      .listeners("exit")
      .filter((l) => !before.includes(l) && l !== backgroundJobExitCleanup)
    for (const l of added) process.removeListener("exit", l)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows bisa menahan handle DB sebentar (EBUSY); OS membersihkan
      // temp root. Ini flake lingkungan, bukan kegagalan kontrak.
    }
  }
})
