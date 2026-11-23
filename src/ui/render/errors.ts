// Pemetaan error provider/agent → pesan yang bisa ditindaklanjuti.
//
// PENTING: modul ini punya 10 test tapi dulu TIDAK dipanggil dari mana pun di
// kode produksi. Renderer memakai formatProviderError() yang mencetak
// `[kategori] <pesan mentah>`, sehingga body JSON provider tumpah utuh ke layar.
// Terlihat pada uji live OpenRouter: satu error 429 mencetak 400+ karakter
// berisi `metadata`, `provider_error_code`, `limit_source`, dan URL dokumentasi
// — di dalam frame TUI selebar 100 kolom.

import { t } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "./sanitize.ts"
import { tSystem } from "./tool-label.ts"
import { truncateToWidth } from "./width.ts"

export interface FriendlyError {
  message: string
  fix?: string
}

/**
 * Ambil kalimat paling berguna dari body error provider.
 *
 * Bentuk yang ditemui di lapangan:
 * - OpenAI/umum : {"error":{"message":"..."}}
 * - OpenRouter  : {"error":{"message":"Provider returned error","metadata":{"raw":"<alasan sebenarnya>","remedy_hint":"..."}}}
 *   Di sini `message` justru tidak informatif; `metadata.raw` yang menjelaskan.
 * - Cloudflare  : HTML dengan <title>host | 502: Bad gateway</title>
 */
export function extractProviderDetail(raw: string): { detail?: string; hint?: string } {
  const trimmed = raw.trim()
  // JSON: cari objek pertama yang bisa di-parse.
  const start = trimmed.indexOf("{")
  if (start !== -1) {
    try {
      const parsed = JSON.parse(trimmed.slice(start)) as {
        error?: {
          message?: string
          metadata?: { raw?: string; remedy_hint?: string; provider_name?: string }
        }
      }
      const err = parsed.error
      const meta = err?.metadata
      // metadata.raw lebih spesifik daripada message generik OpenRouter.
      const detail = firstSentence(meta?.raw ?? err?.message)
      const hint = firstSentence(meta?.remedy_hint)
      return { ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) }
    } catch {
      // Body terpotong (streaming) — jatuh ke regex di bawah.
    }
  }
  // HTML: judul halaman error biasanya sudah menjelaskan.
  const title = /<title>([^<]{1,120})<\/title>/i.exec(trimmed)
  // Judul HTML dari provider tak terpercaya — sanitasi satu-baris agar tag
  // / escape tak lolos via jalur error.
  if (title) return { detail: sanitizeAnsiLine(title[1]!.trim()) }
  // Regex terakhir untuk body yang TERPOTONG (stream terputus di tengah JSON).
  // `raw` didahulukan: pada OpenRouter itu yang memuat alasan sebenarnya,
  // sementara `message` hanya "Provider returned error". Kutip penutup dibuat
  // opsional — pada body terpotong ia memang belum ada.
  for (const field of ["raw", "message"]) {
    const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,300})"?`)
    const m = re.exec(trimmed)
    const value = m?.[1]?.replace(/\\"/g, '"').trim()
    if (value) return { detail: firstSentence(value) }
  }
  return {}
}

/** Satu kalimat pertama, dipangkas — bukan paragraf berisi URL dan kode. */
function firstSentence(s?: string, max = 150): string | undefined {
  if (!s) return undefined
  const clean = s.replace(/\s+/g, " ").trim()
  if (!clean) return undefined
  const cut = /^(.{20,}?[.!?])\s/.exec(clean)
  const one = cut ? cut[1]! : clean
  // Potong per KOLOM terminal (CJK/emoji = 2) dan jangan belah SGR/surrogate;
  // input di sini belum tentu sanitize, jadi sanitasi satu-baris dulu agar
  // ESC[2J/OSC tak lolos via pesan error provider yang tak terpercaya.
  const safe = sanitizeAnsiLine(one)
  return truncateToWidth(safe, max, "…")
}

/**
 * Redaksi rahasia minimal untuk jalur tampil (temuan audit #03, diperketat
 * audit #10 §8/§10/§11).
 *
 * src/ui DILARANG mengimpor policy/scrub.ts (ui-boundary), jadi pola penuh
 * tinggal di sana sebagai kanonis. Yang di sini hanya jaring pengaman untuk
 * kasus konkret: proxy/server menggemakan kredensial ke dalam body error
 * (mis. `Authorization: Bearer …`), yang lalu dirender verbatim oleh
 * formatError. Bukan pengganti scrubSecrets — hanya untuk pesan error.
 *
 * Dua bentuk ditangani BERURUTAN (temuan audit #10, reproducer: header
 * Authorization Bearer — sebelumnya hanya `Authorization:` yang teredaksi
 * sebagai key=value sehingga token aslinya tetap tampil):
 *  1. `Bearer <token>` spasi (bentuk header HTTP yang sah — tanpa `:`/`=`).
 *  2. `key=value`/`key: value` untuk kata-kunci kredensial + cookie/session.
 * `sessionid` dibatasi lowercase eksplisit (audit #11 §18: pola insensitif
 * ikut menyamarkan identifier `sessionId` di pesan error).
 * Guard nilai quoted/berdigit/panjang dipakai di kedua pola kv (audit #11
 * §18: tanpa guard, `token: string` dan SQL `session_id = ?` ikut tersamarkan
 * sehingga diagnostik sah buta).
 */
function redactSecrets(s: string): string {
  // Nilai berbentuk kredensial: quoted, atau berdigit, atau panjang.
  // Identifier/type-word (`string`, `graphemes`, `?`) lolos; token realistis kena.
  // `=` termasuk agar nilai cookie berbentuk pasangan kunci-nilai utuh tersamarkan.
  const V = `(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/=-]*\\d[A-Za-z0-9_~+/=-]*|[A-Za-z0-9_~+/=-]{12,})`
  const V4 = `(?:"[^"]+"|'[^']+'|[A-Za-z0-9_~+/=-]*\\d[A-Za-z0-9_~+/-]*|[A-Za-z0-9_~+/=-]{4,})`
  return (
    s
      // Format kunci provider konkret (subset scrub.ts — ui-boundary melarang
      // impor policy/scrub; pola generik di bawah tak menangkap `sk-ant-…`,
      // `thk_live_…`, `hf_…`, JWT tanpa konteks kv). Divalidasi bug-hunt
      // 2026-09-19: echo proxy key-key ini lolos mentah ke layar sebelumnya.
      .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
      .replace(/\b(thk_live_[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
      .replace(/\b(hf_[A-Za-z0-9]{20,})\b/g, "[redacted]")
      .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[redacted]")
      .replace(/([?&](?:api[_-]?key|apikey|token|secret|password)=)[^&\s"'<>]*/gi, "$1[redacted]")
      .replace(/\bbearer\s+["']?[A-Za-z0-9._~+/-]{6,}["']?/gi, "Bearer [redacted]")
      .replace(
        new RegExp(
          `((?:api[_-]?key|token|authorization|secret|password|client[_-]?secret|cookie)\\s*[:=]\\s*)(?!\\[redacted\\])(${V})`,
          "gi",
        ),
        "$1[redacted]",
      )
      .replace(new RegExp(`(\\bsession[-_]?id\\s*[:=]\\s*)(${V4})`, "g"), "$1[redacted]")
  )
}

// Mapping kategori formal -> pesan user-friendly. Detail provider disertakan
// sebagai satu kalimat bila ada (itu yang memberi tahu model mana yang limit,
// atau tool mana yang tidak didukung) — bukan seluruh body.
export function friendlyFromCategory(category: string, detail: string): FriendlyError {
  // Detail datang dari body error provider (proxy tak terpercaya): redact dulu
  // lalu sanitasi satu-baris agar ESC[2J/OSC/alternate-screen tak bisa lolos
  // via jalur error yang dicetak writer mentah di cli/.
  const truth = sanitizeAnsiLine(redactSecrets(detail.trim()))
  const { detail: providerDetail, hint } = extractProviderDetail(truth)
  const withDetail = (base: string) =>
    providerDetail && providerDetail.toLowerCase() !== base.toLowerCase()
      ? `${base}: ${providerDetail}`
      : base

  switch (category) {
    // Deteksi kata kunci TETAP Inggris: body error provider berbahasa Inggris
    // apa pun locale UI. Yang diterjemahkan hanya pesan/fix tampil.
    case "rate_limit":
      return {
        message: withDetail(t("err.rateLimit")),
        fix: hint ?? t("err.rateLimitFix"),
      }
    case "auth": {
      const low = truth.toLowerCase()
      if (
        low.includes("insufficient balance") ||
        low.includes("credits") ||
        low.includes("billing") ||
        low.includes("quota") ||
        low.includes("credit limit")
      ) {
        return {
          message: withDetail(t("err.balance")),
          fix: hint ?? t("err.balanceFix"),
        }
      }
      return {
        message: withDetail(t("err.auth")),
        fix: hint ?? t("err.authFix"),
      }
    }
    case "server":
      return {
        message: withDetail(t("err.server")),
        fix: hint ?? t("err.serverFix"),
      }
    case "network":
      return {
        message: withDetail(t("err.network")),
        fix: hint ?? t("err.networkFix"),
      }
    case "invalid_request":
      return {
        message: withDetail(t("err.invalid")),
        fix: hint ?? t("err.invalidFix"),
      }
    case "context_length_exceeded":
      return {
        message: withDetail(t("err.context")),
        fix: hint ?? t("err.contextFix"),
      }
    case "content_filter":
      return {
        message: withDetail(t("err.filter")),
        fix: hint ?? t("err.filterFix"),
      }
    default: {
      // Kategori "unknown" menampung status HTTP lain (mis. 402 dari vendor
      // yang frozen) — kenali pola tagihan/limit dari TEKS agar pesannya
      // tetap actionable, bukan dump mentah.
      const low = truth.toLowerCase()
      if (
        low.includes("insufficient balance") ||
        low.includes("credits") ||
        low.includes("billing") ||
        low.includes("quota") ||
        low.includes("credit limit") ||
        low.includes("requires more credits") ||
        low.includes("fewer max_tokens")
      ) {
        return {
          message: withDetail(t("err.balance")),
          fix: hint ?? t("err.balanceFix"),
        }
      }
      if (
        low.includes("rate limit") ||
        low.includes("rate_limit") ||
        low.includes("429") ||
        low.includes("freeusagelimit") ||
        low.includes("try again later")
      ) {
        return {
          message: withDetail(t("err.rateLimit")),
          fix: hint ?? t("err.rateLimitFix"),
        }
      }
      if (providerDetail) return { message: providerDetail, ...(hint ? { fix: hint } : {}) }
      // truth sudah sanitize satu-baris; potong per kolom agar CJK/emoji tak
      // meluap dan tak belah SGR/surrogate.
      return { message: truncateToWidth(truth, 160, "…") }
    }
  }
}

// Fallback string-only (AgentError: timeout/aborted/max_steps, dst.)
export function friendlyError(raw: string): FriendlyError {
  const lower = raw.toLowerCase()
  if (lower.includes("timed out") || lower.includes("timeout"))
    return {
      message: t("err.timeout"),
      fix: t("err.timeoutFix"),
    }
  if (lower.includes("max steps") || lower.includes("max_steps"))
    return {
      message: t("err.steps"),
      fix: t("err.stepsFix"),
    }
  // [Live Hardening 0.13.x] Satu-satunya throw kernel ber-kind budget_exceeded
  // tanpa flag operator adalah kehabisan jendela konteks SETELAH kompaksi
  // ("context window exceeded after compaction", vendor loop). Catch-all
  // "budget" di bawah memmask pesan itu menjadi "Session budget exceeded"
  // dan menyarankan --budget — saran yang salah total (uji live tiprouter:
  // riwayat membengkak ~72k token hingga critical). Kenali lebih dulu.
  if (lower.includes("context window"))
    return { message: t("err.context"), fix: t("err.contextFix") }
  if (lower.includes("budget")) return { message: t("err.budget"), fix: t("err.budgetFix") }
  if (lower.includes("busy")) return { message: t("err.busy"), fix: t("err.busyFix") }
  if (lower.includes("aborted")) return { message: t("err.aborted") }
  const { detail } = extractProviderDetail(redactSecrets(raw))
  // detail sudah sanitize via firstSentence; redact tak menambah ANSI, tapi
  // bungkus lagi agar idempoten bila pemanggil mengirim mentah di masa depan.
  if (detail) return { message: sanitizeAnsiLine(redactSecrets(detail)) }
  const safe = sanitizeAnsiLine(redactSecrets(raw))
  return { message: truncateToWidth(safe, 160, "…") }
}

/**
 * v0.42 / v0.43 — Redaksi RINGKAS untuk kegagalan tool di LAPISAN TAMPIL
 * (transkrip TUI & printer linear). Jalur `tool.failed` dulu mem-bypass
 * `formatError()` kanonik sehingga `failed: exit 1`, idempotency key panjang,
 * atau dump internal bocor ke baris ledger satu-baris. Detail LENGKAP tetap
 * ada di jurnal/verbose — yang berubah hanya redaksi di layar.
 *
 * Murni & satu baris ≤120 kolom. Kata kunci deteksi sengaja Inggris (body
 * error tool/proxy berbahasa Inggris apa pun locale UI); terjemahan memakai
 * `tSystem()` (locale OS), bukan `/lang` — ini kwitansi/peringatan sistem,
 * bukan narasi percakapan. Semua cabang (termasuk target tak terpercaya)
 * tetap lewat redaksi → sanitasi → potong per kolom.
 *
 * v0.43: 13 pola dikenali (4 lama + sub-agent + 8 baru). Presedensi
 * `duplicate → subagent → guard → exit → EIO → 8 pola baru → fallback`
 * disengaja: ringkasan child bisa memuat `exit N`, jadi sub-agent harus
 * menang lebih dulu; guard internal mengalahkan `permission denied`.
 */

// Regex modul-scope tanpa flag `g` — aman dipakai berulang (lastIndex tak
// bergeser antar-panggilan, yang bisa membuat deteksi bolak-balik benar/salah).
const TOOL_DUPLICATE_RE = /duplicate idempotency key/i
// Sub-agent dicek sebelum exit: summary child sering menyertakan "exit N".
const TOOL_SUBAGENT_RE = /sub[- ]?agent|turn exceeded|child tools?:/i
// `no provider for sub-agent` (src/tools/task.ts) = dependensi tak terkonfigurasi,
// bukan ringkasan child; dikecualikan agar tak tertelan pola sub-agent.
const TOOL_NO_PROVIDER_SUBAGENT_RE = /^no provider for sub[- ]?agent\b/i
// Guard internal diperiksa sebelum pola permission denied di grup baru.
const TOOL_GUARD_RE = /bash-guard internal error/i
// `.includes("exit code")` lama mentrigger pada teks tanpa angka; sekarang
// harus ada kode numerik nyata (`exit 1`, `exit code -2`, `exit +7`).
const TOOL_EXIT_RE = /\bexit(?:\s+code)?\s+[+-]?\d+\b/i
// exit 0 = sukses. Baris log netral ("exit code 0 recorded in log") tetap
// apa adanya, bukan diubah jadi "Command failed".
const TOOL_ZERO_EXIT_RE = /\bexit(?:\s+code)?\s+[+-]?0+\b/i
const TOOL_EIO_RE = /\beio\b/i

/**
 * Delapan pola baru, diurutkan: yang lebih spesifik didahulukan agar
 * `tool not found` tak jadi `targetNotFound`, dan `turn exceeded` sudah
 * diserap cabang sub-agent di atas. Anchor `^`/`\b` mencegah substring
 * longgar (`grep: permission denied (in fixture)`, `set timeout 30s`).
 */
const TOOL_ERROR_PATTERNS = [
  { re: /^unknown tool:|\btool not found\b/i, key: "msg.toolNotFound" },
  {
    re: /^(?:permission denied|permission error|not authorized|outside workspace|blocked )\b/i,
    key: "msg.permissionDenied",
  },
  { re: /^invalid arguments:/i, key: "msg.invalidArgs" },
  {
    re: /\btimed out\b|\bETIMEDOUT\b|^(?:MCP|LSP)\b.*\btimed out\b|^turn exceeded\b/i,
    key: "msg.toolTimeout",
  },
  {
    re: /^file not found\b|\bENOENT\b|\bnot found in\b|\bsource not found\b|\bcwd not found\b|\bnot found$/i,
    key: "msg.targetNotFound",
  },
  {
    re: /\bno provider for sub[- ]?agent\b|\bnot configured\b|\bunavailable\b|\brefusing direct execution\b/i,
    key: "msg.notConfigured",
  },
  { re: /^HTTP 4\d\d|^HTTP 5\d\d|^fetch 429|\brate limited\b/i, key: "msg.requestFailed" },
  { re: /^aborted\b|\bcancelled \(empty answer\)|^ask_user cancelled\b/i, key: "msg.cancelled" },
] as const

/**
 * SATU-SATUNYA sumber deteksi 13 pola kanonik (presedensi
 * `duplicate → subagent → guard → exit → EIO → 8 pola baru`). Dipakai bersama
 * oleh dua gerbang tampil:
 *  - friendlyToolError()          → fallback ke pesan mentah (perilaku lama).
 *  - friendlyToolErrorCanonical() → fallback ke "" (jangan tampilkan yang tak
 *    dikenali — permintaan owner: error tanpa pola kanonik tak usah muncul).
 *
 * Mengembalikan redaksi kanonik BELUM disanitasi, atau `undefined` bila tak ada
 * pola yang cocok. Regex modul-scope di atas tanpa flag `g` aman dipakai
 * berulang (lastIndex tak bergeser antar-panggilan).
 */
function canonicalToolError(message: string, target?: string): string | undefined {
  const raw = String(message ?? "")
  const safeTarget = target ? sanitizeAnsiLine(redactSecrets(String(target))).trim() : ""
  const targetText = safeTarget || "-"
  if (TOOL_DUPLICATE_RE.test(raw)) return tSystem("msg.duplicateAction")
  if (TOOL_SUBAGENT_RE.test(raw) && !TOOL_NO_PROVIDER_SUBAGENT_RE.test(raw)) {
    // Timeout/gagal sub-agent: jangan tampilkan stack + potongan partial mentah
    // di ledger. Detail penuh tetap di jurnal/--verbose.
    return tSystem("msg.subagentFailed")
  }
  if (TOOL_GUARD_RE.test(raw)) return tSystem("msg.guardError")
  if (TOOL_EXIT_RE.test(raw) && !TOOL_ZERO_EXIT_RE.test(raw))
    return tSystem("msg.cmdFailed", { target: targetText })
  if (TOOL_EIO_RE.test(raw)) return tSystem("msg.toolFailed")
  const matched = TOOL_ERROR_PATTERNS.find(({ re }) => re.test(raw))
  return matched ? tSystem(matched.key) : undefined
}

/**
 * v0.43 — Redaksi kanonik SAJA untuk kegagalan tool di lapisan tampil.
 *
 * Bedanya dengan friendlyToolError(): bila pesan TIDAK cocok dengan salah satu
 * dari 13 pola kanonik, fungsi ini mengembalikan `""` — jangan tampilkan `raw
 * message` yang tidak dikenali sama sekali. Baris ledger/status tool tetap bisa
 * dirender oleh pemanggil; yang hilang hanyalah redaksi errornya.
 *
 * Cabang kanonik identik dengan friendlyToolError() (locale OS via tSystem,
 * lewat redaksi → sanitasi → potong 120 kolom).
 */
export function friendlyToolErrorCanonical(message: string, target?: string): string {
  const canonical = canonicalToolError(message, target)
  if (canonical === undefined) return ""
  return truncateToWidth(sanitizeAnsiLine(redactSecrets(canonical)), 120, "…")
}

export function friendlyToolError(message: string, target?: string): string {
  const canonical = canonicalToolError(message, target)
  // Fallback ke pesan mentah dipertahankan demek kompatibilitas test/API lama.
  const text = canonical ?? friendlyError(String(message ?? "")).message
  return truncateToWidth(sanitizeAnsiLine(redactSecrets(text)), 120, "…")
}

/** Satu baris siap tampil: pesan + saran. Dipakai renderer TUI & one-shot. */
export function formatFriendly(e: FriendlyError): string {
  return e.fix ? `${e.message}\n  → ${e.fix}` : e.message
}

/**
 * Error apa pun → satu pesan siap tampil. KANONIK untuk seluruh UI
 * (TUI fullscreen, wizard, one-shot).
 *
 * Semua permukaan harus lewat sini: pesan error adalah TEKS TAK
 * DIPERCAYA (body provider, proxy, header Authorization) — `e.message` mentah
 * pernah menampilkan bearer token dan dump JSON mentah ke layar.
 *
 * Bentuk yang dikenali:
 * - ProviderError → punya `category` (peta formal → pesan actionable).
 * - AgentError    → punya `kind` (timeout/aborted/budget/dst).
 * - Error biasa   → pesannya (meredaksi + mensanitasi + memotong).
 * - Non-Error     → tetap LEWAT jalur redaksi; `String(e)` mentah bisa
 *   memuat credential. Informasi yang aman tetap dipertahankan — error tak
 *   diganti jadi teks generik.
 */
export function formatError(e: unknown): string {
  const obj = e as { kind?: string; category?: string; message?: string } | undefined
  // ProviderError punya `category`; AgentError punya `kind`.
  if (obj?.category) return formatFriendly(friendlyFromCategory(obj.category, obj.message ?? ""))
  if (obj?.kind) {
    const friendly = friendlyError(`${obj.kind}: ${obj.message ?? ""}`)
    return formatFriendly(friendly)
  }
  if (e instanceof Error) {
    // Error tanpa pesan → pakai nama kelasnya ("Error"/"TypeError") supaya
    // tetap ada jejak di layar, bukan baris kosong tanpa konteks.
    return formatFriendly(friendlyError(e.message.trim() ? e.message : String(e)))
  }
  // Objek non-Error yang tetap punya `message` (bentuk yang dipakai sebagian
  // lib pihak ketiga): pakai pesannya, bukan "[object Object]".
  if (typeof obj?.message === "string" && obj.message.trim()) {
    return formatFriendly(friendlyError(obj.message))
  }
  // Sisanya (string yang dilempar, objek tanpa message): TETAP lewat redaksi.
  return formatFriendly(friendlyError(String(e)))
}
