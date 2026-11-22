// E-28: frame 8 MiB dari chunk 64 KiB terakit benar untuk IPC daemon dan LSP,
// tanpa O(n²) Buffer.concat dan dengan batas Content-Length di LSP.
import { expect, test } from "bun:test"
import { encodeFrame, FrameDecoder } from "../src/daemon/framing.ts"
import { LspFrameAssembler } from "../src/lsp/client.ts"

const CHUNK = 64 * 1024

function feed(decoder: FrameDecoder, chunks: Buffer[]): unknown[] {
  const out: unknown[] = []
  for (const c of chunks) out.push(...decoder.push(c))
  return out
}

test("daemon: frame ~8 MiB dari chunk 64 KiB → satu pesan utuh", () => {
  const payload = "x".repeat(8 * 1024 * 1024 - 256)
  const encoded = encodeFrame(payload)
  const chunks: Buffer[] = []
  for (let i = 0; i < encoded.length; i += CHUNK) {
    chunks.push(encoded.subarray(i, Math.min(i + CHUNK, encoded.length)))
  }
  expect(chunks.length).toBeGreaterThan(100)

  const decoder = new FrameDecoder()
  const messages = feed(decoder, chunks)
  expect(messages).toEqual([payload])
  expect(decoder.pendingBytes).toBe(0)
})

test("daemon: dua frame berturut-turut dalam aliran chunk", () => {
  const a = encodeFrame({ n: 1 })
  const b = encodeFrame({ n: 2 })
  const stream = Buffer.concat([a, b])
  const chunks: Buffer[] = []
  for (let i = 0; i < stream.length; i += 3) chunks.push(stream.subarray(i, i + 3))
  expect(feed(new FrameDecoder(), chunks)).toEqual([{ n: 1 }, { n: 2 }])
})

function lspFrame(body: unknown): Buffer {
  const raw = Buffer.from(JSON.stringify(body), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${raw.length}\r\n\r\n`, "utf8"), raw])
}

test("LSP: pesan ~8 MiB dari chunk 64 KiB → satu JSON utuh", () => {
  const body = { method: "x", text: "y".repeat(8 * 1024 * 1024 - 512) }
  const wire = lspFrame(body)
  const assembler = new LspFrameAssembler()
  const out: unknown[] = []
  for (let i = 0; i < wire.length; i += CHUNK) {
    out.push(...assembler.push(wire.subarray(i, Math.min(i + CHUNK, wire.length))))
  }
  expect(out).toEqual([body])
  expect(assembler.pendingBytes).toBe(0)
})

test("LSP: header Content-Length dibatasi (tidak menunggu OOM)", () => {
  const assembler = new LspFrameAssembler()
  const errs: string[] = []
  const prev = process.stderr.write
  ;(process.stderr as unknown as { write: unknown }).write = (c: unknown) => {
    errs.push(String(c))
    return true
  }
  try {
    expect(assembler.push(Buffer.from("Content-Length: 99999999999\r\n\r\n", "utf8"))).toEqual([])
  } finally {
    process.stderr.write = prev
  }
  expect(assembler.pendingBytes).toBe(0)
  expect(errs.join("")).toContain("rejected")
})
