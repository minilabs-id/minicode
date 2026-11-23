# AGENTS.md

## Standar kerja pemilik (ditetapkan 2026-11-23)

- **Respons ringkas.** Jangan pakai tabel besar atau rangkasan panjang sebagai
  jawaban default. Sampaikan intinya, lalu berhenti. Yang panjang ditaruh di
  artefak `.audit/` bila memang perlu, bukan di balasan.
- **Perubahan = tuning / perbaikan kecil.** Skop pengembangan ke depan dijaga
  sempit. Kalau suatu perbaikan **berdampak besar ke UI** (geometri, composer,
  caret, ratchet, rekap, layout, warna, writer, I1), **wajib konfirmasi dulu**
  kepada pemilik — jangan langsung kerjakan.
- **Gate/rilis hanya atas aba-aba pemilik.** Jangan menjalankan `gate:fast`
  berulang sebagai kebiasaan. Verifikasi lokal cukup `tsc` + test terarah
  sampai pemilik memberi perintah gate/rilis.

Petunjuk untuk agent yang bekerja di repo ini. Peta struktur hidup:
[docs/architecture.md](docs/architecture.md).
Kontrak terminal FROZEN: [docs/TERMINAL_CONTRACT.md](docs/TERMINAL_CONTRACT.md) —
baca sebelum menyentuh output/rendering apa pun; perubahan perilaku wajib
update dokumen + test peta proteksinya. "FROZEN" bukan berarti tak pernah
berubah: kontrak diperbarui di v0.33, lalu v0.34/v0.35/v0.36/v0.43. **ARSIP v0.33:**
sidebar kanan sudah dihapus di v0.34; I36/I37 = jendela output command &
recovery/approval, bukan invariant sidebar. Baca versi terbaru di dokumen
(entri v0.36 paling atas), jangan mengandalkan ingatan.

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

HEAD checkout ini adalah `42a35a6` (garis rilis v0.43). Working tree adalah
**kandidat rilis 0.43.2 belum di-commit** (rilis ditahan owner): `CHANGELOG.md` dan `package.json` mencatat
0.43.2; kontrak terminal memakai entri v0.43 paling atas (bukan overlay: tail live maks 3 baris, ratchet `scrollBack` naik-saja, history committed tidak bergeser balik) di atas arsip
v0.42–v0.34. Angka gate historis v0.33 di bawah bukan hasil checkout ini;
hasil kandidat ada di `.audit/FINAL-STATE.md` §9/§11. Jangan menganggap angka
historis sebagai hasil checkout ini. `PLAN.md` adalah
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
- Modul aktif: `src/ui/render/{chat-column,tool-label,width,agent-progress}.ts`
  dan `src/ui/tui/{app,transcript}.ts`, serta `src/policy/{shell-tokenize,subagent-budget}.ts`
  (tokenizer shell sadar platform & anggaran sub-agent). Patuhi batas lapisan
  yang sama saat mengubahnya. **ARSIP v0.33:** `sidebar.ts`, `sidebar-layout.ts`,
  `sidebar-model.ts`, `activity-format.ts` dihapus di v0.34; penggantinya
  `chat-column.ts`. `src/ui/screens/window.ts` bukan lagi view sidebar.
- Jalur non-interaktif shell-first (append-only ke scrollback); sesi
  interaktif SELALU TUI alternate-screen (invariant terminal #1, tanpa opsi linear).
- Sejak v0.34 sesi interaktif memakai **kolom chat ter-centre**: `chatCols =
  floor(cols/2)` bila `cols ≥ 120 && rows ≥ 20`, lebar penuh di bawah ambang;
  padding kiri/kanan, footer & composer ikut ter-centre, popup tetap full-screen.
  Sejak v0.36 composer maks 2 baris, dropdown `/` overlay dalam frame yang sama.
  Sejak v0.37 `composerWidth()`/`chatWidth()` satu sumber di `chat-column.ts`
  dengan cap progresif, bracketed paste aktif, Ctrl+A = select-all transkrip bila
  composer kosong, dan resize stabilizer. Rincian di `docs/TERMINAL_CONTRACT.md`
  entri v0.34–v0.37; peta proteksi `test/chat-column.test.ts`, `test/tui-app.test.ts`.
  **ARSIP v0.33 (dicabut v0.34):** sidebar kanan, Live|Log split, `test/sidebar-*.test.ts`.
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
- Lebar prompt = **kolom**, bukan karakter: `composerWidth() = min(100, chatWidth())`
  dipakai konsisten oleh wrap, cache, kursor vertikal, klik mouse, dan frame.
- Wheel selalu menggulir chat; `Home/End` ke top/ekor chat. **ARSIP v0.33
  (dihapus v0.34):** wheel per-pane, `Alt/Ctrl+PgUp/PgDn`, `Ctrl+O`.
- Retry micro-toast TTL 4 dtk **ditimpa** tiap event: repaint satu baris footer,
  jangan menumpuk satu baris per percobaan.
- `vendor/minicore/**` **HOST-EDITABLE** sejak v0.16.0 (keputusan pemilik
  2026-11-10; lihat `vendor/minicore/VENDOR.md`). Tetap utamakan seam aditif
  dan jangan menurunkan kontrak lapisan yang dijaga test.
- Komentar Indonesia, jelaskan **mengapa**. Encoding UTF-8 tanpa BOM.
- Jangan commit kecuali diminta; jangan pernah commit rahasia.
