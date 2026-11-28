// [Fase 3 / LOOP-12, LOOP-G19, LOOP-G27] Detektor deterministik No-Progress &
// Oscillation.
//
// Menutup tiga modus macet otonom tanpa menyentuh kernel frozen:
//   1. Exact Action-Error Fingerprint (`REPEATED_ACTION_ERROR`): pemanggilan
//      tool dengan nama + argumen kanonis + headline error yang identik N kali
//      berturut-turut diblokir pada percobaan ke-(N+1).
//   2. Workspace State Oscillation (`WORKSPACE_REVERT_CYCLE`): file mengalami
//      siklus bolak-balik kembali ke hash lama sebanyak M siklus (mis.
//      H1 -> H2 -> H1 -> H2 -> H1 untuk M=2) tanpa verifikasi lulus di antaranya.
//   3. Read-Only Thrashing (`READ_ONLY_THRASHING`): pemanggilan tool murni-baca
//      (`sideEffectTier === "PURE_READ"`) berturut-turut melampaui ambang batas
//      saat sesi berada pada postur kerja aktif (bukan readonly/explore/plan)
//      tanpa pembaruan rencana (`todo_write`), mutasi, atau jawaban ke user.
//
// Modul ini berada di `src/policy/` dan hanya mengimpor `./tool-contract.ts` +
// pustaka standar Node agar batas lapisan tetap bersih.

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { contractForTool } from "./tool-contract.ts"

export type NoProgressPosture = "active" | "readonly" | "explore" | "plan"

export type LoopGuardKind = "NO_PROGRESS" | "OSCILLATION"

export type LoopGuardReason =
  | "REPEATED_ACTION_ERROR"
  | "WORKSPACE_REVERT_CYCLE"
  | "READ_ONLY_THRASHING"

export type NoProgressVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly kind: LoopGuardKind
      readonly reason: LoopGuardReason
      readonly message: string
    }

export class NoProgressError extends Error {
  override readonly name = "NoProgressError"
  readonly kind: LoopGuardKind
  readonly reason: LoopGuardReason

  constructor(kind: LoopGuardKind, reason: LoopGuardReason, message: string) {
    super(message)
    this.kind = kind
    this.reason = reason
  }
}

export interface NoProgressOptions {
  /** Maksimum kegagalan identik berturut-turut sebelum panggilan berikutnya diblokir (default 3). */
  readonly maxRepeatedErrors?: number
  /**
   * Maksimum kegagalan dengan tool + headline error sama berturut-turut meski
   * argumen sedikit bervariasi sebelum memicu REPEATED_ACTION_ERROR (default 5).
   */
  readonly maxSimilarErrors?: number
  /** Maksimum siklus kembali ke hash file lama tanpa verifikasi hijau (default 2). */
  readonly maxOscillations?: number
  /** Maksimum panggilan PURE_READ berturut-turut di postur aktif (default 30). */
  readonly maxConsecutiveReadCalls?: number
  /** Postur sesi saat ini; non-"active" menonaktifkan detektor read-only thrashing. */
  readonly getPosture?: () => NoProgressPosture
  /** Apakah tool `todo_write` tersedia; memengaruhi petunjuk pemulihan pesan guard. */
  readonly hasTodoWrite?: boolean
  /**
   * [Fase 6A / ACE-04] Maksimum retry terjustifikasi setelah bukti baru
   * (default 1). Hard cap absolut: tidak pernah menambah budget tanpa batas.
   */
  readonly maxNewEvidenceRetries?: number
  /** Hook observabilitas non-autoritatif saat guard memblokir panggilan. */
  readonly onGuardEvent?: (event: {
    kind: LoopGuardKind
    reason: LoopGuardReason
    tool?: string
    detail?: string
  }) => void
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(",")}}`
}

/** Hash argumen kanonis (identik dengan `hashArgs` pada `src/session/journal.ts`). */
export function canonicalArgsHash(args: unknown): string {
  return createHash("sha256")
    .update(canonicalize(args ?? {}))
    .digest("hex")
}

/**
 * Ambil headline error yang stabil (baris pertama bermakna, menormalkan angka
 * durasi volatil agar timeout/error yang sama menghasilkan sidik jari sama).
 */
export function normalizeErrorHeadline(errorText: string): string {
  const firstLine =
    String(errorText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "error"
  return (
    firstLine
      .replace(/\bduration_ms=\d+/g, "duration_ms=#")
      // v0.33 (audit): angka/path volatil lain juga dinormalkan supaya error yang
      // identik tapi beda durasi/PID/baris tak dianggap aksi berbeda (false-negative
      // REPEATED_ACTION_ERROR → retry sampai batas langkah).
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|detik|dtk|seconds?|secs?)\b/gi, "#dur")
      .replace(/\b\d{4,}\b/g, "#n")
      .replace(/0x[0-9a-f]+/gi, "#hex")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#uuid")
      .replace(/:\d+:\d+/g, ":#line:col")
      .replace(/\s+/g, " ")
      .slice(0, 240)
  )
}

export function computeActionErrorFingerprint(
  toolName: string,
  args: unknown,
  errorText: string,
): string {
  const payload = `${toolName}\0${canonicalArgsHash(args)}\0${normalizeErrorHeadline(errorText)}`
  return createHash("sha256").update(payload, "utf8").digest("hex")
}

const HASH_MAX_BYTES = 8 * 1024 * 1024

async function hashWorkspaceFile(
  absPath: string,
): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const st = await stat(absPath)
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return { ok: false }
    const bytes = await readFile(absPath)
    return { ok: true, hash: createHash("sha256").update(bytes).digest("hex") }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true, hash: null }
    return { ok: false }
  }
}

function targetRelPathForTool(
  toolName: string,
  args: unknown,
  workspaceRoot: string,
): string | null {
  const a = (args ?? {}) as Record<string, unknown>
  const raw =
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "apply_patch" ||
    toolName === "delete_file"
      ? a.path
      : toolName === "move_file"
        ? (a.destination ?? a.to)
        : undefined
  if (typeof raw !== "string" || !raw.trim()) return null
  const root = resolve(workspaceRoot)
  const rel = relative(root, resolve(root, raw)).replace(/\\/g, "/")
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel
}

function normalizeTrackPath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "")
}

interface FileHashTracker {
  history: (string | null)[]
  visits: Map<string, number>
  oscillationMessage: string | null
}

const HASH_NULL_SENTINEL = "__ABSENT__"

function hashKey(h: string | null): string {
  return h === null ? HASH_NULL_SENTINEL : h
}

export interface NoProgressDetector {
  evaluateBeforeCall(
    call: { id?: string; name: string; args?: unknown },
    workspaceRoot?: string,
  ): NoProgressVerdict
  assertBeforeCall(
    call: { id?: string; name: string; args?: unknown },
    workspaceRoot?: string,
  ): void
  capturePreMutation(
    call: { id: string; name: string; args?: unknown },
    workspaceRoot: string,
  ): Promise<void>
  /**
   * [Fase 3] Titik masuk barrier async tunggal: tunggu seluruh pencatatan
   * post-mutation step sebelumnya selesai dulu (menutup race async antar-step),
   * evaluasi guard, lalu rekam hash pra-mutasi.
   */
  beforeToolEffectCheck(
    call: { id: string; name: string; args?: unknown },
    workspaceRoot: string,
  ): Promise<void>
  flushPending(): Promise<void>
  recordOutcome(input: {
    id?: string
    name: string
    args?: unknown
    isError?: boolean
    content?: string
  }): NoProgressVerdict
  recordFileMutation(input: {
    path: string
    preTargetHash: string | null
    postTargetHash: string | null
  }): NoProgressVerdict
  completePostMutation(
    call: { id: string; name: string; args?: unknown; isError?: boolean },
    workspaceRoot: string,
  ): Promise<NoProgressVerdict>
  noteVerificationPassed(): void
  noteAssistantResponse(): void
  reset(): void
  snapshot(): {
    readonly repeatedErrorStreak: number
    readonly consecutiveReadCalls: number
    readonly oscillatingPaths: readonly string[]
    /** [Fase 6A / ACE-04] Ada bukti baru sejak blokir REPEATED_ACTION_ERROR. */
    readonly newEvidenceSinceFailure: boolean
    /** [Fase 6A / ACE-04] Retry terjustifikasi yang sudah dipakai untuk blokir aktif. */
    readonly justifiedRetriesUsed: number
  }
}

export function createNoProgressDetector(options: NoProgressOptions = {}): NoProgressDetector {
  const maxRepeatedErrors =
    typeof options.maxRepeatedErrors === "number" &&
    Number.isFinite(options.maxRepeatedErrors) &&
    options.maxRepeatedErrors >= 1
      ? Math.floor(options.maxRepeatedErrors)
      : 3
  const maxSimilarErrors =
    typeof options.maxSimilarErrors === "number" &&
    Number.isFinite(options.maxSimilarErrors) &&
    options.maxSimilarErrors >= 1
      ? Math.floor(options.maxSimilarErrors)
      : Math.max(5, maxRepeatedErrors)
  const maxOscillations =
    typeof options.maxOscillations === "number" &&
    Number.isFinite(options.maxOscillations) &&
    options.maxOscillations >= 1
      ? Math.floor(options.maxOscillations)
      : 2
  const maxConsecutiveReadCalls =
    typeof options.maxConsecutiveReadCalls === "number" &&
    Number.isFinite(options.maxConsecutiveReadCalls) &&
    options.maxConsecutiveReadCalls >= 1
      ? Math.floor(options.maxConsecutiveReadCalls)
      : 30
  const getPosture = options.getPosture ?? (() => "active" as const)
  const hasTodoWrite = options.hasTodoWrite ?? true
  const maxNewEvidenceRetries =
    typeof options.maxNewEvidenceRetries === "number" &&
    Number.isFinite(options.maxNewEvidenceRetries) &&
    options.maxNewEvidenceRetries >= 0
      ? Math.floor(options.maxNewEvidenceRetries)
      : 1
  const emitGuard = (ev: {
    kind: LoopGuardKind
    reason: LoopGuardReason
    tool?: string
    detail?: string
  }) => {
    try {
      options.onGuardEvent?.(ev)
    } catch {}
  }

  let lastErrorFingerprint: string | null = null
  let lastErrorActionKey: string | null = null
  let repeatedErrorStreak = 0
  let lastErrorHeadlineKey: string | null = null
  let headlineErrorStreak = 0

  // [Fase 6A / ACE-04] Blokir REPEATED_ACTION_ERROR bersifat PERSISTEN sampai
  // ada bukti baru — sukses yang tidak relevan tidak boleh membuka jalan
  // mengulang perintah yang sama secara buta.
  let activeBlock: { fingerprint: string; actionKey: string; streak: number } | null = null
  let activeHeadlineBlock: { headlineKey: string; tool: string; streak: number } | null = null
  let newEvidenceAfterBlock = false
  let justifiedRetries = 0
  // Sidik jari observasi baca `(tool + canonicalArgs + hash(content))` berbatas
  // FIFO: bacaan ulang dengan argumen & isi identik tanpa mutasi di antaranya
  // tidak dianggap bukti baru untuk membuka blokir error berulang.
  const MAX_SEEN_READ_EVIDENCE = 64
  const seenReadEvidence = new Set<string>()
  const rememberReadEvidence = (key: string): boolean => {
    if (seenReadEvidence.has(key)) return false
    if (seenReadEvidence.size >= MAX_SEEN_READ_EVIDENCE) {
      const oldest = seenReadEvidence.values().next().value
      if (oldest !== undefined) seenReadEvidence.delete(oldest)
    }
    seenReadEvidence.add(key)
    return true
  }

  let consecutiveReadCalls = 0
  let lastTodoArgsHash: string | null = null

  const fileTrackers = new Map<string, FileHashTracker>()
  const inflightPreHash = new Map<string, { relPath: string; preHash: string | null }>()
  const inflightExecPreHashes = new Map<string, { relPath: string; preHash: string | null }[]>()
  const pendingPost = new Set<Promise<unknown>>()

  /** Ekstrak kandidat path relatif yang sudah terlacak atau disebut pada cmd/code bash. */
  function shellCandidatePaths(call: { args?: unknown }, workspaceRoot: string): string[] {
    const candidates = new Set<string>()
    for (const tracked of fileTrackers.keys()) {
      if (candidates.size >= 32) break
      candidates.add(tracked)
    }
    const addWorkspaceCandidate = (tok: string): boolean => {
      if (!tok || tok.startsWith("-") || tok.startsWith("&") || tok.includes("://")) return false
      const abs = isAbsolute(tok) ? resolve(tok) : resolve(workspaceRoot, tok)
      const rel = normalizeTrackPath(relative(workspaceRoot, abs))
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false
      const sizeBefore = candidates.size
      candidates.add(rel)
      return candidates.size > sizeBefore
    }
    const a = (call.args ?? {}) as Record<string, unknown>
    const rawText = typeof a.cmd === "string" ? a.cmd : typeof a.code === "string" ? a.code : ""
    if (rawText) {
      let addedFromCmd = 0
      // [Wave 5 / G4] Tangkap target redirection (`>`, `>>`, `tee`) dan tujuan
      // `mv`/`cp`/`touch`/`sed -i` meskipun nama berkas di root tanpa ekstensi/slash (mis. Makefile).
      for (const m of rawText.matchAll(/(?:>>?|\btee(?:\s+-[^\s]+)*)\s+["']?([^\s"'`;|&<>()]+)/g)) {
        if (addedFromCmd >= 12) break
        if (addWorkspaceCandidate(m[1] ?? "")) addedFromCmd++
      }
      for (const seg of rawText.split(/[;&|\r\n]+/)) {
        if (addedFromCmd >= 12) break
        const rawParts = seg
          .trim()
          .split(/\s+/)
          .map((p) => p.replace(/^["']|["']$/g, ""))
          .filter(Boolean)
        const redirIdx = rawParts.findIndex((p) => /^(?:\d*>>?|<<?)/.test(p))
        const parts = redirIdx >= 0 ? rawParts.slice(0, redirIdx) : rawParts
        const head = parts[0]?.toLowerCase()
        if (head === "mv" || head === "cp" || head === "touch" || head === "rm" || head === "sed") {
          for (let i = parts.length - 1; i >= 1; i--) {
            const p = parts[i]!
            if (!p || p.startsWith("-")) continue
            if (addWorkspaceCandidate(p)) addedFromCmd++
            if (head === "mv" || head === "cp" || head === "sed") break
          }
        }
      }
      for (const tok of rawText.split(/[\s"'`;|&<>()]+/)) {
        if (addedFromCmd >= 12) break
        if (!tok || tok.startsWith("-") || tok.includes("://")) continue
        if (!/[./\\]/.test(tok)) continue
        if (addWorkspaceCandidate(tok)) addedFromCmd++
      }
    }
    return [...candidates]
  }

  const evaluateBeforeCall: NoProgressDetector["evaluateBeforeCall"] = (call, workspaceRoot) => {
    const name = String(call.name ?? "")
    const actionKey = `${name}\0${canonicalArgsHash(call.args)}`

    // Sinyal 1a: blokir persisten. Hanya boleh dibuka oleh SATU retry
    // terjustifikasi setelah bukti diagnostik/mutasi baru, dengan hard cap.
    if (activeBlock !== null && actionKey === activeBlock.actionKey) {
      if (newEvidenceAfterBlock && justifiedRetries < maxNewEvidenceRetries) {
        justifiedRetries += 1
        newEvidenceAfterBlock = false
        return { allowed: true }
      }
      emitGuard({
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        tool: name,
        detail: `blocked persistent streak=${activeBlock.streak}`,
      })
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${activeBlock.streak}] ` +
          `Identical tool call failed ${activeBlock.streak} times consecutively with the same error. ` +
          `Read fresh diagnostic evidence or change your approach before retrying.`,
      }
    }

    // Sinyal 1a-sim [Wave 5 / G4]: tool yang sama gagal berulang dengan headline
    // error sama meski argumen sedikit bervariasi (mis. offset baris / flag kecil).
    if (activeHeadlineBlock !== null && name === activeHeadlineBlock.tool) {
      if (newEvidenceAfterBlock && justifiedRetries < maxNewEvidenceRetries) {
        justifiedRetries += 1
        newEvidenceAfterBlock = false
        return { allowed: true }
      }
      emitGuard({
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        tool: name,
        detail: `blocked similar headline streak=${activeHeadlineBlock.streak}`,
      })
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${activeHeadlineBlock.streak}] ` +
          `Tool '${name}' failed ${activeHeadlineBlock.streak} times consecutively with the same error headline. ` +
          `Inspect fresh diagnostic evidence or change your approach before retrying.`,
      }
    }

    // Sinyal 1b: panggilan identik yang sudah gagal N kali berturut-turut.
    if (
      repeatedErrorStreak >= maxRepeatedErrors &&
      lastErrorActionKey !== null &&
      actionKey === lastErrorActionKey
    ) {
      emitGuard({
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        tool: name,
        detail: `streak=${repeatedErrorStreak}`,
      })
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${repeatedErrorStreak}] ` +
          `Identical tool call failed ${repeatedErrorStreak} times consecutively with the same error. ` +
          `Stop repeating this command and revise your approach.`,
      }
    }

    // Sinyal 1b-sim [Wave 5 / G4]: headline error identik pada tool yang sama mencapai ambang sekunder.
    if (
      headlineErrorStreak >= maxSimilarErrors &&
      lastErrorHeadlineKey !== null &&
      lastErrorHeadlineKey.startsWith(`${name}\0`)
    ) {
      emitGuard({
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        tool: name,
        detail: `headlineStreak=${headlineErrorStreak}`,
      })
      return {
        allowed: false,
        kind: "NO_PROGRESS",
        reason: "REPEATED_ACTION_ERROR",
        message:
          `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${headlineErrorStreak}] ` +
          `Tool '${name}' failed ${headlineErrorStreak} times consecutively with the same error headline. ` +
          `Inspect fresh diagnostic evidence or change your approach before retrying.`,
      }
    }

    // Sinyal 2: file target sudah terdeteksi dalam siklus revert berulang.
    const contract = contractForTool(name)
    if (contract?.sideEffectTier === "WORKSPACE_MUTATION") {
      const a = (call.args ?? {}) as Record<string, unknown>
      // v7.38: move_file memakai `destination` sebagai target tulis; fallback
      // `to` untuk args historis. Tool lain tetap memakai `path`.
      const rawPath =
        typeof a.path === "string"
          ? a.path
          : typeof a.destination === "string"
            ? a.destination
            : typeof a.to === "string"
              ? a.to
              : undefined
      if (rawPath) {
        const rel = workspaceRoot ? targetRelPathForTool(name, call.args, workspaceRoot) : null
        const key = normalizeTrackPath(rel ?? rawPath)
        const tracker = fileTrackers.get(key) ?? fileTrackers.get(normalizeTrackPath(rawPath))
        if (tracker?.oscillationMessage) {
          emitGuard({
            kind: "OSCILLATION",
            reason: "WORKSPACE_REVERT_CYCLE",
            tool: name,
            detail: key,
          })
          return {
            allowed: false,
            kind: "OSCILLATION",
            reason: "WORKSPACE_REVERT_CYCLE",
            message: tracker.oscillationMessage,
          }
        }
      }
    } else if ((name === "bash" || name === "code_run") && workspaceRoot) {
      for (const cand of shellCandidatePaths(call, workspaceRoot)) {
        const tracker = fileTrackers.get(cand)
        if (tracker?.oscillationMessage) {
          emitGuard({
            kind: "OSCILLATION",
            reason: "WORKSPACE_REVERT_CYCLE",
            tool: name,
            detail: cand,
          })
          return {
            allowed: false,
            kind: "OSCILLATION",
            reason: "WORKSPACE_REVERT_CYCLE",
            message: tracker.oscillationMessage,
          }
        }
      }
    }

    // Sinyal 3: read-only / non-mutating thrashing di postur kerja aktif.
    // Hanya aksi kemajuan nyata (mutasi file, pembaruan rencana todo_write,
    // delegasi, interaksi user, submit_result) yang me-reset counter; pencarian
    // web (web_search/web_fetch) ikut terhitung sebagai bacaan tanpa-mutasi,
    // dan bash/mcp hanya me-reset di recordOutcome bila benar-benar sukses.
    const isPureRead = contract?.sideEffectTier === "PURE_READ"
    const isExternalLookup = name === "web_search" || name === "web_fetch"
    const isResetsStreakImmediately =
      contract?.sideEffectTier === "WORKSPACE_MUTATION" ||
      name === "todo_write" ||
      name === "ask_user" ||
      name === "submit_result" ||
      name === "delegate_task"
    if (isPureRead || isExternalLookup) {
      if (getPosture() === "active") {
        if (consecutiveReadCalls >= maxConsecutiveReadCalls) {
          const observedCount = consecutiveReadCalls
          // Reset setelah satu intervensi supaya model menerima peringatan keras
          // sebagai tool error dan dapat langsung memanggil todo_write / bertindak.
          consecutiveReadCalls = 0
          emitGuard({
            kind: "NO_PROGRESS",
            reason: "READ_ONLY_THRASHING",
            tool: name,
            detail: `count=${observedCount}`,
          })
          const guidance = hasTodoWrite
            ? "without updating the plan, mutating workspace state, or responding to the user. Formulate a plan (todo_write) or act on what you have read."
            : "without mutating workspace state or synthesizing findings. Summarize what you found or act on what you have read."
          return {
            allowed: false,
            kind: "NO_PROGRESS",
            reason: "READ_ONLY_THRASHING",
            message:
              `[LOOP_GUARD kind=NO_PROGRESS reason=READ_ONLY_THRASHING count=${observedCount}] ` +
              `Exceeded ${maxConsecutiveReadCalls} consecutive read-only tool calls ${guidance}`,
          }
        }
        consecutiveReadCalls += 1
      }
    } else if (name === "todo_write") {
      // [Wave 5 / G4] Hanya pembaruan rencana yang benar-benar berubah yang
      // memutus rentetan baca murni; pengulangan payload identik diabaikan.
      const todoHash = canonicalArgsHash(call.args)
      if (lastTodoArgsHash !== todoHash) {
        lastTodoArgsHash = todoHash
        consecutiveReadCalls = 0
      }
    } else if (isResetsStreakImmediately) {
      // Pembaruan file, delegasi, submit_result, atau ask_user memutus rentetan baca murni.
      consecutiveReadCalls = 0
    }

    return { allowed: true }
  }

  const recordFileMutation: NoProgressDetector["recordFileMutation"] = (input) => {
    const key = normalizeTrackPath(input.path)
    if (!key) return { allowed: true }
    // No-op write (isi tidak berubah) tidak dihitung sebagai transisi bolak-balik.
    if (input.preTargetHash === input.postTargetHash) return { allowed: true }

    let tracker = fileTrackers.get(key)
    if (!tracker) {
      const visits = new Map<string, number>()
      const preK = hashKey(input.preTargetHash)
      visits.set(preK, 1)
      tracker = {
        history: [input.preTargetHash],
        visits,
        oscillationMessage: null,
      }
      fileTrackers.set(key, tracker)
    } else if (tracker.history[tracker.history.length - 1] !== input.preTargetHash) {
      // Sinkronkan state awal bila file diubah dari luar di sela dua operasi.
      const preK = hashKey(input.preTargetHash)
      tracker.history.push(input.preTargetHash)
      tracker.visits.set(preK, (tracker.visits.get(preK) ?? 0) + 1)
    }

    const postK = hashKey(input.postTargetHash)
    tracker.history.push(input.postTargetHash)
    const count = (tracker.visits.get(postK) ?? 0) + 1
    tracker.visits.set(postK, count)

    // `count - 1` = berapa kali file kembali ke hash yang sama setelah pernah
    // meninggalkannya (H1 -> H2 -> H1 = 1 siklus; -> H2 -> H1 = 2 siklus).
    const revertCycles = count - 1
    if (revertCycles >= maxOscillations) {
      const msg =
        `[LOOP_GUARD kind=OSCILLATION reason=WORKSPACE_REVERT_CYCLE path=${key}] ` +
        `File state is oscillating between identical versions without progress.`
      tracker.oscillationMessage = msg
      return {
        allowed: false,
        kind: "OSCILLATION",
        reason: "WORKSPACE_REVERT_CYCLE",
        message: msg,
      }
    }
    return { allowed: true }
  }

  const flushPending = async (): Promise<void> => {
    while (pendingPost.size > 0) {
      await Promise.allSettled([...pendingPost])
    }
  }

  const recordPreMutation = async (
    call: { id: string; name: string; args?: unknown },
    workspaceRoot: string,
  ) => {
    const contract = contractForTool(call.name)
    if (!call.id) return
    if (call.name === "bash" || call.name === "code_run") {
      const entries: { relPath: string; preHash: string | null }[] = []
      for (const rel of shellCandidatePaths(call, workspaceRoot)) {
        const pre = await hashWorkspaceFile(resolve(workspaceRoot, rel))
        if (pre.ok) entries.push({ relPath: rel, preHash: pre.hash })
      }
      if (entries.length > 0) inflightExecPreHashes.set(call.id, entries)
      return
    }
    if (contract?.sideEffectTier !== "WORKSPACE_MUTATION") return
    const rel = targetRelPathForTool(call.name, call.args, workspaceRoot)
    if (!rel) return
    const pre = await hashWorkspaceFile(resolve(workspaceRoot, rel))
    if (pre.ok) inflightPreHash.set(call.id, { relPath: rel, preHash: pre.hash })
  }

  return {
    evaluateBeforeCall,
    assertBeforeCall(call, workspaceRoot) {
      const verdict = evaluateBeforeCall(call, workspaceRoot)
      if (!verdict.allowed) {
        throw new NoProgressError(verdict.kind, verdict.reason, verdict.message)
      }
    },
    capturePreMutation: recordPreMutation,
    async beforeToolEffectCheck(call, workspaceRoot) {
      await flushPending()
      const verdict = evaluateBeforeCall(call, workspaceRoot)
      if (!verdict.allowed) {
        throw new NoProgressError(verdict.kind, verdict.reason, verdict.message)
      }
      await recordPreMutation(call, workspaceRoot)
    },
    flushPending,
    recordOutcome(input) {
      const name = String(input.name ?? "")
      const content = String(input.content ?? "")
      // [LF-2] Jangan hitung error yang berasal dari LOOP_GUARD sendiri sebagai
      // kegagalan tool. Hanya cocokkan pesan SINTETIS yang ber-prefix eksak di
      // AWAL string (`[LOOP_GUARD kind=...]` — format nyata observable di modul
      // ini), bukan substring di tengah output tool eksternal.
      if (/^\[LOOP_GUARD kind=(?:NO_PROGRESS|OSCILLATION)\b/.test(content.trimStart())) {
        return { allowed: true }
      }
      const isSubAgentFail =
        name === "delegate_task" &&
        /^\[sub-agent (?:skipped|[^\]\n]*error)\]/.test(content.trimStart())
      if (input.isError === true || isSubAgentFail) {
        const headline = normalizeErrorHeadline(content)
        const fp = computeActionErrorFingerprint(name, input.args, content)
        const actionKey = `${name}\0${canonicalArgsHash(input.args)}`
        const headlineKey = `${name}\0${headline}`
        if (fp === lastErrorFingerprint && actionKey === lastErrorActionKey) {
          repeatedErrorStreak += 1
        } else {
          lastErrorFingerprint = fp
          lastErrorActionKey = actionKey
          repeatedErrorStreak = 1
        }
        if (headlineKey === lastErrorHeadlineKey) {
          headlineErrorStreak += 1
        } else {
          lastErrorHeadlineKey = headlineKey
          headlineErrorStreak = 1
          if (activeHeadlineBlock !== null && activeHeadlineBlock.headlineKey !== headlineKey) {
            activeHeadlineBlock = null
            if (activeBlock === null) {
              justifiedRetries = 0
              newEvidenceAfterBlock = false
            }
          }
        }
        if (repeatedErrorStreak >= maxRepeatedErrors) {
          if (activeBlock === null || activeBlock.actionKey !== actionKey) {
            // Blokir baru: buka budget retry dari nol.
            activeBlock = { fingerprint: fp, actionKey, streak: repeatedErrorStreak }
            justifiedRetries = 0
          } else {
            // Retry terjustifikasi gagal lagi: pertahankan budget yang sudah
            // terpakai (hard cap) dan cabut bukti yang sudah dikonsumsi.
            activeBlock = { ...activeBlock, streak: repeatedErrorStreak }
          }
          newEvidenceAfterBlock = false
          return {
            allowed: false,
            kind: "NO_PROGRESS",
            reason: "REPEATED_ACTION_ERROR",
            message:
              `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${repeatedErrorStreak}] ` +
              `Identical tool call failed ${repeatedErrorStreak} times consecutively with the same error. ` +
              `Stop repeating this command and revise your approach.`,
          }
        }
        if (headlineErrorStreak >= maxSimilarErrors) {
          if (activeHeadlineBlock === null || activeHeadlineBlock.headlineKey !== headlineKey) {
            activeHeadlineBlock = { headlineKey, tool: name, streak: headlineErrorStreak }
            justifiedRetries = 0
          } else {
            activeHeadlineBlock = { ...activeHeadlineBlock, streak: headlineErrorStreak }
          }
          newEvidenceAfterBlock = false
          return {
            allowed: false,
            kind: "NO_PROGRESS",
            reason: "REPEATED_ACTION_ERROR",
            message:
              `[LOOP_GUARD kind=NO_PROGRESS reason=REPEATED_ACTION_ERROR count=${headlineErrorStreak}] ` +
              `Tool '${name}' failed ${headlineErrorStreak} times consecutively with the same error headline. ` +
              `Inspect fresh diagnostic evidence or change your approach before retrying.`,
          }
        }
        return { allowed: true }
      }
      // Eksekusi sukses memutus streak error berulang. [Fase 6A / ACE-04]
      // Mutasi workspace menandai perubahan nyata (membuka retry & menyegarkan
      // baseline bacaan); bacaan PURE_READ hanya membuka retry bila observasi
      // `(tool + args + hash isi)` benar-benar baru — mengulang bacaan file &
      // isi yang identik tidak lagi membuka blokir.
      const tier = contractForTool(name)?.sideEffectTier
      if (tier === "PURE_READ") {
        const contentHash = createHash("sha256").update(content, "utf8").digest("hex")
        const evKey = `${name}\0${canonicalArgsHash(input.args)}\0${contentHash}`
        const isNovelObservation = rememberReadEvidence(evKey)
        if ((activeBlock !== null || activeHeadlineBlock !== null) && isNovelObservation) {
          newEvidenceAfterBlock = true
        }
      } else if (tier === "WORKSPACE_MUTATION") {
        seenReadEvidence.clear()
        lastTodoArgsHash = null
        // Batasi ukuran tracker file hash FIFO agar sesi berhari-hari tidak membengkak di RAM.
        while (fileTrackers.size > 512) {
          const oldest = fileTrackers.keys().next().value
          if (oldest === undefined) break
          fileTrackers.delete(oldest)
        }
        if (activeBlock !== null || activeHeadlineBlock !== null) {
          newEvidenceAfterBlock = true
        }
      } else if (tier === "LOCAL_ENV_MUTATION") {
        seenReadEvidence.clear()
      }
      // Sukses pada mutasi lokal non-deklaratif (bash/code_run/git_commit/dll.)
      // menandakan progres nyata -> putus streak read-only. Tool gagal atau
      // baca-eksternal (web_search/web_fetch) TIDAK mereset.
      if (name !== "web_search" && name !== "web_fetch") {
        if (tier === "LOCAL_ENV_MUTATION" || tier === "WORKSPACE_MUTATION") {
          consecutiveReadCalls = 0
          lastTodoArgsHash = null
        }
      }
      if (activeHeadlineBlock !== null && activeHeadlineBlock.tool === name) {
        activeHeadlineBlock = null
        if (activeBlock === null) {
          justifiedRetries = 0
          newEvidenceAfterBlock = false
        }
      }
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
      lastErrorHeadlineKey = null
      headlineErrorStreak = 0
      return { allowed: true }
    },
    recordFileMutation,
    async completePostMutation(call, workspaceRoot) {
      const task = (async (): Promise<NoProgressVerdict> => {
        const execEntries = call.id ? inflightExecPreHashes.get(call.id) : undefined
        if (call.id) inflightExecPreHashes.delete(call.id)
        if (execEntries && call.isError !== true) {
          let lastVerdict: NoProgressVerdict = { allowed: true }
          for (const entry of execEntries) {
            const post = await hashWorkspaceFile(resolve(workspaceRoot, entry.relPath))
            if (!post.ok) continue
            const v = recordFileMutation({
              path: entry.relPath,
              preTargetHash: entry.preHash,
              postTargetHash: post.hash,
            })
            if (!v.allowed) lastVerdict = v
          }
          return lastVerdict
        }
        const entry = call.id ? inflightPreHash.get(call.id) : undefined
        if (call.id) inflightPreHash.delete(call.id)
        if (!entry || call.isError === true) return { allowed: true }
        const post = await hashWorkspaceFile(resolve(workspaceRoot, entry.relPath))
        if (!post.ok) return { allowed: true }
        return recordFileMutation({
          path: entry.relPath,
          preTargetHash: entry.preHash,
          postTargetHash: post.hash,
        })
      })()
      pendingPost.add(task)
      try {
        return await task
      } finally {
        pendingPost.delete(task)
      }
    },
    noteVerificationPassed() {
      // Verifikasi hijau menandai titik tumpu baru: bersihkan riwayat osilasi
      // masa lalu namun pertahankan hash terakhir sebagai baseline baru.
      for (const [, tracker] of fileTrackers) {
        const latest = tracker.history[tracker.history.length - 1] ?? null
        const visits = new Map<string, number>()
        visits.set(hashKey(latest), 1)
        tracker.history = [latest]
        tracker.visits = visits
        tracker.oscillationMessage = null
      }
      // [Fase 6A / ACE-04] Verifikasi hijau adalah kemajuan nyata: blokir
      // repeated-error tidak lagi relevan.
      activeBlock = null
      activeHeadlineBlock = null
      newEvidenceAfterBlock = false
      justifiedRetries = 0
      seenReadEvidence.clear()
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
      lastErrorHeadlineKey = null
      headlineErrorStreak = 0
      lastTodoArgsHash = null
    },
    noteAssistantResponse() {
      // [Wave 5 / G4] Narasi teks polos tidak boleh diam-diam mereset rentetan
      // PURE_READ lintas jeda antar-respons; reset hanya lewat mutasi nyata,
      // pembaruan todo_write yang berubah, noteVerificationPassed(), atau reset().
    },
    reset() {
      lastErrorFingerprint = null
      lastErrorActionKey = null
      repeatedErrorStreak = 0
      lastErrorHeadlineKey = null
      headlineErrorStreak = 0
      consecutiveReadCalls = 0
      lastTodoArgsHash = null
      activeBlock = null
      activeHeadlineBlock = null
      newEvidenceAfterBlock = false
      justifiedRetries = 0
      seenReadEvidence.clear()
      fileTrackers.clear()
      inflightPreHash.clear()
      inflightExecPreHashes.clear()
    },
    snapshot() {
      const oscillatingPaths: string[] = []
      for (const [p, t] of fileTrackers) {
        if (t.oscillationMessage) oscillatingPaths.push(p)
      }
      return {
        repeatedErrorStreak,
        consecutiveReadCalls,
        oscillatingPaths,
        newEvidenceSinceFailure: newEvidenceAfterBlock,
        justifiedRetriesUsed: justifiedRetries,
      }
    },
  }
}
