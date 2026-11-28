# Riset Mendalam & Evaluasi Kemampuan Pemahaman Dependensi MiniCode

**Tanggal:** 2026-11-28  
**Checkout:** `v0.52.1` ([package.json](file:///d:/Github/minicode/package.json#L1-L89))  
**Metodologi:** Inspeksi kode sumber lintas lapisan, reproduksi langsung perilaku runtime melalui mock JSON-RPC LSP, profiling syscall fallback pencarian, serta verifikasi kontrak test dan gate di repositori `d:\Github\minicode` (read-only terhadap kode produksi).

---

## 1. Ringkasan Temuan Baru Hasil Riset Lanjutan

Riset lanjutan mengungkap lima akar masalah struktural yang memperjelas dan memperluas temuan audit awal:

1. **Kebuntuan anggaran system prompt (`5.191 / 6.800` char habis oleh blok inti):** Di luar teks repo apa pun (direktori kosong), [buildSystemPrompt](file:///d:/Github/minicode/src/policy/context.ts#L257-L460) sudah memakai **`5.191` char** untuk instruksi inti (`# Language`, `# How to work`, `# Communication`, `# Environment`, DATA fence). Dengan cadangan hint live `1.200` char ([session.ts](file:///d:/Github/minicode/src/app/session.ts#L599)) dari pagu `8.000` char ([constants.ts](file:///d:/Github/minicode/src/constants.ts#L73)), sisa anggaran untuk seluruh konteks dinamis (`runtimeStateHeader` + `skills` + RAG + `MEMORY` + `AGENTS.md` + `# Repo map`) hanya **`1.609` char**. Pada sesi nyata dengan `runtimeStateHeader` (`240` char), pemotongan terjadi tepat di **baris 15 `AGENTS.md`** — membuang ~85% `AGENTS.md` dan **100% `# Repo map`**.
2. **Tiga bug runtime terverifikasi pada klien & tool LSP (reproduksi end-to-end):**
   - **Race diagnostics basi:** Pada edit kedua (`didChange`), [waitForDiagnostics](file:///d:/Github/minicode/src/lsp/client.ts#L492-L525) mendapati `this.diagnostics.has(uri) === true`, tidur `100,8 ms`, lalu mengembalikan `["v1-error"]` lama sebelum server mengirim `["v2-updated-error"]` pada `300 ms`. Ini memengaruhi [appendLspDiagnostics](file:///d:/Github/minicode/src/policy/verifier.ts#L280-L297) dan `lsp_diagnostics`.
   - **Bug nomor baris `lsp_symbols`:** [LspConnection.initialize](file:///d:/Github/minicode/src/lsp/client.ts#L327) menyetel `hierarchicalDocumentSymbolSupport: false` (meminta format `SymbolInformation[]` yang menyimpan lokasi di `sym.location.range`), tetapi [lspSymbolsTool](file:///d:/Github/minicode/src/tools/lsp.ts#L297-L300) membaca `sym.range?.start?.line`. Hasil reproduksi: `"1: [Function] alpha\n1: [Function] beta"` — seluruh simbol dilaporkan berada di baris `1`.
   - **Latensi paksa `lspCall()` & asimetri kontrak error:** [lspCall](file:///d:/Github/minicode/src/lsp/client.ts#L746-L758) menahan kueri baca (`textDocument/definition` pada server tanpa push diagnostics) selama **`3.177,9 ms`**. Selain itu, saat `0` server LSP aktif, `lsp_diagnostics` melempar error (`isError=true`), sedangkan `lsp_references` mengembalikan string sukses `"(no LSP servers configured...)"` (`isError=false`, lolos dari pelacak error berulang [no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L592)), lalu berubah melempar error begitu ada server untuk ekstensi lain.
3. **Kebocoran skema wire LSP bernilai `37,2%` dari anggaran tool `explore`:** Sesi induk menyembunyikan 7 tool `lsp_*` (`995` token) lewat [computeUnavailableWireTools](file:///d:/Github/minicode/src/app/tool-layer.ts#L46-L56), tetapi sub-agen `delegate_task` ([cli/index.ts](file:///d:/Github/minicode/cli/index.ts#L199-L222)), eksekutor otonom ([cli/setup.ts](file:///d:/Github/minicode/cli/setup.ts#L4166)), dan `mcp serve` ([src/mcp/server.ts](file:///d:/Github/minicode/src/mcp/server.ts#L63-L67), yang tidak pernah memanggil `configureServers()`) tidak meneruskan `hiddenWireTools`. Akibatnya `6` tool `lsp_*` baca (`775` dari `2.085` token = **`37,2%`**) bocor ke setiap panggilan sub-agen `explore`.
4. **Batasan krusial `Bun.Transpiler.scan()` pada `import type`:** Di `289` berkas `src/+cli/`, `Bun.Transpiler` memindai seluruh repositori dalam `211,66 ms` (`289/289` sukses bila memisahkan loader `"ts"` vs `"tsx"`; loader `"tsx"` gagal pada generik `<T>` di `6` berkas `.ts`). Namun `Bun.Transpiler.scan()` **memangkas `import type`**: ia hanya menangkap **`26` dari `77`** import `#minicore` (`51` edge kontrak tipe hilang). Sementara `8` edge relatif yang tampak tak teresolusi berasal dari `3` berkas working-tree yang belum di-track Git (`liveness-clock.ts`, `autonomous-loop.ts`, `autonomous-build-policy.ts`), membuktikan **`1.209 / 1.209` (100%)** import relatif terlacak mengikuti konvensi ekstensi eksplisit ([test/import-convention.test.ts](file:///d:/Github/minicode/test/import-convention.test.ts#L59-L77)).
5. **Akar lambatnya fallback `grepTool` (`5,02×` overhead syscall) & blind spot retensi konteks:** Pada `988` berkas workspace, `walkWorkspaceFiles` memakan `260,9 ms`, sedangkan `safeReadFile` memakan **`1.150,6 ms`** dibanding `fs.readFile` **`229,0 ms`** karena [safeOpenRead](file:///d:/Github/minicode/src/lib/safe-open.ts#L83-L141) mengulang `3× realpath()` + `stat/fstat` per berkas meski walker sudah memverifikasi `realpath`. Selain itu, pada sesi eksplorasi panjang: `no-progress.ts` memicu `READ_ONLY_THRASHING` pada `30` bacaan berturut di mode `BUILD`, `microcompact.ts` hanya mempertahankan `5` hasil tool terbaru, dan `FACT_TOOLS` di [compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L90-L101) melewatkan semua tool `lsp_*`.

---

## 2. Evaluasi Komprehensif per Dimensi

### 2.1 Peta Repo Statis & Pengiriman Konteks (`repomap.ts` + `context.ts`)
- **Penilaian:** **Gagal di skenario default (1 / 5).**
- **Analisis akar masalah:** Masalah bukan sekadar batas angka `60` file di [constants.ts](file:///d:/Github/minicode/src/constants.ts#L341), melainkan kombinasi berantai:
  1. Pemotongan alfabetis sebelum ranking (`0 / 258` berkas `src/`),
  2. Invalidasi cache yang buta di luar 16 berkas pertama ([quickStamp](file:///d:/Github/minicode/src/repo/repomap.ts#L559-L579)),
  3. Hubungan ranking berbasis substring `joined.includes(lower)` (`782` *false-positive*, `18` tabrakan basename, `175` dynamic import terlewat),
  4. `loadRepoMap()` membuang semua bahasa lain apabila LSP aktif untuk satu ekstensi saja ([repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts#L619-L629)),
  5. `baseSystem` dibekukan sekali saat `createMinicodeSession` ([session.ts](file:///d:/Github/minicode/src/app/session.ts#L594)) dan selalu terpotong di `6.800` char sebelum mencapai `# Repo map`.
- **Implikasi evaluasi:** Memperbesar `REPOMAP_MAX_FILES` atau sekadar mereservasi `1.500` char untuk `# Repo map` di dalam pagu `6.800` tidak cukup — sisa ruang hanya `1.609` char, sehingga mereservasi repo-map tanpa memangkas blok inti atau memindahkannya ke tool *on-demand* akan memangkas habis `AGENTS.md` dan `MEMORY.md`.

### 2.2 Klien, Tool, & Routing LSP (`lsp/client.ts` + `tools/lsp.ts` + `tool-layer.ts`)
- **Penilaian:** **Infrastruktur proses kuat, lapisan protokol & UX lemah (2,5 / 5).**
- **Kekuatan yang wajib dijaga:** `LspFrameAssembler` bebas O(n²) dan berpagu memori, integrasi `ProcessSupervision`, `taskkill /T /F` di Windows, LRU 64 dokumen + `reopenDocuments()` pasca-restart, serta validasi atomik + rollback di `lsp_rename`.
- **Kelemahan terukur:** Tanpa auto-discovery, mayoritas pengguna tidak mengaktifkan LSP (`rust-analyzer` dan `tsc.exe` terpasang lokal tidak terdeteksi oleh `doctor` maupun setup). Ketika diaktifkan, 3 bug di atas (`waitForDiagnostics` basi, `lsp_symbols` line `1`, blokir 3 detik di `lspCall`) ditambah absennya `callHierarchy` / `typeDefinition` / `implementation` serta key tunggal `activeServers` per ekstensi membatasi keandalan pada monorepo.

### 2.3 Pencarian Fallback, Mutasi Lintas-Berkas, & Retensi Konteks
- **Penilaian:** **Aman secara jail, mahal secara latensi & token (2 / 5).**
- Tanpa `rg`, kueri `grep` JS memakan `~1,41 detik` se-workspace, terpotong alfabetis pada `100` match (simbol sentral seperti `scrubSecrets` terhenti di `src/tools/bash.ts` sesudah `CHANGELOG.md` dan `cli/`), serta mencampur komentar/test/string. `move_file` dan `delete_file` tidak melaporkan *incoming dependents* yang putus.

### 2.4 Kendala Gate & Arsitektur untuk Perbaikan (Wajib Dipatuhi)
Berdasarkan verifikasi test kontrak di repositori:
- **Wire contract test ([audit-fix-wire-contract.test.ts](file:///d:/Github/minicode/test/audit-fix-wire-contract.test.ts#L76), [audit-fix-new-tools-and-wire.test.ts](file:///d:/Github/minicode/test/audit-fix-new-tools-and-wire.test.ts#L70)):** Mengunci `expect(allTools).toHaveLength(41)` dan `TOOL_CONTRACTS.length === allTools.length`, prefix `FAMILY_TAGS`, serta deskripsi parameter path yang menyebut `workspace`. Penambahan tool baru harus memperbarui kontrak dan kedua test ini secara sinkron.
- **System prompt cap ([extreme.test.ts](file:///d:/Github/minicode/test/extreme.test.ts#L299-L302), [context-audit.test.ts](file:///d:/Github/minicode/test/context-audit.test.ts#L408-L413), [audit-fix-communication-prompt.test.ts](file:///d:/Github/minicode/test/audit-fix-communication-prompt.test.ts#L77-L105)):** Mengunci total prompt ≤ `8.000` char (termasuk `reserveForLiveHints: 1200`) serta urutan blok inti sebelum blok DATA.
- **Process inventory ([execution-path-inventory.test.ts](file:///d:/Github/minicode/test/execution-path-inventory.test.ts#L380-L430)):** Setiap modul `src/`/`cli/` yang memanggil `spawn`/`execFile`/`fetch` wajib terdaftar di `EXECUTION_PATHS`. Implementasi graf murni dengan `Bun.Transpiler` + `fs` terhindar dari perluasan permukaan proses anak.
- **Pack budget ([pack-budget.ts](file:///d:/Github/minicode/scripts/pack-budget.ts#L188)):** `PACK_SIZE_BUDGET_KIB = 5250` KiB (aktual v0.50.0: `5.013` KiB, margin ~`237` KiB). Solusi zero-dependency (~15–25 KiB) muat dengan aman; WASM `tree-sitter` atau dependensi npm eksternal tetap di luar anggaran.
- **Batas lapisan ([ui-boundary.test.ts](file:///d:/Github/minicode/test/ui-boundary.test.ts)):** Modul graf baru di `src/repo/` atau `src/tools/` tidak boleh mengimpor `src/ui/` atau `cli/`.

---

## 3. Rekomendasi Teruji & Rencana Eksekusi Bertahap

### Gelombang 1 — Perbaikan Bug Nyata & Konsistensi (Risiko Rendah, Dampak Tinggi)
1. **Perbaiki 3 bug klien/tool LSP ([client.ts](file:///d:/Github/minicode/src/lsp/client.ts), [lsp.ts](file:///d:/Github/minicode/src/tools/lsp.ts)):**
   - Tambahkan generation/mutation counter per `uri` pada `didOpen`/`didChange` agar `waitForDiagnostics()` menunggu notifikasi baru setelah mutasi, bukan mengembalikan cache lama sesudah `100 ms`.
   - Pisahkan `lspCallReadOnly()` tanpa `waitForDiagnostics()` agar `definition`/`references`/`hover`/`symbols` tidak terkena delay 3 detik.
   - Perbaiki parsing `lsp_symbols` agar mendukung baik `DocumentSymbol` (`sym.range`) maupun `SymbolInformation` (`sym.location?.range`), dan aktifkan `hierarchicalDocumentSymbolSupport: true`.
   - Seragamkan error saat ekstensi tidak punya server LSP (semua fail-closed konsisten atau sentinel konsisten; selaraskan dengan `computeUnavailableWireTools`).
2. **Tutup kebocoran wire LSP di seluruh jalur sesi:**
   - Teruskan `hiddenWireTools` ke factory sub-agen ([cli/index.ts](file:///d:/Github/minicode/cli/index.ts#L199-L222)), eksekutor otonom ([cli/setup.ts](file:///d:/Github/minicode/cli/setup.ts#L4166)), dan saring `lsp_*` di `mcp serve` ([src/mcp/server.ts](file:///d:/Github/minicode/src/mcp/server.ts#L63)) bila `cfg.lspServers` kosong (hemat **`775` token / `37,2%`** skema `explore`).
3. **Pulihkan cakupan repo-map & validasi cache ([repomap.ts](file:///d:/Github/minicode/src/repo/repomap.ts)):**
   - Naikkan indeks kandidat path (`git ls-files` hingga `1.500–2.000` path sebelum slicing tampilan), prioritaskan direktori produksi (`src/`, `lib/`, `app/`, `packages/`, `cli/`) di atas `test/`/`bench/`/`scripts/`, pakai `.gitignore` di `walkForFiles()`, dan perbaiki `quickStamp()` + `signatureFromContents()` agar memantau direktori/file inti yang terindeks.
   - Gabungkan hasil `buildRepoMapLsp()` dengan fallback regex untuk ekstensi non-LSP agar repo multi-bahasa tidak pincang.

### Gelombang 2 — Graf Dependensi Hibrida & Navigasi Presisi
4. **Pembuat graf modul hibrida (`Bun.Transpiler` + pelengkap `import type`/non-JS):**
   - Gunakan `Bun.Transpiler({ loader: "ts" | "tsx" }).scan()` untuk menangkap static + dynamic imports/exports dengan cepat (`~212 ms` untuk 289 berkas, `0 B` deps), ditambah pass ringan `import type` / `export ... from` agar 51+ edge kontrak tipe tidak hilang, serta resolusi `package.json#imports` dan `tsconfig.json#paths`.
   - Hitung sentralitas nyata (PageRank / in-degree + out-degree) dan tampilkan *Top Architectural Hubs* (`used-by: N`) + *Top Orchestrators* di repo-map.
5. **Atasi kebuntuan anggaran `buildSystemPrompt()` tanpa mematahkan test:**
   - Ringkas blok statis `# How to work` + `# Communication` seperlunya **atau** alokasikan porsi tetap ~`900–1.200` char untuk *Compact Architecture Map* (`used-by` hubs + ringkasan manifest `package.json`/`tsconfig.json`) tepat setelah `# Environment` (sebelum blok `AGENTS.md`/`MEMORY` yang panjang) sambil tetap menjaga total ≤ `6.800` char.
   - Untuk eksplorasi simbol/modul penuh tanpa menekan system prompt, sediakan tool `dep_graph` *on-demand*.
6. **Tool `dep_graph` + integrasi `move_file`/`delete_file` + ekstensi LSP:**
   - Tambah tool `PURE_READ` `dep_graph` (`imports`, `dependents`, `cycles` berbasis gaya DAG [TaskGraph](file:///d:/Github/minicode/src/task/graph.ts), perbarui `TOOL_CONTRACTS` & `41` length guard di test wire-contract).
   - Sertakan peringatan *incoming dependents* pada output `move_file` dan `delete_file`.
   - Tambah `lsp_call_hierarchy`, `lsp_implementation`, `lsp_type_definition`, serta masukkan `lsp_*` ke `FACT_TOOLS` ([compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L90-L101)).

### Gelombang 3 — Performa Fallback, Monorepo, & Ergonomi Operator
7. **Diagnostik & auto-discovery LSP aman di `doctor` / `config lsp`:** Deteksi biner tepercaya di PATH dan tampilkan kesiapan `rg`, server LSP, dan cakupan repo-map di [doctor.ts](file:///d:/Github/minicode/cli/commands/doctor.ts); jaga biner lokal repo (`node_modules/.bin`) tetap opt-in eksplisit.
8. **Multi-root LSP `(ext, packageRoot)`:** Kunci `activeServers` berdasarkan root proyek terdekat (`tsconfig.json`/`Cargo.toml`/`go.mod`) untuk monorepo.
9. **Optimasi fallback `grep` non-`rg` (opsional, butuh kehati-hatian keamanan):** Hindari pengulangan `realpath(root)` berulang di jalur walk `walkGrep` sambil mempertahankan verifikasi `O_NOFOLLOW` + `dev+ino` agar tidak menurunkan jaminan TOCTOU [safe-open.ts](file:///d:/Github/minicode/src/lib/safe-open.ts).
