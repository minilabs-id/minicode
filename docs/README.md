# Dokumentasi MiniCode

MiniCode adalah coding agent terminal yang dibangun di atas kernel MiniCore. Jalur interaktif memakai TUI fullscreen dengan sidebar kanan adaptif (Thinking + Activity/Live/Log); chat hanya memuat narasi, rekap kategori, dan jawaban akhir. Jalur one-shot dan otomatis menulis ke scrollback atau stream mesin sesuai kontraknya.

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
