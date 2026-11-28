// Penyimpanan kredensial OAuth, terpisah dari config.json.
//
// Kenapa terpisah? `config.json` sering dibagikan / di-commit ke repo
// (`.minicode/config.json` lokal), sementara token OAuth adalah rahasia
// berumur pendek yang tak boleh ikut. Berkas ini selalu global
// (`~/.minicode/auth.json`), chmod 600, dan tak pernah dibaca dari cwd.
//
// Refresh token disimpan karena itu inti dari nilai OAuth: user login sekali,
// lalu access token diperbarui otomatis tanpa interaksi.

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { homeDir } from "../lib/db-path.ts"

export interface AuthCredentials {
  /** Tipe kredensial; `oauth` = punya refresh flow. */
  type: "oauth"
  accessToken: string
  refreshToken?: string
  /** Epoch ms kedaluwarsa access token. */
  expiresAt?: number
  /** Scope yang diberikan server (informasional). */
  scope?: string
  /** Endpoint token untuk refresh — disimpan agar tak perlu hard-code ulang. */
  tokenUrl?: string
  clientId?: string
}

export interface AuthStore {
  /** key = provider id (mis. "qwen", "anthropic"). */
  [providerId: string]: AuthCredentials
}

export function authFilePath(): string {
  // Baca homeDir() dinamis (hormati MINICODE_HOME di test/CI hermetik).
  return join(homeDir(), ".minicode", "auth.json")
}

// Kunci in-process per berkas (audit #09 P1): saveAuth/removeAuth adalah
// baca-modifikasi-tulis; dua refresh paralel (dua provider kedaluwarsa
// bersamaan) tanpa ini last-wins dan menelan kredensial segar salah satu —
// reproducer: 2× refresh konkuren → satu tetap OLD. Lintas proses tetap
// last-wins (terdokumentasi, tanpa CAS) — pola sama dengan withConfigLock.
const authLocks = new Map<string, Promise<void>>()

async function withAuthLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = authLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  // Yang DISIMPAN harus rantai yang SAMA dengan yang dibandingkan di finally.
  // Dulu map menyimpan `prev.then(() => next)` tapi finally membandingkan
  // `next` — tak pernah sama, jadi entri tak pernah dihapus dan rantai lock
  // tumbuh terus tiap save/remove (pola perbaikan sama dengan withConfigLock).
  const tail = prev.then(() => gate)
  authLocks.set(path, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (authLocks.get(path) === tail) authLocks.delete(path)
  }
}

const authStoreCache = new Map<
  string,
  { ino: bigint; mtimeNs: bigint; ctimeNs: bigint; size: bigint; store: AuthStore }
>()

function cloneAuthStore(store: AuthStore): AuthStore {
  const copy: AuthStore = {}
  for (const [k, v] of Object.entries(store)) copy[k] = { ...v }
  return copy
}

export async function loadAuthStore(): Promise<AuthStore> {
  const path = authFilePath()
  let fileStat: { ino: bigint; mtimeNs: bigint; ctimeNs: bigint; size: bigint } | null = null
  try {
    fileStat = (await stat(path, { bigint: true })) as unknown as {
      ino: bigint
      mtimeNs: bigint
      ctimeNs: bigint
      size: bigint
    }
    const hit = authStoreCache.get(path)
    if (
      hit &&
      hit.ino === fileStat.ino &&
      hit.mtimeNs === fileStat.mtimeNs &&
      hit.ctimeNs === fileStat.ctimeNs &&
      hit.size === fileStat.size
    ) {
      return cloneAuthStore(hit.store)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      authStoreCache.delete(path)
      return {}
    }
  }
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: AuthStore = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<AuthCredentials>
      // Entri tanpa accessToken tak berguna; buang daripada menyebarkan
      // undefined ke header Authorization.
      if (c && c.type === "oauth" && typeof c.accessToken === "string" && c.accessToken) {
        out[id] = {
          type: "oauth",
          accessToken: c.accessToken,
          ...(typeof c.refreshToken === "string" ? { refreshToken: c.refreshToken } : {}),
          ...(typeof c.expiresAt === "number" ? { expiresAt: c.expiresAt } : {}),
          ...(typeof c.scope === "string" ? { scope: c.scope } : {}),
          ...(typeof c.tokenUrl === "string" ? { tokenUrl: c.tokenUrl } : {}),
          ...(typeof c.clientId === "string" ? { clientId: c.clientId } : {}),
        }
      }
    }
    if (fileStat) {
      if (authStoreCache.size >= 16) authStoreCache.clear()
      authStoreCache.set(path, {
        ino: fileStat.ino,
        mtimeNs: fileStat.mtimeNs,
        ctimeNs: fileStat.ctimeNs,
        size: fileStat.size,
        store: cloneAuthStore(out),
      })
    }
    return out
  } catch {
    // Tidak ada file / JSON rusak = belum login. Bukan kondisi error.
    authStoreCache.delete(path)
    return {}
  }
}

export async function saveAuth(providerId: string, creds: AuthCredentials): Promise<void> {
  const path = authFilePath()
  return withAuthLock(path, async () => {
    const store = await loadAuthStore()
    store[providerId] = creds
    authStoreCache.delete(path)
    // atomicWriteText sudah chmod 600 + O_EXCL tmp; tak perlu perlakuan khusus.
    await atomicWriteText(path, JSON.stringify(store, null, 2))
  })
}

export async function removeAuth(providerId: string): Promise<boolean> {
  const path = authFilePath()
  return withAuthLock(path, async () => {
    const store = await loadAuthStore()
    if (!store[providerId]) return false
    delete store[providerId]
    authStoreCache.delete(path)
    await atomicWriteText(path, JSON.stringify(store, null, 2))
    return true
  })
}

export async function getAuth(providerId: string): Promise<AuthCredentials | undefined> {
  return (await loadAuthStore())[providerId]
}

/** Daftar provider yang punya kredensial (untuk `minicode auth status`). */
export async function listAuth(): Promise<
  { providerId: string; expiresAt?: number; expired: boolean; hasRefresh: boolean }[]
> {
  const store = await loadAuthStore()
  return Object.entries(store).map(([providerId, c]) => ({
    providerId,
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
    expired: isExpired(c),
    hasRefresh: Boolean(c.refreshToken),
  }))
}

/**
 * Kedaluwarsa dengan margin 60 detik.
 *
 * Margin penting: token yang kedaluwarsa 5 detik setelah kita memeriksanya akan
 * gagal di tengah request. Lebih baik refresh sedikit lebih awal.
 */
export function isExpired(creds: AuthCredentials, nowMs: number = Date.now()): boolean {
  if (!creds.expiresAt) return false // tanpa info kedaluwarsa: anggap masih valid
  return creds.expiresAt - 60_000 <= nowMs
}
