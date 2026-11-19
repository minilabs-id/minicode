import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as dns from "node:dns/promises"
import { existsSync } from "node:fs"
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError, ContextStore } from "#minicore"
import { applyContextWindowArg } from "../cli/context-command-run.ts"
import { createRagLayer } from "../src/app/rag-layer.ts"
import { createAggressiveBudgetPolicy, createMinicodeSession } from "../src/app/session.ts"
import { isPrivateHostWithDns } from "../src/lib/net.ts"
import { appendMemory, loadMemoryFiles, withMemLock } from "../src/memory/files.ts"
import {
  addMemory,
  deleteMemoryByQuery,
  getMemoryStats,
  reconcileMemoryStores,
  recordCandidateLesson,
  resolveEnvEmbeddingAuth,
  revokeByProvenance,
} from "../src/memory/vector.ts"
import { createLlmCompaction } from "../src/policy/compaction.ts"
import { createCalibratedEstimator } from "../src/policy/context.ts"
import {
  __resetLiveContextWindows,
  resolveContextWindow,
  setLiveContextWindow,
} from "../src/policy/context-window.ts"
import { applyMicrocompact } from "../src/policy/microcompact.ts"
import { acquireSessionWriter, renewSessionWriter } from "../src/session/authority.ts"
import { deriveSummaryFromCanonical } from "../src/session/context-projection.ts"
import { projectOpenWork } from "../src/session/open-work.ts"
import { openSessionDb, purgeExpired, saveSession } from "../src/session/persistence.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import { writeMemoryTool } from "../src/tools/memory.ts"
import {
  clearSubmittedResult,
  getSubmittedResult,
  submitResultTool,
} from "../src/tools/submit_result.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  getSubAgentProvider,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import {
  clearCompletionEvidence,
  extractCommittedTodoStatuses,
  reconcileCompletionEvidence,
  setCompletionEvidence,
  syncTodoViewsFromTaskStore,
  todoSession,
  todoWriteTool,
} from "../src/tools/todo.ts"

const createdDirs: string[] = []
const origHome = process.env.MINICODE_HOME
const origDeepseekKey = process.env.DEEPSEEK_API_KEY
const origOpenaiKey = process.env.OPENAI_API_KEY
const origAgentBase = process.env.AGENT_BASE_URL
const origAgentKey = process.env.AGENT_API_KEY

async function makeTempEnv(prefix: string): Promise<{ home: string; ws: string }> {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-home-`))
  const ws = await mkdtemp(join(tmpdir(), `${prefix}-ws-`))
  createdDirs.push(home, ws)
  process.env.MINICODE_HOME = home
  return { home, ws }
}

function fakeProvider(
  id: string,
  models: string[],
  onStream: (req: { model?: string }) => Promise<string> | string,
) {
  return {
    id,
    models,
    async *stream(req: { model?: string }) {
      const text = await onStream(req)
      yield { type: "text" as const, text }
      yield {
        type: "extension" as const,
        kind: "usage",
        data: { inputTokens: 40, outputTokens: 10 },
      }
      yield { type: "finish" as const, reason: "stop" as const }
    },
  }
}

afterEach(async () => {
  __resetLiveContextWindows()
  clearCompletionEvidence()
  clearSubAgentSessionFactory()
  resetTaskStoreHandles()
  todoSession.id = "default"
  todoSession.cwd = undefined
  if (origHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = origHome
  if (origDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = origDeepseekKey
  if (origOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = origOpenaiKey
  if (origAgentBase === undefined) delete process.env.AGENT_BASE_URL
  else process.env.AGENT_BASE_URL = origAgentBase
  if (origAgentKey === undefined) delete process.env.AGENT_API_KEY
  else process.env.AGENT_API_KEY = origAgentKey
  while (createdDirs.length > 0) {
    const d = createdDirs.pop()!
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

describe("Fase 1 & 2 regressions: context projection, budget, calibration, compaction, & config scope", () => {
  test("deriveSummaryFromCanonical ignores plain user prose starting with 'Previous context:'", () => {
    const res = deriveSummaryFromCanonical(
      [{ role: "user", content: "Previous context: my notes about the bug" }] as never,
      { keepRecentTurns: 1 },
    )
    expect(res).toBeNull()
    const match = deriveSummaryFromCanonical(
      [{ role: "user", content: "Previous context (summary)\n- user asked x" }] as never,
      { keepRecentTurns: 1 },
    )
    expect(match).toEqual({
      summaryText: "Previous context (summary)\n- user asked x",
      baseSeq: 1,
    })
  })

  test("createAggressiveBudgetPolicy scales >= 16k windows with contextBudgetFor and preserves < 16k test ratios", () => {
    const policy = createAggressiveBudgetPolicy(() => 4_000)
    // Synthetic small window (< 16k) preserves test 65%/85% ratios
    expect(policy.evaluate({ usedTokens: 6_500, limitTokens: 10_000 })).toBe("medium")
    expect(policy.evaluate({ usedTokens: 8_500, limitTokens: 10_000 })).toBe("high")
    // Real window (32_768 with 4_000 reserve) compacts BEFORE 32_768 - 4_000 = 28_768 admission limit
    expect(policy.evaluate({ usedTokens: 28_000, limitTokens: 32_768 })).toBe("high")
    expect(policy.shouldCompact("medium")).toBe(true)
  })

  test("inFlightSample preserves factor/effectiveTokens and pTotal subtracts output tokens", () => {
    const cal = createCalibratedEstimator()
    const first = cal.observeProviderUsage({
      localEstimatedTokens: 100,
      providerInputTokens: 0,
      providerOutputTokens: 250,
      providerTotalTokens: 450,
    })
    // Input actual = 450 - 250 = 200 (not 450)
    expect(first.lastProviderTokens).toBe(200)
    expect(first.factor).toBeCloseTo(2, 6)
    expect(first.effectiveTokens).toBe(200)
    // Spike with unchanged localEstimatedTokens (local === lastLocal && actual > lastLocal * 3) = in-flight sample
    const afterSpike = cal.observeProviderUsage({
      localEstimatedTokens: 100,
      providerInputTokens: 99_000,
    })
    // Raw observation is preserved (P1.4), while factor/drift/effectiveTokens stay protected from SSE inflation.
    expect(afterSpike.lastProviderTokens).toBe(99_000)
    expect(afterSpike.lastLocalEstimate).toBe(100)
    expect(afterSpike.factor).toBeCloseTo(2, 6)
    expect(afterSpike.driftTokens).toBe(100)
    expect(afterSpike.effectiveTokens).toBe(200)
    expect(cal.effectiveContextTokens(100)).toBe(200)
  })

  test("resolveContextWindow reads live wildcard provider::* and bare model without overriding exact pins", () => {
    setLiveContextWindow("p1", "*", 150_000)
    const cfg = {
      providers: [
        {
          id: "p1",
          baseUrl: "https://x.test/v1",
          apiKey: "k",
          models: ["bare-model", "pinned-model"],
          contextWindows: { "pinned-model": 64_000 },
        },
      ],
    }
    expect(resolveContextWindow(cfg, "bare-model").tokens).toBe(150_000)
    expect(resolveContextWindow(cfg, "p1::pinned-model").tokens).toBe(64_000)
  })

  test("applyContextWindowArg with allowLocalConfig does not duplicate global-only provider into local config", async () => {
    const { home, ws } = await makeTempEnv("ctx-scope")
    await mkdir(join(home, ".minicode"), { recursive: true })
    await writeFile(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          { id: "gprov", baseUrl: "https://g.test/v1", apiKey: "secret", models: ["m1"] },
        ],
      }),
    )
    const lines = await applyContextWindowArg("128k", {
      cwd: ws,
      allowLocalConfig: true,
      sessionId: "s",
      currentModel: "gprov::m1",
      usage: {} as never,
      skills: [],
      toolsCount: 0,
      setModelOverride: () => {},
      getContextTokens: () => 0,
      budgetState: () => "ok",
    })
    expect(lines.join("\n")).toContain("128K")
    expect(existsSync(join(ws, ".minicode", "config.json"))).toBe(false)
    const globalCfg = JSON.parse(await readFile(join(home, ".minicode", "config.json"), "utf8"))
    expect(globalCfg.providers[0].contextWindows).toEqual({ m1: 128_000 })
  })

  test("createPermissionHandler explicit allowLocalConfig=false writes Always to global allowlist", async () => {
    const { home, ws } = await makeTempEnv("perm-global")
    const repoRoot = join(import.meta.dir, "..")
    const permMod = JSON.stringify(join(repoRoot, "src", "policy", "permission.ts"))
    const script = `
      const { createPermissionHandler } = await import(${permMod})
      const h = createPermissionHandler({
        mode: "ask",
        root: ${JSON.stringify(ws)},
        allowLocalConfig: false,
        ask: async () => "always",
      })
      const res = await h.check(
        { id: "c1", name: "write_file", args: { path: "a.txt", content: "x" } },
        { signal: new AbortController().signal },
      )
      console.log(res)
    `
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, err).toBe(0)
    expect(out.trim()).toBe("allow")
    expect(existsSync(join(ws, ".minicode", "allowlist.json"))).toBe(false)
    expect(existsSync(join(home, ".minicode", "allowlist.json"))).toBe(true)
  })

  test("applyMicrocompact skips replacement when saving <= 0", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "tool", content: "ok", toolCallId: "t1", name: "bash" },
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ]
    const out = applyMicrocompact(msgs as never, {
      keepRecent: 1,
      budgetTokens: 20,
      estimateTokens: (text) => text.length,
    })
    expect(out.clearedCount).toBe(0)
    expect(out.messages[1]?.content).toBe("ok")
  })

  test("compactWithLlm respects canPersistMemory=false, dynamic getModel, and avoids adjacent user msgs", async () => {
    const { ws } = await makeTempEnv("compact-ro")
    const seenModels: string[] = []
    let activeModel = "model-a"
    const s = createLlmCompaction({
      cwd: ws,
      canPersistMemory: () => false,
      getModel: () => activeModel,
      provider: fakeProvider("mock", ["model-a", "model-b"], (req) => {
        seenModels.push(String(req.model))
        return "Ringkasan teknis"
      }),
    })
    const store = new ContextStore()
    store.appendAll([
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "ans 1" },
      { role: "user", content: "turn 2" },
    ] as never)
    const ac = new AbortController()
    const compacted = await s.compactAsync!(store, { keepRecentTurns: 1 }, ac.signal)
    expect(seenModels).toEqual(["model-a"])
    expect(existsSync(join(ws, ".minicode", "vector.db"))).toBe(false)
    expect(compacted.filter((m) => String(m.content).includes("Previous context")).length).toBe(1)
    activeModel = "model-b"
    const store2 = new ContextStore()
    store2.appendAll([
      ...compacted,
      { role: "assistant", content: "ans 2" },
      { role: "user", content: "turn 3" },
    ] as never)
    const compacted2 = await s.compactAsync!(store2, { keepRecentTurns: 1 }, ac.signal)
    expect(seenModels).toEqual(["model-a", "model-b"])
    expect(compacted2).toHaveLength(2)
    expect(compacted2.filter((m) => String(m.content).includes("Previous context")).length).toBe(1)
  })

  test("compactStore wraps failing sync fallback in AgentError('budget_exceeded') and does not double-emit", async () => {
    const { ws } = await makeTempEnv("compact-err")
    const compactedEvents: unknown[] = []
    const session = await createMinicodeSession({
      cwd: ws,
      tools: [],
      contextWindowTokens: 1_000,
      maxSteps: 1,
      compaction: {
        kind: "always-fail",
        compact() {
          throw new Error("cannot shrink protected turn")
        },
        async compactAsync() {
          throw new Error("llm unreachable")
        },
      },
      provider: fakeProvider("mock", ["m"], () => "ok"),
    })
    session.events.on("context:compacted", (e) => compactedEvents.push(e))
    // Force critical overflow on huge prompt
    let caught: unknown
    try {
      await session.run("x".repeat(20_000))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AgentError)
    expect((caught as AgentError).kind).toBe("budget_exceeded")
    // Only the llm-failed diagnostic event (never a phantom duplicate)
    expect(compactedEvents.length).toBeLessThanOrEqual(1)
  })

  test("isExplicitContextWindow prevents local overflow guard from escalating explicit window pins", async () => {
    const { ws } = await makeTempEnv("explicit-pin")
    let escalated = false
    const session = await createMinicodeSession({
      cwd: ws,
      tools: [],
      contextWindowTokens: 1_000,
      isExplicitContextWindow: () => true,
      onContextWindowEscalated: () => {
        escalated = true
      },
      provider: fakeProvider("mock", ["m"], () => "ok"),
    })
    let caught: unknown
    try {
      await session.run("x".repeat(20_000))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AgentError)
    expect(escalated).toBe(false)
  })

  test("delegate_task pins child todo_read to parent sessionId and respects allowLocalConfig on getSubAgentProvider", async () => {
    const { home, ws } = await makeTempEnv("sub-iso")
    let childTodoReadResult = ""
    await todoWriteTool.execute(
      { todos: [{ content: "Parent work item", status: "in_progress" }] },
      {
        cwd: ws,
        sessionId: "parent-sid",
        emit: () => {},
        signal: new AbortController().signal,
        state: {},
      } as never,
    )
    setSubAgentSessionFactory(
      async (spec) =>
        ({
          events: {
            emit() {},
            on() {
              return () => {}
            },
            once() {
              return () => {}
            },
          },
          async run() {
            const todoRead = spec.tools.find((t) => t.name === "todo_read")!
            childTodoReadResult = String(
              await todoRead.execute({}, {
                cwd: ws,
                sessionId: spec.sessionId,
                emit: () => {},
                signal: new AbortController().signal,
                state: {},
              } as never),
            )
            return {
              finalText: "done",
              finishReason: "stop",
              usage: { steps: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            }
          },
          abort() {},
        }) as never,
    )
    await mkdir(join(home, ".minicode"), { recursive: true })
    await writeFile(
      join(home, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "p", baseUrl: "https://p.test/v1", apiKey: "k", models: ["m"] }],
      }),
    )
    const out = await delegateTaskTool.execute({ prompt: "check todos", mode: "explore" }, {
      cwd: ws,
      sessionId: "parent-sid",
      emit: () => {},
      signal: new AbortController().signal,
      state: { model: "p::m" },
    } as never)
    expect(out).toContain("done")
    expect(childTodoReadResult).toContain("Parent work item")

    await mkdir(join(ws, ".minicode"), { recursive: true })
    await writeFile(
      join(ws, ".minicode", "config.json"),
      JSON.stringify({
        providers: [{ id: "localonly", baseUrl: "https://l.test/v1", apiKey: "k", models: ["lm"] }],
      }),
    )
    const routerNoLocal = await getSubAgentProvider(undefined, { cwd: ws, allowLocalConfig: false })
    expect(routerNoLocal.models.includes("lm")).toBe(false)
    const routerWithLocal = await getSubAgentProvider(undefined, {
      cwd: ws,
      allowLocalConfig: true,
    })
    expect(routerWithLocal.models.includes("lm")).toBe(true)
  })
})

describe("Fase 3 regressions: memory store security, RAG scope, & concurrency", () => {
  test("resolveEnvEmbeddingAuth never sends DEEPSEEK_API_KEY to default api.openai.com", () => {
    delete process.env.OPENAI_API_KEY
    delete process.env.AGENT_API_KEY
    delete process.env.AGENT_BASE_URL
    process.env.DEEPSEEK_API_KEY = "sk-ds-secret"
    expect(resolveEnvEmbeddingAuth()).toEqual({ baseUrl: "https://api.openai.com/v1", apiKey: "" })
    process.env.AGENT_BASE_URL = "https://embed.custom.test/v1"
    expect(resolveEnvEmbeddingAuth()).toEqual({
      baseUrl: "https://embed.custom.test/v1",
      apiKey: "sk-ds-secret",
    })
    delete process.env.AGENT_BASE_URL
    delete process.env.DEEPSEEK_API_KEY
  })

  // v7.40: operasi embedding/tokenizer bisa retry saat network absen — 5s
  // default Bun terlalu ketat untuk test I/O ini (timeout flake di beban penuh).
  test("deleteMemoryByQuery rejects blank queries, getMemoryStats stays read-only, and reconcileMemoryStores isolates global/provisional", async () => {
    const { home, ws } = await makeTempEnv("mem-sec")
    await mkdir(join(home, ".minicode"), { recursive: true })
    await addMemory("Secret global fact")
    expect(await deleteMemoryByQuery("", ws)).toBe(0)
    expect(await deleteMemoryByQuery("   ", ws)).toBe(0)

    const emptyStats = await getMemoryStats(ws)
    expect(emptyStats.rows).toBe(0)
    expect(existsSync(join(ws, ".minicode", "vector.db"))).toBe(false)

    const recEmpty = await reconcileMemoryStores(ws)
    expect(recEmpty).toMatchObject({ vectorOnlyAdopted: 0, fileOnlyAdded: 0 })

    await addMemory("Validated local fact", { cwd: ws, category: "fact" })
    await recordCandidateLesson("s-prov", "Candidate provisional fact", { cwd: ws })
    await reconcileMemoryStores(ws)
    const memFile = await loadMemoryFiles(ws)
    expect(memFile).toContain("Validated local fact")
    expect(memFile).not.toContain("Candidate provisional fact")
    expect(memFile).not.toContain("Secret global fact")
  }, 30_000)

  test("appendMemory rejects hardlink MEMORY.md, withMemLock serializes cleanly, and writeMemoryTool rejects provisional + supersedes_id", async () => {
    const { ws } = await makeTempEnv("mem-lock")
    await withMemLock(join(ws, "lock-a"), async () => {
      await appendMemory("fact one", ws, ["session:s1", "turn:1"])
      await appendMemory("fact ten", ws, ["session:s1", "turn:10"])
    })
    const rev = await revokeByProvenance({ turnId: "1" }, ws)
    expect(rev.fileLines).toBe(1)
    const mdAfter = await readFile(join(ws, ".minicode", "MEMORY.md"), "utf8")
    expect(mdAfter).toContain("fact ten")
    expect(mdAfter).not.toContain("fact one")

    await expect(
      writeMemoryTool.execute({ text: "bad", validation: "provisional", supersedes_id: "id-1" }, {
        cwd: ws,
        signal: new AbortController().signal,
        state: {},
        emit: () => {},
      } as never),
    ).rejects.toThrow(/supersedes_id.*provisional/i)

    const trap = await mkdtemp(join(tmpdir(), "mem-hardlink-"))
    const trapWs = await mkdtemp(join(tmpdir(), "mem-hlws-"))
    createdDirs.push(trap, trapWs)
    await mkdir(join(trapWs, ".minicode"), { recursive: true })
    await writeFile(join(trap, "victim.md"), "- 2026-01-01 victim\n")
    await link(join(trap, "victim.md"), join(trapWs, ".minicode", "MEMORY.md"))
    await expect(appendMemory("x", trapWs)).rejects.toThrow(/hardlink|symlink/i)
  })

  test("createRagLayer ignores repo vector.db when allowLocalConfig is false and honors it when true", async () => {
    const { ws } = await makeTempEnv("rag-gate")
    await mkdir(join(ws, ".minicode"), { recursive: true })
    await addMemory("Local repo architecture secret keyword ZEBRA42", { cwd: ws })
    const ragDenied = await createRagLayer({
      cfg: { providers: [] },
      cwd: ws,
      prompt: "ZEBRA42",
      allowLocalConfig: false,
    })
    expect(ragDenied.memoryHits).toBe(0)
    expect(ragDenied.systemExtra ?? "").not.toContain("ZEBRA42")
    const ragAllowed = await createRagLayer({
      cfg: { providers: [] },
      cwd: ws,
      prompt: "ZEBRA42",
      allowLocalConfig: true,
    })
    expect(ragAllowed.memoryHits).toBeGreaterThan(0)
    expect(ragAllowed.systemExtra ?? "").toContain("ZEBRA42")
  })
})

describe("Fase 4 & 5 regressions: TaskStore single authority, submit_result isolation, openwork, writer lease", () => {
  test("completeTaskVerification sets verification_json, reconcileCompletionEvidence syncs TaskStore + JSON + MD, and purgeExpired cleans todo/plan files", async () => {
    const { ws } = await makeTempEnv("tp-sync")
    await mkdir(join(ws, ".minicode"), { recursive: true })
    await saveSession("sid-ttl", ws, undefined, [{ role: "user", content: "old" }], { t: 1 })
    setCompletionEvidence(() => ({ verdict: "passed", detail: "ok", requireVerified: true }))
    await todoWriteTool.execute({ todos: [{ content: "Ship feature", status: "in_progress" }] }, {
      cwd: ws,
      sessionId: "sid-ttl",
      emit: () => {},
      signal: new AbortController().signal,
      state: {},
    } as never)
    const store = new TaskStore(ws)
    const t = store.listTasks("sid-ttl")[0]!
    const settled = store.completeTaskVerification("sid-ttl", t.id, {
      ok: true,
      verdict: "passed",
      summary: "all green",
    })
    expect(settled.verification?.verdict).toBe("passed")
    expect(settled.verification?.detail).toContain("all green")

    await syncTodoViewsFromTaskStore("sid-ttl", ws)
    const downgraded = await reconcileCompletionEvidence(
      "sid-ttl",
      ws,
      {
        verdict: "failed",
        detail: "post-turn red",
      },
      { syncTaskStore: true },
    )
    expect(downgraded?.[0]?.status).toBe("blocked")
    expect(store.getTask("sid-ttl", t.id)?.status).toBe("BLOCKED")

    expect(
      extractCommittedTodoStatuses("todos 0/1 · 1 blocked\n  [!] t1 — Ship feature", 1),
    ).toEqual(["blocked"])

    const sessDb = openSessionDb(ws)
    sessDb.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(1, "sid-ttl")
    const deleted = purgeExpired(sessDb, Date.now())
    sessDb.close()
    expect(deleted).toBe(1)
    expect(existsSync(join(ws, ".minicode", "todos", "sid-ttl.json"))).toBe(false)
    expect(existsSync(join(ws, ".minicode", "plans", "sid-ttl.md"))).toBe(false)
  })

  test("submitResultTool isolates submitted results by sessionId across concurrent callers", async () => {
    clearSubmittedResult("s-a")
    clearSubmittedResult("s-b")
    await submitResultTool.execute({ result: { status: "success" }, summary: "A" }, {
      sessionId: "s-a",
      signal: new AbortController().signal,
    } as never)
    await submitResultTool.execute({ result: { status: "blocked" }, summary: "B" }, {
      sessionId: "s-b",
      signal: new AbortController().signal,
    } as never)
    expect(getSubmittedResult("s-a")?.summary).toBe("A")
    expect(getSubmittedResult("s-a")?.result).toEqual({ status: "success" })
    expect(getSubmittedResult("s-b")?.summary).toBe("B")
    expect(getSubmittedResult("s-b")?.result).toEqual({ status: "blocked" })
    clearSubmittedResult("s-a")
    clearSubmittedResult("s-b")
  })

  test("projectOpenWork surfaces structural TaskGraph blockers (PARENT_MISSING) without N+1 loop", async () => {
    const { ws } = await makeTempEnv("ow-graph")
    await mkdir(join(ws, ".minicode"), { recursive: true })
    await saveSession("s-ow", ws, undefined, [{ role: "user", content: "x" }], { t: 1 })
    const store = new TaskStore(ws)
    const t = store.createTask("s-ow", {
      title: "Orphan child",
      status: "PENDING",
      order: 1,
      provenance: { origin: "runtime", source: "todo_write" },
    })
    store.patchTask("s-ow", t.id, { parentId: "t9999" })
    const report = projectOpenWork({ cwd: ws, sessionId: "s-ow" })
    const entry = report.open.find((e) => e.taskId === t.id)
    expect(entry?.state).toBe("BLOCKED")
    expect(entry?.blockers.some((b) => b.detail.includes("PARENT_MISSING"))).toBe(true)
  })

  test("acquireSessionWriter atomically transitions expired lease to new writer epoch and renewSessionWriter preserves continuity", async () => {
    const { ws } = await makeTempEnv("auth-tx")
    await mkdir(join(ws, ".minicode"), { recursive: true })
    await saveSession("s-auth", ws, undefined, [{ role: "user", content: "x" }], { t: 1 })
    const t0 = Date.now()
    const a = acquireSessionWriter({ sessionId: "s-auth", cwd: ws, bootId: "b1", now: t0 })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(renewSessionWriter("s-auth", a.admission.token, ws, t0 + 1_000)).toBe("AUTHORITY_HELD")
    const b = acquireSessionWriter({
      sessionId: "s-auth",
      cwd: ws,
      bootId: "b2",
      now: t0 + 1_000 + SESSION_LEASE_MS + 10,
    })
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.admission.tookOver).toBe(true)
    expect(b.admission.epoch).toBe(1)
  })

  test("isPrivateHostWithDns resolves array/single DNS results, reuses cache, and fails closed on timeout", async () => {
    const lookup = spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce({ address: "10.0.0.1", family: 4 } as never)
      .mockImplementationOnce(() => new Promise(() => {}) as never)
    try {
      const hostA = `pub-${Date.now()}.example`
      expect(await isPrivateHostWithDns(hostA)).toBe(false)
      // Kedua kali memakai dnsCache (tanpa lookup kedua)
      expect(await isPrivateHostWithDns(hostA)).toBe(false)
      expect(lookup).toHaveBeenCalledTimes(1)

      // Hasil non-array yang menuju IP privat tetap diblokir
      expect(await isPrivateHostWithDns(`priv-${Date.now()}.example`, { noCache: true })).toBe(true)

      // Timeout strict fail-closed
      expect(
        await isPrivateHostWithDns(`hang-${Date.now()}.example`, {
          strict: true,
          timeoutMs: 5,
          noCache: true,
        }),
      ).toBe(true)
    } finally {
      lookup.mockRestore()
    }
  })
})
