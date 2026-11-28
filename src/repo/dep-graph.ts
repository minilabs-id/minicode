// Graf dependensi statis hibrid (zero-dependency, tanpa spawn subproses):
// - TS/JS memakai `Bun.Transpiler.scan` (runtime + dynamic import + require + exports)
//   dipadu pass leksikal/komentar untuk `import type`, `export type`, dan `export ... from`.
// - Bahasa lain memakai ekstraktor regex sadar-komentar per ekstensi.
// - Resolusi presisi membaca alias `package.json#imports` dan `tsconfig.json#paths`,
//   mendeteksi siklus (Tarjan SCC), dan menghitung centrality berbobot non-test.
import { existsSync, readFileSync } from "node:fs"
import { posix, resolve } from "node:path"

export type EdgeKind = "value" | "type" | "dynamic" | "reexport"

export interface DependencyEdge {
  from: string
  to: string
  spec: string
  kind: EdgeKind
}

export interface FileDepNode {
  path: string
  lang: string
  isTest: boolean
  imports: DependencyEdge[]
  importedBy: DependencyEdge[]
  externalDeps: string[]
  unresolvedLocal: string[]
  exports: string[]
  inDegree: number
  outDegree: number
  prodInDegree: number
  hubScore: number
}

export interface DirClusterSummary {
  dir: string
  files: number
  internalEdges: number
  externalDeps: number
}

export interface DependencyGraph {
  cwd: string
  builtAt: number
  totalFiles: number
  prodFiles: number
  nodes: Map<string, FileDepNode>
  edges: DependencyEdge[]
  cycles: string[][]
  rankedPaths: string[]
  clusters: DirClusterSummary[]
}

const TS_JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const
const TSX_EXTS = new Set([".tsx", ".jsx"])
const TS_ESM_SWAP: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".js"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
}

type TranspilerScan = {
  scan(code: string): {
    exports?: string[]
    imports?: { path: string; kind?: string }[]
  }
}

let tsScanner: TranspilerScan | null | undefined
let tsxScanner: TranspilerScan | null | undefined

function getTranspiler(isTsx: boolean): TranspilerScan | null {
  if (typeof Bun === "undefined" || typeof Bun.Transpiler !== "function") return null
  try {
    if (isTsx) {
      if (tsxScanner === undefined) tsxScanner = new Bun.Transpiler({ loader: "tsx" })
      return tsxScanner
    }
    if (tsScanner === undefined) tsScanner = new Bun.Transpiler({ loader: "ts" })
    return tsScanner
  } catch {
    return null
  }
}

export function normalizeRepoPath(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "")
}

export function isTestFilePath(relPath: string): boolean {
  const norm = normalizeRepoPath(relPath)
  return (
    /^(?:test|tests|__tests__|spec|bench)\//i.test(norm) ||
    /(?:\.|_)(?:test|spec)\.[^.]+$/i.test(norm)
  )
}

export function detectLang(relPath: string): string {
  const dot = relPath.lastIndexOf(".")
  if (dot === -1) return ""
  switch (relPath.slice(dot).toLowerCase()) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "ts"
    case ".py":
      return "py"
    case ".go":
      return "go"
    case ".rs":
      return "rs"
    case ".java":
      return "java"
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
      return "c"
    case ".cs":
      return "cs"
    case ".rb":
      return "rb"
    case ".php":
      return "php"
    default:
      return ""
  }
}

/**
 * Masking komentar `//`, `/* ... * /`, serta isi template literal `` `...` ``
 * (tetapi mempertahankan string `'...'`/`"..."` dan newline agar posisi/struktur baris tetap rapi)
 * sehingga contoh kode di komentar/test-fixture tidak menghasilkan edge palsu.
 */
function maskCommentsAndTemplates(src: string): string {
  const out: string[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === "/" && next === "/") {
      out.push("  ")
      i += 2
      while (i < n && src[i] !== "\n") {
        out.push(" ")
        i++
      }
      continue
    }
    if (ch === "/" && next === "*") {
      out.push("  ")
      i += 2
      while (i < n) {
        if (src[i] === "*" && src[i + 1] === "/") {
          out.push("  ")
          i += 2
          break
        }
        out.push(src[i] === "\n" ? "\n" : " ")
        i++
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      const q = ch
      out.push(ch)
      i++
      while (i < n) {
        const c = src[i]!
        out.push(c)
        i++
        if (c === "\\" && i < n) {
          out.push(src[i]!)
          i++
          continue
        }
        if (c === q || c === "\n") break
      }
      continue
    }
    if (ch === "`") {
      out.push("`")
      i++
      while (i < n) {
        const c = src[i]!
        if (c === "\\" && i + 1 < n) {
          out.push("  ")
          i += 2
          continue
        }
        if (c === "`") {
          out.push("`")
          i++
          break
        }
        out.push(c === "\n" ? "\n" : " ")
        i++
      }
      continue
    }
    out.push(ch)
    i++
  }
  return out.join("")
}

function addSpecKind(map: Map<string, EdgeKind>, spec: string, kind: EdgeKind): void {
  const trimmed = spec.trim()
  if (!trimmed) return
  const prev = map.get(trimmed)
  if (!prev) {
    map.set(trimmed, kind)
    return
  }
  // Prioritas: reexport > dynamic > value > type (reexport/value tidak tertimpa type-only).
  const rank: Record<EdgeKind, number> = { type: 1, value: 2, dynamic: 3, reexport: 4 }
  if (rank[kind] > rank[prev]) map.set(trimmed, kind)
}

const TS_REEXPORT_RE =
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*["']([^"']+)["']/gm
const TS_TYPE_IMPORT_RE =
  /^\s*import\s+type\s+(?:[\w$*]+(?:\s+as\s+[\w$]+)?(?:\s*,\s*\{[^}]*\})?|\{[^}]*\})?\s*(?:from\s*)?["']([^"']+)["']/gm
const TS_INLINE_IMPORT_FROM_RE = /^\s*import\s+(?:[\s\S]*?\bfrom\s*)?["']([^"']+)["']/gm
const TS_REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
const TS_TYPE_QUERY_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
const TS_FALLBACK_IMPORT_RE =
  /(?:^\s*(?:import|export)[\s\S]*?\bfrom\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\))/gm

function extractTsJsRefs(
  relPath: string,
  source: string,
): { specs: Map<string, EdgeKind>; exports: string[] } {
  const specs = new Map<string, EdgeKind>()
  let exports: string[] = []
  const dot = relPath.lastIndexOf(".")
  const ext = dot !== -1 ? relPath.slice(dot).toLowerCase() : ".ts"
  const scanner = getTranspiler(TSX_EXTS.has(ext))

  let transpiledOk = false
  if (scanner) {
    try {
      const scanRes = scanner.scan(source)
      transpiledOk = true
      if (Array.isArray(scanRes.exports)) {
        exports = [...new Set(scanRes.exports.filter((e) => typeof e === "string" && e.length > 0))]
      }
      for (const imp of scanRes.imports ?? []) {
        if (!imp?.path) continue
        const kind: EdgeKind = imp.kind === "dynamic-import" ? "dynamic" : "value"
        addSpecKind(specs, imp.path, kind)
      }
    } catch {
      transpiledOk = false
    }
  }

  const masked = maskCommentsAndTemplates(source)
  // Pass 2: pulihkan `export ... from` & `import type ...` yang di-strip transpiler.
  for (const m of masked.matchAll(TS_REEXPORT_RE)) {
    if (m[1]) addSpecKind(specs, m[1], "reexport")
  }
  for (const m of masked.matchAll(TS_TYPE_IMPORT_RE)) {
    if (m[1]) addSpecKind(specs, m[1], "type")
  }
  // Tangkap import dengan inline `{ type Foo }` bila terlewat oleh scan() runtime.
  for (const m of masked.matchAll(TS_INLINE_IMPORT_FROM_RE)) {
    if (m[1] && !specs.has(m[1])) addSpecKind(specs, m[1], "type")
  }
  for (const m of masked.matchAll(TS_REQUIRE_RE)) {
    if (m[1]) addSpecKind(specs, m[1], "value")
  }
  for (const m of masked.matchAll(TS_TYPE_QUERY_RE)) {
    if (m[1] && !specs.has(m[1])) addSpecKind(specs, m[1], transpiledOk ? "type" : "dynamic")
  }
  if (!transpiledOk) {
    for (const m of masked.matchAll(TS_FALLBACK_IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (spec) addSpecKind(specs, spec, "value")
    }
  }

  return { specs, exports }
}

function stripHashComments(src: string): string {
  return src.replace(/^\s*#.*$/gm, "")
}

function extractOtherLangSpecs(lang: string, source: string): Map<string, EdgeKind> {
  const specs = new Map<string, EdgeKind>()
  if (lang === "py") {
    const clean = stripHashComments(source)
    for (const m of clean.matchAll(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\b/gm)) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
    for (const m of clean.matchAll(/^\s*import\s+([^\n;#]+)/gm)) {
      for (const item of m[1]!.split(",")) {
        const mod = item
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim()
        if (mod) addSpecKind(specs, mod, "value")
      }
    }
    return specs
  }
  const masked = maskCommentsAndTemplates(source)
  if (lang === "go") {
    for (const m of masked.matchAll(/^\s*import\s+(?:[\w.]+\s+)?["']([^"']+)["']/gm)) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
    for (const block of masked.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
      for (const line of block[1]!.matchAll(/["']([^"']+)["']/g)) {
        if (line[1]) addSpecKind(specs, line[1], "value")
      }
    }
  } else if (lang === "rs") {
    for (const m of masked.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
      if (m[1]) addSpecKind(specs, `./${m[1]}`, "value")
    }
    for (const m of masked.matchAll(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)::[\w:]+)/gm)) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
  } else if (lang === "c") {
    for (const m of source.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) {
      if (m[1]) addSpecKind(specs, m[1].startsWith(".") ? m[1] : `./${m[1]}`, "value")
    }
  } else if (lang === "rb") {
    for (const m of stripHashComments(source).matchAll(
      /^\s*require_relative\s*\(?\s*["']([^"']+)["']/gm,
    )) {
      if (m[1]) addSpecKind(specs, m[1].startsWith(".") ? m[1] : `./${m[1]}`, "value")
    }
    for (const m of stripHashComments(source).matchAll(/^\s*require\s*\(?\s*["']([^"']+)["']/gm)) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
  } else if (lang === "php") {
    for (const m of masked.matchAll(
      /\b(?:require|require_once|include|include_once)\s*\(?\s*["']([^"']+)["']/gm,
    )) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
  } else if (lang === "java" || lang === "cs") {
    const re =
      lang === "java"
        ? /^\s*import\s+(?:static\s+)?([\w.]+)/gm
        : /^\s*using\s+(?:static\s+)?([\w.]+)/gm
    for (const m of masked.matchAll(re)) {
      if (m[1]) addSpecKind(specs, m[1], "value")
    }
  }
  return specs
}

interface AliasRule {
  prefix: string
  suffix: string
  hasStar: boolean
  targets: string[]
}

function stripJsonc(raw: string): string {
  const masked = maskCommentsAndTemplates(raw)
  return masked.replace(/,\s*([}\]])/g, "$1")
}

function flattenTargetValues(val: unknown): string[] {
  if (typeof val === "string") return [val]
  if (Array.isArray(val)) return val.flatMap(flattenTargetValues)
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>
    const ordered = ["bun", "import", "types", "default", ...Object.keys(obj)]
    const seen = new Set<string>()
    const out: string[] = []
    for (const k of ordered) {
      if (!(k in obj) || seen.has(k)) continue
      seen.add(k)
      out.push(...flattenTargetValues(obj[k]))
    }
    return out
  }
  return []
}

function loadProjectAliases(cwd: string): {
  rules: AliasRule[]
  baseUrl?: string
} {
  const rules: AliasRule[] = []
  let baseUrl: string | undefined

  const addRule = (pattern: string, targets: string[]) => {
    if (!pattern || targets.length === 0) return
    const star = pattern.indexOf("*")
    if (star === -1) {
      rules.push({ prefix: pattern, suffix: "", hasStar: false, targets })
    } else {
      rules.push({
        prefix: pattern.slice(0, star),
        suffix: pattern.slice(star + 1),
        hasStar: true,
        targets,
      })
    }
  }

  try {
    const pkgPath = resolve(cwd, "package.json")
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        imports?: Record<string, unknown>
      }
      if (pkg.imports && typeof pkg.imports === "object") {
        for (const [pat, val] of Object.entries(pkg.imports)) {
          addRule(pat, flattenTargetValues(val))
        }
      }
    }
  } catch {}

  for (const cfgName of ["tsconfig.json", "jsconfig.json"]) {
    try {
      const cfgPath = resolve(cwd, cfgName)
      if (!existsSync(cfgPath)) continue
      const parsed = JSON.parse(stripJsonc(readFileSync(cfgPath, "utf8"))) as {
        compilerOptions?: {
          baseUrl?: string
          paths?: Record<string, string[]>
        }
      }
      const co = parsed.compilerOptions
      if (typeof co?.baseUrl === "string" && co.baseUrl.trim()) {
        baseUrl = normalizeRepoPath(posix.normalize(normalizeRepoPath(co.baseUrl)))
        if (baseUrl === ".") baseUrl = undefined
      }
      if (co?.paths && typeof co.paths === "object") {
        for (const [pat, list] of Object.entries(co.paths)) {
          if (!Array.isArray(list)) continue
          const targets = list
            .filter((x): x is string => typeof x === "string")
            .map((t) => (baseUrl ? posix.join(baseUrl, t) : t))
          addRule(pat, targets)
        }
      }
      break
    } catch {}
  }

  // Aturan paling spesifik (prefix terpanjang) dicek terlebih dahulu.
  rules.sort((a, b) => b.prefix.length - a.prefix.length)
  return { rules, baseUrl }
}

function createModuleResolver(cwd: string, knownFiles: ReadonlySet<string>) {
  const { rules, baseUrl } = loadProjectAliases(cwd)
  const lowerIndex = new Map<string, string>()
  for (const f of knownFiles) lowerIndex.set(f.toLowerCase(), f)

  const probeExact = (candidate: string): string | null => {
    const norm = normalizeRepoPath(posix.normalize(candidate))
    if (knownFiles.has(norm)) return norm
    if (process.platform === "win32") return lowerIndex.get(norm.toLowerCase()) ?? null
    return null
  }

  const probeCandidate = (raw: string): string | null => {
    const clean = normalizeRepoPath(posix.normalize(raw))
    if (!clean || clean === ".." || clean.startsWith("../")) return null
    const exact = probeExact(clean)
    if (exact) return exact
    const dot = clean.lastIndexOf(".")
    const ext = dot > clean.lastIndexOf("/") ? clean.slice(dot).toLowerCase() : ""
    const swap = TS_ESM_SWAP[ext]
    if (swap) {
      const stem = clean.slice(0, dot)
      for (const sExt of swap) {
        const hit = probeExact(`${stem}${sExt}`)
        if (hit) return hit
      }
    }
    for (const sExt of TS_JS_EXTS) {
      const hit = probeExact(`${clean}${sExt}`)
      if (hit) return hit
    }
    for (const sExt of TS_JS_EXTS) {
      const hit = probeExact(`${clean}/index${sExt}`)
      if (hit) return hit
    }
    for (const altExt of [".py", "/__init__.py", ".rs", "/mod.rs", ".go", ".h", ".hpp"]) {
      const hit = probeExact(`${clean}${altExt}`)
      if (hit) return hit
    }
    return null
  }

  return (
    fromPath: string,
    spec: string,
    lang: string,
  ): { resolved?: string; isLocalSpec: boolean } => {
    const fromDir = posix.dirname(fromPath)
    const dirBase = fromDir === "." ? "" : `${fromDir}/`

    // 1. Alias `#imports` dan `tsconfig.paths`
    for (const r of rules) {
      if (!r.hasStar) {
        if (spec === r.prefix) {
          for (const t of r.targets) {
            const hit = probeCandidate(t)
            if (hit) return { resolved: hit, isLocalSpec: true }
          }
          return {
            isLocalSpec: spec.startsWith("#") || spec.startsWith("@/") || spec.startsWith("~/"),
          }
        }
      } else if (
        spec.startsWith(r.prefix) &&
        spec.endsWith(r.suffix) &&
        spec.length >= r.prefix.length + r.suffix.length
      ) {
        const starVal = spec.slice(r.prefix.length, spec.length - r.suffix.length)
        for (const t of r.targets) {
          const hit = probeCandidate(t.replace(/\*/g, starVal))
          if (hit) return { resolved: hit, isLocalSpec: true }
        }
        return {
          isLocalSpec: spec.startsWith("#") || spec.startsWith("@/") || spec.startsWith("~/"),
        }
      }
    }

    // 2. Relatif TS/JS/Ruby/C/PHP
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const joined = posix.join(dirBase, spec)
      const hit = probeCandidate(joined)
      return hit ? { resolved: hit, isLocalSpec: true } : { isLocalSpec: true }
    }

    // 3. Python dot-relative (`from .sub import x`, `from ..pkg import y`)
    if (lang === "py" && spec.startsWith(".")) {
      const dots = /^(\.+)(.*)$/.exec(spec)
      if (dots) {
        const ups = Math.max(0, dots[1]!.length - 1)
        const modPath = dots[2]!.replace(/\./g, "/")
        const upPrefix = "../".repeat(ups)
        const joined = posix.join(dirBase, `${upPrefix}${modPath || "__init__"}`)
        const hit = probeCandidate(joined)
        return hit ? { resolved: hit, isLocalSpec: true } : { isLocalSpec: true }
      }
    }

    // 4. Rust `crate::...` / `super::...`
    if (lang === "rs" && (spec.startsWith("crate::") || spec.startsWith("super::"))) {
      if (spec.startsWith("crate::")) {
        const sub = spec.slice("crate::".length).replace(/::/g, "/")
        const hit = probeCandidate(`src/${sub}`) ?? probeCandidate(sub)
        return hit ? { resolved: hit, isLocalSpec: true } : { isLocalSpec: true }
      }
      const sub = spec.slice("super::".length).replace(/::/g, "/")
      const hit = probeCandidate(posix.join(dirBase, `../${sub}`))
      return hit ? { resolved: hit, isLocalSpec: true } : { isLocalSpec: true }
    }

    // 5. baseUrl tsconfig atau modul Python lokal root
    if (baseUrl) {
      const hit = probeCandidate(posix.join(baseUrl, spec))
      if (hit) return { resolved: hit, isLocalSpec: true }
    }
    if (lang === "py" && /^[A-Za-z_][\w.]*$/.test(spec)) {
      const hit = probeCandidate(spec.replace(/\./g, "/"))
      if (hit) return { resolved: hit, isLocalSpec: true }
    }

    return { isLocalSpec: spec.startsWith("/") }
  }
}

/**
 * Deteksi Strongly Connected Components (Tarjan) secara iteratif/aman stack
 * hanya pada edge runtime (`value`/`dynamic`/`reexport`), karena `import type`
 * sirkular di TypeScript sah secara runtime dan tidak menimbulkan TDZ.
 */
function findRuntimeCycles(
  nodePaths: string[],
  runtimeOutAdj: Map<string, Set<string>>,
): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  const strongConnect = (start: string) => {
    type Frame = { v: string; neighbors: string[]; ni: number }
    const callStack: Frame[] = []
    indices.set(start, index)
    lowlink.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)
    callStack.push({ v: start, neighbors: [...(runtimeOutAdj.get(start) ?? [])], ni: 0 })

    while (callStack.length > 0) {
      const top = callStack[callStack.length - 1]!
      if (top.ni < top.neighbors.length) {
        const w = top.neighbors[top.ni++]!
        if (!indices.has(w)) {
          indices.set(w, index)
          lowlink.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          callStack.push({ v: w, neighbors: [...(runtimeOutAdj.get(w) ?? [])], ni: 0 })
        } else if (onStack.has(w)) {
          lowlink.set(top.v, Math.min(lowlink.get(top.v)!, indices.get(w)!))
        }
      } else {
        callStack.pop()
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!
          lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(top.v)!))
        }
        if (lowlink.get(top.v) === indices.get(top.v)) {
          const comp: string[] = []
          for (;;) {
            const w = stack.pop()!
            onStack.delete(w)
            comp.push(w)
            if (w === top.v) break
          }
          if (comp.length >= 2) {
            comp.reverse()
            sccs.push(comp)
          }
        }
      }
    }
  }

  for (const p of nodePaths) {
    if (!indices.has(p)) strongConnect(p)
  }
  sccs.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
  return sccs
}

function clusterKey(relPath: string): string {
  const norm = normalizeRepoPath(relPath)
  const parts = norm.split("/")
  if (parts.length <= 1) return "."
  if (parts.length === 2) return parts[0]!
  return `${parts[0]}/${parts[1]}`
}

/**
 * Bangun graf dependensi statis penuh dari daftar berkas yang sudah dibaca.
 * Murni in-memory (tanpa I/O/spawn) agar mudah diuji dan cepat.
 */
export function buildDependencyGraphFromContents(
  cwd: string,
  contents: { path: string; content: string }[],
): DependencyGraph {
  const normalizedItems = contents.map((item) => ({
    path: normalizeRepoPath(item.path),
    content: item.content,
  }))
  const knownFiles = new Set(normalizedItems.map((i) => i.path))
  const resolveImport = createModuleResolver(cwd, knownFiles)

  const nodes = new Map<string, FileDepNode>()
  for (const { path } of normalizedItems) {
    nodes.set(path, {
      path,
      lang: detectLang(path),
      isTest: isTestFilePath(path),
      imports: [],
      importedBy: [],
      externalDeps: [],
      unresolvedLocal: [],
      exports: [],
      inDegree: 0,
      outDegree: 0,
      prodInDegree: 0,
      hubScore: 0,
    })
  }

  const allEdges: DependencyEdge[] = []
  const runtimeOutAdj = new Map<string, Set<string>>()

  for (const { path, content } of normalizedItems) {
    const node = nodes.get(path)!
    let specs: Map<string, EdgeKind>
    if (node.lang === "ts") {
      const res = extractTsJsRefs(path, content)
      specs = res.specs
      node.exports = res.exports
    } else {
      specs = extractOtherLangSpecs(node.lang, content)
    }

    const extSet = new Set<string>()
    const unresolvedSet = new Set<string>()
    const seenEdgeTargets = new Map<string, DependencyEdge>()

    for (const [spec, kind] of specs) {
      const { resolved, isLocalSpec } = resolveImport(path, spec, node.lang)
      if (resolved && resolved !== path) {
        const existing = seenEdgeTargets.get(resolved)
        if (existing) {
          const rank: Record<EdgeKind, number> = { type: 1, value: 2, dynamic: 3, reexport: 4 }
          if (rank[kind] > rank[existing.kind]) existing.kind = kind
          continue
        }
        const edge: DependencyEdge = { from: path, to: resolved, spec, kind }
        seenEdgeTargets.set(resolved, edge)
        node.imports.push(edge)
        const targetNode = nodes.get(resolved)
        if (targetNode) {
          targetNode.importedBy.push(edge)
          allEdges.push(edge)
        }
        if (kind !== "type") {
          let adj = runtimeOutAdj.get(path)
          if (!adj) {
            adj = new Set()
            runtimeOutAdj.set(path, adj)
          }
          adj.add(resolved)
        }
      } else if (!resolved && isLocalSpec) {
        unresolvedSet.add(spec)
      } else if (!resolved) {
        extSet.add(spec)
      }
    }

    node.externalDeps = [...extSet].sort()
    node.unresolvedLocal = [...unresolvedSet].sort()
  }

  // Hitung metrik node, bobot sentralitas non-test, dan kluster direktori.
  let prodFiles = 0
  const clusterMap = new Map<string, { files: number; internalEdges: number; ext: Set<string> }>()
  for (const node of nodes.values()) {
    if (!node.isTest) prodFiles++
    node.outDegree = node.imports.length
    node.inDegree = node.importedBy.length
    let prodIn = 0
    let weightedIn = 0
    for (const e of node.importedBy) {
      const fromTest = nodes.get(e.from)?.isTest ?? false
      if (!fromTest) {
        prodIn++
        weightedIn += e.kind === "type" ? 2 : 3
      } else {
        weightedIn += 0.5
      }
    }
    node.prodInDegree = prodIn
    // Beri penalti kecil pada file test agar berkas produksi hub tetap menduduki puncak peringkat.
    node.hubScore =
      (node.isTest ? weightedIn * 0.25 : weightedIn + 1) + Math.min(node.exports.length, 10) * 0.05

    const cKey = clusterKey(node.path)
    let c = clusterMap.get(cKey)
    if (!c) {
      c = { files: 0, internalEdges: 0, ext: new Set() }
      clusterMap.set(cKey, c)
    }
    c.files++
    c.internalEdges += node.outDegree
    for (const dep of node.externalDeps) c.ext.add(dep)
  }

  const rankedPaths = [...nodes.values()]
    .sort(
      (a, b) =>
        b.hubScore - a.hubScore ||
        b.prodInDegree - a.prodInDegree ||
        b.inDegree - a.inDegree ||
        a.path.localeCompare(b.path),
    )
    .map((n) => n.path)

  const cycles = findRuntimeCycles([...nodes.keys()], runtimeOutAdj)
  const clusters: DirClusterSummary[] = [...clusterMap.entries()]
    .map(([dir, info]) => ({
      dir,
      files: info.files,
      internalEdges: info.internalEdges,
      externalDeps: info.ext.size,
    }))
    .sort(
      (a, b) =>
        b.internalEdges - a.internalEdges || b.files - a.files || a.dir.localeCompare(b.dir),
    )

  return {
    cwd,
    builtAt: Date.now(),
    totalFiles: nodes.size,
    prodFiles,
    nodes,
    edges: allEdges,
    cycles,
    rankedPaths,
    clusters,
  }
}

/** Hitung semua pemakai (reverse-dependents) secara BFS hingga kedalaman `maxDepth`. */
export function queryReverseImpact(
  graph: DependencyGraph,
  targetPath: string,
  maxDepth = 2,
): {
  productionDependents: { path: string; depth: number; via: string; kind: EdgeKind }[]
  testDependents: { path: string; depth: number; via: string; kind: EdgeKind }[]
} {
  const norm = normalizeRepoPath(targetPath)
  const rootNode = graph.nodes.get(norm)
  if (!rootNode) return { productionDependents: [], testDependents: [] }

  const depthCap = Math.max(1, Math.min(5, Math.floor(maxDepth)))
  const visited = new Set<string>([norm])
  const queue: { path: string; depth: number }[] = [{ path: norm, depth: 0 }]
  const prodOut: { path: string; depth: number; via: string; kind: EdgeKind }[] = []
  const testOut: { path: string; depth: number; via: string; kind: EdgeKind }[] = []

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.depth >= depthCap) continue
    const curNode = graph.nodes.get(cur.path)
    if (!curNode) continue
    for (const edge of curNode.importedBy) {
      if (visited.has(edge.from)) continue
      visited.add(edge.from)
      const depNode = graph.nodes.get(edge.from)
      const entry = { path: edge.from, depth: cur.depth + 1, via: cur.path, kind: edge.kind }
      if (depNode?.isTest) testOut.push(entry)
      else prodOut.push(entry)
      queue.push({ path: edge.from, depth: cur.depth + 1 })
    }
  }

  return { productionDependents: prodOut, testDependents: testOut }
}

/** Format ringkasan arsitektur kompak berbasis kluster + hub teratas untuk system prompt. */
export function formatCompactGraphForPrompt(
  graph: DependencyGraph,
  extractSymbolsFn: (content: string, lang: string) => string[],
  contentByPath: ReadonlyMap<string, string>,
  maxChars: number,
): string {
  if (graph.totalFiles === 0 || maxChars <= 80) return ""
  const lines: string[] = []
  const topClusters = graph.clusters
    .filter((c) => !c.dir.startsWith("test"))
    .slice(0, 6)
    .map((c) => `${c.dir}(${c.files}f,${c.internalEdges}e)`)
  lines.push(
    `[graph] ${graph.prodFiles}/${graph.totalFiles} prod/all files · ${graph.edges.length} edges · ${graph.cycles.length} cycles${topClusters.length ? ` · clusters: ${topClusters.join(", ")}` : ""}`,
  )

  let used = lines[0]!.length
  for (const p of graph.rankedPaths) {
    const node = graph.nodes.get(p)
    if (!node) continue
    // Jika ada file produksi, dahulukan produksi; test hanya bila repo memang didominasi test atau masih muat.
    if (node.isTest && graph.prodFiles > 0) continue
    const raw = contentByPath.get(p)
    const syms =
      raw != null ? extractSymbolsFn(raw, node.lang).slice(0, 6) : node.exports.slice(0, 6)
    const degTag =
      node.inDegree > 0 || node.outDegree > 0 ? ` (in:${node.inDegree},out:${node.outDegree})` : ""
    const block = syms.length > 0 ? `${p}${degTag}: ${syms.join(", ")}` : `${p}${degTag}`
    if (used + 1 + block.length > maxChars) {
      if (lines.length === 1) {
        // Minimal 1 baris hub agar peta tidak pernah benar-benar kosong bila ada ruang.
        const avail = maxChars - used - 2
        if (avail > 20) lines.push(`${block.slice(0, avail - 1)}…`)
      }
      break
    }
    lines.push(block)
    used += 1 + block.length
  }
  return lines.join("\n")
}
