# Audit Performa minicode — v0.52.1

## Ringkasan eksekutif

- Penilaian: **disiplin rekayasa performa 8/10**, **efisiensi jalur eksekusi 7/10**.
- Sifat audit: **statis / read-only**. Tidak ada benchmark, test, `tsc`, maupun gate yang dijalankan. Angka di atas menilai struktur dan pengaman yang terlihat di kode, bukan latency terukur.
- Kesimpulan: tidak ada cacat arsitektural kasar berupa `O(n²)` tak terkendali di jalur utama. Yang ada adalah **kerja ganda di batas modul** dan **biaya startup tetap untuk subcommand**.

## Ruang lingkup dan metode

- Objek: checkout `minicode-ai` v0.52.1 (`package.json:2-3`), ESM + Bun, zero runtime dependency.
- Area dibaca: `cli/`, `src/ui/`, `src/session/`, `src/policy/`, `src/tools/`, `src/telemetry/`, `src/presentation/`, skrip `bench-render.ts` dan `bench-typing.ts`, serta `docs/UI_RENDER_PIPELINE.md` dan `AGENTS.md`.
- Empat penyelidikan paralel dialamatkan ke UI, sesi, tools/policy, dan startup. Semua berhenti sebelum selesai; bagian parsialnya **diverifikasi ulang satu per satu**. Dua dugaan ditolak (lihat "Temuan yang tidak dipakai").

## Yang sudah baik

1. Sanitasi teks tak-terpercaya di jalur linear terjadi **per potongan**, bukan per seluruh transkrip: `src/ui/assistant/simple.ts:728`, `:824`, `:841`, `:867`. Ekor escape yang terpotong ditangani stateful di `src/ui/render/sanitize.ts:199-213`.
2. Transkrip TUI sudah memisahkan komit dan tail: proyeksi per lebar (`src/ui/tui/transcript.ts:442-460`, `:1856-1865`), cache per baris (`:587-594`), memo pending per baris (`:2056-2135`), cap 5000 baris / 1MB (`:282-287`).
3. Keluaran tool dibatasi saat ingest, bukan hanya saat ditampilkan: `CappedBuffer` di `src/tools/bash.ts:20-55`, timeout dan cleanup idempoten di `:553-571`.
4. Persistence presentation adalah `INSERT OR IGNORE` per event dengan dedupe kanonik (`src/session/persistence.ts:580-638`), bukan rewrite seluruh riwayat tiap save.
5. Harness performa sudah ada dan sengaja relatif: `scripts/bench-render.ts` melaporkan p50/p95/max, `scripts/bench-typing.ts:18-20` menyatakan yang bermakna adalah rasio dan delta sebelum/sesudah pada mesin yang sama.
6. Regex scrub pernah diperbaiki dari kuadratik menjadi linear untuk pola env-dump (`src/policy/scrub.ts:68-85`), dengan bukti di `test/scrub-bounded.test.ts`.

## Temuan

### Prioritas 1 — Subcommand membayar seluruh graf aplikasi

- Bukti: `cli/index.ts:3-47` mengimpor sesi, TUI, policy, task, dan i18n secara statis. Router memang lazy per handler (`cli/router.ts:113-160`), tetapi itu terjadi **setelah** graf berat dimuat (`cli/index.ts:255`).
- `cli/entry.ts:2-6` mencatat sendiri bahwa impor penuh membakar **~125 ms** sebelum `--version` selesai. Fast-path meta ditambahkan di `entry.ts:18-41`, tetapi hanya untuk argv yang seluruh token-nya berawalan `-`.
- Dampak: `minicode sessions list`, `stats`, `config`, `sessions`, dan subcommand lain tetap membayar biaya modul yang tidak mereka pakai.
- Usulan: ekstrak crash guard (`cli/index.ts:100-136`) + `dispatch()` ke modul boot ringan; `entry.ts` mengimpor boot, memanggil dispatch lebih dulu, lalu `await import("./index.ts")` hanya bila dispatch kembali `false`.
- Risiko yang wajib dicek: `setSubAgentSessionFactory` dipasang di `cli/index.ts:192-252`. Verifikasi dulu apakah `mcp serve` atau subcommand lain memerlukannya sebelum memindahkan wiring ini ke jalur utama.

### Prioritas 2 — Scrubber dipanggil berlapis pada data yang sudah aman

- `scrubSecrets` menjalankan ~20 regex global + query-param + PEM per panggilan (`src/policy/scrub.ts:6-95`, `:144-148`); ada 104 call-site di 31 berkas.
- Bash foreground: potongan di-scrub saat emit (`src/tools/bash.ts:549`), lalu teks akhir di-scrub lagi oleh `CappedBuffer.text()` (`:54`). Background: di-scrub saat ditulis (`:309`, `:313`) dan lagi saat dibaca (`:770`).
- Telemetri melakukan double-scrub eksplisit: `src/telemetry/trace.ts:101-102` — `scrubSecrets(scrubSecrets(args).slice(0, 120))`.
- Dampak: pada potongan kecil ini murah, tetapi pada keluaran 20k–2MB dan banyak sub-agent paralel, setiap pass tambahan adalah scan regex penuh.
- Usulan konkret:
  1. Di `trace.ts:101-102`, gunakan `scrubSecrets(args).slice(0, 120)` (dan bentuk `String(args)` yang sama). Scrub tetap terjadi **sebelum** pemotongan, jadi tidak ada risiko kebocoran potongan secret; satu pass hilang dengan aman.
  2. Di `CappedBuffer`, catat apakah semua segmen berasal dari jalur yang sudah di-scrub. `text()` melewati scrub hanya bila `semuaSegmenSudahDiScrub === true`; segmen error di `bash.ts:325` tetap memaksa fallback scrub. Default tetap fail-closed.
  3. Jangan ubah urutan `scrub` → `slice` di `web_fetch.ts:282`: memotong dulu dapat menyisakan prefix secret yang terlalu pendek untuk cocok dengan pola panjang minimum.

### Prioritas 3 — Proyeksi pending TUI mengulang parsed penuh per delta

- `Transcript.stream()` hanya menambah string dan menaikkan versi (`src/ui/tui/transcript.ts:927-942`).
- `pendingRows()` menjalankan `sanitizeAnsi(this.pending)` + `parseMarkdownBlocks` untuk **seluruh** pending setiap kali versi berubah (`transcript.ts:2059-2077`). Cache hasil total bersyarat `pendingVersion`, sehingga selalu miss pada delta baru. Memo per baris (`:2121-2134`) baru membantu **setelah** parsing.
- Ada sanitasi kedua per baris di `transcript.ts:2128` setelah sanitasi penuh di `:2075`.
- Dampak: untuk jawaban puluhan KB kemungkinan tidak terasa; untuk batas `maxPendingChars` 1MB ini dapat menjadi tail latency saat streaming cepat.
- Usulan: pakai instance `createStreamSanitizer()` (`src/ui/render/sanitize.ts:199-213`) di `Transcript`, sanitasikan hanya delta, lalu evaluasi penghapusan sanitasi kedua di `:2128` dengan test transkrip sebagai gate.
- Catatan dokumentasi: komentar `scripts/bench-render.ts:93-101` menyatakan tail sengaja tidak di-cache, tetapi implementasi `transcript.ts:2056-2135` sudah punya memo per baris. Komentar benchmark perlu diselaraskan.

## Temuan yang tidak dipakai

- `readFileSync` di `src/session/checkpoint.ts:156` bukan jalur frame; pemanggilnya hanya `cli/commands/openwork.ts:602` dan `src/session/open-work.ts:742`. Tidak ada bukti blocking read per paint.
- Dugaan "persistence menulis ulang seluruh history tiap save" tidak terkonfirmasi; `appendPresentationEvents` adalah insert per event (`persistence.ts:580-638`).
- Sanitasi per-chunk di `simple.ts` sudah tepat; kritik awal yang menyebutnya melakukan sanitasi ulang seluruh buffer tidak lolos verifikasi.

## Rencana implementasi

1. **Baseline dulu.** Jalankan `bun scripts/bench-render.ts --json` dan `bun scripts/bench-typing.ts --json`; simpan p50/p95/max sebagai referensi mesin yang sama. Jangan jalankan `gate:fast`—`AGENTS.md:12-14` menegaskan gate hanya atas aba-aba pemilik.
2. **Quick win berisiko rendah.** Perbaiki double-scrub di `trace.ts:101-102` dan dedupe scrub bash dengan flag "sudah di-scrub" pada `CappedBuffer`. Verifikasi: `bun x tsc --noEmit`, test scrub bounded, test bash/output, test telemetri.
3. **Startup.** Pecah boot ringan sesuai usulan Prioritas 1. Verifikasi: `--version`, `--help`, `minicode <subcmd> --help`, subcommand biasa, dan jalur `mcp serve` (khusus wiring sub-agent).
4. **Pending TUI.** Terapkan sanitizer inkremental hanya bila baseline menunjukkan p95 burst-500 masih relevan. Ulangi benchmark dan bandingkan rasio, bukan angka absolut lintas mesin.
5. **Perubahan UI.** Perbaikan yang menyentuh geometri, composer, caret, ratchet, rekap, warna, writer, atau I1 **wajib dikonfirmasi dulu** sebelum dikerjakan (`AGENTS.md:8-11`). Rencana di atas sengaja berhenti di batas itu.

## Batasan klaim

- Audit ini tidak menjalankan kode, sehingga tidak ada angka latency, heap, atau time-to-first-prompt milik checkout v0.52.1.
- Perkiraan dampak bersifat peringkat struktural, bukan pengukuran. Komentar ~125 ms di `cli/entry.ts:3-4` adalah angka historis yang tercatat di repositori, bukan hasil sesi ini.
- Status gate/checkout tidak dinyatakan hijau atau release-ready; `AGENTS.md:37-48` melarang klaim tersebut tanpa gate penuh pada kandidat yang sama.
