// Setup CLI: orchestrator thin - delegates to src/app/* layers

import { readFileSync, statSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import type { Message, Session, Tool } from "#minicore"
import { AgentError } from "#minicore"
import { createProviderLayer } from "../src/app/provider-layer.ts"
import { createRagLayer } from "../src/app/rag-layer.ts"
import {
  createMinicodeSession,
  createRecoveryLedger,
  type PermissionControl,
  type RecoveryLedger,
  type WorkModeControl,
} from "../src/app/session.ts"
import { computeUnavailableWireTools, setupToolLayer } from "../src/app/tool-layer.ts"
import type { MinicodeConfig } from "../src/config.ts"
import { loadLang, loadLastModel, localConfigNotice } from "../src/config.ts"
import { LIMITS } from "../src/constants.ts"
import { runRunHooks, shouldRunHooks } from "../src/hooks/run.ts"
import { homeDir } from "../src/lib/db-path.ts"
import { type ActivityDeadline, createActivityDeadline } from "../src/lib/liveness-clock.ts"
// [Audit F-04 2026-11-22] Catat ukuran batch flush; nonaktif = no-op O(1).
import { perfCount, perfEnabled } from "../src/lib/perf-debug.ts"
import { closeAllLsp as lspCloseAll, setLspProcessSupervisor } from "../src/lsp/client.ts"
import { closeAll as mcpCloseAll } from "../src/mcp/client.ts"
import { addMemory, promoteOrRejectLessonsBySession } from "../src/memory/vector.ts"
import { findRedirectTargets } from "../src/policy/bash-guard.ts"
import {
  createLlmCompaction,
  isSyntheticSummary,
  registerCompactionSummary,
} from "../src/policy/compaction.ts"
import {
  type AceFailureType,
  type ConsequenceDecision,
  evaluateConsequence,
  isAceEnabled,
} from "../src/policy/consequence-engine.ts"
import { minicodeEstimator } from "../src/policy/context.ts"
import { outputReserveFor } from "../src/policy/context-budget.ts"
import { loadContextWindowOverlay, resolveContextWindow } from "../src/policy/context-window.ts"
import { MICROCOMPACT_SENTINEL_PREFIX } from "../src/policy/microcompact.ts"
import type { NoProgressDetector } from "../src/policy/no-progress.ts"
import type { PermissionAsk } from "../src/policy/permission.ts"
import type { RateLimiter } from "../src/policy/ratelimit.ts"
import {
  type FailureSignal,
  planAutonomousOutageCooldown,
  planRecovery,
  type RecoveryDecision,
} from "../src/policy/recovery-budget.ts"
import { isDangerousShellVerb, splitShellSegments } from "../src/policy/shell-tokenize.ts"
import { WRITE_TOOLS } from "../src/policy/tool-contract.ts"
import {
  budgetExceededError,
  createUsageCollector,
  maxTurnsExceededError,
  primePricing,
  type UsageInitialSnapshot,
  watchBudgetLimit,
} from "../src/policy/usage.ts"
import {
  buildBaselineNote,
  buildVerifySnippet,
  checkBaseline,
  classifyVerifyFailure,
  detectVerifyCommand,
  formatVerifyNotice,
  runVerify,
  runWithSelfHeal,
} from "../src/policy/verifier.ts"
import { VerifyWorkModeConflictError } from "../src/policy/work-mode.ts"
import { createPresentationAdapter, type PresentationAdapter } from "../src/presentation/adapter.ts"
import { type DomainEvent, DURABILITY } from "../src/presentation/events.ts"
import { createInitialState, type PresentationState } from "../src/presentation/model.ts"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
  pendingVerificationObservation,
  projectProvenance,
  provenanceMark,
  verificationMark,
} from "../src/presentation/projection.ts"
import {
  createReducerDiagnostics,
  deriveTurnSummary,
  type ReducerDiagnostics,
  rebuildFromDurable,
  reduce,
} from "../src/presentation/reducer.ts"
import {
  type ContentEntry,
  type ContentStore,
  createContentStore,
} from "../src/presentation/store.ts"
import {
  createProductionExecutionRunner,
  inspectStartupRecovery,
  type ProductionExecutionRunner,
  type RuntimeProductionMode,
  runtimeModeFor,
  type StartupRecoveryReport,
} from "../src/runtime/production-execution.ts"
import {
  createProductionRuntime,
  observeProductionRuntime,
  type ProductionRuntimeHandle,
  runtimeGateFor,
  runtimeJournalPath,
} from "../src/runtime/production-runtime.ts"
import { deriveRuntimeView, evaluateResume } from "../src/runtime/runtime-status.ts"
import type { TaskLayerFacts } from "../src/runtime/runtime-status-facts.ts"
import { installRuntimeStatusProvider } from "../src/runtime/runtime-status-provider.ts"
import { admitTaskWork } from "../src/runtime/runtime-task-admission.ts"
import {
  acquireSessionWriter,
  checkWriterFresh,
  describeSessionHolder,
  releaseSessionWriter,
  renewSessionWriter,
  StaleWriterError,
  writerTokenFor,
} from "../src/session/authority.ts"
import {
  beginTurnSnapshot,
  reconcileUndoRedoPointer,
  recordCheckpointFromSnapshots,
  recordCheckpointFromTrees,
  snapshotWorkspace,
  validateResumeWorkspace,
  workspaceChangedPaths,
} from "../src/session/checkpoint.ts"
import {
  attachHeadlessCompactionBridge,
  type RuntimeContextMetadata,
  runtimeMetadataFromSelection,
} from "../src/session/context-adapter.ts"
import { type ContextOnlyArtifact, stripContextOnly } from "../src/session/context-assembly.ts"
import { deriveFrontierFromDurable } from "../src/session/context-identity.ts"
import {
  produceSummaryProjection,
  readConsumableSummaryProjection,
} from "../src/session/context-projection.ts"
import { rowsToCanonicalRefs, selectContext } from "../src/session/context-selector.ts"
import {
  AdoptionRefusedError,
  type AdoptionResult,
  type AdoptTaskSpec,
  adoptUnfinishedTask,
} from "../src/session/cross-session-adoption.ts"
import { beginSessionDbScope, endSessionDbScope } from "../src/session/db/schema.ts"
import {
  type CanonicalSessionIdentity,
  formatSessionIdentityLine,
  resolveSessionIdentity,
} from "../src/session/identity.ts"
import {
  attachMutationJournal,
  finalizeJournal,
  hashArgs,
  isMutationTool,
  loadJournal,
  loadVerificationJournal,
  planRecoveryForSession,
} from "../src/session/journal.ts"
import {
  beginToolInFlight,
  clearPendingTools,
  endToolInFlight,
  setPendingToolsRun,
} from "../src/session/pending-tools.ts"
import {
  appendPresentationEvents,
  backfillHistoryEventIds,
  beginSessionTurn,
  completeRun,
  countDurableCompactionEvents,
  createRun,
  DEFAULT_THREAD_ID,
  ensureDefaultThread,
  failRun,
  getHistorySummary,
  interruptRun,
  listPersistedTurns,
  loadPresentationEvents,
  loadSession,
  loadSessionMeta,
  loadSessionUsageSummary,
  loadSessionWorkMode,
  loadThreadHistoryWithSeq,
  type PresentationPersistStats,
  presentationHead,
  RefusedHistoryRewriteError,
  readWriterEpoch,
  recordTurnUsage,
  type SessionTurnRecord,
  saveHistorySummary,
  saveSession,
  saveSessionWorkMode,
  settleSessionTurn,
  shrinkThreadHistory,
  ThreadArchivedError,
  terminalizeChildRuns,
  tombstoneDeadRuns,
  tombstoneOrphanChildRuns,
  transitionRun,
} from "../src/session/persistence.ts"
import { recoverRewindWorkspace } from "../src/session/rewind.ts"
import { collectOperationalState } from "../src/session/runtime-header.ts"
import { snapshotTree } from "../src/session/shadow-git.ts"
import {
  captureSessionEvaluationBaseline,
  checkWorkspaceIntegrity,
  collectSessionModifiedFiles,
  detectEvaluationTampering,
} from "../src/session/verification.ts"
import type { Skill } from "../src/skills/loader.ts"
import type { AutonomousSessionSpec } from "../src/task/autonomous-context.ts"
import {
  createProductionScheduler,
  type ProductionSchedulerHandle,
  schedulerGateFor,
} from "../src/task/production-scheduler.ts"
import { SchedulerObservability } from "../src/task/scheduler-observability.ts"
import { SESSION_RENEW_INTERVAL_MS } from "../src/task/session-authority.ts"
import { setTaskTransitionSink, TaskStore } from "../src/task/store.ts"
import { createTaskIdentityResolver, settleSessionVerifyingTasks } from "../src/task/sync.ts"
import {
  classifyToolResult,
  denyReasonOf,
  summarizeArgs,
  writeStepTrace,
} from "../src/telemetry/trace.ts"
import { setAskApprovalHook, setAskTextFn } from "../src/tools/ask_user.ts"
import { killAllBackgroundJobs } from "../src/tools/bash.ts"
import {
  setSubAgentExecutionRunner,
  setSubAgentGovernance,
  setSubAgentParentRouting,
  setSubAgentParentRunId,
  setSubAgentWorkMode,
} from "../src/tools/task.ts"
import {
  readPersistedTaskStateSync,
  reconcileCompletionEvidence,
  setCompletionEvidence,
  syncTodoViewsFromTaskStore,
  todoSession,
} from "../src/tools/todo.ts"
import { promptAsk, promptAskText } from "../src/ui/approval/prompt.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationDiagnostic,
  UiPresentationEvent,
  UiPresentationFinding,
  UiPresentationMessage,
  UiPresentationPlan,
  UiPresentationReasoning,
  UiPresentationResult,
  UiPresentationSnapshot,
  UiPresentationSystem,
  UiPresentationTurn,
  UiToolStatus,
  UiTurnSummary,
} from "../src/ui/contract.ts"
import { sanitizeAnsi } from "../src/ui/render/sanitize.ts"
import { c } from "../src/ui/render/theme.ts"
// [Area A · PROMPT 06] State UI per-sesi. Satu instance per `createCliSession`.
import { UiSessionState } from "../src/ui/session-state.ts"
import {
  createChildCompaction,
  parseVerifyTestEvidence,
  toPresentationEvent,
} from "./bootstrap/presentation-bridge.ts"
import { runSetupWizard } from "./wizard.ts"

/**
 * P2.3 (Session 4): kontrak runtime single-session ditegakkan di boundary RUN,
 * bukan hanya didokumentasikan. Satu proses hanya boleh menjalankan SATU sesi
 * agent pada satu waktu. Konstruksi dua sesi tetap boleh (mis. UI isolation
 * test), dan daemon multi-consumer tetap berjalan karena hanya ada satu sesi.
 * Sesi berikutnya boleh berjalan setelah sesi aktif selesai/ditutup.
 */
let activeAgentSessionId: string | null = null

/**
 * Seam uji deterministik untuk memegang guard tanpa menjalankan provider.
 * Produksi TIDAK pernah memanggil ini; hanya test yang menggunakannya agar
 * tidak bergantung pada timing abort provider nyata.
 */
export function __setActiveAgentSessionForTest(sessionId: string | null): void {
  activeAgentSessionId = sessionId
}

export function __getActiveAgentSessionForTest(): string | null {
  return activeAgentSessionId
}

export class ConcurrentAgentSessionError extends Error {
  readonly code = "CONCURRENT_SESSION"
  constructor(active: string, attempted: string) {
    super(
      `[runtime] CONCURRENT_SESSION: session ${active} is already running in this process; ` +
        `session ${attempted} refused (one agent session per process)`,
    )
    this.name = "ConcurrentAgentSessionError"
  }
}

// Cleanup job background saat proses keluar. `close()` hanya jalan pada shutdown
// normal; handler sinyal di src/ui/tui/app.ts memanggil process.exit() langsung,
// jadi event `exit` adalah satu-satunya titik yang tetap terjangkau pada
// SIGTERM/SIGHUP. `process.exit()` menjalankan handler `exit` (events sinkron),
// berbeda dengan `SIGKILL` yang memang tak bisa dijaring siapa pun.
let backgroundExitCleanupInstalled = false

export function backgroundJobExitCleanup(): void {
  // killAllBackgroundJobs() iterasi map + hapus semua entri → idempoten, aman
  // dipanggil dua kali (dari close() lalu dari exit, atau dari exit berkali-kali).
  killAllBackgroundJobs()
}

export function installBackgroundJobExitCleanup(): void {
  if (backgroundExitCleanupInstalled) return
  backgroundExitCleanupInstalled = true
  process.once("exit", backgroundJobExitCleanup)
}

/**
 * v7.40 (audit): pelepasan lease saat startup GAGAL setelah admission tetapi
 * sebelum `close()` terdaftar. Renew timer (unref) memperpanjang lease tanpa
 * batas; tanpa pembersihan ini sesi berikutnya kena WRITER_REFUSED sampai
 * proses mati. Produksi memanggil lewat closure yang memakai `writerClosed` +
 * `stopWriterRenewTimer` yang SAMA dengan `close()` — bukan state teardown
 * paralel. Diekspor sebagai seam uji (test menyuntik spy, bukan provider nyata).
 *
 * `markClosed` dipanggil sebelum `release` supaya pemanggilan kedua (exit
 * handler setelah cleanup fase startup, atau sebaliknya) jadi no-op —
 * token-guarded release di store juga idempoten, tapi flag ini mencegah
 * pelepasan lease milik sesi lain yang kebetulan memakai token yang sama.
 */
export interface WriterStartupCleanupState {
  readonly isClosed: () => boolean
  readonly markClosed: () => void
  readonly stopRenewTimer: () => void
  readonly release: () => void
}

export function releaseWriterLeaseAfterStartupThrow(state: WriterStartupCleanupState): void {
  // Matikan timer DULU: kalau release gagal sekalipun, jangan biarkan
  // perpanjangan lanjut menyimpan lease mati (fail-closed).
  state.stopRenewTimer()
  if (!state.isClosed()) {
    state.markClosed()
    state.release()
  }
}

export interface CliSessionOptions {
  cwd?: string
  sessionId: string
  resumeId?: string
  // P2.1: id volatil per proses untuk korelasi diagnostik (tak pernah jadi
  // kunci persistensi). Diisi CLI; bila absen, identity resolver yang mint.
  bootId?: string
  modelOverride?: string
  providerOverride?: string
  prompt: string
  enterRepl: boolean
  machineOutput?: boolean
  verbose: boolean
  allowAll: boolean
  ask: boolean
  /**
   * [P13.6] Pengganti ask permission TTY untuk jalur headless (daemon).
   * Default TIDAK diset: `promptAsk` dipakai, dan non-TTY ⇒ deny (fail-closed)
   * — daemon yang lupa memasang apa pun tidak pernah bisa mengizinkan
   * diam-diam. Daemon memasang `ApprovalBroker.asPermissionAsk` supaya
   * konsumen Desktop yang mengusulkan keputusan lewat op `approval.decide`.
   */
  permissionAsk?: PermissionAsk
  allowlist: boolean
  verify: boolean
  /** Audit #07 P0 opt-in: baca .minicode/config.json + allowlist lokal.
   * Default mati (fail-closed); diteruskan ke provider-layer, permission
   * handler, dan perintah REPL yang me-refresh provider. */
  allowLocalConfig?: boolean
  budget?: number
  /** Harness-P1: fail-closed bila cost sesi tak dikenal (model tanpa harga). */
  budgetStrict?: boolean
  /** Harness-P2: scope tool sesi — explore = subset read-only. */
  toolScope?: "full" | "explore"
  /**
   * WorkMode (lapis intent 2-mode di atas profil izin). Default DISCUSS =
   * ceiling read-only/investigasi/diskusi/rencana; EXECUTE (UI: BUILD) =
   * eksekusi penuh sesuai profil izin. TIDAK pernah memperluas permission mode
   * (INV-WM1). Diisi CLI dari --work-mode / MINICODE_WORK_MODE; diserahkan ke
   * setupToolLayer (visibilitas) dan createMinicodeSession (handler ceiling).
   */
  workMode?: "DISCUSS" | "EXECUTE"
  /**
   * Transparansi resume. Benar bila operator memberi sinyal WorkMode eksplisit
   * (--work-mode / MINICODE_WORK_MODE). Saat resume tanpa sinyal eksplisit,
   * WorkMode tersimpan dipulihkan; legacy tanpa nilai kembali ke DISCUSS.
   * Bila scope ini `false` DAN identitas sesi `resumed`, composition
   * root menulis SATU baris stderr human-facing (bukan output machine) agar
   * transisi tidak terjadi diam-diam.
   */
  workModeExplicit?: boolean
  /**
   * [PHASE 6U] Opt-in autonomous Scheduler. DEFAULT OFF - `undefined` and
   * `false` behave identically, and for both the composition root is never called.
   *
   * [DESIGN DECISION] A CLI flag rather than a config key or an env var, so it
   * cannot be inherited by a sub-agent, an MCP server, or an unrelated project.
   * See `src/task/production-scheduler.ts` for why the alternatives were rejected.
   */
  schedulerEnabled?: boolean
  /**
   * [P1 M15] Mode produksi runtime. `off` (default) = jalur legacy utuh;
   * `constructed` = runtime + jurnal dibangun, eksekusi masih legacy;
   * `owned` = admission WAJIB lewat M13 → Kernel (satu jalur, fail-closed).
   *
   * [DESIGN DECISION] Mode, bukan boolean. Boolean M14 (`constructed`) tak dapat
   * membedakan "runtime untuk observasi" dari "runtime yang memiliki eksekusi",
   * dan dua klaim itu tidak boleh ter confuse saat rollback. Nilai tak dikenal
   * gagal ke `off`.
   */
  runtimeMode?: RuntimeProductionMode
  /**
   * [P14] Adopsi eksplisit SATU task unfinished dari sesi sumber. Diisi CLI
   * hanya dari `--adopt-task <source>/<taskId>`.
   *
   * [DESIGN DECISION] Startup-only, bukan slash-command. Transfer mengubah
   * namespace task dan mem-fence penulis sesi sumber; itu keputusan operator
   * yang harus terjadi sebelum turn pertama, bukan di tengah percakapan.
   */
  adoptTask?: AdoptTaskSpec
  /**
   * [P13.6] Seam injeksi uji deterministik untuk append presentasi —
   * satu-satunya titik tulis durable presentasi. Produksi TIDAK mengeset ini;
   * default = `appendPresentationEvents` sesungguhnya (pagar epoch yang sama).
   * Analog dengan seam checkpoint `openExecutionJournal`: test memakainya
   * untuk memaksa kegagalan/penghalang TANPA tidur arbiter.
   */
  presentationAppend?: (events: readonly DomainEvent[]) => Promise<PresentationPersistStats>
  maxSteps?: number
  contextWindowTokens?: number
  /** F3.2: override keepRecentTurns kompaksi kernel (berapa turn terakhir
   * dipertahankan saat kompaksi). Default = kernel (DEFAULT_KEEP_RECENT_TURNS).
   * Diisi dari env MINICODE_COMPACT_KEEP_TURNS (bilangan >=1, selain itu
   * diabaikan + warn di composition root). */
  keepRecentTurns?: number
  timeoutMs?: number
  /** Batas keras waktu kalender opsional (`--wall-timeout` / MINICODE_WALL_TIMEOUT_MS). Absen = tak dibatasi (hanya watchdog inaktivitas). */
  wallTimeoutMs?: number
  /** Mode otonom jangka panjang (jam/hari): pemulihan outage bertingkat + guardrail biaya/stagnasi + epoch lanjut otomatis. */
  autonomous?: boolean
  /** Ambil alih paksa lease bila PID pemilik sebelumnya terbukti mati di OS. */
  takeover?: boolean
  /** Maksimum epoch otomatis beruntun di mode otonom (0/undefined = tak dibatasi selain circuit breaker). */
  maxEpochs?: number
  /** Plafon belanja per jam (USD) sebagai circuit breaker otonom. */
  maxCostHour?: number
  rateLimiter?: RateLimiter
  concurrency?: number
  writeConcurrency?: number
  /** Notice sandbox — hanya bila user eksplisit meminta mode (flag/env tak
   * kosong): mis. daemon tak tersedia atau mode tak dikenal. Notice rutin
   * (auto-os / auto-allowlist) sengaja disembunyikan: mode sudah terlihat di
   * prefiks prompt. Dicetak di sini (setelah provider layer lolos) supaya
   * invokasi yang mati sebelumnya tetap senyap. */
  sandboxNotice?: string
  /**
   * Hook fase startup (bar loading). Dipanggil saat fase panjang mulai:
   * "provider-layer", "rag-layer", "tool-layer", "kernel-session", "resume".
   * Optional — absen = tanpa progres (perilaku lama).
   */
  onPhase?: (phase: string) => void
}

export interface CliSession {
  session: Session
  cfg: MinicodeConfig
  cwd?: string
  sessionId: string
  // P2.1: identitas kanonik (durable) vs volatil (proses) — jangan tertukar.
  bootId: string
  // P2.2: generasi pagar penulis saat admission (observability; mutasi
  // memakai CAS in-txn, bukan nilai ini). Token otoritas SENGAJA tak
  // diekspos — tak ada konsumen yang butuh mencetaknya.
  writerEpoch: number
  isWriterStale: () => boolean
  writerStaleNote: () => string
  /**
   * [Stage 5B] Bukti kegagalan checkpoint (dicatat, tak hilang senyap).
   * Pesan error internal saja — tak ada credential di jalur ini.
   */
  checkpointFailures: () => string[]
  /**
   * [Stage 5B] Operasi checkpoint yang masih berjalan. Setelah `close()`
   * selesai HARUS 0 — `close()` adalah barrier lifecycle.
   */
  pendingCheckpointCount: () => number
  modelRef: { current?: string }
  effectiveInitialModel: string
  effectiveTimeoutMs: number
  effectiveWallTimeoutMs?: number
  autonomous?: boolean
  maxEpochs?: number
  maxCostHour?: number
  permissionMode: string
  /** WorkMode efektif sesi ini (default DISCUSS). Dipakai label/
   * readout TUI; diisi composition root dari flag/env. */
  workMode: "DISCUSS" | "EXECUTE"
  /** P12 S2.2 Slice 5 — handle kontrol WorkMode runtime (transisi operator
   * lewat command `/work-mode`). Undefined bila sesi memakai handler izin
   * terinjeksi (policy, bukan mode — fail-closed). */
  workModeControl?: WorkModeControl
  sessionTools: Tool[]
  allLoadedSkills: Skill[]
  usage: ReturnType<typeof createUsageCollector>
  budget?: number
  budgetStrict?: boolean
  /** F-CTX-1: jendela konteks yang dipakai footer TUI (window %) — flag --context-window. */
  contextWindowTokens?: number
  /** Jendela dinamis mengikuti model yang dipilih saat sesi berjalan. */
  getContextWindowTokens?: () => number
  /** Flag opt-in local config sesi ini — dipakai perintah REPL (/sync,
   * /provider, /model) agar konsisten dengan provider/tool yang aktif. */
  allowLocalConfig: boolean
  /** P2.3: jumlah hit RAG memory yang di-inject ke system prompt sesi ini. */
  memoryHits: number
  detachSimple: () => void
  /**
   * [Area A · PROMPT 06] State UI milik SESI ini (collapse/detail/reasoning +
   * buffer /copy + error tertunda). SATU instance per sesi; TUI dan printer
   * linier sesi yang sama berbagi instance ini, sedangkan sesi lain di proses
   * yang sama punya instance sendiri — dua sesi tak saling menimpa.
   */
  uiState: UiSessionState
  persistCurrent: (usageData: unknown) => Promise<void>
  runPromptWithVerify: (prompt: string, signal?: AbortSignal) => Promise<void>
  /**
   * P2.3 daemon: identitas/status run untuk operator control. runId berasal
   * dari jurnal Run kanonik (bukan id sintetis daemon); status RUNNING selama
   * turn berjalan, lalu status terminal terakhir (INTERRUPTED/FAILED/COMPLETED)
   * tetap terbaca sampai turn berikutnya mulai. Absen (null) = belum ada run
   * di sesi ini.
   */
  runState: () => {
    runId: string | null
    status: "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED" | null
  }
  /**
   * P11.1 — ringkasan hasil verify terakhir, read-only untuk summary mesin
   * (`exec --json`). Null bila verify belum pernah jalan di sesi ini.
   * Hanya ok+command (output verify tetap di stderr/stream, tak ikut
   * summary); snapshot disalin agar pemanggil tak bisa memutasi state sesi.
   */
  getLastVerifyResult: () => { ok: boolean; command: string } | null
  /**
   * P3.5 — metadata runtime hasil seleksi konteks (host-side, RAM, lifecycle-
   * scoped). Bukan store/otoritas; hanya membawa identity/frontier/revision/
   * basis/freshness melewati batas seed runtime. Undefined bila sesi bukan resume
   * (tidak ada ContextSelection).
   */
  runtimeContextMetadata?: RuntimeContextMetadata
  /** Kontrol mode permission saat runtime (Shift+Tab / /mode di REPL). */
  permissions?: PermissionControl
  close: () => Promise<void>
  /** Counter reducer presentasi (divergensi harus 0). */
  getShadowDiagnostics: () => {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
    unknownEvent: number
    orphanEvidence: number
    unsupportedProjection: number
  }
  /** Content store untuk /expand [id]. */
  expandContent: (toolCallId: string) => ContentEntry[]
  expandAllContent: () => ContentEntry[]
  getPresentationSnapshot: () => UiPresentationSnapshot
  onPresentationEvent: (handler: (event: UiPresentationEvent) => void) => () => void
  /**
   * [P13.5] DomainEvent mentah — bentuk yang SAMA dengan yang dipersist durable.
   *
   * Kenapa terpisah dari `onPresentationEvent`: proyeksi UI memakai field `seq`
   * dan membuang detail domain (eventSeq/sessionId/lineage). Feed daemon
   * membutuhkan bentuk DomainEvent agar live dan replay berbicara bahasa yang
   * sama; melakukan cast proyeksi ke DomainEvent membuat `eventSeq` hilang dan
   * seluruh live feed diam. Subscriber di sini menerima event sebelum proyeksi.
   */
  onDomainEvent: (handler: (event: DomainEvent) => void) => () => void
  /**
   * [PHASE 6AB] The trigger handle, exposed.
   *
   * 6AA's blocker was precisely that this was NOT here: `createProductionScheduler`
   * returned a real, authority-holding handle that `cli/setup.ts` kept in a local
   * and called exactly one method on - `stop()`. Nothing else in the process could
   * reach `fire()`, so an enabled Scheduler could never be made to do anything.
   *
   * [DESIGN DECISION] Ownership stays with the production runtime, which is what
   * this object is. The handle is deliberately NOT written into TaskStore,
   * TaskGraph, task state or a module-level singleton: it holds an AbortController,
   * a lease token and a subscription, none of which belong in durable state, and a
   * global would make the per-session scoping 6T designed for impossible to keep.
   * Exactly one session owns exactly one handle, and that session is `sessionId`.
   */
  productionScheduler: ProductionSchedulerHandle
  /** [P1 M14] Operator/runtime projection — the P1 runtime owner of this session. */
  productionRuntime: ProductionRuntimeHandle
  /** [P1 M15] Mode runtime sesi ini (off | constructed | owned). */
  runtimeMode: RuntimeProductionMode
  /** [P1 M15] Admission runtime untuk turn sesi ini. */
  executionRunner: ProductionExecutionRunner
  /** [P1 M15] Bukti durable saat start: integritas jurnal + tafsir M12. */
  startupRecovery: StartupRecoveryReport | null
  /** [PHASE 6AB] Operator projection fed by the Scheduler's own event stream. */
  schedulerObservability: SchedulerObservability
  /**
   * [P14] Hasil adopsi lintas sesi saat startup, atau null bila flag tidak
   * dipakai. Dikembalikan agar tes/operator dapat memeriksa outcome tanpa
   * membaca ulang pesan stderr.
   */
  adoption: AdoptionResult | null
  /**
   * Baris diagnostik startup yang didefer (hanya terisi saat enterRepl —
   * bar loading menggantikan teks proses). Di-flush ke transcript TUI oleh
   * cli/tui.ts. Absen/undefined = tidak ada deferral (perilaku lama).
   */
  startupNotices?: string[]
}

export { createChildCompaction, parseVerifyTestEvidence, toPresentationEvent }

/**
 * WorkMode efektif = sinyal eksplisit operator > WorkMode tersimpan > default CLI.
 * Sebelumnya hanya `identity.resumed` yang memicu pulihan, sehingga `--session`
 * yang menimpa baris EXECUTE memakai default DISCUSS dan menimpanya lewat
 * createSession/saveSessionWorkMode. Sekarang keberadaan baris durable saja sudah
 * cukup (takeover maupun resume) — `--resume` tetap tak berubah perilakunya.
 */
export function resolveWorkModeForIdentity(
  identity: Pick<CanonicalSessionIdentity, "sid" | "resumed" | "hasStoredSession">,
  workMode: "DISCUSS" | "EXECUTE",
  workModeExplicit: boolean,
  cwd?: string,
): { persistedWorkMode?: "DISCUSS" | "EXECUTE"; effectiveWorkMode: "DISCUSS" | "EXECUTE" } {
  const hasStored = identity.resumed || identity.hasStoredSession
  const persistedWorkMode = hasStored ? loadSessionWorkMode(identity.sid, cwd) : undefined
  return {
    ...(persistedWorkMode !== undefined ? { persistedWorkMode } : {}),
    effectiveWorkMode: hasStored && !workModeExplicit ? (persistedWorkMode ?? "DISCUSS") : workMode,
  }
}

/**
 * v7.41 (audit #1) — kunci idempotency produksi.
 *
 * KUNCI = tool + hash args + NOMOR GENERASI. Generasi naik SATU kali per
 * `runPromptWithVerify` (satu prompt user), bukan per retry: retry provider
 * memanggil ulang `runPromptWithVerifyImpl` di dalam SATU loop yang sama, jadi
 * `generation` tetap → tool call yang sama (tool+args identik) memakai kunci yang
 * SAMA → dedup durabel menolak eksekusi kedua. Prompt user berikutnya menaikkan
 * generasi → kunci BERBEDA → tulis identik yang memang baru tetap diizinkan.
 *
 * Kenapa tidak memakai toolCallId kernel: `ctx` yang dipegang tool TIDAK
 * mengandung id itu (lihat vendor/minicore/src/core/tool.ts), dan provider bisa
 * mengganti id saat turn di-generate ulang. `generation` yang dikendalikan
 * composition root adalah sumber yang deterministik dan berada di dalam
 * kepemilikan lapisan ini.
 *
 * Tradeoff yang disengaja: dua call identik dalam SATU generasi (satu turn) akan
 * berbagi kunci → yang kedua ditolak (fail-closed). Ini lebih aman daripada
 * membiarkan efek non-idempoten ter-apply dua kali saat recovery.
 */
const READ_ONLY_BASH_HEAD =
  /^(?:ls|dir|pwd|cat|type|head|tail|wc|rg|grep|egrep|fgrep|findstr|where|which|echo|more|sort|uniq)$/i

/**
 * Klasifikasi sempit perintah `bash` observasi murni tanpa efek samping agar
 * pemanggilan ulang pasca-kompaksi / step baru (`git status --short`, `dir /b`)
 * tidak ditolak idempotency berbasis seluruh prompt.
 */
export function isReadOnlyObservationBash(args: unknown): boolean {
  if (!args || typeof args !== "object") return false
  const rec = args as Record<string, unknown>
  const raw =
    typeof rec.cmd === "string" ? rec.cmd : typeof rec.command === "string" ? rec.command : ""
  const cmd = raw.trim()
  if (!cmd) return false
  if (/\$\(|`/.test(cmd)) return false
  if (findRedirectTargets(cmd).length > 0) return false
  const segments = splitShellSegments(cmd)
  if (segments.length === 0) return false
  for (const seg of segments) {
    if (isDangerousShellVerb(seg)) return false
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    const head = (tokens[0] ?? "").toLowerCase()
    if (!head) return false
    if (READ_ONLY_BASH_HEAD.test(head)) continue
    if (head === "git") {
      const sub = (tokens[1] ?? "").toLowerCase()
      if (/^(?:status|log|diff|show|rev-parse|ls-files|describe)$/.test(sub)) continue
      if (
        sub === "branch" &&
        !tokens.some((tok) => /^-(?:[dDmMcC]|-delete|-move|-copy)$/.test(tok))
      )
        continue
      return false
    }
    if (head === "sed") {
      if (tokens.some((tok) => /^-(?:i|-in-place)(?:=|$)/.test(tok))) return false
      if (tokens.some((tok) => /^-(?:n|-quiet|-silent)$/.test(tok))) continue
      return false
    }
    if (head === "find") {
      if (tokens.some((tok) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fls)$/.test(tok))) {
        return false
      }
      continue
    }
    return false
  }
  return true
}

export function productionIdempotencyKey(
  tool: string,
  args: unknown,
  generation: number,
  mutationEpoch?: number,
  observationEpoch?: number,
): string {
  const suffix = typeof mutationEpoch === "number" && mutationEpoch > 0 ? `:m${mutationEpoch}` : ""
  const obsSuffix =
    typeof observationEpoch === "number" && observationEpoch > 0 ? `:o${observationEpoch}` : ""
  return `${tool}:${hashArgs(args ?? {})}:gen${generation}${suffix}${obsSuffix}`
}

/**
 * v7.41 (audit #2 / F2) — gerbang publish DomainEvent yang diurutkan oleh
 * `eventSeq`. Event durable hanya boleh live SETELAH append terkonfirmasi
 * (`confirmDurable`); event non-durable boleh langsung, TAPI ditahan di belakang
 * durable yang masih tertahan supaya subscriber Seq-keyed tak pernah menerima
 * seq kecil SESUDAH seq besar (konsumen membuang seq kecil itu sebagai duplikat).
 *
 * Diekstrak ke helper murni supaya kontrak urutannya bisa diuji hermetik tanpa
 * sesi/SQLite/provider.
 */
export function createOrderedDomainPublisher(
  publish: (event: DomainEvent) => void,
  isDurable: (event: DomainEvent) => boolean,
): {
  enqueue: (event: DomainEvent) => void
  confirmDurable: (eventSeq: number) => void
  /** Buang event yang append-nya GAGAL — jangan pernah dipublish sebagai live. */
  drop: (events: readonly DomainEvent[]) => void
  drain: () => void
  pending: () => readonly DomainEvent[]
} {
  const queue: DomainEvent[] = []
  let durableFloor = -1
  let publishedSeq = -1
  const drain = (): void => {
    while (queue.length > 0) {
      const head = queue[0]!
      // Durable yang belum terkonfirmasi ditahan — bersama semua event di
      // belakangnya — agar urutan seq di subscriber tetap monoton naik.
      if (isDurable(head) && head.eventSeq > durableFloor) break
      queue.shift()
      if (head.eventSeq > publishedSeq) {
        publishedSeq = head.eventSeq
        publish(head)
      }
    }
  }
  return {
    enqueue(event) {
      queue.push(event)
      drain()
    },
    confirmDurable(eventSeq) {
      if (eventSeq > durableFloor) durableFloor = eventSeq
      drain()
    },
    drop(events) {
      // Identitas objek: event yang sama dipush ke queue saat enqueue dan
      // dikirim ke append. Append gagal ⇒ event itu tak pernah durable ⇒
      // harus dibuang, bukan ditahan sampai confirmDurable berikutnya (yang
      // akan mempublikasikannya secara palsu sebagai sudah-durable).
      const doomed = new Set(events)
      for (let i = queue.length - 1; i >= 0; i--) {
        if (doomed.has(queue[i]!)) queue.splice(i, 1)
      }
      drain()
    },
    drain,
    pending: () => queue.slice(),
  }
}

export async function createCliSession(opts: CliSessionOptions): Promise<CliSession> {
  const {
    cwd,
    sessionId: sessionFlag,
    resumeId,
    bootId: bootIdOpt,
    modelOverride,
    providerOverride,
    prompt,
    enterRepl,
    machineOutput = false,
    verbose,
    allowAll,
    ask,
    allowlist,
    verify,
    budget,
    budgetStrict,
    toolScope,
    schedulerEnabled,
    runtimeMode,
    adoptTask,
    allowLocalConfig,
    workMode = "DISCUSS",
    workModeExplicit = false,
    maxSteps,
    contextWindowTokens,
    keepRecentTurns,
    timeoutMs,
    wallTimeoutMs,
    autonomous = false,
    takeover = false,
    maxEpochs,
    maxCostHour,
    rateLimiter,
    sandboxNotice,
    onPhase,
  } = opts
  // [Area A · PROMPT 06] State UI milik SESI ini. Dibuat SEKALI per sesi dan
  // dipakai bersama oleh TUI (Transcript) + printer linier sesi yang sama.
  // Env hanya jadi nilai awal; sesi lain di proses yang sama punya state
  // sendiri sehingga tak saling menimpa collapse/compact/reasoning.
  const uiState = new UiSessionState()
  // Pasang sekali per proses: jalur sinyal (process.exit) tak pernah menjalankan
  // close(), jadi cleanup job background harus punya jalur `exit` yang pasti.
  installBackgroundJobExitCleanup()
  const modelRef = { current: modelOverride }
  // Collector diagnostik startup. Saat REPL + stderr TTY, bar loading
  // menggantikan teks proses verbose — baris diagnostik (resume/recovery/
  // context/dll) DITUNDA dan di-flush ke transcript TUI setelah sesi siap
  // (lihat cli/tui.ts). Non-interaktif ATAU non-TTY (pipe/CI) tetap
  // mencetak langsung seperti sebelumnya — tidak ada diagnostik yang bisa
  // hilang di jalur yang tak punya transcript.
  const deferStartup = enterRepl && process.stderr.isTTY === true
  const startupNotices: string[] = []
  const startupWrite = (s: string): void => {
    if (deferStartup) startupNotices.push(s)
    else process.stderr.write(s)
  }
  // `console.error` dipertahankan pada jalur non-interaktif (spy test
  // menangkap baris provenance resume lewat console.error), tapi didefer
  // saat REPL agar bar loading tetap satu-baris.
  const startupConsoleError = (s: string): void => {
    if (deferStartup) startupNotices.push(s)
    else console.error(s)
  }
  // P2.1 — SATU-SATUNYA keputusan identitas sesi. Sesudah baris ini,
  // `sessionId` adalah identitas kanonik durable; id volatil hanya `bootId`
  // (diagnostik). Tak ada jalur persistensi khusus alias: semua turunan
  // (jurnal, checkpoint, todos, runtime journal, scheduler) memakai sid.
  // --resume tak dikenal melempar SessionNotFoundError (eksplisit, bukan
  // sesi baru diam-diam).
  const rewindResume = await recoverRewindWorkspace(cwd ?? process.cwd(), resumeId)
  if (rewindResume) startupWrite(`[rewind] resuming active branch ${rewindResume}\n`)
  const identity = resolveSessionIdentity({
    sessionFlag: sessionFlag,
    resumeFlag: rewindResume ?? resumeId,
    cwd,
    ...(bootIdOpt ? { bootId: bootIdOpt } : {}),
  })
  const sessionId = identity.sid
  const bootId = identity.bootId
  // Identitas internal (sid/boot) — hanya --verbose; "resumed session …" sudah human-friendly.
  if (verbose) startupWrite(`${c.dim(formatSessionIdentityLine(identity))}\n`)

  // P2.2 — admission penulis tunggal. Lease = admission; pagar mutasi =
  // writer_epoch (CAS di transaksi tulis). Komposisi ini MEMEGANG lease
  // selama hidupnya (token milik boot ini, dibagi dengan scheduler-nya
  // sendiri) dan melepasnya saat close. Penulis asing yang hidup →REFUSED
  // di sini (fail-closed); penulis basi ditolak di tiap mutasi (CAS).
  let dbScopeReleased = false
  beginSessionDbScope(cwd)
  const releaseDbScope = () => {
    if (dbScopeReleased) return
    dbScopeReleased = true
    endSessionDbScope(cwd)
  }
  const writerToken = writerTokenFor(bootId)
  let admission: ReturnType<typeof acquireSessionWriter>
  try {
    admission = acquireSessionWriter({
      sessionId,
      cwd,
      bootId,
      token: writerToken,
      ...(takeover ? { allowDeadPidTakeover: true } : {}),
    })
    if (!admission.ok) throw admission.error
  } catch (err) {
    releaseDbScope()
    throw err
  }
  // v7.39 (P0-1): general startup repair untuk mode interaktif. Sebelumnya
  // JSON↔TaskStore hanya diselaraskan saat adoption/verify-settle/scheduler
  // claim — sehingga sesi yang crash di tengah `todo_write` bisa boot dengan
  // view JSON phantom. Re-derive dari TaskStore (otoritas) SEKALI di sini,
  // best-effort, sebelum ada interaksi model.
  await syncTodoViewsFromTaskStore(sessionId, cwd ?? process.cwd()).catch(() => undefined)
  let expectedEpoch = admission.admission.epoch
  let writerStale = false
  let writerStaleNote = ""
  const markWriterStale = (note: string): void => {
    if (!writerStale) {
      writerStale = true
      writerStaleNote = note
      startupWrite(
        `${c.yellow(`[writer] STALE sid=${sessionId} boot=${bootId} epoch=${expectedEpoch}: ${note} — history NOT durable; resume/restart to re-acquire\n`)}`,
      )
    }
  }
  // Lease sukses = internal; hanya --verbose (STALE/lease-lost tetap tampil).
  if (verbose)
    startupWrite(
      `${c.dim(`[writer] admitted sid=${sessionId} boot=${bootId} epoch=${expectedEpoch}${admission.admission.tookOver ? " (takeover)" : ""}${admission.admission.fresh ? " (fresh)" : ""}\n`)}`,
    )
  // [P14] Adopsi eksplisit berjalan SETELAH admission target (token target
  // sudah sah) dan SEBELUM turn pertama. Gagal = lepas lease target lalu
  // lempar error terklasifikasi; jangan pernah meninggalkan target terkunci
  // oleh proses yang tidak jadi berjalan.
  let adoption: AdoptionResult | null = null
  if (adoptTask) {
    adoption = adoptUnfinishedTask({
      sourceSessionId: adoptTask.sourceSessionId,
      targetSessionId: sessionId,
      taskId: adoptTask.taskId,
      targetOwnerToken: writerToken,
      bootId,
      cwd,
    })
    if (adoption.outcome !== "ADOPTED") {
      releaseSessionWriter(sessionId, writerToken, cwd)
      releaseDbScope()
      throw new AdoptionRefusedError(adoption)
    }
    const moved = adoption.task
    await syncTodoViewsFromTaskStore(sessionId, cwd ?? process.cwd()).catch(() => undefined)
    startupWrite(
      `${c.dim(`[adopt] ADOPTED ${adoptTask.taskId} ${adoptTask.sourceSessionId} -> ${sessionId} revision=${moved?.revision ?? "?"} status=${moved?.status ?? "?"} exec=${adoption.transfer?.execGeneration ?? "?"}${adoption.fencedFormerOwner ? " (former owner fenced)" : ""}\n`)}`,
    )
  }
  // P0.2 (Q5): saat `--resume` tanpa sinyal WorkMode eksplisit, pulihkan
  // WorkMode tersimpan dari metadata sesi (NULL/PLAN legacy → default DISCUSS).
  const { persistedWorkMode, effectiveWorkMode } = resolveWorkModeForIdentity(
    identity,
    workMode,
    workModeExplicit,
    cwd,
  )
  // P0.2 (Q4): tolak startup (fail-closed) bila `--verify` digabung dengan
  // WorkMode DISCUSS (baik dari flag/env maupun pulihan `--resume`).
  if (verify && effectiveWorkMode !== "EXECUTE") {
    releaseSessionWriter(sessionId, writerToken, cwd)
    releaseDbScope()
    throw new VerifyWorkModeConflictError(effectiveWorkMode)
  }
  // P2.6 — kubur residu crash: RUNNING tanpa holder hidup (admission di atas
  // membuktikan tak ada penulis hidup) → INTERRUPTED/UNKNOWN. BUKAN
  // auto-continue/replay; tanpa ini satu crash mengganjal RUNNING unik
  // selamanya. Fenced, idempoten.
  tombstoneDeadRuns(sessionId, cwd, { expectedEpoch })
  // P2.9 — orphan Sub-Agent: Run anak yang masih RUNNING sementara parent
  // sudah terminal/crash → INTERRUPTED + UNKNOWN (P2.6 semantics: kematian tak
  // terobservasi, JANGAN pernah disimpulkan COMPLETED). Tidak ada auto-continue.
  try {
    const orphans = tombstoneOrphanChildRuns(sessionId, cwd, { expectedEpoch })
    if (orphans.length > 0) {
      startupWrite(
        `${c.yellow(`[child] ${orphans.length} orphaned sub-agent run(s) tombstoned (INTERRUPTED/UNKNOWN)\n`)}`,
      )
    }
  } catch {}
  // P2.2 — heartbeat lease milik boot ini (pola yang sama dengan scheduler:
  // unref + dibersihkan saat close). Tanpa ini sesi REPL yang idle > lease
  // kehilangan admission dan take-over asing menjadi mungkin di tengah sesi.
  // Perpanjangan TAK PERNAH menyentuh writer_epoch (§16).
  let writerRenewTimer: ReturnType<typeof setInterval> | undefined
  let renewWarned = false
  let writerClosed = false
  // v7.40 (re-audit): bedakan GAGAL startup dari crash SETELAH startup sukses.
  // `exit` saat startup gagal → lease dilepas; `exit` tanpa close() setelah
  // startup sukses → lease HARUS mengorphan sampai expiry (kontrak 6AD S7).
  // Tanpa flag ini safety-net menyamakan keduanya dan membatalkan eksklusivitas
  // penulis lintas-proses.
  let startupSucceeded = false
  const stopWriterRenewTimer = () => {
    try {
      if (writerRenewTimer !== undefined) clearInterval(writerRenewTimer)
    } catch {}
    writerRenewTimer = undefined
  }
  const startWriterRenewTimer = () => {
    if (writerClosed || writerRenewTimer !== undefined) return
    renewWarned = false
    let transientRenewFailures = 0
    writerRenewTimer = setInterval(() => {
      try {
        const out = renewSessionWriter(sessionId, writerToken, cwd)
        transientRenewFailures = 0
        if (out === "AUTHORITY_LOST") {
          stopWriterRenewTimer()
          // Lease tanpa pemilik aktif & epoch sama = dilepas bersih `/scheduler stop`; re-acquire di turn berikutnya.
          const holder = describeSessionHolder(sessionId, cwd)
          if (!holder.active && readWriterEpoch(sessionId, cwd) === expectedEpoch) {
            return
          }
          if (!renewWarned) {
            renewWarned = true
            startupWrite(
              `${c.yellow(`[writer] lease lost sid=${sessionId} boot=${bootId} — another writer took over; next mutation will be refused unless re-acquired\n`)}`,
            )
          }
        }
      } catch (err) {
        // Kegagalan sementara SQLite I/O/BUSY tak boleh menjatuhkan unhandled error keluar dari timer.
        transientRenewFailures++
        if (transientRenewFailures >= 3 && !renewWarned) {
          renewWarned = true
          startupWrite(
            `${c.yellow(`[writer] lease renew transient error sid=${sessionId}: ${String((err as Error)?.message ?? err)}\n`)}`,
          )
        }
      }
    }, SESSION_RENEW_INTERVAL_MS)
    writerRenewTimer.unref?.()
  }
  startWriterRenewTimer()

  // v7.40 (audit): safety net untuk galat tak tertangkap antara admission dan
  // terdaftarnya `close()`. Renew timer di atas menjaga lease tetap hidup;
  // bila startup melempar sebelum `close()` sempat membersihkan, listener
  // `exit` inilah yang melepas lease + mematikan timer saat proses berakhir.
  // Memakai `writerClosed`/`stopWriterRenewTimer` yang sama dengan `close()`,
  // jadi tak ada state teardown kedua yang bisa beda pendapat.
  const cleanupWriterOnStartupFailure = () => {
    // v7.40 (re-audit): setelah startup sukses, safety-net TIDAK boleh melepas
    // lease. `process.exit()` tanpa close() (crash/kill) justru harus
    // meninggalkan lease orphan yang memblokir takeover sampai expiry (6AD S7).
    // `writerClosed` hanya menjaga jalur close(); flag ini menjaga jalur exit.
    if (startupSucceeded) return
    releaseWriterLeaseAfterStartupThrow({
      isClosed: () => writerClosed,
      markClosed: () => {
        writerClosed = true
      },
      stopRenewTimer: stopWriterRenewTimer,
      release: () => releaseSessionWriter(sessionId, writerToken, cwd),
    })
    releaseDbScope()
  }
  process.once("exit", cleanupWriterOnStartupFailure)

  // P2.2 — pagar pra-turn. JANGAN belanjakan provider untuk turn yang tak
  // bisa persist: basi → lewati turn (histori kernel utuh) + flag untuk
  // exit jujur one-shot / transcript TUI. Tak melempar (aman loop TUI).
  // Akuisisi-ulang di sini menutup kasus lease bersama yang dilepas
  // scheduler-stop di tengah sesi (baris hilang ≠ asing hidup).
  function ensureWriterFresh(): boolean {
    if (writerStale) return false
    const seen = checkWriterFresh(sessionId, writerToken, expectedEpoch, cwd)
    if (seen.fresh) return true
    if (seen.epoch === expectedEpoch) {
      const re = acquireSessionWriter({ sessionId, cwd, bootId, token: writerToken })
      if (re.ok) {
        if (re.admission.epoch !== expectedEpoch) {
          startupWrite(
            `${c.dim(`[writer] re-acquired sid=${sessionId} boot=${bootId} epoch=${re.admission.epoch}\n`)}`,
          )
        }
        expectedEpoch = re.admission.epoch
        startWriterRenewTimer()
        return true
      }
      markWriterStale("pre-turn authority refused (lease held by another writer)")
      return false
    }
    markWriterStale(`pre-turn epoch mismatch (expected ${expectedEpoch}, actual ${seen.epoch})`)
    return false
  }

  // P2.6 — Run durably per turn-invokasi (komposisi, BUKAN loop: kernel tak
  // tersentuh). Satu invokasi = satu Run: dibuat RUNNING saat mulai, kursor
  // maju di persistCurrent (atomik histori+kursor), terminal DITANDAI saat
  // turn berikutnya dimulai / close (persist selalu mendahului penandaan,
  // sehingga kursor tak pernah maju di baris terminal). Crash di antaranya =
  // baris RUNNING → kuburan resume (tombstone) menandainya INTERRUPTED/UNKNOWN.
  let currentRunId: string | null = null
  // Run terakhir yang sudah terminal, dipertahankan sampai turn berikutnya
  // mulai. `markPreviousRunTerminal` sengaja menutup run segera (agar tak ada
  // RUNNING yatim), tetapi konsumen `runState()` berhak melihat outcome
  // INTERRUPTED/FAILED/COMPLETED yang baru terjadi — tanpa ini status terminal
  // hanya bisa tertangkap balapan polling sebelum baris DB ditutup.
  let lastTerminalRun: {
    runId: string
    status: "COMPLETED" | "FAILED" | "INTERRUPTED"
  } | null = null
  let lastTurnOutcome: "completed" | "failed" | "interrupted" | null = null
  // [Fase 1 / LOOP-INV-03] Handle jurnal yang dipakai barrier pre-efek.
  // Deklarasi SEBELUM session dibuat agar closure `beforeToolEffect` di bawah
  // menangkap binding yang sudah ada (tanpa TDZ), dan diisi tepat setelah
  // `attachMutationJournal` (masih sebelum turn pertama).
  let journalHandle: import("../src/session/journal.ts").MutationJournalHandle | null = null

  function markPreviousRunTerminal(): void {
    if (currentRunId === null || lastTurnOutcome === null) return
    const runId = currentRunId
    const outcome = lastTurnOutcome
    currentRunId = null
    lastTurnOutcome = null
    lastTerminalRun = {
      runId,
      status:
        outcome === "completed"
          ? "COMPLETED"
          : outcome === "interrupted"
            ? "INTERRUPTED"
            : "FAILED",
    }
    // [Fase 1 / LOOP-INV-06, LOOP-INV-10] Hanya run yang berakhir NORMAL yang
    // membersihkan `pending_tool_ids`. Untuk INTERRUPTED/FAILED daftar sengaja
    // DIBIARKAN: ia bukti forensik bahwa operasi masih terbuka, dan recovery
    // tidak boleh menyimpulkan "selesai" dari ketiadaan bukti.
    if (outcome === "completed") clearPendingTools()
    setPendingToolsRun(null, cwd)
    if (outcome === "completed") completeRun(runId, cwd, { expectedEpoch })
    else if (outcome === "interrupted") interruptRun(runId, cwd, { expectedEpoch })
    else failRun(runId, cwd, { expectedEpoch })
  }

  function classifyTurnError(e: unknown, aborted: boolean): "failed" | "interrupted" {
    if (aborted) return "interrupted"
    // Struktural (tanpa import kelas vendor): kind kernel aborted/timeout =
    // interupsi; sisanya kegagalan. Tak ada tebakan "selesai".
    const kind = (e as { kind?: unknown })?.kind
    if (kind === "aborted" || kind === "timeout") return "interrupted"
    return "failed"
  }

  // Diagnosis startup lambat: MINICODE_DEBUG_STARTUP=1 mencetak durasi tiap
  // fase session-setup ke stderr (`[startup] rag 8432ms`). Tanpa env = diam.
  const startupPhase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now()
    try {
      onPhase?.(name)
      return await fn()
    } catch (e) {
      // v7.40 (audit): phase startup = titik lempar nyata paling awal
      // (createProviderLayer/tool-layer/kernel-session). Bersihkan lease +
      // timer di SINI juga, supaya host panjang-usia (ACP) yang menangkap
      // galat bisa re-acquire tanpa menunggu event `exit`. Galat asli tetap
      // dilempar (fail-closed); cleanup best-effort tak menimpani pesannya.
      cleanupWriterOnStartupFailure()
      // Catatan (re-audit): safety-net `process.once("exit", …)` SENGAJA tetap
      // terpasang di jalur throw — ia idempoten & di-guard `writerClosed`
      // (plus `startupSucceeded` yang masih false di sini), jadi fire saat exit
      // tak berbahaya. Melepasnya di sini justru menghilangkan jaring pengaman
      // bila host menangkap error lalu exit tanpa close().
      throw e
    } finally {
      if (process.env.MINICODE_DEBUG_STARTUP === "1")
        startupWrite(`[startup] ${name} ${Date.now() - s}ms\n`)
    }
  }

  // Timeout default: --timeout > MINICODE_TIMEOUT_MS env > 1 jam. 0 = Infinity.
  // Sejak desain activity-first, `effectiveTimeoutMs` berlaku sebagai watchdog
  // INAKTIVITAS (direset oleh delta model, step, dan output/heartbeat tool) —
  // kerja sehat berjalan berjam-jam/hari tanpa terpotong. `--wall-timeout` (atau
  // MINICODE_WALL_TIMEOUT_MS) menyediakan batas waktu kalender keras opsional.
  const envTimeout = process.env.MINICODE_TIMEOUT_MS
  let effectiveTimeoutMs =
    timeoutMs ?? (envTimeout != null && envTimeout !== "" ? Number(envTimeout) : 3_600_000)
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs < 0) {
    startupWrite(`[warn] invalid timeout ${effectiveTimeoutMs}, fallback to 3600000\n`)
    effectiveTimeoutMs = 3_600_000
  } else if (effectiveTimeoutMs > LIMITS.MAX_TIMER_DELAY_MS) {
    startupWrite(`[warn] timeout exceeds runtime limit; capped at ${LIMITS.MAX_TIMER_DELAY_MS}ms\n`)
    effectiveTimeoutMs = LIMITS.MAX_TIMER_DELAY_MS
  }
  const envWallTimeout = process.env.MINICODE_WALL_TIMEOUT_MS
  let effectiveWallTimeoutMs: number | undefined =
    wallTimeoutMs ??
    (envWallTimeout != null && envWallTimeout !== "" ? Number(envWallTimeout) : undefined)
  if (effectiveWallTimeoutMs !== undefined) {
    if (!Number.isFinite(effectiveWallTimeoutMs) || effectiveWallTimeoutMs < 0) {
      startupWrite(`[warn] invalid wall-timeout ${effectiveWallTimeoutMs}, ignoring\n`)
      effectiveWallTimeoutMs = undefined
    } else if (effectiveWallTimeoutMs === 0) {
      effectiveWallTimeoutMs = undefined
    }
  }
  // `--timeout` adalah deadline inaktivitas satu pemanggilan prompt. Jangan menyalakan
  // timer saat sesi dibuat: sesi TUI/REPL bisa idle lama lalu menerima prompt
  // baru, yang harus mendapat jatah waktu baru.
  const wakeRenewHook: (() => void) | null = () => {
    if (writerClosed) return
    try {
      const out = renewSessionWriter(sessionId, writerToken, cwd)
      if (out === "AUTHORITY_HELD") startWriterRenewTimer()
    } catch {}
  }
  const createRunDeadline = (): ActivityDeadline =>
    createActivityDeadline({
      inactivityTimeoutMs: effectiveTimeoutMs === 0 ? Infinity : effectiveTimeoutMs,
      ...(effectiveWallTimeoutMs !== undefined ? { maxWallClockMs: effectiveWallTimeoutMs } : {}),
      buildInactivityError: (ms) =>
        new AgentError("timeout", `run inactive with no model/tool activity for ${ms}ms`),
      buildWallClockError: (ms) =>
        new AgentError("timeout", `run exceeded wall-clock timeout (${ms}ms)`),
      onWakeFromSleep: () => {
        try {
          wakeRenewHook?.()
        } catch {}
      },
    })

  // [mode-architecture] `--plan` legacy bukan lagi permission mode — pemetaannya
  // ke WorkMode PLAN terjadi di effectiveWorkMode (di atas). `--allow-all` tetap
  // profil privileged. `--allowlist`/fallback no-sandbox TIDAK lagi mengubah
  // PermissionMode: ia jadi `restrictBash` (lapis kapabilitas bash terpisah).
  const permissionMode = allowAll ? "allow-all" : ask ? "ask" : "auto"
  const restrictBash = allowlist

  // Home guard: sesi dibuka di home berisiko (glob rame, write berbahaya).
  // Standar industri: percaya-tapi-ingatkan, jangan tolak diam-diam maupun
  // pindahkan workspace (menyesatkan resume/checkpoint).
  try {
    const home = homeDir()
    const cur = resolvePath(cwd ?? process.cwd())
    if (resolvePath(home) === cur) {
      startupWrite(
        c.yellow(
          `[warn] workspace is home directory — consider --cwd <project> to avoid scanning the entire home\n`,
        ),
      )
    }
  } catch {}

  // Turn sebelumnya mati tak wajar (segfault/hang/kill): marker yatim masih
  // ada. Laporkan sekali + bersihkan — tanpa ini berhentinya "hilang" tanpa
  // jejak dan user tak tahu harus /resume atau mulai baru.
  try {
    const { checkStaleTurn, clearStaleTurn, formatStaleNotice } = await import(
      "../src/session/turn-marker.ts"
    )
    const stale = checkStaleTurn(cwd, sessionId)
    if (stale) {
      startupWrite(`${c.yellow(formatStaleNotice(stale))}\n`)
      clearStaleTurn(cwd, sessionId)
    }
  } catch {}

  const { cfg, router } = await startupPhase("provider-layer", () =>
    createProviderLayer({
      cwd,
      prompt,
      enterRepl,
      rateLimiter,
      providerOverride,
      allowLocalConfig,
      setupWhenEmpty: runSetupWizard,
    }),
  )
  // Operator wajib tahu saat config repo dipercaya — cetak sekali di awal.
  // localConfigNotice mengembalikan undefined bila flag mati atau berkas tak
  // ada, jadi tak ada noise pada alur normal.
  try {
    const notice = localConfigNotice(cwd ?? process.cwd(), allowLocalConfig === true)
    if (notice) startupWrite(`${c.dim(notice)}\n`)
  } catch {}
  if (sandboxNotice) startupWrite(`${sandboxNotice}\n`)
  // Default model = terakhir dipakai (global), bila tanpa --model dan masih
  // ada di config. Flag selalu menang; tak ada simpanan = provider pertama.
  if (!modelRef.current) {
    const saved = await loadLastModel().catch(() => undefined)
    if (saved && cfg.providers.some((p) => p.models.some((m) => `${p.id}::${m}` === saved))) {
      modelRef.current = saved
    }
  }
  const effectiveDefaultModel = () => modelRef.current ?? cfg.providers[0]?.models[0]
  const warnedContextModels = new Set<string>()
  const warnedCatalogDrift = new Set<string>()
  // Eskalasi jendela konteks adaptif per model selama sesi ini hidup.
  // Menyimpan baseline saat eskalasi terjadi supaya jika user mengubah pin
  // lewat `/context set`, perubahan manual menang atas eskalasi sebelumnya.
  const escalatedWindows = new Map<string, { baseTokens: number; escalatedTokens: number }>()
  const cappedWindows = new Map<string, { baseTokens: number; cappedTokens: number }>()
  const routedContextModel = (model?: string) =>
    router.contextModelIdentity(model ?? effectiveDefaultModel()) ?? model ?? "default"
  const contextModelId = (requested?: string): string => {
    return routedContextModel(requested)
  }
  const resolveEffectiveContextWindow = (model?: string) => {
    const key = routedContextModel(model)
    const resolved = resolveContextWindow(cfg, key, contextWindowTokens)
    const cap = cappedWindows.get(key)
    if (cap) {
      if (cap.baseTokens !== resolved.tokens) {
        cappedWindows.delete(key)
      } else if (cap.cappedTokens < resolved.tokens) {
        return { ...resolved, key, tokens: cap.cappedTokens, escalated: true }
      }
    }
    const esc = escalatedWindows.get(key)
    if (esc) {
      if (esc.baseTokens !== resolved.tokens) {
        escalatedWindows.delete(key)
      } else if (esc.escalatedTokens > resolved.tokens) {
        return { ...resolved, key, tokens: esc.escalatedTokens, escalated: true }
      }
    }
    return { ...resolved, key, escalated: false }
  }
  const getContextWindowTokens = (model?: string) => {
    const resolved = resolveEffectiveContextWindow(model)
    if (resolved.source === "safe-default" && !resolved.escalated) {
      const key = resolved.providerId
        ? `${resolved.providerId}::${resolved.model ?? "default"}`
        : (resolved.model ?? "default")
      if (!warnedContextModels.has(key)) {
        warnedContextModels.add(key)
        startupWrite(
          `${c.yellow(`[context] no configured window for ${sanitizeAnsi(key)}; using fallback ${resolved.tokens} tokens. Set it with: minicode config context-window ${resolved.providerId ?? "<provider>"} ${resolved.model ?? "<model>"} 128k\n`)}`,
        )
      }
    }
    // R9/T8 — katalog vs models.dev beda >2×: katalog mungkin basi. Peringatkan
    // sekali per model agar user tahu harus `pricing sync`/set contextWindows.
    if (resolved.drift) {
      const key = resolved.providerId
        ? `${resolved.providerId}::${resolved.model ?? "default"}`
        : (resolved.model ?? "default")
      if (!warnedCatalogDrift.has(key)) {
        warnedCatalogDrift.add(key)
        startupWrite(
          `${c.yellow(`[context] catalog window ${resolved.drift.catalogTokens} for ${sanitizeAnsi(key)} differs >2x from models.dev (${resolved.drift.overlayTokens}); using ${resolved.tokens} tokens (${resolved.source}). Set provider.contextWindows for an endpoint-specific limit.\n`)}`,
        )
      }
    }
    return resolved.tokens
  }
  const getReportedContextWindowTokens = (model?: string) => {
    const resolved = resolveEffectiveContextWindow(model)
    return resolved.source === "safe-default" && !resolved.escalated ? undefined : resolved.tokens
  }
  router.updateContextWindowResolver(getContextWindowTokens)
  // Muat overlay jendela konteks models.dev sekali sebelum resolusi dipakai;
  // bersifat best-effort (cache mungkin belum ada — itu normal).
  await loadContextWindowOverlay().catch(() => undefined)
  // Emit the fallback warning immediately for the startup-selected model.
  getContextWindowTokens()
  const {
    systemExtra,
    skills: allLoadedSkills,
    memoryHits,
  } = await startupPhase("rag-layer", () =>
    createRagLayer({
      cfg,
      prompt,
      cwd,
      allowLocalConfig: allowLocalConfig === true,
      // RAG retrieval tak boleh menulis access_count di mode tanpa-mutasi.
      // [mode-architecture] PermissionMode readonly/plan tak lagi ada sebagai sumbu
      // persetujuan; ceiling tanpa-mutasi kini diekspresikan via WorkMode
      // DISCUSS/PLAN (effectiveWorkMode). Profil warisan allowlist/allow-all
      // tetap menulis (bukan read-only).
      trackAccess: effectiveWorkMode === "EXECUTE",
    }),
  )

  // resume: load full history dari baris kanonik → seed ke ContextStore.
  // --resume tak dikenal sudah melempar di resolver identitas (eksplisit);
  // tak ada lagi "not found → sesi baru diam-diam".
  let initialMessages: readonly Message[] | undefined
  let resumeTurnCount: number | undefined
  let resumeUsageSnapshot: UsageInitialSnapshot | undefined
  // P3.5 — carrier metadata runtime hasil seleksi (host-side, RAM, lifecycle-
  // scoped). Diisi HANYA di jalur resume yang membangun ContextSelection; sesi
  // baru tetap undefined (tak ada klaim kesegaran tanpa seleksi).
  let runtimeContextMetadata: RuntimeContextMetadata | undefined
  let recoveryAppendix = ""
  // P2.8 forensics: artefak context-only yang ditanam di buffer konteks pada
  // resume ini (bila proyeksi CURRENT). Dipakai persistCurrent untuk membuang
  // artefak turunan SEBELUM menulis ke histori kanonik. Tanpa deklarasi ini
  // ringkasan proyeksi bisa bocor ke `messages`.
  let contextOnlyArtifact: ContextOnlyArtifact | undefined
  // [Fase 4 / LOOP-13] Header operasional deterministik untuk system prompt
  // (buffer kedua: selalu dikirim, tak pernah dikompaksi, tak masuk histori).
  let runtimeStateHeader: string | undefined
  // [Fase 6A / ACE-01] Keputusan consequence terakhir. Dideklarasikan SEBELUM
  // blok resume agar `collectOperationalState` bisa menyertakannya pada header
  // yang dibangun saat sesi dilanjutkan (tidak ada akses ke system prompt
  // yang sudah dibekukan kernel setelah sesi dibuat).
  let lastAceDecision: ConsequenceDecision | null = null
  // Streak kegagalan verify (dipakai ACE sebagai `repeatedFailureCount`).
  let verifyFailureStreak = 0
  // Baseline kanonik saat resume (hanya prefix sebelum tail/proyeksi). Setelah
  // proyeksi/budget-tail memotong prefix, persist harus menyusun ulang prefix + ekor.
  let contextCanonicalBaseline: readonly unknown[] | undefined
  let budgetTailPrefix: readonly unknown[] | undefined
  let budgetTailInitialMessages: readonly Message[] | undefined
  // `--session <id>` yang menimpa baris lama bukan resume (histori tak di-load),
  // tetapi tetap memulihkan WorkMode tersimpan. Beri tahu operator supaya
  // perubahan otoritas ini terlihat, bukan diam-diam mengubah default CLI.
  if (!identity.resumed && identity.hasStoredSession && persistedWorkMode !== undefined) {
    startupWrite(
      `[session] takeover ${sessionId}: WorkMode ${effectiveWorkMode === "EXECUTE" ? "BUILD" : effectiveWorkMode} restored from stored session metadata\n`,
    )
  }
  if (identity.resumed) {
    // P0.2 (Q5 / Invariant #6) — transparansi resume: WorkMode dipulihkan dari
    // metadata sesi bila operator tidak memberi sinyal eksplisit (NULL legacy
    // kembali ke default DISCUSS). Satu baris stderr human-facing memastikan
    // otoritas sesi hasil resume selalu terlihat eksplisit.
    const resumeNotice = !workModeExplicit
      ? persistedWorkMode !== undefined
        ? `[resume] WorkMode ${effectiveWorkMode === "EXECUTE" ? "BUILD" : effectiveWorkMode} restored from session; pass --work-mode DISCUSS|BUILD to override\n`
        : `[resume] WorkMode default DISCUSS (legacy session without saved workMode); pass --work-mode BUILD to change\n`
      : persistedWorkMode !== undefined && persistedWorkMode !== effectiveWorkMode
        ? `[resume] WorkMode ${effectiveWorkMode === "EXECUTE" ? "BUILD" : effectiveWorkMode} (overriding saved ${persistedWorkMode === "EXECUTE" ? "BUILD" : persistedWorkMode})\n`
        : ""
    if (resumeNotice) startupWrite(resumeNotice)
    // P2.4: aktivasi default Thread SEBELUM seed kernel — backfill aditif
    // berpagar (konten/seq tak tersentuh). Basi di sini = gagal loud
    // (dunia bergerak pasca-admission); warn-swallow di bawah tak berlaku.
    // P2.5: backfill event_id legacy deterministik (NULL → evt_migr_*,
    // idempoten) agar SEMUA baris durable beridentitas stabil.
    const defaultThread = ensureDefaultThread(sessionId, cwd, { expectedEpoch })
    const backfilled = backfillHistoryEventIds(sessionId, cwd, { expectedEpoch })
    startupWrite(
      `${c.dim(`[thread sid=${sessionId} tid=${defaultThread.thread_id} head=${defaultThread.head_seq}${backfilled > 0 ? ` backfilled=${backfilled}` : ""}]\n`)}`,
    )
    try {
      const meta = await startupPhase("resume-session", async () => loadSessionMeta(sessionId, cwd))
      if (meta) {
        resumeUsageSnapshot = loadSessionUsageSummary(sessionId, cwd)
      }
      // BACA histori SEKALI (dengan seq). loadSessionMeta tidak decode messages,
      // jadi decode penuh tinggal SATU kali (dulu `loadSession` + `loadThreadHistoryWithSeq`
      // decode dua kali — akar lemot resume berhistori banyak, lihat audit perf).
      const rowsForSelector = await startupPhase("resume-history", async () =>
        loadThreadHistoryWithSeq(sessionId, defaultThread.thread_id, cwd),
      )
      if (meta && rowsForSelector.length) {
        // [Fase 4 / LOOP-13, LOOP-INV-16] Kumpulkan snapshot state operasional
        // deterministik dari sumber durable (TaskStore + usage historis) agar
        // header [RUNTIME_STATE_HEADER] ikut ke konteks resume — tak hilang
        // walau riwayat dipangkas kompaksi. Sumber usage = snapshot resume
        // (collector belum ada di titik ini). Best-effort: absen = perilaku lama.
        let operationalState:
          | import("../src/session/runtime-header.ts").OperationalStateSnapshot
          | null = null
        try {
          const snapUsage = {
            getSession: () => ({
              inputTokens: resumeUsageSnapshot?.inputTokens ?? 0,
              outputTokens: resumeUsageSnapshot?.outputTokens ?? 0,
              totalTokens: resumeUsageSnapshot?.totalTokens ?? 0,
              cost: resumeUsageSnapshot?.totalCostUsd,
            }),
            getTurnCount: () => meta.turnCount ?? 0,
          }
          operationalState = collectOperationalState(
            sessionId,
            cwd ?? process.cwd(),
            snapUsage,
            null,
            lastAceDecision,
          )
        } catch {}

        // P3.3 — selector kanonik menjadi produsen view (derived, murni). Ia
        // MEMBACA data yang sama (rows/revisi/proyeksi) dan menghasilkan
        // ContextSelection provenance-bound. P2.8 dipakai sebagai sumber
        // keputusan proyeksi + fallback identik; selector MEMPERLUAS dengan
        // budget-tail + laporan selectionBasis/freshness. Tak ada tulis kanonik.
        // Batasi histori resume ke batas model, tanpa mengarang overhead.
        // Kernel menghitung system+tools aktual dan memadatkan sebelum request;
        // selector hanya membuang ke budget-tail bila pesan sendiri tak muat.
        // Hitung revisi kompaksi langsung dari kolom `type` — tanpa memuat +
        // decode seluruh presentation_events (dulu tarik ratusan ribu baris
        // hanya untuk menghitung revisi; kini COUNT(*) SQL, lihat audit perf).
        const revision = countDurableCompactionEvents(sessionId, cwd)
        // P3.4: proyeksi kanonik durable adalah sumber UTAMA untuk selector
        // (cakupan-valid: CURRENT atau STALE berjangkar utuh, P3.0 §8 D6),
        // sehingga `summary-plus-tail` menjadi perilaku produksi nyata.
        const durableProjection = await startupPhase("resume-projection", async () =>
          readConsumableSummaryProjection(sessionId, cwd, defaultThread.thread_id),
        )
        const projectionSummary = durableProjection
        const selectedWindow = getContextWindowTokens()
        const selectionReserve = selectedWindow > 16_384 ? outputReserveFor(selectedWindow) : 0
        const messageBudget = Math.max(0, selectedWindow - selectionReserve)
        // N1: turunkan frontier kanonis dari baris yang BARU DIBACA (sumber
        // kebenaran saat ini) dan teruskan ke selector — freshness dihitung
        // via assessContextFreshness (BUKAN hard-code "fresh"). Selector tetap
        // deskriptif; putusan publikasi tetap milik saveSession.
        // Provenance ringkasan TAHAN RESTART.
        //
        // Ringkasan kompaksi disimpan sebagai baris `messages` role user; status
        // "sintetis" dulu hanya ada di WeakSet proses, jadi setelah resume ia
        // terbaca sebagai permintaan user dan ikut diringkas lagi (nesting
        // "Previous context:" yang menumpuk tiap siklus). Produsen proyeksi
        // mencatat teksnya di `history_summaries`; di sini baris yang COCOK
        // dengan catatan itu didaftarkan ulang sebagai sintetis.
        const recordedSummary = (() => {
          try {
            return getHistorySummary(sessionId, defaultThread.thread_id, cwd)
          } catch {
            return null
          }
        })()
        const rowsWithProvenance = (() => {
          const mapped = rowsForSelector.map((r) => ({ seq: r.seq, message: r.message }))
          const first = mapped[0]
          if (!recordedSummary || !first || first.seq !== 0) return mapped
          const text = (first.message as { content?: unknown }).content
          if (typeof text !== "string" || text.length === 0) return mapped
          // Pencocokan PERSIS dengan teks yang dicatat lapisan persist. Bukan
          // heuristik gaya "Previous context": pesan user asli yang kebetulan
          // memuat kata itu tidak boleh pernah didaftarkan sebagai sintetis.
          const exact = recordedSummary.canonicalFirstText
          if (!exact || exact !== text) return mapped
          return [
            {
              ...first,
              message: registerCompactionSummary(
                first.message as Message,
                recordedSummary.summaryText,
              ),
            },
            ...mapped.slice(1),
          ]
        })()
        const selectorRows = rowsWithProvenance
        const canonicalFrontier = deriveFrontierFromDurable({
          sessionId,
          threadId: defaultThread.thread_id,
          rows: rowsToCanonicalRefs(selectorRows),
          revision,
        })
        const selection = await startupPhase("resume-select", async () =>
          selectContext({
            sessionId,
            threadId: defaultThread.thread_id,
            rows: selectorRows,
            revision,
            ...(projectionSummary ? { projection: projectionSummary } : {}),
            policy: { budgetTokens: messageBudget, estimator: minicodeEstimator },
            canonicalFrontier,
          }),
        )
        initialMessages = selection.messages as readonly Message[]
        // [Fase 4 / LOOP-13, LOOP-INV-16] Simpan snapshot state operasional
        // deterministik untuk dijadikan header di SYSTEM prompt (buffer kedua):
        // selalu dikirim ke model, tidak pernah dihapus kompaksi, dan TIDAK
        // pernah masuk histori kanonik (nol risiko duplikasi).
        if (operationalState) {
          try {
            const { buildRuntimeStateHeader } = await import("../src/session/runtime-header.ts")
            runtimeStateHeader = buildRuntimeStateHeader(operationalState)
          } catch {}
        }
        // P3.5 (N1) — angkut metadata seleksi melewati batas seed runtime.
        // Hanya `messages` yang masuk kernel (initialMessages); identity/frontier/
        // revision/basis/freshness/provenance hidup di carrier host-side ini —
        // bukan pesan model, bukan otoritas, bukan store.
        runtimeContextMetadata = runtimeMetadataFromSelection(selection, revision)
        if (selection.contextOnly) {
          contextOnlyArtifact = selection.contextOnly
          // Hanya prefix sebelum `coveredSeq` — ekor `[coveredSeq..N-1]` SUDAH ada di `initialMessages[1..]`.
          contextCanonicalBaseline = rowsForSelector
            .filter((r) => r.seq < selection.coveredSeq)
            .map((r) => r.message)
        } else if (selection.selectionBasis === "budget-tail") {
          const baseSeq =
            selection.messages.length === 0 ? Infinity : (selection.frontier?.baseSeq ?? 0)
          if (baseSeq > 0) {
            budgetTailPrefix = rowsForSelector.filter((r) => r.seq < baseSeq).map((r) => r.message)
            budgetTailInitialMessages = selection.messages
          }
        }
        resumeTurnCount = meta.turnCount
        startupConsoleError(
          c.dim(
            // "(N messages)" dipertahankan VERBATIM (kontrak diagnostik yang
            // sudah dipakai test/CLI).
            `[resumed session ${sessionId} (${rowsForSelector.length} messages)]\n`,
          ),
        )
        // P3.3 — jejak provenance seleksi (baca-saja; tak mengubah perilaku).
        startupConsoleError(
          c.dim(
            `[select sid=${sessionId} basis=${selection.selectionBasis} freshness=${selection.freshness} head=${selection.frontier?.headSeq ?? "-"}]\n`,
          ),
        )
        // P3 — validasi resume: bukan replay buta. Bila workspace berubah
        // sejak checkpoint terakhir (edit manual / run lain), beri tahu —
        // /undo tersedia bila perlu kembali. Best-effort, tak menggagalkan resume.
        const div = await startupPhase("resume-workspace", async () =>
          validateResumeWorkspace(cwd ?? ".", sessionId).catch(() => null),
        )
        if (div && div.diverged > 0) {
          startupConsoleError(
            c.yellow(
              `[resume] workspace changed since last checkpoint (${div.diverged} file(s)) — /undo available to revert\n`,
            ),
          )
        }
      } else {
        // Defensif (tak terjangkau normal: resolver menjamin baris ada).
        startupConsoleError(c.yellow(`[resume] session ${sessionId} has no messages yet\n`))
      }
    } catch (e) {
      // P2.2/P2.4: pagar basi TIDAK boleh jadi warning — lempar ulang agar
      // startup gagal loud (dunia bergerak pasca-admission).
      if (e instanceof StaleWriterError || e instanceof ThreadArchivedError) throw e
      startupWrite(`[warn] resume failed: ${(e as Error).message}\n`)
    }
  }

  // P0-2/P0-1 — recovery journal dibaca SEBELUM seed kernel: putuskan status
  // mutasi yang belum finalized (pending/failed/committed-tanpa-DB), lalu
  // teruskan sebagai SYSTEM appendix (bukan pesan user/assistant palsu).
  // Tanpa jurnal (sesi baru/bersih) = no-op. Tak pernah memblokir resume.
  try {
    const persistedTurns = listPersistedTurns(sessionId, cwd)
    const rec = await planRecoveryForSession(sessionId, cwd, { persistedTurns })
    for (const w of rec.warnings) startupWrite(c.yellow(`[recovery] ${w}\n`))
    if (rec.directive) {
      startupWrite(
        c.yellow(`[recovery] unfinished mutations need verification — see system note\n`),
      )
      recoveryAppendix = `\n\n# Recovery note (interrupted session — verify before re-executing)\n${rec.directive}`
    }
  } catch (e) {
    startupWrite(`[warn] recovery plan failed: ${(e as Error).message}\n`)
  }

  let durablePresentationEvents: DomainEvent[] = []
  try {
    durablePresentationEvents = loadPresentationEvents(sessionId, cwd)
  } catch (e) {
    startupWrite(`[warn] presentation replay load failed: ${(e as Error).message}\n`)
  }
  let rebuiltPresentation: ReturnType<typeof rebuildFromDurable> | null = null
  try {
    rebuiltPresentation = rebuildFromDurable(
      durablePresentationEvents,
      createReducerDiagnostics(),
      sessionId,
    )
  } catch (e) {
    startupWrite(`[warn] presentation replay failed: ${(e as Error).message}\n`)
  }
  // P2.11 — replay watershed: state.seq sesaat setelah rebuild. Baris snapshot
  // pada/di bawah ini = replay/reconstructed; di atasnya = live (provenance
  // absen). null = tak pernah rebuild (semua baris live).
  const replayedUpToSeq: number | null = rebuiltPresentation ? rebuiltPresentation.state.seq : null
  const provenanceOf = (
    entry: { status?: string; incomplete?: boolean },
    seq: number,
  ): { provenance?: "live" | "replay" | "reconstructed" | "unknown" } => {
    const provenance = projectProvenance(entry, seq, replayedUpToSeq)
    return provenance ? { provenance } : {}
  }

  // P0-3 — pointer undo/redo basi (crash apply→save): adopsi dari marker
  // jurnal bila valid. Berjalan untuk SEMUA sesi (bukan hanya --resume),
  // karena --session <id> yang dipakai ulang tanpa --resume pun bisa basi.
  // No-op bila tak ada marker / sudah konvergen. Tak pernah blokir start.
  try {
    await reconcileUndoRedoPointer(sessionId, cwd)
  } catch (e) {
    startupWrite(`[warn] checkpoint reconcile failed: ${(e as Error).message}\n`)
  }

  // Kontrak control-plane (Phase 6, E5): usage kompaksi LLM dikirim ke bus
  // sesi (event usage standar) — dulu blind spot accounting (kompaksi memakai
  // provider sendiri di luar bus; belanja LLM ini tak terlihat budget).
  // Late-binding: onUsage dipanggil di tengah turn, saat session sudah ada.
  let sessionEvents: {
    emit: (e: { type: "provider:extension"; kind: string; data: unknown }) => void
  } | null = null
  // Adaptor semantik presentasi Fase 1 (AGENT_PRESENTATION_ARCHITECTURE_V2_1):
  // mengamati bus kernel dan memancarkan DomainEvent ke subscriber-nya sendiri.
  // Dual-subscribe dengan sink lama — perilaku user NOL berubah pada Fase 1.
  let presentation: PresentationAdapter | null = null
  // Reducer memelihara PresentationState yang dipakai snapshot presentasi.
  // Divergensi = reduce melempar (harusnya 0).
  let shadowState: PresentationState | null = rebuiltPresentation?.state ?? null
  let shadowDiag: ReducerDiagnostics | null = rebuiltPresentation
    ? createReducerDiagnostics()
    : null
  let shadowDivergence = 0
  let unsupportedProjection = 0
  let shadowUnsub: (() => void) | null = null
  let presentationWriteTail: Promise<void> = Promise.resolve()
  let presentationFlushTimer: ReturnType<typeof setTimeout> | undefined
  const pendingPresentationEvents: DomainEvent[] = []
  // [Audit F-04] Akumulasi ukuran batch per turn (hanya relevan saat debug aktif).
  let turnBatchEvents = 0
  // v7.41 (audit #2 / F2): satu gerbang publish terurut untuk SEMUA event.
  // Durable dilepas hanya setelah append (confirmDurable); non-durable ikut
  // antrean tapi langsung lewat bila tak ada durable yang tertahan di depannya.
  // Sebelum fix, non-durable diterbitkan langsung sementara durable lebih awal
  // masih menunggu append → subscriber Seq-keyed menerima seq besar lebih dulu.
  const orderedDomain = createOrderedDomainPublisher(
    (event) => publishDomainEvent(event),
    (event) => DURABILITY[event.type]?.durable === true,
  )
  // [P13.6] Satu titik tulis durable presentasi. Produksi = append asli
  // (pagar epoch sama); test menyuntik penghalang/kegagalan deterministik
  // lewat opts.presentationAppend (analog seam checkpoint jurnal).
  const appendPresentation =
    opts.presentationAppend ??
    ((events: readonly DomainEvent[]) =>
      appendPresentationEvents(sessionId, cwd, events, { expectedEpoch }))
  const flushPresentationEvents = (): void => {
    if (presentationFlushTimer !== undefined) {
      clearTimeout(presentationFlushTimer)
      presentationFlushTimer = undefined
    }
    const batch = pendingPresentationEvents.splice(0)
    if (batch.length === 0) return
    // [Audit F-04] Ukur ukuran batch flush (tanpa mengubah antrean/urutan).
    perfCount("presentation.flush.batchSize", 0, batch.length)
    if (perfEnabled()) turnBatchEvents += batch.length
    presentationWriteTail = presentationWriteTail
      .then(async () => {
        const stats = await appendPresentation(batch)
        void stats
        // [P13.6] LIVE = DURABLE-CONFIRMED: lepas durable hanya setelah append
        // sukses. Gerbang terurut menjaga non-durable tetap di posisi seq-nya.
        for (const event of batch) orderedDomain.confirmDurable(event.eventSeq)
      })
      .catch((error) => {
        // v7.41 (audit #2 / F2): append gagal ⇒ batch ini TIDAK pernah durable.
        // Buang dari antrean publish supaya tak ikut terlepas saat batch
        // berikutnya sukses (dulu event gagal tertahan lalu dipublish sebagai
        // sudah-durable → konsumen replay melihat sejarah berbeda).
        orderedDomain.drop(batch)
        if (error instanceof StaleWriterError) {
          markWriterStale(`presentation flush refused (expected epoch ${error.expectedEpoch})`)
          return
        }
        process.stderr.write(
          `[warn] presentation event persist failed: ${(error as Error).message}\n`,
        )
      })
  }
  const queuePresentationEvent = (event: DomainEvent): void => {
    if (!DURABILITY[event.type]?.durable) return
    pendingPresentationEvents.push(event)
    orderedDomain.enqueue(event)
    if (presentationFlushTimer === undefined) {
      presentationFlushTimer = setTimeout(flushPresentationEvents, 0)
    }
  }
  const presentationSubscribers = new Set<(event: UiPresentationEvent) => void>()
  // [P13.5] Subscriber DomainEvent mentah. Dipisah dari proyeksi UI supaya feed
  // daemon bisa memakai `eventSeq` yang sama dengan baris durable.
  const domainEventSubscribers = new Set<(event: DomainEvent) => void>()
  // Content store in-memory untuk query /expand; jalur production.
  let contentStore: ContentStore | null = null
  const getShadowDiagnostics = (): {
    divergence: number
    eventsIn: number
    duplicateTerminal: number
    lateEvent: number
    orphanTool: number
    orphanApproval: number
    duplicateTurn: number
    unknownEvent: number
    orphanEvidence: number
    unsupportedProjection: number
  } => ({
    divergence: shadowDivergence,
    eventsIn: shadowDiag?.eventsIn ?? 0,
    duplicateTerminal: shadowDiag?.duplicateTerminal ?? 0,
    lateEvent: shadowDiag?.lateEvent ?? 0,
    orphanTool: shadowDiag?.orphanTool ?? 0,
    orphanApproval: shadowDiag?.orphanApproval ?? 0,
    duplicateTurn: shadowDiag?.duplicateTurn ?? 0,
    unknownEvent: shadowDiag?.unknownEvent ?? 0,
    orphanEvidence: shadowDiag?.orphanEvidence ?? 0,
    unsupportedProjection,
  })
  // Fase 1 perf (butir 1): cache snapshot presentasi. Snapshot dibangun ulang
  // penuh pada tiap panggil — padahal panggil terjadi tiap paint (ketikan/scroll),
  // dan nilai yang dibangun tidak berubah di antara event. Reducer immutable:
  // shadowState hanya bermutasi via reduce(event); reduce menaikkan `state.seq`
  // HANYA pada event durable, dan semata field yang dipetakan ke snapshot pun
  // hanya diubah oleh event durable (model.delta/tool.progress/context.window
  // kembali awal / hanya menulis `progress` yang tak masuk snapshot). Karena itu
  // cache ber-key (objek state, seq) aman: seq berubah ⟺ snapshot berubah.
  let snapshotCache: {
    state: PresentationState
    seq: number
    value: UiPresentationSnapshot
  } | null = null
  const getPresentationSnapshot = (): UiPresentationSnapshot => {
    if (!shadowState) return { activities: [], turns: [] }
    // Objek `shadowState` identik + seq identik = konten tak berubah (lihat
    // alasan di atas); reuse tanpa membangun ulang ratusan objek per paint.
    if (
      snapshotCache &&
      snapshotCache.state === shadowState &&
      snapshotCache.seq === shadowState.seq
    ) {
      return snapshotCache.value
    }
    const activities: UiPresentationActivity[] = [...shadowState.activities.values()].map((a) => ({
      seq: a.seq,
      turnId: a.turnId,
      sessionId: a.sessionId,
      toolCallId: a.toolCallId,
      name: a.identity.name,
      qualified: a.identity.qualified,
      ...(a.target ? { target: a.target } : {}),
      ...(a.intent ? { intent: a.intent } : {}),
      status: a.status as UiToolStatus,
      tsStart: a.tsStart,
      ...(a.label ? { label: a.label } : {}),
      ...(a.tsEnd !== undefined ? { tsEnd: a.tsEnd } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.error
        ? {
            error: {
              cause: a.error.cause,
              message: a.error.message,
              ...(a.error.hint ? { hint: a.error.hint } : {}),
            },
          }
        : {}),
      ...(a.denyReason ? { denyReason: a.denyReason } : {}),
      ...(a.receipt
        ? {
            receipt: {
              ...(a.receipt.paths ? { paths: a.receipt.paths } : {}),
              ...(a.receipt.checkpointId ? { checkpointId: a.receipt.checkpointId } : {}),
              ...(a.receipt.stats ? { stats: a.receipt.stats } : {}),
              ...(a.receipt.test ? { test: a.receipt.test } : {}),
              ...(a.receipt.cmd ? { cmd: a.receipt.cmd } : {}),
            },
          }
        : {}),
      ...(a.parentToolCallId ? { parentToolCallId: a.parentToolCallId } : {}),
      ...(a.childSessionId ? { childSessionId: a.childSessionId } : {}),
      ...(a.runId ? { runId: a.runId } : {}),
      ...(a.supersedes ? { supersedes: a.supersedes } : {}),
      ...(a.expandRef
        ? { expandRef: { toolCallId: a.expandRef.toolCallId, idx: a.expandRef.idx } }
        : {}),
      ...(a.verification
        ? {
            verification: {
              invocationId: a.verification.invocationId,
              verdict: a.verification.verdict,
              method: a.verification.method,
              observedAt: a.verification.observedAt,
            },
          }
        : {}),
      ...provenanceOf(a, a.seq),
    }))
    const turns: UiPresentationTurn[] = [...shadowState.turns.values()].map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.summary ? { summary: turn.summary as UiTurnSummary } : {}),
      ...provenanceOf(turn, turn.seq),
    }))
    const conversation: UiPresentationMessage[] = shadowState.conversation.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      role: entry.role,
      text: entry.text,
      truncated: entry.truncated,
      ...(entry.promptRef ? { promptRef: entry.promptRef } : {}),
    }))
    const reasoning: UiPresentationReasoning[] = shadowState.reasoning.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      truncated: entry.truncated,
      expandRef: { toolCallId: entry.expandRef.toolCallId, idx: entry.expandRef.idx },
    }))
    const system: UiPresentationSystem[] = shadowState.system.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      kind: entry.systemKind,
      text: entry.text,
      ...(entry.reason ? { reason: entry.reason } : {}),
      severity: entry.severity,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.taskStatus ? { taskStatus: entry.taskStatus } : {}),
      ...(entry.parentId ? { parentId: entry.parentId } : {}),
      ...(entry.dependsOn?.length ? { dependsOn: [...entry.dependsOn] } : {}),
      ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
    }))
    const plans: UiPresentationPlan[] = [...shadowState.plans.values()].map((entry) => ({
      planId: entry.planId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      status: entry.status,
      steps: entry.steps,
    }))
    const findings: UiPresentationFinding[] = [...shadowState.findings.values()].map((entry) => ({
      findingId: entry.findingId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      category: entry.category,
      severity: entry.severity,
      summary: entry.summary,
      evidence: entry.evidence,
    }))
    const results: UiPresentationResult[] = [...shadowState.results.values()].map((entry) => ({
      resultId: entry.resultId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      status: entry.status,
      summary: entry.summary,
      ...(entry.action ? { action: entry.action } : {}),
    }))
    const diagnostics: UiPresentationDiagnostic[] = shadowState.diagnostics.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      category: entry.category,
      severity: entry.severity,
      message: entry.message,
      ...(entry.cause ? { cause: entry.cause } : {}),
      ...(entry.action ? { action: entry.action } : {}),
    }))
    const snapshot: UiPresentationSnapshot = {
      activities,
      turns,
      conversation,
      reasoning,
      system,
      plans,
      findings,
      results,
      diagnostics,
    }
    snapshotCache = { state: shadowState, seq: shadowState.seq, value: snapshot }
    return snapshot
  }
  const onPresentationEvent = (handler: (event: UiPresentationEvent) => void): (() => void) => {
    presentationSubscribers.add(handler)
    return () => presentationSubscribers.delete(handler)
  }
  const publishPresentationEvent = (event: Parameters<typeof toPresentationEvent>[0]): void => {
    const projected = toPresentationEvent(event)
    if (!projected) {
      unsupportedProjection++
      return
    }
    for (const handler of [...presentationSubscribers]) {
      try {
        handler(projected)
      } catch {}
    }
  }
  const onDomainEvent = (handler: (event: DomainEvent) => void): (() => void) => {
    domainEventSubscribers.add(handler)
    return () => domainEventSubscribers.delete(handler)
  }
  const publishDomainEvent = (event: DomainEvent): void => {
    for (const handler of [...domainEventSubscribers]) {
      // Satu subscriber gagal tak boleh memutus subscriber lain atau
      // mempersentasikan turn sebagai gagal: ini jalur observasi, bukan
      // authoritas lifecycle.
      try {
        handler(event)
      } catch {}
    }
  }
  let compactionCtl: { noteTurnCompleted(): void; resetThrash(): void } | undefined
  const compaction = createLlmCompaction({
    // LLM compaction DIUTAMAKAN supaya fakta tak hilang lewat fallback mekanikal
    // yang lossy. Provider: summarizer murah khusus (DEEPSEEK_API_KEY) ATAU
    // pakai ulang provider sesi (router) — jangan diam-diam jatuh ke mekanikal
    // bila sesi punya provider.
    ...(process.env.DEEPSEEK_API_KEY
      ? {
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
          model: "deepseek-chat",
        }
      : {
          provider: router,
          getModel: () => modelRef.current ?? cfg.providers[0]?.models[0] ?? "deepseek-chat",
        }),
    cwd: cwd ?? process.cwd(),
    getContextWindowTokens,
    getTaskStateFallback: () =>
      readPersistedTaskStateSync(sessionId, cwd ?? process.cwd()) ?? undefined,
    canPersistMemory: () =>
      (workModeControl?.getWorkMode() ?? effectiveWorkMode) === "EXECUTE" &&
      (permissions?.getMode() ?? permissionMode) !== "readonly" &&
      (permissions?.getMode() ?? permissionMode) !== "plan",
    onController: (ctl) => {
      compactionCtl = ctl
    },
    onUsage: (u) => {
      try {
        // Angka sudah dinormalisasi di compactWithLlm (negatif/NaN → skip).
        sessionEvents?.emit({
          type: "provider:extension",
          kind: "usage",
          data: {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            source: "compaction",
            // P1.4: atribusi biaya compaction memakai model yang benar-benar
            // dipakai (u.model dari compactWithLlm), bukan hardcode.
            model: u.model,
          },
        })
      } catch {}
    },
  })
  // v7.41 (audit #1): generasi recovery. Naik sekali per prompt (di
  // runPromptWithVerify), TETAP selama retry dalam loop recovery yang sama.
  // Dibaca oleh closure idempotencyKeyFor di bawah — lihat
  // productionIdempotencyKey untuk penalaran lengkapnya.
  let recoveryGeneration = 0
  // Naik tiap kali tool mutasi berkas berhasil agar verifikasi ulang bash
  // (mis. `bun test` sebelum dan sesudah edit) dalam turn sama tidak ditolak
  // sebagai duplikat, sementara retry tanpa perubahan tetap ter-dedup.
  // Memakai `WRITE_TOOLS` tunggal dari tool-contract.ts (mencakup edit,
  // write_file, apply_patch, delete_file, move_file, git_restore/checkout,
  // lsp_rename) supaya tidak ada daftar manual kedua yang bisa drift.
  let workspaceMutationEpoch = 0
  // Menghitung setiap percobaan mutasi workspace (termasuk gagal/parsial & work sub-agent)
  // serta pemanggilan todo_write untuk memutuskan apakah pasca-turn perlu verify.
  let turnMutationAttemptSeq = 0
  let turnTodoWriteSeq = 0
  // Naik tiap step selesai / kompaksi agar observasi read-only (`git status`, `dir`)
  // pasca-kompaksi tak terkunci kunci `:gen` lama sementara retry dalam satu step tetap ter-dedup.
  let bashObservationEpoch = 0
  const {
    sessionTools,
    evidenceMode,
    setWorkMode: setToolWorkMode,
    setPermissionMode: setToolPermissionMode,
  } = await startupPhase("tool-layer", () =>
    setupToolLayer(
      cfg,
      toolScope ?? "full",
      permissionMode,
      {
        sessionId,
        threadId: DEFAULT_THREAD_ID,
        cwd: cwd ?? process.cwd(),
        // v7.41 (audit #1): sebelum perbaikan scope produksi tak punya
        // idempotencyKeyFor → executeCanonicalInvocation jatuh ke `runOnce()`
        // dan seluruh dedup durabel MATI di produksi (hanya dipanggil test).
        // Sekarang setiap tool covered memakai kunci yang stabil per recovery
        // window: retry efek yang sudah committed ditolak, bukan dijalankan ulang.
        idempotencyKeyFor: (tool, args) =>
          productionIdempotencyKey(
            tool,
            args,
            recoveryGeneration,
            tool === "bash" ? workspaceMutationEpoch : undefined,
            tool === "bash" && isReadOnlyObservationBash(args) ? bashObservationEpoch : undefined,
          ),
      },
      // F-03 (P5 §C2): background bash job diikat ke sid kanonik sesi ini —
      // instance yang diikat sid tidak pernah dipasok lewat argumen tool.
      sessionId,
      // P12 S2.2 + P0.2: ceiling WorkMode efektif (termasuk hasil pulihan resume).
      effectiveWorkMode,
      // P2.3: pin skema MCP per-workspace.
      cwd,
    ),
  )

  // todo_write/todo_read menyimpan state per sesi di .minicode/todos/<id>.json,
  // terikat pada identitas kanonik (P2.1: satu sid untuk semua komponen).
  todoSession.id = sessionId
  todoSession.cwd = cwd
  // View pertanyaan ask_user — composition root meng-inject, tool menolak
  // jalan tanpanya (fail-closed, sama seperti `ask` pada permission).
  // v7.32: teruskan AbortSignal turn ke modal ask_user.
  setAskTextFn((question, options, signal) => promptAskText(question, options, signal))
  // Cermin observability ask_user → adaptor presentasi (perilaku tool utuh).
  setAskApprovalHook((e) => {
    presentation?.publishApproval(e)
  })
  // Warisan routing sub-agen (audit #14): anak memakai limiter BERSAMA
  // (satu bucket — tak memicu 429 yang baru dihindari parent) dan menghormati
  // --provider parent. Model diwarisi live via ToolContext (lihat task.ts).
  setSubAgentParentRouting({
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(providerOverride ? { defaultProviderId: providerOverride } : {}),
    contextWindowTokensForModel: getContextWindowTokens,
  })
  // P2.9 — lineage parent Run untuk anak Sub-Agent. Composition root satu-
  //-satunya pemilik Run hidup; tooltak pernah mengarang id ini (vendor
  // ToolContext tak membawa execution id).
  setSubAgentParentRunId(() => currentRunId)
  // P12 S2.2 Slice 5 — WorkMode RUNTIME. Handle kontrol diambil dari session
  // (onWorkMode) lalu dibaca LIVE di mana pun WorkMode dibutuhkan, supaya
  // transisi operator (command `/work-mode`) berlaku pada sesi yang sedang
  // berjalan — bukan snapshot saat session dibuat.
  let workModeControl: WorkModeControl | undefined
  // Warisan WorkMode ke sub-agen: composition root adalah satu-satunya pemilik
  // WorkMode efektif. Suntikkan sebagai fn LIVE (dibaca saat delegate_task
  // execute) supaya delegasi berikutnya mewarisi WorkMode parent yang AKTIF
  // saat itu — bukan snapshot lama. Tanpa ini ToolContext.permissionMode
  // (hanya PM, bukan WorkMode) membuat delegate_task melahirkan anak tanpa
  // ceiling WorkMode.
  const hiddenWireTools = computeUnavailableWireTools(cfg, {
    sandboxMode: process.env.MINICODE_SANDBOX,
    interactiveAsk: Boolean(enterRepl || (!machineOutput && process.stdin.isTTY)),
  })
  setSubAgentWorkMode(() => workModeControl?.getWorkMode() ?? effectiveWorkMode)
  setSubAgentGovernance(() => ({
    restrictBash,
    allowLocalConfig: allowLocalConfig === true,
    ...(cfg.bashAllowlist ? { bashAllowlist: cfg.bashAllowlist } : {}),
    hiddenWireTools,
  }))

  let permissions: PermissionControl | undefined
  let noProgressDetector: NoProgressDetector | null = null
  const effectiveMaxTurns = (() => {
    const raw = (opts as { maxTurns?: number }).maxTurns ?? Number(process.env.MINICODE_MAX_TURNS)
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined
  })()
  // Validasi concurrency: 0, NaN, Infinity → fallback ke default (jangan teruskan 0 ke executor)
  const safeConcurrency = (() => {
    const v = opts.concurrency
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  })()
  const safeWriteConcurrency = (() => {
    const v = opts.writeConcurrency
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
  })()
  // Muat bahasa label UI lebih awal; bahasa balasan mengikuti percakapan pengguna.
  const { setConfigLocale } = await import("../src/ui/i18n/locale.ts")
  setConfigLocale((await loadLang().catch(() => undefined)) ?? null)
  const session = await startupPhase("kernel-session", () =>
    createMinicodeSession({
      provider: router,
      tools: sessionTools,
      hiddenWireTools,
      cwd,
      sessionId,
      permissionMode,
      restrictBash,
      // Config `bashAllowlist` (lokal/global) kini benar-benar dipakai gate
      // izin; dulu hanya di-parse lalu diabaikan sehingga edit config tampak
      // tanpa efek. Env MINICODE_BASH_ALLOWLIST tetap menang.
      ...(cfg.bashAllowlist ? { bashAllowlist: cfg.bashAllowlist } : {}),
      allowLocalConfig,
      // P12 S2.2 + P0.2 — WorkMode efektif sesi ini (termasuk pulihan resume).
      workMode: effectiveWorkMode,
      // [Fase 4 / LOOP-13, LOOP-INV-16] Header operasional deterministik di
      // system prompt = buffer kedua yang selalu dikirim dan tak pernah
      // dikompaksi; tidak pernah masuk histori kanonik. Absen = perilaku lama.
      systemExtra: `${runtimeStateHeader ? `${runtimeStateHeader}\n\n` : ""}${systemExtra ?? ""}${recoveryAppendix}`,
      model: modelRef.current,
      getContextModel: () => contextModelId(modelRef.current),
      contextWindowTokens: getContextWindowTokens(),
      contextWindowTokensForModel: getContextWindowTokens,
      // P13.6 — ask permission: composition root boleh menyuntik jalur headless
      // (daemon → ApprovalBroker). Tanpa injeksi tetap prompt TTY; non-TTY ⇒
      // deny (fail-closed), bukan izin diam-diam.
      ask: opts.permissionAsk ?? promptAsk,
      allowNonTtyAsk: opts.permissionAsk !== undefined,
      // Cermin observability persetujuan → adaptor presentasi. Keputusan gate
      // tetap milik permission handler; hook ini hanya melaporkan.
      onApprovalEvent: (e) => {
        presentation?.publishApproval(e)
      },
      // [Fase 1 / LOOP-INV-03] Durability-before-effect: intent jurnal ditulis
      // dan DI-AWAIT sebelum tool dijalankan. Tanpa ini, `execution:started`
      // memicu penulisan fire-and-forget sehingga efek bisa terjadi lebih dulu.
      beforeToolEffect: async (call) => {
        if (journalHandle !== null) await journalHandle.preflightIntent(call)
      },
      onPermissions: (ctl) => {
        permissions = {
          setMode: (m) => {
            ctl.setMode(m)
            setToolPermissionMode?.(m)
          },
          getMode: () => ctl.getMode(),
          getRestrictBash: () => ctl.getRestrictBash?.() ?? false,
        }
      },
      // P12 S2.2 Slice 5 — handle kontrol WorkMode runtime. Setelah sesi
      // dibangun, handle ini di-warisi ke sub-agent/hooks/footer sehingga
      // transisi operator berlaku pada sesi yang sedang berjalan.
      onWorkMode: (ctl) => {
        // P12 S2.2 Slice 5 + P0.2 - SATU sumber state: handler WorkMode (ctl).
        // Visibilitas tool + metadata sesi durable diturunkan dari state sama.
        workModeControl = {
          setWorkMode: (m) => {
            ctl.setWorkMode(m)
            setToolWorkMode?.(m)
            try {
              saveSessionWorkMode(sessionId, m, cwd, { expectedEpoch })
            } catch {}
          },
          getWorkMode: () => ctl.getWorkMode(),
        }
      },
      ...(initialMessages ? { initialMessages } : {}),
      ...(resumeTurnCount !== undefined ? { turnCount: resumeTurnCount } : {}),
      ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
      onNoProgress: (detector) => {
        noProgressDetector = detector
      },
      isExplicitContextWindow: (m) => {
        const resolved = resolveContextWindow(cfg, routedContextModel(m), contextWindowTokens)
        return resolved.source === "override" || resolved.origin === "user"
      },
      // Eskalasi jendela konteks: beritahu user secara eksplisit. Tanpa ini,
      // jendela yang naik otomatis terasa seperti angka ajaib — user perlu tahu
      // bahwa ada BUKTI overflow dan berapa nilai barunya, agar bisa memutuskan
      // menyetel `contextWindows` permanen bila perlu.
      onContextWindowEscalated: (info) => {
        // v7.39: beri MAKNA pada event `context.window` yang selama ini cuma
        // didefinisikan adapter tanpa pemanggil produksi. Eskalasi = bukti
        // overflow nyata → ini titik aman untuk mengirim occupancy ke meter UI.
        presentation?.noteContextWindow({
          usedTokens: info.observedTokens,
          windowTokens: info.toTokens,
          turnId: session.state.turnCount,
        })
        const currentKey = routedContextModel()
        const baseForInfo = resolveContextWindow(cfg, info.model, contextWindowTokens).tokens
        const baseForCurrent = resolveContextWindow(cfg, currentKey, contextWindowTokens).tokens
        escalatedWindows.set(info.model, {
          baseTokens: baseForInfo,
          escalatedTokens: info.toTokens,
        })
        if (currentKey !== info.model && info.model.endsWith(`::${currentKey}`)) {
          escalatedWindows.set(currentKey, {
            baseTokens: baseForCurrent,
            escalatedTokens: info.toTokens,
          })
        }
        const msg = `[context] window raised ${info.fromTokens} → ${info.toTokens} tokens for ${sanitizeAnsi(info.model)} after a verified context overflow (observed ${info.observedTokens}). Set provider.contextWindows to make it permanent.`
        if (enterRepl) {
          presentation?.noteContextCutoff({
            reason: msg,
            usedTokens: info.observedTokens,
            windowTokens: info.toTokens,
            turnId: session.state.turnCount,
          })
        } else {
          startupWrite(`${c.yellow(`${msg}\n`)}`)
        }
      },
      onContextWindowClamped: (info) => {
        const currentKey = routedContextModel()
        const baseForInfo = resolveContextWindow(cfg, info.model, contextWindowTokens).tokens
        const baseForCurrent = resolveContextWindow(cfg, currentKey, contextWindowTokens).tokens
        cappedWindows.set(info.model, {
          baseTokens: baseForInfo,
          cappedTokens: info.toTokens,
        })
        if (currentKey !== info.model && info.model.endsWith(`::${currentKey}`)) {
          cappedWindows.set(currentKey, {
            baseTokens: baseForCurrent,
            cappedTokens: info.toTokens,
          })
        }
        presentation?.noteContextWindow({
          usedTokens: info.observedTokens,
          windowTokens: info.toTokens,
          turnId: session.state.turnCount,
        })
        const msg = `[context] window capped ${info.fromTokens} → ${info.toTokens} tokens for ${sanitizeAnsi(info.model)} after upstream overflow at ${info.observedTokens}.`
        if (enterRepl) {
          presentation?.noteContextCutoff({
            reason: msg,
            usedTokens: info.observedTokens,
            windowTokens: info.toTokens,
            turnId: session.state.turnCount,
          })
        } else {
          startupWrite(`${c.yellow(`${msg}\n`)}`)
        }
      },
      onMaxStepsEscalated: (info) => {
        sessionEvents?.emit({
          type: "provider:extension",
          kind: "max-steps-escalated",
          data: info,
        })
        if (!enterRepl) {
          warnLine(
            `[steps] limit raised ${info.fromSteps} → ${info.toSteps} after ${info.observedSteps} steps; completed steps saved`,
          )
        }
      },
      ...(maxSteps ? { maxSteps } : {}),
      ...(keepRecentTurns ? { keepRecentTurns } : {}),
      ...(safeConcurrency ? { concurrency: safeConcurrency } : {}),
      ...(safeWriteConcurrency ? { writeConcurrency: safeWriteConcurrency } : {}),
      timeoutMs: effectiveWallTimeoutMs ?? Infinity,
      idleTimeoutMs: effectiveTimeoutMs === 0 ? Infinity : effectiveTimeoutMs,
      ...(compaction ? { compaction } : {}),
    }),
  )
  // Kontrak control-plane (Phase 6): late-binding bus untuk usage kompaksi —
  // onUsage dipanggil di tengah turn, saat bus sudah hidup.
  sessionEvents = session.events
  // Content store Fase 4: adapter menaruh konten completed ke store (put
  // selalu jalan); expand(id) di tui di belakang flag.
  contentStore = createContentStore()
  let initialTurn = 0
  let initialTurnStartTs = 0
  for (const turn of shadowState?.turns.values() ?? []) {
    if (turn.turnId > initialTurn) {
      initialTurn = turn.turnId
      initialTurnStartTs = turn.tsStart
    }
  }
  // Adaptor mulai mengamati sejak bus hidup (closure onApprovalEvent di atas
  // aman: check() pertama selalu terjadi setelah wiring ini, saat run()).
  presentation = createPresentationAdapter(session.events, {
    // P2.1: identitas kanonik tunggal — payload dan baris memakai sid yang sama.
    sessionId,
    ...(contentStore ? { contentStore } : {}),
    // PHASE 4A.4 - canonical task identity for the plan projection. TaskStore is
    // the authority: an id is reported only when that row really exists for this
    // session, so an unresolvable plan degrades to the positional shape instead
    // of emitting a false payloadVersion 2.
    taskIdentityProvider: createTaskIdentityResolver(cwd ?? process.cwd()),
    ...(shadowState ? { initialSeq: shadowState.seq, initialTurn, initialTurnStartTs } : {}),
  })
  // P1.6: lifecycle task kanonik dipancarkan pada transisi nyata (bukan hanya
  // setelah verify-settle). Dedupe per (id,status,revision) agar tidak
  // double-report saat verify menyelesaikan task yang sama.
  const taskStatusSeen = new Map<string, string>()
  const noteTaskChanged = (task: ReturnType<TaskStore["listTasks"]>[number]) => {
    const key = `${task.status}:${task.revision}`
    if (taskStatusSeen.get(task.id) === key) return
    if (taskStatusSeen.size >= 2048) {
      const oldest = taskStatusSeen.keys().next().value
      if (oldest !== undefined) taskStatusSeen.delete(oldest)
    }
    taskStatusSeen.set(task.id, key)
    presentation?.noteTaskStatus({
      taskId: task.id,
      status: task.status,
      ...(task.parentId ? { parentId: task.parentId } : {}),
      ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}),
      revision: task.revision,
      verification: task.verification
        ? { verdict: task.verification.verdict, checkedAt: task.verification.checkedAt }
        : { verdict: "unverified", checkedAt: "" },
      turnId: session.state.turnCount,
    })
  }
  const emitTaskStatuses = (): void => {
    try {
      for (const task of new TaskStore(cwd ?? process.cwd()).listTasks(sessionId)) {
        noteTaskChanged(task)
      }
    } catch {}
  }
  session.events.on("execution:completed", (e) => {
    const call = (e as { execution?: { call?: { name?: unknown } } }).execution?.call
    if (call?.name === "todo_write") emitTaskStatuses()
  })
  // P2.3: proyeksi transisi AUTHORITATIVE pasca-commit DB.
  setTaskTransitionSink(({ task }) => noteTaskChanged(task))
  try {
    if (!shadowState) shadowState = createInitialState(sessionId)
    if (!shadowDiag) shadowDiag = createReducerDiagnostics()
    presentation.setTurnSummaryProvider(({ sessionId: eventSessionId, turnId, fallback }) => {
      return shadowState
        ? deriveTurnSummary(shadowState, eventSessionId, turnId, fallback)
        : fallback
    })
    shadowUnsub = presentation.onEvent((e) => {
      try {
        if (shadowState && shadowDiag) reduce(shadowState, e, shadowDiag)
      } catch {
        shadowDivergence++
      }
      queuePresentationEvent(e)
      // [P13.6] Event durable TIDAK diterbitkan live di sini — hanya SETELAH
      // append durable sukses (lihat flushPresentationEvents). Feed live harus
      // subset dari toko durable: kalau append gagal/crash sebelum flush, event
      // itu tidak boleh pernah tampak live (konsumen bisa meng-ack-nya, dan
      // offset durable akan melampaui sejarah yang sebenarnya ada).
      // v7.41 (audit #2 / F2): event non-durable (delta) TETAP ingin segera
      // sampai ke UI (jalur UI = publishPresentationEvent di bawah, sinkron dan
      // tak diubah). Untuk SUBSCRIBER domain yang Seq-keyed, delta juga ikut
      // antrean terurut (createOrderedDomainPublisher): ia memapuskannya SEGERA
      // bila tak ada durable yang lebih awal masih tertahan, kalau ada ia
      // ditahan bersama supaya urutan seq tak terbalik. Order > latensi feed.
      if (!DURABILITY[e.type]?.durable) orderedDomain.enqueue(e)
      publishPresentationEvent(e)
    })
  } catch {
    shadowDivergence++
  }

  const effectiveInitialModel = modelRef.current ?? cfg.providers[0]?.models[0] ?? "default"

  // ── Mutation journal wiring (AUDIT #01C): intent di execution:started,
  // terminal di execution:completed — keduanya post-gate kernel. Total:
  // kegagalan tulis jurnal tak pernah menggagalkan turn (degraded-loud).
  // Fase 4: onCommitted → file.changed (receipt paths+journalSeq) ke adapter.
  // [Fase 1] Simpan handle pre-flight (dipakai barrier di atas) dan pasang
  // pelacakan operasi in-flight untuk `runs.pending_tool_ids`.
  //
  // Penanda in-flight dipasang dari bus event KERNEL, bukan dari barrier:
  // `execution:started` di-emit secara SINKRON tepat sebelum `tool.execute`
  // (vendor/minicore/src/core/executor.ts:86 vs :89), sehingga `beginToolInFlight`
  // (tulis SQLite sinkron) sudah durable saat `tool.execute` mulai. Tool yang
  // ditolak policy tidak pernah sampai ke event ini, jadi daftar hanya berisi
  // operasi yang benar-benar akan berjalan.
  //
  // Catatan kontrak (revisi Fase 1): jalur UTAMA intent sekarang ditulis oleh
  // barrier pre-efek yang DI-AWAIT; listener `execution:started` tinggal
  // fallback untuk tool yang tidak lewat barrier. Konsekuensinya disengaja:
  // gagal menulis intent = tool DITOLAK (fail-closed), bukan jalan tanpa bukti.
  journalHandle = attachMutationJournal(session, {
    sessionId,
    cwd,
    evidenceMode,
    onCommitted: (info) => {
      try {
        presentation?.noteFileChanged(info)
      } catch {}
    },
  })
  session.events.on("execution:started", (e) => {
    const ev = e as unknown as { execution?: { call?: { id?: unknown } } }
    const id = typeof ev.execution?.call?.id === "string" ? ev.execution.call.id : ""
    if (id !== "") beginToolInFlight(id)
  })
  session.events.on("execution:completed", (e) => {
    const ev = e as unknown as { execution?: { call?: { id?: unknown } } }
    const id = typeof ev.execution?.call?.id === "string" ? ev.execution.call.id : ""
    if (id !== "") endToolInFlight(id)
  })

  // ── Shadow checkpoint ──
  // Repo git: simpan SHA tree pre/post turn (O(delta), tanpa cap file, tidak
  // menyentuh index/HEAD user). Non-repo: fallback snapshot isi file seperti
  // sebelumnya. Keduanya menangkap perubahan dari bash/git juga, bukan cuma
  // edit/write_file.
  type TurnSnapshot = Awaited<ReturnType<typeof beginTurnSnapshot>>
  let preTurnPromise: Promise<TurnSnapshot> | null = null
  let activeTurnOrdinal: number | null = null
  let logicalTurn: SessionTurnRecord | null = null
  const postEditSnapshots = new Map<string, { path: string; content: string | null }>()

  // ── Kepemilikan pekerjaan checkpoint (Stage 5B) ──
  //
  // Finalisasi checkpoint kini di-await di lifecycle turn (bukan listener bus),
  // sehingga tidak ada pekerjaan yatim yang lahir dari event. Set dan drain
  // dipertahankan sebagai kontrak close (`pendingCheckpointCount`) dan pengaman
  // untuk pekerjaan yang mungkin ditambahkan di masa depan; kegagalan tetap
  // dicatat di `checkpointFailureNotes` + warn stderr.
  const pendingCheckpointWork = new Set<Promise<unknown>>()
  const checkpointFailureNotes: string[] = []

  /**
   * Diagnostic `[warn]` ke stderr (kontrak writer kelas 3: layer non-UI boleh
   * `process.stderr.write` mentah). Satu helper untuk semua `[warn]` di file
   * ini — jumlah writer inventory tak naik.
   */
  const warnLine = (message: string): void => {
    try {
      process.stderr.write(`[warn] ${message}\n`)
    } catch {}
  }

  /**
   * Drain: TUNGGU seluruh pekerjaan checkpoint yang sudah dimulai.
   *
   * Finalisasi kini di-await langsung di lifecycle turn; drain tetap menjaga
   * pekerjaan yang mungkin masih berjalan saat close.
   */
  const drainCheckpointWork = async (): Promise<void> => {
    while (pendingCheckpointWork.size > 0) {
      const batch = [...pendingCheckpointWork]
      await Promise.allSettled(batch)
      // Buang yang sudah selesai — defensif: drain tak boleh bergantung
      // pada callback settle (kalau tak sempat jalan, loop tak boleh berputar).
      for (const done of batch) pendingCheckpointWork.delete(done)
    }
  }

  let preTurnMode: "git" | "files" | "unavailable" | null = null
  const POST_EDIT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
  const captureBeforeTurn = async (): Promise<void> => {
    preTurnMode = null
    const liveWm = workModeControl?.getWorkMode() ?? effectiveWorkMode
    const livePm = permissions?.getMode() ?? permissionMode
    if (liveWm !== "EXECUTE" || livePm === "readonly" || livePm === "plan") return
    preTurnPromise = beginTurnSnapshot(sessionId, cwd ?? process.cwd())
    pendingCheckpointWork.add(preTurnPromise)
    try {
      const pre = await preTurnPromise
      preTurnMode = pre.mode
    } finally {
      pendingCheckpointWork.delete(preTurnPromise)
    }
  }
  session.events.on("execution:completed", (e) => {
    // Mode shadow-git tidak menggunakan postEditSnapshots; lewati readFileSync
    // sinkron di main thread pada setiap edit/write_file.
    if (preTurnMode === "git") return
    const name = e.execution.call.name
    if (name !== "edit" && name !== "write_file" && name !== "apply_patch") return
    const p = (e.execution.call.args as { path?: string })?.path
    if (!p) return
    const abs = resolvePath(cwd ?? ".", p)
    try {
      const st = statSync(abs)
      if (st.size > POST_EDIT_SNAPSHOT_MAX_BYTES) return
      postEditSnapshots.set(p, { path: p.replace(/\\/g, "/"), content: readFileSync(abs, "utf8") })
    } catch {
      postEditSnapshots.set(p, { path: p.replace(/\\/g, "/"), content: null })
    }
  })
  /**
   * Rekam checkpoint untuk SEMUA outcome, bukan hanya `turn:completed`.
   *
   * Turn yang gagal/di-cancel tetap bisa mengubah berkas sebelum provider
   * berhenti. Tanpa checkpoint, `/undo` harus memilih antara membuang
   * percakapan saja (divergen) atau menolak. Snapshot post-turn diambil dari
   * tree saat finalisasi; turn tanpa perubahan tetap tidak membuat checkpoint.
   */
  const finalizeTurnCheckpoint = async (
    outcome: "completed" | "failed" | "interrupted" | null,
  ): Promise<string | null> => {
    try {
      let pre: TurnSnapshot | null = null
      try {
        pre = await preTurnPromise
      } finally {
        preTurnPromise = null
      }
      const redoSnapshots = [...postEditSnapshots.values()]
      postEditSnapshots.clear()
      if (!pre) return "none"
      const turn = activeTurnOrdinal ?? session.state.turnCount
      if (turn < 1) return null
      const desc = outcome && outcome !== "completed" ? `turn ${turn} (${outcome})` : `turn ${turn}`
      if (pre.mode === "unavailable") {
        warnLine(`checkpoint unavailable: ${pre.reason}; undo/redo will not cover turn ${turn}`)
        return null
      }
      if (pre.mode === "git") {
        const after = await snapshotTree(cwd ?? ".", sessionId, `post-${turn}`)
        if (!after) throw new Error("post-turn snapshot unavailable")
        if (
          !(
            await workspaceChangedPaths(
              pre,
              { mode: "git", tree: after.tree },
              cwd ?? process.cwd(),
            )
          ).length
        )
          return "none"
        const checkpoint = await recordCheckpointFromTrees(
          sessionId,
          turn,
          pre.tree,
          after?.tree,
          desc,
          cwd,
        )
        if (checkpoint) {
          presentation?.noteCheckpoint({
            checkpointId: checkpoint.id,
            turnId: turn,
            paths: [],
          })
        }
        return checkpoint?.id ?? "none"
      }
      if (pre.snapshots.length === 0) return "none"
      let redo = redoSnapshots
      try {
        const { LIMITS } = await import("../src/constants.ts")
        const post = await snapshotWorkspace(cwd ?? ".", LIMITS.WORKSPACE_SNAPSHOT_LIMIT)
        if (post.length) redo = post
      } catch {}
      const checkpoint = await recordCheckpointFromSnapshots(
        sessionId,
        turn,
        pre.snapshots,
        desc,
        cwd,
        redo,
      )
      if (checkpoint) {
        presentation?.noteCheckpoint({
          checkpointId: checkpoint.id,
          turnId: turn,
          paths: (redo ?? []).map((snapshot) => snapshot.path),
        })
      }
      return checkpoint?.id ?? "none"
    } catch (error) {
      const note = `checkpoint failed: ${(error as Error).message}`
      checkpointFailureNotes.push(note)
      warnLine(note)
      return null
    }
  }

  // ── Step trace (Harness-P1) ──
  // Satu baris per tool + ringkasan per step ke .minicode/step-traces.jsonl.
  // Fire-and-forget: observability tak boleh menggagalkan turn (bus kernel
  // juga mengisolasi listener yang melempar). Deny diklasifikasi dari isi
  // observasi karena kernel hanya meng-emit execution:* untuk call yang lolos.
  const toolStarts = new Map<string, number>()
  session.events.on("execution:started", (e) => {
    try {
      toolStarts.set(e.execution.call.id, Date.now())
    } catch {}
  })
  session.events.on("execution:completed", (e) => {
    try {
      const { call, result } = e.execution
      const t0 = toolStarts.get(call.id)
      if (t0 !== undefined) toolStarts.delete(call.id)
      const kind = classifyToolResult(result)
      const reason = kind === "denied" ? denyReasonOf(result) : undefined
      void writeStepTrace(cwd, {
        sessionId,
        timestamp: new Date().toISOString(),
        kind: "tool",
        step: session.state.stepCount,
        tool: call.name,
        ok: kind === "ok",
        ...(kind === "denied" ? { denied: true } : {}),
        ...(reason ? { denyReason: reason } : {}),
        ...(t0 !== undefined ? { durationMs: Date.now() - t0 } : {}),
        args: summarizeArgs(call.args),
        sandbox: process.env.MINICODE_SANDBOX ?? "none",
        // F1.2: token kumulatif sesi saat tool selesai — bahan kurva token.
        // `usage` dideklarasikan di bawah, tapi callback ini baru jalan setelah
        // createCliSession selesai — aman dari TDZ.
        // [Audit #2 B.5] `.catch` di sini redundan: writeStepTrace sudah
        // menelan seluruh error async di dalamnya (trace.ts), dan argumen
        // dibangun sinkron di bawah guard `try/catch` di atas.
        totalTokens: usage.getSession().totalTokens,
      })
    } catch {}
  })
  session.events.on("step:completed", (e) => {
    try {
      if ((e as { forwardedChild?: unknown }).forwardedChild == null) {
        bashObservationEpoch++
      }
      const s = e.step
      void writeStepTrace(cwd, {
        sessionId,
        timestamp: new Date().toISOString(),
        kind: "step",
        step: s.index,
        tools: s.toolCalls.length,
        errors: s.results.filter((r) => r.isError).length,
        sandbox: process.env.MINICODE_SANDBOX ?? "none",
        // F1.2: sama seperti baris tool — kumulatif sesi saat step selesai.
        // [Audit #2 B.5] `.catch` di sini redundan: writeStepTrace sudah
        // menelan seluruh error async di dalamnya (trace.ts), dan argumen
        // dibangun sinkron di bawah guard `try/catch` di atas.
        totalTokens: usage.getSession().totalTokens,
      })
    } catch {}
  })
  // ── Phase C: soft-cap warning (host-side) ──
  // Peringatkan SEKALI per turn saat langkah mendekati cap (~85%) supaya operator
  // tahu batas akan tercapai dan bisa memecah/mendelegasikan sebelum tabrakan
  // keras di "Batas langkah tool tercapai". Operator-facing (stderr); menembus
  // ke MODEL butuh seam system-prompt terpisah (di luar scope fase ini).
  let softStepWarned = false
  session.events.on("context:compacted", (e) => {
    if ((e as { forwardedChild?: unknown }).forwardedChild == null) {
      bashObservationEpoch++
    }
  })
  session.events.on("turn:started", () => {
    softStepWarned = false
  })
  session.events.on("step:completed", (e) => {
    try {
      if (softStepWarned) return
      const cap = maxSteps ?? LIMITS.DEFAULT_MAX_STEPS
      const idx = (e.step as { index?: unknown })?.index
      if (typeof idx !== "number") return
      const threshold = Math.max(1, Math.floor(cap * 0.85))
      if (idx >= threshold && idx < cap) {
        softStepWarned = true
        warnLine(
          `mendekati batas langkah (step ${idx}/${cap}) — bungkus hasil, delegasikan, atau siapkan /resume`,
        )
      }
    } catch {}
  })
  // ── P2.11 observasi verifikasi (observation-only) ──
  // Bukti kanonik hidup di jurnal mutasi; presentasi hanya mengamatinya.
  // Setiap tool selesai (dan setiap turn selesai untuk verifikasi susulan),
  // baca jurnal fire-and-forget lalu terbitkan verification.observed HANYA
  // bila ada baris verifikasi eksplisit untuk invokasi yang tepat-satu.
  // Ketiadaan event = UNKNOWN (diturunkan di proyeksi). Tak pernah melempar
  // ke turn; tak pernah menyimpulkan efek dari teks/status.
  const verificationEmitted = new Set<string>()
  const completedToolCalls: Array<{
    id: string
    tool: string
    argsHash: string
    turn: number | null
    scopeSession: string
  }> = []
  const emitVerificationFromRecords = (
    call: { id: string; tool: string; argsHash: string; turn: number | null },
    scopeSession: string,
    records: Awaited<ReturnType<typeof loadJournal>>["records"],
  ): void => {
    const observation = pendingVerificationObservation(
      {
        toolCallId: call.id,
        tool: call.tool,
        turn: call.turn,
        argsHash: call.argsHash,
        sessionId: scopeSession,
      },
      records,
      verificationEmitted,
    )
    if (!observation) return
    if (verificationEmitted.size >= 2048) {
      const oldest = verificationEmitted.values().next().value
      if (oldest !== undefined) verificationEmitted.delete(oldest)
    }
    verificationEmitted.add(observation.invocationId)
    try {
      presentation?.noteVerificationObserved({
        toolCallId: observation.toolCallId,
        invocationId: observation.invocationId,
        verdict: observation.verdict,
        method: observation.method,
        observedAt: observation.observedAt,
        ...(scopeSession !== sessionId ? { sessionId: scopeSession } : {}),
      })
    } catch {}
  }
  const emitVerificationForCall = (
    call: { id: string; tool: string; argsHash: string; turn: number | null },
    scopeSession: string,
  ): void => {
    void (async () => {
      try {
        const loaded = await loadVerificationJournal(scopeSession, cwd)
        if (!loaded.hasVerification) return
        emitVerificationFromRecords(call, scopeSession, loaded.records)
      } catch {}
    })()
  }
  session.events.on("execution:completed", (e) => {
    try {
      const call = e.execution?.call as { id?: unknown; name?: unknown; args?: unknown } | undefined
      if (!call || typeof call.id !== "string" || typeof call.name !== "string") return
      if (call.name === "todo_write") {
        turnTodoWriteSeq++
      }
      const isWorkDelegate =
        call.name === "delegate_task" &&
        (call.args as { mode?: unknown } | undefined)?.mode === "work"
      if (call.name === "delegate_task" ? isWorkDelegate : isMutationTool(call.name)) {
        turnMutationAttemptSeq++
      }
      if (!e.execution?.result?.isError && WRITE_TOOLS.has(call.name)) {
        workspaceMutationEpoch++
      }
      const childId = (e as { forwardedChild?: unknown }).forwardedChild
      const scopeSession = typeof childId === "string" && childId ? childId : sessionId
      const turn = typeof session.state?.turnCount === "number" ? session.state.turnCount : null
      const descriptor = {
        id: call.id,
        tool: call.name,
        argsHash: hashArgs(call.args ?? {}),
        turn,
        scopeSession,
      }
      completedToolCalls.push(descriptor)
      if (completedToolCalls.length > 500) {
        completedToolCalls.splice(0, completedToolCalls.length - 500)
      }
      emitVerificationForCall(descriptor, scopeSession)
    } catch {}
  })
  session.events.on("turn:completed", () => {
    compactionCtl?.noteTurnCompleted()
    // [Audit F-04] Agregasi ukuran batch presentasi per turn, lalu reset.
    perfCount("presentation.flush.turnTotal", 0, turnBatchEvents)
    turnBatchEvents = 0
    // Sapu verifikasi susulan dalam turn yang sama (late verification):
    // kelompokkan per scopeSession dan baca jurnal SEKALI per sesi (bukan N×
    // pembacaan paralel saat turn memiliki puluhan/ratusan tool call).
    try {
      const pending = completedToolCalls.splice(0)
      if (pending.length === 0) return
      const byScope = new Map<string, typeof pending>()
      for (const call of pending) {
        const list = byScope.get(call.scopeSession)
        if (list) list.push(call)
        else byScope.set(call.scopeSession, [call])
      }
      for (const [scopeSession, calls] of byScope) {
        void (async () => {
          try {
            const loaded = await loadVerificationJournal(scopeSession, cwd)
            if (!loaded.hasVerification) return
            for (const call of calls)
              emitVerificationFromRecords(call, scopeSession, loaded.records)
          } catch {}
        })()
      }
    } catch {}
  })
  // ── Auto-verify & self-heal ──
  // Auto-deteksi skrip repo (package.json / Makefile / dll.) HANYA boleh jalan
  // saat repo sudah dipercaya (--allow-local-config) agar membuka repo asing
  // dengan --verify tidak otomatis mengeksekusi skrip repo tak tepercaya.
  const verifyCommand = verify
    ? (process.env.MINICODE_VERIFY_CMD ??
      cfg.verifyCommand ??
      (allowLocalConfig === true ? detectVerifyCommand(cwd) : undefined) ??
      "")
    : ""
  const verifyActive = verifyCommand.length > 0
  if (verifyActive) {
    // BUG-8: kegagalan capture dulu ditelan diam-diam. Sekarang dicatat SEKALI
    // ke stderr — operator perlu tahu bahwa atribusi tamper akan konservatif.
    let baselineCaptureWarned = false
    await captureSessionEvaluationBaseline(sessionId, cwd ?? process.cwd()).catch((err) => {
      if (baselineCaptureWarned) return
      baselineCaptureWarned = true
      process.stderr.write(
        `[verify] cannot capture evaluation baseline: ${(err as Error)?.message ?? String(err)} — tamper attribution will be conservative\n`,
      )
    })
  }
  // Sumber bukti completion untuk domain task (INV-003). Menyimpan hasil
  // verify TERAKHIR: pada saat `todo_write` berjalan, verify untuk turn ini
  // BELUM pernah jalan (verify terjadi setelah turn selesai), jadi bukti yang
  // relevan adalah hasil turn sebelumnya. Maknanya persis yang dibutuhkan:
  // "verify terakhir merah" -> agent tidak boleh menandai task selesai pada
  // turn berikutnya sebelum memperbaiki yang merah.
  //
  // Tanpa `--verify` (opt-in) tidak ada bukti sama sekali → `unverified`:
  // completion tetap diizinkan, tapi tidak diklaim terverifikasi.
  let lastVerify: {
    ok: boolean
    command: string
    output: string
    turn: number | null
    exitCode: number
  } | null = null
  setCompletionEvidence(() => {
    const liveWm = workModeControl?.getWorkMode() ?? effectiveWorkMode
    const livePm = permissions?.getMode() ?? permissionMode
    if (!verifyActive) return { verdict: "unverified" }
    // Jangan pernah meloloskan `completed` tanpa bukti hanya karena user
    // beralih mode BUILD -> DISCUSS/readonly/plan di tengah sesi `--verify`.
    if (liveWm !== "EXECUTE" || livePm === "readonly" || livePm === "plan") {
      return { verdict: "unverified", requireVerified: true }
    }
    // [Fase 3 / LOOP-INV-12, LOOP-G20] Saat `--verify` aktif tetapi verifier
    // belum menghasilkan verdict pertama, tandai `requireVerified: true` agar
    // klaim `completed` ditahan di `VERIFYING` (bukan diloloskan fail-open).
    if (!lastVerify) return { verdict: "unverified", requireVerified: true }
    if (lastVerify.ok)
      return {
        verdict: "passed",
        detail: lastVerify.command,
        exitCode: lastVerify.exitCode,
        summary: lastVerify.output.slice(0, 300) || lastVerify.command,
        requireVerified: true,
        // P10.1.1: ikat bukti ke turn yang diobservasinya — dibaca sinkron
        // tepat setelah verify selesai (belum ada turn baru), sehingga cocok
        // dengan cap `turn` intent jurnal (increment-di-awal di loop.ts).
        // Absen = tak terikat → hilir perlakukan sebagai unverified.
        ...(typeof lastVerify.turn === "number" ? { turn: lastVerify.turn } : {}),
      }
    return {
      verdict: "failed",
      detail: `last verification failed (${lastVerify.command}): ${lastVerify.output.slice(0, 200)}`,
      exitCode: lastVerify.exitCode,
      summary: lastVerify.output.slice(0, 300),
      requireVerified: true,
    }
  })
  const runVerifyWithPresentation = async (signal?: AbortSignal) => {
    const effectiveRoot = cwd ?? process.cwd()
    const result = await runVerify(verifyCommand, effectiveRoot, undefined, signal)
    // [Fase 3 / LOOP-INV-12] Tier 1 integrity check pada file yang dimutasi di
    // jurnal sesi ini sebelum mengizinkan status akhir hijau.
    let integrityOk = true
    let integrityDetail = ""
    let tamperReason = ""
    const loaded = await loadJournal(sessionId, effectiveRoot).catch(() => null)
    const modified = await collectSessionModifiedFiles(
      sessionId,
      effectiveRoot,
      loaded?.status === "valid" ? loaded.records : undefined,
    )
    if (modified.length > 0) {
      const integrity = await checkWorkspaceIntegrity(modified, effectiveRoot)
      integrityOk = integrity.ok
      if (!integrity.ok) integrityDetail = integrity.summary
      // [Fase 6A / ACE-02] Evaluator/gate yang disentuh membatalkan seluruh
      // klaim verifikasi (fail-closed) — tidak ada jalan "hijau" via curang.
      const tamper = await detectEvaluationTampering(modified, effectiveRoot)
      if (tamper.tampered) tamperReason = tamper.reason
    }
    const effectiveOk = result.ok && integrityOk && tamperReason === ""
    const effectiveOutput = !integrityOk
      ? `${integrityDetail}${result.output ? `\n${result.output}` : ""}`
      : tamperReason
        ? `EVALUATOR_TAMPER_ATTEMPT: ${tamperReason}${result.output ? `\n${result.output}` : ""}`
        : result.output
    const effectiveExitCode = effectiveOk ? (result.exitCode ?? 0) : result.exitCode || 1
    // Turn state kode ini diverifikasi: turnCount SETELAH turn terakhir
    // selesai = nilai yang dibawa intent mutasi turn itu (turnOf baca live
    // state yang sama). Diambil sinkron di sini — belum ada turn baru yang
    // bisa menyela dan menggeser angka.
    const verifiedTurn =
      typeof session.state?.turnCount === "number" ? session.state.turnCount : null
    lastVerify = {
      ok: effectiveOk,
      command: verifyCommand,
      output: effectiveOutput,
      turn: verifiedTurn,
      exitCode: effectiveExitCode,
    }
    // [Fase 6A / ACE-01] Terjemahkan bukti verifikasi menjadi keputusan
    // consequence deterministik. `repeatedFailureCount` memakai streak
    // SEBELUM percobaan ini (kontrak evaluateConsequence).
    const tampered = tamperReason.length > 0
    const { transient, permissionBlocked } = effectiveOk
      ? { transient: false, permissionBlocked: false }
      : classifyVerifyFailure({
          ok: false,
          output: effectiveOutput,
          timedOut: result.timedOut,
        })
    const failureType: AceFailureType = effectiveOk ? null : transient ? "timeout" : "functional"
    const repeatedBefore = verifyFailureStreak
    verifyFailureStreak = effectiveOk ? 0 : verifyFailureStreak + 1
    // [Fase 9 / 9.1] Operational rollback switch: `MINICODE_ACE_ENABLED=0`
    // melewati seluruh evaluasi consequence (baseline murni) — `lastAceDecision`
    // tetap null sehingga `ace_state` tidak ikut ke RUNTIME_STATE_HEADER, dan
    // pelajaran kandidat ACE tidak dipromosikan. Hard-safety/tamper-guard TETAP
    // aktif (sudah diterapkan di atas via `detectEvaluationTampering`).
    if (isAceEnabled()) {
      lastAceDecision = evaluateConsequence({
        verificationPassed: effectiveOk,
        evaluatorTamperAttempt: tampered,
        failureType,
        isTransientError: transient,
        repeatedFailureCount: repeatedBefore,
        newEvidenceSinceLastAttempt:
          noProgressDetector?.snapshot().newEvidenceSinceFailure === true,
        blockedByPermissionOrExternalBlocker: permissionBlocked,
        budgetExhausted:
          typeof effectiveMaxTurns === "number" && session.state.turnCount >= effectiveMaxTurns,
        insufficientEvidence: !effectiveOk && effectiveOutput.trim().length === 0,
        baselineContentChanged: false,
      })
      // F-CTRL-1/F-CTRL-2: keputusan consequence terstruktur masuk observability
      // (bukan hanya stderr). VERIFYING / Tamper Guard kini terlihat lewat
      // `newEvidenceSinceLastAttempt` + `failureClass`/`nextAction`.
      presentation?.noteConsequenceDecided({
        verdict: lastAceDecision.verdict,
        failureClass: lastAceDecision.failureClass,
        nextAction: lastAceDecision.nextAction,
        rationale: lastAceDecision.rationale,
        newEvidenceSinceLastAttempt: lastAceDecision.newEvidenceSinceLastAttempt,
        turnId: session.state.turnCount,
      })
      if (lastAceDecision && lastAceDecision.verdict === "BLOCKED") {
        process.stderr.write(
          c.dim(
            `[ace] verdict=BLOCKED next_action=${lastAceDecision.nextAction} — ${lastAceDecision.rationale}\n`,
          ),
        )
      }
      // [Fase 6A / ACE-03] Pelajaran kandidat sesi ini dipromosikan hanya bila
      // verifikasi hijau; kegagalan sementara/human-blocker tidak menghukumnya.
      const lessonVerdict: "passed" | "failed" | "unknown" = effectiveOk
        ? "passed"
        : lastAceDecision.failureClass === "TRANSIENT_ENV" ||
            lastAceDecision.failureClass === "PERMISSION_OR_EXTERNAL_BLOCKER" ||
            lastAceDecision.failureClass === "INSUFFICIENT_EVIDENCE"
          ? "unknown"
          : "failed"
      try {
        await promoteOrRejectLessonsBySession(sessionId, lessonVerdict, effectiveRoot)
      } catch {}
    }
    if (effectiveOk) {
      noProgressDetector?.noteVerificationPassed()
    }
    try {
      const settled = settleSessionVerifyingTasks(effectiveRoot, sessionId, {
        ok: effectiveOk,
        verdict: effectiveOk ? "passed" : "failed",
        exitCode: effectiveExitCode,
        command: verifyCommand,
        summary: effectiveOutput.slice(0, 300) || verifyCommand,
        integrityOk: integrityOk && !tampered,
      })
      // F-TASK-1/P1.6: status task kanonik (t<n>) + DAG diamati sebagai event,
      // bukan hanya efek samping TaskStore. Dedupe yang sama dengan jalur
      // todo_write agar satu transisi tidak dilaporkan dua kali.
      emitTaskStatuses()
      if (settled.length > 0) {
        const synced = await syncTodoViewsFromTaskStore(sessionId, effectiveRoot).catch(() => null)
        if (synced) {
          presentation?.notePlanReconciled({
            todos: synced,
            sessionId,
            turnId: session.state.turnCount,
          })
        }
      }
    } catch {}
    const evidence = parseVerifyTestEvidence(verifyCommand, effectiveOutput)
    if (evidence) {
      presentation?.noteTestCompleted({
        toolCallId: `verify:${sessionId}`,
        turnId: session.state.turnCount,
        ...evidence,
      })
    }
    return effectiveOk === result.ok
      ? result
      : { ok: false, output: effectiveOutput, command: verifyCommand, exitCode: effectiveExitCode }
  }
  // Audit #10 P2 observability: perintah verify (bisa dari config repo bila
  // opt-in, atau package.json) dieksekusi via shell — tampilkan SEBELUM
  // jalan pertama agar operator tahu persis apa yang dieksekusi.
  if (verifyActive) {
    process.stderr.write(c.dim(`${formatVerifyNotice(verifyCommand)}\n`))
  }
  // Audit #10 P1: hooks berjalan di luar permission system — di mode tanpa
  // eksekusi (plan/readonly) hook TETAP mengeksekusi tanpa gate, melanggar
  // kontrak read-only. Lewati + beri tahu sekali per sesi. P12 S2.2: WorkMode
  // DISCUSS (posture read-only penuh) juga menahan hooks walau permissionMode
  // auto — lihat shouldRunHooks.
  //
  // P12 S2.2 Slice 5: predicate dievaluasi PER PEMANGGILAN (bukan snapshot
  // `hooksAllowed` saat session dibuat) supaya transisi WorkMode operator
  // berlaku pada sesi yang sedang berjalan.
  let hooksSkippedNotice = false
  let verifySkippedNotice = false
  const runHooksGated = async (
    phase: "pre" | "post",
    ctx: { phase: "pre" | "post"; prompt: string; cwd?: string; result?: unknown },
    signal?: AbortSignal,
  ): Promise<void> => {
    const liveWorkMode = workModeControl?.getWorkMode() ?? effectiveWorkMode
    const livePm = permissions?.getMode() ?? permissionMode
    if (!shouldRunHooks(livePm, liveWorkMode)) {
      if (!hooksSkippedNotice) {
        hooksSkippedNotice = true
        const reasonLabel =
          liveWorkMode !== "EXECUTE" ? `work-mode ${liveWorkMode}` : `${livePm} mode`
        const msg = `[hooks] skipped in ${reasonLabel} (read-only contract)`
        if (enterRepl) {
          session.events.emit({
            type: "provider:extension",
            kind: "session-notice",
            data: { line: msg },
          })
        } else {
          process.stderr.write(c.dim(`${msg}\n`))
        }
      }
      return
    }
    await runRunHooks(phase, ctx, signal, {
      allowLocal: allowLocalConfig === true,
      ...(enterRepl
        ? {
            onNotice: (line) => {
              session.events.emit({
                type: "provider:extension",
                kind: "session-notice",
                data: { line },
              })
            },
          }
        : {}),
    })
  }

  /**
   * Guard single-session: tolak run kedua dari sesi lain sebelum menyentuh
   * provider/jurnal. Release di finally — termasuk saat turn melempar.
   */
  async function runPromptWithVerify(p: string, signal?: AbortSignal): Promise<void> {
    if (activeAgentSessionId !== null && activeAgentSessionId !== sessionId) {
      throw new ConcurrentAgentSessionError(activeAgentSessionId, sessionId)
    }
    // v7.41 (audit #1): naikkan generasi DI LUAR loop retry. Retry transien
    // memanggil ulang runPromptWithVerifyImpl dengan generasi yang sama, sehingga
    // tool call yang dijalankan ulang memakai kunci idempotency yang sama dan
    // ditolak oleh dedup bila efeknya sudah committed. Prompt baru = generasi
    // baru = tulis identik yang memang berbeda tetap diizinkan.
    recoveryGeneration++
    const previous = activeAgentSessionId
    activeAgentSessionId = sessionId
    const activeAgentPrevious = activeAgentSessionId
    void activeAgentPrevious
    const deadline = createRunDeadline()
    let outageStartedAtMs: number | null = null
    let outageCooldownAttempt = 0
    const touchDeadline = () => deadline.touch()
    const resetOutageEpisode = () => {
      outageStartedAtMs = null
      outageCooldownAttempt = 0
    }
    const offDeadlineEvents = [
      session.events.on("turn:started", touchDeadline),
      session.events.on("step:started", touchDeadline),
      session.events.on("step:completed", () => {
        touchDeadline()
        resetOutageEpisode()
      }),
      session.events.on("turn:completed", resetOutageEpisode),
      session.events.on("execution:started", touchDeadline),
      session.events.on("execution:completed", touchDeadline),
      session.events.on("provider:text", touchDeadline),
      session.events.on("provider:extension", touchDeadline),
    ]
    const runSignal = deadline.signal
      ? signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal
      : signal
    try {
      // [T-009 OBSERVATION.md] Resume otomatis untuk kegagalan TRANSIEN.
      //
      // KENAPA memakai LEDGER BERSAMA: retry provider (lapisan recovery) dan
      // resume turn (di sini) adalah dua lapisan. Memberi masing-masing anggaran
      // sendiri membuat biayanya BERKALI — pola *retry amplification* yang
      // menahan user ~82 dtk untuk provider yang mati. Satu ledger per prompt
      // berarti satu anggaran waktu dan satu kuota percobaan dipakai bersama,
      // sehingga biaya total konstan berapa pun lapisannya.
      const ledger = createRecoveryLedger()
      for (;;) {
        try {
          return await runPromptWithVerifyImpl(p, runSignal, ledger)
        } catch (error) {
          // Jangan retry atau tidur bila pengguna membatalkan atau batas waktu sudah habis.
          if (runSignal?.aborted) throw error
          const failure = classifyFailure(error, {
            userAborted: signal?.aborted === true && deadline.signal?.aborted !== true,
          })
          let decision = decideTurnResume(failure, ledger, p.trim().length > 0)
          let tier2Cooldown = false
          if (decision.action !== "retry" && autonomous) {
            if (outageStartedAtMs === null) outageStartedAtMs = Date.now()
            const cooldown = planAutonomousOutageCooldown({
              failure: {
                ...failure,
                message: error instanceof Error ? error.message : String(error),
              },
              elapsedOutageMs: Date.now() - outageStartedAtMs,
              cooldownAttempt: outageCooldownAttempt,
              hasPrompt: p.trim().length > 0,
            })
            if (cooldown.action === "retry") {
              outageCooldownAttempt = cooldown.attempt
              decision = cooldown
              tier2Cooldown = true
              ledger.resetEpisode()
            }
          }
          if (decision.action !== "retry") throw error
          // Tunda timer inaktivitas selama jeda retry/outage terencana agar
          // tidur pemulihan panjang tak langsung diputus watchdog inaktivitas.
          deadline.suspendInactivity()
          const secs = (decision.delayMs / 1000).toFixed(1)
          const left = Math.max(0, Math.round(decision.remainingMs / 1000))
          if (tier2Cooldown) {
            warnLine(
              `[recovery:outage] jeda cooldown otonom #${decision.attempt} (${secs} dtk, sisa jendela ${left} dtk)`,
            )
          } else {
            process.stderr.write(
              `[recovery] gangguan penyedia — melanjutkan turn otomatis ` +
                `(percobaan ${decision.attempt}, jeda ${secs} dtk, sisa anggaran ${left} dtk)\n`,
            )
          }
          // Tidur sadar-abort agar Esc/Ctrl+C atau deadline memutus jeda seketika
          // alih-alih menahan giliran sampai delayMs selesai.
          try {
            await new Promise<void>((resolve) => {
              if (runSignal?.aborted) {
                resolve()
                return
              }
              const onAbort = () => {
                clearTimeout(timer)
                resolve()
              }
              const timer = setTimeout(() => {
                runSignal?.removeEventListener("abort", onAbort)
                resolve()
              }, decision.delayMs)
              runSignal?.addEventListener("abort", onAbort, { once: true })
            })
          } finally {
            deadline.resumeInactivity()
          }
          // Pengguna menekan Ctrl+C saat menunggu: berhenti, jangan lanjut.
          if (runSignal?.aborted) throw error
        }
      }
    } finally {
      for (const off of offDeadlineEvents) {
        try {
          off()
        } catch {}
      }
      deadline.cancel()
      if (activeAgentSessionId === sessionId) activeAgentSessionId = previous ?? null
    }
  }

  /**
   * Terjemahkan error nyata menjadi `FailureSignal` murni untuk kebijakan.
   * Kategori provider bisa berada di `cause` (adapter membungkusnya), jadi
   * rantai cause ditelusuri berbatas — bukan while(true) pada objek asing.
   */
  function classifyFailure(error: unknown, opts: { userAborted: boolean }): FailureSignal {
    let category: string | undefined
    let kind: string | undefined
    let retryAfterMs: number | undefined
    let stalled = false
    let node: unknown = error
    for (let depth = 0; depth < 5 && node !== null && node !== undefined; depth++) {
      if (typeof node !== "object") break
      const rec = node as {
        category?: unknown
        kind?: unknown
        retryAfterMs?: unknown
        message?: unknown
        cause?: unknown
      }
      if (typeof rec.category === "string" && category === undefined) category = rec.category
      if (typeof rec.kind === "string" && kind === undefined) kind = rec.kind
      if (typeof rec.retryAfterMs === "number" && retryAfterMs === undefined)
        retryAfterMs = rec.retryAfterMs
      if (
        !stalled &&
        typeof rec.message === "string" &&
        (/sent nothing for (\d+)ms/i.test(rec.message) ||
          /timed out after \d+ms/i.test(rec.message))
      ) {
        stalled = true
      }
      node = rec.cause
    }
    return {
      ...(category !== undefined ? { category } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(stalled ? { stalled: true } : {}),
      abortedByUser: opts.userAborted,
    }
  }

  /**
   * Keputusan resume turn, memakai anggaran bersama.
   *
   * Saklar `MINICODE_TURN_AUTO_RESUME=0` dipakai tes yang memang menguji jalur
   * gagal cepat (provider lokal tak terjangkau) dan operator yang ingin
   * kegagalan provider langsung terlihat tanpa jeda. Default tetap menyala.
   */
  function decideTurnResume(
    failure: FailureSignal,
    ledger: RecoveryLedger,
    hasPrompt: boolean,
  ): RecoveryDecision {
    if (process.env.MINICODE_TURN_AUTO_RESUME === "0")
      return { action: "stop", reason: "not-transient" }
    const next = ledger.nextDelay(failure)
    if (next !== null)
      return {
        action: "retry",
        attempt: next.attempt,
        delayMs: next.delayMs,
        remainingMs: ledger.remainingMs(),
      }
    // Kuota/anggaran yang menahan: laporkan alasannya, bukan "not-transient".
    return planRecovery(
      failure,
      {
        startedAtMs: ledger.startedAtMs,
        nowMs: Date.now(),
        attemptsUsed: ledger.attemptsUsed(),
        stallAttemptsUsed: ledger.stallAttemptsUsed(),
      },
      { hasPrompt },
    )
  }

  async function runPromptWithVerifyImpl(
    p: string,
    signal?: AbortSignal,
    recoveryLedger?: RecoveryLedger,
  ): Promise<void> {
    if (signal?.aborted) {
      const reason = signal.reason
      if ((reason as { kind?: unknown } | undefined)?.kind === "timeout") {
        const message = reason instanceof Error ? reason.message : "run exceeded wall-clock timeout"
        process.stderr.write(`[timeout] ${message}\n`)
        throw reason
      }
      throw new AgentError("aborted", "turn aborted", { cause: reason })
    }
    // Sinyal per-prompt berlaku pada persiapan turn, provider retry, tool, dan
    // verify. Kernel memiliki timeout lapis kedua khusus eksekusi model.
    const composedSignal = signal
    // P2.2: pagar pra-turn (lihat ensureWriterFresh). Basi → turn dilewati
    // sebelum provider dibelanjakan; histori tak tersentuh.
    if (!ensureWriterFresh()) return
    // P2.6: tutup Run sebelumnya (terminal dari outcome-nya), lalu buka Run
    // RUNNING baru untuk invokasi ini. Urutan penting: terminal LAMA dulu
    // (UNIQUE RUNNING per sesi), lalu create. Gagal di sini = gagal loud
    // (lebih baik daripada fork diam-diam).
    markPreviousRunTerminal()
    const thread = ensureDefaultThread(sessionId, cwd, { expectedEpoch })
    const created = createRun(sessionId, thread.thread_id, cwd, { expectedEpoch })
    transitionRun(created.run_id, "RUNNING", cwd, { expectedEpoch })
    currentRunId = created.run_id
    lastTerminalRun = null
    // [Fase 1 / LOOP-INV-10] Ikat pelacakan in-flight ke run yang baru hidup.
    // Sejak titik ini setiap tool yang dieksekusi dicatat durable ke
    // `runs.pending_tool_ids` sebelum efeknya, lalu dilepas saat selesai.
    setPendingToolsRun(created.run_id, cwd)
    lastTurnOutcome = null
    activeTurnOrdinal = session.state.turnCount + 1
    // Listener UI segar tiap turn (pagar turn yatim — lihat attachUI).
    attachUI()
    // Fase 0: prefix kanonik + ledger turn direkam SEBELUM prompt masuk ke
    // histori/event. beforeEventSeq diambil sebelum noteUserMessage supaya
    // cabang rewind memotong tepat sebelum prompt turn ini, bukan sesudahnya.
    // Kegagalan menulis ledger = fail-closed: run diselesaikan lebih dulu agar
    // tak ada RUNNING yatim, lalu error diteruskan (turn tak dijalankan).
    try {
      await captureBeforeTurn()
      logicalTurn = beginSessionTurn(
        sessionId,
        {
          runId: created.run_id,
          prompt: p,
          beforeMessages: loadThreadHistoryWithSeq(sessionId, thread.thread_id, cwd).map(
            (row) => row.message,
          ),
          beforeEventSeq: presentationHead(sessionId, cwd),
        },
        cwd ?? process.cwd(),
        { expectedEpoch },
      )
    } catch (error) {
      lastTurnOutcome = "failed"
      try {
        markPreviousRunTerminal()
      } catch {}
      // Lepas listener UI yang sudah terpasang sebelum melempar, agar turn
      // gagal di fase ledger tidak meninggalkan listener duplikat.
      detachUI()
      throw error
    }
    try {
      presentation?.noteUserMessage({
        text: p,
        turnId: logicalTurn ? Math.max(0, logicalTurn.ordinal - 1) : session.state.turnCount,
      })
    } catch {}
    // Tandai turn aktif: bila proses mati di tengah (segfault/kill), sesi
    // berikutnya menemukan marker yatim dan memberi tahu (bukan hilang bisu).
    // Dihapus di finally di bawah pada SEMUA jalur settle.
    const { clearTurnActive, markTurnActive } = await import("../src/session/turn-marker.ts").catch(
      () => ({}) as { clearTurnActive?: unknown; markTurnActive?: unknown },
    )
    try {
      ;(markTurnActive as ((cwd?: string, id?: string) => void) | undefined)?.(cwd, sessionId)
    } catch {}
    try {
      await runPromptWithVerifyInner(p, composedSignal, recoveryLedger)
      lastTurnOutcome = "completed"
    } catch (e) {
      lastTurnOutcome = classifyTurnError(e, composedSignal?.aborted === true)
      throw e
    } finally {
      // [Fase 1 / LOOP-INV-03] Bukti terminal jurnal harus TUNTAS sebelum turn
      // dinyatakan selesai (return/throw). Tanpa await ini, turn bisa berakhir
      // saat append terminal masih di jalan — konsumen melihat "selesai" tanpa
      // bukti. Best-effort: kegagalan sudah dicatat degraded oleh jurnal.
      if (journalHandle !== null) {
        await journalHandle.flushPending().catch(() => {})
      }
      const outcome = lastTurnOutcome
      // Checkpoint harus selesai sebelum turn dianggap settle: provider/abort
      // bisa meninggalkan perubahan berkas yang belum tercatat. Kegagalan
      // snapshot tidak boleh menutupi outcome turn.
      const checkpointId = await finalizeTurnCheckpoint(outcome)
      activeTurnOrdinal = null
      // Fase 0: tutup ledger turn dengan status terminal + id checkpoint.
      // Urutan penting: checkpoint dulu, baru settle supaya checkpoint_id ikut
      // tersimpan dan rewind tahu batas berkas turn ini. Sentinel "none" dari
      // checkpoint (turn tanpa perubahan) dinormalisasi jadi null di ledger.
      if (logicalTurn) {
        const status =
          outcome === "completed"
            ? "COMPLETED"
            : outcome === "interrupted"
              ? "INTERRUPTED"
              : "FAILED"
        try {
          settleSessionTurn(
            sessionId,
            logicalTurn.ordinal,
            status,
            checkpointId === null || checkpointId === "none" ? null : checkpointId,
            cwd ?? process.cwd(),
            { expectedEpoch },
          )
        } catch (error) {
          warnLine(`turn ledger settle failed: ${(error as Error).message}`)
        }
        logicalTurn = null
      }
      // Prompt yang gagal sebelum persist (mis. provider 503) tetap harus
      // durable; tanpa ini user tak bisa melihat/meng-undo prompt tersebut.
      // Sukses tetap dipersist oleh pemanggil (TUI/one-shot) seperti semula.
      if (outcome !== null && outcome !== "completed") {
        try {
          await persistCurrent(usage.get(modelRef.current))
        } catch (error) {
          warnLine(`failed-turn persist failed: ${(error as Error).message}`)
        }
        // Jangan biarkan run FAILED/INTERRUPTED berstatus RUNNING sampai turn
        // berikutnya: tombstone/proses lain harus melihat terminal segera.
        // Bungkus try/catch agar kegagalan SQLite di sini tidak pernah melewati
        // detachUI() dan clearTurnActive() di bawahnya.
        try {
          markPreviousRunTerminal()
        } catch (error) {
          warnLine(`failed-turn run finalize failed: ${(error as Error).message}`)
        }
      }
      detachUI()
      try {
        ;(clearTurnActive as ((cwd?: string, id?: string) => void) | undefined)?.(cwd, sessionId)
      } catch {}
    }
  }

  async function runPromptWithVerifyInner(
    p: string,
    signal?: AbortSignal,
    recoveryLedger?: RecoveryLedger,
  ): Promise<void> {
    // Semua session.run settle lewat sini: finally memastikan garis status
    // berhenti pada sukses MAUPUN gagal/abort (kernel hanya emit
    // turn:completed di jalur sukses — tanpa ini painter basi menimpa prompt).
    const runOnce = async (prompt: string, s?: AbortSignal) => {
      // Pemutus budget MID-TURN (audit 2026-09-16 M3): pre-check driver hanya
      // menolak prompt BARU, sehingga tool loop / siklus self-heal bisa
      // belanja tanpa batas dalam satu turn. Watcher membaca biaya LIVE dari
      // collector dan menggugurkan turn via controller gabungan begitu pagu
      // lewat (atau cost tak dikenal + pemakaian — fail-closed default). Tanpa --budget =
      // no-op (sinyal parent diteruskan apa adanya, zero-cost).
      // `formatUsd` diimpor di bawah (sebelum return) tapi selalu terinisiasi
      // sebelum runOnce pertama dipanggil — aman dipakai di closure ini.
      const ctl = new AbortController()
      const onParentAbort = () => ctl.abort(s?.reason)
      if (s) {
        if (s.aborted) ctl.abort(s.reason)
        else s.addEventListener("abort", onParentAbort, { once: true })
      }
      const stopWatch = watchBudgetLimit({
        bus: session.events,
        budget,
        strict: budgetStrict ?? false,
        maxTurns: effectiveMaxTurns,
        getCost: () => usage.getSession().cost,
        getTokens: () => usage.getSession().totalTokens,
        getTurns: () => session.state.turnCount,
        onOver: (st, cost) => {
          // F-CTX-2: pemotongan mi-stream yang durable → masuk transkrip.
          presentation?.noteContextCutoff({
            reason:
              st === "max-turns"
                ? `max turns (${effectiveMaxTurns}) reached`
                : st === "over" && cost != null && budget != null
                  ? `budget exceeded: ${formatUsd(cost)} > ${formatUsd(budget)}`
                  : "budget exceeded: cost unknown (model without pricing)",
            // Occupancy konteks (bukan spend sesi) — budget cutoff adalah
            // peristiwa berbeda; field tetap konsisten dengan meter context.
            usedTokens: session.contextTokens,
            windowTokens: getContextWindowTokens(),
            turnId: session.state.turnCount,
          })
          process.stderr.write(
            st === "max-turns"
              ? `[budget] max turns (${effectiveMaxTurns}) reached - stopping turn.\n`
              : st === "over" && cost != null && budget != null
                ? `[budget] ${formatUsd(cost)} > ${formatUsd(budget)} - over budget, stopping turn.\n`
                : `[budget] cost unknown (model without pricing) - over budget, stopping turn.\n`,
          )
          // F-18: abort dengan identitas kind budget_exceeded (bukan Error
          // polos) agar kernel melaporkannya sebagai budget_exceeded, bukan
          // "aborted" generik yang tak terbedakan dari Ctrl+C user.
          ctl.abort(
            st === "max-turns" && effectiveMaxTurns !== undefined
              ? maxTurnsExceededError(effectiveMaxTurns, session.state.turnCount)
              : budgetExceededError(),
          )
        },
      })
      const stopContextGuard = session.events.on("provider:extension", (event) => {
        if (event.kind !== "context-window-limit") return
        const data = event.data as
          | {
              inputTokens?: unknown
              outputTokens?: unknown
              windowTokens?: unknown
              factor?: unknown
              localInputTokens?: unknown
              storeMessages?: unknown
            }
          | undefined
        const input = typeof data?.inputTokens === "number" ? data.inputTokens : 0
        const output = typeof data?.outputTokens === "number" ? data.outputTokens : 0
        const windowTokens =
          typeof data?.windowTokens === "number" && data.windowTokens > 0
            ? data.windowTokens
            : getContextWindowTokens()
        const usedTokens = input + output
        // Diagnostik inflasi kalibrasi: factor > 1 & localInput kecil = cutoff
        // palsu. Bila factor besar dan localInput ≈ usage nyata (footer),
        // biang-nya kalibrasi, bukan konteks yang benar-benar penuh.
        const localInput =
          typeof data?.localInputTokens === "number" ? Math.round(data.localInputTokens) : null
        const factor = typeof data?.factor === "number" ? Math.round(data.factor * 100) / 100 : null
        const storeMessages = typeof data?.storeMessages === "number" ? data.storeMessages : null
        const diag =
          localInput !== null || factor !== null || storeMessages !== null
            ? ` (factor=${factor ?? "?"}, localInput=${localInput ?? "?"}, messages=${storeMessages ?? "?"})`
            : ""
        presentation?.noteContextCutoff({
          reason: `context guard stopped request: input ${input} + output ${output} (window ${windowTokens})${diag}`,
          usedTokens,
          windowTokens,
          turnId: session.state.turnCount,
        })
        process.stderr.write(
          `[context] request stopped at context budget: input ${input} + output ${output} (window ${windowTokens})${diag}.\n`,
        )
      })
      try {
        try {
          // [P1 M15] SATU jalur eksekusi turn. Mode `off`/`constructed`:
          // `session.run` dipanggil apa adanya (perilaku sebelum M15, nol
          // overhead). Mode `owned`: lebih dulu admission M13 → Kernel, lalu
          // `session.run` yang SAMA dieksekusi di dalam eksekusi itu dan
          // didaftarkan ke `track()` (drain M14 menutup turn yang masih jalan).
          // Tidak pernah dua kali: legacy run tetap SATU-SATUNYA eksekusi fisik.
          await executionRunner.run(
            {
              kind: "turn",
              schedulerSource: "cli-session",
              authorityHeld: true,
              ownerId: sessionId,
              provenance: { requestedBy: "user", reason: "prompt" },
            },
            () =>
              (
                session.run as (
                  input: string,
                  opts?: {
                    signal?: AbortSignal
                    model?: string
                    recoveryLedger?: RecoveryLedger
                  },
                ) => Promise<unknown>
              )(prompt, {
                model: modelRef.current,
                signal: ctl.signal,
                ...(recoveryLedger ? { recoveryLedger } : {}),
              }),
            { signal: ctl.signal },
          )
        } catch (e) {
          // Kernel diam pada gagal/abort/timeout (turn:completed hanya sukses):
          // adaptor merekonstruksi turn.failed/cancelled dari sini. Error asli
          // selalu dilempar ulang — observability tak menutupi kegagalan.
          try {
            presentation?.noteRunSettled(e, {
              aborted: ctl.signal.aborted,
              parentAborted: s?.aborted === true,
            })
          } catch {
            // Diagnostik adaptor tak boleh menutupi error turn.
          }
          throw e
        }
      } finally {
        stopWatch()
        stopContextGuard()
        if (s) s.removeEventListener("abort", onParentAbort)
        turnStatus?.endTurn()
      }
    }
    const liveWm = workModeControl?.getWorkMode() ?? effectiveWorkMode
    const livePm = permissions?.getMode() ?? permissionMode
    const verifyRunnableNow =
      verifyActive && liveWm === "EXECUTE" && livePm !== "readonly" && livePm !== "plan"
    if (!verifyRunnableNow) {
      // P0.2 (Q4 / Invariant #8): bila operator menurunkan WorkMode ke DISCUSS
      // (atau PM ke readonly/plan) di tengah sesi TUI, lewati baseline
      // shell verify, self-heal, dan auto-memory write secara otomatis.
      if (verifyActive && !verifySkippedNotice) {
        verifySkippedNotice = true
        const modeLabel = liveWm !== "EXECUTE" ? `work-mode ${liveWm}` : `${livePm} mode`
        warnLine(`verify skipped in ${modeLabel} (read-only contract)`)
      }
      await runHooksGated("pre", { phase: "pre", prompt: p, cwd }, signal)
      await runOnce(p, signal)
      await runHooksGated(
        "post",
        { phase: "post", prompt: p, cwd, result: session.state.turnCount },
        signal,
      )
      return
    }
    await runHooksGated("pre", { phase: "pre", prompt: p, cwd }, signal)
    // P2.1 — baseline-first: bila baseline sudah merah sebelum agen menyentuh
    // apa pun, tempelkan catatan agar agen memperbaiki dulu, bukan menumpuk
    // fitur di atas baseline rusak (yang hanya memperparah keadaan).
    let firstPrompt = p
    const mutationsBeforeTurn = turnMutationAttemptSeq
    const todosBeforeTurn = turnTodoWriteSeq
    const broken = await checkBaseline((s) => runVerifyWithPresentation(s ?? signal), signal)
    // Abort saat baseline jalan sudah melempar dari runVerify; cek ini untuk
    // abort yang datang tepat di sela (tanpa ini turn agen jalan padahal user
    // sudah Ctrl+C).
    signal?.throwIfAborted()
    if (broken) {
      process.stderr.write(
        c.yellow(`\n[verify] baseline failing before agent run - fixing first\n`),
      )
      firstPrompt = buildBaselineNote(broken) + p
    }
    await runWithSelfHeal(
      firstPrompt,
      {
        run: async (prompt, s) => {
          // Teruskan abort REPL ke turn perbaikan: tanpa ini Ctrl+C/Esc selama
          // fix-turn diabaikan total (hanya kernel timeout 15 mnt yang menghentikan)
          // sehingga terlihat "selesai menjawab lalu macet" saat verify merah.
          // Pakai signal dari self-heal bila ada (sudah di-race antar-siklus),
          // fallback ke signal turn luar.
          await runOnce(prompt, s ?? signal)
        },
        // Bila baseline sudah HIJAU tepat sebelum turn dan model hanya melakukan baca
        // tanpa mutasi maupun klaim todo_write (PF-01), lewati verify pasca-turn yang identik.
        // Bila baseline memang merah (P2.1), tetap jalankan self-heal sampai hijau atau cap siklus.
        shouldVerify: () =>
          Boolean(broken) ||
          turnMutationAttemptSeq > mutationsBeforeTurn ||
          turnTodoWriteSeq > todosBeforeTurn,
        verify: (s) => runVerifyWithPresentation(s ?? signal),
        onCycle: (cycle, max, v) => {
          if (cycle === max) {
            process.stderr.write(
              c.red(`\n[verify] still failing after ${max} attempts - leaving for user\n`),
            )
            process.stderr.write(`${v.output.slice(0, 1200)}\n`)
          } else {
            process.stderr.write(
              c.yellow(`\n[verify] attempt ${cycle}/${max} failed - self-healing…\n`),
            )
          }
        },
        onOk: (cycles) => {
          process.stderr.write(c.green(`\n[verify] ok after ${cycles} fix cycles\n`))
          // P13 P1 — turn yang lolos verify adalah bukti cara kerja yang valid:
          // simpan ringkasnya sebagai snippet (opt-out sama seperti summary).
          // Fire-and-forget: memori tak boleh menggagalkan run yang sudah hijau.
          if (process.env.MINICODE_AUTO_MEMORY !== "0") {
            void addMemory(buildVerifySnippet(p, verifyCommand, session.state.turnCount), {
              category: "snippet",
              cwd: cwd ?? process.cwd(),
            }).catch(() => {})
          }
        },
      },
      signal,
    )
    // PF-01: `todo_write` berjalan SEBELUM verify turn ini, jadi klaim
    // `completed` bisa sudah tersimpan ketika verify berubah merah (baseline
    // hijau tidak menutup celah ini - hanya baseline merah yang menutupnya).
    // Rekonsiliasi harus terjadi SETELAH self-heal selesai, di luar `runOnce`,
    // supaya verdict final itulah yang membentuk state durable.
    if (verifyActive && lastVerify && !lastVerify.ok) {
      // `reconcileCompletionEvidence` sudah best-effort + menulis diagnostik
      // sendiri, jadi pemanggil tak perlu try/catch (dan tak perlu menambah
      // writer di file ini — pagu OAP-008).
      const reconciled = await reconcileCompletionEvidence(
        sessionId,
        cwd ?? ".",
        {
          verdict: "failed",
          detail: `last verification failed (${lastVerify.command}): ${lastVerify.output.slice(0, 200)}`,
        },
        { syncTaskStore: true },
      )
      if (reconciled) {
        presentation?.notePlanReconciled({
          todos: reconciled,
          sessionId: sessionId,
          turnId: session.state.turnCount,
        })
      }
    }
    await runHooksGated(
      "post",
      { phase: "post", prompt: p, cwd, result: session.state.turnCount },
      signal,
    )
  }

  // Printer linier + status turn: dipasang SEGAR tiap turn dan dilepas saat
  // settle (sukses/gagal/abort/timeout). Cacat yang ditutup: kernel me-race
  // turn melawan timeout/abort — provider/tool non-kooperatif bisa settle
  // SETELAH run() ditolak, dan event telatnya tetap mengalir ke bus sesi
  // bersama. Tanpa pagar ini teks telat tercetak di sesi prompt berikutnya
  // ("macet"). Dengan detach, turn yatim tak punya subscriber → hening total
  // (turnStore-nya memang dibuang kernel; kini outputnya juga).
  let detachSimple: (() => void) | null = null
  let turnStatus: { detach(): void; endTurn(): void } | null = null
  const { attachTurnStatus } = await import("../src/ui/assistant/turn-status.ts")
  const { formatUsd } = await import("../src/ui/render/money.ts")
  // Dump diagnosis event bus (MINICODE_DEBUG_BUS=1): sekali per sesi agar
  // event yatim pun terlihat; tanpa env = tanpa subscribe (zero-cost).
  const { attachBusDebug } = await import("../src/ui/runtime/bus-debug.ts")
  const detachBusDebug = attachBusDebug(session.events)
  const usage = createUsageCollector(session.events, effectiveInitialModel, resumeUsageSnapshot)
  // B3 — persist parsial saat turn terputus (timeout/abort/error): kernel sudah
  // commit turnStore sampai batas aman ke committed store (RAM); di sini kita
  // flush ke SQLite (durable) supaya `--resume` tak amnesia. Fire-and-forget:
  // listener bus tak boleh melempar/blocking, dan persist gagal (mis. stale
  // writer) = best-effort. Penting untuk REPL+resume lintas proses.
  // v7.41 (audit #4): kernel memancarkan `turn:interrupted` dari DALAM run(),
  // lebih dulu daripada persist eksplisit pemanggil (TUI/exec/acp/impl gagal).
  // DULU keduanya memanggil saveSession bersamaan → salah satu kalah generation
  // guard → markWriterStale PALSU pada Ctrl+C biasa. Kini SEMUA pemanggil
  // (bus hook + eksplisit) berbagi satu janji in-flight di `persistCurrent`,
  // jadi tak pernah ada dua saveSession bersamaan. Bus hook tetap dipancarkan
  // segera: entry point TANPA persist eksplisit (daemon autoRunPrompt) tetap
  // mendapat safety net. saved epoch tidak berubah antar save berurutan, jadi
  // pemanggilan ulang setelah yang pertama selesai tetap aman.
  session.events.on("turn:interrupted", () => {
    void persistCurrent(usage.get(modelRef.current)).catch(() => {})
  })
  // Statusline kaya = opt-in (default mati, shell tetap bersih). Data biaya
  // disuntik sebagai callback agar UI tak perlu impor lapisan policy.
  const richStatus = process.env.MINICODE_STATUSLINE === "rich"
  const attachUI = () => {
    detachUI()
    // Mode interaktif = TUI fullscreen memiliki layar (kontrak I3: App
    // penulis tunggal). Printer linier + spinner turn-status DITEKAN agar tak
    // mengotori alt-screen — state tetap jalan (quiet: rememberTurn untuk
    // /copy, collapsed view untuk /expand). One-shot/exec (enterRepl false)
    // tetap melukis seperti dulu.
    detachSimple = attachSimpleLogger(session.events, {
      verbose,
      quiet: enterRepl === true || machineOutput,
      getSnapshot: getPresentationSnapshot,
      onPresentationEvent,
      // [Area A · PROMPT 06] State sesi — buffer /copy & error tertunda
      // bertahan lintas re-attach per turn dan tak bocor ke sesi lain.
      uiState,
      policy: {
        describeActivity,
        matchTurn: matchTurnBySummary,
        elapsedVisible,
        verificationMark,
        provenanceMark,
      },
    })
    if (enterRepl === true) {
      turnStatus = null
      return
    }
    turnStatus = attachTurnStatus(session.events, {
      initialModel: effectiveInitialModel,
      getModel: () => modelRef.current ?? effectiveInitialModel,
      activityFor: (toolCallId: string) => {
        const activity = getPresentationSnapshot().activities.find(
          (item) => item.toolCallId === toolCallId,
        )
        if (!activity) return undefined
        return {
          name: activity.name,
          ...(activity.target ? { target: activity.target } : {}),
        }
      },
      ...(richStatus
        ? {
            getStats: () => {
              const u = usage.getSession(modelRef.current)
              return `${u.totalTokens.toLocaleString()} tok${u.cost != null ? ` · ${formatUsd(u.cost)}` : ""}`
            },
          }
        : {}),
    })
  }
  const detachUI = () => {
    try {
      detachSimple?.()
    } catch {}
    detachSimple = null
    try {
      turnStatus?.detach()
    } catch {}
    turnStatus = null
  }
  // Muat overlay harga dari cache lokal (bila user pernah `pricing sync`).
  // Tidak ada request jaringan di sini — hanya baca berkas.
  void primePricing()

  // v7.41 (audit #4): satu janji persist in-flight untuk SEMUA pemanggil.
  // `turn:interrupted` (dalam run()) dan persist eksplisit (setelah run())
  // berbagi janji yang sama bila bersamaan — mencegah dua saveSession aktif
  // yang memicu markWriterStale palsu. Turn bergantian (running gate), jadi
  // tak ada persist turn BERBEDA yang tertukar janji.
  let inFlightPersist: Promise<void> | null = null
  function persistCurrent(usageData: unknown): Promise<void> {
    if (inFlightPersist) return inFlightPersist
    const task = persistCurrentImpl(usageData)
    inFlightPersist = task
    return task.finally(() => {
      if (inFlightPersist === task) inFlightPersist = null
    })
  }
  async function persistCurrentImpl(usageData: unknown) {
    try {
      flushPresentationEvents()
      await presentationWriteTail
      // P2.2: pagar generasi di dalam txn saveSession. Basi → markWriterStale
      // (diagnostik eksplisit + flag untuk exit jujur one-shot); JANGAN
      // retry buta (akan menimpa penulis baru) dan JANGAN telan diam-diam.
      // P2.6: runId mengikat baris baru ke Run live + memajukan kursor ke
      // head DALAM txn yang sama (atomik histori+kursor).
      // P2.8 forensics: session.state.history adalah buffer KONTEKS vendor —
      // ia memuat artefak ringkasan proyeksi (context-only) yang TAK BOLEH
      // jadi histori kanonik. Bila artefak itu masih di depan buffer, buang
      // DAN susun ulang: baseline kanonik ++ ekor yang benar-benar baru.
      // (Membuang saja tak cukup: setelah prefix ditutup proyeksi, buffer bukan
      // lagi superset histori kanonik — memakainya apa adanya akan wiping
      // histori lewat jalur shrink.) Bila artefak tak ada (fallback / kernel
      // sudah mengompak), buffer dipakai apa adanya — jalur kompaksi P2.7 yang
      // sudah bersaproven (migrated_compacted=1).
      const buffer = session.state.history
      const tail = stripContextOnly(buffer, contextOnlyArtifact)
      const hasBudgetPrefixIntact =
        budgetTailPrefix !== undefined &&
        budgetTailInitialMessages !== undefined &&
        buffer.length >= budgetTailInitialMessages.length &&
        budgetTailInitialMessages.every((m, idx) => {
          const cur = buffer[idx]
          if (cur === m) return true
          const mc = cur as { role?: string; toolCallId?: string; content?: unknown }
          const orig = m as { role?: string; toolCallId?: string }
          if (
            orig?.role === "tool" &&
            mc?.role === "tool" &&
            mc.toolCallId === orig.toolCallId &&
            typeof mc.content === "string" &&
            mc.content.startsWith(MICROCOMPACT_SENTINEL_PREFIX)
          ) {
            return true
          }
          return JSON.stringify(cur) === JSON.stringify(m)
        })
      const durableHistory: readonly unknown[] =
        contextOnlyArtifact !== undefined &&
        contextCanonicalBaseline !== undefined &&
        tail.length !== buffer.length
          ? [...contextCanonicalBaseline, ...tail]
          : hasBudgetPrefixIntact
            ? [...budgetTailPrefix!, ...buffer]
            : buffer
      try {
        await saveSession(sessionId, cwd, undefined, durableHistory, usageData, {
          expectedEpoch,
          workMode: workModeControl?.getWorkMode() ?? effectiveWorkMode,
          ...(currentRunId ? { runId: currentRunId } : {}),
        })
      } catch (e) {
        // P2.7: histori menyusut/berubah (kompaksi kernel di RAM) — saveSession
        // append-only MENOLAK rewrite implisit. Rute eksplisit: terminal-mark
        // run live dulu (shrink melarang RUNNING), lalu shrinkThreadHistory
        // (provenance + invalidasi proyeksi, satu txn). Sempit: hanya error ini.
        if (e instanceof RefusedHistoryRewriteError) {
          // P3.1-retarget (I2): shrink otomatis DILARANG bila kanonik tumbuh
          // melampaui buffer — itu baris penulis lain, bukan lipatan buffer
          // sendiri. Tolak dengan jujur (flag + note, tanpa tulis, tanpa
          // retry) daripada menghancurkan baris yang tak kita kenal.
          if (e.grewBeyondBuffer) {
            markWriterStale(
              `canonical grew beyond buffer (another writer appended): refusing automatic shrink to protect their rows`,
            )
            return
          }
          markPreviousRunTerminal()
          const thread = ensureDefaultThread(sessionId, cwd, { expectedEpoch })
          shrinkThreadHistory(sessionId, thread.thread_id, durableHistory, cwd, {
            expectedEpoch,
          })
          recordTurnUsage(sessionId, usageData, cwd, { expectedEpoch })
        } else {
          throw e
        }
      }
      // Provenance ringkasan TAHAN RESTART — dicatat di SINI karena hanya titik
      // ini yang benar-benar tahu baris mana yang sintetis: `isSyntheticSummary`
      // adalah keanggotaan WeakSet (fakta proses, bukan tebakan teks), dan
      // `durableHistory[0]` adalah baris yang baru saja dipersist. Pencocokan
      // saat resume memakai teks PERSIS, sehingga pesan user asli tak pernah
      // salah didaftarkan sebagai ringkasan.
      //
      // Teks ini JUGA diteruskan ke produsen proyeksi di bawah. Kompaksi LLM
      // mengganti baris pertama store dengan ringkasan hasil model; itulah
      // satu-satunya versi yang benar-benar dibaca model. Tanpa diteruskan,
      // produsen jatuh ke fold mekanis dan setelah turn baru / ganti model
      // konteksnya jadi jauh lebih miskin — meski history_summaries menyimpan
      // teks LLM yang sama persis.
      let runtimeSummaryText: string | undefined
      try {
        const firstDurable = durableHistory[0] as Message | undefined
        if (
          firstDurable &&
          isSyntheticSummary(firstDurable) &&
          typeof firstDurable.content === "string" &&
          firstDurable.content.length > 0
        ) {
          runtimeSummaryText = firstDurable.content
          saveHistorySummary(
            sessionId,
            DEFAULT_THREAD_ID,
            firstDurable.content,
            1,
            cwd,
            firstDurable.content,
          )
        }
      } catch {}
      // P3.4 — PRODUSEN proyeksi kanonik durable (best-effort, derived, epoch-
      // fenced). Menulis HANYA `history_projections` dari state kanonik yang
      // baru dipersist; TIDAK menyentuh `messages`/head/run. Kegagalan di sini
      // tidak pernah menggagalkan persist (proyeksi boleh tetap absen/basi).
      // Bila baris pertama hasil kompaksi adalah ringkasan LLM, teksnya
      // dikirim verbatim bersama baseSeq=1 (seq kanonik tempat ringkasan itu
      // ditulis). Produsen memvalidasi marker; bila tak ada ringkasan baru,
      // ia memakai provenance ringkasan sebelumnya, lalu fallback fold mekanis.
      try {
        const produced = produceSummaryProjection(sessionId, cwd, {
          expectedEpoch,
          policy: { keepRecentTurns: keepRecentTurns && keepRecentTurns > 0 ? keepRecentTurns : 2 },
          ...(runtimeSummaryText ? { summaryText: runtimeSummaryText, baseSeq: 1 } : {}),
        })
        if (produced.produced) {
          process.stderr.write(
            `${c.dim(`[projection sid=${sessionId} base=${produced.baseSeq ?? "-"} status=produced]\n`)}`,
          )
        }
      } catch (e) {
        warnLine(`projection produce failed: ${(e as Error).message}`)
      }
      // Riwayat durable → mutasi turn ini boleh di-finalize (sweep record).
      // Gagal finalize tak menggagalkan persist (warn di dalam).
      await finalizeJournal(sessionId, cwd).catch((e) => {
        warnLine(`journal finalize failed: ${(e as Error).message}`)
      })
    } catch (e) {
      if (e instanceof StaleWriterError) {
        markWriterStale(
          `history persist refused (expected epoch ${e.expectedEpoch}, actual ${e.actualEpoch})`,
        )
        return
      }
      // Histori adalah bukti durable untuk turn ini. Error selain epoch harus
      // naik ke pemanggil agar one-shot tidak mengaku berhasil saat pesan hilang.
      throw e
    }
  }

  // [PHASE 6AB] Proyeksi operator dibuat tanpa syarat & murah (counter + array
  // kosong; tanpa I/O/store/Scheduler) agar kondisi OFF tetap menjawab "scheduler
  // aktif?" dengan OFF yang jujur, bukan lewat ketiadaan. Tak memegang referensi
  // Scheduler/store/UI — hanya diberi event & handle.
  const schedulerObservability = new SchedulerObservability()

  // ── [P1 M14] RUNTIME COMPOSITION ───────────────────────────────────────────
  //
  // [DESIGN DECISION] Satu panggilan di balik MODE default `off`, dependensi dalam
  // THUNK (bentuk sama seperti Scheduler). Alternatif "construct lalu abaikan"
  // memenuhi huruf "gated" tapi membuka handle SQLite & membangun host/kernel/
  // supervisor di setiap run.
  //
  // [DESIGN DECISION] The journal path comes from the canonical SessionId
  // (P2.1: satu sid untuk semua komponen). Tak ada lagi path ganda
  // resume-vs-acak; resume yang menempa path baru tidak mungkin terjadi
  // karena identitas diputus di resolver sebelum wiring apa pun.
  // Bila sesi resume tak punya runtime journal, jurnal dibuat fresh
  // AT THAT PATH — tak pernah di path turunan id baru.
  //
  // [P1 M15] Sengaja SEBELUM komposisi Scheduler: runner harus ada saat thunk deps
  // scheduler memintanya, dan jurnal fail-closed menggagalkan startup sebelum
  // mesin otonom dibangun.
  const runtimeCwd = cwd ?? process.cwd()
  // [P13.3] Holder fakta lapisan task. Runtime dibuat lebih dulu daripada
  // scheduler, jadi nilainya baru ada setelah schedulerconstructed — holder ini
  // dibaca lewat thunk saat fakta dibutuhkan (bukan saat runtime dibangun).
  let taskLayerFacts: TaskLayerFacts = { schedulerAttached: null, storeOpen: null }
  const productionRuntime: ProductionRuntimeHandle = await createProductionRuntime(
    runtimeGateFor(runtimeMode),
    () => ({
      sessionId: sessionId,
      workspaceCwd: runtimeCwd,
      journalPath: runtimeJournalPath(runtimeCwd, sessionId),
      taskLayerFacts: () => taskLayerFacts,
    }),
  )

  // ── [P1 M15] EXECUTION RUNNER: admission runtime untuk setiap turn ─────────
  //
  // [DESIGN DECISION] Runner hidup di composition root, bukan di dalam Session
  // atau tool. Alasannya: jalur eksekusi yang DIREMOTE harus tetap punya satu
  // pemilik (composition root), dan `session.run()` sendiri tidak boleh tahu
  // soal dispatch/journal — supaya eksekusi legacy (mode off/constructed) tetap
  // persis seperti sebelumnya M15.
  const effectiveRuntimeMode = runtimeModeFor(runtimeMode)
  const executionRunner: ProductionExecutionRunner = createProductionExecutionRunner({
    mode: effectiveRuntimeMode,
    runtime: productionRuntime.runtime(),
  })

  // [P1 M15 §19] Bukti durable dari proses sebelumnya: integritas jurnal +
  // tafsir M12 untuk eksekusi yang berakhir non-terminal. Sengaja TIDAK
  // mendispatch (M12 hanya merencanakan; authority/budget/deadline tetap
  // berlaku) — hasil startup diekspos agar operator/REPL bisa
  // memutuskan, dan supaya startup punya bukti bahwa restart tidak diam-diam
  // mengulang pekerjaan.
  const startupRecovery: StartupRecoveryReport | null = productionRuntime.runtime()
    ? inspectStartupRecovery(productionRuntime.runtime()!, { authorityHeld: false })
    : null

  // [P1 M15] Runner dipasang ke tool sub-agen HANYA saat runtime memiliki
  // eksekusi (mode owned). Mode lain: tak ada setter call sama sekali, jadi
  // jalur legacy anak benar-benar tak tersentuh (nol overhead).
  if (executionRunner.owns) setSubAgentExecutionRunner(executionRunner)

  // ── [PHASE 6U] AUTONOMOUS SCHEDULER COMPOSITION ────────────────────────────
  //
  // [DESIGN DECISION] Satu panggilan di balik boolean default false. Semua yang
  // memungkinkan eksekusi otonom (handle TaskStore, session factory, scheduler,
  // trigger, subscription pembatalan) ada DI DALAM thunk `deps`, yang tidak
  // dipanggil saat gate tertutup. Konfigurasi default tak bisa membuka DB,
  // mengalokasikan provider, berlangganan kanal hapus, atau memulai kerja otonom.
  // Gate dari `schedulerEnabled` (di-set hanya oleh cli/index.ts dari token
  // eksplisit `--enable-scheduler`).
  const productionScheduler: ProductionSchedulerHandle = await createProductionScheduler(
    schedulerGateFor(schedulerEnabled),
    async () => {
      const { TaskStore } = await import("../src/task/store.ts")
      const { AUTONOMOUS_TOOL_NAMES } = await import("../src/task/autonomous-policy.ts")
      const { AUTONOMOUS_BUILD_TOOL_NAMES } = await import("../src/task/autonomous-build-policy.ts")
      const store = new TaskStore(cwd, { authority: "SCHEDULER" })
      const autonomousCwd = cwd ?? process.cwd()
      const bootAutonomousWorkMode = workModeControl?.getWorkMode() ?? effectiveWorkMode
      const allowAutonomousBuild = autonomous === true && bootAutonomousWorkMode === "EXECUTE"
      const allowedNames = allowAutonomousBuild
        ? AUTONOMOUS_BUILD_TOOL_NAMES
        : AUTONOMOUS_TOOL_NAMES

      // [DESIGN DECISION] Objek tool ASLI, difilter ke matriks WorkMode-nya — bukan tiruan
      // baru dan bukan seluruh tool sesi.
      const autonomousTools = allowedNames
        .map((name) => sessionTools.find((t) => t.name === name))
        .filter((t): t is NonNullable<typeof t> => t !== undefined)

      // [P13.3] Retry safety DITURUNKAN dari scope tool yang benar-benar diterima
      // bridge, bukan ditegas di sini. Satu nama asing/mutasi → UNPROVEN (= HOLD,
      // bukan retry).
      const { retrySafetyForToolScope } = await import("../src/task/continuity.ts")
      const retrySafety = retrySafetyForToolScope(autonomousTools.map((t) => t.name))

      return {
        sessionId,
        cwd: autonomousCwd,
        store,
        // P2.2: token penulis milik boot ini — sesi + scheduler-nya SATU
        // penulis (satu lease). Tanpa ini keduanya saling menolak.
        authorityToken: writerToken,
        instruction: allowAutonomousBuild
          ? "Work autonomously on the assigned task inside Workspace. Implement the required changes, run tests/checks, and report verification evidence."
          : "Work autonomously on the assigned task. Report what you found.",
        model: modelRef.current,
        ...(autonomous ? { maxDrainCycles: 64 } : {}),
        ...(allowAutonomousBuild && verifyActive
          ? {
              verifier: async (work) => {
                const res = await runVerify(verifyCommand, work.cwd)
                return {
                  ok: res.ok,
                  verdict: res.ok ? ("passed" as const) : ("failed" as const),
                  summary: `${res.command} exited ${res.exitCode}`,
                  requeueOnFail: !res.ok,
                }
              },
            }
          : {}),
        adapter: {
          store,
          tools: autonomousTools,
          provider: router,
          model: modelRef.current,
          cwdFor: () => autonomousCwd,
          ...(allowAutonomousBuild
            ? {
                workMode: "EXECUTE" as const,
                idleTimeoutMs: effectiveTimeoutMs === 0 ? Infinity : effectiveTimeoutMs,
                restrictBash,
                ...(cfg.bashAllowlist ? { bashAllowlist: cfg.bashAllowlist } : {}),
              }
            : {}),
          // [P1 M15] Turn otonom melewati admission runtime yang sama dengan turn
          // user: M13 → Kernel, lalu eksekusi fisiknya (child session) di dalam
          // execution itu. `undefined` pada mode selain `owned` = jalur lama.
          ...(executionRunner.owns ? { executionRunner } : {}),
          // [PHASE 6U] The autonomous child session is a REAL MiniCode session
          // over the REAL provider chain — the same `router` the user session
          // uses — so autonomous work does not run a different model or a weaker
          // tool stack than the interactive session.
          sessionFactory: async (spec: AutonomousSessionSpec) => {
            const childProvider = spec.provider as {
              contextWindowTokensForModel?: (model?: string) => number
              contextModelIdentity?: (model?: string) => string | undefined
            }
            const contextWindowTokensForModel = childProvider.contextWindowTokensForModel
            const getContextModel = () =>
              childProvider.contextModelIdentity?.(spec.model) ?? spec.model
            const child = await createMinicodeSession({
              provider: spec.provider as never,
              tools: spec.tools as never,
              hiddenWireTools,
              cwd: spec.cwd,
              systemExtra: spec.systemExtra,
              model: spec.model,
              compaction: createChildCompaction({
                provider: spec.provider,
                model: spec.model,
                cwd: spec.cwd,
                contextWindowTokensForModel,
                getContextModel,
              }),
              ...(contextWindowTokensForModel
                ? {
                    contextWindowTokens: contextWindowTokensForModel(spec.model),
                    contextWindowTokensForModel,
                    getContextModel,
                  }
                : {}),
              // [PHASE 6U] The child conversation id is NOT a kernel config field.
              timeoutMs: spec.timeoutMs,
              ...(spec.idleTimeoutMs !== undefined ? { idleTimeoutMs: spec.idleTimeoutMs } : {}),
              permissionHandler: spec.permissionHandler as never,
              permissionMode: spec.permissionMode,
            })
            // P3.5 (N2) — jembatan kompaksi otonom. Sesi anak ini TANPA
            // presentation adapter (berbeda dari anak delegate_task yang dipasangi
            // adapter + flush di cli/index.ts); tanpa jembatan ini, event
            // `context:compacted` kernel tetap in-memory sehingga marker durable
            // tak pernah ditulis dan revision undercount. Jembatan best-effort
            // via primitif durable yang SUDAH ADA (idempoten, tanpa pagar epoch
            // — sama seperti flush anak yang tak memegang epoch). Langganan
            // terikat umur sesi anak itu sendiri (tak ada store kedua).
            attachHeadlessCompactionBridge({
              sessionId: spec.sessionId,
              cwd: spec.cwd,
              events: child.events,
            })
            return child
          },
        },
        // [PHASE 6U] The binding is read from DURABLE state at dispatch time. The
        // claim was accepted microseconds ago, so the store's current generation IS
        // this claim's generation — and reading it durably means a binding can
        // never be a guess about in-memory state.
        bindingFor: (taskId: string) => ({
          parentSessionId: sessionId,
          taskId,
          execGeneration: store.getExecutionLineage(sessionId, taskId)?.execGeneration ?? 0,
          sessionIncarnation: store.getSessionIncarnation(sessionId),
        }),
        // [P13.3] Satu sumber bukti kontinuitas otomatis: runtime kanonik + admission
        // `background`, keterbacaan TaskStore/journal, dan scope tool read-only di atas.
        // Ketiadaan marker BUKAN bukti aman; eksekusi lama tak di-redispatch — reconcile
        // sukses menghasilkan claim BARU (exec_generation baru) & turn otonom baru.
        continuity: {
          evidence: ({ authorityHeld, incarnationMatches, ownsSession }) => {
            try {
              const view = deriveRuntimeView(observeProductionRuntime(productionRuntime))
              let storageUsable = false
              try {
                // Store readability is a real probe, not "the handle exists".
                store.getSnapshot(sessionId)
                const journal = productionRuntime.runtime()?.journal ?? null
                storageUsable = journal === null || journal.integrityCheck().mismatched.length === 0
              } catch {
                storageUsable = false
              }
              const resume = evaluateResume({
                // `ALLOW` already implies ACTIVE + NONE + COMPLETE + capabilities;
                // evidenceState is repeated so the intent survives future edits.
                runtimeStateCurrent:
                  view.admission === "ALLOW" && view.evidenceState === "COMPLETE",
                storageUsable,
                leaseValid: authorityHeld,
                authorityCurrent: authorityHeld && ownsSession && incarnationMatches,
              })
              return {
                resume: resume.resume,
                missing: resume.missing,
                // Re-evaluated at reconcile time, before any dispatch. A fresh
                // admission is repeated by the execution runner before the turn.
                admission: admitTaskWork(view, "background").admission,
                retrySafety,
              }
            } catch {
              // Evidence unavailable is evidence MISSING, never permission.
              return {
                resume: false,
                missing: ["continuity-evidence-error"],
                admission: "REFUSE" as const,
                retrySafety: "UNPROVEN" as const,
              }
            }
          },
        },
        // [PHASE 6AB] The sinks 6AA proved nobody passed. Both events were already
        // produced by 6U/6T's constructors; wiring them here is the entire
        // observability fix. They live INSIDE the `deps` thunk, so with the gate
        // shut they are never even constructed.
        onSchedulerEvent: (e) => schedulerObservability.noteSchedulerEvent(e),
        onTriggerEvent: (e) => schedulerObservability.noteTriggerEvent(e),
      }
    },
  )

  // ── [P13.1] SEAM STATUS RUNTIME ───────────────────────────────────────────
  //
  // [DESIGN DECISION] Composition root memasang SATU penyedia status runtime;
  // CLI (`minicode stats`, nanti footer TUI) dan daemon membacanya lewat simbol
  // yang sama. Tanpa seam ini tiap konsumen menghitung statusnya sendiri →
  // N sumber status, dan itu kelas bug yang repo ini kejar sejak awal.
  //
  // Yang dipasang HANYA fakta nyata: gate/constructed/closed dari handle
  // runtime; scheduler/store dari handle scheduler (lapisan task). Status
  // supervisi TIDAK lagi diisi manual — dibaca dari komposisi (P13.2). Tak ada
  // tebakan: yang tak diketahui dilaporkan `null` → fail-closed.
  //
  // [P13.3] Fakta lapisan task untuk gerbang admission. Runtime dibuat SEBELUM
  // scheduler, jadi nilainya baru diketahui setelah scheduler ada — karena itu
  // facts disimpan di holder dan dibaca lewat thunk (nilai basi akan menyesatkan
  // gerbang admission dengan alasan yang tak pernah benar).
  const schedulerAttached: boolean | null = productionScheduler.constructed
    ? true
    : productionScheduler.enabled
      ? false
      : null
  const storeOpen: boolean | null = productionScheduler.constructed
    ? true
    : productionScheduler.enabled
      ? false
      : null
  taskLayerFacts = { schedulerAttached, storeOpen }
  installRuntimeStatusProvider(() =>
    deriveRuntimeView(
      // Satu sumber fakta: komposisi. Fakta lapisan task diambil dari thunk
      // yang sama dengan yang dipakai gerbang admission.
      observeProductionRuntime(productionRuntime),
    ),
  )

  // [P13.2] Registrar proses pertama: server LSP milik runtime ini. Satu
  // jalur ownership proses — runtime yang memegang daftarnya, dan shutdown
  // runtime MENUNGGU anak berhenti (tak ada child yang terlepas).
  setLspProcessSupervisor(productionRuntime.runtime()?.supervision ?? null)

  // ── [P1 M14] RUNTIME COMPOSITION ─────────────────────────────────────────────
  //
  // [DESIGN DECISION] One call, behind one boolean that defaults to false, with
  // its dependencies in a THUNK — the same shape as the Scheduler above, on
  // purpose. The alternative ("just construct it here and ignore it") satisfies
  // the letter of "gated" while opening a SQLite handle and constructing a host,
  // a kernel and a supervisor on every single run.
  //
  // [DESIGN DECISION] The journal path comes from the canonical SessionId
  // (P2.1), not from volatile id. A resume that minted a fresh path would silently start
  // from an empty history while looking exactly like a successful resume; this is
  // the class of bug `--resume` exists to prevent. If the resumed session has no
  // runtime journal at all, the journal is created fresh AT THAT PATH — never at a
  // new path derived from the new session id, which would strand the old history
  // and invent a second file for one resume.
  async function close(): Promise<void> {
    // [PHASE 6U] SHUTDOWN ORDERING. Stop autonomous work FIRST, before the
    // presentation layer is detached and before background jobs are killed.
    //
    // [DESIGN DECISION] The scheduler goes first because it is the only thing
    // here that can still start new work. Detaching UI first would leave a live
    // autonomous turn running with nothing to report to, and killing background
    // jobs first would race an autonomous turn that might legitimately use one.
    //
    // Idempotent and inert when the gate is off, so this line costs nothing in
    // the default configuration.
    try {
      await productionScheduler.stop("shutdown")
      // [PHASE 6AB] `Scheduler.stop()` releases authority without emitting a
      // `cycle:stopped`, so the projection is told explicitly. Otherwise the last
      // activity line an operator sees after exit would describe work rather than
      // the shutdown that ended it.
      if (productionScheduler.constructed) schedulerObservability.noteStopped("shutdown")
    } catch {
      // Teardown must not fail because a scheduler could not stop. Durable
      // recovery remains authoritative for anything still in flight.
    }
    // [P1 M14] Runtime goes SECOND: after autonomous work has stopped (so nothing
    // new can be admitted) but before the UI is detached and background jobs are
    // killed (so a live kernel transition still has a journal to land in). Its
    // own close order is: admission latch → host drain → execution/event drain →
    // journal flush → journal close → host close.
    //
    // Inert when the gate is off, so this line costs nothing by default.
    //
    // [DESIGN DECISION] NO extra stderr writer for an incomplete shutdown. The
    // writer inventory (OAP-008) exists so writer count in this file only goes
    // DOWN, and every other teardown path here is deliberately silent; the truth
    // is not lost either — `productionRuntime.shutdownResult()` carries the
    // structured per-phase result (including a non-confirmed durability verdict)
    // for tests and diagnostics, which is where a teardown warning would end up
    // anyway. Silent teardown + inspectable result beats a new writer slot.
    // [P1 M15] Lepas DI sub-agen saat teardown: proses boleh punya beberapa sesi
    // dalam masa pakainya (test/embed), dan runner milik sesi yang sudah tutup
    // tak boleh menerima turn baru.
    if (executionRunner.owns) setSubAgentExecutionRunner(undefined)
    // [P13.1] Lepas seam status runtime: setelah runtime berhenti, penyedia yang
    // menunjuk handle tertutup tak boleh presenting status basi.
    installRuntimeStatusProvider(null)
    // [P13.2] Lepas registrar proses: tak ada runtime aktif ⇒ tak ada pemilik
    // proses anak yang boleh diklaim.
    setLspProcessSupervisor(null)
    try {
      await productionRuntime.stop()
    } catch {
      // Same rule as the scheduler: teardown never fails on a runtime that could
      // not close. Whatever is unrecorded stays recoverable from the journal.
    }
    // [Stage 5B] Drain checkpoint. POSISI: SESUDAH runtime stop (event
    // `turn:completed` sudah di-emit saat event-drain runtime, jadi operasi
    // checkpoint yang dimulai SUDAH tercatat) dan SEBELUM presentation
    // di-detach (note checkpoint masih bisa sampai ke layar). Listener
    // checkpoint dilepas di dalam drain → tak ada operasi baru yang lahir
    // setelah titik ini. close() jadi barrier: setelah kembali, tak ada
    // pekerjaan checkpoint milik lifecycle ini yang masih berjalan.
    try {
      await drainCheckpointWork()
    } catch {
      // Drain tak boleh menggagalkan teardown; kegagalan checkpoint sudah
      // dicatat (checkpointFailureNotes + warn stderr) saat operasi ditolak.
    }
    flushPresentationEvents()
    await presentationWriteTail
    detachUI()
    detachBusDebug()
    try {
      shadowUnsub?.()
    } catch {}
    shadowUnsub = null
    presentationSubscribers.clear()
    domainEventSubscribers.clear()
    shadowState = null
    shadowDiag = null
    contentStore = null
    try {
      presentation?.dispose()
    } catch {}
    presentation = null
    setAskApprovalHook(undefined)
    // P2.3: lepas sink transisi task milik sesi ini (single-session).
    setTaskTransitionSink(null)
    // background job harus mati bersama CLI — jangan tinggalkan proses yatim
    killAllBackgroundJobs()
    await mcpCloseAll()
    await lspCloseAll()
    // P2.2 — lepas pagar penulis TERAKHIR (setelah scheduler berhenti, agar
    // token bersama tak dilepas sebelum stop-nya selesai; token-guarded jadi
    // urutan tak kritis). Best-effort + diam (kontrak teardown OAP-008).
    // P2.6 — tutup Run live dari outcome terakhir (shutdown bersih =
    // INTERRUPTED/FAILED/COMPLETED eksplisit, BUKAN residu RUNNING untuk
    // kuburan resume). Best-effort + warn (bukan throw teardown).
    try {
      if (currentRunId !== null && lastTurnOutcome !== null) {
        const runId = currentRunId
        const outcome = lastTurnOutcome
        currentRunId = null
        lastTurnOutcome = null
        if (outcome === "completed") completeRun(runId, cwd, { expectedEpoch })
        else if (outcome === "interrupted") interruptRun(runId, cwd, { expectedEpoch })
        else failRun(runId, cwd, { expectedEpoch })
      } else if (currentRunId !== null) {
        const runId = currentRunId
        currentRunId = null
        lastTurnOutcome = null
        interruptRun(runId, cwd, { expectedEpoch })
      }
      // P2.9 — parent terminal ⇒ anak tak boleh tetap RUNNING. Sweep yang sama
      // dengan orphan (INTERRUPTED + UNKNOWN): kita tak boleh mengklaim anak
      // selesai, dan tak boleh meninggalkan eksekusi durable tanpa pelacak.
      terminalizeChildRuns(sessionId, cwd, { expectedEpoch })
    } catch (e) {
      warnLine(`run terminal mark failed: ${(e as Error).message}`)
    }
    // v7.40: jangan biarkan safety-net `exit` menumpuk pada host yang
    // membangun banyak sesi; ditutupnya sesi ini sudah melepas lease di bawah.
    process.off("exit", cleanupWriterOnStartupFailure)
    writerClosed = true
    stopWriterRenewTimer()
    releaseSessionWriter(sessionId, writerToken, cwd)
    releaseDbScope()
    // SATU-SATUNYA pause() mid-process yang tersisa: teardown sesi. stdin
    // TTY kini mengalir seumur proses (tanpa pause per prompt) agar siklus
    // pause→resume tak membunuh 'data' di Bun Windows; tanpa pause di sini
    // event-loop tak pernah kering dan one-shot/exec tak pernah exit.
    try {
      process.stdin.setRawMode(false)
    } catch {}
    try {
      process.stdin.pause()
    } catch {}
  }

  // v7.40 (re-audit): titik tepat di mana startup dinyatakan SELESAI — semua
  // startupPhase sudah lewat dan context siap dikembalikan. Sejak ini safety-net
  // `exit` jadi no-op: crash tanpa close() mengorphankan lease (6AD S7), bukan
  // melepasnya. Galat sebelum titik ini sudah ditangani catch startupPhase.
  startupSucceeded = true

  return {
    session,
    cfg,
    cwd,
    sessionId,
    bootId,
    // P2.2: pagar penulis — observability tanpa token (token tak pernah keluar).
    get writerEpoch() {
      return expectedEpoch
    },
    isWriterStale: () => writerStale,
    writerStaleNote: () => writerStaleNote,
    // [Stage 5B] Bukti kegagalan checkpoint: tercatat (bukan unhandled
    // rejection, bukan sukses palsu). Pesan error internal saja — tak ada
    // credential di jalur ini.
    checkpointFailures: () => checkpointFailureNotes.slice(),
    // Operasi checkpoint yang masih berjalan. Setelah `close()` selesai
    // HARUS 0 — close() jadi barrier lifecycle.
    pendingCheckpointCount: () => pendingCheckpointWork.size,
    modelRef,
    effectiveInitialModel,
    effectiveTimeoutMs,
    ...(effectiveWallTimeoutMs !== undefined ? { effectiveWallTimeoutMs } : {}),
    ...(autonomous ? { autonomous: true } : {}),
    ...(maxEpochs !== undefined ? { maxEpochs } : {}),
    ...(maxCostHour !== undefined ? { maxCostHour } : {}),
    permissionMode,
    get workMode() {
      return workModeControl?.getWorkMode() ?? effectiveWorkMode
    },
    workModeControl,
    allowLocalConfig: allowLocalConfig === true,
    sessionTools,
    allLoadedSkills,
    usage,
    budget,
    budgetStrict,
    get contextWindowTokens() {
      return getReportedContextWindowTokens()
    },
    getContextWindowTokens: () => getContextWindowTokens(),
    memoryHits,
    detachSimple: () => detachUI(),
    // [Area A · PROMPT 06] State UI sesi ini (lihat interface CliSession).
    uiState,
    persistCurrent,
    runPromptWithVerify,
    runState: () => {
      if (currentRunId === null) return lastTerminalRun ?? { runId: null, status: null }
      return {
        runId: currentRunId,
        status:
          lastTurnOutcome === "completed"
            ? "COMPLETED"
            : lastTurnOutcome === "failed"
              ? "FAILED"
              : lastTurnOutcome === "interrupted"
                ? "INTERRUPTED"
                : "RUNNING",
      }
    },
    // P11.1 — baca TERAKHIR-menang: self-heal menimpa lastVerify tiap
    // siklus, jadi yang terbaca di sini selalu hasil final. Salin nilai
    // (bukan referensi) agar summary mesin tak bisa memutasi state sesi.
    getLastVerifyResult: () =>
      lastVerify ? { ok: lastVerify.ok, command: lastVerify.command } : null,
    // P3.5 — carrier metadata runtime (satu sesi, tanpa registry).
    runtimeContextMetadata,
    permissions,
    close,
    // [PHASE 6AB] The two objects the operator control surface needs. Exposed on
    // the session, not through a registry: whoever holds a CliSession can operate
    // the Scheduler of exactly that session and no other.
    productionScheduler,
    schedulerObservability,
    adoption,
    startupNotices: deferStartup ? startupNotices : undefined,
    // [P1 M14] Same rule as the Scheduler handle above: one session owns one
    // runtime, reachable only through the session, never through a registry.
    productionRuntime,
    /** [P1 M15] Mode runtime yang benar-benar dipakai sesi ini. */
    runtimeMode: effectiveRuntimeMode,
    /** [P1 M15] Admission runtime untuk turn sesi ini (mode off = pass-through). */
    executionRunner,
    /** [P1 M15] Laporan bukti durable saat start (integritas + tafsir M12). */
    startupRecovery,
    /** Counter reducer presentasi (divergensi harus 0). */
    getShadowDiagnostics,
    getPresentationSnapshot,
    onPresentationEvent,
    onDomainEvent,
    expandAllContent: (): ContentEntry[] => contentStore?.expandAll() ?? [],
    /** Query content store untuk /expand [id] (buka-ulang identik). */
    expandContent: (toolCallId: string): ContentEntry[] => {
      if (!contentStore) return []
      // Durable fallback: sqlite tool result full (hanya output; reasoning
      // di luar retensi = penanda). Best-effort — miss = tanpa konten.
      const durable = (id: string): string | undefined => {
        try {
          const sess = loadSession(sessionId, cwd)
          if (!sess) return undefined
          for (const m of sess.messages as {
            role?: string
            toolCallId?: string
            content?: unknown
          }[]) {
            if (m.role === "tool" && m.toolCallId === id) {
              return typeof m.content === "string"
                ? m.content
                : m.content != null
                  ? JSON.stringify(m.content)
                  : undefined
            }
          }
        } catch {}
        return undefined
      }
      return contentStore.expand(toolCallId, durable)
    },
  }
}
