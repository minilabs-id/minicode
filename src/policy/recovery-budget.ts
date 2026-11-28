/**
 * Anggaran pemulihan bersama untuk satu panggilan logis ke penyedia.
 * Menyatukan budget waktu total (45 dtk) dan kuota token bucket agar retry
 * provider dan resume turn tidak mengalikan penundaan satu sama lain, lengkap
 * dengan full jitter dan `Retry-After` sebagai batas bawah. Murni tanpa I/O.
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

/** Batas percobaan retry untuk kegagalan timeout/stall koneksi per episode
 * (persetujuan pemilik 2026-11-27: 2× retry agar stall sementara bisa pulih
 * tanpa mengembalikan anti-pattern 6 × 60-90 dtk pada endpoint yang mati total). */
export const RECOVERY_STALL_RETRY_CAP = 2

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
  /** Waktu mulai episode kegagalan (epoch ms). */
  startedAtMs: number
  /** Waktu sekarang (epoch ms) — diberikan pemanggil, bukan diambil sendiri. */
  nowMs: number
  /** Percobaan yang SUDAH dipakai dari kuota. */
  attemptsUsed: number
  /** Percobaan retry stall/timeout yang SUDAH dipakai di episode aktif. */
  stallAttemptsUsed?: number
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
  /** True bila kegagalan dipicu timeout/stall koneksi (tunggu >= idle/request timeout). */
  stalled?: boolean
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
/** Batas waktu total menunggu gangguan penyedia berkelanjutan di mode `--autonomous` (4 jam). */
export const AUTONOMOUS_OUTAGE_MAX_WAIT_MS = 14_400_000
/** Tangga jeda cooldown bertahap untuk gangguan panjang tanpa thundering herd (maks 15 mnt). */
const AUTONOMOUS_COOLDOWN_STEPS_MS: readonly number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
]

export function isPermanentQuotaMessage(message?: string): boolean {
  if (!message) return false
  return (
    /\b402\b/.test(message) ||
    /quota[\s_]?exceeded|insufficient[\s_]?quota|exceeded (?:its|your) quota|credit[\s_]?balance[\s_]?exhausted/i.test(
      message,
    )
  )
}

/**
 * Tier-2 pemulihan untuk mode otonom multi-jam/hari: ketika kuota cepat 45 dtk
 * habis pada gangguan server/jaringan/rate-limit sementara, tunggu terukur hingga
 * batas `maxWaitMs` alih-alih mematikan eksekusi semalam suntuk.
 */
export function planAutonomousOutageCooldown(input: {
  failure: FailureSignal & { message?: string }
  elapsedOutageMs: number
  cooldownAttempt: number
  hasPrompt: boolean
  costBudgetExhausted?: boolean
  maxWaitMs?: number
  random?: () => number
}): RecoveryDecision {
  const { failure } = input
  if (!input.hasPrompt) return { action: "stop", reason: "no-prompt" }
  if (failure.abortedByUser === true || failure.kind === "aborted")
    return { action: "stop", reason: "user-abort" }
  if (input.costBudgetExhausted === true) return { action: "stop", reason: "cost-budget" }
  if (failure.kind !== undefined && TERMINAL_KINDS.has(failure.kind))
    return { action: "stop", reason: "not-transient" }
  if (failure.category !== undefined && TERMINAL_CATEGORIES.has(failure.category))
    return { action: "stop", reason: "not-transient" }
  if (isPermanentQuotaMessage(failure.message)) return { action: "stop", reason: "not-transient" }

  const recoverable =
    failure.category === "server" ||
    failure.category === "network" ||
    failure.category === "rate_limit" ||
    failure.kind === "provider"
  if (!recoverable) return { action: "stop", reason: "not-transient" }

  const maxWaitMs =
    input.maxWaitMs !== undefined && Number.isFinite(input.maxWaitMs) && input.maxWaitMs > 0
      ? input.maxWaitMs
      : AUTONOMOUS_OUTAGE_MAX_WAIT_MS
  const remainingMs = maxWaitMs - Math.max(0, input.elapsedOutageMs)
  if (remainingMs <= 1_000) return { action: "stop", reason: "budget-exhausted" }

  const idx = Math.min(Math.max(0, input.cooldownAttempt), AUTONOMOUS_COOLDOWN_STEPS_MS.length - 1)
  const baseStep = AUTONOMOUS_COOLDOWN_STEPS_MS[idx] ?? 900_000
  const maxStep = Math.max(baseStep, 900_000)
  const retryFloor =
    failure.retryAfterMs !== undefined &&
    Number.isFinite(failure.retryAfterMs) &&
    failure.retryAfterMs > 0
      ? Math.min(failure.retryAfterMs, maxStep)
      : 0
  const target = Math.max(baseStep, retryFloor)
  const r = Math.min(1, Math.max(0, (input.random ?? Math.random)()))
  // Jitter separuh bawah menjaga jeda tidak pernah turun menjadi spam hot-retry.
  const delayMs = Math.min(remainingMs, Math.round(target * (0.5 + 0.5 * r)))
  if (delayMs >= remainingMs) return { action: "stop", reason: "budget-exhausted" }
  return {
    action: "retry",
    attempt: input.cooldownAttempt + 1,
    delayMs,
    remainingMs: remainingMs - delayMs,
  }
}

export function planRecovery(
  failure: FailureSignal,
  state: RecoveryState,
  opts: {
    hasPrompt: boolean
    costBudgetExhausted?: boolean
    /** Anggaran waktu total khusus pemanggil ini (ms). Default
     * `RECOVERY_BUDGET_MS`. Dipakai panggilan yang memang boleh lebih lama
     * dari satu request chat — mis. ringkasan kompaksi, yang butuh puluhan
     * detik per percobaan secara sah — tanpa melonggarkan anggaran pemulihan
     * turn biasa. */
    budgetMs?: number
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
  const hasExplicitBudget =
    opts.budgetMs !== undefined && Number.isFinite(opts.budgetMs) && opts.budgetMs > 0
  const budgetMs = hasExplicitBudget ? opts.budgetMs! : RECOVERY_BUDGET_MS
  const remainingMs = budgetMs - elapsed
  const attempt = state.attemptsUsed + 1
  const delayMs = recoveryDelay(attempt, failure.retryAfterMs, opts.random)
  if (failure.stalled === true) {
    // Stall/timeout baru terdeteksi setelah menunggu >= 60–90 dtk, jadi jam
    // 45 dtk untuk gangguan cepat tidak boleh memblokir retry ke-1..2; pagarnya
    // adalah RECOVERY_STALL_RETRY_CAP (2×) + kuota bersama (6).
    const stallUsed = state.stallAttemptsUsed ?? 0
    if (stallUsed >= RECOVERY_STALL_RETRY_CAP)
      return { action: "stop", reason: "attempts-exhausted" }
    if (hasExplicitBudget && delayMs >= remainingMs)
      return { action: "stop", reason: "budget-exhausted" }
    return {
      action: "retry",
      attempt,
      delayMs,
      remainingMs: Math.max(0, remainingMs - delayMs),
    }
  }
  // Perlu sisa untuk jeda ini DAN untuk percobaan sesudahnya. Kalau jeda saja
  // sudah melebihi sisa anggaran, menunggu lalu mencoba lagi hanya membuat user
  // menunggu tanpa kesempatan berhasil.
  if (delayMs >= remainingMs) return { action: "stop", reason: "budget-exhausted" }

  return { action: "retry", attempt, delayMs, remainingMs: remainingMs - delayMs }
}
