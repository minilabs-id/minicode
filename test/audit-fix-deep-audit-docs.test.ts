// v7.40 — regresi untuk temuan doc/gate audit mendalam.
// Dulu dokumen bisa menyimpang dari kode tanpa gate yang menangkap:
//   - tools.md tidak mendaftarkan git_restore/git_checkout/lsp_rename, dan
//     masih menulis wire LSP `file+symbol` (implementasi sudah pakai `path`);
//   - contributing.md memuat angka budget paket usang, padahal angka tunggal
//     ada di scripts/pack-budget.ts;
//   - CHANGELOG menyimpan entri [Unreleased] berisi konten rilis V6/V7/V8.
//
// Hermetic: baca berkas saja, tanpa jaringan/provider/sesi.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")

const toolsDoc = read("docs/tools.md")
const changelog = read("CHANGELOG.md")
const contributing = read("docs/contributing.md")

/** Pemisah ribuan ala Indonesia (dipakai dokumen): 4608 → "4.608". */
function ribuan(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
}

/** Titik pemisah ribuan harus literal di regex, bukan wildcard. */
function literal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test("docs/tools.md mendaftarkan ke-41 tool bawaan (satu baris tabel = satu tool)", () => {
  // Ambil sel teks sebelum `|` pertama pada setiap baris tabel. Kolom pertama
  // berisi nama tool dalam backtick; baris `todo_write` / `todo_read` sengaja
  // menyimpan DUA nama, jadi keduanya harus ikut terhitung.
  const names = new Set<string>()
  for (const row of toolsDoc.match(/^\|([^|\n]+)\|/gm) ?? []) {
    const firstCell = row.slice(1).split("|")[0] ?? ""
    for (const m of firstCell.matchAll(/`([a-z][a-z0-9_]*)`/g)) names.add(m[1]!)
  }
  // 41 = jumlah `allTools` di src/tools/index.ts (v7.38+: 3 tool baru).
  expect(names.size).toBe(41)
})

test("docs/tools.md memuat git_restore/git_checkout/lsp_rename dan wire `path`", () => {
  // v7.38: tool git-write baru dan lsp_rename harus terlihat di referensi,
  // kalau tidak model tak akan pernah memakainya (dokumen = kontrak wire).
  for (const name of ["git_restore", "git_checkout", "lsp_rename"]) {
    expect(toolsDoc).toMatch(new RegExp(`\\|\\s*\`${name}\`\\s*\\|`))
  }
  expect(toolsDoc).toMatch(/\|\s*`lsp_definition`\s*\|[^\n]*\bpath\b/)
  expect(toolsDoc).toMatch(/\|\s*`lsp_rename`\s*\|[^\n]*\bpath\b/)
  // Klaim lama sudah salah: wire tidak lagi menerima `file+symbol`.
  expect(toolsDoc).not.toMatch(/file\+symbol/)
  // checkout kini tersedia sebagai tool path-restore: yang dilarang adalah
  // mencantumkannya SEBAGAI ITEM daftar "sengaja tidak ada" (bukan menyebut
  // `git_checkout` di catatan).
  expect(toolsDoc).toMatch(
    /Yang sengaja tidak ada:[^\n]*amend\/reset\/rebase\/branch -D\/stash drop/,
  )
  expect(toolsDoc).not.toMatch(/Yang sengaja tidak ada:[^\n]*\bcheckout\b/)
})

test("contributing.md memakai budget paket yang sama dengan sumber tunggalnya", () => {
  // pack-check.ts hanya IMPORT konstanta; angka literalnya ada di
  // pack-budget.ts (satu sumber untuk gate dan tes). Parsing angka dari source
  // mencegah dokumentasi kembali mentok di angka lama 4.096 KiB.
  const budgetSrc = read("scripts/pack-budget.ts")
  const found = budgetSrc.match(/PACK_SIZE_BUDGET_KIB\s*=\s*(\d+)/)
  expect(found).not.toBeNull()
  const kib = Number(found![1])
  expect(kib).toBeGreaterThan(0)
  const formatted = ribuan(kib)

  expect(contributing).toMatch(
    new RegExp(`^### Budget ukuran paket \\(${literal(formatted)} KiB\\)$`, "m"),
  )
  expect(contributing).toMatch(new RegExp(`melebihi\\s+${literal(formatted)}\\s+KiB`))

  const packCheck = read("scripts/pack-check.ts")
  expect(packCheck).toMatch(/PACK_SIZE_BUDGET_KIB/)
  expect(packCheck).not.toMatch(/3,5 MiB/)
})

test("CHANGELOG: tidak ada [Unreleased] yang berisi konten rilis", () => {
  // [Unreleased] dulu disisipkan di antara 0.8.0 dan [Sebelumnya] padahal
  // isinya audit V6/V7/V8 yang sudah rilis — kini jadi arsip historis.
  const lines = changelog.split("\n")
  const starts = lines.flatMap((line, i) => (/^## \[Unreleased\]/.test(line) ? [i] : []))
  for (const start of starts) {
    const next = lines.findIndex((line, i) => i > start && /^## /.test(line))
    const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n")
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(body).not.toMatch(/\bV[6-8]\b/)
  }
  // Kunci hasil perbaikan: konten lama tetap ada, tapi bukan lagi "Unreleased".
  expect(changelog).toMatch(/^## Audit UI\/UX \(V6\/V7\/V8\)/m)
  expect(changelog).not.toMatch(/^## \[Unreleased\]/m)
})
