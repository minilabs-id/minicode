import { lookup } from "node:dns/promises"
import * as http from "node:http"
import * as https from "node:https"
import { isIP } from "node:net"
import { pipeline, Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { isPrivateHost } from "./net.ts"

/** Resolve once and pass only validated addresses to the socket lookup.
 * The original URL retains HTTP Host and HTTPS certificate/SNI validation.
 * No proxy, connection pool, or automatic redirect can bypass this lookup. */
export async function fetchPublicUrl(
  url: URL,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  init.signal.throwIfAborted()
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("disallowed protocol")
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (isPrivateHost(hostname)) throw new Error(`blocked private host: ${hostname}`)
  const family = isIP(hostname)
  let addresses: { address: string; family: number }[]
  if (family) addresses = [{ address: hostname, family }]
  else {
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(1000)])
    let onAbort!: () => void
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener("abort", onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
    } catch {
      init.signal.throwIfAborted()
      throw new Error(`blocked private host: ${hostname} (DNS resolution failed)`)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
  if (
    !addresses.length ||
    addresses.some((entry) => !isIP(entry.address) || isPrivateHost(entry.address))
  ) {
    throw new Error(`blocked private host: ${hostname}`)
  }
  init.signal.throwIfAborted()
  const target = new URL(url)
  target.username = ""
  target.password = ""
  return new Promise<Response>((resolve, reject) => {
    const request = target.protocol === "https:" ? https.request : http.request
    const req = request(
      target,
      {
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        agent: false,
        lookup: (_host, options, callback) => {
          // Both Node and Bun may request all addresses for family autoselection.
          if ((options as { all?: boolean }).all) {
            callback(null, addresses as never)
          } else {
            const entry = addresses[0]!
            callback(null, entry.address, entry.family)
          }
        },
      },
      (res) => {
        let body: Readable = res
        try {
          const headers = new Headers()
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
          }
          const status = res.statusCode ?? 502
          if (status < 200 || status > 599) throw new Error(`invalid HTTP status: ${status}`)
          const noBody = status === 204 || status === 205 || status === 304
          if (noBody) res.resume()
          else {
            const encodings = (headers.get("content-encoding") ?? "")
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter((s) => s && s !== "identity")
            for (const encoding of encodings.reverse()) {
              const decoder =
                encoding === "gzip"
                  ? createGunzip()
                  : encoding === "deflate"
                    ? createInflate()
                    : encoding === "br"
                      ? createBrotliDecompress()
                      : undefined
              if (!decoder) throw new Error(`unsupported content encoding: ${encoding}`)
              pipeline(body, decoder, () => {})
              body = decoder
            }
            if (encodings.length) {
              headers.delete("content-encoding")
              headers.delete("content-length")
            }
          }
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>),
              {
                status,
                statusText: res.statusMessage,
                headers,
              },
            ),
          )
        } catch (error) {
          body.destroy()
          res.destroy()
          reject(error)
        }
      },
    )
    req.once("error", reject)
    req.end()
  })
}

// A module boundary for transport-level tests without opening real network sockets.
export const publicHttp = { fetch: fetchPublicUrl }
