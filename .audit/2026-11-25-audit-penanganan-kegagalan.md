# Audit penanganan kegagalan — error, command, sub-agent, dan jalur lain (2026-11-25)

- **Checkout:** HEAD `7c425a8` (`0.50.0` + perbaikan CI Windows). Working tree **tidak bersih** (banyak file termodifikasi dari sesi sebelumnya); ini audit **working tree**, bukan rilis bersih.
- **Sifat:** read-only. Tidak ada kode/test yang diubah oleh audit ini. Gate penuh **tidak** dijalankan sesuai `AGENTS.md`.
- **Metode:** inspeksi kode langsung, repro formatter via `bun -e`, dan test terarah:
  `bun test test/acp.test.ts test/errors-usage.test.ts test/audit-fix-tool-errors.test.ts test/error-render-suppression.test.ts --timeout 15000`
  → **82 pass / 0 fail** (320 expect).
- **Batas klaim:** angka/perilaku di bawah terverifikasi untuk checkout ini. Temuan yang hanya berupa penalaran statis ditandai **medium/low** atau **hipotesis**. Ini **bukan** klaim repo hijau.
- **Dokumen terkait:** `.audit/AUDIT-CONSOLIDATED.md`, `.audit/2026-11-24-audit-working-tree.md`, `.audit/2026-11-25-riset-arsitektur-kegagalan-sesi.md`, `.audit/2026-11-25-audit-ux-kenyamanan.md`.

---

## 0. Ringkasan

Yang paling mengganggu dari audit ini bukan "error bocor", melainkan **error salah diklasifikasi** dan **kegagalan ditelan di jalur success-shaped**:

1. `friendlyError("writer admission refused: …")` dilaporkan sebagai **masalah jaringan** (`/\brefused\b/` terlalu longgar). Repro langsung di bawah.
2. `exec --json`/ACP sudah memakai formatter mesin, tetapi **trace one-shot menyimpan narasi generik** (`formatError`) sehingga error asli hilang dari diagnostik.
3. `delegate_task` mengembalikan ringkasan error sebagai **string sukses**; presenter menyelamatkan tampilan lewat deteksi awalan, tetapi kernel tetap mencatat `isError:false`.
4. `code_run`/`bash` memakai dua kontrak abort yang berbeda (OS reject vs Docker resolve) dan `git` abort hanya membunuh proses utama.
5. Cooldown provider dan riwayat adaptif sub-agent bersifat **global proses**, bukan per provider/sesi/workspace.
6. Deteksi `exit N` untuk kegagalan shell/git dipakai pada **semua** tool: berkas yang baris pertamanya `exit 1` ditandai gagal.

Yang **sudah membaik** dibanding audit lama: ACP memakai `formatMachineError`, ledger retry memperbarui `meta.status`, setup memakai `WRITE_TOOLS` kanonik, Run sub-agent error kini `FAILED` (bukan `COMPLETED`), baseline tamper gagal → `GIT_FAILED` + peringatan, dan suite error/ACP hijau.

---

## A. Klasifikasi & redaksi error

### ERR-1 — HIGH (terverifikasi, ada repro) — `refused` salah masuk kategori network

`src/ui/render/errors.ts:308` memasukkan `/\brefused\b/` ke cabang network **sebelum** cabang permission/config (`errors.ts:330-360`). Akibatnya setiap pesan dengan kata "refused" dianggap gangguan koneksi.

Repro (`bun -e`):
```
"writer admission refused: lease held" => {"message":"Failed to reach provider","fix":"Check your connection and try again."}
"service unavailable"                  => {"message":"Provider is temporarily unavailable", ...}
"permission denied"                    => {"message":"Access denied", ...}   // benar
```

Contoh nyata: `src/tools/task.ts` melempar `REFUSED_VERIFICATION_EVIDENCE`, `cli/setup.ts` `REFUSED_LEASE_HELD`/`REFUSED_CHILD_SESSION_PERSISTENCE`, `cli/commands/openwork.ts` `export refused`. Semua bisa tampil sebagai "Failed to reach provider" di TUI/one-shot.

**Perbaikan:** hapus `/\brefused\b/` generik; pakai pola network spesifik (`connection refused`, `econnrefused`, `fetch failed`, `socket hang up`). Tambahkan cabang `refused` ke permission/config bila memang dimaksudkan.

### ERR-2 — MEDIUM (terverifikasi) — trace kehilangan error asli

`cli/index.ts:707` menulis `error: formatError(e)` ke trace. `formatError()` (`errors.ts:566-585`) mengganti error tak-terklasifikasi dengan `err.unknown` + `--verbose`. `src/telemetry/trace.ts:252-255` hanya melakukan `scrubSecrets`, jadi narasi generik itulah yang tersimpan.

Repro:
```
formatError(new Error("boom"))      => "An unexpected problem occurred\n  → Try again, or run with --verbose ..."
formatMachineError(new Error("boom")) => "boom"
```

Dampak: post-mortem lewat `traces.jsonl` tak punya sebab nyata untuk error internal (mis. `REFUSED_*`, `TypeError`, kegagalan setup). **Perbaikan:** pakai `formatMachineError(e)` atau `e instanceof Error ? e.message : String(e)` (tetap lewat `scrubSecrets` di `writeTrace`), bukan formatter human.

### ERR-3 — MEDIUM (terverifikasi) — `friendlyToolErrorCanonical` over-match `unavailable`

`errors.ts:451-459` mencocokkan `/\bunavailable\b/` untuk `msg.notConfigured`. Repro:
```
"service unavailable"                 => "Dependency not configured · check setup"
"MCP server temporarily unavailable"  => "Dependency not configured · check setup"
```
Padahal `tSystem("err.server")` sudah tersedia untuk "serverdaan gangguan". **Perbaikan:** pisahkan `server (temporarily) unavailable` → `msg.requestFailed`/server, dan cadangkan `notConfigured` untuk `not configured` / `no provider` / `requires MINICODE_SANDBOX`.

### ERR-4 — MEDIUM (terverifikasi secara statis) — narasi error UI mengabaikan `/lang`

`src/ui/render/errors.ts:11,151-210,379-395` memakai `tSystem()` (locale OS, lihat `src/ui/render/tool-label.ts:39-60`) untuk **seluruh** pesan provider/agent, bukan `t()` (`src/ui/i18n/locale.ts:52-62`). `docs/TERMINAL_CONTRACT.md:38-40,71` membatasi `tSystem()`kwitansi/tool dan menyatakan narasi mengikuti `/lang`. Test `errors-usage.test.ts` justru mengunci perilaku lama ("redaksi id memakai locale OS, bukan /lang").

Dampak: `/lang en` pada OS berbahasa Indonesia tetap menampilkan "Kuota habis…", dan sebaliknya. **Perbaikan butuh keputusan owner** (perubahan kontrak + test), bukan tuning sepihak.

### ERR-5 — LOW (terverifikasi) — drift jumlah pola kanonik

Kode memakai **21 pola** (6 presedensi + 15, `errors.ts:494,527`), tetapi komentar masih menulis 13 (`errors.ts:410`, `src/ui/tui/transcript.ts:2578,2597`) dan `docs/TERMINAL_CONTRACT.md:154-155,242,245` masih "13 pola" (baris 38 sudah 21). Juga komentar di `src/tools/task.ts:1552-1557` masih berkata "`error` tetap COMPLETED seperti dulu", padahal kode `:1572-1575` sekarang memanggil `failRun`. **Perbaikan:** sinkronkan komentar/dokumen; tidak ada perubahan perilaku.

---

## B. Kegagalan tool / command

### CMD-1 — MEDIUM (terverifikasi) — `exit N` dari konten tool apa pun dianggap kegagalan

`src/presentation/adapter.ts:247-254` mendeteksi kegagalan shell dengan regex:
```
/^exit (?:[1-9]\d*|null|unknown)\b/  atau  /^\[TOOL_OUTCOME[^\]]*state=UNKNOWN\b/
```
Fungsi ini dipakai di `:1092-1095` untuk **semua** tool, bukan hanya `bash`/`git_*`/`code_run`. Karena `bash` mengembalikan stdout mentah saat `code===0` (`src/tools/bash.ts:588-590`), perintah `echo "exit 1"` atau `read_file` pada berkas yang baris pertamanya `exit 1` ikut berstatus `tool.failed` dan ledger menampilkan "Command failed" palsu. Negative exit (`exit -2`) juga tidak terdeteksi.

**Perbaikan:** batasi deteksi ke `call.name` family shell/git, atau tambahkan penanda struktural internal (mis. prefix biner/kunci) alih-alih menebak dari teks keluaran.

### CMD-2 — MEDIUM (terverifikasi) — abort `git` tidak tree-kill

`src/tools/git.ts:81-96` (`onAbort = () => p.kill("SIGTERM")`) hanya membunuh `git.exe`. `bash.ts` sudah memakai `killTree()` untuk foreground dan background; `git push` yang memanggil `ssh`/credential helper bisa menyisahkan cucu yang menahan pipe/lease pada Windows. **Perbaikan:** pakai `killProcessTree(p, { env: sanitizeSpawnEnv(process.env) })`, samakan dengan `bash.ts`.

### CMD-3 — MEDIUM (terverifikasi secara statis) — `spawnSync` git tetap mem-blok path async & tanpa sanitize env

- `src/session/verification.ts:1903-1913` `gitBaselineContent()` → `spawnSync` per berkas (`HEAD:<rel>`) dipanggil di `:1959` dan `:1980`. Satu turn yang menyentuh 20–30 berkas test = puluhan spawn berurutan. Tidak ada `env:` sama sekali (berbeda dengan `runGit()` di `src/tools/git.ts`), sehingga seluruh env proses — termasuk secret — diwariskan.
- `src/session/verification.ts:1720-1740` `listDirtyEvaluationPathsResult()` → `spawnSync git status --porcelain --untracked-files=all`, timeout 10 dtk, dipanggil dari startup `cli/setup.ts:2723`.
- `src/session/checkpoint.ts:310-320` `spawnSync git status` (timeout 2 dtk) di dalam fungsi `async`.

Dampak: event loop TUI membeku saat completion `todo_write`/checkpoint; satu git timeout menahan startup. **Perbaikan:** `git cat-file --batch` sekali untuk baseline, async `execFile` dengan konkurensi terikat, `env: sanitizeSpawnEnv(process.env)`, dan helper async yang sudah ada di `src/session/shadow-git.ts`.

### CMD-4 — MEDIUM (terverifikasi) — pencarian menyembunyikan error baca

- `src/tools/context.ts:130` `readdir(opts.dir).catch(() => [])` — direktori tak terbaca dilewati tanpa jejak.
- `src/tools/grep.ts:294,331` `safeReadFile(...).catch(() => null) ?? ""` — berkas tak terbaca dibaca sebagai string kosong.

Hasil `glob`/`grep` tampil "lengkap" padahal sebagian workspace gagal dibaca. Untuk audit/koreksi ini berbahaya: model mengira tidak ada temuan. **Perbaikan:** kumpulkan `skipped[]` dan sertakan ringkasan (`N path skipped: permission denied`) di hasil tool; setidaknya stderr diagnostik sekali per panggilan.

### CMD-5 — LOW (terverifikasi) — kontrak abort OS vs Docker tidak konsisten

`src/sandbox/os.ts:187` `return Promise.reject(opts.signal.reason)` (bisa `undefined`) dan `:285,292` `reject(signal?.reason)`; `src/sandbox/docker.ts:183-185` malah `Promise.resolve({ code: null, output: "[docker] aborted before container start" })`. Pemanggil `bash.ts:430`/`code_run.ts:99` menyelamatkan dengan `ctx.signal.throwIfAborted()`, tetapi pemanggil langsung backend menerima dua bentuk berbeda (throw vs hasil sukses). **Perbaikan:** samakan bentuk hasil dan gunakan `signal.reason ?? new Error("aborted")`.

### CMD-6 — LOW (terverifikasi) — `TOOL_OUTCOME` lebih awal dari `classifyGenericError`

Pesan timeout bash (`errors.ts:255-258`) mengandung `"Its side effects are UNKNOWN"` dan `reason=TIMEOUT`; `classifyGenericError` sudah menangani `[TOOL_OUTCOME ... reason=TIMEOUT` di `TOOL_ERROR_PATTERNS` (tool error), tetapi `friendlyError()` mengklasifikasi `"timeout"` lebih dulu (`errors.ts:222-224`) → kategori generik "timed out". Konsistensi pesan masih bisa ditingkatkan, namun tidak membahayakan.

---

## C. Sub-agent / delegasi

### SUB-1 — MEDIUM (terverifikasi) — ringkasan error adalah string sukses di kernel

`src/tools/task.ts:1400-1490` menangkap semua kegagalan turn anak dan **mengembalikan** `[sub-agent … error] …` sebagai string; `vendor/minicore/src/core/executor.ts:104-115` hanya menandai `isError:true` bila `execute()` melempar. Presenter menyiasati ini dengan `isSubAgentFailureSummary()` (`src/presentation/adapter.ts:261-268,1094`) sehingga UI/ledger tetap merah. Namun kontrak kernel tetap "sukses": konsumen ToolResult lain (no-progress detector `src/app/session.ts:1297-1313`, automasi eksternal) melihat sukses.

**Perbaikan:** bawa status terminal ke `ToolResult` (mis. `isError:true` + ringkasan yang sama), atau hapus deteksi awalan dan jadikan presenter mengonsumsi field status kanonik. Perlu test kontrak P9.2.1 diperbarui karena byte string sengaja dipertahankan.

### SUB-2 — MEDIUM (terverifikasi) — cooldown provider bersifat global, bukan per provider/model

`src/tools/task.ts:131-133` satu variabel `providerCooldownUntil`; `:652-655` menolak **semua** delegasi selama 60 dtk; `:1456` menyetelnya bila pesan cocok `PROVIDER_OUTAGE_SIGNATURE` (`401`/`429`/`authentication_failed`/…). Tidak ada kunci provider, model, atau sesi; `__resetProviderCooldownForTest()` hanya untuk test (`:117-120`) dan tidak dipanggil oleh `clearSubAgentSessionFactory()` (`:465-480`).

Dampak: 401 dari TipRouter memblokir delegasi yang akan lewat provider lain; sesi/daemon berikutnya dalam proses yang sama mewarisi cooldown. `[sub-agent skipped]` juga dikembalikan sebagai string sukses. **Perbaikan:** `Map<routingKey, expiresAt>` dan kembalikan error/`isError` bila benar-benar ditolak.

### SUB-3 — LOW (terverifikasi) — riwayat adaptif lintas sesi/workspace/provider

`src/tools/task.ts:218-271` `subAgentHistory` adalah `Map` modul, kunci hanya `delegationKey(mode, prompt)` (`:218-240`) — tidak memasukkan `cwd`, provider, model, atau `sessionId`. Dipakai untuk timeout (`:705-716`) dan `maxSteps`/cap (`:750-780`); `priorFailureCount` juga memengaruhi `retryLimitReached` (`:1425-1435`). `clearSubAgentSessionFactory()` hanya dipanggil test (`grep` hanya di `src/tools/task.ts` + test), bukan per sesi produksi.

Dampak: prompt identik di workspace/provider berbeda mewarisi "pengalaman" gagal (timeout dipangkas/cap dinaikkan, retry dianggap habis). **Perbaikan:** kunci `cwd|provider|model|sessionId` atau reset per sesi saat factory dikonfigurasi ulang.

### SUB-4 — LOW (terverifikasi) — bookkeeping kegagalan ditelan

`src/tools/task.ts:1535-1590`: `recordSubAgentHistory` dibungkus `catch {}`, `releaseSessionWriter` `catch {}`, terminalisasi Run `catch {}` dengan catatan sweep saat resume. Ini disengaja fail-soft, tetapi bila sweep tidak jalan (proses daemon tidak di-resume dengan benar) residu `RUNNING` tanpa diagnostik. Minimal satu baris stderr terredaksi per kegagalan terminalisasi.

### SUB-5 — INFO (sudah membaik, verifikasi ulang)

Tidak seperti laporan lama (`.audit/2026-11-25-riset-arsitektur-kegagalan-sesi.md` §5), `src/tools/task.ts:1572-1575` sekarang memanggil `failRun()` untuk `childStatus === "error"`; test `test/p92-child-result-envelope.test.ts:304-338` mengunci Run `FAILED`. Baseline tamper gagal juga sudah `GIT_FAILED` + peringatan (`verification.ts:1782-1788`, `cli/setup.ts:2723-2728`).

---

## D. Persistence, ACP, dan degradasi senyap

### INFRA-1 — MEDIUM (terverifikasi) — ACP membalas `ok:true` walau persist gagal

`cli/commands/acp.ts:503-525` membungkus `persistCurrent()` + pengecekan `isWriterStale()` dalam satu `try { … } catch {}` sebelum `ctx.close()`. Bila `persistCurrent` melempar (disk penuh, DB locked, epoch conflict), tidak ada `writeStderrLine`, tidak ada penanda di envelope, dan klien sudah menerima `acpOk` di `:480-499`. Kontras dengan `cli/commands/exec.ts:331-340` dan `cli/index.ts:639-643` yang menjadikan WriterStale menjadi kegagalan exit 1. **Perbaikan:** pisahkan `catch` untuk `persist` dari `isWriterStale`; kirim `[writer] …` ke stderr dan/atau response `error` sesuai kontrak "satu envelope terminal".

### INFRA-2 — MEDIUM (terverifikasi) — cleanup `deleteSession` best-effort tanpa jejak

`src/session/persistence.ts:3376-3425`: hapus jurnal, checkpoint, ref shadow-git, baris trace, dan todo file semuanya `try { … } catch {}`. Komentar menyebut "best-effort", tetapi dari sudut operasional: user yang menjalankan `/delete` yakin data hilang, padahal prompt/args/error lama bisa tetap terbaca di `traces.jsonl`/`step-traces.jsonl`. **Perbaikan:** kembalikan `cleanupReport` (item gagal) dan tampilkan peringatan ringkas, minimal `stderr` terredaksi.

### INFRA-3 — LOW (terverifikasi) — embedding/rag dan telemetry gagal diam-diam

`src/app/rag-layer.ts:81,104-106,113`: kegagalan endpoint embedding/keystore ditelan; sesi jatuh ke keyword search tanpa indikator. `src/telemetry/trace.ts:245-263`: semua kegagalan tulis trace ditelan. `src/session/journal.ts:1116-1134`: kegagalan `atomicWriteText` saat karantina korupsi ditelan, menyisakan jurnal korup yang sama tiap resume. **Perbaikan:** satu baris stderr sekali per sesi/kategori (tanpa secret) dan/atau field `degraded` di status/telemetri.

### INFRA-4 — LOW (terverifikasi) — daemon auto-run mencetak pesan error mentah

`cli/commands/daemon.ts:432-437`: `process.stderr.write(t("cli.daemonRunFailed", { msg: (e as Error).message }))`. Tidak lewat `formatError`/`formatMachineError`/`scrubSecrets`, jadi body provider atau Authorization echo bisa masuk stderr daemon. **Perbaikan:** pakai `formatMachineError(e)` (atau `formatError` untuk human) sebelum interpolasi.

### INFRA-5 — LOW (terverifikasi) — daftar mutator evaluasi masih manual kedua

`src/session/verification.ts:1804-1812` `WORKSPACE_MUTATING_TOOLS` berisi 7 tool; `src/policy/tool-contract.ts:196-206` `WRITE_TOOLS` juga mencakup `git_restore`, `git_checkout`, `lsp_rename`. `cli/setup.ts:1911-1920` sudah memakai `WRITE_TOOLS`, tetapi daftar di `verification.ts` belum. Dampaknya false-negative atribusi tamper untuk ketiga tool itu. **Perbaikan:** impor `WRITE_TOOLS` sebagai satu sumber kebenaran.

---

## E. Kesenjangan test

- Test error/ACP/error-render **hijau 82/82**, tetapi tidak ada test yang mengunci: (a) `refused` tidak boleh dipetakan network, (b) `service unavailable` tidak boleh dipetakan `notConfigured`, (c) trace menyimpan pesan konkret, (d) `exit 1` sebagai isi berkas tidak boleh menandai `read_file` gagal.
- `test/errors-usage.test.ts` justru mengunci `tSystem()` untuk pesan error UI; bila keputusan owner mengubah ke `t()`, test ini wajib diperbarui.
- Belum ada test regresi untuk kontrak abort os/docker yang seragam, `killTree` pada `git` abort, `env` sanitized pada `spawnSync` verifikasi, dan cooldown per-provider.

---

## F. Urutan perbaikan yang disarankan (tanpa menyentuh UI besar)

1. **Murah & dampak langsung:** ERR-1, ERR-3, INFRA-4, ERR-5 (hanya redaksi/komentar + test regresi).
2. **Diagnostik:** ERR-2, INFRA-1, INFRA-2, INFRA-3.
3. **Keandalan tool:** CMD-2, CMD-3, CMD-4, CMD-5, CMD-1 (CMD-1 perlu keputusan karena menyentuh presentasi/ledger).
4. **Sub-agent:** SUB-1, SUB-2, SUB-3 — perlu test kontrak yang sudah mengunci string byte-identik; lakukan bersama-sama agar tidak merusak receipt/recovery.
5. **Perlu keputusan owner:** ERR-4 (`tSystem` vs `/lang`), perubahan kontrak TERMINAL_CONTRACT, dan perubahan status kernel `delegate_task`.

---

## G. Batasan

Laporan ini **tidak** menyatakan repo hijau. Gate penuh tidak dijalankan; perubahan working tree dari sesi sebelumnya tidak dibersihkan oleh audit ini. Temuan bertanda "terverifikasi secara statis" belum direproduksi dengan eksekusi penuh pada kondisi produksi (mis. git timeout nyata, disk penuh saat ACP persist, abort dengan cucu ssh).
