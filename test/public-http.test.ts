import { afterEach, expect, spyOn, test } from "bun:test"
import * as dns from "node:dns/promises"
import { EventEmitter } from "node:events"
import * as http from "node:http"
import * as https from "node:https"
import { Readable } from "node:stream"
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib"
import { LIMITS } from "../src/constants.ts"
import { fetchPublicUrl } from "../src/lib/public-http.ts"
import { readBodyCapped } from "../src/tools/web_fetch.ts"

const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

test("socket lookup uses validated address without resolving again; hostname and TLS remain intact", async () => {
  const lookup = spyOn(dns, "lookup")
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never)
    .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never)
  const request = spyOn(https, "request").mockImplementation(((
    url: URL,
    options: any,
    respond: any,
  ) => {
    expect(url.hostname).toBe("public.example")
    expect(url.username).toBe("")
    expect(options.agent).toBe(false)
    expect(options.rejectUnauthorized).not.toBe(false)
    options.lookup(url.hostname, {}, (err: unknown, address: string, family: number) => {
      expect(err).toBeNull()
      expect(address).toBe("8.8.8.8")
      expect(family).toBe(4)
    })
    options.lookup(url.hostname, { all: true }, (_: unknown, addresses: unknown) =>
      expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]),
    )
    const req = new EventEmitter() as EventEmitter & { end(): void }
    req.end = () => {
      const res = Object.assign(Readable.from([Buffer.from("safe")]), {
        statusCode: 200,
        statusMessage: "OK",
        rawHeaders: ["content-type", "text/plain"],
      })
      respond(res)
    }
    return req
  }) as never)
  restores.push(
    () => lookup.mockRestore(),
    () => request.mockRestore(),
  )
  const res = await fetchPublicUrl(new URL("https://user:pass@public.example/"), {
    signal: new AbortController().signal,
    headers: {},
  })
  expect(await res.text()).toBe("safe")
  expect(lookup).toHaveBeenCalledTimes(1)
})

test("runtime HTTP client honors custom socket lookup", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("lookup-ok"),
  })
  let calls = 0
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://must-not-resolve.invalid:${server.port}/`,
        {
          agent: false,
          signal: AbortSignal.timeout(2000),
          lookup: (_host, options, callback) => {
            calls++
            if ((options as { all?: boolean }).all)
              callback(null, [{ address: "127.0.0.1", family: 4 }] as never)
            else callback(null, "127.0.0.1", 4)
          },
        },
        (res) => {
          let text = ""
          res.on("data", (chunk) => {
            text += chunk
          })
          res.on("end", () => resolve(text))
          res.on("error", reject)
        },
      )
      req.on("error", reject)
    })
    expect(body).toBe("lookup-ok")
    expect(calls).toBeGreaterThan(0)
  } finally {
    server.stop(true)
  }
})

function mockResponse(status: number, data: Buffer, encoding = "") {
  const source = Object.assign(Readable.from([data]), {
    statusCode: status,
    statusMessage: "Test",
    rawHeaders: encoding ? ["content-encoding", encoding] : [],
  })
  const request = spyOn(https, "request").mockImplementation(((
    _url: URL,
    _options: unknown,
    respond: (res: unknown) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end(): void }
    req.end = () => {
      queueMicrotask(() => respond(source))
    }
    return req
  }) as never)
  restores.push(() => request.mockRestore())
  return source
}

const publicLiteral = new URL("https://8.8.8.8/")
test("invalid asynchronous response status rejects without escaping callback", async () => {
  const source = mockResponse(600, Buffer.from("invalid"))
  await expect(
    fetchPublicUrl(publicLiteral, { signal: new AbortController().signal, headers: {} }),
  ).rejects.toThrow("invalid HTTP status")
  expect(source.destroyed).toBe(true)
})

for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
] as const) {
  test(`decodes ${encoding} before exposing response body`, async () => {
    mockResponse(200, compress(Buffer.from("decoded content")), encoding)
    const response = await fetchPublicUrl(publicLiteral, {
      signal: new AbortController().signal,
      headers: {},
    })
    expect(await response.text()).toBe("decoded content")
    expect(response.headers.has("content-encoding")).toBe(false)
  })
}

test("body cap applies to decompressed bytes", async () => {
  mockResponse(
    200,
    gzipSync(Buffer.alloc(LIMITS.WEB_RESPONSE_BODY_HARD_CAP_BYTES + 1000, 97)),
    "gzip",
  )
  const controller = new AbortController()
  const response = await fetchPublicUrl(publicLiteral, { signal: controller.signal, headers: {} })
  const result = await readBodyCapped(response, controller)
  expect(result.truncated).toBe(true)
  expect(result.text.length).toBe(LIMITS.WEB_RESPONSE_BODY_HARD_CAP_BYTES)
  expect(controller.signal.aborted).toBe(true)
})

test("corrupt compressed body rejects the reader", async () => {
  mockResponse(200, Buffer.from("not gzip"), "gzip")
  const response = await fetchPublicUrl(publicLiteral, {
    signal: new AbortController().signal,
    headers: {},
  })
  await expect(response.text()).rejects.toThrow()
})

test("caller abort during DNS lookup preserves its reason and opens no socket", async () => {
  const lookup = spyOn(dns, "lookup").mockImplementation(() => new Promise(() => {}) as never)
  const request = spyOn(https, "request")
  restores.push(
    () => lookup.mockRestore(),
    () => request.mockRestore(),
  )
  const controller = new AbortController()
  const reason = new Error("caller cancelled lookup")
  const pending = fetchPublicUrl(new URL("https://public.example/"), {
    signal: controller.signal,
    headers: {},
  })
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(request).not.toHaveBeenCalled()
})

for (const addresses of [
  [],
  [{ address: "127.0.0.1", family: 4 }],
  [
    { address: "8.8.8.8", family: 4 },
    { address: "::1", family: 6 },
  ],
]) {
  test(`rejects unsafe DNS answers before connection: ${JSON.stringify(addresses)}`, async () => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue(addresses as never)
    const request = spyOn(https, "request")
    restores.push(
      () => lookup.mockRestore(),
      () => request.mockRestore(),
    )
    await expect(
      fetchPublicUrl(new URL("https://public.example/"), {
        signal: new AbortController().signal,
        headers: {},
      }),
    ).rejects.toThrow("blocked private host")
    expect(request).not.toHaveBeenCalled()
  })
}
