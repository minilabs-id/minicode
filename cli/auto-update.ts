// Orkestrasi auto-update interaktif: cek → install → restart.
// Dipanggil dari cli/index.ts HANYA saat masuk REPL (enterRepl). One-shot,
// exec, pipe, dan CI tidak tersentuh (notifikasi async biasa) — restart di
// tengah pipeline akan merusak output machine dan perilaku skrip.

import { type ChildProcess, spawn } from "node:child_process"
import {
  checkForUpdateFresh,
  classifyInstallSource,
  formatUpdateError,
  formatUpdateMessage,
  getLastUpdateFailure,
  type InstallResult,
  installUpdate,
  shouldAutoUpdate,
  UPDATE_GUARD_ENV,
  verifyInstalledVersion,
} from "../src/policy/update-check.ts"
import { c } from "../src/ui/render/theme.ts"

/** Tulis satu baris status progres saat alt-screen dilepas (dipakai /update). */
export function writeUpdateStatusLine(line: string): void {
  process.stderr.write(`${line.replace(/[\r\n]+/g, " ").trim()}\n`)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return String(err)
  } catch {
    return "unknown"
  }
}

/**
 * Tunggu proses anak sampai benar-benar selesai — SATU-SATUNYA cara menunggu
 * spawn di repo ini. Dengarkan `exit` DAN `close` DAN `error`: `exit` saja
 * tak datang bila anak menahan stdio (pipe inherit macet) sehingga induk
 * menunggu selamanya tanpa umpan balik = terlihat hang. Guard `settled`
 * karena exit+close bisa datang berurutan untuk anak yang sama.
 */
export function waitChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((res) => {
    let settled = false
    const done = (c2: number | null) => {
      if (settled) return
      settled = true
      res(c2)
    }
    child.on("exit", (c2) => done(c2))
    child.on("close", (c2) => done(c2))
    child.on("error", () => done(1))
  })
}

/**
 * Bila layak: cek registry (fresh), install bila ada versi baru, lalu
 * respawn argv yang sama dan JANGAN kembali (process.exit di dalam).
 * Return bila tidak ada update / tak layak / install gagal — REPL lanjut
 * dengan versi lama. Tak pernah melempar.
 */
export async function maybeAutoUpdate(
  version: string,
  signal?: AbortSignal,
  opts?: {
    onLongOp?: () => void
    getInstalledVersion?: () => string
    /** Fase progres untuk bar loading: "check" | "install" | "restart". */
    onPhase?: (phase: "check" | "install" | "restart") => void
    /** Sink pesan proses (deferred ke transcript saat bar aktif). */
    onNotice?: (line: string) => void
    /** Hook opsional untuk menutup lease/session sebelum respawn ke versi baru. */
    onBeforeRespawn?: () => Promise<void> | void
  },
): Promise<void> {
  let decision: ReturnType<typeof shouldAutoUpdate>
  try {
    decision = shouldAutoUpdate(process.argv.slice(2), {
      stdinTTY: process.stdin.isTTY,
      installSource: classifyInstallSource(),
    })
  } catch {
    return
  }
  if (!decision.run) return
  if (signal?.aborted) return
  opts?.onPhase?.("check")
  let latest: string | null
  try {
    latest = await checkForUpdateFresh(version, signal)
  } catch {
    return
  }
  if (signal?.aborted) return
  if (!latest) return
  // Fase panjang dimulai (install + restart): minta pemanggil menghentikan
  // bar transient-nya DULU. Output anak (npm/respawn) kini dipipe dan
  // disembunyikan (stdio: "pipe") sehingga tidak mengotori bar — pewarisan
  // `inherit` lama membuat output npm mentah menimpa spinner/bar.
  try {
    opts?.onLongOp?.()
  } catch {}
  opts?.onPhase?.("install")
  opts?.onNotice?.(`${c.yellow(formatUpdateMessage(version, latest))}\n`)
  opts?.onNotice?.(c.dim("Menginstall pembaruan otomatis…\n"))
  let ok = false
  let thrown: unknown
  try {
    ok = installUpdate(latest)
  } catch (err) {
    thrown = err
    ok = false
  }
  if (!ok) {
    // installUpdate mencatat langkah + detail yang sudah diredaksi. Pakai itu,
    // bukan stderr mentah — user butuh tahu apakah E401, EACCES, atau timeout.
    const failure = getLastUpdateFailure() ?? {
      step: "npm install",
      result: {
        status: null,
        error: thrown ? errorMessage(thrown) : "instalasi gagal tanpa detail",
      } satisfies InstallResult,
    }
    const reason = formatUpdateError(failure.step, failure.result)
    opts?.onNotice?.(
      c.yellow(
        `Auto-update gagal pada ${reason} — lanjut versi ${version}. Update manual: npm install -g minicode-ai@${latest}\n`,
      ),
    )
    return
  }
  const installedMatches = (expected: string): boolean => {
    if (!opts?.getInstalledVersion) return true
    return verifyInstalledVersion(expected, opts.getInstalledVersion)
  }
  if (!installedMatches(latest)) {
    opts?.onNotice?.(
      c.yellow(
        `Versi terpasang tidak cocok dengan target ${latest}; mencoba memulihkan ${version}…\n`,
      ),
    )
    let restored = false
    try {
      restored = installUpdate(version) && installedMatches(version)
    } catch {
      restored = false
    }
    if (restored) {
      opts?.onNotice?.(c.yellow(`Auto-update dibatalkan; versi ${version} berhasil dipulihkan.\n`))
      return
    }
    // Gagal tidak dapat dipulihkan: fatal — tetap cetak + keluar (tidak
    // didefer; proses akan mati).
    process.stderr.write(
      c.error(
        `Auto-update tidak dapat memverifikasi atau memulihkan instalasi. Keluar; pulihkan dengan: npm install -g minicode-ai@${version}\n`,
      ),
    )
    process.exit(1)
  }
  // Restart ke kode baru dengan argv identik; guard env cegah loop bila
  // versi ter-install ternyata masih dilaporkan lebih tua.
  opts?.onPhase?.("restart")
  opts?.onNotice?.(c.dim(`Restart ke versi ${latest}…\n`))
  // Pastikan bar induk mati sebelum anak hidup (idempoten — onLongOp
  // sudah dipanggil sebelum install, tapi install bisa gagal-skip jalur ini
  // bila dipanggil ulang di masa depan).
  try {
    opts?.onLongOp?.()
  } catch {}
  try {
    await opts?.onBeforeRespawn?.()
  } catch {}
  const entry = process.argv[1] ?? ""
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [UPDATE_GUARD_ENV]: "1" },
  })
  const code = await waitChildExit(child)
  process.exit(code ?? 0)
}
