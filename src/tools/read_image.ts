import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { estimateImageTokens } from "../policy/context.ts"
import { openSafeToolReadHandle } from "./context.ts"

// Batas b64 = batas truncate kernel yang sebenarnya: toolResultMaxTokens
// (default 4096) × DEFAULT_CHARS_PER_TOKEN (4) = 16.384 chars, dengan margin
// kecil untuk header data-URL + baris metadata. Sinkron dengan komentar di
// vendor tokens.ts — angka lain (BASH_OUTPUT×5) melanggar intent anti-korup.
const IMAGE_B64_MAX_CHARS = 4096 * 4 - 200

function detectImageMime(ext: string, buf: Buffer): string {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  if (ext === "png") return "image/png"
  // Fallback ke magic bytes bila ekstensi tidak dikenal/absen.
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png"
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    buf.length >= 6 &&
    (buf.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buf.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif"
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }
  return "image/png"
}

export const readImageTool: Tool = {
  name: "read_image",
  description:
    "Read an image file as base64 for vision review (PNG/JPG/WebP/GIF). Returns data URL + token estimate.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "relative image file path" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const { handle, st } = await openSafeToolReadHandle(p, ctx)
    let buf: Buffer
    try {
      if (st.size > LIMITS.READ_FILE_MAX_BYTES)
        throw new Error(`image too large: ${st.size} bytes (max 2M)`)
      buf = await handle.readFile()
      // Cek b64 agar tidak terpotong diam-diam oleh serializeContent.
      // Investigasi Phase 5 (probe E-1): batas kernel truncate yang SEBENARNYA
      // = maxTokens(4096) × 4 = 16.384 chars (toolResultMaxTokens TIDAK pernah
      // dioverride). Guard lama memakai BASH_OUTPUT_MAX_CHARS×5 = 100k — 6,1×
      // di atas kernel → gambar >~12KB lolos guard lalu DIPOTONG TENGAH oleh
      // kernel = base64 korup terkirim. Guard kini memakai angka kernel.
      const estB64 = Math.ceil((buf.byteLength * 4) / 3) + 30
      if (estB64 > IMAGE_B64_MAX_CHARS)
        throw new Error(
          `image too large: base64 ~${estB64} chars exceeds the ${IMAGE_B64_MAX_CHARS}-char context limit — compress or resize it first`,
        )
    } finally {
      await handle.close().catch(() => {})
    }
    const b64 = buf.toString("base64")
    const ext = p.split(".").pop()?.toLowerCase() ?? ""
    const mime = detectImageMime(ext, buf)
    const tokens = estimateImageTokens(buf.byteLength)
    // S4 — kirim utuh + laporkan bytes (dulu slice 200k diam-diam → gambar korup).
    // File sudah di-cap (READ_FILE_MAX_BYTES + IMAGE_B64_MAX_CHARS) di atas,
    // jadi b64 selalu muat anggaran truncate konteks.
    return `data:${mime};base64,${b64}\n(${buf.byteLength} bytes ${mime}, tokens ~${tokens})`
  },
}
