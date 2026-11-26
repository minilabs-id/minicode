# Rencana Perbaikan & Mitigasi Dampak — Konsolidasi 3 Audit Terakhir (2026-11-26)

Dokumen ini merancang rencana implementasi dan mitigasi dampak menyeluruh atas seluruh temuan yang masih terbuka dari:
1. [2026-11-26-audit-keselarasan.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-keselarasan.md) *(Track 1 sudah mendarat di `fa6e2c2` / `cf181ac`; tersisa keputusan Track 2)*.
2. [2026-11-26-audit-jendela-popup.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-jendela-popup.md) *(Bug & kerapian popup + overlay + readout)*.
3. [2026-11-26-audit-konsistensi-popup-kustom.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-konsistensi-popup-kustom.md) *(Konsistensi adaptasi terminal/gaya/bahasa & kustomisasi pemanggil)*.

---

## 0. Aturan & Penjaga Global (*Blast-Radius Guardrails*)

Setiap gelombang perubahan **wajib** mempertahankan seluruh pagar repo:
- **Batas lapisan ([test/ui-boundary.test.ts](file:///d:/Github/minicode/test/ui-boundary.test.ts))**: `src/ui/**` dilarang mengimpor `src/` non-ui, `cli/`, atau `#minicore`. Utility baru untuk render/backdrop tinggal di `src/ui/render/` atau `src/ui/screens/`.
- **Inventaris writer ([test/writer-inventory.test.ts](file:///d:/Github/minicode/test/writer-inventory.test.ts))**: nol penambahan panggilan `console.*` / `process.stdout.write` / `process.stderr.write` baru; gunakan `screen.setBracketedPaste?.()`, `app.paintRegion()`, `app.showToast()`, dan writer eksisting.
- **Nilai runtime dinamis ([test/no-frozen-runtime-value.test.ts](file:///d:/Github/minicode/test/no-frozen-runtime-value.test.ts))**: `c`, `glyphs`, `supportsUtf8()`, dan `boxChars()` dibaca saat render, tidak dibekukan ke `const` level modul.
- **Paritas i18n ([test/i18n.test.ts](file:///d:/Github/minicode/test/i18n.test.ts), [test/i18n-hardcode.test.ts](file:///d:/Github/minicode/test/i18n-hardcode.test.ts))**: semua kunci `en.ts` ↔ `id.ts` 1:1 dan terjemahan `id` bukan copy-paste `en`.
- **Kontrak terminal ([docs/TERMINAL_CONTRACT.md](file:///d:/Github/minicode/docs/TERMINAL_CONTRACT.md))**: I1 (1 write/frame di TUI & `paintRegion`), I11 (resize live aman pada dimensi sempit hingga `20×10`), I16 (popup komposit melukis di atas transkrip tanpa menghapus latar).

---

## Gelombang 1 — Bug Fungsional & Keselamatan Layout Murni (Risiko Rendah)

Fokus: memperbaiki bug nyata tanpa mengubah filosofi UX atau tata letak global.

### W1.1. `output-window`: perbaiki anggaran tinggi off-by-4
- **Perubahan**:
  - Di [src/ui/screens/output-window.ts#L88-L99,L157](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L88-L99): ubah `bodyBudget()` menjadi `Math.max(1, windowMaxHeight(screen.rows) - WINDOW_CHROME_ROWS)`. Hapus penambahan `+ WINDOW_CHROME_ROWS` di `outputWindowSpec()` agar `maxHeight` sama persis dengan `windowSpec()` (= `windowMaxHeight(rows)`).
  - Di handler tombol (`L259`): tambahkan huruf `"q"` (hanya huruf tunggal baca) sebagai penutup opsional selain `Esc`/`Enter`/`Ctrl+C`/`Ctrl+D`.
- **Dampak & Mitigasi**:
  - *Test lock*: [test/audit-fix-window-uniform-output.test.ts#L82](file:///d:/Github/minicode/test/audit-fix-window-uniform-output.test.ts#L82) mengunci `expect(out.maxHeight).toBe(windowMaxHeight(rows) + 4)`. **Mitigasi**: perbarui asersi tersebut menjadi `windowMaxHeight(rows)` (selaras `wizardWindowSpec`) beserta komentar kontraknya, dan tambah test regresi di [test/output-window.test.ts](file:///d:/Github/minicode/test/output-window.test.ts) pada `rows = 10` & `24` yang memverifikasi tidak ada baris `dlg.more` (`more`) palsu serta `PgDn` tidak melewati baris.

### W1.2. `/context` & `renderTable`: sinkronkan lebar tabel terhadap popup
- **Perubahan**:
  - Di [src/ui/render/table.ts#L21-L35](file:///d:/Github/minicode/src/ui/render/table.ts#L21-L35): tambah argumen opsional ke-3 `opts?: { width?: number }` (default `getTerminalWidth()`).
  - Di [cli/context-command-run.ts#L73-L86](file:///d:/Github/minicode/cli/context-command-run.ts#L73-L86): ganti `outputWindowWidth` dengan `windowWidth(process.stdout.columns || 80) - 4`, dan teruskan `{ width: inner }` ke `renderTable(...)`.
- **Dampak & Mitigasi**:
  - *Caller lain*: 8 pemanggil lain di `cli/commands/{config,providers,sessions,skills}.ts` dan `test/tui-table.test.ts` tetap memakai 2 argumen → **nol perubahan**.
  - *Ekspor `outputWindowWidth`*: tetap dipertahankan di `output-window.ts` sebagai shim deprecated agar `test/output-window.test.ts#L110` tetap lulus.
  - Uji tambahan: verifikasi baris hasil `/context` pada `cols = 60, 80, 120` tidak ada yang melebihi `windowWidth(cols) - 4`.

### W1.3. `form.ts`: kursor tersembunyi pada `select`/`confirm` & visibilitas error validasi
- **Perubahan**:
  - Di [src/ui/screens/form.ts#L317-L336](file:///d:/Github/minicode/src/ui/screens/form.ts#L317-L336): bila `activeRow >= 0 && activeCol >= 0` barulah panggil `screen.moveCursor(row, col)`; bila `activeCol < 0` (`select`/`confirm`), panggil `screen.setCursorVisible(false)`. Di `finish()` (`L339`), panggil `screen.setCursorVisible(false)` sebelum `clearRegion()`.
  - Untuk error inline di field aktif (`L282-L305`): catat `activeErrEndRow` bila `active && st.error`, dan set `focusRow` menjangkau baris error terakhir (selama total baris field+error ≤ ruang viewport; bila tidak, `activeRow` tetap prioritas utama agar mengetik tidak buta).
- **Dampak & Mitigasi**:
  - Cek seluruh asersi di [test/form.test.ts](file:///d:/Github/minicode/test/form.test.ts) & [test/provider-manager-flows.test.ts](file:///d:/Github/minicode/test/provider-manager-flows.test.ts): pergerakan kursor `text`/`secret` tidak berubah sama sekali; hanya menghilangkan `\x1b[6 q` nyasar di border kanan saat fokus berada di `select`/`confirm`.

### W1.4. `/update` backdrop restore, `onResize` label, & modal progres seragam
- **Perubahan**:
  - Di [src/ui/tui/app.ts#L1805-L1820](file:///d:/Github/minicode/src/ui/tui/app.ts#L1805-L1820): di `reacquireTerminal()`, bila `this.suspended > 0`, panggil `this.paintDimmed()` sebagai pengganti `this.paintCurrent()` agar backdrop redup + `backdropState` hidup kembali sebelum sub-modal lanjutan (`showCommandOutput`) dibuka.
  - Di [cli/tui.ts#L2008-L2086](file:///d:/Github/minicode/cli/tui.ts#L2008-L2086): ganti `popupBoxWidth(cols)` pada `paintSyncProgress` dan `paintUpdateProgress` dengan `windowWidth(cols)`, dan simpan `activeUpdateLabel` di closure `onResize` agar resize tidak menimpa label dengan teks lama.
- **Dampak & Mitigasi**:
  - Cek `test/tui-app.test.ts` & `test/update-command.test.ts`: bila `suspended === 0`, `reacquireTerminal()` tetap memakai `paintCurrent()` seperti semula (untuk `/shell` dan `/sessions` spawn tidak terdampak).

### W1.5. Proteksi suffix `(active)`/`[effort]`, wheel `@mention`, paste modal, `approval`, `dlg.more`, & `idleWarning`
- **Perubahan terarah**:
  1. **`idleWarning` prioritas footer** ([window.ts](file:///d:/Github/minicode/src/ui/screens/window.ts), [picker.ts#L181](file:///d:/Github/minicode/src/ui/screens/picker.ts#L181), [form.ts#L292](file:///d:/Github/minicode/src/ui/screens/form.ts#L292), [output-window.ts#L178](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L178)): saat `idleWarned === true`, ganti footer sementara dengan `c.error(truncateToWidth(t("form.idleWarning", ...), innerW, glyphs.ellipsis))` (pola identik dengan `approval/prompt.ts#L470`). Untuk `model-manager`, `provider-manager`, dan `wizard` (`waitForWizardDismiss`), upgrade `createIdleTimer` menjadi dua-tahap (`warnMs: IDLE_WARN_MS`, `cancelMs: IDLE_CANCEL_MS`) sehingga seluruh 7 modal konsisten memberi peringatan di detik ke-80.
  2. **Proteksi suffix daftar sempit** ([model-manager.ts#L136-L138](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L136-L138), [provider-manager.ts#L135-L137](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L135-L137)): hitung `nameBudget = Math.max(1, w - 4 - displayWidth(suffix) - displayWidth(iconPart))` tanpa memaksakan lantai `8` saat `w` sempit, dan taruh `${badge}` (`[high]`) bersama `${active}` di luar `truncateToWidth` id model; baca dimensi via `screen.cols`/`screen.rows`.
  3. **Wheel `@mention` & ellipsis dropdown** ([app.ts#L1097-L1106,L2780](file:///d:/Github/minicode/src/ui/tui/app.ts#L1097-L1106)): ganti cek `this.state.line.startsWith("/")` menjadi `this.activeSuggestions().items.length > 0` (untuk `@` saat menu terbuka, `↑`/`↓` sudah menggeser pilihan menu); pada `menuRows()`, ganti `chunkByWidth(l, w)[0]` dengan `truncateToWidth(l, w, glyphs.ellipsis)`.
  4. **`approval/prompt.ts` & `dialogBox`**: di `promptAsk` (`L410-L418`), ukur sisa tinggi `maxPreviewLines = Math.max(1, Math.min(5, (process.stdout.rows || 24) - 9))` agar `Tool`, `Risk`, dan opsi pilihan tidak hilang pada terminal `10–14` baris; di [dialog.ts#L133,L150-L160](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L133), gunakan `glyphs.ellipsis` di `cut()`, dan hitung `belowCount = spec.body.length - (bodyStart + shown)`: hanya cetak baris bawah bila `belowCount > 0` (di `bodyStart === 0`, nilainya tetap `spec.body.length - shown` sehingga `test/dialog.test.ts#L62` `"93"` tetap lulus!), serta tampilkan penanda ringkas terpotong atas bila `bodyStart > 0`.
  5. **Bracketed paste di modal non-form**: aktifkan `screen.setBracketedPaste?.(true)` saat mount dan `false` saat cleanup di `picker.ts`, `model-manager.ts`, dan `provider-manager.ts` (atau via `setBracketedPaste` jika `sink` mendukung di `prompt.ts`). **Mitigasi penting**: saat nested popup (`pickEffort` / `runForm`) di dalam `provider-manager`/`model-manager`, **hanya pemilik paling luar (`ownScreen`) atau simpan flag restore** yang mematikan `?2004l`, jangan sampai form di dalam manager mematikan bracketed paste milik induk sebelum `TuiApp` mengambil alih lagi!

---

## Gelombang 2 — Penyelarasan Footer & Peran Jendela *(Keputusan Kontrak UI v0.33)*

*Mengapa terpisah*: mengubah footer default akan menyentuh asersi literal test v0.33 ([test/audit-fix-window-uniform.test.ts#L125-L129](file:///d:/Github/minicode/test/audit-fix-window-uniform.test.ts#L125-L129) dan [test/audit-fix-window-uniform-output.test.ts#L48-L57](file:///d:/Github/minicode/test/audit-fix-window-uniform-output.test.ts#L48-L57)).

### W2.1. `windowFooter` berbasis peran (`role?: "list" | "form" | "viewer" | "progress"`)
- **Desain terpadu** di [src/ui/screens/window.ts](file:///d:/Github/minicode/src/ui/screens/window.ts):
  - Default (`role: "list"` / tidak diisi): mempertahankan perilaku exact `windowFooter()` (`↑↓ move  Enter select  Esc cancel`) → kompatibilitas mundur penuh untuk `picker`, `model-manager`, `provider-manager`, dan test eksisting.
  - `role: "form"`: footer dasar `[...(multiField ? [{ key: "Tab/↑↓", label: t("hint.move") }] : []), { key: "Enter", label: t("hint.save") }, { key: "Esc", label: t("hint.cancel") }]` ditambah `←→` / `←→/y/n` bila field aktif bertipe `select`/`confirm` — **nol `move` ganda, nol `Enter select`**.
  - `role: "viewer"` (`output-window`): dasar `[...(scrollable ? [{ key: glyphs.upDown, label: t("hint.scroll") }] : []), ...(canCopy ? [{ key: "c", label: t("hint.copy") }] : []), { key: "Enter/Esc", label: t("hint.close") }]` — **nol `Enter select` palsu**.
  - `role: "progress"` (kotak loading `/provider sync`, `/update`, `wizard` `"Detecting models…"`, `"Setup complete."`): `footer: undefined` (atau hanya `Esc cancel` bila benar bisa dibatalkan). Untuk error `wizard`: `[{ key: "r/Enter", label: t("hint.retry") }, { key: "b", label: t("hint.back") }, { key: "Esc", label: t("hint.cancel") }]`.
  - `approval/prompt.ts`: pakai `windowSpec({ role: "viewer" / custom baseHints })` yang bersih alih-alih menimpa `frame.footer` manual.
  - **Prioritas penyempitan footer** (mitigasi terminal `cols = 20..56`): bila `displayWidth(hintLine(items)) > innerW`, jatuhkan hint sekunder dari kiri-tengah secara terurut agar aksi paling krusial (`Enter`, `Esc`) tetap terbaca dan tidak terpotong di tengah kata.

### W2.2. Konsistensi tombol navigasi & penanganan error nested
- `model-manager.ts#L424`: samakan `Ctrl+C`/`Ctrl+D` pada mode filter agar konsisten menutup atau keluar jelas (evaluasi: `Esc` bersih filter, `Ctrl+C`/`Ctrl+D` langsung tutup seperti `picker.ts` — cek apakah ada test di `test/model-manager-flows.test.ts` yang mengunci `Ctrl+C` di mode filter sebelum mengubah!).
- `model-manager.ts#L496` & `provider-manager.ts#L562`: `Enter` di daftar kosong beri feedback singkat atau biarkan konsisten (`picker.ts` = tutup batal; manager = tutup / notice `"No models"` — pertahankan behavior aman agar user tidak menutup manager saat tidak sengaja).
- `model-manager.ts#L388` (`pickEffort` nested gagal open / non-modal): tangkap kegagalan dengan notice inline pada manager, bukan `console.log` yang tertelan `captureConsole`.
- `app.ts#L1265,L3545` (`tooSmall()`): tampilkan kotak/teks terpusat dengan info dimensi minimum (`20×10`) dan izinkan `Esc` serta `Ctrl+D` untuk keluar/abort aman (periksa test `tooSmall` di `test/tui-app.test.ts` agar abort turn saat sempit juga tetap diuji).

---

## Gelombang 3 — Compositing Scrim Backdrop, Penyatuan Gaya Box, & Kebijakan Bahasa *(Butuh Izin Pemilik)*

### W3.1. Hilangkan pita hitam kiri/kanan popup saat backdrop scrim aktif
- **Masalah**: [screen.ts#L319-L330](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L319-L330) menghapus penuh baris layar (`\x1b[2K`) lalu mencetak `" ".repeat(left) + box`.
- **Desain + Mitigasi SGR ketat**:
  1. Buat fungsi murni `compositeBackdropBoxLine(backdropLine: string, boxLine: string, totalCols: number): string` di `src/ui/render/width.ts` (menggunakan tokenizer SGR eksisting, tanpa duplikasi parser ESC!).
  2. Hitung `leftPad = boxLeftPad(stripAnsi(boxLine))` dan `boxVis = sliceColumns(boxLine, leftPad, boxWidth)` (potongan dari karakter sudut kiri sampai sudut kanan `│`/`╯`).
  3. Ambil segmen kiri `[0, leftPad)` dari `backdropLine` + `\x1b[0m` (reset penuh sebelum sudut kiri popup!).
  4. Ambil segmen kanan `[leftPad + boxWidth, totalCols)` dari `backdropLine` — **wajib mewarisi SGR aktif** yang sedang terbuka pada posisi `leftPad + boxWidth` di `backdropLine` (khususnya `\x1b[2;48;5;236m` saat `scrimMode() === "bg"`), dan ditutup `\x1b[0m` di ujung baris!
  5. **Penjagaan wide char**: bila karakter 2-kolom di `backdropLine` terbelah tepat pada batas `leftPad` atau `leftPad + boxWidth`, ganti separuh terbelah dengan spasi `" "` agar lebar total kolom baris tepat `totalCols` (nol drift margin kanan!).
  6. **Penjagaan test `NO_COLOR=1` (`test/tui-popup.test.ts#L231`)**: ketika `backdropLine` tidak mengandung `\x1b[2m`/`\x1b[48;5;`, komposit tidak menambahkan SGR apa pun, dan teks transkrip samping ikut terlihat bersih.
  7. **Penjagaan test `dialog.test.ts#L129`**: `dialogBox()` sendiri tetap murni tanpa backdrop; komposit terjadi **hanya** di `screen.ts` `paintRegion()` saat `backdropRows != null`.
  8. **Resize saat popup terbuka**: di `TuiApp.paintDimmed()` ([app.ts#L1867-L1885](file:///d:/Github/minicode/src/ui/tui/app.ts#L1867-L1885)), bila `(cols, rows)` berubah pada `backdropState`, re-pad/clamp atau re-center snapshot secara aman (bukan mutasi `scrollBack`) agar backdrop tidak menggeser/meninggalkan tepi hitam.

### W3.2. Penyatuan `MINICODE_BOX` lintas UI (`theme.ts`, `dialog.ts`, `table-grid.ts`)
- Buat satu helper runtime `resolveBoxStyle()` + `boxCharsForStyle()` di [src/ui/render/theme.ts](file:///d:/Github/minicode/src/ui/render/theme.ts):
  - Menghormati `MINICODE_ASCII=1` / `!supportsUtf8()` → `ascii` (`+-+|`); selain itu `MINICODE_BOX=ascii|square|rounded` (default `rounded`).
  - Pakai di `dialog.ts`, `composerBoxGlyphs()` (`theme.ts`), dan `renderBorderedGrid()` (`table-grid.ts`, dengan sudut dalam `├┼┤┬┴` menyesuaikan `ascii` vs `unicode`).
- *Mitigasi*: verifikasi `test/dialog.test.ts`, `test/tui-geometry.test.ts`, `test/tui-table.test.ts`, and `test/composer-box-and-paste.test.ts` — pada default tanpa env `MINICODE_BOX`, output box popup dan composer **100% identik** dengan sekarang!

### W3.3. Resolusi kebijakan bahasa `t()` (`/lang`) vs `tSystem()` (OS) — Menyatukan Audit #1 Track 2 & Audit #3
- **Rekomendasi**: patuhi [TERMINAL_CONTRACT.md](file:///d:/Github/minicode/docs/TERMINAL_CONTRACT.md):
  - **Jalur `t()` (`/lang`)**: semua chrome popup (`out.titleUpdate` di loading `/update`, notis clipboard `"Copied"`/`"Too large"` di `output-window`, `originLabel` di `/context`, toast UI di `cli/tui.ts`, dan `friendlyError()` generik).
  - **Jalur `tSystem()` (OS)**: label aktivitas tool `› …`, pesan gagal tool `friendlyToolError()`, serta fallback `msg.tooSmall` non-sesi.
- **Mitigasi test & docs**:
  - Tambah kunci `ctx.originCatalog` & `ctx.originSafeDefault` ke `en.ts` & `id.ts`.
  - Perbarui [test/context-command.test.ts#L158-L159](file:///d:/Github/minicode/test/context-command.test.ts#L158-L159), [test/output-window.test.ts#L78,L98](file:///d:/Github/minicode/test/output-window.test.ts#L78), dan [test/tui-lang.test.ts](file:///d:/Github/minicode/test/tui-lang.test.ts), plus catatan [docs/config.md](file:///d:/Github/minicode/docs/config.md) & [docs-en/config.md](file:///d:/Github/minicode/docs-en/config.md).
  - Rapikan alignment label `/status` (`st.*`) pada `en.ts` & `id.ts` supaya titik dua & kolom nilai sejajar lurus.

---

## Gelombang 4 — Kerapian Konten Harian, Overlay Dropdown, `ask_user`, & Sisa Keputusan Audit #1

1. **Kerapian daftar popup**:
   - Samakan tinggi daftar `visibleRows` menjadi maks `12` baris (proporsional dengan `rows - chrome`) untuk `picker`, `model-manager`, dan `provider-manager` (cek test `model-manager-flows.test.ts` & `provider-manager-flows.test.ts` tentang jumlah baris saat list panjang!).
   - Tambahkan counter `(start-end/total)` di judul `picker`/`model-manager`/`provider-manager` ketika `total > visibleRows`.
   - **`/provider`**: tampilkan ringkasan host/URL redup (`baseUrl`) di kanan baris setelah `● id (n)` (dipotong aman sebelum `(active)`).
   - **`/model`**: saat `Ctrl+U` mengosongkan query, set `filter = null` (langsung kembali ke mode normal sehingga tidak ada dua keadaan kosong yang tampak identik), tambahkan placeholder redup di `> ` saat kosong, dan terapkan `highlightMatch` aman-grapheme (bandingkan per-grapheme alih-alih mengandalkan `String.prototype.toLowerCase().length` yang bisa bergeser pada Unicode tertentu) pada ID yang tampil.
   - **`/sessions` ([cli/commands.ts#L1000-L1004](file:///d:/Github/minicode/cli/commands.ts#L1000-L1004))**: aktifkan `category: "session"` (`glyphs.sessionIcon`), tata item menjadi `humanName · shortDir · id` (mengutamakan direktori agar tidak selalu hilang terpotong di 80 kol) dan beri tanda sesi aktif.
   - **`wizard.ts`**: jadikan dialog error gagal deteksi mendukung gulir ↑↓/PgUp/PgDn bila `wrapped.length > rows - 4`.
   - **`picker.ts`**: ganti `{ key: glyphs.caret, label: t("hint.edit") }` (`█ edit` / `# edit`) menjadi teks yang jelas (mis. `{ key: "Type", label: t("hint.filter") }` atau placeholder redup di baris input).
2. **`/help full` & `/help keys` wrapping** ([cli/commands.ts#L732,L745](file:///d:/Github/minicode/cli/commands.ts#L732) & [output-window.ts#L45-L55](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L45-L55)):
   - Buat `wrapCommandLines()` mendeteksi kolom deskripsi pada baris dua-kolom (atau kembalikan daftar terstruktur dari `/help` saat di TUI) agar sambungan deskripsi pada jendela `56–70` kolom sejajar dengan kolom deskripsi, tidak jatuh ke kolom `5`.
3. **Dropdown `/` & `@`, `ask_user`, & Sisa Keputusan Audit #1**:
   - **Dropdown `/` & `@`**: pertahankan `/` pada item command (`clean`, tidak `replace(/^\/+/, "")`), tambah indikator panah/jumlah sisa item saat kandidat `> MAX_DROPDOWN_ROWS`, dan (bila disetujui pemilik) tambahkan 1 baris divider tipis pemisah di atas menu tanpa mengurangi `viewH` secara konsisten (`overlay` tetap utuh).
   - **`Enter` pada `@mention` (`app.ts#L1316-L1326`)**: lengkapi kandidat terpilih (`sel >= 0 ? sel : 0`) pada `Enter` seperti `Tab`, hanya jika token sebelum kursor masih `@<query>` yang cocok — menghindari submit teks `@query` mentah secara tak sengaja.
   - **`ask_user` (`promptAskText` di [approval/prompt.ts#L541-L570](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L541-L570))**: dukung navigasi `↑↓` untuk menyorot `options[]` (menjaga pengetikan teks bebas tetap berfungsi seketika untuk mempertahankan kompatibilitas `test/approval-tui.test.ts#L80-L85`!) plus 1 baris kosong sebelum baris ketik `> `.
   - **`src/tools/task.ts` (Audit #1 Track 2)**: putuskan terpisah apakah kegagalan sub-agent perlu menandai `isError: true` dan mempartisi cooldown `providerCooldownUntil`/`subAgentHistory` per `provider|model|session|cwd` (memerlukan pengecekan kontrak `P9.2.1` & presentation adapter).

---

## Ringkasan Verifikasi per Gelombang

Sesuai `AGENTS.md`: verifikasi lokal per gelombang cukup `tsc --noEmit` + `bun run lint` + test terarah modul yang tersentuh; gate penuh (`bun run gate:fast`) hanya dijalankan atas instruksi rilis pemilik:
- **Pasca Gelombang 1**: `output-window.test.ts`, `audit-fix-window-uniform-output.test.ts`, `context-command.test.ts`, `tui-table.test.ts`, `form.test.ts`, `provider-manager-flows.test.ts`, `model-manager-flows.test.ts`, `wizard.test.ts`, `approval-tui.test.ts`, `dialog.test.ts`, `tui-app.test.ts`, `update-command.test.ts`.
- **Pasca Gelombang 2 & 3**: tambahkan `audit-fix-window-uniform.test.ts`, `audit-fix-window-uniform-managers.test.ts`, `tui-popup.test.ts`, `tui-geometry.test.ts`, `tui-lang.test.ts`, `composer-box-and-paste.test.ts`, `i18n.test.ts`, `i18n-hardcode.test.ts`, `ui-boundary.test.ts`, `writer-inventory.test.ts`, `no-frozen-runtime-value.test.ts`.
- **Pasca Gelombang 4**: tambahkan `cli-handlers.test.ts`, `cli-help-language.test.ts`, `ui-audit-regressions.test.ts`, `hang-fix.test.ts`, `stdin-flow.test.ts`, serta test terkait `task.ts` bila disentuh.
