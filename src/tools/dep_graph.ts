import { lstat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { Tool } from "#minicore"
import { sanitizeIncoming } from "../daemon/sanitize.ts"
import {
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
  isSensitiveReal,
} from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { normalizeRepoPath, queryReverseImpact } from "../repo/dep-graph.ts"
import { loadDependencyGraph } from "../repo/repomap.ts"
import { requireToolCwd, resolveSearchRoot } from "./context.ts"

type DepGraphAction = "summary" | "file" | "impact" | "cycles"

function clampDepth(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 2
  return Math.max(1, Math.min(5, Math.floor(raw)))
}

async function resolveOptionalGraphPath(
  rawPath: unknown,
  root: string,
  sessionRoot: string,
  relaxed: boolean,
): Promise<{ norm: string; existsDir: boolean } | undefined> {
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined
  const trimmed = rawPath.trim()
  if (!relaxed && isPathOutsideRoot(trimmed, sessionRoot)) {
    throw new Error(`path outside workspace: ${trimmed}`)
  }
  if (!relaxed && isSensitive(trimmed)) {
    throw new Error(`blocked sensitive file: ${trimmed}`)
  }
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
  if (
    !relaxed &&
    (isPathOutsideRoot(abs, sessionRoot) || isRealPathOutsideRoot(abs, sessionRoot))
  ) {
    throw new Error(`path outside workspace: ${trimmed}`)
  }
  if (!relaxed && isSensitiveReal(abs, sessionRoot)) {
    throw new Error(`blocked sensitive file: ${trimmed}`)
  }
  const rel = normalizeRepoPath(relative(root, abs))
  if (!rel || rel === ".." || rel.startsWith("../")) {
    throw new Error(`path outside workspace: ${trimmed}`)
  }
  const st = await lstat(abs).catch(() => null)
  return { norm: rel.replace(/\/+$/, ""), existsDir: st?.isDirectory() ?? false }
}

function capRows(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), `… [${lines.length - limit} more omitted]`]
}

export const depGraphTool: Tool = {
  name: "dep_graph",
  description:
    "FILE SEARCH: Map workspace module dependencies, top hubs, reverse dependents, or import cycles.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["summary", "file", "impact", "cycles"],
        description: "query mode (default: file when path is given, else summary)",
      },
      path: {
        type: "string",
        description:
          "file or directory path relative to the workspace root (required for file/impact)",
      },
      depth: {
        type: "number",
        description: "reverse-dependent BFS depth for impact mode (1-5, default 2)",
      },
      includeTests: {
        type: "boolean",
        description: "include test files in summary hubs and cycles (default false)",
      },
      cwd: {
        type: "string",
        description: "workspace directory (default: session root)",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(rawArgs, ctx) {
    ctx.signal.throwIfAborted()
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {}
    const sessionRoot = requireToolCwd(ctx)
    const baseRoot = resolveSearchRoot(args.cwd, ctx)
    const target = await resolveOptionalGraphPath(
      args.path,
      baseRoot.root,
      sessionRoot,
      baseRoot.relaxed,
    )
    const rawAction = typeof args.action === "string" ? args.action : undefined
    const action: DepGraphAction =
      rawAction === "summary" ||
      rawAction === "file" ||
      rawAction === "impact" ||
      rawAction === "cycles"
        ? rawAction
        : target && !target.existsDir
          ? "file"
          : "summary"

    if ((action === "file" || action === "impact") && !target) {
      throw new Error(`dep_graph: 'path' is required for action '${action}'`)
    }

    const { graph } = await loadDependencyGraph(baseRoot.root)
    ctx.signal.throwIfAborted()
    const clean = (s: string) => sanitizeIncoming(s)
    const includeTests = args.includeTests === true

    if (action === "cycles") {
      const filtered = includeTests
        ? graph.cycles
        : graph.cycles.filter((c) => c.some((f) => !graph.nodes.get(f)?.isTest))
      if (filtered.length === 0) {
        return `no runtime dependency cycles across ${graph.totalFiles} files (${graph.edges.length} edges)`
      }
      const rows = filtered.map(
        (comp, idx) => `${idx + 1}. (${comp.length} files): ${comp.map(clean).join(" <-> ")}`,
      )
      return scrubSecrets([`Runtime cycles: ${filtered.length}`, ...capRows(rows, 40)].join("\n"))
    }

    if (action === "file") {
      const node = graph.nodes.get(target!.norm)
      if (!node) {
        return `file not found in dependency graph: ${clean(target!.norm)} (indexed ${graph.totalFiles} source files)`
      }
      const lines = [
        `File: ${clean(node.path)} (${node.lang || "unknown"}, in:${node.inDegree} [prod:${node.prodInDegree}], out:${node.outDegree})`,
      ]
      if (node.imports.length > 0) {
        lines.push("Imports:")
        lines.push(
          ...capRows(
            node.imports.map((e) => `  -> ${clean(e.to)} [${e.kind}]`),
            60,
          ),
        )
      }
      if (node.importedBy.length > 0) {
        lines.push("Imported by:")
        lines.push(
          ...capRows(
            node.importedBy.map((e) => `  <- ${clean(e.from)} [${e.kind}]`),
            60,
          ),
        )
      }
      if (node.externalDeps.length > 0) {
        lines.push(`External: ${node.externalDeps.slice(0, 30).map(clean).join(", ")}`)
      }
      if (node.unresolvedLocal.length > 0) {
        lines.push(`Unresolved local: ${node.unresolvedLocal.slice(0, 20).map(clean).join(", ")}`)
      }
      if (node.exports.length > 0) {
        lines.push(`Exports: ${node.exports.slice(0, 25).map(clean).join(", ")}`)
      }
      return scrubSecrets(lines.join("\n"))
    }

    if (action === "impact") {
      const depth = clampDepth(args.depth)
      const node = graph.nodes.get(target!.norm)
      if (!node) {
        return `file not found in dependency graph: ${clean(target!.norm)} (indexed ${graph.totalFiles} source files)`
      }
      const impact = queryReverseImpact(graph, node.path, depth)
      const total = impact.productionDependents.length + impact.testDependents.length
      if (total === 0) {
        return `no reverse dependents found for ${clean(node.path)} (depth ${depth})`
      }
      const lines = [
        `Reverse impact for ${clean(node.path)} (depth <= ${depth}): ${impact.productionDependents.length} prod, ${impact.testDependents.length} test`,
      ]
      if (impact.productionDependents.length > 0) {
        lines.push("Production dependents:")
        lines.push(
          ...capRows(
            impact.productionDependents.map(
              (d) => `  d${d.depth} ${clean(d.path)} (via ${clean(d.via)}, ${d.kind})`,
            ),
            60,
          ),
        )
      }
      if (includeTests && impact.testDependents.length > 0) {
        lines.push("Test dependents:")
        lines.push(
          ...capRows(
            impact.testDependents.map(
              (d) => `  d${d.depth} ${clean(d.path)} (via ${clean(d.via)}, ${d.kind})`,
            ),
            40,
          ),
        )
      }
      return scrubSecrets(lines.join("\n"))
    }

    // action === "summary"
    const prefix = target ? (target.norm === "." ? "" : `${target.norm}/`) : ""
    const filteredHubs = graph.rankedPaths.filter((p) => {
      if (!includeTests && graph.nodes.get(p)?.isTest) return false
      if (prefix && !p.startsWith(prefix) && p !== target?.norm) return false
      return true
    })
    const clusters = graph.clusters
      .filter((c) => includeTests || !c.dir.startsWith("test"))
      .slice(0, 10)
      .map((c) => `  ${clean(c.dir)}: ${c.files} files, ${c.internalEdges} edges`)
    const hubRows = filteredHubs.slice(0, 20).map((p) => {
      const n = graph.nodes.get(p)!
      return `  ${clean(p)} (in:${n.inDegree}, prodIn:${n.prodInDegree}, out:${n.outDegree})`
    })
    const outLines = [
      `Dependency graph: ${graph.prodFiles}/${graph.totalFiles} prod/all files, ${graph.edges.length} internal edges, ${graph.cycles.length} runtime cycles`,
      ...(clusters.length ? ["Top clusters:", ...clusters] : []),
      ...(hubRows.length ? ["Top hubs:", ...hubRows] : ["No matching source files indexed"]),
    ]
    return scrubSecrets(outLines.join("\n"))
  },
}
