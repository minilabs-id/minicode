// Notifier update — cek versi registry, cache 24 jam, tampil sekali; fire-and-forget 2 dtk.
// Diam saat offline/gagal fetch; hormati NO_UPDATE_CHECK=1 / CI=1.
// Runner bun mengumpulkan stderr/error/timedOut per langkah; detail wajib lewat
// formatUpdateError (satu baris, diredaksi) agar E401/EACCES/timeout tidak generik.

import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
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
 * Batas mati per perintah bun (update -g, add -g, pm ls -g).
 * 60 dtk cukup untuk registry lambat/korporat di Windows, jauh di bawah 3×120 dtk
 * yang membekukan TUI; timeout kini DILAPORKAN, bukan dibungkam.
 */
const BUN_SPAWN_TIMEOUT_MS = 60_000
/** Tail stderr yang disimpan runner — cukup untuk E401/EACCES tanpa membocorkan log penuh. */
const STDERR_TAIL_CHARS = 400
/** formatUpdateError selalu memotong sampai sepanjang ini (termasuk elipsis). */
const MAX_ERROR_LINE = 300

interface Cache {
  checkedAt: number
  latest: string
}

/** Hasil satu perintah bun. Field baru opsional agar runner lama tetap kompatibel. */
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
function clearLastUpdateFailure(): void {
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
  if (isUpdateOptedOut()) return true
  // Jangan ganggu JSONL pipeline
  if (process.argv.includes("--json") || process.argv.includes("--output-format")) return true
  return false
}

/** Opt-out yang dipakai runManualUpdate (/update) — sama dengan gate auto-update. */
function isUpdateOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_UPDATE_CHECK === "1") return true
  if (env.CI === "1") return true
  const off = (env.MINICODE_AUTO_UPDATE ?? "").trim().toLowerCase()
  return off === "0" || off === "false" || off === "off"
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  pre: string[]
}

function parseSemver(v: string): ParsedSemver {
  const withoutBuild = v.split("+", 1)[0] ?? ""
  const dash = withoutBuild.indexOf("-")
  const coreStr = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const preStr = dash === -1 ? "" : withoutBuild.slice(dash + 1)
  const parts = coreStr.split(".").map((x) => Number(x) || 0)
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    pre: preStr ? preStr.split(".") : [],
  }
}

function semverLt(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa.major !== pb.major) return pa.major < pb.major
  if (pa.minor !== pb.minor) return pa.minor < pb.minor
  if (pa.patch !== pb.patch) return pa.patch < pb.patch
  // SemVer 2.0.0 §11.3: rilis stabil tanpa pre-release selalu lebih tinggi dari pre-release
  if (pa.pre.length === 0 && pb.pre.length === 0) return false
  if (pa.pre.length === 0) return false
  if (pb.pre.length === 0) return true
  const len = Math.min(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const sa = pa.pre[i] ?? ""
    const sb = pb.pre[i] ?? ""
    if (sa === sb) continue
    const numA = /^\d+$/.test(sa)
    const numB = /^\d+$/.test(sb)
    if (numA && numB) return Number(sa) < Number(sb)
    // Identifier numerik selalu lebih rendah daripada non-numerik
    if (numA !== numB) return numA
    return sa < sb
  }
  return pa.pre.length < pb.pre.length
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
  let tmp: string | undefined
  try {
    const { mkdir, writeFile, chmod, rename, unlink } = await import("node:fs/promises")
    const target = cacheFilePath()
    await mkdir(dirname(target), { recursive: true })
    tmp = `${target}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify({ checkedAt: Date.now(), latest }), "utf8")
    // 0600 seperti trace/journal (bug-hunt 2026-09-19 H6): default umask bisa
    // world-readable. Isi kini non-rahasia, tapi konsistensi murah.
    await chmod(tmp, 0o600).catch(() => {})
    try {
      await rename(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
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

export type InstallSource = "npm-global" | "bun-global" | "source-checkout"

export function formatUpdateMessage(
  current: string,
  latest: string,
  _source: InstallSource = classifyInstallSource(),
): string {
  // Pakai `--latest` agar range caret `^0.x.y` di bun global package.json ikut naik;
  // npm tidak lagi dipakai di jalur instalasi maupun pembaruan.
  return `Update tersedia ${current} → ${latest} — jalankan: bun update -g ${PKG_NAME} --latest`
}

// ── Auto-update interaktif ──
// REPL TTY dari salinan ter-install: cek versi, update via bun, restart argv yang sama.
// Gagal = lanjut versi lama + pesan manual bun update.

/** Guard env anti-loop restart: di-set saat respawn pasca-update. */
export const UPDATE_GUARD_ENV = "MINICODE_AUTO_UPDATE_DONE"

function findNodeModulesPkgRoot(entry: string): string | null {
  if (!entry) return null
  const norm = entry.replace(/\\/g, "/")
  const marker = "/node_modules/"
  const idx = norm.lastIndexOf(marker)
  let afterStart = -1
  if (idx >= 0) {
    afterStart = idx + marker.length
  } else if (norm.startsWith("node_modules/")) {
    afterStart = "node_modules/".length
  }
  if (afterStart < 0) return null
  let pos = afterStart
  while (norm[pos] === "/") pos++
  if (pos >= norm.length) return null
  const firstEnd = norm.indexOf("/", pos)
  if (firstEnd < 0) return entry
  if (norm[pos] === "@") {
    let secondStart = firstEnd
    while (norm[secondStart] === "/") secondStart++
    const secondEnd = norm.indexOf("/", secondStart)
    return secondEnd < 0 ? entry : entry.slice(0, secondEnd)
  }
  return entry.slice(0, firstEnd)
}

/**
 * Klasifikasikan asal instalasi biner/skrip agar auto-update & `/update` tidak
 * menyentuh checkout dev (`bun link` / git repo) dan tidak menjalankan `npm -g`
 * ke prefix yang salah saat terpasang via `bun add -g`.
 */
export function classifyInstallSource(
  entry = process.argv[1] ?? "",
  opts: {
    env?: NodeJS.ProcessEnv
    realpath?: (p: string) => string
    exists?: (p: string) => boolean
  } = {},
): InstallSource {
  const pkgRoot = findNodeModulesPkgRoot(entry)
  if (!pkgRoot) return "source-checkout"
  const realpath = opts.realpath ?? realpathSync
  const exists = opts.exists ?? existsSync
  let resolvedRoot = pkgRoot
  try {
    resolvedRoot = realpath(pkgRoot)
  } catch {
    // Path virtual (unit test) atau symlink rusak: evaluasi berdasarkan string path mentah.
  }
  const normPkg = pkgRoot.replace(/\\/g, "/").toLowerCase()
  const normReal = resolvedRoot.replace(/\\/g, "/").toLowerCase()
  // Symlink/junction (`bun link` / `npm link`) ke luar `node_modules` atau ke repo `.git`:
  // perlakukan sebagai checkout sumber agar updater tidak menimpa/mematikan dev workspace.
  if (!normReal.includes("/node_modules/") && !normReal.startsWith("node_modules/")) {
    return "source-checkout"
  }
  try {
    if (exists(join(resolvedRoot, ".git"))) return "source-checkout"
  } catch {}
  const env = opts.env ?? process.env
  const bunGlobalMarkers = ["/.bun/install/global/"]
  const bunInstall = env.BUN_INSTALL?.trim()
  if (bunInstall) {
    bunGlobalMarkers.push(
      `${bunInstall.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}/install/global/`,
    )
  }
  if (bunGlobalMarkers.some((m) => normPkg.includes(m) || normReal.includes(m))) {
    return "bun-global"
  }
  return "npm-global"
}

/** True bila kode berjalan dari salinan ter-install (bukan checkout source). */
export function isInstalledCopy(entry = process.argv[1] ?? ""): boolean {
  return classifyInstallSource(entry) !== "source-checkout"
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
 * - salinan ter-install via npm global maupun Bun global (checkout source / dev link dilewati fail-closed)
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
    installSource?: InstallSource
  } = {},
): AutoUpdateDecision {
  const env = opts.env ?? process.env
  if (env.NO_UPDATE_CHECK === "1") return { run: false, reason: "no-update-check" }
  if (env.CI === "1") return { run: false, reason: "ci" }
  const off = (env.MINICODE_AUTO_UPDATE ?? "").trim().toLowerCase()
  if (off === "0" || off === "false" || off === "off") return { run: false, reason: "opt-out" }
  if (env[UPDATE_GUARD_ENV] != null) return { run: false, reason: "already-restarted" }
  if (!(opts.stdinTTY ?? process.stdin.isTTY)) return { run: false, reason: "non-tty" }
  if (opts.installed !== undefined) {
    if (!opts.installed) return { run: false, reason: "source-checkout" }
  } else {
    const source = opts.installSource ?? classifyInstallSource(undefined, { env })
    if (source === "source-checkout") return { run: false, reason: "source-checkout" }
    if (source === "bun-global" || source === "npm-global") return { run: true }
  }
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
  if (signal?.aborted) return null
  const latest = await fetchLatest(signal)
  if (signal?.aborted) return null
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

export function verifyInstalledVersion(expected: string, readVersion: () => string): boolean {
  try {
    return readVersion() === expected
  } catch {
    return false
  }
}

// ── Resolusi executable Bun ──
// Jalankan `bun` langsung (tanpa shell) agar update kebal injeksi dan bebas npm.

function resolveBunExecutable(): string {
  const base = basename(process.execPath).toLowerCase()
  if (
    isAbsolute(process.execPath) &&
    (base === "bun" || base === "bun.exe") &&
    existsSync(process.execPath)
  ) {
    return process.execPath
  }
  const trustedBun = resolveTrustedExecutable("bun")
  if (!isAbsolute(trustedBun)) {
    throw new Error("trusted bun executable not found on PATH")
  }
  return trustedBun
}

function tailText(s: string, max = STDERR_TAIL_CHARS): string {
  const clean = String(s ?? "").replace(/\r/g, "")
  return clean.length > max ? clean.slice(clean.length - max) : clean
}

function defaultBunRunner(): InstallRunner {
  return (cmd, args, opts) => {
    let bunBin: string
    try {
      bunBin = cmd === "bun" ? resolveBunExecutable() : resolveTrustedExecutable(cmd)
    } catch (err) {
      return { status: null, error: errorMessage(err), command: [cmd, ...args].join(" ") }
    }
    if (!isAbsolute(bunBin)) {
      return {
        status: null,
        error: `trusted ${cmd} executable not found on PATH`,
        command: [cmd, ...args].join(" "),
      }
    }
    const runArgs = [...args]
    const command = [bunBin, ...runArgs].join(" ")
    // Isolasi total: jangan pernah pakai cwd repo yang tak tepercaya (agar
    // `<repo>/bunfig.toml` dan skrip lokal tak memengaruhi proses update global).
    const safeEnv = sanitizeSpawnEnv(process.env)
    try {
      const r: SpawnSyncReturns<string> = spawnSync(bunBin, runArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        timeout: BUN_SPAWN_TIMEOUT_MS,
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
// stderr bun = input tak terpercaya (token registry, URL berkredensial, ANSI).
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
 *   bun update -g (exit 1): E401 token [redacted-token] — periksa konfigurasi
 */
export function formatUpdateError(step: string, r: InstallResult): string {
  const status = r.timedOut
    ? "timeout"
    : typeof r.status === "number"
      ? `exit ${r.status}`
      : "exit ?"
  const parts = [r.error?.trim(), r.stderr?.trim()].filter((s): s is string => !!s)
  let reason = redactUpdateText(parts.join(" — "))
  if (!reason) reason = r.timedOut ? "perintah melewati batas waktu" : "bun tidak memberi detail"
  const line = `${step} (${status}): ${reason}`
  return line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE - 1)}…` : line
}

function recordFailure(step: string, r: InstallResult): false {
  lastFailure = { step, result: r }
  return false
}

export function parseBunGlobalLsVersion(stdout: string, pkgName = PKG_NAME): string {
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.lastIndexOf(`${pkgName}@`)
    if (idx < 0) continue
    const before = idx === 0 ? "" : line[idx - 1]!
    if (before && !/[\s─│├└|`-]/.test(before)) continue
    const ver =
      line
        .slice(idx + pkgName.length + 1)
        .trim()
        .split(/\s+/)[0] ?? ""
    if (ver && SEMVER_VERSION_RE.test(ver)) return ver
  }
  return "0.0.0"
}

/**
 * Versi dibaca dari instalasi global Bun (`bun pm ls -g`), bukan package.json modul:
 * `import.meta.dir` bisa menunjuk modul proses lama sehingga versi lama terbaca.
 * Fail-closed: gagal baca → "0.0.0" (verifikasi gagal, rollback aman).
 */
export function readGlobalInstalledVersion(runner?: InstallRunner): string {
  try {
    const run = runner ?? defaultBunRunner()
    const res = run("bun", ["pm", "ls", "-g"])
    if (res.status !== 0 || !res.stdout) return "0.0.0"
    const firstLine =
      res.stdout
        .trim()
        .split(/\r?\n/)
        .find((l) => l.trim()) ?? ""
    const globalRoot = firstLine.replace(/\s+node_modules(?:\s+\([^)]*\))?\s*$/, "").trim()
    if (globalRoot) {
      const cleanRoot = globalRoot.replace(/[\\/]+$/, "")
      const pkgPath =
        cleanRoot.endsWith("/node_modules") || cleanRoot.endsWith("\\node_modules")
          ? join(cleanRoot, PKG_NAME, "package.json")
          : join(cleanRoot, "node_modules", PKG_NAME, "package.json")
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }
        if (typeof pkg.version === "string" && SEMVER_VERSION_RE.test(pkg.version)) {
          return pkg.version
        }
      }
    }
    return parseBunGlobalLsVersion(res.stdout)
  } catch {
    return "0.0.0"
  }
}

const SEMVER_VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export interface InstallUpdateOptions {
  /** Saat rollback versi lama pasca gagal verifikasi, pin versi eksak via `bun add -g pkg@version --exact`. */
  exact?: boolean
}

/**
 * Perbarui atau pasang paket secara global melalui Bun (`--ignore-scripts`).
 * Jalur normal selalu menjalankan `bun update -g minicode-ai --latest`, dengan
 * fallback ke `bun add -g minicode-ai@latest` bila paket belum ada di `bun.lock`
 * global. Tiap kegagalan dicatat di `lastFailure` (step + detail teredaksi).
 */
export function installUpdate(
  version: string,
  runner?: InstallRunner,
  opts?: InstallUpdateOptions,
): boolean {
  lastFailure = null
  if (version.length > 128 || !SEMVER_VERSION_RE.test(version))
    return recordFailure("validasi versi", { status: null, error: "versi target tidak valid" })
  try {
    const run = runner ?? defaultBunRunner()
    if (opts?.exact) {
      const exactRes = run("bun", [
        "add",
        "-g",
        `${PKG_NAME}@${version}`,
        "--ignore-scripts",
        "--exact",
      ])
      if (exactRes.status !== 0) return recordFailure("bun add -g", exactRes)
      return true
    }
    // `defaultBunRunner()` menjatuhkan `opts?.cwd` kosong ke `tmpdir()` agar
    // bunfig.toml repo tak pernah terbaca dan kontrak runner inject tetap terjaga.
    const updateRes = run("bun", ["update", "-g", PKG_NAME, "--latest", "--ignore-scripts"])
    if (updateRes.status === 0) return true
    const updateDetail = `${updateRes.stderr ?? ""}\n${updateRes.error ?? ""}`
    if (/not in bun\.lock/i.test(updateDetail)) {
      const addRes = run("bun", ["add", "-g", `${PKG_NAME}@latest`, "--ignore-scripts"])
      if (addRes.status !== 0) return recordFailure("bun add -g", addRes)
      return true
    }
    return recordFailure("bun update -g", updateRes)
  } catch (err) {
    return recordFailure("bun update -g", { status: null, error: errorMessage(err) })
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
  aborted?: boolean
}

async function notifyPhase(
  opts: {
    onPhase?: (phase: "check" | "install" | "verify", latest?: string) => unknown
  },
  phase: "check" | "install" | "verify",
  latest?: string,
): Promise<void> {
  try {
    await opts.onPhase?.(phase, latest)
  } catch {}
}

export async function runManualUpdate(
  opts: {
    onPhase?: (phase: "check" | "install" | "verify", latest?: string) => unknown
    check?: (signal?: AbortSignal) => Promise<string | null>
    install?: (version: string) => boolean
    getInstalled?: () => string
    installSource?: InstallSource
    signal?: AbortSignal
  } = {},
): Promise<ManualUpdateResult> {
  if (isUpdateOptedOut()) return { ok: false, optedOut: true }
  if (opts.signal?.aborted) return { ok: false, aborted: true, step: "check" }
  clearLastUpdateFailure()
  // Saat test menyuntikkan `install`, izinkan alur tanpa salinan global kecuali
  // `installSource` diisi eksplisit untuk menguji penolakan preflight.
  const source = opts.installSource ?? (opts.install ? "bun-global" : classifyInstallSource())
  if (source === "source-checkout") {
    return {
      ok: false,
      step: "preflight",
      reason: "dijalankan dari source checkout / dev link; update langsung lewat git pull",
    }
  }
  await notifyPhase(opts, "check")
  if (opts.signal?.aborted) return { ok: false, aborted: true, step: "check" }
  let latest: string | null
  try {
    latest = opts.check
      ? await opts.check(opts.signal)
      : await checkForUpdateFresh(readCurrentVersion(), opts.signal)
  } catch (err) {
    if (opts.signal?.aborted || (err as { name?: string })?.name === "AbortError") {
      return { ok: false, aborted: true, step: "check" }
    }
    return {
      ok: false,
      step: "check",
      reason: formatUpdateError("check", { status: null, error: errorMessage(err) }),
    }
  }
  if (opts.signal?.aborted) return { ok: false, aborted: true, step: "check" }
  if (!latest) return { ok: true, alreadyLatest: true }

  await notifyPhase(opts, "install", latest)
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
      step: "bun update -g",
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

  await notifyPhase(opts, "verify", latest)
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

/**
 * Saat instalasi lama berasal dari npm global lalu baru diperbarui lewat Bun,
 * arahkan target respawn ke salinan Bun global yang baru bila sudah tersedia.
 */
export function resolveUpdatedEntry(entry = process.argv[1] ?? ""): string {
  if (!entry) return entry
  if (classifyInstallSource(entry) !== "npm-global") return entry
  const base = process.env.BUN_INSTALL?.trim() || join(homeDir(), ".bun")
  const bunEntry = join(base, "install", "global", "node_modules", PKG_NAME, "cli", "minicode.js")
  return existsSync(bunEntry) ? bunEntry : entry
}
