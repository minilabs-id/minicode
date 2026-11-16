import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { safeReadFileCapped } from "../lib/safe-open.ts"
import { isPathOutsideRoot, isSensitive } from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"

const MAX_INJECT = 2_000
const MENTION_TOKEN_RE = /(^|[\s([{"'])@([^\s]+)/g
const TRAILING_PUNCT_RE = /[,.;:)\]"']+$/

interface MentionSpan {
  readonly path: string
  readonly start: number
  readonly end: number
}

function collectMentionSpans(line: string): MentionSpan[] {
  const spans: MentionSpan[] = []
  for (const m of line.matchAll(MENTION_TOKEN_RE)) {
    const prefixLen = m[1]?.length ?? 0
    const rawToken = m[2]!
    const cleaned = rawToken.replace(TRAILING_PUNCT_RE, "")
    if (!cleaned) continue
    // Lewati dotfile tersembunyi (@.env, @., @..), izinkan jalur relatif eksplisit ./
    if (cleaned.startsWith(".") && !cleaned.startsWith("./")) continue
    const start = (m.index ?? 0) + prefixLen
    spans.push({ path: cleaned, start, end: start + 1 + cleaned.length })
  }
  return spans
}

/** Ambil @mentions dari line → ganti dengan blok konteks file. */
export function parseMentions(line: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const span of collectMentionSpans(line)) {
    if (seen.has(span.path)) continue
    seen.add(span.path)
    out.push(span.path)
  }
  return out
}

export async function resolveMentionContent(
  raw: string,
  cwd: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  if (isPathOutsideRoot(abs, cwd) || isSensitive(abs))
    return { ok: false, reason: "rejected (jail)" }
  try {
    const [real, realRoot] = await Promise.all([realpath(abs), realpath(cwd)])
    if (isPathOutsideRoot(real, realRoot) || isSensitive(real))
      return { ok: false, reason: "rejected (jail)" }
    const { text: txt, truncated } = await safeReadFileCapped(real, realRoot, MAX_INJECT)
    const rel = relative(realRoot, real).replace(/\\/g, "/")
    // Netralkan penutup tag agar isi file tak memalsukan batas blok.
    const safeBody = scrubSecrets(txt).replace(/\[\/file\]/gi, "[\\/file]")
    const body = truncated ? `${safeBody}\n… (truncated: first ${MAX_INJECT} bytes)` : safeBody
    return { ok: true, content: `\n[file: ${rel}]\n${body}\n[/file]\n` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "file not found" }
    const msg = err instanceof Error ? err.message : ""
    if (/non-regular/i.test(msg)) return { ok: false, reason: "rejected (not a regular file)" }
    if (/symlink|hardlink|sensitive|outside/i.test(msg) || code === "EACCES" || code === "EPERM") {
      return { ok: false, reason: "rejected (unsafe or inaccessible target)" }
    }
    return { ok: false, reason: "file unreadable" }
  }
}

export async function expandMentions(
  line: string,
  cwd: string,
): Promise<{ prompt: string; notes: string[] }> {
  const spans = collectMentionSpans(line)
  if (spans.length === 0) return { prompt: line, notes: [] }
  const cache = new Map<string, Awaited<ReturnType<typeof resolveMentionContent>>>()
  const notes: string[] = []
  for (const span of spans) {
    if (cache.has(span.path)) continue
    const r = await resolveMentionContent(span.path, cwd)
    cache.set(span.path, r)
    if (!r.ok) notes.push(`@${span.path}: ${r.reason}`)
  }
  // Single-pass atas indeks asal agar `@token` di dalam isi file tidak terekspansi ulang.
  const chunks: string[] = []
  let cursor = 0
  for (const span of spans) {
    const res = cache.get(span.path)!
    if (!res.ok) continue
    chunks.push(line.slice(cursor, span.start), res.content)
    cursor = span.end
  }
  chunks.push(line.slice(cursor))
  return { prompt: chunks.join(""), notes }
}
