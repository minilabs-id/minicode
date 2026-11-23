import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUILTIN_COMMANDS,
  DRIVER_HELP_COMMANDS,
  HELP_GROUPS,
  handleBuiltinCommand,
} from "../cli/commands.ts"
import { loadSession, saveSession } from "../src/session/persistence.ts"
import { TaskStore } from "../src/task/store.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { captureOutput } from "./helpers/capture.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

// Sebagian test tanpa harness (jalur cetak) menegaskan label Inggris.
beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

let tty: FakeTty | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

function dummyCtx(extra: { setModelOverride?: (m: string) => void } = {}) {
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001 }
  return {
    sessionId: "test-sess",
    currentModel: "gpt-4o",
    usage: {
      get: () => usage,
      getSession: () => usage,
      reset: () => {},
      modelUsed: () => ({ effective: undefined, provider: undefined }),
    },
    skills: [],
    toolsCount: 20,
    setModelOverride: extra.setModelOverride ?? (() => {}),
    // Kontrak control-plane (Phase 6): /status membedakan Context vs Usage vs
    // Budget — dummy menyediakan angka tetap.
    getContextTokens: () => 1024,
    budgetState: () => "ok" as const,
  }
}

test.each([
  { workMode: "DISCUSS", permissionMode: "auto", message: "requires BUILD" },
  { workMode: "BUILD", permissionMode: "readonly", message: "requires BUILD" },
  { workMode: "BUILD", permissionMode: "plan", message: "requires BUILD" },
  { workMode: "BUILD", permissionMode: "auto", message: "not found" },
])(
  "commands: redo refuses unsafe target $workMode/$permissionMode before restoring",
  async ({ workMode, permissionMode, message }) => {
    const cwd = mkdtempSync(join(tmpdir(), "minicode-redo-guard-"))
    mkdirSync(join(cwd, ".minicode", "rewinds"), { recursive: true })
    await saveSession("test-sess", cwd, undefined, [], undefined)
    writeFileSync(join(cwd, "a.txt"), "manual edit")
    writeFileSync(
      join(cwd, ".minicode", "rewinds", "test-sess.json"),
      JSON.stringify({
        v: 1,
        branchSessionId: "test-sess",
        sourceSessionId: "missing-source",
        targetOrdinal: 1,
        targetTurnId: 0,
        prompt: "prompt",
        safety: { mode: "files", snapshots: [{ path: "a.txt", content: "old content" }] },
      }),
    )
    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args) => {
      lines.push(args.join(" "))
    }
    try {
      await handleBuiltinCommand("/redo", { ...dummyCtx(), cwd, workMode, permissionMode })
      expect(lines.join("\n")).toContain(message)
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("manual edit")
    } finally {
      console.log = originalLog
      TaskStore.close(cwd)
      if (process.platform === "win32") Bun.gc(true)
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  },
)

test("commands: undo picker lists turns newest first and cancellation preserves history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "minicode-undo-picker-"))
  mkdirSync(join(cwd, ".minicode"), { recursive: true })
  const messages = [
    { role: "user", content: "prompt pertama" },
    { role: "assistant", content: "baik" },
    { role: "user", content: "prompt terbaru" },
    { role: "assistant", content: "selesai" },
  ]
  await saveSession("test-sess", cwd, undefined, messages, {})
  tty = installFakeTty({ columns: 100, rows: 24 })
  const command = handleBuiltinCommand("/undo", {
    ...dummyCtx(),
    cwd,
    workMode: "DISCUSS",
    permissionMode: "auto",
  })
  try {
    await tty.ready()
    const frame = await tty.waitForScreen((f) => f.some((l) => l.includes("prompt terbaru")))
    const text = frame.join("\n")
    expect(text.indexOf("prompt terbaru")).toBeLessThan(text.indexOf("prompt pertama"))
    await tty.send(KEY.esc, 90)
    await command
    expect(loadSession("test-sess", cwd)?.messages).toEqual(messages)
  } finally {
    tty.restore()
    tty = undefined
    TaskStore.close(cwd)
    if (process.platform === "win32") Bun.gc(true)
    await rm(cwd, { recursive: true, force: true })
  }
})

test("commands: consolidated registry has no retired slash handlers", async () => {
  const names = [...BUILTIN_COMMANDS, ...DRIVER_HELP_COMMANDS].map((b) => b.name)
  expect(new Set(names).size).toBe(names.length)
  expect(HELP_GROUPS.flatMap((g) => [...g.names]).sort()).toEqual([...names].sort())
  for (const name of [
    "work-mode",
    "sync",
    "compact",
    "thinking",
    "expand",
    "minimize",
    "fold",
    "history",
    "branches",
  ]) {
    expect(names).not.toContain(name)
    expect((await handleBuiltinCommand(`/${name}`, dummyCtx())).handled).toBe(false)
  }
  for (const name of [
    "mode",
    "view",
    "sessions",
    "context",
    "status",
    "provider",
    "model",
    "undo",
    "redo",
    "copy",
    "clear",
    "scheduler",
    "lang",
    "help",
    "init",
    "update",
    "exit",
  ]) {
    expect(names).toContain(name)
  }
})

test.each(["en", "id"] as const)(
  "commands: /sessions branches lists nested links beyond picker cap (%s)",
  async (locale) => {
    setSessionLocale(locale)
    const cwd = mkdtempSync(join(tmpdir(), "minicode-branch-list-"))
    mkdirSync(join(cwd, ".minicode", "rewinds"), { recursive: true })
    const messages = [{ role: "user", content: "original prompt" }]
    try {
      for (const id of ["source", "branch-one", "branch-two", "corrupt"]) {
        await saveSession(id, cwd, undefined, messages, {})
      }
      for (const [branch, source] of [
        ["branch-one", "source"],
        ["branch-two", "branch-one"],
      ]) {
        writeFileSync(
          join(cwd, ".minicode", "rewinds", `${branch}.json`),
          JSON.stringify({
            v: 1,
            branchSessionId: branch,
            sourceSessionId: source,
            targetOrdinal: 2,
            targetTurnId: 1,
            prompt: "target\n\x1b[31munsafe\x1b[0m",
            safety: null,
          }),
        )
      }
      writeFileSync(join(cwd, ".minicode", "rewinds", "corrupt.json"), "{invalid")
      for (let i = 0; i < 26; i++) await saveSession(`plain-${i}`, cwd, undefined, messages, {})
      const { lines, value } = await captureOutput(() =>
        handleBuiltinCommand("/sessions branches", { ...dummyCtx(), cwd }),
      )
      expect(value.handled).toBe(true)
      const text = lines.join("\n")
      expect(text).toContain("branch-one → source")
      expect(text).toContain("branch-two → branch-one")
      expect(text).toContain("target unsafe")
      expect(text).not.toContain("\x1b[31m")
      expect(text).not.toContain("corrupt")
      expect(text).not.toContain("plain-")
      expect(loadSession("source", cwd)?.messages).toEqual(messages)
    } finally {
      TaskStore.close(cwd)
      if (process.platform === "win32") Bun.gc(true)
      await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  },
)

test("commands: non-slash input returns handled: false", async () => {
  const res = await handleBuiltinCommand("hello world", dummyCtx())
  expect(res.handled).toBe(false)
})

test("commands: BUILTIN_COMMANDS name tidak boleh berisi placeholder args", () => {
  const { BUILTIN_COMMANDS } = require("../cli/commands.ts") as {
    BUILTIN_COMMANDS: { name: string; args?: string }[]
  }
  for (const b of BUILTIN_COMMANDS) {
    expect(b.name).not.toMatch(/[<[\s]/)
  }
})

test("commands: /model opens the model manager", async () => {
  const res = await handleBuiltinCommand("/model", dummyCtx())
  expect(res.handled).toBe(true)
})

test("commands: /help, /status, /model, /exit are handled", async () => {
  const ctx = dummyCtx()

  const resHelp = await handleBuiltinCommand("/help", ctx)
  expect(resHelp.handled).toBe(true)

  const resModel = await handleBuiltinCommand("/model", ctx)
  expect(resModel.handled).toBe(true)

  const resExit = await handleBuiltinCommand("/exit", ctx)
  expect(resExit.handled).toBe(true)
  expect(resExit.shouldExit).toBe(true)
})

test("commands: /sessions lists saved sessions with cwd", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-sess-"))
  await saveSession("sess-1", tmp, undefined, [{ role: "user", content: "hi" }], { inputTokens: 1 })
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /sessions with an unknown id fails gracefully", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "minicode-resume-"))
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/sessions no-such-id", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /resume <id> alias /sessions <id> (bukan sunyi)", async () => {
  // Gagal-di-kode-lama: /resume jatuh ke default → handled:false → TUI sunyi
  // total (tidak tercatat, tidak spawn).
  const tmp = mkdtempSync(join(tmpdir(), "minicode-resume2-"))
  const ctx = { ...dummyCtx(), cwd: tmp }
  const res = await handleBuiltinCommand("/resume no-such-id", ctx)
  expect(res.handled).toBe(true)
  rmSync(tmp, { recursive: true, force: true })
})

test("commands: /resume tanpa arg dikembalikan (ditangani TUI popup)", async () => {
  const ctx = dummyCtx()
  const res = await handleBuiltinCommand("/resume", ctx)
  expect(res.handled).toBe(false)
})

test("commands: /sessions TTY membuka picker overlay, Esc batal bersih", async () => {
  // Kode lama: tabel + "Select a session to resume." dicetak ke scrollback.
  // Kode baru: picker transient, batal tanpa jejak cetak dan tanpa spawn.
  // Isolasi DB lokal (mkdir .minicode) seperti repl-linear: tanpa itu daftar
  // global mesin ikut tampil; kolom lebar agar id tak terpotong.
  tty = installFakeTty({ columns: 100, rows: 24 })
  const tmp = mkdtempSync(join(tmpdir(), "minicode-sesspick-"))
  mkdirSync(join(tmp, ".minicode"), { recursive: true })
  await saveSession("sess-pick", tmp, undefined, [{ role: "user", content: "hi" }], {
    inputTokens: 1,
  })
  const ctx = { ...dummyCtx(), cwd: tmp }
  const p = handleBuiltinCommand("/sessions", ctx)
  await tty.ready()
  expect(stripAnsi(tty.all())).toContain("sess-pick")
  await tty.send(KEY.esc, 80)
  const res = await p
  expect(res.handled).toBe(true)
  // Tanpa tabel cetak versi lama.
  expect(stripAnsi(tty.all())).not.toContain("Select a session to resume.")
  // DB sqlite lokal masih terbuka di Windows (EBUSY) — biarkan OS
  // membersihkan tmp (pola yang sama di repl-linear.test.ts).
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

test("commands: /status selalu mencetak readout (handler-level)", async () => {
  // Handler tetap mencetak baris; TUI (v7.18) membungkus hasilnya menjadi
  // jendela output command, sedangkan one-shot mencetak ke scrollback.
  tty = installFakeTty({ rows: 24 })
  const ctx = dummyCtx()
  const res = await handleBuiltinCommand("/status", ctx)
  expect(res.handled).toBe(true)
  const out = stripAnsi(tty.all())
  expect(out).toContain("Session test-sess")
  expect(out).toContain("Model:")
})
