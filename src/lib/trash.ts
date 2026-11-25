import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { isPathOutsideRoot } from "../policy/jail.ts"

// Soft-delete bersama untuk delete_file & move_file (backup overwrite).
// Lokasi di <root>/.minicode/.trash — otomatis gitignored (.minicode/) dan
// di-skip glob/grep (dot-dir), jadi tidak mengotori workspace. Cap 100 file
// terbaru; best-effort, jangan gagalkan tool bila prune gagal.
const TRASH_MAX_FILES = 100

export function trashDir(root: string): string {
  return join(root, ".minicode", ".trash")
}

/**
 * Pastikan `.minicode` dan `.minicode/.trash` bukan symlink/junction yang
 * mengarah ke luar workspace sebelum membuat, memindah, atau memangkas isi trash.
 */
async function ensureSafeTrashDir(root: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const minicodeDir = join(root, ".minicode")
  const dir = trashDir(root)
  for (const seg of [minicodeDir, dir]) {
    const lst = await lstat(seg).catch(() => null)
    if (lst?.isSymbolicLink()) {
      throw new Error(`refusing to use symlinked trash path: ${seg}`)
    }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const seg of [minicodeDir, dir]) {
    const lst = await lstat(seg)
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      throw new Error(`refusing to use unsafe trash directory: ${seg}`)
    }
    const realSeg = await realpath(seg)
    if (isPathOutsideRoot(realSeg, realRoot)) {
      throw new Error(`trash directory resolves outside workspace: ${seg}`)
    }
  }
  return await realpath(dir)
}

export async function trashFile(root: string, abs: string): Promise<string> {
  const dir = await ensureSafeTrashDir(root)
  const dest = join(dir, `${randomUUID().slice(0, 8)}-${basename(abs)}`)
  await rename(abs, dest)
  await pruneTrash(dir).catch(() => {})
  return dest
}

async function pruneTrash(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[])
  if (entries.length <= TRASH_MAX_FILES) return
  const withTime: { e: string; m: number }[] = []
  for (const e of entries) {
    try {
      const st = await stat(join(dir, e))
      withTime.push({ e, m: st.mtimeMs })
    } catch {}
  }
  withTime.sort((a, b) => a.m - b.m)
  for (const v of withTime.slice(0, withTime.length - TRASH_MAX_FILES)) {
    await rm(join(dir, v.e), { force: true }).catch(() => {})
  }
}
