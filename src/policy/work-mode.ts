// WorkMode (S2.1) — lapis intent tipis di ATAS PermissionMode, bukan pengganti.
//
// Kenapa bukan sekadar projection mode: `PLAN × auto/ask` TIDAK boleh berubah
// menjadi `plan` polos, karena handler `plan` melewatkan gerbang approval
// `delegate_task` yang dimiliki `auto`/`ask` (owner decision S2.1). Jadi lapis
// ini memasang CEILING lebih dulu, lalu menyerahkan keputusan DI DALAM ceiling
// ke handler PermissionMode asli — allow/deny/prompt-nya utuh.
//
// Ceiling memakai handler `readonly`/`plan` yang sudah ada sebagai primitif:
// satu-satunya sumber daftar tool (18 nama read-only + 3 ekstra plan), tanpa
// menduplikasi READONLY_TOOLS atau membangun engine kedua.

import type { PermissionHandler, ToolCall } from "#minicore"
import type { PermissionMode } from "./permission.ts"
import {
  NETWORK_READ_TOOL_NAMES,
  PLAN_EXTRA_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "./tool-contract.ts"

export type WorkMode = "DISCUSS" | "EXECUTE"

export function normalizeWorkMode(mode?: WorkMode | string | null): WorkMode {
  return mode === "EXECUTE" ? "EXECUTE" : "DISCUSS"
}

/**
 * Error kebijakan startup saat `--verify` digabung dengan WorkMode non-EXECUTE
 * (keputusan owner P0.2 Q4: fail-closed di startup, bukan diam-diam menjalankan
 * shell verify atau menelannya tanpa penolakan).
 */
export class VerifyWorkModeConflictError extends Error {
  readonly workMode: Exclude<WorkMode, "EXECUTE">
  constructor(workMode: Exclude<WorkMode, "EXECUTE"> = "DISCUSS") {
    super(
      `[work-mode] --verify cannot be combined with WorkMode ${workMode} (verification runs shell commands and self-heal turns; use --work-mode BUILD or omit --verify)`,
    )
    this.name = "VerifyWorkModeConflictError"
    this.workMode = workMode
  }
}

/** WorkMode yang memasang ceiling. EXECUTE = identitas (base dipakai apa adanya). */
export type RestrictiveWorkMode = Exclude<WorkMode, "EXECUTE">

type ModeControl = {
  __setMode(m: PermissionMode): void
  __getMode(): PermissionMode
  __promptGated?(call: ToolCall, deps?: unknown): Promise<"allow" | "deny">
}

export type WorkModePermissionHandler = PermissionHandler &
  ModeControl & {
    // P12 S2.2 Slice 5 — kontrol WorkMode runtime (setWorkMode/getWorkMode).
    // Mirip __setMode/__getMode milik PM: kernel mengkonsultasi handler per
    // tool call, jadi __setWorkMode menggeser ceiling tanpa meng-ganti handler.
    __setWorkMode(m: WorkMode): void
    __getWorkMode(): WorkMode
    // Sinkronis dengan kontrak PermissionHandler vendor (dapat sinkron ATAU
    // Promise): deskripsi deny diharapkan sinkron oleh semua handler produksi,
    // tetapi executor kernel meng-await hasilnya — mengetik hanya string akan
    // memicu TS2322 dan mengabaikan kemungkinan handler asinkron.
    describeDenial(call: ToolCall): Promise<string | undefined> | string | undefined
  }

function requireModeControl(base: PermissionHandler): ModeControl {
  const ctrl = base as Partial<ModeControl>
  if (typeof ctrl.__getMode !== "function" || typeof ctrl.__setMode !== "function") {
    // Fail-closed: tanpa kontrol mode, ceiling DISCUSS tak bisa mengikuti mode PM
    // saat runtime — lebih baik menolak konstruksi daripada memakai snapshot
    // basi yang bisa mencabut ceiling setelah `__setMode`.
    throw new Error(
      "createWorkModePermissionHandler: base handler wajib mengekspos __getMode/__setMode (fail-closed)",
    )
  }
  return ctrl as ModeControl
}

// Seleksi ceiling per mode PM SAAT INI (bukan snapshot konstruksi):
// DISCUSS (gabungan diskusi + perencanaan) memakai ceiling read-only saat PM sudah
// lebih ketat (`allowlist`/`readonly`), selain itu ceiling plan (18 readonly + 3 plan extra).
function ceilingFor(_workMode: RestrictiveWorkMode, baseMode: PermissionMode): "readonly" | "plan" {
  return baseMode === "allowlist" || baseMode === "readonly" ? "readonly" : "plan"
}

// Tool Access Policy — ceiling capability WorkMode dihitung LANGSUNG dari
// registry kontrak tool (satu sumber):
// - DISCUSS → 18 `READONLY_TOOL_NAMES` (+ `PLAN_EXTRA_TOOL_NAMES`), atau
//   read-only saja bila PM sudah `readonly`/`allowlist` (lebih ketat).
function ceilingAllows(
  name: string,
  _workMode: RestrictiveWorkMode,
  baseMode: PermissionMode,
): boolean {
  if (baseMode === "readonly" || baseMode === "allowlist") return READONLY_TOOL_NAMES.has(name)
  return READONLY_TOOL_NAMES.has(name) || PLAN_EXTRA_TOOL_NAMES.has(name)
}

export function createWorkModePermissionHandler(opts: {
  workMode: WorkMode
  base: PermissionHandler
  root?: string
}): WorkModePermissionHandler {
  const ctrl = requireModeControl(opts.base)
  let wm: WorkMode = normalizeWorkMode(opts.workMode)
  const ceilingDenyHandlers: Record<"readonly" | "plan", PermissionHandler> = {
    readonly: {
      async check() {
        return "deny"
      },
      describeDenial() {
        return "read-only mode"
      },
    },
    plan: {
      async check() {
        return "deny"
      },
      describeDenial() {
        return "plan mode"
      },
    },
  }
  const discussNetworkDeny: PermissionHandler = {
    async check() {
      return "deny"
    },
    describeDenial() {
      return "work-mode DISCUSS: network read disabled"
    },
  }

  // Pemilik keputusan deny per-call, supaya `describeDenial` membaca seam
  // handler yang benar (ceiling vs base) dengan semantik hapus-saat-baca.
  const ownerById = new Map<string, PermissionHandler>()
  const ownerByRef = new WeakMap<object, PermissionHandler>()

  function rememberDeny(call: ToolCall, owner: PermissionHandler): void {
    try {
      const id = (call as { id?: unknown } | null)?.id
      if (typeof id === "string" && id) {
        if (ownerById.size > 500) ownerById.delete(ownerById.keys().next().value as string)
        ownerById.set(id, owner)
        return
      }
      if (call && typeof call === "object") ownerByRef.set(call as object, owner)
    } catch {}
  }

  function takeDenyOwner(call: ToolCall): PermissionHandler | undefined {
    try {
      const id = (call as { id?: unknown } | null)?.id
      if (typeof id === "string" && id) {
        const owner = ownerById.get(id)
        ownerById.delete(id)
        return owner
      }
      if (call && typeof call === "object") {
        const key = call as object
        const owner = ownerByRef.get(key)
        ownerByRef.delete(key)
        return owner
      }
    } catch {}
    return undefined
  }

  const handler = {
    async check(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      if (wm === "EXECUTE") return opts.base.check(call, _deps as never)
      const baseMode = ctrl.__getMode()
      const ceilingKind = ceilingFor(wm, baseMode)
      if (!ceilingAllows(call.name, wm, baseMode)) {
        rememberDeny(call, ceilingDenyHandlers[ceilingKind])
        return "deny"
      }
      // Di dalam ceiling DISCUSS: paksa enforceJail=true agar `DISCUSS × unrestricted`
      // tidak melompati jail workspace maupun proteksi berkas sensitif `.env` (INV-WM1).
      const baseDeps =
        _deps && typeof _deps === "object"
          ? { ...(_deps as Record<string, unknown>), enforceJail: true }
          : { enforceJail: true }
      const decision = await opts.base.check(call, baseDeps as never)
      if (decision !== "allow") {
        rememberDeny(call, opts.base)
        return decision
      }
      // Di DISCUSS, network read (`web_fetch`, `web_search`) wajib melewati
      // gerbang approval prompt eksplisit (headless/tanpa __promptGated = fail-closed deny).
      if (NETWORK_READ_TOOL_NAMES.has(call.name)) {
        if (typeof ctrl.__promptGated !== "function") {
          rememberDeny(call, discussNetworkDeny)
          return "deny"
        }
        const gated = await ctrl.__promptGated(call, _deps)
        if (gated !== "allow") rememberDeny(call, opts.base)
        return gated
      }
      return decision
    },
    __setMode(m: PermissionMode): void {
      ctrl.__setMode(m)
    },
    __getMode(): PermissionMode {
      return ctrl.__getMode()
    },
    __setWorkMode(m: WorkMode): void {
      wm = normalizeWorkMode(m)
    },
    __getWorkMode(): WorkMode {
      return wm
    },
    describeDenial(call: ToolCall): Promise<string | undefined> | string | undefined {
      const owner = takeDenyOwner(call)
      if (owner) {
        const seam = owner.describeDenial
        return typeof seam === "function" ? seam.call(owner, call) : undefined
      }
      if (wm === "EXECUTE") {
        const baseSeam = opts.base.describeDenial
        return typeof baseSeam === "function" ? baseSeam.call(opts.base, call) : undefined
      }
      return undefined
    },
  }
  return handler as WorkModePermissionHandler
}

/** Titik komposisi produksi: EXECUTE = base identitas, sisanya dibungkus ceiling. */
export function composeWorkModePermissionHandler(opts: {
  workMode: WorkMode
  base: PermissionHandler
  root?: string
}): PermissionHandler {
  const wm = normalizeWorkMode(opts.workMode)
  if (wm === "EXECUTE") return opts.base
  return createWorkModePermissionHandler({
    workMode: wm,
    base: opts.base,
    root: opts.root,
  })
}
