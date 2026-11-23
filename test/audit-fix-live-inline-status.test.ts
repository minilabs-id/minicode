// Footer aktivitas TUI (desain final):
//
//   tool → narasi → rekap(tool sebelum narasi) → tool → …
//
// `narrationSinceFlush` (di Transcript.stream) menandai jeda narasi. Rekap untuk
// tool di segmen SEBELUM narasi ditulis saat tool BERIKUTNYA mulai
// (`tool.started`) — bukan lagi sebagai slot live di ekor. Di akhir turn ditulis
// SATU baris rekap KUMULATIF seluruh tool (`flushTurnTotal`) dari akumulator
// `turnToolNames`, walaupun footer per-narasi sudah ditulis.
//
// Kategori rekap tetap dihitung dari NAMA INTERNAL. Assertion memakai
// `humanToolLabel`/`systemLocale()`: label aktivitas mengikuti bahasa
// SISTEM/OS, bukan sesi `/lang`.

import { describe, expect, test } from "bun:test"
import type { UiPresentationActivity, UiPresentationSnapshot } from "../src/ui/contract.ts"
import { humanToolLabel, systemLocale } from "../src/ui/render/tool-label.ts"
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
      // Urutan nyata presenter: tool.started → tool.completed. `tool.started`
      // memotong segmen narasi (bila ada) dan menulis baris rekap.
      handler?.({ type: "tool.started", turnId: 1, toolCallId: id } as never)
      handler?.({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: id, status } as never)
    },
    finish() {
      handler?.({ type: "turn.completed", seq: 99, turnId: 1 } as never)
    },
  }
}

// Baris rekap = 3 spasi margin + angka kategori, tanpa prefix simbol;
// baris tool (`› …`) tidak cocok dengan pola ini.
function recapLines(lines: string[]): string[] {
  return lines.filter((l) => /^ {3}\d+\s+\p{L}/u.test(l))
}
function recapIndex(lines: string[], category: string): number {
  return lines.findIndex((l) => /^ {3}\d+\s+\p{L}/u.test(l) && l.includes(category))
}

describe("footer narasi: tool → narasi → rekap → tool", () => {
  test("rekap segmen ditulis setelah narasi, tepat sebelum tool berikutnya", () => {
    const { t, say, tool } = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    say("NARASI-SATU")
    tool("c1")
    say("NARASI-DUA")
    tool("c2") // memotong segmen 1 → rekap `1 read`

    const rows = t.view(80, 16, 0)
    const first = rows.findIndex((l) => l.includes("NARASI-SATU"))
    const second = rows.findIndex((l) => l.includes("NARASI-DUA"))
    const recap = recapIndex(rows, "1 read")
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    // Rekap untuk tool SEBELUM narasi muncul SETELAH narasi yang mengikutinya.
    expect(recap).toBeGreaterThan(second)
    expect(rows.join("\n")).toContain(`› ${humanToolLabel("read_file")} a.ts`)
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
    h.finish()

    const rows = h.t.view(80, 20, 0)
    const text = rows.join("\n")
    const recaps = recapLines(rows)
    // Dua rekap segmen + SATU rekap kumulatif (dedup, bukan duplikat identik).
    expect(recaps).toHaveLength(3)
    expect(recaps[0]).toContain("1 read")
    expect(recaps[1]).toContain("1 command")
    expect(recaps[2]).toContain("1 command · 1 read")
    // Tak ada kategori yang hitungannya mencapai 2 di rekap PER SEGMEN;
    // baris kumulatif memang boleh `1 command · 1 read` (bukan 2 per kategori).
    expect(text).not.toMatch(/2 (command|read|edit|subagent|thought|other)/)
    expect(recapIndex(rows, "1 read")).toBeLessThan(recapIndex(rows, "1 command"))
  })

  test("contoh '3 command · 1 edit · 10 subagent' terbentuk dari kategori internal", () => {
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
    h.finish()

    const text = h.t.view(80, 20, 0).join("\n")
    expect(text).toContain("1 command")
    expect(text).toContain("1 edit")
    expect(text).toContain("1 subagent")
    expect(text).not.toContain("other")
    // Label ledger mengikuti sistem, kategori rekap tetap token teknis.
    expect(text).toContain(humanToolLabel("delegate_task", { target: "a.ts" }))
    expect(systemLocale() === "id" || systemLocale() === "en").toBe(true)
  })

  test("tool gagal tetap ikut terhitung di segmen yang sama", () => {
    const h = setup(false, [{ id: "c1", name: "read_file", status: "failed" }])
    h.say("SEGMEN-GAGAL")
    h.tool("c1", "failed")
    h.say("SEGMEN-BERIKUTNYA")
    h.finish()

    const rows = h.t.view(80, 16, 0)
    expect(recapLines(rows)[0]).toContain("1 read")
    expect(rows.join("\n")).toContain("failed")
  })

  test("tak ada slot live: rekap hanya muncul setelah jeda narasi / akhir turn", () => {
    const h = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    h.say("SEGMEN-1")
    h.tool("c1")
    h.say("SEGMEN-2")
    // tool berikutnya belum mulai & turn belum tutup → belum ada baris rekap.
    expect(recapLines(h.t.view(80, 16, 0))).toHaveLength(0)
    h.tool("c2")
    // Sekarang rekap c1 ditulis permanen; bukan akumulatif `2 command`.
    const rows = h.t.view(80, 16, 0)
    expect(recapLines(rows)).toHaveLength(1)
    expect(recapLines(rows)[0]).toContain("1 read")
    expect(rows.join("\n")).not.toMatch(/2 (command|read|edit|subagent|thought|other)/)
  })

  test("turn tutup: rekap kumulatif mencakup semua segmen", () => {
    const h = setup(false, [
      { id: "c1", name: "read_file" },
      { id: "c2", name: "bash" },
    ])
    h.say("SEGMEN-1")
    h.tool("c1")
    h.say("SEGMEN-2")
    h.tool("c2")
    h.finish()

    const rows = h.t.view(80, 20, 0)
    const text = rows.join("\n")
    // Rekap segmen: `1 read` + `1 command`. Baris kumulatif terakhir
    // `1 command · 1 read` mengulang kedua angka (cakupan seluruh turn).
    expect(text.match(/\b1 read\b/g)?.length).toBe(2)
    expect(text.match(/\b1 command\b/g)?.length).toBe(2)
    expect(recapLines(rows).at(-1)).toContain("1 command · 1 read")
  })

  test("chat tak pernah memuat baris `Tool:` — indeks kategori menggantikannya", () => {
    // v0.33: baris `Tool: read_file` dihapus dari chat (keputusan pemilik).
    // Berlaku baik saat per-tool ditahan maupun tidak.
    for (const folded of [false, true]) {
      const h = setup(folded)
      h.tool("c1")
      h.finish()
      const rows = h.t.view(80, 16, 0)
      const view = rows.join("\n")
      expect(view).not.toContain("Tool:")
      expect(recapLines(rows)[0]).toContain("1 read")
    }
  })

  test("nama tool tak terpercaya disanitasi sebelum masuk chat", () => {
    // Detail nama tool kini ada di chat. Sekuens non-SGR berbahaya
    // (ED/clear-screen) wajib hilang dari baris ledger maupun rekap.
    const h = setup(false, [{ id: "c1", name: "read\x1b[2J_file" }])
    h.tool("c1")
    h.finish()
    const rows = h.t.view(80, 16, 0)
    const chat = rows.join("\n")
    expect(chat).not.toContain("\x1b[2J")
    expect(chat).toContain("read")
    expect(recapLines(rows)[0]).toContain("1 read")
  })

  test("invariant tak tersentuh: baris ringkas bukan baris frame tambahan", () => {
    const h = setup()
    h.tool("c1")
    h.finish()
    const rows = h.t.view(80, 12, 0)
    expect(rows.length).toBe(12)
    expect(recapLines(rows).some((l) => l.includes("1 read"))).toBe(true)
  })
})
