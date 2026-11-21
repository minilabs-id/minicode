// v0.33 (audit F3) — riwayat thinking yang dipotong HARUS ditandai.
// Latar lama: buffer slice(-200k) membuang kepala diam-diam. Sekarang
// SidebarModel yang menyimpan histori dan menambah marker jujur saat cap.
import { expect, test } from "bun:test"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { SidebarModel } from "../src/ui/render/sidebar-model.ts"

test("thinking >200KB: marker head terpotong muncul di snapshot", () => {
  setSessionLocale("en")
  const m = new SidebarModel()
  m.ingestThinking("t".repeat(250_000))
  const lines = m.snapshot(80).thinking.join("\n")
  // wrapByWidth menambah newline tiap 80 kolom — allowance 10rb char.
  expect(lines.length).toBeLessThanOrEqual(210_000)
  expect(lines).toContain("older items trimmed")
})

test("thinking kecil: tanpa marker", () => {
  setSessionLocale("en")
  const m = new SidebarModel()
  m.ingestThinking("pendek")
  expect(m.snapshot(80).thinking.join("\n")).not.toContain("trimmed")
})
