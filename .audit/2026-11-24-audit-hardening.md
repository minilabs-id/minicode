# Audit Hardening & Keamanan MiniCode — 2026-11-24

- **HEAD:** `2c7649c` (`release: 0.43.3`) + working tree pasca-0.43.3.
- **Sifat audit:** read-only menyeluruh di seluruh permukaan serangan (policy, path jail, bash-guard, tokenizer shell, git-hardening, tools, SSRF/network, sandbox, sub-agent, MCP, LSP, daemon/IPC, hooks, config, auto-update, sanitasi ANSI). Tidak ada kode yang diubah; `gate:fast` tidak dijalankan.
- **Catatan batas keputusan owner:** Risiko yang sudah **secara eksplisit diterima** di `.audit/decisions-2026-11-23.md` (penulisan `.minicode/**` umum oleh agen, guard hook bukan boundary terhadap `node script.js`, `agent-browser eval`/`mcp` di allowlist) **tidak** diulang sebagai bug baru. Laporan ini hanya memuat celah yang melanggar invariant yang dinyatakan atau membahayakan host/kredensial di luar keputusan tersebut.

---

## P0 — Kritis (RCE Host, Bypass Total Jail/Hard-Deny, Kebocoran Kredensial)

### P0-1. Auto-Update Windows CWD Hijack (`npm.cmd`) + `.npmrc` Poisoning + TOCTOU Verify/Install
- **Lokasi:** `src/policy/update-check.ts:285-289`, `308-314`, `390-395`, `473-485`; `cli/index.ts:520-554`.
- **Bukti:** Di Windows di bawah Bun, `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` tidak ada → `resolveNpmExecutable()` jatuh ke `{ cmd: "npm.cmd", shell: true }`. Baik `npm root -g` (`:393`) maupun `npm install -g` (`:473`) tidak meneruskan `opts.cwd` dan memakai `process.env` mentah.
- **Skenario:**
  1. Repo untrusted berisi `npm.cmd`: membuka `minicode` (atau `/update`) saat ada versi baru langsung mengeksekusi `<repo>\npm.cmd` (resolusi CWD-first `cmd.exe`) dengan seluruh `process.env` (API key).
  2. Lintas OS: `npm install -g` dan `npm root -g` berjalan di `cwd = <repo>`, sehingga membaca `<repo>/.npmrc` (`https-proxy`, `strict-ssl=false`, `prefix`) dan mengunduh ulang paket secara terpisah dari `verifyRoot` (TOCTOU tanpa pin tarball/SHA-512).
- **Rekomendasi:** Resolve `npm` via `resolveTrustedExecutable`, dilarang `shell: true` pada `npm.cmd`, paksa `cwd` ke direktori temp/home bersih + isolasi `--userconfig`/`--globalconfig` + `sanitizeSpawnEnv(process.env)`, dan instal dari tarball terverifikasi integrity di `verifyRoot`.

### P0-2. `grep` Bypass Sensitive-Directory Jail — Bocor `.minicode/auth.json`, `.git/config`, `.aws/credentials` di Semua Mode
- **Lokasi:** `src/tools/grep.ts:411`, `451-459`, `551`, `698-742`; `src/policy/permission.ts:1287-1291`; `src/tools/context.ts:98-113`.
- **Bukti:** `normalizeRgLine` dan jalur `--json` mengecek `isSensitive(rel)` pada path relatif terhadap `root`, bukan `resolve(root, rel)`. `resolveSearchRoot` dan `CWD_JAIL_TOOL_NAMES` tidak memeriksa `isSensitive(cwd)`, dan `isSensitive(".minicode")` / `isSensitive(".git")` bernilai `false`. Selain itu `include` ditambahkan *setelah* `--glob !.git/**` di ripgrep (aturan terakhir menang).
- **Skenario:** Bahkan di `readonly` / `DISCUSS` / `explore` sub-agent, `grep({ pattern: ".", cwd: ".minicode" })` (atau `path: ".minicode"`, `cwd: ".git"`, `cwd: ".aws"`, `cwd: ".ssh"`, atau `include: ".git/**"`) membuat `rg` melaporkan `auth.json:1:...` / `config:5:...` → `isSensitive("auth.json")` = `false` → token OAuth, kredensial git, dan kunci AWS keluar utuh (sebagian tidak tersaring `scrubSecrets`).
- **Rekomendasi:** Cek `isSensitive(resolve(root, rel))` (serta `realpath`) pada semua output `grep`, tolak `cwd`/`path` yang menunjuk `.git`, `.minicode`, `.ssh`, `.aws`, `.kube`, `.docker` (atau cek ancestor sensitif), dan letakkan `--glob !...` eksclusion *setelah* `include` (atau tolak `include` yang menyasar direktori terlarang).

### P0-3. Windows NTFS Double-Colon ADS (`::$DATA`, `::$INDEX_ALLOCATION`) Melewati Seluruh `isSensitive` & `isOwnedHook`
- **Lokasi:** `src/policy/jail.ts:20-36`, `56-73`, `84-112`; `src/lib/safe-open.ts:31-66`; `src/policy/bash-guard.ts:359-360, 1000-1016`.
- **Bukti:** `cleanPathForMatch` memakai `seg.replace(/(:[a-zA-Z0-9_.$-]+)+$/, "")`. Kuantifier `+` gagal mengupas `::` sehingga `".env::$DATA"` menjadi `".env:"` dan `"hooks::$INDEX_ALLOCATION"` menjadi `"hooks:"` — keduanya lolos `SENSITIVE_RE` dan `OWNED_HOOKS_RE`.
- **Skenario:** Di Windows, `write_file(".minicode/hooks::$INDEX_ALLOCATION/pre.js")`, `write_file(".env::$DATA")`, `type .git\config::$DATA`, dan `type .minicode\auth.json::$DATA` lolos `permission.ts`, `resolveSafePath`, dan `bash-guard`.
- **Rekomendasi:** Kupas segala suffix mulai dari `:` pertama pada setiap segmen non-drive-letter (`seg.replace(/:.*$/, "")`) dan/atau tolak path yang mengandung `:` di segmen mana pun selain drive letter `^[A-Za-z]:$` pada indeks 0.

### P0-4. Desinkronisasi Single-Quote Windows `cmd.exe` Melewati Seluruh `STATIC_DENY`, `RM_RECURSIVE`, dan Redirect Jail
- **Lokasi:** `src/policy/bash-guard.ts:87-100`, `328-349`, `508-520`; `src/tools/bash.ts:133-146`.
- **Bukti:** Di Windows `cmd.exe`, `'` adalah karakter literal, bukan pembatas kutip. Namun `stripCaretEscapes`, `blankQuotedDataArgs`, dan `findRedirectTargets` di `bash-guard.ts` tetap memasuki mode single-quote tanpa cek platform, sedangkan `detectWindowsCmdQuotingHazard` mengabaikan `'` tak berpasangan atau apostrof sesudah alfanumerik (`a'`).
- **Skenario:** `echo ' > ..\outside.txt`, `echo a' > .minicode\hooks\pre.js '`, `echo a' & del /s /q * & '`, dan `echo ' & ty^pe .e^nv` semua lolos `bash-guard`, `detectWindowsCmdQuotingHazard`, dan `permissionHandler(auto)` lalu dieksekusi penuh oleh `cmd.exe`.
- **Rekomendasi:** Jangan pernah membuka state single-quote di `bash-guard.ts` pada platform `win32` (ikuti prinsip `shell-tokenize.ts:59`), dan perketat `detectWindowsCmdQuotingHazard` agar tidak melewati `'` sebelum operator shell walau didahului alfanumerik/tanpa pasangan.

### P0-5. Bug Escape `\'` Single-Quote POSIX di `splitShellSegments` — Bypass Penuh Allowlist & `isDangerousShellVerb`
- **Lokasi:** `src/policy/shell-tokenize.ts:58-64`; `src/policy/permission.ts:586-630`.
- **Bukti:** Di dalam `if (quote === "'")`, kode menulis `if (ch === "\\" && next !== undefined) cur += cmd[++i]`. Padahal di POSIX `/bin/sh` & `bash`, backslash di dalam `'...'` **tidak** meng-escape `'`.
- **Skenario:** Di Linux/macOS, `echo '\' ; rm -rf src # '` dikembalikan sebagai **satu segmen** yang cocok `"echo *"` di `DEFAULT_BASH_ALLOWLIST` dan melewati `isDangerousShellVerb`, sementara `/bin/sh` menutup kutip pada `'` kedua dan menjalankan `rm -rf src`.
- **Rekomendasi:** Hapus cabang `ch === "\\"` di dalam `if (quote === "'")` pada `shell-tokenize.ts:61`.

### P0-6. Mode `ask`: Allowlist Dievaluasi Sebelum `bash-guard` + Wildcard `*` Tak Di-escape di `saveAlways`
- **Lokasi:** `src/policy/permission.ts:1062-1064`, `1153-1166`; `src/policy/allowlist.ts:57-65`.
- **Bukti:** `handlers.ask` menjalankan `if (matchAllowlist(call, list)) return "allow"` **sebelum** `bashDenyReason` dan `codeRunMissingSandbox`. Sementara `saveAlways` menyimpan `JSON.stringify(call.args)` mentah tanpa meng-escape `*`, lalu `allowlistRe` mengompilasi setiap `*` menjadi `.*`.
- **Skenario:** Menekan `[a] Always` pada perintah jinak yang memuat `*` (mis. `ls *.ts` atau `echo *`) menulis pola wildcard global ke `~/.minicode/allowlist.json` yang kemudian mengizinkan `echo hi; rm -rf / && cat .env` melewati `bash-guard` di sesi berikutnya.
- **Rekomendasi:** Pindahkan cek `bashDenyReason` & `codeRunMissingSandbox` **sebelum** `matchAllowlist` di `handlers.ask`, dan escape `*` (atau pakai exact-match) pada entri yang ditulis `saveAlways`.

### P0-7. Subproses `git` Tidak Di-harden (`captureGitDigest` Pra-Approval, `gpg.program`, `core.sshCommand`, `worktreeConfig`)
- **Lokasi:** `src/policy/approval-binding.ts:129-148`; `src/lib/git-hardening.ts:23-29`, `67-78`; `src/tools/git.ts:200, 258, 385, 566-583`; `src/session/checkpoint.ts:311-319`; `src/session/verification.ts:1719-1735`.
- **Bukti & Skenario:**
  1. **`captureGitDigest` pra-approval RCE:** Dipanggil sebelum user menyetujui `git_commit`/`git_push`, memakai `-c safe.directory=*`, tanpa `GIT_SAFE_BASE`, tanpa filter neutralizer, dan dengan `process.env` penuh → `.git/config` `core.fsmonitor` / clean filter langsung berjalan membawa API key. (`checkpoint.ts` dan `verification.ts` juga menjalankan `git status` tanpa filter neutralizer & tanpa `sanitizeSpawnEnv`.)
  2. **`GIT_SAFE_BASE` tidak menetralkan GPG/SSH/credential:** `.git/config` dengan `[commit] gpgSign=true` + `[gpg] program=...` mengeksekusi RCE saat `git_commit` (`--no-gpg-sign` absen); `[log] showSignature=true` + `gpg.program` mengeksekusi RCE saat `git_log`/`git_status`; `core.sshCommand`, `credential.helper`, `core.askPass`, `protocol.ext.allow`, `remote.*.receivepack` aktif saat `git_push`.
  3. **`extensions.worktreeConfig`:** `discoverFilterDrivers` memakai `git config --local --includes` yang melewatkan `.git/config.worktree`.
  4. **`git_push` eksfiltrasi & destruktif:** `remote` menerima URL bebas (`https://attacker/exfil.git`), `branch: "+main"` melakukan force-push, dan `branch: ":main"` menghapus branch remote.
- **Rekomendasi:** Tambahkan ke `GIT_SAFE_BASE`: `-c commit.gpgSign=false -c tag.gpgSign=false -c log.showSignature=false -c gpg.program= -c gpg.ssh.program= -c core.sshCommand= -c credential.helper= -c core.askPass= -c protocol.ext.allow=never` (plus `core.hooksPath=NUL` di Windows / `/dev/null` di POSIX), terapkan `GIT_SAFE_BASE` + `gitFilterNeutralizers` + `sanitizeSpawnEnv` pada `captureGitDigest`/`checkpoint`/`verification`, sertakan `--worktree` saat scan filter, dan batasi `git_push` hanya ke nama remote terkonfigurasi serta tolak refspec diawali `+` atau `:`.

### P0-8. Windows `.cmd`/`.bat` Argument Injection (BatBadBut) di `resolveSpawnTarget` (MCP & LSP)
- **Lokasi:** `src/lib/trusted-exec.ts:91-109`, `124-132`; pemanggil `src/mcp/transport.ts:37-45`, `src/lsp/client.ts:231-239`.
- **Bukti:** `quoteWinCmdArg` meng-escape `"` sebagai `\"` lalu meneruskannya ke `cmd.exe /d /s /c "${line}"`. `cmd.exe` tidak menganggap `\"` sebagai escaped quote, sehingga argumen berisi `"` + metakarakter (`&`, `|`, `>`) memutus kutip dan mengeksekusi perintah arbitrer.
- **Rekomendasi:** Tolak karakter `"` (dan `!`) pada argumen shim `.cmd`/`.bat`, atau resolve target `.js` di balik shim npm lalu spawn langsung lewat `process.execPath` (`shell: false`).

### P0-9. `--verify` Menjalankan Perintah Shell dari `<repo>/package.json` Tanpa `--allow-local-config` maupun Approval
- **Lokasi:** `cli/setup.ts:2600-2602`; `src/policy/verifier.ts:81`, `125-134`.
- **Bukti:** Meski `cfg.verifyCommand` sudah dikunci `--allow-local-config`, `detectVerifyCommand(cwd)` membaca `scripts.typecheck` / `scripts.test` dari `<repo>/package.json` secara otomatis dan mengeksekusinya via `child_process.exec()` tanpa melewati `bash-guard` atau prompt izin.
- **Rekomendasi:** Gate `detectVerifyCommand` di balik `--allow-local-config` atau minta persetujuan eksplisit sebelum `runVerify()`.

---

## P1 — Tinggi

### P1-1. Kredensial Daemon & Artefak Keamanan `.minicode/` + `.git/hooks/` Terbuka; Bypass Redirect Symlink ke `.minicode/hooks`
- **Lokasi:** `src/policy/jail.ts:10-11`; `src/policy/bash-guard.ts:886-893`; `src/daemon/discovery.ts:38-50`; `src/mcp/client.ts:261-263`.
- **Bukti:**
  - Keputusan owner `.audit/decisions-2026-11-23.md` §1 menegaskan kredensial daemon tetap `deny`, tetapi `SENSITIVE_RE` hanya memuat `.minicode/auth.json` — **tidak** memuat `daemon-endpoint.json` (menyimpan 32-byte `bootstrap` secret), `daemon-lease.json`, `mcp-schema-pins.json`, maupun `.git/hooks/*`. Model di mode `DISCUSS`/`readonly` bisa membaca `daemon-endpoint.json` (juga tak diredaksi `scrubSecrets`).
  - `bash-guard.ts:886-893` (redirection) hanya mengecek `isOwnedHook(abs)` tanpa `isOwnedHookReal(abs, containmentRoot!)` (berbeda dari `:1015`), sehingga symlink internal `link -> .minicode/hooks` + `echo ... > link/pre.js` melewati kunci hook.
- **Rekomendasi:** Tambahkan `daemon-endpoint.json`, `daemon-lease.json`, `mcp-schema-pins.json`, dan `.git/hooks/` ke `SENSITIVE_RE` (atau kunci khusus), tambahkan `isOwnedHookReal` di `bash-guard.ts:886-893`, dan lindungi `config.json`/`allowlist.json` bila diinginkan.

### P1-2. Daemon `icacls` CWD Hijack, Endpoint SSRF (`host` Bebas), & Secret `.tmp` Race
- **Lokasi:** `src/daemon/discovery.ts:97-108`, `120-125`, `134-156`, `233-243`; `cli/commands/daemon.ts:173-189`.
- **Bukti:**
  1. `hardenAcl()` memanggil bare `"icacls"` tanpa `resolveTrustedExecutable("icacls")` → CWD hijack pada `minicode daemon start` di Windows bila repo memuat `icacls.exe`.
  2. `readEndpoint(cwd)` menerima `host` string apa pun tanpa `--allow-local-config`, dan `discover()` tidak menolak `age < 0` (timestamp masa depan) → `daemon status`/`stop`/`sessions` melakukan TCP SSRF ke host arbitrer.
  3. `writeAtomic()` menulis `bootstrap` secret ke `${path}.${pid}.tmp` dengan ACL warisan sebelum `renameSync` dan baru menjalankan `icacls` sesudahnya (dengan `process.env.USERNAME` yang bisa dimutasi dan `catch {}` diam).
- **Rekomendasi:** Wajibkan `host` loopback (`127.0.0.1`/`::1`) di `readEndpoint`, tolak `age < -5000`, pakai `resolveTrustedExecutable("icacls")` + `os.userInfo().username`, dan harden ACL sebelum menulis secret.

### P1-3. Pencurian Kredensial Global (DPAPI Keystore & OAuth) via Local Repo `baseUrl` (`--allow-local-config`)
- **Lokasi:** `src/config.ts:355-373`; `src/providers/build.ts:112-137`; `src/providers/provision.ts:272-284`; `src/app/rag-layer.ts:64-77`.
- **Bukti:** Repo `.minicode/config.json` (saat `--allow-local-config`) dapat mendaftarkan provider dengan `baseUrl` milik penyerang + `"apiKey": "keystore:provider:openai"` atau `"auth": "oauth"` (`id: "qwen"`), sehingga kunci global dari DPAPI keystore / `~/.minicode/auth.json` dikirim ke server penyerang.
- **Rekomendasi:** Tandai provenance `ProviderEntry` (`global` vs `local`) dan tolak resolusi `keystore:` global / OAuth global untuk provider yang `baseUrl`-nya berasal dari config lokal repo.

### P1-4. MCP Schema Pin Drift Fail-Open & Bypass Tool Tak Terdaftar
- **Lokasi:** `src/mcp/client.ts:148-155`, `201-236`, `262`, `811-817`.
- **Bukti:** JSON korup pada `mcp-schema-pins.json` ditelan `catch {}` dan membiarkan `this.pins` kosong → sesi berikutnya diam-diam re-pin skema baru (`"pinned"`). Di `callMcpTool()`, bila `toolName` tidak ada di `conn.tools`, blok `if (tool)` dilewati dan `conn.callTool()` tetap berjalan tanpa verifikasi pin. Lokasi file pin di `<cwd>/.minicode/` juga writable oleh agen/repo.
- **Rekomendasi:** Tandai registry `corrupt = true` dan fail-closed bila file pin rusak; tolak `callMcpTool` bila `!tool`; pindahkan penyimpanan pin ke `~/.minicode/mcp-schema-pins/` (ber-key hash workspace) via `atomicWriteText`.

### P1-5. Git Pathspec Magic & Wildcard Bypass di `git_commit`, `git_restore`, `git_checkout`
- **Lokasi:** `src/tools/git.ts:380`, `660`, `694`, `275-296`.
- **Bukti:** Ketiga perintah tidak meneruskan `--literal-pathspecs` (berbeda dari baris 412/498/517). `paths: ["."]` atau `":(glob).e?v"` pada `git_commit` men-stage `.env`/`.minicode/*`; `path: "."` atau `":(top)*"` pada `git_restore`/`git_checkout` menimpa seluruh working tree.
- **Rekomendasi:** Tambahkan `--literal-pathspecs`, tolak path direktori (wajib berkas tunggal atau ekspansi tervalidasi), dan tolak pathspec diawali `:(`.

### P1-6. Celah Allowlist, `bash-guard`, dan `agent-browser` Gate
- **Lokasi:** `src/policy/permission.ts:186, 194-244, 501, 596-604, 883-900`; `src/policy/bash-guard.ts:257, 390-391, 434-455, 620-660, 931, 951-965`.
- **Celah terverifikasi:**
  - **Allowlist RCE / read / write:** `rg --pre=sh`, `sed -n "1e id"` / `"1w.minicode/hooks/x"`, `sort -o../out` / `--output=..`, `find . -fprintf ../out %p`, `diff /dev/null .env` (`diff` tak ada di `READERS`), `node -pe` (flag gabungan melewati `INLINE_INTERPRETER`), `npx -c`, `git branch -D main`, `GIT diff --no-index` (case-sensitive di Windows), dan `cd %USERPROFILE%` / `cd ~` / `cd .^.` (keluar jail).
  - **`bash-guard` bypass:** `powershell -Encoded""Command <b64>` (wrapper stripper mematahkan `STATIC_DENY`), `powershell -enc` pendek (<60 char), `for /f "eol=("`, `git -ccore.fsmonitor=...` (tanpa spasi), `Invoke-RestMethod`/`irm`, `curl -o`/`dd of=`, `patch`/`unzip`/`7z`.
  - **`agent-browser` gate bypass:** `isAgentBrowserAutoConnect` dan `isAgentBrowserInstall` mengecek string mentah (bukan `normalizeCommand`) dan hanya mengecek `npm`, sehingga `npx agent-browser --auto-""connect` dan `bun add agent-browser` / `pnpm add agent-browser` lolos tanpa blokir/prompt.
- **Rekomendasi:** Normalisasi perintah sebelum `isAgentBrowser*` dan tambahkan `bun`/`pnpm`/`yarn`; tambahkan `diff`/`patch`/`unzip`/`7z`/`irm` ke guard; periksa nilai flag `--opt=path` dan `-opath` pada `READERS`; perbaiki regex `INLINE_INTERPRETER`, `powershell -enc`, `for /f`, `GIT_DANGEROUS_CONFIG`, `cd`, dan tambah flag `/i` di Windows; keluarkan pola berbahaya (`rg --pre`, `sed -n` `e`/`w`, `git branch -D`).

### P1-7. Sandbox Masking Fail-Open, `DT_UNKNOWN`, Secret Tak Ter-mask, & Bypass macOS Seatbelt
- **Lokasi:** `src/sandbox/mask.ts:20-35, 70-129`; `src/sandbox/docker.ts:135-143`; `src/sandbox/os.ts:80-107, 143-150, 178`.
- **Bukti:**
  1. `allocateEmptyMaskFile` gagal → return `{ path: null }` → Docker & bwrap diam-diam melewati seluruh mask `.env*` (fail-open).
  2. `mask.ts:70-87` hanya memakai `Dirent.isFile()`/`isDirectory()`/`isSymbolicLink()` tanpa fallback `lstatSync` → pada filesystem `DT_UNKNOWN` (XFS lama, NFS, FUSE), seluruh `.env*` & subdirektori terlewat.
  3. Hanya `.minicode/` (jika sudah ada) dan `.env*` kedalaman ≤3 yang di-mask; `.git/config`, `.npmrc`, `*.pem`/`*.key`, dan `.env*` kedalaman ≥4 terbuka RW untuk `code_run` (yang tak melewati `bash-guard`).
  4. **macOS Seatbelt:** `(allow file-read* ... (subpath "/private/tmp"))` ditaruh *setelah* deny rules (di SBPL aturan terakhir menang → workspace di `/tmp` batal ter-deny); rename direktori (`mv sub sub2`) lolos `(literal ...)`; `resolve(cwd)` bukan `realpathSync(cwd)` dan sensitif huruf besar/kecil di APFS (`.eNv`).
- **Rekomendasi:** Fail-closed bila mask file gagal dibuat; tambahkan fallback `lstatSync` saat `DT_UNKNOWN`; mask semua file `SENSITIVE_RE` (dan blokir pembuatan `.minicode/hooks`); perbaiki urutan aturan SBPL, gunakan `realpathSync(cwd)`, dan regex case-insensitive untuk deny `.env*`.

### P1-8. Eskalasi Kapabilitas Sub-Agent & Drop `bashAllowlist` Operator
- **Lokasi:** `src/tools/task.ts:323-379, 507-534, 644-646, 724-778, 1031-1044`; `cli/setup.ts:1988-1991, 2027`.
- **Bukti:**
  - Denylist anak hanya membuang 9 tool; `git_restore`, `git_checkout`, `lsp_rename`, `mcp_call`, `mcp_read`, `mcp_prompt`, `code_run`, `delete_file`, `move_file`, `bash` tetap lolos dan di `EXECUTE × auto` langsung diizinkan tanpa approval.
  - `cfg.bashAllowlist` operator tidak diteruskan lewat `SubAgentGovernance` → anak di mode `allowlist` jatuh kembali ke `DEFAULT_BASH_ALLOWLIST` penuh.
  - `subAgentWorkMode()` fail-open ke `"EXECUTE"`, `subAgentGovernance()` fail-open ke `{}`, `parentMode` tak dikenal jatuh ke `"auto"`, dan `maxSteps` anak (600) dapat melebihi batas parent.
- **Rekomendasi:** Fail-closed ke `"DISCUSS"` / `"explore"` / `restrictBash: true`; teruskan `bashAllowlist` operator ke child; perluas denylist anak untuk tool destruktif/eksternal (`git_restore`, `git_checkout`, `lsp_rename`, `mcp_*`, `code_run`); ikat `maxSteps` anak ke sisa batas parent.

### P1-9. Symlink `.minicode/.trash` Tak Tervalidasi — Move & Delete File di Luar Workspace
- **Lokasi:** `src/lib/trash.ts:15-38`; pemanggil `src/tools/delete_file.ts:32`, `src/tools/move_file.ts:69`.
- **Bukti:** `trashFile` dan `pruneTrash` tidak mengecek apakah `.minicode` atau `.minicode/.trash` adalah symlink ke luar workspace. Jika menunjuk `/victim`, `delete_file`/`move_file` memindahkan file ke `/victim` dan `pruneTrash` menghapus file di `/victim` saat >100 entri.
- **Rekomendasi:** Verifikasi `realpathSync` untuk `.minicode` dan `.minicode/.trash` berada di dalam `root` (tolak symlink via `lstatSync`) sebelum `mkdir`/`rename`/`rm`.

---

## P2 — Sedang

1. **SSRF & HTTP hardening (`src/lib/net.ts`, `src/lib/public-http.ts`, `src/tools/web_search.ts`, `src/providers/{detect,anthropic,responses}.ts`, `src/memory/vector.ts`):**
   - `isPrivateHost` tidak mengupas trailing dot (`localhost.`, `metadata.google.internal.` lolos), melewatkan `224.0.0.0/4`, `240.0.0.0/4`, `198.18.0.0/15`, `ff00::/8`, `fec0::/10`; `isPrivateHostWithDns` short-circuit pada integer IPv4 (`2130706433`) dan default fail-open 400 ms.
   - `public-http.ts:140-156` tidak membatasi panjang rantai `Content-Encoding` (DoS zlib); jalur HTTP memakai native `fetch` yang masih menghormati `HTTP_PROXY`.
   - `web_search.ts` memakai `fetch()` mentah dengan `redirect: "follow"` tanpa SSRF check; `detect.ts`/`anthropic.ts`/`responses.ts` tanpa `redirect: "manual"` dapat membocorkan header `x-api-key` pada cross-origin redirect.
2. **Sanitasi ANSI/Terminal & MCP Metadata (`src/daemon/sanitize.ts`, `src/policy/update-check.ts`, `src/mcp/transport.ts`, `src/lsp/client.ts`, `src/tools/mcp_call.ts`):**
   - `src/daemon/sanitize.ts` dan `redactUpdateText()` melewatkan kontrol C1 (`0x80–0x9F`, termasuk 8-bit CSI `0x9B` & OSC `0x9D`), `\r`, BiDi, dan sekuens tak berpenutup.
   - `stderr` dari MCP/LSP ditulis mentah ke `process.stderr`; `mcp_list` dan `wrapTools` `description` tidak di-fence/di-scrub.
3. **Scrubbing secret & env (`src/policy/scrub.ts`):**
   - `stripSecretsEnv` meloloskan `HTTP_PROXY`/`HTTPS_PROXY` (sering berisi `user:pass@`), `MYSQL_PWD`, `PGPASS`, `DB_PASS`, `*_KEY` non-`API_KEY`, `GIT_ASKPASS`, dan nilai secret pada nama variabel non-standar.
   - `scrubSecrets` belum meredaksi `https://user:pass@host`, `mongodb+srv://`, `rediss://`, AWS STS `ASIA...`, Stripe `sk_live_...`, GitLab `glpat-...`, `BEGIN ENCRYPTED PRIVATE KEY`, dan `"bootstrap"` daemon.
4. **Daemon post-handshake & `readWriterEpoch` (`src/daemon/server.ts`, `src/daemon/control.ts`, `cli/commands/daemon.ts`):**
   - Expiry/revocation capability hanya dicek saat `#onHello`, tidak dicek ulang pada `#onControl`/`#onSubscribe`; `--ttl` tanpa batas atas; `control.ts:280` memanggil `readWriterEpoch(sid)` tanpa `cwd`.
5. **Docker & bwrap hardening (`src/sandbox/docker.ts`, `src/sandbox/os.ts`):**
   - Docker `--tmpfs /tmp` tanpa `size=,noexec,nosuid,nodev`; `--memory 512m` tanpa `--memory-swap 512m`; `-v` pecah bila path memuat `:`. Bwrap tanpa `--size` pada `--tmpfs` dan tanpa batas PID/memori.
6. **Tool TOCTOU, FIFO hang, & ReDoS (`src/lib/safe-open.ts`, `src/tools/{read_file,read_image,write_file,glob,grep}.ts`, `src/policy/permission.ts`):**
   - `read_file`/`read_image` tidak menolak FIFO/device (`!st.isFile()`), sehingga membuka FIFO menggantung libuv threadpool permanen.
   - `globToRegExp("**/**/**/**/**/**/**/**/**/**/nope")` rentan ReDoS eksponensial; `isReDosPronePattern` di `grep.ts` hanya memeriksa grup `(...)`.
   - `permission.ts:1148` (`ask` mode) mengizinkan `web_fetch`/`web_search` tanpa `gateNetworkRead`; `permission.ts:1278` cek `isSensitive` logis (bukan realpath); `write_file.ts:32-42` membuang return `assertSafeWriteTarget`.
   - `shadow-git.ts:70-81` cache neutralizer tidak memantau file `[include]` maupun `.git/config.worktree`.

---

## P3 — Rendah / Defense-in-Depth

- `src/ui/render/sanitize.ts`: tambahkan penghapusan `U+061C`, `U+200E`/`U+200F`, `U+FEFF`, `U+E0000–U+E007F`, dan blokir SGR `8` (conceal).
- `src/daemon/server.ts:132`: tegaskan bind host loopback di constructor/start.
- `src/providers/auth-store.ts:35, 96-103`: gunakan `homeDir()` (hormati `MINICODE_HOME`) dan pertimbangkan proteksi ACL Windows / DPAPI untuk token OAuth.
- `src/policy/permission.ts:1432-1473` & `src/tools/bash.ts:513-522`: scrub `call.args` di approval hook; tangani secret terbelah lintas chunk streaming bash.
- `src/lib/safe-open.ts:320-323`: bandingkan path case-insensitive pada Windows di `assertDeletableTarget`.
