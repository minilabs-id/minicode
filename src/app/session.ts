import { resolve } from "node:path"
import type { RecoveryAction } from "#minicore/core/errors.ts"
import { AgentError, ProviderError } from "#minicore/core/errors.ts"
import type {
  BudgetPolicy,
  ModelProvider,
  PermissionHandler,
  ProviderEvent,
  Session,
  SessionConfig,
} from "#minicore/core/index.ts"
import { createSession as createCoreSession } from "#minicore/core/index.ts"
import { defaultRecoveryPolicy } from "#minicore/core/recovery.ts"
import {
  estimateMessages,
  estimateSystem,
  estimateTools,
  safeStringify,
  type TokenEstimator,
} from "#minicore/core/tokens.ts"
import type { Message, UserMessage } from "#minicore/core/types.ts"
import { LIMITS } from "../constants.ts"
// Instrumentasi durasi; nonaktif = no-op O(1).
import { perfCount, perfEnabled } from "../lib/perf-debug.ts"
// Binding persetujuan ↔ operasi yang dieksekusi.
import { ApprovalBindingStore, verifyApprovalBinding } from "../policy/approval-binding.ts"
import {
  buildSystemPrompt,
  createCalibratedEstimator,
  createIncrementalTokenCounter,
  minicodeEstimator,
} from "../policy/context.ts"
import {
  contextBudgetFor,
  outputReserveFor,
  shouldReclassifyAsOverflow,
} from "../policy/context-budget.ts"
import { nextLadderStep } from "../policy/context-escalation.ts"
import { DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS } from "../policy/context-window.ts"
import { parallelExecutor } from "../policy/executor.ts"
import {
  canonicalArgsHash,
  createNoProgressDetector,
  type NoProgressDetector,
  type NoProgressOptions,
  type NoProgressPosture,
} from "../policy/no-progress.ts"
import {
  createPermissionHandler,
  type PermissionAsk,
  type PermissionMode,
} from "../policy/permission.ts"
import {
  isRecoverable,
  planRecovery,
  RECOVERY_ATTEMPT_QUOTA,
  RECOVERY_BUDGET_MS,
} from "../policy/recovery-budget.ts"
import { DEFAULT_SESSION_MAX_STEPS, nextStepLimit } from "../policy/step-escalation.ts"
import { getCachedTokenizer, loadTokenizer } from "../policy/tokenizer-registry.ts"
import { contractForTool } from "../policy/tool-contract.ts"
import { maxTurnsExceededError } from "../policy/usage.ts"
import {
  createWorkModePermissionHandler,
  normalizeWorkMode,
  type WorkMode,
} from "../policy/work-mode.ts"
import type { ApprovalEventHook } from "../presentation/events.ts"

/** Predikat otorisasi LIVE: `tools` dimutasi in-place saat Shift+Tab, jadi snapshot
 * awal membekukan izin (MCP baru tertolak). Baca ulang tiap call + `refresh()`
 * dari setter mode menjaga `visible === callable`. Tanpa tool = fail-closed. */
export function createLiveAuthorizedTools(
  tools: readonly { readonly name: string }[] | undefined,
): { hasAuthorizedTool(name: string): boolean; refresh(): void } {
  const authorized = new Set<string>()
  const refresh = (): void => {
    authorized.clear()
    for (const t of tools ?? []) authorized.add(t.name)
  }
  refresh()
  // Refresh per-call dihapus: kedua setter mode sudah memanggil `refresh()`,
  // jadi refresh lagi hanya O(tools) copy per call tanpa manfaat.
  return {
    hasAuthorizedTool: (name: string): boolean => {
      // Dirty-flag O(1): ukuran beda = refresh (MCP discovery bisa mengubah array di luar setter).
      if ((tools?.length ?? 0) !== authorized.size) refresh()
      return authorized.has(name)
    },
    refresh,
  }
}

// Kompaksi lebih dini dari default kernel (75%/90%). Jendela ≥16k: ambang
// diselaraskan `contextBudgetFor` agar kompaksi mendahului overflow guard;
// jendela kecil (<16k, test) memakai rasio 65%/85%.
export function createAggressiveBudgetPolicy(
  getMaxOutputTokens?: () => number | undefined,
): BudgetPolicy {
  return {
    evaluate({ usedTokens, limitTokens }) {
      const limit = Math.max(1, limitTokens)
      if (usedTokens >= limit) return "critical"
      if (limit >= 16_000) {
        const b = contextBudgetFor(limit, getMaxOutputTokens?.())
        const highAt = Math.min(Math.floor(limit * 0.85), b.blockingLimit)
        const mediumAt = Math.min(Math.floor(limit * 0.65), b.compactTrigger)
        if (usedTokens >= highAt) return "high"
        if (usedTokens >= mediumAt) return "medium"
        return "low"
      }
      const ratio = usedTokens / limit
      if (ratio >= 0.85) return "high"
      if (ratio >= 0.65) return "medium"
      return "low"
    },
    shouldCompact(pressure) {
      return pressure !== "low"
    },
  }
}

export const aggressiveBudgetPolicy: BudgetPolicy = createAggressiveBudgetPolicy()

// Retry provider memakai SATU anggaran bersama dari `recovery-budget.ts` (waktu,
// kuota, jitter, `Retry-After` sebagai floor) — angka retry lokal berlipat
// menghasilkan biaya BERKALI (dulu ~82 dtk). `onError` sinkron sesuai kontrak
// kernel; status anggaran di `RecoveryLedger` per panggilan logis.

/** 429: 3 percobaan (tidak diperpanjang). `Retry-After` adalah floor, jadi
 * backoff panjang hanya menambah jeda; 429 permanen cepat terlihat. */
export const RATE_LIMIT_RETRY_ATTEMPTS = 3

/** Ledger anggaran satu panggilan logis: memegang jam yang tak disediakan
 * kernel (`onError` hanya dapat `attempt`). Satu ledger = satu prompt user,
 * dipakai retry provider + resume turn agar biaya tak berlipat. */
export interface RecoveryLedger {
  /** Waktu mulai episode kegagalan aktif (atau waktu buat bila belum ada error). */
  readonly startedAtMs: number
  /** Percobaan yang sudah dipakai (retry provider + resume turn) di episode aktif. */
  attemptsUsed(): number
  /** Percobaan retry stall/timeout yang sudah dipakai di episode aktif. */
  stallAttemptsUsed(): number
  /** Catat satu percobaan terpakai. */
  consume(): void
  /** Reset anggaran episode setelah sebuah step/panggilan berhasil pulih. */
  resetEpisode(): void
  /** Jeda berikutnya menurut anggaran bersama, atau null bila harus berhenti. */
  nextDelay(failure: {
    category?: string
    kind?: string
    retryAfterMs?: number
    stalled?: boolean
  }): {
    delayMs: number
    attempt: number
  } | null
  /** Sisa anggaran waktu episode (ms) pada saat dipanggil. */
  remainingMs(): number
}

/** Apakah pesan error berasal dari guard timeout/stall stream (bukan fail-fast HTTP). */
export function isTimeoutOrStallMessage(message: string): boolean {
  return stalledMsFromMessage(message) !== undefined || /timed out after \d+ms/i.test(message)
}

/** Buat ledger baru per turn dengan jam episode yang baru menyala saat error pertama
 * dan di-reset ulang ketika langkah berhasil. `now` di-inject untuk uji. */
export function createRecoveryLedger(now: () => number = Date.now): RecoveryLedger {
  const createdAtMs = now()
  let episodeStartedAtMs: number | null = null
  let used = 0
  let stallUsed = 0
  return {
    get startedAtMs() {
      return episodeStartedAtMs ?? createdAtMs
    },
    attemptsUsed: () => used,
    stallAttemptsUsed: () => stallUsed,
    consume: () => {
      if (episodeStartedAtMs === null) episodeStartedAtMs = now()
      used += 1
    },
    resetEpisode: () => {
      episodeStartedAtMs = null
      used = 0
      stallUsed = 0
    },
    nextDelay(failure) {
      const tNow = now()
      if (episodeStartedAtMs === null) episodeStartedAtMs = tNow
      const decision = planRecovery(
        {
          ...(failure.category !== undefined ? { category: failure.category } : {}),
          ...(failure.kind !== undefined ? { kind: failure.kind } : {}),
          ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
          ...(failure.stalled ? { stalled: true } : {}),
        },
        {
          startedAtMs: episodeStartedAtMs,
          nowMs: tNow,
          attemptsUsed: used,
          stallAttemptsUsed: stallUsed,
        },
        { hasPrompt: true },
      )
      if (decision.action === "stop") return null
      used = decision.attempt
      if (failure.stalled) stallUsed += 1
      return { delayMs: decision.delayMs, attempt: decision.attempt }
    },
    remainingMs: () =>
      episodeStartedAtMs === null
        ? RECOVERY_BUDGET_MS
        : RECOVERY_BUDGET_MS - (now() - episodeStartedAtMs),
  }
}

function sanitizeProviderErrorForFallback(error: ProviderError): ProviderError {
  const ra = error.retryAfterMs
  if (ra != null && (!Number.isFinite(ra) || ra < 0)) {
    const clean = new ProviderError(error.category, error.message, undefined)
    Object.assign(clean, { cause: (error as unknown as { cause?: unknown }).cause })
    return clean
  }
  if (ra != null && ra > LIMITS.RETRY_AFTER_MAX_MS) {
    const capped = new ProviderError(error.category, error.message, LIMITS.RETRY_AFTER_MAX_MS)
    Object.assign(capped, { cause: (error as unknown as { cause?: unknown }).cause })
    return capped
  }
  return error
}

function evaluateCappedRecovery(
  error: ProviderError,
  attempt: number,
  ledger?: RecoveryLedger,
): RecoveryAction {
  const category = error.category
  // 402 / kuota habis tidak akan sembuh dengan retry — fail-fast.
  if (
    category === "unknown" &&
    (/\b402\b/.test(error.message) ||
      /quota_exceeded|insufficient_quota|exceeded its quota/i.test(error.message))
  ) {
    return { type: "throw" }
  }
  const ra = error.retryAfterMs
  const saneRetryAfter =
    ra != null && Number.isFinite(ra) && ra >= 0
      ? Math.min(ra, LIMITS.RETRY_AFTER_MAX_MS)
      : undefined

  // 429 pakai plafon lebih ketat; jeda diserahkan anggaran bersama agar biaya tak berlipat.
  const cap = category === "rate_limit" ? RATE_LIMIT_RETRY_ATTEMPTS : RECOVERY_ATTEMPT_QUOTA
  if (attempt > cap) return { type: "throw" }

  if (ledger) {
    if (!isRecoverable({ category })) {
      return defaultRecoveryPolicy.onError(sanitizeProviderErrorForFallback(error), attempt)
    }
    const stalled = isTimeoutOrStallMessage(error.message)
    const next = ledger.nextDelay({
      category,
      ...(saneRetryAfter !== undefined ? { retryAfterMs: saneRetryAfter } : {}),
      ...(stalled ? { stalled: true } : {}),
    })
    return next !== null ? { type: "retry", delayMs: next.delayMs } : { type: "throw" }
  }

  const stalled = isTimeoutOrStallMessage(error.message)
  const decision = planRecovery(
    {
      category,
      ...(saneRetryAfter !== undefined ? { retryAfterMs: saneRetryAfter } : {}),
      ...(stalled ? { stalled: true } : {}),
    },
    // Jalur statis tanpa ledger: kuota percobaan yang menahan.
    {
      startedAtMs: 0,
      nowMs: 0,
      attemptsUsed: attempt - 1,
      stallAttemptsUsed: stalled ? attempt - 1 : 0,
    },
    { hasPrompt: true },
  )
  if (decision.action === "retry") return { type: "retry", delayMs: decision.delayMs }

  // Di luar anggaran bersama → kebijakan kernel (compaction/throw auth).
  return defaultRecoveryPolicy.onError(sanitizeProviderErrorForFallback(error), attempt)
}

/** Buat policy recovery yang mengikat satu RecoveryLedger per panggilan logis. */
export function createSessionRecoveryPolicy(getLedger: () => RecoveryLedger | undefined) {
  return {
    onError(error: ProviderError, attempt: number): RecoveryAction {
      return evaluateCappedRecovery(error, attempt, getLedger())
    },
    onLength(compacted: boolean): RecoveryAction {
      return defaultRecoveryPolicy.onLength(compacted)
    },
  }
}

/** Sanitasi `retryAfter`: nilai non-finite/negatif dibuang (`setTimeout(Infinity)`
 * ≈ 1 ms → hot fast-retry); nilai besar di-cap. Diekspor untuk test langsung. */
export const cappedRecovery = {
  onError(error: ProviderError, attempt: number): RecoveryAction {
    return evaluateCappedRecovery(error, attempt)
  },
  onLength(compacted: boolean): RecoveryAction {
    return defaultRecoveryPolicy.onLength(compacted)
  },
}

/** Telemetri retry via bus kernel (`minicode:retry`) untuk satu baris status TUI.
 * `attempt`/`quota` dari kebijakan existing, bukan progres rekaan. */
export interface RecoveryRetryTelemetry {
  /** Percobaan ke-n (1-based) pada putaran provider saat ini. */
  readonly attempt: number
  /** Kuota percobaan dari anggaran bersama (`RECOVERY_ATTEMPT_QUOTA`). */
  readonly quota: number
  /** Kategori ProviderError yang memicu retry (bila ada). */
  readonly category?: string
  /** Durasi stall (ms) yang TERCANTUM di pesan error guard; 0 = bukan stall. */
  readonly stalledMs: number
  /** Jeda jitter nyata yang dipilih kebijakan sebelum percobaan berikutnya. */
  readonly delayMs: number
}

/** Kind event bus telemetri retry (kontrak UiBus). */
export const RECOVERY_RETRY_EVENT_KIND = "minicode:retry"

/** Kuota riil per kategori: anggaran bersama (6) hanya untuk server/network;
 * kategori lain pakai 3. Mencegah label "x/6" yang berbohong untuk retry 429. */
export function recoveryQuotaFor(category: string | undefined): number {
  return category === "server" || category === "network"
    ? RECOVERY_ATTEMPT_QUOTA
    : RATE_LIMIT_RETRY_ATTEMPTS
}

/** Durasi idle di-parse dari pesan guard (bukan konfigurasi) agar label UI
 * mengikuti timeout koneksi yang sebenarnya. Null = bukan stall. */
export function stalledMsFromMessage(message: string): number | undefined {
  const match = /sent nothing for (\d+)ms/i.exec(message)
  if (!match) return undefined
  const ms = Number(match[1])
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

export type PermissionControl = {
  setMode(
    m: "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist" | "unrestricted",
  ): void
  getMode(): "auto" | "readonly" | "plan" | "allow-all" | "ask" | "allowlist" | "unrestricted"
  /** Bila true, bash dibatasi ke allow-list (lapis kapabilitas, terpisah mode). */
  getRestrictBash?(): boolean
}

/** Kontrol WorkMode runtime: handler menyimpan mode MUTABLE yang dikonsultasi
 * kernel per tool call. Composition root meneruskan handle live (bukan snapshot). */
export type WorkModeControl = {
  setWorkMode(m: WorkMode): void
  getWorkMode(): WorkMode
}

/** Guidance WorkMode (lapis intent, bukan PermissionMode): DISCUSS = baca-saja
 * dan sajikan opsi; BUILD = implementasi diizinkan, abaikan pembatasan DISCUSS
 * lama. Enforcement tetap di handler `work-mode.ts`. */
export function workModeHint(workMode: WorkMode): string {
  if (workMode === "DISCUSS") {
    return (
      "\n\nDISCUSS MODE (active): You are in read-only investigation, discussion, and planning mode. " +
      "Do NOT modify files, run bash, or use write/edit tools. " +
      "Read, search, and reason — investigate the question thoroughly, discuss findings, options, and trade-offs with the user, and produce a concrete implementation plan. " +
      "Do not implement or execute any change."
    )
  }
  return (
    "\n\nBUILD MODE (active): Full implementation and execution tools are active. " +
    "If earlier turns in the conversation occurred under read-only DISCUSS mode, ignore prior self-statements or plans about waiting/refusing edits — proceed directly to implement requested changes using write/edit/bash tools without asking for written confirmation unless genuine ambiguity remains."
  )
}

const PLAN_PM_HINT =
  "\n\nPLAN MODE: You are in read-only planning mode. Do NOT modify files, run bash, or use write/edit tools. Only read, search, and reason — then output a concrete implementation plan."

/** Penanda `PermissionMode` live di system prompt agar model tak meminta
 * konfirmasi tertulis saat mode berganti. */
export function permissionModeHint(
  permissionMode: PermissionMode | undefined,
  workMode: WorkMode,
): string {
  if (!permissionMode) return ""
  switch (permissionMode) {
    case "plan":
      return PLAN_PM_HINT
    case "unrestricted":
      return workMode === "EXECUTE"
        ? "\n\nPERMISSION MODE: UNRESTRICTED (active this session). Interactive approval prompts, workspace path jail, bash-guard, and allowlist restrictions are lifted; execute tools directly without asking confirmation."
        : "\n\nPERMISSION MODE: UNRESTRICTED (suspended in DISCUSS mode — read-only ceiling and workspace path jail stay enforced until switching to BUILD)."
    case "ask":
      return "\n\nPERMISSION MODE: ASK (supervised). Non-read-only mutating/execution tools require interactive approval in the UI; invoke tools directly when ready — do NOT ask the user for written confirmation in chat before calling them."
    case "auto":
      return "\n\nPERMISSION MODE: AUTO (autonomous within workspace safety guards). Authorized workspace tools execute without confirmation prompts (`ask_user` is unavailable); act directly."
    case "allow-all":
      return "\n\nPERMISSION MODE: ALLOW-ALL. Workspace tools run autonomously subject to path jail and hard security guards."
    case "allowlist":
      return "\n\nPERMISSION MODE: ALLOWLIST. Shell commands are restricted to the configured bash allowlist; workspace path jail and hard security guards stay active."
    case "readonly":
      return "\n\nPERMISSION MODE: READONLY. Only read-only workspace tools are permitted."
  }
}

export interface ModeSnapshot {
  workMode: WorkMode
  permissionMode?: PermissionMode
}

const workModeLabel = (wm: WorkMode): "BUILD" | "DISCUSS" =>
  wm === "EXECUTE" ? "BUILD" : "DISCUSS"

/** Catatan transisi mode antar-turn, disisipkan hanya di wire request turn itu
 * agar model tak terkecoh histori saat bolak-balik mode. */
export function buildModeTransitionNote(prev: ModeSnapshot, curr: ModeSnapshot): string {
  const parts: string[] = []
  if (prev.workMode !== curr.workMode) {
    parts.push(
      curr.workMode === "EXECUTE"
        ? `WorkMode ${workModeLabel(prev.workMode)} -> BUILD (write/edit/bash tools NOW ENABLED; ignore prior read-only/planning statements in history and implement directly without asking written confirmation)`
        : `WorkMode ${workModeLabel(prev.workMode)} -> DISCUSS (read-only mode NOW ACTIVE; do NOT modify files or run mutating commands)`,
    )
  }
  if (prev.permissionMode !== curr.permissionMode && curr.permissionMode) {
    const fromLabel = (prev.permissionMode ?? "auto").toUpperCase()
    const toLabel = curr.permissionMode.toUpperCase()
    if (curr.permissionMode === "unrestricted") {
      parts.push(
        curr.workMode === "EXECUTE"
          ? `PermissionMode ${fromLabel} -> UNRESTRICTED (full access active; approval prompts, jail, and bash-guard bypassed)`
          : `PermissionMode ${fromLabel} -> UNRESTRICTED (read-only DISCUSS ceiling stays active until switching to BUILD)`,
      )
    } else if (curr.permissionMode === "ask") {
      parts.push(
        `PermissionMode ${fromLabel} -> ASK (supervised; call tools directly — approval prompt is automatic in UI)`,
      )
    } else {
      parts.push(
        `PermissionMode ${fromLabel} -> ${toLabel} (autonomous workspace execution active)`,
      )
    }
  }
  return parts.length > 0 ? `[Runtime mode update: ${parts.join("; ")}]` : ""
}

function annotateLastUserMessage(messages: readonly Message[], note: string): readonly Message[] {
  if (!note) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "user") continue
    const content: UserMessage["content"] =
      typeof msg.content === "string"
        ? `${note}\n\n${msg.content}`
        : [{ type: "text", text: `${note}\n` }, ...msg.content]
    const next = messages.slice()
    next[i] = { ...msg, content }
    return next
  }
  return messages
}

/** Skema tool yang benar-benar dikirim di wire (tanpa `hiddenWireTools`).
 * Satu filter untuk `stream()` dan `liveToolSchemas()` agar estimasi token
 * sesuai wire. Diekspor untuk test. */
type WireToolSchema = Parameters<typeof estimateTools>[0][number]
type ProjectedWireTool = Pick<WireToolSchema, "name" | "description" | "parameters">

const wireToolObjectCache = new WeakMap<
  WireToolSchema,
  { name: string; description: string; parameters: unknown; projected: ProjectedWireTool }
>()
const wireToolListCache = new WeakMap<
  readonly WireToolSchema[],
  {
    hiddenSig: string
    sourceRefs: readonly WireToolSchema[]
    visibleRefs: readonly WireToolSchema[]
    projectedRefs: ProjectedWireTool[]
  }
>()

function projectWireTool<T extends WireToolSchema>(
  tool: T,
): Pick<T, "name" | "description" | "parameters"> {
  const cached = wireToolObjectCache.get(tool)
  if (
    cached &&
    cached.name === tool.name &&
    cached.description === tool.description &&
    cached.parameters === tool.parameters
  ) {
    return cached.projected as Pick<T, "name" | "description" | "parameters">
  }
  const projected: ProjectedWireTool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
  wireToolObjectCache.set(tool, {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    projected,
  })
  return projected as Pick<T, "name" | "description" | "parameters">
}

export function visibleWireToolSchemas<T extends WireToolSchema>(
  tools: readonly T[],
  hiddenWireTools?: ReadonlySet<string>,
): Pick<T, "name" | "description" | "parameters">[] {
  const hiddenSig =
    hiddenWireTools && hiddenWireTools.size > 0 ? [...hiddenWireTools].sort().join("\0") : ""
  const listHit = wireToolListCache.get(tools)
  if (listHit && listHit.hiddenSig === hiddenSig && listHit.sourceRefs.length === tools.length) {
    let unchanged = true
    for (let i = 0; i < tools.length; i++) {
      if (tools[i] !== listHit.sourceRefs[i]) {
        unchanged = false
        break
      }
    }
    if (unchanged) {
      for (let i = 0; i < listHit.projectedRefs.length; i++) {
        if (projectWireTool(listHit.visibleRefs[i]!) !== listHit.projectedRefs[i]) {
          unchanged = false
          break
        }
      }
      if (unchanged) {
        return listHit.projectedRefs as Pick<T, "name" | "description" | "parameters">[]
      }
    }
  }
  const visible =
    hiddenWireTools && hiddenWireTools.size > 0
      ? tools.filter((t) => !hiddenWireTools.has(t.name))
      : tools
  const projectedRefs = visible.map((t) => projectWireTool(t))
  wireToolListCache.set(tools, {
    hiddenSig,
    sourceRefs: tools.slice(),
    visibleRefs: visible,
    projectedRefs,
  })
  return projectedRefs
}

export async function createMinicodeSession(
  opts: Partial<
    Omit<SessionConfig, "permissions" | "estimator" | "recovery" | "system" | "executor">
  > & {
    systemExtra?: string
    cwd?: string
    /** Identitas model live untuk kalibrasi token per-model. */
    getContextModel?: () => string | undefined
    permissionMode?:
      | "auto"
      | "readonly"
      | "plan"
      | "allow-all"
      | "ask"
      | "allowlist"
      | "unrestricted"
    /** Kapabilitas bash terpisah dari mode: `auto` membatasi ke allow-list. */
    restrictBash?: boolean
    /** Pola bash tambahan dari config; diteruskan apa adanya ke gate izin. */
    bashAllowlist?: readonly string[]
    /** WorkMode = lapis intent terpisah dari PermissionMode. EXECUTE = perilaku
     * lama; mode lain memasang ceiling di atas handler PM (work-mode.ts). */
    workMode?: WorkMode
    /** Izinkan callback `ask` non-TTY (mis. broker persetujuan daemon) untuk tool gated. */
    allowNonTtyAsk?: boolean
    /** Flag --allow-local-config ke permission handler (default deny). */
    allowLocalConfig?: boolean
    concurrency?: number
    writeConcurrency?: number
    turnCount?: number
    stepCount?: number
    /** Batas keras turn lintas resume; `run()` menolak deterministik dengan
     * `maxTurnsExceededError` saat `turnCount >= maxTurns`. */
    maxTurns?: number
    /** Konfigurasi detektor no-progress/osilasi; aktif default, `false` untuk test. */
    noProgress?: NoProgressOptions | false
    /** Hook reset riwayat osilasi saat verify hijau. */
    onNoProgress?: (detector: NoProgressDetector) => void
    /** True jika jendela dipin user: guard lokal tak boleh menaikkannya tanpa
     * bukti error provider. */
    isExplicitContextWindow?: (model?: string) => boolean
    /** Dipanggil saat jendela naik setelah overflow terverifikasi (bukan
     * 429/402/auth/jaringan) untuk notifikasi/persistensi oleh composition root. */
    onContextWindowEscalated?: (info: {
      model: string
      fromTokens: number
      toTokens: number
      observedTokens: number
    }) => void
    /** Dipanggil saat plafon jendela diturunkan setelah penolakan overflow di bawah angka config. */
    onContextWindowClamped?: (info: {
      model: string
      fromTokens: number
      toTokens: number
      observedTokens: number
    }) => void
    /** Dipanggil saat batas langkah naik setelah `max_steps_exceeded` (bukan
     * abort/timeout/error provider) untuk notifikasi user. */
    onMaxStepsEscalated?: (info: {
      fromSteps: number
      toSteps: number
      observedSteps: number
    }) => void
    /** Store binding persetujuan per-sesi (default) agar bukti tak lintas sesi;
     * composition root boleh mengoper instance bersama bila perlu. */
    approvalBindings?: ApprovalBindingStore
    /** Handle kontrol mode permission: kernel tak expose `config`, jadi mode
     * runtime (Shift+Tab) hanya bisa diubah lewat handler ini. */
    onPermissions?: (control: PermissionControl) => void
    /** Handle kontrol WorkMode runtime; sama seperti onPermissions (kernel tak
     * expose `config`). */
    onWorkMode?: (control: WorkModeControl) => void
    /** View persetujuan (diinject cli/); tanpa ini mode interaktif menolak semua prompt (aman untuk headless). */
    ask?: PermissionAsk
    /** Hook observability persetujuan (diteruskan ke permission handler). */
    onApprovalEvent?: ApprovalEventHook
    /** Injeksi handler permission, menggantikan handler turunan-mode. Tanpa seam
     * ini, child otonom produksi diam-diam memakai policy interaktif (bisa
     * dicabut via `__setMode`, mengizinkan web_fetch/web_search) — bypass nyata.
     * Saat diisi, `permissionMode` hanya metadata kernel dan `onPermissions`
     * tidak di-wire (tak ada mode untuk dikontrol). */
    permissionHandler?: PermissionHandler
    /** Barrier sebelum `tool.execute` (dari `permissions.check` setelah allow):
     * hanya tool yang benar-benar jalan yang menulis bukti; kegagalan barrier
     * menggagalkan panggilan, bukan efek tanpa jejak. Dipakai untuk menulis
     * intent jurnal secara awaited sebelum efek. */
    beforeToolEffect?: (call: { id: string; name: string; args: unknown }) => Promise<void>
    /** Sembunyikan skema tool dari wire LLM (registry/permission tak berubah). */
    hiddenWireTools?: ReadonlySet<string>
  },
): Promise<Session> {
  // Normalisasi root sekali di composition agar ToolContext selalu memiliki path tepercaya.
  const defaultCwd = resolve(opts.cwd ?? process.cwd())
  // Fail-closed lebih awal: WorkMode non-EXECUTE + handler terinjeksi belum
  // terbukti aman — jangan membungkus policy 6S.
  const resolvedWorkMode: WorkMode = normalizeWorkMode(opts.workMode ?? "EXECUTE")
  if (opts.permissionHandler !== undefined && resolvedWorkMode !== "EXECUTE") {
    throw new Error(
      `createMinicodeSession: workMode ${resolvedWorkMode} dengan permissionHandler terinjeksi belum didukung (fail-closed S2.1)`,
    )
  }
  // Dasar prompt dirakit sekali; hint mode ditambah LIVE per-turn lewat wrapper
  // provider agar transisi `/work-mode`/`/mode` tercermin tanpa edit vendor.
  const baseSystem = await buildSystemPrompt({
    cwd: defaultCwd,
    extra: opts.systemExtra ?? "",
    signal: (opts as unknown as { signal?: AbortSignal }).signal,
    // Cadangkan ruang hint live agar total system ≤ cap.
    reserveForLiveHints: 1200,
    allowLocalConfig: opts.allowLocalConfig,
  })
  const {
    concurrency,
    writeConcurrency,
    permissionMode,
    restrictBash,
    bashAllowlist,
    workMode: _workMode,
    allowNonTtyAsk,
    allowLocalConfig,
    systemExtra: _extra,
    getContextModel: _getContextModel,
    provider,
    onPermissions,
    onWorkMode,
    ask,
    onApprovalEvent,
    permissionHandler: _permissionHandler,
    beforeToolEffect,
    turnCount,
    stepCount,
    maxTurns,
    noProgress,
    onNoProgress,
    approvalBindings: _approvalBindings,
    hiddenWireTools,
    ...rest
  } = opts
  if (!provider) throw new Error("createMinicodeSession: provider is required")
  // Store binding per-sesi (bukan global): dua sesi tak saling pakai bukti.
  // Root = cwd sesi (sama untuk resolve path target tool).
  const approvalBindings = _approvalBindings ?? new ApprovalBindingStore(defaultCwd)
  // Sanitasi batas di lapisan app (juga pemanggil library): nilai invalid
  // (NaN/negatif) -> default kernel; Infinity sengaja dipertahankan (`--timeout 0`)
  // agar operator/mode otonom benar-benar menonaktifkan batas waktu dinding.
  {
    const rec = rest as Record<string, unknown>
    const t = rec.timeoutMs
    if (typeof t === "number") {
      if (Number.isNaN(t) || t < 0) delete rec.timeoutMs
      else if (Number.isFinite(t) && t > LIMITS.MAX_TIMER_DELAY_MS)
        rec.timeoutMs = LIMITS.MAX_TIMER_DELAY_MS
    }
    const idle = rec.idleTimeoutMs
    if (typeof idle === "number") {
      if (Number.isNaN(idle) || idle <= 0) delete rec.idleTimeoutMs
    }
    const m = rec.maxSteps
    if (typeof m !== "number" || !Number.isFinite(m) || m < 1) delete rec.maxSteps
    else rec.maxSteps = Math.floor(m)
  }
  const safeConcurrency =
    typeof concurrency === "number" && Number.isFinite(concurrency) && concurrency > 0
      ? Math.floor(concurrency)
      : undefined
  const safeWriteConcurrency =
    typeof writeConcurrency === "number" &&
    Number.isFinite(writeConcurrency) &&
    writeConcurrency > 0
      ? Math.floor(writeConcurrency)
      : undefined
  const safeMaxTurns =
    typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns >= 1
      ? Math.floor(maxTurns)
      : undefined
  // Handler WorkMode selalu dibungkus (bukan `compose`: EXECUTE polos tak punya
  // __setWorkMode, mengunci transisi mode). Wrapper mendelegasikan ke base tapi
  // menyediakan __setWorkMode.
  // Tool terotorisasi = tool terlihat/terdaftar (termasuk MCP runtime); `auto`
  // membedakan MCP sah dari tak-terkonfigurasi (fail-closed). Predikat LIVE.
  const authorized = createLiveAuthorizedTools(rest.tools)
  const permissions =
    opts.permissionHandler ??
    createWorkModePermissionHandler({
      workMode: resolvedWorkMode,
      base: createPermissionHandler({
        mode: permissionMode ?? "auto",
        root: defaultCwd,
        ask,
        allowNonTtyAsk,
        allowLocalConfig: allowLocalConfig === true,
        restrictBash,
        ...(bashAllowlist ? { bashAllowlist } : {}),
        onApprovalEvent,
        hasAuthorizedTool: authorized.hasAuthorizedTool,
        // Store per-sesi: bukti sesi A tak berlaku di sesi B.
        approvalBindings,
      }),
      root: defaultCwd,
    })
  const injected = opts.permissionHandler !== undefined
  const withMode = permissions as typeof permissions & {
    __setMode(m: PermissionMode): void
    __getMode(): PermissionMode
  }
  const wmCtl = permissions as typeof permissions & {
    __setWorkMode?(m: WorkMode): void
    __getWorkMode?(): WorkMode
  }
  const registeredTools = rest.tools ?? []
  const isAllToolsPureRead = (): boolean =>
    registeredTools.length > 0 &&
    registeredTools.every((t) => contractForTool(t.name)?.sideEffectTier === "PURE_READ")
  const livePosture = (): NoProgressPosture => {
    if (injected) return "readonly"
    const pm = withMode.__getMode()
    if (pm === "readonly") return "readonly"
    if (pm === "plan") return "plan"
    const wm = wmCtl.__getWorkMode?.() ?? resolvedWorkMode
    if (wm === "DISCUSS") return "plan"
    if (isAllToolsPureRead()) return "explore"
    return "active"
  }
  const effectiveRoot = defaultCwd
  let guardEventSink: ((ev: unknown) => void) | undefined
  const detector: NoProgressDetector | null =
    noProgress === false
      ? null
      : createNoProgressDetector({
          ...(noProgress ?? {}),
          getPosture: noProgress?.getPosture ?? livePosture,
          hasTodoWrite:
            noProgress?.hasTodoWrite ?? registeredTools.some((t) => t.name === "todo_write"),
          onGuardEvent: (ev) => {
            noProgress?.onGuardEvent?.(ev)
            guardEventSink?.(ev)
          },
        })
  if (detector && onNoProgress) onNoProgress(detector)

  // Barrier sebelum efek: detektor no-progress/osilasi → capture hash pra-efek
  // → `beforeToolEffect` menulis intent jurnal secara awaited. Juga jadi batas
  // eksekusi verifikasi approval (executor cek versi otorisasi lagi sebelum
  // tool.execute). Alasan deny "approval stale" disimpan terpisah karena
  // handler base memakai peta privat; kernel membacanya via `describeDenial`.
  let authorizationVersion = 0
  const staleDenyReasons = new Map<string, string>()
  // Barrier selalu dipasang: verifikasi approval berlaku di semua konfigurasi,
  // termasuk sesi tanpa jurnal/detektor.
  const withEffectBarrier: PermissionHandler = {
    ...permissions,
    check: async (call, deps) => {
      const authorizedVersion = authorizationVersion
      const decision = await permissions.check(call, deps)
      // Kernel hanya memblokir literal "deny": validasi di sini menjaga
      // fail-closed tanpa mengubah salinan MiniCore. Handler ASK tetap sah.
      if (decision !== "allow") return "deny"
      const recordStaleDeny = (reason: string): "deny" => {
        const id = (call as { id?: string } | null)?.id
        if (id) {
          if (staleDenyReasons.size > 500)
            staleDenyReasons.delete(staleDenyReasons.keys().next().value as string)
          staleDenyReasons.set(id, reason)
        }
        return "deny"
      }
      // Konsumsi binding sekali, sebelum await: tak ada sisa binding bila barrier memblokir.
      const currentArgsHash = canonicalArgsHash(call.args)
      const binding = approvalBindings.take(call.name, currentArgsHash, call.id)
      // Fail-closed mutasi args: binding diambil via callId (stabil), bukan
      // argsHash (dulu `take` miss ⇒ lolos). Args eksekusi wajib sama dengan
      // args disetujui; tanpa binding (auto/allowlist/headless) tetap lewat.
      if (binding && binding.argsHash !== currentArgsHash) {
        return recordStaleDeny(
          "approval stale: args changed since approval — request fresh approval",
        )
      }
      // Verifikasi sebelum preflight menulis `pending` agar approval basi tak menodai jurnal.
      const preVerdict = verifyApprovalBinding(binding)
      if (authorizedVersion !== authorizationVersion || preVerdict.kind === "stale") {
        return recordStaleDeny(
          authorizedVersion !== authorizationVersion
            ? "authorization changed while preparing tool execution; request fresh approval"
            : `approval stale: ${preVerdict.kind === "stale" ? preVerdict.reason : "changed"}`,
        )
      }
      if (detector !== null) {
        await detector.beforeToolEffectCheck(call, effectiveRoot)
      }
      if (beforeToolEffect !== undefined) {
        await beforeToolEffect(call)
      }
      // Verifikasi lapis-2: fail-closed bila target/mode berubah saat await berlangsung.
      const verdict = verifyApprovalBinding(binding)
      if (authorizedVersion !== authorizationVersion || verdict.kind === "stale") {
        return recordStaleDeny(
          authorizedVersion !== authorizationVersion
            ? "authorization changed while preparing tool execution; request fresh approval"
            : `approval stale: ${verdict.kind === "stale" ? verdict.reason : "changed"}`,
        )
      }
      return "allow"
    },
    describeDenial: (call) => {
      const id = (call as { id?: string } | null)?.id
      if (id) {
        const reason = staleDenyReasons.get(id)
        if (reason) {
          staleDenyReasons.delete(id)
          return reason
        }
      }
      return permissions.describeDenial?.(call)
    },
  }
  // Handler terinjeksi = policy, bukan mode: tak punya `__setMode`. `onPermissions`
  // sengaja tidak di-wire agar Shift+Tab tak bisa mencabut readonly pada executor
  // otonom (lubang yang ditutup 6S). `permissionMode` hanya metadata kernel.
  if (onPermissions && !injected) {
    onPermissions({
      setMode: (m) => {
        if (withMode.__getMode() !== m) authorizationVersion++
        withMode.__setMode(m)
        // Segarkan otorisasi saat PM berganti (defense-in-depth; predikat juga refresh per-call).
        authorized.refresh()
      },
      getMode: () => withMode.__getMode(),
      // restrictBash = opsi tetap dari closure, bukan state handler WorkMode.
      getRestrictBash: () => restrictBash === true,
    })
  }
  // Kontrol WorkMode hanya di-wire bila handler bukan terinjeksi (policy tak
  // punya __setWorkMode — fail-closed, sama seperti onPermissions).
  if (onWorkMode && !injected) {
    const wm = permissions as typeof permissions & {
      __setWorkMode(m: WorkMode): void
      __getWorkMode(): WorkMode
    }
    onWorkMode({
      setWorkMode: (m) => {
        const norm = normalizeWorkMode(m)
        if (wm.__getWorkMode() !== norm) authorizationVersion++
        wm.__setWorkMode(norm)
        // Segarkan otorisasi saat WM berganti (defense-in-depth; predikat juga refresh per-call).
        authorized.refresh()
      },
      getWorkMode: () => wm.__getWorkMode(),
    })
  }
  // Teruskan mode live ke kernel agar ToolContext.permissionMode selalu
  // mencerminkan Shift+Tab saat itu (bukan snapshot saat sesi dibuat).
  const livePermissionMode = (): PermissionMode => (injected ? "readonly" : withMode.__getMode())
  const liveWorkModeForSystem = (): WorkMode =>
    injected ? resolvedWorkMode : (wmCtl.__getWorkMode?.() ?? resolvedWorkMode)
  const livePermissionModeForSystem = (): PermissionMode | undefined =>
    injected ? opts.permissionMode : withMode.__getMode()
  let lastTurnMode: ModeSnapshot | null = null
  let activeTurnTransitionNote = ""
  let turnSentStream = false
  // State bersama semua run(); run "busy" yang ditolak core tak boleh menimpa
  // state turn aktif lewat finally. Token monoton + pemilik aktif menjaga cleanup.
  let runSeq = 0
  let stateOwner = 0
  const computeLiveSystem = (): string => {
    const __t = perfEnabled() ? performance.now() : 0
    try {
      const pm = livePermissionModeForSystem()
      const wm = liveWorkModeForSystem()
      const contextWindow = contextWindowForModel(currentContextModel())
      const capacityHint = `\n\n# Harness context capacity\nThe harness currently budgets ${contextWindow} tokens for the selected model. This is the configured/resolved session limit, not a guarantee from the provider. It is independent of the Windows operating system and shell. System instructions, tool schemas, history, and output share this budget; compaction starts before the full window is exhausted. Preserve durable task progress before compaction.`
      return baseSystem + workModeHint(wm) + permissionModeHint(pm, wm) + capacityHint
    } finally {
      perfCount("session.computeLiveSystem", perfEnabled() ? performance.now() - __t : 0)
    }
  }
  // Kalibrasi per-model: pindah model tak membawa rasio tokenizer/provider lama.
  const calibrations = new Map<string, ReturnType<typeof createCalibratedEstimator>>()
  const contextModelKey = (model?: string): string => model?.trim() || "__default__"
  const calibrationFor = (model?: string) => {
    const key = contextModelKey(model)
    let calibration = calibrations.get(key)
    if (!calibration) {
      calibration = createCalibratedEstimator()
      calibrations.set(key, calibration)
    }
    return calibration
  }
  let activeContextModel = opts.model
  const currentContextModel = () => {
    const selected = _getContextModel?.() ?? activeContextModel
    try {
      return provider.contextModelIdentity?.(selected) ?? selected
    } catch {
      return selected
    }
  }
  // Estimator presisi: tokenizer EXACT bila tersedia, else density + kalibrasi;
  // menutup under-count chars/4 pada model open tanpa tokenizer ter-bundle.
  const preciseEstimator = (model: string | undefined, text: string): number => {
    const tok = model ? getCachedTokenizer(model) : null
    if (tok) return Math.ceil(tok.countTokens(text))
    return calibrationFor(model).estimator(text)
  }
  const makeEstimatorForModel = (getModel: () => string | undefined): TokenEstimator =>
    Object.assign((text: string) => preciseEstimator(getModel(), text), {
      // Menjaga keamanan cache: membedakan model BPE ter-cache vs factor kalibrasi live.
      cacheKey: () => {
        const m = getModel()
        const tok = m ? getCachedTokenizer(m) : null
        if (tok) return `bpe:${m}`
        const f = calibrationFor(m).snapshot().factor
        return f > 1 ? `minicode:cal:${f}` : "minicode:heur:v1"
      },
    })
  const calibratedEstimator = makeEstimatorForModel(currentContextModel)
  // Warm tokenizer di latar (fire-and-forget): vocab di-cache, request berikut presisi.
  void loadTokenizer(currentContextModel() ?? "").catch(() => {})
  let lastRequestLocalEstimate: { model: string; tokens: number } | undefined
  // ANCHOR input provider (usage.prompt_tokens) = lantai estimasi admission:
  // chars/4 under-count kode/JSON. Ambil nilai terbesar per turn agar aman
  // terhadap usage kumulatif gateway.
  let lastProviderInputTokens: number | undefined
  let lastRequestMessageCount = 0
  const contextWindowForModel = (model?: string): number => {
    const __t = perfEnabled() ? performance.now() : 0
    try {
      // Eskalasi adaptif = bukti endpoint, menang atas resolusi statis. Pin operator
      // dihormati di `contextWindowBase`, tapi bila terbukti kurang (overflow
      // nyata), naik satu tangga lebih baik daripada mengulang kegagalan.
      // Sebaliknya bila penyedia menolak jauh di bawah jendela config, clamp
      // turun agar kompaksi menargetkan ukuran nyata penyedia.
      const key = escalationKey(model)
      const escalated = escalatedWindows.get(key)
      const rawWindow = escalated !== undefined ? escalated : contextWindowBase(model)
      const capped = cappedWindows.get(key)
      return capped !== undefined ? Math.min(rawWindow, capped) : rawWindow
    } finally {
      perfCount("session.contextWindowForModel", perfEnabled() ? performance.now() - __t : 0)
    }
  }
  // Batas output untuk reserve (bukan angka tetap): dari metadata provider
  // (`/models`); tanpa metadata → reserve default.
  const maxOutputTokensForModel = (model?: string): number | undefined => {
    try {
      const fromCore = rest.maxOutputTokensForModel?.(model)
      if (typeof fromCore === "number" && Number.isSafeInteger(fromCore) && fromCore > 0)
        return fromCore
      const fromProvider = (
        provider as { maxOutputTokensForModel?: (m?: string) => number }
      ).maxOutputTokensForModel?.(model)
      if (
        typeof fromProvider === "number" &&
        Number.isSafeInteger(fromProvider) &&
        fromProvider > 0
      )
        return fromProvider
    } catch {}
    return undefined
  }
  // ── Eskalasi & clamp jendela konteks ──
  // Hanya untuk sesi ini (bukan config: itu niat operator). Kunci `provider::model`.
  const escalatedWindows = new Map<string, number>()
  const cappedWindows = new Map<string, number>()
  const escalationKey = (model?: string): string => {
    const raw = model ?? currentContextModel() ?? "default"
    return raw.includes("::") ? raw : `${provider.id}::${raw}`
  }
  /** Jendela dasar sebelum eskalasi. */
  const contextWindowBase = (model?: string): number => {
    const explicit = rest.contextWindowTokens
    try {
      const resolved =
        rest.contextWindowTokensForModel?.(model) ?? provider.contextWindowTokensForModel?.(model)
      if (typeof resolved === "number" && Number.isSafeInteger(resolved) && resolved > 0)
        return resolved
    } catch {}
    return typeof explicit === "number" && Number.isSafeInteger(explicit) && explicit > 0
      ? explicit
      : DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS
  }
  /** Turunkan plafon sesi saat penyedia menolak di bawah kapasitas config agar kompaksi efektif. */
  const clampContextWindow = (
    model: string | undefined,
    observedTokens: number,
    currentLimit: number,
  ) => {
    if (!Number.isFinite(observedTokens) || observedTokens <= 0) return
    const key = escalationKey(model)
    const prev = cappedWindows.get(key) ?? currentLimit
    // Ambil 72% dari titik penolakan (min 8192) supaya target kompaksi (50% = ~36%)
    // serta ruang output berada jauh di bawah batas nyata penyedia.
    const next = Math.max(8_192, Math.floor(observedTokens * 0.72))
    if (next >= prev) return
    escalatedWindows.delete(key)
    cappedWindows.set(key, next)
    try {
      rest.onContextWindowClamped?.({
        model: key,
        fromTokens: prev,
        toTokens: next,
        observedTokens,
      })
    } catch {}
  }
  /** Naik satu tangga setelah overflow terverifikasi. Otomatis (user tak tahu
   * tangga berikutnya; sesi mati lebih mahal), tapi BOUNDED: satu langkah per
   * kejadian, tak melewati batas atas, hanya sesi ini. */
  const escalateContextWindow = (
    model: string | undefined,
    observedTokens: number,
    fromClientGuard = false,
  ) => {
    // Pin eksplisit operator atau plafon hasil clamp penolakan upstream tak boleh
    // dinaikkan diam-diam oleh guard lokal tanpa bukti kapasitas baru dari provider.
    const key = escalationKey(model)
    if (fromClientGuard && (rest.isExplicitContextWindow?.(model) || cappedWindows.has(key))) return
    const base = contextWindowForModel(model)
    // Jika provider sendiri menolak jauh di bawah jendela aktif, jangan justru
    // menaikkan jendela; turunkan plafon agar kompaksi berikutnya memperkecil payload.
    if (
      !fromClientGuard &&
      Number.isFinite(observedTokens) &&
      observedTokens > 0 &&
      observedTokens < base * 0.9
    ) {
      clampContextWindow(model, observedTokens, base)
      return
    }
    // Naik dari nilai pengamatan bila sudah melewati dasar; jika tidak, dari jendela kini.
    const from = Math.max(base, Number.isFinite(observedTokens) ? observedTokens : 0)
    const next = nextLadderStep(from)
    if (next === undefined || next <= base) return
    cappedWindows.delete(key)
    escalatedWindows.set(key, next)
    try {
      rest.onContextWindowEscalated?.({
        model: key,
        fromTokens: base,
        toTokens: next,
        observedTokens,
      })
    } catch {}
  }

  // ── Eskalasi batas langkah ──
  // Backstop, bukan anggaran: turn mentok naik satu tangga (bounded) untuk turn
  // berikutnya, hanya sesi ini. Dipicu HANYA oleh `max_steps_exceeded` — error
  // lain tak tertolong langkah tambahan.
  let effectiveMaxSteps =
    typeof rest.maxSteps === "number" && Number.isFinite(rest.maxSteps) && rest.maxSteps >= 1
      ? Math.floor(rest.maxSteps)
      : DEFAULT_SESSION_MAX_STEPS
  const escalateMaxSteps = (observedSteps: number) => {
    const next = nextStepLimit(effectiveMaxSteps, observedSteps)
    if (next === undefined) return
    const from = effectiveMaxSteps
    effectiveMaxSteps = next
    try {
      rest.onMaxStepsEscalated?.({ fromSteps: from, toSteps: next, observedSteps })
    } catch {}
  }

  const dynamicProvider: ModelProvider = {
    id: provider.id,
    get models() {
      return provider.models
    },
    async *stream(req, signal) {
      turnSentStream = true
      const system = computeLiveSystem()
      const messages = activeTurnTransitionNote
        ? annotateLastUserMessage(req.messages, activeTurnTransitionNote)
        : req.messages
      const model = req.model ?? currentContextModel()
      let limit = contextWindowForModel(model)
      let maxOutputTokens = maxOutputTokensForModel(model)
      const estimatorModel = model?.includes("::") ? model : (currentContextModel() ?? model)
      let activeEstModel = estimatorModel
      let calibration = calibrationFor(activeEstModel)
      const estimator: TokenEstimator = makeEstimatorForModel(() => activeEstModel)
      let admittedFactor = calibration.snapshot().factor
      const rawTools = req.tools ?? []
      const tools =
        hiddenWireTools && hiddenWireTools.size > 0
          ? rawTools.filter((t) => !hiddenWireTools.has(t.name))
          : rawTools
      const __estT = perfEnabled() ? performance.now() : 0
      let localInputTokens = 0
      try {
        localInputTokens =
          estimateMessages(messages, minicodeEstimator) +
          estimateSystem(system, minicodeEstimator) +
          estimateTools(tools, minicodeEstimator)
      } finally {
        perfCount("session.estimateLocalInput", perfEnabled() ? performance.now() - __estT : 0)
      }
      // Ketika BPE belum termuat dan factor kalibrasi === 1, nilainya identik
      // dengan `localInputTokens` sehingga tidak perlu memindai histori ulang.
      const hasBpe = Boolean(activeEstModel && getCachedTokenizer(activeEstModel))
      let inputTokens =
        !hasBpe && admittedFactor <= 1
          ? localInputTokens
          : estimateMessages(messages, estimator) +
            estimateSystem(system, estimator) +
            estimateTools(tools, estimator)
      // Jangan biarkan estimasi (chars/4, under-count 2–5×) jatuh di bawah anchor
      // provider. Reset anchor bila pesan menyusut (kompaksi/rewind/clear).
      if (messages.length < lastRequestMessageCount) {
        lastProviderInputTokens = undefined
      }
      lastRequestMessageCount = messages.length
      if (lastProviderInputTokens !== undefined && lastProviderInputTokens > inputTokens) {
        inputTokens = lastProviderInputTokens
      }
      lastRequestLocalEstimate = {
        model: contextModelKey(estimatorModel),
        tokens: localInputTokens,
      }
      // Reserve ruang jawaban dari `context-budget.ts` (min(max_output,20k),
      // lantai 4k/2%). Tanpa ini request di ambang batas ditolak setelah biaya
      // dibakar (nilai lama ~256 praktis nol untuk jendela 1M).
      let reserve = outputReserveFor(limit, maxOutputTokens)
      let outputAllowance = Math.max(0, limit - inputTokens - reserve)
      let outputTokens = 0
      const streamedText = createIncrementalTokenCounter()
      const streamedReasoning = createIncrementalTokenCounter()
      const contextLimitEvent = (input: number, output: number): ProviderEvent => ({
        type: "extension",
        kind: "context-window-limit",
        data: {
          inputTokens: input,
          outputTokens: output,
          windowTokens: limit,
          // Diagnostik: factor besar + localInput kecil = cutoff palsu (inflasi
          // kalibrasi), bukan konteks penuh.
          factor: calibration.snapshot().factor,
          localInputTokens: localInputTokens,
          storeMessages: messages.length,
        },
      })
      let clientOverflowErr: ProviderError | undefined
      // `reclassified` = 400 generik yang diduga konteks penuh: jangan menaikkan
      // jendela (dulu 1M→2M dan input membengkak 9,3 juta token). Eskalasi hanya
      // untuk overflow terbukti.
      let reclassifiedOverflow = false
      const overflow = (
        actualInput = inputTokens,
        actualOutput = outputTokens,
        clientGuard = false,
        reclassified = false,
      ) => {
        // Jika penyedia menolak pada input jauh di bawah `limit`, turunkan plafon
        // sesi (termasuk untuk `reclassified`) agar kompaksi segera menyusutkan payload.
        if (!clientGuard && actualInput > 0 && actualInput < limit * 0.9) {
          clampContextWindow(model, actualInput, limit)
        } else if (!reclassified) {
          // `context_length_exceeded` → kernel force_compact_and_retry + eskalasi terikat.
          escalateContextWindow(model, actualInput + actualOutput, clientGuard)
        }
        const total = actualInput + actualOutput
        // Pesan jujur: jangan tulis "exceeds" bila angka jauh di bawah jendela
        // (dulu menyesatkan diagnosis user).
        const detail = reclassified
          ? `the provider rejected this request (400) while the local estimate was ${actualInput} of ${limit} tokens, so it is being treated as a context overflow`
          : total >= limit
            ? `input ${actualInput} + output ${actualOutput} exceeds ${limit} tokens`
            : `input ${actualInput} + output reserve ${reserve} reaches the ${limit}-token budget`
        const err = new ProviderError(
          "context_length_exceeded",
          `context window budget reached for the selected model: ${detail}; reduce the prompt/tools or select a larger context window`,
        )
        if (clientGuard) clientOverflowErr = err
        return err
      }
      const requestController = new AbortController()
      const forwardAbort = () => requestController.abort(signal.reason)
      if (signal.aborted) forwardAbort()
      else signal.addEventListener("abort", forwardAbort, { once: true })
      try {
        if (inputTokens + reserve >= limit) {
          const error = overflow(inputTokens, 0, true)
          requestController.abort(error)
          yield contextLimitEvent(inputTokens, 0)
          throw error
        }

        for await (const event of provider.stream(
          {
            ...req,
            messages,
            system,
            ...(hiddenWireTools && hiddenWireTools.size > 0 ? { tools } : {}),
          },
          requestController.signal,
        )) {
          if (event.type === "extension" && event.kind === "effective-model") {
            const effective = event.data as { effective?: unknown; provider?: unknown } | undefined
            if (
              typeof effective?.effective === "string" &&
              typeof effective.provider === "string"
            ) {
              // Fallback router = boundary model lain. Ambil kapasitas terkecil
              // agar provider utama yang gagal tak melebarkan budget diam-diam.
              const effectiveModel = `${effective.provider}::${effective.effective}`
              const effectiveLimit = contextWindowForModel(effectiveModel)
              maxOutputTokens = maxOutputTokensForModel(effectiveModel) ?? maxOutputTokens
              limit = Math.min(limit, effectiveLimit)
              activeEstModel = effectiveModel
              calibration = calibrationFor(effectiveModel)
              admittedFactor = calibration.snapshot().factor
              inputTokens = Math.max(
                inputTokens,
                estimateMessages(messages, estimator) +
                  estimateSystem(system, estimator) +
                  estimateTools(tools, estimator),
              )
              reserve = outputReserveFor(limit, maxOutputTokens)
              outputAllowance = Math.max(0, limit - inputTokens - reserve)
            }
          }
          const currentFactor = calibration.snapshot().factor
          if (currentFactor > admittedFactor) {
            inputTokens = Math.max(
              inputTokens,
              estimateMessages(messages, estimator) +
                estimateSystem(system, estimator) +
                estimateTools(tools, estimator),
            )
            reserve = outputReserveFor(limit, maxOutputTokens)
            outputAllowance = Math.max(0, limit - inputTokens - reserve)
          }
          admittedFactor = currentFactor
          let added = 0
          if (event.type === "text") {
            added = streamedText.add(event.text, calibration.snapshot().factor)
          } else if (event.type === "tool_call") {
            added = estimator(event.name) + estimator(safeStringify(event.args))
          } else if (event.type === "extension" && event.kind === "reasoning") {
            const reasoning = (event.data as { text?: unknown } | undefined)?.text
            if (typeof reasoning === "string") {
              added = streamedReasoning.add(reasoning, calibration.snapshot().factor)
            }
          }
          if (added > 0 && outputTokens + added > outputAllowance) {
            const error = overflow(inputTokens, outputTokens + added, true)
            requestController.abort(error)
            yield contextLimitEvent(inputTokens, outputTokens + added)
            throw error
          }
          outputTokens += added
          yield event as ProviderEvent
        }
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.category === "context_length_exceeded" &&
          !reclassifiedOverflow &&
          error !== clientOverflowErr
        ) {
          escalateContextWindow(model, Math.max(inputTokens + outputTokens, limit), false)
        }
        // 400 generik ("invalid_request") bisa berarti konteks penuh →
        // reklasifikasi agar kernel compact-and-retry, bukan mati fatal. Ambang
        // RELATIF (`min(50k, window*0.5)`); angka mutlak membuat jendela <50k
        // mustahil mencapai ambang.
        if (
          error instanceof ProviderError &&
          (error.category === "invalid_request" || error.category === "unknown")
        ) {
          // Reklasifikasi butuh bukti: teks provider menyebut konteks ATAU
          // estimasi lokal melewati titik kompaksi. Dulu setiap 400 besar
          // memicu retry/eskalasi yang tak menyelesaikan masalah.
          if (
            shouldReclassifyAsOverflow({
              localInputTokens,
              windowTokens: limit,
              ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
              message: error.message,
            })
          ) {
            reclassifiedOverflow = true
            throw overflow(inputTokens, outputTokens, false, true)
          }
        }
        throw error
      } finally {
        signal.removeEventListener("abort", forwardAbort)
        if (!requestController.signal.aborted) {
          requestController.abort(new AgentError("aborted", "provider stream closed"))
        }
      }
    },
  }
  const liveToolSchemas = () => visibleWireToolSchemas(registeredTools, hiddenWireTools)
  // `cappedRecovery` sengaja murni; telemetri dipancarkan dari sini via sink
  // setelah `core` ada. Retry yang tak jadi (throw/compact) tak memancarkan
  // apa pun — jangan klaim kemajuan rekaan.
  let retrySink: ((info: RecoveryRetryTelemetry) => void) | undefined
  let activeRecoveryLedger: RecoveryLedger | undefined
  const sessionRecoveryPolicy = createSessionRecoveryPolicy(() => activeRecoveryLedger)
  const recoveryWithTelemetry: typeof cappedRecovery = {
    onError(error, attempt) {
      const action = sessionRecoveryPolicy.onError(error, attempt)
      if (action.type === "retry") {
        try {
          retrySink?.({
            attempt,
            quota: recoveryQuotaFor(error.category),
            category: error.category,
            stalledMs: stalledMsFromMessage(error.message) ?? 0,
            delayMs: action.delayMs,
          })
        } catch {
          // Observability tak boleh menggagalkan turn: bus rusak dibungkam
          // (fail-open aman, tak ada keputusan keamanan di sini).
        }
      }
      return action
    },
    onLength(compacted) {
      return sessionRecoveryPolicy.onLength(compacted)
    },
  }
  const core = createCoreSession({
    ...rest,
    contextWindowTokens: contextWindowForModel(currentContextModel()),
    contextWindowTokensForModel: contextWindowForModel,
    maxOutputTokensForModel: maxOutputTokensForModel,
    // Batas langkah adaptif: nilai operator = titik awal, naik per
    // `max_steps_exceeded`; kernel baca sekali per turn via `maxStepsForRun`.
    maxSteps: effectiveMaxSteps,
    maxStepsForRun: () => effectiveMaxSteps,
    // Kompaksi lebih agresif (host-side): ringkas mulai 65% jendela, bukan 75%.
    budget: createAggressiveBudgetPolicy(() => maxOutputTokensForModel(currentContextModel())),
    provider: dynamicProvider,
    wireTools: liveToolSchemas,
    system: computeLiveSystem(),
    systemForContext: computeLiveSystem,
    permissions: withEffectBarrier,
    permissionMode: livePermissionMode,
    // Timer estimator kernel tanpa mengubah identitas/perilaku fungsi.
    estimator: Object.assign(
      (text: string): number => {
        const __t = perfEnabled() ? performance.now() : 0
        try {
          return calibratedEstimator(text)
        } finally {
          perfCount("session.estimator.kernel", perfEnabled() ? performance.now() - __t : 0)
        }
      },
      ...(calibratedEstimator.cacheKey ? [{ cacheKey: calibratedEstimator.cacheKey }] : []),
    ),
    recovery: recoveryWithTelemetry,
    executor: parallelExecutor({
      getAuthorizationVersion: () => authorizationVersion,
      concurrency: safeConcurrency ?? LIMITS.EXECUTOR_CONCURRENCY,
      writeConcurrency: safeWriteConcurrency ?? LIMITS.EXECUTOR_WRITE_CONCURRENCY,
    }),
    cwd: defaultCwd,
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(stepCount !== undefined ? { stepCount } : {}),
  })
  // Sink dipasang setelah core ada: event lewat bus yang SAMA dengan langganan
  // TUI (cli/tui.ts melempar `session.events` sebagai UiBus).
  retrySink = (info) => {
    core.events.emit({
      type: "provider:extension",
      kind: RECOVERY_RETRY_EVENT_KIND,
      data: info,
    })
  }
  guardEventSink = (ev) => {
    core.events.emit({
      type: "provider:extension",
      kind: "loop-guard",
      data: ev,
    })
  }
  core.events.on("context:compacted", () => {
    lastProviderInputTokens = undefined
  })
  core.events.on("step:completed", (e) => {
    if ((e as { forwardedChild?: unknown }).forwardedChild == null) {
      activeRecoveryLedger?.resetEpisode()
    }
  })
  core.events.on("turn:completed", (e) => {
    if ((e as { forwardedChild?: unknown }).forwardedChild == null) {
      activeRecoveryLedger?.resetEpisode()
    }
  })
  core.events.on("provider:extension", (e) => {
    if ((e as { forwardedChild?: unknown }).forwardedChild != null) return
    if (e.kind !== "usage") return
    const d = e.data as
      | {
          inputTokens?: number
          outputTokens?: number
          totalTokens?: number
          model?: string
          provider?: string
          source?: string
        }
      | undefined
    if (!d || d.source === "compaction") return
    const reportedModel =
      typeof d.model === "string" && d.model.length > 0
        ? typeof d.provider === "string" && d.provider.length > 0
          ? `${d.provider}::${d.model}`
          : d.model
        : currentContextModel()
    let localEstimatedTokens = lastRequestLocalEstimate?.tokens
    // Hitung estimasi fallback secara lazy: hanya saat estimasi pra-request
    // absen agar tidak meng-clone core.state.history pada setiap event usage SSE.
    if (localEstimatedTokens === undefined) {
      const __fbT = perfEnabled() ? performance.now() : 0
      try {
        localEstimatedTokens =
          estimateSystem(computeLiveSystem(), minicodeEstimator) +
          estimateTools(liveToolSchemas(), minicodeEstimator) +
          estimateMessages(core.state.history, minicodeEstimator)
      } finally {
        perfCount("session.estimateFallback", perfEnabled() ? performance.now() - __fbT : 0)
      }
    }
    // Anchor input nyata (max per turn) = lantai admission request berikutnya.
    if (typeof d.inputTokens === "number" && d.inputTokens > 0) {
      lastProviderInputTokens =
        lastProviderInputTokens === undefined
          ? d.inputTokens
          : Math.max(lastProviderInputTokens, d.inputTokens)
    }
    calibrationFor(reportedModel).observeProviderUsage({
      localEstimatedTokens,
      providerInputTokens: d.inputTokens,
      providerOutputTokens: d.outputTokens,
      providerTotalTokens: d.totalTokens,
    })
  })
  if (detector !== null) {
    core.events.on("execution:completed", (e) => {
      if ((e as { forwardedChild?: unknown }).forwardedChild != null) return
      const call = e.execution?.call as { id?: unknown; name?: unknown; args?: unknown } | undefined
      const result = e.execution?.result as { isError?: unknown; content?: unknown } | undefined
      if (!call || typeof call.name !== "string") return
      const callId = typeof call.id === "string" ? call.id : ""
      detector.recordOutcome({
        id: callId,
        name: call.name,
        args: call.args,
        isError: result?.isError === true,
        content: typeof result?.content === "string" ? result.content : "",
      })
      void detector
        .completePostMutation(
          {
            id: callId,
            name: call.name,
            args: call.args,
            isError: result?.isError === true,
          },
          effectiveRoot,
        )
        .catch(() => {})
    })
    core.events.on("turn:completed", () => {
      detector.noteAssistantResponse()
    })
    core.events.on("context:compacted", () => {
      detector.noteAssistantResponse()
    })
  }
  // Guard volume-baca (opt-in MINICODE_READ_VOLUME_GUARD=1): menghitung char hasil
  // tool per turn dan memperingatkan sekali saat lewat ambang. Guard token hanya
  // peka tekanan TOKEN, bukan working-memory (model 1M bisa baca ribuan baris
  // tanpa kompaksi, nalar menurun diam-diam).
  if (process.env.MINICODE_READ_VOLUME_GUARD === "1") {
    let turnReadChars = 0
    let warnedThisTurn = false
    core.events.on("execution:completed", (e) => {
      if ((e as { forwardedChild?: unknown }).forwardedChild != null) return
      const result = e.execution?.result as { content?: unknown } | undefined
      const text = typeof result?.content === "string" ? result.content : ""
      turnReadChars += text.length
      if (!warnedThisTurn && turnReadChars > LIMITS.TURN_READ_VOLUME_GUARD_CHARS) {
        warnedThisTurn = true
        process.stderr.write(
          `[context] read-volume tinggi turn ini (${turnReadChars} chars ≈ ${Math.round(turnReadChars / 4)} token) tanpa kompaksi — bila task panjang, minta model menulis progres ke file/memory agar fakta tak hilang.\n`,
        )
      }
    })
    core.events.on("turn:completed", () => {
      turnReadChars = 0
      warnedThisTurn = false
    })
  }
  if (safeMaxTurns !== undefined) {
    const origRun = core.run.bind(core)
    core.run = async (input, runOpts) => {
      if (core.state.turnCount >= safeMaxTurns) {
        throw maxTurnsExceededError(safeMaxTurns, core.state.turnCount)
      }
      return origRun(input, runOpts)
    }
  }
  return {
    get state() {
      return core.state
    },
    get events() {
      return core.events
    },
    get contextTokens() {
      return core.contextTokens
    },
    run(
      input: string,
      runOpts?: { signal?: AbortSignal; model?: string; recoveryLedger?: RecoveryLedger },
    ) {
      const myToken = ++runSeq
      // Hanya pemilik core yang menulis state bersama; penolakan "busy" dari
      // run lain tak boleh menjalankan cleanup.
      if (stateOwner === 0) {
        stateOwner = myToken
        activeContextModel = runOpts?.model ?? opts.model
        activeRecoveryLedger = runOpts?.recoveryLedger ?? createRecoveryLedger()
        const startMode: ModeSnapshot = {
          workMode: liveWorkModeForSystem(),
          permissionMode: livePermissionModeForSystem(),
        }
        activeTurnTransitionNote = lastTurnMode
          ? buildModeTransitionNote(lastTurnMode, startMode)
          : ""
        turnSentStream = false
      }
      const modelForRun = runOpts?.model ?? opts.model
      const coreRunOpts =
        runOpts && (runOpts.signal !== undefined || runOpts.model !== undefined)
          ? {
              ...(runOpts.signal !== undefined ? { signal: runOpts.signal } : {}),
              ...(runOpts.model !== undefined ? { model: runOpts.model } : {}),
            }
          : undefined
      return core
        .run(input, coreRunOpts)
        .finally(() => {
          // Bersihkan hanya bila masih pemilik; run "busy" tak boleh menyentuh state aktif.
          if (myToken !== stateOwner) return
          if (turnSentStream) {
            lastTurnMode = {
              workMode: liveWorkModeForSystem(),
              permissionMode: livePermissionModeForSystem(),
            }
          }
          activeTurnTransitionNote = ""
          activeRecoveryLedger = undefined
          turnSentStream = false
          stateOwner = 0
        })
        .catch((error: unknown) => {
          // `budget_exceeded` (reason fixpoint/critical) = bukti jendela terlalu
          // kecil, sama sahnya dengan penolakan provider → eskalasi. Bukan pemicu:
          // max_steps/max_turns/abort/timeout/error non-konteks (max_steps punya
          // jalur sendiri).
          if (error instanceof AgentError && error.kind === "budget_exceeded") {
            const reason = error.details?.reason
            if (reason === "fixpoint" || reason === "critical") {
              const used =
                typeof error.details?.fixedTokens === "number" ? error.details.fixedTokens : 0
              escalateContextWindow(modelForRun, used, true)
            }
          }
          // Mentok batas langkah → naik satu tangga (bounded) untuk turn berikut;
          // kernel sudah meng-commit langkah tuntas via `safeTurnBoundary`,
          // sehingga turn lanjutan melanjutkan konteks tanpa mengulang dari nol.
          if (error instanceof AgentError && error.kind === "max_steps_exceeded") {
            const used = typeof error.details?.steps === "number" ? error.details.steps : 0
            escalateMaxSteps(used)
          }
          throw error
        })
    },
    abort() {
      core.abort()
    },
    /** Steering ke kernel: pesan disisipkan di batas step turn aktif. Keputusan
     * "boleh/tidak" milik kernel (host tak bisa menyisipkan ke sesi idle). */
    steer(text: string) {
      return core.steer(text)
    },
  }
}
