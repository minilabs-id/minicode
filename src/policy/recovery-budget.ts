/**
 * Anggaran pemulihan bersama untuk SATU panggilan logis ke penyedia.
 *
 * ── Kenapa modul ini ada ────────────────────────────────────────────────────
 * Insiden aslinya (sesi `17b6a5ff`, OBSERVATION.md T-009): satu gangguan
 * penyedia yang berlangsung belasan detik mematikan sesi total, karena anggaran
 * retry kernel hanya 3 percobaan (1+2+4 = 7 dtk).
 *
 * Perbaikan naif — "naikkan jumlah percobaan di retry, lalu tambahkan resume
 * turn" — sudah dicoba dan salah secara struktural. Retry dan resume berada di
 * dua lapisan berbeda, jadi biayanya BERKALI, bukan bertambah: 5 percobaan retry
 * diulang untuk setiap resume menghasilkan 3 × 23 dtk + 13 dtk ≈ **82 detik**
 * untuk provider yang mati permanen. Sebelum perubahan itu hanya 7 detik.
 *
 * Itu bukan bug angka, melainkan anti-pattern yang punya nama: *retry
 * amplification* / *retry storm* (AWS Well-Architected REL05-BP03, "implement
 * retries at only one level"). Setiap lapisan yang punya anggarannya sendiri
 * mengalikan lapisan di bawahnya, dan hasilnya adalah penundaan raksasa tanpa
 * tambahan kesembuhan.
 *
 * ── Yang dipakai sebagai gantinya (riset 2026) ──────────────────────────────
 * Satu anggaran WAKTU TOTAL dipegang di puncak, dan setiap percobaan memakai
 * sisa anggaran itu. Konsekuensinya: biaya total konstan berapa pun banyaknya
 * lapisan yang mencoba. Ini pola "timeout budget" yang sama dipakai SDK AWS
 * (retry quota), Google SRE, dan panduan agent-loop modern: *"a budget removes
 * the multiplication by construction — the second attempt inherits what the
 * first one left"*.
 *
 * Tiga mekanisme yang ikut dibawa dari praktik standar:
 *   1. **Retry quota (token bucket)** — AWS standard mode. Token berkurang tiap
 *      percobaan dan pulih saat sukses. Saat habis, kita berhenti cepat alih-alih
 *      menunggu penuh untuk kegagalan yang sudah jelas tidak membaik. Inilah yang
 *      membuat provider mati total gagal dalam hitungan detik, bukan menit.
 *   2. **Full jitter** — jeda acak pada `[0, delay]` (bukan delay pasti). Tanpa
 *      jitter, semua klien yang gagal bersamaan mencoba lagi bersamaan pula dan
 *      mengulang beban yang sama: *thundering herd* yang tertunda.
 *   3. **`Retry-After` sebagai FLOOR, bukan target** — provider lebih tahu kapan
 *      jendelanya dibuka; kita tidak pernah menunggu lebih pendek dari itu.
 *
 * ── Apa yang TIDAK dilakukan ────────────────────────────────────────────────
 * - Tidak ada penambahan jumlah percobaan tanpa batas. Anggaran waktu dan kuota
 *   token adalah dua pagar yang berbeda; keduanya wajib.
 * - Tidak ada retry untuk kegagalan terminal (auth, request invalid, konteks
 *   kehabisan, anggaran habis). Mengulangnya tidak mengubah hasil.
 *
 * Modul ini MURNI (tanpa I/O, tanpa jam global) supaya kebijakan bisa diuji
 * langsung: pemanggil memberi `nowMs`, bukan menyembunyikan `Date.now()`.
 */

/** Batas atas waktu yang boleh dipakai untuk memulihkan SATU panggilan logis.
 *
 * KENAPA 45 dtk: ini menutup gangguan penyedia yang nyata (insiden asli ~11 dtk;
 * 529 "overloaded" Anthropic biasanya pulih dalam hitungan detik) dengan margin
 * besar, sambil tetap jauh di bawah kesabaran user untuk perintah satu-shot dan
 * deadline turn headless. Angka ini juga konsisten dengan praktik umum: panduan
 * AWS menyarankan maksimum backoff 20 dtk, dan anggaran total harus beberapa kali
 * lebih besar agar beberapa percobaan tetap masuk.
 */
export const RECOVERY_BUDGET_MS = 45_000

/** Kuota percobaan (token bucket). AWS standard mode memakai 3 percobaan total
 * untuk satu request; kita memberi 6 slot karena satu panggilan di sini mencakup
 * retry provider DAN resume turn (dua lapisan yang sekarang berbagi satu kuota).
 *
 * KENAPA tetap terbatas walau ada anggaran waktu: anggaran waktu saja akan
 * menghabiskan 45 dtk penuh untuk provider yang mati. Kuota membuatnya berhenti
 * cepat (≈10–15 dtk) begitu polanya jelas "gagal terus". */
export const RECOVERY_ATTEMPT_QUOTA = 6

/** Backoff dasar dan plafon per percobaan (ms).
 *
 * KENAPA 500 dan 8 dtk: AWS memakai base 50 ms untuk transient (sangat cepat
 * karena panggilan HTTP-nya sendiri sudah cepat) dan 1 dtk untuk throttling.
 * Panggilan LLM jauh lebih mahal dan lebih lambat, jadi base 500 ms masuk akal,
 * dengan plafon 8 dtk yang sama dengan plafon backoff SDK Anthropic. */
export const RECOVERY_BASE_DELAY_MS = 500
export const RECOVERY_MAX_DELAY_MS = 8_000

/** Batas minimum jeda agar tidak menjadi hot loop (ms). */
export const RECOVERY_MIN_DELAY_MS = 50

/** Alasan berhenti — dipakai untuk pesan ke user, bukan sekadar dibuang. */
export type RecoveryStopReason =
  /** Kategori/kind tidak akan membaik dengan diulang. */
  | "not-transient"
  /** Kuota percobaan habis (token bucket kosong). */
  | "attempts-exhausted"
  /** Anggaran waktu total habis. */
  | "budget-exhausted"
  /** User membatalkan (Ctrl+C / abort). */
  | "user-abort"
  /** Anggaran biaya/token model sudah habis — bukan gangguan penyedia. */
  | "cost-budget"
  /** Tidak ada prompt untuk dilanjutkan. */
  | "no-prompt"

/** Kelanjutan yang diizinkan untuk sebuah kegagalan. */
export type RecoveryDecision =
  | {
      action: "retry"
      /** Percobaan ke berapa (1-based) setelah keputusan ini dijalankan. */
      attempt: number
      /** Jeda sebelum percobaan itu (sudah termasuk jitter). */
      delayMs: number
      /** Sisa anggaran waktu setelah jeda (ms), untuk diagnostik/uji. */
      remainingMs: number
    }
  | { action: "stop"; reason: RecoveryStopReason }

/** Keadaan anggaran pada satu titik waktu. */
export interface RecoveryState {
  /** Waktu mulai percobaan pertama (epoch ms). */
  startedAtMs: number
  /** Waktu sekarang (epoch ms) — diberikan pemanggil, bukan diambil sendiri. */
  nowMs: number
  /** Percobaan yang SUDAH dipakai dari kuota. */
  attemptsUsed: number
}

/** Sinyal kegagalan minimum, dipisah dari kelas error konkret agar murni. */
export interface FailureSignal {
  /** Kategori provider bila kegagalannya berasal dari penyedia. */
  category?: string
  /** Kode kind AgentError (`max_steps_exceeded`, `aborted`, ...). */
  kind?: string
  /** True bila pembatalan datang dari user (bukan timeout internal). */
  abortedByUser?: boolean
  /** Petunjuk tunggu dari provider (`Retry-After`), ms. */
  retryAfterMs?: number
}

/** Kategori provider yang layak dicoba ulang: gangguan di sisi penyedia/jaringan.
 *
 * KENAPA `rate_limit` TIDAK ikut (riset 2026): 429 punya dua wajah yang tidak
 * bisa dibedakan dari status saja. Yang biasa membawa `Retry-After` dan sudah
 * ditangani lapisan retry (menghormati header, 3 percobaan) — mengulanginya di
 * sini hanya menggandakan jeda. Yang kedua permanen: spend cap Anthropic (tanpa
 * `Retry-After`) dan `credit_balance_exhausted`/spend-limit OpenAI, yang tidak
 * pulih walau ditunggu. 5xx — termasuk 529 "overloaded" Anthropic yang dipetakan
 * adapter ke `server` — tidak punya sinyal itu, dan di situlah pemulihan berguna.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<string> = new Set(["server", "network"])

/** Kind kegagalan yang layak diulang ketika kategori tidak terbawa.
 *
 * KENAPA hanya `provider`: itu penanda "kegagalannya datang dari penyedia", dan
 * kategori di atas yang memutuskan apakah sementaranya.
 *
 * KENAPA `budget_exceeded` TIDAK ikut (regresi nyata yang tertangkap tes):
 * anggaran biaya yang habis bukan kondisi sementara. Mengulang turn justru
 * MEMBAKAR lebih banyak uang untuk melewati pagar yang sama lalu gagal di titik
 * yang sama. Gejalanya persis itu: `budget exceeded` → jeda → `budget exceeded`,
 * dua kali membayar penuh lewat provider, dan bagi operator tampak seperti
 * provider rusak padahal sistem sedang menghormati pagar yang ia sendiri pasang.
 *
 * `aborted`, `max_turns`, auth, dan request invalid juga TIDAK. `max_steps_exceeded`
 * punya jalur sendiri (eskalasi batas langkah); kalau ikut di sini, turn diulang
 * SEKALIGUS batasnya dinaikkan — biaya ganda untuk satu masalah.
 */
const RETRYABLE_KINDS: ReadonlySet<string> = new Set(["provider"])

/** Kategori yang secara eksplisit TIDAK akan membaik walau diulang. Didaftarkan
 * supaya "tidak di-retry" menjadi keputusan yang disengaja, bukan efek samping
 * dari daftar yang tak memuatnya. */
const TERMINAL_CATEGORIES: ReadonlySet<string> = new Set([
  "auth",
  "invalid_request",
  "context_length_exceeded",
])

/** Kind yang terminal untuk tujuan pemulihan. */
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "aborted",
  "budget_exceeded",
  "max_turns",
  "max_steps_exceeded",
])

/**
 * Apakah kegagalan ini layak untuk dicoba lagi sama sekali.
 *
 * Dipisah dari {@link planRecovery} supaya daftar terminal bisa diuji sendiri —
 * kesalahan di sini adalah kesalahan diagnosis, dan diagnosis yang salah membuat
 * semua anggaran di bawahnya sia-sia.
 */
export function isRecoverable(failure: FailureSignal): boolean {
  if (failure.abortedByUser === true) return false
  if (failure.kind !== undefined && TERMINAL_KINDS.has(failure.kind)) return false
  if (failure.category !== undefined) {
    if (TERMINAL_CATEGORIES.has(failure.category)) return false
    return TRANSIENT_CATEGORIES.has(failure.category)
  }
  // Kategori tidak terbawa: pakai kind sebagai cadangan.
  return failure.kind !== undefined && RETRYABLE_KINDS.has(failure.kind)
}

/**
 * Full jitter: nilai acak pada `[min, delay]`.
 *
 * KENAPA full jitter dan bukan "delay + sedikit acak": tujuan jitter adalah
 * memecah klien yang gagal bersamaan agar tidak mencoba bersamaan lagi. Jeda
 * deterministik menghasilkan thundering herd yang hanya tertunda. AWS
 * Architecture Blog: `sleep = random_between(0, min(cap, base * 2^attempt))`.
 *
 * `min` dinaikkan dari 0 ke {@link RECOVERY_MIN_DELAY_MS} agar percobaan pertama
 * tidak menjadi hot retry (dan agar `Retry-After` kecil tetap dihormati sebagai
 * floor). `random` di-inject supaya uji deterministik.
 */
export function fullJitterDelay(delayMs: number, random: () => number = Math.random): number {
  const cap = Math.max(RECOVERY_MIN_DELAY_MS, delayMs)
  const spread = cap - RECOVERY_MIN_DELAY_MS
  // random() bisa bernilai 1.0 pada implementasi lain; clamp agar tidak overflow.
  const r = Math.min(1, Math.max(0, random()))
  return Math.round(RECOVERY_MIN_DELAY_MS + spread * r)
}

/**
 * Jeda eksponensial untuk percobaan ke-`attempt` (1-based), dengan plafon.
 * `retryAfterMs` (bila wajar) diperlakukan sebagai FLOOR — kita tidak pernah
 * menunggu lebih pendek daripada yang diminta provider, karena itu berarti
 * membakar percobaan sebelum jendelanya dibuka.
 */
export function recoveryDelay(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RECOVERY_MAX_DELAY_MS,
  )
  const floor =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, RECOVERY_MAX_DELAY_MS)
      : 0
  const target = Math.max(exponential, floor)
  return fullJitterDelay(target, random)
}

/**
 * Putuskan langkah pemulihan berikutnya untuk satu panggilan logis.
 *
 * Urutan pemeriksaan penting dan sengaja tetap:
 *   1. Kendali user — abort tidak pernah dilanjutkan.
 *   2. Diagnosis — terminal berhenti sebelum menghitung anggaran apa pun.
 *   3. Anggaran biaya model — bukan gangguan, jadi tidak boleh "dipulihkan".
 *   4. Kuota percobaan (fail fast saat pola sudah jelas).
 *   5. Anggaran waktu total (pagar terakhir).
 */
export function planRecovery(
  failure: FailureSignal,
  state: RecoveryState,
  opts: {
    hasPrompt: boolean
    costBudgetExhausted?: boolean
    /** Di-inject untuk uji deterministik. */
    random?: () => number
  },
): RecoveryDecision {
  if (!opts.hasPrompt) return { action: "stop", reason: "no-prompt" }
  if (failure.abortedByUser === true || failure.kind === "aborted")
    return { action: "stop", reason: "user-abort" }
  if (opts.costBudgetExhausted === true) return { action: "stop", reason: "cost-budget" }
  if (!isRecoverable(failure)) return { action: "stop", reason: "not-transient" }

  // Kuota dulu, lalu waktu: kuota adalah pagar yang jauh lebih murah untuk
  // diperiksa dan mencegah 45 dtk terpakai untuk pola "gagal terus".
  if (state.attemptsUsed >= RECOVERY_ATTEMPT_QUOTA)
    return { action: "stop", reason: "attempts-exhausted" }

  const elapsed = state.nowMs - state.startedAtMs
  const remainingMs = RECOVERY_BUDGET_MS - elapsed
  const attempt = state.attemptsUsed + 1
  const delayMs = recoveryDelay(attempt, failure.retryAfterMs, opts.random)
  // Perlu sisa untuk jeda ini DAN untuk percobaan sesudahnya. Kalau jeda saja
  // sudah melebihi sisa anggaran, menunggu lalu mencoba lagi hanya membuat user
  // menunggu tanpa kesempatan berhasil.
  if (delayMs >= remainingMs) return { action: "stop", reason: "budget-exhausted" }

  return { action: "retry", attempt, delayMs, remainingMs: remainingMs - delayMs }
}
