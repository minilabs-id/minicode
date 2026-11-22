#!/usr/bin/env bun
import { resolve as resolvePath } from "node:path"
import { expandMentions } from "../src/app/mentions.ts"
import { NoProviderError } from "../src/app/provider-layer.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { parseCompactKeepTurns } from "../src/policy/compaction.ts"
import { createRateLimiter } from "../src/policy/ratelimit.ts"
import { resolveSandbox, sandboxRefusalReason } from "../src/policy/sandbox-policy.ts"
import { budgetStatus } from "../src/policy/usage.ts"
import { VerifyWorkModeConflictError } from "../src/policy/work-mode.ts"
import { resolveRuntimeMode } from "../src/runtime/production-execution.ts"
import { AdoptionRefusedError, parseAdoptTaskArg } from "../src/session/cross-session-adoption.ts"
import { mintSessionId } from "../src/session/identity.ts"
import { attachMutationJournal } from "../src/session/journal.ts"
import { findSkill, renderSkill } from "../src/skills/loader.ts"
// [PHASE 6X] The ONE production gate resolver, imported directly so the call site
// and its tests cannot drift apart. See the note at the `schedulerEnabled` line.
import { GATE_ENABLED, resolveSchedulerGate } from "../src/task/production-scheduler.ts"
import { writeTrace } from "../src/telemetry/trace.ts"
import { setSubAgentSessionFactory } from "../src/tools/task.ts"
import { formatError } from "../src/ui/assistant/simple.ts"
import { formatUsd } from "../src/ui/render/money.ts"
import { c } from "../src/ui/render/theme.ts"
import {
  allowLocalConfig,
  displayWorkMode,
  flagsAfterPromptBoundary,
  hasFlag,
  parseRuntimeNumericFlags,
  promptFromArgs,
  getArg as rawGetArg,
  readPrompt,
  resolveToolScope,
  resolveWorkModeFlag,
} from "./args.ts"
import { buildHelpJson, HELP, readVersion } from "./help.ts"
import { dispatch } from "./router.ts"
import { createChildCompaction, createCliSession } from "./setup.ts"

/**
 * [AGENT-CONTROL-1] Baris peringatan `[recovery]` untuk jendela waktu tertentu.
 * Dipakai oleh DUA jalur kegagalan: catch one-shot yang exit(1) dan pembungkus
 * turn interaktif (runPromptWithVerify). Sebelum perbaikan hanya jalur one-shot
 * yang memancarkannya, sehingga setelah turn gagal pasca-anak committed, turn
 * berikutnya bisa mendelegasi ulang buta dan menggandakan efek samping anak
 * (docs/AGENTS.md:25). Display-only: baca jurnal + format, TANPA retry, tulis
 * jurnal, atau prompt. Satu sink `process.stderr.write` yang sama dipakai kedua
 * jalur agar inventaris writer (test/writer-inventory.test.ts) tak bertambah.
 */
async function emitDelegateRecoveryLines(
  sessionId: string,
  cwd: string | undefined,
  sinceTs: number,
): Promise<number> {
  try {
    const { committedDelegatesSince } = await import("../src/session/journal.ts")
    const { formatDelegateRecoveryLine } = await import("./recovery-warning.ts")
    const done = await committedDelegatesSince(sessionId, cwd, sinceTs)
    for (const d of done) {
      process.stderr.write(c.yellow(`${formatDelegateRecoveryLine(d)}\n`))
    }
    return done.length
  } catch {
    // Diagnostik recovery tak boleh menggagalkan turn yang memang sudah gagal.
    return 0
  }
}

/**
 * Jaring terakhir proses (audit freeze/ceket 2026-11-16).
 *
 * Tanpa handler ini, SATU rejection/throw yang lolos (dari hook async, timer,
 * stream provider yang ditutup, atau fire-and-forget di UI) membunuh proses
 * dengan exit 1 dan meninggalkan terminal dalam raw mode + alt-screen — gejala
 * persis "ceket": layar rusak, tak ada pesan, sesi harus ditutup manual.
 *
 * Perilaku lama tidak dipertahankan sebagai default karena tak ada satu pun
 * jalur yang memang menginginkan proses mati diam-diam: kegagalan yang perlu
 * menghentikan sesi sudah lewat `App.quit()`/`AgentError`.
 *
 * Kontrak yang dipilih:
 * - Cetak ringkas ke stderr (tanpa stack penuh kecuali MINICODE_DEBUG=1).
 * - Kembalikan terminal (raw mode, alt-screen, kursor) SEBELUM keluar.
 * - Exit code 1 agar CI/skrip tetap melihat kegagalan.
 * - Idempoten: penanganan kedua (mis. error saat cleanup) tidak rekursi.
 */
let crashGuardArmed = false
function installCrashGuard(): void {
  if (crashGuardArmed) return
  crashGuardArmed = true
  const restoreAndExit = (kind: string, error: unknown): void => {
    try {
      // Kembalikan terminal: tanpa ini shell pengguna tetap dalam raw mode.
      const stdin = process.stdin as typeof process.stdin & { setRawMode?: (b: boolean) => void }
      stdin.setRawMode?.(false)
    } catch {}
    try {
      // 1049 = keluar alt-screen; 25h = tampilkan kursor; 0m = reset atribut.
      process.stdout.write("\u001b[?1049l\u001b[?25h\u001b[0m")
    } catch {}
    try {
      const debug = process.env.MINICODE_DEBUG === "1"
      const msg = error instanceof Error ? error.message : String(error)
      const detail = debug && error instanceof Error && error.stack ? `\n${error.stack}` : ""
      process.stderr.write(`\n[minicode] ${kind}: ${msg}${detail}\n`)
    } catch {}
    // 1 = gagal. Dipakai CI dan skrip pemanggil untuk membedakan crash dari exit normal.
    process.exit(1)
  }
  process.on("uncaughtException", (error) => {
    // PTY Linux bisa melempar EIO dari `read` saat anak /shell selesai dan sisi
    // master ditutup. Bukan kegagalan aplikasi — mengabaikannya memberi
    // reacquireTerminal() kesempatan menyelesaikan handoff. Filter sengaja
    // sempit: hanya read tanpa path saat stdin memang TTY.
    const e = error as { code?: string; syscall?: string; path?: string }
    if (e?.code === "EIO" && e?.syscall === "read" && !e?.path && process.stdin.isTTY) return
    restoreAndExit("internal error", error)
  })
  process.on("unhandledRejection", (reason) => restoreAndExit("unhandled rejection", reason))
}

// HELP + readVersion() + buildHelpJson() tinggal SATU sumber di ./help.ts.
// Entry tipis (cli/entry.ts) memakai modul yang sama untuk menjawab meta flag
// tanpa memuat aplikasi; pemanggilan langsung cli/index.ts tetap berperilaku
// identik (dispatch tetap lebih dulu, lalu --version/--help).

const args = process.argv.slice(2)
// Dipasang SEBELUM dispatch: crash di jalur mana pun (termasuk config/mcp/exec)
// tetap memulihkan terminal, bukan meninggalkan sesi dalam raw mode.
installCrashGuard()
function getArg(name: string): string | undefined {
  return rawGetArg(args, name)
}

// Guard runtime: `AbortSignal.any()` (dipakai policy/context, tools/git,
// memory/vector, mcp/server, providers/detect) baru tersedia di Bun 1.1.x.
// `engines.bun` di package.json hanya DOKUMENTASI (npm menegakkan node/npm,
// bukan bun), jadi tanpa guard ini user Bun lama cuma melihat
// "AbortSignal.any is not a function" di tengah turn pertama — jauh dari
// penyebabnya. Gagal cepat + sebut versi minimum.
if (typeof AbortSignal.any !== "function") {
  process.stderr.write(
    `minicode requires Bun >= 1.1.13 (AbortSignal.any missing; detected ${process.versions.bun ?? "unknown"})\n`,
  )
  process.exit(1)
}

// Update-notifier untuk mode NON-interaktif (one-shot/pipe/subcommand):
// fire-and-forget, cache 24 jam, hormat NO_UPDATE_CHECK/CI/--json.
// REPL interaktif TIDAK lewat sini — ditangani maybeAutoUpdate (cek fresh +
// install + restart) setelah enterRepl dihitung, agar tidak ada pesan ganda.
if (
  !hasFlag(args, "--version") &&
  !args.includes("-v") &&
  !args.includes("-h") &&
  !args.includes("--help")
) {
  const likelyRepl =
    hasFlag(args, "--interactive") || (promptFromArgs(args) === "" && process.stdin.isTTY === true)
  if (!likelyRepl) {
    void (async () => {
      try {
        const ver = readVersion()
        const { checkForUpdate, formatUpdateMessage } = await import(
          "../src/policy/update-check.ts"
        )
        const latest = await checkForUpdate(ver)
        if (latest) process.stderr.write(`\n${c.yellow(formatUpdateMessage(ver, latest))}\n`)
      } catch {}
    })()
  }
}

// DI factory sesi sub-agen untuk delegate_task — dipasang di composition root
// sebelum dispatch agar semua jalur (REPL, one-shot, mcp serve) tercakup.
// Sesi anak mendapat wiring jurnal sendiri (childOf = parent) agar efek anak
// tercatat di jurnal anak, bukan disimpulkan dari finalText parent.
setSubAgentSessionFactory(async (spec) => {
  // `journal` hanya untuk wiring app-layer — jangan bocor ke config kernel.
  const { journal, ...coreSpec } = spec
  const contextWindowTokensForModel = coreSpec.provider.contextWindowTokensForModel
  const contextModelIdentity = coreSpec.provider.contextModelIdentity
  const getContextModel = () => contextModelIdentity?.(coreSpec.model) ?? coreSpec.model
  let childJournalHandle: ReturnType<typeof attachMutationJournal> | null = null
  const session = await createMinicodeSession({
    ...coreSpec,
    compaction: createChildCompaction({
      provider: coreSpec.provider,
      model: coreSpec.model,
      cwd: coreSpec.cwd,
      contextWindowTokensForModel,
      getContextModel,
    }),
    ...(journal
      ? {
          beforeToolEffect: async (call) => {
            if (childJournalHandle !== null) await childJournalHandle.preflightIntent(call)
          },
        }
      : {}),
    ...(contextWindowTokensForModel
      ? {
          contextWindowTokens: contextWindowTokensForModel(coreSpec.model),
          contextWindowTokensForModel,
          getContextModel,
        }
      : {}),
  })
  if (journal) {
    const { createPresentationAdapter, disposeOnTerminal } = await import(
      "../src/presentation/adapter.ts"
    )
    const childPresentation = createPresentationAdapter(session.events, {
      sessionId: journal.sessionId,
    })
    const { appendPresentationEvents } = await import("../src/session/persistence.ts")
    let childWrite = Promise.resolve()
    childPresentation.onEvent((event) => {
      childWrite = childWrite
        .then(() => appendPresentationEvents(journal.sessionId, spec.cwd, [event]).then(() => {}))
        .catch(() => {})
    })
    // Anak abort/timeout berakhir di `turn:interrupted` (kernel), bukan
    // `turn:completed`. Tanpa ini adapter + rantai tulis jurnal bocor setelah
    // anak mati. Helper idempoten: terminal mana pun yang tiba duluan menang.
    disposeOnTerminal(session.events, () => {
      void childWrite.finally(() => childPresentation.dispose())
    })
    childJournalHandle = attachMutationJournal(session, {
      sessionId: journal.sessionId,
      cwd: spec.cwd,
      childOf: journal.parentSessionId,
      evidenceMode: "canonical",
      onCommitted: (info) => childPresentation.noteFileChanged(info),
    })
  }
  return session
})

// dispatch subcommands via registry (handlers call process.exit internally)
await dispatch(args, getArg, HELP)

if (hasFlag(args, "--version") || args.includes("-v")) {
  console.log(readVersion())
  process.exit(0)
}

if (args.includes("-h") || args.includes("--help")) {
  if (args.includes("--tui")) {
    // Peringatan usang TETAP dicetak walau help dicetak: sensitivitas ke
    // urutan argumen = alasan klasik flag "diam" tak ketahuan (audit F8).
    process.stderr.write(
      "[deprecated] --tui is a no-op: interactive mode is always the fullscreen TUI\n",
    )
  }
  if (args.includes("--json")) {
    // machine-readable help for CI (minicode --help --json)
    console.log(JSON.stringify(buildHelpJson()))
    process.exit(0)
  }
  console.log(HELP)
  process.exit(0)
}

// -- flag parsing --
const verbose = hasFlag(args, "--verbose")
const allowAll = hasFlag(args, "--allow-all") || hasFlag(args, "-y")
const ask = hasFlag(args, "--ask")
const interactive = hasFlag(args, "--interactive")
const allowlist = hasFlag(args, "--allowlist") || process.env.MINICODE_PERMISSION === "allowlist"
// [mode-architecture] Deprecation notice utk profil warisan — jangan dihapus
// diam-diam; peta kompatibilitas di MODE_ARCHITECTURE_MIGRATION_REPORT.
if (allowAll)
  process.stderr.write(
    `[deprecated] --allow-all is a privileged access profile (hard jail/guard still apply); treat it as an explicit override, not ordinary AUTO\n`,
  )
if (allowlist)
  process.stderr.write(
    `[deprecated] --allowlist is a bash/tool access policy; the persistent approval grants remain in ~/.minicode/allowlist.json (unrenamed)\n`,
  )
const verify = hasFlag(args, "--verify")
const cwdRaw = getArg("--cwd")
const cwd = cwdRaw ? resolvePath(cwdRaw) : undefined
// Audit #07 P0: local config repo tak dipercaya kecuali operator opt-in
// eksplisit per-invokasi (flag atau env). Tanpa ini repo clone-an bisa
// men-spawn MCP server dan menyedot prompt ke endpoint penyerang.
const allowLocal = allowLocalConfig(args)
// WorkMode (lapis intent 2-mode di atas profil izin). Flag mengalahkan env;
// keduanya tak ada atau nilainya tak dikenal = DISCUSS (fail-closed).
const workModeResolved = resolveWorkModeFlag(getArg)
const workMode = workModeResolved.workMode
// Sinyal WorkMode eksplisit (flag/env) ikut diteruskan agar resume dapat
// membedakan pilihan sesi tersimpan dari default DISCUSS.
const workModeExplicit = workModeResolved.explicit
if (workModeResolved.warning) process.stderr.write(`[warn] ${workModeResolved.warning}\n`)
// [PHASE 6U] Autonomous Scheduler opt-in. DEFAULT OFF.
//
// [DESIGN DECISION] `hasFlag` and nothing else - deliberately NOT `|| process.env.`,
// unlike the permission and plan flags above. This one must not be inheritable:
// `process.env` is passed to sub-agents, MCP servers and LSP servers, so an env
// gate would switch autonomous execution on for children the person running the
// process never asked for. This flag is the only mechanism, and it is per-invocation.
//
// [PHASE 6X] ...but `hasFlag` is the WRONG matcher here (6V FINDING-01). It accepts
// any `name=value` form, so `--enable-scheduler=false`, `=0` and even `=whatever`
// all ENABLED the Scheduler - the exact opposite of what the person asked for. The
// gate itself was already correct and unit-tested; the production CALLER was not
// using it. So the call site now uses the same resolver the tests pin, which makes
// "the flag is absent" and "the flag is negated" the same answer, as they must be.
//
// The generic `hasFlag` is deliberately left alone: its value-form behaviour is
// correct for the permission and plan flags, and changing it would alter unrelated
// CLI semantics. The bug was in choosing it for a valueless flag.
const schedulerEnabled = resolveSchedulerGate(args) === GATE_ENABLED
// [P1 M15] Mode runtime produksi. Deterministik per invokasi (flag CLI, bukan
// env): `off` (default) = jalur legacy utuh, `constructed` = runtime + jurnal
// dibangun tanpa memiliki eksekusi, `owned` = admission wajib lewat M13 →
// Kernel. Nilai tak dikenal gagal ke `off` + warning (fail-closed, bukan
// jatuh ke mode yang lebih agresif tanpa diminta).
const runtimeModeResolution = resolveRuntimeMode(args)
if (runtimeModeResolution.warning) {
  process.stderr.write(`[warn] ${runtimeModeResolution.warning}\n`)
}
const runtimeMode = runtimeModeResolution.mode
const resumeId = getArg("--resume")
// P2.1: flag mentah diteruskan apa adanya; sanitasi + keputusan identitas
// tunggal milik resolveSessionIdentity (SATU aturan sanitizer, tak ada drift
// 64-vs-60 di call-site). bootId volatil hanya untuk korelasi diagnostik.
const sessionFlag = getArg("--session")
// [P14] Adopsi task eksplisit. Format salah = tolak SEBELUM sesi/lease dibuat;
// jangan biarkan operator mengira adopsi berjalan padahal argumennya diabaikan.
const adoptTaskRaw = getArg("--adopt-task")
const adoptTaskParsed = adoptTaskRaw === undefined ? null : parseAdoptTaskArg(adoptTaskRaw)
if (adoptTaskRaw !== undefined && adoptTaskParsed === null) {
  console.error(
    `[adopt] invalid --adopt-task value: "${adoptTaskRaw}" (expected <source-session>/<taskId>, task id like t1)`,
  )
  process.exit(1)
}
const adoptTask = adoptTaskParsed ?? undefined
const bootId = mintSessionId()
const modelOverride = getArg("--model")
const providerOverride = getArg("--provider")
const warnStderr = (msg: string): void => {
  process.stderr.write(msg)
}
const { maxSteps, contextWindowTokens, timeoutMs, budget, ratelimitRpm } = parseRuntimeNumericFlags(
  getArg,
  warnStderr,
)
// `--tui` alias usang (TUI fullscreen kini satu-satunya tampilan interaktif):
// tetap diterima agar skrip lama tak pecah, tapi TIDAK diam — tanpa peringatan
// user mengira flag-nya masih mengubah perilaku.
if (args.includes("--tui")) {
  warnStderr("[deprecated] --tui is a no-op: interactive mode is always the fullscreen TUI\n")
}
// F3.2: override keepRecentTurns kompaksi kernel via env (bukan flag: jarang
// diubah, dan permukaan flag CLI sengaja kecil). Selain bilangan >=1 =
// diabaikan + warn (fail-open aman: default kernel berlaku).
const keepTurnsRaw = (process.env.MINICODE_COMPACT_KEEP_TURNS ?? "").trim()
const keepRecentTurns = parseCompactKeepTurns(keepTurnsRaw || undefined)
if (keepTurnsRaw && keepRecentTurns === undefined)
  warnStderr(
    `[warn] MINICODE_COMPACT_KEEP_TURNS requires an integer >= 1, ignoring "${keepTurnsRaw}"\n`,
  )

// Sandbox: OS-native dipakai otomatis bila tersedia. Bila tidak ada isolasi
// nyata dan user belum memilih mode permission sendiri, default diturunkan ke
// `allowlist` — lebih baik membatasi perintah daripada menjalankan apa pun
// sambil menampilkan label aman. Lihat src/policy/sandbox-policy.ts.
const explicitPermission = allowAll || ask || allowlist
const requestedSandbox = getArg("--sandbox") ?? process.env.MINICODE_SANDBOX
// F-03: permintaan sandbox EKSPLISIT tanpa backend = tolak sebelum jalan
// (fail-closed). resolveSandbox di bawah tetap menghitung downgrade allowlist
// untuk notice, tetapi proses tidak lanjut ke eksekusi host.
const sandboxRefusal = sandboxRefusalReason(requestedSandbox)
if (sandboxRefusal) {
  console.error(sandboxRefusal)
  process.exit(1)
}
const sandbox = resolveSandbox(requestedSandbox, explicitPermission)
if (sandbox.mode === "none") delete process.env.MINICODE_SANDBOX
else process.env.MINICODE_SANDBOX = sandbox.mode
// Notice sandbox hanya bila user eksplisit meminta mode (mis. daemon mati,
// mode tak dikenal). Notice rutin disembunyikan: mode terlihat di prefiks.
// Cetaknya di setup, setelah provider layer lolos.
const effectiveAllowlist = allowlist || sandbox.fallbackPermission === "allowlist"
// Harness-P1: strict lewat flag ATAU env (simetri dengan MINICODE_SANDBOX_STRICT).
const budgetStrict = hasFlag(args, "--budget-strict") || process.env.MINICODE_BUDGET_STRICT === "1"
// Harness-P2: scope tool sesi; nilai selain explore jatuh ke full (eksplisit di bawah).
const toolScope = resolveToolScope(getArg)
const rateLimiter = ratelimitRpm !== undefined ? createRateLimiter(ratelimitRpm) : undefined

const prompt = promptFromArgs(args) || (await readPrompt())
// [Live Hardening 0.13.x §8.3] Flag dikenal yang muncul SETELAH prompt boundary
// menjadi teks prompt (pertahanan anti-injeksi), bukan flag terparse — operator
// yang salah letak flag diam-diam tidak mendapat perilaku yang diminta (stage5:
// --resume dibuang). Peringatan actionable, hanya bila nyata ada flag tersisip.
const ignoredFlags = flagsAfterPromptBoundary(args)
if (ignoredFlags.length > 0) {
  process.stderr.write(
    `[warn] ignored flag(s) after the prompt: ${ignoredFlags.join(", ")} — put flags before the prompt (e.g. minicode ${ignoredFlags.join(" ")} "your prompt")\n`,
  )
}
const enterRepl = interactive || (!prompt && process.stdin.isTTY)
// Auto-update REPL TIDAK lagi di-await di sini. Dulu blok ini menahan
// createCliSession sampai 1,8 dtk hanya untuk cek registry. Kini sesi dibuka
// dulu; pengecekan + (bila ada) install/restart dijalankan SETELAH sesi berdiri
// dan SEBELUM runTui menerima input pertama — lihat blok di bawah `finally`.
// Dengan begitu restart tak pernah memotong TUI aktif/turn yang sedang jalan.
if (!prompt && !enterRepl) {
  process.stderr.write('usage: minicode "prompt"  |  minicode (interactive mode)\n')
  // Salah pakai (bukan gagal runtime): exit 2 agar skrip bisa membedakan
  // dari kegagalan provider/budget (exit 1). Lihat TERMINAL_CONTRACT.md.
  process.exit(2)
}

// -- skills: expand /name args --
let effectivePrompt = prompt
try {
  if (prompt.startsWith("/")) {
    const spaceIdx = prompt.indexOf(" ")
    const skillName = spaceIdx === -1 ? prompt.slice(1) : prompt.slice(1, spaceIdx)
    const skillArgs = spaceIdx === -1 ? "" : prompt.slice(spaceIdx + 1)
    const skill = await findSkill(skillName, cwd, { allowLocal })
    if (skill) {
      effectivePrompt = await renderSkill(skill, skillArgs)
      console.error(c.dim(`[loaded skill /${skill.name}]`))
    }
  }
} catch {}

// -- build session --
// Session setup (provider/RAG/MCP/session) bisa makan detik (network + spawn)
// TANPA output — user melihat kursor mati. Bar loading transient TTY-only
// selama setup, dibersihkan sebelum TUI agar tak ada jejak.
// Bar berjalan di atas createCliSession — termasuk saat wizard setup pertama
// (picker gateway + prompt API key) memegang terminal. Lewat paintWrite,
// lukisannya otomatis BERHENTI selama layar interaktif aktif
// (statusline.beginInteractiveScreen di openAltScreen): dulu tulis mentah
// `\r\x1b[2K` menghapus baris prompt wizard, sehingga user baru hanya melihat
// "Menyiapkan sesi…" tanpa cara menyelesaikan setup (laporan: minicode dari
// home selalu macet).
// v7.44: progress startup = SATU baris angka (`start 57%`), bukan LoadingBar
// berlabel. Baik fase auto-update (di atas) maupun fase sesi memakai format
// angka yang sama; `createStartupProgress` dari cli/tui.ts menangani sesi.
const startupProgress = (await import("./tui.ts")).createStartupProgress({
  resume: Boolean(resumeId || sessionFlag),
})
// finally: createCliSession yang melempar (provider/MCP gagal) tak boleh
// membocorkan painter — tutup angka progres walau sesi gagal dibuat.
let ctx: Awaited<ReturnType<typeof createCliSession>>
try {
  ctx = await createCliSession({
    cwd,
    sessionId: sessionFlag ?? "",
    resumeId,
    bootId,
    ...(adoptTask ? { adoptTask } : {}),
    modelOverride,
    providerOverride,
    prompt,
    enterRepl,
    verbose,
    allowAll,
    ask,
    allowlist: effectiveAllowlist,
    verify,
    allowLocalConfig: allowLocal,
    // [PHASE 6U] Off unless the token was literally passed.
    schedulerEnabled,
    // [P1 M15] Reroute runtime (default `off`).
    runtimeMode,
    budget,
    budgetStrict,
    toolScope,
    // WorkMode efektif (sudah di-resolve, default DISCUSS).
    workMode,
    // P12 S2.2 (D-2) — transparansi resume: tahu apakah WorkMode diberi eksplisit.
    workModeExplicit,
    maxSteps,
    contextWindowTokens,
    ...(keepRecentTurns !== undefined ? { keepRecentTurns } : {}),
    timeoutMs,
    rateLimiter,
    sandboxNotice: requestedSandbox ? sandbox.notice : undefined,
    // v7.44: angka saja, area sekitar bersih — tidak ada label fase/kalimat.
    onPhase: startupProgress.onPhase,
  })
} catch (e) {
  // Tanpa provider = setup gagal sebelum sesi ada. Pesan + exit(1) sama
  // persis seperti dulu (provider-layer tak lagi exit sendiri agar
  // exec --json bisa memasang envelope mesinnya — lihat exec.ts).
  if (e instanceof NoProviderError) {
    console.error(e.message)
    process.exit(1)
  }
  // [P14] Refusal adopsi adalah keputusan kebijakan, bukan crash: tampilkan
  // satu baris, bukan stack trace. Detail sudah memuat alasan yang bisa
  // ditindaklanjuti operator (stale, busy, conflict, unresolved relation).
  // DIGABUNG ke cabang NoProvider di atas (satu writer untuk kelas
  // "setup menolak, bukan gagal"): menambah penulis kedua hanya untuk satu
  // format pesan menaikkan inventaris writer tanpa menambah informasi.
  if (e instanceof AdoptionRefusedError || e instanceof VerifyWorkModeConflictError) {
    console.error(e.message)
    process.exit(e instanceof VerifyWorkModeConflictError ? 2 : 1)
  }
  throw e
} finally {
  // Tutup angka progres walau createCliSession melempar (provider/MCP gagal) —
  // tanpa ini baris `start N%` menggantung tanpa newline.
  startupProgress.finish()
}

// Auto-update REPL — dijalankan di sini, BUKAN sebelum createCliSession.
// Sesi sudah berdiri tetapi runTui belum menerima input pertama: satu-satunya
// jendela aman untuk install + restart. maybeAutoUpdate memanggil process.exit
// saat restart (auto-update.ts:140-146); membiarkannya berjalan setelah input
// pertama akan memotong TUI aktif/turn yang sedang berjalan. Jalur one-shot
// tetap fire-and-forget di atas (tidak tersentuh).
// v7.44: format progres dipertahankan persis — `update 33%\r` … `update 100%\n`,
// hanya angka yang berubah; notice asli didahului `\r\x1b[2K` agar tak menimpa.
if (enterRepl) {
  let updateStarted = false
  const writeUpdate = (pct: number) => {
    process.stderr.write(`update ${pct}%\r`)
    updateStarted = true
  }
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 1800)
  try {
    const { maybeAutoUpdate } = await import("./auto-update.ts")
    const { readGlobalInstalledVersion } = await import("../src/policy/update-check.ts")
    await maybeAutoUpdate(readVersion(), ctrl.signal, {
      // Tidak ada painter transient lagi — tidak perlu stop.
      onLongOp: () => {},
      // v0.33: verifikasi dari prefix npm global, bukan package.json di samping
      // modul (bisa cache/transpilasi) — akar "versi tidak cocok" lalu rollback.
      getInstalledVersion: readGlobalInstalledVersion,
      onPhase: (phase) => {
        if (phase === "check") writeUpdate(33)
        else if (phase === "install") writeUpdate(66)
        else if (phase === "restart") writeUpdate(95)
      },
      onNotice: (line) => {
        // Tutup garis progres dulu bila ada, supaya notice tak menimpa angka.
        if (updateStarted) process.stderr.write("\r\x1b[2K")
        process.stderr.write(line)
        updateStarted = false
      },
    })
  } catch {}
  clearTimeout(to)
  // Tutup garis update HANYA bila fase update benar-benar pernah berjalan;
  // jalur tanpa update (kasus paling umum) tetap nol byte.
  if (updateStarted) process.stderr.write("update 100%\n")
}

if (enterRepl) {
  // Satu-satunya tampilan interaktif = TUI fullscreen (REPL linier dihapus).
  // One-shot/exec tak tersentuh (cabang else di bawah).
  // v7.44: `start 100%\n` sudah ditulis startupProgress.finish() di finally —
  // tidak ada jeda 80ms & LoadingBar "finalize" lagi.
  // [AGENT-CONTROL-1] Sebelum perbaikan, baris [recovery] hanya keluar dari
  // catch one-shot di bawah — jalur TUI/interaktif tak pernah memilikinya.
  // Akibatnya, setelah sebuah turn gagal berikut delegasi committed, turn
  // berikutnya bisa mendelegasi ulang buta dan menggandakan efek samping anak.
  // Bungkus runPromptWithVerify (dipasang SEBELUM runTui meng-destructure ctx)
  // agar SETIAP kegagalan turn interaktif memancarkan baris yang identik dengan
  // jalur one-shot, lewat sink diagnostik yang sama — tidak menyentuh alt-screen
  // dengan writer baru dan tidak menulis jurnal/prompt.
  const runPromptBase = ctx.runPromptWithVerify.bind(ctx)
  ctx.runPromptWithVerify = async (p, signal) => {
    const since = Date.now()
    try {
      return await runPromptBase(p, signal)
    } catch (e) {
      await emitDelegateRecoveryLines(ctx.sessionId, ctx.cwd, since)
      throw e
    }
  }
  const { runTui } = await import("./tui.ts")
  try {
    await runTui(ctx)
  } catch (error) {
    process.stderr.write(`[error] ${formatError(error)}\n`)
    process.exitCode = 1
  }
  // Renderer flat: kop sesi saat exit dihapus total. Keluar alternate-screen
  // sudah mengembalikan scrollback apa adanya; clear-screen + ringkasan hanya
  // menimpa riwayat yang masih ingin dibaca user. Tidak ada stdout write baru
  // di jalur ini (writer count juga otomatis turun).
} else {
  // P12 S2.2 (F-DISCUSS-4) + P0.2: one-shot linear memakai `ctx.workMode`
  // efektif (termasuk hasil pulihan `--resume`).
  if (ctx.workMode !== "EXECUTE" || workModeExplicit) {
    const workModeLabel = displayWorkMode(ctx.workMode)
    const modeNote = ctx.workMode === "DISCUSS" ? " (read-only)" : ""
    process.stderr.write(`[work-mode] ${workModeLabel}${modeNote}\n`)
  }
  const {
    session,
    usage,
    modelRef,
    budget: b,
    budgetStrict: strict,
    cwd: wcwd,
    sessionId: sid,
    persistCurrent,
    runPromptWithVerify,
    close,
  } = ctx
  const t0 = Date.now()
  try {
    let finalPrompt = effectivePrompt
    if (finalPrompt.includes("@")) {
      finalPrompt = (await expandMentions(finalPrompt, wcwd ?? process.cwd())).prompt
    }
    await runPromptWithVerify(finalPrompt)
    // Total SESI, bukan turn: satu one-shot hanya punya satu turn, tapi
    // --verify/self-heal bisa menjalankan beberapa dan reset() di antaranya.
    const u = usage.getSession(modelRef.current)
    let overBudget = false
    const status = budgetStatus(b, u.cost, strict ?? false, u.totalTokens)
    if (status === "over" && u.cost != null && b != null) {
      process.stderr.write(
        c.red(`[budget] ${formatUsd(u.cost)} > ${formatUsd(b)} - over budget, stopping.\n`),
      )
      overBudget = true
    } else if (status === "unknown-strict" && b != null) {
      process.stderr.write(
        c.red(
          `[budget] cost unknown (model without pricing) with ${u.totalTokens} tokens spent - over budget, stopping.\n`,
        ),
      )
      overBudget = true
    } else if (b != null && u.cost != null && u.cost > b * 0.8)
      process.stderr.write(c.yellow(`[budget] ${formatUsd(u.cost)} / ${formatUsd(b)} (80% used)\n`))
    // persistCurrent menyimpan pemakaian turn (usage.get()), bukan total sesi.
    await persistCurrent(usage.get(modelRef.current))
    // P2.2: histori yang tak durable = kegagalan jujur (bukan exit 0 diam).
    if (ctx.isWriterStale()) {
      throw new Error(`[writer] stale writer, history NOT durable: ${ctx.writerStaleNote()}`)
    }
    if (overBudget) {
      await close()
      process.exit(1)
    }
    const statusLine = c.muted(
      `\n  ${u.totalTokens.toLocaleString()} token${u.cost != null ? ` · ${formatUsd(u.cost)}` : ""} · ${session.state.stepCount} langkah · ${Math.round((Date.now() - t0) / 1000)}s`,
    )
    process.stderr.write(`${statusLine}`)
    const mUsed = usage.modelUsed()
    if (mUsed.effective && mUsed.effective !== modelRef.current) {
      process.stderr.write(
        c.dim(
          `  (via ${mUsed.provider ?? "?"}/${mUsed.effective} - requested ${modelRef.current})`,
        ),
      )
    }
    process.stderr.write("\n")
    // Model untuk trace: `modelRef.current` kosong bila user tidak memberi
    // --model, dan trace bermodel kosong tidak bisa diatribusikan ke provider —
    // kolom Status di `minicode providers` jadi selalu "belum dipakai" meski
    // sudah dipakai. Pakai model efektif (hasil substitusi router) bila ada.
    const traceModel = mUsed.effective ?? modelRef.current ?? ctx.effectiveInitialModel
    await writeTrace(wcwd, {
      sessionId: sid,
      timestamp: new Date().toISOString(),
      prompt: effectivePrompt,
      durationMs: Date.now() - t0,
      steps: session.state.stepCount,
      turns: session.state.turnCount,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cost: u.cost,
      model: traceModel,
      ok: true,
      memoryHits: ctx.memoryHits,
      overBudget,
    })
  } catch (e) {
    // Error provider biasanya sudah dirender ramah oleh event handler
    // (takePendingError) — cetak sekali saja, jangan dua blok error.
    const shown = ctx.uiState.takePendingError()
    process.stderr.write(`\n${c.red("failed")} ${shown ?? formatError(e)}\n`)
    // Audit #04 P1: sama seperti REPL — turn gagal setelah delegasi
    // committed = efek anak tetap ada. One-shot tak punya retry loop, tapi
    // user yang menjalankan ulang manual butuh peringatan yang sama.
    // [AGENT-CONTROL-1] helper yang SAMA dengan jalur interaktif: tiap baris
    // diperkaya observasi amplop anak (status + preview ringkasan, sudah
    // disanitasi display di formatter); record legacy/rusak jatuh ke baris
    // legacy byte-identik. Display-only di catch yang selalu exit — tanpa
    // retry, tanpa tulis baru.
    await emitDelegateRecoveryLines(sid, wcwd, t0)
    const uErr = usage.getSession(modelRef.current)
    await writeTrace(wcwd, {
      sessionId: sid,
      timestamp: new Date().toISOString(),
      prompt: effectivePrompt,
      durationMs: Date.now() - t0,
      steps: session.state.stepCount,
      turns: session.state.turnCount,
      inputTokens: uErr.inputTokens,
      outputTokens: uErr.outputTokens,
      model: usage.modelUsed().effective ?? modelRef.current ?? ctx.effectiveInitialModel,
      ok: false,
      error: formatError(e),
      memoryHits: ctx.memoryHits,
      overBudget: b != null && uErr.cost != null && uErr.cost > b,
    })
    await close()
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 200))
  await close()
}
