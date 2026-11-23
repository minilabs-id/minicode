// A-P2: proyeksi inkremental untuk transkrip raksasa. Sewaktu transit scroll
// memakai lebar berbeda, cache lama miss terus → 700+ ms/frame pada 5000 baris.
import { expect, test } from "bun:test"
import { TRANSCRIPT_CAP, Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  return { bus, t }
}

test("1000 append: rebuild penuh terjadi paling banyak sekali", () => {
  const { bus, t } = setup()
  for (let i = 0; i < 1000; i++) {
    bus.emit("provider:text", { text: `baris-${i} dengan sedikit teks\n` })
    bus.emit("turn:completed", {})
    // Tiap frame mengukur panjang — ini yang dulu memicu rebuild berulang.
    t.wrappedLength(80)
  }
  expect(t.projectionRebuilds).toBeLessThanOrEqual(1)
  expect(t.wrappedLength(80)).toBe(1000)
})

test("wrappedLength konsisten dengan viewport dan panjang view", () => {
  const { bus, t } = setup()
  for (let i = 0; i < 120; i++) {
    bus.emit("provider:text", { text: `row-${i}\n` })
    bus.emit("turn:completed", {})
  }
  const w = 60
  const h = 15
  const vp = t.viewport(w, h, 0)
  expect(vp.totalRows).toBe(t.wrappedLength(w))
  expect(t.view(w, h, 0)).toHaveLength(h)
  expect(vp.rows).toHaveLength(h)
  // v0.43: viewport TIDAK lagi meng-clamp `scrollBack` ke `maxBack` — ratchet
  // naik-saja memakai nilai apa adanya supaya baris committed tetap di indeks
  // layar yang sama saat baris live hilang (kontrak v0.43). `maxBack` kini
  // diekspos sebagai INFORMATIONAL bounds bagi pemanggil yang ingin clamp.
  const tail = t.viewport(w, h, 1_000_000)
  expect(tail.totalRows).toBe(vp.totalRows)
  expect(tail.firstIndex).toBe(1_000_000)
  expect(tail.maxBack).toBe(Math.max(0, vp.totalRows - h))
})

test("evict di TRANSCRIPT_CAP tetap menjaga panjang & anchor seleksi", () => {
  const { bus, t } = setup()
  for (let i = 0; i < 50; i++) {
    bus.emit("provider:text", { text: `awal-${i}\n` })
    bus.emit("turn:completed", {})
  }
  const first = t.viewport(60, 10, 0).rows.find((r) => r.selectable)
  expect(first).toBeDefined()
  const anchor = t.pointAt(first!, first!.displayStart)
  expect(anchor).not.toBeNull()
  const selected = t.selectionText(anchor!, { id: anchor!.id, offset: anchor!.offset + 3 })
  expect(selected.length).toBeGreaterThan(0)

  const removed: number[] = []
  t.onEviction = (byWidth) => removed.push(...byWidth.values())
  for (let i = 0; i < TRANSCRIPT_CAP + 20; i++) {
    bus.emit("provider:text", { text: `isi-${i}\n` })
    bus.emit("turn:completed", {})
  }
  expect(removed.length).toBeGreaterThan(0)
  expect(t.size()).toBeLessThanOrEqual(TRANSCRIPT_CAP + 1)
  // Seleksi lama sudah ter-evict → hasSource false, tapi API tak melempar.
  expect(() => t.selectionText(anchor!, anchor!)).not.toThrow()
  expect(t.wrappedLength(60)).toBe(t.viewport(60, 10, 0).totalRows)
})

test("sustained cap: append di atas TRANSCRIPT_CAP tidak memicu rebuild tiap baris", () => {
  const { bus, t } = setup()
  for (let i = 0; i < TRANSCRIPT_CAP + 800; i++) {
    bus.emit("provider:text", { text: `baris-${i} dengan sedikit teks\n` })
    bus.emit("turn:completed", {})
    t.wrappedLength(80)
  }
  // 1 rebuild awal + 1 rebuild saat marker eviction pertama dibuat.
  // Sebelum perbaikan, setiap evict menandai dirty → ~800 rebuild tambahan.
  expect(t.projectionRebuilds).toBeLessThanOrEqual(2)
  expect(t.wrappedLength(80)).toBe(t.viewport(80, 10, 0).totalRows)
  expect(t.size()).toBeLessThanOrEqual(TRANSCRIPT_CAP + 1)
})

test("fence & blank run tetap benar setelah proyeksi inkremental", () => {
  const { bus, t } = setup()
  bus.emit("provider:text", { text: "```ts\nconst x = `a`\n```\n\n\n\nsesudah\n" })
  bus.emit("turn:completed", {})
  const text = t.view(80, 20, 0).join("\n")
  // Isi fence tetap LITERAL (bukan di-render markdown).
  expect(text).toContain("const x = `a`")
  // Empat baris kosong beruntun dirapikan jadi maksimal dua (hanya pada
  // konten — padding bawah viewport sengaja dipertahankan apa adanya).
  const content = text.slice(0, text.indexOf("sesudah") + "sesudah".length)
  expect(content).not.toMatch(/\n[^\S\n]*\n[^\S\n]*\n[^\S\n]*\n/)
  // Append sesudah fence tak merusak status fence.
  bus.emit("provider:text", { text: "baris tambahan\n" })
  bus.emit("turn:completed", {})
  expect(t.view(80, 20, 0).join("\n")).toContain("baris tambahan")
})
