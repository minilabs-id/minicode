// E-26/E-27: satu `ls-tree` per 200 path (bukan per path), jail check tetap
// duluan, dan cache per-cwd hanya untuk gitDir/filter config.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetShadowGitCachesForTest,
  __setShadowGitRunnerForTest,
  gitDir,
  restoreTree,
} from "../src/session/shadow-git.ts"

interface Call {
  args: string[]
  cwd: string
}

const dirs: string[] = []
const TREE = "b".repeat(40)
const NOW = "a".repeat(40)

afterEach(() => {
  __setShadowGitRunnerForTest(null)
  __resetShadowGitCachesForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function cwd(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-shadow-batch-"))
  dirs.push(d)
  return d
}

function fakeGit(calls: Call[], opts: { paths?: string[] } = {}) {
  __setShadowGitRunnerForTest(async (args) => {
    calls.push({ args, cwd: "" })
    if (args[0] === "rev-parse")
      return { code: 0, stdout: join(tmpdir(), "fake-repo", ".git"), stderr: "" }
    if (args[0] === "add" || args[0] === "read-tree" || args[0] === "checkout-index")
      return { code: 0, stdout: "", stderr: "" }
    if (args[0] === "write-tree") return { code: 0, stdout: `${NOW}\n`, stderr: "" }
    if (args[0] === "diff") {
      const listed = opts.paths ?? []
      return {
        code: 0,
        stdout: listed.flatMap((p) => ["M", p]).join("\0") + (listed.length ? "\0" : ""),
        stderr: "",
      }
    }
    if (args[0] === "ls-tree") {
      const requested = args.slice(args.indexOf("--") + 1)
      return {
        code: 0,
        stdout: requested.flatMap((p) => [`100644 blob ${"c".repeat(40)}\t${p}`, ""]).join("\0"),
        stderr: "",
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  })
}

test("ls-tree dipanggil 1× untuk ≤200 path", async () => {
  const dir = cwd()
  const calls: Call[] = []
  fakeGit(calls, { paths: ["src/a.ts", "src/b.ts"] })

  const res = await restoreTree(dir, TREE, { paths: ["src/a.ts", "src/b.ts"], strict: true })
  expect(res.skipped).toEqual([])
  expect(res.applied.length).toBe(2)

  const ls = calls.filter((c) => c.args[0] === "ls-tree")
  expect(ls.length).toBe(1)
  expect(ls[0]!.args.slice(0, 5)).toEqual(["ls-tree", "-r", "-z", TREE, "--"])
  expect(ls[0]!.args.slice(5)).toEqual(["src/a.ts", "src/b.ts"])
})

test("450 path → 3 chunk ls-tree (200/200/50)", async () => {
  const dir = cwd()
  const paths = Array.from({ length: 450 }, (_, i) => `src/f${i}.ts`)
  const calls: Call[] = []
  fakeGit(calls, { paths })

  const res = await restoreTree(dir, TREE, { paths, strict: true })
  expect(res.applied.length).toBe(450)
  const ls = calls.filter((c) => c.args[0] === "ls-tree")
  expect(ls.length).toBe(3)
  expect(ls.map((c) => c.args.length - 5)).toEqual([200, 200, 50])
})

test("path jahat ditolak SEBELUM ls-tree", async () => {
  const dir = cwd()
  const calls: Call[] = []
  fakeGit(calls, { paths: ["../outside.txt"] })

  let threw = false
  try {
    await restoreTree(dir, TREE, { paths: ["../outside.txt"], strict: true })
  } catch (e) {
    threw = true
    expect(String((e as Error).message)).toContain("unsafe restore path")
  }
  expect(threw).toBe(true)
  expect(calls.some((c) => c.args[0] === "ls-tree")).toBe(false)
})

test("chunk ls-tree gagal → throw (tidak lanjut)", async () => {
  const dir = cwd()
  const calls: Call[] = []
  fakeGit(calls, { paths: ["src/a.ts"] })
  __setShadowGitRunnerForTest(async (args) => {
    calls.push({ args, cwd: "" })
    if (args[0] === "rev-parse")
      return { code: 0, stdout: join(tmpdir(), "fake-repo", ".git"), stderr: "" }
    if (args[0] === "write-tree") return { code: 0, stdout: `${NOW}\n`, stderr: "" }
    if (args[0] === "diff") return { code: 0, stdout: "M\0src/a.ts\0", stderr: "" }
    if (args[0] === "ls-tree") return { code: 128, stdout: "", stderr: "boom" }
    return { code: 0, stdout: "", stderr: "" }
  })

  await expect(restoreTree(dir, TREE, { paths: ["src/a.ts"], strict: true })).rejects.toThrow(
    /ls-tree failed/,
  )
})

test("gitDir di-cache per cwd dan diinvalidasi saat .git berubah", async () => {
  const dir = cwd()
  let revParses = 0
  __setShadowGitRunnerForTest(async (args) => {
    if (args[0] === "rev-parse") {
      revParses++
      return { code: 0, stdout: join(dir, ".git"), stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  })

  expect(await gitDir(dir)).toContain(".git")
  expect(await gitDir(dir)).toContain(".git")
  expect(revParses).toBe(1)

  writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n")
  expect(await gitDir(dir)).toContain(".git")
  expect(revParses).toBe(2)

  mkdirSync(join(dir, "sub"), { recursive: true })
  const sub = join(dir, "sub")
  expect(await gitDir(sub)).not.toBeNull()
  expect(revParses).toBe(3)
})
