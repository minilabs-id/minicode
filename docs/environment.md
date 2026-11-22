# Environment Variables

Variabel yang paling menentukan perilaku (sisanya referensi di bawah):

- **Batas otonomi di mesin sendiri:** `MINICODE_SANDBOX` + `MINICODE_SANDBOX_STRICT=1` (tolak bash bila isolasi tak ada) + `MINICODE_BUDGET_STRICT=1` (cost tak dikenal = over budget).
- **Privasi/minim jejak:** `MINICODE_TELEMETRY=0` (tanpa traces), `MINICODE_AUTO_MEMORY=0` (tanpa auto-simpan memori).
- **Repo asing:** JANGAN set `MINICODE_ALLOW_LOCAL_CONFIG=1` kecuali workspace milik Anda.
- **Konsol lawas/aksesibilitas:** `MINICODE_ASCII=1`, `MINICODE_A11Y=1`, `MINICODE_BELL=0`, `NO_COLOR`, `MINICODE_COLOR=0`.

## Runtime & limits

| Variabel | Fungsi |
|---|---|
| `MINICODE_TIMEOUT_MS` | Default timeout (ms) bila `--timeout` tidak diset; `0` = Infinity. Ini batas **total** satu prompt (default 1 jam untuk sesi interaktif) |
| `MINICODE_DEBUG` | `1` → tampilkan stack trace lengkap saat proses gagal fatal (default: hanya satu baris sebabnya) |
| `NO_UPDATE_CHECK` | `1` → lewati pemeriksaan pembaruan saat startup |
| `MINICODE_AUTO_UPDATE` | `0`/`false`/`off` → nonaktifkan pemeriksaan dan pemasangan pembaruan otomatis |
| `MINICODE_PERMISSION` | `allowlist` → tool-access policy bash (profil warisan) |
| `MINICODE_TOOL_SCOPE` | `explore` → subset read-only 12 tool (sama `--tool-scope explore`) |
| `MINICODE_WORK_MODE` | `DISCUSS` \| `BUILD` → operating mode (sama `--work-mode`; default `DISCUSS`; `BUILD` dipetakan ke `EXECUTE` internal; flag menang atas env; nilai tak dikenal gagal ke `DISCUSS` dengan peringatan) |
| `MINICODE_HOOKS` | `1` → jalankan hook `pre/post-run` dari `~/.minicode/hooks/*.js` & `.minicode/hooks/*.js` (konteks di env `MINICODE_HOOK_CTX`; env hook disanitasi tanpa secret; dilewati bila sesi dibatalkan) |
| `MINICODE_SESSION_TTL_DAYS` | TTL sesi (default 30; `0` = selamanya) |
| `MINICODE_REWIND_DRAFT` | Internal handoff `/undo`: `1` → TUI memuat prompt target dari record rewind ke composer cabang |
| `MINICODE_REWIND_NOTICE` | Internal handoff `/undo`/`/redo`: notice base64 yang ditampilkan sekali di transkrip sesi anak |
| `MINICODE_SUB_AGENT_TIMEOUT_MS` | Timeout default per turn sub-agent (ms, finite >0; default 300000 / 5 menit). Bisa ditimpa per delegasi lewat argumen `timeoutMs` pada `delegate_task` |
| `MINICODE_SUB_AGENT_POOL_SIZE` | Jumlah slot eksekusi sub-agent paralel (1..16, default 3). Naikkan bila sering menjalankan fan-out 5+ agen sekaligus |
| `MINICODE_REWIND_LOCK_MAX_AGE_MS` | Batas usia lock `operation.lock` rewind sebelum dianggap stale (default 600000 ms / 10 menit). Operator bisa memperpanjang bila rewind sering terputus di mesin lambat |
| `MINICODE_BOOT_ID` | Penanda boot mesin untuk validasi lock rewind lintas restart. Bila tidak diset, diturunkan dari `hostname` + `Date.now() - os.uptime()`; set eksplisit untuk determinisme saat clock NTP bergeser |
| `MINICODE_HOME` | Override home untuk DB lokal/global (sessions + vector); default `~` |
| `MINICODE_TOKENIZERS` | `0`/`off` → nonaktifkan unduh tokenizer presisi on-demand dari HuggingFace (fallback estimator densitas). Default: aktif untuk model open (deepseek/qwen/mistral/gemma/phi); vocab di-cache di `~/.minicode/tokenizers/`, tak diunduh ulang |
| `MINICODE_TELEMETRY` | `0`/`false`/`off` → matikan penulisan traces.jsonl |
| `MINICODE_VERIFY_CMD` | Custom verify command (ganti `detectVerifyCommand`) |
| `MINICODE_ACE_ENABLED` | `0`/`false`/`off`/`no` → nonaktifkan ACE-Lite consequence engine (rollback instan ke baseline murni, tanpa self-heal loop). Default `true`. Hard-safety/tamper-guard & permission policy TETAP aktif — sakelar ini hanya mematikan evaluasi consequence, bukan batas keamanan |
| `MINICODE_BASH_ALLOWLIST` | Kustom allowlist bash (koma-pisah, ganti DEFAULT) |

## Bahasa, diagnosis & kunci

| Variabel | Fungsi |
|---|---|
| `MINICODE_LANG` | `en`/`id` → bahasa UI (prioritas lengkap di kontrak terminal §i18n: `/lang` > env ini > state.json > locale OS > en) |
| `MINICODE_DEBUG_BUS` | `1` → cetak satu baris diagnosis event bus per turn ke stderr (`src/ui/runtime/bus-debug.ts`; diagnostik saja, bukan perilaku) |
| `MINICODE_DEBUG_STARTUP` | `1` → cetak durasi tiap tahap setup sesi ke stderr (diagnosis startup lambat; diagnostik saja, bukan perilaku) |
| `MINICODE_DEBUG_PERF` | `1` → aktifkan timer ringan di jalur komputasi/persistensi (`src/lib/perf-debug.ts`): agregat count/p50/p95 lewat `perfReport()`, diagnostik saja, tanpa mengubah kompaksi/durabilitas |
| `MINICODE_MINIMIZE_ANSWER` | `1` → minimize section jawaban model (default: tidak minimize). Hanya berefek di TTY dan bila bukan `--verbose` |
| `MINICODE_KEYSTORE_DISABLE` | `1` → matikan keystore OS seluruhnya (jatuh ke penyimpanan file; untuk CI/headless yang tak punya keychain/DPAPI) |
| `MINICODE_KEYSTORE_FORCE_DPAPI` | `1`/`true` → paksa jalur DPAPI/Windows walau di non-Windows (khusus test portabilitas; bukan konfigurasi produksi) |
| `MINICODE_MINIMIZE_TOOL` | Di TUI section tool minimize default (setara `1`); set ke nilai selain `1` (mis. `0`) → tampilkan penuh |

> **Catatan v0.35 — label aktivitas tool:** `MINICODE_LANG`/`/lang` mengatur
> bahasa UI dan narasi/jawaban model, tetapi **bukan** label aktivitas `› …`.
> Khusus label itu, **locale OS** (`Intl`, id/en) yang menang di semua
> permukaan — TUI, one-shot/`exec`, dan ACP via `src/ui/assistant/simple.ts` —
> demi kosakata tool yang konsisten lintas permukaan. Tidak ada variabel env
> untuk mengganti perilaku ini; lihat `TERMINAL_CONTRACT.md` entri v0.35.

## Sandbox

| Variabel | Fungsi |
|---|---|
| `MINICODE_SANDBOX` | `docker` \| `os` (alias `bwrap`/`seatbelt`) \| `none` |
| `MINICODE_SANDBOX_STRICT` | `1` → tak pernah fallback host (redundan dengan default fail-closed untuk request eksplisit, tetap dihormati) |
| `MINICODE_SANDBOX_ALLOW_FALLBACK` | `1` → satu-satunya jalan fallback host yang sadar bila backend tak tersedia |
| `MINICODE_SANDBOX_IMAGE` | Image Docker (default `node:22-alpine` — hanya bawa node; python butuh image sendiri) |
| `MINICODE_SANDBOX_MEMORY` | Memory cap (default `512m`) |
| `MINICODE_GREP_ENGINE` | `js` → paksa walker internal, jangan pakai ripgrep |

## Provider & memory

| Variabel | Fungsi |
|---|---|
| `MINICODE_PROVIDER_ORDER` | Urutkan provider agnostik tanpa edit config: `openai,anthropic,deepseek` |
| `MINICODE_EMBED_MODEL` | Model embedding untuk memory/vector (default `text-embedding-3-small`) |
| `MINICODE_COMPACT_KEEP_TURNS` | Override keepRecentTurns kompaksi (bilangan ≥1; invalid → default kernel + warn) |
| `MINICODE_MICROCOMPACT` | `0` → matikan pemangkasan isi hasil tool lama (lapisan termurah sebelum kompaksi penuh). Default aktif; matikan bila sesi butuh seluruh output tool verbatim |
| `MINICODE_PROMPT_CACHE` | `0` → matikan prompt caching (`cache_control: ephemeral` Anthropic). Default aktif; kill-switch runtime bila gateway menolak header cache atau untuk diagnostik hit-rate (berpasangan dengan metrik cache di ringkasan sesi/`/status`) |
| `MINICODE_CONTEXT_PROBE` | `0` → matikan eskalasi adaptif jendela konteks (probe reaktif setelah overflow terverifikasi). Default aktif; probe juga dibatasi anggaran per-model/per-proses terlepas dari nilai ini |
| `MINICODE_MEMORY_SCOPE` | Scope baca memory: `cwd` (default) \| `global` \| `all` (gabung, tanpa silent shadowing) |
| `MINICODE_AUTO_MEMORY` | `0` → matikan auto-simpan summary/snippet ke memory (opt-out) |
| `MINICODE_READ_VOLUME_GUARD` | `1` → aktifkan peringatan sekali per turn saat volume baca (char hasil tool) melewati ambang — penanda "banyak dibaca tanpa kompaksi" (risiko degradasi working-memory, bukan jendela token); default nonaktif |
| `MINICODE_REPOMAP` | `regex` → paksa repo-map regex (skip LSP) |
| `TAVILY_API_KEY` | API key untuk Tavily web_search (fallback keyless Firecrawl/Mwmbl/Marginalia bila kosong) |
| `BRAVE_API_KEY` | API key Brave Search (fallback kedua setelah Tavily) |
| `MINICODE_ALLOW_DDG` | `1` → aktifkan fallback DDG HTML. Default mati karena DuckDuckGo diblokir di Indonesia |

## Budget & config

| Variabel | Fungsi |
|---|---|
| `MINICODE_BUDGET_STRICT` | `1` → penegasan eksplisit fail-closed (cost tak dikenal + pemakaian = over; kini juga default `--budget`) |
| `MINICODE_MAX_TURNS` | Batas keras maksimum jumlah turn per sesi (termasuk carry-forward lintas `--resume`; bilangan ≥1) |
| `MINICODE_AUTO_CONTINUE` | `1` → pada `exec`, saat turn berakhir `max_steps_exceeded`, lanjutkan turn pada sesi yang sama (progres parsial sudah durable) alih-alih gagal; dibatasi `--max-turns` (default 3) |
| `MINICODE_ALLOW_LOCAL_CONFIG` | `1` → percayai config lokal workspace (default: diabaikan) |

## Terminal & aksesibilitas

| Variabel | Fungsi |
|---|---|
| `MINICODE_ASCII` | `1` → paksa glyph ASCII (`[OK]`, `>`, `.`) untuk konsol tanpa UTF-8 |
| `MINICODE_BOX` | gaya sudut kotak popup: default **melengkung** (`╭╮╰╯`); `square` → lancip (`┌┐└┘`); `ascii` → `+-|` (sama dengan `MINICODE_ASCII=1`). Untuk terminal yang merender glyph melengkung jelek |
| `MINICODE_SCRIM` | `none` → paksa scrim backdrop jadi `faint` saja (tanpa latar gelap `48;5;236`) — diagnostik/tema terminal yang memetakan 256-warna aneh |
| `MINICODE_COMPACT` | `1` → tool call ringkas, `0` → expanded. Default: compact di TUI, expanded di one-shot/exec. Toggle `/view compact` sudah dihapus; `Ctrl+O` juga dihapus sejak v0.34 (v0.33 pernah membuka modal detail Live di sidebar) |
| `MINICODE_JUSTIFY` | `1` → aktifkan rata kanan-kiri (justify) keluaran teks model. Default: mati (opt-in) — justify menyuntik spasi yang mengubah teks asli saat di-copy/–pipe |
| `MINICODE_DROPDOWN` | `0` → matikan dropdown, pakai hint inline (konsol legacy). Sejak v0.36 dropdown (bila aktif) digambar sebagai **overlay di dalam frame `paint()` yang sama**, bukan `paintRegion()` terpisah, dan tidak mengurangi `viewH` — lebar prompt/kursor memakai `composerWidth()` dengan cap progresif (100→100, 200→125, 300→150, 500→200; sejak v0.37) |
| `MINICODE_MOUSE_SELECTION` | `0`/`false`/`off`/`no` → matikan mouse tracking TUI; default `1` untuk drag selection + wheel |
| `MINICODE_MOTION` | `0` → matikan animasi status (pulse spark saat turn berjalan jadi glyph statis) — aksesibilitas/rekaman layar/SSH lambat |
| `MINICODE_BELL` | `0` → matikan bell `\x07` saat approval (aksesibilitas) |
| `MINICODE_STATUSLINE` | `rich` → statusline turn menampilkan token kumulatif + biaya sesi (default hemat) |
| `MINICODE_A11Y` | `1` → live-region approval untuk screen reader (baris polos tanpa ANSI) |
| `MINICODE_SHOW_THINKING` | reasoning model tersembunyi SECARA DEFAULT (`false`); `1` → tampilkan marker `+ thinking` di chat (atau `/view thinking` / `--verbose`), `0` → paksa tersembunyi. `Ctrl+T` tidak punya binding; detail lengkap tetap di jurnal |
| `MINICODE_MINIMIZE_ACTIVITY` | ON secara default di TUI; `0` → transparan (baris per-tool). Lipat aktivitas tool per turn jadi satu ringkasan di chat — toggle fold ini TETAP berlaku sejak v0.34; baris tool/`✦`/finding sendiri kembali ke chat (v0.33 pernah memindahkannya ke panel Live + `Ctrl+O`, sekarang dicabut), bukan `/view expand` |
| `MINICODE_ACTIVITY_PANEL` | **Legacy/deprecate (D3)** sejak v0.34: nilai `0`/`1` tetap diterima agar konfigurasi lama tidak error, tetapi tidak lagi mengubah tampilan. Dulu mengontrol panel aktivitas/sidebar (aktif bila `cols ≥ 100` dan `rows ≥ 20`); sidebar sudah dihapus total, jadi variabel ini tidak ada efeknya |
| `MINICODE_AUTORESUME_BG` | `0` → nonaktifkan auto-resume turn TUI saat job background selesai (default aktif; sekali per job, hanya bila tidak ada turn berjalan) |
| `MINICODE_TURN_AUTO_RESUME` | `0` → nonaktifkan resume otomatis turn setelah kegagalan provider **transien** (`server`/`network`; default aktif). Retry provider dan resume turn berbagi **satu anggaran pemulihan** (`src/policy/recovery-budget.ts`): total 45 dtk dan kuota 6 percobaan untuk satu panggilan logis, dengan full jitter dan `Retry-After` sebagai floor. Berbagi satu anggaran mencegah *retry amplification* (angka terpisah per lapisan membuat biaya berkali: ≈82 dtk untuk provider mati). Kegagalan terminal tidak dipulihkan: `rate_limit` (429 permanen/spend-cap tidak pulih), `auth`, `invalid_request`, `context_length_exceeded`, `budget_exceeded`, `max_steps_exceeded`, dan abort user |
| `MINICORE_THINKING` | `off` → kirim `enable_thinking:false` ke OpenAI-compat (DeepSeek). Alias lama `MINICODE_THINKING` masih dihormati |
| `MINICODE_STARTUP_PROGRESS` | `0` → matikan baris progres startup (default AKTIF). Tanpa logo: satu baris `start 57%` yang ditimpa dengan `\r`, angka nyata dari 9 fase `createCliSession`; `update 57%` untuk auto-update. Tutup `start 100%` sekali saat sesi siap |
| `MINICODE_SESSION_SUMMARY` | `0` → matikan blok penutup sesi (default AKTIF). Ditulis ke scrollback SETELAH alt-screen ditutup: logo asli + `Session : minicode<DDMMYYYYHHMMSS>` + Model + Mode + hitungan turn/tool/file/other dengan rincian tool per kategori + jumlah agent + token in/out + biaya/durasi + versi. Data tak tersedia jujur (`0` / `$—`), transkrip tetap utuh |
| `MINICODE_COLOR` | `0` → paksa monokrom (identik `NO_COLOR`); selain itu/absen → warna nyala by default di TTY (v7.29+). `TERM=dumb` / non-TTY tetap monokrom untuk determinisme |
| `NO_COLOR` | Set apa pun selain `0` → matikan seluruh warna |

## API key fallback

| Variabel | Fungsi |
|---|---|
| `AGENT_API_KEY`, `AGENT_BASE_URL`, `AGENT_MODEL` | Fallback generik OpenAI-compat (dipakai provider-layer, memory, task) |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Fallback API key |
| `DEEPSEEK_BASE_URL` | Base URL DeepSeek (default `https://api.deepseek.com/v1`, untuk compaction) |
| `ANTHROPIC_MODEL` | Model Anthropic bila tidak diset eksplisit |

## Lanjut

- [CLI](cli.md) — padanannya dalam bentuk flag `--`.
- [Config](config.md) — config file + lokasi data.
- [Keamanan](security.md) — env scrub subprocess.
