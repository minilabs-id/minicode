# Dokumentasi MiniCode

MiniCode adalah coding agent terminal yang dibangun di atas kernel MiniCore. Jalur interaktif memakai TUI fullscreen dengan chat sebagai kolom tengah (maksimal 50% lebar terminal, footer/composer ter-centre; di bawah ambang chat penuh lebar) — tanpa sidebar kanan. Baris tool, agregat `✦`, finding, dan marker `+ thinking` tampil di chat; jalur one-shot dan otomatis menulis ke scrollback atau stream mesin sesuai kontraknya. Sejak v0.35 rekap tool menjadi baris committed statis `└ …` di footer tiap narasi (rekap akhir turn kumulatif), dan label aktivitas `› …` memakai locale OS lewat `Intl` — narasi/jawaban model tetap memakai bahasa user (`/lang`). Sejak v0.36 composer TUI maksimal 2 baris (draft panjang = jendela geser, transkrip tak bergeser), dropdown `/` jadi overlay dalam frame yang sama tanpa mengurangi `viewH`, dan lebar prompt/kursor memakai `composerWidth() = min(100, chatWidth())` dengan prefix adaptif `minicode › `/`› ` + lanjutan `· ` (cap/ambang v0.36 ini diganti v0.37). Sejak v0.37 bracketed paste aktif (`?2004h`/`?2004l` di luar frame), `Ctrl+A` memilih seluruh transkrip bila composer kosong & dropdown tertutup, resize menstabilkan auto-scroll/drag/kursor/anchor, gema prompt di-wrap sekali selebar chat, dan cap prompt progresif `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (prefix `minicode › ` bila `w−14 ≥ 24`) — composer 2 baris & dropdown overlay tidak dicabut.

## Mulai

1. Ikuti [instalasi](getting-started.md). Metadata paket dan batas runtime Bun tersedia di `package.json` pada root repository.
2. Gunakan [quickstart](getting-started.md) untuk menyiapkan provider dan menjalankan prompt pertama.
3. Baca [memilih mode](choosing-mode.md) sebelum memberi agent akses tulis atau eksekusi.

## Batas yang perlu diketahui

- Prompt dan konteks dikirim ke provider yang Anda pilih. Server MCP dan LSP yang dikonfigurasi juga dapat menerima data atau melakukan efek eksternal.
- Path jail, bash guard (tokenizer shell sadar-platform + denylist kata kerja mutasi), WorkMode, PermissionMode, dan tool access policy membatasi eksekusi; tidak menjamin bahwa keluaran model benar.
- `fetchPinnedUrl` memin alamat untuk mencegah SSRF pada pricing, DNS strict/noCache dipakai saat kompaksi, verifier membatasi `maxBuffer` 32 MB dan mengklasifikasikan kegagalan infrastruktur, serta undo/restore bersifat fail-closed (`rm` yang gagal tercatat sebagai `skipped`).
- Batasan dan kontrak operasional dijelaskan dalam panduan aktif di direktori ini. Laporan audit bertanggal telah dipangkas dari baseline dokumentasi.

## Peta dokumentasi

`SUMMARY.md` adalah daftar navigasi; dibaca build minilabs untuk membangun indeks halaman. Jumlah halaman dijaga kecil dan bebas duplikasi — satu topik, satu halaman. Versi terbit tersedia di [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). [Arsitektur](architecture.md) memuat peta struktur dan alur runtime.

## Pengembangan

Panduan contributor, gate, dan batas lapisan: [contributing.md](contributing.md). Aturan agent ada di `AGENTS.md` pada root repository. Master roadmap tetap milik pemilik repo dan tidak tersedia di checkout ini.
