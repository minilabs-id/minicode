import { afterEach, expect, spyOn, test } from "bun:test"
import * as dns from "node:dns/promises"
import { fetchPublicUrl, publicHttp } from "../src/lib/public-http.ts"
import { webFetchTool } from "../src/tools/web_fetch.ts"

const ctx = {
  signal: new AbortController().signal,
  state: { history: [], turnCount: 0, stepCount: 0 },
  emit: () => {},
}
const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

for (const redirect of [false, true]) {
  test(`DNS failure blocks ${redirect ? "redirect" : "initial"} connection`, async () => {
    const lookup = spyOn(dns, "lookup").mockRejectedValue(new Error("DNS unavailable"))
    const fetch = spyOn(publicHttp, "fetch").mockImplementation(async (url, init) => {
      if (url.hostname === "8.8.8.8")
        return new Response(null, {
          status: 302,
          headers: { location: "https://unresolved-audit.invalid/" },
        })
      return fetchPublicUrl(url, init)
    })
    restores.push(
      () => lookup.mockRestore(),
      () => fetch.mockRestore(),
    )
    await expect(
      webFetchTool.execute(
        { url: redirect ? "https://8.8.8.8/" : "https://unresolved-audit.invalid/" },
        ctx,
      ),
    ).rejects.toThrow(/blocked private host/)
    expect(fetch).toHaveBeenCalledTimes(redirect ? 2 : 1)
  })
}

test("non-HTTP initial URL is rejected before DNS or fetch", async () => {
  const fetch = spyOn(globalThis, "fetch")
  restores.push(() => fetch.mockRestore())
  await expect(webFetchTool.execute({ url: "file:///audit" }, ctx)).rejects.toThrow(
    /disallowed protocol/,
  )
  expect(fetch).not.toHaveBeenCalled()
})
