// v7.35 — kanal laporan inkremental child → induk.
//
// Dua lapis yang diuji (keduanya dulu TIDAK ada, lihat sesi audit ef40d265:
// 4 explore child timeout 600 dtk, yang sampai ke induk cuma kalimat pembuka):
//   1. tool layer: baris `[FINDING]` dari teks child diekstrak & di-emit sambil
//      jalan, lalu dipakai sebagai partial saat child gagal/timeout.
//   2. presentation: event `minicode:child-report` diterjemahkan ke event
//      `finding.detected` yang sudah ada (dengan penanda [EVALUATE]) supaya
//      induk melihat temuan di UI tanpa event type baru.

import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import {
  clearSubAgentSessionFactory,
  delegateTaskTool,
  type SubAgentSpec,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

function providerEnv(): () => void {
  const key = process.env.OPENAI_API_KEY
  const agent = process.env.AGENT_API_KEY
  if (!key && !agent) process.env.OPENAI_API_KEY = "sk-test-hermetic"
  return () => {
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
    if (agent === undefined) delete process.env.AGENT_API_KEY
    else process.env.AGENT_API_KEY = agent
  }
}

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: any) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: any) => void>()
      set.add(handler)
      handlers.set(type, set)
      return () => set.delete(handler)
    },
    emit(type, payload) {
      const set = handlers.get(type)
      if (set) for (const h of [...set]) h(payload)
    },
  }
}

test("delegate: temuan [FINDING] di-emit inkremental & dipakai saat child gagal", async () => {
  const restore = providerEnv()
  const dir = mkdtempSync(join(tmpdir(), "mc-child-report-"))
  const emitted: any[] = []
  const findings = [
    "high | src/x.ts:12 | policy bypass pada jail",
    "medium | src/y.ts:40 | timer melebihi batas",
  ]
  const factory = async (_spec: SubAgentSpec) => ({
    events: {
      on: (name: string, handler: (e: any) => void) => {
        if (name === "provider:text") {
          // Simulasi streaming: kalimat pembuka dulu, lalu findings satu per satu.
          queueMicrotask(() => {
            handler({ text: "I'll start by reading the files.\n" })
            for (const f of findings) handler({ text: `[FINDING] ${f}\n` })
          })
        }
        return () => {}
      },
    },
    run: async () => {
      throw new Error("simulated turn failure")
    },
  })
  setSubAgentSessionFactory(factory as never)
  try {
    const out = (await delegateTaskTool.execute({ prompt: "audit read-only", mode: "explore" }, {
      signal: new AbortController().signal,
      cwd: dir,
      emit: (e: unknown) => emitted.push(e),
    } as never)) as string

    // 1. Event laporan inkremental terkirim SEBELUM child selesai.
    const reports = emitted.filter((e) => e?.kind === "minicode:child-report")
    expect(reports).toHaveLength(2)
    expect(reports[0]?.data?.finding).toBe(findings[0])
    expect(reports[0]?.data?.needsEvaluation).toBe(true)
    expect(typeof reports[0]?.data?.forwardedChild).toBe("string")

    // 2. Partial pada jalur error memakai temuan, bukan kalimat pembuka.
    expect(out).toContain("policy bypass pada jail")
    expect(out).toContain("timer melebihi batas")
    expect(out).not.toContain("I'll start by reading")
  } finally {
    clearSubAgentSessionFactory()
    restore()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("delegate: deskripsi tool mengingatkan induk untuk mengevaluasi laporan", () => {
  expect(delegateTaskTool.description).toContain("EVALUATE")
  expect(delegateTaskTool.description).toContain("hypotheses")
})

test("adapter: child-report → finding.detected dengan penanda [EVALUATE]", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "parent" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))

  bus.emit("provider:extension", {
    type: "provider:extension",
    kind: "minicode:child-report",
    data: {
      forwardedChild: "sub_abc",
      childRunId: "run_abc",
      childLabel: "audit-ui-contract",
      finding: "high | app.ts:12 | off-by-one scroll",
      needsEvaluation: true,
    },
  })

  const found = events.filter((e) => e.type === "finding.detected")
  expect(found).toHaveLength(1)
  const f: any = found[0]
  expect(f.category).toBe("child-report")
  expect(f.severity).toBe("warning")
  expect(f.summary).toContain("[EVALUATE]")
  expect(f.summary).toContain("off-by-one scroll")
  expect(f.evidence).toEqual(["high | app.ts:12 | off-by-one scroll"])
  expect(f.sessionId).toBe("sub_abc")
  adapter.dispose()
})

test("adapter: child-report tanpa finding/childId diabaikan (tidak ada finding palsu)", () => {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "parent" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))

  bus.emit("provider:extension", {
    type: "provider:extension",
    kind: "minicode:child-report",
    data: { forwardedChild: "sub_abc", finding: "   " },
  })
  bus.emit("provider:extension", {
    type: "provider:extension",
    kind: "minicode:child-report",
    data: { finding: "tanpa child id" },
  })

  expect(events.filter((e) => e.type === "finding.detected")).toHaveLength(0)
  adapter.dispose()
})
