// Watchdog aktivitas & deteksi sleep/wake OS berbasis waktu monotonik.
//
// KENAPA tidak sekadar `setTimeout(wallMs)` atau selisih `Date.now()`:
//  1. Agen otonom multi-jam/hari hanya boleh dihentikan ketika BENAR-BENAR diam
//     (inaktivitas / macet), bukan karena jam dinding melewati batas tetap
//     saat model/tool/skrip masih produktif mengirim langkah atau output.
//  2. Laptop sleep/hibernasi atau koreksi NTP membuat `Date.now()` melompat
//     sementara `performance.now()` tidak memajukan waktu kerja nyata; tanpa
//     kompensasi wake-up, proses sehat langsung dituduh "stalled" saat bangun.

import { AgentError } from "#minicore/core/errors.ts"
import { LIMITS } from "../constants.ts"

/** Ambang deviasi wall-vs-monotonic untuk mengenali komputer baru bangun sleep/hibernasi. */
export const WAKE_JUMP_THRESHOLD_MS = 15_000

export interface ActivityDeadlineOptions {
  /** Batas diam (ms) tanpa `touch()` sebelum abort. `0` atau `Infinity` = nonaktif. */
  inactivityTimeoutMs?: number
  /** Batas atas wall-clock opsional (ms) dari awal run. `0` / `Infinity` / `undefined` = tak dibatasi. */
  maxWallClockMs?: number
  /** Alasan error ketika inaktivitas habis. */
  buildInactivityError?: (inactivityMs: number) => Error
  /** Alasan error ketika wall-clock opsional habis. */
  buildWallClockError?: (wallMs: number) => Error
  /** Callback saat terdeteksi sleep/wake jump — memberi kesempatan renew lease. */
  onWakeFromSleep?: (info: { wallJumpMs: number; monoElapsedMs: number }) => void
}

export interface ActivityDeadline {
  readonly signal: AbortSignal
  /** Tandai aktivitas nyata (delta model, step, output tool, heartbeat). */
  touch(source?: string): void
  /** Hentikan sementara hitung diam saat menunggu sleep outage/cooldown terencana. */
  suspendInactivity(): void
  /** Lanjutkan hitung diam setelah cooldown selesai (timer di-reset bersih). */
  resumeInactivity(): void
  cancel(): void
  readonly idleElapsedMs: () => number
  readonly wallElapsedMs: () => number
}

function normalizeFiniteLimit(ms: number | undefined): number | null {
  if (ms === undefined || ms === 0 || ms === Number.POSITIVE_INFINITY) return null
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.max(1, Math.floor(ms))
}

/**
 * Pasang timer aman untuk durasi > `LIMITS.MAX_TIMER_DELAY_MS` (~24,85 hari)
 * tanpa terkena clamp 1ms V8/Bun `setTimeout`.
 */
export function setSafeTimeout(fn: () => void, delayMs: number, unrefTimer = true): () => void {
  let cancelled = false
  let handle: ReturnType<typeof setTimeout> | undefined
  let remaining = Math.max(0, Math.floor(delayMs))

  const scheduleNext = () => {
    if (cancelled) return
    const chunk = Math.min(remaining, LIMITS.MAX_TIMER_DELAY_MS)
    remaining -= chunk
    handle = setTimeout(() => {
      if (cancelled) return
      if (remaining > 0) {
        scheduleNext()
        return
      }
      fn()
    }, chunk)
    handle.unref?.()
  }

  if (unrefTimer) scheduleNext()
  else {
    const chunk = Math.min(remaining, LIMITS.MAX_TIMER_DELAY_MS)
    remaining -= chunk
    handle = setTimeout(() => {
      if (cancelled) return
      if (remaining > 0) scheduleNext()
      else fn()
    }, chunk)
  }

  return () => {
    cancelled = true
    if (handle !== undefined) clearTimeout(handle)
  }
}

export function createActivityDeadline(opts: ActivityDeadlineOptions): ActivityDeadline {
  const idleLimitMs = normalizeFiniteLimit(opts.inactivityTimeoutMs)
  const wallLimitMs = normalizeFiniteLimit(opts.maxWallClockMs)
  const controller = new AbortController()

  const startMono = performance.now()
  const startWall = Date.now()
  let lastTouchMono = startMono
  let lastTouchWall = startWall
  let suspended = false
  let cancelled = false
  let clearIdleTimer: (() => void) | null = null
  let clearWallTimer: (() => void) | null = null

  const cleanupTimers = () => {
    clearIdleTimer?.()
    clearIdleTimer = null
    clearWallTimer?.()
    clearWallTimer = null
  }

  const abortWith = (err: Error) => {
    if (cancelled || controller.signal.aborted) return
    cancelled = true
    cleanupTimers()
    controller.abort(err)
  }

  const checkSleepWakeAndTouch = (): boolean => {
    const nowMono = performance.now()
    const nowWall = Date.now()
    const monoDelta = Math.max(0, nowMono - lastTouchMono)
    const wallDelta = Math.max(0, nowWall - lastTouchWall)
    // Jika waktu kalender melonjak jauh melebihi waktu proses monotonic, sistem
    // baru bangun dari sleep/hibernate. Jangan langsung membunuh — beri jendela segar.
    if (wallDelta - monoDelta > WAKE_JUMP_THRESHOLD_MS) {
      lastTouchMono = nowMono
      lastTouchWall = nowWall
      try {
        opts.onWakeFromSleep?.({ wallJumpMs: wallDelta, monoElapsedMs: monoDelta })
      } catch {}
      return true
    }
    return false
  }

  const armIdle = () => {
    clearIdleTimer?.()
    clearIdleTimer = null
    if (cancelled || suspended || idleLimitMs === null) return
    clearIdleTimer = setSafeTimeout(() => {
      if (cancelled || suspended || controller.signal.aborted) return
      if (checkSleepWakeAndTouch()) {
        armIdle()
        return
      }
      const err =
        opts.buildInactivityError?.(idleLimitMs) ??
        new AgentError("timeout", `run exceeded inactivity timeout (${idleLimitMs}ms)`)
      abortWith(err)
    }, idleLimitMs)
  }

  if (wallLimitMs !== null) {
    clearWallTimer = setSafeTimeout(() => {
      if (cancelled || controller.signal.aborted) return
      const err =
        opts.buildWallClockError?.(wallLimitMs) ??
        new AgentError("timeout", `run exceeded wall-clock timeout (${wallLimitMs}ms)`)
      abortWith(err)
    }, wallLimitMs)
  }

  armIdle()

  return {
    signal: controller.signal,
    touch() {
      if (cancelled || controller.signal.aborted) return
      lastTouchMono = performance.now()
      lastTouchWall = Date.now()
      armIdle()
    },
    suspendInactivity() {
      if (cancelled || suspended) return
      suspended = true
      clearIdleTimer?.()
      clearIdleTimer = null
    },
    resumeInactivity() {
      if (cancelled || !suspended) return
      suspended = false
      lastTouchMono = performance.now()
      lastTouchWall = Date.now()
      armIdle()
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      cleanupTimers()
    },
    idleElapsedMs: () => Math.max(0, performance.now() - lastTouchMono),
    wallElapsedMs: () => Math.max(0, Date.now() - startWall),
  }
}
