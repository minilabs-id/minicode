// Temuan H1: Ctrl+O/Ctrl+T dan /view compact|minimize|fold adalah kontrol mati
// (flag-nya tak dikonsumsi renderer flat). Binding, help, dan kwitansinya harus
// hilang; yang diuji di sini adalah permukaan kontrolnya, bukan state internal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type CommandContext, handleBuiltinCommand } from "../cli/commands.ts"
import { resetLocaleState, setSessionLocale, t } from "../src/ui/i18n/locale.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

beforeEach(() => {
  resetLocaleState()
  setSessionLocale("en")
})

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
  resetLocaleState()
})

function setup() {
  tty = installFakeTty({ columns: 70, rows: 16 })
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never)
  let compactToggles = 0
  let reasoningToggles = 0
  const host: TuiHost = {
    bus: bus as never,
    getStatus: () => ({
      footer: { mode: "auto", model: "m", cwd: "/", context: "1k" },
      busy: false,
    }),
    listCommands: () => [],
    submit: async () => undefined,
    copySelection: () => true,
    abort: () => {},
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {
      compactToggles++
    },
    toggleReasoning: () => {
      reasoningToggles++
    },
  }
  const app = new TuiApp(transcript, host)
  return {
    app,
    compactToggles: () => compactToggles,
    reasoningToggles: () => reasoningToggles,
    screen: () => tty!.screen().join("\n"),
  }
}

describe("H1: kontrol mati dihapus", () => {
  test("Ctrl+O / Ctrl+T tak memanggil toggle dan tak mencetak kwitansi", async () => {
    const { app, compactToggles, reasoningToggles, screen } = setup()
    const runP = app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send(KEY.ctrlO)
    await tty!.send(KEY.ctrlT)
    expect(compactToggles()).toBe(0)
    expect(reasoningToggles()).toBe(0)
    expect(screen()).not.toContain(t("tui.compactLine", { v: t("state.expanded") }))
    expect(screen()).not.toContain(t("tui.thinkingSet", { v: t("state.expanded") }))
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("/help keys tak lagi menawarkan ctrl+o / ctrl+t", async () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.map((a) => String(a)).join(" "))
    try {
      await handleBuiltinCommand("/help keys", {} as CommandContext)
    } finally {
      console.log = orig
    }
    const text = lines.join("\n").toLowerCase()
    expect(text).toContain("ctrl+r")
    expect(text).not.toContain("ctrl+o")
    expect(text).not.toContain("ctrl+t")
  })
})
