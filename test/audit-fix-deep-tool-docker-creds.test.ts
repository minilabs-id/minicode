// Audit finding 5: bash mode unrestricted meneruskan kredensial git lewat
// sanitizeSpawnEnv(..., relaxed), tetapi runInDocker menyanitasi ulang tanpa
// allowGitCredentials sehingga GITHUB_TOKEN/GH_TOKEN gugur di container.
import { afterEach, expect, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { runInDocker, setDockerSpawnForTest } from "../src/sandbox/docker.ts"

afterEach(() => setDockerSpawnForTest(null))

function capturingSpawn(captured: Array<Record<string, string> | undefined>): typeof spawn {
  return ((_cmd: string, _args: readonly string[], opts?: { env?: Record<string, string> }) => {
    captured.push(opts?.env)
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(() => child.emit("close", 0))
    return child
  }) as typeof spawn
}

const envFixture = {
  GITHUB_TOKEN: "ghp_secret_git",
  GH_TOKEN: "ghp_secret_gh",
  SOME_API_KEY: "secret_should_strip",
}

test("runInDocker mewariskan kredensial git hanya bila allowGitCredentials", async () => {
  const captured: Array<Record<string, string> | undefined> = []
  setDockerSpawnForTest(capturingSpawn(captured))

  await runInDocker("echo hi", process.cwd(), {
    env: { ...envFixture },
    allowGitCredentials: true,
  })
  const relaxedEnv = captured[0]!
  expect(relaxedEnv.GITHUB_TOKEN).toBe("ghp_secret_git")
  expect(relaxedEnv.GH_TOKEN).toBe("ghp_secret_gh")
  // Kredensial non-git tetap di-strip walaupun mode unrestricted.
  expect(relaxedEnv.SOME_API_KEY).toBeUndefined()

  await runInDocker("echo hi", process.cwd(), { env: { ...envFixture } })
  const defaultEnv = captured[1]!
  expect(defaultEnv.GITHUB_TOKEN).toBeUndefined()
  expect(defaultEnv.GH_TOKEN).toBeUndefined()
})
