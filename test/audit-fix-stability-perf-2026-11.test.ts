// Regresi audit stabilitas, hang, crash, ReDoS, dan performa (2026-11-26).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession } from "#minicore"
import { estimateMessages, estimateSessionContext, estimateTools } from "#minicore/core/tokens.ts"
import { normalizeConfig } from "../src/config.ts"
import { compileIgnoreMatchers, isIgnored } from "../src/lib/ignore.ts"
import { decodeAnsiCQuotes, inlineSimpleVars } from "../src/policy/bash-guard.ts"
import { BpeTokenizer } from "../src/policy/bpe.ts"
import { createCalibratedEstimator, minicodeEstimator } from "../src/policy/context.ts"
import { dbPath, openSessionDb, setSessionDdlFaultForTest } from "../src/session/db/schema.ts"
import { TriggerCoordinator } from "../src/task/trigger.ts"
import { isReDosPronePattern } from "../src/tools/grep.ts"
import { promptAsk } from "../src/ui/approval/prompt.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  decodeKeysStream,
} from "../src/ui/input/prompt-engine.ts"
import { parseCells } from "../src/ui/render/cells.ts"
import { truncateToWidth } from "../src/ui/render/width.ts"
import { resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: FakeTty | null = null
let lastApp: TuiApp | null = null
const tempDirs: string[] = []

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "minicode-audit-2026-11-"))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  setSessionDdlFaultForTest(null)
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe("P0-1: /shell reacquireTerminal memulihkan stdin listener", () => {
  test("TUI tetap menerima input setelah releaseTerminal() + reacquireTerminal() tanpa suspend", async () => {
    tty = installFakeTty({ columns: 100, rows: 24, isTTY: true })
    const bus = createFakeBus()
    const submitted: string[] = []
    const transcript = new Transcript(bus as never)
    const host: TuiHost = {
      bus: bus as never,
      getStatus: () => ({
        footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
        busy: false,
      }),
      listCommands: () => [],
      submit: async (line) => {
        submitted.push(line)
        return undefined
      },
      enqueue: () => false,
      copySelection: () => true,
      abort: () => {},
      cycleWorkMode: () => {},
      togglePermissionMode: () => {},
      toggleCompact: () => {},
      toggleReasoning: () => {},
    }
    const app = new TuiApp(transcript, host)
    lastApp = app
    const runPromise = app.run()
    await tty.ready()

    app.releaseTerminal()
    expect(app.reacquireTerminal()).toBe(true)

    await tty.send("halo")
    await tty.send(KEY.enter)
    await tty.ready()
    expect(submitted).toEqual(["halo"])

    app.requestQuit()
    await runPromise
  })
})

describe("P0-2: bracketed paste overflow tidak pernah mengunci decoder", () => {
  test("ESC[201~ terbelah di batas 2 MiB tetap keluar dari mode paste", () => {
    const state = createDecoderState()
    const start = Buffer.from("\x1b[200~", "utf8")
    decodeKeysStream(start, state)
    // Kirim tepat di atas 2 MiB dengan ujung yang menyisakan prefix "\x1b[20"
    const payload = Buffer.alloc(2 * 1024 * 1024 - 1, 0x61)
    decodeKeysStream(payload, state)
    decodeKeysStream(Buffer.from("\x1b[20", "utf8"), state)
    decodeKeysStream(Buffer.from("1~x", "utf8"), state)

    const after = decodeKeysStream(Buffer.from("z", "utf8"), state)
    expect(state.pasteOverflow).toBe(false)
    expect(after.some((k) => k.key.type === "char" && k.key.ch === "z")).toBe(true)
  })

  test("UTF-8 lead byte terpotong tepat sebelum ESC[201~ saat overflow tetap keluar", () => {
    const state = createDecoderState()
    decodeKeysStream(Buffer.from("\x1b[200~", "utf8"), state)
    decodeKeysStream(Buffer.alloc(2 * 1024 * 1024 + 64, 0x61), state)
    // 0xc3 adalah lead byte UTF-8 tak lengkap diikuti langsung oleh ESC[201~
    decodeKeysStream(Buffer.concat([Buffer.from([0xc3]), Buffer.from("\x1b[201~", "utf8")]), state)

    const after = decodeKeysStream(Buffer.from("q", "utf8"), state)
    expect(state.pasteOverflow).toBe(false)
    expect(after.some((k) => k.key.type === "char" && k.key.ch === "q")).toBe(true)
  })

  test("ESC sebelum [201~ dengan jeda >50ms saat pasteOverflow tidak di-flush sebagai Esc tunggal", async () => {
    const state = createDecoderState()
    const seen: string[] = []
    const pump = createKeyStreamPump({
      state,
      escMs: 25,
      onKeys: (keys) => {
        for (const k of keys) seen.push(k.key.type)
        return false
      },
    })
    try {
      pump.push(Buffer.from("\x1b[200~", "utf8"))
      pump.push(Buffer.alloc(2 * 1024 * 1024 + 32, 0x61))
      // Chunk terbelah tepat pada ESC pembuka terminator ESC[201~.
      pump.push(Buffer.from("\x1b", "utf8"))
      expect(state.pasteOverflow).toBe(true)
      await new Promise((r) => setTimeout(r, 45))
      expect(seen).not.toContain("esc")

      pump.push(Buffer.from("[201~", "utf8"))
      expect(state.pasteOverflow).toBe(false)
      pump.push(Buffer.from("\r", "utf8"))
      expect(seen.at(-1)).toBe("enter")
    } finally {
      pump.dispose()
    }
  })
})

describe("P0-3: withAbort pada signal pre-aborted tidak memicu unhandled rejection", () => {
  test("Session.run pre-aborted dengan provider yang menolak belakangan tidak bocor", async () => {
    let unhandled: unknown = null
    const onUnhandled = (reason: unknown) => {
      unhandled = reason
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const ac = new AbortController()
      ac.abort(new Error("user cancelled"))
      const session = createSession({
        provider: {
          id: "stub",
          models: ["stub"],
          stream() {
            return {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    new Promise((_, reject) => {
                      setTimeout(() => reject(new Error("late provider boom")), 10)
                    }),
                }
              },
            }
          },
        },
        permissions: { check: async () => "allow" },
        tools: [],
      })
      await expect(session.run("hi", { signal: ac.signal })).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 30))
      expect(unhandled).toBeNull()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("P0-12: normalisasi config models yang korup", () => {
  test("models non-array atau berisi non-string dinormalisasi tanpa crash", () => {
    const cfg = normalizeConfig({
      providers: [
        { id: "badStr", baseUrl: "https://example.com", models: "gpt-4" },
        { id: "badNull", baseUrl: "https://example.com", models: null },
        { id: "mixed", baseUrl: "https://example.com", models: [123, "ok-1", "", "ok-2"] },
      ],
    })
    const byId = new Map(cfg.providers.map((p) => [p.id, p]))
    expect(byId.get("badStr")?.models).toEqual([])
    expect(byId.get("badNull")?.models).toEqual([])
    expect(byId.get("mixed")?.models).toEqual(["ok-1", "ok-2"])
  })
})

describe("P0-13: anti-ReDoS grep, ignore, dan bash-guard", () => {
  test("grep menolak kelas karakter berkuantifier berdampingan", () => {
    expect(isReDosPronePattern("\\w+\\w+\\w+!")).toBe(true)
    expect(isReDosPronePattern("[a-z]+[a-z]+$")).toBe(true)
    expect(isReDosPronePattern("export\\s+function")).toBe(false)
  })

  test("ignore membatasi pola patologis dan jumlah pola dengan cepat", () => {
    const t0 = performance.now()
    const patterns = [
      "a*a*a*a*a*a*a*a*a*a*a*b",
      "**/**/**/**/**/**/target",
      ...Array.from({ length: 2500 }, (_, i) => `dir${i}/*.log`),
    ]
    const matchers = compileIgnoreMatchers(patterns)
    expect(matchers.length).toBeLessThanOrEqual(2000)
    expect(isIgnored(`${"a".repeat(80)}!`, matchers)).toBe(false)
    expect(performance.now() - t0).toBeLessThan(200)
  })

  test("bash-guard decodeAnsiCQuotes & inlineSimpleVars bounded pada input patologis", () => {
    const t0 = performance.now()
    const unclosed = `$'${"\\".repeat(5000)}`
    expect(decodeAnsiCQuotes(unclosed)).toBe(unclosed)
    const expanded = inlineSimpleVars(`A=${"x".repeat(400)}; echo ${"$A".repeat(200)}`)
    expect(expanded.length).toBeLessThanOrEqual(66_000)
    expect(performance.now() - t0).toBeLessThan(200)
  })
})

describe("P1-20 & P1-31: pre-aborted approval prompt & bounded TriggerCoordinator", () => {
  test("promptAsk dengan signal sudah abort langsung deny tanpa membocorkan stdin listener", async () => {
    tty = installFakeTty({ isTTY: true })
    const before = process.stdin.listenerCount("data")
    const ac = new AbortController()
    ac.abort()
    const ans = await promptAsk({ name: "bash", args: { command: "ls" }, signal: ac.signal })
    expect(ans).toBe("deny")
    expect(process.stdin.listenerCount("data")).toBe(before)
  })

  test("TriggerCoordinator di bawah badai trigger berhenti maksimal 2 siklus dan kembali idle", async () => {
    let cycles = 0
    let trig!: TriggerCoordinator
    trig = new TriggerCoordinator({
      runCycle: async () => {
        cycles++
        // Terus tembakkan trigger di setiap siklus (simulasi trigger storm)
        void trig.fire("task-mutation")
        await new Promise((r) => setTimeout(r, 2))
        return { cycles }
      },
    })
    const res = await trig.fire("manual")
    expect(res.outcome).toBe("EVALUATED")
    expect(cycles).toBe(2)
    expect(trig.busy).toBe(false)
  })
})

describe("Wave 3 performa: cells ASCII fast-path, truncateToWidth, BPE, schema stamp", () => {
  test("parseCells konsisten untuk ASCII, SGR, dan Unicode lebar/combining", () => {
    const ascii = parseCells("hello world")
    expect(ascii.map((c) => c.glyph).join("")).toBe("hello world")
    expect(ascii.every((c) => c.style === "" && !c.cont)).toBe(true)

    const styled = parseCells("\x1b[32mhi\x1b[0m中e\u0301")
    expect(styled[0]?.glyph).toBe("h")
    expect(styled[0]?.style).toContain("32")
    expect(styled[2]?.glyph).toBe("中")
    expect(styled[3]?.cont).toBe(true)
    expect(styled[4]?.glyph).toBe("e\u0301")
  })

  test("truncateToWidth pada string 500 KB selesai O(width)", () => {
    const huge = "x".repeat(500_000)
    const t0 = performance.now()
    const out = truncateToWidth(huge, 40)
    expect(out.length).toBe(40)
    expect(out.endsWith("...")).toBe(true)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test("BpeTokenizer menangani potongan 20 KB tanpa spasi secara instan", () => {
    const tok = new BpeTokenizer({ vocab: { a: 0, aa: 1 }, merges: ["a a"] })
    const t0 = performance.now()
    const n = tok.countTokens("a".repeat(20_000))
    expect(n).toBeGreaterThan(0)
    expect(performance.now() - t0).toBeLessThan(100)
  })

  test("openSessionDb melewati DDL saat sidik file sama, tetapi migrasi ulang jika file dibuat baru", () => {
    const dir = makeTempDir()
    const p = dbPath(dir)
    const db1 = openSessionDb(dir)
    db1.close()

    setSessionDdlFaultForTest(1)
    const db2 = openSessionDb(dir)
    db2.close()

    // Hapus file DB di path sama: sidik berubah → migrasi harus jalan lagi.
    setSessionDdlFaultForTest(null)
    for (const f of [p, `${p}-wal`, `${p}-shm`]) {
      try {
        rmSync(f, { force: true })
      } catch {}
    }
    const db3 = openSessionDb(dir)
    try {
      const tbl = db3
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .get()
      expect(tbl).toBeTruthy()
    } finally {
      db3.close()
    }
  })

  test("WeakMap memo estimasi pesan & tool tetap persis setelah kalibrasi berubah dan mengakselerasi 40-step", async () => {
    const { allTools } = await import("../src/tools/index.ts")
    const msgs = Array.from({ length: 120 }, (_, i) => ({
      role:
        i % 3 === 0 ? ("user" as const) : i % 3 === 1 ? ("assistant" as const) : ("tool" as const),
      content: `baris ${i} `.repeat(40),
      ...(i % 3 === 2 ? { toolCallId: `c${i}`, name: "read_file" } : {}),
    }))
    const cal = createCalibratedEstimator()
    const baseUncached = estimateMessages(msgs as never, minicodeEstimator)
    expect(estimateMessages(msgs as never, cal.estimator)).toBe(baseUncached)

    // Naikkan factor kalibrasi: cacheKey baru memutus cache factor lama tanpa stale hit.
    cal.recordTokenCalibrationSample(100, 250)
    const scaledFirst = estimateMessages(msgs as never, cal.estimator)
    expect(scaledFirst).toBeGreaterThan(baseUncached)
    expect(estimateMessages(msgs as never, cal.estimator)).toBe(scaledFirst)

    // Closure estimator tanpa cacheKey (stateful) tak pernah tersangkut cache.
    let mult = 1
    const stateful = (s: string) => s.length * mult
    const m1 = estimateMessages([{ role: "user", content: "abcd" }], stateful)
    mult = 3
    expect(estimateMessages([{ role: "user", content: "abcd" }], stateful)).toBe(m1 * 3)

    const t0 = performance.now()
    for (let step = 0; step < 40; step++) {
      estimateSessionContext(
        { messages: msgs.slice(0, (step + 1) * 3) as never },
        "sys".repeat(500),
        allTools,
        minicodeEstimator,
      )
    }
    expect(performance.now() - t0).toBeLessThan(150)
    expect(estimateTools(allTools, minicodeEstimator)).toBeGreaterThan(0)
  })
})
