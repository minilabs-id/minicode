import { createLlmCompaction } from "../../src/policy/compaction.ts"
import type { DomainEvent } from "../../src/presentation/events.ts"
import type { UiPresentationEvent } from "../../src/ui/contract.ts"

/** Peta exhaustive dari `DomainEvent` ke kontrak event UI lintas lapisan. */
function mapPresentationEvent(event: DomainEvent): UiPresentationEvent | null {
  switch (event.type) {
    case "user.message":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        text: event.text,
        promptRef: event.promptRef,
      }
    case "turn.started":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        promptRef: event.promptRef,
      }
    case "turn.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        summary: event.summary,
      }
    case "turn.failed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        error: event.error.message,
        cause: event.error.cause,
      }
    case "turn.cancelled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        reason: event.reason,
      }
    case "model.delta":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        delta: event.delta,
      }
    case "model.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        text: event.text,
        truncated: event.truncated,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "reasoning.delta":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        delta: event.delta,
      }
    case "reasoning.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        truncated: event.truncated,
        expandRef: event.expandRef,
      }
    case "tool.started":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        stepId: event.stepId,
        toolCallId: event.toolCallId,
        name: event.identity.name,
        qualified: event.identity.qualified,
        target: event.argsSummary.target,
        status: "running",
        tsStart: event.ts,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.progress":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "running",
        message: event.message,
      }
    case "step.started":
      // Progres langkah: UiPresentationEvent membawa angka mentah; label
      // terjemahan dihitung transcript (i18n), bukan di sini (lintas lapisan).
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        step: event.step,
        ...(event.total !== undefined ? { total: event.total } : {}),
        ...(event.label ? { label: event.label } : {}),
      }
    case "tool.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "completed",
        durationMs: event.durationMs,
        toolSummary: event.summary,
        expandRef: event.expandRef,
        ...(event.receipt
          ? {
              receipt: {
                ...(event.receipt.paths ? { paths: event.receipt.paths } : {}),
                ...(event.receipt.checkpointId ? { checkpointId: event.receipt.checkpointId } : {}),
                ...(event.receipt.stats ? { stats: event.receipt.stats } : {}),
                ...(event.receipt.test ? { test: event.receipt.test } : {}),
                ...(event.receipt.cmd ? { cmd: event.receipt.cmd } : {}),
              },
            }
          : {}),
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.failed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "failed",
        durationMs: event.durationMs,
        message: event.message,
        cause: event.cause,
        ...(event.hint ? { hint: event.hint } : {}),
        ...(event.schemaDrift ? { schemaDrift: event.schemaDrift } : {}),
        expandRef: event.expandRef,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.denied":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "denied",
        message: event.message,
        reason: event.reason,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "tool.cancelled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        status: "cancelled",
        reason: event.reason,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "approval.requested":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        name: event.identity.name,
        qualified: event.identity.qualified,
        target: event.argsSummary.target,
        via: event.via,
        ...(event.riskTier ? { riskTier: event.riskTier } : {}),
        ...(event.diffPreview ? { diffPreview: event.diffPreview } : {}),
      }
    case "approval.settled":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        outcome: event.outcome,
      }
    case "file.changed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        paths: event.paths,
        ...(event.journalSeq !== undefined ? { journalSeq: event.journalSeq } : {}),
        ...(event.checkpointId ? { checkpointId: event.checkpointId } : {}),
      }
    case "test.completed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        test: { passed: event.passed, failed: event.failed, summary: event.summary },
      }
    case "verification.observed":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        invocationId: event.invocationId,
        verification: {
          invocationId: event.invocationId,
          verdict: event.verdict,
          method: event.method,
          observedAt: event.observedAt,
        },
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "activity.label":
      // Judul diri anak hanya mengubah label activity; renderer wajib no-op
      // (lihat transcript.presentationEvent) agar tak ada baris baru.
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        label: event.label,
      }
    case "context.compacted":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        reason: event.reason,
        compactionReason: event.reason,
      }
    case "plan.updated":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        planId: event.planId,
        status: event.status === "open" ? "running" : event.status,
        steps: event.steps,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "finding.detected":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        findingId: event.findingId,
        category: event.category,
        severity: event.severity,
        text: event.summary,
        evidence: event.evidence,
        ...(event.parentLink ? { parentToolCallId: event.parentLink.parentToolCallId } : {}),
      }
    case "result.produced":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        resultId: event.resultId,
        status: event.status === "completed" ? "completed" : event.status,
        toolSummary: event.summary,
        action: event.action,
        ...(event.expandRef ? { expandRef: event.expandRef } : {}),
      }
    case "diagnostic.raised":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        category: event.category,
        severity: event.severity,
        message: event.message,
        cause: event.cause,
        action: event.action,
      }
    case "checkpoint.created":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        checkpointId: event.checkpointId,
        paths: event.paths,
      }
    case "consequence.decided":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        verdict: event.verdict,
        failureClass: event.failureClass,
        nextAction: event.nextAction,
        message: event.rationale,
        severity: event.verdict === "FAIL" || event.verdict === "BLOCKED" ? "error" : "warning",
        ...(event.newEvidenceSinceLastAttempt !== undefined
          ? { newEvidenceSinceLastAttempt: event.newEvidenceSinceLastAttempt }
          : {}),
      }
    case "context.window":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        usedTokens: event.usedTokens,
        windowTokens: event.windowTokens,
        ...(event.percent !== undefined ? { percent: event.percent } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.providerModel ? { providerModel: event.providerModel } : {}),
      }
    case "context.cutoff":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        reason: event.reason,
        message: event.reason,
        severity: "warning",
        ...(event.usedTokens !== undefined ? { usedTokens: event.usedTokens } : {}),
        ...(event.windowTokens !== undefined ? { windowTokens: event.windowTokens } : {}),
      }
    case "task.status":
      return {
        type: event.type,
        seq: event.eventSeq,
        turnId: event.turnId,
        taskId: event.taskId,
        taskStatus: event.status,
        ...(event.parentId ? { parentId: event.parentId } : {}),
        ...(event.dependsOn ? { dependsOn: [...event.dependsOn] } : {}),
        ...(event.revision !== undefined ? { revision: event.revision } : {}),
        ...(event.verification ? { taskVerification: event.verification } : {}),
      }
    default: {
      const exhaustive: never = event
      void exhaustive
      return null
    }
  }
}

/**
 * P1.6: proyeksi UI membawa identitas session/child-run tanpa mengulang setiap
 * case. `sessionId` DomainEvent adalah session pemilik event (anak untuk forward),
 * `parentLink` adalah taut ke pemanggil.
 */
export function toPresentationEvent(event: DomainEvent): UiPresentationEvent | null {
  const mapped = mapPresentationEvent(event)
  if (!mapped) return null
  const link = (
    event as { parentLink?: { childSessionId?: string; runId?: string; label?: string } }
  ).parentLink
  return {
    ...mapped,
    sessionId: event.sessionId,
    ...(link?.childSessionId ? { childSessionId: link.childSessionId } : {}),
    ...(link?.runId ? { runId: link.runId } : {}),
    // Continuasi label sub-agent ke UiPresentationEvent → Activity → runMarker.
    ...(link?.label ? { label: link.label } : {}),
  }
}

export function parseVerifyTestEvidence(
  command: string,
  output: string,
): { passed: number; failed: number; summary: string } | undefined {
  if (!/(?:test|vitest|jest|pytest|cargo\s+test)/i.test(command)) return undefined
  const passedMatch = /(\d+)\s+(?:pass(?:ed)?|successful?)/i.exec(output)
  const failedMatch = /(\d+)\s+(?:fail(?:ed|ures?)?|failing)/i.exec(output)
  if (!passedMatch && !failedMatch) return undefined
  return {
    passed: passedMatch ? Number(passedMatch[1]) : 0,
    failed: failedMatch ? Number(failedMatch[1]) : 0,
    summary:
      output
        .split(/\r?\n/)
        .find((line) => /(?:pass|fail)/i.test(line))
        ?.trim()
        .slice(0, 500) ?? "verify completed",
  }
}

/** Kompaksi LLM child session bersama (`canPersistMemory: false` mencegah polusi global). */
export function createChildCompaction(opts: {
  provider: unknown
  model?: string
  cwd?: string
  contextWindowTokensForModel?: (model?: string) => number
  getContextModel?: () => string | undefined
}) {
  const getWindow = opts.contextWindowTokensForModel
  return createLlmCompaction({
    provider: opts.provider as never,
    getModel: () => opts.getContextModel?.() ?? opts.model,
    cwd: opts.cwd ?? process.cwd(),
    ...(getWindow ? { getContextWindowTokens: () => getWindow(opts.model) } : {}),
    canPersistMemory: () => false,
  })
}
