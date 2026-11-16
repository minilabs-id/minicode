import {
  chmodSync,
  existsSync,
  lstatSync,
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
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !SKIP_DIRS.has(name)) {
          queue.push({ dir: full, depth: depth + 1 })
        }
        continue
      }
      if ((st.isFile() || st.isSymbolicLink()) && isSensitiveEnvFileName(name)) {
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
