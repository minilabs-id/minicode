import { readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { isIgnored } from "../lib/ignore.ts"
import {
  assertSafeWriteTarget,
  resolveSafePath,
  safeOpenRead,
  safeReadFile,
} from "../lib/safe-open.ts"
import { isCwdOutsideRoot, isPathOutsideRoot, isSensitive } from "../policy/jail.ts"
import { appendLspDiagnostics } from "../policy/verifier.ts"

/** Workspace root wajib datang dari context eksekusi yang dirakit runtime. */
export function requireToolCwd(context: unknown): string {
  const cwd = (context as { cwd?: unknown } | null)?.cwd
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("ToolContext.cwd is required; refusing to use process.cwd()")
  }
  return cwd
}

/**
 * True hanya di mode `unrestricted`. Sumber: `ToolContext.permissionMode`,
 * di-resolve LIVE per-turn oleh kernel — `/unrestric` saat runtime langsung
 * tercermin tanpa patch vendor. Fail-closed: selain string "unrestricted"
 * (termasuk undefined pada pemanggil library/test) = false.
 */
export function contextUnrestricted(context: unknown): boolean {
  return (context as { permissionMode?: unknown } | null)?.permissionMode === "unrestricted"
}

/**
 * Potong string tanpa membelah pasangan surrogate UTF-16: `slice` mentah pada
 * batas tinggi menghasilkan kode pengganti `U+FFFD`. Dipakai bersama oleh tool
 * yang memotong baris/teks panjang (`read_file`, `ask_user`).
 */
export function sliceSafeChars(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  const code = s.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return s.slice(0, Math.max(0, end))
}

export async function openSafeToolReadHandle(rawPath: string, ctx: unknown) {
  const root = requireToolCwd(ctx)
  const relaxed = contextUnrestricted(ctx)
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
  let handle: Awaited<ReturnType<typeof safeOpenRead>>["handle"]
  try {
    ;({ handle } = await safeOpenRead(abs, root, relaxed))
  } catch (e) {
    const msg = (e as Error).message ?? ""
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || msg.includes("ENOENT"))
      throw new Error(`file not found: ${rawPath}`)
    throw e
  }
  const st = await handle.stat().catch(() => null)
  if (!st) {
    await handle.close().catch(() => {})
    throw new Error(`file not found: ${rawPath}`)
  }
  return { handle, st, root, relaxed, abs }
}

/** Baca teks siap-edit dengan cek jail, anti-symlink overwrite, cap ukuran, & O_NOFOLLOW. */
export async function readSafeTextForEdit(rawPath: string, ctx: unknown) {
  const root = requireToolCwd(ctx)
  const relaxed = contextUnrestricted(ctx)
  const { abs, real: realAbs } = await resolveSafePath(rawPath, root, relaxed)
  await assertSafeWriteTarget(abs, root, relaxed)
  const st = await stat(realAbs).catch(() => null)
  if (!st) throw new Error(`file not found: ${rawPath}`)
  if (st.size > LIMITS.READ_FILE_MAX_BYTES)
    throw new Error(`file too large: ${rawPath} (${st.size})`)
  const content = await safeReadFile(abs, root, relaxed).catch(() => {
    throw new Error(`file not found: ${rawPath}`)
  })
  return { root, realAbs, content }
}

/** Tulis hasil edit dengan cek batas char + atomic write + LSP diagnostics. */
export async function commitSafeTextEdit(
  realAbs: string,
  root: string,
  content: string,
  message: string,
): Promise<string> {
  if (content.length > LIMITS.WRITE_FILE_MAX_CHARS)
    throw new Error(`result too large: ${content.length} chars (max 5M)`)
  await atomicWriteText(realAbs, content)
  return await appendLspDiagnostics(realAbs, content, message, undefined, root)
}

/** Validasi dan resolve `cwd` tool terhadap batas workspace. */
export function resolveSearchRoot(
  cwdArg: unknown,
  ctx: unknown,
): { root: string; rawRoot: string; relaxed: boolean } {
  const sessionRoot = requireToolCwd(ctx)
  const relaxed = contextUnrestricted(ctx)
  const rawRoot = (cwdArg as string) ?? "."
  const root = resolve(sessionRoot, rawRoot)
  if (
    !relaxed &&
    (isPathOutsideRoot(root, sessionRoot) || isCwdOutsideRoot(rawRoot, sessionRoot))
  ) {
    throw new Error(`cwd outside workspace: ${rawRoot}`)
  }
  return { root, rawRoot, relaxed }
}

/** Walk workspace aman (hormat .gitignore, skip dotfile default & symlink escape/sensitif). */
export async function walkWorkspaceFiles(
  opts: {
    dir: string
    root: string
    signal: AbortSignal
    ignoreMatchers: ((rel: string) => boolean)[]
    relaxed?: boolean
    includeDotfiles?: boolean
    shouldStop?: () => boolean
  },
  onFile: (info: { full: string; rel: string; name: string; real: string }) => Promise<void> | void,
): Promise<void> {
  if (opts.signal.aborted) throw new Error("aborted")
  if (opts.shouldStop?.()) return
  const entries = await readdir(opts.dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (opts.shouldStop?.()) break
    if (e.name === "node_modules" || e.name === ".git") continue
    if (!opts.includeDotfiles && e.name.startsWith(".")) continue
    const full = join(opts.dir, e.name)
    const rel = relative(opts.root, full).replace(/\\/g, "/")
    if (isIgnored(rel, opts.ignoreMatchers)) continue
    if (e.isDirectory()) {
      await walkWorkspaceFiles({ ...opts, dir: full }, onFile)
    } else {
      const real = await realpath(full).catch(() => full)
      if (
        (!opts.relaxed && isPathOutsideRoot(real, resolve(opts.root))) ||
        isSensitive(real) ||
        isSensitive(full) ||
        isSensitive(rel)
      )
        continue
      await onFile({ full, rel, name: e.name, real })
    }
  }
}
