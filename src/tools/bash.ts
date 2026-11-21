import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { LIMITS } from "../constants.ts"
import {
  killProcessTree,
  signalProcessGroup,
  signalProcessGroupGraceful,
} from "../lib/process-tree.ts"
import { isCwdOutsideRoot, isPathOutsideRoot } from "../policy/jail.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

export { SECRET_ENV_RE, sanitizeSpawnEnv, stripSecretsEnv } from "../policy/scrub.ts"
// re-export untuk backward compat (helper kini terpusat di policy/scrub & lib/process-tree)
export { signalProcessGroupGraceful }

import { sandboxExplicitFallbackAllowed, sandboxStrict } from "../policy/sandbox-policy.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { dockerAvailable, runInDocker } from "../sandbox/docker.ts"
import { osSandboxAvailable, runInOsSandbox } from "../sandbox/os.ts"

// ── Output buffer dengan cap saat streaming ──
// Cap diterapkan SAAT data masuk, bukan slice di akhir: command dengan output
// raksasa (`yes`, `cat file-1GB`) tidak boleh membawa proses ke OOM.
class CappedBuffer {
  private out = ""
  private err = ""
  truncated = false
  constructor(private readonly cap: number) {}

  append(target: "out" | "err", chunk: Buffer | string): string {
    const s = typeof chunk === "string" ? chunk : chunk.toString()
    // v7.32 (L9): anggaran dipakai BERSAMA stdout+stderr. Dulu tiap stream
    // punya cap penuh 20k sehingga gabungannya bisa ~40k, melanggar klaim
    // "max 20k chars" di deskripsi tool. Sekarang yang tersisa dihitung dari
    // total out+err, jadi total keluaran benar-benar ≤ cap.
    const used = this.out.length + this.err.length
    if (used >= this.cap) {
      this.truncated = true
      return ""
    }
    const room = this.cap - used
    if (s.length > room) this.truncated = true
    const piece = s.slice(0, Math.max(0, room))
    if (target === "out") this.out += piece
    else this.err += piece
    return piece
  }

  /** Teks gabungan, sudah di-scrub, dengan marker truncation. */
  text(): string {
    const joined = (this.out + (this.err ? `\n[stderr]\n${this.err}` : "")).trim()
    return scrubSecrets(joined) + (this.truncated ? "\n… [output truncated]" : "")
  }
}

// F-03: request sandbox EKSPLISIT (MINICODE_SANDBOX=docker/os/...) tanpa
// backend juga fail-closed secara default — lihat sandboxRefusalReason di
// policy/sandbox-policy.ts (dipakai CLI) + cabang di bawah (dipakai jalur
// env-langsung seperti MCP/sub-agen). Downgrade diam-diam ke host membuat
// operator yakin terisolasi padahal tidak — satu baris [warn] bukan
// persetujuan. Fallback eksplisit tetap tersedia via
// MINICODE_SANDBOX_ALLOW_FALLBACK=1 (untuk mesin tanpa backend yang operator
// sadari), dan tanpa MINICODE_SANDBOX sama sekali perilaku tetap direct.

// Penanda truncation: output yang dipotong diam-diam tampak lengkap dan
// menyesatkan model (temuan audit #02). Selalu tandai bila dipotong.
export function capMarked(text: string, cap: number): string {
  return text.length > cap
    ? `${text.slice(0, cap)}\n… [truncated: showing first ${cap} chars]`
    : text
}

// ── Background jobs ──
// Perlu untuk dev server / watcher / test panjang: proses hidup melewati batas
// satu turn, output-nya diambil bertahap lewat bash_output.
interface BackgroundJob {
  id: string
  cmd: string
  startedAt: number
  proc: ReturnType<typeof spawn>
  buffer: CappedBuffer
  /** Offset baca terakhir supaya bash_output hanya mengembalikan yang baru. */
  cursor: number
  chunks: string[]
  exitCode: number | null
  done: boolean
  /** v7.41 (audit bg F5): waktu selesai — dipakai reaping, bukan startedAt. */
  finishedAt?: number
  /** v7.31: timer eskalasi kill dari bash_kill — dibersihkan saat job close. */
  killTimer?: ReturnType<typeof setTimeout>
  /**
   * F-03 (P5 §C2): sid kanonik pemilik job — diikat saat start dari instans
   * tool yang sudah di-composition (createBashJobTools), BUKAN dari argumen
   * tool. null = instans default tanpa sid (library/test legacy); jalur
   * produksi selalu terikat sid lewat composition root.
   */
  ownerSid: string | null
}

const jobs = new Map<string, BackgroundJob>()

/**
 * Pendengar selesainya job background: lapisan cli memakainya untuk repaint
 * badge footer + satu auto-resume terbatas. Tool hanya mengumumkan fakta
 * "job X selesai dengan exit N" — tak tahu apa pun soal UI/prompt. Set agar
 * unsubscribe idempoten dan aman saat listener menghapus dirinya saat emit.
 */
const finishListeners = new Set<(id: string, code: number | null) => void>()

/** Daftarkan pendengar selesai job. Return = fungsi unsubscribe (idempoten). */
export function onBackgroundJobFinished(
  listener: (id: string, code: number | null) => void,
): () => void {
  finishListeners.add(listener)
  return () => {
    finishListeners.delete(listener)
  }
}

function emitBackgroundJobFinished(id: string, code: number | null): void {
  // Satu listener yang melempar tak boleh menahan listener lain ATAU
  // menggagalkan handler `close` proses anak.
  for (const listener of [...finishListeners]) {
    try {
      listener(id, code)
    } catch {}
  }
}

// F-03 (P5 §C2): gerbang akses job. Hanya pemilik (sid sama, null==null untuk
// jalur legacy) yang boleh inspect/cancel. Kegagalan karena kepemilikan
// menghasilkan TIDAK ADA — pemanggil tak bisa membedakan "job milik sesi lain"
// dari "id tak dikenal" (non-disclosing).
function ownedJob(id: string, callerSid: string | null): BackgroundJob | undefined {
  const j = jobs.get(id)
  if (!j || j.ownerSid !== callerSid) return undefined
  return j
}

// Daftar job hidup yang boleh disebut dalam pesan not-found: HANYA milik
// pemanggil. Daftar proses-wide (lama) membocorkan id sesi lain — itulah
// kebocoran yang ditutup C2.
function liveOwnedIds(callerSid: string | null): string[] {
  return [...jobs.values()].filter((j) => !j.done && j.ownerSid === callerSid).map((j) => j.id)
}

function reapFinishedJobs(): void {
  const now = Date.now()
  for (const [id, j] of jobs) {
    // v7.41: ukur dari SELESAI, bukan mulai — job 1 jam yang baru selesai tak
    // boleh langsung hilang saat job berikutnya dimulai (bash_output butuh
    // mengambil output akhirnya). `finishedAt` absen (job lama) → startedAt.
    const since = j.finishedAt ?? j.startedAt
    if (j.done && now - since > LIMITS.BASH_BACKGROUND_MAX_LIFETIME_MS) jobs.delete(id)
  }
}

function killTree(p: ReturnType<typeof spawn>): void {
  killProcessTree(p, { env: sanitizeSpawnEnv(process.env) })
}

/**
 * Hentikan semua job — dipanggil saat CLI keluar agar tidak ada proses yatim.
 *
 * WAJIB tree-kill, bukan `proc.kill()`: yang dibunuh cuma wrapper shell,
 * sedangkan cucu (dev server, watcher, `node -e`) tetap hidup, menahan pipe
 * stdio, dan jadi proses yatim yang tak pernah dibersihkan. Modul ini sudah
 * punya killTree() untuk itu — jalur shutdown sebelumnya tak memakainya.
 */
export function killAllBackgroundJobs(): void {
  for (const [id, j] of jobs) {
    try {
      // `!j.done` = jangan sentuh pid yang sudah mati (risiko pid dipakai
      // ulang proses lain → taskkill /pid membunuh proses tak berkaitan).
      if (!j.done) killTree(j.proc)
    } catch {}
    jobs.delete(id)
  }
}

export function listBackgroundJobs(): { id: string; cmd: string; done: boolean }[] {
  return [...jobs.values()].map((j) => ({ id: j.id, cmd: j.cmd, done: j.done }))
}

function startBackground(
  cmd: string,
  cwd: string | undefined,
  ownerSid: string | null,
  relaxed = false,
): string {
  reapFinishedJobs()
  // Isolasi kuota per pemilik sesi agar satu sesi tidak menghabiskan slot sesi lain,
  // tetap dibatasi backstop global proses agar jumlah anak OS terkendali.
  const ownerLive = [...jobs.values()].filter((j) => !j.done && j.ownerSid === ownerSid).length
  if (ownerLive >= LIMITS.BASH_BACKGROUND_MAX_JOBS) {
    throw new Error(
      `too many background jobs (${ownerLive}/${LIMITS.BASH_BACKGROUND_MAX_JOBS}) — stop one with bash_kill first`,
    )
  }
  const totalLive = [...jobs.values()].filter((j) => !j.done).length
  const totalCap = LIMITS.BASH_BACKGROUND_MAX_JOBS * 4
  if (totalLive >= totalCap) {
    throw new Error(
      `too many active background jobs (${totalLive}/${totalCap}) — stop one with bash_kill first`,
    )
  }
  const id = `bg_${randomUUID().slice(0, 8)}`
  const proc = spawn(cmd, {
    shell: true,
    cwd,
    env: sanitizeSpawnEnv(process.env, undefined, relaxed),
    stdio: ["ignore", "pipe", "pipe"],
    // detached agar shell jadi group leader → killTree bisa menutup SELURUH
    // grup (POSIX kill(-pid)). Tanpa ini yang bisa dibunuh cuma wrapper shell
    // dan cucu (dev server, watcher) jadi yatim saat bash_kill/shutdown.
    detached: process.platform !== "win32",
  })
  const job: BackgroundJob = {
    id,
    cmd,
    startedAt: Date.now(),
    proc,
    buffer: new CappedBuffer(LIMITS.BASH_OUTPUT_MAX_CHARS),
    cursor: 0,
    chunks: [],
    exitCode: null,
    done: false,
    ownerSid,
  }
  proc.stdout?.on("data", (d: Buffer) => {
    const piece = job.buffer.append("out", d)
    if (piece) job.chunks.push(scrubSecrets(piece))
  })
  proc.stderr?.on("data", (d: Buffer) => {
    const piece = job.buffer.append("err", d)
    if (piece) job.chunks.push(scrubSecrets(piece))
  })
  // Emit sekali per job: `error` biasanya disusul `close` (emit ganda =
  // dua auto-resume). Guard lokal cukup — kedua handler berbagi closure.
  let emitted = false
  const emitOnce = (code: number | null): void => {
    if (emitted) return
    emitted = true
    job.finishedAt = Date.now()
    emitBackgroundJobFinished(id, code)
  }
  proc.on("error", (e) => {
    job.chunks.push(`[error] ${e.message}`)
    job.done = true
    emitOnce(null)
  })
  proc.on("close", (code) => {
    job.exitCode = code
    job.done = true
    // v7.31: matikan timer eskalasi bash_kill bila job selesai lebih dulu.
    if (job.killTimer !== undefined) {
      clearTimeout(job.killTimer)
      job.killTimer = undefined
    }
    emitOnce(code)
  })
  jobs.set(id, job)
  return id
}

// F-03: instans tool bash terikat satu sid pemilik. Instans default (export
// di bawah) memakai null — jalur library/test tanpa komposisi sid; sesi
// produksi memakai createBashJobTools(sid) lewat composition root.
function makeBashTool(ownerSid: string | null): Tool {
  return {
    name: "bash",
    // v7.33 (wire contract): deskripsi dipangkas ~45%. Timeout/cap di dalam
    // deskripsi panjang duplikat dengan schema (timeoutMs, LIMITS) dan hasil
    // tool; yang HARUS tetap ada adalah aturan "jangan retry buta" (penting
    // untuk command ber-efek samping) dan petunjuk Windows (dipindah ke `cmd`).
    description:
      "SHELL: Run a shell command (30s timeout, 20k output cap, exit prefixed). background:true for long jobs — collect via bash_output, stop via bash_kill. Prefer git_status/git_diff/git_log and read_file/edit over raw shell; on Windows use dir /b or Get-Content, not for %f / more. On allowlist denial do NOT retry blindly: switch to read_file/edit or ask the operator to rerun with --allow-all/--sandbox docker.",
    parameters: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "command to run (Windows: cmd.exe syntax — dir, echo %VAR%, type)",
        },
        cwd: {
          type: "string",
          description: "working directory relative to the workspace (default: workspace root)",
        },
        timeoutMs: { type: "number", description: "timeout in ms (default 30000)" },
        background: {
          type: "boolean",
          description:
            "run without waiting for completion; returns a job id for bash_output/bash_kill",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
    async execute({ cmd, cwd, timeoutMs, background }, ctx) {
      const sessionRoot = requireToolCwd(ctx)
      const relaxed = contextUnrestricted(ctx)
      const c = cwd as string | undefined
      if (!relaxed && c && (isCwdOutsideRoot(c, sessionRoot) || isPathOutsideRoot(c, sessionRoot)))
        throw new Error(`cwd outside workspace: ${c}`)
      const resolvedCwd = c ? resolvePath(sessionRoot, c) : undefined
      const effectiveCwd = resolvedCwd ?? sessionRoot
      // Catatan TOCTOU (bug-hunt 2026-09-19, tervalidasi e2e): cek-cwd di atas
      // (isCwdOutsideRoot = realpath) menutup varian cwd-form — swap setelah
      // titik ini masih menang SEBELUM spawn (jendela mikrodetik pada alur
      // executor normal; butuh penulis konkuren jahat). Varian redirect-form
      // (`> sub/f` tanpa arg cwd) tak punya recheck saat spawn: shell me-resolve
      // symlink — tak bisa ditutup murah dari sini (shell mengikuti symlink by
      // design; safe-open O_NOFOLLOW hanya untuk tool file). Mitigasi: --sandbox
      // untuk isolasi penuh; lihat permission.ts jail + safe-open.ts.
      // Unrestricted: default timeout jauh lebih lega; timeoutMs eksplisit
      // tetap menang.
      const timeout =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : relaxed
            ? LIMITS.UNRESTRICTED_BASH_TIMEOUT_MS
            : LIMITS.BASH_DEFAULT_TIMEOUT_MS

      if (background === true) {
        // Sandbox tidak diterapkan di jalur background: container/namespace
        // ephemeral mati bersama call-nya, jadi menjanjikan isolasi di sini
        // akan menyesatkan. Tolak eksplisit daripada diam-diam tanpa sandbox.
        if (process.env.MINICODE_SANDBOX) {
          throw new Error(
            "background:true is not supported while --sandbox is active (the process must outlive the turn)",
          )
        }
        const id = startBackground(cmd as string, effectiveCwd, ownerSid, relaxed)
        // F-07: echo perintah di-scrub seperti output foreground — command line
        // bisa membawa secret (`curl -H "Authorization: Bearer …"`), dan versi
        // lama menaruhnya mentah ke konteks model.
        return `background job started: ${id}\ncmd: ${scrubSecrets(String(cmd)).slice(0, 200)}\ncollect output: bash_output({ id: "${id}" })`
      }

      // Docker sandbox mode — run in ephemeral isolated container
      if (process.env.MINICODE_SANDBOX === "docker") {
        if (dockerAvailable()) {
          const res = await runInDocker(cmd as string, effectiveCwd, {
            timeoutMs: timeout,
            env: sanitizeSpawnEnv(process.env, undefined, relaxed) as Record<string, string>,
            signal: ctx.signal,
            // Teruskan flag unrestricted: runInDocker menyanitasi ulang env,
            // tanpa ini kredensial git yang lolos di sini bakal dihapus lagi.
            allowGitCredentials: relaxed,
          })
          ctx.signal.throwIfAborted()
          const text = scrubSecrets(res.output)
          if (res.code !== 0)
            return `exit ${res.code ?? "unknown"}\n${capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)}`
          return capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)
        }
        if (sandboxStrict() || !sandboxExplicitFallbackAllowed()) {
          throw new Error(
            "[sandbox] MINICODE_SANDBOX=docker but docker unavailable — refusing direct execution (explicit sandbox request must not silently downgrade; set MINICODE_SANDBOX_ALLOW_FALLBACK=1 to allow host fallback explicitly)",
          )
        }
        process.stderr.write(
          "[warn] MINICODE_SANDBOX=docker but docker unavailable — falling back to direct execution (explicit MINICODE_SANDBOX_ALLOW_FALLBACK=1)\n",
        )
      }
      // OS-native sandbox (Seatbelt macOS / bubblewrap Linux) — Codex/Gemini-like without Docker
      if (
        process.env.MINICODE_SANDBOX === "os" ||
        process.env.MINICODE_SANDBOX === "seatbelt" ||
        process.env.MINICODE_SANDBOX === "bwrap"
      ) {
        if (osSandboxAvailable()) {
          const res = await runInOsSandbox(cmd as string, effectiveCwd, {
            signal: ctx.signal,
            timeoutMs: timeout,
            env: sanitizeSpawnEnv(process.env, undefined, relaxed) as Record<string, string>,
            // v7.31: env sudah di-sanitize dengan `relaxed` di atas — tanpa
            // flag ini OS sandbox menghapus kredensial git lagi saat unrestricted.
            allowGitCredentials: relaxed,
          })
          const text = scrubSecrets(res.output)
          if (res.code !== 0)
            return `exit ${res.code ?? "unknown"}\n${capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)}`
          return capMarked(text, LIMITS.BASH_OUTPUT_MAX_CHARS)
        }
        if (sandboxStrict() || !sandboxExplicitFallbackAllowed()) {
          throw new Error(
            "[sandbox] OS sandbox unavailable — refusing direct execution (explicit sandbox request must not silently downgrade; set MINICODE_SANDBOX_ALLOW_FALLBACK=1 to allow host fallback explicitly)",
          )
        }
        process.stderr.write(
          "[warn] MINICODE_SANDBOX=os but OS sandbox unavailable — falling back to direct execution (explicit MINICODE_SANDBOX_ALLOW_FALLBACK=1)\n",
        )
      }

      return await new Promise((resolveOut, reject) => {
        const startedAt = Date.now()
        // [Fase 2 / LOOP-INV-07] Dua sebab penghentian yang HARUS dibedakan:
        // timeout internal (efek samping = UNKNOWN) vs abort turn (dibatalkan
        // pemanggil). Sebelumnya keduanya hanya terlihat sebagai `exit null`
        // sehingga model tak punya sinyal untuk berhenti mengulang perintah
        // destruktif yang mungkin sudah setengah berjalan.
        let timedOut = false
        const p = spawn(cmd as string, {
          shell: true,
          // F-24: selalu effectiveCwd (sessionRoot bila arg cwd absen), bukan
          // undefined (= inherit process.cwd()). Jail/permission dievaluasi
          // terhadap sessionRoot — eksekusi harus di direktori yang sama.
          cwd: effectiveCwd,
          env: sanitizeSpawnEnv(process.env, undefined, relaxed),
          // Cancellation is owned below and settles only after process close.
          // detached agar shell jadi group leader → killTree bisa bunuh
          // seluruh grup (POSIX kill(-pid)). Tanpa ini cucu yatim menahan pipe.
          detached: process.platform !== "win32",
        })
        const buf = new CappedBuffer(LIMITS.BASH_OUTPUT_MAX_CHARS)
        // Progres inkremental: command panjang (bun test, build) tidak lagi
        // membisu sampai selesai. Event ini opsional bagi UI.
        const emitChunk = (piece: string) => {
          if (!piece) return
          try {
            ctx.emit?.({
              type: "provider:extension",
              kind: "bash-output",
              data: { text: scrubSecrets(piece) },
            })
          } catch {}
        }
        p.stdout.on("data", (d: Buffer) => emitChunk(buf.append("out", d)))
        p.stderr.on("data", (d: Buffer) => emitChunk(buf.append("err", d)))
        // v7.32 (L2): SATU jalur cleanup dipanggil dari error DAN close.
        // Dulu `p.on("error", reject)` hanya settle promise; bila `close`
        // tak pernah menyusul (mis. spawn ENOENT / kill gagal), timer 30 dtk
        // dan abort listener tetap hidup menahan referensi proses mati.
        // Idempoten (cleanedUp) agar aman bila error diikuti close.
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let t: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          if (t) clearTimeout(t)
          if (killTimer) clearTimeout(killTimer)
          // Kill the group before close can release executor quarantine.
          killTree(p)
        }
        let cleanedUp = false
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          ctx.signal.removeEventListener("abort", onAbort)
          if (t) clearTimeout(t)
          if (killTimer) clearTimeout(killTimer)
        }

        p.on("error", (e) => {
          cleanup()
          reject(e)
        })
        p.on("close", (code) => {
          cleanup()
          const text = buf.text()
          if (ctx.signal.aborted) {
            reject(ctx.signal.reason)
            return
          }
          if (timedOut) {
            // Prefix deterministik (parsing oleh jurnal/recovery) + instruksi
            // eksplisit. `isError: true` dicapai dengan reject: kernel
            // mengubah message menjadi ToolResult{isError:true}.
            const elapsed = Date.now() - startedAt
            const partial = text.length > 4000 ? `…${text.slice(-4000)}` : text
            reject(
              new Error(
                `[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT side_effect_tier=LOCAL_ENV_MUTATION ` +
                  `duration_ms=${elapsed} timeout_ms=${timeout}]\n` +
                  `Command was cut off by the ${timeout} ms timeout. Its side effects are UNKNOWN ` +
                  `(the command may have partially run). Do NOT re-run a side-effecting command ` +
                  `before inspecting workspace/process state.\n` +
                  (partial
                    ? `--- partial output ---\n${partial}`
                    : "--- partial output ---\n(none)"),
              ),
            )
            return
          }
          if (code !== 0) resolveOut(`exit ${code}\n${text}`)
          else resolveOut(text)
        })
        t = setTimeout(() => {
          timedOut = true
          // Windows: SIGTERM hanya membunuh cmd.exe wrapper — cucu (node -e)
          // bisa belum lahir (spawn lambat) atau yatim sambil menahan pipe.
          // Eskalasi taskkill /pid-shell-yang-sudah-mati lalu gagal total.
          // Jadi di win32 langsung tree-kill saat timeout, tanpa jeda.
          // POSIX: SIGTERM ke SELURUH grup dulu (LOOP-INV-10) supaya cucu
          // sempat cleanup; SIGKILL grup menyusul bila 2 detik tak cukup.
          if (process.platform === "win32") killTree(p)
          else signalProcessGroupGraceful(p.pid, p)
          killTimer = setTimeout(() => {
            killTree(p)
          }, 2000)
        }, timeout)
        ctx.signal.addEventListener("abort", onAbort, { once: true })
        if (ctx.signal.aborted) onAbort()
      })
    },
  }
}

function makeBashOutputTool(ownerSid: string | null): Tool {
  return {
    name: "bash_output",
    // v7.33 (wire contract): tag SHELL.
    description:
      "SHELL: Get NEW output from a background job (since the last read); includes exit status once finished.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "job id from bash with background:true" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id }, ctx: ToolContext) {
      ctx.signal.throwIfAborted()
      // v7.41: reap juga saat bash_output dipanggil — job done yang tak pernah
      // disusul job baru (F5) tetap dibersihkan, tapi output akhirnya masih bisa
      // diambil sampai batas lifetime terlewat.
      reapFinishedJobs()
      // F-03: kepemilikan diperiksa SEBELUM output/status apa pun dibocorkan;
      // pesan untuk job sesi lain = persis "tidak dikenal", tanpa daftar id asing.
      const job = ownedJob(String(id), ownerSid)
      if (!job) {
        const live = liveOwnedIds(ownerSid)
        throw new Error(
          `job "${id}" not found${live.length ? ` — active: ${live.join(", ")}` : ""}`,
        )
      }
      const fresh = job.chunks.slice(job.cursor)
      job.cursor = job.chunks.length
      const status = job.done ? `finished (exit ${job.exitCode ?? "?"})` : "running"
      if (fresh.length === 0) return `[${job.id}] ${status} — no new output yet`
      // v7.41 (audit background F1): dulu `capMarked` diterapkan pada header +
      // fresh sekaligus → marker palsu saat total >20k walau fresh utuh, dan
      // flag `job.buffer.truncated` (sumber kebenaran pemotongan) diabaikan.
      // Sekarang: cap isi FRESH dulu, lalu tembahkan header, dan pakai marker
      // yang SAMA dengan jalur foreground (CappedBuffer.text).
      const freshText = fresh.join("")
      const cap = LIMITS.BASH_OUTPUT_MAX_CHARS
      const truncated = job.buffer.truncated || freshText.length > cap
      const shown = truncated ? freshText.slice(0, cap) : freshText
      return `[${job.id}] ${status}\n${scrubSecrets(shown)}${
        truncated ? "\n… [output truncated]" : ""
      }`
    },
  }
}

function makeBashKillTool(ownerSid: string | null): Tool {
  return {
    name: "bash_kill",
    // v7.33 (wire contract): tag SHELL.
    description: "SHELL: Stop a background job (SIGTERM then SIGKILL).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "job id" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute({ id }, ctx: ToolContext) {
      ctx.signal.throwIfAborted()
      // F-03: sama seperti bash_output — penolakan identik dengan id tak dikenal,
      // tanpa mengungkap status (hidup/selesai) milik sesi lain.
      const job = ownedJob(String(id), ownerSid)
      if (!job) throw new Error(`job "${id}" not found`)
      if (job.done) return `[${job.id}] already finished (exit ${job.exitCode ?? "?"})`
      // Bunuh TREE, bukan cuma wrapper shell: `proc.kill()` di Windows hanya
      // menebas cmd.exe — cucu (watcher, `node -e`) tetap hidup, menahan pipe
      // stdio sehingga job tak pernah selesai dan prosesnya yatim.
      // POSIX diberi jeda SIGTERM ke grup dulu (graceful); Windows langsung
      // tree-kill, karena proc.kill hanya menebas cmd.exe sedangkan
      // taskkill /T butuh akar yang masih hidup.
      if (process.platform === "win32") killTree(job.proc)
      else if (!signalProcessGroup(job.proc, "SIGTERM")) {
        try {
          job.proc.kill("SIGTERM")
        } catch {}
      }
      // v7.31: simpan handle & bersihkan saat job selesai — timer 1 dtk yang
      // dibiarkan hidup menahan shutdown dan menyentuh pid mati.
      // v7.32 (L3): batalkan timer eskalasi SEBELUM menggantinya. Tanpa ini,
      // bash_kill kedua menganakkan timer baru sementara timer pertama tetap
      // hidup (orphan) → dua taskkill ke pid yang sama setelah job selesai.
      if (job.killTimer !== undefined) clearTimeout(job.killTimer)
      const escalation = setTimeout(() => {
        try {
          if (!job.done) killTree(job.proc)
        } catch {}
      }, 1000)
      try {
        ;(escalation as unknown as { unref?: () => void }).unref?.()
      } catch {}
      job.killTimer = escalation
      return `[${job.id}] stopped`
    },
  }
}

// Instans default TANPA sid: jalur library/test lama tetap berfungsi (caller
// null mengakses job null). Sesi produksi WAJIB memakai createBashJobTools.
export const bashTool: Tool = makeBashTool(null)
export const bashOutputTool: Tool = makeBashOutputTool(null)
export const bashKillTool: Tool = makeBashKillTool(null)

/**
 * F-03 (P5 §C2): instans bash/bash_output/bash_kill yang menyandang satu sid
 * pemilik kanonik. Dipanggil composition root (tool-layer untuk sesi CLI,
 * serveMcp dengan contextId per-instance) — sid DIJAHIT sebagai closure saat
 * perakitan, bukan dari argumen tool yang bisa dipalsukan pemanggil.
 */
export function createBashJobTools(ownerSid: string): {
  bash: Tool
  bashOutput: Tool
  bashKill: Tool
} {
  if (typeof ownerSid !== "string" || !ownerSid)
    throw new Error("createBashJobTools: ownerSid must be a non-empty canonical session id")
  return {
    bash: makeBashTool(ownerSid),
    bashOutput: makeBashOutputTool(ownerSid),
    bashKill: makeBashKillTool(ownerSid),
  }
}
