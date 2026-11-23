# Rencana Remediation Quality Remediation (F-1…F-11)

**Checkpoint:** working tree `0.43.0` belum di-commit, HEAD `bb41a97`.
**Status:** RENCANA — bukan klaim hijau, bukan roadmap master, bukan bagian dari rilis 0.43.0.
**Sumber:** jurnal sesi `bun run dev` (`journal-eed4fc81.jsonl`, `journal-82e0f46e.jsonl`),
verifikasi independen 3 sub-agent (2026-11-23), dan `.audit/FINAL-STATE.md:34-78`.

## Aturan main

1. Namespace ini **terpisah** dari rilis v0.43.0. Tidak ada perbaikan di bawah yang
   boleh disisipkan ke kandidat rilis yang sedang berjalan.
2. Todo di `.audit/FINAL-STATE.md:34-44` masih `[ ]` untuk F-1/F-2/F-3 — artinya belum fixed.
3. Ambang `scripts/coverage-gate.ts` dan budget `scripts/pack-budget.ts` **tidak boleh**
   diturunkan/enaikkan untuk membuat gate hijau.
4. Penutupan track penuh mensyaratkan `bun run gate:fast` hijau pada **satu kandidat final
   yang sama**, ditambah audit:harness & smoke build/package. Labelled stage-scoped tidak
   boleh ditulis sebagai "seluruh repository hijau".
5. Setiap temuan diverifikasi ulang dengan `file:line` sebelum diimplementasi. Temuan
   sub-agent berstatus hipotesis.

## Triage hasil verifikasi

| ID | Keputusan | Severity | Bukti utama |
|---|---|---|---|
| F-1 migrasi vector | **VALID** | high | `src/memory/vector.ts:285` `catch{}` menelan ALTER; `:308-310` `user_version` tanpa post-check `table_info`; `:240` `table_info` hanya sebelum ALTER. DB aktual sehat → **laten**. |
| F-1 test | **VALID gap** | medium | `test/memory-vector-ddl.test.ts:43-104` hanya 2 happy-path; tanpa injeksi kegagalan DDL. |
| **BARU** migrasi session DB | **VALID** | **high (tertinggi)** | `src/session/db/schema.ts:29-43,132,332`: tanpa `user_version`; guard cuma 3 penanda; ALTER ditelan `catch{}` (`:176-180,193-197,246-250,327-331`); `migratedSessionPaths.add()` tetap jalan → setengah jalan permanen, tak bisa retry. |
| F-2 mask `.env*` | **PERLU NUANSA** | rendah–sedang | `src/sandbox/mask.ts:83` benar tanpa fallback `lstat`; tapi win32 native tidak menghasilkan `DT_UNKNOWN` (libuv memetakan `dwFileAttributes`), runtime repo = Bun → klaim lintas-platform belum terbukti. Tidak ada seam uji. |
| F-3 shadow-git stamp | **PERLU NUANSA** | rendah | `src/session/shadow-git.ts:70-81` hanya 2 path; komentar `:69` soal global salah. **Premis "config global belum dinetralkan" kedaluwarsa** — `src/lib/git-hardening.ts:67-78` sudah `--local --includes` (commit `50642f8`), dibuktikan `test/audit-fix-filter-scope.test.ts:82-97`. Residual: file `[include]` eksternal & worktree. |
| FTS rebuild parsial | **BARU, VALID** | medium | `src/memory/vector.ts:298-304`: rebuild hanya bila `cnt===0 && total>0`; rebuild tegar → recall keyword kurang permanen. |
| chmod ACL win32 | **BARU, VALID** | medium | `src/memory/vector.ts:69-77`, `src/session/db/schema.ts:19-27`: `chmodSync(0o600)` no-op untuk ACL (kelas sama dgn F-9). |
| revoke asymmetry | **BARU, VALID** | medium/rendah | `src/memory/vector.ts:1507-1510`: `revokeByProvenance({query})` hapus baris vector tapi file tetap di `kept`. |
| access_count / Set / DDL race / konstanta mati | **BARU** | rendah | `vector.ts:1362-1377`, `:19,94,1167`, `src/constants.ts:72`. |

## Kepercayaan audit — kaveat wajib

- `resultSummary` sub-agent dipangkas ~2000 karakter (`truncated:true`, terputus di tengah
  kata). Marker `(line truncated to 2000 chars)` adalah artefak tampilan tool baca, bukan isi file.
- Di `eed4fc81`, 2 delegate **aborted / timeout 180000ms** dengan teks "belum terverifikasi".
  Verifikasi F-4…F-11 tidak pernah selesai → statusnya **tidak final**, bukan "clean".
- Keyakinan tinggi hanya F-1, F-3, dan temuan session DB (≥2 sumber + cocok kode + ledger).

## Stage 1 — Pulihkan kepercayaan audit

**Tujuan:** dapatkan laporan lengkap tanpa pemotongan & tanpa delegate gagal.
- Bagi verifikasi F-4…F-11 menjadi batch kecil (≤3 temuan per sub-agent) supaya ringkasan
  tidak melewati batas ~2000 karakter.
- Ulangi 2 delegate yang gagal dengan timeout lebih besar / scope lebih sempit; simpan
  hasil ke artefak `.audit/` (bukan mengandalkan ringkasan jurnal).
- Keluarkan verdict final per temuan: VALID / PERLU NUANSA / SALAH.
- **Acceptance:** tidak ada lagi finding berstatus "belum terverifikasi"; setiap verdict
  punya `file:line` dan nama file artefak sumber.

## Stage 2 — Migrasi DB (prioritas tertinggi)

**Tujuan:** hilangkan "setengah jalan permanen" di dua DB.
- `src/session/db/schema.ts`: perkenalkan `user_version` atau guard setara; jangan
  `migratedSessionPaths.add()` bila ada ALTER gagal; kumpulkan `ddlError` dan jangan
  tandai migrasi selesai sampai post-check lolos.
- `src/memory/vector.ts:239-311`: jangan telan error ALTER (`:285`); lakukan
  `PRAGMA table_info(memory)` **kedua** di `:306-307` (bukan pakai `cols` stale `:240`);
  tulis `:309` dan `vectorDdlRuns++` (`:311`) hanya setelah post-check lolos.
- Seam uji satu baris (mis. `setVectorDdlFaultForTest(stage)`) untuk injeksi kegagalan.
- Test: legacy DB → gagalkan ALTER ke-3 → `open()` throw / `user_version` tetap 0 →
  hapus fault → open kedua → versi 1 + kolom lengkap + counter benar. Uji juga session DB.
- **Acceptance:** test failure-injection hijau; DB sekarang (`user_version=1`, 17 kolom)
  tidak berubah; tidak ada penurunan ambang.

## Stage 3 — Medium

- FTS rebuild parsial (`vector.ts:298-304`): deteksi ketidaklengkapan, bukan hanya `cnt===0`.
- chmod ACL win32 (`vector.ts:69-77`, `schema.ts:19-27`): pakai `hardenAcl` atau setara,
  atau dokumentasikan keterbatasan win32 secara eksplisit.
- F-3 residual (`shadow-git.ts:72`): stamp juga file `[include]` eksternal & gitdir worktree.
- F-2 (`mask.ts:65-83`): tentukan dulu apakah Bun menghasilkan UNKNOWN; bila ya, tambah
  fallback `lstatSync` + seam uji; bila tidak, tutup sebagai non-issue untuk win32.
- revoke asymmetry (`vector.ts:1507-1510`): samakan jalur vector & file.
- **Acceptance:** test regresi per item; tidak ada perubahan API publik tanpa keperluan.

## Stage 4 — Rendah & penutupan

- `access_count` busy-retry, Set tak terikat, DDL race dua proses, `MEMORY_FILE_MAX_CHARS` mati.
- Perbarui `.audit/FINAL-STATE.md` dari `[ ]` ke `[x]` **hanya** untuk item yang benar-benar
  diuji, dengan checkpoint & angka gate pada kandidat yang sama.
- **Acceptance akhir:** `bun run gate:fast` hijau + `audit:harness` + smoke build/package.
  Belum boleh diklaim release-ready sebelum itu.

## Daftar eksplisit: TIDAK masuk v0.43.0

Seluruh Stage 1–4 di atas. v0.43.0 hanya berisi perbaikan render/UX yang sudah dikerjakan
(rekap, caret, ratchet live-tail, composer stabil, error ringkas, allowlist, `/copy` render).
Gate v0.43.0 dijalankan terpisah setelah perbaikan render selesai, bukan setelah track ini.
