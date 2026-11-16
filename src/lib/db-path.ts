import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Satu sumber lokasi DB lokal/global (dipakai sessions.db & vector.db):
 * - bila <cwd>/.minicode/<filename> sudah ada → pakai itu
 * - bila direktori <cwd>/.minicode ada (DB belum dibuat) → pakai lokal
 * - selain itu → global ~/.minicode/<filename>
 *
 * Home diambil dari MINICODE_HOME bila diset (test hermetic + XDG-ish),
 * karena os.homedir() di POSIX mengabaikan $HOME (libuv pakai passwd) —
 * tanpa ini test penggabungan global tak bisa hermetic di Linux.
 */
export function homeDir(): string {
  return process.env.MINICODE_HOME || homedir()
}
export function resolveDbPath(filename: string, cwd?: string): string {
  if (filename.includes("/") || filename.includes("\\") || filename.includes(".."))
    throw new Error(`invalid filename: ${filename}`)
  const baseCwd = cwd ?? process.cwd()
  const local = resolve(baseCwd, ".minicode", filename)
  const localDir = resolve(baseCwd, ".minicode")
  if (existsSync(local)) return local
  if (existsSync(localDir)) {
    try {
      mkdirSync(localDir, { recursive: true, mode: 0o700 })
    } catch {}
    return local
  }
  const global = join(homeDir(), ".minicode", filename)
  try {
    mkdirSync(join(global, ".."), { recursive: true, mode: 0o700 })
  } catch {}
  return global
}

/**
 * Resolusi DB **local-only** — N1 dari Task Model review.
 *
 * `resolveDbPath` jatuh ke `~/.minicode/` global bila `<cwd>/.minicode` belum
 * ada. Itu benar untuk `sessions.db`/`vector.db` (histori bukan milik satu
 * repo), tetapi SALAH untuk task state: task list adalah milik workspace yang
 * sedang dikerjakan, dan kalau ia mendarat di DB user-global maka
 *  (a) state satu project bocor ke project lain yang kebetulan memakai
 *      session id sama, dan
 *  (b) ikut tersapu `purgeExpired` yang berbasis `updated_at` milik session
 *      lain.
 *
 * Perilaku lama `todoPath` justru selalu cwd-lokal, jadi memakai fungsi ini
 * mempertahankan isolasi yang sudah dimiliki task state, bukan mengubahnya.
 */
export function resolveLocalDbPath(filename: string, cwd?: string): string {
  if (filename.includes("/") || filename.includes("\\") || filename.includes(".."))
    throw new Error(`invalid filename: ${filename}`)
  const baseCwd = cwd ?? process.cwd()
  const dir = resolve(baseCwd, ".minicode")
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
  return join(dir, filename)
}

const SQLITE_CONTENTION_RE =
  /SQLITE_BUSY|database is locked|database table is locked|SQLITE_LOCKED|SQLITE_PROTOCOL|SQLITE_IOERR_TRUNCATE|SQLITE_IOERR_SHMOPEN|SQLITE_IOERR_LOCK|disk I\/O error/i

/** Predikat kontensi SQLite transien lintas-proses (aman di-retry; bukan korupsi/constraint). */
export function isSqliteContention(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === "string" && SQLITE_CONTENTION_RE.test(code)) return true
  const msg = e instanceof Error ? String(e.message ?? e) : String(e)
  return SQLITE_CONTENTION_RE.test(msg)
}

export function withSqliteBusyRetrySync<T>(
  fn: () => T,
  opts: {
    attempts?: number
    backoffMs?: number
    jitterMaxMs?: number
    deterministicJitter?: boolean
    onGiveUp?: (last: unknown, attempts: number) => void
  } = {},
): T | null {
  const attempts = opts.attempts ?? 8
  const backoffMs = opts.backoffMs ?? 15
  const jitterMax = opts.jitterMaxMs ?? 0
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (e) {
      if (!isSqliteContention(e)) throw e
      last = e
      if (i + 1 >= attempts) break
      const base = backoffMs * 2 ** i
      const jitter = opts.deterministicJitter
        ? i === 0
          ? 0
          : (i * 7919 + 3) % Math.max(1, Math.floor(base * 0.2))
        : jitterMax > 0
          ? Math.floor(Math.random() * jitterMax)
          : 0
      Bun.sleepSync(base + jitter)
    }
  }
  opts.onGiveUp?.(last, attempts)
  return null
}
