// Regresi audit: perintah git yang GAGAL tapi mengeluarkan stdout/stderr dulu
// di-resolve sebagai sukses (`code !== 0 && !marked`). Sekarang exit code bukan
// nol selalu ditandai `exit N\n` seperti bash tool, sementara deteksi teks
// "nothing to commit" di gitCommitTool tetap dipertahankan.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIT_SAFE_BASE } from "../src/lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import { gitCommitTool, gitPushTool } from "../src/tools/git.ts"

const isolated = join(tmpdir(), `audit-git-config-${randomUUID()}`)
const prevGlobal = process.env.GIT_CONFIG_GLOBAL
const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM
beforeAll(() => {
  writeFileSync(isolated, "", "utf8")
  process.env.GIT_CONFIG_GLOBAL = isolated
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})
afterAll(() => {
  if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGlobal
  if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem
  rmSync(isolated, { force: true })
})

const gitAvailable =
  spawnSync("git", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0

function git(cwd: string, args: string[]): string {
  const r = spawnSync(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  })
  if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(" ")} failed`)
  return r.stdout.trim()
}

function freshRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "audit-git-"))
  git(cwd, ["init", "-q"])
  git(cwd, ["config", "user.email", "audit@example.invalid"])
  git(cwd, ["config", "user.name", "Audit"])
  git(cwd, ["config", "commit.gpgsign", "false"])
  return cwd
}

test.skipIf(!gitAvailable)("git gagal + stderr kini menghasilkan `exit N\\n...`", async () => {
  const cwd = freshRepo()
  try {
    const out = (await gitPushTool.execute({ remote: "no-such-remote-audit" }, {
      cwd,
      signal: new AbortController().signal,
    } as never)) as string
    // Sebelum perbaikan: "fatal: 'no-such-remote-audit' ..." tanpa prefix exit.
    expect(out).toMatch(/^exit \d+\n/)
    expect(out).toContain("no-such-remote-audit")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test.skipIf(!gitAvailable)("commit pertama di repo tanpa HEAD tetap jalan", async () => {
  const cwd = freshRepo()
  try {
    writeFileSync(join(cwd, "first.txt"), "isi\n", "utf8")
    await gitCommitTool.execute({ message: "first commit", paths: ["first.txt"] }, {
      cwd,
      signal: new AbortController().signal,
    } as never)
    expect(git(cwd, ["rev-list", "--count", "HEAD"])).toBe("1")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test.skipIf(!gitAvailable)("deteksi 'nothing to commit' tidak rusak oleh prefix exit", async () => {
  const cwd = freshRepo()
  try {
    writeFileSync(join(cwd, "file.txt"), "isi\n", "utf8")
    git(cwd, ["add", "--all"])
    git(cwd, ["commit", "-qm", "initial"])
    const out = (await gitCommitTool.execute(
      { message: "pesan yang berbeda", paths: ["file.txt"] },
      { cwd, signal: new AbortController().signal } as never,
    )) as string
    expect(out).toContain("nothing to commit:")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
