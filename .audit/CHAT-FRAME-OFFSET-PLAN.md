# Rencana: offset frame chat+composer 3 kolom, footer tetap kolom 0

**Checkpoint:** HEAD `2c7649c` (v0.43.3), working tree dirty (perubahan render/compaction
belum di-commit). **Status: RENCANA — belum dieksekusi, bukan klaim gate hijau.**
Sumber: 2 agen riset baca-sahaja (24–25 Nov 2026), bukti `file:line` di bawah.

## 0. Keputusan owner (sudah diberikan)

- Chat history + composer: **frame di-offset 3 kolom** dari tepi kiri terminal.
- Footer: **tetap mepet kolom 0** (tidak ikut offset).
- Aturan 3 spasi pada **teks** dihapus — padding milik frame, bukan string.

Koreksi penting dari riset: **footer saat ini TIDAK mepet kolom 0.** Semua baris, termasuk
footer, dapat `" ".repeat(padLeft)` di `src/ui/tui/app.ts:2797-2804`; footer juga di-render
pada lebar `chatCols` (`app.ts:2748-2765`, `:2785-2786`). Jadi ini benar-benar perubahan
perilaku, bukan sekadar memindahkan margin yang sudah ada.

## 1. Kondisi saat ini

- `src/ui/render/markdown-layout.ts:26` — `ASSISTANT_LEFT_MARGIN = 3`, adaptif di `:29-34`
  (`effectiveAssistantMargin(chatCols)` → 3/2/1/0 untuk terminal sempit).
- Margin disuntik ke **teks** di banyak titik:
  - composer: `app.ts:157,160-162` (`promptFirst` 3 spasi + `minicode ›`, `promptCont` 2 spasi + `·`); caret `:2198,2733,2810,1264`.
  - ledger: `transcript.ts:2613,2768-2772,3054-3059,2803-2805,2828,2874-2876,2740-2742`.
  - rekap/agregat `✦`: `transcript.ts:2975,2740-2742,1186,1189`.
  - narasi: `markdown-layout.ts:111,117`, `transcript.ts:1326,1351-1365,1502-1503`, printer linear `simple.ts:371-373`.
  - gema user: `transcript.ts:1071-1091`.
  - diagnostic: helper `transcript.ts:127-130` + ~10 pemanggil, `appendWithMargin :3164-3170`.
  - evict marker: `transcript.ts:3216` (`sourcePrefixes`).
- Geometri: `src/ui/render/chat-column.ts:18-26` — `chatCols=floor(cols/2)` bila `cols≥120 && rows≥20`,
  `padLeft=floor((cols-chatCols)/2)`. Frame dirakit `app.ts:2776-2787`, di-crop/pad `:2789-2804`,
  lalu `screen.paint()` (`src/ui/runtime/screen.ts:217-266`) — satu `stdout.write` di `:266`.
- **Titik tunggal offset yang benar**: loop `app.ts:2797-2804` sudah melakukan
  `" ".repeat(padLeft) + padToWidth(truncateToWidth(out[r], chatCols), chatCols) + " ".repeat(padRight)`
  per baris. Karena per-baris, footer **bisa** diberi offset berbeda.

## 2. Rencana implementasi (ATOMIK — tidak bertahap)

> Migrasi bertahap "(offset dulu, hapus margin teks kemudian)" akan menghasilkan **6 spasi**
> sementara dan test merah (`tui-app.test.ts:489,985,1000`; `chat-column.test.ts:270`).
> Harus satu perubahan atomik + update test bersamaan.

### Langkah 1 — geometri & offset frame
- `app.ts:2797-2804`: baris **chat + composer** dapat `" ".repeat(padLeft + margin)`;
  baris **footer/indicator** dapat `" ".repeat(padLeft)` (kolom 0 saat `padLeft=0`) dengan lebar penuh `cols`.
- `margin` = literal `3` (`ASSISTANT_LEFT_MARGIN`) sesuai keputusan owner — bukan adaptif.
  Terminal sempit tetap dapat 3 kolom.
- Konten jangan meluap kanan: `contentCols = chatCols - margin`. Pakai `contentCols` untuk
  `chatWidth()`/`composerWidth()` (`app.ts:1548-1563`), wrap (`:2572,2593,2658,2709`), dan
  `pushUser` width (`transcript.ts:1075-1076`).
- Footer `renderFooter()` (`footer.ts`) tetap lebar `chatCols` seperti sekarang — cuma dikecualikan
  dari offset 3, jadi mulai kolom 0.

### Langkah 2 — hapus margin dari teks (sumber §1)
- Hapus `ASSISTANT_LEFT_MARGIN` / `withTranscriptMargin` / `appendWithMargin` dari `transcript.ts`,
  `markdown-layout.ts`, `simple.ts:371-373`, `table-grid.ts:296`.
- Composer: `promptFirst()` jadi `minicode ›` (tanpa 3 spasi), `promptCont()` jadi `·`.
  `PROMPT_LONG_PREFIX_COLS` turun 3 → ambang `w ≥ 34` (dulu 37).
- Caret & hit-test: kurangi `margin` dari koordinat di `app.ts:1264,2198,2277-2278,2367-2369,
  2403,2421,2435,2511,2733,2810` dan `transcript.ts` (`selectionRange`/`pointAt`/`columnAtOffset`
  `:2063-2103,2166`) — `displayStart` turun 3 saat `sourcePrefix` dihapus.
- `/copy` & seleksi (`transcript.ts:3216`, kontrak `TERMINAL_CONTRACT.md:253-257`) ikut disinkron.

### Langkah 3 — kontrak & test
- `docs/TERMINAL_CONTRACT.md`: butir geometri v0.34 (`:60-70`), prefix/ambang v0.43
  (`:152-164`), peta proteksi (`:233-249`). Nyatakan "padding frame, bukan teks; footer kolom 0".
  Catatan: ini **mengubah D7** di `.audit/NO-SIDEBAR-CENTERED-PLAN.md:21` (dulu footer ikut ter-centre)
  — presedensi entri teratas berlaku.
- Test yang perlu disesuaikan: `test/chat-column.test.ts:98-135,157-163,214-231,259-289`,
  `test/tui-app.test.ts:294-305,487-520,978-1000,2133-2161`, `test/tui-scroll-width.test.ts:24-76`,
  `test/tui-transcript.test.ts:245-297,664-753`, `test/tui-format.test.ts:260-303`,
  `test/audit-fix-clean-composer.test.ts:123-166`, `test/audit-fix-footer-receipts.test.ts:90`.
  `rawFrameLines()` (`tui-app.test.ts:78-86`, `chat-column.test.ts:65-72`) tetap dipakai.
- I1 & writer: **aman** — tetap satu `paint` (`app.ts:2858`) & satu `stdout.write` (`screen.ts:266`).
  Jangan pakai `paintRegion()` (`screen.ts:289-339`) atau `clearRegion()` (`:353`).
  Writer aktual 13 / batas 19 (`test/writer-inventory.test.ts:239`).

## 3. Keputusan owner (SUDAH DITETAPKAN 25 Nov 2026)

1. **Popup/dropdown: tetap full-screen** (kolom 0, `dialog.ts:171-175`, `screen.ts:317-328`,
   `output-window.ts:87-99`). Nol perubahan — sesuai kontrak overlay v0.36.
2. **Footer: tetap seperti sekarang** — lebar `chatCols` (`app.ts:2748-2765`, `:2785-2786`),
   **cuma dikecualikan dari offset 3** (jadi mulai kolom 0, lebar tetap `chatCols`, bukan penuh `cols`).
3. **Margin: tetap 3** — pakai konstanta `ASSISTANT_LEFT_MARGIN = 3`, **bukan**
   `effectiveAssistantMargin` adaptif. Terminal sempit tetap dapat 3 kolom.

Implikasi: langkah 1 §2 memakai literal `3` (bukan `effectiveAssistantMargin`), dan footer
memakai `" ".repeat(padLeft)` + lebar `chatCols` (bukan `cols`).

## 4. Urutan eksekusi

1. ~~Putuskan 3 item §3~~ — SUDAH diputuskan owner (§3).
2. Satu agen implementasi atomik (source + test + kontrak sekaligus).
3. Verifikasi lokal: `tsc`, `lint`, test geometri/TUI terarah — **tanpa gate penuh** sampai aba-aba.
4. Uji manual `bun run dev`: draft panjang wrap tidak mepet; footer tetap di tepi; caret & klik mouse pas.
5. Gate/rilis menyusul atas perintah owner.

## 5. Risiko

- Dobel margin bila migrasi tidak atomik (§2).
- Off-by-3 caret/mouse di ~10 situs (§2 langkah 2).
- Footer ikut padLeft → kontradiksi D7 & kontrak (§2 langkah 3).
- Diff `screen.ts:243-247`: baris kosong jadi 3 spasi → satu repaint penuh saat transisi (masih satu write).
- `/copy` & seleksi berubah saat `sourcePrefix` dihapus — perlu test regresi eksplisit.
