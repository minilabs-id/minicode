# Audit Performa Pemahaman Dependensi MiniCode

**Tanggal audit:** 2026-11-28  
**Kandidat checkout:** `v0.52.1` ([package.json](file:///d:/Github/minicode/package.json#L1-L89))  
**Sifat audit:** Read-only terhadap kode produksi; seluruh angka merupakan hasil inspeksi sumber + eksekusi pengukuran langsung di repositori `d:\Github\minicode`.

---

## 1. Ringkasan Eksekutif & Penilaian

Pemahaman dependensi MiniCode saat ini bertumpu pada **dua jalur** — [src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts) (pasif di system prompt) dan integrasi LSP di [src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts) + [src/tools/lsp.ts](file:///d:/Github/minicode/src/tools/lsp.ts) (aktif via tool).

Secara arsitektur keamanan dan batas kepercayaan (*trust boundary*), fondasinya rapi. Namun secara **efektivitas pemahaman dependensi pada proyek nyata (termasuk repositori MiniCode sendiri)**, kinerjanya **gagal bekerja di skenario default** karena rangkaian cacat desain & ambang batas yang saling memperburuk:

| Dimensi | Status | Skor | Akar Masalah Terukur |
|---|---|:---:|---|
| Cakupan Repo-Map | **Kritis** | 1/5 | `.slice(0, 60)` alfabetis di `gitListFiles()` memotong **100% `src/` (`0 / 258` file)** pada repo ini |
| Pengiriman ke LLM | **Kritis** | 0/5 | `buildSystemPrompt()` memotong ekor di `6.800` char; `# Repo map` **hilang 100%** di MiniCode |
| Grafik Import (`rankByImport`) | **Lemah** | 2/5 | **528** *false-positive* substring, **174** *dynamic import* terlewat, tanpa *path alias* / `index.ts` |
| Ekstraksi Simbol & Relasi | **Dasar** | 2/5 | Regex baris-per-baris tanpa edge `imports`/`used-by`; **31** barrel *re-export* tak terpetakan |
| Integrasi LSP (aktif) | **Memadai, tapi pasif** | 3/5 | Klien tangguh, tapi **0 auto-discovery**; *bug* wire di sub-agent; *bug* `waitForDiagnostics` basi |
| Manifest & Konfigurasi Proyek | **Nihil** | 0/5 | `package.json` hanya dibaca `scripts`/`version`; `dependencies`, `exports`, `imports`, `tsconfig.json#paths` buta |
| Pencarian Fallback Tanpa `rg`/LSP | **Lambat** | 2/5 | Di mesin tanpa `rg`, `grep` fallback walker JS memakan **1.839 ms** per kueri penuh |

> **Verdict singkat:** Pada kondisi default (tanpa LSP terkonfigurasi dan `rg` tidak terpasang), MiniCode **tidak memiliki peta dependensi `src/` di prompt** (terpotong ganda: di `gitListFiles` lalu di `cutMarked`), tidak punya tool inspeksi grafik modul, dan mengandalkan `grep` JS (~1,8 detik/kueri) + `read_file` berulang untuk merangkai dependensi secara manual.

---

## 2. Arsitektur Saat Ini & Hasil Pengukuran Langsung

### 2.1 Inventaris Komponen Pemahaman Dependensi

1. **Repo-Map statis / best-effort LSP:** [src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts) dipanggil lewat `loadRepoMap(cwd)` oleh [src/policy/context.ts](file:///d:/Github/minicode/src/policy/context.ts#L415-L430) dan `/init` di [cli/commands.ts](file:///d:/Github/minicode/cli/commands.ts#L845-L855).
2. **Klien & Tool LSP:** [src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts) (`diagnostics`, `definition`, `references`, `hover`, `documentSymbol`, `workspace/symbol`, `rename`), diekspos lewat 7 tool di [src/tools/lsp.ts](file:///d:/Github/minicode/src/tools/lsp.ts) dan disembunyikan saat `cfg.lspServers` kosong oleh `computeUnavailableWireTools` di [src/app/tool-layer.ts](file:///d:/Github/minicode/src/app/tool-layer.ts#L46-L56).
3. **Verifikasi Otomatis Pasca-Edit:** `appendLspDiagnostics()` di [src/policy/verifier.ts](file:///d:/Github/minicode/src/policy/verifier.ts#L280-L295) otomatis dijalankan setelah `edit` / `apply_patch` ([commitSafeTextEdit](file:///d:/Github/minicode/src/tools/context.ts#L85-L95)), `write_file` ([src/tools/write_file.ts](file:///d:/Github/minicode/src/tools/write_file.ts#L45)), dan `move_file` ([src/tools/move_file.ts](file:///d:/Github/minicode/src/tools/move_file.ts#L79)).
4. **Pencarian Simbol & Berkas Tanpa LSP:** [src/tools/grep.ts](file:///d:/Github/minicode/src/tools/grep.ts) (prioritas `rg`, fallback walker JS) dan [src/tools/glob.ts](file:///d:/Github/minicode/src/tools/glob.ts).
5. **Kontras Positif — Grafik Dependensi Tugas (`TaskGraph`):** [src/task/graph.ts](file:///d:/Github/minicode/src/task/graph.ts) sudah mengimplementasikan graf DAG murni dengan analisis relasi & deteksi siklus untuk dependensi *antar-tugas* (`dependsOn`), membuktikan tim memahami disiplin graf — namun pola ini belum diterapkan pada *dependensi kode/modul*.

### 2.2 Benchmark Empiris pada Repositori `d:\Github\minicode`

Diukur langsung melalui skrip scratch Bun tanpa memodifikasi kode produksi:

- **Total berkas terlacak Git:** `1.021` berkas (`901` cocok dengan 17 ekstensi `SOURCE_EXTS`: `bench: 6`, `cli: 31`, `experiments: 1`, `scripts: 22`, `src: 258`, `test: 565`, `vendor: 18`).
- **60 berkas pertama hasil `.slice(0, 60)` (`LIMITS.REPOMAP_MAX_FILES`):**
  - Rentang: `bench/eval-gate.ts` → `scripts/vendor-minicore.ts` (`bench: 6`, `cli: 31`, `experiments: 1`, `scripts: 22`).
  - Jumlah berkas `src/` yang masuk kandidat repo-map: **`0 / 258` (0,0%)**.
- **Keluaran nyata `buildRepoMap("d:/Github/minicode")`:**
  - Waktu eksekusi: **`171,77 ms`**.
  - Panjang teks: **`2.500 / 2.500` char** (`LIMITS.REPOMAP_MAX_CHARS`).
  - Jumlah berkas yang benar-benar termuat di output: **`11` dari `901` (`1,2%`)** — 10 berkas `cli/*` + `bench/tasks.ts` (berakhir terpotong di tengah simbol `cli/index.ts`), **`0` berkas `src/`**.
- **Topologi dependensi NYATA `src/ + cli/` (`288` berkas TS terukur):**
  - Total *edge* import lokal teresolusi: **`1.267`** | `#minicore` alias: **`104`** | `node:`/`bun:sqlite`: **`276`** | npm: **`13`** | relatif tak teresolusi: **`8`**.
  - **5 hub arsitektural teratas (in-degree nyata):** [src/constants.ts](file:///d:/Github/minicode/src/constants.ts) (`55` pemakai), [src/ui/render/sanitize.ts](file:///d:/Github/minicode/src/ui/render/sanitize.ts) (`52`), [src/ui/render/theme.ts](file:///d:/Github/minicode/src/ui/render/theme.ts) (`46`), [src/policy/scrub.ts](file:///d:/Github/minicode/src/policy/scrub.ts) (`45`), [src/ui/i18n/locale.ts](file:///d:/Github/minicode/src/ui/i18n/locale.ts) (`39`). **Semuanya absen total dari repo-map MiniCode.**
  - **5 orchestrator *fan-out* teratas (out-degree nyata):** [cli/setup.ts](file:///d:/Github/minicode/cli/setup.ts) (`83` import keluar), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts) (`38`), [cli/index.ts](file:///d:/Github/minicode/cli/index.ts) (`31`), [cli/commands.ts](file:///d:/Github/minicode/cli/commands.ts) (`25`), [src/tools/task.ts](file:///d:/Github/minicode/src/tools/task.ts) (`25`).
- **Keluaran nyata `buildSystemPrompt({ cwd, reserveForLiveHints: 1200 })`:**
  - `AGENTS.md` berukur `10.814` char (dipotong `cutMarked(..., 3000)` di [src/policy/context.ts](file:///d:/Github/minicode/src/policy/context.ts#L383)).
  - Panjang total prompt: **`6.800 / 6.800` char** (`SYSTEM_PROMPT_MAX_CHARS = 8.000 - 1.200`).
  - Memuat `# Environment`: **`true`** | Memuat `AGENTS.md` (terpotong di baris ~30): **`true`** | Memuat `# Repo map`: **`false`** | Memuat `# Repo files`: **`false`**.
- **Lingkungan eksekusi & pencarian fallback (`grepTool`):**
  - Binari terdeteksi di PATH mesin ini: `bun` ada, `rust-analyzer` ada; **`rg`**, **`tsc`**, **`typescript-language-server`**, **`pyright-langserver`**, **`gopls`** = `NOT FOUND` (`node_modules/.bin` hanya berisi `tsc.exe` dan `biome.exe`, tidak disentuh MiniCode).
  - Karena `rg` absen, `grepTool` memakai walker JS: pencarian `"buildSystemPrompt"` ke seluruh workspace memakan **`1.839,09 ms`** (29 baris), dan kueri terarah `path: "src"` memakan **`439,32 ms`**.

---

## 3. Apa yang Sudah Kuat (Wajib Dipertahankan)

- **Pertahanan keamanan & provenance:** Cache repo-map disimpan di `~/.minicode/repomap-<sha256>.json` menggunakan signature isi SHA-256 (`signatureFromContents`), bukan di `.minicode/repomap.json` repo yang bisa diracuni; memakai `GIT_SAFE_BASE`, `resolveTrustedExecutable`, dan penolakan symlink di luar root ([src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts#L317-L496)).
- **Batas waktu ketat saat startup TUI:** Timeout `250 ms` pada `spawn("git", ...)` (`stdio: ["ignore", "pipe", "ignore"]`) dan `400 ms` pada `walkForFiles()` mencegah startup TUI membeku seperti insiden `execFile` 1,1 detik ([src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts#L340-L437)).
- **Disiplin anggaran paket (`tree-sitter`):** Penghapusan `tree-sitter` WASM (~1,4 MB/bahasa) adalah keputusan teknik yang sadar dan terdokumentasi di [src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts#L180-L207) demi menjaga `gate:pack` tetap di bawah `5000 KiB`.
- **Siklus hidup LSP & rollback `lsp_rename`:** [LspConnection](file:///d:/Github/minicode/src/lsp/client.ts#L217-L654) memiliki anti-*double-spawn*, batas frame, supervisi child & `taskkill /T /F` di Windows, LRU 64 dokumen, `reopenDocuments()` dengan versi + teks terakhir pasca-restart, serta validasi seluruh edit + backup rollback di [lspRenameTool](file:///d:/Github/minicode/src/tools/lsp.ts#L395-L555).

---

## 4. Kritik Tajam: 8 Celah & Blind Spot Terverifikasi

### K1 (Kritis) — `.slice(0, 60)` Alfabetis Menghapus `src/` 100% dan Melumpuhkan Invalidasi Cache
Di [gitListFiles](file:///d:/Github/minicode/src/repo/repomap.ts#L422-L427), hasil `git ls-files` langsung dipotong `.slice(0, limit)` (`limit = 60` dari [LIMITS.REPOMAP_MAX_FILES](file:///d:/Github/minicode/src/constants.ts#L341)) **sebelum** `rankByImport()` maupun pemetaan direktori inti berjalan. Di repo apa pun yang memiliki ≥ 60 file sumber di direktori sebelum `src/` secara leksikografis (`app/`, `bench/`, `cli/`, `docs/`, `packages/`, `scripts/`), **seluruh `src/` tak pernah terbaca sama sekali**.  
Dampak lanjutannya di [quickStamp](file:///d:/Github/minicode/src/repo/repomap.ts#L559-L579) dan [loadRepoMap](file:///d:/Github/minicode/src/repo/repomap.ts#L596-L600): `quickStamp` hanya men-*stat* root `cwd` + `files.slice(0, 16)` dan `signatureFromContents` hanya meng-hash `files.slice(0, 80)`. Akibatnya, mengubah file di `src/` tidak memicu invalidasi memori maupun disk cache.

### K2 (Kritis) — `# Repo map (symbols)` Selalu Terbuang oleh `cutMarked` di Repositori Nyata
Di [buildSystemPrompt](file:///d:/Github/minicode/src/policy/context.ts#L356-L459), urutan blok adalah: instruksi inti → `# Environment` → `MEMORY` (maks `4.000`) → `AGENTS.md` (maks `3.000`) → steering (`2.000`) → **# Repo map (symbols)** di paling bawah → `cutMarked(full, budget)` (`8.000 - 1.200 = 6.800` char).  
Di `d:\Github\minicode`, prompt sudah mencapai `6.800` char di tengah `AGENTS.md`, sehingga `# Repo map` terpotong **100% menjadi 0 karakter**. Selain itu, `/init` di [cli/commands.ts](file:///d:/Github/minicode/cli/commands.ts#L845-L855) membekukan output `loadRepoMap()` yang cacat K1 langsung ke `AGENTS.md`.

### K3 (Tinggi) — `rankByImport()` Bukan PageRank & Menghasilkan 528 *False-Positive*
Di [src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts#L262-L294):
1. `IMPORT_SPEC_RE = /(?:import|from|require)\s*["'`]([^"'`]*)["'`]/gi` gagal menangkap `import("...")` dan `require("...")` karena ada tanda kurung `(` — **174 *dynamic import*** di `src/ + cli/` terlewat (termasuk mayoritas pemanggilan lazy di `cli/commands.ts`).
2. `joined.includes(lower)` mencocokkan nama berkas dasar (tanpa folder & ekstensi) secara *substring*. Pada `src/ + cli/` terukur **528 kecocokan palsu**: misalnya specifier `../src/ui/render/sanitize.ts` mengandung `"en"` sehingga mengerek skor `src/ui/i18n/en.ts`; `production-execution.ts` mengerek `cli/commands/exec.ts` (`"exec"`) dan `src/hooks/run.ts` (`"run"`).
3. Terdapat **18 basename bertabrakan** (`client` x3, `store` x3, `config` x2, `index` x2, `router` x2, `sanitize` x2) yang mendapat skor bersamaan tanpa resolusi direktori relatif.
4. Algoritma hanya menghitung 1-hop *in-degree* mentah (`scores + 1`), bukan propagasi PageRank iteratif, serta tidak mengenal *path alias* (`#minicore`: 104 edge), `tsconfig.json#paths`, atau barrel `index.ts`. Akibatnya, *entrypoint* ber-fan-out besar seperti `cli/setup.ts` (`83` import keluar) tidak dianggap penting.

### K4 (Tinggi) — Ekstraksi Simbol Regex Melewatkan Relasi Antar-Berkas & Permukaan Re-Export
`extractSymbols()` hanya mendaftar deklarasi teratas per berkas; tidak ada anotasi `imports:` atau `used-by:` di repo-map, **31 barrel *re-export*** (`export { ... } from` / `export * from`) tidak diuraikan ke simbol yang diekspor ulang, `export const fn = (...) => ...` hanya tertulis `const fn` tanpa tanda tangan, dan metode kelas diabaikan. Jalur LSP ([buildRepoMapLsp](file:///d:/Github/minicode/src/repo/repomap.ts#L500-L530)) pun memotong `.slice(0, 200)` simbol mentah secara acak alih-alih mengurutkan menurut sentralitas graf.

### K5 (Tinggi) — LSP Mati Secara Default, dan Sub-Agent `explore` Terkena Bug Skema Wire
- Konfigurasi LSP murni manual (`minicode config lsp add <ext> --command <cmd>`). Tidak ada *auto-discovery* atau saran cepat bahkan saat compiler lokal (`node_modules/.bin/tsc.exe`) atau server di PATH tepercaya (`rust-analyzer`) tersedia.
- **Bug wire konsistensi:** Pada sesi induk, [cli/setup.ts](file:///d:/Github/minicode/cli/setup.ts#L2149-L2157) membuang 7 tool LSP via `computeUnavailableWireTools()` ketika `cfg.lspServers` kosong. Namun pada sub-agent `delegate_task`, [EXPLORE_TOOL_NAMES](file:///d:/Github/minicode/src/policy/tool-contract.ts#L178-L183) memasukkan 6 tool LSP baca (`allowedInExplore: true`), sementara [src/tools/task.ts](file:///d:/Github/minicode/src/tools/task.ts#L1106-L1150) dan [cli/index.ts](file:///d:/Github/minicode/cli/index.ts#L192-L222) **tidak meneruskan `hiddenWireTools`** ke `createMinicodeSession()`. Akibatnya, sub-agent `explore` tetap melihat 6 skema `lsp_*` di wire meski LSP tidak ada.

### K6 (Sedang-Tinggi) — Celah Kapabilitas & *Race* Diagnostics pada Klien LSP
Saat LSP benar-benar dipakai:
1. **Navigasi dependensi tidak lengkap:** [LspConnection.initialize](file:///d:/Github/minicode/src/lsp/client.ts#L315-L333) tidak mendeklarasikan maupun mengekspor tool untuk `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls` / `outgoingCalls`, `textDocument/implementation`, maupun `textDocument/typeDefinition` — padahal `callHierarchy` jauh lebih presisi daripada `lsp_references` untuk melacak rantai pemanggil (*caller graph*).
2. **Bug `waitForDiagnostics()` mengembalikan diagnostics basi & memperlambat kueri baca:** Di [waitForDiagnostics](file:///d:/Github/minicode/src/lsp/client.ts#L492-L496), jika `this.diagnostics.has(uri)` sudah `true` dari pembacaan sebelumnya, fungsi hanya tidur `100 ms` lalu mengembalikan cache lama tanpa membedakan hasil `publishDiagnostics` sebelum vs sesudah `didChange`! Selain itu, [lspCall](file:///d:/Github/minicode/src/lsp/client.ts#L746-L758) memanggil `waitForDiagnostics()` pada **setiap** kueri termasuk `lsp_definition`, `lsp_hover`, dan `lsp_references`, menambah latensi 100–3.000 ms yang tidak perlu sebelum request LSP dikirim.
3. **`findSymbolPosition()` rapuh:** [src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts#L695-L732) melewati semua baris `import ` (`L718`) sehingga model tidak bisa melacak definisi dari baris import via parameter `symbol`, dan tak membedakan metode dengan nama sama di dua kelas berbeda dalam satu berkas.
4. **`move_file` tidak menyadari pemanggil lintas-berkas:** [src/tools/move_file.ts](file:///d:/Github/minicode/src/tools/move_file.ts#L73-L79) hanya memeriksa diagnostics berkas tujuan sendiri — tidak memberi daftar *broken incoming imports* di berkas pemanggil.
5. **Satu server per ekstensi (`activeServers`):** [src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts#L659-L687) mengikat 1 proses & 1 `rootUri` per ekstensi, menyulitkan monorepo dengan banyak `tsconfig.json` / proyek terpisah.

### K7 (Sedang) — Buta 100% Terhadap Manifest & Ekosistem Paket
Pencarian di `src/` memastikan hanya [detectVerifyCommand](file:///d:/Github/minicode/src/policy/verifier.ts#L238-L250) dan `update-check.ts` yang membaca `package.json` / `tsconfig.json`. Model tidak diberi ringkasan terstruktur tentang:
- `dependencies` / `devDependencies` / `engines` / `workspaces` monorepo (`package.json`),
- peta alias `imports` (`#minicore`) dan `tsconfig.json` `paths` / `references`,
- manifest bahasa lain (`Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`).

### K8 (Sedang) — Beban Eksplorasi Manual Tinggi Tanpa Tool Graf Dependensi
Tanpa `rg` (umum di Windows standar) dan tanpa LSP, satu kueri `grep` memakan `~1,84 dtk` di repo berukuran ~1.000 berkas dan hasilnya bercampur antara komentar, string, deklarasi, serta import. Di [src/policy/context.ts](file:///d:/Github/minicode/src/policy/context.ts#L294), arahan kerja hanya menyebut `locate symbols with glob/grep` tanpa mendorong penelusuran *incoming dependents* sebelum mengubah modul bersama dan tanpa menyebut tool LSP saat tersedia.

---

## 5. Saran Perbaikan Konkret & Berprioritas

Semua saran di bawah menjaga constraint MiniCode (`PACK_SIZE_BUDGET` < 5 MiB, zero runtime npm dependencies, batas lapisan [ui-boundary](file:///d:/Github/minicode/test/ui-boundary.test.ts), dan model trust `allowLocalConfig`).

### Tier 1 — Perbaikan Cepat Berdampak Maksimal (Quick Wins)

1. **Pisahkan *File Discovery* dari *Rendering Cap* & Prioritaskan Kode Produksi** ([src/repo/repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts))  
   - Jangan memotong `.slice(0, 60)` sebelum pemeringkatan. Ambil daftar path `git ls-files` hingga pagu aman pengindeksan (mis. `1.500–2.000` path — string path ringan) atau pisahkan `REPOMAP_INDEX_MAX_FILES` (mis. `500–1000`) dari jumlah file yang dicetak ke prompt.
   - Beri bobot/urutan direktori prioritas (`src/`, `lib/`, `app/`, `packages/`, `cli/` lebih dulu daripada `test/`, `bench/`, `fixtures/`, `scripts/`), dan perbarui `signatureFromContents()` agar meng-hash seluruh berkas indeks (atau stat mtime+size seluruh berkas kandidat di luar cache trust) sehingga edit di `src/` menginvalidasi cache.
2. **Amankan Porsi Repo-Map di `buildSystemPrompt()`** ([src/policy/context.ts](file:///d:/Github/minicode/src/policy/context.ts))  
   - Terapkan alokasi anggaran per bagian (*per-section cap*), bukan membiarkan `MEMORY` (`4.000`) + `AGENTS.md` (`3.000`) menghabiskan seluruh `6.800` char lalu memangkas `# Repo map` ke `0`. Sisakan reservasi eksplisit (mis. min `1.500` char untuk `# Repo map`) bila isi repo-map tidak kosong, atau pisahkan penyeimbangannya.
   - Perbarui juga aturan `# How to work` agar mencantumkan penggunaan `lsp_*` bila aktif dan kewajiban mengecek pemanggil (*dependents*) sebelum mengubah modul inti.
3. **Perbaiki Kueri Edge Import & Sub-Agent Wire Hiding**  
   - Ganti matching substring `joined.includes(lower)` dengan resolusi specifier nyata: tangkap `import("...")` / `require("...")` / `export ... from "..."`, resolusi relatif + `.ts`/`.tsx`/`.js`/`/index.*`, baca `package.json#imports` + `tsconfig.json#paths`, hitung bobot in-degree + out-degree (*hub* & *entrypoint*).
   - Teruskan `hiddenWireTools` ke sesi sub-agent di [cli/index.ts](file:///d:/Github/minicode/cli/index.ts#L192-L222) / [src/tools/task.ts](file:///d:/Github/minicode/src/tools/task.ts#L1106) agar skema `lsp_*` tidak dikirim ke worker saat LSP mati.
4. **Perbaiki *Race* & Latensi `waitForDiagnostics` di Klien LSP** ([src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts))  
   - Simpan nomor generasi/timestamp per `uri` saat `didOpen`/`didChange`; `waitForDiagnostics()` harus menunggu notifikasi baru *setelah* mutasi, bukan langsung keluar setelah `100 ms` karena entry lama ada di `Map`.
   - Pisahkan `lspCallReadOnly()` untuk `definition`/`references`/`hover`/`symbols` agar tidak tertahan `waitForDiagnostics()` sebelum mengirim JSON-RPC read request.

### Tier 2 — Peningkatan Struktural Menengah (ROI Tertinggi)

5. **Gunakan `Bun.Transpiler` Bawaan Runtime untuk Grafik Dependensi 0-Byte**  
   - Di mesin yang sudah mewajibkan Bun (`engines.bun >= 1.1.13`), hasil uji langsung pada 288 berkas `src/ + cli/` menunjukkan `new Bun.Transpiler({ loader: "tsx" }).scan()` berjalan dalam **`131,94 ms`** total (`1.347` import termasuk `103` dynamic import, `1.712` export) dengan **`0 byte` tambahan ke ukuran paket**.  
   - Catatan teknis wajib: gunakan loader `"ts"` untuk `.ts` vs `"tsx"` untuk `.tsx`/`.jsx` (karena mode `"tsx"` salah mem-parse generik `<T>` tanpa koma di 6 berkas `.ts`), tetap sediakan fallback regex untuk bahasa non-JS/TS (Python/Go/Rust) serta `import type` yang terhapus transpiler.
6. **Sediakan Tool Read-Only Grafik Dependensi Lokal (`dep_graph` / `module_deps`)**  
   - Tambahkan satu tool ringan yang menjawab secara deterministik dalam <20–150 ms (tanpa butuh LSP atau 5x `grep`):  
     - `imports` langsung & transitif suatu berkas/direktori (plus paket eksternal vs alias),  
     - **`dependents` (siapa saja yang mengimpor berkas/simbol X)** — sangat krusial sebelum `edit`/`move_file`/`delete_file`,  
     - *entry points* / deteksi siklus modul sederhana (meminjam gaya DAG murni seperti [src/task/graph.ts](file:///d:/Github/minicode/src/task/graph.ts)).
7. **Ringkasan Manifest Proyek (~400–600 char) + Repo-Map Berbasis Arsitektur**  
   - Ekstrak metadata deterministik dari `package.json` (`workspaces`, `imports`, `dependencies` ringkas), `tsconfig.json` (`paths`, `references`), `Cargo.toml`, `go.mod`, atau `pyproject.toml`.
   - Format repo-map agar menonjolkan **Top Architectural Hubs** (file paling banyak dipakai, mis. `constants.ts`, `sanitize.ts`) dan **Top Orchestrators** (`cli/setup.ts`), dilengkapi ringkas `used-by: N` alih-alih daftar simbol mentah dari 11 file alfabetis pertama.
8. **Auto-Discovery LSP Terpercaya & Ekstensi Tool Navigasi**  
   - Saat inisialisasi (dengan pagar trust / prompt opt-in pada binary lokal repo), deteksi server standar di PATH (`typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`) atau sarankan perintah `minicode config lsp add` / preset satu langkah agar fitur LSP benar-benar terpakai pengguna.
   - Tambahkan `lsp_call_hierarchy` (`prepareCallHierarchy` + `incomingCalls`/`outgoingCalls`), `lsp_implementation`, dan `lsp_type_definition` di [src/lsp/client.ts](file:///d:/Github/minicode/src/lsp/client.ts) + [src/tools/lsp.ts](file:///d:/Github/minicode/src/tools/lsp.ts).

### Tier 3 — Evolusi Jangka Panjang (Opsional / Perlu Trade-off)

9. **Fallback Semantik TypeScript via `typescript` Workspace (`allowLocalConfig` gated):** Bila proyek sudah memasang `typescript` di `devDependencies` tetapi belum menginstal `typescript-language-server`, sediakan mode opt-in yang menjalankan helper TypeScript Language Service terisolasi (atau `tsc --noEmit` bertarget berkas terdampak).
10. **Routing LSP Multi-Root untuk Monorepo:** Kunci `activeServers` dengan `(ext, workspacePackageRoot)` berdasarkan `tsconfig.json` / `Cargo.toml` / `go.mod` terdekat, bukan global `.ext` tunggal.
