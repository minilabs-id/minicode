// Audit #3 — regresi lock rewind yang basi tapi PID-nya didaur ulang.
// Format lama hanya menyimpan PID; `process.kill(pid, 0)` sukses selamanya bila
// PID dipakai ulang → rewind permanently blocked di Windows. Format baru
// menyimpan {pid,bootId,createdAt}; staleness juga dicek dari mtime berkas
// (berlaku untuk format lama maupun baru).
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DomainEvent } from "../src/presentation/events.ts"
import { appendPresentationEvents, saveSession } from "../src/session/persistence.ts"
import { listUserTurns, rewindToTurn } from "../src/session/rewind.ts"

let seq = 0

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mc-rwlock-"))
  await mkdir(join(dir, ".minicode"), { recursive: true })
  return dir
}

function event(value: Record<string, unknown>): DomainEvent {
  return value as unknown as DomainEvent
}

async function setup(
  cwd: string,
): Promise<{ id: string; target: ReturnType<typeof listUserTurns>[number] }> {
  const id = `rwlock-${process.pid}-${Date.now().toString(36)}-${seq++}`
  await saveSession(
    id,
    cwd,
    "sys",
    [
      { role: "user", content: "turn satu" },
      { role: "assistant", content: "jawaban satu" },
    ],
    { turns: 1 },
  )
  await appendPresentationEvents(id, cwd, [
    event({
      eventSeq: 0,
      ts: Date.now() - 10_000,
      sessionId: id,
      turnId: 0,
      type: "user.message",
      text: "turn satu",
      promptRef: "p0",
    }),
  ])
  return { id, target: listUserTurns(id, cwd)[0]! }
}

async function lockPath(cwd: string): Promise<string> {
  const dir = join(cwd, ".minicode", "rewinds")
  await mkdir(dir, { recursive: true })
  return join(dir, "operation.lock")
}

test("rewind: lock numerik basi dengan PID hidup tidak memblokir (mtime)", async () => {
  const cwd = await makeCwd()
  const { id, target } = await setup(cwd)
  const path = await lockPath(cwd)
  // PID hidup (proses test ini) + mtime lama: kode lama mengira masih aktif.
  await writeFile(path, String(process.pid), "utf8")
  const stale = new Date(Date.now() - 60 * 60 * 1000)
  await utimes(path, stale, stale)

  const result = await rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })
  expect(result.branchId).toBeTruthy()
  expect(existsSync(path)).toBe(false)
  // Handle DB persistence bisa tertahan sejenak di Windows — cleanup best-effort
  // (pola yang sama seperti test/session-rewind.test.ts).
  await rm(cwd, { recursive: true, force: true }).catch(() => {})
})

test("rewind: lock format baru dengan bootId berbeda dianggap basi", async () => {
  const cwd = await makeCwd()
  const { id, target } = await setup(cwd)
  const path = await lockPath(cwd)
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      bootId: "boot-lama-yang-sudah-berubah",
      createdAt: Date.now(),
    }),
    "utf8",
  )

  const result = await rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })
  expect(result.branchId).toBeTruthy()
  expect(existsSync(path)).toBe(false)
  // Handle DB persistence bisa tertahan sejenak di Windows — cleanup best-effort
  // (pola yang sama seperti test/session-rewind.test.ts).
  await rm(cwd, { recursive: true, force: true }).catch(() => {})
})

test("rewind: lock segar dengan PID hidup tetap memblokir", async () => {
  const cwd = await makeCwd()
  const { id, target } = await setup(cwd)
  const path = await lockPath(cwd)
  await writeFile(path, String(process.pid), "utf8")

  await expect(rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })).rejects.toThrow(
    /another rewind operation is active/,
  )
  expect(existsSync(path)).toBe(true)
  // Handle DB persistence bisa tertahan sejenak di Windows — cleanup best-effort
  // (pola yang sama seperti test/session-rewind.test.ts).
  await rm(cwd, { recursive: true, force: true }).catch(() => {})
})
