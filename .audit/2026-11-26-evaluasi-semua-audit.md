# Riset & Evaluasi Menyeluruh Atas 3 Audit Terakhir (2026-11-26)

Dokumen ini mendalami, memverifikasi silang terhadap riwayat commit (`fa6e2c2`, `cf181ac`), kontrak terminal ([TERMINAL_CONTRACT.md](file:///d:/Github/minicode/docs/TERMINAL_CONTRACT.md), [environment.md](file:///d:/Github/minicode/docs/environment.md)), dan *test locks* untuk seluruh temuan pada 3 audit terbaru:
1. [2026-11-26-audit-keselarasan.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-keselarasan.md) (+ rekomendasi di [2026-11-26-rekomendasi-penyelarasan.md](file:///d:/Github/minicode/.audit/2026-11-26-rekomendasi-penyelarasan.md))
2. [2026-11-26-audit-jendela-popup.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-jendela-popup.md)
3. [2026-11-26-audit-konsistensi-popup-kustom.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-konsistensi-popup-kustom.md)

---

## 1. Status Audit #1 (`audit-keselarasan.md`) pada Checkout Saat Ini

Mayoritas temuan **Audit #1 Track 1 sudah selesai dikomit pada `fa6e2c2`** (dirilis sebagai `v0.51.0` di `cf181ac`):
- 11 test working tree sudah hijau; `WORKSPACE_MUTATING_TOOLS` memakai `WRITE_TOOLS`; `activity-group.ts`, `tool-label.ts`, `cli/model-manager.ts`, `cli/provider-manager.ts`, `cli/commands/exec.ts`, `src/ui/render/errors.ts` (`refused`/`unavailable`), dan sinkronisasi `TERMINAL_CONTRACT.md`/`docs-en/` sudah terpasang.
- **Yang tersisa dari Audit #1 hanya 3 keputusan kebijakan/arsitektur (Track 2)**:
  1. Kebijakan `tSystem()` (locale OS) vs `t()` (`/lang`) pada UI/popup/error (beririsan langsung dengan temuan popup di Audit #2 & #3).
  2. Apakah `Enter` saat dropdown `@mention` terbuka dan `sel === -1` harus melengkapi item pertama atau tetap submit teks mentah (`app.ts#L1316-L1326`).
  3. Kontrak `isError` & isolasi cooldown global di `src/tools/task.ts` (`delegate_task`).

---

## 2. Evaluasi Kritis Temuan Popup (Audit #2 & #3) terhadap Kontrak & Test Locks

Riset kode & test membuktikan bahwa temuan di Audit #2 & #3 terbagi tegas menjadi **4 kelas**:

### Kelas I — Bug Nyata (Verifikasi Kuat, Tidak Melanggar Kontrak; Layak Diprioritaskan)

1. **`output-window`: anggaran tinggi off-by-4 → isi halaman terpotong `… N more` & `PgDn` melompat**
   - **Bukti**: [output-window.ts#L157](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L157) memakai `windowMaxHeight(rows)` (`rows` penuh), padahal [window.ts#L30-L35](file:///d:/Github/minicode/src/ui/screens/window.ts#L30-L35) menetapkan anggaran isi = `windowMaxHeight(rows) - 4`. Akibatnya pada output > `rows - 4`, 4–5 baris bawah tiap halaman terpotong.
   - **Catatan Test Lock**: [test/audit-fix-window-uniform-output.test.ts#L82](file:///d:/Github/minicode/test/audit-fix-window-uniform-output.test.ts#L82) mengunci `out.maxHeight === windowMaxHeight(rows) + 4`. Jadi perbaikannya perlu menyelaraskan `outputWindowSpec` + baris test v0.33 itu sekaligus (aman dan jelas alasan bugnya).
2. **`/context` & `renderTable`: tabel mengabaikan lebar popup**
   - **Bukti**: [cli/context-command-run.ts#L73](file:///d:/Github/minicode/cli/context-command-run.ts#L73) memakai `outputWindowWidth` legacy (`96`) dan [table.ts#L33](file:///d:/Github/minicode/src/ui/render/table.ts#L33) selalu memakai `getTerminalWidth()`, membuat border grid `│` terpecah saat di-wrap di `output-window` (`84` kol).
   - **Evaluasi**: Tambah opsi `width` di `renderTable()` + gunakan `windowWidth(cols) - 4` di `/context`. Nol bentrok kontrak; `test/output-window.test.ts#L110` tetap aman karena hanya menguji ekspor `outputWindowWidth`.
3. **`form.ts`: kursor berkedip di luar garis kanan `│` pada `select`/`confirm` & error terpotong saat scroll**
   - **Bukti**: [form.ts#L260,L273,L329-L334](file:///d:/Github/minicode/src/ui/screens/form.ts#L260) tetap memanggil `moveCursor` (bukan `setCursorVisible(false)`) saat `activeCol === -1`. Selain itu `focusRow = activeRow` ([L305](file:///d:/Github/minicode/src/ui/screens/form.ts#L305)) dapat mendorong `st.error` merah tepat di bawah field aktif keluar layar pada `rows = 10..14`.
   - **Evaluasi**: Perbaikan kecil & bersih, nol regresi test.
4. **`/update` gagal pasca-`install` kehilangan backdrop scrim & `onResize` lupa label**
   - **Bukti**: [cli/tui.ts#L870-L896,L2070](file:///d:/Github/minicode/cli/tui.ts#L870-L896) dan [app.ts#L1734-L1736,L1805-L1820](file:///d:/Github/minicode/src/ui/tui/app.ts#L1734-L1736). Saat `reacquireTerminal()` berjalan selagi `suspended > 0`, `App` melukis frame normal terang, lalu `showCommandOutput` gagal memicu `paintDimmed()` karena `suspended++ > 0`.
   - **Evaluasi**: Perbaikan lifecycle murni, risiko nol.
5. **Peringatan idle 80 dtk (`idleWarning`) terpotong habis di 80–120 kolom**
   - **Bukti**: [window.ts#L48](file:///d:/Github/minicode/src/ui/screens/window.ts#L48) meletakkan `extraHints` (`form.idleWarning` = 61–70 char) sesudah `nav` (31–32 char), menghasilkan 94–104 kol > `innerW` (`72`–`84` kol) → dipotong `cut(footer)` ([dialog.ts#L165](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L165)).
   - **Evaluasi**: Bila `idleWarned === true`, jadikan `idleWarning` prioritas/menggantikan footer (pola yang sudah terbukti di `approval/prompt.ts#L470,L566`) agar pengguna benar-benar sempat melihat sebelum popup menutup di detik ke-90.
6. **`/model` & `/provider`: ` (active)` & `[effort]` terpotong di `cols = 20..28`**
   - **Bukti**: lantai `Math.max(8, ...)` di [model-manager.ts#L137](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L137) & [provider-manager.ts#L136](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L136). Letakkan `[effort]` bersama `(active)` sebagai suffix yang diproteksi dan pakai batas minimal adaptif `w`.
7. **Wheel pada `@mention` bocor menggulir chat + pemotongan dropdown tanpa `…`**
   - **Bukti**: [app.ts#L1097-L1106](file:///d:/Github/minicode/src/ui/tui/app.ts#L1097-L1106) hanya mengecek `line.startsWith("/")` alih-alih `this.activeSuggestions().items.length > 0`; [app.ts#L2780](file:///d:/Github/minicode/src/ui/tui/app.ts#L2780) memotong via `chunkByWidth(l, w)[0]` tanpa `glyphs.ellipsis`.
8. **`approval/prompt.ts`: opsi `Always`/`Deny` tertutup di `rows = 10..14` + `dlg.more` salah hitung saat scroll**
   - **Bukti**: [prompt.ts#L410-L418,L472](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L410-L418) selalu mematok 5 baris preview meski terminal pendek (`10–14` baris); [dialog.ts#L150-L160](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L150-L160) menampilkan `… N more` di bawah baris terakhir walau `bodyStart > 0` dan `bodyStart + shown === spec.body.length`.
   - **Catatan Test Lock**: [test/dialog.test.ts#L62](file:///d:/Github/minicode/test/dialog.test.ts#L62) memeriksa angka sisa terpotong saat `bodyStart === 0` — tetap terpenuhi jika rumus memisahkan `above`/`below` atau mengurangi `bodyStart` dari hitungan bawah.
9. **Bracketed paste (`?2004h/l`) di modal non-form & `screen.cols/rows` konsisten**
   - **Evaluasi**: Tambah `setBracketedPaste` ke `picker`/`model-manager`/`provider-manager`/`prompt` saat raw-mode dan samakan pembacaan dimensi memakai `screen.cols/rows`.

---

### Kelas II — Di-Lock Kontrak / Docs / Test (Jangan Diubah Diam-Diam Tanpa Persetujuan Pemilik)

1. **`MINICODE_SCRIM=none` → `"faint"`** ([theme.ts#L86](file:///d:/Github/minicode/src/ui/render/theme.ts#L86)):
   - **Evaluasi**: Terdokumentasi eksplisit di [docs/environment.md#L122](file:///d:/Github/minicode/docs/environment.md#L122) (*"`none` → paksa scrim backdrop jadi `faint` saja"*). Tidak boleh dibalik menjadi `"none"` secara diam-diam tanpa melanggar perilaku terdokumentasi; jika ingin opsi matikan total, tambahkan nilai terpisah atau biarkan apa adanya (`NO_COLOR=1`/`MINICODE_COLOR=0` sudah memberi `"none"`).
2. **Popup lebar `windowWidth` (`56..88`) vs chat kolom tengah (`cols ≥ 120`)**:
   - **Evaluasi**: Kontrak v0.43 ([TERMINAL_CONTRACT.md#L72-L73](file:///d:/Github/minicode/docs/TERMINAL_CONTRACT.md#L72-L73)) dan test v0.33 ([audit-fix-window-uniform*.test.ts](file:///d:/Github/minicode/test/audit-fix-window-uniform.test.ts)) sengaja memisahkan lebar popup fullscreen (`max 88`) dari lebar kolom chat (`floor(cols/2)`) agar dialog & tabel tidak terlalu sempit. **Kesimpulannya**: pertahankan `windowWidth` untuk semua popup, tetapi migrasi kotak progres `/provider sync` & `/update` dari `popupBoxWidth` ke `windowWidth`!
3. **Kontrak `windowFooter` (`↑↓ move  Enter select  Esc cancel`) pada `form`, `output-window`, & `wizard`**:
   - **Evaluasi**: Hint ganda/bohong yang ditemukan Audit #2 & #3 ternyata merupakan **konsekuensi langsung** dari test v0.33 ([audit-fix-window-uniform.test.ts#L125-L129](file:///d:/Github/minicode/test/audit-fix-window-uniform.test.ts#L125-L129) & [audit-fix-window-uniform-output.test.ts#L48-L55](file:///d:/Github/minicode/test/audit-fix-window-uniform-output.test.ts#L48-L55)) yang menuntut `windowFooter` selalu memuat `hint.move` dan `hint.select` kecuali key-nya ditimpa persis sama string-nya!
   - **Rekomendasi**: Minta izin pemilik untuk membuat `windowFooter` sadar peran (`nav` standar hanya untuk `list`, `Tab/↑↓ + Enter save + Esc cancel` untuk `form`, `scroll + c + Esc close` untuk `output-window`, kosong/`Esc cancel`/`Retry` untuk progres/error `wizard`) + memperbarui 2 berkas test v0.33 tersebut.
4. **Hardcode `"katalog"` & `"default aman"` di `originLabel`** ([cli/context-command.ts#L44,L48](file:///d:/Github/minicode/cli/context-command.ts#L44)):
   - **Evaluasi**: Dikunci eksplisit oleh [test/context-command.test.ts#L158-L159](file:///d:/Github/minicode/test/context-command.test.ts#L158-L159) dan ditulis di [docs/config.md#L47-L48](file:///d:/Github/minicode/docs/config.md#L47-L48) + [docs-en/config.md#L47-L48](file:///d:/Github/minicode/docs-en/config.md#L47-L48). Layak dipindahkan ke `t()` bersama sinkronisasi kebijakan `tSystem()` vs `t()` (`/update` loading, `"Copied"` di `output-window`) bila pemilik setuju memperbarui kontrak i18n-nya.

---

### Kelas III — Perlu Keputusan UI Pemilik (Dampak Visual Luas — Sesuai `AGENTS.md`)

1. **Pita kosong memotong latar scrim `bg` di samping kiri/kanan kotak popup** ([screen.ts#L319-L330](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L319-L330) + [dialog.ts#L172-L175](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L172-L175)):
   - Memperbaikinya membutuhkan komposisi segmen `backdropRows` di kiri dan kanan kotak pada tiap baris modal di `paintRegion()`. Dampaknya visual akan jauh lebih rapi (popup benar-benar melayang di atas chat redup tanpa pita hitam), tetapi memodifikasi inti renderer `screen.ts` & sel SGR.
2. **Penyelarasan tema & kosmetik lintas popup**:
   - Menyeragamkan `MINICODE_BOX` across popup + composer + `table-grid.ts`, `glyphs.ellipsis` di `dialogBox`, tinggi list seragam (`12` baris di picker/manager), `idleWarning` 80s di `/model` + `/provider` + `wizard`, tampilkan `baseUrl` redup di `/provider`, `category: "session"` + tata letak `/sessions`, placeholder/highlight/status filter kosong di `/model`, alignment `/help` & `/status`, scrollable error modal `wizard`, serta separator/prefix dropdown `/` & `@`.
3. **`ask_user` (`options[]`) interaktif dengan panah**: mengubah UX `promptAskText` sehingga opsi bisa dipilih via `↑↓` atau ketik bebas. Perlu cek `test/approval-tui.test.ts#L80-L85` agar ketik teks langsung + enter tetap jalan.

---

### Kelas IV — Sebaiknya Tidak Diubah (Over-engineering / Merusak Alur Eksisting)

1. **Jangan samakan lebar popup ke lebar chat 54 kol di `cols >= 120`**: merusak keterbacaan tabel & path panjang.
2. **Jangan ubah mekanisme `Esc` 2-tahap di `form` pada text/secret**: sengaja melindungi editan URL/key dan dikunci `test/form.test.ts`.
3. **Jangan tambahkan klik-mouse per-baris ke semua 5 modal Layer 2 sekaligus tanpa kebutuhan nyata**: menambah kode hit-test di setiap modal dan memperbesar permukaan regresi event mouse.
4. **Jangan ubah makna `MINICODE_SCRIM=none` (`"faint"`)**: sudah jadi kontrak terdokumentasi.

---

## 3. Urutan Eksekusi Terbaik (Rekomendasi Ringkas)

Jika disetujui pemilik:
- **Tahap 1 (Bug Murni & Keamanan Tampilan — cepat & pasti aman)**:
  Perbaiki `output-window` `bodyBudget()` (`rows - 4`) + `/context` `renderTable` width + `form` hidden cursor & error focus + `/update` reacquire scrim + `model/provider-manager` proteksi suffix `active`/`effort` + `idleWarning` tampil di depan footer + wheel `@mention` + bracketed paste modal + `dlg.more` saat `bodyStart > 0` + modal `popupBoxWidth` ke `windowWidth`.
- **Tahap 2 (Keputusan Konsistensi UX & Kontrak — setelah izin pemilik)**:
  1. Rapikan `windowFooter` per peran jendela (`list`/`form`/`viewer`/`progress`) agar nol hint ganda/palsu.
  2. Komposisi backdrop kiri/kanan kotak di `screen.ts` agar pita hitam hilang saat scrim aktif.
  3. Penyeragaman UX list (`/provider` + `baseUrl`, `/model` tinggi 12 + status filter + highlight + 80s warn, `/sessions` + `sessionIcon`), penyatuan `MINICODE_BOX` + `glyphs.ellipsis`, dan kebijakan bahasa `t()` vs `tSystem()` (termasuk `/context`, `/update`, `/help`, `/status`).
