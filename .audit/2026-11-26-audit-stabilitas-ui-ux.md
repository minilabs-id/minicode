# Audit Stabilitas UI & UX MiniCode (Pasca-Evaluasi)

**Tanggal:** 2026-11-26  
**Scope:** Audit menyeluruh lapisan antarmuka & UX (`src/ui/**`, `cli/**` permukaan interaktif/linear, dan `src/ui/i18n/**`) — baca-saja, tanpa perubahan kode produksi.  
**Pembaruan pasca-evaluasi:** Seluruh temuan telah diverifikasi silang terhadap implementasi `app.ts`, `transcript.ts`, `footer.ts`, dan suite test terkait (`test/approval-tui.test.ts`, `test/background-job-badge.test.ts`, `test/tui-app.test.ts`, `test/model-manager-flows.test.ts`). Dua sub-klaim awal dicabut karena dikunci kontrak/test, beberapa mekanisme diperjelas, dan satu bug steer async `@mention` ditambahkan.

**Klasifikasi otoritas (`AGENTS.md`):**
- **`[TUNING]`** — perbaikan bug lokal / konsistensi state / sanitasi tanpa mengubah kontrak geometri, layout, composer, caret, ratchet, rekap, warna, writer, atau I1.
- **`[UI-IMPACT: butuh konfirmasi pemilik]`** — menyentuh layout/geometri, composer, caret, ratchet, rekap, warna, writer, atau kontrak [TERMINAL_CONTRACT.md](file:///d:/Github/minicode/docs/TERMINAL_CONTRACT.md); wajib persetujuan pemilik sebelum dieksekusi.

---

## Ringkasan Eksekutif

- **Pondasi inti TUI sudah kokoh:** single-write-per-frame (`SYNC_START..SYNC_END`), diff cell dengan rewind wide-glyph, streaming key/paste/UTF-8 decoder, timer idle (`createIdleTimer`), watchdog aksi jaringan (`withTimeout`), signal/crash guard, sanitasi ANSI pada teks model/tool/provider, serta paritas kamus i18n **577/577 kunci (`en.ts` ↔ `id.ts`) = 0 selisih/parameter hilang**.
- **Total 16 temuan terverifikasi (11 P1, 5 P2):**
  - **11 temuan P1** (3 `[UI-IMPACT]`, 8 `[TUNING]`): mencakup bug steer `@mention` tertelan diam-diam saat turn sibuk, menu `/` atau `@` tak terlihat membajak `Up`/`Down`/`Enter`, `/provider` Add/Edit membeku 60 dtk tanpa `Esc`, `/view thinking` menyembunyikan baris tunggu live selama fase reasoning, `readModalInput` tanpa `try/catch` + pertanyaan `ask_user` terpotong, `Ctrl+U` `model-manager` + hapus model terakhir mengosongkan footer, `focusAnchor` off-by-1 di `form.ts`, ratchet `turnScrollFloor` pasca-eviksi, evaluasi ganda `runningRows()` & `tooSmall()` tanpa sembunyi kursor, serta pemotongan `runningLine` di kolom sempit.
  - **5 temuan P2** (1 `[UI-IMPACT]`, 4 `[TUNING]`): double-count `"other"` + `info.model` tanpa sanitasi pada penutup sesi, pre-wrap statis prompt user historis, `wizard.ts` `LOCALHOST` + 1200 ms cooked mode, `highlight.ts`/`diff.ts`/`askLine`, dan string satu-bahasa di `cli/auto-update.ts` / `cli/context-command-run.ts`.
- **Sub-klaim awal yang dicabut hasil evaluasi:**
  - ~~`promptAsk` harus menyembunyikan kursor via `moveCursor`~~ → **dikunci test** [test/approval-tui.test.ts](file:///d:/Github/minicode/test/approval-tui.test.ts#L285-L305) agar kursor tidak tertinggal liar di frame latar.
  - ~~`tooSmall()` harus mengosongkan `lastChatCols`~~ → mempertahankan `lastChatCols` justru diperlukan oleh rebase scroll anchor di [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3293-L3301).
  - ~~`WAITING_ASCII` kurang animasi~~ → `[BG:1]` pada mode ASCII **dikunci test** [test/background-job-badge.test.ts](file:///d:/Github/minicode/test/background-job-badge.test.ts#L99); `WAITING_ASCII[1..3]` hanyalah elemen mati dalam konstanta array.

---

## Temuan Prioritas P1

### 1. Menu `/` atau `@` tak terlihat saat turn sibuk membajak `Up`/`Down`/`Enter` `[TUNING]`
- **Lokasi:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L163-L180), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L1276-L1351), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L1410-L1448), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L1506-L1520), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2783-L2785), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3163-L3170); [src/ui/input/prompt-engine.ts](file:///d:/Github/minicode/src/ui/input/prompt-engine.ts#L327-L331)
- **Mekanisme:** `BUSY_TYPING_KEYS` mengizinkan `"up"`, `"down"`, dan `"enter"` saat turn sibuk. Empat jalur penyuntingan di `app.ts` (`L1410`, `L1441`, `L1513`, `L3163`) menyalakan `state.menuOpen = sug.items.length > 0` tanpa memeriksa `!this.isBusy()`, padahal `menuRows()` menyembunyikan dropdown saat `busy`. Akibatnya saat mengetik `/` atau `@` ketika turn berjalan:
  - `Up`/`Down` menggeser `sel` tersembunyi alih-alih kursor vertikal/histori.
  - `Enter` melewati guard `@mention` (`L1315` mensyaratkan `!this.isBusy()`) dan masuk ke `prompt-engine.ts:327` yang memanggil `pickSelected(state.line)` — menimpa seluruh baris draf dengan item dropdown tersembunyi (bahkan untuk `@file` di tengah kalimat!).

### 2. Steer `@mention` asinkron saat turn sibuk menelan pesan diam-diam bila gagal & berpotensi balapan saat turn berakhir `[TUNING]`
- **Lokasi:** [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L2416-L2460)
- **Mekanisme:** Di `host.enqueue`, ketika pesan yang diketik saat busy mengandung `@`, UI langsung menampilkan toast `"steered"` (`L2459`) dan me-return `true` (mengosongkan composer), sementara `expandMentions(...)` dijalankan fire-and-forget. Penangan `.catch(() => {})` (`L2458`) menelan seluruh kegagalan ekspansi tanpa gema error atau pembatalan; selain itu saat ekspansi selesai tepat setelah turn lama berakhir (`L2438`), cabang `L2444` memanggil `runTurn()` tanpa menjaga transisi konkuren dengan `onBackgroundJobFinished`.

### 3. `/provider` Add/Edit membeku hingga 60 detik tanpa pembatalan `Esc`, raw mode mati, dan chrome berbohong `[TUNING]`
- **Lokasi:** [src/ui/screens/provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L177-L202), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L251-L274), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L359-L426), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L436), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L473-L528), [provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L624-L628); [src/ui/screens/model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L525-L545)
- **Mekanisme:** `doAdd` dan `doEdit` memanggil `suspend()` (melepas `onData`/`onResize`, `setRawMode(false)`), merender `notice = t("ntc.detecting")`, lalu menunggu `withWatchdog(..., 60_000)` tanpa `AbortController`/`attachProgressCancel`. Selama itu `Esc` pojok kanan atas & footer tetap tercetak padahal tak ada tombol yang bekerja dan ketikan ter-echo dalam cooked mode. Di file yang sama, `enter` (`L624-L628`) menelan error `opts.onSelect(p)` dan `doDelete` (`L436`) membaca `opts.currentModel` statis alih-alih `opts.getCurrentModel?.()`. Pada `model-manager.ts:525-545`, `onSelect` mengosongkan region via `suspend()` hingga 60 dtk tanpa indikator progres.

### 4. `/view thinking` menyembunyikan indikator tunggu live (`waitingStatusRow`) selama fase reasoning `[UI-IMPACT: butuh konfirmasi pemilik]`
- **Lokasi:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L41), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L1016-L1103), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L1670-L1675), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L3374-L3383); [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L95), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L998)
- **Mekanisme:** `cli/tui.ts:998` menyalakan `activityPanel` secara default. Saat user mengaktifkan `/view thinking` (atau `MINICODE_SHOW_THINKING=1`), segmen yang sudah tutup tetap dicetak sebagai `+ thinking · N lines` lewat `commitThinking()` (`L1080-L1102`, sesuai [docs/environment.md](file:///d:/Github/minicode/docs/environment.md#L131)). Namun **selama fase reasoning live berlangsung** (sebelum tool/teks/turn berakhir): `FLAT_RENDERER = true` memaksa `thinkingRows()` kembali `[]`, sementara teks tertampung di `thinkingArea`/`thinkingTail` — yang sekaligus memicu guard `waitingStatusRow()` (`L3379-L3380`) mengembalikan `null`, sehingga tidak ada baris thinking live maupun indikator tunggu `Thinking...`. *(Catatan: saat `/view thinking` OFF secara default, reasoning masuk `thinkingBuf`, sehingga bug ini tidak muncul pada setelan default.)*

### 5. `approval/prompt.ts`: `readModalInput` tanpa `try/catch` + `resume()`, pertanyaan `ask_user` tak dibungkus baris, dan scroll opsi buta `[TUNING]`
- **Lokasi:** [src/ui/approval/prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L298-L303), [prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L339-L371), [prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L573-L615)
- **Mekanisme:**
  - `onData = (chunk: Buffer) => pump.push(...)` (`L298`) tidak dibungkus `try/catch` seperti modal lain dan `L301` tidak memanggil `process.stdin.resume()`.
  - `promptAskText` (`L608`) mengirim `\`  ${q}\`` sebagai satu baris mentah ke `dialogBox` (`truncateToWidth`), bukan `wrapByWidth` seperti `promptAsk` (`L441`), sehingga pertanyaan > `innerW` (~52–84 kolom) terpotong `…`.
  - Pada `promptAskText` beropsi banyak, `focusRow` selalu dipaku ke `spec.body.length + 1` (baris input), sehingga menggerakkan `Up`/`Down` di daftar opsi tidak menggulir viewport ke pilihan `optSel` yang berada di atas batas tampak.

### 6. `form.ts` off-by-1 batas tinggi `focusAnchor` dapat mendorong kursor ketik ke baris judul/border `[TUNING]`
- **Lokasi:** [src/ui/screens/form.ts](file:///d:/Github/minicode/src/ui/screens/form.ts#L304-L309), [form.ts](file:///d:/Github/minicode/src/ui/screens/form.ts#L341-L344); [src/ui/screens/dialog.ts](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L157-L180)
- **Mekanisme:** `rowsAvail = max(1, windowMaxHeight(rows) - 4)` lebih longgar 1–2 baris dibanding ruang riil `dialogBox` yang memakai `5` chrome (`+ footerGap`) serta `room - 1` saat clipped (`... N more`). Bila error panjang tepat di ambang batas tersebut, `focusAnchor = errEnd` menggulir `activeRow` keluar dari `bodyStart` dan `li` terkunci ke baris judul/border.

### 7. `model-manager.ts`: `Ctrl+U` meninggalkan `filter = ""` merusak `Del`/`Esc`, plus `Enter`/`Tab` saat kosong meninggalkan notice basi `[TUNING]`
- **Lokasi:** [src/ui/screens/model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L174), [model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L449-L495), [model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L521-L524), [model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L551-L552), [model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L591-L595)
- **Mekanisme:** `Ctrl+U` menyetel `filter = ""` alih-alih `null`: hint `Del delete` tetap hilang, menekan `Del` hanya menggeser `""` → `null` tanpa menghapus model, dan `Esc` pertama tampak tak bekerja (butuh 2× `Esc` meski bar filter terlihat kosong). Saat `viewRows()` kosong (`!row`), `Enter` (`L523`) / `Tab` (`L552`) keluar setelah `notice = null` (`L449`) tanpa `render()`.

### 8. Menghapus model/provider terakhir mengosongkan nama model di footer menjadi `""` `[TUNING]`
- **Lokasi:** [cli/model-manager.ts](file:///d:/Github/minicode/cli/model-manager.ts#L112-L118); [cli/provider-manager.ts](file:///d:/Github/minicode/cli/provider-manager.ts#L88-L93); [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L1221-L1226), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L2336)
- **Mekanisme:** Menghapus model/provider terakhir memanggil `setModelOverride("")` sehingga `modelRef.current = ""`. `host.getStatus` memakai `modelRef.current ?? ...` (menghasilkan `""`, bukan `t("tui.noModel")`), dan `commandCtx.currentModel` jatuh balik ke snapshot boot `cfg.providers[0]` yang sudah dihapus.

### 9. `turnScrollFloor` tidak direbase saat eviksi `TRANSCRIPT_CAP` `[UI-IMPACT: butuh konfirmasi pemilik]`
- **Lokasi:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L591-L596), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3318-L3320)
- **Mekanisme:** `transcript.onEviction` mengurangi `this.scrollBack` sebesar baris visual `n` yang terbuang dari kepala transkrip, namun `this.turnScrollFloor` tidak direbase; pada `buildLayout` berikutnya `Math.max(maxBack, this.turnScrollFloor)` dapat menarik `scrollBack` naik melebihi ekor yang sah.

### 10. `runningRows()` dievaluasi berkali-kali per frame, race kecil `wrappedLength` tanpa `viewH`, dan cursor tetap aktif di `tooSmall()` `[TUNING]`
- **Lokasi:** [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2115), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2145), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2168), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L2188), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3277-L3322), [app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3569-L3594); [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L2150-L2163), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L3280-L3289); [src/ui/runtime/screen.ts](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L260-L266)
- **Mekanisme:**
  - `buildLayout` mengevaluasi `wrappedLength` / `viewport` berulang dalam 1 frame (`L3277`, `L3318`, `L3322`), yang membaca `this.nowFn()` ulang di `runningLine` sehingga persilangan ambang 60 ms `LIVE_DWELL_MS` di tengah frame dapat membuat `maxBack` berbeda 1 baris dari `viewport`.
  - `tooSmall()` memanggil `screen.paint(frame)` tanpa parameter `cursor`, sehingga `HIDE_CURSOR` tidak dipancarkan dan kursor tetap berkedip di layar peringatan.
  - `scrollBy`/`scrollRows`/`jumpEdge`/`followTail` tidak meneruskan `viewH` ke `wrappedLength` (berdampak hanya jika dipanggil sebelum `viewport()` pertama atau di celah resize sebelum paint berikutnya). *(Catatan: `lastChatCols` sengaja **tidak** direset pada `tooSmall()`.)*

### 11. Status live `runningLine` terpotong pada kolom centered 120-col (`54` kol) & badge darurat footer terbuang saat sempit `[UI-IMPACT: butuh konfirmasi pemilik]`
- **Lokasi:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L3258-L3302); [src/ui/tui/app.ts](file:///d:/Github/minicode/src/ui/tui/app.ts#L3530); [src/ui/footer.ts](file:///d:/Github/minicode/src/ui/footer.ts#L327-L345)
- **Mekanisme:** `runningLine` membentuk satu baris hingga ~72+ kolom (`maxCols: 72`) tanpa wrap; pada kolom centered 120 kolom (`contentCols = 54`), `app.ts:3530` memotong ekor `"… sedang berjalan (12s)"`. Di `footer.ts`, saat lebar sangat sempit (< ~45–55 kolom atau metrik+badge melampaui `align(leftModeOnlyFor, rightFor)`), mode fallback darurat (`L329-L345`) menggugurkan semua `extraParts` (`retryBadge`, `scrollBadge`, `+N running`, `queuedCount`). *(Array `WAITING_ASCII[1..3]` di `footer.ts:135` hanya dead items karena `[BG:n]` dikunci test `test/background-job-badge.test.ts:99`.)*

---

## Temuan Prioritas P2

### 12. Ringkasan penutup sesi menghitung ganda kategori `"other"` dan mencetak `info.model` tanpa sanitasi `[TUNING]`
- **Lokasi:** [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L783-L812), [cli/tui.ts](file:///d:/Github/minicode/cli/tui.ts#L2738); [src/ui/tui/session-summary.ts](file:///d:/Github/minicode/src/ui/tui/session-summary.ts#L91-L114)
- **Mekanisme:** `writeSessionSummary` menghitung `other++` dari snapshot `activities` **dan** dari record jurnal `committed`, sementara `tools` mengambil `Math.max(...)` (`other` bisa melampaui `tools`). Di `buildClosingBlock`, `info.model` dan `info.toolBreakdown` tidak dilewatkan `sanitizeAnsiLine`/`stripSgr`/`truncateToWidth` seperti `src/ui/render/session-summary.ts:76-77`.

### 13. Prompt user historis di-wrap statis pada lebar saat kirim/replay `[UI-IMPACT: butuh konfirmasi pemilik]`
- **Lokasi:** [src/ui/tui/transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L1155-L1193), [transcript.ts](file:///d:/Github/minicode/src/ui/tui/transcript.ts#L2432)
- **Mekanisme:** `pushUser` memotong prompt ke beberapa entri logis di `this.lines` pada lebar saat submit/replay (`replayHistory` tanpa `availableWidth`), sehingga resize kemudian tidak membuka wrap lama dan mempersempit layar menghasilkan double-wrap.

### 14. `wizard.ts`: cek `localhost` case-sensitive & jeda 1200ms sukses berada di cooked mode `[TUNING]`
- **Lokasi:** [src/ui/screens/wizard.ts](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L295), [wizard.ts](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L377-L390)
- **Mekanisme:** Regex `lokal` tanpa `/i` menolak `HTTP://LOCALHOST:...`, dan `detachCancel()` mematikan `rawMode` sebelum `sleepUnref(1200)` sehingga ketikan selama 1,2 detik sukses ter-echo mentah dan mengantre sebelum `TuiApp` aktif.

### 15. `highlight.ts` salah loncat indeks setelah `\`, `diff.ts` ringkasan tak dibatasi lebar, dan `askLine` linear overshoot jika >= tinggi layar `[TUNING]`
- **Lokasi:** [src/ui/render/highlight.ts](file:///d:/Github/minicode/src/ui/render/highlight.ts#L152-L172); [src/ui/render/diff.ts](file:///d:/Github/minicode/src/ui/render/diff.ts#L230), [diff.ts](file:///d:/Github/minicode/src/ui/render/diff.ts#L248); [src/ui/input/input.ts](file:///d:/Github/minicode/src/ui/input/input.ts#L405-L485)
- **Mekanisme:** `findCommentIndex` menjalankan `i += 2` diikuti `i++` (loncat 3 indeks setelah `\` sehingga `"foo\\" // comment` melewatkan kutip penutup); `diff.ts:230,248` tidak memotong ringkasan/truncasi untuk mode linear `simple.ts`; `askLine` linear mengirim `ESC[...A` melebihi tinggi viewport saat paste/multiline `>= rows`.

### 16. Literal satu-bahasa di jalur runtime & `.slice` UTF-16 pada utilitas tampilan CLI `[TUNING]`
- **Lokasi:** [cli/auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L106), [auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L128), [auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L140), [auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L150), [auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L157), [auto-update.ts](file:///d:/Github/minicode/cli/auto-update.ts#L165); [cli/context-command-run.ts](file:///d:/Github/minicode/cli/context-command-run.ts#L102), [context-command-run.ts](file:///d:/Github/minicode/cli/context-command-run.ts#L136-L139), [context-command-run.ts](file:///d:/Github/minicode/cli/context-command-run.ts#L168); [cli/commands.ts](file:///d:/Github/minicode/cli/commands.ts#L564-L565); [cli/commands/sessions.ts](file:///d:/Github/minicode/cli/commands/sessions.ts#L47)
- **Mekanisme:** `cli/auto-update.ts` menggunakan string Indonesia keras walau locale `en`; `cli/context-command-run.ts` menyisipkan error Inggris keras meski locale `id` + no-op `.replace("{model}", ...)`; `oneLine` memakai `.slice()` UTF-16 bukan `truncateToWidth`; `cli/commands/sessions.ts:47` mencetak `base` tanpa `sanitizeAnsiLine`.

---

## Area yang Sudah Terverifikasi Kokoh

- **Pipeline Render Frame & Diff:** `TuiApp.paint` + `openAltScreen` (`SYNC_START`..`SYNC_END`, single-write), diff per sel (`cells.ts`) dengan rewind `cont`, dan getter runtime `c`/`glyphs`/`boxGlyphsForStyle()`.
- **Dekoder Input & Anti-Hang Terminal:** `prompt-engine.ts` menangani UTF-8 terpecah, overflow bracketed paste, mouse X10 & SGR, `MAX_CONTROL_SEQUENCE_BYTES`, dan `loneEscPending`; modal memakai `createIdleTimer`, `withTimeout`, serta dijaga `installCrashGuard` (`cli/index.ts`) dan `screen.ts`.
- **Keamanan Tampilan & Sanitasi Error:** `sanitizeAnsi` / `createStreamSanitizer` / `formatError` / `friendlyToolErrorCanonical` / `recovery-warning.ts` membuang kontrol berbahaya sebelum tampil di TUI maupun jalur linear.
- **Paritas i18n:** Verifikasi skrip terhadap `src/ui/i18n/en.ts` dan `id.ts` = **577/577 kunci** (0 hilang, 0 selisih `{var}`, 0 nilai kosong, 0 panggilan `t()`/`tSystem()` bermasalah).
