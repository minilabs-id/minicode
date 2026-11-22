# PLAN LENGKAP — Hapus Sidebar, Chat Tengah Maksimal 50%

Checkpoint: HEAD `643f4b399bc19c334f2e8c1d1584c672095c12f6` (`643f4b3`).
Working tree sedang dimodifikasi (remediasi E-1…E-29 belum di-commit).
Rencana Work Context (`WORK-CONTEXT-PLAN.md`) **dibatalkan** — Anda memilih penghapusan total.

Status: **rencana siap dieksekusi; belum ada kode yang diubah untuk rencana ini.**

---

## 0. Keputusan yang dipakai (default, bisa diubah)

| # | Keputusan | Nilai |
|---|---|---|
| D1 | Threshold centre | `cols ≥ 120 && rows ≥ 20`; di bawah itu chat penuh |
| D2 | Notifikasi scheduler/job | dialihkan ke **toast satu baris** (ditimpa, tidak menumpuk) |
| D3 | Env `MINICODE_ACTIVITY_PANEL` | **deprecate di docs**, kode fold tetap dulu |
| D4 | Kontrak | amendemen **v0.34**, arsipkan v0.33 (jangan hapus) |
| D5 | Eksekusi | **bertahap** dengan gate di tiap fase |
| D6 | Popup/modal | tetap full-screen ter-centre pada `cols` (I20 tidak berubah) |
| D7 | Footer/composer | ikut ter-centre bersama chat (satu aturan padding) |

---

## 1. Target akhir

```
cols=200, rows=30:
[50 spasi][chat 100 kolom][50 spasi]
cols=120: [30][chat 60][30]
cols=80:  [0][chat 80][0]   (jangan 40 — merusak wrap & test narrow)
```

Geometri murni:
```ts
centered = cols >= 120 && rows >= 20
chatCols = centered ? Math.floor(cols / 2) : cols
padLeft  = Math.floor((cols - chatCols) / 2)
padRight = cols - chatCols - padLeft
```

Tidak ada lagi: `│`, "Thinking", "Activity", "Live", split, rasio 60:40,
`Alt/Ctrl+PgUp`, wheel per-pane, `Ctrl+O`, prefix umur, marker overflow, positionBar.

Yang tetap: satu frame / satu `stdout.write`, alt-screen satu pasangan, sanitasi,
wrap pakai kolom, `frameStatus`, `liveSummaryRows()+flushActivityFold()`,
`pendingScrollAnchor`/`onEviction`, `agentProgress`, footer spark.

---

## 2. MASTER TODO

Legenda: `[ ]` belum · `[x]` selesai · **GATE** = wajib hijau sebelum lanjut.

### Fase 0 — Baseline & checkpoint

- [x] **T0.1** Rekam `git rev-parse HEAD` dan `git status --short`; pastikan tidak ada perubahan tak dikenal di luar artefak `.audit/`.
- [x] **T0.2** Jalankan `bun run gate:fast` sebagai baseline; catat angka (jangan pakai angka historis v0.33).
- [x] **T0.3** Jalankan probe `bun run scripts/audit-scroll-probe.ts --cols=120` dan simpan output ke `.audit/baseline-center.txt`.
- [x] **GATE-0**: baseline terekam; gate baseline hijau atau flake tercatat.

### Fase 1 — Pulihkan narasi (belum hapus apa pun)

- [x] **T1.1** Di `app.ts`, panggil `this.transcript.setSidebarActive(false)` sekali saat inisialisasi (sebelum paint pertama), bukan sekadar menghapus guard.
- [x] **T1.2** Verifikasi di `t.view()` muncul kembali: baris `› name target`, `✦ 4 sub agent · 25 tool`, `[EVALUATE] …`, `+ thinking · N baris`.
- [x] **T1.3** Tambah/ubah test `test/audit-fix-activity-tidy.test.ts`, `test/audit-fix-finding-render.test.ts`, `test/activity-fold.test.ts` untuk menassert kemunculan itu di chat.
- [x] **T1.4** Pastikan tidak ada writer baru; jalankan `bun test test/writer-inventory.test.ts`.
- [x] **GATE-1**: `bun x tsc --noEmit && bun run lint && bun test <test di atas> && bun run gate:pack`.

### Fase 2 — Chat tengah (sidebar masih hidup, tapi tidak dirender)

- [x] **T2.1** Buat `src/ui/render/chat-column.ts` (~45 baris): `chatColumnGeometry(rows, cols)`, konstanta `CHAT_COLUMN_MIN_COLS=120`, `CHAT_COLUMN_MIN_ROWS=20`, `CHAT_COLUMN_MAX_RATIO=0.5`. Murni, tanpa impor `theme.ts`.
- [x] **T2.2** `app.ts:34`: ganti import `sidebarGeometry` → `chatColumnGeometry`.
- [x] **T2.3** `FrameLayout` (`app.ts:227-242`): `sidebar` → `padLeft/padRight: number`, pertahankan `chatCols`.
- [x] **T2.4** `chatWidth()` (`app.ts:1524-1530`): fallback ke helper baru.
- [x] **T2.5** `buildLayout` (`app.ts:2547`): ganti `sidebarGeometry(...)` dengan `chatColumnGeometry(rows, cols)`; `chatCols` dari helper.
- [x] **T2.6** `app.ts:2617-2630`: pertahankan rebase wrap; hapus `rebaseSidebarScroll` (`:2631-2637`).
- [x] **T2.7** `app.ts:2708`: **`composerLayout(chatCols)`** (jangan `width`).
- [x] **T2.8** `app.ts:2875`: `col: cursorCol + padLeft` (CUP absolut). `moveCursor` modal tetap tanpa pad.
- [x] **T2.9** `app.ts:2772-2870`: hapus blok render sidebar → loop `padLeft + padToWidth(chat) + padRight` untuk semua baris `out`.
- [x] **T2.10** Mouse: tambah `chatX = key.x - padLeft` di `app.ts:2303-2317, 2390-2422, 2433-2467` (5 situs: press/drag/release, movePromptCursor, autoScroll). Kebijakan: press di padding diabaikan, drag di-clamp, wheel di padding tetap scroll chat.
- [x] **T2.11** Hapus cabang wheel sidebar (`app.ts:943-966`), `Alt/Ctrl+PgUp` (`:994-1021`), `Ctrl+O` (`:925-938`).
- [x] **T2.12** Test baru `test/chat-column.test.ts`: geometri 119/120/200, baris tepat `cols`, pad leading, tanpa `│`, cursor CUP, mouse translasi, footer tidak menumpah, popup tetap 88.
- [x] **T2.13** Test `test/tui-app.test.ts`: tulis ulang 2 test sidebar (`:245-272`), tambah paritas scroll `End`/`PgUp` di cols=200.
- [x] **T2.14** Cek activity/waiting clock (`app.ts:2532-2541`) masih dipakai footer spark — jangan hapus sebelum diverifikasi.
- [x] **GATE-2**: `bun run gate:fast` + `bun run scripts/audit-scroll-probe.ts --cols=120` + `bun test test/chat-column.test.ts test/tui-app.test.ts test/screen.test.ts`.

### Fase 3 — Hapus sidebar total

- [x] **T3.1** `cli/tui.ts`: lepas `SidebarModel` (`:816-819`, `:1821`).
- [x] **T3.2** `cli/tui.ts:982` scheduler notice dan `:1336` notifikasi job → **toast satu baris** (D2). Tulis ulang `test/phase6ad-adversarial.test.ts:455-463,591-609` (jangan pakai `pushInfo` untuk sink scheduler).
- [x] **T3.3** `transcript.ts`: hapus `sidebarActive` field (`:626`), setter (`:644-648`), 5 early-return (`:955,2285,2370,2489,2548,2856`), `runningRows` guard; hapus wiring model (`import :36`, opsi `:340`, field `:636`, konstruksi `:722`, `markTurn :730`, `ingestThinking :877`, `:1077-1085`, helper `:1092-1125`, `reset :1240`, `:2290`, `:2310-2316`, `:2445,2533`). **Pertahankan** `agentProgress` & `delegateRowIds`.
- [x] **T3.4** `app.ts`: hapus sisa field/cache `sidebarCache*`/`sidebarSource*`/`sidebarModel` (`:354-365,499-508`) dan helper mati `sidebarPaneGeom`/`sidebarActivityExtra`/`liveBandLine`.
- [x] **T3.5** Hapus 3 file: `src/ui/render/sidebar.ts`, `sidebar-layout.ts`, `sidebar-model.ts`.
- [x] **T3.6** i18n: hapus kunci `sidebar.*` di `en.ts:65-70` & `id.ts:68-73`. **Jangan hapus** `panel.moreLines` (masih dipakai transkrip) dan `panel.thinking`/`panel.lines`.
- [x] **T3.7** Hapus 4 test: `sidebar-model.test.ts`, `sidebar-invariants.test.ts`, `sidebar-width.test.ts`, `thinking-truncation.test.ts` (≈348 baris).
- [x] **T3.8** Tulis ulang 10 test: `thinking-area`, `activity-fold`, `audit-fix-activity-tidy`, `audit-fix-finding-render`, `audit-fix-compact-tool-summary`, `audit-fix-live-inline-status`, `tui-render-regressions`, `tui-transcript`, `perf-no-quadratic` (hapus 2 test sidebar), `phase6ad-adversarial`.
- [x] **T3.9** Verifikasi tidak ada import tersisa: grep `sidebar.ts|sidebar-layout.ts|sidebar-model.ts|SidebarModel|sidebarGeometry` di `src/ cli/ test/ bench/ scripts/`.
- [x] **GATE-3**: `bun run gate:fast` + `bun test test/writer-inventory.test.ts test/ui-boundary.test.ts test/screen.test.ts`.

### Fase 4 — Kontrak, dokumen, rilis

- [x] **T4.1** `docs/TERMINAL_CONTRACT.md`: tambah entri **v0.34** di urutan presedensi; cabut klausa v0.33 butir 1–6 + 9 amandemen v7.x + Sifat produk + Grammar + peta proteksi (~19 lokasi). **Arsipkan v0.33, jangan hapus.**
- [x] **T4.2** Peta proteksi: hapus `sidebar-model`, `sidebar-invariants`, `sidebar-width`, `thinking-truncation`; tambah `chat-column`; perbaiki gap S-17 (`tui-geometry` bukan proteksi sidebar). I36/I37 **jangan** salah dirujuk.
- [x] **T4.3** `docs/architecture.md`: hapus DI `SidebarModel`, tambah `chat-column.ts`, update peta test & urutan render.
- [x] **T4.4** `docs/README.md:3`, `docs/cli.md`, `docs/environment.md`, `docs/getting-started.md`, `docs/troubleshooting.md`, spec internal (`OUTPUT_*`, `UI_RENDER_PIPELINE.md`), dan padanan `docs-en/*`.
- [x] **T4.5** `AGENTS.md`: klausa sidebar adalah otoritas pemilik — **flag untuk owner**, jangan ditulis ulang agent tanpa izin.
- [x] **T4.6** Env: deprecate `MINICODE_ACTIVITY_PANEL` di docs (D3); jelaskan `MINICODE_SHOW_THINKING` kini mengontrol `+ thinking` di chat, `MINICODE_MINIMIZE_ACTIVITY` tetap fold.
- [x] **T4.7** `CHANGELOG.md`: entri v0.34 + catatan migrasi ("detail tool tetap di chat + toast; reasoning di jurnal").
- [x] **T4.8** Arsipkan (jangan hapus) `WORK-CONTEXT-PLAN.md`, `SIDEBAR-CRITIQUE.md`, dan bagian sidebar di `AUDIT-CONSOLIDATED.md` dengan header "model v0.33, superseded".
- [x] **T4.9** **GATE FINAL**: `bun run gate:fast` pada **satu kandidat yang sama** + smoke build/package + CI relevan. Ambang `coverage-gate.ts` / `pack-budget.ts` tidak diubah.
- [x] **T4.10** Laporkan angka sebagai hasil kandidat v0.34; jangan klaim release-ready sebelum gate hijau.

---

## 3. Risiko & mitigasi (ringkas)

| Risiko | Mitigasi |
|---|---|
| Caret meleset ke margin | `cursorCol + padLeft` hanya di `app.ts:2875`; `moveCursor` modal absolut |
| Mouse off-by-padLeft | 5 situs translasi; test klik `x=padLeft+k` ≡ `x=k` |
| Dua-lebar baru | `composerLayout(chatCols)` wajib (T2.7) |
| Narasi hilang | T1 dulu, verifikasi `t.view()` sebelum hapus guard |
| Info scheduler/job hilang | T3.2 toast, bukan buang |
| Writer inventory merah | Padding ditulis di frame yang sama; jangan `write` terpisah |
| Resize flapping di 120 | `pendingScrollAnchor` sudah ada; test 119↔120 |
| Popup overhang 100–111 | Diterima (modal meredupkan seluruh layar), dokumentasikan |
| FROZEN breach | D4 amendemen v0.34 + persetujuan owner |

---

## 4. Definition of Done

- [x] Tidak ada file/field/fungsi sidebar tersisa di `src/ cli/ test/`.
- [x] `cols=200`: frame tepat `rows` baris, tiap baris lebar 200, 50/100/50, tanpa separator.
- [x] `cols=80`: chat penuh 80, padding 0.
- [x] Narasi tool/`✦`/finding/`+ thinking` terbukti muncul di chat via test.
- [x] Satu `screen.paint` / satu `process.stdout.write` per frame (I1).
- [x] `gate:fast` hijau pada satu kandidat final; angka dilaporkan sebagai hasil kandidat v0.34.
- [x] Belum ada commit; tidak ada klaim roadmap/release-ready.

---

## 5. Urutan eksekusi pendek

**T0 → T1 (GATE-1) → T2 (GATE-2) → T3 (GATE-3) → T4 (GATE FINAL).**

Jika salah satu gate merah, **berhenti** dan perbaiki di fase yang sama — jangan lanjut ke fase berikutnya.
