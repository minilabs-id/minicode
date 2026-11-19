// Audit AGENT CONTROL SYSTEM — regresi untuk temuan verified.
//
// Cakupan:
//   #1 peringatan `[recovery]` juga dipancarkan pada kegagalan turn INTERAKTIF
//      (envelope struktural wiring + pembuktian data jurnal nyata — CLI penuh
//      tak dijalankan karena butuh provider & TUI),
//   #2 broker permissive non-TTY TIDAK boleh menyetujui `delegate_task`,
//   #4 "Always" tidak tersedia/tidak dipersist untuk `delegate_task`.
//
// Hermetik: tmpdir, tanpa jaringan, tanpa provider. Test TTY memakai
// Object.defineProperty seperti pola test/agent-contract.test.ts.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatDelegateRecoveryLine } from "../cli/recovery-warning.ts"
import {
  canAlwaysForCall,
  canPersistAlways,
  createPermissionHandler,
} from "../src/policy/permission.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  committedDelegatesSince,
} from "../src/session/journal.ts"

const roots: string[] = []

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-agentctl-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const d of roots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function depsFor(cwd: string): never {
  return {
    registry: { get: () => undefined, list: () => [] },
    permissions: {} as never,
    events: { emit: () => {}, on: () => () => {} },
    signal: new AbortController().signal,
    state: { messages: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 1000,
    cwd,
  } as never
}

async function withTty<T>(value: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.stdin.isTTY
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: prev, configurable: true })
  }
}

describe("AGENT-CONTROL-1 — envelope recovery pada kegagalan turn interaktif", () => {
  test("wiring: helper dipanggil di dua jalur catch (one-shot + pembungkus TUI)", async () => {
    const src = await Bun.file("cli/index.ts").text()

    // v7.40: SATU cek struktural kasar — helper dipanggil di kedua jalur
    // kegagalan. Detail implementasi (nama variabel, urutan bind, teks pesan)
    // sengaja tidak di-pin: bukti perilaku nyata ada di test berikutnya, jadi
    // pin tekstual yang rapuh hanya mengganggu refactor tanpa menambah jaminan.
    const calls = src.match(/await emitDelegateRecoveryLines\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test("data: baris yang dipancarkan helper berasal dari delegasi committed nyata", async () => {
    const dir = ws()
    const parent = "ac1-interactive"
    const intent = await appendMutationIntent({
      session: parent,
      tool: "delegate_task",
      cwd: dir,
      childSessionId: "sub_ac1",
    })
    await appendMutationTerminal(parent, dir, intent.id, intent.seq, "delegate_task", "committed", {
      note: "sub_ac1",
      childResult: { childStatus: "returned", resultSummary: "efek anak tetap ada" },
    } as never)

    // Sama persis dengan rantai `committedDelegatesSince → formatDelegateRecoveryLine`
    // yang dipanggil emitDelegateRecoveryLines di kedua jalur kegagalan.
    const rows = await committedDelegatesSince(parent, dir, 0)
    expect(rows).toHaveLength(1)
    const line = formatDelegateRecoveryLine(rows[0]!)
    expect(line).toContain("sub_ac1")
    expect(line).toContain("(observed child status: returned; receipt: committed)")
    expect(line).toContain("prior child output: efek anak tetap ada")
    expect(line).toContain("effects stand; verify before re-delegating")
  })
})

describe("AGENT-CONTROL-2 — broker non-TTY tak membuka gated tool", () => {
  test("delegate_task deny walau permissionAsk permissive + allowNonTtyAsk", async () => {
    const dir = ws()
    let asks = 0
    await withTty(false, async () => {
      const handler = createPermissionHandler({
        mode: "ask",
        root: dir,
        allowNonTtyAsk: true,
        ask: async () => {
          asks++
          return "allow"
        },
      })
      const d = await handler.check(
        { id: "ac2-delegate", name: "delegate_task", args: { prompt: "x" } } as never,
        depsFor(dir),
      )
      expect(d).toBe("deny")
      // Fail-closed sebelum prompt: broker tak pernah dipanggil untuk delegasi.
      expect(asks).toBe(0)
      expect(handler.describeDenial?.({ id: "ac2-delegate" } as never)).toBe(
        "gated approval unavailable",
      )
    })
  })

  test("kontrol: tool non-gated tetap lewat broker di non-TTY", async () => {
    const dir = ws()
    let asks = 0
    await withTty(false, async () => {
      const handler = createPermissionHandler({
        mode: "ask",
        root: dir,
        allowNonTtyAsk: true,
        ask: async () => {
          asks++
          return "allow"
        },
      })
      const d = await handler.check(
        {
          id: "ac2-write",
          name: "write_file",
          args: { path: join(dir, "a.txt"), content: "x" },
        } as never,
        depsFor(dir),
      )
      expect(d).toBe("allow")
      expect(asks).toBe(1)
    })
  })
})

describe("AGENT-CONTROL-4 — Always tidak reusable untuk delegate_task", () => {
  test("canAlwaysForCall menolak delegate_task tetapi mempertahankan tool biasa", () => {
    const args = { prompt: "sama persis" }
    expect(canPersistAlways(args)).toBe(true) // kontrak lama tak berubah
    expect(canAlwaysForCall({ name: "delegate_task", args } as never)).toBe(false)
    expect(
      canAlwaysForCall({ name: "write_file", args: { path: "a", content: "b" } } as never),
    ).toBe(true)
  })

  test("dua delegasi identik tetap butuh dua approval; view tak pernah ditawari Always", async () => {
    const dir = ws()
    const seenCanAlways: boolean[] = []
    let asks = 0
    await withTty(true, async () => {
      const handler = createPermissionHandler({
        mode: "ask",
        root: dir,
        ask: async (call) => {
          asks++
          seenCanAlways.push(call.canAlways === true)
          return "allow"
        },
      })
      const call = {
        id: `ac4-${asks}`,
        name: "delegate_task",
        args: { prompt: "delegasi identik" },
      } as never
      expect(await handler.check(call, depsFor(dir))).toBe("allow")
      expect(await handler.check(call, depsFor(dir))).toBe("allow")
      // Non-vakum: dua approval nyata diperlukan (tak ada grant reuse), dan
      // opsi "Always" memang disembunyikan di kedua kartu persetujuan.
      expect(asks).toBe(2)
      expect(seenCanAlways).toEqual([false, false])
    })
  })
})
