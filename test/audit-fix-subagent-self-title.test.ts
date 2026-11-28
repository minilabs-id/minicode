// AUDIT-FIX — judul diri sub-agent (self-title).
//
// `delegate_task` menyalakan panggilan LLM KECIL secara paralel dengan turn
// anak. Judul 2–4 kata menimpa label sementara `explore-N` di ledger lewat
// event `provider:extension` → `minicode:child-label`. Panggilan ini TIDAK
// boleh menahan anak; gagal/timeout/garbage = fail-soft (label tetap).
//
// Hermetik: tmpdir, fake factory + fake provider lewat seam `updateProviders`.

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "#minicore/core/events.ts"
import type { ModelProvider, ProviderEvent } from "#minicore/core/provider.ts"
import { LIMITS } from "../src/constants.ts"
import type { RouterProvider } from "../src/providers/router.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-audit-title-"))
  dirs.push(d)
  return d
}
afterAll(async () => {
  clearSubAgentSessionFactory()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function providerEnv(): () => void {
  const savedKey = process.env.OPENAI_API_KEY
  const savedAgent = process.env.AGENT_API_KEY
  if (!savedKey && !savedAgent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedKey
    if (savedAgent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = savedAgent
  }
}

/** Provider judul palsu; dipasang ke router yang SUDAH dipakai anak. */
function titleProvider(opts: {
  text?: string
  throwError?: boolean
  hangUntilAbort?: boolean
}): ModelProvider {
  return {
    id: "fake-title",
    models: ["fake-title-model"],
    async *stream(_req, signal): AsyncIterable<ProviderEvent> {
      if (opts.throwError) throw new Error("title provider down")
      if (opts.hangUntilAbort) {
        // Endpoint hidup tapi bisu: hanya watchdog yang boleh menghentikannya.
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(new Error("aborted"))
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      }
      yield { type: "text", text: opts.text ?? "" }
      yield { type: "finish", reason: "stop" }
    },
  }
}

/** Pasang provider judul ke router di spec anak; run sengaja sedikit lambat
 * supaya panggilan paralel sempat selesai sebelum finally membatalkannya. */
function installFactory(provider: ModelProvider, seen: SubAgentSpec[], runMs = 150): void {
  setSubAgentSessionFactory(async (spec) => {
    seen.push(spec)
    ;(spec.provider as RouterProvider).updateProviders([provider])
    return {
      events: { on: () => () => {} },
      run: async () => {
        await new Promise((r) => setTimeout(r, runMs))
        return { finalText: "ok", usage: { steps: 1 } }
      },
    }
  })
}

function ctxFor(cwd: string, emitted: AgentEvent[]) {
  return {
    signal: new AbortController().signal,
    emit: (e: AgentEvent) => {
      emitted.push(e)
    },
    cwd,
    permissionMode: "auto",
  } as never
}

function labelEventOf(emitted: AgentEvent[]) {
  return emitted.find(
    (e): e is Extract<AgentEvent, { type: "provider:extension" }> =>
      e.type === "provider:extension" && e.kind === "minicode:child-label",
  )
}

// ── A. Konstanta pagu ───────────────────────────────────────────────────────

test("A1 pagu token/watchdog judul tersedia dan pendek", () => {
  expect(LIMITS.TITLE_MAX_TOKENS).toBeGreaterThan(0)
  expect(LIMITS.TITLE_MAX_TOKENS).toBeLessThanOrEqual(64)
  expect(LIMITS.CHILD_TITLE_TIMEOUT_MS).toBeGreaterThan(0)
  expect(LIMITS.CHILD_TITLE_TIMEOUT_MS).toBeLessThan(LIMITS.SUB_AGENT_TIMEOUT_MS)
})

function llmTitleEnv(): () => void {
  const prev = process.env.MINICODE_SUBAGENT_LLM_TITLE
  process.env.MINICODE_SUBAGENT_LLM_TITLE = "1"
  return () => {
    if (prev === undefined) delete process.env.MINICODE_SUBAGENT_LLM_TITLE
    else process.env.MINICODE_SUBAGENT_LLM_TITLE = prev
  }
}

test("B0 default 0-token generator menurunkan judul lokal tanpa panggilan LLM", async () => {
  const restore = providerEnv()
  const prevFlag = process.env.MINICODE_SUBAGENT_LLM_TITLE
  delete process.env.MINICODE_SUBAGENT_LLM_TITLE
  const dir = tmpRoot()
  const prev = todoSession.id
  todoSession.id = "audit-self-title-b0"
  const emitted: AgentEvent[] = []
  const seen: SubAgentSpec[] = []
  let titleStreamCalls = 0
  try {
    installFactory(
      {
        id: "counting",
        models: ["m"],
        async *stream() {
          titleStreamCalls++
          yield { type: "text", text: "should not run" }
          yield { type: "finish", reason: "stop" }
        },
      },
      seen,
    )
    await delegateTaskTool.execute(
      { prompt: "Please investigate dependency cycle in tools" },
      ctxFor(dir, emitted),
    )
    expect(titleStreamCalls).toBe(0)
    const ev = labelEventOf(emitted)
    expect((ev?.data as { childLabel?: string } | undefined)?.childLabel).toBe(
      "dependency cycle in tools",
    )
  } finally {
    if (prevFlag !== undefined) process.env.MINICODE_SUBAGENT_LLM_TITLE = prevFlag
    todoSession.id = prev
    clearSubAgentSessionFactory()
    restore()
  }
})

// ── B. Emisi judul (mode opt-in MINICODE_SUBAGENT_LLM_TITLE=1) ─────────────

test("B1 judul dinormalisasi (4 kata, ·) dan membawa id anak", async () => {
  const restore = providerEnv()
  const restoreTitle = llmTitleEnv()
  const dir = tmpRoot()
  const prev = todoSession.id
  todoSession.id = "audit-self-title-b1"
  const emitted: AgentEvent[] = []
  const seen: SubAgentSpec[] = []
  try {
    installFactory(
      titleProvider({ text: '  "audit   allowlist\nbash guard"  and more words ' }),
      seen,
    )
    await delegateTaskTool.execute({ prompt: "scan" }, ctxFor(dir, emitted))
    const ev = labelEventOf(emitted)
    expect(ev).toBeTruthy()
    const data = ev!.data as { forwardedChild: string; childLabel: string }
    expect(data.forwardedChild).toBe(seen[0]!.sessionId!)
    expect(data.childLabel).toBe("audit allowlist bash guard")
    expect(seen[0]!.label).toMatch(/^explore-\d+$/) // label sementara tetap
  } finally {
    todoSession.id = prev
    clearSubAgentSessionFactory()
    restoreTitle()
    restore()
  }
})

test("B2 balasan garbage tak menghasilkan judul (fallback label sementara)", async () => {
  const restore = providerEnv()
  const restoreTitle = llmTitleEnv()
  const dir = tmpRoot()
  const prev = todoSession.id
  todoSession.id = "audit-self-title-b2"
  const emitted: AgentEvent[] = []
  const seen: SubAgentSpec[] = []
  try {
    installFactory(titleProvider({ text: '  "\n ... !!! "  ' }), seen)
    await delegateTaskTool.execute({ prompt: "scan" }, ctxFor(dir, emitted))
    expect(labelEventOf(emitted)).toBeUndefined()
    expect(seen[0]!.label).toMatch(/^explore-\d+$/)
  } finally {
    todoSession.id = prev
    clearSubAgentSessionFactory()
    restoreTitle()
    restore()
  }
})

test("B3 provider gagal = fail-soft, anak tetap selesai tanpa event judul", async () => {
  const restore = providerEnv()
  const restoreTitle = llmTitleEnv()
  const dir = tmpRoot()
  const prev = todoSession.id
  todoSession.id = "audit-self-title-b3"
  const emitted: AgentEvent[] = []
  const seen: SubAgentSpec[] = []
  try {
    installFactory(titleProvider({ throwError: true }), seen)
    const out = (await delegateTaskTool.execute({ prompt: "scan" }, ctxFor(dir, emitted))) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(labelEventOf(emitted)).toBeUndefined()
    expect(seen).toHaveLength(1)
  } finally {
    todoSession.id = prev
    clearSubAgentSessionFactory()
    restoreTitle()
    restore()
  }
})

test("B4 watchdog memutus provider diam: tanpa judul, tanpa timer bocor", async () => {
  const restore = providerEnv()
  const restoreTitle = llmTitleEnv()
  const dir = tmpRoot()
  const prev = todoSession.id
  todoSession.id = "audit-self-title-b4"
  const emitted: AgentEvent[] = []
  const seen: SubAgentSpec[] = []
  const mutable = LIMITS as unknown as { CHILD_TITLE_TIMEOUT_MS: number }
  const savedTimeout = mutable.CHILD_TITLE_TIMEOUT_MS
  mutable.CHILD_TITLE_TIMEOUT_MS = 50
  try {
    installFactory(titleProvider({ hangUntilAbort: true }), seen, 200)
    const started = Date.now()
    const out = (await delegateTaskTool.execute({ prompt: "scan" }, ctxFor(dir, emitted))) as string
    expect(out).toContain("sub-agent (explore) done")
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(labelEventOf(emitted)).toBeUndefined()
  } finally {
    mutable.CHILD_TITLE_TIMEOUT_MS = savedTimeout
    todoSession.id = prev
    clearSubAgentSessionFactory()
    restoreTitle()
    restore()
  }
})
