// Renderer flat (full mono): lipatan aktivitas merangkum SATU baris kategori
// per turn (`N command · N read`) yang jadi separator, dengan detail penuh
// tetap tersimpan untuk `/expand`. `minimizeActivity` menahan tool sukses agar
// tak menggandakan baris live; tool gagal tetap tampil individual.
// v7.42: `+` ASCII di depan ringkasan dihapus — yang diuji tetap angka+label
// (count & kategori), bukan penandanya; kontrak tanpa duplikasi tetap dijaga.
import { describe, expect, test } from "bun:test"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../src/ui/contract.ts"
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

describe("activity fold (minimizeActivity)", () => {
  test("setMinimizeActivity tidak menulis process.env (F-ENV-1)", () => {
    delete process.env.MINICODE_MINIMIZE_ACTIVITY
    const s = new UiSessionState()
    s.setMinimizeActivity(true)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
    s.setMinimizeActivity(false)
    expect(process.env.MINICODE_MINIMIZE_ACTIVITY).toBeUndefined()
  })

  test("on: SATU baris ringkas per turn + detail /expand; tool gagal tetap tampil", () => {
    const { transcript, uiState, emit } = build(true, "failed")
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    emit({ type: "tool.completed", seq: 2, turnId: 1, toolCallId: "c2", status: "failed" })
    // v7.36: status/jumlah + daftar tool tampil LIVE di bawah narasi. Saat
    // minimizeActivity, baris per-tool sukses tetap ditahan — namun daftar
    // nama di ringkasan live menggantikannya supaya tool yang dipakai tetap
    // terlihat sebelum turn tutup. Tool gagal tetap individual.
    const during = transcript.view(40, 10, 0).join("\n")
    expect(during).toContain("bash")
    expect(during).toContain("1 command")
    expect(during).toContain("1 read")
    expect(during).toContain("read_file")

    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    const view = transcript.view(40, 10, 0).join("\n")
    // Ringkasan permanen tepat SATU baris — baris live sudah hilang bersama
    // activityFold yang dikosongkan `flushActivityFold` (tanpa duplikasi).
    expect(view.match(/\b1 command\b/g)?.length).toBe(1)
    // Ringkasan kategori, bukan daftar "2 tools" / "N ok" lama.
    expect(view).toContain("1 command")
    expect(view).toContain("1 read")
    expect(view).not.toContain("2 tools")
    expect(view).not.toContain("ok ·")
    expect(view).not.toContain("read_file") // detail hanya di /expand
    expect(view).toContain("bash") // baris tool nyata tetap visible
    // Detail per-tool (termasuk sukses yang disembunyikan) tetap ada di /expand.
    const detail = uiState.collapsedSectionsSnapshot().find((s) => s.label === "activity")
    expect(detail).toBeDefined()
    expect(detail?.text).toContain("read_file")
    expect(detail?.text).toContain("bash")
  })

  test("off: baris ledger per-tool tetap tampil (transparan)", () => {
    const { transcript, emit } = build(false)
    emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    const view = transcript.view(40, 10, 0).join("\n")
    expect(view).toContain("read_file")
  })
})
