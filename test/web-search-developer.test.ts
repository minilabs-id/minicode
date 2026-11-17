import { afterEach, expect, test } from "bun:test"
import { webSearchTool } from "../src/tools/web_search.ts"

const originalFetch = globalThis.fetch
const savedEnv = {
  tavily: process.env.TAVILY_API_KEY,
  brave: process.env.BRAVE_API_KEY,
  ddg: process.env.MINICODE_ALLOW_DDG,
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreEnv("TAVILY_API_KEY", savedEnv.tavily)
  restoreEnv("BRAVE_API_KEY", savedEnv.brave)
  restoreEnv("MINICODE_ALLOW_DDG", savedEnv.ddg)
})

const ctx = { signal: new AbortController().signal } as never

function urlOf(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return String((input as Request).url)
}

function jsonResponse(value: unknown): Response {
  const response = Response.json(value)
  response.json = async () => {
    throw new Error("unbounded Response.json must not be used")
  }
  return response
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  delete process.env.TAVILY_API_KEY
  delete process.env.BRAVE_API_KEY
  delete process.env.MINICODE_ALLOW_DDG
  const calls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = urlOf(input)
    calls.push(url)
    return handler(url)
  }) as unknown as typeof fetch
  return calls
}

test("source=stackoverflow memakai API keyless dan mem-fence hasil", async () => {
  const calls = mockFetch((url) => {
    if (url.includes("api.stackexchange.com")) {
      return jsonResponse({
        items: [
          {
            title: "How to Q &amp; A",
            link: "https://stackoverflow.com/q/1",
            score: 5,
            is_answered: true,
            body: "<p>Answer body</p>",
          },
        ],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "q", count: 1, source: "stackoverflow" }, ctx),
  )
  expect(result).toContain('[UNTRUSTED_TOOL_OUTPUT tool="web_search"')
  expect(result).toContain("stackoverflow 1 results")
  expect(result).toContain("How to Q & A")
  expect(result).toContain("5 score, answered")
  expect(result).toContain("Answer body")
  expect(calls[0]).toContain("api.stackexchange.com")
})

test("source=hn memakai Algolia keyless", async () => {
  mockFetch((url) => {
    if (url.includes("hn.algolia.com")) {
      return jsonResponse({
        hits: [
          {
            title: "HN story",
            url: "https://example.invalid/story",
            objectID: "1",
            points: 10,
            num_comments: 2,
            created_at: "2026-01-01",
          },
        ],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(await webSearchTool.execute({ query: "q", count: 1, source: "hn" }, ctx))
  expect(result).toContain("hn 1 results")
  expect(result).toContain("HN story")
  expect(result).toContain("10 points, 2 comments")
})

test("source=github memakai Search API keyless", async () => {
  mockFetch((url) => {
    if (url.includes("api.github.com/search/repositories")) {
      return jsonResponse({
        items: [
          {
            full_name: "owner/repo",
            html_url: "https://github.com/owner/repo",
            description: "repo description",
            stargazers_count: 42,
            language: "TypeScript",
          },
        ],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "repo", count: 1, source: "github" }, ctx),
  )
  expect(result).toContain("github 1 results")
  expect(result).toContain("owner/repo")
  expect(result).toContain("42 stars, TypeScript")
})

test("source=wikipedia memakai MediaWiki API keyless", async () => {
  mockFetch((url) => {
    if (url.includes("en.wikipedia.org/w/api.php")) {
      return jsonResponse({
        query: { search: [{ title: "Test", snippet: "<span>snippet</span>", pageid: 123 }] },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "test", count: 1, source: "wikipedia" }, ctx),
  )
  expect(result).toContain("wikipedia 1 results")
  expect(result).toContain("https://en.wikipedia.org/?curid=123")
  expect(result).toContain("snippet")
})

test("source=openalex memakai OpenAlex keyless", async () => {
  mockFetch((url) => {
    if (url.includes("api.openalex.org/works")) {
      return jsonResponse({
        results: [
          {
            display_name: "A paper",
            doi: "https://doi.org/10.1/x",
            publication_year: 2026,
            cited_by_count: 7,
            primary_location: { landing_page_url: "https://example.invalid/paper" },
          },
        ],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "paper", count: 1, source: "openalex" }, ctx),
  )
  expect(result).toContain("openalex 1 results")
  expect(result).toContain("A paper")
  expect(result).toContain("2026, 7 citations")
})

test("source=arxiv memakai Atom XML keyless", async () => {
  mockFetch((url) => {
    if (url.includes("export.arxiv.org/api/query")) {
      return new Response(
        "<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Paper &amp; Title</title><summary>Paper summary</summary><published>2026-01-02T00:00:00Z</published></entry></feed>",
        { status: 200, headers: { "content-type": "application/atom+xml" } },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "paper", count: 1, source: "arxiv" }, ctx),
  )
  expect(result).toContain("arxiv 1 results")
  expect(result).toContain("Paper & Title")
  expect(result).toContain("https://arxiv.org/abs/2401.00001v1")
  expect(result).toContain("2026-01-02")
})

test("source=crossref memakai Crossref JSON keyless", async () => {
  mockFetch((url) => {
    if (url.includes("api.crossref.org/works")) {
      return jsonResponse({
        message: {
          items: [
            {
              DOI: "10.1/x",
              title: ["Crossref paper"],
              "container-title": ["Journal"],
              issued: { "date-parts": [[2025]] },
              "is-referenced-by-count": 3,
              URL: "https://example.invalid",
            },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "paper", count: 1, source: "crossref" }, ctx),
  )
  expect(result).toContain("crossref 1 results")
  expect(result).toContain("Crossref paper")
  expect(result).toContain("https://doi.org/10.1/x")
  expect(result).toContain("2025, 3 citations")
})

test("source=grep memakai grep.app keyless", async () => {
  mockFetch((url) => {
    if (url.includes("grep.app/api/search")) {
      return jsonResponse({
        hits: {
          hits: [
            {
              repo: { raw: "owner/repo" },
              path: { raw: "src/a.ts" },
              branch: { raw: "main" },
              content: { snippet: "<mark>useEffect</mark>" },
            },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "useEffect", count: 1, source: "grep" }, ctx),
  )
  expect(result).toContain("grep 1 results")
  expect(result).toContain("owner/repo/src/a.ts")
  expect(result).toContain("https://github.com/owner/repo/blob/main/src/a.ts")
  expect(result).toContain("useEffect")
})

test("source=github-issues memakai Search API keyless", async () => {
  mockFetch((url) => {
    if (url.includes("api.github.com/search/issues")) {
      return jsonResponse({
        items: [
          {
            title: "Issue",
            html_url: "https://github.com/o/r/issues/1",
            body: "<p>issue body</p>",
            state: "open",
            comments: 2,
          },
        ],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "issue", count: 1, source: "github-issues" }, ctx),
  )
  expect(result).toContain("github-issues 1 results")
  expect(result).toContain("open, 2 comments")
})

test("source=papers fan-out: OpenAlex + arXiv + Crossref, partial failure", async () => {
  const calls = mockFetch((url) => {
    if (url.includes("api.openalex.org")) {
      return jsonResponse({
        results: [{ display_name: "OpenAlex paper", doi: "https://doi.org/10.1/a" }],
      })
    }
    if (url.includes("export.arxiv.org")) return new Response("down", { status: 500 })
    if (url.includes("api.crossref.org")) {
      return jsonResponse({
        message: { items: [{ DOI: "10.1/b", title: ["Crossref paper"] }] },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "paper", count: 1, source: "papers" }, ctx),
  )
  expect(result).toContain("[papers 2 sources")
  expect(result).toContain("## openalex")
  expect(result).toContain("## crossref")
  expect(result).toContain("[failed: arxiv: HTTP 500]")
  expect(calls).toHaveLength(3)
})

test("source=dev fan-out: sebagian gagal tetap mengembalikan hasil", async () => {
  const calls = mockFetch((url) => {
    if (url.includes("api.stackexchange.com")) {
      return jsonResponse({
        items: [{ title: "SO", link: "https://stackoverflow.com/q/1", body: "so body" }],
      })
    }
    if (url.includes("hn.algolia.com")) return new Response("down", { status: 500 })
    if (url.includes("api.github.com/search/issues")) return new Response("down", { status: 500 })
    if (url.includes("api.github.com")) {
      return jsonResponse({
        items: [{ full_name: "owner/repo", html_url: "https://github.com/owner/repo" }],
      })
    }
    if (url.includes("grep.app")) {
      return jsonResponse({
        hits: {
          hits: [
            {
              repo: { raw: "owner/repo" },
              path: { raw: "src/a.ts" },
              content: { snippet: "snippet" },
            },
          ],
        },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = String(
    await webSearchTool.execute({ query: "dev query", count: 1, source: "dev" }, ctx),
  )
  expect(result).toContain("dev 3 sources")
  expect(result).toContain("## stackoverflow")
  expect(result).toContain("## github")
  expect(result).toContain("## grep")
  expect(result).toContain("hn: HTTP 500")
  expect(result).toContain("github-issues: HTTP 500")
  expect(calls).toHaveLength(5)
})

test("source=dev semua gagal → error", async () => {
  mockFetch(() => new Response("down", { status: 500 }))
  await expect(
    webSearchTool.execute({ query: "dev fail", count: 1, source: "dev" }, ctx),
  ).rejects.toThrow(
    /dev sources failed.*stackoverflow: HTTP 500.*hn: HTTP 500.*github: HTTP 500.*github-issues: HTTP 500.*grep: HTTP 500/,
  )
})

test("source tidak dikenal ditolak tanpa jaringan", async () => {
  const calls = mockFetch(() => new Response("unexpected", { status: 200 }))
  await expect(
    webSearchTool.execute({ query: "x", count: 1, source: "unknown" }, ctx),
  ).rejects.toThrow("unknown source")
  expect(calls).toHaveLength(0)
})
