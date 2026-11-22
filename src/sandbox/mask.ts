import {
  chmodSync,
  type Dirent,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

/** Template env publik non-rahasia yang tetap diizinkan terbaca di sandbox (Opsi A). */
export const SAFE_ENV_TEMPLATES: ReadonlySet<string> = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
])

const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".minicode",
  "dist",
  "build",
])
const MAX_SCAN_DIRS = 500
const MAX_SCAN_DEPTH = 3

/** Apakah nama file termasuk berkas `.env*` sensitif yang wajib dimasking. */
export function isSensitiveEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SAFE_ENV_TEMPLATES.has(lower)) return false
  return lower === ".env" || lower.startsWith(".env.")
}

export interface SandboxMaskTargets {
  readonly hasMinicode: boolean
  /** Path relatif berformat POSIX terhadap workspace root (`".env"`, `"apps/a/.env.local"`). */
  readonly envFiles: readonly string[]
}

/**
 * Temukan `.minicode/` dan file `.env*` sensitif yang BENAR-BENAR ada di workspace.
 * Hanya mengembalikan path yang sudah eksis agar bind-mount read-only tidak pernah
 * menciptakan entri `.env` kosong di host.
 */
export function discoverSandboxMaskTargets(cwd: string): SandboxMaskTargets {
  const abs = resolve(cwd)
  let hasMinicode = false
  try {
    hasMinicode = existsSync(join(abs, ".minicode"))
  } catch {
    hasMinicode = false
  }
  const envFiles: string[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: abs, depth: 0 }]
  let visitedDirs = 0

  while (queue.length > 0 && visitedDirs < MAX_SCAN_DIRS) {
    const { dir, depth } = queue.shift()!
    visitedDirs++
    let entries: Dirent[]
    try {
      // E-9: `readdirSync(..., { withFileTypes: true })` sudah membawa tipe
      // entri dari syscall yang sama. Memanggil `lstatSync` per entri menambah
      // ratusan syscall (baseline ~15ms) — di sini cukup sekali readdir per
      // direktori. `Dirent.isSymbolicLink()` tetap mendeteksi symlink tanpa
      // mengikuti targetnya (perilaku lstat lama dipertahankan persis).
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const name = ent.name
      const full = join(dir, name)
      if (ent.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(name)) {
          queue.push({ dir: full, depth: depth + 1 })
        }
        continue
      }
      if ((ent.isFile() || ent.isSymbolicLink()) && isSensitiveEnvFileName(name)) {
        const rel = relative(abs, full).replace(/\\/g, "/")
        if (rel && !rel.startsWith("..")) envFiles.push(rel)
      }
    }
  }
  envFiles.sort()
  return { hasMinicode, envFiles }
}

/**
 * Buat satu berkas kosong read-only (0 byte) di tempdir host untuk memasking
 * file `.env*` di dalam Docker/bwrap, lengkap dengan fungsi pembersihan idempoten.
 */
export function allocateEmptyMaskFile(needed: boolean): {
  path: string | null
  cleanup: () => void
} {
  if (!needed) return { path: null, cleanup: () => {} }
  let tempDir: string | null = null
  let cleaned = false
  try {
    tempDir = mkdtempSync(join(tmpdir(), "mc-sb-mask-"))
    const maskFile = join(tempDir, "empty-mask")
    writeFileSync(maskFile, "", { mode: 0o444 })
    try {
      chmodSync(maskFile, 0o444)
    } catch {}
    return {
      path: maskFile,
      cleanup: () => {
        if (cleaned || !tempDir) return
        cleaned = true
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {}
      },
    }
  } catch {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    }
    return { path: null, cleanup: () => {} }
  }
}

/** Kolektor output proses (stdout+stderr) berbatas karakter untuk runner sandbox. */
export function createCappedOutputCollector(cap: number) {
  let out = ""
  let err = ""
  let truncated = false
  const append = (target: "out" | "err", d: Buffer | string): void => {
    const s = typeof d === "string" ? d : d.toString()
    const cur = target === "out" ? out : err
    if (cur.length >= cap) {
      truncated = true
      return
    }
    const room = cap - cur.length
    if (s.length > room) truncated = true
    const piece = s.slice(0, Math.max(0, room))
    if (target === "out") out += piece
    else err += piece
  }
  const format = () => {
    const marker = truncated ? "\n… [output truncated]" : ""
    return {
      marker,
      output: (out + (err ? `\n[stderr]\n${err}` : "")).trim() + marker,
    }
  }
  return { append, format }
}
