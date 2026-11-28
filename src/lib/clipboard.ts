// Clipboard OS native lintas platform (Windows / macOS / Linux) sebelum fallback
// OSC-52. Modul hidup di src/lib/ (di luar src/ui/ agar batas lapisan tetap bersih)
// dan tidak pernah menulis ke stdout (inventaris writer tetap utuh).

import { spawnSync } from "node:child_process"
import { isAbsolute } from "node:path"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import { resolveSpawnTarget } from "./trusted-exec.ts"

/** Penanda non-enumerable dari test harness (`installFakeTty`) agar test tidak
 * pernah menyentuh clipboard OS asli atau memicu proses eksternal. */
const FAKE_TTY_SYMBOL = Symbol.for("minicode.fakeTty")

export type ClipboardSpawn = (cmd: string, args: string[], input: string) => { ok: boolean }

export interface NativeClipboardOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
  isFakeTty?: boolean
  /** Paksa coba runner native (khusus unit test dengan `spawn` tersuntik). */
  force?: boolean
  spawn?: ClipboardSpawn
}

const CLIPBOARD_TIMEOUT_MS = 1500

function isFakeTtyStdin(): boolean {
  try {
    return Boolean((process.stdin as unknown as Record<symbol, unknown>)[FAKE_TTY_SYMBOL])
  } catch {
    return false
  }
}

/**
 * Tentukan apakah clipboard OS lokal aman & relevan dipakai.
 *
 * Dinonaktifkan pada:
 * - `MINICODE_CLIPBOARD=osc52` (pilihan eksplisit pengguna)
 * - sesi SSH remote (`SSH_CONNECTION`/`SSH_TTY`/`SSH_CLIENT`): clipboard native
 *   menulis ke host remote, sedangkan OSC-52 meneruskan ke terminal klien
 * - proses non-TTY atau harness fake-TTY test (`FAKE_TTY_SYMBOL`)
 */
export function canUseNativeClipboard(opts: NativeClipboardOptions = {}): boolean {
  const env = opts.env ?? process.env
  if ((env.MINICODE_CLIPBOARD ?? "").trim().toLowerCase() === "osc52") return false
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false
  const tty = opts.isTTY ?? Boolean(process.stdout.isTTY)
  if (!tty) return false
  const fake = opts.isFakeTty ?? isFakeTtyStdin()
  if (fake) return false
  return true
}

/** Resolusi target spawn terpercaya untuk utilitas clipboard; kembalikan null bila bukan path absolut. */
export function prepareClipboardSpawn(
  cmd: string,
  args: readonly string[],
  opts: { platform?: NodeJS.Platform; resolveExec?: (name: string) => string } = {},
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } | null {
  const target = resolveSpawnTarget(cmd, args, opts)
  // Anti-hijack CWD Windows CreateProcess & PATH relatif: nama telanjang yang gagal
  // ter-resolve dari PATH terpercaya ditolak sebelum spawnSync.
  if (!isAbsolute(target.command)) return null
  return target
}

function defaultSpawn(
  cmd: string,
  args: string[],
  input: string,
  platform: NodeJS.Platform = process.platform,
): { ok: boolean } {
  try {
    const target = prepareClipboardSpawn(cmd, args, { platform })
    if (!target) return { ok: false }
    const res = spawnSync(target.command, target.args, {
      input,
      encoding: "utf8",
      timeout: CLIPBOARD_TIMEOUT_MS,
      windowsHide: true,
      env: sanitizeSpawnEnv(process.env),
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["pipe", "ignore", "ignore"],
    })
    return { ok: !res.error && res.status === 0 }
  } catch {
    return { ok: false }
  }
}

/** Kandidat utilitas clipboard berdasarkan OS dan session display (Wayland/X11). */
export function nativeClipboardCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] }[] {
  if (platform === "win32") {
    return [
      {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      },
      { cmd: "clip.exe", args: [] },
    ]
  }
  if (platform === "darwin") {
    return [{ cmd: "pbcopy", args: [] }]
  }
  const cmds: { cmd: string; args: string[] }[] = []
  if (env.WAYLAND_DISPLAY) cmds.push({ cmd: "wl-copy", args: [] })
  if (env.DISPLAY) {
    cmds.push({ cmd: "xclip", args: ["-selection", "clipboard"] })
    cmds.push({ cmd: "xsel", args: ["--clipboard", "--input"] })
  }
  return cmds
}

/**
 * Tulis teks ke clipboard OS lokal secara sinkron dengan timeout singkat.
 * Mengembalikan `true` saat salah satu utilitas sukses; `false` agar pemanggil
 * dapat jatuh ke OSC-52 tanpa melempar error.
 */
export function writeNativeClipboard(text: string, opts: NativeClipboardOptions = {}): boolean {
  if (!opts.force && !canUseNativeClipboard(opts)) return false
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const run =
    opts.spawn ??
    ((cmd: string, args: string[], input: string) => defaultSpawn(cmd, args, input, platform))
  for (const candidate of nativeClipboardCommands(platform, env)) {
    try {
      if (run(candidate.cmd, candidate.args, text).ok) return true
    } catch {}
  }
  return false
}
