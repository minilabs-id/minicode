import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  captureFileSnapshot,
  recordCheckpoint,
  recordCheckpointFromSnapshots,
  redoLastCheckpoint,
  snapshotWorkspace,
  undoLastCheckpoint,
} from "../src/session/checkpoint.ts"

const testDir = join(tmpdir(), `minicode-cp-test-${Date.now()}`)
const testFile = join(testDir, "test.txt")

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  await writeFile(testFile, "initial content", "utf8")
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {})
})

test("checkpoint: records snapshot and undos file modifications", async () => {
  const sessionId = "test-cp-sess"

  // Record initial state
  await recordCheckpoint(sessionId, 1, [testFile], "before edit", testDir)

  // Modify file
  await writeFile(testFile, "modified by agent", "utf8")
  expect(await readFile(testFile, "utf8")).toBe("modified by agent")

  // Undo
  const undoRes = await undoLastCheckpoint(sessionId, testDir)
  expect(undoRes.success).toBe(true)
  expect(await readFile(testFile, "utf8")).toBe("initial content")

  // Redo menerapkan kembali modified state yang ditangkap saat undo
  const redoRes = await redoLastCheckpoint(sessionId, testDir)
  expect(redoRes.success).toBe(true)
  expect(await readFile(testFile, "utf8")).toBe("modified by agent")
})

test("checkpoint: recordCheckpointFromSnapshots restores pre-edit state", async () => {
  const sessionId = "test-cp-snap"
  await writeFile(testFile, "initial content", "utf8")
  // capture pre-edit (persis yang dilakukan loop: baca sebelum edit)
  const snap = await captureFileSnapshot(testFile, testDir)
  // agen mengedit
  await writeFile(testFile, "agent edit", "utf8")
  await recordCheckpointFromSnapshots(sessionId, 1, [snap], "pre-edit", testDir)
  // undo → kembali ke state sebelum turn
  const undoRes = await undoLastCheckpoint(sessionId, testDir)
  expect(undoRes.success).toBe(true)
  expect(await readFile(testFile, "utf8")).toBe("initial content")
})

test("checkpoint: redo reapplies post-edit state", async () => {
  const sessionId = "test-cp-redo"
  await writeFile(testFile, "initial", "utf8")
  const pre = await captureFileSnapshot(testFile, testDir) // pre-edit
  await writeFile(testFile, "agent edit", "utf8")
  const post = await captureFileSnapshot(testFile, testDir) // post-edit
  await recordCheckpointFromSnapshots(sessionId, 1, [pre], "turn", testDir, [post])

  await undoLastCheckpoint(sessionId, testDir)
  expect(await readFile(testFile, "utf8")).toBe("initial")

  await redoLastCheckpoint(sessionId, testDir)
  expect(await readFile(testFile, "utf8")).toBe("agent edit")
})

test("checkpoint: undo skips paths outside workspace (jail)", async () => {
  const sessionId = "test-cp-jail"
  const outside = join(testDir, "..", `outside-${Date.now()}.txt`)
  await writeFile(outside, "sensitive", "utf8")
  await recordCheckpointFromSnapshots(
    sessionId,
    1,
    [{ path: relative(testDir, outside), content: "hijacked" }],
    "turn",
    testDir,
  )

  const res = await undoLastCheckpoint(sessionId, testDir)
  expect(res.restoredFiles.some((f) => f.includes("skipped"))).toBe(true)
  expect(await readFile(outside, "utf8")).toBe("sensitive") // tidak tertimpa
  await rm(outside, { force: true }).catch(() => {})
})

test("checkpoint: snapshotWorkspace captures files (bash/git mutations undoable)", async () => {
  await writeFile(join(testDir, "a.ts"), "export const a = 1;\n", "utf8")
  await mkdir(join(testDir, ".minicode"), { recursive: true })
  await writeFile(join(testDir, ".minicode", "ignore-me.txt"), "ignored", "utf8")
  const snaps = await snapshotWorkspace(testDir, 200)
  expect(snaps.some((s) => s.path === "a.ts")).toBe(true)
  // .minicode (dot dir) dilewati
  expect(snaps.some((s) => s.path.includes("ignore-me"))).toBe(false)
})

test("checkpoint: readCheckpointInventorySync dan pemulihan manifest korup/null", async () => {
  const { loadCheckpointManifest, readCheckpointInventorySync, saveCheckpointManifest } =
    await import("../src/session/checkpoint.ts")
  const sid = "test-cp-inv"
  expect(readCheckpointInventorySync(sid, testDir).exists).toBe(false)

  await recordCheckpointFromSnapshots(
    sid,
    3,
    [{ path: "test.txt", content: "initial content" }],
    "turn-3",
    testDir,
  )
  const validInv = readCheckpointInventorySync(sid, testDir)
  expect(validInv.exists).toBe(true)
  expect(validInv.corrupt).toBe(false)
  expect(validInv.checkpointCount).toBe(1)
  expect(validInv.latestTurn).toBe(3)

  // Manifest JSON rusak → inventory lapor corrupt:true tanpa menulis, load backup ke .corrupt.*
  const manifestPath = join(testDir, ".minicode", "checkpoints", sid, "manifest.json")
  await writeFile(manifestPath, "{bad-json", "utf8")
  const corruptInv = readCheckpointInventorySync(sid, testDir)
  expect(corruptInv.exists).toBe(true)
  expect(corruptInv.corrupt).toBe(true)
  const recovered = await loadCheckpointManifest(sid, testDir)
  expect(recovered.checkpoints).toEqual([])
  expect(recovered.currentIndex).toBe(-1)

  // Manifest JSON literal `null` dinormalisasi ke struktur kosong aman
  await writeFile(manifestPath, "null", "utf8")
  const nullRecovered = await loadCheckpointManifest(sid, testDir)
  expect(nullRecovered.checkpoints).toEqual([])
  expect(nullRecovered.currentIndex).toBe(-1)

  // saveCheckpointManifest langsung + undo file newly-created (`content: null`)
  await saveCheckpointManifest({ sessionId: sid, currentIndex: -1, checkpoints: [] }, testDir)
})

test("checkpoint: recordCheckpointFromTrees memangkas cabang redo dan prune saat melebihi pagu", async () => {
  const { loadCheckpointManifest, recordCheckpointFromTrees, saveCheckpointManifest } =
    await import("../src/session/checkpoint.ts")
  const { LIMITS } = await import("../src/constants.ts")
  const sid = "test-cp-trees-cap"

  // Sama treeBefore/treeAfter → no-op (null)
  expect(
    await recordCheckpointFromTrees(sid, 0, "same-tree", "same-tree", "noop", testDir),
  ).toBeNull()

  const total = LIMITS.CHECKPOINT_MAX_COUNT + 3
  for (let i = 1; i <= total; i++) {
    await recordCheckpointFromTrees(sid, i, `pre-${i}`, `post-${i}`, `turn ${i}`, testDir)
  }
  const m1 = await loadCheckpointManifest(sid, testDir)
  expect(m1.checkpoints).toHaveLength(LIMITS.CHECKPOINT_MAX_COUNT)
  expect(m1.checkpoints[0]!.turn).toBe(4)

  // Mundurkan pointer lalu rekam checkpoint baru untuk menguji pemotongan cabang redo
  await saveCheckpointManifest({ ...m1, currentIndex: 1 }, testDir)
  await recordCheckpointFromTrees(sid, 99, "pre-branch", "post-branch", "branch", testDir)
  const m2 = await loadCheckpointManifest(sid, testDir)
  expect(m2.checkpoints).toHaveLength(3)
  expect(m2.checkpoints[2]!.turn).toBe(99)
  // Beri kesempatan pruneUnlistedSessionRefs fire-and-forget selesai sebelum afterEach membersihkan dir (Windows EBUSY).
  await Bun.sleep(150)
})

test("checkpoint: snapshot hapus file (content null), jalur terlindungi, redo tanpa data, & overflow snapshot", async () => {
  const { loadCheckpointManifest, saveCheckpointManifest } = await import(
    "../src/session/checkpoint.ts"
  )
  const { LIMITS } = await import("../src/constants.ts")
  const sid = "test-cp-edge"
  const createdFile = join(testDir, "created.txt")
  await writeFile(createdFile, "baru", "utf8")

  // Redo tanpa redoSnapshots gagal dengan pesan jelas
  await recordCheckpointFromSnapshots(
    sid,
    1,
    [
      { path: "created.txt", content: null },
      { path: ".minicode/hooks/pre.sh", content: "evil" },
    ],
    "create",
    testDir,
  )
  const undoCreate = await undoLastCheckpoint(sid, testDir)
  expect(undoCreate.success).toBe(true)
  expect(undoCreate.restoredFiles.some((f) => f.includes("removed"))).toBe(true)
  expect(undoCreate.restoredFiles.some((f) => f.includes("protected path"))).toBe(true)

  const m = await loadCheckpointManifest(sid, testDir)
  m.checkpoints[0]!.redoSnapshots = undefined
  await saveCheckpointManifest(m, testDir)
  const noRedo = await redoLastCheckpoint(sid, testDir)
  expect(noRedo.success).toBe(false)
  expect(noRedo.message).toContain("does not have redo data")

  // Overflow & cabang redo pada recordCheckpointFromSnapshots
  for (let i = 2; i <= LIMITS.CHECKPOINT_MAX_COUNT + 3; i++) {
    await recordCheckpointFromSnapshots(
      sid,
      i,
      [{ path: "test.txt", content: `v${i}` }],
      `t${i}`,
      testDir,
    )
  }
  const mOver = await loadCheckpointManifest(sid, testDir)
  expect(mOver.checkpoints).toHaveLength(LIMITS.CHECKPOINT_MAX_COUNT)
  await saveCheckpointManifest({ ...mOver, currentIndex: 0 }, testDir)
  await recordCheckpointFromSnapshots(
    sid,
    99,
    [{ path: "test.txt", content: "branch" }],
    "branch",
    testDir,
  )
  const mBranch = await loadCheckpointManifest(sid, testDir)
  expect(mBranch.checkpoints).toHaveLength(2)
})
