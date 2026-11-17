import { scrubSecrets } from "../../policy/scrub.ts"
import type { CompletionEvidence } from "../../tools/todo.ts"
import type {
  Task,
  TaskAcceptance,
  TaskEvidence,
  TaskProvenance,
  TaskStatus,
  TaskVerification,
} from "../model.ts"

export const TASK_DB_FILENAME = "tasks.db"
export const MAX_DEPENDS_ON = 32
export const MAX_EVIDENCE = 32
export const TASK_DATA_VERSION = 1

export type TaskTransitionKind = "created" | "updated" | "claimed"

export interface TaskTransition {
  kind: TaskTransitionKind
  task: Task
  previousStatus: TaskStatus | null
}

let taskTransitionSink: ((transition: TaskTransition) => void) | null = null

export function setTaskTransitionSink(sink: ((transition: TaskTransition) => void) | null): void {
  taskTransitionSink = sink
}

/** Emit SETELAH commit; kegagalan observer tak boleh menggagalkan transisi. */
export function emitTaskTransition(
  kind: TaskTransitionKind,
  task: Task,
  previousStatus: TaskStatus | null,
): void {
  try {
    taskTransitionSink?.({ kind, task, previousStatus })
  } catch {}
}

export interface TaskRow {
  session_id: string
  task_id: string
  title: string
  status: string
  task_order: number
  parent_id: string | null
  depends_on_json: string | null
  blocked_reason: string | null
  verification_json: string | null
  evidence_json: string | null
  acceptance_json: string | null
  provenance_json: string | null
  created_at: string
  updated_at: string
  revision: number
  exec_generation: number
  attempt_generation: number | null
  execution_owner: string | null
}

export interface ExecutionLineage {
  readonly execGeneration: number
  readonly attemptGeneration: number | null
}

export type ExecutionOwner = "scheduler"

export interface ExecutionOwnership {
  readonly executionOwner: ExecutionOwner | null
}

export type AttemptRecordOutcome = "RECORDED" | "TASK_GONE" | "SUPERSEDED" | "SESSION_SUPERSEDED"

export type LineageReconcileOutcome =
  | "RECONCILED"
  | "NOT_STRANDED"
  | "REJECTED_STALE"
  | "NOT_FOUND"
  | "REFUSED_NO_OWNERSHIP"

export const ADOPTABLE_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "VERIFYING",
  "BLOCKED",
  "FAILED",
  "RETRYING",
]

export const ADOPTABLE_STATUS_SET: ReadonlySet<TaskStatus> = new Set(ADOPTABLE_STATUSES)
export const CLAIMABLE_STATUSES: readonly TaskStatus[] = ["PENDING"]

export function sqlList(statuses: readonly TaskStatus[]): string {
  return statuses.map((s) => `'${s}'`).join(", ")
}

export interface TaskTransfer {
  readonly transferId: string
  readonly taskId: string
  readonly fromSessionId: string
  readonly fromIncarnation: number
  readonly toSessionId: string
  readonly toIncarnation: number
  readonly expectedRevision: number
  readonly newRevision: number
  readonly status: string
  readonly execGeneration: number
  readonly attemptGeneration: number | null
  readonly executionOwner: ExecutionOwner | null
  readonly transferredAt: string
}

export interface TaskTransferRequest {
  readonly taskId: string
  readonly fromSessionId: string
  readonly fromIncarnation: number
  readonly toSessionId: string
  readonly toIncarnation: number
  readonly expectedRevision: number
  readonly sourceOwnerToken: string
  readonly targetOwnerToken: string
  readonly now?: number
}

export type TaskTransferOutcome =
  | "TRANSFERRED"
  | "NOT_FOUND"
  | "REFUSED_SELF_TRANSFER"
  | "REJECTED_STALE_SOURCE_INCARNATION"
  | "REJECTED_STALE_TARGET_INCARNATION"
  | "REJECTED_STALE_REVISION"
  | "REFUSED_NO_SOURCE_AUTHORITY"
  | "REFUSED_NO_TARGET_AUTHORITY"
  | "REFUSED_STATUS"
  | "REFUSED_TARGET_ID_CONFLICT"
  | "REFUSED_UNRESOLVED_RELATION"
  | "REFUSED_CORRUPT_STATE"

export interface TaskTransferResult {
  readonly outcome: TaskTransferOutcome
  readonly task: Task | null
  readonly transfer: TaskTransfer | null
  readonly detail: string
  readonly unresolvedRelations: readonly string[]
}

export interface UnfinishedWorkItem {
  readonly sessionId: string
  readonly sessionIncarnation: number
  readonly task: Task
  readonly execGeneration: number
  readonly attemptGeneration: number | null
  readonly executionOwner: ExecutionOwner | null
  readonly transferredFromSessionId: string | null
  readonly transferredAt: string | null
}

export interface TaskMerge {
  readonly mergeId: string
  readonly sessionId: string
  readonly survivorId: string
  readonly duplicateId: string
  readonly evidence: string
  readonly survivorStatus: string
  readonly duplicateStatus: string
  readonly duplicateRevision: number
  readonly mergedAt: string
}

export interface TaskDuplicateRequest {
  readonly sessionId: string
  readonly survivorId: string
  readonly duplicateId: string
  readonly evidence: string
  readonly expectedRevision?: number
}

export type TaskDuplicateOutcome =
  | "DECLARED"
  | "NOT_FOUND"
  | "REFUSED_SELF_MERGE"
  | "REFUSED_NO_EVIDENCE"
  | "REFUSED_TERMINAL_DUPLICATE"
  | "REJECTED_STALE_REVISION"

export interface TaskDuplicateResult {
  readonly outcome: TaskDuplicateOutcome
  readonly duplicate: Task | null
  readonly survivor: Task | null
  readonly merge: TaskMerge | null
  readonly detail: string
}

export interface NewTaskInput {
  title: string
  status: TaskStatus
  order: number
  parentId?: string | null
  dependsOn?: string[]
  blockedReason?: string | null
  verification?: TaskVerification | null
  evidence?: TaskEvidence[]
  acceptance?: TaskAcceptance | null
  provenance: TaskProvenance
}

export interface TaskPatch {
  title?: string
  status?: TaskStatus
  order?: number
  parentId?: string | null
  dependsOn?: string[]
  blockedReason?: string | null
  verification?: TaskVerification | null
  evidence?: TaskEvidence[]
  acceptance?: TaskAcceptance | null
}

export interface UpsertOptions {
  evidence?: CompletionEvidence
  expectedRevision?: number
}

export interface PatchOptions extends UpsertOptions {
  allowReopen?: boolean
  authorityToken?: string
}

export interface VerificationGateOutcome {
  readonly ok: boolean
  readonly verdict: "passed" | "failed" | "stale"
  readonly exitCode?: number | null
  readonly command?: string
  readonly summary?: string
  readonly integrityOk?: boolean
  readonly timestamp?: string
}

export type TaskAuthorityMode = "LEGACY" | "SCHEDULER"

export interface TaskStoreOptions {
  authority?: TaskAuthorityMode
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function buildVerificationTaskEvidence(outcome: VerificationGateOutcome): TaskEvidence {
  const at = outcome.timestamp ?? nowIso()
  const payload = {
    verdict: outcome.verdict,
    ok: outcome.ok,
    exitCode: outcome.exitCode ?? (outcome.ok ? 0 : 1),
    ...(outcome.command ? { command: scrubSecrets(outcome.command).slice(0, 200) } : {}),
    summary: scrubSecrets(
      outcome.summary ?? (outcome.ok ? "verification passed" : "verification failed"),
    ).slice(0, 500),
    ...(typeof outcome.integrityOk === "boolean" ? { integrityOk: outcome.integrityOk } : {}),
    timestamp: at,
  }
  return {
    kind: "verify",
    detail: JSON.stringify(payload),
    at,
  }
}
