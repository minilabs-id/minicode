// v7.37 — status/jumlah + daftar tool DIPOTONG PER SEGMEN narasi.
//
// v7.36 salah tangkap: ia menyisipkan SATU baris akumulatif di ekor yang terus
// bertambah. Pola yang diminta (sama seperti OpenCode): setiap kali model
// menyampaikan update progres, baris count untuk tool yang dipakai di segmen
// SEBELUMNYA di-flush permanen tepat di bawah narasi itu, lalu di-reset. Jadi:
//
//   "Saya petakan dulu…"      → 2 command · 2 read
//   "Repo terpetakan…"        → 3 command · 1 edit · 10 subagent
//   "Audit jalan, saya pantau" → …
//
// v7.42: ringkasan lipatan tak lagi memakai `+` ASCII di depan — sekarang
// `"   N read · N command"` (margin 3 kolom + angka `c.info`, label `c.gray`).
// Assertion di bawah mencocokkan angka+label tanpa `+`, tapi tetap memeriksa
// jumlah dan ketiadaan duplikasi (kontrak lama tak dilonggarkan).

import { describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

type ToolDef = { id: string; name: string; status?: "completed" | "failed" }

function setup(minimizeActivity = false, tools: ToolDef[] = [{ id: "c1", name: "read_file" }]) {
  const bus = createFakeBus()
  let handler: ((event: never) => void) | undefined
  const uiState = new UiSessionState({ minimizeActivity })
  const activities: UiPresentationActivity[] = tools.map((tool) => ({
    toolCallId: tool.id,
    name: tool.name,
    target: "a.ts",
    status: tool.status ?? "completed",
    tsStart: 1,
  }))
  const snapshot: UiPresentationSnapshot = { activities, turns: [] }
  const t = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    uiState,
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
    say(text: string) {
      bus.emit("provider:text", { text })
    },
    tool(id: string, status: "completed" | "failed" = "completed") {
      handler?.({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: id, status } as never)
    },
    finish() {
      handler?.({ type: "turn.completed", seq: 99, turnId: 1 } as never)
    },
  }
}

describe("v7.37 — ringkasan aktivitas DIPOTONG per segmen narasi", () => {
  test("count segmen pertama melekat di bawah narasi yang mendahului tool", () => {
    const { t, say, tool } = setup()
    say("NARASI-SATU")
    tool("c1")
    say("NARASI-DUA")

    const lines = t.view(80, 16, 0)
    const first = lines.findIndex((l) => l.includes("NARASI-SATU"))
    const second = lines.findIndex((l) => l.includes("NARASI-DUA"))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    const between = lines.slice(first + 1, second).join("\n")
    expect(between).toContain("1 read")
  })

  test("hitungan di-RESET tiap segmen — tidak akumulatif", () => {
    const h = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    h.say("SEGMEN-1")
    h.tool("c1")
    h.say("SEGMEN-2")
    h.tool("c2")
    h.say("SEGMEN-3")

    const text = h.t.view(80, 20, 0).join("\n")
    expect(text).toContain("1 read")
    expect(text).toContain("1 command")
    // v7.42: tanpa `+`, "tidak akumulatif" diuji dengan memastikan tak ada
    // kategori yang hitungannya mencapai 2 (bukan sekadar mencari "+ 2").
    expect(text).not.toMatch(/2 (command|read|edit|subagent|thought|other)/)
    const atRead = text.indexOf("1 read")
    const atCommand = text.indexOf("1 command")
    expect(atRead).toBeLessThan(atCommand)
  })

  test("contoh '3 command · 1 edit · 10 subagent' terbentuk dari kategori", () => {
    const h = setup(false, [
      { id: "a1", name: "bash" },
      { id: "a2", name: "write_file" },
      { id: "a3", name: "delegate_task" },
    ])
    h.say("SEGMEN")
    h.tool("a1")
    h.tool("a2")
    h.tool("a3")
    h.say("LANJUT")

    const text = h.t.view(80, 20, 0).join("\n")
    expect(text).toContain("1 command")
    expect(text).toContain("1 edit")
    expect(text).toContain("1 subagent")
    expect(text).not.toContain("other")
  })

  test("tool gagal tetap ikut terhitung di segmen yang sama", () => {
    const h = setup(false, [{ id: "c1", name: "read_file", status: "failed" }])
    h.say("SEGMEN-GAGAL")
    h.tool("c1", "failed")
    h.say("SEGMEN-BERIKUTNYA")

    const text = h.t.view(80, 16, 0).join("\n")
    expect(text).toContain("1 read")
    expect(text).toContain("failed")
  })

  test("baris live saat streaming hanya menampilkan count SEGMEN BERJALAN", () => {
    const h = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    h.say("SEGMEN-1")
    h.tool("c1")
    h.say("SEGMEN-2")
    // Setelah flush segmen 1, sebelum tool segmen 2: tak ada baris live.
    expect(
      h.t
        .view(80, 16, 0)
        .join("\n")
        .match(/\b1 read\b/g)?.length,
    ).toBe(1)
    h.tool("c2")
    // v7.42: live row "1 command" (bukan "2 command" — tak ada akumulasi).
    const text = h.t.view(80, 16, 0).join("\n")
    expect(text).toContain("1 command")
    expect(text).not.toMatch(/2 (command|read|edit|subagent|thought|other)/)
  })

  test("turn tutup: sisa segmen terakhir di-flush, tanpa duplikasi", () => {
    const h = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    h.say("SEGMEN-1")
    h.tool("c1")
    h.say("SEGMEN-2")
    h.tool("c2")
    h.finish()

    const text = h.t.view(80, 20, 0).join("\n")
    // v7.42: hitung kemunculan angka+label untuk menjaga kontrak "tanpa duplikasi".
    expect(text.match(/\b1 read\b/g)?.length).toBe(1)
    expect(text.match(/\b1 command\b/g)?.length).toBe(1)
  })

  test("daftar nama tool hanya saat per-tool ditahan (minimizeActivity)", () => {
    const normal = setup(false)
    normal.tool("c1")
    expect(normal.t.view(80, 16, 0).join("\n")).not.toContain("Tool:")

    const folded = setup(true)
    folded.tool("c1")
    const view = folded.t.view(80, 16, 0).join("\n")
    expect(view).toContain("Tool:")
    expect(view).toContain("read_file")
  })

  test("nama tool tak terpercaya disanitasi sebelum masuk baris live", () => {
    // SGR (warna) sengaja dipertahankan `sanitizeAnsi` untuk theme — yang
    // WAJIB hilang adalah sekuens non-SGR berbahaya seperti ED/clear-screen.
    const h = setup(true, [{ id: "c1", name: "read\x1b[2J_file" }])
    h.tool("c1")
    const out = h.t.view(80, 16, 0).join("\n")
    expect(out).not.toContain("\x1b[2J")
    expect(out).toContain("read_file")
  })

  test("invariant tak tersentuh: baris ringkas bukan baris frame tambahan", () => {
    const h = setup()
    h.tool("c1")
    const rows = h.t.view(80, 12, 0)
    expect(rows.length).toBe(12)
    expect(rows.some((r) => r.includes("1 read"))).toBe(true)
  })
})
