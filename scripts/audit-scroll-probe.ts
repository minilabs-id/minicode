// audit/scroll probe — TEMPORARY measurement script (dihapus setelah audit)
//
// Mengukur: biaya satu frame (a) ketikan, (b) wheel scroll (coalesced 16 ms),
// (c) PgDn, (d) Home/End — pada ukuran history 0..5000 baris, plus atribusi
// waktu per fungsi (buildLayout / transcript.viewport / wrappedLength / total /
// composer). Jalankan: bun run scripts/audit-scroll-probe.ts

import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "../test/helpers/tui-harness.ts"

const COLS = Number(
  process.env.PROBE_COLS ??
    (process.argv[2]?.startsWith("--cols=") ? process.argv[2].split("=")[1] : 120),
)
const ROWS = Number(process.env.PROBE_ROWS ?? 40)
const MODEL = "deepseek-v4.1-flash-free"

// ── atribusi ────────────────────────────────────────────────────────────────
const acc = new Map<string, { ns: number; calls: number }>()
const widthLog = new Map<string, number>()
function add(name: string, ns: number): void {
  const cur = acc.get(name) ?? { ns: 0, calls: 0 }
  cur.ns += ns
  cur.calls++
  acc.set(name, cur)
}
function wrapProto(target: object, names: string[]): void {
  for (const name of names) {
    const holder = target as Record<string, unknown>
    const orig = holder[name]
    if (typeof orig !== "function") continue
    holder[name] = function patched(this: unknown, ...args: unknown[]) {
      const widthKey = `${name}@w=${String(args[0])}`
      widthLog.set(widthKey, (widthLog.get(widthKey) ?? 0) + 1)
      const t0 = Bun.nanoseconds()
      try {
        return (orig as (...a: unknown[]) => unknown).apply(this, args)
      } finally {
        add(name, Bun.nanoseconds() - t0)
      }
    }
  }
}
wrapProto(Transcript.prototype, [
  "viewport",
  "wrappedLength",
  "total",
  "committedRows",
  "pendingRows",
])
wrapProto(TuiApp.prototype, [
  "buildLayout",
  "paint",
  "composerRows",
  "composerLayout",
  "menuRows",
  "viewportHeight",
])

// ── fake TTY ────────────────────────────────────────────────────────────────
interface BenchTty {
  press(data: string): void
  listenerCount(): number
  frames(): number
  bytes(): number
  onWrite(fn: () => void): void
  restore(): void
}

function installBenchTty(columns: number, rows: number): BenchTty {
  const listeners = new Set<(chunk: Buffer) => void>()
  const resizeListeners = new Set<() => void>()
  const writeHooks = new Set<() => void>()
  let frames = 0
  let bytes = 0
  const origStdin = process.stdin
  const origWrite = process.stdout.write
  const origOn = process.stdout.on
  const origOff = process.stdout.off
  const origRemove = process.stdout.removeListener
  const origCols = process.stdout.columns
  const origRows = process.stdout.rows
  const origIsTTY = process.stdout.isTTY
  const origErrIsTTY = process.stderr.isTTY
  const origErrWrite = process.stderr.write

  const fakeStdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(v: boolean) {
      fakeStdin.isRaw = v
      return fakeStdin
    },
    resume: () => fakeStdin,
    pause: () => fakeStdin,
    on(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") listeners.add(fn)
      return fakeStdin
    },
    addListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.on(event, fn)
    },
    once(event: string, fn: (chunk: Buffer) => void) {
      const w = (chunk: Buffer) => {
        listeners.delete(w)
        fn(chunk)
      }
      return fakeStdin.on(event, w)
    },
    off(event: string, fn: (chunk: Buffer) => void) {
      if (event === "data") listeners.delete(fn)
      return fakeStdin
    },
    removeListener(event: string, fn: (chunk: Buffer) => void) {
      return fakeStdin.off(event, fn)
    },
    removeAllListeners() {
      listeners.clear()
      return fakeStdin
    },
    listenerCount: () => 0,
    setMaxListeners: () => fakeStdin,
    getMaxListeners: () => 10,
    setEncoding: () => fakeStdin,
  }

  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true })
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true })
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
  ;(process.stdout as unknown as { write: (c: string | Uint8Array) => boolean }).write = (
    chunk,
  ) => {
    frames++
    bytes += typeof chunk === "string" ? chunk.length : (chunk as Uint8Array).byteLength
    for (const fn of [...writeHooks]) fn()
    return true
  }
  ;(process.stderr as unknown as { write: () => boolean }).write = () => true
  ;(process.stdout as unknown as { on: (e: string, f: () => void) => void }).on = (event, fn) => {
    if (event === "resize") resizeListeners.add(fn)
  }
  ;(process.stdout as unknown as { off: (e: string, f: () => void) => void }).off = (event, fn) => {
    if (event === "resize") resizeListeners.delete(fn)
  }
  ;(
    process.stdout as unknown as { removeListener: (e: string, f: () => void) => void }
  ).removeListener = (event, fn) => {
    if (event === "resize") resizeListeners.delete(fn)
  }
  process.env.TERM = "xterm-256color"
  process.env.COLORTERM = "truecolor"
  delete process.env.NO_COLOR

  return {
    press(data) {
      const buf = Buffer.from(data, "utf8")
      for (const fn of [...listeners]) fn(buf)
    },
    listenerCount: () => listeners.size,
    frames: () => frames,
    bytes: () => bytes,
    onWrite: (fn) => writeHooks.add(fn),
    restore() {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true })
      Object.defineProperty(process.stdout, "columns", { value: origCols, configurable: true })
      Object.defineProperty(process.stdout, "rows", { value: origRows, configurable: true })
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true })
      Object.defineProperty(process.stderr, "isTTY", { value: origErrIsTTY, configurable: true })
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
      ;(process.stdout as unknown as { on: typeof origOn }).on = origOn
      ;(process.stdout as unknown as { off: typeof origOff }).off = origOff
      ;(process.stdout as unknown as { removeListener: typeof origRemove }).removeListener =
        origRemove
      ;(process.stderr as unknown as { write: typeof origErrWrite }).write = origErrWrite
      writeHooks.clear()
      listeners.clear()
      resizeListeners.clear()
    },
  }
}

// ── host ────────────────────────────────────────────────────────────────────
function makeHost(): TuiHost {
  return {
    bus: createFakeBus() as never,
    getStatus: (): TuiStatusSnapshot => ({
      footer: {
        mode: "auto",
        strictBash: true,
        workMode: "EXECUTE",
        model: MODEL,
        cwd: "D:\\Github\\minicode",
        context: "42.1k",
        metrics: "$1.23 32%",
      },
      busy: false,
    }),
    listCommands: (prefix) => ["/model", "/help", "/exit"].filter((c) => c.startsWith(prefix)),
    submit: async () => {},
    copySelection: () => true,
    abort: () => {},
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
}

async function waitForBoot(tty: BenchTty, done: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (tty.listenerCount() > 0 && tty.frames() > 0) return
    if (done()) throw new Error("app berhenti sebelum frame pertama")
    await Bun.sleep(1)
  }
  throw new Error("app tidak boot")
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i] ?? 0
}
const r3 = (n: number) => Math.round(n * 1000) / 1000

interface Row {
  scenario: string
  lines: number
  p50: number
  p95: number
  max: number
  bytes: number
}

async function scenario(lines: number, keys: number): Promise<Row[]> {
  const tty = installBenchTty(COLS, ROWS)
  const out: Row[] = []
  acc.clear()
  try {
    const host = makeHost()
    const transcript = new Transcript(host.bus as never)
    for (let i = 0; i < lines; i++) {
      transcript.push(`tool ${i} completed target/file-${i}.ts`, {
        kind: i % 3 === 0 ? "assistant" : "system",
      })
    }
    const app = new TuiApp(transcript, host)
    let done = false
    const run = app.run().finally(() => {
      done = true
    })
    await waitForBoot(tty, () => done)

    // ukur: dari press sampai frame berikutnya tertulis
    const measurePress = async (data: string, settleMs: number): Promise<[number, number]> => {
      const before = tty.frames()
      const b0 = tty.bytes()
      const t0 = performance.now()
      let tWrite = 0
      tty.onWrite(() => {
        if (!tWrite) tWrite = performance.now() - t0
      })
      tty.press(data)
      // wheel di-coalesce 16 ms; tunggu frame muncul
      const deadline = performance.now() + 4000
      while (tty.frames() === before && performance.now() < deadline) await Bun.sleep(settleMs)
      return [tWrite || performance.now() - t0, tty.bytes() - b0]
    }

    // warmup
    for (let i = 0; i < 6; i++) tty.press("a")
    for (let i = 0; i < 6; i++) await measurePress("\x1b[<64;10;10M", 1)

    const typed: number[] = []
    const wheel: number[] = []
    const pgdn: number[] = []
    let wheelBytes = 0
    let typeBytes = 0
    for (let i = 0; i < keys; i++) {
      const [t1, b1] = await measurePress("a", 0)
      typed.push(t1)
      typeBytes = b1
      const [t2, b2] = await measurePress("\x1b[<64;10;10M", 1)
      wheel.push(t2)
      wheelBytes = b2
      const [t3] = await measurePress("\x1b[5~", 0) // PgUp
      pgdn.push(t3)
    }
    const mk = (name: string, samples: number[]): Row => {
      const s = [...samples].sort((a, b) => a - b)
      return {
        scenario: name,
        lines,
        p50: r3(pct(s, 50)),
        p95: r3(pct(s, 95)),
        max: r3(pct(s, 95)),
        bytes: 0,
      }
    }
    out.push({ ...mk("ketik 1 char", typed), bytes: typeBytes })
    out.push({ ...mk("wheel -3 baris", wheel), bytes: wheelBytes })
    out.push(mk("PgUp 1 halaman", pgdn))

    // Biaya APPEND: satu baris baru masuk lalu repaint (jalur turn/streaming).
    const append: number[] = []
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now()
      transcript.push(`tool appended-${i} completed target/file-${i}.ts`, { kind: "system" })
      app.repaint()
      append.push(performance.now() - t0)
    }
    out.push(mk("append 1 baris + paint", append))

    tty.press("\x15")
    tty.press("\x04")
    await Promise.race([run, Bun.sleep(4000)])
    perScenario.set(lines, new Map(acc))
  } finally {
    tty.restore()
  }
  return out
}

const perScenario = new Map<number, Map<string, { ns: number; calls: number }>>()
const sizes = [0, 500, 2000, 5000]
const rows: Row[] = []
for (const n of sizes) rows.push(...(await scenario(n, 12)))

console.log("\n== latensi per frame (press → frame tertulis, ms) ==")
console.log(
  "skenario".padEnd(22) +
    "baris".padStart(7) +
    "p50".padStart(10) +
    "p95".padStart(10) +
    "bytes/frame".padStart(14),
)
for (const r of rows) {
  console.log(
    r.scenario.padEnd(22) +
      String(r.lines).padStart(7) +
      r.p50.toFixed(2).padStart(10) +
      r.p95.toFixed(2).padStart(10) +
      String(r.bytes).padStart(14),
  )
}

console.log("\n== atribusi CPU kumulatif (ms, total semua skenario) ==")
const sortedAcc = [...acc.entries()].sort((a, b) => b[1].ns - a[1].ns)
for (const [name, v] of sortedAcc) {
  console.log(
    name.padEnd(24) +
      (v.ns / 1e6).toFixed(1).padStart(10) +
      "ms" +
      String(v.calls).padStart(8) +
      " calls",
  )
}

console.log(`\n== atribusi per skenario (cols=${COLS} rows=${ROWS}) ==`)
for (const [n, m] of perScenario) {
  const top = [...m.entries()]
    .sort((a, b) => b[1].ns - a[1].ns)
    .slice(0, 4)
    .map(
      ([k, v]) =>
        `${k} ${(v.ns / 1e6).toFixed(0)}ms/${v.calls}x = ${(v.ns / 1e6 / Math.max(1, v.calls)).toFixed(1)}ms`,
    )
  console.log(`baris=${n}: ${top.join("   ")}`)
}

console.log("\n== lebar yang diminta (jumlah panggilan) ==")
for (const [k, v] of [...widthLog.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k} ×${v}`)
}

// ── dampak KEbenaran posisi gulir: berapa baris terbungkus pada dua lebar ──
{
  const t = new Transcript(createFakeBus() as never)
  for (let i = 0; i < 5000; i++) {
    t.push(
      `tool ${i} completed target/file-${i}.ts with a fairly long description to force wrapping`,
      { kind: i % 3 === 0 ? "assistant" : "system" },
    )
  }
  const wFull = t.wrappedLength(120)
  const wChat = t.wrappedLength(81)
  const viewH = 33
  console.log("\n== kebenaran batas gulir (5000 baris, kolom chat v0.34) ==")
  console.log(`wrappedLength(120 = lebar terminal) = ${wFull}`)
  console.log(`wrappedLength(81  = lebar kolom chat) = ${wChat}`)
  console.log(`maxBack dari angka terminal = ${Math.max(0, wFull - viewH)}`)
  console.log(`maxBack yang benar          = ${Math.max(0, wChat - viewH)}`)
  console.log(`selisih tak bisa dicapai    = ${Math.abs(wChat - wFull)} baris`)
}
