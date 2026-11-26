// Clipboard OS native lintas platform (Windows / macOS / Linux) sebelum fallback
// OSC-52. Modul hidup di src/lib/ (di luar src/ui/ agar batas lapisan tetap bersih)
// dan tidak pernah menulis ke stdout (inventaris writer tetap utuh).

import { spawnSync } from "node:child_process"

/** Penanda non-enumerable dari test harness (`installFakeTty`) agar test tidak
 * pernah menyentuh clipboard OS asli atau memicu proses eksternal. */
export const FAKE_TTY_SYMBOL = Symbol.for("minicode.fakeTty")

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

function defaultSpawn(cmd: string, args: string[], input: string): { ok: boolean } {
  try {
    const res = spawnSync(cmd, args, {
      input,
      encoding: "utf8",
      timeout: CLIPBOARD_TIMEOUT_MS,
      windowsHide: true,
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
  const run = opts.spawn ?? defaultSpawn
  for (const candidate of nativeClipboardCommands(platform, env)) {
    try {
      if (run(candidate.cmd, candidate.args, text).ok) return true
    } catch {}
  }
  return false
}
