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
  grep: "activity.tool.grep",
  glob: "activity.tool.glob",
  ls: "activity.tool.ls",
  stat: "activity.tool.stat",
  delegate_task: "activity.tool.delegate",
  todo_write: "activity.tool.plan",
  reasoning: "activity.tool.thought",
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
    const extra = activity?.label ?? activity?.summary ?? activity?.target
    if (extra) label = `${label} · ${extra}`
  }
  return truncateToWidth(sanitizeAnsiLine(label), 40, "…")
}
