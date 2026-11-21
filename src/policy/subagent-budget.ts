// Budget langkah sub-agent yang adaptif terhadap LUAS SCOPE — helper MURNI.
//
// Riset (OpenCode `steps: 8` untuk reviewer, Claude Code `maxTurns` + partial
// output): budget per-agent memang lazim, dan angka tetap (5) terlalu sempit
// untuk audit repo. Modul ini sengaja TIDAK mengubah fallback kontrak lama
// (`SUB_AGENT_BUDGET_EXPLORE/PLAN`) — dipakai HANYA bila caller mengirim
// `scope`. Jadi test/ADR lama tetap hijau.

export type DelegationScope = "file" | "dir" | "subtree" | "repo"
export type ChildMode = "explore" | "plan"

const SCOPE_BASE: Readonly<Record<DelegationScope, number>> = {
  // v0.33 (audit sesi 91681815): `file:6` bikin sub-agent mentok 6/6 saat
  // diminta "baca lima berkas". OpenCode memakai steps:8 untuk reviewer, jadi
  // 12 untuk file masih wajar (5 read + reasoning + ringkasan).
  file: 12,
  dir: 18,
  subtree: 26,
  repo: 36,
}

/** Budget awal dari scope + mode. Clamp ke [8,50] — hard-cap delegasi. */
export function budgetForScope(scope: DelegationScope, mode: ChildMode): number {
  const base = SCOPE_BASE[scope] ?? SCOPE_BASE.dir
  const scaled = mode === "plan" ? Math.ceil(base * 1.5) : base
  return Math.max(8, Math.min(50, scaled))
}

/**
 * Tebak scope dari prompt bila caller tak mengirim `scope` eksplisit.
 * Heuristik konservatif: lebih baik dir (10) daripada 5, tapi tak pernah repo
 * hanya karena kata "audit" — menghindari biaya meledak.
 */
export function inferScope(prompt: string): DelegationScope {
  const p = prompt.toLowerCase()
  if (/\b(seluruh|whole|entire|full)\b.*\brepo\b|\brepo\b.*\b(audit|wide|semua)\b/.test(p))
    return "repo"
  if (/\bsubtree\b|\bdirektori\b.*\b(bawah|children|nested)\b|\brecursive\b/.test(p))
    return "subtree"
  if (/\.(ts|tsx|js|jsx|md|json|py|go|rs)\b/.test(p) && !/\bdir\b|\bdirectory\b/.test(p))
    return "file"
  return "dir"
}

/** Tangga eskalasi KHUSUS sub-agent. Sengaja terpisah dari tangga sesi utama
 *  `[200,400,...]` yang kalau dipakai bikin anak loncat 5 → 50 (clamp). */
export const SUB_AGENT_STEP_LADDER: readonly number[] = [8, 12, 20, 32, 50] as const

export function nextSubAgentStepLimit(current: number, observed: number): number | undefined {
  const from = Math.max(
    Number.isFinite(current) && current > 0 ? Math.floor(current) : 0,
    Number.isFinite(observed) && observed > 0 ? Math.floor(observed) : 0,
  )
  for (const step of SUB_AGENT_STEP_LADDER) {
    if (step > from) return step
  }
  return undefined
}
