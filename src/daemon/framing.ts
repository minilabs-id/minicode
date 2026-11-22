// P2.12 — framing berpalang panjang untuk IPC loopback.
//
// Kenapa bukan newline-JSON: payload snapshot membawa riwayat presentasi yang
// boleh saja berisi `\n` di dalam string ter-escape maupun (bila salah escape)
// newline literal dari output model. Parser berbasis newline akan terpecah di
// tengah frame dan menyambung dua pesan jadi satu — klasik corruption yang
// berujung "event aneh" yang tak pernah bisa direproduksi. Palang 4 byte besar
// + ukuran eksplisit membuat pemisahan deterministik, dan batas `MAX_FRAME_BYTES`
// menutup jalur kehabisan memori dari peer yang mengirim header raksasa.

import { DAEMON_PROTOCOL, MAX_FRAME_BYTES } from "./protocol.ts"

/** Frame = [u32be length][utf8 json]. length = panjang payload, bukan total. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameError("FRAME_TOO_LARGE", `frame ${body.length} > ${MAX_FRAME_BYTES}`)
  }
  const out = Buffer.allocUnsafe(4 + body.length)
  out.writeUInt32BE(body.length, 0)
  body.copy(out, 4)
  return out
}

export class FrameError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    // Kode ikut di pesan: pemanggil (dan pengujian) hanya punya teks error,
    // dan "apa yang ditolak" harus terbaca tanpa harus menyimpan referensi
    // ke instance pengecualian.
    super(`${code}: ${message}`)
    this.name = "FrameError"
    this.code = code
  }
}

/**
 * Dekoder streaming. Satu instance per koneksi; `push()` menerima chunk bebas
 * ukuran dan memuntahkan pesan utuh. Sengaja menyimpan sisa buffer MINIMAL
 * (hanya byte yang belum jadi frame) — antrean terkendali ada di lapisan
 * subscription, bukan di sini.
 */
export class FrameDecoder {
  // E-28: dulu `Buffer.concat` dilakukan di SETIAP push. Untuk frame 8 MiB yang
  // datang sebagai chunk 64 KiB itu ~128× copy O(n) → O(n²). Sekarang chunk
  // disimpan sebagai daftar; SATU `Buffer.concat` hanya saat frame lengkap.
  #chunks: Buffer[] = []
  #head = 0
  #length = 0

  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk)
      this.#length += chunk.length
    }
    const out: unknown[] = []
    for (;;) {
      if (this.#length < 4) break
      const len = this.#peek(4).readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        this.#reset()
        throw new FrameError("FRAME_TOO_LARGE", `declared ${len} > ${MAX_FRAME_BYTES}`)
      }
      const frameBytes = 4 + len
      if (this.#length < frameBytes) break
      // SATU concat, tepat saat frame lengkap.
      const frame = this.#consume(frameBytes)
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.subarray(4).toString("utf8"))
      } catch {
        throw new FrameError("BAD_JSON", "frame payload bukan JSON valid")
      }
      out.push(parsed)
    }
    return out
  }

  /** Baca n byte pertama tanpa mengonsumsi (n ≤ #length). */
  #peek(n: number): Buffer {
    const first = this.#chunks[this.#head]!
    if (first.length >= n) return first.subarray(0, n)
    const out = Buffer.allocUnsafe(n)
    let off = 0
    for (let i = this.#head; i < this.#chunks.length && off < n; i++) {
      const c = this.#chunks[i]!
      const take = Math.min(c.length, n - off)
      c.copy(out, off, 0, take)
      off += take
    }
    return out
  }

  /** Ambil n byte dari depan dan lepas referensi chunk yang sudah habis. */
  #consume(n: number): Buffer {
    const parts: Buffer[] = []
    let remaining = n
    while (remaining > 0) {
      const c = this.#chunks[this.#head]!
      if (c.length <= remaining) {
        parts.push(c)
        this.#chunks[this.#head] = EMPTY_BUFFER
        this.#head++
        remaining -= c.length
      } else {
        parts.push(c.subarray(0, remaining))
        this.#chunks[this.#head] = c.subarray(remaining)
        remaining = 0
      }
    }
    this.#length -= n
    if (this.#head >= this.#chunks.length) {
      this.#chunks.length = 0
      this.#head = 0
    } else if (this.#head > 32 && this.#head * 2 > this.#chunks.length) {
      this.#chunks.splice(0, this.#head)
      this.#head = 0
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n)
  }

  #reset(): void {
    this.#chunks.length = 0
    this.#head = 0
    this.#length = 0
  }

  get pendingBytes(): number {
    return this.#length
  }
}

const EMPTY_BUFFER = Buffer.alloc(0)

/** Validasi kasar pesan masuk sebelum disentuh dispatcher. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function assertProtocol(hello: unknown): number {
  if (!isRecord(hello) || typeof hello.protocol !== "number") {
    throw new FrameError("PROTOCOL_ERROR", "hello.protocol wajib number")
  }
  if (hello.protocol !== DAEMON_PROTOCOL) {
    throw new FrameError(
      "PROTOCOL_ERROR",
      `protocol ${hello.protocol} != ${DAEMON_PROTOCOL} (daemon menolak konsumen versi lain)`,
    )
  }
  return hello.protocol
}
