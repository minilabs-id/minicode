import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { bashKillTool, bashOutputTool, bashTool, listBackgroundJobs } from "../src/tools/bash.ts"

const sessionRoot = fileURLToPath(new URL("../src/", import.meta.url))
const normalize = (path: string) => {
  const absolute = resolve(path.trim())
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

for (const cwd of [undefined, "tools"]) {
  test(`A2: background cwd ${cwd === undefined ? "defaults to session root" : "resolves relative to session root"}`, async () => {
    const savedSandbox = process.env.MINICODE_SANDBOX
    const ctx = {
      cwd: sessionRoot,
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof bashTool.execute>[1]
    let id: string | undefined
    try {
      delete process.env.MINICODE_SANDBOX
      expect(normalize(sessionRoot)).not.toBe(normalize(process.cwd()))
      const started = (await bashTool.execute(
        {
          cmd: process.platform === "win32" ? "cd" : "pwd",
          background: true,
          ...(cwd === undefined ? {} : { cwd }),
        },
        ctx,
      )) as string
      id = /background job started: (bg_[\w-]+)/.exec(started)?.[1]
      expect(id).toBeDefined()
      const deadline = Date.now() + 3000
      while (!listBackgroundJobs().find((job) => job.id === id)?.done) {
        if (Date.now() >= deadline) throw new Error("Background cwd probe timed out")
        await Bun.sleep(10)
      }
      const output = (await bashOutputTool.execute({ id }, ctx)) as string
      expect(output.split("\n")[0]).toContain("finished (exit 0)")
      expect(normalize(output.split("\n").slice(1).join("\n"))).toBe(
        normalize(cwd === undefined ? sessionRoot : resolve(sessionRoot, cwd)),
      )
    } finally {
      if (id) await bashKillTool.execute({ id }, ctx)
      if (savedSandbox === undefined) delete process.env.MINICODE_SANDBOX
      else process.env.MINICODE_SANDBOX = savedSandbox
    }
  })
}
