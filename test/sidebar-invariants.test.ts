// v0.33 (audit): invariant yang dulu lolos dari test render. Diuji langsung
// pada helper murni — tanpa TTY, tanpa state UI.
import { expect, test } from "bun:test"
import { sidebarGeometry } from "../src/ui/render/sidebar-layout.ts"
import { SidebarModel } from "../src/ui/render/sidebar-model.ts"

test("markTurn patuh batas log aktivitas & menaikkan activityDropped", () => {
  const m = new SidebarModel()
  // 2.100 turn > MAX_ACTIVITY_LINES (2.000) — dulu markTurn bypass cap.
  for (let i = 0; i < 2_100; i++) m.markTurn()
  const snap = m.snapshot(60)
  // 2.000 baris log + 1 baris marker "trimmed" dari snapshot.
  expect(snap.activity.length).toBeLessThanOrEqual(2_001)
  const trimmed = snap.activity.join("\n")
  expect(trimmed).toContain("older items trimmed")
})

test("cap thinking memotong per code point (tak belah surrogate/emoji)", () => {
  const m = new SidebarModel()
  // 210.000 emoji = 420.000 UTF-16 unit; kalau di-slice per unit, ujungnya
  // jadi lone surrogate. Per code point, ujungnya tetap emoji utuh.
  m.ingestThinking("😀".repeat(210_000))
  const raw = m.snapshot(80).thinking.join("")
  expect(raw.includes("\uD83D") !== raw.includes("\uDE00")).toBe(false)
})

test("geometri: jumlah baris kotak tidak melebihi viewH", () => {
  for (let viewH = 4; viewH <= 40; viewH++) {
    const g = sidebarGeometry(24, 120, viewH, 0.6)
    // bottomRow = topHeight + divider, jadi ini jumlah baris sebenarnya.
    expect(g.bottomRow + g.bottomHeight).toBeLessThanOrEqual(viewH)
  }
})

test("split Activity hanya aktif di jendela sangat lebar dan lebar pas", () => {
  const narrow = sidebarGeometry(32, 120, 32, 0.6)
  expect(narrow.activitySplit).toBe(false)
  // Ambang baru: 168 kolom ≈ 70% desktop; 167 masih satu kolom.
  expect(sidebarGeometry(32, 167, 32, 0.6).activitySplit).toBe(false)
  expect(sidebarGeometry(32, 168, 32, 0.6).activitySplit).toBe(true)
  const wide = sidebarGeometry(32, 200, 32, 0.6)
  expect(wide.activitySplit).toBe(true)
  expect(wide.liveWidth + wide.splitGap + wide.logWidth).toBe(wide.width)
  expect(wide.splitGap).toBe(2)
})

test("live record terstruktur: upsert/remove & snapshot", () => {
  const m = new SidebarModel()
  m.upsertLive({ id: "t1", name: "delegate_task", target: "audit-1", startedAt: Date.now() })
  expect(m.liveRecords()).toHaveLength(1)
  // Live memakai label pendek yang SAMA dengan Activity (audit v0.33).
  expect(m.snapshot(40).live.join("\n")).toContain("agent")
  expect(m.snapshot(40).live.join("\n")).toContain("audit-1")
  expect(m.liveRecord("t1")?.name).toBe("delegate_task")
  m.removeLive("t1")
  expect(m.liveRecords()).toHaveLength(0)
})

test("rasio lebar adaptif monoton (tak ada lompatan di 160 kolom)", () => {
  let prevWidth = 0
  for (let cols = 100; cols <= 200; cols++) {
    const g = sidebarGeometry(24, cols, 24, 0.6)
    expect(g.width).toBeGreaterThanOrEqual(prevWidth)
    prevWidth = g.width
    expect(g.chatCols).toBe(g.active ? cols - g.width - g.gap : cols)
  }
})
