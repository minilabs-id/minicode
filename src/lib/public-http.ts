import { lookup } from "node:dns/promises"
import * as http from "node:http"
import * as https from "node:https"
import { isIP } from "node:net"
import { pipeline, Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { isPrivateHost } from "./net.ts"

export interface PinnedRequestInit {
  signal: AbortSignal
  headers: Record<string, string>
  method?: "GET" | "POST" | "DELETE"
  body?: string
  /** Izinkan host privat (khusus MCP lokal yang di-opt-in eksplisit); IP tetap di-pin ke socket. */
  allowPrivateHost?: boolean
}

/**
 * Resolve once and pass only validated addresses to the socket lookup.
 * The original URL retains HTTP Host and HTTPS certificate/SNI validation.
 * No proxy, connection pool, or automatic redirect can bypass this lookup.
 */
export async function fetchPinnedUrl(url: URL, init: PinnedRequestInit): Promise<Response> {
  init.signal.throwIfAborted()
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("disallowed protocol")
  const allowPrivate = init.allowPrivateHost === true
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (!allowPrivate && isPrivateHost(hostname)) {
    throw new Error(`blocked private host: ${hostname}`)
  }
  const family = isIP(hostname)
  let addresses: { address: string; family: number }[]
  if (family) addresses = [{ address: hostname, family }]
  else {
    // 4000ms memberi ruang untuk DNS dingin/VPN/Windows tanpa mengorbankan batas 10s web_fetch.
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(4000)])
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
    addresses.some(
      (entry) => !isIP(entry.address) || (!allowPrivate && isPrivateHost(entry.address)),
    )
  ) {
    throw new Error(`blocked private host: ${hostname}`)
  }
  init.signal.throwIfAborted()
  const target = new URL(url)
  target.username = ""
  target.password = ""
  const method = init.method ?? "GET"
  const headers: Record<string, string> = { ...init.headers }
  const payload = init.body !== undefined ? Buffer.from(init.body, "utf8") : undefined
  if (payload && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
    headers["content-length"] = String(payload.byteLength)
  }

  // Untuk HTTP polos (tanpa TLS SNI), pin IP tervalidasi langsung ke hostname URL + header Host
  // lewat fetch native (redirect: "manual"). Ini menutup DNS rebinding sekaligus menghindari
  // bug UAF callback custom `lookup` pada `node:http` di Bun Windows saat koneksi/abort bertubi-tubi.
  if (target.protocol === "http:") {
    const pinned = new URL(target)
    const entry = addresses[0]!
    pinned.hostname = entry.family === 6 ? `[${entry.address}]` : entry.address
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "host")) {
      headers.host = target.host
    }
    try {
      const res = await fetch(pinned, {
        method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: init.signal,
        redirect: "manual",
      })
      if (res.status < 200 || res.status > 599) {
        throw new Error(`invalid HTTP status: ${res.status}`)
      }
      return res
    } catch (err) {
      if (init.signal.aborted && init.signal.reason !== undefined) {
        throw init.signal.reason
      }
      throw err
    }
  }

  return new Promise<Response>((resolve, reject) => {
    const rejectWithAbort = (err: unknown): void => {
      if (init.signal.aborted && init.signal.reason !== undefined) {
        reject(init.signal.reason)
        return
      }
      reject(err)
    }
    const request = target.protocol === "https:" ? https.request : http.request
    const req = request(
      target,
      {
        method,
        headers,
        signal: init.signal,
        agent: false,
        lookup: (_host, options, callback) => {
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
          const resHeaders = new Headers()
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            resHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
          }
          const status = res.statusCode ?? 502
          if (status < 200 || status > 599) throw new Error(`invalid HTTP status: ${status}`)
          const noBody = status === 204 || status === 205 || status === 304
          if (noBody) res.resume()
          else {
            const encodings = (resHeaders.get("content-encoding") ?? "")
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter((s) => s && s !== "identity")
            // Batasi rantai decompression (anti zip/gzip-bomb berlapis).
            if (encodings.length > 4) {
              throw new Error(`too many content-encoding layers: ${encodings.length}`)
            }
            for (const encoding of encodings.reverse()) {
              const decoder =
                encoding === "gzip" || encoding === "x-gzip"
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
              resHeaders.delete("content-encoding")
              resHeaders.delete("content-length")
            }
          }
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>),
              {
                status,
                statusText: res.statusMessage,
                headers: resHeaders,
              },
            ),
          )
        } catch (error) {
          body.destroy()
          res.destroy()
          rejectWithAbort(error)
        }
      },
    )
    req.once("error", rejectWithAbort)
    if (payload) req.end(payload)
    else req.end()
  })
}

export async function fetchPublicUrl(
  url: URL,
  init: { signal: AbortSignal; headers: Record<string, string> },
): Promise<Response> {
  return fetchPinnedUrl(url, { ...init, method: "GET", allowPrivateHost: false })
}

// A module boundary for transport-level tests without opening real network sockets.
export const publicHttp = { fetch: fetchPublicUrl, request: fetchPinnedUrl }
