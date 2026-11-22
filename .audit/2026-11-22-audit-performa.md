# Audit Performa — minicode (working tree v0.33/v0.34)

- **Tanggal**: 2026-11-22
- **Checkout**: HEAD `643f4b3` (garis rilis v0.33.0); working tree **termodifikasi** (remediasi bug/dokumentasi belum di-commit)
- **Mode audit**: read-only untuk kode — **tidak ada perubahan source, test, atau konfigurasi**
- **Lingkup**: runtime turn/tool/session/persistensi, context & kompaksi, provider streaming, UI/TUI render, serta guard performa yang sudah ada
- **Batasan**: tidak ada benchmark runtime baru yang dijalankan. Semua pernyataan bersifat *struktural* (kompleksitas/alokasi, dibuktikan `file:line`) atau berasal dari artefak bench/test perf yang sudah ada di repo. Status "hijau"/release-ready **tidak** diklaim: gate belum dijalankan pada kandidat yang sama.

## Ringkasan eksekutif

| ID | Temuan | Dampak | Kepercayaan |
|---|---|---|---|
| F-01 | `session.state` = deep snapshot penuh riwayat, dipakai untuk baca scalar | Tinggi (biaya), Sedang (user) | Tinggi / Sedang |
| F-02 | Estimasi token diulang per step/turn atas riwayat yang sama | Sedang | Sedang |
| F-03 | `computeLiveSystem()` + repo-map/IO per request provider | Sedang | Sedang |
| F-04 | Persistensi write-heavy (save/shrink/presentation events) | Sedang | Sedang–Tinggi |
| F-05 | Jalur status/`getStatus()` rawan menjadi mahal tanpa disadari | Sedang–Rendah | Sedang |
| F-06 | `displayWidth`/grapheme segmentation tanpa memo | Sedang–Rendah | Sedang |
| F-07 | `resolveContextWindow` scan linear overlay models.dev per request | Rendah–Sedang | Sedang |
| F-08 | Gap metodologi: bench ketikan men-stub `host.getStatus()` | Rendah–Sedang | Tinggi |
| F-09 | `trimState` reducer: `findIndex`+`splice` per eviction | Rendah | Tinggi |

Tidak ditemukan pola O(n²) baru pada hot path yang sudah diklaim bebas kuadratik (proyeksi transkrip, order-index reducer, diff). Guard yang ada terverifikasi ada dan relevan — lihat bagian **Guard performa yang sudah ada**.

## Metode

Inspeksi kode + pembacaan artefak perf:

- UI/TUI: `src/ui/tui/{app,transcript}.ts`, `src/ui/render/{width,cells,markdown,table-grid,theme}.ts`
- Agen/runtime: `src/app/session.ts`, `src/policy/{context,context-window,context-budget,compaction,microcompact}.ts`, `src/runtime/*`
- State durable: `src/session/{persistence,context-adapter}.ts`, `src/memory/vector.ts`, `src/repo/repomap.ts`
- Kernel vendored: `vendor/minicore/src/core/{session,snapshot,tokens}.ts`
- Composition root: `cli/{tui,setup,index}.ts`, `cli/commands/{exec,acp}.ts`
- Bench/test perf: `scripts/bench-render.ts`, `scripts/bench-typing.ts`, `scripts/bench-tui-pty.ts`, `bench/harness-audit.ts`, `test/perf-no-quadratic.test.ts`, `test/freeze-regressions.test.ts`, `test/render-audit-2026-11.test.ts`, `test/tui-diff.test.ts`

## Temuan detail

### F-01 — `session.state` melakukan deep snapshot penuh riwayat (Tinggi/Sedang)

**Bukti kode**

- `vendor/minicore/src/core/session.ts:250-252` — getter `state` mengembalikan `snapshotState(state)`.
- `vendor/minicore/src/core/snapshot.ts:51-58` — `snapshotState` memanggil `snapshotMessages(state.history)` (map seluruh pesan).
- `vendor/minicore/src/core/snapshot.ts:94-115` — `snapshotValue` memakai `structuredClone` (tool args); content biner di-`slice()`; content string ikut di-clone per pesan.
- Pembanding: `vendor/minicore/src/core/session.ts:258-264` — `contextTokens` adalah getter **angka** murah, tanpa snapshot.

**Call site yang hanya butuh scalar tetapi membayar O(history)**

- `src/app/session.ts:1430` — `estimateMessages(core.state.history, minicodeEstimator)` di handler `provider:extension` (event usage), **selalu** dihitung walau hasilnya biasanya dibuang karena `lastRequestLocalEstimate?.tokens` sudah ada (`:1431`).
- `src/app/session.ts:1509-1510` — `core.state.turnCount` dibaca 2× (masing-masing snapshot penuh).
- `src/app/session.ts:1516-1518` — getter `state` mengekspos snapshot ke pemanggil luar.
- `cli/tui.ts:794-805` — `getContextTokens()` membaca `session.state` **sebelum** mengecek cache; fungsi ini dipanggil 2× per `getStatus()` (`cli/tui.ts:1705-1706`), dan `getStatus()` dipanggil per paint (`src/ui/tui/app.ts:2657`) serta per handler (`:1408`, `:1452`).
- `cli/tui.ts:593`, `cli/tui.ts:842` — hanya membaca `turnCount`.
- `cli/setup.ts:2075`, `:2096`, `:2337`, `:2427`, `:2542`, `:2667`, `:2705`, `:2718`, `:2762` — sebagian berada di handler per-event: `:2427` (`stepCount`) ada di dalam handler `execution:completed`, yaitu **per tool call**.
- `cli/index.ts:642,664-665,694-695`; `cli/commands/exec.ts:342-343,373`; `cli/commands/acp.ts:493-494` — scalar yang sama.

**Mengapa berbahaya**

`getContextTokens()` sudah dirancang murah (cache `cachedContext` per `turnCount`, nilai `liveContextTokens` per step), tetapi pembacaan `session.state` terjadi lebih dulu sehingga deep clone tetap dibayar meski hasilnya di-cache. Saat idle (di antara turn) `liveContextTokens` undefined, jadi setiap paint — termasuk setiap ketikan — membayar clone penuh riwayat 2×.

**Dampak**: alokasi O(total byte riwayat) + GC pressure, tumbuh seiring panjang sesi dan ukuran tool output. Gejala yang diharapkan: TUI terasa lambat saat mengetik pada sesi panjang, jeda mikro setelah tool selesai.

**Kepercayaan**: Tinggi untuk biaya mekanisme (bukti kode langsung); Sedang untuk besaran user-visible (butuh profiling).

**Rekomendasi**

1. Pisahkan accessor ringan (`turnCount`, `stepCount`, `historyRef` read-only) untuk kebutuhan counter/estimasi.
2. Pertahankan `snapshotState` hanya di boundary yang benar-benar butuh isolasi (payload request provider, ctx tool).
3. Urutkan ulang `getContextTokens()` agar cache/live dicek sebelum menyentuh `session.state`.
4. Guard test: "paint/status tidak boleh memicu snapshot history".

---

### F-02 — Estimasi token diulang pada riwayat yang sama (Sedang)

**Bukti kode**

- `vendor/minicore/src/core/tokens.ts:72-76,79-88,97-108` — `estimateMessages`, `estimateTools`, `estimateSystem`, `estimateSessionContext` memindai ulang argumennya tanpa cache.
- `src/policy/context.ts:93-105` — `minicodeEstimator` menjalankan dua `matchAll` regex (dense token + kode/JSON) atas **seluruh teks** tiap panggilan.
- `src/app/session.ts:1122-1129` — token system/tools/messages dihitung di setiap pembukaan `stream()` (per step).
- `src/app/session.ts:1249-1259` — saat factor kalibrasi berubah, ketiga estimasi dihitung ulang penuh.
- `src/policy/compaction.ts:290,297,479,494,518,648,726` — `estimateMessages` dipakai berulang saat memilih boundary/kandidat kompaksi.

**Mitigasi yang sudah ada**: `createIncrementalTokenCounter` (`src/policy/context.ts:59-91`) untuk teks streaming; cache `contextTokens` per turn di CLI. Yang belum ada: cache per-message untuk estimasi batch.

**Dampak**: CPU linear × jumlah step; memuncak pada sesi panjang dengan tool result besar (`grep`, `bash`, `read_file`). Bukan O(n²) — menambah latensi antar-step, bukan hang.

**Kepercayaan**: Sedang.

**Rekomendasi**: instrumentasi durasi estimasi per step; pertimbangkan memo lemah per identity pesan (WeakMap) + invalidasi saat estimator/factor berubah.

---

### F-03 — `computeLiveSystem()` dan konteks sistem lain dijalankan per request (Sedang)

**Bukti kode**

- `src/app/session.ts:940-946` — `computeLiveSystem()` merangkai `baseSystem + workModeHint + permissionModeHint + capacityHint` tiap panggilan.
- `src/app/session.ts:1106` — dipanggil di awal setiap `stream()`.
- `src/policy/context.ts:420-521` — `buildSystemPrompt` memuat memory, berkas AGENTS/steering (`safeReadFileCapped`, `realpath`, `readdir`), repo-map, dan fallback `git ls-files` (`execFileAsync`, `:499-510`).

**Mitigasi yang benar**: repo-map dijalankan paralel dengan blok prompt berikutnya (`src/policy/context.ts:478-493`) dan punya cache disk + in-process (`src/repo/repomap.ts:410-530`).

**Dampak**: latensi tambahan per step, terutama repo besar / filesystem lambat; jalur fallback `git ls-files` dan `signature()` membaca isi berkas.

**Kepercayaan**: Sedang (sangat bergantung cache hit rate).

**Rekomendasi**: hitung dan log durasi `computeLiveSystem`, `loadRepoMap`, `signature`, dan `git ls-files` per turn; tetapkan budget + alarm (mis. > 100 ms) di mode debug.

---

### F-04 — Persistensi write-heavy dan serialisasi JSON (Sedang–Tinggi)

**Bukti kode**

- `src/session/persistence.ts:654-804` — `saveSession`: upsert sesi, ensure thread, `db.prepare(...)` per operasi, normalisasi tuple untuk dedupe, perbandingan prefix penuh, lalu insert incremental.
- `src/session/persistence.ts:556-606` — `appendPresentationEvents`: `encodePresentationEvent` + fingerprint + `sameCanonicalPayload` + `INSERT OR IGNORE` per event dalam satu transaksi; `withBusyRetry` memakai `Bun.sleep` (`:615-627`).
- `src/session/persistence.ts:3112-3232` — `shrinkThreadHistory`: membaca seluruh baris `messages`, `DELETE`, lalu insert ulang seluruh histori dalam satu transaksi, plus invalidasi proyeksi.
- `src/session/context-adapter.ts:162-195` — setiap kompaksi menulis event durable tambahan.

**Dampak**: pada sesi panjang / stream padat, biaya IO+CPU naik dan dapat memblok event loop (SQLite sinkron di dalam transaksi). Ini kebutuhan durability, bukan bug, tetapi perlu batas ukuran batch dan pengukuran p95.

**Kepercayaan**: Sedang–Tinggi untuk biaya; Sedang untuk dampak user.

**Rekomendasi**: ukur p95 `saveSession` / `appendPresentationEvents` / `shrinkThreadHistory`; periksa ukuran batch flush event presentasi; pastikan tidak ada flush sinkron di tengah stream token.

---

### F-05 — Jalur status/`getStatus()` rawan menjadi mahal (Sedang–Rendah)

**Bukti kode**

- `cli/tui.ts:1686-1724` — `getStatus()` merangkai permission/work-mode, `getContextTokens()` (2×), `fmtUsageMetrics`, `countLiveBackgroundJobs`, dan saat busy `getPresentationSnapshot().activities` + dua `find`.
- `src/ui/tui/app.ts:2642-2664` — `paint()` memanggil `host.getStatus()` satu kali per frame (desain benar); konsekuensinya, biaya apa pun di `getStatus()` menjadi biaya per frame.
- `cli/tui.ts:95-124` — komentar menyatakan sengaja memakai angka cached agar `session.contextTokens` tidak dihitung per paint (intent benar; celah implementasinya dibahas di F-01).

**Dampak**: regresi mudah terjadi tanpa disadari saat menambah field status.

**Kepercayaan**: Sedang.

**Rekomendasi**: tetapkan kontrak tertulis "`getStatus`: tanpa IO, tanpa deep clone, < 2 ms"; tambahkan guard test yang memastikan path status tidak menyentuh snapshot/IO.

---

### F-06 — `displayWidth`/segmentasi grapheme tanpa memo (Sedang–Rendah)

**Bukti kode**

- `src/ui/render/width.ts:66-75` — `segmentGraphemes` memakai `Intl.Segmenter` + `Array.from` per panggilan.
- `src/ui/render/width.ts:106-126` — `displayTokens` selalu memanggil `segmentGraphemes(run)`, termasuk untuk teks ASCII murni.
- `src/ui/render/width.ts:161-165` — `displayWidth` menjumlahkan token tanpa jalur cepat ASCII.
- `src/ui/render/width.ts:306-341` — `truncateToWidth` memanggil `displayWidth(s)` lalu memindai ulang lewat `displayTokens` (dua lintasan).
- `graphemeWidth` (`:77-97`) mengalokasikan `String.fromCodePoint` + beberapa regex per grapheme.

Perilaku ini **benar** untuk Unicode (CJK/emoji/ZWJ); yang disorot adalah biayanya. Angka absolut bergantung mesin; rasio antar komponen diukur `scripts/bench-typing.ts` (baris komponen `applyKey`, `wrap`, `renderFooter`, `resolveContextWindow`).

**Kepercayaan**: Sedang.

**Rekomendasi**: tambah fast-path ASCII pada `displayTokens`/`displayWidth`, lalu ukur delta pada mesin yang sama sebelum/sesudah.

---

### F-07 — `resolveContextWindow` scan linear overlay models.dev (Rendah–Sedang)

**Bukti kode**

- `src/policy/context-window.ts:92-114` — `findContextWindowFromOverlay` melakukan `Object.keys(map).length` dan `Object.entries(map)` per segmen model, tanpa memo.
- `src/policy/context-window.ts:218+` — `resolveContextWindow` memanggil jalur overlay.
- `cli/setup.ts:1173-1198` (`resolveEffectiveContextWindow`) → dipanggil `getContextWindowTokens`, yang dipanggil di `:1223`, `:1363`, `:1942` (resolver router), `:3115`, `:3152`.
- `cli/setup.ts:2061,2078-2079` — dipanggil di jalur eskalasi jendela.
- `cli/context-command-run.ts:58` — per entri katalog.

**Mitigasi penting**: jalur footer memakai snapshot statis (`cli/setup.ts:2009-2010` → `ctx.contextWindowTokens`), jadi **tidak** dipanggil per frame (diverifikasi: `cli/tui.ts` tidak memanggil `resolveContextWindow`).

**Dampak**: biaya per request/step sebanding jumlah entri overlay (bench memakai 1000 entri), bukan per frame. Risiko naik bila kelak dipanggil dari paint.

**Kepercayaan**: Sedang.

**Rekomendasi**: memo per `modelId` dengan invalidasi saat overlay dimuat ulang; pertahankan snapshot statis di jalur footer.

---

### F-08 — Gap metodologi benchmark: bench ketikan men-stub `host.getStatus()` (Rendah–Sedang)

**Bukti kode**

- `scripts/bench-typing.ts:231-248` — `makeGetStatus()` mengembalikan footer sintetis dan **tidak** memanggil `session.contextTokens` maupun `session.state`.
- Padahal bench ini dimaksudkan menjawab keluhan "TUI terasa lambat saat mengetik" (`scripts/bench-typing.ts:1-21`).

**Dampak**: benchmark bisa terlihat sehat sementara biaya nyata ada di `getStatus()` produksi (`cli/tui.ts:1686+`, lihat F-01). Inilah alasan F-01 belum terdeteksi oleh bench yang ada.

**Kepercayaan**: Tinggi.

**Rekomendasi**: tambahkan skenario bench yang memakai `getStatus()` produksi (atau replika yang membaca counter sesi) dengan riwayat 200/400/1000 pesan.

---

### F-09 — Reducer: `trimState` memakai `findIndex` + `splice` per eviction (Rendah)

**Bukti kode**

- `src/presentation/reducer.ts:321-340` — `trimState` melakukan `values.findIndex(removable)` lalu `splice` per entri yang dievict.

**Mitigasi kuat**: `ORDER_KEYS` + `addOrder`/`removeOrder` menghilangkan scan linear per event (`src/presentation/reducer.ts:76-122`), dan `MAX_STATE_ENTRIES` membatasi panjang array.

**Dampak**: hanya terasa saat melewati cap; O(cap) per eviction, bukan O(total event).

**Kepercayaan**: Tinggi untuk mekanisme, Rendah untuk dampak.

**Rekomendasi**: ring buffer / pointer awal bila kelak cap dinaikkan.

---

## Guard performa yang sudah ada (jangan diregresikan)

1. **Proyeksi transkrip inkremental** — `committedByWidth` + LRU 3 lebar, `applyAppend`/`applyEvict`, cache baris per `(id,width)`, memo baris pending: `src/ui/tui/transcript.ts:1453-1760`. `viewport()` tidak memanggil `projectAll()`: `test/perf-no-quadratic.test.ts:23-38`. Rebuild diukur `projectionRebuilds`: `:40-55`.
2. **Batching paint input** — burst/paste tidak melukis N frame: `src/ui/tui/app.ts:391-397`, `:911-939`.
3. **Satu `getStatus()` per frame** + `frameStatus` dipakai ulang helper: `src/ui/tui/app.ts:2655-2663`, `:1446-1456`.
4. **Anti-O(n²) pending projection** — memo baris final; regresi dijaga `test/render-audit-2026-11.test.ts:24-57`.
5. **Diff berbatas** — LCS kata dilepas di atas batas sel, input raksasa dipotong dan pemotongan terlihat: `test/render-audit-2026-11.test.ts:159-184`, `test/tui-diff.test.ts:94-103`.
6. **Repo-map memo** — panggilan kedua < 20 ms: `test/freeze-regressions.test.ts:104-126`.
7. **Stream guard** — idle-timeout memotong provider bisu tanpa memotong stream lambat yang sah: `test/freeze-regressions.test.ts:31-101`.
8. **Repo-map paralel** dengan blok prompt berikutnya, bukan blocking kritis: `src/policy/context.ts:478-493`.
9. **Harness audit deterministik** tanpa API key: `bench/harness-audit.ts` (safety/jail/budget/provider resilience/compaction).

## Rekomendasi prioritas

1. **Instrumentasi dulu, optimasi kemudian** — metrik waktu untuk `getStatus()`, `computeLiveSystem()`, estimasi token per step, `saveSession`, `appendPresentationEvents`, `paint`/`viewport`, `shrinkThreadHistory`.
2. **Baseline benchmark** pada mesin + commit yang sama; simpan output JSON dari `bench-render`, `bench-typing`, `bench-tui-pty`.
3. **Audit seluruh call site `.state`** dan pisahkan accessor counter-only (F-01) — rasio manfaat/risiko terbaik.
4. **Tutup gap metodologi bench** (F-08) sebelum memakai angka bench sebagai bukti "sudah cepat".
5. **Tetapkan budget performa tertulis** — p95 keypress→echo, p95 paint, p95 overhead per step, batas maksimum blok event loop saat persist.

## Perintah reproduksi

```bash
bun scripts/bench-render.ts --json
bun scripts/bench-typing.ts --json
bun scripts/bench-tui-pty.ts
bun bench/harness-audit.ts --json
bun test test/perf-no-quadratic.test.ts test/render-audit-2026-11.test.ts test/freeze-regressions.test.ts
```

Catatan: `scripts/bench-typing.ts:573-577` menyatakan sendiri bahwa angka absolut bergantung host, tidak ada ambang, dan **bukan gerbang CI**. Gunakan hanya sebagai pembanding sebelum/sesudah pada mesin yang sama.

## Batasan audit ini

- Tidak ada perubahan source/test/konfigurasi.
- Tidak ada pengukuran latensi/memori runtime baru pada sesi ini; F-01…F-07 adalah analisis struktural berbasis bukti kode. Angka pada tabel hanya peringkat kualitatif dampak, bukan hasil ukur.
- Working tree sedang dimodifikasi; gate tidak dijalankan pada kandidat yang sama, jadi dokumen ini tidak menyatakan status hijau atau arsitektur final.
