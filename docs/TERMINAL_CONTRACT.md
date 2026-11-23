# Kontrak Terminal MiniCode (TUI fullscreen — v0.43: baris live tool transien ikut tail, **maksimal 3 baris terakhir** agar narasi committed tetap tampil; ratchet `scrollBack` per turn naik-saja, tidak turun saat live hilang; composer **2 baris TETAP di semua state** — prompt tak bergeser saat submit; v0.42: baris live tool committed monoton + teks gagal ringkas (aspek transiensi ditimpa v0.43); v0.41: auto-update diagnostik + `/update` TUI + handoff terminal aman; v0.37: bracketed paste + select-all + resize stabilizer + echo prompt sekali-wrap + geometri prompt progresif; v0.36: composer ≤2 baris & dropdown overlay; v0.35: rekap committed statis & label aktivitas OS; v0.34: sidebar dihapus, chat kolom tengah)

> **Status & presedensi (dibaca dulu).** `v0.x` = versi produk, `v7.x` = versi
> kontrak terminal — dua namespace, bukan peringkat numerik.
>
> **Aturan presedensi:** entri teratas / tanggal rilis terbaru menang; v0.43
> meng-override klausa v0.42 **hanya pada aspek transiensi baris live tool**
> (baris live kembali transien ikut tail, dibatasi 3 baris terakhir; history chat
> committed tidak berubah; jendela transkrip memakai ratchet `scrollBack`
> naik-saja per turn), sedangkan klausa
> v0.42 lain (teks gagal ringkas, rekap tanpa `└`) tetap
> berlaku; v0.42 sendiri meng-override klausa v0.41/v0.37/v0.36/v0.35/
> v0.34/v0.33 dan v7.x yang bertentangan (v0.41 — I1 handoff terminal di luar
> frame; I14 — `/update`; I27 — output auto-update; I17/I19 & echo prompt dari
> v0.37). Arsip v0.33 dan v7.x tidak dihapus maupun direnomor, tetap
> dipertahankan sebagai sejarah, bukan gambaran tampilan kini — klaim
> v7.22/v7.29/v7.36 yang bertentangan tidak berlaku (warna nyala by default di
> TTY dengan `MINICODE_COLOR=0` untuk monokrom; zero-state KOSONG tanpa logo;
> ringkasan dipotong per segmen narasi sejak v7.37).
>
> **Pointer per versi** (rincian di entri `## Perubahan v…` di bawah):
>
> - **v0.43** — klarifikasi atas v0.42: yang tidak boleh hilang adalah **history
>   chat yang sudah committed**; baris aktivitas tool **live kembali transien**
>   (hilang setelah tool selesai), mengikuti perilaku v0.40.0. Tail live
>   **dibatasi maksimal 3 baris terakhir** supaya narasi committed tetap tampil
>   walau puluhan tool berjalan sekaligus; detail lengkap di jurnal/`--verbose`.
>   Saat baris live muncul, `total` bertambah dan sticky-tail menggeser jendela —
>   history boleh naik, tetapi maksimal 3 baris. Saat baris live hilang dan
>   `total` menyusut, jendela **tidak bergeser balik**: posisi baris committed di
>   layar tetap, ruang di bawah boleh kosong. Mekanismenya = **ratchet
>   `scrollBack` per turn naik-saja** (tidak turun saat live hilang), di-reset
>   pada `turn:started` / prompt baru / `/clear` / navigasi manual / resize —
>   bukan overlay, bukan `liveRegion`, bukan commit-in-place baris live. I1 (satu
>   write/frame) utuh.
>   Butir v0.42 "commit-in-place / never-shrink by id" **ditimpa hanya pada aspek
>   transiensi baris live**; klausa v0.42 lain tetap berlaku. Juga diamandemen
>   redaksi kegagalan tool: 13 pola (4 lama + sub-agent + 8 baru) dengan
>   presedensi sub-agent/guard lebih dulu; detail tetap di jurnal/`--verbose`.
>   Juga diamandemen prefix prompt composer: `minicode ›` / `›` / `·`
>   **tanpa spasi trailing**, caret DECSCUSR menempel di glif — selaras dengan
>   klausa v0.36/v7.30 (kode/test lama masih mengunci spasi trailing).
>   Juga diamandemen tinggi composer: **2 baris TETAP di semua state** (idle,
>   mengetik, busy, setelah submit) — `composerH` tak lagi bergantung `editing`,
>   prompt tidak bergeser saat submit, baris ke-2 kosong bila draft satu baris.
>   Juga diamandemen `/copy`: menyalin **render 1 turn** dari transkrip (narasi
>   assistant + rekap/laporan), bukan buffer output tool mentah; dan error tanpa
>   13 redaksi kanonik tak dirender mentah — deny reason P0 tetap tampil.
> - **v0.42** — baris live tool (root/anak) di-commit permanen sejak muncul
>   (id per `toolCallId`/`runId`), ditimpa ringkas saat terminal → tinggi tak
>   pernah menyusut (jitter "naik lalu turun" hilang); rekap tanpa marker `└`
>   (amendemen v0.35, arsip tetap); teks kegagalan tool ringkas ≤120 kolom via
>   `friendlyToolError()` + `tSystem()` (locale OS) — detail di jurnal/verbose.
>   **Aspek transiensi baris live ditimpa v0.43**; klausa lain tetap berlaku.
> - **v0.41** — auto-update diagnostik (alasan diredaksi, satu baris ≤300 char);
>   `/update` hanya di TUI lewat handoff alt-screen → install → restart dengan
>   `MINICODE_AUTO_UPDATE_DONE=1` → exit; non-TTY/one-shot/ACP fail-closed;
>   opt-out `NO_UPDATE_CHECK=1` / `MINICODE_AUTO_UPDATE=0|false|off` / `CI=1`;
>   marker `└` pada rekap dicabut (format jadi baris kategori tanpa prefix simbol).
> - **v0.37** — bracketed paste `?2004h`/`?2004l` di luar frame (I1 utuh);
>   `Ctrl+A` = select-all bila composer kosong & dropdown tertutup, else Home;
>   `Ctrl+C` menyalin saat drag aktif; resize menstabilkan auto-scroll/drag/
>   kursor/anchor; echo prompt di-wrap sekali; lebar prompt progresif
>   `min(chatCols, 100 + floor(max(0, chatCols-100)/4))`.
> - **v0.36** — composer ≤2 baris dan dropdown `/` overlay dalam frame yang sama;
>   cap `min(100, chatWidth())` & ambang prefix ≥60 kolom ditimpa v0.37.
> - **v0.35** — rekap tool = baris committed statis `└ …`; label `› …` memakai
>   locale OS, narasi/model tetap memakai `/lang`.
> - **v0.34** — sidebar kanan dihapus; chat kolom tengah (`cols ≥ 120 && rows ≥
>   20` → `floor(cols/2)`, maks 50%); shortcut pane dihapus; I1 tidak berubah.

## Perubahan v0.43 (baris live tool transien tail ≤3, ratchet `scrollBack` naik-saja — amandemen v0.42)

Entri teratas ini adalah **amandemen v0.42**, bukan penulisan ulang kontrak.
Arsip v0.42 dan entri v7.x sebelumnya dipindahkan ke berkas
`TERMINAL_CONTRACT_ARCHIVE.md` di root repo (tidak ikut paket npm karena tidak
dibutuhkan runtime) — **tidak dihapus maupun direnomor**;
aturan presedensi "entri teratas menang" tetap berlaku. Cakupan = lapisan
tampilan transkrip TUI; kontrak output mesin/JSONL dan jurnal/verbose tidak
berubah. Tidak ada angka gate di entri ini.

Latar — klarifikasi owner: yang tidak boleh hilang adalah **history chat yang
sudah committed**, dan itu tetap berlaku sejak v0.42. Baris aktivitas tool live
bukan history; ia **kembali transien** seperti perilaku v0.40.0 — muncul saat
tool berjalan, ikut tail, dan hilang setelah tool selesai. Yang dilarang bukan
kehilangan baris live itu sendiri, melainkan **jendela transkrip bergeser balik
saat baris live hilang**, sehingga posisi baris committed berubah di layar.

1. **History committed kebal; baris live transien (v0.40.0 dipertahankan).**
   Baris yang sudah di-commit ke `lines[]` (narasi, tool selesai, rekap) tetap
   permanen dan tidak boleh hilang. Baris live root/anak bersifat sementara,
   ikut tail transkrip, dan dibuang saat tool mencapai status terminal — tanpa
   entri committed baru. Yang tidak boleh hilang adalah history committed,
   bukan baris live itu sendiri.
2. **Muncul → `total` naik → jendela boleh naik, DIBATASI 3 BARIS.** Saat baris
   live muncul, `total` bertambah dan sticky-tail menggeser jendela ke bawah;
   baris committed yang terlihat boleh naik di layar — tetapi tail live dibatasi
   **`MAX_LIVE_TAIL_ROWS = 3` aktivitas terakhir** (`src/ui/tui/transcript.ts`,
   `runningRows()`), sehingga narasi committed terdorong maksimal 3 baris.
   Puluhan baris live transien tak pernah mendorong narasi keluar viewport;
   detail lengkap tetap di jurnal/`--verbose`. `liveRows()` (API overlay lama)
   sengaja tidak dipotong — App tidak memakainya.
3. **Hilang → `total` turun → jendela tidak boleh geser balik (ratchet naik-saja).**
   Saat baris live hilang dan `total` menyusut, `scrollBack` **tidak diturunkan**:
   posisi tiap baris committed di layar tetap, dan ruang di bawah ekor boleh
   kosong. Mekanismenya adalah **ratchet `scrollBack` per turn naik-saja**,
   di-reset pada `turn:started`, prompt baru, `/clear`, **navigasi manual
   (PgUp/PgDn/End/wheel) dan resize** (geometri/wrap berubah, floor lama basi).
   Ini mencegah jitter "naik lalu turun" tanpa mengunci baris live ke history.

   **Rumus (implementasi di `src/ui/tui/app.ts` cabang `pinnedToTail`).**

   ```
   maxBack         = max(0, wrappedLength(chatCols) - viewH)
   scrollBack      = max(maxBack, turnScrollFloor)
   turnScrollFloor = max(turnScrollFloor, scrollBack)
   ```

   Tidak ada kap berbasis indeks narasi, tidak ada `narCeil`, tidak ada
   `lastNarrationIndex()` (API dan scan O(n)-nya sudah dihapus). Batas datang
   dari tail yang dipotong di butir 2, bukan dari pembatasan gerak jendela.
   `viewH`, `composerTop`, `wrappedLength`, `lines[]`, dan I1 tidak berubah.
4. **Bukan overlay / bukan region / bukan commit-in-place untuk baris live.**
   Baris live tetap baris tail biasa di dalam transkrip — tidak ditimpa di atas
   baris bawah frame seperti pola overlay dropdown v0.36, tidak memakai
   `liveRegion` untuk hit-test, dan tidak menjadi entri committed yang ditimpa
   saat transisi live → selesai. **I1 (satu `stdout.write` per frame) tetap
   utuh**; tidak ada writer, region, atau `paintRegion()` baru untuk baris live.
5. **Presedensi terhadap v0.42 (dinyatakan eksplisit).** Butir v0.42
   "commit-in-place / never-shrink by id" **ditimpa hanya pada aspek transiensi
   baris live tool** — entri v0.42 jangan dibaca sebagai keadaan kini untuk
   baris live. **Klausa v0.42 lain tidak berubah dan tetap berlaku**: teks
   kegagalan tool ringkas (`friendlyToolError()` + `tSystem()`, ≤120 kolom) dan
   rekap tanpa marker `└`. Arsip v0.42 dipertahankan sebagai sejarah sesuai
   aturan presedensi.
6. **Amendemen redaksi kegagalan tool: 13 pola.** Perluasan atas klausa v0.42:
   `friendlyToolError()` kini mengenali **13 pola** — 4 lama (idempotency
   duplikat, `exit N`, `EIO`, `bash-guard internal error`), sub-agent, dan 8
   pola baru (tool tak dikenal, izin ditolak, argumen invalid, timeout tool,
   target tak ditemukan, dependensi tak dikonfigurasi, request gagal,
   dibatalkan). Presedensi: duplikat → sub-agent → guard → exit → EIO → 8 pola
   baru → fallback; sub-agent mengalahkan `exit N` karena ringkasan child bisa
   memuat kode keluar, guard mengalahkan `permission denied`. Deteksi memakai
   anchor/`\b`, bukan substring longgar, dan `exit` wajib memuat angka. Semua
   cabang tetap satu baris ≤120 kolom, lewat redaksi → sanitasi → potong per
   kolom dengan `tSystem()` (locale OS); detail LENGKAP tetap di
   jurnal/`--verbose` — yang berubah hanya redaksi di layar, kontrak output
   mesin/JSONL tidak berubah. Bila redaksi ringkas dipakai, suffix
    `statusWord`/`childCount` tidak diulang di baris ledger yang sama; warna status
    tetap lewat `paintLedger`; deny reason tanpa redaksi tetap tampil.

7. **Amendemen caret prompt — prefix tanpa spasi trailing (v0.36/v7.30
   dikonsistensikan).** `promptFirst()`/`promptCont()` di `src/ui/tui/app.ts`
   kini menghasilkan `minicode ›` / `›` / `  ·` / `·` — **tanpa spasi
   trailing**. `PROMPT_LONG_PREFIX_COLS` turun dari
   `ASSISTANT_LEFT_MARGIN + 11` menjadi `+ 10` (13 kolom untuk prefix panjang),
   sehingga ambang prefix panjang bergeser dari `w ≥ 38` menjadi `w ≥ 37`.
   Semua posisi caret memakai `displayWidth(pf) + 1` (offset 1-based), tanpa
   tambah `+1` untuk spasi: saat prompt kosong caret tepat sesudah `›`, dan
   pada baris lanjutan tepat sesudah `·`. Klausa v0.36/v7.30 yang mensyaratkan
   caret menempel di `›` kini konsisten dengan kode dan test — teks/test lama
   masih mengunci `"minicode › "` / `"› "` / `"  · "`. Lebar composer,
   `chat-column.ts`, dan `composerWidth()` **tidak berubah**; gema prompt
   transkrip (v0.37) juga tidak disentuh. I1 (satu write/frame) tetap utuh.
 8. **Amendemen kerapian rekap (v0.35 butir 1 & v0.42 butir 3).** Rekap kumulatif
    akhir turn kini **menimpa** baris rekap segmen yang baru saja ditulis
    (`replaceEntry()`), bukan menambah baris baru — mencegah dua rekap bertumpuk
    seperti `10 read` diikuti `2 command · 164 read · …` saat segmen terakhir
    belum ter-flush. Kumulatif tetap jadi baris rekap terakhir; rekap segmen
    sebelumnya yang sah tetap ada. Satu **baris kosong** ditulis tepat setelah
    rekap sebelum narasi berikutnya (flag internal `recapJustWritten`, bukan
    indikator UI), dengan guard `last !== ""` agar tidak ada dua blank berturut.
    Hanya `lines[]`/`rowCache` yang disunting: I1 (satu write/frame) dan writer
    inventory tidak berubah.
9. **Amendemen tinggi composer: 2 baris TETAP di semua state.** `composerHeight()`
   dan `buildLayout()` tidak lagi bergantung pada `composerLive(busy)`/`editing`:
   `composerH = COMPOSER_MAX_ROWS` (= 2) secara konstan — idle, saat mengetik,
   saat busy, dan setelah turn selesai. Dulu `composerH` turun ke 1 saat submit
   (`editing = false`), sehingga `viewH` membesar satu dan `composerTop`/prompt
   bergeser satu baris; `finally` mengembalikannya. Jitter itu kini hilang.
   Baris ke-2 sengaja di-pad kosong bila draft cuma satu baris atau sedang busy,
   jadi tinggi frame tetap. `viewportHeight()` dan `menuRows()` mengikuti otomatis
   lewat `composerHeight()` (rumus keduanya tidak diubah). Draft wrap, `Ctrl+J`,
   dan dropdown `/` tidak tersentuh — tetap 2 baris seperti sebelumnya. I1 (satu
   `stdout.write` per frame) utuh; clamp `contentBudget` untuk terminal sangat
   pendek dibiarkan apa adanya.

10. **Amendemen `/copy` — sumber = yang terender, bukan buffer tool output.**
    `/copy [n]` kini mengambil teks dari `Transcript.copyTurnTexts(n)`, yaitu
    baris yang benar-benar tampil di transkrip untuk 1..n turn terakhir:
    **hanya narasi `kind:"assistant"` dan rekap/laporan** (flag `rekap:true`,
    termasuk agregat `✦`). Gema user, ledger tool, diagnostic, error mentah,
    output tool, dan blank separator DITOLAK. Sumber lama `#lastTurnText`
    (buffer printer linear yang menampung tool output dan memotong 20.000
    kolom) tidak dipakai lagi — tak ada pemotongan karena memang tidak disalin.
    Batas grup = gema `kind:"user"`; ekor setelah gema terakhir = grup terakhir
    (fallback batas `turn:started` hanya untuk transkrip tanpa gema user).
    Grup digabung `"\n\n"`, urut oldest→newest, maks `MAX_COPY_TURNS = 10`.
    Payload OSC 52 adalah teks bebas: **tidak dipaksa ≤120 kolom per baris**
    (bukan ledger). `parseCopyCount`, guard `MAX_CLIPBOARD_BYTES`, dan seluruh
    toast (`copyNone`/`copyTooLarge`/`copyOk`/`copyOkMany`/`copyNeedTty`)
    tetap. `copyTurnTexts()` adalah pembaca murni — tanpa mutasi
    `lines`/`meta`/`sourceTexts`/proyeksi dan tanpa `stdout.write` baru; I1 &
    writer inventory utuh. `replaceEntry()` tetap mempertahankan meta lama
    (flag `rekap` bertahan saat rekap segmen ditimpa kumulatif) dan kini
    menyinkronkan `sourceTexts` agar yang tersalin = angka kumulatif terakhir.
11. **Amendemen redaksi error tanpa pola kanonik.** Ledger/status tool kini
    lewat `friendlyToolErrorCanonical()` (`src/ui/render/errors.ts`): bila pesan
    tak cocok salah satu 13 pola kanonik, fungsi mengembalikan `""` dan
    **`: <raw>` tidak dirender** — baris tool tetap tampil lewat
    `paintLedger(status, line)`, detail lengkap tetap di jurnal/`--verbose`.
    Cabang 13 pola (duplikat → sub-agent → guard → exit → EIO → 8 pola baru)
    identik dengan `friendlyToolError()` (locale OS via `tSystem()`, ≤120
    kolom). **Deny reason (P0) tetap wajib tampil** walau tak ada redaksi
    kanonik; sub-agent error tetap memakai `tSystem("msg.subagentFailed")`.

Peta proteksi rekap: `test/audit-fix-live-inline-status.test.ts` (replaceEntry
mencegah duplikasi & satu blank setelah rekap sebelum narasi).
Peta proteksi: `test/tui-app.test.ts` (ratchet `scrollBack` per turn naik-saja:
naik saat `total` bertambah, tidak turun saat `total` menyusut, reset pada
`turn:started` / prompt baru / `/clear` / navigasi manual / resize; regresi
60×14 — 20 live + narasi per siklus, narasi tetap terlihat dan 1–3 baris live
tampil saat live aktif, narasi tetap tampil setelah live hilang, `total() > 0`,
tinggi & composer konstan, I1 satu write; composer 2 baris tetap (butir 9):
prompt di baris yang sama di idle/ketik/busy/selesai, frame 60×14 konstan,
footer di baris terakhir, baris ke-2 kosong, I1 satu write per repaint; draft
8 baris & dropdown tak menggeser baris prompt); caret tanpa spasi trailing &
menempel di `›`/`·`: prompt kosong, CJK/emoji per kolom, wrap multiline, klik
mouse, panah vertikal, dropdown, ambang 37 kolom, I1 satu write),
`test/audit-fix-clean-composer.test.ts` (composer kosong/draft tanpa spasi
trailing), `test/chat-column.test.ts` (geometri & lebar composer tak berubah),
`test/tui-transcript.test.ts` (viewport transkrip: history committed utuh, tail
live dipotong maksimal 3 aktivitas terakhir walau 20 running, posisi committed
stabil saat baris live hilang; regresi baris ledger `delegate_task` gagal + 1
child: tanpa `statusWord`/`child tools`, satu baris ≤120 kolom, warna status via
`paintLedger`; regresi butir 11: error tanpa 13 pola kanonik tak menghasilkan
`: <raw>`, deny reason tetap tampil), `test/tui-copy-turn.test.ts` (butir 10/11:
`copyTurnTexts()` hanya narasi + rekap, 2 grup oldest→newest, pembaca murni;
payload OSC 52 decode base64 = persis narasi+rekap, baris >120 kolom utuh,
output tool >20.000 char di `#lastTurnText` tak ikut tersalin; error mentah tak
muncul, deny reason & `tSystem("msg.subagentFailed")` tetap),
`test/errors-usage.test.ts` (13 pola
`friendlyToolError()`: presedensi sub-agent/guard, tabel en/id via `tSystem()`,
negatif anchor, redaksi ≤120 kolom tanpa SGR dengan rahasia teredaksi). Angka
gate tidak ditaruh di entri kontrak; hasil kandidat ada di
`.audit/FINAL-STATE.md` dan harus dijalankan ulang bila ada perubahan
setelahnya.

## Indeks arsip

Isi lengkap arsip: `TERMINAL_CONTRACT_ARCHIVE.md` di root repo — tidak ikut
paket npm karena bukan kebutuhan runtime. Arsip tidak dihapus maupun direnomor.

Status & presedensi: entri teratas menang. Aturan presedensi: arsip di bawah
tidak pernah menimpa klausa entri aktif di atasnya.

Perubahan v7.40 — klarifikasi narasi/prompt.
Perubahan v7.35 — unifikasi `scrollBy` ke `viewH`; `wrapped - viewH`.
Perubahan v7.30 — composer & caret.
## Perubahan v0.43 — entri aktif di atas.
## Perubahan v0.42 — arsip: baris live committed, rekap tanpa `└`.
## Perubahan v0.41 — arsip.
## Perubahan v0.37 — arsip: wrap sekali, lebar prompt progresif.
## Perubahan v0.36 — arsip: composer ≤2 baris, dropdown overlay.
## Perubahan v0.35 — arsip: rekap `└ …`.
## Perubahan v0.34 — arsip: sidebar kanan dihapus.

zero-state kosong tanpa logo (bukan "logo + hint").
