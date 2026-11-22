# `.audit/` — wadah artefak audit

Folder ini berisi catatan audit dan rencana kerja. Tidak termasuk `files[]` paket npm, jadi tidak ikut tarball.

## Indeks (setelah evaluasi 2026-11-22)

| Berkas | Isi | Status |
|---|---|---|
| [`FINAL-STATE.md`](FINAL-STATE.md) | **Mulai dari sini.** Evaluasi semua artefak lama, temuan yang masih relevan (F-1…F-11), dan Todo perbaikannya | aktif |
| [`NO-SIDEBAR-CENTERED-PLAN.md`](NO-SIDEBAR-CENTERED-PLAN.md) | Rencana eksekusi v0.34: hapus sidebar, chat kolom tengah maksimal 50% | aktif (sudah dieksekusi; catatan kandidat) |
| [`2026-11-21-audit-kode-working-tree.md`](2026-11-21-audit-kode-working-tree.md) | Bukti kode untuk temuan E-23/E-9/E-27/E-11/E-20/E-19 yang masih terbuka | aktif (sumber bukti) |
| [`2026-11-22-audit-performa.md`](2026-11-22-audit-performa.md) | Audit performa read-only: temuan F-01…F-09 (deep snapshot `session.state`, estimasi token berulang, IO per step, persistensi, render, gap bench) + guard yang harus dijaga | aktif (analisis kode; belum ada angka runtime baru) |
| [`AUDIT-CONSOLIDATED.md`](AUDIT-CONSOLIDATED.md) | Arsip besar pra-v0.34. Bagian 9–14, 22, 26–27, 30 **sudah superseded** oleh penghapusan sidebar | arsip, jangan dipakai sebagai status |

## Yang sudah dibersihkan

Artefak berikut dihapus karena tidak relevan setelah v0.34 atau sudah terwakili di `FINAL-STATE.md`:
`2026-11-21-audit-ui.md`, `2026-11-21-audit-kode-bugkritik.md`, `2026-11-21-audit-ux.md`,
`WORK-CONTEXT-PLAN.md`, `SIDEBAR-CRITIQUE.md`, `temuan.md`, `AUDIT-ROUND2.md`,
`code-audit-e6e50a7.md`, `audit-remediation-plan.md`, `OBSERVATION.md`, dan 4 probe yang
mengimpor modul sidebar yang sudah dihapus.

## Batas klaim

- HEAD checkout `643f4b3`; working tree termodifikasi (belum di-commit).
- Angka gate v0.33.0 di arsip bersifat **historis**, bukan hasil kandidat v0.34.
- `ROADMAP.md` tidak ada di checkout ini — status roadmap tidak dinyatakan di sini.
- `gate:fast` kandidat v0.34 sedang dijalankan; hasilnya belum saya klaim.
