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

/**
 * [v7.33 / audit F2] Jenis argumen path yang DIAWASSI jail permission.
 *
 * `file` = argumen `path` (atau `destination` untuk `move_file`) harus berada
 * di dalam workspace; `cwd` = argumen `cwd` yang jadi direktori kerja; `none` =
 * tak ada path yang dijail. Flag ini EKSPLISIT (bukan disimpulkan dari tier)
 * karena `bash_output` bertier PURE_READ tapi masuk kelas internal-write, dan
 * `read_file` bertier PURE_READ tapi WAJIB dijail path-nya. Menurunkan jail dari
 * sini menutup fail-open: tool tulis baru lewat `ws(...)` otomatis dapat jail.
 */
export type JailTarget = "file" | "cwd" | "none"

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
  /** [v7.33] Argumen path yang dijail permission (lihat JailTarget). */
  readonly jailTarget: JailTarget
  /**
   * [v7.33] Menulis state INTERNAL minicode (memory/todo/hasil/job), bukan file
   * workspace. Sumber tunggal `INTERNAL_WRITE_TOOLS` di permission.ts. Beda dari
   * `jailTarget:"file"`: state internal dikelola minicode, tak punya path user.
   */
  readonly internalWrite: boolean
  /**
   * [v7.33] Tak perlu prompt di mode `ask` (bookkeeping sepele yang izinnya
   * sudah melekat). Sumber tunggal `NO_PROMPT_TOOLS` di permission.ts. Sengaja
   * TIDAK termasuk memory: menulis MEMORY.md persisten tetap butuh persetujuan.
   */
  readonly noPrompt: boolean
  /**
   * [v7.33] Diizinkan pada ceiling WorkMode PLAN (artefak perencanaan aman).
   * Sumber tunggal `PLAN_EXTRA_TOOL_NAMES` — dulu literal hardcode di modul ini.
   */
  readonly allowedInPlan: boolean
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
  // v7.33: default fail-closed — jail hanya untuk tool yang eksplisit
  // mendeklarasikannya. `ws(...)` meng-override ke "file" (lihat helper).
  jailTarget: opts.jailTarget ?? "none",
  internalWrite: opts.internalWrite ?? false,
  noPrompt: opts.noPrompt ?? false,
  allowedInPlan: opts.allowedInPlan ?? false,
})

const pr = (name: string, opts: ContractFlags = {}) =>
  C(name, "PURE_READ", "parallel-read", {
    allowedInExplore: true,
    allowedInAutonomous: true,
    allowedInReadonly: true,
    idempotent: true,
    ...opts,
  })
// v7.33: `ws(...)` = tool tulis workspace dengan satu argumen `path`.
// Menetapkan `jailTarget:"file"` DI HELPER berarti tool ke-39 (atau ke-N)
// yang ditambahkan lewat `ws(...)` otomatis ter-jail DAN auto-allowed —
// tidak lagi fail-open seperti saat jail masih berupa daftar nama manual.
const ws = (name: string, idempotent = false, opts: ContractFlags = {}) =>
  C(name, "WORKSPACE_MUTATION", "path-serialized-write", {
    idempotent,
    journalMutation: true,
    jailTarget: "file",
    ...opts,
  })
const lm = (name: string, cc: ConcurrencyClass, opts: ContractFlags = {}) =>
  C(name, "LOCAL_ENV_MUTATION", cc, opts)
const ex = (name: string, cc: ConcurrencyClass, opts: ContractFlags = {}) =>
  C(name, "EXTERNAL_IRREVERSIBLE", cc, opts)

/**
 * Registry 41 tool bawaan. Urutan di sini adalah urutan tampilan/derivasi;
 * tidak ada konsumen yang boleh mengandalkan urutan selain derivasi daftar.
 */
export const TOOL_CONTRACTS: readonly ToolContractMetadata[] = [
  // ── PURE_READ ────────────────────────────────────────────────────────────
  // `read_file`/`read_image` bertier baca tapi path-nya tetap dijail (symlink
  // keluar workspace / file sensitif ditolak) — jailTarget eksplisit, bukan
  // dari tier. `glob`/`grep`/`git_*` memakai argumen `cwd` → jailTarget "cwd".
  // v7.40 (audit): tool LSP pembaca path juga memakai argumen `path`/`file`.
  // Dulu jailTarget default "none"-nya ditutup oleh klasifikasi prefix `lsp_`
  // di permission.ts (sumber kebenaran KEDUA yang bisa drift). Sekarang
  // jailTarget:"file" ditetapkan eksplisit di sini — satu flag, satu derivasi.
  pr("read_file", { jailTarget: "file" }),
  // v0.43.2: tool PURE_READ lain juga boleh masuk explore. KENAPA aman:
  // semuanya read-only dan jailTarget eksplisit ("file"/"cwd") sudah membatasi
  // path; menyembunyikannya hanya melemahkan eksplorasi tanpa menambah keamanan.
  pr("read_image", { allowedInExplore: true, jailTarget: "file" }),
  pr("glob", { jailTarget: "cwd" }),
  pr("grep", { jailTarget: "cwd" }),
  pr("git_status", { jailTarget: "cwd" }),
  pr("git_diff", { allowedInExplore: true, jailTarget: "cwd" }),
  pr("git_log", { jailTarget: "cwd" }),
  pr("read_memory"),
  pr("todo_read"),
  pr("mcp_list"),
  pr("lsp_diagnostics", { jailTarget: "file" }),
  pr("lsp_definition", { jailTarget: "file" }),
  pr("lsp_references", { allowedInExplore: true, jailTarget: "file" }),
  pr("lsp_hover", { jailTarget: "file" }),
  pr("lsp_symbols", { allowedInExplore: true, jailTarget: "file" }),
  pr("lsp_workspace_symbols", { jailTarget: "file" }),
  // v7.33: `bash_output` secara historis masuk INTERNAL_WRITE + NO_PROMPT
  // (bookkeeping job bash), meski tier-nya PURE_READ — flag eksplisit menjaga
  // klasifikasi lama tetap utuh setelah sets di permission.ts diturunkan.
  pr("bash_output", {
    allowedInExplore: false,
    allowedInAutonomous: false,
    allowedInReadonly: false,
    internalWrite: true,
    noPrompt: true,
  }),

  // ── WORKSPACE_MUTATION (path tunggal → slot tulis + file-lock) ───────────
  ws("write_file", true),
  ws("edit"),
  ws("apply_patch"),
  ws("move_file"),
  ws("delete_file", true),
  // v7.38: tool tulis baru memakai `ws(...)` → otomatis jailTarget:"file" dan
  // FILE_WRITE_TOOL_NAMES. `gatedByDefault` karena restore/rename merusak kerja
  // user; idempotent sengaja false (destructive → tetap butuh persetujuan).
  ws("git_restore", false, { gatedByDefault: true }),
  ws("git_checkout", false, { gatedByDefault: true }),
  ws("lsp_rename", false, { gatedByDefault: true }),

  // ── LOCAL_ENV_MUTATION ──────────────────────────────────────────────────
  // `bash` memakai argumen `cwd` → jailTarget "cwd". Sisanya yang mengubah
  // state internal (memory/todo/job/hasil) diberi `internalWrite:true`; subsets
  // sepele yang tak butuh prompt diberi `noPrompt:true`; artefak perencanaan
  // (`todo_write`, `submit_result`) diberi `allowedInPlan:true`.
  lm("bash", "exclusive", { journalMutation: true, jailTarget: "cwd" }),
  lm("bash_kill", "parallel-read", { internalWrite: true, noPrompt: true }),
  lm("code_run", "exclusive", { journalMutation: true }),
  lm("write_memory", "exclusive", { journalMutation: true, internalWrite: true }),
  lm("forget_memory", "exclusive", {
    idempotent: true,
    journalMutation: true,
    internalWrite: true,
  }),
  lm("todo_write", "exclusive", {
    idempotent: true,
    internalWrite: true,
    noPrompt: true,
    allowedInPlan: true,
  }),
  lm("submit_result", "parallel-read", {
    internalWrite: true,
    noPrompt: true,
    allowedInPlan: true,
  }),
  lm("ask_user", "parallel-read", { gatedByDefault: true }),

  // ── EXTERNAL_IRREVERSIBLE ───────────────────────────────────────────────
  // `git_commit` punya argumen `cwd` (dan `paths`, dicek terpisah di permission)
  // — historical cwd-jail memakai `startsWith("git_")`, jadi ikut jailTarget "cwd"
  // supaya derivasi set identik dengan enumerasi lama.
  ex("git_commit", "exclusive", {
    gatedByDefault: true,
    journalMutation: true,
    jailTarget: "cwd",
  }),
  ex("git_push", "exclusive", { gatedByDefault: true, journalMutation: true }),
  // `delegate_task` adalah artefak perencanaan: izin dibuka di ceiling PLAN,
  // tapi anak dipaksa explore/read-only di task.ts (permission hanya gerbang).
  ex("delegate_task", "parallel-read", {
    gatedByDefault: true,
    journalMutation: true,
    allowedInPlan: true,
  }),
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
 * `allowedInReadonly` untuk `EXECUTE`; di `DISCUSS` (termasuk ceiling PLAN)
 * TIDAK ditolak mentah-mentah, melainkan lewat gerbang approval prompt
 * eksplisit `__promptGated` (headless / tanpa gerbang = fail-closed deny).
 * Koreksi v7.40: komentar lama "ditolak penuh di DISCUSS" salah — work-mode.ts
 * mengizinkan via prompt, bukan deny absolut.
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
 * v7.33: dulu literal hardcode di modul ini — kini DITURUNKAN dari flag
 * `allowedInPlan` supaya menjadi satu sumber bersama `tool-contract.ts`.
 * Satu sumber untuk ceiling WorkMode PLAN (`work-mode.ts`), visibilitas tool
 * (`tool-layer.ts`), dan handler PermissionMode `plan` warisan (`permission.ts`).
 */
export const PLAN_EXTRA_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.allowedInPlan).map((c) => c.name),
)

// ── [v7.33 / audit F2] Satu sumber kebenaran untuk klasifikasi permission ──
// Semua set di bawah DITURUNKAN dari flag di TOOL_CONTRACTS, bukan daftar nama
// manual di permission.ts. Menambah tool baru (mis. lewat `ws(...)`) otomatis
// masuk kelas yang tepat — menutup fail-open jail yang dulu mengandalkan
// enumerasi nama yang bisa lupa diperbarui. Test no-drift di
// test/audit-fix-governance.test.ts mengunci kesetaraan dengan nilai lama.

/** Tool tulis workspace (path-serialized) yang auto-allowed & ter-jail path. */
export const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter(
    (c) => c.jailTarget === "file" && c.sideEffectTier === "WORKSPACE_MUTATION",
  ).map((c) => c.name),
)

/**
 * Tool dengan argumen `path` (atau `destination`) yang wajib dijail ke workspace.
 *
 * v7.40 (audit): LSP pembaca path punya jailTarget:"file" (satu sumber flag),
 * TETAPI jail-nya dijalankan cabang LSP_FILE_JAIL di permission.ts — cabang itu
 * juga menerima argumen `file`, bukan hanya `path`. Mengikutsertakan mereka di
 * sini MAUPUN di set LSP = double-jail yang memakai dua bentuk argumen berbeda.
 * Karena itu tool LSP PURE_READ dikecualikan di sini dan tetap dijail lewat
 * set LSP yang juga diturunkan dari flag yang sama (lihat di bawah).
 */
export const FILE_JAIL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter(
    (c) =>
      c.jailTarget === "file" && !(c.name.startsWith("lsp_") && c.sideEffectTier === "PURE_READ"),
  ).map((c) => c.name),
)

/** Tool dengan argumen `cwd` yang wajib dijail ke workspace. */
export const CWD_JAIL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.jailTarget === "cwd").map((c) => c.name),
)

/**
 * Tool LSP yang menjail argumen `path` (kini seragam dengan tool lain).
 * v7.40 (audit): turunan dari FLAG `jailTarget:"file"` BUKAN prefix nama.
 * Dulu `name.startsWith("lsp_")` mengklasifikasi ulang tool LSP secara
 * independen dari kontraknya — sumber kebenaran kedua yang bisa drift saat
 * tool ditambah/diganti. Sekarang flag yang menentukan. `lsp_rename` adalah
 * WORKSPACE_MUTATION yang sudah jailTarget:"file" lewat `ws(...)` dan sudah
 * masuk FILE_JAIL_TOOL_NAMES — dikecualikan di sini supaya tidak dijail dua
 * kali (dua cabang jail dengan bentuk argumen berbeda). Prefix `lsp_` tetap
 * dipakai HANYA sebagai pembeda cabang jail, bukan pengganti flag.
 */
export const LSP_FILE_JAIL_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter(
    (c) => c.jailTarget === "file" && c.name.startsWith("lsp_") && c.sideEffectTier === "PURE_READ",
  ).map((c) => c.name),
)

/** Tool yang menulis state internal minicode (bukan file workspace). */
export const INTERNAL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.internalWrite).map((c) => c.name),
)

/** Tool bookkeeping yang tak butuh prompt approval di mode `ask`. */
export const NO_PROMPT_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter((c) => c.noPrompt).map((c) => c.name),
)

/**
 * Derivasi klasifikasi jurnal. Tool tak dikenal = "unknown", dan pemanggil
 * (`isMutationTool`) memperlakukannya sebagai mutasi (fail-closed).
 */
export function classifyContractTool(name: string): "mutation" | "none" | "unknown" {
  const c = contractForTool(name)
  if (c === undefined) return "unknown"
  return c.journalMutation ? "mutation" : "none"
}
