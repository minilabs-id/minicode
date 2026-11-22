// Instrumentasi performa ringan (audit F-02/F-03/F-04). Ukur dulu, optimasi
// kemudian. MURNI: tanpa IO/writer/timer otomatis; stderr hanya dari
// `perfReport()` yang dipanggil eksplisit. Aktif bila `MINICODE_DEBUG_PERF=1`,
// dibaca sekali saat import agar `perfCount()` nonaktif jadi no-op O(1).

const ENABLED = process.env.MINICODE_DEBUG_PERF === "1"

/** Apakah instrumentasi aktif? Dipakai pemanggil untuk menghindari `performance.now()`. */
export function perfEnabled(): boolean {
  return ENABLED
}

/** Batas sampel per nama — cukup untuk p50/p95 tanpa menahan riwayat panjang. */
const MAX_SAMPLES = 256

type PerfStat = {
  count: number
  totalMs: number
  maxMs: number
  lastN: number
  samples: number[]
  next: number
}

const stats = new Map<string, PerfStat>()

/** Catat sampel: `ms` durasi, `n` nilai sekunder (mis. ukuran batch). No-op saat nonaktif. */
export function perfCount(name: string, ms = 0, n = 0): void {
  if (!ENABLED) return
  let s = stats.get(name)
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, lastN: 0, samples: [], next: 0 }
    stats.set(name, s)
  }
  s.count++
  s.lastN = n
  if (ms > 0) {
    s.totalMs += ms
    if (ms > s.maxMs) s.maxMs = ms
    // Ring buffer: setelah penuh, timpa sampel terlama secara deterministik.
    if (s.samples.length < MAX_SAMPLES) s.samples.push(ms)
    else {
      s.samples[s.next] = ms
      s.next = (s.next + 1) % MAX_SAMPLES
    }
  }
}

export type PerfSnapshot = {
  count: number
  totalMs: number
  maxMs: number
  lastN: number
}

/** Ambil agregat mentah. Saat nonaktif selalu kosong. */
export function perfSnapshot(): Record<string, PerfSnapshot> {
  const out: Record<string, PerfSnapshot> = {}
  for (const [name, s] of stats) {
    out[name] = { count: s.count, totalMs: s.totalMs, maxMs: s.maxMs, lastN: s.lastN }
  }
  return out
}

/** Hapus seluruh sampel (dipakai test / reset manual). */
export function perfReset(): void {
  stats.clear()
}

// p50/p95 deterministik: elemen terurut pada indeks ceil(q*n)-1; kosong → 0.
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** Agregat count/p50/p95 per nama (urut stabil). stderr hanya saat aktif & eksplisit. */
export function perfReport(): string {
  const lines: string[] = []
  for (const name of [...stats.keys()].sort()) {
    const s = stats.get(name)!
    const sorted = [...s.samples].sort((a, b) => a - b)
    lines.push(
      `[perf] ${name} count=${s.count} total=${fmt(s.totalMs)}ms max=${fmt(s.maxMs)}ms ` +
        `p50=${fmt(percentile(sorted, 0.5))}ms p95=${fmt(percentile(sorted, 0.95))}ms ` +
        `lastN=${s.lastN}`,
    )
  }
  const out = lines.length ? lines.join("\n") : "[perf] no samples"
  if (ENABLED) process.stderr.write(`${out}\n`)
  return out
}
