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
import { appendWrapped, shaveWrapped } from "../render/composer-wrap.ts"
import { formatError } from "../render/errors.ts"
import { listRow } from "../render/list.ts"
import { sanitizeAnsi, sanitizeAnsiLine, stripSgr } from "../render/sanitize.ts"
import { c, glyphs, scrimMode, scrimSgr } from "../render/theme.ts"
import { chunkByWidth, displayWidth, escapeLength, truncateToWidth } from "../render/width.ts"
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
   * Controller mengantrinya sebagai informasi tambahan: dikirim setelah turn
   * aktif selesai, bukan disuntik ke tengah step provider (kernel tak punya
   * seam untuk itu). `false` = ditolak (mis. baris `/slash` yang butuh idle),
   * dan controller sudah menjelaskan alasannya ke transkrip. Absen = perilaku
   * lama: input beku total saat busy.
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

/** Tinggi maksimum blok input (baris logis di-wrap, kursor selalu terlihat). */
const MAX_INPUT_ROWS = 5
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

const promptFirst = (): string => `minicode ${glyphs.arrow} `
const promptCont = (): string => `  ${glyphs.dot} `
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
  cols: number
  transcriptRows: TranscriptRow[]
  transcriptTop: number
  composerTop: number
  composerLines: string[]
  composerOffset: number
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
  /** Timestamp abort terakhir (ms) — dipakai BERSAMA `awaitingSecondEsc` untuk
   * jendela double-tap Esc = quit. Timestamp saja tak cukup: ia basi setelah
   * draft baru diketik (temuan audit VERIFIED). */
  private lastAbortAt = 0
  /**
   * Khusus jendela "Esc lagi = quit" setelah abort. Beda dari `lastIdleEscapeAt`
   * (gesture /undo saat idle) dan diprogram ulang tiap abort. Draft baru / submit
   * / lewatnya 1,5 dtk mematikan flag ini supaya Esc berikutnya tak menyalahartikan
   * "hapus draft" sebagai quit.
   */
  private awaitingSecondEsc = false
  private lastIdleEscapeAt = 0
  /** Hint "tekan lagi untuk keluar" tampil sekali setelah abort pertama. */
  private abortHintOn = false
  /** Micro-toast 2 detik di slot footer saat mengganti bahasa/salin. */
  private statusToast = ""
  private toastTimer: ReturnType<typeof setTimeout> | undefined
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
  private releaseBackdrop: (() => void) | null = null
  private selection: SelectionState | null = null
  private lastLayout: FrameLayout | null = null
  /**
   * Cache layout composer: satu paint memanggil tinggi, isi, dan posisi
   * kursor untuk state yang SAMA. Dulu tiap panggilan me-wrap ulang seluruh
   * teks (3×), jadi ketikan panjang membayar wrap berulang. Key memuat line,
   * kursor, lebar efektif, dan mode editing agar tak menyajikan frame basi.
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
        // Lukis layar AKTIF (bukan handle `screen` run() yang basi setelah
        // release+reacquire gagal — dulu repaint/resize melukis ke handle
        // tertutup sekaligus menimpa currentScreen baru dengannya).
        this.paintCurrent()
      }
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on("data", this.onData)
      stdout.on("resize", this.onResize)
      // Sinyal fatal (temuan audit TUI-001): default kernel-kill TIDAK
      // menjalankan handler "exit" Node — terminal bisa tertinggal alt-screen
      // + raw mode. Dipasang per-run, dilepas di cleanup (pasangan ketat).
      // Handler TERPISAH per sinyal: Bun TIDAK menyampaikan nama sinyal ke
      // handler (argumen undefined — beda dengan Node), jadi satu handler
      // bersama tak bisa membedakan TERM vs HUP dari parameternya.
      // WAJIB tetap di blok sinkron yang sama dengan openAltScreen() di atas
      // (tanpa await di antaranya): sinyal hanya disampaikan antar-tick event
      // loop, jadi tak ada jendela nyata; sisipkan await di antara keduanya =
      // membuka race SIGTERM sebelum handler terpasang.
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
      this.onExit = () => this.setMouseMode("off")
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
        this.turnStartedAt = Date.now()
        this.streamDeltas = []
        this.lastStreamTextAt = 0
        this.streamIntervalMs = 0
        // Turn BARU harus mulai bersih: hint "Esc lagi = quit" dari abort di
        // turn sebelumnya tak boleh bocor ke turn yang tak berhubungan (audit).
        this.abortHintOn = false
        this.startActivityClock()
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
      sub("turn:completed", () => {})
      sub("context:compacted")
      // v7.28: anchor atas membuat 0 = kepala. Resume history harus mulai
      // dari ekor (terbaru), sama seperti setelah ketikan/submit.
      this.followTail()
      this.scrollBase = this.transcript.total()
      this.setMouseMode(mouseSelectionEnabled() ? "drag" : "off")
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
      this.scrollBy(key.type === "wheelup" ? -0.5 : 0.5)
      return
    }
    // Scroll SELALU tersedia (menu buka/tutup, busy/idle, layar menciut) —
    // di-intercept sebelum engine supaya tak jadi histori maupun teks.
    // Dulu di bawah gate tooSmall: terminal menciut + turn busy = tak bisa
    // scroll maupun abort (harus kill -9).
    // Shift+PgUp/PgDn (ESC[5;2~/6;2~, didekode modifier 2 = shift) = setengah
    // halaman (temuan audit TUI-002): halaman penuh terlalu kasar untuk
    // transkrip panjang; Home/End = lompat top/tail (di bawah).
    if (key.type === "pageup" || key.type === "pagedown") {
      const mod = key.modifier ?? 0
      if (mod === 2) {
        // v7.28: PgUp = naik (negatif), PgDn = turun (positif).
        this.scrollBy(key.type === "pageup" ? -0.5 : 0.5)
        return
      }
      this.scrollBy(key.type === "pageup" ? -1 : 1)
      return
    }
    // Home/End LOMPAT transkrip HANYA saat prompt kosong & tanpa dropdown
    // (temuan audit TUI-002): transkrip cap 5000 baris ≈ 125 halaman —
    // menekan PgUp 125× bukan navigasi. Home = baris teratas, End = kembali
    // ke ekor. Baris BERISI = tombol editing (awal/akhir baris, kontrak lama);
    // dropdown terbuka = navigasi menu (jalur engine).
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
    if (key.type === "ctrl-c") {
      if (this.selection && !this.selection.dragging) this.copySelection()
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
      cursorOnly && this.editing && this.currentScreen?.ok
        ? this.composerLayout(Math.max(10, this.currentScreen.cols)).visIdx
        : -1
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
    const composer = this.composerLayout(Math.max(10, screen.cols))
    const visibleRows = Math.min(MAX_INPUT_ROWS, Math.max(1, layout.composerLines.length))
    // Bila kursor berpindah ke luar jendela composer terlihat (input > 5 baris),
    // lukis ulang penuh agar `composerOffset` & baris tampil ikut bergulir.
    if (
      composer.visIdx < layout.composerOffset ||
      composer.visIdx >= layout.composerOffset + visibleRows
    ) {
      this.paintCurrent()
      return
    }
    const row = Math.max(1, layout.cursor.row + (composer.visIdx - prevVisIdx))
    const col = Math.max(1, composer.col)
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
    this.state = createState()
    this.preferredCol = null
    this.histIdx = -1
    this.editing = false
    this.followTail()
    this.abortHintOn = false
    this.disarmAbortQuit()
    if (!line) {
      // Enter pada baris kosong tetap idle: prompt harus langsung kembali
      // (I13), bukan menghilang sampai ketikan berikutnya.
      this.editing = true
      this.paintCurrent()
      return
    }
    this.rememberHistory(line)
    // Built-in commands and shortcuts belong to the composer history, not the
    // conversation transcript. The command result remains independently
    // visible when it carries useful user-facing information.
    if (!line.startsWith("/")) {
      // v7.29: prompt masuk transkrip sebagai history biasa (tanpa card).
      this.transcript.pushUser(rawLine)
    }
    this.busy = true
    this.turnStartedAt = Date.now()
    this.lastAbortAt = 0
    this.startActivityClock()
    this.paintCurrent()
    try {
      const res = await this.host.submit(line)
      if (res?.quit) this.quit()
    } catch (e) {
      // [P0 UI Security] Pesan error = TEKS TAK DIPERCAYA: bisa memuat body
      // provider, header `Authorization: Bearer …`, atau escape ANSI. Jalur
      // lama `e.message` mentah membocorkan credential ke layar TUI — kini
      // lewat formatter kanonik (redaksi credential + sanitasi + pemotongan).
      this.transcript.pushError(formatError(e))
    } finally {
      this.busy = false
      this.editing = true
      this.turnStartedAt = 0
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
    const layout = this.buildLayout(rows, cols, snap)
    this.lastLayout = layout
    const frozen = layout.frame.map((ln) => TuiApp.applyBackdropDim(ln))
    screen.paint([...frozen])
    this.frames++
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

  private isBusy(): boolean {
    if (this.busy) return true
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
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const viewH = this.viewportHeight(rows, cols)
    const wrapped = this.transcript.wrappedLength(cols)
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
  private scrollRows(n: number): void {
    const cols = process.stdout.columns || 80
    const rows = process.stdout.rows || 24
    const viewH = this.viewportHeight(rows, cols)
    const wrapped = this.transcript.wrappedLength(cols)
    const maxBack = Math.max(0, wrapped - viewH)
    // v7.28: n > 0 = gulir ke bawah (lebih baru), n < 0 = ke atas.
    if (this.scrollBack === maxBack && n < 0) this.scrollBase = this.transcript.total()
    this.scrollBack = Math.max(0, Math.min(this.scrollBack + n, maxBack))
    if (this.scrollBack === maxBack) {
      this.scrollBase = this.transcript.total()
    }
    this.paintCurrent()
  }

  /**
   * Lompat ke ujung transkrip (temuan audit TUI-002): Home = baris teratas
   * (scrollBack maksimum), End = ekor. `lastWrapped` dinetralkan SEBELUM
   * perhitungan kunci-posisi-baca berikutnya: jendela yang sengaja dipindah
   * user bukan drift stream, tanpa ini paint pertama post-jump menarik
   * viewport kembali ke ekor (lompatan tak terlihat).
   */
  private jumpEdge(top: boolean): void {
    const rows = process.stdout.rows || 24
    const cols = process.stdout.columns || 80
    const curWrapped = this.transcript.wrappedLength(cols)
    const viewH = this.viewportHeight(rows, cols)
    const maxBack = Math.max(0, curWrapped - viewH)
    // v7.28: Home = kepala (0), End = ekor (maks).
    if (top) {
      this.scrollBack = 0
    } else {
      if (this.scrollBack === maxBack) this.scrollBase = this.transcript.total()
      this.scrollBack = maxBack
      this.scrollBase = this.transcript.total()
    }
    this.paintCurrent()
  }

  /** Kembali ke ekor (bawah): dipakai tiap ketikan/submit baru (I18). */
  private followTail(): void {
    const cols = process.stdout.columns || 80
    const viewH = this.viewportHeight(process.stdout.rows || 24, cols)
    this.scrollBack = Math.max(0, this.transcript.wrappedLength(cols) - viewH)
    this.scrollBase = this.transcript.total()
  }

  /** Kosongkan transkrip (/clear): viewport + basis scroll ikut di-reset agar
   * tak tertinggal scrollBack basi (layar kosong + user harus PgDn manual). */
  clearView(): void {
    this.transcript.clear()
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

  private composerRows(
    cols: number,
    snap: TuiStatusSnapshot,
    busy: boolean,
    now: number,
  ): string[] {
    // v7.29: kolom chat BERSIH — tidak ada status/progres di composer, baik
    // idle maupun busy. Status kerja tampil di footer indicatorLine, bukan di
    // sini. Composer selalu menampil prompt/draft saja, siap diketik.
    void snap
    void busy
    void now
    // Idle: prompt tetap tampil. Dulu baris kosong menggantikannya sehingga
    // setelah Esc/Enter-kosong layar terlihat mati (I13: prompt tampil saat
    // boot/idle) — audit 2026-11-12, MEDIUM-4.
    if (!this.editing) return [chunkByWidth(promptFirst(), Math.max(10, cols))[0] ?? ""]
    return this.composerLayout(cols).rows
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

  private composerHeight(cols: number, busy = this.busy): number {
    if (!this.composerLive(busy)) return 1
    return Math.min(MAX_INPUT_ROWS, Math.max(1, this.composerLayout(cols).rows.length))
  }

  // ── Paint ──

  private currentScreen: AltScreen | null = null

  private setMouseMode(mode: MouseMode): void {
    if (this.mouseMode === mode) return
    const sequence = mode === "drag" ? MOUSE_DRAG_ON : mode === "wheel" ? MOUSE_WHEEL_ON : MOUSE_OFF
    try {
      if (mode === "off" || this.mouseMode === "off") process.stdout.write(sequence)
      else if (mode === "drag") process.stdout.write(`\x1b[?1000l${sequence}`)
      else process.stdout.write(`\x1b[?1002l${sequence}`)
      this.mouseMode = mode
    } catch {}
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

  private viewportHeight(rows: number, cols: number): number {
    const busy = this.isBusy()
    const inputH = this.composerHeight(cols, busy)
    const menuH = this.menuHeight(rows, cols, busy)
    return Math.max(1, rows - 2 - inputH - menuH)
  }

  private composerLayout(cols: number): ComposerLayout {
    if (!this.editing) return EMPTY_COMPOSER_LAYOUT
    const w = Math.max(10, cols)
    const line = this.state.line
    const cursor = this.state.cursor
    const pf = promptFirst()
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
  private composerVisual(cols: number): ComposerLayout & { visual: ComposerVisualRow[] } {
    const w = Math.max(10, cols)
    const cached = this.composerLayout(w)
    if (cached.visual) return cached as ComposerLayout & { visual: ComposerVisualRow[] }
    const pf = promptFirst()
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
    const cols = Math.max(10, this.currentScreen?.cols || process.stdout.columns || 80)
    const { visual, visIdx, col } = this.composerVisual(cols)
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
    const pf = promptFirst()
    const pc = promptCont()
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

  private menuRows(rows: number, cols: number, busy = this.isBusy()): string[] {
    if (!this.editing || busy || !this.state.menuOpen || !this.state.line.startsWith("/")) return []
    const hints = this.host.listCommands(this.state.line)
    if (!hints.length) return []
    const room = Math.max(0, rows - 2 - this.composerHeight(cols, busy) - 3)
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
    return out.map((l) => chunkByWidth(l, w)[0] ?? "")
  }

  private menuHeight(rows: number, cols: number, busy = this.isBusy()): number {
    return this.menuRows(rows, cols, busy).length
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
    const relativeRow = key.y - 1 - layout.composerTop
    const targetRow = layout.composerOffset + relativeRow
    const { visual } = this.composerVisual(layout.cols)
    const shownRows = Math.min(MAX_INPUT_ROWS, Math.max(1, visual.length - layout.composerOffset))
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
      cursor: cursorAtVisualRowColumn(visual[targetRow]!, key.x - 1),
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
    const rowIndex = key.y - 1 - layout.transcriptTop
    const insideTranscript = rowIndex >= 0 && rowIndex < layout.transcriptRows.length
    if (key.action === "press") {
      if (!insideTranscript) {
        if (this.movePromptCursor(layout, key)) return
        this.selection = null
        this.stopAutoScroll()
        this.paintCurrent()
        return
      }
      const point = this.resolveTranscriptPoint(layout, rowIndex, key.x - 1)
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
      this.updateAutoScroll(layout, key)
      const point = this.resolveTranscriptPoint(layout, rowIndex, key.x - 1)
      if (point) this.selection.focus = point
      this.scheduleSelectionPaint()
      return
    }
    if (key.action === "release") {
      if (!this.selection?.dragging) return
      const point = this.resolveTranscriptPoint(layout, rowIndex, key.x - 1)
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
    if (rowIndex <= 0) this.startAutoScroll(-1, key.x)
    else if (rowIndex >= n - 1) this.startAutoScroll(1, key.x)
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
      this.showToast(t("tui.selectionTooLarge"))
      return
    }
    let copied = false
    try {
      copied = this.host.copySelection(text)
    } catch {}
    const msg = t(copied ? "tui.selectionCopied" : "tui.selectionCopyFailed")
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
    // v7.28: indikator "baris baru" muncul saat user TIDAK berada di ekor
    // (anchor atas → ekor = maks, bukan 0).
    const maxBackForIndicator = Math.max(
      0,
      this.transcript.wrappedLength(width) -
        Math.max(
          1,
          height -
            2 -
            Math.min(MAX_INPUT_ROWS, Math.max(1, this.composerRows(width, snap, busy, now).length)),
        ),
    )
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
    const indicatorLine = this.statusToast
      ? c.accent(truncateToWidth(this.statusToast, width))
      : busy && this.abortHintOn
        ? c.warning(truncateToWidth(t("app.abortHint"), width))
        : newCount > 0
          ? c.muted(truncateToWidth(t("app.newBelow", { n: newCount }), width))
          : ""

    const allMenu = this.menuRows(height, width, busy)
    const allComposer = this.composerRows(width, snap, busy, now)
    const contentBudget = Math.max(1, height - 3)
    let menu = allMenu
    let composerH = Math.min(MAX_INPUT_ROWS, Math.max(1, allComposer.length))
    if (menu.length + composerH > contentBudget) {
      menu = menu.slice(0, Math.max(0, contentBudget - 1))
      composerH = Math.max(1, contentBudget - menu.length)
    }
    // v7.29: card prompt DIHAPUS — prompt kini menjadi history biasa di
    // transkrip (lihat `projectRows`). Biarkan cardRows kosong; semua turunan
    // `cardH` di bawah (viewH, cursorRow, composerTop) otomatis collapse ke 0,
    // sehingga tinggi frame & pemetaan mouse tetap konsisten.
    const cardRows: string[] = []
    const cardH = 0
    const viewH = Math.max(1, height - 2 - composerH - menu.length - cardH)
    // v7.28: dengan anchor atas, baris baru ditambahkan DI BAWAH sehingga
    // tidak menggeser baris yang sedang terlihat — tidak perlu koreksi drift.
    const viewport = this.transcript.viewport(width, viewH, this.scrollBack)
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

    const pf = promptFirst()
    let shownComposer: string[]
    let cursorRow: number
    let cursorCol = 1
    let composerOffset = 0
    if (this.composerLive(busy)) {
      const cursor = this.composerLayout(width)
      const winStart = Math.max(0, Math.min(allComposer.length - composerH, cursor.visIdx))
      composerOffset = winStart
      shownComposer = allComposer.slice(winStart, winStart + composerH)
      cursorRow = viewH + cardH + menu.length + (cursor.visIdx - winStart) + 1
      cursorCol = cursor.col
    } else {
      shownComposer = allComposer.slice(0, composerH)
      cursorRow = viewH + cardH + menu.length + 1
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
        width,
      )[0] ?? ""
    const frame = [
      ...body,
      ...cardRows,
      ...menu,
      ...shownComposer,
      "",
      indicatorLine ? truncateToWidth(indicatorLine, width) : footer,
    ]
    const rawLength = frame.length
    const crop = Math.max(0, rawLength - height)
    const topPad = Math.max(0, height - rawLength)
    while (frame.length < height) frame.unshift("")
    const out = frame.slice(-height)
    return {
      frame: out,
      cursor: {
        row: Math.max(1, Math.min(height, cursorRow + topPad - crop)),
        col: Math.max(1, cursorCol),
      },
      cols: Math.max(10, width),
      transcriptRows: bodyRows,
      transcriptTop: topPad - crop,
      composerTop: topPad - crop + body.length + cardH + menu.length,
      composerLines: allComposer,
      composerOffset,
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
      const frame = [c.warning(truncateToWidth(t("tui.tooSmall"), w))]
      while (frame.length < Math.max(1, rows)) frame.push("")
      screen.paint(frame.slice(0, Math.max(1, rows)))
      this.frames++
      return
    }
    const layout = this.buildLayout(rows, cols, this.host.getStatus())
    this.lastLayout = layout
    screen.paint(layout.frame, layout.cursor)
    this.frames++
  }
}
