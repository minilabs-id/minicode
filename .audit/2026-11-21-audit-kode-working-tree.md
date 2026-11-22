# Audit kode — working tree minicode (remediasi E-1…E-29)

- **Tanggal:** 2026-11-21
- **HEAD:** `643f4b3` (garis rilis v0.33.0)
- **Status tree:** SEDANG DIMODIFIKASI (≥64 file belum di-commit: remediasi temuan audit E-* + ekstraksi `HELP` ke `cli/help.ts`)
- **Sifat audit:** statis (baca kode/dokumen/test). **Gate tidak dijalankan.** Tidak ada file sumber yang diubah.
- **Batasan proses:**
  - `git diff` terpotong (≥160k karakter tidak tampil) → daftar file tidak dapat dienumerasi penuh.
  - 3 sub-agent (daemon/IPC, runtime/perf, drift dokumen) timeout tanpa laporan → audit dikerjakan manual per-area.
- **Klaim hasil:** laporan ini TIDAK menyatakan repo hijau/release-ready. Yang diverifikasi hanya butir yang disebut eksplisit di bawah.

## Ringkasan peringkat

| # | Sev | Area | Temuan |
|---|---|---|---|
| 1 | tinggi | E-23 memory/vector | DB bisa berhenti "setengah migrasi" permanen |
| 2 | tinggi | E-9 sandbox | Masking `.env*` bisa diam-diam bolong |
| 3 | tinggi | E-27 shadow-git | Cache neutralizer filter tidak melihat config global |
| 4 | sedang | E-11 session | Dirty-flag otorisasi hanya cek panjang array |
| 5 | sedang | E-20 daemon | Salinan bootstrap secret di `.tmp` tak di-harden & tak dibersihkan |
| 6 | sedang | E-19 telemetry | Rotasi bisa menghilangkan baris; chmod sekali-gagal permanen |
| 7 | sedang | dokumen | AGENTS.md salah menunjuk I36/I37 untuk sidebar |
| 8 | sedang | dokumen | `docs/TERMINAL_CONTRACT.md` mencantumkan test yang tidak ada |
| 9 | sedang | test | Penjaga perf berbasis pemindaian teks sumber |

---

## 1. E-23 — DB vector bisa berhenti "setengah migrasi" secara permanen (TINGGI)

`src/memory/vector.ts:239-311`

Seluruh blok `ALTER TABLE` / `CREATE INDEX` berada di dalam `try { … } catch {}` (239→285), lalu
`PRAGMA user_version=1` dieksekusi tanpa syarat (`:309`). Konsekuensi: satu ALTER gagal
(`SQLITE_BUSY`, kolom tak terduga pada DB lama) → error ditelan, versi dinaikkan, dan open
berikutnya **tidak pernah** mengulang migrasi. Bandingkan perilaku lama (DDL tiap open) yang
memperbaiki diri sendiri pada percobaan berikut.

Test `test/memory-vector-ddl.test.ts` hanya menguji jalur sukses (semua ALTER berhasil), jadi
regresi ini tidak tertangkap.

**Saran:** naikkan `user_version` hanya setelah semua kolom terverifikasi ada (atau jangan telan
error ALTER), plus test injeksi kegagalan di tengah migrasi.

## 2. E-9 — masking sandbox bisa diam-diam kehilangan `.env*` (TINGGI)

`src/sandbox/mask.ts:70-86`

Pemindaian kini mempercayai `Dirent.isFile()` / `Dirent.isSymbolicLink()` dan hanya menambahkan
entri dengan tipe tersebut. Pada filesystem yang mengembalikan `DT_UNKNOWN` (sebagian FUSE/SMB/NFS,
mount jaringan Windows), kedua predikat bernilai false → `.env` **tidak masuk daftar mask** → file
tetap ter-mount ke container/sandbox. Jalur `lstat` lama benar untuk kasus ini.

Test `test/sandbox.test.ts:108-146` hanya menguji filesystem lokal, jadi hijau tanpa menutup kasus.

**Saran:** fallback `lstatSync` khusus entri bertipe tidak diketahui; tambah test dengan seam
`readdir` yang mengembalikan Dirent bertipe UNKNOWN.

## 3. E-27 — cache neutralizer filter git tidak melihat config global (TINGGI)

`src/session/shadow-git.ts:69-81, 175-182`; `src/lib/git-hardening.ts:118-131`

Komentar `gitConfigStamp()` menyatakan mencakup "config lokal `.git/config` + global `~/.gitconfig`",
tetapi implementasinya hanya membaca `<cwd>/.git/config` dan `<cwd>/.git`. Sementara
`discoverFilterDrivers()` memakai `git config`, yang ikut membaca config global/system.

Akibat: filter driver yang ditambahkan ke `~/.gitconfig` setelah cache hangat **tidak
dinetralkan** (`filter.<d>.clean/process`) selama proses hidup — persis jalur eksekusi yang ditutup
Audit #10 (`git add` / `write-tree` menjalankan clean filter repo/global).

**Saran:** sertakan stamp `~/.gitconfig` (dan `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`), atau buang
cache neutralizer dan cache hanya hasil `rev-parse --absolute-git-dir`.

---

## 4. E-11 — dirty-flag otorisasi hanya membandingkan panjang array (SEDANG)

`src/app/session.ts:87-99`

```ts
if ((tools?.length ?? 0) !== authorized.size) refresh()
```

Perubahan isi dengan panjang sama tidak terdeteksi. Saat ini aman karena `setMode` dan
`setWorkMode` memanggil `authorized.refresh()` (`session.ts:894`, `:917`), tetapi ketergantungan itu
implisit. Jalur yang menukar tool in-place dengan jumlah sama (mis. rediscovery MCP yang mengganti
tool, atau filter mode dengan set berbeda-tapi-sepanjang) akan meninggalkan set otorisasi basi —
dan basi ke arah permisif mengotorisasi tool yang tak lagi terlihat.

**Saran:** tambahkan versi revisi di tool-layer (naikkan pada `syncVisible`), atau bandingkan
identitas elemen (mis. `tools[0]`/stempel) — bukan hanya `length`.

## 5. E-20 — salinan bootstrap secret di `.tmp` tidak di-harden & tidak dibersihkan (SEDANG)

`src/daemon/discovery.ts:120-125`

`writeFileSync(tmp, …)` menulis endpoint (berisi `bootstrap` secret) sebelum `renameSync`. File tmp
tidak pernah melewati `hardenAcl` dan memakai ACL warisan direktori. Jika proses crash di jendela
itu, `daemon-endpoint.json.<pid>.tmp` tertinggal permanen — duplikat secret dengan izin lebih
longgar, tanpa pembersihan.

`docs/security.md:96-97` sudah mendokumentasikan residual `icacls` (multi-user Windows) tetapi
belum residual `.tmp` ini.

**Saran:** buat tmp lebih dulu lalu harden ACL-nya sebelum menulis isi, dan sapu `.tmp` basi saat
start.

## 6. E-19 — rotasi telemetry kehilangan baris & chmod permanen (SEDANG, observability)

`src/telemetry/trace.ts:203-208, 227-241`

- `rotateFile` adalah read-modify-write (`readFile` → `atomicWriteText`) sementara `appendFile` lain
  berjalan; baris yang mendarat di antaranya hilang.
- `ensureChmodOnce` menandai path "selesai" **sebelum** `chmod` selesai → satu kegagalan transien
  membuat berkas tetap 0644 sepanjang proses.

Dampak: kehilangan observability, bukan kebocoran.

## 7. Drift dokumen — AGENTS.md salah menunjuk invarian sidebar (SEDANG)

`AGENTS.md:129-132` menyebut "Rincian invariant di `docs/TERMINAL_CONTRACT.md` (I36/I37)". Faktanya:

- I36 = output command readout overlay (`docs/TERMINAL_CONTRACT.md:1592`, v7.18)
- I37 = agent control system / peringatan `[recovery]` (`:1605`, v7.22.1)

Aturan sidebar hanya prosa (`:1091`) + amendemen v0.33 (`:1391`, `:1429`), **tanpa nomor
invarian** (tidak ada I38+). Rujukan "I36/I37" akan menyesatkan pembaca ke kontrak yang salah.

## 8. Drift dokumen — test yang tidak ada (SEDANG)

`docs/TERMINAL_CONTRACT.md:72` mencantumkan `test/retry-visibility.test.ts`. File itu tidak ada;
nama sebenarnya `test/audit-fix-retry-visibility.test.ts` (sudah tercantum di `:75`).

Nama lain pada peta proteksi sidebar terverifikasi ada: `test/sidebar-model.test.ts`,
`test/sidebar-invariants.test.ts`, `test/sidebar-width.test.ts`, `test/perf-no-quadratic.test.ts`,
`test/transcript-incremental.test.ts`, `test/tui-scroll-width.test.ts`.

## 9. Kualitas test perf lemah (SEDANG)

`test/perf-no-quadratic.test.ts`

Empat dari lima test memindai **teks sumber** (`toContain("thinkingCache")`, regex pada source).
Assertion jenis ini lulus/gagal karena rename, bukan karena perilaku. Hanya test
`projectionRebuilds` (baris 59-74) yang benar-benar mengukur. Cache sidebar
(key `rev:width`, cap 3 di `src/ui/render/sidebar-model.ts:66-80`) belum punya test perilaku.

---

## Nits

- `cli/help.ts:50` menulis `0 = off`; `buildHelpJson` (`:122`) menulis `0 = Infinity`. Keduanya
  juga tidak menyebut default jalur `exec` (15 menit). Catatan: `docs/exec.md:97` **benar** —
  default 900000 hanya untuk `exec` (`cli/commands/exec.ts:144`), bukan drift.
- `BoundedQueue.shift` (`src/daemon/subscription.ts:60-63`): cabang `#head === #items.length`
  praktis mati (kompaksi `head*2 > max` sudah jalan lebih dulu untuk `max>=1`); tidak ada test
  push/shift berselang-seling panjang yang menguji jalur `slice` kompaksi.
- `hardenAcl` (`src/daemon/discovery.ts:97-108`) no-op senyap bila `USERNAME` kosong atau
  `icacls` tak tersedia → tidak ada sinyal ke operator.

## Terverifikasi bersih (bukan asumsi)

- **Tidak ada pelemahan gate:** coverage min 87 funcs / 86 lines (`scripts/coverage-gate.ts:101-102`),
  budget pack 5000 KiB (`scripts/pack-budget.ts:179`) — cocok dengan AGENTS.md.
- **E-1/BUG-2:** `HELP`/`readVersion`/`buildHelpJson` satu sumber di `cli/help.ts`; entry tipis
  `cli/entry.ts` hanya mengimpor modul itu; parity diuji dengan spawn kedua entry termasuk
  `minicode <subcmd> --help` (`test/cli-entry.test.ts`); default `--max-steps` kini dari
  `LIMITS.DEFAULT_MAX_STEPS` (200), bukan angka 50 yang salah.
- **Auto-update REPL tidak hilang** oleh ekstraksi help: masih dijalankan setelah
  `createCliSession` dan sebelum `runTui` (`cli/index.ts:507-549`).
- **E-28/E-29:** satu `Buffer.concat` tepat saat frame lengkap (`src/daemon/framing.ts:44-120`),
  `shift` O(1) (`src/daemon/subscription.ts:49-65`), LSP dibatasi 8 MiB payload / 16 KiB header
  (`src/lsp/client.ts:80-143`); test menutup frame 8 MiB dari chunk 64 KiB dan header raksasa.
- **E-26:** cek jail/sensitive/owned-state **sebelum** `ls-tree` batch, `change.from` ikut
  divalidasi, mode entri tak didukung → throw (fail-closed) (`src/session/shadow-git.ts:364-400`).
- **E-24:** satu `persist()` per discover, verdict per tool, drift tetap menonaktifkan tool
  (fail-closed) (`src/mcp/client.ts:626-649`).
- **E-10/E-3/E-12:** env hook disanitasi sekali & eksekusi hook tetap serial
  (`src/hooks/run.ts:88-107`); runner secret async dengan secret lewat stdin
  (`src/lib/keystore.ts:85-135`); history dispatch cap 32 & store cap 1024 buang-terminal-tertua
  (`src/runtime/dispatch.ts:279-308`), cache recovery LRU+TTL cap 512
  (`src/runtime/recovery.ts:240-272`).

## Belum tercakup

`cli/setup.ts` (sangat besar; hanya spot-check), sisa hunk `src/mcp/client.ts`, `src/hooks/run.ts`,
`docs/concepts.md`, `docs/getting-started.md`, `docs-en/cli.md`, dan seluruh pembuktian dinamis
(`bun x tsc --noEmit`, `bun run lint`, `bun test`, `gate:coverage`, `gate:pack`).
