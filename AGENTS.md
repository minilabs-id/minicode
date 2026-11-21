# AGENTS.md

Petunjuk untuk agent yang bekerja di repo ini. Peta struktur hidup:
[docs/architecture.md](docs/architecture.md).
Kontrak terminal FROZEN: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) —
baca sebelum menyentuh output/rendering apa pun; perubahan perilaku wajib
update dokumen + test peta proteksinya. "FROZEN" bukan berarti tak pernah
berubah: kontrak memang diperbarui di v0.33 (sidebar kanan; invarians I36/I37).
Baca versi terbaru di dokumen, jangan mengandalkan ingatan.

## Otoritas roadmap

Roadmap arsitektur adalah milik pemilik repo. `ROADMAP.md` tidak tersedia di
checkout ini, jadi status Big Phase maupun next action belum dapat dinyatakan.
`PLAN.md` ada di checkout ini tetapi hanyalah ledger legacy, bukan roadmap
aktif; `ROADMAP.md` tidak ada.
Jangan merekonstruksi status dari changelog, kode, atau artefak histori. Jangan
menulis ulang master roadmap sebagai agent. Label Big Phase (`P1`–`P14`),
sub-milestone (`P2.x`), Quality Remediation (`Stage 1`–`10`), dan hotfix
(`P0/UX-001`) adalah namespace berbeda.

## Status checkout

HEAD adalah commit v0.33 (`1aaca14`); `CHANGELOG.md` dan `package.json` kini
mencatat v0.33.0. `PLAN.md` adalah
ledger milestone legacy, bukan roadmap aktif. `ROADMAP.md`,
`docs/ARCHITECTURE.html`, dan `docs/audit/` tidak ada; status roadmap belum
tersedia. Gate repository dapat dijalankan, tetapi checkout tidak boleh
disebut hijau atau release-ready sebelum seluruh gate lulus pada kandidat yang
sama.

Peta dokumentasi aktif: [docs/README.md](docs/README.md), navigasi:
[`docs/SUMMARY.md`](docs/SUMMARY.md), arsitektur: [docs/architecture.md](docs/architecture.md),
kontrak terminal: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md).

## Gate (urutan ini, semua hijau sebelum selesai)

```bash
bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
```

Lima perintah di atas adalah **minimum lokal**. Set canonical untuk seluruh gate
adalah `bun run gate:fast` — gabungan tsc, lint, test, coverage, pack, bash,
bench:smoke, audit:harness, dan gate:telemetry. Gate memakai manifest
`package.json` yang ada pada checkout ini.

### Gate coverage — HASIL HISTORIS kandidat rilis v0.33.0 (2026-11-21)

> **Bukan janji untuk commit berikutnya.** Angka di bawah tercatat pada pohon
> kandidat rilis v0.33.0 (checkpoint 2026-11-21): commit fitur `1aaca14`
> ditambah bump versi, CHANGELOG, dan pembaruan dokumentasi. Angka historis
> tetap historis — sebutkan checkpoint-nya, jangan menyebutnya sebagai hasil
> checkout berikutnya. Jalankan ulang gate bila ada perubahan setelah ini.

`bun run gate:coverage` **selesai dan lulus** pada kandidat tersebut:

```
[coverage-gate] funcs 90.22% (min 87) · lines 91.07% (min 86)
[coverage-gate] lantai per-berkas: 19/19 modul kritis hijau
```

Angka gate lain pada kandidat yang SAMA (`bun run gate:fast`, exit 0): `bun x
tsc --noEmit` = bersih (0 error), `bun run lint` = 851 file / 0 error,
`bun test` = 6627 pass / 33 skip / 0 fail, `bun run gate:pack` = 23 pass / 0
fail (budget 5000 KiB, paket 4903 KB / 340 file), `bun run gate:bash`,
`bun run bench:smoke`, `bun run gate:telemetry` lolos, `bun run audit:harness`
= 73 pass / 0 fail (2 advisory). Checkpoint lebih awal `1aaca14` (sebelum
meta/dokumentasi) mencatat coverage 90.19% funcs / 91.07% lines dan paket
4874 KB — selisih kecil karena perubahan test/i18n/dokumen pada kandidat rilis.

Catatan lama soal "job panjang dihentikan saat sesi berakhir" tidak lagi
berlaku di lingkungan ini: `gate:coverage` diselesaikan dengan proses latar
yang bertahan melewati sesi pemanggil dan log-nya dibaca setelah selesai.

Gejala flake yang sudah teridentifikasi, jangan dikejar sebagai regresi:

- Di bawah beban suite penuh, beberapa test yang menunggu subproses keluar
  dengan batas 5–7,5 dtk bisa timeout (`test/supply-chain.test.ts`,
  `test/work-mode-cli.test.ts`, `test/writer-inventory.test.ts`,
  `test/exit-codes.test.ts`, `test/extreme.test.ts`,
  `test/phase1-tools.test.ts`). Semuanya lulus saat dijalankan sendiri; run
  penuh berikutnya 0 fail.
- `test/concurrency-cross-process.test.ts` (§32 dua proses tulis sesi) adalah
  flake lintas-proses Windows yang sama kelasnya.

Angka di atas adalah hasil pada kandidat tersebut, bukan janji untuk commit
berikutnya: jalankan ulang gate bila ada perubahan setelah kandidat ini.
Jangan menurunkan ambang di `scripts/coverage-gate.ts` atau menaikkan budget di
`scripts/pack-budget.ts` untuk membuat gate hijau.

**Ruang lingkup klaim hasil — baca sebelum menulis laporan status.**

- Laporan **stage-scoped** (mis. "Stage 8.1 `FIX VERIFIED`") **hanya boleh
  mengklaim scope yang benar-benar divalidasi** pada scope itu: perintah yang
  dijalankan, commit/working tree yang diuji, angka pass/fail/skip/error, dan
  tes yang **tidak** dijalankan. Hasil stage-scoped **tidak boleh** ditulis
  seolah-olah seluruh repository hijau.
- **Menutup track Quality Remediation penuh** (Stage 1–10) atau **mengumumkan
  release-readiness / quality akhir** tetap **mensyaratkan seluruh gate akhir
  lulus pada satu kandidat final yang sama** — urutan di atas ditambah
  `bun run audit:harness`, smoke build/package, dan pemeriksaan CI yang
  relevan. Ambang gate **tidak boleh** diturunkan untuk membuat hasil terlihat
  hijau.
- Angka hasil historis (laporan sebelumnya) tetap berstatus **historical**:
  sebutkan checkpoint-nya, jangan menyebutnya sebagai hasil sekarang.

Jangan turunkan ambang coverage atau naikkan budget paket untuk membuat gate
hijau. Sumber angkanya `scripts/coverage-gate.ts` dan
`scripts/pack-budget.ts`; perubahan budget memerlukan bukti baru dan
persetujuan pemilik.

## Batas lapisan (dijaga `test/ui-boundary.test.ts`)

- `cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui DILARANG impor
  `src/ui/`; `src/ui/` DILARANG impor `cli/`, `src/` non-ui, `#minicore`.
- Lintas-lapisan via DI dari composition root (`cli/index.ts`, `cli/setup.ts`):
  `ask`, `setupWhenEmpty`, `setSubAgentSessionFactory`. Tanpa injeksi default
  selalu deny / fail-closed. `providers → config` satu arah (provisioning di
  `src/providers/provision.ts`, `src/config.ts` murni IO).
- Layar `src/ui/screens/` = view murni (props + callback), controller di `cli/`.
- Modul v0.33: `src/ui/render/{sidebar,sidebar-layout,sidebar-model,activity-format,agent-progress}.ts`
  dan `src/ui/screens/window.ts` (view sidebar, tetap murni props + callback),
  serta `src/policy/{shell-tokenize,subagent-budget}.ts` (tokenizer shell sadar
  platform & anggaran sub-agent). Patuhi batas lapisan yang sama saat mengubahnya.
- Jalur non-interaktif shell-first (append-only ke scrollback); sesi
  interaktif SELALU TUI alternate-screen (invariant terminal #1, tanpa opsi linear).
- Sejak v0.33 sesi interaktif punya **sidebar kanan adaptif** (jendela Thinking /
  Activity / Live; aktif bila `cols ≥ 100` **dan** `rows ≥ 20`; Live|Log split
  mulai 168 kolom; chat floor 36 kolom; tanpa bingkai). Rincian invariant di
  `docs/TERMINAL_CONTRACT.md` (I36/I37); peta proteksi di `test/sidebar-*.test.ts`.
- Ubah struktur/dependensi antarlapisan → wajib update `docs/architecture.md`.

## Jebakan (semua pernah jadi bug nyata)

- `c`/`glyphs` di `src/ui/render/theme.ts` adalah **getter** runtime — jangan
  simpan ke `const` di module scope (nilai membeku saat import).
- Lebar terminal = **kolom**, bukan karakter: pakai `displayWidth` dkk. dari
  `src/ui/render/width.ts` (CJK/emoji = 2 kolom).
- Teks model/tool/berkas = input tak terpercaya: lewatkan `sanitizeAnsi`
  (`src/ui/render/sanitize.ts`) sebelum tampil — termasuk label picker &
  daftar manager (nama model/provider dari jaringan/config lokal repo), dan
  gema dialognya. Sanitasi adalah satu-satunya gerbangnya: modul geometri
  (`width.ts`) SENGAJA mempertahankan sekuens utuh karena footer memakai CHA
  non-SGR untuk merapatkan konteks.
- `cwd` tool file **wajib** dari `ToolContext.cwd`, bukan `process.cwd()`.
- Sidebar dihitung dalam **kolom** (`displayWidth`/helper layout), bukan karakter:
  rasio 30%≤150 kolom → 50%≥160 kolom, Live|Log mulai 168, chat floor 36.
- Wheel sidebar **per-pane** (pane di bawah kursor), bukan satu state global:
  `Alt+PgUp/PgDn` menggulir dua kotak + menggeser seleksi Live,
  `Ctrl+PgUp/PgDn` mengubah rasio tinggi, `Ctrl+O` modal detail, `Home/End` ke
  tepi chat **dan** sidebar.
- Retry micro-toast TTL 4 dtk **ditimpa** tiap event: repaint satu baris footer,
  jangan menumpuk satu baris per percobaan.
- `vendor/minicore/**` **HOST-EDITABLE** sejak v0.16.0 (keputusan pemilik
  2026-11-10; lihat `vendor/minicore/VENDOR.md`). Tetap utamakan seam aditif
  dan jangan menurunkan kontrak lapisan yang dijaga test.
- Komentar Indonesia, jelaskan **mengapa**. Encoding UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.
