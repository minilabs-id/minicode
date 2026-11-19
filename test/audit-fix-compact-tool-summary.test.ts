// Audit fix: satu baris ringkas per turn untuk pemakaian tool (OpenCode-style
// `+ 5 command · 3 edit · 1 thought`) + penghapusan marker "step" dari area
// chat/prompt. Baris ini sekaligus separator antar turn. Hermetic: fake bus,
// tanpa TTY/jaringan — rendering layar penuh diuji tui-app.test.ts.
import { describe, expect, test } from "bun:test"
import type { UiPresentationEvent } from "../src/ui/contract.ts"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup(opts: { minimizeActivity?: boolean; activityPanel?: boolean } = {}) {
  setSessionLocale("en")
  const bus = createFakeBus()
  let handler: ((event: UiPresentationEvent) => void) | undefined
  const uiState = new UiSessionState(opts)
  const transcript = new Transcript(bus as never, {
    uiState,
    onPresentationEvent: (next) => {
      handler = next as (event: UiPresentationEvent) => void
      return () => {
        handler = undefined
      }
    },
  })
  return {
    transcript,
    uiState,
    emit(event: UiPresentationEvent) {
      handler?.(event)
    },
    screen() {
      return transcript.view(120, 40, 0).map(stripAnsi)
    },
  }
}

/** Baris ringkas = satu-satunya baris yang diawali spasi lalu "+ ". */
function summaryLines(lines: string[]): string[] {
  return lines.filter((l) => /^\s+\+\s/.test(l))
}

describe("compact tool summary per turn", () => {
  test("tool campuran → tepat SATU baris dengan hitungan per kategori", () => {
    const { transcript, emit, screen } = setup()
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    const tools: [string, string][] = [
      ["c1", "bash"],
      ["c2", "git_commit"],
      ["c3", "write_file"],
      ["c4", "edit"],
      ["c5", "read_file"],
      ["c6", "grep"],
      ["c7", "reasoning"],
    ]
    let seq = 2
    for (const [toolCallId, name] of tools) {
      emit({
        type: "tool.completed",
        seq: seq++,
        turnId: 1,
        toolCallId,
        name,
        status: "completed",
      })
    }
    emit({ type: "turn.completed", seq: seq, turnId: 1 })

    const lines = screen()
    const summaries = summaryLines(lines)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain("+ 2 command")
    expect(summaries[0]).toContain("2 edit")
    expect(summaries[0]).toContain("2 read")
    expect(summaries[0]).toContain("1 thought")
    // Kategori yang tak muncul tidak dicetak (nol disembunyikan).
    expect(summaries[0]).not.toContain("other")
    // Ringkasan berdiri sendiri: satu blank sebelum & sesudahnya.
    const idx = lines.indexOf(summaries[0]!)
    expect(lines[idx - 1]).toBe("")
    expect(lines[idx + 1]).toBe("")
    void transcript
  })

  test("satu baris per turn — dua turn menghasilkan dua separator", () => {
    const { emit, screen } = setup()
    for (const turnId of [1, 2]) {
      emit({ type: "turn.started", seq: turnId * 10, turnId })
      emit({
        type: "tool.completed",
        seq: turnId * 10 + 1,
        turnId,
        toolCallId: `c${turnId}`,
        name: turnId === 1 ? "bash" : "read_file",
        status: "completed",
      })
      emit({ type: "turn.completed", seq: turnId * 10 + 2, turnId })
    }
    const summaries = summaryLines(screen())
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toContain("1 command")
    expect(summaries[1]).toContain("1 read")
  })

  test("detail /expand tetap tersedia walau transkrip hanya satu baris", () => {
    const { uiState, emit } = setup()
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "write_file",
      target: "a.ts",
      status: "completed",
    })
    emit({
      type: "tool.completed",
      seq: 3,
      turnId: 1,
      toolCallId: "c2",
      name: "read_file",
      target: "b.ts",
      status: "completed",
    })
    emit({ type: "turn.completed", seq: 4, turnId: 1 })

    const detail = uiState.collapsedSectionsSnapshot().find((s) => s.label === "activity")
    expect(detail).toBeDefined()
    expect(detail?.text).toContain("write_file a.ts")
    expect(detail?.text).toContain("read_file b.ts")
  })

  test("turn tanpa tool tidak menghasilkan baris ringkas", () => {
    const { emit, screen } = setup()
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({ type: "turn.completed", seq: 2, turnId: 1 })
    expect(summaryLines(screen())).toHaveLength(0)
  })

  test("token kategori identik di locale id (jejak stabil lintas /lang)", () => {
    setSessionLocale("id")
    const bus = createFakeBus()
    let handler: ((event: UiPresentationEvent) => void) | undefined
    const transcript = new Transcript(bus as never, {
      onPresentationEvent: (next) => {
        handler = next as (event: UiPresentationEvent) => void
        return () => {
          handler = undefined
        }
      },
    })
    const emit = (event: UiPresentationEvent) => handler?.(event)
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({
      type: "tool.completed",
      seq: 2,
      turnId: 1,
      toolCallId: "c1",
      name: "bash",
      status: "completed",
    })
    emit({ type: "turn.completed", seq: 3, turnId: 1 })
    const summaries = summaryLines(transcript.view(120, 20, 0).map(stripAnsi))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain("1 command")
    expect(summaries[0]).not.toContain("perintah")
    setSessionLocale("en")
  })
})

describe("marker step tidak bocor ke chat/prompt", () => {
  test("step.started menyimpan data internal tapi tak ada 'step N' di transkrip", () => {
    const { transcript, emit, screen } = setup()
    emit({ type: "turn.started", seq: 1, turnId: 1 })
    emit({ type: "step.started", seq: 2, turnId: 1, step: 1, total: 5 })
    // Data/event tetap hidup (dipakai penelusuran), tapi bukan teks transkrip.
    expect(transcript.progressLabelText()).toBe("step 2/5")
    expect(screen().join("\n")).not.toContain("step 2/5")
    emit({
      type: "tool.completed",
      seq: 3,
      turnId: 1,
      toolCallId: "c1",
      name: "bash",
      status: "completed",
    })
    emit({ type: "turn.completed", seq: 4, turnId: 1 })
    const text = screen().join("\n")
    expect(text).not.toContain("step")
    expect(summaryLines(screen())).toHaveLength(1)
  })
})
