import { resolve } from "node:path"
import { abortError } from "#minicore/core/errors.ts"
import { runCall } from "#minicore/core/executor.ts"
import type { ExecutorDeps, ToolExecutor } from "#minicore/core/index.ts"
import type { ToolCall, ToolResult } from "#minicore/core/types.ts"
import { LIMITS } from "../constants.ts"
// [Fase 2 / TOOL-01] Klasifikasi konkurensi diturunkan dari SATU registry
// kontrak tool — dulu dua Set manual di file ini yang bisa menyimpang.
import { contractForTool, EXCLUSIVE_TOOLS, WRITE_TOOLS } from "./tool-contract.ts"

function isWrite(call: ToolCall): boolean {
  return WRITE_TOOLS.has(call.name) || EXCLUSIVE_TOOLS.has(call.name)
}

// Kunci file-lock: hanya WRITE_TOOLS dengan args.path string valid.
// EXCLUSIVE_TOOLS (tanpa path) dan move_file (memakai path+destination) sengaja
// tidak punya kunci — inilah yang membuat writeConcurrency > 1 tidak aman untuk
// mereka (F-01). Klasifikasi batch memakai fungsi ini; jangan diganti dengan
// cek `isWrite` saja.
function getLockPath(call: ToolCall, cwd: string | undefined): string | null {
  if (!WRITE_TOOLS.has(call.name)) return null
  // v7.38: wire move_file kini punya `path`, tetapi mengunci HANYA ujung sumber
  // memberi ilusi aman (race terjadi di `destination`). Karena itu tetap
  // dibiarkan tanpa kunci → batch terserialisasi penuh, identik dengan perilaku
  // sebelum rename `from`/`to` (kontrak F-01 tidak berubah).
  if (call.name === "move_file") return null
  const p = (call.args as Record<string, unknown>)?.path
  if (typeof p !== "string" || !p) return null
  // normalisasi: resolve abs + lowerCase di Windows agar ./a.ts vs a.ts tidak miss lock
  try {
    const base = cwd ?? process.cwd()
    const abs = resolve(base, p)
    return process.platform === "win32" ? abs.toLowerCase() : abs
  } catch {
    return process.platform === "win32" ? p.toLowerCase() : p
  }
}

// Antrean abort-aware: saat signal abort, entry dibuang dari antrean dan
// promise langsung reject — worker tidak menunggu tool in-flight selesai.
interface Waiter {
  resolve(): void
  reject(reason: unknown): void
  onAbort?: () => void
}

function detach(w: Waiter, signal: AbortSignal | undefined): void {
  if (w.onAbort && signal) signal.removeEventListener("abort", w.onAbort)
  w.onAbort = undefined
}

function makeWaiter(
  signal: AbortSignal,
  removeFromQueue: (w: Waiter) => void,
): { promise: Promise<void>; waiter: Waiter } {
  let settle!: () => void
  let rejectFn!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    settle = res
    rejectFn = rej
  })
  const waiter: Waiter = {
    resolve: () => {
      detach(waiter, signal)
      settle()
    },
    reject: (reason) => {
      detach(waiter, signal)
      rejectFn(reason)
    },
  }
  waiter.onAbort = () => {
    removeFromQueue(waiter)
    waiter.reject(abortError(signal))
  }
  if (signal.aborted) waiter.onAbort()
  else signal.addEventListener("abort", waiter.onAbort, { once: true })
  return { promise, waiter }
}

export function parallelExecutor(
  opts: {
    concurrency?: number
    writeConcurrency?: number
    maxToolsPerBatch?: number
    getAuthorizationVersion?: () => number
  } = {},
): ToolExecutor {
  const concurrency = opts.concurrency ?? LIMITS.EXECUTOR_CONCURRENCY
  const writeConcurrency = opts.writeConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY
  // [Fase 8 / 8.3] Batas tool per batch. Bila disetel (>0), batch yang
  // melebihi batas dipangkas: tool yang melampaui batas TIDAK dieksekusi dan
  // diganti hasil tool-error dengan pesan `[batch limit reached: maxToolsPerBatch=...]`.
  // Mencegah eksekusi berlebih dalam satu batch (Live Test: model mengirim
  // puluhan tool call sekaligus yang membakar budget tanpa hasil berguna).
  const maxToolsPerBatch = opts.maxToolsPerBatch ?? 0

  // Wrap only the per-call registry lookup; keep the live session tool array intact.
  function invoke(call: ToolCall, deps: ExecutorDeps) {
    const version = opts.getAuthorizationVersion?.()
    return runCall(call, {
      ...deps,
      registry: {
        list: () => deps.registry.list(),
        get: (name) => {
          const tool = deps.registry.get(name)
          if (!tool) return undefined
          return {
            ...tool,
            execute(args, ctx) {
              ctx.signal.throwIfAborted()
              if (version !== opts.getAuthorizationVersion?.()) {
                throw new Error(
                  "authorization changed before tool execution; request fresh approval",
                )
              }
              return tool.execute(args, ctx)
            },
          }
        },
      },
    })
  }

  async function runBatch(
    calls: readonly ToolCall[],
    rawDeps: ExecutorDeps,
  ): Promise<readonly ToolResult[]> {
    if (calls.length === 0) return []
    // P0.2 (G1 / Invariant #7): `createToolRegistry` vendor membekukan Map pada
    // saat sesi dibuat sementara `list()` membaca array `visible` yang dimutasi
    // in-place oleh `setWorkMode` / `setPermissionMode`. Resolusi live dari
    // `list()` memastikan `callable === visible` di kedua arah transisi
    // (DISCUSS→EXECUTE membuka tool tulis; EXECUTE→DISCUSS menutupnya).
    const liveRegistry =
      typeof rawDeps.registry.list === "function"
        ? {
            list: () => rawDeps.registry.list(),
            get: (name: string) => rawDeps.registry.list().find((t) => t.name === name),
          }
        : rawDeps.registry
    const getLiveWorkMode = (rawDeps.permissions as { __getWorkMode?: () => string } | undefined)
      ?.__getWorkMode
    const liveWorkMode =
      typeof getLiveWorkMode === "function" ? getLiveWorkMode.call(rawDeps.permissions) : "EXECUTE"
    // INV-WM1: `unrestricted` hanya berlaku di WorkMode EXECUTE; saat DISCUSS
    // aktif, klaim `unrestricted` diturunkan ke `auto` di ToolContext agar
    // `contextUnrestricted(ctx)` pada tool baca tidak melewati jail workspace.
    const effectivePm =
      rawDeps.permissionMode === "unrestricted" && liveWorkMode !== "EXECUTE"
        ? "auto"
        : rawDeps.permissionMode
    const baseDeps: ExecutorDeps = {
      ...rawDeps,
      registry: liveRegistry,
      ...(effectivePm !== undefined ? { permissionMode: effectivePm } : {}),
    }
    // P0.2 (G-MEM-TRACK / Invariant #2 & #3): saat WorkMode DISCUSS,
    // `read_memory` menerima `permissionMode: "readonly"` per-sesi agar tidak
    // menaikkan `access_count` di SQLite walau PermissionMode dasar `auto`.
    const depsFor = (call: ToolCall): ExecutorDeps => {
      if (call.name === "read_memory") {
        if (liveWorkMode === "DISCUSS") {
          return { ...baseDeps, permissionMode: "readonly" }
        }
        const listed = typeof rawDeps.registry.list === "function" ? rawDeps.registry.list() : []
        if (
          listed.length > 0 &&
          listed.every((t) => contractForTool(t.name)?.sideEffectTier === "PURE_READ")
        ) {
          return { ...baseDeps, permissionMode: "readonly" }
        }
      }
      return baseDeps
    }
    const deps = baseDeps
    const results: (ToolResult | undefined)[] = new Array(calls.length)

    // write+baca campur → sekuensial urut input: read setelah write pada file
    // sama harus melihat konten baru (paralel akan balapan). Perilaku P4 yang
    // dibekukan.
    const anyWrite = calls.some(isWrite)
    const anyRead = calls.some((c) => !isWrite(c))
    if (anyWrite && anyRead) {
      for (let i = 0; i < calls.length; i++) {
        if (deps.signal.aborted) throw abortError(deps.signal)
        const c = calls[i]!
        results[i] = await invoke(c, depsFor(c))
      }
      return results as ToolResult[]
    }

    // F-01 (P5 §C1): slot tulis (writeConcurrency > 1) hanya didemonstrasikan
    // aman untuk write tool ber-kunci args.path. Batch yang mengandung write
    // tanpa kunci — EXCLUSIVE_TOOLS (bash dsb.), move_file (path/destination), atau
    // WRITE_TOOL tanpa path valid — dijalankan sekuensial penuh. Ini menutup
    // overlap dua bash, bash vs write path, dan dua move_file yang dulu lolos
    // pada wc > 1 tanpa bukti keselamatan; batch murni write ber-path tetap
    // memakai semaphore + file-lock di bawah. Race terhadap signal
    // mempertahankan penolakan prompt saat abort (setara antrean writeWaiter):
    // tool in-flight boleh mengabaikan signal, tetapi execute() reject begitu
    // abort datang, tanpa menunggu tool selesai.
    const anyUnkeyedWrite = calls.some((c) => isWrite(c) && getLockPath(c, deps.cwd) === null)
    if (anyWrite && anyUnkeyedWrite) {
      for (let i = 0; i < calls.length; i++) {
        if (deps.signal.aborted) throw abortError(deps.signal)
        const call = calls[i]!
        results[i] = await invoke(call, depsFor(call))
      }
      return results as ToolResult[]
    }

    let cursor = 0
    let activeWrites = 0
    // per-file lock to prevent same-file write race (e.g. two edits to same path)
    const fileLocks = new Map<string, number>()
    const fileWaiters = new Map<string, Waiter[]>()
    const writeWaiters: Waiter[] = []
    const signal = deps.signal

    function acquireWrite(): Promise<void> {
      if (signal.aborted) return Promise.reject(abortError(signal))
      if (activeWrites < writeConcurrency) {
        activeWrites++
        return Promise.resolve()
      }
      const { promise, waiter } = makeWaiter(signal, (w) => {
        const i = writeWaiters.indexOf(w)
        if (i !== -1) writeWaiters.splice(i, 1)
      })
      writeWaiters.push(waiter)
      return promise
    }
    function releaseWrite(): void {
      const next = writeWaiters.shift()
      if (next) {
        // ownership berpindah — counter tetap (setara decrement+increment lama)
        next.resolve()
      } else {
        activeWrites--
      }
    }

    function acquireFileLock(path: string | null): Promise<void> {
      if (!path) return Promise.resolve()
      if (signal.aborted) return Promise.reject(abortError(signal))
      if ((fileLocks.get(path) ?? 0) === 0) {
        fileLocks.set(path, 1)
        return Promise.resolve()
      }
      const { promise, waiter } = makeWaiter(signal, (w) => {
        const q = fileWaiters.get(path)
        if (!q) return
        const i = q.indexOf(w)
        if (i !== -1) q.splice(i, 1)
        if (q.length === 0) fileWaiters.delete(path)
      })
      const q = fileWaiters.get(path) ?? []
      q.push(waiter)
      fileWaiters.set(path, q)
      return promise
    }
    function releaseFileLock(path: string | null): void {
      if (!path) return
      const q = fileWaiters.get(path)
      const next = q?.shift()
      if (next) {
        if (q && q.length === 0) fileWaiters.delete(path)
        next.resolve() // ownership berpindah ke waiter berikutnya
      } else {
        fileLocks.delete(path)
      }
    }

    const workers = Array(Math.min(concurrency, calls.length))
      .fill(0)
      .map(async () => {
        while (true) {
          if (deps.signal.aborted) throw abortError(deps.signal)
          const idx = cursor++
          if (idx >= calls.length) break
          const call = calls[idx]!
          const needWrite = isWrite(call)
          const filePath = needWrite ? getLockPath(call, deps.cwd) : null
          let held = false
          try {
            if (needWrite) {
              await acquireWrite() // nothing held yet — safe to throw
              try {
                await acquireFileLock(filePath)
                held = true
              } catch (e) {
                releaseWrite()
                throw e
              }
            }
            const res = await invoke(call, depsFor(call))
            results[idx] = res
          } finally {
            if (held) {
              releaseFileLock(filePath)
              releaseWrite()
            }
          }
        }
      })
    // Drain every worker before releasing the batch exclusion, including when
    // queued workers abort while another tool is still ignoring cancellation.
    const outcomes = await Promise.allSettled(workers)
    const failed = outcomes.find((outcome) => outcome.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    return results as ToolResult[]
  }

  // A cancelled caller may return while an extension ignores its signal.
  // Keep subsequent batches behind actual completion, retaining all locks.
  let drained: Promise<void> = Promise.resolve()
  async function dispatch(calls: readonly ToolCall[], deps: ExecutorDeps) {
    if (deps.signal.aborted) throw abortError(deps.signal)
    const running = drained.then(() => runBatch(calls, deps))
    drained = running.then(
      () => {},
      () => {},
    )
    let onAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(deps.signal))
      deps.signal.addEventListener("abort", onAbort, { once: true })
      if (deps.signal.aborted) onAbort()
    })
    try {
      return await Promise.race([running, cancelled])
    } finally {
      deps.signal.removeEventListener("abort", onAbort)
    }
  }

  return {
    async execute(calls: readonly ToolCall[], deps: ExecutorDeps): Promise<readonly ToolResult[]> {
      if (calls.length === 0) return []
      // [Fase 8 / 8.3] Pangkas batch bila maxToolsPerBatch aktif.
      if (maxToolsPerBatch > 0 && calls.length > maxToolsPerBatch) {
        const kept = calls.slice(0, maxToolsPerBatch)
        const results: (ToolResult | undefined)[] = new Array(calls.length)
        const trimmed = await dispatch(kept, deps)
        for (let i = 0; i < trimmed.length; i++) results[i] = trimmed[i]
        for (let i = maxToolsPerBatch; i < calls.length; i++) {
          results[i] = {
            role: "tool",
            toolCallId: calls[i]!.id,
            name: calls[i]!.name,
            content: `[batch limit reached: maxToolsPerBatch=${maxToolsPerBatch}]`,
            isError: true,
          }
        }
        return results as ToolResult[]
      }
      return dispatch(calls, deps)
    },
  }
}
