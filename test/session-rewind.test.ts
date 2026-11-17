import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DomainEvent } from "../src/presentation/events.ts"
import { saveCheckpointManifest, undoFilesToTurn } from "../src/session/checkpoint.ts"
import {
  appendPresentationEvents,
  branchSession,
  deleteSession,
  hasExplicitFileMutationAtOrAfter,
  loadPresentationEvents,
  loadSession,
  resolveUserTurnBoundary,
  resolveUserTurnBoundaryByOrdinal,
  saveSession,
} from "../src/session/persistence.ts"
import {
  listUserTurns,
  readRewindRecord,
  restoreRewindTarget,
  rewindToTurn,
} from "../src/session/rewind.ts"

const dirs: string[] = []
let seq = 0

async function makeCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minicode-rewind-"))
  await mkdir(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

function makeId(): string {
  return `rewind-test-${process.pid}-${Date.now().toString(36)}-${seq++}`
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function event(value: Record<string, unknown>): DomainEvent {
  return value as unknown as DomainEvent
}

function userEvent(
  sessionId: string,
  eventSeq: number,
  turnId: number,
  ts: number,
  text: string,
): DomainEvent {
  return event({
    eventSeq,
    ts,
    sessionId,
    turnId,
    type: "user.message",
    text,
    promptRef: `p${turnId}`,
  })
}

const firstTurn = [
  { role: "user", content: "turn satu" },
  { role: "assistant", content: "jawaban satu" },
]
const twoTurns = [
  ...firstTurn,
  { role: "user", content: "turn dua" },
  { role: "assistant", content: "jawaban dua" },
]

test("rewind: prompt gagal yang tidak persist tetap jadi batas percakapan", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    userEvent(id, 1, 1, base + 10, "turn dua"),
    userEvent(id, 2, 2, base + 20, "prompt salah yang gagal"),
  ])

  const turns = listUserTurns(id, cwd)
  expect(turns.map((t) => t.prompt)).toEqual(["turn satu", "turn dua", "prompt salah yang gagal"])
  const beforeSeq = resolveUserTurnBoundary(id, turns[2]!.prompt, turns[2]!.ts, cwd)
  expect(beforeSeq).toBe(4)
  expect(hasExplicitFileMutationAtOrAfter(id, beforeSeq, cwd)).toBe(false)
})

test("rewind: prompt berulang yang gagal tidak memotong turn lama", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  const repeated = [
    { role: "user", content: "lanjut" },
    { role: "assistant", content: "jawaban satu" },
    { role: "user", content: "lanjut" },
    { role: "assistant", content: "jawaban dua" },
  ]
  await saveSession(id, cwd, "sys", repeated, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "lanjut"),
    userEvent(id, 1, 1, base + 10, "lanjut"),
    userEvent(id, 2, 2, base + 20, "lanjut"),
  ])
  const turns = listUserTurns(id, cwd)
  expect(resolveUserTurnBoundary(id, turns[2]!.prompt, turns[2]!.ts, cwd)).toBe(4)
})

test("rewind: berkas + percakapan dipulihkan, sesi sumber tetap utuh", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await writeFile(join(cwd, "a.txt"), "after", "utf8")
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    userEvent(id, 1, 1, base + 10, "turn dua"),
    userEvent(id, 2, 2, base + 20, "turn tiga"),
    event({
      eventSeq: 3,
      ts: base + 30,
      sessionId: id,
      turnId: 2,
      type: "file.changed",
      paths: ["a.txt"],
      toolCallId: "t1",
    }),
  ])
  await saveCheckpointManifest(
    {
      sessionId: id,
      currentIndex: 0,
      checkpoints: [
        {
          id: "cp_target",
          turn: 3,
          timestamp: new Date(base + 30_000).toISOString(),
          description: "turn 3",
          snapshots: [{ path: "a.txt", content: "before" }],
          redoSnapshots: [{ path: "a.txt", content: "after" }],
        },
      ],
    },
    cwd,
  )

  const target = listUserTurns(id, cwd)[2]!
  const result = await rewindToTurn({
    sourceSessionId: id,
    target,
    cwd,
    beforeSeq: 4,
  })

  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("before")
  const branch = loadSession(result.branchId, cwd)
  expect(branch?.messages.length).toBe(4)
  expect(branch?.turnCount).toBe(2)
  const events = loadPresentationEvents(result.branchId, cwd)
  expect(events.every((e) => e.turnId < 2)).toBe(true)
  expect(loadSession(id, cwd)?.messages.length).toBe(4)

  const record = await readRewindRecord(result.branchId, cwd)
  expect(record?.sourceSessionId).toBe(id)
  expect(record?.safety).not.toBeNull()
  expect(record?.branchMessageHead).toBe(3)
  expect(record?.branchEventHead).toBe(1)
  expect(record?.branchUserTurns).toBe(2)
  const restored = await restoreRewindTarget(record!, cwd)
  expect(restored.length).toBeGreaterThan(0)
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after")
})

test("rewind: perubahan berkas tanpa checkpoint ditolak", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await writeFile(join(cwd, "a.txt"), "after", "utf8")
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    event({
      eventSeq: 1,
      ts: base + 10,
      sessionId: id,
      turnId: 0,
      type: "file.changed",
      paths: ["a.txt"],
      toolCallId: "t1",
    }),
  ])
  const target = listUserTurns(id, cwd)[0]!
  await expect(rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })).rejects.toThrow(
    /checkpoint tidak tersedia/,
  )
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after")
  expect(listUserTurns(id, cwd)).toHaveLength(1)
})

test("rewind: DISCUSS menolak undo yang menyentuh berkas", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await writeFile(join(cwd, "a.txt"), "after", "utf8")
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    event({
      eventSeq: 1,
      ts: base + 10,
      sessionId: id,
      turnId: 0,
      type: "file.changed",
      paths: ["a.txt"],
      toolCallId: "t1",
    }),
  ])
  const target = listUserTurns(id, cwd)[0]!
  await expect(
    rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0, allowFiles: false }),
  ).rejects.toThrow(/membutuhkan BUILD/)
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after")
})

test("rewind: undo turn pertama membuat cabang kosong yang tetap bisa di-resume", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  // Event prompt mendahului save turn (urutan nyata); target adalah pesan yang
  // sudah persisten, sehingga batas turn pertama harus kosong.
  const base = Date.now() - 10_000
  await appendPresentationEvents(id, cwd, [userEvent(id, 0, 0, base, "turn satu")])
  const target = listUserTurns(id, cwd)[0]!
  const result = await rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })
  const branch = loadSession(result.branchId, cwd)
  expect(branch).not.toBeNull()
  expect(branch?.messages.length).toBe(0)
  expect(branch?.turnCount).toBe(0)
  const record = await readRewindRecord(result.branchId, cwd)
  expect(record?.targetOrdinal).toBe(1)
  expect(record?.prompt).toBe("turn satu")
})

test("undoFilesToTurn: memilih checkpoint lewat timestamp, bukan nomor turn duplikat", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await writeFile(join(cwd, "a.txt"), "after", "utf8")
  await saveSession(id, cwd, "sys", firstTurn, { turns: 1 })
  const base = Date.now()
  await saveCheckpointManifest(
    {
      sessionId: id,
      currentIndex: 1,
      checkpoints: [
        {
          id: "cp_prior",
          turn: 1,
          timestamp: new Date(base - 1000).toISOString(),
          description: "prior",
          snapshots: [{ path: "a.txt", content: "prior" }],
        },
        {
          id: "cp_target",
          turn: 1,
          timestamp: new Date(base + 1000).toISOString(),
          description: "target",
          snapshots: [{ path: "a.txt", content: "before" }],
        },
      ],
    },
    cwd,
  )
  const res = await undoFilesToTurn(id, base, cwd, { fallbackTurn: 2 })
  expect(res.checkpoint?.id).toBe("cp_target")
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("before")
})

test("rewind: checkpoint turn target di luar jendela prompt berikutnya ditolak", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await writeFile(join(cwd, "a.txt"), "after", "utf8")
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    {
      eventSeq: 1,
      ts: base + 5,
      sessionId: id,
      turnId: 0,
      type: "file.changed",
      paths: ["a.txt"],
      toolCallId: "t1",
    } as unknown as DomainEvent,
    userEvent(id, 2, 1, base + 10, "turn dua"),
  ])
  await saveCheckpointManifest(
    {
      sessionId: id,
      currentIndex: 0,
      checkpoints: [
        {
          id: "cp_late",
          turn: 1,
          timestamp: new Date(base + 20_000).toISOString(),
          description: "checkpoint telat (milik turn berikutnya)",
          snapshots: [{ path: "a.txt", content: "before" }],
        },
      ],
    },
    cwd,
  )
  const target = listUserTurns(id, cwd)[0]!
  await expect(rewindToTurn({ sourceSessionId: id, target, cwd, beforeSeq: 0 })).rejects.toThrow(
    /checkpoint tidak tersedia/,
  )
  expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("after")
})

test("rewind: sesi legacy tanpa event memakai ordinal pesan user", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const turns = listUserTurns(id, cwd)
  expect(turns.map((t) => t.prompt)).toEqual(["turn satu", "turn dua"])
  expect(resolveUserTurnBoundaryByOrdinal(id, 2, cwd)).toBe(2)
  const branch = await branchSession(id, `${id}-legacy`, cwd, { beforeSeq: 2, beforeTurnId: 1 })
  expect(branch).toBe(2)
})

test("branch prefix eventSeq: turnId duplikat dari turn gagal tidak memotong event sebelumnya", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  const dst = `${id}-dupe`
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    userEvent(id, 1, 1, base + 10, "gagal A"),
    userEvent(id, 2, 1, base + 20, "gagal B"),
  ])
  await branchSession(id, dst, cwd, {
    beforeSeq: 4,
    beforeEventSeq: 2,
    beforeTurnTs: base + 20,
  })
  const events = loadPresentationEvents(dst, cwd)
  expect(events.map((e) => e.eventSeq)).toEqual([0, 1])
})

test("branch prefix: hanya pesan/turn/event sebelum batas yang disalin", async () => {
  const cwd = await makeCwd()
  const id = makeId()
  const dst = `${id}-branch`
  await saveSession(id, cwd, "sys", twoTurns, { turns: 2 })
  const base = Date.now() + 10_000
  await appendPresentationEvents(id, cwd, [
    userEvent(id, 0, 0, base, "turn satu"),
    userEvent(id, 1, 1, base + 10, "turn dua"),
  ])
  const copied = await branchSession(id, dst, cwd, { beforeSeq: 2, beforeTurnId: 1 })
  expect(copied).toBe(2)
  const branch = loadSession(dst, cwd)
  expect(branch?.messages.length).toBe(2)
  expect(branch?.turnCount).toBe(1)
  const events = loadPresentationEvents(dst, cwd)
  expect(events.map((e) => e.turnId)).toEqual([0])
  await deleteSession(dst, cwd)
})
