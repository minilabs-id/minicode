// Composition scheduler produksi (terpisah dari `cli/setup.ts` agar pemeriksaan
// gerbang `--enable-scheduler` sebelum konstruksi mudah diverifikasi).
// Invariant utama: saat `--enable-scheduler` nonaktif, `deps()` tidak dipanggil
// sehingga handle/koneksi DB scheduler tidak dibuat.

import {
  type AutonomousAdapterConfig,
  type AutonomousExecutionBinding,
  buildAutonomousRunTurn,
} from "./autonomous-adapter.ts"
import type { ContinuityGate } from "./continuity.ts"
import { type CancelReason, Scheduler, type SchedulerEvent } from "./scheduler.ts"
import { onSessionInvalidated, releaseSessionOwnershipFor } from "./session-ownership.ts"
import type { TaskStore } from "./store.ts"
import type { TriggerEvent, TriggerResult, TriggerSource } from "./trigger.ts"
import { TriggerCoordinator } from "./trigger.ts"

/** The single enablement mechanism. Default OFF. */
export const SCHEDULER_FLAG = "--enable-scheduler"

export type SchedulerGateSource = "cli-flag" | "absent"

/**
 * [PHASE 6U][DESIGN DECISION] EXACTLY ONE gate: a CLI boolean flag.
 *
 * The alternatives were each rejected against the requirement "cannot be
 * accidentally inherited from unrelated configuration":
 *
 *  - **Environment variable.** Rejected. `process.env` is inherited by every child
 *    this runtime spawns — sub-agents (`src/tools/task.ts`), MCP servers
 *    (`src/mcp/server.ts`), LSP servers. A sub-agent that inherited the gate would
 *    build its own Scheduler for the same session, and `acquireSessionOwnership`
 *    would fail closed and leave a stopped instance holding nothing. Inheritable by
 *    construction, and the inheritance is exactly the accident the requirement
 *    forbids.
 *  - **Config file.** Rejected. `~/.minicode/config.json` is global, so enabling
 *    it once would silently enable it for every project on the machine. The
 *    repo-local `.minicode/config.json` is gated behind `--allow-local-config`, but
 *    once a user passes that flag for an unrelated reason, a repository could ship
 *    a config that turns autonomous execution on. That is unrelated configuration
 *    with a scheduling consequence.
 *  - **Runtime setting.** Rejected. Nothing reads a scheduler setting at runtime,
 *    and a mutable runtime switch could not stop a *live* turn anyway without the
 *    polling loop 6T rejected in ADR-14.
 *
 * A CLI flag is per-invocation, is not in `process.env`, is not read from any file,
 * and must be typed by whoever runs the process. It is also the only one of the
 * four that a process-boundary test can vary without a fixture.
 */
export interface SchedulerGate {
  readonly enabled: boolean
  readonly source: SchedulerGateSource
}

export const GATE_DISABLED: SchedulerGate = { enabled: false, source: "absent" }
export const GATE_ENABLED: SchedulerGate = { enabled: true, source: "cli-flag" }

/**
 * Resolve the gate from an argv array.
 *
 * Parsed here rather than in `cli/index.ts` so the rule is testable without
 * spawning a process, and so there is exactly one place that knows what enables
 * the Scheduler. Anything other than the literal flag — a config key, an env var,
 * a default — leaves it off.
 */
export function resolveSchedulerGate(argv: readonly string[]): SchedulerGate {
  // Exact token match, and nothing else. Deliberately NOT `argv.includes`-with-
  // fuzzy-matching and NOT `--enable-scheduler=false` semantics: the flag has no
  // value form, so `--enable-scheduler=anything` does not enable it.
  //
  // [PHASE 6X] The scan also STOPS at `--`, which `Array.prototype.some` did not.
  // `--` is the conventional end-of-options marker, and everything after it is the
  // user's prompt text, not flags. Without this, `minicode "explain -- --enable-scheduler"`
  // would switch autonomous execution ON from inside a quoted prompt - a fail-open
  // from a non-flag position, and strictly worse than the value-form bug it fixed.
  // `hasFlag` already behaved this way, so this preserves the pre-6X parsing shape
  // while making the flag itself strict.
  for (const token of argv) {
    if (token === "--") break
    if (token === SCHEDULER_FLAG) return GATE_ENABLED
  }
  return GATE_DISABLED
}

/**
 * [PHASE 6U] The CALL SITE's whole decision, in one testable line.
 *
 * [DESIGN DECISION] `cli/setup.ts` calls this rather than assembling argv itself.
 * Without it, the production call site was a *tested module plus an untested
 * expression*, and mutation M2 ("make it default-on") survived every test in the
 * suite — the module was covered, the wiring was not. A one-line seam that the
 * tests can reach is the difference between "the policy is correct" and "the
 * policy is correct AND the product calls it correctly".
 *
 * Anything other than literal `true` is OFF. `undefined` — the ordinary case, a
 * process that never passed the flag — is off by construction rather than by
 * defaulting.
 */
export function schedulerGateFor(enabled: boolean | undefined): SchedulerGate {
  return enabled === true ? GATE_ENABLED : GATE_DISABLED
}

/** Everything the composition root needs — but ONLY if the gate is open. */
export interface ProductionSchedulerDeps {
  readonly sessionId: string
  readonly cwd: string
  readonly store: TaskStore
  readonly instruction: string
  readonly adapter: AutonomousAdapterConfig
  /** Reads the durable binding for a task at claim time. */
  readonly bindingFor: (taskId: string) => AutonomousExecutionBinding
  readonly model?: string
  /** P2.2: token otoritas milik composition root (satu penulis per boot).
   * Diteruskan ke Scheduler agar sesi + scheduler-nya memakai lease yang
   * sama; absen = perilaku lama (Scheduler mint sendiri). */
  readonly authorityToken?: string
  /**
   * [P13.3 Stage C] Retry-safety evidence for automatic reconciliation.
   *
   * ABSENT means HOLD, not legacy recovery: the composition root must prove
   * that a fresh attempt cannot repeat unsafe external effects.
   */
  readonly continuity?: ContinuityGate
  readonly maxDrainCycles?: number
  /**
   * Verifier eksternal opsional pasca-attempt. Scheduler tetap tidak pernah menulis
   * COMPLETED; verifier di luar siklus memvalidasi output dan mentransisikan task.
   */
  readonly verifier?: (work: {
    sessionId: string
    taskId: string
    title: string
    cwd: string
  }) => Promise<{
    ok: boolean
    verdict: "passed" | "failed" | "stale"
    summary?: string
    requeueOnFail?: boolean
  }>
  readonly onSchedulerEvent?: (e: SchedulerEvent) => void
  readonly onTriggerEvent?: (e: TriggerEvent) => void
}

/**
 * The handle production code holds.
 *
 * [DESIGN DECISION] Every method is safe to call when disabled, and every one
 * reports `null`/`false` rather than throwing. A caller that forgets to check the
 * gate gets an inert object, not a crash — a missing `if` must degrade to "nothing
 * happens", never to "autonomous execution runs because the error was swallowed".
 */
export interface ProductionSchedulerHandle {
  readonly enabled: boolean
  /** [PHASE 6U] §13's headline invariant, readable by tests and operators. */
  readonly constructed: boolean
  /** True between activation and stop. */
  isActive(): boolean
  /** Request an evaluation. `null` when disabled. */
  fire(source: TriggerSource): Promise<TriggerResult | null>
  /** Cancel the live execution and release everything. Idempotent. */
  stop(reason: CancelReason): Promise<void>
  /** Session deletion notification. Idempotent, safe after stop. */
  notifySessionDeleted(): Promise<void>
  getScheduler(): Scheduler | null
  getTrigger(): TriggerCoordinator | null
}

/** Handle nonaktif: tidak menyentuh store/scheduler saat gerbang mati. */
function inertHandle(gate: SchedulerGate): ProductionSchedulerHandle {
  return {
    enabled: gate.enabled,
    constructed: false,
    isActive: () => false,
    fire: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
    notifySessionDeleted: () => Promise.resolve(),
    getScheduler: () => null,
    getTrigger: () => null,
  }
}

/**
 * Bangun scheduler produksi di belakang gerbang `--enable-scheduler`.
 * Thunk `deps` hanya dievaluasi bila gerbang aktif.
 */
export async function createProductionScheduler(
  gate: SchedulerGate,
  deps: () => ProductionSchedulerDeps | Promise<ProductionSchedulerDeps>,
): Promise<ProductionSchedulerHandle> {
  if (!gate.enabled) return inertHandle(gate)

  // ── construction ───────────────────────────────────────────────────────────
  // [DESIGN DECISION] Awaited, because a real composition root may need async
  // imports (TaskStore, the 6S matrix) before it can describe its dependencies.
  const d = await deps()

  // [DESIGN DECISION] The tool set is NOT recomputed here. It comes from the
  // caller's adapter.tools, and buildAutonomousRunTurn validates it against
  // the 6S matrix's own assertAutonomousToolScope at construction. Deriving it
  // here would create a THIRD copy of one policy, furthest from the tests that
  // justify it and therefore most likely to drift.

  let lastClaimed: { taskId: string; title: string } | null = null
  const onEvent = (e: SchedulerEvent): void => {
    try {
      if (e.kind === "task:claimed") {
        const claimedTask = d.store.getTask(d.sessionId, e.taskId)
        lastClaimed = { taskId: e.taskId, title: claimedTask?.title ?? e.taskId }
      }
      d.onSchedulerEvent?.(e)
    } finally {
      if (e.kind === "task:claimed" || e.kind === "task:recovered") {
        void import("../tools/todo.ts")
          .then(({ syncTodoViewsFromTaskStore }) => syncTodoViewsFromTaskStore(d.sessionId, d.cwd))
          .catch(() => {})
      }
    }
  }

  const scheduler = new Scheduler(d.sessionId, {
    store: d.store,
    runTurn: buildAutonomousRunTurn(d.bindingFor, d.adapter),
    instruction: d.instruction,
    ...(d.model ? { model: d.model } : {}),
    // P2.2: teruskan token komposisi (bila ada) — satu penulis per boot.
    ...(d.authorityToken ? { authorityToken: d.authorityToken } : {}),
    ...(d.continuity ? { continuity: d.continuity } : {}),
    onEvent,
  })

  let activeTriggerSource: TriggerSource = "manual"
  const runVerifiedCycle = async () => {
    lastClaimed = null
    const res = await scheduler.cycle()
    const claimedTarget = lastClaimed as { taskId: string; title: string } | null
    if (
      d.verifier &&
      res.dispatched?.ok &&
      res.dispatched.lineage === "RECORDED" &&
      claimedTarget
    ) {
      lastClaimed = null
      try {
        const cur = d.store.getTask(d.sessionId, claimedTarget.taskId)
        if (cur && cur.status === "IN_PROGRESS") {
          const patchOpts = d.authorityToken
            ? { authorityToken: d.authorityToken, expectedRevision: cur.revision }
            : { expectedRevision: cur.revision }
          const v = await d.verifier({
            sessionId: d.sessionId,
            taskId: claimedTarget.taskId,
            title: claimedTarget.title,
            cwd: d.cwd,
          })
          const done = d.store.completeTaskVerification(
            d.sessionId,
            claimedTarget.taskId,
            {
              ok: v.ok,
              verdict: v.verdict,
              ...(v.summary ? { summary: v.summary } : {}),
              timestamp: new Date().toISOString(),
            },
            patchOpts,
          )
          if (!v.ok && v.requeueOnFail && done.status === "BLOCKED") {
            d.store.patchTask(
              d.sessionId,
              claimedTarget.taskId,
              { status: "PENDING" },
              d.authorityToken
                ? { authorityToken: d.authorityToken, expectedRevision: done.revision }
                : { expectedRevision: done.revision },
            )
          }
        }
      } catch (err) {
        // Kegagalan hook verifikasi tidak boleh menghentikan loop trigger, tetapi
        // WAJIB terobservasi dan menutup celah task IN_PROGRESS tanpa sinyal.
        const msg = err instanceof Error ? err.message : String(err)
        d.onTriggerEvent?.({
          kind: "trigger:cycle_failed",
          source: activeTriggerSource,
          detail: `verifier failed for ${claimedTarget.taskId}: ${msg}`.slice(0, 200),
        })
        try {
          const curAfter = d.store.getTask(d.sessionId, claimedTarget.taskId)
          if (curAfter && curAfter.status === "IN_PROGRESS") {
            const failPatchOpts = d.authorityToken
              ? { authorityToken: d.authorityToken, expectedRevision: curAfter.revision }
              : { expectedRevision: curAfter.revision }
            d.store.completeTaskVerification(
              d.sessionId,
              claimedTarget.taskId,
              {
                ok: false,
                verdict: "failed",
                summary: `verifier hook failed: ${msg}`.slice(0, 200),
                timestamp: new Date().toISOString(),
              },
              failPatchOpts,
            )
          }
        } catch {
          // Kegagalan sekunder persistensi tetap dilaporkan via trigger:cycle_failed.
        }
      }
    }
    return res
  }

  const trigger = new TriggerCoordinator({
    runCycle: runVerifiedCycle,
    isRunning: () => scheduler.getLifecycle() === "RUNNING" || scheduler.getLifecycle() === "IDLE",
    ...(d.maxDrainCycles !== undefined ? { maxDrainCycles: d.maxDrainCycles } : {}),
    ...(d.onTriggerEvent ? { onEvent: d.onTriggerEvent } : {}),
  })

  // ── activation ─────────────────────────────────────────────────────────────
  //
  // Separate from construction, and separately observable: `constructed` is true
  // here while `isActive()` is still false until `start()` succeeds. That gap is
  // deliberate — it is where a future activation policy (a health check, a budget
  // ceiling) would sit without touching construction.
  let active = false
  scheduler.start()
  active = true

  // ── cancellation wiring ────────────────────────────────────────────────────
  //
  // [DESIGN DECISION] Reuse `session-ownership`'s existing per-session channel
  // rather than introducing a second process-local registry. That module is
  // ALREADY the process's per-session authority, it is already consulted by the
  // Scheduler, and 6Q's design refused to add a registry precisely so that
  // deletion works without one. A scheduler that holds a deletion subscription
  // under the same authority that already gates its reconciliation keeps those two
  // facts in one place.
  //
  // [DESIGN DECISION] Cancel BEFORE stop, and idempotently. A turn that is still
  // unwinding when `stop()` awaits the cycle is exactly the case where the abort
  // has to have been sent first.
  let stopping = false
  const unsubscribe = onSessionInvalidated(d.sessionId, () => {
    // Fire-and-forget: the notification must not block the deletion path, and the
    // abort itself is synchronous. `stop()` completes on its own.
    void handle.stop("session-deleted")
  })

  const handle: ProductionSchedulerHandle = {
    enabled: true,
    constructed: true,
    isActive: () => active && !stopping,
    fire: (source) => {
      if (!handle.isActive()) return Promise.resolve(null)
      activeTriggerSource = source
      return trigger.fire(source)
    },
    async stop(reason) {
      if (stopping) return
      stopping = true
      active = false
      // 1. stop accepting triggers
      trigger.dispose()
      // 2. signal the live execution
      scheduler.cancelActive(reason)
      // 3. bounded wait for the cycle to unwind, then release authority
      await trigger.awaitSettled()
      await scheduler.stop()
      // 4. release the process-local authority for this session
      unsubscribe()
      releaseSessionOwnershipFor(d.sessionId, "scheduler")
    },
    notifySessionDeleted: () => handle.stop("session-deleted"),
    getScheduler: () => scheduler,
    getTrigger: () => trigger,
  }

  return handle
}
