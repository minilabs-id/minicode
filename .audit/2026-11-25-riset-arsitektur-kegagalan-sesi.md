# Riset Arsitektur & Solusi Kegagalan Internal MiniCode (Studi Sesi `e254924d`)

Tanggal: 2026-11-25  
Ruang lingkup: murni mekanisme internal MiniCode (`src/`, `cli/`, `vendor/minicore/`). Masalah eksternal (kuota/concurrency limit upstream `429` dan kapasitas model asli di balik gateway) diabaikan sebagai penyebab eksternal, kecuali bagaimana arsitektur MiniCode meresponsnya.

---

## 1. Adaptive Context Window Hanya Bisa Naik, Tak Bisa Menyusut (`one-way ratchet`) + Compaction Buta Terhadap Overflow Nyata

### Masalah Arsitektural
1. **`escalateContextWindow` satu arah (monotonik naik):**  
   Di `src/app/session.ts:854-876`, saat terjadi error konteks, jendela hanya dinaikkan (`nextLadderStep(from)`), sementara bila penyedia menolak pada angka lebih rendah dari `config.json` (mis. config `1.000.000` namun permintaan ditolak pada ~`66k-79k` estimasi lokal), `contextWindowForModel()` (`src/app/session.ts:799-811`) **tetap mengembalikan `1.000.000`**.
2. **Target kompaksi dihitung dari config, bukan titik kegagalan aktual:**  
   Di `src/policy/compaction.ts:525-538`, `targetTokens()` memakai `limit * LIMITS.COMPACTION_SUMMARY_TARGET_RATIO` dengan `limit = 1_000_000`. Akibatnya saat `force_compact_and_retry` berjalan, `boundedMechanical` / `boundCompactionResult` (`src/policy/compaction.ts:481-516`) menganggap ~`66k-79k` sudah jauh di bawah target (~`200k-350k`), lalu mempertahankan tail hingga `keepRecentTurns` (~`64k-67k` token).
3. **Recovery single-shot langsung mati sebagai `budget_exceeded`:**  
   Di `vendor/minicore/src/core/loop.ts:299-313`, `force_compact_and_retry` hanya diberi **1 kali** kesempatan (`if (compactedForRecovery) throw new AgentError("budget_exceeded", ...)`). Karena kompaksi pertama tidak menyentuh di bawah titik overflow aktual (~`66k`), request ulang otomatis gagal lagi → turn langsung mati berstatus `turn.cancelled (budget)` dan `FAILED`.

### Arah Solusi
1. **Tambahkan Ceiling Adaptif Turun (*Bounded Ceiling Clamp* per sesi):**  
   Saat `ProviderError("context_length_exceeded")` (termasuk `reclassifiedOverflow`) terjadi dengan `localInputTokens = N` (atau `usage.prompt_tokens` terakhir), catat batas atas sesi `cappedWindows.set(key, Math.max(MIN_SAFE_WINDOW, Math.floor(N * 0.85)))` di `src/app/session.ts`. Dengan demikian `contextWindowForModel()` memakai `min(configured, capped)` untuk permintaan dan perhitungan target kompaksi berikutnya, tanpa mengubah `config.json`.
2. **Target Kompaksi Overflow Harus Berbasis `observedRejectTokens`, Bukan Config Optimistis:**  
   Teruskan `overflowObservedTokens` ke `compactStore` / `targetTokens()` ketika kompaksi dipicu oleh `force_compact_and_retry`, sehingga target pemangkasan di-clamp ke `Math.min(targetFromWindow, Math.floor(observedRejectTokens * 0.55))`, dan paksa `keepRecentTurns = 1` (atau `0` jika tail tunggal sudah melebihi 50% batas) sebelum memberi tahu `budget_exceeded`.
3. **Retry Kompaksi Maksimal 2 Tingkat sebelum Terminal:**  
   Tingkat-1: kompaksi LLM/mekanikal mempertahankan 1 turn terakhir; bila retry tetap ditolak overflow pada `N2`, Tingkat-2: drop seluruh tail tool/assistant ke ringkasan ringkas + user prompt aktif sebelum menyerah. Dan bedakan `AgentError` kode alasan `context_overflow` dari `budget_exceeded` agar tidak menyesatkan diagnostik seolah anggaran USD habis (`adapter.ts:1591`).

---

## 2. Kegagalan Compaction LLM (`timeout` + `hallucinated-path`) & Regresi Konteks Recovery

### Masalah Arsitektural
1. **Validator `SOURCE_PATH` terlalu rapuh terhadap format gabungan:**  
   Di `src/policy/compaction-validate.ts:38-39` dan `99-103`, regex `SOURCE_PATH = /\b((?:src|test|docs)\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]+)\b/g` cocok pada string gabungan yang ditulis LLM seperti `docs/cli.md/docs/config.md` (`sub_9e6c2c` `ev=699`) sehingga menolak **seluruh ringkasan LLM** hanya karena satu token path tergabung tanpa spasi.
2. **Satu timeout pada ringkasan LLM membuang seluruh konteks kerja via mekanikal:**  
   Di `src/policy/compaction.ts:600-660`, panggilan LLM summarizer dapat menghabiskan ~94–103 detik sebelum melempar `llm compaction timeout`/`idle timeout`, lalu `vendor/minicore/src/core/loop.ts:530-546` langsung mengganti seluruh store dengan ringkasan mekanikal (`<result omitted>`), yang dalam sesi `e254924d` membuat hasil audit Turn 1–2 hilang dan menyusutkan `before_seq` pesan dari `39` ke `3`.
3. **Recovery mechanical compaction menghancurkan fakta kerja bertumpuk:**  
   Di `vendor/minicore/src/core/compact.ts:66-82`, setiap tool sukses sebelumnya diubah menjadi `- tool(read_file): <result omitted>` sehingga agen mengulang pembacaan berkas yang sama berkali-kali pasca-kompaksi.

### Arah Solusi
1. **Hardening Validator (`compaction-validate.ts`):**
   - Jika kandidat `path` memuat segmen prefiks valid berulang (`/src/`, `/docs/`, `/test/`), pecah dulu di batas prefiks atau sanitasi daripada langsung membatalkan seluruh ringkasan.
   - Bila ringkasan lolos semua cek lain tetapi hanya memiliki ≤2 path ambigu, ganti path tersebut dengan penanda `[unverified-path: ...]` atau flag `needs-verification` alih-alih membuang seluruh ringkasan LLM senilai puluhan ribu token observasi.
2. **Micro-compact Progresif Lebih Agresif Sebelum LLM Summary Penuh:**  
   Pastikan `microcompact()` dipanggil juga sebagai jalur cepat pada recovery overflow dengan menjaga daftar file+line hasil `read_file`/`grep` sebagai baris indeks padat (`path (lines A-B read)`), sehingga agen tidak mengulang membaca file yang sama setelah kompaksi.
3. **Timeout Ketat Summarizer LLM + Ledger Fakta Terstruktur:**  
   Batasi timeout per-attempt LLM compaction (mis. 25–30 dtk maks bila `recovery` aktif) dan suntikkan ringkasan terstruktur deterministik (`filesRead`, `verifiedFacts`, `openTodos` dari `.minicode/todos/`) ke header fallback mekanikal agar hasil investigasi tidak lenyap saat LLM compaction gagal.

---

## 3. Idempotency `bash` Memblokir Command Read-Only Safe Setelah Compaction

### Masalah Arsitektural
1. **`productionIdempotencyKey` mengikat `bash` ke `recoveryGeneration` + `workspaceMutationEpoch`:**  
   Di `cli/setup.ts:662-670` dan `1933-1939`:
   ```ts
   productionIdempotencyKey(tool, args, recoveryGeneration, tool === "bash" ? workspaceMutationEpoch : undefined)
   ```
   - `recoveryGeneration` hanya naik **sekali per user prompt** (`cli/setup.ts:1906`).
   - `workspaceMutationEpoch` hanya naik jika ada `WRITE_TOOLS` (`edit`, `write_file`, dll.) yang sukses.
2. **Konsekuensi di Turn 1 (`e254924d`):**  
   Pada turn audit read-only (`workspaceMutationEpoch === 0`), ketika compaction menghapus hasil `git status --short` atau `dir /b` dari riwayat, model memanggil `git status --short` lagi pada step berikutnya. Karena `argsHash`, `recoveryGeneration`, dan `workspaceMutationEpoch` semuanya sama (`gen1`), `findIdempotentInvocation` (`src/session/verification.ts:685-749`) memblokirnya sebagai `"duplicate idempotency key: already committed"`. Pada Turn 1 hal ini terjadi **7 kali berturut-turut** (`ev=3934..4556`).

### Arah Solusi
1. **Pisahkan Semantik Idempotency per Kelas Command / Step:**  
   - **Untuk `bash` murni read-only/observasional** (atau semua invocation non-crash-replay pada **step baru** yang dipicu oleh LLM setelah menerima tool result sebelumnya): sertakan **indeks step (`stepIndex`)** atau **counter pemanggilan logis pasca-compaction** dalam kunci idempotency bila turn tidak sedang berada pada replay recovery crash proses!
   - Idempotency P2.10 bertujuan mencegah **eksekusi ulang buta saat crash/retry pada step yang sama atau receipt hilang**, bukan melarang LLM di step ke-12 membaca ulang `git status` setelah step ke-0 (atau setelah kompaksi membuang output lama).
2. **Minimum Viable Architectural Fix:**  
   Tambahkan counter `compactionEpoch` dan/atau `modelStepEpoch` (naik setiap kali kernel menyelesaikan satu step dan meminta generasi LLM baru, tetap konstan selama retry provider/crash-recovery step berjalan) khusus untuk tool observasi (`bash` read-only atau `ToolContext`), atau klasifikasikan perintah `bash` read-only deterministik (`git status`, `git log`, `git diff`, `dir`, `ls`, `rg`, dll.) agar dibedakan dari mutasi irreversible pada gerbang idempotency ini.

---

## 4. `LOOP_GUARD READ_ONLY_THRASHING` Membentur Tugas Audit/Investigasi Saat `BUILD`

### Masalah Arsitektural
1. **Postur `active` ditentukan hanya dari mode, bukan sifat langkah & status delegasi:**  
   Di `src/app/session.ts:607-616`, selama WorkMode = `BUILD` dan `registeredTools` mengandung tool tulis, `livePosture()` selalu mengembalikan `"active"`.
2. **Batas 15 `PURE_READ` terlalu sempit di sesi investigasi besar:**  
   Di `src/policy/no-progress.ts:59, 392-409`, `maxConsecutiveReadCalls = 15` memblokir `read_file`/`glob`/`grep` setelah 15 bacaan beruntun, termasuk ketika user eksplisit meminta audit menyeluruh dan semua subagent (`delegate_task`) baru saja gagal sehingga induk harus membaca kode sendiri. Pada step `0` paralel (`10–15` `read_file` sekaligus), kuota 15 habis hanya dalam 1–2 putaran step LLM.

### Arah Solusi
1. **Hitung Streak Berdasarkan *Turn/LLM-Step Unik* + Dedup Target, Bukan Jumlah Call Mentah:**  
   Bila model memanggil 8 `read_file` berbeda dalam **1 batch step paralel**, itu baru 1 langkah kemajuan (membaca file yang belum pernah dibaca), bukan 8 iterasi thrashing. Thrashing sebenarnya terjadi bila:
   - File/query yang dibaca **duplikat berulang** tanpa kemajuan, ATAU
   - Terlampaui batas berdasarkan **jumlah batch step read-only berturut-turut** (mis. `>= 12` step LLM murni baca pada file baru atau total call > 40 tanpa `todo_write`/narasi), bukan 15 individual tool call.
2. **Jangan Hitung Call yang Mengarah ke Berkas Baru sebagai Thrashing Seketika; Reset Saat `todo_write` atau Laporan Parsial:**  
   Peringatan awal (`soft warning` di output tool) pada threshold lebih aman memberi sinyal ke model untuk menyusun `todo_write` sebelum pemblokiran keras.

---

## 5. Status `runs` Sub-agent Palsu (`COMPLETED` saat Error), `messages = 0`, & Concurrency Storm

### Masalah Arsitektural
1. **`runs.status` menipu sebagai `COMPLETED` saat sub-agent gagal (`error`):**  
   Di `src/tools/task.ts:1517-1540`, `delegate_task` hanya memanggil `interruptRun` untuk `timeout`/`aborted`/`maxStepsExceeded`, tetapi komentar eksplisit menyatakan *"error tetap COMPLETED seperti dulu"* → memanggil `completeRun()` padahal `childStatus === "error"` (termasuk `budget_exceeded` / overflow konteks). Akibatnya semua 4 subagent Turn 1 tercatat `COMPLETED` di tabel `runs` `sessions.db` sementara isi `journal-e254924d.jsonl` mencatat `childStatus: "error"` & `aceVerdict: "FAIL"`.
2. **`messages` anak di SQLite selalu `0` baris (`sub_*`):**  
   Di sesi anak yang dibuat via `createChildSession` (`src/session/persistence.ts:2201-2294` & `src/tools/task.ts:887`), `presentation_events` disinkronkan ke SQLite, namun riwayat percakapan anak (`messages`) tidak dipersist ke tabel `messages`, sehingga analisis pasca-kegagalan subagent kehilangan pesan input/output model di DB.
3. **Semburan 4 `delegate_task` paralel langsung menghantam rate/concurrency provider tanpa stagger/adaptive backoff:**  
   Di Turn 1 dan Turn 4, induk langsung melepas 4 subagent paralel seketika pada `step` yang sama, memicu 4x panggilan LLM serentak (+ parent) -> tabrakan langsung pada koneksi awal (`429`) dan menaikkan overhead konteks parent sekaligus.

### Arah Solusi
1. **Koreksi Mesin Keadaan `Run` Sub-agent di `src/tools/task.ts:1525-1545`:**  
   Bila `childStatus` berawal/berjenis `error` (`isSubAgentError` / `childStatus.error === true`) atau `budget_exceeded`, panggil `failRun(childRunId, ...)` (transisi `RUNNING → FAILED` sesuai `RUN_EDGES`), BUKAN `completeRun()`.
2. **Stagger & Concurrency Gate + Feedback `429` Lintas-Pool:**  
   Tambahkan jitter/stagger startup antar worker di pool subagent (mis. 150–400 ms antar launch awal) dan **shared rate-limit cooldown** per provider di pool subagent: begitu 1 worker menerima `429`, worker lain di pool menunggu `retryAfter`/cooldown tersebut sebelum menembak request baru agar tidak menciptakan *retry storm*.
3. **Persist Ringkas/Tail Pesan Sub-agent saat Settled:**  
   Simpan pesan final atau error snapshot subagent (atau minimal turn messages saat `completeRun`/`failRun`) agar audit dan `--resume` forensik tidak menemui `messages = 0`.

---

## 6. Cacat Metadata & Lifecycle Sinkronisasi `sessions.db`

### Masalah Arsitektural
1. **`sessions.cwd` bernilai `""` (string kosong):**  
   Di `src/session/persistence.ts:2229` & `2262`, `createChildSession` menyisipkan baris `sessions` parent dan child dengan `cwd = ''` hardcoded (agar tidak gagal bila parent belum dimaterialisasi), dan pada sesi yang berjalan cepat/resumed `saveSession` tidak selalu menambal kolom `cwd` induk.
2. **Inkonsistensi `turnId` & ketiadaan baris `turns` untuk Turn 2–4:**  
   Di `sessions.db` sesi `e254924d`: `turn_ledger` punya `ordinal 1, 2, 3, 4`, namun tabel `turns` hanya punya `turn_idx = 0`, sedangkan `presentation_events.turn_id` terisi `0, 0, 1, 1` — karena `adapter.ts:865` membaca `e?.turn` (yang di-reset ke `0` atau di-derive dari panjang history yang ter-compact) sehingga beberapa turn ter-kolaps menjadi `turnId` yang sama setelah gagal/resume!
3. **`before_seq` `turn_ledger` merosot (39 → 3) pasca-`recovery` compaction:**  
   Karena mekanisme kompaksi mengganti array `messages` di SQLite di tempat (`replace` dari `seq 0`), `before_seq` pada turn berikutnya ikut turun ke `3` dan menyembunyikan sejarah turn yang sudah selesai (`Turn 2` tak lagi punya jejak pesan terpisah di `messages`).

### Arah Solusi
1. **Teruskan `cwd` kanonik saat materialisasi `sessions`:**  
   Ubah `createChildSession` (`src/session/persistence.ts:2229,2262`) untuk menulis `opts.cwd ?? ''` (bukan selalu `''`), dan pastikan `upsert`/`saveSession` mengisi `cwd` non-kosong bila awalnya `''`.
2. **Gunakan `turn_ledger.ordinal` Monotonik Sebagai Satu Sumber `turnId`:**  
   Jangan turunkan `turnId` di `adapter.ts` dari jumlah pesan `messages` pasca-kompaksi (yang bisa turun kembali ke 0/1); gunakan penghitung turn monotonik persisten dari `turn_ledger` (`max(ordinal)` + 1).
3. **Catat Row `turns` Saat `turn.completed` maupun `turn.cancelled`:**  
   Pastikan `turns` & usage kumulatif tetap ditulis pada akhir setiap turn yang mendapat minimal 1 respons provider (bukan hanya turn pertama / kondisi tertentu).
