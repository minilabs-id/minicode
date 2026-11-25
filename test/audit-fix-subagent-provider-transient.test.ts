// Provider 401/429 pada anak tidak boleh dibaca sebagai kegagalan fungsional
// (ANALYZE_FAILURE). Klasifikasi murni + integrasi ACE verdict di receipt.
// Hermetik: temp dir, fake session factory, tanpa jaringan.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AceFailureType } from "../src/policy/consequence-engine.ts"
import { evaluateConsequence } from "../src/policy/consequence-engine.ts"
import { type ChildResultEnvelope, loadJournal } from "../src/session/journal.ts"
import {
  __resetProviderCooldownForTest,
  classifyChildFailureType,
  clearSubAgentHistory,
  clearSubAgentSessionFactory,
  delegateTaskTool,
  isProviderOutage,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"
import { todoSession } from "../src/tools/todo.ts"

const dirs: string[] = []

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-subagent-transient-"))
  dirs.push(d)
  return d
}

function providerEnv(): () => void {
  const saved = process.env.OPENAI_API_KEY
  if (!saved) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved
  }
}

function ctx(cwd: string) {
  return {
    signal: new AbortController().signal,
    emit: () => {},
    cwd,
    permissionMode: "auto",
  } as never
}

afterEach(() => {
  clearSubAgentSessionFactory()
  clearSubAgentHistory()
  __resetProviderCooldownForTest()
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    } catch {}
  }
})

describe("classifyChildFailureType — klasifikasi murni", () => {
  const cases: {
    label: string
    text: string
    status: "timeout" | "aborted" | "max_steps_exceeded" | "error"
    expected: AceFailureType
  }[] = [
    {
      label: "429 + capacity_exhausted → rate_limit",
      text: "rate limited (429): capacity_exhausted",
      status: "error",
      expected: "rate_limit",
    },
    {
      label: "rate_limit / too many requests → rate_limit",
      text: "ProviderError: rate_limit_exceeded — too many requests",
      status: "error",
      expected: "rate_limit",
    },
    {
      label: "auth failed (401) → network_error (transient)",
      text: "auth failed (401): please try again; if it persists, contact support",
      status: "error",
      expected: "network_error",
    },
    {
      label: "authentication_failed → network_error",
      text: "ProviderError: authentication_failed",
      status: "error",
      expected: "network_error",
    },
    {
      label: "timeout tanpa tanda provider → timeout",
      text: "turn exceeded 60000ms",
      status: "timeout",
      expected: "timeout",
    },
    {
      label: "abort tanpa tanda provider → timeout",
      text: "parent aborted the child run",
      status: "aborted",
      expected: "timeout",
    },
    {
      label: "tanda provider eksplisit mengalahkan kind aborted",
      text: "rate limited (429)",
      status: "aborted",
      expected: "rate_limit",
    },
    {
      label: "error biasa → functional",
      text: "write_file failed: ENOENT",
      status: "error",
      expected: "functional",
    },
    {
      label: "bukan substring longgar: 14013 / ratelimiter → functional",
      text: "status 14013 from ratelimiter",
      status: "error",
      expected: "functional",
    },
  ]

  for (const c of cases) {
    test(c.label, () => {
      expect(classifyChildFailureType(c.text, c.status)).toBe(c.expected)
    })
  }

  test("case-insensitive", () => {
    expect(classifyChildFailureType("AUTH FAILED (401)", "error")).toBe("network_error")
    expect(classifyChildFailureType("TOO MANY REQUESTS", "error")).toBe("rate_limit")
  })
})

describe("ACE consequence — tipe transient dari provider", () => {
  test("401 → TRANSIENT_ENV / RETRY_TRANSIENT, 429 → sama", () => {
    for (const failureType of ["network_error", "rate_limit"] as const) {
      const d = evaluateConsequence({
        verificationPassed: false,
        failureType,
        isTransientError: true,
      })
      expect(d.verdict).toBe("FAIL")
      expect(d.failureClass).toBe("TRANSIENT_ENV")
      expect(d.nextAction).toBe("RETRY_TRANSIENT")
    }
  })

  test("retry ke-2 & ke-3 masih RETRY_TRANSIENT; ke-4 → REQUEST_HUMAN", () => {
    // prior count = jumlah kegagalan SEBELUM attempt ini (0,1,2 = attempt 1,2,3).
    for (const repeatedFailureCount of [0, 1, 2]) {
      const d = evaluateConsequence({
        verificationPassed: false,
        failureType: "network_error",
        isTransientError: true,
        repeatedFailureCount,
      })
      expect(d.nextAction).toBe("RETRY_TRANSIENT")
    }
    const atLimit = evaluateConsequence({
      verificationPassed: false,
      failureType: "rate_limit",
      isTransientError: true,
      repeatedFailureCount: 3,
      retryLimitReached: true,
    })
    expect(atLimit.verdict).toBe("BLOCKED")
    expect(atLimit.failureClass).toBe("REPEATED_NO_EVIDENCE")
    expect(atLimit.nextAction).toBe("REQUEST_HUMAN")
  })

  test("pagar engine: 5 kegagalan identik tanpa bukti baru → REQUEST_HUMAN", () => {
    const d = evaluateConsequence({
      verificationPassed: false,
      failureType: "network_error",
      isTransientError: true,
      repeatedFailureCount: 5,
    })
    expect(d.nextAction).toBe("REQUEST_HUMAN")
    // Bukti baru memutus streak — retry tetap boleh, ini pagar longgar.
    const withEvidence = evaluateConsequence({
      verificationPassed: false,
      failureType: "network_error",
      isTransientError: true,
      repeatedFailureCount: 5,
      newEvidenceSinceLastAttempt: true,
    })
    expect(withEvidence.nextAction).toBe("RETRY_TRANSIENT")
  })

  test("hard constraint EVALUATOR_TAMPER_ATTEMPT tetap menang atas tipe transient", () => {
    const d = evaluateConsequence({
      verificationPassed: false,
      failureType: "network_error",
      isTransientError: true,
      evaluatorTamperAttempt: true,
    })
    expect(d.verdict).toBe("BLOCKED")
    expect(d.failureClass).toBe("EVALUATOR_TAMPER_ATTEMPT")
    expect(d.nextAction).toBe("STOP_AND_REPORT")
    // Pagar retry baru TIDAK boleh menimpa hard constraint.
    const d2 = evaluateConsequence({
      failureType: "network_error",
      isTransientError: true,
      retryLimitReached: true,
      evaluatorTamperAttempt: true,
    })
    expect(d2.failureClass).toBe("EVALUATOR_TAMPER_ATTEMPT")
    expect(d2.nextAction).toBe("STOP_AND_REPORT")
  })
})

describe("integrasi delegate_task — aceVerdict di receipt", () => {
  async function runChildError(message: string): Promise<ChildResultEnvelope> {
    const restore = providerEnv()
    const dir = tempDir()
    const parentId = `subagent-transient-${message.slice(0, 12).replace(/\W+/g, "-")}`
    const prevTodo = todoSession.id
    todoSession.id = parentId
    try {
      setSubAgentSessionFactory((async () => ({
        events: { on: () => () => {} },
        abort: () => {},
        run: async () => {
          throw new Error(message)
        },
      })) as never)
      const out = (await delegateTaskTool.execute(
        { prompt: "kerjakan" } as never,
        ctx(dir),
      )) as string
      expect(out).toContain("[sub-agent explore error]")
      const { records } = await loadJournal(parentId, dir)
      const receipt = records.find(
        (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
      )
      expect(receipt).toBeDefined()
      const env = receipt!.outcome?.childResult as ChildResultEnvelope | undefined
      expect(env).toBeDefined()
      return env!
    } finally {
      todoSession.id = prevTodo
      clearSubAgentSessionFactory()
      restore()
    }
  }

  test("auth 401 → FAIL / TRANSIENT_ENV / RETRY_TRANSIENT", async () => {
    const env = await runChildError("auth failed (401): please try again")
    expect(env.aceVerdict).toMatchObject({
      verdict: "FAIL",
      failureClass: "TRANSIENT_ENV",
      nextAction: "RETRY_TRANSIENT",
    })
  })

  test("rate limited 429 → FAIL / TRANSIENT_ENV / RETRY_TRANSIENT", async () => {
    const env = await runChildError("rate limited (429): capacity_exhausted")
    expect(env.aceVerdict).toMatchObject({
      verdict: "FAIL",
      failureClass: "TRANSIENT_ENV",
      nextAction: "RETRY_TRANSIENT",
    })
  })

  test("error biasa → FAIL / FUNCTIONAL_TEST_FAIL / ANALYZE_FAILURE", async () => {
    const env = await runChildError("write_file failed: ENOENT")
    expect(env.aceVerdict).toMatchObject({
      verdict: "FAIL",
      failureClass: "FUNCTIONAL_TEST_FAIL",
      nextAction: "ANALYZE_FAILURE",
    })
  })
})

describe("audit v0.43.2 — jeda + batas retry per scope delegasi", () => {
  async function aceActionOfLastReceipt(
    parentId: string,
    dir: string,
  ): Promise<string | undefined> {
    const { records } = await loadJournal(parentId, dir)
    const receipts = records.filter(
      (r) => r.tool === "delegate_task" && (r.state === "committed" || r.state === "failed"),
    )
    const env = receipts.at(-1)?.outcome?.childResult as ChildResultEnvelope | undefined
    return env?.aceVerdict?.nextAction
  }

  test("401 berulang: attempt 2 & 3 masih RETRY_TRANSIENT, attempt 4 → REQUEST_HUMAN", async () => {
    const restore = providerEnv()
    const dir = tempDir()
    const parentId = "subagent-transient-retry-limit"
    const prevTodo = todoSession.id
    todoSession.id = parentId
    try {
      clearSubAgentHistory()
      setSubAgentSessionFactory((async () => ({
        events: { on: () => () => {} },
        abort: () => {},
        run: async () => {
          throw new Error("auth failed (401): please try again")
        },
      })) as never)

      const actions: (string | undefined)[] = []
      for (let attempt = 1; attempt <= 4; attempt++) {
        // Cooldown 60 dtk = jeda antar retry. Reset di test menyimulasikan jeda
        // sudah lewat; tanpa ini attempt 2-4 diskip dan tak ada yang diuji.
        __resetProviderCooldownForTest()
        const out = (await delegateTaskTool.execute(
          { prompt: "scope-retry-401", scope: "file" } as never,
          ctx(dir),
        )) as string
        expect(out).toContain("[sub-agent explore error]")
        actions.push(await aceActionOfLastReceipt(parentId, dir))
      }
      expect(actions).toEqual([
        "RETRY_TRANSIENT",
        "RETRY_TRANSIENT",
        "RETRY_TRANSIENT",
        "REQUEST_HUMAN",
      ])
    } finally {
      todoSession.id = prevTodo
      clearSubAgentSessionFactory()
      clearSubAgentHistory()
      restore()
    }
  })

  test("429 mengaktifkan cooldown 60 dtk yang sudah ada", () => {
    for (const msg of [
      "rate limited (429): capacity_exhausted",
      "ProviderError: rate_limit_exceeded — too many requests",
      "HTTP 429 from upstream",
    ]) {
      expect(isProviderOutage(msg)).toBe(true)
    }
    // Bukan gangguan provider → jangan memicu jeda.
    expect(isProviderOutage("write_file failed: ENOENT")).toBe(false)
    expect(isProviderOutage("permission denied: allowlist")).toBe(false)
  })
})
