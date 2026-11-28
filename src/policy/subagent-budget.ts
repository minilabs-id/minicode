// Budget langkah sub-agent yang adaptif terhadap LUAS SCOPE — helper MURNI.
// Anggaran awal mengikuti scope (`24/40/64/100` dengan pengali `1.5` untuk `plan`),
// sementara hard-cap delegasi dikunci oleh `LIMITS.SUB_AGENT_MAX_STEPS` (600).

export type DelegationScope = "file" | "dir" | "subtree" | "repo"
export type ChildMode = "explore" | "plan"

const SCOPE_BASE: Readonly<Record<DelegationScope, number>> = {
  // Proyek besar membutuhkan anggaran baca/telusur yang cukup agar tidak
  // berulang kali terpotong di tengah investigasi; hard-cap 600 + watchdog
  // tetap menjadi pengaman atas.
  file: 24,
  dir: 40,
  subtree: 64,
  repo: 100,
}

/** Budget awal dari scope + mode. Clamp ke [24,600] — hard-cap delegasi. */
export function budgetForScope(scope: DelegationScope, mode: ChildMode): number {
  const base = SCOPE_BASE[scope] ?? SCOPE_BASE.dir
  const scaled = mode === "plan" ? Math.ceil(base * 1.5) : base
  return Math.max(24, Math.min(600, scaled))
}

/**
 * Tebak scope dari prompt bila caller tak mengirim `scope` eksplisit.
 * Mengakomodasi kata kunci repo/proyek/codebase serta subtree/file.
 */
const KNOWN_WORKSPACE_ROOTS = new Set([
  "src",
  "cli",
  "docs",
  "test",
  "tests",
  "scripts",
  "vendor",
  "packages",
  "apps",
  "examples",
  ".audit",
  ".minicode",
])

/** Ekstrak akar direktori workspace dan file eksplisit yang disebut di prompt (abaikan URL dan slash prosa seperti read/write). */
function analyzePromptScopeTargets(prompt: string): {
  dirRoots: Set<string>
  explicitFiles: Set<string>
} {
  const withoutUrls = prompt.replace(/https?:\/\/\S+/gi, " ")
  const dirRoots = new Set<string>()
  for (const m of withoutUrls.matchAll(/(?:^|[\s(`"'[,])([a-z0-9_.-]+\/(?:[a-z0-9_./*+-]*))/gi)) {
    const token = m[1]!.toLowerCase()
    const slash = token.indexOf("/")
    const root = token.slice(0, slash)
    if (root === "." || root === ".." || root === "") continue
    const rest = token.slice(slash + 1)
    const isRealPath =
      token.endsWith("/") ||
      rest.includes("/") ||
      /\.[a-z0-9]{1,8}$/i.test(rest) ||
      KNOWN_WORKSPACE_ROOTS.has(root)
    if (isRealPath) dirRoots.add(root)
  }
  const explicitFiles = new Set<string>()
  for (const m of withoutUrls.matchAll(
    /\b([a-z0-9_.-]+\.(?:ts|tsx|js|jsx|md|json|py|go|rs))\b/gi,
  )) {
    explicitFiles.add(m[1]!.toLowerCase())
  }
  return { dirRoots, explicitFiles }
}

export function inferScope(prompt: string): DelegationScope {
  const p = prompt.toLowerCase()
  if (
    /\b(?:seluruh|whole|entire|full)\b.*\b(?:repo|project|proyek|codebase|bagian|modul|sistem|aplikasi)\b|\b(?:repo|project|proyek|codebase)\b.*\b(?:audit|wide|semua|besar|large)\b|\baudit\s+(?:menyeluruh|total)\b/.test(
      p,
    )
  )
    return "repo"
  const { dirRoots, explicitFiles } = analyzePromptScopeTargets(prompt)
  // Audit lintas >=3 area/direktori tingkat-atas (mis. src/, cli/, docs/, test/)
  // butuh pagu repo agar sub-agent tidak kehabisan step saat merangkum hasil.
  if (dirRoots.size >= 3) return "repo"
  if (
    dirRoots.size === 2 ||
    /\bsubtree\b|\bdirektori\b.*\b(bawah|children|nested)\b|\brecursive\b/.test(p)
  )
    return "subtree"
  if (
    explicitFiles.size === 1 &&
    /\.(ts|tsx|js|jsx|md|json|py|go|rs)\b/.test(p) &&
    !/\bdir\b|\bdirectory\b|\bfiles\b|\bmodules\b/.test(p)
  )
    return "file"
  return "dir"
}

/** Tangga eskalasi KHUSUS sub-agent yang selaras dengan SCOPE_BASE baru
 *  hingga hard-cap 600 (`LIMITS.SUB_AGENT_MAX_STEPS`). */
export const SUB_AGENT_STEP_LADDER: readonly number[] = [
  24, 40, 64, 100, 150, 250, 400, 600,
] as const

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
