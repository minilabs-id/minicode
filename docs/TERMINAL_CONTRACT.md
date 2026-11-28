# Kontrak Terminal MiniCode (TUI fullscreen — v0.51 amandemen v0.43: label niat manusiawi per tool + reveal ketikan live + tail live adaptif `max(3, floor(viewH * 0.5))` + kegagalan berbasis label `<label> mengalami kegagalan (<penyebab>)`; v0.43: chat + composer di-offset **3 kolom kiri + 3 kolom kanan sebagai padding FRAME simetris** (margin bukan spasi pada teks; footer tetap kolom 0 lebar `chatCols`; popup/dropdown full-screen), **kotak garis tipis bersudut lengkung keliling composer (`╭─╮`/`│ │`/`╰─╯`, warna `#36383E`/`236`, tanpa latar warna) dengan tinggi isi dinamis 1–2 baris (default 1 baris, otomatis melebar ke 2 baris saat teks > 1 baris, dapat digulir via panah `↑`/`↓` maupun mouse wheel bila > 2 baris dengan indikator `↑`/`↓`), tanpa prefix `minicode ›`, seleksi teks composer via drag/`Ctrl+A`/`Ctrl+C`** + **word-wrap** + **placeholder paste ringkas (`{paste text N lines}`)**; ratchet `scrollBack` per turn naik-saja, tidak turun saat live hilang; v0.42: baris live tool committed monoton + teks gagal ringkas (aspek transiensi ditimpa v0.43); v0.41: auto-update diagnostik + `/update` TUI + handoff terminal aman; v0.37: bracketed paste + select-all + resize stabilizer + echo prompt sekali-wrap + geometri prompt progresif; v0.36: composer ≤2 baris & dropdown overlay; v0.35: rekap committed statis & label aktivitas OS; v0.34: sidebar dihapus, chat kolom tengah)

> **Status & presedensi (dibaca dulu).** `v0.x` = versi produk, `v7.x` = versi
> kontrak terminal — dua namespace, bukan peringkat numerik.
>
> **Aturan presedensi:** entri teratas / tanggal rilis terbaru menang; **v0.51**
> mengamandemen v0.43 pada tail live adaptif `max(3, floor(viewH * 0.5))`, reveal
> ketikan live, waiting indicator, serta redaksi kegagalan seragam
> `<label> mengalami kegagalan (<tag>)`; **v0.43** mengamandemen v0.42 **hanya pada aspek
> transiensi baris live tool** (baris live kembali transien ikut tail; history chat
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
> - **Perbaikan parser markdown & pemisah horizontal (disetujui pemilik 2026-11-28)** — `renderInline()` memakai stack delimiter ala CommonMark + pencocokan run backtick `N`-panjang + parser tautan seimbang + `paintWithRestore()` sehingga penekanan bersarang (`**… *…***`, `***…***`), span multi-backtick (```` ```…``` ````), dan SGR di dalam heading/tautan tidak menyisakan `**`/`***`/`` ` `` mentah; helper bersama `renderMarkdownContentLine()` di `markdown.ts` & `Transcript.renderAssistantLine()` juga membuang `#` pada heading berindentasi maupun di dalam list/kutipan dan merender garis pemisah horizontal mandiri (`***`/`---`/`___`) dengan `c.dim(glyphs.hLine.repeat(…))`. Peta proteksi: `test/tui-format.test.ts`, `test/tui-transcript.test.ts`, `test/tui-theme-highlight.test.ts`.
> - **Amandemen tampilan live & agregat sub-agent (disetujui pemilik 2026-11-28)** — baris agregat `✦` menghapus jumlah live/selesai dalam kurung (`(R running)` / `(R running · D done)`) sehingga selalu ringkas `✦ N sub agent · T tool · F failed` (plus perincian gagal bila `F > 0`). Baris live sub-agent (`delegate_task`) hanya menampilkan `› <nama>` dengan pulse warna halus (`c.info` terang ↔ `c.gray` redup tiap `600 ms`, statis `c.info` bila `MINICODE_MOTION=0`) dan timer `MM:SS` (`HH:MM:SS` bila `≥ 1 jam`) berwarna redup `c.faint` setelah `≥ 2 dtk`, tanpa teks status `… running`/`… berjalan`; tool non-sub-agent tetap memakai format `› <label> … running/berjalan (<Ns>)`.
> - **Amandemen durasi akhir turn bersama rekap (disetujui pemilik 2026-11-28)** — di akhir setiap turn TUI (`turn:completed`/`turn.completed`/`turn.failed`/`turn.cancelled`, serta `--resume` bila `summary.durationMs` tersedia), `flushTurnTotal()` selalu mencatat lama turn berjalan dengan `formatElapsed` berspasi antara menit dan detik (`14s`, `1m 05s`, `1h 02m`) terlepas dari ada-tidaknya tool: jika ada tool digabung di baris rekap kumulatif (`2 command · 118 read · 1m 05s`, tetap ber-`rekap:true` untuk `/copy` dan menimpa rekap segmen terakhir via `replaceEntry`), sedangkan turn tanpa tool (`0` tool) menampilkan baris durasi saja (`1m 05s`, `kind:"system"` tanpa `rekap:true` agar `/copy` tetap menyalin narasi bersih). Rekap segmen tengah turn (`flushActivityFold`) tidak menyertakan durasi turn.
> - **Amandemen pasca-v0.52.1 (tampilan live sub-agent 2 lapis, agregat per putaran, & label kerja — disetujui pemilik 2026-11-27)** — (1) baris live TUI hanya menampilkan aktivitas root (`!parentToolCallId`) agar baris `  ↳` tool anak tidak berkedip dan seluruh baris live sub-agent selaras gaya `runningLine()` dengan tool non-sub-agent; (2) agregat `✦` sub-agent dilacak **per putaran (`wave`)**: putaran lama tetap tertinggal di atas sebagai riwayat, putaran baru membuat blok `✦` + live root putaran berjalan di bawah dengan spasi/jeda konsisten dan kegagalan `delegate_task` tetap ditampilkan berlabel tugas; (3) `extractIntent` menyaring ringkasan `args.prompt` saat `delegate_task` tanpa `name`, `cleanDelegateRole` memblokir placeholder `"delegate_task"` & `"sub-agent (…) done:"`, `friendlyToolFailureTag`/`agentFailureReason` memisahkan `stepLimit`, dan `deriveSupersedes` mencegah overwrite lintas tugas `delegate_task` berbeda.
> - **Amandemen gema paste di transkrip (disetujui pemilik 2026-11-27)** — placeholder paste `{paste text N line(s)}` tetap ringkas **hanya di composer** (termasuk recall histori `↑`/`↓` dan `Ctrl+R`); saat Enter (submit idle maupun enqueue/steer busy), token paste diekspansi penuh baik ke `host.submit`/`host.enqueue` maupun pada gema riwayat chat (`pushUser`) agar isi prompt terbuka dan terbaca di histori percakapan.
> - **v0.52.1 (perbaikan UI/UX & keterbacaan warna tema — amandemen atas v0.51)** — (1) baris
>   tunggu transien `waitingStatusRow()` tidak lagi tertahan oleh buffer
>   `thinkingTail`/`thinkingArea` saat `FLAT_RENDERER` menekan baris thinking;
>   (2) ratchet `turnScrollFloor` ikut direbase turun ketika evict memangkas
>   kepala transkrip (`onEviction`); (3) baris live `runningLine()` memakai
>   anggaran label proporsional terhadap `chatCols` agar suffix status & timer
>   tidak terpotong/membungkus di kolom sempit, dan fallback sempit
>   `renderFooter()` memprioritaskan badge operasional (`retry`, `+running`,
>   `queued`, `new·PgDn`) di atas metrik angka; (4) `pushUser()` menyimpan
>   baris logis utuh tanpa pre-wrap statis sehingga resize dan
>   `replayHistory()` membungkus ulang gema prompt secara dinamis ke `chatCols`;
>   (5) tutup bold dengan `\x1b[22;39m`, kalibrasi kontras truecolor
>   `gray`/`faint`/`accentAlt`/`magenta`, segmen pasif timer & ledger non-terminal
>   memakai `c.gray`, hit list tak terpilih `c.info` tanpa `c.dim`, serta
>   hierarki heading H1–H4+/tautan/kutipan `>` terpusat di `markdown.ts` +
>   `transcript.ts`; serta (6) agregat `✦` sub-agent digabung menjadi 1 baris
>   per turn dan `delegate_task` langsung memakai label peran tanpa awalan
>   berulang (bingkai `#36383E`, palet gelap tunggal, & geometri frame tetap).
> - **v0.51 (amandemen atas v0.43)** — menyempurnakan tampilan tool live & error:
>   (1) parameter opsional `label` hanya disuntikkan ke tool ber-intent terbuka
>   (`bash`, `code_run`, `web_search`, `web_fetch`, dan MCP via `withMcpTools`;
>   `delegate_task` tetap memakai `name`) untuk menghemat token skema, sementara
>   tool sederhana memakai **auto-label manusiawi 0-token** di
>   `formatActivityLabel` / `cleanAutoTarget`; (2) tail live bersifat **adaptif
>   `max(3, floor(viewH * 0.5))`** (bukan kap keras `3` lagi) supaya seluruh
>   aktivitas paralel tampil pada terminal wajar tanpa menelan chat atau
>   meledakkan ruang ratchet, dan hitungan `+N` footer serta indikator scroll
>   memakai batas adaptif `viewH` yang sama (plus prioritas seluruh root /
>   sub-agent paralel saat kuota baris penuh); (3) pada TUI interaktif
>   (`animateLive: true`), baris live memakai **jeda anti-kedip `60 ms`**
>   (tool kilat tak berkedip sepotong) lalu muncul **per kata (`50 ms/kata`)** via
>   ticker dinamis (kembali ke `200 ms` saat tuntas, tetap I1 1 write/frame);
>   saat turn aktif namun layar masih kosong menunggu model/penyedia (`≥ 1,5 dtk`
>   atau retry), tampil 1 baris status tunggu transien yang otomatis hilang
>   begitu narasi/tool masuk; (4) **semua** kegagalan tool
>   memakai satu format seragam `› <label/auto-label> mengalami kegagalan (<tag>)`
>   (`formatLabeledToolFailure`), tanpa menggandakan `{target}` command mentah;
>   (5) event `turn.cancelled (budget)`, replay `llm-failed` `context.compacted`,
>   serta gangguan provider berat (`≥ 3` retry/error) dicatat ringkas di transkrip;
>   (6) badge `retry` dan `new · PgDn` bergabung di footer tanpa menghilangkan
>   timer atau konteks.
> - **v0.43** — klarifikasi atas v0.42: yang tidak boleh hilang adalah **history
>   chat yang sudah committed**; baris aktivitas tool **live kembali transien**
>   (hilang setelah tool selesai), mengikuti perilaku v0.40.0. Tail live awalnya
>   dibatasi maksimal 3 baris terakhir (lalu diamandemen di **v0.51** menjadi
>   adaptif **`max(3, floor(viewH * 0.5))`**) supaya narasi committed tetap tampil
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
>   redaksi kegagalan tool: 21 pola kanonik (6 jalur presedensi + 15 pola) dengan
>   presedensi duplicate/sub-agent/guard/shellQuoting lebih dulu + fallback narasi
>   aman OS-locale (`tSystem`); detail tetap di jurnal/`--verbose`, dan jalur
>   mesin ACP memakai `formatMachineError` (redaksi+sanitasi tanpa fallback generik).
>   Juga diamandemen **margin kiri 3 kolom + kanan 3 kolom simetris**: kini menjadi
>   **padding FRAME** saat merakit baris (`src/ui/tui/app.ts`), BUKAN spasi pada
>   string teks. Baris chat history + composer mulai di `padLeft + 3`;
>   **footer/indicator dikecualikan** (mulai di `padLeft` = kolom 0 saat chat
>   penuh, lebar tetap `chatCols`, bukan penuh `cols`); **popup/dropdown tetap
>   full-screen kolom 0** (nol perubahan). Margin bersifat **literal 3**
>   (`ASSISTANT_LEFT_MARGIN` kiri & `FRAME_RIGHT_MARGIN` kanan), bukan
>   `effectiveAssistantMargin` adaptif. Lebar isi = `chatCols - 6` dipakai
>   wrap/viewport/composer/klik; I1 & writer inventory utuh.
>   Juga diamandemen tinggi composer: **dinamis 1–2 baris isi** — default **1
>   baris** saat kosong/1 baris teks/idle/busy, otomatis melebar ke **2 baris**
>   saat teks melebihi 1 baris (wrap atau `\n`), dan **dapat digulir** di dalam
>   jendela 2 baris via panah `↑`/`↓` maupun **mouse wheel** di atas kotak
>   composer (dengan indikator `↑`/`↓`) bila teks melebihi 2 baris.
>   Juga diamandemen **kotak garis tipis bersudut lengkung keliling composer
>   (`╭─╮` / `│ │` / `╰─╯`, ASCII `+-+`/`|`, warna `#36383E` / `236`, tanpa
>   latar warna)**, **tanpa prefix `minicode ›` di dalam composer** (gema di
>   transkrip tetap memakai `minicode › `), **seleksi teks composer** via drag
>   mouse / `Ctrl+A` / `Ctrl+C`, **word-wrap di batas spasi/tab**, serta
>   **placeholder paste ringkas** (`{paste text N lines}` di composer untuk paste bracketed
>   ≥2 baris atau ≥160 char, hapus atomik Backspace/Delete, dan ekspansi penuh
>   saat submit/enqueue serta pada gema transkrip chat).
>   Juga diamandemen `/copy`: menyalin **render 1 turn** dari transkrip (narasi
>   assistant + rekap/laporan), bukan buffer output tool mentah; dan error tanpa
>   21 redaksi kanonik tak dirender mentah — deny reason P0 tetap tampil.
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

## Amandemen tampilan live & agregat sub-agent (2026-11-28)

Disetujui pemilik (2026-11-28) di atas kontrak `Amandemen pasca-v0.52.1` (mengamandemen butir #2 mengenai tanda jumlah live `(R running)` / `(R running · D done)` dan gaya `runningLine()` khusus `delegate_task`):

1. **Baris agregat `✦` bersih tanpa jumlah live.** `formatAgentProgress()` selalu menampilkan `✦ N sub agent · T tool · F failed` (atau `gagal` + perincian kegagalan bila `F > 0`) baik ketika gelombang sedang berjalan maupun sesudah selesai, tanpa imbuhan `(R running)` maupun `(R running · D done)`.
2. **Baris live sub-agent: `› <nama> <MM:SS>` dengan nama pulse & timer redup.** Khusus `delegate_task` pada `Transcript.runningLine()`:
   - Teks status `… running` / `… berjalan` dihilangkan; cukup `› <nama>`.
   - Setelah ambang `elapsedVisible` (`≥ 2 dtk`), timer ditampilkan tepat di sebelah nama dalam format `MM:SS` (`HH:MM:SS` bila `≥ 1 jam`, mis. `11:24`) memakai `c.faint(...)` agar lebih redup dari nama.
   - Seluruh teks `› <nama>` berdenyut halus meredup–menyala (`c.info` ↔ `c.gray` bergantian tiap `600 ms`, mengikuti clock repaint TUI), dan tetap `c.info` statis saat `MINICODE_MOTION=0`.
   - Tool non-sub-agent tetap memakai format `› <label> … running/berjalan (<Ns>)` seperti pada `v0.51`/`v0.52.1`.

## Amandemen pasca-v0.52.1 (live sub-agent 2 lapis, riwayat per putaran, & budget sub-agent)

Disetujui pemilik (2026-11-27) di atas kontrak `v0.52.1` tanpa mengubah geometri frame (`chatCols`, margin `3+3`, kotak composer, footer, ratchet):

1. **Tampilan live sub-agent 2 lapis (selaras live tool non-sub-agent).** `Transcript.orderedRunning()` hanya merender aktivitas root (`!parentToolCallId`); baris tool anak `  ↳` tidak lagi berkedip di tail live (`runningRows()`/`liveRows()`). Tool anak tetap dihitung di baris agregat `✦` secara real-time.
2. **Agregat `✦` per putaran (`wave`) & riwayat tetap di atas.** Setiap gelombang delegasi `delegate_task` membuat dan memperbarui baris `✦ N sub agent · T tool · F failed` sendiri. Saat gelombang masih berjalan dan sebagian sub-agent sudah selesai, baris tersebut menampilkan progres aktif (`✦ N sub agent (R running · D done) · …` / `(R berjalan · D selesai)`), lalu kembali bersih `✦ N sub agent · …` setelah seluruh root gelombang selesai. Saat putaran lama selesai dan putaran baru dimulai dalam turn yang sama, putaran lama tetap tertinggal di atas beserta baris kegagalan `delegate_task` berlabel tugasnya, sementara putaran baru membuka blok `✦` + live root putaran baru di bawahnya setelah satu jeda baris kosong (dan antar-baris aktivitas di dalam blok tetap rapat tanpa jeda kosong berulang).
3. **Label tugas & diagnosis kegagalan.** `extractIntent()` merangkum frasa pertama `args.prompt` ketika `delegate_task` dipanggil tanpa `name`; `getPresentationSnapshot()` meneruskan `intent` ke `UiPresentationActivity` dan `minicode:child-link` non-placeholder menyinkronkan `activity.label` ke induk; `cleanDelegateRole()` memblokir placeholder `"delegate_task"` dan `"sub-agent (…) done:"`; `deriveSupersedes()` mencegah `delegate_task` berbeda tugas menimpa kegagalan putaran sebelumnya; serta `friendlyToolFailureTag()`/`agentFailureReason()` mengklasifikasikan `step limit reached` sebagai `stepLimit` (`step limit`/`batas langkah`).

## Perubahan v0.52.1 (perbaikan UI/UX & keterbacaan warna tema — amandemen atas v0.51)

Entri ini menjaga seluruh geometri frame v0.43/v0.51 (termasuk bingkai `#36383E` dan palet gelap tunggal) tetap utuh dan menambal lima butir perilaku/visual pada runtime TUI & renderer:

1. **Waiting indicator tetap tampil di renderer flat (`U1`).** Saat `FLAT_RENDERER` aktif, buffer `thinkingTail`/`thinkingArea` tidak pernah dirender (`thinkingRows()` mengembalikan `[]`), sehingga `waitingStatusRow()` hanya menahan status tunggu bila thinking benar-benar dirender (`!FLAT_RENDERER`).
2. **Ratchet `turnScrollFloor` ikut bergeser saat evict (`U2`).** Di `TuiApp` (`onEviction`), selain `scrollBack = max(0, scrollBack - n)`, `turnScrollFloor = max(0, turnScrollFloor - n)` mencegah ratchet lama menahan viewport melewati tinggi transkrip baru sesudah pangkas kepala (`TRANSCRIPT_CAP`).
3. **Budget label live & prioritas badge footer sempit (`U3`).** `Transcript.runningLine()` menerima lebar `chatCols` dari `tailRows()`/`liveRows()` untuk menghitung anggaran label proporsional (`max(12, min(72, width - overhead))`), menjaga suffix status `… berjalan (Ns)` pada satu baris di kolom ter-centre; fallback sempit `renderFooter()` memprioritaskan badge operasional (`retryBadge`, `+running`, `queued`, `new · PgDn`) sebelum memotong/membuang metrik angka.
4. **Gema prompt user adaptif terhadap resize & replay (`U4`).** `Transcript.pushUser()` menyimpan baris logis utuh tanpa pre-wrap statis terhadap lebar sesaat, sehingga `projectText` selalu membungkus ulang baris `kind: "user"` secara dinamis mengikuti lebar `chatCols` aktif maupun sesudah `replayHistory()`.
5. **Keterbacaan warna tema, penutup SGR bold, & hierarki markdown (`C1`–`C5`).** `paintTokenBoldFor` menutup bold eksplisit dengan `\x1b[22;39m`; truecolor `gray` (`38;2;142;148;158`) dan `faint` (`38;2;104;110;122`) dikalibrasi sementara `accentAlt`/`magenta` diselaraskan ke ungu `38;2;180;142;242`; segmen pasif timer aktif dan ledger non-terminal memakai `c.gray`; hit pencarian `highlightMatch` pada baris tak terpilih memakai `c.info` tanpa `c.dim`; boolean/`null` JSON memakai `brightMagenta` & flag shell memakai `info`; serta `markdown.ts` + `Transcript.renderAssistantLine` berbagi `paintMarkdownHeading`/`paintMarkdownBlockquote`, tautan non-bold `c.accent`, dan fast-path `^\s*>` untuk baris kutipan.
6. **Agregat sub-agent 1 baris per turn & label peran langsung.** `Transcript.aggregateAgent()` menggabungkan seluruh `delegate_task` dalam satu turn menjadi satu baris `✦ N sub agent · …` alih-alih N baris `✦ 1 sub agent` bertumpuk; `humanToolLabel()`/`formatActivityLabel()` menampilkan label peran (`intent`/`label`/`summary`/`target`) secara langsung tanpa awalan `sub agent · `/`agen sub · ` maupun prefiks `Delegasi tugas`/`Subagent`, serta `activity.label` ikut memperbarui baris induk `delegate_task`.

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
2. **Muncul → `total` naik → jendela boleh naik, DIBATASI ADAPTIF VIEWPORT.**
   Saat baris live muncul, `total` bertambah dan sticky-tail menggeser jendela ke
   bawah; baris committed yang terlihat boleh naik di layar — tail live dibatasi
   **`max(MIN_LIVE_TAIL_ROWS = 3, floor(viewH * 0.5))`** (`DEFAULT_MAX_LIVE_TAIL_ROWS = 12`
   bila tinggi tak diketahui; `src/ui/tui/transcript.ts`, `runningRows()`),
   sehingga seluruh tool paralel wajar tampil bersamaan tanpa mendorong narasi
   keluar viewport. Detail lengkap tetap di jurnal/`--verbose`. `liveRows()` (API
   overlay lama) sengaja tidak dipotong — App tidak memakainya.
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
6. **Amendemen redaksi kegagalan tool: 21 pola kanonik (6 jalur presedensi + 15 pola).** Perluasan atas klausa v0.42:
   `friendlyToolError()` kini mengenali **21 pola** — 6 jalur presedensi
   (idempotency duplikat, sub-agent, `bash-guard internal error`, `cmd.exe quoting`,
   `exit N`, `EIO`) dan 15 pola kanonik terstruktur (tool tak dikenal, izin ditolak,
   argumen invalid, timeout tool, sinkronisasi rencana, edit mismatch, target tak
   ditemukan, dependensi tak dikonfigurasi, request gagal, dibatalkan, akses FS,
   jaringan/TLS, parse JSON/URL, galat git, integrasi MCP/LSP) → fallback OS-locale.
   Presedensi: duplikat → sub-agent → guard → shellQuoting → exit → EIO → 15 pola
   → fallback; sub-agent mengalahkan `exit N` karena ringkasan child bisa
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
   kini menghasilkan `minicode ›` / `›` / `·` — **tanpa spasi depan/belakang** —
   (margin 3 kini padding frame). `PROMPT_LONG_PREFIX_COLS` turun dari
   `13` menjadi `10` (prefix panjang murni label),
   sehingga ambang prefix panjang bergeser dari `w ≥ 37` menjadi **`w ≥ 34`**
   (`w` = `composerWidth()`; lebar isi `= cols - 3`, jadi ambang LAYAR tetap 37).
   Semua posisi caret memakai `displayWidth(pf) + 1`, lalu CUP absolut ditambah
   `padLeft + 3`; hit-test mouse mengurangi `padLeft + 3` sebelum memetakan kolom.
   Klausa v0.36/v7.30 yang mensyaratkan caret menempel di `›` tetap berlaku.
   Geometri `chat-column.ts` tidak berubah; yang berubah hanya lebar isi
   (`chatCols - 3`) untuk wrap/composer/gema. I1 (satu write/frame) tetap utuh.
   **Amendemen bentuk caret (24 Nov 2026):** DECSCUSR berubah `6 q` (bar
   stabil) → `5 q` (bar **berkedip**). Kedipan dilakukan terminal sendiri —
   tanpa timer, repaint tambahan, atau `stdout.write` baru. Posisi caret
   (offset `displayWidth(pf) + 1`) tidak berubah; `0 q` saat exit tetap.
   **Amendemen spark footer:** glif thinking saat busy kini berputar 4 warna
   (cyan→magenta→yellow→white) mengikuti `sparkFrame` yang sudah ada; idle
   tetap `faint`. Tidak ada writer baru, geometri footer tidak berubah.
    **Amendemen retry sukses (24 Nov 2026):** bila tool/sub-agent gagal lalu
    retry berhasil, baris ledger lama **ditimpa** via `replaceEntry()` dengan
    versi sukses (`paintLedger("completed")` ⇒ hijau), bukan ditambah baris baru.
    Agregat `✦` mengurangi hitungan `failures` untuk alasan itu dan kembali ke
    warna normal (`c.info`). Rekap (`activityFold`/`turnToolNames`) mengganti
    slot attempt gagal — tak ada dobel hitung. Penanda `↻ retry` tetap ada di
    baris tunggal sebagai jejak attempt kedua. Ini bukan pelanggaran
    "never-shrink by id": barisnya tetap ada, yang berubah cuma warna/status;
    preseden `replaceEntry` sudah dipakai untuk rekap butir 8 & agregat `✦`.
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
9. **Amendemen tinggi composer (disempurnakan butir 12 v0.43: dinamis 1–2 baris dalam kotak tipis).**
   Semula butir 9 v0.43 menguji composer **2 baris tetap**; pada rilis final
   v0.43 (butir 12 di bawah & entri teratas) tinggi isi composer ditetapkan
   **dinamis 1–2 baris**: default **1 baris** saat kosong/1 baris/idle/busy,
   otomatis melebar ke **2 baris** saat teks >1 baris (wrap atau `\n`), dan
   **dapat digulir** (`↑`/`↓` atau wheel) bila >2 baris dalam kotak garis tipis
   `╭─╮`/`│ │`/`╰─╯`. Teks bar 1–2 tetap memiliki batas keras 2 baris sehingga
   `viewH`, `menuRows()`, dan tinggi frame tetap terkunci tanpa meluap (I1 utuh).

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
    tak cocok salah satu 21 pola kanonik (v0.43+), fungsi mengembalikan `""` dan
    **`: <raw>` tidak dirender** — baris tool tetap tampil lewat
    `paintLedger(status, line)`, detail lengkap tetap di jurnal/`--verbose`.
    Cabang 21 pola (duplikat → sub-agent → guard → shellQuoting → exit → EIO →
    15 pola) identik dengan `friendlyToolError()` (locale OS via `tSystem()`, ≤120
    kolom). **Deny reason (P0) tetap wajib tampil** walau tak ada redaksi
    kanonik; sub-agent error tetap memakai `tSystem("msg.subagentFailed")`.
12. **Amendemen kotak garis tipis bersudut lengkung keliling composer, margin kanan simetris, tanpa prefix, seleksi teks, word-wrap, dan placeholder paste.**
    - **Kotak tipis sudut lengkung:** composer 1–2 baris dinamis dibingkai `╭─…─╮`,
      `│ … │`, `╰─…─╯` (`+-+` / `|` pada `MINICODE_ASCII=1`) selebar
      `composerBoxWidth()` dengan warna garis lebih halus dari `faint`
      (`38;2;54;56;62` truecolor, `38;5;236` 256-warna, `90` 16-warna, polos di
      `MINICODE_COLOR=0` / `NO_COLOR`), tanpa latar warna. Baris tepi atas &
      bawah menggantikan dua baris pemisah kosong, sehingga `viewH = height - 5`,
      `composerTop`, tinggi frame, dan **I1 (satu write per frame) tidak
      berubah**. Lebar isi composer = `composerBoxWidth() - 4`
      (`COMPOSER_BOX_LEFT_COLS = 2` untuk `│ `, `COMPOSER_BOX_RIGHT_COLS = 2`
      untuk sel indikator gulir `↑`/`↓` (ASCII `^`/`v`) + `│`).
    - **Margin kanan frame simetris:** baris chat & composer kini punya margin
      kanan `FRAME_RIGHT_MARGIN = 3` selain margin kiri 3, sehingga lebar isi
      (`contentCols`, dipakai wrap/viewport/composer/klik) = `chatCols - 6`.
      Footer/indicator tetap dikecualikan (mulai `padLeft`, lebar `chatCols`).
    - **Tanpa prefix di composer:** `promptFirst()`/`promptCont()` di dalam
      composer bernilai string kosong (`""`) sehingga caret/teks mulai di kolom
      `padLeft + 3 + 2 + 1` tanpa label `minicode ›` / `›` / `·`; gema
      prompt di transkrip (`Transcript.pushUser`) tetap mempertahankan penanda
      `minicode › `.
    - **Seleksi teks composer (`Ctrl+A` / drag mouse / `Ctrl+C`):** `Ctrl+A`
      memilih seluruh teks composer saat draft berisi (`\x1b[7m…\x1b[27m`), dan
      tetap memilih seluruh transkrip saat composer kosong; drag mouse di dalam
      area composer memilih substring draft. `Ctrl+C` menyalin teks terpilih
      (otomatis mengekspansi placeholder paste); mengetik/paste/Backspace/Delete
      menimpa atau menghapus bagian terpilih; `Esc` membatalkan seleksi tanpa
      menghapus draft.
    - **Word-wrap composer:** `wrapComposerLine()` (`src/ui/render/composer-wrap.ts`)
      membungkus di batas spasi/tab sehingga kata tidak terpotong di tengah,
      menjaga prefix `minicode ›` serta token placeholder paste tetap atomik,
      dan hanya memotong per grapheme bila satu kata tunggal melampaui lebar
      composer (atau pada baris pertama sebelum ada badan kata). Konservasi
      grapheme (`rows.join("") === prefix + body`) dijaga demi sinkronisasi
      panah vertikal & klik mouse.
    - **Placeholder paste ringkas:** payload bracketed paste (`ESC[200~…ESC[201~`)
      berjumlah **≥ 2 baris atau ≥ 160 karakter** diringkas di composer
      sebagai token `{paste text N line(s)}` (`#2`, `#3`, … bila
      jumlah baris sama berulang dalam satu draft). Backspace/Delete di ujung atau
      dalam token menghapus seluruh token secara atomik; `Ctrl+U`/`Esc`
      membersihkan peta paste aktif. Saat submit/enqueue (`doSubmit`), seluruh
      token di-ekspansi satu lintasan ke teks paste penuh baik untuk dikirim ke
      `host.submit` / `host.enqueue` maupun untuk gema riwayat chat (`pushUser`);
      recall histori `↑`/`↓` dan `Ctrl+R` tetap memulihkan token ringkas beserta
      payload-nya di composer (hingga 20 entri histori terakhir).

13. **Amendemen kenyamanan input, navigasi, antrean, & ketahanan dialog.**
    - **Atomik paste & navigasi kata:** token placeholder paste dijaga atomik
      oleh `←`/`→`, `Ctrl+←`/`Ctrl+→`/`Alt+B`/`Alt+F`, `Ctrl+W`/`Alt+Backspace`,
      klik mouse, seleksi drag, dan kursor vertikal; `Ctrl+K` menghapus ke
      akhir baris; `Ctrl+Enter` menyisipkan `ctrl-j` newline.
    - **Konsistensi `Esc` / `Ctrl+C` / `Ctrl+R`:** `Esc` di idle membatalkan
      seleksi atau menutup dropdown tanpa memicu `/undo` diam-diam; state
      fast-abort `Esc Esc` saat busy di-reset saat turn selesai. `Ctrl+C`
      berantai: salin selection → abort saat busy → bersihkan draft → toast
      hint keluar. `Ctrl+R` mendukung pencarian substring interaktif dan
      `Esc` mengembalikan draft pra-pencarian.
    - **Dropdown `/`, `@file`, & `/logs`:** `/` dicocokkan case-insensitive;
      `@` membuka autocomplete file workspace (`Tab`/`Enter` mengganti token);
      klik item pertama kali memilih lalu klik ulang pada item aktif
      melengkapinya. `/logs` membuka ring buffer error sesi; footer
      menampilkan badge antrean (`queuedCount`) dan luapan live tool (`+N`).
    - **Syntax highlight & modal parity:** blok kode bertanda pagar pada
      narasi asisten diwarnai oleh `highlightCode`; lebar gema prompt user
      sejajar margin simetris `- 6 - 1`; dialog persetujuan memakai antrean
      FIFO & pembatalan `AbortSignal`; form mendukung `Ctrl+A` + bracketed
      paste; wizard menyediakan Retry/Back saat deteksi provider gagal;
      pelukis transien `stderr` menggambar ulang lewat `onDisplace` saat
      interaktif dilepas, memakai palet `cErr` sesuai warna `stderr`.

Peta proteksi rekap: `test/audit-fix-live-inline-status.test.ts` (replaceEntry
mencegah duplikasi & satu blank setelah rekap sebelum narasi).
Peta proteksi: `test/tui-app.test.ts` (ratchet `scrollBack` per turn naik-saja:
naik saat `total` bertambah, tidak turun saat `total` menyusut, reset pada
`turn:started` / prompt baru / `/clear` / navigasi manual / resize; regresi
60×14 — 20 live + narasi per siklus, narasi tetap terlihat dan tail live
adaptif `max(3, floor(viewH * 0.5))` tampil saat live aktif, narasi tetap tampil
setelah live hilang, `total() > 0`, tinggi & composer dinamis 1–2 baris (butir 9 & 12) di
dalam kotak tipis sudut lengkung: prompt di baris yang sama pada tiap state,
frame 60×14 konstan, footer di baris terakhir, I1 satu write per repaint; draft 8
baris & dropdown tak menggeser baris prompt); tanpa prefix di composer (`promptFirst`/`promptCont`
kosong, caret mulai kolom `padLeft + 3 + 2 + 1`): prompt kosong,
CJK/emoji per kolom, wrap multiline, klik mouse, drag seleksi + `Ctrl+A` /
`Ctrl+C` di dalam composer, panah vertikal, dropdown, I1 satu write; offset
frame 3 kiri + 3 kanan: chat mulai `padLeft + 3`, footer `padLeft` lebar
`chatCols`, CUP & klik dikompensasi 3+2),
`test/composer-wrap.test.ts` (word-wrap, konservasi grapheme, inkremental &
helper placeholder paste),
`test/composer-box-and-paste.test.ts` (E2E word-wrap, kotak tipis sudut lengkung
keliling composer tanpa latar warna pada truecolor/256/mono/ASCII + indikator
`↑`/`↓`, seleksi teks composer via `Ctrl+A` & drag mouse, serta paste `{paste text N lines}`
saat ketik, hapus atomik, recall histori, antre busy, serta ekspansi penuh ke submit & gema transkrip chat),
`test/audit-fix-clean-composer.test.ts` (composer kosong/draft di dalam kotak
tipis), `test/audit-fix-footer-receipts.test.ts` (klik seleksi mulai kolom 4; toast
kwitansi tetap di footer), `test/chat-column.test.ts` (geometri & lebar composer;
chat 53/94/53 vs footer 50/100/50 pada cols=200),
`test/tui-scroll-width.test.ts` (wrap memakai `contentCols = chatCols - 6`),
`test/tui-transcript.test.ts` (viewport transkrip: history committed utuh, tail
live dipotong oleh batas adaptif `max(3, floor(viewH * 0.5))` walau 20 running, posisi committed
stabil saat baris live hilang; regresi baris ledger `delegate_task` gagal + 1
child: tanpa `statusWord`/`child tools`, satu baris ≤120 kolom, warna status via
`paintLedger`; regresi butir 11: error tanpa pola kanonik tak menghasilkan
`: <raw>`, deny reason tetap tampil), `test/tui-copy-turn.test.ts` (butir 10/11:
`copyTurnTexts()` hanya narasi + rekap, 2 grup oldest→newest, pembaca murni;
payload OSC 52 decode base64 = persis narasi+rekap, baris >120 kolom utuh,
output tool >20.000 char di `#lastTurnText` tak ikut tersalin; error mentah tak
muncul, deny reason & `tSystem("msg.subagentFailed")` tetap),
`test/errors-usage.test.ts` (21 pola
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
