// App TUI — pemilik tunggal layar mode `--tui` (kontrak I17-I20).
//
// Arsitektur: SATU repaint sinkron per event. Tak ada painter lain yang aktif
// bersamaan (turn berjalan = spark pada status bar, bukan painter). Frame
// selalu TEPAT `rows` baris: transkrip viewport + dropdown `/` + blok input +
// status bar. Kursor diparkir di posisi ketik setelah paint.
//
// Batas lapisan: semua yang berbau sesi/model/turn datang via TuiHost yang
// di-inject dari cli/ (composition root). src/ui TAK BOLEH impor cli/.
import type { UiBus, UiPresentationActivity } from "../contract.ts"
import { type FooterStatus, renderFooter, type TimerHighlight } from "../footer.ts"
import { t } from "../i18n/locale.ts"
import {
  applyKey,
  createDecoderState,
  createKeyStreamPump,
  createState,
  type DecoderState,
  type KeyStreamPump,
  type PromptKey,
  type PromptState,
  pointLength,
  toGraphemes,
} from "../input/prompt-engine.ts"
import {
  chatColumnGeometry,
  chatWidth as chatWidthFromGeometry,
  composerWidth as composerWidthFromChat,
} from "../render/chat-column.ts"
import { appendWrapped, shaveWrapped } from "../render/composer-wrap.ts"
import { formatError, friendlyToolErrorCanonical } from "../render/errors.ts"
import { listRow } from "../render/list.ts"
import { ASSISTANT_LEFT_MARGIN } from "../render/markdown-layout.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { c, glyphs, scrimMode, scrimSgr } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import {
  chunkByWidth,
  displayWidth,
  escapeLength,
  padToWidth,
  truncateToWidth,
} from "../render/width.ts"
import { motionReduced } from "../runtime/motion.ts"
import {
  type AltScreen,
  forceRestoreScreenForSignal,
  openAltScreen,
  registerScreenBackdrop,
} from "../runtime/screen.ts"
import type { Transcript, TranscriptPoint, TranscriptRow } from "./transcript.ts"

export interface TuiStatusSnapshot {
  footer: FooterStatus
  busy: boolean
  pinnedActivity?: UiPresentationActivity
}

export interface TuiHost {
  bus: UiBus
  /** Status untuk bar status (mode/model/cwd/konteks dari sumber = footer). */
  getStatus(): TuiStatusSnapshot
  /** Hint dropdown untuk baris "/" (slash + skill, difilter prefix). */
  listCommands(prefix: string): string[]
  /**
   * Eksekusi baris yang di-submit: builtin (/exit, /clear, /help, …) atau
   * prompt ke model. Resolve {quit:true} untuk keluar. Throw = App tampilkan
   * sebagai baris error (tak ada jalur diam).
   */
  submit(text: string): Promise<{ quit?: boolean } | undefined>
  /**
   * Kirim baris saat turn MASIH berjalan (Enter di composer yang hidup).
   * Controller mengantrinya: teks jadi informasi tambahan, slash command aman
   * ditunda sampai turn selesai (mode/UI mutasi butuh idle). `false` = ditolak
   * (command berdampak destruktif, mis. `/clear`), dan controller sudah
   * menjelaskan alasannya lewat toast. Absen = perilaku lama: input beku total
   * saat busy.
   */
  enqueue?(text: string): boolean
  /** Batalkan turn yang berjalan (Esc saat busy). */
  abort(): void
  copySelection(text: string): boolean
  /** Putar WorkMode DISCUSS→PLAN→BUILD (Tab). */
  cycleWorkMode(dir: 1 | -1): void
  /** Toggle PermissionMode AUTO↔ASK (Shift+Tab). */
  togglePermissionMode(): void
  /**
   * Dipertahankan hanya untuk kompatibilitas komposisi/fixture lama. Binding
   * Ctrl+O/Ctrl+T sudah dihapus: renderer flat tak mengonsumsi flag-flag ini,
   * jadi memanggilnya hanya menghasilkan kwitansi palsu.
   */
  toggleCompact(): void
  toggleReasoning(): void
}

export interface TuiRunResult {
  /** False = layar tak mampu; caller reports the refusal and sets a failing exit code. */
  started: boolean
  frames: number
}

/**
 * [retry-visibility] Ringkasan retry penyedia yang dikirim session.ts lewat
 * `provider:extension` kind `minicode:retry`. Didefinisikan ulang di sini
 * (struktural) supaya src/ui tak mengimpor src/app — batas lapisan dijaga
 * `test/ui-boundary.test.ts`.
 */
interface RetryIndicatorState {
  attempt: number
  quota: number
}

/**
 * Retry = MICRO-TOAST, bukan pengganti footer. Angka detik dihitung live dari
 * `retrySince` tiap paint; toast hilang setelah `retryToastUntil` atau turn selesai.
 */
const RETRY_TOAST_MS = 4_000

/**
 * Tinggi blok input FIKS 2 baris saat editing. Draft lebih panjang tidak
 * menambah baris (dan menggeser transkrip): jendela geser `composerOffset`
 * yang mengikuti caret. Kontrak ini menjaga transkrip tak bergeser saat
 * mengetik/paste maupun saat dropdown `/` muncul.
 */
const COMPOSER_MAX_ROWS = 2
/**
 * Tombol yang tetap dilayani saat turn berjalan: penyusun teks + Enter (antre).
 * Semua tombol mode/overlay lain sengaja ditahan (lihat handleKey) supaya
 * tidak ada state UI yang berubah di tengah turn.
 */
const BUSY_TYPING_KEYS = new Set([
  "char",
  "backspace",
  "delete",
  "enter",
  "ctrl-j",
  "ctrl-u",
  "ctrl-w",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
])
/** Tinggi maksimum dropdown — sisa ruang di atas transcript minimum 3 baris. */
const MAX_DROPDOWN_ROWS = 8
const MIN_ROWS = 10
const MIN_COLS = 20

// Prefix adaptif: prefix panjang `minicode ›` memakan 13 kolom (3 margin +
// 10 label), jadi hanya dipakai bila ruang isi `w - 13 >= 24` (w ≥ 37).
// Di bawah itu pakai `›` / `·` supaya ruang wrap tidak termakan label.
// Kedua prefix TANPA spasi trailing supaya caret DECSCUSR menempel di glif
// (`›` / `·`) — klausa v0.36/v7.30. `w` = composerWidth() satu-sumber
// (cap progresif di chat-column.ts); posisi caret memakai displayWidth(pf)+1.
const PROMPT_LONG_PREFIX_COLS = ASSISTANT_LEFT_MARGIN + 10
const PROMPT_MIN_BODY_COLS = 24
const promptLong = (w: number): boolean => w - PROMPT_LONG_PREFIX_COLS >= PROMPT_MIN_BODY_COLS
const promptFirst = (w: number): string =>
  promptLong(w) ? `${" ".repeat(ASSISTANT_LEFT_MARGIN)}minicode ${glyphs.arrow}` : glyphs.arrow
const promptCont = (w: number): string => (promptLong(w) ? `  ${glyphs.dot}` : glyphs.dot)
const TIMER_TEXT = "00.00.00"
const DOT_INTERVAL_MS = 200
/** v7.29: peta laju stream teks → interval kedip spark (sama seperti turn-status). */
const SPARK_INTERVALS = [120, 150, 220, 320] as const
/** Badge job background berputar lebih pelan dari dots (tidak berkedip). */
const WAITING_INTERVAL_MS = 400
const DOT_PHASES = ["...", "..", ".", ".."] as const
const MOUSE_DRAG_ON = "\x1b[?1002h\x1b[?1006h"
const MOUSE_WHEEL_ON = "\x1b[?1000h\x1b[?1006h"
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l"
/**
 * Bracketed paste (DECSET/DECRST 2004): saat aktif terminal membungkus paste
 * dengan `\x1b[200~…\x1b[201~` supaya decoder memperlakukannya sebagai teks
 * (bukan deretan keystroke Ctrl+C/Ctrl+D). Ditulis DI LUAR frame — I1 (satu
 * write per frame) tetap utuh karena ini bukan paint.
 */
const BRACKETED_PASTE_ON = "\x1b[?2004h"
const BRACKETED_PASTE_OFF = "\x1b[?2004l"
const MAX_SELECTION_CHARS = 200_000
/** Batas byte UTF-8 payload salin (selaras `MAX_CLIPBOARD_BYTES` OSC 52 di
 * `assistant/simple.ts`): 200k char CJK bisa 600 KB byte, jadi cek char saja
 * tidak cukup sebelum menulis OSC 52. */
const MAX_SELECTION_BYTES = 256 * 1024

/** Panjang UTF-8 (byte) tanpa alokasi — untuk guard ukuran payload salin. */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}
type MouseMode = "off" | "wheel" | "drag"

function mouseSelectionEnabled(): boolean {
  const value = process.env.MINICODE_MOUSE_SELECTION?.toLowerCase()
  return value !== "0" && value !== "false" && value !== "off" && value !== "no"
}

export function thinkingDots(now = Date.now(), startedAt = now, reduced = motionReduced()): string {
  if (reduced) return "..."
  const elapsed = Math.max(0, now - startedAt)
  return DOT_PHASES[Math.floor(elapsed / DOT_INTERVAL_MS) % DOT_PHASES.length]!
}

export function formatTimer(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, "0")}.${String(minutes).padStart(2, "0")}.${String(rest).padStart(2, "0")}`
}

export function timerHighlight(ms: number): TimerHighlight {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds >= 3600) return "hours"
  if (seconds >= 60) return "minutes"
  return "seconds"
}

/**
 * Indeks awal jendela dropdown yang menjaga item terpilih (`sel`) selalu tampil.
 * Sebelum A1, jendela selalu `slice(0, visible)` sehingga `sel >= visible` tak
 * pernah tersorot tetapi Enter tetap mengirim `hints[sel]` — perintah destruktif
 * yang tak terlihat. Kontrak: untuk `0 <= sel < total` berlaku
 * `start <= sel < start + min(visible, total)`.
 */
export function dropdownWindowStart(sel: number, visible: number, total: number): number {
  const v = Math.max(1, Math.floor(visible))
  if (total <= v) return 0
  return Math.max(0, Math.min(sel - v + 1, total - v))
}

interface FrameLayout {
  frame: string[]
  cursor: { row: number; col: number }
  /** Lebar terminal penuh (footer & popup memakai ini). */
  cols: number
  /** Lebar area chat — maksimal setengah cols saat ter-centre. */
  chatCols: number
  /** Padding kiri/kanan kolom chat (kolom, bukan karakter). */
  padLeft: number
  padRight: number
  /** Tinggi viewport transkrip — satu sumber untuk scroll & indikator. */
  viewH: number
  transcriptRows: TranscriptRow[]
  transcriptTop: number
  composerTop: number
  composerLines: string[]
  composerOffset: number
  /**
   * Dropdown `/` ditimpa di atas baris transkrip bawah (overlay, frame sama).
   * `top` = baris layar 1-based pertama, `count` = jumlah baris, `firstIndex`
   * = indeks hint pertama yang tampil (dipakai pemetaan klik mouse).
   */
  menuRegion: { top: number; count: number; firstIndex: number } | null
}

/** Detail satu baris visual composer agar layout, klik mouse, dan panah atas/bawah memakai geometri yang sama. */
interface ComposerVisualRow {
  text: string
  prefixCols: number
  body: string
  startCursor: number
  endCursor: number
  softWrapped: boolean
}

/** Baris visual composer + posisi kursor (indeks baris 0-based, kolom 1-based). */
interface ComposerLayout {
  rows: string[]
  visIdx: number
  col: number
  visual?: ComposerVisualRow[]
}

const EMPTY_COMPOSER_LAYOUT: ComposerLayout = { rows: [], visIdx: 0, col: 1, visual: [] }

interface SelectionState {
  anchor: TranscriptPoint
  focus: TranscriptPoint
  dragging: boolean
}

interface RawStdin {
  setRawMode(v: boolean): void
  on(e: string, fn: (c: Buffer) => void): void
  removeListener(e: string, fn: (c: Buffer) => void): void
  resume(): void
  pause(): void
  isTTY?: boolean
}

function highlightColumns(text: string, start: number, end: number): string {
  if (end <= start) return text
  let out = ""
  let column = 0
  let active = false
  let i = 0
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const length = escapeLength(text, i)
      if (length > 0) {
        out += text.slice(i, i + length)
        if (active) out += "\x1b[7m"
        i += length
        continue
      }
    }
    let endOfRun = text.indexOf("\x1b", i)
    if (endOfRun < 0) endOfRun = text.length
    if (endOfRun === i) endOfRun++
    for (const grapheme of toGraphemes(text.slice(i, endOfRun))) {
      const width = displayWidth(grapheme)
      const next = column + width
      const inside = column < end && next > start
      if (inside && !active) {
        out += "\x1b[7m"
        active = true
      } else if (!inside && active) {
        out += "\x1b[27m"
        active = false
      }
      out += grapheme
      column = next
    }
    i = endOfRun
  }
  if (active) out += "\x1b[27m"
  return out
}

function graphemeOffsetAtColumn(text: string, column: number): number {
  const target = Math.max(0, column)
  let used = 0
  const units = toGraphemes(text)
  for (let i = 0; i < units.length; i++) {
    const width = displayWidth(units[i]!)
    if (target <= used + width / 2) return i
    used += width
    if (target <= used) return i + 1
  }
  return units.length
}

/** Konversi koordinat kolom layar (0-based) ke posisi grapheme pada satu baris visual composer. */
function cursorAtVisualRowColumn(row: ComposerVisualRow, screenColZeroBased: number): number {
  const targetBodyCol = Math.max(0, screenColZeroBased - row.prefixCols)
  const localOffset = graphemeOffsetAtColumn(row.body, targetBodyCol)
  // Pada sub-baris hasil soft-wrap, posisi `endCursor` dirender di awal sub-baris
  // berikutnya; jepit ke sebelum wrap agar klik/panah tetap bertahan di baris target.
  const maxOffset = row.softWrapped
    ? Math.max(0, row.endCursor - row.startCursor - 1)
    : row.endCursor - row.startCursor
  return row.startCursor + Math.min(localOffset, maxOffset)
}

export class TuiApp {
  private state: PromptState = createState()
  private scrollBack = 0
  /**
   * v0.43 — Ratchet scroll PER TURN (murni state, BUKAN indikator UI).
   *
   * Baris live tool adalah tail transien: saat ia muncul `total` tumbuh dan
   * sticky-tail menggeser jendela ke bawah (history naik di layar). Saat ia
   * hilang, `total` menyusut — tanpa ratchet `scrollBack` dihitung ulang ke
   * `maxBack` yang lebih kecil dan history turun lagi (jitter "naik-turun").
   * Floor ini mengunci jendela agar TAK PERNAH bergeser balik selama turn yang
   * sama; baris bawah yang tak terisi di-pad kosong oleh viewport().
   *
   * Reset HANYA di awal turn/prompt (/clear & sesi baru = konstruktor), bukan
   * tiap frame — kalau tiap frame, floor selalu menyamai maxBack dan ratchet
   * jadi no-op. Inisialisasi di sini juga mencakup "sesi dibuat ulang" (instance
   * TuiApp baru = sesi baru).
   */
  private turnScrollFloor = 0
  /**
   * Penanda "mengikuti ekor" saat streaming. Anchor scroll = kepala (`scrollBack=0`),
   * jadi viewport diam saat konten tumbuh; flag diclear segera setelah user sengaja
   * scroll ke atas (jangan menarik pembaca yang sedang membaca histori).
   */
  private pinnedToTail = true
  /** Jangkar baris viewport saat lebar chat berubah (resize). */
  private pendingScrollAnchor: TranscriptPoint | null = null
  private history: string[] = []
  private histIdx = -1
  private draft = ""
  private editing = true
  private busy = false
  /** v7.29: laju stream teks → interval kedip spark. */
  private streamDeltas: number[] = []
  private lastStreamTextAt = 0
  private streamIntervalMs = 0
  private turnStartedAt = 0
  private activityTimer: ReturnType<typeof setTimeout> | undefined
  // Clock badge job background: TERPISAH dari activityTimer karena job hidup
  // justru saat turn IDLE (activityTimer hanya jalan saat busy).
  private waitingTimer: ReturnType<typeof setTimeout> | undefined
  private waitingStartedAt = 0
  /** Timestamp abort terakhir (ms), dipakai BERSAMA `awaitingSecondEsc` untuk
   * double-tap Esc = quit. Timestamp saja basi setelah draft baru diketik. */
  private lastAbortAt = 0
  /**
   * Jendela "Esc lagi = quit" setelah abort. Beda dari `lastIdleEscapeAt` (/undo
   * saat idle). Draft baru/submit/lewat 1,5 dtk mematikan flag agar Esc berikutnya
   * tak menyalahartikan "hapus draft" sebagai quit.
   */
  private awaitingSecondEsc = false
  private lastIdleEscapeAt = 0
  /** Hint "tekan lagi untuk keluar" tampil sekali setelah abort pertama. */
  private abortHintOn = false
  /** Micro-toast 2 detik di slot footer saat mengganti bahasa/salin. */
  private statusToast = ""
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * [retry-visibility] SATU state retry, sengaja DITIMPA tiap event — bukan
   * daftar. Badai retry (5–23 percobaan) harus tampil sebagai satu baris yang
   * berubah angkanya, bukan satu baris transkrip per retry. Null = tak ada
   * retry aktif; direset di awal/akhir turn supaya tak bocor ke turn berikutnya.
   */
  private retryInfo: RetryIndicatorState | null = null
  private retrySince = 0
  private retryToastUntil = 0
  private frames = 0
  /**
   * Kedalaman batch input. Selama >0 paint ditunda lalu digabung jadi SATU
   * frame per chunk stdin: burst/paste 500 karakter tidak lagi melukis 500
   * frame (O(N²) diff-write). Key tunggal tetap melukis langsung.
   */
  private paintBatchDepth = 0
  private paintPending = false
  private quitRequested = false
  private finish: (() => void) | null = null
  private runtimeFailure: { error: unknown } | null = null
  private cleanupDone = false
  private decoder: DecoderState = createDecoderState()
  private pump: KeyStreamPump | null = null
  private onData: ((chunk: Buffer) => void) | null = null
  private onResize: (() => void) | null = null
  /**
   * Dua wrapper sinyal terpisah — Bun tidak menyampaikan nama sinyal ke
   * handler (argumen undefined, beda dengan Node), jadi pemetaan sinyal →
   * exit code dilakukan lewat pemasangan per-sinyal ke core di bawah.
   */
  private onSignalTerm: (() => void) | null = null
  private onSignalHup: (() => void) | null = null
  private onSignalInt: (() => void) | null = null
  private signalExitHandled = false

  private wasRaw = false
  /**
   * Kedalaman suspend (popup komposit memegang fokus). >0 = listener stdin
   * dilepas + repaint ditahan — byte masuk HANYA ke view popup.
   */
  private suspended = 0
  private stdin: RawStdin | null = null
  /** True setelah releaseTerminal (spawn anak): paint/repaint ditahan. */
  private released = false
  private mouseMode: MouseMode = "off"
  /** Bracketed paste menyala selama sesi alt-screen aktif (dimatikan saat child spawn). */
  private bracketedPasteOn = false
  private releaseBackdrop: (() => void) | null = null
  private selection: SelectionState | null = null
  private lastLayout: FrameLayout | null = null
  /**
   * Lebar chat dari frame terakhir. Dipakai oleh semua jalur scroll/indikator
   * supaya hitungan wrap SAMA dengan render (chat bisa menyusut saat ter-centre).
   * `null` sebelum paint pertama — fallback ke geometri saat itu.
   */
  private lastChatCols: number | null = null
  /**
   * Status host diambil SATU kali di awal paint; `isBusy()` dalam frame membaca
   * ini, bukan memanggil getStatus() berulang.
   */
  private frameStatus: TuiStatusSnapshot | null = null
  /**
   * Cache layout composer: satu paint memanggil tinggi/isi/kursor untuk state
   * sama (dulu me-wrap 3×). Key memuat line, kursor, lebar efektif, dan mode
   * editing agar tak menyajikan frame basi.
   */
  private composerCache: {
    line: string
    cursor: number
    cols: number
    editing: boolean
    prompt: string
    layout: ComposerLayout
  } | null = null
  private onExit: (() => void) | null = null
  /**
   * Langganan bus untuk repaint live (streaming jawaban, ledger tool,
   * thinking): TANPA ini layar buta selama turn — teks baru hanya tampil
   * saat turn selesai / tombol ditekan. Coalesce 30ms agar burst chunk tak
   * melukis ulang tiap byte.
   */
  private busUnsubs: (() => void)[] = []
  private repaintTimer: ReturnType<typeof setTimeout> | undefined
  /** Coalescing wheel: kumpulkan beberapa event jadi SATU repaint. */
  private wheelRepaintTimer: ReturnType<typeof setTimeout> | undefined
  /** Timer debounce khusus drag-selection agar tak bentrok dengan repaint bus. */
  private selectionPaintTimer: ReturnType<typeof setTimeout> | undefined
  /** Kolom layar (0-based) yang dijaga selama navigasi panah Up/Down berturut-turut. */
  private preferredCol: number | null = null
  /** Ukuran transkrip saat mulai scroll ke atas (basis hitung baris baru). */
  private scrollBase = 0
  /** Auto-scroll saat drag seleksi menempel di tepi viewport (feature). */
  private autoScrollTimer: ReturnType<typeof setInterval> | undefined
  /** +1 = tepi ATAS (gulir ke konten lama); -1 = tepi BAWAH (ke konten baru). */
  private autoScrollDir: 1 | -1 = 1
  /** Kolom x yang ditambatkan fokus seleksi selama auto-scroll. */
  private autoScrollCol = 0

  private initialDraft = ""

  constructor(
    private readonly transcript: Transcript,
    private readonly host: TuiHost,
    opts?: { initialDraft?: string },
  ) {
    this.initialDraft = opts?.initialDraft ?? ""
    // Eviction membuang baris dari KEPALA — geser scrollBack sejumlah baris
    // visual yang hilang supaya anchor pembaca tak lompat. Injeksi lewat field
    // publik (bukan import cli/); callback composition root tetap dipanggil.
    const rootOnEviction = transcript.onEviction
    transcript.onEviction = (removed) => {
      rootOnEviction?.(removed)
      const n = removed.get(this.chatWidth()) ?? 0
      if (n > 0) this.scrollBack = Math.max(0, this.scrollBack - n)
    }
  }

  /** Jalan sampai quit. Alt-screen enter/exit SELALU berpasangan (I17). */
  async run(): Promise<TuiRunResult> {
    // Cek ukuran SEBELUM enter: terminal sempit langsung fallback tanpa
    // flicker masuk-keluar alt-screen (kontrak residual #7).
    const preRows = process.stdout.rows || 0
    const preCols = process.stdout.columns || 0
    if (preRows < MIN_ROWS || preCols < MIN_COLS) return { started: false, frames: 0 }
    const screen = openAltScreen()
    if (!screen.ok || screen.rows < MIN_ROWS || screen.cols < MIN_COLS) {
      try {
        screen.close()
      } catch {}
      return { started: false, frames: 0 }
    }
    const stdin = process.stdin as unknown as RawStdin
    const stdout = process.stdout as unknown as {
      on(e: string, fn: () => void): void
      removeListener(e: string, fn: () => void): void
    }
    this.cleanupDone = false
    this.runtimeFailure = null
    this.currentScreen = screen
    this.stdin = stdin
    try {
      try {
        this.wasRaw =
          (stdin as unknown as { isRaw?: boolean }).isRaw ??
          (process.stdin as unknown as { isRaw?: boolean }).isRaw ??
          false
      } catch {
        this.wasRaw = false
      }
      const done = new Promise<void>((resolve) => (this.finish = resolve))
      this.pump = createKeyStreamPump({
        state: this.decoder,
        onKeys: (keys) => {
          try {
            return this.handleKeys(keys)
          } catch (error) {
            this.stopAfterRuntimeError(error)
            return true
          }
        },
      })
      this.onData = (chunk: Buffer) => {
        try {
          this.pump?.push(new Uint8Array(chunk))
        } catch (error) {
          this.stopAfterRuntimeError(error)
        }
      }
      this.onResize = () => {
        // Saat popup fokus, view popup yang melukis ulang regionnya sendiri;
        // repaint penuh App akan menghapus popup dari layar.
        if (this.suspended > 0) return
        // Stabilizer resize: geometri berubah → koordinat lama basi. Hentikan
        // auto-scroll (timer 60ms bisa menggeser fokus ke baris yang sudah
        // pindah), lepaskan status drag, dan buang kolom kursor yang dijaga
        // (preferredCol) supaya klik/panah setelah resize tak meleset.
        this.stopAutoScroll()
        if (this.selection) this.selection.dragging = false
        this.preferredCol = null
        // Ratchet per turn mengunci scrollBack lama; setelah geometri berubah,
        // angka itu basi (wrap ulang mengubah total). Buang agar viewport bisa
        // dihitung ulang dari ekor yang baru.
        this.turnScrollFloor = 0
        // Lukis layar AKTIF, bukan handle `screen` run() yang basi setelah
        // release+reacquire gagal.
        this.paintCurrent()
      }
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on("data", this.onData)
      stdout.on("resize", this.onResize)
      // Sinyal fatal (TUI-001): kernel-kill TIDAK menjalankan handler "exit" Node,
      // sehingga alt-screen + raw mode bisa tertinggal. Dipasang per-run, dilepas
      // di cleanup. Handler TERPISAH per sinyal (Bun tak menyampaikan nama sinyal).
      // WAJIB di blok sinkron sama dengan openAltScreen(): tanpa await di antaranya,
      // atau SIGTERM masuk sebelum handler terpasang.
      const restoreAndExit = (code: number) => {
        if (this.signalExitHandled) return
        this.signalExitHandled = true
        // Selesaikan loop lebih dulu: cleanup melepas referensi resolver.
        // Ini juga penting saat process.exit di-stub oleh test atau host.
        this.quitRequested = true
        this.finish?.()
        this.cleanupRun(stdin, stdout, screen)
        forceRestoreScreenForSignal()
        // exit() eksplisit memicu handler "exit" yang tersisa (spinner,
        // turn-status) — best-effort sinkron. 128+n = konvensi "mati oleh
        // sinyal n" (SIGTERM=15 → 143, SIGHUP=1 → 129) agar automation
        // tetap bisa membedakan sebab.
        process.exit(code)
      }
      this.onSignalTerm = () => restoreAndExit(143)
      this.onSignalHup = () => restoreAndExit(129)
      this.onSignalInt = () => {
        try {
          this.requestAbort()
        } catch (error) {
          this.stopAfterRuntimeError(error)
        }
      }
      try {
        process.on("SIGTERM", this.onSignalTerm)
      } catch {
        this.onSignalTerm = null
      }
      try {
        process.on("SIGHUP", this.onSignalHup)
      } catch {
        this.onSignalHup = null
      }
      try {
        process.on("SIGINT", this.onSignalInt)
      } catch {
        this.onSignalInt = null
      }
      this.onExit = () => {
        this.setBracketedPaste(false)
        this.setMouseMode("off")
      }
      try {
        process.on("exit", this.onExit)
      } catch {
        this.onExit = null
      }
      // Repaint live mengikuti event bus (stream teks, ledger, thinking).
      // Suspend menahan repaint (popup melukis sendiri); quit menahan semua.
      const requestPaint = () => {
        if (this.quitRequested || this.suspended > 0 || this.released) return
        if (this.repaintTimer !== undefined) return
        this.repaintTimer = setTimeout(() => {
          this.repaintTimer = undefined
          if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
        }, 30)
        try {
          ;(this.repaintTimer as unknown as { unref?: () => void }).unref?.()
        } catch {}
      }
      // [F-TYPE-1] Payload tiap call-site dianotasi; `sub` generik (E diinfer dari
      // handler) menjaga anotasi itu, bukan melunturkannya ke `any`. `UiBus.on`
      // tetap longgar di tepi (dokumentasi src/ui/contract.ts:62-71); satu-satunya
      // cast `event as E` menandai perpindahan unknown → bentuk call-site.
      const sub = <E = unknown>(type: Parameters<UiBus["on"]>[0], handler?: (event: E) => void) => {
        try {
          this.busUnsubs.push(
            this.host.bus.on(type, (event: unknown) => {
              try {
                handler?.(event as E)
              } catch (error) {
                this.stopAfterRuntimeError(error)
              } finally {
                try {
                  requestPaint()
                } catch (error) {
                  this.stopAfterRuntimeError(error)
                }
              }
            }),
          )
        } catch {}
      }
      sub("turn:started", () => {
        this.closeMenu()
        this.turnStartedAt = Date.now()
        // Turn baru = lepas ratchet scroll: history boleh kembali ke posisi
        // normal (jendela mengikuti ekor tanpa jejak baris live turn lama).
        this.turnScrollFloor = 0
        this.streamDeltas = []
        this.lastStreamTextAt = 0
        this.streamIntervalMs = 0
        // Turn BARU harus mulai bersih: hint "Esc lagi = quit" dari abort di
        // turn sebelumnya tak boleh bocor ke turn yang tak berhubungan (audit).
        this.abortHintOn = false
        this.retryInfo = null
        this.retrySince = 0
        this.retryToastUntil = 0
        this.startActivityClock()
      })
      // [retry-visibility] Satu-satunya sumber kebenaran angka retry adalah
      // kebijakan pemulihan di session.ts. Event basi/inkonsisten dibuang
      // (fail-closed) daripada menampilkan "progres" yang tidak nyata.
      sub<{ kind?: unknown; data?: unknown }>("provider:extension", (e) => {
        if (e?.kind !== "minicode:retry") return
        const d = e.data as {
          attempt?: unknown
          quota?: unknown
          category?: unknown
          stalledMs?: unknown
        } | null
        const attempt = d?.attempt
        const quota = d?.quota
        if (
          typeof attempt !== "number" ||
          !Number.isSafeInteger(attempt) ||
          attempt < 1 ||
          typeof quota !== "number" ||
          !Number.isSafeInteger(quota) ||
          quota < 1 ||
          attempt > quota
        )
          return
        this.retryInfo = { attempt, quota }
        this.retrySince = Date.now()
        this.retryToastUntil = this.retrySince + RETRY_TOAST_MS
      })
      // v7.29: reasoning tidak lagi punya baris status khusus; transkrip
      // tetap menerima event reasoning lewat subscription Transcript sendiri.
      sub("provider:text", () => {
        // v7.29: ukur jeda antar chunk teks (jendela 6 sampel) untuk mengatur
        // kecepatan kedip spark — model cepat = kelip cepat, lambat = lambat.
        const now = Date.now()
        if (this.lastStreamTextAt > 0) {
          const d = now - this.lastStreamTextAt
          if (d > 5 && d < 2000) {
            this.streamDeltas.push(d)
            if (this.streamDeltas.length > 6) this.streamDeltas.shift()
            const avg = this.streamDeltas.reduce((a, b) => a + b, 0) / this.streamDeltas.length
            this.streamIntervalMs =
              avg < 120
                ? SPARK_INTERVALS[0]
                : avg < 250
                  ? SPARK_INTERVALS[1]
                  : avg < 500
                    ? SPARK_INTERVALS[2]
                    : SPARK_INTERVALS[3]
          }
        }
        this.lastStreamTextAt = now
      })
      sub("execution:started", () => {})
      sub("execution:completed", () => {})
      sub("turn:completed", () => {
        this.closeMenu()
        this.retryInfo = null
        this.retrySince = 0
        this.retryToastUntil = 0
      })
      sub("context:compacted")
      // v7.28: anchor atas membuat 0 = kepala. Resume history harus mulai
      // dari ekor (terbaru), sama seperti setelah ketikan/submit.
      this.followTail()
      this.scrollBase = this.transcript.total()
      // v0.33: proses yang di-kill/SIGKILL bisa meninggalkan mode mouse
      // (1000/1002/1006) Aktif di terminal. Karena `this.mouseMode` awalnya
      // "off", setMouseMode("off") akan early-return dan mode basi itu tetap
      // mengirim SGR — yang bocor sebagai deretan angka saat scroll/klik.
      // Paksa MATI dulu, baru aktifkan mode yang diinginkan sesi ini.
      this.setMouseMode("off", true)
      this.setMouseMode(mouseSelectionEnabled() ? "drag" : "off")
      // Alt-screen + raw SUDAH aktif: aktifkan bracketed paste SEBELUM frame
      // pertama. Tulisan ini di luar paint() (bukan frame), jadi I1 utuh.
      this.setBracketedPaste(true)
      if (this.initialDraft) {
        const draft = this.initialDraft
        this.initialDraft = ""
        this.setLine(draft)
      }
      this.paint(screen)
      await done
      this.throwRuntimeFailure()
      return { started: true, frames: this.frames }
    } finally {
      this.cleanupRun(stdin, stdout, screen)
    }
  }

  /** Tutup resource sesi TUI satu kali, termasuk bila setup berhenti separuh jalan. */
  private cleanupRun(
    stdin: RawStdin,
    stdout: { removeListener(e: string, fn: () => void): void },
    initialScreen: AltScreen,
  ): void {
    if (this.cleanupDone) return
    this.cleanupDone = true
    try {
      if (this.onData) stdin.removeListener("data", this.onData)
    } catch {}
    try {
      if (this.onResize) stdout.removeListener("resize", this.onResize)
    } catch {}
    if (this.repaintTimer !== undefined) {
      clearTimeout(this.repaintTimer)
      this.repaintTimer = undefined
    }
    if (this.wheelRepaintTimer !== undefined) {
      clearTimeout(this.wheelRepaintTimer)
      this.wheelRepaintTimer = undefined
    }
    this.clearSelectionPaintTimer()
    if (this.toastTimer !== undefined) {
      clearTimeout(this.toastTimer)
      this.toastTimer = undefined
    }
    this.statusToast = ""
    this.stopActivityClock()
    this.stopWaitingClock()
    this.stopAutoScroll()
    this.clearBackdrop()
    for (const unsubscribe of this.busUnsubs.splice(0)) {
      try {
        unsubscribe()
      } catch {}
    }
    for (const [event, listener] of [
      ["SIGTERM", this.onSignalTerm],
      ["SIGHUP", this.onSignalHup],
      ["SIGINT", this.onSignalInt],
      ["exit", this.onExit],
    ] as const) {
      if (!listener) continue
      try {
        process.off(event, listener)
      } catch {}
    }
    this.onSignalTerm = null
    this.onSignalHup = null
    this.onSignalInt = null
    this.onExit = null
    const activeScreen = this.currentScreen
    this.currentScreen = null
    try {
      this.setBracketedPaste(false)
    } catch {}
    try {
      this.setMouseMode("off")
    } catch {}
    try {
      activeScreen?.close()
    } catch {}
    if (activeScreen !== initialScreen) {
      try {
        initialScreen.close()
      } catch {}
    }
    try {
      this.pump?.dispose()
    } catch {}
    this.pump = null
    this.onData = null
    this.onResize = null
    try {
      stdin.setRawMode(this.wasRaw)
    } catch {}
    try {
      stdin.pause()
    } catch {}
    this.stdin = null
    this.finish = null
    this.suspended = 0
    this.released = false
  }

  private stopAfterRuntimeError(error: unknown): void {
    if (!this.runtimeFailure) this.runtimeFailure = { error }
    this.quitRequested = true
    this.finish?.()
  }

  private throwRuntimeFailure(): void {
    const failure = this.runtimeFailure
    if (failure) throw failure.error
  }

  // ── Penanganan key ──

  private requestAbort(): void {
    if (!this.isBusy()) return
    // Dropdown yang masih terbuka saat abort tak boleh muncul lagi setelah
    // turn selesai (state line bisa kosong tapi menuOpen tetap true).
    this.closeMenu()
    try {
      this.host.abort()
    } catch {}
    const now = Date.now()
    // Flag eksplisit, bukan `lastAbortAt` saja: timestamp dari abort lama bisa
    // masih dalam jendela 1,5 dtk saat user sudah mengetik draft baru (audit).
    const doubleTap = this.awaitingSecondEsc && now - this.lastAbortAt < 1500
    if (!doubleTap) {
      this.abortHintOn = true
      this.startActivityClock()
    }
    this.lastAbortAt = now
    this.awaitingSecondEsc = true
    if (doubleTap) this.quit()
    else this.paintCurrent()
  }

  /** Matikan jendela "Esc lagi = quit" setelah abort (audit VERIFIED). */
  private disarmAbortQuit(): void {
    this.awaitingSecondEsc = false
    this.lastAbortAt = 0
  }

  /**
   * Tutup dropdown `/` secara eksplisit pada transisi busy/abort. Engine
   * menyetel `menuOpen` dari baris yang diketik; kalau baris dibersihkan saat
   * submit/abort tanpa menutup flag, menu hantu muncul lagi di turn berikutnya.
   */
  private closeMenu(): void {
    if (!this.state.menuOpen) return
    this.state = { ...this.state, menuOpen: false, sel: -1 }
  }

  private handleKeys(keys: { key: PromptKey }[]): boolean {
    // Garda suspend: timer flush lone-ESC yang dipersenjatai SEBELUM suspend
    // tetap menembak setelah popup terbuka (listener dilepas, timer tidak).
    // Tanpa ini repaint penuh App 50ms kemudian menimpa region popup +
    // memutasi state di belakang view. Gagal-di-kode-lama.
    if (this.suspended > 0) return false
    // Satu chunk stdin = satu key-event di decoder (burst/paste), jadi semua
    // key di sini digabung menjadi satu paint. finally WAJIB menurunkan depth
    // walau handler melempar, supaya paint berikutnya tidak tertahan selamanya.
    this.paintBatchDepth++
    try {
      for (const { key } of keys) {
        if (this.quitRequested) return true
        this.handleKey(key)
      }
      return this.quitRequested
    } finally {
      this.paintBatchDepth--
      if (this.paintBatchDepth === 0) this.flushPendingPaint()
    }
  }

  private flushPendingPaint(): void {
    if (this.paintBatchDepth > 0 || !this.paintPending) return
    this.paintPending = false
    this.paintCurrent()
  }

  private handleKey(key: PromptKey): void {
    if (key.type !== "esc") this.lastIdleEscapeAt = 0
    if (key.type === "mouse") {
      this.handleMouse(key)
      return
    }
    if (key.type === "wheelup" || key.type === "wheeldown") {
      // Wheel SELALU menggulir chat, termasuk saat kursor ada di padding.
      if (
        !this.tooSmall() &&
        !this.isBusy() &&
        this.editing &&
        this.state.menuOpen &&
        this.state.line.startsWith("/") &&
        this.host.listCommands(this.state.line).length > 0
      ) {
        this.applyEngine({ type: key.type === "wheelup" ? "up" : "down" })
        return
      }
      // v7.28 anchor atas: wheelup = ke atas/lama (scrollBack mengecil).
      // Wheel = 3 BARIS, bukan setengah halaman — gulir terasa meluncur,
      // bukan meloncat. Banyak event digabung jadi satu repaint di bawah.
      this.scrollRows(key.type === "wheelup" ? -3 : 3, false)
      this.scheduleWheelRepaint()
      return
    }
    // Scroll SELALU tersedia (juga saat busy/layar menciut) — di-intercept sebelum
    // engine. Dulu di bawah gate tooSmall: busy + ciut = tak bisa scroll/abort.
    // Shift+PgUp/PgDn (modifier 2) = setengah halaman; halaman penuh terlalu kasar.
    if (key.type === "pageup" || key.type === "pagedown") {
      const mod = key.modifier ?? 0
      if (mod === 2) {
        // PgUp = naik (negatif), PgDn = turun (positif).
        this.scrollBy(key.type === "pageup" ? -0.5 : 0.5)
        return
      }
      this.scrollBy(key.type === "pageup" ? -1 : 1)
      return
    }
    // Home/End LOMPAT transkrip hanya saat prompt kosong & tanpa dropdown:
    // 5000 baris ≈ 125 halaman, PgUp 125× bukan navigasi. Home = kepala, End = ekor.
    // Baris berisi = tombol editing; dropdown = navigasi menu (jalur engine).
    if ((key.type === "home" || key.type === "end") && !this.state.menuOpen && !this.state.line) {
      const logical = key.type === "home"
      if (logical || this.scrollBack !== 0) {
        this.jumpEdge(logical)
        return
      }
      // End saat sudah di ekor: biarkan ke engine (kebiasaan editing —
      // tidak ada yang berubah, action "none").
      this.applyEngine(key)
      return
    }
    // Ctrl+A (key `selectAll` dari decoder) = SELECT-ALL transkrip, bukan
    // sekadar Home. Pengecualian: menu/draft aktif → perlakukan seperti Home
    // (perilaku lama, jangan regresi editing). Esc tetap membersihkan seleksi.
    if (key.type === "selectAll") {
      if (this.state.menuOpen || this.state.line.length > 0) {
        this.applyEngine({ type: "home" })
        return
      }
      const range = this.transcript.selectionRange()
      if (range) {
        this.selection = { anchor: range.first, focus: range.last, dragging: false }
        this.stopAutoScroll()
        this.paintCurrent()
      }
      return
    }
    if (key.type === "ctrl-c") {
      if (this.selection) {
        // Ctrl+C di tengah drag = salin seleksi yang sudah ada, BUKAN no-op
        // dan bukan abort. Lepaskan drag dulu supaya timer auto-scroll mati.
        if (this.selection.dragging) {
          this.selection.dragging = false
          this.stopAutoScroll()
        }
        this.copySelection()
      }
      return
    }
    // Abort/batal: Esc — berlaku juga saat layar menciut (jalan keluar saat
    // terminal mengecil di tengah turn busy). Jalan keluar saat abort macet
    // (provider/tool non-kooperatif abaikan sinyal): Esc dua kali dalam 1.5 dtk,
    // atau Ctrl+D baris-kosong, = abort + quit. Tanpa ini sesi hanya bisa
    // dibunuh kill -9 (kontrak I14).
    if (key.type === "esc" && this.selection) {
      this.lastIdleEscapeAt = 0
      this.selection = null
      this.paintCurrent()
      return
    }
    if (key.type === "esc") {
      // Cek jendela abort DULUAN, sebelum cabang busy/idle. Turn yang dibatalkan
      // bisa selesai lebih cepat dari jari user: tanpa ini Esc kedua jatuh ke
      // cabang idle dan (dalam kondisi gesture tertentu) memicu /undo, bukan quit.
      // Jendela diprogram oleh FLAG eksplisit, bukan timestamp saja: timestamp
      // basi setelah draft baru diketik (audit VERIFIED). Lewat 1,5 dtk = mati.
      if (this.awaitingSecondEsc && Date.now() - this.lastAbortAt >= 1500) {
        this.disarmAbortQuit()
      }
      if (this.awaitingSecondEsc && Date.now() - this.lastAbortAt < 1500) {
        this.quit()
        return
      }
      if (this.isBusy()) {
        this.lastIdleEscapeAt = 0
        this.requestAbort()
        return
      }
      if (this.tooSmall()) return
      if (this.state.menuOpen) {
        this.lastIdleEscapeAt = 0
        this.applyEngine(key)
        return
      }
      if (!this.state.line) {
        const now = Date.now()
        const doubleTap = this.lastIdleEscapeAt > 0 && now - this.lastIdleEscapeAt < 500
        this.lastIdleEscapeAt = doubleTap ? 0 : now
        if (doubleTap) void this.doSubmit("/undo")
        return
      }
      this.lastIdleEscapeAt = 0
      if (this.state.line || this.editing) {
        this.state = createState()
        this.preferredCol = null
        this.histIdx = -1
        // Prompt TETAP tampil setelah Esc: kontrak I13 mensyaratkan prompt
        // ada saat idle, dan menyembunyikannya membuat layar terlihat mati
        // sampai user menekan tombol berikutnya (audit 2026-11-12, MEDIUM-4).
        this.editing = true
        this.paintCurrent()
      }
      return
    }
    // Terminal menciut di bawah minimum: abaikan SEMUA kecuali keluar.
    // Tanpa ini layout rusak (kolom negatif, kursor melompat) dan user
    // terkunci tanpa jalan keluar yang terlihat.
    if (this.tooSmall()) {
      if (key.type === "ctrl-d") this.quit()
      return
    }
    // Saat turn berjalan input TIDAK lagi beku total (perubahan kontrak atas
    // permintaan pemilik repo): tombol penyusun teks tetap jalan supaya koreksi
    // bisa diketik selagi model bekerja, dan Enter mengantri sebagai informasi
    // tambahan (`host.enqueue`). Yang tetap ditahan saat busy: Escape (abort),
    // scroll/selection (di atas), Tab/Shift+Tab/Ctrl+R, karena
    // semuanya memutasi mode atau membuka overlay yang tak boleh balapan dengan
    // turn. Ctrl+D baris-kosong tetap abort + quit (I14, jalan keluar saat abort
    // macet).
    if (this.isBusy()) {
      if (key.type === "ctrl-d" && !this.state.line) {
        try {
          this.host.abort()
        } catch {}
        this.quit()
        return
      }
      if (!BUSY_TYPING_KEYS.has(key.type)) return
    }
    if (key.type === "ctrl-d") {
      // Baris kosong = keluar (konvensi EOF); berisi = abaikan (I19).
      if (!this.state.line) this.quit()
      return
    }
    if (key.type === "tab") {
      // Saat dropdown `/` sedang terbuka dan punya kandidat, Tab melengkapi
      // command ke composer tanpa langsung submit; selain itu putar WorkMode.
      const hasMenu =
        this.editing &&
        this.state.menuOpen &&
        this.state.line.startsWith("/") &&
        this.host.listCommands(this.state.line).length > 0
      if (hasMenu) {
        this.applyEngine(key)
        return
      }
      this.host.cycleWorkMode(1)
      // Pembaruan WorkMode langsung mengubah label di bar footer tanpa
      // menutup footer dengan toast sementara.
      this.paintCurrent()
      return
    }
    if (key.type === "shift-tab") {
      this.host.togglePermissionMode()
      // Pembaruan PermissionMode langsung mengubah label di bar footer.
      this.paintCurrent()
      return
    }
    // Ctrl+O / Ctrl+T sengaja TIDAK di-bind lagi. Dulu keduanya memutasi flag
    // UI dan mencetak kwitansi, padahal renderer flat mengabaikan flag itu —
    // kontrol mati yang menyesatkan. Biarkan jatuh ke engine (action "none").
    if (key.type === "ctrl-r") {
      this.historySearch()
      return
    }
    // Up/Down di luar menu: navigasi baris visual dalam composer dulu (baik
    // paragraf wrap panjang maupun multiline `\n`), sambil menjaga kolom layar.
    // Hanya picu navigasi histori bila sudah di baris visual pertama/terakhir.
    if ((key.type === "up" || key.type === "down") && !this.state.menuOpen) {
      const dir = key.type === "up" ? -1 : 1
      if (this.moveCursorVertical(dir)) return
      this.historyNav(dir)
      return
    }
    this.applyEngine(key)
  }

  private applyEngine(key: PromptKey): void {
    this.preferredCol = null
    if (["char", "backspace", "delete", "enter", "ctrl-j"].includes(key.type)) this.selection = null
    const hints = (line: string) => (line.startsWith("/") ? this.host.listCommands(line) : [])
    // Fast path kursor: panah/Home/End hanya memindahkan kursor — isi frame
    // (transkrip, menu, footer) tak berubah satu sel pun. Menyusun ulang frame
    // penuh + diff per sel hanya untuk menggeser kursor membuang kerja O(frame).
    // Tangkap visIdx SEBELUM key supaya posisi baris kursor baru bisa dihitung
    // dari layout lama tanpa buildLayout.
    const cursorOnly =
      key.type === "left" || key.type === "right" || key.type === "home" || key.type === "end"
    const prevVisIdx =
      cursorOnly && this.editing && this.currentScreen?.ok ? this.composerLayout().visIdx : -1
    const { state, action } = applyKey(this.state, key, hints)
    const lineUnchanged = state.line === this.state.line
    this.state = state
    // Baris berubah = user mengedit draft. Jendela "Esc lagi = quit" dari abort
    // sebelumnya harus mati: Esc berikutnya bermakna hapus draft, bukan quit.
    if (!lineUnchanged) this.disarmAbortQuit()
    if (action === "submit") {
      void this.doSubmit(state.line)
    } else if (action === "cancel") {
      // Engine cancel (ctrl-c/ctrl-d) sudah ditangani di atas; tak terjangkau.
    } else if (action === "render" || action === "none") {
      if (action === "render" && key.type === "char") this.editing = true
      if (
        cursorOnly &&
        action === "render" &&
        lineUnchanged &&
        prevVisIdx >= 0 &&
        this.canCursorPaint()
      ) {
        this.paintCursorOnly(prevVisIdx)
        return
      }
      // Ketikan baru = kembali ke ekor (I18); stream turn TIDAK me-reset
      // (user yang sedang membaca ke atas tak dirampas).
      if (key.type === "char" || key.type === "backspace" || key.type === "delete") {
        this.followTail()
      }
      this.paintCurrent()
    }
  }

  /** Siap melukis kursor-saja? Butuh layout terakhir + layar sehat. */
  private canCursorPaint(): boolean {
    return (
      !this.quitRequested &&
      !this.released &&
      this.suspended === 0 &&
      this.paintBatchDepth === 0 &&
      !this.tooSmall() &&
      this.editing &&
      this.lastLayout !== null
    )
  }

  /**
   * Geser KURSOR saja memakai layout lama. `prevVisIdx` = visIdx composer
   * sebelum key; delta baris kursor = delta visIdx (geometri atas tak berubah).
   */
  private paintCursorOnly(prevVisIdx: number): void {
    const layout = this.lastLayout
    const screen = this.currentScreen
    if (!layout || !screen?.ok) {
      this.paintCurrent()
      return
    }
    const composer = this.composerLayout()
    const visibleRows = COMPOSER_MAX_ROWS
    // Bila kursor berpindah ke luar jendela composer (input > 2 baris), lukis
    // ulang penuh agar `composerOffset` & baris tampil ikut bergulir.
    if (
      composer.visIdx < layout.composerOffset ||
      composer.visIdx >= layout.composerOffset + visibleRows
    ) {
      this.paintCurrent()
      return
    }
    const row = Math.max(1, layout.cursor.row + (composer.visIdx - prevVisIdx))
    // Fast path panah: CUP absolut, jadi harus menyertakan padding kiri chat.
    // (Bedakan dari `moveCursor()` modal yang memakai koordinat screen mentah.)
    const col = Math.max(1, composer.col + layout.padLeft)
    try {
      screen.moveCursor(row, col)
    } catch (error) {
      this.stopAfterRuntimeError(error)
      return
    }
    // Simpan posisi kursor baru supaya paint berikutnya tak mengira kursor
    // masih di tempat lama (mis. mouse-hit-test memakai lastLayout).
    this.lastLayout = { ...layout, cursor: { row, col } }
    this.frames++
  }

  private async doSubmit(rawLine: string): Promise<void> {
    const line = rawLine.trim()
    // Enter saat turn berjalan = antre, BUKAN turn kedua yang balapan dengan
    // yang sedang jalan. Draft dibersihkan dan baris status aktivitas kembali
    // tampil; pesannya dikirim controller setelah turn ini selesai.
    if (this.isBusy()) {
      this.closeMenu()
      this.state = createState()
      this.preferredCol = null
      this.histIdx = -1
      this.editing = true
      this.disarmAbortQuit()
      if (line) {
        this.rememberHistory(line)
        this.host.enqueue?.(line)
      }
      this.followTail()
      this.paintCurrent()
      return
    }
    this.closeMenu()
    this.state = createState()
    this.preferredCol = null
    this.histIdx = -1
    this.editing = false
    this.abortHintOn = false
    this.disarmAbortQuit()
    if (!line) {
      // Enter pada baris kosong tetap idle: prompt harus langsung kembali
      // (I13), bukan menghilang sampai ketikan berikutnya.
      this.editing = true
      this.followTail()
      this.paintCurrent()
      return
    }
    this.rememberHistory(line)
    // Built-in commands and shortcuts belong to the composer history, not the
    // conversation transcript. The command result remains independently
    // visible when it carries useful user-facing information.
    if (!line.startsWith("/")) {
      // v7.29: prompt masuk transkrip sebagai history biasa (tanpa card).
      // Wrap gema memakai lebar CHAT (bukan cols terminal): kalau tidak,
      // prompt panjang ter-wrap dua kali — sekadar di pushUser lebar terminal,
      // lalu lagi oleh projectText pada kolom chat yang ter-centre.
      this.transcript.pushUser(rawLine, this.chatWidth())
    }
    // Prompt user baru = awal turn baru. Ratchet dari turn sebelumnya dilepas
    // supaya history bisa kembali ke ekor (bukan terkunci oleh live yang sudah
    // hilang). `turn:started` juga me-reset, tapi submit parent siklus lengkap
    // (host tak selalu memancarkan event bus).
    this.turnScrollFloor = 0
    this.busy = true
    this.turnStartedAt = Date.now()
    this.lastAbortAt = 0
    this.startActivityClock()
    // Gema prompt user sudah masuk transkrip — baru sekarang pin ke ekor,
    // kalau tidak frame pertama turn sudah tertinggal ~3 baris.
    this.followTail()
    this.paintCurrent()
    try {
      const res = await this.host.submit(line)
      if (res?.quit) this.quit()
    } catch (e) {
      // [P0 UI Security] Pesan error = TEKS TAK DIPERCAYA: bisa memuat body
      // provider, header `Authorization: Bearer …`, atau escape ANSI. Jalur
      // lama `e.message` mentah membocorkan credential ke layar TUI — kini
      // lewat formatter kanonik (redaksi credential + sanitasi + pemotongan).
      // [Audit VALID] sub-agent REFUSED_* (src/tools/task.ts) dilempar sebagai
      // Error biasa; formatError() jatuh ke fallback `friendlyError()` yang
      // mengembalikan pesan mentah. Kanonikkan dulu: pola yang dikenali →
      // redaksi ringkas; bila "" (tak dikenali) → formatError(e) supaya detail
      // provider/sistem yang aman tidak hilang.
      const raw = String((e as { message?: unknown } | null)?.message ?? e)
      const canonical = friendlyToolErrorCanonical(raw)
      this.transcript.pushError(canonical || formatError(e))
    } finally {
      this.busy = false
      this.editing = true
      this.closeMenu()
      this.turnStartedAt = 0
      // [retry-visibility] Turn selesai (sukses/gagal/abort) = retry indicator
      // harus hilang. finally adalah pagar terakhir kalau event bus terlewat.
      this.retryInfo = null
      this.retrySince = 0
      this.retryToastUntil = 0
      this.stopActivityClock()
      if (!this.quitRequested) this.paintCurrent()
    }
  }

  private quit(): void {
    if (this.quitRequested) return
    try {
      this.host.abort()
    } catch {}
    this.stopActivityClock()
    this.stopWaitingClock()
    this.quitRequested = true
    this.finish?.()
  }

  /**
   * Minta keluar (dipakai controller saat terminal tak bisa dihidupkan lagi
   * setelah spawn gagal — daripada TUI mati tanpa layar).
   */
  requestQuit(): void {
    this.quit()
  }

  /**
   * Bekukan App untuk popup komposit: lepas listener stdin (byte masuk HANYA
   * ke view popup — anti double-handling) + redupkan layar sebagai backdrop.
   * View melukis kotaknya sendiri via paintRegion; tutup = resume().
   */
  suspend(): void {
    if (!this.currentScreen || this.quitRequested) return
    if (this.suspended++ > 0) return
    if (this.selection) this.selection.dragging = false
    this.decoder.pending = []
    this.setMouseMode("wheel")
    try {
      if (this.onData) this.stdin?.removeListener("data", this.onData)
    } catch {}
    try {
      this.paintDimmed()
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /**
   * Kembalikan fokus: rebut raw mode + pasang listener + repaint penuh
   * (menimpa region popup). Idempoten terhadap resume berlebih. No-op bila
   * terminal dilepas untuk spawn anak (releaseTerminal) — kebangkitan
   * eksplisit lewat reacquireTerminal.
   */
  resume(): void {
    if (this.released || this.suspended <= 0) return
    if (--this.suspended > 0) return
    this.clearBackdrop()
    try {
      this.stdin?.setRawMode(true)
    } catch {}
    try {
      if (this.onData) this.stdin?.on("data", this.onData)
    } catch {}
    this.setMouseMode(mouseSelectionEnabled() ? "drag" : "off")
    if (this.isBusy()) this.startActivityClock()
    this.paintCurrent()
  }

  /**
   * Lepas terminal untuk spawn anak stdio-inherit (/sessions <id>): keluar
   * alt-screen + cooked mode + lepas listener. Tanpa ini anak mewarisi buffer
   * ?1049h + raw mode (double-ENTER, EXIT anak merobek buffer parent,
   * stdin mentah macet). Gagal-di-kode-lama: layar korup + terminal rusak
   * setelah anak keluar.
   */
  releaseTerminal(): void {
    this.stopActivityClock()
    this.clearBackdrop()
    try {
      if (this.onData) this.stdin?.removeListener("data", this.onData)
    } catch {}
    try {
      this.stdin?.setRawMode(false)
    } catch {}
    try {
      this.setBracketedPaste(false)
      this.setMouseMode("off")
      this.currentScreen?.close()
    } catch {}
    this.currentScreen = null
    this.lastLayout = null
    this.released = true
  }

  /**
   * Hidupkan kembali terminal setelah release (jalur spawn GAGAL — anak tak
   * jalan sehingga parent harus lanjut). No-op bila tidak dilepas. False =
   * terminal tak mampu lagi → pemanggil harus quit. Listener stdin TIDAK
   * dipasang di sini (tugas resume() di finally pemanggil) agar tak ganda.
   */
  reacquireTerminal(): boolean {
    if (!this.released) return true
    if (this.quitRequested) return false
    const screen = openAltScreen()
    if (!screen.ok) return false
    this.currentScreen = screen
    this.released = false
    this.setBracketedPaste(true)
    this.setMouseMode(!mouseSelectionEnabled() ? "off" : this.suspended > 0 ? "wheel" : "drag")
    try {
      this.stdin?.setRawMode(true)
    } catch {}
    if (this.isBusy()) this.startActivityClock()
    this.paintCurrent()
    return true
  }

  /** True saat popup/modal memegang fokus (input App dibekukan). */
  isSuspended(): boolean {
    return this.suspended > 0
  }

  /**
   * Bungkus baris dengan scrim latar netral bila tersedia. Reset SGR dalam
   * konten dipulihkan ke keadaan scrim agar warna teks tak mematikan backdrop.
   */
  static applyBackdropDim(ln: string): string {
    if (!ln) return ""
    const mode = scrimMode()
    if (mode === "none") return ln
    const esc = String.fromCharCode(27)
    const scrim = scrimSgr(mode)
    // Bold DIPETAKAN ke scrim (bukan dibuang) dan `[22m` memulihkan scrim,
    // bukan meninggalkan teks normal (AUD-003).
    let s = ln.replaceAll(`${esc}[1m`, scrim)
    s = s.replaceAll(`${esc}[22m`, `${esc}[22m${scrim}`)
    s = s.replaceAll(`${esc}[0m`, `${esc}[0m${scrim}`)
    s = s.replaceAll(`${esc}[m`, `${esc}[0m${scrim}`)
    return `${scrim}${s}${esc}[22m${esc}[0m`
  }

  private clearBackdrop(): void {
    try {
      this.releaseBackdrop?.()
    } catch {}
    this.releaseBackdrop = null
  }

  /** Layar redup sebagai backdrop popup: frame normal dibungkus faint. */
  private paintDimmed(): void {
    const screen = this.currentScreen
    if (!screen) return
    const cols = screen.cols
    const rows = screen.rows
    // Bekukan FRAME redup sekali saat suspend. Callback backdrop saat resize
    // DULU memanggil buildLayout lagi → memutasi scrollBack / lastWrapped /
    // selection / clock di belakang modal (audit VERIFIED). Kini callback hanya
    // memakai snapshot beku ini; `resume()` tetap repaint penuh dari state hidup.
    const snap = this.host.getStatus()
    this.frameStatus = snap
    const layout = this.buildLayout(rows, cols, snap)
    this.lastLayout = layout
    const frozen = layout.frame.map((ln) => TuiApp.applyBackdropDim(ln))
    screen.paint([...frozen])
    this.frames++
    // Snapshot HANYA untuk frame ini; di luar paint isBusy() kembali membaca
    // host.getStatus() seperti semula (tak ada status basi di handler).
    this.frameStatus = null
    this.clearBackdrop()
    this.releaseBackdrop = registerScreenBackdrop(
      (_c, r) => {
        // screen.paintRegion sudah memotong tiap baris ke lebar baru; di sini
        // cukup menyajikan `r` baris dari snapshot (lebih panjang = di-crop,
        // lebih pendek = baris kosong redup). Tak ada efek samping layout.
        const out: string[] = []
        for (let i = 0; i < r; i++) out.push(frozen[i] ?? "")
        return out
      },
      cols,
      rows,
    )
  }

  /**
   * Lebar area transkrip yang dipakai SEMUA jalur hitung baris (scroll,
   * indikator, follow). Sebelum paint pertama belum ada `lastLayout`, jadi
   * hitung dari geometri dengan input yang sama seperti buildLayout.
   */
  private chatWidth(): number {
    if (this.lastChatCols != null) return this.lastChatCols
    if (this.lastLayout) return this.lastLayout.chatCols
    const cols = Math.max(1, this.currentScreen?.cols || process.stdout.columns || 80)
    const rows = Math.max(1, this.currentScreen?.rows || process.stdout.rows || 24)
    return chatWidthFromGeometry(chatColumnGeometry(rows, cols))
  }

  /**
   * Lebar wrap composer SATU-SUMBER. Geometri (cap progresif + lantai) tinggal
   * di `chat-column.ts`; semua situs composer — wrap, cache, kursor vertikal,
   * klik mouse, dan komposisi frame — memanggil helper ini supaya tak ada dua
   * lebar yang divergen.
   */
  private composerWidth(): number {
    return composerWidthFromChat(this.chatWidth())
  }

  private isBusy(): boolean {
    if (this.busy) return true
    // Handler di luar paint tetap memanggil host.getStatus() sendiri; di sini
    // cukup pakai snapshot yang diambil sekali di awal paint.
    if (this.frameStatus) return this.frameStatus.busy
    try {
      return this.host.getStatus().busy
    } catch {
      return false
    }
  }

  // ── Histori prompt (memori sesi; tak persist ke berkas REPL) ──

  private rememberHistory(line: string): void {
    if (this.history[this.history.length - 1] !== line) this.history.push(line)
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200)
  }

  /** Salinan histori prompt sesi ini (untuk perintah `/history` di TUI). */
  getHistory(): readonly string[] {
    return [...this.history]
  }

  private historyNav(dir: -1 | 1): void {
    if (!this.history.length) return
    if (this.histIdx === -1) {
      if (dir > 0) return
      this.draft = this.state.line
      this.histIdx = this.history.length - 1
    } else {
      const next = this.histIdx + dir
      if (next < 0) return
      if (next >= this.history.length) {
        this.histIdx = -1
        this.setLine(this.draft)
        return
      }
      this.histIdx = next
    }
    this.setLine(this.history[this.histIdx] ?? "")
  }

  private historySearch(): void {
    const prefix = this.state.line
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i]!
      if (h !== prefix && h.startsWith(prefix)) {
        this.setLine(h)
        return
      }
    }
  }

  private setLine(line: string): void {
    // Bangun ulang state lewat engine (aturan menu/sel ikut terjaga). Baris
    // berubah = kembali ke ekor (paritas ketikan — viewport tidak diam).
    // Recall/history juga mengubah draft → matikan jendela quit pasca-abort.
    this.disarmAbortQuit()
    this.followTail()
    const { state } = applyKey(
      createState(),
      { type: "char", ch: stripSgr(sanitizeAnsi(line)) },
      () => [],
    )
    // Recall (history ↑↓ / Ctrl+R) BUKAN mengetik "/" — menu command hanya
    // boleh terbuka saat user AKTIF mengetik (via applyEngine). `withLine` di
    // engine menyetel menuOpen = line.startsWith("/"), jadi recall entri command
    // (/model) akan membuka menu; tanpa koreksi ini, ↑↓ berikutnya dinavigasi ke
    // menu (sel), bukan history, dan user terkunci tak bisa melewati entri command.
    this.state = { ...state, menuOpen: false, sel: -1 }
    this.preferredCol = null
    this.editing = true
    this.paintCurrent()
  }

  // ── Scroll ──

  private scrollBy(pages: number): void {
    // Navigasi eksplisit user melepaskan ratchet turn — kalau tidak, saat user
    // scroll balik ke ekor, floor lama menarik viewport ke posisi basi.
    this.turnScrollFloor = 0
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const viewH = this.viewportHeight(rows, cols, this.isBusy())
    // P0: lebar CHAT, bukan lebar terminal — kalau tidak, cache proyeksi
    // mis-match terus (chat bisa ter-centre) dan hitungan meleset.
    const wrapped = this.transcript.wrappedLength(this.chatWidth())
    // v7.35: page WAJIB sama dengan viewH (bukan viewH - 1). scrollRows/jumpEdge/
    // followTail memakai `wrapped - viewH`; bila PgDn memakai viewH - 1, satu
    // langkah kurang dari satu viewport penuh sehingga ekor butuh langkah
    // tambahan yang tak mengubah tampilan (no-op). Samakan batasnya di sini.
    const page = viewH
    // v7.28 anchor atas: scrollBack = 0 berarti KEPALA, nilai besar = ekor.
    // PgDn (+pages) maju ke bawah, PgUp (-pages) mundur ke atas.
    const max = Math.max(0, wrapped - viewH)
    if (this.scrollBack === max && pages < 0) this.scrollBase = this.transcript.total()
    this.scrollBack = Math.max(0, Math.min(max, Math.round(this.scrollBack + pages * page)))
    this.pinnedToTail = this.scrollBack === max
    if (this.scrollBack === max) {
      this.scrollBase = this.transcript.total()
    }
    this.paintCurrent()
  }

  /**
   * Scroll per BARIS (bukan per halaman) — dipakai auto-scroll seleksi agar
   * gulirnya halus & presisi. `n` = baris terbungkus (+ = ke bawah/baru,
   * - = ke atas/lama); di-clamp ke [0, wrapped - viewH]. Menjaga basis
   * `scrollBase` sama seperti `scrollBy`. Arah ini selaras dengan scrollBy:
   * scrollBack 0 = kepala, nilai besar = ekor (v7.28 anchor atas).
   */
  private scrollRows(n: number, repaint = true): void {
    this.turnScrollFloor = 0
    const cols = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const viewH = this.viewportHeight(rows, cols, this.isBusy())
    const wrapped = this.transcript.wrappedLength(this.chatWidth())
    const maxBack = Math.max(0, wrapped - viewH)
    // v7.28: n > 0 = gulir ke bawah (lebih baru), n < 0 = ke atas.
    if (this.scrollBack === maxBack && n < 0) this.scrollBase = this.transcript.total()
    this.scrollBack = Math.max(0, Math.min(this.scrollBack + n, maxBack))
    this.pinnedToTail = this.scrollBack === maxBack
    if (this.scrollBack === maxBack) {
      this.scrollBase = this.transcript.total()
    }
    if (repaint) this.paintCurrent()
  }

  /**
   * Lompat ke ujung transkrip (temuan audit TUI-002): Home = baris teratas
   * (scrollBack maksimum), End = ekor. `lastWrapped` dinetralkan SEBELUM
   * perhitungan kunci-posisi-baca berikutnya: jendela yang sengaja dipindah
   * user bukan drift stream, tanpa ini paint pertama post-jump menarik
   * viewport kembali ke ekor (lompatan tak terlihat).
   */
  private jumpEdge(top: boolean): void {
    this.turnScrollFloor = 0
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const curWrapped = this.transcript.wrappedLength(this.chatWidth())
    const viewH = this.viewportHeight(rows, cols, this.isBusy())
    const maxBack = Math.max(0, curWrapped - viewH)
    // v7.28: Home = kepala (0), End = ekor (maks).
    if (top) {
      this.scrollBack = 0
      this.pinnedToTail = false
    } else {
      if (this.scrollBack === maxBack) this.scrollBase = this.transcript.total()
      this.scrollBack = maxBack
      this.scrollBase = this.transcript.total()
      this.pinnedToTail = true
    }
    this.paintCurrent()
  }

  /** Kembali ke ekor (bawah): dipakai tiap ketikan/submit baru (I18). */
  private followTail(): void {
    const cols = process.stdout.columns || 80
    const viewH = this.viewportHeight(process.stdout.rows || 24, cols, this.isBusy())
    this.scrollBack = Math.max(0, this.transcript.wrappedLength(this.chatWidth()) - viewH)
    this.scrollBase = this.transcript.total()
    this.pinnedToTail = true
  }

  /** Kosongkan transkrip (/clear): viewport + basis scroll ikut di-reset agar
   * tak tertinggal scrollBack basi (layar kosong + user harus PgDn manual). */
  clearView(): void {
    this.transcript.clear()
    // /clear = sesi tampilan baru: buang ratchet turn lama supaya viewport
    // benar-benar mulai dari nol, bukan menyimpan floor dari transkrip lama.
    this.turnScrollFloor = 0
    this.followTail()
    this.paintCurrent()
  }

  private startActivityClock(): void {
    if (this.activityTimer || this.quitRequested) return
    const tick = () => {
      this.activityTimer = undefined
      if (!this.isBusy() || this.quitRequested) return
      if (this.suspended === 0 && !this.released) this.paintCurrent()
      if (this.quitRequested) return
      this.startActivityClock()
    }
    this.activityTimer = setTimeout(tick, DOT_INTERVAL_MS)
    try {
      ;(this.activityTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private stopActivityClock(): void {
    if (this.activityTimer !== undefined) {
      clearTimeout(this.activityTimer)
      this.activityTimer = undefined
    }
  }

  // Clock badge job background: berjalan selama ada job hidup, termasuk saat
  // turn idle (justru saat itulah job biasanya selesai).
  private startWaitingClock(): void {
    if (this.waitingTimer !== undefined || this.quitRequested) return
    if (!this.waitingStartedAt) this.waitingStartedAt = Date.now()
    const tick = () => {
      this.waitingTimer = undefined
      if (this.quitRequested) return
      if (!this.hasBackgroundJobs()) {
        this.waitingStartedAt = 0
        return
      }
      if (this.suspended === 0 && !this.released) this.paintCurrent()
      if (this.quitRequested) return
      this.startWaitingClock()
    }
    this.waitingTimer = setTimeout(tick, WAITING_INTERVAL_MS)
    try {
      ;(this.waitingTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private stopWaitingClock(): void {
    if (this.waitingTimer !== undefined) {
      clearTimeout(this.waitingTimer)
      this.waitingTimer = undefined
    }
    this.waitingStartedAt = 0
  }

  /** Jumlah job hidup dari snapshot host (0 bila host tak melaporkan). */
  private hasBackgroundJobs(): boolean {
    try {
      const jobs = this.host.getStatus().footer.backgroundJobs ?? 0
      return jobs >= 1
    } catch {
      return false
    }
  }

  /**
   * v7.29: composer SELALU hidup (prompt siap diketik), termasuk saat busy.
   * Tidak ada lagi baris status aktivitas yang menggantikan prompt.
   */
  private composerLive(_busy: boolean): boolean {
    return this.editing
  }

  private composerRows(snap: TuiStatusSnapshot, busy: boolean, now: number): string[] {
    // v7.29: kolom chat BERSIH — tidak ada status/progres di composer, baik
    // idle maupun busy. Status kerja tampil di footer indicatorLine, bukan di
    // sini. Composer selalu menampil prompt/draft saja, siap diketik.
    void snap
    void busy
    void now
    // Idle: prompt tetap tampil. Dulu baris kosong menggantikannya sehingga
    // setelah Esc/Enter-kosong layar terlihat mati (I13: prompt tampil saat
    // boot/idle) — audit 2026-11-12, MEDIUM-4.
    const w = this.composerWidth()
    if (!this.editing) return [chunkByWidth(promptFirst(w), w)[0] ?? ""]
    return this.composerLayout().rows
  }

  /** Tampilkan pesan status singkat (micro-toast) di slot footer selama `ms` ms. */
  showToast(text: string, ms = 2000): void {
    const clean = sanitizeAnsiLine(text).trim()
    if (!clean) return
    this.statusToast = clean
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toastTimer = undefined
      this.statusToast = ""
      if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
    }, ms)
    try {
      ;(this.toastTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
    if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
  }

  /**
   * Composer dikunci 2 baris di SEMUA state (idle, mengetik, busy, habis submit).
   * Reservasi ini mencegah prompt naik-turun saat `editing` berubah di
   * doSubmit/finally: dulu `composerH` menyusut jadi 1 saat busy, `viewH`
   * membesar satu, dan `composerTop` turun satu baris. Baris ke-2 sengaja
   * dikosongkan bila draft cuma satu baris / sedang busy (padding di buildLayout).
   */
  private composerHeight(_busy = this.busy): number {
    return COMPOSER_MAX_ROWS
  }

  // ── Paint ──

  private currentScreen: AltScreen | null = null

  /**
   * Satu-satunya writer mentah App (inventaris writer OAP-008): mode mouse,
   * bracketed paste, dan sinyal terminal lain lewat sini. Semuanya ditulis
   * DI LUAR paint()/frame, jadi I1 (satu write per frame) tak terlanggar.
   */
  private writeRaw(sequence: string): void {
    try {
      process.stdout.write(sequence)
    } catch {}
  }

  private setBracketedPaste(on: boolean): void {
    if (this.bracketedPasteOn === on) return
    this.writeRaw(on ? BRACKETED_PASTE_ON : BRACKETED_PASTE_OFF)
    this.bracketedPasteOn = on
  }

  private setMouseMode(mode: MouseMode, force = false): void {
    if (this.mouseMode === mode && !force) return
    const sequence = mode === "drag" ? MOUSE_DRAG_ON : mode === "wheel" ? MOUSE_WHEEL_ON : MOUSE_OFF
    // Saat beralih antar-mode aktif, matikan dulu mode lama supaya SGR dari
    // mode yang ditinggalkan tak bocor sebagai deretan angka di terminal.
    const prefix =
      mode === "off" || this.mouseMode === "off"
        ? ""
        : mode === "drag"
          ? "\x1b[?1000l"
          : "\x1b[?1002l"
    this.writeRaw(prefix + sequence)
    this.mouseMode = mode
  }

  private clearSelectionPaintTimer(): void {
    if (this.selectionPaintTimer !== undefined) {
      clearTimeout(this.selectionPaintTimer)
      this.selectionPaintTimer = undefined
    }
  }

  private paintCurrent(): void {
    // Suspend = pemilik layar lain (popup, approval, modal progres command)
    // sedang melukis regionnya sendiri. Paint batch yang tertunda dari tombol
    // Enter (`flushPendingPaint`) tak boleh menimpanya: submit yang langsung
    // suspend + melukis modal berjalan di dalam handler key yang sama.
    if (this.suspended > 0) {
      this.paintPending = false
      return
    }
    if (this.paintBatchDepth > 0) {
      this.paintPending = true
      return
    }
    this.clearSelectionPaintTimer()
    if (!this.currentScreen || this.quitRequested) return
    try {
      this.paint(this.currentScreen)
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /**
   * Wheel bisa memancarkan banyak event per gerakan fisik. Update posisi
   * scroll dulu (murah), lalu SATU repaint untuk semua event dalam jendela
   * 16 ms — menghindari build-frame + diff per-cell berulang kali.
   */
  private scheduleWheelRepaint(): void {
    if (this.wheelRepaintTimer !== undefined) return
    this.wheelRepaintTimer = setTimeout(() => {
      this.wheelRepaintTimer = undefined
      if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
    }, 16)
    try {
      ;(this.wheelRepaintTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  /**
   * Repaint eksplisit untuk pemilik sink eksternal (approval): blok yang baru
   * dicatat harus terlihat SEBELUM user menjawab. No-op bila layar belum
   * jalan atau sudah quit.
   */
  repaint(): void {
    // Suspend = pemilik layar lain (popup/approval) sedang melukis region
    // sendiri; melukis frame penuh di sini akan menimpanya. Sebelumnya guard
    // ini hanya ada di `requestPaint`, jadi API publik tak konsisten (audit
    // 2026-11-12, MEDIUM-9).
    if (!this.quitRequested && this.suspended === 0) this.paintCurrent()
  }

  // Titik masuk popup komposit (approval/ask_user): lukis kotak di atas
  // transkrip yang sudah redup. Geometri milik currentScreen.
  paintRegion(lines: string[], topRow: number): void {
    if (!this.currentScreen || this.quitRequested) return
    try {
      this.currentScreen.paintRegion(lines, topRow)
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /** Parkir kursor untuk pemilik region modal (approval/ask_user). */
  moveCursor(row: number, col: number): void {
    if (!this.currentScreen || this.quitRequested) return
    try {
      this.currentScreen.moveCursor(row, col)
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /** Atur visibilitas kursor untuk pemilik region modal (read-only/progress). */
  setCursorVisible(visible: boolean): void {
    if (!this.currentScreen || this.quitRequested) return
    try {
      this.currentScreen.setCursorVisible(visible)
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /** Hapus region popup (pasangan paintRegion); App akan repaint penuh saat resume. */
  clearRegion(): void {
    if (!this.currentScreen) return
    try {
      this.currentScreen.clearRegion()
    } catch (error) {
      this.stopAfterRuntimeError(error)
    }
  }

  /** [retry-visibility] Micro-toast minimalis: `retry 1/6 · 12s`. Detik DIHITUNG
   *  live dari event time, bukan angka statis dari pesan error. */
  private retryIndicatorText(): string {
    const state = this.retryInfo
    if (!state) return ""
    const secs = Math.max(1, Math.round((Date.now() - this.retrySince) / 1000))
    return tSystem("msg.retry", { n: state.attempt, total: state.quota, s: secs })
  }

  private viewportHeight(
    rows: number,
    _cols: number,
    busy = this.busy || this.frameStatus?.busy || false,
  ): number {
    // Dropdown `/` adalah overlay di frame yang SAMA — ia tidak mengurangi
    // viewH. Satu-satunya pemotong viewH adalah composer (2 baris tetap).
    // -1 = baris kosong pemisah transkrip ↔ composer (sama seperti buildLayout).
    const inputH = this.composerHeight(busy)
    return Math.max(1, rows - 2 - inputH - 1)
  }

  private composerLayout(): ComposerLayout {
    if (!this.editing) return EMPTY_COMPOSER_LAYOUT
    const w = this.composerWidth()
    const line = this.state.line
    const cursor = this.state.cursor
    const pf = promptFirst(w)
    const cached = this.composerCache
    if (
      cached?.editing &&
      cached.cols === w &&
      cached.cursor === cursor &&
      cached.line === line &&
      cached.prompt === pf
    ) {
      return cached.layout
    }
    const layout =
      (cached?.prompt === pf ? this.incrementalComposerLayout(cached, line, cursor, w) : null) ??
      this.layoutComposer(line, cursor, w)
    this.composerCache = { line, cursor, cols: w, editing: true, prompt: pf, layout }
    return layout
  }

  /** Pastikan layout composer memuat peta baris visual lengkap (dipakai klik & panah vertikal). */
  private composerVisual(): ComposerLayout & { visual: ComposerVisualRow[] } {
    const w = this.composerWidth()
    const cached = this.composerLayout()
    // `EMPTY_COMPOSER_LAYOUT.visual` = [] (truthy): tanpa cek panjang, layout
    // kosong saat !editing dianggap cache hit dan dipakai pemanggil baru.
    if (cached.visual && cached.visual.length > 0)
      return cached as ComposerLayout & { visual: ComposerVisualRow[] }
    const pf = promptFirst(w)
    const full = this.layoutComposer(this.state.line, this.state.cursor, w)
    this.composerCache = {
      line: this.state.line,
      cursor: this.state.cursor,
      cols: w,
      editing: true,
      prompt: pf,
      layout: full,
    }
    return full as ComposerLayout & { visual: ComposerVisualRow[] }
  }

  /** Pindahkan kursor ke baris visual di atas/bawah dalam composer (menjaga kolom). */
  private moveCursorVertical(dir: -1 | 1): boolean {
    if (this.isBusy() || !this.editing || !this.state.line) return false
    // Pakai composerWidth() (lebar chat dibatasi 100), BUKAN cols mentah —
    // kalau tidak, wrap kursor vertikal beda dengan frame pada 120/200 kolom.
    const { visual, visIdx, col } = this.composerVisual()
    const targetIdx = visIdx + dir
    if (targetIdx < 0 || targetIdx >= visual.length) return false
    const desiredCol = this.preferredCol ?? Math.max(0, col - 1)
    this.preferredCol = desiredCol
    this.state = { ...this.state, cursor: cursorAtVisualRowColumn(visual[targetIdx]!, desiredCol) }
    this.selection = null
    this.paintCurrent()
    return true
  }

  /**
   * Coba wrap inkremental untuk ketikan/silang di UJUNG baris. `null` =
   * pemanggil membungkus ulang penuh (`layoutComposer`). Aman: hanya menerima
   * state yang benar-benar perubahan-ujung; bentuk lain jatuh balik.
   */
  private incrementalComposerLayout(
    cached: {
      line: string
      cursor: number
      cols: number
      editing: boolean
      layout: ComposerLayout
    } | null,
    line: string,
    cursor: number,
    w: number,
  ): ComposerLayout | null {
    if (!cached?.editing || cached.cols !== w || !line) return null
    const prevLine = cached.line
    if (prevLine === line) return null
    const prevRows = cached.layout.rows
    if (!prevRows.length) return null
    // Kedua sisi harus ber-kursor di ujung: itulah syarat baris sebelumnya
    // sudah jenuh sehingga hanya baris terakhir yang berubah.
    if (cursor !== pointLength(line) || cached.cursor !== pointLength(prevLine)) return null
    let rows: string[] | null
    if (line.startsWith(prevLine)) {
      rows = appendWrapped(prevRows, line.slice(prevLine.length), w)
    } else if (prevLine.startsWith(line)) {
      rows = shaveWrapped(prevRows, prevLine.slice(line.length), w)
    } else {
      return null
    }
    if (!rows) return null
    if (rows.length === 0) return null
    const lastRow = rows[rows.length - 1] ?? ""
    return { rows, visIdx: rows.length - 1, col: displayWidth(lastRow) + 1 }
  }

  /**
   * Wrap composer + posisi kursor dalam SATU lintasan. Semantiknya sama
   * dengan gabungan inputRows + cursorIndex lama: prefix per baris logis,
   * potong per kolom, kursor di baris visual yang memuat targetWidth.
   */
  private layoutComposer(line: string, cursor: number, w: number): ComposerLayout {
    const pf = promptFirst(w)
    const pc = promptCont(w)
    const pfCols = displayWidth(pf)
    // Prompt kosong SELALU satu baris utuh — sama dengan jalur lama. Tanpa
    // special-case, terminal sempit (w < lebar prefix) memecah prefix jadi dua
    // baris dan menggeser kursor; MIN_COLS membuatnya tak terjangkau di app,
    // tapi helper ini juga dipakai layout lain/test.
    if (!line) {
      return {
        rows: [pf],
        visIdx: 0,
        col: pfCols + 1,
        visual: [
          {
            text: pf,
            prefixCols: pfCols,
            body: "",
            startCursor: 0,
            endCursor: 0,
            softWrapped: false,
          },
        ],
      }
    }
    // Kursor dinormalisasi ke batas grapheme supaya emoji tak terbelah saat
    // dihitung. Hitungan visual & posisi kursor dibangun dari array `visual`
    // yang sama agar render, klik mouse, dan panah atas/bawah selalu sinkron.
    const units = toGraphemes(line)
    const safeCursor = Math.max(0, Math.min(cursor, units.length))
    const visual: ComposerVisualRow[] = []
    const rows: string[] = []
    const logical = line.split("\n")
    let cursorBase = 0
    for (let li = 0; li < logical.length; li++) {
      const prefix = li === 0 ? pf : pc
      const wrapped = chunkByWidth(`${prefix}${logical[li] ?? ""}`, w)
      let prefixRemaining = prefix
      for (let wi = 0; wi < wrapped.length; wi++) {
        const rowText = wrapped[wi] ?? ""
        const plain = stripSgr(rowText)
        let prefixCols = 0
        let body = plain
        if (prefixRemaining) {
          let matched = 0
          while (
            matched < prefixRemaining.length &&
            matched < plain.length &&
            prefixRemaining[matched] === plain[matched]
          ) {
            matched++
          }
          prefixCols = displayWidth(plain.slice(0, matched))
          body = plain.slice(matched)
          prefixRemaining = prefixRemaining.slice(matched)
        }
        const bodyLen = toGraphemes(body).length
        const startCursor = cursorBase
        const endCursor = cursorBase + bodyLen
        visual.push({
          text: rowText,
          prefixCols,
          body,
          startCursor,
          endCursor,
          softWrapped: wi < wrapped.length - 1,
        })
        rows.push(rowText)
        cursorBase = endCursor
      }
      cursorBase += 1
    }
    let visIdx = Math.max(0, visual.length - 1)
    let col = 1
    for (let i = 0; i < visual.length; i++) {
      const row = visual[i]!
      // Baris kursor: baris visual pertama yang memuat `safeCursor` (atau
      // baris akhir baris logis bila kursor tepat di ujung tanpa soft-wrap).
      if (safeCursor < row.endCursor || (safeCursor === row.endCursor && !row.softWrapped)) {
        visIdx = i
        const beforeInRow = toGraphemes(row.body)
          .slice(0, Math.max(0, safeCursor - row.startCursor))
          .join("")
        col = Math.max(1, row.prefixCols + displayWidth(beforeInRow) + 1)
        break
      }
    }
    return { rows, visIdx, col, visual }
  }

  private menuRows(
    rows: number,
    cols: number,
    busy = this.isBusy(),
  ): { lines: string[]; start: number } {
    if (!this.editing || busy || !this.state.menuOpen || !this.state.line.startsWith("/")) {
      return { lines: [], start: 0 }
    }
    const hints = this.host.listCommands(this.state.line)
    if (!hints.length) return { lines: [], start: 0 }
    const room = Math.max(0, rows - 2 - this.composerHeight(busy) - 3)
    const visible = Math.max(1, Math.min(MAX_DROPDOWN_ROWS, room))
    const total = hints.length
    // A1: jendela MENGIKUTI `sel`, bukan selalu slice dari index 0. `sel` bisa
    // wrap melewati jumlah baris terlihat (mis. 24 perintah → sel 9..23), dan
    // bila jendela tetap index 0, tak ada baris tersorot tetapi Enter tetap
    // mengirim hints[sel] — perintah yang tak pernah terlihat (destruktif untuk
    // /clear, /undo). `start` menjaga item terpilih selalu tampil.
    const start = dropdownWindowStart(this.state.sel, visible, total)
    const shown = hints.slice(start, start + visible)
    const w = Math.max(10, cols)
    const out: string[] = []
    shown.forEach((h, i) => {
      const picked = start + i === this.state.sel
      const text = sanitizeAnsiLine(h).replace(/^\/+/, "")
      // Marker `›` + kolom marker tetap: seleksi terbaca tanpa warna dan
      // label tak bergeser saat panah berpindah.
      out.push(listRow(text, picked))
    })
    return { lines: out.map((l) => chunkByWidth(l, w)[0] ?? ""), start }
  }

  private selectedRange(row: TranscriptRow): { start: number; end: number } | null {
    const selection = this.selection
    if (!selection || !row.selectable || row.sourceId < 0) return null
    const first =
      this.transcript.comparePoints(selection.anchor, selection.focus) <= 0
        ? selection.anchor
        : selection.focus
    const last = first === selection.anchor ? selection.focus : selection.anchor
    const rowStart = { id: row.sourceId, offset: row.sourceStart }
    const rowEnd = { id: row.sourceId, offset: row.sourceEnd }
    if (this.transcript.comparePoints(last, rowStart) < 0) return null
    if (this.transcript.comparePoints(first, rowEnd) > 0) return null
    const start =
      first.id === row.sourceId ? Math.max(row.sourceStart, first.offset) : row.sourceStart
    const end = last.id === row.sourceId ? Math.min(row.sourceEnd, last.offset) : row.sourceEnd
    if (end <= start) return null
    return {
      start: this.transcript.columnAtOffset(row, start),
      end: this.transcript.columnAtOffset(row, end),
    }
  }

  private scheduleSelectionPaint(): void {
    if (this.selectionPaintTimer !== undefined) return
    this.selectionPaintTimer = setTimeout(() => {
      this.selectionPaintTimer = undefined
      if (!this.quitRequested && this.suspended === 0 && !this.released) this.paintCurrent()
    }, 16)
    try {
      ;(this.selectionPaintTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private movePromptCursor(
    layout: FrameLayout,
    key: Extract<PromptKey, { type: "mouse" }>,
  ): boolean {
    if (this.isBusy() || !this.editing) return false
    // Translasi x layar → x dalam kolom chat. Klik di padding BUKAN klik
    // composer: kembalikan false supaya caller membersihkan seleksi & repaint.
    const chatX = key.x - layout.padLeft
    if (chatX < 1 || chatX > layout.chatCols) return false
    const relativeRow = key.y - 1 - layout.composerTop
    const targetRow = layout.composerOffset + relativeRow
    const { visual } = this.composerVisual()
    const shownRows = COMPOSER_MAX_ROWS
    if (
      relativeRow < 0 ||
      relativeRow >= shownRows ||
      targetRow < 0 ||
      targetRow >= visual.length
    ) {
      return false
    }
    this.state = {
      ...this.state,
      cursor: cursorAtVisualRowColumn(visual[targetRow]!, chatX - 1),
    }
    this.preferredCol = null
    this.histIdx = -1
    this.editing = true
    this.selection = null
    this.paintCurrent()
    return true
  }

  /**
   * Petakan koordinat baris/kolom ke TranscriptPoint terdekat yang selectable.
   * Menjaga drag selection tetap kontinu saat melintasi separator kosong, border
   * tabel, header blok kode, atau keluar batas atas/bawah viewport.
   */
  private resolveTranscriptPoint(
    layout: FrameLayout,
    rowIndex: number,
    column: number,
  ): TranscriptPoint | null {
    const rows = layout.transcriptRows
    const n = rows.length
    if (n === 0) return null
    const clamped = Math.max(0, Math.min(n - 1, rowIndex))
    const pointOnRow = (idx: number, col: number): TranscriptPoint | null => {
      const target = rows[idx]
      if (!target?.selectable) return null
      return this.transcript.pointAt(target, Math.max(0, col))
    }
    if (rowIndex >= 0 && rowIndex < n) {
      const direct = pointOnRow(clamped, column)
      if (direct) return direct
    }
    if (rowIndex < 0) {
      for (let i = 0; i < n; i++) {
        const p = pointOnRow(i, 0)
        if (p) return p
      }
      return null
    }
    if (rowIndex >= n) {
      for (let i = n - 1; i >= 0; i--) {
        const p = pointOnRow(i, rows[i]!.displayEnd)
        if (p) return p
      }
      return null
    }
    const anchor = this.selection?.anchor
    for (let delta = 1; delta < n; delta++) {
      const upIdx = clamped - delta
      const downIdx = clamped + delta
      const upRow = upIdx >= 0 && rows[upIdx]?.selectable ? rows[upIdx] : undefined
      const downRow = downIdx < n && rows[downIdx]?.selectable ? rows[downIdx] : undefined
      if (upRow && downRow) {
        if (anchor) {
          const upEnd = this.transcript.pointAt(upRow, upRow.displayEnd)
          if (upEnd && this.transcript.comparePoints(anchor, upEnd) <= 0) return upEnd
          const downStart = this.transcript.pointAt(downRow, 0)
          if (downStart) return downStart
        }
        return this.transcript.pointAt(upRow, column) ?? this.transcript.pointAt(downRow, column)
      }
      if (upRow) return this.transcript.pointAt(upRow, upRow.displayEnd)
      if (downRow) return this.transcript.pointAt(downRow, 0)
    }
    return null
  }

  private handleMouse(key: Extract<PromptKey, { type: "mouse" }>): void {
    if (key.action === "move") return
    if (key.button !== 0 && !(key.action === "release" && key.button === null)) return
    const layout = this.lastLayout
    if (!layout) return
    // Satu translasi x layar → x kolom chat, dipakai kelima situs mouse.
    const chatX = key.x - layout.padLeft
    const inPadding = chatX < 1 || chatX > layout.chatCols
    const rowIndex = key.y - 1 - layout.transcriptTop
    const insideTranscript = rowIndex >= 0 && rowIndex < layout.transcriptRows.length
    // Dropdown di-overlay di atas transkrip: klik di area menu HARUS dipetakan
    // ke item menu, bukan menjadi anchor seleksi transkrip yang tertutup menu.
    const menu = layout.menuRegion
    const menuHit =
      menu !== null && !inPadding && key.y >= menu.top && key.y < menu.top + menu.count
    if (key.action === "press") {
      if (menuHit && menu) {
        if (!this.isBusy() && this.state.menuOpen) {
          const idx = menu.firstIndex + (key.y - menu.top)
          const hints = this.host.listCommands(this.state.line)
          if (idx >= 0 && idx < hints.length) {
            this.state = { ...this.state, sel: idx }
            this.paintCurrent()
          }
        }
        return
      }
      if (!insideTranscript) {
        if (this.movePromptCursor(layout, key)) return
        this.selection = null
        this.stopAutoScroll()
        this.paintCurrent()
        return
      }
      // Press di padding = klik di luar chat: abaikan (polanya sama dengan
      // klik pada baris non-selectable) — jangan jadikan anchor seleksi baru.
      if (inPadding) {
        this.selection = null
        this.stopAutoScroll()
        this.paintCurrent()
        return
      }
      const point = this.resolveTranscriptPoint(layout, rowIndex, chatX - 1)
      if (!point) {
        this.selection = null
        this.stopAutoScroll()
        this.paintCurrent()
        return
      }
      this.selection = { anchor: point, focus: point, dragging: true }
      this.updateAutoScroll(layout, key)
      this.paintCurrent()
      return
    }
    if (key.action === "drag") {
      if (!this.selection?.dragging) return
      // Drag melintas area menu: jangan perluas seleksi ke baris tertutup menu.
      if (menuHit) return
      this.updateAutoScroll(layout, key)
      // Drag ke padding di-clamp ke tepi chat: seleksi tetap kontinu.
      const x = Math.max(1, Math.min(layout.chatCols, chatX))
      const point = this.resolveTranscriptPoint(layout, rowIndex, x - 1)
      if (point) this.selection.focus = point
      this.scheduleSelectionPaint()
      return
    }
    if (key.action === "release") {
      if (!this.selection?.dragging) return
      if (menuHit) {
        this.selection.dragging = false
        this.stopAutoScroll()
        this.paintCurrent()
        return
      }
      const x = Math.max(1, Math.min(layout.chatCols, chatX))
      const point = this.resolveTranscriptPoint(layout, rowIndex, x - 1)
      if (point) this.selection.focus = point
      this.selection.dragging = false
      this.stopAutoScroll()
      this.paintCurrent()
    }
  }

  // ── Auto-scroll saat drag seleksi menempel di tepi ──

  /** Mulai/teruskan auto-scroll seleksi ke arah `dir` pada kolom `col`. */
  private startAutoScroll(dir: 1 | -1, col: number): void {
    if (this.autoScrollTimer !== undefined && this.autoScrollDir === dir) {
      this.autoScrollCol = col
      return
    }
    this.stopAutoScroll()
    this.autoScrollDir = dir
    this.autoScrollCol = col
    this.autoScrollTimer = setInterval(() => {
      const sel = this.selection
      if (!sel?.dragging || this.suspended > 0 || this.released) {
        this.stopAutoScroll()
        return
      }
      const layout = this.lastLayout
      if (!layout || layout.transcriptRows.length === 0) return
      // Tautkan fokus ke baris selectable terdekat dari tepi viewport SEBELUM
      // menggulir (pindai masuk bila baris tepi persis border/pemisah kosong).
      const rows = layout.transcriptRows
      // v7.31: dir -1 = tepi ATAS → pindai dari index 0 masuk ke bawah;
      // dir +1 = tepi BAWAH → pindai dari ekor masuk ke atas.
      const step = this.autoScrollDir === -1 ? 1 : -1
      const start = this.autoScrollDir === -1 ? 0 : rows.length - 1
      for (let i = start; i >= 0 && i < rows.length; i += step) {
        const edgeRow = rows[i]!
        if (!edgeRow.selectable) continue
        const p = this.transcript.pointAt(edgeRow, Math.max(0, this.autoScrollCol - 1))
        if (p) {
          sel.focus = p
          break
        }
      }
      // v7.31: scrollRows(-1) = ke atas/konten lama, +1 = ke bawah/baru.
      this.scrollRows(this.autoScrollDir)
    }, 60)
    try {
      ;(this.autoScrollTimer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer !== undefined) {
      clearInterval(this.autoScrollTimer)
      this.autoScrollTimer = undefined
    }
  }

  /** Deteksi tepi viewport dari posisi mouse dan nyalakan/matikan auto-scroll. */
  private updateAutoScroll(layout: FrameLayout, key: Extract<PromptKey, { type: "mouse" }>): void {
    if (!this.selection?.dragging) {
      this.stopAutoScroll()
      return
    }
    const n = layout.transcriptRows.length
    if (n === 0) {
      this.stopAutoScroll()
      return
    }
    const rowIndex = key.y - 1 - layout.transcriptTop
    // v7.31: anchor atas → tepi ATAS = gulir ke lama (scrollBack mengecil,
    // dir -1), tepi BAWAH = ke baru (dir +1). Sebelumnya terbalik sehingga
    // seleksi drag tak bisa diperpanjang melewati viewport.
    // X untuk auto-scroll sudah dalam koordinat chat (autoScrollCol dipakai
    // sebagai offset relatif baris transkrip, bukan kolom layar absolut).
    const chatX = Math.max(1, Math.min(layout.chatCols, key.x - layout.padLeft))
    if (rowIndex <= 0) this.startAutoScroll(-1, chatX)
    else if (rowIndex >= n - 1) this.startAutoScroll(1, chatX)
    else this.stopAutoScroll()
  }

  private copySelection(): void {
    const selection = this.selection
    if (!selection) return
    // Salin teks ASLI (bukan `.trim()`): indentasi baris pertama dan newline di
    // ekor adalah bagian dari konten yang dipilih pengguna (blok kode/teks
    // berindentasi). Trim hanya untuk mendeteksi "seleksi kosong".
    const text = this.transcript.selectionText(selection.anchor, selection.focus)
    if (!text.trim()) {
      this.selection = null
      this.paintCurrent()
      return
    }
    if (text.length > MAX_SELECTION_CHARS || utf8ByteLength(text) > MAX_SELECTION_BYTES) {
      // v7.30: kwitansi salin BUKAN percakapan — tampil di footer (toast),
      // jangan jadi baris permanen di transkrip.
      this.showToast(tSystem("msg.copyTooLarge"))
      return
    }
    let copied = false
    try {
      copied = this.host.copySelection(text)
    } catch {}
    const msg = tSystem(copied ? "msg.copied" : "msg.copyFailed")
    // v7.30: hasil salin adalah kwitansi UI, bukan giliran bicara — footer saja.
    this.showToast(msg)
  }

  private buildLayout(rows: number, cols: number, snap: TuiStatusSnapshot): FrameLayout {
    const height = Math.max(1, Math.floor(rows))
    const width = Math.max(1, Math.floor(cols))
    const busy = this.busy || snap.busy
    const now = Date.now()
    if (busy) {
      if (!this.turnStartedAt) this.turnStartedAt = now
      this.startActivityClock()
    } else {
      this.turnStartedAt = 0
    }
    // Badge hidup saat busy DAN idle; clock-nya terpisah dari activity.
    const backgroundJobs = snap.footer.backgroundJobs ?? 0
    if (backgroundJobs >= 1) this.startWaitingClock()
    else this.stopWaitingClock()
    // Satu geometri untuk seluruh frame — `chatCols` TIDAK bergantung viewH,
    // jadi tak perlu hitung dua kali dengan tinggi berbeda.
    const geom = chatColumnGeometry(height, width)
    const chatCols = geom.chatCols
    const padLeft = geom.padLeft
    const padRight = geom.padRight
    const prevChatCols = this.lastChatCols
    this.lastChatCols = chatCols

    // v7.29: card prompt DIHAPUS — prompt kini menjadi history biasa di
    // transkrip (lihat `projectRows`). Biarkan cardRows kosong; semua turunan
    // `cardH` di bawah (viewH, cursorRow, composerTop) otomatis collapse ke 0,
    // sehingga tinggi frame & pemetaan mouse tetap konsisten.
    const menuView = this.menuRows(height, chatCols, busy)
    const allComposer = this.composerRows(snap, busy, now)
    const contentBudget = Math.max(1, height - 3)
    let menu = menuView.lines
    // Composer TETAP 2 baris di semua state — TIDAK bergantung pada
    // `composerLive(busy)`/`editing`. Kalau tinggi mengikuti `editing`, prompt
    // bergeser satu baris di transisi submit → busy → selesai (viewH berubah).
    // Jendela geser `composerOffset` menangani draft panjang; dropdown overlay.
    let composerH = COMPOSER_MAX_ROWS
    if (menu.length + composerH > contentBudget) {
      menu = menu.slice(0, Math.max(0, contentBudget - 1))
      composerH = Math.max(1, contentBudget - menu.length)
    }
    const cardRows: string[] = []
    const cardH = 0
    // Dropdown adalah OVERLAY di baris transkrip bawah — TIDAK mengurangi
    // viewH. Ini menyamakan viewH dengan `viewportHeight()` di jalur scroll.
    const viewH = Math.max(1, height - 2 - composerH - cardH - 1)
    // v7.28: indikator "baris baru" muncul saat user TIDAK berada di ekor.
    // Ambangnya memakai VIEWH FINAL yang sama dengan frame (bukan hitungan
    // terpisah yang bisa melenceng saat menu/draft berubah).
    const maxBackForIndicator = Math.max(0, this.transcript.wrappedLength(chatCols) - viewH)
    const awayFromTail = this.scrollBack < maxBackForIndicator
    const newCount = awayFromTail ? this.transcript.total() - this.scrollBase : 0
    // Baris indikator WAJIB dipotong ke lebar frame seperti baris lain: teks
    // locale id lebih panjang dari terminal sempit (51 kolom untuk abort hint),
    // dan baris lebih lebar dari `cols` membungkus sendiri → frame jadi
    // `rows+1`, alt-screen scroll, seluruh diff CUP meleset (audit 2026-11-12,
    // HIGH-3).
    // Indikator status (abort hint / "N baris di bawah") TIDAK memakai baris
    // frame sendiri: ia MENGGANTIKAN isi baris footer selama aktif (lihat
    // `frame` di bawah). Dua alasan:
    //   (a) tinggi frame tidak bergantung status. Dulu baris indikator
    //       menambah/mengurangi satu baris, dan karena `viewH` memilih jendela
    //       transkrip, seluruh isi layar bergeser di antara frame — gejala
    //       "teks naik-turun";
    //   (b) tidak memakan satu baris transkrip permanen demi pesan sementara.
    // v7.30: toast (kwitansi perintah) lebih baru daripada hint abort —
    // kalau hint menang, pesan toast tak pernah terlihat (pesan dijamin tampil).
    // Urutan baru: toast > hint abort > indikator "baris baru". Tinggi frame
    // tetap satu baris, jadi geometri/composer tidak berubah.
    // v0.33: retry adalah MICRO-TOAST yang DITAMBAHKAN ke footer — bukan
    // pengganti. Footer (model/konteks/timer/mode) tetap utuh; toast hilang
    // sendiri setelah 4 dtk atau saat turn selesai.
    const retryLine =
      busy && this.retryInfo && Date.now() < this.retryToastUntil ? this.retryIndicatorText() : ""
    const indicatorLine = this.statusToast
      ? c.accent(truncateToWidth(this.statusToast, width))
      : busy && this.abortHintOn
        ? c.warning(truncateToWidth(tSystem("msg.abortedHint"), width))
        : newCount > 0
          ? c.muted(truncateToWidth(t("app.newBelow", { n: newCount }), width))
          : ""

    // Rebase scroll saat lebar berubah: indeks baris mentah melompat ketika
    // wrap berubah. Simpan anchor (id, offset) dari baris viewport pertama di
    // lebar LAMA, lalu cari lagi posisinya di lebar BARU.
    if (prevChatCols != null && prevChatCols !== chatCols && !this.pinnedToTail) {
      const oldVp = this.transcript.viewport(
        prevChatCols,
        this.lastLayout?.viewH ?? viewH,
        this.scrollBack,
      )
      const first = oldVp.rows.find((r) => r.selectable && r.sourceId >= 0)
      if (first) this.pendingScrollAnchor = this.transcript.pointAt(first, first.displayStart)
    }
    // v0.33: anchor atas + sticky tail. Baris baru memang ditambahkan di bawah,
    // tetapi SELAMA user tidak sengaja scroll ke atas, viewport harus ikut ke
    // ekor. Tanpa ini `scrollBack` absolut menjadi basi saat transkrip tumbuh
    // (streaming/tool), layar tampak diam dan tertinggal (laporan pemilik).
    // Pakai `viewH` yang SAMA dengan viewport di bawah agar tidak ada selisih
    // geometri dengan `viewportHeight()`.
    if (this.pendingScrollAnchor) {
      const idx = this.transcript.indexOfPoint(this.pendingScrollAnchor, chatCols)
      this.pendingScrollAnchor = null
      if (idx >= 0) this.scrollBack = idx
    } else if (this.pinnedToTail && !this.selection) {
      // v0.43 — sticky-tail + ratchet naik-saja. Baris live transien dibatasi
      // maksimal TIGA baris terakhir di tail transkrip (lihat
      // `MAX_LIVE_TAIL_ROWS`), jadi narasi committed tak terdorong keluar
      // viewport. Saat live hilang `total` menyusut tetapi floor menahan
      // jendela: posisi baris committed di layar tetap, bawah boleh kosong.
      const maxBack = Math.max(0, this.transcript.wrappedLength(chatCols) - viewH)
      this.scrollBack = Math.max(maxBack, this.turnScrollFloor)
      this.turnScrollFloor = Math.max(this.turnScrollFloor, this.scrollBack)
    }
    const viewport = this.transcript.viewport(chatCols, viewH, this.scrollBack)
    if (
      this.selection &&
      (!this.transcript.hasSource(this.selection.anchor.id) ||
        !this.transcript.hasSource(this.selection.focus.id) ||
        (!this.selection.dragging &&
          this.transcript.selectionIsEmpty(this.selection.anchor, this.selection.focus)))
    ) {
      this.selection = null
    }
    // Transcript sudah menyembunyikan gema user terakhir (card) dan
    // menormalkan jeda — viewport tinggal dipakai apa adanya.
    const bodyRows = viewport.rows
    let body = bodyRows.map((row) => row.text)
    if (this.selection) {
      const sel = this.selection
      const first =
        this.transcript.comparePoints(sel.anchor, sel.focus) <= 0 ? sel.anchor : sel.focus
      const last = first === sel.anchor ? sel.focus : sel.anchor
      const ranges = bodyRows.map((row) => this.selectedRange(row))
      let topSelected = -1
      let bottomSelected = -1
      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i]) {
          if (topSelected === -1) topSelected = i
          bottomSelected = i
        }
      }
      body = bodyRows.map((row, i) => {
        const selected = ranges[i]
        if (selected) return highlightColumns(row.text, selected.start, selected.end)
        // Jaga kontinitas visual blok seleksi saat melintasi jeda paragraf/poin
        // kosong atau baris border/header non-selectable yang diapit teks terpilih.
        const spannedLogical =
          row.selectable &&
          row.sourceId >= 0 &&
          this.transcript.comparePoints(first, { id: row.sourceId, offset: row.sourceStart }) < 0 &&
          this.transcript.comparePoints(last, { id: row.sourceId, offset: row.sourceEnd }) > 0
        const spannedVisual = topSelected !== -1 && i > topSelected && i < bottomSelected
        if (spannedLogical || spannedVisual) {
          const wRow = displayWidth(row.text)
          return wRow > 0 ? highlightColumns(row.text, 0, wRow) : "\x1b[7m \x1b[27m"
        }
        return row.text
      })
    }
    // Renderer flat: zero-state sengaja KOSONG. Logo, hint, dan identitas tidak
    // diulang di transkrip — footer sudah memuat model/cwd, dan layar kosong
    // lebih jujur daripada dekorasi. Komposer tetap menjadi satu-satunya
    // petunjuk bahwa aplikasi siap menerima input.

    const pf = promptFirst(this.composerWidth())
    let shownComposer: string[]
    let cursorRow: number
    let cursorCol = 1
    let composerOffset = 0
    if (this.composerLive(busy)) {
      // Composer memakai composerWidth() satu-sumber (chat dibatasi 100 kolom).
      const cursor = this.composerLayout()
      const winStart = Math.max(0, Math.min(allComposer.length - composerH, cursor.visIdx))
      composerOffset = winStart
      shownComposer = allComposer.slice(winStart, winStart + composerH)
      // Baris komposer dijamin tepat `composerH` supaya frame tak berubah
      // walau draft hanya satu baris — transkrip tidak bergeser saat mengetik.
      while (shownComposer.length < composerH) shownComposer.push("")
      // +1 untuk baris kosong pemisah transkrip ↔ composer.
      cursorRow = viewH + 1 + cardH + (cursor.visIdx - winStart) + 1
      cursorCol = cursor.col
    } else {
      shownComposer = allComposer.slice(0, composerH)
      while (shownComposer.length < composerH) shownComposer.push("")
      cursorRow = viewH + 1 + cardH + 1
      // v7.30: SELALU parkir caret tepat setelah prompt, termasuk saat busy
      // dengan editing=false (cabang ini). Dulu `if (!busy)` membuat cursorCol
      // tetap 1 saat submit → caret tampil SEBELUM prompt (`| minicode ›`).
      cursorCol = displayWidth(pf) + 1
    }
    if (this.composerLive(busy) && composerOffset === 0 && shownComposer[0]?.startsWith(pf)) {
      shownComposer = [
        `${c.accent(pf)}${shownComposer[0]!.slice(pf.length)}`,
        ...shownComposer.slice(1),
      ]
    }

    const started = this.turnStartedAt || now
    const sparkInterval = this.streamIntervalMs > 0 ? this.streamIntervalMs : DOT_INTERVAL_MS
    const sparkFrame =
      busy && !motionReduced() ? Math.max(1, Math.floor((now - started) / sparkInterval) + 1) : 0
    const elapsed = now - started
    const timer = busy ? formatTimer(elapsed) : TIMER_TEXT
    const footer =
      renderFooter(
        {
          ...snap.footer,
          sparkFrame,
          streamIntervalMs: this.streamIntervalMs,
          timer,
          timerActive: busy,
          timerHighlight: timerHighlight(elapsed),
          // Frame badge dihitung dari clock badge sendiri (waitingStartedAt),
          // bukan dari turn: job background berputar juga saat idle.
          backgroundFrame:
            backgroundJobs >= 1 && !motionReduced()
              ? Math.floor((now - (this.waitingStartedAt || now)) / WAITING_INTERVAL_MS)
              : 0,
        },
        chatCols,
      )[0] ?? ""
    // Dropdown = OVERLAY: timpa baris transkrip PALING BAWAH di frame yang
    // SAMA (bukan paintRegion / write terpisah). Baris transkrip lain tetap
    // di posisinya → tidak bergeser saat menu muncul. Transkrip pendek di-pad
    // dengan baris kosong di ATAS supaya posisinya sama seperti tanpa menu.
    while (body.length < viewH) body.unshift("")
    const overlay = Math.min(menu.length, body.length)
    const overlayStart = body.length - overlay
    if (overlay > 0) {
      body = [...body.slice(0, overlayStart), ...menu.slice(menu.length - overlay)]
    }
    const frame = [
      ...body,
      // Napas WAJIB antara transkrip dan composer — dulu composer menempel
      // langsung ke baris teks terakhir saat transkrip penuh.
      "",
      ...cardRows,
      ...shownComposer,
      "",
      indicatorLine
        ? truncateToWidth(indicatorLine, chatCols)
        : truncateToWidth(retryLine ? `${c.warning(retryLine)}  ${footer}` : footer, chatCols),
    ]
    const rawLength = frame.length
    const crop = Math.max(0, rawLength - height)
    const topPad = Math.max(0, height - rawLength)
    while (frame.length < height) frame.unshift("")
    const out = frame.slice(-height)
    // Satu frame, satu write: chat ter-centre lewat padding spasi di kedua sisi.
    // Padding ditulis di frame yang SAMA (bukan write terpisah) supaya kontrak
    // satu-write & writer-inventory tetap hijau. Berlaku untuk SEMUA baris out,
    // termasuk footer dan spacer — kalau tidak, tepi kanan bergetar tiap baris.
    for (let r = 0; r < out.length; r++) {
      // padToWidth menjaga chat selalu `chatCols` kolom: teks pendek tak bikin
      // padding kanan bergeser saat isi berubah (kontrak render lama).
      out[r] =
        " ".repeat(padLeft) +
        padToWidth(truncateToWidth(out[r] ?? "", chatCols), chatCols) +
        " ".repeat(padRight)
    }
    return {
      frame: out,
      cursor: {
        row: Math.max(1, Math.min(height, cursorRow + topPad - crop)),
        // CUP absolut: composer digambar di dalam kolom chat yang ter-centre.
        col: Math.max(1, cursorCol + padLeft),
      },
      cols: Math.max(10, width),
      chatCols,
      padLeft,
      padRight,
      viewH,
      transcriptRows: bodyRows,
      // Padding transkrip ditambahkan di ATAS (lihat overlay) → geser pemetaan.
      transcriptTop: topPad - crop + (viewH - bodyRows.length),
      // +1 = baris kosong pemisah (lihat frame) — klik composer harus naik 1.
      composerTop: topPad - crop + viewH + 1 + cardH,
      composerLines: allComposer,
      composerOffset,
      // Baris 1-based dari overlay menu di layar (dipakai handleMouse).
      menuRegion:
        overlay > 0
          ? { top: topPad - crop + overlayStart + 1, count: overlay, firstIndex: menuView.start }
          : null,
    }
  }

  /** True bila terminal menciut di bawah minimum TUI (MIN_ROWS/MIN_COLS). */
  private tooSmall(): boolean {
    const cols = process.stdout.columns || 0
    const rows = process.stdout.rows || 0
    return rows < MIN_ROWS || cols < MIN_COLS
  }

  private paint(screen: AltScreen): void {
    this.currentScreen = screen
    const cols = screen.cols
    const rows = screen.rows
    if (this.tooSmall()) {
      this.lastLayout = null
      const w = Math.max(1, cols)
      const frame = [c.warning(truncateToWidth(tSystem("msg.tooSmall"), w))]
      while (frame.length < Math.max(1, rows)) frame.push("")
      screen.paint(frame.slice(0, Math.max(1, rows)))
      this.frames++
      return
    }
    // SATU pembacaan status per frame. buildLayout & seluruh helper turunannya
    // memakai `snap` ini (lewat argumen `busy` eksplisit), bukan getStatus ulang.
    const snap = this.host.getStatus()
    this.frameStatus = snap
    const layout = this.buildLayout(rows, cols, snap)
    this.lastLayout = layout
    screen.paint(layout.frame, layout.cursor)
    this.frames++
    this.frameStatus = null
  }
}
