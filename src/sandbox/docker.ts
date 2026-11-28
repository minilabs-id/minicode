import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { LIMITS } from "../constants.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import {
  allocateEmptyMaskFile,
  createCappedOutputCollector,
  discoverSandboxMaskTargets,
} from "./mask.ts"

let dockerOk: boolean | null = null

// Cek docker CLI tersedia (cache hasilnya).
export function dockerAvailable(): boolean {
  if (dockerOk !== null) return dockerOk
  try {
    // F-23: resolve absolut dari PATH terpercaya — di Windows spawn mencari
    // CWD lebih dulu sehingga docker.bat di workspace bisa membajak cek ini.
    const r = spawnSync(
      resolveTrustedExecutable("docker"),
      ["version", "--format", "{{.Server.Version}}"],
      {
        stdio: "ignore",
        timeout: 5000,
      },
    )
    dockerOk = r.status === 0
  } catch {
    dockerOk = false
  }
  return dockerOk
}

// Konversi path workspace untuk -v mount. Windows: C:\x → //c/x (Docker Desktop / MSYS).
function workspaceMount(cwd: string): string {
  const abs = resolve(cwd)
  if (process.platform === "win32") {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs)
    if (m) return `//${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`
  }
  return abs
}

export interface DockerRunOptions {
  image?: string
  network?: "none" | "bridge"
  memory?: string
  cpus?: number
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Mode unrestricted (bash) boleh mewariskan kredensial git sempit
   * (GITHUB_TOKEN/GH_TOKEN/SSH_AUTH_SOCK) ke container. Tanpa ini, sanitasi
   * kedua di bawah menggugurkan kredensial yang sudah lolos di bash tool —
   * push via token/SSH jadi gagal diam-diam di sandbox docker.
   */
  allowGitCredentials?: boolean
  /** Callback heartbeat ringan saat proses container mengeluarkan stdout/stderr. */
  onActivity?: () => void
}

let dockerSpawnForTest: typeof spawn | null = null

/** Seam untuk mensimulasikan lifecycle Docker tanpa daemon dalam tes. */
export function setDockerSpawnForTest(spawner: typeof spawn | null): void {
  dockerSpawnForTest = spawner
}

function dockerExecutable(): string {
  return dockerSpawnForTest ? "docker" : resolveTrustedExecutable("docker")
}

function spawnDocker(args: string[], env: NodeJS.ProcessEnv) {
  return (dockerSpawnForTest ?? spawn)(dockerExecutable(), args, {
    stdio: "ignore",
    env,
  })
}

/** Minta daemon menghapus container; timeout membuat kegagalan cleanup eksplisit. */
function removeContainer(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolveResult) => {
    let done = false
    const p = spawnDocker(["rm", "--force", name], env)
    const finish = (removed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveResult(removed)
    }
    const timer = setTimeout(() => {
      p.kill("SIGKILL")
      finish(false)
    }, LIMITS.DOCKER_CLEANUP_TIMEOUT_MS)
    p.on("error", () => finish(false))
    p.on("close", (code) => finish(code === 0))
  })
}

/** Susun argumen `docker run` termasuk masking `.minicode/` & `.env*` sensitif. */
export function buildDockerRunArgs(
  command: string,
  cwd: string,
  opts: DockerRunOptions,
  mask: {
    containerName: string
    hasMinicode: boolean
    envFiles: readonly string[]
    emptyMaskHostPath: string | null
  },
): string[] {
  const image = opts.image ?? process.env.MINICODE_SANDBOX_IMAGE ?? "node:22-alpine"
  const mount = workspaceMount(cwd)
  if (mount.includes(":")) {
    throw new Error(`refusing docker mount with ':' in path: ${mount}`)
  }
  const net = opts.network === "bridge" ? "bridge" : "none"
  const mem = opts.memory ?? process.env.MINICODE_SANDBOX_MEMORY ?? "512m"
  if (mask.envFiles.length > 0 && !mask.emptyMaskHostPath) {
    throw new Error("refusing to start docker sandbox without .env mask file")
  }
  const args = [
    "run",
    "--rm",
    "--name",
    mask.containerName,
    "-i",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "32",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "-v",
    `${mount}:${mount}`,
  ]
  // Sembunyikan state minicode (.minicode/) dan rahasia workspace (.env*) di dalam container.
  if (mask.hasMinicode) {
    args.push("--tmpfs", `${mount}/.minicode:ro,size=64k`)
  }
  if (mask.emptyMaskHostPath) {
    const emptyMount = workspaceMount(mask.emptyMaskHostPath)
    if (emptyMount.includes(":")) {
      throw new Error(`refusing docker mask mount with ':' in path: ${emptyMount}`)
    }
    for (const rel of mask.envFiles) {
      if (rel.includes(":")) throw new Error(`refusing docker .env mask with ':' in path: ${rel}`)
      args.push("-v", `${emptyMount}:${mount}/${rel}:ro`)
    }
  }
  args.push(
    "-w",
    mount,
    "--network",
    net,
    "--memory",
    mem,
    "--memory-swap",
    mem,
    "--cpus",
    String(opts.cpus ?? 1),
    "--user",
    "1000:1000",
    image,
    "sh",
    "-c",
    command,
  )
  return args
}

// Run command di dalam container ephemeral, terisolasi (--network none default,
// memori/CPU cap, masking .env/.minicode), mount workspace read-write. Return { code, output }.
export function runInDocker(
  command: string,
  cwd: string,
  opts: DockerRunOptions = {},
): Promise<{ code: number | null; output: string }> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, output: "[docker] aborted before container start" })
  }
  const containerName = `minicode-${randomUUID()}`
  const targets = discoverSandboxMaskTargets(cwd)
  if (targets.truncated) {
    return Promise.reject(
      new Error(
        `[docker] refusing to start: .env* mask discovery truncated (${targets.truncationReason ?? "limit"})`,
      ),
    )
  }
  const emptyMask = allocateEmptyMaskFile(targets.envFiles.length > 0)
  const args = buildDockerRunArgs(command, cwd, opts, {
    containerName,
    hasMinicode: targets.hasMinicode,
    envFiles: targets.envFiles,
    emptyMaskHostPath: emptyMask.path,
  })

  return new Promise((resolveResult) => {
    // env selalu disanitasi dari hasil merge final — secret (API_KEY/TOKEN/...)
    // tidak pernah diwarisi container walau caller lupa strip. Satu-satunya
    // passthrough adalah kredensial git pada mode unrestricted yang diteruskan
    // eksplisit oleh bash tool lewat opts.allowGitCredentials.
    const env = sanitizeSpawnEnv(process.env, opts.env, opts.allowGitCredentials)
    const p = (dockerSpawnForTest ?? spawn)(dockerExecutable(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
    // Cap buffer saat streaming — output container raksasa tidak menumpuk di RAM.
    const collector = createCappedOutputCollector(LIMITS.DOCKER_OUTPUT_MAX_CHARS)
    const timeout =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : LIMITS.DOCKER_TIMEOUT_MS
    let settled = false
    let closed = false
    let stopReason: "timeout" | "abort" | undefined
    let stopPromise: Promise<boolean> | undefined
    let t: ReturnType<typeof setTimeout>
    const signal = opts.signal
    const finalize = (code: number | null, suffix = "") => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
      emptyMask.cleanup()
      resolveResult({ code, output: collector.format().output + suffix })
    }
    const requestStop = (reason: "timeout" | "abort") => {
      if (stopReason || settled) return
      stopReason = reason
      clearTimeout(t)
      stopPromise = removeContainer(containerName, env).catch(() => false)
      void stopPromise.then((removed) => {
        if (!closed) p.kill("SIGKILL")
        if (closed) {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          const reasonText = reason === "timeout" ? `timed out after ${timeout}ms` : "aborted"
          finalize(null, `\n[docker] ${reasonText}; ${detail}`)
        }
      })
    }
    const startedMono = performance.now()
    const maxActiveMs = Math.max(timeout * 8, timeout)
    const armTimer = () => {
      clearTimeout(t)
      if (settled || stopReason) return
      const elapsed = Math.max(0, performance.now() - startedMono)
      const remaining = Math.max(1, maxActiveMs - Math.floor(elapsed))
      t = setTimeout(() => requestStop("timeout"), Math.min(timeout, remaining))
    }
    let lastBeatAt = 0
    const onDockerChunk = (stream: "out" | "err", d: Buffer) => {
      collector.append(stream, d)
      if (opts.onActivity && Date.now() - lastBeatAt >= 2_000) {
        lastBeatAt = Date.now()
        try {
          opts.onActivity()
        } catch {}
      }
      if (opts.timeoutMs && opts.timeoutMs > LIMITS.DOCKER_TIMEOUT_MS) armTimer()
    }
    p.stdout.on("data", (d) => onDockerChunk("out", d))
    p.stderr.on("data", (d) => onDockerChunk("err", d))
    const onAbort = () => requestStop("abort")
    armTimer()
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) requestStop("abort")
    }
    p.on("error", (e) => {
      closed = true
      if (stopReason) {
        void (stopPromise ?? Promise.resolve(false)).then((removed) => {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          finalize(null, `\n[docker] ${stopReason}; ${detail}`)
        })
      } else {
        finalize(null, `[docker] ${e.message}`)
      }
    })
    p.on("close", (code) => {
      closed = true
      clearTimeout(t)
      if (stopReason) {
        void (stopPromise ?? Promise.resolve(false)).then((removed) => {
          const detail = removed
            ? "daemon container removal confirmed"
            : "daemon cleanup unconfirmed"
          const reasonText = stopReason === "timeout" ? `timed out after ${timeout}ms` : "aborted"
          finalize(null, `\n[docker] ${reasonText}; ${detail}`)
        })
      } else {
        finalize(code)
      }
    })
  })
}
