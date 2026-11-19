// Audit v7.40 — regresi scope filter driver: definisi filter GLOBAL/SISTEM
// (mis. Git LFS bawaan Git-for-Windows) jangan sampai dianggap filter repo.
// Sebelum perbaikan, query `git config` tanpa `--local` mengembalikan definisi
// LFS operator dan mem-blokir SETIAP commit/restore (false positive). Fixture
// di bawah meniru mesin tersebut: hanya config global yang berisi filter LFS.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverFilterDrivers, GIT_SAFE_BASE } from "../src/lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { gitCheckoutTool, gitCommitTool, gitRestoreTool } from "../src/tools/git.ts"

setDefaultTimeout(60_000)

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

const uid = randomUUID()
// Config global PALSU: filter LFS seperti yang dipasang Git-for-Windows.
const fakeGlobalConfig = join(tmpdir(), `mc-filter-scope-global-${uid}`)
// Netralisasi atribut global: jangan sampai file atribut operator menandai
// `filter=lfs` pada path fixture dan mengubah konten/eksekusi test.
const emptyAttrs = join(tmpdir(), `mc-filter-scope-attrs-${uid}`)
const originalGlobal = process.env.GIT_CONFIG_GLOBAL
const originalNoSystem = process.env.GIT_CONFIG_NOSYSTEM

beforeAll(async () => {
  await writeFile(emptyAttrs, "", "utf8")
  await writeFile(
    fakeGlobalConfig,
    `[core]\n\tattributesFile = ${emptyAttrs.replace(/\\/g, "/")}\n` +
      '[filter "lfs"]\n\tsmudge = git-lfs smudge -- %f\n\tclean = git-lfs clean -- %f\n',
    "utf8",
  )
  process.env.GIT_CONFIG_GLOBAL = fakeGlobalConfig
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})

afterAll(async () => {
  if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = originalGlobal
  if (originalNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = originalNoSystem
  await rm(fakeGlobalConfig, { force: true }).catch(() => {})
  await rm(emptyAttrs, { force: true }).catch(() => {})
})

function git(args: string[], cwd: string): string {
  const r = spawnSync(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} gagal: ${r.stderr}`)
  return r.stdout.trim()
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mc-filter-scope-"))
  git(["init", "-q"], dir)
  git(["config", "--local", "user.email", "t@example.com"], dir)
  git(["config", "--local", "user.name", "t"], dir)
  git(["config", "--local", "commit.gpgsign", "false"], dir)
  return dir
}

const ctxFor = (dir: string) => ({ cwd: dir, signal: AbortSignal.timeout(30000) }) as never

async function seededRepo(): Promise<string> {
  const dir = await tempRepo()
  await writeFile(join(dir, "a.txt"), "v1\n", "utf8")
  git(["add", "--", "a.txt"], dir)
  git(["commit", "-qm", "init"], dir)
  return dir
}

describe.skipIf(!gitAvailable)("scope filter: hanya driver LOKAL yang dihitung", () => {
  test("hanya filter global → discoverFilterDrivers returns []", async () => {
    const dir = await tempRepo()
    try {
      // Kontrol: query tanpa `--local` memang melihat filter LFS global.
      const all = spawnSync(
        resolveTrustedExecutable("git"),
        ["config", "--get-regexp", "^filter\\.lfs\\.(clean|smudge)$"],
        { cwd: dir, encoding: "utf8", timeout: 15000 },
      )
      expect(all.stdout).toContain("filter.lfs.clean")

      expect(await discoverFilterDrivers(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hanya filter global → git_commit tidak menolak karena filter", async () => {
    const dir = await seededRepo()
    try {
      await writeFile(join(dir, "a.txt"), "v2\n", "utf8")
      const out = (await gitCommitTool.execute(
        { message: "commit dengan LFS global", paths: ["a.txt"] },
        ctxFor(dir),
      )) as string
      expect(out.trim()).not.toBe("")
      expect(git(["show", "--pretty=format:", "--name-only", "HEAD"], dir)).toBe("a.txt")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hanya filter global → git_restore/git_checkout tidak menolak karena filter", async () => {
    const dir = await seededRepo()
    try {
      await writeFile(join(dir, "a.txt"), "v2\n", "utf8")
      await gitRestoreTool.execute({ path: "a.txt" }, ctxFor(dir))
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("v1\n")

      await writeFile(join(dir, "a.txt"), "v3\n", "utf8")
      await gitCheckoutTool.execute({ path: "a.txt" }, ctxFor(dir))
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("v1\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("filter.evil.smudge LOKAL → tetap ditemukan dan ditolak (fail-closed)", async () => {
    const dir = await seededRepo()
    try {
      git(["config", "--local", "filter.evil.smudge", "cat"], dir)

      const drivers = await discoverFilterDrivers(dir)
      expect(drivers.map((d) => d.name)).toContain("evil")

      await expect(
        gitCommitTool.execute({ message: "x", paths: ["a.txt"] }, ctxFor(dir)),
      ).rejects.toThrow(/blocked before staging.*filter\.evil|filters are configured/)
      await expect(gitRestoreTool.execute({ path: "a.txt" }, ctxFor(dir))).rejects.toThrow(
        /filters are configured/,
      )
      await expect(gitCheckoutTool.execute({ path: "a.txt" }, ctxFor(dir))).rejects.toThrow(
        /filters are configured/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("filter di file [include] config repo → tetap ditemukan (fail-open dicegah)", async () => {
    const dir = await seededRepo()
    const inc = join(tmpdir(), `mc-filter-scope-inc-${uid}`)
    try {
      await writeFile(inc, '[filter "evilinc"]\n\tsmudge = cat\n', "utf8")
      git(["config", "--local", "include.path", inc.replace(/\\/g, "/")], dir)

      // `--local` saja tidak mengikuti include; `--includes` menutup celah ini.
      expect((await discoverFilterDrivers(dir)).map((d) => d.name)).toContain("evilinc")
      await expect(
        gitCommitTool.execute({ message: "x", paths: ["a.txt"] }, ctxFor(dir)),
      ).rejects.toThrow(/filters are configured/)
    } finally {
      await rm(inc, { force: true }).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })
})
