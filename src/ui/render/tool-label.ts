// Label aktivitas tool manusiawi — MURNI, tanpa I/O (tetap bisa dipakai
// presenter linear `simple.ts` maupun renderer TUI dengan satu sumber angka).
//
// KENAPA terpisah dari `t()` di i18n/locale.ts: label aktivitas mengikuti
// bahasa SISTEM/OS (Intl), sedangkan narasi/model mengikuti bahasa user
// (`/lang`). Kalau memakai `t()`, ganti /lang ikut mengganti nama tool di
// footer — itu bukan yang diminta. Dua jalur ini sengaja beda.
//
// Kategori rekap (`compactToolCategory` di tui/transcript.ts) TIDAK memakai
// helper ini: ia menghitung dari NAMA INTERNAL. Fungsi di sini hanya untuk
// tampilan (`line` ledger), jadi safety net Sanitasi + truncasi ada di ujung.
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

/**
 * Locale SISTEM/OS — lazy-cache (baca sekali saat pertama dipakai).
 * `id` bila locale mulai "id", sisanya `en`. Sengaja tak membaca env
 * MINICODE_LANG / state.json / sesi /lang: itu jalur bahasa user, bukan OS.
 */
/** Test-only: paksa hasil deteksi OS agar kedua cabang en/id bisa diuji. */
export function __setSystemLocaleForTest(locale: Locale | null): void {
  cachedSystemLocale = locale
}

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

/**
 * String UI non-narasi (toast/kwitansi/peringatan/kegagalan) memakai bahasa
 * SISTEM/OS — sama seperti label tool, bukan bahasa sesi `/lang`. Narasi/model
 * tetap lewat `t()` di i18n/locale.ts; jalur ini sengaja terpisah (lihat
 * komentar file). Interpolasi `{nama}` identik dengan `t()` supaya pola
 * pemakaiannya mulus. Sengaja tak impor `t()`/`currentLocale()` — selain
 * menghindari siklus, itu akan mengikuti sesi `/lang`.
 */
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

/**
 * Nama tool internal → label manusiawibahasa sistem/OS.
 *
 * `delegate_task` mendapat identitas child (`label` → `summary` → `target`)
 * supaya fan-out sub-agent tetap bisa dibedakan di footer. Semua keluaran
 * disanitasi (nama child tak terpercaya) dan dipotong 40 kolom.
 */
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
