# .audit

Direktori ini menyimpan arsip audit dan keputusan historis yang masih dirujuk oleh [CHANGELOG.md](../CHANGELOG.md), [docs/security.md](../docs/security.md), atau [docs/TERMINAL_CONTRACT.md](../docs/TERMINAL_CONTRACT.md), sengaja dipisahkan dari `docs/` agar tidak ikut masuk ke paket npm.

Berkas yang dipertahankan:

- `decisions-2026-11-23.md` — keputusan operator/pemilik terkait trust model `.minicode/` vs `.minicode/hooks/**` dan kebijakan browser.
- `2026-11-24-audit-hardening.md` — catatan audit hardening P0–P3.
- `2026-11-26-audit-stabilitas-performa-hang.md` — catatan audit stabilitas, anti-hang, deadlock, dan anti-ReDoS.
- `QR-REMEDIATION-PLAN.md` — arsip rencana remediasi kualitas.
- `FINAL-STATE.md` — catatan kondisi dan hasil gate historis kandidat sebelumnya (bukan hasil checkout berikutnya).
- `TERMINAL_CONTRACT_ARCHIVE.md` — arsip entri kontrak terminal v0.42–v0.34 dan v7.x.
