// Kepemilikan sesi process-local agar rekonsiliasi `IN_PROGRESS`/`VERIFYING`
// bekerja secara fail-closed (menolak jika sesi tidak dimiliki proses ini).
// Rekonsiliasi lintas-proses tidak didukung karena registry hanya hidup di memori proses.

/** Opaque identity of the in-process owner of a session. */
export type SessionOwner = { readonly token: symbol; readonly label: string }

export type ReleaseReason = "stopped" | "session-removed" | "replaced"

/**
 * One owner per session, per process.
 *
 * Module-level because ownership is a property of the PROCESS, not of any
 * TaskStore instance — two TaskStore instances over the same database in one
 * process must agree about who owns a session.
 *
 * It is the ONLY process-global state introduced by Phase 6B, and it holds
 * ownership only. It is not a task authority: it cannot read or write a task,
 * and every durable mutation still goes through TaskStore.
 */
const owners = new Map<string, SessionOwner>()

/**
 * Take ownership of `sessionId` for this process.
 *
 * A second acquisition of the same session is refused rather than silently
 * stealing, so a double-attach is visible instead of a silent last-writer-wins.
 */
export function acquireSessionOwnership(sessionId: string, label: string): SessionOwner | null {
  if (owners.has(sessionId)) return null
  const owner: SessionOwner = { token: Symbol(label), label }
  owners.set(sessionId, owner)
  return owner
}

/** True only when `owner` is the owner this process recorded for `sessionId`. */
export function ownsSession(sessionId: string, owner: SessionOwner | null | undefined): boolean {
  if (owner === null || owner === undefined) return false
  const current = owners.get(sessionId)
  return current !== undefined && current.token === owner.token
}

export function releaseSessionOwnership(
  sessionId: string,
  owner: SessionOwner,
  _reason: ReleaseReason = "stopped",
): boolean {
  if (!ownsSession(sessionId, owner)) return false
  owners.delete(sessionId)
  return true
}

/**
 * [PHASE 6U] Per-session invalidation subscribers.
 *
 * A `SessionOwner` knows it OWNS a session; it has no way to learn that the
 * session was deleted while it was not looking. 6Q closed that gap durably (the
 * incarnation check at claim and lineage-write time), which makes a late write
 * safe — but it cannot make a *live* autonomous turn stop, because nothing
 * interrupts a turn that is already running.
 *
 * [DESIGN DECISION] This is the SAME process-local, per-session authority, not a
 * second registry. Adding a map here is a smaller and more honest change than a
 * new "scheduler registry": the Scheduler already consults this module, and one
 * place should answer "who cares about this session in this process".
 *
 * [DESIGN DECISION] Process-local and therefore a best-effort OPTIMISATION, not a
 * correctness boundary. A deletion in another process reaches nothing here — and
 * must not need to: the incarnation check remains the authoritative barrier, and
 * this only makes the stop happen sooner when someone is present to signal it.
 * That asymmetry is the point; a subscriber that was mistaken for a guarantee
 * would be worse than none.
 */
const invalidated = new Map<string, Set<() => void>>()

/**
 * Subscribe to "this session was deleted" for this process.
 *
 * Returns an unsubscribe function, and MUST be called on teardown: the set is
 * process-global, so a leaked subscription would retain a whole Scheduler —
 * including its provider and its child sessions — for the life of the process.
 */
export function onSessionInvalidated(sessionId: string, cb: () => void): () => void {
  let set = invalidated.get(sessionId)
  if (set === undefined) {
    set = new Set()
    invalidated.set(sessionId, set)
  }
  set.add(cb)
  let live = true
  return () => {
    if (!live) return
    live = false
    set.delete(cb)
    if (set.size === 0) invalidated.delete(sessionId)
  }
}

/**
 * Tell subscribers that `sessionId` was deleted.
 *
 * Deliberately swallows subscriber failures: this is called from the deletion
 * path, and a throwing observer must not be able to fail a deletion. Reporting
 * the failure belongs to the subscriber's own logging, if it has any.
 *
 * @returns how many subscribers were notified. Diagnostics only.
 */
export function notifySessionInvalidated(sessionId: string): number {
  const set = invalidated.get(sessionId)
  if (set === undefined) return 0
  // Copied first: a subscriber that unsubscribes during notification must not
  // mutate the set being iterated.
  for (const cb of [...set]) {
    try {
      cb()
    } catch {
      /* an observer cannot fail a deletion */
    }
  }
  return set.size
}

/** Sessions with at least one subscriber in this process. Diagnostics only. */
export function watchedSessions(): readonly string[] {
  return [...invalidated.keys()]
}

/**
 * Release the ownership token recorded under a known label, without holding the
 * `SessionOwner`.
 *
 * [PHASE 6U] The composition root's shutdown path knows the session id and the
 * label it composed with, but not the token `acquireSessionOwnership` minted.
 * This releases by identity of intent (this process, this label) rather than
 * requiring the caller to hold an opaque token it was never given.
 *
 * [DESIGN DECISION] Fail-closed on the token: only the CURRENT owner's token is
 * removed, so a late shutdown from a superseded instance cannot evict its
 * replacement. The extra token-identity check is what makes that safe.
 */
export function releaseSessionOwnershipFor(sessionId: string, label: string): boolean {
  const current = owners.get(sessionId)
  if (current === undefined) return false
  if (current.label !== label) return false
  owners.delete(sessionId)
  return true
}

/**
 * Test-only. Clears all ownership.
 *
 * NOT a production affordance: nothing outside tests may call this, because it
 * would let a caller manufacture the "not owned" state that reconciliation
 * needs in order to refuse.
 */
export function resetSessionOwnershipForTests(): void {
  owners.clear()
  invalidated.clear()
}
