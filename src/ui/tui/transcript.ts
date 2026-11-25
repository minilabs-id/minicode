// Transkrip TUI — kolektor append-only event bus menjadi baris logis.
// Baris LOGIS disimpan tanpa wrap agar resize me-wrap saat paint; lebar terminal
// dibaca saat paint, bukan saat event (kontrak I11).
import type {
  PresentationPolicy,
  UiBus,
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
  UiToolStatus,
} from "../contract.ts"
import { t } from "../i18n/locale.ts"
import { renderActivityPanel } from "../render/activity-panel.ts"
import {
  type AgentFailureReason,
  EMPTY_AGENT_PROGRESS,
  formatAgentProgress,
} from "../render/agent-progress.ts"
import { chatColumnGeometry, chatWidth as chatWidthFromGeometry } from "../render/chat-column.ts"
import { friendlyToolErrorCanonical } from "../render/errors.ts"
import { paintLedger, runMarker, statusWord } from "../render/ledger.ts"
import { parseFence, renderInline } from "../render/markdown.ts"
import { computeAssistantLineLayout, formatAssistantSpacing } from "../render/markdown-layout.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "../render/markdown-table.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { renderMarkdownTable } from "../render/table-grid.ts"
import { c, glyphs } from "../render/theme.ts"
import { humanToolLabel, tSystem } from "../render/tool-label.ts"
import { displayWidth, padToWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { defaultUiState, MAX_COPY_TURNS, type UiSessionState } from "../session-state.ts"

// Renderer flat: semua dekorasi non-esensial (panel, lipatan, ringkasan turn,
// area thinking) sengaja dimatikan. Jejak aktivitas = baris tool live saat turn
// berjalan + SATU baris ringkas kategori di akhir turn (separator antar turn),
// seperti TUI OpenCode — tanpa kotak/grup.
const FLAT_RENDERER = true

/**
 * Lipat deretan sentinel microcompact jadi SATU baris ringkas.
 * `microcompact.ts` menulis satu sentinel per tool (jujur, tapi jadi dinding
 * chatter setelah kompaksi besar); di sini HANYA tampilan yang diubah.
 * Cocok lewat POLA, bukan salin teks: `src/ui/**` dilarang impor `src/` non-ui
 * (batas lapisan) dan menyalin frasa Indonesia memecah i18n-hardcode.
 * Sentinel selalu `[...: <tool> <n> char...]`.
 */
const COMPACTION_TRIM_READ_ONLY: ReadonlySet<string> = new Set([
  "read_file",
  "read_image",
  "grep",
  "glob",
  "ls",
  "stat",
  "git_status",
  "git_diff",
  "git_log",
])

/** Satu sentinel yang berhasil dikenali (data untuk agregasi baris ringkas). */
export interface CompactionTrimItem {
  readonly tool: string
  readonly chars: number
}

/**
 * Kenali satu baris sentinel microcompact. Mengembalikan null untuk baris biasa
 * supaya pemanggil bisa membedakan "ini chatter kompaksi" dari teks asli.
 *
 * Regex sengaja longgar di ekor: yang kami butuhkan hanya nama tool + jumlah
 * char. Klasifikasi ulang TIDAK memakai kata "JANGAN jalankan ulang" di dalam
 * sentinel (itu teks taken-from-model), melainkan nama tool — fail-closed.
 */
export function parseCompactionTrimLine(line: string): CompactionTrimItem | null {
  const plain = stripSgr(sanitizeAnsiLine(line)).trimStart()
  // Pola struktural: `[<apa pun>: <tool> <n> char...]` — tanpa literal teks
  // supaya UI tak melanggar batas i18n maupun ui-boundary.
  const match = /^\[[^\]]+:\s*([^\s\]]+)\s+(\d+)\s+char/.exec(plain)
  if (!match) return null
  const chars = Number(match[2])
  if (!Number.isFinite(chars) || chars < 0) return null
  return { tool: match[1] ?? "", chars }
}

/**
 * Apakah tool ini stateful (JANGAN disarankan untuk dijalankan ulang)?
 * Fail-closed: tool yang tidak dikenal DIANGGAP stateful, mirip aturan
 * `replayIsUnsafe` di `microcompact.ts`.
 */
export function compactionTrimIsStateful(tool: string): boolean {
  return !COMPACTION_TRIM_READ_ONLY.has(tool)
}

/** `42k char` untuk angka besar; `999 char` tetap apa adanya. */
function formatTrimChars(chars: number): string {
  if (chars < 1000) return `${chars} char`
  const k = Math.round(chars / 1000)
  return `${k}k char`
}

/**
 * Satu baris ringkas untuk sekelompok sentinel.
 *
 * KENAPA cabang stateful TIDAK menyertakan "jalankan ulang bila perlu": kalau
 * ada satu tool mutasi saja, menyuruh user mengulang seluruh grup berarti
 * mengulang efek samping (`rm`, tulis file, migrasi). Pesan utamanya berubah
 * menjadi "verifikasi state dulu" — ini bagian yang TIDAK boleh hilang.
 */
export function compactionTrimSummary(items: readonly CompactionTrimItem[]): string {
  if (items.length === 0) return ""
  const chars = items.reduce((sum, item) => sum + item.chars, 0)
  const stateful = items.filter((item) => compactionTrimIsStateful(item.tool)).length
  const base = `${items.length} tool results dipangkas (${formatTrimChars(chars)})`
  return stateful > 0
    ? `${base} · ${stateful} tool stateful: JANGAN jalankan ulang, verifikasi state dulu`
    : `${base} · jalankan ulang bila perlu`
}

type CompactToolCategory = "command" | "edit" | "read" | "subagent" | "thought" | "other"

/**
 * Entri akumulator rekap. `toolCallId` WAJIB ada supaya retry sukses bisa
 * MENGGANTI entri attempt gagal di slot yang sama — kalau cuma di-push, rekap
 * akan bilang `2 read` padahal user hanya melihat satu baris sukses.
 */
interface ActivityFoldEntry {
  toolCallId?: string
  rawName: string
  name: string
  status: string
  line: string
}

// Kategori adalah TOKEN TEKNIS (sama seperti nama tool), bukan prosa UI.
// Sengaja identik di en/id supaya jejak ringkas per-segmen stabil — test dan
// pembaca log tak bergantung pada /lang. Urutan di sini = urutan tampilan.
// v7.37: `subagent` dipisah dari `other` supaya fan-out 10 agent terbaca
// sebagai "10 subagent", bukan angka abstrak di kategori lain.
const COMPACT_CATEGORY_ORDER: readonly CompactToolCategory[] = [
  "command",
  "edit",
  "read",
  "subagent",
  "thought",
  "other",
]
const COMPACT_COMMAND_TOOLS = new Set([
  "bash",
  "bash_output",
  "bash_kill",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_push",
])
const COMPACT_EDIT_TOOLS = new Set([
  "write_file",
  "edit",
  "apply_patch",
  "delete_file",
  "move_file",
  // v7.40: lsp_rename menulis WorkspaceEdit melalui atomicWriteText — mutasi
  // file nyata, bukan "other" (audit UI/CLI).
  "lsp_rename",
])
const COMPACT_READ_TOOLS = new Set(["read_file", "read_image", "grep", "glob", "ls", "stat"])
const COMPACT_SUBAGENT_TOOLS = new Set(["delegate_task"])
const COMPACT_THOUGHT_TOOLS = new Set(["reasoning"])

/** Petakan nama tool ke kategori ringkas. `git_*` = perintah, BUKAN edit:
 *  ia mengubah repo tapi dijalankan seperti shell (lihat MUTATION_TOOLS).
 *  v7.37: `delegate_task` kini punya kategori sendiri (fan-out sub-agent). */
function compactToolCategory(name: string): CompactToolCategory {
  if (COMPACT_COMMAND_TOOLS.has(name) || name.startsWith("git_")) return "command"
  if (COMPACT_EDIT_TOOLS.has(name)) return "edit"
  if (COMPACT_READ_TOOLS.has(name)) return "read"
  if (COMPACT_SUBAGENT_TOOLS.has(name)) return "subagent"
  if (COMPACT_THOUGHT_TOOLS.has(name)) return "thought"
  return "other"
}

/**
 * Maksimal DUA baris kosong beruntun. Batas satu mengompres pemisah bab yang
 * sengaja dua baris (`formatAssistantSpacing`), menghilangkan hierarki.
 */
function normalizeBlankRunsFrom(
  rows: readonly TranscriptRow[],
  initialBlankRun: number,
): { rows: TranscriptRow[]; blankRun: number } {
  const out: TranscriptRow[] = []
  let blankRun = initialBlankRun
  for (const row of rows) {
    if (row.text === "") {
      if (blankRun >= 2) continue
      blankRun++
    } else {
      blankRun = 0
    }
    out.push(row)
  }
  return { rows: out, blankRun }
}

function normalizeBlankRuns(rows: TranscriptRow[]): TranscriptRow[] {
  return normalizeBlankRunsFrom(rows, 0).rows
}

/** Map menjaga urutan sisipan — hapas+set = pindah ke ujung (MRU). */
function lruGet<T>(map: Map<number, T>, key: number): T | undefined {
  const hit = map.get(key)
  if (hit === undefined) return undefined
  map.delete(key)
  map.set(key, hit)
  return hit
}

function lruSet<T>(map: Map<number, T>, key: number, value: T, max = 3): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

function emptyFence(): FenceCursor {
  return { open: false, char: "", len: 0 }
}

/**
 * SATU sumber logika fence — dipakai baik oleh `fenceTracker` (pending) maupun
 * oleh proyeksi inkremental. Kursor dimutasi supaya bisa dilanjutkan baris
 * berikutnya tanpa memindai ulang awal blok.
 */
function advanceFence(cursor: FenceCursor, line: string): FenceState {
  const fence = parseFence(line)
  if (!cursor.open && fence) {
    cursor.open = true
    cursor.char = fence.char
    cursor.len = fence.len
    return fence.lang ? `open:${fence.lang}` : "boundary"
  }
  if (cursor.open && fence && fence.char === cursor.char && fence.len >= cursor.len) {
    cursor.open = false
    return "boundary"
  }
  return cursor.open ? "inside" : "outside"
}

/** Cap memori: baris logis tertua dibuang diam-diam (kontrak I12). */
// Catatan retention (K.7): ini cap TAMPILAN transkrip. Berbeda dan sengaja tak
// sama dengan MAX_STATE_ENTRIES=4096 di presentation/model.ts yang membatasi
// reducer presentasi (state durable/resume) — dua lapis retention berbeda untuk
// substansi berbeda (viewport vs riwayat yang bisa di-replay).
export const TRANSCRIPT_CAP = 5000
export const TRANSCRIPT_TEXT_MAX_CHARS = 1_000_000
/** Baris pending lebih panjang dari ini tidak dimemo (kunci = isi baris). */
const PENDING_MEMO_LINE_MAX = 4096
/** Batas entri memo proyeksi pending sebelum dibuang seluruhnya. */
const PENDING_MEMO_MAX_ENTRIES = 4000
/** Baris thinking yang terlihat di area live (Fase 3). */
const MAX_THINKING_ROWS = 10
/**
 * Baris live tool yang terlihat di tail viewport. Cukup 3 baris terakhir
 * supaya narasi committed tetap tampil saat puluhan tool berjalan sekaligus;
 * detail lengkap tetap di jurnal/`--verbose`. `liveRows()` (overlay lama)
 * sengaja TIDAK dipotong — App tak memakainya.
 */
const MAX_LIVE_TAIL_ROWS = 3
const TRANSCRIPT_TRUNCATION_MARKER = "… [transcript truncated: turn cap exceeded]"
/**
 * Sink approval TUI: pemilik layar (cli/tui.ts) mendaftarkan transkrip +
 * repaint + suspend/resume agar prompt persetujuan tercatat di transkrip dan
 * terlihat SEBELUM user menjawab. Suspend selama askLine menunggu jawaban:
 * tanpa ini listener App + repaint live (stream/PgUp) berlomba dengan
 * askLine — prompt tak terlihat, user mengetik buta. Tanpa sink
 * (one-shot/exec/headless) approval memakai tulis langsung warisan.
 * Satu layer (src/ui) sehingga impor aman dari siklus.
 */
export interface ApprovalSink {
  pushBlock(lines: string[]): void
  repaint(): void
  suspend(): void
  resume(): void
  /** Lukis kotak modal di atas transkrip (popup komposit). Opsional: sink warisan (mock/test) boleh tanpa. */
  paintRegion?(lines: string[], topRow: number): void
  /** Parkir kursor di baris aktif modal. Opsional. */
  moveCursor?(row: number, col: number): void
  /** Hapus kotak modal sebelum resume. Opsional. */
  clearRegion?(): void
}

let approvalSink: ApprovalSink | null = null

export function setApprovalSink(sink: ApprovalSink | null): void {
  approvalSink = sink
}

export function getApprovalSink(): ApprovalSink | null {
  return approvalSink
}

export interface TranscriptMeta {
  seq?: number
  kind: "user" | "assistant" | "activity" | "approval" | "system" | "diagnostic"
  turnId?: number
  toolCallId?: string
  approvalId?: string
  status?: UiToolStatus
  expandRef?: { toolCallId: string; idx: number }
  table?: MarkdownTable
  /**
   * v0.43 — baris REKAP/LAPORAN (bukan narasi, bukan ledger tool).
   * Dipakai `copyTurnTexts()` supaya `/copy` mengambil narasi assistant + rekap
   * saja. Rekap ber-`kind:"system"`, jadi tanpa penanda ini ia tak bisa dibedakan
   * dari diagnostic/info system lain; flag ini MURNI metadata tampilan.
   */
  rekap?: boolean
}

export interface TranscriptOptions {
  getSnapshot?: () => UiPresentationSnapshot | null
  onPresentationEvent?: (handler: (event: UiPresentationEvent) => void) => () => void
  /** Kebijakan kanonik dari composition root; absen = logika inline legacy. */
  policy?: PresentationPolicy
  maxPendingChars?: number
  /**
   * [Area A · PROMPT 06] State UI milik SESI ini (visibility reasoning).
   * Absen = instance default modul. Permukaan produksi wajib mengoper state
   * sesinya supaya dua sesi dalam satu proses tak saling menimpa.
   */
  uiState?: UiSessionState
  /**
   * Diberitahu saat cap membuang baris dari kepala. Kunci = lebar cache,
   * nilai = jumlah baris visual yang hilang (netto setelah marker eviction).
   * App memakainya untuk menggeser `scrollBack` supaya anchor tak lompat.
   * Injeksi dari composition root — src/ui TIDAK boleh mengimpor cli/.
   */
  onEviction?: (removedByWidth: ReadonlyMap<number, number>) => void
}

export interface TranscriptPoint {
  id: number
  offset: number
}

export interface TranscriptRow {
  text: string
  sourceId: number
  sourceStart: number
  sourceEnd: number
  displayStart: number
  displayEnd: number
  selectable: boolean
  /** Teks tampil polos saat transformasi markdown inline mengubah kolom vs sumber. */
  plainBody?: string
}

export interface TranscriptViewport {
  rows: TranscriptRow[]
  firstIndex: number
  totalRows: number
  /** Batas atas scrollBack menurut konten saat ini (informasi; tidak dipakai untuk clamp). */
  maxBack: number
}

/** P2.2: hasil proyeksi satu baris logis + input yang memengaruhinya. */
interface ProjectedLineCache {
  width: number
  id: number
  raw: string
  assistant: boolean
  source: string
  prefix: string
  table: MarkdownTable | null
  fenceState: FenceState
  rows: TranscriptRow[]
}

/** Posisi code-fence yang bisa dilanjutkan inkremental lintas baris. */
interface FenceCursor {
  open: boolean
  char: string
  len: number
}

/**
 * Proyeksi baris ter-commit untuk SATU lebar. `counts[i]` = jumlah baris visual
 * dari baris logis ke-i; `rows` = gabungannya. Dengan ini `wrappedLength` jadi
 * O(1) dan `viewport` memotong langsung dari `rows` (O(height)) tanpa
 * membangun ulang 5.000 baris tiap frame.
 */
interface WidthProjection {
  width: number
  rows: TranscriptRow[]
  counts: number[]
  /** Fence state per baris logis — dipakai saat evict untuk tahu apakah opener/closer ikut terbuang. */
  fenceStates: FenceState[]
  fence: FenceCursor
  blankRun: number
  /** `totalAppended` saat proyeksi terakhir disinkron. */
  appendsSeen: number
  /** True bila mutasi out-of-band (evict/replace fence) menuntuk rebuild. */
  dirty: boolean
}

/**
 * Ringkas alasan gagal ringkasan LLM menjadi SEBAB yang bisa dibaca.
 *
 * Contoh nyata dari lapangan: `server error (503): {"error":{"origin":
 * "tiprouter","code":"overloaded","requestId":"c38699cf-...","message":
 * "The gateway is overloaded ()"}}`. Yang berguna: "503 · gateway overloaded".
 * Tanpa ini, satu baris ledger menyeret JSON gateway (dan id request) ke
 * transkrip, mendorong konteks lain keluar layar.
 */
function shortLlmFailureReason(raw: string): string {
  const body = raw.slice("llm-failed:".length).trim()
  // Status HTTP + kode mesin-terbaca bila ada di JSON gateway.
  const status = /(?:^|[^0-9])([0-9]{3})(?:[^0-9]|$)/.exec(body)?.[1]
  const code = /"code"\s*:\s*"([^"]{1,40})"/.exec(body)?.[1]
  const message = /"message"\s*:\s*"([^"]{1,120})"/.exec(body)?.[1]
  const parts: string[] = []
  if (status) parts.push(status)
  if (code && code !== status) parts.push(code)
  if (message)
    parts.push(
      message
        .replace(/\(\)/g, "")
        .replace(/[,;:]+$/, "")
        .trim(),
    )
  if (parts.length > 0) return parts.join(" · ")
  // Teks biasa (timeout, auth): ambil kalimat pertama saja.
  const firstBreak = body.indexOf("\n")
  const firstLine = firstBreak >= 0 ? body.slice(0, firstBreak) : body
  return firstLine.replace(/\r$/, "").slice(0, 120)
}

type TurnCountKey =
  | "ts.turnOk"
  | "ts.turnFailed"
  | "ts.turnDenied"
  | "ts.turnCancelled"
  | "ts.turnInterrupted"
  | "ts.turnFiles"

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

type FenceState = "outside" | "inside" | "boundary" | `open:${string}`

function clampCodeUnitBoundary(s: string, index: number): number {
  const idx = Math.max(0, Math.min(index, s.length))
  if (idx > 0 && idx < s.length) {
    const code = s.charCodeAt(idx)
    if (code >= 0xdc00 && code <= 0xdfff) return idx - 1
  }
  return idx
}

/**
 * Fallback lebar wrap gema saat pemanggil tak meneruskan lebar chat (jalur CLI
 * lama / test unit). Memakai geometri kolom chat yang SAMA dengan App supaya
 * default tak memakai lebar terminal mentah di kolom ter-centre.
 */
function userEchoWidth(): number {
  const cols = Math.max(1, process.stdout.columns || 80)
  const rows = Math.max(1, process.stdout.rows || 24)
  return Math.max(40, chatWidthFromGeometry(chatColumnGeometry(rows, cols)) - 1)
}

function renderAssistantLine(line: string, fenceState: FenceState): string | null {
  if (fenceState === "boundary") return null
  if (fenceState.startsWith("open:")) {
    // Penanda bahasa memakai bar yang SAMA dengan isi blok (bukan `·`) supaya
    // tak terbaca sebagai poin daftar di atas blok kode.
    const lang = fenceState.slice(5)
    return lang ? c.accent(`${glyphs.vLine} ${lang}`) : null
  }
  if (fenceState === "inside") return line
  // v0.33: `__bold__` juga markdown — jangan bocor ke layar bila jadi satu-satunya marker.
  if (!/(?:\*{1,2}|_{2}|`|^#{1,6}\s|~~|\[[^\]]+\]\()/.test(line)) return line
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    // Level hierarchy tanpa artefak `#`: #/## paling kuat, ### tebal,
    // #### ke bawah diredupkan agar sub-bab tak disamakan dengan bab induk.
    const level = heading[1]!.length
    const text = renderInline(heading[2] ?? "")
    if (level <= 2) return c.accentBold(text)
    if (level === 3) return c.bold(text)
    return c.gray(text)
  }
  const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (listItem) return `${listItem[1]}${listItem[2]} ${renderInline(listItem[3] ?? "")}`
  const blockquote = /^(\s*(?:>\s*)+)(.*)$/.exec(line)
  if (blockquote) return `${blockquote[1]}${renderInline(blockquote[2] ?? "")}`
  return renderInline(line)
}

/**
 * Rapikan hanya whitespace presentasi jawaban model: hapus baris kosong di
 * tepi, sisipkan jeda bersih antar-poin/heading/blok, dan batasi jeda berulang
 * di luar fenced code. Isi code fence tetap literal.
 */
function normalizeAssistantOutput(text: string): string {
  return formatAssistantSpacing(text)
}

let selectionSegmenter: Intl.Segmenter | undefined

function offsetAtColumn(text: string, start: number, end: number, column: number): number {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const target = Math.max(0, column)
  let used = 0
  try {
    selectionSegmenter ??= new Intl.Segmenter("und", { granularity: "grapheme" })
    for (const part of selectionSegmenter.segment(text.slice(from, to))) {
      const width = displayWidth(part.segment)
      if (target <= used + width / 2) return from + part.index
      used += width
      if (target <= used) return from + part.index + part.segment.length
    }
  } catch {
    for (const part of text.slice(from, to)) {
      const width = displayWidth(part)
      if (target <= used + width / 2) return from + text.indexOf(part, from)
      used += width
      if (target <= used) return from + text.indexOf(part, from) + part.length
    }
  }
  return to
}

export class Transcript {
  private lines: string[] = []
  private tables: (MarkdownTable | null)[] = []
  /**
   * P2.2: cache proyeksi PER BARIS logis. Transkrip append-only, jadi baris
   * lama tidak perlu di-wrap/markdown ulang setiap frame. Cache di-key oleh
   * semua input yang memengaruhi hasil (width, teks, source, prefix, tabel,
   * fence state), memakai ID stabil; eviction hanya membuang ID yang hilang.
   */
  /** Cache per (id, width) — satu slot per lebar bikin miss terus saat scroll
   *  memakai lebar terminal dan render memakai lebar chat. */
  private rowCache = new Map<number, Map<number, ProjectedLineCache>>()
  private ids: number[] = []
  private sourcePrefixes: string[] = []
  private sourceTexts = new Map<number, string>()
  private sourceOrders = new Map<number, number>()
  private assistantDisplay = new Map<number, string | null>()
  private nextId = 1
  private nextOrder = 1
  private pending = ""
  private pendingTruncated = false
  private activeProviderAttempt: {
    id: number
    pendingLength: number
    pendingTruncated: boolean
  } | null = null
  private maxPendingChars: number
  /** Hitung monotonik baris yang pernah ditambah — basis indikator "baru"
   * yang kebal evict cap 5000 (size() menyusut saat tertua dibuang). */
  private totalAppended = 0
  /** Thinking terakumulasi (tersanitasi). Minimized: penanda hidup;
   * expanded: mengalir redup seperti teks. */
  private thinkingBuf = ""
  private thinkingTail = ""
  /** Baris thinking turn berjalan (mode AREA, Fase 3): dirender sebagai blok
   * live maks 10 baris, bukan di-commit per baris. Diringkas saat turn selesai. */
  private thinkingArea: string[] = []
  /** Id baris ringkasan thinking turn berjalan (null = belum ada). Dipakai
   * untuk MENGGANTI baris yang sama saat segmen thinking berikutnya datang,
   * bukan menambah baris baru. */
  private thinkingRowId: number | null = null
  /** True bila ada segmen reasoning yang sudah ditutup (commit) dalam turn
   * berjalan — dipakai untuk memisahkan baris segmen baru dari sisa tail. */
  private thinkingSeenSegment = false
  /** Total baris thinking yang SUDAH ditampilkan untuk turn berjalan — sumber
   * angka pada baris ringkasan. Sengaja tidak dinolkan saat turn ditutup supaya
   * angka yang sudah tercetak tetap benar. */
  private thinkingTurnRows = 0
  private meta: TranscriptMeta[] = []
  /**
   * v0.43 — id baris PERTAMA tiap turn (dicitat saat `turn:started`, setelah
   * commit sisa turn sebelumnya). Dipakai sebagai batas grup `/copy` HANYA bila
   * transkrip tak punya gema user sama sekali (jalur bus/event programatik —
   * mis. test yang emit `turn:*` langsung tanpa lewat App.submit). Alur normal
   * selalu memakai `kind:"user"` sebagai batas; ini fallback sempit, bukan
   * state tampilan baru (tak memengaruhi lines/proyeksi/size/total).
   */
  private turnStartIds: number[] = []
  /**
   * Label progres live untuk slot composer/status App. Dua sumber:
   * `step.started` (langkah agen) dan `plan.updated` (todo_write). Keduanya
   * disimpan SEBAGAI STRING, bukan baris transkrip — renderer flat tak boleh
   * menambah baris/grup/kotak. Di-baca App lewat getter di bawah.
   */
  private progressLabel = ""
  private planLabel = ""
  /** Prompt user terakhir — dipakai renderer flat untuk card di atas composer. */
  private evicted = 0
  private hasEvictMarker = false
  private getSnapshot: (() => UiPresentationSnapshot | null) | undefined
  private policy: PresentationPolicy | undefined
  // [Area A · PROMPT 06] State UI sesi ini; default = instance modul.
  private uiState: UiSessionState
  private presentationUnsub: (() => void) | null = null
  private presentedTerminals = new Set<string>()
  /**
   * Baris tool anak identik (run+tool+target+status+alasan) ditimpa dengan ×N,
   * bukan di-append: `read_file` yang sama 22× = retry anak, bukan 22 langkah.
   */
  /**
   * Satu baris agregat per `delegate_task` induk; child ditimpa di baris SAMA.
   * `✦` chat & rekap memakai satu sumber angka.
   */
  private agentProgress = new Map<
    string,
    {
      id: number
      agents: Set<string>
      tools: Set<string>
      failures: Map<AgentFailureReason, number>
    }
  >()
  private delegateRowIds = new Map<string, number>()
  /**
   * v0.43 retry: id baris ledger terminal per toolCallId. Retry sukses
   * (`activity.supersedes`) menimpa baris attempt gagal di id yang SAMA,
   * bukan append — kalau tidak, baris merah lama tetap tinggal berdampingan
   * dengan baris hijau barunya (persis keluhan yang diperbaiki di sini).
   */
  private ledgerRowIds = new Map<string, number>()
  /** Alasan kegagalan child per toolCallId, dipakai saat retry sukses untuk
   *  mengurangi hitungan `✦ … N gagal` pada agregat induk yang sama. */
  private agentFailureById = new Map<string, AgentFailureReason>()
  private presentedVerifications = new Set<string>()
  // Dedup finding child (`finding.detected` / `[EVALUATE]`): event bisa datang
  // ulang dari bridge/replay, jadi satu finding = satu baris.
  private presentedFindings = new Set<string>()
  private summarizedTurns = new Set<number>()
  /** Lipat aktivitas: baris per-tool ditahan, lalu dirangkum jadi SATU baris
   * di akhir turn (+ detail di-buffer untuk /expand).
   * `rawName` = nama internal (hitung kategori); `name` = label humanToolLabel
   * untuk tampilan. Tak boleh digabung: terjemahan menggeser kategori rekap. */
  private activityFold: ActivityFoldEntry[] = []
  /**
   * Nama internal (mentah) SEMUA tool selama turn berjalan. Beda dengan
   * `activityFold` yang dikosongkan tiap kali narasi memotong segmen — akumulator
   * ini dipakai untuk SATU baris rekap KUMULATIF di akhir turn.
   */
  private turnToolNames: string[] = []
  /** Id tool sejajar dengan `turnToolNames` — kunci untuk menimpa slot retry. */
  private turnToolNameIds: string[] = []
  /** Rekap terakhir yang sudah ditulis — cegah duplikat identik di akhir turn. */
  private lastRecapText = ""
  /** Id baris rekap SEGMEN terakhir — ditimpa rekap kumulatif akhir turn supaya
   *  tak ada dua baris rekap bertumpuk berurutan (pola sama seperti
   *  `delegateRowIds`: simpan id dari `appendWithId`, perbarui via `replaceEntry`). */
  private recapRowId: number | null = null
  /** True sejenak setelah rekap ditulis: narasi berikutnya butuh SATU baris
   *  kosong pemisah. Bookkeeping transkrip murni, BUKAN state UI/App baru. */
  private recapJustWritten = false
  /**
   * True bila ada teks narasi sejak flush terakhir. Dikonsumsi `tool.started`:
   * footer `tool → narasi → rekap → tool` hanya ditulis bila narasi benar-benar
   * sudah lewat, bukan pada tool pertama / tool anak.
   */
  private narrationSinceFlush = false
  /**
   * v0.33: baris ringkas kompaksi yang sedang dibangun. Sentinel bisa datang
   * dalam beberapa batch `pushInfo` berturut-turut (satu event kompaksi =
   * beberapa panggilan), jadi agregatnya disimpan lalu ditimpa DI TEMPAT pada
   * id yang sama — tinggi transkrip tetap satu baris, jangkar scroll tak geser.
   */
  private compactionTrimRow: { id: number; items: CompactionTrimItem[] } | null = null
  private unsubs: (() => void)[] = []
  /**
   * Fase 1 perf (butir 2): memo daftar activity "running". Snapshot presentasi
   * kini stabil antar-event (cache di composition root), jadi filter
   * `status === "running"` tak perlu diulang tiap paint — cukup sekali per
   * snapshot. Key = identitas objek snapshot.
   */
  private runningMemo: {
    snapshot: UiPresentationSnapshot
    running: UiPresentationActivity[]
  } | null = null
  /**
   * Fase 1 perf (butir 3): cache proyeksi baris. Proyeksi sudah punya
   * `rowCache` per baris logis, tetapi `projectAll` tetap membangun ulang array
   * seluruh baris visual + parseFence + parse markdown `pending` pada tiap
   * paint (ketikan/scroll), meski isinya tak berubah. Cache di bawah menghindari
   * kerja itu: baris ter-commit di-cache per (width, totalAppended), pending
   * per (width, pendingVersion, truncated).
   */
  /** Proyeksi committed per lebar (LRU 3). Menggantikan slot tunggal lama. */
  private committedByWidth = new Map<number, WidthProjection>()
  /** Hitungan rebuild penuh — dipakai probe/test regresi performa. */
  private rebuildCount = 0
  private pendingProjection: {
    width: number
    version: number
    truncated: boolean
    rows: TranscriptRow[]
  } | null = null
  /**
   * Fase 1 perf (lanjutan): cache gabungan committed+pending — bagian O(N)
   * dari `projectAll`. Saat thinking/running kosong (kasus idle ketik/scroll,
   * mayoritas paint), hasil ini dikembalikan APA ADANYA tanpa salinan, sehingga
   * `[...committed, ...pending]` tak diulang O(N) tiap keystroke saat transkrip
   * sudah menumpuk. Di-invalidate oleh sinyal yang sama dengan dua cache di atas.
   */
  /** Cache gabungan committed+pending per lebar (LRU 3). */
  private projectedBaseByWidth = new Map<
    number,
    {
      width: number
      totalAppended: number
      pendingVersion: number
      pendingTruncated: boolean
      rows: TranscriptRow[]
    }
  >()
  /** Naik setiap `this.pending` berubah (stream/commit/invalidated/clear). */
  private pendingVersion = 0
  /** Callback eviction (di-inject App; tidak mengimpor cli/). */
  onEviction: TranscriptOptions["onEviction"]

  constructor(bus: UiBus, opts: TranscriptOptions = {}) {
    this.getSnapshot = opts.getSnapshot
    this.policy = opts.policy
    this.onEviction = opts.onEviction
    this.uiState = opts.uiState ?? defaultUiState
    this.maxPendingChars = Math.max(1, opts.maxPendingChars ?? TRANSCRIPT_TEXT_MAX_CHARS)
    // Gagal subscribe = transcript mati total; biarkan throw (fail-closed).
    this.unsubs = [
      bus.on("provider:text", (e: { text: string }) => this.stream(e.text)),
      bus.on("turn:started", () => {
        this.commit()
        // v0.43: catat id baris pertama turn ini SETELAH commit sisa turn
        // sebelumnya — dengan begitu teks yang baru di-commit masih masuk grup
        // lama, bukan grup baru. Dipakai `copyTurnTexts()` hanya bila tak ada
        // gema `kind:"user"` sama sekali di transkrip.
        if (this.turnStartIds[this.turnStartIds.length - 1] !== this.nextId) {
          this.turnStartIds.push(this.nextId)
        }
        // Akhiri akumulasi thinking turn sebelumnya: turn baru = baris baru.
        this.commitThinking(true)
        // Angka total dinolkan DI SINI (bukan saat turn ditutup) supaya baris
        // turn yang baru selesai tetap menunjukkan panjangnya sendiri. Tanpa
        // reset ini, turn kedua melanjutkan hitungan turn pertama dan
        // melaporkan "4 lines" untuk penalaran 2 baris.
        this.thinkingTurnRows = 0
        this.activityFold = []
        // Akumulator rekap kumulatif + penanda jeda narasi ikut turn baru.
        this.turnToolNames = []
        this.lastRecapText = ""
        this.recapRowId = null
        this.recapJustWritten = false
        this.narrationSinceFlush = false
        // Turn baru = event kompaksi baru; jangan sambung hitungan lama.
        this.compactionTrimRow = null
      }),
      bus.on("turn:completed", () => {
        // Satu panggilan `turnEnd`: flush sisa segmen DAN menutup akumulasi.
        // Dua panggilan terpisah seperti sebelumnya membuang segmen terakhir
        // yang belum sempat di-flush (hitungan jadi kurang dari kenyataan).
        this.commitThinking(true)
        this.commit()
        // v7.40: komentar lama menjanjikan "flush sisa segmen" tapi tak pernah
        // memanggilnya — jalur bus (non-presentasi) menggugurkan hitungan
        // segmen terakhir. flush() mengosongkan fold, jadi aman/idempoten bila
        // presentation path `turn.completed` juga memanggilnya.
        this.flushActivityFold()
        // Rekap AKHIR TURN kumulatif (dari akumulator, bukan fold yang baru
        // dikosongkan). Idempoten: akumulator dikosongkan setelah emit, jadi
        // jalur bus + presentation yang sama tak menulis dua kali.
        this.flushTurnTotal()
      }),
      bus.on("execution:started", () => {
        this.commit()
        this.commitThinking()
      }),
      bus.on("provider:extension", (e: { kind: string; data: unknown }) => this.extension(e)),
      bus.on("context:compacted", (e: { reason: string }) =>
        this.push(c.muted(this.compactedLabel(e.reason ?? ""))),
      ),
    ]
    if (opts.onPresentationEvent) {
      this.presentationUnsub = opts.onPresentationEvent((event) => this.presentationEvent(event))
    }
  }

  /**
   * Label hasil kompaksi yang JUJUR soal sebab dan akibat.
   *
   * Kernel mengirim `pressure:<level>` saat benar-benar menyusut dan
   * `pressure:<level>:no-op` saat tak ada yang bisa dibuang. Dulu keduanya
   * tampil sama ("dipadatkan: pressure:critical:no-op") sehingga sesi yang
   * konteksnya TIDAK menyusut terlihat seakan berhasil dipadatkan — user lalu
   * bingung kenapa turn berikut tetap gagal. Pemetaan ini memisahkan empat
   * kondisi yang berbeda tindak lanjutnya: no-op, fixpoint, mustahil (biaya
   * tetap), dan ringkasan LLM gagal.
   */
  private compactedLabel(reason: string): string {
    const clean = sanitizeAnsiLine(reason)
    if (!clean) return t("ts.compacted", { reason: "-" })
    if (clean.endsWith(":no-op")) {
      const base = clean.slice(0, -":no-op".length)
      return t("ts.compactedNoOp", { reason: base })
    }
    const kept = /^fixpoint:(\d+)$/.exec(clean)
    if (kept) return t("ts.compactedFixpoint", { kept: kept[1] ?? "0" })
    const impossible = /^impossible:(\d+):(\d+)$/.exec(clean)
    if (impossible)
      return t("ts.compactedImpossible", {
        fixed: impossible[1] ?? "0",
        trigger: impossible[2] ?? "0",
      })
    if (clean.startsWith("llm-failed:")) {
      // Alasan mentah provider dipangkas ke SEBAB saja: pesan 503 penuh berisi
      // JSON gateway (`{"error":{"origin":"tiprouter",...,"requestId":"..."}}`)
      // yang membingungkan dan mendorong baris lain keluar layar. Yang
      // berguna bagi pengguna hanya "kenapa", bukan id request gateway.
      return t("ts.compactedLlmFailed", { reason: shortLlmFailureReason(clean) })
    }
    return t("ts.compacted", { reason: clean })
  }

  /** Teks model mengalir — ditahan sebagai ekor hidup sampai commit. */
  stream(text: string): void {
    if (!text) return
    this.commitThinking()
    // Footer narasi: `tool → narasi → rekap → tool`. Teks model menandai
    // ujung segmen; rekap untuk tool SEBELUM narasi ditulis nanti, tepat saat
    // tool berikutnya dimulai (`tool.started`), bukan di sini. Flush di sini
    // (v7.37) dulu menulis baris sebelum narasi sempat di-commit.
    this.narrationSinceFlush = true
    const remaining = this.maxPendingChars - this.pending.length
    if (remaining <= 0) {
      this.pendingTruncated = true
      return
    }
    if (text.length <= remaining) {
      this.pending += text
      this.pendingVersion++
      return
    }
    let keep = text.slice(0, remaining)
    const last = keep.charCodeAt(keep.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) keep = keep.slice(0, -1)
    this.pending += keep
    this.pendingVersion++
    this.pendingTruncated = true
  }

  /** Chunk reasoning (`provider:extension` kind reasoning, data {text}). */
  extension(e: { kind: string; data: unknown }): void {
    if (e.kind === "minicode:attempt") {
      const data = e.data as {
        phase?: unknown
        attemptId?: unknown
        hadVisibleOutput?: unknown
      } | null
      const id = data?.attemptId
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return
      if (data?.phase === "started") {
        this.activeProviderAttempt = {
          id,
          pendingLength: this.pending.length,
          pendingTruncated: this.pendingTruncated,
        }
      } else if (data?.phase === "completed") {
        if (this.activeProviderAttempt?.id === id) this.activeProviderAttempt = null
      } else if (data?.phase === "invalidated" && this.activeProviderAttempt?.id === id) {
        this.pending = this.pending.slice(0, this.activeProviderAttempt.pendingLength)
        this.pendingVersion++
        this.pendingTruncated = this.activeProviderAttempt.pendingTruncated
        this.activeProviderAttempt = null
        // Reasoning dari attempt yang gagal tidak boleh tertinggal sebagai
        // konten aktif/collapsible. Baris reasoning yang sudah dipaint tetap
        // diberi marker append-only di bawah.
        this.thinkingBuf = ""
        this.thinkingTail = ""
        this.thinkingArea = []
        if (data.hadVisibleOutput === true) {
          this.push(c.warning(t("ts.providerAttemptDiscarded", { attempt: id })), {
            kind: "diagnostic",
          })
        }
      }
      return
    }
    if (e.kind !== "reasoning") return
    const text = (e.data as { text?: string } | null)?.text ?? ""
    if (!text) return
    const clean = sanitizeAnsi(text)
    if (this.uiState.reasoningVisible) {
      if (this.thinkingAreaMode()) {
        // Mode AREA (Fase 3): tahan baris di buffer, dirender sebagai blok live
        // terbatas (projectAll). JANGAN di-commit per baris — area yang
        // menggantikannya + ringkasan saat turn selesai.
        // Segmen reasoning BARU setelah tool call harus memulai baris sendiri:
        // sisa `thinkingTail` dari segmen sebelumnya (teks tanpa `\n` terakhir)
        // di-flush dulu. Tanpa ini dua segmen pendek bergabung dan baris
        // penutupnya hilang dari hitungan (baris terlihat lebih sedikit dari
        // yang sebenarnya dipikirkan model).
        if (this.thinkingSeenSegment) {
          if (this.thinkingTail.length > 0) this.thinkingArea.push(this.thinkingTail)
          this.thinkingTail = ""
          this.thinkingSeenSegment = false
        }
        this.thinkingTail += clean
        const parts = this.thinkingTail.split("\n")
        for (let i = 0; i < parts.length - 1; i++) this.thinkingArea.push(parts[i] ?? "")
        // Batasi memori; detail penuh sudah dipangkas per turn saat ringkasan.
        if (this.thinkingArea.length > 2000)
          this.thinkingArea.splice(0, this.thinkingArea.length - 2000)
        this.thinkingTail = parts[parts.length - 1] ?? ""
      } else {
        // Legacy (panel off): alir per baris dengan indentasi 2 kolom
        // (line-buffered, ekor hidup) — membedakan thinking dari jawaban model.
        this.thinkingTail += clean
        const parts = this.thinkingTail.split("\n")
        for (let i = 0; i < parts.length - 1; i++)
          this.append(c.thinking(parts[i] ?? ""), { kind: "diagnostic" })

        this.thinkingTail = parts[parts.length - 1] ?? ""
      }
    } else {
      // Minimized: penanda hidup; isi disimpan di collapsed view linear.
      this.thinkingBuf = (this.thinkingBuf + clean).slice(-20000)
    }
  }

  /** Mode area thinking aktif? Panel aktivitas ON + reasoning terlihat.
   * Panel off = perilaku legacy (stream per baris) agar `/fold` benar-benar
   * mengembalikan tampilan mentah. */
  private thinkingAreaMode(): boolean {
    return this.uiState.reasoningVisible && this.uiState.activityPanel
  }

  /** Selesaikan fase thinking.
   * - Mode area: ringkas jadi SATU baris (detail penuh di `/expand`),
   *   diakumulasi per TURN dan diperbarui di tempat.
   * - Legacy: flush ekor berindentasi.
   * - Minimized: penanda hilang.
   *
   * `turnEnd = true` menutup akumulasi sehingga turn berikutnya memulai baris
   * baru; pemanggil di tengah turn (mis. `execution:started`) memakai default
   * agar segmen berikutnya menambah hitungan pada baris yang sama. */
  private commitThinking(turnEnd = false): void {
    if (this.thinkingAreaMode()) {
      const lines = [...this.thinkingArea]
      if (this.thinkingTail) {
        lines.push(this.thinkingTail)
        this.thinkingTail = ""
      }
      this.thinkingArea = []
      this.thinkingBuf = ""
      this.thinkingSeenSegment = true
      if (lines.length > 0) {
        // ── Satu baris thinking per TURN, bukan per segmen ──────────────────
        // `execution:started` menyala setiap tool call, jadi model yang pola
        // pikirannya pendek-pendek menghasilkan deretan `+ thinking · 3 lines`
        // berulang tanpa jeda (keluhan "jendela thinking bocor / semrawut").
        // Segmen berikutnya dalam turn yang sama menambah HITUNGAN pada baris
        // yang sama alih-alih mencetak baris baru: pembaca melihat total
        // panjang penalaran turn itu, bukan sepuluh fragmen.
        this.thinkingTurnRows += lines.length
        // Narasi thinking hidup di CHAT: baris ringkas ini ditimpa di tempat
        // tiap segmen, jadi total penalaran turn tetap terbaca tanpa duplikasi.
        const label = c.thinking(
          `+ ${t("panel.thinking")} · ${t("panel.lines", { n: this.thinkingTurnRows })}`,
        )
        if (this.thinkingRowId !== null && this.replaceEntry(this.thinkingRowId, label)) {
          // Baris lama masih ada: perbarui di tempat (id tetap → tinggi tetap).
        } else {
          // Baris lama TIDAK ada lagi — bisa karena eviction `TRANSCRIPT_CAP`
          // saat turn sangat panjang. Tanpa cabang ini, `thinkingRowId` basi
          // membuat `replaceEntry` no-op selamanya dan seluruh thinking sisa
          // turn HILANG tanpa jejak (penalaran model tak terlihat).
          this.thinkingRowId = this.appendWithId(label, { kind: "diagnostic" })
        }
      }
      // `turnEnd` hanya menutup BARIS (agar turn berikutnya membuat baris
      // baru). Angka totalnya sengaja TIDAK dinolkan di sini: baris yang sudah
      // tercetak harus tetap menunjukkan panjang penalaran turn yang baru
      // selesai. Reset terjadi saat `turn:started` berikutnya.
      if (turnEnd) {
        this.thinkingRowId = null
        this.thinkingSeenSegment = false
      }
      return
    }
    if (!this.uiState.reasoningVisible) {
      // Reasoning tersembunyi sengaja dibuang: tak boleh bocor ke chat.
      // Detail lengkap tetap ada di jurnal presentasi, bukan di transkrip.
      this.thinkingBuf = ""
      this.thinkingTail = ""
      this.thinkingArea = []
      return
    }
    if (this.thinkingTail) {
      this.append(c.thinking(this.thinkingTail), { kind: "diagnostic" })
      this.thinkingTail = ""
    }
    this.thinkingBuf = ""
    this.thinkingArea = []
  }

  /** Dorong baris logis (sudah final, mis. gema prompt user). */
  push(line: string, meta: TranscriptMeta = { kind: "system" }): void {
    this.commit()
    // v0.33: jalur push (error/notice/kompaksi) juga bisa menerima sentinel
    // satu per satu — pakai akumulator yang sama dengan pushInfo.
    const item = parseCompactionTrimLine(line)
    if (item) {
      if (this.compactionTrimRow) this.compactionTrimRow.items.push(item)
      else this.startCompactionTrimRow(item)
      this.refreshCompactionTrimRow()
      return
    }
    this.compactionTrimRow = null
    this.append(line, meta)
  }

  /**
   * Gema prompt user ala shell: `minicode › baris-1`, lanjutan menjorok.
   *
   * `availableWidth` = lebar CHAT dari pemanggil (App memakai `chatWidth()`).
   * Wrap di sini memakai lebar itu, BUKAN lebar terminal: kalau tidak, prompt
   * panjang di terminal ≥120 kolom ter-wrap sekali di sini (lebar terminal)
   * lalu ter-wrap LAGI oleh `projectText` pada kolom chat ter-centre — baris
   * lanjutannya keluar dari margin. Isi/sumber tiap entri tidak berubah.
   */
  pushUser(prompt: string, availableWidth?: number): void {
    const rows = sanitizeAnsi(prompt).split("\n")
    const [first, ...rest] = rows
    this.commit()
    // Jeda visual lembut sebelum prompt user berikutnya agar batas giliran
    // terbaca cepat di transkrip panjang (baris awal sesi tidak diberi jeda).
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.append("", { kind: "system" })
    }
    const arrow = glyphs.arrow
    // v0.43: margin 3 kini milik FRAME, bukan teks. `prefix` tetap dipakai
    // sebagai chrome untuk pemetaan seleksi (displayStart turun 3 → 11).
    const prefix = `minicode ${arrow} `
    // v0.33 (audit): jangan serahkan wrap ke terminal — baris lanjutan mulai di
    // kolom 0. Wrap di sini dengan lebar ISI chat (sudah dikurangi margin).
    const width = availableWidth == null ? userEchoWidth() : Math.max(40, availableWidth - 1)
    const bodyWidth = Math.max(10, width - displayWidth(prefix))
    const chunks = wrapByWidth(first ?? "", bodyWidth)
    this.appendWithSource(
      `${c.accent("minicode")} ${c.muted(arrow)} ${chunks[0] ?? ""}`,
      { kind: "user" },
      chunks[0] ?? "",
      prefix,
    )
    for (let i = 1; i < chunks.length; i++) {
      this.appendWithSource(`${chunks[i]}`, { kind: "user" }, chunks[i]!, "")
    }
    for (const r of rest) {
      const restChunks = wrapByWidth(r, Math.max(10, width - 2))
      restChunks.forEach((chunk, i) => {
        // Indentasi baris lanjutan prompt multi-baris tetap jadi chrome seleksi.
        const indent = i === 0 ? " ".repeat(arrow.length + 1) : ""
        this.appendWithSource(`${indent}${chunk}`, { kind: "user" }, chunk, indent)
      })
    }
    // Ritme flat: SATU baris kosong setelah prompt sebelum jawaban model.
    // Bersama jeda sebelum prompt di atas, tiap blok (turn) dipisah rapi.
    this.append("", { kind: "system" })
  }

  /**
   * Label langkah live untuk slot status App (sudah disanitasi + via i18n).
   * String kosong = belum ada langkah / turn sudah selesai.
   */
  progressLabelText(): string {
    return this.progressLabel
  }

  /** Label rencana live (todo_write) untuk slot status App. */
  planLabelText(): string {
    return this.planLabel
  }

  pushError(message: string): void {
    this.push(c.error(sanitizeAnsiLine(message)), { kind: "diagnostic" })
  }

  pushInfo(lines: string[]): void {
    this.commit()
    if (lines.length === 0) return
    // v0.33: sentinel kompaksi dikenali SEBELUM parse markdown. Baris biasa
    // tetap lewat jalur lama (termasuk tabel); hanya chatter kompaksi yang
    // dilipat. Urutan relative dijaga: grup normal → baris ringkas → grup normal.
    let normal: string[] = []
    const flushNormal = (): void => {
      if (normal.length === 0) return
      const group = normal
      normal = []
      const blocks = parseMarkdownBlocks(sanitizeAnsi(group.join("\n")))
      if (blocks.length === 0) {
        for (const line of group) this.append(line, { kind: "system" })
        return
      }
      for (const block of blocks) {
        if (block.type === "table") this.appendTable(block.table, { kind: "system" })
        else {
          for (const line of block.text.split("\n")) this.append(line, { kind: "system" })
        }
      }
    }
    for (const line of lines) {
      const item = parseCompactionTrimLine(line)
      if (item) {
        flushNormal()
        if (this.compactionTrimRow) this.compactionTrimRow.items.push(item)
        else this.startCompactionTrimRow(item)
        this.refreshCompactionTrimRow()
        continue
      }
      // Baris bukan-sentinel menutup event kompaksi; sentinel setelahnya
      // adalah event baru, bukan kelanjutan baris ringkas yang sama.
      this.compactionTrimRow = null
      normal.push(line)
    }
    flushNormal()
  }

  /**
   * Permukaan eksplisit untuk detail kompaksi. Memakai jalur `pushInfo` yang
   * sama supaya satu sumber kebenaran untuk lipatan dan margin (sourcePrefix).
   */
  pushCompactionTrims(lines: readonly string[]): void {
    this.pushInfo([...lines])
  }

  /** Mulai satu baris ringkas kompaksi; dikembalikan id untuk update di tempat. */
  private startCompactionTrimRow(item: CompactionTrimItem): void {
    const id = this.nextId
    this.append(c.muted(compactionTrimSummary([item])), { kind: "system" })
    this.compactionTrimRow = { id, items: [item] }
  }

  /**
   * Perbarui ringkasan di id yang sama. KENAPA replace, bukan append: tiap
   * sentinel baru menambah angka/count; kalau jadi baris baru, justru muncul
   * dinding "1 tool…", "2 tool…", "3 tool…" yang ingin kita hilangkan.
   * Margin tetap di `sourcePrefix`, teks sumber = ringkasan polos, jadi seleksi
   * & `/copy` tak membawa tiga spasi chrome (kontrak margin v0.33).
   */
  private refreshCompactionTrimRow(): void {
    const row = this.compactionTrimRow
    if (!row) return
    const plain = compactionTrimSummary(row.items)
    const index = this.ids.indexOf(row.id)
    if (index < 0) {
      // Baris lama kena evict TRANSCRIPT_CAP — ciptakan lagi agar agregat hidup.
      row.id = this.nextId
      this.append(c.muted(plain), { kind: "system" })
      return
    }
    this.lines[index] = c.muted(plain)
    this.sourceTexts.set(row.id, stripSgr(sanitizeAnsi(plain)))
    // Satu penulis: semua perubahan baris lewat replaceAt → proyeksi inkremental.
    this.replaceAt(row.id)
  }

  /** Kosongkan transkrip (`/clear`): viewport kembali ke layar kosong. */
  clear(): void {
    this.lines = []
    this.rowCache.clear()
    this.pendingRowMemo.clear()
    this.tables = []
    this.ids = []
    this.sourcePrefixes = []
    this.sourceTexts.clear()
    this.sourceOrders.clear()
    this.assistantDisplay.clear()
    this.nextId = 1
    this.nextOrder = 1
    this.meta = []
    this.turnStartIds = []
    this.pending = ""
    this.pendingTruncated = false
    this.activeProviderAttempt = null
    this.thinkingBuf = ""
    this.thinkingTail = ""
    this.thinkingArea = []
    this.thinkingRowId = null
    this.evicted = 0
    this.hasEvictMarker = false
    this.runningMemo = null
    this.invalidateProjection()
    this.pendingProjection = null
    this.pendingVersion = 0
    this.presentedTerminals.clear()
    this.agentProgress.clear()
    this.delegateRowIds.clear()
    this.ledgerRowIds.clear()
    this.agentFailureById.clear()
    this.presentedVerifications.clear()
    this.presentedFindings.clear()
    this.summarizedTurns.clear()
    this.activityFold = []
    this.turnToolNames = []
    this.turnToolNameIds = []
    this.lastRecapText = ""
    this.recapRowId = null
    this.recapJustWritten = false
    this.narrationSinceFlush = false
    this.compactionTrimRow = null
    this.progressLabel = ""
    this.planLabel = ""
  }

  /** Jumlah baris logis (untuk test; bukan API paint). */
  size(): number {
    return this.lines.length + (this.pending ? 1 : 0)
  }

  /** Total baris logis yang pernah ditambah (monotonik, kebal evict cap). */
  total(): number {
    return this.totalAppended + (this.pending ? 1 : 0)
  }

  /**
   * v0.43 — Teks render 1..n turn terakhir: HANYA narasi assistant + rekap.
   *
   * Sumbernya BUKAN buffer `#lastTurnText` (yang menampung tool output mentah
   * dan terpotong di printer linear), melainkan baris yang benar-benar tampil
   * di transkrip. Gema user, ledger tool, diagnostic, error mentah, dan blank
   * separator sengaja dilewat — yang disalin cuma percakapan + laporan.
   *
   * Batas grup = gema `kind:"user"`. Satu grup berjalan dari sebuah baris user
   * sampai baris user berikutnya (eksklusif); ekor setelah user terakhir adalah
   * grup terakhir. Bila transkrip tak punya gema user sama sekali (jalur bus
   * programatik), batas diambil dari awal `turn:started` yang dicatat di
   * `turnStartIds` — tetap satu turn per grup, tanpa mengubah state tampilan.
   *
   * Pembaca MURNI: tak ada mutasi `lines`/`meta`/`sourceTexts`/proyeksi, tak ada
   * `stdout.write`. I1 & writer inventory tidak tersentuh.
   */
  copyTurnTexts(count = 1): string[] {
    const n = Math.max(1, Math.min(MAX_COPY_TURNS, Math.trunc(count) || 1))
    if (this.ids.length === 0) return []

    const userStarts: number[] = []
    for (let i = 0; i < this.meta.length; i++) {
      if (this.meta[i]?.kind === "user") userStarts.push(i)
    }
    let starts = userStarts
    if (starts.length === 0 && this.turnStartIds.length > 0) {
      starts = []
      for (let i = 0; i < this.ids.length; i++) {
        const id = this.ids[i]
        if (id !== undefined && this.turnStartIds.includes(id)) starts.push(i)
      }
    }

    const groups: string[] = []
    const collect = (from: number, to: number): void => {
      const rows: string[] = []
      for (let i = from; i < to; i++) {
        const meta = this.meta[i]
        if (!meta) continue
        if (meta.kind !== "assistant" && meta.rekap !== true) continue
        // sourceTexts sudah polos & tersanitasi; fallback untuk baris lama yang
        // belum punya source (mis. entri eviction) ikut dibersihkan dua lapis.
        const plain = stripSgr(
          sanitizeAnsi(this.sourceTexts.get(this.ids[i] ?? -1) ?? this.lines[i] ?? ""),
        )
        if (plain.trim() === "") continue
        rows.push(plain)
      }
      const text = rows.join("\n").trim()
      if (text) groups.push(text)
    }

    let from = 0
    for (const start of starts) {
      if (start > from) collect(from, start)
      from = start
    }
    collect(from, this.ids.length)
    return groups.slice(-n)
  }

  private projectText(
    text: string,
    sourceText: string,
    sourceId: number,
    width: number,
    selectable: boolean,
    sourcePrefix = "",
    markdown = false,
    fenceState: FenceState = "outside",
  ): TranscriptRow[] {
    const w = Math.max(10, width)
    // v0.43: margin 3 adalah padding FRAME, bukan spasi pada teks — baris
    // markdown tidak menyuntik outerMargin lagi.
    const outerMargin = 0
    const renderedLines = text.split("\n")
    const sourceLines = sourceText.split("\n")
    const out: TranscriptRow[] = []
    let sourceBase = 0
    for (let lineIndex = 0; lineIndex < renderedLines.length; lineIndex++) {
      const raw = renderedLines[lineIndex] ?? ""
      const source = sourceLines[lineIndex] ?? stripSgr(sanitizeAnsi(raw))
      let renderedBody: string | null
      if (!markdown) renderedBody = raw
      else if (sourceId >= 0 && this.assistantDisplay.has(sourceId))
        renderedBody = this.assistantDisplay.get(sourceId)!
      else {
        renderedBody = renderAssistantLine(raw, fenceState)
        if (sourceId >= 0) this.assistantDisplay.set(sourceId, renderedBody)
      }
      if (renderedBody === null) {
        sourceBase += source.length + 1
        continue
      }
      const isBoundaryHeader = markdown && fenceState.startsWith("open:")
      let firstLead = ""
      let hangingIndent = ""
      if (markdown) {
        if (isBoundaryHeader) {
          firstLead = outerMargin > 0 ? " ".repeat(outerMargin) : ""
          hangingIndent = firstLead
        } else if (renderedBody !== "") {
          const layout = computeAssistantLineLayout(raw, outerMargin, w, {
            inFence: fenceState === "inside",
          })
          firstLead = layout.firstLead
          hangingIndent = layout.hangingIndent
        }
      }
      const rendered = renderedBody === "" ? "" : `${firstLead}${renderedBody}`
      const renderedRows =
        rendered === ""
          ? [""]
          : wrapByWidth(rendered, w, hangingIndent ? { hangingIndent } : undefined)
      const effectiveHangCols = displayWidth(hangingIndent)
      const effectiveHang = effectiveHangCols > 0 && effectiveHangCols < w ? hangingIndent : ""
      const plainRenderedFull = stripSgr(sanitizeAnsi(rendered))
      const linePrefix0 = `${firstLead}${sourcePrefix}`
      const expectedExact = `${linePrefix0}${source}`
      const exactMatch = !isBoundaryHeader && (!markdown || plainRenderedFull === expectedExact)
      const prefixTrimmed = sourcePrefix.trimEnd()
      const rowBodies: Array<{
        text: string
        plainBody: string
        displayStart: number
        displayEnd: number
      }> = []
      for (let rowIndex = 0; rowIndex < renderedRows.length; rowIndex++) {
        const renderedRow = renderedRows[rowIndex] ?? ""
        const plainRendered = stripSgr(sanitizeAnsi(renderedRow))
        let rowDisplayStart = 0
        let plainBody = plainRendered
        if (rowIndex === 0 && linePrefix0) {
          if (plainRendered.startsWith(linePrefix0)) {
            rowDisplayStart = displayWidth(linePrefix0)
            plainBody = plainRendered.slice(linePrefix0.length)
          } else if (
            sourcePrefix &&
            prefixTrimmed &&
            plainRendered.startsWith(`${firstLead}${prefixTrimmed}`) &&
            plainRendered.length <= linePrefix0.length
          ) {
            // Terminal sempit memecah tepat di ujung chrome prefix ("minicode ›").
            rowDisplayStart = displayWidth(plainRendered)
            plainBody = ""
          }
        } else if (rowIndex > 0 && effectiveHang && plainRendered.startsWith(effectiveHang)) {
          // Lewati spasi indentasi gantung sintetis di awal baris lanjutan agar
          // highlight seleksi & clipboard /copy tetap bersih berisi teks asli.
          rowDisplayStart = effectiveHangCols
          plainBody = plainRendered.slice(effectiveHang.length)
        }
        rowBodies.push({
          text: renderedRow,
          plainBody,
          displayStart: rowDisplayStart,
          displayEnd: displayWidth(renderedRow),
        })
      }

      const rowSelectable = selectable && sourceId >= 0 && !isBoundaryHeader
      if (exactMatch) {
        let cursorInSource = 0
        for (let rowIndex = 0; rowIndex < rowBodies.length; rowIndex++) {
          const item = rowBodies[rowIndex]!
          if (
            rowIndex > 0 &&
            item.plainBody.length > 0 &&
            source.slice(cursorInSource).startsWith(" ") &&
            !item.plainBody.startsWith(" ") &&
            source.slice(cursorInSource + 1).startsWith(item.plainBody)
          ) {
            cursorInSource += 1
          }
          const start = sourceBase + cursorInSource
          const remaining = Math.max(0, source.length - cursorInSource)
          const take =
            rowIndex === rowBodies.length - 1
              ? remaining
              : Math.min(item.plainBody.length, remaining)
          cursorInSource += take
          const end = sourceBase + cursorInSource
          out.push({
            text: item.text,
            sourceId: rowSelectable ? sourceId : -1,
            sourceStart: start,
            sourceEnd: end,
            displayStart: item.displayStart,
            displayEnd: item.displayEnd,
            selectable: rowSelectable,
          })
        }
      } else {
        // Inline markdown mengubah panjang tampilan vs sumber (`**bold**`,
        // `[label](url)`, heading `## `): petakan proporsional ke kolom visual
        // agar highlight seleksi dan copy tidak meleset di baris yang sama.
        const colWidths = rowBodies.map((item) => Math.max(0, item.displayEnd - item.displayStart))
        const totalCols = colWidths.reduce((sum, v) => sum + v, 0)
        let prevPos = 0
        let accCols = 0
        for (let rowIndex = 0; rowIndex < rowBodies.length; rowIndex++) {
          const item = rowBodies[rowIndex]!
          accCols += colWidths[rowIndex]!
          const nextPos =
            isBoundaryHeader || !rowSelectable
              ? 0
              : rowIndex === rowBodies.length - 1 || totalCols === 0
                ? source.length
                : clampCodeUnitBoundary(source, Math.round((accCols / totalCols) * source.length))
          const start = sourceBase + prevPos
          const end = sourceBase + Math.max(prevPos, nextPos)
          prevPos = Math.max(prevPos, nextPos)
          out.push({
            text: item.text,
            sourceId: rowSelectable ? sourceId : -1,
            sourceStart: start,
            sourceEnd: end,
            displayStart: item.displayStart,
            displayEnd: item.displayEnd,
            selectable: rowSelectable,
            ...(rowSelectable ? { plainBody: item.plainBody } : {}),
          })
        }
      }
      sourceBase += source.length + 1
    }
    return out
  }

  private projectTable(table: MarkdownTable, sourceId: number, width: number): TranscriptRow[] {
    // v0.43: TUI sudah memberi margin kiri/kanan lewat padding FRAME, jadi
    // kirim `outerMargin = 0` agar tabel tidak kehilangan 3 kolom ganda dan
    // tidak perlu strip regex `^ {3}` yang rapuh pada lebar sempit.
    const rendered = renderMarkdownTable(table, Math.max(1, width), renderInline, 0)
    if (!rendered) return []
    const renderedRows = rendered.split("\n")
    const logicalRows = [table.headers, ...table.rows].map((row) => row.join("\t"))
    const ranges: Array<{ start: number; end: number }> = []
    let base = 0
    for (const row of logicalRows) {
      ranges.push({ start: base, end: base + row.length })
      base += row.length + 1
    }
    const plainRows = renderedRows.map((row) => stripSgr(sanitizeAnsi(row)))
    // Border Unicode (─/box drawing) DAN fallback ASCII (`+---+`) harus
    // dikenali. Tanpa varian ASCII, baris `+---+` dianggap data: ia menjadi
    // selectable dengan offset yang salah dan seleksi tabel kehilangan teks.
    const isBorderRow = (row: string): boolean =>
      /^[\s─━┌┐└┘├┤┬┴┼]+$/.test(row) || /^[\s+-]+$/.test(row)
    const horizontal = plainRows.some(isBorderRow)
    const fields = Math.max(1, table.headers.length)
    // Margin sudah menjadi padding frame; displayStart tabel kembali ke 0.
    // `plainBody` tetap dipakai agar seleksi memakai pemetaan kolom layar.
    let logicalIndex = 0
    return renderedRows.map((row, index) => {
      const plain = plainRows[index] ?? ""
      const isBorder = isBorderRow(plain)
      let range = ranges[0] ?? { start: 0, end: 0 }
      if (horizontal) {
        if (!isBorder) range = ranges[logicalIndex] ?? range
        if (!isBorder) logicalIndex++
      } else {
        const dataIndex = table.rows.length === 0 ? 0 : Math.floor(index / fields) + 1
        range = ranges[dataIndex] ?? range
      }
      const rowDisplayStart = 0
      const rowSelectable = !isBorder && sourceId >= 0
      return {
        text: row,
        sourceId: isBorder ? -1 : sourceId,
        sourceStart: range.start,
        sourceEnd: range.end,
        displayStart: rowDisplayStart,
        displayEnd: displayWidth(row),
        selectable: rowSelectable,
        ...(rowSelectable ? { plainBody: plain.slice(rowDisplayStart) } : {}),
      }
    })
  }

  /**
   * Pelacak code fence per aliran teks: baris DI DALAM fence tidak kena
   * render markdown (kode harus literal). Marker pembuka/penutup sendiri
   * juga dilewati agar state tetap sinkron dengan decorateMarkdown.
   */
  private fenceTracker(): (line: string) => FenceState {
    const cursor = emptyFence()
    return (line: string): FenceState => advanceFence(cursor, line)
  }

  /** Baris live area thinking (mode area): header `+ berpikir` + maks 10 baris
   * visual terakhir dari turn berjalan. Baris panjang dibungkus (bukan
   * dipotong). Kosong bila mode area off / belum ada thinking. */
  private thinkingRows(w: number): TranscriptRow[] {
    // Renderer flat: area thinking tidak dirender (tanpa blok/grup).
    if (FLAT_RENDERER) {
      void w
      return []
    }
    if (!this.thinkingAreaMode()) return []
    const logical = [...this.thinkingArea]
    if (this.thinkingTail) logical.push(this.thinkingTail)
    if (logical.length === 0) return []
    const visual: string[] = []
    const contentWidth = Math.max(1, w - 2)
    for (const line of logical) {
      if (line === "") visual.push("")
      else visual.push(...wrapByWidth(line, contentWidth))
    }
    const shown = visual.slice(-MAX_THINKING_ROWS)
    const hidden = visual.length - shown.length
    const out: TranscriptRow[] = []
    const push = (raw: string) => {
      out.push({
        text: c.thinking(raw),
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(raw),
        selectable: false,
      })
    }
    push(
      hidden > 0
        ? `  + ${t("panel.thinking")} · ${t("panel.moreLines", { n: hidden })}`
        : `  + ${t("panel.thinking")}`,
    )
    for (const row of shown) push(`  ${row}`)
    return out
  }

  /** Proyeksi panel aktivitas (Fase 2): baris grup dari tool TURN BERJALAN.
   * Sumber = `activityFold` (dikumpulkan per turn oleh event tool), BUKAN
   * snapshot sesi — snapshot bersifat kumulatif sampai cap, jadi akan
   * menampilkan tool dari turn lama. Kosong bila panel off / belum ada tool. */
  private panelRows(): TranscriptRow[] {
    // Renderer flat: panel aktivitas dihapus. Tool tetap tampil sebagai satu
    // baris ringkas lewat `presentationLedger` / `runningRows`.
    if (FLAT_RENDERER) return []
    if (!this.uiState.activityPanel) return []
    if (this.activityFold.length === 0) return []
    const activities = this.activityFold.map((e) => ({
      toolCallId: "",
      name: e.name,
      status: e.status as UiToolStatus,
      tsStart: 0,
    }))
    const lines = renderActivityPanel(activities, { maxRows: 10 })
    return lines.map((line) => ({
      text: line,
      sourceId: -1,
      sourceStart: 0,
      sourceEnd: 0,
      displayStart: 0,
      displayEnd: displayWidth(line),
      selectable: false,
    }))
  }

  // ── Proyeksi inkremental (A-P2) ──────────────────────────────────────────
  // Transkrip append-only → baris lama tak perlu di-wrap/markdown ulang tiap
  // frame. `committedByWidth` menyimpan satu WidthProjection per lebar (LRU 3).
  // Mutasi HANYA lewat appendEntry/replaceEntry/clear — lihat apply* di bawah.

  /** Batalkan semua proyeksi saat state yang mengubah hasil (clear/fence) berubah. */
  private invalidateProjection(): void {
    this.committedByWidth.clear()
    this.projectedBaseByWidth.clear()
  }

  /** Jumlah rebuild penuh sejak awal — dipakai probe regresi performa. */
  get projectionRebuilds(): number {
    return this.rebuildCount
  }

  private cachedRows(id: number, w: number): ProjectedLineCache | undefined {
    return this.rowCache.get(id)?.get(w)
  }

  /** Proyeksi satu baris logis, memakai rowCache per (id, width). */
  private rowsForIndex(index: number, w: number, fenceState: FenceState): TranscriptRow[] {
    const id = this.ids[index] ?? -1
    const table = this.tables[index] ?? null
    const raw = this.lines[index] ?? ""
    const assistant = this.meta[index]?.kind === "assistant"
    const source = this.sourceTexts.get(id) ?? ""
    const prefix = this.sourcePrefixes[index] ?? ""
    const cached = this.cachedRows(id, w)
    if (
      cached &&
      cached.id === id &&
      cached.raw === raw &&
      cached.assistant === assistant &&
      cached.source === source &&
      cached.prefix === prefix &&
      cached.table === table &&
      cached.fenceState === fenceState
    ) {
      return cached.rows
    }
    const produced = table
      ? this.projectTable(table, id, w)
      : this.projectText(raw, source, id, w, true, prefix, assistant, fenceState)
    let perWidth = this.rowCache.get(id)
    if (!perWidth) {
      perWidth = new Map()
      this.rowCache.set(id, perWidth)
    }
    perWidth.set(w, {
      width: w,
      id,
      raw,
      assistant,
      source,
      prefix,
      table,
      fenceState,
      rows: produced,
    })
    return produced
  }

  /** Tambah satu baris logis ke ujung proyeksi (dipakai rebuild & append). */
  private appendToProjection(proj: WidthProjection, index: number): void {
    const assistant = this.meta[index]?.kind === "assistant"
    const raw = this.lines[index] ?? ""
    const fenceState = assistant ? advanceFence(proj.fence, raw) : "outside"
    const produced = this.rowsForIndex(index, proj.width, fenceState)
    const normalized = normalizeBlankRunsFrom(produced, proj.blankRun)
    proj.blankRun = normalized.blankRun
    proj.counts.push(normalized.rows.length)
    proj.fenceStates.push(fenceState)
    proj.rows.push(...normalized.rows)
  }

  /** Cold build — dipanggil sekali per lebar (atau setelah mutasi fence). */
  private rebuildWidth(w: number, reuse?: WidthProjection): WidthProjection {
    const proj: WidthProjection = reuse ?? {
      width: w,
      rows: [],
      counts: [],
      fenceStates: [],
      fence: emptyFence(),
      blankRun: 0,
      appendsSeen: this.totalAppended,
      dirty: false,
    }
    proj.width = w
    proj.rows = []
    proj.counts = []
    proj.fenceStates = []
    proj.fence = emptyFence()
    proj.blankRun = 0
    proj.appendsSeen = this.totalAppended
    proj.dirty = false
    for (let i = 0; i < this.lines.length; i++) this.appendToProjection(proj, i)
    lruSet(this.committedByWidth, w, proj)
    this.rebuildCount++
    return proj
  }

  /** Proyeksi committed untuk satu lebar — O(1) bila masih segar. */
  private projection(width: number): WidthProjection {
    const w = Math.max(10, width)
    const hit = this.committedByWidth.get(w)
    if (hit && !hit.dirty && hit.appendsSeen === this.totalAppended) {
      lruGet(this.committedByWidth, w) // touch MRU
      return hit
    }
    return this.rebuildWidth(w, hit)
  }

  /** Satu baris baru masuk: perbarui semua proyeksi tanpa rebuild. */
  private applyAppend(): void {
    if (this.committedByWidth.size === 0) return
    const index = this.lines.length - 1
    if (index < 0) return
    for (const proj of this.committedByWidth.values()) {
      this.appendToProjection(proj, index)
      proj.appendsSeen = this.totalAppended
    }
  }

  /**
   * Cap membuang baris dari kepala: geser counts/rows & laporkan ke App.
   *
   * `firstEvict` = benar saat marker eviction BARU disisipkan di indeks 0.
   * Marker itu belum ada di proyeksi, jadi sekali ini kita rebuild (murah,
   * satu kali) agar counts/fenceStates sejajar dengan `this.lines`.
   * Evict berikutnya inkremental: marker dipertahankan, yang dibuang mulai
   * indeks 1. Rebuild hanya bila opener/closer fence ikut terbuang — kalau
   * tidak, sesi panjang tetap O(1) per append (ini inti perbaikan A-P2).
   */
  private applyEvict(removedLogical: number, firstEvict: boolean): void {
    const removedByWidth = new Map<number, number>()
    for (const [w, proj] of this.committedByWidth) {
      const from = firstEvict ? 0 : Math.min(1, proj.counts.length)
      const n = Math.min(removedLogical, Math.max(0, proj.counts.length - from))
      const removedVisual = proj.counts.slice(from, from + n).reduce((sum, v) => sum + v, 0)
      removedByWidth.set(w, Math.max(0, removedVisual - (firstEvict ? 1 : 0)))
      if (firstEvict) {
        proj.dirty = true // rebuild sekali untuk memasukkan baris marker
        continue
      }
      if (n === 0) continue
      const startRow = proj.counts.slice(0, from).reduce((sum, v) => sum + v, 0)
      proj.counts.splice(from, n)
      proj.rows.splice(startRow, removedVisual)
      const removedStates = proj.fenceStates.slice(from, from + n)
      proj.fenceStates.splice(from, n)
      if (removedStates.some((s) => s === "boundary" || s.startsWith("open:"))) proj.dirty = true
    }
    this.onEviction?.(removedByWidth)
  }

  /**
   * Ganti teks satu baris di tempat. Bila jumlah baris visual sama, cukup splice
   * (thinking summary & compaction trim termasuk kasus ini). Beda = rebuild.
   */
  private replaceAt(id: number): void {
    const index = this.ids.indexOf(id)
    if (index < 0) return
    const assistant = this.meta[index]?.kind === "assistant"
    for (const proj of this.committedByWidth.values()) {
      if (assistant) {
        proj.dirty = true
        continue
      }
      const oldCount = proj.counts[index] ?? 0
      const start = proj.counts.slice(0, index).reduce((sum, v) => sum + v, 0)
      const produced = this.rowsForIndex(index, proj.width, "outside")
      const normalized = normalizeBlankRunsFrom(produced, 0).rows
      if (normalized.length !== oldCount) {
        proj.dirty = true
        continue
      }
      proj.rows.splice(start, oldCount, ...normalized)
      let run = 0
      for (let i = proj.rows.length - 1; i >= 0 && proj.rows[i]!.text === ""; i--) {
        if (run >= 2) break
        run++
      }
      proj.blankRun = run
    }
    this.projectedBaseByWidth.clear()
  }

  /**
   * Baris di luar committed, URUTAN SAMA dengan projectAll lama:
   * thinking → running → panel → pending. Rekap TIDAK lagi hidup di sini:
   * ia ditulis permanen saat narasi dipotong tool berikutnya (atau di akhir
   * turn), supaya urutan footer `tool → narasi → rekap → tool` terjaga.
   * Dipisah supaya viewport bisa memotong langsung dari array committed (O(height)).
   */
  private tailRows(width: number): TranscriptRow[] {
    const w = Math.max(10, width)
    const proj = this.projection(w)
    const out: TranscriptRow[] = []
    if (!FLAT_RENDERER && !this.thinkingAreaMode() && this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const chunkRows = chunk === "" ? [""] : wrapByWidth(chunk, w)
        for (const row of chunkRows) {
          out.push({
            text: c.thinking(row),
            sourceId: -1,
            sourceStart: 0,
            sourceEnd: 0,
            displayStart: 0,
            displayEnd: displayWidth(row),
            selectable: false,
          })
        }
      }
    }
    // Area thinking (Fase 3): blok live maks 10 baris terakhir (mode area).
    out.push(...this.thinkingRows(w))
    // Tool yang SEDANG berjalan — panel hanya memuat tool terminal, jadi running
    // tetap punya baris sendiri (tak ada duplikasi).
    for (const row of this.runningRows()) {
      out.push({
        text: row,
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(row),
        selectable: false,
      })
    }
    out.push(...this.panelRows())
    // Jawaban streaming di ekor (di bawah semua activity turn berjalan).
    out.push(...this.pendingRows(w))
    return normalizeBlankRunsFrom(out, proj.blankRun).rows
  }

  /** Dipertahankan untuk kompatibilitas test/bench; viewport TIDAK memanggilnya. */
  private projectAll(width: number): TranscriptRow[] {
    const w = Math.max(10, width)
    const tail = this.tailRows(w)
    if (tail.length === 0) {
      const hit = lruGet(this.projectedBaseByWidth, w)
      if (
        hit &&
        hit.totalAppended === this.totalAppended &&
        hit.pendingVersion === this.pendingVersion &&
        hit.pendingTruncated === this.pendingTruncated
      ) {
        return hit.rows
      }
      const rows = this.projection(w).rows
      lruSet(this.projectedBaseByWidth, w, {
        width: w,
        totalAppended: this.totalAppended,
        pendingVersion: this.pendingVersion,
        pendingTruncated: this.pendingTruncated,
        rows,
      })
      return rows
    }
    return this.projectRows([...this.projection(w).rows, ...tail])
  }

  /** v7.29: prompt user TIDAK disembunyikan lagi — ia adalah history di transkrip. */
  private projectRows(rows: TranscriptRow[]): TranscriptRow[] {
    return normalizeBlankRuns(rows)
  }

  /** Kompatibilitas test/bench — jangan dipakai jalur paint/viewport. */
  projectAllRows(width: number): TranscriptRow[] {
    return this.projectAll(width)
  }

  /**
   * Memo proyeksi baris pending, dikunci isi baris (bukan indeks).
   *
   * Cache `pendingProjection` lama hanya valid per `pendingVersion`, dan versi
   * itu naik SETIAP delta — jadi tiap paint memproyeksikan ulang seluruh
   * jawaban. Biayanya O(pending) per frame → total O(n²) per turn (audit
   * 2026-11-12, CRITICAL-1): terukur 295 ms/frame pada 200 KB dan 1,4 dtk/
   * frame pada batas 1 MB. Mayoritas baris saat streaming sudah final, jadi
   * proyeksi per baris dimemo: yang tumbuh hanya baris terakhir.
   *
   * Dikunci juga `w` dan fenceState karena keduanya mengubah hasil proyeksi.
   * Baris sangat panjang tidak dimemo (kuncinya akan sebesar barisnya sendiri).
   */
  private pendingRowMemo = new Map<string, TranscriptRow[]>()

  /** Proyeksi `pending` (jawaban streaming) + marker truncasi. Di-cache per
   * (width, pendingVersion, truncated) untuk hasil total; proyeksi per baris
   * dimemo terpisah agar delta baru tidak memaksa kerja ulang penuh. */
  private pendingRows(w: number): TranscriptRow[] {
    if (!this.pending) {
      this.pendingProjection = null
      this.pendingRowMemo.clear()
      return []
    }
    if (
      this.pendingProjection &&
      this.pendingProjection.width === w &&
      this.pendingProjection.version === this.pendingVersion &&
      this.pendingProjection.truncated === this.pendingTruncated
    ) {
      return this.pendingProjection.rows
    }
    const rows: TranscriptRow[] = []
    const pendingFence = this.fenceTracker()
    const pending = normalizeAssistantOutput(sanitizeAnsi(this.pending))
    if (pending) {
      for (const block of parseMarkdownBlocks(pending)) {
        if (block.type === "table") {
          if (rows.length > 0 && rows[rows.length - 1]!.text !== "") {
            rows.push({
              text: "",
              sourceId: -1,
              sourceStart: 0,
              sourceEnd: 0,
              displayStart: 0,
              displayEnd: 0,
              selectable: false,
            })
          }
          rows.push(...this.projectTable(block.table, -1, w))
        } else {
          const lineList = block.text.split("\n")
          if (rows.length > 0 && lineList[0] !== "" && rows[rows.length - 1]!.text !== "") {
            rows.push({
              text: "",
              sourceId: -1,
              sourceStart: 0,
              sourceEnd: 0,
              displayStart: 0,
              displayEnd: 0,
              selectable: false,
            })
          }
          for (const line of lineList) {
            const fenceState = pendingFence(line)
            const memoKey =
              line.length <= PENDING_MEMO_LINE_MAX ? `${w}\u0000${fenceState}\u0000${line}` : null
            const memo = memoKey === null ? undefined : this.pendingRowMemo.get(memoKey)
            if (memo) {
              rows.push(...memo)
              continue
            }
            const clean = stripSgr(sanitizeAnsi(line))
            const produced = this.projectText(line, clean, -1, w, false, "", true, fenceState)
            if (memoKey !== null) {
              // Batas sederhana: memo adalah cache tampilan, bukan struktur
              // data — dibuang seluruhnya saat terlalu besar.
              if (this.pendingRowMemo.size >= PENDING_MEMO_MAX_ENTRIES) this.pendingRowMemo.clear()
              this.pendingRowMemo.set(memoKey, produced)
            }
            rows.push(...produced)
          }
        }
      }
    }
    if (this.pendingTruncated) {
      rows.push({
        text: c.gray(TRANSCRIPT_TRUNCATION_MARKER),
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(TRANSCRIPT_TRUNCATION_MARKER),
        selectable: false,
      })
    }
    this.pendingProjection = {
      width: w,
      version: this.pendingVersion,
      truncated: this.pendingTruncated,
      rows,
    }
    return rows
  }

  /** O(1) setelah proyeksi lebar ini tersedia. */
  wrappedLength(width: number): number {
    return this.projection(width).rows.length + this.tailRows(width).length
  }

  viewport(width: number, height: number, scrollBack: number): TranscriptViewport {
    const proj = this.projection(width)
    const tail = this.tailRows(width)
    const committedCount = proj.rows.length
    const total = committedCount + tail.length
    const safeHeight = Math.max(1, Math.floor(height))
    // v7.28: anchor ATAS. `scrollBack = 0` = kepala, nilai besar = ekor.
    // Konten lebih pendek dari viewport → baris kosong ditaruh DI BAWAH.
    const maxBack = Math.max(0, total - safeHeight)
    // v0.43: baris live tool adalah tail transien. Saat ia hilang, `total`
    // menyusut dan `maxBack` ikut turun, tetapi scrollBack yang dipakai App
    // belum tentu ikut rebase. Jangan clamp ke maxBack: pakai scrollBack apa
    // adanya supaya baris committed tetap di indeks layar yang sama. Baris
    // bawah yang tak terisi diisi kosong oleh padding di bawah. Clamp bawah
    // tetap dijaga agar nilai negatif tak menggeser jendela ke sebelum kepala.
    const back = Math.max(0, scrollBack)
    const firstIndex = back
    const rows: TranscriptRow[] = []
    if (back < committedCount) {
      const end = Math.min(committedCount, back + safeHeight)
      rows.push(...proj.rows.slice(back, end))
    }
    if (rows.length < safeHeight && tail.length > 0) {
      const tailStart = Math.max(0, back - committedCount)
      rows.push(...tail.slice(tailStart, tailStart + safeHeight - rows.length))
    }
    // Normalisasi jeda hanya pada jendela (O(height)), bukan seluruh transkrip.
    const normalized = normalizeBlankRuns(rows)
    while (normalized.length < safeHeight) {
      normalized.push({
        text: "",
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: 0,
        selectable: false,
      })
    }
    return { rows: normalized.slice(0, safeHeight), firstIndex, totalRows: total, maxBack }
  }

  /**
   * Indeks baris visual pertama yang memuat `point` pada lebar tertentu —
   * dipakai App untuk rebase scroll setelah resize (anchor id+offset).
   */
  indexOfPoint(point: TranscriptPoint, width: number): number {
    const rows = this.projection(width).rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (!row.selectable || row.sourceId !== point.id) continue
      if (point.offset >= row.sourceStart && point.offset <= row.sourceEnd) return i
    }
    // Anchor bisa berada di baris ekor (pending jawaban streaming) yang belum
    // ter-commit saat resize. wrappedLength() menghitung committed + tail, jadi
    // indeksnya harus menerus ke tailRows supaya rebase tak jatuh ke ekor buta.
    const tail = this.tailRows(width)
    for (let i = 0; i < tail.length; i++) {
      const row = tail[i]!
      if (!row.selectable || row.sourceId !== point.id) continue
      if (point.offset >= row.sourceStart && point.offset <= row.sourceEnd) return rows.length + i
    }
    return -1
  }

  view(width: number, height: number, scrollBack: number): string[] {
    return this.viewport(width, height, scrollBack).rows.map((row) => row.text)
  }

  pointAt(row: TranscriptRow, column: number): TranscriptPoint | null {
    if (!row.selectable || row.sourceId < 0) return null
    const source = this.sourceTexts.get(row.sourceId)
    if (source === undefined) return null
    const relative = Math.max(0, column - row.displayStart)
    if (
      row.plainBody !== undefined &&
      source.slice(row.sourceStart, row.sourceEnd) !== row.plainBody
    ) {
      const bodyCols = Math.max(0, row.displayEnd - row.displayStart)
      if (bodyCols === 0 || relative === 0) return { id: row.sourceId, offset: row.sourceStart }
      if (relative >= bodyCols) return { id: row.sourceId, offset: row.sourceEnd }
      const span = row.sourceEnd - row.sourceStart
      const rawOffset = row.sourceStart + Math.round((relative / bodyCols) * span)
      return { id: row.sourceId, offset: clampCodeUnitBoundary(source, rawOffset) }
    }
    return {
      id: row.sourceId,
      offset: offsetAtColumn(source, row.sourceStart, row.sourceEnd, relative),
    }
  }

  hasSource(id: number): boolean {
    return this.sourceTexts.has(id)
  }

  columnAtOffset(row: TranscriptRow, offset: number): number {
    const source = this.sourceTexts.get(row.sourceId)
    if (source === undefined) return 0
    const clamped = Math.max(row.sourceStart, Math.min(offset, row.sourceEnd))
    if (
      row.plainBody !== undefined &&
      source.slice(row.sourceStart, row.sourceEnd) !== row.plainBody
    ) {
      const span = row.sourceEnd - row.sourceStart
      const bodyCols = Math.max(0, row.displayEnd - row.displayStart)
      const ratio = span <= 0 ? 0 : (clamped - row.sourceStart) / span
      return row.displayStart + Math.round(ratio * bodyCols)
    }
    return row.displayStart + displayWidth(source.slice(row.sourceStart, clamped))
  }

  comparePoints(left: TranscriptPoint, right: TranscriptPoint): number {
    const leftOrder = this.sourceOrders.get(left.id)
    const rightOrder = this.sourceOrders.get(right.id)
    if (leftOrder === undefined || rightOrder === undefined) return 0
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    return left.offset === right.offset ? 0 : left.offset < right.offset ? -1 : 1
  }

  selectionText(start: TranscriptPoint, end: TranscriptPoint): string {
    const startOrder = this.sourceOrders.get(start.id)
    const endOrder = this.sourceOrders.get(end.id)
    if (startOrder === undefined || endOrder === undefined) return ""
    const [first, last] =
      startOrder <= endOrder
        ? [
            { order: startOrder, point: start },
            { order: endOrder, point: end },
          ]
        : [
            { order: endOrder, point: end },
            { order: startOrder, point: start },
          ]
    if (start.id === end.id) {
      const source = this.sourceTexts.get(start.id) ?? ""
      const from = Math.min(start.offset, end.offset)
      const to = Math.max(start.offset, end.offset)
      return source.slice(from, to)
    }
    // `ids` terurut menaik menurut `order` (monotonik saat append + eviction
    // dari depan), jadi lompati sumber SEBELUM awal seleksi dengan pencarian
    // biner — bukan memindai seluruh transkrip (bisa 5.000 entri) tiap salin.
    const parts: string[] = []
    for (let i = this.orderLowerBound(first.order); i < this.ids.length; i++) {
      const id = this.ids[i]!
      const order = this.sourceOrders.get(id)
      if (order === undefined) continue
      if (order > last.order) break
      const source = this.sourceTexts.get(id) ?? ""
      if (order === first.order) parts.push(source.slice(first.point.offset))
      else if (order === last.order) parts.push(source.slice(0, last.point.offset))
      else parts.push(source)
    }
    return parts.join("\n")
  }

  /** Seleksi kosong (anchor == focus pada sumber yang sama) tanpa menyusun teks. */
  selectionIsEmpty(start: TranscriptPoint, end: TranscriptPoint): boolean {
    const startOrder = this.sourceOrders.get(start.id)
    const endOrder = this.sourceOrders.get(end.id)
    if (startOrder === undefined || endOrder === undefined) return true
    if (start.id === end.id) return start.offset === end.offset
    return false
  }

  /**
   * Dua titik untuk select-all: sumber selectable PERTAMA (offset 0) dan
   * TERAKHIR (offset = panjang sumber). Dipakai App saat Ctrl+A pada prompt
   * kosong. `null` = transkrip tak punya sumber yang bisa disalin (no-op).
   * Urutan `ids` mengikuti append order, jadi kepala/ekurangnya adalah ujung
   * seleksi; `selectionText` akan menggabungkan semua sumber di antaranya.
   */
  selectionRange(): { first: TranscriptPoint; last: TranscriptPoint } | null {
    let first: TranscriptPoint | null = null
    for (const id of this.ids) {
      if (!this.sourceTexts.has(id)) continue
      first = { id, offset: 0 }
      break
    }
    if (!first) return null
    for (let i = this.ids.length - 1; i >= 0; i--) {
      const id = this.ids[i]!
      const source = this.sourceTexts.get(id)
      if (source === undefined) continue
      return { first, last: { id, offset: source.length } }
    }
    return null
  }

  /** Indeks pertama di `ids` dengan order >= `order` (ids terurut menaik). */
  private orderLowerBound(order: number): number {
    let lo = 0
    let hi = this.ids.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const o = this.sourceOrders.get(this.ids[mid]!) ?? -1
      if (o < order) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  dispose(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    try {
      this.presentationUnsub?.()
    } catch {}
    this.presentationUnsub = null
  }

  private commit(): void {
    if (!this.pending) return
    const rawText = this.pendingTruncated
      ? `${this.pending}\n${TRANSCRIPT_TRUNCATION_MARKER}`
      : this.pending
    this.pending = ""
    this.pendingVersion++
    this.pendingTruncated = false
    this.appendAssistantText(rawText)
  }

  /** Render jawaban asisten (markdown) menjadi baris logis kind "assistant". */
  private appendAssistantText(raw: string): void {
    const text = normalizeAssistantOutput(raw)
    if (!text) return
    // Pisahkan jawaban dari thinking/diagnostik ATAU rekap tepat di atasnya
    // dengan satu baris kosong — rekap ditulis dengan `kind:"system"`, jadi
    // `lastKind()` saja tak cukup untuk mendeteksi ekor rekap. Flag bookkeeping
    // ini dikonsumsi `appendEntry()` saat blank/entri berikutnya ditulis,
    // sehingga tepat satu blank (normalizeBlankRunsFrom membatasi maks 2).
    const last = this.lines[this.lines.length - 1]
    if ((this.lastKind() === "diagnostic" || this.recapJustWritten) && last !== "") {
      this.append("", { kind: "system" })
      this.recapJustWritten = false
    }
    const blocks = parseMarkdownBlocks(sanitizeAnsi(text))
    for (const block of blocks) {
      if (block.type === "table") {
        if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
          this.append("", { kind: "assistant" })
        }
        this.appendTable(block.table, { kind: "assistant" })
      } else {
        const rows = block.text.split("\n")
        if (this.tables[this.tables.length - 1] && rows[0] !== "") {
          this.append("", { kind: "assistant" })
        }
        for (const row of rows) this.append(row, { kind: "assistant" })
      }
    }
  }

  /**
   * Rebuild riwayat transkrip dari event presentasi durable (jalur resume).
   * Dipanggil SEKALI sebelum turn live berikutnya, jadi tak ada double-render.
   * `user.message` → echo prompt; `model.completed` → jawaban model; sisanya
   * (turn.*, tool.*, task.status, …) melewati jalur `presentationEvent` yang
   * sama seperti live — snapshot presentasi sudah di-rebuild saat resume,
   * sehingga ledger/provenance mengacu data yang benar.
   */
  replayHistory(events: readonly UiPresentationEvent[]): void {
    for (const event of events) {
      if (event.type === "user.message") {
        if (event.text) this.pushUser(event.text)
        continue
      }
      if (event.type === "model.completed") {
        if (event.text) this.appendAssistantText(event.text)
        continue
      }
      // catatan v7.40: `finding.detected` KINI punya baris transkrip (lihat
      // handler di presentationEvent). Event non-tool lain tetap no-op aman.
      this.presentationEvent(event)
    }
  }

  private lastKind(): TranscriptMeta["kind"] | undefined {
    return this.meta[this.meta.length - 1]?.kind
  }

  private presentationSnapshot(): UiPresentationSnapshot | null {
    if (!this.getSnapshot) return null
    try {
      return this.getSnapshot()
    } catch {
      return null
    }
  }

  private presentationEvent(event: UiPresentationEvent): void {
    if (event.type === "turn.started") {
      this.commit()
      // Turn baru: tutup akumulasi turn sebelumnya supaya baris thinkingnya
      // mandiri (tidak menyambung hitungan turn yang sudah lewat).
      this.commitThinking(true)
      this.thinkingTurnRows = 0
      this.activityFold = []
      this.turnToolNames = []
      this.turnToolNameIds = []
      this.lastRecapText = ""
      this.recapRowId = null
      this.recapJustWritten = false
      this.narrationSinceFlush = false
      this.compactionTrimRow = null
      // Dedup baris anak dan terminal lama tak boleh membungkam
      // toolCallId yang dipakai ulang di turn berikutnya (replay/test).
      this.presentedTerminals.clear()
      this.agentProgress.clear()
      this.delegateRowIds.clear()
      this.ledgerRowIds.clear()
      this.agentFailureById.clear()
      // Progres lama tak boleh bocor ke turn berikutnya.
      this.progressLabel = ""
      this.planLabel = ""
      return
    }
    if (event.type === "turn.completed") {
      this.commitThinking(true)
      // Ringkasan ditutup SETELAH jawaban terakhir di-commit supaya baris ini
      // benar-benar berada di ekor turn (separator), bukan di tengah narasi.
      // Dulu flush dilakukan sebelum commit demi urutan panel live — kini panel
      // mati, jadi alasan itu tak berlaku lagi.
      this.commit()
      this.flushActivityFold()
      // Rekap kumulatif seluruh tool turn ini (lihat bus `turn:completed`).
      this.flushTurnTotal()
      // minimizeActivity ON / activityPanel ON → fold meringkas sendiri; baris
      // ringkas itu sudah cukup, turnSummary (turn · files · durasi) dilewati.
      if (!this.uiState.minimizeActivity && !this.uiState.activityPanel)
        this.turnSummary(event.summary, event)
      this.progressLabel = ""
      this.planLabel = ""
      return
    }
    if (event.type === "turn.failed" || event.type === "turn.cancelled") {
      this.commitThinking(true)
      this.commit()
      this.flushActivityFold()
      this.flushTurnTotal()
      // Turn gagal diikuti turn baru tanpa `turn.started` bisa terjadi saat
      // resume; tutup akumulator agar ringkasan lama tak menumpuk.
      this.compactionTrimRow = null
      this.agentProgress.clear()
      this.delegateRowIds.clear()
      this.ledgerRowIds.clear()
      this.agentFailureById.clear()
      this.progressLabel = ""
      this.planLabel = ""
      return
    }
    // ── Baris progres live: update label internal + repaint, TANPA baris baru ──
    // step.started/plan.updated bukan aktivitas: jangan menyentuh
    // presentedTerminals (dedup terminal tool) dan jangan meng-append transkrip.
    if (event.type === "step.started") {
      if (typeof event.step === "number" && Number.isFinite(event.step)) {
        const n = Math.max(1, Math.floor(event.step) + 1) // kernel 0-based
        this.progressLabel =
          typeof event.total === "number" && Number.isFinite(event.total) && event.total > 0
            ? t("progress.step", { n, total: Math.floor(event.total) })
            : t("progress.stepNoTotal", { n })
        // v7.31: label progres tidak lagi punya surface di UI (v7.30 ringkasan
        // tool jadi separator). Jangan paksa repaint pada setiap step —
        // event bus App sudah menggambar ulang dari perubahan konten nyata.
      }
      return
    }
    if (event.type === "plan.updated") {
      this.planLabel = this.formatPlanLabel(event)
      // v7.31: sama seperti step — state disimpan, repaint tak dipaksa.
      return
    }
    // Renderer flat: diagnostik non-tool (task/consequence/context/verification)
    // tidak dirender sebagai baris transkrip — transkrip hanya user, jawaban,
    // dan satu baris ringkas per tool. Event tetap dikonsumsi (return) agar
    // tidak jatuh ke guard `tool.` di bawah.
    if (
      event.type === "task.status" ||
      event.type === "consequence.decided" ||
      event.type === "context.cutoff" ||
      event.type === "context.window" ||
      event.type === "verification.observed" ||
      // Judul diri sub-agent mengubah label di snapshot (LIVE panel), bukan
      // baris transkrip: append di sini akan menduplikasi baris childLedger.
      event.type === "activity.label"
    ) {
      return
    }
    // v7.40: finding dari child (`[EVALUATE] …`) HARUS tampil di TUI — v7.35
    // berjanji laporan live tapi cuma presenter linear yang merendernya.
    // Tempatnya SEBELUM guard `tool.` karena tipenya bukan tool event.
    if (event.type === "finding.detected") {
      const id = event.findingId
      if (!id || this.presentedFindings.has(id)) return
      // v7.41 re-audit: bridge (presentation-bridge.ts:261) menaruh isi finding
      // di `text`, bukan `summary` (summary di union bertipe UiTurnSummary).
      // Dulu kode ini baca `event.summary as string` → selalu "" → baris finding
      // tak pernah dirender (fitur v7.40 jadi no-op). Baca `text` yang benar.
      const text = sanitizeAnsiLine(event.text ?? "")
      if (!text) return
      this.presentedFindings.add(id)
      // Temuan audit adalah narasi: hidup di CHAT pada semua permukaan
      // (termasuk jalur one-shot/CI) supaya tak ada yang hilang.
      // "diagnostic" = baris observasi, bukan percakapan (lihat TranscriptMeta).
      this.append(truncateToWidth(text, 200, "…"), { kind: "diagnostic" })
      return
    }
    if (!event.type.startsWith("tool.")) return
    if (event.type === "tool.started") {
      // Tutup narasi/think yang masih menggantung supaya baris tool terminal
      // berikutnya muncul di bawahnya, bukan menempel di ekor jawaban.
      this.commit()
      this.commitThinking()
      // Footer narasi: `tool → narasi → rekap → tool`. Rekap untuk tool di
      // segmen SEBELUM narasi ditulis SETELAH narasi di-commit, tepat sebelum
      // tool baru muncul. Hanya saat narasi benar-benar lewat — tool pertama
      // turn / deretan tool tanpa narasi tak memotong segmen. Tool anak
      // (parentToolCallId) juga SKIP: ia detail, bukan pemotong segmen induk.
      if (this.narrationSinceFlush && !event.parentToolCallId) {
        this.narrationSinceFlush = false
        this.flushActivityFold()
      }
      return
    }
    this.presentationLedger(event)
  }

  /**
   * Satu baris datar ringkasan rencana: `todos 3/5 · sekarang: <task>`.
   * Judul task = teks tak terpercaya → sanitasi + potong sebelum tampil.
   */
  private formatPlanLabel(event: UiPresentationEvent): string {
    const steps = event.steps ?? []
    if (steps.length === 0) return ""
    const done = steps.filter((s) => s.status === "completed").length
    const active = steps.find((s) => s.status === "active")
    const current = active?.title
      ? // sanitizeAnsi sengaja MENYIMPAN SGR; baris status flat wajib polos.
        truncateToWidth(stripSgr(sanitizeAnsiLine(active.title)), 40, "…")
      : t("ts.statusRunning")
    return t("progress.plan", { done, total: steps.length, current })
  }

  private snapshotActivity(toolCallId: string | undefined) {
    if (!toolCallId) return undefined
    return this.presentationSnapshot()?.activities.find((a) => a.toolCallId === toolCallId)
  }

  /**
   * Rekap akhir turn: retry sukses MENGGANTI slot nama attempt gagal.
   * Dua toolCallId berbeda (attempt 1 gagal, attempt 2 sukses) tetap satu
   * tindakan bagi pembaca — kalau cuma di-push, rekap mengklaim `2 read`.
   */
  private pushTurnToolName(
    toolId: string | undefined,
    supersedesId: string | undefined,
    rawName: string,
  ): void {
    if (supersedesId) {
      const idx = this.turnToolNameIds.lastIndexOf(supersedesId)
      if (idx >= 0) {
        this.turnToolNames[idx] = rawName
        // Pindahkan kunci ke id baru supaya retry berikutnya tetap menimpa
        // slot yang sama (bukan menambah entri lagi).
        this.turnToolNameIds[idx] = toolId ?? supersedesId
        return
      }
    }
    this.turnToolNames.push(rawName)
    this.turnToolNameIds.push(toolId ?? "")
  }

  /** Sama seperti `pushTurnToolName`, tapi untuk rekap per-segmen. */
  private pushFoldActivity(entry: ActivityFoldEntry, supersedesId: string | undefined): void {
    if (supersedesId) {
      const idx = this.activityFold.findIndex((e) => e.toolCallId === supersedesId)
      if (idx >= 0) {
        this.activityFold[idx] = entry
        return
      }
    }
    this.activityFold.push(entry)
  }

  private presentationLedger(event: UiPresentationEvent): void {
    // Observasi verifikasi punya baris ledger sendiri (dedup per invocation):
    // terminal tool sudah tampil duluan, dan transcript append-only tak bisa
    // menimpa baris lama. Baris ini tak pernah mengklaim status tool.
    if (event.type === "verification.observed") {
      this.verificationLedger(event)
      return
    }
    if (event.toolCallId) {
      if (this.presentedTerminals.has(event.toolCallId)) return
      this.presentedTerminals.add(event.toolCallId)
    }
    const activity = this.snapshotActivity(event.toolCallId)
    // `supersedes` = attempt gagal yang digantikan (reducer.deriveSupersedes).
    // Retry memakai toolCallId BARU, jadi dedup `presentedTerminals` tak
    // membungkamnya — dan id lama inilah kunci baris yang akan ditimpa.
    const supersedesId = activity?.supersedes
    const toolId = event.toolCallId ?? activity?.toolCallId
    // F-AGENT-1: baris per-run HANYA bila activity membawa identitas run anak
    // (childSessionId/runId — data nyata dari ChildSessionLink). Tool anak yang
    // cuma punya `parentToolCallId` (jalur grouping legacy) tetap SEPENUHNYA
    // ditelan hitungan induk "n child tools" — kontrak P5 satu baris ledger
    // induk. `parentToolCallId` = taut ke pemanggil, BUKAN identitas run; jangan
    // disamakan dengan childSessionId/runId.
    if (activity?.parentToolCallId) {
      if (activity.childSessionId || activity.runId) this.aggregateAgent(event, activity)
      return
    }
    // v7.29: satu baris kosong MEMISAHKAN narasi (yang baru saja di-commit)
    // dari baris tool — seperti `marginTop=1` OpenCode. Hanya sekali per
    // transisi, bukan tiap tool: consecutive tools tetap rapat. `normalizeBlankRuns`
    // menjamin maksimal satu blank walau jalur lain menyisipkan juga.
    // Retry tidak memerlukan pemisah baru: ia menimpa baris attempt lama,
    // bukan membuka grup tool baru di bawahnya.
    if (!supersedesId && this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.append("", { kind: "assistant" })
    }
    this.commit()
    const snapshot = this.presentationSnapshot()
    // v0.33: hitung RUN anak yang unik, bukan semua activity. Sebelumnya retry,
    // phantom, dan tool yang masih jalan ikut terhitung sehingga baris induk
    // mengklaim "failed 34 child tools" padahal anak yang gagal jauh lebih sedikit.
    const children = activity
      ? new Set(
          (snapshot?.activities ?? [])
            .filter((a) => a.parentToolCallId === activity.toolCallId)
            .map((a) => a.childSessionId ?? a.runId ?? a.toolCallId),
        ).size
      : 0
    // Keputusan node dari policy kanonik bila di-inject; paint/sanitasi tetap
    // di sini. Tanpa policy = logika inline legacy (rollback flag).
    const desc =
      this.policy && activity
        ? this.policy.describeActivity(activity, { childCount: children })
        : undefined
    // Nama INTERNAL tetap dipakai untuk kategori rekap; `name` (label
    // manusiawibahasa SISTEM) HANYA untuk baris tampilan. Keduanya jangan
    // disatukan — lihat kontrak `activityFold` di atas.
    const rawName = sanitizeAnsiLine(desc?.name ?? activity?.name ?? event.name ?? "tool")
    const name = humanToolLabel(rawName, activity)
    // Akumulator turn menyimpan rawName SETIAP tool terminal (jalur dedup &
    // child sudah return lebih awal di atas), bukan fold per-segmen. Retry
    // sukses mengganti slot attempt gagal — bukan menambah nama kedua.
    this.pushTurnToolName(toolId, supersedesId, rawName)
    const target = desc?.target ?? activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = desc?.status ?? activity?.status ?? event.status ?? "completed"
    const retry = (desc ? desc.retryOf : activity?.supersedes) ? ` ${t("ts.retry")}` : ""
    // P2.11: penanda verifikasi/provenans dari deskripsi policy (ASCII aman).
    // Absen = unknown/live — tidak dirender sebagai keberhasilan.
    const verification = desc?.verification ?? activity?.verification
    const provenance = desc?.provenance ?? activity?.provenance
    // Keputusan marker lewat policy kanonik bila di-inject; fallback inline
    // legacy (tanpa policy) dijaga test display agar tak divergen dari
    // projection.ts (`verificationMark`/`provenanceMark`).
    const verificationMark = this.policy
      ? this.policy.verificationMark(verification)
      : !verification
        ? ""
        : verification.verdict === "present"
          ? " [verified]"
          : ` [unverified:${verification.verdict}]`
    const provenanceMark = this.policy
      ? this.policy.provenanceMark(provenance)
      : provenance === "reconstructed"
        ? " [reconstructed]"
        : provenance === "replay"
          ? " [replay]"
          : ""
    // Denial reason wajib terlihat di TUI: linear + machine sudah menampilkannya,
    // dan operator butuh tahu MENGAPA tool ditolak tanpa membaca log.
    const denyReason =
      status === "denied"
        ? (desc?.denyReason ?? activity?.denyReason ?? (event.reason ? String(event.reason) : ""))
        : ""
    const errorMessage = event.message ?? desc?.message ?? activity?.error?.message
    // Pesan error WAJIB satu baris: ledger adalah ringkasan, bukan dump. Teks
    // datang dari provider/tool (tak terpercaya) dan bisa multi-baris. Potong
    // di sini SEBELUM sanitasi: `sanitizeAnsiLine` memang sengaja mengubah \n
    // menjadi spasi (untuk teks alir), jadi memotong sesudahnya tidak berguna —
    // pesannya sudah tergabung menjadi satu baris panjang. Tanpa potongan awal,
    // satu error ikut menyeret sisa pesannya ke dalam ledger.
    const firstLine = String(errorMessage ?? "").split(/[\r\n]/)[0] ?? ""
    // v0.43: HANYA 13 redaksi kanonik yang boleh tampil di ledger. Fungsi
    // `friendlyToolErrorCanonical()` mengembalikan "" bila tak ada pola cocok —
    // error mentah tak diteruskan lagi (detail tetap di jurnal/--verbose).
    // Nama/target tool sudah tampil di `line`; fungsi menerimanya hanya untuk
    // frasa "Command failed · <target> · …". Deny reason (P0) tetap lewat cabang
    // `message` di bawah, terlepas dari ada/tidaknya redaksi kanonik.
    const canonical = errorMessage
      ? friendlyToolErrorCanonical(firstLine, target ? String(target) : undefined)
      : ""
    // Bila error tool tak cocok pola kanonik dan bukan denyReason, tampilkan
    // narasi fallback OS-locale agar detail mentah tak pernah bocor ke layar.
    const friendly =
      canonical ||
      (errorMessage && !denyReason && status !== "completed" ? tSystem("msg.unknownToolError") : "")
    const message = friendly
      ? `: ${friendly}`
      : denyReason
        ? `: ${truncateToWidth(sanitizeAnsi(denyReason), 200, "…").split("\n")[0] ?? ""}`
        : ""
    // Bedakan redaksi kanonik (13 pola) dari fallback yang hanya meneruskan
    // pesan mentah — mis. "boom" tetap butuh statusWord agar baris gagal jelas.
    const rawFirstLine = truncateToWidth(sanitizeAnsiLine(firstLine), 120, "…")
    const conciseRedaction = Boolean(friendly) && friendly !== rawFirstLine
    // v0.43: bila redaksi ringkas dipakai pada baris GAGAL, kata status dan
    // hitungan child TIDAK diulang — redaksi (mis. "Sub-agent failed · details
    // in --verbose") sudah menyatakan kegagalan, dan "N child tools" bukan inti
    // masalah (detail tetap di baris agregat ✦ & jurnal). Deny reason tanpa
    // redaksi tetap memakai statusWord + alasannya seperti sebelumnya. Warna
    // fail-closed TETAP lewat `paintLedger(status, line)` di bawah.
    const compactFailure = conciseRedaction && status !== "completed"
    const child = !compactFailure && children > 0 ? ` ${t("ts.childGroup", { n: children })}` : ""
    // Format ledger: `› nama target` (kontrak grammar). Kata status HANYA
    // dicetak saat bukan sukses: baris sukses berwarna hijau sudah menyatakan
    // hasilnya, dan "selesai" di setiap baris membuat daftar tool jadi derau.
    const statusSuffix =
      status === "completed" || compactFailure ? "" : ` ${glyphs.dot} ${statusWord(status)}`
    // v0.43: margin adalah padding FRAME — baris ledger polos di kolom 0.
    const line = `${glyphs.arrow} ${name}${targetText}${statusSuffix}${retry}${child}${verificationMark}${provenanceMark}${message}`
    // Lipat aktivitas (opencode-like): saat minimizeActivity ATAU panel
    // aktivitas aktif, baris ledger per-tool TIDAK boleh menghilang diam-diam
    // — ditahan lalu dirangkum saat turn selesai (panel: per keluarga tool;
    // minimize: satu baris nama+hitungan). Detail via /expand.
    //
    // Tool gagal/ditolak TETAP dicetak individual supaya alasannya langsung
    // terbaca (menyembunyikannya = pengguna tak tahu kenapa tool berhenti).
    // Kegagalan JUGA masuk fold agar baris grup tetap melaporkan agregatnya
    // (`1 failed`) — angka itu informasi nyata, bukan duplikasi teks. Yang
    // tidak boleh dobel adalah PESANNYA; di baris grup hanya ada hitungan,
    // jadi tidak ada teks alasan yang tercetak dua kali.
    const folded = this.uiState.minimizeActivity || this.uiState.activityPanel || FLAT_RENDERER
    if (folded) {
      // Retry sukses mengganti entri gagal di slot yang sama supaya rekap tak
      // menghitung dua attempt sebagai dua tool.
      this.pushFoldActivity({ toolCallId: toolId, rawName, name, status, line }, supersedesId)
    }
    const overwriteId =
      status === "completed" && supersedesId ? this.ledgerRowIds.get(supersedesId) : undefined
    // Retry sukses: timpa baris merah lama, jangan append hijau di bawahnya.
    // `replaceEntry` menyalin SGR dari `line` (paintLedger menghasilkan warna
    // di dalam string) dan menyinkronkan sourceTexts/rowCache/proyeksi.
    if (
      overwriteId !== undefined &&
      this.replaceEntry(overwriteId, paintLedger("completed", line), { status: "completed" })
    ) {
      if (toolId) {
        this.ledgerRowIds.set(toolId, overwriteId)
        // delegate_task: agregat ✦ anak nanti menimpa baris yang SAMA, bukan
        // membuat agregat kedua di bawah baris sukses ini.
        if (supersedesId && this.delegateRowIds.has(supersedesId)) {
          this.delegateRowIds.set(toolId, overwriteId)
        }
      }
      return
    }
    // Baris sukses di mode lipatan/panel diwakili baris grup — kecuali bila
    // retry sukses menimpa baris lama (sudah ditangani di atas).
    if ((this.uiState.minimizeActivity || this.uiState.activityPanel) && status === "completed")
      return
    const meta: TranscriptMeta = {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity?.expandRef ? { expandRef: activity.expandRef } : {}),
    }
    const rowId = this.appendWithId(paintLedger(status, line), meta)
    if (toolId) {
      this.ledgerRowIds.set(toolId, rowId)
      // Baris `delegate_task` induk kelak ditimpa ringkasan agregat — simpan
      // id-nya sekarang supaya tak ada `› failed N child tools` berdiri sendiri.
      if (rawName === "delegate_task" && !activity?.parentToolCallId) {
        this.delegateRowIds.set(toolId, rowId)
      }
    }
  }

  /** Golongkan alasan kegagalan anak ke kategori ringkas (fail-closed: error). */
  private agentFailureReason(status: string, message: string): AgentFailureReason {
    const s = `${status} ${message}`.toLowerCase()
    if (s.includes("timeout") || s.includes("exceeded") || s.includes("180000ms")) return "timeout"
    if (s.includes("abort") || s.includes("cancel")) return "aborted"
    if (s.includes("denied") || s.includes("permission")) return "denied"
    return "error"
  }

  /**
   * Satu baris agregat per delegasi — menggantikan puluhan baris `↳`.
   * Angka dihitung dari id unik supaya retry/replay tak menggandakan.
   */
  private aggregateAgent(event: UiPresentationEvent, activity: UiPresentationActivity): void {
    const parent = activity.parentToolCallId ?? ""
    let row = this.agentProgress.get(parent)
    if (!row) {
      const existing = this.delegateRowIds.get(parent)
      row = {
        id: existing ?? -1,
        agents: new Set(),
        tools: new Set(),
        failures: new Map(),
      }
      this.agentProgress.set(parent, row)
    }
    row.agents.add(activity.childSessionId ?? activity.runId ?? activity.toolCallId ?? "")
    row.tools.add(event.toolCallId ?? `${activity.name}:${activity.target ?? ""}`)
    const status = activity.status ?? event.status ?? "completed"
    const rawReason = String(event.message ?? (event as { reason?: unknown }).reason ?? "")
    const toolId = activity.toolCallId || event.toolCallId
    if (status !== "completed") {
      const reason = this.agentFailureReason(status, rawReason)
      row.failures.set(reason, (row.failures.get(reason) ?? 0) + 1)
      // Simpan alasan per attempt: saat retry sukses datang, kita harus tahu
      // kategori mana yang dikurangi (bukan asal mengurangi hitungan pertama).
      if (toolId) this.agentFailureById.set(toolId, reason)
    } else if (activity.supersedes) {
      // Retry sukses mencabut kegagalan attempt lama dari agregat ✦. Tanpa ini
      // baris tetap bilang `1 gagal (timeout)` padahal usaha kedua berhasil.
      const oldReason = this.agentFailureById.get(activity.supersedes)
      // Hapus dulu: event replay tak boleh mengurangi dua kali.
      this.agentFailureById.delete(activity.supersedes)
      if (oldReason) {
        const next = Math.max(0, (row.failures.get(oldReason) ?? 0) - 1)
        if (next === 0) row.failures.delete(oldReason)
        else row.failures.set(oldReason, next)
      }
    }
    // Tool anak ikut rekap kategori di chat: jalur ini return lebih awal dari
    // `presentationLedger`, jadi tanpa ini nama tool anak tak pernah masuk
    // `activityFold` / akumulator turn dan rekap `1 read` hilang dari chat.
    // rawName = NAMA INTERNAL (bukan label manusiawi) agar kategori tak geser.
    const rawName = sanitizeAnsiLine(activity.name ?? event.name ?? "tool")
    this.pushFoldActivity(
      {
        toolCallId: toolId,
        rawName,
        name: humanToolLabel(rawName, activity),
        status,
        line: "",
      },
      activity.supersedes,
    )
    this.pushTurnToolName(toolId, activity.supersedes, rawName)
    const failed = { ...EMPTY_AGENT_PROGRESS.failures }
    for (const [k, v] of row.failures) failed[k] = v
    const line = formatAgentProgress({
      agents: row.agents.size,
      tools: row.tools.size,
      failures: failed,
    })
    // `replaceEntry` memakai SGR dari argumen; bungkus dengan c.info supaya
    // agregat tetap biru/normal setelah retry sukses (sebelumnya replace
    // menulis teks polos, warnanya hilang dari baris yang sama).
    if (row.id < 0 || !this.replaceEntry(row.id, c.info(line))) {
      // Agregat `✦` adalah laporan ringkas, bukan ledger tool mentah: ikut
      // tersalin sebagai rekap oleh `copyTurnTexts()`.
      row.id = this.appendWithId(c.info(line), {
        kind: "activity",
        rekap: true,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      })
    }
  }

  private verificationLedger(event: UiPresentationEvent): void {
    const verification = event.verification
    if (!verification || !event.toolCallId) return
    if (this.presentedVerifications.has(verification.invocationId)) return
    this.presentedVerifications.add(verification.invocationId)
    const activity = this.snapshotActivity(event.toolCallId)
    if (activity?.parentToolCallId) return
    const name = sanitizeAnsiLine(activity?.name ?? event.name ?? "tool")
    const target = activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    // v0.43: margin adalah padding FRAME — tanpa lead pada teks.
    const line =
      verification.verdict === "present"
        ? `${name}${targetText} verified`
        : `? ${name}${targetText} unverified (${verification.verdict})`
    this.append(
      verification.verdict === "present" ? paintLedger("completed", line) : c.muted(line),
      {
        kind: "activity",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        toolCallId: event.toolCallId,
        status: activity?.status ?? "completed",
      },
    )
  }

  /**
   * P1.6: baris ledger consequence.decided — menampilkan verdict ACE/policy
   * agar operator tahu keputusan yang diambil runtime (PASS/FAIL/BLOCKED/
   * INCONCLUSIVE). Sebelumnya diblokir oleh guard `!startsWith("tool.")`.
   */
  consequenceLedger(event: UiPresentationEvent): void {
    this.commit()
    const verdict = String(event.verdict ?? "UNKNOWN")
    const rule = event.failureClass ? ` class=${sanitizeAnsiLine(String(event.failureClass))}` : ""
    const rationale = event.message ?? event.reason
    const reason = rationale
      ? `: ${truncateToWidth(sanitizeAnsiLine(String(rationale)), 200, "…")}`
      : ""
    const next = event.nextAction ? ` next=${sanitizeAnsiLine(String(event.nextAction))}` : ""
    // Paritas renderer linear (simple.ts): marker netral `glyphs.bullet`
    // (●/*). Logika lama memakai glyphs.check/cross (="" setelah ikon
    // dihapus) + "?", sehingga baris PASS tampil tanpa penanda (dua spasi)
    // dan divergen antar permukaan — kelas OAP-001.
    const line = `${glyphs.bullet} consequence ${sanitizeAnsiLine(verdict)}${rule}${next}${reason}`
    const paint =
      verdict === "FAIL" || verdict === "BLOCKED"
        ? c.error(line)
        : verdict === "PASS"
          ? c.success(line)
          : c.warning(line)
    this.append(paint, {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  /**
   * P1.6: baris ledger context.cutoff / context.window — memberitahu operator
   * saat konteks dipotong (compaction) atau mendekati batas jendela.
   * Sebelumnya diblokir oleh guard `!startsWith("tool.")`.
   */
  contextLedger(event: UiPresentationEvent): void {
    this.commit()
    if (event.type === "context.cutoff") {
      const reason = event.reason ? `: ${sanitizeAnsiLine(String(event.reason))}` : ""
      const line = `${glyphs.bullet} context cutoff${reason}`
      this.append(c.warning(line), {
        kind: "system",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      })
    } else {
      // context.window — occupancy aktual vs kapasitas (bukan session spend).
      const used = event.usedTokens
      const window = event.windowTokens
      const pct = event.percent != null ? ` ${Math.round(event.percent)}%` : ""
      const tokens =
        used != null
          ? ` ${used.toLocaleString()}${window ? `/${window.toLocaleString()}` : ""} tokens`
          : ""
      const line = `  ${glyphs.bullet} context window${tokens}${pct}`
      this.append(c.muted(line), {
        kind: "system",
        ...(event.seq !== undefined ? { seq: event.seq } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      })
    }
  }

  /**
   * F-TASK-1: baris ledger status task kanonik (`t<n>`) + DAG. Id/status/parent/
   * dependsOn dibawa apa adanya dari TaskStore; tak ada status yang diarang.
   */
  taskStatusLedger(event: UiPresentationEvent): void {
    const id = event.taskId
    const raw = event.taskStatus
    if (id === undefined || raw === undefined) return
    this.commit()
    const status = sanitizeAnsiLine(String(raw).toLowerCase())
    const parent = event.parentId ? ` parent=${sanitizeAnsiLine(event.parentId)}` : ""
    const deps = event.dependsOn?.length
      ? ` dependsOn=[${event.dependsOn.map((d) => sanitizeAnsiLine(d)).join(",")}]`
      : ""
    const rev = event.revision !== undefined ? ` r${event.revision}` : ""
    // P1.5: COMPLETED tanpa verification passed bukan PASS. Tandai eksplisit.
    const verify =
      raw === "COMPLETED"
        ? event.taskVerification?.verdict === "passed"
          ? " [verified]"
          : ` [${event.taskVerification?.verdict ?? "unverified"}]`
        : ""
    const line = `${glyphs.bullet} ${sanitizeAnsiLine(id)} ${status}${parent}${deps}${rev}${verify}`
    const paint =
      raw === "FAILED"
        ? c.error(line)
        : raw === "BLOCKED"
          ? c.warning(line)
          : raw === "COMPLETED"
            ? c.success(line)
            : c.muted(line)
    this.append(paint, {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  private turnSummary(summary: UiPresentationEvent["summary"], event: UiPresentationEvent): void {
    if (!summary) return
    // Renderer flat: ringkasan turn/ckpt tidak dirender (derau).
    if (FLAT_RENDERER) return
    const snapshot = this.presentationSnapshot()
    const turn = snapshot
      ? (this.policy?.matchTurn(snapshot.turns, summary) ??
        snapshot.turns.find((candidate) => {
          const value = candidate.summary
          return (
            value?.toolsOk === summary.toolsOk &&
            value?.toolsFailed === summary.toolsFailed &&
            value?.toolsDenied === summary.toolsDenied &&
            value?.filesChanged === summary.filesChanged
          )
        }))
      : undefined
    const turnId =
      event.turnId ?? turn?.turnId ?? snapshot?.turns[snapshot.turns.length - 1]?.turnId ?? 0
    if (event.turnId !== undefined) {
      if (this.summarizedTurns.has(event.turnId)) return
      this.summarizedTurns.add(event.turnId)
    }
    // Rakit per bagian dan LEWATI counter nol: baris lama selalu mencetak
    // "0 dibatalkan · 0 terhenti" sehingga angka yang berarti tenggelam — dan
    // ckpt "—" hanya menambah derau ketika turn tak membuat checkpoint.
    const parts = [t("ts.turnHead", { turn: turnId })]
    const counters: { value: number | undefined; key: TurnCountKey }[] = [
      { value: summary.toolsOk, key: "ts.turnOk" },
      { value: summary.toolsFailed, key: "ts.turnFailed" },
      { value: summary.toolsDenied, key: "ts.turnDenied" },
      { value: summary.toolsCancelled, key: "ts.turnCancelled" },
      { value: summary.toolsInterrupted, key: "ts.turnInterrupted" },
      { value: summary.filesChanged, key: "ts.turnFiles" },
    ]
    for (const { value, key } of counters) {
      if (value != null && value > 0) parts.push(t(key, { n: value }))
    }
    if (summary.checkpointId) parts.push(t("ts.turnCkpt", { id: summary.checkpointId }))
    parts.push(formatElapsed(summary.durationMs))
    const line = parts.join(` ${glyphs.dot} `)
    this.append(c.muted(line), {
      kind: "system",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    })
  }

  /**
   * Formatter rekap aktivitas — SATU sumber angka/diksi untuk rekap per-segmen
   * (`flushActivityFold`) maupun rekap kumulatif akhir turn (`flushTurnTotal`).
   * Memisahkan keduanya akan membuat hitungan di tengah turn beda dengan akhir
   * turn.
   *
   * Kategori DIHITUNG dari NAMA INTERNAL (`rawName`), bukan label manusiawi.
   * Label ("baca berkas"/"read file") hanya tampilan di `line` ledger — memakai
   * label untuk mengategorikan akan menggeser rekap `2 command · 118 read`.
   */
  private formatFoldSummary(fold: readonly { rawName: string }[]): string {
    const counts: Record<CompactToolCategory, number> = {
      command: 0,
      edit: 0,
      read: 0,
      subagent: 0,
      thought: 0,
      other: 0,
    }
    for (const entry of fold) counts[compactToolCategory(entry.rawName)]++
    // v7.42: angka lebih terang (c.info) dari label kategori (c.gray, abu
    // lebih gelap) — hierarki visual tanpa `+` di depan (permintaan user).
    // Di mono kedua token jadi polos; gray pakai `dim` agar tetap lebih redup.
    const parts = COMPACT_CATEGORY_ORDER.filter((cat) => counts[cat] > 0).map((cat) => {
      const label = `${c.info(String(counts[cat]))} ${c.gray(t(`ts.toolCategory.${cat}`))}`
      // v0.33: icon agent di belakang label subagent (bukan di depan angka)
      // supaya format "N subagent" tetap stabil untuk test & pembaca.
      // Tanpa ikon `✦` — rekap ini indeks ringkas di chat, bukan agregat status.
      // Ikon agregat tetap milik baris `formatAgentProgress`.
      return label
    })
    if (parts.length === 0) return ""
    // Baris kategori (tanpa prefix simbol) menandai rekap sebagai EKOR dari segmen
    // yang baru saja lewat, bukan baris tool baru. Urutan footer:
    // `tool → narasi → rekap → tool → …`.
    return parts.join(` ${c.faint(glyphs.dot)} `)
  }

  /** Tutup satu segmen narasi → tepat SATU baris rekap.
   * Dulu slot live menulis dua baris dan flush menulis tiga baris supaya tinggi
   * ekor net-nol. Slot live sudah dihapus, jadi aturan "dua baris net-nol" tak
   * berlaku lagi — satu baris permanen saja. */
  private flushActivityFold(): void {
    const fold = this.activityFold
    this.activityFold = []
    if (fold.length === 0) return
    const summary = this.formatFoldSummary(fold)
    if (!summary) return
    this.lastRecapText = summary
    // Simpan id baris ini: `flushTurnTotal()` akan MENIMPA teksnya dengan rekap
    // kumulatif (bukan menambah baris) bila angkanya berbeda. `append()` biasa
    // dulu menghasilkan dua baris rekap bertumpuk di akhir turn.
    this.recapRowId = this.appendWithId(summary, { kind: "system", rekap: true })
    this.recapJustWritten = true
  }

  /**
   * Rekap AKHIR TURN = KUMULATIF semua tool selama turn. Sumbernya
   * `turnToolNames` (bukan `activityFold` yang sudah dikosongkan flush segmen
   * terakhir), supaya angka akhir tetap mencakup tool yang sudah terpotong
   * oleh narasi di tengah turn. Akumulator dikosongkan setelah emit agar jalur
   * turn-end ganda (bus `turn:completed` + presentation `turn.completed`)
   * idempoten — satu baris, bukan dua.
   */
  private flushTurnTotal(): void {
    if (this.turnToolNames.length === 0) return
    const summary = this.formatFoldSummary(this.turnToolNames.map((rawName) => ({ rawName })))
    this.turnToolNames = []
    if (!summary) return
    // Bila segmen terakhir sudah menulis rekap yang sama persis, jangan ulangi —
    // rekap kumulatif tetap benar (sudah tertera), hanya tanpa baris ganda.
    if (summary === this.lastRecapText) return
    this.lastRecapText = summary
    // Timpa rekap SEGMEN terakhir dengan angka kumulatif — jangan append baris
    // baru. Kalau baris itu sudah ter-evict (TRANSCRIPT_CAP), fallback append.
    if (this.recapRowId === null || !this.replaceEntry(this.recapRowId, summary)) {
      // Fallback saat baris rekap lama sudah ter-evict: meta HARUS ikut
      // `rekap:true` supaya `copyTurnTexts()` tetap mengenalinya sebagai laporan.
      this.append(summary, { kind: "system", rekap: true })
    }
    this.recapRowId = null
    this.recapJustWritten = true
  }

  /** Fase 1 perf (butir 2): daftar activity running per snapshot (memoized). */
  private runningActivities(snapshot: UiPresentationSnapshot): UiPresentationActivity[] {
    if (this.runningMemo && this.runningMemo.snapshot === snapshot) {
      return this.runningMemo.running
    }
    // Aktivitas yang terminalnya SUDAH tercetak tak boleh muncul lagi sebagai
    // baris `running` — dua permukaan (committed vs live) dulu bisa dobel
    // untuk toolCallId yang sama saat bridge/reducer lag.
    const running = snapshot.activities.filter(
      (a) => a.status === "running" && !(a.toolCallId && this.presentedTerminals.has(a.toolCallId)),
    )
    this.runningMemo = { snapshot, running }
    return running
  }

  /** Satu baris live untuk activity running — format SAMA persis dengan
   *  implementasi tail lama supaya test/parity tak bergeser. Dipakai tail
   *  viewport maupun `liveRows()` untuk overlay. */
  private runningLine(activity: UiPresentationActivity, child: boolean, marker: string): string {
    const name = sanitizeAnsiLine(activity.name)
    const target = activity.target
      ? ` ${truncateToWidth(sanitizeAnsiLine(activity.target), 120, "")}`
      : ""
    const elapsed = Date.now() - activity.tsStart
    const showElapsed = this.policy
      ? this.policy.elapsedVisible(activity.tsStart, Date.now())
      : elapsed >= 2000
    const elapsedText = showElapsed ? ` (${formatElapsed(elapsed)})` : ""
    const retry = activity.supersedes ? ` ${t("ts.retry")}` : ""
    const markerText = marker ? `${marker} ` : ""
    // v0.43: margin 3 milik FRAME. Indent 2 kolom anak tetap jadi hierarki.
    const prefix = child ? `  ↳ ` : `${glyphs.arrow} `
    return c.info(
      `${prefix}${markerText}${name}${target} … ${t("ts.statusRunning")}${elapsedText}${retry}`,
    )
  }

  /** Urutan baris live: root + anaknya, lalu anak yatim (sama seperti dulu). */
  private orderedRunning(snapshot: UiPresentationSnapshot): {
    activity: UiPresentationActivity
    child: boolean
    marker: string
  }[] {
    const running = this.runningActivities(snapshot)
    const roots = running.filter((a) => !a.parentToolCallId)
    const out: { activity: UiPresentationActivity; child: boolean; marker: string }[] = []
    for (const activity of roots) {
      out.push({ activity, child: false, marker: "" })
      for (const child of running.filter((a) => a.parentToolCallId === activity.toolCallId))
        out.push({ activity: child, child: true, marker: runMarker(child) })
    }
    for (const activity of running) {
      if (
        !activity.parentToolCallId ||
        roots.some((r) => r.toolCallId === activity.parentToolCallId)
      )
        continue
      out.push({ activity, child: true, marker: runMarker(activity) })
    }
    return out
  }

  /** Baris live transien untuk tail viewport — TIDAK masuk `lines[]`.
   *  Cukup 3 aktivitas terakhir supaya narasi tetap tampil; detail lengkap
   *  tetap di jurnal/`--verbose`. */
  private runningRows(): string[] {
    const snapshot = this.presentationSnapshot()
    if (!snapshot) return []
    return this.orderedRunning(snapshot)
      .map(({ activity, child, marker }) => this.runningLine(activity, child, marker))
      .slice(-MAX_LIVE_TAIL_ROWS)
  }

  /**
   * Baris aktivitas live transien untuk overlay — TIDAK masuk `lines[]`/proyeksi.
   * Murni pembaca snapshot: tanpa mutasi state, tanpa effect pada `size()`/`total()`.
   * Kosong bila tak ada tool running. Urutan root → anak → anak yatim sama
   * dengan tail lama (`runningRows()`).
   */
  liveRows(width: number): string[] {
    const w = Math.max(10, width)
    const snapshot = this.presentationSnapshot()
    if (!snapshot) return []
    return this.orderedRunning(snapshot).map(({ activity, child, marker }) =>
      padToWidth(truncateToWidth(this.runningLine(activity, child, marker), w, ""), w),
    )
  }

  private append(line: string, meta: TranscriptMeta = { kind: "system" }): void {
    this.appendWithSource(line, meta, stripSgr(sanitizeAnsi(line)))
  }

  /** Seperti `append`, tetapi MENGEMBALIKAN id baris — dipakai baris yang
   * nanti diperbarui di tempat (ringkasan thinking per turn). */
  private appendWithId(line: string, meta: TranscriptMeta): number {
    const id = this.nextId
    this.append(line, meta)
    return id
  }

  /**
   * Ganti teks baris yang sudah ada TANPA menambah tinggi transkrip.
   *
   * KENAPA bukan append: baris ringkasan thinking diperbarui setiap segmen
   * penalaran (bisa puluhan kali per turn). Kalau tiap pembaruan jadi baris
   * baru, transkrip penuh fragmen `+ thinking · N lines` dan konten bergeser
   * terus — keluhan "thinking bocor" dan "teks naik-turun".
   */
  private replaceEntry(
    id: number,
    line: string,
    metaPatch?: Partial<Pick<TranscriptMeta, "status">>,
  ): boolean {
    const index = this.ids.indexOf(id)
    if (index < 0) return false
    this.lines[index] = line
    // v0.43: `meta` dipertahankan (penanda `rekap:true`, turnId, seq tetap
    // utuh); hanya patch eksplisit (mis. `status: "completed"` saat retry
    // sukses menimpa baris gagal) yang diperbarui agar metadata tak basi.
    if (metaPatch && this.meta[index]) {
      this.meta[index] = { ...this.meta[index]!, ...metaPatch }
    }
    // sourceTexts ikut disinkronkan: tanpa ini `copyTurnTexts()` akan menyalin
    // rekap SEGMEN yang basi, bukan angka kumulatif yang benar-benar tampil.
    this.sourceTexts.set(id, stripSgr(sanitizeAnsi(line)))
    // Satu penulis: replaceAt menjaga counts/rows tiap lebar tetap sinkron.
    this.rowCache.delete(id)
    this.replaceAt(id)
    this.runningMemo = null
    return true
  }

  private appendWithSource(
    line: string,
    meta: TranscriptMeta,
    sourceText: string,
    sourcePrefix = "",
  ): void {
    this.appendEntry(line, null, meta, sourceText, sourcePrefix)
  }

  private appendTable(table: MarkdownTable, meta: TranscriptMeta = { kind: "assistant" }): void {
    const sourceText = [table.headers, ...table.rows].map((row) => row.join("\t")).join("\n")
    this.appendEntry(table.source, table, { ...meta, table }, sourceText, "")
  }

  private appendEntry(
    line: string,
    table: MarkdownTable | null,
    meta: TranscriptMeta,
    sourceText: string,
    sourcePrefix: string,
  ): void {
    // Penanda jeda rekap dikonsumsi entri PERTAMA setelah rekap — bisa blank
    // yang disisipkan `appendAssistantText`, bisa entri non-narasi (tool/user).
    // `flushActivityFold`/`flushTurnTotal` menyetelnya lagi SETELAH menulis.
    this.recapJustWritten = false
    const id = this.nextId++
    const order = this.nextOrder++
    this.lines.push(line)
    this.tables.push(table)
    this.ids.push(id)
    this.sourcePrefixes.push(sourcePrefix)
    this.sourceTexts.set(id, sourceText)
    this.sourceOrders.set(id, order)
    this.meta.push(meta)
    this.totalAppended++
    if (!this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP) {
      const overflow = this.lines.length - TRANSCRIPT_CAP
      const removed = this.ids.splice(0, overflow)
      for (const removedId of removed) {
        this.rowCache.delete(removedId)
        this.sourceTexts.delete(removedId)
        this.assistantDisplay.delete(removedId)
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(0, overflow)
      this.tables.splice(0, overflow)
      this.sourcePrefixes.splice(0, overflow)
      this.meta.splice(0, overflow)
      this.evicted += overflow
      this.lines.unshift(c.muted(t("ts.evictMarker", { n: this.evicted })))
      this.tables.unshift(null)
      this.ids.unshift(-1)
      this.sourcePrefixes.unshift("")
      this.meta.unshift({ kind: "system" })
      this.hasEvictMarker = true
      this.applyEvict(overflow, true)
    }
    if (this.hasEvictMarker && this.lines.length > TRANSCRIPT_CAP + 1) {
      const overflow = this.lines.length - (TRANSCRIPT_CAP + 1)
      const removed = this.ids.splice(1, overflow)
      for (const removedId of removed) {
        this.rowCache.delete(removedId)
        this.sourceTexts.delete(removedId)
        this.assistantDisplay.delete(removedId)
        this.sourceOrders.delete(removedId)
      }
      this.lines.splice(1, overflow)
      this.tables.splice(1, overflow)
      this.sourcePrefixes.splice(1, overflow)
      this.meta.splice(1, overflow)
      this.evicted += overflow
      this.lines[0] = c.muted(t("ts.evictMarker", { n: this.evicted }))
      // Marker ikut tumbuh digit (9→10): sinkronkan proyeksi di lebar mana pun,
      // kalau tidak counts/rows basi saat marker melebar.
      this.replaceAt(this.ids[0] ?? -1)
      this.applyEvict(overflow, false)
    }
    // Baris baru selalu masuk ke UJUNG proyeksi — O(1) per lebar, tanpa rebuild.
    this.applyAppend()
  }
}
