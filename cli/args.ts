// Pure arg-parsing helpers - dipisah dari cli/index.ts agar mudah diuji.
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"

export type CliFlagKind = "boolean" | "value" | "meta"

export interface CliFlagSpec {
  readonly kind: CliFlagKind
}

// Tabel deklaratif tunggal seluruh flag CLI yang dikenal parser — BOOLEAN_FLAGS,
// VALUE_FLAGS, dan KNOWN_FLAGS diturunkan darinya agar tidak menyimpang.
const CLI_FLAG_SPECS: Readonly<Record<string, CliFlagSpec>> = {
  // ── Flag meta ─────────────────────────────────────────────────────────────
  "-h": { kind: "meta" },
  "--help": { kind: "meta" },
  "-v": { kind: "meta" },
  "--version": { kind: "meta" },

  // ── Flag boolean ──────────────────────────────────────────────────────────
  "--verbose": { kind: "boolean" },
  "--allow-all": { kind: "boolean" },
  "-y": { kind: "boolean" }, // alias ringkas untuk --allow-all
  "--ask": { kind: "boolean" },
  "--interactive": { kind: "boolean" },
  "--tui": { kind: "boolean" }, // alias usang: TUI fullscreen kini satu-satunya tampilan interaktif
  "--verify": { kind: "boolean" },
  "--allowlist": { kind: "boolean" },
  "--json": { kind: "boolean" }, // dipakai `exec --json` dan `--help --json`
  "--budget-strict": { kind: "boolean" }, // penegasan eksplisit fail-closed (kini juga default --budget)
  "--allow-local-config": { kind: "boolean" }, // opt-in: baca .minicode/config.json + allowlist lokal (default mati)
  // flag boolean subcommand — harus di sini agar router tidak memakan token berikutnya sebagai nilai
  "--allow-private": { kind: "boolean" },
  "--jsonl": { kind: "boolean" },
  "--all-tools": { kind: "boolean" },
  "--global": { kind: "boolean" },
  "--local": { kind: "boolean" },
  "--auto-continue": { kind: "boolean" },
  "--blocked": { kind: "boolean" },
  "--closed": { kind: "boolean" },
  "--force": { kind: "boolean" },
  // [PHASE 6U] Experimental. Opt-in gate for autonomous Scheduler execution.
  // DEFAULT OFF. A CLI flag and not a config key or env var on purpose: env is
  // inherited by sub-agents and MCP servers, and config is inherited globally or
  // per-repo — both would let autonomous execution switch on without the person
  // running the process asking for it. See src/task/production-scheduler.ts.
  "--enable-scheduler": { kind: "boolean" },

  // ── Flag bernilai ─────────────────────────────────────────────────────────
  "--cwd": { kind: "value" },
  "--resume": { kind: "value" },
  "--model": { kind: "value" },
  "--provider": { kind: "value" },
  "--session": { kind: "value" },
  "--max-steps": { kind: "value" },
  "--context-window": { kind: "value" },
  "--timeout": { kind: "value" },
  "--sandbox": { kind: "value" },
  "--ratelimit": { kind: "value" },
  "--budget": { kind: "value" },
  "--tool-scope": { kind: "value" }, // full | explore (read-only) — tanpa ini jadi kata prompt!
  "--work-mode": { kind: "value" }, // DISCUSS | BUILD — HARUS dikenal agar tak bocor ke prompt.
  "--mode": { kind: "value" }, // alias ringkas untuk --work-mode (DISCUSS | BUILD)
  // [P1 M15] Mode runtime produksi (off | constructed | owned). HARUS terdaftar:
  // flag tak dikenal menghentikan scan `hasFlag`/`getArg` (dianggap prompt
  // boundary), sehingga flag yang diletakkan SETELAH `--runtime` akan hilang
  // diam-diam — tepat kebocoran semantik yang ingin dicegah audit flag.
  "--runtime": { kind: "value" },
  "--output-format": { kind: "value" }, // `exec --output-format=json`
  "--prompt": { kind: "value" },
  // subcommand flags — harus dikenal agar tidak bocor ke prompt one-shot
  "--baseUrl": { kind: "value" },
  "--apiKey": { kind: "value" },
  "--id": { kind: "value" },
  "--command": { kind: "value" },
  "--args": { kind: "value" },
  "--env": { kind: "value" },
  "--header": { kind: "value" },
  "--url": { kind: "value" },
  "--match": { kind: "value" },
  "--adopt-task": { kind: "value" },
  "--max-turns": { kind: "value" },
  "--port": { kind: "value" },
  "--who": { kind: "value" },
  "--scopes": { kind: "value" },
  "--ttl": { kind: "value" },
  "--hash": { kind: "value" },
  "--status": { kind: "value" },
  "--state": { kind: "value" },
  "--priority": { kind: "value" },
  "--min-age-days": { kind: "value" },
  "--depends-on": { kind: "value" },
  "--stale-days": { kind: "value" },
  "--keep": { kind: "value" },
  "--drop": { kind: "value" },
  "--evidence": { kind: "value" },
  "--task": { kind: "value" },
  "--format": { kind: "value" },
  "--out": { kind: "value" },
  "--autonomous": { kind: "boolean" },
  "--wall-timeout": { kind: "value" },
  "--max-epochs": { kind: "value" },
  "--max-cost-hour": { kind: "value" },
  "--takeover": { kind: "boolean" },
}

const VALUE_FLAGS = new Set(
  Object.entries(CLI_FLAG_SPECS)
    .filter(([, spec]) => spec.kind === "value")
    .map(([name]) => name),
)
export const valueFlags = VALUE_FLAGS
const KNOWN_FLAGS = new Set(Object.keys(CLI_FLAG_SPECS))

/** `--flag` atau `--flag=value` -> normalisasi ke nama flag murni. */
export function flagNameOf(token: string): string | null {
  if (!token.startsWith("-")) return null
  const eq = token.indexOf("=")
  const name = eq === -1 ? token : token.slice(0, eq)
  return KNOWN_FLAGS.has(name) ? name : null
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token === "--") return false
    const flag = flagNameOf(token)
    if (flag) {
      if (token === name) return true
      // `--flag=value` HANYA sah untuk value flag. Untuk boolean flag,
      // `--allow-all=false` dulu dihitung sebagai `--allow-all` hadir →
      // mengaktifkan mode privileged. Fail-closed: bentuk itu = TIDAK hadir.
      if (token.startsWith(`${name}=`) && valueFlags.has(flag)) return true
      if (valueFlags.has(flag) && !token.includes("=")) i++
      continue
    }
    if (token.startsWith("-")) {
      // unknown flag seperti "-5" untuk nilai numerik sudah di-skip sebagai value di atas
      // bila sampai sini, itu prompt atau flag tak dikenal -> hentikan scan
      if (/^-?\d+(\.\d+)?$/.test(token)) {
        // "-5" tanpa flag sebelumnya bukan flag, anggap prompt
        return false
      }
      // unknown flag -> prompt boundary, bukan flag global
      return false
    }
    // prompt word pertama -> sisa argv adalah prompt, bukan flag
    return false
  }
  return false
}

/** Opt-in config lokal untuk alur sesi utama (index/exec): flag eksplisit
 * operator ATAU env (keduanya default mati). Memakai hasFlag yang
 * boundary-aware: flag di DALAM teks prompt tidak dihitung (anti-injeksi). */
export function allowLocalConfig(argv: string[]): boolean {
  return hasFlag(argv, "--allow-local-config") || process.env.MINICODE_ALLOW_LOCAL_CONFIG === "1"
}

/** Cek --allow-local-config / env pada argv subcommand. */
export function allowLocalSubcommand(argv: readonly string[]): boolean {
  // Pakai hasFlag (bukan argv.includes) supaya `--allow-local-config=false`
  // TIDAK mengaktifkan opt-in — kelas bug yang sama dengan hasFlag di finding 4.
  // argv subcommand diawali NAMA PERINTAH (bukan prompt), jadi token leading
  // bukan-flag dilewati dulu; kalau tidak, boundary-aware hasFlag akan berhenti
  // di `providers` dan flag aslinya tak pernah terlihat.
  let start = 0
  while (start < argv.length && argv[start] && !argv[start]!.startsWith("-")) start++
  return (
    hasFlag(argv.slice(start), "--allow-local-config") ||
    process.env.MINICODE_ALLOW_LOCAL_CONFIG === "1"
  )
}

/** Ambil positional ke-`index` dari argv subcommand (tolak `-*`). */
export function positionalSubArg(argv: readonly string[], index: number): string | undefined {
  const v = argv[index]
  return v && !v.startsWith("-") ? v : undefined
}

/** Cek apakah argv subcommand meminta `--help` / `-h` (sadar value-flag & batas `--`). */
export function hasHelpFlag(argv: readonly string[]): boolean {
  let start = 0
  while (start < argv.length && argv[start] && !argv[start]!.startsWith("-")) start++
  const tail = argv.slice(start)
  return hasFlag(tail, "--help") || hasFlag(tail, "-h")
}

/** Tangani `--help`/`-h` (exit 0) dan positional tak terduga (exit 2) secara seragam. */
export function guardSubcommand(
  args: readonly string[],
  cmd: string,
  help: string,
  out: (s: string) => void,
  err: (s: string) => void,
  extraIndex = 1,
): void {
  if (hasHelpFlag(args)) {
    out(help)
    process.exit(0)
  }
  if (extraIndex >= 0) {
    const extra = positionalSubArg(args, extraIndex)
    if (extra) {
      err(`unknown ${cmd} subcommand: ${sanitizeAnsiLine(extra)}\n${help}`)
      process.exit(2)
    }
  }
}

/** Parse argumen toggle (`/compact`, `/thinking`, `/fold`, `/minimize`, `/unrestric`). */
export function parseToggleArg(raw: string): boolean | undefined | "invalid" {
  const norm = raw.trim().toLowerCase()
  if (norm === "") return undefined
  if (norm === "on" || norm === "1") return true
  if (norm === "off" || norm === "0") return false
  return "invalid"
}

/** Parse flag numerik runtime + peringatan seragam untuk CLI utama & `exec`. */
function parseNumericFlag(
  getArg: (name: string) => string | undefined,
  flag: string,
  kind: "positive" | "non-negative" | "usd",
  warn: (msg: string) => void,
): number | undefined {
  const raw = getArg(flag)
  if (!raw) return undefined
  const n = Number(raw)
  if (Number.isFinite(n) && (kind === "positive" ? n > 0 : n >= 0)) return n
  const label = kind === "usd" ? "USD number" : `${kind} number`
  warn(`[warn] ${flag} requires a ${label}, ignoring "${raw}"\n`)
  return undefined
}

export function parseRuntimeNumericFlags(
  getArg: (name: string) => string | undefined,
  warn: (msg: string) => void,
) {
  return {
    maxSteps: parseNumericFlag(getArg, "--max-steps", "positive", warn),
    contextWindowTokens: parseNumericFlag(getArg, "--context-window", "positive", warn),
    timeoutMs: parseNumericFlag(getArg, "--timeout", "non-negative", warn),
    wallTimeoutMs: parseNumericFlag(getArg, "--wall-timeout", "non-negative", warn),
    maxEpochs: parseNumericFlag(getArg, "--max-epochs", "non-negative", warn),
    maxCostPerHour: parseNumericFlag(getArg, "--max-cost-hour", "usd", warn),
    budget: parseNumericFlag(getArg, "--budget", "usd", warn),
    ratelimitRpm: parseNumericFlag(getArg, "--ratelimit", "positive", warn),
  }
}

export function resolveToolScope(getArg: (name: string) => string | undefined): "explore" | "full" {
  const raw = (getArg("--tool-scope") ?? process.env.MINICODE_TOOL_SCOPE ?? "").toLowerCase()
  return raw === "explore" ? "explore" : "full"
}

export type CliWorkMode = "DISCUSS" | "EXECUTE"

/** Parse dua nilai Work Mode yang ditampilkan ke operator (DISCUSS | BUILD). */
export function parseWorkModeValue(raw: string): CliWorkMode | undefined {
  const norm = raw.trim().toUpperCase()
  // BUILD adalah nama produk untuk identitas runtime EXECUTE.
  if (norm === "BUILD") return "EXECUTE"
  if (norm === "DISCUSS") return norm
  return undefined
}

/**
 * Nama produk WorkMode untuk antarmuka pengguna: identitas internal `EXECUTE`
 * ditampilkan sebagai `BUILD`. Dipakai footer, /status, help, dan i18n agar
 * semua permukaan konsisten, tanpa mengubah identitas runtime/persistence.
 */
export function displayWorkMode(workMode: CliWorkMode): "DISCUSS" | "BUILD" {
  return workMode === "EXECUTE" ? "BUILD" : workMode
}

/**
 * P12 S2.2 — Resolusi WorkMode dari flag CLI + env, murni & diekspor untuk
 * test (pola repo). Flag `--work-mode` mengalahkan env `MINICODE_WORK_MODE`;
 * keduanya tak ada = DISCUSS. Nilai tak dikenal jatuh ke DISCUSS (fail-closed).
 * Case-insensitive agar konsisten dengan flag permission lainnya.
 */
export function resolveWorkModeFlag(getArg: (n: string) => string | undefined): {
  workMode: CliWorkMode
  /** Benar bila operator memberi sinyal WorkMode eksplisit (flag ATAU env),
   *  terlepas nilainya sah/tidak. Dipakai composition root untuk membedakan
   *  resume yang memakai nilai tersimpan dari default DISCUSS. */
  explicit: boolean
  warning?: string
} {
  const raw = getArg("--work-mode") ?? getArg("--mode") ?? process.env.MINICODE_WORK_MODE
  if (raw === undefined) return { workMode: "DISCUSS", explicit: false }
  const parsed = parseWorkModeValue(raw)
  if (parsed) return { workMode: parsed, explicit: true }
  return {
    workMode: "DISCUSS",
    explicit: true,
    warning: `--work-mode requires DISCUSS|BUILD, ignoring "${raw}" (using DISCUSS)`,
  }
}

export function getArg(argv: string[], name: string): string | undefined {
  // dukung bentuk --name value DAN --name=value; ambil kemunculan terakhir
  // (flag berulang -> yang terakhir menang, konsisten dengan CLI umum)
  let found: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === "--") break
    const flag = flagNameOf(a)
    if (flag) {
      if (a === name) {
        const v = argv[i + 1]
        const hasVal =
          v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v))
        if (hasVal) found = v
        if (hasVal && valueFlags.has(flag) && !a.includes("=")) i++
        continue
      } else if (a.startsWith(`${name}=`)) {
        const v = a.slice(name.length + 1)
        if (v !== "") found = v
        continue
      }
      if (valueFlags.has(flag) && !a.includes("=")) {
        const v = argv[i + 1]
        if (v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v))) i++
      }
      continue
    }
    if (a.startsWith("-")) {
      if (/^-?\d+(\.\d+)?$/.test(a)) return found
      return found
    }
    // prompt word pertama -> hentikan scan, sisa adalah prompt
    return found
  }
  return found
}

export function promptFromArgs(argv: string[]): string {
  const out: string[] = []
  let afterSeparator = false
  let seenPrompt = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === "--") {
      afterSeparator = true
      continue
    }
    if (afterSeparator) {
      out.push(a)
      continue
    }
    const fname = flagNameOf(a)
    if (fname === null) {
      // bukan flag dikenal -> prompt word; setelah ini semua token jadi prompt
      seenPrompt = true
      out.push(a)
      continue
    }
    if (seenPrompt) {
      // flag dikenal setelah prompt pertama -> anggap bagian prompt (anti injection)
      out.push(a)
      // untuk value flag dengan "=" sudah push sebagai satu token prompt
      // untuk bentuk terpisah, nilai berikutnya juga prompt jika ada
      if (valueFlags.has(fname) && !a.includes("=")) {
        const v = argv[i + 1]
        if (v !== undefined) {
          out.push(v)
          i++
        }
      }
      continue
    }
    if (!VALUE_FLAGS.has(fname)) continue
    // value flag sebelum prompt: lewati flag + nilainya (hanya jika benar nilai, bukan flag lain)
    if (!a.includes("=")) {
      const v = argv[i + 1]
      if (v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v))) i++
    }
  }
  return out.join(" ")
}

/**
 * Deteksi flag bernilai sebelum batas prompt yang tidak diberi nilai (mis.
 * `minicode --cwd --verbose` atau `minicode --model` di ujung) agar CLI
 * menolak dengan jelas alih-alih melompati flag berikutnya atau diam-diam kosong.
 */
export function missingValueFlags(argv: string[]): string[] {
  const missing: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined || a === "--") break
    const fname = flagNameOf(a)
    if (fname === null) {
      if (a.startsWith("--") || (a.startsWith("-") && a.length > 1 && !/^-?\d+(\.\d+)?$/.test(a))) {
        continue
      }
      break
    }
    if (!valueFlags.has(fname) || a.includes("=")) continue
    const v = argv[i + 1]
    const hasVal = v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v))
    if (!hasVal) missing.push(fname)
    else i++
  }
  return missing
}

/**
 * Deteksi token `--...` tak dikenal sebelum kata prompt pertama agar typo
 * (`--workmode`, `--modle`) dilaporkan jelas daripada dikirim ke LLM sebagai prompt.
 */
export function unknownFlagsBeforePrompt(argv: string[]): string[] {
  const unknown: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined || a === "--") break
    const fname = flagNameOf(a)
    if (fname !== null) {
      if (valueFlags.has(fname) && !a.includes("=")) {
        const v = argv[i + 1]
        if (v !== undefined && (v === "-" || !v.startsWith("-") || /^-?\d+(\.\d+)?$/.test(v))) i++
      }
      continue
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      unknown.push(eq === -1 ? a : a.slice(0, eq))
      continue
    }
    if (a.startsWith("-") && a.length > 1 && !/^-?\d+(\.\d+)?$/.test(a)) {
      unknown.push(a)
      continue
    }
    break
  }
  return unknown
}

/**
 * [Live Hardening 0.13.x §8.3/§7.1] Daftar flag YANG DIKENAL yang muncul SETELAH
 * prompt boundary (kata prompt pertama, atau separator `--`). `promptFromArgs`
 * sengaja menghentikan pemindaian flag pada boundary itu (pertahanan anti-injeksi),
 * sehingga flag semacam itu menjadi bagian teks prompt — bukan flag yang diparse.
 *
 * Tanpa peringatan, operator yang mengetik `minicode "refactor" --work-mode PLAN`
 * diam-diam menjalankan satu run tanpa work-mode yang diminta (kasus stage5: resume
 * dibuang). Helper ini memurnikan deteksi agar CLI dapat memberi `[warn]` yang
 * actionable. Nama flag di-dedupe menjaga urutan kemunculan; hanya flag dikenal
 * yang dilaporkan (flag tak dikenal memang tak akan pernah dijalankan sebagai flag).
 */
export function flagsAfterPromptBoundary(argv: string[]): string[] {
  const found: string[] = []
  let afterBoundary = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === "--") {
      // Separator eksplisit: semua token setelahnya adalah prompt (flag pun).
      afterBoundary = true
      continue
    }
    if (afterBoundary) {
      const f = flagNameOf(a)
      if (f && !found.includes(f)) found.push(f)
      continue
    }
    const fname = flagNameOf(a)
    if (fname === null) {
      // Token prompt pertama (bukan flag dikenal) → boundary di titik ini;
      // token ini sendiri adalah prompt, bukan flag.
      afterBoundary = true
      continue
    }
    // Flag dikenal SEBELUM boundary: lewati flag + nilainya (bila value flag
    // bentuk terpisah) persis seperti promptFromArgs.
    if (valueFlags.has(fname) && !a.includes("=")) i++
  }
  return found
}

export function readPrompt(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("")
  return new Promise((resolve) => {
    let data = ""
    let done = false
    const onData = (c: string | Buffer) => {
      data += String(c)
    }
    const onEnd = () => {
      if (!done) {
        done = true
        clearTimeout(t)
        cleanup()
        resolve(data.trim())
      }
    }
    const cleanup = () => {
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
    }
    const t = setTimeout(() => {
      if (!done) {
        done = true
        cleanup()
        resolve("")
      }
    }, 500)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
    // if stdin already ended
    if (process.stdin.readableEnded) {
      done = true
      clearTimeout(t)
      cleanup()
      resolve("")
    }
  })
}
