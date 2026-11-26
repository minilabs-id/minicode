# Audit Kenyamanan Penggunaan & UX MiniCode — 2026-11-25

- **HEAD:** `7c425a8` (`v0.50.0` + perbaikan CI Windows).
- **Sifat audit:** read-only di seluruh permukaan UX/usabilitas (TUI composer, input/paste/mouse, transkrip/markdown/error/i18n, modal/approval/onboarding/undo, CLI flags/help/startup/subcommands/statusline). Tidak ada kode atau test yang diubah; gate tidak dijalankan.
- **Catatan kebijakan (`AGENTS.md`):** Temuan di bagian **B** (menyentuh geometri, composer, caret, layout, warna, semantik tombol/ESC, atau kontrak `TERMINAL_CONTRACT.md`) **wajib konfirmasi pemilik** sebelum dieksekusi.

---

## Ringkasan P0 (Dampak Kritis — Hilang Data, Keluar Tak Sengaja, atau Macet)

### UX-P0-1. `awaitingSecondEsc` tetap aktif 1,5 detik setelah turn selesai → keluar paksa TUI saat idle
- **Lokasi:** `src/ui/tui/app.ts:822-827, 972-973, 1173-1179, 1543-1555`
- **Fakta:** `requestAbort()` menyetel `awaitingSecondEsc = true` dan `lastAbortAt = now`. Baik `turn:completed` maupun blok `finally` di `doSubmit()` tidak mereset `awaitingSecondEsc`. Di `handleKey`, cek `awaitingSecondEsc && Date.now() - lastAbortAt < 1500` dievaluasi **sebelum** `this.isBusy()`.
- **Dampak user:** Tekan `Esc` untuk abort, turn selesai < 1,5 dtk (kembali idle), lalu user menekan `Esc` lagi → seluruh aplikasi TUI langsung keluar (`this.quit()`).

### UX-P0-2. Double-`Esc` saat idle (< 500 ms) langsung menjalankan `/undo` tanpa konfirmasi
- **Lokasi:** `src/ui/tui/app.ts:1191-1196`
- **Fakta:** Saat `idle` dan composer kosong (`!this.state.line`), menekan `Esc` dua kali dalam 500 ms memanggil `void this.doSubmit("/undo")` tanpa prompt konfirmasi awal.
- **Dampak user:** Menekan `Esc` berturut-turut untuk memastikan mode/seleksi bersih dapat tiba-tiba memicu alur rollback `/undo`.

### UX-P0-3. Mengedit di sekitar/dalam placeholder `{paste text N lines}` merusak payload paste secara diam-diam
- **Lokasi:** `src/ui/tui/app.ts:1322-1350, 1375-1378, 1786-1791, 2574, 2847-2876`
- **Fakta:** Hanya `backspace` dan `delete` yang memakai `findPasteTokenAtCursor()`. Gerak `left`/`right`/`up`/`down`, klik mouse (`resolveComposerCursor`), `Ctrl+W`, dan hapus seleksi parsial dapat menempatkan kursor di tengah atau memotong token `{paste text N lines}`. Begitu teks token berubah, `pruneUnusedPasteBlocks()` langsung menghapus entri dari `this.pastedBlocks`; `Ctrl+C` pada seleksi parsial juga menyalin fragmen literal `{paste te` alih-alih isi penuh. Tidak ada aksi untuk mengintip/expand placeholder sebelum kirim.
- **Dampak user:** Salah pencet `Ctrl+W` atau klik di tengah badge paste diam-diam menghilangkan seluruh payload multiline yang baru ditempel.

### UX-P0-4. `Alt+Backspace` (`ESC + 0x08`) menghapus seluruh draft atau membatalkan turn
- **Lokasi:** `src/ui/input/prompt-engine.ts:858-866`
- **Fakta:** Pada terminal yang mengirim `ESC + ^H` (`0x1b 0x08`), `n1 < 0x20` tidak masuk cabang `n1 >= 0x20` (baris 858), sehingga baris 864 memancarkan event `esc` diikuti `backspace`. Sementara `Alt+B`/`Alt+F`/`Alt+D` jatuh menjadi huruf literal `b`/`f`/`d`.
- **Dampak user:** Kebiasaan `Alt+Backspace` (hapus satu kata ke belakang) menghapus seluruh draft (idle) atau meng-abort turn aktif (busy).

### UX-P0-5. `promptAsk` mengabaikan `AbortSignal` — modal approval menggantung di raw-mode saat timeout/abort
- **Lokasi:** `src/ui/approval/prompt.ts:342, 422-438`; `src/policy/permission.ts:90, 1582`
- **Fakta:** `PermissionAsk` dan `promptAsk` tidak menerima `signal?: AbortSignal`, dan `readModalInput` dipanggil tanpa `signal` (berbeda dengan `promptAskText` di `prompt.ts:523`). Saat `raceAbort(ask(...), signal)` terpicu, eksekusi turn berhenti sementara modal approval tetap menahan `stdin` raw-mode dan menggantung hingga idle-cancel 90 detik.

### UX-P0-6. Auto-update respawn bertabrakan dengan single-writer lease pada `--resume` / `--session`
- **Lokasi:** `cli/index.ts:451-554`; `cli/auto-update.ts:166-171`; `src/session/authority.ts:171`
- **Fakta:** Untuk REPL, `createCliSession` dijalankan lebih dulu (mengambil writer lease + `writerRenewTimer`), baru `maybeAutoUpdate` memanggil `spawn(child)` dengan argv identik dan menunggu `waitChildExit(child)` tanpa memanggil `ctx.close()`.
- **Dampak user:** Jika `minicode --resume <id>` atau `--session <id>` memicu auto-update, proses anak gagal mengambil lease (`SessionBusyError` / `REFUSED_LEASE_HELD`) dan langsung crash.

---

## Ringkasan P1 (Hambatan Nyata Alur Kerja & Kejelasan)

### 1. Composer, Input, Navigasi & Queueing
1. **State `menuOpen` tak terlihat mengunci `↑`/`↓` dan membuat `Esc` terasa macet (`src/ui/input/prompt-engine.ts:207, 281-295, 309-311`, `src/ui/tui/app.ts:1186-1190, 1279-1288, 2494-2498`):**
   `withLine()` menyalakan `menuOpen = line.startsWith("/")` meskipun daftar kandidat kosong (`/mode auto`, path `/usr/bin`, typo `/xyz`, atau saat `busy`). Akibatnya `↑`/`↓` (baik gerak baris multiline maupun histori) mati total, dan `Esc` pertama hanya mematikan `menuOpen` tanpa efek visual.
2. **Dropdown `/` melanggar kontrak lebar penuh & punya friksi interaksi (`docs/TERMINAL_CONTRACT.md:1, 45`, `src/ui/tui/app.ts:1248-1262, 2494, 2652-2663, 2948, 3221-3233`, `cli/tui.ts:1085`):**
   - Kontrak menyebut dropdown full-screen kolom 0, tetapi implementasi me-render menu selebar `contentCols` di dalam padding `3+3`.
   - Filter prefix case-sensitive (`/HELP` kosong walau `submit()` lowercase).
   - Menekan `Tab` melengkapi command dan menutup menu (`menuOpen = false`); menekan `Tab` lagi langsung mengganti WorkMode (`Discuss ↔ Build`).
   - Klik mouse pada baris menu hanya memindahkan sorotan (`sel`), tidak memilih/melengkapi.
   - Saat `busy`, dropdown disembunyikan tetapi `turn:completed` memanggil `closeMenu()`.
3. **`@` mention: tanpa autocomplete & TIDAK diekspansi saat steered di tengah turn (`src/app/mentions.ts:73-98`, `cli/tui.ts:1331-1336, 1967-1982`):**
   Tidak ada picker/autocomplete untuk `@file`, dan ketika pesan dikirim saat busy lalu masuk `ctx.session.steer(line)`, `expandMentions()` tidak dipanggil — string `@path` mentah terkirim ke model.
4. **`Ctrl+R` hanya prefix 1-kali & histori TUI tidak persisten (`src/ui/tui/app.ts:1272-1275, 1849-1858`, `cli/tui.ts:2014`):**
   Berbeda dengan `askLine` (`src/ui/input/input.ts:166-187`), `TuiApp.historySearch()` mengganti draft dengan kecocokan `startsWith` terbaru tanpa menyimpan `query`/`histIdx`, sehingga menekan `Ctrl+R` lagi tidak mencari entri lebih lama. Histori TUI juga mulai kosong tiap sesi (tidak memuat `~/.minicode/history`).
5. **Inkonsistensi input saat `busy` & `Ctrl+C` (`src/ui/tui/app.ts:1133-1155, 2664-2679`):**
   - Klik & drag seleksi mouse di composer diblokir saat `busy` (`!this.isBusy()` di `2665`), padahal mengetik, `Ctrl+A`, dan `Ctrl+C` diizinkan.
   - `resolveComposerCursor` (`2562`) mengizinkan klik hingga `contentCols` alih-alih `composerBoxWidth()` — pada terminal lebar (`cols >= 220`), klik di ruang kosong kanan luar kotak composer ikut menggerakkan kursor.
   - `Ctrl+C` tanpa seleksi adalah no-op total (tidak abort, tidak hapus draft, tidak keluar), berlawanan dengan `/help keys` (`cli/commands.ts:238`).
   - `Esc` saat `busy` dengan `composerSelection` aktif (`1150`) langsung meng-abort turn alih-alih membatalkan seleksi dulu.
6. **Antrean prompt/command saat `busy` buta & memuntahkan paste penuh ke transkrip (`cli/tui.ts:1480-1485, 1952-1982`, `src/ui/tui/app.ts:1481`):**
   - Setelah toast 2 detik hilang, tidak ada indikator persisten jumlah/isi prompt yang sedang antre maupun cara membatalkan satu item antrean.
   - `host.enqueue(expandedLine)` mengirim hasil ekspansi paste ke `transcript.pushUser(line)` (dan tanpa `chatWidth()`), membanjiri transkrip dengan ratusan baris mentah (berbeda dari submit idle yang mempertahankan `{paste text N lines}`).
   - `queuedCommands` juga menerima typo `/...` saat busy dan baru melaporkan `Unknown command` setelah turn selesai.
7. **Gema prompt user double-wrap di terminal sempit (`cols < 47`) dan lebar salah saat dipanggil tanpa `availableWidth` (`src/ui/tui/transcript.ts:471-475, 1058`):**
   `Math.max(40, availableWidth - 1)` memaksa wrap 40 kolom meski `contentCols` lebih sempit (hingga 14 kol di `MIN_COLS = 20`); saat dipanggil tanpa `availableWidth` (jalur queue/steer di `cli/tui.ts`), `userEchoWidth()` memakai `chatCols - 1` alih-alih `chatCols - 6`.

### 2. Transkrip, Feedback Tool, Markdown, Error & i18n
1. **Redaksi error tool menutup semua detail di TUI tanpa jalan lihat di dalam sesi (`src/ui/tui/transcript.ts:2568-2597`, `src/ui/render/errors.ts:442-543`, `src/ui/i18n/en.ts:23, 26, 46`):**
   Saat command gagal atau error tak cocok 21 pola kanonik, user hanya melihat `Command failed · <target> · details in --verbose` atau `Action failed · details in --verbose`. Di dalam TUI tidak ada `/verbose`, `/logs`, atau `/output` untuk melihat penyebab sebenarnya (exit stderr / error asli) tanpa keluar sesi dan menjalankan ulang CLI dengan `--verbose`.
2. **Tail aktivitas live maksimal 3 baris menyembunyikan tool paralel lain tanpa indikator jumlah (`src/ui/tui/transcript.ts:3078-3084`):**
   `.slice(-MAX_LIVE_TAIL_ROWS)` membuang baris live ke-4 dst. secara diam-diam. Saat 8–10 tool atau sub-agent berjalan paralel, user tidak tahu berapa aktivitas lain yang masih berjalan.
3. **Blok kode markdown di TUI tidak di-highlight dan tidak punya bingkai/indentasi pembeda (`src/ui/tui/transcript.ts:479-485` vs `src/ui/render/markdown.ts:97, 115`):**
   `decorateMarkdown` (mode non-TUI) memanggil `highlightCode(line, fenceLang)`, sedangkan `renderAssistantLine` di `transcript.ts` mengembalikan `line` mentah saat `inside` fence (tanpa syntax highlight) dan mengembalikan `null` untuk fence tanpa tag bahasa (`open:` kosong), sehingga blok kode tanpa bahasa menyatu dengan paragraf biasa.
4. **Bahasa campuran (mixed Indonesian/English) & string hardcoded (`src/ui/render/tool-label.ts:40-56`, `src/ui/i18n/locale.ts:44-55`, `src/ui/tui/transcript.ts:111-114`, `cli/setup.ts:1487`, `src/session/rewind.ts:268-269`):**
   - `tool-label.ts` (`humanToolLabel`, `tSystem`) memakai locale OS (`Intl`), sementara `t()` memakai `/lang` / `LANG`. Pada Windows ber-locale `id-ID` (atau user Indonesia yang memakai `/lang en`), label tool & toast error keluar dalam Bahasa Indonesia sedangkan `/help`, status, dan `+ thinking` keluar dalam Bahasa Inggris (dan sebaliknya).
   - `compactionTrimSummary()` (`transcript.ts:111-114`), `cli/setup.ts:1487`, dan `src/session/rewind.ts:268-269` berisi string Indonesia hardcoded walau `/lang en` aktif; `cli/commands/stats.ts:34, 85` dan `cli/commands/memory.ts:9-10, 66, 72` mencampur istilah Indonesia-Inggris.
5. **Warna border & palet hanya untuk terminal gelap (`src/ui/render/theme.ts:5, 174, 536-541`):**
   Border composer (`#36383E` / `236`) dan `faint` (`#484848` / `238`) nyaris tak terlihat di tema gelap tertentu dan kontrasnya sangat rendah / terasa asing di terminal terang.

### 3. Slash Commands, Approval Modal, Wizard, Manager & Recovery
1. **`/resume` tanpa argumen di TUI no-op diam-diam (`cli/tui.ts:1765-1766`, `cli/commands.ts:935-937`):**
   Pesan `err.stepsFix` dan `formatStaleNotice` menyuruh user menjalankan `/resume`, tetapi `/resume` tanpa argumen mengembalikan `{ handled: false }` dan tidak membuka picker maupun menampilkan petunjuk.
2. **`/help` menyesatkan & tidak lengkap (`cli/commands.ts:232, 238, 710`, `cli/tui.ts:1515-1529`, `src/ui/i18n/id.ts:283`):**
   - `/help keys` menulis `ctrl+a / ctrl+e` = `"line start / end"` (aktual `Ctrl+A` = select all) dan `ctrl+c` = `"copy / cancel"` (aktual `Ctrl+C` tidak pernah cancel/abort).
   - `/help` ringkas tidak menyebut adanya `/help full` / `/help all`.
   - `id.ts:283` (`help.k.esc`) tidak menyebut `/ keluar` pada double-Esc saat busy.
3. **Approval modal: tanpa serialisasi paralel & konteks dipotong ke 1 baris (`src/policy/executor.ts:289-320`, `src/policy/permission.ts:772-844`, `src/ui/approval/prompt.ts:361-391`, `src/ui/screens/dialog.ts:133`):**
   - Tool paralel yang memicu `promptAsk` bersamaan saling menimpa `paintRegion` dan berebut `stdin.on("data")`.
   - `buildDiffPreview` untuk `write_file`/`edit` hanya mengirim baris pertama (maks 80/120 char) tanpa jumlah baris/byte; `promptAsk` menaruh `summaryLine` di 1 baris tanpa wrap lalu dipotong `dialogBox` (`truncateToWidth`), sehingga di terminal 80 kolom (`innerW = 52`) isi perintah/diff sering terpotong setelah nama path.
4. **Onboarding `wizard.ts` & `form.ts` kurang ramah paste & navigasi mundur (`src/ui/screens/form.ts:140, 456-468, 546-568`, `src/ui/screens/wizard.ts:187-245, 277-306`):**
   - `form.ts` tidak menyalakan bracketed paste (`\x1b[?2004h`), sehingga paste API key berujung newline di onboarding langsung men-submit form.
   - `toState()` menyetel `cursor = 0` untuk nilai awal (`initial`), menempatkan kursor di depan `https://` alih-alih di akhir.
   - Tidak ada tombol Back antar langkah maupun Retry saat `detectFail` (gagal langsung membuang input URL/key), dan teks gagal `wiz.keyLater` menyebut `OPENAI_API_KEY` secara hardcoded.
   - `windowFooter` (`src/ui/screens/window.ts:41-48`) selalu menyisipkan `↑↓ move  Enter select  Esc cancel` sebelum `extraHints`, menghasilkan duplikasi/kontradiksi hint di `output-window.ts`, `wizard.ts`, dan `form.ts` (mis. `Enter select` sekaligus `Enter close` atau `Esc cancel` muncul 2×).
5. **Pemberitahuan cabang `/undo` hilang dalam 2 detik & recovery warning menulis stderr mentah ke alt-screen (`cli/tui.ts:2024`, `cli/index.ts:51-68, 570-578`, `cli/setup.ts:1513`):**
   - `MINICODE_REWIND_NOTICE` (`undo.branchNotice`, ~125+ char memuat ID sesi asal) ditampilkan via `app.showToast()` yang terpotong satu baris dan hilang dalam 2 detik.
   - `emitDelegateRecoveryLines` menulis langsung ke `process.stderr` saat TUI memegang alt-screen, sehingga segera tertimpa oleh `paintCurrent()`.
   - `cli/setup.ts:1513` merujuk `"see system note"` yang hanya masuk ke system prompt LLM dan tidak bisa dibaca user.

### 4. CLI Entry, Startup & Subcommands
1. **Flag typo & flag tanpa nilai diam-diam dikirim sebagai prompt LLM (`cli/args.ts:110-146, 301-320, 340-363`):**
   `minicode --hepl` atau `minicode --model --work-mode BUILD "hi"` tidak gagal dengan exit 2: flag asing langsung dianggap kata prompt pertama, dan flag nilai yang kehilangan argumen menelan token `--work-mode` berikutnya lalu menjadikan `BUILD` sebagai prompt.
2. **Inkonsistensi `docs/cli.md` / `HELP` / `--ask` (`docs/cli.md:81, 100`, `cli/args.ts:249-255, 280`, `cli/help.ts:22-142`):**
   `docs/cli.md:81` mengklaim `--ask` menyetel `BUILD + ASK`, padahal `--ask` hanya menyetel permission mode sehingga `minicode --ask "edit"` tetap berada di `DISCUSS` (hanya-baca). CLI `--mode` hanya alias `--work-mode` (menolak `ask` dengan pesan `--work-mode`), berbeda dari TUI `/mode` yang menerima keduanya.
3. **`createStartupProgress` & auto-update mencemari stderr non-TTY dan memalsukan progres (`cli/index.ts:445, 493-509, 522-553`, `cli/tui.ts:515-521`):**
   - `createStartupProgress` menulis `start 11%\r` ke stderr bahkan saat one-shot/pipe/non-TTY, dan tidak menjalankan `finish()` pada cabang `process.exit()` di `catch` (`cli/index.ts:493, 503`).
   - `maybeAutoUpdate` memicu `onPhase("check")` sebelum tahu apakah ada update, sehingga setiap startup normal tetap mencetak `update 33%\rupdate 100%\n`.
   - `SessionNotFoundError` (`--resume` salah) / `SessionBusyError` tidak ditangani sebagai error CLI bersih melainkan jatuh ke `installCrashGuard` (`unhandled rejection`).
4. **Arbritrasi `statusline.ts` & TTY stderr di `theme.ts` (`src/ui/runtime/statusline.ts:227-288`, `src/ui/render/theme.ts:58`):**
   - `acquireTransientPaint` menimpa `owner` tanpa menghentikan `setInterval` milik painter sebelumnya sehingga dua timer dapat menimpa baris stderr bersamaan.
   - `theme.ts` hanya mengecek `process.stdout.isTTY`, bahkan untuk painter `stderr` (`loading-bar.ts`, `spinner.ts`, `turn-status.ts`): `> out.txt` mematikan warna stderr TTY, sementara `2> err.log` membocorkan ANSI ke file log.
5. **Subcommand `openwork` & `config` (`cli/commands/openwork.ts:915-969`, `cli/commands/config.ts:120-526`):**
   `openwork` salah membaca nilai global flag (`--model gpt-4 openwork`) sebagai action; `config <subcmd> --help` gagal exit 2; `config remove` selalu mencetak `ok` walau ID tidak ada; `--json` diabaikan pada banyak subcommand (`sessions list`, `config list`, `providers`, `auth`, `skills`, `pricing`).

---

## Ringkasan P2 & P3 (Kenyamanan Tambahan & Poles)

- **Shortcut editor yang hilang / kurang konsisten (`prompt-engine.ts:272-280, 1107-1112`):** tidak ada `Ctrl+Enter` (`13;5u`), Kitty event suffix (`13;2:1u`), `Ctrl+K` (kill to EOL), lompat kata (`Ctrl/Alt+Left/Right`), maupun `Home`/`End` per baris pada draft multiline (`Home`/`End`/`Ctrl+U` selalu berlaku ke seluruh draft).
- **Navigasi & terminal sempit (`app.ts:1185, 2991-2999, 3205-3207`, `chat-column.ts:21-25`):**
  - Saat `tooSmall()`, tidak ada petunjuk `Ctrl+D` di layar.
  - `indicatorLine` (toast / `N new`) menggantikan seluruh footer; `retryLine` memotong bagian kanan footer (konteks/cost/permission).
  - Transisi lebar `cols = 119 ↔ 120` membelah lebar chat tiba-tiba dari `119` ke `60`.
  - Tidak ada `--continue` untuk resume sesi terakhir, dan tidak ada mekanisme membuka ulang output `/status`/`/help`/`/sessions` tanpa menjalankan ulang command.
- **Kejujuran state di Manager & Slash Command (`cli/model-manager.ts`, `cli/provider-manager.ts`, `cli/commands.ts`):**
  - `Tab` di `/model` mengubah `reasoningEffort` tingkat **provider** tapi berlabel seolah per-model (`(next session)`).
  - Menghapus model aktif tidak memperbarui label footer/aktif hingga reload.
  - `/provider <arg>` selain `sync` mengabaikan argumen diam-diam; `/sessions <typo>` dianggap ID sesi; `/clear` tidak menjelaskan apakah konteks LLM ikut terhapus atau tetap disimpan.
  - 5 dari 7 modal (`picker`, `model-manager`, `provider-manager`, `output-window`, `wizard`) langsung auto-cancel pada detik ke-90 tanpa peringatan 10 detik sebelumnya (tidak seperti `form.ts` dan `approval/prompt.ts`).
- **`doctor.ts` (`40, 45-47, 120-127`):** menelan error parse config/DB menjadi angka `0`, dan menyarankan `pricing sync` tanpa awalan `minicode`.

---

## Pemilahan Tindakan (Sesuai `AGENTS.md`)

### A. Perbaikan/Tuning Sempit (Dapat dikerjakan tanpa mengubah layout/kontrak UI besar)
1. **Bug keamanan & keandalan input/state:**
   - Reset `awaitingSecondEsc` saat `turn:completed` dan `finally` di `doSubmit()` (`app.ts`).
   - Tangani `ESC + 0x08` (`Alt+Backspace`) dan tambahkan proteksi atomik token `{paste text N lines}` pada gerak kursor/`Ctrl+W`/seleksi parsial (`prompt-engine.ts`, `app.ts`).
   - Pastikan `menuOpen` hanya aktif bila `listCommands(line).length > 0` atau sinkronkan dengan menu terlihat (`app.ts`, `prompt-engine.ts`).
   - Teruskan `AbortSignal` ke `promptAsk` dan serialisasikan antrean modal approval (`permission.ts`, `approval/prompt.ts`).
   - Panggil `expandMentions` di jalur `steer` (`cli/tui.ts`) dan teruskan `this.chatWidth()` di `pushUser` jalur queue/steer.
   - Tutup sesi/lease induk (`ctx.close()`) sebelum respawn auto-update, tangani `SessionNotFoundError`/`SessionBusyError` secara bersih, dan cegah `createStartupProgress`/`update` menulis `\r` ke non-TTY (`cli/index.ts`, `cli/tui.ts`).
   - Cek validasi flag CLI unknown/missing-value di `cli/args.ts` + sinkronkan `/help keys`, `/resume` tanpa argumen (arahkan ke `/sessions` picker), dan hapus string Indonesia hardcoded (`transcript.ts:111-114`, `setup.ts:1487`, `rewind.ts:268`).
   - Aktifkan bracketed paste + posisi kursor di akhir `initial` pada `form.ts`.

### B. Perubahan Berdampak Besar ke UI / Kontrak (Wajib Konfirmasi Pemilik Terlebih Dahulu)
1. **Geometri / Composer / Frame (`TERMINAL_CONTRACT.md`):**
   - Menyelaraskan kontrak tinggi composer (1–2 baris dinamis vs 2 baris tetap), lebar dropdown `/` (mengikuti `contentCols` vs full-screen kolom 0), serta lompatan lebar `119 ↔ 120` di `chat-column.ts`.
   - Mengubah/menghapus double-`Esc` idle → `/undo`, menambah perilaku `Ctrl+C` (abort/clear/double-press exit), atau menambah `Ctrl+Enter`/navigasi `@file` autocomplete & indikator antrean persisten.
2. **Transkrip / Warna / Feedback Error & Tool:**
   - Menambah syntax highlighting / bingkai blok kode di `Transcript`, menampilkan indikator `+N running` di atas cap 3 baris live tail, atau menyediakan inspektor detail error/output di dalam TUI (mengurangi kebutuhan restart `--verbose`).
   - Menyatukan bahasa tampilan (`tool-label.ts` / `tSystem` OS locale vs `/lang`) dan penyesuaian kontras tema terang/gelap (`#36383E`).
   - Mengubah mekanisme tampilan notice `/undo` dari toast footer 2 detik ke entri transkrip/banner, serta memperluas multi-baris preview diff/command pada modal approval.
