import { spawn, spawnSync } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { loadIgnoreMatchers } from "../lib/ignore.ts"
import { safeReadFile } from "../lib/safe-open.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { isPathOutsideRoot, isSensitive } from "../policy/jail.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { resolveSearchRoot, walkWorkspaceFiles } from "./context.ts"
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
) {
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
          const body = line
          const cut = body.length > LIMITS.GREP_MATCH_MAX_CHARS
          out.push(
            `${rel}:${i + 1}: ${scrubSecrets(cut ? `${body.slice(0, LIMITS.GREP_MATCH_MAX_CHARS)}…` : body)}`,
          )
          if (out.length >= limit) break
        }
      }
    },
  )
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
  // supaya hasil identik dengan fallback (symlink/sensitive tetap dibuang).
  if ((!relaxed && isPathOutsideRoot(rel, resolve(root))) || isSensitive(rel)) return null
  const body = text ?? ""
  const cut = body.length > LIMITS.GREP_MATCH_MAX_CHARS
  return `${rel}:${lineNo}: ${scrubSecrets(cut ? `${body.slice(0, LIMITS.GREP_MATCH_MAX_CHARS)}…` : body)}`
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
): Promise<string[]> {
  const args = [
    "--no-config", // config ripgrep dapat menjalankan --pre pada berkas workspace
    "--vimgrep", // path:line:col:text
    "--no-heading",
    "--color=never",
    "--hidden", // tetap perlu --glob !.git di bawah
    "--no-follow", // jangan ikuti symlink (setara jail walker)
    "--max-filesize",
    String(LIMITS.GREP_FILE_MAX_BYTES),
    "--max-count",
    String(limit),
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
  ]
  if (!includeDotfiles) args.push("--glob", "!.*/**")
  if (ignoreCase) args.push("-i")
  if (include) args.push("--glob", include)
  args.push("--regexp", pattern, "--", ".")

  return new Promise((resolveOut, reject) => {
    const env = sanitizeSpawnEnv(process.env)
    // Config pengguna tidak ikut diterapkan pada operasi pencarian agent.
    // --no-config tetap dipasang sebagai pagar kedua pada argv ripgrep.
    delete env.RIPGREP_CONFIG_PATH
    const p = spawn(resolveTrustedExecutable("rg"), args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
    const out: string[] = []
    let buf = ""
    let stderr = ""
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      fn()
    }
    const onAbort = () => {
      p.kill("SIGTERM")
      finish(() => reject(new Error("aborted")))
    }
    if (signal.aborted) {
      p.kill("SIGTERM")
      return reject(new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      p.kill("SIGTERM")
      finish(() => {
        // v7.32 (L6): marker timeout HARUS selalu ada, termasuk saat nol hit.
        // Dulu marker hanya ditambah bila ada sebagian hasil, sehingga timeout
        // dengan 0 match salah dilaporkan sebagai "no matches" (miss asli).
        // Pemanggil membedakan lewat prefix marker yang sama dengan jalur
        // hasil sebagian (dikenali withCapMark).
        out.push(RIPGREP_TIMEOUT_MARKER)
        resolveOut(out)
      })
    }, LIMITS.GREP_RIPGREP_TIMEOUT_MS)

    p.stdout.on("data", (d: Buffer) => {
      if (out.length >= limit) return
      buf += d.toString()
      let idx = buf.indexOf("\n")
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "")
        buf = buf.slice(idx + 1)
        const norm = normalizeRgLine(line, root, relaxed)
        if (norm) out.push(norm)
        if (out.length >= limit) {
          p.kill("SIGTERM")
          break
        }
        idx = buf.indexOf("\n")
      }
    })
    p.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString()
    })
    p.on("error", (e) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      finish(() => reject(e))
    })
    p.on("close", (code) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      // rg: 0 = ada match, 1 = tak ada match, 2 = error (mis. regex invalid)
      if (code === 2 && out.length === 0) {
        finish(() => reject(new Error(stderr.trim() || "ripgrep failed")))
        return
      }
      finish(() => resolveOut(out))
    })
  })
}

export const grepTool: Tool = {
  name: "grep",
  // v7.33 (wire contract): tag family untuk grouping di model.
  description:
    "FILE SEARCH: Search a regex across files; returns file:line: content, capped at 100/500 matches. Skips .git, node_modules, dotfiles; no symlink follow. Use to locate symbols/patterns before reading files.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "regex pattern (e.g. log.*Error)" },
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
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute({ pattern, cwd, include, limit, caseInsensitive, includeDotfiles }, ctx) {
    const { root, rawRoot, relaxed } = resolveSearchRoot(cwd, ctx)
    const rawLim = limit as number | undefined
    const lim = Number.isFinite(rawLim)
      ? Math.min(Math.max(Math.floor(rawLim!), 1), LIMITS.SEARCH_MAX_LIMIT)
      : LIMITS.SEARCH_DEFAULT_LIMIT
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
        const hits = await runRipgrep(
          pat,
          root,
          want,
          ctx.signal,
          include as string | undefined,
          relaxed,
          ignoreCase,
          withDotfiles,
        )
        // v7.32 (L6): rg timeout dengan nol match menyisakan SATU marker —
        // bedakan dari "no matches" sungguhan supaya model tak mengira pola
        // memang tak ada (padahal pencarian cuma kehabisan waktu).
        if (hits.length === 1 && hits[0]!.startsWith(RIPGREP_TIMEOUT_MARKER))
          return ripgrepTimeoutEmptyMessage(rawPat, rawRoot)
        if (hits.length === 0) return noMatch()
        return withCapMark(hits, lim)
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
    await walkGrep(
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
    )
    // v7.32 (L4): walker memakai urutan readdir yang tak stabil — sort supaya
    // hasil fallback JS deterministik (sama seperti jalur glob/ripgrep).
    out.sort()
    return out.length === 0 ? noMatch() : withCapMark(out, lim)
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
