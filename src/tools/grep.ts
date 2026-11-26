import { spawn, spawnSync } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { loadIgnoreMatchers } from "../lib/ignore.ts"
import { safeReadFile } from "../lib/safe-open.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import {
  isCwdOutsideRoot,
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
  isSensitiveReal,
} from "../policy/jail.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { requireToolCwd, resolveSearchRoot, walkWorkspaceFiles } from "./context.ts"
import { globToRegExp } from "./glob.ts"

// v7.32 (L6): prefix marker timeout ripgrep. Dipakai dua arah — runRipgrep
// menandai hasil (walau kosong) dan pemanggil membedakannya dari miss asli.
export const RIPGREP_TIMEOUT_PREFIX = "… [truncated: ripgrep timeout"
export const RIPGREP_TIMEOUT_MARKER = `${RIPGREP_TIMEOUT_PREFIX} ${LIMITS.GREP_RIPGREP_TIMEOUT_MS}ms]`

/** Pesan eksplisit saat rg timeout sebelum menghasilkan satu pun match. */
export function ripgrepTimeoutEmptyMessage(pattern: string, root: string): string {
  return `ripgrep timed out after ${LIMITS.GREP_RIPGREP_TIMEOUT_MS}ms with no results for /${pattern}/ in ${root} — search incomplete, refine pattern or retry`
}

// ── v7.38 (L7): pagar ReDoS khusus fallback JS ──
// Ripgrep memakai regex Rust (waktu linear), tapi walker JS memakai `new RegExp`
// yang bisa catastrophic backtracking. Kita deteksi bentuk rawan SECARA STATIS
// sebelum menjalankan regex di fallback, lalu tolak (fail-closed). Pagar ini
// SENGAJA dipanggil hanya di jalur JS — jalur ripgrep tak pernah terkena, jadi
// pencarian valid dengan rg tetap byte-identik.

/** Batas panjang baris di walker JS; di atas ini baris dilewati (generous). */
export const GREP_JS_LINE_MAX_CHARS = 100_000

const REPEAT_OR_BOUNDED = /[+*{]/
// v7.40: `?` juga quantifier. Disertakan HANYA saat menilai isi grup yang
// sendiri di-quantify — `(a?b?)*` = nested quantifier (backtracking eksponensial,
// terbukti ~900ms pada 57 char). Di luar konteks itu `a?b`/suffix opsional
// sengaja tak ditandai supaya pola normal tak tertolak.
const REPEAT_WITH_OPTIONAL = /[+*{?]/

/** Buang class/escape/tanda grup supaya analisis tak tertipu oleh literal. */
function structuralChars(content: string): string {
  // v7.40 re-audit: slice isi grup bisa diawali prefix grup `(?:`, `(?=`, `(?!`,
  // `(?<=`, `(?<!`, `(?<name>`, `(?i:`. Karakter `?`/`:` di prefix BUKAN
  // quantifier — tanpa pembuangan ini `(?:ab)*` salah ditolak sebagai ReDoS.
  if (content.startsWith("?")) {
    let j = 1
    while (j < content.length && !":=!>".includes(content[j]!)) j++
    if (j < content.length) content = content.slice(j + 1)
  }
  let out = ""
  let inClass = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!
    // Prefix grup bersarang di dalam isi (mis. `a(?:b)?`): buang `(?…)` juga.
    if (c === "(" && content[i + 1] === "?") {
      i += 2
      while (i < content.length && !":=!>".includes(content[i]!)) i++
      continue
    }
    if (c === "\\") {
      i++ // karakter setelah backslash adalah literal/escape, bukan struktur
      continue
    }
    if (c === "[") {
      inClass = true
      continue
    }
    if (c === "]") {
      inClass = false
      continue
    }
    if (inClass) continue
    if (c === "(" || c === ")") continue
    out += c
  }
  return out
}

/** Alternasi yang diulang rawan bila satu alternatif adalah awalan yang lain. */
function hasOverlappingAlternation(structural: string): boolean {
  if (!structural.includes("|")) return false
  const alts = structural.split("|")
  for (let i = 0; i < alts.length; i++) {
    for (let j = i + 1; j < alts.length; j++) {
      const a = alts[i]!
      const b = alts[j]!
      if (a.length === 0 || b.length === 0) return true // alternasi kosong = ambigu
      if (a.startsWith(b) || b.startsWith(a)) return true // prefix bersama = ambigu
    }
  }
  return false
}

/**
 * Deteksi statis regex rawan catastrophic backtracking pada fallback JS:
 * quantifier bersarang (`(a+)+`, `(a*)*`), alternasi tumpang tindih yang
 * diulang (`(a|aa)+`), serta backreference ter-quantifier / ke grup
 * ter-quantifier. Diekspor untuk test; bukan validator regex penuh — sengaja
 * konservatif (lebih banyak menolak daripada menggantung).
 */
export function isReDosPronePattern(pattern: string): boolean {
  const stack: Array<{ start: number; capture: number }> = []
  const riskyCapture = new Map<number, boolean>()
  let captureCount = 0

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "\\") {
      const next = pattern[i + 1]
      if (next && next >= "1" && next <= "9") {
        const after = pattern[i + 2]
        // Backreference yang diulang, atau yang merujuk grup ter-quantifier.
        if (after === "+" || after === "*" || after === "{") return true
        if (riskyCapture.get(Number(next))) return true
        i++ // lewati digit referensi
      } else {
        i++ // lewati karakter ter-escape
      }
      continue
    }
    if (c === "[") {
      // Lewati character class: +/*/|/() di dalamnya adalah literal.
      i++
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++
        i++
      }
      continue
    }
    if (c === "(") {
      const special = pattern[i + 1] === "?"
      // Grup capture biasa diberi nomor; lookaround & non-capture tidak.
      const capture = special ? 0 : ++captureCount
      stack.push({ start: i, capture })
      continue
    }
    if (c === ")") {
      const frame = stack.pop()
      if (!frame) continue
      const structural = structuralChars(pattern.slice(frame.start + 1, i))
      const after = pattern[i + 1]
      // `?` dianggap rawan hanya bila grupnya sendiri di-quantify (`+`/`*`/`{`);
      // `after === "?"` (grup opsional) tetap dikecualikan seperti semula.
      const groupQuantified = after === "+" || after === "*" || after === "{"
      const repeat = groupQuantified ? REPEAT_WITH_OPTIONAL : REPEAT_OR_BOUNDED
      const risky = repeat.test(structural) || hasOverlappingAlternation(structural)
      if (frame.capture > 0) riskyCapture.set(frame.capture, risky)
      // Grup rawan yang diulang (`?` dikecualikan: {0,1} terikat).
      if (risky && groupQuantified) return true
    }
  }
  // Deteksi rantai wildcard/quantifier tak-tergrup yang rawan backtracking
  // polinomial/eksponensial pada fallback JS (mis. `.*.*.*.*`, `.+.+.+.+`).
  // Hanya menandai bila ada >= 2 pengulangan wildcard berdekatan (`.*.*`) atau
  // >= 4 quantifier tak-terbatas (`*`/`+`) di luar character class.
  const topStructural = structuralChars(pattern)
  if (/(?:\.\*|\.\+){2,}/.test(topStructural)) return true
  // Rantai kelas karakter ter-quantifier yang berdekatan (mis. `\w+\w+\w+!`,
  // `[a-z]+[a-z]+$`) memicu backtracking eksponensial/polinomial di JSC YARR
  // walau tanpa `.*`/`.+`.
  if (
    /(\[[^\]\r\n]{1,64}\]|\\[wWdDsS]|\.)(?:[*+]|\{\d{1,4},\})\1(?:[*+]|\{\d{1,4},\})/.test(
      pattern,
    ) ||
    /(?:\\(?:w|W|d|D|s|S)|\.)(?:[*+]|\{\d{1,4},\})(?:\\(?:w|W|d|D|s|S)|\.)(?:[*+]|\{\d{1,4},\})(?:\\(?:w|W|d|D|s|S)|\.)(?:[*+]|\{\d{1,4},\})/.test(
      pattern,
    )
  ) {
    return true
  }
  const unboundedCount = (topStructural.match(/(?:\.\*|\.\+|[*+])/g) ?? []).length
  if (unboundedCount >= 4 && /(?:\\(?:w|W|d|D|s|S)|\.\*|\.\+)/.test(pattern)) return true
  return false
}

/** Pesan isError saat fallback JS menolak pola rawan ReDoS. Null bila aman. */
export function redosGuardMessage(pattern: string): string | null {
  if (!isReDosPronePattern(pattern)) return null
  return (
    `grep pattern /${pattern}/ is ReDoS-prone on the JS fallback ` +
    `(nested quantifiers, overlapping alternation, or a quantified backreference) ` +
    `and was refused before running the regex. Ripgrep handles such patterns safely; ` +
    `for the JS fallback use a simpler pattern or escape regex metacharacters ` +
    `(., *, +, ?, (, ), [, ], {, }, |, ^, $, \\) to search for a literal string.`
  )
}

function formatGrepLine(rel: string, lineNo: number, sep: ":" | "-", rawLine: string): string {
  const body = rawLine.replace(/\r$/, "")
  const cut = body.length > LIMITS.GREP_MATCH_MAX_CHARS
  return `${rel}:${lineNo}${sep} ${scrubSecrets(cut ? `${body.slice(0, LIMITS.GREP_MATCH_MAX_CHARS)}…` : body)}`
}

function renderMatchedIndicesWithContext(
  rel: string,
  fileLines: readonly string[],
  matchIndices: readonly number[],
  ctxLines: number,
  out: string[],
  hasPrevOutput: boolean,
): void {
  if (matchIndices.length === 0) return
  const matchSet = new Set(matchIndices)
  const ranges: Array<{ start: number; end: number }> = []
  for (const m of matchIndices) {
    const start = Math.max(0, m - ctxLines)
    const end = Math.min(fileLines.length - 1, m + ctxLines)
    const prev = ranges[ranges.length - 1]
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end)
    } else {
      ranges.push({ start, end })
    }
  }
  ranges.forEach((r, hIdx) => {
    if (hasPrevOutput || hIdx > 0) out.push("--")
    for (let i = r.start; i <= r.end; i++) {
      out.push(formatGrepLine(rel, i + 1, matchSet.has(i) ? ":" : "-", fileLines[i]!))
    }
  })
}

async function grepSingleFile(opts: {
  real: string
  rel: string
  sessionRoot: string
  re: RegExp
  limit: number
  ctxLines: number
  relaxed: boolean
}): Promise<{ lines: string[]; hasMore: boolean; matchCount: number }> {
  const st = await stat(opts.real).catch(() => null)
  if (!st || st.size > LIMITS.GREP_FILE_MAX_BYTES) {
    throw new Error(`file too large to search: ${opts.rel} (${st?.size ?? 0})`)
  }
  const text = await safeReadFile(opts.real, opts.sessionRoot, opts.relaxed)
  if (text.includes("\0")) return { lines: [], hasMore: false, matchCount: 0 }
  const fileLines = text.split("\n")
  const want = opts.limit + 1
  const matchIndices: number[] = []
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i]!
    if (line.length > GREP_JS_LINE_MAX_CHARS) continue
    opts.re.lastIndex = 0
    if (opts.re.test(line)) {
      matchIndices.push(i)
      if (matchIndices.length >= want) break
    }
  }
  if (matchIndices.length === 0) return { lines: [], hasMore: false, matchCount: 0 }
  const hasMore = matchIndices.length > opts.limit
  const shownMatches = hasMore ? matchIndices.slice(0, opts.limit) : matchIndices
  if (opts.ctxLines === 0) {
    return {
      lines: shownMatches.map((idx) => formatGrepLine(opts.rel, idx + 1, ":", fileLines[idx]!)),
      hasMore,
      matchCount: shownMatches.length,
    }
  }
  const out: string[] = []
  renderMatchedIndicesWithContext(opts.rel, fileLines, shownMatches, opts.ctxLines, out, false)
  return { lines: out, hasMore, matchCount: shownMatches.length }
}

interface ContextFileMatch {
  rel: string
  fileLines: string[]
  matchIndices: number[]
}

async function walkGrep(
  dir: string,
  re: RegExp,
  out: string[],
  root: string,
  limit: number,
  signal: AbortSignal,
  includeRe?: RegExp | null,
  ignoreMatchers: ((rel: string) => boolean)[] = [],
  relaxed = false,
  includeDotfiles = false,
  ctxLines = 0,
): Promise<{ lines: string[]; hasMore: boolean; matchCount: number }> {
  if (ctxLines <= 0) {
    await walkWorkspaceFiles(
      {
        dir,
        root,
        signal,
        ignoreMatchers,
        relaxed,
        includeDotfiles,
        shouldStop: () => out.length >= limit,
      },
      async ({ rel, name, real }) => {
        if (includeRe && !includeRe.test(rel) && !includeRe.test(name)) return
        if (/\.(png|jpg|jpeg|gif|webp|pdf|zip|exe|dll|bin)$/i.test(name)) return
        const st = await stat(real).catch(() => null)
        if (!st || st.size > LIMITS.GREP_FILE_MAX_BYTES) return
        const text = (await safeReadFile(real, root, relaxed).catch(() => null)) ?? ""
        if (text.includes("\0")) return
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          // v7.38 (L7): baris sangat panjang dilewati di fallback. Bahkan pola yang
          // lolos pagar statis tak boleh menggantung walker pada satu baris raksasa;
          // jalur ripgrep tetap memprosesnya (regex Rust linear, tak ada ReDoS).
          if (line.length > GREP_JS_LINE_MAX_CHARS) continue
          re.lastIndex = 0
          if (re.test(line)) {
            out.push(formatGrepLine(rel, i + 1, ":", line))
            if (out.length >= limit) break
          }
        }
      },
    )
    return { lines: out, hasMore: false, matchCount: out.length }
  }

  let totalFound = 0
  const fileMatches: ContextFileMatch[] = []
  await walkWorkspaceFiles(
    {
      dir,
      root,
      signal,
      ignoreMatchers,
      relaxed,
      includeDotfiles,
      shouldStop: () => totalFound >= limit,
    },
    async ({ rel, name, real }) => {
      if (includeRe && !includeRe.test(rel) && !includeRe.test(name)) return
      if (/\.(png|jpg|jpeg|gif|webp|pdf|zip|exe|dll|bin)$/i.test(name)) return
      const st = await stat(real).catch(() => null)
      if (!st || st.size > LIMITS.GREP_FILE_MAX_BYTES) return
      const text = (await safeReadFile(real, root, relaxed).catch(() => null)) ?? ""
      if (text.includes("\0")) return
      const fileLines = text.split("\n")
      const matchIndices: number[] = []
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i]!
        if (line.length > GREP_JS_LINE_MAX_CHARS) continue
        re.lastIndex = 0
        if (re.test(line)) {
          matchIndices.push(i)
          totalFound++
          if (totalFound >= limit) break
        }
      }
      if (matchIndices.length > 0) fileMatches.push({ rel, fileLines, matchIndices })
    },
  )
  fileMatches.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const displayLimit = Math.max(0, limit - 1)
  const hasMore = totalFound > displayLimit
  const formatted: string[] = []
  let emitted = 0
  for (const fm of fileMatches) {
    if (emitted >= displayLimit) break
    const take = fm.matchIndices.slice(0, displayLimit - emitted)
    if (take.length === 0) break
    renderMatchedIndicesWithContext(
      fm.rel,
      fm.fileLines,
      take,
      ctxLines,
      formatted,
      formatted.length > 0,
    )
    emitted += take.length
  }
  return { lines: formatted, hasMore, matchCount: emitted }
}

function includeToRegExp(include: string): RegExp | null {
  if (!include) return null
  // Pakai parser glob yang sama dengan glob.ts agar brace expansion `{ts,tsx}`
  // konsisten antara mesin ripgrep (--glob) dan walker fallback JS.
  return globToRegExp(include)
}

// ── ripgrep ──
// Walker JS di atas butuh ~3,5 s untuk repo 16k LOC karena membaca tiap file
// lewat event loop. `rg` melakukan hal sama dalam puluhan milidetik. Kita pakai
// bila tersedia, tapi fallback tetap dipertahankan supaya tool ini tak pernah
// bergantung pada binary eksternal.
let rgPath: string | null | undefined

export function ripgrepAvailable(): boolean {
  if (rgPath !== undefined) return rgPath !== null
  try {
    const executable = resolveTrustedExecutable("rg")
    // Resolver fallback berupa nama telanjang tidak aman untuk workspace
    // Windows: CreateProcess dapat mencari executable bernama sama di cwd.
    // Tanpa PATH tepercaya, gunakan walker JS alih-alih mencari ulang dari cwd.
    if (!isAbsolute(executable)) {
      rgPath = null
      return false
    }
    const env = sanitizeSpawnEnv(process.env)
    delete env.RIPGREP_CONFIG_PATH
    const r = spawnSync(executable, ["--no-config", "--version"], {
      stdio: "ignore",
      timeout: 3000,
      env,
    })
    rgPath = r.status === 0 ? executable : null
  } catch {
    rgPath = null
  }
  return rgPath !== null
}

/**
 * Normalisasi satu baris keluaran `rg --vimgrep`-style (`path:line:col:text`)
 * ke format yang sama dengan walker (`path:line: text`), sekaligus scrub dan
 * cap panjang. Return null bila baris harus dibuang (sensitif / tak terparse).
 * Diekspor untuk test.
 */
export function normalizeRgLine(line: string, root: string, relaxed = false): string | null {
  // path bisa memuat ':' di Windows (C:\...), jadi cari dua ':' terakhir yang
  // diikuti angka — bukan split(':') naif.
  const m = /^(.*?):(\d+):(\d+):([\s\S]*)$/.exec(line)
  if (!m) return null
  const [, rawPath, lineNo, , text] = m
  const rel = (rawPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "")
  if (!rel) return null
  // Defense-in-depth: rg sudah dibatasi ke cwd, tapi jail tetap diterapkan
  // pada path relatif DAN absolut terhadap root (menutup `cwd: ".git"` / `.minicode`).
  const abs = resolve(root, rel)
  if ((!relaxed && isPathOutsideRoot(rel, resolve(root))) || isSensitive(rel) || isSensitive(abs))
    return null
  const body = text ?? ""
  const cut = body.length > LIMITS.GREP_MATCH_MAX_CHARS
  return `${rel}:${lineNo}: ${scrubSecrets(cut ? `${body.slice(0, LIMITS.GREP_MATCH_MAX_CHARS)}…` : body)}`
}

function decodeRgJsonText(field: { text?: string; bytes?: string } | undefined): string {
  if (!field) return ""
  if (typeof field.text === "string") return field.text
  if (typeof field.bytes === "string") {
    try {
      return Buffer.from(field.bytes, "base64").toString("utf8")
    } catch {
      return ""
    }
  }
  return ""
}

function runRipgrep(
  pattern: string,
  root: string,
  limit: number,
  signal: AbortSignal,
  include?: string,
  relaxed = false,
  ignoreCase = false,
  includeDotfiles = false,
  ctxLines = 0,
): Promise<{ lines: string[]; hasMore: boolean; matchCount: number; timedOut: boolean }> {
  const args = [
    "--no-config", // config ripgrep dapat menjalankan --pre pada berkas workspace
    ...(ctxLines > 0 ? ["--json", "--context", String(ctxLines)] : ["--vimgrep", "--no-heading"]),
    "--color=never",
    "--hidden", // tetap perlu --glob !.git di bawah
    "--no-follow", // jangan ikuti symlink (setara jail walker)
    "--max-filesize",
    String(LIMITS.GREP_FILE_MAX_BYTES),
    "--max-count",
    String(limit),
  ]
  if (ignoreCase) args.push("-i")
  // Glob include user HARUS sebelum eksklusi negatif: ripgrep mengevaluasi
  // `--glob` berdasarkan urutan terakhir yang cocok, sehingga menaruh
  // `!node_modules/**`/`!.git/**`/`!.*/**` di belakang mencegah `include: "**/*"`
  // membypass eksklusi.
  if (include) args.push("--glob", include)
  args.push("--glob", "!.git/**", "--glob", "!node_modules/**")
  if (!includeDotfiles) args.push("--glob", "!.*/**")
  args.push("--regexp", pattern, "--", ".")

  return new Promise((resolveOut, reject) => {
    // Cek abort SEBELUM spawn agar tidak memunculkan proses yatim atau
    // unhandled 'error' event saat spawn gagal sebelum listener terpasang.
    if (signal.aborted) {
      reject(new Error("aborted"))
      return
    }
    const env = sanitizeSpawnEnv(process.env)
    // Config pengguna tidak ikut diterapkan pada operasi pencarian agent.
    // --no-config tetap dipasang sebagai pagar kedua pada argv ripgrep.
    delete env.RIPGREP_CONFIG_PATH
    const p = spawn(resolveTrustedExecutable("rg"), args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    })
    const out: string[] = []
    let buf = ""
    let stderr = ""
    let done = false
    let matchCount = 0
    let hasMore = false
    let killEscalation: ReturnType<typeof setTimeout> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const displayLimit = ctxLines > 0 ? Math.max(0, limit - 1) : limit
    // Untuk mode `--json` + `-C`: tahan konteks-sebelum agar tidak bocor bila
    // match berikutnya ternyata melampaui `displayLimit`.
    let pendingBefore: Array<{ rel: string; lineNo: number; body: string }> = []
    let lastEmitted: { rel: string; lineNo: number } | null = null
    let afterRemaining = 0

    const emitFormatted = (rel: string, lineNo: number, sep: ":" | "-", body: string) => {
      if (lastEmitted && (lastEmitted.rel !== rel || lineNo > lastEmitted.lineNo + 1)) {
        out.push("--")
      }
      out.push(formatGrepLine(rel, lineNo, sep, body))
      lastEmitted = { rel, lineNo }
    }

    const terminateRg = () => {
      try {
        p.stdout.destroy()
      } catch {}
      try {
        p.kill("SIGTERM")
      } catch {}
      if (!killEscalation) {
        killEscalation = setTimeout(() => {
          try {
            p.kill("SIGKILL")
          } catch {}
        }, 500)
        killEscalation.unref?.()
      }
    }

    const finish = (fn: () => void) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (killEscalation) clearTimeout(killEscalation)
      signal.removeEventListener("abort", onAbort)
      fn()
    }
    const onAbort = () => {
      terminateRg()
      finish(() => reject(new Error("aborted")))
    }
    p.on("error", (e) => {
      finish(() => reject(e))
    })
    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      terminateRg()
      finish(() => {
        // v7.32 (L6): marker timeout HARUS selalu ada, termasuk saat nol hit.
        // Dulu marker hanya ditambah bila ada sebagian hasil, sehingga timeout
        // dengan 0 match salah dilaporkan sebagai "no matches" (miss asli).
        // Pemanggil membedakan lewat prefix marker yang sama dengan jalur
        // hasil sebagian (dikenali withCapMark).
        if (ctxLines === 0) out.push(RIPGREP_TIMEOUT_MARKER)
        resolveOut({ lines: out, hasMore, matchCount, timedOut: true })
      })
    }, LIMITS.GREP_RIPGREP_TIMEOUT_MS)
    timer.unref?.()

    const consumeLine = (line: string): boolean => {
      if (ctxLines === 0) {
        if (out.length >= limit) return false
        const norm = normalizeRgLine(line, root, relaxed)
        if (norm) {
          out.push(norm)
          matchCount++
        }
        if (out.length >= limit) {
          p.kill("SIGTERM")
          return false
        }
        return true
      }
      if (!line.trim()) return true
      let ev: {
        type?: string
        data?: {
          path?: { text?: string; bytes?: string }
          line_number?: number
          lines?: { text?: string; bytes?: string }
        }
      }
      try {
        ev = JSON.parse(line)
      } catch {
        return true
      }
      if (ev.type !== "match" && ev.type !== "context") return true
      const rawPath = decodeRgJsonText(ev.data?.path)
      const rel = rawPath.replace(/\\/g, "/").replace(/^\.\//, "")
      const lineNo = ev.data?.line_number
      if (!rel || typeof lineNo !== "number") return true
      const absPath = resolve(root, rel)
      if (
        (!relaxed && isPathOutsideRoot(rel, resolve(root))) ||
        isSensitive(rel) ||
        isSensitive(absPath)
      )
        return true
      const body = decodeRgJsonText(ev.data?.lines).replace(/[\r\n]+$/, "")
      if (ev.type === "context") {
        if (
          lastEmitted &&
          lastEmitted.rel === rel &&
          lineNo === lastEmitted.lineNo + 1 &&
          afterRemaining > 0
        ) {
          emitFormatted(rel, lineNo, "-", body)
          afterRemaining--
        } else if (matchCount < displayLimit) {
          pendingBefore = pendingBefore.filter((x) => x.rel === rel)
          pendingBefore.push({ rel, lineNo, body })
          if (pendingBefore.length > ctxLines) pendingBefore.shift()
        }
        return true
      }
      // ev.type === "match"
      matchCount++
      if (matchCount > displayLimit) {
        hasMore = true
        terminateRg()
        return false
      }
      for (const b of pendingBefore) {
        if (b.rel === rel) emitFormatted(b.rel, b.lineNo, "-", b.body)
      }
      pendingBefore = []
      emitFormatted(rel, lineNo, ":", body)
      afterRemaining = ctxLines
      return true
    }

    p.stdout.on("data", (d: Buffer) => {
      if (done) return
      const prevLen = buf.length
      buf += d.toString()
      let scanFrom = prevLen
      let lineStart = 0
      let idx = buf.indexOf("\n", scanFrom)
      while (idx >= 0) {
        const line = buf.slice(lineStart, idx).replace(/\r$/, "")
        lineStart = idx + 1
        scanFrom = lineStart
        if (!consumeLine(line)) {
          buf = ""
          return
        }
        idx = buf.indexOf("\n", scanFrom)
      }
      if (lineStart > 0) buf = buf.slice(lineStart)
    })
    p.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString()
    })
    p.on("close", (code) => {
      if (!done && buf.trim()) consumeLine(buf.replace(/\r$/, ""))
      // rg: 0 = ada match, 1 = tak ada match, 2 = error (mis. regex invalid)
      if (code === 2 && out.length === 0) {
        finish(() => reject(new Error(stderr.trim() || "ripgrep failed")))
        return
      }
      finish(() => resolveOut({ lines: out, hasMore, matchCount, timedOut: false }))
    })
  })
}

export function formatContextCapMark(
  lines: readonly string[],
  hasMore: boolean,
  timedOut: boolean,
  lim: number,
): string {
  const parts = [...lines]
  if (timedOut) parts.push(RIPGREP_TIMEOUT_MARKER)
  if (hasMore) {
    parts.push(`… [truncated: showing first ${lim} matches — refine pattern/include]`)
  }
  return parts.join("\n")
}

export const grepTool: Tool = {
  name: "grep",
  // v7.33 (wire contract): tag family untuk grouping di model.
  description:
    "FILE SEARCH: Search a regex across files or a single `path`; supports `contextLines` (0-10 before/after). Returns file:line: content, capped at 100/500 matches. Prefer `path` + `contextLines` over bash grep/sed. Skips .git, node_modules, dotfiles; no symlink follow.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "regex pattern (e.g. log.*Error)" },
      path: {
        type: "string",
        description:
          "optional file or directory path relative to the workspace (use instead of bash grep/sed)",
      },
      cwd: { type: "string", description: "root directory (default: workspace root)" },
      include: { type: "string", description: "file glob filter (e.g. *.ts or *.{ts,tsx})" },
      limit: { type: "number" },
      caseInsensitive: {
        type: "boolean",
        description: "ignore case when matching (default false)",
      },
      includeDotfiles: {
        type: "boolean",
        description: "include dotfiles/dotdirs like .github (default false)",
      },
      contextLines: {
        type: "number",
        description: "lines of before/after context per match (0-10, default 0)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(
    { pattern, path, cwd, include, limit, caseInsensitive, includeDotfiles, contextLines },
    ctx,
  ) {
    const baseRoot = resolveSearchRoot(cwd, ctx)
    const sessionRoot = requireToolCwd(ctx)
    const relaxed = baseRoot.relaxed
    const rawLim = limit as number | undefined
    const lim = Number.isFinite(rawLim)
      ? Math.min(Math.max(Math.floor(rawLim!), 1), LIMITS.SEARCH_MAX_LIMIT)
      : LIMITS.SEARCH_DEFAULT_LIMIT
    const rawCtx = contextLines as number | undefined
    const ctxLines = Number.isFinite(rawCtx) ? Math.min(Math.max(Math.floor(rawCtx!), 0), 10) : 0
    const rawPat = pattern as string
    const inlineIgnoreCase = rawPat.startsWith("(?i)")
    const pat = inlineIgnoreCase ? rawPat.slice(4) : rawPat
    const ignoreCase = caseInsensitive === true || inlineIgnoreCase
    // Validasi regex di JS lebih dulu: pesan errornya jelas dan berlaku untuk
    // kedua jalur. Prefix `(?i)` dikonversi ke flag `i` agar sintaks umum PCRE
    // tidak ditolak oleh JS RegExp sebelum mencapai ripgrep.
    let re: RegExp
    try {
      re = new RegExp(pat, ignoreCase ? "i" : "")
    } catch (e) {
      throw new Error(`invalid regex: ${(e as Error).message}`)
    }

    const rawPath = typeof path === "string" && path.trim() !== "" ? path.trim() : undefined
    let root = baseRoot.root
    let rawRoot = baseRoot.rawRoot
    if (!relaxed && (isSensitive(root) || isSensitiveReal(root, sessionRoot))) {
      throw new Error(`cannot search sensitive directory: ${rawRoot}`)
    }

    if (rawPath) {
      const targetAbs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(baseRoot.root, rawPath)
      if (
        !relaxed &&
        (isPathOutsideRoot(targetAbs, sessionRoot) || isCwdOutsideRoot(rawPath, sessionRoot))
      ) {
        throw new Error(`path outside workspace: ${rawPath}`)
      }
      const relTarget = relative(sessionRoot, targetAbs).replace(/\\/g, "/") || "."
      if (!relaxed && (isSensitive(targetAbs) || isSensitive(relTarget))) {
        throw new Error(`cannot search sensitive file: ${rawPath}`)
      }
      const targetSt = await stat(targetAbs).catch(() => null)
      if (!targetSt) throw new Error(`file not found: ${rawPath}`)
      const realTarget = await realpath(targetAbs).catch(() => targetAbs)
      if (!relaxed && isRealPathOutsideRoot(realTarget, sessionRoot)) {
        throw new Error(`path outside workspace: ${rawPath}`)
      }
      if (!relaxed && isSensitive(realTarget)) {
        throw new Error(`cannot search sensitive file: ${rawPath}`)
      }
      if (targetSt.isFile()) {
        const redosError = redosGuardMessage(pat)
        if (redosError !== null) throw new Error(redosError)
        const relDisplay = relative(baseRoot.root, targetAbs).replace(/\\/g, "/") || relTarget
        const single = await grepSingleFile({
          real: realTarget,
          rel: relDisplay,
          sessionRoot,
          re,
          limit: lim,
          ctxLines,
          relaxed,
        })
        if (single.matchCount === 0) {
          return `no matches for /${rawPat}/ in ${rawPath} — broaden pattern or check another file`
        }
        return ctxLines > 0
          ? formatContextCapMark(single.lines, single.hasMore, false, lim)
          : single.hasMore
            ? `${single.lines.join("\n")}\n… [truncated: showing first ${lim} matches — refine pattern/include]`
            : single.lines.join("\n")
      }
      root = targetAbs
      rawRoot = rawPath
    }

    // v7.33 (wire contract): hasil kosong butuh langkah lanjutan yang jelas —
    // tanpa ini model mengulang pola/include yang sama persis.
    const noMatch = () =>
      `no matches for /${rawPat}/ in ${rawRoot}${include ? ` (include ${include})` : ""} — broaden pattern or drop include`
    const st = await stat(root).catch(() => null)
    if (!st?.isDirectory()) return noMatch()
    const withDotfiles = includeDotfiles === true

    // Minta satu lebih agar tahu pasti apakah hasil terpotong (temuan #02:
    // limit-hit diam-diam tampak lengkap). Tampilkan tetap `lim`.
    const want = lim + 1
    if (process.env.MINICODE_GREP_ENGINE !== "js" && ripgrepAvailable()) {
      try {
        const rg = await runRipgrep(
          pat,
          root,
          want,
          ctx.signal,
          include as string | undefined,
          relaxed,
          ignoreCase,
          withDotfiles,
          ctxLines,
        )
        if (ctxLines === 0) {
          // v7.32 (L6): rg timeout dengan nol match menyisakan SATU marker —
          // bedakan dari "no matches" sungguhan supaya model tak mengira pola
          // memang tak ada (padahal pencarian cuma kehabisan waktu).
          if (rg.lines.length === 1 && rg.lines[0]!.startsWith(RIPGREP_TIMEOUT_MARKER))
            return ripgrepTimeoutEmptyMessage(rawPat, rawRoot)
          if (rg.lines.length === 0) return noMatch()
          return withCapMark(rg.lines, lim)
        }
        if (rg.timedOut && rg.matchCount === 0) return ripgrepTimeoutEmptyMessage(rawPat, rawRoot)
        if (rg.matchCount === 0) return noMatch()
        return formatContextCapMark(rg.lines, rg.hasMore, rg.timedOut, lim)
      } catch (e) {
        if ((e as Error).message === "aborted") throw e
        // rg gagal (regex flavour berbeda, binary rusak, permission) → fallback
        process.stderr.write(
          `[warn] grep: ripgrep failed (${(e as Error).message}) — fallback JS\n`,
        )
      }
    }

    // v7.38 (L7): pagar ReDoS HANYA untuk jalur fallback JS. Jalur ripgrep
    // (regex Rust linear) sudah return di atas dan tak pernah terkena pagar ini.
    // Lempar Error supaya kernel menandai isError, konsisten dengan "invalid regex".
    const redosError = redosGuardMessage(pat)
    if (redosError !== null) throw new Error(redosError)

    const incRe = include ? includeToRegExp(include as string) : null
    const ignoreMatchers = await loadIgnoreMatchers(root)
    const out: string[] = []
    const walked = await walkGrep(
      root,
      re,
      out,
      root,
      want,
      ctx.signal,
      incRe,
      ignoreMatchers,
      relaxed,
      withDotfiles,
      ctxLines,
    )
    if (ctxLines === 0) {
      // v7.32 (L4): walker memakai urutan readdir yang tak stabil — sort supaya
      // hasil fallback JS deterministik (sama seperti jalur glob/ripgrep).
      out.sort()
      return out.length === 0 ? noMatch() : withCapMark(out, lim)
    }
    return walked.matchCount === 0
      ? noMatch()
      : formatContextCapMark(walked.lines, walked.hasMore, false, lim)
  },
}

// Tandai bila hasil mencapai cap (suffix timeout rg dipertahankan duluan).
export function withCapMark(hits: string[], lim: number): string {
  const body = [...hits]
  let suffix = ""
  const last = body[body.length - 1]
  if (typeof last === "string" && last.startsWith(RIPGREP_TIMEOUT_PREFIX)) {
    suffix = `\n${body.pop()}`
  }
  if (body.length > lim) {
    return `${body.slice(0, lim).join("\n")}${suffix}\n… [truncated: showing first ${lim} matches — refine pattern/include]`
  }
  return body.join("\n") + suffix
}
