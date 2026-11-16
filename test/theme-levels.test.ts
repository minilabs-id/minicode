// Palet harus mengikuti level terminal: 16-warna TIDAK boleh menerima SGR
// truecolor (`38;2;...`). Regresi nyata: semua token semantik dulu selalu
// memancarkan truecolor walau `getColorDepth()` melaporkan 4/16 warna.
import { afterAll, beforeEach, expect, test } from "bun:test"
import { c } from "../src/ui/render/theme.ts"

const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const depthDesc = Object.getOwnPropertyDescriptor(process.stdout, "getColorDepth")
const origTerm = process.env.TERM
const origColorterm = process.env.COLORTERM
const origNoColor = process.env.NO_COLOR

function setDepth(depth: number): void {
  Object.defineProperty(process.stdout, "getColorDepth", {
    value: () => depth,
    configurable: true,
  })
}

beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  delete process.env.NO_COLOR
})

afterAll(() => {
  if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc)
  else delete (process.stdout as { isTTY?: boolean }).isTTY
  if (depthDesc) Object.defineProperty(process.stdout, "getColorDepth", depthDesc)
  else delete (process.stdout as { getColorDepth?: unknown }).getColorDepth
  if (origTerm == null) delete process.env.TERM
  else process.env.TERM = origTerm
  if (origColorterm == null) delete process.env.COLORTERM
  else process.env.COLORTERM = origColorterm
  if (origNoColor == null) delete process.env.NO_COLOR
  else process.env.NO_COLOR = origNoColor
})

test("16-color: status memakai SGR 16-warna, bukan truecolor", () => {
  process.env.TERM = "xterm"
  delete process.env.COLORTERM
  setDepth(4)
  const success = c.success("X")
  expect(success).toContain("\x1b[32m")
  expect(success).not.toContain("38;2;")
  expect(c.accent("X")).toContain("\x1b[94m")
  expect(c.error("X")).not.toContain("38;2;")
})

test("256-color: status memakai SGR 38;5, bukan truecolor", () => {
  process.env.TERM = "xterm-256color"
  delete process.env.COLORTERM
  setDepth(8)
  const success = c.success("X")
  expect(success).toContain("\x1b[38;5;114m")
  expect(success).not.toContain("38;2;")
})

test("truecolor: status memakai 38;2", () => {
  process.env.TERM = "xterm-256color"
  process.env.COLORTERM = "truecolor"
  setDepth(24)
  expect(c.success("X")).toContain("\x1b[38;2;137;209;133m")
})

test("mono: semua token identitas", () => {
  process.env.NO_COLOR = "1"
  expect(c.success("X")).toBe("X")
  expect(c.accent("X")).toBe("X")
  expect(c.error("X")).toBe("X")
  delete process.env.NO_COLOR
})
