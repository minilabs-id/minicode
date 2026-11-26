// Test eskalasi jendela konteks pada jalur NYATA (createMinicodeSession).
//
// Properti keamanan yang dijaga:
// 1. Overflow konteks terverifikasi menaikkan jendela satu anak tangga.
// 2. Rate limit / auth / server TIDAK menaikkan jendela (diagnosis salah =
//    membakar request lebih banyak pada kondisi yang butuh berhenti).
// 3. Nilai tak pernah melebihi batas atas absolut.
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore"
import { FakeProvider, finish, text } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import {
  CONTEXT_WINDOW_ESCALATION_CEILING,
  CONTEXT_WINDOW_LADDER,
} from "../src/policy/context-escalation.ts"

type Escalation = { model: string; fromTokens: number; toTokens: number; observedTokens: number }

function makeSession(windowTokens: number, steps: ConstructorParameters<typeof FakeProvider>[0]) {
  const p = new FakeProvider(steps)
  const escalations: Escalation[] = []
  const cwd = mkdtempSync(join(tmpdir(), "mc-esc-"))
  const promise = createMinicodeSession({
    provider: p,
    cwd,
    contextWindowTokens: windowTokens,
    onContextWindowEscalated: (info) => escalations.push(info),
  })
  return { p, escalations, promise }
}

describe("eskalasi jendela: dipicu hanya oleh overflow konteks", () => {
  test("konteks kepanjangan → jendela naik satu anak tangga", async () => {
    // `finish("length")` adalah sinyal kehabisan output; konteks juga penuh
    // karena prompt-nya besar. Strategi recovery akan menempuh jalur konteks.
    const { escalations, promise } = makeSession(131_072, [
      { events: [finish("length")] },
      { events: [text("pulih"), finish("stop")] },
      { events: [text("pulih"), finish("stop")] },
    ])
    const s = await promise
    await s.run(`halo ${"k".repeat(600_000)}`, {}).catch(() => undefined)
    // Overflow nyata terjadi → eskalasi WAJIB tercatat (bukan sekadar "tidak
    // crash"): prompt sebesar ini pasti melampaui jendela awal.
    expect(escalations.length).toBeGreaterThan(0)
    // Setiap eskalasi: naik, tetap di tangga resmi, tidak melebihi batas atas.
    // Retry boleh menghasilkan lebih dari satu kejadian — itu wajar selama
    // setiap langkah tetap bounded.
    for (const e of escalations) {
      expect(e.toTokens).toBeGreaterThan(e.fromTokens)
      expect(CONTEXT_WINDOW_LADDER as readonly number[]).toContain(e.toTokens)
      expect(e.toTokens).toBeLessThanOrEqual(CONTEXT_WINDOW_ESCALATION_CEILING)
    }
    // Eskalasi pertama naik DARI jendela awal sesi (131.072 di fixture ini).
    expect(escalations[0]!.fromTokens).toBe(131_072)
  }, 20000)

  test("rate limit (429) TIDAK menaikkan jendela", async () => {
    const { escalations, promise } = makeSession(131_072, [
      { error: new ProviderError("rate_limit", "429 too many requests") },
      { error: new ProviderError("rate_limit", "429 too many requests") },
      { error: new ProviderError("rate_limit", "429 too many requests") },
    ])
    const s = await promise
    await s.run("halo", {}).catch(() => undefined)
    expect(escalations).toHaveLength(0)
  }, 20000)

  test("kuota habis (402) TIDAK menaikkan jendela", async () => {
    const { escalations, promise } = makeSession(131_072, [
      { error: new ProviderError("unknown", "402 payment required") },
      { error: new ProviderError("unknown", "402 payment required") },
    ])
    const s = await promise
    await s.run("halo", {}).catch(() => undefined)
    expect(escalations).toHaveLength(0)
  }, 20000)

  test("auth gagal (401) TIDAK menaikkan jendela", async () => {
    const { escalations, promise } = makeSession(131_072, [
      { error: new ProviderError("auth", "401 unauthorized") },
    ])
    const s = await promise
    await s.run("halo", {}).catch(() => undefined)
    expect(escalations).toHaveLength(0)
  }, 20000)

  test("400 overflow jauh di bawah config 1M melakukan clamp turun (bukan naik 2M)", async () => {
    const { toolCall } = await import("#minicore/test/fakes.ts")
    const p = new FakeProvider([
      { events: [toolCall("bigread", {}, "c1"), finish("tool_calls")] },
      { error: new ProviderError("invalid_request", "prompt is too long: max 64k") },
      { events: [text("pulih"), finish("stop")] },
    ])
    const escalations: Escalation[] = []
    const clamped: Escalation[] = []
    const s = await createMinicodeSession({
      provider: p,
      cwd: mkdtempSync(join(tmpdir(), "mc-clamp-")),
      contextWindowTokens: 1_000_000,
      keepRecentTurns: 0,
      tools: [
        {
          name: "bigread",
          description: "read large chunk",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => "z".repeat(240_000),
        },
      ],
      onContextWindowEscalated: (info) => escalations.push(info),
      onContextWindowClamped: (info) => clamped.push(info),
    })
    const res = await s.run("audit repo", {})
    expect(escalations).toHaveLength(0)
    expect(clamped.length).toBeGreaterThan(0)
    expect(clamped[0]!.fromTokens).toBe(1_000_000)
    expect(clamped[0]!.toTokens).toBeLessThan(70_000)
    expect(clamped[0]!.toTokens).toBeGreaterThanOrEqual(8_192)
    expect(res.finalText).toBe("pulih")
  }, 20000)
})
