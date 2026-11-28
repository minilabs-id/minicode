// Kanonikal task assignment untuk menyalurkan ID TaskStore yang baru dicetak
// oleh sinkronisasi `todo_write` kembali ke builder rencana melalui return value.
//
// Alasan memakai trailer pada string return tool:
// - `ToolContext` (`vendor/minicore/src/core/tool.ts`) tidak membawa tool-call ID.
// - Kernel memasangkan call dengan result melalui string hasil di event
//   `execution:completed` (`vendor/minicore/src/core/executor.ts`), sehingga
//   return value menjadi saluran per-operasi yang berkorelasi langsung tanpa
//   state tersembunyi atau duplikasi logika `runCall`.
//
// Bersifat fail-closed: `decode` mengembalikan `undefined` untuk trailer yang
// hilang, sesi asing, ID rusak, duplikat, atau versi wire yang salah.

import { isTaskId } from "./model.ts"

/** Whether the id already existed or was minted by this operation. Kept because
 *  the plan builder must be able to tell "confirmed an existing task" from
 *  "this operation created it" — the difference is what 4A.4 could not express. */
export type CanonicalAssignmentKind = "existing" | "new"

/** One declared item's canonical identity. */
export interface CanonicalAssignment {
  taskId: string
  kind: CanonicalAssignmentKind
}

/** One entry per DECLARED item, in declaration order. Index `i` corresponds to
 *  declared item `i` — the order is the contract, so the table is never sorted,
 *  deduped or re-derived on the way out. */
export type CanonicalAssignmentTable = readonly CanonicalAssignment[]

const WIRE_VERSION = 1
const OPEN = "<!-- minicore:canonical-tasks "
const CLOSE = " -->"

/** Serialize the table as a single trailing line.
 *
 *  `JSON.stringify` never emits a raw newline, so a session id containing one is
 *  escaped rather than splitting the channel across lines. */
export function encodeCanonicalAssignments(
  sessionId: string,
  table: CanonicalAssignmentTable,
): string {
  const body = JSON.stringify({
    v: WIRE_VERSION,
    session: sessionId,
    declared: table.map((a) => ({ taskId: a.taskId, kind: a.kind })),
  })
  return `${OPEN}${body}${CLOSE}`
}

/** Recover the table, or `undefined` if anything at all is off.
 *
 *  Only the FINAL non-empty line is considered, so ordinary model-visible prose
 *  can never be mistaken for the channel. Arity is deliberately NOT checked here:
 *  this function knows nothing about the declaration, so the caller compares the
 *  returned length against the steps it is about to label. */
export function decodeCanonicalAssignments(
  content: unknown,
  opts: { sessionId: string },
): CanonicalAssignmentTable | undefined {
  if (typeof content !== "string" || content.length === 0) return undefined

  const lines = content.split("\n")
  let last = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] as string).trim()
    if (t.length > 0) {
      last = t
      break
    }
  }
  if (!last.startsWith(OPEN) || !last.endsWith(CLOSE)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(last.slice(OPEN.length, last.length - CLOSE.length))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined

  const p = parsed as { v?: unknown; session?: unknown; declared?: unknown }
  if (p.v !== WIRE_VERSION) return undefined
  // The session stamp turns cross-session leakage from "argued not to happen"
  // into "detected and rejected".
  if (p.session !== opts.sessionId) return undefined
  if (!Array.isArray(p.declared) || p.declared.length === 0) return undefined

  const out: CanonicalAssignment[] = []
  const seen = new Set<string>()
  for (const entry of p.declared) {
    if (typeof entry !== "object" || entry === null) return undefined
    const c = entry as { taskId?: unknown; kind?: unknown }
    // `isTaskId` is the single owner of the id format, so the wire format cannot
    // drift away from what TaskStore would accept.
    if (!isTaskId(c.taskId)) return undefined
    if (c.kind !== "existing" && c.kind !== "new") return undefined
    if (seen.has(c.taskId)) return undefined
    seen.add(c.taskId)
    out.push({ taskId: c.taskId, kind: c.kind })
  }
  return out
}
