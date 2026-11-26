# Audit Mendalam Keselarasan Seluruh Bagian MiniCode (2026-11-26)

- **Lingkup:** Audit lintas lapisan pada working tree saat ini (`HEAD 7c425a8` + modifikasi lokal pada ~60+ berkas di `cli/`, `src/`, `docs/`, `test/`).
- **Sifat:** Read-only terhadap kode produksi/test (hanya menulis artefak audit ini). Gate penuh (`bun run gate:fast`) tidak dijalankan sesuai aturan `AGENTS.md`.
- **Verifikasi yang dijalankan langsung pada working tree ini:**
  - `bun x tsc --noEmit`: **0 error**.
  - `bun run lint` (`biome check src cli test bench scripts`): **882 berkas, 0 error**.
  - `bun run vendor:check`: **exit 1** (20 berkas, hash kerja `407529907f2b3f91` vs pin historis `4cee16b60d65d18f` di `vendor/minicore/VENDOR.md` — wajar sesuai status host-editable, bukan gate).
  - Test terarah lintas lapisan (`>50` berkas test): mayoritas hijau (termasuk `ui-boundary`, `writer-inventory`, `i18n`, `i18n-hardcode`, `no-frozen-runtime-value`, `import-convention`, `tui-app`, `chat-column`, `composer-box-and-paste`, `live-label-render`, `acp`, `cli-args`, `cli-entry`, `cli-subcommands`, `cli-help-language`, `task-contract-boundary`, `task-invariants`, `runtime-composition`, `p13-runtime-contract`, `p2-daemon-guards`, `persistence-rewrite`), dengan **11 kegagalan test teramati** (rincian di §1).

---

## 1. Ketidakselarasan Test & Implementasi Working Tree

1. **`test/form.test.ts:78` (1 fail — regresi sinkronisasi working tree)**
   - `src/ui/screens/form.ts:138-142` mengubah posisi kursor awal field ber-`initial` dari `0` menjadi `toGraphemes(initialText).length` (ujung kanan nilai).
   - `test/form.test.ts:78` masih menguji perilaku lama: mengirim `"X"` dan menuntut `"Xhttps://preset.example"`, sedangkan layar merender `"https://preset.exampleX"`.
2. **`test/tui-transcript.test.ts` (6 fail) & `test/audit-fix-live-inline-status.test.ts` (4 fail) pada Windows non-WT/non-UTF8**
   - `src/ui/render/theme.ts:19-33` (`supportsUtf8()`) mengembalikan `false` pada proses PowerShell/Windows tanpa `WT_SESSION`, `TERM_PROGRAM`, `MSYSTEM`, `TERM`, atau locale `utf-8`, sehingga `glyphs` turun ke ASCII (`>`, `*`, `.`).
   - `installFakeTty()` di `test/helpers/tui-harness.ts:297-302` menyetel `TERM=xterm-256color` dan `WT_SESSION=fake-tty`, namun kedua berkas test `Transcript` di atas hanya memanggil `createFakeBus()` dan meng-assert literal `"›"`, `"✦"`, dan `"·"`.

---

## 2. Keselarasan Lapisan UI, Presentasi, i18n, & Penanganan Error

1. **Drift kebijakan bahasa `tSystem()` (OS locale) vs `t()` (`/lang`)**
   - Kontrak aktif (`docs/TERMINAL_CONTRACT.md:38-40,71`, `docs/repl.md:13-19`, `docs/environment.md:71-76`) membatasi `tSystem()` khusus untuk label aktivitas tool `› …`, sedangkan UI/narasi/jawaban memakai `/lang` (`t()`).
   - Aktual di kode: `cli/tui.ts` memakai `tSystem()` pada ~40 titik toast/pesan UI (termasuk balasan `/lang` sendiri di baris `1900, 1905, 1915`, `tui.stopped`, `tui.unknownCmd`, `tui.steered`, `tui.queued`, `tui.budgetUnknown`, `tui.budget80`), sementara `tui.budgetOver` (`cli/tui.ts:1513`) masih memakai `t()`. `src/ui/render/errors.ts` juga memakai `tSystem()` untuk seluruh `friendlyError()` / `friendlyFromCategory()`.
2. **Klasifikasi & diagnostik error masih tidak konsisten**
   - `src/ui/render/errors.ts:308`: `/\brefused\b/.test(lower)` masih berada di cabang `err.network` sebelum `err.permission`/`err.config`, sehingga `REFUSED_*` / `"writer admission refused"` salah diklasifikasikan sebagai gangguan jaringan.
   - `src/ui/render/errors.ts:466`: `/\bunavailable\b/` pada `msg.notConfigured` ikut menangkap `"service unavailable"`.
   - `cli/index.ts:712` (`writeTrace`) dan `cli/tui.ts:1558,1578` (`/logs` via `pushSessionLog`) memakai `formatError(...)` alih-alih `formatMachineError(...)`, sehingga error internal tak terklasifikasi tersimpan sebagai teks generik `"An unexpected problem occurred..."` di trace dan `/logs`.
   - `src/ui/assistant/simple.ts:953-960`: jalur fallback `execution:completed` (`isError`) masih memakai `humanToolLabel` + `friendlyToolErrorCanonical` + `tSystem("msg.unknownToolError")`, berbeda dari jalur `writePresentationTerminal` (`simple.ts:639-644`) dan `Transcript` (`src/ui/tui/transcript.ts:2748-2757`) yang sudah memakai `formatLabeledToolFailure`. Komentar di `simple.ts:949-950` juga bertentangan dengan fallback `: ${tSystem("msg.unknownToolError")}` di baris `954-955`.
   - `cli/commands/acp.ts:479-524`: mengirim `acpOk` lebih dulu sebelum `persistCurrent()` dan membungkus persist + `isWriterStale()` di `try { … } catch {}` (kegagalan persist tertelan tanpa stderr/envelope error — kontras dengan `cli/commands/exec.ts:331-342`).
3. **Divergensi 3 tabel klasifikasi tool terhadap 41 tool di `src/tools/index.ts` & `src/policy/tool-contract.ts`**
   - `src/ui/render/activity-group.ts:14-57` (`GROUP_BY_TOOL`): tidak memuat `lsp_rename`, `git_restore`, `git_checkout` → jatuh ke `"other"` alih-alih `"edit"`/`"execute"`.
   - `src/ui/tui/transcript.ts:150-184` (`compactToolCategory`): `code_run` tidak masuk `COMPACT_COMMAND_TOOLS`, dan tool baca LSP (`lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols`, `lsp_workspace_symbols`), `read_memory`, serta `todo_read` tidak masuk `COMPACT_READ_TOOLS` → terhitung sebagai `"other"`.
   - `src/ui/render/tool-label.ts:12-50,132` (`TOOL_LABEL_KEYS`, `cleanAutoTarget`): masih mencantumkan `ls` dan `stat` (tidak ada di `allTools`), sementara `bash_kill`, `read_memory`, `write_memory`, `forget_memory`, `todo_read`, `submit_result`, `ask_user` belum dipetakan.
4. **Sinkronisasi state manager & `@mention` autocomplete**
   - `cli/provider-manager.ts:56`: meneruskan `currentModel: activeModel` by value ke `runProviderManagerView`, sehingga pembaruan `activeModel` di `onSelect` tidak memperbarui tanda `(active)` di `src/ui/screens/provider-manager.ts:125`.
   - `cli/model-manager.ts:104-110`: `onDelete` tidak membersihkan `activeModel` atau `opts.setModelOverride` bila model yang sedang aktif dihapus.
   - `src/ui/tui/app.ts:1316-1322`: saat dropdown `@mention` terbuka dan `sel === -1`, tombol `Enter` langsung men-submit draft dengan token `@query` yang belum selesai (berbeda dari dropdown `/` yang ditangani `applyEngine`).

---

## 3. Keselarasan Backend, Policy, Session, Runtime, & Daemon

1. **Daftar mutator ganda di `src/session/verification.ts`**
   - `WORKSPACE_MUTATING_TOOLS` (`src/session/verification.ts:1804-1812`) masih daftar manual 7 tool yang kehilangan `git_restore`, `git_checkout`, dan `lsp_rename` (ketiganya `WORKSPACE_MUTATION` di `src/policy/tool-contract.ts:196-206`, dan `cli/setup.ts` sudah mengimpor `WRITE_TOOLS`).
   - `gitBaselineContent` (`src/session/verification.ts:1905`) memanggil `spawnSync("git", ...)` tanpa `env: sanitizeSpawnEnv(process.env)` (berbeda dari `listDirtyEvaluationPathsResult` di baris `1736` dan `runGit` di `src/tools/git.ts`).
2. **Kontrak status & isolasi state sub-agent (`src/tools/task.ts`)**
   - `delegateTaskTool` mengembalikan ringkasan kegagalan `[sub-agent … error]` sebagai string sukses sehingga `vendor/minicore/src/core/executor.ts` mencatat `isError: false`; presenter (`src/presentation/adapter.ts`) mengenali kegagalan lewat prefix string, sedangkan konsumen kernel/no-progress melihat sukses.
   - `providerCooldownUntil`, `subAgentRateLimitUntil`, dan `subAgentHistory` masih berlingkup global-proses, belum diisolasi per provider/model/sesi/workspace.
3. **Abort propagation di daemon approvals (`src/daemon/approvals.ts`)**
   - `asPermissionAsk` (`src/daemon/approvals.ts:333-352`) belum meneruskan/merespons `call.signal` (kontras dengan `promptAsk` di `src/ui/approval/prompt.ts` yang kini menerima dan menghormati `signal?: AbortSignal`).
4. **Parsing `--runtime` (`src/runtime/production-execution.ts`)**
   - `resolveRuntimeMode(argv)` (`src/runtime/production-execution.ts:64-78`) hanya mengenali `--runtime <mode>` dan belum mendukung bentuk `--runtime=<mode>`, berbeda dari `cli/args.ts` `getArg`.

---

## 4. Keselarasan CLI & Dokumentasi (`docs/` vs `docs-en/` vs Kode)

1. **Paritas validasi flag & help CLI**
   - `cli/index.ts:276-284` menolak `missingValueFlags` dan `unknownFlagsBeforePrompt` dengan exit `2`, tetapi `cli/commands/exec.ts` belum memanggil kedua helper tersebut.
   - `cli/help.ts`: `buildHelpJson()` (`90-140`) belum mencantumkan `--runtime`, `--mode`/`-y`, dan subcommand `doctor` pada `usage`; baris `Keys:` di `HELP` (`72`) masih menyebut `Esc abort turn (twice = quit)` tanpa `Ctrl+C`.
   - `src/ui/i18n/en.ts:321` & `id.ts:327` (`help.k.lineEnds`) masih menyebut `"line start / end"` / `"awal/akhir baris"`, padahal `Ctrl+A` kini `selectAll`; `KEYBOARD_HELP` (`cli/commands.ts:247`) belum mencantumkan `ctrl+enter` di samping `ctrl+j`.
2. **Kontradiksi internal di `docs/TERMINAL_CONTRACT.md` & dokumen Indonesia lain**
   - `docs/TERMINAL_CONTRACT.md`: header/baris `1`, `28-30`, `74`, `139` menyebut tail live adaptif `max(3, floor(viewH * 0.5))` dan tinggi composer dinamis `1–2` baris, tetapi baris `8-9, 49, 178, 345, 369` masih menyebut kap keras `3` baris / `13 pola`, dan butir `9` (`231-240`) + `278` masih menyatakan composer `2 baris TETAP` (`viewH = height - 5`). Komentar `13 pola` juga masih tersisa di `src/ui/render/errors.ts:410`.
   - `docs/repl.md:100-121`, `docs/OUTPUT_RENDERING_SPEC.md:223-266`, dan `docs/environment.md:125` masih mendeskripsikan composer lama v0.36–v0.37 (prefix `minicode › `, spacer kosong tanpa bingkai `╭─╮`, lebar `composerWidth()` tanpa `chatCols - 6`). Komentar `cli/tui.ts:11` juga masih menulis `histori prompt = memori sesi (tak persist ke berkas)` meski `loadHistory()` sudah dipakai.
3. **Dokumentasi Inggris (`docs-en/`) tertinggal**
   - Seluruh 23 berkas `docs-en/` tidak ikut diperbarui dalam perubahan working tree: `docs-en/cli.md` dan `docs-en/repl.md` masih memuat perilaku lama (`--ask` = `BUILD + ASK`, flag asing menjadi prompt, `Esc Esc` idle = `/undo`, `Ctrl+C` no-op, tanpa `/logs`, dan composer lama tanpa kotak `╭─╮`).
