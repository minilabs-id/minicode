// Proteksi regresi untuk perbaikan Audit Command & Deduplikasi (CMD-01..CMD-10).
// Mencakup helper telemetry (`readTraceRows`), builtin command (`/init`, `/sessions`),
// dan perilaku end-to-end TUI (`/view thinking`, `/view expand`, `/sessions history`, `/init`).
// `/view compact|fold|minimize` sengaja dihapus: renderer flat tak membaca
// flag-flag itu, sehingga kwitsinya dulu palsu (menyesatkan operator).

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
import { tSystem } from "../src/ui/render/tool-label.ts"
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
  // v0.34: VIEW_ACTIONS HANYA ["thinking"] — expand dihapus (riwayat penuh
  // di jurnal/chat; sidebar dihapus). compact/fold/minimize juga tak ada. Picker wajib berisi
  // SATU item, bukan lima seperti sebelum rewrite.
  test("/view picker hanya menawarkan aksi thinking yang valid", async () => {
    const session = makeFakeTuiSession(makeTmp("minicode-view-picker-"))
    tty = installFakeTty({ columns: 100, rows: 24 })
    const runP = runTui(session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("/view")
      await tty.send(KEY.enter)
      const frame = await tty.waitForScreen((f) => f.some((l) => l.includes("thinking —")))
      const screen = frame.join("\n")
      expect(screen).toContain("thinking —")
      // Aksi mati TIDAK boleh muncul lagi di picker.
      for (const name of ["expand", "compact", "minimize", "fold"]) {
        expect(screen).not.toContain(`${name} —`)
      }
      expect(tty.promptListeners()).toBe(1)
      await tty.send(KEY.enter)
      const receipt = tSystem("tui.thinkingSet", { v: tSystem("state.expanded") })
      // v7.30: kwitansi /view tinggal di footer (toast), bukan baris transkrip.
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(receipt))
      expect(tty.promptListeners()).toBe(1)
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("perintah lepas dari /view tetap unknown; compact/fold/minimize benar-benar dihapus", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const runP = runTui(makeFakeTuiSession(makeTmp("minicode-retired-")))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      // compact/fold/minimize sudah dihapus total. thinking/expand juga unknown
      // sebagai perintah lepas — keduanya HANYA valid sebagai sub-`/view`.
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
        // v7.30: unknown-command = toast di footer. Pesan i18n berkapital
        // ("Unknown command"), jadi bandingkan tanpa case.
        await tty.waitForScreen((f) =>
          (f[f.length - 1] ?? "").toLowerCase().includes(`unknown command: /${name}`),
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
      await tty.waitForScreen(
        (f) =>
          !f.slice(0, -5).some((l) => l.includes("│")) && f.some((l) => l.includes("00.00.00")),
      )
      expect(tty.screen().join("\n")).not.toContain("completed sync-ui")
    } finally {
      release()
      if (tty && runP) await tty.send(KEY.esc, 90)
      await closeTuiClean(tty, runP)
      server.stop(true)
      clearDetectCache()
    }
  }, 15_000)

  test("/view thinking menerima on/off case-insensitive; compact/fold/minimize ditolak", async () => {
    const dir = makeTmp("minicode-tui-toggles-")
    const session = makeFakeTuiSession(dir)
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      // Rekam state sesudah default TUI diterapkan — kontrol mati tak boleh
      // mengubahnya (dulu /view minimize memaksa keduanya minimized).
      const toolBefore = session.uiState!.sectionMinimized("tool")
      const answerBefore = session.uiState!.sectionMinimized("answer")

      // thinking masih hidup: toggle benar-benar mengubah state yang dirender.
      await tty.send("/view thinking ON")
      await tty.send(KEY.enter)
      // v7.30: kwitansi-kwitansi ini di footer (toast), bukan baris transkrip.
      await tty.waitForScreen((f) =>
        (f[f.length - 1] ?? "").includes(
          tSystem("tui.thinkingSet", { v: tSystem("state.expanded") }),
        ),
      )

      await tty.send("/view thinking salah")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        (f[f.length - 1] ?? "").includes(tSystem("tui.toggleUse", { cmd: "thinking" })),
      )

      await tty.send("/view thinking OFF")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) =>
        (f[f.length - 1] ?? "").includes(
          tSystem("tui.thinkingSet", { v: tSystem("state.minimized") }),
        ),
      )

      // compact/fold/minimize sengaja ditolak: renderer flat tak membaca
      // flag-flag itu, jadi kwitansi lamanya palsu. Harus jatuh ke usage.
      for (const cmd of ["compact", "fold", "minimize"]) {
        await tty.send(`/view ${cmd} ON`)
        await tty.send(KEY.enter)
        await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(tSystem("tui.viewUse")))
      }
      expect(tty.screen()[tty.screen().length - 1]).toContain(tSystem("tui.viewUse"))
      // Kwitansi kontrol mati TIDAK boleh muncul lagi.
      const screen = tty.screen().join("\n")
      expect(screen).not.toContain(tSystem("tui.compactLine", { v: tSystem("state.compact") }))
      expect(screen).not.toContain(tSystem("tui.activityFold", { v: tSystem("state.folded") }))
      expect(screen).not.toContain(tSystem("tui.sectionsMin"))
      expect(session.uiState!.sectionMinimized("tool")).toBe(toolBefore)
      expect(session.uiState!.sectionMinimized("answer")).toBe(answerBefore)

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })

  test("/view expand sudah dihapus — bukan lagi sub-aksi yang valid", async () => {
    const dir = makeTmp("minicode-tui-expand-")
    tty = installFakeTty({ columns: 90, rows: 24 })
    let runP: Promise<void> | null = runTui(makeFakeTuiSession(dir))
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))

      // v0.34: /expand dihapus; riwayat penuh di jurnal/chat (sidebar dihapus).
      // Perintah ini kini ditolak dengan petunjuk aksi /view yang tersisa.
      await tty.send("/view expand")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes(tSystem("tui.viewUse")))
      expect(tty!.screen().join("\n")).not.toContain(tSystem("tui.expandEmpty"))

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
      await tty.waitForScreen(
        (f) =>
          !f.slice(0, -5).some((l) => l.includes("│")) && f.some((l) => l.includes("00.00.00")),
      )

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
      await tty.waitForScreen(
        (f) =>
          !f.slice(0, -5).some((l) => l.includes("│")) && f.some((l) => l.includes("00.00.00")),
      )

      await tty.send("/mode BUILD")
      await tty.send(KEY.enter)
      // v7.30: kwitansi "work mode: BUILD" dihapus — footer yang menampilkan Build.
      await tty.waitForScreen((f) => (f[f.length - 1] ?? "").includes("Build"))

      await tty.send("/init")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes("AGENTS.md created")))
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(true)
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen(
        (f) =>
          !f.slice(0, -5).some((l) => l.includes("│")) && f.some((l) => l.includes("00.00.00")),
      )

      await tty.send("/exit")
      await tty.send(KEY.enter)
      await runP
      runP = null
    } finally {
      await closeTuiClean(tty, runP)
    }
  })
})
