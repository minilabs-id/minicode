// Regresi audit F-1 (session): dulu guard migrasi hanya mengecek 3 penanda
// (`invocation_id`, `work_mode`, `turn_ledger`), sehingga ALTER ADD COLUMN yang
// gagal (ditelan `catch {}`) membuat partial migration permanen — beda dengan
// vector DB yang masih punya `user_version=0` sebagai fallback. Test ini mengunci:
// (1) DB lengkap tidak di-migrasi ulang, (2) ALTER gagal tidak menandai migrated
// dan error dilempar, (3) setelah fault dihapus, open berikutnya melengkapi kolom
// dan guard kembali benar.
import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dbPath, openSessionDb, setSessionDdlFaultForTest } from "../src/session/db/schema.ts"

const dirs: string[] = []

// WAL/shm handle kadang masih terkunci sesaat setelah close di Windows —
// retry dulu sebelum rm (pola yang sama dipakai test session lain).
async function rmDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-session-mig-"))
  // WAJIB: tanpa `.minicode`, resolveDbPath() jatuh ke ~/.minicode global —
  // test lalu menyentuh sessions.db milik user sungguhan.
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  // Seam uji harus kembali ke default(null) agar tidak bocor ke test lain.
  setSessionDdlFaultForTest(null)
  for (const dir of dirs.splice(0)) await rmDir(dir)
})

// Sama dengan daftar di schema.ts. Sengaja ditulis ulang di test supaya test
// gagal bila schema.ts kehilangan salah satu kolom dari daftar wajibnya.
const REQUIRED: Record<string, string[]> = {
  sessions: [
    "work_mode",
    "updated_at",
    "parent_session_id",
    "parent_run_id",
    "writer_epoch",
    "default_thread_id",
  ],
  messages: [
    "toolCallId",
    "name",
    "reasoning",
    "is_error",
    "thread_id",
    "event_id",
    "run_id",
    "migrated",
    "migrated_compacted",
    "projection_note",
  ],
  daemon_approvals: ["args_hash", "invocation_id"],
  runs: ["takeover_epoch"],
  history_projections: ["anchor_event_id"],
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

function assertSchemaComplete(path: string): void {
  const db = new Database(path)
  try {
    for (const [table, cols] of Object.entries(REQUIRED)) {
      const have = columnNames(db, table)
      expect(have.length, `tabel ${table} harus ada`).toBeGreaterThan(0)
      for (const c of cols) expect(have, `${table}.${c} harus ada`).toContain(c)
    }
    // 3 penanda lama tidak boleh hilang.
    expect(columnNames(db, "daemon_approvals")).toContain("invocation_id")
    expect(columnNames(db, "sessions")).toContain("work_mode")
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_ledger'")
        .get(),
    ).toBeTruthy()
  } finally {
    db.close()
  }
}

test("DB skema lengkap: guard benar, tidak ada DDL ulang", () => {
  const dir = workspace()
  const path = dbPath(dir)

  // Open pertama membangun skema lengkap + menandai path sebagai migrated.
  const db = openSessionDb(dir)
  db.close()
  assertSchemaComplete(path)

  // Bila path benar-benar terisi & guard bernilai true, DDL tidak boleh jalan
  // lagi. Suntik fault di ALTER #1: kalau DDL masih berjalan, execAlter akan
  // melempar dan test ini gagal.
  setSessionDdlFaultForTest(1)
  expect(() => {
    const again = openSessionDb(dir)
    again.close()
  }).not.toThrow()
})

test("DB legacy + ALTER gagal: ditandai GAGAL, lalu pulih saat fault dihapus", () => {
  const dir = workspace()
  const path = dbPath(dir)

  // Bentuk legacy: hanya 3 tabel awal, tanpa kolom-kolom hasil ALTER.
  const old = new Database(path)
  old.exec("PRAGMA journal_mode=WAL")
  old.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
    CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
    CREATE TABLE turns (session_id TEXT, turn_idx INTEGER, usage TEXT, ts INTEGER, PRIMARY KEY(session_id, turn_idx));
    INSERT INTO sessions (id, created_at, cwd, system) VALUES ('lama', 1000, '/x', 'sys');
  `)
  old.close()

  // Fault di ALTER pertama (sessions.updated_at). Penanda lama TETAP terbentuk
  // pada open ini (work_mode, turn_ledger, invocation_id) — persis skenario bug
  // lama, tapi kini guard tidak lagi terkecoh dan error dilempar ke caller.
  setSessionDdlFaultForTest(1)
  expect(() => openSessionDb(dir)).toThrow(/migrasi tidak lengkap/i)

  // Kolom yang gagal tetap absen; baris lama tidak rusak.
  const during = new Database(path)
  try {
    expect(columnNames(during, "sessions")).not.toContain("updated_at")
    expect(during.prepare("SELECT cwd FROM sessions WHERE id = 'lama'").get()).toEqual({
      cwd: "/x",
    })
  } finally {
    during.close()
  }

  // Hapus fault → open kedua mengulang DDL & melengkapi semua kolom.
  setSessionDdlFaultForTest(null)
  const db2 = openSessionDb(dir)
  db2.close()
  assertSchemaComplete(path)

  // Guard kini benar: suntik fault lagi, DDL tak boleh berjalan.
  setSessionDdlFaultForTest(1)
  expect(() => {
    const again = openSessionDb(dir)
    again.close()
  }).not.toThrow()
})
