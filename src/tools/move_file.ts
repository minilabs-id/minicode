import { lstat, mkdir, rename, stat } from "node:fs/promises"
import { dirname, extname } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { assertSafeWriteTarget, resolveSafePath, safeReadFile } from "../lib/safe-open.ts"
import { trashFile } from "../lib/trash.ts"
import { getConfiguredExts } from "../lsp/client.ts"
import { appendLspDiagnostics } from "../policy/verifier.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

export const moveFileTool: Tool = {
  name: "move_file",
  description:
    "Move/rename a file within workspace (atomic rename). Supports moving to new directory (auto-creates parents).",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "source path relative to cwd" },
      to: { type: "string", description: "destination path relative to cwd" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async execute({ from, to }, ctx) {
    ctx.signal.throwIfAborted()
    const root = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    const f = from as string
    const t = to as string
    // Verifikasi kedua ujung via pemilik tunggal (logis + target nyata) —
    // detail di safe-open.ts. Beda dengan tool satu-berkas hanya karena
    // move punya dua ujung; substring pesan ("outside workspace",
    // "blocked sensitive file") dipertahankan agar test regex tetap hijau.
    const { abs: absFrom, real: realFrom } = await resolveSafePath(f, root, relaxed)
    const st = await stat(realFrom).catch(() => null)
    if (!st) throw new Error(`source not found: ${f}`)
    const { abs: absTo, real: realTo } = await resolveSafePath(t, root, relaxed)
    await assertSafeWriteTarget(absTo, root, relaxed)
    await mkdir(dirname(absTo), { recursive: true, mode: 0o700 }).catch(() => {})

    // Deteksi rename case-only (mis. foo.ts → Foo.ts di Windows NTFS) atau
    // alias path ke berkas fisik yang sama sebelum trashFile, agar sumber
    // tidak dipindahkan ke .trash sebelum rename dijalankan.
    const fromLstat = await lstat(absFrom, { bigint: true }).catch(() => null)
    const destLstat = await lstat(absTo, { bigint: true }).catch(() => null)
    const sameInode =
      fromLstat !== null &&
      destLstat !== null &&
      fromLstat.ino !== 0n &&
      fromLstat.dev === destLstat.dev &&
      fromLstat.ino === destLstat.ino
    const sameWinCasePath =
      process.platform === "win32" &&
      absFrom.toLowerCase() === absTo.toLowerCase() &&
      !destLstat?.isSymbolicLink()
    const sameFileRename = sameInode || sameWinCasePath

    // S3 — dest yang sudah ada dibackup ke trash dulu (jangan timpa diam-diam).
    // Pakai lstat agar symlink tujuan di-trash sebagai entry link, bukan targetnya.
    let backup = ""
    if (destLstat && !sameFileRename) {
      if (destLstat.isDirectory()) throw new Error(`destination is a directory: ${t}`)
      const trashed = await trashFile(root, absTo)
      backup = ` (previous dest backed up to ${trashed})`
    }
    await rename(absFrom, absTo)
    const base = `moved ${f} -> ${t}${backup}`
    if (!st.isFile() || st.size > LIMITS.READ_FILE_MAX_BYTES) return base
    const ext = extname(absTo).toLowerCase()
    if (!getConfiguredExts().includes(ext)) return base
    const text = await safeReadFile(absTo, root, relaxed).catch(() => null)
    if (text === null) return base
    return await appendLspDiagnostics(realTo, text, base, undefined, root)
  },
}
