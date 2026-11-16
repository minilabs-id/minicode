import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

// Resolusi executable TERPERCAYA (audit #10 P0).
//
// Masalah: `spawn("git", …, { cwd: workspace })` di Windows memakai urutan
// pencarian CreateProcess yang mencari DIREKTORI CWD lebih dulu daripada PATH.
// Repo yang dibuka cukup menaruh `git.bat`/`git.cmd`/`git.exe` → operasi git
// otomatis minicode (mis. `git ls-files` saat membangun system prompt setiap
// sesi) menjalankan kode repo TANPA persetujuan. Mengubah PATH child TIDAK
// menolong (cwd tetap menang), jadi resolusi harus absolut.
//
// Solusi: cari nama di entri PATH yang VALID (absolut, bukan ""/"."), memakai
// PATHEXT di Windows, TANPA pernah melihat cwd. Bila tak ketemu → kembalikan
// nama telanjang (perilaku lama) supaya kegagalan tetap fail-open seperti
// semula, tetapi kasus umum (git terpasang di PATH) jadi aman dari hijack.

function isWindows(): boolean {
  return process.platform === "win32"
}

function validPathEntries(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? ""
  const out: string[] = []
  for (const entry of raw.split(delimiter)) {
    if (!entry) continue // "" = direktori kerja (bahaya)
    if (!isAbsolute(entry)) continue // relatif = tak dapat dipercaya
    out.push(entry)
  }
  return out
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    if (isWindows()) return true
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const cache = new Map<string, string>()

/**
 * Kembalikan path absolut terpercaya untuk `name`, atau `name` itu sendiri
 * bila tak ditemukan (fail-open, sama seperti perilaku spawn bawaan).
 * Hasil di-cache per proses.
 */
export function resolveTrustedExecutable(name: string): string {
  const cached = cache.get(name)
  if (cached) return cached
  const resolved = resolveUncached(name)
  // Jangan pernah men-cache kegagalan resolusi (nama telanjang): bila PATH
  // baru diisi belakangan, pemanggilan ulang harus tetap bisa menemukan biner absolut.
  if (isAbsolute(resolved)) cache.set(name, resolved)
  return resolved
}

function resolveUncached(name: string): string {
  // Nama yang sudah absolut atau memuat pemisah path (mis. "./scripts/x",
  // "tools\\run.exe") adalah pilihan eksplisit pemanggil — jangan diubah.
  if (isAbsolute(name)) return name
  if (name.includes("/") || name.includes("\\")) return name
  const windows = isWindows()
  const exts = windows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""]
  for (const dir of validPathEntries()) {
    if (windows) {
      for (const ext of exts) {
        const candidate = join(
          dir,
          name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext,
        )
        if (isExecutableFile(candidate)) return candidate
      }
    } else {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return name
}

function quoteWinCmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("trusted-exec: unsafe control character in cmd.exe shim argument")
  }
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg
  // Pisahkan di `%` agar `cmd.exe` tidak melakukan ekspansi `%VAR%` di dalam
  // tanda kutip ganda: tiap potongan aman dikutip, `%` disisip di luar kutip
  // sebagai `^%` tanpa menghasilkan `""` berurutan yang dibaca MSVCRT sebagai `"`.
  const quoteSegment = (seg: string): string =>
    seg === "" ? "" : `"${seg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
  if (arg.includes("%")) {
    const out = arg
      .split("%")
      .map((part) => quoteSegment(part))
      .join("^%")
    return out || '""'
  }
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

/**
 * Siapkan target `spawn()` lintas-OS yang aman dari hijack CWD sekaligus
 * mampu menjalankan shim `.cmd`/`.bat` di Windows (Node/Bun menolak spawn
 * langsung `.cmd` dengan EINVAL tanpa shell).
 */
export function resolveSpawnTarget(
  command: string,
  args: readonly string[],
  opts: { platform?: NodeJS.Platform; resolveExec?: (name: string) => string } = {},
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const resolveExec = opts.resolveExec ?? resolveTrustedExecutable
  const resolved = resolveExec(command)
  const platform = opts.platform ?? process.platform
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    const comspec = resolveExec(process.env.ComSpec || "cmd.exe")
    const line = [resolved, ...args].map(quoteWinCmdArg).join(" ")
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    }
  }
  return { command: resolved, args: [...args] }
}
