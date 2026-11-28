import type { WorkMode } from "./work-mode.ts"

/**
 * Orkestrator multi-epoch & circuit-breaker untuk sesi otonom jangka panjang.
 *
 * Mencegah dua kegagalan klasik sesi multi-jam/multi-hari:
 *   1. Pemborosan biaya / stagnasi tanpa ujung (hourly spend cap + no-progress breaker).
 *   2. Context rot setelah berkali-kali rollover epoch atau kompaksi (goal, milestone
 *      selesai, dan pendekatan yang pernah gagal disuntikkan ringkas di setiap epoch baru).
 */

export const AUTONOMOUS_DEFAULT_MAX_NO_PROGRESS_EPOCHS = 5
const ONE_HOUR_MS = 3_600_000
const MAX_GOAL_MEMORY_ITEMS = 15

export type AutonomousStopReason =
  | "completed"
  | "max-epochs"
  | "budget-exceeded"
  | "hourly-spend-cap"
  | "no-progress-circuit-breaker"
  | "mode-restricted"
  | "cancelled"

export interface AutonomousLoopConfig {
  readonly workMode: WorkMode
  /** Batas maksimum epoch; `undefined` / `Infinity` berarti tak dibatasi epoch selama masih ada progres. */
  readonly maxEpochs?: number
  /** Batas biaya total sesi dalam USD. */
  readonly maxCostUsd?: number
  /** Circuit breaker biaya per jam bergulir (rolling 60 menit) dalam USD. */
  readonly maxCostPerHourUsd?: number
  /** Batas epoch berturut-turut tanpa progres sebelum circuit breaker berhenti (default 5). */
  readonly maxConsecutiveNoProgress?: number
  /** Bila true, mode DISCUSS tetap diizinkan untuk riset read-only multi-epoch (tanpa mutasi). */
  readonly allowReadOnlyAutonomy?: boolean
}

export interface AutonomousEpochOutcome {
  readonly progressed: boolean
  readonly costUsd?: number
  readonly milestone?: string
  readonly failedApproach?: string
  readonly completed?: boolean
}

export interface AutonomousLoopSnapshot {
  readonly epoch: number
  readonly totalSpendUsd: number
  readonly hourlySpendUsd: number
  readonly consecutiveNoProgress: number
  readonly completedMilestones: readonly string[]
  readonly failedApproaches: readonly string[]
}

export interface AutonomousLoopController {
  canStartNextEpoch(
    nowMs?: number,
    signal?: AbortSignal,
  ):
    | { readonly allow: true; readonly nextEpoch: number }
    | {
        readonly allow: false
        readonly reason: AutonomousStopReason
        readonly message: string
      }
  recordEpoch(
    outcome: AutonomousEpochOutcome,
    nowMs?: number,
  ): {
    readonly stopped: boolean
    readonly reason?: AutonomousStopReason
    readonly message?: string
  }
  hourlySpend(nowMs?: number): number
  formatEpochPrompt(baseInstruction: string, stepNote?: string): string
  snapshot(): AutonomousLoopSnapshot
}

function pushBounded(target: string[], item: string | undefined, cap: number): void {
  const clean = item?.trim()
  if (!clean) return
  if (target[target.length - 1] === clean) return
  target.push(clean)
  if (target.length > cap) target.splice(0, target.length - cap)
}

export function createAutonomousLoopController(
  config: AutonomousLoopConfig,
): AutonomousLoopController {
  const maxEpochs =
    typeof config.maxEpochs === "number" &&
    Number.isFinite(config.maxEpochs) &&
    config.maxEpochs > 0
      ? Math.floor(config.maxEpochs)
      : Number.POSITIVE_INFINITY
  const maxCostUsd =
    typeof config.maxCostUsd === "number" &&
    Number.isFinite(config.maxCostUsd) &&
    config.maxCostUsd >= 0
      ? config.maxCostUsd
      : undefined
  const maxCostPerHourUsd =
    typeof config.maxCostPerHourUsd === "number" &&
    Number.isFinite(config.maxCostPerHourUsd) &&
    config.maxCostPerHourUsd > 0
      ? config.maxCostPerHourUsd
      : undefined
  const maxNoProgress =
    typeof config.maxConsecutiveNoProgress === "number" &&
    Number.isFinite(config.maxConsecutiveNoProgress) &&
    config.maxConsecutiveNoProgress >= 1
      ? Math.floor(config.maxConsecutiveNoProgress)
      : AUTONOMOUS_DEFAULT_MAX_NO_PROGRESS_EPOCHS

  let epoch = 0
  let totalSpendUsd = 0
  let consecutiveNoProgress = 0
  let completed = false
  const hourlySamples: Array<{ atMs: number; costUsd: number }> = []
  const completedMilestones: string[] = []
  const failedApproaches: string[] = []

  const pruneHourly = (nowMs: number): number => {
    const cutoff = nowMs - ONE_HOUR_MS
    while (hourlySamples.length > 0 && hourlySamples[0]!.atMs <= cutoff) {
      hourlySamples.shift()
    }
    let sum = 0
    for (const s of hourlySamples) sum += s.costUsd
    return sum
  }

  return {
    hourlySpend(nowMs = Date.now()) {
      return pruneHourly(nowMs)
    },
    canStartNextEpoch(nowMs = Date.now(), signal) {
      if (signal?.aborted) {
        return {
          allow: false,
          reason: "cancelled",
          message: "autonomous loop cancelled by signal",
        }
      }
      if (completed) {
        return {
          allow: false,
          reason: "completed",
          message: "autonomous goal already marked completed",
        }
      }
      // Hormati batas WorkMode: DISCUSS read-only kecuali pemanggil eksplisit mengizinkan riset read-only.
      if (config.workMode !== "EXECUTE" && !config.allowReadOnlyAutonomy) {
        return {
          allow: false,
          reason: "mode-restricted",
          message:
            "autonomous execution requires BUILD mode (--work-mode BUILD) for workspace changes and verification",
        }
      }
      if (epoch >= maxEpochs) {
        return {
          allow: false,
          reason: "max-epochs",
          message: `autonomous max epochs (${maxEpochs}) reached`,
        }
      }
      if (consecutiveNoProgress >= maxNoProgress) {
        return {
          allow: false,
          reason: "no-progress-circuit-breaker",
          message: `circuit breaker: ${consecutiveNoProgress} consecutive epochs without progress`,
        }
      }
      if (maxCostUsd !== undefined && totalSpendUsd >= maxCostUsd) {
        return {
          allow: false,
          reason: "budget-exceeded",
          message: `autonomous session cost $${totalSpendUsd.toFixed(4)} reached cap $${maxCostUsd.toFixed(4)}`,
        }
      }
      const hourSpend = pruneHourly(nowMs)
      if (maxCostPerHourUsd !== undefined && hourSpend >= maxCostPerHourUsd) {
        return {
          allow: false,
          reason: "hourly-spend-cap",
          message: `autonomous hourly spend $${hourSpend.toFixed(4)}/h reached cap $${maxCostPerHourUsd.toFixed(4)}/h`,
        }
      }
      return { allow: true, nextEpoch: epoch + 1 }
    },
    recordEpoch(outcome, nowMs = Date.now()) {
      epoch++
      const cost =
        typeof outcome.costUsd === "number" &&
        Number.isFinite(outcome.costUsd) &&
        outcome.costUsd > 0
          ? outcome.costUsd
          : 0
      if (cost > 0) {
        totalSpendUsd += cost
        hourlySamples.push({ atMs: nowMs, costUsd: cost })
      }
      if (outcome.completed) completed = true
      if (outcome.progressed) consecutiveNoProgress = 0
      else consecutiveNoProgress++
      pushBounded(completedMilestones, outcome.milestone, MAX_GOAL_MEMORY_ITEMS)
      pushBounded(failedApproaches, outcome.failedApproach, MAX_GOAL_MEMORY_ITEMS)

      if (completed) {
        return { stopped: true, reason: "completed", message: "autonomous work completed" }
      }
      if (consecutiveNoProgress >= maxNoProgress) {
        return {
          stopped: true,
          reason: "no-progress-circuit-breaker",
          message: `circuit breaker: ${consecutiveNoProgress} consecutive epochs without progress`,
        }
      }
      if (maxCostUsd !== undefined && totalSpendUsd >= maxCostUsd) {
        return {
          stopped: true,
          reason: "budget-exceeded",
          message: `autonomous session cost $${totalSpendUsd.toFixed(4)} reached cap $${maxCostUsd.toFixed(4)}`,
        }
      }
      const hourSpend = pruneHourly(nowMs)
      if (maxCostPerHourUsd !== undefined && hourSpend >= maxCostPerHourUsd) {
        return {
          stopped: true,
          reason: "hourly-spend-cap",
          message: `autonomous hourly spend $${hourSpend.toFixed(4)}/h reached cap $${maxCostPerHourUsd.toFixed(4)}/h`,
        }
      }
      if (epoch >= maxEpochs) {
        return {
          stopped: true,
          reason: "max-epochs",
          message: `autonomous max epochs (${maxEpochs}) reached`,
        }
      }
      return { stopped: false }
    },
    formatEpochPrompt(baseInstruction, stepNote) {
      const parts = [
        `[AUTONOMOUS EPOCH ${epoch + 1}${Number.isFinite(maxEpochs) ? `/${maxEpochs}` : ""}]`,
        `Goal: ${baseInstruction}`,
      ]
      if (completedMilestones.length > 0) {
        parts.push(`Completed milestones:\n- ${completedMilestones.join("\n- ")}`)
      }
      if (failedApproaches.length > 0) {
        parts.push(`Failed approaches (do not repeat blindly):\n- ${failedApproaches.join("\n- ")}`)
      }
      if (stepNote?.trim()) {
        parts.push(stepNote.trim())
      }
      parts.push(
        "Continue from current workspace and task state. Verify changes before concluding.",
      )
      return parts.join("\n\n")
    },
    snapshot() {
      const hourlySpendUsd = pruneHourly(Date.now())
      return {
        epoch,
        totalSpendUsd,
        hourlySpendUsd,
        consecutiveNoProgress,
        completedMilestones: [...completedMilestones],
        failedApproaches: [...failedApproaches],
      }
    },
  }
}
