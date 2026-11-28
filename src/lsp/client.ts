import { Buffer } from "node:buffer"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, extname, isAbsolute, relative, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { LIMITS } from "../constants.ts"
import { sanitizeIncoming } from "../daemon/sanitize.ts"
import { resolveSpawnTarget, resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import type {
  ManagedChild,
  ManagedChildObservation,
  ProcessSupervision,
} from "../runtime/process-supervision.ts"

export interface LspServerEntry {
  ext: string // ".ts"
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * [P13.2] Supervisor proses runtime (DI).
 *
 * Server LSP adalah anak proses milik runtime ini: ia lahir dari perintah
 * pengguna, bisa mati sendiri, dan TIDAK boleh lepas begitu saja. Registrar ini
 * menyerahkan kepemilikan ke SATU jalur ownership proses (runtime), sehingga
 * "tidak ada child yang terlepas" bisa dibuktikan, bukan diklaim.
 *
 * Tanpa pemasang (mode runtime off / tool dipakai tanpa runtime), server LSP
 * tetap jalan seperti sebelumnya — jalur legacy utuh, tanpa klaim supervisi.
 */
let processSupervision: ProcessSupervision | null = null

/** Pasang/lepas jalur ownership proses (composition root). */
export function setLspProcessSupervisor(supervisor: ProcessSupervision | null): void {
  processSupervision = supervisor
}

async function killWindowsTreeAsync(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(resolveTrustedExecutable("taskkill"), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: sanitizeSpawnEnv(process.env),
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        resolve()
      }, 2_000)
      timer.unref?.()
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.once("error", () => {
        clearTimeout(timer)
        resolve()
      })
    } catch {
      resolve()
    }
  })
}

const LANG_ID: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".md": "markdown",
}

function languageIdFor(file: string): string {
  return LANG_ID[extname(file).toLowerCase()] ?? "plaintext"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * E-28: perakitan frame LSP berbasis chunk-list. Dulu tiap chunk stdout
 * `Buffer.concat` ke seluruh sisa buffer → O(n²) untuk pesan besar. Sekarang
 * chunk hanya digabung SATU kali saat frame lengkap, dan referensi chunk lama
 * dilepas setelah dikonsumsi.
 *
 * `Content-Length` juga dibatasi: sebelumnya header bisa menyatakan miliaran
 * byte dan decoder menunggu/mengalokasi tanpa batas (OOM).
 */
const LSP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const LSP_MAX_HEADER_BYTES = 16 * 1024
const EMPTY_BUFFER = Buffer.alloc(0)

export class LspFrameAssembler {
  #chunks: Buffer[] = []
  #head = 0
  #buffered = 0

  get pendingBytes(): number {
    return this.#buffered
  }

  reset(): void {
    this.#chunks.length = 0
    this.#head = 0
    this.#buffered = 0
  }

  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
    const out: unknown[] = []
    for (;;) {
      const window = Math.min(this.#buffered, LSP_MAX_HEADER_BYTES)
      if (window === 0) break
      const head = this.#peek(window)
      const sep = head.indexOf("\r\n\r\n")
      if (sep === -1) {
        if (this.#buffered >= LSP_MAX_HEADER_BYTES) {
          // Header tak wajar besar (atau koneksi mengirim sampah) → buang state
          // daripada menahan memori tak terbatas.
          this.reset()
        }
        break
      }
      const header = head.subarray(0, sep).toString("utf8")
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.#consume(sep + 4)
        continue
      }
      const len = Number(m[1])
      if (!Number.isFinite(len) || len < 0 || len > LSP_MAX_MESSAGE_BYTES) {
        process.stderr.write(
          `[lsp] content-length ${m[1]} rejected (limit ${LSP_MAX_MESSAGE_BYTES})\n`,
        )
        this.reset()
        break
      }
      const total = sep + 4 + len
      if (this.#buffered < total) break
      const frame = this.#consume(total)
      const body = frame.subarray(sep + 4).toString("utf8")
      try {
        out.push(JSON.parse(body))
      } catch {
        // Format protokol: pesan tak valid dibuang, bukan menggagalkan stream.
      }
    }
    return out
  }

  #peek(n: number): Buffer {
    const first = this.#chunks[this.#head]!
    if (first.length >= n) return first.subarray(0, n)
    const out = Buffer.allocUnsafe(n)
    let off = 0
    for (let i = this.#head; i < this.#chunks.length && off < n; i++) {
      const c = this.#chunks[i]!
      const take = Math.min(c.length, n - off)
      c.copy(out, off, 0, take)
      off += take
    }
    return out
  }

  #consume(n: number): Buffer {
    const parts: Buffer[] = []
    let remaining = n
    while (remaining > 0) {
      const c = this.#chunks[this.#head]!
      if (c.length <= remaining) {
        parts.push(c)
        this.#chunks[this.#head] = EMPTY_BUFFER
        this.#head++
        remaining -= c.length
      } else {
        parts.push(c.subarray(0, remaining))
        this.#chunks[this.#head] = c.subarray(remaining)
        remaining = 0
      }
    }
    this.#buffered -= n
    if (this.#head >= this.#chunks.length) {
      this.#chunks.length = 0
      this.#head = 0
    } else if (this.#head > 32 && this.#head * 2 > this.#chunks.length) {
      this.#chunks.splice(0, this.#head)
      this.#head = 0
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n)
  }
}

class LspConnection {
  private proc: ChildProcess | null = null
  private frames = new LspFrameAssembler()
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private seq = 0
  private started = false
  // guard anti double-spawn saat beberapa tool call paralel
  private starting?: Promise<void>
  // abort HANYA saat stop() — bukan timeout, agar server tidak mati sendiri
  private killSignal = new AbortController()
  private opened = new Map<string, { version: number; text: string; langId: string }>()
  readonly diagnostics = new Map<string, Record<string, unknown>[]>()
  private diagnosticWaiters = new Map<string, Set<() => void>>()
  /** [P13.2] true saat stop() yang kita minta → keluarannya BUKAN "tak terduga". */
  private stopping = false
  /** [P13.2] root workspace — dipakai lagi saat restart. */
  private rootPath = ""
  /** Referensi handle stabil supaya restart berulang tetap memakai identitas yang sama di supervisor. */
  private managedHandle: ManagedChild | null = null

  constructor(
    public entry: LspServerEntry,
    private readonly projectRoot = "",
    private readonly isSubRoot = false,
  ) {}

  /** Id anak proses: pertahankan `lsp:<ext>` pada root utama demi kompatibilitas supervisi, tambah hash hanya untuk sub-root monorepo. */
  private get childId(): string {
    return this.isSubRoot && this.projectRoot
      ? `lsp:${this.entry.ext}:${shortRootHash(this.projectRoot)}`
      : `lsp:${this.entry.ext}`
  }

  get serverRoot(): string {
    return this.projectRoot || this.rootPath
  }

  start(rootPath: string): Promise<void> {
    if (this.started) return Promise.resolve()
    this.rootPath = rootPath
    this.starting ??= this.doStart(rootPath)
    return this.starting
  }

  private async doStart(rootPath: string): Promise<void> {
    this.rootPath = rootPath
    this.stopping = false
    this.killSignal = new AbortController()
    const target = resolveSpawnTarget(this.entry.command, this.entry.args)
    this.proc = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      // env kredensial di-strip; env eksplisit config server menang setelahnya
      env: sanitizeSpawnEnv(process.env, this.entry.env),
      signal: this.killSignal.signal,
      detached: process.platform !== "win32",
      windowsHide: true,
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    this.proc.on("error", (err) => {
      this.started = false
      this.starting = undefined
      this.proc = null
      this.failAll(err)
    })
    // [P13.2] Tulis ke server yang sudah mati menghasilkan EPIPE. Itu kondisi
    // NORMAL saat shutdown/supervisi (kita menutup lebih dulu) — dibiarkan
    // jadi event tanpa penanganan, ia bisa menjatuhkan proses CLI. Proses mati
    // dilaporkan lewat handler `exit` ✅, jadi di sini cukup diserap.
    this.proc.stdin?.on("error", () => {})
    this.proc.stdout?.on("error", () => {})
    this.proc.on("exit", (code) => {
      this.started = false
      this.starting = undefined
      this.proc = null
      this.failAll(new Error(`LSP server ${this.entry.ext} exited (${code})`))
      // [P13.2] Keluar saat kita TIDAK minta = anak hilang: serahkan ke jalur
      // proses (bounded restart / eskalasi jujur). Keluar karena stop() kita
      // sendiri bukan kegagalan.
      if (!this.stopping) {
        const supervisor = processSupervision
        if (supervisor) {
          void supervisor.notifyExit(this.childId, {
            status: code === 0 ? "exited" : "failed",
            exitCode: code,
          })
        }
      }
    })
    this.proc.stderr?.on("data", (d: Buffer) => {
      const clean = sanitizeIncoming(d.toString()).trim().slice(0, 500)
      if (clean) process.stderr.write(`[lsp${sanitizeIncoming(this.entry.ext)}] ${clean}\n`)
    })
    this.proc.stdout!.on("data", (chunk: Buffer) => this.handleData(chunk))

    // [P13.2] Serahkan kepemilikan anak ke jalur ownership proses runtime.
    const supervisor = processSupervision
    if (supervisor) {
      if (!this.managedHandle) this.managedHandle = this.managedChild()
      supervisor.register(this.managedHandle)
    }

    // initialize handshake — bila gagal/timeout, wajib bersihkan `this.starting`
    // dan matikan proses LSP agar sesi tak terkunci permanen pada promise ditolak.
    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToFileURL(resolvePath(rootPath)).href,
          capabilities: {
            workspace: { symbol: {} },
            textDocument: {
              publishDiagnostics: { relatedInformation: false },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: {},
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
          },
        },
        LIMITS.LSP_INIT_TIMEOUT_MS,
      )
      this.notify("initialized", {})
      this.started = true
    } catch (err) {
      this.started = false
      this.starting = undefined
      const dead = this.proc
      this.proc = null
      this.stopping = true
      try {
        this.killSignal.abort()
      } catch {}
      if (dead && dead.exitCode === null && dead.signalCode === null) {
        try {
          if (process.platform === "win32" && dead.pid !== undefined) {
            await killWindowsTreeAsync(dead.pid)
          } else if (process.platform !== "win32" && dead.pid !== undefined) {
            process.kill(-dead.pid, "SIGKILL")
          } else {
            dead.kill("SIGKILL")
          }
        } catch {
          try {
            dead.kill("SIGKILL")
          } catch {}
        }
      }
      throw err
    }
  }

  /**
   * [P13.2] Port anak yang dikelola runtime.
   *
   * Restart server LSP TIDAK mengulang kerja pengguna — server hanya menjawab
   * permintaan, jadi restart otomatis aman (dibatasi policy M9). Untuk
   *_background command_ yang bisa mengulang efek, restartSafety-nya "unsafe"
   * dan runtime akan MENOLAK me-restart-nya.
   */
  private managedChild(): ManagedChild {
    return {
      id: this.childId,
      kind: "lsp-server",
      restartSafety: "safe",
      observe: (): ManagedChildObservation => {
        if (this.started) return { status: "running" }
        if (this.proc) return { status: "exited", exitCode: null }
        return { status: "unknown", detail: "not started" }
      },
      stop: async (): Promise<void> => {
        await this.stop()
      },
      restart: async (): Promise<void> => {
        // Diagnostics lama milik server lama → dibuang SEBELUM restart. Kalau
        // dibuang setelah, diagnostics yang baru saja dipublish server baru ikut
        // hilang (dan hasil waitForDiagnostics jadi kosong tanpa sebab).
        this.diagnostics.clear()
        await this.start(this.rootPath)
        // Server baru tak tahu dokumen yang tadi dibuka → buka ulang dengan isi
        // terakhir yang klien kirim (bukan isi basi dari disk).
        this.reopenDocuments()
      },
    }
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const id = ++this.seq
    const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8")
    const proc = this.proc
    const stdin = proc?.stdin
    if (
      !proc ||
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded
    ) {
      throw new Error(`LSP ${method}: server stdin unavailable`)
    }
    stdin.write(`Content-Length: ${msg.length}\r\n\r\n`)
    stdin.write(msg)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed || this.proc.stdin.writableEnded)
      throw new Error(`LSP server ${this.entry.ext} not running`)
    const msg = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8")
    this.proc.stdin.write(`Content-Length: ${msg.length}\r\n\r\n`)
    this.proc.stdin.write(msg)
  }

  openDocument(absPath: string, text: string): string {
    const uri = pathToFileURL(absPath).href
    const langId = languageIdFor(absPath)
    const known = this.opened.get(uri)
    if (!known) {
      // Batasi LRU dokumen terbuka agar RAM proses & server LSP tidak tumbuh tak terbatas.
      if (this.opened.size >= 64) {
        const oldest = this.opened.keys().next().value
        if (oldest) {
          this.opened.delete(oldest)
          this.diagnostics.delete(oldest)
          try {
            this.notify("textDocument/didClose", { textDocument: { uri: oldest } })
          } catch {}
        }
      }
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: langId, version: 1, text },
      })
      this.opened.set(uri, { version: 1, text, langId })
    } else if (known.text === text) {
      // Isi identik: segarkan urutan LRU tanpa didChange palsu yang memicu diagnostics ulang.
      this.opened.delete(uri)
      this.opened.set(uri, known)
    } else {
      const v = known.version + 1
      // Hapus cache diagnostik lama sebelum didChange agar waitForDiagnostics tidak memulangkan hasil versi sebelumnya.
      this.diagnostics.delete(uri)
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      })
      // Refresh urutan LRU.
      this.opened.delete(uri)
      this.opened.set(uri, { version: v, text, langId })
    }
    return uri
  }

  closeDocument(absPath: string): void {
    const uri = pathToFileURL(absPath).href
    if (this.opened.has(uri)) {
      this.opened.delete(uri)
      try {
        this.notify("textDocument/didClose", { textDocument: { uri } })
      } catch {}
    }
    this.diagnostics.delete(uri)
  }

  /**
   * [P13.2] Buka ulang dokumen yang masih terbuka pada server yang BARU.
   *
   * Server yang di-restart tidak tahu dokumen apa pun: isinya hilang bersama
   * prosesnya. Kalau dibiarkan, state klien (dokumen masih terbuka) dan state
   * server jadi berbeda — server jadi buta, dan hasil simbol/diagnostics
   * kosong tanpa alasan.
   *
   * Isi yang dikirim adalah TEKS TERAKHIR yang klien kirim (bukan isi file
   * dari disk): isi disk bisa sudah basi, dan mengirim basi berarti server
   * bekerja pada dokumen yang berbeda dari yang dilihat pengguna.
   *
   * Versi dokumen diteruskan apa adanya, jadi increments seterusnya tetap
   * naik dan server tak pernah melihat versi yang mundur.
   */
  private reopenDocuments(): void {
    for (const [uri, doc] of this.opened) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: doc.langId, version: doc.version, text: doc.text },
      })
    }
  }

  async waitForDiagnostics(uri: string, timeoutMs = 5_000): Promise<Record<string, unknown>[]> {
    if (timeoutMs <= 0) return this.diagnostics.get(uri) ?? []
    if (this.diagnostics.has(uri)) {
      await sleep(100) // settle window for follow-up pushes
      return this.diagnostics.get(uri) ?? []
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const onDiag = () => {
        clearTimeout(timer)
        cleanup()
        setTimeout(resolve, 50)
      }
      const cleanup = () => {
        const s = this.diagnosticWaiters.get(uri)
        if (s) {
          s.delete(onDiag)
          if (s.size === 0) this.diagnosticWaiters.delete(uri)
        }
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, timeoutMs)
      timer.unref?.()

      let s = this.diagnosticWaiters.get(uri)
      if (!s) {
        s = new Set()
        this.diagnosticWaiters.set(uri, s)
      }
      s.add(onDiag)
    })
    return this.diagnostics.get(uri) ?? []
  }

  async stop(): Promise<void> {
    if (!this.proc) return
    // [P13.2] Tandai stop yang kita minta: keluarannya tak dilaporkan sebagai
    // crash tak terduga. Kirim didClose SEBELUM shutdown/exit selagi sesi LSP aktif.
    this.stopping = true
    for (const uri of this.opened.keys()) {
      try {
        this.notify("textDocument/didClose", { textDocument: { uri } })
      } catch {}
    }
    this.opened.clear()
    this.diagnostics.clear()
    try {
      await this.request("shutdown", {}, 2_000)
    } catch {}
    try {
      this.notify("exit")
    } catch {}
    try {
      this.proc.stdin?.end()
    } catch {}
    const p = this.proc
    if (process.platform === "win32" && p.pid !== undefined && p.exitCode === null) {
      await killWindowsTreeAsync(p.pid)
    }
    this.killSignal.abort()
    if (p.exitCode === null && p.signalCode === null) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          try {
            if (process.platform !== "win32" && p.pid !== undefined) process.kill(-p.pid, "SIGKILL")
            else p.kill("SIGKILL")
          } catch {
            try {
              p.kill("SIGKILL")
            } catch {}
          }
          r()
        }, 2_000)
        t.unref?.()
        p.once("exit", () => {
          clearTimeout(t)
          r()
        })
      })
    }
    this.proc = null
    this.started = false
    this.starting = undefined
    this.frames.reset()
    processSupervision?.unregister(this.childId)
  }

  private handleData(chunk: Buffer) {
    let msgs: unknown[]
    try {
      msgs = this.frames.push(chunk)
    } catch (err) {
      // Frame corrupt / melebihi batas: reset parser dan fail-all pending request, bukan throw di listener stdout.
      this.frames.reset()
      this.failAll(err instanceof Error ? err : new Error(String(err)))
      return
    }
    for (const msg of msgs) {
      if (msg && typeof msg === "object" && !Array.isArray(msg)) {
        try {
          this.dispatch(msg as Record<string, unknown>)
        } catch {}
      }
    }
  }

  private dispatch(msg: Record<string, unknown>) {
    // response to our request
    if (msg.id != null && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id as number)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(msg.id as number)
        if (msg.error)
          p.reject(new Error(String((msg.error as Record<string, unknown>).message ?? "LSP error")))
        else p.resolve(msg.result)
      }
      return
    }
    // server → client requests (mis. workspace/configuration, client/registerCapability):
    // wajib dibalas agar pyright/rust-analyzer/gopls tidak menggantung menunggu jawaban.
    if (msg.id != null && typeof msg.method === "string") {
      try {
        const stdin = this.proc?.stdin
        if (stdin && !stdin.destroyed && !stdin.writableEnded) {
          const items = (msg.params as { items?: unknown[] } | undefined)?.items
          const result =
            msg.method === "workspace/configuration" && Array.isArray(items)
              ? items.map(() => null)
              : null
          const reply = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), "utf8")
          stdin.write(`Content-Length: ${reply.length}\r\n\r\n`)
          stdin.write(reply)
        }
      } catch {}
      return
    }
    // server → client notifications
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as
        | { uri?: string; version?: number; diagnostics?: Record<string, unknown>[] }
        | undefined
      if (params?.uri) {
        // Abaikan notifikasi yang secara eksplisit membawa versi lebih tua dari state terbuka saat ini.
        const openedVersion = this.opened.get(params.uri)?.version
        if (
          typeof params.version === "number" &&
          openedVersion !== undefined &&
          params.version < openedVersion
        ) {
          return
        }
        this.diagnostics.set(params.uri, params.diagnostics ?? [])
        const waiters = this.diagnosticWaiters.get(params.uri)
        if (waiters) {
          for (const cb of waiters) cb()
        }
      }
    }
  }

  private failAll(err: Error) {
    for (const s of this.diagnosticWaiters.values()) {
      for (const cb of s) cb()
    }
    this.diagnosticWaiters.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}

const PROJECT_ROOT_MARKERS = [
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const

function normRootKey(p: string): string {
  const abs = resolvePath(p)
  return process.platform === "win32" ? abs.toLowerCase() : abs
}

function shortRootHash(root: string): string {
  let h = 0x811c9dc5
  const norm = normRootKey(root)
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Temukan akar sub-proyek terdekat di dalam workspace untuk isolasi LSP monorepo. */
function findProjectRoot(absFile: string, workspaceRoot: string): string {
  const root = resolvePath(workspaceRoot)
  const file = resolvePath(root, absFile)
  const rel = relative(root, file)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return root
  let dir = dirname(file)
  for (;;) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (existsSync(resolvePath(dir, marker))) return dir
    }
    if (normRootKey(dir) === normRootKey(root)) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return root
}

// Entri terkonfigurasi per ekstensi + koneksi aktif keyed `${ext}\0${normRoot}`.
const configuredEntries = new Map<string, LspServerEntry>()
const activeServers = new Map<string, LspConnection>()

export function configureServers(entries: LspServerEntry[]): void {
  for (const e of entries) {
    const key = e.ext.toLowerCase()
    if (!configuredEntries.has(key)) configuredEntries.set(key, e)
  }
}

// Seam uji: kosongkan registry (isolasi antar test file — repomap mengambil
// jalur LSP begitu ADA server terdaftar, jadi stub uji tak boleh bocor).
export function clearLspServers(): void {
  configuredEntries.clear()
  activeServers.clear()
}

export function getConfiguredExts(): string[] {
  return [...configuredEntries.keys()]
}

function getOrCreateConnection(
  ext: string,
  entry: LspServerEntry,
  projectRoot: string,
  workspaceRoot: string,
): LspConnection {
  const normProject = normRootKey(projectRoot)
  const normWorkspace = normRootKey(workspaceRoot)
  const key = `${ext}\0${normProject}`
  let conn = activeServers.get(key)
  if (!conn) {
    conn = new LspConnection(entry, resolvePath(projectRoot), normProject !== normWorkspace)
    activeServers.set(key, conn)
  }
  return conn
}

async function getConnection(file: string, cwd?: string): Promise<LspConnection> {
  const ext = extname(file).toLowerCase()
  const entry = configuredEntries.get(ext)
  if (!entry) throw new Error(`no LSP configured for '${ext}' — add via minicode config lsp add`)
  const workspaceRoot = resolvePath(cwd ?? process.cwd())
  const projectRoot = findProjectRoot(file, workspaceRoot)
  const conn = getOrCreateConnection(ext, entry, projectRoot, workspaceRoot)
  // Root server mengikuti akar proyek terdekat (atau workspaceRoot bila tunggal), BUKAN process.cwd().
  await conn.start(projectRoot)
  return conn
}

/** Tutup dokumen di koneksi LSP aktif (dipakai move_file / delete_file agar diagnosa lama tidak tertinggal). */
export function closeLspDocument(absPath: string, _cwd?: string): void {
  const ext = extname(absPath).toLowerCase()
  for (const conn of activeServers.values()) {
    if (conn.entry.ext.toLowerCase() === ext) conn.closeDocument(absPath)
  }
}

export interface LspPositionResult {
  position: { line: number; character: number }
  text: string
}

export function findSymbolPosition(
  text: string,
  symbol: string,
): LspPositionResult["position"] | null {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const wordRe = new RegExp(`\\b${escaped}\\b`, "g")
  const declRe = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:(?:function|class|interface|type|enum|const|let|var|def|fn|struct|impl|trait)\\s+|(?:public|private|protected|static|readonly|override|pub(?:\\([^)]*\\))?)\\s+)*${escaped}\\b`,
  )
  const isCommentLine = (trimmed: string): boolean =>
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#")

  // Prioritaskan baris deklarasi non-komentar, lalu kemunculan word-boundary
  // non-komentar pertama, baru fallback ke pencarian umum agar tidak nyasar
  // ke komentar atau import statement di atas file.
  const lines = text.split("\n")
  let firstNonComment: LspPositionResult["position"] | null = null
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!
    const trimmed = line.trimStart()
    if (isCommentLine(trimmed) || trimmed.startsWith("import ")) continue
    wordRe.lastIndex = 0
    const m = wordRe.exec(line)
    if (!m) continue
    if (!firstNonComment) firstNonComment = { line: lineIdx, character: m.index }
    if (declRe.test(line)) return { line: lineIdx, character: m.index }
  }
  if (firstNonComment) return firstNonComment

  const m = new RegExp(`\\b${escaped}\\b`).exec(text)
  const idx = m?.index ?? text.indexOf(symbol)
  if (idx === -1) return null
  const before = text.slice(0, idx).split("\n")
  return { line: before.length - 1, character: before[before.length - 1]!.length }
}

export async function lspDiagnostics(
  absPath: string,
  text: string,
  timeoutMs = 5_000,
  cwd?: string,
): Promise<{ uri: string; items: Record<string, unknown>[] }> {
  const conn = await getConnection(absPath, cwd)
  const uri = conn.openDocument(absPath, text)
  const items = await conn.waitForDiagnostics(uri, timeoutMs)
  return { uri, items }
}

export async function lspCall(
  absPath: string,
  text: string,
  method: string,
  params: Record<string, unknown>,
  cwd?: string,
  // Query navigasi/simbol read-only tidak perlu memblokir 3 detik menunggu pushDiagnostics.
  waitDiagsMs = 0,
): Promise<unknown> {
  const conn = await getConnection(absPath, cwd)
  const uri = conn.openDocument(absPath, text)
  if (waitDiagsMs > 0) await conn.waitForDiagnostics(uri, waitDiagsMs).catch(() => [])
  return conn.request(method, params)
}

export async function closeAllLsp(): Promise<void> {
  for (const conn of activeServers.values()) {
    try {
      await conn.stop()
    } catch {}
  }
}

export interface WorkspaceSymbol {
  name: string
  kind: number
  location: { uri: string; range?: { start?: { line?: number } } }
  containerName?: string
}

// Query workspace symbols across all configured LSP servers (best-effort).
// Returns merged, deduped symbols. Empty query "" should return top symbols
// on servers that support it; we cap and timeout per server.
export async function workspaceSymbols(
  query: string,
  timeoutMs = 4000,
  cwd?: string,
): Promise<WorkspaceSymbol[]> {
  if (configuredEntries.size === 0 && activeServers.size === 0) return []
  const workspaceRoot = resolvePath(cwd ?? process.cwd())
  const targetConns = new Map<LspConnection, string>()
  for (const conn of activeServers.values()) {
    const r = conn.serverRoot || workspaceRoot
    const rel = relative(workspaceRoot, resolvePath(r))
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      targetConns.set(conn, r)
    }
  }
  for (const [ext, entry] of configuredEntries) {
    const hasUnderRoot = [...targetConns.keys()].some((c) => c.entry.ext.toLowerCase() === ext)
    if (!hasUnderRoot) {
      const conn = getOrCreateConnection(ext, entry, workspaceRoot, workspaceRoot)
      targetConns.set(conn, workspaceRoot)
    }
  }
  if (targetConns.size === 0) return []
  const results = await Promise.all(
    [...targetConns.entries()].map(async ([conn, root]) => {
      try {
        await conn.start(root)
        const res = (await conn.request("workspace/symbol", { query }, timeoutMs)) as
          | WorkspaceSymbol[]
          | null
        return Array.isArray(res) ? res : []
      } catch {
        return [] as WorkspaceSymbol[]
      }
    }),
  )
  const seen = new Set<string>()
  const merged: WorkspaceSymbol[] = []
  for (const list of results) {
    for (const s of list) {
      const key = `${s.location.uri}::${s.name}::${s.kind}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(s)
      }
    }
  }
  return merged
}
