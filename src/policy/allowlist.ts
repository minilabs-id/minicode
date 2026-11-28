import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ToolCall } from "#minicore/core/types.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"

export interface Allowlist {
  allowed: string[] // entries like "bash:echo hi" or "write_file:.tmp/*"
}

const GLOBAL_ALLOW = join(homedir(), ".minicode", "allowlist.json")
const LOCAL_ALLOW = ".minicode/allowlist.json"

function sanitizeAllowedEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  let invalid = 0
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry)
    else invalid++
  }
  if (invalid > 0) {
    process.stderr.write(`[warn] allowlist: ignoring ${invalid} non-string/empty entry\n`)
  }
  return out
}

export async function loadAllowlist(
  cwd?: string,
  opts: { allowLocal?: boolean } = {},
): Promise<Allowlist> {
  let globalList: string[] = []
  let localList: string[] = []
  try {
    const txt = await readFile(GLOBAL_ALLOW, "utf8")
    const parsed = JSON.parse(txt) as { allowed?: unknown }
    globalList = sanitizeAllowedEntries(parsed?.allowed)
  } catch {}
  // Sama seperti config (audit #07 P0): allowlist lokal adalah input repo —
  // repo yang memberi dirinya sendiri "always" = persetujuan palsu. Hanya
  // dibaca bila operator opt-in; default = global saja.
  if (opts.allowLocal) {
    try {
      const path = resolve(cwd ?? process.cwd(), LOCAL_ALLOW)
      const txt = await readFile(path, "utf8")
      const parsed = JSON.parse(txt) as { allowed?: unknown }
      localList = sanitizeAllowedEntries(parsed?.allowed)
    } catch {}
  }
  // merge global+local, dedup
  const merged = new Set<string>([...globalList, ...localList])
  return { allowed: [...merged] }
}

export async function saveAllowlist(entry: string, cwd?: string, opts: { global?: boolean } = {}) {
  if (typeof entry !== "string" || entry.length === 0) return
  const path = opts.global ? GLOBAL_ALLOW : resolve(cwd ?? process.cwd(), LOCAL_ALLOW)
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  let allowed: string[] = []
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { allowed?: unknown }
    allowed = sanitizeAllowedEntries(parsed?.allowed)
  } catch {}
  if (!allowed.includes(entry)) allowed.push(entry)
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  await atomicWriteText(path, JSON.stringify({ allowed }, null, 2))
}

// [Audit #2 C.F6] Cache kompilasi RegExp per pola allowlist: `new RegExp`
// semula dibuat ulang di setiap pemeriksaan tool call (hot path).
const allowlistReCache = new Map<string, RegExp>()
function allowlistRe(pat: string): RegExp {
  let re = allowlistReCache.get(pat)
  if (!re) {
    const safe = pat.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
    re = new RegExp(`^${safe}$`)
    allowlistReCache.set(pat, re)
  }
  return re
}

export function matchAllowlist(call: ToolCall, allowlist: string[]): boolean {
  // Tanpa pemotongan: kunci = nama + JSON ARG PENUH. Versi lama memakai
  // `.slice(0, 200)` sehingga dua panggilan dengan 200-char prefix sama
  // berbagi kunci — entri "always" untuk perintah jinak panjang otomatis
  // me-allow perintah jahat dengan prefix sama (temuan audit #07, reproducer:
  // prefix 'A'x195 + tail jinak vs tail jahat → kunci terpotong identik).
  const key = `${call.name}:${JSON.stringify(call.args)}`
  return allowlist.some((pat) => {
    // Entri `exact:` ditulis `saveAlways` saat argumen memuat `*` literal agar
    // klik "Always" pada `ls *.ts` tidak berubah menjadi wildcard `.*` global.
    if (pat.startsWith("exact:")) return key === pat.slice("exact:".length)
    const re = allowlistRe(pat)
    if (pat.includes(":")) return re.test(key)
    return re.test(call.name) || re.test(key)
  })
}
