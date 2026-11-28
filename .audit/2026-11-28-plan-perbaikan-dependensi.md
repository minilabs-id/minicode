# Plan Perbaikan Kemampuan Pemetaan & Pemahaman Dependensi MiniCode

**Tanggal:** 2026-11-28  
**Target Checkout:** `d:\Github\minicode` (`v0.52.1`, working tree kotor pra-sesi + `.audit/2026-11-28-riset-evaluasi-dependensi.md`)  
**Rujukan Bukti:** [`.audit/2026-11-28-riset-evaluasi-dependensi.md`](../.audit/2026-11-28-riset-evaluasi-dependensi.md)  
**Status:** Siap ditinjau pemilik (belum ada berkas `src/`, `cli/`, `test/`, `package.json`, atau `scripts/` yang diubah)

---

## 0. Prinsip Kerja & Keputusan Pemilik (Gates)

Plan ini disusun agar setiap perubahan tetap **zero external npm dependencies** (`package.json` `dependencies: {}`), mematuhi batas lapisan `test/ui-boundary.test.ts`, tidak menambah `spawn` baru di `src/` di luar kontrak `test/execution-path-inventory.test.ts`, dan tidak menyentuh geometri/komponen UI yang memerlukan izin pemilik.

### 3 Titik Konfirmasi Pemilik Sebelum/Saat Eksekusi

| Gate | Situasi Saat Ini (Terukur) | Opsi Default (Tanpa Ubah Ambang) | Opsi Alternatif (Perlu Izin Pemilik) |
| :--- | :--- | :--- | :--- |
| **G1 — Anggaran System Prompt** (`src/constants.ts`) | Core statis + runtime + skills + `MEMORY` + `AGENTS.md` menyisakan `0` char untuk `# Repo map` di dalam `budget = 6.800` (`SYSTEM_PROMPT_MAX_CHARS = 8_000`, cadangan `1.200`). | **Opsi A (Direkomendasikan lebih dulu):** Pemadatan core statis (`-1.000..1.400` char) + alokasi kuota terjamin per bagian (`AGENTS_MD` ringkas + lantai `# Repo map` `1.200–1.500` char berbasis hub graf), tetap `<= 8.000` (`test/context-audit.test.ts` tetap lulus). | **Opsi B:** Naikkan `SYSTEM_PROMPT_MAX_CHARS` (mis. `10_500–12_000`) + sesuaikan guardrail di `test/context-audit.test.ts` bila ingin mempertahankan `AGENTS.md` `3.000` char + `MEMORY` `4.000` char penuh. |
| **G2 — Anggaran Tarball (`PACK_SIZE_BUDGET_KIB`)** (`scripts/pack-budget.ts`) | Working tree saat ini `npm pack --dry-run --json` mencatat `346` berkas / `5.324` KiB unpacked — sudah **+74 KiB** di atas `PACK_SIZE_BUDGET_KIB = 5250` (`PACK-01`). | Jaga penambahan Wave 1–5 tetap ramping (`~10–15` KiB) + audit/pangkas berkas non-esensial dari `package.json` `files[]` pada Wave 6 agar kembali `< 5250` KiB. | Jika trimming tidak memadai, minta persetujuan pemilik sebelum menaikkan `PACK_SIZE_BUDGET_KIB` di `scripts/pack-budget.ts` + `docs/contributing.md` (`test/audit-fix-deep-audit-docs.test.ts`, `test/pack-integrity.test.ts`). |
| **G3 — Verifikasi Gate Penuh (`bun run gate:fast`)** (`AGENTS.md`) | Gate lokal harian cukup `bun x tsc --noEmit` + `bun test` terarah. | Jalankan `tsc` + test terarah pada setiap wave. | Jalankan `bun run gate:fast` hanya setelah aba-aba pemilik. |

---

## Ringkasan Urutan Wave

```text
Wave 1 (LSP Runtime Bugs & Multi-Root)
  ├──► Wave 2 (Tutup Kebocoran Wire LSP ke Sub-agent, Autonomous Child & MCP Serve)
  └──► Wave 3 (Engine Hybrid `src/repo/dep-graph.ts` + Fix Kelaparan `src/repo/repomap.ts`)
         └──► Wave 4 (Kuota Terjamin `buildSystemPrompt` + Optimasi `grepTool` Fallback)
                └──► Wave 5 (Tool `dep_graph` #42, Lifecycle Hook Move/Delete, `/context` & `doctor`)
                       └──► Wave 6 (Audit Pack Budget `< 5250 KiB`, Sinkronisasi Dokumen & Verifikasi)
```

- **Wave 1** dan **Wave 2** independen dan memberi perbaikan kualitas instan pada sesi LSP/non-LSP tanpa mengubah jumlah tool maupun ukuran system prompt.
- **Wave 3** mengganti fondasi pemetaan repo agar `src/` terindeks menyeluruh sebelum **Wave 4** menyuntikkannya secara terjamin ke prompt dan **Wave 5** mengekspos query graf terarah lewat tool `dep_graph`.

---

## Wave 1 — Perbaikan Stabilitas, Akurasi & Isolasi Runtime LSP

**Tujuan:** Menghilangkan 3 bug runtime LSP yang direproduksi di riset (`waitForDiagnostics` stale cache, `lsp_symbols` line `1:`, blocking `3.177,9 ms` di `lspCall`), menormalisasi pelaporan error agar terdeteksi `no-progress.ts`, dan mendukung monorepo multi-root.

### Perubahan Kode

1. **`src/lsp/client.ts` — Generasi Diagnosa, Content-Hash, Read/Write Split & Multi-Root:**
   - **Perbaikan stale `waitForDiagnostics` (`L436-525`):**
     - Tambahkan pelacakan generasi/versi dokumen per URI (`pendingVersionByUri`, `diagReceivedVersionByUri` atau timestamp/sequence kenaikan setiap `didOpen`/`didChange`).
     - Di `openDocument`: simpan hash/teks terakhir yang dikirim di `opened`; bila teks sama persis, jangan kirim `didChange` maupun naikkan `version` berulang. Saat teks berubah dan `didChange` terkirim, tandai diagnosa URI tersebut **stale** (`staleDiagUris.add(uri)`) atau catat `minSeq` sebelum menunggu.
     - Di `waitForDiagnostics(uri, timeoutMs)`: jangan langsung berhenti setelah `sleep(100)` bila `this.diagnostics.has(uri)` berasal dari versi pra-edit (`staleDiagUris.has(uri)`); tunggu hingga notifikasi `textDocument/publishDiagnostics` baru masuk (`staleDiagUris.delete(uri)`) atau `timeoutMs` habis.
   - **Perbaikan `lsp_symbols` (`L327`):**
     - Aktifkan `hierarchicalDocumentSymbolSupport: true` pada capability `textDocument.documentSymbol` saat `initialize`.
   - **Pisahkan read navigation dari blocking wait (`L734-758`):**
     - Di `lspCall(..., waitDiagsMs = 0)` vs `lspDiagnostics(..., waitDiagsMs = 3000)`: query navigasi (`definition`, `references`, `hover`, `documentSymbol`, `prepareCallHierarchy` opsional) tidak boleh memblokir `3.000 ms` menunggu diagnosa bila server tidak mengembalikan diagnosa secara pasif. Berikan default `waitDiagsMs = 0` untuk operasi read-only navigasi/simbol di `lspCall`.
   - **Tutup/reset dokumen saat file dihapus atau dipindah:**
     - Ekspor helper `closeLspDocument(ext, path, cwd)` (`textDocument/didClose`) + hapus dari `opened` dan `diagnostics` agar tidak meninggalkan diagnosa hantu.
   - **Isolasi multi-root monorepo (`L248`, `L659-688`):**
     - Tambahkan resolver `findProjectRoot(filePath, workspaceRoot)` (naik hingga menemukan `tsconfig.json`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, berhenti di `workspaceRoot` dan tidak pernah keluar root).
     - Ganti kunci `activeServers` dari `ext` menjadi `${ext}\0${projectRoot}`.
     - Pertahankan `childId` tetap `"lsp:" + ext` ketika `projectRoot === workspaceRoot` (menjaga kontrak `test/p13-runtime-supervision.test.ts:762-794`), dan gunakan `"lsp:" + ext + ":" + shortHash(projectRoot)` hanya untuk sub-root berbeda di dalam monorepo.

2. **`src/tools/lsp.ts` — Kompatibilitas `SymbolInformation`/`DocumentSymbol`, Output Terbaca & Error Simetris:**
   - **Dual-format `lspSymbolsTool` (`L296-301`):**
     - Dukung `DocumentSymbol` (`sym.range`, `sym.selectionRange`, rekursi `sym.children` dengan indentasi) **dan** `SymbolInformation` (`sym.location.range`). Jangan lagi jatuh ke fallback `?? 0` yang menghasilkan `1:`.
   - **Normalisasi error ketika LSP belum siap (`L78-112`):**
     - Seragamkan jalur gagal di `resolvePosition`, `lspDiagnosticsTool`, `lspSymbolsTool`, dan `lspWorkspaceSymbolsTool`: jika `getConfiguredExts().length === 0` atau ekstensi file target tidak cocok server manapun (atau `lspWorkspaceSymbols` dengan `0` server), **lempar Error terstruktur** (`throw new Error(...)`) alih-alih mengembalikan string teks sukses, sehingga `no-progress.ts` (`REPEATED_ACTION_ERROR`) selalu menandai kegagalan berulang.
     - *(Pastikan pesan tetap jelas & menyertakan panduan konfigurasi singkat seperti `minicode config lsp add` tanpa membocorkan stack panjang).*
   - **Format posisi ramah-konteks (`formatPos`):**
     - Ubah URI `file://...` menjadi path relatif terhadap `ToolContext.cwd` (jika masih berada di dalam workspace; tetap sanitasi lewat `sanitizeAnsi` sebelum dikembalikan ke model).

### Tes & Verifikasi Wave 1
- Tambah kasus uji pada `test/p13-lsp-production.test.ts` (mock JSON-RPC server):
  1. `didChange` disusul `publishDiagnostics` terlambat (`300 ms`) mengembalikan diagnosa versi terbaru, bukan cache `v1`.
  2. `lsp_symbols` mengembalikan nomor baris benar baik ketika server membalas `SymbolInformation[]` maupun `DocumentSymbol[]` bersarang.
  3. `lsp_definition` / `lsp_references` tidak memblokir `3.000 ms` jika server tidak mengirim diagnosa.
  4. `lsp_references` / `lsp_symbols` pada `0` server maupun ekstensi tak cocok melempar error (`isError=true`), simetris dengan `lsp_diagnostics`.
  5. Dua sub-root (`packages/a/tsconfig.json` & `packages/b/tsconfig.json`) men-spawn dua koneksi LSP terpisah dan menutup bersih lewat `closeAllLsp()`.
- **Perintah cek Wave 1:**
  ```bash
  bun x tsc --noEmit && bun test test/p13-lsp-production.test.ts test/p13-runtime-supervision.test.ts test/p15-phase2-contracts-approval-recovery.test.ts
  ```

---

## Wave 2 — Penutupan Kebocoran Wire Tool LSP (`hiddenWireTools` Konsisten)

**Tujuan:** Menghilangkan kebocoran `7` wire tool `lsp_*` (`995` token utama; `775 / 2.085` = `37,2%` budget tool di sub-agent `explore`) pada sub-agent, autonomous scheduler child, dan MCP server ketika server LSP tidak dikonfigurasi/tersedia.

### Perubahan Kode

1. **`src/tools/task.ts` & `cli/index.ts` — Teruskan `hiddenWireTools` ke `SubAgentSpec`:**
   - Tambahkan field opsional `hiddenWireTools?: ReadonlySet<string>` pada `SubAgentSpec` / `SubAgentGovernance` (`src/tools/task.ts`).
   - **Kunci anti-regresi:** **JANGAN** menghapus nama tool dari `spec.tools`! `test/work-mode-subagent.test.ts:109` dan `test/delegate-audit.test.ts:98` mensyaratkan `spec.tools` tetap memuat seluruh `EXPLORE_TOOL_NAMES`.
   - Sebagai gantinya, di `cli/index.ts:199` (`setSubAgentSessionFactory` memanggil `createMinicodeSession`), teruskan `hiddenWireTools: spec.hiddenWireTools` agar penyaringan terjadi di `visibleWireToolSchemas()` (`src/app/session.ts:1062-1065`), persis sama seperti sesi utama.
   - Pastikan saat `setupToolLayer` atau `cli/setup.ts` memanggil `setSubAgentGovernance(...)` (atau fallback berbasis `computeUnavailableWireTools(cfg, { cwd })` bila `hiddenWireTools` tidak diinjeksi manual), `LSP_WIRE_TOOLS` disembunyikan otomatis ketika LSP tidak aktif/tidak dikonfigurasi.

2. **`cli/setup.ts:4158-4206` — Autonomous Scheduler `sessionFactory`:**
   - Variabel `hiddenWireTools` sudah dihitung di `cli/setup.ts:2149-2157`. Teruskan `hiddenWireTools` tersebut ke pemanggilan `createMinicodeSession(...)` di `cli/setup.ts:4166` (child session mode otonom).

3. **`src/mcp/server.ts:63` & `cli/commands/mcp.ts` — `selectTools` & `serveMcp`:**
   - Tambahkan parameter opsional `hiddenWireTools?: ReadonlySet<string>` pada `selectTools(opts)` / `serveMcp(opts)`.
   - Di `cli/commands/mcp.ts`, muat config + hitung `computeUnavailableWireTools(cfg, { cwd })` sebelum memanggil `serveMcp`, lalu teruskan agar klien MCP tidak menerima 7 skema `lsp_*` mati ketika belum ada konfigurasi LSP.

### Tes & Verifikasi Wave 2
- Tambah tes pada `test/work-mode-subagent.test.ts` (atau `test/audit-fix-deep-audit-app-task.test.ts`) dan `test/mcp-server.test.ts`: membuktikan bahwa saat `hiddenWireTools` berisi `LSP_WIRE_TOOLS`, `spec.tools` masih berisi seluruh `EXPLORE_TOOL_NAMES`, namun `wireTools` / `liveToolSchemas` yang dikirim ke model di sesi anak tidak memuat `lsp_*` (dan `selectTools` menyaringnya di MCP); serta ketika LSP terkonfigurasi, `lsp_*` muncul kembali.
- **Perintah cek Wave 2:**
  ```bash
  bun x tsc --noEmit && bun test test/work-mode-subagent.test.ts test/delegate-audit.test.ts test/p9-admission-boundaries.test.ts test/audit-fix-deep-audit-app-task.test.ts test/audit-fix-wire-contract.test.ts test/mcp-server.test.ts
  ```

---

## Wave 3 — Engine Graf Dependensi Hibrid (`src/repo/dep-graph.ts`) & Perbaikan `src/repo/repomap.ts`

**Tujuan:** Mengatasi kelaparan `0/258` berkas `src/`, menghilangkan `782` false positive `rankByImport`, menangkap `175` dynamic `import()/require()` dan `import type` / `export ... from` (`51` edge `#minicore`), serta menjaga cache tetap instan tanpa subproses baru di `src/`.

### Desain Teknis `src/repo/dep-graph.ts` (Modul Baru di `src/repo/`)

1. **Inventaris Berkas Lengkap Sebelum Ranking (Perbaiki `gitListFiles` & `loadRepoMap`):**
   - Pindahkan / sinkronkan pengambilan daftar file antara `repomap.ts` (`L422-427`, `L622`) dan `dep-graph.ts`:
     - Saat memakai `git`: jalankan `git ls-files --cached --others --exclude-standard` dengan batas aman tinggi (mis. `MAX_INDEX_FILES = 5_000` atau gunakan semua file `SOURCE_EXTS` sebelum ranking; jangan memotong `.slice(0, 60)` atau `.slice(0, 80)` di muka!).
     - Filter setiap kandidat file memakai aturan ignore + **jaminan symlink tidak keluar root** (`test/repomap.test.ts:63`, `test/supply-chain.test.ts:441`).
   - Perbaiki `quickStamp()` (`src/repo/repomap.ts:559`):
     - Selain mtime root & git head/index mtime, ambil sampel mtime terstratifikasi (mis. max `48` file menyebar across bucket/direktori atau mtime `.git/index` + `files.length`), agar perubahan berkas jauh di `src/ui/` tetap membatalkan cache.
     - Pertahankan memo in-process (syarat `test/freeze-regressions.test.ts:116`: panggilan kedua `< 20 ms`) serta persistensi `.minicode/depgraph.json` + `.minicode/repomap.json`.

2. **Ekstraksi Edge Hibrid Tanpa `spawn()` (`src/repo/dep-graph.ts`):**
   - **Jalur TypeScript / JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`):**
     - **Lapis A — Runtime AST via `Bun.Transpiler`:** Gunakan instance per loader `"ts"` vs `"tsx"` (`loader: ext === ".tsx" || ext === ".jsx" ? "tsx" : "ts"` — hasil riset menunjukkan `"tsx"` gagal pada 6 file `.ts` dengan generic `<T>`, sedangkan pemisahan `"ts"`/`"tsx"` sukses `289/289` dalam `211,66 ms`). Panggil `.scan(source)` untuk menangkap `imports` (`import-statement`, `dynamic-import`, `require-call`) dan `exports`. Bungkus guard `typeof Bun !== "undefined" && typeof Bun.Transpiler === "function"` dengan fallback regex bila dijalankan di luar runtime Bun.
     - **Lapis B — Static Type & Re-export Pass:** Karena `Bun.Transpiler.scan()` melucuti `import type`, `export type`, dan sebagian re-export (`26` vs `77` import `#minicore`), tambahkan pass pemindai token/komentar ringan (mengabaikan `//`, `/* ... */`, string/template literal non-import) yang mengekstrak `import type ... from "..."`, `export type ... from "..."`, `export { ... } from "..."`, dan `export * from "..."`. Tandai setiap edge dengan metadata `{ kind: "value" | "type" | "dynamic" | "reexport" }`.
   - **Jalur Polyglot Statis (`.py`, `.go`, `.rs`, `.java`, `.c`, `.h`, `.cpp`, `.hpp`, `.cs`, `.rb`, `.php`):**
     - Ekstraktor regex per bahasa (strip komentar terlebih dahulu) untuk `import`/`from ... import` (Python termasuk relative dot `.a`/`..b`), `import` (Go), `mod`/`use` (Rust), `import` (Java/C#), `#include "..."` (C/C++), `require`/`require_relative` (Ruby), `require`/`use` (PHP).

3. **Resolusi Modul Presisi (Pengganti `rankByImport` Substring):**
   - Baca sekali per build graf (aman, murni `JSON.parse`/`stripJsonComments`, tanpa eksekusi):
     - `package.json` di root / workspace terdekat (`imports` subpath seperti `#minicore` / `#minicore/*`, `workspaces`).
     - `tsconfig.json` / `jsconfig.json` (`compilerOptions.baseUrl`, `compilerOptions.paths`, `extends` dasar).
   - Selesaikan specifier relatif (`./`, `../`), path alias `paths`/`#subpath`, normalisasi `.js`→`.ts`/`.tsx` (konvensi TS ESM), serta fallback `index.{ts,tsx,js,jsx}`.
   - Pisahkan hasil menjadi:
     - `edges`: internal resolved edges (`from -> to`, `kind`, `rawSpec`)
     - `externalDeps`: package pihak ketiga / builtin Node/Bun (`node:*`, `bun:*`, dll.)
     - `unresolvedLocal`: specifier relatif/alias yang tidak menemukan berkas target (indikasi potensi broken import)
   - Hitung metrik graf: `inDegree`, `outDegree`, **centrality non-test** (bobot referensi dari `src/`/`cli/`/`app/` lebih tinggi daripada referensi dari `test/` agar `src/` hubs menduduki peringkat teratas alih-alih test helper), serta **Tarjan Strongly Connected Components (SCC)** untuk mendeteksi siklus dependensi.

4. **Integrasi Aditif dengan `src/repo/repomap.ts`:**
   - Ganti `rankByImport` (`L262-294`) untuk membaca indeks/centrality dari `buildDependencyGraph()` (`dep-graph.ts`).
   - Pada `loadRepoMap()` (`L629`): jangan short-circuit penuh ke `buildRepoMapLsp` yang membuang edge impor statis. Gunakan ranking graf statis sebagai kerangka utama + perkaya simbol penting dari LSP bila server sudah hidup (dibatasi timeout singkat `<= 300 ms`).

### Tes & Verifikasi Wave 3
- Buat `test/dep-graph.test.ts` menguji:
  1. Static value import, dynamic `import()`, `require()`, `import type`, `export ... from` (`reexport`).
  2. TS-ESM `.js -> .ts` mapping, `tsconfig.json` `paths`, `package.json` `#imports` (`#minicore/*`), dan resolusi tanpa false positive basename ganda (`config.ts` di dua direktori berbeda).
  3. Deteksi siklus (SCC `A -> B -> C -> A`), `inDegree`/`outDegree`, dan pemeringkatan prioritas non-test atas file hub.
  4. Polyglot dasar (Python relative `from .sub import x`, C `#include "local.h"`).
  5. Keamanan symlink keluar root (diabaikan) & memo/invalidation saat file berubah (`< 20 ms` cache hit).
- **Perintah cek Wave 3:**
  ```bash
  bun x tsc --noEmit && bun test test/dep-graph.test.ts test/repomap.test.ts test/freeze-regressions.test.ts test/repo-git-trust.test.ts test/supply-chain.test.ts test/execution-path-inventory.test.ts test/ui-boundary.test.ts
  ```

---

## Wave 4 — Membuka Deadlock System Prompt (`buildSystemPrompt`) & Percepatan `grepTool`

**Tujuan:** Memastikan `# Repo map` (ringkasan kluster & hub graf) benar-benar muncul dalam system prompt pada proyek sebesar MiniCode (termasuk mode RAG & sub-agent), sekaligus memangkas latensi JS fallback `grepTool` dari `~1,41 detik` dan mengatasi bias urutan alfabetis `CHANGELOG.md`/`test/`.

### Perubahan Kode

1. **`src/policy/context.ts` — Kuota Terjamin Per Bagian & Ringkasan Graf Kompak (Gate G1):**
   - **Pemetaan akar masalah:** Di checkout saat ini, static core = `5.191` char; `budget = 6.800` (`8.000 - 1.200`); `runtimeStateHeader` (`240`) + `skills` (`276`) + `MEMORY` (`559`) = `1.075` char → tersisa `534` char sebelum `AGENTS.md` (`3.000` cap) menghabiskannya dan membuang seluruh `# Repo map`.
   - **Implementasi Opsi A (Default — Budget-Neutral dalam `SYSTEM_PROMPT_MAX_CHARS = 8_000`):**
     - Audit & padatkan prosa berulang pada bagian statis (`# Language`, `# How to work`, `# Communication`, `# Environment`) di `src/policy/context.ts` dengan target menghemat **`~1.000–1.400` char** tanpa mengubah satupun invarian yang dicek oleh `test/audit-fix-communication-prompt.test.ts` dan `test/context-audit.test.ts`.
     - Ganti strategi "gabung dulu baru `cutMarked` di ujung" menjadi **reserved budget per section**:
       - Hitung `remaining = budget - staticCore - runtimeHeader - skillsSection`.
       - Saat repo memiliki konten kode, **kunci lantai terjamin `repoMapBudget = min(LIMITS.REPOMAP_MAX_CHARS, max(1200, floor(remaining * 0.40)))`** (bahkan ketika `AGENTS.md` dan `MEMORY.md` hadir dan mode RAG/sub-agent aktif).
       - Alokasikan sisa budget ke `AGENTS.md` (ringkas hingga `min(LIMITS.AGENTS_MD_MAX_CHARS, agentsBudget)` dengan catatan `[truncated — use read_file on AGENTS.md for full rules]`) dan `MEMORY` (`min(LIMITS.MEMORY_FILE_MAX_CHARS, memoryBudget)`).
     - Format `# Repo map` dalam prompt menggunakan output **kluster/hub graf** dari Wave 3 (misal 15–25 file hub `src/` & `cli/` teratas beserta `inDegree/outDegree` + simbol ekspor utama + ringkasan subdirektori bila ruang mencukupi), sehingga `1.200–1.500` char jauh lebih informatif daripada daftar file mentah.
   - *(Jika pemilik memilih **Opsi B** di Gate G1: naikkan `SYSTEM_PROMPT_MAX_CHARS` dan biarkan `AGENTS_MD_MAX_CHARS = 3_000` + `REPOMAP_MAX_CHARS = 2_500` tanpa kompresi agresif — namun tetap pertahankan reserved slice agar salah satu bagian tidak memakan bagian lain di masa depan).*

2. **`src/tools/grep.ts` & `src/lib/safe-open.ts` — Optimasi JS Fallback `grepTool`:**
   - **Mengurangi 5.02x syscall overhead (`safeOpenRead` 1.150 ms vs 229 ms):**
     - Di `walkGrep` (`src/tools/grep.ts`), pertahankan keamanan symlink/anti-escape secara penuh tanpa memanggil `realpath` direktori induk berulang kali per file:
       - Cache `realpath` per direktori selama satu kali eksekusi `walkGrep` (`Map<string, { ok: boolean; realDir: string }>`).
       - Tambah helper internal tepercaya (hanya untuk walk read-only yang sudah memeriksa `lstat` / `Dirent.isSymbolicLink() === false` dan batas workspace) atau `safeReadGrepCandidate(absPath, root, verifiedDirCache)`: bila entry bukan symlink dan `nlink === 1` setelah `open(..., O_RDONLY | O_NOFOLLOW)` + `fstat`, skip 3x `realpath` redundant yang biasanya dilakukan `safeOpenRead` berulang untuk direktori yang sama. *(Tetap fallback ke `safeOpenRead` penuh bila symlink terdeteksi atau flag mencurigakan).*
   - **Prioritas Urutan Pemindaian & Hint Truncation:**
     - Urutkan file di `walkGrep` agar direktori sumber utama (`src/`, `cli/`, `app/`, `lib/`, `packages/`) dan file root konfigurasi dipindai **lebih dulu** dibanding `test/`, `docs/`, `CHANGELOG.md`, agar batas default `100` match menampilkan call-site produksi sebelum tertimbun changelog & fixture test.
     - Tambahkan informasi jumlah file terlewati & saran filter (`[truncated at N matches across M/${total} files — narrow with path/glob or raise limit]`) saat mencapai limit.
   - **Peningkatan deteksi `ripgrepAvailable()` (Windows-friendly):**
     - Selain `Bun.which("rg")`, cek lokasi instalasi umum `rg.exe` bila tersedia (tanpa mengubah kontrak zero-download atau menambah binary bundel). *Opsional terpisah (hanya jika diizinkan): fast-path `git grep` tidak digunakan sebelum mengecek aturan `test/execution-path-inventory.test.ts`.*

### Tes & Verifikasi Wave 4
- Tambah tes pada `test/context-audit.test.ts`: fixture proyek besar dengan `AGENTS.md` `10 KiB`, `MEMORY.md` `2 KiB`, dan `20+` modul berimpor → memverifikasi output `buildSystemPrompt()` memuat header `# Repo map` serta modul hub `src/` di dalam batas anggaran aktif (`<= SYSTEM_PROMPT_MAX_CHARS`).
- Tambah tes pada `test/grep-security.test.ts` (atau berkas tes baru terpisah): memastikan `walkGrep` menolak file symlink keluar root namun tetap mengurutkan `src/` sebelum `CHANGELOG.md`/`test/` ketika terkena cap limit.
- **Perintah cek Wave 4:**
  ```bash
  bun x tsc --noEmit && bun test test/context-audit.test.ts test/audit-fix-communication-prompt.test.ts test/extreme.test.ts test/repomap.test.ts test/supply-chain.test.ts test/grep-security.test.ts
  ```

---

## Wave 5 — Tool `dep_graph` (#42), Lifecycle Warning & Integrasi Operasional

**Tujuan:** Memberi model & sub-agent (`explore`, `autonomous`, `readonly`, `discuss`, `execute`) kemampuan query graf dependensi struktural 1-panggilan, menambahkan jaring pengaman dependensi pada `move_file`/`delete_file`, dan menampilkan diagnostik keterbacaan di `/context` dan `doctor`.

### Perubahan Kode

1. **Tool Baru `dep_graph` (`src/tools/dep_graph.ts`):**
   - **Nama & Deskripsi:** `name: "dep_graph"`.
   - **Argumen:**
     - `action: "summary" | "file" | "impact" | "cycles"` (default `"summary"` bila `path` kosong, `"file"` bila `path` diisi)
     - `path?: string` (wajib untuk `"file"` / `"impact"`; mendukung path file atau prefix direktori untuk `"summary"`)
     - `depth?: number` (default `2`, dibatasi `1..5` untuk traversal `"impact"`)
     - `includeTests?: boolean` (default `false` untuk `"summary"`/`"cycles"`, `true` untuk `"impact"` terpisah antara produksi vs test)
     - `cwd?: string`
   - **Output Ringkas & Tersegmentasi:**
     - `"summary"`: total node/edge/eksternal/siklus, top hub (`importedBy`), distribusi kluster direktori tingkat-1/2.
     - `"file"`: daftar `imports` (beserta `value`/`type`/`dynamic`/`reexport`), daftar `importedBy`, daftar `externalDeps`, dan simbol ekspor.
     - `"impact"`: BFS reverse-dependents hingga `depth` dipisahkan menjadi `productionDependents` dan `testDependents` (penting sebelum refactoring/edit besar).
     - `"cycles"`: SCC bermuatan `>= 2` node beserta rantai siklus singkatnya.
   - **Keamanan & Sanitasi:**
     - Ambil base directory dari `ctx.cwd` (bukan `process.cwd()`).
     - Validasi `path` dengan `isRealPathOutsideRoot` / `resolveWorkspacePath` (tolak traversal & symlink keluar root) dan lewatkan semua nama file/specifier tak terpercaya lewat `sanitizeAnsi`.

2. **Registrasi & Kontrak Tool di Seluruh Pipeline (`41 → 42` Tools):**
   - `src/tools/index.ts`: ekspor dan masukkan `depGraphTool` ke `allTools`.
   - `src/policy/tool-contract.ts`: daftarkan via helper `pr("dep_graph", { category: "search", argKeys: ["action", "path", "depth", "includeTests", "cwd"], jailTarget: "lsp-file" })` (atau perbarui `permission.ts` agar `LSP_FILE_JAIL_TOOL_NAMES` + `CWD_JAIL_TOOL_NAMES` mencakup `dep_graph` sesuai konvensi `audit-fix-governance.test.ts:183-206`!).
     - Catatan teknis: `FILE_JAIL_TOOL_NAMES` di `src/policy/permission.ts:1391-1406` menolak jika `args.path` kosong (`if (!p) return "deny"`), sedangkan `dep_graph` dengan `action: "summary"` / `"cycles"` tidak wajib mengirim `path`. Maka `jailTarget: "lsp-file"` (`L1408-1414`, mengecek `path` + `isSensitive` + `isRealPathOutsideRoot` **bila `path` diisi**, sekaligus `CWD_JAIL_TOOL_NAMES` atau pemeriksaan `cwdArg` untuk `cwd`) adalah pilihan yang tepat secara semantik dan aman secara fail-closed!
   - `src/task/autonomous-policy.ts`: tambahkan `"dep_graph"` ke `TOOL_CAPABILITIES` (`read-only`, `allowedInAutonomous: true`).
   - `src/policy/compaction.ts` (`L90-101`): tambahkan `"dep_graph"` ke `FACT_TOOLS`.
   - `src/policy/microcompact.ts`: tambahkan `"dep_graph"` ke himpunan tool baca yang aman diringkas setelah `keepRecent = 5`.
   - **Labeling & i18n (non-layout):**
     - `src/ui/render/tool-label.ts`: tambah `"dep_graph": "activity.tool.depGraph"` di `TOOL_LABEL_KEYS`.
     - `src/ui/i18n/en.ts`: `"activity.tool.depGraph": "map dependencies"`.
     - `src/ui/i18n/id.ts`: `"activity.tool.depGraph": "petakan dependensi"`.
     - `src/presentation/label.ts`: pastikan `targetOf` mengekstrak `path` / `action` untuk label aktivitas singkat.

3. **Jaring Pengaman Refactoring di Tool Mutasi File (`src/tools/move_file.ts`, `src/tools/delete_file.ts`):**
   - Di `move_file.ts`: setelah pemindahan berhasil, panggil `closeLspDocument` pada path sumber lama (`src/lsp/client.ts`), lalu tambahkan catatan graf non-blocking: bila berkas sumber sebelumnya diimpor oleh berkas lain di workspace (dari cache graf atau refresh cepat), lampirkan ringkasan `[dep-graph] N files still import old path ...` bersama output `appendLspDiagnostics`.
   - Di `delete_file.ts`: sebelum/sesudah soft-delete ke `.trash/`, jalankan lookup cepat `importedBy` (jika cache graf ada atau build ringan tersedia dalam budget singkat `<= 150 ms`) + `closeLspDocument` dan tampilkan peringatan bila masih ada importer aktif.

4. **Integrasi Diagnostik CLI (`/context`, `doctor`):**
   - `cli/context-command.ts` (`/context`): tampilkan baris info cakupan repo-map & graf dependensi (jumlah berkas terindeks, edge internal, apakah bagian `# Repo map` masuk penuh atau terpotong oleh anggaran prompt).
   - `cli/commands/doctor.ts`: tambah seksi status LSP yang ringkas pada `DoctorReport` (daftar server dari config, apakah command/binary ditemukan via `Bun.which`, sehingga user tahu apakah analisis semantik aktif atau tidak).

### Daftar Tes Hard-Pinned yang Harus Diperbarui Bersamaan (`41 → 42`, `EXPLORE 16 → 17`, `LOCAL_READONLY 16 → 17`, `READONLY 18 → 19`, `DISCUSS 21 → 22`)

Setiap item di bawah terverifikasi mematok jumlah/set tool lama dan wajib disinkronkan dalam Wave 5:
1. `docs/tools.md` — tambah entri tabel `dep_graph` (`test/audit-fix-deep-audit-docs.test.ts:43` memeriksa tepat 41 → 42 baris tool).
2. `test/audit-fix-deep-audit-docs.test.ts` (`L43`)
3. `test/audit-fix-new-tools-and-wire.test.ts` (`L70`)
4. `test/audit-fix-wire-contract.test.ts` (`L76`)
5. `test/journal.test.ts` (`L108`)
6. `test/p22-phase10-holistic-release-gate.test.ts` (`L142`)
7. `test/permission-matrix.test.ts` (`L95-118`, `ARGS`, `NAMES`, `expected`)
8. `test/work-mode-tool-visibility.test.ts` (`L46-57`, `L98`, `L139`)
9. `test/work-mode-contract.test.ts` (`L265`)
10. `test/delegate-audit.test.ts` (`L98-99`)
11. `test/p15-phase2-contracts-approval-recovery.test.ts` (`L159`, `L188`)
12. `test/audit-fix-governance.test.ts` (`L183-206` jika menyentuh `FILE_JAIL_TOOL_NAMES` / `CWD_JAIL_TOOL_NAMES`)
13. `test/tool-label.test.ts` (tambah kasus `dep_graph` untuk `en`/`id` & batas 40 kolom)

- **Perintah cek Wave 5:**
  ```bash
  bun x tsc --noEmit && bun test test/dep-graph.test.ts test/tool-label.test.ts test/permission-matrix.test.ts test/audit-fix-new-tools-and-wire.test.ts test/audit-fix-wire-contract.test.ts test/work-mode-tool-visibility.test.ts test/work-mode-contract.test.ts test/delegate-audit.test.ts test/p15-phase2-contracts-approval-recovery.test.ts test/audit-fix-governance.test.ts test/audit-fix-deep-audit-docs.test.ts test/p22-phase10-holistic-release-gate.test.ts test/journal.test.ts test/doctor.test.ts test/ui-boundary.test.ts
  ```

---

## Wave 6 — Pengendalian Pack Budget, Dokumentasi & Kesiapan Gate

**Tujuan:** Menutup selisih tarball (`5.324 KiB` vs `5250 KiB`), menyinkronkan dokumentasi arsitektur/tool/LSP, dan menyiapkan verifikasi bersih jika pemilik meminta gate penuh.

### Langkah Eksekusi
1. **Audit Tarball (`Gate G2`):**
   - Jalankan `npm pack --dry-run --json` untuk melihat kontributor terbesar di `346` berkas tarball (catatan: sudah `+74 KiB` pra-Wave 1).
   - Evaluasi apakah berkas non-runtime di dalam `package.json` `files[]` / `scripts/pack-budget.ts` bisa dipangkas sehingga tetap `< 5250 KiB` setelah penambahan `src/repo/dep-graph.ts` dan `src/tools/dep_graph.ts`.
   - Bila total minimal runtime + docs tetap melampaui `5250 KiB`, ajukan angka baru + rincian ukuran ke pemilik untuk persetujuan sebelum mengubah `PACK_SIZE_BUDGET_KIB` (`scripts/pack-budget.ts`) & `docs/contributing.md`.
2. **Pembaruan Dokumentasi Inti:**
   - `docs/architecture.md`: catat modul baru `src/repo/dep-graph.ts` dan `src/tools/dep_graph.ts` sesuai aturan boundary.
   - `docs/tools.md`: dokumentasikan `dep_graph` + perilaku baru `move_file`/`delete_file` & `lsp_*`.
   - `docs/mcp-lsp.md`: dokumentasikan isolasi multi-root monorepo LSP, `lsp_symbols` hierarkis, serta pemfilteran wire saat tidak dikonfigurasi.
3. **Final Check (Gate G3 — Hanya Atas Aba-Aba Pemilik):**
   - Minimum lokal sebelum rilis (`AGENTS.md`):
     ```bash
     bun x tsc --noEmit && bun run lint && bun test && bun run gate:coverage && bun run gate:pack
     ```
   - Gate penuh (`bun run gate:fast`) hanya dijalankan apabila pemilik meminta eksekusi gate/rilis.

---

## Ringkasan Risiko & Mitigasi Utama

| Risiko | Dampak | Mitigasi dalam Plan |
| :--- | :--- | :--- |
| Regresi test jumlah/set tool (`41`, `EXPLORE=16`, `LOCAL_READONLY=16`, `READONLY=18`, `DISCUSS=21`) | Banyak test kontrak gagal saat Wave 5 | Pembaruan serempak seluruh 12 berkas test kontrak + `docs/tools.md` hanya di Wave 5 (Wave 1–4 nol perubahan jumlah tool). |
| Pelanggaran test sub-agent `spec.tools` (`work-mode-subagent.test.ts:109`) | Kegagalan tes delegate/work-mode saat Wave 2 | Jangan ubah `spec.tools`; sembunyikan skema di `visibleWireToolSchemas` melalui `hiddenWireTools`. |
| Pemblokiran startup / cache miss `loadRepoMap` (`test/freeze-regressions.test.ts:116`) | Regresi performa startup & flaky timeout | Memo in-process tetap dipertahankan (`< 20 ms`), cold build `dep-graph` on-demand atau ber-cap waktu, dan tanpa spawn proses baru selain `git ls-files` eksisting. |
| Kegagalan `gate:pack` (`> 5250 KiB`) | Build/pack gate merah | Lacak ukuran tiap file baru di Wave 6 dan selesaikan lewat trimming atau persetujuan resmi Gate G2 atas `PACK_SIZE_BUDGET_KIB`. |
| Kehilangan edge `import type` oleh `Bun.Transpiler.scan` | Edge arsitektur / lapisan tipe TS hilang dari graf | Komposisi parser hibrid: `Bun.Transpiler.scan` untuk runtime/dynamic + pass komentar/token untuk `import type`/`export ... from`. |
