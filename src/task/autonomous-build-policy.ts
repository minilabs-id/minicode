import { createPermissionHandler } from "../policy/permission.ts"
import { createWorkModePermissionHandler, type WorkMode } from "../policy/work-mode.ts"
import {
  AUTONOMOUS_TOOL_NAMES,
  type AutonomousPermissionHandler,
  type AutonomousPolicyLedger,
  assertAutonomousToolScope,
  createAutonomousPermissionHandler,
} from "./autonomous-policy.ts"

/**
 * Tool tambahan yang diizinkan untuk eksekusi otonom TERBATAS WORK MODE `EXECUTE` (`BUILD`).
 *
 * Sengaja TIDAK memasukkan tool interaktif (`ask_user`), mutasi graph tugas
 * (`todo_write`, `submit_result`), delegasi rekursif (`delegate_task`), atau
 * operasi eksternal/push (`git_push`, `git_commit`, `mcp_*`, `web_*`), supaya
 * worker otonom tetap terjail di workspace dan tervalidasi sebelum COMPLETED.
 */
export const AUTONOMOUS_WORKSPACE_WRITE_TOOLS: readonly string[] = [
  "write_file",
  "edit",
  "apply_patch",
  "move_file",
  "delete_file",
  "git_restore",
  "git_checkout",
  "lsp_rename",
  "bash",
  "bash_kill",
  "bash_output",
  "code_run",
  "write_memory",
  "forget_memory",
]

export const AUTONOMOUS_BUILD_TOOL_NAMES: readonly string[] = [
  ...new Set([...AUTONOMOUS_TOOL_NAMES, ...AUTONOMOUS_WORKSPACE_WRITE_TOOLS]),
]

const AUTONOMOUS_BUILD_TOOL_SET: ReadonlySet<string> = new Set(AUTONOMOUS_BUILD_TOOL_NAMES)

/**
 * Validasi daftar tool terhadap WorkMode aktif:
 * - `DISCUSS` (default): tetap 100% read-only (kontrak Phase 6S `assertAutonomousToolScope`).
 * - `EXECUTE` (`BUILD`): mengizinkan subset tulis-workspace + build/test terjail, menolak tool luar ruang lingkup.
 */
export function assertModeBoundedAutonomousToolScope(
  toolNames: readonly string[],
  workMode: WorkMode = "DISCUSS",
): void {
  if (workMode !== "EXECUTE") {
    assertAutonomousToolScope(toolNames)
    return
  }
  const disallowed = toolNames.filter((name) => !AUTONOMOUS_BUILD_TOOL_SET.has(name))
  if (disallowed.length > 0) {
    throw new Error(
      `autonomous BUILD execution refused; tools outside autonomous BUILD scope: ${disallowed.join(", ")}`,
    )
  }
}

export interface ModeBoundedAutonomousPermissionOptions {
  readonly ledger: AutonomousPolicyLedger
  readonly workMode: WorkMode
  readonly cwd: string
  readonly restrictBash?: boolean
  readonly bashAllowlist?: readonly string[]
}

/**
 * Gerbang izin runtime untuk eksekusi otonom sadar WorkMode:
 * - `DISCUSS`: delegasi persis ke handler read-only 6S (tanpa mutasi apa pun).
 * - `EXECUTE`: bungkus handler `auto` + jail workspace ketat, tanpa prompt manusia
 *   (`allowNonTtyAsk: false`) dan tolak setiap tool di luar `AUTONOMOUS_BUILD_TOOL_SET`.
 */
export function createModeBoundedAutonomousPermissionHandler(
  opts: ModeBoundedAutonomousPermissionOptions,
): AutonomousPermissionHandler {
  if (opts.workMode !== "EXECUTE") {
    return createAutonomousPermissionHandler(opts.ledger)
  }
  const inner = createWorkModePermissionHandler({
    workMode: "EXECUTE",
    root: opts.cwd,
    base: createPermissionHandler({
      mode: "auto",
      root: opts.cwd,
      allowNonTtyAsk: false,
      allowLocalConfig: false,
      restrictBash: opts.restrictBash === true,
      ...(opts.bashAllowlist ? { bashAllowlist: opts.bashAllowlist } : {}),
    }),
  })
  return {
    async check(call, deps) {
      if (!AUTONOMOUS_BUILD_TOOL_SET.has(call.name)) {
        opts.ledger.deny(call.name, "NOT_AUTONOMOUS")
        return "deny"
      }
      const decision = await inner.check(
        call as Parameters<typeof inner.check>[0],
        deps as Parameters<typeof inner.check>[1],
      )
      if (decision !== "allow") {
        opts.ledger.deny(call.name, "OUT_OF_SCOPE")
        return "deny"
      }
      opts.ledger.allow(call.name)
      return "allow"
    },
    describeDenial: (call) => {
      const desc = inner.describeDenial?.(call as Parameters<typeof inner.check>[0])
      return typeof desc === "string" ? desc : undefined
    },
  }
}
