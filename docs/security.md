# Keamanan

## Prinsip

Minicode mengontrol **kemampuan bertingkat** (layered capability control), bukan niat model.
Model boleh salah paham; yang menentukan apa yang benar-benar terjadi adalah gerbang
deterministik di bawahnya: izin → jail → guard → validasi → eksekusi → bukti.

1. **Fail-closed di jalur tak pasti**: tool tanpa backend tersedia menolak (`code_run`), sandbox yang diminta tapi tidak tersedia ditolak (fail-closed; fallback host hanya via `MINICODE_SANDBOX_ALLOW_FALLBACK=1`), provider OAuth yang belum login dibuang dari daftar, auth non-TTY fail-fast.
2. **Ukur, bukan klaim**: bash-guard divalidasi korpus manual pola serangan + perintah sah — jalankan `bun run gate:bash` untuk angka terkini (exit 0 = 0 bypass / 0 over-block).
3. **Teks eksternal = tidak terpercaya**: output tool, MCP, web, bahkan output verify dibungkus fence; `sanitizeAnsi` menyaring escape ANSI dari teks model/tool sebelum render — termasuk label picker & daftar manager, nama child agent, dan gema dialog approval. Sanitasi adalah satu-satunya gerbangnya (modul geometri sengaja mempertahankan sekuens utuh untuk CHA non-SGR di footer).
4. **Permission mengontrol pemanggilan, bukan capability**: di ASK, satu approval hanya mencakup pasangan server+tool+args (MCP); capability di balik server tak bisa diketahui statis.

## Execution Chain

Setiap pemanggilan tool melewati rantai ini, berurutan:

```
Permission → Jail → Bash Guard → Argument Validation → Executor → Journal / Recovery
```

| Tahap | Fungsi |
|---|---|
| **Permission** | Mode izin (`src/policy/permission.ts`) memutuskan allow/deny/ask per pasangan tool+args. Berlaku SEBELUM efek apa pun. |
| **Jail** | Path di luar workspace, symlink keluar, dan file sensitif (`.env`, `.git/config`) ditolak — **bahkan di `--allow-all`** (kecuali mode `unrestricted`, lihat §Mode dan akses di bawah). Sejak keputusan owner 2026-11-23, `.minicode/` umum **boleh ditulis** lewat file tool maupun shell; yang tetap ditolak hanya skrip `.minicode/hooks/**` + file sensitif (`auth.json`). |
| **Bash Guard** | Perintah shell dinormalisasi dulu (buang quote/wrapper/variabel sederhana), baru diperiksa polanya. Tokenizer sadar-platform (`src/policy/shell-tokenize.ts`: quote `'`/backslash pada POSIX, caret `^` pada Windows, single-quote literal) memecah argumen sebelum **denylist verba mutasi** dijalankan mendahului allowlist. Menolak env-dump, exfiltrasi upload, interpreter inline, destruksi luas. |
| **Argument Validation** | Skema argumen divalidasi kernel sebelum eksekusi; argumen invalid ditolak tanpa efek. |
| **Executor** | Menjalankan yang lolos: read paralel, write dibatasi konkurensinya, abort-aware, output dipotong dengan penanda (tak pernah diam-diam). |
| **Journal / Recovery** | Tiap mutasi dicatat sebagai `pending` lalu `committed`/`failed`/`unknown`; finalisasi menandai cakupan turn durable. Resume tak pernah mengulang buta (lihat [Checkpoint & recovery](#checkpoint--recovery)). |

## Mode dan akses

Kontrol mode punya tiga sumbu: **WorkMode** (`DISCUSS`/`BUILD`, dengan `PLAN` sebagai nilai legacy yang dinormalkan ke `DISCUSS`) membatasi cara kerja agent; **PermissionMode** (`AUTO`/`ASK`) menentukan kapan dibutuhkan persetujuan manusia; **Tool Access Policy** menentukan capability yang tersedia. Nilai internal `readonly`, `plan`, `allowlist`, dan `allow-all` masih ada untuk batas akses dan kompatibilitas, tetapi bukan empat mode pengawasan tambahan. Hard deny path jail, file sensitif, `.minicode/hooks/**`, dan bash-guard tetap berlaku (sejak 2026-11-23 `.minicode/` umum boleh ditulis). Detail kombinasi dan interface ada di [Memilih Mode](choosing-mode.md) dan [Policy & Sandbox](policy-sandbox.md).

**Binding approval.** Saat memverifikasi target yang disetujui, guard membedakan target yang tak terbaca (`UNREADABLE_TARGET`) dari target yang memang tak ada (`MISSING_TARGET`) atau bukan berkas (`NOT_A_FILE`) — approval tidak boleh diam-diam dianggap cocok untuk target yang gagal dibaca.

## Lapisan perlindungan bash

1. **Bash-guard ternormalisasi** (`src/policy/bash-guard.ts`) menormalisasi command sebelum aturan diterapkan: tokenizer sadar-platform (`src/policy/shell-tokenize.ts` — quote `'`/backslash pada POSIX, caret `^` pada Windows, single-quote dianggap literal) memisahkan argumen, lalu **denylist verba mutasi** (`del`/`mv`/`Remove-Item`/`rm` …) dijalankan **sebelum** allowlist, sehingga perintah berbahaya tak bisa disamarkan lewat bentuk yang tampak jinak. Tabel bypass termasuk redirect, ekspansi env Windows, hardlink, escape caret, dan pembaca `for /f` ada di [Policy & Sandbox](policy-sandbox.md), satu sumber contoh. `bun run gate:bash` mengukur regresi.

2. **Allowlist** — diperiksa SETELAH tokenizer platform-aware dan **denylist verba mutasi** (`del`/`mv`/`Remove-Item`/`rm`/`cp`). Daftar lengkap pola perintah untuk mode **Narrow** (`--allowlist`, termasuk subcommand `agent-browser` dan catatan override config/env `MINICODE_BASH_ALLOWLIST`) serta mode **Developer** (`restrictBash`) dirinci pada satu sumber di [Policy & Sandbox](policy-sandbox.md#bash-guard-ternormalisasi). Aturan kunci yang berlaku lintas keduanya: perintah majemuk diperiksa per segmen; `npm exec`/`npx`/`bun run`/`bun x` tidak boleh ekspansi shell atau redirection; eval inline (`-e`/`--eval`/`-c`/`-r`/`--require`) dan verba rilis-registry (`npm publish`, `cargo publish`, `docker push`, …) ditolak di semua mode; package manager mengeksekusi lifecycle script registry sehingga isolasi nyata tetap membutuhkan `--sandbox docker`; serta `git --no-index/--exec-path/--upload-pack/--receive-pack`, `ext::`, dan `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_*` inline ditolak guard.
3. **Path jail** realpath-based + symlink check; pembaca membuka target canonical, memakai `O_NOFOLLOW` pada POSIX, lalu mencocokkan `dev+ino` antara stat sebelum open dan handle setelah open (termasuk Windows). `.env`/`.git/config`/`node_modules`/hive Windows (`system32\config\sam|system|security|software`, `ntds.dit`) deny; berlaku bahkan `--allow-all`.
4. **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final. `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` **tetap ada** (pernah terhapus dan memecahkan build CI), sementara `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` di-strip. Bila non-rahasia ikut hilang, itu bug — laporkan nama variabelnya.
5. **web_fetch/web_search**: redirect manual ≤5 hop + resolve DNS tanpa cache per hop (anti-rebinding) + body cap 2 MB. Host privat ditolak (sama untuk MCP HTTP). Sinkronisasi harga memakai `fetchPinnedUrl`: IP hasil resolve di-pin ke socket (resolve-once), DNS strict/noCache, host privat dan redirect ditolak, cap 12 MiB. **Residual:** summarizer kompat-OpenAI masih memakai `fetch` global, belum lewat pinning ini.

`grep` memakai ripgrep bila tersedia. Biner di-resolve dari PATH absolut yang
tepercaya, environment child disanitasi, dan config eksternal dinonaktifkan
(`--no-config`, tanpa `RIPGREP_CONFIG_PATH`). Config ripgrep mendukung
preprocessor yang mengeksekusi program per berkas; karena itu tool pencarian
tidak mewarisi konfigurasi tersebut.

## Prompt injection

- Output verify dibungkus fence agar instruksi di error build tidak diikuti model. Verifier membatasi output (`maxBuffer` 32 MB); ENOENT/over-buffer diklasifikasikan `infraFailure`, timeout sebagai `timedOut` — keduanya transien, bukan kegagalan assertion.
- `mcp_read`/`mcp_prompt` di-gate meski read-only — konten pihak ketiga langsung ke konteks = jalur injection; "read-only ≠ aman".
- Secret scrubber meredaksi `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` sebelum teks ke LLM (read_file/bash/grep), tanpa whitelist kata.
- Bypass korpus: `bun run gate:bash`. Batas jujur: analisis statis atas bahasa Turing-complete; `$(curl …)` dinamis perlu sandbox OS/docker.

## Batas kepercayaan file lokal (trust model)

Agen berjalan SEBAGAI user — tidak ada batas privilege antara agen dan pemilik
mesin. Yang dilindungi guard adalah **niat operator**, bukan capability:
konten yang dibaca agen bisa memengaruhi keputusan dan ikut terkirim ke
provider model pihak ketiga.

- `MEMORY.md` (.minicode/, root, home), `AGENTS.md`, `rules/`, skills: **input
  tepercaya yang boleh diedit manusia** — termasuk edit langsung via file.
  Tulis out-of-band (di luar `write_memory`) ikut termuat apa adanya pada
  retrieval berikutnya. Jangan taruh instruksi dari repo tak dikenal tanpa
  dibaca; `forget_memory` menjangkau vector store + `.minicode/MEMORY.md` di
  scope lokal DAN global (keduanya ikut di-search) — hierarki baca
  `MEMORY.md` root/`CLAUDE.md` tidak ikut terhapus.
- `sessions.db` + jurnal: transkrip sesi tersimpan plaintext di workspace
  (terbaca agen mana pun di workspace itu). Jurnal 0-byte = sesi terpasang
  yang belum bermutasi (by-design, bukan korupsi).
- State milik runtime (`.minicode/` — DB, todos, plans, checkpoints, jurnal,
  traces, allowlist, config): sejak keputusan owner 2026-11-23 **boleh ditulis**
  agen lewat file tool maupun redirection shell; jail workspace & rahasia tetap,
  dan jangan menimpa `sessions.db`/config sembarangan. Baca tetap boleh
  (observability). `isOwnedState()`/`isOwnedStateReal()` kini dipakai untuk
  deteksi/filtrasi, bukan kunci tulis.
- Skrip hooks `.minicode/hooks/` **tetap terkunci** untuk penulisan — satu-satunya sudut `.minicode/` yang masih dilarang (audit
  2026-11-12, ditegaskan 2026-11-23). Hook adalah kode arbitrer di luar permission system yang
  dieksekusi OTOMATIS lewat scan direktori saat opt-in `MINICODE_HOOKS=1`
  (hanya WorkMode `EXECUTE`, timeout 5 dtk, env disanitasi). Kalau file tool
  boleh menulis ke sana, model/prompt-injection bisa menanam hook lalu
  menjalankannya di sesi yang sama — jadi skrip hook dibuat operator di luar
  sesi. Repo clone-an yang sudah memuat `.minicode/hooks/*.js` tetap harus
  diperlakukan sebagai config lokal tak tepercaya: periksa isinya sebelum
  menyalakan `MINICODE_HOOKS=1`.
- **Catatan jujur guard hook:** kunci tulis di permission layer untuk
  `.minicode/hooks/**` **bukan boundary keamanan** terhadap kode yang dieksekusi
  agen. Misalnya `node script.js` bisa menulis ke `.minicode/hooks/` lewat `fs`
  langsung dan melewati file-tool guard sepenuhnya — jangan mengira hook tidak bisa ditulis
  ditanam hanya karena file tool diblokir. `MINICODE_HOOKS=1` tetap keputusan
  operator sadar yang menyetujui risiko ini (ditegaskan owner 2026-11-23;
  rincian di `.audit/decisions-2026-11-23.md`). Ini risiko yang sudah diterima
  owner, bukan jaminan isolasi.

## Config lokal & supply chain

- Config lokal `.minicode/config.json` + allowlist **diabaikan secara default** — repo clone-an tidak bisa men-spawn MCP, menyedot prompt, atau memasang hook. Percayai dengan `--allow-local-config`.
- Server MCP terdaftar tidak mendapat wildcard auto-allow. Capability tetap harus diotorisasi; di ASK pemanggilan yang digate meminta persetujuan per pasangan server+tool+args, sedangkan AUTO menjalankan capability authorized tanpa prompt rutin. `[a] Always` menyimpan cakupan yang disetujui ke allowlist.
- Config/allowlist/auth ditulis atomik + chmod 600; token OAuth terpisah di `~/.minicode/auth.json` (bukan config yang rawan ter-commit).
- Daemon menaruh `bootstrap` secret di `<cwd>/.minicode/daemon-endpoint.json` (`0600`). Di Windows mode POSIX diabaikan, jadi ACL berkas itu dicabut dari warisan dan dibatasi ke user pemilik via `icacls` (best-effort). Residual: pada mesin multi-user Windows di mana `icacls` gagal, user lain yang bisa membaca folder repo masih bisa membaca secret dan menerbitkan capability daemon (loopback, bukan remote). Endpoint/secret tetap mendapat ACL penuh ini; **`writeEndpoint` tidak boleh kehilangan hardening**.
- File lease `<cwd>/.minicode/daemon-lease.json` **sengaja tidak dipanggil `hardenAcl`**: isinya bukan secret, dan penulisan atomik (`tmp` + `renameSync`) menciptakan inode baru sehingga ACL yang dipasang pada inode lama tidak otomatis melekat. Perlindungannya = mode `0600` + direktori `.minicode` `0700` + validasi bentuk di `readLease` (`version`, `incarnation`, `updatedAt`); jangan pernah menyimpan bootstrap/capability di sini. Dua aturan penemuan tetap berlaku: **PID bukan otoritas** (dapat didaur ulang OS, hanya untuk diagnostik), dan **recency bukan liveness** (lease segar hanya "suspect"; status hidup harus dibuktikan probe koneksi oleh pemanggil).
- `mcp serve` stdio-only (tanpa mode HTTP → tanpa permukaan jaringan), curated tools, permission aktif; `--all-tools` opt-in operator.

## Checkpoint & recovery

Setiap turn checkpoint shadow-git + recovery journal `.minicode/journal-<sesi>.jsonl` (`pending` → `committed`/`failed`/`unknown`; finalisasi menandai cakupan turn durable). Saat resume: `committed` yang turn-nya hilang tidak diulang; `pending`/`failed`/`unknown` → direktif verifikasi, dilarang redo buta; `committed` MCP = external-acknowledged wajib baca-balik. Restore fail-closed: baca diff yang gagal melempar error (bukan menganggap "identical"), dan `rm` yang gagal menghasilkan `skipped: remove failed: <code>` (bukan `(removed)`). Detail di [Memory & Sessions](memory-sessions.md).

## Dangerous Capabilities

Minicode **tidak menyediakan tool** untuk (terverifikasi di `src/tools/`):

- `git fetch`, `pull`, `clone` — tak ada tool git jaringan pembaca
- `git reset`, `amend`, `rebase`, `branch -D`, `stash drop`
- Eksekusi remote / deploy bawaan

Satu-satunya operasi jaringan git adalah `git_push` (di-gate seperti `git_commit`: TTY minta sekali, non-TTY tolak, `readonly/plan/allowlist` tolak, sub-agent tidak mendapatkannya). Tool ini memakai hardening `GIT_SAFE_BASE` dan di mode `unrestricted` mendapat kredensial git sempit (lihat §Mode dan akses).

Tool git-write lain yang **di-gate** seperti `git_commit`: `git_restore` dan `git_checkout` (v7.38). Keduanya sengaja SEMPIT — satu `path`, tanpa branch switching / `--force` / hapus ref; argumen dibangun sebagai argv array dan lewat `runGit` yang menetralkan hook/filter repo, dengan fail-closed untuk path luar root/sensitif/owned-state. `git_checkout` hanya path-restore (`git checkout -- <path>`), bukan `git checkout <branch>` — switch branch mengubah seluruh working tree dan bisa menimpa kerja user.

Catatan jujur: operasi lain tetap BISA diketik lewat `bash` (tunduk pada bash-guard + jail, BUKAN larangan). `git` via bash menjalankan konfigurasi repo apa adanya (hook/filter/driver milik repo). Tool baca `git_*` dinetralkan; `git_push` menetralkan hook/filter via `GIT_SAFE_BASE`; `git_commit` menolak sebelum staging bila filter Git terkonfigurasi. Di repo tak-terpercaya, utamakan tool baca dan tinjau konfigurasi sebelum memakai Git manual.

## Limitations

- **Repo hooks/filter/driver:** `git` via bash mengeksekusinya (semantik stock-git); tool baca `git_*` menetralkan filter, sedangkan `git_commit` menolak bila menemukan filter terkonfigurasi.
- **Bash arbitrer:** guard adalah analisis statis; substitusi dinamis (`$(curl …)`) butuh sandbox OS/docker untuk isolasi nyata.
- **Efek eksternal MCP:** setelah terjadi, tak bisa dibatalkan dari sini.
- **Provider/network:** data melewati provider pilihan Anda; Minicode tak menambahkan transmisi sendiri.
- **Perilaku model:** pemilihan tool, klaim sukses, dan kepatuhan intent adalah sifat model — orkestrasi menjamin bukti dan batas, bukan kebijaksanaan.
- **Server LSP:** di-spawn dari perintah di config Anda; hanya daftarkan server yang Anda percaya.
- **Repo tak-terpercaya:** perlakukan seperti menjalankan `git`/`bash` manual di sana — karena memang itu yang terjadi di balik tool.

## Security Contact

Belum ada kontak keamanan privat. Laporkan masalah via [GitHub Issues](https://github.com/minilabs-id/minicode/issues) **tanpa menyertakan kredensial, token, atau data sensitif** — cukup langkah reproduksi minimal + output `minicode doctor`.

## Lanjut

- [Keamanan](security.md) — rantai eksekusi, trust boundary, dan limitasi dalam satu halaman.
- [Policy & Sandbox](policy-sandbox.md) — mode, tool access policy, dan detail guard.
- [Kontrak Terminal](TERMINAL_CONTRACT.md) — kenapa warna di-gate TTY.
- [Otomasi & CI](exec.md) — batasan agent di CI (fail-closed non-TTY).
