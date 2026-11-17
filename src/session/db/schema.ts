import { Database } from "bun:sqlite"
import { LIMITS } from "../../constants.ts"
import { resolveDbPath, resolveLocalDbPath, withSqliteBusyRetrySync } from "../../lib/db-path.ts"

export const dbPath = (cwd?: string, local = false): string =>
  local ? resolveLocalDbPath("sessions.db", cwd) : resolveDbPath("sessions.db", cwd)

const initializedSessionPaths = new Set<string>()
const migratedSessionPaths = new Set<string>()

function daemonApprovalsMigrated(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(daemon_approvals)").all() as { name: string }[]
    if (!cols.some((c) => c.name === "invocation_id")) return false
    const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    return (
      sessCols.some((c) => c.name === "work_mode") &&
      !!db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_ledger'")
        .get()
    )
  } catch {
    return false
  }
}

const DB_INIT_ATTEMPTS = 8

export function withBusyRetrySync<T>(fn: () => T, attempts = DB_INIT_ATTEMPTS): T | null {
  return withSqliteBusyRetrySync(fn, {
    attempts,
    deterministicJitter: true,
    onGiveUp: (last, n) => {
      process.stderr.write(
        `[warn] persistence: schema setup gave up after ${n} attempts: ${String((last as Error)?.message ?? last)}\n`,
      )
    },
  })
}

function threadsTableNeedsP24Rebuild(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(threads)").all() as { name: string; pk: number }[]
    if (cols.length === 0) return false
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    return !(pk.length === 2 && pk[0] === "session_id" && pk[1] === "thread_id")
  } catch {
    return false
  }
}

function projectionsTableNeedsP24Rebuild(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(history_projections)").all() as { name: string }[]
    if (cols.length === 0) return false
    return !cols.some((c) => c.name === "session_id")
  } catch {
    return false
  }
}

function assertEmptyTableForRebuild(db: Database, table: string): void {
  let exists = false
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { ok: number } | null
    exists = row !== null
  } catch {
    return
  }
  if (!exists) return
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  if (n > 0) {
    throw new Error(
      `[persistence] refusing to rebuild non-empty table ${table} (${n} rows) — migrate, never destroy`,
    )
  }
}

export function openSessionHandle(cwd?: string, local = false): Database {
  const p = dbPath(cwd, local)
  const db = withBusyRetrySync(() => {
    const d = new Database(p)
    try {
      d.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
    } catch {}
    return d
  })
  if (!db) {
    throw new Error(
      `persistence: cannot open sessions.db after ${DB_INIT_ATTEMPTS} busy-retry attempts: ${p}`,
    )
  }
  try {
    if (!initializedSessionPaths.has(p)) {
      const walOk = withBusyRetrySync(() => {
        db.exec(
          `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
        )
        initializedSessionPaths.add(p)
        return true
      })
      if (walOk === null) {
        process.stderr.write(`[warn] persistence: wal setup deferred, retry next open: ${p}\n`)
      }
      try {
        const { chmodSync } = require("node:fs") as typeof import("node:fs")
        chmodSync(p, 0o600)
      } catch {}
    }
    const needsDdl = !migratedSessionPaths.has(p) || !daemonApprovalsMigrated(db)
    if (needsDdl) {
      withBusyRetrySync(() => {
        db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT, writer_epoch INTEGER NOT NULL DEFAULT 0, default_thread_id TEXT NULL, work_mode TEXT NULL);
    CREATE TABLE IF NOT EXISTS messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, reasoning TEXT, is_error INTEGER, ts INTEGER, thread_id TEXT NULL, event_id TEXT NULL, run_id TEXT NULL, migrated INTEGER NOT NULL DEFAULT 0, migrated_compacted INTEGER NOT NULL DEFAULT 0, projection_note TEXT NULL, PRIMARY KEY(session_id, seq));
    CREATE TABLE IF NOT EXISTS turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
    CREATE TABLE IF NOT EXISTS turn_ledger (
      session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL, before_seq INTEGER NOT NULL,
      before_event_seq INTEGER NOT NULL, before_messages TEXT NOT NULL,
      checkpoint_id TEXT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NULL,
      PRIMARY KEY(session_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS presentation_events (
      session_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      turn_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(session_id, event_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_presentation_events_session ON presentation_events(session_id, event_seq);
  `)
      })
      try {
        const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
        if (!cols.some((c) => c.name === "updated_at")) {
          db.exec("ALTER TABLE sessions ADD COLUMN updated_at INTEGER")
          db.exec("UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL")
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`)
        if (!cols.some((c) => c.name === "parent_session_id")) {
          db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT NULL")
        }
        if (!cols.some((c) => c.name === "parent_run_id")) {
          db.exec("ALTER TABLE sessions ADD COLUMN parent_run_id TEXT NULL")
        }
        if (!cols.some((c) => c.name === "work_mode")) {
          db.exec("ALTER TABLE sessions ADD COLUMN work_mode TEXT NULL")
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)`)
      } catch (e) {
        process.stderr.write(
          `[warn] persistence: sessions migration skipped: ${(e as Error).message}\n`,
        )
      }
      try {
        const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
        if (!msgCols.some((c) => c.name === "toolCallId")) {
          db.exec("ALTER TABLE messages ADD COLUMN toolCallId TEXT")
          db.exec("ALTER TABLE messages ADD COLUMN name TEXT")
        }
        if (!msgCols.some((c) => c.name === "reasoning")) {
          db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT")
        }
        if (!msgCols.some((c) => c.name === "is_error")) {
          db.exec("ALTER TABLE messages ADD COLUMN is_error INTEGER")
        }
      } catch (e) {
        process.stderr.write(
          `[warn] persistence: messages migration skipped: ${(e as Error).message}\n`,
        )
      }
      withBusyRetrySync(() => {
        db.exec(`
    CREATE TABLE IF NOT EXISTS session_aliases (alias TEXT PRIMARY KEY, fs_key TEXT NOT NULL, canonical TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_session_aliases_fs ON session_aliases(fs_key);
    CREATE INDEX IF NOT EXISTS idx_session_aliases_canonical ON session_aliases(canonical);
  `)
      })
      try {
        const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
        if (!sessCols.some((c) => c.name === "writer_epoch")) {
          db.exec("ALTER TABLE sessions ADD COLUMN writer_epoch INTEGER NOT NULL DEFAULT 0")
        }
        if (!sessCols.some((c) => c.name === "default_thread_id")) {
          db.exec("ALTER TABLE sessions ADD COLUMN default_thread_id TEXT NULL")
        }
        const msgCols2 = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
        const addMsgCol = (name: string, ddl: string): void => {
          if (!msgCols2.some((c) => c.name === name))
            db.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`)
        }
        addMsgCol("thread_id", "thread_id TEXT NULL")
        addMsgCol("event_id", "event_id TEXT NULL")
        addMsgCol("run_id", "run_id TEXT NULL")
        addMsgCol("migrated", "migrated INTEGER NOT NULL DEFAULT 0")
        addMsgCol("migrated_compacted", "migrated_compacted INTEGER NOT NULL DEFAULT 0")
        addMsgCol("projection_note", "projection_note TEXT NULL")
        try {
          const runCols = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]
          if (runCols.length > 0 && !runCols.some((c) => c.name === "takeover_epoch")) {
            db.exec("ALTER TABLE runs ADD COLUMN takeover_epoch INTEGER NULL")
          }
        } catch {}
        try {
          const projCols = db.prepare("PRAGMA table_info(history_projections)").all() as {
            name: string
          }[]
          if (projCols.length > 0 && !projCols.some((c) => c.name === "anchor_event_id")) {
            db.exec("ALTER TABLE history_projections ADD COLUMN anchor_event_id TEXT NULL")
          }
        } catch {}
        db.exec("DROP INDEX IF EXISTS idx_messages_thread")
        withBusyRetrySync(() => {
          db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS udx_messages_thread_seq ON messages(session_id, thread_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS udx_messages_event_id ON messages(session_id, thread_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
    `)
        })
      } catch (e) {
        process.stderr.write(
          `[warn] persistence: writer_epoch migration skipped: ${(e as Error).message}\n`,
        )
      }
      withBusyRetrySync(() => {
        db.exec(`
    CREATE TABLE IF NOT EXISTS session_takeovers (session_id TEXT NOT NULL, prior_epoch INTEGER NOT NULL, new_epoch INTEGER NOT NULL, reason TEXT NOT NULL, boot TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, prior_epoch));
    CREATE INDEX IF NOT EXISTS idx_session_takeovers_session ON session_takeovers(session_id);
  `)
      })
      if (threadsTableNeedsP24Rebuild(db)) {
        assertEmptyTableForRebuild(db, "threads")
        db.exec("DROP TABLE IF EXISTS threads")
      }
      if (projectionsTableNeedsP24Rebuild(db)) {
        assertEmptyTableForRebuild(db, "history_projections")
        db.exec("DROP TABLE IF EXISTS history_projections")
      }
      withBusyRetrySync(() => {
        db.exec(`
    CREATE TABLE IF NOT EXISTS threads (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_thread_id TEXT NULL, fork_event_seq INTEGER NULL, head_seq INTEGER NOT NULL DEFAULT -1, status TEXT NOT NULL DEFAULT 'active', read_only INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(session_id, thread_id), CHECK(head_seq >= -1), CHECK(fork_event_seq IS NULL OR fork_event_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
    CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'CREATED', started_at INTEGER NOT NULL, ended_at INTEGER NULL, last_persisted_seq INTEGER NOT NULL DEFAULT 0, pending_tool_ids TEXT NOT NULL DEFAULT '[]', recovery_status TEXT NULL, takeover_epoch INTEGER NULL, created_at INTEGER NOT NULL, CHECK(last_persisted_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS udx_runs_single_running ON runs(session_id) WHERE status = 'RUNNING';
    CREATE TABLE IF NOT EXISTS history_projections (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, projection_id TEXT NOT NULL, base_seq INTEGER NOT NULL DEFAULT 0, summary_text TEXT NOT NULL DEFAULT '', included_ranges TEXT NOT NULL DEFAULT '[]', built_at INTEGER NOT NULL, anchor_event_id TEXT NULL, PRIMARY KEY(session_id, thread_id, projection_id), CHECK(base_seq >= 0));
    CREATE INDEX IF NOT EXISTS idx_projections_thread ON history_projections(session_id, thread_id);
  `)
      })
      withBusyRetrySync(() => {
        db.exec(`
    CREATE TABLE IF NOT EXISTS consumer_offsets (
      consumer_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_acked_seq INTEGER NOT NULL DEFAULT -1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(consumer_id, session_id),
      CHECK(last_acked_seq >= -1)
    );
    CREATE INDEX IF NOT EXISTS idx_consumer_offsets_session ON consumer_offsets(session_id);
    CREATE TABLE IF NOT EXISTS daemon_approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NULL,
      tool TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NULL,
      decided_at INTEGER NULL,
      decision TEXT NULL,
      incarnation TEXT NOT NULL,
      args_hash TEXT NULL,
      invocation_id TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daemon_approvals_session ON daemon_approvals(session_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_daemon_approvals_state ON daemon_approvals(state);
  `)
      })
      try {
        const approvalCols = db.prepare("PRAGMA table_info(daemon_approvals)").all() as {
          name: string
        }[]
        if (!approvalCols.some((c) => c.name === "args_hash")) {
          db.exec("ALTER TABLE daemon_approvals ADD COLUMN args_hash TEXT NULL")
        }
        if (!approvalCols.some((c) => c.name === "invocation_id")) {
          db.exec("ALTER TABLE daemon_approvals ADD COLUMN invocation_id TEXT NULL")
        }
      } catch (e) {
        process.stderr.write(
          `[warn] persistence: daemon_approvals migration skipped: ${(e as Error).message}\n`,
        )
      }
      migratedSessionPaths.add(p)
    }
    return db
  } catch (err) {
    try {
      db.close()
    } catch {}
    throw err
  }
}

export function openSessionDb(cwd?: string): Database {
  return openSessionHandle(cwd)
}

export function openWorkspaceSessionDb(cwd?: string): Database {
  return openSessionHandle(cwd, true)
}

export class StaleWriterError extends Error {
  readonly code = "REFUSED_STALE_EPOCH"
  readonly sessionId: string
  readonly expectedEpoch: number
  readonly actualEpoch: number
  constructor(sessionId: string, expectedEpoch: number, actualEpoch: number) {
    super(
      `[persist] REFUSED_STALE_EPOCH sid=${sessionId} expected=${expectedEpoch} actual=${actualEpoch} — authority moved; history NOT durable`,
    )
    this.name = "StaleWriterError"
    this.sessionId = sessionId
    this.expectedEpoch = expectedEpoch
    this.actualEpoch = actualEpoch
  }
}

export function readWriterEpoch(id: string, cwd?: string): number {
  const db = openSessionHandle(cwd)
  try {
    const row = db.prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?").get(id) as {
      epoch: number | null
    } | null
    return row?.epoch ?? 0
  } finally {
    db.close()
  }
}

export function assertWriterEpochInTxn(db: Database, id: string, expectedEpoch: number): void {
  const row = db.prepare("SELECT writer_epoch AS epoch FROM sessions WHERE id = ?").get(id) as {
    epoch: number | null
  } | null
  const actual = row?.epoch ?? 0
  if (row !== null && actual !== expectedEpoch) {
    throw new StaleWriterError(id, expectedEpoch, actual)
  }
  if (row === null && expectedEpoch !== 0) {
    throw new StaleWriterError(id, expectedEpoch, actual)
  }
}

export function sessionRowExistsInTxn(db: Database, sessionId: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sessions WHERE id = ?").get(sessionId) as {
    ok: number
  } | null
  return row !== null
}
