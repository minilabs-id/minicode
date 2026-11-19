// Audit finding 3: runGit meng-resolve `exit null` saat abort/timeout tanpa
// memeriksa signal induk, jadi pembatalan user tampil seperti hasil normal.
// Regresi: abort harus menolak dengan signal.reason.
import { afterEach, expect, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { runGit, setGitSpawnForTest } from "../src/tools/git.ts"

afterEach(() => setGitSpawnForTest(null))

function fakeGitSpawn(closeOnSpawn = false): typeof spawn {
  return ((_cmd: string, _args: readonly string[]) => {
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        queueMicrotask(() => child.emit("close", null))
        return true
      },
    })
    if (closeOnSpawn) queueMicrotask(() => child.emit("close", 0))
    return child
  }) as typeof spawn
}

test("runGit menolak dengan signal.reason saat signal dibatalkan", async () => {
  setGitSpawnForTest(fakeGitSpawn())
  const controller = new AbortController()
  const reason = new Error("user cancelled")
  const pending = runGit(["status"], process.cwd(), controller.signal)
  controller.abort(reason)

  let thrown: unknown
  try {
    await pending
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBe(reason)
})

test("runGit tanpa abort tetap mengembalikan teks hasil", async () => {
  setGitSpawnForTest(fakeGitSpawn(true))
  const out = await runGit(["status"], process.cwd(), new AbortController().signal)
  expect(typeof out).toBe("string")
  expect(out).toContain("(exit 0)")
})
