import { spawn, spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import {
  allocateEmptyMaskFile,
  createCappedOutputCollector,
  discoverSandboxMaskTargets,
} from "./mask.ts"

let osSandboxOk: boolean | null = null
let osSandboxType: "seatbelt" | "bwrap" | "none" | null = null

function detectOsSandbox(): { available: boolean; type: "seatbelt" | "bwrap" | "none" } {
  if (osSandboxOk !== null) return { available: osSandboxOk, type: osSandboxType! }
  if (process.platform === "darwin") {
    // seatbelt via sandbox-exec (macOS). Check availability
    try {
      // F-23: resolve absolut (lihat docker.ts) — berlaku di Windows untuk
      // docker; di POSIX sebagai hygiene + determinisme PATH.
      const r = spawnSync(resolveTrustedExecutable("sandbox-exec"), ["-h"], {
        stdio: "ignore",
        timeout: 2000,
      })
      // sandbox-exec returns 0 or 64 with usage, consider available if binary exists
      const ok = r.error === undefined
      osSandboxOk = ok
      osSandboxType = ok ? "seatbelt" : "none"
      return { available: ok, type: osSandboxType }
    } catch {
      osSandboxOk = false
      osSandboxType = "none"
      return { available: false, type: "none" }
    }
  }
  if (process.platform === "linux") {
    try {
      const r = spawnSync(resolveTrustedExecutable("bwrap"), ["--version"], {
        stdio: "ignore",
        timeout: 2000,
      })
      const ok = r.status === 0
      osSandboxOk = ok
      osSandboxType = ok ? "bwrap" : "none"
      return { available: ok, type: osSandboxType }
    } catch {
      osSandboxOk = false
      osSandboxType = "none"
      return { available: false, type: "none" }
    }
  }
  osSandboxOk = false
  osSandboxType = "none"
  return { available: false, type: "none" }
}

export function osSandboxAvailable(): boolean {
  return detectOsSandbox().available
}

export function osSandboxTypeName(): string {
  return detectOsSandbox().type
}

export interface OsSandboxOptions {
  signal?: AbortSignal
  env?: Record<string, string>
  timeoutMs?: number
  network?: "none" | "bridge"
  /** v7.31: samakan dengan Docker — kiи kredensial git saat unrestricted. */
  allowGitCredentials?: boolean
}

function escapeSeatbelt(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Susun profil macOS Seatbelt dengan penolakan `.minicode/` dan berkas `.env*` sensitif. */
export function buildSeatbeltProfile(
  absCwd: string,
  envFiles: readonly string[] = [],
  opts: { network?: "none" | "bridge" } = {},
): string {
  const escapedAbs = escapeSeatbelt(absCwd)
  const deniedPaths = new Set<string>([
    ...envFiles.map((rel) => join(absCwd, rel)),
    ...([".env", ".env.local", ".env.production", ".env.development", ".env.test"] as const).map(
      (f) => join(absCwd, f),
    ),
  ])
  const envDenyRules = [...deniedPaths]
    .sort()
    .map((p) => `(deny file-read* file-write* (literal "${escapeSeatbelt(p)}"))`)
    .join("\n")
  const escapedMinicode = escapeSeatbelt(join(absCwd, ".minicode"))
  return `(version 1)
(deny default)
(allow process-exec)
(allow file-read* file-write* (subpath "${escapedAbs}"))
(deny file-read* file-write* (subpath "${escapedMinicode}"))
${envDenyRules}
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/private/tmp"))
(allow sysctl-read)
${opts.network === "bridge" ? "(allow network*)" : "(deny network*)"}
`
}

/** Susun argumen `bwrap` dengan isolasi namespace penuh dan masking `.minicode/` & `.env*`. */
export function buildBwrapArgs(
  command: string,
  absCwd: string,
  opts: OsSandboxOptions,
  mask: {
    hasMinicode: boolean
    envFiles: readonly string[]
    emptyMaskPath: string | null
  },
): string[] {
  const args = [
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    absCwd,
    absCwd,
  ]
  if (mask.hasMinicode) {
    args.push("--tmpfs", join(absCwd, ".minicode"))
  }
  if (mask.emptyMaskPath) {
    for (const rel of mask.envFiles) {
      args.push("--ro-bind", mask.emptyMaskPath, join(absCwd, rel))
    }
  }
  args.push("--chdir", absCwd, "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session")
  if (opts.network !== "bridge") {
    args.push("--unshare-net")
  }
  args.push("--die-with-parent", "--cap-drop", "ALL", "sh", "-c", command)
  return args
}

// Seatbelt profile minimal (deny network, restrict writes outside cwd + .env/.minicode)
// bwrap: bubblewrap with --ro-bind / --bind cwd, namespace unshare + masking
export function runInOsSandbox(
  command: string,
  cwd: string,
  opts: OsSandboxOptions = {},
): Promise<{ code: number | null; output: string }> {
  if (opts.signal?.aborted) return Promise.reject(opts.signal.reason)
  const { available, type } = detectOsSandbox()
  if (!available) {
    // Fail-closed seam: pemanggil (bash/code_run) wajib cek osSandboxAvailable
    // dulu; siapa pun yang memanggil langsung tanpa cek mendapat throw, bukan
    // output berbentuk-sukses yang terlihat seperti isolasi berjalan.
    return Promise.reject(
      new Error(
        "[os-sandbox] not available on this platform — refusing to run (no isolation backend)",
      ),
    )
  }
  const abs = resolve(cwd)
  const sanitizedEnv = sanitizeSpawnEnv(process.env, opts.env, opts.allowGitCredentials) as Record<
    string,
    string
  >
  const timeout = opts.timeoutMs ?? LIMITS.DOCKER_TIMEOUT_MS
  const targets = discoverSandboxMaskTargets(abs)

  if (type === "seatbelt") {
    const profile = buildSeatbeltProfile(abs, targets.envFiles, { network: opts.network })
    const args = ["-p", profile, "sh", "-c", command]
    return runSpawn("sandbox-exec", args, abs, sanitizedEnv, timeout, opts.signal)
  }
  if (type === "bwrap") {
    const emptyMask = allocateEmptyMaskFile(targets.envFiles.length > 0)
    const args = buildBwrapArgs(command, abs, opts, {
      hasMinicode: targets.hasMinicode,
      envFiles: targets.envFiles,
      emptyMaskPath: emptyMask.path,
    })
    return runSpawn("bwrap", args, abs, sanitizedEnv, timeout, opts.signal).finally(() =>
      emptyMask.cleanup(),
    )
  }
  return Promise.resolve({ code: null, output: "[os-sandbox] unknown type" })
}

function runSpawn(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult, reject) => {
    signal?.throwIfAborted()
    // F-23: bin di-resolve absolut dari PATH terpercaya di sini (satu titik
    // untuk seatbelt/bwrap) — spawn dengan cwd workspace di Windows bisa
    // mengeksekusi <bin>.bat repo bila hanya nama telanjang.
    // detached:true → bwrap/sandbox-exec menjadi process-group leader, sehingga
    // timeout bisa membunuh SELURUH pohon (runner + child command) via group kill,
    // bukan hanya pemimpinnya. Tanpa ini, p.kill("SIGKILL") hanya membunuh bwrap;
    // child `node -e 'while(true){}'` tetap hidup mewarisi stdio pipe sehingga
    // event `close` tak pernah menyala → hang + proses bocor (test code_run loop).
    const p = spawn(resolveTrustedExecutable(bin), args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    const collector = createCappedOutputCollector(LIMITS.DOCKER_OUTPUT_MAX_CHARS)
    p.stdout.on("data", (d) => collector.append("out", d))
    p.stderr.on("data", (d) => collector.append("err", d))
    let aborted = false
    let timedOut = false
    let settled = false
    const killGroup = (): void => {
      // SIGKILL ke seluruh process group (bwrap + child command). Fallback ke
      // kill tunggal bila pid tak tersedia (spawn gagal sinkron).
      try {
        if (p.pid !== undefined) process.kill(-p.pid, "SIGKILL")
        else p.kill("SIGKILL")
      } catch {
        try {
          p.kill("SIGKILL")
        } catch {}
      }
    }
    const onAbort = (): void => {
      if (settled || aborted) return
      aborted = true
      clearTimeout(t)
      killGroup()
    }
    const cleanup = (): void => {
      settled = true
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
    }
    const t = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    p.once("error", (e) => {
      cleanup()
      if (aborted) reject(signal?.reason)
      else resolveResult({ code: null, output: `[os-sandbox] ${e.message}` })
    })
    p.once("close", (code) => {
      if (settled) return
      cleanup()
      if (aborted) {
        reject(signal?.reason)
        return
      }
      const { marker, output } = collector.format()
      if (timedOut) {
        // Kontrak lapisan ini adalah RESOLVE (bukan reject): runner hanya
        // melaporkan hasil proses (code/output), dan pemanggil yang memutuskan
        // arti code=null. Dulu di sini `reject` untuk timeout, sementara abort
        // `resolve` — kontraknya campur, sehingga `code_run` (yang tidak menangkap
        // reject) meneruskan timeout sebagai error tak terduga. Docker runner
        // sudah resolve untuk timeout; disamakan di sini.
        resolveResult({
          code: null,
          output: `[os-sandbox] timed out after ${timeoutMs}ms; effects are UNKNOWN, inspect before retrying${marker ? `\n${marker}` : ""}${output ? `\n${output}` : ""}`,
        })
        return
      }
      resolveResult({ code, output })
    })
    signal?.addEventListener("abort", onAbort, { once: true })
    // Close the race between the pre-spawn check and listener registration.
    if (signal?.aborted) onAbort()
  })
}
