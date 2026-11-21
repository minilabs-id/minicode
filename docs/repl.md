# TUI — Slash & Keyboard (satu tampilan fullscreen)

Ketik `/` di prompt → dropdown polos (tanpa bingkai; `max 8` baris, daftar panjang dipotong tanpa baris `… N more` — baris itu hanya ada di `askLine`/dialog linear). `↑`/`↓`
navigasi, `Enter` lengkapi + submit, `Esc` tutup. Semua permukaan interaktif
hidup di dalam TUI fullscreen; terminal tanpa ANSI/alt-screen = pesan satu
baris + keluar (interaktif butuh TTY ≥10 baris).

Bahasa UI: `/lang` (sesi, tersimpan state.json) > `MINICODE_LANG` > state.json `lang` >
locale OS > en. `/lang` tanpa argumen = tampilkan aktif. Semua string lewat kamus i18n
(`src/ui/i18n/`); literal Indonesia hardcode di luar kamus dilarang test.

## Slash commands

| Command | Fungsi |
|---|---|
| `/help` | Daftar perintah ringkas, terkelompok per kategori (Session/Model/Mode/View/Task) |
| `/help full` | Daftar lengkap terkelompok dengan deskripsi (alias `/help all`); `/help` kosong dari non-TTY juga menampilkan ini |
| `/help keys` | Pintasan papan tombol lengkap (alias `/help tombol`) |
| `/provider [sync]` | Kelola provider: popup — picker preset + form (URL/key/scope/timpa), hapus (`d`, menyebut jumlah model yang ikut hilang), ubah (`e`). `sync` = segarkan daftar model semua provider (hanya bilang restart bila benar ada model baru) |
| `/model [cari]` | Popup semua `provider::model` (argumen = filter awal; di dalam ketik langsung cari live, Ctrl+U clear, Esc keluar filter). Del = hapus (konfirmasi). Enter = pilih + atur thinking effort (`default/low/medium/high`, tersimpan di provider, berlaku sesi berikutnya; Esc = batal total). Effort non-default tampil badge `[low|medium|high]` |
| `/context [nilai]` | Tabel jendela konteks efektif tiap model + asal angkanya (`manual`/`endpoint`/`katalog`/`models.dev`/`flag`/`default aman`). Dengan argumen: setel untuk model aktif (`128k`, `1m`, `1024x1024`, `auto`) — langsung berlaku turn berikutnya. Detail di [Konfigurasi](config.md) |
| `/undo [n\|list]` | Undo percakapan **dan** berkas sampai sebelum turn `n` (tanpa argumen: picker terbaru-dulu; `last`: turn terakhir). `Esc Esc` saat composer kosong membuka picker. Sesi lama tetap utuh; prompt target dibuka sebagai draft di sesi cabang. `list` menampilkan nomor turn. Di DISCUSS, undo yang menyentuh berkas ditolak; undo percakapan-saja tetap boleh |
| `/redo` | Kembali ke sesi asal setelah `/undo` dan pulihkan workspace ke keadaan sebelum undo; ditolak bila sudah ada turn baru di cabang |
| `/sessions [id\|history\|branches]` | Tanpa argumen = popup picker resume; `<id>` = langsung resume; `history` = 20 riwayat prompt; `branches` = daftar cabang undo |
| `/status` | Runtime + pemakaian & biaya **kumulatif sesi** |
| `/mode [discuss\|build\|auto\|ask]` | Tanpa argumen = popup dua sumbu: WorkMode (`discuss`/`build`) + PermissionMode (`auto`/`ask`). WorkMode membatasi cara agent bekerja: `DISCUSS` investigasi/perencanaan read-only (+ artefak rencana), `BUILD` tidak menambah ceiling (identitas internal `EXECUTE`). Nilai invalid ditolak dan mode aktif tidak berubah. Tab/Shift+Tab tetap pintasan cepat. |
| `/lang [en|id]` | Bahasa UI; tanpa argumen = tampilkan aktif |
| `/init` | Buat `AGENTS.md` proyek ini |
| `/copy [n]` | Salin `n` turn terakhir (default `1`, maksimal `10`) via OSC 52 |
| `/clear` | Kosongkan transkrip (viewport kembali kosong) |
| `/view [action]` | Tanpa argumen = popup aksi tampilan. `compact` = putar output tool ringkas/penuh; `thinking` = tampil/sembunyikan reasoning; `expand` dihapus — riwayat lengkap di sidebar (gulir mouse / Alt+PgUp); `minimize` = lipat tool+jawaban; `fold` = panel aktivitas |
| `/exit` | Keluar (satu-satunya jalan keluar; `/quit` alias). Setelah keluar, tercetak kop ringkasan sesi: wordmark `minicode` + Session/Model/Usage (token, biaya, durasi) |
| `/scheduler [status\|run\|stop]` | Kendali Scheduler produksi. **Nonaktif secara bawaan** di setiap sesi (perlu flag `--enable-scheduler`); tanpa flag, perintahnya menjawab "not enabled". Tetap tampil di `/help` supaya operator yang mengaktifkan flag bisa menemukannya. |

Alias (jalan, tidak diiklankan di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/quit`. Nama lama `/sync`, `/work-mode`, `/history`, `/compact`, `/thinking`, `/expand`, `/minimize`, dan `/fold` sudah pensiun (tidak ada alias) — `/help` dan pesan did-you-mean menuntun ke penggantinya.

Perintah tersembunyi (sengaja tak tampil di `/help`/dropdown, per-sesi): `/unrestric` — jembatan jail luar workspace + bash-guard + allowlist dibuka, kredensial git sempit diteruskan, tetapi file sensitif/state minicode tetap ditolak; gerbang = kepercayaan operator (toggle; footer menampilkan `○` merah). Detail di [Keamanan](security.md).

Did-you-mean: typo `/sessoons` → `Did you mean /sessions?` (jarak ≤ 2).

## Keyboard

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt (di picker/form: pilih/simpan; kosong = batal di picker) |
| `tab` | Toggle WorkMode (`DISCUSS` ↔ `BUILD`) |
| `shift+tab` | Toggle PermissionMode (`AUTO` ↔ `ASK`) |
| `↑` / `↓` | Riwayat prompt, atau navigasi item di picker/manager/form |
| `pgup` / `pgdn` | Gulir transkrip satu halaman; dengan `shift`: setengah halaman (di picker/manager: gulir daftar) |
| `mouse drag` | Select teks transkrip; `Ctrl+C` menyalin selection app-level |
| `mouse wheel` | Gulir transkrip; klik prompt memindahkan kursor |
| `home` / `end` | Awal/akhir baris; saat baris kosong tanpa dropdown: lompat ke atas transkrip / kembali ke ekor (di picker/manager: lompat atas/bawah daftar) |
| `←` / `→` | Geser kursor (di form select/confirm: ganti opsi/nilai) |
| `ctrl+a` / `ctrl+e` | Awal / akhir baris |
| `delete` / `backspace` | Hapus karakter (di filter: pangkas query; di /model browse: Del = hapus model dengan konfirmasi) |
| `ctrl+r` | Cari riwayat prompt (prefix) |
| `ctrl+j` | Baris baru (multiline; Enter tetap submit) |
| `ctrl+w` | Hapus satu kata sebelum kursor |
| `ctrl+u` | Kosongkan baris (di filter: kosongkan query) |
| `ctrl+o` | Putar tool call compact/expanded (juga `/view compact`) |
| `ctrl+t` | Toggle tampilan thinking expanded/minimized (juga `/view thinking`) |
| `esc` | Tutup dropdown/picker; dua-tahap di form (tekan-1 bersihkan field, tekan-2 batal); busy = batalkan turn; idle + composer kosong: dua Esc dalam 500 ms membuka picker `/undo` |
| `ctrl+c` | Salin selection (TUI); tanpa selection = no-op. Abort turn pakai `Esc` (`Esc` dua kali dalam 1,5 dtk, atau `Ctrl+D` baris-kosong, saat abort macet) |
| `ctrl+d` | Keluar saat baris kosong; saat busy baris-kosong = abort turn lalu keluar |
| `enter` saat turn berjalan | **Selipkan sebagai informasi tambahan (steer)**: baris masuk ke konteks turn AKTIF pada batas step berikutnya — sebelum request model selanjutnya — jadi model membacanya di turn yang sama tanpa pekerjaan yang sedang berjalan dibatalkan (transkrip menandai `diselipkan ke turn yang berjalan`). Bila turn ternyata sudah selesai lebih dulu, baris jatuh ke antrean turn berikutnya (`diantrikan #n`) supaya tidak hilang. Baris `/perintah` ditolak dengan alasan karena perintah UI butuh idle. `Esc` membatalkan turn sekaligus membuang antrean fallback (dengan pemberitahuan) |

Saat turn berjalan composer tetap hidup: draft yang sedang diketik tampil di slot
composer (menggantikan baris status aktivitas selama draft tidak kosong), jadi
koreksi/informasi tambahan bisa disiapkan tanpa menghentikan turn. `Tab`,
`Shift+Tab`, `Ctrl+O`, `Ctrl+T`, dan `Ctrl+R` tetap ditahan sampai turn selesai.

## Aturan konsistensi (kontrak I25)

- `Esc` dua-tahap di SEMUA input teks: isi tidak pernah hilang sekali tekan.
- `backspace`/`delete` selalu edit teks; aksi hapus-data selalu dengan
  konfirmasi (dalam popup) dan tercatat di transkrip.
- Navigasi daftar = `↑↓` + `pgup/pgdn` + `home/end` di semua popup ber-daftar.
- Setiap permukaan menampilkan hint footer sesuai tombol yang benar-benar
  berlaku di sana.
