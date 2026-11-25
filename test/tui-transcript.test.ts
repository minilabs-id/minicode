// Unit Transcript: koleksi event → baris logis → viewport.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { paintLedger } from "../src/ui/render/ledger.ts"
import { c, glyphs, stripAnsi } from "../src/ui/render/theme.ts"
import { humanToolLabel, tSystem } from "../src/ui/render/tool-label.ts"
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
    expect(t.view(40, 3, 0)[0]).toBe("halo dunia")
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
    expect(out).toContain(`› ${humanToolLabel("write_file")} a.ts`)
    // Sukses tidak mencetak kata status: baris hijau sudah menyatakannya, dan
    // daftar tool yang panjang jadi derau bila setiap baris berakhir "completed".
    expect(out).not.toContain("completed")
  })
  test("ledger error satu baris merah diawali › — tanpa pola kanonik, raw tak tampil", () => {
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
    expect(out).toContain(humanToolLabel("bash"))
    expect(out).toContain("failed")
    // v0.43: "boom" bukan 13 pola kanonik — redaksi dihilangkan, bukan
    // diteruskan mentah. statusWord tetap jadi penanda kegagalan.
    expect(out).not.toContain("boom")
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
  test("tool in-flight muncul sebagai baris running di transkrip", () => {
    // Narasi live tak lagi dialihkan: baris `› nama target … running` wajib
    // terlihat di view() saat tool masih berjalan.
    const { t } = setupPresentation({
      activities: [
        activity({ toolCallId: "call-run", name: "grep", target: "src/", status: "running" }),
      ],
      turns: [],
    })
    const out = t.view(80, 4, 0).join("\n")
    expect(out).toContain("grep src/")
    expect(out).toContain("running")
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
  test("v0.33: dua baris kosong sebelum bab ###, sub-poin bullet tetap rapat", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", {
      text: [
        "Pembuka.",
        "### 1) Pertama",
        "- **Bukti:** alpha",
        "",
        "- **Dampak:** beta",
        "  - sub satu",
        "  - sub dua",
        "### 2) Kedua",
        "- **Bukti:** gamma",
      ].join("\n"),
    })
    bus.emit("turn:completed", {})
    const rows = t.view(80, 24, 0)
    const idx = rows.findIndex((r) => r.includes("2) Kedua"))
    expect(idx).toBeGreaterThan(0)
    expect(rows[idx - 1]).toBe("")
    expect(rows[idx - 2]).toBe("")
    // Dua bullet sibling tidak dipisah baris kosong.
    const bukti = rows.findIndex((r) => r.includes("Bukti: alpha"))
    const dampak = rows.findIndex((r) => r.includes("Dampak: beta"))
    expect(dampak).toBe(bukti + 1)
  })

  test("jawaban model merapatkan blank line luar tanpa mengubah blank line code", () => {
    const { bus, t } = setup()
    bus.emit("provider:text", {
      text: "\n\n## Ringkasan\n\n\nParagraf.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n",
    })
    bus.emit("turn:completed", {})
    const out = t.view(80, 20, 0).join("\n").trim()
    expect(out).toContain("Ringkasan\n\nParagraf.")
    expect(out).not.toContain("Paragraf.\n\n\n")
    expect(out).toContain("const a = 1\n\nconst b = 2")
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
    // v0.43: margin 3 milik FRAME — transkrip polos di kolom 0.
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
    // v0.43: margin adalah padding FRAME — teks sumber mulai di kolom 0.
    const alphaStart = t.pointAt(alpha, 0)!
    const alphaEnd = t.pointAt(alpha, 5)!
    expect(t.selectionText(alphaStart, alphaEnd)).toBe("alpha")
    const promptStart = t.pointAt(prompt, 11)!
    expect(t.selectionText(promptStart, promptStart)).toBe("")
  })
  test("selection wrapped tetap satu logical source tanpa newline artefaktual", () => {
    const { t } = setup()
    t.pushInfo(["abcdefghijklmnopqrst"])
    // v0.43: margin milik frame — lebar teks = lebar viewport (10), kolom
    // seleksi tak lagi digeser 3.
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
      const after = t.view(40, 3, 0).join("\n")
      // Reasoning tersembunyi tak bocor ke transkrip, baik saat live maupun
      // setelah turn ditutup. Ia tetap ada di jurnal presentasi.
      expect(after).not.toContain("thinking")
      expect(after).not.toContain("mikirmodelrahasia")
      expect(t.size()).toBe(0)
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
    expect(t.view(80, 3, 0).join("\n")).toContain(`${humanToolLabel("edit")} a.ts`)
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

describe("v0.43 — baris ledger error ringkas (tanpa duplikasi status/child)", () => {
  test("delegate_task gagal + 1 child: redaksi ringkas menang, warna paintLedger tetap", () => {
    const parentId = "call-delegate"
    const childId = "call-child"
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({
          toolCallId: parentId,
          name: "delegate_task",
          label: "delegate_task",
          status: "failed",
        }),
        activity({
          toolCallId: childId,
          name: "read_file",
          target: "a.ts",
          status: "failed",
          parentToolCallId: parentId,
        }),
      ],
      turns: [],
    }
    const { t, emit } = setupPresentation(snapshot)
    emit("tool.failed", {
      seq: 1,
      turnId: 1,
      toolCallId: parentId,
      name: "delegate_task",
      status: "failed",
      message: "[sub-agent error] turn exceeded 180000ms",
    })

    const rows = t.view(120, 6, 0)
    const redaksi = tSystem("msg.subagentFailed")
    // Satu baris ledger, bukan dua: status/child tak jadi baris sendiri.
    expect(rows.filter((row) => row.includes(redaksi))).toHaveLength(1)
    const painted = rows.find((row) => row.includes(redaksi))!
    const plain = stripAnsi(painted)
    // Redaksi kanonik tampil; duplikasi statusWord + hitungan child hilang.
    expect(plain).toContain(redaksi)
    expect(plain).not.toContain("child tools")
    expect(plain).not.toContain("tool anak")
    expect(plain).not.toMatch(/failed 1|\bgagal 1\b/)
    // Satu baris ≤120 kolom dan status visual tetap lewat paintLedger("failed", …).
    expect(displayWidth(plain)).toBeLessThanOrEqual(120)
    expect(painted).toBe(paintLedger("failed", plain))
  })
})

describe("v0.43 retry sukses menimpa kegagalan (bukan append)", () => {
  test("tool gagal → retry sukses: SATU baris ledger hijau, tanpa failed/boom", () => {
    const oldId = "read-1"
    const newId = "read-2"
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({ toolCallId: oldId, name: "read_file", target: "a.ts", status: "failed" }),
        activity({
          toolCallId: newId,
          name: "read_file",
          target: "a.ts",
          status: "completed",
          supersedes: oldId,
        }),
      ],
      turns: [],
    }
    const { t: tr, emit } = setupPresentation(snapshot)
    emit("tool.failed", {
      seq: 1,
      turnId: 1,
      toolCallId: oldId,
      status: "failed",
      message: "boom",
    })
    const before = tr.view(120, 20, 0).map(stripAnsi).join("\n")
    expect(before).toContain(humanToolLabel("read_file"))
    expect(before).toContain("failed")

    emit("tool.completed", { seq: 2, turnId: 1, toolCallId: newId, status: "completed" })
    emit("turn.completed", { seq: 3, turnId: 1 })

    const painted = tr.view(120, 20, 0)
    const led = painted.filter((l) => stripAnsi(l).includes(humanToolLabel("read_file")))
    expect(led).toHaveLength(1)
    const plain = stripAnsi(led[0]!)
    expect(plain).not.toContain("failed")
    expect(plain).not.toContain("boom")
    // Penanda attempt kedua tetap tampil: baris TUNGGAL ini jujur bahwa
    // keberhasilannya datang setelah retry, bukan hapus jejak attempt pertama.
    expect(plain).toContain(t("ts.retry"))
    expect(led[0]).toBe(paintLedger("completed", plain))

    // Rekap turn tak menghitung dua toolCallId sebagai dua tool.
    const recaps = painted.map(stripAnsi).filter((l) => /^\d+\s+\p{L}/u.test(l))
    expect(recaps.filter((l) => l.includes(t("ts.toolCategory.read")))).toHaveLength(1)
    expect(recaps.join("\n")).toContain(`1 ${t("ts.toolCategory.read")}`)
  })

  test("sub-agent gagal (1 child) → retry sukses: agregat ✦ 0 failed & biru", () => {
    const parentId = "delegate-1"
    const oldChild = "child-1"
    const newChild = "child-2"
    const child = (toolCallId: string, status: "failed" | "completed", supersedes?: string) =>
      activity({
        toolCallId,
        name: "read_file",
        target: "a.ts",
        status,
        parentToolCallId: parentId,
        childSessionId: "sub_1",
        runId: "run_1",
        label: "explore-1",
        ...(supersedes ? { supersedes } : {}),
      })
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({ toolCallId: parentId, name: "delegate_task", label: "delegate_task" }),
        child(oldChild, "failed"),
        child(newChild, "completed", oldChild),
      ],
      turns: [],
    }
    const { t: tr, emit } = setupPresentation(snapshot)
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: parentId, status: "completed" })
    emit("tool.failed", {
      seq: 2,
      turnId: 1,
      toolCallId: oldChild,
      status: "failed",
      message: "timeout 180000ms",
    })
    const before = tr.view(120, 20, 0).map(stripAnsi).join("\n")
    expect(before).toContain(`1 ${t("ts.agentReason.timeout")}`)

    emit("tool.completed", { seq: 3, turnId: 1, toolCallId: newChild, status: "completed" })

    const painted = tr.view(120, 20, 0)
    const aggs = painted.filter((l) => stripAnsi(l).includes(glyphs.agentIcon))
    expect(aggs).toHaveLength(1)
    const plain = stripAnsi(aggs[0]!)
    // Hitungan failure dikurangi, bukan menumpuk; agregat balik ke status normal.
    expect(plain).toContain(t("ts.agentSummary", { agents: 1, tools: 2, failed: 0 }))
    expect(plain).not.toContain(t("ts.agentReason.timeout"))
    expect(aggs[0]).toBe(c.info(plain))
    // Tak ada baris child merah mandiri yang tertinggal.
    expect(painted.map(stripAnsi).join("\n")).not.toContain(`1 ${t("ts.agentReason.timeout")}`)
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
    expect(out).toContain(humanToolLabel("write_file"))
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
      // v0.43: margin 3 milik FRAME — echo user polos di kolom 0.
      expect(rows).toEqual(["jawaban", "", "minicode > pertanyaan dua", ""])
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
    // v0.43: margin milik frame — sumber (hello) mulai di kolom 11 (dulu 14).
    const prompt = rows.find((r) => r.text.includes("minicode › hello world"))!
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
    expect(mdRow.displayStart).toBe(0)
    expect(mdRow.displayEnd).toBe(12)
    const start = t.pointAt(mdRow, 0)!
    const end = t.pointAt(mdRow, 12)!
    expect(t.selectionText(start, end)).toBe("Use **bold** end")
    expect(t.columnAtOffset(mdRow, end.offset)).toBe(12)
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

    // v0.43: margin 3 milik frame — indent lanjutan sub-item = 3 (sumber) + 2 ("- ") = 5.
    const subRows = rows.filter(
      (r) => r.selectable && (r.text.includes("- sub item") || /^\s{5}\S/.test(r.text)),
    )
    expect(subRows.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < subRows.length; i++) {
      expect(subRows[i]!.text).toMatch(/^\s{5}\S/)
      expect(subRows[i]!.displayStart).toBe(5)
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
    // v0.43: margin tabel milik frame — displayStart kembali ke 0.
    expect(headerRow.displayStart).toBe(0)
    expect(headerRow.plainBody).toBeDefined()
    expect(headerRow.plainBody!).not.toMatch(/^\s/)

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

  test("pushUser menerima lebar chat; wrap tidak memakai process.stdout.columns", () => {
    const src = readFileSync(new URL("../src/ui/tui/transcript.ts", import.meta.url), "utf8")
    const at = src.indexOf("pushUser(prompt:")
    const body = src.slice(at, src.indexOf("\n  /**", at + 1))
    expect(body).not.toContain("process.stdout.columns")

    const { t } = setup()
    t.pushUser("x".repeat(120), 60)
    const rows = t.viewport(60, 10, 0).rows
    // v0.43: width = 60-1 = 59, prefix 11 → isi 48 char → 120 = 48+48+24.
    const withX = rows.filter((r) => r.text.includes("x"))
    expect(withX).toHaveLength(3)
    expect(withX[0]!.text).toContain("minicode")
    for (const r of withX.slice(1)) {
      // Margin milik frame — baris lanjutan mulai di kolom 0.
      expect(r.text.startsWith("x")).toBe(true)
    }
  })

  test("selectionRange mengembalikan ujung pertama/terakhir untuk select-all", () => {
    const { t } = setup()
    expect(t.selectionRange()).toBeNull()
    t.pushInfo(["alpha", "beta", "gamma"])
    const range = t.selectionRange()
    expect(range).not.toBeNull()
    expect(t.selectionText(range!.first, range!.last)).toBe("alpha\nbeta\ngamma")
    // Titik pertama benar-benar awal sumber pertama, titik akhir = ekor terakhir.
    expect(range!.first.offset).toBe(0)
    const lastSource = t.viewport(60, 10, 0).rows.find((r) => r.text.includes("gamma"))!
    expect(range!.last.id).toBe(lastSource.sourceId)
  })
})

describe("v0.40 — baris live tool tetap tail transien (bukan commit-in-place)", () => {
  function setupMutable(initial: UiPresentationSnapshot) {
    const bus = createFakeBus()
    let snapshot = initial
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
      t,
      bus,
      set(next: UiPresentationSnapshot) {
        snapshot = next
      },
      emit(type: string, payload: Record<string, unknown>) {
        handler?.({ type, ...payload } as never)
      },
    }
  }

  test("running root adalah tail — size() 0 sebelum, saat, dan sesudah live", () => {
    const run = activity({ toolCallId: "m1", name: "grep", target: "src/", status: "running" })
    const { t, set } = setupMutable({ activities: [], turns: [] })
    expect(t.size()).toBe(0)

    set({ activities: [run], turns: [] })
    const live = t.view(80, 6, 0).join("\n")
    expect(live).toContain("grep src/")
    expect(live).toContain("running")
    // Baris live TIDAK pernah masuk `lines[]`/proyeksi.
    expect(t.size()).toBe(0)
    expect(t.total()).toBe(0)

    set({ activities: [], turns: [] })
    expect(t.view(80, 6, 0).join("\n")).not.toContain("grep src/")
    expect(t.size()).toBe(0)
    expect(t.total()).toBe(0)
  })

  test("tool terminal menulis SATU baris ledger ringkas (live hilang)", () => {
    const run = activity({ toolCallId: "m1", name: "grep", target: "src/", status: "running" })
    const { t, set, emit } = setupMutable({ activities: [run], turns: [] })
    expect(t.view(80, 6, 0).join("\n")).toContain("running")
    expect(t.size()).toBe(0)

    set({ activities: [activity({ ...run, status: "completed" })], turns: [] })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "m1", status: "completed" })

    const after = t.view(80, 6, 0).join("\n")
    expect(after).toContain(`› ${humanToolLabel("grep")} src/`)
    expect(after).not.toContain("running")
    expect(t.size()).toBe(1)
  })

  test("child yang diagregasi tak punya baris sendiri; agregat ✦ tetap", () => {
    const parent = activity({
      toolCallId: "p1",
      name: "delegate_task",
      target: undefined,
      status: "completed",
    })
    const child = activity({
      toolCallId: "c1",
      name: "read_file",
      target: "a.ts",
      parentToolCallId: "p1",
      childSessionId: "sub_1",
      runId: "run_1",
      label: "explore-a",
      status: "completed",
    })
    const { t, emit } = setupMutable({ activities: [parent, child], turns: [] })
    emit("tool.completed", { seq: 1, turnId: 1, toolCallId: "p1", status: "completed" })
    emit("tool.completed", { seq: 2, turnId: 1, toolCallId: "c1", status: "completed" })

    const after = t.view(120, 10, 0).join("\n")
    // Child ditelan induk: tak ada baris `read_file` sendiri (bukan commit-in-place).
    expect(
      after.split("\n").filter((l) => l.includes("read_file") || l.includes("read file")),
    ).toHaveLength(0)
    expect(after).toContain("✦ 1 sub agent · 1 tool · 0 failed")
    expect(after).not.toContain("running")
  })

  test("siklus live muncul→hilang tak menggeser indeks narasi committed di view()", () => {
    const { t, bus, set } = setupMutable({ activities: [], turns: [] })
    bus.emit("provider:text", { text: "narasi committed yang stabil" })
    bus.emit("turn:completed", {})
    const before = t.view(80, 8, 0)
    const idx = before.findIndex((r) => r.includes("narasi committed yang stabil"))
    expect(idx).toBeGreaterThanOrEqual(0)
    const committedSize = t.size()
    const committedTotal = t.total()

    set({
      activities: [
        activity({ toolCallId: "live-1", name: "grep", target: "src/", status: "running" }),
      ],
      turns: [],
    })
    const during = t.view(80, 8, 0)
    expect(during.findIndex((r) => r.includes("narasi committed yang stabil"))).toBe(idx)
    expect(during.join("\n")).toContain("grep src/")

    set({ activities: [], turns: [] })
    const after = t.view(80, 8, 0)
    expect(after.findIndex((r) => r.includes("narasi committed yang stabil"))).toBe(idx)
    expect(t.size()).toBe(committedSize)
    expect(t.total()).toBe(committedTotal)
  })

  test("liveRows(w) mengembalikan baris live tanpa menambah committed", () => {
    const parent = activity({
      toolCallId: "p",
      name: "delegate_task",
      target: undefined,
      status: "running",
    })
    const child = activity({
      toolCallId: "c",
      name: "read_file",
      target: "a.ts",
      parentToolCallId: "p",
      childSessionId: "sub_1",
      runId: "run_1",
      status: "running",
    })
    const orphan = activity({
      toolCallId: "o",
      name: "grep",
      target: "b.ts",
      parentToolCallId: "parent-yang-sudah-hilang",
      status: "running",
    })
    const { t, set } = setupMutable({ activities: [parent, child, orphan], turns: [] })
    const beforeSize = t.size()
    const beforeTotal = t.total()

    const rows = t.liveRows(40)
    expect(rows).toHaveLength(3)
    // Urutan root → anak → anak yatim (sama dengan tail lama).
    expect(rows[0]).toContain("delegate_task")
    expect(rows[1]).toContain("read_file")
    expect(rows[2]).toContain("grep")
    for (const row of rows) {
      expect(displayWidth(row)).toBe(40)
      expect(row).not.toContain("\x1b[2J")
    }
    // Murni pembaca: tak ada mutasi state.
    expect(t.size()).toBe(beforeSize)
    expect(t.total()).toBe(beforeTotal)

    set({ activities: [], turns: [] })
    expect(t.liveRows(40)).toEqual([])
  })

  test("v0.43: s > maxBack saat live hilang — committed tak bergeser, bawah kosong", () => {
    const { t, set } = setupMutable({ activities: [], turns: [] })
    t.pushInfo(["satu", "dua", "tiga", "empat"])
    const w = 80
    const h = 4
    // 4 committed + 1 live tool → total 5, maxBack 1. scrollBack di ekor = 1.
    set({
      activities: [
        activity({ toolCallId: "live-1", name: "grep", target: "src/", status: "running" }),
      ],
      turns: [],
    })
    expect(t.wrappedLength(w)).toBe(5)
    const before = t.viewport(w, h, 1)
    expect(before.totalRows).toBe(5)
    expect(before.maxBack).toBe(1)
    expect(before.firstIndex).toBe(1)
    expect(before.rows).toHaveLength(h)
    expect(before.rows.map((r) => r.text).slice(0, 3)).toEqual(["dua", "tiga", "empat"])
    expect(before.rows[3]!.text).toContain("grep")

    // Tool selesai tanpa ledger: baris live hilang, total menyusut jadi 4
    // (maxBack 0). scrollBack belum di-rebase → tetap 1, kini > maxBack.
    set({ activities: [], turns: [] })
    expect(t.wrappedLength(w)).toBe(4)
    const after = t.viewport(w, h, 1)
    expect(after.totalRows).toBe(4)
    expect(after.maxBack).toBe(0)
    // firstIndex = back yang dipakai (1), bukan yang ter-clamp (0).
    expect(after.firstIndex).toBe(1)
    expect(after.rows).toHaveLength(h)
    // Posisi baris committed di layar identik; baris bawah jadi kosong.
    expect(after.rows.map((r) => r.text).slice(0, 3)).toEqual(
      before.rows.map((r) => r.text).slice(0, 3),
    )
    expect(after.rows[3]!.text).toBe("")
    expect(after.rows[3]!.selectable).toBe(false)
  })

  test("v0.43: scrollBack jauh melebihi total → tepat h baris kosong, aman", () => {
    const { t } = setup()
    t.pushInfo(["hanya", "dua", "baris"])
    const vp = t.viewport(40, 5, 99)
    expect(vp.rows).toHaveLength(5)
    expect(vp.rows.every((r) => r.text === "")).toBe(true)
    expect(vp.firstIndex).toBe(99)
    expect(vp.totalRows).toBe(3)
    expect(vp.maxBack).toBe(0)
  })

  test("v0.43: regresi — scrollBack <= maxBack identik perilaku v0.40", () => {
    const { t } = setup()
    t.pushInfo(["a", "b", "c", "d", "e", "f"])
    const w = 40
    const h = 3
    // total 6, maxBack 3. s = 2 → baris indeks 2,3,4.
    const vp = t.viewport(w, h, 2)
    expect(vp.totalRows).toBe(6)
    expect(vp.maxBack).toBe(3)
    expect(vp.firstIndex).toBe(2)
    expect(vp.rows.map((r) => r.text)).toEqual(["c", "d", "e"])
    expect(t.view(w, h, 2)).toEqual(["c", "d", "e"])
    // s = maxBack → ekor; s = 0 → kepala.
    expect(t.view(w, h, 3)).toEqual(["d", "e", "f"])
    expect(t.view(w, h, 0)).toEqual(["a", "b", "c"])
  })

  test("v0.43: tail live dibatasi 3 aktivitas terakhir walau 20 running", () => {
    const activities = Array.from({ length: 20 }, (_, i) =>
      activity({
        toolCallId: `live-${i}`,
        name: "grep",
        target: `src/${i}`,
        status: "running",
      }),
    )
    const { t, set } = setupMutable({ activities, turns: [] })
    const w = 80
    // Tanpa committed, seluruh baris viewport = tail. Kap 3 → tepat 3 baris,
    // bukan 20 (dulu puluhan baris live mendorong narasi keluar layar).
    expect(t.wrappedLength(w)).toBe(3)
    const live = t.view(w, 20, 0).filter((row) => row.includes("grep src/"))
    expect(live).toHaveLength(3)
    // Yang tampil = TIGA aktivitas terakhir (urutan root → anak tetap jujur).
    expect(live[0]).toContain("src/17")
    expect(live[1]).toContain("src/18")
    expect(live[2]).toContain("src/19")
    // Murni pembaca: tak ada baris live yang masuk `lines[]`.
    expect(t.size()).toBe(0)
    expect(t.total()).toBe(0)

    set({ activities: [], turns: [] })
    expect(t.wrappedLength(w)).toBe(0)
    expect(t.view(w, 20, 0).filter((row) => row.includes("grep src/"))).toHaveLength(0)
  })
})
