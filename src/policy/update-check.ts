// Notifier update — cek versi npm, cache 24 jam, tampil sekali; fire-and-forget 2 dtk.
// Diam saat offline/gagal fetch; hormati NO_UPDATE_CHECK=1 / CI=1.
// Runner npm mengumpulkan stderr/error/timedOut per langkah; detail wajib lewat
// formatUpdateError (satu baris, diredaksi) agar E401/EACCES/timeout tidak generik.

import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { homeDir } from "../lib/db-path.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv } from "./scrub.ts"

const PKG_NAME = "minicode-ai"
function cacheFilePath(): string {
  return join(homeDir(), ".minicode", "update-check.json")
}
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2000
/**
 * Batas mati per perintah npm (root -g, install temp, audit signatures, install -g).
 * 60 dtk cukup untuk registry lambat/korporat di Windows, jauh di bawah 3×120 dtk
 * yang membekukan TUI; timeout kini DILAPORKAN, bukan dibungkam.
 */
const NPM_SPAWN_TIMEOUT_MS = 60_000
/** Tail stderr yang disimpan runner — cukup untuk E401/EACCES tanpa membocorkan log penuh. */
const STDERR_TAIL_CHARS = 400
/** formatUpdateError selalu memotong sampai sepanjang ini (termasuk elipsis). */
const MAX_ERROR_LINE = 300

interface Cache {
  checkedAt: number
  latest: string
}

/** Hasil satu perintah npm. Field baru opsional agar runner lama tetap kompatibel. */
export interface InstallResult {
  status: number | null
  stdout?: string
  stderr?: string
  error?: string
  timedOut?: boolean
  command?: string
}

export type InstallRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => InstallResult

/** Detail kegagalan langkah terakhir — diisi installUpdate, dibaca pemanggil. */
export interface UpdateFailure {
  step: string
  result: InstallResult
}

let lastFailure: UpdateFailure | null = null

export function getLastUpdateFailure(): UpdateFailure | null {
  return lastFailure
}

/** Bersihkan state sebelum alur manual dengan runner injection (tanpa installUpdate). */
export function clearLastUpdateFailure(): void {
  lastFailure = null
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

function shouldSkip(): boolean {
  if (process.env.NO_UPDATE_CHECK === "1") return true
  if (process.env.CI === "1") return true
  // Jangan ganggu JSONL pipeline
  if (process.argv.includes("--json") || process.argv.includes("--output-format")) return true
  return false
}

/** Opt-out yang dipakai runManualUpdate (/update) — sama dengan gate auto-update. */
export function isUpdateOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_UPDATE_CHECK === "1") return true
  if (env.CI === "1") return true
  const off = (env.MINICODE_AUTO_UPDATE ?? "").trim().toLowerCase()
  return off === "0" || off === "false" || off === "off"
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number(x) || 0)
  const pb = b.split(".").map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false
  }
  return false
}

async function readCache(): Promise<Cache | null> {
  try {
    // Lazy import — hindari top-level `node:fs/promises` bareng `bun:sqlite`
    // yang di Bun Windows nge-trigger `kWriteMonkeyPatchDefense` (lihat 0.9.7).
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(cacheFilePath(), "utf8")
    const j = JSON.parse(raw) as Cache
    if (typeof j.checkedAt === "number" && typeof j.latest === "string") return j
  } catch {}
  return null
}

async function writeCache(latest: string): Promise<void> {
  try {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises")
    const target = cacheFilePath()
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({ checkedAt: Date.now(), latest }), "utf8")
    // 0600 seperti trace/journal (bug-hunt 2026-09-19 H6): default umask bisa
    // world-readable. Isi kini non-rahasia, tapi konsistensi murah.
    await chmod(target, 0o600).catch(() => {})
  } catch {}
}

async function fetchLatest(signal?: AbortSignal): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const sig = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/latest`, {
        signal: sig,
        headers: { accept: "application/json" },
      })
      clearTimeout(t)
      if (!res.ok) return null
      const j = (await res.json()) as { version?: string }
      return typeof j.version === "string" ? j.version : null
    } finally {
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
    }
  } catch {
    return null
  }
}

export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  if (shouldSkip()) return null
  const cached = await readCache()
  let latest: string | null = null
  if (cached && Date.now() - cached.checkedAt < TTL_MS) {
    latest = cached.latest
  } else {
    latest = await fetchLatest()
    if (latest) await writeCache(latest)
    else if (cached) latest = cached.latest // offline: pakai cache lama
  }
  if (!latest) return null
  if (semverLt(currentVersion, latest)) return latest
  return null
}

export function formatUpdateMessage(current: string, latest: string): string {
  // `npm update` bisa melewati langkah verifikasi signature; selalu pasang
  // versi eksak yang sudah terverifikasi dari registry yang sama.
  return `Update tersedia ${current} → ${latest} — jalankan: npm install -g ${PKG_NAME}@${latest}`
}

// ── Auto-update interaktif ──
// REPL TTY dari salinan ter-install: cek versi, install, restart argv yang sama.
// Satu-satunya mutasi `npm install -g` paket sendiri; gagal = lanjut versi lama + pesan manual.

/** Guard env anti-loop restart: di-set saat respawn pasca-update. */
export const UPDATE_GUARD_ENV = "MINICODE_AUTO_UPDATE_DONE"

/** True bila kode berjalan dari salinan ter-install (bukan checkout source). */
export function isInstalledCopy(entry = process.argv[1] ?? ""): boolean {
  return entry.includes("node_modules")
}

export function isNewer(current: string, latest: string): boolean {
  return semverLt(current, latest)
}

export interface AutoUpdateDecision {
  run: boolean
  /** Alasan skip — untuk observability/test, bukan pesan user. */
  reason?: string
}

/**
 * Layak auto-update? Syarat SEMUA:
 * - stdin TTY (user membuka REPL, bukan pipe/CI)
 * - salinan ter-install (checkout source jangan disentuh npm)
 * - bukan mode machine (`exec`, `--json`) dan bukan `--help`/`--version`
 * - belum habis di-restart (guard env) dan tidak di-opt-out
 *   (`NO_UPDATE_CHECK=1`, `CI=1`, `MINICODE_AUTO_UPDATE=0`).
 */
export function shouldAutoUpdate(
  argv: string[] = process.argv.slice(2),
  opts: {
    stdinTTY?: boolean
    env?: NodeJS.ProcessEnv
    installed?: boolean
  } = {},
): AutoUpdateDecision {
  const env = opts.env ?? process.env
  if (env.NO_UPDATE_CHECK === "1") return { run: false, reason: "no-update-check" }
  if (env.CI === "1") return { run: false, reason: "ci" }
  const off = (env.MINICODE_AUTO_UPDATE ?? "").trim().toLowerCase()
  if (off === "0" || off === "false" || off === "off") return { run: false, reason: "opt-out" }
  if (env[UPDATE_GUARD_ENV] != null) return { run: false, reason: "already-restarted" }
  if (!(opts.stdinTTY ?? process.stdin.isTTY)) return { run: false, reason: "non-tty" }
  if (!(opts.installed ?? isInstalledCopy())) return { run: false, reason: "source-checkout" }
  if (argv.includes("--json") || argv.includes("--output-format"))
    return { run: false, reason: "machine-output" }
  if (argv.includes("-h") || argv.includes("--help") || argv.includes("-v"))
    return { run: false, reason: "help-version" }
  const first = argv.find((a) => !a.startsWith("-"))
  if (first === "exec") return { run: false, reason: "exec-mode" }
  return { run: true }
}

/**
 * Cek versi SELALU ke registry (abaikan cache 24 jam) khusus alur auto-update.
 * Offline/network-gagal = fallback cache lama; tetap tak ada = null.
 */
export async function checkForUpdateFresh(
  currentVersion: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const latest = await fetchLatest(signal)
  if (latest) await writeCache(latest)
  const eff = latest ?? (await readCache())?.latest ?? null
  if (!eff) return null
  return isNewer(currentVersion, eff) ? eff : null
}

/** Versi lokal untuk default check() — baca package.json, bukan hardcode. */
function readCurrentVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url)
    return (JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string }).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

const NPM_REGISTRY = "https://registry.npmjs.org/"

export function verifyInstalledVersion(expected: string, readVersion: () => string): boolean {
  try {
    return readVersion() === expected
  } catch {
    return false
  }
}

// ── Resolusi executable npm (Windows) ──
// `spawnSync("npm", {shell:true})` rapuh (cmd.exe, spasi di path, npm.cmd).
// Panggil npm-cli.js lewat node langsung (tanpa shell) — satu-satunya cara aman.

interface NpmExec {
  cmd: string
  prefixArgs: string[]
  shell: boolean
}

function quoteShellArg(arg: string): string {
  // Argumen kita semua konstan SemVer/flag/URL; ini hanya pengaman bila shell
  // terpaksa dipakai (npm.cmd tanpa npm-cli.js) dan ada spasi di path.
  if (/^[A-Za-z0-9_@/:=.,+~-]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

function resolveNpmExecutable(): NpmExec {
  const nodeBin = (() => {
    const resolved = resolveTrustedExecutable("node")
    return isAbsolute(resolved) ? resolved : process.execPath
  })()
  const fromEnv = process.env.npm_execpath?.trim()
  if (fromEnv && isAbsolute(fromEnv)) {
    if (/\.[cm]?js$/i.test(fromEnv) && existsSync(fromEnv))
      return { cmd: nodeBin, prefixArgs: [fromEnv], shell: false }
    if (/\.(cmd|bat)$/i.test(fromEnv)) {
      const cli = join(dirname(fromEnv), "npm-cli.js")
      if (existsSync(cli)) return { cmd: nodeBin, prefixArgs: [cli], shell: false }
      const nestedCli = join(dirname(fromEnv), "node_modules", "npm", "bin", "npm-cli.js")
      if (existsSync(nestedCli)) return { cmd: nodeBin, prefixArgs: [nestedCli], shell: false }
    } else if (existsSync(fromEnv)) {
      return { cmd: fromEnv, prefixArgs: [], shell: false }
    }
  }
  const trustedNpm = resolveTrustedExecutable("npm")
  if (process.platform === "win32") {
    const candidates = [
      join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      ...(isAbsolute(trustedNpm)
        ? [
            join(dirname(trustedNpm), "node_modules", "npm", "bin", "npm-cli.js"),
            join(dirname(trustedNpm), "npm-cli.js"),
          ]
        : []),
    ]
    for (const cli of candidates) {
      if (existsSync(cli)) return { cmd: nodeBin, prefixArgs: [cli], shell: false }
    }
    // Fail-closed: jangan pernah menjalankan `npm.cmd` telanjang lewat `shell: true`
    // di cwd yang tak tepercaya (CWD hijacking + BatBadBut).
    if (!isAbsolute(trustedNpm)) {
      throw new Error("trusted npm executable not found on PATH")
    }
    return { cmd: trustedNpm, prefixArgs: [], shell: false }
  }
  if (!isAbsolute(trustedNpm)) {
    throw new Error("trusted npm executable not found on PATH")
  }
  return { cmd: trustedNpm, prefixArgs: [], shell: false }
}

function tailText(s: string, max = STDERR_TAIL_CHARS): string {
  const clean = String(s ?? "").replace(/\r/g, "")
  return clean.length > max ? clean.slice(clean.length - max) : clean
}

function defaultNpmRunner(): InstallRunner {
  return (cmd, args, opts) => {
    let exec: NpmExec
    try {
      exec = resolveNpmExecutable()
    } catch (err) {
      return { status: null, error: errorMessage(err), command: [cmd, ...args].join(" ") }
    }
    // runner yang di-inject menerima "npm" — jangan ubah argumen yang mereka lihat.
    // Mapping ke executable asli terjadi HANYA di sini.
    const runCmd = cmd === "npm" ? exec.cmd : resolveTrustedExecutable(cmd)
    const runArgs = cmd === "npm" ? [...exec.prefixArgs, ...args] : [...args]
    const command = [runCmd, ...runArgs].join(" ")
    const spawnArgs = exec.shell && cmd === "npm" ? runArgs.map(quoteShellArg) : runArgs
    // Isolasi total: jangan pernah pakai cwd repo yang tak tepercaya (agar
    // `<repo>/.npmrc` dan biner lokal tak pernah dieksekusi), strip secret env,
    // dan netralkan userconfig npm yang bisa menyusup lewat env.
    const safeEnv: NodeJS.ProcessEnv = {
      ...sanitizeSpawnEnv(process.env),
      npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
    }
    try {
      const r: SpawnSyncReturns<string> = spawnSync(runCmd, spawnArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: exec.shell && cmd === "npm",
        timeout: NPM_SPAWN_TIMEOUT_MS,
        cwd: opts?.cwd ?? tmpdir(),
        env: safeEnv,
      })
      const timedOut = !!(r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
      return {
        status: typeof r.status === "number" ? r.status : null,
        stdout: String(r.stdout ?? ""),
        stderr: tailText(String(r.stderr ?? "")),
        ...(r.error ? { error: r.error.message } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        command,
      }
    } catch (err) {
      return { status: null, error: errorMessage(err), command }
    }
  }
}

// ── Redaksi pesan error ──
// stderr npm = input tak terpercaya (token .npmrc, URL berkredensial, ANSI).
// formatUpdateError satu-satunya gerbang — jangan pernah tampilkan stderr mentah.

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip DCS/APC/PM/SOS & C0/C1 kontrol
const ANSI_STR_SEQ_RE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: pola CSI memang memakai ESC
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: pola ESC tunggal
const ANSI_SINGLE_RE = /\x1b[@-_]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 non-whitespace + DEL + C1 kontrol
const CTRL_C0_C1_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const BIDI_CTRL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const CREDENTIAL_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*:[^\s"'<>]*@[^\s"'<>]*/gi
const BARE_CREDENTIAL_RE = /\b[^\s:/@]+:[^\s/@]+@[^\s]+/g
const BEARER_RE = /\bBearer\s+[^\s,;]+/gi
const NPM_TOKEN_RE = /\bnpm_[A-Za-z0-9_-]{8,}/g
const SECRET_KV_RE =
  /\b(_auth(?:Token)?|password|passwd|pwd|authorization|token|api[_-]?key|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi

function redactUpdateText(input: string): string {
  return input
    .replace(ANSI_STR_SEQ_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_SINGLE_RE, "")
    .replace(CTRL_C0_C1_RE, "")
    .replace(BIDI_CTRL_RE, "")
    .replace(CREDENTIAL_URL_RE, "[redacted-url]")
    .replace(BARE_CREDENTIAL_RE, "[redacted]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(NPM_TOKEN_RE, "[redacted-token]")
    .replace(SECRET_KV_RE, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/**
 * Satu baris, ≤300 char, aman ditampilkan. Contoh:
 *   npm audit signatures (exit 1): E401 token [redacted-token] — periksa .npmrc
 */
export function formatUpdateError(step: string, r: InstallResult): string {
  const status = r.timedOut
    ? "timeout"
    : typeof r.status === "number"
      ? `exit ${r.status}`
      : "exit ?"
  const parts = [r.error?.trim(), r.stderr?.trim()].filter((s): s is string => !!s)
  let reason = redactUpdateText(parts.join(" — "))
  if (!reason) reason = r.timedOut ? "perintah melewati batas waktu" : "npm tidak memberi detail"
  const line = `${step} (${status}): ${reason}`
  return line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE - 1)}…` : line
}

function recordFailure(step: string, r: InstallResult): false {
  lastFailure = { step, result: r }
  return false
}

/**
 * Versi dibaca dari PREFIX GLOBAL npm (`npm root -g`), bukan package.json modul:
 * `import.meta.dir` bisa menunjuk cache/transpilasi sehingga versi lama terbaca.
 * Fail-closed: gagal baca → "0.0.0" (verifikasi gagal, rollback aman).
 */
export function readGlobalInstalledVersion(runner?: InstallRunner): string {
  try {
    const run = runner ?? defaultNpmRunner()
    const res = run("npm", ["root", "-g"])
    if (res.status !== 0 || !res.stdout) return "0.0.0"
    const root = res.stdout.trim().split(/\r?\n/).pop() ?? ""
    if (!root) return "0.0.0"
    const pkg = JSON.parse(readFileSync(join(root, PKG_NAME, "package.json"), "utf8")) as {
      version?: string
    }
    return pkg.version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

const SEMVER_VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/**
 * Verifikasi registry (signature + provenance) di prefix sementara lalu pasang versi
 * persis secara global; skrip paket tidak dijalankan. Npm lama/tanpa bukti tepercaya
 * = fail-closed. Tiap kegagalan dicatat di `lastFailure` (step + detail teredaksi).
 */
export function installUpdate(version: string, runner?: InstallRunner): boolean {
  lastFailure = null
  if (version.length > 128 || !SEMVER_VERSION_RE.test(version))
    return recordFailure("validasi versi", { status: null, error: "versi target tidak valid" })
  let verifyRoot: string | undefined
  try {
    const run = runner ?? defaultNpmRunner()
    verifyRoot = mkdtempSync(join(tmpdir(), "minicode-update-verify-"))
    writeFileSync(
      join(verifyRoot, "package.json"),
      JSON.stringify({ name: "minicode-update-verification", version: "1.0.0", private: true }),
      "utf8",
    )
    const verifiedInstall = run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--save-exact",
        "--package-lock=true",
        // checkForUpdateFresh() membaca packument via HTTP langsung (selalu
        // fresh), tapi `npm install` memakai packument cache lokal yang bisa
        // basi — itulah sebabnya versi baru terdeteksi lalu ETARGET saat install.
        // Paksa npm merevalidasi metadata registry sebelum resolusi versi.
        "--prefer-online",
        "--registry",
        NPM_REGISTRY,
        `${PKG_NAME}@${version}`,
      ],
      { cwd: verifyRoot },
    )
    if (verifiedInstall.status !== 0) return recordFailure("npm install", verifiedInstall)
    let lock: { packages?: Record<string, unknown> }
    try {
      lock = JSON.parse(readFileSync(join(verifyRoot, "package-lock.json"), "utf8")) as {
        packages?: Record<string, unknown>
      }
    } catch (err) {
      return recordFailure("npm install", {
        status: verifiedInstall.status,
        error: `package-lock tidak terbaca: ${errorMessage(err)}`,
      })
    }
    const installedPackages = Object.keys(lock.packages ?? {}).filter((path) =>
      path.startsWith("node_modules/"),
    )
    // Install global tidak memakai lockfile lokal. CLI kini tanpa dependensi runtime;
    // tolak drift graf dependensi diam-diam sampai updater bisa memasang & memverifikasi semua lock.
    if (installedPackages.length !== 1 || installedPackages[0] !== `node_modules/${PKG_NAME}`)
      return recordFailure("npm install", {
        status: verifiedInstall.status,
        error: "graf dependensi tak terduga di package-lock",
      })
    const signatures = run("npm", ["audit", "signatures", "--registry", NPM_REGISTRY], {
      cwd: verifyRoot,
    })
    if (signatures.status !== 0) return recordFailure("npm audit signatures", signatures)
    // Fail-closed: signature gagal = install gagal. TIDAK ADA fallback npm update.
    // `defaultNpmRunner()` selalu menjatuhkan `opts?.cwd` yang kosong ke `tmpdir()`
    // (bukan cwd workspace), sehingga `.npmrc` repo tak pernah dibaca dan kontrak
    // runner inject (opts?.cwd absent untuk install -g) tetap terjaga.
    const globalInstall = run("npm", [
      "install",
      "-g",
      "--ignore-scripts",
      // Sama seperti verifikasi: revalidasi packument agar versi yang baru
      // saja terbit tidak kena ETARGET dari cache npm lokal yang basi.
      "--prefer-online",
      "--registry",
      NPM_REGISTRY,
      `${PKG_NAME}@${version}`,
    ])
    if (globalInstall.status !== 0) return recordFailure("npm install -g", globalInstall)
    return true
  } catch (err) {
    return recordFailure("npm install", { status: null, error: errorMessage(err) })
  } finally {
    if (verifyRoot && existsSync(verifyRoot)) {
      try {
        rmSync(verifyRoot, { recursive: true, force: true })
      } catch {}
    }
  }
}

// ── API manual untuk /update ──
// Beda dengan maybeAutoUpdate: TIDAK restart, TIDAK process.exit. Pemanggil
// (TUI) yang memutuskan kapan keluar/mulai ulang setelah menerima hasil ini.

export interface ManualUpdateResult {
  ok: boolean
  latest?: string
  step?: string
  reason?: string
  optedOut?: boolean
  alreadyLatest?: boolean
}

function notifyPhase(
  opts: { onPhase?: (phase: "check" | "install" | "verify") => void },
  phase: "check" | "install" | "verify",
): void {
  try {
    opts.onPhase?.(phase)
  } catch {}
}

export async function runManualUpdate(
  opts: {
    onPhase?: (phase: "check" | "install" | "verify") => void
    check?: () => Promise<string | null>
    install?: (version: string) => boolean
    getInstalled?: () => string
  } = {},
): Promise<ManualUpdateResult> {
  if (isUpdateOptedOut()) return { ok: false, optedOut: true }
  clearLastUpdateFailure()
  notifyPhase(opts, "check")
  let latest: string | null
  try {
    latest = opts.check ? await opts.check() : await checkForUpdateFresh(readCurrentVersion())
  } catch (err) {
    return {
      ok: false,
      step: "check",
      reason: formatUpdateError("check", { status: null, error: errorMessage(err) }),
    }
  }
  if (!latest) return { ok: true, alreadyLatest: true }

  notifyPhase(opts, "install")
  let installed = false
  let thrown: unknown
  try {
    installed = opts.install ? opts.install(latest) : installUpdate(latest)
  } catch (err) {
    thrown = err
    installed = false
  }
  if (!installed) {
    const failure: UpdateFailure = getLastUpdateFailure() ?? {
      step: "npm install",
      result: {
        status: null,
        error: thrown ? errorMessage(thrown) : "instalasi gagal tanpa detail",
      },
    }
    return {
      ok: false,
      step: failure.step,
      reason: formatUpdateError(failure.step, failure.result),
    }
  }

  notifyPhase(opts, "verify")
  try {
    const current = opts.getInstalled ? opts.getInstalled() : readGlobalInstalledVersion()
    if (current !== latest) {
      return {
        ok: false,
        step: "verify",
        reason: formatUpdateError("verify", {
          status: null,
          error: `versi terpasang ${current} tidak cocok dengan target ${latest}`,
        }),
      }
    }
  } catch (err) {
    return {
      ok: false,
      step: "verify",
      reason: formatUpdateError("verify", { status: null, error: errorMessage(err) }),
    }
  }
  return { ok: true, latest }
}
