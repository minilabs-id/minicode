// Palet harus mengikuti level terminal: 16-warna TIDAK boleh menerima SGR
// truecolor (`38;2;...`). Regresi nyata: semua token semantik dulu selalu
// memancarkan truecolor walau `getColorDepth()` melaporkan 4/16 warna.
import { afterAll, beforeEach, expect, test } from "bun:test"
import { c, stripAnsi } from "../src/ui/render/theme.ts"

const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const depthDesc = Object.getOwnPropertyDescriptor(process.stdout, "getColorDepth")
const origTerm = process.env.TERM
const origColorterm = process.env.COLORTERM
const origNoColor = process.env.NO_COLOR
const origMinicodeColor = process.env.MINICODE_COLOR

function setDepth(depth: number): void {
  Object.defineProperty(process.stdout, "getColorDepth", {
    value: () => depth,
    configurable: true,
  })
}

beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  delete process.env.NO_COLOR
  // v7.29: warna nyala by default di TTY. Flag mono harus dihapus supaya test
  // level warna menguji jalur berwarna; test mono menyalakannya sendiri.
  delete process.env.MINICODE_COLOR
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
  if (origMinicodeColor == null) delete process.env.MINICODE_COLOR
  else process.env.MINICODE_COLOR = origMinicodeColor
})

test("level 16-warna monokrom saat MINICODE_COLOR=0", () => {
  // v7.29: warna kini nyala by default di TTY, jadi mode mono dipaksa lewat
  // flag. Test ini tetap menjaga jalur aksesibilitas, bukan menghapusnya.
  process.env.MINICODE_COLOR = "0"
  try {
    process.env.TERM = "xterm"
    delete process.env.COLORTERM
    setDepth(4)
    expect(c.success("X")).toBe("X")
    expect(c.accent("X")).toBe("X")
    expect(c.error("X")).toBe("X")
  } finally {
    delete process.env.MINICODE_COLOR
  }
})

test("v7.29: level 16-warna memancarkan SGR 16-warna", () => {
  process.env.TERM = "xterm"
  delete process.env.COLORTERM
  setDepth(4)
  // Deteksi depth=4 harus memilih kode 16-warna, bukan 38;5 / 38;2.
  expect(c.success("X")).toBe("\x1b[32mX\x1b[39m")
  expect(c.accent("X")).toBe("\x1b[94mX\x1b[39m")
  expect(stripAnsi(c.success("X"))).toBe("X")
})

test("level 256-warna monokrom saat MINICODE_COLOR=0", () => {
  process.env.MINICODE_COLOR = "0"
  try {
    process.env.TERM = "xterm-256color"
    delete process.env.COLORTERM
    setDepth(8)
    expect(c.success("X")).toBe("X")
    expect(c.accent("X")).toBe("X")
  } finally {
    delete process.env.MINICODE_COLOR
  }
})

test("v7.29: level 256-warna memancarkan SGR 256-warna", () => {
  process.env.TERM = "xterm-256color"
  delete process.env.COLORTERM
  setDepth(8)
  expect(c.success("X")).toBe("\x1b[38;5;114mX\x1b[39m")
  expect(c.accent("X")).toBe("\x1b[38;5;69mX\x1b[39m")
  expect(stripAnsi(c.success("X"))).toBe("X")
})

test("level truecolor monokrom saat MINICODE_COLOR=0", () => {
  process.env.MINICODE_COLOR = "0"
  try {
    process.env.TERM = "xterm-256color"
    process.env.COLORTERM = "truecolor"
    setDepth(24)
    expect(c.success("X")).toBe("X")
    expect(c.accent("X")).toBe("X")
  } finally {
    delete process.env.MINICODE_COLOR
  }
})

test("v7.29: level truecolor memancarkan SGR 24-bit", () => {
  process.env.TERM = "xterm-256color"
  process.env.COLORTERM = "truecolor"
  setDepth(24)
  expect(c.success("X")).toBe("\x1b[38;2;137;209;133mX\x1b[39m")
  expect(c.accent("X")).toBe("\x1b[38;2;74;144;226mX\x1b[39m")
  expect(stripAnsi(c.success("X"))).toBe("X")
})

test("mono: semua token identitas", () => {
  process.env.NO_COLOR = "1"
  expect(c.success("X")).toBe("X")
  expect(c.accent("X")).toBe("X")
  expect(c.error("X")).toBe("X")
  delete process.env.NO_COLOR
})
