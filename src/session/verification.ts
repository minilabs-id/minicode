// P2.10 — canonical execution evidence and explicit external-effect observation.
//
// Layering:
// - ToolInvocationId = application-owned invocation identity.
// - EffectIntent = durable pre-effect record in the existing mutation journal.
// - EffectReceipt = durable post-execution terminal in the same journal.
// - VerificationRecord = a separate durable journal record produced ONLY by
//   explicit observation. Untrusted prose and unrelated lifecycle,
//   observation, authorization, or persistence-watermark authorities are never
//   accepted as effect proof.
// - Idempotency reuses outcome.note, following the proven MCP-server pattern.
// - Child effect correlation reads child-journal evidence and explicit child
//   observation; it never treats delegation prose as effect evidence.
//
// This module writes only journal evidence. It never writes conversation,
// derived, observation, lifecycle, or watermark stores. It also never imports
// presentation, context, persistence, task, or CLI modules.

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { Tool, ToolContext } from "#minicore"
import { GIT_SAFE_BASE, gitFilterNeutralizersSync } from "../lib/git-hardening.ts"
import { safeReadFile, safeStat } from "../lib/safe-open.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { WRITE_TOOLS } from "../policy/tool-contract.ts"
import type { VerifyResult } from "../policy/verifier.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  appendVerificationRecord,
  type ChildResultEnvelope,
  type ChildStatus,
  hashArgs,
  isCanonicalEvidenceCovered,
  isJournalHealthy,
  isVerificationMethod,
  type JournalOutcome,
  type JournalRecord,
  loadJournal,
  type VerificationMethod,
  type VerificationVerdict,
  verifyPaths,
} from "./journal.ts"

// Status observasi anak dipakai pemanggil delegate (tipe milik journal,
// diekspor ulang agar factory receipt punya satu seam bukti).
export type { ChildStatus } from "./journal.ts"

import { isGitRepo } from "./shadow-git.ts"

const MAX_ID = 200
const MAX_ACK = 200
const GIT_OBSERVE_TIMEOUT_MS = 10_000
const SHA_RE = /^[0-9a-f]{7,64}$/i
const TRUNCATION_MARKERS = ["[truncated", "[output truncated]"]
const BASH_EXIT_RE = /^exit (-?\d+)(?:\D|$)/
const GIT_HEAD_RE = /HEAD:\s*([0-9a-f]{7,40})\b/i

export type SpecialEvidencePath = "delegate-task" | "mcp-server"
export type EffectAckSource =
  | "bash-exit"
  | "sandbox-exit"
  | "git-commit"
  | "external-response"
  | "absent"
export type IdempotencyScope = "session" | "mcp"
export type IdempotencyStatus = "proceed" | "committed" | "failed" | "pending" | "conflict"
export type ChildDelegationStatus = "committed" | "failed" | "pending" | "absent"
export type ChildJournalStatus = "committed" | "failed" | "pending" | "absent"
export type ChildVerificationStatus = "present" | "absent" | "inconclusive" | "absent-record"

export interface ToolInvocationRequest {
  sessionId: string
  threadId: string
  turnIndex?: number | null
  tool: string
  providerToolCallId?: string
}

export interface ToolInvocationId {
  version: 1
  sessionId: string
  threadId: string
  turnIndex: number | null
  tool: string
  providerToolCallId?: string
  allocationSequence: number
  nonce: string
  value: string
}

export interface InvocationAllocation {
  allocationSequence: number
  nonce?: string
}

function asNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`verification: refusing invocation without ${field}`)
  }
  return value
}

function normalizeTurnIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null
}

function normalizeProviderToolCallId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return scrubSecrets(trimmed).slice(0, MAX_ID)
}

function normalizeNonce(nonce: string | undefined): string {
  if (typeof nonce === "string" && /^[0-9a-f]{16}$/.test(nonce)) return nonce
  return randomUUID().replace(/-/g, "").slice(0, 16)
}

/** Application-owned invocation identity. Provider identifiers are locators only. */
export function allocateToolInvocationId(
  request: ToolInvocationRequest,
  allocation: InvocationAllocation,
): ToolInvocationId {
  const sessionId = asNonEmpty(request.sessionId, "sessionId")
  const threadId = asNonEmpty(request.threadId, "threadId")
  const tool = asNonEmpty(request.tool, "tool")
  const turnIndex = normalizeTurnIndex(request.turnIndex)
  const providerToolCallId = normalizeProviderToolCallId(request.providerToolCallId)
  if (!Number.isInteger(allocation.allocationSequence) || allocation.allocationSequence < 0) {
    throw new Error("verification: refusing invocation without journal allocation sequence")
  }
  const nonce = normalizeNonce(allocation.nonce)
  const locatorHash = createHash("sha256")
    .update(`${tool}\u0000${providerToolCallId ?? ""}`)
    .digest("hex")
    .slice(0, 16)
  const value = [
    "inv",
    sanitizeSessionPart(sessionId),
    sanitizeSessionPart(threadId),
    `t${turnIndex ?? "x"}`,
    `s${allocation.allocationSequence}`,
    locatorHash,
    nonce,
  ].join(":")
  return {
    version: 1,
    sessionId,
    threadId,
    turnIndex,
    tool,
    ...(providerToolCallId ? { providerToolCallId } : {}),
    allocationSequence: allocation.allocationSequence,
    nonce,
    value,
  }
}

export interface EffectIntentRequest {
  sessionId: string
  threadId: string
  turnIndex?: number | null
  tool: string
  providerToolCallId?: string
  cwd: string
  childOf?: string
  args?: unknown
  paths?: string[]
  idempotencyKey?: string
  idempotencyScope?: IdempotencyScope
  childSessionId?: string
  specialPath?: SpecialEvidencePath
}

export interface EffectIntentResult {
  invocation: ToolInvocationId
  record: JournalRecord
  argsHash: string
  idempotencyKey?: string
  durable: boolean
}

function normalizeIdempotencyKey(
  sessionId: string,
  key: unknown,
  scope: IdempotencyScope = "session",
): string {
  if (scope === "mcp") {
    // Preserve the proven MCP request/id + args-hash key byte-for-byte.
    if (typeof key !== "string" || !key) {
      throw new Error("verification: refusing MCP intent without idempotency key")
    }
    return key
  }
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("verification: refusing intent without idempotency key")
  }
  const safe = scrubSecrets(key.trim()).slice(0, MAX_ID)
  if (!safe) throw new Error("verification: refusing empty idempotency key")
  return `p210:intent:session:${sanitizeSessionPart(sessionId)}:${safe}`
}

function requireWorkspaceRoot(cwd: unknown): string {
  // Evidence storage must use an explicit workspace. ToolContext.cwd remains
  // the authority for file effects; this root only selects the journal file.
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("verification: refusing evidence without explicit workspace root")
  }
  return resolve(cwd)
}

/** Write one canonical pre-effect intent and await its durable result. */
export async function persistEffectIntent(
  request: EffectIntentRequest,
): Promise<EffectIntentResult> {
  const tool = asNonEmpty(request.tool, "tool")
  if (request.specialPath === undefined && !isCanonicalEvidenceCovered(tool)) {
    throw new Error(`verification: refusing intent for non-covered tool ${tool}`)
  }
  if (request.specialPath === "delegate-task" && tool !== "delegate_task") {
    throw new Error("verification: delegate-task special path requires delegate_task")
  }
  const sessionId = asNonEmpty(request.sessionId, "sessionId")
  const threadId = asNonEmpty(request.threadId, "threadId")
  const root = requireWorkspaceRoot(request.cwd)
  const argsHash = hashArgs(request.args ?? {})
  const idempotencyKey = request.idempotencyKey
    ? normalizeIdempotencyKey(
        sessionId,
        request.idempotencyKey,
        request.idempotencyScope ?? "session",
      )
    : undefined
  const providerToolCallId = normalizeProviderToolCallId(request.providerToolCallId)
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16)
  const record = await appendMutationIntent({
    session: sessionId,
    ...(request.childOf ? { childOf: request.childOf } : {}),
    turn: normalizeTurnIndex(request.turnIndex),
    tool,
    threadId,
    providerToolCallId,
    allocateInvocationId: (allocationSequence) =>
      allocateToolInvocationId(
        {
          sessionId,
          threadId,
          turnIndex: normalizeTurnIndex(request.turnIndex),
          tool,
          ...(providerToolCallId ? { providerToolCallId } : {}),
        },
        { allocationSequence, nonce },
      ).value,
    cwd: root,
    paths: request.paths ?? verifyPaths(tool, request.args ?? {}, root),
    argsHash,
    ...(request.childSessionId ? { childSessionId: request.childSessionId } : {}),
    ...(idempotencyKey ? { note: idempotencyKey } : {}),
  })
  const invocation = allocateToolInvocationId(
    {
      sessionId,
      threadId,
      turnIndex: normalizeTurnIndex(request.turnIndex),
      tool,
      ...(providerToolCallId ? { providerToolCallId } : {}),
    },
    { allocationSequence: record.seq, nonce },
  )
  const durable = isJournalHealthy(sessionId, root)
  return { invocation, record, argsHash, ...(idempotencyKey ? { idempotencyKey } : {}), durable }
}

export interface ObservedAck {
  ack: string | number | boolean | null
  ackSource: EffectAckSource
  ackAuthority?: "application-observed"
}

function extractObservedAck(tool: string, result: unknown): ObservedAck {
  const absent: ObservedAck = { ack: null, ackSource: "absent" }
  if (typeof result !== "string") return absent
  if (tool === "bash" || tool === "code_run") {
    const match = BASH_EXIT_RE.exec(result)
    if (!match) return absent
    const code = Number(match[1])
    if (!Number.isFinite(code)) return absent
    return {
      ack: code,
      ackSource: tool === "bash" ? "bash-exit" : "sandbox-exit",
      ackAuthority: "application-observed",
    }
  }
  if (tool === "git_commit") {
    const match = GIT_HEAD_RE.exec(result)
    if (!match?.[1]) return absent
    return {
      ack: match[1],
      ackSource: "git-commit",
      ackAuthority: "application-observed",
    }
  }
  // Delegation text, MCP prose, and file-tool prose are observations, not
  // structured external acknowledgements. Keep them absent rather than guess.
  return absent
}

function hasTruncationMarker(result: unknown): boolean {
  return typeof result === "string" && TRUNCATION_MARKERS.some((marker) => result.includes(marker))
}

/**
 * Batas ringkasan amplop anak (P9.2.1): naik 2_000 → 4_000 mengikuti pagu
 * teks partial child (`MAX_PARTIAL_CHARS`), supaya amplop durable tak memotong
 * temuan yang masih muat di output anak. Satuan code-unit UTF-16 (`length`/
 * `slice` JS memang berhitung begitu). Bukan limit retensi/transkrip baru.
 */
export const CHILD_RESULT_SUMMARY_MAX = 4_000

/**
 * Klasifikasi observasi turn anak dari error terstruktur (P9.2.1).
 * Hanya membaca `kind` terstruktur (taksonomi AgentError vendor) — TIDAK
 * menebak dari wording pesan (isTimeoutOutcome/isAbortOutcome berbasis pesan
 * sengaja tak dipakai di sini). Tanpa `kind` yang dikenal = `error`
 * konservatif: terlihat gagal, sebab tak terpetakan. Bukan vonis kausal.
 */
export function classifyChildStatus(
  error: unknown,
): "timeout" | "aborted" | "max_steps_exceeded" | "error" {
  const kind = (error as { kind?: unknown } | null)?.kind
  if (kind === "timeout") return "timeout"
  if (kind === "aborted") return "aborted"
  if (kind === "max_steps_exceeded") return "max_steps_exceeded"
  return "error"
}

/**
 * Flag outcome-level untuk status anak (P9.2.1): memakai kosakata outcome
 * yang sudah ada (`timeout`/`aborted`, konsisten dengan
 * summarizeObservedReturn) plus `maxStepsExceeded` untuk pagu langkah —
 * BUKAN status baru di `ChildStatus`. Parameter bertipe gabungan penuh agar
 * pemanggil yang variabelnya disempitkan CFA (penugasan di dalam closure tak
 * terbaca di situs finally) tetap bisa memakainya jujur.
 *
 * KENAPA `max_steps_exceeded` ikut dalam "failure set": turn yang berhenti
 * karena pagu langkah adalah KEGAGALAN, bukan penyelesaian normal. Tanpa flag
 * ini pemanggil (`src/tools/task.ts`) mengira anak selesai dan mengunci Run
 * COMPLETED — padahal hasilnya terpotong. Flag ini TIDAK mengubah makna
 * receipt `committed`/`failed` (delegasi memang jalan); hanya mengubah status
 * Run anak menjadi INTERRUPTED/UNKNOWN, sama seperti timeout/abort.
 */
export function childStatusOutcomeFlags(status: ChildStatus): {
  timeout?: true
  aborted?: true
  maxStepsExceeded?: true
} {
  return {
    ...(status === "timeout" ? { timeout: true as const } : {}),
    ...(status === "aborted" ? { aborted: true as const } : {}),
    ...(status === "max_steps_exceeded" ? { maxStepsExceeded: true as const } : {}),
  }
}

/** [Fase 7 / LOOP-INV-13/15] Verdict consequence-engine (ACE-Lite) dari hasil anak. */
export interface AceResultSnapshot {
  readonly verdict: import("../policy/consequence-engine.ts").AceVerdict
  readonly failureClass: import("../policy/consequence-engine.ts").AceFailureClass
  readonly nextAction: import("../policy/consequence-engine.ts").AceNextAction
  readonly rationale?: string
}

/**
 * Bangun amplop hasil anak (P9.2.1): sanitasi salinan DENGAN primitif yang
 * sudah mapan (`scrubSecrets`, sama seperti ack/evidenceReference), lalu
 * potong ke `CHILD_RESULT_SUMMARY_MAX`. `summary` adalah string yang sudah
 * dilihat parent (atau pesan rejection bila tak ada) — JANGAN umpan teks
 * mentah tak terbatas ke sini; pemanggil memotong di batas parent dulu.
 * `runId`/`steps` null bila memang tak tersedia di jalur itu.
 * ACE verdict opsional: bila ada, disimpan bersama outcome untuk auditability.
 */
export function buildChildResultEnvelope(input: {
  childStatus: ChildStatus
  summary: string
  runId: string | null
  steps: number | null
  aceVerdict?: AceResultSnapshot
}): ChildResultEnvelope {
  const clean = scrubSecrets(input.summary)
  const truncated = clean.length > CHILD_RESULT_SUMMARY_MAX
  return {
    childStatus: input.childStatus,
    resultSummary: truncated ? clean.slice(0, CHILD_RESULT_SUMMARY_MAX) : clean,
    runId: input.runId,
    steps: typeof input.steps === "number" && Number.isFinite(input.steps) ? input.steps : null,
    truncated,
    ...(input.aceVerdict !== undefined ? { aceVerdict: input.aceVerdict } : {}),
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function isAbortOutcome(error: unknown, signalAborted: boolean): boolean {
  if (signalAborted) return true
  const outcome = error as { name?: unknown; message?: unknown; code?: unknown } | null
  if (!outcome || typeof outcome !== "object") return false
  if (outcome.name === "AbortError" || outcome.code === "ABORT_ERR") return true
  return outcome.message === "aborted"
}

function isTimeoutOutcome(error: unknown): boolean {
  const outcome = error as { name?: unknown; message?: unknown; code?: unknown } | null
  if (!outcome || typeof outcome !== "object") return false
  if (
    outcome.name === "TimeoutError" ||
    outcome.code === "ETIMEDOUT" ||
    outcome.code === "TIMEOUT"
  ) {
    return true
  }
  return (
    typeof outcome.message === "string" &&
    (/\btimed out\b/i.test(outcome.message) || /\btimeout\b/i.test(outcome.message))
  )
}

/** Summarize an observed return without storing tool output or inferring effects. */
export function summarizeObservedReturn(input: {
  tool: string
  result?: unknown
  error?: unknown
  signalAborted?: boolean
  observedAt?: number
}): JournalOutcome {
  const signalAborted = input.signalAborted === true
  const observedAt =
    typeof input.observedAt === "number" && Number.isFinite(input.observedAt)
      ? input.observedAt
      : Date.now()
  if (input.error !== undefined) {
    const aborted = isAbortOutcome(input.error, signalAborted)
    return {
      ...(aborted ? { aborted: true as const } : {}),
      ...(!aborted && isTimeoutOutcome(input.error) ? { timeout: true as const } : {}),
      loss: "unknown",
      uncertainty: "ambiguous-effect",
      observedAt,
    }
  }
  const ack = extractObservedAck(input.tool, input.result)
  const outcome: JournalOutcome = {
    loss: "none",
    uncertainty: "unverified-external",
    observedAt,
  }
  if (ack.ack !== null && ack.ack !== undefined) {
    const value = typeof ack.ack === "string" ? scrubSecrets(ack.ack).slice(0, MAX_ACK) : ack.ack
    return {
      ...outcome,
      ack: value,
      ackSource: ack.ackSource,
      ackAuthority: "application-observed",
      ...(hasTruncationMarker(input.result) ? { truncated: true as const } : {}),
    }
  }
  return {
    ...outcome,
    ack: null,
    ackSource: "absent",
    ...(hasTruncationMarker(input.result) ? { truncated: true as const } : {}),
  }
}

export interface EffectReceiptRequest {
  sessionId: string
  threadId: string
  tool: string
  providerToolCallId?: string
  cwd: string
  invocation: ToolInvocationId
  intent: Pick<JournalRecord, "id" | "seq" | "tool" | "session" | "invocationId" | "argsHash">
  state: "committed" | "failed"
  result?: unknown
  error?: unknown
  signalAborted?: boolean
  outcome?: Omit<JournalOutcome, "observedAt"> & { observedAt?: number }
  childSessionId?: string
  dedup?: boolean
  specialPath?: SpecialEvidencePath
}

function findIntentRecord(
  records: JournalRecord[],
  request: EffectReceiptRequest,
): JournalRecord | undefined {
  return records.find(
    (record) =>
      (!record.kind || record.kind === "mutation") &&
      record.id === request.intent.id &&
      record.seq === request.intent.seq &&
      record.session === request.sessionId &&
      record.tool === request.tool &&
      record.invocationId === request.invocation.value,
  )
}

function hasTerminalRecord(records: JournalRecord[], request: EffectReceiptRequest): boolean {
  return records.some(
    (record) =>
      (!record.kind || record.kind === "mutation") &&
      record.id === request.intent.id &&
      (record.state === "committed" || record.state === "failed"),
  )
}

/** Write one canonical post-execution terminal for a durable intent. */
export async function persistEffectReceipt(
  request: EffectReceiptRequest,
): Promise<{ durable: boolean }> {
  const sessionId = asNonEmpty(request.sessionId, "sessionId")
  const threadId = asNonEmpty(request.threadId, "threadId")
  const tool = asNonEmpty(request.tool, "tool")
  if (request.state !== "committed" && request.state !== "failed") {
    throw new Error("verification: refusing receipt with unsupported state")
  }
  if (request.invocation.sessionId !== sessionId || request.invocation.tool !== tool) {
    throw new Error("verification: refusing receipt for mismatched invocation")
  }
  const root = requireWorkspaceRoot(request.cwd)
  const loaded = await loadJournal(sessionId, root)
  if (loaded.status === "unreadable") {
    throw new Error("verification: refusing receipt while intent evidence is unreadable")
  }
  const intent = findIntentRecord(loaded.records, request)
  if (!intent) {
    throw new Error("verification: refusing terminal without durable intent")
  }
  if (hasTerminalRecord(loaded.records, request)) {
    throw new Error("verification: refusing duplicate terminal for invocation")
  }
  const summary = summarizeObservedReturn({
    tool,
    result: request.result,
    error: request.error,
    signalAborted: request.signalAborted,
    observedAt: request.outcome?.observedAt,
  })
  const outcome: JournalOutcome = {
    ...(request.outcome?.code !== undefined ? { code: request.outcome.code } : {}),
    ...(request.outcome?.note !== undefined ? { note: request.outcome.note } : {}),
    ...(request.outcome?.ack !== undefined
      ? {
          ack:
            typeof request.outcome.ack === "string"
              ? scrubSecrets(request.outcome.ack).slice(0, MAX_ACK)
              : request.outcome.ack,
        }
      : { ack: summary.ack ?? null }),
    ...(request.outcome?.ackSource !== undefined
      ? { ackSource: request.outcome.ackSource }
      : { ackSource: summary.ackSource ?? "absent" }),
    ...(request.outcome?.ackAuthority !== undefined
      ? { ackAuthority: request.outcome.ackAuthority }
      : summary.ackAuthority
        ? { ackAuthority: summary.ackAuthority }
        : {}),
    ...(request.outcome?.truncated === true || summary.truncated === true
      ? { truncated: true as const }
      : {}),
    ...(request.outcome?.timeout === true || summary.timeout === true
      ? { timeout: true as const }
      : {}),
    ...(request.outcome?.aborted === true || summary.aborted === true
      ? { aborted: true as const }
      : {}),
    // v7.31: flag max_steps harus ikut ke receipt durable, bukan hanya
    // dipakai untuk terminalisasi Run — kalau tidak, pembaca outcome melihat
    // anak "normal" walau ia mati karena batas langkah.
    ...(request.outcome?.maxStepsExceeded === true || summary.maxStepsExceeded === true
      ? { maxStepsExceeded: true as const }
      : {}),
    ...(request.outcome?.loss !== undefined
      ? { loss: request.outcome.loss }
      : summary.loss
        ? { loss: summary.loss }
        : {}),
    ...(request.outcome?.uncertainty !== undefined
      ? { uncertainty: request.outcome.uncertainty }
      : summary.uncertainty
        ? { uncertainty: summary.uncertainty }
        : {}),
    ...(request.outcome?.observedAt !== undefined
      ? { observedAt: request.outcome.observedAt }
      : summary.observedAt !== undefined
        ? { observedAt: summary.observedAt }
        : {}),
    // P9.2.1: amplop anak diteruskan eksplisit (allowlist seperti field
    // lain di atas — JANGAN spread buta seluruh outcome). Batas + sanitasi
    // dijamin produsen via buildChildResultEnvelope; di sini hanya
    // penerusan agar bentuk record lama tak berubah.
    ...(request.outcome?.childResult !== undefined
      ? { childResult: request.outcome.childResult }
      : {}),
  }
  await appendMutationTerminal(
    sessionId,
    root,
    intent.id,
    intent.seq,
    tool,
    request.state,
    outcome,
    request.childSessionId,
    {
      ...(request.dedup === true || outcome.note !== undefined ? { dedup: true as const } : {}),
      threadId,
      invocationId: request.invocation.value,
      ...(request.providerToolCallId ? { providerToolCallId: request.providerToolCallId } : {}),
      ...(intent.argsHash ? { argsHash: intent.argsHash } : {}),
      receipt: {
        ...(outcome.ack !== undefined ? { ack: outcome.ack } : {}),
        ...(outcome.ackSource !== undefined ? { ackSource: outcome.ackSource } : {}),
        ...(outcome.ackAuthority !== undefined ? { ackAuthority: outcome.ackAuthority } : {}),
        ...(outcome.truncated === true ? { truncated: true as const } : {}),
        ...(outcome.timeout === true ? { timeout: true as const } : {}),
        ...(outcome.aborted === true ? { aborted: true as const } : {}),
        ...(outcome.loss !== undefined ? { loss: outcome.loss } : {}),
        ...(outcome.uncertainty !== undefined ? { uncertainty: outcome.uncertainty } : {}),
        ...(outcome.observedAt !== undefined ? { observedAt: outcome.observedAt } : {}),
      },
    },
  )
  return { durable: isJournalHealthy(sessionId, root) }
}

export class EvidenceIncompleteError extends Error {
  readonly code = "REFUSED_VERIFICATION_EVIDENCE"
}

export class IdempotentDuplicateError extends Error {
  readonly code: string
  readonly status: Exclude<IdempotencyStatus, "proceed">
  constructor(status: Exclude<IdempotencyStatus, "proceed">, message: string) {
    super(message)
    this.code =
      status === "pending" ? "UNKNOWN_IDEMPOTENT_INVOCATION" : "REFUSED_IDEMPOTENT_DUPLICATE"
    this.status = status
  }
}

export function buildIdempotencyKey(sessionId: string, key: unknown): string {
  const sid = asNonEmpty(sessionId, "sessionId")
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("verification: refusing empty idempotency key")
  }
  const safe = scrubSecrets(key.trim()).slice(0, MAX_ID)
  if (!safe) throw new Error("verification: refusing empty idempotency key")
  return `p210:intent:session:${sanitizeSessionPart(sid)}:${safe}`
}

export interface IdempotencyLookup {
  status: IdempotencyStatus
  invocationId?: string
  recordId?: string
  message?: string
}

/** Durable duplicate lookup for one session-scoped idempotency key. */
export async function findIdempotentInvocation(input: {
  sessionId: string
  cwd: string
  idempotencyKey: string
  argsHash: string
}): Promise<IdempotencyLookup> {
  const sessionId = asNonEmpty(input.sessionId, "sessionId")
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey) {
    throw new Error("verification: refusing idempotency lookup without key")
  }
  if (typeof input.argsHash !== "string" || !input.argsHash) {
    throw new Error("verification: refusing idempotency lookup without args hash")
  }
  const root = requireWorkspaceRoot(input.cwd)
  const loaded = await loadJournal(sessionId, root)
  // v7.33 fail-closed: journal yang ADA tapi tak terbaca bukan bukti kosong.
  // Mengembalikan "proceed" di sini akan menjalankan ulang efek yang mungkin
  // sudah committed (yang hilang hanyalah receipt-nya). Tolak dengan "pending"
  // agar pemanggil berhenti dan recovery menentukan nasibnya, bukan kita menebak.
  if (loaded.status === "unreadable") {
    return {
      status: "pending",
      message: `idempotency lookup refused: journal unreadable — effect status unknown`,
    }
  }
  let exactTerminal: JournalRecord | undefined
  let exactPending: JournalRecord | undefined
  let conflict: JournalRecord | undefined
  for (const record of loaded.records) {
    if (record.outcome?.note !== input.idempotencyKey) continue
    if ((!record.kind || record.kind === "mutation") === false) continue
    if (record.argsHash !== input.argsHash) {
      conflict = record
      continue
    }
    if (record.state === "committed" || record.state === "failed") {
      // First terminal wins elsewhere in recovery; keep the same rule here.
      exactTerminal = exactTerminal ?? record
      continue
    }
    // v7.39 (P0-2): journal mendefinisikan `unknown` sebagai terminal AMBIGU —
    // eksekusi berhenti tanpa bukti apakah efeknya terjadi. Di gerbang
    // idempotency ini ia WAJIB diperlakukan seperti `pending`: tolak eksekusi
    // dan paksa recovery memverifikasi. Membiarkannya jatuh ke "proceed" adalah
    // blind re-execution atas efek yang mungkin sudah committed.
    // Audit: `state` bersifat opsional pada JournalRecord. Record mutasi dengan
    // note+argsHash+kind yang cocok tetapi `state === undefined` (mis. intent
    // yang terminalnya gagal ditulis) dulu jatuh ke "proceed" — blind
    // re-execution. Fail-closed: SEMUA state bukan terminal yang dikenal
    // (pending, unknown, undefined, atau nilai tak dikenal dari journal) =
    // pending, sehingga eksekusi dihentikan dan recovery yang memutuskan.
    exactPending = exactPending ?? record
  }
  if (exactTerminal?.state === "committed" || exactTerminal?.state === "failed") {
    const state = exactTerminal.state
    return {
      status: state,
      ...(exactTerminal.invocationId ? { invocationId: exactTerminal.invocationId } : {}),
      recordId: exactTerminal.id,
      message:
        state === "committed"
          ? `duplicate idempotency key: already committed — do not execute again blindly; verify state before retrying with a new key`
          : `duplicate idempotency key: previous attempt failed — inspect state, then retry with a new key`,
    }
  }
  if (exactPending) {
    return {
      status: "pending",
      ...(exactPending.invocationId ? { invocationId: exactPending.invocationId } : {}),
      recordId: exactPending.id,
      message: `duplicate idempotency key: previous attempt status unknown — verify state before retrying with a new key`,
    }
  }
  if (conflict) {
    return {
      status: "conflict",
      ...(conflict.invocationId ? { invocationId: conflict.invocationId } : {}),
      recordId: conflict.id,
      message: `idempotency conflict: same key with different arguments — explicit refusal`,
    }
  }
  return { status: "proceed" }
}

const idempotentExecutions = new Map<string, Promise<unknown>>()

async function runOncePerIdempotencyKey(key: string, runner: () => Promise<unknown>) {
  const prior = idempotentExecutions.get(key)
  if (prior) return prior
  const task = (async () => runner())()
  idempotentExecutions.set(key, task)
  try {
    return await task
  } finally {
    if (idempotentExecutions.get(key) === task) idempotentExecutions.delete(key)
  }
}

/**
 * v7.33 fail-closed receipt: sinyal eksplisit saat receipt pasca-efek gagal
 * ditulis durable. Dulu sinyalnya dibuang (`void receipt.durable`), sehingga
 * efek yang SUDAH committed di dunia nyata + intent yang masih pending tampak
 * seperti sukses bersih — recovery lalu bisa menjalankan ulang efek itu.
 * `loss: "persistence"` memakai kosakata `JournalOutcome` yang sudah ada,
 * bukan kategori baru.
 */
export interface ReceiptLossSignal {
  readonly kind: "non-durable-receipt"
  readonly tool: string
  readonly invocationId: string
  readonly state: "committed"
  readonly loss: "persistence"
}

/**
 * Bentuk "explicit error" dari sinyal di atas. Composition root bisa memasang
 * `onReceiptLoss: throwOnReceiptLoss` supaya eksekusi gagal keras alih-alih
 * mengembalikan hasil seolah tersimpan. Melewatkan kelas `EvidenceIncompleteError`
 * menjaga satu bahasa galat evidence di seluruh modul.
 */
export class ReceiptNotDurableError extends EvidenceIncompleteError {
  readonly signal: ReceiptLossSignal
  constructor(signal: ReceiptLossSignal) {
    super(
      `verification: refusing clean success — receipt for ${signal.tool}/${signal.invocationId} is non-durable (loss: ${signal.loss})`,
    )
    this.signal = signal
  }
}

export function throwOnReceiptLoss(signal: ReceiptLossSignal): never {
  throw new ReceiptNotDurableError(signal)
}

export interface CanonicalScope {
  sessionId: string
  threadId: string
  cwd: string
  childOf?: string
  getTurnIndex?: () => number | null
  idempotencyKeyFor?: (tool: string, args: unknown) => string | undefined
  /**
   * v7.33 fail-closed receipt: dipanggil BILA receipt sukses gagal ditulis
   * durable. Ini satu-satunya tempat sinyal itu keluar — jangan dibuang lagi.
   * Opsional (default no-op) agar test lama yang memeriksa outcome mentah
   * tetap kompatibel; pemanggil produksi wajib menyuntik penolak/pewarta.
   */
  onReceiptLoss?: (signal: ReceiptLossSignal) => void | Promise<void>
}

export interface EvidenceWriter {
  writeIntent: (input: EffectIntentRequest) => Promise<EffectIntentResult>
  writeReceipt: (input: EffectReceiptRequest) => Promise<{ durable: boolean }>
}

const journalEvidenceWriter: EvidenceWriter = {
  writeIntent: (input) => persistEffectIntent(input),
  writeReceipt: (input) => persistEffectReceipt(input),
}

/**
 * Canonical awaited wrapper around one covered mutation-tool execution.
 *
 * Ordering is deliberate: awaited intent, then inner execute, then awaited
 * receipt. Intent failure refuses execution; receipt failure preserves the
 * observed tool outcome but (v7.33) no longer SILENTLY drops the signal —
 * `scope.onReceiptLoss` is awaited so the caller can refuse or flag a
 * committed effect whose terminal never became durable.
 */
export async function executeCanonicalInvocation(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
  scope: CanonicalScope,
  writer: EvidenceWriter = journalEvidenceWriter,
): Promise<unknown> {
  if (!isCanonicalEvidenceCovered(tool.name)) return tool.execute(input, ctx)
  const sessionId = asNonEmpty(scope.sessionId, "sessionId")
  const threadId = asNonEmpty(scope.threadId, "threadId")
  // File effects use ToolContext.cwd first; scope.cwd only selects evidence storage.
  const effectRoot = (ctx as { cwd?: string }).cwd ?? scope.cwd
  if (!effectRoot)
    throw new EvidenceIncompleteError("verification: refusing invocation without cwd")
  const evidenceRoot = requireWorkspaceRoot(scope.cwd)
  const turnIndex =
    scope.getTurnIndex?.() ?? normalizeTurnIndex((ctx.state as { turnCount?: unknown })?.turnCount)
  const argsHash = hashArgs(input ?? {})
  const baseKey = scope.idempotencyKeyFor?.(tool.name, input)
  const idempotencyKey = baseKey === undefined ? undefined : buildIdempotencyKey(sessionId, baseKey)
  const runOnce = async (): Promise<unknown> => {
    const intent = await writer.writeIntent({
      sessionId,
      threadId,
      turnIndex,
      tool: tool.name,
      cwd: evidenceRoot,
      ...(scope.childOf ? { childOf: scope.childOf } : {}),
      args: input,
      // v7.41 (audit #1/#2): kirim KUNCI MENTAH ke writer. `persistEffectIntent`
      // menormalisasi (prefix + scrub) sekali di dalamnya — mengirim kunci yang
      // sudah dibangun di sini membuat `outcome.note` ber-prefix GANDA,
      // sehingga `findIdempotentInvocation` (yang mencari kunci hasil build
      // sekali) TAK pernah menemukan intent pending. Celah itu persis jalur
      // receipt-loss: efek committed + receipt tak durable → retry buta.
      // Receipt di bawah tetap memakai `idempotencyKey` (sudah final) agar
      // note-nya konsisten dengan lookup.
      ...(baseKey ? { idempotencyKey: baseKey, idempotencyScope: "session" as const } : {}),
    })
    if (!intent.durable) {
      throw new EvidenceIncompleteError(
        "verification: refusing execution without durable EffectIntent",
      )
    }
    if (isSignalAborted(ctx.signal)) {
      throw new EvidenceIncompleteError("verification: aborted before tool execution")
    }
    let result: unknown
    try {
      result = await tool.execute(input, ctx)
    } catch (error) {
      await writer.writeReceipt({
        sessionId,
        threadId,
        tool: tool.name,
        cwd: evidenceRoot,
        invocation: intent.invocation,
        intent: {
          id: intent.record.id,
          seq: intent.record.seq,
          tool: intent.record.tool,
          session: intent.record.session,
          ...(intent.record.invocationId ? { invocationId: intent.record.invocationId } : {}),
          ...(intent.record.argsHash ? { argsHash: intent.record.argsHash } : {}),
        },
        state: "failed",
        error,
        signalAborted: isSignalAborted(ctx.signal),
        ...(idempotencyKey ? { outcome: { note: idempotencyKey }, dedup: true } : {}),
      })
      throw error
    }
    const receipt = await writer.writeReceipt({
      sessionId,
      threadId,
      tool: tool.name,
      cwd: evidenceRoot,
      invocation: intent.invocation,
      intent: {
        id: intent.record.id,
        seq: intent.record.seq,
        tool: intent.record.tool,
        session: intent.record.session,
        ...(intent.record.invocationId ? { invocationId: intent.record.invocationId } : {}),
        ...(intent.record.argsHash ? { argsHash: intent.record.argsHash } : {}),
      },
      state: "committed",
      result,
      signalAborted: isSignalAborted(ctx.signal),
      ...(idempotencyKey ? { outcome: { note: idempotencyKey }, dedup: true } : {}),
    })
    // v7.33 fail-closed receipt: jangan buang sinyal non-durable. Efek sudah
    // committed di dunia nyata tetapi journal hanya menyimpan intent pending;
    // tanpa pemberitahuan eksplisit, recovery bisa mengira ini eksekusi baru dan
    // menjalankan ulang efeknya. Seam ini meneruskan fakta itu ke pemanggil.
    if (!receipt.durable) {
      await scope.onReceiptLoss?.({
        kind: "non-durable-receipt",
        tool: tool.name,
        invocationId: intent.invocation.value,
        state: "committed",
        loss: "persistence",
      })
    }
    // Observed return tetap dikembalikan; yang berubah adalah pemanggil kini
    // DIBERITAHU (bukan lagi `void`) bahwa bukti terminalnya tidak durable.
    return result
  }
  if (!idempotencyKey) return runOnce()
  const flightKey = `${evidenceRoot}::${idempotencyKey}`
  return runOncePerIdempotencyKey(flightKey, async () => {
    const duplicate = await findIdempotentInvocation({
      sessionId,
      cwd: evidenceRoot,
      idempotencyKey,
      argsHash,
    })
    if (duplicate.status !== "proceed") {
      throw new IdempotentDuplicateError(
        duplicate.status,
        duplicate.message ?? `duplicate idempotency key: refusing blind re-execution`,
      )
    }
    return runOnce()
  })
}

export interface FilesystemVerificationTarget {
  path: string
  expected?: "present" | "absent"
  expectedContent?: string
}

export interface FilesystemVerificationRequest {
  sessionId: string
  threadId?: string
  tool: string
  invocationId: string
  cwd: string
  expected: "present" | "absent"
  targets: FilesystemVerificationTarget[]
  childSessionId?: string
  observedAt?: number
}

type FilesystemObservation = "present" | "absent" | "unreadable"

interface FilesystemTargetObservation {
  observed: FilesystemObservation
  usable: boolean
  reason?: string
}

function observationReason(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException)?.code
  const detail = typeof code === "string" && code ? code : fallback
  return scrubSecrets(detail).slice(0, 120)
}

async function observeFilesystemTarget(
  root: string,
  target: FilesystemVerificationTarget,
): Promise<FilesystemTargetObservation> {
  const abs = resolve(root, target.path)
  const rel = relative(root, abs).replace(/\\/g, "/")
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { observed: "unreadable", usable: false, reason: "outside-workspace" }
  }
  let stat: Awaited<ReturnType<typeof safeStat>> | null
  try {
    stat = await safeStat(abs, root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { observed: "absent", usable: true }
    }
    return {
      observed: "unreadable",
      usable: false,
      reason: observationReason(error, "stat-unavailable"),
    }
  }
  if (!stat || stat.isDirectory()) {
    if (target.expectedContent !== undefined) {
      return { observed: "present", usable: false, reason: "directory-content-uncomparable" }
    }
    return { observed: "present", usable: true }
  }
  let content: string
  try {
    content = await safeReadFile(abs, root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { observed: "absent", usable: true }
    }
    return {
      observed: "unreadable",
      usable: false,
      reason: observationReason(error, "read-unavailable"),
    }
  }
  if (target.expectedContent !== undefined && content !== target.expectedContent) {
    return { observed: "present", usable: false, reason: "content-mismatch" }
  }
  return { observed: "present", usable: true }
}

/** Explicit filesystem read-back around checkpoint file-snapshot primitives. */
export async function verifyFilesystemEffect(
  input: FilesystemVerificationRequest,
): Promise<{ record: JournalRecord; durable: boolean; verdict: VerificationVerdict }> {
  const sessionId = asNonEmpty(input.sessionId, "sessionId")
  const invocationId = asNonEmpty(input.invocationId, "invocationId")
  const tool = asNonEmpty(input.tool, "tool")
  const root = requireWorkspaceRoot(input.cwd)
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("verification: refusing filesystem observation without targets")
  }
  if (input.expected !== "present" && input.expected !== "absent") {
    throw new Error("verification: refusing filesystem observation without expected state")
  }
  const observations = []
  for (const target of input.targets) {
    if (!target || typeof target.path !== "string" || !target.path) {
      throw new Error("verification: refusing filesystem observation without path")
    }
    observations.push({
      path: target.path,
      ...(await observeFilesystemTarget(root, { ...target, expected: input.expected })),
    })
  }
  const usable = observations.every((item) => item.usable)
  const observed = observations.map((item) => item.observed)
  const verdict: VerificationVerdict = !usable
    ? "inconclusive"
    : observed.every((state) => state === input.expected)
      ? input.expected
      : observed.every((state) => state !== input.expected)
        ? input.expected === "present"
          ? "absent"
          : "present"
        : "inconclusive"
  const reference = JSON.stringify({
    method: "filesystem-read-back",
    expected: input.expected,
    observations: observations.map((item) => ({
      path: item.path,
      observed: item.observed,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  })
  const result = await recordExternalVerification({
    sessionId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    tool,
    invocationId,
    method: "filesystem-read-back",
    verdict,
    evidenceReference: reference,
    cwd: root,
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(typeof input.observedAt === "number" ? { observedAt: input.observedAt } : {}),
  })
  return { record: result.record, durable: result.durable, verdict }
}

/** Read-only commit observation using hardened git plumbing. */
export async function observeGitCommit(
  cwd: string,
  sha: unknown,
): Promise<"present" | "absent" | "inconclusive"> {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error("verification: refusing git observation without commit SHA")
  }
  const root = requireWorkspaceRoot(cwd)
  let repo = false
  try {
    repo = await isGitRepo(root)
  } catch {
    return "inconclusive"
  }
  if (!repo) return "inconclusive"
  try {
    const result = spawnSync(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, "cat-file", "-e", `${sha}^{commit}`],
      {
        cwd: root,
        encoding: "utf8",
        timeout: GIT_OBSERVE_TIMEOUT_MS,
      },
    )
    if (result.status === 0) return "present"
    if (typeof result.status === "number") return "absent"
    return "inconclusive"
  } catch {
    return "inconclusive"
  }
}

/** Write a git-state VerificationRecord for an already-observed commit. */
export async function verifyGitCommit(input: {
  sessionId: string
  threadId?: string
  tool: string
  invocationId: string
  cwd: string
  sha: string
  childSessionId?: string
  observedAt?: number
}): Promise<{ record: JournalRecord; durable: boolean; verdict: VerificationVerdict }> {
  const observation = await observeGitCommit(input.cwd, input.sha)
  const verdict: VerificationVerdict =
    observation === "present" ? "present" : observation === "absent" ? "absent" : "inconclusive"
  const result = await recordExternalVerification({
    sessionId: input.sessionId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    tool: input.tool,
    invocationId: input.invocationId,
    method: "git-state",
    verdict,
    evidenceReference: `git-state:commit:${input.sha}:${observation}`,
    cwd: input.cwd,
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(typeof input.observedAt === "number" ? { observedAt: input.observedAt } : {}),
  })
  return { record: result.record, durable: result.durable, verdict }
}

/** Map an actually executed verifier outcome (never model prose) to a verdict. */
function mapVerifierOutcome(result: VerifyResult): VerificationVerdict {
  return result.ok ? "present" : "inconclusive"
}

/** Record an executed existing-verifier outcome for one invocation. */
export async function recordVerifierOutcome(input: {
  sessionId: string
  threadId?: string
  tool: string
  invocationId: string
  cwd: string
  result: VerifyResult
  childSessionId?: string
  observedAt?: number
}): Promise<{ record: JournalRecord; durable: boolean; verdict: VerificationVerdict }> {
  const command = scrubSecrets(String(input.result.command ?? "")).slice(0, MAX_ID)
  if (!command) throw new Error("verification: refusing verifier record without command")
  const verdict = mapVerifierOutcome(input.result)
  const result = await recordExternalVerification({
    sessionId: input.sessionId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    tool: input.tool,
    invocationId: input.invocationId,
    method: "existing-verifier",
    verdict,
    evidenceReference: `existing-verifier:${command}:${input.result.ok ? "passed" : "failed"}`,
    cwd: input.cwd,
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(typeof input.observedAt === "number" ? { observedAt: input.observedAt } : {}),
  })
  return { record: result.record, durable: result.durable, verdict }
}

export interface ExternalVerificationRequest {
  sessionId: string
  threadId?: string
  tool: string
  invocationId: string
  method: VerificationMethod
  verdict: VerificationVerdict
  evidenceReference: string
  observedAt?: number
  cwd: string
  childOf?: string
  childSessionId?: string
  providerToolCallId?: string
}

/**
 * Record an explicit external observation. Only approved methods are accepted;
 * untrusted prose and unrelated lifecycle, observation, authorization, or
 * watermark authorities are rejected before any write. The referenced
 * invocation must already have durable intent.
 */
export async function recordExternalVerification(
  input: ExternalVerificationRequest,
): Promise<{ record: JournalRecord; durable: boolean }> {
  const sessionId = asNonEmpty(input.sessionId, "sessionId")
  const tool = asNonEmpty(input.tool, "tool")
  const invocationId = asNonEmpty(input.invocationId, "invocationId")
  if (!isVerificationMethod(input.method)) {
    throw new Error(`verification: unsupported method ${String(input.method)}`)
  }
  if (
    input.verdict !== "present" &&
    input.verdict !== "absent" &&
    input.verdict !== "inconclusive"
  ) {
    throw new Error(`verification: unsupported verdict ${String(input.verdict)}`)
  }
  const root = requireWorkspaceRoot(input.cwd)
  const loaded = await loadJournal(sessionId, root)
  if (loaded.status === "unreadable") {
    throw new EvidenceIncompleteError(
      "verification: refusing observation while intent is unreadable",
    )
  }
  const intent = loaded.records.some(
    (record) =>
      (!record.kind || record.kind === "mutation") && record.invocationId === invocationId,
  )
  if (!intent) {
    throw new EvidenceIncompleteError("verification: refusing observation without durable intent")
  }
  return appendVerificationRecord({
    session: sessionId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    tool,
    invocationId,
    method: input.method,
    verdict: input.verdict,
    evidenceReference: input.evidenceReference,
    ...(typeof input.observedAt === "number" ? { observedAt: input.observedAt } : {}),
    cwd: root,
    ...(input.childOf ? { childOf: input.childOf } : {}),
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
  })
}

export interface ChildLineage {
  parentSessionId: string
  childSessionId: string
}

export interface ChildEffectRequest {
  parentSessionId: string
  childSessionId: string
  childInvocationId: string
  cwd: string
  lineage: ChildLineage[]
}

export interface ChildEffectCorrelation {
  parentDelegation: ChildDelegationStatus
  childJournal: ChildJournalStatus
  childVerification: ChildVerificationStatus
  conclusion: VerificationVerdict | "unknown"
  evidence: {
    parentIntentId?: string
    parentTerminalId?: string
    childIntentId?: string
    childTerminalId?: string
    childVerificationId?: string
  }
}

function latestBySeq<T extends { seq: number }>(records: T[]): T | undefined {
  let latest: T | undefined
  for (const record of records) {
    if (!latest || record.seq >= latest.seq) latest = record
  }
  return latest
}

/**
 * Correlate parent delegation with child-journal evidence. Delegation text is
 * not consulted. Only an explicit child VerificationRecord can move the
 * conclusion away from unknown.
 */
export async function correlateChildEffect(
  input: ChildEffectRequest,
): Promise<ChildEffectCorrelation> {
  const parentSessionId = asNonEmpty(input.parentSessionId, "parentSessionId")
  const childSessionId = asNonEmpty(input.childSessionId, "childSessionId")
  const childInvocationId = asNonEmpty(input.childInvocationId, "childInvocationId")
  const root = requireWorkspaceRoot(input.cwd)
  const linked = (input.lineage ?? []).some(
    (entry) =>
      entry?.parentSessionId === parentSessionId && entry?.childSessionId === childSessionId,
  )
  if (!linked) {
    return {
      parentDelegation: "absent",
      childJournal: "absent",
      childVerification: "absent-record",
      conclusion: "unknown",
      evidence: {},
    }
  }
  const parent = await loadJournal(parentSessionId, root)
  const parentIntents = parent.records.filter(
    (record) =>
      (!record.kind || record.kind === "mutation") &&
      record.tool === "delegate_task" &&
      record.childSessionId === childSessionId,
  )
  const parentTerminal = latestBySeq(
    parentIntents.filter((record) => record.state === "committed" || record.state === "failed"),
  )
  const parentDelegation: ChildDelegationStatus = parentTerminal
    ? parentTerminal.state === "committed"
      ? "committed"
      : "failed"
    : parentIntents.length > 0
      ? "pending"
      : "absent"
  if (parentDelegation !== "committed") {
    return {
      parentDelegation,
      childJournal: "absent",
      childVerification: "absent-record",
      conclusion: "unknown",
      evidence: {
        ...(parentIntents[0] ? { parentIntentId: parentIntents[0].id } : {}),
        ...(parentTerminal ? { parentTerminalId: parentTerminal.id } : {}),
      },
    }
  }
  const child = await loadJournal(childSessionId, root)
  const childIntents = child.records.filter(
    (record) =>
      (!record.kind || record.kind === "mutation") &&
      record.invocationId === childInvocationId &&
      record.session === childSessionId,
  )
  if (childIntents.length === 0) {
    return {
      parentDelegation,
      childJournal: "absent",
      childVerification: "absent-record",
      conclusion: "unknown",
      evidence: {
        ...(parentTerminal ? { parentTerminalId: parentTerminal.id } : {}),
      },
    }
  }
  const childTerminal = latestBySeq(
    childIntents.filter((record) => record.state === "committed" || record.state === "failed"),
  )
  const childJournal: ChildJournalStatus = childTerminal
    ? childTerminal.state === "committed"
      ? "committed"
      : "failed"
    : "pending"
  const verification = latestBySeq(
    child.records.filter(
      (record) => record.kind === "verification" && record.invocationId === childInvocationId,
    ),
  )
  const childVerification: ChildVerificationStatus = verification
    ? (verification.verdict ?? "inconclusive")
    : "absent-record"
  const conclusion =
    childVerification === "present" || childVerification === "absent"
      ? childVerification
      : "unknown"
  return {
    parentDelegation,
    childJournal,
    childVerification,
    conclusion,
    evidence: {
      ...(parentTerminal ? { parentTerminalId: parentTerminal.id } : {}),
      ...(childIntents[0] ? { childIntentId: childIntents[0].id } : {}),
      ...(childTerminal ? { childTerminalId: childTerminal.id } : {}),
      ...(verification ? { childVerificationId: verification.id } : {}),
    },
  }
}

// ── [Fase 3 / LOOP-INV-12, LOOP-G21] Tier 1 Workspace Integrity Check ──────
//
// Pemeriksaan deterministik & instan (tanpa spawn proses eksternal) sebelum
// task diizinkan mengunci status terminal `COMPLETED`:
//   1. File yang tercatat dimutasi (write_file/edit/apply_patch/move_file)
//      tidak boleh hilang diam-diam di disk.
//   2. File teks yang dimutasi tidak boleh menyisakan penanda konflik Git
//      yang belum diselesaikan (`<<<<<<< `, `=======`, `>>>>>>> ` di awal baris).

export interface WorkspaceIntegrityIssue {
  readonly path: string
  readonly reason:
    | "missing-written-file"
    | "unresolved-conflict-marker"
    | "integrity-check-unavailable"
  readonly line?: number
  readonly detail: string
}

export interface WorkspaceIntegrityReport {
  readonly ok: boolean
  readonly checkedFiles: readonly string[]
  readonly issues: readonly WorkspaceIntegrityIssue[]
  readonly summary: string
}

const INTEGRITY_MAX_BYTES = 8 * 1024 * 1024
const CONFLICT_START_RE = /^<{7}(?: |$)/
const CONFLICT_END_RE = /^>{7}(?: |$)/

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

async function addIntegrityReadIssue(
  issues: WorkspaceIntegrityIssue[],
  abs: string,
  rel: string,
  error: unknown,
  operation: "stat" | "read",
): Promise<void> {
  // Sebagian filesystem/adapter Windows membungkus error open dan tidak
  // meneruskan code ENOENT. Probe lstat membedakan file yang memang hilang
  // dari target yang ada tetapi tak dapat diperiksa secara aman.
  let missing = isMissingPathError(error)
  if (!missing) {
    try {
      await lstat(abs)
    } catch (probeError) {
      missing = isMissingPathError(probeError)
    }
  }
  issues.push(
    missing
      ? {
          path: rel,
          reason: "missing-written-file",
          detail: `expected written file '${rel}' is missing on disk`,
        }
      : {
          path: rel,
          reason: "integrity-check-unavailable",
          detail: `could not securely ${operation} expected written file '${rel}'`,
        },
  )
}

function findConflictMarkerLine(text: string): number | null {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (CONFLICT_START_RE.test(line) || CONFLICT_END_RE.test(line)) {
      return i + 1
    }
  }
  // `=======` sendirian lazim sebagai setext heading Markdown, jadi hanya
  // dianggap conflict marker bila disertai `<<<<<<<` / `>>>>>>>` (yang sudah
  // tertangkap di atas). Menjaga nol false-positive pada dokumentasi `.md`.
  return null
}

export async function checkWorkspaceIntegrity(
  modifiedFiles: readonly string[],
  workspaceRoot: string,
): Promise<WorkspaceIntegrityReport> {
  const root = resolve(workspaceRoot)
  const checkedFiles: string[] = []
  const issues: WorkspaceIntegrityIssue[] = []
  const seen = new Set<string>()

  for (const rawPath of modifiedFiles) {
    if (typeof rawPath !== "string" || !rawPath.trim()) continue
    const abs = resolve(root, rawPath)
    const rel = relative(root, abs).replace(/\\/g, "/")
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue
    if (seen.has(rel)) continue
    seen.add(rel)
    checkedFiles.push(rel)

    let st: Awaited<ReturnType<typeof safeStat>> | null = null
    try {
      st = await safeStat(abs, root)
    } catch (err) {
      await addIntegrityReadIssue(issues, abs, rel, err, "stat")
      continue
    }
    if (!st.isFile() || st.size > INTEGRITY_MAX_BYTES) {
      issues.push({
        path: rel,
        reason: "integrity-check-unavailable",
        detail: !st.isFile()
          ? `expected written path '${rel}' is not a regular file`
          : `expected written file '${rel}' exceeds the integrity scan limit`,
      })
      continue
    }

    let contentText: string
    try {
      contentText = await safeReadFile(abs, root)
    } catch (err) {
      await addIntegrityReadIssue(issues, abs, rel, err, "read")
      continue
    }
    // Lewati file biner (ada karakter NUL pada 8 KiB pertama).
    const probeLen = Math.min(contentText.length, 8192)
    let binary = false
    for (let i = 0; i < probeLen; i++) {
      if (contentText.charCodeAt(i) === 0) {
        binary = true
        break
      }
    }
    if (binary) continue

    const markerLine = findConflictMarkerLine(contentText)
    if (markerLine !== null) {
      issues.push({
        path: rel,
        reason: "unresolved-conflict-marker",
        line: markerLine,
        detail: `unresolved Git conflict marker in '${rel}' at line ${markerLine}`,
      })
    }
  }

  if (issues.length === 0) {
    return {
      ok: true,
      checkedFiles,
      issues: [],
      summary: "workspace integrity ok",
    }
  }
  const first = issues[0]!
  const suffix = issues.length > 1 ? ` (+${issues.length - 1} more)` : ""
  return {
    ok: false,
    checkedFiles,
    issues,
    summary: `workspace integrity failed: ${first.detail}${suffix}`,
  }
}

// ── [Fase 6A / ACE-02] Anti-Reward-Hacking Tamper Guard ──────────────────────
// Tolak klaim selesai bila permukaan evaluator/gate/test dimanipulasi selama sesi
// (fail-closed terhadap `HEAD` / baseline pra-sesi).

export interface EvaluationTamperingReport {
  readonly tampered: boolean
  readonly reason: string
  readonly offendingFiles: readonly string[]
}

export interface EvaluationTamperingOptions {
  /** Operator/agen eksplisit diizinkan mengubah test (mis. task "perbaiki test"). */
  readonly allowTestModification?: boolean
  /** Baseline isi file sebelum sesi; bila absen, `git show HEAD:` dipakai. */
  readonly baselineContentByFile?: ReadonlyMap<string, string>
}

const EVALUATOR_GATE_FILES = new Set([
  "bench/eval-gate.ts",
  "bench/harness-audit.ts",
  "scripts/telemetry-gate.ts",
  "scripts/coverage-gate.ts",
  "scripts/pack-budget.ts",
  "tsconfig.json",
  "biome.json",
])
const SKIP_TODO_RE = /\.(?:skip|skipIf|only|todo|fails)\s*\(/g
const ASSERTION_CALL_RE = /\b(?:expect|assert(?:\.[A-Za-z_]+)?)\s*\(/g
const TAUTOLOGY_RE =
  /\bexpect\s*\(\s*(?:true|false|1|0|"[^"]*"|'[^']*')\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*(?:true|false|1|0|"[^"]*"|'[^']*')\s*\)/g
const EVALUATION_SCAN_ROOTS = [
  "test",
  "bench",
  "scripts",
  "package.json",
  "tsconfig.json",
  "biome.json",
  ".github",
] as const

/** Baseline status git pra-sesi per (root::sessionId) agar edit user sebelum sesi tak jadi false-positive. */
const SESSION_BASELINE_MAX_ENTRIES = 256
const SESSION_BASELINE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * BUG-8: cache baseline tanpa eviksi tumbuh sepanjang hidup proses (satu entri
 * per sesi yang pernah di-verify). Sekarang berupa LRU + TTL: entri terakhir
 * dipakai dipindah ke belakang `Map`, dan entri tertua dibuang saat penuh atau
 * kedaluwarsa.
 *
 * `GIT_FAILED` adalah sentinel berbeda dari "baseline memang tidak ada":
 * bila `git status` gagal saat capture, baseline TIDAK bisa dipercaya, jadi
 * jangan menandai seluruh path kotor sebagai tamper (false-tamper).
 */
const GIT_FAILED = Symbol("evaluation-baseline-git-failed")
type SessionBaseline = Map<string, string> | typeof GIT_FAILED

const sessionEvaluationBaselines = new Map<string, { value: SessionBaseline; at: number }>()

function sessionBaselineKey(sessionId: string, workspaceRoot: string): string {
  return `${resolve(workspaceRoot)}::${sessionId}`
}

function getSessionBaseline(key: string): SessionBaseline | undefined {
  const hit = sessionEvaluationBaselines.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > SESSION_BASELINE_TTL_MS) {
    sessionEvaluationBaselines.delete(key)
    return undefined
  }
  // Sentuh ulang untuk LRU (Map.insertion-order).
  sessionEvaluationBaselines.delete(key)
  sessionEvaluationBaselines.set(key, hit)
  return hit.value
}

function setSessionBaseline(key: string, value: SessionBaseline): void {
  sessionEvaluationBaselines.delete(key)
  sessionEvaluationBaselines.set(key, { value, at: Date.now() })
  while (sessionEvaluationBaselines.size > SESSION_BASELINE_MAX_ENTRIES) {
    const oldest = sessionEvaluationBaselines.keys().next().value
    if (oldest === undefined) break
    sessionEvaluationBaselines.delete(oldest)
  }
}

/** Seam uji: jumlah entri baseline yang masih hidup (untuk assertion eviksi). */
export function __sessionBaselineCacheSizeForTest(): number {
  return sessionEvaluationBaselines.size
}

/** Seam uji: kosongkan cache baseline (uji hermetik). */
export function __clearSessionBaselineCacheForTest(): void {
  sessionEvaluationBaselines.clear()
}

function isProtectedEvaluatorSurface(rel: string): boolean {
  return EVALUATOR_GATE_FILES.has(rel) || rel.startsWith(".github/workflows/")
}

function countSkipTodo(text: string): number {
  return (text.match(SKIP_TODO_RE) ?? []).length
}

function countAssertions(text: string): number {
  return (text.match(ASSERTION_CALL_RE) ?? []).length
}

function countTautologies(text: string): number {
  return (text.match(TAUTOLOGY_RE) ?? []).length
}

/**
 * Sama seperti `listDirtyEvaluationPaths`, tapi membedakan "git sukses, tak ada
 * path kotor" dari "git gagal / bukan repo". Keduanya dulu mengembalikan `[]`
 * yang tak terbedakan → baseline kosong dianggap sah dan semua path kotor kena
 * tamper. Sekarang `ok: false` dipertahankan sampai ke baseline.
 */
/** Seam uji: simulasi git gagal vs git sukses tanpa mengubah environment. */
type DirtyScan = (root: string) => { ok: boolean; paths: string[] }
let dirtyScanOverride: DirtyScan | null = null
export function __setEvaluationDirtyScanForTest(fn: DirtyScan | null): void {
  dirtyScanOverride = fn
}

function parseDirtyPorcelain(stdout: string): string[] {
  const out: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) continue
    let p = rawLine.slice(3).trim()
    const arrow = p.indexOf(" -> ")
    if (arrow !== -1) p = p.slice(arrow + 4).trim()
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1)
    }
    if (p) out.push(p.replace(/\\/g, "/"))
  }
  return out
}

function spawnGitStdoutAsync(
  root: string,
  gitArgs: readonly string[],
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ""
    let bytes = 0
    const finish = (ok: boolean, out = "") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok, stdout: out })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolveTrustedExecutable("git"), [...gitArgs], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        env: sanitizeSpawnEnv(process.env),
      })
    } catch {
      resolvePromise({ ok: false, stdout: "" })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(false)
    }, GIT_OBSERVE_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8")
      if (bytes > INTEGRITY_MAX_BYTES) {
        try {
          child.kill()
        } catch {}
        finish(false)
        return
      }
      stdout += chunk
    })
    child.on("error", () => finish(false))
    child.on("close", (code) => finish(code === 0, stdout))
  })
}

async function listDirtyEvaluationPathsAsync(
  root: string,
): Promise<{ ok: boolean; paths: string[] }> {
  if (dirtyScanOverride) return dirtyScanOverride(root)
  if (!isGitRepo(root)) return { ok: false, paths: [] }
  try {
    const neutral = gitFilterNeutralizersSync(root)
    const r = await spawnGitStdoutAsync(root, [
      ...GIT_SAFE_BASE,
      ...neutral,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...EVALUATION_SCAN_ROOTS,
    ])
    return r.ok ? { ok: true, paths: parseDirtyPorcelain(r.stdout) } : { ok: false, paths: [] }
  } catch {
    return { ok: false, paths: [] }
  }
}

async function hashWorkspaceRel(root: string, rel: string): Promise<string> {
  try {
    const raw = await safeReadFile(resolve(root, rel), root)
    return createHash("sha256").update(raw, "utf8").digest("hex")
  } catch {
    return "MISSING"
  }
}

/**
 * Rekam sidik jari permukaan evaluator/test yang sudah kotor SEBELUM sesi
 * dimulai, sehingga perubahan lokal sah milik developer tidak memicu false-positive
 * EVALUATOR_TAMPER_ATTEMPT saat `--verify` berjalan.
 */
export async function captureSessionEvaluationBaseline(
  sessionId: string,
  workspaceRoot: string,
): Promise<void> {
  const root = resolve(workspaceRoot)
  const key = sessionBaselineKey(sessionId, root)
  const scanned = await listDirtyEvaluationPathsAsync(root)
  // Fail-closed JUJUR: git gagal → jangan simpan baseline kosong yang nanti
  // membuat semua path kotor tampak "berubah dari baseline".
  if (!scanned.ok) {
    setSessionBaseline(key, GIT_FAILED)
    return
  }
  const hashed = await Promise.all(
    scanned.paths.map(async (rel) => [rel, await hashWorkspaceRel(root, rel)] as const),
  )
  const baseline = new Map<string, string>(hashed)
  setSessionBaseline(key, baseline)
}

/**
 * v7.35 (atribusi tamper sadar-sesi): tool yang MAMPU memutasi file workspace.
 * Dipakai untuk memutus apakah path "kotor" di git boleh diatribusikan ke sesi ini.
 * Sengaja konservatif (fail-closed): bila ragu, anggap mutating agar deteksi
 * tampering tetap berjalan penuh. Sesi yang hanya menjalankan tool baca tidak
 * boleh divonis `EVALUATOR_TAMPER_ATTEMPT` gara-gara proses/sesi LAIN mengubah
 * file yang memang sudah kotor sejak awal sesi.
 */
// Derivasikan mutasi file dari sumber kebenaran WRITE_TOOLS plus shell/code_run
// agar tool tulis baru (lsp_rename, git_restore, git_checkout) otomatis tercakup.
const WORKSPACE_MUTATING_TOOLS = new Set<string>([...WRITE_TOOLS, "bash", "code_run"])

/**
 * Kumpulkan SEMUA file dimutasi milik sesi ini — menggabungkan jurnal induk,
 * jurnal seluruh child sub-agent (`delegate_task`), dan perubahan in-session pada
 * permukaan evaluator/test melalui `bash`/`code_run` (terdeteksi lewat git status).
 *
 * v7.35: fallback git-status HANYA dipakai bila sesi (atau child-nya) benar-benar
 * menjalankan tool mutating. Koleksi berbasis jurnal (langkah a) tetap selalu aktif.
 */
export async function collectSessionModifiedFiles(
  sessionId: string,
  workspaceRoot: string,
  parentRecords?: readonly JournalRecord[],
): Promise<string[]> {
  const root = resolve(workspaceRoot)
  let records = parentRecords
  if (!records) {
    const loaded = await loadJournal(sessionId, root).catch(() => null)
    if (loaded?.status === "valid") records = loaded.records
  }
  const combined = new Set<string>(records ? collectModifiedFilesFromJournal(records) : [])
  const allRecords: JournalRecord[] = records ? [...records] : []
  if (records) {
    const childIds = new Set<string>()
    for (const r of records) {
      if (r.tool === "delegate_task" && typeof r.childSessionId === "string" && r.childSessionId) {
        childIds.add(r.childSessionId)
      }
    }
    const childLoads = await Promise.all(
      [...childIds].slice(0, 20).map((cid) => loadJournal(cid, root).catch(() => null)),
    )
    for (const childLoaded of childLoads) {
      if (childLoaded?.status === "valid") {
        allRecords.push(...childLoaded.records)
        for (const p of collectModifiedFilesFromJournal(childLoaded.records)) {
          combined.add(p)
        }
      }
    }
  }

  // v7.35: kumpulkan tool mutating dari induk + seluruh child. Path kotor tanpa
  // satu pun tool mutating tak punya sebab sebab-akibat dengan sesi ini → jangan
  // disalahatribusikan. Koleksi jurnal di atas tetap dipertahankan apa adanya.
  const sessionMutatingTools = new Set<string>()
  for (const r of allRecords) {
    if (WORKSPACE_MUTATING_TOOLS.has(r.tool)) sessionMutatingTools.add(r.tool)
  }

  if (sessionMutatingTools.size > 0) {
    const { paths: dirtyPaths } = await listDirtyEvaluationPathsAsync(root)
    if (dirtyPaths.length > 0) {
      const baseline = getSessionBaseline(sessionBaselineKey(sessionId, root))
      if (baseline !== GIT_FAILED) {
        if (!baseline) {
          // Baseline memang tidak ada (capture tak pernah dipanggil) →
          // fail-closed tetap berlaku: anggap path berubah.
          for (const rel of dirtyPaths) combined.add(rel)
        } else {
          const hashed = await Promise.all(
            dirtyPaths.map(async (rel) => [rel, await hashWorkspaceRel(root, rel)] as const),
          )
          for (const [rel, nowHash] of hashed) {
            const prevHash = baseline.get(rel)
            if (prevHash === undefined || prevHash !== nowHash) {
              combined.add(rel)
            }
          }
        }
      }
    }
  }
  return [...combined]
}

function verificationScriptsFingerprint(text: string): string | null {
  try {
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const parsed = JSON.parse(clean) as { scripts?: Record<string, unknown> }
    const scripts = parsed.scripts ?? {}
    return Object.keys(scripts)
      .filter((k) => /^(?:test|verify|lint|check|gate|eval)/i.test(k))
      .sort()
      .map((k) => `${k}=${String(scripts[k])}`)
      .join("\n")
  } catch {
    return null
  }
}

function gitBaselineContent(root: string, rel: string): string | null {
  try {
    const result = spawnSync(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, "show", `HEAD:${rel}`],
      {
        cwd: root,
        encoding: "utf8",
        timeout: GIT_OBSERVE_TIMEOUT_MS,
        maxBuffer: INTEGRITY_MAX_BYTES,
        env: sanitizeSpawnEnv(process.env),
      },
    )
    return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null
  } catch {
    return null
  }
}

/**
 * Deteksi manipulasi evaluator pada file yang dimutasi sesi ini.
 * Deterministik: hanya membaca file/baseline; tidak menulis apa pun.
 */
export async function detectEvaluationTampering(
  modifiedFiles: readonly string[],
  workspaceRoot: string,
  opts: EvaluationTamperingOptions = {},
): Promise<EvaluationTamperingReport> {
  if (opts.allowTestModification === true) {
    return { tampered: false, reason: "test modification explicitly allowed", offendingFiles: [] }
  }

  const root = resolve(workspaceRoot)
  const offending: string[] = []
  const seen = new Set<string>()

  for (const rawPath of modifiedFiles) {
    if (typeof rawPath !== "string" || !rawPath.trim()) continue
    const abs = resolve(root, rawPath)
    const rel = relative(root, abs).replace(/\\/g, "/")
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || seen.has(rel)) continue
    seen.add(rel)

    // 1. Skrip gate/evaluator kritis & workflow CI tidak boleh berubah sama sekali.
    if (isProtectedEvaluatorSurface(rel)) {
      offending.push(rel)
      continue
    }

    // 2. `package.json`: hanya bagian script test/verify/lint/gate yang relevan.
    if (rel === "package.json") {
      let current: string
      try {
        current = await safeReadFile(abs, root)
      } catch {
        continue // file terhapus: bukan manipulasi script.
      }
      const baselineText = opts.baselineContentByFile?.get(rel) ?? gitBaselineContent(root, rel)
      if (baselineText == null) {
        // Tanpa baseline bentuk script tak bisa dibuktikan → fail-closed.
        offending.push(rel)
        continue
      }
      const before = verificationScriptsFingerprint(baselineText)
      const after = verificationScriptsFingerprint(current)
      if (before === null || after === null || before !== after) offending.push(rel)
      continue
    }

    // 3. Berkas test & helper (`test/**/*.ts`): deteksi .skip/.todo baru,
    // penghapusan assertion (`expect`/`assert`), atau assertion tautologi.
    if (rel.startsWith("test/") && rel.endsWith(".ts")) {
      let current: string
      try {
        current = await safeReadFile(abs, root)
      } catch {
        continue
      }
      const baselineText = opts.baselineContentByFile?.get(rel) ?? gitBaselineContent(root, rel)
      const beforeSkip = baselineText == null ? 0 : countSkipTodo(baselineText)
      const beforeAsserts = baselineText == null ? 0 : countAssertions(baselineText)
      const beforeTaut = baselineText == null ? 0 : countTautologies(baselineText)
      const skipAdded = countSkipTodo(current) > beforeSkip
      const assertsDropped = beforeAsserts > 0 && countAssertions(current) < beforeAsserts
      const tautologyAdded = countTautologies(current) > beforeTaut
      if (skipAdded || assertsDropped || tautologyAdded) offending.push(rel)
    }
  }

  if (offending.length === 0) {
    return { tampered: false, reason: "evaluation surface unchanged", offendingFiles: [] }
  }
  return {
    tampered: true,
    reason: `evaluation tampering: modified evaluator/test surfaces [${offending.join(", ")}]`,
    offendingFiles: offending,
  }
}

/**
 * Kumpulkan daftar file yang terakhir dimutasi secara committed dalam jurnal
 * sesi (mengikuti write/edit/apply_patch, move_file, dan menghapus file yang
 * memang dihapus lewat delete_file). Record sintetis `pending` tanpa terminal
 * committed diabaikan agar tidak menimbulkan klaim palsu.
 */
export function collectModifiedFilesFromJournal(records: readonly JournalRecord[]): string[] {
  const byId = new Map<string, JournalRecord[]>()
  for (const r of records) {
    if (r.kind && r.kind !== "mutation") continue
    const list = byId.get(r.id) ?? []
    list.push(r)
    byId.set(r.id, list)
  }
  const ordered = [...byId.values()].sort((a, b) => a[0]!.seq - b[0]!.seq)
  const active = new Set<string>()
  for (const group of ordered) {
    const intent = group[0]!
    const committed = group.some((r) => r.state === "committed")
    if (!committed) continue
    const paths = intent.paths ?? []
    if (paths.length === 0) continue
    if (intent.tool === "write_file" || intent.tool === "edit" || intent.tool === "apply_patch") {
      for (const p of paths) active.add(p)
    } else if (intent.tool === "delete_file") {
      for (const p of paths) active.delete(p)
    } else if (intent.tool === "move_file") {
      if (paths[0]) active.delete(paths[0])
      if (paths[1]) active.add(paths[1])
    }
  }
  return [...active]
}
