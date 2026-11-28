# Plan Perbaikan Audit Iteratif — Minicode v0.52.1

**Tanggal:** 2026-11-28  
**Dasar:** [2026-11-27-audit-iteratif-tiga-putaran.md](2026-11-27-audit-iteratif-tiga-putaran.md) + riset silang kode & kontrak gate saat ini.  
**Status UI:** Tidak ada perubahan pada geometri, composer, caret, ratchet, rekap, layout, warna, writer, maupun I1 (`AGENTS.md` konfirmasi UI tidak terpicu).

---

## Temuan Riset Kritis Sebelum Eksekusi

Beberapa fakta tambahan dari riset codebase yang menentukan desain perbaikan agar aman dan bebas regresi:

1. **OVER-BUDGET PAKET SAAT INI (`PACK-01`):**
   `npm pack --dry-run --json` pada working tree saat ini mencatat **346 berkas, 5.310 KiB unpacked** (`1.655 KiB` compressed), **sudah melewati batas `PACK_SIZE_BUDGET_KIB = 5250` di `scripts/pack-budget.ts:188` sebesar +60 KiB** sebelum perbaikan audit ini diterapkan.  
   - Rincian terbesar: `src/ui` 991 KiB, `src/session` 578 KiB, `src/policy` 534 KiB, `src/tools` 389 KiB, `src/task` 367 KiB, `src/runtime` 340 KiB, `cli/setup.ts` 202 KiB, `src/presentation` 182 KiB, dan total `docs/*.md` ~280+ KiB (`TERMINAL_CONTRACT.md` 37 KiB, `architecture.md` 25 KiB, `OUTPUT_RENDERING_SPEC.md` 22 KiB, `UI_RENDER_PIPELINE.md` 22 KiB, `autonomous-scheduler.md` 21 KiB, `OUTPUT_UX_RULES.md` 20 KiB).  
   - `docs-en/` **tidak** tercantum di `package.json` `"files"`, jadi sinkronisasi `docs-en/` menambah **0 KiB** ke tarball.  
   - Karena `AGENTS.md` melarang menaikkan `PACK_SIZE_BUDGET_KIB` tanpa bukti + persetujuan pemilik, keputusan `PACK-01` (trim isi non-runtime di tarball atau re-baseline `PACK_SIZE_BUDGET_KIB`) dijadwalkan di Gelombang 3 untuk konfirmasi pemilik.

2. **Jebakan Infinite Restart Loop pada `P1-9` (`process-supervision.ts` + `lsp/client.ts`):**
   Di `src/lsp/client.ts:308`, `doStart()` memanggil `supervisor.register(this.managedChild())`, dan `restart()` (`L387`) memanggil `start()` → `doStart()`. Setiap pemanggilan `managedChild()` (`L369`) mengembalikan object literal baru. Jika `ProcessSupervision.register()` me-reset `attempts`/`exits`/`escalated` setiap kali `register()` dipanggil (atau saat `existing !== child`), maka setiap restart otomatis akan menghapus penghitung percobaan dan menciptakan **loop restart tak berujung**. Solusi harus menjaga identitas per instance `LspConnection` dan memisahkan kontrak *restart instance sama* vs *registrasi instance pengganti / pasca-`unregister`*.

3. **Lantai Coverage Ketat (`scripts/coverage-gate.ts:119-142`):**
   Beberapa modul sasaran perbaikan memiliki batas liputan per-berkas yang tinggi:
   - `src/policy/scrub.ts` (`95/95`) — `P0-6`
   - `src/policy/bash-guard.ts` (`92/92`) — `P0-3`
   - `src/policy/permission.ts` (`90/90`) — `P0-3`
   - `src/lib/trusted-exec.ts` (`90/90`) — dipanggil `P0-2`
   - `src/session/journal.ts` (`85/90`) — `P1-3`
   Setiap cabang defensif baru di file tersebut **wajib** memiliki unit test yang menutup jalurnya.

4. **`GATE-02` Tidak Boleh Memasukkan `gate:eval` ke `gate:fast`:**
   `bench/eval-gate.ts:56-72` menolak `--fake` (`summary.fake !== false`) dan mewajibkan hasil benchmark LLM nyata. Sementara `gate:fast` adalah gate offline tanpa API key (`bench:smoke --fake`). Maka `GATE-02` diselesaikan via dokumentasi eksplisit (bukan mematahkan `gate:fast`).

5. **Nuansa `CLI-01` di Entrypoint Root (`cli/index.ts:262`):**
   Penggunaan `args.includes("-h") || args.includes("--help")` tidak hanya ada di `cli/args.ts` (`hasHelpFlag`), tetapi juga langsung di `cli/index.ts:262-270` (termasuk `--tui`/`--json`).

6. **Nuansa `P0-6` (`read_file.ts:197-205`):**
   Jalur `paged` pada `read_file` membaca satu halaman berbatas baris (`formatHandleRange`), bukan seluruh 50 MiB ke `scrubSecrets` kecuali satu halaman berisi baris raksasa; unpaged sudah dibatasi `READ_FILE_MAX_BYTES`. `P0-6` tetap layak diperkeras, tetapi setelah benchmark terukur (prioritas Gelombang 3).

---

## Rencana Eksekusi Bertahap

### Gelombang 0 — Keamanan, Konkurensi, Kontrak Scheduler, & Release Workflow
Target: semua temuan `P0-1` sampai `P0-5` yang berdampak fungsional/keamanan/rilis langsung.

#### 0.1 `P0-1` — Timer per-waiter di `ExecutionBackend`
- **Berkas:** `src/runtime/execution-backend.ts` (`L314-330`, `L465-510`)
- **Perubahan:**
  - Ubah `HostRecord.waiters` dari `Set<(r: BackendWaitResult) => void>` + satu `timer` bersama menjadi `Map<(r: BackendWaitResult) => void, ReturnType<typeof setTimeout>>` (atau struktur waiter ber-timer masing-masing), hapus `rec.timer`.
  - Di `wait()`: buat timer terpisah per pemanggil; di `onTimeout()`, hapus hanya entri waiter tersebut dari `rec.waiters` lalu resolve `{ status: "timeout" }`.
  - Di `settleHostRecord()`: iterasi seluruh entri `rec.waiters`, `clearTimeout` semua timer-nya, kosongkan map, lalu resolve seluruh waiter aktif.
- **Test:** tambah test di suite runtime/execution-backend untuk dua `wait()` konkuren dengan timeout berbeda (mis. `50 ms` dan `300 ms`) pada satu handle yang hidup: waiter cepat timeout ~50 ms tanpa membatalkan timer waiter lambat, dan `dispose()` membersihkan semua timer.

#### 0.2 `P0-2` — Clipboard OS via `resolveSpawnTarget` + `sanitizeSpawnEnv`
- **Berkas:** `src/lib/clipboard.ts` (`L1-67`)
- **Batas lapisan:** `src/lib/` sudah mengimpor `../policy/scrub.ts` di `src/lib/git-hardening.ts:2`; aman terhadap `test/ui-boundary.test.ts`.
- **Perubahan:**
  - Impor `isAbsolute` (`node:path`), `resolveSpawnTarget` (`./trusted-exec.ts`), dan `sanitizeSpawnEnv` (`../policy/scrub.ts`).
  - Di `defaultSpawn(cmd, args, input, platform)`:
    - Hitung `const target = resolveSpawnTarget(cmd, args, { platform })`.
    - Tolak fail-closed (`return { ok: false }`) jika `!isAbsolute(target.command)` agar nama telanjang (`powershell.exe`, `clip.exe`, `pbcopy`, dll.) tidak pernah jatuh ke pencarian CWD Windows atau PATH relatif.
    - Panggil `spawnSync(target.command, target.args, { ..., env: sanitizeSpawnEnv(process.env), ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) })`.
  - Pertahankan `nativeClipboardCommands()` tetap murni mengembalikan nama logis + signature `opts.spawn` DI agar kontrak unit test yang ada tetap kompatibel.
- **Test:** tambah test di `test/clipboard.test.ts` yang memverifikasi CWD hijack (`clip.exe` / `powershell.exe` di cwd temp) tidak tereksekusi / di-skip jika resolver tidak menemukan biner absolut di `PATH`, serta `MINICODE_*`/secret env ter-scrub.

#### 0.3 `P0-3` — `NUL` Khusus Windows & Redirection Guard di `permission.ts` / `bash-guard.ts`
- **Berkas:** `src/policy/bash-guard.ts` (`L598-600`, `L891`), `src/policy/permission.ts` (`L509-516`, `L621-637`, `L733-737`)
- **Perubahan:**
  - `bash-guard.ts`: ubah `isNullSink(t: string, platform: NodeJS.Platform = process.platform)` agar `t.toUpperCase() === "NUL"` hanya dianggap null sink ketika `platform === "win32"`. Teruskan `opts?.platform ?? process.platform` bila tersedia di konteks evaluasi guard.
  - `permission.ts`:
    - Pisahkan regex redirection netral menjadi platform-aware `stripNeutralRedirections(cmd, platform = process.platform)`:
      - `win32`: terima `&\d`, `/dev/null`, dan `NUL`.
      - Non-`win32` (POSIX): terima **hanya** `&\d` dan `/dev/null` (`NUL` tetap diperlakukan sebagai file redirect biasa!).
      - Gunakan batas token yang presisi `(?:$|(?=\s|[;|&]))` alih-alih `\b` supaya `>/dev/null/evil` tidak ter-strip sebagian.
    - Karena `NUL` tidak lagi dihapus di POSIX, `hadFileRedirection = /[<>]/.test(cleaned)` di `L635` otomatis bernilai `true` untuk `npx tsc >NUL` pada POSIX (sehingga package runner tetap ditolak di `L735`), sementara `npx tsc 2>&1` dan `npx tsc >/dev/null` tetap sah.
- **Test:** tambah regresi di `test/allowlist-npx.test.ts` / `test/bash-guard-escaping.test.ts` dengan parameter platform eksplisit (`"linux"` vs `"win32"`) memverifikasi `npx tsc >NUL` ditolak di `"linux"` dan redirect file ke `NUL` divalidasi di bash-guard POSIX. Pastikan liputan baris/fungsi tetap di atas lantai `90/90` & `92/92`.

#### 0.4 `P0-4` — Sinkronisasi `.github/workflows/publish.yml`
- **Berkas:** `.github/workflows/publish.yml` (`L44-58`)
- **Perubahan:**
  - Hapus step `bun test` (`L44-45`) yang duplikat karena `bun run gate:coverage` (`L47`) sudah menjalankan `bun test --coverage` penuh (`scripts/coverage-gate.ts:160`).
  - Samakan step `Telemetry gate` (`L56-57`) dengan `.github/workflows/ci.yml:169-195`: jalankan `bun run gate:telemetry -- --allow-missing` diikuti self-test strict menggunakan direktori temporer sintetis (`3` run lolos, `1` run ditolak).
- **Verifikasi:** validasi YAML sintaks & keringkan logika self-test lokal terhadap `scripts/telemetry-gate.ts`.

#### 0.5 `P0-5` — Synchronous Dispatch Refusal di `autonomous-adapter.ts`
- **Berkas:** `src/task/autonomous-adapter.ts` (`L151-176`)
- **Perubahan:**
  - Pindahkan pembuatan `planAutonomousContext(work, bindingFor(work.taskId), config)` dan konstruksi `new AutonomousExecutionContext(...)` ke badan **sinkron** sebelum mengembalikan `(async () => { ... })()`.
  - Dengan demikian kegagalan planning/binding melempar exception secara sinkron, ditangkap `Scheduler` (`src/task/scheduler.ts:857-871`) sebagai `failure: "bridge-threw"`, `lineage: "NOT_ATTEMPTED"`, dan claim dirilis kembali ke `PENDING` lewat `releaseClaim("dispatch-failed")`.
- **Test:** tambah test integrasi `Scheduler` + `buildAutonomousRunTurn` saat `bindingFor` melempar/kurang field: memastikan task kembali ke `PENDING` dan `execGeneration` tidak mencatat attempt palsu.

---

### Gelombang 1 — Integritas Auth Provider, Journal, Loader, Scrubber, & XML Entity
Target: `P1-1`, `P1-3`, `P1-4`, `P1-5`, `P1-6`, `P1-8`, `P1-10` (perbaikan lokal terarah risiko rendah).

1. **`P1-1` (`src/providers/provision.ts:224-243`):**
   - Salin `...(previous?.auth ? { auth: previous.auth } : {})` pada `entry` di `detectAndSave` (cek juga apakah ada properti stabil lain di `ProviderEntry` selain `contextWindows`/`maxOutputTokens`/`enablePromptCaching`/`reasoningEffort`).
   - **Test:** regresi di `test/provision-effort.test.ts` membuktikan `detectAndSave` mempertahankan `auth: "oauth"`.

2. **`P1-3` (`src/session/journal.ts:340-420`) — lantai coverage `85/90`:**
   - **Perbaikan `move_file`:**
     - Pada `targetHashesFor`: untuk `move_file`, ambil `paths = verifyPaths(name, args, root)`. Bila `paths.length >= 2`, hash sumber `src = paths[0]` sebagai `preTargetHash` dan pertahankan `paths = [src, dest]`.
     - Pada `reconcileWorkspaceMutationIntent`: bila `record.paths.length >= 2` (jalur dua-ujung `move_file`), verifikasi **kedua** path secara aman (bounds check untuk `paths[0]` dan `paths[1]`):
       - bila `src` masih ada dengan hash `=== pre` (dan bukan target yang sama/case-only yang sudah selesai) → `CONFIRMED_NOT_EXECUTED`;
       - bila `dest` ada dengan hash `=== pre` dan `src` sudah tidak ada (kecuali case-only di path yang sama) → `CONFIRMED_EXECUTED`;
       - bila keduanya tidak cocok → `UNKNOWN`.
   - **Perbaikan `delete_file` tak-eksis:**
     - Pada cabang tunggal (`L399-416`), jika `pre === null && post === null && observed.hash === null`, kembalikan `{ verdict: "UNKNOWN", ..., reason: "target-already-absent" }` — tidak pernah mengklaim `CONFIRMED_EXECUTED` atas penghapusan file yang sejak awal tidak ada.
   - **Test:** tambah test di `test/p15-phase2-contracts-approval-recovery.test.ts` untuk (a) `move_file` belum jalan / sudah pindah / setengah gagal, dan (b) `delete_file` dengan `pre: null, post: null` menghasilkan `UNKNOWN`.

3. **`P1-4` (`src/policy/allowlist.ts:14-52`):**
   - Tambahkan helper kecil `sanitizeAllowedEntries(raw: unknown): string[]` yang hanya mengambil elemen `typeof x === "string" && x.length > 0` dan mengeluarkan peringatan stderr singkat jika ada entri rusak yang dibuang. Terapkan pada `loadAllowlist` (global & lokal) maupun `saveAllowlist`.
   - **Test:** regresi di `test/skills-hooks.test.ts`: `allowlist.json` berisi angka/`null`/objek tidak membuat `matchAllowlist` melempar exception.

4. **`P1-5` (`src/policy/pricing.ts:186-195`):**
   - Tambahkan guard `if (!v || typeof v !== "object" || Array.isArray(v)) continue` di `normalizePriceMap` sebelum mengakses `p.input`.
   - **Test:** regresi di `test/budget-unknown.test.ts` dengan cache overlay berisi satu entri `null` + satu entri valid: entri valid tetap dimuat.

5. **`P1-6` (`vendor/minicore/src/providers/openai-compat.ts:141-154`):**
   - Saat `forceRefresh && config.refreshApiKey`: coba `await config.refreshApiKey().catch(() => undefined)`; bila masih kosong/undefined dan `config.getApiKey` tersedia, jatuh ke `await config.getApiKey().catch(() => undefined)` sebelum fallback terakhir ke `config.apiKey`.
   - Cek konsistensi dengan provider lain di `vendor/minicore/src/providers/` bila pola `refreshApiKey` juga dipakai di sana.
   - **Test:** uji skenario `401` retry saat `refreshApiKey()` mengembalikan `undefined` namun `getApiKey()` mengembalikan token segar.

6. **`P1-8` (`src/telemetry/trace.ts:99-111`):**
   - Pada `summarizeArgs`, panggil `scrubSecrets` **lebih dulu** sebelum memotong `.slice(0, 120)` pada argumen string dan sebelum menggabungkan; setelah `parts.join(" ").slice(0, 300)`, panggil `scrubSecrets` sekali lagi untuk jaga-jaga jika batas pemotongan membentuk token bermasalah.
   - **Test:** tambah test di `test/telemetry-privacy.test.ts` dengan secret panjang yang dimulai tepat di indeks 105–130 (terbelah di batas `120` atau `300`): secret tetap ter-redact, bukan terpotong separuh.

7. **`P1-10` (`src/tools/web_search.ts:409-418` + `src/tools/web_fetch.ts:31-38`):**
   - Ekstrak atau gunakan helper `decodeNumericEntities` berbatas `Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff` (konsisten antara `web_fetch.ts` dan `web_search.ts`, menghindari duplikasi logika) agar entitas XML arXiv out-of-range tidak melempar `RangeError`.
   - **Test:** tambah test di `test/web-search-developer.test.ts` dengan entitas `&#99999999;` / `&#xD800;`.

---

### Gelombang 2 — Observabilitas Scheduler, Sandbox Mask, Supervision Lifecycle, CLI & Docs
Target: `P1-2`, `P1-7`, `P1-9`, `CLI-01`, `DOCS-01`, `TOOL-02`.

1. **`P1-2` (`src/task/production-scheduler.ts:264-309` + tipe event):**
   - Ubah `catch (err)` pada `runVerifiedCycle` (`L304-306`) dari silent swallow menjadi pelaporan terstruktur:
     - Definisikan `SchedulerEvent` / `TriggerEvent` atau callback status terklasifikasi (`verification-hook-failed` dengan detail yang disanitasi) agar `onTriggerEvent` / `onSchedulerEvent` mendengar kegagalan verifier/persisten.
     - Jika verifier melempar sebelum `completeTaskVerification` dan `cur.status === "IN_PROGRESS"`, tetap jaga agar loop tidak crash, sekaligus bila policy mengizinkan catat kegagalan verifikasi / transisikan secara jujur tanpa membiarkan task `IN_PROGRESS` bisu tanpa sinyal. *(Verifikasi kontrak test Phase 6U/6Z sebelum memilih apakah status tetap ditahan atau menjadi `BLOCKED`).*
   - **Test:** uji `d.verifier` throw dan `store.completeTaskVerification` gagal → event kegagalan teremit.

2. **`P1-7` (`src/sandbox/mask.ts:38-105`, `src/sandbox/os.ts:207-225`, `src/sandbox/docker.ts:189-197`):**
   - Kembalikan `truncated: boolean` (dan `truncationReason?: "max-dirs" | "max-depth"` opsional) dari `discoverSandboxMaskTargets`.
   - Tambah direktori build/cache umum yang jelas aman (`".next"`, `".turbo"`, `".cache"`, `"coverage"`) ke `SKIP_DIRS` supaya monorepo normal tidak boros kuota `MAX_SCAN_DIRS` *(cek apakah aman terhadap test existing — jangan skip folder yang bisa berisi `.env` pengguna)*.
   - Di `runInDocker` & `runInOsSandbox`: bila `targets.truncated` bernilai `true`, fail-closed (`throw new Error(...)`) atau tolak start sandbox aktif sesuai kontrak fail-closed modul sandbox agar monorepo raksasa tidak berjalan dengan `.env*` tak termasking diam-diam.
   - **Test:** uji tree melebihi `MAX_SCAN_DEPTH` di `test/sandbox.test.ts` memicu `truncated: true` dan sandbox menolak start fail-closed (atau pakai DI scan limit agar cepat dan deterministik tanpa membuat 2.000 folder!).

3. **`P1-9` (`src/runtime/process-supervision.ts:233-246`, `src/lsp/client.ts:242-393`):**
   - Tambah `unregister(childId: string)` (atau reset state saat registrasi ulang **hanya** untuk instance yang benar-benar baru!) dengan mekanisme aman anti-infinite-loop:
     - Pada `LspConnection`, simpan satu object handle stabil `private readonly managed = this.buildManagedChild()` alih-alih membuat object literal baru tiap pemanggilan `managedChild()`.
     - Saat `LspConnection.stop()` dipanggil eksplisit (`stopping = true`), bersihkan dari `processSupervision` bila `unregister` tersedia.
     - Pada `createProcessSupervision`: sediakan `unregister(childId)` yang menghapus `children`, `attempts`, `exits`, `lastExitAt`, dan `escalated` untuk `childId`; dan di `register(child)`, jika `const prev = children.get(child.id)` sudah ada **dan `prev !== child`**, reset ledger per-id (`attempts`, `exits`, `lastExitAt`, `escalated`) sebagai child instance baru — sementara bila `prev === child` (restart internal `child` yang sama), **pertahankan** seluruh penghitung percobaan!
   - **Test:** uji di `test/p13-runtime-supervision.test.ts`:
     1. Restart berulang `LspConnection` yang sama **tetap** mencapai `maxAttempts` lalu dieskalasi (tidak loop abadi).
     2. Instance `ManagedChild` baru (atau setelah `unregister`) di-register pada supervisor yang sama memperoleh anggaran restart segar.

4. **`CLI-01` (`cli/args.ts:181-206, 411-432` dan `cli/index.ts:262-277`):**
   - Refactor `hasHelpFlag(argv)` memakai scanner flag sadar `valueFlags` + prompt/subcommand boundary + `--` end-of-options (analog `allowLocalSubcommand` + `hasFlag`, hanya skip token positional subcommand terdepan bila ada atau sediakan helper `hasGlobalHelpFlag` vs `hasSubcommandHelpFlag` agar `--model --help` terbaca sebagai nilai `--model`, bukan help!).
   - Perbarui `cli/index.ts:262-270` agar tidak pakai raw `args.includes("--help")`/`args.includes("--tui")`/`args.includes("--json")`, melainkan helper sadar value-flag & boundary prompt; pastikan order check `missingValueFlags`/`unknownFlagsBeforePrompt` konsisten.
   - Pada `unknownFlagsBeforePrompt(argv)` (`cli/args.ts:411-431`): alih-alih hanya mengecek `if (a.startsWith("--"))` dan langsung `break` pada `-x`, tangkap juga unknown short flag `a.startsWith("-") && a.length > 1 && !/^-?\d+(\.\d+)?$/.test(a)` sebagai unknown option sebelum prompt (konsisten dengan `docs/cli.md:148-158`).
   - **Test:** uji di `test/cli-args.test.ts`: `--model --help`, `"jelaskan --help"`, `-x`, `-xyz` sebelum prompt vs angka negatif `-123` di posisi prompt.

5. **`DOCS-01` (`docs-en/*.md`):**
   - Sinkronkan halaman `docs-en/` yang tertinggal dengan kode & `docs/`:
     - `docs-en/tools.md`: pool `5`, budget `24/40/64/100` (`[24, 600]`, eskalasi `[24,40,64,100,150,250,400,600]`), timeout `3,600,000 ms`.
     - `docs-en/agents.md`, `docs-en/environment.md`, `docs-en/cli.md`, `docs-en/choosing-mode.md`, `docs-en/repl.md`, `docs-en/contributing.md`: selaraskan angka timeout/pool/cap/mode (`DISCUSS`/`PLAN`/`BUILD`), `/logs`, serta budget paket (`5,250 KiB`).
     - `docs-en/README.md` & `docs-en/SUMMARY.md`: perbaiki tautan `TERMINAL_CONTRACT.md` agar mengarah eksplisit ke `../docs/TERMINAL_CONTRACT.md` (tidak broken link).
   - Verifikasi seluruh tautan `.md` lintas `docs/` dan `docs-en/` tidak ada yang rusak (0 KiB tambahan ke npm pack).

6. **`TOOL-02` (`src/tools/glob.ts:7-37`):**
   - Di `globToRegExp(glob)`: tolak atau normalisasi NUL byte di awal (`if (glob.includes("\0")) throw new Error(...)` atau gunakan parser karakter/token berbasis indeks alih-alih sentinel NUL di string) sehingga argumen JSON yang menyelundupkan `\0BRACE_START\0` tidak pernah mengubah sintaks RegExp.
   - **Test:** regresi di `test/tool-audit-fixes.test.ts` menguji input glob berisi `\0` / `\0BRACE_START\0`.

---

### Gelombang 3 — Benchmark P0-6, Dokumentasi Gate, & Keputusan Pack Budget (`PACK-01`)

1. **`P0-6` — Benchmark ReDoS Dot-All → Keputusan Konkret:**
   - Jalankan micro-benchmark di skrip/test sementara (`10.000` penanda `-----BEGIN PRIVATE KEY-----` tak berpasangan pada 2 MiB, serta `10.000` `<script>` & `<entry>` tak berpasangan pada 2 MiB) pada runtime Bun saat ini.
   - Jika terbukti lambat (mis. `> 50–100 ms`), ganti pola dot-all di:
     - `src/policy/scrub.ts:24` (PEM private key block) dengan pemindai `indexOf("-----BEGIN ", ...)` → cari pasangan `-----END ... PRIVATE KEY-----` linear terikat;
     - `src/tools/web_fetch.ts:17-18` (`<!--...-->` dan `<script|style|noscript|svg>`) dengan pemindai tag linear `indexOf`;
     - `src/tools/web_search.ts:427` (`<entry>...</entry>`) dengan iterasi `indexOf("<entry", ...)` / `</entry>`.
   - Pertahankan coverage floor `scrub.ts` (`>=95/95`).

2. **`GATE-02` — Klarifikasi `gate:eval` vs `gate:fast`:**
   - Tambahkan catatan jelas di `docs/verify-benchmark.md` (dan `docs/contributing.md` bila perlu) bahwa `gate:fast` adalah gate deterministik/offline tanpa API key (menguji smoke `--fake` + penolakan `--fake` pada `eval-gate`), sedangkan `bun run gate:eval` adalah gate kualitas model pasca-`bun run bench` nyata.

3. **`PACK-01` — Penanganan Kelebihan Budget Tarball (+60 KiB saat ini):**
   - Setelah Gelombang 0–2 selesai, ukur ulang `npm pack --dry-run --json` dan periksa daftar file dalam tarball (`346` berkas, saat ini `5.310 KiB` vs `PACK_SIZE_BUDGET_KIB = 5250`).
   - Konsultasikan ke pemilik sebelum mengubah apa pun pada budget (`AGENTS.md` mewajibkan bukti + persetujuan pemilik):
     - **Opsi A:** keluarkan dokumen arsitektur/audit internal tertentu dari `package.json` `"files"` (atau arsipkan/kompresi manual spesifikasi panjang non-CLI jika tidak dibutuhkan di paket npm) sehingga tetap `< 5250 KiB`; atau
     - **Opsi B:** catat bukti ukuran baru + rincian modul di `scripts/pack-budget.ts` dan minta persetujuan pemilik menaikkan `PACK_SIZE_BUDGET_KIB`.

---

## Strategi Verifikasi
- **Per gelombang (lokal):** `bun x tsc --noEmit` + `bun test --timeout 15000` pada seluruh suite yang relevan di setiap gelombang + `test/ui-boundary.test.ts`.
- **Gate penuh (`bun run gate:fast` + `bun run audit:harness` + cek workflow/pack):** hanya dijalankan **setelah seluruh gelombang selesai dan atas aba-aba eksplisit pemilik**.
