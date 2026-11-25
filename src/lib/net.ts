// Shared host validation. isPrivateHostWithDns performs resolve-and-check only;
// web_fetch uses public-http.ts to bind validated addresses to socket lookup.
// Other consumers still need their own connection-level policy.
//
// RESIDUAL anti-SSRF yang SENGAJA TIDAK ditutup (dokumentasi jujur, bukan
// kelalaian): prefix IPv6 lain yang juga memuat alamat IPv4 tapi tidak
// menaruhnya di 32 bit terakhir — NAT64 well-known (64:ff9b::/96), 6to4
// (2002::/16), dan Teredo (2001:0000::/32, IPv4-nya di-obfuscate). Bentuk itu
// hanya terjangkau bila mesin punya translator/relay NAT64 atau 6to4 — dan
// memblokir 64:ff9b::/96 sepenuhnya akan mematikan host IPv6-only yang sah di
// lingkungan NAT64. Yang ditutup: IPv4-mapped (::ffff:0:0/96),
// IPv4-translated (::ffff:0:0:0/96), dan IPv4-compatible (::/96).
import { lookup } from "node:dns/promises"

// Host validasi untuk anti-SSRF. Catatan: WHATWG URL sudah menormalisasi host
// IPv4 non-dotted (hex 0x7f000001 / desimal 2130706433) menjadi dotted-decimal,
// jadi cukup cek bentuk dotted di sini — bypass encoding tertutup oleh parser.
// CATATAN PENTING: normalisasi itu HANYA berlaku untuk IPv4 telanjang.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) ditulis parser sebagai HEKSADESIMAL
// ("::ffff:a9fe:a9fe"), bukan dotted — jadi bentuk dotted SAJA tidak cukup,
// dan tanpa penanganan extra guard ini lolos ke metadata endpoint IMDS.
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])
  const d = Number(m[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return true
  if (a === 127 || a === 10 || a === 0) return true // loopback / priv10 / this-network
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // link-local (cloud metadata IMDS)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18.0.0/15
  if (a >= 224) return true // multicast 224.0.0.0/4 & reserved 240.0.0.0/4
  return false
}

// Ambil alamat IPv4 yang tertanam di 32 bit TERAKHIR sebuah literal IPv6.
// Dua bentuk: dotted ("169.254.169.254") atau hextet ("a9fe:a9fe", atau
// "0:a9fe:a9fe" untuk IPv4-translated). Bentuk hextet inilah yang dipakai
// parser WHATWG, jadi bentuk dotted saja tidak cukup.
function low32IPv4(tail: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail
  const parts = tail.split(":").filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const lo = parts[parts.length - 1]!
  const hi = parts.length >= 2 ? parts[parts.length - 2]! : "0"
  if (!/^[0-9a-f]{1,4}$/.test(hi) || !/^[0-9a-f]{1,4}$/.test(lo)) return null
  const hiN = Number.parseInt(hi, 16)
  const loN = Number.parseInt(lo, 16)
  if (!Number.isFinite(hiN) || !Number.isFinite(loN)) return null
  return [hiN >>> 8, hiN & 0xff, loN >>> 8, loN & 0xff].join(".")
}

/** Ekspansi alamat IPv6 literal (termasuk bentuk non-kompresi `0:0:0:0:0:0:0:1`) ke 8 hextet. */
function expandIPv6Hextets(h: string): number[] | null {
  if (!h.includes(":")) return null
  // Pisahkan suffix dotted IPv4 bila ada (mis. `0:0:0:0:0:ffff:127.0.0.1`).
  let work = h
  const lastColon = work.lastIndexOf(":")
  const tail = work.slice(lastColon + 1)
  if (tail.includes(".")) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
    if (!m) return null
    const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (oct.some((o) => o > 255)) return null
    const hi = ((oct[0]! << 8) | oct[1]!).toString(16)
    const lo = ((oct[2]! << 8) | oct[3]!).toString(16)
    work = `${work.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = work.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null
  const full = [...left, ...Array<string>(missing).fill("0"), ...right]
  if (full.length !== 8) return null
  const nums: number[] = []
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    nums.push(Number.parseInt(part, 16))
  }
  return nums
}

export function isPrivateHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
  if (!h) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.endsWith(".internal") || h.endsWith(".local")) return true
  // Bentuk IPv4 alternatif tanpa URL normalization (integer 2130706433, hex
  // 0x7f000001, oktal 0177.0.0.1) — fail-closed.
  if (/^(?:\d+|0x[0-9a-f]+)$/i.test(h) || /^0\d+(?:\.\d+){1,3}$/.test(h)) return true
  if (h === "::1" || h === "::") return true
  // IPv4-mapped (::ffff:0:0/96) dan IPv4-translated (::ffff:0:0:0/96): alamat
  // IPv4 ada di 32 bit terakhir. Parser menuliskan ini sebagai heksadesimal,
  // jadi bentuk dotted yang tadinya ditangani TIDAK menangkapnya.
  if (h.startsWith("::ffff:")) {
    const v4 = low32IPv4(h.slice(7))
    return v4 ? isPrivateIPv4(v4) : true
  }
  // IPv4-compatible (::/96, mis. "::a9fe:a9fe"): 32 bit terakhir juga IPv4.
  // Rentang ini tidak dipakai untuk host sungguhan → fail-closed.
  if (h.startsWith("::")) {
    const v4 = low32IPv4(h.slice(2))
    if (v4) return isPrivateIPv4(v4)
  }
  // Normalisasi penuh IPv6: tutup bentuk non-kompresi (`0:0:0:0:0:0:0:1`,
  // `0:0:0:0:0:ffff:7f00:1`), multicast (`ff00::/8`), site-local (`fec0::/10`),
  // unique-local (`fc00::/7`), dan link-local (`fe80::/10`).
  const v6 = expandIPv6Hextets(h)
  if (v6) {
    const first = v6[0]!
    const allZeroPrefix6 = v6.slice(0, 6).every((x) => x === 0)
    const allZeroPrefix5 = v6.slice(0, 5).every((x) => x === 0)
    if (allZeroPrefix6 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) return true // :: / ::1
    if (allZeroPrefix5 && v6[5] === 0xffff) {
      const v4 = [v6[6]! >>> 8, v6[6]! & 0xff, v6[7]! >>> 8, v6[7]! & 0xff].join(".")
      return isPrivateIPv4(v4)
    }
    if (allZeroPrefix6 && (v6[6] !== 0 || v6[7] !== 0)) {
      const v4 = [v6[6]! >>> 8, v6[6]! & 0xff, v6[7]! >>> 8, v6[7]! & 0xff].join(".")
      if (isPrivateIPv4(v4)) return true
    }
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site-local
    if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]{0,1}:/.test(h)) return true // fe80::/10 link-local
  if (/^fe[c-f][0-9a-f]{0,1}:/.test(h)) return true // fec0::/10 site-local
  if (/^ff[0-9a-f]{0,2}:/.test(h)) return true // ff00::/8 multicast
  return isPrivateIPv4(h)
}

// Resolve-and-check only; legacy default is 400ms fail-open, strict is 1000ms
// fail-closed. Tool web_fetch uses the separate pinned public HTTP transport.
const dnsCache = new Map<string, { addrs: string[]; at: number }>()
export async function isPrivateHostWithDns(
  hostname: string,
  opts: { strict?: boolean; timeoutMs?: number; noCache?: boolean } = {},
): Promise<boolean> {
  if (isPrivateHost(hostname)) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return false
  const timeoutMs = opts.timeoutMs ?? (opts.strict ? 1000 : 400)
  if (!opts.noCache) {
    const cached = dnsCache.get(hostname)
    if (cached && Date.now() - cached.at < 30_000) {
      for (const a of cached.addrs) if (isPrivateHost(a) || isPrivateIPv4(a)) return true
      return false
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addrs = (await Promise.race([
      lookup(hostname, { all: true } as never).then((r) => {
        if (Array.isArray(r)) return (r as { address: string }[]).map((x) => x.address)
        return [(r as { address: string }).address]
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("dns timeout")), timeoutMs)
      }),
    ])) as string[]
    if (!opts.noCache) dnsCache.set(hostname, { addrs, at: Date.now() })
    for (const a of addrs) if (isPrivateHost(a) || isPrivateIPv4(a)) return true
  } catch {
    // Strict consumers fail closed on DNS errors. Never cache a failed lookup.
    if (opts.strict) return true
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return false
}
