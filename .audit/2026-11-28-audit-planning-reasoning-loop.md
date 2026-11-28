# Audit Performa: Planning & Reasoning Loop MiniCode

Tanggal: 2026-11-28  
Ruang lingkup: kernel agent loop (`vendor/minicore/src/core/`), orkestrasi sesi & estimator konteks (`src/app/session.ts`), planning (`src/tools/todo.ts`, `src/tools/task.ts`, `src/policy/subagent-budget.ts`), anti-stagnasi & eskalasi (`src/policy/no-progress.ts`, `src/policy/step-escalation.ts`, `src/policy/autonomous-loop.ts`), kompaksi (`src/policy/compaction.ts`, `src/policy/microcompact.ts`), eksekutor (`src/policy/executor.ts`), verifikasi (`src/policy/verifier.ts`, `cli/setup.ts`), dan wire reasoning provider (`src/providers/`, `vendor/minicore/src/providers/openai-compat.ts`).

---

## 1. Penilaian Objektif Keseluruhan

Secara arsitektural, pipeline **planning & reasoning loop MiniCode sudah matang di sisi reliabilitas, keamanan, dan anti-runaway** (skor objektif ~**7.5/10** untuk kestabilan dan ketahanan kontrol; masih memiliki celah efisiensi token, latensi langkah, serta koherensi reasoning lintas-step pada ~**6–6.5/10**).

### Kekuatan Utama yang Terverifikasi
1. **Loop kernel deterministik dengan pagar ganda (`vendor/minicore/src/core/loop.ts`):**
   - Urutan per step konsisten (`drainSteers` → cek `stepIndex >= maxSteps` → `microcompact` 0-LLM → `compactAsync` + fallback mekanikal sinkron → guard `fixedContextTokens` → stream dengan `defaultRecoveryPolicy` → eksekusi tool → `step:completed` + update `context-window`).
   - Steering mid-turn disisipkan aman pada batas step ([loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L96-L101)) dan tetap dihitung pada anggaran `stepIndex++` setelah respons tanpa tool ([loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L347-L358)).
2. **Eskalasi langkah berundak & anti-stagnasi 3 modus:**
   - Tangga batas langkah adaptif `200 → 400 → 800 → 1.600 → 3.200 → 6.400` ([step-escalation.ts](file:///d:/Github/minicode/src/policy/step-escalation.ts#L25-L38)) dan sub-agent berbasis scope `file (24) · dir (40) · subtree (64) · repo (100)` (`plan ×1.5`, atap `600`, [subagent-budget.ts](file:///d:/Github/minicode/src/policy/subagent-budget.ts#L8-L23)).
   - Detektor `createNoProgressDetector` ([no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L237-L624)) memblokir `REPEATED_ACTION_ERROR` (3× gagal identik, persisten dengan maksimal `1` retry setelah bukti baru), `WORKSPACE_REVERT_CYCLE` (2× siklus hash berkas), dan `READ_ONLY_THRASHING` (`30` bacaan beruntun di mode aktif; `48` di sub-agent).
   - Orkestrator otonom multi-epoch ([autonomous-loop.ts](file:///d:/Github/minicode/src/policy/autonomous-loop.ts#L12-L180)) menjaga spend cap per jam, spend cap total, serta breaker `5` epoch tanpa progres dengan membawa milestone & pendekatan yang gagal antar epoch.
3. **Kompaksi 2 lapis anti semantic-drift & prompt caching Anthropic:**
   - `microcompact` menargetkan hasil tool lama sebelum LLM summary sambil mengecualikan `todo_read`, `todo_write`, memori, dan `ask_user` ([microcompact.ts](file:///d:/Github/minicode/src/policy/microcompact.ts#L30-L38)).
   - `compactWithLlm` mengunci summary sebelumnya secara verbatim, mem-budget input/output sesuai window, dan memiliki cooldown thrashing (`2`× reduksi `<10%` → cooldown 10 menit / 3 turn, [compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L591-L787)).
   - `toAnthropicTools` & `toAnthropicMessages` memasang breakpoint `cache_control: { type: "ephemeral" }` ([anthropic.ts](file:///d:/Github/minicode/src/providers/anthropic.ts#L87-L135), [anthropic.ts](file:///d:/Github/minicode/src/providers/anthropic.ts#L462-L475)).

---

## 2. Kritik Objektif & Temuan Kelemahan Konkret

### F1 [HIGH] — Kontinuitas Extended Thinking / Reasoning Hilang di Anthropic & Responses API
- **Bukti kode:**
  - Kernel hanya menampung `reasoning: string` polos pada `AssistantMessage` ([loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L230), [loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L343)).
  - Adapter Anthropic hanya me-yield `thinking_delta` sebagai teks polos tanpa menangkap `signature_delta` maupun `redacted_thinking` ([anthropic.ts](file:///d:/Github/minicode/src/providers/anthropic.ts#L203-L338)), dan `toAnthropicMessages()` sama sekali tidak menyertakan block `thinking` pada turn `assistant` berisi `tool_use` ([anthropic.ts](file:///d:/Github/minicode/src/providers/anthropic.ts#L396-L412)). Hanya `openai-compat.ts` yang mengirim ulang `reasoning_content` ([openai-compat.ts](file:///d:/Github/minicode/vendor/minicore/src/providers/openai-compat.ts#L363)).
  - Adapter Responses API (`toResponsesInput`) juga tidak membawa item reasoning dan mengirim `input` penuh **sekaligus** `previous_response_id` pada `store: true` ([responses.ts](file:///d:/Github/minicode/src/providers/responses.ts#L25-L86), [responses.ts](file:///d:/Github/minicode/src/providers/responses.ts#L115-L143)), menduplikasi konteks di sisi server saat chaining aktif.
- **Dampak performa:** Pada multi-step tool loop Claude extended/adaptive thinking, model kehilangan jejak reasoning step sebelumnya tiap memanggil tool (atau berisiko ditolak wire ketat bila signature wajib dikirim); pada Responses API, payload wire + chaining server terduplikasi.

### F2 [HIGH] — Planning via `todo_write` Memicu Round-Trip Ekstra, Serialisasi Executor, dan I/O Berlapis
- **Bukti kode & angka:**
  - `todo_write` mewajibkan deklarasi daftar penuh dan menolak update id-less begitu task kanonik ada di `TaskStore` bila konten/jumlah berbeda — memaksa model memanggil `todo_read` dulu sebelum `todo_write` ([todo.ts](file:///d:/Github/minicode/src/tools/todo.ts#L779-L882)). Auto-repair hanya berlaku bila jumlah dan teks konten 100% identik.
  - Satu eksekusi `todo_write` menjalankan I/O berantai: `resolveFreshEvidence()` → `loadTodos()` → `saveTodos()` #1 → `synchronizeCanonicalTasks()` (SQLite) → `saveTodos()` #2 → `savePlanSnapshot()` markdown ([todo.ts](file:///d:/Github/minicode/src/tools/todo.ts#L829-L1030)).
  - Di [tool-contract.ts](file:///d:/Github/minicode/src/policy/tool-contract.ts#L223-L227), `todo_write` bertanda `concurrencyClass: "exclusive"` (`EXCLUSIVE_TOOLS`). Di [executor.ts](file:///d:/Github/minicode/src/policy/executor.ts#L196-L225), batch campuran read+write atau batch yang memuat item `EXCLUSIVE_TOOLS` **memaksa seluruh batch dieksekusi sekuensial 1-per-1**.
- **Dampak performa:** Saat model memulai turn dengan `[todo_write(...), read_file(a), read_file(b), grep(c)]`, seluruh pembacaan paralel `EXECUTOR_CONCURRENCY = 6` mati menjadi sekuensial, ditambah 1 round-trip LLM tambahan setiap kali model harus memanggil `todo_read` sebelum memperbarui daftar tugas.

### F3 [HIGH] — `runPromptWithVerify` Memicu Baseline Verify & Self-Heal Hingga 3 Siklus Tanpa Cek Mutasi
- **Bukti kode:**
  - Di [setup.ts](file:///d:/Github/minicode/cli/setup.ts#L3634-L3708) dan [verifier.ts](file:///d:/Github/minicode/src/policy/verifier.ts#L328-L360), selama `verifyActive` menyala dan `WorkMode === "EXECUTE"`, **setiap** prompt selalu memanggil `checkBaseline()` sebelum `session.run()` lalu `runWithSelfHeal(..., maxCycles = 3)` sesudahnya, tanpa memeriksa apakah turn tersebut benar-benar melakukan mutasi file/workspace (`filesChanged > 0` atau panggilan write tool).
- **Dampak performa:** Pertanyaan Q&A, audit baca, atau penelusuran di mode `BUILD` tetap membayar biaya waktu eksekusi penuh `verifyCommand` (`tsc`/test suite) minimal 2× per prompt — bahkan bisa menyeret percakapan baca menjadi hingga 3 siklus fix LLM bila repo sedang memiliki error pra-ada.

### F4 [HIGH] — Overhead & Re-Computasi Per-Step (`O(steps² × pesan)` + Redundansi Estimator & Fixed Schema)
- **Bukti kode & pengukuran pada repo:**
  - **Double/quadruple estimation per step:** Di tiap step, `loop.ts` memanggil `contextTokens(s)` di awal step ([loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L114)) dan akhir step ([loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L415)). Di tengahnya, `dynamicProvider.stream()` di [session.ts](file:///d:/Github/minicode/src/app/session.ts#L1069-L1080) **kembali** menghitung seluruh `messages + system + tools` **dua kali berturut-turut** (`minicodeEstimator` untuk `localInputTokens`, lalu `calibratedEstimator`/`BpeTokenizer` untuk `inputTokens`) — dan seluruh `tools` di-stringify ulang di tiap panggilan (`safeStringify` di [tokens.ts](file:///d:/Github/minicode/vendor/minicore/src/core/tokens.ts#L79-L83)) tanpa memo per referensi `Message` atau `ToolSchema`.
  - **Biaya BPE O(L²) pada potongan besar / cache miss:** [bpe.ts](file:///d:/Github/minicode/src/policy/bpe.ts#L53-L124) melakukan regex pre-tokenization + merge loop greedy per piece pada seluruh histori di setiap step tanpa memo per objek `Message`.
  - **Beban skema fixed terukur di repo:** Pengukuran `bun -e` pada checkout ini mencatat `42` tool mengonsumsi `24.997` char (`~7.185` token `minicodeEstimator`) ditambah `buildSystemPrompt` (`6.740` char / `~1.685` token) = **`~8.870` token tetap per request** (`delegate_task` `1.867` char, `todo_write` `1.551` char, `grep` `1.243` char). Memanggil `estimateTools(42 tools)` 100× menghabiskan `52.33 ms` (~`0.52 ms`/call sebelum menghitung array `messages`).

### F5 [HIGH] — Overhead Fan-Out Sub-Agent: Side-Call Judul LLM, Cold Setup Berulang, dan Pemotongan Hasil 2.000 Char
- **Bukti kode:**
  - Saat `delegate_task` dipanggil tanpa parameter `name`, [task.ts](file:///d:/Github/minicode/src/tools/task.ts#L1333-L1383) memicu request LLM terpisah (`CHILD_TITLE_PROMPT`) di provider & rate-limiter yang sama dengan parent.
  - Setiap anak membangun provider (`loadConfig` + `buildProviderListAsync` di [task.ts](file:///d:/Github/minicode/src/tools/task.ts#L604-L637)), DB session + writer lease ([task.ts](file:///d:/Github/minicode/src/tools/task.ts#L925-L948)), dan system prompt + repo-map dari nol tanpa berbagi prompt statis/repo-map yang sudah dibangun induk (`cli/index.ts:192-252` + `session.ts`).
  - Kontrak kembalian anak ke induk memotong `finalText` pada **`2.000` karakter** ([task.ts](file:///d:/Github/minicode/src/tools/task.ts#L1459)), sering memaksa parent membaca ulang berkas yang sama bila temuan tidak diringkas dalam batas itu.

### F6 [MEDIUM-HIGH] — Blind Spot pada `NoProgressDetector` & Gate Terlalu Tinggi di `microcompact`
- **Celah detektor stagnasi ([no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts)):**
  - `computeActionErrorFingerprint` menggunakan `canonicalArgsHash(args)` eksak ([no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L121-L128)): perubahan minor argumen (offset baris/flag kecil) untuk pesan error kompilasi yang **persis sama** mereset `repeatedErrorStreak` kembali ke `1`, memungkinkan retry boros hingga batas `200` step.
  - `consecutiveReadCalls` (`30`) direset ke `0` oleh `noteAssistantResponse()` di setiap `turn:completed` maupun 1 panggilan `todo_write` ([no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L446), [no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L723-L725)), sehingga rangkaian baca tanpa mutasi di antara narasi singkat tak pernah menyentuh ambang.
  - `shellCandidatePaths` hanya memindai token berkarakter `.` / `/` / `\` pada string perintah `bash`/`code_run` ([no-progress.ts](file:///d:/Github/minicode/src/policy/no-progress.ts#L308-L329)), sehingga mutasi skrip/glob tersembunyi lolos dari deteksi `WORKSPACE_REVERT_CYCLE`.
- **Gate `microcompact` terlalu ketat ([compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L636-L656), [constants.ts](file:///d:/Github/minicode/src/constants.ts#L143-L150)):**
  - Syarat gabungan `keepRecent = 5` + `minSavingTokens = min(20k, 12% effBudget)` + `minToolShare >= 0.4` membuat microcompact 0-LLM sering dilewati pada percakapan dengan banyak narasi/reasoning sehingga langsung melompat ke `compactWithLlm` (menanggung latensi panggilan LLM + timeout 60–90 detik).
- **Kehilangan `taskState` pasca-resume + kompaksi berulang ([compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L186-L212)):**
  - `syntheticSummaries` adalah `WeakSet` in-memory ("Pesan hasil load selalu false"); sesudah `--resume` dan kompaksi kedua, `latestTaskState(all)` yang hanya memindai `messages[]` tidak membaca `.minicode/todos/<sessionId>.json` / `TaskStore` dari disk jika `todo_write` lama sudah berada di balik summary hasil load.

---

## 3. Rekomendasi Perbaikan Konkret (Terurut Menurut Rasio Dampak/Upaya)

1. **Skip `checkBaseline` / Self-Heal pada Turn Tanpa Mutasi (Dampak Tinggi, Upaya Kecil — `cli/setup.ts`):**
   - Lacak apakah turn berjalan mengeksekusi tool mutasi workspace (`filesChanged > 0` atau mutator non-error pada `execution:completed` yang bukan hanya baca). Bila nol mutasi, lewati `runWithSelfHeal` pasca-turn (atau tunda `checkBaseline` hingga sesudah mutasi pertama lewat hook pre-edit/post-turn), memangkas latensi prompt Q&A/eksplorasi di mode `BUILD` secara langsung.
2. **Pisahkan `todo_write` dari `EXCLUSIVE_TOOLS` untuk Workspace & Tambah Mode Delta/Auto-Match (Dampak Tinggi, Upaya Sedang — `src/policy/tool-contract.ts`, `src/policy/executor.ts`, `src/tools/todo.ts`):**
   - Tambahkan jalur kunci internal khusus state `.minicode/todos` (`internal-state-lock` / non-blocking terhadap `parallel-read` workspace) agar `[todo_write, read_file, grep, glob]` tetap berjalan paralel dengan `EXECUTOR_CONCURRENCY = 6`.
   - Pada `todo_write`, dukung patching status/penambahan item berbasis kecocokan judul/prefix unik atau sediakan param `mode: "merge" | "replace"` agar model tidak wajib membayar 1 step `todo_read` + `2× saveTodos` penuh hanya untuk menandai 1 item `completed`.
3. **Memoisasi Token per Objek `Message` & Cache Skema `ToolSchema` (Dampak Tinggi, Upaya Kecil — `vendor/minicore/src/core/tokens.ts`, `src/app/session.ts`):**
   - Gunakan `WeakMap<Message, Map<TokenEstimator | string, number>>` dan `WeakMap<ToolSchema[], number>` (atau hash versi array `visibleWireToolSchemas`) agar `estimateSessionContext` per step berubah dari **O(N × L)** menjadi **O(1)** per pesan lama; hilangkan pemanggilan ganda `estimateMessages` + `estimateTools` di `dynamicProvider.stream()` dengan mengembalikan tuple `[local, calibrated]` dalam satu lintasan apabila `factor === 1` dan tokenizer belum aktif.
4. **Hapus Side-Call LLM Judul Sub-Agent atau Jadikan Opsional + Warisi Prompt/Repo-Map Induk (Dampak Tinggi, Upaya Kecil–Sedang — `src/tools/task.ts`, `cli/setup.ts`):**
   - Hentikan panggilan LLM `CHILD_TITLE_PROMPT` otomatis saat `name` kosong (gunakan `normalizeChildLabel` heuristik lokal 0-token yang sudah dimiliki `tool-label.ts` / ringkasan deterministik), menghemat 1 request LLM + rate-limit per sub-agent.
   - Teruskan hasil `buildSystemPrompt` statis (bagian repo-map / `AGENTS.md`) secara read-only atau memo-cache ber-TTL di level `cwd` ke `createChildSession`, dan pertimbangkan menaikkan / memformat ringkasan hasil akhir sub-agent secara terstruktur (`file:line` terkompresi) agar tidak terpotong buta pada 2.000 karakter.
5. **Preserve Extended Thinking Signature (Anthropic) & Hapus Duplikasi Context Responses API (Dampak Tinggi, Upaya Sedang — `src/providers/anthropic.ts`, `vendor/minicore/src/core/loop.ts`, `src/providers/responses.ts`):**
   - Tangkap `thinking` block + `signature` (atau `redacted_thinking`) pada SSE `content_block_start`/`signature_delta` di `anthropic.ts` sebagai metadata non-text terpisah pada `AssistantMessage` (mirip mekanisme `providerMetaByCallId`), dan kirim ulang sebelum block `tool_use` pada `toAnthropicMessages()`.
   - Pada `responses.ts`, kirim **delta items baru** setelah `prev` bila `previous_response_id` dikirim (atau reset chain eksplisit saat `compacted` / history mismatch), menghindari duplikasi riwayat penuh di server.
6. **Perketat Detektor Stagnasi Lintas-Step & Turunkan Ambang `microcompact` Berbasis Rasio (Dampak Sedang, Upaya Kecil — `src/policy/no-progress.ts`, `src/policy/compaction.ts`):**
   - Di `no-progress.ts`, lacak juga **error-fingerprint tanpa args (`toolName + normalizeErrorHeadline`)** dengan ambang sekunder (mis. `5×`) agar variasi spasi/baris kecil untuk error identik tetap terhenti; dan pisahkan reset `consecutiveReadCalls` antara narasi teks murni (`noteAssistantResponse`) vs progres nyata (`WORKSPACE_MUTATION` / `LOCAL_ENV_MUTATION` sukses).
   - Turunkan `minSavingTokens` dinamis pada `createLlmCompaction` (mis. `max(1_000, effBudget * 0.05)`) serta izinkan `latestTaskState()` membaca fallback disk (`loadTodos`) bila `messages[]` tidak memuat node `syntheticSummaries` pasca-`--resume`.
7. **Pangkas Ukuran Skema Tool Wire (Dampak Sedang, Upaya Kecil — `src/tools/index.ts`, `src/tools/task.ts`, `src/tools/todo.ts`):**
   - Ringkas deskripsi parameter yang berulang pada 8 tool tergemuk (`delegate_task` 1.867 char, `todo_write` 1.551 char, `grep` 1.243 char, `bash` 1.071 char, `apply_patch` 1.043 char) — pemangkasan ~25–30% teks deskripsi menghemat `~1.800–2.200` token tetap di **setiap** request step.
