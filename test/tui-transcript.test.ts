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
    // v7.28 anchor atas: konten mulai di baris PERTAMA, padding kosong di bawah.
    expect(t.view(40, 3, 0).join("\n")).toContain("halo")
    bus.emit("provider:text", { text: "dunia" })
    bus.emit("turn:completed", {})
    expect(t.size()).toBe(1)
    expect(t.view(40, 3, 0)[0]).toBe("   halo dunia")
    expect(t.view(40, 3, 0).slice(1)).toEqual(["", ""])
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
    expect(out).toContain("› write_file a.ts")
    // Sukses tidak mencetak kata status: baris hijau sudah menyatakannya, dan
    // daftar tool yang panjang jadi derau bila setiap baris berakhir "completed".
    expect(out).not.toContain("completed")
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
  test("gema prompt user menampilkan markdown literal di transkrip (v7.29)", () => {
    const { t } = setup()
    t.pushUser("pakai **bintang** ya")
    // v7.29: prompt adalah history biasa — gema `minicode › …` tampil di
    // viewport dengan markdown LITERAL (tak di-render jadi bold, tak pindah ke card).
    const out = t.view(60, 4, 0).join("\n")
    expect(out).toContain("minicode › pakai **bintang** ya")
    expect(out).not.toContain("minicode › pakai bintang ya")
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
    // v7.28 anchor atas: `scrollBack = 0` = kepala, konten di Atas dan sisa
    // tinggi viewport diisi baris kosong DI BAWAH (bukan di atas seperti dulu).
    expect(t.view(40, 6, 0)).toEqual(["a", "b", "c", "d", "", ""])
    // scrollBack naik menggulir KE BAWAH menuju ekor: 2 → baris "c","d".
    expect(t.view(40, 2, 2)).toEqual(["c", "d"])
  })
  test("cap 5000 membuang tertua dan menambahkan marker", () => {
    const { t } = setup()
    const lines = Array.from({ length: 5010 }, (_, i) => `l${i}`)
    t.pushInfo(lines)
    expect(t.size()).toBe(5001)
    // v7.28 anchor atas: marker evict menandai baris TERTUA, jadi ia duduk di
    // kepala (scrollBack = 0), bukan di ekor. Di ekor (scrollBack = maks) ada
    // baris terbaru — kedua ujung tetap diverifikasi.
    expect(t.view(100, 1, 0)[0]).toContain("10 early lines")
    expect(t.view(100, 1, 5000)[0]).toBe("l5009")
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
  test("baris wrapped tetap copy tanpa prefix chrome", () => {
    const { t } = setup()
    // Prompt user kini di card; pakai baris info untuk menguji pemetaan
    // seleksi teks terbungkus tanpa prefix dekoratif.
    t.pushInfo(["abcdefghijkl"])
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
    // State reasoning adalah singleton proses — test lain bisa mengubahnya.
    // Reset eksplisit ke false supaya asersi "default hidden" tak bergantung
    // pada urutan test, lalu kembalikan ke nilai semula di finally.
    const { defaultUiState } = await import("../src/ui/session-state.ts")
    const { setReasoningVisible } = await import("../src/ui/render/reasoning.ts")
    const prevReasoning = defaultUiState.reasoningVisible
    setReasoningVisible(false)
    try {
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
        defaultUiState
          .collapsedSectionsSnapshot()
          .some((s) => s.text.includes("mikirmodelrahasia")),
      ).toBe(true)
      defaultUiState.clearCollapsedSections()
    } finally {
      setReasoningVisible(prevReasoning)
    }
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

describe("P1 operator diagnostics in TUI (renderer flat)", () => {
  test("verification.observed tidak dirender di renderer flat (event tetap dikonsumsi)", () => {
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
    // Baris diagnostik verifikasi dihapus; event return lebih awal supaya tak
    // jatuh ke guard tool.* (itulah alasan konsumsinya tetap dipertahankan).
    expect(t.view(80, 3, 0).join("\n")).not.toContain("verified")
    expect(t.view(80, 3, 0).join("\n")).not.toContain("unverified")
    // Positif: jalur tool biasa masih hidup dan menampilkan satu baris flat.
    emit("tool.completed", { seq: 3, turnId: 1, toolCallId: "call-v", status: "completed" })
    expect(t.view(80, 3, 0).join("\n")).toContain("edit a.ts")
  })

  test("consequence.decided tidak dirender di renderer flat", () => {
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
    // Verdict/next-action kini derau di transkrip flat: tak ada baris baru.
    expect(out).not.toContain("consequence")
    expect(out).not.toContain("BLOCKED")
    expect(out).not.toContain("STOP_AND_REPORT")
    expect(t.size()).toBe(0)
  })

  test("context.window tidak dirender di renderer flat", () => {
    const { t, emit } = setupPresentation({ activities: [], turns: [] })
    emit("context.window", {
      seq: 4,
      turnId: 1,
      usedTokens: 1200,
      windowTokens: 4000,
      percent: 30,
    })
    const out = t.view(100, 3, 0).join("\n")
    // Occupancy/capacity memang info nyata, tapi bukan lagi baris transkrip.
    expect(out).not.toContain("context window")
    expect(out).not.toContain("1,200/4,000")
    expect(out).not.toContain("30%")
    expect(t.size()).toBe(0)
  })

  test("task.status COMPLETED tanpa verification tidak dirender di renderer flat", () => {
    const { t, emit } = setupPresentation({ activities: [], turns: [] })
    emit("task.status", {
      seq: 6,
      turnId: 1,
      taskId: "t1",
      taskStatus: "COMPLETED",
      taskVerification: { verdict: "unverified", checkedAt: "" },
    })
    const out = t.view(100, 3, 0).join("\n")
    // Termasuk penanda `[unverified]`-nya: seluruh baris task kini hilang.
    expect(out).not.toContain("[unverified]")
    expect(out).not.toContain("t1")
    expect(t.size()).toBe(0)
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
    // v7.29: echo user adalah baris transkrip nyata, bukan helper/card —
    // replay harus mengembalikan gema `minicode › …` yang benar-benar tampil.
    const out = t.view(120, 8, 0).join("\n")
    expect(out.split("\n").some((line) => line.includes("minicode › buat file a.ts"))).toBe(true)
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
      // v7.29: prompt kini history — gema `minicode > …` (ASCII) tampil di
      // transkrip dengan tepat SATU jeda sebelum dan sesudahnya.
      // v7.42: echo user mengikuti margin kiri seragam (3 kolom).
      expect(rows).toEqual(["jawaban", "", "   minicode > pertanyaan dua", ""])
      // Kill-switch ASCII tetap berlaku: panah '›' tak boleh muncul.
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
    // Bar yang sama dengan isi blok: `· ts` terbaca seperti poin daftar.
    expect(out).toContain(`${glyphs.vLine} ts`)
    expect(out).toContain("const a = 1")
  })

  test("gema prompt user di viewport: prefix chrome tak ikut tersalin (v7.29)", () => {
    const { t } = setup()
    t.pushUser("hello world")
    const rows = t.viewport(60, 4, 0).rows
    // v7.29: prompt kini history — baris gema `minicode › hello world` benar-benar
    // ada di viewport (dulu disembunyikan demi card), tapi chrome tetap dikecualikan
    // dari sumber seleksi seperti sebelum kartu diperkenalkan.
    // v7.42: margin +3 → teks `minicode › hello world` mulai di kolom 3,
    // sumber (hello) mulai di kolom 11+3=14.
    const prompt = rows.find((r) => r.text.includes("minicode › hello world"))!
    expect(prompt.displayStart).toBe(14)
    const start = t.pointAt(prompt, 14)!
    const end = t.pointAt(prompt, 19)!
    expect(t.selectionText(start, end)).toBe("hello")
    expect(t.columnAtOffset(prompt, start.offset)).toBe(14)
    expect(t.columnAtOffset(prompt, end.offset)).toBe(19)
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

  test("projectTable menyertakan displayStart dan plainBody selaras kolom layar tabel", () => {
    const { t } = setup()
    t.pushInfo(["| KolomA | KolomB |\n| --- | --- |\n| satu | dua |"])
    const rows = t.viewport(60, 12, 0).rows
    const selectable = rows.filter((r) => r.selectable)
    expect(selectable.length).toBe(2)
    const headerRow = selectable[0]!
    // Renderer flat: tabel tanpa kotak, konten mulai di kolom 0.
    expect(headerRow.displayStart).toBe(0)
    expect(headerRow.plainBody).toBeDefined()
    expect(headerRow.plainBody!).not.toMatch(/^[│|]/)

    const pStart = t.pointAt(headerRow, headerRow.displayStart)!
    const pMid = t.pointAt(
      headerRow,
      Math.floor((headerRow.displayStart + headerRow.displayEnd) / 2),
    )!
    const pEnd = t.pointAt(headerRow, headerRow.displayEnd)!
    expect(pStart.offset).toBe(headerRow.sourceStart)
    expect(pMid.offset).toBeGreaterThan(pStart.offset)
    expect(pEnd.offset).toBe(headerRow.sourceEnd)

    const colStart = t.columnAtOffset(headerRow, pStart.offset)
    const colMid = t.columnAtOffset(headerRow, pMid.offset)
    const colEnd = t.columnAtOffset(headerRow, pEnd.offset)
    expect(colStart).toBe(headerRow.displayStart)
    expect(colMid).toBeGreaterThan(colStart)
    expect(colMid).toBeLessThan(colEnd)
    expect(colEnd).toBe(headerRow.displayEnd)
  })
})
