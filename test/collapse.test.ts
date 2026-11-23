// Section collapse (+ / - / /expand / /minimize): output besar (thinking,
// bash, edit, content tool) dikecilkan jadi satu baris `  + label` saat
// MINICODE_MINIMIZE_TOOL=1 (default REPL) — isi di-buffer, bukan dicetak.
// Env kosong = expanded = perilaku lama. Toggle live membaca reasoning.visible
// dan MINICODE_MINIMIZE_TOOL per event (pola detail.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { EventBus } from "#minicore/core/index.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import {
  clearCollapsedSections,
  collapsedSectionsSnapshot,
  rememberCollapsedSection,
  setSectionMinimized,
} from "../src/ui/render/collapse.ts"
import { setReasoningVisible } from "../src/ui/render/reasoning.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { humanToolLabel } from "../src/ui/render/tool-label.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

beforeEach(() => {
  tty = installFakeTty({ columns: 80, rows: 24 })
  setReasoningVisible(false)
  setSectionMinimized("tool", false)
  setSectionMinimized("answer", false)
  clearCollapsedSections()
})

afterEach(() => {
  tty?.restore()
  tty = undefined
  setReasoningVisible(false)
  setSectionMinimized("tool", false)
  setSectionMinimized("answer", false)
  clearCollapsedSections()
})

const attach = () => {
  const bus = createFakeBus()
  const detach = attachSimpleLogger(bus as unknown as EventBus, {})
  return {
    bus,
    detach,
    err: () => stripAnsi(tty!.allErr()),
    all: () => stripAnsi(tty!.combined()),
  }
}

const done = (name: string, args: Record<string, unknown>, content: string, isError = false) => ({
  execution: {
    call: { name, args },
    result: { isError, content },
  },
})

describe("collapse: thinking section", () => {
  test("default hidden: thinking tidak dicetak, buffer /expand sudah dihapus", () => {
    // v0.34: /expand dihapus — thinking penuh ada di jurnal. Printer linear
    // cukup menyembunyikannya, tanpa buffer collapsed.
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "pemikiran rahasia\n" } })
    bus.emit("provider:text", { text: "jawaban\n" })
    bus.emit("turn:completed", {})
    detach()
    // Header `+ thinking` tetap ada (penanda), yang hilang adalah isi & buffer.
    expect(err()).toContain("+ thinking")
    expect(err()).not.toContain("pemikiran rahasia")
    expect(collapsedSectionsSnapshot().some((s) => s.text.includes("pemikiran rahasia"))).toBe(
      false,
    )
  })

  test("expanded: header - thinking + teks mengalir", () => {
    setReasoningVisible(true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "pemikiran terlihat\n" } })
    detach()
    expect(err()).toContain("− thinking")
    expect(err()).toContain("pemikiran terlihat")
  })

  test("toggle mid-thinking: expanded mencetak, collapsed menyembunyikan", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "satu\n" } })
    setReasoningVisible(true)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "dua\n" } })
    expect(err()).toContain("− thinking") // glyph minus (bukan ASCII '-')
    // Collapse lagi: reasoning baru tak boleh bocor ke scrollback.
    setReasoningVisible(false)
    bus.emit("provider:extension", { kind: "reasoning", data: { text: "tiga-rahasia\n" } })
    expect(err()).toContain("+ thinking")
    expect(err()).not.toContain("tiga-rahasia")
    bus.emit("turn:completed", {})
    detach()
    expect(collapsedSectionsSnapshot().some((s) => s.text.includes("tiga-rahasia"))).toBe(false)
  })
})

describe("collapse: tool section", () => {
  test("minimized: header tool tetap tampil, output tidak dicetak", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: { call: { name: "bash", args: { cmd: "ls -la" } } },
    })
    bus.emit("execution:completed", done("bash", { cmd: "ls -la" }, "file1\nfile2\nfile3\n"))
    bus.emit("turn:completed", {})
    detach()
    expect(err()).toContain("bash")
    expect(err()).not.toContain("file1")
    // v0.34: buffer /expand mati — detail di jurnal + chat (sidebar dihapus), bukan sini.
    expect(collapsedSectionsSnapshot().some((s) => s.text.includes("file3"))).toBe(false)
  })

  test("minimized: header edit tetap tampil, isi tidak dicetak", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit(
      "execution:completed",
      done("edit", { path: "src/a.ts", oldString: "lama", newString: "baru" }, "ok"),
    )
    detach()
    expect(err()).toContain("edit")
    expect(err()).not.toContain("lama")
    expect(collapsedSectionsSnapshot().some((s) => s.label === "edit src/a.ts")).toBe(false)
  })

  test("expanded (env kosong): output penuh tercetak — perilaku lama utuh", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("bash", { cmd: "echo hi" }, "hi\n"))
    detach()
    expect(err()).toContain("hi")
  })

  test("error tool selalu tampil walau dikecilkan", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("read_file", { path: "x.ts" }, "gagal membaca", true))
    detach()
    // v0.43: makna test tetap — BARIS error tool tetap tampil walau section
    // diminimalkan. Yang berubah: redaksi mentah "gagal membaca" kini
    // disembunyikan (tak cocok 13 pola kanonik friendlyToolError()).
    expect(err()).toContain(`› ${humanToolLabel("read_file")}`)
    expect(err()).not.toContain("gagal membaca")
    expect(err()).not.toContain("+ read_file")
  })

  test("toggle tool saat aktif: expand = output penuh, minimize = sembunyi", () => {
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", { execution: { call: { name: "bash", args: { cmd: "b" } } } })
    setSectionMinimized("tool", false)
    bus.emit("execution:completed", done("bash", { cmd: "b" }, "terlihat\n"))
    expect(err()).toContain("terlihat")
    setSectionMinimized("tool", true)
    bus.emit("execution:completed", done("bash", { cmd: "c" }, "tersembunyi-rahasia\n"))
    expect(err()).not.toContain("tersembunyi-rahasia")
    detach()
    expect(collapsedSectionsSnapshot().some((s) => s.text.includes("tersembunyi-rahasia"))).toBe(
      false,
    )
  })
})

describe("collapse: answer section", () => {
  const minimizeAnswer = () => {
    setSectionMinimized("answer", true)
  }

  test("minimized: ringkasan ukuran jawaban tanpa petunjuk /expand", () => {
    minimizeAnswer()
    const { bus, detach, err, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "jawaban lengkap\nbaris dua\n" })
    expect(all()).not.toContain("jawaban lengkap")
    bus.emit("turn:completed", {})
    detach()
    expect(err()).toContain("+ answer (")
    expect(err()).toContain("chars)")
    // v0.33: /expand dihapus — petunjuk lama tak boleh muncul lagi.
    expect(err()).not.toContain("/view expand to read")
    expect(collapsedSectionsSnapshot().some((s) => s.label === "answer")).toBe(false)
  })

  test("expanded (env kosong): jawaban mengalir seperti dulu", () => {
    const { bus, detach, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "terlihat langsung\n" })
    bus.emit("turn:completed", {})
    detach()
    expect(all()).toContain("terlihat langsung")
    expect(collapsedSectionsSnapshot().length).toBe(0)
  })

  test("expand live: buffer lama tercetak + lanjut stream", () => {
    minimizeAnswer()
    const { bus, detach, all } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:text", { text: "bagian satu\n" })
    expect(all()).not.toContain("bagian satu")
    // Tombol + : minimize mati → header + flush + stream.
    setSectionMinimized("answer", false)
    bus.emit("provider:text", { text: "bagian dua\n" })
    expect(all()).toContain("bagian satu")
    expect(all()).toContain("bagian dua")
    detach()
  })

  test("todo_write diringkas jadi N items (bukan dump JSON)", () => {
    setSectionMinimized("tool", true)
    const { bus, detach, err } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit(
      "execution:completed",
      done("todo_write", { todos: [{ content: "a", status: "pending" }] }, "ok"),
    )
    detach()
    expect(err()).toContain("+ todo_write 1 items")
    expect(err()).not.toContain('"content"')
  })
})

describe("collapse: buffer & reset", () => {
  test("rememberCollapsedSection cap per-entry", () => {
    rememberCollapsedSection("x", "y".repeat(500_000))
    const buf = collapsedSectionsSnapshot()
    expect(buf[buf.length - 1]!.text.length).toBeLessThanOrEqual(200_000)
  })

  test("rememberCollapsedSection cap total: tertua dibuang, terbaru dipertahankan", () => {
    rememberCollapsedSection("a", "a".repeat(200_000))
    rememberCollapsedSection("b", "b".repeat(200_000))
    rememberCollapsedSection("c", "c".repeat(200_000))
    const buf = collapsedSectionsSnapshot()
    const total = buf.reduce((n, s) => n + s.text.length, 0)
    expect(total).toBeLessThanOrEqual(500_000)
    expect(buf[buf.length - 1]!.label).toBe("c")
    expect(buf.some((s) => s.label === "a")).toBe(false)
  })

  test("alur /expand: baca buffer lalu kosongkan (tanpa cetak ganda)", () => {
    rememberCollapsedSection("bash $ ls", "file1\n")
    expect(collapsedSectionsSnapshot().length).toBe(1)
    // repl /expand membaca lalu memanggil reset — tiru urutannya persis.
    const shown = collapsedSectionsSnapshot()
      .map((s) => `── ${s.label} ──\n${s.text}`)
      .join("\n")
    expect(shown).toContain("file1")
    clearCollapsedSections()
    expect(collapsedSectionsSnapshot().length).toBe(0)
  })

  test("turn:started tidak meninggalkan buffer collapsed dari turn sebelumnya", () => {
    setSectionMinimized("tool", true)
    const { bus, detach } = attach()
    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:completed", done("bash", { cmd: "a" }, "isi-rahasia\n"))
    // v0.33: printer linear tak lagi menulis collapsed buffer.
    expect(collapsedSectionsSnapshot().length).toBe(0)
    bus.emit("turn:started", { turn: 2 })
    expect(collapsedSectionsSnapshot().length).toBe(0)
    detach()
  })
})
