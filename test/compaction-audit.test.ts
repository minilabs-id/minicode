import { expect, test } from "bun:test"
import { estimateMessages } from "#minicore/core/tokens.ts"
import type { Message } from "#minicore/core/types.ts"
import { LIMITS } from "../src/constants.ts"
import {
  compactWithLlm,
  createLlmCompaction,
  mechanicalKeepResults,
} from "../src/policy/compaction.ts"
import { minicodeEstimator } from "../src/policy/context.ts"
import { syntheticSummaryMessage } from "../src/session/context-assembly.ts"

const windowTokens = 2000
const target = Math.floor(windowTokens * LIMITS.COMPACTION_SUMMARY_TARGET_RATIO)
const storeOf = (messages: Message[]) => ({ messages }) as never
const strategy = () => createLlmCompaction({ getContextWindowTokens: () => windowTokens })
const history = (): Message[] => [
  { role: "user", content: "Earlier request" },
  { role: "assistant", content: "Earlier answer" },
  { role: "user", content: `Keep all current instructions verbatim. ${"instruction ".repeat(90)}` },
  { role: "assistant", content: "", toolCalls: [{ id: "done", name: "read_file", args: {} }] },
  { role: "tool", toolCallId: "done", name: "read_file", content: "evidence ".repeat(12000) },
]

test("oversized latest turn is folded after older messages were removed", () => {
  const messages = history()
  const out = strategy().compact(storeOf(messages), { keepRecentTurns: 1 })
  expect(estimateMessages(out, minicodeEstimator)).toBeLessThanOrEqual(target)
  expect(out).toContain(messages[2]!)
  expect(out).not.toContain(messages[4]!)
})

test("pending tool batch and already received sibling result remain intact", () => {
  const messages = history()
  const pending: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", args: {} },
        { id: "b", name: "read_file", args: {} },
      ],
    },
    { role: "tool", toolCallId: "a", name: "read_file", content: "partial result" },
  ]
  messages.push(...pending)
  const out = strategy().compact(storeOf(messages), { keepRecentTurns: 1 })
  expect(out.slice(-2)).toEqual(pending)
  expect(out).toContain(messages[2]!)
  expect(estimateMessages(out, minicodeEstimator)).toBeLessThanOrEqual(target)
})

test("unshrinkable user instructions fail explicitly", () => {
  const messages: Message[] = [{ role: "user", content: "instruction ".repeat(12000) }]
  expect(() => strategy().compact(storeOf(messages), { keepRecentTurns: 1 })).toThrow(
    /cannot fit.*target/i,
  )
})

test("real Previous context user text is preserved without a token target", () => {
  const request: Message = {
    role: "user",
    content: `Previous context: ${"instruction ".repeat(12000)}`,
  }
  const out = createLlmCompaction().compact(storeOf([request]), { keepRecentTurns: 1 })
  expect(out).toEqual([request])
  expect(out[0]).toBe(request)
})

test("real Previous context user text cannot be fitted as a synthetic summary", () => {
  const request: Message = {
    role: "user",
    content: `Previous context: ${"instruction ".repeat(12000)}`,
  }
  expect(() => strategy().compact(storeOf([request]), { keepRecentTurns: 1 })).toThrow(
    /cannot fit.*target/i,
  )
  expect(request.content).toBe(`Previous context: ${"instruction ".repeat(12000)}`)
})

test("LLM active-turn compaction preserves a real Previous context request", async () => {
  const messages = history().slice(2)
  messages[0] = { role: "user", content: "Previous context: preserve this current request." }
  const out = await compactWithLlm(storeOf(messages), {
    keepRecentTurns: 1,
    provider: {
      id: "fake",
      models: ["m"],
      async *stream() {
        yield { type: "text" as const, text: "Summarized tool observations" }
        yield { type: "finish" as const, reason: "stop" as const }
      },
    } as never,
  })
  expect(out).toHaveLength(2)
  expect(out[1]).toBe(messages[0]!)
})

test.each([undefined, windowTokens])(
  "bounded/fitted summaries retain provenance (window %s)",
  async (window) => {
    const messages: Message[] = []
    for (let i = 0; i < 40; i++) {
      messages.push(
        { role: "user", content: `PROVENANCE_FACT ${"older instructions ".repeat(20)}` },
        { role: "assistant", content: "older answer ".repeat(30) },
      )
    }
    messages.push({ role: "user", content: "Current request" })
    if (window !== undefined) {
      messages.splice(0, messages.length, ...history())
      messages[0] = { role: "user", content: "PROVENANCE_FACT" }
    }
    const out = createLlmCompaction(
      window === undefined ? {} : { getContextWindowTokens: () => window },
    ).compact(storeOf(messages), { keepRecentTurns: 1 })
    expect(String(out[0]!.content)).toContain("incomplete")
    expect(String(out[0]!.content).length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    if (window !== undefined) {
      expect(estimateMessages(out, minicodeEstimator)).toBeLessThanOrEqual(target)
    }
    let prompt = ""
    const next = await compactWithLlm(
      storeOf([...out, { role: "user", content: "Next request" }]),
      {
        keepRecentTurns: 1,
        provider: {
          id: "fake",
          models: ["m"],
          async *stream(req: { messages: Message[] }) {
            prompt = String(req.messages[0]!.content)
            yield { type: "text" as const, text: "Fresh summary" }
            yield { type: "finish" as const, reason: "stop" as const }
          },
        } as never,
      },
    )
    // Structured user goal is carried forward; the old summary is not nested in the prompt.
    expect(prompt).toContain("PROVENANCE_FACT")
    expect(prompt).not.toContain("[mechanical summary;")
    expect(String(next[0]!.content)).toContain("Fresh summary")
  },
)

test("repeated mechanical compaction preserves goal and steering without nested summaries", () => {
  let messages: Message[] = [
    { role: "user", content: "Fix the remaining audit findings and verify the Windows harness." },
    { role: "assistant", content: "Investigating compaction." },
    { role: "user", content: "Keep the context aligned with our chat." },
  ]
  for (let cycle = 0; cycle < 8; cycle++) {
    messages = [...createLlmCompaction().compact(storeOf(messages), { keepRecentTurns: 1 })]
    const summary = String(messages[0]!.content)
    expect(summary).toContain("Fix the remaining audit findings")
    expect(summary.match(/Previous context/g)).toHaveLength(1)
    expect(summary).not.toContain("- user: Previous context")
    expect(summary.length).toBeLessThanOrEqual(LIMITS.COMPACTION_SUMMARY_MAX_CHARS)
    messages.push(
      { role: "assistant", content: `Verification ${cycle} pending.` },
      { role: "user", content: `Continue step ${cycle}.` },
    )
  }
  expect(String(messages[0]!.content)).toContain("Continue step 5.")
})

test("mechanical digest preserves correction chronology and the latest recorded todo", () => {
  const out = mechanicalKeepResults(
    storeOf([
      { role: "user", content: "Use English." },
      { role: "user", content: "Use Indonesian." },
      { role: "user", content: "Use English." },
      {
        role: "tool",
        name: "todo_write",
        toolCallId: "todo",
        content: "Done: DNS tests. Pending: full suite.",
      },
      { role: "user", content: "Continue." },
    ]),
    1,
  )
  const text = String(out[0]!.content)
  expect(text.indexOf("Use Indonesian.")).toBeLessThan(text.lastIndexOf("Use English."))
  expect(text).toContain("Done: DNS tests. Pending: full suite.")
  expect(out[out.length - 1]!.content).toBe("Continue.")
})

test("active-turn re-compaction retains earlier evidence and task state", () => {
  const messages: Message[] = [
    { role: "user", content: "Fix audit findings." },
    { role: "tool", name: "todo_read", toolCallId: "todo", content: "Pending: coverage gate." },
    { role: "tool", name: "bash", toolCallId: "test", content: "Network tests: 28 passed." },
  ]
  const first = createLlmCompaction().compact(storeOf(messages), { keepRecentTurns: 1 })
  const next = createLlmCompaction().compact(
    storeOf([
      ...first,
      { role: "tool", name: "bash", toolCallId: "check", content: "Typecheck passed." },
    ]),
    { keepRecentTurns: 1 },
  )
  expect(String(next[0]!.content)).toContain("Network tests: 28 passed.")
  expect(String(next[0]!.content)).toContain("Pending: coverage gate.")
  expect(String(next[0]!.content)).toContain("Typecheck passed.")
})

test("LLM findings survive a later mechanical fallback", async () => {
  const first = await compactWithLlm(
    storeOf([
      { role: "user", content: "Fix audit findings." },
      { role: "assistant", content: "Investigation." },
      { role: "user", content: "Continue." },
    ]),
    {
      keepRecentTurns: 1,
      provider: {
        id: "fake",
        models: ["m"],
        async *stream() {
          yield {
            type: "text" as const,
            text: "Confirmed: socket lookup pins the validated address.",
          }
          yield { type: "finish" as const, reason: "stop" as const }
        },
      } as never,
    },
  )
  const next = mechanicalKeepResults(storeOf([...first, { role: "user", content: "Next." }]), 1)
  expect(String(next[0]!.content)).toContain("socket lookup pins the validated address")
})

test("trusted projection summaries retain evidence without being treated as user goals", () => {
  const projection = syntheticSummaryMessage(
    "Confirmed: DNS tests passed. Pending: full suite.",
    20,
  )
  const next = mechanicalKeepResults(
    storeOf([
      projection,
      { role: "user", content: "Continue." },
      { role: "assistant", content: "Checking." },
      { role: "user", content: "Next." },
    ]),
    1,
  )
  expect(String(next[0]!.content)).toContain("Confirmed: DNS tests passed.")
  expect(String(next[0]!.content)).not.toContain("Previous context [0,20)")
})

test("brief continuation messages do not evict a substantive correction", () => {
  let messages: Message[] = [
    { role: "user", content: "Fix audit findings." },
    { role: "user", content: "Only change Windows code." },
    { role: "user", content: "Continue." },
  ]
  for (let i = 0; i < 8; i++) {
    messages = [
      ...mechanicalKeepResults(storeOf(messages), 1),
      { role: "user", content: "Continue." },
    ]
  }
  expect(String(messages[0]!.content)).toContain("Only change Windows code.")
})

test("oversized pending result fails without dropping its batch", () => {
  const messages = history()
  messages.push(
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", args: {} },
        { id: "b", name: "read_file", args: {} },
      ],
    },
    {
      role: "tool",
      toolCallId: "a",
      name: "read_file",
      content: "pending evidence ".repeat(12000),
    },
  )
  expect(() => strategy().compact(storeOf(messages), { keepRecentTurns: 1 })).toThrow(/cannot fit/i)
})

test("getTaskStateFallback memulihkan state todo saat pesan resume tanpa WeakSet provenance", async () => {
  const s = createLlmCompaction({
    getTaskStateFallback: () => "todos 1/2 · sekarang: periksa router\n  [x] t1 — audit loop",
  })
  const resumed = [
    // Simulasi pesan summary hasil load DB (tidak terdaftar di syntheticSummaries).
    { role: "user" as const, content: "Previous context (loaded from resume)" },
    { role: "assistant" as const, content: "Melanjutkan pemeriksaan." },
    { role: "user" as const, content: "Lanjutkan tahap 2." },
  ]
  const out = s.compact(storeOf(resumed), { keepRecentTurns: 1 })
  expect(String(out[0]!.content)).toContain("periksa router")
  expect(String(out[0]!.content)).toContain("t1 — audit loop")
})
