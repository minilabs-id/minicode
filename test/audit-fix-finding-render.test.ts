// v0.33: finding.detected tidak lagi masuk ke transkrip chat saat sidebar aktif
// — temuan audit pindah ke log Activity. Mode linear (tanpa sidebar) tetap
// merender di transkrip supaya output one-shot/CI tak kehilangan temuan.
import { expect, test } from "bun:test"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup(sidebar: boolean) {
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
  t.setSidebarActive(sidebar)
  return { t, emit: (e: unknown) => handler?.(e) }
}

const finding = (text: string) => ({
  type: "finding.detected",
  findingId: "child-report:sub1:1",
  category: "child-report",
  severity: "warning",
  text,
  turnId: 1,
})

test("sidebar aktif: finding masuk log Activity, bukan chat", () => {
  const { t, emit } = setup(true)
  emit(finding("[EVALUATE] high | src/x.ts:12 | policy bypass"))
  const side = t.sidebarActivity(0, 80).join("\n")
  expect(side).toContain("[EVALUATE]")
  expect(side).toContain("policy bypass")
  expect(t.view(80, 12, 0).join("\n")).not.toContain("[EVALUATE]")
})

test("finding duplikat (id sama) tak dicatat dua kali", () => {
  const { t, emit } = setup(true)
  emit(finding("[EVALUATE] temuan"))
  emit(finding("[EVALUATE] temuan"))
  const side = t.sidebarActivity(0, 80).join("\n")
  expect(side.split("[EVALUATE]").length - 1).toBe(1)
})

test("finding tanpa text diabaikan (tak ada baris kosong)", () => {
  const { t, emit } = setup(true)
  emit({ type: "finding.detected", findingId: "f", summary: { unused: true }, turnId: 1 })
  expect(t.sidebarActivity(0, 80).join("\n")).not.toContain("undefined")
})

test("mode linear (tanpa sidebar): finding tetap dirender di transkrip", () => {
  const { t, emit } = setup(false)
  emit(finding("[EVALUATE] low | docs/x.md:3 | catatan"))
  expect(t.view(80, 12, 0).join("\n")).toContain("[EVALUATE] low | docs/x.md:3 | catatan")
})
