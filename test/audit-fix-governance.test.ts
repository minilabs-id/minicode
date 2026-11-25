// Audit governance — v7.33. Mengunci dua temuan kritis:
//
//  F1 (CRITICAL) `visible === callable` saat transisi WorkMode: otorisasi MCP
//    WAJIB live, bukan snapshot. `session.ts` dulu membekukan `new Set(tools)`
//    sekali saat sesi dibuat, sehingga tool MCP yang muncul di EXECUTE tetap
//    deny ("not configured/authorized"). Predikat `createLiveAuthorizedTools`
//    membaca array tool LIVE milik tool-layer tiap pemanggilan.
//  F2 (HIGH) "satu sumber kebenaran" — klasifikasi permission (file write,
//    internal write, no-prompt, plan-extra) DAN jail group kini diturunkan dari
//    TOOL_CONTRACTS. Test no-drift di bawah membuktikan himpunan hasil identik
//    dengan literal lama, jadi ini refactor murni (bukan perubahan kebijakan).
//
// Semua perilaku diuji di proses ini dengan handler produksi; TTY dipalsukan
// ketika jalur ASK gated butuh terminal (pola permission-contract.test.ts).

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Tool } from "#minicore"
import { createLiveAuthorizedTools } from "../src/app/session.ts"
import { applyWorkModeFilter } from "../src/app/tool-layer.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  CWD_JAIL_TOOL_NAMES,
  contractForTool,
  FILE_JAIL_TOOL_NAMES,
  FILE_WRITE_TOOL_NAMES,
  GATED_TOOLS,
  INTERNAL_WRITE_TOOL_NAMES,
  LSP_FILE_JAIL_TOOL_NAMES,
  NO_PROMPT_TOOL_NAMES,
  PLAN_EXTRA_TOOL_NAMES,
  TOOL_CONTRACTS,
} from "../src/policy/tool-contract.ts"
import { allTools } from "../src/tools/index.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

const tmpRoot = (tag: string): string => mkdtempSync(join(tmpdir(), `mc-audit-gov-${tag}-`))
const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, args })
const mcpTool = (name: string): Tool =>
  ({ name, parameters: { type: "object", properties: {} } }) as unknown as Tool

// ── F1 — otorisasi LIVE ─────────────────────────────────────────────────────

describe("F1 — visible === callable lewat predikat otorisasi live", () => {
  test("predikat mengikuti array tool LIVE di kedua arah transisi", () => {
    const mcp = mcpTool("github.list_repos")
    const tools: Tool[] = [mcp] // EXECUTE: MCP terlihat
    const auth = createLiveAuthorizedTools(tools)
    expect(auth.hasAuthorizedTool("github.list_repos")).toBe(true)
    // DISCUSS: tool-layer mengosongkan array secara in-place.
    tools.length = 0
    expect(auth.hasAuthorizedTool("github.list_repos")).toBe(false)
    // EXECUTE lagi: tool kembali muncul.
    tools.push(mcp)
    expect(auth.hasAuthorizedTool("github.list_repos")).toBe(true)
    // Fail-closed: tool tak dikenal tak pernah authorized.
    expect(auth.hasAuthorizedTool("evil.unknown")).toBe(false)
  })

  test("auto: MCP deny→allow→deny mengikuti predikat (bukan snapshot)", async () => {
    const root = tmpRoot("f1-auto")
    try {
      const tools: Tool[] = []
      const auth = createLiveAuthorizedTools(tools)
      const h = createPermissionHandler({
        mode: "auto",
        root,
        hasAuthorizedTool: auth.hasAuthorizedTool,
      })
      expect(await h.check(call("a", "github.list_repos", {}), {} as never)).toBe("deny")
      tools.push(mcpTool("github.list_repos"))
      expect(await h.check(call("b", "github.list_repos", {}), {} as never)).toBe("allow")
      tools.length = 0
      expect(await h.check(call("c", "github.list_repos", {}), {} as never)).toBe("deny")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("kompatibilitas: authorizedTools statis tetap jalan; predikat menang bila keduanya ada", async () => {
    const root = tmpRoot("f1-compat")
    try {
      const legacy = createPermissionHandler({
        mode: "auto",
        root,
        authorizedTools: new Set(["fs.read"]),
      })
      expect(await legacy.check(call("1", "fs.read", {}), {} as never)).toBe("allow")
      expect(await legacy.check(call("2", "other.tool", {}), {} as never)).toBe("deny")
      const both = createPermissionHandler({
        mode: "auto",
        root,
        authorizedTools: new Set(["fs.read"]),
        hasAuthorizedTool: () => false,
      })
      expect(await both.check(call("3", "fs.read", {}), {} as never)).toBe("deny")
      const none = createPermissionHandler({ mode: "auto", root })
      expect(await none.check(call("4", "fs.read", {}), {} as never)).toBe("deny")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("integrasi tool-layer: mutasi in-place `visible` mengubah autorisasi MCP", async () => {
    const root = tmpRoot("f1-layer")
    try {
      const all = [...allTools, mcpTool("srv.doThing")]
      // DISCUSS: workModeVisible menyembunyikan MCP bertitik.
      const visible = applyWorkModeFilter(all, "DISCUSS")
      expect(visible.map((t) => t.name)).not.toContain("srv.doThing")
      const auth = createLiveAuthorizedTools(visible)
      const h = createPermissionHandler({
        mode: "auto",
        root,
        hasAuthorizedTool: auth.hasAuthorizedTool,
      })
      const check = (id: string) => h.check(call(id, "srv.doThing", {}), {} as never)
      expect(await check("1")).toBe("deny")

      // setWorkMode('EXECUTE') tool-layer = mutasi in-place array yang SAMA.
      const exec = applyWorkModeFilter(all, "EXECUTE")
      visible.length = 0
      visible.push(...exec)
      expect(visible.map((t) => t.name)).toContain("srv.doThing")
      expect(await check("2")).toBe("allow")

      // Kembali ke DISCUSS → tool hilang dari wire → autorisasi dicabut.
      const discuss = applyWorkModeFilter(all, "DISCUSS")
      visible.length = 0
      visible.push(...discuss)
      expect(await check("3")).toBe("deny")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── F2 — satu sumber kebenaran (no-drift) ───────────────────────────────────

describe("F2 — derivasi kontrak identik dengan daftar lama", () => {
  const eq = (actual: ReadonlySet<string>, legacy: readonly string[]): void => {
    expect([...actual].sort()).toEqual([...legacy].sort())
  }

  test("set permission (file/internal/no-prompt/plan/gated) tidak bergeser", () => {
    eq(FILE_WRITE_TOOL_NAMES, [
      "write_file",
      "edit",
      "apply_patch",
      "move_file",
      "delete_file",
      "git_restore",
      "git_checkout",
      "lsp_rename",
    ])
    eq(INTERNAL_WRITE_TOOL_NAMES, [
      "write_memory",
      "forget_memory",
      "todo_write",
      "submit_result",
      "bash_output",
      "bash_kill",
    ])
    eq(NO_PROMPT_TOOL_NAMES, ["todo_write", "submit_result", "bash_output", "bash_kill"])
    eq(PLAN_EXTRA_TOOL_NAMES, ["todo_write", "delegate_task", "submit_result"])
    eq(GATED_TOOLS, [
      "git_commit",
      "git_push",
      "git_restore",
      "git_checkout",
      "delegate_task",
      "mcp_call",
      "mcp_read",
      "mcp_prompt",
      "ask_user",
      "lsp_rename",
    ])
  })

  test("jail group turunan = enumerasi nama lama", () => {
    eq(FILE_JAIL_TOOL_NAMES, [
      "write_file",
      "edit",
      "apply_patch",
      "move_file",
      "delete_file",
      "git_restore",
      "git_checkout",
      "lsp_rename",
      "read_file",
      "read_image",
    ])
    eq(CWD_JAIL_TOOL_NAMES, [
      "bash",
      "glob",
      "grep",
      "git_status",
      "git_diff",
      "git_log",
      "git_commit",
      "git_push",
    ])
  })

  test("tool WORKSPACE_MUTATION baru (ws(...)) otomatis ter-jail & auto-allowed", () => {
    // Menutup fail-open: flag jailTarget:"file" ditetapkan di helper ws(), jadi
    // tool baru (git_restore/git_checkout/lsp_rename) otomatis ter-jail tanpa
    // daftar manual.
    const wsContracts = TOOL_CONTRACTS.filter((c) => c.sideEffectTier === "WORKSPACE_MUTATION")
    expect(wsContracts.length).toBeGreaterThan(0)
    for (const c of wsContracts) {
      expect(c.jailTarget).toBe("file")
      expect(FILE_WRITE_TOOL_NAMES.has(c.name)).toBe(true)
      expect(FILE_JAIL_TOOL_NAMES.has(c.name)).toBe(true)
    }
    // Nama tak dikenal TANPA titik = undefined (jurnal memperlakukannya sebagai
    // mutation = fail-closed). Nama bertitik mewarisi kontrak mcp_call.
    expect(contractForTool("totallyUnknown")).toBeUndefined()
    expect(contractForTool("totally.unknown")?.name).toBe("mcp_call")
  })
})

// ── F2 — guard perilaku ─────────────────────────────────────────────────────

describe("F2 — guard: jail & approval mengikuti flag kontrak", () => {
  test("setiap jailTarget:'file': auto-allow di dalam root, deny di luar", async () => {
    const root = tmpRoot("f2-jail")
    try {
      const h = createPermissionHandler({ mode: "auto", root })
      const inside = "safe.txt"
      const inside2 = "safe2.txt"
      const outside = resolve(root, "..", "escape-secret.txt")
      for (const c of TOOL_CONTRACTS.filter((x) => x.jailTarget === "file")) {
        const argsIn =
          c.name === "move_file" ? { path: inside, destination: inside2 } : { path: inside }
        const argsOut =
          c.name === "move_file" ? { path: outside, destination: inside2 } : { path: outside }
        expect(
          await h.check(call(`${c.name}-in`, c.name, argsIn), {} as never),
          `auto harus allow ${c.name} di dalam root`,
        ).toBe("allow")
        expect(
          await h.check(call(`${c.name}-out`, c.name, argsOut), {} as never),
          `auto harus deny ${c.name} di luar root`,
        ).toBe("deny")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("setiap gatedByDefault tool memicu prompt di mode ASK", async () => {
    const root = tmpRoot("f2-ask")
    const tty = installFakeTty({ isTTY: true })
    try {
      let prompts = 0
      const h = createPermissionHandler({
        mode: "ask",
        root,
        ask: async () => {
          prompts++
          return "deny"
        },
      })
      for (const name of GATED_TOOLS) {
        const before = prompts
        // v7.38: tool jail-by-path (FILE_JAIL/LSP_FILE_JAIL) butuh `path` valid,
        // kalau tidak jail menolak DULUAN sebelum handler ASK sempat mem-prompt.
        // Sertakan path di dalam root + nonce unik (anti short-circuit allowlist).
        const needsPath = FILE_JAIL_TOOL_NAMES.has(name) || LSP_FILE_JAIL_TOOL_NAMES.has(name)
        const decision = await h.check(
          call(`g-${name}`, name, {
            ...(needsPath ? { path: "in-root.txt" } : {}),
            __auditNonce: `${name}-${before}-${prompts}`,
          }),
          {} as never,
        )
        expect(decision, `ASK prompt untuk ${name}`).toBe("deny")
        expect(prompts, `${name} wajib memanggil ask`).toBe(before + 1)
      }
    } finally {
      tty.restore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
