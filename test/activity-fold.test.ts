// Renderer flat (full mono): lipatan aktivitas merangkum SATU baris kategori
// per turn (`1 command · 1 read`) yang jadi separator, dengan detail per-tool
// tetap ditulis di chat sebagai baris `› nama target` (mode default) atau
// dibaca dari jurnal presentasi (minimizeActivity). Tool gagal tetap tampil
// individual supaya alasannya tak hilang.
// v7.42: `+` ASCII di depan ringkasan dihapus — yang diuji tetap angka+label
// (count & kategori), bukan penandanya; kontrak tanpa duplikasi tetap dijaga.
import { describe, expect, test } from "bun:test"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../src/ui/contract.ts"
import { humanToolLabel } from "../src/ui/render/tool-label.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function activity(overrides: Partial<UiPresentationActivity>): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    target: "a.ts",
    status: "completed",
    tsStart: 1,
    ...overrides,
  }
}

function build(minimizeActivity: boolean, secondStatus: UiToolStatus = "completed") {
  const bus = createFakeBus()
  const uiState = new UiSessionState({ minimizeActivity })
  const snapshot: UiPresentationSnapshot = {
    activities: [
      activity({ toolCallId: "c1", name: "read_file", target: "a.ts" }),
      activity({ toolCallId: "c2", name: "bash", target: undefined, status: secondStatus }),
    ],
    turns: [],
  }
  const transcript = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    uiState,
  })
  const emit = (event: UiPresentationEvent) =>
    (
      transcript as unknown as { presentationEvent: (e: UiPresentationEvent) => void }
    ).presentationEvent.call(transcript, event)
  return { transcript, uiState, emit }
}

// Baris rekap = angka kategori di kolom 0 (margin 3 milik FRAME sejak v0.43,
// bukan spasi pada teks); baris tool (`› …`) tidak cocok dengan pola ini.
function recapLines(text: string): string[] {
  return text.split("\n").filter((l) => /^\d+\s+\p{L}/u.test(l))
}

describe("activity fold (minimizeActivity)", () => {
  test("setMinimizeActivity tidak menulis process.env (F-ENV-1)", () => {
    delete process.env.MINICODE_MINIMIZE_ACTIVITY
    const s = new UiSessionState()
    s.setMinimizeActivity(true)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
    s.setMinimizeActivity(false)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
  })

  test("tak ada slot live: rekap baru muncul permanen di akhir turn", () => {
    const { transcript, emit } = build(false)
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    const before = transcript.view(80, 20, 0).join("\n")
    // liveSummaryRows dihapus: tak ada baris rekap mengambang di ekor saat tool
    // selesai. Rekap hanya ditulis saat narasi dipotong tool / turn ditutup.
    expect(recapLines(before)).toHaveLength(0)
    emit({ type: "turn.completed", seq: 2, turnId: 1 })
    const after = transcript.view(80, 20, 0).join("\n")
    // Satu baris permanen: rekap kumulatif identik dengan segmen terakhir
    // tidak ditulis ulang (tanpa duplikat).
    expect(recapLines(after)).toHaveLength(1)
  })

  test("on: rekap segmen + kumulatif, tool gagal tetap tampil di chat", () => {
    const { transcript, emit } = build(true, "failed")
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    emit({ type: "tool.completed", seq: 2, turnId: 1, toolCallId: "c2", status: "failed" })
    // minimizeActivity: baris per-tool sukses ditahan; yang gagal tetap
    // individual dengan label manusiawi bahasa SISTEM (bukan `bash` mentah).
    const during = transcript.view(40, 10, 0).join("\n")
    expect(during).toContain(humanToolLabel("bash"))
    expect(recapLines(during)).toHaveLength(0) // tanpa slot live
    expect(during).not.toContain(`› ${humanToolLabel("read_file")}`)

    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    const view = transcript.view(40, 10, 0).join("\n")
    // Satu baris rekap permanen: kategori dihitung dari nama internal
    // (`1 command · 1 read`), kumulatif identik jadi tidak diduplikasi.
    expect(recapLines(view)).toHaveLength(1)
    expect(view.match(/\b1 command\b/g)?.length).toBe(1)
    expect(view).toContain("1 read")
    expect(view).not.toContain("2 tools")
    expect(view).not.toContain("ok ·")
    // Detail tetap di chat: baris tool gagal tidak ditelan lipatan.
    expect(view).toContain(humanToolLabel("bash"))
    expect(view).toContain("failed")
  })

  test("off: baris ledger per-tool read/bash tetap tampil di chat (transparan)", () => {
    const { transcript, emit } = build(false)
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    emit({ type: "tool.completed", seq: 2, turnId: 1, toolCallId: "c2", status: "completed" })
    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    const view = transcript.view(40, 10, 0).join("\n")
    expect(view).toContain(`› ${humanToolLabel("read_file")} a.ts`)
    expect(view).toContain(`› ${humanToolLabel("bash")}`)
    expect(recapLines(view)[0]).toContain("1 command · 1 read")
  })
})
