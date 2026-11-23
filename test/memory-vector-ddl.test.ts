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
  setVectorDdlFaultForTest,
} from "../src/memory/vector.ts"

const dirs: string[] = []

afterEach(() => {
  __resetVectorDdlCounterForTest()
  // Jangan bocorkan fault ke test lain / produksi dalam satu proses.
  setVectorDdlFaultForTest(null)
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

test("ALTER ke-3 gagal → user_version tetap 0; retry sukses tanpa fault", async () => {
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
  // Fault di ALTER ke-3 = kolom `parent` (1:model, 2:dim, 3:parent).
  setVectorDdlFaultForTest(3)
  await expect(memoryRowExists("old-1", cwd)).rejects.toThrow()

  const failed = new Database(p, { readonly: true })
  try {
    const v = failed.prepare("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(0)
    const names = new Set(
      (failed.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map((c) => c.name),
    )
    // Dua ALTER pertama lolos, ke-3 dan seterusnya tidak jalan.
    expect(names.has("model")).toBe(true)
    expect(names.has("dim")).toBe(true)
    expect(names.has("parent")).toBe(false)
    expect(names.has("superseded_by")).toBe(false)
  } finally {
    failed.close()
  }

  // Fault dilepas → open berikutnya mengulang DDL dari awal (user_version masih 0).
  setVectorDdlFaultForTest(null)
  await memoryRowExists("old-1", cwd)
  expect(__vectorDdlRunsForTest()).toBe(1)

  const done = new Database(p, { readonly: true })
  try {
    const v = done.prepare("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(1)
    const names = new Set(
      (done.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map((c) => c.name),
    )
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
    const fts = done.prepare("SELECT count(*) as c FROM memory_fts").get() as { c: number }
    expect(fts.c).toBe(1)
  } finally {
    done.close()
  }
})
