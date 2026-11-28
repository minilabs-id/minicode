// [Area B · PROMPT 06] Pengikatan persetujuan ↔ operasi yang dieksekusi.
// CAPTURE (sebelum prompt): hash argumen kanonis + isi target (anti-symlink) / state git.
// GRANT (setelah setuju): simpan per operasi (callId/FIFO).
// VERIFY (barrier efek sebelum & sesudah await): hitung ulang; beda ⇒ basi ⇒ TOLAK.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs"
import { resolve } from "node:path"
import { GIT_SAFE_BASE, gitFilterNeutralizersSync } from "../lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { canonicalArgsHash } from "./no-progress.ts"
import { sanitizeSpawnEnv } from "./scrub.ts"

/** Tool yang TARGET-nya file di workspace — satu-satunya yang bisa di-fingerprint. */
const FILE_TARGET_TOOLS = new Set(["write_file", "edit", "apply_patch", "delete_file", "move_file"])
const GIT_STATE_TOOLS = new Set(["git_commit", "git_push"])

/**
 * Batas fingerprint KONTEN. File lebih besar dari ini di-fingerprint lewat
 * size+mtime+ctime+ino: approval untuk file raksasa tetap bisa dideteksi
 * berubah, tanpa membaca ratusan MB dua kali per prompt.
 */
const MAX_CONTENT_FINGERPRINT_BYTES = 2 * 1024 * 1024

/** Sidik jari "file tidak ada" — BEDA dari hash file kosong. */
const MISSING_TARGET = "missing"
/** Sidik jari "path ada tapi bukan file biasa" (mis. direktori). */
const NOT_A_FILE = "not-a-file"
/** v0.33 (audit): file ADA tapi tak bisa dibaca (EACCES/EBUSY/EPERM) — jangan
 *  disamakan dengan MISSING_TARGET atau pesan staleness jadi menyesatkan. */
const UNREADABLE_TARGET = "unreadable"

/** Sidik jari satu target file. */
export interface ApprovalTarget {
  /** Path absolut target. */
  readonly path: string
  /** Hash isi (file kecil) / size+mtime / symlink / MISSING_TARGET. */
  readonly fingerprint: string
}

/** Sidik jari state repo git untuk tool commit/push yang disetujui. */
export interface ApprovalGitState {
  readonly cwd: string
  readonly digest: string
}

/** Bukti persetujuan untuk SATU operasi. */
export interface ApprovalBinding {
  /** ID tool call paralel agar konsumsi binding tak tertukar FIFO. */
  readonly callId?: string
  /** Nama tool yang disetujui. */
  readonly tool: string
  /** SHA-256 argumen kanonis (identik dengan `hashArgs`/`canonicalArgsHash`). */
  readonly argsHash: string
  /** Target file yang jadi bukti (kosong untuk tool tanpa target file). */
  readonly targets: readonly ApprovalTarget[]
  /** State git HEAD + working tree saat prompt untuk tool git tulis/push. */
  readonly gitState?: ApprovalGitState
}

/**
 * Path absolut target file untuk tool tertentu.
 *
 * `move_file` punya DUA ujung (path + destination): keduanya jadi bukti, karena
 * perubahan salah satu ujung mengubah operasi yang disetujui. Fallback lama
 * dipertahankan untuk binding yang dibuat sebelum rename wire v7.38.
 */
function approvalTargetPaths(tool: string, args: unknown, root: string): string[] {
  if (!FILE_TARGET_TOOLS.has(tool)) return []
  const a = (args ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  if (tool === "move_file") {
    const from = str(a.path ?? a.from)
    const to = str(a.destination ?? a.to)
    return [from, to].filter((p) => p !== "").map((p) => resolve(root, p))
  }
  const p = str(a.path)
  return p ? [resolve(root, p)] : []
}

/**
 * Sidik jari target saat ini (anti-symlink: pakai lstat + O_NOFOLLOW + fstat
 * agar swap symlink/file di antara check dan baca tidak diikuti diam-diam).
 */
export function fingerprintTarget(path: string): string {
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(path)
  } catch {
    return MISSING_TARGET
  }
  if (lst.isSymbolicLink()) {
    try {
      return `symlink:${readlinkSync(path)}`
    } catch {
      return NOT_A_FILE
    }
  }
  if (!lst.isFile()) return NOT_A_FILE
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let fd: number | undefined
  try {
    fd = openSync(path, flags)
    const fst = fstatSync(fd)
    if (!fst.isFile()) return NOT_A_FILE
    if (fst.size > MAX_CONTENT_FINGERPRINT_BYTES) {
      return `size:${fst.size}:mtime:${fst.mtimeMs}:ctime:${fst.ctimeMs}:ino:${fst.ino}`
    }
    return createHash("sha256").update(readFileSync(fd)).digest("hex")
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    return code === "ENOENT" ? MISSING_TARGET : UNREADABLE_TARGET
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function captureGitDigest(cwd: string): string | null {
  try {
    const git = resolveTrustedExecutable("git")
    const neutral = gitFilterNeutralizersSync(cwd)
    const env = sanitizeSpawnEnv(process.env)
    const head = spawnSync(git, [...GIT_SAFE_BASE, ...neutral, "rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      env,
    })
    const status = spawnSync(git, [...GIT_SAFE_BASE, ...neutral, "status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      env,
    })
    if (status.status !== 0) return null
    const headOut = head.status === 0 ? head.stdout.trim() : "UNBORN"
    return createHash("sha256").update(`${headOut}\0${status.stdout}`).digest("hex")
  } catch {
    return null
  }
}

/**
 * TANGKAP bukti persetujuan — dipanggil SEBELUM prompt.
 *
 * Ini adalah "apa yang dilihat user": argumen + isi file target pada saat
 * preview dibuat. Menangkap SEBELUM prompt penting: prompt bisa berjalan
 * lama (user berpikir), dan kalau sidik jari diambil SETELAH prompt kita
 * memverifikasi state yang tidak pernah dilihat user.
 */
export function captureApprovalBinding(
  tool: string,
  args: unknown,
  root: string,
  callId?: string,
): ApprovalBinding {
  let gitState: ApprovalGitState | undefined
  if (GIT_STATE_TOOLS.has(tool)) {
    const a = (args ?? {}) as Record<string, unknown>
    const gitCwd = typeof a.cwd === "string" && a.cwd.trim() ? resolve(root, a.cwd) : root
    const digest = captureGitDigest(gitCwd)
    if (digest !== null) gitState = { cwd: gitCwd, digest }
  }
  return {
    ...(callId ? { callId } : {}),
    tool,
    argsHash: canonicalArgsHash(args),
    targets: approvalTargetPaths(tool, args, root).map((path) => ({
      path,
      fingerprint: fingerprintTarget(path),
    })),
    ...(gitState ? { gitState } : {}),
  }
}

/**
 * Hasil verifikasi binding terhadap state target saat ini.
 * `stale` = operasi yang disetujui tak lagi berlaku (fail-closed).
 */
export type BindingVerdict =
  | { kind: "ok" }
  | { kind: "no-binding" }
  | { kind: "stale"; reason: string }

/**
 * Verifikasi binding approval terhadap state file target saat ini.
 *
 * `no-binding` = tak ada persetujuan yang tercatat untuk operasi ini (mis.
 * mode auto/allowlist, atau handler permission terinjeksi) → tak ada yang bisa
 * diverifikasi, dan tidak ada bukti basi → biarkan lewat.
 */
export function verifyApprovalBinding(binding: ApprovalBinding | undefined): BindingVerdict {
  if (!binding) return { kind: "no-binding" }
  for (const t of binding.targets) {
    const now = fingerprintTarget(t.path)
    if (now === t.fingerprint) continue
    return {
      kind: "stale",
      reason:
        now === MISSING_TARGET
          ? `target ${t.path} tidak ada lagi (hilang sejak approval)`
          : `target ${t.path} berubah sejak approval — approval basi, minta ulang`,
    }
  }
  if (binding.gitState) {
    const nowDigest = captureGitDigest(binding.gitState.cwd)
    if (nowDigest !== binding.gitState.digest) {
      return {
        kind: "stale",
        reason: `state git di ${binding.gitState.cwd} berubah sejak approval — approval basi, minta ulang`,
      }
    }
  }
  return { kind: "ok" }
}

/**
 * Penyimpanan binding persetujuan milik SATU sesi.
 *
 * Per-sesi, bukan global: dua sesi dalam satu proses tak boleh memakai
 * bukti persetujuan milik satu sama lain (Area A — isolasi instance).
 */
export class ApprovalBindingStore {
  readonly root: string
  /**
   * [AUDIT-FIX #1] Antre per callId — identitas stabil yang TIDAK berubah
   * walau args dimutasi. Dulu kunci utamanya `(tool, argsHash)`: bila `ask`/
   * broker yang di-inject mengubah `call.args` antara prompt dan eksekusi
   * (daemon mengoper `args: call.args` by reference di gatedPrompt), hash di
   * barrier jadi beda dari hash saat capture ⇒ `take` miss ⇒
   * `verifyApprovalBinding(undefined)` = "no-binding" ⇒ dibiarkan lewat,
   * sehingga tool jalan dengan args yang TIDAK disetujui user. Sekarang take
   * dicari berdasarkan callId; kesamaan argsHash dengan args eksekusi diveri-
   * fikasi EKSPLISIT di barrier (session.ts) dan beda ⇒ deny (fail-closed).
   */
  readonly #pending = new Map<string, ApprovalBinding[]>()

  constructor(root: string) {
    this.root = root
  }

  /**
   * Kunci utama = callId. Fallback komposit `(tool, argsHash)` HANYA untuk
   * binding legacy tanpa callId, supaya pemanggil/test lama tanpa id tetap
   * bisa consume-once FIFO. Jangan memakai argsHash sebagai kunci utama:
   * itulah akar fail-open yang diperbaiki di sini.
   */
  static key(callId: string | undefined, tool: string, argsHash: string): string {
    return callId ? `id\u0000${callId}` : `legacy\u0000${tool}\u0000${argsHash}`
  }

  /** Catat persetujuan yang sudah diberikan user (SETELAH prompt selesai). */
  grant(binding: ApprovalBinding): void {
    const k = ApprovalBindingStore.key(binding.callId, binding.tool, binding.argsHash)
    const arr = this.#pending.get(k)
    if (arr) arr.push(binding)
    else this.#pending.set(k, [binding])
  }

  /**
   * Ambil satu binding untuk call ini — consume-once.
   *
   * `argsHash` tetap diterima demi kompatibilitas tanda tangan dan dipakai
   * fallback legacy; kesamaan hash dengan args eksekusi sengaja DIVERIFIKASI
   * PEMANGGIL di barrier, bukan di sini — supaya args yang berubah terbaca
   * sebagai "stale" (deny), bukan sekadar "tak ketemu" (yang dulu malah
   * dianggap lolos).
   */
  take(tool: string, argsHash: string, callId?: string): ApprovalBinding | undefined {
    const k = ApprovalBindingStore.key(callId, tool, argsHash)
    const arr = this.#pending.get(k)
    if (!arr || arr.length === 0) return undefined
    // Kunci utamanya callId, jadi semua entri dalam antre memiliki id yang
    // sama; ambil FIFO. Fallback legacy tanpa id juga FIFO seperti semula.
    const [picked] = arr.splice(0, 1)
    if (arr.length === 0) this.#pending.delete(k)
    return picked
  }

  /** Jumlah binding yang masih tertunda (diagnostik/test). */
  get size(): number {
    let n = 0
    for (const arr of this.#pending.values()) n += arr.length
    return n
  }

  clear(): void {
    this.#pending.clear()
  }
}
