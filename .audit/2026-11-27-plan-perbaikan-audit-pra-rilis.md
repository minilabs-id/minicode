# Rencana Perbaikan Audit Menyeluruh Pra-Rilis (v0.52.1)

**Tanggal:** 2026-11-27
**Sumber Audit:** [2026-11-27-audit-menyeluruh-pra-rilis.md](2026-11-27-audit-menyeluruh-pra-rilis.md)
**Baseline Kode:** Working tree `v0.52.1` (40 entri modifikasi pra-rilis)
**Batasan Kritis Pra-Eksekusi:**
1. **Headroom Paket Kritis:** `npm pack --dry-run --json` saat ini berukuran **5.335.537 B (`~5210,5 KiB`)** across `343` file terhadap batas ketat `< 5250 KiB` (`scripts/pack-budget.ts:188,201`) — sisa ruang hanya **`~39,5 KiB`** (`src` 4096,9 KiB, `cli` 632,7 KiB, `docs` 358,1 KiB, `vendor` 109,4 KiB). Semua perbaikan kode harus **ringkas, DRY (pakai helper bersama)**, dan hemat komentar agar tidak menabrak `gate:pack` sebelum disetujui pemilik.
2. **Aturan Konfirmasi UI (`AGENTS.md`):** Perubahan pada rekap/gelombang sub-agent (`agentWaves`), parsing `/` & paste composer, pintasan modal approval, dan renderer/ANSI/Markdown wajib **konfirmasi pemilik** sebelum dieksekusi.
3. **Verifikasi Bertahap (`AGENTS.md`):** Setiap gelombang diuji dengan `bun x tsc --noEmit` + tes terarah; full gate (`bun run gate:fast`) hanya dijalankan atas aba-aba pemilik.

---

## Ringkasan Urutan Gelombang Perbaikan

| Gelombang | Fokus | ID Temuan Audit | Perlu Konfirmasi Pemilik? |
|---|---|---|---|
| **Wave 1** | Keamanan, Test Fuzz Buta, & Isolasi Sandbox | `SEC-02`, `SEC-01`, `SEC-03`, `SEC-04` | Ya (opsi strict `--sandbox <typo>`) |
| **Wave 2** | Regresi Worktree Kotor `v0.52.1` & Modal/UI/TUI | `UI-01`, `UI-02`, `UX-01`, `BUDG-01`, `UI-03` | **Ya (wajib per `AGENTS.md`)** |
| **Wave 3** | Pricing Sync, Kernel Loop/Overflow, & Provider Streams | `PROV-01..06`, `CORE-01`, `CORE-02` | Ya (jika menyentuh `vendor/` patch / retry semantics) |
| **Wave 4** | Persistensi SQLite, Transaksi, Jurnal, Checkpoint & Epoch | `STOR-01`, `STOR-02` | Opsional (perilaku error read-only DB) |
| **Wave 5** | CLI, MCP, LSP, Gates, Pack Headroom & Dokumentasi | `CLI-01..02`, `INT-01..02`, `GATE-01` | Ya (`coverage-gate`, `pack-budget`, `publish.yml`) |

---

## Wave 1 — Keamanan, Fuzzer Test & Isolasi Sandbox (`SEC-01` s.d. `SEC-04`)

### 1.1 `SEC-02` — Perbaiki Fuzz Test `bash-guard` (`{ command }` → `{ cmd }`)
- **Berkas:** `test/bash-guard-fast-fuzz.test.ts:63-91`
- **Akar Masalah:** `checkPattern()` memanggil `handler.check({ name: "bash", args: { command: pattern } })`, sedangkan `src/policy/permission.ts:1227,1267,1451` membaca `(args?.cmd as string) ?? ""`. Semua pola dievaluasi sebagai `""` dan lulus semu.
- **Desain Perbaikan:**
  1. Ganti `{ command: pattern }` → `{ cmd: pattern }` pada `test/bash-guard-fast-fuzz.test.ts:70`.
  2. Tambahkan kontrol positif (mis. `ls` / `git status` yang wajib `allow` di allowlist) serta asersi eksplisit bahwa setiap pola pada `PATTERNS` bernilai `true` (`rejected === PATTERNS.length`), menggantikan `expect(rejected).toBeGreaterThan(0)` (`L89`) yang terlalu longgar.
- **Verifikasi:** `bun test test/bash-guard-fast-fuzz.test.ts test/bash-guard-escaping.test.ts test/bash-guard-redirect-escape.test.ts test/bash-fuzz-regression.test.ts`

### 1.2 `SEC-01` — Kunci Keystore Local-Config & Redirect Lintas-Origin/Downgrade Vector Embeddings
- **Berkas:** `src/app/rag-layer.ts:12-26,62-77`, `src/memory/vector.ts:461-502`
- **Pola Repo yang Dipakai Ulang:** `isLocalConfigProvider(p)` dari `src/config.ts:338` (sudah dipakai di `src/providers/build.ts:113-124`).
- **Desain Perbaikan:**
  1. Di `src/app/rag-layer.ts`: ubah `buildEmbeddingCandidates(cfg)` agar membawa metadata `fromLocal: isLocalConfigProvider(p)` (default `false` untuk `envAuth`). Di loop `createRagLayer` (`L65`), jika `apiKey.startsWith("keystore:") && c.fromLocal`, catat peringatan ringkas ke `stderr` dan `continue` tanpa memanggil `getSecret()`.
  2. Di `src/memory/vector.ts:491-502`: catat `initialOrigin` dan `initialProto` sebelum loop `hop`. Saat menerima `3xx`:
     - Jika protokol turun dari `https:` ke `http:`, tolak (`return null`).
     - Jika request membawa `Authorization` atau `x-api-key` dan `nextUrl.origin !== currentUrl.origin`, **tolak redirect** (`return null`) — API embedding tidak seharusnya mengalihkan POST token autentikasi ke origin berbeda.
- **Test Terdampak & Baru:** `test/rag-layer.test.ts`, `test/local-config-optin.test.ts`, `test/persistence-vector.test.ts` (+ tambah kasus uji: local provider `keystore:` ditolak di RAG & redirect lintas-origin/HTTP-downgrade pada `embedTexts` tidak mengirim `Authorization`/`x-api-key`).

### 1.3 `SEC-03` — Masking `.env*` di Monorepo Dalam, Segmen `(cd` / `pushd`, & `--sandbox` Tak Dikenal
- **Berkas:** `src/sandbox/mask.ts:28-29,92`, `src/policy/permission.ts:678-689`, `src/policy/sandbox-policy.ts:84-90`
- **Desain Perbaikan:**
  1. **Masking `.env*` (`src/sandbox/mask.ts`):** Naikkan `MAX_SCAN_DEPTH` dari `3` ke `8` dan `MAX_SCAN_DIRS` dari `500` ke `2000` (dengan `SKIP_DIRS` `.git`, `node_modules`, `.minicode`, `dist`, `build` sudah terlewat, overhead lokal tetap kecil; pertimbangkan memakai `rg --files -g ".env*"` tidak dipakai agar bebas ketergantungan binary). Jika batas tercapai sebelum antrean habis, fail-safe atau beri peringatan diagnostik eksplisit bila sandbox aktif.
  2. **Penjaga `cd`/subshell (`src/policy/permission.ts:670-689`):**
     - Tolak segmen allowlist yang diawali `(` atau `{` (subshell / command group) dengan alasan jelas sebelum evaluasi pola, sehingga `(cd /etc && ...)` tidak pernah lolos melewati `/^cd\b/i`.
     - Tolak verba `pushd` / `popd` / `chdir` / `set-location` / `sl` di jalur allowlist `cd` (`L678`), karena mengubah CWD proses shell tanpa melewati pengecekan jail `cd`.
  3. **`sandbox-policy.ts:84-90` `[Konfirmasi Pemilik]`:** Saat `req` terisi nilai tak dikenal (`--sandbox foo`), set `explicit: true` atau tangani di `sandboxRefusalReason(requested)` agar ditolak sejak awal (fail-closed) alih-alih diam-diam jatuh ke `mode: "none", explicit: false`.
- **Verifikasi:** `bun test test/sandbox.test.ts test/sandbox-failclosed.test.ts test/os-sandbox-abort.test.ts test/restrict-bash.test.ts` + `bun run gate:bash` (hanya jika relevan setelah perbaikan security).

### 1.4 `SEC-04` — Urutan `scrubSecrets` Sebelum `.slice()` & Sinkronisasi Trace Lock
- **Berkas:** `src/telemetry/trace.ts:254-330`, `src/daemon/approvals.ts:395,410`
- **Desain Perbaikan:**
  1. Di `trace.ts:254`: ubah ke `scrubSecrets(trace.prompt).slice(0, 2000)` (untuk input wajar) atau scrub sepotong batas aman yang melebihi panjang pola secret (mis. `scrubSecrets(trace.prompt.slice(0, 2400)).slice(0, 2000)` bila ingin menjaga kompleksitas regex O(1) pada prompt raksasa, asalkan sisa akhir dicek). Untuk argumen persetujuan (`approvals.ts`), scrub sebelum `sanitizeLabel(..., 300)` (`sanitizeLabel(scrubSecrets(rawText), 300)`).
  2. Di `trace.ts`: arahkan `appendFile` dan `purgeSessionTraces` melalui per-path lock `rotationLocks` yang sudah ada agar tidak race dengan rotasi file.
- **Verifikasi:** `bun test test/p13-approvals-roundtrip.test.ts test/audit-fix-approval-hardening.test.ts` (+ tambah uji unit secret tepat di sekitar indeks pemotongan).

---

## Wave 2 — Worktree Kotor `v0.52.1`, UI/TUI & Modal UX (`UI-01`, `UI-02`, `UX-01`, `BUDG-01`, `UI-03`)

> **[WAJIB KONFIRMASI PEMILIK — `AGENTS.md`]:** Wave ini menyentuh baris rekap `✦`, deteksi slash command di composer/transkrip, shortcut modal persetujuan, dan modul render ANSI/Markdown.

### 2.1 `UI-01` — Akuntansi Kegagalan & Deduplikasi pada `agentWaves`
- **Berkas:** `src/ui/tui/transcript.ts:666-688,2766-2768,2953-3048`
- **Invariant Wajib Dijaga:** Sesuai `test/audit-fix-activity-tidy.test.ts:266-318`, jika anak `c2` sudah mencatat kegagalan (`step limit`), kegagalan root `d2` yang menyusul TIDAK boleh dihitung ganda (`1 failed`, bukan `2 failed`).
- **Desain Perbaikan:**
  1. Pada struktur `wave` di `transcript.ts:666`: tambah `failedToolReasons: Map<string, AgentFailureReason>` dan `rootsWithChildFailure: Set<string>`.
  2. Di `startDelegateWave` (`L2988`): hapus kondisi rusak `!wave.agents.has(toolCallId)` — cukup `if (!wave.agents.has(\`pending:${toolCallId}\`) && ...)` atau hanya sisipkan `pending:${toolCallId}` bila `rootIds` baru ditambahkan dan belum ada run anak untuk `toolCallId` tersebut.
  3. Di `aggregateAgent` (`L3011-3034`):
     - Gunakan `toolKey = toolId || \`anon:${rawName}:${activity.target ?? ""}\`` pada `wave.failedToolReasons` agar event terminal ganda untuk `toolCallId` sama tidak menaikkan jumlah kegagalan lagi; catat `parent` ke `wave.rootsWithChildFailure` bila `status !== "completed"`.
     - Jika `activity.supersedes` ada, hapus entri lama dari `wave.failedToolReasons` dan `this.agentFailureById` **terlepas dari** apakah attempt baru `"completed"` atau `"failed"`; bila attempt baru gagal, masukkan alasan baru ke `wave.failedToolReasons`.
     - Hitung map `wave.failures` sebagai proyeksi dari `wave.failedToolReasons.values()` (satu sumber kebenaran, anti drift count).
  4. Di `settleDelegateRoot(toolId, event, activity)` (`L2767,2995`): bila root `delegate_task` berakhir dengan `status !== "completed"`:
     - Hapus `pending:${toolId}` dari `wave.agents` jika tidak ada anak lain; (opsional sesuai konfirmasi: bila memang gagal di admission sebelum anak jalan, tetap pertahankan count `1 sub agent` atau set `wave.failedToolReasons.set(\`root:${toolId}\`, reason)` agar baris atas menampilkan `✦ 1 sub agent · 0 tool · 1 failed (<tag>)`, hanya ketika `!wave.rootsWithChildFailure.has(toolId)`). Panggil `this.renderAgentWave(wave, event.turnId)` agar baris `✦` ikut mutakhir.
- **Verifikasi:** `bun test test/audit-fix-activity-tidy.test.ts test/tui-transcript.test.ts test/presentation-projections.test.ts` (+ skenario baru: root `delegate_task` gagal langsung sebelum tool anak + retry anak gagal 2× pada `supersedes`).

### 2.2 `UI-02` — Bedakan Slash Command vs Paste/Path Berawalan `/` & Seragamkan Parser Command
- **Berkas:** `src/ui/tui/app.ts:1634-1699`, `cli/tui.ts:1916-1935,2380-2426`
- **Desain Perbaikan:**
  1. Pada `app.ts:1634` (`doSubmit`): deteksi apakah input **layak** dianggap slash command menggunakan dua syarat bersama:
     - `displayLine` awal dimulai `/` (`rawLine.trimStart().startsWith("/")`), dan
     - Tidak mengandung newline setelah ekspansi (`!expandedLine.includes("\n")`), serta command name setelah `/` adalah token identifikasi perintah valid (mis. `/^[a-zA-Z0-9_?-]+(?:\s|$)/`, sehingga path seperti `/etc/hosts` atau `/Users/zo/file` yang memuat `/` kedua di segmen pertama TIDAK dianggap slash command? **Catatan konfirmasi:** beberapa slash command tidak punya `/`, mis. `/help`, `/model`, `/resume`, sedangkan `/foo/bar` dengan dua slash atau multiline hampir pasti path/prompt kecuali argumen sesudah spasi, mis. `/review src/a.ts` di mana spasi memisahkan nama command `review`!).
     - Lebih spesifik & aman:
       - Aturan 1 (multi-baris / paste): bila `activePastes.size > 0 && expandedLine.includes("\n")` atau `displayLine` diawali token `{paste ...}`, **perlakukan sebagai prompt biasa** (bukan slash command), sehingga `pushUser(expandedLine)` selalu masuk ke history chat.
       - Aturan 2 (path absolut berawalan `/` seperti `/Users/a/b.ts` atau `/etc/hosts`): bila segmen pertama (sebelum whitespace pertama) mengandung `/` kedua setelah indeks 0 (mis. `/etc/hosts` punya `/` di indeks 4), perlakukan sebagai prompt biasa, bukan slash command.
  2. Ekstrak helper murni kecil `parseSlashCommand(line: string): { name: string; args: string } | null` yang memeriksa aturan satu-baris & memisahkan pada `/\s+/`, lalu pakai **di tiga tempat** (`app.ts:1679`, `cli/tui.ts:1925`, `cli/tui.ts:2390`) — menghilangkan perbedaan `indexOf(" ")` vs `split(/\s+/)` sekaligus memastikan input yang dieksekusi di `submit()` dan di-validasi di `enqueue()` konsisten.
- **Verifikasi:** `bun test test/composer-box-and-paste.test.ts test/composer-wrap.test.ts` (+ uji: paste multi-baris berawalan `/...`, paste path `/etc/hosts`, dan `/help\nfoo` pada `submit`/`enqueue`).

### 2.3 `UX-01` — Hapus Konflik Shortcut `i` pada Modal Persetujuan Indonesia
- **Berkas:** `src/ui/approval/prompt.ts:479-490`, `src/ui/i18n/id.ts:90-92`
- **Desain Perbaikan:** Di `prompt.ts:484`, ubah `{ label: t("appr.deny"), keys: ["n", "i"], value: "deny" }` menjadi `keys: ["n"]` (tombol `"t"` untuk Bahasa Indonesia `"tolak"` sudah ada di `L490`). Tombol `"i"` tidak lagi menolak aksi secara tidak sengaja saat pengguna membaca `"[y] Izinkan sekali"`.
- **Verifikasi:** `bun test test/approval-prompt.test.ts test/approval-tui.test.ts test/approval-integrity.test.ts`.

### 2.4 `BUDG-01` — Perbaiki `inferScope` & Komentar Usang `subagent-budget.ts`
- **Berkas:** `src/policy/subagent-budget.ts:1-46`
- **Desain Perbaikan:**
  1. Perbarui `inferScope` (`L33-46`) agar mengenali frasa cakupan repo tanpa hanya mengandalkan kata literal `repo|project|proyek|codebase` (mis. `/(?:audit\s+menyeluruh|seluruh\s+(?:bagian|modul|sistem|aplikasi|komponen))/`).
  2. Selaraskan komentar `L5-7` bahwa batas dasar kini `24/40/64/100` (bukan lagi catatan usang `(5)`).
- **Verifikasi:** `bun test test/subagent-budget.test.ts test/p9-admission-boundaries.test.ts`.

### 2.5 `UI-03` — Input History Atomik, Incremental Wrap + Paste Tokens, ANSI `:` & Markdown Headings
- **Berkas:** `src/ui/input/input.ts:60-72`, `src/ui/tui/app.ts:2628-2635`, `src/ui/render/theme.ts:700`, `src/ui/render/markdown.ts:24-45,164-170`
- **Desain Perbaikan:**
  1. `input.ts:60-72` (`appendHistory`): gunakan `dirname(file)` alih-alih hardcoded `~/.minicode` saat `mkdir`, tulis lewat file sementara + `rename` atomik (atau `atomicWriteText` bila diperbolehkan oleh batas lapisan `test/ui-boundary.test.ts` — cek batas impor: `src/ui/` DILARANG mengimpor `src/` non-ui! Jadi pakai `writeFile` ke `${file}.${process.pid}.${Date.now()}.tmp` + `rename` langsung di `input.ts`).
  2. `app.ts:2628-2635`: mundurkan guard `if (this.pastedBlocks.size > 0) return null` ke awal `incrementalComposerLayout` (sebelum cabang `appendWordWrapped` `L2629` maupun `shaveWordWrapped` `L2632`) agar placeholder `{paste ...}` selalu melewati `layoutComposer` utuh.
  3. `theme.ts:700`: selaraskan `ANSI_PATTERN` agar menyertakan karakter `:` (subparameter SGR ITU/kitty seperti `\x1b[38:2:...m` dan `\x1b[58:5:...m`) dan byte intermediate `[\x20-\x2f]*` seperti yang sudah ada di `src/ui/render/cells.ts:115-129`.
  4. `markdown.ts:24-45,164-170`: lindungi backtick ganda (```` ``...`` ````), tangani `***bold+italic***` sebelum `**bold**`/`*italic*`, dan pada `paintMarkdownHeading` bungkus tiap segmen non-ANSI atau sisipkan ulang warna heading setelah `\x1b[39m` milik inline code (agar warna heading `H2`/`H4+` tidak mati di tengah kalimat setelah `` `code` ``).
- **Verifikasi:** `bun test test/ui-boundary.test.ts test/ansi-fragmentation.test.ts test/composer-wrap.test.ts test/transcript-incremental.test.ts`.

---

## Wave 3 — Pricing Sync, Kernel Context/Compact, & Provider Adapters (`PROV-01..06`, `CORE-01..02`)

### 3.1 `PROV-01` — Streaming Reader Berbatas Nyata untuk `pricing sync`
- **Berkas:** `src/policy/pricing.ts:105-120,281-315`, `src/constants.ts` (tambah konstanta khusus mis. `PRICING_FETCH_MAX_BYTES: 12 * 1024 * 1024` atau `10 * 1024 * 1024`)
- **Desain Perbaikan:**
  1. Ganti pola `res.text().then(t => t.slice(...))` di `pricing.ts:303-309` dengan pembacaan bertahap `res.body.getReader()` yang menghitung total byte UTF-8 (serupa `readCapped` di `src/mcp/http-transport.ts:390-413`, bisa diekstrak ke helper kecil di `src/lib/` atau lokal bila `<15` baris).
  2. Jika stream melebihi batas (mis. 12 MB), batalkan reader & lempar error ukuran yang jelas alih-alih memotong JSON menjadi invalid.
  3. Gunakan helper strip UTF-8 BOM pada `loadPricingOverlay()` (`L109`).
- **Verifikasi:** `bun test test/phase4-auth-git-pricing.test.ts` (+ test baru payload JSON >2 MB valid berhasil di-parse dan payload >12 MB dibatalkan sebelum OOM).

### 3.2 `CORE-01` — Hapus Eskalasi Ganda Context Window & Perbaiki Reset Episode Recovery
- **Berkas:** `src/app/session.ts:981-1016,1113-1256,1348-1352`, `vendor/minicore/src/core/loop.ts:288-341`
- **Desain Perbaikan:**
  1. Di `src/app/session.ts:1221-1231`: lewati panggilan `escalateContextWindow` ketika `error === clientOverflowErr` (karena `overflow(..., clientGuard=true)` di `L1148`/`L1212` sudah memanggilnya sekali di `L1125`), atau cukup tangani eskalasi/clamp hanya di satu tempat agar **1 kejadian overflow = maksimum 1 anak tangga eskalasi** dan 1 callback `onContextWindowEscalated`.
  2. Di `src/app/session.ts:1348-1352`: reset `activeRecoveryLedger?.resetEpisode()` juga pada `turn:completed` (selain `step:completed`), dan reset per-attempt sukses jika model telah menghasilkan teks (`provider:text`) atau saat berpindah episode recovery baru agar episode turn teks non-tool tidak membawa kuota retry usang.
- **Verifikasi:** `bun test test/context-escalation-session.test.ts test/provider-retry-output.test.ts test/session-audit.test.ts` (+ test regresi: 1 client-guard overflow hanya menaikkan 1 tangga `nextLadderStep` dan 1× `onContextWindowEscalated`).

### 3.3 `CORE-02` — Surrogate Safety di Executor Truncation & `budgetTailPrefix` Saat `microcompact`
- **Berkas:** `vendor/minicore/src/core/executor.ts:151-161`, `cli/setup.ts:3736-3754`
- **Desain Perbaikan:**
  1. Di `vendor/minicore/src/core/executor.ts:151-161`: pakai helper kecil (`safeHead`/`safeTail` ≤10 baris) yang mundur 1 unit bila ujung slice berakhir pada high surrogate (`0xD800..0xDBFF`) dan maju 1 unit bila awal tail slice jatuh pada low surrogate (`0xDC00..0xDFFF`); hitung `tailLen` menggunakan panjang aktual string notice pemotongan agar hasil total benar-benar `<= maxChars`. (Verifikasi parity via `scripts/vendor-minicore.ts --check` bila ada overlay, ingat `vendor/minicore/**` statusnya HOST-EDITABLE sejak `v0.16.0`).
  2. Di `cli/setup.ts:3738-3754`: saat memeriksa `hasBudgetPrefixIntact`, izinkan kecocokan bila elemen pada indeks `0..N-1` memiliki `role`/`toolCallId`/`name` identik atau ditandai ringkas oleh `microcompact` alih-alih memaksa string JSON tool result lama identik byte-per-byte.
- **Verifikasi:** `bun test test/persistence-rewrite.test.ts test/session-fidelity.test.ts test/pack-integrity.test.ts` (+ uji unit emoji 4-byte pada batas `headLen`/`tailLen`).

### 3.4 `PROV-02`, `PROV-03`, `PROV-04`, `PROV-05`, `PROV-06` — Konsolidasi Empat Adapter Provider & Parser SSE
- **Berkas:**
  - `vendor/minicore/src/providers/openai-compat.ts:88-141,180,291-295,498-516`
  - `src/providers/anthropic.ts:83-87,124-127,188-299,336,440-446`
  - `src/providers/responses.ts:285-297,391-434,445,480-488`
  - `src/providers/sse-bounds.ts:62-64,91`
  - `src/providers/effort.ts:27-28`, `src/providers/provision.ts:97-98,227,345-357`, `src/providers/detect.ts:176-179`
- **Desain Perbaikan:**
  1. **`openai-compat.ts` (`PROV-02`):**
     - Tambah parameter `peek?: boolean` di `toMessages`/`takeProviderMeta` — hanya konsumsi & hapus dari `providerMetaByCallId` setelah `!response.ok` fallback selesai (`response.ok === true`), sehingga retry `400` tanpa `stream_options` tetap membawa `extra_content`.
     - Lacak flag `sawDoneOrFinish` di generator `sse()`; bila stream berakhir tanpa `[DONE]` dan tanpa `finish_reason`, lempar `ProviderError("network", "OpenAI-compat stream ended prematurely")` (kecuali memang sudah menerima `[DONE]` di `L503` dan tidak ada partial error). Map `/quota/` ke `"unknown"` (atau `"rate_limit"`? Sesuaikan dengan `responses.ts:288` / `402` handling konsisten); ukur ukuran frame SSE dalam UTF-8 bytes (`Buffer.byteLength`).
  2. **`anthropic.ts` (`PROV-03`):**
     - Tangani `evType === "error"` dalam loop `sseAnthropic`: petakan `overloaded_error`/`api_error` ke `"server"`, `rate_limit_error` ke `"rate_limit"`, `authentication_error`/`permission_error` ke `"auth"`, dan lempar `ProviderError`.
     - Hindari melampirkan `cache_control` atau mendorong `{ type: "text", text: "" }` bila string kosong `""` di `L124-127` & `L336` (skip teks kosong atau beri placeholder hanya jika seluruh blok pesan kosong).
     - Ekstrak `parseRetryAfterMs(raw: string | null): number | undefined` ke `src/providers/sse-bounds.ts` (mendukung angka detik maupun `Date.parse` HTTP-date) dan pakai di `toAnthropicError`.
  3. **`responses.ts` (`PROV-04`):**
     - Jangan masukkan `response.incomplete` ke `isNonDeltaEvent` yang diabaikan; baca `data.response?.incomplete_details?.reason` — bila `"max_output_tokens"` emit warning + `finish: "length"`, selain itu emit `finish: "length"` atau lempar error network sesuai kategori.
     - Jangan fallback `pendingCalls.keys().pop()` secara membabi buta jika `pendingCalls.size > 1` tanpa `item_id` (hanya izinkan fallback ketika `pendingCalls.size === 1`). Bila stream berhenti mendadak sebelum `response.completed`/`response.incomplete`/`[DONE]`, lempar `ProviderError("network", ...)` alih-alih mem-flush panggilan parsial dengan `"stop"`.
  4. **`sse-bounds.ts` (`PROV-05`):**
     - Pada `done` (`L62`), periksa `if (lineBytes !== 0)` untuk mendeteksi frame yang terpotong di tengah baris (bukan `frameBytes !== 0`, yang gagal salah jika koneksi tutup bersih setelah satu `\n` tanpa trailing blank line).
  5. **`effort.ts` + `provision.ts` + `detect.ts` (`PROV-06`):**
     - Di `effort.ts:24`: ambil `const bare = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m` sebelum mengecek family `o1/o3/o4/gpt-5/gpt-6/claude-*`.
     - Di `provision.ts`: impor `parseJsonFile` dari `../config.ts` di `L346`; teruskan semua field kapasitas (`contextWindows`, `contextWindowSources`, `maxOutputTokens`, `maxOutputTokensDefault`, `enablePromptCaching`) di `saveProvider` (`L227`) & `setModelsMetadata`/`sync` (`L355-358`); perbarui `mergeDiscoveredCapacity` (`L97`) agar tetap memproses jika ada `maxOutputTokens` atau `promptCaching` meski `metadata` kosong hanya jika previous ada, dan di `detect.ts:176` sertakan model dengan `capacity.promptCaching !== undefined`.
- **Verifikasi:** `bun test test/providers.test.ts test/provider-audit.test.ts test/provider-sse-bounds.test.ts test/provider-wire-vcr.test.ts test/responses-tools.test.ts test/effort.test.ts test/provision-effort.test.ts test/build-providers.test.ts`

---

## Wave 4 — Persistensi SQLite, Transaksi, Jurnal & Checkpoint (`STOR-01`, `STOR-02`)

### 4.1 `STOR-01` — Reader `{ readonly: true }` + `busy_timeout` & Transaksi `IMMEDIATE`
- **Berkas:**
  - `src/session/persistence.ts:1638-1764`
  - `src/task/store.ts:478,1675`, `src/tools/todo.ts:576`, `src/task/sync.ts:377,404`, `src/daemon/store.ts:53,267`
  - `cli/commands/sessions.ts:97-112`
- **Desain Perbaikan:**
  1. Buat helper internal kecil `openReadOnlySessionDb(p: string): Database` di `persistence.ts` yang membuka `new Database(p, { readonly: true })` dan mengeksekusi `PRAGMA busy_timeout=${LIMITS.SQLITE_BUSY_TIMEOUT_MS}`. Gunakan pada 4 reader (`readSessionMetaRows`, `readSessionInventoryRows`, `readAllPresentationEventsReadOnly`, `readRunRowsReadOnly`), dengan retry singkat saat `SQLITE_BUSY` dan warning eksplisit untuk error non-ENOENT.
  2. Teruskan argument kedua `immediate = true` pada seluruh pemanggil `withTransaction(..., true)` yang melakukan read-then-write (`store.ts:478,1675`, `todo.ts:576`, `sync.ts:377,404`), dan ubah `db.transaction(...)()` menjadi `db.transaction(...).immediate()` di `daemon/store.ts:53,267`.
  3. Di `cli/commands/sessions.ts:97-112`: gunakan `openSessionHandle` (atau buka + `PRAGMA busy_timeout`) dan pindahkan penghapusan file jurnal (`deleteJournalFile`) **setelah** `purgeExpired(db)` berhasil (kumpulkan daftar `stale` sebelum purge atau jalankan query dalam transaksi lalu hapus file jurnalnya pasca-commit).
- **Verifikasi:** `bun test test/phase4a2-taskstore-transaction.test.ts test/p2-daemon.test.ts test/persistence-ttl.test.ts test/session-storage.test.ts test/taskstore.test.ts`.

### 4.2 `STOR-02` — `move_file` di Jurnal, Strict Rollback Undo, & CAS Epoch Anak
- **Berkas:**
  - `src/session/journal.ts:287-290`
  - `src/session/shadow-git.ts:475-490` & `src/session/checkpoint.ts:581-584,714-728`
  - `src/tools/task.ts:938-956,1612-1644`
  - `src/session/persistence.ts:1429` & `src/session/verification.ts:1886`
- **Desain Perbaikan:**
  1. `journal.ts:288`: samakan dengan `permission.ts:1379` — `[pick(a.path ?? a.from), pick(a.destination ?? a.to)].filter(...)`.
  2. `shadow-git.ts:475-490`: pindahkan `if (opts?.strict && skipped.length) throw ...` (atau cek `if (opts && skipped.length) throw`) ke **setelah** loop `toDelete` (`L479-490`), sehingga kegagalan hapus saat undo/rollback selalu melempar. Di `checkpoint.ts:582` (`applyCheckpoint`), teruskan opsi `{ strict: true }` (atau `{ paths, strict: true }`) saat dipanggil untuk rollback/undo.
  3. `tools/task.ts:938-956,1612-1644`: simpan `const childExpectedEpoch = admission.admission.epoch` saat `acquireSessionWriter` (`L938`) — gunakan `childExpectedEpoch` tersebut pada `transitionRun(..., "RUNNING")` dan blok `finally` (`completeRun`/`failRun`/`interruptRun`), serta sertakan pada `interruptRun` di `catch` (`L950`) bila tersedia.
  4. `persistence.ts:1429`: bungkus `JSON.parse(row.before_messages)` dalam `try/catch` (fallback `[]` / record corruption note); `verification.ts:1886`: strip BOM awal sebelum `JSON.parse`.
- **Verifikasi:** `bun test test/journal.test.ts test/checkpoint.test.ts test/checkpoint-lifecycle.test.ts test/session-epoch.test.ts test/p2-taskgraph-epoch.test.ts`.

---

## Wave 5 — CLI, MCP, LSP, Gates & Packaging (`CLI-01..02`, `INT-01..02`, `GATE-01`)

### 5.1 `CLI-01` & `CLI-02` — CLI Flags, Keystore Order, ACP Busy, & Tool Args Guard
- **Berkas:** `cli/commands.ts:382-397`, `cli/commands/config.ts:354-372`, `cli/commands/acp.ts:351-359,580-603`, `src/tools/git.ts:264`, `src/tools/ask_user.ts:67,133`
- **Desain Perbaikan:**
  1. `cli/commands.ts:382-397` (`buildResumeSpawnArgs`): teruskan flag aktif (`--work-mode`, `--model`, `--sandbox`, `--budget`) pada restart pasca auto-update.
  2. `cli/commands/config.ts:354-372`: validasi dan muat `cfg` + cek `entry` **sebelum** memanggil `setSecret(key, secret)` (`L354`) agar tidak menyisakan orphan secret di OS keystore ketika provider ID tidak ditemukan. (Untuk `detect`: tambahkan opsi `--apiKeyEnv` / prompt stdin tanpa melepas kompatibilitas argumen eksisting).
  3. `cli/commands/acp.ts:351-603`: pisahkan flag `turnRunning` (yang mencakup seluruh siklus sampai `persistCurrent()` & cleanup `finally`) dari `aborter`, dan gunakan `turnRunning` untuk guard `prompt`/`busy` saat `stop()` baru saja dipanggil.
  4. `src/tools/git.ts:264`: sanitasi `limit` memakai helper numerik integer `Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 100) : 20`. `src/tools/ask_user.ts:67,133`: pakai helper slice aman surrogate (shared helper kecil di `src/lib/` bersama `CORE-02`).
- **Verifikasi:** `bun test test/cli-config-inprocess.test.ts test/cli-session.test.ts test/acp.test.ts`.

### 5.2 `INT-01` & `INT-02` — MCP Client/HTTP/Server & LSP Client
- **Berkas:** `src/mcp/client.ts:154,172-191,653-656`, `src/mcp/http-transport.ts:328-334,393-406`, `src/mcp/server.ts:582-584,700-705`, `src/lsp/client.ts:275,527-535,564-570`
- **Desain Perbaikan:**
  1. `mcp/client.ts`: strip UTF-8 BOM di `load()`, lakukan read-merge (baca pin disk terbaru di bawah lock ringan / merge non-konflik sebelum menulis `tmp` → `renameSync`) di `persist()` supaya dua sesi Minicode paralel tidak menimpa pin server milik satu sama lain; di `callTool` (`L653-656`), lewatkan pesan error lewat `scrubSecrets(sanitizeIncoming(...))`.
  2. `mcp/http-transport.ts`: gabungkan baris `data:` dalam satu event SSE dengan `"\n"` sesuai spesifikasi SSE (`L333`), dan pada `readCapped` (`L404`) akumulasi `bytes += value.byteLength` alih-alih membandingkan `out.length` terhadap batas byte.
  3. `mcp/server.ts`: masukkan hash argumen (`argsHash`) ke kunci `completedCache` (`L583`), dan pada `onEnd` (`L700-705`) tunggu penyelesaian `inflight` / promise `handleLine` terakhir dengan batas grace pendek sebelum memanggil `done()`.
  4. `lsp/client.ts`: bungkus `for (const msg of this.frames.push(chunk))` di `handleData` (`L565`) dalam `try/catch` (reset frame & `failAll` pada error parsing agar proses utama tidak crash oleh stdout LSP korup); ganti `spawnSync("taskkill", ...)` di Windows (`L527-535`) dengan helper spawn asinkron ber-timeout (atau tunggu child exit bersama `Promise.race`) agar tidak memblokir event loop 2 detik.
- **Verifikasi:** `bun test test/mcp-client-pin-batch.test.ts test/mcp-http.test.ts test/mcp-server.test.ts test/p2-mcp-reliability.test.ts test/p13-lsp-production.test.ts`.

### 5.3 `GATE-01` — Readiness Gate, Evaluasi Budget Paket, & Sinkronisasi Docs
- **Berkas:** `.github/workflows/publish.yml:45-55`, `bench/eval-gate.ts:347-353`, `scripts/coverage-gate.ts:119-142`, `scripts/vendor-minicore.ts:290-313`, `docs/cli.md:56`, `docs/tools.md:100`, `scripts/pack-budget.ts`
- **Desain & Keputusan Owner:**
  1. **Docs & Script (tanpa ubah ambang gate):**
     - Sinkronkan [`docs/cli.md:56`](../docs/cli.md#L56) (`50` → `600` per `LIMITS.SUB_AGENT_MAX_STEPS`) dan [`docs/tools.md:100`](../docs/tools.md#L100) (`16/24/40/64`, fallback `5/15`, tangga `[8..100]` → `24/40/64/100`, `[24,40,64,100,150,250,400,600]`).
     - Perbarui generator `VENDOR.md` di `scripts/vendor-minicore.ts:290-313` agar mencantumkan status *HOST-EDITABLE* `v0.16.0` (tidak menghapus catatan pemilik saat sync).
  2. **Perubahan Gate `[Konfirmasi Pemilik]`:**
     - `bench/eval-gate.ts:347-353`: ubah `<=` menjadi `<` (atau putuskan apakah equality diperbolehkan lalu perbarui docstring `L277-278` & `test/eval-gate.test.ts` agar selaras).
     - `.github/workflows/publish.yml:45-55`: hapus duplikasi `bun test` sebelum `gate:coverage` dan tentukan apakah `publish.yml` menjalankan `bun run gate:fast` penuh sebelum `npm publish`.
     - `scripts/coverage-gate.ts:119-142`: pertimbangkan menambah modul berisiko tinggi (`providers/{anthropic,responses,provision,sse-bounds}.ts`, `daemon/{server,store}.ts`, `task/store.ts`, `mcp/client.ts`, `ui/tui/transcript.ts`) setelah mengukur liputan dasar aktual.
     - **Pack Budget (`5210,5 / 5250 KiB`):** Setelah Wave 1–5 dieksekusi, ukur `npm pack --dry-run --json`. Jika perubahan DRY masih melewati `5250 KiB` (`AGENTS.md` melarang menaikkan budget sepihak), ajukan audit isi `docs/` / pemangkasan komentar usang atau minta persetujuan eksplisit pemilik untuk re-baseline `PACK_SIZE_BUDGET_KIB`.

---

## Keputusan yang Memerlukan Konfirmasi Pemilik Sebelum Eksekusi

1. **Wave 2 (`UI-01`, `UI-02`, `UX-01`, `UI-03` — Kontrak UI per `AGENTS.md`):**
   - Setujui perbaikan akuntansi `agentWaves` (root gagal sebelum anak → tampilkan `1 failed` tanpa menghitung ganda kasus anak yang sudah gagal), pembedaan prompt paste/path `/` vs slash command, pencabutan tombol `i` dari `deny` dialog persetujuan ID, dan penyesuaian ANSI/Markdown heading?
2. **Keamanan & Strict Mode (`SEC-03`):**
   - Apakah `--sandbox <nilai-tak-dikenal>` diubah menjadi penolakan tegas (fail-closed) di `sandboxRefusalReason` / `cli`?
3. **Gate & Budget (`GATE-01`):**
   - Di `bench/eval-gate.ts:347-353`, apakah memilih pengetatan operator `<` (ikuti docstring) atau mempertahankan `<=` (revisi docstring)?
   - Apakah `publish.yml` diselaraskan ke `bun run gate:fast`, dan apakah `coverage-gate.ts` + `PACK_SIZE_BUDGET_KIB` (jika mendekati 5250 KiB setelah perbaikan) disetujui untuk diperbarui dengan bukti gate terbaru?
