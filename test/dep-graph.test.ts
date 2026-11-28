import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import {
  buildDependencyGraphFromContents,
  formatCompactGraphForPrompt,
  queryReverseImpact,
} from "../src/repo/dep-graph.ts"
import {
  extractSymbols,
  invalidateRepoGraphCache,
  loadCompactRepoMap,
  loadDependencyGraph,
} from "../src/repo/repomap.ts"
import { deleteFileTool } from "../src/tools/delete_file.ts"
import { depGraphTool } from "../src/tools/dep_graph.ts"
import { moveFileTool } from "../src/tools/move_file.ts"

describe("dep-graph hybrid engine (Wave 3)", () => {
  test("menangkap value, dynamic import(), require(), import type, export ... from dan mengabaikan komentar", () => {
    const g = buildDependencyGraphFromContents("/repo", [
      {
        path: "src/core.ts",
        content: "export const core = 1;\nexport type CoreCfg = { a: number };\n",
      },
      { path: "src/dyn.ts", content: "export function dyn() { return 2 }\n" },
      { path: "src/cjs.ts", content: "module.exports = { ok: true }\n" },
      { path: "src/reexp.ts", content: "export { core } from './core.js'\n" },
      {
        path: "src/entry.ts",
        content: [
          "// import { ghost } from './ghost.ts'",
          "/* require('./fake-comment.ts') */",
          "const snippet = `\nimport { tpl } from './template-fake.ts'\n`;",
          "import type { CoreCfg } from './core.js'",
          "import { dyn } from './dyn'",
          "export const loadDyn = () => import('./dyn.ts')",
          "const c = require('./cjs')",
          "export * from './reexp'",
          "import { missing } from './does-not-exist'",
          "import { readFile } from 'node:fs/promises'",
          "export { c };",
        ].join("\n"),
      },
    ])

    const entry = g.nodes.get("src/entry.ts")!
    expect(entry.imports.find((e) => e.to === "src/core.ts")?.kind).toBe("type")
    expect(entry.imports.find((e) => e.to === "src/dyn.ts")?.kind).toBe("dynamic")
    expect(entry.imports.find((e) => e.to === "src/cjs.ts")?.kind).toBe("value")
    expect(entry.imports.find((e) => e.to === "src/reexp.ts")?.kind).toBe("reexport")
    expect(entry.unresolvedLocal).toEqual(["./does-not-exist"])
    expect(entry.externalDeps).toContain("node:fs/promises")
    // Komentar dan isi template literal tidak ikut terhitung sebagai edge/unresolved.
    expect(entry.unresolvedLocal).not.toContain("./ghost.ts")
    expect(entry.unresolvedLocal).not.toContain("./template-fake.ts")

    const reexp = g.nodes.get("src/reexp.ts")!
    expect(reexp.imports[0]?.to).toBe("src/core.ts")
    expect(reexp.imports[0]?.kind).toBe("reexport")
  })

  test("resolusi alias package.json#imports dan tsconfig.json#paths serta bebas tabrakan basename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-dep-alias-"))
    try {
      await mkdir(join(dir, "src", "a"), { recursive: true })
      await mkdir(join(dir, "src", "b"), { recursive: true })
      await mkdir(join(dir, "vendor", "core"), { recursive: true })
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          imports: {
            "#core": "./vendor/core/index.ts",
            "#core/*": "./vendor/core/*",
          },
        }),
      )
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@app/*": ["src/*"] },
          },
        }),
      )
      await writeFile(join(dir, "vendor", "core", "index.ts"), "export const v = 1\n")
      await writeFile(join(dir, "src", "a", "config.ts"), "export const cfgA = 1\n")
      await writeFile(join(dir, "src", "b", "config.ts"), "export const cfgB = 2\n")
      await writeFile(
        join(dir, "src", "main.ts"),
        [
          "import { v } from '#core'",
          "import { cfgA } from '@app/a/config'",
          "export const run = v + cfgA",
        ].join("\n"),
      )

      const { graph } = await loadDependencyGraph(dir)
      const main = graph.nodes.get("src/main.ts")!
      const targets = main.imports.map((e) => e.to).sort()
      expect(targets).toEqual(["src/a/config.ts", "vendor/core/index.ts"])
      // basename `config.ts` di folder `b/` tidak boleh ikut terhitung.
      expect(graph.nodes.get("src/b/config.ts")!.inDegree).toBe(0)
      expect(graph.nodes.get("src/a/config.ts")!.inDegree).toBe(1)
    } finally {
      invalidateRepoGraphCache(dir)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("deteksi siklus runtime Tarjan SCC (type-only tidak memicu false positive), impact BFS & ranking non-test", () => {
    const g = buildDependencyGraphFromContents("/repo", [
      { path: "src/a.ts", content: "import { b } from './b'\nexport const a = b\n" },
      { path: "src/b.ts", content: "import { a } from './a'\nexport const b = 1\n" },
      { path: "src/typeA.ts", content: "import type { TB } from './typeB'\nexport type TA = TB\n" },
      {
        path: "src/typeB.ts",
        content: "import type { TA } from './typeA'\nexport type TB = string\n",
      },
      { path: "src/hub.ts", content: "export const hubFn = () => 1\n" },
      {
        path: "src/consumer.ts",
        content: "import { hubFn } from './hub'\nexport const u = hubFn()\n",
      },
      { path: "src/top.ts", content: "import { u } from './consumer'\nexport const t = u\n" },
      {
        path: "test/hub.test.ts",
        content: "import { hubFn } from '../src/hub'\nexport const x = hubFn()\n",
      },
    ])

    expect(g.cycles).toHaveLength(1)
    expect([...g.cycles[0]!].sort()).toEqual(["src/a.ts", "src/b.ts"])

    const impact = queryReverseImpact(g, "src/hub.ts", 2)
    expect(impact.productionDependents.map((d) => d.path).sort()).toEqual([
      "src/consumer.ts",
      "src/top.ts",
    ])
    expect(impact.testDependents.map((d) => d.path)).toEqual(["test/hub.test.ts"])
    // File produksi berada di peringkat sebelum test file di rankedPaths.
    const idxConsumer = g.rankedPaths.indexOf("src/consumer.ts")
    const idxTest = g.rankedPaths.indexOf("test/hub.test.ts")
    expect(idxConsumer).toBeGreaterThanOrEqual(0)
    expect(idxTest).toBeGreaterThan(idxConsumer)
  })

  test("polyglot dasar (Python dot-relative, C include) & formatCompactGraphForPrompt", () => {
    const contents = [
      { path: "pkg/mod.py", content: "def helper():\n  return 1\n" },
      { path: "pkg/sub/use.py", content: "from ..mod import helper\n" },
      { path: "native/util.h", content: "int add(int a, int b);\n" },
      { path: "native/main.c", content: '#include "util.h"\nint main() { return 0; }\n' },
    ]
    const g = buildDependencyGraphFromContents("/poly", contents)
    expect(g.nodes.get("pkg/sub/use.py")?.imports[0]?.to).toBe("pkg/mod.py")
    expect(g.nodes.get("native/main.c")?.imports[0]?.to).toBe("native/util.h")

    const summary = formatCompactGraphForPrompt(
      g,
      (src, lang) => extractSymbols(src, lang),
      new Map(contents.map((c) => [c.path, c.content])),
      600,
    )
    expect(summary).toContain("[graph]")
    expect(summary).toContain("pkg/mod.py")
  })

  test("loadDependencyGraph dan loadCompactRepoMap pada repo minicode cepat pada hit kedua (< 20 ms)", async () => {
    const cwd = process.cwd()
    const first = await loadDependencyGraph(cwd)
    expect(first.graph.totalFiles).toBeGreaterThan(200)
    expect(first.graph.nodes.has("src/app/session.ts")).toBe(true)
    const sessionNode = first.graph.nodes.get("src/app/session.ts")!
    expect(sessionNode.inDegree).toBeGreaterThan(0)

    const t0 = performance.now()
    await loadDependencyGraph(cwd)
    const secondMs = performance.now() - t0
    expect(secondMs).toBeLessThan(20)

    const compact = await loadCompactRepoMap(cwd, 1_200)
    expect(compact.length).toBeLessThanOrEqual(1_200)
    expect(compact).toContain("[graph]")
    expect(compact).toContain("src/")
  })

  test("Wave 5: tool dep_graph (summary/file/impact/cycles), jail path+cwd, dan peringatan move/delete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mc-dep-tool-"))
    const ctx = { cwd: dir, signal: new AbortController().signal } as never
    try {
      await mkdir(join(dir, "src"), { recursive: true })
      await mkdir(join(dir, "test"), { recursive: true })
      await writeFile(join(dir, "src", "core.ts"), "export const BASE = 1\n")
      await writeFile(
        join(dir, "src", "mid.ts"),
        "import { BASE } from './core.ts'\nexport const MID = BASE + 1\n",
      )
      await writeFile(
        join(dir, "src", "app.ts"),
        "import { MID } from './mid.ts'\nexport const APP = MID\n",
      )
      await writeFile(
        join(dir, "test", "app.test.ts"),
        "import { BASE } from '../src/core.ts'\nexport const T = BASE\n",
      )

      const summary = (await depGraphTool.execute({ action: "summary" }, ctx)) as string
      expect(summary).toContain("3/4 prod/all files")
      expect(summary).toContain("src/core.ts")

      const fileInfo = (await depGraphTool.execute(
        { action: "file", path: "src/core.ts" },
        ctx,
      )) as string
      expect(fileInfo).toContain("Imported by:")
      expect(fileInfo).toContain("<- src/mid.ts")

      const impact = (await depGraphTool.execute(
        { action: "impact", path: "src/core.ts", depth: 2, includeTests: true },
        ctx,
      )) as string
      expect(impact).toContain("2 prod, 1 test")
      expect(impact).toContain("d1 src/mid.ts")
      expect(impact).toContain("d2 src/app.ts")
      expect(impact).toContain("test/app.test.ts")

      const cycles = (await depGraphTool.execute({ action: "cycles" }, ctx)) as string
      expect(cycles).toContain("no runtime dependency cycles")

      // Permission jail menolak path & cwd luar workspace + .env.
      const perms = createPermissionHandler({ mode: "auto", root: dir })
      expect(
        await perms.check(
          { id: "g1", name: "dep_graph", args: { cwd: ".." } } as never,
          {} as never,
        ),
      ).toBe("deny")
      expect(
        await perms.check(
          { id: "g2", name: "dep_graph", args: { action: "file", path: "../secret.ts" } } as never,
          {} as never,
        ),
      ).toBe("deny")
      expect(
        await perms.check(
          { id: "g3", name: "dep_graph", args: { action: "file", path: ".env" } } as never,
          {} as never,
        ),
      ).toBe("deny")

      await expect(
        depGraphTool.execute({ action: "file", path: "../evil.ts" }, ctx),
      ).rejects.toThrow(/outside workspace/)

      // move_file & delete_file memberi peringatan importer aktif dan menginvalidasi cache.
      const movedOut = (await moveFileTool.execute(
        { path: "src/mid.ts", destination: "src/mid2.ts" },
        ctx,
      )) as string
      expect(movedOut).toContain("[dep-graph] warning:")
      expect(movedOut).toContain("src/app.ts")
      expect(await readFile(join(dir, "src", "mid2.ts"), "utf8")).toContain("BASE")

      // Rebuild graf harus mencerminkan src/mid2.ts, bukan src/mid.ts lagi.
      const summaryAfterMove = (await depGraphTool.execute({ action: "summary" }, ctx)) as string
      expect(summaryAfterMove).not.toContain("src/mid.ts (")

      const delOut = (await deleteFileTool.execute({ path: "src/core.ts" }, ctx)) as string
      expect(delOut).toContain("[dep-graph] warning:")
      expect(delOut).toContain("src/mid2.ts")
    } finally {
      invalidateRepoGraphCache(dir)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
