# Policy & Sandbox

WorkMode, persetujuan, tool access policy, penjaga perintah shell, dan isolasi eksekusi adalah kontrol yang berbeda. Hard deny path jail, file sensitif (`.env`, `auth.json`), dan `.minicode/hooks/**` tetap berlaku di atasnya — sejak keputusan owner 2026-11-23, `.minicode/` umum boleh ditulis agen maupun shell.

## Tiga sumbu kontrol

| Sumbu | Nilai | Fungsi |
|---|---|---|
| **WorkMode** | `DISCUSS` / `BUILD` (`EXECUTE` internal) | Membatasi cara agent bekerja. `DISCUSS` read-only (+ artefak rencana); `BUILD` tidak menambah ceiling. WorkMode hanya mempersempit akses. |
| **PermissionMode** | `AUTO` / `ASK` | Menentukan pengawasan manusia. `AUTO` menjalankan capability yang diotorisasi tanpa persetujuan rutin; `ASK` meminta persetujuan untuk aksi yang digate. Hard deny tetap berlaku. |
| **Tool Access Policy** | capability read-only, allowlist, profil akses warisan | Menentukan capability yang tersedia. Nilai internal `readonly`, `plan`, `allowlist`, dan `allow-all` masih dipakai untuk kompatibilitas dan batas akses, bukan sebagai pilihan pengawasan. |

`PermissionMode` internal masih berupa union kompatibilitas yang juga memuat profil akses warisan. Untuk pilihan mode, flag, dan kombinasi yang menghadap pengguna, lihat [Memilih Mode](choosing-mode.md) dan [CLI](cli.md). Delegasi juga mewarisi batas parent; lihat [Sub-Agents & Tasks](agents.md).

Set terkait: `INTERNAL_WRITE_TOOLS`, `FILE_WRITE_TOOLS`, `GATED_TOOLS` (+ `*.*` MCP), `NO_PROMPT_TOOLS`. `move_file`/`delete_file` dijail di permission layer (berlaku semua mode termasuk `--allow-all`).

## Bash-guard ternormalisasi

`src/policy/bash-guard.ts`: quote pemisah kata dibuang dan assignment sederhana disubstitusi **sebelum** pemeriksaan. Tokenizer sadar-platform (`src/policy/shell-tokenize.ts`) memecah argumen menurut aturan shell yang bersangkutan — POSIX `'`/backslash, Windows caret `^`, single-quote literal — lalu **denylist verba mutasi** dijalankan mendahului allowlist.

| Dulu lolos | Sekarang |
|---|---|
| `cat .e""nv` | ditolak |
| `X=.env; cat $X` | ditolak |
| `p=python3; $p -c 1` | ditolak |
| `node --eval "1"` | ditolak |
| `env`, `set`, `export -p` | ditolak |
| `curl -F file=@~/.ssh/id_rsa` | ditolak |
| `echo x > ..\evil` (redirect keluar workspace) | ditolak; target redirect di-resolve ke cwd sebelum lolos allowlist |
| `echo x > "%TEMP%\evil"` | ditolak; target berisi ekspansi `%NAMA%` tak bisa dipastikan aman secara statis |
| `py -c …`, `python3.14 -c …` | ditolak bersama varian launcher dan versi Python |
| `type ..\..\windows\system32\config\sam`, `Get-Content .../ntds.dit` | ditolak (hive Windows + `reg save|export` hive + `vssadmin create|delete shadow` + `ntdsutil`; `reg query`, `vssadmin list`, `system.txt` biasa tetap lolos) |
| `write_file .minicode/<apa-pun>` | **boleh** sejak keputusan owner 2026-11-23 (kunci penuh segmen dicabut, termasuk lewat shell); yang tetap ditolak hanya `.minicode/hooks/**` + file sensitif (`.env`, `auth.json`). Jangan timpa `sessions.db`/config sembarangan — lihat [Keamanan](security.md) |
| `bash <(curl x)` | ditolak |
| `rm -rf ..`, `rm --recursive --force /`, `rm -rf /; :` | ditolak |
| `command env`, `nice env`, dkk. (wrapper) | deteksi env-dump ter-anchor ke awal | ditolak via `stripCommandWrappers` (buang wrapper berlapis) |
| Baca lewat hardlink menuju luar workspace | ditolak jika handle yang dibuka memiliki `nlink > 1`; pengecekan memakai `fstat` |
| `type .e^nv`, `ty^pe .env` (escape caret cmd.exe) | ditolak setelah caret dinormalisasi sebelum aturan nama/jail |
| `type %USERPROFILE%\notes.txt` | ditolak; argumen pembaca berpola `%NAMA%` tak bisa dipastikan aman |
| `for /f %i in (.env) do @echo %i` | ditolak; file set pada loop `for /f` ikut diperiksa |
| `cat${IFS}.env`, `cat$IFS.env`, `cat${IFS:0:1}.env` (audit 2026-11-12) | ditolak; `$IFS` adalah pemisah kata, dinormalisasi jadi spasi sebelum aturan nama |
| `cat .?nv`, `cat .[e]nv` | ditolak; glob `?`/`[]` mengembang ke nama lain sama seperti `*` |
| `cat .{env,}`, `cat {.env,x}` | ditolak; brace expansion diekspansi sebelum pemeriksaan |
| `cat$(printf ' ').env` | ditolak; argumen pembaca berupa substitusi perintah tak bisa dipastikan statis |
| `echo "rm -rf /"`, `git commit -m "docs: sudo rm"` | lolos (arah over-block); isi kutip milik echo/printf/grep/`-m` git adalah DATA, bukan perintah — kecuali memuat `$(`, backtick, atau `$VAR` yang tetap dieksekusi |
| `echo hi ' & del x '` (cmd.exe) | ditolak; tokenizer memperlakukan single-quote sebagai literal sehingga `&` di dalamnya bukan pemisah, lalu verba `del` kena denylist |
| `cat .e\nv` (POSIX backslash-quote) | ditolak; backslash meng-escape sehingga argumen menjadi `.env`, lalu aturan nama/jail tetap berlaku |
| `del x`, `mv a b`, `Remove-Item -Force x` | ditolak; verba mutasi masuk denylist sebelum allowlist, tak bisa diselundupkan lewat quote/wrapper |

Allowlist (bentuk perintah yang boleh; diperiksa SETELAH bash-guard). Sebelum allowlist, tokenizer platform-aware memecah argumen dan denylist verba mutasi (`del`/`mv`/`Remove-Item`/`rm` …) menolak perintah berbahaya lebih dulu (lihat tabel di atas). Perintah majemuk diperiksa **per segmen**: `;`, `&&`, `||`, `|`, dan newline memisahkan tahap, dan setiap tahap harus cocok sendiri (pola + aturan `npx`). Redirection netral (`2>&1`, `2>/dev/null`, `>NUL`) tidak mengubah bentuk, sedangkan `> file` ditolak (itu efek tulis). `cd` hanya sah bila target berada di dalam workspace. Pola dari `bashAllowlist` di config ikut dipakai: **menggantikan seluruh** daftar narrow, menambah daftar developer; env `MINICODE_BASH_ALLOWLIST` menang atas keduanya. Catatan operasional: bila override (env/config) aktif, daftar bawaan — termasuk penambahan `tree`/`du`/`df`/`date`/`uname` — tidak ikut dipakai; sertakan pola yang dibutuhkan di override Anda sendiri. Dua daftar bawaan:
- **Narrow** (`--allowlist`, task tak-terpercaya): `git status/diff/log/branch/show`, `bun test/run/x tsc`, `npm/bun/pnpm/yarn install|add`, `npm run/exec/install/ci/test/start`, `node`, `npx`, `ls dir cat type head tail wc grep rg find which echo pwd tree du df date uname` (pembaca sistem/inventaris `tree`/`du` tetap dibatasi ROOT_SCAN: `tree /`/`du /` ditolak). Tulis via shell (`mkdir cp mv rm touch`) ditahan — pakai `write_file`/`edit` yang ter-jail. Sejak 2026-11-23 `.minicode/` umum boleh ditulis lewat file tool maupun redirection shell, kecuali `.minicode/hooks/**`. Browser lewat bash (`agent-browser`) eksplisit diizinkan untuk subcommand sempit `open`, `snapshot`, `click`, `fill`, `errors`, `console`, `network`, `get`, `close`, `skills get core`, `--version`, `install`, `eval`, `mcp` (keputusan owner 2026-11-23; profil fresh tetap disarankan). `--auto-connect` **dicabut** — tidak dipakai; browser selalu fresh atau profil dari setingan `.minicode`. Pola `npx *` mencakup semua bentuk npx termasuk `npx agent-browser ...`, jadi tak perlu entri khusus.
- **Developer** (fallback tanpa sandbox OS — `restrictBash`; sesi trusted di mesin sendiri): narrow + runtime/interpreter luas (`python`/`node`/`ruby`/`php`/`perl`/`lua`/`julia`/`elixir`/`groovy`/`scala`/`java`/`dotnet`/`swift`/`dart`…), package manager (`pip`/`pip3`/`uv`/`pipx`/`poetry`/`pipenv`/`gem`/`bundle`/`composer`/`cargo`/`go`/`nuget`…), framework/bundler (`vite`/`next`/`nuxt`/`webpack`/`esbuild`/`rollup`…), test/lint/build (`pytest`/`ruff`/`mypy`/`jest`/`vitest`/`eslint`/`tsc`/`mvn`/`gradle`/`dotnet`/`make`/`cmake`/`gcc`…), DB CLI (`psql`/`mysql`/`sqlite3`/`prisma`…), container (`docker`/`podman`).

Contoh yang kini lolos di narrow/developer: `grep -n "x" f 2>&1 | head`, `cat a.txt | wc -l`, `sed -n '1,40p' f`, `ls -la && git status`. Contoh yang tetap ditolak: `cat f > out.txt`, `echo $(whoami)`, `sed -i s/a/b/ f`, `cd .. && ls`, dan tahap apa pun yang tak ada di daftar (mis. `curl`).

`npm exec`/`npx`/`bun run`/`bun x` tak boleh ekspansi shell (`$`, backtick) atau redirection. Runtime hanya menjalankan berkas skrip — eval inline (`-e`/`--eval`/`-c`/`-r`/`--require`) difilter guard lebih dulu untuk SEMUA interpreter (termasuk baru: `lua -e`, `julia -e`, …). **Verba rilis-registry** (`npm publish`, `cargo publish`/`login`, `gem push`, `docker push`, `mvn deploy`, `dart pub publish`, `twine upload`…) ditolak guard di SEMUA mode. Package manager menjalankan lifecycle script (postinstall/setup.py = kode arbitrer dari registry), jadi kedua daftar berstatus "trusted", bukan pengganti isolasi — isolasi sungguhan tetap `--sandbox docker`.

Ukur, bukan klaim — jalankan sendiri untuk angka terkini:

```bash
bun run gate:bash        # korpus manual pola serangan + perintah sah (0 bypass / 0 over-block = lulus)
```

Fuzz membangkitkan varian dari transformasi yang shell anggap setara (quote-split menurut aturan POSIX/Windows lewat tokenizer, backslash-quote, caret, indirection, wrapper, flag panjang, chaining); temuan terkunci sebagai regression test.

> Batas jujur: analisis statis atas bahasa Turing-complete. `$(curl …)` dinamis tak bisa diselesaikan tanpa eksekusi — untuk itu sandbox OS ada.

## Sandbox otomatis

| Kondisi | Yang terjadi |
|---|---|
| bwrap (Linux) / seatbelt (macOS) tersedia | Bash di dalamnya, tanpa flag |
| Tidak tersedia (termasuk semua Windows) | Default turun ke restrictBash (allowlist **developer**, sesi trusted); tanpa pesan `[sandbox]` — pesan itu hanya muncul untuk request `--sandbox` eksplisit |
| `--allow-all` / `--ask` / `--allowlist` diberikan | Pilihan dihormati, tanpa peringatan |
| `--sandbox none` | Opt-out sadar; tanpa downgrade |
| `--sandbox docker` | Container ephemeral (`--network none`, 512m, 1 CPU, `node:22-alpine`) |
| `--sandbox docker` tapi daemon mati | TOLAK sebelum jalan (fail-closed) + cara opt-in fallback eksplisit; tidak pura-pura terisolasi |

Container mendapat nama acak per-run. Saat batas waktu habis atau tool dibatalkan,
runner meminta daemon menjalankan `docker rm --force` dengan timeout cleanup
5 detik sebelum menghentikan penunggu CLI. Output membedakan cleanup yang
dikonfirmasi daemon dari yang tidak terkonfirmasi. Ini tidak membatalkan efek
workspace yang sudah terjadi sebelum container dihentikan.

`MINICODE_SANDBOX_STRICT=1` = tak pernah fallback host (redundan dengan default fail-closed untuk request eksplisit, tetap dihormati). `MINICODE_SANDBOX_ALLOW_FALLBACK=1` = satu-satunya jalan fallback host yang sadar bila backend tak tersedia. `MINICODE_SANDBOX_IMAGE` ganti image (default `node:22-alpine` hanya bawa node). `code_run` selalu lewat sandbox runner dan menolak bila backend tak tersedia.

## Lapisan lain

- **Path jail** realpath-based + symlink `realpath` di permission layer; `.env`/`.git/config`/`node_modules`/hive Windows deny; sejak 2026-11-23 `.minicode/` umum **boleh ditulis** agen lewat file tool maupun shell — yang tetap ditolak hanya `.minicode/hooks/**` (kunci ganda string + realpath via `isOwnedHook`/`isOwnedHookReal`, menutup junction yang menyamarkan target hook) + file sensitif. `isOwnedState()`/`isOwnedStateReal()` kini dipakai deteksi/filtrasi, bukan kunci tulis; jail workspace & rahasia tetap berlaku pada target NYATA. bash-guard menahan PEMBUATAN link yang operannya sensitif. Untuk pembacaan, `safeOpenRead` memeriksa boundary ulang setelah stat dan mencocokkan `dev+ino` dari handle yang terbuka; `O_NOFOLLOW` juga dipakai pada POSIX. Stress test symlink tetap skip bila host tidak memberi privilege membuat symlink.
- **Env scrub** `sanitizeSpawnEnv`: strip kata-kunci kredensial dari merge final; `GITHUB_WORKSPACE`/`GITHUB_REF`/`GOOGLE_CHROME_PATH`/`REDIS_HOST`/`AWS_REGION` tetap ada, `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` tetap di-strip.
- **web_fetch/web_search**: redirect manual 5 hop + resolve DNS tanpa cache per hop (anti-rebinding) + body 2 MB. Harga memakai `fetchPinnedUrl` (IP resolve di-pin ke socket, DNS strict/noCache, host privat & redirect ditolak, cap 2 MB); summarizer kompat-OpenAI masih memakai `fetch` global (residual).
- **Secret scrubber**: `sk-`, `ghp_`, `AKIA`, PEM, JWT, Bearer, `api_key=...` di-redact sebelum ke LLM (read_file/bash/grep) — tanpa whitelist kata.
- **Config/allowlist**: atomic randomUUID tmp+rename + chmod 600. MCP serve curated tools + permission aktif.
