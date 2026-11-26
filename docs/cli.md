# CLI — Mode & Flags

Semua cara menjalankan Minicode: interaktif, sekali jalan, pipe, dan otomasi CI — plus flags dan environment.

## Mode

| Perintah | Fungsi |
|---|---|
| `minicode` | Mode interaktif (TUI fullscreen) + wizard bila belum ada provider |
| `minicode "prompt"` | Sekali jalan (headless) |
| `echo "prompt" \| minicode` | Via pipe |
| `minicode exec "prompt" [--json] [--auto-continue] [--max-turns <n>]` | Headless CI — event JSONL + baris `{"type":"summary"}` di stdout |
| `minicode acp` | Server JSON-RPC stdio untuk IDE (subset minimal: initialize/run/cancel/shutdown) |
| `minicode daemon <start\|status\|stop\|issue\|sessions>` | Daemon lokal: host proses, status, hentikan, terbitkan perintah, daftar sesi anak |
| `minicode --interactive` | Paksa TUI interaktif |
| `minicode --provider <id> "prompt"` | Paksa provider agnostik tanpa ubah config (atau `provider::model`) |
| `minicode config add --baseUrl <url> --apiKey <key>` | Tambah provider LLM |
| `minicode config mcp add <id> --command <cmd> --args "<a1,a2>"` | Daftarkan MCP server stdio |
| `minicode config mcp add <id> --url <https://…>` | Daftarkan MCP server HTTP |
| `minicode config lsp add <ext> --command <cmd> --args "<a1,a2>"` | Daftarkan LSP server |
| `minicode auth login [provider]` | Login OAuth device-code |
| `minicode auth status\|logout\|list` | Kelola kredensial OAuth |
| `minicode pricing status\|sync\|show <model>\|clear` | Tabel harga estimasi biaya |
| `minicode skills list` | Daftar skill terpasang |
| `minicode sessions list` | Riwayat sesi |
| `minicode memory status [--json]` | Statistik vector RAG (rows, size, hit-rate) |
| `minicode memory reconcile [--json] [--cwd PATH]` | Samakan `vector.db` ↔ `.minicode/MEMORY.md` (adopsi entri vector-only, tambah baris file-only, bersihkan baris superseded; hierarki `MEMORY.md` root/`CLAUDE.md` tak disentuh) |
| `minicode doctor [--json]` | Diagnosis lokal |
| `minicode mcp serve` | Ekspos minicode sebagai MCP server |
| `minicode openwork [inventory\|context\|export\|merge]` | Baca, susun konteks, ekspor, atau deduplikasi pekerjaan lintas sesi; aksi tidak menjalankan task |

Subcommand di-route di `cli/router.ts` (`stats`, `sessions`, `mcp`, `config`, `skills`, `providers`/`models`/`sync`, `auth`, `pricing`, `exec`, `daemon`, `memory`, `doctor`, `acp`, `openwork`).

## Flags

| Flag | Deskripsi |
|---|---|
| `--verbose` | Tampilkan reasoning & usage |
| `--verify` | Auto-verify + self-heal (detect: typecheck → test → tsconfig) |
| `--sandbox docker` | Bash di container ephemeral (`--network none`) |
| `--sandbox none` | Matikan sandbox otomatis (opt-out sadar) |
| `--sandbox os` | Paksa OS-native (bwrap/seatbelt). Sudah otomatis bila tersedia |
| `--ratelimit <rpm>` | Batas request LLM per menit |
| `--budget <usd>` | Batas biaya sesi; warn 80%, exit/break bila lewat; cost tak dikenal + pemakaian = over (fail-closed default) |
| `--budget-strict` | Penegasan eksplisit fail-closed di atas (back-compat) |
| `--tool-scope <s>` | `full` (default) \| `explore` = subset read-only 12 tool |
| `--allowlist` | Bash hanya perintah aman (tool-access policy warisan) |
| `--ask` | Minta persetujuan untuk pemanggilan yang digate (human-supervised) |
| `--allow-all` | Profil akses privileged (path jail + bash-guard tetap aktif) |
| `--model <name>` | Override model (`providerId::model` paksa provider) |
| `--provider <id>` | Paksa provider id agnostik |
| `--resume <id>` | Lanjutkan history yang tersimpan; setelah kompaksi, bagian lama dapat berupa ringkasan + tail |
| `--timeout <ms>` | Hard deadline per prompt (default 3600000 = 1 jam; `0` = Infinity; jalur `exec` tetap 15 menit). Sesi yang idle tidak menghabiskan deadline prompt berikutnya. |
| `--cwd <path>` | Workspace root untuk tool file & jail |
| `--allow-local-config` | Percayai `.minicode/config.json` + allowlist lokal (default: diabaikan) |
| `--max-steps <n>` | Batas langkah tool (default 200; angka 50 adalah hard-cap langkah sub-agent, bukan default global) |
| `--context-window <n>` | Ukuran jendela konteks (token) |
| `--session <id>` | ID sesi (default random, disanitasi) |
| `--work-mode <m>` | `DISCUSS` \| `BUILD` (default: `DISCUSS`). **Work Mode**: `DISCUSS` = investigasi & perencanaan read-only, `BUILD` = implementasi. Persetujuan hanya `AUTO`/`ASK` (default `AUTO`). Lihat [TUI](repl.md) untuk `/mode` |
| `--enable-scheduler` | Opt-in scheduler otonom (default **off**). Tanpa flag ini, scheduler tidak dibangun sama sekali dan `/scheduler` menjawab "not enabled". Eksekusi manual saja lewat `/scheduler run` — tidak ada timer; turn otonom bersifat read-only. Lihat `/scheduler status` dan `/scheduler stop` |
| `--runtime <mode>` | `off` (default) \| `constructed` \| `owned`. Arsitektur eksekusi: `off` = perilaku sekarang, tak berubah; `constructed` = runtime + jurnal durable dibangun, turn masih jalan jalur lama; `owned` = setiap turn di-admit lewat runtime (kernel + jurnal durable) dan admission yang ditolak menjalankan tak apa pun. Nilai tak dikenal = `off` |

Tanpa flag, MiniCode memakai `providers[].contextWindows` dari konfigurasi.
Jika model/gateway tidak punya metadata itu, MiniCode memakai fallback
32.000 token (model tak dikenal) atau default konservatif 128K untuk alias
router (`auto`/`best`/...), lalu memberi peringatan saat sesi mulai. Gunakan
batas model yang tepat pada config atau flag; batas yang terlalu kecil memicu
kompaksi dini, sedangkan batas yang terlalu besar berisiko ditolak provider.
Batas berubah otomatis saat `/model` mengganti model. MiniCode juga membatasi
keluaran stream berdasarkan ruang tersisa setelah system prompt, tools, dan
riwayat dihitung.

Di TUI, **Tab** meng-toggle Work Mode (`Discuss` ↔ `Build`) dan **Shift+Tab** meng-toggle Permission Mode (`Auto` ↔ `Ask`). `/mode auto|ask` mengubah persetujuan; `/mode discuss|build` mengubah operating mode. Footer menampilkan Work Mode di kiri dan Permission Mode berwarna cyan di kanan, dekat penggunaan konteks; pada terminal sempit label dipadatkan. Sejak v0.34 sidebar kanan sudah dihapus: chat adalah kolom tengah (maks 50% lebar terminal, footer/composer ter-centre). Baris tool/`✦`/finding dan marker `+ thinking` ada di chat; pintasan pane lama (`Alt/Ctrl+PgUp/PgDn`, `Ctrl+O`) tidak lagi terikat. Sejak v0.37 bracketed paste aktif, `Ctrl+A` = select-all bila composer kosong & dropdown tertutup (else Home), `Ctrl+C` menyalin juga saat drag aktif, resize menstabilkan auto-scroll/drag/kursor/anchor, dan lebar prompt progresif `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (composer tetap ≤2 baris). Sejak v0.41 slash command `/update` hanya ada di TUI interaktif (handoff terminal aman); non-TTY/one-shot/`exec`/pipe/ACP menjawab "not available" tanpa spawn npm. Ringkasan pintasan yang masih berlaku ada di [TUI](repl.md).

## Kapan memakai apa

| Tujuan | Pakai |
|---|---|
| Memahami repo / menyusun rencana tanpa perubahan | Default (`DISCUSS` + `AUTO`) — investigasi & perencanaan read-only |
| Meminta perubahan | `--work-mode BUILD` (`AUTO` default untuk persetujuan) — tool tulis/eksekusi tetap tunduk pada policy |
| Repo asing / perintah belum dipahami | `--ask` (atau `--work-mode BUILD --ask` untuk eksekusi berpersetujuan); jawab `always` hanya untuk pasangan tool+args yang sudah dinilai |
| CI tanpa manusia | `exec --json` + `--budget`/`--max-steps`; `AUTO` menolak `ask_user` deterministik |
| Otonom penuh di mesin sendiri | `--work-mode BUILD` + `AUTO`; isolasi tambahan `--sandbox docker` (atau OS) + `--budget` |
| Model mahal tak terkendali | `--budget 0.50` + `--budget-strict` + `pricing sync` |

Detail alasan tiap mode di [Memilih Mode](choosing-mode.md).

## Environment variables (ringkas)

Kepala tabel penuh ada di [Environment Variables](environment.md); yang paling sering dipakai:

| Variabel | Fungsi |
|---|---|
| `MINICODE_VERIFY_CMD` | Custom verify command |
| `MINICODE_SANDBOX` | `docker` \| `os` \| `none` |
| `MINICODE_SANDBOX_STRICT=1` | Tak pernah fallback host (default request eksplisit sudah fail-closed) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK=1` | Izinkan fallback host secara eksplisit bila backend tak tersedia |
| `MINICODE_BUDGET_STRICT=1` | Sama dengan `--budget-strict` |
| `MINICODE_ALLOW_LOCAL_CONFIG=1` | Sama dengan `--allow-local-config` |
| `MINICODE_WORK_MODE` | `DISCUSS` / `BUILD` — WorkMode default (`PLAN` legacy → `DISCUSS`); precedence ada di [Environment Variables](environment.md) |
| `MINICODE_TOOL_SCOPE=explore` | Subset read-only |
| `MINICODE_GREP_ENGINE=js` | Paksa walker internal |
| `MINICODE_MEMORY_SCOPE` | `cwd` \| `global` \| `all` |
| `MINICODE_AUTO_MEMORY=0` | Matikan auto-simpan summary/snippet |
| `MINICODE_TELEMETRY=0` | Matikan `traces.jsonl` |
| `MINICODE_HOME` | Override home untuk DB lokal/global |
| `TAVILY_API_KEY` | Tavily web_search (fallback keyless Firecrawl/Mwmbl/Marginalia bila kosong) |
| `MINICODE_ALLOW_DDG=1` | Aktifkan fallback DDG HTML (default mati; DDG diblokir di Indonesia) |
| `NO_COLOR` | Matikan warna (menang atas TTY) |
| `MINICODE_COLOR=0` | Paksa monokrom (identik `NO_COLOR`) |
| `MINICODE_ASCII=1` | Glyph ASCII untuk konsol tanpa UTF-8 |
| `MINICODE_STATUSLINE=rich` | Spinner tampilkan token + biaya sesi |
| `MINICODE_MINIMIZE_ACTIVITY=0` | Tampilkan detail aktivitas per-tool (bukan ringkasan lipat); toggle fold tetap berlaku di chat |
| `MINICODE_SHOW_THINKING=1` | Tampilkan marker `+ thinking` di chat (default tersembunyi) |
| `MINICODE_ACTIVITY_PANEL` | Legacy/deprecate (D3): diterima agar konfigurasi lama tidak error, tetapi tidak lagi mengubah tampilan — sidebar sudah dihapus di v0.34 |
| `MINICODE_SESSION_SUMMARY=0` | Matikan blok penutup sesi (model/mode/rincian tool/agent/token) |
| `MINICODE_STARTUP_PROGRESS=0` | Matikan baris progres startup |
| `MINICODE_SUB_AGENT_POOL_SIZE` | Slot sub-agent paralel (1..16, default 3) |
| `MINICODE_SUB_AGENT_TIMEOUT_MS` | Timeout per turn sub-agent (ms, default 300000); ditimpa `timeoutMs` di `delegate_task` |
| `NO_UPDATE_CHECK=1` | Lewati pengecekan pembaruan saat startup |
| `MINICODE_AUTO_UPDATE=0\|false\|off` | Nonaktifkan pengecekan & pemasangan pembaruan otomatis |
| `CI=1` | Auto-update fail-closed: tanpa pemasangan, tanpa spawn npm |
| `MINICODE_AUTO_UPDATE_DONE=1` | Guard internal pada proses restart hasil `/update` (jangan diset manual) |

## Auto-update (v0.41)

Auto-update berlaku hanya untuk salinan ter-install (checkout source tidak
disentuh) dan memverifikasi versi eksak lewat `npm audit signatures` sebelum
pemasangan; kegagalan verifikasi selalu membatalkan update. Sejak v0.41
kegagalan install menyebut **langkah & alasan** yang sudah diredaksi (ANSI,
token/kredensial, URL berkredensial dibuang; satu baris ≤300 char), bukan pesan
generik — batas redaksi hanya tiga kategori itu plus panjang/baris, bukan
pembersih rahasia umum. Di Windows runner npm memilih `npm_execpath` / `npm.cmd`
dengan timeout 60 dtk; urutan verifikasi signature tetap fail-closed.

Slash command `/update` hanya tersedia di TUI interaktif: release alt-screen →
install → spawn restart dengan `MINICODE_AUTO_UPDATE_DONE=1` → exit; bila sudah
latest/opt-out/gagal, terminal di-reacquire dan hasil ditampilkan. Jalur
non-TTY/one-shot/`exec`/pipe/ACP **fail-closed** — injeksi `withUpdate` absen,
perintah menjawab "not available", tak pernah spawn npm dari pipe/CI. Instruksi
manual: lihat [instalasi manual](getting-started.md). Lihat
[Environment](environment.md#auto-update-v041) untuk daftar opt-out.

## Config

Skema, contoh, scope global/lokal, dan lokasi seluruh data ada di [Config — File & Lokasi Data](config.md). Config lokal tetap diabaikan kecuali operator memilih `--allow-local-config` atau `MINICODE_ALLOW_LOCAL_CONFIG=1`.

## Anti-injeksi flag

`cli/args.ts` (`hasFlag`/`getArg`) berhenti di prompt word pertama: prompt `"review --allow-all"` tidak mengaktifkan flag. `--cwd`/value-flag setelah nama subcommand diparse per-subcommand agar tidak menembus boundary prompt. Flag tak dikenal atau flag ber-nilai yang kehilangan argumennya sebelum prompt (atau tanpa `--`) ditolak fail-closed dengan exit `2` (gunakan `--` bila prompt diawali `--`).

## Exit codes

| Kode | Arti |
|---|---|
| `0` | Sukses, atau help yang memang diminta |
| `1` | Gagal runtime: provider error, budget lewat, turn gagal, setup gagal |
| `2` | Salah pakai: argumen/nilai flag hilang atau malformed, flag tak dikenal sebelum prompt, subcommand bersarang asing |

Lookup yang gagal (provider/skill/sesi tak dikenal) = `1`: itu kegagalan operasi, bukan pemakaian. Skrip cukup cek `!= 0` untuk gagal; cek `== 2` untuk spesifik salah pakai.
