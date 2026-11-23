# TUI — Slash & Keyboard (satu tampilan fullscreen)

Ketik `/` di prompt → dropdown polos (tanpa bingkai; `max 8` baris, daftar panjang dipotong tanpa baris `… N more` — baris itu hanya ada di `askLine`/dialog linear). `↑`/`↓`
navigasi, `Enter` lengkapi + submit, `Esc` tutup. Sejak v0.36 dropdown
digambar **overlay di dalam frame `paint()` yang sama** (satu `stdout.write`,
I1) dan **tidak mengurangi `viewH`** — ia menimpa baris transkrip bawah, bukan
menggeser transkrip, serta TIDAK memakai `paintRegion()` terpisah (menghindari
dua write & flicker saat steer). Klik mouse di area dropdown memetakan ke item
menu, bukan seleksi transkrip. Semua permukaan interaktif hidup di dalam TUI
fullscreen; terminal tanpa ANSI/alt-screen = pesan satu baris + keluar
(interaktif butuh TTY ≥10 baris).

Bahasa UI: `/lang` (sesi, tersimpan state.json) > `MINICODE_LANG` > state.json `lang` >
locale OS > en. `/lang` tanpa argumen = tampilkan aktif. Semua string lewat kamus i18n
(`src/ui/i18n/`); literal Indonesia hardcode di luar kamus dilarang test.
**Pengecualian v0.35:** label aktivitas tool `› …` memakai **locale OS** (`Intl`,
id/en), bukan `/lang` — lihat bagian di bawah. Narasi/jawaban model tetap memakai
bahasa user (`/lang`).

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
| `/copy [n]` | Salin `n` turn terakhir (default `1`, maksimal `10`) via OSC 52 — yang tersalin adalah **yang benar-benar dirender** di transkrip: narasi asisten + rekap/laporan, bukan output tool mentah; gema prompt, baris ledger, diagnostic, dan error tak ikut |
| `/clear` | Kosongkan transkrip (viewport kembali kosong) |
| `/view [thinking]` | Hanya menerima `thinking`: tanpa argumen = picker satu aksi (`thinking`), `thinking` = tampil/sembunyikan baris `+ thinking` di chat. Aksi lama `compact`/`minimize`/`fold`/`expand` DITOLAK — reasoning penuh tetap di jurnal, bukan panel samping |
| `/exit` | Keluar (satu-satunya jalan keluar; `/quit` alias). Setelah keluar, blok penutup ke scrollback: wordmark `minicode` + Session/Model/Mode + Usage (token in/out, biaya, durasi) + rincian tool per kategori + jumlah agent. Matikan dengan `MINICODE_SESSION_SUMMARY=0` |
| `/scheduler [status\|run\|stop]` | Kendali Scheduler produksi. **Nonaktif secara bawaan** di setiap sesi (perlu flag `--enable-scheduler`); tanpa flag, perintahnya menjawab "not enabled". Tetap tampil di `/help` supaya operator yang mengaktifkan flag bisa menemukannya. |
| `/update` (v0.41) | Perbarui MiniCode ke **versi eksak terverifikasi**. **Hanya TUI interaktif**: handoff aman — alt-screen dilepas → install → spawn restart dengan `MINICODE_AUTO_UPDATE_DONE=1` → exit; bila sudah latest/opt-out/gagal, terminal di-reacquire dan hasil ditampilkan. Non-TTY/one-shot/`exec`/pipe/ACP menjawab "not available" (fail-closed, tak pernah spawn npm dari pipe/CI). Instruksi manual: lihat [instalasi manual](getting-started.md). |

Alias (jalan, tidak diiklankan di `/help`): `/models` → `/model`, `/providers` → `/provider`, `/usage` & `/cost` → `/status`, `/resume [id]` → `/sessions [id]`, `/quit`. Nama lama `/sync`, `/work-mode`, `/history`, `/compact`, `/thinking`, `/expand`, `/minimize`, dan `/fold` sudah pensiun (tidak ada alias) — `/help` dan pesan did-you-mean menuntun ke penggantinya.

Perintah tersembunyi (sengaja tak tampil di `/help`/dropdown, per-sesi): `/unrestric` — jembatan jail luar workspace + bash-guard + allowlist dibuka, kredensial git sempit diteruskan, tetapi file sensitif (`.env`/`auth.json`/kredensial daemon) dan `.minicode/hooks/**` tetap ditolak — state `.minicode/` sendiri boleh ditulis sejak 2026-11-23; gerbang = kepercayaan operator (toggle; footer menampilkan `○` merah). Detail di [Keamanan](security.md).

Did-you-mean: typo `/sessoons` → `Did you mean /sessions?` (jarak ≤ 2).

## Keyboard

| Tombol | Fungsi |
|---|---|
| `enter` | Kirim prompt (di picker/form: pilih/simpan; kosong = batal di picker) |
| `tab` | Toggle WorkMode (`DISCUSS` ↔ `BUILD`) |
| `shift+tab` | Toggle PermissionMode (`AUTO` ↔ `ASK`) |
| `↑` / `↓` | Riwayat prompt, atau navigasi item di picker/manager/form. Di draft panjang/multi-baris: pindah antar-baris visual memakai `composerWidth()` (jendela geser, benar di terminal ≥120 kolom) lalu ke histori di baris pertama/terakhir |
| `pgup` / `pgdn` | Gulir transkrip satu halaman; dengan `shift`: setengah halaman (di picker/manager: gulir daftar) |
| `mouse drag` | Select teks transkrip; `Ctrl+C` menyalin selection app-level |
| `mouse wheel` | Gulir chat (klik/press di area padding diabaikan, drag di-clamp); klik prompt memindahkan kursor. Saat dropdown `/` terbuka, klik/wheel di area dropdown memilih item menu, bukan menggulir transkrip |
| `home` / `end` | Awal/akhir baris; saat baris kosong tanpa dropdown: bawa chat ke tepi atas/bawah (di picker/manager: lompat atas/bawah daftar) |
| `←` / `→` | Geser kursor (di form select/confirm: ganti opsi/nilai) |
| `ctrl+a` / `ctrl+e` | Awal / akhir baris. **Sejak v0.37:** `ctrl+a` = key `selectAll` — bila composer kosong & dropdown tertutup memilih **seluruh baris logis transkrip**; bila ada draft atau menu terbuka ia **tetap Home** (kompatibel). `ctrl+e` tetap akhir baris |
| `delete` / `backspace` | Hapus karakter (di filter: pangkas query; di /model browse: Del = hapus model dengan konfirmasi) |
| `ctrl+r` | Cari riwayat prompt (prefix) |
| `ctrl+j` | Baris baru (multiline; Enter tetap submit) |
| `ctrl+w` | Hapus satu kata sebelum kursor |
| `ctrl+u` | Kosongkan baris (di filter: kosongkan query) |
| `ctrl+o` | Tanpa binding sejak v0.34 (modal detail Live dihapus bersama sidebar) |
| `ctrl+t` | Tanpa binding (dulu toggle thinking; kini tidak ada aksi) |
| `esc` | Tutup dropdown/picker; dua-tahap di form (tekan-1 bersihkan field, tekan-2 batal); busy = batalkan turn; idle + composer kosong: dua Esc dalam 500 ms membuka picker `/undo` |
| `ctrl+c` | Salin selection (TUI), **termasuk saat drag masih aktif** — drag di-finalisasi dulu menjadi seleksi (bukan no-op/abort, sejak v0.37); tanpa selection = no-op. Abort turn pakai `Esc` (`Esc` dua kali dalam 1,5 dtk, atau `Ctrl+D` baris-kosong, saat abort macet) |
| `paste` (multi-baris) | Bracketed paste aktif sejak v0.37: `?2004h` saat masuk, `?2004l` saat keluar — TUI, `askLine`/`askSecret`, dan output-window. Sequence ditulis **di luar frame** (I1: satu `write` per frame tetap utuh). CR di dalam paste dibaca sebagai newline draft, **bukan submit** — tidak ada submit bertingkat |
| `ctrl+d` | Keluar saat baris kosong; saat busy baris-kosong = abort turn lalu keluar |
| `/update` (handoff, v0.41) | Handoff terminal untuk auto-update di TUI: alt-screen dilepas → install → restart dengan `MINICODE_AUTO_UPDATE_DONE=1` → exit. Bila latest/opt-out/gagal terminal di-reacquire & hasil ditampilkan. Non-TTY/one-shot/ACP: "not available", tanpa spawn npm. Kegagalan install menyebut langkah & alasan yang diredaksi (ANSI/token/URL kredensial dibuang, ≤300 char), bukan pesan generik |
| `resize` (v0.37) | Menghentikan **auto-scroll**, membatalkan status **drag**, mereset **kolom preferensi kursor**, dan **merebase anchor gulir** walau seleksi aktif — selection tidak melompat ke baris lama. Dropdown `/` ditutup saat transisi busy/abort. Klik pasca-resize memetakan ke geometri **baru**, bukan koordinat lama |
| `enter` saat turn berjalan | **Selipkan sebagai informasi tambahan (steer)**: baris masuk ke konteks turn AKTIF pada batas step berikutnya — sebelum request model selanjutnya — jadi model membacanya di turn yang sama tanpa pekerjaan yang sedang berjalan dibatalkan (transkrip menandai `diselipkan ke turn yang berjalan`). Bila turn ternyata sudah selesai lebih dulu, baris jatuh ke antrean turn berikutnya (`diantrikan #n`) supaya tidak hilang. Baris `/perintah` ditolak dengan alasan karena perintah UI butuh idle. `Esc` membatalkan turn sekaligus membuang antrean fallback (dengan pemberitahuan) |

Saat turn berjalan composer tetap hidup: draft yang sedang diketik tampil di slot
composer (menggantikan baris status aktivitas selama draft tidak kosong), jadi
koreksi/informasi tambahan bisa disiapkan tanpa menghentikan turn. `Tab`,
`Shift+Tab`, dan `Ctrl+R` tetap ditahan sampai turn selesai.

## Kolom chat tengah (v0.34)

Sejak v0.34 tidak ada panel samping. Chat memakai lebar penuh terminal sampai
`cols < 120` atau `rows < 20`. Di atas ambang itu, `chatCols = floor(cols / 2)`
dan sisanya jadi padding kiri/kanan agar chat berada di tengah (mis. 200 kolom →
50 / 100 / 50). Footer dan composer mengikuti kolom ini; popup/modal tetap
ter-centre pada lebar terminal penuh. Seluruh baris masih ditulis dalam satu
frame `paint()` / satu `stdout.write` — tidak ada scrollback tambahan.

Detail per-tool, rekap `✦`, dan finding `[EVALUATE]` tampil di chat; reasoning
penuh tetap di jurnal dan bisa ditampilkan sebagai baris `+ thinking` lewat
`/view thinking`. Notifikasi scheduler/job memakai micro-toast footer.

## Composer & dropdown (v0.36–v0.37)

- **Tinggi composer maksimal 2 baris** (dulu hingga 5; v0.36 tidak dicabut).
  Draft yang lebih panjang memakai **jendela geser** yang mengikuti kursor —
  tidak menambah baris di frame dan **tidak menggeser transkrip**. Satu baris
  kosong pemisah composer–footer tetap ada (I13/I17).
- **Satu geometri prompt (v0.37):** `composerWidth()` dan `chatWidth()`
  berasal dari satu sumber di `src/ui/render/chat-column.ts`. Semua perhitungan
  composer, wrap, kursor `↑`/`↓`, `Home`/`End`, dan klik-untuk-pindah memakai
  `composerWidth()` (I14). Capnya sekarang **progresif**:
  `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` — `100→100`, `200→125`,
  `300→150`, `500→200` (menggantikan cap lama `min(100, chatWidth())`).
- **Prefix adaptif (v0.37):** `minicode › ` bila ruang isi `w−14 ≥ 24` (yaitu
  `w ≥ 38`), sebaliknya `› `; baris lanjutan memakai `· `. Ambang lama "≥60
  kolom" sudah ditimpa.
- **Dropdown `/` = overlay dalam frame yang sama** (I19/I1): tidak mengurangi
  `viewH`, menimpa baris transkrip bawah, tanpa `paintRegion()` terpisah. Klik
  di area dropdown memilih item menu, bukan seleksi transkrip. Sejak v0.37
  dropdown **ditutup saat transisi busy/abort**.
- **Echo prompt (v0.37):** gema prompt user disimpan **satu baris logis** dan
  di-wrap **sekali** oleh proyektor selebar **kolom chat**, bukan lebar terminal
  penuh — menghindari double-wrap akibat padding centre.

Klausa lama tentang composer hingga 5 baris, dropdown yang mengurangi tinggi
transkrip, cap `min(100, chatWidth())`, ambang prefix ≥60 kolom, dan kursor yang
mengikuti `chatWidth()` penuh adalah arsip yang ditimpa v0.36/v0.37 — lihat
aturan presedensi di `TERMINAL_CONTRACT.md`.

## Rekap footer & label aktivitas tool (v0.35)

Rekap tool bukan state live. Ia ditulis sebagai **baris committed statis** yang
jadi footer tiap narasi:

```text
tool → narasi → rekap(tool sebelum narasi)
2 command · 118 read · 1 other
```

Baris rekap menghitung tool yang terjadi **sebelum** narasi itu (sejak v0.41 tanpa
prefix simbol). Rekap **akhir
turn** = kumulatif semua tool selama turn (bukan potongan per segmen).
Klausa lama — rekap dua baris saat live, `flushActivityFold` net-nol,
`liveSummaryRows()` mengikuti ekor, dan jeda antar narasi sebagai baris
melayang — adalah arsip v0.33/v7.x yang sudah ditimpa v0.35.

Label aktivitas `› …` (nama/status tool) memakai **bahasa sistem/OS** lewat
`Intl` (id/en) di semua permukaan — TUI, one-shot/`exec`, dan ACP lewat
`src/ui/assistant/simple.ts`. Narasi/progres/jawaban model TETAP memakai bahasa
user (`/lang`, fallback `MINICODE_LANG`). Jadi mengubah `/lang` tidak mengubah
label `› …`; locale OS yang menang khusus untuk label itu, demi konsistensi
lintas permukaan. Sumber tunggalnya ada di `src/ui/render/tool-label.ts`.

## Baris live tool (v0.43 — amandemen v0.42)

Baris aktivitas tool **live** (root/anak) kembali transien seperti v0.40.0:
muncul saat tool berjalan, ikut tail transkrip, dan hilang setelah tool
selesai — tanpa entri committed baru. Saat baris live muncul, `total` bertambah
dan sticky-tail menggeser jendela, sehingga history boleh naik. Saat baris live
hilang dan `total` menyusut, jendela **tidak bergeser balik**: posisi baris
committed di layar tetap, ruang di bawah boleh kosong.

Mekanismenya adalah **ratchet `scrollBack` per turn** — hanya naik, tidak
turun — di-reset pada `turn:started`, prompt baru, maupun `/clear`. Baris live
bukan overlay, bukan `liveRegion`, dan bukan commit-in-place; I1 (satu
`stdout.write` per frame) tetap utuh, tanpa writer/region baru.

Yang tidak boleh hilang adalah **history chat yang sudah committed** — itu
tetap berlaku sejak v0.42. Butir v0.42 "commit-in-place / never-shrink by id"
**ditimpa hanya pada aspek transiensi baris live**; klausa v0.42 lain (teks
gagal ringkas, rekap tanpa `└`) tetap berlaku. Arsip tidak dihapus maupun
direnomor — lihat entri `## Perubahan v0.43` di `TERMINAL_CONTRACT.md`.

## Aturan konsistensi (kontrak I25)

- `Esc` dua-tahap di SEMUA input teks: isi tidak pernah hilang sekali tekan.
- `backspace`/`delete` selalu edit teks; aksi hapus-data selalu dengan
  konfirmasi (dalam popup) dan tercatat di transkrip.
- Navigasi daftar = `↑↓` + `pgup/pgdn` + `home/end` di semua popup ber-daftar.
- Setiap permukaan menampilkan hint footer sesuai tombol yang benar-benar
  berlaku di sana.
