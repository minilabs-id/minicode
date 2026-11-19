// v7.39 — audit P0-2 / P1-3 regression tests.
//
// P0-2: `findIdempotentInvocation` harus memperlakukan terminal `unknown`
// sebagai `pending` (refuse + verifikasi), bukan `proceed` (blind re-execution).
// P1-3: `takeoverEpochUnderLease` harus melepas lease yang baru diambil bila
// baca/takeover epoch melempar, lalu melempar ulang galat aslinya (fail-closed).
//
// Hermetic: journal lokal di temp root; tak ada jaringan / kernel / sesi nyata.

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import {
  acquireSessionWriter,
  type LeaseTakeoverDeps,
  releaseSessionWriter,
  takeoverEpochUnderLease,
} from "../src/session/authority.ts"
import { appendMutationTerminal, hashArgs } from "../src/session/journal.ts"
import {
  buildIdempotencyKey,
  executeCanonicalInvocation,
  findIdempotentInvocation,
  IdempotentDuplicateError,
} from "../src/session/verification.ts"
import { resetTaskStoreHandles } from "../src/task/store.ts"
import { isolateHomeForTests } from "./helpers/hermetic-home.ts"

isolateHomeForTests()

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    resetTaskStoreHandles()
  } catch {
    // abai: hanya guard handle SQLite antar-test.
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows bisa menahan handle sebentar; OS membersihkan temp root.
  }
}

function ctxFor(dir: string): ToolContext {
  return {
    signal: new AbortController().signal,
    state: { history: [], turnCount: 0, stepCount: 0 } as ToolContext["state"],
    cwd: dir,
    emit: () => {},
  }
}

function toolFor(name: string, execute: Tool["execute"]): Tool {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
  }
}

async function writeUnknownTerminal(opts: {
  sid: string
  dir: string
  baseKey: string
  args: unknown
  seq?: number
  invocationId?: string
}): Promise<{ idempotencyKey: string; argsHash: string }> {
  const idempotencyKey = buildIdempotencyKey(opts.sid, opts.baseKey)
  const argsHash = hashArgs(opts.args)
  const seq = opts.seq ?? 0
  await appendMutationTerminal(
    opts.sid,
    opts.dir,
    `${opts.sid}:${seq}`,
    seq,
    "write_file",
    "unknown",
    { note: idempotencyKey },
    undefined,
    { argsHash, invocationId: opts.invocationId ?? `inv-${opts.sid}-${seq}` },
  )
  return { idempotencyKey, argsHash }
}

// ── P0-2 ────────────────────────────────────────────────────────────────────

test("P0-2: findIdempotentInvocation mengembalikan pending untuk terminal unknown", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-unknown-lookup"
    const args = { path: "a.txt" }
    const { idempotencyKey, argsHash } = await writeUnknownTerminal({
      sid,
      dir,
      baseKey: "op-unknown",
      args,
    })
    const lookup = await findIdempotentInvocation({
      sessionId: sid,
      cwd: dir,
      idempotencyKey,
      argsHash,
    })
    expect(lookup.status).toBe("pending")
  } finally {
    cleanup(dir)
  }
})

test("P0-2: executeCanonicalInvocation menolak menjalankan tool pada terminal unknown", async () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-unknown-exec"
    const args = { path: "a.txt" }
    const baseKey = "op-unknown-exec"
    await writeUnknownTerminal({ sid, dir, baseKey, args })
    let calls = 0
    const tool = toolFor("write_file", async () => {
      calls++
      return "should-not-run"
    })
    const scope = {
      sessionId: sid,
      threadId: `${sid}-thread`,
      cwd: dir,
      idempotencyKeyFor: () => baseKey,
    }
    const err = await executeCanonicalInvocation(tool, args, ctxFor(dir), scope).catch(
      (error: unknown) => error,
    )
    expect(err).toBeInstanceOf(IdempotentDuplicateError)
    expect((err as IdempotentDuplicateError).status).toBe("pending")
    expect((err as IdempotentDuplicateError).code).toBe("UNKNOWN_IDEMPOTENT_INVOCATION")
    expect(calls).toBe(0)
  } finally {
    cleanup(dir)
  }
})

// ── P1-3 ────────────────────────────────────────────────────────────────────

test("P1-3: takeover melempar → lease dilepas best-effort lalu galat dilempar ulang", () => {
  const dir = tmpRoot()
  try {
    const sid = "audit-lease-throw"
    const token = "tok-baru"
    const boom = new Error("SQLITE_BUSY")
    const released: Array<[string, string, string | undefined]> = []
    let takeoverCalls = 0
    const deps: LeaseTakeoverDeps = {
      readEpoch: (() => 3) as LeaseTakeoverDeps["readEpoch"],
      takeover: (() => {
        takeoverCalls++
        throw boom
      }) as LeaseTakeoverDeps["takeover"],
      release: ((s: string, t: string, c?: string) => {
        released.push([s, t, c])
        return true
      }) as LeaseTakeoverDeps["release"],
    }
    expect(() =>
      takeoverEpochUnderLease(
        { sessionId: sid, token, cwd: dir, bootId: "boot-b", preOwnerToken: "tok-lama" },
        deps,
      ),
    ).toThrow(boom)
    expect(takeoverCalls).toBe(1)
    expect(released).toEqual([[sid, token, dir]])
  } finally {
    cleanup(dir)
  }
})

test("P1-3: takeover melempar tapi release juga melempar → galat takeover tetap menang", () => {
  const dir = tmpRoot()
  try {
    const boom = new Error("takeover-gagal")
    const deps: LeaseTakeoverDeps = {
      readEpoch: (() => 0) as LeaseTakeoverDeps["readEpoch"],
      takeover: (() => {
        throw boom
      }) as LeaseTakeoverDeps["takeover"],
      release: (() => {
        throw new Error("release-gagal")
      }) as LeaseTakeoverDeps["release"],
    }
    expect(() =>
      takeoverEpochUnderLease(
        {
          sessionId: "audit-lease-both-throw",
          token: "tok",
          cwd: dir,
          bootId: "boot",
          preOwnerToken: "lama",
        },
        deps,
      ),
    ).toThrow(boom)
  } finally {
    cleanup(dir)
  }
})

test("P1-3: jalur fresh (tanpa takeover) hanya baca epoch, tanpa release", () => {
  const dir = tmpRoot()
  try {
    let readCalls = 0
    let takeoverCalls = 0
    const released: unknown[] = []
    const deps: LeaseTakeoverDeps = {
      readEpoch: (() => {
        readCalls++
        return 7
      }) as LeaseTakeoverDeps["readEpoch"],
      takeover: (() => {
        takeoverCalls++
        return { epoch: 8, outcome: "advanced" as const }
      }) as LeaseTakeoverDeps["takeover"],
      release: ((...args: unknown[]) => {
        released.push(args)
        return true
      }) as LeaseTakeoverDeps["release"],
    }
    const out = takeoverEpochUnderLease(
      {
        sessionId: "audit-lease-fresh",
        token: "tok",
        cwd: dir,
        bootId: "boot",
        preOwnerToken: undefined,
      },
      deps,
    )
    expect(out).toEqual({ epoch: 7, tookOver: false })
    expect(readCalls).toBe(1)
    expect(takeoverCalls).toBe(0)
    expect(released).toHaveLength(0)
  } finally {
    cleanup(dir)
  }
})

test("P1-3: re-acquire token sendiri juga tak menyentuh takeover/release", () => {
  const dir = tmpRoot()
  try {
    let takeoverCalls = 0
    const deps: LeaseTakeoverDeps = {
      readEpoch: (() => 5) as LeaseTakeoverDeps["readEpoch"],
      takeover: (() => {
        takeoverCalls++
        return { epoch: 6, outcome: "advanced" as const }
      }) as LeaseTakeoverDeps["takeover"],
      release: (() => true) as LeaseTakeoverDeps["release"],
    }
    const out = takeoverEpochUnderLease(
      {
        sessionId: "audit-lease-reacquire",
        token: "tok-sama",
        cwd: dir,
        bootId: "boot",
        preOwnerToken: "tok-sama",
      },
      deps,
    )
    expect(out).toEqual({ epoch: 5, tookOver: false })
    expect(takeoverCalls).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("P1-3: takeover sukses menaikkan epoch tanpa melepas lease", () => {
  const dir = tmpRoot()
  try {
    let released = 0
    const deps: LeaseTakeoverDeps = {
      readEpoch: (() => 2) as LeaseTakeoverDeps["readEpoch"],
      takeover: (() => ({
        epoch: 3,
        outcome: "advanced" as const,
      })) as LeaseTakeoverDeps["takeover"],
      release: (() => {
        released++
        return true
      }) as LeaseTakeoverDeps["release"],
    }
    const out = takeoverEpochUnderLease(
      {
        sessionId: "audit-lease-ok",
        token: "tok",
        cwd: dir,
        bootId: "boot",
        preOwnerToken: "lama",
      },
      deps,
    )
    expect(out).toEqual({ epoch: 3, tookOver: true })
    expect(released).toBe(0)
  } finally {
    cleanup(dir)
  }
})

test("P1-3: acquireSessionWriter nyata — jalur fresh tetap epoch 0, tanpa takeover", () => {
  const dir = tmpRoot()
  try {
    resetTaskStoreHandles()
    const a = acquireSessionWriter({ sessionId: "audit-real-fresh", cwd: dir, bootId: "boot-a" })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.admission.fresh).toBe(true)
    expect(a.admission.tookOver).toBe(false)
    expect(a.admission.epoch).toBe(0)
    expect(releaseSessionWriter("audit-real-fresh", a.admission.token, dir)).toBe(true)
  } finally {
    cleanup(dir)
  }
})
