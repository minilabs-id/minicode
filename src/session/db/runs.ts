import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { assertWriterEpochInTxn, openSessionHandle, sessionRowExistsInTxn } from "./schema.ts"

export type RunStatus = "CREATED" | "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED"

export const RUN_TERMINAL: ReadonlySet<string> = new Set(["COMPLETED", "INTERRUPTED", "FAILED"])

export interface RunRow {
  run_id: string
  session_id: string
  thread_id: string
  status: RunStatus
  started_at: number
  ended_at: number | null
  last_persisted_seq: number
  pending_tool_ids: string
  recovery_status: string | null
  takeover_epoch: number | null
  created_at: number
}

const RUN_ID_RE = /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_RE.test(value)
}

export function allocateRunId(): string {
  return `run_${randomUUID()}`
}

export class RunStatusError extends Error {
  readonly code = "RUN_INVALID_TRANSITION"
  constructor(runId: string, from: string, to: string) {
    super(`[run] RUN_INVALID_TRANSITION ${runId}: ${from} → ${to} refused`)
    this.name = "RunStatusError"
  }
}

export class RunTerminalConflictError extends Error {
  readonly code = "RUN_TERMINAL_CONFLICT"
  constructor(runId: string, from: string, to: string) {
    super(
      `[run] RUN_TERMINAL_CONFLICT ${runId}: already terminal ${from}, refusing conflicting ${to} (first terminal wins)`,
    )
    this.name = "RunTerminalConflictError"
  }
}

export class RunRunningExistsError extends Error {
  readonly code = "RUNNING_EXISTS"
  constructor(sessionId: string) {
    super(`[run] RUNNING_EXISTS ${sessionId}: a RUNNING run already holds this session`)
    this.name = "RunRunningExistsError"
  }
}

export class RunCursorError extends Error {
  readonly code: "RUN_CURSOR_BACKWARD" | "RUN_CURSOR_BEYOND_HEAD" | "RUN_CURSOR_FOREIGN"
  constructor(code: RunCursorError["code"], runId: string, detail: string) {
    super(`[run] ${code} ${runId}: ${detail}`)
    this.name = "RunCursorError"
    this.code = code
  }
}

export class RunPendingError extends Error {
  readonly code = "RUN_PENDING_MALFORMED"
  constructor(detail: string) {
    super(`[run] RUN_PENDING_MALFORMED: ${detail}`)
    this.name = "RunPendingError"
  }
}

function rowToRun(row: RunRow): RunRow {
  return { ...row }
}

const RUN_COLUMNS =
  "run_id, session_id, thread_id, status, started_at, ended_at, last_persisted_seq, pending_tool_ids, recovery_status, takeover_epoch, created_at"

export function getRun(runId: string, cwd?: string): RunRow | null {
  const db = openSessionHandle(cwd)
  try {
    const row = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | null
    return row ? rowToRun(row) : null
  } finally {
    db.close()
  }
}

export function listSessionRuns(sessionId: string, cwd?: string): RunRow[] {
  const db = openSessionHandle(cwd)
  try {
    return (
      db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? ORDER BY started_at`)
        .all(sessionId) as RunRow[]
    ).map(rowToRun)
  } finally {
    db.close()
  }
}

export function getActiveRun(sessionId: string, cwd?: string): RunRow | null {
  const db = openSessionHandle(cwd)
  try {
    const row = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE session_id = ? AND status = 'RUNNING' LIMIT 1`,
      )
      .get(sessionId) as RunRow | null
    return row ? rowToRun(row) : null
  } finally {
    db.close()
  }
}

export function assessRunRecoveryStatus(run: RunRow): "NONE" | "UNKNOWN" {
  if (run.recovery_status === "UNKNOWN") return "UNKNOWN"
  if (run.status === "RUNNING") return "UNKNOWN"
  return "NONE"
}

function validatePendingToolIds(value: unknown): string {
  if (!Array.isArray(value)) throw new RunPendingError("pending_tool_ids must be an array")
  if (value.length > 256) throw new RunPendingError("pending_tool_ids exceeds 256 entries")
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) {
      throw new RunPendingError("pending_tool_ids entries must be non-empty strings ≤512 chars")
    }
  }
  return JSON.stringify(value)
}

export function createRun(
  sessionId: string,
  threadId: string,
  cwd?: string,
  opts?: { runId?: string; pendingToolIds?: unknown; expectedEpoch?: number },
): RunRow {
  const db = openSessionHandle(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      if (!sessionRowExistsInTxn(db, sessionId)) throw new Error(`session not found: ${sessionId}`)
      const thread = db
        .prepare("SELECT thread_id FROM threads WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { thread_id: string } | null
      if (!thread) throw new Error(`thread not found: ${sessionId}/${threadId}`)
      const runId = opts?.runId ?? allocateRunId()
      if (!isRunId(runId)) throw new Error(`invalid run id: ${opts?.runId}`)
      const pending =
        opts?.pendingToolIds !== undefined ? validatePendingToolIds(opts.pendingToolIds) : "[]"
      const now = Date.now()
      const headRow = db
        .prepare("SELECT MAX(seq) AS m FROM messages WHERE session_id = ? AND thread_id = ?")
        .get(sessionId, threadId) as { m: number | null } | null
      const head = Math.max(headRow?.m ?? -1, 0)
      const epochRow = db
        .prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?")
        .get(sessionId) as {
        epoch: number
      }
      db.prepare(
        "INSERT INTO runs (run_id, session_id, thread_id, status, started_at, ended_at, last_persisted_seq, pending_tool_ids, recovery_status, takeover_epoch, created_at) VALUES (?, ?, ?, 'CREATED', ?, NULL, ?, ?, 'NONE', ?, ?)",
      ).run(runId, sessionId, threadId, now, head, pending, epochRow.epoch, now)
      return rowToRun({
        run_id: runId,
        session_id: sessionId,
        thread_id: threadId,
        status: "CREATED",
        started_at: now,
        ended_at: null,
        last_persisted_seq: head,
        pending_tool_ids: pending,
        recovery_status: "NONE",
        takeover_epoch: epochRow.epoch,
        created_at: now,
      })
    })()
  } finally {
    db.close()
  }
}

const RUN_EDGES: Record<RunStatus, readonly RunStatus[]> = {
  CREATED: ["RUNNING", "COMPLETED", "INTERRUPTED", "FAILED"],
  RUNNING: ["COMPLETED", "INTERRUPTED", "FAILED"],
  COMPLETED: ["COMPLETED"],
  INTERRUPTED: ["INTERRUPTED"],
  FAILED: ["FAILED"],
}

function isRunningUniquenessViolation(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e)
  return msg.includes("UNIQUE constraint failed") && msg.includes("runs")
}

export function transitionRun(
  runId: string,
  to: RunStatus,
  cwd?: string,
  opts?: { expectedEpoch?: number; recoveryStatus?: string },
): RunRow {
  const db = openSessionHandle(cwd)
  try {
    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | null
      if (!row) throw new Error(`run not found: ${runId}`)
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, row.session_id, opts.expectedEpoch)
      if (RUN_TERMINAL.has(row.status)) {
        if (row.status === to) return rowToRun(row)
        if (RUN_TERMINAL.has(to)) throw new RunTerminalConflictError(runId, row.status, to)
        throw new RunStatusError(runId, row.status, to)
      }
      if (!RUN_EDGES[row.status].includes(to)) throw new RunStatusError(runId, row.status, to)
      const now = Date.now()
      const terminal = RUN_TERMINAL.has(to)
      const recovery = to === "INTERRUPTED" ? (opts?.recoveryStatus ?? "NONE") : "NONE"
      try {
        db.prepare(
          "UPDATE runs SET status = ?, ended_at = ?, recovery_status = ? WHERE run_id = ?",
        ).run(to, terminal ? now : null, recovery, runId)
      } catch (e) {
        if (isRunningUniquenessViolation(e)) throw new RunRunningExistsError(row.session_id)
        throw e
      }
      return rowToRun({
        ...row,
        status: to,
        ended_at: terminal ? now : row.ended_at,
        recovery_status: recovery,
      })
    })()
  } finally {
    db.close()
  }
}

export function completeRun(
  runId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): RunRow {
  return transitionRun(runId, "COMPLETED", cwd, opts)
}

export function failRun(runId: string, cwd?: string, opts?: { expectedEpoch?: number }): RunRow {
  return transitionRun(runId, "FAILED", cwd, opts)
}

export function interruptRun(
  runId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number; recoveryStatus?: string },
): RunRow {
  return transitionRun(runId, "INTERRUPTED", cwd, opts)
}

export function advanceRunCursorInTxn(
  db: Database,
  runId: string,
  seq: number,
  expectSessionId: string | undefined,
  opts?: { expectedEventId?: string },
): RunRow {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
    .get(runId) as RunRow | null
  if (!row) throw new Error(`run not found: ${runId}`)
  if (expectSessionId !== undefined && row.session_id !== expectSessionId)
    throw new Error(`run ${runId} does not belong to session ${expectSessionId}`)
  if (RUN_TERMINAL.has(row.status))
    throw new RunStatusError(runId, row.status, `${row.status}+cursor`)
  if (!Number.isInteger(seq) || seq < 0)
    throw new RunCursorError("RUN_CURSOR_BEYOND_HEAD", runId, `invalid seq ${seq}`)
  const target = db
    .prepare(
      "SELECT seq, run_id, event_id FROM messages WHERE session_id = ? AND thread_id = ? AND seq = ?",
    )
    .get(row.session_id, row.thread_id, seq) as {
    seq: number
    run_id: string | null
    event_id: string | null
  } | null
  if (!target)
    throw new RunCursorError("RUN_CURSOR_BEYOND_HEAD", runId, `no durable event at seq ${seq}`)
  if (target.run_id !== null && target.run_id !== runId) {
    throw new RunCursorError(
      "RUN_CURSOR_FOREIGN",
      runId,
      `seq ${seq} belongs to run ${target.run_id}`,
    )
  }
  if (opts?.expectedEventId !== undefined && target.event_id !== opts.expectedEventId) {
    throw new RunCursorError("RUN_CURSOR_FOREIGN", runId, `seq ${seq} event mismatch`)
  }
  if (seq < row.last_persisted_seq) {
    throw new RunCursorError(
      "RUN_CURSOR_BACKWARD",
      runId,
      `${row.last_persisted_seq} → ${seq} refused (no rewind in P2.6)`,
    )
  }
  if (seq === row.last_persisted_seq) return rowToRun(row)
  const upd = db
    .prepare("UPDATE runs SET last_persisted_seq = ? WHERE run_id = ? AND last_persisted_seq = ?")
    .run(seq, runId, row.last_persisted_seq)
  if (upd.changes === 0) {
    const cur = db.prepare("SELECT last_persisted_seq FROM runs WHERE run_id = ?").get(runId) as {
      last_persisted_seq: number
    }
    throw new RunCursorError(
      "RUN_CURSOR_BACKWARD",
      runId,
      `concurrent advance observed (now ${cur.last_persisted_seq})`,
    )
  }
  return rowToRun({ ...row, last_persisted_seq: seq })
}

export function advanceRunCursor(
  runId: string,
  seq: number,
  cwd?: string,
  opts?: { expectedEpoch?: number; expectedEventId?: string },
): RunRow {
  const db = openSessionHandle(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined) {
        const owner = db.prepare("SELECT session_id FROM runs WHERE run_id = ?").get(runId) as {
          session_id: string
        } | null
        if (!owner) throw new Error(`run not found: ${runId}`)
        assertWriterEpochInTxn(db, owner.session_id, opts.expectedEpoch)
      }
      return advanceRunCursorInTxn(db, runId, seq, undefined, opts)
    })()
  } finally {
    db.close()
  }
}

export function setRunPendingTools(
  runId: string,
  pendingToolIds: unknown,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): RunRow {
  const db = openSessionHandle(cwd)
  try {
    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | null
      if (!row) throw new Error(`run not found: ${runId}`)
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, row.session_id, opts.expectedEpoch)
      const pending = validatePendingToolIds(pendingToolIds)
      db.prepare("UPDATE runs SET pending_tool_ids = ? WHERE run_id = ?").run(pending, runId)
      return rowToRun({ ...row, pending_tool_ids: pending })
    })()
  } finally {
    db.close()
  }
}

export function tombstoneDeadRuns(
  sessionId: string,
  cwd?: string,
  opts?: { expectedEpoch?: number },
): number {
  const db = openSessionHandle(cwd)
  try {
    return db.transaction(() => {
      if (opts?.expectedEpoch !== undefined)
        assertWriterEpochInTxn(db, sessionId, opts.expectedEpoch)
      const res = db
        .prepare(
          "UPDATE runs SET status = 'INTERRUPTED', recovery_status = 'UNKNOWN' WHERE session_id = ? AND status = 'RUNNING'",
        )
        .run(sessionId)
      return res.changes
    })()
  } finally {
    db.close()
  }
}
