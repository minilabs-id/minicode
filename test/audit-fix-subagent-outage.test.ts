// v0.33 — gangguan provider tidak boleh membuang kuota lewat delegasi berulang.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetProviderCooldownForTest,
  clearSubAgentSessionFactory,
  delegateTaskTool,
  isProviderOutage,
  setSubAgentSessionFactory,
} from "../src/tools/task.ts"

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
  __resetProviderCooldownForTest()
})

test("retry anak tidak diteruskan ke bus induk (tak menimpa status retry induk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-outage-retry-"))
  const emitted: Array<{ type?: string; kind?: string }> = []
  try {
    setSubAgentSessionFactory((async () => {
      const handlers = new Map<string, Set<(e: unknown) => void>>()
      return {
        events: {
          on: (type: string, h: (e: unknown) => void) => {
            const set = handlers.get(type) ?? new Set()
            set.add(h)
            handlers.set(type, set)
            return () => set.delete(h)
          },
        },
        abort: () => {},
        run: async () => {
          for (const h of handlers.get("provider:extension") ?? [])
            h({ type: "provider:extension", kind: "minicode:retry", data: { attempt: 1 } })
          return { finalText: "ok", usage: { steps: 1 } }
        },
      }
    }) as never)
    await delegateTaskTool.execute({ prompt: "cepat" }, {
      signal: new AbortController().signal,
      emit: (e: unknown) => emitted.push(e as { type?: string; kind?: string }),
      cwd: dir,
      permissionMode: "auto",
    } as never)
    expect(emitted.filter((e) => e.kind === "minicode:retry")).toHaveLength(0)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

test("isProviderOutage: hanya gangguan provider yang dikenali", () => {
  expect(isProviderOutage("server error: TipRouter: the provider is temporarily unavailable")).toBe(
    true,
  )
  expect(isProviderOutage("provider sent nothing for 60000ms (connection stalled)")).toBe(true)
  expect(isProviderOutage("402: quota_exceeded")).toBe(true)
  expect(isProviderOutage("permission denied: allowlist")).toBe(false)
  expect(isProviderOutage("write_file failed: ENOENT")).toBe(false)
})

test("anak gagal karena provider → partial ditandai belum terverifikasi & cooldown aktif", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-outage-"))
  let spawns = 0
  try {
    const outageFactory = async () => {
      spawns++
      return {
        events: { on: () => () => {} },
        abort: () => {},
        run: async () => {
          throw new Error("server error: TipRouter: the provider is temporarily unavailable")
        },
      }
    }
    setSubAgentSessionFactory(outageFactory as never)
    const first = (await delegateTaskTool.execute(
      { prompt: "audit area daemon" },
      ctx(dir),
    )) as string
    expect(first).toContain("temporarily unavailable")
    // Kalimat pembuka tak boleh dibaca sebagai temuan terverifikasi.
    expect(first).not.toContain("partial: I'll")

    setSubAgentSessionFactory((async () => {
      spawns++
      throw new Error("factory harusnya tidak dipanggil saat cooldown")
    }) as never)
    const second = (await delegateTaskTool.execute(
      { prompt: "audit area renderer" },
      ctx(dir),
    )) as string
    expect(second).toContain("[sub-agent skipped]")
    expect(spawns).toBe(1) // delegasi kedua benar-benar tak di-spawn
  } finally {
    // Windows bisa menahan handle DB sebentar (EBUSY); OS membersihkan temp root.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})
