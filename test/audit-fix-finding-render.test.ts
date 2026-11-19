// v7.41 re-audit (rendering #1): finding.detected HARUS dirender di TUI.
// Sebelumnya bridge menaruh isi finding di `text`, tapi transcript membaca
// `event.summary` (bertipe UiTurnSummary / undefined) → baris finding tak pernah
// muncul. Test ini mengunci alur presentation event → baris transkrip.
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
  return { t, emit: (e: unknown) => handler?.(e) }
}

test("finding.detected dengan text (bukan summary) menghasilkan baris transkrip", () => {
  const { t, emit } = setup()
  emit({
    type: "finding.detected",
    findingId: "child-report:sub1:1",
    category: "child-report",
    severity: "warning",
    text: "[EVALUATE] high | src/x.ts:12 | policy bypass",
    evidence: ["high | src/x.ts:12 | policy bypass"],
    turnId: 1,
  })
  const view = t.view(80, 12, 0).join("\n")
  expect(view).toContain("[EVALUATE] high | src/x.ts:12 | policy bypass")
})

test("finding duplikat (id sama) tak dirender dua kali", () => {
  const { t, emit } = setup()
  const ev = {
    type: "finding.detected",
    findingId: "child-report:sub1:1",
    category: "child-report",
    severity: "warning",
    text: "[EVALUATE] temuan",
    turnId: 1,
  }
  emit(ev)
  emit(ev)
  const view = t.view(80, 12, 0).join("\n")
  expect(view.split("[EVALUATE] temuan").length - 1).toBe(1)
})

test("finding tanpa text diabaikan (tak ada baris kosong)", () => {
  const { t, emit } = setup()
  emit({
    type: "finding.detected",
    findingId: "child-report:sub1:1",
    category: "child-report",
    severity: "warning",
    summary: { unused: true },
    turnId: 1,
  })
  const view = t.view(80, 12, 0).join("\n")
  expect(view).not.toContain("undefined")
})
