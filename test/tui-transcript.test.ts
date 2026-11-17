// Unit Transcript: koleksi event → baris logis → viewport.
import { describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { glyphs } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  return { bus, t }
}

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "write_file",
    target: "a.ts",
    status: "completed",
    tsStart: Date.now(),
    ...overrides,
  }
}

function setupPresentation(snapshot: UiPresentationSnapshot) {
  const bus = createFakeBus()
  let handler: ((event: never) => void) | undefined
  const t = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    onPresentationEvent: (next) => {
      handler = next as (event: never) => void
      return () => {
        handler = undefined
      }
    },
  })
  return {
    bus,
    t,
    emit(type: string, payload: Record<string, unknown>) {
      handler?.({ type, ...payload } as never)
    },
  }
}

describe("Transcript", () => {
  test("teks model mengalir sebagai ekor hidup lalu commit saat turn selesai", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "halo " })
    // Belum commit tapi terlihat di viewport (ekor hidup).
    expect(t.view(40, 3, 0).join("\n")).toContain("halo")
    bus.emit("provider:text", { text: "dunia" })
    bus.emit("turn:completed", {})
    expect(t.size()).toBe(1)
    expect(t.view(40, 3, 0)[2]).toBe("   halo dunia")
  })
  test("attempt provider gagal dihapus dari jawaban live dan diberi penanda", () => {
    const { bus, t } = setup()
    bus.emit("provider:extension", {
      kind: "minicode:attempt",
      data: { phase: "started", attemptId: 1 },
    })
    bus.emit("provider:text", { text: "PARTIAL" })
    bus.emit("provider:extension", {
      kind: "minicode:attempt",
      data: { phase: "invalidated", attemptId: 1, hadVisibleOutput: true, reason: "stream-error" },
    })
    bus.emit("provider:extension", {
      kind: "minicode:attempt",
      data: { phase: "started", attemptId: 2 },
    })
    bus.emit("provider:text", { text: "FINAL" })
    bus.emit("provider:extension", {
      kind: "minicode:attempt",
      data: { phase: "completed", attemptId: 2, hadVisibleOutput: true },
    })
    bus.emit("turn:completed", {})
    const out = t.view(100, 8, 0).join("\n")
    expect(out).toContain("FINAL")
    expect(out).toContain("attempt 1")
    expect(out).not.toContain("PARTIAL")
  })
  test("buffer live punya cap dan menandai truncasi", () => {
    const bus = createFakeBus()
    const t = new Transcript(bus as never, { maxPendingChars: 10 })
    bus.emit("provider:text", { text: "012345" })
    bus.emit("provider:text", { text: "6789ABC" })
    expect(t.view(40, 3, 0).join("\n")).toContain("truncated")
    bus.emit("turn:completed", {})
    expect(t.view(40, 3, 0).join("\n")).toContain("truncated")
  })
  test("ledger tool sukses satu baris › nama target", () => {
    const { t, emit } = setupPresentation({
      activities: [activity({ status: "completed" })],
      turns: [],
    })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "call-1", status: "completed" })
    const out = t.view(60, 2, 0).join("\n")
    expect(out).toContain("write_file a.ts")
    expect(out).toContain("completed")
  })
  test("ledger error satu baris merah diawali ›", () => {
    const { t, emit } = setupPresentation({
      activities: [
        activity({
          toolCallId: "bash-1",
          name: "bash",
          target: undefined,
          status: "failed",
        }),
      ],
      turns: [],
    })
    emit("tool.failed", {
      seq: 1,
      turnId: 1,
      toolCallId: "bash-1",
      status: "failed",
      message: "boom\nbaris2",
    })
    const out = t.view(60, 2, 0).join("\n")
    expect(out).toContain("bash")
    expect(out).toContain("failed")
    expect(out).toContain("boom")
    expect(out).not.toContain("baris2")
  })
  test("nama tool tak terpercaya disanitasi (tak bisa clear-screen)", () => {
    const { t, emit } = setupPresentation({
      activities: [activity({ toolCallId: "x1", name: "x\x1b[2J", target: undefined })],
      turns: [],
    })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "x1", status: "completed" })
    expect(t.view(60, 2, 0).join("")).not.toContain("\x1b[2J")
  })
  test("jawaban model me-render markdown inline (bold/code/heading)", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "## Ringkasan\nHasil **tebal** dan `kode`." })
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain("Ringkasan")
    expect(out).toContain("tebal")
    expect(out).toContain("kode")
    expect(out).not.toContain("**")
    expect(out).not.toContain("##")
    expect(out).not.toContain("`kode`")
  })
  test("jawaban model merapatkan blank line luar tanpa mengubah blank line code", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", {
      text: "\n\n## Ringkasan\n\n\nParagraf.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n",
    })
    bus.emit("turn:completed", {})
    const out = t.view(80, 20, 0).join("\n").trim()
    expect(out).toContain("Ringkasan\n\n   Paragraf.")
    expect(out).not.toContain("Paragraf.\n\n\n")
    expect(out).toContain("const a = 1\n\n   const b = 2")
  })
  test("jawaban streaming mempertahankan blank line di fence yang belum lengkap", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "```ts\nconst a = 1\n\n" })
    bus.emit("turn:completed", {})
    const rows = t.view(80, 10, 0)
    expect(t.size()).toBeGreaterThanOrEqual(2)
    expect(rows.join("\n")).toContain("const a = 1")
  })
  test("code fence model menyembunyikan delimiter dan menjaga isi literal", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "```\n**bukan bold**\n```" })
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain("**bukan bold**")
    expect(out).not.toContain("```")
  })
  test("gema user tidak me-render markdown (literal)", () => {
    const { t } = setup()
    t.pushUser("pakai **bintang** ya")
    expect(t.view(60, 2, 0).join("\n")).toContain("**bintang**")
  })
  test("gema user + error + info + clear", () => {
    const { t } = setup()
    t.pushUser("tanya\nlanjut")
    t.pushError("gagal <x>")
    t.pushInfo(["satu", "dua"])
    const out = t.view(40, 6, 0).join("\n")
    expect(out).toContain(`minicode ${glyphs.arrow} tanya`)
    expect(out).toContain("gagal <x>")
    expect(out).toContain("dua")
    t.clear()
    expect(t.size()).toBe(0)
    expect(t.view(40, 2, 0)).toEqual(["", ""])
  })
  test("view selalu tepat height (padding) + scrollBack menggeser", () => {
    const { t } = setup()
    t.pushInfo(["a", "b", "c", "d"])
    expect(t.view(40, 6, 0)).toEqual(["", "", "a", "b", "c", "d"])
    expect(t.view(40, 2, 2)).toEqual(["a", "b"])
  })
  test("cap 5000 membuang tertua dan menambahkan marker", () => {
    const { t } = setup()
    const lines = Array.from({ length: 5010 }, (_, i) => `l${i}`)
    t.pushInfo(lines)
    expect(t.size()).toBe(5001)
    expect(t.view(100, 1, 5000)[0]).toContain("10 early lines")
  })
  test("total() monotonik kebal evict (basis indikator F-08)", () => {
    // size() menyusut saat cap membuang tertua → newCount negatif/hilang.
    const { t } = setup()
    t.pushInfo(Array.from({ length: 5010 }, (_, i) => `l${i}`))
    expect(t.size()).toBe(5001)
    expect(t.total()).toBe(5010)
    t.pushInfo(["baru"])
    expect(t.total()).toBe(5011)
  })
  test("projection selection menyalin logical text tanpa wrap/prefix", () => {
    const { t } = setup()
    t.pushInfo(["alpha beta", "gamma"])
    t.pushUser("prompt\nnext")
    const rows = t.viewport(40, 8, 0).rows
    const alpha = rows.find((row) => row.text.includes("alpha"))!
    const prompt = rows.find((row) => row.text.includes("minicode"))!
    const alphaStart = t.pointAt(alpha, 0)!
    const alphaEnd = t.pointAt(alpha, 5)!
    expect(t.selectionText(alphaStart, alphaEnd)).toBe("alpha")
    const promptStart = t.pointAt(prompt, 11)!
    expect(t.selectionText(promptStart, promptStart)).toBe("")
  })
  test("selection wrapped tetap satu logical source tanpa newline artefaktual", () => {
    const { t } = setup()
    t.pushInfo(["abcdefghijklmnopqrst"])
    const rows = t.viewport(10, 4, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 1)!
    const end = t.pointAt(rows[1]!, 10)!
    expect(t.selectionText(start, end)).toBe("bcdefghijklmnopqrst")
  })
  test("user prompt wrapped tetap copy tanpa prefix chrome", () => {
    const { t } = setup()
    t.pushUser("abcdefghijkl")
    const rows = t.viewport(10, 4, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 0)!
    const last = rows[rows.length - 1]!
    const end = t.pointAt(last, displayWidth(last.text))!
    expect(t.selectionText(start, end)).toBe("abcdefghijkl")
  })
  test("tabel selection memakai TSV tanpa border/padding", () => {
    const { t } = setup()
    t.pushInfo(["| A | B |\n| --- | --- |\n| x | y |"])
    const rows = t.viewport(40, 8, 0).rows.filter((row) => row.selectable)
    const start = t.pointAt(rows[0]!, 0)!
    const end = t.pointAt(rows[rows.length - 1]!, 40)!
    expect(t.selectionText(start, end)).toBe("A\tB\nx\ty")
  })
  test("wrappedLength = jumlah baris visual view (kunci scroll)", () => {
    const { t } = setup()
    t.pushInfo(["a", "b", "c"])
    expect(t.wrappedLength(40)).toBe(3)
    expect(t.view(40, 3, 0).filter((l) => l !== "").length).toBe(3)
  })
  test("kompaksi konteks jadi baris redup", () => {
    const { bus, t } = setup()
    bus.emit("context:compacted", { reason: "penuh" })
    expect(t.view(40, 2, 0).join("\n")).toContain("compacted")
  })
  test("thinking default hidden: transcript bersih, indikator dots dimiliki App", async () => {
    const { defaultUiState } = await import("../src/ui/session-state.ts")
    expect(defaultUiState.reasoningVisible).toBe(false)
    const { bus, t } = setup()
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "hmm " } })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "mikirmodelrahasia" } })
    const live = t.view(40, 3, 0).join("\n")
    expect(live).not.toContain("thinking")
    expect(live).not.toContain("mikirmodelrahasia")
    bus.emit("turn:completed", {})
    expect(t.view(40, 3, 0).join("\n")).not.toContain("thinking")
    expect(
      defaultUiState.collapsedSectionsSnapshot().some((s) => s.text.includes("mikirmodelrahasia")),
    ).toBe(true)
    defaultUiState.clearCollapsedSections()
  })
  test("thinking expanded: mengalir redup per baris", async () => {
    const { setReasoningVisible } = await import("../src/ui/render/reasoning.ts")
    setReasoningVisible(true)
    try {
      const { bus, t } = setup()
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "baris-satu\nbaris-dua" } })
      const live = t.view(60, 4, 0).join("\n")
      expect(live).toContain("baris-satu")
      expect(live).not.toContain("… thinking")
    } finally {
      setReasoningVisible(false)
    }
  })
})

describe("P1 operator diagnostics in TUI", () => {
  test("verification.observed dirender (tidak lagi ditelan guard tool.*)", () => {
    const { t, emit } = setupPresentation({
      activities: [activity({ toolCallId: "call-v", name: "edit", target: "a.ts" })],
      turns: [],
    })
    emit("verification.observed", {
      seq: 2,
      turnId: 1,
      toolCallId: "call-v",
      verification: {
        invocationId: "inv-1",
        verdict: "present",
        method: "journal",
        observedAt: 1,
      },
    })
    expect(t.view(80, 3, 0).join("\n")).toContain("verified")
  })

  test("consequence.decided menampilkan verdict + next action", () => {
    const { t, emit } = setupPresentation({ activities: [], turns: [] })
    emit("consequence.decided", {
      seq: 3,
      turnId: 1,
      verdict: "BLOCKED",
      failureClass: "EVALUATOR_TAMPER_ATTEMPT",
      nextAction: "STOP_AND_REPORT",
      message: "verifier script modified",
    })
    const out = t.view(100, 4, 0).join("\n")
    expect(out).toContain("consequence")
    expect(out).toContain("BLOCKED")
    expect(out).toContain("STOP_AND_REPORT")
  })

  test("context.window memakai occupancy/capacity, bukan session spend", () => {
    const { t, emit } = setupPresentation({ activities: [], turns: [] })
    emit("context.window", {
      seq: 4,
      turnId: 1,
      usedTokens: 1200,
      windowTokens: 4000,
      percent: 30,
    })
    const out = t.view(100, 3, 0).join("\n")
    expect(out).toContain("context window")
    expect(out).toContain("1,200/4,000")
    expect(out).toContain("30%")
  })

  test("task COMPLETED tanpa verification tampil unverified (bukan PASS)", () => {
    const { t, emit } = setupPresentation({ activities: [], turns: [] })
    emit("task.status", {
      seq: 6,
      turnId: 1,
      taskId: "t1",
      taskStatus: "COMPLETED",
      taskVerification: { verdict: "unverified", checkedAt: "" },
    })
    expect(t.view(100, 3, 0).join("\n")).toContain("[unverified]")
  })

  test("tool.denied menampilkan denyReason", () => {
    const { t, emit } = setupPresentation({
      activities: [
        activity({
          toolCallId: "call-d",
          name: "write_file",
          target: "a.ts",
          status: "denied",
          denyReason: "read-only mode",
        }),
      ],
      turns: [],
    })
    emit("tool.denied", {
      seq: 5,
      turnId: 1,
      toolCallId: "call-d",
      status: "denied",
      reason: "read-only mode",
    })
    expect(t.view(100, 3, 0).join("\n")).toContain("read-only mode")
  })
})

describe("Transcript.replayHistory (resume)", () => {
  test("membangun ulang echo user + jawaban model", () => {
    const { t } = setup()
    t.replayHistory([
      { type: "user.message", text: "buat file a.ts", turnId: 1 },
      { type: "model.completed", text: "Baik, saya buat file-nya.", turnId: 1 },
    ])
    const out = t.view(120, 8, 0).join("\n")
    expect(out).toContain("buat file a.ts")
    expect(out).toContain("Baik, saya buat file-nya.")
  })

  test("membangun ulang ledger tool dari snapshot resume", () => {
    const { t } = setupPresentation({
      activities: [
        activity({ toolCallId: "call-1", name: "write_file", target: "a.ts", status: "completed" }),
      ],
      turns: [],
    })
    t.replayHistory([
      { type: "tool.completed", seq: 4, turnId: 1, toolCallId: "call-1", status: "completed" },
    ])
    const out = t.view(120, 8, 0).join("\n")
    expect(out).toContain("write_file")
    expect(out).toContain("a.ts")
  })
})

describe("Transcript UI audit regressions (Fase 3.2-3.4)", () => {
  test("pushUser menyisipkan jeda antar-turn bila transkrip tidak kosong dan patuh MINICODE_ASCII=1", () => {
    const prevAscii = process.env.MINICODE_ASCII
    const prevWt = process.env.WT_SESSION
    process.env.WT_SESSION = "1"
    process.env.MINICODE_ASCII = "1"
    try {
      const { t } = setup()
      t.pushInfo(["jawaban"])
      t.pushUser("pertanyaan dua")
      const rows = t.view(40, 4, 0)
      expect(rows).toContain("")
      expect(rows.some((l) => l.includes("minicode > pertanyaan dua"))).toBe(true)
      expect(rows.some((l) => l.includes("›"))).toBe(false)
    } finally {
      if (prevAscii === undefined) delete process.env.MINICODE_ASCII
      else process.env.MINICODE_ASCII = prevAscii
      if (prevWt === undefined) delete process.env.WT_SESSION
      else process.env.WT_SESSION = prevWt
    }
  })

  test("code fence berbahasa menampilkan tag bahasa redup dan membiarkan kode utuh", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "```ts\nconst a = 1\n```" })
    bus.emit("turn:completed", {})
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain(`${glyphs.dot} ts`)
    expect(out).toContain("const a = 1")
  })

  test("mouse selection pada baris user memperhitungkan displayStart chrome prefix", () => {
    const { t } = setup()
    t.pushUser("hello world")
    const rows = t.viewport(60, 4, 0).rows
    const prompt = rows.find((r) => r.text.includes("minicode"))!
    expect(prompt.displayStart).toBe(11)
    const start = t.pointAt(prompt, 11)!
    const end = t.pointAt(prompt, 16)!
    expect(t.selectionText(start, end)).toBe("hello")
    expect(t.columnAtOffset(prompt, start.offset)).toBe(11)
    expect(t.columnAtOffset(prompt, end.offset)).toBe(16)
  })

  test("mouse selection pada baris markdown inline selaras dengan kolom tampilan", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", { text: "Use **bold** end" })
    bus.emit("turn:completed", {})
    const rows = t.viewport(60, 4, 0).rows
    const mdRow = rows.find((r) => r.text.includes("Use"))!
    expect(mdRow.displayStart).toBe(3)
    expect(mdRow.displayEnd).toBe(15)
    const start = t.pointAt(mdRow, 3)!
    const end = t.pointAt(mdRow, 15)!
    expect(t.selectionText(start, end)).toBe("Use **bold** end")
    expect(t.columnAtOffset(mdRow, end.offset)).toBe(15)
    // Menarik mulai kolom margin kiri (0) tetap mendarat di awal konten logis.
    expect(t.pointAt(mdRow, 0)!.offset).toBe(start.offset)
  })

  test("wrap multi-tingkat menjaga batas kiri tiap level dan selection tetap akurat", () => {
    const { bus, t } = setup()
    const nested =
      "   - sub item panjang sekali yang harus terbungkus rapi di bawah levelnya tanpa kembali ke tepi"
    bus.emit("provider:text", {
      text: `1. Poin utama pertama yang ringkas\n${nested}\n2. Poin utama kedua`,
    })
    bus.emit("turn:completed", {})
    const rows = t.viewport(44, 20, 0).rows
    const plain = rows.map((r) => r.text).filter(Boolean)
    // Jeda vertikal antara poin utama `1.` dan `2.` (dengan sub-item tetap terkelompok).
    const p1Idx = plain.findIndex((l) => l.includes("1. Poin utama"))
    const subIdx = plain.findIndex((l) => l.includes("- sub item"))
    const p2Idx = plain.findIndex((l) => l.includes("2. Poin utama kedua"))
    expect(p1Idx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBe(p1Idx + 1)
    expect(p2Idx).toBeGreaterThan(subIdx + 1)

    // Setiap baris lanjutan sub-item wajib menjorok >= 8 kolom (margin 3 + indent 3 + "- " 2).
    const subRows = rows.filter(
      (r) => r.selectable && (r.text.includes("- sub item") || /^\s{8}\S/.test(r.text)),
    )
    expect(subRows.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < subRows.length; i++) {
      expect(subRows[i]!.text).toMatch(/^\s{8}\S/)
      expect(subRows[i]!.displayStart).toBe(8)
    }

    // Drag selection lintas baris terbungkus menyalin teks asli tanpa spasi gantung sintetis.
    const first = subRows[0]!
    const last = subRows[subRows.length - 1]!
    const selStart = t.pointAt(first, first.displayStart)!
    const selEnd = t.pointAt(last, last.displayEnd)!
    expect(t.selectionText(selStart, selEnd)).toBe(nested)
  })
})
