import { readFileSync, rmSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { isJournalHealthy, loadJournal, mutationsSinceTurn } from "../session/journal.ts"
import {
  checkWorkspaceIntegrity,
  collectSessionModifiedFiles,
  detectEvaluationTampering,
} from "../session/verification.ts"
import { type CanonicalAssignmentTable, encodeCanonicalAssignments } from "../task/assignment.ts"
import { isTaskId, type Task, TaskError, type TaskStatus } from "../task/model.ts"
import { TaskStore } from "../task/store.ts"
import { hasCanonicalIdentity, hasCanonicalTasks, synchronizeCanonicalTasks } from "../task/sync.ts"
import { requireToolCwd } from "./context.ts"

// Todo list per sesi — state eksplisit untuk task multi-langkah.
// Tanpa ini agent tidak punya tempat menyimpan rencana antar step, sehingga
// pada task panjang ia lupa langkah yang belum dikerjakan.

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"

export interface TodoItem {
  content: string
  status: TodoStatus
  /** Alasan `blocked` - WAJIB ada kalau status=blocked (INV: blocker harus
   *  bisa dijelaskan). Tidak ada di schema tool: diisi runtime dari bukti. */
  blockedReason?: string
  /**
   * PHASE 4A.1 - canonical task identity, OPTIONAL.
   *
   * This field only TRANSPORTS an id that already exists. The protocol layer
   * never mints, derives, rewrites or infers one: an id that is absent stays
   * absent, and an id that is present is passed through byte-for-byte. The sole
   * allocator remains `TaskStore`.
   *
   * Validity is checked with the one canonical guard, `isTaskId` from
   * `src/task/model.ts` - there is deliberately no second regex in this file.
   */
  taskId?: string
}

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed", "cancelled", "blocked"]

const GLYPH: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
  blocked: "[!]",
}

// ── Completion evidence (INV-003 / INV-009) ──────────────────────────────────
// "Agent bilang selesai" BUKAN bukti. Kebijakan ini bisa disuntik: composition
// root menyuntikkan sumber bukti (di CLI: hasil verify terakhir); tanpa
// injeksi, default `unverified` — completion tetap diizinkan, tapi statusnya
// tercatat sebagai belum diverifikasi, bukan diam-diam dianggap sah.
//
// Fail-closed hanya di arah yang berbahaya: `failed` MENOLAK `completed`.
// Menolak tanpa bukti (default) akan mematikan pemakaian normal yang tidak
// menjalankan verify, jadi itu tidak dilakukan.
export type CompletionVerdict = "unverified" | "passed" | "failed" | "stale"

export interface CompletionEvidence {
  verdict: CompletionVerdict
  detail?: string
  /**
   * P10.1.1: turn yang diobservasi bukti ini (diisi produsen verify,
   * yaitu runner `--verify`). Absen/null = bukti tanpa ikatan turn
   * (bukti lama/test) → diperlakukan `unverified` untuk freshness, BUKAN
   * passed: tak ada ikatan, tak ada klaim kesegaran.
   */
  turn?: number | null
  /**
   * [Fase 3 / LOOP-INV-12, LOOP-G20] Mode wajib verifikasi: bila `true` dan
   * bukti masih `unverified`, klaim `completed` ditahan di `VERIFYING` /
   * diturunkan — tidak diloloskan ke `COMPLETED` secara fail-open.
   */
  requireVerified?: boolean
  /** Kode keluar proses verifier (0 = lulus). */
  exitCode?: number | null
  /** Ringkasan hasil verifier untuk disimpan ke `evidence_json`. */
  summary?: string
}

const UNVERIFIED: CompletionEvidence = { verdict: "unverified" }
let completionEvidence: () => CompletionEvidence = () => UNVERIFIED

/** Dipanggil composition root (cli/setup.ts). Tanpa ini: `unverified`. */
export function setCompletionEvidence(fn: () => CompletionEvidence): void {
  completionEvidence = fn
}

/** Kembalikan ke default (seam uji / isolasi antar test file). */
export function clearCompletionEvidence(): void {
  completionEvidence = () => UNVERIFIED
}

function currentCompletionEvidence(): CompletionEvidence {
  try {
    return completionEvidence() ?? UNVERIFIED
  } catch {
    // Sumber bukti yang melempar TIDAK boleh menuntaskan task diam-diam.
    return { verdict: "failed", detail: "completion evidence source failed" }
  }
}

/**
 * Selesaikan bukti completion terhadap kesegaran mutasi (P10.1.1).
 * Dipakai jalur tulis `todo_write` (async) — BUKAN di dalam `normalizeTodos`
 * yang kontraknya murni tanpa I/O.
 *
 * - `passed` + turn + tanpa mutasi lebih baru → `passed` apa adanya.
 * - `passed` + mutasi lebih baru → `stale` (tolak klaim; label dipertahankan).
 * - `passed` tanpa turn → `unverified` (tak ada ikatan = perilaku legacy,
 *   izinkan-tanpa-klaim; BUKAN passed).
 * - Gagal baca jurnal → `failed` (fail-closed, konsisten dengan
 *   `currentCompletionEvidence`: ketidakpastian kesegaran tak boleh
 *   mengotorisasi completion).
 * - Verdict lain (`failed`/`unverified`) diteruskan tanpa disentuh.
 */
export async function resolveFreshEvidence(
  sessionId: string,
  cwd: string,
): Promise<CompletionEvidence> {
  const base = currentCompletionEvidence()
  if (base.verdict === "failed" || base.verdict === "stale") return base
  if (base.verdict === "passed" && typeof base.turn !== "number") {
    return base.requireVerified
      ? { verdict: "unverified", requireVerified: true }
      : { verdict: "unverified" }
  }
  if (base.verdict === "unverified") {
    // [Fase 3 / LOOP-INV-12] Tier 1 integrity check pada file yang benar-benar
    // telah di-commit ke jurnal sesi ini. Best-effort pada jurnal absent/empty/
    // corrupt agar kompatibilitas legacy turn-less & sesi tanpa jurnal tetap utuh.
    const loaded = await loadJournal(sessionId, cwd).catch(() => null)
    const modified = await collectSessionModifiedFiles(
      sessionId,
      cwd,
      loaded?.status === "valid" ? loaded.records : undefined,
    )
    if (modified.length > 0) {
      const integrity = await checkWorkspaceIntegrity(modified, cwd)
      if (!integrity.ok) {
        return {
          verdict: "failed",
          detail: integrity.summary,
          ...(base.requireVerified ? { requireVerified: true } : {}),
        }
      }
      // [Fase 6A / ACE-02] Tamper guard fail-closed: evaluator/gate yang
      // disentuh membuat SEMUA klaim completion tak bisa dipercaya.
      const tamper = await detectEvaluationTampering(modified, cwd)
      if (tamper.tampered) {
        return {
          verdict: "failed",
          detail: `EVALUATOR_TAMPER_ATTEMPT: ${tamper.reason}`,
          ...(base.requireVerified ? { requireVerified: true } : {}),
        }
      }
    }
    return base
  }
  // P10.1.2: jurnal degraded (kegagalan tulis intent — jalur produksi
  // "intent append gagal" pada tool event-path seperti MCP dotted) berarti
  // riwayat mutasi TAK LENGKAP: kesegaran tak bisa dipercaya → fail-closed
  // `failed`, BUKAN passed palsu-fresh. `isJournalHealthy` melaporkan `true`
  // untuk sesi baru/sehat (default `?? true` — semantics dipin test C2) dan
  // `false` hanya bila path tulis jurnal SESI INI pernah gagal, jadi cek ini
  // tak mengubah sesi sehat.
  if (!isJournalHealthy(sessionId, cwd)) {
    return {
      verdict: "failed",
      detail: "journal degraded — freshness unverifiable; re-verify, then re-claim",
    }
  }
  let newer: readonly unknown[]
  try {
    newer = await mutationsSinceTurn(sessionId, cwd, base.turn!)
  } catch (e) {
    return {
      verdict: "failed",
      detail: `freshness check failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    }
  }
  if (newer.length > 0) {
    return {
      verdict: "stale",
      detail:
        `verification stale — ${newer.length} mutation(s) since turn ${base.turn}; ` +
        `re-verify, then re-claim`,
    }
  }
  // [Fase 3 / LOOP-INV-12, LOOP-G21] Tier 1 integrity check sebelum mengizinkan
  // bukti `passed` mengunci `COMPLETED`.
  const loaded = await loadJournal(sessionId, cwd).catch(() => null)
  const modified = await collectSessionModifiedFiles(
    sessionId,
    cwd,
    loaded?.status === "valid" ? loaded.records : undefined,
  )
  if (modified.length > 0) {
    const integrity = await checkWorkspaceIntegrity(modified, cwd)
    if (!integrity.ok) {
      return {
        verdict: "failed",
        detail: integrity.summary,
        ...(base.requireVerified ? { requireVerified: true } : {}),
      }
    }
    // [Fase 6A / ACE-02] Tamper guard: bukti `passed` batal bila evaluator
    // atau test diubah untuk meloloskan verifikasi.
    const tamper = await detectEvaluationTampering(modified, cwd)
    if (tamper.tampered) {
      return {
        verdict: "failed",
        detail: `EVALUATOR_TAMPER_ATTEMPT: ${tamper.reason}`,
        ...(base.requireVerified ? { requireVerified: true } : {}),
      }
    }
  }
  return base
}

function sanitizeTodoId(id: string): string {
  return sanitizeSessionPart(id)
}

/**
 * OLD mapping (pre-N2). No longer the source of truth — kept ONLY so files
 * already written to disk stay reachable for one compatibility version.
 * `a/b` used to become `a_b.json`; under the canonical mapping that file is
 * `a-b.json`, so `loadTodos` must try both. Once the compatibility window
 * closes, this function is deleted.
 */
function legacySanitizeTodoId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default"
}

/** Todo filename. Canonical (N2) — the source of truth for all writes. */
function todoPath(sessionId: string, cwd: string): string {
  return resolve(cwd, ".minicode", "todos", `${sanitizeTodoId(sessionId)}.json`)
}

/** Legacy filename. Read fallback only; never written. */
function legacyTodoPath(sessionId: string, cwd: string): string {
  return resolve(cwd, ".minicode", "todos", `${legacySanitizeTodoId(sessionId)}.json`)
}

function planPath(sessionId: string, cwd: string): string {
  return resolve(cwd, ".minicode", "plans", `${sanitizeTodoId(sessionId)}.md`)
}

/** Same as `legacyTodoPath`, for the plan snapshot. */
function legacyPlanPath(sessionId: string, cwd: string): string {
  return resolve(cwd, ".minicode", "plans", `${legacySanitizeTodoId(sessionId)}.md`)
}

// Audit #13 chain 28: todo + plan snapshot adalah state milik sesi —
// deleteSession wajib menghapusnya agar konten rencana tak bertahan sebagai
// residual reachable pasca-hapus. Best-effort (kegagalan tak menggagalkan hapus).
export function deleteTodoFilesSync(sessionId: string, cwd: string): void {
  for (const p of [
    todoPath(sessionId, cwd),
    legacyTodoPath(sessionId, cwd),
    planPath(sessionId, cwd),
    legacyPlanPath(sessionId, cwd),
  ]) {
    try {
      rmSync(p, { force: true })
    } catch {}
  }
}

export async function deleteTodoFiles(sessionId: string, cwd: string): Promise<void> {
  deleteTodoFilesSync(sessionId, cwd)
}

function taskStatusToTodoStatus(status: TaskStatus): TodoStatus {
  switch (status) {
    case "COMPLETED":
      return "completed"
    case "CANCELLED":
      return "cancelled"
    case "BLOCKED":
      return "blocked"
    case "IN_PROGRESS":
    case "VERIFYING":
      return "in_progress"
    default:
      return "pending"
  }
}

export async function syncTodoViewsFromTaskStore(
  sessionId: string,
  cwd: string,
): Promise<TodoItem[] | null> {
  const tasks = new TaskStore(cwd).listTasks(sessionId)
  if (!tasks.length) return null
  const mapped: TodoItem[] = [...tasks]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((t: Task) => {
      const status = taskStatusToTodoStatus(t.status)
      return {
        content: t.title,
        status,
        ...(status === "blocked" ? { blockedReason: t.blockedReason ?? "blocked" } : {}),
        taskId: t.id,
      }
    })
  await saveTodos(sessionId, mapped, cwd)
  await savePlanSnapshot(sessionId, mapped, cwd).catch(() => {})
  return mapped
}

const GLYPH_TO_STATUS: Record<string, TodoStatus> = {
  " ": "pending",
  "~": "in_progress",
  x: "completed",
  "-": "cancelled",
  "!": "blocked",
}

export function extractCommittedTodoStatuses(
  resultContent: unknown,
  expectedCount: number,
): TodoStatus[] | undefined {
  if (typeof resultContent !== "string" || expectedCount <= 0) return undefined
  const lines = resultContent.split("\n")
  const headerIdx = lines.findIndex((l) => /^todos \d+\/\d+/.test(l))
  if (headerIdx === -1) return undefined
  const out: TodoStatus[] = []
  for (let i = headerIdx + 1; i < lines.length && out.length < expectedCount; i++) {
    const st = GLYPH_TO_STATUS[lines[i]!.match(/^ {2}\[([ ~x!-])\] /)?.[1] ?? ""]
    if (!st) break
    out.push(st)
  }
  return out.length === expectedCount ? out : undefined
}

/** Sanitasi + batasi daftar + terapkan kebijakan completion. Diekspor untuk test.
 *
 * `evidence` default = `currentCompletionEvidence()` (sumber yang disuntik
 * composition root). Pemanggil yang sudah punya bukti bisa mengoper nilainya
 * eksplisit supaya deterministik di test.
 */
/**
 * Terapkan kebijakan completion pada daftar yang sudah ternormalisasi.
 *
 * Murni (tanpa I/O) dan dipakai oleh DUA jalur agar aturan "completed butuh
 * bukti" hanya ada di satu tempat:
 *  1. `todo_write` (jalur tulis) - sebelum disimpan;
 *  2. `reconcileCompletionEvidence` (jalur rekonsiliasi) - setelah verify
 *     selesai, karena verify sebuah turn berjalan SETELAH `todo_write`.
 *
 * Mengembalikan array BARU bila ada yang berubah, `null` bila tidak -
 * pemanggil memakai ini untuk memutuskan apakah perlu menulis/menerbitkan
 * event (idempoten: tidak ada event plan palsu saat tidak ada perubahan).
 */
export function applyCompletionPolicy(
  list: readonly TodoItem[],
  evidence: CompletionEvidence,
  opts?: { requireVerified?: boolean },
): TodoItem[] | null {
  const requireVerified = opts?.requireVerified === true || evidence.requireVerified === true
  const fallbackReason =
    evidence.verdict === "failed" || evidence.verdict === "stale"
      ? `verification ${evidence.verdict}`
      : requireVerified && evidence.verdict === "unverified"
        ? "verification required: run verifier before marking completed"
        : null
  if (!fallbackReason || !list.some((t) => t.status === "completed")) return null
  const reason = evidence.detail?.trim().slice(0, 300) || fallbackReason
  return list.map((t) =>
    t.status === "completed" ? { ...t, status: "blocked" as const, blockedReason: reason } : t,
  )
}

/**
 * [AUDIT-FIX / stale todo] Petakan deklarasi penuh tanpa taskId ke task kanonik
 * yang SUDAH ada, memakai `content` sebagai kunci yang stabil.
 *
 * WHY: turn lanjutan/resume sering mengirim ulang SELURUH daftar (mis. 7 item)
 * tanpa taskId karena model tidak sempat memanggil todo_read. Guard 4A.5
 * memblokirnya, model lalu melanjutkan tanpa rencana. Selama teks itemnya
 * persis sama dengan judul task yang tersimpan, identitasnya bisa dipulihkan
 * TANPA mengarang id — TaskStore tetap satu-satunya sumber id.
 *
 * FAIL-CLOSED: jumlah item HARUS sama dan setiap `content` HARUS cocok persis
 * dengan `title` task kanonik yang belum terpakai. Satu item asing atau jumlah
 * yang beda mengembalikan null → pemanggil menolak seluruh penulisan. Tidak ada
 * yang pernah dibuang: bila tak semua bisa dipetakan, tak ada yang diubah.
 */
export function repairIdlessFullDeclaration(
  declared: readonly TodoItem[],
  existing: readonly Task[],
): TodoItem[] | null {
  if (declared.length === 0 || existing.length !== declared.length) return null
  if (declared.some((t) => typeof t.taskId === "string" && t.taskId !== "")) return null
  // Urutan kanonik dipakai sebagai pemecah ikatan saat ada judul kembar, supaya
  // pemetaan deterministik dan tiap task dipakai paling banyak sekali.
  const pool = [...existing].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const used = new Set<string>()
  const repaired: TodoItem[] = []
  for (const item of declared) {
    const match = pool.find((t) => !used.has(t.id) && t.title === item.content)
    if (!match) return null
    used.add(match.id)
    repaired.push({ ...item, taskId: match.id })
  }
  return repaired
}

export function normalizeTodos(
  input: unknown,
  evidence?: CompletionEvidence,
  opts?: { requireVerified?: boolean },
): TodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos must be an array")
  const ev = evidence ?? currentCompletionEvidence()
  const out: TodoItem[] = []
  for (const raw of input.slice(0, LIMITS.TODO_MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as {
      content?: unknown
      status?: unknown
      blockedReason?: unknown
      taskId?: unknown
    }
    const content = String(r.content ?? "")
      .trim()
      .slice(0, LIMITS.TODO_CONTENT_MAX_CHARS)
    if (!content) continue
    const status = STATUSES.includes(r.status as TodoStatus) ? (r.status as TodoStatus) : "pending"
    // `blockedReason` HARUS ikut dibaca: tanpanya alasan blocker hilang
    // tepat setelah restart (durable write, non-durable read).
    const reason = typeof r.blockedReason === "string" ? r.blockedReason.trim().slice(0, 300) : ""
    // PHASE 4A.1 - `taskId` is the ONE identity-bearing field that survives
    // normalization. It is validated with the canonical guard and then passed
    // through unchanged: never trimmed, renumbered, generated or coerced. An
    // absent id stays absent - this layer must not invent durable identity.
    if (r.taskId !== undefined && r.taskId !== null && !isTaskId(r.taskId)) {
      throw new Error(`todo item has a non-canonical taskId: ${String(r.taskId)}`)
    }
    const taskId = isTaskId(r.taskId) ? r.taskId : undefined
    out.push(
      reason
        ? { content, status, blockedReason: reason, ...(taskId ? { taskId } : {}) }
        : { content, status, ...(taskId ? { taskId } : {}) },
    )
  }
  if (out.length === 0) throw new Error("todos is empty — provide at least one item with content")
  // `blocked` tanpa alasan adalah state tak terjelaskan (PF-04). Selain
  // `blocked` dikeluarkan dari enum model, ada pagar kedua di sini: file yang
  // ditulis tangan atau jalur argumen lain tidak boleh menciptakan blocker
  // yang tak bisa dijelaskan. Tanpa alasan -> turun ke `pending`.
  for (const t of out) {
    if (t.status !== "blocked" || t.blockedReason) continue
    t.status = "pending"
  }
  // Bukti merah MENOLAK `completed`: task turun ke `blocked` beserta alasannya.
  // Ini yang menutup INV-003 - sebelumnya model bisa menandai "selesai" sambil
  // verify merah dan tak ada satu pun jalur kode yang mencegahnya.
  const gated = applyCompletionPolicy(out, ev, opts)
  const final = gated ?? out
  // Satu in_progress saja: kalau model menandai beberapa, sisanya turun ke
  // pending supaya daftar tetap punya satu fokus yang jelas.
  let seenActive = false
  for (const t of final) {
    if (t.status !== "in_progress") continue
    if (seenActive) t.status = "pending"
    seenActive = true
  }
  return final
}

export function renderTodos(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  const blocked = todos.filter((t) => t.status === "blocked").length
  const active = todos.find((t) => t.status === "in_progress")
  const head =
    `todos ${done}/${todos.length}` +
    (blocked > 0 ? ` · ${blocked} blocked` : "") +
    (active ? ` · sekarang: ${active.content}` : "")
  const body = todos
    .map(
      // PHASE 4A.1 - identity is echoed so the model can reference the task
      // later. It is rendered only when present; an id-less item is rendered
      // exactly as before. No id is ever synthesised for display.
      (t) =>
        `  ${GLYPH[t.status]} ${t.taskId ? `${t.taskId} — ` : ""}${t.content}${t.blockedReason ? ` — ${t.blockedReason}` : ""}`,
    )
    .join("\n")
  return `${head}\n${body}`
}

/**
 * Baca daftar todo dari disk. **PASIF**: tidak menerapkan kebijakan
 * completion apa pun.
 *
 * Dulu jalur baca ini melewati `normalizeTodos` tanpa argumen bukti, sehingga
 * ia memakai `currentCompletionEvidence()` - akibatnya `todo_read` melaporkan
 * `blocked` sementara file tetap `completed`. Durable dan observed berbeda, dan
 * tak ada yang menyelaraskan. Sekarang bentuk di disk adalah satu-satunya
 * kebenaran; kebijakan hanya berlaku di jalur tulis (`todo_write`) dan di
 * rekonsiliasi eksplisit (`reconcileCompletionEvidence`) yang menulis balik.
 */
export async function loadTodos(sessionId: string, cwd: string): Promise<TodoItem[]> {
  // N2: try the canonical name first, then the legacy name. A file written by an
  // older process only exists at the legacy path, so without this fallback a
  // workspace that was upgraded but never ran `todo_write` again would lose its
  // task list silently.
  for (const p of [todoPath(sessionId, cwd), legacyTodoPath(sessionId, cwd)]) {
    const parsed = await readTodoFile(p)
    if (parsed) return parsed
  }
  return []
}

async function readTodoFile(p: string): Promise<TodoItem[] | null> {
  try {
    const raw = await readFile(p, "utf8")
    const parsed = JSON.parse(raw) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) return null
    // Bentuk tersimpan sudah ternormalisasi saat ditulis. Normalisasi di sini
    // hanya untuk mem-namedai file yang ditulis tangan, dengan bukti
    // `unverified` supaya TIDAK ada kebijakan yang diam-diam berlaku saat baca.
    return normalizeTodos(parsed.todos, UNVERIFIED)
  } catch {
    return null
  }
}

/**
 * Baca & format daftar todo tersimpan secara sinkron tanpa menerapkan kebijakan
 * completion — dipakai compaction saat pesan `todo_write` lama telah terlipat
 * pasca `--resume` (ketika WeakSet provenance in-memory kosong).
 */
export function readPersistedTaskStateSync(sessionId: string, cwd: string): string | null {
  for (const p of [todoPath(sessionId, cwd), legacyTodoPath(sessionId, cwd)]) {
    try {
      const raw = readFileSync(p, "utf8")
      const parsed = JSON.parse(raw) as { todos?: unknown }
      if (!Array.isArray(parsed.todos)) continue
      const items = normalizeTodos(parsed.todos, UNVERIFIED)
      return items.length > 0 ? renderTodos(items) : null
    } catch {}
  }
  return null
}

/**
 * Rekonsiliasi completion SETELAH verify selesai.
 *
 * Menutup gap PF-01: `todo_write` berjalan sebelum verify sebuah turn, jadi
 * klaim `completed` bisa sudah tersimpan ketika verify turn itu berubah merah.
 * Fungsi ini menutup celah itu dari arah yang sama seperti gerbang tulis:
 * penurunan `completed` menjadi `blocked` + alasan, ditulis balik ke disk, dan
 * pemanggil menerbitkan `plan.updated` baru.
 *
 * Idempoten dan pasif-bila-tak-perlu: mengembalikan `null` bila tidak ada
 * perubahan, supaya tidak terbit event plan yang tidak mencerminkan kenyataan.
 */
export async function reconcileCompletionEvidence(
  sessionId: string,
  cwd: string,
  evidence: CompletionEvidence,
  opts: { syncTaskStore?: boolean } = {},
): Promise<TodoItem[] | null> {
  // `stale` diperlakukan seperti `failed` untuk otorisasi (tolak klaim),
  // dengan label + alasan basi dipertahankan apa adanya.
  if (evidence.verdict !== "failed" && evidence.verdict !== "stale") return null
  try {
    const current = await loadTodos(sessionId, cwd)
    const next = applyCompletionPolicy(current, evidence)
    const canonical = opts.syncTaskStore === true && hasCanonicalTasks(cwd, sessionId)
    let canonicalChanged = false
    if (canonical) {
      const store = new TaskStore(cwd)
      const outcome = {
        ok: false as const,
        verdict: evidence.verdict,
        ...(evidence.detail ? { detail: evidence.detail } : {}),
        summary: evidence.detail?.trim().slice(0, 300) || `verification ${evidence.verdict}`,
      }
      const blockedReason =
        evidence.detail?.trim().slice(0, 300) ||
        (evidence.verdict === "stale" ? "verification stale" : "verification failed")
      store.withTransaction((tx) => {
        const tasks = tx.listTasks(sessionId)
        for (const t of tasks) {
          if (t.status === "VERIFYING") {
            tx.completeTaskVerification(sessionId, t.id, outcome)
            canonicalChanged = true
            continue
          }
          const jsonItem = (next ?? current).find((it) => it.taskId === t.id)
          if (
            jsonItem?.status === "blocked" &&
            t.status !== "BLOCKED" &&
            t.status !== "CANCELLED"
          ) {
            tx.patchTask(
              sessionId,
              t.id,
              {
                status: "BLOCKED",
                blockedReason: jsonItem.blockedReason ?? blockedReason,
                verification: {
                  verdict: "failed",
                  ...(evidence.detail ? { detail: evidence.detail.slice(0, 300) } : {}),
                  checkedAt: new Date().toISOString(),
                },
              },
              { allowReopen: t.status === "COMPLETED" },
            )
            canonicalChanged = true
          }
        }
      }, true)
    }
    if (canonicalChanged) {
      return await syncTodoViewsFromTaskStore(sessionId, cwd)
    }
    if (!next) return null
    await saveTodos(sessionId, next, cwd)
    await savePlanSnapshot(sessionId, next, cwd).catch(() => {})
    return next
  } catch (e) {
    // Best-effort: kegagalan rekonsiliasi TIDAK boleh menggagalkan turn yang
    // sudah selesai. Diagnostik ditulis di modul pemilik kegagalan, bukan di
    // pemanggil — menambah `process.stderr.write` di `cli/setup.ts` menaikkan
    // writer ke-27 dan melanggar pagu invaris OAP-008 (test/writer-inventory).
    process.stderr.write(`[warn] completion reconcile failed: ${(e as Error).message}\n`)
    return null
  }
}

export async function saveTodos(sessionId: string, todos: TodoItem[], cwd: string): Promise<void> {
  const p = todoPath(sessionId, cwd)
  await mkdir(resolve(cwd, ".minicode", "todos"), { recursive: true }).catch(() => {})
  await atomicWriteText(p, JSON.stringify({ sessionId, updatedAt: Date.now(), todos }, null, 2))
}

/**
 * [P0-1] Pulihkan tampilan JSON dari TaskStore setelah `todo_write` gagal.
 *
 * TaskStore adalah otoritas; file JSON hanya turunan. Sebelum perbaikan ini,
 * file dibiarkan berisi `taskId` phantom saat sinkronisasi rollback, sehingga
 * `todo_read` berbohong dan KEDUA saran lama gagal: "kirim tanpa taskId"
 * diblokir guard 4A.5 (canonical task masih ada), "pakai taskId dari
 * todo_read" mengulang id phantom yang sama. Helper ini membaca id yang
 * benar-benar ada di TaskStore, menulis balik tampilannya, dan mengembalikan
 * id tersebut supaya pesan error bisa memberi jalur perbaikan yang bekerja.
 *
 * `viewBefore` dipakai saat TaskStore rollback ke kosong: file id-less lama
 * (legacy) tetap sah walau tanpa baris kanonik, jangan dihapus begitu saja.
 */
export async function restoreTodoViewFromStore(
  sessionId: string,
  cwd: string,
  viewBefore: readonly TodoItem[],
): Promise<string[]> {
  let tasks: Task[]
  try {
    tasks = new TaskStore(cwd).listTasks(sessionId)
  } catch {
    // Store tak bisa dibaca: tak ada otoritas untuk diturunkan. Jangan
    // mengarang id — pemanggil tetap menyampaikan diagnostik kegagalannya.
    return []
  }
  if (tasks.length === 0) {
    // Rollback ke tampilan SEBELUM tulisan yang gagal. Audit deep: jangan
    // salin `taskId` apa adanya — id itu bisa phantom (dialokasikan tapi tak
    // jadi commit). Tanpa otoritas TaskStore, menyimpannya verbatim
    // mengembalikan id hantu yang tak bisa dipakai model. Buang `taskId`,
    // pertahankan content/status/blockedReason agar daftar legacy tetap ada.
    const stripped: TodoItem[] = viewBefore.map((t) => ({
      content: t.content,
      status: t.status,
      ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
    }))
    await saveTodos(sessionId, stripped, cwd).catch(() => {})
    return []
  }
  const mapped: TodoItem[] = [...tasks]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((t) => ({
      content: t.title,
      status: taskStatusToTodoStatus(t.status),
      ...(t.status === "BLOCKED" ? { blockedReason: t.blockedReason ?? "blocked" } : {}),
      taskId: t.id,
    }))
  await saveTodos(sessionId, mapped, cwd).catch(() => {})
  await savePlanSnapshot(sessionId, mapped, cwd).catch(() => {})
  return mapped.map((t) => t.taskId!).filter((id): id is string => typeof id === "string")
}

/** P13 P1 — plan artifact: snapshot markdown rencana per sesi.
 * JSON todos bagus untuk mesin tapi tak bisa dibaca kilat manusia; file ini
 * dibaca model berikutnya saat resume lintas sesi tanpa memutar ulang todo.
 * Best-effort: gagal tulis tak boleh menggagalkan todo_write. */
export function renderPlan(sessionId: string, todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === "completed").length
  const blocked = todos.filter((t) => t.status === "blocked").length
  const lines = [
    `# Plan — ${sessionId}`,
    ``,
    `Progress: ${done}/${todos.length} completed.${blocked ? ` · ${blocked} blocked.` : ""}`,
    ``,
    ...todos.map((t) => {
      const box =
        t.status === "completed"
          ? "x"
          : t.status === "in_progress"
            ? "~"
            : t.status === "cancelled"
              ? "-"
              : t.status === "blocked"
                ? "!"
                : " "
      // Alasan blocker WAJIB ikut: tanpa ini artefak ini tidak bisa
      // menjelaskan kenapa sebuah task tidak bisa diselesaikan.
      const why = t.blockedReason ? ` — ${t.blockedReason}` : ""
      return `- [${box}] ${t.content} (${t.status})${why}`
    }),
    ``,
    `_Updated: ${new Date().toISOString()}_`,
    ``,
  ]
  return lines.join("\n")
}

export async function savePlanSnapshot(
  sessionId: string,
  todos: TodoItem[],
  cwd: string,
): Promise<string> {
  const p = planPath(sessionId, cwd)
  await mkdir(resolve(cwd, ".minicode", "plans"), { recursive: true }).catch(() => {})
  await atomicWriteText(p, renderPlan(sessionId, todos))
  return p
}

export async function loadPlan(sessionId: string, cwd: string): Promise<string | null> {
  try {
    return await readFile(planPath(sessionId, cwd), "utf8")
  } catch {
    return null
  }
}

/** Session id aktif — di-set CLI supaya todo tersimpan per sesi. */
export const todoSession = { id: "default", cwd: undefined as string | undefined }

/**
 * PHASE 4A.4B — the identity ONE todo operation runs under.
 *
 * WHY THIS EXISTS. `todoSession` is a process-level singleton. The write path used
 * to read it *after* an `await`, so a second request that rebound the global could
 * silently steal the first request's session: the JSON write, the TaskStore
 * namespace, the assignment's session stamp and the plan snapshot could all end
 * up under the wrong session.
 *
 * The fix is deliberately NOT a new global and NOT a new context abstraction. It
 * is the existing per-request `ToolContext` — which MCP already builds fresh for
 * every request and already populates with the execution root — plus ONE capture
 * at operation entry. Everything after an `await` then reads the immutable local,
 * so the operation stays bound to the session it was invoked with no matter what
 * another request does to the global.
 *
 * Identitas boleh memakai default composition. Root workspace wajib dari
 * request context agar tool tidak berpindah diam-diam ke cwd proses.
 *
 * `todoSession` remains the composition-root DEFAULT — `cli/setup.ts` binds it
 * once at startup and never mutates it during operation. It is read here exactly
 * once per operation, at entry, which is what makes it safe rather than what makes
 * it correct on its own.
 */
export function todoOperationContext(ctx: unknown): { sessionId: string; cwd: string } {
  const c = (ctx ?? {}) as { sessionId?: string; cwd?: string }
  return {
    sessionId: typeof c.sessionId === "string" && c.sessionId !== "" ? c.sessionId : todoSession.id,
    cwd: requireToolCwd(c),
  }
}

export const todoWriteTool: Tool = {
  name: "todo_write",
  // v7.33 (wire contract): tag PLAN (todo = rencana, bukan file/memori).
  description:
    "PLAN: Write or patch the todo list (use updates:[{taskId,status}] for delta status updates, or todos as a full list, never a delta). Keep one item in_progress. New items: OMIT `taskId` (auto-assigned). Updating existing items via todos: call `todo_read` and echo exact `taskId` (ids are never invented; id-less full list auto-repairs only on exact content+count match, else REJECTED). Never reopen completed/cancelled tasks; claim completed only with passing verification (otherwise REFUSED → blocked).",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "full todo list (replace, not delta); use when creating/reordering items",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "short, actionable task item" },
            // `blocked` SENGAJA tidak ada di enum model: itu status yang
            // ditegakkan runtime (verifikasi merah) dan selalu membawa alasan.
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
            // PHASE 4A.1 - the single identity-bearing field the model may
            // supply. Optional, so every existing id-less payload still
            // validates. `additionalProperties: false` below is retained, so
            // this is the ONLY new accepted property.
            taskId: {
              type: "string",
              description:
                "OMIT for new items (auto-assigned); echo canonical id from todo_read for existing items, never invent.",
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
      updates: {
        type: "array",
        description: "incremental status updates by canonical taskId (avoids resending full todos)",
        items: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "canonical id returned by todo_read/todo_write",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
          },
          required: ["taskId", "status"],
          additionalProperties: false,
        },
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ todos, updates }, ctx) {
    ctx.signal.throwIfAborted()
    if ((todos !== undefined) === (updates !== undefined)) {
      throw new Error(
        "provide either todos (full list) or updates (delta status patches), not both or neither",
      )
    }
    // PHASE 4A.4B - bind ONCE, before the first await. `sessionId` and `cwd` are
    // immutable for the rest of this operation, so no later request can redirect
    // the JSON write, the TaskStore namespace, the assignment stamp or the plan
    // snapshot to another session.
    const { sessionId, cwd } = todoOperationContext(ctx)
    // P10.1.1: bukti diselesaikan terhadap kesegaran mutasi (async) SEBELUM
    // gate murni — `normalizeTodos` tetap sync tanpa I/O.
    const evidence = await resolveFreshEvidence(sessionId, cwd)
    const rawDeclaredCompleted = new Set<number>()
    let list: TodoItem[]

    if (updates !== undefined) {
      if (!Array.isArray(updates) || updates.length === 0) {
        throw new Error("updates must be a non-empty array")
      }
      const patchById = new Map<string, TodoStatus>()
      for (const raw of updates) {
        if (!raw || typeof raw !== "object") continue
        const u = raw as { taskId?: unknown; status?: unknown }
        if (!isTaskId(u.taskId)) {
          throw new Error(`todo item has a non-canonical taskId: ${String(u.taskId)}`)
        }
        if (patchById.has(u.taskId)) {
          throw new Error(`duplicate taskId in updates: ${u.taskId}`)
        }
        if (typeof u.status !== "string" || !STATUSES.includes(u.status as TodoStatus)) {
          throw new Error(`invalid status for taskId ${u.taskId}: ${String(u.status)}`)
        }
        patchById.set(u.taskId, u.status as TodoStatus)
      }
      if (patchById.size === 0) throw new Error("updates must be a non-empty array")

      const existing = await loadTodos(sessionId, cwd)
      if (existing.length === 0) {
        const msg = hasCanonicalTasks(cwd, sessionId)
          ? "canonical tasks exist on disk; call todo_read first to fetch their taskIds."
          : "no existing todos yet; provide initial items via `todos` first."
        throw new TaskError("TASK_IDENTITY_REQUIRED", msg)
      }
      const knownIds = new Set(
        existing.map((t) => t.taskId).filter((id): id is string => Boolean(id)),
      )
      for (const id of patchById.keys()) {
        if (!knownIds.has(id)) {
          const valid = [...knownIds].join(", ") || "none"
          throw new TaskError(
            "TASK_IDENTITY_REQUIRED",
            `unknown taskId ${id} in updates (valid: ${valid}). Call todo_read and use exact existing ids.`,
          )
        }
      }
      // Hanya klaim `completed` BARU di `updates` yang diuji kebijakan completion
      // agar task yang sudah verified sebelumnya tidak ter-downgrade saat update item lain.
      let newlyActivatedId: string | undefined
      list = existing.map((item, idx) => {
        const nextStatus = item.taskId ? patchById.get(item.taskId) : undefined
        if (!nextStatus) return item
        if (nextStatus === "in_progress") newlyActivatedId = item.taskId
        if (nextStatus === "completed") {
          rawDeclaredCompleted.add(idx)
          const checked = applyCompletionPolicy([{ ...item, status: "completed" }], evidence)
          if (checked) return checked[0]!
        }
        const { blockedReason: _oldReason, ...clean } = item
        return { ...clean, status: nextStatus }
      })
      if (newlyActivatedId) {
        list = list.map((item) =>
          item.status === "in_progress" && item.taskId !== newlyActivatedId
            ? { ...item, status: "pending" as const }
            : item,
        )
      }
    } else {
      // Indeks item valid (setelah pemangkasan content kosong, persis urutan
      // `normalizeTodos`) yang diajukan `completed` oleh model. Dipakai saat
      // `requireVerified && unverified` agar TaskStore menahan baris di VERIFYING.
      if (Array.isArray(todos)) {
        let validIdx = 0
        for (const raw of todos.slice(0, LIMITS.TODO_MAX_ITEMS)) {
          if (!raw || typeof raw !== "object") continue
          const r = raw as { content?: unknown; status?: unknown }
          if (!String(r.content ?? "").trim()) continue
          if (r.status === "completed") rawDeclaredCompleted.add(validIdx)
          validIdx += 1
        }
      }
      list = normalizeTodos(todos, evidence)
    }

    // PHASE 4A.5 + [AUDIT-FIX / stale todo] — identitas untuk deklarasi penuh.
    //
    // `todo_write` adalah FULL DECLARATION. Setelah task kanonik ada, payload
    // tanpa taskId dulu ditolak mentah-mentah; pada sesi audit model mengirim
    // ulang 7 item persis seperti sebelumnya, kena TASK_IDENTITY_REQUIRED, lalu
    // melanjutkan tanpa rencana. Sekarang ada satu jalur perbaikan yang aman:
    // bila JUMLAH dan setiap `content` cocok persis dengan task yang ada, id
    // dipetakan dari TaskStore (bukan dikarang) dan update diterapkan.
    //
    // FAIL-CLOSED tetap: item yang bertabrakan/asing atau jumlah yang beda
    // mengembalikan null → seluruh penulisan ditolak, tak ada yang dibuang.
    //
    // PLACEMENT. Ini tetap SEBELUM `saveTodos`: penolakan adalah no-op penuh
    // (tanpa JSON, TaskStore, alokasi id, atau plan). Saat repair berhasil,
    // `list` sudah ber-identity sehingga sync kanonik di bawah berjalan normal.
    if (list.length > 0 && !hasCanonicalIdentity(list) && hasCanonicalTasks(cwd, sessionId)) {
      const tasks = new TaskStore(cwd).listTasks(sessionId)
      const repaired = repairIdlessFullDeclaration(list, tasks)
      if (repaired) {
        // Hanya menambahkan taskId, bukan mengubah urutan/status/konten — jadi
        // indeks `rawDeclaredCompleted` yang dihitung lebih awal tetap selaras.
        list = repaired
      } else {
        const preview = tasks
          .slice(0, 10)
          .map((t) => `${t.id}(${t.status.toLowerCase()})`)
          .join(", ")
        const more = tasks.length > 10 ? `, +${tasks.length - 10} more` : ""
        throw new TaskError(
          "TASK_IDENTITY_REQUIRED",
          `this task already has ${tasks.length} canonical task(s) [${preview}${more}], so this full declaration must identify them. ` +
            `An id-less list is only repaired when every item's content exactly matches an existing task; ` +
            `call todo_read and re-send existing items with their taskId (e.g. {"taskId":"t1", ...}) and never reopen completed/cancelled tasks to pending/in_progress. ` +
            `To start a new topic in the same session, keep existing terminal taskId(s) unchanged and omit taskId only on genuinely new items. ` +
            `Nothing was written: the todo list and canonical tasks are unchanged.`,
        )
      }
    }

    // [P0-1] Rekam tampilan SEBELUM menulis. Bila sinkronisasi kanonik rollback,
    // JSON dipulihkan dari sini (atau dari TaskStore bila masih ada baris), supaya
    // pasangan JSON↔TaskStore tetap konsisten dan todo_read tak menampilkan id
    // phantom.
    const viewBefore = await loadTodos(sessionId, cwd)
    // Simpan isi file todo SEBELUM sinkronisasi TaskStore: urutan ini adalah
    // kontrak 4A.4 (durabel dulu, plan publish tertahan bila sync gagal).
    await saveTodos(sessionId, list, cwd)
    // PHASE 4A.4 - canonical TaskStore synchronization (NEW ARCHITECTURE).
    //
    // Placement follows the ordering production already proves: the durable JSON
    // write happens first, so a failure here still suppresses plan publication
    // (the adapter only publishes when the tool did not error). All-id-less
    // payloads are left alone - the legacy path stays legacy.
    //
    // `content` is mapped to `title` here because TaskStore requires `title`;
    // passing the legacy `content` through was measured to fail NOT NULL.
    //
    // PHASE 4A.4A - the resulting assignment is captured here and emitted on the
    // return value, which is the only per-operation channel the kernel itself
    // correlates (the reasoning, and the rejected alternatives, are in
    // `src/task/assignment.ts`). The legacy all-id-less path appends nothing, so
    // its output is byte-identical to what it was before this phase.
    let assignment: CanonicalAssignmentTable | undefined
    const holdInVerifying = evidence.verdict === "unverified" && evidence.requireVerified === true
    // [Fase 8 / 8.3] Todo→TaskStore sync untuk payload all-id-less.
    //
    // Live Test §3.1: `todo_write` dengan payload tanpa `taskId` (all-id-less)
    // TIDAK pernah menyinkronkan ke `.minicode/tasks.db` → query tasks selalu
    // `0 rows`. `synchronizeCanonicalTasks` sengaja menolak payload id-less
    // (legacy). Namun untuk sesi yang BELUM punya identitas kanonik sama sekali
    // (belum ada baris tasks), payload id-less adalah deklarasi pertama — item
    // di dalamnya memang task baru, jadi mengalokasikan id via TaskStore adalah
    // aman dan justru menghilangkan `0 rows`. Guard 4A.5 (reject id-less bila
    // canonical tasks sudah ada) tetap berjalan di atas — jadi alur ini hanya
    // menjangkau sesi yang benar-benar baru (dup yang sudah ada tetap ditolak).
    const firstCanonicalWrite = !hasCanonicalIdentity(list) && !hasCanonicalTasks(cwd, sessionId)
    if (hasCanonicalIdentity(list) || firstCanonicalWrite) {
      try {
        const sync = synchronizeCanonicalTasks({
          cwd,
          sessionId,
          declared: list.map((t, idx) => ({
            ...(t.taskId ? { taskId: t.taskId } : {}),
            title: t.content,
            status: t.status,
            ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
            ...(holdInVerifying && rawDeclaredCompleted.has(idx) ? { holdVerifying: true } : {}),
          })),
          ...(firstCanonicalWrite ? { adoptIdlessAsNew: true } : {}),
          ...(evidence.verdict === "passed"
            ? {
                verificationOutcome: {
                  ok: true,
                  verdict: "passed",
                  exitCode: evidence.exitCode ?? 0,
                  ...(evidence.detail ? { command: evidence.detail } : {}),
                  summary: evidence.summary ?? evidence.detail ?? "verification passed",
                  integrityOk: true,
                },
              }
            : {}),
        })
        if (sync.assignment && sync.assignment.length > 0) assignment = sync.assignment
      } catch (e) {
        // [P0-1] JSON + TaskStore kini SATU unit yang bisa dipulihkan, bukan
        // divergence yang dibiarkan. Re-derive tampilan dari otoritas (TaskStore)
        // lalu sebutkan id yang BENAR di pesan — bukan id phantom dari JSON lama.
        const validIds = await restoreTodoViewFromStore(sessionId, cwd, viewBefore)
        const err = e as TaskError
        // Audit deep: saran harus KONSISTEN dengan kenyataan. Dulu pesan
        // mengatakan "(none — re-send ... with no taskId)" lalu menyuruh
        // "re-send using ONLY those taskIds" — kontradiktif. Bila tak ada id
        // sah, Katakan sekali: hilangkan SEMUA taskId.
        const idsHint =
          validIds.length > 0
            ? `Valid taskIds: ${validIds.join(", ")}. Call todo_read, then re-send the full list using ONLY those taskIds; omit taskId only on items that are genuinely new.`
            : `No canonical taskIds exist — re-send a fresh full list with no taskId (omit every taskId; all items are new).`
        throw new TaskError(
          err.code ?? "TASK_PERSISTENCE_FAILURE",
          `canonical task sync failed (${err.message}); no canonical task was committed and the ` +
            `todo JSON view was re-derived from TaskStore, so todo_read and TaskStore now agree. ` +
            idsHint,
        )
      }
    }
    // PHASE 4B.1 - write the RESOLVED identities back to the durable todo file.
    //
    // THE DEFECT THIS FIXES. `saveTodos` above persists the *declared* payload,
    // which by definition carries no id for a task the sync was about to create.
    // The id minted by TaskStore reached the plan builder (4A.4A) but never the
    // JSON, and `todo_read` reads the JSON - so the model could never learn the id
    // of a task it had just created. On the next turn it re-sent that item
    // id-less, 4A.5 classified it as a mixed payload, and a SECOND durable row was
    // created for the same logical task. Measured before the fix: t3=C then
    // t4=C, two canonical rows for one task.
    //
    // The ids merged here are the allocator's own, returned by the transaction
    // that committed them. Nothing is inferred from position, content or title.
    //
    // ORDERING IS PRESERVED. The first `saveTodos` still happens BEFORE the
    // canonical sync, so a durable-write failure still suppresses plan
    // publication (4A.4) and the 4A.5 guard still runs before anything is
    // written. This is an ADDITIONAL write that only happens once the canonical
    // state is committed.
    //
    // The legacy all-id-less path produces no assignment, so it performs no
    // second write and its file is byte-identical to before.
    let current = list
    if (assignment) {
      const merged = list.map((t, i) =>
        // Only ever ADD an id the store just minted. A declared id is never
        // rewritten, and an item with no assignment entry is left untouched.
        !t.taskId && assignment[i] ? { ...t, taskId: assignment[i]!.taskId } : t,
      )
      if (merged.some((t, i) => t.taskId !== list[i]?.taskId)) {
        current = merged
        // [P0-1] TaskStore sudah commit di sini. Kegagalan tulis JSON kedua
        // harus terlihat dan punya jalur perbaikan, bukan membuat TaskStore
        // diam-diam lebih baru dari JSON tanpa diagnostik.
        try {
          // Awaited, not swallowed: leaving a stale view file behind is precisely
          // what made this defect invisible.
          await saveTodos(sessionId, current, cwd)
        } catch (saveErr) {
          const validIds = await restoreTodoViewFromStore(sessionId, cwd, viewBefore)
          // Audit deep: sama seperti jalur sync — bila tak ada id sah yang
          // bisa disebut, jangan menyarankan "those ids". Katakan sekali agar
          // jalur perbaikan yang diiklankan benar-benar bisa dijalankan.
          const idsHint =
            validIds.length > 0
              ? `Valid taskIds now: ${validIds.join(", ")}. Call todo_read and re-send using exactly those ids; never invent a taskId.`
              : `No canonical taskIds — re-send with no taskId (omit every taskId); never invent one.`
          throw new TaskError(
            "TASK_PERSISTENCE_FAILURE",
            `TaskStore committed the canonical tasks but the todo JSON write failed ` +
              `(${(saveErr as Error).message}). ${idsHint}`,
          )
        }
      }
    }
    // Plan artifact ditulis tiap save — murah (atomik, kecil) dan membuat
    // resume lintas sesi tidak butuh memutar ulang seluruh percakapan.
    // Now fed with the RESOLVED list, so the persisted plan carries canonical ids.
    await savePlanSnapshot(sessionId, current, cwd).catch(() => {})
    // Penolakan completion harus TERLIHAT oleh model, bukan hanya tersimpan di
    // file: tanpa baris ini model mengira item-nya completed lalu mencoba
    // lanjut — persis pola "false completion" yang INV-003 larang.
    const refused = current.filter((t) => t.status === "blocked" && t.blockedReason)
    // P10.1.1: stale ≠ failed — pesannya dibedakan agar model memperbaiki
    // hal yang benar (re-verify untuk basi, perbaiki check untuk gagal).
    const notice =
      refused.length > 0
        ? evidence.verdict === "stale"
          ? `refused ${refused.length} completion claim(s): verification evidence is stale — code changed since the last green run; re-verify, then re-claim.\n`
          : holdInVerifying
            ? `refused ${refused.length} completion claim(s): verification is required before completion — tasks are held in VERIFYING until the verifier runs green.\n`
            : `refused ${refused.length} completion claim(s): verification is failing, so they are blocked instead of completed. Fix the failing check first.\n`
        : ""
    return (
      notice +
      renderTodos(current) +
      (assignment ? `\n${encodeCanonicalAssignments(sessionId, assignment)}` : "")
    )
  },
}

export const todoReadTool: Tool = {
  name: "todo_read",
  // v7.33 (wire contract): tag PLAN.
  description: "PLAN: Read the current todo list (the last state written by todo_write).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    ctx.signal.throwIfAborted()
    // PHASE 4A.4B - same single entry capture as the write path. A concurrent
    // write rebinding the global must not decide which session this read observes.
    const { sessionId, cwd } = todoOperationContext(ctx)
    const list = await loadTodos(sessionId, cwd)
    if (list.length === 0) return "(no todos yet — use todo_write to create one)"
    return renderTodos(list)
  },
}
