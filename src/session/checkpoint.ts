import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { GIT_SAFE_BASE } from "../lib/git-hardening.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import {
  isOwnedState,
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
} from "../policy/jail.ts"
import { appendUndoMarker, loadJournal } from "./journal.ts"
import { diffTrees, ephemeralTree, isGitRepo, restoreTree, snapshotTree } from "./shadow-git.ts"

/** Alias back-compat: satu-satunya sanitizer kini di lib/session-id.ts (F-17). */
export function sanitizeSessionId(id: string): string {
  return sanitizeSessionPart(id)
}

// In-process lock per manifest path untuk mencegah lost-update checkpoint
// saat turn paralel (mis. Pool(3) sub-agent).
const checkpointLocks = new Map<string, Promise<void>>()

/**
 * Test-only: jumlah entri lock yang masih tersisa. Kebocoran map tidak bisa
 * dibuktikan lewat perilaku tanpa mengintrospeksi struktur internal, jadi
 * regresi audit #1 memakai accessor sempit ini.
 */
export function checkpointLockCountForTest(): number {
  return checkpointLocks.size
}

async function withCheckpointLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = checkpointLocks.get(path) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  // Yang DISIMPAN harus rantai yang sama dengan yang dibandingkan di finally.
  // Dulu map menyimpan `prev.then(() => next)` sementara finally membandingkan
  // `next` — tak pernah sama, sehingga entri map tidak pernah dihapus dan
  // rantai promise tumbuh terus di daemon berumur panjang.
  const tail = prev.then(() => gate)
  checkpointLocks.set(path, tail)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (checkpointLocks.get(path) === tail) checkpointLocks.delete(path)
  }
}

// v7.31: pakai konstanta terpusat supaya tak drift dengan LIMITS.
const MAX_CHECKPOINTS = LIMITS.CHECKPOINT_MAX_COUNT

export interface FileSnapshot {
  path: string // relative path
  content: string | null // null means file was deleted/didn't exist
}

export interface Checkpoint {
  id: string
  turn: number
  timestamp: string
  description: string
  snapshots: FileSnapshot[] // pre-edit state (untuk /undo)
  redoSnapshots?: FileSnapshot[] // post-edit state (untuk /redo)
  /** Tree git pre-turn (mode shadow-git). Bila ada, snapshots dibiarkan kosong. */
  treeBefore?: string
  /** Tree git post-turn (mode shadow-git) untuk /redo. */
  treeAfter?: string
}

export interface CheckpointManifest {
  sessionId: string
  currentIndex: number // pointer in history
  checkpoints: Checkpoint[]
}

/**
 * [Audit #2 A.2] Normalisasi manifest korup: `JSON.parse` yang sukses belumlah
 * berarti strukturnya valid. `checkpoints` yang bukan array atau `currentIndex`
 * di luar batas akan memicu `TypeError` saat undo/redo mengindeks
 * `manifest.checkpoints[manifest.currentIndex]`. Bentuk tak valid → jatuh ke
 * state kosong yang aman; pointer di luar batas di-clamp ke `[-1, len-1]`.
 */
function normalizeCheckpointManifest(
  parsed: unknown,
  fallbackSessionId: string,
): CheckpointManifest {
  if (typeof parsed !== "object" || parsed === null) {
    return { sessionId: sanitizeSessionId(fallbackSessionId), currentIndex: -1, checkpoints: [] }
  }
  const m = parsed as Partial<CheckpointManifest>
  const checkpoints = Array.isArray(m.checkpoints) ? m.checkpoints : []
  let currentIndex =
    typeof m.currentIndex === "number" && Number.isInteger(m.currentIndex) ? m.currentIndex : -1
  if (currentIndex < -1) currentIndex = -1
  if (currentIndex >= checkpoints.length) currentIndex = checkpoints.length - 1
  if (checkpoints.length === 0) currentIndex = -1
  return {
    sessionId:
      typeof m.sessionId === "string" && m.sessionId.trim() !== ""
        ? m.sessionId
        : sanitizeSessionId(fallbackSessionId),
    currentIndex,
    checkpoints,
  }
}

function getCheckpointDir(sessionId: string, cwd: string = process.cwd()): string {
  return resolve(cwd, ".minicode", "checkpoints", sanitizeSessionId(sessionId))
}

function getManifestPath(sessionId: string, cwd: string = process.cwd()): string {
  return join(getCheckpointDir(sessionId, cwd), "manifest.json")
}

/**
 * [P14.0] Ringkasan manifest checkpoint, SYNC dan NON-MENULIS.
 *
 * `loadCheckpointManifest` yang async menulis backup `.corrupt.*` saat JSON
 * rusak — itu benar untuk jalur pemulihan sesi, tapi PROYEKSI read-only tidak
 * boleh meninggalkan jejak tulis. Pembaca ini hanya melaporkan: manifest
 * hilang = `exists: false` (kondisi normal sesi tanpa checkpoint), JSON rusak
 * = `corrupt: true` (dilabel jujur, tidak dibackup, tidak dihapus).
 */
export interface CheckpointInventoryEntry {
  readonly sessionId: string
  readonly exists: boolean
  readonly corrupt: boolean
  readonly checkpointCount: number
  readonly currentIndex: number
  readonly latestTurn: number | null
  readonly latestTimestamp: string | null
}

export function readCheckpointInventorySync(
  sessionId: string,
  cwd?: string,
): CheckpointInventoryEntry {
  const empty: CheckpointInventoryEntry = {
    sessionId,
    exists: false,
    corrupt: false,
    checkpointCount: 0,
    currentIndex: -1,
    latestTurn: null,
    latestTimestamp: null,
  }
  let raw: string
  try {
    raw = require("node:fs").readFileSync(getManifestPath(sessionId, cwd ?? process.cwd()), "utf8")
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as CheckpointManifest
    const checkpoints = Array.isArray(parsed.checkpoints) ? parsed.checkpoints : []
    const latest = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined
    return {
      sessionId,
      exists: true,
      corrupt: false,
      checkpointCount: checkpoints.length,
      currentIndex: typeof parsed.currentIndex === "number" ? parsed.currentIndex : -1,
      latestTurn: typeof latest?.turn === "number" ? latest.turn : null,
      latestTimestamp: typeof latest?.timestamp === "string" ? latest.timestamp : null,
    }
  } catch {
    return { ...empty, exists: true, corrupt: true }
  }
}

export async function loadCheckpointManifest(
  sessionId: string,
  cwd?: string,
): Promise<CheckpointManifest> {
  const path = getManifestPath(sessionId, cwd)
  try {
    const raw = await readFile(path, "utf8")
    try {
      return normalizeCheckpointManifest(JSON.parse(raw), sessionId)
    } catch (e) {
      if (e instanceof SyntaxError) {
        const backup = `${path}.corrupt.${Date.now()}`
        await atomicWriteText(backup, raw).catch(() => {})
        process.stderr.write(
          `[warn] checkpoint: manifest corrupt — backup to ${backup}: ${(e as Error).message} — starting empty\n`,
        )
      }
      throw e
    }
  } catch (e) {
    // manifest hilang = kondisi normal utk sesi baru; manifest KORUP sudah di-backup di atas
    // lalu akan jatuh ke sini sebagai SyntaxError — tetap return empty tapi sudah backup
    const code = (e as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && !(e instanceof SyntaxError)) {
      process.stderr.write(
        `[warn] checkpoint: manifest unreadable (${(e as Error).message}) — starting empty\n`,
      )
    }
    if (e instanceof SyntaxError) {
      // already backed up, return empty
    }
    return { sessionId: sanitizeSessionId(sessionId), currentIndex: -1, checkpoints: [] }
  }
}

export async function saveCheckpointManifest(
  manifest: CheckpointManifest,
  cwd?: string,
): Promise<void> {
  const dir = getCheckpointDir(manifest.sessionId, cwd)
  await mkdir(dir, { recursive: true }).catch(() => {})
  const path = getManifestPath(manifest.sessionId, cwd)
  await atomicWriteText(path, JSON.stringify(manifest, null, 2))
}

// P3 — validasi resume: workspace berubah sejak checkpoint terakhir?
// Bukan replay buta: mode git bandingkan treeAfter terakhir vs tree sekarang
// (tanpa pin ref baru); mode files bandingkan snapshot post (redo) vs isi
// sekarang. Best-effort: null bila tak bisa dipastikan — resume tetap jalan.
export async function validateResumeWorkspace(
  cwd: string,
  sessionId: string,
): Promise<{ mode: "git" | "files" | "none"; diverged: number } | null> {
  try {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.checkpoints.length === 0) return { mode: "none", diverged: 0 }
    const last =
      manifest.checkpoints[manifest.currentIndex] ??
      manifest.checkpoints[manifest.checkpoints.length - 1]!
    if (last.treeAfter) {
      const now = await ephemeralTree(cwd)
      if (!now) return null
      if (now === last.treeAfter) return { mode: "git", diverged: 0 }
      const changes = await diffTrees(cwd, last.treeAfter, now)
      // Pembukuan harness sendiri (.minicode/: manifest, trace, todos berubah
      // tiap run) bukan divergensi user — keluarkan agar resume di repo tanpa
      // gitignore .minicode tidak selalu kuning.
      const userChanges = changes.filter(
        (ch) => ch.path !== ".minicode" && !ch.path.startsWith(".minicode/"),
      )
      return { mode: "git", diverged: userChanges.length }
    }
    const refs = last.redoSnapshots?.length ? last.redoSnapshots : last.snapshots
    if (refs.length === 0) return { mode: "none", diverged: 0 }
    let diverged = 0
    for (const s of refs.slice(0, LIMITS.WORKSPACE_SNAPSHOT_LIMIT)) {
      // Jail: manifest bisa usang/rusak — jangan baca di luar workspace.
      if (isPathOutsideRoot(s.path, cwd)) {
        diverged++
        continue
      }
      let cur: string | null
      try {
        cur = await readFile(resolve(cwd, s.path), "utf8")
      } catch {
        cur = null
      }
      if (cur !== s.content) diverged++
    }
    return { mode: "files", diverged }
  } catch {
    return null
  }
}

export async function captureFileSnapshot(
  filePath: string,
  cwd: string = process.cwd(),
): Promise<FileSnapshot> {
  const rel = relative(cwd, filePath).replace(/\\/g, "/")
  const abs = resolve(cwd, filePath)
  try {
    const content = await readFile(abs, "utf8")
    return { path: rel, content }
  } catch {
    return { path: rel, content: null }
  }
}

// Snapshot seluruh workspace (maks `limit` file) — menangkap perubahan apa pun
// termasuk bash/git (bukan cuma edit/write_file). Dipakai /undo per turn.
async function walkFiles(root: string, rel: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return
  const dir = rel ? join(root, rel) : root
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= limit) break
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === ".git") continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walkFiles(root, r, out, limit)
    else out.push(r)
  }
}

export async function snapshotWorkspace(
  cwd: string = process.cwd(),
  limit = 200,
): Promise<FileSnapshot[]> {
  // Try git dirty files first for efficiency on large workspaces.
  // Audit #10: status menjalankan fsmonitor repo tanpa netralisasi; git
  // di-resolve absolut agar `git.bat` repo tak dieksekusi dari cwd (Windows).
  try {
    const { spawnSync } = await import("node:child_process")
    const { resolveTrustedExecutable } = await import("../lib/trusted-exec.ts")
    const r = spawnSync(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, "status", "--porcelain"],
      {
        cwd,
        timeout: 2000,
        encoding: "utf8",
      },
    )
    if (r.status === 0 && r.stdout) {
      const dirty = r.stdout
        .split("\n")
        .map((l: string) => l.slice(3).trim())
        .filter(Boolean)
        .slice(0, limit)
      if (dirty.length > 0) {
        const snaps: FileSnapshot[] = []
        const seen = new Set<string>()
        for (const f of dirty) {
          const snap = await captureFileSnapshot(resolve(cwd, f), cwd)
          seen.add(snap.path)
          snaps.push(snap)
        }
        if (snaps.length < limit) {
          const extra: string[] = []
          await walkFiles(cwd, "", extra, limit)
          for (const f of extra) {
            if (snaps.length >= limit) break
            const snap = await captureFileSnapshot(resolve(cwd, f), cwd)
            if (seen.has(snap.path)) continue
            seen.add(snap.path)
            snaps.push(snap)
          }
        }
        return snaps
      }
    }
  } catch {}
  const files: string[] = []
  await walkFiles(cwd, "", files, limit)
  const snaps: FileSnapshot[] = []
  for (const f of files) {
    snaps.push(await captureFileSnapshot(resolve(cwd, f), cwd))
  }
  return snaps
}

// ── Shadow-git: jalur utama bila cwd adalah repo git ──
//
// Menyimpan SHA tree alih-alih isi file. Biayanya O(delta) bukan
// O(ukuran workspace), tanpa cap jumlah file, dan tidak menyentuh index/HEAD
// user. Fallback ke snapshot manual di bawah tetap ada untuk non-repo.

/**
 * Ambil snapshot pre-turn. Return penanda mode yang dipakai supaya pemanggil
 * tahu apakah perlu mengumpulkan snapshot file manual.
 */
export async function beginTurnSnapshot(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<
  | { mode: "git"; tree: string }
  | { mode: "files"; snapshots: FileSnapshot[] }
  | { mode: "unavailable"; reason: string }
> {
  const shadow = await snapshotTree(cwd, sessionId, "pre")
  if (shadow) return { mode: "git", tree: shadow.tree }
  // Fallback file snapshot dibatasi 200 path. Memakainya saat repo Git gagal
  // membuat snapshot dapat memberi kesan rollback lengkap padahal parsial.
  if (await isGitRepo(cwd)) return { mode: "unavailable", reason: "git-snapshot-failed" }
  try {
    return { mode: "files", snapshots: await snapshotCompleteWorkspace(cwd) }
  } catch (error) {
    return { mode: "unavailable", reason: (error as Error).message }
  }
}

export async function snapshotCompleteWorkspace(cwd: string): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = []
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      if (isOwnedState(absolute) || isSensitive(absolute) || entry.name === "node_modules") continue
      if (entry.isSymbolicLink() || isRealPathOutsideRoot(absolute, cwd))
        throw new Error("workspace snapshot cannot cover symlinks")
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) throw new Error("workspace snapshot contains unsupported entries")
      const content = await readFile(absolute)
      bytes += content.length
      if (snapshots.length >= 5000 || bytes > 32 * 1024 * 1024)
        throw new Error("workspace snapshot exceeds safety budget")
      snapshots.push({
        path: relative(cwd, absolute).replace(/\\/g, "/"),
        content: new TextDecoder("utf-8", { fatal: true }).decode(content),
      })
    }
  }
  await visit(resolve(cwd))
  return snapshots
}

/** Rekam checkpoint dari tree git pre/post turn. */
export async function recordCheckpointFromTrees(
  sessionId: string,
  turn: number,
  treeBefore: string,
  treeAfter: string | undefined,
  description: string,
  cwd: string = process.cwd(),
): Promise<Checkpoint | null> {
  // Tak ada perubahan → tak ada yang perlu di-undo. Ini juga mencegah manifest
  // dipenuhi checkpoint kosong dari turn yang hanya membaca.
  if (treeAfter && treeAfter === treeBefore) return null
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    const cp: Checkpoint = {
      id: `cp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      turn,
      timestamp: new Date().toISOString(),
      description,
      snapshots: [],
      treeBefore,
      ...(treeAfter ? { treeAfter } : {}),
    }
    if (manifest.currentIndex < manifest.checkpoints.length - 1) {
      manifest.checkpoints = manifest.checkpoints.slice(0, manifest.currentIndex + 1)
    }
    manifest.checkpoints.push(cp)
    if (manifest.checkpoints.length > MAX_CHECKPOINTS) {
      manifest.checkpoints = manifest.checkpoints.slice(-MAX_CHECKPOINTS)
    }
    manifest.currentIndex = manifest.checkpoints.length - 1
    await saveCheckpointManifest(manifest, cwd)
    return cp
  })
}

export async function recordCheckpoint(
  sessionId: string,
  turn: number,
  filePaths: string[],
  description: string = "",
  cwd: string = process.cwd(),
): Promise<Checkpoint> {
  const snapshots: FileSnapshot[] = []
  for (const fp of filePaths) {
    snapshots.push(await captureFileSnapshot(fp, cwd))
  }
  const cp = await recordCheckpointFromSnapshots(sessionId, turn, snapshots, description, cwd)
  if (!cp) throw new Error("no files to checkpoint")
  return cp
}

// Rekam checkpoint dari snapshot yang SUDAH ditangkap. `snapshots` = pre-edit
// (untuk /undo); `redoSnapshots` opsional = post-edit (untuk /redo).
export async function recordCheckpointFromSnapshots(
  sessionId: string,
  turn: number,
  snapshots: FileSnapshot[],
  description: string = "",
  cwd: string = process.cwd(),
  redoSnapshots?: FileSnapshot[],
): Promise<Checkpoint | null> {
  if (snapshots.length === 0) return null
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    const cp: Checkpoint = {
      id: `cp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      turn,
      timestamp: new Date().toISOString(),
      description,
      snapshots,
      ...(redoSnapshots?.length ? { redoSnapshots } : {}),
    }

    // Truncate any redo branches if new action is taken
    if (manifest.currentIndex < manifest.checkpoints.length - 1) {
      manifest.checkpoints = manifest.checkpoints.slice(0, manifest.currentIndex + 1)
    }

    manifest.checkpoints.push(cp)
    // Cap manifest agar tidak membengkak tanpa batas (keep N terakhir)
    if (manifest.checkpoints.length > MAX_CHECKPOINTS) {
      manifest.checkpoints = manifest.checkpoints.slice(-MAX_CHECKPOINTS)
    }
    manifest.currentIndex = manifest.checkpoints.length - 1

    await saveCheckpointManifest(manifest, cwd)
    return cp
  })
}

// Terapkan snapshot dengan jail path: path di luar workspace atau sensitif dilewati.
async function applySnapshots(snapshots: FileSnapshot[], cwd: string): Promise<string[]> {
  const root = resolve(cwd)
  const applied: string[] = []
  for (const snap of snapshots) {
    const absPath = resolve(root, snap.path)
    if (isPathOutsideRoot(absPath, root) || isRealPathOutsideRoot(absPath, root)) {
      applied.push(`${snap.path} (skipped: outside workspace)`)
      continue
    }
    if (isSensitive(absPath) || isOwnedState(absPath)) {
      applied.push(`${snap.path} (skipped: protected path)`)
      continue
    }
    if (snap.content === null) {
      if (existsSync(absPath)) {
        // v0.33: jangan klaim "(removed)" bila `rm` gagal (EBUSY/EPERM).
        try {
          await rm(absPath, { force: true })
          applied.push(`${snap.path} (removed)`)
        } catch (error) {
          const reason =
            error instanceof Error
              ? ((error as NodeJS.ErrnoException).code ?? error.message)
              : String(error)
          applied.push(`${snap.path} (skipped: remove failed: ${reason})`)
        }
      }
    } else {
      await atomicWriteText(absPath, snap.content)
      applied.push(`${snap.path} (restored)`)
    }
  }
  return applied
}

/** Terapkan satu checkpoint: tree git bila ada, else snapshot file. */
async function applyCheckpoint(
  cp: Checkpoint,
  direction: "undo" | "redo",
  cwd: string,
): Promise<string[]> {
  const tree = direction === "undo" ? cp.treeBefore : cp.treeAfter
  if (tree) {
    const res = await restoreTree(cwd, tree)
    return [...res.applied, ...res.skipped.map((s) => `${s} (skipped)`)]
  }
  const snaps = direction === "undo" ? cp.snapshots : cp.redoSnapshots
  if (!snaps) throw new Error(`checkpoint ${cp.id} does not have ${direction} data`)
  return applySnapshots(snaps, cwd)
}

export type WorkspaceSafetySnapshot =
  | { mode: "git"; tree: string }
  | { mode: "files"; snapshots: FileSnapshot[] }

export async function captureWorkspaceSafety(
  sessionId: string,
  cwd: string,
): Promise<WorkspaceSafetySnapshot> {
  const snapshot = await beginTurnSnapshot(sessionId, cwd)
  if (snapshot.mode === "unavailable")
    throw new Error(`workspace snapshot unavailable: ${snapshot.reason}`)
  return snapshot
}

export async function workspaceChangedPaths(
  before: WorkspaceSafetySnapshot,
  after: WorkspaceSafetySnapshot,
  cwd: string,
): Promise<string[]> {
  if (before.mode !== after.mode) throw new Error("workspace snapshot mode changed")
  let paths: string[]
  if (before.mode === "git" && after.mode === "git") {
    const changes = await diffTrees(cwd, before.tree, after.tree, true)
    paths = changes.flatMap((change) => [change.path, ...(change.from ? [change.from] : [])])
  } else {
    const first = new Map(
      (before as { snapshots: FileSnapshot[] }).snapshots.map((s) => [s.path, s.content]),
    )
    const last = new Map(
      (after as { snapshots: FileSnapshot[] }).snapshots.map((s) => [s.path, s.content]),
    )
    paths = [...new Set([...first.keys(), ...last.keys()])].filter(
      (path) => (first.get(path) ?? null) !== (last.get(path) ?? null),
    )
  }
  return [...new Set(paths)].filter(
    (path) => !isOwnedState(resolve(cwd, path)) && !isSensitive(resolve(cwd, path)),
  )
}

export async function applyWorkspacePaths(
  snapshot: WorkspaceSafetySnapshot,
  paths: readonly string[],
  cwd: string,
): Promise<string[]> {
  for (const path of paths) {
    const absolute = resolve(cwd, path)
    if (
      isPathOutsideRoot(absolute, cwd) ||
      isRealPathOutsideRoot(absolute, cwd) ||
      isSensitive(absolute) ||
      isOwnedState(absolute)
    )
      throw new Error(`unsafe restore path: ${path}`)
  }
  if (snapshot.mode === "git")
    return (await restoreTree(cwd, snapshot.tree, { paths, strict: true })).applied
  const contents = new Map(snapshot.snapshots.map((s) => [s.path, s.content]))
  const applied: string[] = []
  for (const path of paths) {
    const content = contents.get(path) ?? null
    if (content === null) await rm(resolve(cwd, path), { force: true })
    else await atomicWriteText(resolve(cwd, path), content)
    applied.push(path)
  }
  return applied
}

/** Pulihkan snapshot safety; dipakai rollback undo dan arah redo rewind. */
export async function restoreWorkspaceSafety(
  snapshot: WorkspaceSafetySnapshot,
  cwd: string = process.cwd(),
): Promise<string[]> {
  if (snapshot.mode === "git") {
    const res = await restoreTree(cwd, snapshot.tree)
    return [...res.applied, ...res.skipped.map((s) => `${s} (skipped)`)]
  }
  return applySnapshots(snapshot.snapshots, cwd)
}

/**
 * Undo berkas ke keadaan SEBELUM turn target, bukan hanya checkpoint terakhir.
 *
 * Checkpoint dipilih dari **timestamp event prompt**, bukan nomor turn:
 * `state.turnCount` hanya maju pada turn sukses, sehingga turn gagal dan turn
 * berikutnya bisa berbagi nomor yang sama. Checkpoint pertama pada/after
 * timestamp target adalah titik file-change pertama sejak batas; treeBefore-nya
 * tepat keadaan workspace di batas itu.
 *
 * Snapshot safety diambil SEBELUM apply agar kegagalan di tengah restore bisa
 * dikembalikan dan redo punya keadaan tujuan yang utuh.
 */
export async function undoFilesToTurn(
  sessionId: string,
  targetEventTs: number,
  cwd: string = process.cwd(),
  opts?: { fallbackTurn?: number; beforeTs?: number },
): Promise<{
  noCheckpoint: boolean
  checkpoint?: Checkpoint
  restoredFiles: string[]
  safety?: WorkspaceSafetySnapshot
}> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    const timed =
      targetEventTs > 0
        ? manifest.checkpoints.find((cp) => {
            const ts = Date.parse(cp.timestamp)
            return (
              Number.isFinite(ts) &&
              ts >= targetEventTs &&
              (opts?.beforeTs === undefined || ts < opts.beforeTs)
            )
          })
        : undefined
    const checkpoint =
      timed ??
      (opts?.fallbackTurn !== undefined && opts.beforeTs === undefined
        ? manifest.checkpoints.find((cp) => cp.turn >= opts.fallbackTurn!)
        : undefined)
    if (!checkpoint) return { noCheckpoint: true, restoredFiles: [] }

    const pre = await beginTurnSnapshot(sessionId, cwd)
    if (pre.mode === "unavailable") {
      throw new Error(`workspace safety snapshot unavailable: ${pre.reason}`)
    }
    const safety: WorkspaceSafetySnapshot =
      pre.mode === "git"
        ? { mode: "git", tree: pre.tree }
        : { mode: "files", snapshots: pre.snapshots }
    let restoredFiles: string[]
    try {
      restoredFiles = await applyCheckpoint(checkpoint, "undo", cwd)
    } catch (error) {
      await restoreWorkspaceSafety(safety, cwd).catch(() => {})
      throw error
    }

    // Pointer manifest sumber TIDAK diubah di sini: rewind membuat cabang dan
    // membiarkan sesi sumber utuh untuk /redo. Karena itu marker undo (yang
    // menyatakan newIndex) juga tidak ditulis — marker basi justru bisa
    // diadopsi rekonsiliasi sebagai pointer yang salah.
    return { noCheckpoint: false, checkpoint, restoredFiles, safety }
  })
}

/** Salin checkpoint sebelum timestamp event prompt ke manifest sesi cabang. */
export async function copyCheckpointPrefix(
  srcSessionId: string,
  dstSessionId: string,
  beforeTimestamp: number,
  cwd: string = process.cwd(),
): Promise<number> {
  const src = await loadCheckpointManifest(srcSessionId, cwd)
  const checkpoints = src.checkpoints.filter((cp) => {
    const ts = Date.parse(cp.timestamp)
    return Number.isFinite(ts) && ts < beforeTimestamp
  })
  if (checkpoints.length === 0) return 0
  await saveCheckpointManifest(
    {
      sessionId: dstSessionId,
      currentIndex: checkpoints.length - 1,
      checkpoints,
    },
    cwd,
  )
  return checkpoints.length
}

export async function undoLastCheckpoint(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{ success: boolean; restoredFiles: string[]; message: string }> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.currentIndex < 0 || manifest.checkpoints.length === 0) {
      return { success: false, restoredFiles: [], message: "no checkpoints to undo" }
    }

    const targetCp = manifest.checkpoints[manifest.currentIndex]!
    if (!targetCp.redoSnapshots && !targetCp.treeAfter && targetCp.snapshots) {
      try {
        const redoSnaps: FileSnapshot[] = []
        for (const snap of targetCp.snapshots) {
          redoSnaps.push(await captureFileSnapshot(resolve(cwd, snap.path), cwd))
        }
        targetCp.redoSnapshots = redoSnaps
      } catch {}
    }
    const restoredFiles = await applyCheckpoint(targetCp, "undo", cwd)

    // Urutan: marker DULU (bukti durable niat+hasil apply), pointer-disk
    // TERAKHIR. Crash apply→save: marker + pointer basi → rekonsiliasi
    // mengadopsi pointer (P0-3). Marker gagal ≠ save batal (lanjut save).
    const newIndex = manifest.currentIndex - 1
    await appendUndoMarker(sessionId, cwd, "undo", targetCp.turn, {
      newIndex,
      files: restoredFiles.length,
    }).catch((e) => {
      process.stderr.write(`[warn] journal: undo marker failed: ${(e as Error).message}\n`)
    })
    manifest.currentIndex = newIndex
    await saveCheckpointManifest(manifest, cwd)

    return {
      success: true,
      restoredFiles,
      message: `undid checkpoint ${targetCp.id} (turn ${targetCp.turn})`,
    }
  })
}

export async function redoLastCheckpoint(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{ success: boolean; reappliedFiles: string[]; message: string }> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.currentIndex >= manifest.checkpoints.length - 1) {
      return { success: false, reappliedFiles: [], message: "no undone checkpoints to redo" }
    }

    // Protokol UNIFORM dengan undo (P0-3): hitung target DULU tanpa mutasi
    // pointer, apply files, tulis marker, BARU persist pointer. Versi lama
    // increment pointer di memori sebelum apply — hilang saat crash dan
    // mengaburkan jendela crash (pointer-memory vs pointer-disk berbeda).
    const targetIndex = manifest.currentIndex + 1
    const targetCp = manifest.checkpoints[targetIndex]!
    if (!targetCp.treeAfter && !targetCp.redoSnapshots) {
      return {
        success: false,
        reappliedFiles: [],
        message: `checkpoint ${targetCp.id} (turn ${targetCp.turn}) does not have redo data`,
      }
    }
    const reappliedFiles = await applyCheckpoint(targetCp, "redo", cwd)

    await appendUndoMarker(sessionId, cwd, "redo", targetCp.turn, {
      newIndex: targetIndex,
      files: reappliedFiles.length,
    }).catch((e) => {
      process.stderr.write(`[warn] journal: redo marker failed: ${(e as Error).message}\n`)
    })
    manifest.currentIndex = targetIndex
    await saveCheckpointManifest(manifest, cwd)

    return {
      success: true,
      reappliedFiles,
      message: `redid checkpoint ${targetCp.id} (turn ${targetCp.turn})`,
    }
  })
}

/**
 * Rekonsiliasi pointer undo/redo pasca-crash (P0-3).
 *
 * Protokol apply → marker → save menyisakan satu jendela: marker durable,
 * pointer-disk basi. Crash di sana membuat resume melihat pointer yang
 * menunjuk TERLALU TUA sementara file sudah di-apply. Fungsi ini menutupnya
 * secara deterministik: marker undo/redo TERBARU yang valid (indeks dalam
 * batas + turn cocok dengan checkpoint pada indeks itu) diadopsi sebagai
 * pointer — metadata-only, tanpa menyentuh file (file sudah benar).
 *
 * Tanpa marker / marker cocok pointer / marker invalid → null (no-op).
 * Idempoten: pemanggilan ulang menghasilkan null setelah adopsi pertama.
 */
export async function reconcileUndoRedoPointer(
  sessionId: string,
  cwd: string = process.cwd(),
): Promise<{
  repaired: boolean
  from: number
  to: number
  kind: "undo" | "redo"
  files: number
} | null> {
  const manifestPath = getManifestPath(sessionId, cwd)
  return withCheckpointLock(manifestPath, async () => {
    const manifest = await loadCheckpointManifest(sessionId, cwd)
    if (manifest.checkpoints.length === 0) return null
    let markers: {
      kind: "undo" | "redo"
      targetTurn?: number
      newIndex?: number
      files?: number
      seq: number
    }[]
    try {
      const loaded = await loadJournal(sessionId, cwd)
      markers = loaded.records
        .filter((r) => (r.kind === "undo" || r.kind === "redo") && typeof r.seq === "number")
        .map((r) => ({
          kind: r.kind as "undo" | "redo",
          targetTurn: r.targetTurn,
          newIndex: r.newIndex,
          files: r.files,
          seq: r.seq as number,
        }))
    } catch {
      return null
    }
    if (markers.length === 0) return null
    const latest = markers.sort((a, b) => a.seq - b.seq)[markers.length - 1]!
    if (latest.newIndex === undefined) return null // marker lama tanpa pointer
    if (latest.newIndex === manifest.currentIndex) return null // konvergen
    if (latest.newIndex < -1 || latest.newIndex > manifest.checkpoints.length - 1) {
      process.stderr.write(
        `[warn] checkpoint: undo/redo marker menunjuk indeks invalid (${latest.newIndex}) — diabaikan, pointer dipertahankan\n`,
      )
      return null
    }
    // Turn harus cocok: marker untuk susunan checkpoints yang berbeda
    // (eviksi/cabang lain) tak boleh diadopsi buta.
    // Pada undo: targetCp yang dibatalkan berada di indeks newIndex + 1 (newIndex -1 → checkpoint 0).
    // Pada redo: targetCp yang diaplikasikan kembali berada tepat di latest.newIndex.
    const targetIdx = latest.kind === "undo" ? latest.newIndex + 1 : latest.newIndex
    const pointed = manifest.checkpoints[targetIdx]
    if (!pointed || (latest.targetTurn !== undefined && pointed.turn !== latest.targetTurn)) {
      const actualTurn = pointed ? ` (turn ${pointed.turn})` : " (absen)"
      process.stderr.write(
        `[warn] checkpoint: ${latest.kind} marker turn ${latest.targetTurn} tak cocok checkpoint idx ${targetIdx}${actualTurn} — diabaikan\n`,
      )
      return null
    }
    const from = manifest.currentIndex
    manifest.currentIndex = latest.newIndex
    await saveCheckpointManifest(manifest, cwd)
    process.stderr.write(
      `[recovery] checkpoint pointer dipulihkan ${from} → ${latest.newIndex} (${latest.kind} turn ${latest.targetTurn ?? "?"}, ${latest.files ?? 0} file)\n`,
    )
    return {
      repaired: true,
      from,
      to: latest.newIndex,
      kind: latest.kind,
      files: latest.files ?? 0,
    }
  })
}
