// Renderer flat (full mono): area thinking LIVE tidak dirender (tanpa blok
// atau jendela 10 baris). Narasi reasoning tetap hidup di transkrip lewat
// SATU baris ringkas `+ thinking · N lines` per turn — ditimpa di tempat saat
// segmen berikutnya datang, sehingga tak ada duplikasi fragmen.
import { afterEach, describe, expect, test } from "bun:test"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

afterEach(() => {
  resetLocaleState()
})

function setup(opts: { activityPanel: boolean; reasoningVisible?: boolean }) {
  setSessionLocale("en")
  const bus = createFakeBus()
  let handler: ((event: unknown) => void) | undefined
  const uiState = new UiSessionState({
    activityPanel: opts.activityPanel,
    reasoningVisible: opts.reasoningVisible ?? true,
  })
  const t = new Transcript(bus as never, {
    getSnapshot: () => ({ activities: [], turns: [] }),
    onPresentationEvent: (next) => {
      handler = next as (event: unknown) => void
      return () => {
        handler = undefined
      }
    },
    uiState,
  })
  return {
    t,
    uiState,
    emit(event: Record<string, unknown>) {
      handler?.(event)
    },
    reason(text: string) {
      bus.emit("provider:extension", { kind: "reasoning", data: { text } })
    },
  }
}

const lines = (t: Transcript, height = 12) =>
  t
    .view(80, height, 0)
    .map(stripAnsi)
    .filter((l) => l.trim() !== "")

describe("area thinking (TUI)", () => {
  test("mode area: tidak ada blok/header thinking LIVE di renderer flat", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason("baris-satu\nbaris-dua")
    const view = lines(t)
    // `thinkingRows()` mengembalikan [] pada renderer flat: reasoning masih
    // ditahan di buffer sebelum turn selesai, jadi belum ada baris di viewport.
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    expect(view.some((l) => l.includes("baris-satu"))).toBe(false)
    expect(view.some((l) => l.includes("baris-dua"))).toBe(false)
    expect(t.size()).toBe(0)
  })

  test("mode area: tidak ada penanda '+ thinking · N' / baris thinking sebelum turn tutup", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason(
      Array.from({ length: 20 }, (_, i) => `l${i}`)
        .join("\n")
        .concat("\n"),
    )
    const view = lines(t, 20)
    expect(view.some((l) => l.includes("more lines"))).toBe(false)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    expect(view.some((l) => l.includes("l19"))).toBe(false)
    expect(view.some((l) => l.includes("l0"))).toBe(false)
  })

  test("turn selesai: ringkasan `+ thinking · 3 lines` muncul di transkrip", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("alpha\nbeta\ngamma")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20).join("\n")
    // Narasi thinking dipulihkan di chat: tepat satu baris ringkas dengan
    // hitungan baris penalaran turn tersebut (bukan isi mentahnya).
    expect(all).toContain("+ thinking")
    expect(all).toContain("3 lines")
  })

  test("beberapa segmen reasoning menyatu jadi satu baris dengan total", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("a\nb")
    emit({ type: "tool.started", toolCallId: "t1", name: "bash" })
    reason("c")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20).join("\n")
    expect(all.match(/\+ thinking/g)?.length).toBe(1)
    expect(all).toContain("3 lines")
  })

  test("mode area: setelah turn selesai tidak ada duplikasi blok", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("a\nb")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const headers = lines(t, 20).filter((l) => l.includes("+ thinking"))
    expect(headers).toHaveLength(1)
  })

  test("panel OFF: perilaku legacy (stream per baris, tanpa header area)", () => {
    const { t, reason } = setup({ activityPanel: false })
    reason("satu\ndua")
    const view = lines(t)
    expect(view.some((l) => l.includes("satu"))).toBe(true)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    expect(t.size()).toBe(1)
  })

  test("reasoning disembunyikan: tidak ada jejak sama sekali di transkrip", () => {
    const { t, reason, emit } = setup({ activityPanel: true, reasoningVisible: false })
    reason("rahasia")
    expect(lines(t).some((l) => l.includes("rahasia"))).toBe(false)
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const after = lines(t).join("\n")
    expect(after).not.toContain("rahasia")
    expect(after).not.toContain("+ thinking")
  })
})
