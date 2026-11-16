import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { killProcessTree, signalProcessGroupGraceful } from "../lib/process-tree.ts"
import { isRealPathOutsideRoot } from "../policy/jail.ts"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"

export interface RunHookCtx {
  phase: "pre" | "post"
  prompt?: string
  cwd?: string
  result?: unknown
}

export interface RunHooksOptions {
  /** Izinkan hook lokal `<cwd>/.minicode/hooks` (hanya bila `--allow-local-config`). */
  allowLocal?: boolean
}

/**
 * Guard mode untuk hooks (audit #10 P1): hooks berjalan di luar permission
 * system — di mode tanpa-eksekusi (plan/readonly) hook TETAP mengeksekusi
 * tanpa gate bila tidak dijaga, melanggar kontrak read-only. Diekspor agar
 * composition root + test memakai predikat yang sama.
 *
 * P12 S2.2 + P0.2 — WorkMode-aware. Hooks (eksekusi Node di luar permission
 * system) HANYA boleh jalan di WorkMode EXECUTE; DISCUSS dan PLAN dilarang
 * karena keduanya posture non-eksekusi (ceiling handler menolak tool
 * tulis/eksekusi). Pemanggil legacy tanpa workMode memakai keputusan murni
 * permission mode (default undefined = perilaku lama).
 */
export function shouldRunHooks(
  permissionMode: string,
  workMode?: "DISCUSS" | "PLAN" | "EXECUTE",
): boolean {
  // P0.2 (Q3): hooks berjalan di luar permission system dengan akses penuh
  // Node.js/filesystem/jaringan, sehingga DILARANG di DISCUSS maupun PLAN
  // untuk seluruh PermissionMode. Hanya WorkMode EXECUTE (atau pemanggil
  // legacy tanpa argumen workMode) yang boleh menjalankan hooks.
  if (workMode !== undefined && workMode !== "EXECUTE") return false
  return permissionMode !== "plan" && permissionMode !== "readonly"
}

// 6.4 — hooks global opt-in: ~/.minicode/hooks/{pre,post}*.js, dan lokal
// .minicode/hooks/{pre,post}*.js (fail-closed: lokal butuh allowLocal=true
// agar menyalakan MINICODE_HOOKS=1 global tak mengeksekusi JS repo asing).
// Berjalan sebagai node script terpisah dengan konteks di env MINICODE_HOOK_CTX.
export function findRunHooks(
  cwd?: string,
  opts: RunHooksOptions = {},
): { pre: string[]; post: string[] } {
  const dirs: { dir: string; jail: boolean }[] = [
    { dir: join(homedir(), ".minicode", "hooks"), jail: false },
  ]
  if (cwd && opts.allowLocal === true) {
    dirs.push({ dir: resolve(cwd, ".minicode", "hooks"), jail: true })
  }
  const out = { pre: [] as string[], post: [] as string[] }
  for (const { dir, jail } of dirs) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith(".js")) continue
      const full = join(dir, f)
      // Symlink di dalam .minicode/hooks tak boleh lolos keluar direktori hook.
      if (jail && isRealPathOutsideRoot(full, dir)) continue
      if (f.startsWith("pre")) out.pre.push(full)
      else if (f.startsWith("post")) out.post.push(full)
    }
  }
  return out
}

export async function runRunHooks(
  phase: "pre" | "post",
  ctx: RunHookCtx,
  signal?: AbortSignal,
  opts: RunHooksOptions = {},
): Promise<void> {
  if (process.env.MINICODE_HOOKS !== "1") return
  // Hook = arbitrary Node.js di luar permission system (berjalan di EXECUTE
  // bila opt-in) — karenanya: tanpa secret di env (baca dari berkas bila
  // perlu), hormati pembatalan sesi secara instan, dan tree-kill saat timeout.
  if (signal?.aborted) return
  const hooks = findRunHooks(ctx.cwd, opts)
  const baseKillEnv = sanitizeSpawnEnv(process.env)
  for (const file of hooks[phase]) {
    if (signal?.aborted) return
    // Audit #10 P2 observability: hook adalah eksekusi di luar permission
    // system — operator wajib bisa melihat APA yang jalan (nama berkas saja;
    // output hook tetap dibuang, isi tak pernah di-log).
    try {
      process.stderr.write(`[hooks] ${phase}: ${file.split(/[\\/]/).pop()}\n`)
    } catch {}
    await new Promise<void>((res) => {
      const p = spawn(process.execPath, [file], {
        env: sanitizeSpawnEnv(process.env, { MINICODE_HOOK_CTX: JSON.stringify(ctx) }),
        stdio: "ignore",
        detached: process.platform !== "win32",
      })
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener("abort", onAbort)
        res()
      }
      const terminateHook = (): void => {
        if (settled) return
        if (process.platform === "win32") {
          killProcessTree(p, { env: baseKillEnv })
          return
        }
        signalProcessGroupGraceful(p.pid, p)
        killTimer = setTimeout(() => {
          killProcessTree(p, { env: baseKillEnv })
        }, 1000)
        killTimer.unref?.()
      }
      const onAbort = (): void => {
        killProcessTree(p, { env: baseKillEnv })
      }
      const timer = setTimeout(terminateHook, 5000)
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
      p.on("error", cleanup)
      p.on("close", cleanup)
    })
  }
}
