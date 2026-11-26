# Rencana Perbaikan Kenyamanan Penggunaan & UX MiniCode

- **Basis:** Audit UX [2026-11-25-audit-ux-kenyamanan.md](2026-11-25-audit-ux-kenyamanan.md) + riset seam kode, boundary (`test/ui-boundary.test.ts`), writer inventory (`test/writer-inventory.test.ts`), dan kontrak test aktif pada HEAD `7c425a8` (`v0.50.0`).
- **Status:** RENCANA — belum ada kode yang diubah; belum ada test/gate yang dijalankan.
- **Aturan `AGENTS.md`:**
  - **Track A (Bugfix & Tuning Sempit):** tidak mengubah layout/geometri/warna/kontrak besar — dapat dieksekusi setelah disetujui.
  - **Track B (Perubahan Besar UI / Kontrak / Test Lock Aktif):** menyentuh geometri, composer, caret, dropdown, semantik `Esc`/`Ctrl+C`, tema/warna, atau membalik test kontrak yang memang mengunci perilaku lama — **wajib keputusan pemilik** sebelum dieksekusi.
  - **Verifikasi lokal per gelombang:** `bun x tsc --noEmit` + test terarah (`bun run gate:fast` hanya atas aba-aba pemilik).

---

## Peta Risiko & Penguncian Test (Wajib Dibaca Sebelum Mengubah Kode)

Riset menemukan 7 penguncian test eksplisit yang **sengaja menguji perilaku lama** (mengubah kode tanpa keputusan pemilik akan mematahkan test kontrak):

1. **`H4` (`test/tui-app.test.ts:1346-1367`):** menguji bahwa `Esc` abort → turn cepat selesai (`releaseSlow()`, runs `finally`) → `Esc` ke-2 dalam 1,5 dtk **harus keluar (`quit`)** alih-alih jatuh ke `/undo`. Jadi me-reset `awaitingSecondEsc` di `doSubmit().finally` mematahkan H4.
2. **Idle double-`Esc` → `/undo` (`test/tui-app.test.ts:203-218`, `test/audit-fix-deep-control-tui.test.ts:111-133`):** dikunci eksplisit.
3. **`busy + Ctrl+C` diabaikan (`test/tui-app.test.ts:1368-1384`):** dikunci eksplisit (`Ctrl+C` hanya copy seleksi, `Esc` yang abort).
4. **Unknown CLI flags masuk prompt (`test/cli-args.test.ts:29-33, 47-49`, `docs/cli.md:158`):** mengunci `promptFromArgs(["--plan", "refactor"]) === "--plan refactor"` dan `["-123", "x"] === "-123 x"`.
5. **`/resume` absen dari `/help` & `BUILTIN_COMMANDS` (`test/cli-help-language.test.ts:73-90, 126-148`):** mengunci daftar `/help` tidak memuat `/resume`.
6. **`colorLevel()` terikat `process.stdout.isTTY` (`test/theme.test.ts:80-89`, `test/audit-fix-color-mode.test.ts:82-86`):** test memaksa `stdout.isTTY = false` dengan `COLORTERM=truecolor` dan menuntut 0 SGR; mengubah `colorLevel()` global akan memecah test ini.
7. **`cli/index.ts` regex-locked pada `emitDelegateRecoveryLines` (`test/p92-recovery-warning-envelope.test.ts:551-561`, `test/audit-fix-agent-control-recovery-interactive.test.ts:68-104`):** menuntut string literal `async function emitDelegateRecoveryLines(`, `await emitDelegateRecoveryLines(sid, wcwd, t0)`, `await emitDelegateRecoveryLines(ctx.sessionId, ctx.cwd, since)`, dan `ctx.runPromptWithVerify = async (p, signal) => {`, serta `cli/recovery-warning.ts` harus tetap 0 writer.

Plus 3 invariant lintas-lapisan:
- **`test/ui-boundary.test.ts`:** `src/ui/**` dilarang mengimpor `cli/`, `src/` non-ui, atau `#minicore`. Semua integrasi baru harus lewat DI (`TuiHost`, `AltScreen`, `PermissionAsk`, `TranscriptOptions`).
- **`test/writer-inventory.test.ts`:** jumlah literal `console.*` / `process.std(out|err).write` dikunci per file (`cli/index.ts` max 38, `cli/setup.ts` max 45, `cli/tui.ts` max 11, `src/ui/screens/form.ts` max 1, `src/ui/tui/app.ts` max 3, dst.).
- **`test/i18n-hardcode.test.ts` & `test/i18n.test.ts`:** `en.ts` dan `id.ts` harus 1:1 key; dilarang literal string kata Indonesia di luar `id.ts`.

---

## Track A — Perbaikan Bug & Tuning Sempit (Zero UI/Contract Break)

Urutan gelombang disusun dari perbaikan paling kritikal + independen hingga konsistensi antarpermukaan.

### Gelombang 1 — Proteksi Data, Raw-Mode Hang, & Single-Writer Lease (P0)

#### A1. Proteksi atomik placeholder `{paste text N lines}` di composer
- **Target:** `src/ui/render/composer-wrap.ts`, `src/ui/tui/app.ts:1289-1405, 1786-1791, 2300-2314, 2554-2575, 2847-2888`
- **Desain:**
  1. Ekspor helper murni di `composer-wrap.ts`: `snapCursorOutOfPasteToken(line, cursor, pastes, bias: "left" | "right" | "nearest")` dan `expandSelectionToWholePasteTokens(line, start, end, pastes)`.
  2. Di `TuiApp`:
     - `left` / `right`: jika mendarat di dalam `[gStart, gEnd)` token aktif, lompat ke `gStart` (`left`) atau `gEnd` (`right`).
     - `moveCursorVertical` & `resolveComposerCursor` (klik mouse): snap keluar ke batas token terdekat (`nearest`), sehingga klik/panah tak pernah menaruh kursor di dalam `{paste ...}`.
     - `ctrl-w`: jika token berada tepat sebelum kursor, hapus token atomik (seperti `backspace`), bukan memotong sebagian teksnya via regex `\S+\s*$`.
     - `deleteComposerSelection` & `copyComposerSelection`: perluas range ke batas utuh token bila irisan menyentuh token, lalu ekspansi penuh saat `Ctrl+C` sehingga salin sebagian token tidak menghasilkan `{paste te`.
- **Risiko:** `pastedBlocks` kosong untuk draft normal → 0 overhead.
- **Verifikasi:** `bun test test/composer-wrap.test.ts test/composer-box-and-paste.test.ts`

#### A2. Perbaiki `Alt+Backspace` (`ESC + 0x08`) di `prompt-engine.ts`
- **Target:** `src/ui/input/prompt-engine.ts:858-866, 1021-1116`
- **Desain:**
  1. Di `decodeKeysStream`: tepat sebelum `if (n1 >= 0x20)` (`858`), tangani `n1 === 0x08 || n1 === 0x7f` (saat `i >= pendingCount || loneEscPending`) → keluarkan `{ key: { type: "ctrl-w" }, width: 2 }` dan `i += 2` (atau `{ type: "word-backspace" }` jika ingin dipisah, tetapi memetakan ke `ctrl-w` langsung memberi hapus-kata-ke-kiri konsisten di TUI, `askLine`, dan `form` tanpa menyentuh `esc`).
  2. Sinkronkan `decodeKey` (`1114-1115`): tangani `s[i + 1] === "\x08" || s[i + 1] === "\x7f"` → `{ key: { type: "ctrl-w" }, width: 2 }`.
  3. Untuk `Alt+B` / `Alt+F` (`n1 === 0x62` / `0x66` dll. di `858`): tetap aman di Track B jika ingin word-jump, tetapi minimal `\x1b\x08` tidak lagi memancarkan `esc`.
- **Verifikasi:** `bun test test/prompt-engine.test.ts test/fuzz-prompt.test.ts test/tui-app.test.ts`

#### A3. Teruskan `AbortSignal` ke `promptAsk` + serialisasi approval modal paralel
- **Target:** `src/policy/permission.ts:90-101, 1580-1595`, `src/ui/approval/prompt.ts:34-47, 342-474`, `src/daemon/approvals.ts:333` (cek kompatibilitas parameter opsional)
- **Desain:**
  1. Tambah properti opsional `signal?: AbortSignal` ke parameter `PermissionAsk` dan `ApprovalRequest` (`cli/setup.ts` dan `ApprovalBroker` tetap kompatibel penuh karena opsional).
  2. Di `gatedPrompt` (`permission.ts:1582`), teruskan `signal` di objek `ask({ ..., signal })`.
  3. Di `promptAsk` (`src/ui/approval/prompt.ts:422`), teruskan `call.signal` ke `readModalInput(..., call.signal)` dan tangkap `AbortError` agar mengembalikan `"deny"` (atau biar `raceAbort` yang menang setelah `finally` merapikan `clearRegion()` + `sink.resume()` + `setRawMode(false)`).
  4. Tambahkan antrean/mutex ringan module-scope di `src/ui/approval/prompt.ts` (`let promptQueue = Promise.resolve()`) yang membungkus `promptAsk` dan `promptAskText` sehingga dua tool paralel di `parallelExecutor` (`concurrency = 6`) mengantre rapi satu per satu alih-alih saling menimpa `paintRegion` dan `stdin.on("data")`. Catatan: periksa `call.signal?.aborted` **sebelum** menunggu dan **setelah** mendapat giliran antrean!
- **Verifikasi:** `bun test test/approval-prompt.test.ts test/approval-tui.test.ts test/presentation-events.test.ts test/audit-fix-approval-hardening.test.ts`

#### A4. Lepas writer lease (`ctx.close()`) sebelum respawn auto-update & rapikan progres startup
- **Target:** `cli/auto-update.ts:58-68, 146-171`, `cli/index.ts:444-554`, `cli/tui.ts:509-545`
- **Desain:**
  1. Tambah hook opsional `onBeforeRespawn?: () => Promise<void> | void` pada `maybeAutoUpdate`: panggil `await opts?.onBeforeRespawn?.()` tepat sebelum `spawn(...)` (`auto-update.ts:165`) **dan** sebelum `process.exit(1)` pada rollback gagal (`auto-update.ts:153`). Di `cli/index.ts:531`, isi `onBeforeRespawn: () => ctx.close()`.
  2. Di `createStartupProgress` (`cli/tui.ts:509-545`): tambahkan guard `!(opts?.env ? true : process.stderr.isTTY)` atau flag `ttyOnly` (default aktif ketika `write` & `env` produksi tidak disuntik mock, atau cek `Boolean(opts?.write) || process.stderr.isTTY === true`) dan di `cli/index.ts:444` hanya nyalakan bila `enterRepl && process.stderr.isTTY`. Perbaiki `resume: Boolean(resumeId)` (bukan `sessionFlag`, agar `--session <new>` menampilkan `start`, bukan `update`).
  3. Pastikan `startupProgress.finish()` dipanggil sebelum `process.exit(...)` di blok `catch` (`cli/index.ts:491-505`), serta tangkap `SessionNotFoundError`, `SessionBusyError`, `SessionAliasError`, `SessionKeyCollisionError` di `catch` tersebut dengan pesan actionable + hint `minicode sessions list` + `process.exit(1)` (tanpa jatuh ke `unhandled rejection`).
  4. Di `cli/index.ts:520-554`: jangan tulis `update ${pct}%\r` kecuali `MINICODE_STARTUP_PROGRESS !== "0"` dan `process.stderr.isTTY`, dan **jangan** tulis `update 33%` sebelum `checkForUpdateFresh` benar-benar menemukan `latest` (atau hapus/pindahkan `writeUpdate` ke fase `install`/`restart` saja agar startup normal tanpa update tetap 0 byte, sesuai komentar `cli/index.ts:551-552`).
- **Catatan writer-inventory:** tetap dalam batas `cli/index.ts` (38) — gunakan ulang `console.error` yang sudah ada di blok `catch` (`cli/index.ts:492, 502`) untuk kelas error sesi!
- **Verifikasi:** `bun test test/audit-fix-startup-progress.test.ts test/update-command.test.ts test/concurrency-cross-process.test.ts`

---

### Gelombang 2 — Composer Ergonomics, Mentions, & Validasi Input (P1)

#### A5. `menuOpen` hanya aktif bila ada kandidat slash command
- **Target:** `src/ui/input/prompt-engine.ts:206-214`, `src/ui/tui/app.ts:1279-1288, 1331, 2856`
- **Desain:**
  1. Di `prompt-engine.ts` (`withLine`), ubah `menuOpen: line.startsWith("/") && countOf(line) > 0` (kecuali saat pemanggil menyetel `menuOpen: false` via `setLine`).
  2. Di `app.ts` (`deleteComposerSelection` & paste token delete), gunakan `const hintCount = nextLine.startsWith("/") ? this.host.listCommands(nextLine).length : 0; const menuOpen = hintCount > 0`.
  3. Di `cli/tui.ts:1085` (`suggestions`), ubah filter menjadi case-insensitive `t.toLowerCase().startsWith(line.toLowerCase())` sehingga `/HELP` tetap menampilkan `/help` dan dapat disubmit dengan `Enter`.
  4. Di `app.ts:1487, 822-827`: saat `turn:completed` (`823`), jangan memanggil `closeMenu()` jika `this.editing && this.state.line.startsWith("/") && this.host.listCommands(this.state.line).length > 0` — justru buka kembali `menuOpen = true` agar menu langsung muncul setelah turn selesai jika user sedang mengetik `/...`.
- **Verifikasi:** `bun test test/prompt-engine.test.ts test/fuzz-prompt.test.ts test/tui-app.test.ts`

#### A6. Ekspansi `@mentions` di jalur `steer` + lebar `pushUser` yang tepat
- **Target:** `cli/tui.ts:1330-1336, 1484, 1885, 1967-1975`, `src/ui/tui/transcript.ts:471-475, 1058`
- **Desain:**
  1. Ekstrak helper lokal di `cli/tui.ts` untuk `expandMentionsWithNotes(text)` dan terapkan juga sebelum `ctx.session.steer?.(finalLine)` (`cli/tui.ts:1967`) — jika `line.includes("@")`, expand dulu (atau jaga fallback ke `queuedPrompts` jika turn selesai selama `await expandMentions`).
  2. Beri seam baca lebar chat di `TuiApp` (`getChatWidth(): number`, mengembalikan `this.chatWidth()` — opsional di `runTui`) atau teruskan lebar chat saat `cli/tui.ts:1484, 1885, 1971` memanggil `transcript.pushUser(text, chatW)`.
  3. Di `transcript.ts:471-475`: kurangi `FRAME_HORIZONTAL_MARGIN` (6) di `userEchoWidth()`, dan di `transcript.ts:1058`: ganti `Math.max(40, availableWidth - 1)` menjadi `Math.max(10, availableWidth - 1)` (atau cek apakah ada test yang mengunci `Math.max(40, ...)` — di `test/tui-transcript.test.ts:652-701` nilai yang diuji adalah `availableWidth = 60`, bukan `< 41`, jadi `Math.max(10, ...)` aman dan mencegah double-wrap di terminal 20–46 kolom!).
- **Verifikasi:** `bun test test/file-mention.test.ts test/tui-transcript.test.ts test/tui-queue.test.ts`

#### A7. `Ctrl+R` reverse-i-search interaktif di `TuiApp` (paritas `askLine`) + klik mouse saat busy + hit-test kotak composer
- **Target:** `src/ui/tui/app.ts:1272-1275, 1849-1858, 2561-2574, 2664-2679`
- **Desain:**
  1. Perbaiki `Ctrl+R` di `TuiApp`: simpan state pencarian `{ query, matchIdx, savedLine, savedPastes }` — saat `Ctrl+R` pertama ditekan, mulai dari query saat ini (atau mode ketik query dengan status footer `reverse-i-search: <q>`), dan tiap `Ctrl+R` berikutnya memajukan `matchIdx` ke kecocokan substring (case-insensitive) yang lebih lama, sementara `Esc` membatalkan & mengembalikan `savedLine`/`savedPastes`! (Tetap jaga `isBusy()` menahan `Ctrl+R` seperti kontrak saat ini.)
  2. Izinkan klik & drag seleksi di dalam kotak composer saat `isBusy()` (`app.ts:2665`: hapus `!this.isBusy()`, cukup `if (this.editing)`), dan perbaiki `resolveComposerCursor` (`app.ts:2562`) agar `chatX` dibatasi `this.composerBoxWidth()`, bukan `layout.contentCols` — sehingga klik di ruang kosong kanan luar bingkai kotak composer tidak menggerakkan caret.
  3. Di `handleKey` (`app.ts:1150`): hapus `!this.isBusy()` pada `if (key.type === "esc" && this.composerSelectionRange())` agar `Esc` membatalkan seleksi teks composer lebih dulu sebelum meng-abort turn (simetris dengan seleksi transkrip di `app.ts:1161`).
- **Verifikasi:** `bun test test/tui-app.test.ts test/composer-box-and-paste.test.ts`

#### A8. Perbaiki `form.ts` (bracketed paste, kursor akhir `initial`, `Ctrl+A` select-all, wrap error) & `wizard.ts` (retry/tooSmall)
- **Target:** `src/ui/runtime/screen.ts`, `src/ui/screens/form.ts:140, 279, 509-568`, `src/ui/screens/wizard.ts:151-157, 279-306`
- **Desain:**
  1. Tambah method `setBracketedPaste?(enabled: boolean): void` di `AltScreen` (`screen.ts`) yang menulis `\x1b[?2004h` / `\x1b[?2004l` menggunakan writer handle yang sudah ada (sehingga `writer-inventory` untuk `form.ts` tetap `max: 1`!). Panggil di `runForm` saat mount/finish.
  2. Di `form.ts:140`: ubah `cursor: typeof def.initial === "string" ? toGraphemes(sanitizeAnsiLine(def.initial)).length : 0` (kursor di ujung nilai awal), tangani `k.type === "selectAll"` (`Ctrl+A` → lompat ke `0` atau seleksi penuh; minimal tidak diabaikan), dan wrap `st.error` memakai `wrapByWidth` alih-alih `cut(...)` satu baris.
  3. Di `wizard.ts:152-157`: jika `!canRenderModal(...)`, cetak pesan `tSystem("msg.tooSmall")` (lewat `console.log` atau status error, cek `wizard.ts` writer limit `1`), dan pada `detectFail` (`279-306`), ubah `waitForWizardDismiss` menjadi pilihan `r` Retry / `b` Back / `Esc` Cancel agar input URL & API key tidak terbuang sia-sia saat salah ketik atau timeout jaringan sesaat!
- **Verifikasi:** `bun test test/form.test.ts test/wizard.test.ts test/tui-geometry.test.ts`

---

### Gelombang 3 — Konsistensi Perintah, Recovery, Statusline, & CLI (P1/P2)

#### A9. Perbaiki celah perintah TUI & `/help keys` tanpa memecah `cli-help-language.test.ts`
- **Target:** `cli/tui.ts:1515-1529, 1659, 1765-1768, 1952-1964`, `cli/commands.ts:232, 238, 886, 935, 1010`, `cli/model-manager.ts:102-116`, `cli/provider-manager.ts:55-59`, `src/ui/i18n/en.ts`, `src/ui/i18n/id.ts`
- **Desain:**
  1. **`/resume` tanpa argumen di TUI (`cli/tui.ts:1765`):** jika `name === "resume" && !args`, arahkan ke `popupBuiltin("/sessions")` sehingga user yang mengikuti `err.stepsFix` / `formatStaleNotice` langsung mendapat picker sesi (tanpa menambahkan `/resume` ke `BUILTIN_COMMANDS`, sehingga `test/cli-help-language.test.ts:77, 137` tetap hijau!).
  2. **`/help` & `/help keys` (`cli/commands.ts:232, 238`, `en.ts:255, 272, 277-278`, `id.ts:261, 278, 283-284`):**
     - Perbaiki teks `help.k.lineEnds`: jelaskan `ctrl+a` = select all (atau line start jika ada draft) dan `ctrl+e` = end of line.
     - Perbaiki teks `help.k.ctrlC`: `"copy selected text"` (hapus klaim palsu `/ cancel` yang membuat user mengira `Ctrl+C` meng-abort).
     - Perbaiki `id.ts:283` (`help.k.esc`): samakan dengan `en.ts:277` (`busy: batal / keluar`).
     - Di `help.cMore` (`en.ts:255`, `id.ts:261`): tambahkan `/help full` di samping `/help keys` (periksa `test/cli-help-language.test.ts:92-94` — hanya melarang `/help tombol`, bukan `/help full`).
  3. **Validasi argumen perintah TUI:**
     - `/provider <arg>` (`cli/tui.ts:1767`): jika `args` non-kosong dan bukan `sync`, tampilkan toast usage alih-alih membuka manager sambil mengabaikan argumen.
     - `/unrestrict off` (`cli/tui.ts:1659`): samakan ke `tSystem("tui.unrestrictedOff", ...)`.
     - Busy command queue (`cli/tui.ts:1952-1964`): validasi nama command sebelum memasukkannya ke `queuedCommands`; jika tidak dikenal (bukan builtin/driver/alias/skill), langsung tampilkan `suggestSimilar` toast alih-alih mengantrekan typo.
  4. **Manager state:**
     - `cli/model-manager.ts:102-108`: jika model aktif dihapus, perbarui/kosongkan `opts.setModelOverride?.("")` / `opts.currentModel` lokal agar `(active)` tidak tertinggal.
     - `cli/provider-manager.ts:55-59`: saat `Enter` ditekan di provider tanpa model (`!row.firstModel`), tampilkan notice `"No models"` di popup alih-alih diam.
  5. **Hapus literal Indonesia hardcoded (lulus `i18n-hardcode.test.ts`):**
     - `src/ui/tui/transcript.ts:111-114` (`compactionTrimSummary` → pindah ke kunci `en.ts`/`id.ts` via `t()`).
     - `cli/setup.ts:1487` (`[resume] workspace changed...` → kunci i18n atau Bahasa Inggris teknis konsisten dengan notice `[resume]`/`[thread]` lain).
     - `src/session/rewind.ts:268-269`: cek `test/session-rewind.test.ts` dulu (mengunci `/membutuhkan BUILD/` — tetap pertahankan di `rewind.ts` atau biarkan test lock ini sampai owner memutuskan!).
- **Verifikasi:** `bun test test/cli-help-language.test.ts test/cli-commands.test.ts test/i18n.test.ts test/i18n-hardcode.test.ts test/model-manager-flows.test.ts test/provider-manager-flows.test.ts`

#### A10. Perbaiki `emitDelegateRecoveryLines` di TUI aktif + `statusline.ts` timer leak
- **Target:** `cli/index.ts:51-68, 569-578`, `cli/tui.ts:1890-2000`, `src/ui/runtime/statusline.ts:219-223, 267-288`, `src/ui/runtime/spinner.ts`, `src/ui/assistant/turn-status.ts`
- **Desain:**
  1. **Recovery di TUI (`cli/index.ts:569-578`):** pertahankan tanda tangan dan panggilan literal `emitDelegateRecoveryLines(...)` (demi `test/p92-recovery-warning-envelope.test.ts:551-561`!), tetapi beri sink opsional `emitLine?: (formattedLine: string) => void` pada parameter ke-4 `emitDelegateRecoveryLines(sessionId, cwd, sinceTs, emitLine?)` (default `process.stderr.write(c.yellow(...))`). Di `cli/tui.ts`, daftarkan sink TUI di `ctx` (mis. `ctx.onRecoveryLine` atau callback dari `runTui` lewat `setTurnRecoverySink`) sehingga baris `[recovery]` masuk bersih ke `transcript.pushInfo([c.yellow(line)])` dan **tidak** menulis stderr mentah di balik alt-screen!
  2. **Transient paint overlap (`statusline.ts:267-288`):** izinkan `acquireTransientPaint(kind, paintNow, onDisplace?)` memanggil `onDisplace?.()` pada `owner` lama sebelum menggantinya, sehingga `spinner` / `turn-status` menghentikan `setInterval`-nya saat diambil alih! Di `beginInteractiveScreen()` (`219-223`), saat `screenDepth` turun kembali ke `0` dan `owner` masih aktif, panggil `owner.paintNow()` agar `loading-bar` tidak hilang diam-diam.
  3. **`spinner.ts` & `turn-status.ts`:** hormati `TERM === "dumb"` dan `motionReduced()` (`MINICODE_MOTION=0`) pada `spinner.ts`, dan samakan deteksi Windows legacy di `turn-status.ts` dengan `supportsUtf8()` (`theme.ts:19-33`, termasuk `ConEmuANSI === "ON"` dan `MSYSTEM`).
  4. **Warna `stderr` TTY terpisah (`theme.ts`):** jangan ubah `colorLevel()` (`stdout`), melainkan tambahkan helper paralel `stderrColorLevel()` / `cErr` (memeriksa `process.stderr.isTTY`) untuk `loading-bar.ts`, `spinner.ts`, `turn-status.ts`, dan pesan `stderr` di `cli/index.ts`/`cli/setup.ts`. Semua test `stdout` (`test/theme.test.ts`) tetap hijau 100%!
- **Verifikasi:** `bun test test/p92-recovery-warning-envelope.test.ts test/transient-arbitration.test.ts test/loading-bar.test.ts test/turn-status.test.ts test/theme.test.ts test/writer-inventory.test.ts`

#### A11. Perbaiki `cli/args.ts` missing-value, `cli/router.ts` (`openwork`), & subcommands UX
- **Target:** `cli/args.ts:291-323, 361-364`, `cli/router.ts:123-131`, `cli/help.ts:77-141`, `docs/cli.md:81, 100`, `cli/commands/{config,doctor,exec,openwork,pricing,providers,sessions,stats,memory}.ts`
- **Desain:**
  1. **Missing value pada value flag (`cli/args.ts:301-306, 361-364`):** bila `valueFlags.has(flag)` dan tidak pakai `=`, periksa apakah `argv[i + 1]` adalah valid value (bukan `undefined` dan bukan flag lain kecuali angka negatif). Jika tidak ada nilai valid, **jangan** `i++` (agar flag berikutnya seperti `--work-mode` tidak ikut tertelan!) dan sediakan helper `missingValueFlags(argv)` untuk memperingatkan / gagal exit 2 di `cli/index.ts` & `exec.ts`.
  2. **Typo `--flag` sebelum prompt (`cli/index.ts`):** tanpa memecah `promptFromArgs(["--plan", "refactor"])` di `test/cli-args.test.ts:29-33`, tambahkan diagnostik di `cli/index.ts` jika token `--*` sebelum prompt punya `suggestSimilar(token, KNOWN_FLAGS)` jarak ≤ 2 (mis. `--hepl`, `--verboes`) → fail exit 2 atau warning eksplisit sebelum mengirim ke LLM (lihat keputusan B4 jika ingin tolak keras semua `--*` tak dikenal).
  3. **`openwork` routing (`cli/router.ts:123-131`, `cli/commands/openwork.ts:915-972`):** gunakan `cmdArgv` (atau sinkronkan `ACTION_VALUE_FLAGS` dari `valueFlags` di `cli/args.ts`!) sehingga `minicode --model gpt-4 openwork` tidak salah menganggap `gpt-4` sebagai action; ganti `args.includes("--help")` dengan cek sebelum `--evidence` / pakai `hasHelpFlag(cmdArgv)` agar `--evidence "see --help"` tidak membuka help; pada `--json` error di `openwork.ts`, keluarkan JSON error di `stdout` sebelum exit 1.
  4. **Subcommands cleanup:**
     - `cli/help.ts`: tambahkan `--runtime` di `buildHelpJson()`, serta `-y`/`--mode` di `HELP` / `docs/cli.md`; perbaiki `docs/cli.md:81` (jelaskan `--ask` saja tetap `DISCUSS` kecuali disertai `--work-mode BUILD`) dan `docs/cli.md:100`.
     - `cli/commands/config.ts`: cek `hasHelpFlag(args)` di setiap cabang (`add`, `remove`, `set-key`, `delete-key`, `context-window`, `mcp add`, `lsp add`), samakan dukungan `--local` di `list`/`mcp list`/`lsp list`, laporkan `"not found"` saat `remove` tidak menemukan ID, dan tangkap error di `config add`.
     - `cli/commands/doctor.ts`: tampilkan peringatan bila `config`/`memory.db` korup (jangan diam menjadi `0`), perbaiki saran `minicode pricing sync` & `minicode auth login`.
     - `cli/commands/pricing.ts`: exit `1` pada `pricing show <unknown>` dan laporkan error `EACCES` di `pricing clear`.
     - `cli/commands/exec.ts`: tambahkan `--prompt`, `--output-format`, `--auto-continue`, `--max-turns` ke `EXEC_HELP`, dan beri warning `stderr` bila `--max-turns` invalid atau di-clamp ke `20`.
     - `cli/commands/stats.ts` & `memory.ts`: konsistenkan Bahasa Inggris teknis (hapus istilah Indonesia campur seperti `tak-tersedia`/`bukti`/`kapabilitas`).
- **Verifikasi:** `bun test test/cli-args.test.ts test/cli-entry.test.ts test/cli-handlers.test.ts test/cli-subcommands.test.ts test/doctor.test.ts test/p14-open-work.test.ts test/exec-json-envelope.test.ts test/exit-codes.test.ts`

---

## Track B — Perubahan UI / Kontrak Besar (Wajib Konfirmasi Pemilik Terlebih Dahulu)

Setiap item di bawah menyentuh `TERMINAL_CONTRACT.md`, `docs/OUTPUT_UX_RULES.md`, geometri/warna, atau membalik test kontrak yang sudah ada. **Sajikan opsi keputusan ini kepada pemilik sebelum dikerjakan.**

### B1. Semantik `Esc`, Double-`Esc` Idle (`/undo`), & `Ctrl+C` (`app.ts` + `H4` test lock)
- **Masalah:**
  1. `awaitingSecondEsc` bertahan 1,5 dtk meski turn sudah selesai (`H4` sengaja menguncinya agar turn cepat selesai tidak jatuh ke `/undo`, namun ini membuat `Esc` saat idle tiba-tiba keluar dari aplikasi).
  2. Double-`Esc` idle (<500ms) langsung mengeksekusi `/undo` tanpa konfirmasi.
  3. `Ctrl+C` tanpa seleksi menjadi no-op total (`test/tui-app.test.ts:1368-1384` menguncinya).
- **Opsi Keputusan Pemilik:**
  - **B1a (Aman tanpa hapus H4):** pertahankan `awaitingSecondEsc` setelah turn selesai **hanya** sebagai pelindung terhadap `/undo` (yakni `Esc` kedua saat sudah idle menjadi no-op + disarm, atau tampilkan toast `"Press Ctrl+D or /exit to quit"` alih-alih langsung `quit()`, sedangkan `Esc Esc` saat masih `busy` tetap `quit()`). Butuh update `H4` di `test/tui-app.test.ts:1346-1367`.
  - **B1b (Double-`Esc` idle):** hapus pemicu `/undo` otomatis dari `Esc Esc` idle, atau wajibkan konfirmasi 1-langkah (`Press Esc again to undo` / pindah ke `/undo` eksplisit). Butuh update `test/tui-app.test.ts:203-218`.
  - **B1c (`Ctrl+C`):** ubah `Ctrl+C` tanpa seleksi menjadi perilaku shell modern: jika ada draft → bersihkan draft + toast `"Ctrl+D / /exit to quit"`; jika `busy` → abort turn (menyamakan dengan `/help keys` atau hapus klaim cancel dari `/help keys`). Butuh update `test/tui-app.test.ts:1368-1384`.

### B2. Kontrak Dropdown `/`, Geometri Lebar `119 ↔ 120`, & Indikator Antrean/Live
- **Masalah:**
  1. `TERMINAL_CONTRACT.md:1, 45` menyebut dropdown `/` full-screen kolom 0, tetapi kode (`app.ts:2948, 3221-3233`) membatasinya ke `contentCols` (`chatCols - 6`). Juga klik pada baris menu saat ini hanya menyorot, tidak memilih/menjalankan, dan `Tab` kedua langsung mengganti WorkMode (`Discuss ↔ Build`).
  2. `TERMINAL_CONTRACT.md:208-219` masih tertulis composer 2 baris tetap, sedangkan v0.43/v0.50 implementasinya dinamis 1–2 baris (yang menggeser `viewH` 1 baris saat transisi 1↔2).
  3. Antrean prompt/command saat busy (`queuedPrompts` / `queuedCommands`) dan tail live > 3 baris (`MAX_LIVE_TAIL_ROWS = 3`) tidak punya indikator persisten di layar.
  4. Paste panjang di `steer` / `queuedPrompts` ter-ekspansi mentah ke transkrip alih-alih mempertahankan badge `{paste text N lines}`.
- **Opsi Keputusan Pemilik:**
  - **B2a:** Sinkronkan dokumen `TERMINAL_CONTRACT.md` (akui dropdown mengikuti kolom chat `contentCols` + composer dinamis 1–2 baris sebagai perilaku resmi, bukan bug), atau ubah renderer dropdown ke kolom 0.
  - **B2b:** Izinkan klik item dropdown langsung mengisi composer (atau single-click highlight + double-click/Enter pilih), dan tahan `Tab` agar tidak langsung memindah WorkMode tepat setelah autocomplete command (butuh trailing space atau jeda).
  - **B2c:** Tambah badge/baris indikator antrean persisten di status/footer (mis. `queued: 2`) dan/atau baris `+ N more running` di atas cap 3 baris live tail (`transcript.ts:3078`), serta pertahankan `{paste text N lines}` untuk gema pesan `steer`/`queued`.

### B3. Tampilan Transkrip, Blok Kode, Inspeksi Error TUI, & Konsistensi Bahasa/Tema
- **Masalah:**
  1. Blok kode di TUI tidak memakai syntax highlight (`transcript.ts:485`, berbeda dengan `simple.ts`/`markdown.ts`) dan fence tanpa tag bahasa menyatu dengan paragraf.
  2. Error tool non-kanonik hanya menulis `… · details in --verbose` tanpa cara melihat detail error asli di dalam sesi TUI.
  3. `tool-label.ts` (`tSystem`, OS locale) vs `t()` (`/lang`) membuat tampilan campur Bahasa Indonesia dan Inggris; border `#36383E` terlalu redup di sebagian tema/terminal terang.
  4. Notice `/undo` (`undo.branchNotice`, ~125 char) terpotong dan hilang dalam toast 2 detik (`cli/tui.ts:2024`), padahal memuat ID sesi asal.
  5. Approval modal memotong preview diff/command ke 1 baris (`dialogBox` + `buildDiffPreview`) dan `windowFooter` menduplikasi/kontradiksi dengan `extraHints`.
- **Opsi Keputusan Pemilik:**
  - **B3a (Code block TUI):** aktifkan `highlightCode(line, fenceLang)` + indentasi/bar kiri halus untuk isi code fence di `Transcript.renderAssistantLine`.
  - **B3b (Inspektor detail di TUI):** tambah perintah `/logs` atau `/errors` (atau `/view verbose`) yang membuka `runOutputWindow` berisi error/output tool terakhir dari jurnal sesi sehingga user tak perlu keluar TUI + restart `--verbose`.
  - **B3c (`/undo` notice & approval multi-baris):** tulis `undo.branchNotice` sebagai baris info permanen di awal transkrip sesi cabang (bukan toast 2 detik); perluas preview `approval/prompt.ts` hingga 3–5 baris terbungkus (`wrapByWidth`) untuk command/diff; bersihkan duplikasi `windowFooter` (update `test/audit-fix-window-uniform*.test.ts`).
  - **B3d (Bahasa & warna):** apakah `tSystem()` tetap mengikuti OS locale (sesuai keputusan v0.35) atau ikut `/lang` saat user eksplisit mengganti `/lang`; dan apakah border composer `#36383E` dinaikkan sedikit kontrasnya atau dibuat adaptif.

### B4. Autocomplete `@file` & Ketegasan Flag CLI Tak Dikenal
- **Masalah:** Belum ada dropdown autocomplete `@file` di composer TUI; dan flag `--typo` tak dikenal sebelum prompt masuk ke LLM (terkunci `test/cli-args.test.ts:29-33`).
- **Opsi Keputusan Pemilik:**
  - **B4a:** Tambah dropdown overlay `@` di `TuiApp` via `TuiHost.listFiles?(prefix)` (mematuhi `ui-boundary.test.ts`).
  - **B4b:** Tetap pertahankan unknown `-*` masuk prompt (dengan warning untuk `--typo` jarak ≤ 2), atau ubah aturan CLI agar `--*` tak dikenal sebelum `--` wajib exit 2 (perlu update `test/cli-args.test.ts:29-33` dan `docs/cli.md:158`).

---

## Ringkasan Urutan Eksekusi yang Disarankan

1. **Tunggu konfirmasi pemilik** untuk item **Track B** (B1–B4) sekaligus persetujuan mulai mengeksekusi **Track A**.
2. **Eksekusi Track A Gelombang 1** (A1 paste token, A2 `Alt+Backspace`, A3 `AbortSignal`+queue approval, A4 `ctx.close()` auto-update + startup progress) → verifikasi `tsc --noEmit` + test terarah.
3. **Eksekusi Track A Gelombang 2** (A5 `menuOpen`, A6 `@mention` steer + `pushUser` width, A7 `Ctrl+R` + mouse busy/bounds, A8 `form.ts` paste/kursor + `wizard.ts`) → verifikasi `tsc --noEmit` + test terarah.
4. **Eksekusi Track A Gelombang 3** (A9 `/resume`/`/help keys`/validasi/i18n, A10 recovery TUI + `statusline` + `stderr` color, A11 `cli/args.ts`/`openwork`/`config`/`doctor`/`exec`) → verifikasi `tsc --noEmit` + test terarah + `test/ui-boundary.test.ts` + `test/writer-inventory.test.ts` + `test/i18n-hardcode.test.ts`.
5. **Eksekusi item Track B yang disetujui pemilik**, update `docs/TERMINAL_CONTRACT.md` / `docs/cli.md` / `docs/repl.md` + test proteksi terkait.
6. **Gate penuh (`bun run gate:fast`)** hanya dijalankan setelah ada aba-aba pemilik.
