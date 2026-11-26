import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createEventBus } from "#minicore/core/events.ts"
import { costFor, createUsageCollector } from "../src/policy/usage.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import {
  extractProviderDetail,
  formatError,
  friendlyError,
  friendlyFromCategory,
  friendlyToolError,
} from "../src/ui/render/errors.ts"
import { __setSystemLocaleForTest, tSystem } from "../src/ui/render/tool-label.ts"
import { displayWidth } from "../src/ui/render/width.ts"

// Pesan error mengikuti locale OS (`tSystem`) — kunci en secara eksplisit
// agar deterministik di mesin OS mana pun.
beforeEach(() => {
  __setSystemLocaleForTest("en")
  setSessionLocale("en")
})
afterEach(() => {
  __setSystemLocaleForTest(null)
  resetLocaleState()
})

test("friendlyFromCategory: auth + balance", () => {
  const f = friendlyFromCategory(
    "auth",
    'credits: {"message":"Insufficient balance. Manage billing here: https://opencode.ai/workspace/wrk_123/billing"}',
  )
  expect(f.message).toContain("balance or quota")
  expect(f.fix).toContain("/model")
})

test("friendlyFromCategory: auth tanpa saldo → pesan auth generik", () => {
  const f = friendlyFromCategory("auth", "auth failed (401): invalid api key")
  expect(f.message).toContain("rejected authentication")
})

test("friendlyFromCategory: rate_limit / server / network", () => {
  expect(friendlyFromCategory("rate_limit", "429").message).toContain("rate-limiting")
  expect(friendlyFromCategory("server", "500").message).toContain("temporarily unavailable")
  expect(friendlyFromCategory("network", "socket hang up").message).toContain(
    "Failed to reach provider",
  )
})

test("friendlyFromCategory: invalid_request & context_length", () => {
  expect(friendlyFromCategory("invalid_request", "400 model not found").message).toContain(
    "rejected by provider",
  )
  expect(friendlyFromCategory("context_length_exceeded", "").message).toContain("Context window")
})

test("friendlyFromCategory: unknown mengambil field message dari JSON", () => {
  const f = friendlyFromCategory("unknown", '{"error":{"message":"Some technical detail"}}')
  expect(f.message).toBe("Some technical detail")
  const cut = friendlyFromCategory("unknown", "x".repeat(200))
  expect(cut.message.length).toBeLessThanOrEqual(161)
})

test("friendlyFromCategory: unknown 402 dikenali sebagai saldo habis", () => {
  const f = friendlyFromCategory(
    "unknown",
    '402: {"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
  )
  expect(f.message).toContain("balance or quota")
  expect(f.fix ?? "").toContain("/model")
})

test("friendlyFromCategory: unknown FreeUsageLimit dikenali sebagai limit", () => {
  const f = friendlyFromCategory(
    "unknown",
    '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
  )
  expect(f.message).toContain("rate-limiting")
})

test("friendlyError: string bergaya AgentError", () => {
  expect(friendlyError("timeout: run exceeded 600000ms").message).toContain("timeout")
  expect(friendlyError("max_steps_exceeded: 50 steps").message).toContain("Tool step limit")
  expect(friendlyError("budget exceeded").message.toLowerCase()).toContain("budget")
  // [Live Hardening 0.13.x] kind budget_exceeded dengan pesan jendela konteks
  // HARUS jatuh ke branch context, bukan catch-all "budget" (saran --budget
  // menyesatkan untuk masalah jendela konteks; uji live tiprouter).
  expect(
    friendlyError("budget_exceeded: context window exceeded after compaction").message,
  ).toContain("Context window exceeded")
})

// ── Regresi dari uji live OpenRouter ────────────────────────────────────────
// Satu error 429 mencetak 400+ karakter berisi metadata, provider_error_code,
// limit_source, dan URL dokumentasi — di dalam frame TUI selebar 100 kolom.
// Body OpenRouter juga menyembunyikan alasan sebenarnya di metadata.raw,
// sementara field `message` hanya berbunyi "Provider returned error".

const OR_429 =
  'rate limited (429): {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"z-ai/glm-5.2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Decart","is_byok":false,"provider_error_code":"upstream_429","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key, or route to another provider."}}}'

const OR_403 =
  'auth failed (403): {"error":{"message":"thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps","code":403}}'

const OR_404_NO_TOOLS =
  '404: {"error":{"message":"No endpoints found that support tool use. Try disabling \\"read_file\\". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection","code":404}}'

const CF_502 =
  "<!DOCTYPE html><html><head><title>gorouter.app | 502: Bad gateway</title></head><body>Cloudflare</body></html>"

test("extractProviderDetail: metadata.raw dipilih di atas message generik", () => {
  const { detail, hint } = extractProviderDetail(OR_429)
  expect(detail).toContain("rate-limited upstream")
  expect(detail).not.toContain("Provider returned error")
  expect(hint).toContain("Retry shortly")
})

test("extractProviderDetail: ambil message biasa bila tidak ada metadata", () => {
  const { detail } = extractProviderDetail(OR_403)
  expect(detail).toContain("only available on agentic harnesses")
})

test("extractProviderDetail: judul HTML untuk error Cloudflare", () => {
  const { detail } = extractProviderDetail(CF_502)
  expect(detail).toBe("gorouter.app | 502: Bad gateway")
})

test("extractProviderDetail: body JSON terpotong tetap menghasilkan detail", () => {
  const truncated =
    'rate limited (429): {"error":{"message":"Provider returned error","metadata":{"raw":"model X limit tercapai'
  const { detail } = extractProviderDetail(truncated)
  expect(detail).toContain("limit tercapai")
})

test("extractProviderDetail: teks tanpa JSON/HTML tidak melempar", () => {
  expect(extractProviderDetail("socket hang up")).toEqual({})
  expect(extractProviderDetail("")).toEqual({})
})

test("429 OpenRouter: pesan ringkas, tidak menumpahkan metadata", () => {
  const f = friendlyFromCategory("rate_limit", OR_429)
  expect(f.message).toContain("rate-limited upstream")
  expect(f.message).not.toContain("metadata")
  expect(f.message).not.toContain("provider_error_code")
  expect(f.message).not.toContain("limit_source")
  // Cukup pendek untuk satu baris terminal, bukan 400 karakter.
  expect(f.message.length).toBeLessThanOrEqual(200)
  expect(f.fix).toContain("Retry shortly") // remedy_hint provider dipakai
})

test("403 OpenRouter: alasan sebenarnya tampil, bukan 'auth ditolak' saja", () => {
  const f = friendlyFromCategory("auth", OR_403)
  expect(f.message).toContain("agentic harnesses")
  expect(f.message.length).toBeLessThanOrEqual(220)
})

test("404 no-tool-support: menyebut tool, bukan JSON mentah", () => {
  const f = friendlyFromCategory("invalid_request", OR_404_NO_TOOLS)
  expect(f.message.toLowerCase()).toContain("tool")
  expect(f.message).not.toContain('\\"')
  expect(f.message).not.toContain("openrouter.ai/docs")
})

test("502 HTML Cloudflare: tidak ada tag HTML yang lolos ke pesan", () => {
  const f = friendlyFromCategory("server", CF_502)
  expect(f.message).not.toContain("<")
  expect(f.message).toContain("502")
})

test("semua kategori selalu memberi saran tindakan", () => {
  for (const cat of [
    "rate_limit",
    "auth",
    "server",
    "network",
    "invalid_request",
    "context_length_exceeded",
    "content_filter",
  ]) {
    const f = friendlyFromCategory(cat, "{}")
    expect(f.fix, cat).toBeTruthy()
  }
})

test("detail yang sama dengan pesan dasar tidak diulang dua kali", () => {
  const f = friendlyFromCategory(
    "rate_limit",
    '{"error":{"message":"Provider is rate-limiting requests"}}',
  )
  const occurrences = f.message.split("rate-limiting").length - 1
  expect(occurrences).toBe(1)
})

test("redactSecrets menutup format kunci provider + JWT + query (bug-hunt)", () => {
  // Kode lama: hanya Bearer/kv — echo proxy key konkret lolos mentah ke layar.
  const f = friendlyFromCategory(
    "unknown",
    "proxy says sk-ant-probe-1234567890abcdef and thk_live_probe12345678901234 and TOKEN",
  )
  expect(f.message).not.toContain("sk-ant-probe")
  expect(f.message).not.toContain("thk_live_probe")
  const j = friendlyError(
    "oops eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c boom",
  )
  expect(j.message).not.toContain("eyJhbGciOi")
  expect(j.message).toBe(tSystem("err.unknown"))
  // Query secret di body JSON provider terstruktur tetap teredaksi sebelum ditampilkan.
  const q = friendlyFromCategory(
    "unknown",
    '{"error":{"message":"denied https://h.test/?api_key=SECRET42 rec"}}',
  )
  expect(q.message).not.toContain("SECRET42")
  expect(q.message).toContain("api_key=[redacted]")
  // String non-terstruktur tidak lagi bocor ke layar sama sekali.
  const qRaw = friendlyFromCategory("unknown", "denied https://h.test/?api_key=SECRET42 rec")
  expect(qRaw.message).not.toContain("SECRET42")
  expect(qRaw.message).toBe(tSystem("err.unknown"))
})

// ── Audit TUI P1-1: pesan error provider = teks tak terpercaya ───────────────
// Proxy jahat bisa menggemakan escape (bersihkan layar, alternate screen) di
// body error yang lalu dirender writer mentah cli/. Kode lama meloloskan
// utuh; kode baru sanitize satu-baris di errors.ts.
test("friendlyFromCategory: escape di detail provider dibuang, teks kept", () => {
  const evil = '{"error":{"message":"boom\x1b[2J\x1b[H\x1b[?1049h ha"}}'
  const f = friendlyFromCategory("unknown", evil)
  expect(f.message).toContain("boom")
  expect(f.message).not.toContain("\x1b[2J")
  expect(f.message).not.toContain("1049")
  expect(f.message).not.toContain("\x1b[H")
})

test("friendlyFromCategory: judul HTML ber-ANSI tetap satu baris bersih", () => {
  const f = friendlyFromCategory(
    "server",
    "<html><head><title>down\x1b]0;pwned\x07 | 502</title></head></html>",
  )
  expect(f.message).not.toContain("\x1b]")
  expect(f.message).toContain("502")
})

test("friendlyError: potong CJK per kolom pada detail provider JSON (bukan karakter)", () => {
  // 100 emoji = 200 kolom + prefix; kode lama slice 157 char (=321 kolom).
  const m = friendlyError(`{"error":{"message":"gagal: ${"🔥".repeat(100)}"}}`).message
  expect(displayWidth(m)).toBeLessThanOrEqual(160)
  expect(m.endsWith("…")).toBe(true)
})

// ── usage collector: effective model dari fallback ──
test("usage: effective-model event changes cost basis", () => {
  const bus = createEventBus()
  const collector = createUsageCollector(bus, "gpt-4o")

  // simulate substitution (router fallback): gpt-4o dipakai, tapi provider
  // hanya punya deepseek-chat → router memilih effective deepseek-chat
  bus.emit({
    type: "provider:extension",
    kind: "effective-model",
    data: { requested: "gpt-4o", effective: "deepseek-chat", provider: "fallback-x" },
  })
  bus.emit({
    type: "provider:extension",
    kind: "usage",
    data: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
  })

  const used = collector.modelUsed()
  expect(used.effective).toBe("deepseek-chat")
  expect(used.provider).toBe("fallback-x")

  const u = collector.get("gpt-4o")
  // deepseek-chat: input 0.14/m, output 0.28/m → 0.14 + 0.28 = 0.42
  expect(u.cost).toBeCloseTo(0.42, 3)
})

test("usage: reset clears effective model", () => {
  const bus = createEventBus()
  const collector = createUsageCollector(bus, "gpt-4o")
  bus.emit({
    type: "provider:extension",
    kind: "effective-model",
    data: { requested: "x", effective: "y", provider: "z" },
  })
  collector.reset()
  expect(collector.modelUsed().effective).toBeUndefined()
})

// ── C18: pricing boundary matching ──────────────────────────────────────────

test("pricing: exact and versioned model names match", () => {
  // exact — gpt-4o $2,50/M input. Tabel lama menulis $5,00 (harga peluncuran
  // Mei 2024, sudah dipotong separuh Agustus 2024), jadi estimasi biaya
  // selama ini 2× terlalu tinggi untuk model ini. Dikoreksi di Fase 4.3.
  expect(costFor("gpt-4o", 1_000_000, 0, 0, 0, false)).toBeCloseTo(2.5, 6)
  // sufiks versi (pemisah -)
  expect(costFor("gpt-4o-2024-11-20", 1_000_000, 0, 0, 0, false)).toBeCloseTo(2.5, 6)
  // prefix provider openrouter
  expect(costFor("deepseek/deepseek-chat", 1_000_000, 0, 0, 0, false)).toBeCloseTo(0.14, 6)
  // varian :free benar-benar gratis, bukan mewarisi harga varian berbayar
  expect(costFor("deepseek/deepseek-chat:free", 1_000_000, 0, 0, 0, false)).toBe(0)
  // longest-key menang: claude-sonnet-4-5, bukan claude-sonnet-4
  expect(costFor("claude-sonnet-4-5", 1_000_000, 0, 0, 0, false)).toBeCloseTo(3, 6)
})

// ── P0 UI Security: formatError = satu-satunya gerbang pesan error UI ───────
//
// Jalur TUI fullscreen (src/ui/tui/app.ts) DULU memakai `e.message` mentah:
// bearer token, body JSON provider, dan credential Echo bisa tampil utuh di
// layar. Sekarang semua permukaan lewat formatError → redaksi + sanitasi.
//
// Sentinel di bawah adalah nilai PALSU (bukan credential nyata) — hanya
// membuktikan polanya tertangkap redaksi.
const SENTINEL_BEARER = "SENTINEL-BEARER-abcdef123456"
const SENTINEL_PROVIDER_KEY = "sk-testsentinel0123456789abcdef"
const SENTINEL_QUERY = "SENTINELQUERY987654321"

test("formatError: error jaringan tetap dikenali dan dinarasikan tanpa bocor detail mentah", () => {
  const msg = formatError(new Error("koneksi refused di 127.0.0.1:8080"))
  expect(msg).toContain(tSystem("err.network"))
  expect(msg).toContain(tSystem("err.networkFix"))
  expect(msg).not.toContain("127.0.0.1")
})

test("formatError: bearer token tak pernah tampil (Authorization header)", () => {
  const msg = formatError(new Error(`proxy menolak: Authorization: Bearer ${SENTINEL_BEARER}`))
  expect(msg).not.toContain(SENTINEL_BEARER)
  expect(msg).not.toContain("Authorization")
  expect(msg).toContain(tSystem("err.unknown"))
})

test("formatError: kunci provider + query string tak bocor dan dipetakan ke narasi auth", () => {
  const msg = formatError(
    new Error(`gagal auth: ${SENTINEL_PROVIDER_KEY} / https://h.test/?api_key=${SENTINEL_QUERY}`),
  )
  expect(msg).not.toContain(SENTINEL_PROVIDER_KEY)
  expect(msg).not.toContain(SENTINEL_QUERY)
  expect(msg).toContain(tSystem("err.auth"))
})

test("formatError: body JSON provider mentah tak membocorkan credential", () => {
  const raw =
    'rate limited (429): {"error":{"message":"Provider returned error","metadata":{"raw":' +
    `"${SENTINEL_PROVIDER_KEY} dipakai untuk model X"}},"code":429}}`
  const msg = formatError(new Error(raw))
  expect(msg).not.toContain(SENTINEL_PROVIDER_KEY)
  expect(msg).toContain("[redacted]")
  expect(msg).toContain(tSystem("err.rateLimit"))
})

test("formatError: credential yang dipotong batas 150 kolom tetap teredaksi", () => {
  // Token tepat di batas potong `firstSentence` → urutan redact→extract
  // (bukan extract→redact) yang membuatnya tak bocor.
  const filler = "x".repeat(140)
  const msg = formatError(new Error(`${filler} ${SENTINEL_PROVIDER_KEY}`))
  expect(msg).not.toContain(SENTINEL_PROVIDER_KEY)
  expect(msg).toContain(tSystem("err.unknown"))
})

test("formatError: objek non-Error (string dilempar) juga aman dan tak bocor credential", () => {
  const msg = formatError(`boom Authorization: Bearer ${SENTINEL_BEARER}`)
  expect(msg).not.toContain(SENTINEL_BEARER)
  expect(msg).not.toContain("boom")
  expect(msg).toContain(tSystem("err.unknown"))
})

test("formatError: objek non-Error dengan `message` rate limited dinarasikan", () => {
  const msg = formatError({ message: "rate limited, coba lagi" } as unknown)
  expect(msg).toContain(tSystem("err.rateLimit"))
})

test("formatError: error tanpa pesan jatuh ke narasi fallback aman", () => {
  const msg = formatError(new Error(""))
  expect(msg.trim().length).toBeGreaterThan(0)
  expect(msg).toContain(tSystem("err.unknown"))
})

test("formatError: escape ANSI di pesan error dibuang dan jatuh ke narasi aman", () => {
  const msg = formatError(new Error("boom\x1b[2J\x1b[?1049h"))
  expect(msg).not.toContain("\x1b[2J")
  expect(msg).not.toContain("1049")
  expect(msg).not.toContain("boom")
  expect(msg).toContain(tSystem("err.unknown"))
})

test("formatError: kategori tambahan & bilingual OS-locale (id/en)", () => {
  __setSystemLocaleForTest("id")
  setSessionLocale("en") // /lang sesi tidak menggeser narasi error OS-locale
  expect(formatError(new Error("EACCES: permission denied"))).toContain(tSystem("err.permission"))
  expect(formatError(new Error("ENOSPC: no space left on device"))).toContain(
    tSystem("err.fsError"),
  )
  expect(formatError(new SyntaxError("Unexpected token } in JSON"))).toContain(tSystem("err.parse"))
  expect(formatError(new Error("fatal: not a git repository"))).toContain(tSystem("err.git"))
  expect(formatError(new Error("ERR_TLS_CERT_ALTNAME_INVALID"))).toContain(tSystem("err.tls"))
  expect(formatError(new Error("unhandled mystery failure xyz"))).toContain(tSystem("err.unknown"))
  __setSystemLocaleForTest("en")
  expect(formatError(new Error("ENOSPC: no space left on device"))).toContain("File system error")
})

test("formatError: ProviderError (category) & AgentError (kind) tetap dipetakan", () => {
  const provider = formatError({ category: "rate_limit", message: "429 exploded" } as unknown)
  expect(provider.toLowerCase()).toContain("rate")
  const agent = formatError({ kind: "timeout", message: "run exceeded" } as unknown)
  expect(agent.toLowerCase()).toContain("timeout")
})

// ── v0.42/v0.43: redaksi ringkas kegagalan tool (tSystem / locale OS) ────────
describe("friendlyToolError", () => {
  afterEach(() => __setSystemLocaleForTest(null))

  test("prioritas: duplicate > subagent > guard > exit > EIO > 8 pola > fallback", () => {
    __setSystemLocaleForTest("en")
    expect(friendlyToolError("duplicate idempotency key abc-123")).toBe(
      "Already run · verify state before retrying",
    )
    // Sub-agent MENANG atas `exit N`: ringkasan child sering memuat kode keluar.
    expect(
      friendlyToolError(
        "1 child tools: [sub-agent explore error] exit 2 | partial: I'll start by mapping the security-rel…",
      ),
    ).toBe("Sub-agent failed · details in --verbose")
    expect(friendlyToolError("sub-agent failed: exit 7")).toBe(
      "Sub-agent failed · details in --verbose",
    )
    // "turn exceeded" juga pola toolTimeout, tapi sub-agent dicek lebih dulu.
    expect(friendlyToolError("turn exceeded 180000ms")).toBe(
      "Sub-agent failed · details in --verbose",
    )
    // Guard mengalahkan `permission denied`.
    expect(friendlyToolError("bash-guard internal error: permission denied: blocked rm")).toBe(
      "Command blocked · retry",
    )
    expect(friendlyToolError("failed: exit 1\nerror: boom", "bash")).toBe(
      "Command failed · bash · details in --verbose",
    )
    expect(friendlyToolError("read failed: EIO: something")).toBe("Terminal read failed · retry")
    // Unknown/unmatched errors must not leak raw message; return safe narrative.
    const unknown = friendlyToolError("boom")
    expect(unknown).toBe(tSystem("msg.unknownToolError"))
    expect(unknown).not.toContain("boom")
    // Pola tool tambahan (plan sync, shell quoting, edit mismatch, fs, network, parse, git, MCP/LSP)
    expect(friendlyToolError("cmd.exe quoting hazard: single quotes")).toBe(
      tSystem("msg.shellQuoting"),
    )
    expect(friendlyToolError("canonical task sync failed (illegal task transition)")).toBe(
      tSystem("msg.planSyncFailed"),
    )
    expect(friendlyToolError("oldString == newString (no change)")).toBe(
      tSystem("msg.editMismatch"),
    )
    expect(friendlyToolError("ENOSPC: no space left on device")).toBe(tSystem("msg.fsAccess"))
    expect(friendlyToolError("ECONNREFUSED 127.0.0.1:443")).toBe(tSystem("msg.networkTool"))
    expect(friendlyToolError("SyntaxError: Unexpected token")).toBe(tSystem("msg.parseError"))
    expect(friendlyToolError("fatal: not a git repository")).toBe(tSystem("msg.gitError"))
    expect(friendlyToolError("MCP server not connected")).toBe(tSystem("msg.integrationError"))
  })

  test("redaksi id memakai locale OS, bukan /lang", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("en") // sesi beda — tak boleh mengubah hasil tSystem
    expect(friendlyToolError("duplicate idempotency key")).toBe(
      "Sudah dijalankan · verifikasi state dulu",
    )
    expect(friendlyToolError("exit 7", "git_push")).toBe(
      "Perintah gagal · git_push · detail di --verbose",
    )
  })

  const TOOL_ERROR_CASES: ReadonlyArray<{ raw: string; en: string; id: string }> = [
    {
      raw: "unknown tool: do_thing",
      en: "Unknown tool · check the name",
      id: "Tool tidak dikenal · periksa nama",
    },
    {
      raw: "tool not found: read_file",
      en: "Unknown tool · check the name",
      id: "Tool tidak dikenal · periksa nama",
    },
    {
      raw: "permission denied: outside workspace",
      en: "Blocked by permission policy · check access",
      id: "Ditolak kebijakan izin · periksa akses",
    },
    {
      raw: "invalid arguments: path must be a string",
      en: "Invalid tool arguments · check the call",
      id: "Argumen tool tidak valid · periksa panggilan",
    },
    {
      raw: "read_file timed out after 5000ms",
      en: "Tool timed out · retry or raise the limit",
      id: "Tool melewati batas waktu · ulangi atau naikkan batas",
    },
    {
      raw: "ETIMEDOUT while fetching schema",
      en: "Tool timed out · retry or raise the limit",
      id: "Tool melewati batas waktu · ulangi atau naikkan batas",
    },
    {
      raw: "MCP server timed out",
      en: "Tool timed out · retry or raise the limit",
      id: "Tool melewati batas waktu · ulangi atau naikkan batas",
    },
    {
      raw: "file not found: /tmp/missing",
      en: "Target not found · check the path/id",
      id: "Target tidak ditemukan · periksa path/id",
    },
    {
      raw: "ENOENT: no such file or directory",
      en: "Target not found · check the path/id",
      id: "Target tidak ditemukan · periksa path/id",
    },
    {
      raw: "oldString not found in src/ui/a.ts",
      en: "Target not found · check the path/id",
      id: "Target tidak ditemukan · periksa path/id",
    },
    {
      raw: "source not found: old.ts",
      en: "Target not found · check the path/id",
      id: "Target tidak ditemukan · periksa path/id",
    },
    {
      raw: "no provider for sub-agent",
      en: "Dependency not configured · check setup",
      id: "Dependensi belum dikonfigurasi · periksa penyiapan",
    },
    {
      raw: "docker unavailable — refusing direct execution",
      en: "Dependency not configured · check setup",
      id: "Dependensi belum dikonfigurasi · periksa penyiapan",
    },
    {
      raw: "HTTP 429 too many requests",
      en: "Request failed · retry or check the endpoint",
      id: "Permintaan gagal · ulangi atau periksa endpoint",
    },
    {
      raw: "fetch 429 from gateway",
      en: "Request failed · retry or check the endpoint",
      id: "Permintaan gagal · ulangi atau periksa endpoint",
    },
    {
      raw: "upstream rate limited, retry later",
      en: "Request failed · retry or check the endpoint",
      id: "Permintaan gagal · ulangi atau periksa endpoint",
    },
    {
      raw: "aborted by user",
      en: "Cancelled",
      id: "Dibatalkan",
    },
    {
      raw: "ask_user cancelled by user",
      en: "Cancelled",
      id: "Dibatalkan",
    },
    {
      raw: "answer cancelled (empty answer)",
      en: "Cancelled",
      id: "Dibatalkan",
    },
  ]

  test("8 pola baru: tabel redaksi en/id via locale OS (tSystem)", () => {
    for (const c of TOOL_ERROR_CASES) {
      __setSystemLocaleForTest("en")
      setSessionLocale("id") // /lang sesi tak boleh mengubah kwitansi sistem
      expect(friendlyToolError(c.raw), `en: ${c.raw}`).toBe(c.en)
      __setSystemLocaleForTest("id")
      setSessionLocale("en")
      expect(friendlyToolError(c.raw), `id: ${c.raw}`).toBe(c.id)
    }
  })

  test("negatif: anchor/batas kata mencegah over-match & fallback tak bocor", () => {
    __setSystemLocaleForTest("en")
    // exit 0 = sukses: baris log netral tak salah masuk cmdFailed → jatuh ke narasi aman.
    expect(friendlyToolError("exit code 0 recorded in log")).toBe(tSystem("msg.unknownToolError"))
    // Tanpa angka, penyebutan "exit code" tak lagi memicu cmdFailed.
    expect(friendlyToolError("see exit code in log")).toBe(tSystem("msg.unknownToolError"))
    expect(friendlyToolError("grep: permission denied (in fixture)")).not.toBe(
      "Blocked by permission policy · check access",
    )
    expect(friendlyToolError("set timeout 30s")).not.toBe(
      "Tool timed out · retry or raise the limit",
    )
  })

  test("murni, satu baris ≤120 kolom, tanpa SGR, rahasia di pesan DAN target teredaksi", () => {
    __setSystemLocaleForTest("en")
    const long = friendlyToolError(
      `exit 2 ${"x".repeat(200)} Authorization: Bearer ${SENTINEL_BEARER}`,
      `bash Authorization: Bearer ${SENTINEL_BEARER}`,
    )
    expect(displayWidth(long)).toBeLessThanOrEqual(120)
    expect(long).not.toContain("\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: regex SGR memang memakai ESC
    expect(long).not.toMatch(/\x1b\[[0-9;?]*[A-Za-z]/)
    expect(long).not.toContain(SENTINEL_BEARER)
    expect(long).toContain("[redacted]")
    expect(long).toContain("Command failed")
    const secret = friendlyToolError(`boom Authorization: Bearer ${SENTINEL_BEARER}`)
    expect(secret).not.toContain(SENTINEL_BEARER)
    expect(secret).not.toContain("boom")
    expect(secret).toBe(tSystem("msg.unknownToolError"))
    // Cabang pola baru juga lewat gerbang redaksi yang sama.
    const matched = friendlyToolError(
      `unknown tool: Authorization: Bearer ${SENTINEL_BEARER}`,
      `target Bearer ${SENTINEL_BEARER}`,
    )
    expect(matched).toBe("Unknown tool · check the name")
    expect(matched).not.toContain(SENTINEL_BEARER)
  })

  test("refused non-jaringan tak salah masuk network; service unavailable masuk requestFailed", () => {
    __setSystemLocaleForTest("en")
    expect(friendlyError("policy refused this operation").message).toBe(tSystem("err.unknown"))
    expect(friendlyError("connection refused to 127.0.0.1").message).toBe(tSystem("err.network"))
    expect(friendlyToolError("service unavailable")).toBe(tSystem("msg.requestFailed"))
    expect(friendlyToolError("docker unavailable — refusing direct execution")).toBe(
      tSystem("msg.notConfigured"),
    )
  })
})
