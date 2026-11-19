// Regresi audit: webSearchTool terdaftar di allTools tetapi tidak diekspor
// dari barrel. Ini juga test compile-level — import akan gagal bila export
// hilang.
import { expect, test } from "bun:test"
import * as barrel from "../src/tools/index.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

test("webSearchTool tersedia dari barrel src/tools/index.ts", () => {
  expect(barrel.webSearchTool).toBe(webSearchTool)
  expect(webSearchTool.name).toBe("web_search")
  expect(barrel.allTools.some((t) => t.name === "web_search")).toBe(true)
})
