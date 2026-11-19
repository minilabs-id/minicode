// Audit finding 1: nama tool/kind dari model/MCP tak boleh menyuntik kontrol
// terminal ke dump MINICODE_DEBUG_BUS=1. Regression: ESC[2J, OSC, dan BEL
// harus dibuang sebelum baris ditulis ke stderr.

import { afterEach, beforeEach, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { attachBusDebug } from "../src/ui/runtime/bus-debug.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
let saved: string | undefined

beforeEach(() => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  saved = process.env.MINICODE_DEBUG_BUS
  process.env.MINICODE_DEBUG_BUS = "1"
})

afterEach(() => {
  if (saved === undefined) delete process.env.MINICODE_DEBUG_BUS
  else process.env.MINICODE_DEBUG_BUS = saved
  tty?.restore()
  tty = undefined
})

test("nama tool dengan ESC[2J / OSC / BEL tak menghasilkan byte kontrol di dump", () => {
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  const evil = `bash\x1b[2J\x1b]0;judul\x07\x1b[?1049h`
  bus.emit("execution:started", { execution: { call: { name: evil, args: {} } } })
  bus.emit("execution:completed", {
    execution: { call: { name: evil, args: {} }, result: { isError: true } },
  })
  detach()
  const out = tty!.allErr()
  // Tak ada byte ESC / BEL mentah yang sampai ke stderr.
  expect(out.includes("\x1b")).toBe(false)
  expect(out.includes("\x07")).toBe(false)
  expect(out).toContain("[bus] start:bash")
  expect(out).toContain("[bus] done:bash:err")
})

test("nama tool CJK/emoji dipotong per KOLOM, bukan UTF-16, tanpa ESC", () => {
  const bus = createFakeBus()
  const detach = attachBusDebug(bus as unknown as EventBus)
  bus.emit("execution:started", {
    execution: { call: { name: "漢字".repeat(300).concat("\x1b[2J"), args: {} } },
  })
  detach()
  const out = tty!.allErr()
  expect(out.includes("\x1b")).toBe(false)
  // Kap memakai lebar kolom (CJK = 2): ringkasan dibatasi 300 kolom + prefix.
  const baris = out.slice(0, out.indexOf("\n"))
  expect(displayWidth(baris)).toBeLessThanOrEqual(306)
})
