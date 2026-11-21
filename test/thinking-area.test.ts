// Renderer flat (full mono): area thinking dimatikan total — tidak ada blok
// LIVE, header `+ thinking`, penanda "… N more lines", maupun baris ringkasan.
// Reasoning tetap ditahan di buffer (tak di-commit per baris), jadi transkrip
// bersih dari jejak thinking. Mode area lama hanya aktif saat panel ON.
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
  test("mode area: tidak ada blok/header thinking di renderer flat", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason("baris-satu\nbaris-dua")
    const view = lines(t)
    // thinkingRows() mengembalikan [] pada renderer flat: tak ada header
    // `+ thinking` dan tak ada baris konten yang dirender live — reasoning
    // cuma ditahan di buffer, bukan dipancarkan ke viewport.
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    expect(view.some((l) => l.includes("baris-satu"))).toBe(false)
    expect(view.some((l) => l.includes("baris-dua"))).toBe(false)
    // Belum ada baris permanen yang di-commit.
    expect(t.size()).toBe(0)
  })

  test("mode area: tidak ada penanda '+ berpikir · N' / baris thinking", () => {
    const { t, reason } = setup({ activityPanel: true })
    reason(
      Array.from({ length: 20 }, (_, i) => `l${i}`)
        .join("\n")
        .concat("\n"),
    )
    const view = lines(t, 20)
    // Renderer flat: tak ada jendela 10 baris, tak ada header "+ thinking",
    // dan tak ada penanda "N more lines" — seluruh area thinking dimatikan.
    expect(view.some((l) => l.includes("more lines"))).toBe(false)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    expect(view.some((l) => l.includes("l19"))).toBe(false)
    expect(view.some((l) => l.includes("l0"))).toBe(false)
  })

  test("v0.33: setelah commit, sidebar thinking tetap membaca isi /expand", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("alpha\nbeta\ngamma")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    // commitThinking mengosongkan buffer live — sidebar HARUS mengambil dari
    // collapsedSectionsSnapshot("thinking") supaya tidak jadi kosong.
    const sidebar = t.sidebarThinking(10, 40).join("\n")
    expect(sidebar).toContain("alpha")
    expect(sidebar).toContain("beta")
    expect(sidebar).toContain("gamma")
  })

  test("mode area: turn selesai → ringkas 1 baris + detail di /expand", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("alpha\nbeta\ngamma")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20).join("\n")
    expect(all).toContain("+ thinking")
    expect(all).toContain("3 lines")
    // v0.33: /expand dihapus — detail penuh kini di riwayat sidebar thinking.
    const history = t.sidebarThinking(20, 40).join("\n")
    expect(history).toContain("alpha")
    expect(history).toContain("gamma")
  })

  test("mode area: setelah turn selesai tidak ada duplikasi blok", () => {
    const { t, reason, emit } = setup({ activityPanel: true })
    reason("a\nb")
    emit({ type: "turn.completed", seq: 1, turnId: 1 })
    const all = lines(t, 20)
    const headers = all.filter((l) => l.includes("+ thinking"))
    expect(headers).toHaveLength(1)
  })

  test("panel OFF: perilaku legacy (stream per baris, tanpa header area)", () => {
    const { t, reason } = setup({ activityPanel: false })
    reason("satu\ndua")
    const view = lines(t)
    expect(view.some((l) => l.includes("satu"))).toBe(true)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
    // Satu baris sudah di-commit (legacy) + ekor hidup.
    expect(t.size()).toBe(1)
  })

  test("reasoning disembunyikan: tidak ada area sama sekali", () => {
    const { t, reason } = setup({ activityPanel: true, reasoningVisible: false })
    reason("rahasia")
    const view = lines(t)
    expect(view.some((l) => l.includes("rahasia"))).toBe(false)
    expect(view.some((l) => l.includes("+ thinking"))).toBe(false)
  })
})
