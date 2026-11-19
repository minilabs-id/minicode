// v7.33 audit — fail-closed receipt.
//
// Dua celah yang dulu terbuka (keduanya berujung pada efek committed + intent
// pending yang bisa dijalankan ulang recovery seolah eksekusi baru):
//   1. findIdempotentInvocation mengembalikan `proceed` saat journal tak terbaca.
//   2. executeCanonicalInvocation membuang `receipt.durable` dengan `void`.
//
// Test ini mengunci kontrak penggantinya: tolak dengan `pending`, dan keluarkan
// sinyal non-durable lewat seam `onReceiptLoss` (bukan lagi dibuang diam-diam).
// Mutation-scoped design dipertahankan: tool baca tidak menyentuh journal.

import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { isCanonicalEvidenceCovered, journalPath } from "../src/session/journal.ts"
import {
  type CanonicalScope,
  EvidenceIncompleteError,
  type EvidenceWriter,
  executeCanonicalInvocation,
  findIdempotentInvocation,
  IdempotentDuplicateError,
  persistEffectIntent,
  type ReceiptLossSignal,
  ReceiptNotDurableError,
  throwOnReceiptLoss,
} from "../src/session/verification.ts"

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-p210-audit-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows bisa sebentar menahan handle; OS yang membersihkan temp root.
  }
}

function scopeFor(
  sessionId: string,
  dir: string,
  overrides: Partial<CanonicalScope> = {},
): CanonicalScope {
  return { sessionId, threadId: `${sessionId}-thread`, cwd: dir, ...overrides }
}

function ctxFor(dir: string): ToolContext {
  return {
    signal: new AbortController().signal,
    state: { history: [], turnCount: 7, stepCount: 7 } as ToolContext["state"],
    cwd: dir,
    emit: () => {},
  }
}

function toolFor(name: string, execute: Tool["execute"]): Tool {
  return {
    name,
    description: `${name} audit tool`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    execute,
  }
}

/** Writer dengan receipt yang gagal jadi durable — simulasi kehilangan terminal. */
function nonDurableWriter(): EvidenceWriter {
  return {
    writeIntent: (input) => persistEffectIntent(input),
    writeReceipt: async () => ({ durable: false }),
  }
}

test("journal tak terbaca: lookup menolak dengan pending, bukan proceed", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-unreadable-journal"
    // Direktori di path journal → readFile melempar EISDIR (bukan ENOENT),
    // jadi loadJournal melaporkan "unreadable", bukan "absent"/"empty".
    mkdirSync(journalPath(sid, dir))
    const lookup = await findIdempotentInvocation({
      sessionId: sid,
      cwd: dir,
      idempotencyKey: "key-unreadable",
      argsHash: "hash-unreadable",
    })
    // KENAPA pending: status efek tidak diketahui. "proceed" akan menyetujui
    // eksekusi buta walau efeknya mungkin sudah committed.
    expect(lookup.status).toBe("pending")
    expect(lookup.status).not.toBe("proceed")
    expect(lookup.message).toContain("unreadable")
  } finally {
    cleanup(dir)
  }
})

test("journal tak terbaca + idempotency key: eksekusi ditolak sebelum tool jalan", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-unreadable-blocks-exec"
    mkdirSync(journalPath(sid, dir))
    let innerCalls = 0
    const tool = toolFor("write_file", async () => {
      innerCalls++
      return "should-not-run"
    })
    const result = await executeCanonicalInvocation(
      tool,
      { path: "a.txt" },
      ctxFor(dir),
      scopeFor(sid, dir, { idempotencyKeyFor: () => "key-blocked" }),
    ).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(IdempotentDuplicateError)
    expect((result as IdempotentDuplicateError).status).toBe("pending")
    expect(innerCalls).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("receipt non-durable: sinyal eksplisit keluar lewat seam onReceiptLoss", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-receipt-signal"
    const signals: ReceiptLossSignal[] = []
    const result = await executeCanonicalInvocation(
      toolFor("write_file", async () => "ok"),
      { path: "a.txt" },
      ctxFor(dir),
      scopeFor(sid, dir, {
        onReceiptLoss: (signal) => {
          signals.push(signal)
        },
      }),
      nonDurableWriter(),
    )
    // Outcome mentah tetap dikembalikan (kompatibilitas), TAPI sinyalnya kini
    // tidak lagi dibuang — inilah yang diuji.
    expect(result).toBe("ok")
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      kind: "non-durable-receipt",
      tool: "write_file",
      state: "committed",
      loss: "persistence",
    })
    expect(signals[0]!.invocationId).toContain(":s0:")
  } finally {
    cleanup(dir)
  }
})

test("seam penolak bawaan mengubah sinyal jadi galat eksplisit", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-receipt-throw"
    const failure = await executeCanonicalInvocation(
      toolFor("write_file", async () => "ok"),
      { path: "a.txt" },
      ctxFor(dir),
      scopeFor(sid, dir, { onReceiptLoss: throwOnReceiptLoss }),
      nonDurableWriter(),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ReceiptNotDurableError)
    expect(failure).toBeInstanceOf(EvidenceIncompleteError)
    const signal = (failure as ReceiptNotDurableError).signal
    expect(signal.kind).toBe("non-durable-receipt")
    expect(signal.tool).toBe("write_file")
    expect(signal.loss).toBe("persistence")
  } finally {
    cleanup(dir)
  }
})

test("tool baca tetap di luar journal (desain mutation-scoped tak diubah)", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-readonly-bypass"
    let seamCalls = 0
    expect(isCanonicalEvidenceCovered("read_file")).toBe(false)
    const result = await executeCanonicalInvocation(
      toolFor("read_file", async () => "content"),
      {},
      ctxFor(dir),
      scopeFor(sid, dir, {
        onReceiptLoss: () => {
          seamCalls++
        },
      }),
    )
    expect(result).toBe("content")
    expect(seamCalls).toBe(0)
    expect(existsSync(journalPath(sid, dir))).toBe(false)
  } finally {
    cleanup(dir)
  }
})
