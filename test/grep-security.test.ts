import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeSpawnEnv } from "../src/policy/scrub.ts"
import { grepTool, ripgrepAvailable } from "../src/tools/grep.ts"

describe("grep subprocess isolation", () => {
  test("ignores configured preprocessors and does not pass credential env", async () => {
    if (!ripgrepAvailable()) return

    const root = await mkdtemp(join(tmpdir(), "minicode-grep-security-"))
    const previousConfig = process.env.RIPGREP_CONFIG_PATH
    const previousApiKey = process.env.OPENAI_API_KEY
    const previousEngine = process.env.MINICODE_GREP_ENGINE
    const marker = join(root, "preprocessor-ran.txt")
    const config = join(root, "rg.conf")
    const payload = join(root, "payload.js")
    try {
      await writeFile(config, `--pre\n${JSON.stringify(process.execPath)}\n`, "utf8")
      await writeFile(
        payload,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.env.OPENAI_API_KEY ?? "missing");\n`,
        "utf8",
      )
      await writeFile(join(root, "input.txt"), "ordinary workspace input\n", "utf8")
      process.env.RIPGREP_CONFIG_PATH = config
      process.env.OPENAI_API_KEY = "dummy-grep-probe"
      delete process.env.MINICODE_GREP_ENGINE
      expect(sanitizeSpawnEnv(process.env).OPENAI_API_KEY).toBeUndefined()

      await grepTool.execute({ pattern: "never_match_grep_security_probe", cwd: root, limit: 5 }, {
        cwd: root,
        signal: new AbortController().signal,
      } as never)

      expect(existsSync(marker)).toBe(false)
    } finally {
      if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH
      else process.env.RIPGREP_CONFIG_PATH = previousConfig
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousApiKey
      if (previousEngine === undefined) delete process.env.MINICODE_GREP_ENGINE
      else process.env.MINICODE_GREP_ENGINE = previousEngine
      await rm(root, { recursive: true, force: true })
    }
  })

  test("Wave 4 fallback JS: memprioritaskan src/ di atas CHANGELOG.md/test/ dan menolak symlink keluar", async () => {
    const root = await mkdtemp(join(tmpdir(), "minicode-grep-prio-"))
    const outside = await mkdtemp(join(tmpdir(), "minicode-grep-out-"))
    const prevEngine = process.env.MINICODE_GREP_ENGINE
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      await mkdir(join(root, "src"), { recursive: true })
      await mkdir(join(root, "test"), { recursive: true })
      await writeFile(
        join(root, "CHANGELOG.md"),
        Array.from({ length: 12 }, (_, i) => `NEEDLE_TOKEN changelog ${i}`).join("\n"),
        "utf8",
      )
      await writeFile(join(root, "test", "a.test.ts"), "const x = 'NEEDLE_TOKEN in test'\n", "utf8")
      await writeFile(join(root, "src", "hub.ts"), "export const NEEDLE_TOKEN = 1\n", "utf8")
      const outFile = join(outside, "leak.ts")
      await writeFile(outFile, "export const NEEDLE_TOKEN = 'OUTSIDE'\n", "utf8")
      try {
        await symlink(outFile, join(root, "src", "escape.ts"), "file")
      } catch {}

      const out = (await grepTool.execute({ pattern: "NEEDLE_TOKEN", cwd: root, limit: 1 }, {
        cwd: root,
        signal: new AbortController().signal,
      } as never)) as string
      expect(out).toContain("src/hub.ts:1:")
      expect(out).not.toContain("CHANGELOG.md")
      expect(out).not.toContain("OUTSIDE")
    } finally {
      if (prevEngine === undefined) delete process.env.MINICODE_GREP_ENGINE
      else process.env.MINICODE_GREP_ENGINE = prevEngine
      await rm(root, { recursive: true, force: true }).catch(() => {})
      await rm(outside, { recursive: true, force: true }).catch(() => {})
    }
  })
})
