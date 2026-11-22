// E-1: entry tipis (cli/minicode.js → cli/entry.ts) harus identik secara
// teramati dengan pemanggilan langsung cli/index.ts untuk meta flag, sementara
// argv ber-subcommand tetap melewati dispatch() di index.ts seperti sebelumnya.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { HELP, readVersion } from "../cli/help.ts"
import { LIMITS } from "../src/constants.ts"

const repoRoot = resolve(import.meta.dir, "..")
const direct = join(repoRoot, "cli", "index.ts")
const wrapper = join(repoRoot, "cli", "minicode.js")

interface Run {
  code: number
  stdout: string
  stderr: string
}

function run(entry: string, args: string[]): Run {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1", NO_UPDATE_CHECK: "1" },
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

describe("cli help in-process: nilai konkret, bukan perbandingan dua jalur", () => {
  test("readVersion() membaca package.json yang sama dengan CHANGELOG teratas", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      version: string
    }
    expect(readVersion()).toBe(pkg.version)
  })

  test("HELP memuat perintah & flag yang sebenarnya didukung", () => {
    for (const needle of [
      'minicode "prompt" [options]',
      "minicode exec",
      "minicode acp",
      "--work-mode",
      "--budget",
      "--tool-scope",
    ]) {
      expect(HELP).toContain(needle)
    }
  })
})

describe("cli entry tipis: output meta flag identik", () => {
  const cases: string[][] = [
    ["--version"],
    ["-v"],
    ["--help"],
    ["-h"],
    ["--help", "--json"],
    ["--help", "--tui"],
    ["--verbose", "--help"],
  ]

  for (const args of cases) {
    test(`minicode ${args.join(" ")}`, () => {
      const a = run(direct, args)
      const b = run(wrapper, args)
      expect(b.code).toBe(a.code)
      expect(b.stdout).toBe(a.stdout)
      expect(b.stderr).toBe(a.stderr)
    })
  }

  test("subcommand --help masih diproses router (bukan help global)", () => {
    for (const args of [
      ["sessions", "--help"],
      ["exec", "--help"],
      ["skills", "--help"],
    ]) {
      const a = run(direct, args)
      const b = run(wrapper, args)
      expect(b.code, args.join(" ")).toBe(a.code)
      expect(b.stdout, args.join(" ")).toBe(a.stdout)
      expect(b.stderr, args.join(" ")).toBe(a.stderr)
      expect(b.stdout).not.toContain("Options:\n  -h, --help")
    }
  })
})

describe("BUG-2: default --max-steps di help berasal dari konstanta", () => {
  test("help teks & help JSON menyebut LIMITS.DEFAULT_MAX_STEPS", () => {
    const text = run(wrapper, ["--help"]).stdout
    expect(text).toContain(
      `--max-steps <n>     max tool steps (default ${LIMITS.DEFAULT_MAX_STEPS})`,
    )
    expect(text).not.toContain("max tool steps (default 50)")
    const json = JSON.parse(run(wrapper, ["--help", "--json"]).stdout) as {
      options: { flag: string; desc: string }[]
    }
    const maxSteps = json.options.find((o) => o.flag === "--max-steps <n>")
    expect(maxSteps?.desc).toBe(`max tool steps (default ${LIMITS.DEFAULT_MAX_STEPS})`)
  })
})
