# Riset & Rekomendasi Penyelarasan MiniCode (2026-11-26)

Dokumen ini menindaklanjuti [2026-11-26-audit-keselarasan.md](2026-11-26-audit-keselarasan.md) dengan memetakan **akar masalah**, **penguncian test aktif** (*test locks*), serta **rekomendasi urutan eksekusi terbaik** yang selaras dengan aturan `AGENTS.md` (tuning sempit dipisahkan dari keputusan kontrak/UI pemilik).

---

## Ringkasan Prinsip Penyelarasan

1. **Stabilkan working tree yang sedang kotor lebih dulu** (11 test gagal + regresi sinkronisasi) sebelum menambah fitur baru.
2. **Satu sumber kebenaran (*Single Source of Truth*)**: satukan daftar mutator (`WRITE_TOOLS`), kategori/label 41 tool, dan formatter kegagalan (`formatLabeledToolFailure`).
3. **Pisahkan dengan tegas Track 1 (aman, tanpa ubah kontrak) vs Track 2 (wajib keputusan pemilik)** karena beberapa perilaku lama dikunci eksplisit oleh test kontrak (`test/errors-usage.test.ts`, `test/cli-help-language.test.ts`, `docs/TERMINAL_CONTRACT.md`).

---

## Track 1 — Perbaikan Aman & Stabilisasi Working Tree (Tanpa Ubah Kontrak UI)

### Gelombang 1: Hijaukan 11 Test Gagal di Working Tree
1. **Sinkronkan `test/form.test.ts:78` dengan perilaku kursor akhir di `src/ui/screens/form.ts:138-142`:**
   - `form.ts` sengaja mengubah kursor `initial` ke akhir teks (`toGraphemes(initialText).length`) demi ergonomi edit URL/API key. Perbarui ekspektasi `test/form.test.ts:78` menjadi `"https://preset.exampleX"` (atau tambahkan uji `Home` sebelum mengetik bila ingin tetap menguji posisi awal).
2. **Bebaskan `test/tui-transcript.test.ts` (6 fail) & `test/audit-fix-live-inline-status.test.ts` (4 fail) dari asumsi Windows Terminal:**
   - Kedua berkas memakai `createFakeBus()` tanpa `installFakeTty()`, sehingga pada Windows non-WT `supportsUtf8()` (`src/ui/render/theme.ts:19-33`) menghasilkan `glyphs.arrow = ">"`, `glyphs.sparkle = "*"`, `glyphs.dot = "."`.
   - **Saran terbaik:** ganti literal `"›"`, `"✦"`, `"·"` di assertion kedua test memakai getter `glyphs.arrow`, `glyphs.sparkle`, `glyphs.dot` (atau aktifkan `WT_SESSION` di `beforeEach`/`afterEach` helper test transkrip), sambil mempertahankan test eksplisit `MINICODE_ASCII=1`.

### Gelombang 2: Klasifikasi Error, Diagnostik, & Kontrak Jalur Mesin
3. **Perbaiki over-match `refused` & `unavailable` di `src/ui/render/errors.ts`:**
   - Hapus `/\brefused\b/` generik di `errors.ts:308` (`err.network`); ganti dengan pola jaringan spesifik (`connection refused`, `econnrefused`, `fetch failed`, `socket hang up`). Tambahkan cabang `refused` ke permission/policy bila relevan.
   - Perketat `errors.ts:466` (`msg.notConfigured`) agar `"docker unavailable"` / `"sandbox unavailable"` tetap cocok (`test/errors-usage.test.ts:529-532` menguncinya!), sedangkan `"service unavailable"` / `"server unavailable"` masuk ke `msg.requestFailed` (tool) / `err.server` (generic).
4. **Simpan penyebab asli di trace & `/logs`:**
   - Ubah `cli/index.ts:712` (`writeTrace`) dan `cli/tui.ts:1558,1578` (`pushSessionLog`) dari `formatError(...)` menjadi `formatMachineError(...)` — tetap tersanitasi dan ter-scrub secret, tetapi tidak menyamarkan error internal menjadi `"An unexpected problem occurred..."`.
5. **Selaraskan fallback `simple.ts` dengan `formatLabeledToolFailure`:**
   - Di `src/ui/assistant/simple.ts:946-961` (`execution:completed`), samakan format error fallback dengan `writePresentationTerminal` (`simple.ts:639-645`) dan `Transcript` (`src/ui/tui/transcript.ts:2748-2757`), sekaligus selaraskan komentar baris `949-950`.
6. **Jujurkan persistensi ACP (`cli/commands/acp.ts:479-524`):**
   - Pindahkan `persistCurrent()` + cek `isWriterStale()` **sebelum** menulis `acpOk` (sejajar dengan `cli/commands/exec.ts:331-342`), atau setidaknya pisahkan `catch` persist untuk menulis `[writer] ...` terredaksi ke `stderr` alih-alih `catch {}` senyap.

### Gelombang 3: Satu Sumber Kebenaran Tool, Manager, CLI, & Backend Safety
7. **Satukan peta tool terhadap 41 tool di `src/tools/index.ts` & `src/policy/tool-contract.ts`:**
   - `src/session/verification.ts:1804-1812`: hapus `WORKSPACE_MUTATING_TOOLS` manual; impor `WRITE_TOOLS` dari `src/policy/tool-contract.ts` agar `git_restore`, `git_checkout`, dan `lsp_rename` ikut terlacak.
   - `src/ui/render/activity-group.ts:14-57`: tambahkan `lsp_rename` (`"edit"`), `git_restore`, `git_checkout` (`"execute"`).
   - `src/ui/tui/transcript.ts:150-184`: masukkan `code_run` ke `COMPACT_COMMAND_TOOLS` dan `lsp_*` baca + `read_memory` + `todo_read` ke `COMPACT_READ_TOOLS` (dan pertimbangkan menurunkan peta kategori ini langsung atau diuji paritasnya terhadap `TOOL_CONTRACTS`).
   - `src/ui/render/tool-label.ts:12-50,132`: hapus `ls`/`stat` mati, tambahkan kunci label untuk `bash_kill`, `read_memory`, `write_memory`, `forget_memory`, `todo_read`, `submit_result`, `ask_user` + `en.ts`/`id.ts`.
8. **Perbaiki state manager, `@mention`, & sanitasi backend kecil:**
   - `cli/provider-manager.ts:56`: teruskan getter/callback `getCurrentModel: () => activeModel` atau mutasi terkontrol ke `src/ui/screens/provider-manager.ts:125` agar label `(active)` ikut terbarui.
   - `cli/model-manager.ts:104-110`: bila `onDelete(id)` menghapus `activeModel`, kosongkan `activeModel` dan panggil `opts.setModelOverride?.("")` (atau fallback jujur).
   - `src/ui/tui/app.ts:1316-1322`: bila `@mention` dropdown terbuka (`items.length > 0`) saat `Enter`, pertimbangkan melengkapi kandidat pertama (`sel < 0 ? 0 : sel`) seperti `/` dropdown, atau dokumentasikan bahwa `Tab` yang melengkapi `@`.
   - `src/session/verification.ts:1905`: tambahkan `env: sanitizeSpawnEnv(process.env)` pada `gitBaselineContent()` (dan secara bertahap migrasikan ke async `execFile` / `git cat-file --batch`).
   - `src/tools/git.ts:98`: ganti `p.kill("SIGTERM")` menjadi `killProcessTree(p)` (paritas `bash.ts`).
   - `src/daemon/approvals.ts:333-352`: teruskan/hormati `call.signal` di `asPermissionAsk` (paritas `promptAsk`).
9. **Paritas CLI flags & help:**
   - `cli/commands/exec.ts`: panggil `missingValueFlags(subArgs)` & `unknownFlagsBeforePrompt(subArgs)` dengan exit `2` + JSON failure bila `--json` aktif (paritas `cli/index.ts:276-284`).
   - `src/runtime/production-execution.ts:64-78`: dukung juga bentuk `--runtime=<mode>` di `resolveRuntimeMode`.
   - `cli/help.ts`: tambahkan `--runtime`, `--mode`/`-y`, dan `doctor` ke `buildHelpJson()`, serta perbarui baris `Keys:` di `HELP` agar menyebut `Ctrl+C`.
   - `src/ui/i18n/en.ts:321` & `id.ts:327` (`help.k.lineEnds`) + `cli/commands.ts:247`: selaraskan deskripsi `Ctrl+A` (`selectAll` / `Home`) dan `Ctrl+Enter`.

---

## Track 2 — Keputusan Pemilik Diperlukan (Menyentuh Kontrak / Test Lock / Kebijakan)

1. **Kebijakan i18n `tSystem()` vs `t()` (`/lang`):**
   - **Opsi A (Patuh kontrak lama — direkomendasikan):** kembalikan toast UI & balasan `/lang`/`/mode`/`/copy` di `cli/tui.ts` dan pesan error UI di `src/ui/render/errors.ts` (`friendlyError`) agar memakai `t()` (`/lang`), sementara `tSystem()` **hanya** dipakai untuk label aktivitas tool `› …` + kegagalan tool `friendlyToolError` (atau ikuti `t()` juga bila user eksplisit set `/lang`).
   - **Opsi B (Ubah kontrak):** tetapkan secara eksplisit di `TERMINAL_CONTRACT.md`, `docs/repl.md`, dan `docs/environment.md` bahwa seluruh toast sistem & pesan error mengikuti OS locale (`tSystem`), dan hanya `/lang` responses (`tui.langLine`, `tui.langUnknown`) yang memakai `t()`.
2. **Resolusi kontradiksi internal `docs/TERMINAL_CONTRACT.md` & `docs-en/`:**
   - Pilih satu kebenaran aktif di `TERMINAL_CONTRACT.md` sesuai kode sekarang: **composer dinamis 1–2 baris dalam kotak `╭─╮` (`chatCols - 6`)** + **tail live adaptif `max(3, floor(viewH * 0.5))`** + **21 pola kanonik error**. Bersihkan klausa lama yang masih menyebut "2 baris TETAP (`height - 5`)", "maksimal 3 baris live", dan "13 pola".
   - Perbarui juga `docs/repl.md:100-121`, `docs/OUTPUT_RENDERING_SPEC.md:223-266`, `docs/environment.md:125`, dan sinkronkan seluruh **23 berkas `docs-en/`** (terutama `docs-en/cli.md` dan `docs-en/repl.md`) setelah perubahan UI/CLI dikunci.
3. **Kontrak `isError` untuk `delegate_task` (`src/tools/task.ts`):**
   - Pertimbangkan menandai hasil error sub-agent dengan `isError: true` (sambil mempertahankan ringkasan string yang sama demi kompatibilitas model & test P9.2.1), lalu mengisolasi `providerCooldownUntil` / `subAgentHistory` per `provider|model|sessionId|cwd`.
