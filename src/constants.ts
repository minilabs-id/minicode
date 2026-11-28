/** Centralized magic numbers — full English naming. Single source for limits. */

/**
 * Ambang timer JS (`setTimeout`). Sengaja didefinisikan SEBELUM `LIMITS` supaya
 * helper env di bawah bisa memakainya tanpa referring ke objek yang sedang
 * dibangun. Angka ini = `LIMITS.MAX_TIMER_DELAY_MS`; duplikasi satu angka platform
 * ini disengaja (tidak ada cara lain memakai konstanta di dalam literal yang sama).
 */
const JS_TIMER_MAX = 2_147_483_647

/**
 * Baca limit numerik dari env saat modul dimuat. Nilai tak valid (NaN/Infinity,
 * di bawah min, di atas max) dibuang → default dipakai. Ini pola fail-closed
 * yang sama dengan `src/app/session.ts`: konfigurasi rusak tak boleh berubah
 * jadi abort instan (timeout ≤ 0) atau timer 1 ms (timeout > 2^31-1).
 */
function envBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback
}

export const LIMITS = {
  /** Maksimum timer JS; nilai lebih besar diklem agar tidak berubah jadi 1ms. */
  MAX_TIMER_DELAY_MS: 2_147_483_647,
  /** File size limits */
  READ_FILE_MAX_BYTES: 2_000_000,
  WRITE_FILE_MAX_CHARS: 5_000_000,
  /** read_file paging — file besar dibaca per rentang baris, bukan sekaligus */
  READ_FILE_DEFAULT_LINE_LIMIT: 2_000,
  READ_FILE_MAX_LINE_LIMIT: 5_000,
  READ_FILE_MAX_LINE_CHARS: 2_000,
  /** Tool output truncation */
  BASH_OUTPUT_MAX_CHARS: 20_000,
  BASH_DEFAULT_TIMEOUT_MS: 30_000,
  /** Timeout default bash di mode `unrestricted` (30 menit): kompilasi/instal/
   * push jaringan tak boleh mati oleh timeout pendek; `timeoutMs` tetap menang. */
  UNRESTRICTED_BASH_TIMEOUT_MS: 1_800_000,
  /** Batas diam (tanpa output stdout/stderr) untuk bash bertimeout panjang
   * (mode unrestricted 30 menit). Perintah yang terus mengalirkan output tetap
   * boleh jalan sampai batas total; yang macet sunyi diputus lebih cepat. */
  BASH_IDLE_TIMEOUT_MS: 120_000,
  /** bash background: proses hidup melewati batas turn, dipanggil via bash_output */
  BASH_BACKGROUND_MAX_JOBS: 8,
  BASH_BACKGROUND_MAX_LIFETIME_MS: 3_600_000,
  DOCKER_OUTPUT_MAX_CHARS: 100_000,
  /** Batas untuk meminta daemon Docker menghapus container yang timeout/abort. */
  DOCKER_CLEANUP_TIMEOUT_MS: 5_000,
  MCP_OUTPUT_MAX_CHARS: 100_000,
  /** Batas frame JSON-RPC stdio default (diuji kontrak); koneksi MCP produksi dapat memberi pagu lebih besar untuk screenshot/DOM. */
  MCP_STDIO_FRAME_MAX_BYTES: 1_048_576,
  /** Batas respons mentah MCP (HTTP body & stdio koneksi produksi = 8 MiB) agar screenshot/snapshot browser tidak terpotong atau meng-kill server. */
  MCP_HTTP_BODY_MAX_BYTES: 8_388_608,
  MCP_REQUEST_TIMEOUT_MS: 30_000,
  TASK_SUB_AGENT_MAX_TOKENS: 2_000,
  /**
   * Pagu output untuk panggilan samping pembuatan judul diri sub-agent.
   * Sengaja sangat kecil: judul hanya 2–4 kata, jadi mengizinkan generasi
   * panjang hanya membuang token dan menambah latensi panggilan paralel yang
   * tak boleh menahan kerja anak.
   */
  TITLE_MAX_TOKENS: 32,
  /**
   * Watchdog total untuk panggilan judul diri. Panggilan ini SPAWN PARALEL
   * dengan turn anak, tapi tetap harus dibatasi: provider yang diam tanpa
   * satu byte akan memegang timer/listener sampai turn anak selesai bila tak
   * ada batas ini. Nilai pendek sengaja — judul yang telat tak berguna lagi
   * karena ledger sudah memakai label sementara (`explore-N`).
   */
  CHILD_TITLE_TIMEOUT_MS: 8_000,
  /** Context & memory */
  SYSTEM_PROMPT_MAX_CHARS: 8_000,
  /** Batas baca per skill sebelum dirender sebagai instruksi pada prompt. */
  SKILL_FILE_MAX_BYTES: 32_000,
  MEMORY_FILE_MAX_CHARS: 4_000,
  MEMORY_FILE_MAX_BYTES: 200_000,
  MEMORY_TRUNCATE_KEEP_BYTES: 150_000,
  AGENTS_MD_MAX_CHARS: 3_000,
  COMPACTION_SUMMARY_MAX_CHARS: 4_000,
  /** R9 — pagu langit-langit ringkasan kompaksi LLM untuk model berjendela
   * raksasa. Ringkasan diskala mengikuti jendela lewat
   * `summaryCharBudgetForWindow` (lantai = COMPACTION_SUMMARY_MAX_CHARS, atap =
   * nilai ini ≈ 8k token), bukan 4k char konstan yang membuat model 1M
   * over-discard fakta lama. */
  COMPACTION_SUMMARY_SCALED_MAX_CHARS: 32_000,
  /** R10/B — lantai & atap input summarizer kompaksi LLM (`scrubbedPrefix`).
   * Sebelumnya hard-coded 6000 char = titik sempit nyata: summarizer hanya
   * melihat ≤6000 char prefix (≈1500 token), sehingga ringkasan tak bisa lebih
   * kaya dari yang terbaca. Diskala lewat `summaryInputCharBudget`, atap ≈
   * 12k token input untuk model berjendela raksasa. */
  COMPACTION_LLM_INPUT_MIN_CHARS: 6_000,
  COMPACTION_LLM_INPUT_SCALED_MAX_CHARS: 48_000,
  /** F3.2/R9 — rasio target ringkasan terhadap jendela konteks saat kompaksi
   * mekanikal/LLM menarget budget token (0.5 = target 50% jendela). Sebelumnya
   * angka 0.5 tersebar inline di compaction.ts tanpa nama (magic number). */
  COMPACTION_SUMMARY_TARGET_RATIO: 0.5,
  /** Backstop TOTAL untuk satu percobaan ringkasan LLM.
   * Sebelumnya 10.000 ms — angka itu membunuh setiap panggilan ke provider
   * yang lambat (sesi nyata mencatat `provider sent nothing for 60000ms`),
   * sehingga 7 dari 7 kompaksi jatuh ke ringkasan mekanikal 4k yang lossy.
   * Pagar sesungguhnya ada di dua timeout di bawah (first-byte & idle); nilai
   * ini hanya jaring pengaman terakhir agar satu percobaan tak menggantung. */
  COMPACTION_LLM_TIMEOUT_MS: 60_000,
  /** Tunggu byte PERTAMA. Provider yang belum mengirim apa pun setelah batas
   * ini dianggap menggantung: percobaan dibatalkan dan diulang, bukan ditunggu
   * sampai backstop.
   */
  COMPACTION_LLM_FIRST_BYTE_TIMEOUT_MS: 25_000,
  /** Jarak maksimum antar-chunk saat streaming ringkasan. Stream yang berhenti
   * mengalir di tengah jalan (koneksi mati tanpa `finish`) juga harus gagal
   * cepat, bukan menunggu backstop total.
   */
  COMPACTION_LLM_IDLE_TIMEOUT_MS: 15_000,
  /** Anggaran waktu TOTAL untuk seluruh percobaan kompaksi LLM (retry ikut
   * dihitung). Dipisah dari `RECOVERY_BUDGET_MS` (45 dtk) karena satu
   * ringkasan 60 dtk sah-sah saja, sedangkan pemulihan panggilan chat biasa
   * tetap harus berhenti di 45 dtk.
   */
  COMPACTION_LLM_BUDGET_MS: 90_000,
  /** BATAS ATAS ambang ukuran konteks (estimasi chars/token lokal) untuk
   * mengklasifikasi 400 `invalid_request` generik sebagai
   * `context_length_exceeded` alih-alih mati fatal. Di bawah ambang ini, 400
   * dianggap error format sah (bukan konteks). Proxy monotonik ukuran konteks,
   * bukan hitungan presisi.
   *
   * KENAPA batas atas, bukan angka mutlak: nilai ini dulu 50.000 mutlak,
   * sehingga model berjendela < 50.000 tak pernah bisa menempuh jalur
   * recovery `compact-and-retry` — jendelanya penuh jauh sebelum ambangnya
   * tercapai. Ambang efektif kini `min(nilai ini, window * 0.5)` (lihat
   * `contextReclassifyThreshold`), jadi tetap aman untuk jendela besar tanpa
   * mematikan recovery di jendela kecil. */
  CONTEXT_RECLASSIFY_400_MIN_LOCAL_TOKENS: 50_000,
  /** Fraksi jendela konteks untuk ambang reklasifikasi 400 di atas. 0.5 dipilih
   * karena 400 generik yang benar-benar "konteks kepanjangan" praktis selalu
   * terjadi setelah separuh jendela terpakai (chars/4 under-count paling buruk
   * ~2×, jadi 0.5 masih di bawah garis aman). */
  CONTEXT_RECLASSIFY_400_WINDOW_RATIO: 0.5,
  /** Microcompact — jumlah hasil tool TERBARU yang dipertahankan utuh. 5 adalah
   * titik kumpul lintas implementasi harness produksi (median 5 dari enam
   * implementasi yang disurvei); di bawah 3 model cenderung mengulang
   * pembacaan berkas yang sama. */
  MICROCOMPACT_KEEP_RECENT: 5,
  /** Hemat minimum agar pemangkasan hasil tool sepadan. Di bawah ini, yang
   * dibuang hanya informasi tanpa manfaat token. */
  MICROCOMPACT_MIN_SAVING_TOKENS: 20_000,
  /** Hasil tool harus menempati porsi ini dari budget konteks agar pemangkasan
   * dipertimbangkan — bila konteks dikuasai pesan lain, memangkas tool hanya
   * membuang fakta. */
  MICROCOMPACT_MIN_TOOL_SHARE: 0.4,
  /** R11 — ambang volume-baca per turn (char hasil tool terakumulasi) untuk
   * observer opt-in `MINICODE_READ_VOLUME_GUARD=1`. Di atas ini, peringatkan
   * sekali per turn: "banyak dibaca tanpa kompaksi" = risiko degradasi
   * working-memory (bukan jendela token). Default 200k char ≈ 50k token. */
  TURN_READ_VOLUME_GUARD_CHARS: 200_000,
  /** F3.1 anti-thrash: kompaksi LLM yang mengurangi <10% dihitung tak
   * berprogres (satu output tool raksasa mendominasi jendela); 2× beruntun
   * = thrash → jalur LLM dimatikan sesi-ini (mekanikal saja). */
  COMPACTION_THRASH_MIN_PROGRESS: 0.1,
  COMPACTION_THRASH_MAX_STREAK: 2,
  EMBEDDING_TIMEOUT_MS: 3_500,
  /** Budget TOTAL semua attempt embedding (3 header × 2 URL sekuensial):
   * tanpa ini endpoint lambat-menjawab menahan RAG setup ~21 dtk (6×3,5 dtk
   * + DNS per attempt) dengan spinner "Menyiapkan sesi…" yang diam = macet.
   * Lewat budget = fallback keyword, bukan hang. */
  EMBEDDING_TOTAL_TIMEOUT_MS: 10_000,
  VECTOR_SEARCH_LIMIT: 500,
  VECTOR_RECENT_LIMIT: 300,
  VECTOR_KEYWORD_LIMIT: 200,
  MEMORY_MIN_SCORE_HYBRID: 0.2,
  MEMORY_MIN_SCORE_KEYWORD: 0.25,
  /** P13 P1 — TTL hierarkis per kategori (hari): fakta awet, ringkasan
   * sedang, snippet cepat basi. Menggantikan MEMORY_TTL_DAYS flat 90. */
  MEMORY_TTL_FACT_DAYS: 180,
  MEMORY_TTL_SUMMARY_DAYS: 90,
  MEMORY_TTL_SNIPPET_DAYS: 14,
  MEMORY_MAX_ROWS: 5000,
  /** P2 MMR: bobot relevansi vs diversitas + ambang dedup near-duplikat */
  MEMORY_MMR_LAMBDA: 0.7,
  MEMORY_MMR_CANDIDATES: 50,
  MEMORY_DEDUP_COSINE: 0.92,
  /** P2 chunking: entri panjang dipecah per baris ini dengan overlap */
  MEMORY_CHUNK_CHARS: 2000,
  MEMORY_CHUNK_OVERLAP: 200,
  WORKSPACE_SNAPSHOT_LIMIT: 200,
  CHECKPOINT_MAX_COUNT: 20,
  /** Checkpoint shadow-git: operasi git punya deadline sendiri agar turn tak
   * tergantung repo raksasa; batch path menghindari batas command-line Windows. */
  SHADOW_GIT_TIMEOUT_MS: 20_000,
  SHADOW_GIT_PATH_BATCH: 200,
  /** Tool git (status/diff/log/commit). Longgar karena `git_commit` menjalankan
   * beberapa operasi berurutan dan mesin sibuk membuat spawn git lambat. */
  GIT_TIMEOUT_MS: 20_000,
  /** F-15: cap output git saat streaming (git_diff/log di repo raksasa). */
  GIT_OUTPUT_MAX_CHARS: 500_000,
  /** Executor & sub-agents — tuned for 4-core laptop (6/1) vs 8/2 server */
  /** [T-008 OBSERVATION.md] Batas langkah = backstop, bukan anggaran kerja.
   * 50 terlalu kecil untuk kerja nyata (4 dari 5 `turn.failed` pada sesi
   * 17b6a5ff adalah `exceeded 50 steps`). Default kini 200 dan NAIK satu tangga
   * otomatis saat sesi terbukti mentok — lihat `src/policy/step-escalation.ts`.
   * Cap sub-agent naik ke 100 atas rekomendasi riset & persetujuan owner;
   * pagar tetap ada (pool, provider cooldown, watchdog liveness, eskalasi
   * satu tangga), jadi ini bukan delegasi tanpa batas. */
  DEFAULT_MAX_STEPS: 200,
  EXECUTOR_CONCURRENCY: 6,
  EXECUTOR_WRITE_CONCURRENCY: 1,
  /**
   * Slot konkuren untuk sub-agen. Default 5: fan-out 5 explorer kini benar-
   * benar jalan paralel, tak ada 2 anak yang mengantri menunggu slot.
   * Env `MINICODE_SUB_AGENT_POOL_SIZE` masih bisa meng-override (1..16) bila
   * mesin lebih kecil. Antrian lama (dengan 3 slot) bukan penyebab
   * "turn exceeded ...ms" — clock mulai saat slot didapat — tapi menghilangkan
   * antrean membuat total wall-clock fan-out lebih pendek.
   */
  SUB_AGENT_POOL_SIZE: envBoundedInt("MINICODE_SUB_AGENT_POOL_SIZE", 5, 1, 16),
  SUB_AGENT_BUDGET_EXPLORE: 24,
  SUB_AGENT_BUDGET_PLAN: 36,
  /** Ambang bacaan berturut-turut untuk detektor NoProgress pada sub-agent:
   *  angka 8 terlalu ketat bagi mode `plan` di proyek besar saat fase recon. */
  SUB_AGENT_CONSECUTIVE_READ_LIMIT: 48,
  /** [T-008] Cap langkah eksplisit sub-agent naik 50 → 100 → 600 (persetujuan
   * owner) agar sebanding dengan timeout 1 jam (~6 dtk/langkah, rasio lama
   * 300 dtk/50). Tetap TERPILAH dari `DEFAULT_MAX_STEPS` sesi utama. KENAPA
   * aman: pagar lain tetap — pool 5, provider cooldown 60 dtk, NoProgress 8,
   * watchdog idle 120 dtk, ACE consequence, riwayat bound 32. Ini atap
   * backstop, bukan izin berputar tanpa henti. */
  SUB_AGENT_MAX_STEPS: 600,
  /**
   * Timeout satu turn sub-agen. Naik 120_000 → 300_000 → 600_000 → 3_600_000
   * (1 jam). Audit 2026-11-23: 300 dtk masih kehabisan waktu untuk 4 explorer
   * paralel dengan ~38–51 tool call (prompt pendek kena ratio 0,6 ⇒ 180 dtk).
   * Aman karena watchdog liveness (`task.ts:1192-1224`) membunuh anak yang
   * benar-benar diam dalam 120 dtk — jadi pagu panjang hanya membantu anak
   * yang sehat tapi lambat, bukan membiarkan proses macet. Pagaru biaya tetap
   * `SUB_AGENT_MAX_STEPS` (100), bukan timeout. Env
   * `MINICODE_SUB_AGENT_TIMEOUT_MS` tetap meng-override.
   */
  SUB_AGENT_TIMEOUT_MS: envBoundedInt("MINICODE_SUB_AGENT_TIMEOUT_MS", 3_600_000, 1, JS_TIMER_MAX),
  /**
   * Interval watchdog liveness sub-agent. Tiap ~2 detik watchdog memeriksa
   * apakah anak masih mengirim `step:started`/`step:completed`. KENAPA 2 dtk:
   * cukup cepat untuk menghentikan anak yang diam sebelum timeout penuh
   * (5 menit), tapi jarang cukup untuk menambah beban pada pool paralel.
   */
  SUB_AGENT_HEARTBEAT_INTERVAL_MS: 2_000,
  /**
   * Atap anggaran DIAM anak sebelum watchdog mengambil tindakan. Anggaran
   * aktual = `min(resolvedTimeout / 4, angka ini)`. KENAPA ada atap: timeout
   * yang sangat besar (override caller) tak boleh membuat anak bisu dibiarkan
   * berjam-jam; 120 dtk masih di atas jeda wajar antar-langkah model.
   */
  SUB_AGENT_IDLE_BUDGET_CAP_MS: 120_000,
  /**
   * v7.33: batas teks partial yang diselamatkan saat turn sub-agent timeout.
   * Dipindah dari konstanta lokal `src/tools/task.ts` ke sini supaya satu
   * sumber angka untuk pagu output child (sejajar CHILD_RESULT_SUMMARY_MAX di
   * session/verification.ts). Naik 1,2k → 4k char supaya jejak partial dari
   * anak yang mentok/timeout cukup untuk dilanjutkan parent tanpa mengulang
   * kerja; batas tetap ada agar pesan error parent tak menggelembung.
   */
  MAX_PARTIAL_CHARS: 4_000,
  /** Network / providers */
  RETRY_AFTER_MAX_MS: 30_000,
  /** F-11: batas TOTAL satu request provider (server hung = turn hung tanpa
   * ini). Longgar (5 mnt) karena reasoning stream sah bisa bermenit-menit;
   * timeout turn (default 1 jam) tetap backstop terluar.
   *
   * Catatan audit freeze 2026-11-16: ini BUKAN timeout idle. Provider yang
   * menerima koneksi lalu diam tanpa satu byte pun juga menghabiskan seluruh
   * 5 menit — itulah "macet" yang dikeluhkan. Deteksi diam ditangani
   * `PROVIDER_IDLE_TIMEOUT_MS` di bawah; keduanya dipakai bersama. */
  PROVIDER_REQUEST_TIMEOUT_MS: 300_000,
  /** Batas total maksimum satu stream HTTP provider yang TERUS aktif mengirim SSE byte/keepalive (1 jam). */
  PROVIDER_STREAM_MAX_ACTIVE_MS: 3_600_000,
  /** Batas tunggu byte/aktivitas PERTAMA dari provider sebelum request dianggap
   * macet saat fase prefill/antrean (konteks 62k+ token / model reasoning tanpa
   * SSE keepalive comment bisa melampaui 60 dtk sebelum token pertama keluar).
   * Setelah byte/keepalive pertama tiba, batas turun ke `PROVIDER_IDLE_TIMEOUT_MS`. */
  PROVIDER_FIRST_BYTE_TIMEOUT_MS: 90_000,
  /** Batas DIAM antar-chunk (tidak ada byte/keepalive apa pun dari provider)
   * setelah stream aktif sebelum request dianggap mati. Timer di-reset setiap
   * ada byte SSE masuk (termasuk komentar `: OPENROUTER PROCESSING` / `: ping`),
   * jadi stream lambat yang tetap hidup TIDAK terpotong. */
  PROVIDER_IDLE_TIMEOUT_MS: 60_000,
  /** F-16: cap akumulasi teks per stream (anti-OOM); hanya memotong kasus
   * patologis (~250rb token teks dalam satu turn). */
  PROVIDER_TEXT_MAX_CHARS: 1_000_000,
  /** Investigasi Phase 5: cap reasoning stream (terbukti TANPA cap = akumulasi
   * tak terbatas — satu-satunya jalur loop `reasoning +=` tanpa batas). */
  PROVIDER_REASON_MAX_CHARS: 2_000_000,
  /** Frame SSE provider longgar untuk JSON tool besar (write_file menerima 5 MB chars). */
  PROVIDER_SSE_FRAME_MAX_BYTES: 16_777_216,
  /** Batas total satu respons stream provider, termasuk reasoning/tool args. */
  PROVIDER_SSE_TOTAL_MAX_BYTES: 67_108_864,
  /** Argumen tool besar tetap didukung; envelope JSON dapat menggandakan escape chars. */
  PROVIDER_TOOL_ARGS_MAX_BYTES: 12_582_912,
  /** Batas agregat argumen yang masih tertahan dari beberapa tool call. */
  PROVIDER_TOOL_ARGS_PENDING_MAX_BYTES: 25_165_824,
  /** Respons error provider cukup untuk diagnosis tanpa membaca body arbitrer. */
  PROVIDER_ERROR_BODY_MAX_BYTES: 65_536,
  DOCKER_TIMEOUT_MS: 30_000,
  DETECT_MODELS_TIMEOUT_MS: 4_000,
  DETECT_GLOBAL_TIMEOUT_MS: 6_000,
  DETECT_ATTEMPT_TIMEOUT_MS: 2_500,
  MCP_HANDSHAKE_TIMEOUT_MS: 15_000,
  /** OAuth device flow: request pendek, tapi poll bisa berlangsung menit. */
  OAUTH_REQUEST_TIMEOUT_MS: 15_000,
  /** Pricing dari models.dev — cache agar tidak menembak jaringan tiap run. */
  PRICING_FETCH_TIMEOUT_MS: 5_000,
  /** Katalog models.dev asli ~4,4 MB; batasi baca stream pada 12 MiB agar tak OOM maupun terpotong di tengah JSON. */
  PRICING_FETCH_MAX_BYTES: 12_582_912,
  PRICING_CACHE_TTL_MS: 86_400_000,
  LSP_DIAGNOSTICS_TIMEOUT_MS: 5_000,
  LSP_INIT_TIMEOUT_MS: 15_000,
  /** v7.38: pagu `lsp_rename` — nama simbol baru & jumlah edit WorkspaceEdit.
   * Tanpa pagu, server LSP jahat bisa memaksa tool menulis ribuan file/edit
   * dalam satu panggilan (biaya & risiko di luar authority satu rename). */
  LSP_RENAME_MAX_NAME_CHARS: 200,
  LSP_RENAME_MAX_EDITS: 500,
  VERIFY_DEFAULT_TIMEOUT_MS: 30_000,
  WEB_FETCH_BODY_HARD_CAP_CHARS: 2_000_000,
  WEB_RESPONSE_BODY_HARD_CAP_BYTES: 2_000_000,
  WEB_FETCH_MAX_REDIRECTS: 5,
  /** Glob/grep */
  SEARCH_DEFAULT_LIMIT: 100,
  SEARCH_MAX_LIMIT: 500,
  /** grep: ripgrep dipakai bila ada di PATH; fallback walker JS */
  GREP_RIPGREP_TIMEOUT_MS: 15_000,
  GREP_MATCH_MAX_CHARS: 300,
  GREP_FILE_MAX_BYTES: 1_000_000,
  /** todo list per sesi */
  TODO_MAX_ITEMS: 50,
  TODO_CONTENT_MAX_CHARS: 200,
  /** SQLite */
  SQLITE_BUSY_TIMEOUT_MS: 3_000,
  SQLITE_WAL_SIZE_LIMIT_BYTES: 33_554_432,
  SQLITE_WAL_AUTOCHECKPOINT_PAGES: 1_000,
  /** Telemetry */
  TRACE_MAX_LINES: 1_000,
  /** Repo-map */
  REPOMAP_MAX_FILES: 60,
  REPOMAP_MAX_FILE_BYTES: 100_000,
  REPOMAP_MAX_CHARS: 2_500,
  REPOMAP_MAX_SYMBOLS_PER_FILE: 40,
} as const

/** LSP SymbolKind string mapping (1-indexed, LSP specification) */
export const LSP_SYMBOL_KINDS = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const
