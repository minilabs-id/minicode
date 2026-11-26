# Audit Konsistensi Jendela Popup yang Disesuaikan (Adaptasi & Kustomisasi)

Tanggal: 2026-11-26
Checkout referensi: `cf181ac` (+ penghapusan daftar provider terdaftar)
Laporan pendamping: [2026-11-26-audit-jendela-popup.md](file:///d:/Github/minicode/.audit/2026-11-26-audit-jendela-popup.md)

Audit ini membedah konsistensi pada **dua sumbu penyesuaian**:
1. **Adaptasi lingkungan & preferensi** (dimensi terminal `cols×rows`, `MINICODE_BOX`, `MINICODE_ASCII`, `MINICODE_COLOR`/`NO_COLOR`, `MINICODE_SCRIM`, bahasa `/lang` vs OS `tSystem`).
2. **Penyesuaian per pemanggil** (`windowSpec` vs `dialogBox` mentah vs `outputWindowSpec` vs `wizardWindowSpec` vs `footerHints` vs modal `promptAsk`/`ask_user` vs overlay `/` & `@`).

---

## Matriks Ringkas Drift Konsistensi

| Permukaan | Rumus Lebar | Rumus Tinggi Isi | Sumber Dimensi | Gaya Border | Footer Hint | Idle 80s Warn | Bahasa Chrome | Bracketed Paste |
|---|---|---|---|---|---|---|---|---|
| `picker.ts` | `windowWidth` (`56..88`) | `min(rows - chrome, 12)` | Mix (`screen.cols`, `stdout.rows`) | `MINICODE_BOX` | `windowFooter` + `█ edit` | Ya (terpotong) | `t()` (`gate`: `t()`) | Tidak |
| `model-manager.ts` | `windowWidth` (`56..88`) | `min(rows - 5, 8)` | `stdout.columns/rows` vs `screen` | `MINICODE_BOX` | `windowFooter` + `Tab` + `Del` | **Tidak** | `t()` (`gate`: `t()`) | Tidak |
| `provider-manager.ts` | `windowWidth` (`56..88`) | `min(rows - 4, 14)` | `stdout.columns/rows` vs `screen` | `MINICODE_BOX` | `windowFooter` + `a`/`e`/`d` | **Tidak** | `t()` (`gate`: `t()`) | Tidak |
| `form.ts` (`/mode`, add/edit/del) | `windowWidth` (`56..88`) | `rows - 4` (+ `focusRow`) | `screen.cols/rows` | `MINICODE_BOX` | **Ganda** (`move`×2, `Enter`×2) | Ya (terpotong) | `t()` | Ya |
| `output-window.ts` | `windowWidth` (`56..88`) | **Bug: `rows` (off-by-4)** | `stdout.rows/columns` | `MINICODE_BOX` | **Palsu** (`Enter select` padahal close) | Ya (terpotong) | Campur (`t` + `tSystem` notice) | Ya |
| `wizard.ts` (progress/done/err) | `windowWidth` (`56..88`) | `rows - 4` (no scroll) | `screen.cols/rows` | `MINICODE_BOX` | **Pasif ber-hint nav** (`windowFooter`) | **Tidak** | `t()` (`tooSmall`: `tSystem`) | Hanya di `runForm` |
| `/provider sync` & `/update` progress | **`popupBoxWidth` (`40..88`)** | Fixed 1 baris (`3` total) | `stdout.columns/rows` | `MINICODE_BOX` | Tanpa footer | Tidak ada | **Campur `tSystem`/`t`** | Tidak |
| `approval/prompt.ts` (`promptAsk`/`ask_user`) | `windowWidth` (`56..88`) | `rows - 4` (+ `focusRow`) | `stdout.columns/rows` | `MINICODE_BOX` | Timpa `frame.footer` manual | Ya (ganti footer) | Campur (`t` + `tSystem` tooSmall) | Tidak |
| Dropdown `/` & `@` | `contentCols` (centered saat `≥120`) | `min(8, viewH - 2)` | Geometri layout frame | Tanpa border | Tanpa footer/hint | N/A | N/A | Milik `TuiApp` |

---

## 1. Inkonsistensi Adaptasi Ukuran Terminal (`cols` & `rows`)

### 1.1. Kontradiksi geometri di layar besar (`cols ≥ 120 && rows ≥ 20`) vs layar sedang
- Main chat pada `cols = 120` berada di kolom tengah selebar `chatCols = 60` (`contentCols = 54`), dan dropdown `/` & `@` ikut menciut ke `54` kolom ([src/ui/tui/app.ts#L3214-L3227](file:///d:/Github/minicode/src/ui/tui/app.ts#L3214-L3227)), **tetapi** seluruh modal Layer 2 memakai `windowWidth(120) = 88` (`innerW = 84`) — lebih lebar 30 kolom dari kolom chatnya.
- Sebaliknya di `cols = 100`, kolom chat justru lebar penuh (`contentCols = 94`), sedangkan popup disusutkan ke `88` (`innerW = 84`).
- Progres `/provider sync` & `/update` ([cli/tui.ts#L2012,L2056](file:///d:/Github/minicode/cli/tui.ts#L2012)) masih memakai `popupBoxWidth` (`48` kol di `80` kol, `72` kol di `120` kol), sehingga lebar kotak meloncat (+28 / +16 kol) saat beralih ke `output-window`.
- `/context` ([cli/context-command-run.ts#L73](file:///d:/Github/minicode/cli/context-command-run.ts#L73), [src/ui/render/table.ts#L33](file:///d:/Github/minicode/src/ui/render/table.ts#L33)) memakai `outputWindowWidth` legacy (`96`) dan `getTerminalWidth()` mentah sehingga tabel ter-wrap paksa di `output-window`.

### 1.2. Degradasi pada terminal sempit (`cols = 20..56`, batas `canRenderModal`)
- **`idleWarning` pasti terpotong bahkan di 80–120 kolom**: [window.ts#L48](file:///d:/Github/minicode/src/ui/screens/window.ts#L48) meletakkan `extraHints` SESUDAH `nav` (`↑↓ move  Enter select  Esc cancel` = 31–32 kol). Saat `idleWarned = true` (`form.idleWarning` = 61 char EN / 70 char ID di [en.ts#L79](file:///d:/Github/minicode/src/ui/i18n/en.ts#L79) & [id.ts#L82](file:///d:/Github/minicode/src/ui/i18n/id.ts#L82)), total panjang footer menjadi **94–104 kolom** > `innerW = 72` (di 80 kol) dan `84` (di 120 kol). `dialogBox`'s `cut(footer)` ([dialog.ts#L165](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L165)) memotong habis peringatan idle **dan** seluruh tombol penting sesudahnya (`Tab`, `Enter save`, `a add`, `c copy`).
- **Footer `form` standar ikut terpotong di `cols ≤ 58`**: `↑↓ move  Enter select  Esc cancel  Tab move  Enter save` = 53 kolom (EN) / 56 kolom (ID); di `cols = 40..56`, `Tab` dan `Enter save` hilang terpotong `"..."`.
- **Label `(active)` hilang di `/model` & `/provider` (`cols = 20..28`)**: [model-manager.ts#L137](file:///d:/Github/minicode/src/ui/screens/model-manager.ts#L137) & [provider-manager.ts#L136](file:///d:/Github/minicode/src/ui/screens/provider-manager.ts#L136) memaksa lantai `Math.max(8, w - 4 - ...)`, sehingga baris melampaui `w` dan dipotong oleh `dialogBox` tepat pada kata ` (active)`.

### 1.3. Degradasi pada terminal pendek (`rows = 10..15`, batas `canRenderModal`)
- **`form.ts` memotong pesan error validasi ke bawah**: saat field bertumpuk (`stacked`) atau form memiliki beberapa field plus error inline (`st.error` ditaruh SETELAH `activeRow`), `focusRow = activeRow` hanya menjaga baris input terlihat — **pesan error merah tepat di bawah field aktif dapat terselip ke luar `shown` (`… N more`)**.
- **`model-manager` / `provider-manager` memotong notice multi-baris**: ketika `formatError` ter-wrap `> 4` baris pada `rows = 10..12`, `visibleRows()` turun ke `1`, tetapi total body (`filter + 1 item + notice panjang`) tetap melampaui `room`, sehingga baris saran perbaikan (`→ fix`) di dasar notice terpotong menjadi `... N more`.
- **`approval/prompt.ts` pada `rows = 10..14`**: `focusRow` mengunci opsi terpilih paling atas, mendorong `Tool:`/`Risk:` ke atas dan menyembunyikan `Always`/`Deny` ke `... N more`.

---

## 2. Inkonsistensi Adaptasi Gaya Kotak, Warna, & Scrim

### 2.1. `MINICODE_BOX` (`rounded` / `square` / `ascii`) terpecah 3 jalur berbeda
- Popup `dialogBox` ([dialog.ts#L61-L65](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L61-L65)) menghormati `MINICODE_BOX=rounded|square|ascii` + `MINICODE_ASCII=1`.
- Kotak composer ([theme.ts#L610-L622](file:///d:/Github/minicode/src/ui/render/theme.ts#L610-L622)) hanya mengecek `supportsUtf8()`, **mengabaikan `MINICODE_BOX=square`** (saat diset `square`, semua popup siku `┌─┐` tapi composer tetap `╭─╮`).
- Tabel `/context` ([table-grid.ts#L220-L246](file:///d:/Github/minicode/src/ui/render/table-grid.ts#L220-L246)) juga hanya mengecek `supportsUtf8()`, **mengabaikan `MINICODE_BOX=ascii`** (saat diset `MINICODE_BOX=ascii`, bingkai popup `+-+` tetapi grid tabel di dalamnya tetap `┌─┐`).
- `dialogBox` memotong teks dengan `"..."` (3 titik hardcode di [dialog.ts#L133](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L133)) alih-alih `glyphs.ellipsis` (`…` 1 kolom di UTF-8, `...` di ASCII).

### 2.2. Warna bingkai & bug `MINICODE_SCRIM=none` + pita hitam samping popup
- **`MINICODE_SCRIM=none` bohong** ([theme.ts#L86](file:///d:/Github/minicode/src/ui/render/theme.ts#L86)): `if (process.env.MINICODE_SCRIM === "none") return "faint"` — alih-alih mematikan scrim (`"none"`), justru menyalakan redup `faint`.
- **Pita kosong memotong scrim latar di kiri/kanan kotak popup** ([dialog.ts#L172-L175](file:///d:/Github/minicode/src/ui/screens/dialog.ts#L172-L175) + [screen.ts#L319-L330](file:///d:/Github/minicode/src/ui/runtime/screen.ts#L319-L330)): saat `scrimMode() === "bg"` (`2;48;5;236m`), `paintRegion` menghapus penuh satu baris layar (`\x1b[2K`) lalu menulis `" ".repeat(left) + box`. Akibatnya kolom kiri & kanan di luar kotak popup pada baris yang sama tidak mewarisi warna scrim `48;5;236` dan teks transkrip redup di samping modal hilang menjadi pita hitam polos.
- **Backdrop resize beku**: memperbesar/memperkecil terminal saat popup terbuka membuat `frozen` backdrop tetap di lebar lama ([app.ts#L1867-L1885](file:///d:/Github/minicode/src/ui/tui/app.ts#L1867-L1885)), sedangkan kotak modal berpindah ke tengah lebar baru.
- **Kontras bingkai popup vs composer**: bingkai composer diredam halus lewat `paintComposerBorder` (`#36383E`/`236`/`90`), sedangkan semua popup memakai warna teks default terang tanpa pewarnaan border.

---

## 3. Inkonsistensi Adaptasi Bahasa (`/lang en|id` vs `tSystem`)

- **Hardcode Bahasa Indonesia di `/context`**: [cli/context-command.ts#L44,L48](file:///d:/Github/minicode/cli/context-command.ts#L44) mengembalikan `"katalog"` dan `"default aman"` literal tanpa `t(...)` — sehingga saat `/lang en`, tabel `/context` menampilkan header Inggris (`Model | Window | Origin`) berisi nilai Bahasa Indonesia (`katalog`, `default aman`).
- **Judul & notice mencampur `t()` vs `tSystem()` pada jendela yang sama**:
  - Loading box `/update` ([cli/tui.ts#L2059](file:///d:/Github/minicode/cli/tui.ts#L2059)) memakai `tSystem("out.titleUpdate")`, hasil akhirnya ([L2080](file:///d:/Github/minicode/cli/tui.ts#L2080)) memakai `t("out.titleUpdate")`.
  - Notice clipboard di `output-window` ([output-window.ts#L195,L269-L272](file:///d:/Github/minicode/src/ui/screens/output-window.ts#L195)) memakai `tSystem("msg.copied")` di dalam jendela yang semua tombol/judulnya memakai `t()`.
  - Penolakan `tooSmall` memakai `t("gate.tui*")` pada picker/manager, tetapi `tSystem("msg.tooSmall")` pada `wizard`, `approval`, dan `TuiApp`.
- **Ketidaksejajaran terjemahan pada `/status`**: `"  WorkMode: "` vs `"  Permission: "` (EN) dan `"  Tool:     "` vs `"  Mode izin: "` (ID) memiliki spasi manual tidak rata.
- **Label key di UTF-8 vs ASCII pada `picker`**: `{ key: glyphs.caret, label: t("hint.edit") }` berubah menjadi `█ edit` (UTF-8) atau `# edit` (ASCII, menyesatkan seolah tombol `#`).

---

## 4. Inkonsistensi Penyesuaian per Pemanggil (Customization Drift)

1. **Tiga pola override footer yang saling bertentangan**:
   - `windowFooter` selalu memasang `↑↓ move  Enter select  Esc cancel`.
   - `form.ts` dan `output-window.ts` menempelkan `extraHints` sehingga menimbulkan hint ganda/salah (`Enter select` + `Enter save`, `Enter select` + `Esc close`, `↑↓ move` pada kotak pasif `wizard`).
   - `approval/prompt.ts` ([L324](file:///d:/Github/minicode/src/ui/approval/prompt.ts#L324)) membajak `frame.footer = spec.footer` secara manual setelah `windowSpec`.
   - `paintSyncProgress` & `paintUpdateProgress` memanggil `dialogBox` langsung tanpa `windowSpec` sama sekali.
2. **Lima gaya sumber ukuran & batas tinggi berbeda**: `model-manager` (`max 8`), `picker` (`max 12`), `provider-manager` (`max 14`), `output-window` (`rows` bug off-by-4), `form`/`wizard`/`approval` (`rows - 4`); sekaligus pencampuran `screen.cols/rows` vs `process.stdout.columns/rows`.
3. **Empat gaya navigasi/keluar yang tak seragam**:
   - `Esc` bersihkan filter (`picker`, `model-manager`) vs reset field diam-diam (`form` tanpa notice) vs langsung tutup (`provider-manager`, `output-window`).
   - `Ctrl+C`/`Ctrl+D` langsung tutup (`picker`, `provider-manager`, `output-window`, `form` bila bersih) vs hanya reset filter (`model-manager`) / no-op `Esc`/`Ctrl+C` (`TuiApp.tooSmall`).
   - `Enter` di hasil kosong = batal & tutup (`picker`) vs diam no-op (`model-manager`, `provider-manager`).
   - `ask_user` dengan `options[]` tetap ketik angka statis (`1..n`) alih-alih navigasi panah seperti `promptAsk` & `picker`.
4. **Kesenjangan fitur antar layar sejenis (`picker` vs `/model` vs `/provider` vs dropdown)**:
   - Highlight kecocokan hanya ada di `picker`, absen di `/model` (dan di `picker` sendiri rusak bila teks terpotong di ekor atau huruf Unicode berubah panjang saat `toLowerCase()`).
   - `category: "session"` hanya didefinisikan di `picker.ts`, tidak pernah dipakai di `/sessions`; `/provider` menyembunyikan `baseUrl`; `/model` keadaan `filter === null` vs `filter === ""` (pasca `Ctrl+U`) tampak identik namun berbeda perilaku tombol.
   - Wheel di `picker`/`model`/`provider`/`output`/`approval`, tetapi diabaikan di `form`/`wizard` dan **bocor ke transkrip saat dropdown `@mention` terbuka** ([app.ts#L1102](file:///d:/Github/minicode/src/ui/tui/app.ts#L1102)).
   - Bracketed paste hanya dipasang di `form` dan `output-window`, absen di `picker`, `model-manager`, `provider-manager`, dan `approval`.
