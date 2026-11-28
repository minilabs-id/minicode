// Struk aksi pendek di dalam popup (sukses/gagal/info). Satu sumber agar
// manager model & penyedia tidak lagi merender error sebagai teks redup tanpa
// kata status: error = merah + pesan kanonik, sukses = hijau, info = redup.
import { sanitizeAnsiLine } from "./sanitize.ts"
import { c } from "./theme.ts"

export type NoticeKind = "success" | "error" | "info"

function paintNotice(kind: NoticeKind, text: string): string {
  const clean = sanitizeAnsiLine(text)
  if (kind === "success") return c.success(clean)
  if (kind === "error") return c.error(clean)
  return c.dim(clean)
}

/** Notice multi-baris (formatError membawa baris `→ fix`). */
export function paintNoticeLines(kind: NoticeKind, text: string): string[] {
  return text.split("\n").map((line) => paintNotice(kind, line))
}
