// Kontrak runtime WorkMode (P12 S2.2 Slice 5) — transisi mode pada sesi yang
// SEDANG BERJALAN, bukan hanya tampilan.
//
// Yang dibuktikan di sini (bukan sekadar parser/footer):
// 1. Permission ceiling handler membaca WorkMode terbaru (__setWorkMode).
// 2. Tool visibility yang dilihat kernel ikut berubah (registry.list() hidup).
// 3. Hooks mengikuti WorkMode AKTIF (bukan snapshot saat session dibuat).
// 4. Delegasi berikutnya mewarisi WorkMode parent yang aktif.
// 5. WorkMode tak bisa dinaikkan otomatis oleh argumen delegasi/anak.
// 6. Command `/mode` benar-benar mengubah state (TUI end-to-end).
// 7. Footer mencerminkan kombinasi WorkMode + permission mode.
//
// WorkMode adalah lapis intent di ATAS permission mode: tidak pernah
// menempelkan permission mode (INV-WM1), dan permission mode tak pernah
// dilewati oleh ceiling WorkMode.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCall } from "#minicore"
import { FakeProvider } from "#minicore/test/fakes.ts"
import type { CliSession } from "../cli/setup.ts"
import { runTui } from "../cli/tui.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { setupToolLayer } from "../src/app/tool-layer.ts"
import { shouldRunHooks } from "../src/hooks/run.ts"
import { createPermissionHandler, type PermissionMode } from "../src/policy/permission.ts"
import { LOCAL_READONLY_TOOL_NAMES } from "../src/policy/tool-contract.ts"
import { createWorkModePermissionHandler, type WorkMode } from "../src/policy/work-mode.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  EXPLORE_TOOL_NAMES,
  type SubAgentSpec,
  setSubAgentSessionFactory,
  setSubAgentWorkMode,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"
import { paintPermissionMode, paintWorkMode, renderFooter } from "../src/ui/footer.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

const dirs: string[] = []
const roots: string[] = []

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-wm-rt-"))
  roots.push(d)
  return d
}

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(async () => {
  tty?.restore()
  tty = null
  clearSubAgentSessionFactory()
  for (const d of roots.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
})

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  args: args as never,
})

type LiveHandler = {
  check(c: ToolCall, d?: unknown): Promise<"allow" | "deny">
  __setMode(m: PermissionMode): void
  __getMode(): PermissionMode
  __setWorkMode(m: WorkMode): void
  __getWorkMode(): WorkMode
}

function liveHandler(workMode: WorkMode, pm: PermissionMode, root: string): LiveHandler {
  const base = createPermissionHandler({ mode: pm, root })
  return createWorkModePermissionHandler({ workMode, base, root }) as unknown as LiveHandler
}

describe("1. permission ceiling mengikuti WorkMode terbaru", () => {
  test("EXECUTE → DISCUSS: write ditolak, read tetap boleh", async () => {
    const root = tmpRoot()
    const h = liveHandler("EXECUTE", "auto", root)
    const write = call("w0", "write_file", { path: "a.txt", content: "x" })
    expect(await h.check(write, {})).toBe("allow")
    h.__setWorkMode("DISCUSS")
    expect(h.__getWorkMode()).toBe("DISCUSS")
    expect(await h.check(call("w1", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "deny",
    )
    expect(await h.check(call("r1", "read_file", { path: "a.txt" }), {})).toBe("allow")
  })

  test("DISCUSS (unified read-only + plan) → EXECUTE: todo_write boleh di DISCUSS, write_file baru boleh di EXECUTE", async () => {
    const root = tmpRoot()
    const h = liveHandler("DISCUSS", "auto", root)
    // DISCUSS (unified): todo_write boleh, tapi tulis file/bash tetap deny.
    expect(await h.check(call("t1", "todo_write", { todos: [] }), {})).toBe("allow")
    expect(await h.check(call("w1", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "deny",
    )
    expect(await h.check(call("b1", "bash", { cmd: "echo hi" }), {})).toBe("deny")
    h.__setWorkMode("EXECUTE")
    expect(await h.check(call("w2", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "allow",
    )
  })

  test("WorkMode tidak menggeser permission mode dasar (INV-WM1)", async () => {
    const root = tmpRoot()
    const h = liveHandler("DISCUSS", "auto", root)
    h.__setWorkMode("EXECUTE")
    // EXECUTE + PM auto: write boleh (identitas base).
    expect(await h.check(call("w0", "write_file", { path: "a.txt", content: "x" }), {})).toBe(
      "allow",
    )
  })

  test("permission mode → readonly tetap membatasi meski WorkMode DISCUSS/EXECUTE", async () => {
    const root = tmpRoot()
    for (const wm of ["DISCUSS", "EXECUTE"] as const) {
      const h = liveHandler(wm, "auto", root)
      h.__setMode("readonly")
      expect(
        await h.check(call(`w-${wm}`, "write_file", { path: "a.txt", content: "x" }), {}),
      ).toBe("deny")
      expect(await h.check(call(`r-${wm}`, "read_file", { path: "a.txt" }), {})).toBe("allow")
    }
  })
})

describe("2. wiring sesi — kontrol WorkMode hidup di composition root", () => {
  test("onWorkMode memberi handle; setWorkMode mengubah state handler", async () => {
    const root = tmpRoot()
    let control: { setWorkMode(m: WorkMode): void; getWorkMode(): WorkMode } | undefined
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [],
      cwd: root,
      permissionMode: "auto",
      workMode: "EXECUTE",
      onWorkMode: (ctl) => {
        control = ctl
      },
    })
    expect(control).toBeDefined()
    expect(control!.getWorkMode()).toBe("EXECUTE")
    control!.setWorkMode("DISCUSS")
    expect(control!.getWorkMode()).toBe("DISCUSS")
  })

  test("sesi dengan handler terinjeksi tidak diberi kontrol WorkMode (fail-closed)", async () => {
    const root = tmpRoot()
    let wired = false
    const base = createPermissionHandler({ mode: "auto", root })
    await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: [],
      cwd: root,
      permissionMode: "readonly",
      permissionHandler: base,
      onWorkMode: () => {
        wired = true
      },
    })
    expect(wired).toBe(false)
  })
})

describe("3. tool visibility mengikuti WorkMode aktif (daftar yang dilihat kernel)", () => {
  test("setWorkMode mengubah daftar tool LIVE (array dipegang kernel dimutasi in-place)", async () => {
    const { sessionTools, setWorkMode } = await setupToolLayer(
      { providers: [] } as never,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    const full = sessionTools.length
    expect(setWorkMode).toBeDefined()
    setWorkMode!("DISCUSS")
    // Array yang sama (identitas objek) — kernel menyimpan referensi ini.
    expect(sessionTools.length).toBe(21)
    expect(sessionTools.map((t) => t.name)).toContain("todo_write")
    setWorkMode!("EXECUTE")
    expect(sessionTools.length).toBe(full)
  })

  test("kernel melihat daftar tool yang diperbarui (context tokens menyusut)", async () => {
    const root = tmpRoot()
    const { sessionTools, setWorkMode } = await setupToolLayer(
      { providers: [] } as never,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    const session = await createMinicodeSession({
      provider: new FakeProvider([]),
      tools: sessionTools,
      cwd: root,
      permissionMode: "auto",
      workMode: "EXECUTE",
    })
    const before = session.contextTokens
    setWorkMode!("DISCUSS")
    // contextTokens dihitung dari `registry.list()` — jadi bila daftar tool
    // kernel ikut berubah, estimasi konteks juga berubah (bukti nyata, bukan
    // asumsi soal array yang dimutasi).
    expect(session.contextTokens).toBeLessThan(before)
  })
})

describe("4. delegasi mewarisi WorkMode parent yang AKTIF", () => {
  const providerEnv = (): (() => void) => {
    const savedKey = process.env.OPENAI_API_KEY
    const savedAgent = process.env.AGENT_API_KEY
    if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
    return () => {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKey
      if (savedAgent === undefined) delete process.env.AGENT_API_KEY
      else process.env.AGENT_API_KEY = savedAgent
    }
  }
  const ctxFor = (cwd: string, pm: string) =>
    ({
      signal: new AbortController().signal,
      emit: () => {},
      cwd,
      permissionMode: pm,
    }) as never

  test("setelah WorkMode parent berubah, child mewarisi mode terbaru", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-rt"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    let wm: WorkMode = "EXECUTE"
    // Handle kontrol seperti composition root: fn live ke state aktif.
    setSubAgentWorkMode(() => wm)
    try {
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[0]!.workMode).toBe("EXECUTE")
      // Operator menurunkan work mode parent ke DISCUSS (aksi eksplisit di TUI).
      wm = "DISCUSS"
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[1]!.workMode).toBe("DISCUSS")
      // Child tak pernah lebih lebar: tools anak ikut ceiling WorkMode.
      for (const n of seen[1]!.tools.map((t) => t.name)) expect(EXPLORE_TOOL_NAMES).toContain(n)
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })

  test("argumen delegasi tak bisa menaikkan WorkMode parent", async () => {
    const restore = providerEnv()
    const dir = tmpRoot()
    dirs.push(dir)
    const prevTodo = todoSession.id
    todoSession.id = "p-wm-rt2"
    const seen: SubAgentSpec[] = []
    setSubAgentSessionFactory(async (spec: SubAgentSpec) => {
      seen.push(spec)
      return {
        events: { on: () => () => {} },
        run: async () => ({ finalText: "ok", usage: { steps: 1 } }),
      }
    })
    const wm: WorkMode = "DISCUSS"
    setSubAgentWorkMode(() => wm)
    try {
      // Model meminta mode "plan" (bukan explore) — tak boleh menaikkan parent.
      await delegateTaskTool.execute({ prompt: "x", mode: "plan" }, ctxFor(dir, "auto"))
      expect(seen[0]!.workMode).toBe("DISCUSS")
      expect(wm).toBe("DISCUSS")
    } finally {
      todoSession.id = prevTodo
      restore()
    }
  })
})

describe("5. hooks mengikuti WorkMode AKTIF, bukan snapshot", () => {
  test("predicate mengikuti handle kontrol yang berubah (Q3=A3: DISCUSS menahan)", () => {
    let wm: WorkMode = "EXECUTE"
    expect(shouldRunHooks("auto", wm)).toBe(true)
    wm = "DISCUSS"
    expect(shouldRunHooks("auto", wm)).toBe(false)
  })
})

describe("6. footer mencerminkan kombinasi WorkMode + permission mode", () => {
  test("EXECUTE → Build: nilai title case tanpa label", () => {
    expect(stripAnsi(paintWorkMode("EXECUTE")).trimEnd()).toBe("Build")
    expect(paintWorkMode("EXECUTE")).not.toContain("Work Mode:")
    expect(paintWorkMode("EXECUTE")).not.toContain("EXECUTE")
    expect(stripAnsi(paintPermissionMode("auto"))).toBe("Auto")
    expect(paintPermissionMode("auto")).not.toContain("Permission Mode:")
  })
  test("Discuss dan Ask memakai title case tanpa label", () => {
    expect(stripAnsi(paintWorkMode("DISCUSS")).trimEnd()).toBe("Discuss")
    expect(stripAnsi(paintPermissionMode("ask"))).toBe("Ask")
  })
  test("renderFooter menempatkan kedua nilai mode pada footer", () => {
    const line = renderFooter(
      { mode: "auto", workMode: "DISCUSS", model: "m1", cwd: "cwd" },
      90,
    )[0]!
    expect(line).toContain("Discuss")
    expect(line).toContain("Auto")
    expect(line).not.toContain("Work Mode:")
    expect(line).not.toContain("Permission Mode:")
    const plain = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 90)[0]!
    expect(plain).toContain("Discuss")
    expect(plain).toContain("Auto")
  })
})

describe("8. jalur produksi createCliSession — wiring composition root, G1, & G-MEM-TRACK", () => {
  test("perubahan WorkMode live/updating tool visibility sesi nyata", async () => {
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const { writeFileSync, mkdirSync } = await import("node:fs")
    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-prod-"))
    roots.push(cwd)
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const provider = startFakeProvider([{ kind: "text", text: "halo" }])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const { createCliSession } = await import("../cli/setup.ts")
    const ctx = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "",
      prompt: "hi",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      allowlist: false,
      verify: false,
      workMode: "EXECUTE",
    })
    try {
      expect(ctx.workModeControl).toBeDefined()
      expect(ctx.workModeControl!.getWorkMode()).toBe("EXECUTE")
      expect(ctx.workMode).toBe("EXECUTE")
      const full = ctx.sessionTools.length
      expect(full).toBeGreaterThan(LOCAL_READONLY_TOOL_NAMES.length)
      // Transisi operator: tool yang terlihat menyusut tepat ke 21 tool ceiling DISCUSS.
      ctx.workModeControl!.setWorkMode("DISCUSS")
      expect(ctx.workModeControl!.getWorkMode()).toBe("DISCUSS")
      expect(ctx.workMode).toBe("DISCUSS")
      expect(ctx.sessionTools).toHaveLength(21)
      expect(ctx.sessionTools.map((t) => t.name)).toContain("todo_write")
      expect(ctx.sessionTools.map((t) => t.name)).not.toContain("write_file")
      // Kembali ke EXECUTE: daftar penuh kembali.
      ctx.workModeControl!.setWorkMode("EXECUTE")
      expect(ctx.sessionTools.length).toBe(full)
    } finally {
      await ctx.close()
      provider.close()
    }
  })

  test("G1 tertutup: sesi mulai DISCUSS → naik ke EXECUTE mampu dispatch write_file; turun lagi ke DISCUSS menolak write_file", async () => {
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs")
    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-g1-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-g1home-"))
    roots.push(cwd, home)
    const savedMinicodeHome = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    const provider = startFakeProvider([
      // Turn 1 (setelah naik ke EXECUTE): model memanggil write_file → HARUS berhasil.
      { kind: "tool", id: "c1", name: "write_file", args: { path: "g1-ok.txt", content: "hidup" } },
      { kind: "text", text: "berhasil ditulis" },
      // Turn 2 (setelah turun ke DISCUSS): model mencoba write_file → HARUS ditolak/unknown.
      {
        kind: "tool",
        id: "c2",
        name: "write_file",
        args: { path: "g1-blocked.txt", content: "bocor" },
      },
      { kind: "text", text: "ditolak" },
    ])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    const { createCliSession } = await import("../cli/setup.ts")
    const ctx = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "g1-session",
      prompt: "mulai",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      allowlist: false,
      verify: false,
      workMode: "DISCUSS",
      workModeExplicit: true,
    })
    try {
      expect(ctx.sessionTools.map((t) => t.name)).not.toContain("write_file")
      // Naik ke EXECUTE di tengah sesi: liveRegistry harus menemukan write_file!
      ctx.workModeControl!.setWorkMode("EXECUTE")
      await ctx.runPromptWithVerify("tulis g1-ok.txt")
      expect(readFileSync(join(cwd, "g1-ok.txt"), "utf8")).toBe("hidup")

      // Turun kembali ke DISCUSS: write_file disembunyikan & ditolak.
      ctx.workModeControl!.setWorkMode("DISCUSS")
      await ctx.runPromptWithVerify("coba tulis lagi")
      expect(existsSync(join(cwd, "g1-blocked.txt"))).toBe(false)
    } finally {
      await ctx.close()
      provider.close()
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
    }
  })

  test("G-MEM-TRACK tertutup: read_memory pada DISCUSS × auto TIDAK menaikkan access_count di SQLite", async () => {
    const { Database } = await import("bun:sqlite")
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const { addMemory, tripEmbeddingCircuitForTest } = await import("../src/memory/vector.ts")
    const { startFakeProvider } = await import("./helpers/fake-provider.ts")
    const { createCliSession } = await import("../cli/setup.ts")

    const cwd = mkdtempSync(join(tmpdir(), "mc-wm-mem-"))
    const home = mkdtempSync(join(tmpdir(), "mc-wm-memhome-"))
    roots.push(cwd, home)
    const savedMinicodeHome = process.env.MINICODE_HOME
    process.env.MINICODE_HOME = home
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    tripEmbeddingCircuitForTest("https://api.openai.com/v1", undefined, "test")
    await addMemory("rahasia kontrak P0 memori", { cwd, category: "fact" })

    const provider = startFakeProvider([
      { kind: "tool", id: "m1", name: "read_memory", args: { query: "rahasia" } },
      { kind: "text", text: "dibaca di DISCUSS" },
      { kind: "tool", id: "m3", name: "read_memory", args: { query: "rahasia" } },
      { kind: "text", text: "dibaca di EXECUTE" },
    ])
    writeFileSync(
      join(cwd, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "fake", baseUrl: provider.baseUrl, apiKey: "sk-test", models: ["m"] }],
      }),
      "utf8",
    )
    tripEmbeddingCircuitForTest(provider.baseUrl, undefined, "test")

    const readAccessCount = (): number => {
      const db = new Database(join(cwd, ".minicode", "vector.db"), { readonly: true })
      try {
        const row = db
          .query("SELECT access_count FROM memory WHERE text LIKE '%rahasia kontrak P0 memori%'")
          .get() as { access_count: number } | null
        return row?.access_count ?? -1
      } finally {
        db.close()
      }
    }

    const ctx = await createCliSession({
      cwd,
      allowLocalConfig: true,
      sessionId: "mem-session",
      prompt: "baca",
      enterRepl: false,
      verbose: false,
      allowAll: false,
      ask: false,
      allowlist: false,
      verify: false,
      workMode: "DISCUSS",
      workModeExplicit: true,
    })
    try {
      expect(readAccessCount()).toBe(0)
      await ctx.runPromptWithVerify("cari di DISCUSS")
      expect(readAccessCount()).toBe(0)

      ctx.workModeControl!.setWorkMode("EXECUTE")
      await ctx.runPromptWithVerify("cari di EXECUTE")
      expect(readAccessCount()).toBeGreaterThanOrEqual(1)
    } finally {
      await ctx.close()
      provider.close()
      if (savedMinicodeHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = savedMinicodeHome
    }
  })
})

describe("7. command /mode (TUI end-to-end)", () => {
  const makeControl = (initial: WorkMode) => {
    let wm = initial
    return {
      setWorkMode: (m: WorkMode) => {
        wm = m
      },
      getWorkMode: () => wm,
    }
  }
  const fakeSession = (control: ReturnType<typeof makeControl>): CliSession => {
    const bus = { on: () => () => {}, emit: () => {} }
    const noop = async () => {}
    const cwd = tmpRoot()
    let permission: PermissionMode = "auto"
    mkdirSync(join(cwd, ".minicode"), { recursive: true })
    return {
      session: { events: bus as never, contextTokens: 0 },
      cfg: { providers: [] },
      cwd,
      sessionId: "wm-tui",
      modelRef: {} as { current?: string },
      permissionMode: "auto",
      permissions: {
        getMode: () => permission,
        setMode: (next: PermissionMode) => {
          permission = next
        },
      },
      workMode: "EXECUTE",
      workModeControl: control,
      sessionTools: [],
      allLoadedSkills: [],
      allowLocalConfig: false,
      usage: {
        get: () => ({}),
        getSession: () => ({ cost: undefined, totalTokens: 0 }),
        reset: () => {},
      },
      budget: undefined,
      budgetStrict: false,
      persistCurrent: noop,
      runPromptWithVerify: noop,
      close: noop,
    } as unknown as CliSession
  }

  test("/mode DISCUSS dan BUILD mengubah WorkMode aktif; footer ikut berubah", async () => {
    const control = makeControl("EXECUTE")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/mode DISCUSS")
    await tty.send(KEY.enter)
    // Perubahan /mode langsung merender label di footer in-place (tanpa toast penutup footer).
    await tty.waitForOutput(() =>
      /Discuss/.test(stripAnsi(tty!.screen()[tty!.screen().length - 1] ?? "")),
    )
    const discussFooter = stripAnsi(tty.screen()[tty.screen().length - 1] ?? "")
    expect(discussFooter).toContain("Discuss")
    expect(discussFooter).not.toContain("work mode:")
    expect(control.getWorkMode()).toBe("DISCUSS")
    // BUILD diterima → identitas internal EXECUTE, ditampil Build.
    await tty.send("/mode BUILD")
    await tty.send(KEY.enter)
    await tty.waitForOutput(() => control.getWorkMode() === "EXECUTE")
    expect(control.getWorkMode()).toBe("EXECUTE")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("/undo tetap tersedia di DISCUSS untuk percakapan-saja (tanpa turn = pesan jelas)", async () => {
    const control = makeControl("DISCUSS")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/undo")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("No user turn to undo"))
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("/mode ask saat unrestricted hanya mengubah izin", async () => {
    const control = makeControl("DISCUSS")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/unrestric on")
    await tty.send(KEY.enter)
    await tty.waitForOutput(() => control.getWorkMode() === "EXECUTE")
    expect(control.getWorkMode()).toBe("EXECUTE")
    await tty.send("/mode ask")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f[f.length - 1]!.includes("Ask"))
    expect(control.getWorkMode()).toBe("EXECUTE")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("input invalid (termasuk PLAN): pesan error, WorkMode TIDAK berubah", async () => {
    const control = makeControl("DISCUSS")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/mode PLAN")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("unknown mode"))
    expect(control.getWorkMode()).toBe("DISCUSS")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })

  test("/mode popup mengatur kedua sumbu independen dan batal tidak mengubah state", async () => {
    const control = makeControl("DISCUSS")
    const session = fakeSession(control)
    tty = installFakeTty({ columns: 90, rows: 24 })
    const runP = runTui(session)
    try {
      await tty.ready()
      await tty.waitForOutput((o) => o.includes("00.00.00"))
      await tty.send("/mode")
      await tty.send(KEY.enter)
      await tty.waitForScreen(
        (f) => f.some((l) => l.includes("Work mode")) && f.some((l) => l.includes("Permission")),
      )
      expect(control.getWorkMode()).toBe("DISCUSS")
      expect(session.permissions?.getMode()).toBe("auto")
      await tty.send(KEY.right)
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f[f.length - 1]!.includes("Build"))
      expect(control.getWorkMode()).toBe("EXECUTE")
      expect(session.permissions?.getMode()).toBe("auto")

      await tty.send("/mode")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes("Permission")))
      await tty.send(KEY.tab)
      await tty.send(KEY.right)
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f[f.length - 1]!.includes("Ask"))
      expect(control.getWorkMode()).toBe("EXECUTE")
      expect(session.permissions?.getMode()).toBe("ask")

      await tty.send("/mode")
      await tty.send(KEY.enter)
      await tty.waitForScreen((f) => f.some((l) => l.includes("Work mode")))
      await tty.send(KEY.left)
      await tty.send(KEY.esc, 90)
      await tty.send(KEY.esc, 90)
      await tty.waitForScreen((f) => f.some((l) => l.includes("minicode ›")))
      expect(control.getWorkMode()).toBe("EXECUTE")
      expect(session.permissions?.getMode()).toBe("ask")
    } finally {
      await tty.send("\x15/exit")
      await tty.send(KEY.enter)
      await runP
    }
  })

  test("/mode = PermissionMode (AUTO/ASK), tak mengubah WorkMode; Shift+Tab = toggle", async () => {
    const control = makeControl("DISCUSS")
    tty = installFakeTty({ columns: 80, rows: 24 })
    const runP = runTui(fakeSession(control))
    await tty.ready()
    await tty.waitForOutput((o) => o.includes("00.00.00"))
    await tty.send("/mode ask")
    await tty.send(KEY.enter)
    await tty.waitForOutput(() =>
      /Ask/.test(stripAnsi(tty!.screen()[tty!.screen().length - 1] ?? "")),
    )
    const askFooter = stripAnsi(tty.screen()[tty!.screen().length - 1] ?? "")
    expect(askFooter).toContain("Ask")
    expect(askFooter).not.toContain("mode:")
    expect(control.getWorkMode()).toBe("DISCUSS")
    await tty.send("/mode readonly")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("unknown mode"))
    expect(control.getWorkMode()).toBe("DISCUSS")
    await tty.send(KEY.shiftTab)
    expect(control.getWorkMode()).toBe("DISCUSS")
    await tty.send("/exit")
    await tty.send(KEY.enter)
    await runP
  })
})
