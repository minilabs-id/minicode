# Konsep & Desain

Minicode itu apa, kenapa dibangun begitu, dan kenapa beberapa hal sengaja tidak ada. Halaman ini latar belakangnya; langkah praktis ada di [Instalasi](getting-started.md).

## Dua benda, dua peran

| Nama | Apa |
|---|---|
| **MiniCore** | Kernel runtime `STATE / MODEL / ACTION / LOOP`. Zero-dependency, di-vendor ke `vendor/minicore`; dapat diedit di host sejak v0.16.0 (angka provenance historis dicatat di `vendor/minicore/VENDOR.md`). Bukan dependency — di-resolve lewat subpath imports `#minicore` |
| **Minicode** | Layer agencode di atasnya: tools, sub-agents, skills, hooks, policy/sandbox, providers, MCP/LSP, memory, sessions, repo-map, verifier, dan CLI dengan TUI interaktif serta jalur non-interaktif shell-first |


## Loop ReAct

Setiap prompt berjalan sebagai loop `Thought → Action → Observation` sampai jawaban final, batas `--max-steps` (default 50), atau `--timeout` (default 1 jam). Model menerima system prompt berisi `# Environment` (cwd + platform), repo-map ringkas, dan memory yang relevan — lalu memilih tool, melihat hasilnya, dan memilih langkah berikutnya. Tidak ada grafik alur tersembunyi: di jalur non-interaktif jejak aksi tampil sebagai ledger di stderr; di TUI interaktif chat hanya memuat narasi, rekap kategori (mis. `3 command · 2 read · 5 subagent`), dan jawaban akhir, sementara rincian per-tool pindah ke sidebar kanan (Activity/Live/Log).

## Shell-first: non-interaktif polos, interaktif fullscreen

Minicode sengaja **tanpa library TUI pihak ketiga** (tanpa Ink/React; TUI-nya
ditulis sendiri) dan membagi dua jalur secara tegas:

- **Non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`):
  output mengalir **append-only ke scrollback** — hasil agen adalah artefak
  terminal biasa yang bisa di-pipe, di-grep, dan tersimpan di scrollback Anda
  sendiri.
- **Interaktif** (TTY mampu): satu tampilan **TUI fullscreen** alternate-screen
  — transkrip ala shell + status bar satu baris + popup komposit + sidebar kanan
  adaptif (Thinking + Activity/Live/Log) bila `cols ≥ 100` dan `rows ≥ 20`; keluar =
  buffer utama kembali persis (transkrip tidak di-dump ke scrollback).
- Warna hanya saat TTY; `NO_COLOR` selalu menang; output program tetap bersih dari cursor-control saat di-pipe.

Detail lengkap + kontrak FROZEN-nya di [Kontrak Terminal](TERMINAL_CONTRACT.md).

## Kejujuran sebagai fitur

Beberapa keputusan desain lahir dari tidak mau berpura-pura:

- **Angka tidak ditulis permanen** di dokumentasi — jalankan `bun test` / `bun run gate:coverage` / lihat CI. Halaman yang mengklaim jumlah test akan usang begitu dipush.
- **Kegagalan dilaporkan apa adanya**: `auth login` menampilkan error server tanpa dipercantik; `minicode sync`/`/provider sync` jujur `{updated, failed}`; sandbox yang tidak tersedia **tidak** dilabeli aman — default turun ke `allowlist` dengan alasan dicetak sekali.
- **Ukur, bukan klaim**: bash-guard divalidasi korpus serangan + perintah sah (jalankan `bun run gate:bash`). Lihat [Keamanan](security.md).
- **Skor benchmark dilaporkan apa adanya** beserta batas validitasnya (lingkungan, ukuran sampel). Lihat [Verify & Benchmark](verify-benchmark.md).

## Zero-dep runtime

Runtime tanpa dependency pihak ketiga; satu-satunya kebutuhan keras adalah **Bun** (`bun:sqlite` dipakai langsung — tidak jalan di Node.js). Parser markdown web, renderer tabel/diff, dan highlight juga mini buatan sendiri, bukan library. Manfaatnya: audit permukaan lebih kecil, install cepat, dan supply-chain yang bisa dibaca sambil duduk.

## Bahasa

Dokumentasi dan komentar kode berbahasa **Indonesia** dengan istilah teknis tetap English (`provider`, `checkpoint`, `sandbox`, `jail`). Tabel di bawah mengunci makna istilah yang paling sering dipakai.

## Glosarium

Istilah MiniCode yang punya makna spesifik. Dokumentasi berbahasa Indonesia dengan
istilah teknis English — tabel ini mengunci maknanya.

| Istilah | Makna |
|---|---|
| **MiniCore** | Kernel runtime `STATE / MODEL / ACTION / LOOP` di-vendor ke `vendor/minicore`; inti beku, zero-dep, di-resolve via `#minicore` |
| **Minicode** | Layer agencode di atas MiniCore: tools, agents, policy, providers, memory, sessions, CLI |
| **Tool** | Kemampuan yang dipilih model dalam loop ReAct; tool MCP dapat ditambahkan dinamis sebagai `serverId.toolName` |
| **Tool scope** | `full` atau subset read-only `explore` — flag `--tool-scope` |
| **WorkMode** | Cara agent bekerja: `DISCUSS` atau `BUILD` (alias produk untuk identitas internal `EXECUTE`). Nilai `PLAN` adalah legacy dan dinormalkan ke `DISCUSS` |
| **PermissionMode** | Pilihan pengawasan: `AUTO` menjalankan capability yang diotorisasi; `ASK` meminta persetujuan untuk aksi yang digate |
| **Tool Access Policy** | Batas capability yang tersedia, seperti read-only, allowlist, atau profil akses warisan `--allow-all` |
| **Gate** | Tool wajib persetujuan manusia saat TTY; non-TTY selalu tolak (mis. `git_commit`, MCP, `delegate_task`) |
| **Path jail** | Pembatasan akses file ke workspace (realpath + symlink; `O_NOFOLLOW` pada POSIX dan pencocokan identitas handle `dev+ino` pada semua platform); aktif bahkan `--allow-all` |
| **Bash-guard** | Tokenizer shell sadar-platform + denylist kata kerja mutasi: normalisasi + blokir pola bash berbahaya sebelum eksekusi (quote-split, indirection, wrapper) |
| **Sandbox OS** | bubblewrap (Linux) / seatbelt (macOS) — otomatis bila tersedia |
| **Sandbox Docker** | Container ephemeral `--network none`, 512m, 1 CPU, `node:22-alpine` |
| **Checkpoint** | Snapshot per turn via shadow-git: SHA tree di `refs/minicode/…` (O(delta), HEAD/index tak tersentuh) |
| **Recovery journal** | `journal-<sesi>.jsonl`: `pending` → `committed`/`failed`/`unknown`; finalisasi menandai cakupan turn yang sudah durable |
| **Session** | Riwayat tersimpan di `.minicode/sessions.db` (SQLite WAL); kompaksi dapat mengganti bagian lama dengan ringkasan + tail |
| **Memory dua lapis** | `MEMORY.md` hierarki (selalu ke system prompt) + vector RAG hybrid (injeksi bila skor ≥ ambang) |
| **RAG hybrid** | Pencarian memory cosine 0.7 + keyword 0.3, ranking MMR (λ 0.7), dedup >0.92 |
| **Repo-map** | Simbol per file (regex 9 bahasa, fallback LSP) disuntik ke system prompt |
| **Skill** | Prompt terpaket `.minicode/skills/*.md` dengan frontmatter `name`/`description` |
| **Hook** | Skrip `pre/post-run` dari `~/.minicode/hooks` + `.minicode/hooks`; mati default, `MINICODE_HOOKS=1` |
| **Env scrub** | `sanitizeSpawnEnv` menghapus kata-kunci kredensial dari env subprocess |
| **Secret scrubber** | Redaksi `sk-`/`ghp_`/`AKIA`/PEM/JWT/Bearer sebelum teks ke LLM |
| **Ledger** | Jejak aksi agent: di jalur non-interaktif berupa baris `  › name target` / `  › name: …` di stderr; di TUI interaktif rinciannya pindah ke sidebar kanan (Activity/Live/Log), chat hanya rekap kategori |
| **Scrollback** | Riwayat layar terminal; jalur non-interaktif minicode append-only di sana (interaktif pakai alternate screen) |
| **Transient** | UI muncul-sekali yang menghapus dirinya (spinner, garis status turn, micro-toast retry `retry n/total · Ns` dengan TTL 4 dtk) — vs transkrip yang menetap |
| **Sidebar kanan** | Panel adaptif di TUI (Thinking + Activity/Live/Log); aktif bila `cols ≥ 100` dan `rows ≥ 20`, lebar 30–50%, tinggi Thinking:Activity 60:40 — bagian dari frame `paint()` yang sama, bukan scrollback |
| **Rekap kategori** | Ringkasan per-tool di chat (mis. `3 command · 2 read · 5 subagent`) yang menggantikan ledger per-tool, baris `Tool:`, `/expand`, dan buffer terlipat |
| **Micro-toast retry** | Satu notifikasi footer `retry n/total · Ns` (TTL 4 dtk, counter langsung) untuk retry — menggantikan toast panjang |
| **Delegation scope** | `file`/`dir`/`subtree`/`repo` → budget 12/18/26/36 langkah; `plan` ×1,5 di-clamp ke [8,50] (repo+plan = 50); eskalasi `[8,12,20,32,50]` bila mentok — `maxSteps` eksplisit mematikan eskalasi; tanpa scope fallback 5/15 |
| **Composition root** | `cli/index.ts` + `cli/setup.ts`: satu tempat wiring DI (provider, RAG, session, tools) |
| **Seam aditif** | Satu-satunya patch yang dibolehkan ke kernel beku: `compactAsync`, `initialMessages`, `cwd` |
| **Self-contained** | Tanpa clone repo lain — kernel di-vendor, runtime zero-dep, butuh Bun ≥ 1.1.13 |

## Lanjut

- [Arsitektur](architecture.md) — tiga lapisan, boundary, alur satu prompt.
- [Instalasi & Quickstart](getting-started.md) — dari nol ke prompt pertama yang ter-verify.
