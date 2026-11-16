// [Fase 2 / LOOP-INV-04, TOOL-01] SATU sumber kebenaran kontrak tool.
//
// Masalah yang ditutup: sebelum modul ini, klasifikasi efek samping tersebar di
// lima daftar manual yang bisa (dan pernah) menyimpang satu sama lain:
//
//   1. `WRITE_TOOLS` + `EXCLUSIVE_TOOLS`      (src/policy/executor.ts)
//   2. `GATED_TOOLS`                          (src/policy/permission.ts)
//   3. `MUTATION_TOOLS` + `NON_MUTATION_TOOLS`(src/session/journal.ts)
//   4. `EXPLORE_TOOL_NAMES`                   (src/tools/task.ts)
//   5. `TOOL_CAPABILITIES[].autonomous`       (src/task/autonomous-policy.ts)
//
// Semua daftar itu sekarang DITURUNKAN dari registry di bawah. Menambah tool
// baru berarti menambah satu entri di sini; tidak ada tempat lain untuk lupa.
//
// KEPUTUSAN PENTING — kenapa ada `journalMutation`:
//
// `sideEffectTier` menjawab "apakah tool ini mengubah sesuatu", sedangkan
// jurnal mutasi menjawab pertanyaan yang BERBEDA: "apakah efek ini perlu
// pasangan intent/terminal di jurnal mutasi?". `todo_write` mengubah plan
// (tier LOCAL_ENV_MUTATION) tetapi TIDAK dijurnal sebagai mutasi workspace,
// dan `web_fetch` punya efek eksternal tetapi tidak dijurnal. Menggabungkan
// keduanya akan mengubah perilaku recovery yang sudah teruji. Karena itu
// `journalMutation` dieksplisitkan, bukan disimpulkan.
//
// `code_run` mutasi workspace melalui sandbox RW. Karena itu ia harus menjadi
// exclusive di batch yang juga dapat membaca atau menulis file yang sama.

/** Kelas efek samping yang dideklarasikan sebuah tool. */
export type SideEffectTier =
  | "PURE_READ"
  | "WORKSPACE_MUTATION"
  | "LOCAL_ENV_MUTATION"
  | "EXTERNAL_IRREVERSIBLE"

/**
 * Kelas konkurensi untuk eksekutor batch.
 *
 * - `parallel-read`        boleh berjalan paralel dengan tool lain.
 * - `path-serialized-write` menulis workspace; butuh slot tulis + file-lock.
 * - `exclusive`            tidak punya path tunggal untuk dikunci; batch yang
 *                          memuatnya dijalankan sekuensial penuh.
 */
export type ConcurrencyClass = "parallel-read" | "path-serialized-write" | "exclusive"

export interface ToolContractMetadata {
  readonly name: string
  readonly sideEffectTier: SideEffectTier
  readonly concurrencyClass: ConcurrencyClass
  /** Di-gate approval secara default (izin generik tidak cukup). */
  readonly gatedByDefault: boolean
  /** Boleh terlihat oleh sub-agen mode `explore`. */
  readonly allowedInExplore: boolean
  /** Boleh dijalankan pada eksekusi otonom/background. */
  readonly allowedInAutonomous: boolean
  /**
   * Diizinkan tanpa persetujuan di mode permission `readonly`/`plan` (dan
   * tanpa prompt di `ask`/`auto`): tool yang tidak mengubah workspace maupun
   * state internal minicode — membaca saja. `bash_output` sengaja `false`
   * (hanya bermakna bila ada job `bash` yang sedang berjalan, yang dilarang
   * readonly); `web_fetch`/`web_search` sengaja `true` walau bertier eksternal
   * karena efeknya baca-jaringan, bukan mutasi lokal/irreversibel arsip.
   */
  readonly allowedInReadonly: boolean
  /** Efek yang diulang dengan input sama tidak menggandakan hasil. */
  readonly idempotent: boolean
  /** Butuh pasangan intent/terminal di jurnal mutasi (lihat catatan di atas). */
  readonly journalMutation: boolean
}

type ContractFlags = Partial<
  Omit<ToolContractMetadata, "name" | "sideEffectTier" | "concurrencyClass">
>

const C = (
  name: string,
  sideEffectTier: SideEffectTier,
  concurrencyClass: ConcurrencyClass,
  opts: ContractFlags = {},
): ToolContractMetadata => ({
  name,
  sideEffectTier,
  concurrencyClass,
  gatedByDefault: opts.gatedByDefault ?? false,
  allowedInExplore: opts.allowedInExplore ?? false,
  allowedInAutonomous: opts.allowedInAutonomous ?? false,
  allowedInReadonly: opts.allowedInReadonly ?? false,
  idempotent: opts.idempotent ?? false,
  journalMutation: opts.journalMutation ?? false,
})

const pr = (name: string, opts: ContractFlags = {}) =>
  C(name, "PURE_READ", "parallel-read", {
    allowedInExplore: true,
    allowedInAutonomous: true,
    allowedInReadonly: true,
    idempotent: true,
    ...opts,
  })
const ws = (name: string, idempotent = false) =>
  C(name, "WORKSPACE_MUTATION", "path-serialized-write", { idempotent, journalMutation: true })
const lm = (name: string, cc: ConcurrencyClass, opts: ContractFlags = {}) =>
  C(name, "LOCAL_ENV_MUTATION", cc, opts)
const ex = (name: string, cc: ConcurrencyClass, opts: ContractFlags = {}) =>
  C(name, "EXTERNAL_IRREVERSIBLE", cc, opts)

/**
 * Registry 38 tool bawaan. Urutan di sini adalah urutan tampilan/derivasi;
 * tidak ada konsumen yang boleh mengandalkan urutan selain derivasi daftar.
 */
export const TOOL_CONTRACTS: readonly ToolContractMetadata[] = [
  // ── PURE_READ ────────────────────────────────────────────────────────────
  pr("read_file"),
  pr("read_image", { allowedInExplore: false }),
  pr("glob"),
  pr("grep"),
  pr("git_status"),
  pr("git_diff", { allowedInExplore: false }),
  pr("git_log"),
  pr("read_memory"),
  pr("todo_read"),
  pr("mcp_list"),
  pr("lsp_diagnostics"),
  pr("lsp_definition"),
  pr("lsp_references", { allowedInExplore: false }),
  pr("lsp_hover"),
  pr("lsp_symbols", { allowedInExplore: false }),
  pr("lsp_workspace_symbols"),
  pr("bash_output", {
    allowedInExplore: false,
    allowedInAutonomous: false,
    allowedInReadonly: false,
  }),

  // ── WORKSPACE_MUTATION (path tunggal → slot tulis + file-lock) ───────────
  ws("write_file", true),
  ws("edit"),
  ws("apply_patch"),
  ws("move_file"),
  ws("delete_file", true),

  // ── LOCAL_ENV_MUTATION ──────────────────────────────────────────────────
  lm("bash", "exclusive", { journalMutation: true }),
  lm("bash_kill", "parallel-read"),
  lm("code_run", "exclusive", { journalMutation: true }),
  lm("write_memory", "exclusive", { journalMutation: true }),
  lm("forget_memory", "exclusive", { idempotent: true, journalMutation: true }),
  lm("todo_write", "exclusive", { idempotent: true }),
  lm("submit_result", "parallel-read"),
  lm("ask_user", "parallel-read", { gatedByDefault: true }),

  // ── EXTERNAL_IRREVERSIBLE ───────────────────────────────────────────────
  ex("git_commit", "exclusive", { gatedByDefault: true, journalMutation: true }),
  ex("git_push", "exclusive", { gatedByDefault: true, journalMutation: true }),
  ex("delegate_task", "parallel-read", { gatedByDefault: true, journalMutation: true }),
  ex("mcp_call", "parallel-read", { gatedByDefault: true, journalMutation: true }),
  ex("mcp_read", "parallel-read", { gatedByDefault: true, idempotent: true }),
  ex("mcp_prompt", "parallel-read", { gatedByDefault: true, idempotent: true }),
  ex("web_fetch", "parallel-read", { allowedInReadonly: true, idempotent: true }),
  ex("web_search", "parallel-read", { allowedInReadonly: true, idempotent: true }),
]

const BY_NAME: ReadonlyMap<string, ToolContractMetadata> = new Map(
  TOOL_CONTRACTS.map((c) => [c.name, c]),
)

/**
 * Kontrak efektif untuk satu nama tool.
 *
 * Tool MCP runtime (`server.tool`) mewarisi kelas `mcp_call`: efek arbitrer di
 * server eksternal. Nama tak dikenal mengembalikan `undefined` supaya pemanggil
 * bisa fail-closed sendiri (jurnal memutuskan "unknown" = mutation).
 */
export function contractForTool(name: string): ToolContractMetadata | undefined {
  const direct = BY_NAME.get(name)
  if (direct !== undefined) return direct
  // Nama bertitik = tool MCP runtime. `includes(".")` sama dengan isMcpToolName
  // tanpa mengimpor lapisan presentasi dari policy (batas lapisan).
  if (name.includes(".")) return BY_NAME.get("mcp_call")
  return undefined
}

/** Derivasi: tool yang mengubah workspace dengan path tunggal. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.concurrencyClass === "path-serialized-write").map((c) => c.name),
)

/** Derivasi: tool yang harus eksklusif (tanpa path tunggal untuk dikunci). */
export const EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.concurrencyClass === "exclusive").map((c) => c.name),
)

/** Derivasi: tool yang di-gate approval secara default. */
export const GATED_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.gatedByDefault).map((c) => c.name),
)

/** Derivasi: subset read-only untuk sub-agen `explore`. */
export const EXPLORE_TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.filter(
  (c) => c.allowedInExplore,
).map((c) => c.name)

/** Derivasi: subset yang boleh dijalankan eksekusi otonom. */
export const AUTONOMOUS_TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.filter(
  (c) => c.allowedInAutonomous,
).map((c) => c.name)

/**
 * Derivasi: tool yang diizinkan tanpa persetujuan di mode permission
 * `readonly`/`plan` (dan tanpa prompt di `ask`/`auto`) — baca-saja, tanpa
 * mutasi workspace maupun state internal. Sumber tunggal untuk `READONLY_TOOLS`
 * di src/policy/permission.ts; menambah/mengganti tool berarti mengubah
 * `allowedInReadonly` di registry ini, bukan mengedit dua daftar terpisah.
 */
export const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.allowedInReadonly).map((c) => c.name),
)

/**
 * Derivasi P0.2 (Q1/Q2): semua 16 tool `PURE_READ` lokal yang diizinkan pada
 * ceiling `DISCUSS` (`visible === callable`, nol mutasi workspace/DB, nol
 * network read). Diturunkan dari `TOOL_CONTRACTS` tanpa daftar manual kedua.
 */
export const LOCAL_READONLY_TOOL_NAMES: readonly string[] = TOOL_CONTRACTS.filter(
  (c) => c.allowedInReadonly && c.sideEffectTier === "PURE_READ",
).map((c) => c.name)

/**
 * Derivasi P0.2 (Q2): tool baca jaringan (`web_fetch`, `web_search`) —
 * `allowedInReadonly` untuk `EXECUTE`, ditolak penuh di `DISCUSS`, dan wajib
 * melewati gerbang approval prompt di `PLAN` (headless = deny).
 */
export const NETWORK_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.allowedInReadonly && c.sideEffectTier !== "PURE_READ").map(
    (c) => c.name,
  ),
)

/**
 * Derivasi Tool Access Policy: tool ekstra yang diizinkan pada ceiling PLAN
 * (di atas 18 `READONLY_TOOL_NAMES`). Tiga artefak perencanaan yang aman:
 *   - `todo_write`     → artefak rencana `.minicode/plans` (bukan file workspace)
 *   - `delegate_task`  → penelahan rencana (dipaksa explore/read-only di task.ts
 *                        bila parent PLAN — permission hanya membuka gerbangnya)
 *   - `submit_result`  → singleton memori-proses (exec --json) tanpa tulis file
 *
 * Satu sumber untuk ceiling WorkMode PLAN (`work-mode.ts`), visibilitas tool
 * (`tool-layer.ts`), dan handler PermissionMode `plan` warisan (`permission.ts`).
 */
export const PLAN_EXTRA_TOOL_NAMES: ReadonlySet<string> = new Set([
  "todo_write",
  "delegate_task",
  "submit_result",
])

/**
 * Derivasi klasifikasi jurnal. Tool tak dikenal = "unknown", dan pemanggil
 * (`isMutationTool`) memperlakukannya sebagai mutasi (fail-closed).
 */
export function classifyContractTool(name: string): "mutation" | "none" | "unknown" {
  const c = contractForTool(name)
  if (c === undefined) return "unknown"
  return c.journalMutation ? "mutation" : "none"
}
