// Fixture matriks WorkMode × PermissionMode (2-mode: DISCUSS | EXECUTE) — DATA test-only.
//
// `DISCUSS` menyatukan investigasi read-only, diskusi, dan perencanaan:
// - Mengizinkan 18 `READONLY_TOOL_NAMES` + 3 `PLAN_EXTRA` (`todo_write`,
//   `delegate_task` [explore], `submit_result`) = 21 tool saat PM `auto`/`ask`/
//   `plan`/`allow-all`, atau 18 `READONLY_TOOL_NAMES` saat PM `readonly`/`allowlist`.
// - `web_fetch` & `web_search` wajib approval prompt di DISCUSS (di seluruh 6 PM;
//   headless tanpa broker = deny), dan mengikuti PM di EXECUTE.
// - Hooks diblokir di DISCUSS untuk seluruh 6 PM.
// - `--verify` ditolak fail-closed saat startup di DISCUSS.
//
// `ceiling` = ceiling WorkMode yang dipasang SEBELUM handler PM memutuskan:
//   "readonly" → hanya 18 READONLY_TOOL_NAMES (+ prompt wajib untuk network read di DISCUSS);
//   "plan"     → 18 READONLY_TOOL_NAMES + 3 PLAN_EXTRA (+ prompt wajib untuk network read di DISCUSS);
//   "none"     → EXECUTE, tanpa ceiling (handler PM apa adanya).

import type { PermissionMode } from "../../src/policy/permission.ts"
import type { WorkMode } from "../../src/policy/work-mode.ts"

export interface WorkModeCell {
  workMode: WorkMode
  permissionMode: PermissionMode
  ceiling: "readonly" | "plan" | "none"
  networkRead: "prompt" | "pm"
  hooks: "blocked" | "allowed"
  verify: "refused" | "allowed"
  /** Catatan keputusan yang menyimpang dari tabel literal (bila ada). */
  note?: string
}

export const WORK_MODE_CELLS: readonly WorkModeCell[] = [
  {
    workMode: "DISCUSS",
    permissionMode: "auto",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "delegate_task & network read wajib lewat gerbang approval (headless deny / TTY prompt)",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "ask",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "delegate_task & network read wajib lewat gerbang approval (headless deny / TTY prompt)",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "plan",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "allow-all",
    ceiling: "plan",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "allowlist",
    ceiling: "readonly",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
    note: "lebih ketat dari irisan literal (owner-approved): read-only saja + prompt untuk network read",
  },
  {
    workMode: "DISCUSS",
    permissionMode: "readonly",
    ceiling: "readonly",
    networkRead: "prompt",
    hooks: "blocked",
    verify: "refused",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "auto",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "ask",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "plan",
    ceiling: "none",
    networkRead: "pm",
    hooks: "blocked",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "allow-all",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "allowlist",
    ceiling: "none",
    networkRead: "pm",
    hooks: "allowed",
    verify: "allowed",
  },
  {
    workMode: "EXECUTE",
    permissionMode: "readonly",
    ceiling: "none",
    networkRead: "pm",
    hooks: "blocked",
    verify: "allowed",
  },
] as const

export function cellOf(workMode: WorkMode, permissionMode: PermissionMode): WorkModeCell {
  const cell = WORK_MODE_CELLS.find(
    (c) => c.workMode === workMode && c.permissionMode === permissionMode,
  )
  if (!cell) throw new Error(`fixture: sel ${workMode} × ${permissionMode} tidak ada`)
  return cell
}
