// Audit v7.29: warna dinyalakan lagi by default di TTY (FORCE_MONO dihapus).
// File ini mengunci KONTRAK barunya secara eksplisit, terpisah dari test palet
// lama: TTY + env bersih = SGR nyata; MINICODE_COLOR=0 / NO_COLOR / non-TTY /
// TERM=dumb = monokrom. Di kedua jalur, `stripAnsi(c.*(...))` tetap teks asli.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { c, stripAnsi, themeCapabilityKey } from "../src/ui/render/theme.ts"

const ENV_KEYS = ["NO_COLOR", "MINICODE_COLOR", "COLORTERM", "TERM"] as const
type EnvKey = (typeof ENV_KEYS)[number]
let savedEnv: Partial<Record<EnvKey, string | undefined>> = {}
let savedIsTty: boolean | undefined

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedIsTty = process.stdout.isTTY
  // v7.29: warna digate stdout.isTTY — stub TTY supaya yang diuji logika warna,
  // bukan fakta bahwa runner test menulis ke pipe.
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
})

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: savedIsTty, configurable: true })
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
})

const SUCCESS_SGR = "\x1b[38;2;137;209;133m"

describe("v7.29 color-by-default", () => {
  test("TTY + env bersih memancarkan SGR truecolor, stripAnsi tetap utuh", () => {
    process.env.COLORTERM = "truecolor"
    const out = c.success("X")
    expect(out).toContain(SUCCESS_SGR)
    expect(out).toContain("\x1b[39m")
    expect(stripAnsi(out)).toBe("X")
  })

  test("MINICODE_COLOR=0 mematikan semua SGR (jalur mono)", () => {
    process.env.COLORTERM = "truecolor"
    process.env.MINICODE_COLOR = "0"
    for (const slot of ["success", "error", "warning", "info", "accent", "string"] as const) {
      expect(c[slot]("X"), slot).toBe("X")
      expect(stripAnsi(c[slot]("X")), slot).toBe("X")
    }
  })

  test("MINICODE_COLOR=false/off/no juga berarti mono", () => {
    process.env.COLORTERM = "truecolor"
    for (const value of ["false", "off", "no"]) {
      process.env.MINICODE_COLOR = value
      expect(c.success("X"), value).toBe("X")
    }
  })

  test("MINICODE_COLOR=1 bukan kill-switch — warna tetap nyala", () => {
    process.env.COLORTERM = "truecolor"
    process.env.MINICODE_COLOR = "1"
    expect(c.success("X")).toContain(SUCCESS_SGR)
  })

  test("NO_COLOR dengan nilai selain 0 mematikan warna", () => {
    process.env.COLORTERM = "truecolor"
    process.env.NO_COLOR = "1"
    expect(c.success("X")).toBe("X")
    expect(c.bold("X")).toBe("X")
  })

  test("NO_COLOR=0 sengaja dibaca sebagai 'jangan matikan'", () => {
    // Keputusan product: "0" = eksplisit jangan matikan, berbeda dari no-color.org.
    process.env.COLORTERM = "truecolor"
    process.env.NO_COLOR = "0"
    expect(c.success("X")).toContain(SUCCESS_SGR)
  })

  test("non-TTY memaksa mono walau COLORTERM=truecolor", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    process.env.COLORTERM = "truecolor"
    expect(c.success("X")).toBe("X")
  })

  test("TERM=dumb memaksa mono walau TTY", () => {
    process.env.TERM = "dumb"
    process.env.COLORTERM = "truecolor"
    expect(c.success("X")).toBe("X")
  })

  test("themeCapabilityKey mencakup flag warna supaya cache tak basi", () => {
    delete process.env.MINICODE_COLOR
    const colored = themeCapabilityKey()
    process.env.MINICODE_COLOR = "0"
    const mono = themeCapabilityKey()
    expect(colored).not.toBe(mono)
    expect(mono.endsWith(":0")).toBe(true)
    expect(colored.endsWith(":1")).toBe(true)
  })
})
