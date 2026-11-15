import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { osSandboxAvailable, runInOsSandbox } from "../src/sandbox/os.ts"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("OS sandbox rejects preaborted signals before backend detection or execution", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled before spawn")
  controller.abort(reason)
  await expect(runInOsSandbox("exit 0", process.cwd(), { signal: controller.signal })).rejects.toBe(
    reason,
  )
})

test("OS sandbox preserves the default AbortError", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    runInOsSandbox("exit 0", process.cwd(), { signal: controller.signal }),
  ).rejects.toHaveProperty("name", "AbortError")
})

test.skipIf(!osSandboxAvailable())(
  "native abort kills descendants and timeout reports unknown outcome",
  async () => {
    const cwd = mkdtempSync(join(process.cwd(), "os-abort-test-"))
    const controller = new AbortController()
    const reason = new Error("cancel running group")
    let running: Promise<unknown> | undefined
    try {
      // A background shell inherits the process group and keeps stdout open.
      // Killing only the wrapper would leave it writing and prevent close.
      running = runInOsSandbox(
        "(while :; do printf x >> heartbeat; sleep 0.05; done) & wait",
        cwd,
        { signal: controller.signal, timeoutMs: 3000 },
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      const heartbeat = join(cwd, "heartbeat")
      let ready = false
      for (let i = 0; i < 100; i++) {
        try {
          ready = readFileSync(heartbeat, "utf8").length > 0
        } catch {}
        if (ready) break
        await delay(20)
      }
      expect(ready).toBe(true)
      controller.abort(reason)
      expect(await running).toEqual({ error: reason })
      const stopped = readFileSync(heartbeat, "utf8")
      await delay(150)
      expect(readFileSync(heartbeat, "utf8")).toBe(stopped)
      await expect(runInOsSandbox("sleep 10", cwd, { timeoutMs: 100 })).rejects.toThrow(
        "state=UNKNOWN reason=TIMEOUT",
      )
    } finally {
      controller.abort(reason)
      await running
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  10000,
)
