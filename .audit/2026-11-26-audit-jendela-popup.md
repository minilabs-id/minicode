# Audit Mendalam Jendela Popup & Permukaan Sekunder (Parameter Kerapian)

Tanggal: 2026-11-26
Checkout referensi: `cf181ac` (+ penghapusan daftar provider terdaftar)
Cakupan: seluruh jendela di luar transkrip chat utama — `window.ts`, `dialog.ts`, `output-window.ts`, `picker.ts`, `form.ts`, `model-manager.ts`, `provider-manager.ts`, `wizard.ts`, `approval/prompt.ts`, `screen.ts`, `table.ts`, overlay dropdown `/` & `@` di `TuiApp`, kotak progres & orkestrasi di `cli/tui.ts`, serta pembangun readout di `cli/commands.ts` / `cli/context-command-run.ts`.

---

## Ringkasan Masalah

Audit menemukan **17 masalah nyata** yang menurunkan kerapian visual, keakuratan informasi, konsistensi navigasi, dan integritas layout di jendela popup & permukaan non-chat utama:
- **4 Bug Layout & Pemotongan** (isi terpotong `… N more` palsu, tabel pecah, modal approval menyembunyikan opsi saat pendek, penanda potong atas hilang).
- **4 Bug Kursor, Backdrop, & Siklus Screen** (kursor keluar border kanan, label `(active)` terpotong di layar sempit, `/update` gagal hilangkan scrim redup backdrop, backdrop beku saat resize).
- **4 Inkonsistensi Footer, Tombol, & Idle** (`windowFooter` memaksakan hint bohong/ganda, inkonsistensi `Esc`/`Ctrl+C`/`Enter`, absennya peringatan idle 80 dtk di `/model`, `/provider`, `wizard`).
- **5 Kerapian Visual, Konten, & Overlay Inline** (lebar kotak progres meloncat + bahasa campur, daftar `/provider` & `/sessions` & `/model` kurang rapi, `/help` & `/status` alignment pecah, wheel pada `@mention` menggulir chat bukan menu, ketiadaan bracketed paste & klik mouse).

---

## A. Bug Geometri, Pemotongan, & Rendering Frame

### A1. `output-window`: anggaran tinggi off-by-4 → halaman kepotong `… N more` & `PgDn` melompat
- **Lokasi**: [src/ui/screens/output-window.ts#L88-L99](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L88-L99), [L156-L198](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L156-L198), [L294-L296](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L294-L296) vs [src/ui/screens/window.ts#L30-L38](file:///d:/Github/minicode/src/ui/screens/window.ts#L30-L38) & [src/ui/screens/dialog.ts#L142-L160](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L142-L160).
- **Akar masalah**: `windowMaxHeight(rows)` mengembalikan `rows` penuh (sudah termasuk 4 baris chrome). `output-window.ts` salah menggunakannya langsung sebagai anggaran **isi**: `bodyBudget() = windowMaxHeight(rows)` (= `24` di terminal 24 baris), sementara `dialogBox()` men-clamp `boxBudget = min(r0, maxHeight)` (= `24`) lalu mengurangi `chromeFixed = 4` → `room = 20`.
- **Dampak kerapian**:
  - Pada `/help full`, `/logs`, atau `/status` panjang di 24 baris: header menjanjikan `(1-24/40)`, tetapi `dialogBox` melihat `24 > 20`, memotong ke `19` baris, dan menimpa baris ke-20 dengan `... 5 more`.
  - Baris 20–24 tiap halaman hilang, dan `PgDn`/`Space` melompat `budget - 1 = 23` baris sehingga baris terlewati saat menggulir.
  - Saat `copyNotice` (`Copied`) muncul di baris 0, jendela memotong lagi karena slice tetap `budget - 1 = 23 > 20`.
- **Perbaikan**: `bodyBudget()` harus `Math.max(1, windowMaxHeight(screen.rows) - WINDOW_CHROME_ROWS)`, `outputWindowSpec` tidak perlu menambah `WINDOW_CHROME_ROWS` ke `maxHeight`.

### A2. `/context` & `renderTable`: tabel memakai rumus lebar legacy & `getTerminalWidth()` → border kotak pecah
- **Lokasi**: [cli/context-command-run.ts#L73-L86](file:///d:/Github/minicode/cli/context-command-run.ts#L73-L86), [src/ui/render/table.ts#L33](file:///d:/Github/minicode/src/ui/render/table.ts#L33).
- **Akar masalah**: `/context` menghitung kolom menggunakan fungsi legacy `outputWindowWidth(cols)` (maks `96`, bukan `windowWidth(cols)` maks `88`), dan `renderTable()` mengabaikan anggaran lebar jendela output lalu meneruskan `width: getTerminalWidth()` ke `renderGridTable`.
- **Dampak kerapian**: Saat terminal lebar (`> 100` kolom) atau model panjang hadir, tabel dirakit lebih lebar dari `innerW` jendela output (`84` kolom); `wrapCommandLines()` di `output-window` lalu membungkus tiap baris tabel melewati garis border vertikal `│`, memecah tampilan tabel.
- **Perbaikan**: Hitung dan kirim `maxWidth` tabel memakai `windowWidth(cols) - 4` lewat parameter opsi `renderTable` (atau `renderGridTable` langsung).

### A3. `approval/prompt.ts`: `focusRow` menggeser header `Tool`/`Risk` & menyembunyikan `Always`/`Deny`
- **Lokasi**: [src/ui/approval/prompt.ts#L309-L315](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L309-L315), [L465-L474](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L465-L474), [src/ui/screens/dialog.ts#L150-L154](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L150-L154).
- **Akar masalah**: `promptAsk` menggabungkan `info` + maks 5 baris `summaryLines` + `""` + 3 pilihan (`Allow once`, `Always allow`, `Deny`) menjadi hingga `11` baris `body`, lalu mem-pin hanya `focusRow = spec.body.length + 1 + sel`.
- **Dampak kerapian**: Di terminal `10–14` baris (masih lolos `canRenderModal`), saat `sel = 0`:
  - `bodyStart` mendorong baris paling atas (`Tool: bash`, `Risk: ...`) keluar layar;
  - `Always allow` dan `Deny` di bawah ikut terpotong menjadi `... N more` sehingga pilihan tidak langsung terlihat tanpa menekan panah bawah dulu.
- **Perbaikan**: Di `promptAsk`, sesuaikan batas `cappedSummary` secara dinamis dengan `screen.rows` yang tersedia agar `info` + ringkasan + seluruh 3 opsi selalu muat terlihat bersamaan (atau scroll hanya area preview).

### A4. `dialogBox`: indikator `… N more` keliru saat ter-scroll & memakai `...` 3 titik
- **Lokasi**: [src/ui/screens/dialog.ts#L133](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L133), [L150-L160](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L150-L160).
- **Akar masalah**:
  1. `cut` memakai default `ellipsis = "..."` (3 kolom), tidak konsisten dengan `glyphs.ellipsis` (`"…"`, 1 kolom) yang dipakai `picker`, `model-manager`, `provider-manager`, dan `errors`.
  2. Ketika `bodyStart > 0` (karena `focusRow` menggeser body), baris paling bawah tetap mencetak `t("dlg.more", { n: spec.body.length - shown })` — menjumlahkan baris tersembunyi di ATAS dan BAWAH, tanpa penanda apa pun di atas, bahkan saat `bodyStart + shown === spec.body.length` (tidak ada lagi baris di bawah).
- **Perbaikan**: Pakai `glyphs.ellipsis` di `dialogBox`; bedakan penanda `↑ N above` vs `↓ N more` hanya ketika masing-masing `bodyStart > 0` atau `bodyStart + shown < spec.body.length`.

---

## B. Bug Kursor, Backdrop, & Siklus Screen

### B1. `form.ts`: kursor bar muncul di luar border kanan kotak pada field `select`/`confirm`
- **Lokasi**: [src/ui/screens/form.ts#L260-L273](file:///d:/Github/minicode/src/ui/screens/form.ts#L260-L273), [L317-L362](file:///d:/Github/minicode/src/ui/screens/form.ts#L317-L362).
- **Akar masalah**: Pada field `select` (`/mode`, `Scope`) dan `confirm` (hapus provider/model), `activeCol = -1`. Alih-alih menyembunyikan kursor lewat `screen.setCursorVisible(false)`, `render()` memakai cabang else `raw = leftPad + contentW + 1` yang mengarahkan `screen.moveCursor(row, col)` (dan menyalakan `CARET_BAR` + `SHOW_CURSOR`) tepat **1 kolom di luar garis kanan `│` kotak**. Saat `finish()`, form juga tidak menyembunyikan kursor.
- **Perbaikan**: Bila `activeCol < 0` (atau `!fields[idx]` bertipe teks), panggil `screen.setCursorVisible(false)`; panggil juga saat `finish()` sebelum `clearRegion()`.

### B2. `/model` & `/provider`: `active` terpotong pada terminal sempit & badge `[effort]` tertelan
- **Lokasi**: [src/ui/screens/model-manager.ts#L136-L138](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L136-L138), [src/ui/screens/provider-manager.ts#L135-L137](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L135-L137).
- **Akar masalah**: Keduanya memakai `nameBudget = Math.max(8, w - 4 - displayWidth(active) - displayWidth(iconPart))`. Pada terminal selebar `20–28` kolom (`w = 12..20`), lantai `8` membuat total panjang melebihi `w`, lalu `dialogBox` memotong ujung kanan sehingga badge ` (active)` hilang. Selain itu di `model-manager`, `${badge}` (` [high]`) diletakkan di DALAM `truncateToWidth(...)`, sehingga nama model panjang memakan badge thinking effort.
- **Perbaikan**: Ganti `Math.max(8, ...)` menjadi `Math.max(1, Math.min(w - 4 - ..., ...))` atau potong hanya bagian ID sebelum `${badge}${active}`.

### B3. `/update` yang gagal pasca-`install` menghilangkan scrim redup di belakang `output-window`
- **Lokasi**: [cli/tui.ts#L870-L896](file:///d:/Github/minicode/cli/tui.ts#L870-L896), [L2051-L2085](file:///d:/Github/minicode/cli/tui.ts#L2051-L2085), [src/ui/tui/app.ts#L1734-L1736](file:///d:/Github/minicode/src/ui/tui/app.ts#L1734-L1736), [L1805-L1820](file:///d:/Github/minicode/src/ui/tui/app.ts#L1805-L1820).
- **Akar masalah**: `app.suspend()` mengatur `suspended = 1`. Saat `/update` masuk `install`, `releaseTerminal()` menghapus `backdropState`. Jika instalasi gagal, `reacquireTerminal()` melukis `App` dengan warna penuh (bukan backdrop redup). Lalu `showCommandOutput()` memanggil `app.suspend()` yang langsung early-return (`if (this.suspended++ > 0) return`) sehingga `paintDimmed()` tidak dipanggil lagi. Juga pada [cli/tui.ts#L2070](file:///d:/Github/minicode/cli/tui.ts#L2070), `onResize` selalu menulis ulang `"Checking for updates…"`.
- **Perbaikan**: Setelah `reacquireTerminal()` saat `suspended > 0`, panggil `paintDimmed()` (atau panggil `showCommandOutput` setelah `app.resume()`).

### B4. Backdrop redup beku di dimensi lama saat resize + inkonsistensi sumber `cols`/`rows`
- **Lokasi**: [src/ui/tui/app.ts#L1859-L1885](file:///d:/Github/minicode/src/ui/tui/app.ts#L1859-L1885), [src/ui/runtime/screen.ts#L313-L317](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L313-L317); [model-manager.ts#L94,L101](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L94), [provider-manager.ts#L99,L108](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L99), [picker.ts#L117](file:///d:/Github/minicode/src/ui/screens/picker.ts#L117).
- **Akar masalah**: `backdropState` menyimpan snapshot baris yang di-render pada dimensi sebelum popup dibuka (`frozen`). Bila terminal diperlebar/diperkecil saat popup terbuka, kotak modal bergeser ke tengah dimensi baru, sementara latar chat redup di belakang tetap ter-center pada dimensi lama (menyisakan tepi kosong hitam di kanan atau terpotong miring). Selain itu `bodyLines`/`visibleRows` di picker & kedua manager masih membaca `process.stdout.columns/rows` alih-alih `screen.cols/rows`.

---

## C. Inkonsistensi Footer, Tombol Kontrol, & Idle Timeout

### C1. `windowFooter` menyuntikkan hint statis `↑↓ move  Enter select  Esc cancel` yang menabrak konteks
- **Lokasi**: [src/ui/screens/window.ts#L41-L49](file:///d:/Github/minicode/src/ui/screens/window.ts#L41-L49).
- **Dampak di 3 layar**:
  1. **`form.ts`** ([L92-L109](file:///d:/Github/minicode/src/ui/screens/form.ts#L92-L109)): `defaultExtraHints` tidak me-replace key `↑↓` maupun `Enter`, sehingga footer berbunyi `↑↓ move  Enter select  Esc cancel  Tab move  Enter save` (ganda `move` + dua aksi `Enter` kontradiktif). Pada dialog konfirmasi 1 field (`model-manager.ts#L354`, `provider-manager.ts#L404`), `↑↓ move` tetap tampil padahal hanya ada 1 field. Bila terminal sempit (`40–60` kol) atau muncul `idleWarning`, footer panjang ini terpotong diam-diam di ujung kanan (`Tab move` / `Enter save` / `Esc cancel` hilang).
  2. **`output-window.ts`** ([L177-L184](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L177-L184), [L259](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L259)): `Enter` sebenarnya **menutup** jendela (`finish(true)`), tapi footer tidak menimpa `"Enter"`, sehingga tampil `Enter select` dan `Esc close` sekaligus; saat tidak `scrollable`, `↑↓ move` tetap muncul padahal tidak bisa digulir. Tombol pager lazim `q` juga tidak didukung.
  3. **`wizard.ts`** ([L240-L290](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L240-L290)): kotak pasif `"Detecting models…"` dan `"Setup complete."` tetap menampilkan `↑↓ move  Enter select  Esc cancel` meski tanpa handler keyboard apa pun; dialog gagal tetap menampilkan `↑↓ move  Enter select` di kiri `r/Enter retry`.
- **Perbaikan**: Tambahkan opsi di `WindowSpecOptions` (`hints?: readonly HintItem[]` atau `mode` / `suppressDefaultNav?: boolean`) agar tiap jenis permukaan (list vs form vs readonly viewer vs passive progress) hanya merender hint yang benar-benar berlaku, dan lakukan prioritas/ringkas hint saat lebar terminal sempit agar aksi kritis & `idleWarning` tidak terpotong.

### C2. Semantik `Esc`, `Ctrl+C`, `Ctrl+D`, & `Enter` tidak konsisten antar popup
- **Lokasi**:
  - `Esc`/`Ctrl+C` di [form.ts#L472-L479](file:///d:/Github/minicode/src/ui/screens/form.ts#L472-L479): dua-tahap (reset field kotor ke default dulu, tekan ke-2 baru batal) **tanpa feedback teks**. Pada `/mode`, mengubah `Discuss` → `Build` lalu menekan `Esc` justru mengembalikan nilai ke `Discuss` secara diam-diam (user mengira `Esc` batal & tutup).
  - `Ctrl+C`/`Ctrl+D` di [model-manager.ts#L424-L433](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L424-L433) ketika mode filter aktif hanya menghapus filter (tidak menutup manager), bertolak belakang dengan [picker.ts#L418-L423](file:///d:/Github/minicode/src/ui/screens/picker.ts#L418-L423) di mana `Ctrl+C`/`Ctrl+D` selalu menutup.
  - `Enter` pada daftar hasil kosong: di `picker.ts` menutup modal (`onCancel`), di `model-manager.ts#L496` & `provider-manager.ts#L562` tidak melakukan apa-apa tanpa pesan.

### C3. Peringatan idle 80 detik (`idleWarning`) tidak merata
- **Lokasi**: [src/ui/screens/model-manager.ts#L217-L220](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L217-L220), [src/ui/screens/provider-manager.ts#L195-L205](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L195-L205), [src/ui/screens/wizard.ts#L72-L75](file:///d:/Github/minicode/src/ui/screens/wizard.ts#L72-L75).
- **Masalah**: `picker`, `form`, `output-window`, dan `approval/prompt` menampilkan peringatan `IDLE_WARN_MS` (`80s`) merah di footer selama 10 detik sebelum menutup di 90s; sebaliknya `/model`, `/provider`, dan kotak error wizard memakai timer 1-tahap dan menutup mendadak di detik ke-90.

### C4. Mode `tooSmall()` mengunci tombol keluar kecuali `Ctrl+D` & tampil mentah di pojok kiri atas
- **Lokasi**: [src/ui/tui/app.ts#L1265-L1268](file:///d:/Github/minicode/src/ui/tui/app.ts#L1265-L1268), [L3545-L3553](file:///d:/Github/minicode/src/ui/tui/app.ts#L3545-L3553).
- **Masalah**: Saat terminal diciutkan di bawah `20×10`, `tooSmall()` hanya membolehkan `Ctrl+D` (`Esc`/`Ctrl+C` tidak diterima untuk batal/keluar) dan pesan `Terminal too small` ditulis mentah di baris 1 kolom 1 tanpa pemusatan ataupun info dimensi minimum. Pada `pickEffort` nested di `/model` ([model-manager.ts#L388](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L388)), bila `canRenderModal` gagal atau `setRawMode` melempar di nested picker, `console.log("⚠ ...")` di [picker.ts#L255](file:///d:/Github/minicode/src/ui/screens/picker.ts#L255) tertahan di buffer `captureConsole` sampai `/model` ditutup — menekan `Tab` saat error tampak no-op total.

---

## D. Kerapian Visual, Konten Jendela, & Overlay

### D1. Kotak progres `/provider sync` & `/update` memakai `popupBoxWidth` legacy + bahasa campur
- **Lokasi**: [cli/tui.ts#L2008-L2025](file:///d:/Github/minicode/cli/tui.ts#L2008-L2025), [L2052-L2080](file:///d:/Github/minicode/cli/tui.ts#L2052-L2080); [src/ui/screens/output-window.ts#L195,L269-L272](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L195).
- **Masalah**:
  - Kedua modal progres memakai `popupBoxWidth(cols)` (`floor(cols * 0.6)` = 48 di terminal 80 kolom) lalu bertransisi ke `runOutputWindow` (`windowWidth(cols)` = 76 kolom), sehingga bingkai kotak meloncat lebar begitu probe selesai. Keduanya juga tanpa footer (tinggi 3 baris).
  - Kotak loading `/update` memakai `tSystem("out.titleUpdate")` (locale OS) sementara jendela hasilnya memakai `t("out.titleUpdate")` (locale `/lang` sesi) — judul berganti bahasa saat transisi jika `/lang` ≠ locale OS.
  - Notice `Copied` / `Too large` di `output-window` juga memakai `tSystem(...)`, berlawanan dengan seluruh label/hint di jendela yang sama (`t(...)`).

### D2. Asimetri tinggi daftar, scroll indicator, ikon kategori, & kelengkapan informasi baris
- **Lokasi & temuan**:
  1. **Tinggi daftar tak seragam**: maks baris isi di `model-manager` = `8` ([L102](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L102)), `picker` = `12` ([L122](file:///d:/Github/minicode/src/ui/screens/picker.ts#L122)), `provider-manager` = `14` ([L109](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L109)) — daftar `/model` yang lazimnya paling panjang justru diberi jendela paling sempit.
  2. **Tidak ada indikator posisi/sisa gulir**: `picker`, `/model`, dan `/provider` menyembunyikan baris ke-`N+1` tanpa angka `(1-12/45)` di judul (padahal `output-window` punya) maupun tanda `↑`/`↓` di batas atas/bawah list.
  3. **Dead field `category: "session"` di `/sessions` + baris padat terpotong**: `picker.ts#L30,L167` menyediakan `category: "session"` (`glyphs.sessionIcon`), tetapi [cli/commands.ts#L1000-L1004](file:///d:/Github/minicode/cli/commands.ts#L1000-L1004) lupa mengirimkannya. Baris item memadatkan 4 elemen ke satu string yang dipotong di ekor → `cwd` sering terpotong habis, dan sesi aktif tidak diberi tanda.
  4. **Baris `/provider` minus `baseUrl`**: [provider-manager.ts#L128-L138](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L128-L138) hanya merender `● <id> (<n>)`. Setelah preset dihapus dan ID berupa slug host, membedakan beberapa endpoint/path mirip menuntut pengguna menekan `e` satu per satu.
  5. **`/model` filter UX**: [model-manager.ts#L120-L121](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L120-L121) & [L440-L456](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L440-L456) — keadaan `filter === null` dan `filter === ""` (pasca `Ctrl+U`) tampil identik (`> ` kosong), padahal di `filter === ""` tombol `Esc` tidak menutup jendela, `Del` tidak menghapus model, dan hint `Del delete` tiba-tiba hilang dari footer. Filter juga tanpa placeholder redup, tanpa hint ketik-cari di footer, dan tanpa highlight kecocokan seperti di `picker.ts`.
  6. **`highlightMatch` di `picker.ts#L53-L63`**: menyocokkan query pada `truncated` (jika `cwd` pada `/sessions` terpotong, query yang cocok dengan `it.name` tetap tampil tapi tidak di-highlight) dan mengiris string asli memakai indeks `label.toLowerCase()` (rentan salah offset pada karakter Unicode non-ASCII yang panjang case-fold-nya berubah).
  7. **Notice menggeser list**: notice di `/model` (`L144`) dan `/provider` (`L142`) ditempel rapat tepat di bawah item terakhir dan mengurangi `visibleRows()`, membuat isi daftar melompat naik-turun ketika notice muncul lalu hilang.
  8. **Error modal `wizard.ts#L272-L290` tak bisa di-scroll**: error jaringan panjang yang ter-wrap melebihi `rows - 4` langsung terpotong `… N more`.

### D3. Kerapian teks terformat di dalam `output-window` (`/help`, `/status`)
- **Lokasi**: [cli/commands.ts#L732,L745](file:///d:/Github/minicode/cli/commands.ts#L732) vs [src/ui/screens/output-window.ts#L45-L55](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L45-L55); [en.ts#L259-L280](file:///d:/Github/minicode/src/ui/i18n/en.ts#L259-L280) & [id.ts#L265-L288](file:///d:/Github/minicode/src/ui/i18n/id.ts#L265-L288).
- **Masalah**:
  - `/help full` dan `/help keys` mem-pad kolom kiri ke lebar `26`/`32` kolom, sementara `wrapCommandLines()` hanya mengindentasi baris lanjutan sejauh spasi awal baris (`2`–`4` spasi). Pada lebar jendela `56–70` kolom, deskripsi yang membungkus jatuh ke kolom `5` tepat di bawah nama perintah/tombol.
  - Label `/status` (`st.*`) memiliki lebar prefix yang tidak sejajar (`WorkMode:`/`Permission:`/`Mode izin:` meleset 1–2 kolom dari `Model:`/`Provider:`/`Context:` baik di `en` maupun `id`).

### D4. Overlay Dropdown `/` & `@` + Modal `ask_user` + Mouse di Modal Layer 2
- **Lokasi**: [src/ui/tui/app.ts#L1094-L1107](file:///d:/Github/minicode/src/ui/tui/app.ts#L1094-L1107), [L2750-L2781](file:///d:/Github/minicode/src/ui/tui/app.ts#L2750-L2781), [L2918-L2938](file:///d:/Github/minicode/src/ui/tui/app.ts#L2918-L2938), [L3464-L3469](file:///d:/Github/minicode/src/ui/tui/app.ts#L3464-L3469); [src/ui/approval/prompt.ts#L541-L570](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L541-L570).
- **Masalah**:
  - **Bug wheel pada `@mention`**: [app.ts#L1102](file:///d:/Github/minicode/src/ui/tui/app.ts#L1102) memeriksa `this.state.line.startsWith("/") && this.host.listCommands(...)`, sehingga saat dropdown **`@`** terbuka, memutar scroll wheel malah menggulir transkrip chat di belakangnya alih-alih menggeser pilihan file `@`!
  - **Tampilan dropdown mentah**: menu langsung menimpa baris transkrip terbawah tanpa border/separator pemisah atas, tanpa penanda scroll atas/bawah saat item > `MAX_DROPDOWN_ROWS` (`8`), mencabut prefiks `/` dari item command (`help`, bukan `/help`) sementara `@path` mempertahankan `@`, tanpa deskripsi singkat perintah, serta memotong path panjang pakai `chunkByWidth(l, w)[0]` tanpa tanda `…`.
  - **Klik ganda tersirat tanpa hover**: klik pertama di menu hanya menyorot, klik kedua baru melengkapi; hover mouse diabaikan; klik mouse pada baris item di SEMUA modal Layer 2 (`picker`, `/model`, `/provider`, `/mode`, `approval`) diabaikan meski `suspend()` mengirim event mouse `?1000h`.
  - **`ask_user` (`promptAskText`)**: opsi berindeks `options[]` dirender sebagai daftar teks statis (harus mengetik `"1"`/`"2"` + Enter, tidak mendukung pemilihan panah `↑↓`) dan tanpa jeda baris kosong sebelum input `  > `.

### D5. Bracketed paste tidak aktif di modal non-form
- **Lokasi**: [src/ui/screens/picker.ts](file:///d:/Github/minicode/src/ui/screens/picker.ts), [src/ui/screens/model-manager.ts](file:///d:/Github/minicode/src/ui/screens/model-manager.ts), [src/ui/screens/provider-manager.ts](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts), [src/ui/approval/prompt.ts](file:///d:/Github/minicode/src/ui/approval/prompt.ts) vs [src/ui/screens/form.ts#L608](file:///d:/Github/minicode/src/ui/screens/form.ts#L608) & [src/ui/screens/output-window.ts#L328](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L328).
- **Masalah**: Hanya `form` dan `output-window` yang mengaktifkan `\x1b[?2004h`. Ketika `picker` dibuka langsung di luar `TuiApp` (mis. CLI / `wizard` / nested) dan pengguna mem-paste teks yang mengandung newline, byte `\r`/`\n` tidak dibungkus paste token sehingga dapat langsung mengirim `Enter` (memilih item secara tak sengaja).

---

## Prioritas Perbaikan yang Disarankan (Siap Dikonfirmasi Pemilik)

1. **Perbaikan Cepat & Aman (Bug murni, nol risiko UX)**:
   - A1 (`output-window.ts` anggaran `rows - 4` + hilangkan `dlg.more` palsu).
   - B1 (`form.ts` `setCursorVisible(false)` pada field non-teks).
   - B3 (`cli/tui.ts` restore backdrop redup & resize text di `/update` + samakan lebar `windowWidth` & bahasa `t()` pada progres `/update` & `/provider sync`).
   - D4 sebagian (wheel `@mention` menggerakkan item menu + ellipsis `…` di dropdown).
   - B2 (`model-manager` & `provider-manager` jaga `active` & `[effort]` di terminal sempit).
2. **Penyelarasan Chrome & Footer (Perlu persetujuan/arah pemilik karena mengubah teks hint/tampilan semua popup)**:
   - C1 & A4 (`windowFooter` adaptif per jenis jendela: list vs form vs viewer vs progress; `dialogBox` pakai `…` dan pisahkan `↑ N above` vs `↓ N more`).
   - C2, C3, D2 (seragamkan `Esc`/`Ctrl+C`/empty `Enter`, tambah `idleWarning` 80 dtk di manager & wizard, tampilkan indikator scroll `(1-N/total)` + `baseUrl` di `/provider`, `category: "session"` + tata letak `/sessions`, placeholder & badge status filter di `/model`, pembungkus kolom `/help` + alignment `/status`).
3. **Peningkatan Interaksi (Opsional sesuai preferensi)**:
   - Separator/tampilan dropdown `/` & `@`, pemilihan panah pada `ask_user` yang punya `options[]`, klik baris di modal Layer 2, dan scrollable error modal di `wizard`.
