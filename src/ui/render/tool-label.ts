// Label aktivitas tool manusiawi — murni, dipakai TUI & printer linear.
// Sengaja terpisah dari `t()`: label mengikuti locale OS (Intl), narasi
// mengikuti `/lang`. Kategori rekap di transcript memakai nama internal,
// bukan helper ini; di sini hanya tampilan + sanitasi/truncasi di ujung.
import { en } from "../i18n/en.ts"
import { id } from "../i18n/id.ts"
import type { Locale, MsgKey } from "../i18n/locale.ts"
import { sanitizeAnsiLine } from "./sanitize.ts"
import { truncateToWidth } from "./width.ts"

/** Sekitar 12 tool umum. Nama di luar peta jatuh ke nama internal apa adanya. */
const TOOL_LABEL_KEYS: Readonly<Record<string, MsgKey>> = {
  read_file: "activity.tool.readFile",
  read_image: "activity.tool.readImage",
  write_file: "activity.tool.writeFile",
  edit: "activity.tool.edit",
  apply_patch: "activity.tool.applyPatch",
  delete_file: "activity.tool.deleteFile",
  move_file: "activity.tool.moveFile",
  bash: "activity.tool.bash",
  bash_output: "activity.tool.bashOutput",
  bash_kill: "activity.tool.bashKill",
  grep: "activity.tool.grep",
  glob: "activity.tool.glob",
  read_memory: "activity.tool.readMemory",
  write_memory: "activity.tool.writeMemory",
  forget_memory: "activity.tool.forgetMemory",
  delegate_task: "activity.tool.delegate",
  todo_write: "activity.tool.plan",
  todo_read: "activity.tool.todoRead",
  submit_result: "activity.tool.submitResult",
  ask_user: "activity.tool.askUser",
  reasoning: "activity.tool.thought",
  git_status: "activity.tool.gitStatus",
  git_diff: "activity.tool.gitDiff",
  git_log: "activity.tool.gitLog",
  git_commit: "activity.tool.gitCommit",
  git_push: "activity.tool.gitPush",
  git_restore: "activity.tool.gitRestore",
  git_checkout: "activity.tool.gitCheckout",
  web_search: "activity.tool.webSearch",
  web_fetch: "activity.tool.webFetch",
  code_run: "activity.tool.codeRun",
  lsp_diagnostics: "activity.tool.lsp",
  lsp_definition: "activity.tool.lsp",
  lsp_references: "activity.tool.lsp",
  lsp_hover: "activity.tool.lsp",
  lsp_symbols: "activity.tool.lsp",
  lsp_workspace_symbols: "activity.tool.lsp",
  lsp_rename: "activity.tool.lsp",
  mcp_call: "activity.tool.mcp",
  mcp_list: "activity.tool.mcp",
  mcp_read: "activity.tool.mcp",
  mcp_prompt: "activity.tool.mcp",
}

let cachedSystemLocale: Locale | null = null

/** Test-only: paksa hasil deteksi OS agar kedua cabang en/id bisa diuji. */
export function __setSystemLocaleForTest(locale: Locale | null): void {
  cachedSystemLocale = locale
}

/** Locale SISTEM/OS lazy-cache: `id` bila mulai "id", else `en`. Sengaja tak
 * membaca env/state/sesi /lang — itu jalur bahasa user. */
export function systemLocale(): Locale {
  if (cachedSystemLocale !== null) return cachedSystemLocale
  let raw = ""
  try {
    raw = new Intl.DateTimeFormat().resolvedOptions().locale ?? ""
  } catch {
    // Lingkungan tanpa Intl penuh: fallback aman ke en.
    raw = ""
  }
  cachedSystemLocale = raw.trim().toLowerCase().startsWith("id") ? "id" : "en"
  return cachedSystemLocale
}

/** Toast/kwitansi/peringatan memakai locale OS, bukan `/lang`. Narasi tetap
 * lewat `t()`. Interpolasi `{nama}` identik; sengaja tak impor `t()` agar tak
 * mengikuti sesi. */
export function tSystem(key: MsgKey, params?: Record<string, string | number>): string {
  const template = (systemLocale() === "id" ? id : en)[key] ?? en[key] ?? key
  if (!params) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m,
  )
}

/** Subset activity yang dipakai label delegate (structural: UiPresentationActivity cocok). */
export interface HumanToolActivity {
  label?: string
  intent?: string
  summary?: string
  target?: string
}

/** Nama internal → label manusiawi locale OS. `delegate_task` menyisipkan
 * identitas child (label → summary → target). Sanitasi + potong 40 kolom. */
export function humanToolLabel(rawName: string, activity?: HumanToolActivity): string {
  const key = TOOL_LABEL_KEYS[rawName]
  const dict = systemLocale() === "id" ? id : en
  let label: string = key ? (dict[key] ?? rawName) : rawName
  if (rawName === "delegate_task") {
    const extra = activity?.intent ?? activity?.label ?? activity?.summary ?? activity?.target
    if (extra) label = `${label} · ${extra}`
  }
  return truncateToWidth(sanitizeAnsiLine(label), 40, "…")
}

/**
 * Rapikan target argumen untuk label manusiawi otomatis: hilangkan noise `cd … &&`
 * pada bash, ringkas path panjang menjadi basename bila >36 kolom, dan buang
 * awalan `pattern=`/`query=`/`glob=` agar nyaman dibaca.
 */
export function cleanAutoTarget(rawName: string, rawTarget?: string): string {
  if (!rawTarget) return ""
  let clean = sanitizeAnsiLine(rawTarget).trim()
  if (!clean) return ""
  if (rawName === "bash" || rawName === "code_run") {
    clean = clean.replace(/^\$\s+/, "")
    clean = clean.replace(/^cd\s+(?:\/d\s+)?(?:"[^"]+"|\S+)\s*&&\s*/i, "")
    return truncateToWidth(clean.trim(), 44, "…")
  }
  if (rawName === "grep" || rawName === "glob") {
    clean = clean.replace(/^(?:pattern|query|glob)=/i, "")
    return truncateToWidth(clean.trim(), 40, "…")
  }
  if (
    rawName === "read_file" ||
    rawName === "read_image" ||
    rawName === "write_file" ||
    rawName === "edit" ||
    rawName === "apply_patch" ||
    rawName === "delete_file" ||
    rawName === "move_file" ||
    rawName === "stat" ||
    rawName === "ls" ||
    rawName === "git_restore" ||
    rawName.startsWith("lsp_")
  ) {
    if (clean.length > 36 && !clean.includes(" → ")) {
      const normalized = clean.replace(/\\/g, "/")
      const base = normalized.slice(normalized.lastIndexOf("/") + 1)
      if (base) clean = base
    }
    return truncateToWidth(clean, 40, "…")
  }
  return truncateToWidth(clean, 48, "…")
}

/**
 * Judul utama aktivitas tool untuk live & ledger:
 * - `text` / `isIntent=true`: memakai label niat eksplisit dari model (`args.label`).
 * - `autoText`: label manusiawi deterministik 0-token (tanpa menunggu model).
 */
export function formatActivityLabel(
  rawName: string,
  activity?: HumanToolActivity,
  opts: { maxCols?: number } = {},
): { text: string; autoText: string; isIntent: boolean } {
  const maxCols = opts.maxCols ?? 72
  const cleanIntent = activity?.intent ? sanitizeAnsiLine(activity.intent).trim() : ""
  const baseLabel = humanToolLabel(rawName, activity)
  // `delegate_task` sudah menyertakan extra (label/summary/target) di `humanToolLabel`.
  const cleanTarget = rawName === "delegate_task" ? "" : cleanAutoTarget(rawName, activity?.target)
  const autoRaw = cleanTarget
    ? rawName === "bash" || rawName === "code_run"
      ? `${baseLabel}: ${cleanTarget}`
      : `${baseLabel} ${cleanTarget}`
    : baseLabel
  const autoText = truncateToWidth(autoRaw, maxCols, "…")
  if (cleanIntent) {
    return { text: truncateToWidth(cleanIntent, maxCols, "…"), autoText, isIntent: true }
  }
  return { text: baseLabel, autoText, isIntent: false }
}
