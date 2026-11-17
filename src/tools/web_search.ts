import type { Tool } from "#minicore"
import { isPrivateHost } from "../lib/net.ts"
import { fenceUntrustedToolOutput, isAlreadyFenced, scrubSecrets } from "../policy/scrub.ts"
import { readBodyCapped } from "./web_fetch.ts"

// Penanda truncation (temuan audit #02): snippet/total yang dipotong
// diam-diam tampak lengkap. Snippet 400 char, total per-provider di-cap.
export function cutSnippet(s: string): string {
  const clean = scrubSecrets(s)
  return clean.length > 400 ? `${clean.slice(0, 400)}…` : clean
}

export function capTotal(out: string, cap: number): string {
  return out.length > cap ? `${out.slice(0, cap)}\n… [truncated: showing first ${cap} chars]` : out
}

export function decodeDdgUrl(raw: string): string {
  const unescaped = raw.replace(/&amp;/g, "&").trim()
  const full = unescaped.startsWith("//") ? `https:${unescaped}` : unescaped
  try {
    const u = new URL(full)
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const uddg = u.searchParams.get("uddg")
      if (uddg) return uddg
    }
  } catch {}
  return full
}

// Keyless fallback: Firecrawl (daily per-IP cap) -> Mwmbl (independent index)
// -> Marginalia (shared public key). Dipakai setelah provider ber-key gagal,
// agar search tetap hidup tanpa pendaftaran. DDG HTML tidak lagi otomatis:
// domain DDG diblokir di Indonesia (lihat MINICODE_ALLOW_DDG).
interface FirecrawlKeylessResponse {
  success?: boolean
  data?: {
    web?: Array<{ title?: string; url?: string; description?: string }>
  }
}

interface MwmblSegment {
  value?: string
}

interface MwmblRow {
  url?: string
  title?: MwmblSegment[]
  extract?: MwmblSegment[]
}

interface MarginaliaResponse {
  results?: Array<{ url?: string; title?: string; description?: string }>
}

async function withKeylessRequest<T>(
  signal: AbortSignal,
  fn: (controller: AbortController) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("timeout")), 8000)
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await fn(controller)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

async function readJsonCapped<T>(
  res: Response,
  controller: AbortController,
  label: string,
): Promise<T> {
  const body = await readBodyCapped(res, controller)
  if (body.truncated) throw new Error(`${label} response exceeds body cap`)
  return JSON.parse(body.text) as T
}

function fenceKeyless(content: string): string {
  return isAlreadyFenced(content) ? content : fenceUntrustedToolOutput("web_search", content)
}

const keylessHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  accept: "application/json",
  "user-agent": "minicode/1.0",
  ...extra,
})

async function firecrawlKeylessSearch(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<string> {
  return withKeylessRequest(signal, async (controller) => {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: keylessHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ query, limit: count }),
      signal: controller.signal,
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    const data = await readJsonCapped<FirecrawlKeylessResponse>(res, controller, "Firecrawl")
    if (data.success === false) throw new Error("request failed")
    const rows = data.data?.web ?? []
    const results = rows.filter((r) => r.url).slice(0, count)
    if (results.length === 0) throw new Error("no results")
    const out = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title ?? r.url}\n   ${r.url}\n   ${cutSnippet(r.description ?? "")}`,
      )
      .join("\n\n")
    return fenceKeyless(
      capTotal(`[firecrawl ${results.length} results for "${query}"]\n${out}`, 16000),
    )
  })
}

async function mwmblSearch(query: string, count: number, signal: AbortSignal): Promise<string> {
  return withKeylessRequest(signal, async (controller) => {
    const url = `https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(query)}`
    const res = await fetch(url, { headers: keylessHeaders(), signal: controller.signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    const data = await readJsonCapped<unknown>(res, controller, "Mwmbl")
    if (!Array.isArray(data)) throw new Error("unexpected response")
    const rows = (data as MwmblRow[]).filter((r) => r?.url).slice(0, count)
    if (rows.length === 0) throw new Error("no results")
    const joinSegments = (parts?: MwmblSegment[]): string =>
      (parts ?? [])
        .map((p) => p.value ?? "")
        .join("")
        .trim()
    const out = rows
      .map(
        (r, i) =>
          `${i + 1}. ${joinSegments(r.title) || r.url}\n   ${r.url}\n   ${cutSnippet(joinSegments(r.extract))}`,
      )
      .join("\n\n")
    return fenceKeyless(capTotal(`[mwmbl ${rows.length} results for "${query}"]\n${out}`, 12000))
  })
}

async function marginaliaSearch(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<string> {
  return withKeylessRequest(signal, async (controller) => {
    const url = `https://api2.marginalia-search.com/search?query=${encodeURIComponent(query)}&count=${count}`
    const res = await fetch(url, {
      headers: keylessHeaders({ "API-Key": "public" }),
      signal: controller.signal,
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    const data = await readJsonCapped<MarginaliaResponse>(res, controller, "Marginalia")
    const rows = (data.results ?? []).filter((r) => r.url).slice(0, count)
    if (rows.length === 0) throw new Error("no results")
    const out = rows
      .map(
        (r, i) =>
          `${i + 1}. ${r.title ?? r.url}\n   ${r.url}\n   ${cutSnippet(r.description ?? "")}`,
      )
      .join("\n\n")
    return fenceKeyless(
      capTotal(`[marginalia ${rows.length} results for "${query}"]\n${out}`, 12000),
    )
  })
}

interface DeveloperResult {
  title: string
  url: string
  snippet: string
  meta?: string
}

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()

async function fetchJsonKeyless<T>(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<T> {
  return withKeylessRequest(signal, async (controller) => {
    const res = await fetch(url, { headers: keylessHeaders(headers), signal: controller.signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    return readJsonCapped<T>(res, controller, new URL(url).hostname)
  })
}

async function fetchTextKeyless(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<string> {
  return withKeylessRequest(signal, async (controller) => {
    const res = await fetch(url, { headers: keylessHeaders(headers), signal: controller.signal })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status}`)
    }
    const body = await readBodyCapped(res, controller)
    if (body.truncated) throw new Error(`${new URL(url).hostname} response exceeds body cap`)
    return body.text
  })
}

function formatDeveloperResults(source: string, query: string, results: DeveloperResult[]): string {
  const out = results
    .map(
      (r, i) =>
        `${i + 1}. ${r.title}${r.meta ? ` (${r.meta})` : ""}\n   ${r.url}\n   ${cutSnippet(r.snippet)}`,
    )
    .join("\n\n")
  return capTotal(`[${source} ${results.length} results for "${query}"]\n${out}`, 12000)
}

interface StackExchangeResponse {
  items?: Array<{
    title?: string
    link?: string
    score?: number
    is_answered?: boolean
    body?: string
  }>
}

async function stackOverflowResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${count}&filter=withbody`
  const data = await fetchJsonKeyless<StackExchangeResponse>(url, signal)
  return (data.items ?? [])
    .filter((item) => item.link)
    .slice(0, count)
    .map((item) => ({
      title: stripHtml(item.title ?? "Stack Overflow"),
      url: item.link ?? "",
      snippet: stripHtml(item.body ?? ""),
      meta: `${item.score ?? 0} score${item.is_answered ? ", answered" : ""}`,
    }))
}

interface HnResponse {
  hits?: Array<{
    title?: string
    url?: string
    objectID?: string
    points?: number
    num_comments?: number
    created_at?: string
  }>
}

async function hnResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count}`
  const data = await fetchJsonKeyless<HnResponse>(url, signal)
  return (data.hits ?? []).slice(0, count).map((hit) => ({
    title: hit.title ?? "Hacker News",
    url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
    snippet: hit.created_at ? `posted ${hit.created_at}` : "",
    meta: `${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments`,
  }))
}

interface GitHubSearchResponse {
  items?: Array<{
    full_name?: string
    html_url?: string
    description?: string
    stargazers_count?: number
    language?: string
  }>
}

async function githubResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${count}&sort=stars&order=desc`
  const data = await fetchJsonKeyless<GitHubSearchResponse>(url, signal, {
    accept: "application/vnd.github+json",
  })
  return (data.items ?? [])
    .filter((item) => item.html_url)
    .slice(0, count)
    .map((item) => ({
      title: item.full_name ?? "GitHub repository",
      url: item.html_url ?? "",
      snippet: item.description ?? "",
      meta: `${item.stargazers_count ?? 0} stars${item.language ? `, ${item.language}` : ""}`,
    }))
}

interface GitHubIssueResponse {
  items?: Array<{
    title?: string
    html_url?: string
    body?: string
    state?: string
    comments?: number
  }>
}

async function githubIssueResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${count}&sort=relevance&order=desc`
  const data = await fetchJsonKeyless<GitHubIssueResponse>(url, signal, {
    accept: "application/vnd.github+json",
  })
  return (data.items ?? [])
    .filter((item) => item.html_url)
    .slice(0, count)
    .map((item) => ({
      title: item.title ?? "GitHub issue",
      url: item.html_url ?? "",
      snippet: stripHtml((item.body ?? "").slice(0, 800)),
      meta: `${item.state ?? "unknown"}, ${item.comments ?? 0} comments`,
    }))
}

interface GrepAppResponse {
  hits?: {
    hits?: Array<{
      repo?: { raw?: string }
      path?: { raw?: string }
      branch?: { raw?: string }
      content?: { snippet?: string }
    }>
  }
}

async function grepAppResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://grep.app/api/search?q=${encodeURIComponent(query)}`
  const data = await fetchJsonKeyless<GrepAppResponse>(url, signal)
  return (data.hits?.hits ?? [])
    .flatMap((hit) => {
      const repo = hit.repo?.raw ?? ""
      const path = (hit.path?.raw ?? "").replace(/^\/+/, "")
      if (!repo || !path) return []
      const branch = hit.branch?.raw ?? "main"
      return [
        {
          title: `${repo}/${path}`,
          url: `https://github.com/${repo}/blob/${branch}/${path}`,
          snippet: stripHtml(hit.content?.snippet ?? ""),
        },
      ]
    })
    .slice(0, count)
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

async function arxivResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}`
  const xml = await fetchTextKeyless(url, signal, { accept: "application/atom+xml" })
  const entries = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/g) ?? []
  return entries
    .flatMap((entry) => {
      const pick = (tag: string): string => {
        const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
        return match ? stripHtml(decodeXmlEntities(match[1] ?? "")) : ""
      }
      const id = pick("id").replace(/^http:/, "https:")
      if (!id) return []
      const published = pick("published")
      return [
        {
          title: pick("title") || "arXiv paper",
          url: id,
          snippet: pick("summary"),
          meta: published ? published.slice(0, 10) : "",
        },
      ]
    })
    .slice(0, count)
}

interface CrossrefResponse {
  message?: {
    items?: Array<{
      DOI?: string
      URL?: string
      title?: string[]
      "container-title"?: string[]
      issued?: { "date-parts"?: number[][] }
      "is-referenced-by-count"?: number
    }>
  }
}

async function crossrefResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${count}`
  const data = await fetchJsonKeyless<CrossrefResponse>(url, signal)
  return (data.message?.items ?? [])
    .flatMap((item) => {
      const title = stripHtml((item.title ?? [])[0] ?? "")
      if (!title) return []
      const year = item.issued?.["date-parts"]?.[0]?.[0]
      const journal = (item["container-title"] ?? [])[0]
      return [
        {
          title,
          url: item.DOI ? `https://doi.org/${item.DOI}` : (item.URL ?? ""),
          snippet: journal ? stripHtml(journal) : "",
          meta: `${year ?? "n/a"}, ${item["is-referenced-by-count"] ?? 0} citations`,
        },
      ]
    })
    .filter((item) => item.url)
    .slice(0, count)
}

interface WikipediaResponse {
  query?: {
    search?: Array<{ title?: string; snippet?: string; pageid?: number }>
  }
}

async function wikipediaResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=${count}`
  const data = await fetchJsonKeyless<WikipediaResponse>(url, signal)
  return (data.query?.search ?? [])
    .filter((item) => item.title)
    .slice(0, count)
    .map((item) => {
      const title = item.title ?? "Wikipedia"
      return {
        title,
        url: item.pageid
          ? `https://en.wikipedia.org/?curid=${item.pageid}`
          : `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: stripHtml(item.snippet ?? ""),
      }
    })
}

interface OpenAlexResponse {
  results?: Array<{
    display_name?: string
    doi?: string | null
    publication_year?: number
    cited_by_count?: number
    primary_location?: { landing_page_url?: string | null }
  }>
}

async function openAlexResults(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<DeveloperResult[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${count}`
  const data = await fetchJsonKeyless<OpenAlexResponse>(url, signal)
  return (data.results ?? [])
    .map((item) => ({
      title: item.display_name ?? "OpenAlex work",
      url: item.doi ?? item.primary_location?.landing_page_url ?? "",
      snippet: "",
      meta: `${item.publication_year ?? "n/a"}, ${item.cited_by_count ?? 0} citations`,
    }))
    .filter((item) => item.url)
    .slice(0, count)
}

async function fanOutSearch(
  label: string,
  query: string,
  providers: Array<{ name: string; run: () => Promise<DeveloperResult[]> }>,
  signal: AbortSignal,
): Promise<string> {
  const settled = await Promise.allSettled(providers.map((provider) => provider.run()))
  signal.throwIfAborted()
  const sections: string[] = []
  const failures: string[] = []
  settled.forEach((result, index) => {
    const name = providers[index]!.name
    if (result.status === "fulfilled") {
      if (result.value.length) {
        sections.push(`## ${name}\n${formatDeveloperResults(name, query, result.value)}`)
      } else {
        failures.push(`${name}: no results`)
      }
    } else {
      failures.push(
        `${name}: ${scrubSecrets((result.reason as Error)?.message ?? String(result.reason)).slice(0, 120)}`,
      )
    }
  })
  if (sections.length === 0) {
    throw new Error(`${label} sources failed${failures.length ? ` (${failures.join("; ")})` : ""}`)
  }
  const note = failures.length ? `\n\n[failed: ${failures.join("; ")}]` : ""
  return fenceKeyless(
    capTotal(
      `[${label} ${sections.length} sources for "${query}"]\n${sections.join("\n\n")}${note}`,
      20000,
    ),
  )
}

async function developerSearchAll(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<string> {
  return fanOutSearch(
    "dev",
    query,
    [
      { name: "stackoverflow", run: () => stackOverflowResults(query, count, signal) },
      { name: "hn", run: () => hnResults(query, count, signal) },
      { name: "github", run: () => githubResults(query, count, signal) },
      { name: "github-issues", run: () => githubIssueResults(query, count, signal) },
      { name: "grep", run: () => grepAppResults(query, count, signal) },
    ],
    signal,
  )
}

async function paperSearchAll(query: string, count: number, signal: AbortSignal): Promise<string> {
  return fanOutSearch(
    "papers",
    query,
    [
      { name: "openalex", run: () => openAlexResults(query, count, signal) },
      { name: "arxiv", run: () => arxivResults(query, count, signal) },
      { name: "crossref", run: () => crossrefResults(query, count, signal) },
    ],
    signal,
  )
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web (Tavily/Brave/Keyless Firecrawl-Mwmbl-Marginalia) or keyless developer sources (Stack Overflow, Hacker News, GitHub, Wikipedia, papers). Use source=dev for coding research. Returns top results with snippets. Uses web_fetch under the hood with SSRF guard.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search query" },
      count: { type: "number", description: "max results (default 5, max 10)" },
      source: {
        type: "string",
        description:
          "web (default), stackoverflow, hn, github, github-issues, grep, wikipedia, arxiv, crossref, openalex, papers (OpenAlex+arXiv+Crossref), or dev (Stack Overflow + HN + GitHub repos/issues + grep.app)",
        enum: [
          "web",
          "stackoverflow",
          "hn",
          "github",
          "github-issues",
          "grep",
          "wikipedia",
          "arxiv",
          "crossref",
          "openalex",
          "papers",
          "dev",
        ],
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute({ query, count, source }, ctx) {
    // Fail-fast saat sesi sudah dibatalkan — sebelum network apa pun.
    ctx.signal.throwIfAborted()
    const q = String(query ?? "").trim()
    if (!q) throw new Error("query required")
    const n = Math.min(Math.max(Number(count) || 5, 1), 10)
    const sourceId = String(source ?? "web")
      .trim()
      .toLowerCase()
    if (sourceId !== "web") {
      const developerSources: Record<string, () => Promise<DeveloperResult[]>> = {
        stackoverflow: () => stackOverflowResults(q, n, ctx.signal),
        so: () => stackOverflowResults(q, n, ctx.signal),
        hn: () => hnResults(q, n, ctx.signal),
        github: () => githubResults(q, n, ctx.signal),
        "github-issues": () => githubIssueResults(q, n, ctx.signal),
        issues: () => githubIssueResults(q, n, ctx.signal),
        grep: () => grepAppResults(q, n, ctx.signal),
        grepapp: () => grepAppResults(q, n, ctx.signal),
        wikipedia: () => wikipediaResults(q, n, ctx.signal),
        arxiv: () => arxivResults(q, n, ctx.signal),
        crossref: () => crossrefResults(q, n, ctx.signal),
        openalex: () => openAlexResults(q, n, ctx.signal),
      }
      if (sourceId === "dev") return developerSearchAll(q, n, ctx.signal)
      if (sourceId === "papers") return paperSearchAll(q, n, ctx.signal)
      const run = developerSources[sourceId]
      if (!run) throw new Error(`unknown source: ${sourceId}`)
      const results = await run()
      if (results.length === 0) throw new Error(`no results for source ${sourceId}`)
      return fenceKeyless(formatDeveloperResults(sourceId, q, results))
    }
    const providerErrors: string[] = []
    // Prefer Tavily if key available (more reliable than scraping)
    const tavilyKey = process.env.TAVILY_API_KEY
    if (tavilyKey) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        const onAbort = () => controller.abort(ctx.signal.reason)
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: q,
              max_results: n,
              search_depth: "basic",
            }),
            signal: controller.signal,
          })
          if (res.ok) {
            const body = await readBodyCapped(res, controller)
            if (body.truncated) throw new Error("Tavily response exceeds body byte cap")
            const data = JSON.parse(body.text) as {
              results?: { title: string; url: string; content: string }[]
            }
            const results = (data.results ?? []).slice(0, n)
            const out = results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${cutSnippet(r.content)}`)
              .join("\n\n")
            const content = capTotal(`[tavily ${results.length} results for "${q}"]\n${out}`, 20000)
            return isAlreadyFenced(content)
              ? content
              : fenceUntrustedToolOutput("web_search", content)
          }
          providerErrors.push(`tavily HTTP ${res.status}`)
          await res.body?.cancel().catch(() => {})
        } finally {
          clearTimeout(t)
          ctx.signal.removeEventListener("abort", onAbort)
        }
      } catch (e) {
        ctx.signal.throwIfAborted()
        providerErrors.push(`tavily: ${scrubSecrets((e as Error).message)}`)
      }
    }
    // Fallback 2: Brave Search API (gratis, JSON bersih) bila BRAVE_API_KEY ada.
    const braveKey = process.env.BRAVE_API_KEY
    if (braveKey) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        // Tautkan pembatalan parent (sebelumnya hanya Tavily yang menautkan).
        const onAbort = () => controller.abort(ctx.signal.reason)
        if (ctx.signal.aborted) controller.abort(ctx.signal.reason)
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const res = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`,
            {
              headers: { "X-Subscription-Token": braveKey, accept: "application/json" },
              signal: controller.signal,
            },
          )
          if (res.ok) {
            const body = await readBodyCapped(res, controller)
            if (body.truncated) throw new Error("Brave response exceeds body byte cap")
            const data = JSON.parse(body.text) as {
              web?: { results?: { title: string; url: string; description: string }[] }
            }
            const results = (data.web?.results ?? []).slice(0, n)
            if (results.length) {
              const out = results
                .map(
                  (r, i) =>
                    `${i + 1}. ${r.title}\n   ${r.url}\n   ${cutSnippet(r.description ?? "")}`,
                )
                .join("\n\n")
              const content = capTotal(
                `[brave ${results.length} results for "${q}"]\n${out}`,
                20000,
              )
              return isAlreadyFenced(content)
                ? content
                : fenceUntrustedToolOutput("web_search", content)
            }
            providerErrors.push("brave: 0 results")
          } else {
            providerErrors.push(`brave HTTP ${res.status}`)
          }
          await res.body?.cancel().catch(() => {})
        } finally {
          clearTimeout(t)
          ctx.signal.removeEventListener("abort", onAbort)
        }
      } catch (e) {
        ctx.signal.throwIfAborted()
        providerErrors.push(`brave: ${scrubSecrets((e as Error).message)}`)
      }
    }
    // Fallback keyless: Firecrawl -> Mwmbl -> Marginalia. Semua tanpa API key;
    // provider ber-key di atas tetap diprioritaskan sehingga perilaku pengguna
    // lama tidak berubah.
    const keylessProviders: Array<{ name: string; run: () => Promise<string> }> = [
      { name: "firecrawl", run: () => firecrawlKeylessSearch(q, n, ctx.signal) },
      { name: "mwmbl", run: () => mwmblSearch(q, n, ctx.signal) },
      { name: "marginalia", run: () => marginaliaSearch(q, n, ctx.signal) },
    ]
    for (const provider of keylessProviders) {
      try {
        return await provider.run()
      } catch (e) {
        ctx.signal.throwIfAborted()
        providerErrors.push(`${provider.name}: ${scrubSecrets((e as Error).message).slice(0, 200)}`)
      }
    }

    // DDG HTML hanya opt-in: domain DDG diblokir di Indonesia. Default mati
    // agar kegagalan TLS tidak lagi menjadi jalur utama web_search.
    if (process.env.MINICODE_ALLOW_DDG === "1") {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
      try {
        const parsed = new URL(ddgUrl)
        if (isPrivateHost(parsed.hostname)) throw new Error("blocked")
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 8000)
        const onAbort = () => controller.abort(ctx.signal.reason)
        if (ctx.signal.aborted) controller.abort(ctx.signal.reason)
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
        try {
          const res = await fetch(ddgUrl, {
            signal: controller.signal,
            headers: {
              "user-agent": "Mozilla/5.0 (compatible; minicode/1.0)",
              "accept-language": "en-US,en;q=0.9",
            },
          })
          if (!res.ok) {
            await res.body?.cancel().catch(() => {})
            throw new Error(`HTTP ${res.status} ${res.statusText || "blocked/rate-limited"}`)
          }
          // Cap streaming seperti web_fetch (bug-hunt 2026-09-19: res.text()
          // tanpa batas = transient ~2x body di heap untuk halaman raksasa).
          const body = await readBodyCapped(res, controller)
          const html = body.text
          const scrubbed = scrubSecrets(html)
          // DDG markup berubah-ubah; coba dua pola kelas umum.
          const resRe = /<a[^>]+class="result__url"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
          const altRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
          const results: { url: string; title: string }[] = []
          for (const m of scrubbed.matchAll(resRe)) {
            if (results.length >= n) break
            results.push({ url: decodeDdgUrl(m[1] ?? ""), title: (m[2] ?? "").trim() })
          }
          if (results.length === 0) {
            for (const m of scrubbed.matchAll(altRe)) {
              if (results.length >= n) break
              results.push({ url: decodeDdgUrl(m[1] ?? ""), title: (m[2] ?? "").trim() })
            }
          }
          if (results.length) {
            const truncation = body.truncated ? " · response truncated at byte cap" : ""
            const content = capTotal(
              `[duckduckgo ${results.length} results for "${q}"${truncation}]\n${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")}`,
              8000,
            )
            return isAlreadyFenced(content)
              ? content
              : fenceUntrustedToolOutput("web_search", content)
          }
          throw new Error(body.truncated ? "response exceeded body cap" : "no structured results")
        } finally {
          clearTimeout(t)
          ctx.signal.removeEventListener("abort", onAbort)
        }
      } catch (e) {
        ctx.signal.throwIfAborted()
        providerErrors.push(`duckduckgo: ${scrubSecrets((e as Error).message).slice(0, 200)}`)
      }
    }

    const detail = providerErrors.length ? ` (${providerErrors.join("; ")})` : ""
    throw new Error(
      `web_search failed: no provider succeeded${detail}. Set TAVILY_API_KEY (1,000 free/month) or BRAVE_API_KEY for reliable results; DuckDuckGo is disabled by default because it is blocked in Indonesia (set MINICODE_ALLOW_DDG=1 to opt in).`,
    )
  },
}
