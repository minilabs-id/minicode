// Hardening F-09/F-12: batas runtime tak valid tidak boleh punya perilaku
// implisit (abort instan, loop tak terbatas, worker nol, hot-retry).
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent } from "#minicore/core/provider.ts"
import { DEFAULT_MAX_STEPS } from "#minicore/core/session.ts"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { cappedRecovery, createMinicodeSession } from "../src/app/session.ts"
import { LIMITS } from "../src/constants.ts"

test("F-12: retryAfter Infinity/NaN/negatif → backoff, besar → cap", () => {
  // Sejak anggaran pemulihan bersama (T-009), jeda retry memakai FULL JITTER:
  // nilainya acak pada [min, batas atas]. Yang diuji di sini karena itu BUKAN
  // angka pasti, melainkan pagar: nilai tak masuk akal tidak boleh menjadi hot
  // retry (jeda ~0) dan tidak boleh melebihi plafon.
  const assertRetry = (action: ReturnType<typeof cappedRecovery.onError>, maxMs: number) => {
    expect(action.type).toBe("retry")
    if (action.type !== "retry") return
    expect(Number.isFinite(action.delayMs)).toBe(true)
    expect(action.delayMs).toBeGreaterThan(0)
    expect(action.delayMs).toBeLessThanOrEqual(maxMs)
  }

  // Infinity/NaN/negatif: backoff eksponensial biasa, bukan setTimeout(Infinity)
  // yang berperilaku seperti ~1 ms (hot fast-retry).
  assertRetry(cappedRecovery.onError(new ProviderError("rate_limit", "x", Infinity), 1), 1_000)
  assertRetry(cappedRecovery.onError(new ProviderError("rate_limit", "x", NaN), 2), 2_000)
  assertRetry(cappedRecovery.onError(new ProviderError("rate_limit", "x", -5000), 1), 1_000)
  // Nilai sangat besar di-cap ke plafon provider (bukan ditunggu apa adanya).
  const huge = cappedRecovery.onError(new ProviderError("rate_limit", "x", 3_600_000), 1)
  expect(huge).toEqual({ type: "retry", delayMs: LIMITS.RETRY_AFTER_MAX_MS })
  // Nilai wajar dipakai apa adanya sebagai FLOOR: jitter tidak boleh membuat
  // kita mencoba lagi lebih cepat daripada yang diminta provider.
  const ok = cappedRecovery.onError(new ProviderError("rate_limit", "x", 5000), 1)
  expect(ok.type).toBe("retry")
  if (ok.type === "retry") expect(ok.delayMs).toBeGreaterThanOrEqual(5000)
  // Backoff tetap berhingga dan tidak melebihi plafon anggaran.
  assertRetry(cappedRecovery.onError(new ProviderError("server", "boom"), 3), 4_000)
})

const echoTool = {
  name: "echoTool",
  description: "echo",
  parameters: {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: false,
  },
  execute: async (args: unknown) => `echo:${JSON.stringify(args)}`,
} as never

async function runWithBounds(extra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bounds-"))
  try {
    const provider = new FakeProvider([
      { events: [toolCall("echoTool", { a: 1 }), finish("tool_calls")] },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [echoTool],
      permissionMode: "allow-all",
      cwd: dir,
      ...extra,
    })
    const res = await session.run("kerjakan", {})
    return res.finalText ?? ""
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

test("F-09: maxSteps 0/negatif/Infinity → default aman, turn jalan", async () => {
  expect(await runWithBounds({ maxSteps: 0 })).toContain("selesai")
  expect(await runWithBounds({ maxSteps: -3 })).toContain("selesai")
  expect(await runWithBounds({ maxSteps: Infinity })).toContain("selesai")
})

// Batch 9 (B02): nilai default pagu iterasi di-pin — kernel tetap 50 (backstop
// library generik), host naik ke 200 (T-008 OBSERVATION.md). Bukan tautologi:
// perubahan diam-diam pada angka ini melipatgandakan anggaran runaway loop;
// sanitasi F-09 di atas hanya membuktikan fallback, bukan nilainya.
//
// KENAPA kini berbeda: sesi 17b6a5ff mencatat 4 dari 5 `turn.failed` adalah
// `exceeded 50 steps`. Host memakai eskalasi adaptif (src/policy/step-escalation.ts)
// dengan titik awal 200; kernel tetap 50 agar library generik tak ikut membengkak.
test("F-09b: DEFAULT_MAX_STEPS = 50 di kernel, 200 di host (T-008)", () => {
  expect(DEFAULT_MAX_STEPS).toBe(50)
  expect(LIMITS.DEFAULT_MAX_STEPS).toBe(200)
  // Cap sub-agent TERPISAH naik 50 → 100 → 600 (riset + persetujuan owner): naiknya
  // default sesi utama tidak boleh memperluas kewenangan delegasi secara diam-diam.
  expect(LIMITS.SUB_AGENT_MAX_STEPS).toBe(600)
})

test("F-09: timeoutMs NaN/negatif → default aman, turn jalan", async () => {
  expect(await runWithBounds({ timeoutMs: NaN })).toContain("selesai")
  expect(await runWithBounds({ timeoutMs: -100 })).toContain("selesai")
})

test("F-09: timeout di atas batas timer JS tidak berubah menjadi abort 1ms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bounds-timeout-"))
  const provider: ModelProvider = {
    id: "wait-for-abort",
    models: ["wait-for-abort"],
    async *stream(_request, signal): AsyncIterable<ProviderEvent> {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  }
  try {
    const session = await createMinicodeSession({
      provider,
      cwd: dir,
      timeoutMs: LIMITS.MAX_TIMER_DELAY_MS + 10_000,
    })
    const controller = new AbortController()
    const run = session.run("wait", { signal: controller.signal })
    setTimeout(() => controller.abort(new Error("caller stopped")), 30)
    let caught: unknown
    try {
      await run
    } catch (error) {
      caught = error
    }
    expect((caught as { kind?: string } | undefined)?.kind).toBe("aborted")
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("F-09: concurrency 0/negatif → default aman, hasil tool terdefinisi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bounds-"))
  try {
    const provider = new FakeProvider([
      { events: [toolCall("echoTool", { a: 1 }), finish("tool_calls")] },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [echoTool],
      permissionMode: "allow-all",
      cwd: dir,
      concurrency: 0,
    })
    const seen: unknown[] = []
    session.events.on("execution:completed", (e) => seen.push(e.execution.result))
    const res = await session.run("kerjakan", {})
    expect(res.finalText).toContain("selesai")
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeDefined()
    // sukses = tanpa flag error (isError opsional, hanya true saat gagal)
    expect((seen[0] as { isError?: boolean }).isError).not.toBe(true)
    expect(String((seen[0] as { content?: unknown }).content)).toContain('"a":1')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
