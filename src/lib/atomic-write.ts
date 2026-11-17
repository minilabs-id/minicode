import { randomUUID } from "node:crypto"
import { chmod, type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Rename atomic dengan backoff EPERM/EBUSY/EACCES sesaat (lock AV/replace window Windows).
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: { maxRetries?: number; renameFn?: (src: string, dst: string) => Promise<void> } = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? 8
  const doRename = opts.renameFn ?? rename
  let lastErr: unknown
  for (let r = 0; r < maxRetries; r++) {
    try {
      await doRename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        lastErr = e
        await new Promise((res) => setTimeout(res, Math.min(10 * 2 ** r, 100)))
      } else {
        throw e
      }
    }
  }
  if (lastErr) throw lastErr
}

/**
 * Tulis file secara atomic + tahan hijack:
 * - nama tmp memakai randomUUID → tidak dapat diprediksi attacker
 * - flag "wx" (O_EXCL) gagal bila tmp sudah ada (mis. symlink pre-create)
 * - mode 0o600 best-effort sebelum rename (Windows: no-op, aman diabaikan)
 * - rename(tmp→target) atomic per POSIX; di Windows libuv memakai
 *   MOVEFILE_REPLACE_EXISTING sehingga menimpa target lama.
 */
export async function atomicWriteText(path: string, data: string): Promise<void> {
  let dirErr: NodeJS.ErrnoException | undefined
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (e) {
    dirErr = e as NodeJS.ErrnoException
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const entropy = 16
    const tmp = `${path}.tmp.${process.pid}.${randomUUID().slice(0, entropy)}`
    let fh: FileHandle | undefined
    try {
      fh = await open(tmp, "wx", 0o600)
    } catch (e) {
      if (dirErr) throw Object.assign(dirErr, { cause: e })
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && attempt === 0) continue
      throw e
    }
    try {
      try {
        await fh.writeFile(data, "utf8")
      } catch (e) {
        const msg = String((e as Error)?.message ?? "")
        if (msg.includes("kWriteMonkeyPatchDefense") || msg.includes("kWrite")) {
          await fh.close().catch(() => {})
          fh = undefined
          await Bun.write(tmp, data)
          await chmod(tmp, 0o600).catch(() => {})
          await renameWithRetry(tmp, path)
          return
        }
        throw e
      }
      await fh.sync().catch(() => {})
      await chmod(tmp, 0o600).catch(() => {})
      await renameWithRetry(tmp, path)
      return
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }
  throw new Error(`atomic write failed after retries: ${path}`)
}
