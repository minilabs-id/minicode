// v7.32 error semantics — audit H1/M1/M2/M3:
// kegagalan tool WAJIB muncul sebagai isError (throw), bukan string sukses;
// sentinel "kosong/tidak ada" tetap string sukses; cap daftar wajib ditandai.
// Hermetic: spy modus untuk LSP/MCP/verification, spawn git tiruan.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { workModeVisible } from "../src/app/tool-layer.ts"
import * as lspClient from "../src/lsp/client.ts"
import * as mcpClient from "../src/mcp/client.ts"
import { hiddenBuiltinToolMessage } from "../src/policy/tool-contract.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
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
import { type ExecutorDeps, runCall } from "../vendor/minicore/src/core/executor.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"

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

// ── v0.43.3: `unknown tool: bash` → pesan actionable ──────────────────────────
// Registry yang sudah difilter WorkMode membuat `bash` di DISCUSS tampak
// seperti tool tak dikenal. Model lalu mengira salah argumen dan retry buta
// (bukti: sesi 9f3fee62 seq 151). Yang diuji: redaksi + klasifikasi, BUKAN
// pelonggaran izin (INV-WM1 tetap dijaga `workModeVisible`).

const kernelCall = (name: string): ToolCall => ({ id: `hidden-${name}`, name, args: {} })
const kernelDeps = (): ExecutorDeps =>
  ({
    registry: new Map(),
    permissions: { check: async () => "allow" },
    events: { emit: () => {} },
    signal: new AbortController().signal,
    state: { history: [], turnCount: 0, stepCount: 0, model: "m" },
    maxResultTokens: 4000,
  }) as unknown as ExecutorDeps

function failedEvents(content: string): DomainEvent[] {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  const bus: EventBusLike & { emit: (type: string, payload: unknown) => void } = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      for (const h of [...(handlers.get(type) ?? [])]) h(payload)
    },
  }
  const adapter = createPresentationAdapter(bus, { sessionId: "hidden-tool-s" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))
  const payload = {
    execution: {
      call: { id: "c-hidden", name: "bash", args: {} },
      result: { isError: true, content },
    },
  }
  bus.emit("execution:started", payload)
  bus.emit("execution:completed", payload)
  adapter.dispose()
  return events
}

describe("hidden built-in tool → pesan actionable", () => {
  test("tool benar-benar tak ada tetap `unknown tool: <n>` (kompatibel)", async () => {
    const r = await runCall(kernelCall("tool_yang_tak_ada"), kernelDeps())
    expect(String(r.content)).toBe("unknown tool: tool_yang_tak_ada")
  })

  test("seam kernel memakai redaksi actionable, tanpa mengubah urutan gate", async () => {
    const r = await runCall(kernelCall("bash"), {
      ...kernelDeps(),
      hiddenToolMessage: (n: string) => hiddenBuiltinToolMessage(n, "DISCUSS", "auto"),
    })
    const text = String(r.content)
    expect(r.isError).toBe(true)
    expect(text).toContain("WorkMode DISCUSS")
    expect(text).toContain("/mode build")
    expect(text).toContain("/unrestric")
    expect(text).not.toContain("unknown tool")
    expect(text).not.toContain("invalid arguments")
  })

  test("helper hanya menandai built-in yang sedang disembunyikan mode", () => {
    expect(hiddenBuiltinToolMessage("bash", "DISCUSS", "auto")).toMatch(/WorkMode DISCUSS/)
    expect(hiddenBuiltinToolMessage("read_file", "DISCUSS", "auto")).toBeUndefined()
    expect(hiddenBuiltinToolMessage("bash", "EXECUTE", "auto")).toBeUndefined()
    expect(hiddenBuiltinToolMessage("tool_yang_tak_ada", "DISCUSS", "auto")).toBeUndefined()
    expect(hiddenBuiltinToolMessage("srv.tool", "DISCUSS", "auto")).toBeUndefined()
  })

  test("INV-WM1: visibilitas WorkMode tidak berubah", () => {
    expect(workModeVisible("bash", "DISCUSS", "auto")).toBe(false)
    expect(workModeVisible("bash", "EXECUTE", "auto")).toBe(true)
  })

  test("adapter: hidden tool → cause `permission` + hint, bukan `invalid`", () => {
    const msg = hiddenBuiltinToolMessage("bash", "DISCUSS", "auto")!
    const failed = failedEvents(msg).find((e) => e.type === "tool.failed") as
      | { cause?: string; hint?: string; message?: string }
      | undefined
    expect(failed).toBeTruthy()
    expect(failed!.cause).toBe("permission")
    expect(failed!.hint).toContain("/mode build")
    expect(failed!.message).toContain("WorkMode DISCUSS")
  })

  test("adapter: `unknown tool` biasa tetap cause `invalid`", () => {
    const failed = failedEvents("unknown tool: tool_yang_tak_ada").find(
      (e) => e.type === "tool.failed",
    ) as { cause?: string; hint?: string } | undefined
    expect(failed).toBeTruthy()
    expect(failed!.cause).toBe("invalid")
    expect(failed!.hint).toBeUndefined()
  })
})
