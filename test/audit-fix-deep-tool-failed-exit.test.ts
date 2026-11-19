// Audit finding 1: tool shell/git mengembalikan `exit N\n…` sebagai string biasa
// (isError unset). Tanpa deteksi di adapter, bridge menerjemahkannya jadi
// status "completed" tanpa pesan dan ledger transkrip menyembunyikan kegagalan.
//
// v7.33: tiga test di bawah adalah UNIT TEST klasifikasi adapter — mereka
// menyuntik string `exit N` ke bus tiruan, BUKAN menjalankan bash/git sungguhan.
// Di bawah juga ada SATU integration test nyata yang membuktikan bash memang
// menghasilkan awalan `exit 7` (kontrak yang diklaim finding ini).
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { toPresentationEvent } from "../cli/bootstrap/presentation-bridge.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent, EventBusLike } from "../src/presentation/events.ts"
import { bashTool } from "../src/tools/bash.ts"

function fakeBus(): EventBusLike & { emit: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(e: unknown) => void>()
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

function runExit(content: string, name = "git_push", isError = false): DomainEvent[] {
  const bus = fakeBus()
  const adapter = createPresentationAdapter(bus, { sessionId: "s1" })
  const events: DomainEvent[] = []
  adapter.onEvent((e) => events.push(e))
  bus.emit("execution:started", {
    execution: { call: { id: "call-1", name, args: {} } },
  })
  bus.emit("execution:completed", {
    execution: {
      call: { id: "call-1", name, args: {} },
      result: { isError, content },
    },
  })
  adapter.dispose()
  return events
}

test("git exit 128 → tool.failed berm pesan exit, BUKAN tool.completed", () => {
  const events = runExit("exit 128\nfatal: could not read Username for remote")
  const failed = events.find((e) => e.type === "tool.failed") as
    | { type: string; message?: string }
    | undefined
  expect(failed).toBeTruthy()
  expect(failed!.message).toContain("exit 128")
  expect(events.some((e) => e.type === "tool.completed")).toBe(false)
})

test("bridge memetakan kegagalan exit jadi status failed + pesan exit (bukan completed)", () => {
  const events = runExit("exit 1\nerror: test gagal", "bash")
  const failed = events.find((e) => e.type === "tool.failed")!
  const ui = toPresentationEvent(failed)! as unknown as {
    status: string
    message?: string
  }
  expect(ui.status).toBe("failed")
  // Pesan = baris exit (sesuai kontrak finding): ini yang tampil di ledger.
  expect(ui.message).toContain("exit 1")
})

test("sukses biasa tetap tool.completed, error isError:true tetap tool.failed", () => {
  const ok = runExit("ok\nsemua beres")
  expect(ok.some((e) => e.type === "tool.completed")).toBe(true)
  expect(ok.some((e) => e.type === "tool.failed")).toBe(false)

  const err = runExit("boom", "bash", true)
  expect(err.some((e) => e.type === "tool.failed")).toBe(true)
  expect(err.some((e) => e.type === "tool.completed")).toBe(false)
})

// Integration test nyata: kontrak `exit N` di atas berasal dari bash sungguhan,
// bukan cuma string buatan. Tanpa ini klaim finding hanya diuji dengan data
// sintetis (bisa salah bila bash berubah format).
test("bash exit 7 nyata → hasil tool diawali 'exit 7' (bukan cuma string sintetis)", async () => {
  const d = mkdtempSync(join(tmpdir(), "audit-bash-exit-"))
  const savedSandbox = process.env.MINICODE_SANDBOX
  // Jalur direct spawn: sandbox eksplisit tanpa backend akan menolak, jadi
  // pastikan tidak ada flag sandbox yang tersisa dari test lain.
  delete process.env.MINICODE_SANDBOX
  try {
    const ctx = { signal: new AbortController().signal, cwd: d } as never
    const r = (await bashTool.execute({ cmd: "exit 7" }, ctx)) as string
    expect(typeof r).toBe("string")
    expect(r.startsWith("exit 7")).toBe(true)
  } finally {
    if (savedSandbox === undefined) delete process.env.MINICODE_SANDBOX
    else process.env.MINICODE_SANDBOX = savedSandbox
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})
