// Proteksi regresi untuk perbaikan Audit Command & Deduplikasi (CMD-01..CMD-10).
// Mencakup helper telemetry (`readTraceRows`), builtin command (`/init`, `/sessions`),
// dan perilaku end-to-end TUI (`/view compact`, `/view thinking`, `/view fold`, `/view expand`, `/sessions history`, `/init`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { saveSession } from "../src/session/persistence.ts"
import { TaskStore } from "../src/task/store.ts"
import { readTraceRows } from "../src/telemetry/trace.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
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

afterEach(async () => {
  tty?.restore()
  tty = null
  resetLocaleState()
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevLang === undefined) delete process.env.MINICODE_LANG
  else process.env.MINICODE_LANG = prevLang
  const { rm } = await import("node:fs/promises")
  for (const d of tmpRoots.splice(0)) {
    TaskStore.close(d)
    if (process.platform === "win32") Bun.gc(true)
    await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
    uiState: new UiSessionState(),
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
  test.each(["compact", "thinking", "expand", "minimize", "fold"] as const)(
    "/view picker dispatches %s without leaking input",
    async (action) => {
      const session = makeFakeTuiSession(makeTmp("minicode-view-picker-"))
      tty = installFakeTty({ columns: 100, rows: 24 })
      const runP = runTui(session)
      try {
        await tty.ready()
        await tty.waitForOutput((o) => o.includes("00.00.00"))
        await tty.send("/view")
        await tty.send(KEY.enter)
        const frame = await tty.waitForScreen((f) => f.some((l) => l.includes("compact —")))
        for (const name of ["compact", "thinking", "expand", "minimize", "fold"]) {
          expect(frame.join("\n")).toContain(`${name} —`)
        }
        expect(tty.promptListeners()).toBe(1)
        const index = ["compact", "thinking", "expand", "minimize", "fold"].indexOf(action)
        for (let i = 0; i < index; i++) await tty.send(KEY.down)
        await tty.send(KEY.enter)
        const receipt =
          action === "compact"
            ? t("tui.compactLine", { v: t("state.expanded") })
            : action === "thinking"
              ? t("tui.thinkingSet", { v: t("state.expanded") })
              : action === "expand"
                ? t("tui.expandEmpty")
                : action === "minimize"
                  ? t("tui.sectionsMin")
                  : t("tui.activityFold", { v: t("state.folded") })
        await tty.waitForScreen((f) => f.some((l) => l.includes(receipt)))
        expect(tty.promptListeners()).toBe(1)
        if (action === "minimize") {
          expect(session.uiState!.sectionMinimized("tool")).toBe(true)
          expect(session.uiState!.sectionMinimized("answer")).toBe(true)
        }
      } finally {
        await closeTuiClean(tty, runP)
      }
    },
  )

  test("retired names are unknown in TUI completion and dispatch", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const runP = runTui(makeFakeTuiSession(makeTmp("minicode-retired-")))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
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
        await tty.send(`/${name}`)
        await tty.send(KEY.enter)
        // Pesan i18n berkapital ("Unknown command"), jadi bandingkan tanpa case.
        await tty.waitForScreen((f) =>
          f.some((l) => l.toLowerCase().includes(`unknown command: /${name}`)),
        )
      }
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("/provider sync keeps opt-in, live progress, refresh and output-window routing", async () => {
    const dir = makeTmp("minicode-provider-sync-ui-")
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith("/models"))
          return new Response("not found", { status: 404 })
        requests++
        await pending
        return Response.json({ data: [{ id: "new-one" }, { id: "new-two" }] })
      },
    })
    const path = join(dir, ".minicode", "config.json")
    writeFileSync(
      path,
      JSON.stringify({
        providers: [{ id: "sync-ui", baseUrl: `${server.url}v1`, apiKey: "test", models: ["old"] }],
      }),
    )
    const { clearDetectCache } = await import("../src/providers/detect.ts")
    clearDetectCache()
    let runP: Promise<void> | null = null
    try {
      const denied = await captureOutput(() =>
        handleBuiltinCommand("/provider sync", makeCommandCtx(dir, "DISCUSS")),
      )
      expect(denied.value.handled).toBe(true)
      expect(requests).toBe(0)
      expect(JSON.parse(readFileSync(path, "utf8")).providers[0].models).toEqual(["old"])
      const session = makeFakeTuiSession(dir)
      session.allowLocalConfig = true
      tty = installFakeTty({ columns: 90, rows: 24 })
      runP = runTui(session)
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("/provider SYNC")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("cmd.syncing"))))
      tty.resize(100, 26)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("out.titleSync"))))
      release()
      await tty.waitForScreen((f) => f.some((l) => l.includes("completed sync-ui")))
      expect(requests).toBe(1)
      expect(JSON.parse(readFileSync(path, "utf8")).providers[0].models).toEqual([
        "new-one",
        "new-two",
      ])
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen((f) => f.some((l) => l.includes("minicode ›")))
      expect(tty.screen().join("\n")).not.toContain("completed sync-ui")
    } finally {
      release()
      if (tty && runP) await tty.send(KEY.esc, 90)
      await closeTuiClean(tty, runP)
      server.stop(true)
      clearDetectCache()
    }
  }, 15_000)

  test("/view compact, /view thinking, dan /view fold menerima on/off case-insensitive serta menolak argumen asing", async () => {
    const dir = makeTmp("minicode-tui-toggles-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("/view compact ON")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.compactLine", { v: t("state.compact") }))),
      )

      await tty.send("/view compact salah")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.toggleUse", { cmd: "compact" }))),
      )

      await tty.send("/view thinking OFF")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        f.some((l) => l.includes(t("tui.thinkingSet", { v: t("state.minimized") }))),
      )

      await tty.send("/view fold bogus")
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

  test("/view expand membedakan daftar kosong vs id tidak ditemukan", async () => {
    const dir = makeTmp("minicode-tui-expand-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("/view expand")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes(t("tui.expandEmpty"))))

      await tty.send("/view expand tidak-ada-id")
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

  test("/sessions history menampilkan prompt in-memory dari sesi berjalan walau file histori kosong", async () => {
    const dir = makeTmp("minicode-tui-hist-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      await tty.send("prompt-in-memory-unik")
      await tty.send(KEY.enter)
      await tty.waitForListener(2000)

      await tty.send("/sessions history")
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

  test("/init di TUI tertahan saat DISCUSS lalu berhasil sesudah /mode BUILD", async () => {
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

      await tty.send("/mode BUILD")
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
