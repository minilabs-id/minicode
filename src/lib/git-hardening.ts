import { spawnSync } from "node:child_process"
import { sanitizeSpawnEnv } from "../policy/scrub.ts"
import { resolveTrustedExecutable } from "./trusted-exec.ts"

// Hardening argv untuk SEMUA pemanggilan git minicode (audit #10 P0).
//
// Model ancaman: direktori repo yang dibuka bisa membawa `.git/config`
// (hooksPath, fsmonitor, pager, filter/diff drivers) + `.git/hooks/*` +
// `.gitattributes`. Tanpa netralisasi, operasi git rutin (bahkan read-only
// seperti `status`/`diff`) mengeksekusi perintah repo: clean/smudge filters,
// textconv/diff.external, fsmonitor, hooks commit, pager.
//
// Aturan pemakaian:
// - GIT_SAFE_BASE di semua pemanggilan (tanpa kecuali).
// - GIT_NO_DIFF_DRIVERS di diff/log yang menampilkan konten.
// - gitFilterNeutralizers HANYA untuk plumbing internal (shadow
//   snapshot/restore) yang wajib byte-exact + tanpa eksekusi — JANGAN untuk
//   index user (LFS/semantik clean milik user, lihat git.ts). Pengecualian:
//   protokol `filter.<d>.process` diutamakan git di atas clean/smudge, jadi
//   neutralizer selalu mematikannya (nilai kosong = fallback ke clean/smudge)
//   di SEMUA jalur plumbing; `git_commit` menolak filter sebelum staging.

/** Netralisasi universal: tanpa hooks, fsmonitor, pager, GPG/SSH/credential/ext-protocol RCE. */
export const GIT_SAFE_BASE: readonly string[] = [
  "--no-pager",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "core.fsmonitor=",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=",
  "-c",
  "gpg.ssh.program=",
  "-c",
  "gpg.x509.program=",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.askPass=",
  "-c",
  "protocol.ext.allow=never",
]

/** Netralisasi driver konten untuk diff/log (tanpa eksekusi repo). */
export const GIT_NO_DIFF_DRIVERS: readonly string[] = ["--no-ext-diff", "--no-textconv"]

const DRIVER_RE = /^filter\.([A-Za-z0-9_.-]+)\.(clean|smudge|process)$/i

export interface FilterDriver {
  name: string
  /** Driver memakai protokol process (long-running) — diutamakan git di atas
   * clean/smudge, sehingga override clean/smudge saja TIDAK cukup. */
  hasProcess: boolean
}

/**
 * Daftar driver filter yang TERKONFIGURASI di repo (discovery read-only via
 * `git config`, tanpa hook/filter/pager). Kegagalan discovery melempar error:
 * pemanggil tidak boleh menganggap ketidakmampuan memeriksa sebagai tidak ada
 * filter. Dipakai neutralizer plumbing dan preflight `git_commit`.
 *
 * Hanya config LOKAL (`--local`, yakni `.git/config`) beserta file yang
 * di-include-nya (`--includes`) yang dihitung. Model ancaman = repo yang dibuka
 * membawa definisi filter sendiri; itu SELALU lokal (bisa lewat `[include]`).
 * Filter global/sistem (mis. Git LFS di Git-for-Windows) bukan ancaman repo:
 * tanpa `--local` definition LFS operator dilaporkan sebagai filter repo dan
 * mem-blokir setiap commit/restore (false positive). Catatan: sengaja TIDAK
 * menyaring berdasarkan pemakaian di `.gitattributes` — sumber atribut bisa
 * tersebar (per-dir, `.git/info/attributes`, `core.attributesFile`), dan kalau
 * ada satu sumber yang terlewat, filter yang benar-benar jalan lolos (fail-open).
 * Lebih aman menolak semua filter lokal; `--local` sudah cukup hilangkan FP.
 */
export function discoverFilterDriversSync(cwd: string): FilterDriver[] {
  const gitBin = resolveTrustedExecutable("git")
  const env = sanitizeSpawnEnv(process.env)
  // `--local` = baca HANYA `.git/config` repo. Tanpa ini, `git config` ikut
  // mengembalikan filter global/sistem (LFS) yang memicu penolakan palsu.
  // `--includes` WAJIB: `--local` saja TIDAK mengikuti `[include] path=...`
  // dari config repo, sehingga repo jahat bisa menyembunyikan filter di file
  // yang di-include dan lolos (fail-open). `--local --includes` tetap TIDAK
  // membaca scope global/sistem (include chain mulai dari file lokal saja).
  const r = spawnSync(
    gitBin,
    [
      "config",
      "--local",
      "--includes",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process)$",
    ],
    { cwd, encoding: "utf8", timeout: 10_000, env },
  )
  if (r.error) throw new Error(`unable to inspect Git filter configuration: ${r.error.message}`)
  // v7.40 re-audit: `--local` di luar repo (cwd tanpa `.git`) exit 128 dengan
  // pesan "--local can only be used inside a git repository". Itu berarti TAK
  // ADA `.git/config` → mustahil ada repo-local filter → aman return [].
  // Error lain (IO/parse) TETAP fail-closed dilempar.
  if (
    r.status === 128 &&
    /--local can only be used inside a git repository|not a git repository/i.test(
      String(r.stderr ?? ""),
    )
  ) {
    return []
  }
  if (r.status !== 0 && !(r.status === 1 && !r.stdout?.trim())) {
    throw new Error(`unable to inspect Git filter configuration (git exited ${String(r.status)})`)
  }
  const lines: string[] = []
  if (r.stdout?.trim()) lines.push(...r.stdout.split("\n"))
  // Periksa juga `--worktree` (best-effort bila extensions.worktreeConfig aktif):
  // repo dengan worktree config dapat menaruh driver filter di config.worktree.
  const wt = spawnSync(
    gitBin,
    [
      "config",
      "--worktree",
      "--includes",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process)$",
    ],
    { cwd, encoding: "utf8", timeout: 10_000, env },
  )
  if (wt.status === 0 && wt.stdout?.trim()) {
    lines.push(...wt.stdout.split("\n"))
  }
  if (lines.length === 0) return []
  const drivers = new Map<string, FilterDriver>()
  for (const line of lines) {
    const key = line.trim()
    if (!key) continue
    const m = DRIVER_RE.exec(key)
    if (!m?.[1] || !m[2]) {
      throw new Error("unable to safely parse Git filter configuration")
    }
    const d = drivers.get(m[1]) ?? { name: m[1], hasProcess: false }
    if (m[2].toLowerCase() === "process") d.hasProcess = true
    drivers.set(m[1], d)
  }
  return [...drivers.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
}

export async function discoverFilterDrivers(cwd: string): Promise<FilterDriver[]> {
  return discoverFilterDriversSync(cwd)
}

export function gitFilterNeutralizersSync(cwd: string): string[] {
  const drivers = discoverFilterDriversSync(cwd)
  const out: string[] = []
  for (const d of drivers) {
    out.push("-c", `filter.${d.name}.clean=cat`, "-c", `filter.${d.name}.smudge=cat`)
    // Protokol process DIUTAMAKAN git di atas clean/smudge: tanpa override
    // ini, `git add` tetap mengeksekusi filter process repo meski clean=cat
    // (terbukti via probe diagnostik: marker process jalan, clean tidak).
    // Nilai kosong diperlakukan sebagai unset → fallback ke clean/smudge
    // (cat di jalur plumbing; milik pengguna di jalur user-index) — tanpa
    // noise error dan tanpa merusak driver clean/smudge yang sah (LFS).
    if (d.hasProcess) out.push("-c", `filter.${d.name}.process=`)
  }
  return out
}

/**
 * Bangun override `-c filter.<d>.clean=cat -c filter.<d>.smudge=cat` untuk
 * semua driver clean/smudge yang TERKONFIGURASI. `cat` = identitas byte
 * (snapshot/restore tetap konsisten) tanpa mengeksekusi perintah repo.
 * Discovery via `git config` (plumbing baca murni: tanpa hook/filter/pager).
 */
export async function gitFilterNeutralizers(cwd: string): Promise<string[]> {
  return gitFilterNeutralizersSync(cwd)
}
