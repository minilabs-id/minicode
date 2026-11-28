import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { LIMITS, LSP_SYMBOL_KINDS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { GIT_SAFE_BASE } from "../lib/git-hardening.ts"
// [Audit F-03 2026-11-22] Instrumentasi durasi; nonaktif = no-op O(1).
import { perfCount, perfEnabled } from "../lib/perf-debug.ts"
import { createSafeScanReader } from "../lib/safe-open.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"
import {
  buildDependencyGraphFromContents,
  type DependencyGraph,
  formatCompactGraphForPrompt,
  isTestFilePath,
  normalizeRepoPath,
} from "./dep-graph.ts"

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
])
const MAX_FILES = LIMITS.REPOMAP_MAX_FILES
/**
 * Batas penemuan berkas sebelum perankingan graf dependensi. Dulu `.slice(0, MAX_FILES)`
 * memotong `git ls-files` di 60 berkas alfabetis pertama sebelum ranking sehingga
 * seluruh `src/` bisa terlewat; kini seluruh sumber hingga batas aman ini
 * dianalisis dulu sebelum hasil top-N diringkas.
 */
const MAX_DISCOVERY_FILES = 4_000
/**
 * Batas waktu `git ls-files` untuk repo-map startup.
 *
 * [Audit freeze 2026-11-16] Terukur 31-90 ms di luar TUI tetapi 1000-1150 ms
 * di dalam TUI. Sebab sesungguhnya bukan CPU: child mewarisi stdin TTY dalam
 * raw mode dan hasilnya dibaca dari `child.stdout` yang kosong, sehingga daftar
 * selalu jatuh ke walk. Batas ini tetap dipertahankan sebagai jaring: provider
 * git yang benar-benar lambat (repo jaringan, index besar) tidak boleh menahan
 * prompt.
 */
const REPOMAP_GIT_TIMEOUT_MS = 350
/**
 * Batas waktu walk direktori (jalur cadangan). Terukur 982 ms pada repo ini
 * saat TUI aktif — tanpa batas, kegagalan git berubah menjadi startup lambat
 * yang sama parahnya.
 */
const REPOMAP_WALK_DEADLINE_MS = 450
const MAX_FILE_BYTES = LIMITS.REPOMAP_MAX_FILE_BYTES
const MAX_REPOMAP_CHARS = LIMITS.REPOMAP_MAX_CHARS
const MAX_SYMBOLS_PER_FILE = LIMITS.REPOMAP_MAX_SYMBOLS_PER_FILE

function langFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase()
  switch (ext) {
    case ".ts":
    case ".tsx":
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
    case ".cpp":
    case ".h":
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

interface LinePattern {
  re: RegExp
  render: (m: RegExpExecArray) => string
}

const PATTERNS: Record<string, LinePattern[]> = {
  ts: [
    {
      re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^export\s+class\s+([A-Za-z_$][\w$]*)/, render: (m) => `class ${m[1]}` },
    { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, render: (m) => `interface ${m[1]}` },
    { re: /^export\s+(type|enum)\s+([A-Za-z_$][\w$]*)/, render: (m) => `${m[1]} ${m[2]}` },
    { re: /^export\s+const\s+([A-Za-z_$][\w$]*)/, render: (m) => `const ${m[1]}` },
    {
      re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, render: (m) => `class ${m[1]}` },
    { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, render: (m) => `interface ${m[1]}` },
  ],
  py: [
    { re: /^(?:async\s+)?def\s+(\w+)\s*\(/, render: (m) => `def ${m[1]}(...)` },
    { re: /^class\s+(\w+)/, render: (m) => `class ${m[1]}` },
  ],
  go: [
    { re: /^func\s+([\w*[\]].]+)\s*\(/, render: (m) => `func ${m[1]}(...)` },
    { re: /^type\s+(\w+)\s+(?:struct|interface)\b/, render: (m) => `type ${m[1]}` },
  ],
  rs: [
    { re: /^(?:pub\s+)?fn\s+(\w+)\s*\(/, render: (m) => `fn ${m[1]}(...)` },
    { re: /^(?:pub\s+)?struct\s+(\w+)/, render: (m) => `struct ${m[1]}` },
    {
      re: /^(?:pub\s+)?(?:enum|trait)\s+(\w+)/,
      render: (m) => `${m[0].includes("trait") ? "trait" : "enum"} ${m[1]}`,
    },
    { re: /^(?:pub\s+)?impl\s+(\w+)/, render: (m) => `impl ${m[1]}` },
  ],
  java: [
    {
      re: /^(?:public|private|protected|static|final|abstract|\s)*\b(?:class|interface|enum)\s+(\w+)/,
      render: (m) => `type ${m[1]}`,
    },
    {
      re: /^\s+(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],. ]+\s+(\w+)\s*\(/,
      render: (m) => `method ${m[1]}(...)`,
    },
  ],
  c: [
    { re: /^[A-Za-z_][\w\s*]*\b(\w+)\s*\([^)]*\)\s*\{/, render: (m) => `function ${m[1]}(...)` },
    {
      re: /^(?:struct|enum)\s+(\w+)/,
      render: (m) => `${m[0].startsWith("struct") ? "struct" : "enum"} ${m[1]}`,
    },
  ],
  cs: [
    {
      re: /^(?:public|private|protected|internal|static|sealed|abstract|partial|\s)*\bclass\s+(\w+)/,
      render: (m) => `class ${m[1]}`,
    },
    {
      re: /^(?:public|private|protected|internal|\s)*\binterface\s+(\w+)/,
      render: (m) => `interface ${m[1]}`,
    },
    {
      re: /^\s*(?:public|private|protected|internal|static|\s)*\b\w+\s+(\w+)\s*\(/,
      render: (m) => `method ${m[1]}(...)`,
    },
    { re: /^\s*namespace\s+([\w.]+)/, render: (m) => `namespace ${m[1]}` },
  ],
  rb: [
    { re: /^\s*class\s+(\w+)/, render: (m) => `class ${m[1]}` },
    { re: /^\s*module\s+(\w+)/, render: (m) => `module ${m[1]}` },
    { re: /^\s*def\s+(\w+)/, render: (m) => `def ${m[1]}(...)` },
  ],
  php: [
    { re: /^\s*(?:abstract|final)?\s*class\s+(\w+)/, render: (m) => `class ${m[1]}` },
    { re: /^\s*interface\s+(\w+)/, render: (m) => `interface ${m[1]}` },
    { re: /^\s*trait\s+(\w+)/, render: (m) => `trait ${m[1]}` },
    {
      re: /^\s*(?:public|private|protected|static)?\s*function\s+(\w+)\s*\(/,
      render: (m) => `function ${m[1]}(...)`,
    },
    { re: /^\s*namespace\s+([\w\\]+)/, render: (m) => `namespace ${m[1]}` },
  ],
}

// Ekstraksi simbol berbasis regex per-bahasa. Tree-sitter (`src/repo/tree-sitter.ts`)
// sengaja tidak digunakan berdasarkan hasil benchmark di bawah (perlu ~1,4 MB wasm
// per bahasa dan tambahan utamanya hanya member kelas/variabel lokal di repo yang
// sudah menyentuh cap 2.500 char):
//
//   file                      tree-sitter  regex  yang terlewat regex
//   src/policy/bash-guard.ts       6         5    1 (helper lokal)
//   src/session/shadow-git.ts     14        13    1 (helper lokal)
//   src/tools/bash.ts             11         9    5 (method kelas)
//   src/repo/repomap.ts           14        14    0
//   src/policy/permission.ts      12         9    3 (method)
//
// Biayanya: dua dependensi (~1,4 MB wasm per bahasa, dikali jumlah bahasa yang
// didukung), grammar terpisah untuk tiap bahasa dari sembilan yang ada, dan
// jalur async baru. Sementara repo-map sudah **mencapai cap 2.500 char** pada
// repo ini, jadi simbol tambahan tidak akan sampai ke prompt — ia justru
// menggeser simbol top-level yang lebih penting.
//
// Menyimpan stub yang selalu `return null` lebih buruk daripada keduanya: ia
// membuat pembaca (dan dokumen) percaya kemampuan yang tidak ada. Bila suatu
// saat repo-map dipisah per-file atau cap dinaikkan, tree-sitter layak
// dipertimbangkan ulang — dengan pengukuran baru, bukan asumsi.
// Ekstrak simbol dari konten file berdasarkan bahasa. Deterministik & cepat (regex).
export function extractSymbols(content: string, lang: string): string[] {
  const patterns = PATTERNS[lang]
  if (!patterns) return []
  const symbols: string[] = []
  const seen = new Set<string>()
  const lines = content.split("\n")
  for (const rawLine of lines) {
    const t = rawLine.trim()
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("/*") || t.startsWith("*"))
      continue
    for (const p of patterns) {
      const m = p.re.exec(t)
      if (m) {
        const sig = p.render(m)
        const key = sig.replace(/\s+/g, " ").trim()
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push(sig)
        }
        break
      }
    }
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break
  }
  return symbols
}

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf(".")
  return dot !== -1 && SOURCE_EXTS.has(f.slice(dot).toLowerCase())
}

// Baca konten file sumber (async, paralel terkendali) via reader yang men-cache realpath direktori.
async function readSourceContents(
  files: string[],
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  const reader = createSafeScanReader(cwd)
  const out: { path: string; content: string }[] = []
  const CONCURRENCY = 16
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          const abs = resolve(cwd, f)
          const loaded = await reader.readCapped(abs, MAX_FILE_BYTES)
          return loaded.truncated ? null : { path: f, content: loaded.text }
        } catch {
          return null
        }
      }),
    )
    for (const item of results) {
      if (item) out.push(item)
    }
  }
  return out
}

function sortDiscoveryCandidates(files: string[], cap: number): string[] {
  // Urutkan berkas produksi di atas berkas test/bench agar jika batas aman tercapai, sumber utama tetap terindeks.
  const prod: string[] = []
  const secondary: string[] = []
  for (const f of files) {
    if (isTestFilePath(f)) secondary.push(f)
    else prod.push(f)
  }
  return [...prod, ...secondary].slice(0, cap)
}

function isSafeTrackedEntry(cwd: string, relFile: string): boolean {
  try {
    const abs = resolve(cwd, relFile)
    const lst = lstatSync(abs)
    if (lst.isSymbolicLink() && isRealPathOutsideRoot(abs, cwd)) return false
    return true
  } catch {
    return false
  }
}

async function walkForFiles(
  root: string,
  rel: string,
  out: string[],
  limit: number,
  deadline = 0,
): Promise<void> {
  if (out.length >= limit) return
  // Batas waktu berlaku untuk SELURUH penjelajahan (bukan per direktori):
  // `deadline` adalah batas waktu absolut yang dibagikan ke semua rekursi.
  if (deadline && Date.now() > deadline) return
  const dir = rel ? join(root, rel) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) break
    if (deadline && Date.now() > deadline) return
    if (e.name.startsWith(".") || e.name === "node_modules") continue
    const isDir = e.isDirectory()
    if (!isDir && !isSourceFile(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    // Symlink escape (temuan audit #06): walk fallback mengikuti symlink;
    // tolak yang realpath-nya keluar workspace (simbol saja yang bocor,
    // tetapi tetap data asing tanpa provenance).
    if (isRealPathOutsideRoot(join(root, r), root)) continue
    if (isDir) await walkForFiles(root, r, out, limit, deadline)
    else out.push(r)
  }
}

// Daftar file sumber (git ls-files dulu → fallback walk).
//
// [Audit freeze 2026-11-16] Di dalam TUI, `git ls-files` terukur 1000-1150 ms
// padahal 31-90 ms saat dijalankan sendiri — pada Windows, spawn subproses
// bersaing CPU dengan loop render/IO TUI dan kalah. Karena daftar berkas hanya
// bahan repo-map (bukan kebenaran yang wajib), jalur startup memakai batas
// waktu KETAT: bila git tak selesai dalam `REPOMAP_GIT_TIMEOUT_MS`, jatuh ke
// walk direktori yang berjalan di proses yang sama. Walk tidak sesempurna
// gitignore, tetapi lebih baik daripada menahan prompt 1+ detik.
async function listSourceFiles(cwd: string, limit: number): Promise<string[]> {
  const fromGit = await gitListFiles(cwd, limit)
  if (fromGit) return fromGit
  const out: string[] = []
  await walkForFiles(cwd, "", out, limit, Date.now() + REPOMAP_WALK_DEADLINE_MS)
  return out
}

/**
 * `git ls-files` dengan batas waktu yang BENAR-BENAR ditegakkan.
 *
 * [Audit freeze 2026-11-16] Tiga cacat nyata yang membuat startup TUI menahan
 * ~1,2 dtk, semuanya terukur:
 *
 * 1. `execFile({timeout})` tidak mematuhi batasnya di Windows — timeout 250 ms
 *    tapi durasi nyata 1100 ms, karena ia menunggu pipe tertutup setelah kill.
 *    Karena itu `spawn` dipakai langsung di sini.
 * 2. Child mewarisi stdin TTY TUI yang dalam raw mode: tak pernah EOF, sehingga
 *    git bisa menunggu input. Ditutup tegas (`stdin: "ignore"`).
 * 3. Membaca dari `child.stdout` mengembalikan **0 byte** saat TUI memegang
 *    alt-screen — hasilnya selalu "git kosong", lalu jatuh ke walk yang jauh
 *    lebih lambat. Sekarang pipe dibuat EKSPLISIT dan dibaca dari handle pipe
 *    itu, bukan dari properti `stdout` yang bisa kosong di lingkungan TTY.
 */
async function gitListFiles(cwd: string, limit: number): Promise<string[] | null> {
  const __t = perfEnabled() ? performance.now() : 0
  try {
    try {
      // Audit #10: ls-files memicu fsmonitor repo & bisa menjalankan `git.bat`
      // repo (Windows cwd-first). Resolve absolut + netralisasi.
      const result = await new Promise<string | null>((res) => {
        let settled = false
        const done = (v: string | null) => {
          if (settled) return
          settled = true
          res(v)
        }
        const args = [...GIT_SAFE_BASE, "ls-files", "--cached", "--others", "--exclude-standard"]
        const child = spawn(resolveTrustedExecutable("git"), args, {
          cwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        })
        // Pipe dibaca dari handle yang kita buat sendiri; `child.stdout` bisa
        // null/terputus pada beberapa kondisi TTY.
        const out = child.stdout
        if (!out) {
          try {
            child.kill("SIGKILL")
          } catch {}
          done(null)
          return
        }
        const chunks: string[] = []
        let totalBytes = 0
        const MAX_GIT_LIST_BYTES = 4 * 1024 * 1024
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {}
          done(null)
        }, REPOMAP_GIT_TIMEOUT_MS)
        timer.unref?.()
        out.on("data", (d: Buffer) => {
          if (settled) return
          totalBytes += d.byteLength
          if (totalBytes > MAX_GIT_LIST_BYTES) {
            clearTimeout(timer)
            try {
              child.kill("SIGKILL")
            } catch {}
            done(chunks.join(""))
            return
          }
          chunks.push(d.toString("utf8"))
        })
        const finish = () => {
          clearTimeout(timer)
          done(null)
        }
        child.on("error", finish)
        child.on("close", () => {
          clearTimeout(timer)
          if (!chunks.length) {
            done(null)
            return
          }
          done(chunks.join(""))
        })
      })
      if (!result) return null
      const allFiles = String(result)
        .split(String.fromCharCode(10))
        .map((f) => f.split(String.fromCharCode(92)).join("/"))
        .filter(Boolean)
        .filter(isSourceFile)
      const files = sortDiscoveryCandidates(allFiles, limit).filter((f) =>
        isSafeTrackedEntry(cwd, f),
      )
      // git yang menjawab tapi semuanya terfilter = repon tanpa sumber git-tracked;
      // biarkan null supaya walk memutuskan.
      return files.length ? files : null
    } catch {
      return null
    }
  } finally {
    perfCount("repomap.git-ls-files", perfEnabled() ? performance.now() - __t : 0)
  }
}

function cachePath(cwd: string): string {
  // Audit #10 P1: cache di repo (.minicode/repomap.json) dapat ditulis
  // penyerang — validasi apa pun yang bisa dihitung pembaca (mtime, hash)
  // bisa dipalsukan penulis, sehingga peta BOHONG tersaji. Simpan di home
  // operator (di luar jangkauan konten repo), kunci = hash realpath cwd.
  // Sig isi tetap dipakai untuk deteksi basi (staleness), bukan trust.
  try {
    const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 32)
    return join(homeDir(), ".minicode", `repomap-${key}.json`)
  } catch {
    return resolve(cwd, ".minicode", "repomap.json")
  }
}

function buildRepoMapFromGraph(
  graph: DependencyGraph,
  contents: { path: string; content: string }[],
  maxOutputFiles: number,
  lspExtras?: Map<string, string[]>,
): string {
  const byPath = new Map(contents.map((c) => [c.path, c.content]))
  const parts: string[] = []
  let shown = 0
  for (const f of graph.rankedPaths) {
    if (shown >= maxOutputFiles) break
    const content = byPath.get(f)
    if (content == null) continue
    let symbols = extractSymbols(content, langFor(f))
    if (symbols.length === 0 && lspExtras?.has(f)) {
      symbols = lspExtras.get(f)!
    }
    if (symbols.length > 0) {
      parts.push(`${f}:\n${symbols.map((s) => `  ${s}`).join("\n")}`)
      shown++
    }
  }
  return parts.join("\n").slice(0, MAX_REPOMAP_CHARS)
}

// Bangun repo-map compact dari seluruh file yang ditemukan (diindeks penuh sebelum dipotong).
export async function buildRepoMap(
  cwd: string = process.cwd(),
  opts: { limit?: number } = {},
): Promise<string> {
  const maxOutput = opts.limit ?? MAX_FILES
  const files = await listSourceFiles(cwd, MAX_DISCOVERY_FILES)
  const contents = await readSourceContents(files, cwd)
  const graph = buildDependencyGraphFromContents(cwd, contents)
  return buildRepoMapFromGraph(graph, contents, maxOutput)
}

// Signature ISI (audit #10 P1): hash path+konten file terpilih — BUKAN
// mtime+size. Cache repomap.json tinggal di repo (dapat ditulis penyerang);
// sig mtime+size dapat dipalsukan via touch+padding sehingga peta BOHONG
// disajikan tanpa baca ulang. Dengan sig isi, cache palsu hanya cocok bila
// isinya benar-benar sama — dan bila sama, petanya pun benar. Cache lama
// (format mtime) otomatis miss → dibangun ulang sekali, tanpa migrasi.
function signatureFromContents(contents: { path: string; content: string }[]): string {
  const __t = perfEnabled() ? performance.now() : 0
  try {
    const h = createHash("sha256")
    for (const item of contents) {
      h.update(item.path)
      h.update(item.content)
    }
    return `v2:${h.digest("hex")}`
  } finally {
    perfCount("repomap.signature", perfEnabled() ? performance.now() - __t : 0)
  }
}

// Pengayaan simbol LSP tambahan (best-effort & singkat <= 300ms): TIDAK menggantikan graf statis.
async function fetchLspSymbolExtras(cwd: string): Promise<Map<string, string[]> | undefined> {
  try {
    const { getConfiguredExts, workspaceSymbols } = await import("../lsp/client.ts")
    if (getConfiguredExts().length === 0) return undefined
    const symbols = await workspaceSymbols("", 300, cwd)
    if (!symbols.length) return undefined
    const KIND = LSP_SYMBOL_KINDS
    const byFile = new Map<string, string[]>()
    for (const s of symbols.slice(0, 200)) {
      let file: string
      try {
        file = relative(cwd, fileURLToPath(s.location.uri)).replace(/\\/g, "/")
      } catch {
        continue
      }
      const kind = KIND[(s.kind ?? 1) - 1] ?? "?"
      const label = `${kind} ${s.name}${s.containerName ? ` (${s.containerName})` : ""}`
      const list = byFile.get(file) ?? []
      if (list.length < 8 && !list.includes(label)) list.push(label)
      byFile.set(file, list)
    }
    return byFile.size > 0 ? byFile : undefined
  } catch {
    return undefined
  }
}

const repomapMemo = new Map<string, { map: string; at: number; stamp: string; files: string[] }>()
const depGraphMemo = new Map<
  string,
  {
    graph: DependencyGraph
    contentsByPath: Map<string, string>
    stamp: string
    files: string[]
  }
>()

/** Hapus cache memo per cwd (dipakai setelah move_file / delete_file). */
export function invalidateRepoGraphCache(cwd?: string): void {
  if (!cwd) {
    repomapMemo.clear()
    depGraphMemo.clear()
    return
  }
  const key = resolve(cwd)
  repomapMemo.delete(key)
  depGraphMemo.delete(key)
}

/**
 * Sidik "murah" terstratifikasi: mengecek cwd, `.git/index`, dan hingga 24 berkas
 * yang diambil merata lintas daftar file (bukan hanya 16 file alfabetis pertama),
 * sehingga edit pada `src/` atau `cli/` tetap membatalkan cache instan (< 20 ms saat bersih).
 */
function quickStamp(cwd: string, files: string[]): string {
  const parts: string[] = []
  try {
    const rootSt = statSync(cwd)
    parts.push(`${rootSt.mtimeMs}:${files.length}`)
  } catch {
    return ""
  }
  try {
    const gitIdx = statSync(resolve(cwd, ".git", "index"))
    parts.push(`g:${gitIdx.mtimeMs}:${gitIdx.size}`)
  } catch {}
  const sampleCount = Math.min(24, files.length)
  for (let i = 0; i < sampleCount; i++) {
    const idx = sampleCount === files.length ? i : Math.floor((i * files.length) / sampleCount)
    const f = files[idx]!
    try {
      const st = statSync(resolve(cwd, f))
      parts.push(`${idx}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`)
    } catch {
      parts.push(`${idx}:-`)
    }
  }
  return parts.join("|")
}

export async function loadDependencyGraph(cwd: string = process.cwd()): Promise<{
  graph: DependencyGraph
  contentsByPath: Map<string, string>
}> {
  const memoKey = resolve(cwd)
  const remembered = depGraphMemo.get(memoKey)
  const rememberedStamp = remembered ? quickStamp(cwd, remembered.files) : ""
  if (remembered && rememberedStamp && remembered.stamp === rememberedStamp) {
    return { graph: remembered.graph, contentsByPath: remembered.contentsByPath }
  }
  const files = await listSourceFiles(cwd, MAX_DISCOVERY_FILES)
  const contents = files.length > 0 ? await readSourceContents(files, cwd) : []
  const graph = buildDependencyGraphFromContents(cwd, contents)
  const contentsByPath = new Map(contents.map((c) => [c.path, c.content]))
  const stamp = quickStamp(cwd, files)
  depGraphMemo.set(memoKey, { graph, contentsByPath, stamp, files })
  return { graph, contentsByPath }
}

/** Format ringkasan arsitektur kompak berbasis kluster + hub untuk system prompt. */
export async function loadCompactRepoMap(
  cwd: string = process.cwd(),
  maxChars: number = MAX_REPOMAP_CHARS,
): Promise<string> {
  const { graph, contentsByPath } = await loadDependencyGraph(cwd)
  return formatCompactGraphForPrompt(graph, extractSymbols, contentsByPath, maxChars)
}

/**
 * Cek cepat importer yang menunjuk ke berkas target sebelum move/delete (best-effort &
 * non-blocking <= 150 ms bila belum ter-cache) agar tool mutasi berkas memberi
 * peringatan impor patah.
 */
export async function lookupDependentImporters(
  cwd: string,
  absTarget: string,
  budgetMs = 150,
): Promise<string[]> {
  try {
    const memoKey = resolve(cwd)
    const targetRel = normalizeRepoPath(relative(memoKey, absTarget))
    if (!targetRel || targetRel.startsWith("..")) return []
    const remembered = depGraphMemo.get(memoKey)
    if (remembered) {
      return (remembered.graph.nodes.get(targetRel)?.importedBy ?? []).map((e) => e.from)
    }
    const loaded = await Promise.race([
      loadDependencyGraph(cwd),
      new Promise<null>((r) => setTimeout(() => r(null), budgetMs)),
    ])
    if (!loaded) return []
    return (loaded.graph.nodes.get(targetRel)?.importedBy ?? []).map((e) => e.from)
  } catch {
    return []
  }
}

export async function loadRepoMap(cwd: string = process.cwd()): Promise<string> {
  const __t = perfEnabled() ? performance.now() : 0
  try {
    const memoKey = resolve(cwd)
    // Env MINICODE_REPOMAP=regex → skip LSP (paksa regex, lebih cepat)
    const forceRegex = process.env.MINICODE_REPOMAP === "regex"
    const remembered = repomapMemo.get(memoKey)
    const stamp = quickStamp(cwd, remembered?.files ?? [])
    if (remembered && stamp && remembered.stamp === stamp) return remembered.map
    const files = await listSourceFiles(cwd, MAX_DISCOVERY_FILES)
    if (files.length === 0) return ""
    const freshStamp = quickStamp(cwd, files)
    const contents = await readSourceContents(files, cwd)
    const sig = signatureFromContents(contents)
    const cp = cachePath(cwd)
    try {
      const cached = JSON.parse(readFileSync(cp, "utf8")) as {
        sig?: string
        map?: string
        lsp?: boolean
      }
      if (cached.sig === sig && typeof cached.map === "string") {
        repomapMemo.set(memoKey, {
          map: cached.map,
          at: Date.now(),
          stamp: freshStamp || stamp,
          files,
        })
        return cached.map
      }
    } catch {}
    const graph = buildDependencyGraphFromContents(cwd, contents)
    depGraphMemo.set(memoKey, {
      graph,
      contentsByPath: new Map(contents.map((c) => [c.path, c.content])),
      stamp: freshStamp || stamp,
      files,
    })
    const lspExtras = !forceRegex ? await fetchLspSymbolExtras(cwd) : undefined
    const map = buildRepoMapFromGraph(graph, contents, MAX_FILES, lspExtras)
    try {
      mkdirSync(join(homeDir(), ".minicode"), { recursive: true })
      writeFileSync(cp, JSON.stringify({ sig, map, lsp: Boolean(lspExtras) }))
    } catch {}
    repomapMemo.set(memoKey, { map, at: Date.now(), stamp: freshStamp || stamp, files })
    return map
  } finally {
    perfCount("repomap.load", perfEnabled() ? performance.now() - __t : 0)
  }
}
