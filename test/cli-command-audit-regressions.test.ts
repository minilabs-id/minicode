// Proteksi regresi untuk perbaikan Audit Command & Deduplikasi (CMD-01..CMD-10).
// Mencakup helper telemetry (`readTraceRows`), builtin command (`/init`, `/sessions`),
// dan perilaku end-to-end TUI (`/compact`, `/thinking`, `/fold`, `/expand`, `/history`, `/init`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { saveSession } from "../src/session/persistence.ts"
import { readTraceRows } from "../src/telemetry/trace.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { captureOutput } from "./helpers/capture.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const tmpRoots: string[] = []
let tty: ReturnType<typeof installFakeTty> | null = null
let prevHome: string | undefined
let prevLang: string | undefined

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

beforeEach(() => {
  resetLocaleState()
  setSessionLocale("en")
  prevHome = process.env.MINICODE_HOME
  prevLang = process.env.MINICODE_LANG
  delete process.env.MINICODE_LANG
  delete process.env.LANG
  delete process.env.LC_ALL
  process.env.MINICODE_HOME = makeTmp("minicode-cmd-audit-home-")
})

afterEach(() => {
  tty?.restore()
  tty = null
  resetLocaleState()
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevLang === undefined) delete process.env.MINICODE_LANG
  else process.env.MINICODE_LANG = prevLang
  for (const d of tmpRoots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Handle Windows SQLite (sessions.db) lambat lepas — sama seperti test/cli-handlers.test.ts.
    }
  }
})

function makeCommandCtx(cwd: string, workMode: string): CommandContext {
  return {
    cwd,
    sessionId: "audit-cmd",
    currentModel: "fake::m",
    workMode,
    usage: {
      get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      reset() {},
      modelUsed: () => ({}),
    },
    skills: [],
    toolsCount: 0,
    setModelOverride() {},
    getContextTokens: () => 0,
    budgetState: () => "ok" as const,
  }
}

function makeFakeTuiSession(cwd: string) {
  const bus = createFakeBus()
  let wm: "DISCUSS" | "EXECUTE" = "DISCUSS"
  const noop = async () => {}
  const session = {
    bus,
    session: { events: bus, contextTokens: 0 },
    cfg: { providers: [] },
    cwd,
    sessionId: "tui-audit-cmd",
    modelRef: {} as { current?: string },
    permissionMode: "auto",
    permissions: undefined,
    workModeControl: {
      getWorkMode: () => wm,
      setWorkMode: (next: "DISCUSS" | "EXECUTE") => {
        wm = next
      },
    },
    sessionTools: [],
    allLoadedSkills: [],
    allowLocalConfig: false,
    usage: {
      get: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      getSession: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }),
      modelUsed: () => ({}),
      reset: () => {},
    },
    budget: undefined,
    budgetStrict: false,
    expandContent: () => [],
    expandAllContent: () => [],
    persistCurrent: noop,
    runPromptWithVerify: noop,
    close: noop,
  } as unknown as CliSession & { bus: ReturnType<typeof createFakeBus> }
  return session
}

async function closeTuiClean(
  activeTty: ReturnType<typeof installFakeTty> | null,
  runP: Promise<void> | null,
): Promise<void> {
  if (!activeTty || !runP) return
  try {
    await activeTty.send("\x15/exit")
    await activeTty.send(KEY.enter)
    await runP
  } catch {}
}

describe("readTraceRows (telemetry/trace.ts)", () => {
  test("mengembalikan [] saat berkas belum ada, dan melewati baris korup", () => {
    const dir = makeTmp("minicode-trace-rows-")
    expect(readTraceRows(dir)).toEqual([])

    mkdirSync(join(dir, ".minicode"), { recursive: true })
    writeFileSync(
      join(dir, ".minicode", "traces.jsonl"),
      ['{"model":"p::m","ok":true}', "{rusak-json", '{"model":"p::n","ok":false}', ""].join("\n"),
      "utf8",
    )
    const rows = readTraceRows<{ model?: string; ok?: boolean }>(dir, "traces.jsonl")
    expect(rows).toEqual([
      { model: "p::m", ok: true },
      { model: "p::n", ok: false },
    ])
  })
})

describe("handleBuiltinCommand: /init & /sessions", () => {
  test("/init ditolak di WorkMode DISCUSS dan tidak menulis AGENTS.md", async () => {
    const dir = makeTmp("minicode-init-discuss-")
    const { lines, value } = await captureOutput(() =>
      handleBuiltinCommand("/init", makeCommandCtx(dir, "DISCUSS")),
    )
    expect(value.handled).toBe(true)
    expect(lines.join("\n")).toContain(t("cmd.initInDiscuss"))
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false)
  })

  test("/init di BUILD membuat AGENTS.md ber-i18n dan menolak overwrite bila sudah ada", async () => {
    const dir = makeTmp("minicode-init-build-")
    setSessionLocale("id")
    const first = await captureOutput(() =>
      handleBuiltinCommand("/init", makeCommandCtx(dir, "BUILD")),
    )
    expect(first.value.handled).toBe(true)
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true)
    const body = readFileSync(join(dir, "AGENTS.md"), "utf8")
    expect(body).toContain(t("cmd.initBodyDesc"))

    const second = await captureOutput(() =>
      handleBuiltinCommand("/init", makeCommandCtx(dir, "BUILD")),
    )
    expect(second.lines.join("\n")).toContain("AGENTS.md")
  })

  test("/sessions menyaring sekuens ANSI berbahaya di cwd sesi tersimpan", async () => {
    const dir = makeTmp("minicode-sessions-ansi-")
    await saveSession(
      "sess-ansi-check",
      "/tmp/\x1b[31mjudul-jahat\x1b[0m",
      "m",
      [{ role: "user", content: "hai" }],
      {},
    )
    const { lines, value } = await captureOutput(() =>
      handleBuiltinCommand("/sessions", makeCommandCtx(dir, "DISCUSS")),
    )
    expect(value.handled).toBe(true)
    const plain = lines.join("\n")
    expect(plain).toContain("sess-ansi-check")
    expect(plain).not.toContain("\x1b[31m")
  })
})

describe("TUI slash commands (CMD-02..CMD-09)", () => {
  test("/compact, /thinking, dan /fold menerima on/off case-insensitive serta menolak argumen asing", async () => {
    const dir = makeTmp("minicode-tui-toggles-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("/compact ON")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.compactLine", { v: t("state.compact") }))),
      )

      await tty.send("/compact salah")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.toggleUse", { cmd: "compact" }))),
      )

      await tty.send("/thinking OFF")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.thinkingSet", { v: t("state.minimized") }))),
      )

      await tty.send("/fold bogus")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("tui.toggleUse", { cmd: "fold" }))))

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("/expand membedakan daftar kosong vs id tidak ditemukan", async () => {
    const dir = makeTmp("minicode-tui-expand-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("/expand")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("tui.expandEmpty"))))

      await tty.send("/expand tidak-ada-id")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.expandNotFound", { id: "tidak-ada-id" }))),
      )

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("/history menampilkan prompt in-memory dari sesi berjalan walau file histori kosong", async () => {
    const dir = makeTmp("minicode-tui-hist-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("prompt-in-memory-unik")
      await tty.send(KEY.enter)
      await tty.waitForListener(2000)

      await tty.send("/history")
      await tty.send(KEY.enter)
      await tty.waitForScreen(
        (f) =>
          f.some((l) => l.includes(t("out.titleHistory"))) &&
          f.some((l) => l.includes("prompt-in-memory-unik")),
      )
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen((f) => f.some((l) => l.includes("minicode ›")))

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("/init di TUI tertahan saat DISCUSS lalu berhasil sesudah /work-mode BUILD", async () => {
    const dir = makeTmp("minicode-tui-init-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("/init")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("cmd.initInDiscuss"))))
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false)
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen((f) => f.some((l) => l.includes("minicode ›")))

      await tty.send("/work-mode BUILD")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes("work mode: BUILD")))

      await tty.send("/init")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes("AGENTS.md created")))
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(true)
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen((f) => f.some((l) => l.includes("minicode ›")))

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })
})
