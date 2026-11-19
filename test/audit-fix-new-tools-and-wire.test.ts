// v7.38 — audit-fix: 3 tool baru (git_restore/git_checkout/lsp_rename) + rename
// wire (`file`→`path`, `from`/`to`→`path`/`destination`).
//
// Hermetic: tmp dir sendiri, spawner git/stub LSP disuntik; tanpa jaringan,
// tanpa TTY, tanpa commit nyata. Mengunci kontrak keamanan (argv array, jail,
// fail-closed LSP) DAN fakta bahwa tool lain tak berubah perilakunya.

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { computeUnavailableWireTools } from "../src/app/tool-layer.ts"
import * as lspClient from "../src/lsp/client.ts"
import { contractForTool, TOOL_CONTRACTS } from "../src/policy/tool-contract.ts"
import { gitCheckoutTool, gitRestoreTool, setGitSpawnForTest } from "../src/tools/git.ts"
import { allTools } from "../src/tools/index.ts"
import { lspDiagnosticsTool, lspRenameTool } from "../src/tools/lsp.ts"
import { moveFileTool } from "../src/tools/move_file.ts"
import { isolateGitConfigForTests } from "./helpers/isolated-git-config.ts"

// Preflight filter-driver butuh config git terisolasi dari filter LFS/system
// milik mesin operator — pola yang sama dipakai test git lain di repo ini.
isolateGitConfigForTests()

const NEW_TOOLS = ["git_restore", "git_checkout", "lsp_rename"] as const
const LSP_PATH_TOOLS = [
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_symbols",
  "lsp_rename",
] as const

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "audit-newtools-"))
  dirs.push(d)
  return d
}
const ctx = (cwd: string, signal?: AbortSignal) =>
  ({ cwd, signal: signal ?? new AbortController().signal }) as never

beforeEach(() => {
  lspClient.clearLspServers()
})
afterEach(() => {
  setGitSpawnForTest(null)
  mock.restore()
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

function toolNamed(name: string) {
  const t = allTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} tak terdaftar`)
  return t
}
const propsOf = (t: (typeof allTools)[number]) =>
  t.parameters.properties as Record<string, { type?: string; description?: string }>

// ── A: registrasi & kontrak ──────────────────────────────────────────────────

test("3 tool baru terdaftar tepat sekali di allTools DAN TOOL_CONTRACTS", () => {
  expect(allTools).toHaveLength(41)
  expect(TOOL_CONTRACTS).toHaveLength(allTools.length)
  expect(new Set(allTools.map((t) => t.name)).size).toBe(allTools.length)
  for (const name of NEW_TOOLS) {
    expect(allTools.filter((t) => t.name === name)).toHaveLength(1)
    expect(TOOL_CONTRACTS.filter((c) => c.name === name)).toHaveLength(1)
    const c = contractForTool(name)!
    expect(c.sideEffectTier).toBe("WORKSPACE_MUTATION")
    expect(c.jailTarget).toBe("file")
    expect(c.gatedByDefault).toBe(true)
    expect(c.journalMutation).toBe(true)
    // family tag jujur di wire description.
    expect(toolNamed(name).description).toMatch(/^(GIT WRITE|LSP):/)
  }
})

test("wire capability: lsp_rename disembunyikan saat tak ada server LSP", () => {
  const hidden = computeUnavailableWireTools({ mcpServers: [], lspServers: [] })
  expect(hidden.has("lsp_rename")).toBe(true)
  const shown = computeUnavailableWireTools({
    mcpServers: [],
    lspServers: [{ ext: ".ts", command: "tsls", args: [] }],
  })
  expect(shown.has("lsp_rename")).toBe(false)
})

// ── B: git tools — argv array & jail ─────────────────────────────────────────

interface SpawnCall {
  args: string[]
  cwd: string | undefined
}

/** Argumen git "nyata" (abaikan probe `isGitRepo`). */
function realCalls(calls: SpawnCall[]): SpawnCall[] {
  return calls.filter((c) => !c.args.includes("--is-inside-work-tree"))
}

/** Spawner palsu: merekam argv, lalu tutup dengan exit 0. */
function captureGit(calls: SpawnCall[]): void {
  setGitSpawnForTest(((_cmd: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ args: [...args], cwd: opts.cwd })
    const p = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    p.kill = () => {}
    queueMicrotask(() => {
      // isGitRepo memanggil rev-parse; tanpa "true" tool berhenti lebih awal
      // dan argv restore/checkout tak pernah terbangun.
      if (args.includes("--is-inside-work-tree")) p.stdout.emit("data", Buffer.from("true\n"))
      p.emit("close", 0)
    })
    return p
  }) as never)
}

test("git_restore/git_checkout membuild argv ARRAY, `--` memisahkan path", async () => {
  const root = tmp()
  const calls: SpawnCall[] = []
  captureGit(calls)

  await gitRestoreTool.execute({ path: "a.ts" }, ctx(root))
  expect(realCalls(calls)).toHaveLength(1)
  const restore = realCalls(calls)[0]!.args
  expect(restore).toContain("restore")
  expect(restore.at(-2)).toBe("--")
  expect(restore.at(-1)).toBe("a.ts")

  calls.length = 0
  await gitRestoreTool.execute({ path: "a.ts", staged: true, ref: "HEAD~1" }, ctx(root))
  const staged = realCalls(calls)[0]!.args
  expect(staged).toContain("--staged")
  expect(staged).toContain("--source=HEAD~1")
  expect(staged.at(-2)).toBe("--")

  calls.length = 0
  await gitCheckoutTool.execute({ path: "a.ts" }, ctx(root))
  const checkout = realCalls(calls)[0]!.args
  expect(checkout).toContain("checkout")
  expect(checkout.at(-2)).toBe("--")
  expect(checkout.at(-1)).toBe("a.ts")
  // TIDAK ada branch switching / force, sesuai deskripsi kontrak.
  expect(checkout).not.toContain("-f")
  expect(checkout).not.toContain("--force")
})

test("git tools menolak path luar root & ref berawalan '-' (fail-closed)", async () => {
  const root = tmp()
  const calls: SpawnCall[] = []
  captureGit(calls)
  await expect(gitRestoreTool.execute({ path: "../evil.txt" }, ctx(root))).rejects.toThrow(
    /outside/,
  )
  await expect(gitCheckoutTool.execute({ path: "../evil.txt" }, ctx(root))).rejects.toThrow(
    /outside/,
  )
  await expect(
    gitRestoreTool.execute({ path: "a.ts", ref: "--upload-pack=evil" }, ctx(root)),
  ).rejects.toThrow(/must not start/)
  // Tak ada spawn sama sekali untuk input yang ditolak.
  expect(calls).toHaveLength(0)
})

test("git tools mengirim path ber-metakarakter sebagai SATU argumen (tanpa shell)", async () => {
  const root = tmp()
  const calls: SpawnCall[] = []
  captureGit(calls)
  const tricky = "a; touch pwned.txt"
  await gitCheckoutTool.execute({ path: tricky }, ctx(root))
  const argv = realCalls(calls)[0]!.args
  expect(argv.at(-1)).toBe(tricky)
  // Tag `;` dan spasi tetap dalam satu elemen argv — bukan dipecah shell.
  expect(argv.filter((a) => a === "touch")).toHaveLength(0)
})

// ── C: lsp_rename fail-closed ────────────────────────────────────────────────

test("lsp_rename melempar isError saat tak ada server / tanpa WorkspaceEdit", async () => {
  const root = tmp()
  writeFileSync(join(root, "a.ts"), "const oldName = 1\n")
  // Tanpa server terdaftar → fail-closed, bukan string sukses.
  await expect(
    lspRenameTool.execute({ path: "a.ts", symbol: "oldName", newName: "fresh" }, ctx(root)),
  ).rejects.toThrow(/no LSP servers configured/)

  // Server ada, tapi tak mendukung rename → tetap error, jangan mengarang sukses.
  lspClient.configureServers([{ ext: ".ts", command: "stub", args: [] }])
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  spyOn(lspClient, "lspCall").mockResolvedValue(null)
  await expect(
    lspRenameTool.execute({ path: "a.ts", symbol: "oldName", newName: "fresh" }, ctx(root)),
  ).rejects.toThrow(/WorkspaceEdit|not supported/)
})

test("lsp_rename benar-benar menerapkan WorkspaceEdit (bukan string palsu)", async () => {
  const root = tmp()
  writeFileSync(join(root, "a.ts"), "const oldName = 1\n")
  lspClient.configureServers([{ ext: ".ts", command: "stub", args: [] }])
  spyOn(lspClient, "getConfiguredExts").mockReturnValue([".ts"])
  spyOn(lspClient, "lspCall").mockResolvedValue({
    changes: {
      [pathToFileURL(join(root, "a.ts")).href]: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 },
          },
          newText: "freshName",
        },
      ],
    },
  })
  const out = (await lspRenameTool.execute(
    { path: "a.ts", symbol: "oldName", newName: "freshName" },
    ctx(root),
  )) as string
  expect(out).toContain("renamed")
  expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const freshName = 1\n")
})

// ── D: wire rename assertions ────────────────────────────────────────────────

test("semua tool LSP memakai `path`, bukan `file` (skema + perilaku)", async () => {
  for (const name of LSP_PATH_TOOLS) {
    const p = propsOf(toolNamed(name))
    expect(Object.keys(p), `${name} harus punya path`).toContain("path")
    expect(Object.keys(p), `${name} tak boleh punya file`).not.toContain("file")
    expect(toolNamed(name).parameters.required).toContain("path")
  }
  const ws = toolNamed("lsp_workspace_symbols")
  expect(Object.keys(propsOf(ws))).not.toContain("file")

  // Call-site: `file` kini diabaikan → readTarget gagal (isError), `path` diterima.
  const root = tmp()
  writeFileSync(join(root, "a.ts"), "const a = 1\n")
  spyOn(lspClient, "lspDiagnostics").mockResolvedValue({ uri: "file:///a.ts", items: [] })
  await expect(lspDiagnosticsTool.execute({ path: "a.ts" }, ctx(root))).resolves.toContain(
    "(no diagnostics)",
  )
  await expect(lspDiagnosticsTool.execute({ file: "a.ts" }, ctx(root))).rejects.toThrow()
})

test("move_file menerima path/destination dan TIDAK lagi from/to", async () => {
  const t = toolNamed("move_file")
  expect(Object.keys(propsOf(t)).sort()).toEqual(["destination", "path"])
  expect(t.parameters.required).toEqual(["path", "destination"])
  const root = tmp()
  writeFileSync(join(root, "a.txt"), "isi")
  const out = (await moveFileTool.execute(
    { path: "a.txt", destination: "sub/b.txt" },
    ctx(root),
  )) as string
  expect(out).toContain("moved a.txt -> sub/b.txt")
  expect(readFileSync(join(root, "sub", "b.txt"), "utf8")).toBe("isi")
})

test("tool lain tak regresi: jumlah & nama kontrak sinkron dengan registry", () => {
  expect(new Set(TOOL_CONTRACTS.map((c) => c.name))).toEqual(new Set(allTools.map((t) => t.name)))
  expect(contractForTool("write_file")?.sideEffectTier).toBe("WORKSPACE_MUTATION")
  expect(contractForTool("read_file")?.sideEffectTier).toBe("PURE_READ")
  expect(contractForTool("git_commit")?.gatedByDefault).toBe(true)
  expect(contractForTool("unknown_tool")).toBeUndefined()
})
