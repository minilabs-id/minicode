// Jurnal intent mutasi — otoritas komitmen lapisan aplikasi. Menjawab satu
// pertanyaan: "status komitmen mutasi X?" Intent ditulis setelah permission+
// validate dan sebelum execute; terminal saat execution:completed; finalize saat
// turn durable di SQLite (hanya ini yang boleh di-cleanup). Bukan transaksi
// FS+DB, checkpoint, atau penentu redo (resume = verify-first). Gagal
// append/fsync tak menggagalkan turn, tapi menandai sesi degraded + warn;
// resume memakai jalur advisory.

import { createHash } from "node:crypto"
import { unlinkSync } from "node:fs"
import { mkdir, open, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { sanitizeSessionPart } from "../lib/session-id.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { classifyContractTool } from "../policy/tool-contract.ts"
import { isMcpToolName } from "../presentation/label.ts"

/**
 * Jurnal sesi = Canonical Recovery Authority untuk intent/receipt/verification.
 * `runtime/execution-journal.ts` hanya Diagnostic Audit Projection (merekam,
 * bukan memutus recovery). Konstanta ini penanda authority lokal agar source
 * of truth tak tertukar.
 */
export const SESSION_JOURNAL_AUTHORITY = "canonical_recovery_ledger" as const

// `unknown` = terminal ambigu: efek tak terbukti terjadi (mis. timeout bash).
// Bukan `failed`/`pending` — recovery wajib verifikasi sebelum mengulang.
export type JournalState = "pending" | "committed" | "failed" | "unknown"

/** Satu definisi "terminal" agar `unknown` tak pernah dianggap pending. */
const TERMINAL_JOURNAL_STATES: ReadonlySet<string> = new Set(["committed", "failed", "unknown"])

export function isTerminalJournalState(state: JournalState | undefined): boolean {
  return state !== undefined && TERMINAL_JOURNAL_STATES.has(state)
}

export type VerificationMethod =
  | "filesystem-read-back"
  | "checkpoint-diff"
  | "git-state"
  | "external-acknowledgement"
  | "existing-verifier"
  | "human-resolution"

export type VerificationVerdict = "present" | "absent" | "inconclusive"

const VERIFICATION_METHODS: ReadonlySet<VerificationMethod> = new Set([
  "filesystem-read-back",
  "checkpoint-diff",
  "git-state",
  "external-acknowledgement",
  "existing-verifier",
  "human-resolution",
])

export function isVerificationMethod(method: string): method is VerificationMethod {
  return VERIFICATION_METHODS.has(method as VerificationMethod)
}

export interface JournalOutcome {
  code?: number | null
  note?: string
  /** Acknowledgement hasil pengamatan aplikasi, bukan bukti efek universal. */
  ack?: string | number | boolean | null
  ackSource?: "bash-exit" | "sandbox-exit" | "git-commit" | "external-response" | "absent"
  ackAuthority?: "application-observed"
  truncated?: true
  timeout?: true
  aborted?: true
  /** Child turn dipotong batas max_steps (bukan timeout/abort). */
  maxStepsExceeded?: true
  loss?: "none" | "response" | "persistence" | "unknown"
  uncertainty?: "none" | "ambiguous-effect" | "unverified-external" | "evidence-incomplete"
  observedAt?: number
  /** Observasi bounded turn anak (delegate-task) — bukan otoritas baru: tak
   * mengubah `committed`/`failed` atau menggantikan verifikasi. Opsional untuk
   * kompatibilitas record lama; bukan bukti efek. */
  childResult?: ChildResultEnvelope
}

/** Status observasi anak dari sisi pemanggil: `returned` = runner kembali
 * normal (ringkasan boleh berisi teks error anak); `failed_to_start` = runner
 * tak pernah jalan. */
export type ChildStatus =
  | "returned"
  | "timeout"
  | "aborted"
  | "max_steps_exceeded"
  | "error"
  | "failed_to_start"

/** Amplop hasil anak bounded + disanitasi: `resultSummary` bukan transkrip;
 * `null` = data tak tersedia (jangan difabrikasi). */
/** Verdict consequence-engine (ACE-Lite) dari hasil anak. */
export interface AceResultSnapshot {
  readonly verdict: import("../policy/consequence-engine.ts").AceVerdict
  readonly failureClass: import("../policy/consequence-engine.ts").AceFailureClass
  readonly nextAction: import("../policy/consequence-engine.ts").AceNextAction
  readonly rationale?: string
}

export interface ChildResultEnvelope {
  readonly childStatus: ChildStatus
  readonly resultSummary: string
  readonly runId: string | null
  readonly steps: number | null
  readonly truncated: boolean
  /** Hasil deterministik consequence-engine untuk turn anak (PASS/FAIL);
   * absent = runner legacy yang belum menghitung ACE. */
  readonly aceVerdict?: AceResultSnapshot
}

export interface JournalRecord {
  v: 1
  /** Identity utama: `${session}:${seq}` (seq monotonik per jurnal). */
  id: string
  session: string
  /** Rantai delegasi: id sesi parent (diisi wiring factory-site). */
  childOf?: string
  /** Nomor turn kernel saat intent (narrative; boleh null). */
  turn?: number | null
  seq: number
  tool: string
  /** mutation (default) | verification | undo | redo | finalize. Marker bukan intent. */
  kind?: "mutation" | "verification" | "undo" | "redo" | "finalize"
  /** true = klaim sukses berasal dari pihak remote (MCP), bukan komit lokal. */
  remote?: true
  /** Backend code_run ("docker"|"os"|...) — alat interpretasi, bukan kontrol. */
  backend?: string
  /** Workspace root saat record ditulis (deteksi resume-beda-cwd). */
  cwd: string
  /** Path relatif-workspace untuk verification (allowlist per kelas-tool). */
  paths?: string[]
  /** Thread history kanonik untuk intent ini (scope invokasi). */
  threadId?: string
  /** Kunci invokasi milik aplikasi (id provider hanya penanda lokasi). */
  invocationId?: string
  /** Id panggilan provider bila ada; tak pernah kanonik sendiri. */
  providerToolCallId?: string
  /** SHA-256 JSON kanonisal argumen — identitas, BUKAN replay (tanpa raw args). */
  argsHash?: string
  /** Hash target SEBELUM efek (SHA-256) atau `null` bila file belum ada.
   * Hanya jalur pre-flight yang menulisnya; absent = rekonsiliasi UNKNOWN. */
  preTargetHash?: string | null
  /** Hash target yang diharapkan pasca-efek; `null` = target diharapkan tak ada.
   * Absent (isi tak bisa diturunkan dari argumen) → UNKNOWN bila isi berubah. */
  postTargetHash?: string | null
  /** Tautan delegasi: id sesi anak (parent-side record). */
  childSessionId?: string
  // Korelator execution: `id` tetap identitas utama; field ini opsional.
  // Lima field di bawah DEPRECATED: produksi tak mengisinya. Korelasi runtime
  // milik `src/runtime/execution-journal.ts`; jurnal ini tetap domain mutasi.
  // Jangan tambah caller produksi. Field dipertahankan agar record lama terbaca.
  /** Identity instance execution (allocated / derived stabil). DEPRECATED (lihat catatan). */
  executionId?: string
  /** Parent execution (absen pada root). DEPRECATED (lihat catatan). */
  parentExecutionId?: string
  /** Root forest korelasi (immutable). DEPRECATED (lihat catatan). */
  rootExecutionId?: string
  /** Kind datar M1. DEPRECATED (lihat catatan). */
  executionKind?: string
  /** Owner menurut arsitektur; bukan authority user input. DEPRECATED (lihat catatan). */
  ownerId?: string
  /** Marker finalize: semua seq ≤ ini durable. */
  uptoSeq?: number
  /** Marker undo/redo: turn target manifest. */
  targetTurn?: number
  /** Pointer manifest pasca-operasi: ditulis setelah apply file, sebelum save
   * manifest — crash di antaranya meninggalkan bukti rekonsiliasi. */
  newIndex?: number
  /** Marker undo/redo: jumlah file yang berhasil di-apply (info, bukan janji). */
  files?: number
  /** Hanya untuk kind mutation. Terminal immutable (lihat consolidate). */
  state?: JournalState
  outcome?: JournalOutcome
  /** Hanya kind verification: metode observasi dan verdict eksplisit. */
  method?: VerificationMethod
  verdict?: VerificationVerdict
  /** Penunjuk observasi eksternal discrub + dipotong (bukan konten mentah). */
  evidenceReference?: string
  /** Waktu observasi eksternal (boleh beda dari waktu append). */
  observedAt?: number
  /** Bukti dedup idempotency dipertahankan sweep agar retry id-sama pasca-
   * restart terdeteksi (MCP: note = `req:<id>:<argsHash>`). */
  dedup?: true
  ts: number
}

// ── Klasifikasi closed-set berbasis efek aktual ──
// MUTATION = execute() bisa berdampak durable; "none" = terbukti tanpa efek.
// Berasal dari registry kontrak tool; tool tak dikenal tetap fail-closed
// diperlakukan sebagai mutasi.

export function classifyTool(name: string): "mutation" | "none" | "unknown" {
  // Nama bertitik (server.tool) = kelas mcp_call; sudah ditangani kontrak.
  return classifyContractTool(name)
}

export function isMutationTool(name: string): boolean {
  // unknown = mutasi (fail-closed): tool baru yang belum didaftarkan tetap
  // terjurnal. `classifyTool` tetap mengembalikan "unknown" untuk guard test.
  return classifyTool(name) !== "none"
}

/** Tool registry yang dicakup wrapper awaited (mode canonical). */
export function isCanonicalEvidenceCovered(name: string): boolean {
  // Jalur khusus punya pasangan intent/terminal sendiri: delegate_task menulis
  // eksplisit; MCP runtime bertitik tetap di jalur event.
  return isMutationTool(name) && !NO_AUTO_JOURNAL.has(name) && !isMcpToolName(name)
}

// delegate_task dicatat eksplisit oleh tool-nya sendiri (butuh childSessionId
// yang hanya diketahui di sana) — wiring generik melewatinya agar tak ganda.
const NO_AUTO_JOURNAL: ReadonlySet<string> = new Set(["delegate_task"])

// ── Hash & paths (tanpa rahasia di jurnal) ──

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`
}

export function hashArgs(args: unknown): string {
  return createHash("sha256")
    .update(canonicalize(args ?? {}))
    .digest("hex")
}

// ── Tag hasil tool ambigu ──
// `ToolResult` kernel FROZEN hanya `{content, isError}`, jadi UNKNOWN memakai
// prefix deterministik di `content` (bukan field baru). Parser return `null`
// untuk hasil normal, menjaga perilaku pemanggil lama.
// Format: [TOOL_OUTCOME state=UNKNOWN reason=… side_effect_tier=… …]
export interface ToolOutcomeTag {
  readonly state: "UNKNOWN"
  readonly reason: string
  readonly sideEffectTier: string
  readonly durationMs: number | null
  readonly timeoutMs: number | null
}

const TOOL_OUTCOME_RE =
  /^\[TOOL_OUTCOME state=UNKNOWN reason=([A-Z_]+) side_effect_tier=([A-Z_]+)([^\]]*)\]/

export function parseToolOutcomeTag(content: string): ToolOutcomeTag | null {
  if (typeof content !== "string") return null
  const m = TOOL_OUTCOME_RE.exec(content)
  if (!m) return null
  const numeric = (key: string): number | null => {
    const mm = new RegExp(`(?:^|\\s)${key}=(\\d+)(?:\\s|$)`).exec(m[3] ?? "")
    return mm ? Number(mm[1]) : null
  }
  return {
    state: "UNKNOWN",
    reason: m[1]!,
    sideEffectTier: m[2]!,
    durationMs: numeric("duration_ms"),
    timeoutMs: numeric("timeout_ms"),
  }
}

/** Ambil path verifikasi (relatif, di dalam root) sesuai kelas tool. */
export function verifyPaths(tool: string, args: unknown, cwd: string): string[] {
  const a = (args ?? {}) as Record<string, unknown>
  const pick = (p: unknown): string | null => {
    if (typeof p !== "string" || !p) return null
    const rel = relative(cwd, resolve(cwd, p)).replace(/\\/g, "/")
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
    return rel
  }
  const many = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .map(pick)
      .filter((x): x is string => x !== null)
      .slice(0, 20)
  switch (tool) {
    case "write_file":
    case "edit":
    case "apply_patch":
    case "delete_file": {
      const p = pick(a.path)
      return p ? [p] : []
    }
    case "move_file": {
      const out = [pick(a.path ?? a.from), pick(a.destination ?? a.to)].filter(
        (x): x is string => x !== null,
      )
      return out
    }
    case "git_commit":
      return many(a.paths)
    default:
      return []
  }
}

// ── Hash target pra/pasca mutasi ──
// Setelah crash, recovery membedakan "belum terjadi"/"selesai"/"setengah
// tertulis" tanpa mengulang mutasi. Bukti hanya dikumpulkan sebelum efek
// (jalur pre-flight); batas ukuran mencegah membaca file raksasa.

const TARGET_HASH_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
])

/** Batas baca hash: di atas ini bukti hash dilewati (rekonsiliasi = UNKNOWN). */
const TARGET_HASH_MAX_BYTES = 8 * 1024 * 1024

async function hashFileOrNull(
  abs: string,
): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const st = await stat(abs)
    if (!st.isFile() || st.size > TARGET_HASH_MAX_BYTES) return { ok: false }
    const bytes = await readFile(abs)
    return { ok: true, hash: createHash("sha256").update(bytes).digest("hex") }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, hash: null }
    return { ok: false }
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Hash pra-efek (+pasca bila bisa diturunkan). Tak pernah melempar: gagal
 * baca = field absen, bukan alasan menggagalkan tool. */
async function targetHashesFor(
  name: string,
  args: Record<string, unknown>,
  root: string,
): Promise<{ preTargetHash?: string | null; postTargetHash?: string | null }> {
  if (!TARGET_HASH_TOOLS.has(name)) return {}
  const paths = verifyPaths(name, args, root)
  const rel = paths[0]
  if (!rel) return {}
  const pre = await hashFileOrNull(resolve(root, rel))
  if (!pre.ok) return {}
  const out: { preTargetHash?: string | null; postTargetHash?: string | null } = {
    preTargetHash: pre.hash,
  }
  if (name === "write_file" && typeof args.content === "string") {
    out.postTargetHash = sha256Text(args.content)
  } else if (name === "delete_file") {
    // Field hadir dengan nilai null = "diharapkan tidak ada setelah efek".
    out.postTargetHash = null
  } else if (name === "move_file" && paths[1] && pre.hash !== null) {
    // move_file memindahkan isi sumber ke tujuan (paths[1]); isi akhir tujuan
    // diharapkan sama dengan hash pra-efek sumber.
    out.postTargetHash = pre.hash
  }
  // edit/apply_patch: isi akhir tak bisa diturunkan dari argumen →
  // postTargetHash absen (UNKNOWN bila isi berubah dari pre).
  return out
}

export type WorkspaceMutationVerdict = "CONFIRMED_NOT_EXECUTED" | "CONFIRMED_EXECUTED" | "UNKNOWN"

export interface WorkspaceReconciliation {
  readonly verdict: WorkspaceMutationVerdict
  readonly targetPath: string | null
  readonly observedHash: string | null
  readonly reason: string
}

function resolveContainedPath(root: string, rel: string): string | null {
  const abs = resolve(root, rel)
  const back = relative(root, abs).replace(/\\/g, "/")
  if (!back || back.startsWith("..") || isAbsolute(back)) return null
  return abs
}

/** Rekonsiliasi intent mutasi terhadap disk saat ini (urutan penting):
 *  0. dua path (move_file) → verifikasi sumber & tujuan terhadap preTargetHash
 *  1. isi == pre dan != post → CONFIRMED_NOT_EXECUTED
 *  2. post diketahui dan isi == post (kecuali pre==post==null) → CONFIRMED_EXECUTED
 *  3. selainnya → UNKNOWN (aman: verifikasi, bukan ulang mutasi). */
export async function reconcileWorkspaceMutationIntent(
  record: Pick<JournalRecord, "paths" | "preTargetHash" | "postTargetHash">,
  workspaceRoot: string,
): Promise<WorkspaceReconciliation> {
  const root = resolve(workspaceRoot)
  const rel = record.paths?.[0]
  if (!rel) {
    return { verdict: "UNKNOWN", targetPath: null, observedHash: null, reason: "no-target-path" }
  }
  const abs = resolveContainedPath(root, rel)
  if (!abs) {
    return { verdict: "UNKNOWN", targetPath: rel, observedHash: null, reason: "path-outside-root" }
  }
  const destRel = record.paths?.[1]
  let absDest: string | null = null
  if (destRel !== undefined) {
    absDest = resolveContainedPath(root, destRel)
    if (!absDest) {
      return {
        verdict: "UNKNOWN",
        targetPath: destRel,
        observedHash: null,
        reason: "path-outside-root",
      }
    }
  }
  if (record.preTargetHash === undefined) {
    return {
      verdict: "UNKNOWN",
      targetPath: rel,
      observedHash: null,
      reason: "no-pre-target-hash",
    }
  }

  const pre = record.preTargetHash
  if (destRel && absDest) {
    if (pre === null) {
      return {
        verdict: "UNKNOWN",
        targetPath: rel,
        observedHash: null,
        reason: "source-absent-before-move",
      }
    }
    const [observedSrc, observedDest] = await Promise.all([
      hashFileOrNull(abs),
      hashFileOrNull(absDest),
    ])
    if (!observedSrc.ok || !observedDest.ok) {
      return {
        verdict: "UNKNOWN",
        targetPath: !observedSrc.ok ? rel : destRel,
        observedHash: null,
        reason: "target-unreadable",
      }
    }
    const sameCasePath = abs.toLowerCase() === absDest.toLowerCase()
    if (!sameCasePath && observedSrc.hash === null && observedDest.hash === pre) {
      return {
        verdict: "CONFIRMED_EXECUTED",
        targetPath: destRel,
        observedHash: observedDest.hash,
        reason: "moved-to-destination",
      }
    }
    if (!sameCasePath && observedSrc.hash === pre && observedDest.hash !== pre) {
      return {
        verdict: "CONFIRMED_NOT_EXECUTED",
        targetPath: rel,
        observedHash: observedSrc.hash,
        reason: "source-intact",
      }
    }
    return {
      verdict: "UNKNOWN",
      targetPath: destRel,
      observedHash: observedDest.hash,
      reason: "move-state-ambiguous",
    }
  }

  const observed = await hashFileOrNull(abs)
  if (!observed.ok) {
    return { verdict: "UNKNOWN", targetPath: rel, observedHash: null, reason: "target-unreadable" }
  }
  const post = record.postTargetHash
  if (pre === null && post === null && observed.hash === null) {
    return {
      verdict: "UNKNOWN",
      targetPath: rel,
      observedHash: null,
      reason: "target-already-absent",
    }
  }
  if (observed.hash === pre && post !== pre) {
    return {
      verdict: "CONFIRMED_NOT_EXECUTED",
      targetPath: rel,
      observedHash: observed.hash,
      reason: "content-matches-pre",
    }
  }
  if (post !== undefined && observed.hash === post) {
    return {
      verdict: "CONFIRMED_EXECUTED",
      targetPath: rel,
      observedHash: observed.hash,
      reason: "content-matches-post",
    }
  }
  return {
    verdict: "UNKNOWN",
    targetPath: rel,
    observedHash: observed.hash,
    reason: "content-differs-from-known-states",
  }
}

// ── Lokasi & state penulis ──

function sanitizeId(s: string): string {
  // Delegasi ke sanitizer bersama agar pemetaan id konsisten.
  return sanitizeSessionPart(s)
}

export function journalPath(sessionId: string, cwd?: string): string {
  return resolve(cwd ?? process.cwd(), ".minicode", `journal-${sanitizeId(sessionId)}.jsonl`)
}

export function deleteJournalFile(sessionId: string, cwd?: string): void {
  // Best-effort sinkron: unlinkSync selesai sebelum fungsi kembali (kontrak
  // `: void`); jangan pakai import async — memicu race baca-jurnal.
  const p = journalPath(sessionId, cwd)
  invalidateJournalCache(p)
  try {
    unlinkSync(p)
  } catch {
    // Best-effort: file mungkin memang sudah tak ada.
  }
}

/** Jurnal yatim untuk purge TTL: sesi tak dikenal, tak dirujuk delegasi, dan
 * lebih tua dari TTL. File tak terbaca dilewati (yatim tak terbukti). */
export async function findOrphanJournals(
  journalDir: string,
  knownSessionIds: Set<string>,
  ttlDays: number,
  nowMs = Date.now(),
): Promise<string[]> {
  const { readdir, readFile: readF, stat } = await import("node:fs/promises")
  let entries: string[]
  try {
    entries = await readdir(journalDir)
  } catch {
    return []
  }
  const files = entries.filter((f) => f.startsWith("journal-") && f.endsWith(".jsonl"))
  // Pass 1: kumpulkan referensi anak; parent hidup melindungi jurnal anaknya.
  const referenced = new Set<string>()
  const owners = new Map<string, string>() // file → owner session
  for (const f of files) {
    const full = join(journalDir, f)
    let raw: string
    try {
      raw = await readF(full, "utf8")
    } catch {
      continue // unreadable → jangan sentuh (lihat kontrak di atas)
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as { session?: unknown; childSessionId?: unknown }
        if (typeof r.session === "string" && !owners.has(f)) owners.set(f, r.session)
        if (typeof r.childSessionId === "string") referenced.add(r.childSessionId)
      } catch {
        break // baris korup: pemilik dari record valid sebelumnya (atau tak ada)
      }
    }
    if (!owners.has(f)) {
      // File kosong/penuh-sampah-terbaca: fallback stem nama (best-effort).
      owners.set(f, f.slice("journal-".length, -".jsonl".length))
    }
  }
  // Pass 2: yatim = pemilik asing + tak dirujuk + tua.
  const cutoff = nowMs - ttlDays * 24 * 60 * 60 * 1000
  const orphans: string[] = []
  for (const f of files) {
    const owner = owners.get(f)
    if (!owner || knownSessionIds.has(owner) || referenced.has(owner)) continue
    try {
      const st = await stat(join(journalDir, f))
      if (st.mtimeMs < cutoff) orphans.push(join(journalDir, f))
    } catch {}
  }
  return orphans.sort()
}

interface WriterState {
  nextSeq: number
  healthy: boolean
}

const writers = new Map<string, WriterState>()
/** File yang gagal dibuat/ditulis (di luar map writers agar tak merusak seq). */
const degradedFiles = new Set<string>()

function writerKey(session: string, cwd: string): string {
  return `${resolve(cwd)}::${session}`
}

// ── Serialisasi per-file ──
// Alokasi seq + append harus atomik: dua intent konkuren membaca nextSeq sama
// berisiko tabrakan id. Gunakan rantai promise per file, dan hindari memanggil
// API terkunci lain secara bersarang dari dalam callback agar tidak deadlock.
const fileLocks = new Map<string, Promise<void>>()

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key)
  let release!: () => void
  const gate = new Promise<void>((res) => {
    release = res
  })
  fileLocks.set(key, gate)
  if (prev) {
    try {
      await prev
    } catch {}
  }
  try {
    return await fn()
  } finally {
    release()
    // Lepas rantai promise setelah antrean kosong supaya sesi panjang/multi-child tidak membocorkan key.
    if (fileLocks.get(key) === gate) fileLocks.delete(key)
  }
}

export function isJournalHealthy(sessionId: string, cwd?: string): boolean {
  const root = resolve(cwd ?? process.cwd())
  if (degradedFiles.has(journalPath(sessionId, root))) return false
  return writers.get(writerKey(sessionId, root))?.healthy ?? true
}

function markDegraded(sessionId: string, cwd: string, why: string): void {
  degradedFiles.add(journalPath(sessionId, cwd))
  const st = writers.get(writerKey(sessionId, cwd))
  if (st) st.healthy = false
  process.stderr.write(`[warn] journal degraded (${why})\n`)
}

// ── Tulis durabel: append → flush/fsync (§10) ──

// Cache baca JSONL in-memory koheren-penulis (tervalidasi stat ino/mtimeNs/ctimeNs/size)
// agar findIdempotentInvocation, persistEffectReceipt, & observer tidak membaca
// ulang dan JSON.parse seluruh jurnal pada setiap pemanggilan tool.
const JOURNAL_CACHE_MAX = 64
interface JournalCacheEntry {
  ino: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  size: bigint
  records: JournalRecord[]
  status: "valid" | "empty"
  hasVerification: boolean
}
const journalCache = new Map<string, JournalCacheEntry>()

function setJournalCache(path: string, entry: JournalCacheEntry): void {
  journalCache.delete(path)
  journalCache.set(path, entry)
  while (journalCache.size > JOURNAL_CACHE_MAX) {
    const oldest = journalCache.keys().next().value
    if (oldest === undefined) break
    journalCache.delete(oldest)
  }
}

const activeJournalWrites = new Map<string, number>()
let journalMutationSeq = 0

function beginJournalWrite(path: string): void {
  activeJournalWrites.set(path, (activeJournalWrites.get(path) ?? 0) + 1)
  journalMutationSeq++
}

function endJournalWrite(path: string): void {
  const left = (activeJournalWrites.get(path) ?? 1) - 1
  if (left <= 0) activeJournalWrites.delete(path)
  else activeJournalWrites.set(path, left)
  journalMutationSeq++
}

function invalidateJournalCache(path: string): void {
  journalCache.delete(path)
  journalMutationSeq++
}

async function appendLine(path: string, obj: JournalRecord): Promise<boolean> {
  const line = `${JSON.stringify(obj)}\n`
  beginJournalWrite(path)
  // Baris kecil + O_APPEND = tulis atomik antar proses (POSIX).
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
    const h = await open(path, "a")
    try {
      await h.appendFile(line, "utf8")
      await h.sync()
    } finally {
      await h.close().catch(() => {})
    }
    const cached = journalCache.get(path)
    if (cached) {
      try {
        const st = await stat(path, { bigint: true })
        const addedBytes = BigInt(Buffer.byteLength(line, "utf8"))
        if (st.ino === cached.ino && st.size === cached.size + addedBytes) {
          cached.records.push(obj)
          if (obj.kind === "verification") cached.hasVerification = true
          cached.status = "valid"
          cached.mtimeNs = st.mtimeNs
          cached.ctimeNs = st.ctimeNs
          cached.size = st.size
        } else {
          invalidateJournalCache(path)
        }
      } catch {
        invalidateJournalCache(path)
      }
    }
    return true
  } catch (e) {
    invalidateJournalCache(path)
    process.stderr.write(`[warn] journal: write failed (${path}): ${(e as Error).message}\n`)
    return false
  } finally {
    endJournalWrite(path)
  }
}

async function stateFor(path: string, key: string): Promise<WriterState> {
  let st = writers.get(key)
  if (!st) {
    st = { nextSeq: 0, healthy: true }
    // Lanjutkan seq lintas restart proses (anti tabrakan id).
    const cached = journalCache.get(path)
    let populatedFromCache = false
    if (cached) {
      try {
        const fileStat = await stat(path, { bigint: true })
        if (
          fileStat.ino === cached.ino &&
          fileStat.mtimeNs === cached.mtimeNs &&
          fileStat.ctimeNs === cached.ctimeNs &&
          fileStat.size === cached.size
        ) {
          for (const r of cached.records) {
            if (typeof r.seq === "number" && Number.isFinite(r.seq)) {
              st.nextSeq = Math.max(st.nextSeq, Math.floor(r.seq) + 1)
            }
          }
          populatedFromCache = true
        }
      } catch {}
    }
    if (!populatedFromCache) {
      try {
        const raw = await readFile(path, "utf8")
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue
          try {
            const r = JSON.parse(line) as { seq?: unknown }
            if (typeof r.seq === "number" && Number.isFinite(r.seq)) {
              st.nextSeq = Math.max(st.nextSeq, Math.floor(r.seq) + 1)
            }
          } catch {}
        }
      } catch {}
    }
    if (writers.size >= 512) {
      const oldest = writers.keys().next().value
      if (oldest !== undefined) writers.delete(oldest)
    }
    writers.set(key, st)
  }
  return st
}

export interface IntentInput {
  session: string
  childOf?: string
  turn?: number | null
  tool: string
  threadId?: string
  /** Kunci invokasi milik aplikasi (provisional atau kanonik). */
  invocationId?: string
  providerToolCallId?: string
  /** Alokasi kunci kanonik dari seq jurnal di dalam lock. */
  allocateInvocationId?: (allocationSequence: number) => string
  remote?: true
  backend?: string
  cwd?: string
  paths?: string[]
  argsHash?: string
  /** [Fase 2 / LOOP-G06] Hash isi target sebelum efek (lihat JournalRecord). */
  preTargetHash?: string | null
  /** [Fase 2 / LOOP-G07] Hash target yang diharapkan setelah efek sukses. */
  postTargetHash?: string | null
  childSessionId?: string
  /** Kunci idempotency ditulis ke outcome.note sejak intent agar crash saat
   * eksekusi tetap meninggalkan bukti yang bisa dicocokkan. */
  note?: string
  // Korelator execution passthrough; absent = perilaku lama. Validasi bentuk
  // di allocator/helper — jurnal hanya menyalin id publik (tanpa rahasia).
  executionId?: string
  parentExecutionId?: string
  rootExecutionId?: string
  executionKind?: string
  ownerId?: string
}

/** Tulis intent pending. Tak pernah throw (degraded-loud, lihat header). */
export async function appendMutationIntent(input: IntentInput): Promise<JournalRecord> {
  const root = resolve(input.cwd ?? process.cwd())
  const path = journalPath(input.session, root)
  const key = writerKey(input.session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    // Alokasi seq sinkron di dalam lock: cegah tabrakan id antar pemanggil konkuren.
    const seq = st.nextSeq
    const invocationId = input.allocateInvocationId
      ? input.allocateInvocationId(seq)
      : input.invocationId
    const rec: JournalRecord = {
      v: 1,
      id: `${input.session}:${seq}`,
      session: input.session,
      ...(input.childOf ? { childOf: input.childOf } : {}),
      turn: input.turn ?? null,
      seq,
      tool: input.tool,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(invocationId ? { invocationId } : {}),
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      ...(input.remote ? { remote: true as const } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      cwd: root,
      ...(input.paths?.length ? { paths: input.paths } : {}),
      ...(input.argsHash ? { argsHash: input.argsHash } : {}),
      ...(input.preTargetHash !== undefined ? { preTargetHash: input.preTargetHash } : {}),
      ...(input.postTargetHash !== undefined ? { postTargetHash: input.postTargetHash } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      // M1 correlator passthrough (absent = tak ada perubahan perilaku).
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
      ...(input.rootExecutionId ? { rootExecutionId: input.rootExecutionId } : {}),
      ...(input.executionKind ? { executionKind: input.executionKind } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      // Kunci idempotency sejak intent (lihat IntentInput.note).
      ...(input.note ? { outcome: { note: input.note } } : {}),
      state: "pending",
      ts: Date.now(),
    }
    // Tak pernah throw: gagal jurnal tak boleh menggagalkan turn (degraded-loud).
    if (await appendLine(path, rec)) {
      st.nextSeq = seq + 1
    } else {
      markDegraded(input.session, root, "intent append gagal")
    }
    return rec
  })
}

/** Tulis terminal (committed/failed) untuk id intent. Append-only. */
export async function appendMutationTerminal(
  session: string,
  cwd: string | undefined,
  id: string,
  seq: number,
  tool: string,
  state: "committed" | "failed" | "unknown",
  outcome?: JournalOutcome,
  childSessionId?: string,
  opts: {
    dedup?: boolean
    threadId?: string
    invocationId?: string
    providerToolCallId?: string
    argsHash?: string
    receipt?: Omit<JournalOutcome, "code" | "note">
    // M1 correlator passthrough (absent = terminal legacy tanpa korelasi).
    executionId?: string
    parentExecutionId?: string
    rootExecutionId?: string
    executionKind?: string
    ownerId?: string
  } = {},
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    await stateFor(path, key)
    const rec: JournalRecord = {
      v: 1,
      id,
      session,
      seq,
      tool,
      state,
      cwd: root,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
      ...(opts.providerToolCallId ? { providerToolCallId: opts.providerToolCallId } : {}),
      ...(opts.argsHash ? { argsHash: opts.argsHash } : {}),
      ...(outcome || opts.receipt
        ? {
            outcome: {
              ...(outcome ?? {}),
              ...(opts.receipt ?? {}),
              ...(opts.receipt?.observedAt === undefined ? { observedAt: Date.now() } : {}),
            },
          }
        : {}),
      // Tautan delegasi diwariskan agar pembaca tak perlu join intent-terminal.
      ...(childSessionId ? { childSessionId } : {}),
      // Bukti dedup idempotency (mis. MCP request id): dipertahankan sweep.
      ...(opts.dedup ? { dedup: true as const } : {}),
      // M1 correlator passthrough terminal (diwariskan dari intent pemanggil).
      ...(opts.executionId ? { executionId: opts.executionId } : {}),
      ...(opts.parentExecutionId ? { parentExecutionId: opts.parentExecutionId } : {}),
      ...(opts.rootExecutionId ? { rootExecutionId: opts.rootExecutionId } : {}),
      ...(opts.executionKind ? { executionKind: opts.executionKind } : {}),
      ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      ts: Date.now(),
    }
    const st = writers.get(key)
    if (!(await appendLine(path, rec)) && st) markDegraded(session, root, "terminal append gagal")
  })
}

/** Tulis observasi efek eksternal mandiri (VerificationRecord). */
export async function appendVerificationRecord(input: {
  session: string
  threadId?: string
  tool: string
  invocationId: string
  method: VerificationMethod
  verdict: VerificationVerdict
  evidenceReference: string
  observedAt?: number
  cwd?: string
  childOf?: string
  childSessionId?: string
  providerToolCallId?: string
}): Promise<{ record: JournalRecord; durable: boolean }> {
  if (!input.tool) throw new Error("verification: refusing record without tool")
  if (!input.invocationId) throw new Error("verification: refusing record without invocationId")
  if (!VERIFICATION_METHODS.has(input.method)) {
    throw new Error(`verification: unsupported method ${String(input.method)}`)
  }
  if (
    input.verdict !== "present" &&
    input.verdict !== "absent" &&
    input.verdict !== "inconclusive"
  ) {
    throw new Error(`verification: unsupported verdict ${String(input.verdict)}`)
  }
  const evidenceReference = scrubSecrets(String(input.evidenceReference ?? "")).slice(0, 1000)
  if (!evidenceReference) throw new Error("verification: refusing record without evidenceReference")
  const root = resolve(input.cwd ?? process.cwd())
  const path = journalPath(input.session, root)
  const key = writerKey(input.session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const observedAt =
      typeof input.observedAt === "number" && Number.isFinite(input.observedAt)
        ? input.observedAt
        : Date.now()
    const rec: JournalRecord = {
      v: 1,
      id: `${input.session}:v${seq}`,
      session: input.session,
      seq,
      tool: input.tool,
      kind: "verification",
      ...(input.childOf ? { childOf: input.childOf } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      invocationId: input.invocationId,
      ...(input.providerToolCallId ? { providerToolCallId: input.providerToolCallId } : {}),
      ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
      method: input.method,
      verdict: input.verdict,
      evidenceReference,
      observedAt,
      cwd: root,
      ts: Date.now(),
    }
    const durable = await appendLine(path, rec)
    if (durable) st.nextSeq = seq + 1
    else markDegraded(input.session, root, "verification append gagal")
    return { record: rec, durable }
  })
}

/** Marker finalize: semua seq ≤ uptoSeq durable (post-persistCurrent). */
export async function appendFinalize(
  session: string,
  cwd: string | undefined,
  uptoSeq: number,
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const rec: JournalRecord = {
      v: 1,
      id: `${session}:f${seq}`,
      session,
      seq,
      tool: "",
      kind: "finalize",
      uptoSeq,
      cwd: root,
      ts: Date.now(),
    }
    if (await appendLine(path, rec)) st.nextSeq = seq + 1
    else markDegraded(session, root, "finalize append gagal")
  })
}

/** Marker undo/redo: posisi workspace pasca-operasi (DB tak ikut). */
export async function appendUndoMarker(
  session: string,
  cwd: string | undefined,
  kind: "undo" | "redo",
  targetTurn: number,
  extra?: { newIndex?: number; files?: number },
): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(session, root)
  const key = writerKey(session, root)
  return withFileLock(key, async () => {
    const st = await stateFor(path, key)
    const seq = st.nextSeq
    const rec: JournalRecord = {
      v: 1,
      id: `${session}:m${seq}`,
      session,
      seq,
      tool: "",
      kind,
      targetTurn,
      cwd: root,
      ...(extra?.newIndex !== undefined ? { newIndex: extra.newIndex } : {}),
      ...(extra?.files !== undefined ? { files: extra.files } : {}),
      ts: Date.now(),
    }
    if (await appendLine(path, rec)) st.nextSeq = seq + 1
    else markDegraded(session, root, "marker append gagal")
  })
}

/** Finalize + sweep: dipanggil setelah persistCurrent sukses. */
export async function finalizeJournal(sessionId: string, cwd?: string): Promise<void> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(sessionId, root)
  const key = writerKey(sessionId, root)
  const st = await stateFor(path, key)
  const maxMutation = st.nextSeq - 1
  if (maxMutation < 0) return
  await appendFinalize(sessionId, root, maxMutation)
  await sweepJournal(sessionId, root).catch((e) => {
    process.stderr.write(`[warn] journal: sweep failed: ${(e as Error).message}\n`)
  })
}

/** Sweep atomik (tmp → rename): buang terminal finalized dan marker lama.
 * Pending tak dibuang oleh finalize (finalize = persist, bukan status mutasi),
 * kecuali superseded oleh commit mutasi sama (tool+paths). Pending tanpa paths
 * bertahan sampai resolvePending eksplisit. */
export async function sweepJournal(sessionId: string, cwd?: string): Promise<number> {
  const root = resolve(cwd ?? process.cwd())
  const key = writerKey(sessionId, root)
  // Sweep vs append konkuren = lost-record: serialkan dengan penulis.
  return withFileLock(key, () => sweepInner(sessionId, root))
}

async function sweepInner(sessionId: string, root: string): Promise<number> {
  const path = journalPath(sessionId, root)
  const loaded = await loadJournal(sessionId, root)
  if (loaded.records.length === 0) return 0
  let maxUpto = -1
  for (const r of loaded.records) {
    if (r.kind === "finalize" && typeof r.uptoSeq === "number")
      maxUpto = Math.max(maxUpto, r.uptoSeq)
  }
  if (maxUpto < 0) return 0
  // Pending berpasangan dengan terminal ikut dibuang (status di terminal).
  const paired = new Set<string>()
  for (const r of loaded.records) {
    if ((!r.kind || r.kind === "mutation") && isTerminalJournalState(r.state)) {
      paired.add(r.id)
    }
  }
  const committedKeys = committedPathsKeys(loaded.records)
  // Hitung sekali di luar filter agar sweep O(n), bukan O(n²).
  const maxFinalize = maxFinalizeSeq(loaded.records)
  const keep = loaded.records.filter((r) => {
    if (r.kind === "finalize") return r.seq === maxFinalize
    if (r.kind === "undo" || r.kind === "redo") return r.seq > maxUpto
    // Bukti verification dipertahankan seperti terminal dedup: bisa jadi satu-
    // satunya observasi efek eksternal pasca-sweep. Dibatasi TTL/ukuran file.
    if (r.kind === "verification") return true
    if (r.state === "pending" && paired.has(r.id)) return false
    if (r.state === "pending") return !isSuperseded(r, committedKeys)
    // Terminal dedup dipertahankan: menghapusnya membuat retry id-sama pasca-
    // restart dieksekusi ulang buta. Intent pasangannya tetap dibuang.
    if ((!r.kind || r.kind === "mutation") && isTerminalJournalState(r.state) && r.dedup === true)
      return true
    return (r.seq ?? 0) > maxUpto // committed/failed muda bertahan
  })
  if (keep.length === loaded.records.length) return 0
  const data = keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : "")
  beginJournalWrite(path)
  try {
    invalidateJournalCache(path)
    await atomicWriteText(path, data)
  } finally {
    endJournalWrite(path)
  }
  // Sinkronkan counter in-memory dengan file hasil sweep.
  const key = writerKey(sessionId, root)
  const st = writers.get(key)
  if (st) {
    let mx = -1
    for (const r of keep) if (typeof r.seq === "number") mx = Math.max(mx, r.seq)
    st.nextSeq = mx + 1
  }
  return loaded.records.length - keep.length
}

/** Kunci supersede: tool + paths non-kosong (bash/MCP tanpa path tak ikut). */
function pathsKey(tool: string, paths?: string[]): string | null {
  if (!paths || paths.length === 0) return null
  return `${tool}|${[...paths].sort().join(",")}`
}

function committedPathsKeys(records: JournalRecord[]): Set<string> {
  const out = new Set<string>()
  // Terminal committed per id: terminal pertama menang (sama seperti decideRecovery).
  const seen = new Set<string>()
  for (const r of records) {
    if (r.kind && r.kind !== "mutation") continue
    if (r.state !== "committed" || seen.has(r.id)) continue
    seen.add(r.id)
    const k = pathsKey(r.tool, r.paths)
    if (k) out.add(`${k}@${r.seq}`)
  }
  return out
}

function isSuperseded(r: JournalRecord, committedKeys: Set<string>): boolean {
  const k = pathsKey(r.tool, r.paths)
  if (!k) return false
  for (const entry of committedKeys) {
    const at = entry.lastIndexOf("@")
    if (entry.slice(0, at) === k && Number(entry.slice(at + 1)) > r.seq) return true
  }
  return false
}

/** Resolusi manual pending → terminal dari verifikasi manusia: `applied` =
 * efek ada (jangan ulang); `absent` = efek tak ada (boleh dicoba lagi). */
export async function resolvePending(
  sessionId: string,
  cwd: string | undefined,
  seq: number,
  verdict: "applied" | "absent",
  note?: string,
): Promise<boolean> {
  const root = resolve(cwd ?? process.cwd())
  const loaded = await loadJournal(sessionId, root)
  const mine = loaded.records.filter(
    (r) => (!r.kind || r.kind === "mutation") && r.session === sessionId && r.seq === seq,
  )
  if (mine.length === 0) return false
  if (mine.some((r) => isTerminalJournalState(r.state))) return false
  const first = mine[0]!
  await appendMutationTerminal(
    sessionId,
    root,
    first.id,
    seq,
    first.tool,
    verdict === "applied" ? "committed" : "failed",
    { note: `human-verified:${verdict}${note ? ` ${note}` : ""}` },
  )
  return true
}

function maxFinalizeSeq(records: JournalRecord[]): number {
  let mx = -1
  for (const r of records) {
    if (r.kind === "finalize" && typeof r.seq === "number") mx = Math.max(mx, r.seq)
  }
  return mx
}

// ── Baca + korupsi (§9) ──

export interface JournalLoad {
  records: JournalRecord[]
  warnings: string[]
  /** Ekor terpotong (fail-closed keputusan, fail-open sesi). */
  truncatedTail: boolean
  quarantined: boolean
  /** Status file: absent = tak ada; empty = nol record; valid = ≥1 record;
   * corrupt = dikarantina/ekor-rusak; unreadable = tak terbaca (bukan kosong). */
  status: "absent" | "empty" | "valid" | "corrupt" | "unreadable"
}

function isRecordShape(r: unknown): r is JournalRecord {
  if (!r || typeof r !== "object") return false
  const o = r as Record<string, unknown>
  if (o.v !== 1 || typeof o.id !== "string" || typeof o.session !== "string") return false
  if (typeof o.seq !== "number" || !Number.isFinite(o.seq)) return false
  if (o.kind === "finalize" || o.kind === "undo" || o.kind === "redo") return true
  if (o.kind === "verification") {
    return (
      typeof o.tool === "string" &&
      o.tool !== "" &&
      typeof o.invocationId === "string" &&
      o.invocationId !== "" &&
      VERIFICATION_METHODS.has(o.method as VerificationMethod) &&
      (o.verdict === "present" || o.verdict === "absent" || o.verdict === "inconclusive") &&
      typeof o.evidenceReference === "string" &&
      o.evidenceReference !== "" &&
      typeof o.observedAt === "number" &&
      Number.isFinite(o.observedAt)
    )
  }
  if (typeof o.tool !== "string" || !o.tool) return false
  return o.state === "pending" || isTerminalJournalState(o.state as JournalState)
}

export async function loadVerificationJournal(
  sessionId: string,
  cwd?: string,
): Promise<JournalLoad & { hasVerification: boolean }> {
  return loadJournalInternal(sessionId, cwd)
}

export async function loadJournal(sessionId: string, cwd?: string): Promise<JournalLoad> {
  const { hasVerification: _hv, ...load } = await loadJournalInternal(sessionId, cwd)
  return load
}

async function loadJournalInternal(
  sessionId: string,
  cwd?: string,
): Promise<JournalLoad & { hasVerification: boolean }> {
  const root = resolve(cwd ?? process.cwd())
  const path = journalPath(sessionId, root)
  // Tangkap generasi & status tulis SEBELUM I/O async agar pembacaan konkuren yang
  // beririsan dengan append/sweep/delete tak menanam cache ber-`stBig` basi
  // bersama isi baru (yg dapat menggandakan record di appendLine berikutnya).
  const seqAtStart = journalMutationSeq
  const busyAtStart = activeJournalWrites.has(path)
  const warnings: string[] = []
  let fileStat: Awaited<ReturnType<typeof stat>> | null = null
  try {
    fileStat = (await stat(path, { bigint: true })) as unknown as Awaited<ReturnType<typeof stat>>
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      invalidateJournalCache(path)
      return {
        records: [],
        warnings,
        truncatedTail: false,
        quarantined: false,
        status: "absent",
        hasVerification: false,
      }
    }
  }
  const stBig = fileStat as unknown as {
    ino: bigint
    mtimeNs: bigint
    ctimeNs: bigint
    size: bigint
  } | null
  if (stBig) {
    const cached = journalCache.get(path)
    if (
      cached &&
      stBig.ino === cached.ino &&
      stBig.mtimeNs === cached.mtimeNs &&
      stBig.ctimeNs === cached.ctimeNs &&
      stBig.size === cached.size
    ) {
      journalCache.delete(path)
      journalCache.set(path, cached)
      return {
        records: cached.records.slice(),
        warnings: [],
        truncatedTail: false,
        quarantined: false,
        status: cached.status,
        hasVerification: cached.hasVerification,
      }
    }
  }
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    // ENOENT = absent; error lain = unreadable (bukan empty).
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      invalidateJournalCache(path)
      return {
        records: [],
        warnings,
        truncatedTail: false,
        quarantined: false,
        status: "absent",
        hasVerification: false,
      }
    }
    invalidateJournalCache(path)
    warnings.push(`journal tak terbaca (${path}): ${(e as Error).message}`)
    return {
      records: [],
      warnings,
      truncatedTail: false,
      quarantined: false,
      status: "unreadable",
      hasVerification: false,
    }
  }
  const lines = raw.split("\n")
  // Baris akhir kosong = terminator normal, bukan truncasi.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  const records: JournalRecord[] = []
  let hasVerification = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      invalidateJournalCache(path)
      const r = await handleCorrupt(
        path,
        lines,
        i,
        records,
        warnings,
        `baris ${i + 1} bukan JSON valid`,
      )
      return {
        ...r,
        status: "corrupt",
        hasVerification: r.records.some((rec) => rec.kind === "verification"),
      }
    }
    if (!isRecordShape(parsed)) {
      invalidateJournalCache(path)
      const r = await handleCorrupt(
        path,
        lines,
        i,
        records,
        warnings,
        `baris ${i + 1} bentuk record invalid`,
      )
      return {
        ...r,
        status: "corrupt",
        hasVerification: r.records.some((rec) => rec.kind === "verification"),
      }
    }
    if (parsed.kind === "verification") hasVerification = true
    records.push(parsed)
  }
  const status: "valid" | "empty" = records.length > 0 ? "valid" : "empty"
  if (
    stBig &&
    !busyAtStart &&
    !activeJournalWrites.has(path) &&
    journalMutationSeq === seqAtStart &&
    BigInt(Buffer.byteLength(raw, "utf8")) === stBig.size
  ) {
    setJournalCache(path, {
      ino: stBig.ino,
      mtimeNs: stBig.mtimeNs,
      ctimeNs: stBig.ctimeNs,
      size: stBig.size,
      records: records.slice(),
      status,
      hasVerification,
    })
  }
  return {
    records,
    warnings,
    truncatedTail: false,
    quarantined: false,
    status,
    hasVerification,
  }
}

async function handleCorrupt(
  path: string,
  lines: string[],
  at: number,
  prefix: JournalRecord[],
  warnings: string[],
  reason: string,
): Promise<JournalLoad> {
  const isTail = at === lines.length - 1
  if (isTail) {
    // Ekor terpotong (crash mid-append): buang baris, pakai prefix.
    warnings.push(
      `journal korup di ekor (${reason}) — baris dibuang, prefix (${prefix.length} record) tetap otoritatif`,
    )
    beginJournalWrite(path)
    try {
      invalidateJournalCache(path)
      await atomicWriteText(
        path,
        prefix.map((r) => JSON.stringify(r)).join("\n") + (prefix.length ? "\n" : ""),
      )
    } catch {
    } finally {
      endJournalWrite(path)
    }
    return { records: prefix, warnings, truncatedTail: true, quarantined: false, status: "corrupt" }
  }
  // Tengah korup: quarantine + pertahankan prefix sebagai live.
  const qpath = `${path}.corrupt.${Date.now()}`
  warnings.push(
    `journal KORUP di tengah (${reason}) — file dikarantina ke ${qpath}; prefix (${prefix.length} record) dipakai, suffix dianggap pending/ambigu`,
  )
  beginJournalWrite(path)
  try {
    invalidateJournalCache(path)
    await atomicWriteText(qpath, lines.join("\n"))
    await atomicWriteText(
      path,
      prefix.map((r) => JSON.stringify(r)).join("\n") + (prefix.length ? "\n" : ""),
    )
  } catch {
  } finally {
    endJournalWrite(path)
  }
  return { records: prefix, warnings, truncatedTail: false, quarantined: true, status: "corrupt" }
}

// ── Keputusan resume murni: decideRecovery (tanpa I/O) ──

export interface AttentionItem {
  id: string
  seq: number
  tool: string
  state: JournalState
  remote: boolean
  paths: string[]
  childSessionId?: string
  turn?: number | null
}

export interface RecoveryPlan {
  clean: boolean
  /** SATU blok SYSTEM (blocking + stitch + remote). null bila clean. */
  directive: string | null
  warnings: string[]
  attention: AttentionItem[]
  stitched: { id: string; tool: string; turn?: number | null }[]
  stats: {
    pending: number
    failed: number
    committed: number
    /** [Fase 2 / LOOP-INV-07] Terminal ambigu: efek belum bisa dipastikan. */
    unknown: number
    finalized: number
    markers: number
  }
}

const MAX_DIRECTIVE_ITEMS = 10

export function decideRecovery(
  records: JournalRecord[],
  persistedTurns: number[],
  opts: { maxItems?: number } = {},
): RecoveryPlan {
  const warnings: string[] = []
  const maxItems = opts.maxItems ?? MAX_DIRECTIVE_ITEMS
  // Konsolidasi per id: terminal pertama menang; duplikat/terminal→pending =
  // anomali → warn, abaikan tulisan basi.
  const byId = new Map<string, JournalRecord[]>()
  for (const r of records) {
    if (r.kind && r.kind !== "mutation") continue
    const list = byId.get(r.id) ?? []
    list.push(r)
    byId.set(r.id, list)
  }
  // Finalize diskop per file sesi: maxUpto global mencampur namespace parent/child.
  const uptoBySession = new Map<string, number>()
  let undoRedoCount = 0
  // Marker undo/redo untuk stitch: redo mengembalikan efek (stitch moot), undo
  // mencabutnya (warning khusus). Hanya record sesi sendiri (tanpa childOf).
  const redoMarks: { targetTurn: number; seq: number }[] = []
  const undoMarks: { targetTurn: number; seq: number }[] = []
  for (const r of records) {
    if (r.kind === "finalize" && typeof r.uptoSeq === "number") {
      uptoBySession.set(r.session, Math.max(uptoBySession.get(r.session) ?? -1, r.uptoSeq))
    }
    if (r.kind === "undo" || r.kind === "redo") {
      undoRedoCount += 1
      if (typeof r.targetTurn === "number" && typeof r.seq === "number") {
        ;(r.kind === "redo" ? redoMarks : undoMarks).push({ targetTurn: r.targetTurn, seq: r.seq })
      }
    }
  }
  const covered = (r: JournalRecord): boolean => r.seq <= (uptoBySession.get(r.session) ?? -1)
  // Anak ter-cover bila delegasi parent committed + finalized; jika tidak,
  // committed anak stitch spurius (turn anak tak ada di DB parent).
  const coveredChild = new Set<string>()
  for (const [, list] of byId) {
    const first = list[0]!
    if (first.tool !== "delegate_task" || !first.childSessionId) continue
    const term = list.find((r) => isTerminalJournalState(r.state))
    if (term?.state === "committed" && covered(term)) coveredChild.add(first.childSessionId)
  }
  // Gap seq = kemungkinan penulis ganda/hilang (peringatan, bukan blokir).
  const seqs = [...byId.values()].map((l) => l[0]!.seq).sort((a, b) => a - b)
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! - seqs[i - 1]! > 1) {
      warnings.push(
        `journal seq gap ${seqs[i - 1]} → ${seqs[i]} (kemungkinan tulis hilang/penulis ganda)`,
      )
      break
    }
  }
  const stats = {
    pending: 0,
    failed: 0,
    committed: 0,
    unknown: 0,
    finalized: 0,
    markers: undoRedoCount,
  }
  const attention: AttentionItem[] = []
  const stitched: { id: string; tool: string; turn?: number | null }[] = []
  const remoteVerify: AttentionItem[] = []
  const supersedeKeys = committedPathsKeys(records)
  for (const [, list] of [...byId.entries()].sort((a, b) => a[1][0]!.seq - b[1][0]!.seq)) {
    const first = list[0]!
    if (list.length > 1) {
      const terminals = list.filter((r) => isTerminalJournalState(r.state))
      if (terminals.length > 1) {
        warnings.push(
          `journal id duplikat ${first.id} (${terminals.length} terminal) — pakai yang pertama`,
        )
      }
      const stalePending = list.findIndex((r, i) => i > 0 && r.state === "pending")
      if (stalePending !== -1 || (terminals.length === 0 && list.length > 1)) {
        warnings.push(`journal id duplikat ${first.id} — abaikan tulisan basi`)
      }
    }
    const eff = list.find((r) => isTerminalJournalState(r.state)) ?? first
    if (!eff.state || eff.state === "pending") {
      // Superseded = mutasi sama berhasil belakangan; jangan nagih yang sudah terjawab.
      if (isSuperseded(first, supersedeKeys)) continue
      stats.pending += 1
      if (covered(first)) {
        // Ter-cover finalize tanpa terminal tetap ambigu (finalize = persist, bukan status).
        warnings.push(
          `journal ${first.id} pending tetapi ter-cover finalize — tetap diperlakukan ambigu`,
        )
      }
      attention.push(toItem(first, "pending"))
      continue
    }
    if (eff.state === "unknown") {
      // Terminal ambigu selalu butuh verifikasi: finalize membuktikan record
      // durable, bukan efek. Menyembunyikannya = auto-retry buta.
      stats.unknown += 1
      warnings.push(
        `journal ${first.id} (${first.tool}) berakhir UNKNOWN — efek belum dapat dipastikan; verifikasi sebelum mengulang`,
      )
      attention.push(toItem(first, "unknown"))
      continue
    }
    if (eff.state === "failed") {
      stats.failed += 1
      if (covered(first)) {
        stats.finalized += 1
        continue
      }
      attention.push(toItem(first, "failed"))
      continue
    }
    // committed
    if (covered(first)) {
      stats.committed += 1
      stats.finalized += 1
      continue
    }
    // Anak ter-cover transitif via delegasi parent committed + finalized.
    if (first.childOf && coveredChild.has(first.session)) {
      stats.committed += 1
      continue
    }
    stats.committed += 1
    if (first.remote) {
      remoteVerify.push(toItem(first, "committed"))
      continue
    }
    // Redo lebih baru mengembalikan efek (stitch moot; bukan auto-redo).
    // Remote dikecualikan: redo file tak memulihkan efek server.
    if (!first.childOf && first.turn != null) {
      const redone = redoMarks.some((mk) => mk.seq > first.seq && mk.targetTurn >= first.turn!)
      if (redone) continue
      // Undo lebih baru mencabut efek: stitch "anggap ada" salah → warning jujur.
      const undone = undoMarks.some((mk) => mk.seq > first.seq && first.turn! >= mk.targetTurn)
      if (undone) {
        warnings.push(
          `efek turn ${first.turn} (${first.tool}) di-undo sesudah commit — transkrip lebih baru dari file; JANGAN ulangi otomatis, JANGAN percaya penuh`,
        )
        continue
      }
    }
    // Isolasi namespace turn: turn anak tak dibandingkan dengan turn parent.
    // Anak uncovered selalu stitch (aman, tak ada cross-match kebetulan).
    if (!first.childOf) {
      const turn = first.turn ?? null
      if (turn !== null && persistedTurns.includes(turn)) continue // normal
    }
    stitched.push({ id: first.id, tool: first.tool, turn: first.turn ?? null })
  }
  const blocks: string[] = []
  const shown = attention.slice(0, maxItems)
  if (shown.length > 0) {
    blocks.push(
      "MUTASI TAK-PASTI (pending/failed/unknown) — verifikasi SEBELUM mengulang; DILARANG redo buta:",
      ...shown.map(
        (a) =>
          `- [seq ${a.seq}] ${a.tool} (${a.state})${a.paths.length ? ` paths: ${a.paths.join(", ")}` : " (tanpa path — diff workspace vs checkpoint)"}${a.childSessionId ? ` child: ${a.childSessionId}` : ""}`,
      ),
    )
    if (attention.length > shown.length) {
      blocks.push(
        `- ... +${attention.length - shown.length} lagi — minta keputusan user sebelum lanjut.`,
      )
    }
  }
  if (remoteVerify.length > 0) {
    const rshown = remoteVerify.slice(0, maxItems)
    blocks.push(
      "MUTASI REMOTE (external-acknowledged, BUKAN komit lokal) — wajib baca-balik sebelum membangun state di atasnya:",
      ...rshown.map((a) => `- [seq ${a.seq}] ${a.tool}`),
    )
  }
  if (stitched.length > 0) {
    blocks.push(
      "CATATAN NARASI (bukan blokir): mutasi berikut tercatat committed tetapi turn-nya tidak durable — JANGAN dieksekusi ulang; anggap efeknya ada:",
      ...stitched.map((s) => `- [${s.id}] ${s.tool}${s.turn != null ? ` (turn ${s.turn})` : ""}`),
    )
  }
  const clean = blocks.length === 0
  return {
    clean,
    directive: clean
      ? null
      : `[recovery] Sesi sebelumnya berhenti tak-sempurna. Ikuti aturan ini:\n${blocks.join("\n")}`,
    warnings,
    attention,
    stitched,
    stats,
  }
}

function toItem(first: JournalRecord, state: JournalState): AttentionItem {
  return {
    id: first.id,
    seq: first.seq,
    tool: first.tool,
    state,
    remote: first.remote === true,
    paths: first.paths ?? [],
    ...(first.childSessionId ? { childSessionId: first.childSessionId } : {}),
    turn: first.turn ?? null,
  }
}

// ── Wiring event (titik D: execution:started/completed) ──

interface EventBusLike {
  on(type: string, handler: (event: never) => void): () => void
}

interface SessionLike {
  events: EventBusLike
  state?: { turnCount?: number }
}

interface ExecutionEvent {
  execution?: {
    call?: { name?: unknown; args?: unknown; id?: unknown }
    result?: { isError?: unknown; content?: unknown }
  }
  /** Event child yang di-forward ke bus parent: catat hanya di jurnal anak
   * (bus asal), bukan ganda di parent. */
  forwardedChild?: unknown
}

/** Pasang jurnal pada sesi apa pun; gagal I/O tak pernah melempar ke bus turn. */
export interface MutationJournalHandle {
  /** Tulis intent dan tunggu durable, sebelum tool dieksekusi. No-op untuk
   * tool tak dijurnal (read-only/NO_AUTO_JOURNAL/canonical). */
  preflightIntent(call: { id: string; name: string; args: unknown }): Promise<void>
  /** Tunggu terminal selesai sebelum turn dinyatakan selesai (bukti sebelum status). */
  flushPending(): Promise<void>
}

export function attachMutationJournal(
  session: SessionLike,
  opts: {
    sessionId: string
    cwd?: string
    childOf?: string
    /** Kabar committed (paths+journalSeq) → composition root memancarkan
     * file.changed. Opsional; tanpa hook jurnal tetap berjalan. */
    onCommitted?: (info: {
      toolCallId: string
      paths: string[]
      journalSeq: number
      sessionId: string
      turnId?: number
    }) => void
    /** Mode canonical: tool yang dicakup wrapper awaited sudah menulis satu
     * pasangan intent/terminal. Fallback event hanya untuk jalur khusus. */
    evidenceMode?: "events" | "canonical"
  },
): MutationJournalHandle {
  const root = resolve(opts.cwd ?? process.cwd())
  // Buat file saat wiring (sebelum mutasi pertama) agar absent ≠ empty saat
  // resume. Mode "wx" tak menimpa file ada; fire-and-forget menjaga attach
  // sinkron (gagal = degraded, bukan sesi gagal start).
  void (async () => {
    const path = journalPath(opts.sessionId, root)
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {})
      const h = await open(path, "wx", 0o600)
      try {
        await h.sync().catch(() => {})
      } finally {
        await h.close().catch(() => {})
      }
    } catch (e) {
      // EEXIST = file sudah ada (normal). Sisanya = degraded (bukan empty!).
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        markDegraded(opts.sessionId, root, `eager create gagal: ${(e as Error).message}`)
      }
    }
  })()
  // Antre intent FIFO per toolCallId: started ganda tak boleh menimpa;
  // completed mengambil pasangan tertua (map-overwrite = pending hantu).
  const inflight = new Map<string, Promise<JournalRecord>[]>()
  // toolCallId yang sudah di-preflight dilewati listener started (cegah intent ganda).
  const preflighted = new Set<string>()
  // Terminal yang masih menulis: completed sinkron, append async — tanpa daftar
  // ini turn selesai sebelum bukti terminal tiba.
  const pendingTerminals = new Set<Promise<void>>()
  const turnOf = (): number | null => {
    try {
      const n = session.state?.turnCount
      return typeof n === "number" ? n : null
    } catch {
      return null
    }
  }
  /** Satu-satunya pembangun input intent, dipakai event fallback dan pre-flight
   * agar bentuk record identik di dua jalur. */
  const intentInputFor = (
    name: string,
    args: Record<string, unknown>,
    hashes: { preTargetHash?: string | null; postTargetHash?: string | null } = {},
  ) => {
    const base = base_of(name)
    return {
      session: opts.sessionId,
      ...(opts.childOf ? { childOf: opts.childOf } : {}),
      turn: turnOf(),
      tool: name,
      ...(base === "mcp_call" ? { remote: true as const } : {}),
      ...(base === "code_run" ? { backend: process.env.MINICODE_SANDBOX || "none" } : {}),
      cwd: root,
      paths: verifyPaths(base, args, root),
      argsHash: hashArgs(args),
      ...(hashes.preTargetHash !== undefined ? { preTargetHash: hashes.preTargetHash } : {}),
      ...(hashes.postTargetHash !== undefined ? { postTargetHash: hashes.postTargetHash } : {}),
    }
  }
  const shouldJournal = (name: string): boolean =>
    name !== "" &&
    !NO_AUTO_JOURNAL.has(name) &&
    isMutationTool(name) &&
    !(opts.evidenceMode === "canonical" && isCanonicalEvidenceCovered(name))
  session.events.on("execution:started", (e) => {
    const ev = e as unknown as ExecutionEvent
    // Event child forward: truth di jurnal anak; mencatat di sini = bukti ganda.
    if (ev.forwardedChild != null) return
    const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
    if (!shouldJournal(name)) return
    const callId =
      typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
    // Pre-flight sudah menulis intent sebelum efek; menulis lagi = intent
    // ganda yang menggantung saat recovery.
    if (callId !== "" && preflighted.has(callId)) return
    const args = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
    // Daftarkan promise sebelum await agar completed menunggu intent selesai.
    const intentP = appendMutationIntent(intentInputFor(name, args))
    if (callId) {
      const q = inflight.get(callId) ?? []
      q.push(
        intentP.catch((err) => {
          process.stderr.write(`[warn] journal: intent failed: ${(err as Error).message}\n`)
          throw err
        }),
      )
      inflight.set(callId, q)
    }
    void intentP.catch((err) => {
      process.stderr.write(`[warn] journal: intent failed: ${(err as Error).message}\n`)
    })
  })
  session.events.on("execution:completed", (e) => {
    const task = (async () => {
      try {
        const ev = e as unknown as ExecutionEvent
        if (ev.forwardedChild != null) return
        const name = typeof ev.execution?.call?.name === "string" ? ev.execution.call.name : ""
        if (!shouldJournal(name)) return
        const callId =
          typeof ev.execution?.call?.id === "string" ? (ev.execution.call.id as string) : ""
        const q = callId ? (inflight.get(callId) ?? []) : []
        const found = q.length > 0 ? await q.shift()!.catch(() => undefined) : undefined
        if (callId && q.length === 0) inflight.delete(callId)
        // Tanpa pasangan intent: jangan karang terminal yatim (advisory + warn).
        if (!found) return
        const result = ev.execution?.result
        const failed = result?.isError === true
        // Tag UNKNOWN ≠ failed biasa (efek mungkin terjadi) → terminal `unknown`
        // agar recovery tak menganggapnya aman-diulang.
        const outcomeTag = failed ? parseToolOutcomeTag(String(result?.content ?? "")) : null
        const state = outcomeTag ? "unknown" : failed ? "failed" : "committed"
        let note: string | undefined
        if (base_of(name) === "mcp_call") {
          const a = (ev.execution?.call?.args ?? {}) as Record<string, unknown>
          const srv = typeof a.server === "string" ? a.server : ""
          const t =
            typeof a.tool === "string"
              ? a.tool
              : isMcpToolName(name)
                ? name.split(".").slice(1).join(".")
                : ""
          if (srv || t) note = `${srv ? `${srv}.` : ""}${t}`
        }
        const outcome: JournalOutcome | undefined = outcomeTag
          ? {
              ...(note ? { note } : {}),
              uncertainty: "ambiguous-effect",
              ...(outcomeTag.reason === "TIMEOUT" ? { timeout: true as const } : {}),
            }
          : note
            ? { note }
            : undefined
        await appendMutationTerminal(
          opts.sessionId,
          root,
          found.id,
          found.seq,
          found.tool,
          state,
          outcome,
        )
        // Kabar committed ke composition root; gagal hook tak boleh menggagalkan jurnal.
        if (state === "committed" && opts.onCommitted && callId) {
          try {
            opts.onCommitted({
              toolCallId: callId,
              paths: found.paths ?? [],
              journalSeq: found.seq,
              sessionId: opts.sessionId,
              ...(found.turn != null ? { turnId: found.turn } : {}),
            })
          } catch {}
        }
      } catch (err) {
        process.stderr.write(`[warn] journal: terminal failed: ${(err as Error).message}\n`)
      }
    })()
    // Daftarkan agar composition root bisa menunggu terminal; `finally` hanya
    // membersihkan daftar (promise tak pernah reject).
    pendingTerminals.add(task)
    void task.finally(() => pendingTerminals.delete(task)).catch(() => {})
  })

  /** Handle composition root: `preflightIntent` menulis intent dan menunggu
   * durable sebelum efek (via beforeToolEffect). Idempoten per toolCallId;
   * listener started melewati id yang sudah di-preflight. */
  return {
    async flushPending(): Promise<void> {
      // Loop sampai tak ada terminal tertunda (penulisan baru bisa lahir saat await).
      while (pendingTerminals.size > 0) {
        await Promise.allSettled([...pendingTerminals])
      }
    },
    async preflightIntent(call: { id: string; name: string; args: unknown }): Promise<void> {
      const name = typeof call.name === "string" ? call.name : ""
      if (!shouldJournal(name)) return
      const callId = typeof call.id === "string" ? call.id : ""
      if (callId === "" || preflighted.has(callId)) return
      // Tandai sebelum await: cegah dua preflight paralel untuk id sama.
      preflighted.add(callId)
      const args = (call.args ?? {}) as Record<string, unknown>
      // Hash pra-efek dihitung sebelum intent ditulis; gagal baca = field absen
      // (UNKNOWN saat reconcile).
      const hashes = await targetHashesFor(name, args, root)
      const p = appendMutationIntent(intentInputFor(name, args, hashes))
      const q = inflight.get(callId) ?? []
      q.push(p)
      inflight.set(callId, q)
      try {
        await p
      } catch (err) {
        // Durabilitas gagal → pemanggil menolak tool. Bersihkan state agar tak
        // ada intent hantu yang ditunggu terminal.
        preflighted.delete(callId)
        const idx = q.indexOf(p)
        if (idx !== -1) q.splice(idx, 1)
        if (q.length === 0) inflight.delete(callId)
        throw err
      }
    },
  }
}

function base_of(name: string): string {
  return isMcpToolName(name) ? "mcp_call" : name
}

/** Mutasi dengan turn lebih baru dari bukti (freshness completion). Murni baca.
 * Relevan = `isMutationTool`; record turn null (legacy) dikecualikan agar sesi
 * lama tak terkunci. State tak membedakan. Gagal baca DILEMPAR (gate wajib
 * fail-closed), beda dari pembaca display yang gagal-lembut. */
export async function mutationsSinceTurn(
  sessionId: string,
  cwd: string | undefined,
  evidenceTurn: number,
): Promise<readonly JournalRecord[]> {
  const loaded = await loadJournal(sessionId, cwd)
  // Jurnal tak-terbaca/korup → lempar agar gate fail-closed. `absent`/`empty`
  // aman (nol record = nol mutasi).
  if (loaded.status !== "absent" && loaded.status !== "empty" && loaded.status !== "valid") {
    throw new Error(`journal unreadable for freshness check (status: ${loaded.status})`)
  }
  const { records } = loaded
  return records.filter(
    (r) =>
      typeof r.turn === "number" &&
      r.turn > evidenceTurn &&
      typeof r.tool === "string" &&
      isMutationTool(r.tool),
  )
}

// ── Resume: muat jurnal (+anak) → putuskan ──

export interface RecoveryInput {
  directive: string | null
  warnings: string[]
  clean: boolean
}

/** Delegasi committed sejak timestamp (untuk peringatan turn-gagal). Murni
 * baca; gagal baca = [] + warn stderr. */
export interface CommittedDelegate {
  readonly childSessionId: string
  readonly seq: number
  readonly ts: number
  /** Amplop anak (display-only) disalin dari terminal yang sama, bukan baca
   * jurnal anak. Absen = pemanggil fallback baris legacy. */
  readonly childStatus?: ChildStatus
  readonly resultSummary?: string
  readonly truncated?: boolean
}

/** Status amplop yang boleh tampil (di luar ini = rusak → absen). */
const DISPLAYABLE_CHILD_STATUS: ReadonlySet<string> = new Set([
  "returned",
  "timeout",
  "aborted",
  "max_steps_exceeded",
  "error",
  "failed_to_start",
])

/** Predikat status tampil bersama (pembaca jurnal + formatter CLI): satu
 * sumber agar status asing tak jadi teks menyesatkan. */
export function isDisplayableChildStatus(value: unknown): value is ChildStatus {
  return typeof value === "string" && DISPLAYABLE_CHILD_STATUS.has(value)
}

export async function committedDelegatesSince(
  sessionId: string,
  cwd: string | undefined,
  sinceTs: number,
): Promise<CommittedDelegate[]> {
  try {
    const { records } = await loadJournal(sessionId, cwd)
    // Tautan dari terminal, fallback ke intent se-id (jurnal lama).
    const intentChild = new Map<string, string>()
    for (const r of records) {
      if (r.tool === "delegate_task" && r.childSessionId && r.state === "pending") {
        intentChild.set(r.id, r.childSessionId)
      }
    }
    const out: CommittedDelegate[] = []
    for (const r of records) {
      if (r.tool !== "delegate_task" || r.state !== "committed") continue
      const cid = r.childSessionId ?? intentChild.get(r.id)
      if (!cid) continue
      if (typeof r.ts !== "number" || r.ts < sinceTs) continue
      // Amplop rusak = absen (fallback legacy): childStatus harus dikenal dan
      // ringkasan harus string — status asing tak boleh jadi teks menyesatkan.
      const env = r.outcome?.childResult
      const envelope =
        env !== null &&
        typeof env === "object" &&
        isDisplayableChildStatus(env.childStatus) &&
        typeof env.resultSummary === "string"
          ? {
              childStatus: env.childStatus as ChildStatus,
              resultSummary: env.resultSummary,
              ...(env.truncated === true ? { truncated: true as const } : {}),
            }
          : {}
      out.push({ childSessionId: cid, seq: r.seq, ts: r.ts, ...envelope })
    }
    return out.sort((a, b) => a.seq - b.seq)
  } catch (e) {
    process.stderr.write(
      `[warn] journal: committedDelegatesSince failed: ${(e as Error).message}\n`,
    )
    return []
  }
}

/** Rencana recovery satu sesi: jurnal sendiri + anak yang dirujuk delegasi.
 * Murni baca; keputusan via decideRecovery (tanpa I/O). */
export async function planRecoveryForSession(
  sessionId: string,
  cwd?: string,
  opts: { includeChildren?: boolean; maxItems?: number; persistedTurns?: number[] } = {},
): Promise<RecoveryInput & { stats: RecoveryPlan["stats"] }> {
  const warnings: string[] = []
  try {
    const root = resolve(cwd ?? process.cwd())
    const main = await loadJournal(sessionId, root)
    warnings.push(...main.warnings)
    let records = [...main.records]
    if (main.quarantined) {
      warnings.push("journal utama dikarantina — keputusan dari prefix valid + advisory")
    }
    if (opts.includeChildren !== false) {
      const childIds = [
        ...new Set(
          main.records
            .filter((r) => r.tool === "delegate_task" && r.childSessionId)
            .map((r) => r.childSessionId as string),
        ),
      ].slice(0, 10)
      // Hanya delegasi committed yang membuktikan anak "seharusnya ada";
      // failed/pending = absen normal. Tautan dari terminal, fallback intent.
      const intentChild = new Map<string, string>()
      for (const r of main.records) {
        if (r.tool === "delegate_task" && r.childSessionId && r.state === "pending") {
          intentChild.set(r.id, r.childSessionId)
        }
      }
      const delegateDone = new Set<string>()
      for (const r of main.records) {
        if (r.tool !== "delegate_task" || r.state !== "committed") continue
        const cid = r.childSessionId ?? intentChild.get(r.id)
        if (cid) delegateDone.add(cid)
      }
      const degraded: string[] = []
      for (const cid of childIds) {
        const child = await loadJournal(cid, root).catch(
          (e): JournalLoad => ({
            records: [],
            warnings: [`jurnal anak ${cid} gagal dimuat: ${(e as Error).message}`],
            truncatedTail: false,
            quarantined: false,
            status: "unreadable",
          }),
        )
        warnings.push(...child.warnings.map((w) => `child ${cid}: ${w}`))
        switch (child.status) {
          case "absent":
            // Parent committed + file tak ada = bukti hilang; failed/pending = normal.
            if (delegateDone.has(cid)) {
              degraded.push(
                `jurnal anak ${cid} SEHARUSNYA ADA (delegasi committed) tetapi file tak ditemukan — bukti tak-lengkap, jangan asumsikan efek anak ada/tidak-ada`,
              )
            }
            break
          case "unreadable":
            // File ada tetapi tak terbaca = anomali dalam kondisi apa pun.
            degraded.push(
              `jurnal anak ${cid} TAK TERBACA — bukti tak-lengkap, jangan asumsikan efek anak ada/tidak-ada`,
            )
            break
          case "empty":
            // Anak terpasang tetapi nol mutasi = normal, bukan anomali.
            break
          default:
            records = records.concat(child.records)
            break
        }
        if (child.quarantined) {
          warnings.push(
            `child ${cid}: journal dikarantina — keputusan dari prefix valid + advisory`,
          )
        }
      }
      // Bukti degraded masuk direktif non-blocking agar model tak membangun di atasnya.
      if (degraded.length > 0) {
        const extra = `[recovery] BUKTI TAK-LENGKAP (degraded, bukan blokir):\n${degraded.map((d) => `- ${d}`).join("\n")}`
        warnings.push(...degraded)
        const base = decideRecovery(records, opts.persistedTurns ?? [], { maxItems: opts.maxItems })
        warnings.push(...base.warnings)
        const directive = base.directive ? `${base.directive}\n${extra}` : extra
        if (!isJournalHealthy(sessionId, root)) {
          warnings.push("journal degraded (tulis gagal sebelumnya) — anggap catatan tak-lengkap")
        }
        return { directive, warnings, clean: false, stats: base.stats }
      }
    }
    // Turn durable dipasok pemanggil agar tak bergantung persistence (anti cycle-import).
    const plan = decideRecovery(records, opts.persistedTurns ?? [], { maxItems: opts.maxItems })
    warnings.push(...plan.warnings)
    if (!isJournalHealthy(sessionId, root)) {
      warnings.push("journal degraded (tulis gagal sebelumnya) — anggap catatan tak-lengkap")
    }
    return { directive: plan.directive, warnings, clean: plan.clean, stats: plan.stats }
  } catch (e) {
    return {
      directive: null,
      warnings: [`recovery journal gagal dimuat: ${(e as Error).message} — lanjut jalur advisory`],
      clean: false,
      stats: { pending: 0, failed: 0, committed: 0, unknown: 0, finalized: 0, markers: 0 },
    }
  }
}
