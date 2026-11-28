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
import { createTuiUpdateHandler } from "../cli/tui.ts"
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

test("createTuiUpdateHandler: check tetap di alt-screen saat alreadyLatest / preflight gagal", async () => {
  const events: string[] = []
  const handler = createTuiUpdateHandler({
    releaseTerminal: () => events.push("releaseTerminal"),
    reacquireTerminal: () => {
      events.push("reacquireTerminal")
      return true
    },
    requestQuit: () => events.push("requestQuit"),
    resumeStdin: () => events.push("resumeStdin"),
    closeSession: async () => {
      events.push("closeSession")
    },
    writeStatusLine: (line) => events.push(`status:${line}`),
    runUpdate: async ({ onPhase }) => {
      await onPhase?.("check")
      events.push("checked")
      return { ok: true, alreadyLatest: true }
    },
    respawn: async () => {
      events.push("respawn")
      return 0
    },
    exit: (() => {
      events.push("exit")
      throw new Error("exit")
    }) as never,
  })
  const res = await handler()
  expect(res).toEqual({ ok: true, alreadyLatest: true })
  expect(events).toEqual(["checked"])
})

test("createTuiUpdateHandler: lepas terminal saat install lalu closeSession() SEBELUM spawn", async () => {
  const events: string[] = []
  let exitCode: number | undefined
  const handler = createTuiUpdateHandler({
    releaseTerminal: () => events.push("releaseTerminal"),
    reacquireTerminal: () => {
      events.push("reacquireTerminal")
      return true
    },
    requestQuit: () => events.push("requestQuit"),
    resumeStdin: () => events.push("resumeStdin"),
    closeSession: async () => {
      events.push("closeSession")
    },
    writeStatusLine: (line) => events.push(`status:${line}`),
    runUpdate: async ({ onPhase }) => {
      await onPhase?.("check")
      events.push("run:check")
      await onPhase?.("install", "2.5.0")
      events.push("run:install")
      await onPhase?.("verify", "2.5.0")
      return { ok: true, latest: "2.5.0" }
    },
    respawn: async (v) => {
      events.push(`respawn:${v}`)
      return 0
    },
    exit: ((code: number) => {
      exitCode = code
      events.push(`exit:${code}`)
      throw new Error("EXITED")
    }) as never,
  })
  await expect(handler()).rejects.toThrow("EXITED")
  expect(exitCode).toBe(0)
  expect(events).toEqual([
    "run:check",
    "releaseTerminal",
    "status:Updating minicode-ai via bun to v2.5.0…",
    "run:install",
    "closeSession",
    "respawn:2.5.0",
    "exit:0",
  ])
})

test("createTuiUpdateHandler: install gagal pasca-release memulihkan terminal tanpa close/spawn", async () => {
  const events: string[] = []
  const handler = createTuiUpdateHandler({
    releaseTerminal: () => events.push("releaseTerminal"),
    reacquireTerminal: () => {
      events.push("reacquireTerminal")
      return false
    },
    requestQuit: () => events.push("requestQuit"),
    resumeStdin: () => events.push("resumeStdin"),
    closeSession: async () => {
      events.push("closeSession")
    },
    writeStatusLine: (line) => events.push(`status:${line}`),
    runUpdate: async ({ onPhase }) => {
      await onPhase?.("check")
      await onPhase?.("install", "2.5.0")
      return { ok: false, step: "bun update -g", reason: "network error" }
    },
    respawn: async () => {
      events.push("respawn")
      return 0
    },
    exit: (() => {
      events.push("exit")
      throw new Error("exit")
    }) as never,
  })
  const res = await handler()
  expect(res).toEqual({ ok: false, step: "bun update -g", reason: "network error" })
  expect(events).toEqual([
    "releaseTerminal",
    "status:Updating minicode-ai via bun to v2.5.0…",
    "resumeStdin",
    "reacquireTerminal",
    "requestQuit",
  ])
})

test("createTuiUpdateHandler: abort saat fase check batal bersih tanpa melepas terminal", async () => {
  const events: string[] = []
  const ac = new AbortController()
  const handler = createTuiUpdateHandler({
    releaseTerminal: () => events.push("releaseTerminal"),
    reacquireTerminal: () => {
      events.push("reacquireTerminal")
      return true
    },
    requestQuit: () => events.push("requestQuit"),
    resumeStdin: () => events.push("resumeStdin"),
    closeSession: async () => {
      events.push("closeSession")
    },
    writeStatusLine: (line) => events.push(`status:${line}`),
    runUpdate: async ({ signal }) => {
      ac.abort()
      expect(signal?.aborted).toBe(true)
      return { ok: false, aborted: true, step: "check" }
    },
    respawn: async () => 0,
    exit: (() => {
      throw new Error("exit")
    }) as never,
  })
  const res = await handler(ac.signal)
  expect(res).toEqual({ ok: false, aborted: true, step: "check" })
  expect(events).toEqual([])
})
