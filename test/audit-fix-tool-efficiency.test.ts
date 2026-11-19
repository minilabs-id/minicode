// Audit finding L1/L2/L3/L4/L5/L6/L8/L9 — regresi efisiensi & determinisme tool.
// Hermetic: fetch di-stub, filesystem pakai tmpdir, tanpa jaringan/backend sandbox.
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bashKillTool, bashTool } from "../src/tools/bash.ts"
import { codeRunTimeoutError } from "../src/tools/code_run.ts"
import { globTool } from "../src/tools/glob.ts"
import { RIPGREP_TIMEOUT_MARKER, ripgrepTimeoutEmptyMessage } from "../src/tools/grep.ts"
import { clampTopK } from "../src/tools/memory.ts"
import { webSearchTool } from "../src/tools/web_search.ts"

const originalFetch = globalThis.fetch
const savedEnv = {
  tavily: process.env.TAVILY_API_KEY,
  brave: process.env.BRAVE_API_KEY,
  ddg: process.env.MINICODE_ALLOW_DDG,
  engine: process.env.MINICODE_GREP_ENGINE,
}

function restoreEnv(): void {
  for (const [name, value] of [
    ["TAVILY_API_KEY", savedEnv.tavily],
    ["BRAVE_API_KEY", savedEnv.brave],
    ["MINICODE_ALLOW_DDG", savedEnv.ddg],
    ["MINICODE_GREP_ENGINE", savedEnv.engine],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreEnv()
})

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── L1: abort race pada web_search ──
// Signal palsu mencatat URUTAN operasi: listener harus dipasang SEBELUM
// `aborted` dibaca. Urutan terbalik = celah abort race (check→add) hilang.
function orderingSignal(): { signal: AbortSignal; ops: string[] } {
  const ops: string[] = []
  const aborted = false
  const signal = {
    reason: new Error("parent-aborted"),
    throwIfAborted() {},
    addEventListener() {
      ops.push("addEventListener")
    },
    removeEventListener() {},
  } as unknown as AbortSignal
  Object.defineProperty(signal, "aborted", {
    get() {
      ops.push("read:aborted")
      return aborted
    },
    configurable: true,
  })
  return { signal, ops }
}

function expectListenerBeforeAbortCheck(ops: string[]): void {
  const add = ops.indexOf("addEventListener")
  const read = ops.indexOf("read:aborted")
  expect(add).toBeGreaterThanOrEqual(0)
  expect(read).toBeGreaterThanOrEqual(0)
  // Listener terpasang dulu, baru status aborted dicek (pola web_fetch.ts).
  expect(add).toBeLessThan(read)
}

test("L1a: keyless (withKeylessRequest) memasang abort listener sebelum cek aborted", async () => {
  delete process.env.TAVILY_API_KEY
  delete process.env.BRAVE_API_KEY
  delete process.env.MINICODE_ALLOW_DDG
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch
  const { signal, ops } = orderingSignal()
  await expect(
    webSearchTool.execute({ query: "race", count: 1 }, { signal } as never),
  ).rejects.toThrow()
  expectListenerBeforeAbortCheck(ops)
})

test("L1b: jalur Tavily memasang abort listener sebelum cek aborted", async () => {
  process.env.TAVILY_API_KEY = "test-key"
  delete process.env.BRAVE_API_KEY
  globalThis.fetch = (async () =>
    Response.json({
      results: [{ title: "r", url: "https://example.invalid", content: "ok" }],
    })) as unknown as typeof fetch
  const { signal, ops } = orderingSignal()
  const out = String(await webSearchTool.execute({ query: "race", count: 1 }, { signal } as never))
  expect(out).toContain("tavily 1 results")
  expectListenerBeforeAbortCheck(ops)
})

// ── L4: urutan deterministik glob/grep ──
test("L4a: glob mengembalikan path terurut (tak bergantung urutan readdir)", async () => {
  const dir = tmpRoot("mc-eff-glob-")
  try {
    // Sengaja dibuat tidak terurut secara alfabetis.
    for (const name of ["zeta.ts", "alpha.ts", "mid.ts"]) {
      writeFileSync(join(dir, name), "export {}\n")
    }
    const res = String(
      await globTool.execute({ pattern: "*.ts" }, {
        signal: new AbortController().signal,
        cwd: dir,
      } as never),
    )
    expect(res.split("\n")).toEqual(["alpha.ts", "mid.ts", "zeta.ts"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("L4b: fallback JS grep mengembalikan match terurut", async () => {
  const dir = tmpRoot("mc-eff-grep-")
  try {
    process.env.MINICODE_GREP_ENGINE = "js"
    for (const name of ["z.txt", "a.txt", "m.txt"]) {
      writeFileSync(join(dir, name), "MARKER_EFF\n")
    }
    const res = String(
      await (await import("../src/tools/grep.ts")).grepTool.execute({ pattern: "MARKER_EFF" }, {
        signal: new AbortController().signal,
        cwd: dir,
      } as never),
    )
    const files = res.split("\n").map((line) => line.split(":")[0])
    expect(files).toEqual(["a.txt", "m.txt", "z.txt"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── L5: topK dibatasi [1, 25] ──
test("L5: clampTopK membatasi nilai liar dan fallback ke 5", () => {
  expect(clampTopK(1e9)).toBe(25)
  expect(clampTopK(0)).toBe(1)
  expect(clampTopK(-5)).toBe(1)
  expect(clampTopK(Number.NaN)).toBe(5)
  expect(clampTopK(undefined)).toBe(5)
  expect(clampTopK(7)).toBe(7)
  expect(clampTopK(25)).toBe(25)
})

// ── L6: timeout ripgrep dengan nol hit ≠ "no matches" ──
test("L6: marker timeout ripgrep konsisten dan pesan kosong beda dari miss asli", () => {
  expect(RIPGREP_TIMEOUT_MARKER).toContain("timeout")
  const msg = ripgrepTimeoutEmptyMessage("foo", ".")
  expect(msg).toContain("timed out")
  expect(msg).not.toContain("no matches")
  expect(msg).toContain("/foo/")
})

// ── L8: code_run timeout melempar error, bukan string sukses ──
test("L8: codeRunTimeoutError menghasilkan Error dengan tag TOOL_OUTCOME yang sama dengan bash", () => {
  const err = codeRunTimeoutError(500, "partial text")
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toContain("[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT")
  expect(err.message).toContain("timeout_ms=500")
  expect(err.message).toContain("partial text")
  const empty = codeRunTimeoutError(250, "")
  expect(empty.message).toContain("--- partial output ---\n(none)")
})

// ── L9: anggaran output bash dipakai bersama stdout+stderr ──
test("L9: stdout+stderr gabungan di-cap ~20k (bukan 40k)", async () => {
  const rt = JSON.stringify(process.execPath)
  const cmd = `${rt} -e "process.stdout.write('o'.repeat(15000));process.stderr.write('e'.repeat(15000))"`
  const res = String(
    await bashTool.execute({ cmd, timeoutMs: 20_000 }, {
      signal: new AbortController().signal,
      cwd: process.cwd(),
    } as never),
  )
  // Cap lama per-stream menghasilkan ~30k; kini total benar-benar ≤ 20k.
  expect(res.length).toBeLessThanOrEqual(21_000)
  expect(res).toContain("[stderr]")
  expect(res).toContain("… [output truncated]")
})

// ── L2/L3: cleanup & timer eskalasi bash ──
test("L2: close normal melepaskan abort listener", async () => {
  const signal = new AbortController().signal
  const remove = spyOn(signal, "removeEventListener")
  await bashTool.execute({ cmd: "echo cleanup-ok" }, { signal, cwd: process.cwd() } as never)
  expect(remove).toHaveBeenCalled()
  remove.mockRestore()
})

test("L3: bash_kill kedua membatalkan timer eskalasi pertama", async () => {
  const clear = spyOn(globalThis, "clearTimeout")
  try {
    const rt = JSON.stringify(process.execPath)
    const dir = tmpRoot("mc-eff-kill-")
    const cmd = `${rt} -e "setInterval(()=>{},1000)"`
    const started = String(
      await bashTool.execute({ cmd, background: true }, {
        signal: new AbortController().signal,
        cwd: dir,
      } as never),
    )
    const id = /background job started: (\S+)/.exec(started)?.[1]
    expect(id).toBeTruthy()
    const ctx = { signal: new AbortController().signal } as never
    // Kedua execute() berjalan sinkron (tak ada await di dalamnya) sebelum
    // event `close` sempat menandai job done — jadi keduanya membuat timer.
    const first = bashKillTool.execute({ id }, ctx)
    const before = clear.mock.calls.length
    const second = bashKillTool.execute({ id }, ctx)
    // v7.32 (L3): clearTimeout dipanggil sebelum timer kedua dipasang.
    expect(clear.mock.calls.length).toBeGreaterThan(before)
    await Promise.all([first, second])
    rmSync(dir, { recursive: true, force: true })
  } finally {
    clear.mockRestore()
  }
})
