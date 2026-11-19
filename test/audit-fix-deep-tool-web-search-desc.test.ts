// Audit finding 6: deskripsi web_search mengklaim "Uses web_fetch under the
// hood with SSRF guard", padahal ia memakai fetch global ke endpoint tetap
// (bukan URL arbitrer seperti web_fetch). Klaim itu menyesatkan — diperbaiki dengan
// deskripsi yang jujur; perubahan perilaku tidak diperlukan.
import { expect, test } from "bun:test"
import { webSearchTool } from "../src/tools/web_search.ts"

test("deskripsi web_search tidak lagi mengklaim SSRF guard via web_fetch", () => {
  const desc = webSearchTool.description
  expect(desc.toLowerCase()).not.toContain("ssrf guard")
  expect(desc.toLowerCase()).not.toContain("uses web_fetch under the hood")
  // Penjelasan jujur: endpoint tetap, query bukan URL arbitrer.
  expect(desc).toContain("fixed public search-provider endpoints")
})
