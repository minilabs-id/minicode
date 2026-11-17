import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { LIMITS } from "../../constants.ts"
import { resolveLocalDbPath, withSqliteBusyRetrySync } from "../../lib/db-path.ts"
import { scrubSecrets } from "../../policy/scrub.ts"
import {
  isTaskStatus,
  type Task,
  type TaskAcceptance,
  TaskError,
  type TaskEvidence,
  type TaskProvenance,
  type TaskStatus,
  type TaskVerification,
} from "../model.ts"
import { TASK_DATA_VERSION, TASK_DB_FILENAME, type TaskRow } from "./types.ts"

export const SCHEMA_ATTEMPTS = 8
export const SCHEMA_BACKOFF_MS = 25

export function withBusyRetrySync<T>(fn: () => T, attempts = SCHEMA_ATTEMPTS): T | null {
  return withSqliteBusyRetrySync(fn, { attempts, backoffMs: SCHEMA_BACKOFF_MS })
}

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  task_order INTEGER NOT NULL,
  parent_id TEXT,
  depends_on_json TEXT,
  blocked_reason TEXT,
  verification_json TEXT,
  evidence_json TEXT,
  acceptance_json TEXT,
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  exec_generation INTEGER NOT NULL DEFAULT 0,
  attempt_generation INTEGER,
  execution_owner TEXT,
  PRIMARY KEY (session_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_session_order ON tasks(session_id, task_order);
CREATE TABLE IF NOT EXISTS task_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_authority (
  session_id       TEXT    NOT NULL,
  incarnation      INTEGER NOT NULL,
  owner_token      TEXT    NOT NULL,
  owner_pid        INTEGER NOT NULL,
  acquired_at      INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, incarnation)
);

CREATE TABLE IF NOT EXISTS task_transfers (
  transfer_id        TEXT    PRIMARY KEY,
  task_id            TEXT    NOT NULL,
  from_session_id    TEXT    NOT NULL,
  from_incarnation   INTEGER NOT NULL,
  to_session_id      TEXT    NOT NULL,
  to_incarnation     INTEGER NOT NULL,
  expected_revision  INTEGER NOT NULL,
  new_revision       INTEGER NOT NULL,
  status             TEXT    NOT NULL,
  exec_generation    INTEGER NOT NULL,
  attempt_generation INTEGER,
  execution_owner    TEXT,
  transferred_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_transfers_from ON task_transfers(from_session_id, task_id);
CREATE INDEX IF NOT EXISTS idx_task_transfers_to ON task_transfers(to_session_id, task_id);
CREATE TABLE IF NOT EXISTS task_merges (
  merge_id          TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL,
  survivor_id       TEXT    NOT NULL,
  duplicate_id      TEXT    NOT NULL,
  evidence          TEXT    NOT NULL,
  survivor_status   TEXT    NOT NULL,
  duplicate_status  TEXT    NOT NULL,
  duplicate_revision INTEGER NOT NULL,
  merged_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_merges_session ON task_merges(session_id, duplicate_id);
`

const DDL_STATEMENTS: readonly string[] = DDL.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

export const handles = new Map<string, Database>()
const initialized = new Set<string>()
export const txDepth = new Map<string, number>()

export function openTxPaths(): string[] {
  return [...txDepth.entries()].filter(([, d]) => d > 0).map(([p]) => p)
}

export function assertNoOpenTx(p: string, what: string): void {
  if ((txDepth.get(p) ?? 0) > 0) {
    throw new TaskError(
      "TASK_TX_ACTIVE",
      `cannot ${what} while a TaskStore transaction is open for this database`,
    )
  }
}

export function dbFile(cwd?: string): string {
  return resolveLocalDbPath(TASK_DB_FILENAME, cwd)
}

/**
 * [PHASE 6K] Migrasi idempoten & non-destruktif kolom `exec_generation` dan `attempt_generation`
 * memakai introspeksi `PRAGMA table_info(tasks)`.
 */
function migrateExecutionLineageSchema(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  )
  if (present.size === 0) return

  const needsExec = !present.has("exec_generation")
  const needsAttempt = !present.has("attempt_generation")
  if (!needsExec && !needsAttempt) return

  const run = db.transaction(() => {
    if (needsExec) {
      db.exec("ALTER TABLE tasks ADD COLUMN exec_generation INTEGER NOT NULL DEFAULT 0")
    }
    if (needsAttempt) {
      db.exec("ALTER TABLE tasks ADD COLUMN attempt_generation INTEGER")
    }
  })
  try {
    withBusyRetrySync(() => {
      run()
      return true
    })
  } catch (e) {
    throw new TaskError(
      "TASK_MIGRATION_FAILURE",
      `lineage migration failed: ${(e as Error).message}`,
    )
  }
  try {
    const cur = db.prepare("SELECT value FROM task_meta WHERE key = ?").get("data_version") as
      | { value: string }
      | null
      | undefined
    const n = cur ? Number(cur.value) : 0
    if (!Number.isFinite(n) || n < TASK_DATA_VERSION) {
      db.prepare(
        "INSERT INTO task_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("data_version", String(TASK_DATA_VERSION))
    }
  } catch {}
}

/**
 * [PHASE 6P] Tambahkan kolom `execution_owner` secara aditif tanpa backfill spekulatif.
 */
function migrateExecutionOwnershipSchema(db: Database): void {
  const present = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
  )
  if (present.size === 0 || present.has("execution_owner")) return
  try {
    withBusyRetrySync(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN execution_owner TEXT")
      return true
    })
  } catch (e) {
    throw new TaskError(
      "TASK_MIGRATION_FAILURE",
      `execution-ownership migration failed: ${(e as Error).message}`,
    )
  }
}

export function handle(cwd?: string): Database {
  const p = dbFile(cwd)
  const existing = handles.get(p)
  if (existing) return existing
  const opened = withBusyRetrySync(() => {
    const d = new Database(p)
    try {
      d.exec(`PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`)
    } catch {}
    return d
  })
  if (!opened) {
    throw new TaskError(
      "TASK_DB_INIT_FAILURE",
      `cannot open ${p} after ${SCHEMA_ATTEMPTS} busy-retry attempts`,
    )
  }
  const db = opened
  try {
    if (!initialized.has(p)) {
      const walOk = withBusyRetrySync(() => {
        db.exec(
          `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${LIMITS.SQLITE_WAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=${LIMITS.SQLITE_WAL_AUTOCHECKPOINT_PAGES};`,
        )
        return true
      })
      if (walOk === null) {
        process.stderr.write(`[warn] taskstore: wal setup deferred, retry next open: ${p}\n`)
      }
      try {
        const { chmodSync } = require("node:fs") as typeof import("node:fs")
        chmodSync(p, 0o600)
      } catch {}
    }
    for (const stmt of DDL_STATEMENTS) {
      const ok = withBusyRetrySync(() => {
        db.exec(stmt)
        return true
      })
      if (ok === null) throw new Error(`schema init did not complete: ${stmt.slice(0, 40)}`)
    }
    migrateExecutionLineageSchema(db)
    migrateExecutionOwnershipSchema(db)
    initialized.add(p)
  } catch (e) {
    try {
      db.close()
    } catch {}
    handles.delete(p)
    throw new TaskError("TASK_DB_INIT_FAILURE", `schema init failed: ${(e as Error).message}`)
  }
  handles.set(p, db)
  return db
}

export function closeTaskStoreHandle(cwd?: string): void {
  const p = dbFile(cwd)
  assertNoOpenTx(p, "close the store")
  const db = handles.get(p)
  if (db) {
    try {
      db.close()
    } catch {}
    handles.delete(p)
    initialized.delete(p)
  }
}

export function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as T
    return v ?? fallback
  } catch {
    return fallback
  }
}

export function parseStringArrayStrict(raw: string | null): string[] | null {
  if (raw === null || raw.trim() === "") return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    if (v.some((x) => typeof x !== "string")) return null
    return v as string[]
  } catch {
    return null
  }
}

export function rowToTask(r: TaskRow): Task {
  return {
    id: r.task_id,
    sessionId: r.session_id,
    title: r.title,
    status: (isTaskStatus(r.status) ? r.status : "PENDING") as TaskStatus,
    order: r.task_order,
    parentId: r.parent_id,
    dependsOn: parseJson<string[]>(r.depends_on_json, []),
    blockedReason: r.blocked_reason,
    verification: parseJson<TaskVerification | null>(r.verification_json, null),
    evidence: parseJson<TaskEvidence[]>(r.evidence_json, []),
    acceptance: parseJson<TaskAcceptance | null>(r.acceptance_json, null),
    provenance: parseJson<TaskProvenance>(r.provenance_json, {
      origin: "runtime",
      source: "unknown",
    }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
  }
}

export function j(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

/** Discard the handle cache. For hermetic tests only. */
export function resetTaskStoreHandles(): void {
  const open = openTxPaths()
  if (open.length > 0) {
    throw new TaskError(
      "TASK_TX_ACTIVE",
      `cannot reset task store handles while ${open.length} transaction(s) are open`,
    )
  }
  for (const db of handles.values()) {
    try {
      db.close()
    } catch {}
  }
  handles.clear()
  initialized.clear()
}

/** Legacy-source fingerprint, used by migration so a re-import of identical content changes nothing. */
export function legacyDigest(raw: string): string {
  return createHash("sha256").update(scrubSecrets(raw)).digest("hex").slice(0, 32)
}
