// Audit finding 4: mcp_call menangkap Error "MCP tool …" (dari hasil isError
// server) lalu mengembalikannya sebagai string `[mcp] error: …`, sehingga
// isError tetap false dan model mengira panggilan berhasil. Regresi: error
// harus dilempar agar runCall menandai kegagalan; outcome-unknown tetap dilempar.
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as mcpClient from "../src/mcp/client.ts"
import { McpCallOutcomeUnknownError } from "../src/mcp/client.ts"
import { mcpCallTool } from "../src/tools/mcp_call.ts"

afterEach(() => mock.restore())

const ctx = () => ({ signal: new AbortController().signal }) as never

test("mcp_call melempar error isError MCP (bukan string sukses)", async () => {
  spyOn(mcpClient, "getMcpServerIds").mockReturnValue(["srv"])
  spyOn(mcpClient, "callMcpTool").mockRejectedValue(new Error("MCP tool boom: something failed"))

  let thrown: unknown
  try {
    await mcpCallTool.execute({ server: "srv", tool: "boom", args: {} }, ctx())
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeTruthy()
  expect((thrown as Error).message).toContain("something failed")
})

test("McpCallOutcomeUnknownError tetap dilempar apa adanya (perlakuan khusus)", async () => {
  spyOn(mcpClient, "getMcpServerIds").mockReturnValue(["srv"])
  const unknown = new McpCallOutcomeUnknownError("boom", new Error("transport mati"))
  spyOn(mcpClient, "callMcpTool").mockRejectedValue(unknown)

  let thrown: unknown
  try {
    await mcpCallTool.execute({ server: "srv", tool: "boom" }, ctx())
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBe(unknown)
})
