import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { isPrivateHost } from "../lib/net.ts"
import { publicHttp } from "../lib/public-http.ts"
import { fenceUntrustedToolOutput, isAlreadyFenced, scrubSecrets } from "../policy/scrub.ts"

const MAX_REDIRECTS = LIMITS.WEB_FETCH_MAX_REDIRECTS
// Hard-cap pembacaan body SEBELUM slicing — cegah OOM dari response raksasa.
const BODY_HARD_CAP_BYTES = LIMITS.WEB_RESPONSE_BODY_HARD_CAP_BYTES

/**
 * Ekstrak teks terbaca dari HTML agar halaman web penuh <script>/<style>/<svg>
 * tidak memboroskan budget 8000 karakter sebelum isi artikel sempat terbaca.
 */
export function extractReadableHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "\n")
    .replace(
      /<\/?(?:p|div|section|article|main|aside|header|footer|nav|h[1-6]|li|tr|td|th|blockquote|pre|br|hr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
  const decoded = withoutBlocks
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const cp = Number(n)
      return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const cp = Number.parseInt(hex, 16)
      return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    })
  const cleaned = decoded
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim()
  return cleaned
}

// Diekspor untuk web_search (jalur DDG): satu kebijakan cap untuk semua fetch.
export async function readBodyCapped(
  res: Response,
  controller: AbortController,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ""
  let bytesRead = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        out += decoder.decode()
        break
      }
      const remaining = BODY_HARD_CAP_BYTES - bytesRead
      if (value.byteLength > remaining) {
        if (remaining > 0) out += decoder.decode(value.subarray(0, remaining), { stream: true })
        truncated = true
        controller.abort(new Error("response exceeds body byte cap"))
        await reader.cancel().catch(() => {})
        break
      }
      bytesRead += value.byteLength
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return { text: out, truncated }
}

// Snippet body error dengan cap streaming (F-15): cukup untuk diagnosis,
// tak pernah buffer body utuh. Cancel stream setelah cap agar server
// berhenti mengirim (hemat bandwidth + memori).
async function readErrorSnippet(res: Response, maxChars = 4096): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) out += decoder.decode(value, { stream: true })
      if (done || out.length >= maxChars) break
    }
  } catch {
    return out.slice(0, maxChars)
  } finally {
    try {
      await reader.cancel()
    } catch {}
    try {
      reader.releaseLock()
    } catch {}
  }
  return out.slice(0, maxChars)
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  // v7.33 (wire contract): tag WEB; batas private-host tetap disebut singkat.
  description:
    "WEB: Fetch a public HTTP/HTTPS URL (GET, 10s timeout, 50k char cap) with readable-HTML extraction. Private IPs and private redirect targets are blocked.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "https:// URL to fetch" },
      maxChars: { type: "number", description: "max chars to return (default 8000, max 50000)" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute({ url, maxChars }, ctx) {
    const u = String(url ?? "").trim()
    if (!u) throw new Error("url required")
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      throw new Error(`invalid url: ${u}`)
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`disallowed protocol: ${parsed.protocol}`)
    }

    // Default 8000 (bukan 20000): hasil web rakus konteks — satu fetch `README`
    // /halaman GitHub bisa 17 KB yang menggelembungkan jendela konteks hingga
    // melampaui batas model. 8000 tetap cukup utk membaca section, jauh lebih
    // hemat agar beberapa fetch beruntun tidak menumpuk jadi ~1M token.
    const limit = Math.min(Math.max(Number(maxChars) || 8000, 1000), 50000)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error("fetch timeout 10s")), 10_000)
    // Link parent signal — selalu pasang listener dulu, cek aborted setelahnya
    // (tutup race abort antara check dan addEventListener).
    const onParentAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener("abort", onParentAbort, { once: true })
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason)

    try {
      // Each redirect uses a fresh validated DNS answer pinned to socket lookup.
      // Host/SNI remain bound to the original hostname, not the selected address.
      let current = parsed
      // Every hop resolves independently; validated addresses are never reused across redirects.
      if (isPrivateHost(current.hostname)) {
        throw new Error(`blocked private host: ${current.hostname}`)
      }
      const headers = {
        "user-agent": "Mozilla/5.0 (compatible; minicode/1.0)",
        accept: "text/html,application/json,text/*;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      }
      let res: Response | undefined
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        res = await publicHttp.fetch(current, { signal: controller.signal, headers })
        if (res.status < 300 || res.status >= 400) break
        void res.body?.cancel().catch(() => {})
        const loc = res.headers.get("location")
        if (!loc) break
        let next: URL
        try {
          next = new URL(loc, current)
        } catch {
          throw new Error(`invalid redirect location: ${loc}`)
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`redirect to disallowed protocol: ${next.protocol}`)
        }
        if (isPrivateHost(next.hostname)) {
          throw new Error(`blocked private host (redirect target): ${next.hostname}`)
        }
        current = next
      }
      if (!res) throw new Error("unreachable")
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
      }

      if (!res.ok) {
        // F-15: JANGAN res.text() mentah — error body raksasa (500MB dari
        // server jahat) ter-buffer penuh sebelum slice(0,1000). Baca streaming
        // dengan cap kecil (snippet diagnosis cukup 4k), lalu cancel.
        const body = await readErrorSnippet(res)
        const snippet = scrubSecrets(body).slice(0, 1000)
        throw new Error(`fetch ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}`)
      }

      const contentType = res.headers.get("content-type") ?? ""
      const body = await readBodyCapped(res, controller)
      const isHtml = /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)
      const readable = isHtml ? extractReadableHtml(body.text) || body.text : body.text
      const scrubbed = scrubSecrets(readable)
      const sliced = scrubbed.slice(0, limit)
      const outputTruncation =
        scrubbed.length > limit ? `\n\n… truncated ${scrubbed.length - limit} chars` : ""
      const byteTruncation = body.truncated
        ? `\n\n… response truncated at ${BODY_HARD_CAP_BYTES} bytes`
        : ""
      // Header tak boleh menggema kredensial: userinfo dihapus STRUKTURAL
      // (scrub pola tak kenal `user:pass@`), query disamarkan via scrubSecrets
      // (pola sama seperti body). Divalidasi e2e bug-hunt 2026-09-19 F4:
      // `?api_key=SECRET` + `user:pass@` lolos verbatim ke konteks model
      // (lalu persist ke sessions.db) sebelum fix ini.
      const shown = new URL(current.toString())
      shown.username = ""
      shown.password = ""
      const header = `[${scrubSecrets(shown.toString())} ${res.status} ${contentType}]\n`
      const content = (header + sliced + outputTruncation + byteTruncation).slice(0, limit + 500)
      // [Fase 4 / TOOL-05] Pagar data tak-terpercaya pada output web_fetch
      return isAlreadyFenced(content) ? content : fenceUntrustedToolOutput("web_fetch", content)
    } finally {
      clearTimeout(timeout)
      ctx.signal.removeEventListener("abort", onParentAbort)
    }
  },
}
