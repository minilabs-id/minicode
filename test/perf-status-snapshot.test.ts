// F-01/F-05/F-08 — guard: jalur status/paint TIDAK boleh memicu snapshot
// riwayat. `session.state` adalah `snapshotState` (deep clone seluruh history);
// `cli/tui.ts` kini membacanya SEKALI saat setup lalu memakai counter turn dari
// event + cache per turn. File ini mengunci kontrak itu dua cara:
//
//   1. Runtime: fake session dengan `state` getter yang di-spy, riwayat
//      200/400/1000 pesan, `getContextTokens()` dipanggil berkali-kali
//      (meniru dua pemakaian per `getStatus()` paint) → getter TIDAK dipanggil
//      lagi setelah setup, dan angka cache stabil antar paint.
//   2. Struktural: setelah komentar dibuang, `session.state` hanya muncul SATU
//      kali di source `cli/tui.ts` (baris inisialisasi tracker).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { type ContextTokenSession, createContextTokenTracker } from "../cli/tui.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

interface FakeSession {
  session: ContextTokenSession
  history: unknown[]
  /** Jumlah pembacaan `state` (deep clone) dan `contextTokens`. */
  reads: () => { stateReads: number; tokenReads: number }
}

/**
 * Riwayat besar + counter akses. `state` getter sengaja meng-clone tiap pesan
 * supaya perilaku lama (state-first) benar-benar mahal bila kembali muncul.
 */
function fakeSession(messages: number, initialTurnCount = 3): FakeSession {
  const history = Array.from({ length: messages }, (_, i) => ({
    id: `m-${i}`,
    content: "x".repeat(200),
    toolArgs: { i, payload: "y".repeat(80) },
  }))
  let stateReads = 0
  let tokenReads = 0
  const session = {
    get state() {
      stateReads++
      return {
        turnCount: initialTurnCount,
        // Simulasi snapshotState: clone per pesan (biaya O(history)).
        history: history.map((m) => ({ ...m, toolArgs: { ...m.toolArgs } })),
      }
    },
    get contextTokens() {
      tokenReads++
      return 42_100
    },
  } as unknown as ContextTokenSession
  return { session, history, reads: () => ({ stateReads, tokenReads }) }
}

describe("perf: status/paint tidak boleh menyentuh snapshot history", () => {
  for (const messages of [200, 400, 1000]) {
    test(`riwayat ${messages} pesan: state getter hanya dibaca saat setup`, () => {
      const fake = fakeSession(messages)
      const bus = createFakeBus()
      const tracker = createContextTokenTracker(fake.session, bus as never)

      // Saat setup: SATU pembacaan state (boleh bayar deep clone sekali).
      expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 0 })

      // Meniru getStatus(): dua pemakaian token per paint, N paint idle.
      for (let paint = 0; paint < 250; paint++) {
        const a = tracker.getContextTokens()
        const b = tracker.getContextTokens() // fmtCtx + fmtUsageMetrics
        expect(a).toBe(b)
      }
      const after = fake.reads()
      expect(after.stateReads).toBe(1)
      // Satu recompute saat cache kosong; sisanya cache hit lintas paint.
      expect(after.tokenReads).toBe(1)

      tracker.dispose()
      expect(after.stateReads).toBe(1)
    })
  }

  test("cache getContextTokens() tidak berubah antar paint, walau turn bertambah", () => {
    const fake = fakeSession(400)
    const bus = createFakeBus()
    const tracker = createContextTokenTracker(fake.session, bus as never)

    const first = tracker.getContextTokens()
    expect(tracker.getContextTokens()).toBe(first)
    expect(tracker.getTurnCount()).toBe(3)

    // `turn:started` mengubah counter & membatalkan cache, tetapi TIDAK boleh
    // membaca session.state. Kernel meng-emit turn SEBELUM increment.
    bus.emit("turn:started", { turn: 3 })
    expect(tracker.getTurnCount()).toBe(4)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 1 })

    expect(tracker.getContextTokens()).toBe(42_100)
    expect(tracker.getContextTokens()).toBe(42_100)
    // Satu recompute pasca-invalidasi turn, lalu stabil lagi.
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 2 })

    // Sinyal batas turn lain juga tak boleh menyentuh state.
    bus.emit("turn:completed", {})
    bus.emit("context:compacted", { reason: "auto" })
    bus.emit("turn:interrupted", {})
    expect(tracker.getContextTokens()).toBe(42_100)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 3 })

    tracker.dispose()
  })

  test("live context (per-step) menang tanpa menyentuh state maupun cache", () => {
    const fake = fakeSession(1000)
    const bus = createFakeBus()
    const tracker = createContextTokenTracker(fake.session, bus as never)

    bus.emit("provider:extension", {
      kind: "context-window",
      data: { usedTokens: 9_999 },
      forwardedChild: undefined,
    })
    expect(tracker.getContextTokens()).toBe(9_999)
    expect(tracker.getContextTokens()).toBe(9_999)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 0 })

    // Event child diabaikan seperti di produksi.
    bus.emit("provider:extension", {
      kind: "context-window",
      data: { usedTokens: 1 },
      forwardedChild: "child-session",
    })
    expect(tracker.getContextTokens()).toBe(9_999)

    bus.emit("turn:completed", {})
    expect(tracker.getContextTokens()).toBe(42_100)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 1 })
    tracker.dispose()
  })

  test("abort tanpa partial commit membuang angka live (kernel tak emit turn:interrupted)", () => {
    const fake = fakeSession(400)
    const bus = createFakeBus()
    const tracker = createContextTokenTracker(fake.session, bus as never)

    bus.emit("turn:started", { turn: 3 })
    bus.emit("provider:extension", {
      kind: "context-window",
      data: { usedTokens: 77_777 },
      forwardedChild: undefined,
    })
    expect(tracker.getContextTokens()).toBe(77_777)

    // Kernel hanya emit `turn:interrupted` bila ada partial commit; abort/error
    // sebelum step boundary tak memancarkan event. TUI memanggil invalidate()
    // dari handler abort/finally runTurn.
    tracker.invalidate()
    expect(tracker.getContextTokens()).toBe(42_100)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 1 })
    tracker.dispose()
  })

  test("dispose melepas listener sehingga event pasca-quit tak mengubah angka", () => {
    const fake = fakeSession(200)
    const bus = createFakeBus()
    const tracker = createContextTokenTracker(fake.session, bus as never)
    tracker.getContextTokens()
    tracker.dispose()

    bus.emit("turn:started", { turn: 9 })
    expect(tracker.getTurnCount()).toBe(3)
    expect(tracker.getContextTokens()).toBe(42_100)
    expect(fake.reads()).toEqual({ stateReads: 1, tokenReads: 1 })
  })
})

describe("perf: struktur sumber cli/tui.ts", () => {
  test("session.state hanya diakses sekali (inisialisasi tracker)", () => {
    const src = readFileSync(new URL("../cli/tui.ts", import.meta.url), "utf8")
    // Buang komentar blok & baris supaya hanya akses kode yang dihitung.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
    const accesses = code.match(/session\.state\b/g) ?? []
    expect(accesses).toEqual(["session.state"])

    // getStatus() tidak boleh mengandung akses .state; cukup panggil tracker.
    const start = code.indexOf("getStatus: () => {")
    expect(start).toBeGreaterThan(-1)
    const body = code.slice(start, start + 2_500)
    expect(body).not.toContain(".state")
    expect(body).toContain("getContextTokens()")
  })
})
