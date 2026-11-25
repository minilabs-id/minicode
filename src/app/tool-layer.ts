import type { Tool } from "#minicore"
import type { MinicodeConfig } from "../config.ts"
import { configureServers as lspConfigure } from "../lsp/client.ts"
import { connectAll as mcpConnectAll } from "../mcp/client.ts"
import {
  EXPLORE_TOOL_NAMES,
  GATED_TOOLS,
  PLAN_EXTRA_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "../policy/tool-contract.ts"
import { isMcpToolName } from "../presentation/label.ts"
import type { CanonicalScope } from "../session/verification.ts"
import { createBashJobTools } from "../tools/bash.ts"
import { withEvidence } from "../tools/evidence.ts"
import { allTools, withMcpTools } from "../tools/index.ts"
import { createWriteMemoryTool } from "../tools/memory.ts"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Pemilik visibilitas tool mengekspos redaksi "tool disembunyikan mode" supaya
// executor bisa memberi pesan actionable. Logikanya tetap SATU di
// tool-contract.ts (sumber yang sama dengan `workModeVisible` di bawah), jadi
// tak ada daftar kedua yang bisa drift. Tidak mengubah izin/WorkMode.
export { hiddenBuiltinToolMessage } from "../policy/tool-contract.ts"

export type ToolScope = "full" | "explore"

const MCP_WIRE_TOOLS = ["mcp_list", "mcp_call", "mcp_read", "mcp_prompt"] as const
const LSP_WIRE_TOOLS = [
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_symbols",
  "lsp_workspace_symbols",
  // v7.38: rename juga butuh server; sembunyikan dari wire saat LSP kosong
  // (wireCapability hiding), sama seperti tool LSP baca.
  "lsp_rename",
] as const

/**
 * Daftar tool yang skemanya aman disembunyikan dari wire API ketika kapabilitas
 * runtime-nya tidak aktif (MCP/LSP kosong, sandbox none, atau non-interaktif),
 * agar token prompt awal hemat tanpa mengubah registry izin/WorkMode kanonik.
 */
export function computeUnavailableWireTools(
  cfg: Pick<MinicodeConfig, "mcpServers" | "lspServers">,
  opts: { sandboxMode?: string; interactiveAsk?: boolean } = {},
): Set<string> {
  const hidden = new Set<string>()
  if (!cfg.mcpServers?.length) for (const n of MCP_WIRE_TOOLS) hidden.add(n)
  if (!cfg.lspServers?.length) for (const n of LSP_WIRE_TOOLS) hidden.add(n)
  if (!opts.sandboxMode || opts.sandboxMode === "none") hidden.add("code_run")
  if (opts.interactiveAsk === false) hidden.add("ask_user")
  return hidden
}

// WorkMode ceiling (DISCUSS menyatukan diskusi + perencanaan; EXECUTE = BUILD).
// Invariant INV-WM1 & #7: WorkMode TIDAK PERNAH memperluas akses; `visible`
// diselaraskan penuh dengan `callable` di handler:
// - DISCUSS: 18 `READONLY_TOOL_NAMES` (16 lokal + 2 network read ber-approval) +
//   `PLAN_EXTRA` (kecuali bila `permissionMode` adalah `readonly`/`allowlist`
//   yang ceiling-nya `readonly`).
// - EXECUTE: tanpa ceiling WorkMode tambahan; mengikuti `permissionMode`.
export function workModeVisible(
  name: string,
  workMode: "DISCUSS" | "EXECUTE",
  permissionMode?: string,
): boolean {
  const wm = workMode === "EXECUTE" ? "EXECUTE" : "DISCUSS"
  if (isMcpToolName(name)) {
    // [AGENT-CONTROL-3] Handler `allowlist` menolak SEMUA tool gated/MCP
    // (permission.ts: `isGated → deny`). Menampilkannya di wire hanya membuat
    // model membuang langkah mencoba tool yang pasti ditolak — sembunyikan.
    return (
      wm === "EXECUTE" &&
      permissionMode !== "readonly" &&
      permissionMode !== "plan" &&
      permissionMode !== "allowlist"
    )
  }
  if (wm === "DISCUSS") {
    if (permissionMode === "readonly" || permissionMode === "allowlist") {
      return READONLY_TOOL_NAMES.has(name)
    }
    return READONLY_TOOL_NAMES.has(name) || PLAN_EXTRA_TOOL_NAMES.has(name)
  }
  // EXECUTE = tanpa ceiling WorkMode tambahan; hormati filter PermissionMode.
  if (permissionMode === "readonly") return READONLY_TOOL_NAMES.has(name)
  if (permissionMode === "plan")
    return READONLY_TOOL_NAMES.has(name) || PLAN_EXTRA_TOOL_NAMES.has(name)
  // [AGENT-CONTROL-3] `allowlist` mem-blokir GATED_TOOLS di permission handler;
  // jangan tampilkan tool yang tak mungkin bisa dipanggil (visible === callable).
  // `code_run` juga selalu ditolak handler allowlist (butuh sandbox, dan bukan
  // termasuk FILE/INTERNAL/READONLY), jadi sembunyikan bersama gated/MCP — kalau
  // tidak, model membuang langkah mencoba tool yang pasti deny.
  if (permissionMode === "allowlist") return !GATED_TOOLS.has(name) && name !== "code_run"
  // v7.40 (audit): di EXECUTE × `auto`, `ask_user` masih dikirim di wire tetapi
  // handler permission AUTO menolaknya deterministik (permission.ts:1064).
  // visible ≠ callable — sembunyikan agar model tak membuang langkah mencoba
  // tool yang pasti deny. Hiding headless (interactiveAsk:false) TETAP di
  // computeUnavailableWireTools; jangan campur atau hapus di sini.
  if (name === "ask_user" && permissionMode === "auto") return false
  return true
}

export function applyWorkModeFilter<T extends Tool>(
  tools: readonly T[],
  workMode: "DISCUSS" | "EXECUTE",
  permissionMode?: string,
): T[] {
  return tools.filter((t) => workModeVisible(t.name, workMode, permissionMode))
}

export type ToolEvidenceMode = "events" | "canonical"

export async function setupToolLayer(
  cfg: MinicodeConfig,
  scope: ToolScope = "full",
  permissionMode?: string,
  verification?: CanonicalScope,
  jobOwnerSid?: string,
  workMode: "DISCUSS" | "EXECUTE" = "EXECUTE",
  cwd?: string,
): Promise<{
  sessionTools: Tool[]
  evidenceMode: ToolEvidenceMode
  /** P12 S2.2 Slice 5 - set WorkMode runtime (visibilitas tool). */
  setWorkMode?: (m: "DISCUSS" | "EXECUTE") => void
  /** P0.2 - set PermissionMode runtime agar visibilitas tetap sinkron saat /mode atau Shift+Tab. */
  setPermissionMode?: (pm: string) => void
}> {
  let sessionTools: Tool[] = allTools
  if (jobOwnerSid) {
    sessionTools = sessionTools.map((tool) =>
      tool.name === "write_memory" ? createWriteMemoryTool(jobOwnerSid) : tool,
    )
  }
  // Harness-P2: scope explore = subset read-only sub-agen (tetap 12 EXPLORE_TOOL_NAMES).
  if (scope === "explore")
    sessionTools = allTools.filter((t) => EXPLORE_TOOL_NAMES.includes(t.name))
  // F-03 (P5 §C2): background bash job diikat ke sid kanonik sesi ini.
  // Rebind dilakukan pada kandidat penuh sebelum filter mode supaya transisi
  // runtime DISCUSS/PLAN/readonly → EXECUTE tetap mendapat bash terikat sid.
  if (jobOwnerSid) {
    const owned = createBashJobTools(jobOwnerSid)
    const rebind = new Map<string, Tool>([
      ["bash", owned.bash],
      ["bash_output", owned.bashOutput],
      ["bash_kill", owned.bashKill],
    ])
    sessionTools = sessionTools.map((t) => rebind.get(t.name) ?? t)
  }
  try {
    if (cfg.mcpServers?.length && scope !== "explore") {
      // P2.3: bawa cwd agar pin skema tersimpan per-workspace.
      const mcpTools = await mcpConnectAll(cfg.mcpServers, cwd)
      if (mcpTools.length) {
        sessionTools = withMcpTools(sessionTools, mcpTools)
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] init failed: ${errMsg(e)}\n`)
  }
  try {
    if (cfg.lspServers?.length) lspConfigure(cfg.lspServers)
  } catch (e) {
    process.stderr.write(`[lsp] init failed: ${errMsg(e)}\n`)
  }
  if (verification) {
    // P2.10 canonical coverage: one awaited intent/receipt pair per covered
    // registry invocation. Special paths keep their explicit instrumentation.
    sessionTools = sessionTools.map((tool) => withEvidence(tool, verification))
  }
  // P12 S2.2 + P0.2 - visibilitas tool runtime (sinkron terhadap WorkMode DAN
  // PermissionMode). `parallelExecutor` meresolusi `registry.get(name)` dari
  // `list()` yang sama sehingga `callable === visible` di kedua arah transisi.
  const candidates = sessionTools
  let currentWm: "DISCUSS" | "EXECUTE" = workMode
  let currentPm: string | undefined = permissionMode
  const computeVisible = (wm: "DISCUSS" | "EXECUTE", pm?: string): Tool[] => {
    if (scope === "explore") {
      // Scope explore sudah dibatasi ke EXPLORE_TOOL_NAMES; tetap terapkan irisan WorkMode.
      return applyWorkModeFilter(candidates, wm, pm)
    }
    return applyWorkModeFilter(candidates, wm, pm)
  }
  // Array LIVE: identitas objek ini yang dipegang kernel.
  const visible: Tool[] = computeVisible(currentWm, currentPm)
  const syncVisible = (): void => {
    const next = computeVisible(currentWm, currentPm)
    visible.length = 0
    visible.push(...next)
  }
  const setWorkMode = (wm: "DISCUSS" | "EXECUTE"): void => {
    currentWm = wm
    syncVisible()
  }
  const setPermissionMode = (pm: string): void => {
    currentPm = pm
    syncVisible()
  }
  return {
    sessionTools: visible,
    evidenceMode: verification ? "canonical" : "events",
    setWorkMode,
    setPermissionMode,
  }
}
