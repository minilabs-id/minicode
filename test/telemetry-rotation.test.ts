// E-19: rotasi telemetry — counter hanya pemicu, `rotateFile` tetap membaca
// berkas nyata; 500 event harus menghasilkan ≤5× rotasi dan chmod 1×/file.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetTraceTelemetryForTest,
  __setTraceRotationThresholdForTest,
  __traceTelemetryStatsForTest,
  readTraceRows,
  type StepTrace,
  writeStepTrace,
  writeTrace,
} from "../src/telemetry/trace.ts"

const dirs: string[] = []
const prevTelemetry = process.env.MINICODE_TELEMETRY

afterEach(() => {
  __resetTraceTelemetryForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (prevTelemetry === undefined) delete process.env.MINICODE_TELEMETRY
  else process.env.MINICODE_TELEMETRY = prevTelemetry
})

function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-trace-rot-"))
  dirs.push(d)
  return d
}

test("500 event → rotasi ≤5×, chmod tepat 1× per file", async () => {
  process.env.MINICODE_TELEMETRY = "1"
  __resetTraceTelemetryForTest()
  const cwd = tmpCwd()
  // Ambang rendah supaya rotasi benar-benar terjadi (default 904 → 0 rotasi).
  __setTraceRotationThresholdForTest(100)

  const row: StepTrace = {
    sessionId: "s-rot",
    timestamp: new Date().toISOString(),
    kind: "tool",
    step: 1,
    tool: "read_file",
    ok: true,
    args: "path=src/a.ts",
  }
  for (let i = 0; i < 500; i++) await writeStepTrace(cwd, row)

  const stats = __traceTelemetryStatsForTest()
  expect(stats.rotations).toBeLessThanOrEqual(5)
  expect(stats.rotations).toBeGreaterThan(0)
  expect(stats.chmods).toBe(1)

  const raw = readFileSync(join(cwd, ".minicode", "step-traces.jsonl"), "utf8")
  expect(raw.trim().split("\n").length).toBeLessThanOrEqual(1000)
  expect(readTraceRows<StepTrace>(cwd, "step-traces.jsonl").length).toBeGreaterThan(0)
})

test("rotasi memotong ke 1000 baris terakhir walaupun counter meleset", async () => {
  process.env.MINICODE_TELEMETRY = "1"
  const cwd = tmpCwd()
  __setTraceRotationThresholdForTest(1)

  // Isi berkas dengan 1100 baris di luar counter agar rotateFile harus
  // membaca berkas nyata, bukan mempercayai Map.
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const dir = join(cwd, ".minicode")
  mkdirSync(dir, { recursive: true })
  const lines = Array.from({ length: 1100 }, (_, i) =>
    JSON.stringify({
      sessionId: "s",
      timestamp: "t",
      prompt: `p${i}`,
      durationMs: 0,
      steps: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      ok: true,
    }),
  )
  writeFileSync(join(dir, "traces.jsonl"), `${lines.join("\n")}\n`)

  await writeTrace(cwd, {
    sessionId: "s",
    timestamp: "t",
    prompt: "prompt",
    durationMs: 0,
    steps: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    ok: true,
  })

  const rows = readTraceRows(cwd, "traces.jsonl")
  expect(rows.length).toBe(1000)
  expect(rows.at(-1)?.prompt).toBe("prompt")
})

test("scrub tetap berlaku pada jalur fire-and-forget", async () => {
  process.env.MINICODE_TELEMETRY = "1"
  const cwd = tmpCwd()
  __setTraceRotationThresholdForTest(1000)

  await writeStepTrace(cwd, {
    sessionId: "s",
    timestamp: "t",
    kind: "tool",
    step: 1,
    tool: "bash",
    ok: true,
    args: "cmd=echo sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  })
  const raw = readFileSync(join(cwd, ".minicode", "step-traces.jsonl"), "utf8")
  expect(raw).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
})
