import { expect, test } from "bun:test"
import { createEventBus, createToolRegistry } from "#minicore"
import { parallelExecutor } from "../src/policy/executor.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

for (const kind of ["read", "keyed", "mixed", "unkeyed"] as const) {
  test(`A6: ${kind} abort returns promptly but replacement waits for outstanding work`, async () => {
    const started = deferred()
    const release = deferred()
    const name = kind === "read" ? "read_file" : kind === "unkeyed" ? "bash" : "write_file"
    let executions = 0
    const tool = {
      name,
      description: "controlled effect",
      parameters: { type: "object" as const, additionalProperties: true },
      async execute() {
        executions++
        if (executions === 1) {
          started.resolve()
          await release.promise
        }
        return "ok"
      },
    }
    const controller = new AbortController()
    const deps = {
      registry: createToolRegistry([tool]),
      permissions: { check: async () => "allow" as const },
      events: createEventBus(),
      signal: controller.signal,
      state: { history: [], turnCount: 0, stepCount: 0 },
      maxResultTokens: 1000,
    }
    const executor = parallelExecutor()
    const calls = [{ id: "a", name, args: { path: "unused" } }]
    if (kind === "mixed") calls.push({ id: "b", name: "read_file", args: { path: "unused" } })
    const running = executor.execute(calls, deps)
    await started.promise
    controller.abort()
    try {
      await expect(running).rejects.toThrow()
      const replacement = executor.execute([{ id: "new", name, args: { path: "unused" } }], {
        ...deps,
        signal: new AbortController().signal,
      })
      await new Promise((r) => setTimeout(r, 10))
      expect(executions).toBe(1)
      release.resolve()
      expect(await replacement).toHaveLength(1)
      expect(executions).toBe(2)
    } finally {
      release.resolve()
    }
  })
}
