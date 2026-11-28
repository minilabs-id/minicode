# Riset Mendalam: Kegagalan `bun run dev` (`2d1c6522`) — Provider Stall & Dead Recovery Budget

Tanggal: 2026-11-27  
Sesi acuan: `2d1c6522` (2026-11-27 15:58:58–16:01:48 WIB) beserta analisis historis `.minicode/sessions.db` & `.minicode/step-traces.jsonl`.  
Status: **Diimplementasikan (2026-11-27)** — 2× retry untuk stall/timeout, `RecoveryLedger` per episode + reset per `step:completed`, `PROVIDER_FIRST_BYTE_TIMEOUT_MS = 90_000` / `PROVIDER_IDLE_TIMEOUT_MS = 60_000`, serta propagasi keepalive SSE (`: ping` / `: OPENROUTER PROCESSING` / `event: ping`) ke `withStreamGuards`.

---

## 1. Ringkasan Eksekutif

Sesi terakhir `bun run dev` (`2d1c6522`) gagal di step ke-5 pada pukul `16:01:48 WIB` karena stream ke provider terputus oleh idle timeout 60 detik (`provider sent nothing for 60000ms (connection stalled)`), lalu langsung mati **tanpa 1 kali pun retry maupun auto-resume**.

Investigasi kode, riwayat `sessions.db`, dan sejarah git menemukan bahwa ini bukan insiden sesaat, melainkan **4 kelemahan struktural yang saling mengunci** — termasuk **regresi nyata sejak commit `fa6e2c2` (2026-11-26 11:06 WIB)**:

1. **Regresi jam turn di `RecoveryLedger` (`fa6e2c2`):** `RecoveryLedger` menghitung `elapsed` sejak awal prompt/sub-agent, bukan sejak insiden kegagalan, dan tidak pernah di-reset setelah langkah yang berhasil. Setiap turn atau sub-agent berumur `> 45 detik` langsung kehilangan seluruh hak retry (`remainingMs < 0`).
2. **Kontradiksi konstanta (`60_000 ms > 45_000 ms`):** `PROVIDER_IDLE_TIMEOUT_MS` (`60_000 ms`) lebih besar daripada `RECOVERY_BUDGET_MS` (`45_000 ms`), padahal waktu tunggu request yang stall ikut dihitung terhadap `RECOVERY_BUDGET_MS`. Akibatnya **0 dari 99** insiden `connection stalled` dalam database sesi pernah memenuhi syarat waktu `45 detik`.
3. **Titik buta SSE keepalive pada ketiga adapter provider:** Meski komentar di `constants.ts` dan `guards.ts` mengklaim frame SSE keepalive me-reset idle timer, `openai-compat.ts`, `anthropic.ts`, dan `responses.ts` sama-sama menelan komentar SSE (`: OPENROUTER PROCESSING`, `: ping`) serta `event: ping` tanpa mengabari `withStreamGuards`.
4. **Satu timer 60 detik mencampur antrean/prefill TTFB dan stream mati total** (padahal data `step-traces.jsonl` menunjukkan step normal pada konteks besar sering memakan waktu puluhan detik hingga >60 detik).

---

## 2. Kronologi Empiris Sesi Terakhir & Data Historis

### 2.1 Sesi `2d1c6522` (2026-11-27 15:58:58–16:01:48 WIB)

Dari `.minicode/sessions.db` dan `.minicode/step-traces.jsonl`:

- **Prompt:** Audit read-only seluruh codebase Minicode (`work_mode = DISCUSS`).
- **Step 0–4 berjalan normal** (`totalTokens = 62.430`, `inputTokens = 58.480`, `outputTokens = 2.578`, `cacheReadTokens = 32.192`):
  - `15:58:58.938`: Run dimulai (`ledger` dibuat di `cli/setup.ts:3060`).
  - `15:59:35.909`: Step 0 (`todo_write` pertama — 37 dtk dari mulai turn).
  - `15:59:47.901`: Step 1 (`todo_write` sukses — 12 dtk).
  - `15:59:57.706`: Step 2 (5 read/glob tool — 10 dtk).
  - `16:00:09.393`: Step 3 (5 read/glob tool — 11,7 dtk).
  - `16:00:48.222`: Step 4 (`todo_write`, `t1 → completed`, `t2 → in_progress` — 38,8 dtk; dalam `reasoning` `seq 17` model merencanakan mendelegasikan 5 sub-agent paralel).
- **Step 5 (`16:00:48.187` → `16:01:48.237`):**
  - Request step 5 dikirim, lalu **selama 60.000 ms tidak ada `ProviderEvent` yang masuk** ke `withStreamGuards` (`src/providers/guards.ts:88-91`).
  - `16:01:48.237`: `diagnostic.raised` (`PROVIDER_ERROR`: `"provider sent nothing for 60000ms (connection stalled)"`).
  - `16:01:48.512`: `turn.failed` (`cause: "provider"`), `runs.status = "FAILED"`, `turn_ledger.status = "FAILED"`, **0 event `minicode:retry`**, **0 auto-resume**.

### 2.2 Perbandingan Sebelum vs Sesudah Commit `fa6e2c2` (`2026-11-26 11:06`)

Bukti langsung dari `.minicode/sessions.db`:

- **Sebelum `fa6e2c2` (`e254924d`, 2026-11-25):**
  `src/app/session.ts` memakai `cappedRecovery` (tanpa jam turn). Ketika `e254924d` mengalami `provider sent nothing for 60000ms` pada **menit ke-47 (step 67, `14:56:20 WIB`, `event_seq 26946`)**, sesi tetap melanjutkan ke step 68 pada `14:56:44 WIB` (`event_seq 26991`).
  Sementara untuk `503` terus-menerus di detik awal turn (`e62bf359`, 2026-11-23 `21:15:12`), kuota `RECOVERY_ATTEMPT_QUOTA = 6` tercatat melakukan 6× retry dalam 20 detik sebelum berhenti.
- **Sesudah `fa6e2c2` (2026-11-26 11:06 → sekarang):**
  `fa6e2c2` menyambungkan `activeRecoveryLedger` dari `cli/setup.ts:3060` dan `session.ts:1435` ke `sessionRecoveryPolicy` (`src/app/session.ts:1223`). Sejak commit tersebut, **setiap** sesi yang terkena `connection stalled` maupun `server error` setelah turn berjalan >45 dtk mati total pada percobaan pertama:
  - `c9e2aa7f` (`11-26 17:09`, `elapsed=186.6s`; `17:13`, `elapsed=87.2s`): `server error TipRouter` → 0 retry, langsung `turn.failed`.
  - `39f7af42` (`11-26 17:38`, `elapsed=60.8s`): stall 60 dtk → 0 retry, `turn.failed`.
  - `9ab08c04` (`11-26 23:23`, `elapsed=1368.1s`): stall 60 dtk setelah partial stream (`PROVIDER_ATTEMPT_INVALIDATED`) → 0 retry, `turn.failed`.
  - `b52459a8` (`11-27 13:06–13:07`, `elapsed=2276.8s`): 3 sub-agent paralel (`sub_fa9f67a4`, `sub_ffe18786`, `sub_aff0b56c`) stall serentak lalu mati tanpa retry; parent-nya ikut stall `60s` pada `13:07:25` dan langsung mati.
  - `58e8f635` (`11-27 14:56`, `elapsed=60.2s`): stall pada **request paling pertama (step 0)** → `45_000 - 60_000 = -15_000` → 0 retry, `turn.failed`.
  - `2d1c6522` (`11-27 16:01`, `elapsed=169.6s`): stall pada step 5 → 0 retry, `turn.failed`.

### 2.3 Statistik Agregat `.minicode/sessions.db` & `step-traces.jsonl`

- Total event `diagnostic.raised` berisi `"connection stalled"`: **99 kali**.
  - Terjadi di `elapsed < 45 dtk` sejak awal run: **0 / 99 (0%)**.
  - Terjadi di `60–70 dtk`: **8 / 99**.
  - Terjadi di `> 70 dtk`: **91 / 99**.
- Interval antar-step root di `.minicode/step-traces.jsonl` (`40` interval terukur):
  - `p50 = 12,3 dtk`, `p90 = 91,3 dtk`, `p95 = 270,7 dtk`, `p99 = 377,7 dtk`.
  - Catatan: interval mencakup waktu step/sub-agent, namun bahkan pada step tunggal tanpa sub-agent (`2d1c6522` step 0 = `37,3 dtk`, step 4 = `38,8 dtk` pada 62k token), latensi TTFB/reasoning sudah mendekati ambang 60 detik.

---

## 3. Analisis Mendalam 4 Akar Masalah di Kode

### Akar 1: `RecoveryLedger` Mengukur Umur Seluruh Turn & Tidak Pernah Reset antar-Step Sehat
- `cli/setup.ts:3060` membuat `const ledger = createRecoveryLedger()` **sebelum `runPromptWithVerifyImpl` dimulai**.
- `src/tools/task.ts:1394` memanggil `session.run(String(prompt), { signal: ctx.signal })` tanpa `recoveryLedger`, sehingga `src/app/session.ts:1435` membuat satu ledger dengan `startedAtMs = waktu mulai sub-agent`.
- Di `src/policy/recovery-budget.ts:277-289`:
  ```ts
  const elapsed = state.nowMs - state.startedAtMs
  const remainingMs = budgetMs - elapsed
  if (delayMs >= remainingMs) return { action: "stop", reason: "budget-exhausted" }
  ```
- **Mengapa tes unit lolos sementara produksi gagal:**
  `test/auto-resume.test.ts:301-323` memajukan `clock` hanya pada saat simulasi retry, dan `test/audit-fix-retry-visibility.test.ts:59-109` melempar `"provider sent nothing for 60000ms"` secara sinkron di **`0 ms`**. Tidak satu pun tes mensimulasikan step sehat yang berlangsung `> 45 dtk` sebelum gangguan atau penundaan nyata `60_000 ms` sebelum error guard terpicu.

### Akar 2: `PROVIDER_IDLE_TIMEOUT_MS` (`60_000`) > `RECOVERY_BUDGET_MS` (`45_000`)
- Penjaga stream (`src/providers/guards.ts:85-92, 232-236`) sengaja mengklasifikasikan `connection stalled` sebagai `ProviderError("server", ...)` agar bisa di-retry (`src/app/session.ts:288`).
- Namun saat stall terdeteksi pada detik ke-60 (`PROVIDER_IDLE_TIMEOUT_MS = 60_000` di `src/constants.ts:283`), `nowMs - startedAtMs` minimal `60_000 ms`, yang langsung mengalahkan `RECOVERY_BUDGET_MS = 45_000` (`src/policy/recovery-budget.ts:59`) **bahkan pada percobaan ke-1** (terbukti nyata di `58e8f635`).
- Pada saat yang sama, kita **wajib tetap menjaga invariant T-009** (`test/auto-resume.test.ts`): jangan biarkan provider mati total/lambat menggantung `6 × 60 dtk = 360 dtk` atau mengulangi gelombang retry di `decideTurnResume`.

### Akar 3: Ketiga Adapter Wire Menelan Keepalive SSE Tanpa Mereset `idleTimer`
Klaim kontrak di `src/constants.ts:274-275` dan `src/providers/guards.ts:79-80` ("Timer di-reset setiap ada aktivitas termasuk frame SSE keep-alive/thinking") **tidak terjadi di runtime**:
- `withStreamGuards` hanya mereset `armIdle()` saat iterator `ProviderEvent` (`text`, `tool_call`, `extension`, `finish`) menghasilkan event (`src/providers/guards.ts:112-118`).
- `vendor/minicore/src/providers/openai-compat.ts:489-498` (`sse()`) menjalankan `if (!line.startsWith("data:")) continue;` — seluruh komentar SSE standar seperti `: OPENROUTER PROCESSING` atau `: ping` dibuang diam-diam sebelum pernah menghasilkan `ProviderEvent`. Begitu juga chunk `data:` tanpa `choices[0]` (`L216`: `if (!first) continue`).
- `src/providers/anthropic.ts:188-299, 495-507` menerima `event: ping` / `{ type: "ping" }` dan komentar `:`, tetapi `for await` di `createAnthropicProvider` tidak memancarkan apa pun untuk `evType === "ping"`.
- `src/providers/responses.ts:246-472` mengabaikan komentar `:` dan beberapa event keepalive/lifecycle tanpa memancarkan `ProviderEvent`.

Akibatnya, saat gateway/upstream (OpenRouter/TipRouter/Anthropic proxy) menahan HTTP stream hidup dengan komentar `: ping` / `: OPENROUTER PROCESSING` selagi memproses prefill `62k+` token atau reasoning panjang >60 dtk, `withStreamGuards` tetap membunuh koneksi sehat tepat di `60.000 ms`.

### Akar 4: Sub-Agent Liveness Watchdog & Retry Duplikasi di `cli/setup.ts`
- `src/tools/task.ts:1229-1267` memanggil `noteProgress()` pada `provider:text`, `step:started`, `step:completed`, dan `execution:started`, **tetapi tidak pada `provider:extension` kind `reasoning`** — sehingga anak yang thinking panjang berisiko tidak dicatat sebagai progres hidup oleh watchdog internal (`120 dtk`).
- `cli/setup.ts:3061-3071` (`decideTurnResume`) membungkus ulang seluruh `runPromptWithVerifyImpl` (membuka `Run` baru dan memancarkan `user.message` duplikat, terlihat di `e62bf359`), padahal retry di level `loop.ts:288` jauh lebih bersih karena menjaga turn tunggal, histori bersih, dan memancarkan indikator `minicode:retry` satu baris di footer TUI.

---

## 4. Rencana Perbaikan yang Direkomendasikan (Butuh Konfirmasi Pemilik)

Rencana dibagi menjadi 4 langkah terukur agar **mengembalikan pemulihan yang sempat hilang** tanpa membuka kembali anti-pattern *retry storm* `T-009`:

### Langkah 1 — Jadikan `RecoveryLedger` Berbasis *Failure Episode* & Reset di Langkah Sehat
- **File target:** `src/policy/recovery-budget.ts`, `src/app/session.ts`, `cli/setup.ts`.
- **Perilaku baru:**
  1. `RecoveryLedger` melacak **`episodeStartedAtMs`** yang baru **di-arm pada kegagalan pertama** setelah kondisi sehat (`null` sebelum ada kegagalan), bukan sejak awal turn 40 menit yang lalu. (Properti `startedAtMs` tetap mengembalikan `episodeStartedAtMs ?? createdAtMs` agar kompatibel dengan pembaca luar).
  2. Menambahkan `resetEpisode()` pada `RecoveryLedger`: dipanggil oleh `src/app/session.ts` ketika suatu step berhasil tuntas (`step:completed` non-child atau `provider.stream()` selesai sehat — atau `finish` valid) sehingga turn multi-step dan sub-agent panjang tetap memiliki anggaran pemulihan baru pada step-step berikutnya.
  3. **Dampaknya pada stall (`60s`):**
     - Saat `attempt 1` stall pada detik ke-60, `episodeStartedAtMs` baru menyala saat error diterima → **`remainingMs = 45.000 ms` → `attempt 1` langsung mendapat Retry #1**!
     - Bila retry pulih → selesai & `resetEpisode()`.
     - Bila endpoint benar-benar mati/stall terus dan `attempt 2` juga stall `60s` lagi → pada kegagalan ke-2 `elapsed` dari `episodeStartedAtMs` sudah `~60,5s > 45s` → berhenti bersih di 2 percobaan total (bukan `0` retry dan bukan `6 × 60s = 360s` hang!), dan `decideTurnResume` di `cli/setup.ts` ikut melihat ledger yang sama sudah `budget-exhausted`.
  4. **Opsional (opsi untuk pemilik):** Jika ingin toleransi hingga **2× retry** khusus kasus stall/timeout yang lebih sabar (mis. `RECOVERY_STALL_RETRY_CAP = 2` atau `stallBudgetMs = 90_000` sementara error cepat tetap `45_000`), bisa dipilih dengan batas eksplisit agar tidak melewati ~2–3 menit total.
- **Kesesuaian `T-009`:** Semua invariant `test/auto-resume.test.ts` (45s window pada failure burst, quota 6 shared lintas loop + turn resume, 429 tidak di-retry di lapisan ini, stop saat budget habis) tetap hijau.

### Langkah 2 — Propagasi Aktivitas SSE Keepalive ke `withStreamGuards` Tanpa Mengotori `ProviderEvent`
- **File target:** `src/providers/guards.ts`, `src/providers/sse-bounds.ts`, `src/providers/anthropic.ts`, `src/providers/responses.ts`, `vendor/minicore/src/providers/openai-compat.ts` (`HOST-EDITABLE`).
- **Mekanisme bersih (zero noise di array event tes/kernel):**
  - Tambahkan registry ringan `WeakMap<AbortSignal, () => void>` di host untuk `anthropic`/`responses`, plus hook opsional non-serialized (atau `Symbol.for("minicode.streamActivity")` pada `signal` agar `vendor/minicore/src/providers/openai-compat.ts` tetap zero-dependency tanpa mengimpor `src/`) yang dipanggil saat `sse()` / `boundedSseBody()` membaca chunk byte nyata atau frame komentar SSE (`: ping`, `: OPENROUTER PROCESSING`, `event: ping`).
  - `withStreamGuards` mengikat `armIdle` ke `ctl.signal` sebelum memanggil `provider.stream(request, ctl.signal)`.
  - Setiap keepalive SSE dari server langsung me-reset `idleTimer` (`60_000 ms`), sementara `PROVIDER_REQUEST_TIMEOUT_MS` (`300_000 ms`) tetap membatasi total waktu request agar server yang cuma mengirim `: ping` selamanya tanpa output nyata tetap berhenti di 5 menit.

### Langkah 3 — Evaluasi Ambang Idle / TTFB (`constants.ts`)
- **Pertimbangan empiris:** Bila Langkah 2 aktif, gateway seperti OpenRouter/Anthropic yang mengirim keepalive `: ping` tiap 10–15 dtk tidak akan terputus walau berpikir >60 dtk.
- **Celah tersisa:** Upstream yang **tidak** mengirim `: ping` saat prefill awal konteks besar (`62k–200k` token) atau thinking model non-streaming-delta.
  - Default `PROVIDER_IDLE_TIMEOUT_MS = 60_000` bisa dipertahankan (minimal-change, langsung ditolong Langkah 1 & 2) **atau** dipisah menjadi `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (mis. `90_000 ms` sebelum event/byte pertama) dan `PROVIDER_IDLE_TIMEOUT_MS` (`60_000 ms` antar-chunk setelah stream mulai). Ini ditawarkan sebagai pilihan ke pemilik.

### Langkah 4 — Sub-Agent Heartbeat & Uji Regresi Deterministik
- Di `src/tools/task.ts:1229-1255`, panggil `noteProgress()` juga untuk `provider:extension` kind `"reasoning"`.
- Tambahkan unit/integrasi test regresi di `test/auto-resume.test.ts`, `test/provider-guards.test.ts`, `test/audit-fix-retry-visibility.test.ts`:
  - Turn berjalan `> 120 dtk` melewati beberapa step sukses, lalu terkena `503` / `connection stalled` → wajib tetap memancarkan `minicode:retry` dan pulih.
  - Stall `60_000 ms` di attempt pertama (disimulasikan dengan fake clock / `idleTimeoutMs`) → mendapat retry, namun bila retry ulang juga stall tidak melampaui batas wajar (anti-360s hang).
  - SSE comment `: OPENROUTER PROCESSING` dan Anthropic `event: ping` me-reset `idleTimer` di `withStreamGuards` tanpa mengubah isi `ProviderEvent[]` yang keluar.

---

## 5. Berkas yang Berubah Bila Disetujui

- `src/app/session.ts` (`createRecoveryLedger`, reset episode pada step/stream sehat)
- `src/policy/recovery-budget.ts` (dukungan episode/stall policy bila diperlukan)
- `cli/setup.ts` (konsistensi `decideTurnResume` dengan episode ledger)
- `src/providers/guards.ts`, `src/providers/sse-bounds.ts`, `src/providers/anthropic.ts`, `src/providers/responses.ts`, `vendor/minicore/src/providers/openai-compat.ts` (heartbeat keepalive reset)
- `src/tools/task.ts` (`noteProgress` untuk reasoning sub-agent)
- Opsional sesuai pilihan pemilik: `src/constants.ts` (tuning/pemisahan TTFB vs idle)
- Test terkait: `test/auto-resume.test.ts`, `test/provider-guards.test.ts`, `test/audit-fix-retry-visibility.test.ts`, `test/freeze-regressions.test.ts`.
