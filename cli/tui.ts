// Driver TUI — komposisi: CliSession + Transcript + TuiApp. Satu-satunya
// tampilan interaktif (tanpa mode).
//
// Peran: TERJEMAHKAN dunia cli/ (budget, skill, mention, mode, clipboard)
// menjadi TuiHost, lalu jalankan App fullscreen. Semua output user-visible
// masuk Transcript (bukan console) — console.log mentah di sini akan menimpa
// frame alt-screen. Satu-satunya console yang tersisa: fallback non-mampu
// (belum start) dan error fatal.
//
// Perilaku khas TUI (kontrak I17-I24):
// - histori prompt = memori sesi (tak persist ke berkas).
// - /clear = kosongkan transkrip (bukan penanda scrollback).
// - /status, /history & /help ringkas = readout ke transkrip (bukan jendela
//   modal) — transkrip fullscreen SUDAH permukaan baca; modal untuk info
//   statis hanya menambah langkah. /model & /provider & /sessions = popup
//   komposit (butuh interaksi pilih).
// - busy = composer hidup; Enter MENYELIPKAN informasi tambahan ke turn aktif
//   (kernel `Session.steer`, dibaca model di batas step berikutnya). Bila turn
//   sudah selesai lebih dulu, baris diantrikan sebagai turn berikutnya; Esc =
//   abort yang juga membuang antrean fallback. Perintah slash butuh idle.
import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { expandMentions } from "../src/app/mentions.ts"
import { budgetStatus } from "../src/policy/usage.ts"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
  provenanceMark,
  verificationMark,
} from "../src/presentation/projection.ts"
import { loadJournal } from "../src/session/journal.ts"
import { collectSessionModifiedFiles } from "../src/session/verification.ts"
import { renderSkill } from "../src/skills/loader.ts"
import { listBackgroundJobs, onBackgroundJobFinished } from "../src/tools/bash.ts"
import {
  clipboardByteLength,
  MAX_CLIPBOARD_BYTES,
  MAX_COPY_TURNS,
  writeClipboardOsc52,
} from "../src/ui/assistant/simple.ts"
import type { UiBus } from "../src/ui/contract.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { loadHistory } from "../src/ui/input/input.ts"
import { renderLogoRows } from "../src/ui/render/logo.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { c, glyphs } from "../src/ui/render/theme.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { canRenderModal, dialogBox, popupBoxWidth } from "../src/ui/screens/dialog.ts"
import { runOutputWindow } from "../src/ui/screens/output-window.ts"
// [Area A · PROMPT 06] State UI milik SESI ini. TUI + printer linier sesi yang
// sama berbagi state (satu instance), sesi lain di proses yang sama tak
// tersentuh. Absen = instance default (fixture tes partial).
import { defaultUiState, type UiSessionState } from "../src/ui/session-state.ts"
import { TuiApp, type TuiHost } from "../src/ui/tui/app.ts"
import {
  buildClosingBlock,
  buildProgressLine,
  buildSessionStamp,
  progressPercent,
  type SessionSummaryInfo,
} from "../src/ui/tui/session-summary.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { displayWorkMode, parseToggleArg, parseWorkModeValue } from "./args.ts"
import {
  BUILTIN_COMMANDS,
  type CommandContext,
  DRIVER_HELP_COMMANDS,
  HELP_GROUPS,
  handleBuiltinCommand,
  type ManualUpdateOutcome,
  persistModelChoice,
  suggestSimilar,
} from "./commands.ts"
import type { CliSession } from "./setup.ts"

// Dua sumbu mode berbagi popup, bukan otoritas.
const PERMISSION_MODES = ["auto", "ask"] as const
const WORK_MODE_CYCLE = ["DISCUSS", "EXECUTE"] as const
// Aksi view yang benar-benar punya efek di renderer flat. compact/minimize/fold
// dihapus: mengubah flag-flag itu tak mengubah satu sel pun di layar (hanya
// menghasilkan kwitansi palsu), jadi jangan ditawarkan lagi di picker /view.
// `/expand` sengaja tak ada lagi: renderer flat tak punya mode expand. Yang
// tersisa, `/view thinking`, mengubah visibilitas reasoning inline di transkrip
// (bukan panel/sidebar terpisah) lewat `tui.thinkingSet`.
const VIEW_ACTIONS = ["thinking"] as const
const DRIVER_COMMANDS = ["/view", "/mode", "/lang", "/clear", "/copy", "/undo", "/redo"]

function fmtCtx(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${(n / 1000000).toFixed(1)}m`
}

/**
 * F-CTX-1: metrik usage footer (biaya + window %) dari angka NYATA, tanpa
 * perkiraan. Kosong = tak ada data relevan (belum belanja / flag window tak
 * disetel) — footer tak pernah menampilkan persentase/biaya palsu.
 *
 * P1.4: persentase footer = OCCUPANCY konteks saat ini (param `used`), bukan
 * total token yang sudah dibelanjakan sepanjang sesi. Memakai spend membuat
 * footer mentok 100% setelah beberapa step meski konteks masih jauh di bawah
 * window. `used` di-inject oleh pemanggil (cache per turn) agar angka
 * O(history) `session.contextTokens` tak dihitung ulang tiap paint.
 */
function fmtUsageMetrics(ctx: CliSession, used: number): string | undefined {
  const cost: number | undefined = ctx.usage.getSession().cost
  // Utamakan getter `contextWindowTokens` bila ada agar `safe-default` (`undefined`)
  // tidak menampilkan % palsu di footer, sambil fallback ke `getContextWindowTokens()`
  // untuk stub/test minimal yang tidak mendefinisikan properti getter tersebut.
  const windowTokens: number | undefined =
    "contextWindowTokens" in ctx ? ctx.contextWindowTokens : ctx.getContextWindowTokens?.()
  const parts: string[] = []
  if (cost !== undefined && Number.isFinite(cost) && cost > 0) parts.push(formatUsd(cost))
  if (
    windowTokens !== undefined &&
    Number.isFinite(windowTokens) &&
    windowTokens > 0 &&
    Number.isFinite(used)
  ) {
    const pct = Math.min(100, Math.round((used / windowTokens) * 100))
    parts.push(`${pct}%`)
  }
  return parts.length ? parts.join(" ") : undefined
}

/**
 * Tangkap console.log/error selama `fn` → baris teks (tanpa warna liar:
 * caller yang mewarnai). Dipakai membungkus handleBuiltinCommand supaya
 * readout warisan (/help, pesan status/undo) mendarat di transkrip,
 * bukan menimpa frame alt-screen. View modal menulis via stdout.write
 * langsung (bukan console) sehingga tak ikut tertangkap — layarnya tetap
 * tampil normal (nested refcount screen.ts). Baris yang sudah tercetak
 * SEBELUM fn melempar tetap dikembalikan via capturedLines (ditempel ke
 * error) — tanpa ini kegagalan di tengah readout (/sync) diam-diam
 * membuang output parsial.
 */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "))
  }
  const flush = () => lines.flatMap((l) => l.split("\n"))
  try {
    await fn()
  } catch (e) {
    ;(e as { capturedLines?: string[] }).capturedLines = flush()
    throw e
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return flush()
}

/**
 * Env teks dari proses induk (rewind) di-decode base64 agar newline/karakter
 * shell tidak rusak. Batas panjang mencegah env raksasa membebani composer.
 */
function decodeEnvText(name: string): string | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  try {
    const text = Buffer.from(raw, "base64").toString("utf8")
    return text.length > 0 && text.length <= 200_000 ? text : undefined
  } catch {
    return undefined
  }
}

// v7.41 — Rekap sub-agent `delegate_task`. Sebelumnya model induk DIAM saat anak
// selesai; sekarang satu prompt rekap ditembakkan hanya saat sebuah turn tuntas
// DAN UI idle. Tool biasa sengaja tak ikut: hitungan per-segment sudah
// mencakupnya. Semua batas (jumlah entri, panjang ringkasan, satu prompt/turn,
// anti-loop) sengaja dipusatkan di helper murni di bawah supaya bisa diuji tanpa
// harness TTY — dan supaya perilaku fail-closed mudah diaudit.
export const CHILD_RECAP_MAX_ENTRIES = 8
export const CHILD_RECAP_SUMMARY_MAX_CHARS = 300

/** Opt-out mirror `MINICODE_AUTORESUME_BG`. Terima env eksplisit supaya murni. */
export function isChildRecapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MINICODE_AUTORESUME_CHILD !== "0"
}

export interface ChildRecapFireInput {
  enabled: boolean
  pendingCount: number
  queuedCount: number
  suspended: boolean
  abortActive: boolean
  aborted: boolean
  inRecapTurn: boolean
}

/**
 * Keputusan murni: bolehkah rekap ditembakkan? Mengumpulkan SEMUA guard di satu
 * tempat. `abortActive`/`aborted` menolak turn yang masih jalan atau dibatalkan;
 * `queuedCount` mendahulukan pesan user; `inRecapTurn` = kunci anti-loop.
 */
export function shouldFireChildRecap(i: ChildRecapFireInput): boolean {
  return (
    i.enabled &&
    i.pendingCount > 0 &&
    i.queuedCount === 0 &&
    !i.suspended &&
    !i.abortActive &&
    !i.aborted &&
    !i.inRecapTurn
  )
}

export interface ChildRecapTracker {
  /** tool.started — hanya `delegate_task` yang id-nya dilacak. */
  noteStarted(toolCallId: string, name: string): void
  /** tool.completed — kembalikan true bila ringkasan benar-benar tersimpan. */
  noteCompleted(toolCallId: string, summary: string): boolean
  /** Bersihkan id saat tool berakhir tanpa summary (failed/denied/cancelled). */
  noteTerminal(toolCallId: string): void
  setEnabled(v: boolean): void
  setInRecapTurn(v: boolean): void
  readonly enabled: boolean
  readonly inRecapTurn: boolean
  readonly pendingCount: number
  /** Ambil SEMUA ringkasan sekaligus lalu kosongkan → satu recap per turn. */
  drain(): string[]
  /** Buang semua ringkasan tanpa dipakai (v7.41: turn induk di-abort). */
  clear(): void
}

/**
 * State collector rekap. TIDak menyimpan referensi ke TUI/ctx — murni, sehingga
 * test bisa menyuap event buatan dan memeriksa hasilnya tanpa tty.
 */
export function createChildRecapTracker(enabled: boolean): ChildRecapTracker {
  const delegateCallIds = new Set<string>()
  const pending: string[] = []
  let isEnabled = enabled
  let isInRecapTurn = false
  return {
    noteStarted(toolCallId, name) {
      if (name === "delegate_task") delegateCallIds.add(toolCallId)
    },
    noteCompleted(toolCallId, summary) {
      // Anti-loop: selama turn recap berjalan, abaikan tool.completed apa pun.
      if (isInRecapTurn) return false
      if (!delegateCallIds.has(toolCallId)) return false
      // Terminal: id dibuang walau recap sedang nonaktif (jangan bocor).
      delegateCallIds.delete(toolCallId)
      if (!isEnabled || pending.length >= CHILD_RECAP_MAX_ENTRIES) return false
      // Teks berasal dari model = input tak terpercaya: buang sekuens kontrol
      // berbahaya (non-SGR, C0/C1, bidi) lewat sanitizer kanonik, lalu potong
      // panjangnya supaya prompt rekap tak membengkak / menyisipkan kontrol.
      const clean = sanitizeAnsiLine(summary ?? "").slice(0, CHILD_RECAP_SUMMARY_MAX_CHARS)
      pending.push(clean)
      return true
    },
    noteTerminal(toolCallId) {
      delegateCallIds.delete(toolCallId)
    },
    setEnabled(v) {
      isEnabled = v
    },
    setInRecapTurn(v) {
      isInRecapTurn = v
    },
    get enabled() {
      return isEnabled
    },
    get inRecapTurn() {
      return isInRecapTurn
    },
    get pendingCount() {
      return pending.length
    },
    drain() {
      return pending.splice(0, pending.length)
    },
    clear() {
      // v7.41 (audit): anak yang di-abort mengirim STRING error lewat
      // `tool.completed`, bukan throw. Bila dibiarkan, entry itu terbawa ke
      // turn bersih berikutnya dan dikutip seolah hasil asli. Buang di sini.
      pending.length = 0
      delegateCallIds.clear()
    },
  }
}

/** Satu prompt rekap (i18n) dari sekumpulan ringkasan hasil drain(). */
export function buildChildRecapPrompt(summaries: readonly string[]): string {
  return t("tui.childRecap", {
    n: String(summaries.length),
    summary: summaries.join(" | "),
  })
}

// ── v7.41 (audit turn-stability #1–#4) ───────────────────────────────────────
// Helper murni di bawah memisahkan KEPUTUSAN dari efek samping supaya auditable
// tanpa harness TTY. Semua state yang bisa bocor antar turn sengaja dikunci di
// satu tempat (turn state guard), bukan disebar di closure.

/**
 * #1/#3: UI dianggap idle untuk aksi otomatis hanya bila TIDAK ada turn aktif,
 * TIDAK ada popup, DAN App tidak busy. `busy` penting untuk jendela @-mention:
 * `expandMentions` di-await SEBELUM `abort = ctrl`, sehingga `app.busy=true`
 * sementara `abort===null` — tanpa ini bg job bisa membuka runTurn kedua.
 * Fail-closed: bila ragu, anggap tidak idle.
 */
export function isTurnIdleForBackground(opts: {
  abortActive: boolean
  suspended: boolean
  busy: boolean
}): boolean {
  return !opts.abortActive && !opts.suspended && !opts.busy
}

/**
 * #4 (batch 3): `TuiApp.isBusy()` bersifat private; panggil lewat cast
 * struktural. Fail-closed: method absen / melempar → anggap sibuk.
 */
export function isAppBusy(app: unknown): boolean {
  try {
    const target = app as { isBusy?: (() => boolean) | undefined } | null
    if (!target || typeof target.isBusy !== "function") return true
    return target.isBusy() === true
  } catch {
    return true
  }
}

/** Job bg yang selesai saat turn aktif, ditunda resumed-nya sampai idle. */
export interface DeferredBgJob {
  id: string
  code: number | null
}

/** #3 (batch 3): antrean job tertunda, bounded agar tak tumbuh tanpa batas. */
export function createDeferredBgJobs(cap = 16) {
  const jobs: DeferredBgJob[] = []
  return {
    defer(job: DeferredBgJob): boolean {
      if (jobs.length >= cap) return false
      jobs.push(job)
      return true
    },
    drain(): DeferredBgJob[] {
      return jobs.splice(0, jobs.length)
    },
    get count(): number {
      return jobs.length
    },
  }
}

/**
 * #3: antrean notifikasi job background. Saat turn aktif, notifikasi DITUNDA
 * (bukan dibuang): `pushInfo` memaksa commit transkrip dan memecah jawaban
 * streaming di tengah code fence. Dikeluarkan lagi di batas turn (idle).
 */
export function createBgNoticeQueue() {
  const pending: string[] = []
  return {
    /** Idle → langsung tampil; sibuk → ditunda, kembalikan `undefined`. */
    offer(text: string, idle: boolean): string | undefined {
      if (idle) return text
      pending.push(text)
      return undefined
    },
    drain(): string[] {
      return pending.splice(0, pending.length)
    },
    get pendingCount(): number {
      return pending.length
    },
  }
}

export interface TurnStateGuard {
  /**
   * Awal runTurnOnce: ambil status "turn ini recap" SEKALIGUS reset flag.
   * Dipanggil SEBELUM early-return budget supaya tak ada jalur keluar yang
   * meninggalkan `abortRequested` menggantung atau recap flag bocor (#2).
   */
  beginTurn(): { isChildRecapTurn: boolean }
  markAbortRequested(): void
  markChildRecapPromptPending(): void
  readonly abortRequested: boolean
  readonly childRecapPromptPending: boolean
}

/** #2: satu pemilik untuk flag lintas-turn yang dulu tersebar di closure. */
export function createTurnStateGuard(): TurnStateGuard {
  let abortRequested = false
  let childRecapPromptPending = false
  return {
    beginTurn() {
      const isChildRecapTurn = childRecapPromptPending
      // Audit #2: reset di SATU titik, sebelum early-return budget. Kalau tidak,
      // abort + budget short-circuit mengunci steering selamanya, dan recap flag
      // yang sudah digeser dari antrean menandai turn user sah berikutnya.
      childRecapPromptPending = false
      abortRequested = false
      return { isChildRecapTurn }
    },
    markAbortRequested() {
      abortRequested = true
    },
    markChildRecapPromptPending() {
      childRecapPromptPending = true
    },
    get abortRequested() {
      return abortRequested
    },
    get childRecapPromptPending() {
      return childRecapPromptPending
    },
  }
}

/**
 * #4: `TuiApp.disarmAbortQuit()` masih `private` di app.ts (di luar ownership
 * file ini), jadi dipanggil lewat cast struktural + optional chaining. Ini
 * memakai logika disarm ASLI (mengosongkan `awaitingSecondEsc` + `lastAbortAt`),
 * bukan meniru state di sini. Fail-closed: stub/fixture tanpa method tak crash.
 */
export function disarmAbortQuitIfAvailable(app: unknown): void {
  try {
    const target = app as { disarmAbortQuit?: (() => void) | undefined } | null
    target?.disarmAbortQuit?.()
  } catch {}
}

/**
 * Batch 2 #2: jumlah tool = panjang array `visible` yang dimutasi in-place oleh
 * setToolWorkMode. Diekspos murni supaya sifat "live" bisa diuji tanpa TTY.
 */
export function liveToolsCount(tools: readonly unknown[]): number {
  return tools.length
}

// ── v7.44 (audit) — progres startup + blok penutup sesi ──────────────────────
// Dua jejak teks ini SENGAJA lewat callback yang disuntikkan, bukan write
// mentah di setup.ts: `onPhase` dipanggil untuk SEMUA entry point (exec,
// daemon, ACP), sedangkan kontrak hanya mengizinkan jejak di launch interaktif
// (`minicode` [enter]). Tanpa callback = perilaku lama, nol byte baru.

/** Urutan 9 fase dari `startupPhase` di cli/setup.ts — sumber persen progres. */
export const STARTUP_PHASE_NAMES = [
  "provider-layer",
  "rag-layer",
  "resume-session",
  "resume-history",
  "resume-projection",
  "resume-select",
  "resume-workspace",
  "tool-layer",
  "kernel-session",
] as const

export interface StartupProgress {
  readonly enabled: boolean
  /** Dipasang sebagai `opts.onPhase` pada `createCliSession` jalur interaktif. */
  readonly onPhase: (phase: string) => void
  /** Tulis 100% + newline sekali, lalu lepas handle. Aman dipanggil berulang. */
  readonly finish: () => void
}

// Handle terakhir dipakai `runTui` untuk menutup bar bila pemanggil lupa
// memanggil `finish()` (createCliSession resolve → runTui mulai). Satu proses
// interaktif = satu sesi, jadi ini bukan singleton lintas-sesi.
let activeStartupProgress: StartupProgress | null = null

/**
 * Pabrik callback progres. Satu update = SATU write ke stderr:
 * `start 11%\r`, lalu `start 22%\r`, … — hanya angka yang berubah, area
 * sekitarnya tetap bersih (tanpa logo/kalimat/frame). `\r` di AKHIR baris
 * mengembalikan kursor ke kolom 0 supaya update berikutnya menimpa baris yang
 * sama ( kontrak TERMINAL_CONTRACT: satu baris, angka saja yang berubah).
 *
 * `MINICODE_STARTUP_PROGRESS=0` mematikan total — nol byte, bukan baris
 * kosong. Prefix `update` dipilih bila operator sedang resume/update.
 */
export function createStartupProgress(opts?: {
  readonly prefix?: "start" | "update"
  readonly resume?: boolean
  readonly write?: (s: string) => void
  readonly env?: NodeJS.ProcessEnv
}): StartupProgress {
  const env = opts?.env ?? process.env
  if (env.MINICODE_STARTUP_PROGRESS === "0") {
    return { enabled: false, onPhase: () => {}, finish: () => {} }
  }
  const prefix = opts?.prefix ?? (opts?.resume === true ? "update" : "start")
  // stderr, bukan stdout: stdout dipakai TUI/alat dan harus tetap murni.
  const write = opts?.write ?? ((s: string) => process.stderr.write(s))
  let finished = false
  const progress: StartupProgress = {
    enabled: true,
    onPhase(phase) {
      if (finished) return
      const idx = STARTUP_PHASE_NAMES.indexOf(phase as (typeof STARTUP_PHASE_NAMES)[number])
      if (idx < 0) return
      // Fase terakhir tak ditulis di sini: 100% + newline adalah milik
      // finish() (satu write, penutup baris). Tanpa ini angka 100% muncul
      // dua kali berturut-turut.
      if (idx === STARTUP_PHASE_NAMES.length - 1) return
      const pct = progressPercent(idx + 1, STARTUP_PHASE_NAMES.length)
      write(`${buildProgressLine(prefix, pct)}\r`)
    },
    finish() {
      if (finished) return
      finished = true
      if (activeStartupProgress === progress) activeStartupProgress = null
      write(`${buildProgressLine(prefix, 100)}\n`)
    },
  }
  activeStartupProgress = progress
  return progress
}

// Kategori ringkas tool — SALINAN sengaja dari `src/ui/tui/transcript.ts`
// (helper di sana tidak diekspor). Memakai daftar yang sama mencegah angka
// "other" di blok penutup berbeda dari ringkasan yang dilihat user di TUI.
const SUMMARY_COMMAND_TOOLS = new Set([
  "bash",
  "bash_output",
  "bash_kill",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_push",
])
const SUMMARY_EDIT_TOOLS = new Set([
  "write_file",
  "edit",
  "apply_patch",
  "delete_file",
  "move_file",
  "lsp_rename",
])
const SUMMARY_READ_TOOLS = new Set(["read_file", "read_image", "grep", "glob", "ls", "stat"])
const SUMMARY_SUBAGENT_TOOLS = new Set(["delegate_task"])
const SUMMARY_THOUGHT_TOOLS = new Set(["reasoning"])

function summaryToolCategory(name: string): string {
  if (SUMMARY_COMMAND_TOOLS.has(name) || name.startsWith("git_")) return "command"
  if (SUMMARY_EDIT_TOOLS.has(name)) return "edit"
  if (SUMMARY_READ_TOOLS.has(name)) return "read"
  if (SUMMARY_SUBAGENT_TOOLS.has(name)) return "subagent"
  if (SUMMARY_THOUGHT_TOOLS.has(name)) return "thought"
  return "other"
}

/** Versi dibaca dari package.json — satu sumber, jangan di-hardcode. */
function readTuiVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url)
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return pkg.version ?? "?"
  } catch {
    return "?"
  }
}

/**
 * F-01/F-05: accessor ringan untuk token konteks. `session.state` adalah
 * `snapshotState` = deep clone SELURUH riwayat — dibaca HANYA SEKALI di sini
 * (saat setup). Setelah itu counter turn dipakai sebagai kunci cache dan
 * diperbarui dari event turn, sehingga `getContextTokens()`/`getStatus()` tidak
 * pernah menyentuh `session.state` lagi (termasuk pada ketikan idle).
 *
 * `session.contextTokens` (getter angka murah) dibaca HANYA saat cache miss —
 * satu kali per turn, bukan dua kali per paint.
 */
export interface ContextTokenSession {
  /** Snapshot penuh. Dipakai sekali untuk inisialisasi counter, lalu ditinggalkan. */
  readonly state?: { readonly turnCount?: number } | undefined
  /** Getter angka murah (tanpa snapshot history). */
  readonly contextTokens: number
}

/** Bus minimal yang dibutuhkan tracker (struktural, cocok dengan UiBus/EventBus). */
export interface ContextTokenBus {
  on(type: string, handler: (event: any) => void): () => void
}

export interface ContextTokenTracker {
  getContextTokens(): number
  getTurnCount(): number
  /** Buang angka live saat turn gagal/abort tanpa `turn:interrupted` dari kernel. */
  invalidate(): void
  dispose(): void
}

export function createContextTokenTracker(
  session: ContextTokenSession,
  bus: ContextTokenBus,
): ContextTokenTracker {
  // Inisialisasi SATU-SATUNYA pembacaan `session.state` (deep clone sekali).
  // Fixture test parsial boleh tanpa `state` → counter mulai dari 0.
  let turnCount = 0
  try {
    turnCount = session.state?.turnCount ?? 0
  } catch {}

  let cachedContext: { turn: number; tokens: number } | null = null
  let liveContextTokens: number | undefined
  const unsubs: Array<() => void> = []

  const subscribe = (name: string, handler: (event: any) => void): void => {
    try {
      const off = bus.on(name, handler)
      if (typeof off === "function") unsubs.push(off)
    } catch {}
  }
  const resetCache = (): void => {
    liveContextTokens = undefined
    cachedContext = null
  }

  // Nilai per-step dari kernel; O(1) dan menang saat turn berjalan.
  subscribe("provider:extension", (event: any) => {
    if (event?.forwardedChild != null) return
    if (event?.kind !== "context-window") return
    const data = event.data as { usedTokens?: unknown } | undefined
    if (typeof data?.usedTokens === "number") liveContextTokens = data.usedTokens
  })

  subscribe("turn:started", (event: any) => {
    // Kernel meng-emit turn SEBELUM increment: `turn = state.turnCount;
    // emit(turn); state.turnCount++` (loop.ts). Jadi turnCount baru = turn + 1.
    // `Math.max` menjaga counter tak mundur bila event duplikat/warisan tiba.
    turnCount =
      typeof event?.turn === "number" ? Math.max(turnCount, event.turn + 1) : turnCount + 1
    resetCache()
  })
  for (const name of ["turn:completed", "turn:interrupted", "context:compacted"]) {
    subscribe(name, () => resetCache())
  }

  return {
    getContextTokens(): number {
      // Urutan penting: live → counter LOKAL → cache → session.contextTokens
      // (hanya saat miss). TIDAK ada `session.state` di jalur ini.
      if (liveContextTokens !== undefined) return liveContextTokens
      if (!cachedContext || cachedContext.turn !== turnCount) {
        cachedContext = { turn: turnCount, tokens: session.contextTokens }
      }
      return cachedContext.tokens
    },
    getTurnCount: () => turnCount,
    invalidate: resetCache,
    dispose() {
      for (const off of unsubs.splice(0)) {
        try {
          off()
        } catch {}
      }
    },
  }
}

/**
 * Kumpulkan statistik secara read-only & fail-jujur: data yang tak tersedia
 * jadi 0 / `$—`, bukan angka rekaan. Ditulis SETelah alt-screen ditutup dan
 * `close()` selesai supaya blok persisten & bisa disalin dari scrollback.
 */
async function writeSessionSummary(
  ctx: CliSession,
  startedAt: number,
  write: (s: string) => void,
  extra: { model?: string; mode?: string; turns?: number } = {},
): Promise<void> {
  if (process.env.MINICODE_SESSION_SUMMARY === "0") return
  let turns = 0
  let tools = 0
  let other = 0
  let files = 0
  let tokens = 0
  let cost: number | null = null
  let toolBreakdown = ""
  let agents = 0
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  // F-01: counter diambil dari tracker (sudah diinisialisasi sekali), bukan
  // dari `ctx.session.state` yang melakukan deep clone riwayat penuh.
  turns = extra.turns ?? 0
  try {
    const activities = ctx.getPresentationSnapshot?.().activities ?? []
    tools = activities.length
    for (const a of activities) {
      if (summaryToolCategory(a.name) === "other") other++
    }
    // v0.33 (audit closing block): snapshot activities SUDAH dikosongkan saat
    // turn ditutup → `0 tool` walau sesi memanggil tool. Jurnal adalah sumber
    // kumulatif yang tahan ditutupnya turn.
    const root = ctx.cwd ?? process.cwd()
    const journal = await loadJournal(ctx.sessionId, root).catch(() => null)
    if (journal?.status === "valid") {
      const records = journal.records.filter(
        (r) => r.state === "committed" && r.kind !== "finalize" && !!r.tool,
      )
      const byCategory = new Map<string, number>()
      const childIds = new Set<string>()
      for (const r of records) {
        const cat = summaryToolCategory(r.tool)
        if (cat === "other") other++
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1)
        if (r.childSessionId) childIds.add(r.childSessionId)
      }
      agents = childIds.size
      toolBreakdown = [...byCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([cat, n]) => `${n} ${cat}`)
        .join(" · ")
      tools = Math.max(tools, records.length)
    }
  } catch {}
  try {
    files = (await collectSessionModifiedFiles(ctx.sessionId, ctx.cwd ?? process.cwd())).length
  } catch {}
  try {
    const u = ctx.usage.getSession()
    tokens = u.totalTokens ?? 0
    cost = u.cost ?? null
    inputTokens = u.inputTokens
    outputTokens = u.outputTokens
  } catch {}
  const info: SessionSummaryInfo = {
    stamp: buildSessionStamp(new Date()),
    turns,
    tools,
    files,
    other,
    tokens,
    cost,
    duration: Date.now() - startedAt,
    version: readTuiVersion(),
    model: extra.model,
    mode: extra.mode,
    ...(toolBreakdown ? { toolBreakdown } : {}),
    ...(agents > 0 ? { agents } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
  }
  // v0.33: setelah `?1049l`, kursor bisa kembali ke HOME (kasus conhost /
  // Windows PowerShell 5.1) sehingga blok ini menimpa banner & prompt shell.
  // Pindah ke baris TERAKHIR dulu (9999 di-clamp terminal), lalu baris baru.
  const SEEK_END = "\x1b[9999;1H"
  write(`${SEEK_END}\r\n${buildClosingBlock(renderLogoRows(), info).join("\n")}\n`)
}

export async function runTui(ctx: CliSession, progress?: StartupProgress): Promise<void> {
  // createCliSession sudah resolve sebelum runTui dipanggil → tutup bar di sini
  // (juga menutup bila pemanggil lupa memanggil `finish()` secara eksplisit).
  const pendingProgress = progress ?? activeStartupProgress
  pendingProgress?.finish()
  const startedAt = Date.now()
  let tuiStarted = false
  const {
    cfg,
    cwd,
    sessionId,
    modelRef,
    permissionMode,
    permissions,
    workModeControl,
    sessionTools,
    allLoadedSkills,
    allowLocalConfig,
    usage,
    budget,
    budgetStrict,
    persistCurrent,
    runPromptWithVerify,
    close,
    productionScheduler,
    schedulerObservability,
  } = ctx
  const { session } = ctx
  // [Area A · PROMPT 06] State UI sesi. `runTui` juga dijalankan fixture tes
  // dengan CliSession parsial — absen berarti pakai instance default (dipakai
  // tes yang memasangkan logger linier + TUI pada state yang sama).
  const ui: UiSessionState = ctx.uiState ?? defaultUiState
  const getPresentationSnapshot = () =>
    typeof ctx.getPresentationSnapshot === "function"
      ? ctx.getPresentationSnapshot()
      : { activities: [], turns: [] }

  // [Fase 2] Panel aktivitas default ON di TUI (thinking + grup tool).
  // Env MINICODE_ACTIVITY_PANEL=0 (opt-out eksplisit) / /fold mematikannya.
  // Guard `ctx.uiState`: produksi SELALU mengoper state sesi (cli/setup.ts);
  // fixture tes tanpa uiState memakai singleton `defaultUiState` — jangan
  // dimutasi dari sini (bocor antar berkas tes).
  if (ctx.uiState && process.env.MINICODE_ACTIVITY_PANEL !== "0") ui.setActivityPanel(true)

  let mode: string = permissions?.getMode() ?? permissionMode ?? "auto"
  // Satu sumber kebenaran mode permission: kontrol runtime bila tersedia, baru
  // snapshot boot. /status dan footer WAJIB lewat helper yang sama — sebelumnya
  // /status memakai live control sementara footer memakai `mode` basi, sehingga
  // label keduanya bisa berbeda setelah Shift+Tab.
  const livePermissionMode = (): string => permissions?.getMode() ?? mode
  // Mode permission sebelum /unrestric diaktifkan — dipakai untuk memulihkan
  // saat operator menonaktifkannya kembali (toggle, per-sesi).
  let modeBeforeUnrestricted: string | null = null
  let workModeBeforeUnrestricted: "DISCUSS" | "EXECUTE" | null = null
  if (process.env.MINICODE_COMPACT === undefined) ui.setCompactMode(true)
  if (process.env.MINICODE_MINIMIZE_TOOL === undefined) ui.setSectionMinimized("tool", true)
  // Grouping aktivitas tool jadi satu baris (opencode-like): default ON di TUI;
  // `MINICODE_MINIMIZE_ACTIVITY=0` eksplisit mematikan (transparan). Hanya
  // disetel pada instance MILIK SESI (ctx.uiState ada) — bukan singleton default
  // (dipakai path tes) agar nilai tidak bocor antar tes.
  if (ctx.uiState !== undefined && process.env.MINICODE_MINIMIZE_ACTIVITY === undefined)
    ui.setMinimizeActivity(true)
  let warned80 = false
  let abort: AbortController | null = null
  // Abort membatalkan NIAT: sampai user benar-benar mengirim prompt BARU,
  // jalur antrean (steering fallback) harus menolak baris. Tanpa ini, Enter
  // yang masuk di celah antara unwind abort dan submit berikutnya mengisi
  // `queuedPrompts` lagi lalu dijalankan `runTurn` sebagai turn hantu (M2).
  // v7.41 (audit #2): flag ini + flag recap punya SATU pemilik (TurnStateGuard)
  // yang di-reset di awal runTurnOnce, termasuk sebelum early-return budget.
  const turnState = createTurnStateGuard()
  // Antrean FALLBACK untuk informasi tambahan: hanya dipakai bila kernel
  // menolak steering (turn sudah selesai lebih dulu — race antara submit dan
  // akhir turn). Pesannya lalu dikirim sebagai turn penuh berikutnya supaya
  // tidak hilang. Jalur utama tetap `Session.steer` di `host.enqueue`.
  // v7.41 (audit F1): `needsEcho` menandai baris user yang gema transkripnya
  // DITUNDA sampai benar-benar dikonsumsi runTurn. Baris yang dibuang saat
  // abort tak pernah digema → tak ada prompt hantu di transkrip.
  const queuedPrompts: { text: string; needsEcho: boolean }[] = []
  // Baris yang berhasil di-steer digema SEGERA (posisi kronologis benar), tapi
  // dicatat untuk notifikasi pembatalan bila turn di-abort sebelum kernel
  // menerapkannya. Dibersihkan di awal tiap turn.
  const steeredEchoes: string[] = []
  /** Job background hidup (badge footer). Dihitung dari registry tool bash. */
  const countLiveBackgroundJobs = (): number =>
    listBackgroundJobs().reduce((n, j) => (j.done ? n : n + 1), 0)

  // F-01/F-05: `session.state` adalah deep clone penuh riwayat. Tracker
  // mengambilnya SEKALI saat setup, lalu memakai counter turn dari event dan
  // cache per turn. `getContextTokens()` (dipakai 2× oleh getStatus per paint)
  // kini tidak pernah menyentuh snapshot history — termasuk saat idle/mengetik.
  const contextTokens = createContextTokenTracker(
    session as unknown as ContextTokenSession,
    session.events as unknown as ContextTokenBus,
  )
  const getContextTokens = contextTokens.getContextTokens

  // Bahasa UI: state.json (sesi bisa menimpa via /lang). Gagal baca = default.
  const { setConfigLocale } = await import("../src/ui/i18n/locale.ts")
  try {
    const { loadLang } = await import("../src/config.ts")
    setConfigLocale((await loadLang().catch(() => undefined)) ?? null)
  } catch {}

  // Kebijakan proyeksi kanonik di-inject di sini (batas lapisan: src/ui
  // tidak boleh impor src/presentation).
  const transcript = new Transcript(session.events as unknown as UiBus, {
    getSnapshot: getPresentationSnapshot,
    onPresentationEvent: ctx.onPresentationEvent,
    // [Area A · PROMPT 06] State sesi yang sama dengan printer linier.
    uiState: ui,
    policy: {
      describeActivity,
      matchTurn: matchTurnBySummary,
      elapsedVisible,
      verificationMark,
      provenanceMark,
    },
  })

  // [resume] Rebuild riwayat transkrip dari event presentasi durable. Hanya sesi
  // yang BENAR-BENAR di-resume (turnCount > 0) yang punya histori — `--session
  // <id>` reuse tanpa `--resume` tak boleh menampilkan riwayat lama. Sesi baru
  // (tanpa event) = no-op. Tak double-render: replay memproses event LAMA,
  // turn live baru menyusul dengan event baru.
  // Baris diagnostik startup yang didefer (resume/recovery/context/dll)
  // di-flush ke transcript SEBELUM replay agar urutan kronologisnya benar
  // (diagnostik dulu, lalu riwayat sesi).
  if (ctx.startupNotices?.length) {
    transcript.pushInfo(ctx.startupNotices)
  }
  try {
    // Pakai counter dari tracker (sudah diinisialisasi dari session.state sekali).
    if (contextTokens.getTurnCount() > 0) {
      const { loadPresentationEvents } = await import("../src/session/persistence.ts")
      const { toPresentationEvent } = await import("./setup.ts")
      const durable = await loadPresentationEvents(sessionId, cwd)
      if (durable.length > 0) {
        const events = durable
          .map((e) => toPresentationEvent(e))
          .filter((e): e is import("../src/ui/contract.ts").UiPresentationEvent => e !== null)
        transcript.replayHistory(events)
      }
    }
  } catch {
    // Replay best-effort: gagal membaca histori bukan alasan membatalkan TUI.
  }

  const commandCtx: CommandContext = {
    cwd,
    sessionId,
    allowLocalConfig,
    // [P1 Hygiene F1b] Mode runtime sesi ini — diteruskan ke proses popup-resume
    // agar owned/constructed tidak turun diam-diam menjadi off.
    runtimeMode: ctx.runtimeMode,
    // [PHASE 6AB] THE operator control surface. `/scheduler` is the single
    // production-reachable path to `fire()` and to `stop()`; 6AA proved nothing
    // else could reach either. Both objects belong to THIS session, so the command
    // cannot address another session's Scheduler (section 12).
    //
    // Omitted entirely when absent, so the command reports "unavailable" - a
    // different and more honest answer than "off".
    ...(productionScheduler && schedulerObservability
      ? {
          scheduler: {
            handle: productionScheduler,
            observability: schedulerObservability,
          },
        }
      : {}),
    get currentModel() {
      if (modelRef.current) return modelRef.current
      const first = cfg.providers[0]
      const m = first?.models[0]
      return first && m ? `${first.id}::${m}` : m
    },
    set currentModel(v) {
      modelRef.current = v
    },
    usage,
    skills: allLoadedSkills,
    // CMD-07: `sessionTools` BUKAN snapshot boot — itu array `visible` milik
    // setupToolLayer yang dimutasi IN-PLACE oleh setToolWorkMode/setPermission
    // Mode (lihat setup.ts onWorkMode → workModeControl.setWorkMode). Karena
    // identitas array-nya sama, getter ini membaca jumlah tool live setelah
    // Shift+Tab DISCUSS ↔ BUILD. Jangan diganti `slice()`/snapshot: itu yang
    // akan membuat /status basi seperti yang dulu dituduhkan audit.
    get toolsCount() {
      return liveToolsCount(sessionTools)
    },
    // P1.2: dua dimensi selalu terbaca live di /status — bukan snapshot boot.
    // [mode-architecture] /status memakai nilai PRODUK (BUILD/AUTO/ASK).
    get workMode() {
      return displayWorkMode(workModeControl?.getWorkMode() ?? "DISCUSS")
    },
    get permissionMode() {
      return livePermissionMode().toUpperCase()
    },
    get providerHint() {
      const cur = modelRef.current
      const pid = cur?.includes("::") ? cur.slice(0, cur.indexOf("::")) : undefined
      return (
        (pid ? cfg.providers.find((p) => p.id === pid)?.providerHint : undefined) ??
        cfg.providers[0]?.providerHint
      )
    },
    setModelOverride: (m) => persistModelChoice(m, modelRef),
    // Spawn anak stdio-inherit (/sessions <id>): keluar alt-screen + cooked
    // mode DULU dan tutup lease sesi induk agar anak tidak ditolak WRITER_REFUSED.
    onBeforeSpawn: async () => {
      app.releaseTerminal()
      await close().catch(() => {})
    },
    // v7.32: shell interaktif via handoff aman (sudah teruji untuk /sessions).
    // Keluar alt-screen + cooked mode → shell asli menguasai terminal (vim,
    // htop, warna, resize semua jalan) → re-acquire TUI saat shell selesai.
    withShell: async (cmd: string) => {
      const { spawn } = await import("node:child_process")
      const { waitChildExit } = await import("./auto-update.ts")
      const shell =
        process.platform === "win32"
          ? (process.env.COMSPEC ?? "cmd.exe")
          : (process.env.SHELL ?? "/bin/sh")
      const shellArgs =
        process.platform === "win32"
          ? ["/K", ...(cmd.trim() ? [cmd.trim()] : [])]
          : ["-c", cmd.trim() || 'exec "$SHELL"']
      app.releaseTerminal()
      let code: number | null = null
      try {
        const child = spawn(shell, shellArgs, {
          stdio: "inherit",
          cwd: cwd ?? process.cwd(),
          env: process.env,
        })
        code = await waitChildExit(child)
      } finally {
        process.stdin.resume()
        // reacquireTerminal() sudah memasang listener + repaint; resume() di sini
        // akan menaikkan suspend counter secara tidak seimbang — jangan dipanggil.
        if (!app.reacquireTerminal()) app.requestQuit()
      }
      if (code !== 0 && code != null) throw new Error(`shell exited with code ${code}`)
    },
    // /update — handoff aman meniru withShell, tapi API A TIDAK merestart:
    // pemanggil yang spawn anak + process.exit. Lepas terminal SEBELUM cek/
    // install (npm bisa lama; TUI yang masih memegang raw mode = terlihat hang).
    withUpdate: async () => {
      const { runManualUpdate } = await import("../src/policy/update-check.ts")
      const { waitChildExit } = await import("./auto-update.ts")
      const { spawn } = await import("node:child_process")
      // Toast progres = status UI (locale OS via tSystem), bukan giliran bicara.
      // showToast mengabaikan repaint saat suspended/released, aman di sini.
      const onPhase = (phase: "check" | "install" | "verify"): void => {
        if (phase === "check") app.showToast(tSystem("cmd.updateChecking"))
        else if (phase === "install") app.showToast(tSystem("cmd.updateInstalling"))
      }
      app.releaseTerminal()
      let result: ManualUpdateOutcome
      try {
        result = await runManualUpdate({ onPhase })
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      if (result.ok && result.latest) {
        // Sukses & ada versi baru: restart ke kode terpasang dengan guard env
        // anti-loop. stdio inherit + tunggu anak sebelum induk keluar.
        const entry = process.argv[1] ?? resolvePath(import.meta.dir, "index.ts")
        const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
          stdio: "inherit",
          env: { ...process.env, MINICODE_AUTO_UPDATE_DONE: "1" },
        })
        const code = await waitChildExit(child)
        process.exit(code ?? 0)
      }
      // alreadyLatest / opt-out / gagal: tidak ada anak → hidupkan TUI. Hasil
      // ditampilkan handler /update lewat jendela output (lihat submit).
      process.stdin.resume()
      if (!app.reacquireTerminal()) app.requestQuit()
      return result
    },
    getContextTokens: () => session.contextTokens,
    budgetState: () => {
      const u = usage.getSession()
      return budgetStatus(budget, u.cost, budgetStrict ?? false, u.totalTokens)
    },
  }

  const suggestions = (line: string): string[] => {
    if (!line.startsWith("/")) return []
    const all = [
      ...BUILTIN_COMMANDS.map((b) => `/${b.name}`),
      ...DRIVER_COMMANDS,
      ...allLoadedSkills.map((s) => `/${s.name}`),
    ]
    return all.filter((t) => t.startsWith(line))
  }

  // Tab: cycle WorkMode (DISCUSS ↔ BUILD). Hanya command ini
  // (beserta /work-mode) yang menggeser operating mode — TIDAK permission mode.
  const cycleWorkMode = (dir: 1 | -1): void => {
    if (!workModeControl) return // policy terinjeksi = tanpa kontrol (fail-closed)
    const current = workModeControl.getWorkMode() ?? "DISCUSS"
    const idx = (WORK_MODE_CYCLE as readonly string[]).indexOf(current)
    if (idx === -1) return
    const next = WORK_MODE_CYCLE[(idx + dir + WORK_MODE_CYCLE.length) % WORK_MODE_CYCLE.length]!
    workModeControl.setWorkMode(next)
  }

  const clearUnrestrictedBackup = (wasUnrestricted: boolean): void => {
    if (!wasUnrestricted) return
    if (workModeBeforeUnrestricted) workModeControl?.setWorkMode(workModeBeforeUnrestricted)
    modeBeforeUnrestricted = null
    workModeBeforeUnrestricted = null
  }

  // Shift+Tab: toggle PermissionMode (AUTO ↔ ASK); pulihkan WorkMode bila keluar unrestricted.
  const togglePermissionMode = (): void => {
    if (!permissions) return
    const wasUnrestricted = mode === "unrestricted"
    const next = permissions.getMode() === "ask" ? "auto" : "ask"
    permissions.setMode(next)
    mode = next
    clearUnrestrictedBackup(wasUnrestricted)
  }

  function setPermissionAxis(next: (typeof PERMISSION_MODES)[number]): void {
    permissions?.setMode(next)
    mode = next
    // Perubahan izin eksplisit tidak boleh menggeser sumbu kerja.
    modeBeforeUnrestricted = null
    workModeBeforeUnrestricted = null
  }

  async function modePopup(): Promise<void> {
    const { openAltScreen } = await import("../src/ui/runtime/screen.ts")
    const { runForm } = await import("../src/ui/screens/form.ts")
    app.suspend()
    const screen = openAltScreen()
    try {
      if (!screen.ok || !canRenderModal(screen.cols, screen.rows)) {
        transcript.pushInfo([c.muted(t("gate.tuiPicker", { title: t("tui.modeTitle") }))])
        return
      }
      const work = displayWorkMode(workModeControl?.getWorkMode() ?? "DISCUSS")
      const permission = mode === "ask" ? "Ask" : "Auto"
      const result = await runForm(
        {
          title: t("tui.modeTitle"),
          fields: [
            {
              id: "work",
              label: t("tui.modeWork"),
              kind: "select",
              options: ["Discuss", "Build"],
              initial: work === "BUILD" ? 1 : 0,
              validate: (value) =>
                !workModeControl && value.toUpperCase() !== work
                  ? t("tui.workModeUnavailable")
                  : null,
            },
            {
              id: "permission",
              label: t("tui.modePermission"),
              kind: "select",
              options: ["Auto", "Ask"],
              initial: permission === "Ask" ? 1 : 0,
              validate: (value) =>
                !permissions && value !== permission ? t("tui.permissionUnavailable") : null,
            },
          ],
        },
        screen,
      )
      if (result.cancelled || !result.values) return
      const nextWork = parseWorkModeValue(result.values.work ?? "")
      if (nextWork && displayWorkMode(nextWork) !== work) workModeControl?.setWorkMode(nextWork)
      if (result.values.permission !== permission) {
        setPermissionAxis(
          result.values.permission?.toLowerCase() as (typeof PERMISSION_MODES)[number],
        )
      }
    } finally {
      screen.clearRegion()
      screen.close()
      app.resume()
    }
  }

  async function runBuiltin(
    q: string,
    recordOutput = true,
  ): Promise<{ lines: string[]; shouldExit: boolean; handled: boolean }> {
    let shouldExit = false
    let handled = false
    let lines: string[] = []
    try {
      lines = await captureConsole(async () => {
        const r = await handleBuiltinCommand(q, commandCtx)
        shouldExit = !!r.shouldExit
        handled = r.handled
      })
    } catch (e) {
      // Baris parsial yang sempat tercetak sebelum throw tetap tampil —
      // tanpa ini hanya pesan error generik yang keluar (data-loss diam).
      lines = (e as { capturedLines?: string[] }).capturedLines ?? []
      if (recordOutput && lines.length) transcript.pushInfo(lines)
      throw e
    }
    return { lines, shouldExit, handled }
  }

  /** Judul jendela hasil command — satu sumber untuk semua readout. */
  function commandWindowTitle(q: string): string {
    const name = (q.trim().split(/\s+/)[0] ?? "").replace(/^\/+/, "").toLowerCase()
    switch (name) {
      case "help":
        return t("out.titleHelp")
      case "status":
      case "cost":
      case "usage":
        return t("out.titleStatus")
      case "context":
        return t("ctx.title")
      case "history":
        return t("out.titleHistory")
      case "sync":
        return t("out.titleSync")
      case "init":
        return t("out.titleInit")
      case "update":
        return t("out.titleUpdate")
      case "scheduler":
        return t("sched.title")
      case "sessions":
        return q.trim().split(/\s+/)[1]?.toLowerCase() === "branches"
          ? t("sess.branchesTitle")
          : t("sess.title")
      case "resume":
        return t("sess.title")
      case "model":
      case "models":
        return t("out.titleModels")
      case "provider":
      case "providers":
        return t("out.titleProviders")
      default:
        return t("out.titleCommand")
    }
  }

  /**
   * Output command readout tampil sebagai JENDELA di atas chat, bukan dicetak
   * ke transkrip. Bila layar tak mampu, fallback ke transkrip agar data tidak
   * hilang. App dibekukan selama jendela hidup (pola popupBuiltin).
   */
  async function showCommandOutput(title: string, lines: string[]): Promise<boolean> {
    if (!lines.length) return true
    app.suspend()
    let opened = false
    try {
      opened = await runOutputWindow({
        title,
        lines,
        onCopy: (text) => writeClipboardOsc52(text),
      })
    } catch {
      opened = false
    } finally {
      app.resume()
    }
    if (!opened) transcript.pushInfo(lines)
    return opened
  }

  async function delegateBuiltin(q: string, recordOutput = true): Promise<{ quit?: boolean }> {
    const { lines, shouldExit } = await runBuiltin(q, recordOutput)
    if (recordOutput && lines.length) {
      await showCommandOutput(commandWindowTitle(q), lines)
    }
    return shouldExit ? { quit: true } : {}
  }

  /**
   * Builtin yang membuka popup: bekukan App (input dilepas + layar redup),
   * view melukis regionnya sendiri, App repaint saat kembali. Tanpa ini
   * byte masuk ke dua tempat (App + popup) dan frame App menimpa popup.
   * Hasil pemilihan provider/model terlihat di footer dan daftar saat dibuka
   * kembali; transkrip tidak mengarsipkan pilihan UI yang sudah selesai.
   */
  async function popupBuiltin(q: string): Promise<{ quit?: boolean }> {
    let lines: string[] = []
    let shouldExit = false
    app.suspend()
    try {
      const res = await runBuiltin(q, true)
      lines = res.lines
      shouldExit = res.shouldExit
    } catch (e) {
      // Spawn anak gagal (terminal sudah dilepas onBeforeSpawn): hidupkan
      // kembali atau keluar bersih — jangan biarkan TUI mati tanpa layar.
      if (!app.reacquireTerminal()) app.requestQuit()
      throw e
    } finally {
      app.resume()
    }
    const clean = lines.filter((l) => l.trim().length > 0)
    if (clean.length > 0) {
      if (clean.length <= 3) transcript.pushInfo(clean)
      else await showCommandOutput(commandWindowTitle(q), lines)
    }
    return shouldExit ? { quit: true } : {}
  }

  /**
   * Satu turn tuntas (prompt → persist). Antrean dikuras oleh `runTurn`.
   */
  async function runTurnOnce(prompt: string): Promise<void> {
    const spent = usage.getSession(modelRef.current)
    const preStatus = budgetStatus(budget, spent.cost, budgetStrict ?? false, spent.totalTokens)

    // v7.41 (audit #2): GUARD TUNGGAL — dieksekusi SEBELUM early-return budget.
    // Tanpa ini, abort + budget short-circuit meninggalkan abortRequested=true
    // (steering mati selamanya) dan childRecapPromptPending=true (turn user sah
    // berikutnya salah terflag sebagai turn recap).
    const { isChildRecapTurn } = turnState.beginTurn()
    // v7.41 (audit F1): catatan gema steered milik turn lama tak boleh ikut
    // dihitung sebagai "dibuang" saat turn ini di-abort.
    steeredEchoes.length = 0

    if (preStatus === "over" && spent.cost != null && budget != null) {
      transcript.pushError(
        t("tui.budgetOver", { spent: formatUsd(spent.cost), budget: formatUsd(budget) }),
      )
      return
    }
    if (preStatus === "unknown-strict") {
      transcript.pushError(tSystem("tui.budgetUnknown", { tokens: spent.totalTokens }))
      return
    }
    let finalPrompt = prompt
    if (prompt.includes("@")) {
      const expanded = await expandMentions(prompt, cwd ?? process.cwd())
      finalPrompt = expanded.prompt
      if (expanded.notes.length)
        transcript.pushInfo(expanded.notes.map((n) => c.muted(`  [@mention] ${n}`)))
    }
    const ctrl = new AbortController()
    abort = ctrl
    // v7.41: turn yang mengonsumsi prompt rekap ditandai supaya tool.completed
    // di dalamnya tak mengumpulkan rekap lanjutan (anti-loop). Jendela "Esc lagi
    // = quit" juga dimatikan (audit #4): recap dipicu otomatis, bukan lewat
    // doSubmit yang biasanya melakukan disarm itu.
    if (isChildRecapTurn) {
      childRecap.setInRecapTurn(true)
      disarmAbortQuitIfAvailable(app)
    }
    // Outer try/finally (audit #1): `abort` BARU dilepas setelah SELURUH
    // runTurnOnce — termasuk persistCurrent & batas fire — selesai. Selama
    // jendela itu abort non-null sehingga onBackgroundJobFinished tak bisa
    // membuka runTurn kedua yang menguras antrean/flag yang sama.
    try {
      try {
        await runPromptWithVerify(finalPrompt, ctrl.signal)
        // v7.30: kwitansi abort/antrean/budget = status UI, bukan giliran bicara.
        if (ctrl.signal.aborted) app.showToast(tSystem("tui.stopped"))
      } catch (error) {
        // v7.31: abort user melempar `AgentError(aborted)` dari decideTurnResume.
        // Tanpa penanganan di sini, rejection sampai ke doSubmit.catch yang
        // menulis error permanen ke transkrip — dan toast "stopped" di atas tak
        // pernah tercapai. Abort = status UI, bukan giliran bicara.
        if (ctrl.signal.aborted || (error as { kind?: string })?.kind === "aborted") {
          app.showToast(tSystem("tui.stopped"))
        } else {
          throw error
        }
      } finally {
        // Kernel hanya emit `turn:interrupted` bila ada partial commit. Abort/error
        // sebelum step boundary tak memancarkan event itu → angka live dari turn
        // yang di-rollback harus dibuang di sini, bukan dipakai saat idle.
        contextTokens.invalidate()
        // v7.41: turn rekap berakhir — lepas kunci anti-loop sebelum batas fire.
        childRecap.setInRecapTurn(false)
        // Abort membatalkan NIAT user: pesan yang sempat diantrikan tak boleh
        // dikirim otomatis sesudahnya. Dibuang dengan pemberitahuan eksplisit
        // (bukan hilang diam-diam). v7.41 (audit F1): hitung juga baris steered
        // yang digema tapi tak jadi diproses kernel karena abort.
        if (ctrl.signal.aborted) {
          const droppedQueued = queuedPrompts
            .splice(0, queuedPrompts.length)
            .filter((q) => q.needsEcho).length
          const droppedSteered = steeredEchoes.splice(0).length
          const dropped = droppedQueued + droppedSteered
          if (dropped > 0) app.showToast(tSystem("tui.queueDropped", { n: String(dropped) }))
          // v7.41 (audit): anak di-abort mengirim STRING error via tool.completed.
          // Ringkasan yang sudah terkumpul di turn ini WAJIB dibuang, kalau tidak
          // turn bersih berikutnya mengutipnya seolah hasil asli. Ini TIDAK
          // menyentuh recap sah yang fire di batas turn (turn tak di-abort).
          childRecap.clear()
        }
      }

      const u = usage.get(modelRef.current)
      await persistCurrent(u)
      // P2.2: histori yang tak durable = error transkrip eksplisit (bukan diam).
      // Detail teknis (epoch/bootId/catatan) tetap di jurnal & log; layar hanya
      // pesan pendek bahasa sistem — bukan prefix teknis yang tak berarti
      // bagi user. Lihat test/tui-lang.test.ts (P03-B).
      if (ctx.isWriterStale()) transcript.pushError(tSystem("msg.staleWriter"))
      usage.reset()
      const sess = usage.getSession(modelRef.current)
      if (
        budget != null &&
        sess.cost != null &&
        sess.cost > budget * 0.8 &&
        sess.cost <= budget &&
        !warned80
      ) {
        warned80 = true
        app.showToast(
          tSystem("tui.budget80", { spent: formatUsd(sess.cost), budget: formatUsd(budget) }),
        )
      }

      // v7.41: BATAS FIRE — badan turn sudah tuntas, UI idle, antrean user kosong.
      // `abort` masih menunjuk ctrl di sini (dilepas outer finally), jadi yang
      // dicek bukan "abort !== null" melainkan "apakah turn LAIN sudah mengambil
      // alih" — bila ya, rekap ditunda (fail-closed), tak dibakar setengah hati.
      if (
        shouldFireChildRecap({
          enabled: childRecap.enabled,
          pendingCount: childRecap.pendingCount,
          queuedCount: queuedPrompts.length,
          suspended: app.isSuspended(),
          abortActive: abort !== ctrl,
          aborted: ctrl.signal.aborted,
          inRecapTurn: childRecap.inRecapTurn,
        })
      ) {
        const summaries = childRecap.drain()
        queuedPrompts.push({ text: buildChildRecapPrompt(summaries), needsEcho: false })
        turnState.markChildRecapPromptPending()
      }
    } finally {
      // Audit #1: satu-satunya titik pelepasan abort. Tetap jalan saat throw,
      // tapi TIDAK lebih awal dari persist/recap.
      abort = null
      // Audit #3: notifikasi job yang ditunda saat turn sibuk kini aman
      // dikeluarkan — streaming sudah selesai, tak ada fence untuk dipecah.
      const deferred = bgNotices.drain()
      // Notifikasi job yang ditunda tampil sebagai SATU micro-toast di footer.
      // Bukan entri transkrip: pushInfo memaksa commit & memecah fence streaming.
      if (deferred.length) app.showToast(deferred.join(" · "))
      // Batch 3 #3: job yang selesai saat turn aktif TIDAK ditandai resumed di
      // handler. Di sini antrean dikuras ke `queuedPrompts` — BUKAN `runTurn`
      // langsung — supaya loop yang sedang berjalan yang mengambilnya (anti
      // race). `needsEcho:false`: ini prompt internal, bukan pesan user.
      const jobs = deferredBgJobs.drain()
      if (jobs.length) disarmAbortQuitIfAvailable(app)
      for (const job of jobs) {
        if (resumedJobs.has(job.id)) continue
        resumedJobs.add(job.id)
        queuedPrompts.push({
          text: t("tui.bgFinishedAuto", { id: job.id, code: job.code ?? "?" }),
          needsEcho: false,
        })
      }
    }
  }

  /**
   * Jalankan prompt lalu kuras antrean "informasi tambahan" yang masuk selagi
   * turn berjalan. Loop (bukan rekursi) supaya backlog panjang tidak menumpuk
   * stack, dan tiap pesan antre tetap jadi turn PENUH sendiri — sehingga model
   * melihat hasil turn sebelumnya utuh sebelum membaca tambahan itu.
   */
  async function runTurn(prompt: string): Promise<void> {
    let next: string | undefined = prompt
    while (next !== undefined) {
      await runTurnOnce(next)
      const item = queuedPrompts.shift()
      // v7.41 (audit F1): gema baris user TEPAT saat baris diambil untuk
      // dijalankan. Bila dibuang saat abort, ia tak pernah sampai ke sini dan
      // karenanya tak pernah tampil sebagai prompt hantu di transkrip.
      if (item?.needsEcho) transcript.pushUser(item.text)
      next = item?.text
    }
  }

  /**
   * /help ringkas: daftar perintah per grup, ditampilkan di jendela output
   * command (bukan transkrip). Detail penuh = `/help tombol` (delegasi).
   */
  async function helpConcise(): Promise<void> {
    // Grup kurasi (sengaja bukan dump flat dari registry): label + baris pendek
    // per kategori supaya /help mudah dipindai. Sumber daftarnya SATU —
    // `HELP_GROUPS` di `cli/commands.ts` — karena sebelumnya grup di sini dan
    // grup di /help lengkap terpelihara terpisah: menambah perintah ke satu sisi
    // meninggalkan sisi lain basi (persis yang terjadi pada `/context`).
    const group = (label: string, names: readonly string[]): string =>
      `  ${label.padEnd(9)}${names.map((n) => `/${n}`).join(" ")}`
    await showCommandOutput(t("out.titleHelp"), [
      t("help.cHead"),
      ...HELP_GROUPS.map((g) => group(t(g.key), g.names)),
      t("help.cKeys"),
      t("help.cMore"),
    ])
  }

  function parseCopyCount(raw: string): number | null {
    if (!raw) return 1
    if (!/^\d+$/.test(raw)) return null
    const count = Number(raw)
    return count >= 1 && count <= MAX_COPY_TURNS ? count : null
  }

  async function copyLastTurn(count: number): Promise<void> {
    // [Area A · PROMPT 06] Buffer /copy milik SESI ini (bukan singleton modul)
    // — sesi lain di proses yang sama tak ikut tercampur.
    const turns = ui
      .getLastTurnTexts(count)
      .map((turn) => turn.trim())
      .filter(Boolean)
    const txt = turns.join("\n\n").trim()
    // v7.30: semua kwitansi /copy adalah urusan UI, bukan percakapan —
    // tampil di footer (toast) supaya histori transkrip tetap murni dialog.
    if (!txt) {
      app.showToast(tSystem("tui.copyNone"))
      return
    }
    // Guard byte SEBELUM base64: 10 turn panjang bisa melewati batas OSC 52;
    // memberi pesan spesifik lebih baik daripada gagal "butuh TTY" yang keliru.
    const bytes = clipboardByteLength(txt)
    if (bytes > MAX_CLIPBOARD_BYTES) {
      app.showToast(tSystem("tui.copyTooLarge", { n: bytes, max: MAX_CLIPBOARD_BYTES }))
      return
    }
    if (writeClipboardOsc52(txt)) {
      const key = turns.length > 1 ? "tui.copyOkMany" : "tui.copyOk"
      app.showToast(tSystem(key, { n: txt.length, turns: turns.length }))
    } else app.showToast(tSystem("tui.copyNeedTty"))
  }

  async function submit(line: string): Promise<{ quit?: boolean } | undefined> {
    // Flag abort sengaja TIDAK dihapus di sini: satu-satunya titik clear ada di
    // runTurnOnce saat AbortController turn baru dibuat. Kalau tidak, auto-resume
    // job background (yang tak lewat submit) akan mewarisi niat abort lama.
    if (!line.startsWith("/")) {
      await runTurn(line)
      return
    }
    const spaceIdx = line.indexOf(" ")
    const name = (spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx)).toLowerCase()
    let args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim()

    if (name === "") {
      await helpConcise()
      return
    }
    if (name === "help" && !args) {
      await helpConcise()
      return
    }
    if (name === "exit" || name === "quit") return { quit: true }
    if (name === "clear") {
      // Reset via App (bukan transcript.clear langsung) agar scrollBack dan
      // basis indikator ikut kembali ke ekor — tanpa ini viewport basi.
      app.clearView()
      return
    }
    if (name === "mode") {
      if (!args) {
        await modePopup()
        return
      }
      const nextWork = parseWorkModeValue(args)
      if (nextWork) {
        if (!workModeControl) {
          app.showToast(tSystem("tui.workModeUnavailable"))
          return
        }
        workModeControl.setWorkMode(nextWork)
        // v7.30: kwitansi "work mode: X" / "mode: X" DIBUANG — footer sudah
        // menampilkan kedua sumbu secara live. Toast malah menimpa footer
        // dan mengulang informasi yang sudah terlihat (histori tetap dialog).
      } else if ((PERMISSION_MODES as readonly string[]).includes(args.toLowerCase())) {
        if (!permissions) {
          app.showToast(tSystem("tui.permissionUnavailable"))
          return
        }
        setPermissionAxis(args.toLowerCase() as (typeof PERMISSION_MODES)[number])
      } else {
        app.showToast(tSystem("tui.unknownMode", { a: args, modes: "DISCUSS, BUILD, AUTO, ASK" }))
        return
      }
      app.repaint()
      return
    }
    // /unrestric — full akses tanpa gerbang (jail + bash-guard + sandbox/allowlist).
    // HIDDEN dari daftar "/" dan /help: operator yang tahu perintahnya yang bisa
    // memanggil. Berlaku per-sesi, toggle. Gerbang keamanan = kepercayaan operator.
    if (name === "unrestric" || name === "unrestrict") {
      const parsed = parseToggleArg(args)
      if (parsed === "invalid") {
        // v7.30: kwitansi toggle = status UI, bukan percakapan (footer/toast).
        app.showToast(tSystem("tui.unrestrictedUsage"))
        return
      }
      const next = parsed === undefined ? mode !== "unrestricted" : parsed
      if (next) {
        if (mode !== "unrestricted") {
          modeBeforeUnrestricted = mode
          workModeBeforeUnrestricted = workModeControl?.getWorkMode() ?? "DISCUSS"
        }
        mode = "unrestricted"
        permissions?.setMode("unrestricted")
        // WorkMode EXECUTE (BUILD) agar ceiling DISCUSS tak menahan tulis.
        workModeControl?.setWorkMode("EXECUTE")
        app.repaint()
        app.showToast(`${glyphs.unlock} ${tSystem("tui.unrestrictedOn")}`)
        return
      }
      if (mode !== "unrestricted") {
        app.showToast(`${glyphs.lock} ${tSystem("tui.unrestrictedOff", { m: mode })}`)
        return
      }
      mode = modeBeforeUnrestricted ?? "auto"
      permissions?.setMode(mode as "auto" | "ask" | "allow-all" | "allowlist")
      // Pulihkan juga WorkMode semula (DISCUSS) agar ceiling read-only
      // kembali berlaku — tanpa ini toggle-off meninggalkan BUILD (tulis bebas).
      workModeControl?.setWorkMode(workModeBeforeUnrestricted ?? "DISCUSS")
      modeBeforeUnrestricted = null
      workModeBeforeUnrestricted = null
      app.repaint()
      app.showToast(`${glyphs.lock} ${t("tui.unrestrictedOff", { m: mode })}`)
      return
    }
    if (name === "lang") {
      const { currentLocale, setSessionLocale } = await import("../src/ui/i18n/locale.ts")
      if (!args) {
        // v7.30: readout/pesan /lang = kwitansi UI — footer (toast), bukan transkrip.
        app.showToast(tSystem("tui.langLine", { v: `${currentLocale()} (en|id)` }))
        return
      }
      const next = args.trim().toLowerCase()
      if (next !== "en" && next !== "id") {
        app.showToast(tSystem("tui.langUnknown", { a: args }))
        return
      }
      setSessionLocale(next)
      // Simpan permanen (best-effort); sesi ini langsung berlaku via session.
      try {
        const { saveLang } = await import("../src/config.ts")
        await saveLang(next)
      } catch {}
      // v7.30: hapus duplikasi transkrip — toast di footer sudah menyampaikan hasilnya.
      app.showToast(tSystem("tui.langLine", { v: next }))
      return
    }
    let viewAction = ""
    if (name === "view") {
      if (!args) {
        const { runPicker } = await import("../src/ui/screens/picker.ts")
        let picked: string | undefined
        app.suspend()
        try {
          await runPicker({
            title: t("tui.viewTitle"),
            showTitle: true,
            items: VIEW_ACTIONS.map((action) => ({
              name: `${action} — ${t(`help.desc.${action}`)}`,
              provider: "",
              value: action,
            })),
            onPick: (value) => {
              picked = value
            },
            onCancel: () => {},
          })
        } finally {
          app.resume()
        }
        if (picked) return submit(`/view ${picked}`)
        return
      }
      const parts = args.split(/\s+/)
      viewAction = parts.shift()!.toLowerCase()
      args = parts.join(" ")
      if (!(VIEW_ACTIONS as readonly string[]).includes(viewAction)) {
        // v7.30: kwitansi /view = status UI, bukan giliran bicara (toast di footer).
        app.showToast(tSystem("tui.viewUse"))
        return
      }
    }
    if (viewAction === "thinking") {
      // compact/fold (dan minimize di bawah) sudah dihapus dari VIEW_ACTIONS:
      // flag-nya tak dibaca renderer flat, jadi hanya menyisakan kwitansi palsu.
      const parsed = parseToggleArg(args)
      if (parsed === "invalid") {
        app.showToast(tSystem("tui.toggleUse", { cmd: viewAction }))
        return
      }
      app.showToast(
        tSystem("tui.thinkingSet", {
          v: tSystem(ui.setReasoningVisible(parsed) ? "state.expanded" : "state.minimized"),
        }),
      )
      return
    }
    // `/view expand` sengaja tidak ada lagi — lihat catatan VIEW_ACTIONS.
    if (name === "undo" || name === "redo") {
      // Daftar turn adalah readout panjang → jendela command, sama seperti
      // /history. Receipt undo/redo yang pendek tetap di transkrip.
      if (name === "undo" && args.trim().toLowerCase() === "list") return delegateBuiltin(line)
      return popupBuiltin(line)
    }
    if (name === "copy") {
      const count = parseCopyCount(args)
      if (count === null) {
        app.showToast(tSystem("tui.copyInvalid", { n: args, max: MAX_COPY_TURNS }))
        return
      }
      await copyLastTurn(count)
      return
    }
    if (name === "cost" || name === "usage") return delegateBuiltin("/status")
    if (name === "models" || name === "model")
      return popupBuiltin(`/model${args ? ` ${args}` : ""}`)
    if (name === "sessions" && args.toLowerCase() === "history") {
      const disk = await loadHistory().catch(() => [])
      const inMem = app.getHistory().filter((h) => h.trim().toLowerCase() !== "/sessions history")
      const merged: string[] = []
      for (const entry of [...disk, ...inMem]) {
        if (merged[merged.length - 1] !== entry) merged.push(entry)
      }
      const lines = merged.slice(-20)
      await showCommandOutput(t("out.titleHistory"), lines.length ? lines : [t("tui.historyEmpty")])
      return
    }
    if (name === "sessions" && args.toLowerCase() === "branches") return delegateBuiltin(line)
    if (name === "sessions" || name === "resume")
      return popupBuiltin(`/${name}${args ? ` ${args}` : ""}`)
    if ((name === "provider" || name === "providers") && args.toLowerCase() !== "sync")
      return popupBuiltin("/provider")
    if ((name === "provider" || name === "providers") && args.toLowerCase() === "sync") {
      // Tampilkan progres "Syncing models…" langsung di kotak Layer 2 selama
      // probe jaringan berjalan, lalu transisi ke jendela hasil tanpa kedip.
      app.suspend()
      const paintSyncProgress = () => {
        const cols = process.stdout.columns || 80
        const rows = process.stdout.rows || 24
        if (!canRenderModal(cols, rows)) return
        const w = popupBoxWidth(cols)
        const box = dialogBox(
          {
            title: t("out.titleSync"),
            body: [c.muted(t("cmd.syncing"))],
            minWidth: w,
            maxWidth: w,
          },
          cols,
          rows,
        )
        app.paintRegion(box.lines, box.topRow)
        app.setCursorVisible(false)
      }
      const onResize = () => paintSyncProgress()
      process.stdout.on("resize", onResize)
      let syncLines: string[] = []
      try {
        paintSyncProgress()
        ;({ lines: syncLines } = await runBuiltin("/provider sync"))
        process.stdout.removeListener("resize", onResize)
        app.clearRegion()
        const nonBlank = syncLines.filter((l) => l.trim().length > 0)
        const out =
          nonBlank.length > 1 && nonBlank[0]?.trim() === t("cmd.syncing")
            ? nonBlank.slice(1)
            : syncLines
        if (out.length) await showCommandOutput(t("out.titleSync"), out)
      } finally {
        process.stdout.removeListener("resize", onResize)
        app.clearRegion()
        app.resume()
      }
      return
    }
    if (name === "update") {
      // Mirip /provider sync: tunjukkan progres "Checking for updates…" di
      // kotak Layer 2 selama cek/install berjalan, lalu transisi ke jendela
      // hasil. withUpdate melepas terminal saat phase install — paintRegion
      // jadi no-op setelah itu, jadi progres awal + toast onPhase yang tampil.
      app.suspend()
      const paintUpdateProgress = (label: string): void => {
        const cols = process.stdout.columns || 80
        const rows = process.stdout.rows || 24
        if (!canRenderModal(cols, rows)) return
        const w = popupBoxWidth(cols)
        const box = dialogBox(
          {
            title: tSystem("out.titleUpdate"),
            body: [c.muted(label)],
            minWidth: w,
            maxWidth: w,
          },
          cols,
          rows,
        )
        app.paintRegion(box.lines, box.topRow)
        app.setCursorVisible(false)
      }
      const onResize = () => paintUpdateProgress(tSystem("cmd.updateChecking"))
      process.stdout.on("resize", onResize)
      try {
        paintUpdateProgress(tSystem("cmd.updateChecking"))
        // runBuiltin → handleBuiltinCommand → withUpdate (release + install,
        // restart + exit di jalur sukses; reacquire di jalur gagal).
        const { lines } = await runBuiltin("/update")
        process.stdout.removeListener("resize", onResize)
        app.clearRegion()
        const out = lines.filter((l) => l.trim().length > 0)
        if (out.length) await showCommandOutput(t("out.titleUpdate"), out)
      } finally {
        process.stdout.removeListener("resize", onResize)
        app.clearRegion()
        app.resume()
      }
      return
    }
    const { lines, shouldExit, handled } = await runBuiltin(line)
    if (shouldExit) return { quit: true }
    // handled tanpa cetakan = murni modal (tak ada yang perlu ke transkrip).
    if (handled) {
      // Readout command (/help full, /status, /context, /sync, /init,
      // /scheduler) tampil sebagai jendela di atas chat, bukan dicetak ke
      // transkrip. Fallback transkrip bila layar tak mampu.
      if (lines.length) await showCommandOutput(commandWindowTitle(line), lines)
      return
    }
    // handleBuiltinCommand tak menangani → skill atau unknown (paritas REPL).
    const skill = allLoadedSkills.find((s) => s.name === name)
    if (!skill) {
      const hint = suggestSimilar(name, [
        ...BUILTIN_COMMANDS.map((b) => b.name),
        ...DRIVER_COMMANDS.map((d) => d.slice(1)),
        ...DRIVER_HELP_COMMANDS.map((b) => b.name),
        "cost",
        "usage",
        "resume",
        ...allLoadedSkills.map((s) => s.name),
      ])
      // v7.30: perintah tak dikenal adalah umpan balik UI, bukan pesan percakapan.
      app.showToast(
        tSystem("tui.unknownCmd", {
          name,
          tail: hint ? tSystem("tui.didYou", { hint }) : tSystem("tui.tryHelp"),
        }),
      )
      return
    }
    transcript.pushUser(line)
    await runTurn(await renderSkill(skill, args))
  }

  const host: TuiHost = {
    bus: session.events as unknown as TuiHost["bus"],
    getStatus: () => {
      const busy = abort != null
      const liveMode = livePermissionMode()
      // F-05: satu pembacaan token per paint (dua pemakaian di footer). Tracker
      // menjamin angka ini cache-backed & tanpa deep clone riwayat.
      const ctxTokens = getContextTokens()
      const status = {
        footer: {
          // Normalisasi: sumbu persetujuan hanya AUTO/ASK. Profil warisan
          // (allow-all/allowlist) tak lagi bocor sebagai label mode. "unrestricted"
          // adalah mode full-akses eksplisit (/unrestric) — tampil apa adanya.
          // Baca kontrol live (bukan snapshot `mode`) — lihat livePermissionMode.
          mode: liveMode === "ask" ? "ask" : liveMode === "unrestricted" ? "unrestricted" : "auto",
          // Gembok (allow-list) terang HANYA saat allow-list benar-benar menahan
          // bash: restrictBash + mode AUTO. Di ASK bash diawasi prompt (bukan
          // allow-list), dan di allow-all bash bebas — keduanya gembok redup.
          strictBash: (permissions?.getRestrictBash?.() ?? false) && liveMode === "auto",
          // P12 S2.2 Slice 5 - WorkMode LIVE (bukan snapshot boot): footer
          // mencerminkan mode aktif saat frame digambar.
          workMode: workModeControl?.getWorkMode() ?? "DISCUSS",
          model: modelRef.current ?? cfg.providers[0]?.models[0] ?? t("tui.noModel"),
          cwd: cwd ?? process.cwd(),
          context: fmtCtx(ctxTokens),
          metrics: fmtUsageMetrics(ctx, ctxTokens),
          // Jumlah job background hidup — dihitung di sini karena badge footer
          // adalah view murni (src/ui dilarang impor src/ non-UI).
          backgroundJobs: countLiveBackgroundJobs(),
        },
        busy,
      }
      // Fase 1 perf (butir 2): pinnedActivity hanya ditampilkan saat busy —
      // jangan memindai seluruh activities pada tiap ketikan idle.
      if (!busy) return { ...status, pinnedActivity: undefined }
      const activities = getPresentationSnapshot().activities
      return {
        ...status,
        pinnedActivity:
          activities.find(
            (activity) => activity.status === "running" && !activity.parentToolCallId,
          ) ?? activities.find((activity) => activity.status === "running"),
      }
    },
    listCommands: (prefix) => suggestions(prefix),
    submit,
    // Enter saat turn berjalan: SELIPKAN ke turn aktif (steering, seperti
    // "steer" di opencode) — kernel menambahkannya sebagai pesan user pada
    // batas step berikutnya, jadi model membacanya di turn yang sama. Bila turn
    // ternyata sudah selesai (balapan), jatuh ke antrean turn berikutnya supaya
    // pesan tidak hilang. Perintah `/slash` ditolak: ia memutasi UI/mode dan
    // butuh idle.
    enqueue: (raw) => {
      const line = raw.trim()
      if (!line) return false
      if (turnState.abortRequested) {
        // Jangan diam: user perlu tahu barisnya tak jadi turn hantu.
        // v7.30: kwitansi antrean = status UI (toast), bukan baris percakapan.
        app.showToast(tSystem("tui.queueAborted"))
        return false
      }
      if (line.startsWith("/")) {
        const name = line.split(/\s+/)[0] ?? line
        app.showToast(tSystem("tui.busyCmd", { cmd: name }))
        return false
      }
      // `?.` menjaga fixture/komposisi lama yang belum punya seam ini (fail-safe:
      // jatuh ke antrean, bukan crash di tengah turn).
      if (ctx.session.steer?.(line)) {
        // v7.41 (audit F1): steer diterima → kernel akan menaruhnya di store
        // pada batas step. Gema sekarang (urutan kronologis benar) dan catat
        // untuk notifikasi pembatalan bila turn di-abort sebelum itu terjadi.
        transcript.pushUser(line)
        if (steeredEchoes.length < 8) steeredEchoes.push(line)
        app.showToast(tSystem("tui.steered"))
        return true
      }
      // v7.41 (audit F1): gema DITUNDA sampai runTurn benar-benar mengonsumsi
      // baris ini. Kalau dibuang saat abort, ia tak pernah digema → tak ada
      // prompt hantu yang seolah dikirim ke model.
      queuedPrompts.push({ text: line, needsEcho: true })
      app.showToast(tSystem("tui.queued", { n: String(queuedPrompts.length) }))
      return true
    },
    copySelection: (text) => writeClipboardOsc52(text),
    abort: () => {
      turnState.markAbortRequested()
      contextTokens.invalidate()
      abort?.abort()
    },
    cycleWorkMode: (dir) => {
      cycleWorkMode(dir)
    },
    togglePermissionMode: () => {
      togglePermissionMode()
    },
    // Tidak ada lagi binding Ctrl+O/Ctrl+T. Metode ini sengaja NO-OP: renderer
    // flat tak mengonsumsi flag compact/reasoning, jadi mengubahnya sambil
    // mencetak kwitansi hanya menyesatkan user (temuan H1).
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }

  const loadRewindDraft = process.env.MINICODE_REWIND_DRAFT === "1"
  const rewindNotice = decodeEnvText("MINICODE_REWIND_NOTICE")
  delete process.env.MINICODE_REWIND_DRAFT
  delete process.env.MINICODE_REWIND_NOTICE
  let initialDraft: string | undefined
  if (loadRewindDraft) {
    try {
      const { readRewindRecord } = await import("../src/session/rewind.ts")
      const record = await readRewindRecord(sessionId, cwd ?? process.cwd())
      if (record?.branchSessionId === sessionId) initialDraft = record.prompt
    } catch {}
  }
  const app = new TuiApp(transcript, host, { initialDraft })
  // [6AD] Scheduler lifecycle → micro-toast SATU baris di footer, BUKAN entri
  // transkrip. Sink-nya `app.showToast` sudah ada di App: tak ada writer
  // stdout/stderr baru. Dipasang setelah TuiApp terbentuk; notice yang muncul
  // lebih awal masih tercatat di bounded log `/scheduler status`, jadi tak ada
  // informasi yang hilang permanen (hanya kwitansi sesaatnya yang terlewat).
  schedulerObservability?.onSchedulerNotice((line) =>
    app.showToast(tSystem("msg.scheduler", { line })),
  )
  // v7.30: notisi rewind = status sesi sesaat, bukan riwayat percakapan.
  if (rewindNotice) app.showToast(sanitizeAnsiLine(rewindNotice))
  // Approval sebagai warga TUI: blok pertanyaan + keputusan tercatat di
  // transkrip dan terlihat sebelum menjawab (tanpa sink = tulis langsung).
  const { setApprovalSink } = await import("../src/ui/tui/transcript.ts")
  // Auto-resume sekali per job background (scope "lanjutkan tanpa saya"),
  // bounded: satu resume per id, tak menumpuk walau banyak job selesai.
  const resumedJobs = new Set<string>()
  const autoResumeEnabled = process.env.MINICODE_AUTORESUME_BG !== "0"
  // Audit #3: notifikasi job yang datang saat turn aktif DITUNDA, bukan langsung
  // pushInfo — pushInfo memaksa commit transkrip dan memecah jawaban streaming
  // di tengah code fence. Dikeluarkan lagi di batas turn (runTurnOnce).
  const bgNotices = createBgNoticeQueue()
  const deferredBgJobs = createDeferredBgJobs()
  const unsubscribeJobFinished = onBackgroundJobFinished((id, code) => {
    try {
      if (resumedJobs.has(id)) return
      // Audit #1/#3 + batch 3 #2: satu guard idle untuk notifikasi DAN auto-
      // resume. `abort` non-null sampai seluruh runTurnOnce selesai; `app.busy`
      // menutup jendela @-mention (expandMentions di-await sebelum abort=ctrl).
      const idle = isTurnIdleForBackground({
        abortActive: abort !== null,
        suspended: app.isSuspended(),
        busy: isAppBusy(app),
      })
      if (autoResumeEnabled) {
        const immediate = bgNotices.offer(
          c.muted(t("tui.bgFinished", { id, code: code ?? "?" })),
          idle,
        )
        if (immediate !== undefined) transcript.pushInfo([immediate])
      }
      app.repaint()
      // Batch 3 #3: JANGAN tandai resumed di sini. Kalau turn sedang aktif,
      // job ditunda dan ditandai nanti di batas turn — kalau tidak, job hilang
      // permanen: sudah "resumed" tapi tak pernah benar-benar dijalankan.
      if (!idle) {
        if (autoResumeEnabled) deferredBgJobs.defer({ id, code })
        return
      }
      if (!autoResumeEnabled) return
      // Audit #4: auto-resume memanggil runTurn langsung (bukan doSubmit), jadi
      // jendela "Esc lagi = quit" wajib dimatikan di sini secara eksplisit.
      disarmAbortQuitIfAvailable(app)
      resumedJobs.add(id)
      void runTurn(t("tui.bgFinishedAuto", { id, code: code ?? "?" })).catch(() => {})
    } catch {}
  })
  // v7.41: Kumpulkan bukti anak delegate_task yang selesai. Handler domain-event
  // HANYA mengisi tracker; penembakan recap terjadi di batas turn (runTurnOnce)
  // supaya tak menyela user. Opt-out MINICODE_AUTORESUME_CHILD=0 → fail-closed.
  // `ctx.onDomainEvent` dijaga opsional: fixture tes parsial tanpa method ini
  // tetap jalan (tak ada event → tak ada recap), bukan crash.
  const childRecapEnabled = isChildRecapEnabled()
  const childRecap = createChildRecapTracker(childRecapEnabled)
  const unsubscribeChildRecap = ctx.onDomainEvent
    ? ctx.onDomainEvent((event) => {
        try {
          if (event.type === "tool.started") {
            childRecap.noteStarted(event.toolCallId, event.identity?.name ?? "")
          } else if (event.type === "tool.completed") {
            childRecap.noteCompleted(event.toolCallId, event.summary ?? "")
          } else if (
            event.type === "tool.failed" ||
            event.type === "tool.denied" ||
            event.type === "tool.cancelled"
          ) {
            childRecap.noteTerminal(event.toolCallId)
          }
        } catch {}
      })
    : () => {}
  try {
    setApprovalSink({
      pushBlock: (lines) => transcript.pushInfo(lines),
      repaint: () => app.repaint(),
      suspend: () => app.suspend(),
      resume: () => app.resume(),
      paintRegion: (lines, topRow) => app.paintRegion(lines, topRow),
      moveCursor: (row, col) => app.moveCursor(row, col),
      clearRegion: () => app.clearRegion(),
    })
    const res = await app.run()
    tuiStarted = res.started
    if (!res.started) {
      // Kegagalan startup adalah diagnostik, bukan keluaran program. App
      // sudah menolak membuka layar dan tidak ada fallback linear yang sah.
      // Notices startup yang sempat didefer WAJIB tetap terlihat di jalur
      // gagal ini (transcript tak pernah hidup) — digabung ke SATU write
      // dengan pesan noTty agar inventaris writer tidak bertambah.
      const deferred = ctx.startupNotices?.length ? ctx.startupNotices.join("") : ""
      process.stderr.write(`${deferred}${t("tui.noTty")}\n`)
      process.exitCode = 1
      return
    }
  } finally {
    setApprovalSink(null)
    unsubscribeJobFinished()
    unsubscribeChildRecap()
    contextTokens.dispose()
    transcript.dispose()
    // Blok penutup ditulis PALING AKHIR: app.run() sudah menutup alt-screen
    // lewat cleanupRun(), jadi teks ini jadi scrollback permanen, bukan frame
    // yang hilang saat layar di-restore.
    try {
      await close()
    } finally {
      if (tuiStarted) {
        // Blok penutup adalah kosmetik scrollback: kegagalan mengumpulkan
        // statisitk TIDAK boleh mengubah status keluar sesi.
        try {
          await writeSessionSummary(ctx, startedAt, (s) => process.stdout.write(s), {
            model: modelRef.current || undefined,
            mode: `${displayWorkMode(workModeControl?.getWorkMode() ?? "DISCUSS")}/${livePermissionMode().toUpperCase()}`,
            turns: contextTokens.getTurnCount(),
          })
        } catch {}
      }
    }
  }
}
