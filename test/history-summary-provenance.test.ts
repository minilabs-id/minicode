// Provenance ringkasan yang TAHAN RESTART.
//
// Regresi nyata (sesi `1bfbcc50`): ringkasan kompaksi disimpan sebagai baris
// `messages` role user, sedangkan status "sintetis" hanya hidup di WeakSet
// proses. Setelah resume/proyeksi-invalid, ringkasan itu diperlakukan sebagai
// permintaan user dan ikut diringkas — nesting "Previous context:" menumpuk
// tiap siklus. Perbaikannya: produsen proyeksi mencatat teks ringkasan yang
// SAMA di tabel `history_summaries` (batas tepercaya, tanpa menebak isi).

import { expect, test } from "bun:test"
import { produceSummaryProjection } from "../src/session/context-projection.ts"
import { getHistorySummary, saveHistorySummary, saveSession } from "../src/session/persistence.ts"
import { P2_CLASS, p2Cleanup, p2Cwd, p2Id, p2Msgs, p2ResetIds } from "./helpers/p2.ts"

test("roundtrip: catat, baca, dan timpa provenance ringkasan", async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-hsum")
  try {
    const id = p2Id("sess")
    await saveSession(id, cwd, undefined, p2Msgs(2, "h"), { turns: 1 })
    expect(getHistorySummary(id, "th_default", cwd)).toBeNull()
    saveHistorySummary(id, "th_default", "RINGKASAN-A", 3, cwd)
    expect(getHistorySummary(id, "th_default", cwd)).toEqual({
      summaryText: "RINGKASAN-A",
      coveredSeq: 3,
      canonicalFirstText: null,
    })
    saveHistorySummary(id, "th_default", "RINGKASAN-B", 5, cwd)
    expect(getHistorySummary(id, "th_default", cwd)?.summaryText).toBe("RINGKASAN-B")
    // Teks kanonik dicatat PERSIS oleh lapisan persist; resume membandingkan
    // string ini apa adanya (bukan heuristik "Previous context").
    saveHistorySummary(id, "th_default", "RINGKASAN-B", 5, cwd, "BARIS-KANONIK-0")
    expect(getHistorySummary(id, "th_default", cwd)?.canonicalFirstText).toBe("BARIS-KANONIK-0")
    // Upsert berikutnya tanpa teks kanonik tidak menghapus provenance lama.
    saveHistorySummary(id, "th_default", "RINGKASAN-C", 7, cwd)
    expect(getHistorySummary(id, "th_default", cwd)).toEqual({
      summaryText: "RINGKASAN-C",
      coveredSeq: 7,
      canonicalFirstText: "BARIS-KANONIK-0",
    })
  } finally {
    await p2Cleanup(cwd)
  }
})

test(`[${P2_CLASS.FUTURE_CONTRACT}] produsen proyeksi mencatat provenance`, async () => {
  p2ResetIds()
  const cwd = p2Cwd("mc-hsum-prod")
  try {
    const id = p2Id("sess")
    await saveSession(id, cwd, undefined, p2Msgs(6, "p"), { turns: 1 })
    const produced = produceSummaryProjection(id, cwd, {
      expectedEpoch: 0,
      policy: { keepRecentTurns: 1 },
    })
    expect(produced.produced).toBe(true)
    const recorded = getHistorySummary(id, "th_default", cwd)
    expect(recorded).not.toBeNull()
    // Teks provenance = teks proyeksi (satu sumber), bukan turunan terpisah.
    expect(recorded!.summaryText).toContain("Previous context")
    expect(recorded!.coveredSeq).toBe(produced.baseSeq as number)
  } finally {
    await p2Cleanup(cwd)
  }
})
