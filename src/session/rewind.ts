import { randomUUID } from "node:crypto"
import { type FileHandle, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { hostname, uptime } from "node:os"
import { join, resolve } from "node:path"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import {
  isOwnedState,
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
} from "../policy/jail.ts"
import {
  applyWorkspacePaths,
  type Checkpoint,
  captureWorkspaceSafety,
  loadCheckpointManifest,
  saveCheckpointManifest,
  type WorkspaceSafetySnapshot,
  workspaceChangedPaths,
} from "./checkpoint.ts"
import {
  branchSession,
  deleteSession,
  getActiveRun,
  hasExplicitFileMutationAtOrAfter,
  listSessionTurns,
  loadPresentationEvents,
  loadSession,
  messageHead,
  presentationHead,
  readWriterEpoch,
} from "./persistence.ts"

export interface UserTurn {
  ordinal: number
  turnId: number
  prompt: string
  ts: number
  eventSeq: number
  beforeSeq?: number
  beforeMessages?: unknown[]
  checkpointId?: string | null
  status?: string
}

export interface RewindFilePlan {
  target: WorkspaceSafetySnapshot
  original: WorkspaceSafetySnapshot
  paths: string[]
}

export interface RewindRecord {
  v: 1
  branchSessionId: string
  sourceSessionId: string
  targetOrdinal: number
  targetTurnId: number
  prompt: string
  createdAt: string
  safety: WorkspaceSafetySnapshot | null
  plan?: RewindFilePlan
  state?: "prepared" | "applied" | "rolled_back" | "redone"
  branchMessageHead?: number
  branchEventHead?: number
  branchUserTurns?: number
}

export interface RewindResult {
  branchId: string
  restoredFiles: string[]
  checkpointTurn: number | null
}

function directory(cwd: string): string {
  return resolve(cwd, ".minicode", "rewinds")
}
function recordPath(id: string, cwd: string): string {
  return join(directory(cwd), `${sanitizeSessionPart(id)}.json`)
}

export function listUserTurns(sessionId: string, cwd?: string): UserTurn[] {
  const ledger = listSessionTurns(sessionId, cwd)
  const events = loadPresentationEvents(sessionId, cwd)
  const users = events.filter((event) => event.type === "user.message")
  const legacy = users
    .filter((event) => !ledger.length || event.eventSeq < ledger[0]!.beforeEventSeq)
    .map((event, index) => ({
      ordinal: index + 1,
      turnId: event.turnId,
      prompt: event.text,
      ts: event.ts,
      eventSeq: event.eventSeq,
    }))
  if (ledger.length)
    return [
      ...legacy,
      ...ledger.map((turn) => ({
        ordinal: turn.ordinal,
        turnId: turn.ordinal - 1,
        prompt: turn.prompt,
        ts: turn.startedAt,
        eventSeq: turn.beforeEventSeq,
        beforeSeq: turn.beforeSeq,
        beforeMessages: turn.beforeMessages,
        checkpointId: turn.checkpointId,
        status: turn.status,
      })),
    ]
  if (legacy.length) return legacy
  const messages = loadSession(sessionId, cwd)?.messages ?? []
  const result: UserTurn[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as { role?: string; content?: unknown }
    if (message.role === "user" && typeof message.content === "string") {
      result.push({
        ordinal: result.length + 1,
        turnId: result.length,
        prompt: message.content,
        ts: 0,
        eventSeq: -1,
        beforeSeq: index,
        beforeMessages: messages.slice(0, index),
      })
    }
  }
  return result
}

/**
 * Batas usia lock rewind sebelum dianggap basi. Bisa diubah operator lewat env
 * (milidetik); default 10 menit. Garda ini menutup kasus crash + PID reuse:
 * `process.kill(pid, 0)` bisa selalu sukses pada PID yang didaur ulang, sehingga
 * lock lama tanpa batas usia memblokir rewind selamanya.
 */
const REWIND_LOCK_MAX_AGE_MS = (() => {
  const raw = Number(process.env.MINICODE_REWIND_LOCK_MAX_AGE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000
})()

interface RewindLockContent {
  pid: number
  bootId: string
  createdAt: number
}

/** Penanda boot yang stabil selama satu sesi boot mesin. */
function rewindBootMarker(): string {
  const fromEnv = process.env.MINICODE_BOOT_ID?.trim()
  if (fromEnv) return fromEnv
  // `Date.now() - uptime()` konstan dalam satu boot (keduanya naik bersama).
  // Bulatkan ke menit agar jitter sub-detik tak mengubah penanda antar-proses.
  const bootStart = Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000
  return `${hostname()}:${bootStart}`
}

/**
 * Terima format baru ({pid,bootId,createdAt}) dan format lama (PID numerik).
 * Format lama tak punya createdAt/bootId — staleness-nya memakai mtime berkas.
 */
function parseRewindLock(raw: string): Partial<RewindLockContent> | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<RewindLockContent>
      if (
        typeof parsed.pid === "number" &&
        Number.isSafeInteger(parsed.pid) &&
        parsed.pid >= 1 &&
        typeof parsed.bootId === "string" &&
        typeof parsed.createdAt === "number" &&
        Number.isFinite(parsed.createdAt)
      )
        return parsed
    } catch {}
    return null
  }
  const pid = Number(trimmed)
  return Number.isSafeInteger(pid) && pid >= 1 ? { pid } : null
}

/** Klaim lock basi (boot beda / terlalu tua / PID mati); lock hidup dilempar. */
async function reclaimRewindLock(path: string): Promise<FileHandle> {
  let raw: string
  let mtimeMs: number
  try {
    raw = await readFile(path, "utf8")
    mtimeMs = (await stat(path)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Berkas hilang di antara EEXIST dan baca — langsung coba acquire lagi.
      return await open(path, "wx", 0o600)
    }
    throw error
  }
  const lock = parseRewindLock(raw)
  if (!lock) throw new Error("invalid rewind lock; recovery required")
  const now = Date.now()
  // Format lama tak punya createdAt — jangan menyumbang staleness (mtime saja
  // yang dipakai). Sentinel Infinity justru membuat semua lock lama selalu basi.
  const staleByContent =
    lock.createdAt !== undefined && now - lock.createdAt > REWIND_LOCK_MAX_AGE_MS
  const bootStale = lock.bootId !== undefined && lock.bootId !== rewindBootMarker()
  const staleByAge = now - mtimeMs > REWIND_LOCK_MAX_AGE_MS || staleByContent
  if (!bootStale && !staleByAge) {
    // Masih segar: pertahankan pemeriksaan PID liveness yang sudah ada.
    try {
      process.kill(lock.pid!, 0)
      throw new Error("another rewind operation is active")
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure
    }
  }
  await rm(path)
  return await open(path, "wx", 0o600)
}

async function withOperation<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const dir = directory(cwd)
  if (isRealPathOutsideRoot(dir, cwd)) throw new Error("rewind state is outside the workspace")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "operation.lock")
  const acquire = async (): Promise<FileHandle> => {
    try {
      return await open(path, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return await reclaimRewindLock(path)
      throw error
    }
  }
  let handle: FileHandle
  try {
    handle = await acquire()
  } catch (error) {
    // TOCTOU: proses lain menghapus/buat lock tepat setelah pengecekan EEXIST.
    // Satu retry menutup jendela ini tanpa memutar loop tak terbatas.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    handle = await acquire()
  }
  const content: RewindLockContent = {
    pid: process.pid,
    bootId: rewindBootMarker(),
    createdAt: Date.now(),
  }
  await handle.writeFile(JSON.stringify(content))
  try {
    return await action()
  } finally {
    await handle.close()
    await rm(path, { force: true })
  }
}

async function writeActive(source: string, target: string, cwd: string): Promise<void> {
  await atomicWriteText(
    join(directory(cwd), "active-session.json"),
    JSON.stringify({ source, target }),
  )
}

function conversationOnlyPlan(
  source: string,
  target: UserTurn,
  beforeSeq: number,
  cwd: string,
): { plan?: RewindFilePlan; checkpointTurn: number | null } {
  if (fileTouch(source, target, beforeSeq, cwd).mutated)
    throw new Error("pemulihan berkas membutuhkan BUILD dan izin tulis")
  return { checkpointTurn: null }
}

function snapshotOf(checkpoint: Checkpoint, after: boolean): WorkspaceSafetySnapshot {
  const tree = after ? checkpoint.treeAfter : checkpoint.treeBefore
  if (tree) return { mode: "git", tree }
  const snapshots = after ? checkpoint.redoSnapshots : checkpoint.snapshots
  if (!snapshots) throw new Error(`checkpoint incomplete: ${checkpoint.id}`)
  return { mode: "files", snapshots }
}

/**
 * Apakah turn target (termasuk turn sesudahnya yang ikut dibuang) menyentuh
 * berkas. Dipakai dua kali: untuk memilih checkpoint dan untuk menolak undo
 * percakapan-saja di DISCUSS SEBELUM error checkpoint muncul — pesan "butuh
 * BUILD" lebih actionable daripada "checkpoint tidak tersedia".
 */
function fileTouch(
  source: string,
  target: UserTurn,
  beforeSeq: number,
  cwd: string,
): { mutated: boolean; targetChanged: boolean; nextTs?: number } {
  const events = loadPresentationEvents(source, cwd)
  const next = events.find(
    (event) => event.type === "user.message" && event.eventSeq > target.eventSeq,
  )
  const targetChanged = events.some(
    (event) =>
      event.type === "file.changed" &&
      event.eventSeq > target.eventSeq &&
      (!next || event.eventSeq < next.eventSeq),
  )
  const mutated =
    targetChanged ||
    hasExplicitFileMutationAtOrAfter(source, beforeSeq, cwd) ||
    events.some((event) => event.type === "file.changed" && event.eventSeq > target.eventSeq)
  return { mutated, targetChanged, ...(next ? { nextTs: next.ts } : {}) }
}

async function filePlan(
  source: string,
  target: UserTurn,
  beforeSeq: number,
  cwd: string,
): Promise<{ plan?: RewindFilePlan; checkpointTurn: number | null }> {
  const manifest = await loadCheckpointManifest(source, cwd)
  let checkpoints: Checkpoint[]
  if (target.checkpointId !== undefined) {
    const turns = listSessionTurns(source, cwd).filter((turn) => turn.ordinal >= target.ordinal)
    if (turns.some((turn) => turn.status === "RUNNING" || turn.checkpointId === null))
      throw new Error("turn checkpoint unavailable; refusing partial rewind")
    const ids = turns
      .map((turn) => turn.checkpointId)
      .filter((id): id is string => id !== null && id !== "none")
    checkpoints = ids.map((id) => {
      const checkpoint = manifest.checkpoints.find((item) => item.id === id)
      if (!checkpoint) throw new Error("checkpoint outside retention; refusing partial rewind")
      return checkpoint
    })
  } else {
    checkpoints = manifest.checkpoints
      .slice(0, manifest.currentIndex + 1)
      .filter((checkpoint) =>
        target.ts > 0
          ? Date.parse(checkpoint.timestamp) >= target.ts
          : checkpoint.turn >= target.ordinal,
      )
    const touch = fileTouch(source, target, beforeSeq, cwd)
    if (
      touch.mutated &&
      (!checkpoints.length ||
        (touch.targetChanged &&
          touch.nextTs !== undefined &&
          Date.parse(checkpoints[0]!.timestamp) >= touch.nextTs))
    )
      throw new Error("checkpoint tidak tersedia; refusing partial rewind")
  }
  if (!checkpoints.length) return { checkpointTurn: null }
  const paths = new Set<string>()
  for (const checkpoint of checkpoints) {
    for (const path of await workspaceChangedPaths(
      snapshotOf(checkpoint, false),
      snapshotOf(checkpoint, true),
      cwd,
    ))
      paths.add(path)
  }
  const original = await captureWorkspaceSafety(source, cwd)
  const last = snapshotOf(checkpoints[checkpoints.length - 1]!, true)
  const conflict = (await workspaceChangedPaths(last, original, cwd)).filter((path) =>
    paths.has(path),
  )
  if (conflict.length)
    throw new Error(`manual changes would be overwritten: ${conflict.join(", ")}`)
  for (let index = 1; index < checkpoints.length; index++) {
    const gap = await workspaceChangedPaths(
      snapshotOf(checkpoints[index - 1]!, true),
      snapshotOf(checkpoints[index]!, false),
      cwd,
    )
    if (gap.some((path) => paths.has(path)))
      throw new Error("manual changes between turns prevent safe rewind")
  }
  return {
    plan: { target: snapshotOf(checkpoints[0]!, false), original, paths: [...paths] },
    checkpointTurn: checkpoints[0]!.turn,
  }
}

async function applyTransition(
  plan: RewindFilePlan,
  direction: "undo" | "redo",
  id: string,
  cwd: string,
): Promise<string[]> {
  const expected = direction === "undo" ? plan.original : plan.target
  const target = direction === "undo" ? plan.target : plan.original
  const now = await captureWorkspaceSafety(id, cwd)
  const conflict = (await workspaceChangedPaths(expected, now, cwd)).filter((path) =>
    plan.paths.includes(path),
  )
  if (conflict.length)
    throw new Error(`manual changes would be overwritten: ${conflict.join(", ")}`)
  return applyWorkspacePaths(target, plan.paths, cwd)
}

interface PendingOperation {
  record: RewindRecord
  direction: "undo" | "redo"
}

async function rollbackPending(pending: PendingOperation, cwd: string): Promise<void> {
  const { record, direction } = pending
  if (record.plan) {
    const current = await captureWorkspaceSafety(record.sourceSessionId, cwd)
    const from = direction === "undo" ? record.plan.original : record.plan.target
    const to = direction === "undo" ? record.plan.target : record.plan.original
    const differsFrom = new Set(await workspaceChangedPaths(current, from, cwd))
    const differsTo = new Set(await workspaceChangedPaths(current, to, cwd))
    if (record.plan.paths.some((path) => differsFrom.has(path) && differsTo.has(path)))
      throw new Error("rewind recovery conflicts with external changes; nothing overwritten")
    await applyWorkspacePaths(from, record.plan.paths, cwd)
  }
  record.state = direction === "undo" ? "rolled_back" : "applied"
  await atomicWriteText(recordPath(record.branchSessionId, cwd), JSON.stringify(record))
  await writeActive(
    record.sourceSessionId,
    direction === "undo" ? record.sourceSessionId : record.branchSessionId,
    cwd,
  )
  await rm(join(directory(cwd), "pending.json"), { force: true })
  if (direction === "undo" && loadSession(record.branchSessionId, cwd))
    await deleteSession(record.branchSessionId, cwd)
}

export async function recoverRewindWorkspace(
  cwd: string,
  requestedSession?: string,
): Promise<string | undefined> {
  let pending: PendingOperation | undefined
  try {
    pending = JSON.parse(await readFile(join(directory(cwd), "pending.json"), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (pending) {
    if (
      !pending.record ||
      (pending.direction !== "undo" && pending.direction !== "redo") ||
      !validRecord(pending.record, cwd)
    )
      throw new Error("invalid rewind intent; recovery required")
    await withOperation(cwd, () => rollbackPending(pending!, cwd))
  }
  try {
    const active = JSON.parse(
      await readFile(join(directory(cwd), "active-session.json"), "utf8"),
    ) as { source?: unknown; target?: unknown }
    if (
      requestedSession &&
      active.source === requestedSession &&
      typeof active.target === "string" &&
      active.target !== requestedSession
    ) {
      if (!loadSession(active.target, cwd)) throw new Error("active rewind branch is missing")
      return active.target
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return undefined
}

/**
 * Turn benar-benar berjalan? Run sukses sengaja TETAP `RUNNING` sampai turn
 * berikutnya atau close (kontrak P4-E09), jadi baris run saja bukan bukti.
 * Bukti yang tepat: ledger turn masih `RUNNING` DAN run-nya masih `RUNNING`.
 * Setelah crash + resume, run sudah di-tombstone sementara ledger bisa
 * tertinggal — kondisi itu tidak boleh memblokir rewind selamanya.
 */
function turnIsRunning(sessionId: string, cwd: string): boolean {
  if (!getActiveRun(sessionId, cwd)) return false
  return listSessionTurns(sessionId, cwd).some((turn) => turn.status === "RUNNING")
}

export async function rewindToTurn(opts: {
  sourceSessionId: string
  target: UserTurn
  cwd: string
  beforeSeq: number
  allowFiles?: boolean
}): Promise<RewindResult> {
  const { sourceSessionId, target, cwd } = opts
  return withOperation(cwd, async () => {
    if (turnIsRunning(sourceSessionId, cwd)) throw new Error("cannot rewind while a turn is active")
    const source = loadSession(sourceSessionId, cwd)
    if (!source || (source.cwd && resolve(source.cwd) !== resolve(cwd)))
      throw new Error("session workspace mismatch")
    const epoch = readWriterEpoch(sourceSessionId, cwd)
    const head = messageHead(sourceSessionId, cwd)
    const beforeSeq = target.beforeSeq ?? opts.beforeSeq
    // DISCUSS/izin baca-saja: tanpa rencana berkas sama sekali. Turn yang
    // menyentuh berkas ditolak lebih dulu agar alasannya mode, bukan checkpoint.
    const files =
      opts.allowFiles === false
        ? conversationOnlyPlan(sourceSessionId, target, beforeSeq, cwd)
        : await filePlan(sourceSessionId, target, beforeSeq, cwd)
    const branchId = `rewind_${randomUUID().replace(/-/g, "").slice(0, 24)}`
    await branchSession(sourceSessionId, branchId, cwd, {
      beforeSeq,
      beforeMessages: target.beforeMessages,
      beforeOrdinal: target.ordinal,
      ...(target.eventSeq >= 0
        ? { beforeEventSeq: target.eventSeq, beforeTurnTs: target.ts }
        : { beforeTurnId: target.turnId }),
    })
    const previous = await loadCheckpointManifest(sourceSessionId, cwd)
    const ids = new Set(
      listSessionTurns(sourceSessionId, cwd)
        .filter((turn) => turn.ordinal < target.ordinal)
        .map((turn) => turn.checkpointId),
    )
    const prefix = previous.checkpoints.filter((checkpoint) =>
      target.checkpointId !== undefined
        ? ids.has(checkpoint.id)
        : target.ts > 0
          ? Date.parse(checkpoint.timestamp) < target.ts
          : checkpoint.turn < target.ordinal,
    )
    await saveCheckpointManifest(
      { sessionId: branchId, currentIndex: prefix.length - 1, checkpoints: prefix },
      cwd,
    )
    const record: RewindRecord = {
      v: 1,
      branchSessionId: branchId,
      sourceSessionId,
      targetOrdinal: target.ordinal,
      targetTurnId: target.turnId,
      prompt: target.prompt,
      createdAt: new Date().toISOString(),
      safety: files.plan?.original ?? null,
      plan: files.plan,
      state: "prepared",
      branchMessageHead: messageHead(branchId, cwd),
      branchEventHead: presentationHead(branchId, cwd),
      branchUserTurns: listUserTurns(branchId, cwd).length,
    }
    const pending: PendingOperation = { record, direction: "undo" }
    await atomicWriteText(join(directory(cwd), "pending.json"), JSON.stringify(pending))
    try {
      if (
        epoch !== readWriterEpoch(sourceSessionId, cwd) ||
        head !== messageHead(sourceSessionId, cwd)
      )
        throw new Error("source session changed during rewind")
      const restoredFiles = files.plan
        ? await applyTransition(files.plan, "undo", sourceSessionId, cwd)
        : []
      record.state = "applied"
      await atomicWriteText(recordPath(branchId, cwd), JSON.stringify(record))
      await writeActive(sourceSessionId, branchId, cwd)
      await rm(join(directory(cwd), "pending.json"))
      return { branchId, restoredFiles, checkpointTurn: files.checkpointTurn }
    } catch (error) {
      try {
        await rollbackPending(pending, cwd)
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "rewind failed; durable intent retained for recovery",
        )
      }
      throw error
    }
  })
}

function validSnapshot(value: unknown, cwd: string): value is WorkspaceSafetySnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as { mode?: unknown; tree?: unknown; snapshots?: unknown }
  if (snapshot.mode === "git")
    return typeof snapshot.tree === "string" && /^[0-9a-f]{40,64}$/.test(snapshot.tree)
  return (
    snapshot.mode === "files" &&
    Array.isArray(snapshot.snapshots) &&
    snapshot.snapshots.every((item) => {
      if (!item || typeof item !== "object") return false
      const entry = item as { path?: unknown; content?: unknown }
      return (
        typeof entry.path === "string" &&
        !isPathOutsideRoot(resolve(cwd, entry.path), cwd) &&
        (entry.content === null || typeof entry.content === "string")
      )
    })
  )
}

function validRecord(value: unknown, cwd: string): value is RewindRecord {
  if (!value || typeof value !== "object") return false
  const record = value as RewindRecord
  if (
    record.v !== 1 ||
    typeof record.branchSessionId !== "string" ||
    typeof record.sourceSessionId !== "string" ||
    !/^[\w.-]{1,64}$/.test(record.branchSessionId) ||
    !/^[\w.-]{1,64}$/.test(record.sourceSessionId) ||
    typeof record.prompt !== "string" ||
    !Number.isSafeInteger(record.targetOrdinal) ||
    record.targetOrdinal < 1 ||
    !Number.isSafeInteger(record.targetTurnId)
  )
    return false
  if (record.safety !== null && !validSnapshot(record.safety, cwd)) return false
  if (
    record.plan &&
    (!validSnapshot(record.plan.target, cwd) ||
      !validSnapshot(record.plan.original, cwd) ||
      !Array.isArray(record.plan.paths) ||
      !record.plan.paths.every(
        (path) =>
          typeof path === "string" &&
          !isPathOutsideRoot(resolve(cwd, path), cwd) &&
          !isOwnedState(resolve(cwd, path)) &&
          !isSensitive(resolve(cwd, path)),
      ))
  )
    return false
  return true
}

export async function readRewindRecord(
  sessionId: string,
  cwd: string,
): Promise<RewindRecord | null> {
  try {
    const record: unknown = JSON.parse(await readFile(recordPath(sessionId, cwd), "utf8"))
    return validRecord(record, cwd) && record.branchSessionId === sessionId ? record : null
  } catch {
    return null
  }
}

export async function restoreRewindTarget(record: RewindRecord, cwd: string): Promise<string[]> {
  return withOperation(cwd, async () => {
    if (!validRecord(record, cwd) || (record.state && record.state !== "applied"))
      throw new Error("redo record is not active")
    if (record.safety && !record.plan) throw new Error("legacy redo has no safe file transition")
    if (!loadSession(record.sourceSessionId, cwd)) throw new Error("redo source session missing")
    if (
      turnIsRunning(record.branchSessionId, cwd) ||
      messageHead(record.branchSessionId, cwd) !== record.branchMessageHead ||
      listUserTurns(record.branchSessionId, cwd).length !== record.branchUserTurns
    )
      throw new Error("new work makes redo unavailable")
    const pending: PendingOperation = { record, direction: "redo" }
    await atomicWriteText(join(directory(cwd), "pending.json"), JSON.stringify(pending))
    try {
      const paths = record.plan
        ? await applyTransition(record.plan, "redo", record.branchSessionId, cwd)
        : []
      await writeActive(record.sourceSessionId, record.sourceSessionId, cwd)
      record.state = "redone"
      await atomicWriteText(recordPath(record.branchSessionId, cwd), JSON.stringify(record))
      await rm(join(directory(cwd), "pending.json"))
      return paths
    } catch (error) {
      try {
        await rollbackPending(pending, cwd)
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "redo failed; durable intent retained for recovery",
        )
      }
      throw error
    }
  })
}
