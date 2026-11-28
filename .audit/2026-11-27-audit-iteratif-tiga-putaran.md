# Audit Iteratif Tiga Putaran — Minicode v0.52.1 (Working Tree Kotor)

**Tanggal:** 2026-11-27
**Mode eksekusi audit:** read-only. Laporan ini disimpan ke `.audit/` atas aba-aba pemilik setelah mode diubah ke BUILD; tidak ada file kode/test/dokumen di luar artefak ini yang diubah.
**Target:** seluruh repositori pada working tree `v0.52.1` (termasuk 111 berkas modifikasi dan berkas baru yang belum ter-commit).
**Gate/test:** tidak dijalankan (aturan `AGENTS.md`: gate hanya atas aba-aba pemilik; audit ini berbasis pembacaan kode aktual + verifikasi silang).

---

## 1. Metode dan cakupan

Putaran berulang yang dijalankan:

1. **Putaran 1 — pemetaan & audit per area.** Lima auditor paralel: (a) `cli/` + `scripts/` + `.github/` + `bench/` + `package.json`; (b) `src/app/`, `src/policy/`, `src/runtime/`, `vendor/minicore/src/core/`; (c) `src/session/`, `src/daemon/`, `src/memory/`, `src/sandbox/`, `src/tools/`, `src/config.ts`; (d) `src/providers/`, `src/mcp/`, `src/lsp/`, `src/lib/`, `src/telemetry/`, `vendor/minicore/src/providers/`; (e) `src/ui/`, `src/presentation/`, `cli/tui.ts`, `docs/`, `docs-en/`, `test/`.
2. **Putaran 1b — perincian.** Lima tindak lanjut untuk mengambil temuan yang terpotong dari ringkasan agen; semua item yang masih berlaku diverifikasi ulang dengan `read_file`/`grep` langsung.
3. **Putaran 2 — celah yang terlewat.** Tiga auditor: task/scheduler-approval, pemindaian pola berbahaya lintas-repo, dan konsistensi dokumentasi/test; ditambah tiga tindak lanjut perincian.
4. **Putaran 3 — sapuan akhir.** Verifikasi langsung terhadap jalur keamanan yang dinyatakan sudah diperbaiki (vector redirect, LSP frame, MCP SSE/byte cap, OS sandbox, jail, keystore, OAuth) dan kontradiksi komentar/implementasi di scheduler.

Status temuan dibedakan: **Terverifikasi-kode** (baris dibaca langsung) dan **Analitis** (perlu benchmark/pengukuran runtime). Tidak ada klaim "nol temuan" mutlak: area yang tidak bisa dieksekusi (provider nyata, gate penuh) dicatat sebagai keterbatasan.

---

## 2. Hasil tinjauan terhadap audit sebelumnya

Artefak `.audit/2026-11-27-audit-menyeluruh-pra-rilis.md` dan rencana perbaikannya dipakai sebagai baseline, bukan sebagai fakta. Verifikasi terhadap kode saat ini menunjukkan sebagian besar temuan lama **sudah tidak berlaku**, antara lain:

- **CORE-01/CORE-02:** guard eskalasi ganda sudah ada (`src/app/session.ts:1120-1148,1227-1235`), reset episode juga dipasang di `turn:completed` (`~1352-1361`), dan pemotongan surrogate sudah memakai `clampHeadEnd`/`clampTailStart` di `vendor/minicore/src/core/executor.ts:140-175`.
- **PROV-01…06:** `pricing sync` memakai `readCappedResponseText` (`src/policy/pricing.ts:334`); `openai-compat`, `anthropic`, `responses`, `sse-bounds`, `effort`, dan `provision` sudah diperbaiki.
- **STOR-01:** reader SQLite memakai `{ readonly: true }` + `busy_timeout`; transaksi read-then-write sudah `immediate` di `task/sync.ts`, `tools/todo.ts`, `daemon/store.ts`.
- **UI-01/UI-02/UX-01/UI-03:** parser `/paste`/path sudah terpusat di `src/ui/render/composer-wrap.ts:478-485`; shortcut `i` tidak lagi memetakan ke deny; sanitasi heading/input sudah disesuaikan.
- **SEC-01:** redirect embedding kini menolak downgrade HTTPS→HTTP dan redirect lintas-origin ber-header kredensial (`src/memory/vector.ts:468-510`).
- **INT-01/INT-02:** BOM/read-merge pin MCP, join SSE data, cache key, dan `try/catch` frame LSP sudah ada.
- **CLI-02:** normalisasi `limit` git dan `sliceSafeChars` ask_user sudah terpasang.

Temuan lama yang **masih berlaku sebagian** (detail di bawah): cakupan `.env*` di `mask.ts`, urutan `scrubSecrets` di `trace.ts`, keterbatasan register-ulang supervisor (bersyarat), dan headroom paket.

---

## 3. Temuan masih berlaku — Prioritas tinggi

### P0-1 [HIGH, terverifikasi] Waiter backend memakai satu timer bersama
**Lokasi:** `src/runtime/execution-backend.ts:465-492` (lihat juga `settleHostRecord` di `:319-326`).
**Bukti:** setiap pemanggilan `wait()` menambahkan `resolveWait` ke `rec.waiters`, lalu `if (rec.timer) clearTimeout(rec.timer); rec.timer = setTimeout(onTimeout, timeoutMs)`. `onTimeout` hanya menghapus waiter miliknya sendiri dan mengosongkan `rec.timer`. Bila waiter pertama memakai timeout 5.000 ms lalu waiter kedua memakai 100 ms, timer pertama dihapus; bila tidak ada exit/dispose, waiter pertama tidak pernah di-resolve. Sebaliknya, bila timer 100 ms melewati batas, waiter 5.000 ms tetap tertinggal tanpa timer.
**Dampak:** kontrak kapabilitas A (“stop waiting”) gagal; pemanggil bisa menggantung sampai proses keluar. Test yang ada menguji `wait` berurutan dan konkurensi dengan timeout serupa, bukan campuran timeout pendek/panjang pada record yang sama.
**Rekomendasi:** simpan timeout per-waiter (`Map<resolve, timer>`), atau pertahankan satu timer dengan deadline paling awal dan resolve semua waiter yang jatuh tempo; pastikan `settleHostRecord` membersihkan semua timer.

### P0-2 [HIGH, terverifikasi] Clipboard OS melewati resolver executable terpercaya
**Lokasi:** `src/lib/clipboard.ts:53-65` (`defaultSpawn`), `:68-96` (`nativeClipboardCommands`), `:104-114` (`writeNativeClipboard`).
**Bukti:** `spawnSync(cmd, args, …)` dipanggil dengan nama mentah `powershell.exe`, `clip.exe`, `pbcopy`, `xclip`, `xsel`, `wl-copy`. Repo ini memiliki `src/lib/trusted-exec.ts:52-89,119-137` dan hampir semua jalur spawn lain (git, LSP, MCP, keystore, update-check, sandbox) memakai `resolveTrustedExecutable`/`resolveSpawnTarget` + `sanitizeSpawnEnv`. Clipboard tidak mengimpor keduanya.
**Dampak:** pada Windows, pencarian CreateProcess memeriksa direktori CWD sebelum PATH; repo yang dibuka dengan `clip.exe`/`powershell.exe` buatan penyerang dapat mengeksekusi kode saat fitur paste/salin dipakai, tanpa persetujuan bash.
**Rekomendasi:** resolusi absolut via `resolveSpawnTarget`, tolah hasil resolusi yang masih berupa nama telanjang untuk kandidat Windows, dan gunakan `sanitizeSpawnEnv` untuk parity.

### P0-3 [HIGH, terverifikasi] `NUL` diperlakukan null sink lintas-platform
**Lokasi:** `src/policy/bash-guard.ts:597-600,876-891`; `src/policy/permission.ts:509-515,621-637,730-737`.
**Bukti:** `isNullSink()` menerima `"/dev/null"` atau `t.toUpperCase() === "NUL"` tanpa parameter platform. Di permission mode allowlist, `NEUTRAL_REDIRECT_RE` juga mencocokkan `NUL\b`; `decideBashCommand` membuat `cleaned = stripNeutralRedirections(cmd)` (`:622`) sebelum `hadFileRedirection = /[<>]/.test(cleaned)` (`:635`). Jadi `npx tsc >NUL` berubah menjadi `npx tsc` dan lolos dari pemeriksaan package-runner yang melarang redirect (`:733-737`), padahal di POSIX `NUL` adalah berkas biasa di workspace. Di bash-guard, target `NUL` juga diskip sebelum validasi target.
**Dampak:** efek tulis tidak terdeteksi dan aturan “package runner + redirect = deny” bisa dilewati di POSIX.
**Rekomendasi:** `isNullSink(t, platform)` hanya menerima `NUL` pada win32; hitung `hadFileRedirection` dari perintah sebelum redirection netral dihapus.

### P0-4 [HIGH, terverifikasi] Publish workflow menjalankan gate yang pasti gagal pada checkout tag bersih
**Lokasi:** `.github/workflows/publish.yml:44-57`; `scripts/telemetry-gate.ts:4-8,22-27,50-55`; perbandingan `.github/workflows/ci.yml:169-195`; `package.json:61`.
**Bukti:** publish menjalankan `bun test` lalu `bun run gate:coverage` (suite penuh dua kali), dan `bun run gate:telemetry` tanpa `--allow-missing`. Gate telemetry kini strict secara default dan gagal bila `.minicode/traces.jsonl` tidak ada atau <3 run. CI secara eksplisit memakai `--allow-missing` karena trace hanya ditulis oleh sesi runtime nyata, lalu menguji jalur strict dengan artifact sintetis. Publish tidak memiliki keduanya. Selain itu `gate:fast` tidak memuat `gate:eval`, sementara CI punya pemeriksaan terpisah bahwa smoke `--fake` tidak boleh lolos (`ci.yml:149-162`).
**Dampak:** rilis tag dapat gagal sebelum `npm publish`; gate lokal bisa hijau sementara CI merah.
**Rekomendasi:** samakan publish dengan CI (`--allow-missing` + uji strict sintetis) atau konsolidasikan ke `bun run gate:fast` yang diperluas; hapus duplikasi `bun test`; putuskan apakah `gate:eval` masuk `gate:fast`.

### P0-5 [HIGH, terverifikasi] Dispatch failure dari adapter autonomous berubah jadi attempt gagal
**Lokasi:** `src/task/autonomous-adapter.ts:151-161`; `src/task/scheduler.ts:854-871,891-896`.
**Bukti:** `buildAutonomousRunTurn` mengembalikan fungsi `async` dan memanggil `planAutonomousContext(work, bindingFor(work.taskId), config)` **sebelum** blok `try`. Komentar di `:155-158` menyatakancheduler memperlakukan throw sinkron sebagai dispatch failure dan melepaskan claim. Namun karena fungsinya `async`, throw (mis. binding tidak lengkap dari `:103-107` atau `cwdFor` gagal) menjadi rejected promise. Scheduler menangkap rejection itu di `:892-895` sebagai `{kind:"rejected"}` dan mencatat `recordAttemptReturned`.
**Dampak:** kegagalan yang tidak pernah menjalankan eksekusi tetap membakar `exec_generation`, sehingga task tidak kembali ke `PENDING` lewat `releaseClaim`.
**Rekomendasi:** lakukan planning di luar closure async (sebelum promise dibentuk) atau kembalikan typed `dispatch-failure` yang ditangani scheduler dengan `releaseClaim`.

### P0-6 [HIGH-MEDIUM, analitis—belum di-benchmark] Backtracking regex pada input tak terpercaya
**Lokasi:** `src/policy/scrub.ts:23-24`; `src/tools/read_file.ts:192-218`; `src/tools/web_fetch.ts:15-23`; `src/tools/web_search.ts:409-431`.
**Bukti:** pola PEM `/-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END … PRIVATE KEY-----/g` memindai sampai EOF untuk setiap `BEGIN` tanpa pasangan `END`; pola `<(script|style|noscript|svg)\b[^>]*>[\s\S]*?</\1>` dan `<entry[^>]*>[\s\S]*?</entry>` memiliki sifat yang sama. `read_file` dapat menerima sampai 50 MB saat paged (`HARD_CAP` di `:185-195`) dan selalu memanggil `scrubSecrets`; `web_fetch`/`web_search` memproses body hingga 2.000.000 karakter (`LIMITS.WEB_*` di `src/constants.ts:321-322`).
**Dampak:** dokumen/HTML/feed jahat dengan banyak penanda tak berpasangan berpotensi mem-blok satu turn (CPU spike). Catatan: `scrub.ts` sudah memiliki optimasi linear untuk pola env-dump lain (komentar `:70-87`), jadi ini celah spesifik pada pola dot-all.
**Rekomendasi:** ganti dengan pemindai linear berindeks / pencarian pasangan `indexOf` terbatas; tambah benchmark dengan 10k penanda tak berpasangan pada batas 2 MB sebelum/ sesudah perbaikan. Status: analisis statis, bukan hasil pengukuran.

---

## 4. Temuan masih berlaku — Prioritas menengah

### P1-1 [MED, terverifikasi] `detectAndSave` menghilangkan metadata `auth`
**Lokasi:** `src/providers/provision.ts:214-245`; `src/providers/provision.ts:34-47`; `src/providers/build.ts:111-118,178-179`.
**Bukti:** `entry: ProviderEntry` disusun field-per-field dari `detected`/`apiKey`/`capacity` dan hanya menyalin `contextWindows`, `contextWindowSources`, `maxOutputTokens`, `maxOutputTokensDefault`, `enablePromptCaching`, `reasoningEffort` dari `previous`. Tidak ada `auth: previous.auth`. `saveProvider` menimpa seluruh entri dan mensyaratkan `apiKey` bila `auth !== "oauth"`. Jalur yang terpengaruh: `cli/commands/config.ts:127`, `cli/provider-manager.ts:67,117,129`, `cli/wizard.ts:11`.
**Dampak:** edit/re-detect provider OAuth dapat mengubahnya menjadi `apikey`, lalu gagal validasi karena `apiKey` kosong, atau kehilangan mode OAuth.
**Rekomendasi:** gunakan `...previous` sebelum override (atau salin semua field stabil eksplisit termasuk `auth`), dan uji re-detect pada provider OAuth.

### P1-2 [MED, terverifikasi] Kegagalan verifier ditelan; task bisa silent strand
**Lokasi:** `src/task/production-scheduler.ts:264-307`; `src/task/scheduler.ts:891-896,1113-1124`.
**Bukti:** verifier hanya dipanggil bila `res.dispatched.ok && lineage === "RECORDED"`. Blok `catch {}` di `:304-306` menelan error dari `d.verifier()` maupun `completeTaskVerification()` tanpa event/transisi. Scheduler sengaja tidak mengonsultasikan `observation.ok` (komentar `:912-915`) dan continuity gate hanya merekonsiliasi bila `SAFE_TO_RETRY`; `REQUIRES_VERIFIER`/`HOLD` sengaja dibiarkan.
**Dampak:** tanpa verifier atau saat verifier/write gagal, task tetap `IN_PROGRESS` tanpa sinyal; UI todo tidak sinkron. Sebagian ini adalah keputusan desain keselamatan (mencegah pengulangan efek), jadi yang hilang adalah penanganan kegagalan yang teramati, bukan requeue sembarangan.
**Rekomendasi:** ubah `catch` menjadi outcome bertipe, emisikan event kegagalan, dan terapkan transisi `BLOCKED`/requeue eksplisit bila kebijakan mengizinkan.

### P1-3 [MED, terverifikasi] Verifikasi mutasi kerja salah target untuk `move_file` dan file yang tidak ada
**Lokasi:** `src/session/journal.ts:266-298,316-357,373-415`.
**Bukti:** `verifyPaths("move_file")` mengembalikan `[sumber, tujuan]`, tetapi `targetHashesFor` memakai `[0]` (sumber), yang setelah operasi tidak ada lagi → `target-unreadable`/`UNKNOWN`. Untuk `delete_file` pada file yang memang tidak ada, `pre = null`, `post = null`, `observed.hash = null`: syarat pertama `post !== pre` bernilai false, lalu syarat kedua `observed.hash === post` bernilai true → `CONFIRMED_EXECUTED`.
**Dampak:** bukti eksekusi tidak pernah membuktikan `move_file`, dan aksi yang tidak dijalankan dilaporkan berhasil.
**Rekomendasi:** hash `destination` untuk `move_file`; perlakukan `pre === null && post === null && observed === null` sebagai `CONFIRMED_NOT_EXECUTED` atau `UNKNOWN` sesuai kontrak.

### P1-4 [MED, terverifikasi] Entri allowlist non-string merusak pengecekan izin
**Lokasi:** `src/policy/allowlist.ts:14-38,54-81`.
**Bukti:** loader hanya memeriksa `Array.isArray(parsed.allowed)` lalu memasukkan isi ke `Set<string>` tanpa validasi elemen. `matchAllowlist` memanggil `pat.startsWith("exact:")` dan `allowlistRe(pat)` yang memanggil `pat.replace(...)`.
**Dampak:** `allowlist.json` yang rusak (angka/objek) menyebabkan throw di hot path permission, bukan penolakan yang terkontrol.
**Rekomendasi:** filter `typeof entry === "string" && entry.length > 0` saat load dan simpan, plus peringatan untuk entri invalid.

### P1-5 [MED, terverifikasi] Satu entri harga rusak membuang seluruh overlay
**Lokasi:** `src/policy/pricing.ts:137-151,162-195`.
**Bukti:** `normalizePriceMap` melakukan `toModelPrice(p.input, ...) tanpa memeriksa `p != null`; satu entri `null` melempar TypeError. `loadPricingOverlay` membungkus seluruhnya dalam `catch {}` lalu mengembalikan `{}`.
**Dampak:** estimasi biaya/`--budget` kehilangan seluruh cache harga akibat satu berkas cache yang sebagian rusak.
**Rekomendasi:** validasi per-entri (`if (!p || typeof p !== "object") continue`) dan pertahankan entri lain.

### P1-6 [MED, terverifikasi] Retry 401 OpenAI-compat tidak memakai dynamic key saat refresh gagal
**Lokasi:** `vendor/minicore/src/providers/openai-compat.ts:141-161`; konteks `src/providers/build.ts:178-179`.
**Bukti:** `resolveHeaders(forceRefresh=true)` hanya memanggil `config.refreshApiKey()`; `config.getApiKey()` berada di cabang `else if`. Bila refresh gagal, token jatuh ke `config.apiKey` statis (untuk OAuth bisa kosong) dan tidak mencoba `getApiKey()`.
**Dampak:** retry 401 mengirim kunci lama/kosong; provider OAuth gagal pulih.
**Rekomendasi:** panggil `getApiKey()` sebagai fallback juga pada cabang refresh gagal.

### P1-7 [MED, terverifikasi] Pemindaian `.env*` di sandbox berhenti diam-diam
**Lokasi:** `src/sandbox/mask.ts:21-29,49-104`; pemakai di `src/sandbox/os.ts:90-124,127-145` dan jalur Docker.
**Bukti:** `MAX_SCAN_DIRS = 2000`, `MAX_SCAN_DEPTH = 8`; BFS berhenti saat batas tercapai tanpa menandai truncation. `SKIP_DIRS` hanya `.git`, `node_modules`, `.minicode`, `dist`, `build`.
**Dampak:** `.env` pada kedalaman >8 atau monorepo >2000 direktori tidak dimasking pada bwrap/Seatbelt/Docker.
**Rekomendasi:** kembalikan flag `truncated` dari `discoverSandboxMaskTargets`; bila sandbox aktif dan ada indikasi terpotong, tolak start atau perluas batas dengan pruning eksplisit.

### P1-8 [MED, terverifikasi] Trace summary memotong sebelum scrub
**Lokasi:** `src/telemetry/trace.ts:99-110` (bandingkan jalur approvals yang benar di `src/daemon/approvals.ts:401-410`).
**Bukti:** `scrubSecrets(args.slice(0, 120))`, `v.slice(0, 120)` pada argumen, dan `parts.join(" ").slice(0, 300)` terjadi sebelum `scrubSecrets` pada hasil akhir.
**Dampak:** rahasia yang terbelah tepat di batas bisa lolos ke ringkasan trace.
**Rekomendasi:** scrub nilai penuh (atau batas + overlap) sebelum slice, lalu scrub ulang hasil slice.

### P1-9 [MED, bersyarat, terverifikasi sebagian] Supervisor child mewarisi buku besar lama saat register ulang
**Lokasi:** `src/runtime/process-supervision.ts:233-245`; `src/lsp/client.ts:242-247,306-308,369-392`.
**Bukti:** `register()` hanya men-set `children` dan menginisialisasi `attempts` bila belum ada; tidak mereset `escalated`, `exits`, `lastExitAt`. `childId` LSP stabil per ekstensi (`lsp:${ext}`); bila instance LSP baru didaftarkan ke supervisor yang sama, entri lama terbawa.
**Dampak:** child baru bisa langsung dieskalasi atau tidak direstart karena kuota habis. Ini bergantung apakah supervisor yang sama dipakai ulang lintas instance; perlu dikonfirmasi lewat test lifecycle sebelum diklasifikasikan sebagai bug pasti.
**Rekomendasi:** reset seluruh buku besar per-id saat register, atau kunci state berdasarkan incarnation.

### P1-10 [MED, terverifikasi] `RangeError` pada entitas XML arXiv
**Lokasi:** `src/tools/web_search.ts:409-417`; pembanding aman di `src/tools/web_fetch.ts:31-38`.
**Bukti:** `decodeXmlEntities` memakai `String.fromCodePoint(Number(n))` dan `parseInt(n,16)` tanpa validasi `0..0x10FFFF`/surrogate. `web_fetch` sudah memvalidasi dengan `Number.isSafeInteger` dan batas code point.
**Dampak:** feed arXiv dengan entitas di luar rentang melempar `RangeError` dan menggagalkan seluruh fan-out pencarian.
**Rekomendasi:** pakai helper validasi yang sama dengan `web_fetch`.

---

## 5. Temuan prioritas rendah / dokumentasi / gate pendukung

- **CLI-01 [LOW-MED, terverifikasi]** `cli/args.ts:181-205`: `hasHelpFlag` memakai `argv.includes("--help")`, tidak sadar value-flag, sehingga nilai `--help` pada opsi lain dapat memicu help + exit 0. `cli/args.ts:411-431`: `unknownFlagsBeforePrompt` memecah loop pada token `-x`, padahal `docs/cli.md:148-150` menjanjikan exit 2 untuk flag tak dikenal sebelum prompt. **Rekomendasi:** parser flag yang sadar nilai dan satukan dengan kontrak docs.
- **DOCS-01 [MED, diverifikasi auditor dokumen]** `docs-en/` tertinggal dari kode dan `docs/`: `choosing-mode.md:5,18,26` (`PLAN`/`BUILD`), `cli.md:57,84,103` (cap 50, `--work-mode PLAN`), `tools.md:99` (pool 3, `16/24/40/64`, `[8,100]`, 300 dtk), `agents.md:7` (600.000 ms), `environment.md:23` (PLAN/300000/pool 3), `contributing.md:47,49,51` (5.000 KiB & tanggal lama), `repl.md:31,33,38,74` (hilang `/logs`, hint Esc/Ctrl+C berbeda). Pembanding: `src/policy/work-mode.ts:21-25`, `src/constants.ts:215,227,238`, `scripts/pack-budget.ts:188`, `docs/contributing.md:48-52`. Tautan di `docs-en/README.md:3` dan `docs-en/SUMMARY.md:52` mengarah ke `TERMINAL_CONTRACT.md` yang hanya ada di `docs/`. **Rekomendasi:** sinkronkan seluruh halaman EN atau arahkan ke versi ID secara eksplisit.
- **GATE-02 [MED, terverifikasi]** `package.json:61` (`gate:fast`) tidak menyertakan `gate:eval`, sementara CI memiliki assertion khusus di `ci.yml:149-162`. **Rekomendasi:** masukkan ke `gate:fast` atau nyatakan sebagai gate parsial dalam dokumentasi.
- **TOOL-02 [LOW, analitis]** `src/tools/glob.ts:12-35`: sentinel `\0BRACE_START\0`, `\0BRACE_OR\0`, `\0REC\0` disisipkan lalu diganti menjadi `(`, `|`, `)`, `(?:.*/)?` setelah escaping regex. Argumen JSON yang memuat NUL literal dapat menyuntik sintaks RegExp. **Rekomendasi:** sentinel yang tidak bisa berasal dari input. Perlu reproducer sebelum prioritas dinaikkan.
- **PACK-01 [info, tidak diukur ulang]:** baseline artefak sebelumnya mencatat paket ~5.210 KiB terhadap `PACK_SIZE_BUDGET_KIB = 5250` (`scripts/pack-budget.ts:188,197-201`), margin sangat tipis. **Rekomendasi:** jalankan `npm pack --dry-run --json` sebelum perubahan apa pun; jangan menaikkan budget tanpa bukti dan persetujuan.

---

## 6. Urutan rekomendasi perbaikan (belum diterapkan)

1. **Gelombang 0 — keamanan & rilis:** P0-2 (clipboard), P0-3 (`NUL`), P0-4 (publish/telemetry), P0-1 (timer wait). Ini perbaikan kecil dan tidak mengubah UI.
2. **Gelombang 1 — scheduler & provider:** P0-5 (async dispatch), P1-1 (auth OAuth), P1-2 (verifier outcome), P1-6 (refresh key), P1-5 (pricing overlay).
3. **Gelombang 2 — verifikasi & observabilitas:** P1-3 (jurnal), P1-8 (trace scrub), P1-4 (allowlist), P1-10 (RangeError), P1-7 (mask truncation), P1-9 (supervisor, setelah dikonfirmasi).
4. **Gelombang 3 — performa & konsistensi:** P0-6 (benchmark + pemindai linear), CLI-01, DOCS-01, GATE-02, TOOL-02; ukur ulang PACK-01.
5. **Verifikasi per gelombang:** `bun x tsc --noEmit` + test terarah. `bun run gate:fast` / gate penuh hanya atas aba-aba pemilik dan setelah satu kandidat final disepakati.

### Perubahan UI
Tidak ada temuan audit ini yang menyarankan perubahan geometri, composer, caret, ratchet, rekap, layout, warna, writer, atau I1. Bila perbaikan di masa depan menyentuh area tersebut, `AGENTS.md` tetap mewajibkan konfirmasi pemilik.

---

## 7. Keterbatasan dan hal yang sengaja tidak diklaim

- Tidak ada test, benchmark, `tsc`, lint, maupun gate yang dijalankan; seluruh temuan berasal dari pembacaan kode. P0-6 dan PACK-01 ditandai analitis/perlu pengukuran.
- Provider nyata (kredensial), perilaku OS sandbox sebenarnya, dan konkurensi lintas-proses tidak diverifikasi secara runtime.
- Klaim “sudah tidak ada temuan baru” hanya berlaku untuk cakupan yang dibaca pada putaran 3, bukan jaminan mutlak atas seluruh kombinasi runtime.
- Tidak ada commit, tidak ada perubahan kode sumber, dan tidak ada perubahan dokumen di luar artefak ini.
