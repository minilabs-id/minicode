// Regression tests for Waves 1-5 pre-release audit remediation.
import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import { createOpenAICompatProvider } from "#minicore/providers/openai-compat.ts"
import { compareAceAblation } from "../bench/eval-gate.ts"
import { buildResumeSpawnArgs } from "../cli/commands.ts"
import { buildEmbeddingCandidates } from "../src/app/rag-layer.ts"
import { loadConfig } from "../src/config.ts"
import { computeMcpToolSchemaHash, McpSchemaPinRegistry } from "../src/mcp/client.ts"
import { readSseResponse } from "../src/mcp/http-transport.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { resolveSandbox } from "../src/policy/sandbox-policy.ts"
import { createAnthropicProvider } from "../src/providers/anthropic.ts"
import { thinkingFamily } from "../src/providers/effort.ts"
import { clearResponsesChain, createResponsesProvider } from "../src/providers/responses.ts"
import { boundedSseBody } from "../src/providers/sse-bounds.ts"
import { discoverSandboxMaskTargets } from "../src/sandbox/mask.ts"
import { verifyPaths } from "../src/session/journal.ts"
import { readTraceRows, writeTrace } from "../src/telemetry/trace.ts"
import { gitLogTool } from "../src/tools/git.ts"
import { promptAsk } from "../src/ui/approval/prompt.ts"
import type { UiPresentationActivity, UiPresentationEvent } from "../src/ui/contract.ts"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { parseSlashCommand } from "../src/ui/render/composer-wrap.ts"
import { glyphs } from "../src/ui/render/theme.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const tmpDirs: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
let tty: FakeTty | undefined

const ENV_SNAPSHOT: Record<string, string | undefined> = {
  MINICODE_TELEMETRY: process.env.MINICODE_TELEMETRY,
  AGENT_BASE_URL: process.env.AGENT_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  AGENT_API_KEY: process.env.AGENT_API_KEY,
}

function makeTmpDir(prefix = "mc-wave-reg-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  tty?.restore()
  tty = undefined
  setSessionLocale("en")
  clearResponsesChain()
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("Wave 1 — security & isolation regressions", () => {
  test("SEC-01: local config providers are tagged fromLocal in buildEmbeddingCandidates", async () => {
    delete process.env.AGENT_BASE_URL
    delete process.env.OPENAI_API_KEY
    delete process.env.AGENT_API_KEY
    const dir = makeTmpDir()
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    writeFileSync(
      join(dir, ".minicode", "config.json"),
      JSON.stringify({
        providers: [
          {
            id: "local-emb",
            baseUrl: "https://local.invalid/v1",
            apiKey: "keystore:secret",
            models: ["m1"],
          },
        ],
      }),
    )
    const cfg = await loadConfig(dir, { allowLocal: true })
    const cands = buildEmbeddingCandidates(cfg)
    const local = cands.find((c) => c.baseUrl === "https://local.invalid/v1")
    expect(local?.fromLocal).toBe(true)

    const globalOnly = buildEmbeddingCandidates({
      providers: [{ id: "g", baseUrl: "https://global.invalid/v1", apiKey: "k", models: [] }],
    })
    expect(globalOnly).toEqual([{ baseUrl: "https://global.invalid/v1", apiKey: "k" }])
  })

  test("SEC-03: sandbox mask scans nested depth 5, allowlist blocks subshells/pushd, unknown sandbox lowers permission", async () => {
    const dir = makeTmpDir()
    const deep = join(dir, "a", "b", "c", "d", "e")
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, ".env.secret"), "TOKEN=abc\n")
    const targets = discoverSandboxMaskTargets(dir)
    expect(targets.envFiles).toContain("a/b/c/d/e/.env.secret")

    const perms = createPermissionHandler({ mode: "auto", restrictBash: true, root: dir })
    const deps = { state: { history: [], turnCount: 0, stepCount: 0 } } as never
    expect(
      await perms.check({ id: "1", name: "bash", args: { cmd: "(cd /etc && git status)" } }, deps),
    ).toBe("deny")
    expect(
      await perms.check({ id: "2", name: "bash", args: { cmd: "pushd .. && git status" } }, deps),
    ).toBe("deny")
    expect(await perms.check({ id: "3", name: "bash", args: { cmd: "git status" } }, deps)).toBe(
      "allow",
    )

    const typo = resolveSandbox("typo-mode", false, { os: () => false, docker: () => false })
    expect(typo.mode).toBe("none")
    expect(typo.fallbackPermission).toBe("allowlist")
    expect(typo.notice).toContain("unknown mode")
    expect(
      resolveSandbox("typo-mode", true, { os: () => false, docker: () => false })
        .fallbackPermission,
    ).toBeUndefined()
  })

  test("SEC-04: writeTrace scrubs secrets crossing the 2000-char slice boundary", async () => {
    process.env.MINICODE_TELEMETRY = "1"
    const dir = makeTmpDir()
    const secret = "sk-proj-secret1234567890abcdef1234567890"
    await writeTrace(dir, {
      sessionId: "s1",
      timestamp: new Date().toISOString(),
      prompt: `${"x".repeat(1995)}${secret}`,
      durationMs: 1,
      steps: 1,
      turns: 1,
      inputTokens: 1,
      outputTokens: 1,
      ok: true,
    })
    const rows = readTraceRows(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.prompt).not.toContain("sk-proj-secret")
  })
})

describe("Wave 2 — TUI, slash command & approval regressions", () => {
  test("UI-01: root delegate_task failure counts once even with 0 child tools, and retried child failure deduplicates", () => {
    setSessionLocale("id")
    const bus = createFakeBus()
    let snapshot: { activities: UiPresentationActivity[]; turns: [] } = {
      activities: [],
      turns: [],
    }
    let emitFn: ((e: UiPresentationEvent) => void) | undefined
    const tr = new Transcript(bus as never, {
      getSnapshot: () => snapshot,
      onPresentationEvent: (fn) => {
        emitFn = fn
        return () => {
          emitFn = undefined
        }
      },
    })
    const rootAct: UiPresentationActivity = {
      toolCallId: "root-0",
      name: "delegate_task",
      status: "failed",
      tsStart: Date.now(),
      label: "explore",
    }
    snapshot = { activities: [rootAct], turns: [] }
    emitFn?.({ type: "tool.started", seq: 1, turnId: 1, toolCallId: "root-0" })
    emitFn?.({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "root-0",
      status: "failed",
      message: "timeout",
    })
    expect(tr.view(120, 20, 0).join("\n")).toContain(
      `${glyphs.sparkle} 1 sub agent · 0 tool · 1 gagal`,
    )

    // Turn 2: child fails once, then retry supersedes with failed again → 1 gagal (not 2).
    const c1: UiPresentationActivity = {
      toolCallId: "c1",
      name: "read_file",
      target: "a.ts",
      status: "failed",
      tsStart: Date.now(),
      parentToolCallId: "root-2",
      childSessionId: "sub_2",
      runId: "run_2",
    }
    const c2: UiPresentationActivity = {
      ...c1,
      toolCallId: "c2",
      supersedes: "c1",
    }
    snapshot = { activities: [c1, c2], turns: [] }
    emitFn?.({ type: "turn.started", turnId: 2 })
    emitFn?.({ type: "tool.completed", seq: 3, turnId: 2, toolCallId: "c1", status: "failed" })
    emitFn?.({ type: "tool.completed", seq: 4, turnId: 2, toolCallId: "c2", status: "failed" })
    const lastSparkle = tr
      .view(120, 20, 0)
      .filter((l) => l.includes(glyphs.sparkle))
      .at(-1)
    expect(lastSparkle).toContain("1 gagal")
    expect(lastSparkle).not.toContain("2 gagal")
  })

  test("UI-02 & UX-01: parseSlashCommand rejects paths/multiline/paste-tokens and approval drops 'i' deny shortcut", async () => {
    expect(parseSlashCommand("/etc/hosts")).toBeNull()
    expect(parseSlashCommand("/help\nfoo")).toBeNull()
    expect(parseSlashCommand("/help arg", { rawLine: "{paste text 2 lines}" })).toBeNull()
    expect(parseSlashCommand("  /help  keys  ")).toEqual({ name: "help", args: "keys" })

    setSessionLocale("en")
    tty = installFakeTty({ isTTY: true })
    const pending = promptAsk({ name: "bash", args: { command: "ls" } })
    await tty.ready()
    await tty.send("i")
    const raced = await Promise.race([
      pending.then(() => "settled" as const),
      Bun.sleep(30).then(() => "pending" as const),
    ])
    expect(raced).toBe("pending")
    await tty.send("n\r")
    expect(await pending).toBe("deny")
  })
})

describe("Wave 3 — provider, SSE & effort regressions", () => {
  test("PROV-06 & PROV-05: thinkingFamily strips gateway prefix and boundedSseBody allows LF-terminated EOF", async () => {
    expect(thinkingFamily("openrouter/anthropic/claude-opus-4.6")).toBe("claude-adaptive")
    expect(thinkingFamily("azure/openai/o3")).toBe("openai-reasoning")

    const okStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {}\n"))
        c.close()
      },
    })
    const ac = new AbortController()
    const reader = boundedSseBody(okStream, ac.signal, "test").getReader()
    while (!(await reader.read()).done) {}

    const badStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: partial"))
        c.close()
      },
    })
    const badReader = boundedSseBody(badStream, ac.signal, "test").getReader()
    await expect(
      (async () => {
        while (!(await badReader.read()).done) {}
      })(),
    ).rejects.toThrow("incomplete SSE frame")
  })

  test("PROV-03: Anthropic SSE event:error maps rate_limit cleanly", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    })
    servers.push(srv)
    const p = createAnthropicProvider({
      apiKey: "k",
      baseUrl: `http://127.0.0.1:${srv.port}`,
      models: ["claude-sonnet-4"],
    })
    let caught: unknown
    try {
      for await (const _ of p.stream(
        { messages: [{ role: "user", content: "hi" }], model: "claude-sonnet-4" },
        new AbortController().signal,
      )) {
      }
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProviderError)
    expect((caught as ProviderError).category).toBe("rate_limit")
  })

  test("PROV-02: openai-compat preserves extra_content on stream_options retry and rejects truncated EOF", async () => {
    let callIdx = 0
    let secondBody: Record<string, unknown> | undefined
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        callIdx++
        const body = (await req.json()) as Record<string, unknown>
        if (callIdx === 1) {
          return new Response(
            `data: ${JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc1",
                        function: { name: "read_file", arguments: '{"path":"a"}' },
                        extra_content: { thought_signature: "sig-xyz" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (callIdx === 2) {
          return new Response('{"error":{"message":"unknown parameter stream_options"}}', {
            status: 400,
          })
        }
        if (callIdx === 3) {
          secondBody = body
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        // callIdx === 4: truncated SSE without [DONE] or finish_reason
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    servers.push(srv)
    const p = createOpenAICompatProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    const ac = new AbortController()
    for await (const _ of p.stream(
      { messages: [{ role: "user", content: "hi" }], model: "m" },
      ac.signal,
    )) {
    }
    for await (const _ of p.stream(
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", name: "read_file", args: { path: "a" } }],
          },
          { role: "tool", toolCallId: "tc1", name: "read_file", content: "ok" },
        ],
        model: "m",
      },
      ac.signal,
    )) {
    }
    const msgs = secondBody?.messages as Array<{ tool_calls?: Array<{ extra_content?: unknown }> }>
    expect(msgs?.[1]?.tool_calls?.[0]?.extra_content).toEqual({ thought_signature: "sig-xyz" })

    await expect(
      (async () => {
        for await (const _ of p.stream(
          { messages: [{ role: "user", content: "hi" }], model: "m" },
          ac.signal,
        )) {
        }
      })(),
    ).rejects.toThrow("ended without finish reason or [DONE]")
  })

  test("PROV-04: Responses response.incomplete max_output_tokens emits length & truncated EOF throws network", async () => {
    let n = 0
    const srv = Bun.serve({
      port: 0,
      fetch: () => {
        n++
        const body =
          n === 1
            ? `data: ${JSON.stringify({
                type: "response.incomplete",
                response: { id: "r1", incomplete_details: { reason: "max_output_tokens" } },
              })}\n\n`
            : `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })
    servers.push(srv)
    clearResponsesChain()
    const p = createResponsesProvider({
      baseUrl: `http://127.0.0.1:${srv.port}/v1`,
      models: ["m"],
    })
    const evs: Array<{ type: string; reason?: string; kind?: string }> = []
    for await (const ev of p.stream(
      { messages: [{ role: "user", content: "hi" }], model: "m" },
      new AbortController().signal,
    )) {
      evs.push(ev as { type: string; reason?: string; kind?: string })
    }
    expect(evs.some((e) => e.type === "extension" && e.kind === "warning")).toBe(true)
    expect(evs.find((e) => e.type === "finish")?.reason).toBe("length")

    await expect(
      (async () => {
        for await (const _ of p.stream(
          { messages: [{ role: "user", content: "hi" }], model: "m" },
          new AbortController().signal,
        )) {
        }
      })(),
    ).rejects.toThrow("ended without completion or finish_reason")
  })
})

describe("Wave 4 & Wave 5 — journal, gates, resume, git_log & MCP regressions", () => {
  test("STOR-02 & GATE-01: move_file verifyPaths supports path/destination & compareAceAblation rejects ties", () => {
    const dir = makeTmpDir()
    expect(verifyPaths("move_file", { path: "a.ts", destination: "b.ts" }, dir)).toEqual([
      "a.ts",
      "b.ts",
    ])
    expect(verifyPaths("move_file", { from: "x.ts", to: "y.ts" }, dir)).toEqual(["x.ts", "y.ts"])

    const base = {
      verifiedTaskSuccessRate: 0.7,
      regressionRate: 0.2,
      unproductiveRetryRate: 0.3,
      falseCompletionRate: 0.1,
      unsafeActionRate: 0.05,
      costPerVerifiedSuccess: 1.0,
    }
    expect(compareAceAblation(base, { ...base, verifiedTaskSuccessRate: 0.9 }).passed).toBe(false)
  })

  test("Wave 5: buildResumeSpawnArgs, git_log NaN limit, McpSchemaPinRegistry concurrent merge & SSE multiline join", async () => {
    expect(
      buildResumeSpawnArgs("cli/index.ts", "s1", "/ws", "owned", {
        workMode: "BUILD",
        model: "p::m",
        sandbox: "os",
        budget: 2.5,
      }),
    ).toEqual([
      "cli/index.ts",
      "--resume=s1",
      "--cwd=/ws",
      "--runtime",
      "owned",
      "--work-mode",
      "BUILD",
      "--model",
      "p::m",
      "--sandbox",
      "os",
      "--budget",
      "2.5",
    ])

    const repo = makeTmpDir()
    spawnSync("git", ["init"], { cwd: repo })
    spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: repo })
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: repo })
    spawnSync("git", ["commit", "--allow-empty", "-m", "initial commit"], { cwd: repo })
    const logOut = await gitLogTool.execute({ limit: Number.NaN }, {
      cwd: repo,
      signal: new AbortController().signal,
      emit() {},
    } as never)
    expect(String(logOut)).toContain("initial commit")

    const pinFile = join(makeTmpDir(), "pins.json")
    const regA = new McpSchemaPinRegistry()
    const regB = new McpSchemaPinRegistry()
    regA.configure(pinFile)
    regB.configure(pinFile)
    const hA1 = computeMcpToolSchemaHash({ name: "t1", inputSchema: { type: "object" } })
    const hB1 = computeMcpToolSchemaHash({ name: "t2", inputSchema: { type: "object" } })
    const hA2 = computeMcpToolSchemaHash({ name: "t3", inputSchema: { type: "object" } })
    regA.pin("srvA", "t1", hA1)
    regB.pin("srvB", "t2", hB1)
    regA.pin("srvA", "t3", hA2)
    const disk = JSON.parse(readFileSync(pinFile, "utf8")) as Record<string, string>
    expect(Object.keys(disk).sort()).toEqual(["srvA:t1", "srvA:t3", "srvB:t2"])

    const sseRes = new Response('data: {"jsonrpc":"2.0","id":7,\ndata: "result":{"ok":true}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    })
    const parsed = await readSseResponse(sseRes, 7)
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } })
  })
})
