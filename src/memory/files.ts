import { appendFile, lstat, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { homeDir } from "../lib/db-path.ts"
import { assertSafeWriteTarget, safeReadFileCapped } from "../lib/safe-open.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"

function tildePath(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

// Jalur global DIHITUNG per panggil (bukan const modul): homeDir() hormat
// MINICODE_HOME saat runtime (hermetic test + XDG-ish, sama seperti DB).
// Const modul akan membekukan home saat import pertama (audit 2026-09-16 M4).
const globalMemPath = (): string => join(homeDir(), ".minicode", "MEMORY.md")
const LOCAL_MEM = ".minicode/MEMORY.md"
const ROOT_MEM = "MEMORY.md"
// Claude-like hierarchy extensions
const CLAUDE_MEM = "CLAUDE.md"

export async function loadMemoryFiles(
  cwd = process.cwd(),
  opts: { allowLocalRules?: boolean } = {},
): Promise<string> {
  const parts: string[] = []
  const globalMem = globalMemPath()
  // Hierarchy: global → local → root → CLAUDE compat → rules/
  const candidates = [
    globalMem,
    resolve(cwd, LOCAL_MEM),
    resolve(cwd, ROOT_MEM),
    resolve(cwd, CLAUDE_MEM),
  ]
  for (const p of candidates) {
    try {
      // Symlink escape (temuan audit #06): kandidat fixed-name bisa berupa
      // symlink keluar workspace. globalMem (home) sengaja dikecualikan —
      // di luar cwd by design. Samakan rules/ di bawah ke realpath.
      if (p !== globalMem && isRealPathOutsideRoot(p, cwd)) continue
      const { text, truncated } = await safeReadFileCapped(
        p,
        p === globalMem ? dirname(p) : cwd,
        6000,
      )
      if (text.trim())
        parts.push(
          `# ${tildePath(p)}\n${scrubSecrets(text)}${truncated ? "\n… [truncated: showing first 6000 bytes]" : ""}`,
        )
    } catch {}
  }
  // Load .minicode/rules/*.md (Kiro steering style) — hanya aktif bila
  // local config diizinkan (`--allow-local-config`), selaras dengan .minicode/skills/.
  if (opts.allowLocalRules === true) {
    try {
      const { readdir } = await import("node:fs/promises")
      const rulesDir = resolve(cwd, ".minicode/rules")
      const entries = await readdir(rulesDir).catch(() => [] as string[])
      // entries may be string[] or Dirent — handle both
      const files: string[] =
        Array.isArray(entries) && typeof entries[0] === "string"
          ? (entries as string[]).filter((f) => f.endsWith(".md")).slice(0, 10)
          : (entries as unknown as import("node:fs").Dirent[])
              .filter((e) => e.isFile() && e.name.endsWith(".md"))
              .map((e) => e.name)
              .slice(0, 10)
      for (const f of files) {
        try {
          const full = join(rulesDir, f as string)
          if (isRealPathOutsideRoot(full, cwd)) continue
          const { text, truncated } = await safeReadFileCapped(full, cwd, 3000)
          if (text.trim())
            parts.push(
              `# rules/${f}\n${scrubSecrets(text)}${truncated ? "\n… [truncated: showing first 3000 bytes]" : ""}`,
            )
        } catch {}
      }
    } catch {}
  }
  return parts.join("\n\n")
}

const MAX_MEMORY_FILE_BYTES = LIMITS.MEMORY_FILE_MAX_BYTES

// Kunci in-process per berkas (audit #09 P1): appendMemory (append +
// truncate-guard read-modify-write) dan deleteMemoryLines (read-filter-write)
// serta reconcileMemoryStores/revokeByProvenance berbagi lock ini agar tak
// saling menelan.
const memLocks = new Map<string, Promise<void>>()

export async function withMemLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = memLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => (release = res))
  const tail = prev.then(() => next)
  memLocks.set(path, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (memLocks.get(path) === tail) memLocks.delete(path)
  }
}

/** Cegah symlink/hardlink escape sebelum baca/tulis MEMORY.md. */
export async function assertSafeMemoryPath(path: string, root: string): Promise<void> {
  await assertSafeWriteTarget(path, root)
  try {
    const st = await lstat(path)
    if (st.isSymbolicLink() || st.nlink > 1) {
      throw new Error(`unsafe memory target (symlink or hardlink): ${path}`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
}

export async function safeReadMemoryFile(path: string, root: string): Promise<string> {
  await assertSafeMemoryPath(path, root)
  return await readFile(path, "utf8")
}

async function safeAtomicWriteMemory(path: string, root: string, content: string): Promise<void> {
  const { atomicWriteText } = await import("../lib/atomic-write.ts")
  await assertSafeMemoryPath(path, root)
  await atomicWriteText(path, content)
}

function sanitizeMemoryTags(tags?: readonly string[]): string[] | undefined {
  if (!tags?.length) return undefined
  return tags.map((tg) => scrubSecrets(String(tg)).replace(/[\r\n]+/g, " "))
}

export async function appendMemoryUnlocked(
  text: string,
  cwd = process.cwd(),
  tags?: readonly string[],
): Promise<string> {
  const path = resolve(cwd, LOCAL_MEM)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
  await assertSafeMemoryPath(path, cwd)
  // Ratakan newline agar satu entri tetap satu baris & tidak memecah parser.
  const clean = scrubSecrets(text.trim()).replace(/[\r\n]+/g, " ")
  const safeTags = sanitizeMemoryTags(tags)
  const meta = safeTags?.length ? ` [tags: ${JSON.stringify(safeTags)}]` : ""
  const entry = `- ${new Date().toISOString().slice(0, 10)} ${clean}${meta}\n`
  await appendFile(path, entry, "utf8").catch(async () => {
    await mkdir(dirname(path), { recursive: true })
    await assertSafeMemoryPath(path, cwd)
    await appendFile(path, entry, "utf8")
  })
  try {
    const txt = await safeReadMemoryFile(path, cwd)
    const buf = Buffer.from(txt, "utf8")
    if (buf.byteLength > MAX_MEMORY_FILE_BYTES) {
      const rawKeep = buf.subarray(-LIMITS.MEMORY_TRUNCATE_KEEP_BYTES).toString("utf8")
      const entryBoundary = rawKeep.indexOf("\n- ")
      const cut = entryBoundary >= 0 ? entryBoundary + 1 : rawKeep.indexOf("\n")
      const trimmed = cut >= 0 ? rawKeep.slice(cut + (entryBoundary >= 0 ? 0 : 1)) : rawKeep
      await safeAtomicWriteMemory(path, cwd, trimmed)
    }
  } catch {}
  return path
}

export async function appendMemory(
  text: string,
  cwd = process.cwd(),
  tags?: readonly string[],
): Promise<string> {
  const path = resolve(cwd, LOCAL_MEM)
  return withMemLock(path, () => appendMemoryUnlocked(text, cwd, tags))
}

export async function readMemoryFile(cwd = process.cwd()): Promise<string> {
  return await loadMemoryFiles(cwd)
}

/** Parser baris MEMORY.md terpusat (dipakai files.ts & vector.ts). */
export function parseMemoryLine(line: string): { text: string; tags: string[] } | null {
  if (!line.startsWith("- ")) return null
  const match = line.match(/^-\s+\d{4}-\d{2}-\d{2}(?:T\S+)?\s+(.+)$/)
  const body = (match ? match[1]! : line.trim().replace(/^-\s+\S+\s+/, "")).trim()
  if (!body) return null
  const jsonTagMatch = body.match(/\s*\[tags:\s*(\[.*\])\]\s*$/)
  if (jsonTagMatch) {
    try {
      const parsed = JSON.parse(jsonTagMatch[1]!)
      if (Array.isArray(parsed)) {
        return {
          text: body.slice(0, jsonTagMatch.index!).trim(),
          tags: parsed.map((item) => String(item)),
        }
      }
    } catch {}
  }
  const tagMatch = body.match(/\[tags:\s*[^\]]+\]/)
  return {
    text: (tagMatch ? body.slice(0, tagMatch.index!) : body).trim(),
    tags: [],
  }
}

export function memoryLineText(line: string): string {
  return parseMemoryLine(line)?.text ?? ""
}

export async function deleteMemoryEntryUnlocked(
  target: string,
  cwd = process.cwd(),
): Promise<boolean> {
  const needle = target.trim().replace(/[\r\n]+/g, " ")
  if (!needle) return false
  const path = resolve(cwd, LOCAL_MEM)
  let txt: string
  try {
    txt = await safeReadMemoryFile(path, cwd)
  } catch {
    return false
  }
  const lines = txt.split("\n")
  let removed = 0
  const kept = lines.filter((line) => {
    if (!line.startsWith("- ")) return true
    const text = memoryLineText(line)
    const hit = text === needle || (needle.length >= 200 && text.startsWith(needle))
    if (hit) removed++
    return !hit
  })
  if (removed === 0) return false
  await safeAtomicWriteMemory(path, cwd, kept.join("\n"))
  return true
}

export async function deleteMemoryEntry(target: string, cwd = process.cwd()): Promise<boolean> {
  const needle = target.trim().replace(/[\r\n]+/g, " ")
  if (!needle) return false
  const path = resolve(cwd, LOCAL_MEM)
  return withMemLock(path, () => deleteMemoryEntryUnlocked(needle, cwd))
}

export async function deleteMemoryLines(query: string, cwd = process.cwd()): Promise<number> {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  let total = 0
  const globalMem = globalMemPath()
  for (const path of [resolve(cwd, LOCAL_MEM), globalMem]) {
    const root = path === globalMem ? dirname(path) : cwd
    total += await withMemLock(path, async () => {
      let txt: string
      try {
        txt = await safeReadMemoryFile(path, root)
      } catch {
        return 0
      }
      const lines = txt.split("\n")
      const kept = lines.filter((l) => !l.toLowerCase().includes(q))
      const deleted = lines.length - kept.length
      if (deleted === 0) return 0
      await safeAtomicWriteMemory(path, root, kept.join("\n"))
      return deleted
    })
  }
  return total
}
