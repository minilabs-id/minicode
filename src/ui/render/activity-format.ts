// Pemformat isi jendela sidebar — helper MURNI (tanpa I/O/TTY/state).
//
// v0.33: dua keluhan terpisah dari pemilik:
//   1. "output thinking dan tool lebih rapi" → buang markdown dekoratif dari
//      reasoning, rapikan spasi, dan satukan separasi baris aktivitas.
//   2. "rapikan nama-nama tool" → nama internal (`read_file`, `delegate_task`)
//      dipendekkan jadi label tampilan yang konsisten, prefix MCP dibuang.

import { sanitizeAnsiLine, stripSgr } from "./sanitize.ts"
import { c } from "./theme.ts"

/** Nama internal panjang → label tampilan pendek. Yang tak ada di peta tetap
 *  dipakai apa adanya (setelah prefix dibuang) supaya tool baru tak hilang. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  apply_patch: "patch",
  delegate_task: "agent",
  todo_write: "todo",
  todo_read: "todo",
  task_update: "task",
  list_directory: "ls",
}

/** Nama tool untuk ditampilkan: sanitasi, buang prefix, peta label pendek. */
export function toolDisplayName(raw: string): string {
  const clean = stripSgr(sanitizeAnsiLine(raw)).trim()
  const base = clean.replace(/^(?:mcp__|functions[./])+/i, "")
  return TOOL_LABELS[base.toLowerCase()] ?? base
}

/** Baris reasoning: SGR dibuka, markdown dekoratif dibuang, trailing spasi mati.
 *  Konten kata TIDAK dibuang — ini soal kerapian, bukan pemotongan histori. */
export function normalizeThinkingLine(line: string): string {
  return stripSgr(sanitizeAnsiLine(line))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .trimEnd()
}

/** Satu baris aktivitas: `<tool> <target> · <status>[: alasan]`.
 *  Semua field lewat sanitasi; pemisah `·` konsisten, tanpa spasi dobel. */
export function formatActivityLine(parts: {
  readonly tag: string
  readonly name: string
  readonly target?: string
  readonly status: string
  readonly reason?: string
}): string {
  const clean = (v: string): string => stripSgr(sanitizeAnsiLine(v)).trim()
  // Warna: nama tool mengikuti hasil (hijau sukses / merah gagal / biru lain),
  // tag agent aksen, target abu, alasan gagal merah — aktivitas mudah dipindai.
  const label = toolDisplayName(parts.name)
  const name =
    parts.status === "failed"
      ? c.error(label)
      : parts.status === "completed"
        ? c.success(label)
        : c.info(label)
  const tag = parts.tag ? `${c.accent(clean(parts.tag))} ` : ""
  const target = parts.target ? ` ${c.gray(clean(parts.target))}` : ""
  const status =
    parts.status === "completed"
      ? ""
      : ` · ${c.error(`${clean(parts.status)}${parts.reason ? `: ${clean(parts.reason)}` : ""}`)}`
  return `${tag}${name}${target}${status}`.replace(/ +/g, " ").trim()
}
