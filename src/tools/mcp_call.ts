import type { Tool } from "#minicore"
import {
  callMcpTool,
  capMcpText,
  extractMcpText,
  getMcpPrompt,
  getMcpServerIds,
  McpCallOutcomeUnknownError,
  mcpInventory,
  readMcpResource,
} from "../mcp/client.ts"
import { fenceUntrustedToolOutput, isAlreadyFenced } from "../policy/scrub.ts"

export const mcpListTool: Tool = {
  name: "mcp_list",
  // v7.33 (wire contract): tag MCP.
  description:
    "MCP: List connected MCP servers with their tools, resources and prompts. Call this first, before mcp_call / mcp_read / mcp_prompt.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx) {
    ctx.signal.throwIfAborted()
    const inv = mcpInventory()
    if (inv.length === 0) return "(no MCP servers connected — add one via minicode config mcp add)"
    const lines: string[] = []
    for (const s of inv) {
      lines.push(
        `# ${s.id} (${s.kind}) — ${s.tools.length} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`,
      )
      for (const t of s.tools)
        lines.push(`  tool     ${t.name}${t.description ? `: ${t.description.slice(0, 110)}` : ""}`)
      for (const r of s.resources)
        lines.push(
          `  resource ${r.uri}${r.name ? ` (${r.name})` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}`,
        )
      for (const p of s.prompts) {
        const args = (p.arguments ?? []).map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")
        lines.push(
          `  prompt   ${p.name}${args ? `(${args})` : ""}${p.description ? `: ${p.description.slice(0, 90)}` : ""}`,
        )
      }
    }
    return lines.join("\n")
  },
}

export const mcpCallTool: Tool = {
  name: "mcp_call",
  // v7.33 (wire contract): tag MCP; hapus "Parameters: ..." (sudah ada di
  // schema). Pagar "OUTSIDE minicode policy" + outcome-unknown dipertahankan.
  description:
    "MCP: Call a tool on a connected MCP server (server, tool, args). The server runs OUTSIDE minicode policy — one approval covers one server+tool+args call only. If transport aborts after dispatch the outcome is unknown; inspect remote state before retrying.",
  parameters: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server ID (see mcp_list)",
      },
      tool: {
        type: "string",
        description: "Name of the tool to call",
      },
      args: {
        type: "object",
        description: "Arguments for the tool (key-value object)",
        additionalProperties: true,
      },
    },
    required: ["server", "tool"],
    additionalProperties: false,
  },
  async execute({ server, tool, args }, ctx) {
    const sid = server as string
    const tn = tool as string
    const a = (args as Record<string, unknown>) ?? {}

    ctx.signal.throwIfAborted()

    const ids = getMcpServerIds()
    // v7.32: server tak terdaftar = kegagalan. Dulu return string → kernel
    // menandai isError=false; notConnected() kini melempar (lihat bawah).
    if (!ids.includes(sid)) notConnected(sid)

    try {
      const result = await callMcpTool(sid, tn, a, ctx.signal)
      const content = extractMcpText(result)
      const capped = capMcpText(content)
      return isAlreadyFenced(capped)
        ? capped
        : fenceUntrustedToolOutput(`mcp_call:${sid}.${tn}`, capped)
    } catch (e) {
      // Mulanya semua error (termasuk isError=true dari server, yang diterjemah
      // client menjadi Error "MCP tool …") DIKEMBALIKAN sebagai string sukses
      // `[mcp] error: …`. Akibatnya kernel menandai isError=false dan model
      // mengira panggilan berhasil. Lempar kembali supaya runCall menandai
      // kegagalan dengan benar. McpCallOutcomeUnknownError dicek PERTAMA:
      // perlakuan khususnya (pesan outcome unknown) tetap menang walaupun
      // signal gugur bersamaan — baru setelah itu cek abort, lalu error biasa.
      if (e instanceof McpCallOutcomeUnknownError) throw e
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}

/**
 * Server tak terdaftar = kegagalan, BUKAN hasil. v7.32: versi lama
 * mengembalikan string `[mcp] … is not connected` yang dibaca kernel sebagai
 * sukses (isError=false) — jadi lemparkan Error supaya runCall menandai
 * kegagalan dengan benar. Tidak ada `return` di sini (return type `never`).
 */
function notConnected(sid: string): never {
  const ids = getMcpServerIds()
  throw new Error(
    `[mcp] server '${sid}' is not connected. Registered servers: ${ids.join(", ") || "(none)"}`,
  )
}

export const mcpReadTool: Tool = {
  name: "mcp_read",
  // v7.33 (wire contract): tag MCP.
  description:
    "MCP: Read a resource (resources/read) from a connected MCP server; get URIs from mcp_list. Read-only.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP server ID" },
      uri: { type: "string", description: "Resource URI, e.g. file:///x or db://table" },
    },
    required: ["server", "uri"],
    additionalProperties: false,
  },
  async execute({ server, uri }, ctx) {
    ctx.signal.throwIfAborted()
    const sid = String(server ?? "")
    const u = String(uri ?? "").trim()
    if (!u) throw new Error("uri is required")
    if (!getMcpServerIds().includes(sid)) notConnected(sid)
    try {
      const text = await readMcpResource(sid, u, ctx.signal)
      if (!text) return `[mcp] resource '${u}' is empty or returned no text`
      const capped = capMcpText(text)
      return isAlreadyFenced(capped) ? capped : fenceUntrustedToolOutput(`mcp_read:${sid}`, capped)
    } catch (e) {
      // v7.31: samakan dengan mcp_call — error wajib dilempar supaya kernel
      // menandai isError. Mengembalikan string membuat tool.failed tampil
      // sebagai tool.completed di ledger.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}

export const mcpPromptTool: Tool = {
  name: "mcp_prompt",
  // v7.33 (wire contract): tag MCP.
  description:
    "MCP: Fetch a prompt template from an MCP server (prompts/get); the server renders its args and returns text to use as context.",
  parameters: {
    type: "object",
    properties: {
      server: { type: "string", description: "MCP server ID" },
      name: { type: "string", description: "Prompt name (see mcp_list)" },
      args: {
        type: "object",
        description: "Prompt arguments (key-value object)",
        additionalProperties: true,
      },
    },
    required: ["server", "name"],
    additionalProperties: false,
  },
  async execute({ server, name, args }, ctx) {
    ctx.signal.throwIfAborted()
    const sid = String(server ?? "")
    const pn = String(name ?? "").trim()
    if (!pn) throw new Error("name is required")
    if (!getMcpServerIds().includes(sid)) notConnected(sid)
    try {
      const text = await getMcpPrompt(sid, pn, (args as Record<string, unknown>) ?? {}, ctx.signal)
      if (!text) return `[mcp] prompt '${pn}' returned no message`
      const capped = capMcpText(text)
      return isAlreadyFenced(capped)
        ? capped
        : fenceUntrustedToolOutput(`mcp_prompt:${sid}`, capped)
    } catch (e) {
      // v7.31: samakan dengan mcp_call — error wajib dilempar supaya kernel
      // menandai isError. Mengembalikan string membuat tool.failed tampil
      // sebagai tool.completed di ledger.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}
