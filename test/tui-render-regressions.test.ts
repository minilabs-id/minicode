// Regresi render TUI (keluhan lapangan, 2026-11-14):
//
//   1. Baris `+ thinking · 3 lines` muncul berulang untuk satu turn karena
//      `execution:started` menyala tiap tool call.
//   2. Tool gagal dicetak individual DAN dihitung di baris grup → dobel.
//      Perbaikan pertama sempat MENELAN barisnya (alasan hilang) — dijaga di
//      sini supaya tidak kembali.
//   3. Alasan gagal ringkasan LLM menyeret JSON gateway mentah ke transkrip.
//
// Semua perilaku diuji lewat jalur NYATA (bus + presentation event), bukan
// dengan memanggil helper internal, karena bug aslinya muncul dari urutan
// event yang dirakit lapisan presentasi.

import { describe, expect, test } from "bun:test"
import { stripSgr } from "../src/ui/render/sanitize.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { TRANSCRIPT_CAP, Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

interface Harness {
  tr: Transcript
  ui: UiSessionState
  events: ((e: unknown) => void)[]
  acts: Record<string, unknown>[]
  emit: (event: Record<string, unknown>) => void
  rows: () => string[]
  /** v7.28: baca baris dari EKOR (scrollBack besar), bukan kepala. */
  tailRows: () => string[]
}

function harness(opts: { reasoning?: boolean } = {}): Harness {
  const ui = new UiSessionState({ activityPanel: true, minimizeActivity: true })
  if (opts.reasoning !== false) ui.setReasoningVisible(true)
  const bus = createFakeBus()
  const tasks: ((e: unknown) => void)[] = []
  const acts: Record<string, unknown>[] = []
  const tr = new Transcript(bus as never, {
    uiState: ui,
    getSnapshot: () => ({ activities: acts, turns: [] }) as never,
    onPresentationEvent: (handler) => {
      tasks.push(handler as (e: unknown) => void)
      return () => {}
    },
  })
  const emit = (event: Record<string, unknown>) => {
    for (const handler of tasks) handler(event)
  }
  const rows = () => {
    const view = (
      tr as unknown as {
        viewport: (w: number, h: number, back: number) => { rows: { text: string }[] }
      }
    ).viewport(100, 80, 0)
    return view.rows.map((row) => stripSgr(row.text).trimEnd()).filter((line) => line.length > 0)
  }
  // v7.28 anchor atas: `rows()` melihat KEPALA (scrollBack=0). Untuk kasus
  // eviction, baris yang diuji ada di EKOR — baca dengan scrollBack besar.
  const tailRows = () => {
    const view = (
      tr as unknown as {
        viewport: (w: number, h: number, back: number) => { rows: { text: string }[] }
      }
    ).viewport(100, 80, TRANSCRIPT_CAP)
    return view.rows.map((row) => stripSgr(row.text).trimEnd()).filter((line) => line.length > 0)
  }
  return { tr, ui, events: tasks, acts, emit, rows, tailRows }
}

const reasoning = (h: Harness, text: string) =>
  h.tr.extension({ kind: "reasoning", data: { text } } as never)

describe("thinking: satu baris per turn, bukan per segmen", () => {
  test("lima segmen thinking menyatu jadi satu baris terakumulasi", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    for (let i = 0; i < 5; i++) {
      reasoning(h, `pikir ${i}a\npikir ${i}b\npikir ${i}c`)
      // `tool.started` yang menutup segmen thinking di jalur nyata
      // (reasoning → tool call → reasoning lagi).
      h.emit({ type: "tool.started", toolCallId: `t${i}`, name: "bash", seq: i })
      h.emit({
        type: "tool.completed",
        toolCallId: `t${i}`,
        name: "bash",
        status: "completed",
        seq: i,
      })
    }
    h.emit({ type: "turn.completed", summary: {} })
    const rows = h.rows()
    const thinking = rows.filter((line) => line.includes("thinking"))
    // Sebelum perbaikan: lima baris `+ thinking · 3 lines`.
    expect(thinking.length).toBe(1)
    // Hitungannya TOTAL turn (5 segmen × 3 baris), bukan 3.
    expect(thinking[0]).toContain("15")
  })

  test("turn berikutnya memulai baris thinking sendiri", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    reasoning(h, "a\nb")
    h.emit({ type: "turn.completed", summary: {} })
    h.emit({ type: "turn.started" })
    reasoning(h, "c\nd")
    h.emit({ type: "turn.completed", summary: {} })
    expect(h.rows().filter((line) => line.includes("thinking")).length).toBe(2)
  })

  test("angka thinking turn kedua tidak melanjutkan turn pertama", () => {
    const h = harness()
    for (const turn of [1, 2]) {
      h.emit({ type: "turn.started" })
      reasoning(h, "a\nb")
      h.emit({ type: "tool.started", toolCallId: `t${turn}`, name: "bash" })
      h.emit({ type: "turn.completed", summary: {} })
    }
    const rows = h.rows().filter((line) => line.includes("thinking"))
    expect(rows.length).toBe(2)
    // Dulu turn kedua melaporkan "4 lines" karena akumulasi tidak direset.
    for (const row of rows) expect(row).toContain("2")
  })

  test("thinking tetap tampil walau baris lamanya ter-evict", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    reasoning(h, "segmen-awal")
    h.emit({ type: "tool.started", toolCallId: "t0", name: "bash" })
    // Banjiri sampai melewati batas transkrip: baris thinking lama terbuang.
    const tr = h.tr as unknown as { push: (line: string, meta?: unknown) => void }
    for (let i = 0; i < TRANSCRIPT_CAP + 20; i++) tr.push(`isian-${i}`)
    // Turn masih berjalan — segmen berikutnya WAJIB tetap terlihat.
    reasoning(h, "segmen-kedua")
    h.emit({ type: "tool.started", toolCallId: "t1", name: "bash" })
    // Segmen terbaru ada di ekor setelah banjir eviction (v7.28).
    expect(h.tailRows().some((line) => line.includes("thinking"))).toBe(true)
  })

  test("detail penuh tetap bisa diambil lewat /expand", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    reasoning(h, "baris-detail-penting\nbaris-kedua")
    h.emit({ type: "turn.completed", summary: {} })
    // Isi asli tidak dibuang ke mana-mana: tersimpan untuk /expand.
    const stored = h.ui.collapsedSectionsSnapshot()
    expect(stored.length).toBeGreaterThan(0)
    expect(JSON.stringify(stored)).toContain("baris-detail-penting")
  })
})

describe("tool gagal: satu baris, alasan tidak hilang", () => {
  test("tool gagal: alasan tercetak sekali di baris flat (tanpa panel grup)", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    for (let i = 0; i < 3; i++)
      h.emit({
        type: "tool.completed",
        toolCallId: `t${i}`,
        name: "bash",
        status: "completed",
        seq: i,
      })
    h.acts.push({
      toolCallId: "tf",
      name: "grep",
      status: "failed",
      tsStart: 0,
      error: { message: "pola tidak ditemukan" },
    })
    h.emit({
      type: "tool.failed",
      toolCallId: "tf",
      durationMs: 5,
      cause: "tool",
      message: "pola tidak ditemukan",
      expandRef: { kind: "tool", id: "tf" },
      seq: 9,
    })
    h.emit({ type: "turn.completed", summary: {} })
    const rows = h.rows()
    // Renderer flat (ledger) tak punya panel grup: satu baris tool gagal membawa
    // nama, status, dan alasan. Yang dijaga: alasan tampil tepat SEKALI dan tak
    // hilang (regresi lama: barisnya ditelan saat hitungan dipindah ke grup).
    expect(rows.filter((line) => line.includes("pola tidak ditemukan")).length).toBe(1)
    const failedRow = rows.find((line) => line.includes("pola tidak ditemukan"))!
    expect(failedRow).toContain("grep")
    expect(failedRow).toContain("failed")
    expect(failedRow).toContain("pola tidak ditemukan")
    // Tak ada lagi baris grup "execute · 3 ok" — tiap tool dicatat apa adanya.
    expect(rows.some((line) => line.includes("execute"))).toBe(false)
    expect(rows.some((line) => line.includes("3 ok"))).toBe(false)
  })

  test("tool ditolak juga tampil (alasan penolakan tidak ditelan)", () => {
    const h = harness()
    h.emit({ type: "turn.started" })
    h.acts.push({
      toolCallId: "td",
      name: "bash",
      status: "denied",
      tsStart: 0,
      denyReason: "mode allowlist menolak rm -rf",
    })
    h.emit({
      type: "tool.denied",
      toolCallId: "td",
      reason: "mode allowlist menolak rm -rf",
      seq: 1,
    })
    h.emit({ type: "turn.completed", summary: {} })
    const denied = h.rows().filter((line) => line.includes("rm -rf"))
    expect(denied.length).toBe(1)
  })
})

describe("alasan gagal ringkasan LLM dipendekkan", () => {
  const label = (reason: string) => {
    const h = harness()
    return (h.tr as unknown as { compactedLabel: (r: string) => string }).compactedLabel(reason)
  }

  test("JSON gateway 503 menjadi sebab yang bisa dibaca", () => {
    const out = label(
      'llm-failed:server error (503): {"error":{"origin":"tiprouter","code":"overloaded","requestId":"c38699cf-3559-43f3-998f-e2b014d147fb","message":"The gateway is overloaded (),"}}',
    )
    expect(out).toContain("503")
    expect(out).toContain("overloaded")
    // Yang tidak boleh: id request dan kurung JSON mentah ikut tercetak.
    expect(out).not.toContain("requestId")
    expect(out).not.toContain("c38699cf")
    expect(out).not.toContain("{")
    expect(out.length).toBeLessThan(140)
  })

  test("timeout tetap terbaca apa adanya", () => {
    expect(label("llm-failed:llm compaction timeout")).toContain("llm compaction timeout")
  })
})
