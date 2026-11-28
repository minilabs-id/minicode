# Instalasi & Quickstart

Dari nol sampai prompt pertama yang ter-verify: pasang, setup provider, jalankan, verifikasi.

Prasyarat tunggal: **`bun >= 1.1.13`** — runtime dan package manager Minicode, bukan Node.js. (Lantai versi: kode memakai `AbortSignal.any()` yang absen di Bun 1.0.x; `minicode` gagal cepat dengan pesan jelas bila versi lebih lama.)

> Kernel MiniCore ikut repo di `vendor/minicore`, jadi **tanpa clone tambahan**. Clone sibling `../minicore` hanya dibutuhkan bila kamu mau sync ulang kernel via `bun run vendor:minicore`.

## Install (untuk awam)

**Langkah 1 — Pasang Bun** (sekali saja, tutup-buka terminal lagi setelahnya):

```powershell
# Windows PowerShell
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Cek: `bun --version` harus keluar versi ≥ `1.1.13` (contoh `1.4.x`). Kalau masih `command not found`, tutup-buka terminal dulu (PATH baru ke-load setelah restart).

**Langkah 2 — Pasang Minicode:**

```bash
bun add -g minicode-ai
# bin: minicode
minicode --version  # pastikan versi terbaru terpasang
```

Minicode dipasang dan dijalankan eksklusif lewat Bun (`bun add -g minicode-ai`), tanpa perantara Node/npm. Tanpa Bun di PATH, `minicode` gagal dengan `'bun' is not recognized`.

Untuk kontributor (kerja dari source):

```bash
git clone https://github.com/minilabs-id/minicode && cd minicode
bun install && bun link
```

Opsional tapi disarankan: `rg` (ripgrep) di PATH mempercepat tool `grep`. Tanpa `rg`, walker internal dipakai dengan hasil identik (paksa jalur itu untuk uji dengan `MINICODE_GREP_ENGINE=js`).

Verifikasi:

```bash
minicode doctor        # runtime, provider, pricing, memory, sandbox, config
bun test               # offline/hermetic; live & docker di-skip otomatis
```

Setup wizard berjalan otomatis saat `minicode` pertama kali bila belum ada provider.

## Prompt pertama

Tujuan: dari nol sampai prompt pertama yang ter-verify, tanpa membaca seluruh manual.

## 1. Jalan pertama (1 menit)

```bash
minicode
```

Bila belum ada provider, wizard setup muncul. Isi berurutan: pilih gateway → tempel API key (ter-masking) → auto-detect models. Wizard memakai picker (panah + filter), bukan `readline` nomor — mengetik di luar rentang tidak lagi diam-diam memilih `[0]`.

Alternatif tanpa API key:

```bash
minicode auth login          # device-code: kode singkat + URL, setujui di browser
minicode auth status         # lihat kredensial + kapan kedaluwarsa
```

## 2. Prompt pertama (2 menit)

```bash
minicode --work-mode BUILD "buat http server hello world di server.ts" --verbose
```

Yang terjadi: model menerima system prompt berisi `# Environment` (cwd + platform) + repo-map ringkas, lalu loop ReAct `Thought → Action → Observation` sampai jawaban final atau batas (`--max-steps` default 200, `--timeout` default 1 jam; angka 600 adalah hard-cap sub-agent, bukan default sesi).

Coba mode interaktif:

```bash
minicode --interactive
# minicode › jelaskan isi src/tools/index.ts
# /model   → picker provider::model, Enter = pilih + atur effort
# /status  → token + biaya kumulatif sesi
# /exit    → keluar (blok penutup: model, mode, rincian kategori tool, jumlah agent, dan token in/out; matikan dengan MINICODE_SESSION_SUMMARY=0 — Esc ganda saat abort juga bisa)
```

Pada TUI interaktif sejak v0.34 **tidak ada sidebar kanan**. Chat adalah kolom tengah: bila `cols ≥ 120` **dan** `rows ≥ 20`, lebarnya `floor(cols/2)` (maks 50% terminal) dengan padding kiri/kanan dan footer/composer ikut ter-centre; di bawah ambang itu chat memakai lebar penuh. Popup/modal tetap ter-centre pada lebar terminal penuh. Chat memuat narasi, rekap kategori (mis. `3 command · 2 read · 5 subagent`), baris tool, agregat `✦`, finding, marker `+ thinking`, dan jawaban akhir. Scroll memakai wheel/`PgUp/PgDn` untuk chat; `Home/End` ke top/ekor chat. Pintasan pane lama (`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, `Ctrl+O`) dihapus. `/view expand` tetap dihapus; `MINICODE_ACTIVITY_PANEL` kini legacy/deprecate (D3) dan tidak lagi mengubah tampilan, `MINICODE_SHOW_THINKING` mengontrol `+ thinking` di chat, `MINICODE_MINIMIZE_ACTIVITY` tetap mengontrol fold.

## 3. Verify otomatis (2 menit)

```bash
minicode --work-mode BUILD --verify "fix bugs lalu typecheck"
```

Sebelum agen jalan, baseline diuji dulu. Bila baseline sudah merah, catatan Health-Check ditempel ke prompt awal agar agen memperbaiki dulu. Setelah run, verify dijalankan; bila gagal, agen self-heal maks 3 siklus. Output error dibungkus fence agar tidak jadi prompt injection. Custom command via `MINICODE_VERIFY_CMD` atau `verifyCommand` di config.

## Contoh pola harian

```bash
minicode --ask "deploy script"          # human-in-loop confirmation card
minicode --sandbox docker "task"        # bash di container ephemeral
minicode --budget 0.50 "task besar"     # warn 80%; pagu lewat → prompt baru ditolak + turn berjalan digugurkan
minicode exec "prompt" --json           # headless CI: JSONL stream + summary
minicode "/review src/a.ts"             # skill slash-command
```

## Matriks OS

| OS | Sandbox otomatis | Default permission | Catatan |
|---|---|---|---|
| Linux + bubblewrap | Ya, tanpa flag | `auto` | Paling terisolasi untuk `bash` |
| macOS + seatbelt | Ya, tanpa flag | `auto` | Sama, via seatbelt |
| Windows (semua) / tanpa bwrap-seatbelt | Tidak tersedia | `auto` (bash `restrictBash` allow-list otomatis) | Lebih baik membatasi perintah daripada label aman palsu. Pilih sendiri dengan `--allow-all` / `--ask`, matikan dengan `--sandbox none`, atau pakai `--sandbox docker` |

Docker **tidak** dipakai otomatis meski tersedia — menarik image tanpa diminta terlalu invasif untuk default.

## Update & uninstall

Membuka `minicode` interaktif (TTY) selalu cek versi terbaru ke registry:
bila ada versi lebih baru, Minicode memperbarui instalasi global memakai **Bun**
(`bun update -g minicode-ai --latest --ignore-scripts`, otomatis fallback ke
`bun add -g minicode-ai@latest --ignore-scripts` bila `minicode-ai` belum
tercatat di `bun.lock` global), membaca ulang versi terpasang lewat
`bun pm ls -g`, lalu restart sendiri (`MINICODE_AUTO_UPDATE_DONE=1`). Bila
verifikasi versi gagal, Minicode mencoba memulihkan versi sebelumnya via
`bun add -g minicode-ai@<versi> --ignore-scripts --exact`; bila pemulihan gagal,
proses berhenti agar tidak berjalan dengan instalasi campuran. Berlaku hanya
untuk salinan ter-install (checkout source / `bun link` tidak disentuh).

Sejak v0.41, kegagalan install menyebut **langkah & alasan** yang sudah
diredaksi (sekuens ANSI, token/kredensial, dan URL berkredensial dibuang; satu
baris ≤300 char). **Batas redaksi hanya tiga kategori itu plus panjang/baris**
— bukan pembersih rahasia umum. Runner mengeksekusi biner `bun` langsung tanpa
shell dengan timeout 60 dtk dan tidak pernah menjalankan `npm`.

Di TUI interaktif, slash command `/update` menjalankan pembaruan yang sama lewat
handoff terminal aman: alt-screen dilepas → update via `bun` → spawn restart
dengan `MINICODE_AUTO_UPDATE_DONE=1` → exit. Bila sudah latest, opt-out, atau
gagal, terminal di-reacquire dan hasilnya ditampilkan. Perintah ini **hanya ada
di TUI**; jalur one-shot, `exec`, pipe, dan ACP fail-closed — menjawab "not
available" dan tidak pernah spawn updater dari pipe/CI.

Update manual (selalu gunakan `--latest` atau `@latest` karena range `^0.x.y`
pada `bun.lock` global menahan minor bump `0.x`):

```bash
bun update -g minicode-ai --latest   # atau: bun update -g minicode-ai@latest
# bila belum tercatat di bun.lock global: bun add -g minicode-ai@latest
minicode sync          # refresh model baru dari semua provider
minicode pricing sync  # refresh cache harga dari models.dev
```

Opt-out: `NO_UPDATE_CHECK=1`, `MINICODE_AUTO_UPDATE=0|false|off`, atau `CI=1`.
Guard internal `MINICODE_AUTO_UPDATE_DONE=1` menandai restart hasil update agar
tak memicu pengecekan/install berulang.

Clone contributor: `cd minicode && git pull && bun install`.

Uninstall = `bun remove -g minicode-ai` (atau hapus clone + `bun unlink` bila memakai link). Config global tetap di `~/.minicode/` sampai kamu hapus manual; config lokal di `.minicode/` per repo. Uninstall tidak pernah menghapus state, sesi, memori, atau file proyekmu.

## Lokasi data

- Config global `~/.minicode/config.json` + lokal `.minicode/config.json` (merge, lokal menang, tulis atomik + chmod 600).
- Token OAuth di `~/.minicode/auth.json` (chmod 600) — **bukan** di `config.json`, karena config lokal sering ikut ter-commit.
- Sessions `.minicode/sessions.db` (WAL), vector memory `vector.db`, repo-map `.minicode/repomap.json`, traces `.minicode/traces.jsonl`, checkpoint `.minicode/checkpoints/`, trash `.minicode/.trash/`.
- Override home untuk DB dengan `MINICODE_HOME` (berguna agar test hermetic di POSIX).

## Berikutnya

- [Troubleshooting](troubleshooting.md) — bila `doctor` merah atau sandbox tidak jalan.
