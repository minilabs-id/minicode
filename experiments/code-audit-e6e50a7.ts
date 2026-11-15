// Audit probes: no network or filesystem mutations. Assertions characterize
// current defects; these are evidence probes, not passing regression tests.
import { strict as assert } from "node:assert"
import { mock } from "bun:test"
import { createEventBus, createToolRegistry } from "#minicore"
import { parallelExecutor } from "../src/policy/executor.ts"
import { loadTokenizer } from "../src/policy/tokenizer-registry.ts"
import {
  createDecoderState,
  decodeKeysStream,
  flushLoneEsc,
} from "../src/ui/input/prompt-engine.ts"

const observations: Record<string, unknown> = {}
const encoder = new TextEncoder()
const state = createDecoderState()
assert.equal(decodeKeysStream(encoder.encode("\x1b[\x03"), state).length, 0)
assert.equal(decodeKeysStream(encoder.encode("hello\x1b\x04"), state).length, 0)
assert.equal(flushLoneEsc(state).length, 0)
observations.malformedCsi = { emittedKeys: 0, retainedBytes: state.pending.length }
const modified = decodeKeysStream(encoder.encode("\x1b[1;5A"), createDecoderState())
assert.equal(modified[0]?.key.type, "esc")
observations.ctrlUp = modified[0]?.key.type

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
for (const kind of ["read", "keyed-write", "mixed", "unkeyed-write"] as const) {
  const started = deferred()
  const released = deferred()
  const name = kind === "read" ? "read_file" : kind === "unkeyed-write" ? "bash" : "write_file"
  const tools = [{
    name,
    description: "in-memory audit tool",
    parameters: { type: "object" as const, additionalProperties: true },
    async execute() { started.resolve(); await released.promise; return "ok" },
  }]
  const calls = [{ id: "a", name, args: { path: "audit-placeholder.txt" } }]
  if (kind === "mixed") calls.push({ id: "b", name: "read_file", args: { path: "audit-placeholder.txt" } })
  const controller = new AbortController()
  let settled = false
  const result = parallelExecutor().execute(calls, {
    registry: createToolRegistry(tools),
    permissions: { check: async () => "allow" },
    events: createEventBus(),
    signal: controller.signal,
    state: { history: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 1000,
    cwd: process.cwd(),
  }).then(() => { settled = true }, () => { settled = true })
  await started.promise
  controller.abort()
  await new Promise((r) => setTimeout(r, 25))
  observations[`abort:${kind}`] = { settledBeforeToolRelease: settled }
  assert.equal(settled, kind === "unkeyed-write")
  released.resolve()
  await result
}

const originalFetch = globalThis.fetch
const originalEnabled = process.env.MINICODE_TOKENIZERS
let fetchCalls = 0
try {
  process.env.MINICODE_TOKENIZERS = "0"
  globalThis.fetch = (async () => { fetchCalls++; return new Response("", { status: 404 }) }) as unknown as typeof fetch
  await loadTokenizer("qwen-audit-model")
  assert.equal(fetchCalls, 1)
  observations.tokenizerDisabled = { fetchCalls }
} finally {
  globalThis.fetch = originalFetch
  if (originalEnabled === undefined) delete process.env.MINICODE_TOKENIZERS
  else process.env.MINICODE_TOKENIZERS = originalEnabled
}

// Isolate global/local allowlist IO; production permission and session logic remain real.
mock.module("../src/policy/allowlist.ts", () => ({
  loadAllowlist: async () => ({ allowed: [] }),
  matchAllowlist: () => false,
  saveAllowlist: async () => { throw new Error("unexpected allowlist write") },
}))
const { createMinicodeSession } = await import("../src/app/session.ts")
const { FakeProvider, toolCall, finish, text } = await import("../vendor/minicore/test/fakes.ts")
for (const axis of ["work-mode", "permission-mode"] as const) {
  let revoke = () => {}
  let executions = 0
  const session = await createMinicodeSession({
    provider: new FakeProvider([
      { events: [toolCall("write_file", { path: "audit-placeholder.txt" }), finish("tool_calls")] },
      { events: [text("done"), finish("stop")] },
    ]),
    tools: [{
      name: "write_file", description: "in-memory effect counter",
      parameters: { type: "object", additionalProperties: true },
      async execute() { executions++; return "ok" },
    }],
    cwd: process.cwd(),
    workMode: "EXECUTE",
    permissionMode: "auto",
    noProgress: false,
    onWorkMode: (control) => { if (axis === "work-mode") revoke = () => control.setWorkMode("DISCUSS") },
    onPermissions: (control) => { if (axis === "permission-mode") revoke = () => control.setMode("readonly") },
    beforeToolEffect: async () => { revoke() },
  })
  await session.run("probe permission revocation")
  assert.equal(executions, 1)
  observations[`revocation:${axis}`] = { executionsAfterRevocation: executions }
}
const { contextBudgetFor } = await import("../src/policy/context-budget.ts")
const smallBudget = contextBudgetFor(8192)
assert.equal(smallBudget.outputReserve, 4096)
assert.ok(smallBudget.outputReserve > smallBudget.windowTokens * 0.4)
assert.ok(contextBudgetFor(64000).compactTrigger < contextBudgetFor(63999).compactTrigger)
observations.budget = {
  window8192: smallBudget,
  trigger63999: contextBudgetFor(63999).compactTrigger,
  trigger64000: contextBudgetFor(64000).compactTrigger,
}

// Harmless subprocess: prints cwd, with both possible directories in this workspace.
const { resolve } = await import("node:path")
const { createBashJobTools, onBackgroundJobFinished } = await import("../src/tools/bash.ts")
const jobs = createBashJobTools("code-audit-e6e50a7")
const jobFinished = deferred()
const detach = onBackgroundJobFinished(() => jobFinished.resolve())
const ctx = {
  cwd: resolve("docs"),
  signal: new AbortController().signal,
  state: { history: [], turnCount: 0, stepCount: 0 },
  emit: () => {},
}
const sandboxSetting = process.env.MINICODE_SANDBOX
try {
  delete process.env.MINICODE_SANDBOX
  const launch = String(await jobs.bash.execute({ cmd: process.platform === "win32" ? "cd" : "pwd", background: true }, ctx))
  const id = /background job started: (\S+)/.exec(launch)?.[1]
  assert.ok(id)
  await jobFinished.promise
  const output = String(await jobs.bashOutput.execute({ id }, ctx))
  assert.ok(output.includes(process.cwd()))
  assert.ok(!output.includes(ctx.cwd))
  observations.backgroundCwd = { expected: ctx.cwd, observed: output }
} finally {
  detach()
  if (sandboxSetting === undefined) delete process.env.MINICODE_SANDBOX
  else process.env.MINICODE_SANDBOX = sandboxSetting
}
const { createLlmCompaction } = await import("../src/policy/compaction.ts")
const { estimateMessages } = await import("#minicore/core/tokens.ts")
const { minicodeEstimator } = await import("../src/policy/context.ts")
const { LIMITS } = await import("../src/constants.ts")
const messages = [
  { role: "user", content: "old request" },
  { role: "assistant", content: "old answer" },
  { role: "user", content: "current request" },
  { role: "assistant", content: "", toolCalls: [{ id: "large", name: "read_file", args: {} }] },
  { role: "tool", toolCallId: "large", name: "read_file", content: "evidence ".repeat(12000) },
] as import("#minicore").Message[]
const strategy = createLlmCompaction({ getContextWindowTokens: () => 8192 })
const compacted = strategy.compact({ messages } as never, { keepRecentTurns: 1 })
const target = Math.floor(8192 * LIMITS.COMPACTION_SUMMARY_TARGET_RATIO)
const estimated = estimateMessages(compacted, minicodeEstimator)
assert.ok(estimated > target)
observations.compaction = { inputMessages: messages.length, outputMessages: compacted.length, target, estimated }
console.log(JSON.stringify(observations, null, 2))
