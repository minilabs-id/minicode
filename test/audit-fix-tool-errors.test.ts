// v7.32 error semantics — audit H1/M1/M2/M3:
// kegagalan tool WAJIB muncul sebagai isError (throw), bukan string sukses;
// sentinel "kosong/tidak ada" tetap string sukses; cap daftar wajib ditandai.
// Hermetic: spy modus untuk LSP/MCP/verification, spawn git tiruan.

import { afterEach, expect, mock, spyOn, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import * as lspClient from "../src/lsp/client.ts"
import * as mcpClient from "../src/mcp/client.ts"
import * as verification from "../src/session/verification.ts"
import { runGit, setGitSpawnForTest } from "../src/tools/git.ts"
import {
  capLocations,
  lspDiagnosticsTool,
  lspHoverTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
} from "../src/tools/lsp.ts"
import { mcpCallTool, mcpPromptTool, mcpReadTool } from "../src/tools/mcp_call.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "audit-tool-"))
  dirs.push(d)
  return d
}
function ctxFor(cwd: string, signal = new AbortController().signal): never {
  return { signal, cwd, emit: () => {} } as never
}

afterEach(() => {
  mock.restore()
  setGitSpawnForTest(null)
  clearSubAgentSessionFactory()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ── H1: LSP ─────────────────────────────────────────────────────────────────

test("H1: abort saat LSP menunggu menolak dengan reason (bukan string [lsp])", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "a.ts"), "const a = 1\n")
  spyOn(lspClient, "lspDiagnostics").mockImplementation(
    () => new Promise<{ uri: string; items: Record<string, unknown>[] }>(() => {}),
  )
  const c = new AbortController()
  const pending = lspDiagnosticsTool.execute({ path: "a.ts" }, ctxFor(dir, c.signal))
  setTimeout(() => c.abort(new Error("batal-user")), 20)
  await expect(pending).rejects.toThrow("batal-user")
})

test("H1: jail-denied (file sensitif) menolak, bukan sukses", async () => {
  const dir = tmp()
  await expect(lspDiagnosticsTool.execute({ path: ".env" }, ctxFor(dir))).rejects.toThrow(
    /blocked sensitive file/,
  )
  // posTool butuh server terkonfigurasi supaya lolos gerbang awalnya.
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  await expect(lspHoverTool.execute({ path: ".env", symbol: "x" }, ctxFor(dir))).rejects.toThrow(
    /blocked sensitive file/,
  )
})

test("H1: kegagalan lspCall pada posTool menolak", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "a.ts"), "export function foo() {}\n")
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  spyOn(lspClient, "lspCall").mockRejectedValue(new Error("lsp server mati"))
  await expect(lspHoverTool.execute({ path: "a.ts", symbol: "foo" }, ctxFor(dir))).rejects.toThrow(
    "lsp server mati",
  )
})

test("H1: sentinel sah (kosong / tak terkonfigurasi) tetap string sukses", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "a.ts"), "const a = 1\n")
  spyOn(lspClient, "lspDiagnostics").mockResolvedValue({ uri: "file:///a.ts", items: [] })
  // v7.33: pesan sentinel kini boleh menyusul petunjuk konfigurasi; yang diuji
  // ialah penanda "(no diagnostics)" tetap string sukses, bukan ejaan penuhnya.
  expect(await lspDiagnosticsTool.execute({ path: "a.ts" }, ctxFor(dir))).toContain(
    "(no diagnostics)",
  )

  spyOn(lspClient, "lspCall").mockResolvedValue([])
  // Sama seperti di atas: penanda sentinel yang diuji, bukan ejaan penuh pesan.
  expect(await lspSymbolsTool.execute({ path: "a.ts" }, ctxFor(dir))).toContain("(no symbols)")

  spyOn(lspClient, "getConfiguredExts").mockReturnValue([])
  expect(await lspWorkspaceSymbolsTool.execute({ query: "x" }, ctxFor(dir))).toContain(
    "no LSP servers configured",
  )
})

// ── M3: cap LSP ─────────────────────────────────────────────────────────────

test("M3: diagnostics (50) dan symbols (100) memotong daftar dengan penanda", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "a.ts"), "const a = 1\n")
  const items = Array.from({ length: 60 }, (_, i) => ({
    range: { start: { line: i, character: 0 } },
    severity: 1,
    message: `m${i}`,
  }))
  spyOn(lspClient, "lspDiagnostics").mockResolvedValue({ uri: "file:///a.ts", items })
  const d = (await lspDiagnosticsTool.execute({ path: "a.ts" }, ctxFor(dir))) as string
  expect(d).toContain("[truncated: showing first 50 of 60]")

  const syms = Array.from({ length: 120 }, (_, i) => ({
    name: `s${i}`,
    kind: 1,
    range: { start: { line: i } },
  }))
  spyOn(lspClient, "lspCall").mockResolvedValue(syms)
  const s = (await lspSymbolsTool.execute({ path: "a.ts" }, ctxFor(dir))) as string
  expect(s).toContain("[truncated: showing first 100 of 120]")

  // Daftar pendek tak boleh mendapat penanda.
  expect(capLocations(["a", "b"], 50)).toBe("a\nb")
})

// ── M1: MCP ─────────────────────────────────────────────────────────────────

test("M1: server tak terhubung melempar error untuk mcp_call/read/prompt", async () => {
  spyOn(mcpClient, "getMcpServerIds").mockReturnValue([])
  await expect(mcpCallTool.execute({ server: "hantu", tool: "t" }, ctxFor(tmp()))).rejects.toThrow(
    /is not connected/,
  )
  await expect(
    mcpReadTool.execute({ server: "hantu", uri: "x://y" }, ctxFor(tmp())),
  ).rejects.toThrow(/is not connected/)
  await expect(
    mcpPromptTool.execute({ server: "hantu", name: "p" }, ctxFor(tmp())),
  ).rejects.toThrow(/is not connected/)
})

test("M1: hasil kosong mcp_read/prompt tetap string sukses", async () => {
  spyOn(mcpClient, "getMcpServerIds").mockReturnValue(["s"])
  spyOn(mcpClient, "readMcpResource").mockResolvedValue("")
  expect(await mcpReadTool.execute({ server: "s", uri: "file:///x" }, ctxFor(tmp()))).toContain(
    "is empty",
  )
  spyOn(mcpClient, "getMcpPrompt").mockResolvedValue("")
  expect(await mcpPromptTool.execute({ server: "s", name: "p" }, ctxFor(tmp()))).toContain(
    "returned no message",
  )
})

// ── M1: delegate_task ───────────────────────────────────────────────────────

test("M1: evidence intent tak durabel → delegasi menolak (isError)", async () => {
  const dir = tmp()
  const saved = process.env.OPENAI_API_KEY
  if (!saved) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  setSubAgentSessionFactory(async () => ({
    events: { on: () => () => {} },
    run: async () => ({ finalText: "x", usage: { steps: 1 } }),
  }))
  spyOn(verification, "persistEffectIntent").mockResolvedValue({ durable: false } as never)
  try {
    await expect(delegateTaskTool.execute({ prompt: "x" }, ctxFor(dir))).rejects.toThrow(
      /REFUSED_VERIFICATION_EVIDENCE/,
    )
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved
  }
})

// v7.33: source-regex test (pemeriksaan ejaan return/throw di src/tools/task.ts)
// DIHAPUS — menguji teks sumber, bukan perilaku, dan mudah patah tanpa arti.
// Pengganti behavioral (delegate melempar REFUSED_, bukan string sukses) ada di
// test/audit-fix-tool-tests-quality.test.ts.

// ── M2: git timeout ─────────────────────────────────────────────────────────

function fakeGit(closeCode: number | null, closeOnSpawn = false): typeof spawn {
  return ((_cmd: string, _args: readonly string[]): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        queueMicrotask(() => child.emit("close", closeCode))
        return true
      },
    })
    if (closeOnSpawn) queueMicrotask(() => child.emit("close", closeCode))
    return child
  }) as typeof spawn
}

test("M2: timeout gabungan menolak dengan reason (bukan resolve exit null)", async () => {
  const timer = new AbortController()
  spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal)
  setGitSpawnForTest(fakeGit(null))
  const reason = new Error("git-timeout")
  const pending = runGit(["status"], process.cwd(), new AbortController().signal)
  timer.abort(reason)
  await expect(pending).rejects.toThrow("git-timeout")
})

test("M2: kegagalan exit code non-timeout tetap terdeteksi", async () => {
  setGitSpawnForTest(fakeGit(3, true))
  const out = await runGit(["status"], process.cwd(), new AbortController().signal)
  expect(out).toContain("exit 3")
})
