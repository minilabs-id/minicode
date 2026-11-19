// Audit deep (v7.40) — regression untuk 7 temuan terkonfirmasi pada tool.
// Hermetik: tmpdir per test, spawner git / server LSP / factory anak disuntik.
// Tak ada jaringan, TTY, atau commit nyata. Fokus pada pagar fail-closed DAN
// fakta bahwa jalur normal tak berubah.

import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { LIMITS } from "../src/constants.ts"
import * as atomicWrite from "../src/lib/atomic-write.ts"
import * as lspClient from "../src/lsp/client.ts"
import { gitCheckoutTool, gitRestoreTool, runGit, setGitSpawnForTest } from "../src/tools/git.ts"
import { grepTool, isReDosPronePattern } from "../src/tools/grep.ts"
import { lspRenameTool } from "../src/tools/lsp.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  delegationKey,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import {
  loadTodos,
  restoreTodoViewFromStore,
  saveTodos,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"
import { isolateGitConfigForTests } from "./helpers/isolated-git-config.ts"

// FIX2 butuh determinisme: hanya filter.evil lokal yang boleh terlihat.
isolateGitConfigForTests()

const owned: string[] = []
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  owned.push(d)
  return d
}
const ctx = (cwd: string, sessionId?: string, signal?: AbortSignal) =>
  ({
    cwd,
    sessionId,
    signal: signal ?? new AbortController().signal,
    emit: () => {},
  }) as never
const emitCtx = (cwd: string, sink: unknown[]) =>
  ({ cwd, signal: new AbortController().signal, emit: (e: unknown) => sink.push(e) }) as never

function providerEnv(): () => void {
  const k = process.env.OPENAI_API_KEY
  const a = process.env.AGENT_API_KEY
  if (!k && !a) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (k === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = k
    if (a === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = a
  }
}

afterEach(async () => {
  setGitSpawnForTest(null)
  clearSubAgentSessionFactory()
  lspClient.clearLspServers()
  mock.restore()
  while (owned.length) await rm(owned.pop()!, { recursive: true, force: true }).catch(() => {})
})

// ── FIX 1: pagar ReDoS menangkap quantifier `?` di grup ter-quantify ──────────

test("FIX1: (a?b?)* terdeteksi; pola normal tetap aman", () => {
  // Runtime-proven: ~900ms pada 57 char — sekarang ditolak statis.
  for (const p of ["(a?b?)*$", "(a?b?)*", "(a?b?)+"]) {
    expect(isReDosPronePattern(p), p).toBe(true)
  }
  // Regresi: bentuk lama tetap tertangkap.
  for (const p of ["(a+)+$", "(a|aa)+$", "(a*)*$"]) {
    expect(isReDosPronePattern(p), p).toBe(true)
  }
  // Suffix opsional / pola awalan tak boleh salah ditandai.
  for (const p of ["foo.*Error", "a?b", "(foo)?", "(foo|bar)+", "(a?b?)$"]) {
    expect(isReDosPronePattern(p), p).toBe(false)
  }
  // v7.40 re-audit: prefix grup `(?:`/`(?=`/`(?<=`/`(?<name>`/`(?i:` BUKAN
  // quantifier — dulu `?`-nya salah terdeteksi sehingga `(?:ab)*` ditolak.
  // Non-capturing group yang di-quantify dengan isi aman tetap boleh.
  for (const p of ["(?:ab)*", "(?:foo|bar)+", "(?=ab)c", "(?<=a)b", "(?<word>\\w)", "(?i:ab)*"]) {
    expect(isReDosPronePattern(p), p).toBe(false)
  }
  // Tapi `?` di dalam non-capturing group yang di-quantify TETAP rawan.
  for (const p of ["(?:a?b?)*$", "(?=a?b?)*$"]) {
    expect(isReDosPronePattern(p), p).toBe(true)
  }
})

test("FIX1: (a?b?)*$ ditolak di fallback JS sebelum re.test (tak menggantung)", async () => {
  const dir = await tmp("mc-deep-grep-")
  const prev = process.env.MINICODE_GREP_ENGINE
  process.env.MINICODE_GREP_ENGINE = "js"
  try {
    writeFileSync(join(dir, "bad.txt"), `${"a".repeat(57)}X\n`)
    const result = await Promise.race([
      grepTool.execute({ pattern: "(a?b?)*$", cwd: dir, limit: 5 }, ctx(dir)).then(
        () => "value",
        (e) => `error:${String((e as Error).message)}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
    ])
    expect(result).not.toBe("timeout")
    expect(result).toContain("ReDoS-prone")
  } finally {
    if (prev === undefined) delete process.env.MINICODE_GREP_ENGINE
    else process.env.MINICODE_GREP_ENGINE = prev
  }
})

// ── FIX 2: restore/checkout menolak filter driver repo (smudge = RCE) ─────────

function gitCli(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} gagal: ${r.stderr}`)
}

test("FIX2: git_restore/git_checkout menolak repo dengan filter driver", async () => {
  const dir = await tmp("mc-deep-git-")
  setGitSpawnForTest(null) // pakai git asli untuk discovery + isGitRepo
  gitCli(["init", "-q"], dir)
  gitCli(["config", "filter.evil.clean", "cat"], dir)
  // Keduanya harus gagal SEBELUM restore/checkout menyentuh worktree.
  await expect(gitRestoreTool.execute({ path: "a.ts" }, ctx(dir))).rejects.toThrow(
    /filter\.evil|filters are configured/,
  )
  await expect(gitCheckoutTool.execute({ path: "a.ts" }, ctx(dir))).rejects.toThrow(
    /filter\.evil|filters are configured/,
  )
})

// ── FIX 3: anggaran output stdout+stderr dipakai bersama ──────────────────────

test("FIX3: runGit membatasi total out+err, bukan masing-masing", async () => {
  const dir = await tmp("mc-deep-gitcap-")
  const cap = LIMITS.GIT_OUTPUT_MAX_CHARS
  setGitSpawnForTest(((_cmd: string, _args: string[], _opts: unknown) => {
    const p = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => {}
    queueMicrotask(() => {
      p.stdout.emit("data", Buffer.from("a".repeat(cap)))
      p.stderr.emit("data", Buffer.from("b".repeat(cap)))
      p.emit("close", 0)
    })
    return p
  }) as never)
  const out = await runGit(["status"], dir, new AbortController().signal)
  expect(out.length).toBeLessThanOrEqual(cap + 100)
  expect(out).toContain("truncated")
  // Anggaran habis di stdout → stderr tak boleh menyumbang satu pun char.
  expect(out).not.toContain("bbbb")
})

// ── FIX 4: phantom taskId & pesan perbaikan yang kontradiktif ─────────────────

test("FIX4: taskId phantom dibuang saat TaskStore kosong", async () => {
  const dir = await tmp("mc-deep-todo-")
  const S = "deep-audit"
  const phantom = { content: "legacy", status: "pending" as const, taskId: "t99" }
  await saveTodos(S, [phantom], dir)
  const ids = await restoreTodoViewFromStore(S, dir, [phantom])
  expect(ids).toEqual([])
  const view = await loadTodos(S, dir)
  expect(view).toHaveLength(1)
  expect(view[0]?.taskId).toBeUndefined()
  expect(view[0]?.content).toBe("legacy")
})

test("FIX4: pesan error konsisten — semua taskId dihilangkan bila tak ada id sah", async () => {
  const dir = await tmp("mc-deep-todo-")
  const S = "deep-audit-msg"
  const prevId = todoSession.id
  const prevCwd = todoSession.cwd
  todoSession.id = S
  todoSession.cwd = dir
  try {
    await saveTodos(S, [{ content: "legacy", status: "pending" }], dir)
    let msg = ""
    try {
      await todoWriteTool.execute(
        { todos: [{ taskId: "t1", content: "ghost", status: "pending" }] },
        ctx(dir, S),
      )
    } catch (e) {
      msg = String((e as Error).message)
    }
    expect(msg).toContain("omit every taskId")
    expect(msg).not.toContain("ONLY those taskIds")
  } finally {
    todoSession.id = prevId
    todoSession.cwd = prevCwd
  }
})

// ── FIX 5: [FINDING] dari stream chunk tetap utuh + flush akhir ───────────────

test("FIX5: baris [FINDING] terbelah dua chunk tetap utuh; baris akhir di-flush", async () => {
  const restore = providerEnv()
  const dir = await tmp("mc-deep-child-")
  const emitted: any[] = []
  const factory = async () => ({
    events: {
      on: (name: string, handler: (e: any) => void) => {
        if (name === "provider:text") {
          queueMicrotask(() => {
            handler({ text: "[FI" })
            handler({ text: "NDING] high | src/z.ts:1 | temuan terbelah" })
            handler({ text: "\n[FINDING] low | src/q.ts:9 | baris akhir tanpa newline" })
          })
        }
        return () => {}
      },
    },
    run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
  })
  setSubAgentSessionFactory(factory as never)
  try {
    await delegateTaskTool.execute({ prompt: "split-stream" }, emitCtx(dir, emitted))
    const reports = emitted.filter((e) => e?.kind === "minicode:child-report")
    expect(reports).toHaveLength(2)
    expect(reports[0]?.data?.finding).toBe("high | src/z.ts:1 | temuan terbelah")
    expect(reports[1]?.data?.finding).toBe("low | src/q.ts:9 | baris akhir tanpa newline")
  } finally {
    restore()
  }
})

// ── FIX 6: lsp_rename — batas newText, preflight tulis, rollback ──────────────

test("FIX6: newText per edit dibatasi sebelum ada tulisan", async () => {
  const dir = await tmp("mc-deep-lsp-")
  writeFileSync(join(dir, "a.ts"), "const oldName = 1\n")
  lspClient.configureServers([{ ext: ".ts", command: "stub", args: [] }])
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  const uri = pathToFileURL(join(dir, "a.ts")).href
  spyOn(lspClient, "lspCall").mockResolvedValue({
    changes: {
      [uri]: [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
          newText: "x".repeat(LIMITS.LSP_RENAME_MAX_NAME_CHARS * 4 + 1),
        },
      ],
    },
  })
  await expect(
    lspRenameTool.execute({ path: "a.ts", symbol: "oldName", newName: "fresh" }, ctx(dir)),
  ).rejects.toThrow(/newText terlalu panjang/)
  // Tak ada tulisan yang terjadi: file tetap utuh.
  expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const oldName = 1\n")
})

test("FIX6: kegagalan tulis file kedua di-rollback (tak ada partial rename)", async () => {
  const dir = await tmp("mc-deep-lsp-")
  const f1 = join(dir, "a.ts")
  const f2 = join(dir, "b.ts")
  const orig1 = "const aaa = 1\n"
  const orig2 = "const bbb = 2\n"
  writeFileSync(f1, orig1)
  writeFileSync(f2, orig2)
  lspClient.configureServers([{ ext: ".ts", command: "stub", args: [] }])
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  const u1 = pathToFileURL(f1).href
  const u2 = pathToFileURL(f2).href
  spyOn(lspClient, "lspCall").mockResolvedValue({
    changes: {
      [u1]: [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          newText: "zzz",
        },
      ],
      [u2]: [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
          newText: "yyy",
        },
      ],
    },
  })
  const realWrite = atomicWrite.atomicWriteText
  let n = 0
  spyOn(atomicWrite, "atomicWriteText").mockImplementation(async (p: string, data: string) => {
    n++
    if (n === 2) throw new Error("simulated write failure")
    return realWrite(p, data)
  })
  await expect(
    lspRenameTool.execute({ path: "a.ts", symbol: "aaa", newName: "zzz" }, ctx(dir)),
  ).rejects.toThrow(/simulated write failure/)
  // File pertama sudah sempat ditulis, lalu dikembalikan ke isi semula.
  expect(readFileSync(f1, "utf8")).toBe(orig1)
})

// ── FIX 7: delegationKey = hash FNV-1a dari seluruh prompt ────────────────────

test("FIX7: kunci delegasi beda untuk prompt yang beda di ekor, tanpa prompt mentah", () => {
  const head = "p".repeat(80)
  const left = delegationKey("explore", `${head}-left`)
  const right = delegationKey("explore", `${head}-right`)
  expect(left).not.toBe(right)
  // Deterministik untuk prompt yang sama.
  expect(delegationKey("explore", "same")).toBe(delegationKey("explore", "same"))
  // Tak menyimpan potongan prompt (bisa berisi data sensitif).
  expect(delegationKey("explore", "super-secret-token-xyz")).not.toContain("secret")
  expect(delegationKey("explore", "super-secret-token-xyz")).not.toContain("token")
})
