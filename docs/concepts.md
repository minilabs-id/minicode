# Konsep & Desain

Minicode itu apa, kenapa dibangun begitu, dan kenapa beberapa hal sengaja tidak ada. Halaman ini latar belakangnya; langkah praktis ada di [Instalasi](getting-started.md).

## Dua benda, dua peran

| Nama | Apa |
|---|---|
| **MiniCore** | Kernel runtime `STATE / MODEL / ACTION / LOOP`. Zero-dependency, di-vendor ke `vendor/minicore`; dapat diedit di host sejak v0.16.0 (angka provenance historis dicatat di `vendor/minicore/VENDOR.md`). Bukan dependency — di-resolve lewat subpath imports `#minicore` |
| **Minicode** | Layer agencode di atasnya: tools, sub-agents, skills, hooks, policy/sandbox, providers, MCP/LSP, memory, sessions, repo-map, verifier, dan CLI dengan TUI interaktif serta jalur non-interaktif shell-first |


## Loop ReAct

Setiap prompt berjalan sebagai loop `Thought → Action → Observation` sampai jawaban final, batas `--max-steps` (default 200; angka 50 adalah cap sub-agent, bukan default sesi), atau `--timeout` (default 1 jam). Model menerima system prompt berisi `# Environment` (cwd + platform), repo-map ringkas, dan memory yang relevan — lalu memilih tool, melihat hasilnya, dan memilih langkah berikutnya. Tidak ada grafik alur tersembunyi: di jalur non-interaktif jejak aksi tampil sebagai ledger di stderr; di TUI interaktif chat memuat narasi, rekap kategori (mis. `3 command · 2 read · 5 subagent`), baris tool ringkas, dan jawaban akhir. Sejak v0.34 tidak ada panel samping — rincian ada di chat dan jurnal. Sejak
v0.35 rekap tool menjadi baris committed statis di footer tiap narasi
(`tool → narasi → rekap(tool sebelum narasi)`, rekap akhir turn kumulatif; sejak v0.41 tanpa prefix simbol),
dan label aktivitas `› …` memakai locale OS — narasi/model tetap memakai
bahasa user (`/lang`). Sejak v0.36 composer TUI dibatasi maksimal 2 baris
(draft panjang = jendela geser, tanpa menggeser transkrip), dropdown `/`
menjadi overlay dalam frame yang sama tanpa mengurangi `viewH`. Sejak v0.37
bracketed paste aktif (`?2004h`/`?2004l` di luar frame), `Ctrl+A` = select-all
transkrip bila composer kosong & dropdown tertutup, resize menstabilkan
auto-scroll/drag/kursor/anchor, gema prompt di-wrap sekali selebar chat, dan
lebar prompt progresif `min(chatCols, 100 + floor(max(0, chatCols-100)/4))`
dengan prefix `minicode › ` bila `w−14 ≥ 24`, else `› `, lanjutan `· ` — composer
2 baris dan dropdown overlay tidak dicabut.

## Shell-first: non-interaktif polos, interaktif fullscreen

Minicode sengaja **tanpa library TUI pihak ketiga** (tanpa Ink/React; TUI-nya
ditulis sendiri) dan membagi dua jalur secara tegas:

- **Non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`):
  output mengalir **append-only ke scrollback** — hasil agen adalah artefak
  terminal biasa yang bisa di-pipe, di-grep, dan tersimpan di scrollback Anda
  sendiri.
- **Interaktif** (TTY mampu): satu tampilan **TUI fullscreen** alternate-screen
  — transkrip ala shell + status bar satu baris + popup komposit. Sejak v0.34 chat
  berupa kolom tengah (maksimal 50% lebar terminal, mulai `cols ≥ 120` dan
  `rows ≥ 20`); di bawah ambang chat memakai lebar penuh. Keluar = buffer utama
  kembali persis (transkrip tidak di-dump ke scrollback).
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
| **Ledger** | Jejak aksi agent: di jalur non-interaktif berupa baris `  › name target` / `  › name: …` di stderr; di TUI interaktif baris ringkas dan rekap kategori keduanya ada di chat |
| **Scrollback** | Riwayat layar terminal; jalur non-interaktif minicode append-only di sana (interaktif pakai alternate screen) |
| **Transient** | UI muncul-sekali yang menghapus dirinya (spinner, garis status turn, micro-toast retry `retry n/total · Ns` dengan TTL 4 dtk) — vs transkrip yang menetap |
| **Kolom chat tengah** | Sejak v0.34 chat dibatasi maksimal 50% lebar terminal dan di-padding ke tengah bila `cols ≥ 120` dan `rows ≥ 20`; di bawah ambang chat penuh. Footer/composer mengikuti kolom ini, dalam satu frame `paint()`. Sejak v0.36 lebar prompt/kursor dihitung terpisah via `composerWidth()` (bukan `chatWidth()` penuh) |
| **Rekap kategori** | Sejak v0.35: baris committed statis di footer tiap narasi (`tool → narasi → rekap(tool sebelum narasi)`, mis. `2 command · 118 read · 1 other` sejak v0.41 tanpa prefix simbol); rekap akhir turn kumulatif seluruh tool. Menggantikan rekap live dua baris/`flushActivityFold` net-nol/`liveSummaryRows` arsip v0.33/v7.x, ledger per-tool, baris `Tool:`, `/expand`, dan buffer terlipat |
| **Label aktivitas tool** | Prefix `› …` (nama/status tool) yang memakai **locale OS** via `Intl` (id/en) di semua permukaan (TUI, one-shot/`exec`, ACP via `simple.ts`) — dibedakan dari narasi/jawaban model yang tetap memakai `/lang`. Sumber tunggal: `src/ui/render/tool-label.ts` |
| **Composer (v0.36–v0.37)** | Area ketik TUI, tinggi **maksimal 2 baris**; draft panjang memakai jendela geser tanpa menambah baris / menggeser transkrip. `composerWidth()`/`chatWidth()` satu sumber di `chat-column.ts`; cap v0.37 = `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (100→100, 200→125, 300→150, 500→200); prefix `minicode › ` bila `w−14 ≥ 24` / else `› `, lanjutan `· ` |
| **Bracketed paste & select-all (v0.37)** | `?2004h`/`?2004l` di TUI/`askLine`/`askSecret`/output-window, ditulis di luar frame (I1 utuh); CR paste bukan submit. `Ctrl+A` = `selectAll` bila composer kosong & dropdown tertutup (else Home); `Ctrl+C` menyalin juga saat drag aktif; resize merebase anchor walau seleksi aktif |
| **Dropdown overlay (v0.36)** | Menu `/` digambar di dalam frame `paint()` yang sama (satu `stdout.write`, I1), menimpa baris transkrip bawah tanpa mengurangi `viewH` — bukan `paintRegion()` terpisah; klik di area dropdown memilih item menu |
| **Micro-toast retry** | Satu notifikasi footer `retry n/total · Ns` (TTL 4 dtk, counter langsung) untuk retry — menggantikan toast panjang |
| **Delegation scope** | `file`/`dir`/`subtree`/`repo` → budget 24/40/64/100 langkah; `plan` ×1,5 di-clamp ke [24,600] (repo+plan = 150); eskalasi `[24,40,64,100,150,250,400,600]` bila mentok — `maxSteps` eksplisit mematikan eskalasi; tanpa scope fallback 5/15 |
| **Composition root** | `cli/index.ts` + `cli/setup.ts`: satu tempat wiring DI (provider, RAG, session, tools) |
| **Seam aditif** | Satu-satunya patch yang dibolehkan ke kernel beku: `compactAsync`, `initialMessages`, `cwd` |
| **Self-contained** | Tanpa clone repo lain — kernel di-vendor, runtime zero-dep, butuh Bun ≥ 1.1.13 |

## Lanjut

- [Arsitektur](architecture.md) — tiga lapisan, boundary, alur satu prompt.
- [Instalasi & Quickstart](getting-started.md) — dari nol ke prompt pertama yang ter-verify.
