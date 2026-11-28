import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { visibleWireToolSchemas } from "../src/app/session.ts"
import {
  createInitialState,
  deriveSupersedes,
  deriveTurnSummary,
  reduce,
} from "../src/presentation/reducer.ts"
import { getAuth, removeAuth, saveAuth } from "../src/providers/auth-store.ts"
import { beginSessionDbScope, endSessionDbScope, withSessionDb } from "../src/session/db/schema.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  loadJournal,
  sweepJournal,
} from "../src/session/journal.ts"
import { globTool } from "../src/tools/glob.ts"
import { stripSgr } from "../src/ui/render/sanitize.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { lazySnapshotState } from "../vendor/minicore/src/core/snapshot.ts"
import { estimateTools } from "../vendor/minicore/src/core/tokens.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe("performance optimization regressions", () => {
  test("Transcript incremental pendingRows matches full one-shot rendering", () => {
    const sample = [
      "# Heading Utama\n\nParagraf pembuka dengan teks cukup panjang agar melampaui batas pemecahan prefiks streaming.",
      "\n\n| Kolom A | Kolom B |\n| :--- | ---: |\n| satu | 10 |\n| dua | 20 |\n\n",
      "```ts\nconst x = 1\nconst y = x + 2\n```\n\n",
      "### Subjudul Lanjutan\n\n- item pertama dengan `kode`\n- item kedua **tebal**\n\n",
      ...Array.from(
        { length: 45 },
        (_, i) =>
          `Blok paragraf streaming ke-${i} berisi uraian teknis kode & metrik performa.\n\n`,
      ),
      "Paragraf ekor aktif yang masih berjalan",
    ].join("")

    const busOneShot = createFakeBus()
    const tFull = new Transcript(busOneShot as never)
    busOneShot.emit("provider:text", { text: sample })
    const expected = tFull.viewport(80, 400, 0).rows.map((r) => r.text)

    const busInc = createFakeBus()
    const tInc = new Transcript(busInc as never)
    for (let pos = 0; pos < sample.length; pos += 193) {
      busInc.emit("provider:text", { text: sample.slice(pos, pos + 193) })
      // Paksa render berkala agar cache prefiks terbentuk lalu ter-advance.
      tInc.viewportMetrics(80, 40)
    }
    const actual = tInc.viewport(80, 400, 0).rows.map((r) => r.text)
    expect(actual).toEqual(expected)
  })

  test("displayWidth & stripSgr preserve mixed ASCII/Unicode and SGR behavior", () => {
    expect(stripSgr("plain text")).toBe("plain text")
    expect(stripSgr("\u001b[32mgreen\u001b[0m plain")).toBe("green plain")
    expect(displayWidth("› src/ui/tui/app.ts · 12s")).toBe("› src/ui/tui/app.ts · 12s".length)
    expect(displayWidth("e\u0301clair")).toBe(6)
    expect(displayWidth("日本語abc")).toBe(9)
  })

  test("visibleWireToolSchemas preserves object references for toolTokenCache hits", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" as const, properties: { path: { type: "string" as const } } },
        execute: async () => "ok",
      },
      {
        name: "write_file",
        description: "Write a file",
        parameters: { type: "object" as const, properties: { path: { type: "string" as const } } },
        execute: async () => "ok",
      },
    ]
    const hidden = new Set(["write_file"])
    const first = visibleWireToolSchemas(tools, hidden)
    const second = visibleWireToolSchemas(tools, hidden)
    expect(first).toBe(second)
    expect(first).toHaveLength(1)
    expect(first[0]).toBe(second[0])
    const est = Object.assign((s: string) => s.length, { cacheKey: () => "test-len" })
    expect(estimateTools(first, est)).toBe(estimateTools(second, est))
  })

  test("lazySnapshotState defers history cloning until read and preserves isolation", () => {
    let getterReads = 0
    const rawHistory = [{ role: "user" as const, content: "hello" }]
    const state = {
      get history() {
        getterReads++
        return rawHistory
      },
      turnCount: 1,
      stepCount: 0,
      model: "m1",
    }
    const stepSnap = lazySnapshotState(state)
    const permSnap = lazySnapshotState(stepSnap)
    const ctxSnap = lazySnapshotState(stepSnap)
    // `stepSnap` reads `state.history` once (slice); `permSnap` & `ctxSnap` must not trigger extra clones.
    expect(getterReads).toBe(1)
    const hPerm = permSnap.history as { role: string; content: string }[]
    hPerm.push({ role: "user", content: "mutated" })
    expect(ctxSnap.history).toHaveLength(1)
    expect(rawHistory).toHaveLength(1)
  })

  test("withSessionDb pools handles inside scope and closes handle on endSessionDbScope", () => {
    const dir = makeTempDir("minicode-db-scope-")
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    let firstHandle: Database | undefined
    beginSessionDbScope(dir, true)
    try {
      firstHandle = withSessionDb(
        dir,
        (db) => {
          db.exec("CREATE TABLE IF NOT EXISTS probe(x INT); INSERT INTO probe VALUES (1);")
          return db
        },
        true,
      )
      const secondHandle = withSessionDb(
        dir,
        (db) => {
          const stmt = db.prepare("SELECT COUNT(*) AS n FROM probe")
          const row = stmt.get() as { n: number }
          stmt.finalize()
          expect(row.n).toBe(1)
          return db
        },
        true,
      )
      expect(secondHandle).toBe(firstHandle)
    } finally {
      endSessionDbScope(dir, true)
    }
    const postScopeHandle = withSessionDb(dir, (db) => db, true)
    expect(postScopeHandle).not.toBe(firstHandle)
  })

  test("loadJournal cache stays coherent across append and sweep", async () => {
    const dir = makeTempDir("minicode-jcache-")
    const sid = "sess-jcache"
    const i1 = await appendMutationIntent({
      session: sid,
      cwd: dir,
      tool: "write_file",
      paths: ["a.ts"],
    })
    const l1 = await loadJournal(sid, dir)
    expect(l1.records).toHaveLength(1)
    await appendMutationTerminal(sid, dir, i1.id, i1.seq, "write_file", "committed")
    const l2 = await loadJournal(sid, dir)
    expect(l2.records).toHaveLength(2)
    await sweepJournal(sid, dir)
    const l3 = await loadJournal(sid, dir)
    expect(l3.records).toHaveLength(2)
  })

  test("loadJournal cache tidak menggandakan record saat append dan baca konkuren", async () => {
    const dir = makeTempDir("minicode-jcache-race-")
    const sid = "sess-jcache-race"
    for (let round = 0; round < 5; round++) {
      const s = `${sid}-${round}`
      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 10; i++) {
        ops.push(
          appendMutationIntent({
            session: s,
            cwd: dir,
            tool: "delegate_task",
          }).then(async (rec) => {
            await loadJournal(s, dir)
            await appendMutationTerminal(s, dir, rec.id, rec.seq, "delegate_task", "committed")
          }),
        )
        if (i % 2 === 0) ops.push(loadJournal(s, dir))
      }
      await Promise.all(ops)
      const finalLoad = await loadJournal(s, dir)
      const pending = finalLoad.records.filter((r) => r.state === "pending")
      const committed = finalLoad.records.filter((r) => r.state === "committed")
      expect(pending).toHaveLength(10)
      expect(committed).toHaveLength(10)
    }
  })

  test("presentation reducer indices match multi-turn deriveTurnSummary & deriveSupersedes", () => {
    const state = createInitialState("s1")
    reduce(state, {
      eventSeq: 1,
      ts: 100,
      sessionId: "s1",
      turnId: 1,
      type: "turn.started",
      promptRef: "p1",
    })
    reduce(state, {
      eventSeq: 2,
      ts: 110,
      sessionId: "s1",
      turnId: 1,
      stepId: 0,
      type: "tool.started",
      toolCallId: "tc1",
      identity: { origin: "builtin", name: "bash", qualified: "bash" },
      argsSummary: { target: "npm test", text: "bash npm test" },
    })
    reduce(state, {
      eventSeq: 3,
      ts: 120,
      sessionId: "s1",
      turnId: 1,
      type: "tool.failed",
      toolCallId: "tc1",
      durationMs: 10,
      cause: "exec",
      message: "failed",
      expandRef: { toolCallId: "tc1", idx: 0, kind: "output" },
    })
    reduce(state, {
      eventSeq: 4,
      ts: 130,
      sessionId: "s1",
      turnId: 1,
      stepId: 1,
      type: "tool.started",
      toolCallId: "tc2",
      identity: { origin: "builtin", name: "bash", qualified: "bash" },
      argsSummary: { target: "npm test", text: "bash npm test" },
    })
    expect(
      state.activities.get("s1\u0000tc2")?.supersedes ?? state.activities.get("s1:tc2")?.supersedes,
    ).toBe("tc1")
    expect(
      deriveSupersedes(state, {
        sessionId: "s1",
        turnId: 1,
        qualified: "bash",
        target: "npm test",
        startSeq: 5,
      }),
    ).toBe("tc1")
    const sum = deriveTurnSummary(state, "s1", 1)
    expect(sum.toolsFailed).toBe(1)
  })

  test("auth-store cache reflects saveAuth and removeAuth updates", async () => {
    const prevHome = process.env.MINICODE_HOME
    const home = makeTempDir("minicode-auth-")
    process.env.MINICODE_HOME = home
    try {
      await saveAuth("qwen", { type: "oauth", accessToken: "tok-1" })
      expect((await getAuth("qwen"))?.accessToken).toBe("tok-1")
      await saveAuth("qwen", { type: "oauth", accessToken: "tok-2" })
      expect((await getAuth("qwen"))?.accessToken).toBe("tok-2")
      expect(await removeAuth("qwen")).toBe(true)
      expect(await getAuth("qwen")).toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prevHome
    }
  })

  test("globTool with preFilter returns matches while excluding sensitive files", async () => {
    const dir = makeTempDir("minicode-glob-")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1\n")
    writeFileSync(join(dir, ".env"), "SECRET=1\n")
    writeFileSync(join(dir, "README.md"), "doc\n")
    const res = await globTool.execute({ pattern: "**/*.ts" }, {
      cwd: dir,
      signal: new AbortController().signal,
    } as never)
    expect(res).toBe("src/index.ts")
  })
})
