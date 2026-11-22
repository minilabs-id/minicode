// finding.detected adalah narasi: tampil di transkrip chat pada semua
// permukaan (termasuk one-shot/CI). Satu finding = satu baris; teks tak
// terpercaya disanitasi sebelum tampil.
import { expect, test } from "bun:test"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  let handler: ((e: unknown) => void) | undefined
  const t = new Transcript(bus as never, {
    onPresentationEvent: (h) => {
      handler = h as (e: unknown) => void
      return () => {
        handler = undefined
      }
    },
  })
  return { t, emit: (e: unknown) => handler?.(e), view: () => t.view(80, 12, 0).join("\n") }
}

const finding = (text: string) => ({
  type: "finding.detected",
  findingId: "child-report:sub1:1",
  category: "child-report",
  severity: "warning",
  text,
  turnId: 1,
})

test("[EVALUATE] muncul di chat", () => {
  const { emit, view } = setup()
  emit(finding("[EVALUATE] high | src/x.ts:12 | policy bypass"))
  expect(view()).toContain("[EVALUATE] high | src/x.ts:12 | policy bypass")
})

test("finding duplikat (id sama) tak dicatat dua kali", () => {
  const { emit, view } = setup()
  emit(finding("[EVALUATE] temuan"))
  emit(finding("[EVALUATE] temuan"))
  expect(view().split("[EVALUATE]").length - 1).toBe(1)
})

test("finding tanpa text diabaikan (tak ada baris kosong / 'undefined')", () => {
  const { t, emit, view } = setup()
  emit({ type: "finding.detected", findingId: "f", summary: { unused: true }, turnId: 1 })
  expect(view()).not.toContain("undefined")
  expect(t.size()).toBe(0)
})

test("teks finding tak terpercaya disanitasi di chat", () => {
  const { emit, view } = setup()
  emit(finding("[EVALUATE] low | \x1b[2J docs/x.md:3 | catatan"))
  const out = view()
  expect(out).not.toContain("\x1b[2J")
  expect(out).toContain("[EVALUATE]")
  expect(out).toContain("docs/x.md:3")
})
