// v0.33 (audit) — SidebarModel: satu sumber histori/scroll/follow.
import { expect, test } from "bun:test"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { SidebarModel } from "../src/ui/render/sidebar-model.ts"

test("histori thinking & aktivitas masuk model, versi naik", () => {
  setSessionLocale("en")
  const m = new SidebarModel()
  m.ingestThinking("alpha\nbeta")
  m.ingestActivity("read_file jail.ts")
  const s = m.snapshot(40)
  expect(s.thinking.join("\n")).toContain("alpha")
  expect(s.activity.join("\n")).toContain("read_file jail.ts")
  expect(s.version).toBe(2)
})

test("scroll mengikuti lebar AKTIF dan follow otomatis di ekor", () => {
  const m = new SidebarModel()
  for (let i = 0; i < 30; i++) m.ingestActivity(`line-${i}`)
  const width = 20
  const cap = 5
  m.syncFollow("activity", width, cap)
  expect(m.isFollowing("activity")).toBe(true)
  expect(m.scrollOffset("activity")).toBe(m.maxScroll("activity", width, cap))
  m.scrollPane("activity", -3, width, cap)
  expect(m.isFollowing("activity")).toBe(false)
  expect(m.scrollOffset("activity")).toBe(m.maxScroll("activity", width, cap) - 3)
  m.scrollPane("activity", 99, width, cap)
  expect(m.isFollowing("activity")).toBe(true)
})

test("markTurn memberi pemisah di kedua aliran & menaikkan versi", () => {
  const m = new SidebarModel()
  m.ingestThinking("alasan")
  m.ingestActivity("tool")
  const before = m.version
  m.markTurn()
  const snap = m.snapshot(60)
  expect(snap.version).toBe(before + 1)
  // Penanda tipis (titik), bukan teks "turn 1".
  expect(snap.thinking.join("\n")).toContain("·")
  expect(snap.activity.join("\n")).toContain("·")
})

test("rasio kotak bisa diubah dan dibatasi 30–80%", () => {
  const m = new SidebarModel()
  expect(m.ratio).toBeCloseTo(0.6)
  m.adjustRatio(0.05)
  expect(m.ratio).toBeCloseTo(0.65)
  for (let i = 0; i < 50; i++) m.adjustRatio(1)
  expect(m.ratio).toBeCloseTo(0.8)
  for (let i = 0; i < 50; i++) m.adjustRatio(-1)
  expect(m.ratio).toBeCloseTo(0.3)
})

test("jumpToEdge: Home ke kepala, End ke ekor + follow", () => {
  const m = new SidebarModel()
  for (let i = 0; i < 20; i++) m.ingestActivity(`baris-${i}`)
  m.jumpToEdge("activity", true, 20, 5)
  expect(m.scrollOffset("activity")).toBe(0)
  expect(m.isFollowing("activity")).toBe(false)
  m.jumpToEdge("activity", false, 20, 5)
  expect(m.scrollOffset("activity")).toBe(m.maxScroll("activity", 20, 5))
  expect(m.isFollowing("activity")).toBe(true)
})

test("ingest inkremental: 200rb char per chunk kecil tetap utuh", () => {
  const m = new SidebarModel()
  // 1000 chunk × 200 char = 200rb. Dulu tiap chunk Array.from(seluruh buffer)
  // → O(n²); sekarang hitungan inkremental.
  const chunk = "a".repeat(200)
  for (let i = 0; i < 1000; i++) m.ingestThinking(chunk)
  expect(m.snapshot(80).thinking.join("").replace(/\s/g, "").length).toBeGreaterThan(0)
  expect(m.version).toBe(1000)
})

test("surrogate terbelah antar chunk tetap jadi emoji utuh", () => {
  const m = new SidebarModel()
  const emoji = "😀"
  m.ingestThinking(emoji.slice(0, 1)) // high surrogate
  m.ingestThinking(emoji.slice(1)) // low surrogate
  const text = m.snapshot(80).thinking.join("")
  expect(text).toContain(emoji)
  expect(text.includes("\uD83D") && !text.includes("\uDE00")).toBe(false)
})

test("reset mengosongkan histori, scroll, dan follow", () => {
  const m = new SidebarModel()
  m.ingestThinking("h")
  m.ingestActivity("a")
  m.scrollPane("thinking", -1, 20, 2)
  m.reset()
  expect(m.snapshot(20).thinking).toEqual([])
  expect(m.snapshot(20).activity).toEqual([])
  expect(m.scrollOffset("thinking")).toBe(0)
  expect(m.isFollowing("thinking")).toBe(true)
})
