export { askUserTool } from "./ask_user.ts"
export { bashKillTool, bashOutputTool, bashTool } from "./bash.ts"
export { codeRunTool } from "./code_run.ts"
export { deleteFileTool } from "./delete_file.ts"
export { depGraphTool } from "./dep_graph.ts"
export { editTool } from "./edit.ts"
export {
  gitCheckoutTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPushTool,
  gitRestoreTool,
  gitStatusTool,
} from "./git.ts"
export { globTool } from "./glob.ts"
export { grepTool } from "./grep.ts"
export {
  lspDefinitionTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspReferencesTool,
  lspRenameTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
} from "./lsp.ts"
export { mcpCallTool, mcpListTool, mcpPromptTool, mcpReadTool } from "./mcp_call.ts"
export { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "./memory.ts"
export { moveFileTool } from "./move_file.ts"
export { applyPatchTool } from "./patch.ts"
export { readFileTool } from "./read_file.ts"
export { readImageTool } from "./read_image.ts"
export { submitResultTool } from "./submit_result.ts"
export { delegateTaskTool } from "./task.ts"
export { todoReadTool, todoSession, todoWriteTool } from "./todo.ts"
export { webFetchTool } from "./web_fetch.ts"
export { webSearchTool } from "./web_search.ts"
export { writeFileTool } from "./write_file.ts"

import type { Tool } from "#minicore"
import { askUserTool } from "./ask_user.ts"
import { bashKillTool, bashOutputTool, bashTool } from "./bash.ts"
import { codeRunTool } from "./code_run.ts"
import { deleteFileTool } from "./delete_file.ts"
import { depGraphTool } from "./dep_graph.ts"
import { editTool } from "./edit.ts"
import {
  gitCheckoutTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitPushTool,
  gitRestoreTool,
  gitStatusTool,
} from "./git.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import {
  lspDefinitionTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspReferencesTool,
  lspRenameTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
} from "./lsp.ts"
import { mcpCallTool, mcpListTool, mcpPromptTool, mcpReadTool } from "./mcp_call.ts"
import { forgetMemoryTool, readMemoryTool, writeMemoryTool } from "./memory.ts"
import { moveFileTool } from "./move_file.ts"
import { applyPatchTool } from "./patch.ts"
import { readFileTool } from "./read_file.ts"
import { readImageTool } from "./read_image.ts"
import { submitResultTool } from "./submit_result.ts"
import { delegateTaskTool } from "./task.ts"
import { todoReadTool, todoWriteTool } from "./todo.ts"
import { webFetchTool } from "./web_fetch.ts"
import { webSearchTool } from "./web_search.ts"
import { writeFileTool } from "./write_file.ts"

const LABEL_SCHEMA = {
  type: "string" as const,
  description:
    "optional short human-readable progress label in the user's language (e.g. 'Pengetesan gate sebagian')",
}

/** Tool ber-intent terbuka yang menerima argumen opsional `label` dari model.
 *  Tool sederhana (read_file, edit, grep, git_*, dll.) tidak perlu `label` di
 *  schema karena UI menghasilkan nama manusiawi otomatis dari argumennya
 *  (menghemat ~1000 token definisi tool per request). */
const OPEN_INTENT_LABEL_TOOLS = new Set(["bash", "code_run", "web_search", "web_fetch"])

/**
 * Suntikkan field opsional `label` hanya pada tool ber-intent terbuka & MCP
 * agar tetap lolos `additionalProperties: false`, lalu kupas sebelum diteruskan
 * ke `execute()` asli.
 */
function withActivityLabel(tool: Tool, force = false): Tool {
  if (!force && !OPEN_INTENT_LABEL_TOOLS.has(tool.name)) return tool
  const params = tool.parameters
  const props = params?.properties
  if (!props || "label" in props) return tool
  return {
    ...tool,
    parameters: {
      ...params,
      properties: {
        ...props,
        label: LABEL_SCHEMA,
      },
    },
    async execute(input, ctx) {
      if (input && typeof input === "object" && !Array.isArray(input) && "label" in input) {
        const { label: _ignored, ...rest } = input as Record<string, unknown>
        return tool.execute(rest, ctx)
      }
      return tool.execute(input, ctx)
    },
  }
}

export const allTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editTool,
  applyPatchTool,
  globTool,
  grepTool,
  depGraphTool,
  bashTool,
  bashOutputTool,
  bashKillTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitPushTool,
  gitRestoreTool,
  gitCheckoutTool,
  webFetchTool,
  webSearchTool,
  readMemoryTool,
  writeMemoryTool,
  forgetMemoryTool,
  todoWriteTool,
  todoReadTool,
  delegateTaskTool,
  mcpListTool,
  mcpCallTool,
  mcpReadTool,
  mcpPromptTool,
  lspDiagnosticsTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspHoverTool,
  lspSymbolsTool,
  lspWorkspaceSymbolsTool,
  lspRenameTool,
  moveFileTool,
  deleteFileTool,
  readImageTool,
  codeRunTool,
  submitResultTool,
  askUserTool,
].map((tool) => withActivityLabel(tool))

// MCP server tools (prefixed "serverid.toolname") di-append runtime via connectAll()
export function withMcpTools(base: Tool[], mcpTools: Tool[]): Tool[] {
  const seen = new Set(base.map((t) => t.name))
  return [
    ...base,
    ...mcpTools.filter((t) => !seen.has(t.name)).map((t) => withActivityLabel(t, true)),
  ]
}
