// E-24: pinMany menyimpan SATU persist per discover; drift tetap terdeteksi
// dan jalur verify() biasa (fail-open pin pertama) tidak berubah.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __setMcpPinPersistProbeForTest,
  computeMcpToolSchemaHash,
  McpSchemaPinRegistry,
} from "../src/mcp/client.ts"

const dirs: string[] = []
afterEach(() => {
  __setMcpPinPersistProbeForTest(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-mcp-pin-"))
  dirs.push(d)
  return join(d, "pins.json")
}

function tool(name: string, description = "desc") {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  }
}

test("pinMany N tool → tepat 1 persist; urutan & hash kanonik benar", () => {
  const path = tmpPath()
  const reg = new McpSchemaPinRegistry()
  reg.configure(path)
  let persists = 0
  __setMcpPinPersistProbeForTest(() => persists++)

  const tools = Array.from({ length: 8 }, (_, i) => tool(`t${i}`))
  const verdicts = reg.pinMany(
    tools.map((t) => ({ serverId: "srv", toolName: t.name, hash: computeMcpToolSchemaHash(t) })),
  )
  expect(verdicts).toEqual(Array(8).fill("pinned"))
  expect(persists).toBe(1)

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>
  expect(Object.keys(onDisk).length).toBe(8)
  for (const t of tools) expect(onDisk[`srv:${t.name}`]).toBe(computeMcpToolSchemaHash(t))

  __setMcpPinPersistProbeForTest(null)
  expect(reg.list().length).toBe(8)
})

test("pinMany tidak menimpa pin lama; drift tetap terdeteksi", () => {
  const path = tmpPath()
  const first = new McpSchemaPinRegistry()
  first.configure(path)
  first.pin("srv", "t0", computeMcpToolSchemaHash(tool("t0")))
  const original = computeMcpToolSchemaHash(tool("t0"))

  const second = new McpSchemaPinRegistry()
  second.configure(path)
  const changed = tool("t0", "DESKRIPSI BARU")
  const verdicts = second.pinMany([
    { serverId: "srv", toolName: "t0", hash: computeMcpToolSchemaHash(changed) },
  ])
  expect(verdicts).toEqual(["drift"]) // hash lama menang, tidak ditimpa
  expect(second.getPin("srv", "t0")).toBe(original)

  // Jalur execute (verify) tetap fail-closed saat skema benar-benar drift.
  second.approveMcpSchemaUpdate("srv", "t0", original)
  expect(second.verify("srv", "t0", computeMcpToolSchemaHash(changed))).toBe("drift")
})
