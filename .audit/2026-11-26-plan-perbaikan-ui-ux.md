# Plan Perbaikan Stabilitas UI & UX MiniCode

**Tanggal:** 2026-11-26  
**Basis:** [2026-11-26-audit-stabilitas-ui-ux.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-stabilitas-ui-ux.md) (16 temuan terverifikasi: 11 P1, 5 P2).  
**Status:** Dieksekusi & diverifikasi pada kandidat **v0.52.1** (`T1`–`T12` + `U1`–`U4` diterapkan dan didokumentasikan di `docs/TERMINAL_CONTRACT.md`). Mengacu ke `AGENTS.md`:
- **Jalur A (`[TUNING]` — 12 item):** aman langsung dieksekusi setelah aba-aba, tanpa mengubah geometri, layout, composer, caret, ratchet, rekap, warna, writer, atau I1.
- **Jalur B (`[UI-IMPACT]` — 4 item):** menyentuh perilaku layout, ratchet, status live, atau kontrak `docs/TERMINAL_CONTRACT.md` — **wajib konfirmasi pemilik sebelum dikerjakan**.

---

## Ringkasan Dampak Lintas Sistem Setelah Diperbaiki

1. **Komposer & Turn Sibuk (T1–T2):** Mengetik `/` atau `@` saat AI bekerja tak lagi membuka menu hantu atau membajak panah/`Enter`; steer `@mention` yang gagal tak lagi lenyap diam-diam.
2. **Dialog Modal & Manager (T3–T6):** `/provider` Add/Edit responsif terhadap `Esc`/`Ctrl+C` dan resize selama `"Detecting models…"`; `ask_user` (`promptAskText`) aman dari crash listener `'data'`, membungkus pertanyaan panjang, dan menggeser daftar opsi saat dipilih; `form.ts` tak lagi mendorong kursor ke border saat error panjang; `model-manager` konsisten pada `Ctrl+U`/`Del`/`Esc`.
3. **Footer, Summary, Wizard, Renderer & CLI (T7–T12):** Hapus model terakhir menampilkan `"no model"`/`"belum ada model"` alih-alih kolom kosong; ringkasan keluar tidak menghitung ganda `"other"` & selalu mensanitasi `info.model`; highlight komentar `highlight.ts` akurat pada `"foo\\"`; pesan `/context` dan `auto-update` mengikuti `/lang`.
4. **Opsional Perlu Persetujuan Pemilik (U1–U4):** Mengisi jeda sunyi saat `/view thinking` live, menstabilkan posisi gulir saat eviksi 5000 baris tengah turn, mencegah terpotongnya teks `runningLine`/badge footer di lebar sempit, dan membuat wrap prompt user lama ikut menyesuaikan resize.

---

## Jalur A — Rencana Perbaikan `[TUNING]` (12 Item)

### T1. Matikan pembukaan menu `/` & `@` saat turn sibuk + bersihkan guard di 4 titik
- **Target:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L1410-L1520), [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3163-L3170)
- **Masalah:** `BUSY_TYPING_KEYS` mengizinkan `up`/`down`/`enter` saat sibuk, sementara `applyEngine` (`L1513`), delete token paste (`L1410`, `L1441`), dan `deleteComposerSelection` (`L3163`) menyalakan `menuOpen = true` walau `menuRows` menyembunyikannya. `Enter` lalu memicu `prompt-engine.ts:327` `pickSelected` yang menimpa seluruh ketikan dengan item tersembunyi.
- **Desain perbaikan:**
  - Ekstrak satu helper privat `computeMenuState(line, cursor, prevSel, busy)` di `TuiApp`: bila `busy` bernilai `true`, kembalikan `{ menuOpen: false, sel: -1 }`; bila `false`, sinkronkan dari `activeSuggestions(...)`.
  - Pakai helper tunggal ini pada ke-4 titik mutasi composer (`L1410`, `L1441`, `L1513`, `L3163`).
- **Dampak setelah diperbaiki:**
  - `Up`/`Down` saat busy **selalu** memindahkan kursor vertikal atau histori input — tidak pernah macet.
  - `Enter` saat busy **selalu** mengirim/steer teks asli yang diketik user (tanpa substitusi item dropdown tersembunyi).
  - Saat turn kembali idle, dropdown tidak muncul tiba-tiba sampai user mengetik/mengedit lagi.
- **Verifikasi target:** `bun test test/tui-app.test.ts test/tui-queue.test.ts` + tambah skenario busy mengetik `/m` lalu `Down` & `Enter`.

### T2. Tangani gagal & transisi idle pada async `@mention` steer di `host.enqueue`
- **Target:** [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L2416-L2460), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L1023)
- **Masalah:** Saat busy, prompt berisi `@` langsung menghapus composer dan menampilkan toast `"steered"` sementara `expandMentions(...)` berjalan async dengan `.catch(() => {})` yang menelan kegagalan, serta berisiko balapan dengan auto-resume job latar bila turn keburu selesai sebelum `.then` berjalan.
- **Desain perbaikan:**
  - Tambah counter `pendingMentionSteers = 0` di `runTui` (inkremen sebelum `expandMentions`, dekremen di `.finally`) dan masukkan `pendingMentionSteers > 0` ke kondisi `!idle` pada `onBackgroundJobFinished`.
  - Ganti `.catch(() => {})`: bila tidak dibatalkan (`!turnState.abortRequested && gen === turnGen`), tampilkan catatan warning via `transcript.pushInfo` dan tetap salurkan pesan mentah `line` ke steer/queue agar pesan user tidak hilang.
  - Tahan atau bedakan toast: kirim toast `"steered"` / `"queued"` setelah `expandMentions` benar-benar masuk `steer` atau `queuedPrompts` (atau saat `enqueue` beri status `"resolving @..."` singkat).
- **Dampak setelah diperbaiki:** Kegagalan membaca berkas `@mention` saat busy tidak lagi menghilangkan pesan user secara diam-diam, dan turn dari `@mention` tertunda tidak bertabrakan dengan auto-resume job latar.
- **Verifikasi target:** `bun test test/tui-queue.test.ts test/file-mention.test.ts`.

### T3. Dukungan batal `Esc`/`Ctrl+C` + resize pada `/provider` Add/Edit + sinkronisasi delete/select + progres `model-manager`
- **Target:** [src/ui/screens/provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L177-L202), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L359-L528), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L436), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L624-L628); [cli/provider-manager.ts](file:///d:/Github/minicode/cli/provider-manager.ts#L64-L133); [src/ui/screens/model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L525-L545)
- **Masalah:** `doAdd` dan `doEdit` memanggil `suspend()` lalu merender `"Detecting models…"` dan menunggu hingga 60 dtk tanpa listener `Esc`, tanpa `onResize`, dalam cooked mode (`setRawMode(false)`), sementara footer masih memajang tombol daftar. Di `enter`, exception `opts.onSelect` ditelan `catch {}`; di `doDelete`, pengecekan model aktif memakai `opts.currentModel` statis bukan `getCurrentModel()`.
- **Desain perbaikan:**
  - Perluas signature opsional `onAdd(input, signal?)` dan `onEditSave(row, input, signal?)` pada `ProviderManagerViewOptions`; `cli/provider-manager.ts` meneruskan `signal` tersebut ke `detectAndSave(..., { ..., signal })` (sudah didukung `src/providers/provision.ts:160`).
  - Saat fase jaringan `doAdd`/`doEdit` di `provider-manager.ts`: pasang helper cancel + resize sementara (pola `wizard.ts:198` `attachProgressCancel`), dan render `windowSpec({ role: "progress", escHint: true, ... })` selama proses berlangsung. Bila `ac.signal.aborted`, tampilkan `notice = t("common.canceled")` (`info`).
  - Di `provider-manager.ts`: pada `doDelete` gunakan `opts.getCurrentModel ? opts.getCurrentModel() : opts.currentModel`; pada `enter` tangkap error `opts.onSelect(p)` ke `notice = formatError(e); noticeKind = "error"; render()` alih-alih ditelan diam.
  - Di `model-manager.ts:525`: sebelum `suspend()` saat `Enter` (`onSelect`), tampilkan `notice` info singkat atau hanya `suspend()` saat perlu (atau biarkan layar tampil dengan `busy = true` selama `onSelect` singkat — tanpa menghapus bingkai modal menjadi kosong selama 60 dtk saat timeout). *(Cek `test/model-manager-flows.test.ts:554-603`: test hanya mengecek pesan error/timeout tampil dan `waitForListener` pulih!)*
- **Dampak setelah diperbaiki:**
  - Tekan `Esc` / `Ctrl+C` saat tambah/edit provider langsung membatalkan deteksi jaringan dan memulihkan daftar secara responsif (tak perlu menunggu timeout 60 dtk, tak ada ketikan mentah bocor ke layar, footer tak berbohong soal tombol `a/e/d`).
  - Error saat `onSelect` provider tampil rapi di kotak notice; konfirmasi hapus provider aktif memakai model live terkini.
- **Verifikasi target:** `bun test test/provider-manager-flows.test.ts test/model-manager-flows.test.ts test/hang-fix.test.ts`.

### T4. Perbaiki `readModalInput` crash-guard + wrap pertanyaan & scroll opsi di `approval/prompt.ts`
- **Target:** [src/ui/approval/prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L298-L303), [prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L339-L371), [prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L573-L615)
- **Masalah:** `onData` tak punya `try/catch` (throw di handler EventEmitter menjatuhkan proses) & tak memanggil `process.stdin.resume()`; `promptAskText` tak membungkus `q` (`wrapByWidth`) sehingga pertanyaan > 1 baris terpotong `…`; `focusRow` dipaku ke baris input sehingga panah `Up`/`Down` pada `options[]` panjang memilih opsi yang keluar layar. *(Catatan: `promptAsk` `moveCursor` dipertahankan karena dikunci `test/approval-tui.test.ts:285-305`.)*
- **Desain perbaikan:**
  - Di `readModalInput`: bungkus `pump.push(...)` dengan `try/catch` yang memanggil `finish(null as R)` bila gagal, dan panggil `process.stdin.resume()` di dekat `setRawMode(true)`.
  - Di `promptAskText`: bungkus `q` menggunakan `wrapByWidth` dengan lebar `Math.max(10, windowWidth(process.stdout.columns || 80) - 6)` berindentasi `"  "` (recompute di callback render saat resize!); arahkan `focusRow` ke indeks opsi tersorot `qLines.length + sel` bila `sel >= 0`, dan ke baris input bila `sel < 0`. *(Cursor input `moveCursor` hanya dipanggil saat input bar visible di viewport — sudah dijaga `L360`.)*
- **Dampak setelah diperbaiki:**
  - Error internal di modal `approval`/`ask_user` tak pernah meruntuhkan proses Node/Bun.
  - Pertanyaan `ask_user` yang panjang terbaca utuh multi-baris, dan memilih opsi berdaftar panjang via panah selalu menjaga opsi terpilih di dalam kotak.
- **Verifikasi target:** `bun test test/approval-tui.test.ts test/approval-prompt.test.ts` + unit test baru pertanyaan panjang + daftar opsi panjang.

### T5. Perbaiki `focusAnchor` off-by-1 di `form.ts`
- **Target:** [src/ui/screens/form.ts](file:///d:/Github/minicode/src/ui/screens/form.ts#L304-L309), [form.ts](file:///d:/Github/minicode/src/ui/screens/form.ts#L338-L355)
- **Masalah:** `rowsAvail = max(1, windowMaxHeight(rows) - 4)` lebih besar 1–2 baris daripada `room` aktual `dialogBox` (`chrome = 5` saat `footerGap` aktif, plus `-1` baris `"... N more"` saat terpotong), sehingga `focusAnchor = errEnd` memaksa `activeRow` keluar dari jendela tampak dan kursor pindah ke baris judul/border.
- **Desain perbaikan:**
  - Gunakan anggaran konservatif `const maxVisibleSpan = Math.max(1, windowMaxHeight(screen.rows || 24) - 6)` (memperhitungkan border(2) + title(1) + footerGap(1) + footer(1) + reserved `... more`(1)) saat memutuskan apakah `errEnd` bisa dijadikan `focusAnchor` tanpa mendorong `activeRow`.
  - Sebagai pertahanan berlapis saat memarkir kursor (`L338`), pastikan hanya memanggil `moveCursor` bila `activeRow >= box.bodyStart` dan `li >= box.bodyTop`.
- **Dampak setelah diperbaiki:** Kursor ketik di `form` tetap terkunci akurat pada field input aktif walau pesan error validasi sangat panjang atau tinggi terminal mendekati batas 10 baris.
- **Verifikasi target:** `bun test test/form.test.ts test/tui-geometry.test.ts` + kasus error multi-baris pada tinggi 10–14 baris.

### T6. Konsistensi `Ctrl+U`, `Del`, `Esc`, dan notice kosong di `model-manager.ts`
- **Target:** [src/ui/screens/model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L449-L495), [model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L521-L553)
- **Masalah:** `Ctrl+U` menyetel `filter = ""` (bukan `null`), sementara `filter != null` menganggap mode cari masih aktif: menyembunyikan hint `Del delete`, membuat `Del` gagal menghapus item (hanya mengubah `""` → `null`), dan memaksa `Esc` ditekan 2× untuk keluar walau filter tampak kosong. Pada `Enter`/`Tab` saat daftar kosong (`!row`), `notice = null` di `L449` tak diikuti `render()`.
- **Desain perbaikan:**
  - Samakan semantik kosong-filter di `model-manager.ts`: `Ctrl+U` langsung menyetel `filter = null` (konsisten dengan `Backspace`/`Del` saat query habis di `L483`!).
  - Pada `Enter` (`L523`) dan `Tab` (`L552`) ketika `!row`, panggil `render()` sebelum `return true` agar `notice` lama yang sudah dihapus ikut bersih dari layar (atau jangan hapus `notice` bila aksi no-op).
- **Dampak setelah diperbaiki:** Setelah menghapus query via `Ctrl+U`, tombol `Del delete` langsung aktif di footer & berfungsi, sekali `Esc` menutup manager, dan layar tak menyisakan notice basi saat menekan `Enter`/`Tab` di hasil filter kosong.
- **Verifikasi target:** `bun test test/model-manager-flows.test.ts` + tambah kasus `Ctrl+U` diikuti `Esc` dan `Del`.

### T7. Perbaiki label model footer `"no model"` dan `/status` saat semua model/provider dihapus
- **Target:** [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L1221-L1226), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L2336)
- **Masalah:** `model-manager.ts` & `provider-manager.ts` memanggil `setModelOverride("")` saat model terakhir terhapus. `modelRef.current ?? ...` di `L2336` berhenti di `""` (string kosong di footer), dan `currentModel` di `L1222` jatuh ke snapshot boot `cfg.providers[0]` yang mungkin sudah dihapus.
- **Desain perbaikan:**
  - Bedakan `modelRef.current === undefined` (belum pernah dipilih — fallback ke boot `cfg.providers[0]`) vs `modelRef.current === ""` (sengaja dikosongkan karena seluruh model terhapus):
    - Di `host.getStatus().footer.model`: `modelRef.current === undefined ? (cfg.providers[0]?.models[0] ?? t("tui.noModel")) : (modelRef.current || t("tui.noModel"))`.
    - Di `commandCtx.currentModel`: bila `modelRef.current === ""`, kembalikan `undefined` (bukan provider lama di snapshot boot `cfg`).
- **Dampak setelah diperbaiki:** Setelah menghapus model terakhir lewat `/model` atau `/provider`, footer jujur menampilkan `belum ada model` / `no model` dan `/status`/`/context` tak lagi menyebut provider yang sudah dihapus.
- **Verifikasi target:** `bun test test/audit-fix-footer-receipts.test.ts test/cli-command-audit-regressions.test.ts`.

### T8. Bersihkan penghitungan `"other"` & sanitasi model pada blok penutup sesi
- **Target:** [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L783-L812), [src/ui/tui/session-summary.ts](file:///d:/Github/minicode/src/ui/tui/session-summary.ts#L91-L114)
- **Masalah:** `writeSessionSummary` menjumlahkan `other++` dari snapshot `activities` **dan juga** dari record jurnal `committed` (double-count saat turn terhenti menyisakan `activities`), dan `buildClosingBlock` mencetak `info.model`/`info.toolBreakdown` tanpa `sanitizeAnsiLine`/`stripSgr`/`truncateToWidth`.
- **Desain perbaikan:**
  - Di `cli/tui.ts:783-813`: bila jurnal `valid` dan memuat records, hitung `other` dan `tools` dari jurnal (dedup `toolCallId` atau pakai sumber jurnal tunggal agar konsisten dengan `toolBreakdown`), hanya fallback ke `activities` snapshot bila jurnal tak tersedia/kosong.
  - Di `src/ui/tui/session-summary.ts`: sanitasi & potong `info.model` (`truncateToWidth(stripSgr(sanitizeAnsiLine(info.model)), 64, "…")`) serta `info.toolBreakdown` sebelum disisipkan ke output.
- **Dampak setelah diperbaiki:** Angka kategori `"other"` pada blok statistik keluar tidak pernah melebihi jumlah `tools` akibat double-count, dan ID model panjang/asing dari endpoint tak dapat merusak format atau menyuntikkan ANSI ke scrollback pasca-exit.
- **Verifikasi target:** `bun test test/tui-format.test.ts` / unit test `buildClosingBlock`.

### T9. Sembunyikan kursor di layar `tooSmall()` & satukan evaluasi `runningRows()` per frame
- **Target:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2115-L2190), [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3277-L3322), [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3573-L3594); [src/ui/runtime/screen.ts](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L260-L266)
- **Masalah:** Saat `tooSmall()`, `screen.paint(frame)` tanpa argumen `cursor` meninggalkan kursor terminal menyala di layar peringatan; di `buildLayout`, `wrappedLength` / `runningRows` mengevaluasi `nowFn()` berulang kali dalam 1 frame sehingga melintasi 60 ms `LIVE_DWELL_MS` bisa memicu selisih 1 baris; dan `scroll*` mengabaikan `viewH`.
- **Desain perbaikan:**
  - Di `screen.ts:paint` (atau lewat `setCursorVisible(false)` sebelum `screen.paint(frame)` di `app.ts:3591`): pastikan kursor disembunyikan saat `cursor` tidak diberikan / pada layar `tooSmall()`. *(Pertahankan `lastChatCols` utuh saat `tooSmall()` demi rebase scroll!)*
  - Di `app.ts` `scrollBy`/`scrollRows`/`jumpEdge`/`followTail`: teruskan `viewH` sebagai argumen kedua `wrappedLength(this.chatWidth(), viewH)`.
  - Di `buildLayout`: simpan hasil `wrappedLength(contentCols, viewH)` ke variabel lokal agar `maxBackForIndicator` dan `maxBack` memakai satu nilai konsisten per frame (atau snapshot `viewport.totalRows` dari satu kali panggilan).
- **Dampak setelah diperbaiki:** Layar peringatan terlalu kecil bersih tanpa kursor liar berkedip; hitungan posisi scroll dan `maxBack` deterministik di setiap satu frame.
- **Verifikasi target:** `bun test test/tui-app.test.ts`.

### T10. Perbaiki `wizard.ts`: case-insensitive `localhost` & cegah key echo saat jeda selesai 1200ms
- **Target:** [src/ui/screens/wizard.ts](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L295), [wizard.ts](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L377-L390)
- **Masalah:** `HTTP://LOCALHOST:...` ditolak sebagai host lokal (meminta API key wajib karena tidak ada `/i`), dan jeda `1200ms` tampilan `"Done"` berjalan sesudah `setRawMode(false)` sehingga ketikan prematur user tercetak mentah ke alt-screen dan bocor ke buffer input TUI.
- **Desain perbaikan:**
  - Tambah flag `i` pada regex `lokal` (`L295`).
  - Pertahankan raw mode & noop key consumer selama `sleepUnref(1200)` (atau tutup segera jika user menekan tombol/Esc/`Enter` selama jeda 1,2 dtk — sehingga responsif sekaligus mengonsumsi input prematur bersih!), baru lepas raw mode di `finally`.
- **Dampak setelah diperbaiki:** URL `LOCALHOST` kapital dikenali sebagai endpoint lokal; mengetik saat banner sukses wizard tampil tak mengotori layar atau mengirim karakter nyasar ke prompt pertama TUI.
- **Verifikasi target:** `bun test test/wizard.test.ts`.

### T11. Perbaiki `highlight.ts` skip-3 setelah `\`, wrap ringkasan `diff.ts`, dan batas naik `askLine` linear
- **Target:** [src/ui/render/highlight.ts](file:///d:/Github/minicode/src/ui/render/highlight.ts#L152-L172); [src/ui/render/diff.ts](file:///d:/Github/minicode/src/ui/render/diff.ts#L230), [diff.ts](file:///d:/Github/minicode/src/ui/render/diff.ts#L248); [src/ui/input/input.ts](file:///d:/Github/minicode/src/ui/input/input.ts#L405-L485)
- **Masalah:** `findCommentIndex` loncat 3 indeks (`i += 2` lalu `i++`) sehingga `"foo\\" // kom` melewatkan kutip penutup; `diff.ts:230,248` tak membatasi lebar ringkasan/pesan truncasi di jalur linear; `askLine` mengirim `ESC[...A` melebihi tinggi terminal bila baris multiline `>= rows`.
- **Desain perbaikan:**
  - Di `highlight.ts:158`: ubah `if (ch === "\\") i += 2` menjadi `if (ch === "\\") { i += 2; continue }` (agar tepat melompati `\` + 1 char berikutnya, total +2 bukan +3!).
  - Di `diff.ts:230,248`: lewatkan kedua baris ringkasan/truncasi via `truncateToWidth(..., width, glyphs.ellipsis)`.
  - Di `input.ts`: batasi baris yang digambar `renderAnsi` dan nilai `ESC[...A` maksimal `Math.max(1, rows - 1)` supaya tidak menembus scrollback atas.
- **Dampak setelah diperbaiki:** Pewarnaan komentar setelah string berakhiran `\\` menjadi tepat; diff linear & prompt multiline panjang tidak lagi mematahkan batas kolom/scrollback.
- **Verifikasi target:** `bun test test/highlight.test.ts test/tui-diff.test.ts test/tui-classic.test.ts`.

### T12. Lokalisasi pesan `cli/auto-update.ts` & `cli/context-command-run.ts`, `truncateToWidth` di `oneLine`, dan sanitasi `--cwd` di `sessions.ts`
- **Target:** [src/ui/i18n/en.ts](file:///d:/Github/minicode/src/ui/i18n/en.ts), [id.ts](file:///d:/Github/minicode/src/ui/i18n/id.ts); [cli/auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L106-L165); [cli/context-command-run.ts](file:///d:/Github/minicode/cli/context-command-run.ts#L102-L168); [cli/commands.ts](file:///d:/Github/minicode/cli/commands.ts#L563-L566); [cli/commands/sessions.ts](file:///d:/Github/minicode/cli/commands/sessions.ts#L47)
- **Masalah:** Notice auto-update selalu berbahasa Indonesia walau locale `en`, error `/context` berbahasa Inggris keras walau locale `id` + `.replace("{model}", ...)` tak terpakai, `oneLine` memotong via `.slice()`, dan `sessions list` mencetak `base` tanpa `sanitizeAnsiLine`. *(Budget `writer-inventory.test.ts` tetap tak tersentuh karena jumlah pemanggilan `console`/`stderr.write` nol berubah.)*
- **Desain perbaikan:**
  - Tambah kunci i18n baru yang simetris di `en.ts` dan `id.ts` untuk 5 pesan `cli/auto-update.ts` serta 2 alasan error `cli/context-command-run.ts`; hapus `.replace("{model}", ...)`.
  - Ganti `oneLine` memakai `truncateToWidth(flat, max, glyphs.ellipsis)` dan bungkus `base` di `sessions.ts:47` dengan `sanitizeAnsiLine(base)`.
- **Dampak setelah diperbaiki:** Bahasa `/context` dan auto-update konsisten 100% mengikuti `/lang` & `MINICODE_LANG` (sambil mempertahankan angka writer inventory tetap sama), serta preview prompt ber-emoji pada `/undo` / `/sessions` aman dari pembelahan surrogate pair.
- **Verifikasi target:** `bun test test/i18n.test.ts test/writer-inventory.test.ts test/update-auto.test.ts test/context-window-manual.test.ts`.

---

## Jalur B — Rencana Perubahan `[UI-IMPACT: butuh konfirmasi pemilik]` (4 Item)

> Sesuai `AGENTS.md`, keempat item ini mengubah kontrak UI/geometri/ratchet/writer/layout. Setiap butir perlu keputusan eksplisit Anda sebelum dikerjakan (termasuk pembaruan `docs/TERMINAL_CONTRACT.md` & test peta proteksi bila disetujui).

### U1. Indikator fase reasoning live saat `/view thinking` menyala
- **Target:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L1670-L1675), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L3374-L3383)
- **Opsi perbaikan:**
  - *Opsi minimal (direkomendasikan):* Pertahankan mode flat (`thinkingRows` tidak membocorkan teks thinking penuh), namun di `waitingStatusRow()` ganti kondisi sunyi dengan status tunggu khusus saat `thinkingAreaMode()` aktif dan sedang menampung `thinkingArea`/`thinkingTail` (mis. `› Thinking (N lines)…` atau tetap izinkan `waitingStatusRow()` tampil di atas segmen yang sedang berpikir) — lalu tetap di-commit menjadi `+ thinking · N lines` saat segmen selesai.
- **Dampak setelah diperbaiki:** Saat `/view thinking` menyala dan model sedang berpikir puluhan detik sebelum memanggil tool/jawaban, layar tak lagi kosong diam; pengguna langsung melihat umpan balik bahwa model aktif berpikir. *(Mengubah output live viewport pada mode `/view thinking ON`, memengaruhi test transcript bila ada yg mengasumsikan `thinkingArea` sunyi.)*

### U2. Rebase `turnScrollFloor` saat eviksi `TRANSCRIPT_CAP` (5000 baris) tengah turn
- **Target:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L591-L596), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3318-L3320)
- **Desain perbaikan:** Di dalam `transcript.onEviction`: selain menurunkan `this.scrollBack`, turunkan juga `this.turnScrollFloor = Math.max(0, this.turnScrollFloor - n)`.
- **Dampak setelah diperbaiki:** Pada sesi sangat panjang (>5000 baris logis) yang menyentuh batas eviksi di tengah turn berjalan, ratchet `scrollBack` tetap sinkron tanpa menyisakan ruang kosong berlebih atau pergeseran jendela mendadak. *(Menyentuh mekanisme ratchet — butuh persetujuan pemilik & update test ratchet jika relevan.)*

### U3. Penanganan lebar sempit untuk `runningLine` & prioritas badge darurat `footer.ts`
- **Target:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L3258-L3302), [src/ui/footer.ts](file:///d:/Github/minicode/src/ui/footer.ts#L327-L345)
- **Desain perbaikan (jika disetujui):**
  - Hitung budget karakter `runningLine` secara proporsional atau wrap melalui `tailRows(w)` (tetap hormati batas `maxLiveTailRows`) atau prioritaskan menjaga suffix status `… sedang berjalan (12s)` sebelum memotong judul tengah dengan elipsis (middle/left-bias trim).
  - Di `footer.ts` mode sempit: pertahankan `retryBadge` & `scrollBadge` di depan `ctx/metrics` pada cabang fallback sempit `L329-L345` agar indikator retry & pesan baru tak lenyap sebelum `metrics` dipangkas.
- **Dampak setelah diperbaiki:** Di layar centered 120 kolom (`contentCols=54`) atau terminal sangat sempit, user tetap melihat status `"sedang berjalan (12s)"`, info retry, dan indikator pesan baru — dengan trade-off judul target panjang terpotong lebih awal dan sebagian test snapshot `footer-render.test.ts` mungkin perlu disesuaikan bila mengubah layout fallback sempit.

### U4. Proyeksi dinamis prompt user historis di `Transcript` mengikuti lebar saat resize
- **Target:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L1155-L1193), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L2432)
- **Desain perbaikan (jika disetujui):** Simpan entri prompt user sebagai entri logis di `Transcript` lalu bungkus per lebar tampilan di `WidthProjection` (seperti pesan assistant/info), alih-alih memecah string permanen pada lebar saat submit/replay.
- **Dampak setelah diperbaiki:** Mengubah ukuran terminal (memperlebar/mempersempit) membuat riwayat prompt user ikut menyesuaikan lebar kolom dengan rapi, tidak membeku sempit atau ter-wrap ganda — namun mengubah jumlah baris `this.lines` per `pushUser` dan memerlukan pembaruan kontrak seleksi (`displayStart`/chromes) serta test terkait `pushUser`.

---

## Urutan Eksekusi yang Disarankan

1. **Gelombang 1 (Input & Modal Interaktif — risiko hang/kehilangan input paling tinggi):** `T1`, `T2`, `T3`, `T4`
2. **Gelombang 2 (Konsistensi Manager, Form & State):** `T5`, `T6`, `T7`, `T8`
3. **Gelombang 3 (TUI Polish, Renderer & Lokalisasi CLI):** `T9`, `T10`, `T11`, `T12`
4. **Gelombang 4 (Opsional — Hanya item `[UI-IMPACT]` yang Anda setujui):** pilih dari `U1`–`U4` + update `docs/TERMINAL_CONTRACT.md` bila mengubah kontrak.
5. **Verifikasi Lokal Akhir (`AGENTS.md`):** jalankan `bun x tsc --noEmit` + test unit/integrasi terarah per gelombang (tanpa menjalankan `gate:fast` sampai ada aba-aba rilis dari pemilik).
