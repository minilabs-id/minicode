// E-23: DDL/migrasi vector.db dijalankan sekali per berkas memakai
// PRAGMA user_version (bukan Set per-proses), dan DB lama tetap termigrasi.

import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  __resetVectorDdlCounterForTest,
  __vectorDdlRunsForTest,
  memoryRowExists,
} from "../src/memory/vector.ts"

const dirs: string[] = []

afterEach(() => {
  __resetVectorDdlCounterForTest()
  for (const d of dirs.splice(0)) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        // Windows AV/WAL menahan file sepersekian detik setelah db.close().
        Bun.sleepSync(25)
      }
    }
  }
})

function localVectorPath(cwd: string): string {
  return resolve(cwd, ".minicode", "vector.db")
}

function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-vector-ddl-"))
  mkdirSync(join(d, ".minicode"), { recursive: true })
  dirs.push(d)
  return d
}

test("10× open vector → DDL sekali + user_version = 1", async () => {
  const cwd = tmpCwd()
  __resetVectorDdlCounterForTest()
  for (let i = 0; i < 10; i++) await memoryRowExists("tidak-ada", cwd)

  expect(__vectorDdlRunsForTest()).toBe(1)
  const db = new Database(localVectorPath(cwd), { readonly: true })
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number }
    expect(row.user_version).toBe(1)
  } finally {
    db.close()
  }
})

test("DB lama (tanpa kolom baru, user_version 0) termigrasi sekali", async () => {
  const cwd = tmpCwd()
  const p = localVectorPath(cwd)
  const legacy = new Database(p)
  try {
    legacy.exec(
      "CREATE TABLE memory(id TEXT PRIMARY KEY, text TEXT, embedding BLOB, created_at INTEGER)",
    )
    legacy
      .prepare("INSERT INTO memory (id, text, embedding, created_at) VALUES (?, ?, ?, ?)")
      .run("old-1", "fakta lama untuk rebuild fts", null, Date.now())
  } finally {
    legacy.close()
  }

  __resetVectorDdlCounterForTest()
  await memoryRowExists("old-1", cwd)
  await memoryRowExists("old-1", cwd)
  expect(__vectorDdlRunsForTest()).toBe(1)

  const db = new Database(p, { readonly: true })
  try {
    const cols = db.prepare("PRAGMA table_info(memory)").all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    for (const name of [
      "model",
      "dim",
      "parent",
      "category",
      "tags",
      "access_count",
      "session_id",
      "turn_id",
      "source_kind",
      "source_ref",
      "validation_status",
      "supersedes",
      "superseded_by",
    ]) {
      expect(names.has(name)).toBe(true)
    }
    const fts = db.prepare("SELECT count(*) as c FROM memory_fts").get() as { c: number }
    expect(fts.c).toBe(1)
  } finally {
    db.close()
  }
})
