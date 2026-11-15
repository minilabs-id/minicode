import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { createMinicodeSession } from "../src/app/session.ts"

test("harness communicates the live model budget independently of OS context", async () => {
  const cwd = mkdtempSync(join(process.cwd(), "capacity-prompt-"))
  const seen: string[] = []
  let capacity = 131_072
  const provider: ModelProvider = {
    id: "capacity-test",
    models: ["test-model"],
    async *stream(req) {
      seen.push(req.system ?? "")
      yield { type: "text", text: "ok" }
      yield { type: "finish", reason: "stop" }
    },
  }
  try {
    const session = await createMinicodeSession({
      provider,
      cwd,
      model: "test-model",
      contextWindowTokensForModel: () => capacity,
    })
    await session.run("hello", {})
    capacity = 1_000_000
    await session.run("continue", {})
    expect(seen[0]).toContain("budgets 131072 tokens")
    expect(seen[1]).toContain("budgets 1000000 tokens")
    expect(seen[1]).toContain("not a guarantee from the provider")
    expect(seen[1]).toContain(`Platform: ${process.platform}`)
    if (process.platform === "win32") expect(seen[1]).toContain("cmd.exe")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
