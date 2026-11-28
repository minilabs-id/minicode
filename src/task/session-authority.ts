// PHASE 6X — SESSION-LEVEL AUTONOMOUS EXECUTION AUTHORITY.
//
// Implements 6W ADR-20/ADR-21. This is a CLAIM ON THE RIGHT TO SCHEDULE, not a
// claim on a task and not a proof of liveness.
//
// ── WHAT IT IS ───────────────────────────────────────────────────────────────
//
// A durable record: (session, incarnation) -> (owner token, lease expiry).
// Exactly one Scheduler may hold it at a time. A second process that tries to
// acquire while the lease is valid FAILS CLOSED, which removes the precondition
// for FINDING-02: F02 required two reconcilers to coexist, and this prevents
// that outright.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
//
// It is NOT a liveness proof. An expired lease does not prove a process died; it
// proves only that nobody renewed in time. A process that is alive but stalled
// past the lease will lose authority — and 6W chose that direction deliberately,
// because at session granularity a wrong answer costs WASTED WORK, while at task
// granularity (the status quo) it costs DUPLICATE EXECUTION.
//
// It is NOT a replacement for lineage. `exec_generation` / `attempt_generation`
// still answer "what happened to this execution"; the lease answers "who may
// schedule for this session". The two layers never read each other.

import { LIMITS } from "../constants.ts"
import { SUB_AGENT_TIMEOUT_MIN_MS } from "../policy/subagent-timeout.ts"

/**
 * How long an acquired lease remains valid.
 *
 * [DESIGN DECISION] Lease DITURUNKAN dari timeout sub-agent, bukan angka lepas.
 * Awalnya 300_000 = 2.5 × 120_000. Saat timeout dinaikkan ke 300_000, lease harus
 * ikut naik (2.5 × 300_000 = 750_000) atau proses yang masih hidup tapi lambat
 * akan kehilangan otoritas di tengah turn yang sah — false positive yang justru
 * ingin dicegah oleh Phase 6X. Memakai konstanta yang SAMA mencegah dua angka
 * drift diam-diam.
 *
 * v7.40 (audit): env `MINICODE_SUB_AGENT_TIMEOUT_MS` dibatasi [1, JS_TIMER_MAX],
 * jadi bisa jadi 1_000 ms → lease 2_500 ms. Sementara itu
 * `resolveSubAgentTimeout` meng-clamp timeout anak ke lantai absolut
 * `SUB_AGENT_TIMEOUT_MIN_MS` (30 dtk) — anak masih sah berjalan 30 dtk, tetapi
 * lease sudah kedaluwarsa di tengah turn (false-positive takeover).
 * Lantai yang SAMA dipakai di sini: basis = max(env, 30 dtk), sehingga lease
 * selalu ≥ 2.5 × pagu anak. Default 300_000 → 750_000 TIDAK berubah.
 */
const LEASE_BASE_MS = Math.max(LIMITS.SUB_AGENT_TIMEOUT_MS, SUB_AGENT_TIMEOUT_MIN_MS)
export const SESSION_LEASE_MS = Math.ceil(LEASE_BASE_MS * 2.5)

/** How often a live owner refreshes it. Five renewals per lease. */
// v7.31: diturunkan dari lease supaya env timeout kecil (< ~24 dtk) tak
// membuat owner kehilangan authority sebelum renew pertama.
export const SESSION_RENEW_INTERVAL_MS = Math.min(
  60_000,
  Math.max(1, Math.floor(SESSION_LEASE_MS / 5)),
)

/**
 * [PHASE 6X] Lease constants are DERIVED, not chosen.
 *
 * `FACT` The runtime's own limits, read from `src/constants.ts` and
 * `autonomous-context.ts`:
 *
 *   BASH_DEFAULT_TIMEOUT_MS   30_000  longest single tool call
 *   SUB_AGENT_TIMEOUT_MS    300_000  longest single sub-agent turn (env-overridable)
 *   autonomous turn default 300_000  `timeoutMs ?? LIMITS.SUB_AGENT_TIMEOUT_MS`
 *
 * `INFERENCE` The longest interval in which a legitimately running execution can
 * go without making observable progress is bounded by the turn timeout, not by
 * how fast the model happens to be today. A lease shorter than that would lapse
 * during an ordinary slow call — which is precisely the false positive 6W chose
 * to eliminate.
 *
 * `DESIGN DECISION` lease = 2.5x the sub-agent turn bound (now 300_000 ms →
 * 750_000 ms). A live process therefore retains authority across a stalled event
 * loop well beyond one turn. Renewal every 60_000 ms still gives many chances
 * inside one lease, so a single missed tick is not fatal.
 *
 * `INFERENCE` Lease is now DERIVED from `LIMITS.SUB_AGENT_TIMEOUT_MS`, which is
 * itself env-overridable. Raising the timeout automatically keeps the lease at
 * 2.5x — the two can no longer drift apart silently.
 */

/**
 * [PHASE 6X] Expiry boundary, stated once so no comparison is left to chance.
 *
 * A lease is ACTIVE while `lease_expires_at > now`, and EXPIRED when
 * `lease_expires_at <= now`.
 *
 * `DESIGN DECISION` Expired-at-exactly-`now` counts as EXPIRED. Using `<=` on
 * the acquirer's side means an expiring lease is immediately available, and the
 * alternative (`<`) would let a lease whose deadline has passed keep blocking a
 * takeover for one more clock tick — a needless availability loss with no safety
 * gain, since the previous owner is by definition no longer renewing.
 */
export function isLeaseActive(expiresAt: number, now: number): boolean {
  return expiresAt > now
}

let counter = 0

/**
 * [PHASE 6X] A fresh owner token.
 *
 * `DESIGN DECISION` NOT a PID and NOT an object identity. PIDs are reused and
 * object identity is meaningless in another process; the token is the only value
 * that distinguishes "me, still holding it" from "someone who took it after my
 * lease expired". It is unpredictable, so it cannot be guessed by another local
 * process, and it is regenerated on every acquisition — a restarted process can
 * never present its predecessor's token.
 */
export function newOwnerToken(): string {
  counter += 1
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  return `own-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`
}

/** The durable row. One per (session, incarnation). */
export interface SessionAuthority {
  readonly sessionId: string
  /** 6Q incarnation. Keying on it stops a recreated session inheriting a lease. */
  readonly incarnation: number
  readonly ownerToken: string
  readonly ownerPid: number
  readonly acquiredAt: number
  readonly leaseExpiresAt: number
}
