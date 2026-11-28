import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContextStore } from "#minicore/core/history.ts"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { createSession } from "#minicore/core/session.ts"
import type { Tool } from "#minicore/core/tool.ts"
import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import {
  hasFlag,
  parseRuntimeNumericFlags,
  promptFromArgs,
  unknownFlagsBeforePrompt,
} from "../cli/args.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { LIMITS } from "../src/constants.ts"
import { createActivityDeadline, setSafeTimeout } from "../src/lib/liveness-clock.ts"
import { createAutonomousLoopController } from "../src/policy/autonomous-loop.ts"
import { createLlmCompaction } from "../src/policy/compaction.ts"
import {
  AUTONOMOUS_OUTAGE_MAX_WAIT_MS,
  isPermanentQuotaMessage,
  planAutonomousOutageCooldown,
} from "../src/policy/recovery-budget.ts"
import { createContentStore } from "../src/presentation/store.ts"
import { withStreamGuards } from "../src/providers/guards.ts"
import { acquireSessionWriter, isProcessAlive, SessionBusyError } from "../src/session/authority.ts"
import {
  beginSessionTurn,
  listSessionTurns,
  purgeExpired,
  saveSession,
  settleSessionTurn,
} from "../src/session/persistence.ts"
import { buildRuntimeStateHeader } from "../src/session/runtime-header.ts"
import { AUTONOMOUS_BUILD_TOOL_NAMES } from "../src/task/autonomous-build-policy.ts"
import { AutonomousExecutionContext } from "../src/task/autonomous-context.ts"
import { AUTONOMOUS_TOOL_NAMES } from "../src/task/autonomous-policy.ts"
import { createProductionScheduler, schedulerGateFor } from "../src/task/production-scheduler.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { createPeriodicTrigger, TriggerCoordinator } from "../src/task/trigger.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

isolateHomeForTests()

const tempDirs: string[] = []
function makeTempDir(prefix = "minicode-longrun-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  resetTaskStoreHandles()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

describe("Long-running autonomous runtime invariants", () => {
  test("createActivityDeadline resets on touch(), suspends during cooldown, and setSafeTimeout handles >24.85d delays", async () => {
    const d = createActivityDeadline({
      inactivityTimeoutMs: 80,
      buildInactivityError: (ms) => new Error(`inactive ${ms}`),
    })
    await Bun.sleep(45)
    d.touch("token")
    await Bun.sleep(45)
    expect(d.signal.aborted).toBe(false)

    // Suspend pause prevents abort while waiting
    d.suspendInactivity()
    await Bun.sleep(95)
    expect(d.signal.aborted).toBe(false)
    d.resumeInactivity()
    await Bun.sleep(40)
    expect(d.signal.aborted).toBe(false)
    await Bun.sleep(60)
    expect(d.signal.aborted).toBe(true)
    expect((d.signal.reason as Error)?.message).toContain("inactive 80")

    // setSafeTimeout > MAX_TIMER_DELAY_MS does not fire at 1ms clamp
    let fired = false
    const cancel = setSafeTimeout(() => {
      fired = true
    }, LIMITS.MAX_TIMER_DELAY_MS + 5_000)
    await Bun.sleep(25)
    expect(fired).toBe(false)
    cancel()
  })

  test("kernel idleTimeoutMs + timeoutMs:Infinity survives multi-step active work > idleTimeoutMs", async () => {
    const noopTool: Tool = {
      name: "noop_tool",
      description: "slow active step tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        await Bun.sleep(55)
        return { content: "ok" }
      },
    }
    let turnStep = 0
    const provider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream() {
        turnStep++
        await Bun.sleep(25)
        if (turnStep <= 3) {
          yield { type: "tool_call", id: `c${turnStep}`, name: "noop_tool", args: {} }
          yield { type: "finish", reason: "tool_calls" }
        } else {
          yield { type: "text", text: "finished all steps" }
          yield { type: "finish", reason: "stop" }
        }
      },
    }
    const sess = createSession({
      provider,
      permissions: { check: async () => "allow" },
      tools: [noopTool],
      timeoutMs: Number.POSITIVE_INFINITY,
      idleTimeoutMs: 120,
    })
    // 3 * (25 + 55) + 25 = ~265ms > 120ms idleTimeoutMs, stays alive because each step resets activity!
    const res = await sess.run("multi-step task")
    expect(res.finalText).toBe("finished all steps")
    expect(res.usage.steps).toBe(3)

    // True hang with no events aborts at idleTimeoutMs
    const hungProvider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream(_req, signal) {
        await new Promise((_res, rej) => {
          signal.addEventListener("abort", () => rej(signal.reason), { once: true })
        })
      },
    }
    const hungSess = createSession({
      provider: hungProvider,
      permissions: { check: async () => "allow" },
      tools: [],
      timeoutMs: Number.POSITIVE_INFINITY,
      idleTimeoutMs: 70,
    })
    await expect(hungSess.run("hang forever")).rejects.toThrow(/inactive/i)
  })

  test("createMinicodeSession preserves timeoutMs:Infinity when explicitly unbounded", async () => {
    let calls = 0
    const provider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream() {
        calls++
        await Bun.sleep(40)
        yield { type: "text", text: `turn ${calls}` }
        yield { type: "finish", reason: "stop" }
      },
    }
    const dir = makeTempDir()
    const s = await createMinicodeSession({
      provider,
      tools: [],
      cwd: dir,
      timeoutMs: Number.POSITIVE_INFINITY,
      idleTimeoutMs: 250,
    })
    const out = await s.run("unbounded wall timeout")
    expect(out.finalText).toBe("turn 1")
  })

  test("withStreamGuards keeps active chunked stream alive and aborts stalled stream on idleTimeoutMs", async () => {
    const activeProvider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream() {
        for (let i = 0; i < 4; i++) {
          await Bun.sleep(30)
          yield { type: "text", text: `${i}` }
        }
        yield { type: "finish", reason: "stop" }
      },
    }
    const guarded = withStreamGuards(activeProvider, {
      firstByteTimeoutMs: 80,
      idleTimeoutMs: 80,
    })
    let collected = ""
    for await (const ev of guarded.stream(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      if (ev.type === "text") collected += ev.text
    }
    expect(collected).toBe("0123")

    const stalledProvider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream(_req, signal) {
        yield { type: "text", text: "first" }
        await new Promise((_res, rej) => {
          signal.addEventListener("abort", () => rej(signal.reason), { once: true })
        })
      },
    }
    const stalledGuard = withStreamGuards(stalledProvider, {
      firstByteTimeoutMs: 50,
      idleTimeoutMs: 50,
    })
    const consume = async () => {
      for await (const _ev of stalledGuard.stream(
        { messages: [{ role: "user", content: "stall" }] },
        new AbortController().signal,
      )) {
      }
    }
    await expect(consume()).rejects.toThrow()
  })

  test("OpenAI-compat provider evaluates getApiKey per request and retries 1x via refreshApiKey on HTTP 401", async () => {
    let token = "expired-token"
    let refreshCalls = 0
    const seenAuth: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization") ?? ""
        seenAuth.push(auth)
        if (auth !== "Bearer fresh-token") {
          return new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        }
        const sse = [
          'data: {"choices":[{"delta":{"content":"oauth ok"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join("")
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      const provider = createOpenAICompatProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: ["gpt-test"],
        getApiKey: async () => token,
        refreshApiKey: async () => {
          refreshCalls++
          token = "fresh-token"
          return token
        },
      })
      let out = ""
      for await (const ev of provider.stream(
        { messages: [{ role: "user", content: "ping" }] },
        new AbortController().signal,
      )) {
        if (ev.type === "text") out += ev.text
      }
      expect(out).toBe("oauth ok")
      expect(refreshCalls).toBe(1)
      expect(seenAuth).toEqual(["Bearer expired-token", "Bearer fresh-token"])
    } finally {
      server.stop(true)
    }
  })

  test("Tier-2 outage cooldown waits across hours and stops immediately on permanent quota", () => {
    const transient = planAutonomousOutageCooldown({
      failure: { category: "server", message: "503 Service Unavailable" },
      elapsedOutageMs: 3_600_000,
      cooldownAttempt: 3,
      hasPrompt: true,
      random: () => 0.5,
    })
    expect(transient.action).toBe("retry")

    const exhausted = planAutonomousOutageCooldown({
      failure: { category: "server" },
      elapsedOutageMs: AUTONOMOUS_OUTAGE_MAX_WAIT_MS,
      cooldownAttempt: 10,
      hasPrompt: true,
    })
    expect(exhausted).toEqual({ action: "stop", reason: "budget-exhausted" })

    expect(isPermanentQuotaMessage("Insufficient quota: please add billing credits")).toBe(true)
    const permQuota = planAutonomousOutageCooldown({
      failure: { category: "rate_limit", message: "insufficient_quota: plan expired" },
      elapsedOutageMs: 1_000,
      cooldownAttempt: 0,
      hasPrompt: true,
    })
    expect(permQuota).toEqual({ action: "stop", reason: "not-transient" })
  })

  test("compaction thrash throws during cooldown then re-arms after 3 completed turns", async () => {
    let ctl: { noteTurnCompleted(): void; resetThrash(): void } | undefined
    let llmSummaryCount = 0
    const mockProvider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream() {
        llmSummaryCount++
        // Calls 1 & 2 produce valid shorter summary (<10% prefix shrink) to trip thrash cooldown; call 3 shrinks cleanly
        const text = llmSummaryCount <= 2 ? "S".repeat(110) : "S".repeat(20)
        yield { type: "text", text }
        yield { type: "finish", reason: "stop" }
      },
    }
    const dir = makeTempDir()
    const strategy = createLlmCompaction({
      provider: mockProvider,
      cwd: dir,
      onController: (c) => {
        ctl = c
      },
    })
    const makeStore = () => {
      const store = new ContextStore()
      store.append({ role: "user", content: "P".repeat(120) })
      for (let i = 0; i < 5; i++) {
        store.append({ role: "user", content: `u${i}` })
        store.append({ role: "assistant", content: `a${i}` })
      }
      return store
    }
    const sig = () => new AbortController().signal

    await strategy.compactAsync!(makeStore(), { keepRecentTurns: 5 }, sig())
    await strategy.compactAsync!(makeStore(), { keepRecentTurns: 5 }, sig())
    // Immediate 3rd call must still throw during cooldown
    await expect(
      strategy.compactAsync!(makeStore(), { keepRecentTurns: 5 }, sig()),
    ).rejects.toThrow(/disabled after thrash/)
    expect(llmSummaryCount).toBe(2)

    // Completing 3 turns re-arms LLM compaction on the same strategy
    ctl?.noteTurnCompleted()
    ctl?.noteTurnCompleted()
    ctl?.noteTurnCompleted()
    const rearmedOut = await strategy.compactAsync!(makeStore(), { keepRecentTurns: 5 }, sig())
    expect(llmSummaryCount).toBe(3)
    expect(rearmedOut.length).toBeGreaterThan(0)
  })

  test("loop allows >3 budget compactions across progressing steps in a single turn", async () => {
    const stepTool: Tool = {
      name: "read_big",
      description: "returns big chunk",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "R".repeat(500) }
      },
    }
    let step = 0
    const provider: ModelProvider = {
      id: "fake",
      models: ["fake-1"],
      async *stream() {
        step++
        if (step <= 5) {
          yield { type: "tool_call", id: `t${step}`, name: "read_big", args: {} }
          yield { type: "finish", reason: "tool_calls" }
        } else {
          yield { type: "text", text: "all steps compacted" }
          yield { type: "finish", reason: "stop" }
        }
      },
    }
    let compactionCalls = 0
    const sess = createSession({
      provider,
      permissions: { check: async () => "allow" },
      tools: [stepTool],
      budget: {
        evaluate: () => "medium",
        shouldCompact: () => true,
      },
      compaction: {
        kind: "test",
        compact(store) {
          compactionCalls++
          const msgs = store.messages
          return msgs.length > 2 ? [msgs[0]!, ...msgs.slice(-2)] : msgs
        },
      },
    })
    const res = await sess.run("go through 5 big steps")
    expect(res.finalText).toBe("all steps compacted")
    expect(compactionCalls).toBeGreaterThan(3)
  })

  test("WorkMode restricts autonomous context: DISCUSS stays read-only, EXECUTE allows workspace edits/bash while jailing external & human tools", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "a.txt"), "hello", "utf8")
    const dummyTools = AUTONOMOUS_BUILD_TOOL_NAMES.map((name) => ({ name }))
    const fakeSessionFactory = async (spec: {
      permissionHandler: { check: (...args: never[]) => unknown }
      permissionMode: string
    }) => ({
      async run() {
        return { finalText: spec.permissionMode, usage: { steps: 1 } }
      },
      abort() {},
    })

    // DISCUSS initializes with readonly permissionMode
    const discussCtx = new AutonomousExecutionContext({
      parentSessionId: "p1",
      taskId: "t1",
      taskTitle: "read",
      instruction: "inspect",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: dir,
      workMode: "DISCUSS",
      tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
      sessionFactory: fakeSessionFactory as never,
    })
    await discussCtx.initialize()
    expect(discussCtx.getSession()).not.toBeNull()

    // Tool outside BUILD matrix is refused even in EXECUTE
    const badCtx = new AutonomousExecutionContext({
      parentSessionId: "p1",
      taskId: "t2",
      taskTitle: "bad",
      instruction: "bad",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: dir,
      workMode: "EXECUTE",
      tools: [{ name: "ask_user" }],
      sessionFactory: fakeSessionFactory as never,
    })
    await expect(badCtx.initialize()).rejects.toThrow(/outside autonomous BUILD scope/)

    // EXECUTE permits inside-workspace writes and bash, denies outside jail and git_push
    let capturedHandler: {
      check(call: { name: string; args?: unknown }): Promise<"allow" | "deny">
    } | null = null
    const buildCtx = new AutonomousExecutionContext({
      parentSessionId: "p1",
      taskId: "t3",
      taskTitle: "build",
      instruction: "edit and test",
      execGeneration: 1,
      sessionIncarnation: 1,
      cwd: dir,
      workMode: "EXECUTE",
      idleTimeoutMs: 5_000,
      tools: dummyTools,
      sessionFactory: async (spec) => {
        expect(spec.permissionMode).toBe("auto")
        expect(spec.timeoutMs).toBe(Number.POSITIVE_INFINITY)
        expect(spec.idleTimeoutMs).toBe(5_000)
        capturedHandler = spec.permissionHandler
        return {
          async run() {
            return { finalText: "done", usage: { steps: 1 } }
          },
          abort() {},
        }
      },
    })
    await buildCtx.initialize()
    expect(
      await capturedHandler!.check({
        name: "write_file",
        args: { path: "inside.txt", content: "ok" },
      }),
    ).toBe("allow")
    expect(await capturedHandler!.check({ name: "bash", args: { cmd: "echo ok" } })).toBe("allow")
    expect(
      await capturedHandler!.check({
        name: "write_file",
        args: { path: "../escape.txt", content: "bad" },
      }),
    ).toBe("deny")
    expect(await capturedHandler!.check({ name: "git_push", args: {} })).toBe("deny")
    expect(await capturedHandler!.check({ name: "ask_user", args: { question: "?" } })).toBe("deny")
  })

  test("ProductionScheduler verifier transitions verified task IN_PROGRESS -> COMPLETED and supports periodic pump", async () => {
    const dir = makeTempDir()
    const sid = "sessverif"
    const store = new TaskStore(dir, { authority: "SCHEDULER" })
    const t = store.createTask(sid, {
      title: "Implement feature",
      status: "PENDING",
      order: 1,
      provenance: { origin: "model", source: "todo_write" },
    })
    const inc = store.getSessionIncarnation(sid)
    let verifyCalls = 0
    const handle = await createProductionScheduler(schedulerGateFor(true), () => ({
      sessionId: sid,
      cwd: dir,
      store,
      instruction: "Build and test",
      maxDrainCycles: 4,
      bindingFor: (taskId) => ({
        parentSessionId: sid,
        taskId,
        execGeneration: store.getExecutionLineage(sid, taskId)?.execGeneration ?? 0,
        sessionIncarnation: inc,
      }),
      verifier: async () => {
        verifyCalls++
        return { ok: true, verdict: "passed", summary: "tests green" }
      },
      adapter: {
        store,
        tools: AUTONOMOUS_TOOL_NAMES.map((name) => ({ name })),
        cwdFor: () => dir,
        sessionFactory: async () => ({
          async run() {
            return { finalText: "implemented", usage: { steps: 1 } }
          },
          abort() {},
        }),
      },
    }))
    try {
      await handle.fire("manual")
      const after = store.getTask(sid, t.id)!
      expect(verifyCalls).toBe(1)
      expect(after.status).toBe("COMPLETED")
      expect(after.verification?.verdict).toBe("passed")

      // Periodic trigger starts & stops cleanly
      const trig = new TriggerCoordinator({ runCycle: async () => null, maxDrainCycles: 5 })
      const p = createPeriodicTrigger({ intervalMs: 100, trigger: trig })
      p.start()
      expect(p.isRunning()).toBe(true)
      p.stop()
      expect(p.isRunning()).toBe(false)
    } finally {
      await handle.stop("shutdown")
    }
  })

  test("createAutonomousLoopController enforces mode-restriction, rolling hourly spend cap, stagnation breaker, and epoch prompt", () => {
    const discussLoop = createAutonomousLoopController({ workMode: "DISCUSS" })
    expect(discussLoop.canStartNextEpoch()).toMatchObject({
      allow: false,
      reason: "mode-restricted",
    })

    const loop = createAutonomousLoopController({
      workMode: "EXECUTE",
      maxCostPerHourUsd: 10,
      maxConsecutiveNoProgress: 5,
    })
    // 4 no-progress epochs then 1 progressed resets streak
    for (let i = 0; i < 4; i++) {
      expect(loop.recordEpoch({ progressed: false, costUsd: 1 }, 1_000 + i).stopped).toBe(false)
    }
    expect(
      loop.recordEpoch({ progressed: true, costUsd: 2, milestone: "fixed auth" }, 2_000).stopped,
    ).toBe(false)
    expect(loop.hourlySpend(2_000)).toBe(6)
    // Old hourly samples expire after > 1 hour
    expect(loop.hourlySpend(2_000 + 3_600_001)).toBe(0)

    // Prompt carries milestone & failed approaches cleanly
    loop.recordEpoch({ progressed: false, failedApproach: "avoid legacy adapter" }, 10_000_000)
    const prompt = loop.formatEpochPrompt("Finish autonomy")
    expect(prompt).toContain("fixed auth")
    expect(prompt).toContain("avoid legacy adapter")

    const header = buildRuntimeStateHeader({
      turnCount: 3,
      goalSummary: "Ship feature X",
      completedMilestones: ["m1", "m2"],
      failedApproaches: ["f1"],
    })
    expect(header).toContain("goal_summary: Ship feature X")
    expect(header).toContain("completed_milestones: [m1 ; m2]")
    expect(header).toContain("failed_approaches: [f1]")

    // 5 consecutive no-progress epochs trip circuit breaker
    for (let i = 0; i < 4; i++) {
      const r = loop.recordEpoch({ progressed: false }, 10_000_100 + i)
      if (i < 3) expect(r.stopped).toBe(false)
      else {
        expect(r.stopped).toBe(true)
        expect(r.reason).toBe("no-progress-circuit-breaker")
      }
    }
  })

  test("CLI arg parser recognizes autonomous flags and preserves prompt boundaries", () => {
    const argv = [
      "--autonomous",
      "--work-mode",
      "BUILD",
      "--wall-timeout",
      "7200000",
      "--max-epochs",
      "0",
      "--max-cost-hour",
      "2.5",
      "--takeover",
      "build the project",
    ]
    expect(unknownFlagsBeforePrompt(argv)).toEqual([])
    expect(hasFlag(argv, "--autonomous")).toBe(true)
    expect(hasFlag(argv, "--takeover")).toBe(true)
    expect(promptFromArgs(argv)).toBe("build the project")
    const warns: string[] = []
    const map = new Map<string, string>([
      ["--wall-timeout", "7200000"],
      ["--max-epochs", "0"],
      ["--max-cost-hour", "2.5"],
    ])
    const nums = parseRuntimeNumericFlags(
      (k) => map.get(k),
      (m) => warns.push(m),
    )
    expect(warns).toEqual([])
    expect(nums.wallTimeoutMs).toBe(7_200_000)
    expect(nums.maxEpochs).toBe(0)
    expect(nums.maxCostPerHour).toBe(2.5)
  })

  test("Dead-PID --takeover reclaims orphaned lease while refusing default concurrent writer", async () => {
    const dir = makeTempDir()
    const sid = "sessdead"
    // Open workspace TaskStore handle first so `.minicode` exists and sessions.db + tasks.db share local scope
    const store = new TaskStore(dir)
    const inc = store.getSessionIncarnation(sid)
    await saveSession(sid, dir, "sys", [{ role: "user", content: "hi" }], {})
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", "process.exit(0)"],
      stdout: "ignore",
      stderr: "ignore",
    })
    await proc.exited
    const deadPid = proc.pid
    expect(isProcessAlive(deadPid)).toBe(false)
    const future = Date.now() + 300_000
    const { handle: taskHandle } = await import("../src/task/db/schema.ts")
    taskHandle(dir)
      .prepare(
        `INSERT INTO session_authority (session_id, incarnation, owner_token, owner_pid, acquired_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sid, inc, "dead-token-1", deadPid, Date.now(), future)

    // Without takeover -> refused with holderAlive === false hint
    const refused = acquireSessionWriter({ sessionId: sid, cwd: dir, bootId: "b2" })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toBeInstanceOf(SessionBusyError)
      expect(refused.error.holderAlive).toBe(false)
      expect(refused.error.message).toContain("--takeover")
    }

    // With allowDeadPidTakeover -> reclaimed cleanly
    const reclaimed = acquireSessionWriter({
      sessionId: sid,
      cwd: dir,
      bootId: "b2",
      allowDeadPidTakeover: true,
    })
    expect(reclaimed.ok).toBe(true)
    if (reclaimed.ok) {
      expect(reclaimed.admission.tookOver).toBe(true)
    }
  })

  test("turn_ledger prunes old settled before_messages while keeping latest 5, and ContentStore bounds dead keys", async () => {
    const dir = makeTempDir()
    const sid = "sessprune"
    const adm = acquireSessionWriter({ sessionId: sid, cwd: dir, bootId: "b1" })
    expect(adm.ok).toBe(true)
    const epoch = adm.ok ? adm.admission.epoch : 1
    await saveSession(
      sid,
      dir,
      "sys",
      [{ role: "user", content: "hi" }],
      {},
      { expectedEpoch: epoch },
    )
    for (let i = 1; i <= 7; i++) {
      const rec = beginSessionTurn(
        sid,
        {
          runId: `r${i}`,
          prompt: `p${i}`,
          beforeMessages: [{ role: "user", content: `big-${i}` }],
          beforeEventSeq: 0,
        },
        dir,
        { expectedEpoch: epoch },
      )
      settleSessionTurn(sid, rec.ordinal, "COMPLETED", null, dir, { expectedEpoch: epoch })
    }
    const turns = listSessionTurns(sid, dir)
    expect(turns).toHaveLength(7)
    expect(turns[0]!.beforeMessages).toEqual([])
    expect(turns[1]!.beforeMessages).toEqual([])
    for (let i = 2; i < 7; i++) {
      expect(turns[i]!.beforeMessages.length).toBe(1)
    }

    // Direct purgeExpired still removes expired sessions
    const db = new Database(join(dir, ".minicode", "sessions.db"))
    try {
      expect(purgeExpired(db, Date.now())).toBe(0)
    } finally {
      db.close()
    }

    // ContentStore dead keys bounded at MAX_DEAD_REFS = 16_384
    const cs = createContentStore()
    for (let i = 0; i < 16_450; i++) {
      cs.markDead({ toolCallId: `tc-${i}`, idx: 0, kind: "output" })
    }
    expect(cs.stats().dead).toBeLessThanOrEqual(16_384)
  })
})
