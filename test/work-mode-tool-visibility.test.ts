// Kontrak visibilitas tool WorkMode (2-mode: DISCUSS | EXECUTE) — ceiling di lapisan tool layer.
//
// INV-WM1: WorkMode TIDAK PERNAH memperluas akses yang sudah dibatasi permission
// mode; ia hanya mempersempit. Filter di `src/app/tool-layer.ts` digabung sebagai
// IRISAN (tool harus lolos filter permission mode DAN filter WorkMode). Slice ini
// BUKAN defense-in-depth permission (deny tetap di handler) — ia menghindari model
// membuang langkah mencoba tool yang pasti ditolak, dan menutup kebocoran tool
// MCP runtime ke posture non-EXECUTE.

import { describe, expect, test } from "bun:test"
import type { Tool } from "#minicore"
import { applyWorkModeFilter, setupToolLayer, workModeVisible } from "../src/app/tool-layer.ts"
import {
  LOCAL_READONLY_TOOL_NAMES,
  NETWORK_READ_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "../src/policy/tool-contract.ts"
import { allTools } from "../src/tools/index.ts"
import { EXPLORE_TOOL_NAMES } from "../src/tools/task.ts"

const cfgEmpty = { providers: [] } as never
const nameOf = (ts: readonly Tool[]) => ts.map((t) => t.name)

const WRITE_TOOLS = [
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "bash",
  "code_run",
  "write_memory",
  "forget_memory",
  "git_commit",
  "mcp_call",
  "mcp_read",
  "mcp_prompt",
  "ask_user",
]

const PLAN_EXTRA = ["todo_write", "delegate_task", "submit_result"] as const

describe("work-mode tool visibility — fixture", () => {
  test("himpunan kontrak baca (EXPLORE=12, LOCAL_READONLY=16, READONLY=18) ada di allTools", () => {
    const names = new Set(nameOf(allTools))
    expect(EXPLORE_TOOL_NAMES.length).toBe(12)
    expect(LOCAL_READONLY_TOOL_NAMES.length).toBe(16)
    expect(READONLY_TOOL_NAMES.size).toBe(18)
    for (const n of EXPLORE_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of LOCAL_READONLY_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of READONLY_TOOL_NAMES) expect(names.has(n)).toBe(true)
  })

  test("predikat workModeVisible: EXECUTE = identitas, DISCUSS = 18/21 sesuai PM (unified read-only + planning)", () => {
    expect(workModeVisible("read_file", "EXECUTE")).toBe(true)
    expect(workModeVisible("write_file", "EXECUTE")).toBe(true)
    // DISCUSS default/auto: 18 READONLY_TOOL_NAMES + 3 PLAN_EXTRA = 21.
    expect(workModeVisible("read_file", "DISCUSS")).toBe(true)
    expect(workModeVisible("read_image", "DISCUSS")).toBe(true)
    expect(workModeVisible("git_diff", "DISCUSS")).toBe(true)
    expect(workModeVisible("lsp_references", "DISCUSS")).toBe(true)
    expect(workModeVisible("lsp_symbols", "DISCUSS")).toBe(true)
    expect(workModeVisible("web_fetch", "DISCUSS")).toBe(true)
    expect(workModeVisible("web_search", "DISCUSS")).toBe(true)
    expect(workModeVisible("todo_write", "DISCUSS")).toBe(true)
    expect(workModeVisible("delegate_task", "DISCUSS")).toBe(true)
    expect(workModeVisible("submit_result", "DISCUSS")).toBe(true)
    expect(workModeVisible("write_file", "DISCUSS")).toBe(false)
    expect(workModeVisible("bash", "DISCUSS")).toBe(false)
    // DISCUSS × allowlist/readonly (G5): PLAN_EXTRA disembunyikan agar visible === callable.
    expect(workModeVisible("todo_write", "DISCUSS", "allowlist")).toBe(false)
    expect(workModeVisible("delegate_task", "DISCUSS", "readonly")).toBe(false)
    expect(workModeVisible("read_file", "DISCUSS", "allowlist")).toBe(true)
  })
})

describe("DISCUSS × permission mode — tidak memperluas permission mode (visible === callable)", () => {
  for (const pm of ["auto", "ask", "plan", "allow-all"] as const) {
    test(`DISCUSS × ${pm}: tepat 21 tool (18 READONLY + 3 PLAN_EXTRA)`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "DISCUSS",
      )
      const names = nameOf(sessionTools)
      const allowed = new Set([...READONLY_TOOL_NAMES, ...PLAN_EXTRA])
      expect(names).toHaveLength(21)
      for (const n of allowed) expect(names).toContain(n)
      for (const n of names) expect(allowed.has(n)).toBe(true)
      for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
    })
  }

  for (const pm of ["readonly", "allowlist"] as const) {
    test(`DISCUSS × ${pm}: tepat 18 READONLY_TOOL_NAMES tanpa PLAN_EXTRA (G5 tertutup)`, async () => {
      const { sessionTools } = await setupToolLayer(
        cfgEmpty,
        "full",
        pm,
        undefined,
        undefined,
        "DISCUSS",
      )
      const names = nameOf(sessionTools)
      expect(names).toHaveLength(18)
      for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
      for (const n of names) expect(READONLY_TOOL_NAMES).toContain(n)
      for (const extra of PLAN_EXTRA) expect(names).not.toContain(extra)
      for (const net of NETWORK_READ_TOOL_NAMES) expect(names).toContain(net)
    })
  }
})

describe("EXECUTE × permission mode — perilaku lama + keselarasan READONLY_TOOL_NAMES", () => {
  // v7.40 (audit): di auto, `ask_user` disembunyikan karena handler permission
  // AUTO menolaknya deterministik — visible === callable. Jadi "semua tool"
  // kini = allTools − 1. Ini bukan regresi, tapi penegakan invarian.
  const autoCount = allTools.length - 1
  test("EXECUTE × auto: semua tool bawaan kecuali ask_user (auto deny)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "auto",
      undefined,
      undefined,
      "EXECUTE",
    )
    expect(nameOf(sessionTools)).toHaveLength(autoCount)
    expect(nameOf(sessionTools)).not.toContain("ask_user")
  })
  test("EXECUTE (tanpa argumen, default) × auto: semua tool bawaan kecuali ask_user", async () => {
    const { sessionTools } = await setupToolLayer(cfgEmpty, "full", "auto")
    expect(nameOf(sessionTools)).toHaveLength(autoCount)
    expect(nameOf(sessionTools)).not.toContain("ask_user")
  })
  test("EXECUTE × readonly: tepat 18 READONLY_TOOL_NAMES", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "readonly",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    expect(names).toHaveLength(18)
    for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
  })
  test("EXECUTE × plan: tepat 21 tool (18 READONLY + 3 PLAN_EXTRA)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "plan",
      undefined,
      undefined,
      "EXECUTE",
    )
    const names = nameOf(sessionTools)
    expect(names).toHaveLength(21)
    for (const n of READONLY_TOOL_NAMES) expect(names).toContain(n)
    for (const extra of PLAN_EXTRA) expect(names).toContain(extra)
  })
  test("transisi runtime setPermissionMode + setWorkMode menyinkronkan sessionTools in-place", async () => {
    const { sessionTools, setWorkMode, setPermissionMode } = await setupToolLayer(
      cfgEmpty,
      "full",
      "auto",
      undefined,
      undefined,
      "DISCUSS",
    )
    expect(sessionTools).toHaveLength(21)
    setPermissionMode!("allowlist")
    expect(sessionTools).toHaveLength(18)
    expect(nameOf(sessionTools)).not.toContain("todo_write")
    setWorkMode!("EXECUTE")
    setPermissionMode!("auto")
    expect(sessionTools).toHaveLength(autoCount)
    expect(nameOf(sessionTools)).not.toContain("ask_user")
  })
})

describe("unrestricted × WorkMode — INV-WM1: WorkMode mempersempit, unrestricted hanya penuh di EXECUTE", () => {
  test("EXECUTE × unrestricted: semua tool bawaan tampil (full akses)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "unrestricted",
      undefined,
      undefined,
      "EXECUTE",
    )
    expect(nameOf(sessionTools)).toHaveLength(allTools.length)
    expect(workModeVisible("bash", "EXECUTE", "unrestricted")).toBe(true)
    expect(workModeVisible("write_file", "EXECUTE", "unrestricted")).toBe(true)
    expect(workModeVisible("git_commit", "EXECUTE", "unrestricted")).toBe(true)
  })
  test("DISCUSS × unrestricted: tetap 21 tool ceiling DISCUSS (ceiling menang atas unrestricted)", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "unrestricted",
      undefined,
      undefined,
      "DISCUSS",
    )
    const names = nameOf(sessionTools)
    const allowed = new Set([...READONLY_TOOL_NAMES, ...PLAN_EXTRA])
    expect(names).toHaveLength(21)
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w)
    for (const n of names) expect(allowed.has(n)).toBe(true)
  })
})

describe("tool MCP mengikuti batasan WorkMode", () => {
  const mcpTool = (name: string): Tool =>
    ({ name, parameters: { type: "object", properties: {} } }) as unknown as Tool

  test("DISCUSS menolak tool MCP runtime bertitik", () => {
    expect(workModeVisible("github.list_repos", "DISCUSS")).toBe(false)
    expect(workModeVisible("fs.read", "DISCUSS")).toBe(false)
  })
  test("EXECUTE membolehkan tool MCP runtime (perilaku lama)", () => {
    expect(workModeVisible("github.list_repos", "EXECUTE")).toBe(true)
  })
  test("applyWorkModeFilter memfilter daftar tool campuran (bawaan + MCP)", () => {
    const mix = [...allTools, mcpTool("github.list_repos"), mcpTool("fs.read")]
    const discussedNames = nameOf(applyWorkModeFilter(mix, "DISCUSS"))
    expect(discussedNames).not.toContain("github.list_repos")
    expect(discussedNames).not.toContain("fs.read")
    const allowed = new Set([...READONLY_TOOL_NAMES, ...PLAN_EXTRA])
    for (const n of discussedNames) expect(allowed.has(n)).toBe(true)
  })
})

describe("AGENT-CONTROL-3 — EXECUTE × allowlist: visible === callable (gated/MCP disembunyikan)", () => {
  const mcpTool = (name: string): Tool =>
    ({ name, parameters: { type: "object", properties: {} } }) as unknown as Tool

  test("predikat workModeVisible menolak gated & MCP di allowlist", () => {
    for (const gated of ["delegate_task", "git_commit", "git_push", "mcp_call", "ask_user"]) {
      expect(workModeVisible(gated, "EXECUTE", "allowlist")).toBe(false)
    }
    expect(workModeVisible("github.list_repos", "EXECUTE", "allowlist")).toBe(false)
    // code_run ditolak handler allowlist (butuh sandbox + bukan read/write yang
    // diizinkan) — sembunyikan juga supaya visible === callable.
    expect(workModeVisible("code_run", "EXECUTE", "allowlist")).toBe(false)
    // Mode lain tempat code_run memang callable tetap menampilkannya.
    expect(workModeVisible("code_run", "EXECUTE", "auto")).toBe(true)
    expect(workModeVisible("code_run", "EXECUTE", "ask")).toBe(true)
    expect(workModeVisible("code_run", "EXECUTE", "allow-all")).toBe(true)
    expect(workModeVisible("code_run", "DISCUSS")).toBe(false)
    expect(workModeVisible("code_run", "EXECUTE", "plan")).toBe(false)
    expect(workModeVisible("code_run", "EXECUTE", "readonly")).toBe(false)
    // Tool yang memang bisa dipanggil di allowlist tetap terlihat.
    expect(workModeVisible("write_file", "EXECUTE", "allowlist")).toBe(true)
    expect(workModeVisible("read_file", "EXECUTE", "allowlist")).toBe(true)
    expect(workModeVisible("bash", "EXECUTE", "allowlist")).toBe(true)
  })

  test("setupToolLayer + filter daftar campuran: nol gated/MCP pada EXECUTE × allowlist", async () => {
    const { sessionTools } = await setupToolLayer(
      cfgEmpty,
      "full",
      "allowlist",
      undefined,
      undefined,
      "EXECUTE",
    )
    expect(nameOf(sessionTools)).not.toContain("delegate_task")
    expect(nameOf(sessionTools)).not.toContain("git_commit")
    expect(nameOf(sessionTools)).not.toContain("mcp_call")
    expect(nameOf(sessionTools)).not.toContain("code_run")

    // Simulasikan MCP runtime terdaftar (tanpa koneksi jaringan) lalu filter.
    const mix = [...sessionTools, mcpTool("github.list_repos"), mcpTool("fs.read")]
    const visible = nameOf(applyWorkModeFilter(mix, "EXECUTE", "allowlist"))
    expect(visible).not.toContain("github.list_repos")
    expect(visible).not.toContain("fs.read")
    // Alat tulis/baca yang memang callable di allowlist tetap tampil.
    expect(visible).toContain("write_file")
    expect(visible).toContain("read_file")
  })
})
