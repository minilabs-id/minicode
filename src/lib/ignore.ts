import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

/**
 * Subset jujur .gitignore — nama persis, `*.ext`, prefix `dir/`.
 * Tanpa negasi `!` (didokumentasikan sebagai batas). Dipakai glob/grep
 * agar tidak memuntahkan `node_modules`/`dist` yang tak relevan meski
 * walker sudah skip hard-coded.
 * Pure kecuali load di helper; matcher bisa diuji tanpa FS.
 */
const MAX_IGNORE_PATTERNS = 2000
const MAX_IGNORE_FILE_BYTES = 256 * 1024
const MAX_WILDCARDS_PER_PATTERN = 4

export function compileIgnoreMatchers(patterns: string[]): ((rel: string) => boolean)[] {
  const matchers: ((rel: string) => boolean)[] = []
  for (const raw of patterns) {
    if (matchers.length >= MAX_IGNORE_PATTERNS) break
    const pat = raw.trim()
    if (!pat || pat.startsWith("#") || pat.startsWith("!") || pat.length > 512) continue
    const isDir = pat.endsWith("/")
    const core = isDir ? pat.slice(0, -1) : pat
    const hasSlash = core.includes("/")
    // Kolaps pengulangan wildcard (`***`, `**/**`, `**/**/`) sebelum dikompilasi
    // agar .gitignore dari repo asing tidak memicu backtracking eksponensial (ReDoS).
    const normalized = core
      .replace(/^\//, "")
      .replace(/\*{3,}/g, "**")
      .replace(/(?:\*\*\/){2,}/g, "**/")
      .replace(/(?:\*\*)+/g, "**")
    const starRuns = normalized.match(/\*+/g)?.length ?? 0
    if (starRuns > MAX_WILDCARDS_PER_PATTERN) continue
    // Build regex via glob simple: * -> [^/]*, ** -> .* (pakai placeholder agar ** tidak rusak oleh * berikutnya)
    const escapeGlob = (s: string) =>
      s
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§/g, ".*")
        .replace(/\?/g, ".")
    if (hasSlash) {
      // path pattern: cocok terhadap rel path (anchored)
      const re = new RegExp(`^${escapeGlob(normalized)}${isDir ? "(?:/.*)?" : ""}$`)
      matchers.push((rel) => re.test(rel))
    } else {
      // basename pattern: cocok bagian mana pun
      const re = new RegExp(`^${escapeGlob(normalized)}$`)
      matchers.push((rel) => {
        const parts = rel.split("/")
        if (isDir) return parts.includes(normalized) || re.test(parts[parts.length - 1] ?? "")
        return parts.some((seg) => re.test(seg))
      })
    }
  }
  return matchers
}

export function isIgnored(rel: string, matchers: ((rel: string) => boolean)[]): boolean {
  for (const m of matchers) if (m(rel)) return true
  return false
}

export async function loadIgnoreMatchers(root: string): Promise<((rel: string) => boolean)[]> {
  try {
    const txt = await readFile(resolve(root, ".gitignore"), "utf8")
    const bounded = txt.length > MAX_IGNORE_FILE_BYTES ? txt.slice(0, MAX_IGNORE_FILE_BYTES) : txt
    const lines = bounded.split("\n")
    return compileIgnoreMatchers(lines)
  } catch {
    return []
  }
}
