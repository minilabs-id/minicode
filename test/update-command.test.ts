// /update — handoff aman TUI + fail-closed non-TTY + kehadiran di /help.
// API runManualUpdate TIDAK merestart proses; pemanggil yang spawn + exit.
// Di sini kita inject withUpdate (sebuah spy) supaya tak ada spawn/exit asli
// dan semua cabang hasil bisa diuji deterministik.

import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  BUILTIN_COMMANDS,
  HELP_GROUPS,
  handleBuiltinCommand,
  type ManualUpdateOutcome,
} from "../cli/commands.ts"
import { en } from "../src/ui/i18n/en.ts"
import { id } from "../src/ui/i18n/id.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { captureOutput } from "./helpers/capture.ts"

beforeEach(() => setSessionLocale("en"))
afterEach(() => resetLocaleState())

type Ctx = Parameters<typeof handleBuiltinCommand>[1]

function dummyCtx(extra: Partial<Ctx> = {}): Ctx {
  const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001 }
  return {
    sessionId: "update-test",
    currentModel: "prov::m",
    usage: {
      get: () => usage,
      getSession: () => usage,
      reset: () => {},
      modelUsed: () => ({ effective: undefined, provider: undefined }),
    },
    skills: [],
    toolsCount: 12,
    setModelOverride: () => {},
    getContextTokens: () => 1024,
    budgetState: () => "ok" as const,
    ...extra,
  } as unknown as Ctx
}

/** Handoff spy: catat jumlah panggil, kembalikan hasil yang ditentukan. */
function inject(result: ManualUpdateOutcome | (() => never)): { ctx: Ctx; calls: () => number } {
  let count = 0
  const withUpdate = async (): Promise<ManualUpdateOutcome> => {
    count++
    if (typeof result === "function") return result()
    return result
  }
  return { ctx: dummyCtx({ withUpdate }), calls: () => count }
}

test("update: tanpa injeksi → fail-closed, bukan crash / spawn buta", async () => {
  const { lines, value } = await captureOutput(() => handleBuiltinCommand("/update", dummyCtx()))
  expect(value.handled).toBe(true)
  expect(value.shouldExit).toBeUndefined()
  expect(lines.join("\n")).toContain(t("cmd.updateUnavailable"))
})

test("update: sukses + latest → handoff dipanggil sekali, readout restart", async () => {
  const { ctx, calls } = inject({ ok: true, latest: "9.9.9" })
  const { lines, value } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  expect(value.handled).toBe(true)
  expect(calls()).toBe(1)
  const text = lines.join("\n")
  expect(text).toContain("9.9.9")
  expect(text).toContain(t("cmd.updateDone"))
})

test("update: alreadyLatest → tidak ada klaim restart", async () => {
  const { ctx, calls } = inject({ ok: true, alreadyLatest: true })
  const { lines } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  expect(calls()).toBe(1)
  expect(lines.join("\n")).toContain(t("cmd.updateLatest"))
})

test("update: gagal → alasan tampil, tidak dibungkam", async () => {
  const { ctx } = inject({ ok: false, step: "install", reason: "network down" })
  const { lines } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  const text = lines.join("\n")
  expect(text).toContain(t("cmd.updateFailed", { msg: "" }))
  expect(text).toContain("network down")
})

test("update: opt-out → pesaing singkat, bukan error", async () => {
  const { ctx } = inject({ ok: true, optedOut: true })
  const { lines } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  expect(lines.join("\n")).toContain(t("cmd.updateOptedOut"))
})

test("update: handoff melempar → ditangkap, tidak merusak TUI", async () => {
  const { ctx } = inject(() => {
    throw new Error("boom-from-api")
  })
  const { lines, value } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  expect(value.handled).toBe(true)
  const text = lines.join("\n")
  // formatError memetakan galat tak-terklasifikasi ke pesan ramah pengguna (bukan raw exception).
  expect(text).toContain(t("cmd.updateFailed", { msg: "" }))
  expect(text.length).toBeGreaterThan(t("cmd.updateFailed", { msg: "" }).length)
})

test("update: alasan tak terpercaya disanitasi (ANSI dibuang)", async () => {
  const { ctx } = inject({ ok: false, reason: "\x1b[31mraw\x1b[0m" })
  const { lines } = await captureOutput(() => handleBuiltinCommand("/update", ctx))
  const text = lines.join("\n")
  expect(text).toContain("raw")
  expect(text).not.toContain("\x1b[31m")
})

test("update: terdaftar di BUILTIN + grup gGeneral, descKey unik", () => {
  const b = BUILTIN_COMMANDS.find((x) => x.name === "update")
  expect(b).toBeDefined()
  expect(b!.descKey).toBe("help.desc.update")
  expect(BUILTIN_COMMANDS.filter((x) => x.name === "update")).toHaveLength(1)
  const general = HELP_GROUPS.find((g) => g.key === "help.gGeneral")
  expect(general?.names).toContain("update")
})

test("update: descKey ada di kedua kamus (en/id)", () => {
  const b = BUILTIN_COMMANDS.find((x) => x.name === "update")!
  for (const dict of [en, id]) {
    const v = dict[b.descKey]
    expect(typeof v, b.descKey).toBe("string")
    expect(v.length, b.descKey).toBeGreaterThan(0)
  }
  for (const key of [
    "out.titleUpdate",
    "cmd.updateChecking",
    "cmd.updateAvailable",
    "cmd.updateLatest",
    "cmd.updateInstalling",
    "cmd.updateDone",
    "cmd.updateFailed",
    "cmd.updateUnavailable",
    "cmd.updateOptedOut",
  ] as const) {
    expect(typeof en[key], `en.${key}`).toBe("string")
    expect(typeof id[key], `id.${key}`).toBe("string")
  }
})

test.each(["en", "id"] as const)("update: muncul di /help (%s)", async (locale) => {
  setSessionLocale(locale)
  const { lines, value } = await captureOutput(() => handleBuiltinCommand("/help", dummyCtx()))
  expect(value.handled).toBe(true)
  expect(lines.join("\n")).toContain("/update")
})
