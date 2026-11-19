// v7.41 audit #1/#2/#4 — submodule idempotency MATI di produksi + feed order.
//
// Temuan utama (#1): scope CanonicalScope produksi dibangun tanpa
// `idempotencyKeyFor`, sehingga `executeCanonicalInvocation` selalu jatuh ke
// `runOnce()` — `findIdempotentInvocation` + `runOncePerIdempotencyKey` hanya
// pernah dipanggil test. On transient failure `runPromptWithVerify` mengulang
// prompt dan tool effect (write_file/edit/bash/git_commit) bisa ter-apply dua
// kali. Test ini mengunci kunci produksi + perilaku dedupnya lewat seam
// `executeCanonicalInvocation` (hermetik: jurnal lokal, fake tool, tanpa kernel,
// tanpa provider, tanpa SQLite sesi).
//
// #2 (F2): event domain non-durable dulu diterbitkan langsung, mendahului event
// durable yang masih menunggu append → subscriber Seq-keyed menerima seq besar
// lebih dulu. Diuji lewat helper `createOrderedDomainPublisher` murni.
//
// #4 (F4): double persist pada abort tidak hermetik diuji di sini (butuh sesi
// penuh + writer epoch guard); dicatat sebagai residual di laporan.

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { createOrderedDomainPublisher, productionIdempotencyKey } from "../cli/setup.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { finalizeJournal } from "../src/session/journal.ts"
import {
  buildIdempotencyKey,
  type CanonicalScope,
  type EvidenceWriter,
  executeCanonicalInvocation,
  IdempotentDuplicateError,
  persistEffectIntent,
  ReceiptNotDurableError,
  throwOnReceiptLoss,
} from "../src/session/verification.ts"

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-prod-idem-"))
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
  generation: number,
  overrides: Partial<CanonicalScope> = {},
): CanonicalScope {
  return {
    sessionId,
    threadId: `${sessionId}-thread`,
    cwd: dir,
    // Ini tepat closure yang dipasang di scope produksi (cli/setup.ts).
    idempotencyKeyFor: (tool, args) => productionIdempotencyKey(tool, args, generation),
    ...overrides,
  }
}

function ctxFor(dir: string, turn = 7): ToolContext {
  return {
    signal: new AbortController().signal,
    state: { history: [], turnCount: turn, stepCount: turn } as ToolContext["state"],
    cwd: dir,
    emit: () => {},
  }
}

function toolFor(name: string, execute: Tool["execute"]): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
    execute,
  }
}

// ── #1: kunci produksi ──────────────────────────────────────────────────────

test("kunci idempotency produksi terdefinisi, stabil, dan bisa dinormalisasi", () => {
  const key = productionIdempotencyKey("write_file", { path: "a.txt" }, 3)
  // Bukan undefined → `executeCanonicalInvocation` tak akan jatuh ke runOnce().
  expect(typeof key).toBe("string")
  expect(key.length).toBeGreaterThan(0)
  expect(() => buildIdempotencyKey("sid", key)).not.toThrow()
  // Stabil untuk tool+args+generasi yang sama (sama seperti retry recovery).
  expect(productionIdempotencyKey("write_file", { path: "a.txt" }, 3)).toBe(key)
  // Generasi berbeda (turn baru) → kunci berbeda.
  expect(productionIdempotencyKey("write_file", { path: "a.txt" }, 4)).not.toBe(key)
  // argsHash kanonik: urutan kunci objek tak mengubah kunci.
  expect(productionIdempotencyKey("write_file", { path: "a.txt", mode: "x" }, 3)).toBe(
    productionIdempotencyKey("write_file", { mode: "x", path: "a.txt" }, 3),
  )
})

test("retry dalam satu recovery window: eksekusi kedua ditolak, efek pertama tetap", async () => {
  const dir = tmpRoot()
  try {
    const sid = "prod-idem-retry"
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "first-effect"
    })
    const args = { path: "a.txt", content: "x" }
    // Generasi SAMA di dua pemanggilan = satu window recovery yang sama.
    const scope = scopeFor(sid, dir, 1)
    await expect(executeCanonicalInvocation(tool, args, ctxFor(dir), scope)).resolves.toBe(
      "first-effect",
    )
    await finalizeJournal(sid, dir)
    const retry = await executeCanonicalInvocation(tool, args, ctxFor(dir), scope).catch((e) => e)
    expect(retry).toBeInstanceOf(IdempotentDuplicateError)
    expect((retry as IdempotentDuplicateError).status).toBe("committed")
    // Efek hanya berjalan SATU kali — inilah yang hilang sebelum perbaikan.
    expect(calls).toBe(1)
  } finally {
    cleanup(dir)
  }
})

test("call identik di generasi baru (turn berikutnya) tetap diizinkan", async () => {
  const dir = tmpRoot()
  try {
    const sid = "prod-idem-newgen"
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return `effect-${calls}`
    })
    const args = { path: "a.txt", content: "x" }
    const scopeGen1 = scopeFor(sid, dir, 1)
    const scopeGen2 = scopeFor(sid, dir, 2)
    await expect(executeCanonicalInvocation(tool, args, ctxFor(dir, 7), scopeGen1)).resolves.toBe(
      "effect-1",
    )
    // Generasi naik → kunci berbeda → dedup TIDAK memblokir tulis baru yang sah.
    await expect(executeCanonicalInvocation(tool, args, ctxFor(dir, 8), scopeGen2)).resolves.toBe(
      "effect-2",
    )
    expect(calls).toBe(2)
  } finally {
    cleanup(dir)
  }
})

test("receipt hilang: retry ditolak fail-closed, bukan double-execute", async () => {
  const dir = tmpRoot()
  try {
    const sid = "prod-idem-receipt-loss"
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "committed-in-world"
    })
    const args = { path: "a.txt", content: "y" }
    const scope = scopeFor(sid, dir, 1, { onReceiptLoss: throwOnReceiptLoss })
    // SimulasiBUG2: efek committed di dunia nyata, receipt gagal ditulis durable
    // → onReceiptLoss melempar → model diundang retry buta.
    const lossyWriter: EvidenceWriter = {
      writeIntent: (input) => persistEffectIntent(input),
      writeReceipt: async () => ({ durable: false }),
    }
    const first = await executeCanonicalInvocation(
      tool,
      args,
      ctxFor(dir),
      scope,
      lossyWriter,
    ).catch((e) => e)
    expect(first).toBeInstanceOf(ReceiptNotDurableError)
    expect(calls).toBe(1)

    // Retry (masih generasi yang sama) dengan writer sehat: kunci yang sama
    // menemukan intent pending → ditolak, efek TIDAK dijalankan ulang.
    const retry = await executeCanonicalInvocation(
      tool,
      args,
      ctxFor(dir),
      scopeFor(sid, dir, 1, { onReceiptLoss: throwOnReceiptLoss }),
    ).catch((e) => e)
    expect(retry).toBeInstanceOf(IdempotentDuplicateError)
    // Status "pending" (bukan "committed") karena receipt-nya yang hilang,
    // namun tetap penolakan fail-closed — inilah yang diinginkan.
    expect((retry as IdempotentDuplicateError).status).toBe("pending")
    expect(calls).toBe(1)
  } finally {
    cleanup(dir)
  }
})

// ── #2 (F2): urutan publish domain ──────────────────────────────────────────

function domainEvent(seq: number, durable: boolean): DomainEvent {
  return {
    type: durable ? "user.message" : "model.delta",
    sessionId: "sid",
    turnId: 1,
    eventSeq: seq,
    ts: seq,
    ...(durable ? { text: "hello" } : { text: "delta" }),
  } as DomainEvent
}

test("durable sebelum non-durable: subscriber melihat durable lebih dulu", () => {
  const seen: number[] = []
  const durable = (e: DomainEvent) => e.type !== "model.delta"
  const pub = createOrderedDomainPublisher((e) => seen.push(e.eventSeq), durable)

  // Durable seq 5 belum dikonfirmasi append → ditahan.
  pub.enqueue(domainEvent(5, true))
  // Non-durable seq 6 datang lebih dulu: TIDAK boleh dideliver sebelum seq 5.
  pub.enqueue(domainEvent(6, false))
  expect(seen).toEqual([])
  expect(pub.pending().map((e) => e.eventSeq)).toEqual([5, 6])

  // Append seq 5 sukses → gerbang melepas 5 lalu 6 secara berurutan.
  pub.confirmDurable(5)
  expect(seen).toEqual([5, 6])
  expect(pub.pending()).toHaveLength(0)
})

test("non-durable tanpa durable yang tertahan langsung lewat (tak ada delay)", () => {
  const seen: number[] = []
  const durable = (e: DomainEvent) => e.type !== "model.delta"
  const pub = createOrderedDomainPublisher((e) => seen.push(e.eventSeq), durable)
  pub.enqueue(domainEvent(1, false))
  expect(seen).toEqual([1])
})

test("append gagal: event dibuang, tak ikut terbit saat batch berikutnya sukses", () => {
  const seen: number[] = []
  const durable = (e: DomainEvent) => e.type !== "model.delta"
  const pub = createOrderedDomainPublisher((e) => seen.push(e.eventSeq), durable)
  const failed = domainEvent(5, true)
  pub.enqueue(failed)
  pub.enqueue(domainEvent(6, false))
  expect(seen).toEqual([])
  // Append seq 5 gagal → buang. Non-durable 6 kini bebas (urutan tetap benar).
  pub.drop([failed])
  expect(seen).toEqual([6])
  expect(pub.pending()).toHaveLength(0)
  // Batch baru seq 7 sukses → terbit normal, tak ada "hantu" seq 5.
  const fresh = domainEvent(7, true)
  pub.enqueue(fresh)
  pub.confirmDurable(7)
  expect(seen).toEqual([6, 7])
})
