// v7.33 audit — cakupan E2E /shell handoff yang sebelumnya hilang dari peta proteksi.
//
// Kontrak v7.32: `/shell` melepas alt-screen + raw mode, spawn shell asli dengan
// stdio:inherit, lalu reacquireTerminal(); jalur non-TTY / tanpa hook ditolak
// fail-closed. Handler (cli/commands.ts) diuji dengan injeksi nyata di sini.
// Host (cli/tui.ts) adalah arrow function inline yang TIDAK diekspor, jadi urutan
// spawn/release/reacquire-nya hanya bisa dibuktikan struktural — lihat test
// "structural guard, not E2E" di bawah (jangan diklaim sebagai E2E).

import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { captureOutput } from "./helpers/capture.ts"

beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

function dummyCtx(extra: Partial<CommandContext> = {}): CommandContext {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }
  return {
    sessionId: "test-sess-shell",
    cwd: process.cwd(),
    usage: {
      get: () => usage,
      getSession: () => usage,
      reset: () => {},
      modelUsed: () => ({ effective: undefined, provider: undefined }),
    },
    skills: [],
    toolsCount: 1,
    setModelOverride: () => {},
    getContextTokens: () => 1024,
    budgetState: () => "ok" as const,
    ...extra,
  }
}

function sliceBlock(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  if (from < 0) throw new Error(`penanda awal tidak ditemukan: ${start}`)
  const to = src.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`penanda akhir tidak ditemukan: ${end}`)
  return src.slice(from, to)
}

function shellCaseSource(): string {
  // Ambil HANYA blok `case "shell"` supaya `spawn()` di resumeById tidak bikin
  // false positive. commands.ts memang punya spawn untuk /sessions <id>.
  const src = readFileSync(join(import.meta.dir, "..", "cli", "commands.ts"), "utf8")
  return sliceBlock(src, 'case "shell": {', 'case "init": {')
}

test("/shell meneruskan argumen ke hook withShell yang disuntikkan", async () => {
  const received: string[] = []
  const ctx = dummyCtx({
    withShell: async (cmd: string) => {
      received.push(cmd)
    },
  })
  const { value } = await captureOutput(() => handleBuiltinCommand("/shell echo hi", ctx))
  // KENAPA ini E2Ehandler: hook injeksi adalah satu-satunya jalur spawn di
  // command layer, jadi memanggilnya = membuktikan handoff terjadi.
  expect(value.handled).toBe(true)
  expect(received).toEqual(["echo hi"])
})

test("/shell tanpa argumen tetap memanggil hook dengan string kosong", async () => {
  const received: string[] = []
  const ctx = dummyCtx({
    withShell: async (cmd: string) => {
      received.push(cmd)
    },
  })
  const { value } = await captureOutput(() => handleBuiltinCommand("/shell", ctx))
  expect(value.handled).toBe(true)
  expect(received).toEqual([""])
})

test("non-TTY / tanpa hook: tolak fail-closed dengan kunci shell.unavailable", async () => {
  // Hook sengaja ABSEN (default one-shot/pipe). Satu-satunya jalur spawn di
  // command handler adalah ctx.withShell, jadi tanpa hook tak ada shell yang
  // bisa hidup — yang diuji adalah pesan penolakannya, bukan hasil spawn.
  const ctx = dummyCtx({ withShell: undefined })
  const { lines, value } = await captureOutput(() => handleBuiltinCommand("/shell", ctx))
  expect(value.handled).toBe(true)
  // Bandingkan dengan terjemahan aktif, bukan string literal — kuncinya yang
  // menjadi kontrak (test lain memakai pola `t("...")` yang sama).
  expect(lines).toEqual([t("shell.unavailable")])
})

test("handler tidak pernah spawn langsung; spawn hanya lewat hook denganShell", () => {
  // structural guard, not E2E: memastikan jalur non-TTY benar-benar tidak punya
  // fallback spawn buta di dalam command handler.
  const shellCase = shellCaseSource()
  expect(shellCase).toContain("if (!ctx.withShell)")
  expect(shellCase).toContain('t("shell.unavailable")')
  expect(shellCase).toContain("await ctx.withShell(args)")
  expect(shellCase).not.toContain("spawn(")
})

test("structural guard, not E2E: urutan host release → spawn(inherit) → reacquire", () => {
  // Host withShell ditulis inline di composition root cli/tui.ts dan TIDAK
  // diekspor, sehingga tidak bisa di-inject/dipanggil dari test. Yang dibuktikan
  // di sini adalah URUTAN simbol-simbol kontrak, bukan perilaku runtime shell.
  const src = readFileSync(join(import.meta.dir, "..", "cli", "tui.ts"), "utf8")
  const block = sliceBlock(src, "withShell: async (cmd: string) => {", "getContextTokens:")
  const release = block.indexOf("app.releaseTerminal()")
  const spawn = block.indexOf('stdio: "inherit"')
  const reacquire = block.indexOf("app.reacquireTerminal()")
  expect(release).toBeGreaterThan(-1)
  expect(spawn).toBeGreaterThan(-1)
  expect(reacquire).toBeGreaterThan(-1)
  expect(release).toBeLessThan(spawn)
  expect(spawn).toBeLessThan(reacquire)
  expect(block).toContain("finally")
  expect(block).toContain("waitChildExit")
})
