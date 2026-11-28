# Rencana Riset & Penyempurnaan: Sub-Agent Budget, Live UI 2 Lapis, Label Tugas, & Ledger Kegagalan

Tanggal: 2026-11-27
Baseline kode: `v0.52.1` (`bc73a94`)

## 1. Diagnosis Akar Masalah (Terbukti di Kode)

### 1.1 Kenapa sub-agent sering mentok batas langkah / tool pada proyek besar
1. **Fallback tanpa `scope` masih 5 langkah (`explore`) / 15 langkah (`plan`):**
   - `src/tools/task.ts:821-829`: saat model memanggil `delegate_task` tanpa `scope`, `derivedBudget` = `undefined` sehingga `cap` jatuh ke `LIMITS.SUB_AGENT_BUDGET_EXPLORE` (`5`, `src/constants.ts:216`) atau `SUB_AGENT_BUDGET_PLAN` (`15`, `src/constants.ts:217`).
   - `src/policy/subagent-budget.ts:34-43` sudah menyediakan `inferScope(prompt)`, tetapi belum pernah dipanggil di `src/tools/task.ts`.
2. **Budget `SCOPE_BASE` masih terlalu sempit untuk proyek besar & tangga eskalasi miss saat prompt berubah:**
   - `src/policy/subagent-budget.ts:12-27`: `file: 16`, `dir: 24`, `subtree: 40`, `repo: 64` (mode `plan` ×1,5). Padahal rata-rata riset besar memakan ~40–70 tool/agent (terlihat dari contoh nyata: 13 sub-agent × 686 tool ≈ 53 tool/agent), sementara hard-cap `LIMITS.SUB_AGENT_MAX_STEPS` sudah `600` dan `SUB_AGENT_TIMEOUT_MS` sudah `3_600_000 ms` (`1` jam).
   - `src/tools/task.ts:246-265`: `delegationKey(mode, prompt, scopeKey)` meng-hash teks penuh `prompt`. Ketika induk menjalankan Putaran 2 dengan wording baru (*"auditor lanjutan untuk scope yang sama"*), cache `maxStepsExceeded` **miss** dan budget kembali turun ke angka dasar.
   - `src/tools/task.ts:1159-1176`: `systemExtra` anak tidak memberi informasi batas langkah (`cap`) maupun anjuran menggabungkan tool baca paralel dan menyimpulkan sebelum langkah habis.
3. **Jebakan `NoProgress` (`maxConsecutiveReadCalls = 8`) di mode `plan`:**
   - `src/tools/task.ts:1155` memasang `noProgress: { maxConsecutiveReadCalls: 8 }` (lebih ketat dari default `30`).
   - Pada mode `explore`, seluruh tool-nya bertier `PURE_READ` sehingga `livePosture()` (`src/app/session.ts:650-660`) bernilai `"explore"` (melewati sinyal `READ_ONLY_THRASHING`). Namun pada mode `plan` dengan parent `EXECUTE + auto`, anak menerima tool tulis/bash sehingga `livePosture()` bernilai `"active"`; membaca >8 kali berturut-turut memicu `LOOP_GUARD READ_ONLY_THRASHING count=8` (`src/policy/no-progress.ts:449-468`), bahkan pesannya menyuruh memanggil `todo_write` padahal `todo_write` telah dibuang dari daftar tool anak (`src/tools/task.ts:842`).

### 1.2 Kenapa live UI & ledger error tampil berantakan seperti cuplikan nyata
Cuplikan nyata:
```
5 read
✦ 13 sub agent · 686 tool · 9 failed (9 error)

› delegate_task failed (sub-agent)

› delegate_task failed (sub-agent)

› (explore) done: 5 temuan dari putaran 2: ↻ retry 1 child tools
```
Penyebab pastinya di kode:
1. **Baris root muncul sebagai `delegate_task` & baris selesai bocor sebagai `(explore) done: ...`:**
   - `name` di schema `delegate_task` (`src/tools/task.ts:672-678`) opsional. Bila `name` kosong, `extractIntent`/`extractTarget` (`src/presentation/adapter.ts:184-230`) mengabaikan `args.prompt`, sehingga `labelTool` (`src/presentation/label.ts:112`) mengisi `activity.summary = "delegate_task"`.
   - `humanToolLabel("delegate_task", activity)` (`src/ui/render/tool-label.ts:114-118`) mengambil `summary` tersebut; `DELEGATE_PREFIX_RE` tidak membuang `"delegate_task"` (karena memakai `_` tanpa kata lanjut) → tampil literal **`delegate_task`**.
   - Saat selesai sukses, `task.ts:1461` menulis `observedSummary = "sub-agent (explore) done: …"` yang menimpa `activity.summary` (`reducer.ts:503`). Bila `intent`/`label` kosong, `cleanDelegateRole` memotong `"sub-agent "` saja dan meninggalkan **`"(explore) done: 5 temuan dari putaran 2:"`**.
2. **Overwrite siluman lintas putaran + `↻ retry` palsu:**
   - `delegate_task` induk punya `target === undefined`. Maka `deriveSupersedes` (`src/presentation/reducer.ts:200-222`) menganggap `delegate_task` Putaran 2 adalah retry dari `delegate_task` yang gagal di Putaran 1.
   - `replaceEntry` (`src/ui/tui/transcript.ts:2850-2863`) kemudian menimpa salah satu baris merah Putaran 1 dengan hasil sukses Putaran 2 (melewati filter `minimizeActivity`) — menghasilkan baris hijau `› (explore) done: ...: ↻ retry 1 child tools`, sementara 2 kegagalan Putaran 1 lainnya tetap tercetak sebagai `› delegate_task failed (sub-agent)`.
3. **Tag kegagalan tidak informatif (`(sub-agent)` & `(9 error)`):**
   - `friendlyToolFailureTag` (`src/ui/render/errors.ts:585-597`) tidak mengenali `"step limit reached"` / `"max_steps"`, sehingga kegagalan limit langkah jatuh ke tag `"sub-agent"`.
   - `agentFailureReason` (`src/ui/tui/transcript.ts:2888-2894`) hanya mengecek `"timeout"`, `"exceeded"`, `"abort"`, `"denied"`, sehingga `"step limit reached"` atau `"LOOP_GUARD"` terhitung sebagai `"error"` (`9 failed (9 error)`).
4. **Agregat `✦` akumulatif per `turnId` & live tail masih 3 lapis:**
   - `aggregateAgent` (`src/ui/tui/transcript.ts:2901-2917`) memakai kunci `turn:${event.turnId}` dan menempelkannya ke `lines[]` (committed) sesudah tool anak pertama selesai; Putaran 1 + Putaran 2 terus dijumlahkan (`13 sub agent · 686 tool`) dan posisinya tertinggal di atas bila diselingi narasi.
   - `orderedRunning` (`src/ui/tui/transcript.ts:3336-3358`) merender root `delegate_task` **dan** tool anak `  ↳ ... running` yang berkedip cepat.

---

## 2. Plan Penyempurnaan (4 Paket Kerja)

### Paket 1 — Perpanjangan Budget & Penghapusan Jebakan Limit Tool Sub-Agent
- **Berkas:** `src/constants.ts`, `src/policy/subagent-budget.ts`, `src/policy/no-progress.ts`, `src/tools/task.ts`, `src/runtime/child-execution.ts`
- **Perubahan:**
  1. **Scope & fallback budget lebih lega untuk proyek besar:**
     - Aktifkan fallback `inferScope(prompt)` di `src/tools/task.ts` ketika `scope` tidak dikirim (atau naikkan `SUB_AGENT_BUDGET_EXPLORE` dari `5 → 24` dan `SUB_AGENT_BUDGET_PLAN` dari `15 → 36`; lihat poin konfirmasi ADR/test B1/B5).
     - Naikkan `SCOPE_BASE` di `src/policy/subagent-budget.ts`: usulan `file: 24`, `dir: 40`, `subtree: 64`, `repo: 100` (mode `plan` ×1,5 → `36 / 60 / 96 / 150`, max hard-cap tetap `600`).
     - Sesuaikan `SUB_AGENT_STEP_LADDER` ke `[24, 40, 64, 100, 150, 250, 400, 600]` agar tidak lagi mulai dari 8/12/20.
  2. **Eskalasi tetap berlaku saat re-delegasi scope sama di putaran berikutnya:**
     - Tambah kunci sekunder per `(scopeKey || sessionId, mode, resolvedScope)` ketika terjadi `max_steps_exceeded`, atau parameter opsional riwayat gagal sebelumnya, sehingga Putaran 2 dengan prompt yang diparafrase tetap naik satu anak tangga.
  3. **Hilangkan jebakan `READ_ONLY_THRASHING` 8-read di sub-agent:**
     - Untuk sub-agent (`task.ts:1155`), naikkan ambang `maxConsecutiveReadCalls` (mis. `48`–`60`, atau `noProgress` mode eksplorasi tidak memicu thrashing hanya karena banyak membaca di fase recon `plan`), sambil tetap menjaga `maxRepeatedErrors` (panggilan identik gagal berulang) dan watchdog idle 120s.
     - Di `no-progress.ts:466`: jangan rekomendasikan `todo_write` bila detektor berjalan tanpa tool tersebut (atau perjelas pesan generik).
  4. **Kesadaran budget di `systemExtra` anak:**
     - Informasikan batas langkah `cap` dan instruksikan memanggil beberapa tool baca paralel per langkah serta mulai menyusun ringkasan 2–3 langkah sebelum batas.
- **Test terdampak:** `test/subagent-budget.test.ts`, `test/p9-admission-boundaries.test.ts` (B1/B1b/B2/B5), `test/audit-fix-subagent-adaptive-history.test.ts`, `test/delegate-audit.test.ts`.

### Paket 2 — Label Kerja Jelas Sejak Detik Ke-0 (Anti `delegate_task` & `(explore) done:`)
- **Berkas:** `src/presentation/adapter.ts`, `src/ui/render/tool-label.ts`, `src/tools/task.ts`, `src/policy/context.ts`
- **Perubahan:**
  1. Di `adapter.ts` (`extractIntent` & `summarize`): saat `toolName === "delegate_task"` dan `name`/`label`/`role` kosong, buat ringkasan 1 baris dari `args.prompt` (ambil kalimat/klausa pertama yang bermakna, buang boilerplate pembuka & markdown, potong rapi ≤60 kolom) agar sejak `tool.started` baris root langsung berbunyi seperti `"Memahami arsitektur alur render"`, bukan `"delegate_task"`.
  2. Di `tool-label.ts`:
     - Jangan gunakan `activity.summary` berpola `sub-agent (...) done: ...` atau string literal `"delegate_task"` / `"sub-agent"` sebagai nama tugas di `humanToolLabel` / `formatActivityLabel`.
     - Jika benar-benar tidak ada label/intent/prompt, jatuh ke terjemahan `dict()["activity.tool.delegate"]` (`sub agent` / `agen sub`), bukan `"delegate_task"`.
  3. Di `task.ts`: `normalizeChildTitle` gabung kata dengan spasi (`" "`), bukan titik tengah `"·"`; dan hanya terbitkan `minicode:child-label` bila belum ada `name` eksplisit yang jelas dari induk.
  4. Di `task.ts` (schema `name`) & `policy/context.ts`: tegaskan contoh frasa aktivitas ringkas (*"Memahami alur render"*, *"Audit modul auth"*).
- **Test terdampak:** `test/tool-label.test.ts`, `test/live-label-render.test.ts`, `test/audit-fix-subagent-self-title.test.ts`, `test/presentation-subagent.test.ts`.

### Paket 3 — Tampilan Live Sub-Agent 2 Lapis Bersih & Agregat Per Putaran
- **Berkas:** `src/ui/tui/transcript.ts`, `src/ui/render/agent-progress.ts`, `docs/TERMINAL_CONTRACT.md`
- **Perubahan:**
  1. **Tanpa baris child tool live (`  ↳`):**
     - `orderedRunning()` / `runningRows()` tidak merender `activity` dengan `parentToolCallId` (child tool tetap berjalan normal dan masuk counter `✦`, tetapi tidak berkedip-kedip di tail).
     - Live list hanya menampilkan root `delegate_task` yang sedang aktif (`running`), dengan label deskripsi tugas yang jelas (`Memahami arsitektur alur render … berjalan (3s)`).
  2. **Agregat `✦` Live Per Putaran (Wave):**
     - Kelompokkan putaran delegasi berdasarkan gelombang aktif (`waveId` baru setiap kali ada `delegate_task` mulai sesudah gelombang sebelumnya kosong / pindah `step`, bukan menjumlahkan seluruh `turnId`).
     - Hitung sub-agent aktif (`status === "running"`) + selesai dalam putaran itu sejak putaran dimulai, sehingga sejak awal putaran langsung tampil `✦ N sub agent · T tool · F failed` tepat di atas daftar sub-agent yang sedang live di putaran itu.
     - Saat Putaran 2 dimulai dengan 2 sub-agent baru, ringkasan agregat diperbarui menampilkan statistik putaran berjalan (`✦ 2 sub agent · 23 tool · 1 error`) dan daftar live hanya berisi 2 sub-agent putaran tersebut (menunggu konfirmasi pemilik: apakah baris `✦` Putaran 1 tetap tertinggal di transkrip atas saat narasi/putaran berganti, atau murni 1 baris agregat live tunggal yang di-update in-place sepanjang turn).
- **Test & dokumen terdampak:** `docs/TERMINAL_CONTRACT.md` (entri baru amandemen live sub-agent), `test/audit-fix-activity-tidy.test.ts`, `test/tui-transcript.test.ts`.

### Paket 4 — Ledger Kegagalan Akurat & Tanpa `↻ retry` / Overwrite Siluman
- **Berkas:** `src/presentation/reducer.ts`, `src/ui/render/errors.ts`, `src/ui/tui/transcript.ts`, `src/ui/i18n/{en,id}.ts`
- **Perubahan:**
  1. Di `reducer.ts` (`deriveSupersedes`): jangan menganggap dua `delegate_task` berbeda dengan `target === undefined` sebagai retry otomatis (`qualified === "delegate_task"` butuh kecocokan label/prompt yang sama, bukan semua yang `target === undefined`). Ini menghentikan overwrite baris gagal Putaran 1 oleh hasil sukses Putaran 2 dan menghilangkan `↻ retry 1 child tools`.
  2. Di `errors.ts` (`friendlyToolFailureTag`) + `en.ts`/`id.ts`: tambahkan pola `step limit reached` / `max_steps` → tag `"step limit"` / `"batas langkah"`, dan `NO_PROGRESS` → `"loop guard"` yang sudah ada, alih-alih jatuh ke `"sub-agent"`.
  3. Di `transcript.ts` (`agentFailureReason`) + `agent-progress.ts`: bedakan `"step_limit"` (atau `"limit"`) di breakdown kegagalan `✦` jika diperlukan, agar error langkah tidak tersembunyi rata sebagai `(9 error)`.
  4. Konsistensi pasca-selesai: pastikan `delegate_task` yang sukses di `minimizeActivity` tidak pernah bocor menjadi baris ledger mentah karena `overwriteId`, dan kegagalan `delegate_task` tetap menampilkan label tugas manusiawi + penyebab jelas (`<tugas> mengalami kegagalan (batas langkah)`).
- **Test terdampak:** `test/presentation-reducer.test.ts`, `test/tui-copy-turn.test.ts`, `test/audit-fix-activity-tidy.test.ts`.

---

## 3. Keputusan yang Memerlukan Konfirmasi Pemilik Sebelum Eksekusi

1. **Perilaku baris agregat `✦` lintas Putaran 1 → Putaran 2:**
   - **Opsi A (1 baris `✦` tunggal di ekor live):** Saat Putaran 2 mulai, baris `✦ 4 sub agent · 50 tool · 2 failed` dari Putaran 1 diganti/diperbarui in-place menjadi `✦ 2 sub agent · 23 tool · 1 error` (paling ringkas: selalu hanya ada 1 blok `✦` + live root di layar).
   - **Opsi B (jejak per putaran):** Putaran 1 meng-commit `✦ 4 sub agent · 50 tool · 2 failed` di posisinya, lalu Putaran 2 membuat blok baru `✦ 2 sub agent · 23 tool · 1 error` + live root putaran 2 di bawahnya.
2. **Kenaikan angka budget langkah sub-agent:**
   - Menyetujui kenaikan fallback default (`explore: 5 → 24`, `plan: 15 → 36`) + `SCOPE_BASE` (`file: 24 / dir: 40 / subtree: 64 / repo: 100`) — termasuk memperbarui kontrak test `test/p9-admission-boundaries.test.ts` (B1/B5) dan `test/audit-fix-subagent-adaptive-history.test.ts` bila angka fallback konstanta ikut naik (atau tetap pakai konstanta `LIMITS.SUB_AGENT_BUDGET_*` jika dinaikkan nilainya).
   - Menyetujui pelonggaran `maxConsecutiveReadCalls` anak dari `8` ke `48` (atau non-thrashing untuk sub-agent).
3. **Baris gagal `delegate_task` individual saat mode ringkas:**
   - Tetap cetak baris gagal berlabel tugas (`› Audit modul auth mengalami kegagalan (batas langkah)`) di bawah `✦`, **atau** cukup terangkum di counter `✦` + ringkasan narasi induk?
