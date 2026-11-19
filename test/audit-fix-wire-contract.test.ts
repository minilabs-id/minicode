// v7.33 — WIRE CONTRACT (tool schema + deskripsi yang dikirim ke model).
//
// Kenapa test ini ada: deskripsi tool adalah "prompt" yang paling sering
// dibaca model. Duplikasi enum, aturan pilih-tool yang melingkar, dan parameter
// path tanpa konteks workspace membuat model membuang langkah atau salah
// memanggil tool. Test ini mengunci perbaikan audit-fix agar tidak regresi.
//
// Hermetic: hanya membaca metadata `allTools` + dua tool search pada direktori
// kosong; tidak spawn proses, tidak jaringan.

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globTool } from "../src/tools/glob.ts"
import { grepTool } from "../src/tools/grep.ts"
import { allTools } from "../src/tools/index.ts"

/**
 * Sembilan tag yang diminta audit ditambah empat tag turunan yang diperlukan
 * supaya semua 41 tools punya grouping jujur:
 *  - GIT WRITE: commit/push mengubah riwayat/remote, bukan operasi baca;
 *  - PLAN: todo = rencana, bukan berkas/memori;
 *  - RESULT: submit_result = kontrak keluaran terstruktur;
 *  - INTERACT: ask_user = interaksi manusia, bukan sub-agent.
 */
const FAMILY_TAGS = [
  "FILE EDIT:",
  "FILE SEARCH:",
  "GIT READ:",
  "GIT WRITE:",
  "SHELL:",
  "WEB:",
  "SUBAGENT:",
  "MEMORY:",
  "MCP:",
  "LSP:",
  "PLAN:",
  "RESULT:",
  "INTERACT:",
] as const

/** Kalimat aturan pilih-tool yang HARUS identik di edit/apply_patch/write_file. */
const DECISION_RULE =
  "1 change → edit; ≥2 changes in one file → apply_patch; full rewrite/new file → write_file. Every search block must match exactly once — add surrounding lines if ambiguous."

/** Nama parameter yang mengalamatkan berkas (bukan `cwd` yang berupa direktori). */
const PATH_LIKE_PARAMS = ["path", "file", "from", "to", "destination"] as const

/** Panjang deskripsi bash SEBELUM pemangkasan audit (diukur 2026-11-18). */
const ORIGINAL_BASH_DESC_CHARS = 709

type Props = Record<string, { description?: string; enum?: readonly unknown[] }>
function propertiesOf(tool: (typeof allTools)[number]): Props {
  return (tool.parameters.properties ?? {}) as Props
}
const toolNamed = (name: string) => allTools.find((t) => t.name === name)

const dirs: string[] = []
function emptyDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wire-contract-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

test("setiap deskripsi tool diawali family tag", () => {
  // 41 = semua tool registry (38 lama + git_restore/git_checkout/lsp_rename);
  // jangan diam-diam bertambah tanpa tag.
  expect(allTools).toHaveLength(41)
  for (const tool of allTools) {
    expect(
      FAMILY_TAGS.some((tag) => tool.description.startsWith(tag)),
      `${tool.name}: "${tool.description.slice(0, 60)}…"`,
    ).toBe(true)
  }
})

test("parameter path-like punya deskripsi yang menyebut workspace", () => {
  for (const tool of allTools) {
    const props = propertiesOf(tool)
    for (const name of PATH_LIKE_PARAMS) {
      const p = props[name]
      if (!p) continue
      // v7.38: move_file kini `path`/`destination` deskripsinya tetap wajib
      // menyebut "workspace" (konvensi path-like yang seragam).
      expect(
        typeof p.description === "string" && p.description.toLowerCase().includes("workspace"),
        `${tool.name}.${name}: ${p.description}`,
      ).toBe(true)
    }
  }
})

test("deskripsi tool tidak mengulang seluruh nilai enum parameter sendiri", () => {
  for (const tool of allTools) {
    for (const p of Object.values(propertiesOf(tool))) {
      const values = p.enum
      // Enum 2 nilai (mode/lang) terlalu pendek untuk disebut "duplikasi".
      if (!values || values.length < 3 || !values.every((v) => typeof v === "string")) continue
      const restated = (values as string[]).every((v) => tool.description.includes(v))
      expect(restated, `${tool.name}: ${JSON.stringify(values)}`).toBe(false)
    }
  }
})

test("edit / apply_patch / write_file memakai satu aturan keputusan yang identik", () => {
  for (const name of ["edit", "apply_patch", "write_file"]) {
    const tool = toolNamed(name)
    expect(tool, `tool ${name} harus ada`).toBeDefined()
    expect(tool!.description.includes(DECISION_RULE), `${name} tidak memuat aturan identik`).toBe(
      true,
    )
  }
  // Nasihat lama yang melingkar tidak boleh muncul lagi.
  for (const [name, stale] of [
    ["edit", "Prefer edit for small"],
    ["apply_patch", "Prefer for multiple changes"],
    ["write_file", "Prefer edit for small"],
  ] as const) {
    expect(toolNamed(name)!.description).not.toContain(stale)
  }
})

test("deskripsi bash lebih pendek dari 60% deskripsi lama", () => {
  const bash = toolNamed("bash")!
  expect(bash.description.length).toBeLessThan(ORIGINAL_BASH_DESC_CHARS * 0.6)
  // Petunjuk penting yang TIDAK boleh hilang walau dipangkas.
  expect(bash.description).toContain("do NOT retry blindly")
  expect(bash.description).toMatch(/git_status|git_diff/)
  // Hint Windows dipindah ke parameter `cmd`, bukan deskripsi utama.
  expect(bash.description).not.toContain("cmd.exe")
  expect(propertiesOf(bash).cmd?.description).toContain("cmd.exe")
})

test("web_search: deskripsi ringkas + alias dideklarasikan di enum", () => {
  const ws = toolNamed("web_search")!
  expect(ws.description.length).toBeLessThan(200)
  const values = (propertiesOf(ws).source?.enum ?? []) as string[]
  for (const alias of ["so", "issues", "grepapp"]) expect(values).toContain(alias)
  // Satu sumber nilai: deskripsi tidak lagi membocorkan daftar provider.
  expect(ws.description).not.toContain("Tavily/Brave")
})

test("hasil kosong grep/glob memberi langkah lanjutan", async () => {
  const dir = emptyDir()
  const ctx = { signal: new AbortController().signal, cwd: dir, emit: () => {} } as never
  const noMatch = (await grepTool.execute({ pattern: "somethingAbsent" }, ctx)) as string
  expect(noMatch).toContain("no matches")
  expect(noMatch).toContain("broaden pattern or drop include")

  const noFiles = (await globTool.execute({ pattern: "**/*.xyz" }, ctx)) as string
  expect(noFiles).toContain("no files match")
  expect(noFiles).toContain("verify pattern and cwd")
})
