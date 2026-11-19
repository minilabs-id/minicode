// Transkrip TUI — kolektor append-only event bus menjadi baris logis.
//
// Kenapa kelas sendiri: App butuh sumber kebenaran tunggal untuk viewport
// (paint, scroll, resize) yang terpisah dari pengambilan input. Menyimpan
// baris LOGIS (tanpa wrap) supaya resize me-wrap ulang saat paint — lebar
// terminal dibaca saat paint, bukan saat event (kontrak I11).
//
// Mode compact saja di Fase 1: teks model mengalir, ledger tool satu baris
// `  › nama target` (grammar sama dengan REPL), error merah satu baris.
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
import { paintLedger, runMarker, statusWord } from "../render/ledger.ts"
import { parseFence, renderInline } from "../render/markdown.ts"
import {
  computeAssistantLineLayout,
  effectiveAssistantMargin,
  formatAssistantSpacing,
} from "../render/markdown-layout.ts"
import { type MarkdownTable, parseMarkdownBlocks } from "../render/markdown-table.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { renderMarkdownTable } from "../render/table-grid.ts"
import { c, glyphs } from "../render/theme.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { defaultUiState, type UiSessionState } from "../session-state.ts"

// Renderer flat: semua dekorasi non-esensial (panel, lipatan, ringkasan turn,
// area thinking) sengaja dimatikan. Jejak aktivitas = baris tool live saat turn
// berjalan + SATU baris ringkas kategori di akhir turn (separator antar turn),
// seperti TUI OpenCode — tanpa kotak/grup.
const FLAT_RENDERER = true

type CompactToolCategory = "command" | "edit" | "read" | "subagent" | "thought" | "other"

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

/** Ratakan jeda: maksimal SATU baris kosong beruntun antar blok transkrip. */
function normalizeBlankRuns(rows: TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = []
  for (const row of rows) {
    if (row.text === "" && out[out.length - 1]?.text === "") continue
    out.push(row)
  }
  return out
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

function renderAssistantLine(line: string, fenceState: FenceState): string | null {
  if (fenceState === "boundary") return null
  if (fenceState.startsWith("open:")) {
    // Penanda bahasa memakai bar yang SAMA dengan isi blok (bukan `·`) supaya
    // tak terbaca sebagai poin daftar di atas blok kode.
    const lang = fenceState.slice(5)
    return lang ? c.dim(`${glyphs.vLine} ${lang}`) : null
  }
  if (fenceState === "inside") return line
  if (!/(?:\*{1,2}|`|^#{1,6}\s|~~|\[[^\]]+\]\()/.test(line)) return line
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) return c.bold(renderInline(heading[2] ?? ""))
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
  private rowCache = new Map<number, ProjectedLineCache>()
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
  private presentedVerifications = new Set<string>()
  // v7.40: dedup finding dari child report (`finding.detected` / `[EVALUATE]`)
  // — event bisa datang ulang dari bridge/replay, jadi satu finding = satu baris.
  private presentedFindings = new Set<string>()
  private summarizedTurns = new Set<number>()
  /** Lipat aktivitas (minimizeActivity): baris ledger per-tool ditahan dulu,
   * lalu saat turn selesai dirangkum jadi SATU baris (opencode-like) + detail
   * di-buffer untuk /expand. */
  private activityFold: { name: string; status: string; line: string }[] = []
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
  private committedProjection: {
    width: number
    totalAppended: number
    rows: TranscriptRow[]
  } | null = null
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
  private projectedBase: {
    width: number
    totalAppended: number
    pendingVersion: number
    pendingTruncated: boolean
    rows: TranscriptRow[]
  } | null = null
  /** Naik setiap `this.pending` berubah (stream/commit/invalidated/clear). */
  private pendingVersion = 0

  constructor(bus: UiBus, opts: TranscriptOptions = {}) {
    this.getSnapshot = opts.getSnapshot
    this.policy = opts.policy
    this.uiState = opts.uiState ?? defaultUiState
    this.maxPendingChars = Math.max(1, opts.maxPendingChars ?? TRANSCRIPT_TEXT_MAX_CHARS)
    // Gagal subscribe = transcript mati total; biarkan throw (fail-closed).
    this.unsubs = [
      bus.on("provider:text", (e: { text: string }) => this.stream(e.text)),
      bus.on("turn:started", () => {
        this.commit()
        // Akhiri akumulasi thinking turn sebelumnya: turn baru = baris baru.
        this.commitThinking(true)
        // Angka total dinolkan DI SINI (bukan saat turn ditutup) supaya baris
        // turn yang baru selesai tetap menunjukkan panjangnya sendiri. Tanpa
        // reset ini, turn kedua melanjutkan hitungan turn pertama dan
        // melaporkan "4 lines" untuk penalaran 2 baris.
        this.thinkingTurnRows = 0
        this.activityFold = []
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
    // v7.37 — POTONG PER SEGMEN. `pending` kosong berarti narasi sebelumnya
    // sudah di-commit (tool event menyebut `commit()`). Bila `activityFold`
    // masih berisi tool dari segmen itu, flush SEKARANG sebagai baris permanen
    // tepat di bawah narasi lama, lalu kosongkan — segmen baru mulai dengan
    // hitungan bersih. Tanpa ini v7.36 mengumpulkan semua tool sepanjang turn
    // dalam satu baris ekor (keluhan: "gak di-cut off tiap paragraf laporan").
    if (this.pending.length === 0 && this.activityFold.length > 0) this.flushActivityFold()
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
          this.append(c.thinking(`  ${parts[i] ?? ""}`), { kind: "diagnostic" })

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
        // Detail penuh tidak hilang: masuk buffer `/expand`.
        this.uiState.rememberCollapsedSection("thinking", lines.join("\n"))
        // ── Satu baris thinking per TURN, bukan per segmen ──────────────────
        // `execution:started` menyala setiap tool call, jadi model yang pola
        // pikirannya pendek-pendek menghasilkan deretan `+ thinking · 3 lines`
        // berulang tanpa jeda (keluhan "jendela thinking bocor / semrawut").
        // Segmen berikutnya dalam turn yang sama menambah HITUNGAN pada baris
        // yang sama alih-alih mencetak baris baru: pembaca melihat total
        // panjang penalaran turn itu, bukan sepuluh fragmen.
        this.thinkingTurnRows += lines.length
        const label = c.thinking(
          `  + ${t("panel.thinking")} · ${t("panel.lines", { n: this.thinkingTurnRows })}`,
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
      // Tetap simpan thinking tersembunyi ke buffer `/expand` sebelum reset
      // agar user tetap bisa membuka proses berpikir jika diperlukan.
      if (this.thinkingBuf) this.uiState.rememberCollapsedSection("thinking", this.thinkingBuf)
      this.thinkingBuf = ""
      this.thinkingTail = ""
      this.thinkingArea = []
      return
    }
    if (this.thinkingTail) {
      this.append(c.thinking(`  ${this.thinkingTail}`), { kind: "diagnostic" })
      this.thinkingTail = ""
    }
    this.thinkingBuf = ""
    this.thinkingArea = []
  }

  /** Dorong baris logis (sudah final, mis. gema prompt user). */
  push(line: string, meta: TranscriptMeta = { kind: "system" }): void {
    this.commit()
    this.append(line, meta)
  }

  /** Gema prompt user ala shell: `minicode › baris-1`, lanjutan menjorok. */
  pushUser(prompt: string): void {
    const rows = sanitizeAnsi(prompt).split("\n")
    const [first, ...rest] = rows
    this.commit()
    // Jeda visual lembut sebelum prompt user berikutnya agar batas giliran
    // terbaca cepat di transkrip panjang (baris awal sesi tidak diberi jeda).
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.append("", { kind: "system" })
    }
    const arrow = glyphs.arrow
    this.appendWithSource(
      `${c.accent("minicode")} ${c.muted(arrow)} ${first ?? ""}`,
      { kind: "user" },
      first ?? "",
      `minicode ${arrow} `,
    )
    for (const r of rest) this.appendWithSource(`  ${r}`, { kind: "user" }, r, "  ")
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
    const blocks = parseMarkdownBlocks(sanitizeAnsi(lines.join("\n")))
    if (blocks.length === 0) {
      for (const line of lines) this.append(line)
      return
    }
    for (const block of blocks) {
      if (block.type === "table") this.appendTable(block.table, { kind: "system" })
      else {
        for (const line of block.text.split("\n")) this.append(line)
      }
    }
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
    this.committedProjection = null
    this.pendingProjection = null
    this.projectedBase = null
    this.pendingVersion = 0
    this.presentedTerminals.clear()
    this.presentedVerifications.clear()
    this.presentedFindings.clear()
    this.summarizedTurns.clear()
    this.activityFold = []
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
    const outerMargin = markdown ? effectiveAssistantMargin(w) : 0
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
    const rendered = renderMarkdownTable(table, Math.max(1, width), renderInline)
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
    // Tabel kotak diawali margin kiri (spasi); lewati dari displayStart dan sertakan
    // plainBody agar seleksi & highlight pakai pemetaan kolom layar, bukan tab source.
    const outerCols = effectiveAssistantMargin(Math.max(1, width))
    const marginPrefix = outerCols > 0 ? " ".repeat(outerCols) : ""
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
      const rowDisplayStart = marginPrefix && plain.startsWith(marginPrefix) ? outerCols : 0
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
    let open = false
    let char = ""
    let len = 0
    return (line: string): FenceState => {
      const fence = parseFence(line)
      if (!open && fence) {
        open = true
        char = fence.char
        len = fence.len
        return fence.lang ? `open:${fence.lang}` : "boundary"
      }
      if (open && fence && fence.char === char && fence.len >= len) {
        open = false
        return "boundary"
      }
      return open ? "inside" : "outside"
    }
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

  private projectAll(width: number): TranscriptRow[] {
    const w = Math.max(10, width)
    const thinking = this.thinkingRows(w)
    const running = this.runningRows()
    const panel = this.panelRows()
    // Kasus umum (idle ketik/scroll — thinking tau cara running kosong):
    // kembalikan gabungan committed+pending yang ter-cache TANPA menyalin ulang.
    // Ini memberantas biaya concat O(N) pada setiap paint (biaya yang TUMBUH
    // seiring transkrip menumpuk — tepat gejala "mengetik berat saat history penuh").
    // v7.36: aktifnya `activityFold` juga memaksa jalur segar — baris ringkas
    // live harus ikut berubah setiap kali tool selesai, bukan tersangkut di
    // cache `projectedBase` yang hanya dikunci oleh pending/committed.
    if (
      !this.thinkingTail &&
      thinking.length === 0 &&
      running.length === 0 &&
      panel.length === 0 &&
      this.activityFold.length === 0
    ) {
      if (
        this.projectedBase &&
        this.projectedBase.width === w &&
        this.projectedBase.totalAppended === this.totalAppended &&
        this.projectedBase.pendingVersion === this.pendingVersion &&
        this.projectedBase.pendingTruncated === this.pendingTruncated
      ) {
        return this.projectedBase.rows
      }
      const base: TranscriptRow[] = this.projectRows([
        ...this.committedRows(w),
        ...this.pendingRows(w),
      ])
      this.projectedBase = {
        width: w,
        totalAppended: this.totalAppended,
        pendingVersion: this.pendingVersion,
        pendingTruncated: this.pendingTruncated,
        rows: base,
      }
      return base
    }
    // thinking/running aktif: bangun segar (jarang — hanya saat turn berjalan,
    // dan repaint-nya sudah dicoalesce 30ms, bukan per-keypress).
    // Urutan: committed → activity (thinking/running/panel) → pending. Jawaban di
    // ekor agar jangkar stabil saat streaming (activity mendorong histori, bukan jawaban).
    const rows: TranscriptRow[] = [...this.committedRows(w)]
    if (!FLAT_RENDERER && !this.thinkingAreaMode() && this.thinkingTail) {
      for (const chunk of this.thinkingTail.split("\n")) {
        const chunkRows = chunk === "" ? [""] : wrapByWidth(chunk, w)
        for (const row of chunkRows) {
          rows.push({
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
    // Mode legacy sudah menaruh thinking-nya di atas (stream per baris).
    rows.push(...thinking)
    // Baris tool yang SEDANG berjalan (dari snapshot). Panel aktivitas hanya
    // memuat tool TERMINAL (fold), jadi running tetap punya barisnya sendiri —
    // tak ada duplikasi, dan tool yang belum selesai tidak pernah hilang.
    for (const row of running) {
      rows.push({
        text: row,
        sourceId: -1,
        sourceStart: 0,
        sourceEnd: 0,
        displayStart: 0,
        displayEnd: displayWidth(row),
        selectable: false,
      })
    }
    // Panel aktivitas (Fase 2): baris grup tool terminal — tampil di bawah
    // running, di atas jawaban (pending). Hanya saat ada activity.
    rows.push(...panel)
    // Jawaban streaming berada di ekor (di bawah semua activity turn berjalan).
    rows.push(...this.pendingRows(w))
    // v7.36: status/jumlah + daftar tool ditaruh tepat SETELAH narasi, bukan
    // di footer dan bukan baru saat turn tutup. Jangkar narasi tetap stabil
    // karena baris ini mengikuti ekor pending, bukan mendorongnya.
    rows.push(...this.liveSummaryRows(w))
    return this.projectRows(rows)
  }

  /** v7.29: prompt user TIDAK disembunyikan lagi — ia adalah history di transkrip. */
  private projectRows(rows: TranscriptRow[]): TranscriptRow[] {
    return normalizeBlankRuns(rows)
  }

  /** Proyeksi baris ter-commit (Fase 1 perf butir 3). Di-cache per (width,
   * totalAppended): totalAppended monotonik dan hanya naik saat baris baru
   * masuk/evict, jadi paint idle (ketik/scroll) tidak mengulang iterasi 5000
   * baris + parseFence. Cache disamakan objeknya, hasil dipakai read-only. */
  private committedRows(w: number): TranscriptRow[] {
    if (
      this.committedProjection &&
      this.committedProjection.width === w &&
      this.committedProjection.totalAppended === this.totalAppended
    ) {
      return this.committedProjection.rows
    }
    const rows: TranscriptRow[] = []
    const committedFence = this.fenceTracker()
    for (let i = 0; i < this.lines.length; i++) {
      const table = this.tables[i] ?? null
      const id = this.ids[i] ?? -1
      const raw = this.lines[i] ?? ""
      const assistant = this.meta[i]?.kind === "assistant"
      const fenceState = assistant ? committedFence(raw) : "outside"
      const source = this.sourceTexts.get(id) ?? ""
      const prefix = this.sourcePrefixes[i] ?? ""
      const cached = this.rowCache.get(id)
      if (
        cached &&
        cached.width === w &&
        cached.id === id &&
        cached.raw === raw &&
        cached.assistant === assistant &&
        cached.source === source &&
        cached.prefix === prefix &&
        cached.table === table &&
        cached.fenceState === fenceState
      ) {
        rows.push(...cached.rows)
        continue
      }
      const produced = table
        ? this.projectTable(table, id, w)
        : this.projectText(raw, source, id, w, true, prefix, assistant, fenceState)
      this.rowCache.set(id, {
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
      rows.push(...produced)
    }
    this.committedProjection = { width: w, totalAppended: this.totalAppended, rows }
    return rows
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
        text: c.muted(TRANSCRIPT_TRUNCATION_MARKER),
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

  wrappedLength(width: number): number {
    return this.projectAll(width).length
  }

  viewport(width: number, height: number, scrollBack: number): TranscriptViewport {
    const wrapped = this.projectAll(width)
    const safeHeight = Math.max(1, Math.floor(height))
    // v7.28: anchor ATAS (OpenCode-style). `scrollBack = 0` kini berarti
    // kepala/awal percakapan; nilai besar bergerak ke bawah (lebih baru).
    // Saat konten lebih pendek dari viewport, baris kosong ditaruh DI BAWAH
    // (push), bukan di atas — pesan mulai dari baris pertama, composer tetap
    // di bawah. Tail-follow sudah ditangani App lewat `scrollBack`.
    const maxBack = Math.max(0, wrapped.length - safeHeight)
    const back = Math.max(0, Math.min(scrollBack, maxBack))
    const firstIndex = back
    const rows = wrapped.slice(firstIndex, firstIndex + safeHeight)
    while (rows.length < safeHeight) {
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
    return { rows, firstIndex, totalRows: wrapped.length }
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
    // Pisahkan jawaban dari thinking/diagnostik tepat di atasnya dengan satu
    // baris kosong — supaya "berpikir" tidak nempel ke jawaban.
    if (this.lastKind() === "diagnostic") this.append("", { kind: "assistant" })
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
      // `summary` di sini adalah string (finding), tapi union UiPresentationEvent
      // punya `summary: UiTurnSummary` di tipe lain → bantu TS narrowing.
      const text = sanitizeAnsiLine((event.summary as unknown as string) ?? "")
      if (!text) return
      this.presentedFindings.add(id)
      // "diagnostic" = baris observasi, bukan percakapan (lihat TranscriptMeta).
      this.append(truncateToWidth(text, 200, "…"), { kind: "diagnostic" })
      return
    }
    if (!event.type.startsWith("tool.")) return
    if (event.type === "tool.started") {
      this.commit()
      this.commitThinking()
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
    // F-AGENT-1: baris per-run HANYA bila activity membawa identitas run anak
    // (childSessionId/runId — data nyata dari ChildSessionLink). Tool anak yang
    // cuma punya `parentToolCallId` (jalur grouping legacy) tetap SEPENUHNYA
    // ditelan hitungan induk "n child tools" — kontrak P5 satu baris ledger
    // induk. `parentToolCallId` = taut ke pemanggil, BUKAN identitas run; jangan
    // disamakan dengan childSessionId/runId.
    if (activity?.parentToolCallId) {
      if (activity.childSessionId || activity.runId) this.childLedger(event, activity)
      return
    }
    // v7.29: satu baris kosong MEMISAHKAN narasi (yang baru saja di-commit)
    // dari baris tool — seperti `marginTop=1` OpenCode. Hanya sekali per
    // transisi, bukan tiap tool: consecutive tools tetap rapat. `normalizeBlankRuns`
    // menjamin maksimal satu blank walau jalur lain menyisipkan juga.
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.append("", { kind: "assistant" })
    }
    this.commit()
    const snapshot = this.presentationSnapshot()
    const children = activity
      ? (snapshot?.activities ?? []).filter((a) => a.parentToolCallId === activity.toolCallId)
          .length
      : 0
    // Keputusan node dari policy kanonik bila di-inject; paint/sanitasi tetap
    // di sini. Tanpa policy = logika inline legacy (rollback flag).
    const desc =
      this.policy && activity
        ? this.policy.describeActivity(activity, { childCount: children })
        : undefined
    const name = sanitizeAnsiLine(desc?.name ?? activity?.name ?? event.name ?? "tool")
    const target = desc?.target ?? activity?.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = desc?.status ?? activity?.status ?? event.status ?? "completed"
    const retry = (desc ? desc.retryOf : activity?.supersedes) ? ` ${t("ts.retry")}` : ""
    const child = children > 0 ? ` ${t("ts.childGroup", { n: children })}` : ""
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
    const message = errorMessage
      ? `: ${truncateToWidth(sanitizeAnsiLine(firstLine), 200, "…")}`
      : denyReason
        ? `: ${truncateToWidth(sanitizeAnsi(denyReason), 200, "…").split("\n")[0] ?? ""}`
        : ""
    // Format ledger: `› nama target` (kontrak grammar). Kata status HANYA
    // dicetak saat bukan sukses: baris sukses berwarna hijau sudah menyatakan
    // hasilnya, dan "selesai" di setiap baris membuat daftar tool jadi derau.
    const statusSuffix = status === "completed" ? "" : ` ${glyphs.dot} ${statusWord(status)}`
    const line = `  ${glyphs.arrow} ${name}${targetText}${statusSuffix}${retry}${child}${verificationMark}${provenanceMark}${message}`
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
    if (this.uiState.minimizeActivity || this.uiState.activityPanel) {
      this.activityFold.push({ name, status, line })
      // Yang berhasil sudah diwakili baris grup → tak perlu baris individual.
      if (status === "completed") return
    } else if (FLAT_RENDERER) {
      // Renderer flat: kumpulkan JUGA untuk jejak ringkas akhir turn. Beda
      // dengan mode lipatan, baris live TETAP diprint — ringkasan itu footer,
      // bukan pengganti (kontrak ledger v7.29).
      this.activityFold.push({ name, status, line })
    }
    this.append(paintLedger(status, line), {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity?.expandRef ? { expandRef: activity.expandRef } : {}),
    })
  }

  /** F-AGENT-1: baris terminal tool anak — identitas run + tool + status.
   * Paralel dipisah via runMarker (data aktual runId/childSessionId), bukan
   * hitungan "n tool anak" yang menyatukan run berbeda.
   */
  private childLedger(event: UiPresentationEvent, activity: UiPresentationActivity): void {
    this.commit()
    const marker = runMarker(activity)
    const name = sanitizeAnsiLine(activity.name ?? event.name ?? "tool")
    const target = activity.target ?? event.target
    const targetText = target ? ` ${truncateToWidth(sanitizeAnsiLine(target), 120, "")}` : ""
    const status = activity.status ?? event.status ?? "completed"
    const message =
      status === "failed" && event.message
        ? `: ${truncateToWidth(sanitizeAnsiLine(String(event.message).split(/[\r\n]/)[0] ?? ""), 200, "…")}`
        : ""
    const markerText = marker ? `${marker} ` : ""
    const statusSuffix = status === "completed" ? "" : ` ${glyphs.dot} ${statusWord(status)}`
    const line = `    ↳ ${markerText}${name}${targetText}${statusSuffix}${message}`
    this.append(paintLedger(status, line), {
      kind: "activity",
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      status,
      ...(activity.expandRef ? { expandRef: activity.expandRef } : {}),
    })
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
    const line =
      verification.verdict === "present"
        ? `  ${name}${targetText} verified`
        : `  ? ${name}${targetText} unverified (${verification.verdict})`
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
    const line = `  ${glyphs.bullet} consequence ${sanitizeAnsiLine(verdict)}${rule}${next}${reason}`
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
      const line = `  ${glyphs.bullet} context cutoff${reason}`
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
    const line = `  ${glyphs.bullet} ${sanitizeAnsiLine(id)} ${status}${parent}${deps}${rev}${verify}`
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

  /** Flush aktivitas turn menjadi SATU baris ringkas per kategori tool
   * (`  + 5 command · 3 edit · 1 thought`) + buffer detail untuk /expand.
   *
   * Kenapa satu baris: tool sudah tampil live selama turn lewat
   * `presentationLedger`; baris ini BUKAN pengulangan per-tool melainkan jejak
   * permanen yang sekaligus memisahkan turn/report satu dari yang lain.
   * Tanpa kotak/grup — `panelRows` sengaja tetap mati di renderer flat. */
  /**
   * v7.36: formatter ringkasan aktivitas — SATU sumber angka/diksi yang dipakai
   * baik oleh baris permanen (`flushActivityFold`, saat turn tutup) maupun oleh
   * baris LIVE di bawah narasi (`liveSummaryRows`). Memisahkan keduanya akan
   * membuat count di tengah turn beda dengan count di akhir turn.
   */
  private formatFoldSummary(fold: readonly { name: string }[]): string {
    const counts: Record<CompactToolCategory, number> = {
      command: 0,
      edit: 0,
      read: 0,
      subagent: 0,
      thought: 0,
      other: 0,
    }
    for (const entry of fold) counts[compactToolCategory(entry.name)]++
    const parts = COMPACT_CATEGORY_ORDER.filter((cat) => counts[cat] > 0).map(
      (cat) => `${counts[cat]} ${t(`ts.toolCategory.${cat}`)}`,
    )
    if (parts.length === 0) return ""
    // `+` ASCII aman di mono; warna lewat token c.* ikut mati saat NO_COLOR.
    return `  ${c.accentAlt("+")} ${c.muted(parts.join(` ${glyphs.dot} `))}`
  }

  /**
   * v7.36: baris status/jumlah + daftar tool yang dipakai, dirender LIVE di
   * bawah narasi yang sedang mengalir (bukan baru saat turn tutup). Sumber =
   * `activityFold` yang sudah diisi `presentationLedger` sejak tool pertama.
   *
   * Daftar NAMA tool hanya dipancarkan saat `minimizeActivity`/panel aktif —
   * di mode itu baris per-tool memang ditahan, jadi ini satu-satunya jejak
   * "tool apa yang dipakai". Di mode default baris per-tool sudah live, cukup
   * ringkasan kategori yang ditambah (tanpa duplikasi nama).
   */
  private liveSummaryRows(w: number): TranscriptRow[] {
    const fold = this.activityFold
    if (fold.length === 0) return []
    const summary = this.formatFoldSummary(fold)
    if (!summary) return []
    const lines: string[] = [summary]
    if (this.uiState.minimizeActivity || this.uiState.activityPanel) {
      const names: string[] = []
      for (const entry of fold) {
        const name = sanitizeAnsiLine(entry.name).trim()
        if (name && !names.includes(name)) names.push(name)
      }
      if (names.length > 0) {
        const list = truncateToWidth(
          names.slice(0, 12).join(` ${glyphs.dot} `),
          Math.max(10, w - 10),
          "…",
        )
        // `appr.tool` sudah mengandung titik dua ("Tool:") — jangan ditambah.
        lines.push(`  ${c.muted(t("appr.tool"))} ${c.info(list)}`)
      }
    }
    return lines.map((text) => ({
      text,
      sourceId: -1,
      sourceStart: 0,
      sourceEnd: 0,
      displayStart: 0,
      displayEnd: displayWidth(text),
      selectable: false,
    }))
  }

  private flushActivityFold(): void {
    const fold = this.activityFold
    this.activityFold = []
    if (fold.length === 0) return

    // Detail per-tool TETAP disimpan untuk /expand — tak ada yang dibuang
    // diam-diam walau transkrip permanen hanya membawa satu baris ringkas.
    this.uiState.rememberCollapsedSection("activity", fold.map((e) => e.line).join("\n"))

    const summary = this.formatFoldSummary(fold)
    if (!summary) return

    // Satu blank di atas & bawah supaya ringkasan berdiri sendiri sebagai
    // separator. `normalizeBlankRuns` membatasi maksimal satu blank walau
    // `commit`/`pushUser` ikut menyisipkan jeda di tempat yang sama.
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.append("", { kind: "system" })
    }
    this.append(summary, { kind: "system" })
    this.append("", { kind: "system" })
  }

  /** Fase 1 perf (butir 2): daftar activity running per snapshot (memoized). */
  private runningActivities(snapshot: UiPresentationSnapshot): UiPresentationActivity[] {
    if (this.runningMemo && this.runningMemo.snapshot === snapshot) {
      return this.runningMemo.running
    }
    const running = snapshot.activities.filter((a) => a.status === "running")
    this.runningMemo = { snapshot, running }
    return running
  }

  private runningRows(): string[] {
    const snapshot = this.presentationSnapshot()
    if (!snapshot) return []
    const running = this.runningActivities(snapshot)
    const roots = running.filter((a) => !a.parentToolCallId)
    const row = (activity: (typeof running)[number], child: boolean, marker: string): string => {
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
      const prefix = child ? "    ↳ " : `  ${glyphs.arrow} `
      return c.info(
        `${prefix}${markerText}${name}${target} … ${t("ts.statusRunning")}${elapsedText}${retry}`,
      )
    }
    // F-AGENT-1: tiap run anak = baris sendiri, bukan hitungan "n tool anak".
    const out: string[] = []
    for (const activity of roots) {
      out.push(row(activity, false, ""))
      for (const child of running.filter((a) => a.parentToolCallId === activity.toolCallId))
        out.push(row(child, true, runMarker(child)))
    }
    // Anak yatim (parent tak lagi running/root): tetap tampil, jangan hilang.
    for (const activity of running) {
      if (
        !activity.parentToolCallId ||
        roots.some((r) => r.toolCallId === activity.parentToolCallId)
      )
        continue
      out.push(row(activity, true, runMarker(activity)))
    }
    return out
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
  private replaceEntry(id: number, line: string): boolean {
    const index = this.ids.indexOf(id)
    if (index < 0) return false
    this.lines[index] = line
    this.rowCache.delete(id)
    this.committedProjection = null
    this.projectedBase = null
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
    }
  }
}
