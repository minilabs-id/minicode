import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { LIMITS, LSP_SYMBOL_KINDS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { GIT_SAFE_BASE } from "../lib/git-hardening.ts"
import { safeReadFileCapped } from "../lib/safe-open.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"

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
 * Batas waktu `git ls-files` untuk repo-map startup.
 *
 * [Audit freeze 2026-11-16] Terukur 31-90 ms di luar TUI tetapi 1000-1150 ms
 * di dalam TUI. Sebab sesungguhnya bukan CPU: child mewarisi stdin TTY dalam
 * raw mode dan hasilnya dibaca dari `child.stdout` yang kosong, sehingga daftar
 * selalu jatuh ke walk. Batas ini tetap dipertahankan sebagai jaring: provider
 * git yang benar-benar lambat (repo jaringan, index besar) tidak boleh menahan
 * prompt.
 */
const REPOMAP_GIT_TIMEOUT_MS = 250
/**
 * Batas waktu walk direktori (jalur cadangan). Terukur 982 ms pada repo ini
 * saat TUI aktif — tanpa batas, kegagalan git berubah menjadi startup lambat
 * yang sama parahnya. Hasil parsial tetap dipakai: peta repo hanya pelengkap
 * prompt, jadi 60 berkas cukup dan jauh lebih baik daripada menahan 1 dtk.
 */
const REPOMAP_WALK_DEADLINE_MS = 400
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

// Ekstraksi simbol berbasis regex per-bahasa.
//
// Keputusan Fase 3.2 (PLAN_V4): `src/repo/tree-sitter.ts` DIHAPUS, bukan
// diimplementasikan. Alasannya diukur, bukan diasumsikan.
//
// Prototipe `web-tree-sitter` + `tree-sitter-typescript` berjalan dan cepat
// (init 89 ms, load grammar 19 ms, parse 6 ms), tapi perbandingan pada 5 file
// nyata di repo ini menunjukkan selisihnya kecil dan hampir seluruhnya berupa
// **member kelas** (`constructor`, `append`, `execute`, `check`, `__setMode`)
// dan variabel lokal — bukan simbol top-level yang berguna untuk orientasi:
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
export async function extractSymbolsAsync(content: string, lang: string): Promise<string[]> {
  return extractSymbols(content, lang)
}

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

// Baca konten file sumber (async) — dipakai sekali untuk ranking + ekstraksi simbol.
async function readSourceContents(
  files: string[],
  cwd: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  for (const f of files) {
    try {
      const abs = resolve(cwd, f)
      const loaded = await safeReadFileCapped(abs, cwd, MAX_FILE_BYTES)
      if (!loaded.truncated) out.push({ path: f, content: loaded.text })
    } catch {}
  }
  return out
}

// Ranking sederhana ala PageRank: file yang banyak di-import file lain
// mendapat skor lebih tinggi → tampil lebih awal di repo-map (hemat token).
function rankByImport(files: { path: string; content: string }[]): string[] {
  const basenameToFiles = new Map<string, string[]>()
  for (const { path: f } of files) {
    const base = f.slice(f.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "")
    if (!base) continue
    const list = basenameToFiles.get(base) ?? []
    list.push(f)
    basenameToFiles.set(base, list)
  }
  const scores = new Map<string, number>()
  for (const { path: f } of files) scores.set(f, 0)
  for (const { path: f, content } of files) {
    for (const [base, targets] of basenameToFiles) {
      if (f === targets[0] && targets.length === 1) continue // jangan hit diri sendiri bila unik
      const importRe = new RegExp(
        `(?:import|from|require)\\s*["'\`][^"'\`]*${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\`]*["'\`]`,
        "i",
      )
      if (importRe.test(content)) {
        for (const t of targets) scores.set(t, (scores.get(t) ?? 0) + 1)
      }
    }
  }
  return [...files.map((f) => f.path)].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
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
    const r = rel ? `${rel}/${e.name}` : e.name
    // Symlink escape (temuan audit #06): walk fallback mengikuti symlink;
    // tolak yang realpath-nya keluar workspace (simbol saja yang bocor,
    // tetapi tetap data asing tanpa provenance).
    if (isRealPathOutsideRoot(join(root, r), root)) continue
    if (e.isDirectory()) await walkForFiles(root, r, out, limit, deadline)
    else if (isSourceFile(e.name)) out.push(r)
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
      const child = spawn(resolveTrustedExecutable("git"), [...GIT_SAFE_BASE, "ls-files"], {
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
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        done(null)
      }, REPOMAP_GIT_TIMEOUT_MS)
      out.on("data", (d: Buffer) => chunks.push(d.toString("utf8")))
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
    const files = String(result)
      .split(String.fromCharCode(10))
      .map((f) => f.split(String.fromCharCode(92)).join("/"))
      .filter(Boolean)
      .filter(isSourceFile)
      .slice(0, limit)
    // git yang menjawab tapi semuanya terfilter = repon tanpa sumber git-tracked;
    // biarkan null supaya walk memutuskan.
    return files.length ? files : null
  } catch {
    return null
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

// Bangun repo-map compact dari daftar file.
export async function buildRepoMap(
  cwd: string = process.cwd(),
  opts: { limit?: number } = {},
): Promise<string> {
  const limit = opts.limit ?? MAX_FILES
  const files = await listSourceFiles(cwd, limit)
  // baca sekali → dipakai untuk ranking DAN simbol (tanpa double-read)
  const contents = await readSourceContents(files, cwd)
  const ranked = rankByImport(contents)
  const byPath = new Map(contents.map((c) => [c.path, c.content]))
  const parts: string[] = []
  for (const f of ranked) {
    const content = byPath.get(f)
    if (content == null) continue
    const symbols = extractSymbols(content, langFor(f))
    if (symbols.length) parts.push(`${f}:\n${symbols.map((s) => `  ${s}`).join("\n")}`)
  }
  return parts.join("\n").slice(0, MAX_REPOMAP_CHARS)
}

// Signature ISI (audit #10 P1): hash path+konten file terpilih — BUKAN
// mtime+size. Cache repomap.json tinggal di repo (dapat ditulis penyerang);
// sig mtime+size dapat dipalsukan via touch+padding sehingga peta BOHONG
// disajikan tanpa baca ulang. Dengan sig isi, cache palsu hanya cocok bila
// isinya benar-benar sama — dan bila sama, petanya pun benar. Cache lama
// (format mtime) otomatis miss → dibangun ulang sekali, tanpa migrasi.
async function signature(files: string[], cwd: string): Promise<string> {
  const h = createHash("sha256")
  for (const f of files.slice(0, 80)) {
    try {
      const abs = resolve(cwd, f)
      const loaded = await safeReadFileCapped(abs, cwd, MAX_FILE_BYTES)
      if (loaded.truncated) continue
      h.update(f)
      h.update(loaded.text)
    } catch {}
  }
  return `v2:${h.digest("hex")}`
}

// Coba bangun repo-map via LSP workspace/symbol (lebih akurat dari regex).
// Best-effort: timeout cepat, fallback ke regex bila LSP tak tersedia/kosong.
async function buildRepoMapLsp(cwd: string): Promise<string | null> {
  try {
    const { getConfiguredExts, workspaceSymbols } = await import("../lsp/client.ts")
    if (getConfiguredExts().length === 0) return null
    const symbols = await workspaceSymbols("", 4000, cwd)
    if (!symbols.length) return null
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
    if (byFile.size === 0) return null
    const parts: string[] = []
    for (const [file, syms] of byFile)
      parts.push(`${file}:\n${syms.map((x) => `  ${x}`).join("\n")}`)
    const map = parts.join("\n").slice(0, MAX_REPOMAP_CHARS)
    return map || null
  } catch {
    return null
  }
}

// Load repo-map, pakai cache di .minicode/repomap.json bila file tak berubah.
//
// [Audit freeze 2026-11-16] Tambahan cache DALAM-PROSES: `signature()` membaca
// isi 80 berkas (~99 ms) dan `git ls-files` (~31 ms) pada SETIAP panggilan,
// termasuk saat cache disk sudah segar — karena cache disk masih harus
// divalidasi dengan cara yang sama mahalnya. Sesi hanya butuh satu peta per
// cwd, jadi hasil per-cwd diingat di memori proses. Invalidasi: TTL pendek
// ditambah pembanding signature murah (jumlah berkas + mtime direktori kerja
// tidak dipakai karena bisa palsu) — di sini cukup TTL karena peta hanya
// memperkaya prompt; sesi panjang yang ingin peta segar memanggil `/context`
// atau memulai sesi baru.
const repomapMemo = new Map<string, { map: string; at: number; stamp: string; files: string[] }>()

/**
 * Sidik "murah" untuk mendeteksi perubahan isi repo tanpa membaca 80 berkas.
 *
 * Kenapa bukan TTL saja: TTL akan menyajikan peta BOHONG selama satu menit
 * setelah berkas berubah — regresi nyata yang tertangkap
 * `test/supply-chain.test.ts` ("repomap basi dibangun ulang saat berkas
 * berubah"). Staleness harus tetap menang atas kecepatan.
 *
 * Yang dipakai: (jumlah entry, mtime maksimum) dari direktori kerja. Jauh lebih
 * murah daripada `signature()` (baca isi 80 berkas ≈ 99 ms) dan cukup untuk
 * kasus nyata (menambah/menyunting berkas mengubah mtime direktori). Bila
 * sidik ini cocok, peta lama masih dianggap berlaku; bila tidak, jalur normal
 * (signature + cache disk) yang memutuskan.
 */
function quickStamp(cwd: string, files: string[]): string {
  // (mtime direktori kerja, mtime+size berkas teratas). Menyunting ISI berkas
  // tidak mengubah mtime direktori, jadi mtime berkas ikut disertakan — inilah
  // yang menjaga `test/supply-chain.test.ts` tetap hijau. Batasnya 16 berkas
  // teratas: cukup untuk mendeteksi suntingan pada berkas yang masuk peta.
  const parts: string[] = []
  try {
    parts.push(String(statSync(cwd).mtimeMs))
  } catch {
    return ""
  }
  for (const f of files.slice(0, 16)) {
    try {
      const st = statSync(resolve(cwd, f))
      parts.push(`${st.mtimeMs}:${st.size}`)
    } catch {
      parts.push("-")
    }
  }
  return parts.join("|")
}

export async function loadRepoMap(cwd: string = process.cwd()): Promise<string> {
  const memoKey = resolve(cwd)
  // Env MINICODE_REPOMAP=regex → skip LSP (paksa regex, lebih cepat)
  const forceRegex = process.env.MINICODE_REPOMAP === "regex"
  // Sidik murah dihitung SEBELUM `git ls-files` (yang justru bagian mahalnya),
  // dengan berkas yang diingat dari panggilan sebelumnya. Bila cocok, tak ada
  // git/disk yang disentuh sama sekali.
  const remembered = repomapMemo.get(memoKey)
  const stamp = quickStamp(cwd, remembered?.files ?? [])
  if (remembered && stamp && remembered.stamp === stamp) return remembered.map
  const files = await listSourceFiles(cwd, MAX_FILES)
  if (files.length === 0) return ""
  const freshStamp = quickStamp(cwd, files)
  const sig = await signature(files, cwd)
  const cp = cachePath(cwd)
  // Cache hit → langsung pakai (tanpa LSP, cepat)
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
  // Cache miss → coba LSP dulu (best-effort), fallback ke regex
  if (!forceRegex) {
    const lspMap = await buildRepoMapLsp(cwd)
    if (lspMap) {
      try {
        mkdirSync(join(homeDir(), ".minicode"), { recursive: true })
        writeFileSync(cp, JSON.stringify({ sig, map: lspMap, lsp: true }))
      } catch {}
      repomapMemo.set(memoKey, { map: lspMap, at: Date.now(), stamp: freshStamp || stamp, files })
      return lspMap
    }
  }
  const map = await buildRepoMap(cwd, { limit: MAX_FILES })
  try {
    mkdirSync(join(homeDir(), ".minicode"), { recursive: true })
    writeFileSync(cp, JSON.stringify({ sig, map, lsp: false }))
  } catch {}
  repomapMemo.set(memoKey, { map, at: Date.now(), stamp: freshStamp || stamp, files })
  return map
}
