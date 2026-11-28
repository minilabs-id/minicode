// Pemetaan error provider/agent → pesan yang bisa ditindaklanjuti.
//
// PENTING: modul ini punya 10 test tapi dulu TIDAK dipanggil dari mana pun di
// kode produksi. Renderer memakai formatProviderError() yang mencetak
// `[kategori] <pesan mentah>`, sehingga body JSON provider tumpah utuh ke layar.
// Terlihat pada uji live OpenRouter: satu error 429 mencetak 400+ karakter
// berisi `metadata`, `provider_error_code`, `limit_source`, dan URL dokumentasi
// — di dalam frame TUI selebar 100 kolom.

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

// Mapping kategori formal -> pesan user-friendly (mengikuti bahasa OS via tSystem).
// Detail provider disertakan sebagai satu kalimat bila ada (itu yang memberi tahu
// model mana yang limit, atau tool mana yang tidak didukung) — bukan seluruh body.
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
    // apa pun locale UI. Yang diterjemahkan hanya pesan/fix tampil (via tSystem).
    case "rate_limit":
      return {
        message: withDetail(tSystem("err.rateLimit")),
        fix: hint ?? tSystem("err.rateLimitFix"),
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
          message: withDetail(tSystem("err.balance")),
          fix: hint ?? tSystem("err.balanceFix"),
        }
      }
      return {
        message: withDetail(tSystem("err.auth")),
        fix: hint ?? tSystem("err.authFix"),
      }
    }
    case "server":
      return {
        message: withDetail(tSystem("err.server")),
        fix: hint ?? tSystem("err.serverFix"),
      }
    case "network":
      return {
        message: withDetail(tSystem("err.network")),
        fix: hint ?? tSystem("err.networkFix"),
      }
    case "invalid_request":
      return {
        message: withDetail(tSystem("err.invalid")),
        fix: hint ?? tSystem("err.invalidFix"),
      }
    case "context_length_exceeded":
      return {
        message: withDetail(tSystem("err.context")),
        fix: hint ?? tSystem("err.contextFix"),
      }
    case "content_filter":
      return {
        message: withDetail(tSystem("err.filter")),
        fix: hint ?? tSystem("err.filterFix"),
      }
    default: {
      // Kategori "unknown" menampung status HTTP lain (mis. 402 dari vendor
      // yang frozen) atau error lain — klasifikasikan agar pesannya tetap
      // actionable, dan jangan pernah membocorkan body mentah ke UI.
      const classified = classifyGenericError(truth)
      if (classified) {
        return {
          message: withDetail(classified.message),
          ...((hint ?? classified.fix) ? { fix: hint ?? classified.fix } : {}),
        }
      }
      if (providerDetail) return { message: providerDetail, ...(hint ? { fix: hint } : {}) }
      return { message: tSystem("err.unknown"), fix: tSystem("err.unknownFix") }
    }
  }
}

/**
 * Klasifikasikan pesan error generik menjadi narasi singkat + saran (locale OS).
 * Dipakai bersama oleh `friendlyError()` dan cabang `unknown` pada
 * `friendlyFromCategory()` agar cakupan kategori konsisten di seluruh UI.
 */
function classifyGenericError(safeText: string): FriendlyError | null {
  const lower = safeText.toLowerCase()
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("etimedout")) {
    return { message: tSystem("err.timeout"), fix: tSystem("err.timeoutFix") }
  }
  if (lower.includes("max steps") || lower.includes("max_steps")) {
    return { message: tSystem("err.steps"), fix: tSystem("err.stepsFix") }
  }
  // [Live Hardening 0.13.x] Satu-satunya throw kernel ber-kind budget_exceeded
  // tanpa flag operator adalah kehabisan jendela konteks SETELAH kompaksi
  // ("context window exceeded after compaction", vendor loop). Kenali sebelum "budget".
  if (
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens")
  ) {
    return { message: tSystem("err.context"), fix: tSystem("err.contextFix") }
  }
  if (lower.includes("budget")) {
    return { message: tSystem("err.budget"), fix: tSystem("err.budgetFix") }
  }
  if (lower.includes("busy") || lower.includes("already running")) {
    return { message: tSystem("err.busy"), fix: tSystem("err.busyFix") }
  }
  if (lower.includes("aborted") || lower.includes("cancelled")) {
    return { message: tSystem("err.aborted") }
  }
  if (
    lower.includes("insufficient balance") ||
    lower.includes("credits") ||
    lower.includes("billing") ||
    lower.includes("quota") ||
    lower.includes("credit limit") ||
    lower.includes("requires more credits") ||
    lower.includes("fewer max_tokens") ||
    /\b402\b/.test(lower)
  ) {
    return { message: tSystem("err.balance"), fix: tSystem("err.balanceFix") }
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("ratelimit") ||
    lower.includes("rate limited") ||
    lower.includes("too many requests") ||
    lower.includes("freeusagelimit") ||
    lower.includes("try again later") ||
    /\b429\b/.test(lower)
  ) {
    return { message: tSystem("err.rateLimit"), fix: tSystem("err.rateLimitFix") }
  }
  if (
    lower.includes("content filter") ||
    lower.includes("content_filter") ||
    lower.includes("safety filter") ||
    lower.includes("moderation")
  ) {
    return { message: tSystem("err.filter"), fix: tSystem("err.filterFix") }
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key") ||
    lower.includes("authentication") ||
    /\bauth\b/.test(lower) ||
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower)
  ) {
    return { message: tSystem("err.auth"), fix: tSystem("err.authFix") }
  }
  if (
    lower.includes("err_tls") ||
    lower.includes("certificate") ||
    lower.includes("self signed") ||
    /\b(?:ssl|tls)\b/.test(lower)
  ) {
    return { message: tSystem("err.tls"), fix: tSystem("err.tlsFix") }
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach") ||
    lower.includes("connection refused") ||
    /\b(?:connection|koneksi|socket|tcp|tls|connect)\s+refused\b|\brefused\s+(?:to\s+connect|connection)\b/.test(
      lower,
    ) ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up")
  ) {
    return { message: tSystem("err.network"), fix: tSystem("err.networkFix") }
  }
  if (
    /\b5\d\d\b/.test(lower) ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("overloaded")
  ) {
    return { message: tSystem("err.server"), fix: tSystem("err.serverFix") }
  }
  if (
    lower.includes("permission denied") ||
    lower.includes("outside workspace") ||
    lower.includes("eacces") ||
    lower.includes("eperm") ||
    lower.includes("authorization changed")
  ) {
    return { message: tSystem("err.permission"), fix: tSystem("err.permissionFix") }
  }
  if (lower.includes("enoent") || lower.includes("file not found") || /\bnot found\b/.test(lower)) {
    return { message: tSystem("err.notFound"), fix: tSystem("err.notFoundFix") }
  }
  if (
    /\b(?:enospc|ebusy|erofs|eisdir|enotdir|emfile)\b/.test(lower) ||
    lower.includes("binary file")
  ) {
    return { message: tSystem("err.fsError"), fix: tSystem("err.fsErrorFix") }
  }
  if (
    lower.includes("syntaxerror") ||
    lower.includes("json.parse") ||
    lower.includes("unexpected token") ||
    lower.includes("invalid json") ||
    lower.includes("malformed json")
  ) {
    return { message: tSystem("err.parse"), fix: tSystem("err.parseFix") }
  }
  if (
    lower.includes("not a git repository") ||
    lower.includes("merge conflict") ||
    lower.includes("non-fast-forward") ||
    lower.includes("index.lock")
  ) {
    return { message: tSystem("err.git"), fix: tSystem("err.gitFix") }
  }
  if (
    lower.includes("not configured") ||
    lower.includes("no provider") ||
    lower.includes("api key missing") ||
    lower.includes("requires minicode_sandbox")
  ) {
    return { message: tSystem("err.config"), fix: tSystem("err.configFix") }
  }
  if (
    lower.includes("too many background jobs") ||
    lower.includes("too many active background jobs") ||
    lower.includes("batch limit reached")
  ) {
    return { message: tSystem("err.toolLimit"), fix: tSystem("err.toolLimitFix") }
  }
  return null
}

// Fallback string-only (AgentError: timeout/aborted/max_steps, dst.) — selalu
// lewat redaksi + sanitasi + klasifikasi narasi (bahasa OS), tak bocor mentah.
export function friendlyError(raw: string): FriendlyError {
  const safe = sanitizeAnsiLine(redactSecrets(String(raw ?? "")))
  const { detail, hint } = extractProviderDetail(safe)
  const classified = classifyGenericError(safe)
  if (classified) {
    const message =
      detail && detail.toLowerCase() !== classified.message.toLowerCase()
        ? `${classified.message}: ${detail}`
        : classified.message
    const fix = hint ?? classified.fix
    return fix ? { message, fix } : { message }
  }
  if (detail) {
    return { message: sanitizeAnsiLine(redactSecrets(detail)), ...(hint ? { fix: hint } : {}) }
  }
  return { message: tSystem("err.unknown"), fix: tSystem("err.unknownFix") }
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
 * v0.43+: 21 pola dikenali (6 jalur presedensi + 15 pola kanonik). Presedensi
 * `duplicate → subagent → guard → shellQuoting → exit → EIO → 15 pola → fallback`
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
const TOOL_SHELL_QUOTING_RE = /^cmd\.exe quoting hazard:/i
// `.includes("exit code")` lama mentrigger pada teks tanpa angka; sekarang
// harus ada kode numerik nyata (`exit 1`, `exit code -2`, `exit +7`).
const TOOL_EXIT_RE = /\bexit(?:\s+code)?\s+[+-]?\d+\b/i
// exit 0 = sukses. Baris log netral ("exit code 0 recorded in log") tetap
// apa adanya, bukan diubah jadi "Command failed".
const TOOL_ZERO_EXIT_RE = /\bexit(?:\s+code)?\s+[+-]?0+\b/i
const TOOL_EIO_RE = /\beio\b/i

/**
 * 15 pola tool kanonik (total 21 bersama 6 jalur presedensi di atas),
 * diurutkan: yang lebih spesifik didahulukan agar `tool not found` tak jadi
 * `targetNotFound`, dan `turn exceeded` sudah diserap cabang sub-agent di
 * atas. Anchor `^`/`\b` mencegah substring longgar (`grep: permission denied
 * (in fixture)`, `set timeout 30s`).
 */
const TOOL_ERROR_PATTERNS = [
  { re: /^unknown tool:|\btool not found\b/i, key: "msg.toolNotFound" },
  {
    re: /^(?:permission denied|permission error|not authorized|outside workspace|blocked |cwd outside workspace|path outside workspace|cannot search sensitive|authorization changed)\b/i,
    key: "msg.permissionDenied",
  },
  { re: /^invalid arguments:|^invalid regex:|ReDoS-prone/i, key: "msg.invalidArgs" },
  {
    re: /\btimed out\b|\bETIMEDOUT\b|^(?:MCP|LSP)\b.*\btimed out\b|^turn exceeded\b|\[TOOL_OUTCOME[^\]]*reason=TIMEOUT/i,
    key: "msg.toolTimeout",
  },
  {
    re: /canonical task sync failed|\bTASK_IDENTITY_REQUIRED\b|\bTASK_AUTHORITY_VIOLATION\b|illegal task transition|non-canonical taskId|already has \d+ canonical task/i,
    key: "msg.planSyncFailed",
  },
  {
    re: /^oldString == newString\b|^oldString found multiple times\b|\bpatch failed\b|\bhunk failed\b|\bcannot apply patch\b/i,
    key: "msg.editMismatch",
  },
  {
    re: /^file not found\b|\bENOENT\b|\bnot found in\b|\bsource not found\b|\bcwd not found\b|\bjob "[^"]*" not found\b|\bnot found$/i,
    key: "msg.targetNotFound",
  },
  {
    re: /\b(?:service|server|api|endpoint|upstream)\s+(?:is\s+)?unavailable\b|\btemporarily unavailable\b/i,
    key: "msg.requestFailed",
  },
  {
    re: /\bno provider for sub[- ]?agent\b|\bnot configured\b|\bunavailable\b|\brefusing direct execution\b|\brequires MINICODE_SANDBOX\b/i,
    key: "msg.notConfigured",
  },
  { re: /^HTTP 4\d\d|^HTTP 5\d\d|^fetch 429|\brate limited\b/i, key: "msg.requestFailed" },
  { re: /^aborted\b|\bcancelled \(empty answer\)|^ask_user cancelled\b/i, key: "msg.cancelled" },
  {
    re: /\b(?:EACCES|EPERM|EROFS|EBUSY|EISDIR|ENOTDIR|EEXIST|ENOSPC|EMFILE)\b|^cannot read binary file\b|\bfile too large\b/i,
    key: "msg.fsAccess",
  },
  {
    re: /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_TLS_[A-Z0-9_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)\b|\bsocket hang up\b|\bfetch failed\b/i,
    key: "msg.networkTool",
  },
  {
    re: /^(?:SyntaxError|JSON\.parse)\b|\binvalid JSON\b|\bmalformed JSON\b|\bUnexpected token\b|\binvalid URL\b/i,
    key: "msg.parseError",
  },
  {
    re: /\bnot a git repository\b|\bmerge conflict\b|^CONFLICT \(|\bnon-fast-forward\b|\bindex\.lock\b|\bdetached HEAD\b/i,
    key: "msg.gitError",
  },
  {
    re: /^(?:MCP|LSP)\b|\bserver not connected\b|\btoo many (?:active )?background jobs\b|\bbatch limit reached\b/i,
    key: "msg.integrationError",
  },
] as const

/**
 * SATU-SATUNYA sumber deteksi 21 pola kanonik (presedensi
 * `duplicate → subagent → guard → shellQuoting → exit → EIO → 15 pola`).
 * Dipakai bersama oleh dua gerbang tampil:
 *  - friendlyToolError()          → fallback ke narasi aman `msg.unknownToolError`.
 *  - friendlyToolErrorCanonical() → fallback ke "" agar pemanggil (app.ts,
 *    simple.ts, recovery-warning.ts) tetap bisa memisahkan fallthrough vs ledger.
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
  if (TOOL_SHELL_QUOTING_RE.test(raw)) return tSystem("msg.shellQuoting")
  if (TOOL_EXIT_RE.test(raw) && !TOOL_ZERO_EXIT_RE.test(raw))
    return tSystem("msg.cmdFailed", { target: targetText })
  if (TOOL_EIO_RE.test(raw)) return tSystem("msg.toolFailed")
  const matched = TOOL_ERROR_PATTERNS.find(({ re }) => re.test(raw))
  return matched ? tSystem(matched.key) : undefined
}

/**
 * Redaksi kanonik SAJA untuk kegagalan tool.
 *
 * Mengembalikan "" bila pesan tidak cocok satu pun dari 21 pola kanonik, agar
 * pemanggil yang punya fallback lebih kaya (`app.ts → formatError`,
 * `simple.ts → formatProviderError`, `recovery-warning.ts → withheld`) tetap
 * dapat berjalan, sementara renderer baris tool memakai `msg.unknownToolError`.
 */
export function friendlyToolErrorCanonical(message: string, target?: string): string {
  const canonical = canonicalToolError(message, target)
  if (canonical === undefined) return ""
  return truncateToWidth(sanitizeAnsiLine(redactSecrets(canonical)), 120, "…")
}

const CANONICAL_TAG_BY_KEY: Readonly<
  Record<
    string,
    | "tag.toolNotFound"
    | "tag.permission"
    | "tag.invalidArgs"
    | "tag.timeout"
    | "tag.planSync"
    | "tag.editMismatch"
    | "tag.targetNotFound"
    | "tag.notConfigured"
    | "tag.requestFailed"
    | "tag.cancelled"
    | "tag.fsAccess"
    | "tag.network"
    | "tag.parse"
    | "tag.git"
    | "tag.integration"
  >
> = {
  "msg.toolNotFound": "tag.toolNotFound",
  "msg.permissionDenied": "tag.permission",
  "msg.invalidArgs": "tag.invalidArgs",
  "msg.toolTimeout": "tag.timeout",
  "msg.planSyncFailed": "tag.planSync",
  "msg.editMismatch": "tag.editMismatch",
  "msg.targetNotFound": "tag.targetNotFound",
  "msg.notConfigured": "tag.notConfigured",
  "msg.requestFailed": "tag.requestFailed",
  "msg.cancelled": "tag.cancelled",
  "msg.fsAccess": "tag.fsAccess",
  "msg.networkTool": "tag.network",
  "msg.parseError": "tag.parse",
  "msg.gitError": "tag.git",
  "msg.integrationError": "tag.integration",
}

/**
 * Tag penyebab super-ringkas (1–3 kata) untuk disandingkan dengan label
 * manusiawi saat tool gagal — tanpa membocorkan raw JSON/credential.
 */
export function friendlyToolFailureTag(message: string): string {
  const raw = String(message ?? "")
  if (!raw.trim()) return ""
  if (TOOL_DUPLICATE_RE.test(raw)) return tSystem("tag.duplicate")
  if (TOOL_SUBAGENT_RE.test(raw) && !TOOL_NO_PROVIDER_SUBAGENT_RE.test(raw)) {
    const lower = raw.toLowerCase()
    if (/step limit reached|\bmax[_ ]?steps(?:_exceeded)?\b|\bexceeded \d+ steps\b/.test(lower)) {
      return tSystem("tag.stepLimit")
    }
    if (
      lower.includes("loop_guard") ||
      lower.includes("read_only_thrashing") ||
      lower.includes("repeated_action_error")
    ) {
      return tSystem("tag.loopGuard")
    }
    if (lower.includes("context window") || lower.includes("context length")) {
      return tSystem("tag.contextFull")
    }
    if (lower.includes("aborted") || lower.includes("cancelled")) return tSystem("tag.aborted")
    if (lower.includes("timed out") || lower.includes("timeout")) return tSystem("tag.timeout")
    return tSystem("tag.subagent")
  }
  if (/LOOP_GUARD/i.test(raw)) return tSystem("tag.loopGuard")
  if (TOOL_GUARD_RE.test(raw)) return tSystem("tag.guard")
  if (TOOL_SHELL_QUOTING_RE.test(raw)) return tSystem("tag.shellQuoting")
  if (TOOL_EXIT_RE.test(raw) && !TOOL_ZERO_EXIT_RE.test(raw)) {
    const m = /\bexit(?:\s+code)?\s+([+-]?\d+)\b/i.exec(raw)
    return m?.[1] ? tSystem("tag.exit", { code: m[1] }) : ""
  }
  if (TOOL_EIO_RE.test(raw)) return tSystem("tag.readError")
  if (/\brate limited\b|\b429\b/i.test(raw)) return tSystem("tag.rateLimit")
  const matched = TOOL_ERROR_PATTERNS.find(({ re }) => re.test(raw))
  if (!matched) return ""
  const tagKey = CANONICAL_TAG_BY_KEY[matched.key]
  return tagKey ? tSystem(tagKey) : ""
}

/**
 * Format kegagalan berbasis label manusiawi: `"<label> mengalami kegagalan"`
 * plus tag penyebab singkat bila dikenali (tetap lewat redaksi & sanitasi).
 */
export function formatLabeledToolFailure(
  intent: string,
  rawMessage?: string,
  denyReason?: string,
): string {
  const cleanLabel = truncateToWidth(sanitizeAnsiLine(redactSecrets(intent)).trim(), 72, "…")
  const base = tSystem("msg.intentFailed", { label: cleanLabel })
  const firstLine = String(rawMessage ?? "").split(/[\r\n]/)[0] ?? ""
  const tag =
    friendlyToolFailureTag(firstLine) ||
    (denyReason ? truncateToWidth(sanitizeAnsiLine(redactSecrets(denyReason)).trim(), 32, "…") : "")
  const line = tag ? `${base} (${tag})` : base
  return truncateToWidth(sanitizeAnsiLine(redactSecrets(line)), 120, "…")
}

export function friendlyToolError(message: string, target?: string): string {
  const canonical = canonicalToolError(message, target)
  // Fallback ke narasi aman OS-locale; tidak pernah membocorkan pesan mentah.
  const text = canonical ?? tSystem("msg.unknownToolError")
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

/**
 * Error untuk permukaan protokol mesin (ACP JSON-RPC, dsb.): tetap meredaksi
 * secret dan mensanitasi ANSI/satu-baris, serta tetap memetakan kategori yang
 * dikenali, tetapi TIDAK mengganti pesan error konkret tak-terklasifikasi
 * dengan narasi generik manusia (`--verbose`).
 */
export function formatMachineError(e: unknown): string {
  const obj = e as { kind?: string; category?: string; message?: string } | undefined
  if (obj?.category) {
    const truth = sanitizeAnsiLine(redactSecrets(String(obj.message ?? "").trim()))
    if (obj.category === "unknown") {
      const { detail, hint } = extractProviderDetail(truth)
      const classified = classifyGenericError(truth)
      if (classified) {
        const message =
          detail && detail.toLowerCase() !== classified.message.toLowerCase()
            ? `${classified.message}: ${detail}`
            : classified.message
        const fix = hint ?? classified.fix
        return formatFriendly(fix ? { message, fix } : { message })
      }
      if (detail) return formatFriendly({ message: detail, ...(hint ? { fix: hint } : {}) })
      return truncateToWidth(truth, 160, "…") || tSystem("err.unknown")
    }
    return formatFriendly(friendlyFromCategory(obj.category, obj.message ?? ""))
  }
  const raw = obj?.kind
    ? `${obj.kind}: ${obj.message ?? ""}`
    : e instanceof Error
      ? e.message.trim()
        ? e.message
        : String(e)
      : typeof obj?.message === "string" && obj.message.trim()
        ? obj.message
        : String(e)
  const safe = sanitizeAnsiLine(redactSecrets(raw))
  const { detail, hint } = extractProviderDetail(safe)
  const classified = classifyGenericError(safe)
  if (classified) {
    const message =
      detail && detail.toLowerCase() !== classified.message.toLowerCase()
        ? `${classified.message}: ${detail}`
        : classified.message
    const fix = hint ?? classified.fix
    return formatFriendly(fix ? { message, fix } : { message })
  }
  if (detail) return sanitizeAnsiLine(redactSecrets(detail))
  return truncateToWidth(safe, 160, "…") || tSystem("err.unknown")
}
