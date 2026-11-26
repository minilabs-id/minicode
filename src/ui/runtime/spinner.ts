import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { cErr, glyphs } from "../render/theme.ts"
import { motionReduced } from "./motion.ts"
import { acquireTransientPaint, paintWrite } from "./statusline.ts"

// Jaga agar kursor terminal selalu ter-restore meski proses dihentikan
// (SIGINT/dll). Didaftarkan LAZY saat spinner benar-benar menyembunyikan
// kursor (pola loading-bar.ts) agar import modul tak menulis ESC[?25h saat exit.
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    try {
      if (process.stderr.isTTY) process.stderr.write("\x1b[?25h")
    } catch {}
  })
}

export interface Spinner {
  update: (message: string) => void
  stop: (finalMessage?: string) => void
  success: (message: string) => void
  error: (message: string) => void
}

export interface SpinnerOptions {
  /**
   * Tunda frame pertama (ms). Dipakai fase startup yang sering selesai <200ms
   * (cek update) — tanpa delay, spinner berkedip lalu hilang. 0 = langsung.
   */
  delayMs?: number
  /** Interval antar frame (default 120ms). */
  intervalMs?: number
}

export function createSpinner(initialMessage: string = "", opts: SpinnerOptions = {}): Spinner {
  const isTTY = process.stderr.isTTY
  const isDumb = (process.env.TERM ?? "").toLowerCase() === "dumb"
  const isWinLegacy =
    process.platform === "win32" &&
    !(
      process.env.WT_SESSION ||
      process.env.TERM_PROGRAM ||
      process.env.ANSICON ||
      process.env.ConEmuANSI
    )
  const canAnimate = isTTY && !isDumb && !isWinLegacy && !motionReduced()
  const intervalMs = opts.intervalMs ?? 120
  const delayMs = opts.delayMs ?? 0
  // Pesan spinner bisa datang dari hasil tool yang tidak terpercaya — SGR boleh
  // lewat, sekuens lain (mis. \x1b[2J) dibuang agar tidak merusak layar.
  let message = sanitizeAnsiLine(initialMessage)
  let frameIdx = 0
  let intervalId: ReturnType<typeof setInterval> | undefined
  let delayTimer: ReturnType<typeof setTimeout> | undefined
  // Kepemilikan transient stderr selama animasi — mutual exclusion dengan
  // garis status turn di-enforce statusline.ts (warning overlap, bukan crash).
  let owned: { release(): void } | null = null
  // Sudah pernah menulis frame? Determinan apakah stop() boleh menulis
  // pembersih `\r\x1b[K` — spinner yang belum sempat melukis (masih dalam
  // delay) tidak boleh menghapus baris milik penulis lain.
  let painted = false
  let stopped = false

  const frames = glyphs.spinnerFrames

  const tick = () => {
    const frame = cErr.info(frames[frameIdx % frames.length]!)
    frameIdx++
    painted = true
    paintWrite(`\r${frame} ${message}\x1b[K`)
  }

  // `withDelay` hanya untuk frame PERTAMA (delay gagal-berkedip fase startup);
  // frame lanjutan/delay kedua akan membuat spinner tak pernah muncul.
  const startPaint = (withDelay = false) => {
    if (!isTTY || stopped || intervalId || delayTimer) return
    if (isDumb || isWinLegacy) {
      if (!painted && message) {
        painted = true
        paintWrite(`${message}\n`)
      }
      return
    }
    if (withDelay && delayMs > 0) {
      delayTimer = setTimeout(() => {
        delayTimer = undefined
        startPaint()
      }, delayMs)
      // Jangan tahan process hidup hanya karena delay tampil.
      try {
        ;(delayTimer as unknown as { unref?: () => void }).unref?.()
      } catch {}
      return
    }
    // Hide cursor during spin
    installExitHook()
    paintWrite("\x1b[?25l")
    owned = acquireTransientPaint("spinner", tick, () => {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = undefined
      }
      owned = null
    })
    tick()
    if (!canAnimate) return
    intervalId = setInterval(tick, intervalMs)
    try {
      ;(intervalId as unknown as { unref?: () => void }).unref?.()
    } catch {}
  }

  const stopTimer = () => {
    if (delayTimer) {
      clearTimeout(delayTimer)
      delayTimer = undefined
    }
    if (owned) {
      owned.release()
      owned = null
    }
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }
    if (isTTY && painted && !isDumb && !isWinLegacy) {
      paintWrite("\r\x1b[K\x1b[?25h")
    }
    painted = false
  }

  startPaint(delayMs > 0)

  return {
    update(newMessage: string) {
      message = sanitizeAnsiLine(newMessage)
    },
    stop(finalMessage?: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      if (finalMessage) {
        process.stderr.write(`${sanitizeAnsiLine(finalMessage)}\n`)
      }
    },
    success(msg: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      process.stderr.write(`${cErr.green("ok")} ${sanitizeAnsiLine(msg)}\n`)
    },
    error(msg: string) {
      if (stopped) return
      stopped = true
      stopTimer()
      process.stderr.write(`${cErr.red("failed")} ${sanitizeAnsiLine(msg)}\n`)
    },
  }
}
