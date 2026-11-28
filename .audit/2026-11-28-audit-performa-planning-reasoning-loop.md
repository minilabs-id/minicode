# Audit Performa: Planning & Reasoning Loop — Tindak Lanjut 2026-11-28

Tanggal: 2026-11-28 (mengikuti penamaan artefak terbaru; perintah pembaca tanggal sistem ditolak allowlist, jadi tanggal tidak diambil dari runtime).
Status: **audit statis**. Penyusunan dilakukan saat WorkMode `DISCUSS`; satu-satunya perubahan workspace adalah artefak ini, setelah mode `BUILD` aktif. Tidak ada benchmark runtime baru yang dijalankan.
Metode: 4 penyelidik paralel (orkestrasi loop, artefak planning, biaya konteks/kompaksi, observabilitas) + verifikasi manual baris demi baris terhadap kode. Satu penyelidik terhenti dengan temuan awal; bagian itu saya lanjutkan sendiri.

Artefak terkait:
- `.audit/2026-11-28-audit-planning-reasoning-loop.md` — audit topik sama dari sesi sebelumnya (F1–F7). File ini **melengkapi**, bukan menggantikan; temuan lama yang relevan dirangkum di Lampiran A.
- `.audit/2026-11-22-audit-performa.md` — audit performa umum (F-01…F-09).
- `.audit/README.md` — indeks dan batas klaim.

---

## 1. Penilaian ringkas

| Aspek | Penilaian | Dasar |
|---|---|---|
| Kontrol anti-runaway loop | Baik (~8/10) | Kompaksi berlapis, pagu, deteksi biaya tetap, eskalasi berundak, guard stagnasi, timeout provider |
| Efisiensi komputasi per step | Sedang (~5/10) | Estimasi konteks O(H) diulang ±9–10× per step; clone histori per step; dua pass estimator di provider |
| Ekonomi planning/`todo_write` | Lemah (~4/10) | Tool "idempotent" tapi melakukan evidence check + git + fsync + SQLite patch tiap panggilan; deklarasi penuh |
| Observabilitas performa loop | Lemah (~4/10) | Step dihitung, latency per step tidak dicatat; `perf-debug` env-gated dan tanpa timer step |

Catatan: angka adalah penilaian analitis berdasarkan bukti kode, bukan hasil pengukuran runtime sesi ini.

---

## 2. Peta kerja satu step (terverifikasi)

Sumber utama: `vendor/minicore/src/core/loop.ts:94-418`.

1. Cek abort → `drainSteers` → guard `stepIndex >= maxSteps` (`:94-108`). `maxSteps` di-resolve sekali per turn lewat `maxStepsForRun` (`:81-92`).
2. Evaluasi tekanan konteks → microcompact 0-LLM → kompaksi LLM dengan fallback mekanikal (`:113-195`).
3. Guard biaya tetap: bila system + tool schema saja melebihi jendela, kompaksi dibatalkan lebih awal (`:150-166`).
4. Stream provider dengan retry/compact-and-retry deterministik (`:227-337`).
5. Append assistant message (termasuk `reasoning` penuh) → `step:started` (`:339-365`).
6. `snapshotState` → executor → append hasil → `step:completed` → event `context-window` yang menghitung token lagi (`:367-417`).

Pagu yang berlaku: `maxBudgetCompactions = 3` per step, `maxTotalTurnBudgetCompactions = 64` per turn (`loop.ts:57-61`); cooldown anti-thrash 600.000 ms / 3 turn (`src/policy/compaction.ts:583-610`); tangga step `200 → 400 → 800 → 1600 → 3200 → 6400` (`src/policy/step-escalation.ts:25-38`), default sub-agent 50 (`:40-49`).

---

## 3. Temuan sesi ini

### F-A [TINGGI] Estimasi konteks memindai seluruh histori berulang kali per step

**Bukti**
- `contextTokens(s)` dipanggil di 9 titik: `loop.ts:114, 123, 133, 168, 171, 181, 197, 205, 415`; `fixedContextTokens(s)` di `:155`. Tidak semua titik aktif tiap step, tetapi `:114` dan `:415` selalu terjadi, sehingga minimum 2 pemindaian penuh per step.
- `contextTokens` memanggil `s.systemForContext?.()` lalu `estimateSessionContext` (`loop.ts:516-524`). Estimator menjumlahkan **semua** pesan + system + tool schema (`vendor/minicore/src/core/tokens.ts:72-107`); `estimateTools` melakukan `safeStringify` schema per tool (`:79-83`).
- Host menyediakan `systemForContext: computeLiveSystem` (`src/app/session.ts:1311`). `computeLiveSystem` menyusun string baru dan memanggil `contextWindowForModel` tiap kali (`:855-865`).
- `dynamicProvider.stream` menghitung ulang seluruh `messages + system + tools` dua kali: estimator lokal `:1069-1072` dan estimator presisi `:1076-1079`; di `:1185-1205` dihitung lagi saat model/calibration berubah.
- Tiap chunk reasoning/text/tool_call dihitung inkremental (`:1207-1225`).
- `buildRequest` meng-clone semua messages dan tool schema per provider attempt (`loop.ts:441-452`); `snapshotState` meng-clone state untuk deps executor (`:372`) dan executor meng-clone lagi untuk permission dan tool context (`vendor/minicore/src/core/executor.ts:66,94`).

**Mekanisme biaya:** `O(H)` per pemanggilan estimasi, dengan `H` = jumlah pesan; konstanta pengali ±9–10 per step ditambah 2 pass di provider dan beberapa deep clone. Biaya tumbuh linear dengan sesi, bukan dengan kompleksitas tugas.

**Dampak:** CPU/latensi per step meningkat tajam pada sesi panjang atau hasil tool besar; kompaksi yang seharusnya jarang justru berada di jalur panas karena pengecekan tekanan dilakukan sebelum tiap request.



**Batas klaim:** tidak ada angka ms dari sesi ini. Artefak sebelumnya mencatat pengukuran historis 42 tool → `~8.870` token tetap/request dan `estimateTools` 100× ≈ `52,33 ms` — rujuk Lampiran A, jangan dianggap hasil baru.

**Kontradiksi antar penyelidik (selesai):** satu penyelidik melaporkan "system prompt dirakit sekali per sesi",penyelidik lain melaporkan "dibangun ulang tiap pemanggilan". Verifikasi: `baseSystem` memang dibangun sekali (`src/app/session.ts:592-594`), tetapi wrapper live `computeLiveSystem` dihitung ulang setiap `contextTokens` memanggil `systemForContext` (`loop.ts:516-524`, `session.ts:1311`). Keduanya benar pada level berbeda.

---

### F-B [TINGGI] `todo_write` murah di kontrak, mahal di implementasi

**Bukti**
- Kontrak: `lm("todo_write", "exclusive", { idempotent: true, internalWrite: true, noPrompt: true, allowedInPlan: true })` (`src/policy/tool-contract.ts:223-228`).
- Skema mewajibkan **full declaration**: `"Write/replace the entire todo list (send the full list, never a delta)"` (`src/tools/todo.ts:775-816`). Model wajib mengirim ulang seluruh item + `taskId` tiap update; biaya token planning tumbuh `O(n)` per update, `O(n²)` selama sesi.
- `execute` menjalankan `resolveFreshEvidence` sebelum gate apa pun (`todo.ts:817-844`). Jalur `unverified` memuat jurnal, `collectSessionModifiedFiles`, lalu `checkWorkspaceIntegrity` dan `detectEvaluationTampering` (`todo.ts:136-165`).
- `collectSessionModifiedFiles` menggabungkan jurnal hingga 20 child session (`src/session/verification.ts:1830-1845`).
- Bila sesi pernah memakai tool mutasi, `listDirtyEvaluationPathsResult` menjalankan `spawnSync("git", ..., "status", "--porcelain", ...)` (`verification.ts:1716-1756`), lalu hash ulang tiap path kotor terhadap baseline (`:1856-1878`).
- Penulisan: `saveTodos` #1 tanpa syarat (`todo.ts:889-892`, `:626-629`), `synchronizeCanonicalTasks` (`todo.ts:921-947`), `saveTodos` #2 bila ada id baru (`:993-1008`), dan `savePlanSnapshot` tiap save (`:1026-1029`). Setiap `saveTodos`/`savePlanSnapshot` memakai `atomicWriteText`: tmp `wx` → write → `fsync` best-effort → chmod → rename dengan retry (`src/lib/atomic-write.ts:41-85`).
- `synchronizeCanonicalTasks` memanggil `patchTask` untuk setiap item existing (`src/task/sync.ts:222-294`). `patchTask` menjalankan `UPDATE ... revision = revision + 1` **tanpa cek nilai sama** (`src/task/store.ts:402-443`), di dalam transaksi dengan `getTask` tambahan (`:332,440`) dan event `emitTaskTransition` (`:443`).

**Dampak:** satu panggilan planning karena perubahan 1 status dapat berarti: baca jurnal induk + child, `git status`, hashing file, 2–3 atomic write, dan satu transaksi SQLite dengan patch per item—bahkan bila rencana tidak berubah. Eksekusi bertanda `exclusive` juga memaksa batch tool lain menunggu (lihat Lampiran A, F2 lama).

**Batas klaim:** path `verdict === "passed"` memiliki I/O lebih ringan daripada `unverified`; tidak semua pemanggilan selalu menjalankan `git status`. Tidak ada pengukuran durasi `todo_write` di sesi ini.

---

### F-C [SEDANG] Guard stagnasi memberi insentif memanggil `todo_write` tanpa progres nyata

**Bukti**
- Ambang default 30 bacaan murni berturut-turut di postur `active` (`src/policy/no-progress.ts:250-255`, `:437-476`).
- Saat guarded, pesan eksplisit: `"Formulate a plan (todo_write) or act on what you have read."` (`:463-472`).
- `todo_write` termasuk `isResetsStreakImmediately` dan me-reset `consecutiveReadCalls = 0` tanpa memeriksa isi payload (`:444-449`, `:477-480`). `delegate_task`, `ask_user`, `submit_result`, dan mutasi juga me-reset; `bash`/MCP baru me-reset bila sukses (`:437-449`).

**Dampak:** model dapat me-reset guard dengan mengirim ulang rencana identik—membayar seluruh biaya F-B tanpa mengubah state—lalu melanjutkan loop bacaan. Ini menurunkan kualitas sinyal "progres" dan dapat memperpanjang step yang tidak produktif hingga `maxSteps`.

**Terkait:** eskalasi step bersifat **reaktif**: `escalateMaxSteps` hanya dipanggil setelah `max_steps_exceeded` (`src/app/session.ts:1025-1041`), sehingga turn yang mentok sudah membakar anggaran sebelum batas dinaikkan untuk turn berikutnya. Ini disengaja sebagai backstop, bukan anggaran prediktif.

---

### F-D [SEDANG] Reasoning tidak memiliki anggaran ekonomi tersendiri

**Bukti**
- Kernel mengumpulkan seluruh teks reasoning per stream (`loop.ts:230,268`) lalu menyimpannya utuh di assistant message (`:341-345`, `:363`).
- Estimator menghitung `message.reasoning` sebagai bagian konteks (`vendor/minicore/src/core/tokens.ts:53-58`).
- Pagu adalah anti-OOM, bukan pagu token: `PROVIDER_REASON_MAX_CHARS = 2_000_000`, `PROVIDER_TEXT_MAX_CHARS = 1_000_000`, `PROVIDER_SSE_TOTAL_MAX_BYTES = 67_108_864` (`src/constants.ts:285-294`).
- Ringkasan mekanikal mengabaikan field `reasoning` (`vendor/minicore/src/core/compact.ts:66-82`), tetapi ekor `keepRecentTurns` tetap menyimpan reasoning penuh; `message.reasoning` juga ikut di-snapshot (`vendor/minicore/src/core/snapshot.ts:86-90`).
- Output allowance dapat mengabort stream saat `outputTokens + added > outputAllowance` (`src/app/session.ts:1207-1224`), termasuk saat potongan reasoning besar datang.

**Dampak:** reasoning panjang pada model thinking dapat mendesak kompaksi berulang atau memicu abort/output-limit meski jawaban akhirnya pendek. Tidak ada kebijakan "ringkas reasoning lama lebih dulu" sebelum kompaksi LLM penuh.

**Catatan positif:** provider OpenAI-compat mengirim ulang `reasoning_content` ke history (`vendor/minicore/src/providers/openai-compat.ts:359-364`), sehingga retensi reasoning memang dibutuhkan untuk multi-turn pada provider itu.

---

### F-E [SEDANG] Microcompact aman tetapi ambangnya lambat

**Bukti**
- `MICROCOMPACT_NEVER_TRIM` melindungi `todo_read`, `todo_write`, `write_memory`, `read_memory`, `forget_memory`, `submit_result`, `ask_user` (`src/policy/microcompact.ts:30-38`); `bash`/`code_run` sengaja ikut dipangkas dengan sentinel anti-replay (`:40-73`, `:95-98`).
- Syarat pemangkasan: hemat ≥ 20.000 token, total hasil tool ≥ 40% budget, dan bukan di tengah batch aktif (`:158-186`). `keepRecent` default 5 (`:100-102`, `:167`).

**Dampak:** lapisan termurah bekerja dengan aman, tetapi pada sesi menengah pemangkasan baru terjadi setelah hasil tool benar-benar dominan; sampai saat itu kompaksi penuh tetap menjadi jalur berikutnya. Ini trade-off yang disengaja, bukan bug—perlu diuji sebelum menurunkan ambang.

---

### F-F [RENDAH] Observabilitas tidak bisa menjawab "berapa ms per step?"

**Yang ada**
- `usage.ts` mengakumulasi token per turn/sesi dan parsing delta SSE (`src/policy/usage.ts`); event `context:compacted` membawa `reason`, `step:started`/`step:completed` membawa index dan tool call; event recovery retry dipancarkan lewat `provider:extension` (`src/app/session.ts:1333-1348`).
- `bench/runner.ts:202-217` menghitung `observedSteps` dan **durasi total** `Date.now()`; tidak ada timestamp per step.
- `src/lib/perf-debug.ts` memiliki `perfCount`, `perfSnapshot`, p50/p95, ring buffer 256 sampel, tetapi aktif hanya bila `MINICODE_DEBUG_PERF=1` (`:1-14`, `:25-47`).
- Timer manual sudah ada pada `session.computeLiveSystem`, `session.estimateLocalInput`, `session.estimator.kernel`, `session.contextWindowForModel`, `context.repoMap` (`src/app/session.ts:856-864,905-918,1066-1074,1316-1320`; `src/policy/context.ts:397-417`), tetapi **belum ada timer untuk `contextTokens` kernel, `buildRequest`, atau eksekusi step**.

**Dampak:** temuan F-A/F-B hanya bisa dinyatakan secara analitis; tidak ada baseline runtime untuk membuktikan perbaikan.

---

## 4. Guard yang sudah baik dan harus dijaga saat optimasi

- Kompaksi: microcompact 0-LLM → LLM summary → mechanical fallback; deteksi "mustahil dipadatkan" lewat `fixedContextTokens` sebelum LLM dibakar (`loop.ts:113-195`, `:526-539`).
- Anti-thrash: cooldown 10 menit / 3 turn setelah reduksi rendah berulang (`compaction.ts:583-610`); LLM summary mencoba ulang dengan setengah input bila kosong, lalu validasi ringkasan sebelum dipakai (`compaction.ts:1275-1297`).
- Recovery:retry quota + `force_compact_and_retry` hanya sekali; flag terpisah untuk jalur policy dan recovery agar tidak saling membakar (`loop.ts:48-66,286-336`).
- Parsing prompt: system dasar dibangun sekali per sesi (`session.ts:592-594`), repo map/steering tidak dibangun ulang tiap turn.
- Timeout stream: total 300 s, first-byte 90 s, idle 60 s, stream aktif maksimal 1 jam (`constants.ts:264-284`).

---

## 5. Rekomendasi konkret (prioritas)

**P0-1 — Cache estimasi konteks.** Kunci oleh `store revision/version` + versi system string + versi tool schema. Kembalikan satu nilai yang dipakai ulang dalam satu step; *invalidate* saat append/replace/compaction/perubahan skema. Memoize `computeLiveSystem` oleh `(workMode, permissionMode, contextWindow)`. Hilangkan dua pass estimator penuh di `dynamicProvider.stream` dengan satu lintasan yang menghasilkan angka lokal dan presisi. Target: jumlah pemanggilan estimator per step konstan terhadap `H`.

**P0-2 — Ringankan `todo_write` tanpa mengorbankan verification.** (a) Lewati `resolveFreshEvidence` bila tidak ada item bertransisi ke `completed`; (b) cache verdict bukti per turn dan *invalidate* pada jurnal mutasi; (c) bandingkan list tervalidasi dengan state sebelumnya—bila identik, kembalikan teks rencana tanpa `saveTodos`, `sync`, atau `savePlanSnapshot`; (d) di `synchronizeCanonicalTasks`, patch hanya item yang berubah dan tambahkan short-circuit sebelum `revision = revision + 1`. Jangan menghapus fail-closed verification.

**P1-1 — Perbaiki sinyal progres.** Ubah pesan guard `READ_ONLY_THRASHING` agar tidak menyarankan `todo_write` sebagai tindakan murah. Reset streak hanya bila hash rencana berubah atau mutasi nyata terjadi. Pertimbangkan penanda progres internal ringan yang tidak menyentuh disk.

**P1-2 — Anggaran reasoning.** Tambahkan cap per-step untuk reasoning sebagai fraksi `outputAllowance`, dan ringkas/buang reasoning lama sebelum kompaksi penuh. Pastikan kompatibilitas dengan provider yang butuh `reasoning_content` di history.

**P2-1 — Instrumentasi sebelum/bersamaan optimasi.** Tambahkan timer `contextTokens`, `buildRequest`, `execute`, `compact` ke `perfCount`, serta `startedAt/endedAt` pada event step atau metrik turunan. Laporkan p50/p95 di bench. Ukur sebelum/sesudah dengan sesi 100 step.

**P2-2 — Turunkan ambang microcompact secara terukur.** Uji `minSavingTokens` dinamis (misal `max(1_000, effBudget*0.05)`) dengan regresi compaction/no-progress sebelum mengubah default 20k/40%.

---

## 6. Rencana implementasi & verifikasi (belum dijalankan)

1. Instrumentasi dulu (P2-1) untuk baseline; jangan ubah perilaku.
2. Cache konteks (P0-1) + test jumlah estimator per step.
3. Optimasi `todo_write` (P0-2) + test payload identik → 0 write, test fail-closed verification tetap lolos.
4. Guard & anggaran reasoning (P1-1, P1-2) + test reset streak dan test multi-turn reasoning.
5. Verifikasi lokal: `tsc` + test terarah (`test/compaction.test.ts`, `test/long-running-autonomy.test.ts`, `test/audit-fix-context-boundary-and-thrash.test.ts`, `test/usage-session.test.ts`, `test/presentation-events.test.ts`) + bench 100 step sebelum/sesudah.
6. Gate/rilis **hanya atas aba-aba pemilik**. Perbaikan yang berdampak besar ke UI memerlukan konfirmasi terpisah.

---

## 7. Catatan proses dan batas klaim

- Empat `explore` agent dipakai: Orchestration, Planning Artifact, Context Cost (terhenti; dilanjutkan manual), Observability. Temuan agen diperlakukan sebagai hipotesis dan diverifikasi sebelum dimasukkan.
- Satu perintah `powershell` untuk membaca tanggal sistem ditolak allowlist; tidak dicoba ulang, penamaan mengikuti artefak terbaru.
- Tidak ada perubahan kode produksi, tidak ada test/gate yang dijalankan, tidak ada angka latency baru. Semua angka `file:line` berasal dari checkout saat audit.
- Beberapa detail dari penyelidik paralel yang **tidak** diverifikasi baris per baris (rekonsiliasi canonical assignment di `src/presentation/adapter.ts`, kompleksitas lokal `repairIdlessFullDeclaration`) sengaja tidak dijadikan temuan utama di file ini.

---

## Lampiran A — Ringkasan temuan artefak sebelumnya yang masih relevan

Dari `.audit/2026-11-28-audit-planning-reasoning-loop.md` (tidak diverifikasi ulang di sesi ini, dicantumkan agar "semua temuan" tetap tertaut):

- **F1 [HIGH]**: kontinuitas extended thinking/Anthropic signature & duplikasi konteks Responses API — beririsan dengan F-D di atas pada sisi retensi reasoning, tetapi F1 membahas wire provider yang tidak saya periksa ulang.
- **F2 [HIGH]**: `todo_write` memaksa `todo_read` tambahan dan mengubah batch campuran menjadi sekuensial lewat `EXCLUSIVE_TOOLS` — diperkuat oleh F-B di atas (I/O dan SQLite).
- **F3 [HIGH]**: `runPromptWithVerify` menjalankan baseline verify + self-heal hingga 3 siklus pada turn tanpa mutasi — di luar ruang lingkup sesi ini.
- **F4 [HIGH]**: re-komputasi estimator/fixed schema per step dan biaya BPE — menjadi dasar F-A; angka historis 42 tool/`~8.870` token, `estimateTools` 100× ≈ `52,33 ms`.
- **F5 [HIGH]**: fan-out sub-agent (side-call LLM judul, cold setup, potongan 2.000 char) — di luar verifikasi sesi ini.
- **F6 [MEDIUM-HIGH]**: blind spot fingerprint error pada `no-progress`, ambang `microcompact`, dan `syntheticSummaries` pasca-resume — beririsan dengan F-C/F-E; bagian fingerprint tidak diverifikasi ulang.
- **F7**: butuh dibaca langsung dari artefak asli untuk detailnya; tidak saya ringkas agar tidak menggeser makna.
