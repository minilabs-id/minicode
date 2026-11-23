# Dokumentasi MiniCode

MiniCode adalah coding agent terminal berbasis kernel MiniCore: jalur interaktif memakai TUI fullscreen dengan chat kolom tengah tanpa sidebar; jalur one-shot/otomatis menulis ke scrollback atau stream mesin. Rincian perilaku terkini (rekap statis tanpa `└`, baris live tool committed monoton, teks gagal tool ringkas, label locale OS, composer dua baris, bracketed paste, auto-update diagnostik) ada di [Kontrak Terminal](TERMINAL_CONTRACT.md).

## Mulai

1. Ikuti [instalasi](getting-started.md). Metadata paket dan batas runtime Bun tersedia di `package.json` pada root repository.
2. Gunakan [quickstart](getting-started.md) untuk menyiapkan provider dan menjalankan prompt pertama.
3. Baca [memilih mode](choosing-mode.md) sebelum memberi agent akses tulis atau eksekusi.

## Batas yang perlu diketahui

- Prompt dan konteks dikirim ke provider yang Anda pilih. Server MCP dan LSP yang dikonfigurasi juga dapat menerima data atau melakukan efek eksternal.
- Path jail, bash guard (tokenizer shell sadar-platform + denylist kata kerja mutasi), WorkMode, PermissionMode, dan tool access policy membatasi eksekusi; tidak menjamin bahwa keluaran model benar.
- `fetchPinnedUrl` mem-pin alamat untuk mencegah SSRF pada pricing, DNS strict/noCache dipakai saat kompaksi, verifier membatasi `maxBuffer` 32 MB dan mengklasifikasikan kegagalan infrastruktur, serta undo/restore bersifat fail-closed (`rm` yang gagal tercatat sebagai `skipped`).
- Batasan dan kontrak operasional dijelaskan dalam panduan aktif di direktori ini. Laporan audit bertanggal telah dipangkas dari baseline dokumentasi.

## Peta dokumentasi

`SUMMARY.md` adalah daftar navigasi; dibaca build minilabs untuk membangun indeks halaman. Jumlah halaman dijaga kecil dan bebas duplikasi — satu topik, satu halaman. Versi terbit tersedia di [minilabs.id/projects/minicode/docs](https://minilabs.id/projects/minicode/docs/). [Arsitektur](architecture.md) memuat peta struktur dan alur runtime.

## Pengembangan

Panduan contributor, gate, dan batas lapisan: [contributing.md](contributing.md). Aturan agent ada di `AGENTS.md` pada root repository. Master roadmap tetap milik pemilik repo dan tidak tersedia di checkout ini.
