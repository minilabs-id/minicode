import { type ChildProcess, type spawn, spawnSync } from "node:child_process"
import { resolveTrustedExecutable } from "./trusted-exec.ts"

/** Kirim sinyal ke grup proses POSIX (`-pid`, butuh `detached: true`). */
export function signalProcessGroup(p: Pick<ChildProcess, "pid">, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32" || p.pid === undefined) return false
  try {
    process.kill(-p.pid, signal)
    return true
  } catch {
    return false
  }
}

/** Eskalasi sopan POSIX: SIGTERM ke process group, fallback ke proses tunggal. */
export function signalProcessGroupGraceful(
  pid: number | undefined,
  fallback: { kill: (signal?: NodeJS.Signals | number) => boolean },
  opts: {
    platform?: NodeJS.Platform
    killGroup?: (pid: number, signal: NodeJS.Signals) => boolean
  } = {},
): "group" | "fallback" {
  const platform = opts.platform ?? process.platform
  if (platform !== "win32" && typeof pid === "number" && pid > 0) {
    const killGroup =
      opts.killGroup ??
      ((target: number, signal: NodeJS.Signals): boolean => process.kill(target, signal))
    try {
      if (killGroup(-pid, "SIGTERM")) return "group"
    } catch {}
  }
  try {
    fallback.kill("SIGTERM")
  } catch {}
  return "fallback"
}

/** Hentikan proses beserta subtree: Windows `taskkill /T /F`, POSIX SIGKILL `-pid`. */
export function killProcessTree(
  p: ReturnType<typeof spawn>,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  try {
    if (process.platform === "win32" && p.pid !== undefined) {
      const r = spawnSync(
        resolveTrustedExecutable("taskkill"),
        ["/pid", String(p.pid), "/T", "/F"],
        {
          stdio: "ignore",
          ...(opts.env ? { env: opts.env } : {}),
        },
      )
      if (r.status === 0) return
    } else if (signalProcessGroup(p, "SIGKILL")) {
      return
    }
  } catch {}
  try {
    p.kill("SIGKILL")
  } catch {}
}
