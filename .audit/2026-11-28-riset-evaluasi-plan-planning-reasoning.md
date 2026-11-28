# Riset, Evaluasi Objektif, dan Plan Perbaikan: Planning & Reasoning Loop MiniCode

Tanggal: 2026-11-28  
Basis: [Audit Planning & Reasoning Loop](file:///d:/Github/minicode/.audit/2026-11-28-audit-planning-reasoning-loop.md), pembacaan kontrak source/test di checkout `v0.52.1`, dan pengukuran mikro-benchmark lokal (`bun`).  
Status: **Rencana siap eksekusi bertahap — menanti persetujuan Owner Gates (`G1`–`G4`); belum ada kode produksi yang diubah.**

---

## 1. Bukti Riset Empiris & Koreksi Audit Awal

Pengujian langsung dan pemeriksaan kontrak test pada checkout ini mengonfirmasi mayoritas bottleneck performa pada F1–F6, **sekaligus mengoreksi dua asumsi berlebih** pada audit awal agar perbaikan tidak mematahkan invarian keamanan/kontrak P0:

### 1.1 Pengukuran Benchmark & Overhead Token Aktual (Checkout Lokal)
1. **Biaya re-estimasi konteks `O(steps² × pesan)` ([tokens.ts](file:///d:/Github/minicode/vendor/minicore/src/core/tokens.ts#L53-L108), [loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L114), [session.ts](file:///d:/Github/minicode/src/app/session.ts#L1069-L1080)):**
   - Simulasi sesi 40 step (`120` pesan / `34.800` token konteks + `systemPrompt` `6.740` char + `42` tool) dengan 4 lintasan estimasi per step (pra-step & pasca-step `loop.ts`, plus `localInputTokens` & `inputTokens` di `session.ts`):
     - Tanpa memo (`minicodeEstimator` saat ini): **`194,10 ms`** (di luar biaya tambahan `101,78 ms` bila 1× lintasan BPE sintetis 12-merge dijalankan per step).
     - Dengan cache `WeakMap` per referensi `Message` + cache `tools`/`system`: **`1,09 ms`** (**`177,9×` lebih cepat**). Pada sesi `SUB_AGENT_MAX_STEPS = 600` atau loop otonom tereskalasi, penghematan CPU menjadi ratusan milidetik hingga multi-detik.
   - Verifikasi mutasi in-place: pemeriksaan `\.content\s*=|\.toolCalls\s*=` pada `src/` dan `vendor/minicore/src/` memastikan objek `Message` yang sudah masuk histori tidak dimutasi in-place (`applyMicrocompact` mengembalikan salinan array baru — dijaga [microcompact.test.ts](file:///d:/Github/minicode/test/microcompact.test.ts#L66-L71)).
2. **Audit ukuran schema tool di wire sebenarnya ([tool-layer.ts](file:///d:/Github/minicode/src/app/tool-layer.ts#L46-L56), [session.ts](file:///d:/Github/minicode/src/app/session.ts#L1062-L1065)):**
   - Total `42` tool di registry memang **`7.185` token** (`24.997` char). **Namun**, pada sesi produksi dengan MCP/LSP kosong, sandbox `"none"`, dan `interactiveAsk: false`, `computeUnavailableWireTools()` di `cli/setup.ts:2124` + `session.ts:1062-1065` **sudah menyembunyikan 13 tool** (`mcp_*`, `lsp_*`, `code_run`, `ask_user`), sehingga payload wire riil adalah **`29` tool = `5.355` token** (menghemat `1.830` token di API, walaupun `loop.ts:523` masih menghitung `s.registry.list()` yang penuh `42` tool).
   - Konsekuensi untuk Rekomendasi #7 awal: target awal `"hemat ~1.800–2.200 token"` **terlalu tinggi**. Karena `test/audit-fix-wire-contract.test.ts`, `test/audit-fix-todo-onboarding.test.ts`, dan `test/audit-fix-child-report.test.ts` mengunci kata kunci protokol penting, pangkas aman pada `29` visible wire tools (`5.355` tok) realistis di kisaran **`~350–650` token** (`~7–12%` dari visible wire schema).

### 1.2 Koreksi Penting terhadap Benturan Kontrak & Test Pengunci
| Area | Rencana Naif yang Harus Dihindari | Fakta Kontrak / Test Pengunci di Repo | Pendekatan Aman yang Dipilih |
|---|---|---|---|
| **F2 (`todo_write`)** | Langsung keluarkan `todo_write` dari `EXCLUSIVE_TOOLS` & hapus kewajiban `"full list, never a delta"` | [p15-phase2-contracts-approval-recovery.test.ts](file:///d:/Github/minicode/test/p15-phase2-contracts-approval-recovery.test.ts#L131-L142) mengunci set `EXCLUSIVE_TOOLS`; [executor.ts](file:///d:/Github/minicode/src/policy/executor.ts#L196-L205) membekukan `anyWrite && anyRead` sekuensial (P4); [wire-contract](file:///d:/Github/minicode/test/audit-fix-wire-contract.test.ts#L76) mengunci `allTools.length === 42`; [todo-onboarding](file:///d:/Github/minicode/test/audit-fix-todo-onboarding.test.ts#L9-L21) & [todo-repair](file:///d:/Github/minicode/test/audit-fix-todo-repair.test.ts#L50-L100) mengunci pesan `"full list, never a delta"` + `TASK_IDENTITY_REQUIRED` | Pisahkan dua jalur: (1) hemat I/O internal ganda (`saveTodos` #1) tanpa ubah kontrak; (2) ubah kelas konkurensi `todo_write` (`internal-exclusive` yang paralel terhadap baca workspace tetapi berseri terhadap `todo_read`/`todo_write`) **+ parameter aditif opsional `updates`** hanya setelah **Gate G2** disetujui (tanpa menambah tool ke-43). |
| **F3 (`verify`)** | Lewati `checkBaseline()` sebelum `session.run()` bila belum ada edit | [cli-session.test.ts](file:///d:/Github/minicode/test/cli-session.test.ts#L1038-L1210) (`PF-07` & `PF-07b`): `--verify` WAJIB menjalankan `checkBaseline` sebelum turn agar `baseline failing before agent run` dan kesegaran pasca-`--resume` berlaku sebelum `todo_write` klaim tanpa mutasi | **Pertahankan `checkBaseline` pre-turn** (`PF-07` tetap hijau), dan terapkan guard hanya pada **pasca-turn `verify` + `runWithSelfHeal`**: bila `checkBaseline` baru saja berjalan di turn ini **dan** `0` mutasi workspace terjadi di turn tersebut, lewati re-verify & 3× siklus self-heal. |
| **F5 (Judul sub-agent)** | Hapus `CHILD_TITLE_PROMPT` diam-diam | [audit-fix-subagent-self-title.test.ts](file:///d:/Github/minicode/test/audit-fix-subagent-self-title.test.ts#L108-L207) menguji stream LLM judul dan event `minicode:child-label` untuk panggilan tanpa `name` | Butuh **Gate G3a**: jadikan generator heuristik lokal 0-token sebagai default (atau tunda LLM title call hingga child berjalan >2 dtk / opt-in env), serta perbarui unit test `audit-fix-subagent-self-title.test.ts`. |
| **F6 (`NoProgress` & `microcompact`)** | Hapus reset `consecutiveReadCalls` saat `todo_write` & turunkan konstanta `MICROCOMPACT_*` secara membabi buta | [p15-phase3-verifying-budget-noprogress.test.ts](file:///d:/Github/minicode/test/p15-phase3-verifying-budget-noprogress.test.ts#L685-L693) mengunci `todo_write` me-reset counter baca; [microcompact.test.ts](file:///d:/Github/minicode/test/microcompact.test.ts#L142-L268) memvalidasi gating 3 syarat **dan** sudah memverifikasi `createLlmCompaction.microcompact` berskala dinamis pada jendela 32k | Pertahankan reset `todo_write` (tambahkan anti-no-op bila isi plan identik), hentikan reset dari `noteAssistantResponse()` teks polos, dan tambah streak sekunder `tool + normalizedErrorHeadline`. Di `microcompact`, jangan ubah konstanta unit test 200k; cukup audit/tuning proporsi ambang dinamis pada `createLlmCompaction` + tambahkan fallback disk `latestTaskState()` pasca-`--resume`. |

---

## 2. Evaluasi & Triase Per Temuan

| ID | Akar Masalah Terkonfirmasi | Skor ROI (Dampak / Biaya) | Dampak Lapisan & `gate:pack` | Keputusan |
|---|---|---|---|---|
| **F4a** | Re-computasi `O(N²)` estimator pesan/skema 4× per step + selisih `hiddenWireTools` di `loop.ts` vs `session.ts` | **Sangat Tinggi** (`~178×` lebih cepat di simulasi 40 step; margin lebih besar di BPE / sub-agent 600 step) | `vendor/minicore/src/core/{tokens,loop}.ts` + `src/app/session.ts` + `VENDOR.md`. Delta byte sangat kecil (`< 3 KiB`) | **Wave 1A** (butuh izin sentuh `vendor/minicore` per **Gate G1**) |
| **F3** | `runWithSelfHeal` tetap memicu `verify` ulang + hingga 3× fix LLM meski turn tidak menyentuh workspace sama sekali | **Tinggi** (memangkas 50–75% panggilan verify pada prompt Q&A/audit di mode `BUILD` & cegah mutasi liar) | `cli/setup.ts` (controller only, UI aman). Delta byte `< 1 KiB` | **Wave 1B** (bebas konflik kontrak `PF-07`/`PF-07b`) |
| **F2a / F6c** | `todo_write` menulis `saveTodos()` 2× per eksekusi; pasca-`--resume` `syntheticSummaries` WeakSet kosong sehingga `latestTaskState` kehilangan state | **Menengah–Tinggi** (hapus 1 file-write async per todo update & pulihkan kontinuitas rencana lintas `--resume`+kompaksi) | `src/tools/todo.ts`, `src/policy/compaction.ts`. Delta byte `< 2 KiB` | **Wave 1C** (bebas konflik kontrak) |
| **F1a** | Anthropic SSE membuang `signature_delta` & `redacted_thinking`, dan `toAnthropicMessages` tidak mereplay blok `thinking` saat multi-step `tool_use` | **Tinggi** (akurasi reasoning Claude extended/adaptive + kepatuhan API tool loop) | `src/providers/anthropic.ts`, opsional field aditif di `vendor/minicore/src/core/{types,loop}.ts` (`VENDOR.md`) | **Wave 2** (butuh **Gate G1**) |
| **F2b / F2c / F4b** | `todo_write` memblokir paralelisasi `read_file`/`grep` batch (`EXCLUSIVE_TOOLS`), mewajibkan full-list replace, dan top schema (`delegate_task` `473` tok, `todo_write` `415` tok, `grep` `356` tok) masih dapat dipadatkan | **Tinggi** (kurangi serialisasi step awal & round-trip `todo_read`; hemat `~350–650` tok/step wire) | `src/policy/{tool-contract,executor}.ts`, `src/tools/{todo,task,grep,bash,edit,apply_patch,write_file}.ts` + 4 berkas test pin | **Wave 3** (butuh **Gate G2**) |
| **F5 / F1b** | Side-call LLM `CHILD_TITLE_PROMPT` per sub-agent; setup provider/repo-map ulang tiap child; cap hasil `2.000` char; duplikasi `input` + `previous_response_id` di `responses.ts` | **Tinggi** (kurangi 429/rate-limit, percepat fan-out 5 sub-agent, dan akhiri duplikasi konteks OpenAI Responses) | `src/tools/task.ts`, `cli/setup.ts`, `src/providers/responses.ts` + update test `subagent-self-title` & `providers-p11` | **Wave 4** (butuh **Gate G3a & G3b/ADR**) |
| **F6a / F6b / Bench** | `canonicalArgsHash` reset pada variasi flag/baris kecil; `noteAssistantResponse()` mereset `consecutiveReadCalls` pada teks biasa; `bench/` belum menguji loop planning/anti-stagnasi | **Menengah** (cegah waste step menuju batas 200 tanpa merusak kasus eksplorasi sah) | `src/policy/no-progress.ts`, `bench/tasks.ts`, `test/p15-phase3-verifying-budget-noprogress.test.ts` | **Wave 5** (butuh **Gate G4**) |

---

## 3. Owner Gates (Persetujuan Sebelum Implementasi)

Sesuai [AGENTS.md](file:///d:/Github/minicode/AGENTS.md) dan batas anggaran paket di [scripts/pack-budget.ts](file:///d:/Github/minicode/scripts/pack-budget.ts#L196) (**aktual terukur `5.384 KB / 5.500 KiB` — sisa margin `~116 KiB`**; tidak ada perubahan UI TUI di plan ini):

1. **Gate G1 — Sentuhan Aditif `vendor/minicore` (Wave 1A & Wave 2):**
   - Menyetujui perubahan aditif di `vendor/minicore/src/core/{tokens,loop,types}.ts` (cache `WeakMap` estimasi pesan/tool + opsional field non-wajib metadata thinking) serta pencatatannya di [vendor/minicore/VENDOR.md](file:///d:/Github/minicode/vendor/minicore/VENDOR.md#L24-L36). *(Tanpa menyentuh TUI/geometri/writer.)*
2. **Gate G2 — Amandemen Kontrak Konkurensi `todo_write` & Schema Trim (Wave 3):**
   - `G2a`: Apakah `todo_write` diizinkan berjalan paralel terhadap `PURE_READ` file workspace (sambil tetap diserialisasi terhadap `todo_read` & `todo_write` lain), disertai pembaruan pin di [p15-phase2-contracts-approval-recovery.test.ts](file:///d:/Github/minicode/test/p15-phase2-contracts-approval-recovery.test.ts#L131-L142)?
   - `G2b`: Apakah `todo_write` mendapat parameter opsional `updates?: [{ taskId, status, blockedReason? }]` (mempertahankan `todos` full-list & guard `TASK_IDENTITY_REQUIRED`, jumlah tool tetap `42`), disertai pelonggaran kata kunci di [audit-fix-todo-onboarding.test.ts](file:///d:/Github/minicode/test/audit-fix-todo-onboarding.test.ts#L17-L20)?
   - `G2c`: Persetujuan trim deskripsi schema tool wire (~350–650 token hemat) sepanjang frasa kritis di `audit-fix-wire-contract.test.ts` tetap dipertahankan.
3. **Gate G3 — Sub-Agent Title Side-Call & Responses API ADR (Wave 4):**
   - `G3a`: Mengganti panggilan LLM `CHILD_TITLE_PROMPT` otomatis dengan ekstraksi label lokal 0-token secara default (LLM side-call hanya jika `MINICODE_SUBAGENT_LLM_TITLE=1` atau tertunda >2 dtk), dan memperbarui ekspektasi [audit-fix-subagent-self-title.test.ts](file:///d:/Github/minicode/test/audit-fix-subagent-self-title.test.ts).
   - `G3b`: Menyetujui ADR untuk [responses.ts](file:///d:/Github/minicode/src/providers/responses.ts#L25-L28): mengirim **delta input** setelah `previous_response_id` hanya ketika hash prefix `messages` cocok 1:1 per rantai sesi/cabang (dan otomatis reset chain saat compaction/rewind/fallback router/concurrent child), lalu memperbarui [providers-p11.test.ts](file:///d:/Github/minicode/test/providers-p11.test.ts#L103-L138).
4. **Gate G4 — Amandemen Perilaku `NoProgressDetector` (Wave 5):**
   - Menyetujui penghentian reset `consecutiveReadCalls` oleh narasi teks biasa (`noteAssistantResponse()`), mempertahankan reset `todo_write` 1× tetapi mendeteksi `todo_write` identik no-op, serta menambah streak error sekunder berbasis `toolName + headline` (ambang `5`).

---

## 4. Plan Perbaikan Bertahap (Waves 1–5)

### Wave 1 — Foundation Performa & Safety Guard (Risiko Terendah)
*Prasyarat: Gate G1 untuk bagian 1A; bagian 1B & 1C bebas gate kontrak.*

1. **1A — Memoisasi Estimasi Token & Sinkronisasi Wire Schema (`F4`):**
   - [vendor/minicore/src/core/tokens.ts](file:///d:/Github/minicode/vendor/minicore/src/core/tokens.ts): Tambahkan cache internal berbasis `WeakMap<TokenEstimator, WeakMap<Message, number>>` di `estimateMessages()` dan cache `WeakMap<TokenEstimator, WeakMap<readonly ToolSchema[], number>>` (tervalidasi panjang+referensi elemen atau cache per `ToolSchema`) — catatan: gunakan `baseEstimator` murni bila pemanggil membungkus faktor pengali agar invalidasi faktor aman! Atau ekspor `createMessageTokenCache(est)` / deteksi `WeakMap` hanya pada fungsi estimator yang murni deterministik (untuk `calibratedEstimator` di `session.ts`, pass `minicodeEstimator` ke `estimateMessages` lalu kalikan `factor` di luar lintasan!).
   - [src/app/session.ts](file:///d:/Github/minicode/src/app/session.ts#L1058-L1206):
     - Hitung `baseTokens = estimateMessages(..., minicodeEstimator) + ...` **sekali saja** (`localInputTokens`), lalu bila `calibrated` belum mengaktifkan `BpeTokenizer` (`!hasLoadedBpe(estimatorModel)`), turunkan `inputTokens = factor > 1 ? Math.ceil(baseTokens * factor) : baseTokens` tanpa iterasi kedua atas seluruh array `messages` dan `tools`!
     - Oper filter `hiddenWireTools` agar konsisten dengan anggaran konteks yang dipakai `loop.ts` (atau sediakan opsi `wireTools?: () => readonly ToolSchema[]` / filter di estimator loop agar tidak terjadi selisih palsu `+1.830` token saat MCP/LSP mati).
   - Catat perubahan vendor di [vendor/minicore/VENDOR.md](file:///d:/Github/minicode/vendor/minicore/VENDOR.md).
2. **1B — Guard Mutasi pada Post-Turn `verify` & `runWithSelfHeal` (`F3`):**
   - [cli/setup.ts](file:///d:/Github/minicode/cli/setup.ts#L3655-L3708): Sebelum `checkBaseline()`, catat seq/counter tool mutasi (`filesChanged` / panggilan tool dari kelompok `isMutationTool()` yang sukses).
   - Pertahankan pemanggilan `checkBaseline()` sebelum `runOnce()` agar `PF-07` & `PF-07b` tetap 100% utuh.
   - Tambahkan pembungkus pada fase pasca-`runOnce`: jika `checkBaseline` baru saja berjalan untuk turn ini **dan** `turnHadMutation === false`:
     - Jika `broken === null` (baseline sudah hijau dan tak ada mutasi), lewati `verify` pasca-turn & `runWithSelfHeal` sepenuhnya (langsung selesai, tanpa menulis snippet verifikasi berulang).
     - Jika `broken !== null` (repo awalnya sudah merah, misalnya Q&A/audit atau skenario non-mutasi `PF-07`), jangan masuki loop `runWithSelfHeal` LLM yang memaksa model memperbaiki repo yang tidak disentuhnya; pertahankan `lastVerify = broken` agar gerbang `todo_write` (`reconcileCompletionEvidence`) tetap konsisten.
3. **1C — Eliminasi Double Disk Write `todo_write` & Fallback Disk `latestTaskState` (`F2` I/O + `F6` Resume):**
   - [src/tools/todo.ts](file:///d:/Github/minicode/src/tools/todo.ts#L829-L1030): Saat mode kanonik (`TaskStore`) akan menulis snapshot akhir via `synchronizeCanonicalTasks` → `saveTodos` #2, tunda/lewati penulisan `saveTodos` #1 pra-sync yang redundan bila sync kanonik berhasil (rollback tetap memakai `viewBefore` bila sync gagal).
   - [src/policy/compaction.ts](file:///d:/Github/minicode/src/policy/compaction.ts#L186-L212): Saat `latestTaskState(messages)` tidak menemukan blok todo terbaru di pesan aktif maupun di balik node `syntheticSummaries` (kasus cold `--resume` ketika `WeakSet` in-memory kosong), sediakan hook/opsi `loadPersistedTaskState?: () => string | null` dari `session.ts` yang membaca `.minicode/todos/<sid>.json` atau `TaskStore` secara read-only best-effort agar ringkasan kompaksi pasca-resume tetap membawa state rencana aktif.
4. **Verifikasi Wave 1:**
   - Baru/diperbarui: `test/audit-fix-stability-perf-2026-11.test.ts` (kesetaraan + benchmark O(1) cache token), `test/cli-session.test.ts` (turn non-mutasi BUILD tidak mengulang verify / memicu self-heal), `test/compaction-audit.test.ts` (taskState terpulihkan pasca-simulasi resume tanpa WeakSet).
   - Jalankan: `bun x tsc --noEmit`, `bun run lint` terarah, dan suite `bun test test/audit-fix-stability-perf-2026-11.test.ts test/cli-session.test.ts test/compaction-audit.test.ts test/hang-fix.test.ts test/harness-p2.test.ts test/context-calibration.test.ts`.

---

### Wave 2 — Kontinuitas Extended Thinking Anthropic (`F1a`)
*Prasyarat: Gate G1.*

1. [vendor/minicore/src/core/types.ts](file:///d:/Github/minicode/vendor/minicore/src/core/types.ts) & [loop.ts](file:///d:/Github/minicode/vendor/minicore/src/core/loop.ts#L228-L355): Tambahkan properti opsional non-wajib `reasoningBlocks?: readonly Record<string, unknown>[]` (atau `providerMeta?: Record<string, unknown>`) pada `AssistantMessage` untuk menampung blok thinking terotentikasi tanpa mencemari field `reasoning` teks tampilan UI. Dokumentasikan di [vendor/minicore/VENDOR.md](file:///d:/Github/minicode/vendor/minicore/VENDOR.md).
2. [src/providers/anthropic.ts](file:///d:/Github/minicode/src/providers/anthropic.ts#L42-L68, L160-L430):
   - Di parser SSE: lacak `content_block_start` (`thinking` / `redacted_thinking`), `delta.type === "signature_delta"` (`delta.signature`), dan `content_block.data` (untuk `redacted_thinking`). Emit extension event terstruktur atau kumpulkan blok final dan teruskan ke `loop.ts` pada `finish`.
   - Di `toAnthropicMessages()`: **hanya** sisipkan kembali blok `{ type: "thinking", thinking, signature }` (jika `signature` non-kosong) atau `{ type: "redacted_thinking", data }` sebelum blok `text` & `tool_use` pada pesan `assistant` ketika mode `thinking` aktif pada request tersebut. **Fail-safe wajib:** bila berasal dari provider lain, hasil compaction, atau resume SQLite tanpa `signature`, jangan pernah menyuntikkan blok `thinking` tak bertanda tangan (agar tidak memicu HTTP `400 invalid_request_error`).
3. **Verifikasi Wave 2:**
   - Tambah test mock SSE Anthropic multi-step tool loop di `test/prompt-caching.test.ts` atau `test/providers.test.ts`: memastikan (a) `signature_delta` + `thinking` diteruskan kembali di request kedua sebelum `tool_use`, (b) `redacted_thinking` dipertahankan utuh, dan (c) pesan hasil resume tanpa `signature` tetap dikirim bersih tanpa blok `thinking` cacat.

---

### Wave 3 — Konkurensi `todo_write`, Patch Delta & Trim Schema Wire (`F2b`, `F2c`, `F4b`)
*Prasyarat: Gate G2 (`G2a`, `G2b`, `G2c`).*

1. **Pemisahan Lock Internal `todo_write` (`G2a`):**
   - [src/policy/tool-contract.ts](file:///d:/Github/minicode/src/policy/tool-contract.ts#L223-L227) & [src/policy/executor.ts](file:///d:/Github/minicode/src/policy/executor.ts#L190-L235): Definisikan pengecualian khusus `internalStateKey: "__minicode_todos__"` untuk `todo_write` dan `todo_read`. Dalam `parallelExecutor`, `todo_write` memblokir sesama accessor `__minicode_todos__` (`todo_read` / `todo_write`), **tidak** lagi memicu sekuensial penuh terhadap batch `read_file` / `grep` / `glob` workspace.
   - Perbarui [test/p15-phase2-contracts-approval-recovery.test.ts](file:///d:/Github/minicode/test/p15-phase2-contracts-approval-recovery.test.ts#L131-L142) dan tambah verifikasi batch campuran `[todo_write, read_file, grep]` berjalan paralel sementara `[todo_write, todo_read]` tetap sekuensial di `test/f01-write-concurrency.test.ts`.
2. **Mode Patch Aditif `updates` pada `todo_write` (`G2b`):**
   - [src/tools/todo.ts](file:///d:/Github/minicode/src/tools/todo.ts): Jadikan `todos` opsional jika `updates` diberikan (`updates: Array<{ taskId: string, status: TodoStatus, blockedReason?: string }>`), validasikan `isTaskId()` + jalur bukti `applyCompletionPolicy()` & `TaskStore` yang persis sama, dan pertahankan guard `TASK_IDENTITY_REQUIRED` untuk pengiriman `todos` deklarasi penuh. Tetap menjaga `allTools.length === 42` & `classifyTool("todo_write") === "none"`.
   - Perbarui teks ekspektasi pada [test/audit-fix-todo-onboarding.test.ts](file:///d:/Github/minicode/test/audit-fix-todo-onboarding.test.ts) dan tambah unit test `updates` (sukses parsial, penolakan status `completed` saat verify merah/basi, penolakan id asing/non-kanonik).
3. **Pemadatan Deskripsi Schema Wire (`G2c`):**
   - Ringkas kalimat berulang pada properti & deskripsi di `delegate_task` (`473` tok), `todo_write` (`415` tok), `grep` (`356` tok), `bash` (`294` tok), `apply_patch` (`293` tok), `edit`, `write_file` — target hemat `~350–650` token wire dengan menjaga semua tag & aturan yang dipin [test/audit-fix-wire-contract.test.ts](file:///d:/Github/minicode/test/audit-fix-wire-contract.test.ts) (`DECISION_RULE`, `FAMILY_TAGS`, `"EVALUATE"`, `"hypotheses"`, `"file 24"`, `"repo 100"`, `"workspace"`).

---

### Wave 4 — Akselerasi Fan-Out Sub-Agent & Responses API Delta Chaining (`F5`, `F1b`)
*Prasyarat: Gate G3 (`G3a`, `G3b`).*

1. **Zero-Token Sub-Agent Title & Shared Read-Only Setup (`G3a` — `src/tools/task.ts`, `cli/setup.ts`):**
   - Ganti side-call LLM `CHILD_TITLE_PROMPT` otomatis dengan ekstraktor kata kunci deterministik 0-token dari `prompt` (mis. `deriveLocalChildTitle(prompt)` berbasis `normalizeChildTitle`), dan gerbang LLM side-call di balik `MINICODE_SUBAGENT_LLM_TITLE=1` (atau tunda timer >2 dtk hanya bila masih berjalan). Perbarui [test/audit-fix-subagent-self-title.test.ts](file:///d:/Github/minicode/test/audit-fix-subagent-self-title.test.ts).
   - Cache hasil `buildSystemPrompt` statis (`AGENTS.md` + `loadCompactRepoMap`) ber-TTL singkat (mis. 5–10 dtk per `cwd` + sidik git status/HEAD) dan teruskan snapshot provider yang sudah teresolusi dari parent ke `createChildSession` saat `delegate_task` melakukan fan-out paralel `SUB_AGENT_POOL_SIZE = 5`.
   - Naikkan ringkasan hasil akhir sub-agent dari batas datar `2.000` char menjadi `4.000` char pada scope `subtree`/`repo` (tetap di bawah pagu `TASK_SUB_AGENT_MAX_TOKENS`), dengan mendahulukan baris `[FINDING]` + daftar `file:line` unik agar parent tidak mengulang `read_file` mentah.
2. **ADR & Delta Chaining Responses API (`G3b` — `src/providers/responses.ts`):**
   - Dokumentasikan ADR singkat di `docs/architecture.md` / komentar kepala `responses.ts`.
   - Ganti `lastResponseByModel` modul-global dengan state rantai ber-scope `(chainKey = hash(system + tools + model))` yang menyimpan `{ responseId, lastSentCount, prefixDigest }`.
   - Kirim **hanya delta `input.slice(lastSentCount)`** bersama `previous_response_id` apabila prefix pesan identik; apabila histori menyusut/terkompaksi, rewind, fallback router, atau error HTTP 400 terkait `previous_response_id`, reset chain dan kirim ulang `input` penuh tanpa `previous_response_id`.
   - Perbarui [test/providers-p11.test.ts](file:///d:/Github/minicode/test/providers-p11.test.ts#L103-L138) + tambah test pemutusan rantai saat kompaksi / sesi konkuren.

---

### Wave 5 — Ketahanan Detektor Anti-Stagnasi & Evaluasi Benchmark (`F6`, `bench/`)
*Prasyarat: Gate G4.*

1. **Pengetatan `NoProgressDetector` (`G4` — `src/policy/no-progress.ts`):**
   - Tambah pelacakan streak sekunder `errorHeadlineStreak` keyed by `${toolName}\n${normalizeErrorHeadline(content)}` (mengabaikan perbedaan argumen kosmetik seperti offset baris/flag kecil), memicu `REPEATED_ACTION_ERROR` pada ambang sekunder (mis. `5×`) sambil menjaga ambang utama `3×` untuk argumen identik.
   - Hentikan `noteAssistantResponse()` mereset `consecutiveReadCalls` pada teks narasi biasa; hanya reset pada mutasi nyata (`WORKSPACE_MUTATION` / `LOCAL_ENV_MUTATION` non-error) atau 1× pembaruan `todo_write` yang benar-benar **mengubah** isi daftar tugas (no-op `todo_write` berulang dengan payload identik tidak me-reset counter).
   - Perluas ekstraksi kandidat path bash sederhana (`mv/cp/sed -i/tee/cat >` token file tanpa slash di root workspace) agar mutasi file root ikut terlacak `WORKSPACE_REVERT_CYCLE`.
   - Perbarui & tambah kasus di [test/p15-phase3-verifying-budget-noprogress.test.ts](file:///d:/Github/minicode/test/p15-phase3-verifying-budget-noprogress.test.ts).
2. **Ekspansi Regresi Benchmark (`bench/tasks.ts`):**
   - Tambahkan skenario simulasi hermetik `--fake` untuk: (a) turn non-mutasi dengan `--verify`, (b) batch paralel `todo_write + read_file`, dan (c) stagnasi error variasi argumen; jalankan `bun bench/runner.ts --fake --runs 2` untuk memastikan skor baseline asap tetap `13/13`+.

---

## 5. Protokol Verifikasi & Pengendalian Ukuran Paket (`gate:pack`)

- **Komitmen ringan byte:** Target pertumbuhan net seluruh kode Wave 1–5 (setelah pemangkasan deskripsi schema tool di Wave 3C & penghapusan duplikasi write) adalah **`<= +10 KiB`** terhadap posisi aktual `5.384 KB` (`PACK_SIZE_BUDGET_KIB = 5500`), sehingga tidak membutuhkan kenaikan budget `gate:pack`.
- **Verifikasi lokal per wave (sesuai standar `AGENTS.md`):**
  - Setelah setiap wave selesai, cukup jalankan `bun x tsc --noEmit`, `bun run lint` terarah pada berkas berubah, serta `bun test` terarah sesuai daftar di masing-masing wave (plus `bun run gate:pack` sekali setelah perubahan menyentuh berkas paket atau di akhir keseluruhan seri wave).
  - Jangan jalankan `bun run gate:fast` penuh tanpa aba-aba pemilik.
