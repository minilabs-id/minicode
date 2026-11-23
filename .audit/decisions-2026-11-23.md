# Keputusan owner — 2026-11-23

Checkpoint: HEAD `42a35a6` (garis rilis v0.43). Working tree saat pencatatan:
kandidat rilis 0.43.2 belum di-commit (rilis ditahan owner).

**Catatan keputusan, BUKAN klaim gate hijau.** Dokumen ini merekam keputusan
owner yang sebelumnya hanya hidup di komentar kode. Gate/rilis ditahan owner
sampai seluruh tugas bersih dan semua gate lolos pada satu kandidat final yang
sama. Lihat `AGENTS.md` untuk urutan gate; jangan turunkan ambang untuk membuat
hasil terlihat hijau.

## 1. Penulisan `.minicode/**`

- Agen/model **boleh menulis** `.minicode/**` lewat file tool **maupun shell**
  (redirection).Runtime-owned state (DB, todos, plans, checkpoints, jurnal,
  traces, allowlist, config) tidak lagi dikunci tulis; `isOwnedState()`/
  `isOwnedStateReal()` dipakai untuk deteksi/filtrasi, bukan sebagai write lock.
- **Kecuali:** `.minicode/hooks/**` dan file sensitif `.env` / `auth.json` /
  kredensial daemon — tetap deny (path jail + aturan file sensitif berlaku,
  bahkan di `--allow-all`).
- **Alasan:** mendukung workflow skill lokal dan eksperimen. Hook tetap dikunci
  karena dieksekusi otomatis (auto-executed) lewat scan direktori saat
  `MINICODE_HOOKS=1`.

## 2. Risiko yang diterima — guard hook bukan boundary

- Kunci tulis hook di permission layer **bukan boundary keamanan** terhadap kode
  yang dijalankan agen. Contoh: `node script.js` dapat menulis ke
  `.minicode/hooks/` lewat `fs` langsung, melewati file-tool guard.
- `MINICODE_HOOKS=1` tetap keputusan operator sadar yang menyetujui risiko ini.
- Status: risiko diterima owner — ini bukan jaminan isolasi.

## 3. Allowlist browser (`agent-browser` via bash)

- `eval` **diizinkan** — Chrome fresh tanpa profil, sehingga cookie aman.
- `mcp` **fallback** diizinkan.
- `install` **butuh konfirmasi ASK** (mengunduh Chrome for Testing ratusan MB).
- `--auto-connect` **dicabut** — tidak dipakai; browser selalu fresh / profil
  dari setingan `.minicode`.
- Subcommand sempit lain: `open`, `snapshot`, `click`, `fill`, `errors`,
  `console`, `network`, `get`, `close`, `skills get core`, `--version`.
  Pola `npx *` mencakup semua bentuk npx, termasuk `npx agent-browser ...`.

## 4. Anggaran sub-agent

- Pool concurrency: **3 → 5** (`MINICODE_SUB_AGENT_POOL_SIZE`, 1..16).
- Cap `maxSteps`: **50 → 100 → 600**; budget per `scope` **16/24/40/64**
  (`plan` ×1,5, di-clamp ke `[8,600]`).
- Timeout default: **300 s → 600 s → 1 jam** (`MINICODE_SUB_AGENT_TIMEOUT_MS`
  = 3.600.000 ms).
- Watchdog idle **120 dtk tetap** menjadi pengaman — pagu panjang hanya
  membantu anak sehat yang lambat, bukan mengizinkan anak diam selamanya.

## 5. Status

Gate/rilis **ditahan owner** sampai seluruh tugas bersih. Dokumen ini adalah
catatan keputusan, bukan klaim gate hijau. Angka gate historis harus disebut
checkpoint-nya, bukan dijadikan hasil checkout berikutnya.
