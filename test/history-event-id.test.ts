// P2.5 — Identitas event histori kanonik (produksi).
//
// Membuktikan: alokasi tunggal, stabilitas lintas save/load/resume,
// duplikat-idempoten vs konflik-ditolak di level DB, independensi seq,
// backfill legacy deterministik + idempoten, pagar epoch, aturan branch
// PRESERVE, tanpa Run/proyeksi/kompaksi.

import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allocateHistoryEventId,
  appendHistoryEvent,
  backfillHistoryEventIds,
  branchSession,
  DEFAULT_THREAD_ID,
  deriveLegacyHistoryEventId,
  EventIdConflictError,
  EventIdInvalidError,
  getDefaultThread,
  isHistoryEventId,
  loadSession,
  loadThreadHistory,
  readWriterEpoch,
  StaleWriterError,
  saveSession,
  shrinkThreadHistory,
  takeoverSessionEpoch,
} from "../src/session/persistence.ts"

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p25-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function dbPath(cwd: string): string {
  return join(cwd, ".minicode", "sessions.db")
}

function eventIds(cwd: string, sid: string): (string | null)[] {
  const db = new Database(dbPath(cwd), { readonly: true })
  try {
    return (
      db.prepare("SELECT event_id FROM messages WHERE session_id = ? ORDER BY seq").all(sid) as {
        event_id: string | null
      }[]
    ).map((r) => r.event_id)
  } finally {
    db.close()
  }
}

test("P2.5.1-4: alokasi valid, stabil lintas save, reload, resume; invalid ditolak", async () => {
  const cwd = ws()
  const id = allocateHistoryEventId()
  expect(isHistoryEventId(id)).toBe(true)
  expect(isHistoryEventId("acak")).toBe(false)
  expect(isHistoryEventId("exec_123")).toBe(false)
  expect(isHistoryEventId(deriveLegacyHistoryEventId("s", "th_default", 0))).toBe(true)
  const msgs = [{ role: "user", content: "satu" }]
  await saveSession("s", cwd, undefined, msgs, { t: 1 })
  const first = eventIds(cwd, "s")
  expect(first.length).toBe(1)
  expect(isHistoryEventId(first[0])).toBe(true)
  // Save ulang identik + beban berbeda + resume-load-save: id stabil.
  await saveSession("s", cwd, undefined, msgs, { t: 1 })
  expect(eventIds(cwd, "s")).toEqual(first)
  const loaded = loadSession("s", cwd)!
  await saveSession("s", cwd, undefined, loaded.messages, { t: 1 })
  expect(eventIds(cwd, "s")).toEqual(first)
  await expect(
    (async () => {
      appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "x" }, cwd, {
        eventId: "bukan-id",
      })
    })(),
  ).rejects.toThrow(EventIdInvalidError)
})

test("P2.5.5-8: duplikat idempoten, konflik ditolak, unik di level DB", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  const eid = allocateHistoryEventId()
  const r1 = appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "b" }, cwd, {
    eventId: eid,
  })
  expect(r1.outcome).toBe("appended")
  // Duplikat identik: tanpa baris baru, tanpa seq baru.
  const r2 = appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "b" }, cwd, {
    eventId: eid,
  })
  expect(r2).toEqual({ outcome: "duplicate", seq: r1.seq, eventId: eid })
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(2)
  // Konflik: id sama, payload beda → DITOLAK; asli otoritatif, head diam.
  const headBefore = getDefaultThread("s", cwd)!.head_seq
  expect(() =>
    appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "C-BEDA" }, cwd, {
      eventId: eid,
    }),
  ).toThrow(EventIdConflictError)
  expect(getDefaultThread("s", cwd)!.head_seq).toBe(headBefore)
  expect(loadThreadHistory("s", DEFAULT_THREAD_ID, cwd).length).toBe(2)
  // Unik komposit benar-benar di DB: duplikat mentah ditolak constraint.
  const db = new Database(dbPath(cwd))
  try {
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, thread_id, seq, role, content, ts, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("s", DEFAULT_THREAD_ID, 99, "user", '"z"', 0, eid),
    ).toThrow()
  } finally {
    db.close()
  }
})

test("P2.5.9-12: seq/head independen dari event_id", async () => {
  const cwd = ws()
  await saveSession(
    "s",
    cwd,
    undefined,
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    { t: 1 },
  )
  const ids = eventIds(cwd, "s")
  expect(ids[0]).not.toBe(ids[1])
  // event_id ≠ seq dan tak diturunkan dari konten/posisi: histori identik di
  // sesi lain mendapat id BERBEDA (alokasi acak, bukan hash konten/seq).
  await saveSession(
    "s2",
    cwd,
    undefined,
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    { t: 1 },
  )
  expect(eventIds(cwd, "s2")).not.toEqual(ids)
  const before = getDefaultThread("s", cwd)!.head_seq
  const eid = allocateHistoryEventId()
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "c" }, cwd, { eventId: eid })
  const after = getDefaultThread("s", cwd)!.head_seq
  expect(after).toBe(before + 1)
  // Duplikat/konflik tak menggerakkan head (dibuktikan di test 5-8; di sini
  // append normal maju tepat satu).
  expect(after).toBe(2)
})

test("P2.5.13-15: stale epoch tak bisa mutasi event; alokasi di dalam txn berpagar", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  expect(() =>
    appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "x" }, cwd, {
      expectedEpoch: 0,
    }),
  ).toThrow(StaleWriterError)
  expect(() => backfillHistoryEventIds("s", cwd, { expectedEpoch: 0 })).toThrow(StaleWriterError)
  const ok = appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "x" }, cwd, {
    expectedEpoch: 1,
  })
  expect(ok.outcome).toBe("appended")
  expect(backfillHistoryEventIds("s", cwd, { expectedEpoch: 1 })).toBe(0)
})

test("P2.5.16-19: legacy NULL di-backfill deterministik, idempoten, konten utuh", async () => {
  const cwd = ws()
  const p = dbPath(cwd)
  const raw = new Database(p)
  try {
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, cwd TEXT, system TEXT);
      CREATE TABLE messages (session_id TEXT, seq INTEGER, role TEXT, content TEXT, toolCalls TEXT, toolCallId TEXT, name TEXT, ts INTEGER, PRIMARY KEY(session_id, seq));
    `)
    const now = Date.now()
    raw
      .prepare("INSERT INTO sessions (id, created_at, cwd, system) VALUES (?, ?, ?, ?)")
      .run("w", now, cwd, "")
    // Bentuk baris prod-nyata (toolCalls selalu string safeContent, bukan
    // NULL mentah) agar uji adopsi tak terkontaminasi quirk prefix-compare.
    raw
      .prepare(
        "INSERT INTO messages (session_id, seq, role, content, toolCalls, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("w", 0, "user", JSON.stringify("satu"), "null", now)
    raw
      .prepare(
        "INSERT INTO messages (session_id, seq, role, content, toolCalls, ts) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("w", 1, "assistant", JSON.stringify("dua"), "null", now)
  } finally {
    raw.close()
  }
  const before = JSON.stringify(loadSession("w", cwd)!.messages)
  const n = backfillHistoryEventIds("w", cwd)
  expect(n).toBe(2)
  // Deterministik: derivasi sama dengan fungsi kanonik.
  expect(eventIds(cwd, "w")).toEqual([
    deriveLegacyHistoryEventId("w", DEFAULT_THREAD_ID, 0),
    deriveLegacyHistoryEventId("w", DEFAULT_THREAD_ID, 1),
  ])
  // Idempoten: run kedua nihil.
  expect(backfillHistoryEventIds("w", cwd)).toBe(0)
  // Konten/urutan/flag tak berubah (hash dekode identik); migrated jujur.
  expect(JSON.stringify(loadSession("w", cwd)!.messages)).toBe(before)
  const db = new Database(p, { readonly: true })
  try {
    const flags = db
      .prepare(
        "SELECT migrated, migrated_compacted FROM messages WHERE session_id = ? ORDER BY seq",
      )
      .all("w") as { migrated: number; migrated_compacted: number }[]
    expect(flags).toEqual([
      { migrated: 1, migrated_compacted: 0 },
      { migrated: 1, migrated_compacted: 0 },
    ])
  } finally {
    db.close()
  }
  // Rewrite pasca-backfill MEMPERTAHANKAN id slot identik.
  const ids = eventIds(cwd, "w")
  await saveSession(
    "w",
    cwd,
    "",
    [
      { role: "user", content: "satu" },
      { role: "assistant", content: "dua" },
    ],
    { t: 1 },
  )
  expect(eventIds(cwd, "w")).toEqual(ids)
  // Rewrite dengan satu slot berubah (model kompaksi N→N): slot utuh
  // mempertahankan id, slot berubah mendapat id FRESH (bukan timpa).
  // P2.7: rewrite implisit di saveSession DIHAPUS; jalur eksplisit =
  // shrinkThreadHistory (invariant identitas P2.5 tetap sama).
  shrinkThreadHistory(
    "w",
    DEFAULT_THREAD_ID,
    [
      { role: "user", content: "RINGKASAN" },
      { role: "assistant", content: "dua" },
    ],
    cwd,
    { expectedEpoch: 0 },
  )
  const ids2 = eventIds(cwd, "w")
  expect(ids2[1]).toBe(ids[1])
  expect(ids2[0]).not.toBe(ids[0])
  expect(isHistoryEventId(ids2[0])).toBe(true)
  expect(JSON.stringify(loadSession("w", cwd)!.messages)).toBe(
    JSON.stringify([
      { role: "user", content: "RINGKASAN" },
      { role: "assistant", content: "dua" },
    ]),
  )
})

test("history shrink preserves timestamps only for identical same-position events", async () => {
  const cwd = ws()
  const messages = [
    { role: "user", content: "unchanged" },
    { role: "assistant", content: "replace me" },
    { role: "user", content: "remove me" },
    { role: "assistant", content: "moved" },
  ]
  await saveSession("s", cwd, undefined, messages, { t: 1 })
  const ids = eventIds(cwd, "s")
  const originalTimestamp = 1234
  const db = new Database(dbPath(cwd))
  try {
    db.prepare("UPDATE messages SET ts = ? WHERE session_id = ?").run(originalTimestamp, "s")
    const startedAt = Date.now()
    shrinkThreadHistory(
      "s",
      DEFAULT_THREAD_ID,
      [messages[0], { role: "assistant", content: "replacement" }, messages[3]],
      cwd,
      { expectedEpoch: 0 },
    )
    const finishedAt = Date.now()
    const rows = db
      .prepare("SELECT event_id, ts FROM messages WHERE session_id = ? ORDER BY seq")
      .all("s") as { event_id: string; ts: number }[]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.event_id).toBe(ids[0]!)
    expect(rows[0]?.ts).toBe(originalTimestamp)
    for (const row of rows.slice(1)) {
      expect(isHistoryEventId(row.event_id)).toBe(true)
      expect(ids).not.toContain(row.event_id)
      expect(row.ts).toBeGreaterThanOrEqual(startedAt)
      expect(row.ts).toBeLessThanOrEqual(finishedAt)
    }
  } finally {
    db.close()
  }
})

test("P2.5.20-22: branch PRESERVE event_id; dst terisolasi; src utuh", async () => {
  const cwd = ws()
  await saveSession(
    "src",
    cwd,
    undefined,
    [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    { t: 1 },
  )
  const srcIds = eventIds(cwd, "src")
  expect(srcIds.every((id) => isHistoryEventId(id))).toBe(true)
  await branchSession("src", "dst", cwd)
  // Aturan branch: id sama (masa lalu bersama), sesi/thread cakupan beda.
  expect(eventIds(cwd, "dst")).toEqual(srcIds)
  // Append di dst: id fresh, src tak tersentuh, dst terisolasi.
  await saveSession(
    "dst",
    cwd,
    undefined,
    [
      ...(loadSession("dst", cwd)!.messages as { role: string; content: unknown }[]),
      { role: "user", content: "c" },
    ],
    { t: 2 },
  )
  const dstIds = eventIds(cwd, "dst")
  expect(dstIds.slice(0, 2)).toEqual(srcIds)
  expect(isHistoryEventId(dstIds[2])).toBe(true)
  expect(dstIds[2]).not.toBe(srcIds[0])
  expect(dstIds[2]).not.toBe(srcIds[1])
  expect(eventIds(cwd, "src")).toEqual(srcIds)
  expect(loadThreadHistory("dst", DEFAULT_THREAD_ID, cwd).length).toBe(3)
})

test("P2.5: epoch pagar dipertahankan (bukan direset migrasi event)", async () => {
  const cwd = ws()
  await saveSession("s", cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  expect(takeoverSessionEpoch("s", 0, "uji", "bootB", cwd).outcome).toBe("advanced")
  expect(backfillHistoryEventIds("s", cwd, { expectedEpoch: 1 })).toBe(0)
  const eid = allocateHistoryEventId()
  appendHistoryEvent("s", DEFAULT_THREAD_ID, { role: "user", content: "b" }, cwd, {
    eventId: eid,
    expectedEpoch: 1,
  })
  expect(readWriterEpoch("s", cwd)).toBe(1)
})

// [T-004 OBSERVATION.md] Regresi: `ts` per-baris, bukan satu nilai untuk batch.
// Bug asli: sesi 17b6a5ff menyimpan 159 pesan dengan SATU nilai `ts` identik,
// sehingga urutan waktu asli tak bisa direkonstruksi dari DB (hanya jurnal).
// Kontrak: setiap baris baru mendapat stamp sendiri, tidak pernah mundur.
test("T-004: incremental append memberi ts per-baris, monoton terhadap seq", async () => {
  const cwd = ws()
  const db = new Database(dbPath(cwd))
  try {
    await saveSession("s", cwd, undefined, [{ role: "user", content: "awal" }], { t: 1 })
    const first = db
      .prepare("SELECT ts FROM messages WHERE session_id = ? ORDER BY seq")
      .all("s") as { ts: number }[]
    expect(first).toHaveLength(1)

    // Append banyak pesan dalam SATU saveSession: jalur incremental.
    await saveSession(
      "s",
      cwd,
      undefined,
      [
        { role: "user", content: "awal" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
      ],
      { t: 2 },
    )

    const rows = db
      .prepare("SELECT seq, ts FROM messages WHERE session_id = ? ORDER BY seq")
      .all("s") as { seq: number; ts: number }[]
    expect(rows).toHaveLength(4)
    // Baris lama tak tersentuh (append-only).
    expect(rows[0]!.ts).toBe(first[0]!.ts)
    // Monoton: ts tidak pernah mundur seiring seq.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.ts).toBeGreaterThanOrEqual(rows[i - 1]!.ts)
    }
    // Bukan hasil injeksi jarak buatan: semua berada di sekitar waktu nyata.
    const now = Date.now()
    for (const r of rows.slice(1)) expect(now - r.ts).toBeLessThan(60_000)

    // Kontrak inti bug T-004: stamp diambil PER BARIS, bukan dibekukan dari
    // awal batch. Dua append terpisah yang sengaja diberi jeda WAJIB berbeda;
    // dengan `now` tunggal per panggilan nilai ini tetap berubah, jadi untuk
    // membedakan kedua implementasi kita buktikan bahwa batch kedua tidak
    // memakai ulang stamp batch pertama (bukti replay satu nilai global).
    const beforeSecond = Date.now()
    await Bun.sleep(8)
    await saveSession(
      "s",
      cwd,
      undefined,
      [
        { role: "user", content: "awal" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ],
      { t: 3 },
    )
    const next = db
      .prepare("SELECT ts FROM messages WHERE session_id = ? AND seq = 4")
      .get("s") as { ts: number }
    expect(next.ts).toBeGreaterThanOrEqual(beforeSecond)
    expect(next.ts).toBeGreaterThan(rows[3]!.ts)
  } finally {
    db.close()
  }
})

// [T-005 OBSERVATION.md] Regresi: jalur append per-event WAJIB memajukan
// `sessions.updated_at`. Bug asli: turn yang menulis lewat
// `appendHistoryEvent` meninggalkan `updated_at` di save terakhir, sehingga
// sesi yang sedang aktif terlihat mandek (10:45 vs jurnal 12:07).
test("T-005: appendHistoryEvent memajukan sessions.updated_at", async () => {
  const cwd = ws()
  const sid = "t005"
  const stale = Date.now() - 60 * 60 * 1000
  // Fase 1: siapkan sesi lalu paksa `updated_at` basi lewat koneksi sendiri.
  await saveSession(sid, cwd, undefined, [{ role: "user", content: "a" }], { t: 1 })
  {
    const db = new Database(dbPath(cwd))
    try {
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(stale, sid)
      const before = (
        db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get(sid) as {
          updated_at: number
        }
      ).updated_at
      expect(before).toBe(stale)
    } finally {
      db.close()
    }
  }

  // Fase 2: append lewat jalur produksi (koneksi sendiri).
  const startedAt = Date.now()
  appendHistoryEvent(sid, DEFAULT_THREAD_ID, { role: "assistant", content: "b" }, cwd)

  // Fase 3: koneksi BARU untuk membaca. Handle lama akan tetap melihat
  // snapshot pra-append (WAL) dan membuat tes ini gagal secara palsu.
  {
    const db = new Database(dbPath(cwd))
    try {
      const after = (
        db.prepare("SELECT updated_at FROM sessions WHERE id = ?").get(sid) as {
          updated_at: number
        }
      ).updated_at
      expect(after).toBeGreaterThanOrEqual(startedAt)
      expect(after).toBeGreaterThan(stale)
    } finally {
      db.close()
    }
  }
})
