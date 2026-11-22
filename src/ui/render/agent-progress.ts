// Agregat `✦` sub-agent di chat — murni, tanpa I/O/TTY. Satu baris ditimpa
// di tempat. Sidebar v0.33 tak jadi; jangan tambah pane untuk angka ini.
// Angka jujur: agent/tools dari id unik, failure dikelompokkan per alasan.

import { t } from "../i18n/locale.ts"
import { glyphs } from "./theme.ts"

export type AgentFailureReason = "aborted" | "timeout" | "denied" | "error"

export interface AgentProgressSnapshot {
  readonly agents: number
  readonly tools: number
  readonly failures: Readonly<Record<AgentFailureReason, number>>
}

export const EMPTY_AGENT_PROGRESS: AgentProgressSnapshot = {
  agents: 0,
  tools: 0,
  failures: { aborted: 0, timeout: 0, denied: 0, error: 0 },
}

function failureDetail(failures: AgentProgressSnapshot["failures"]): string {
  const parts: string[] = []
  for (const reason of ["aborted", "timeout", "denied", "error"] as const) {
    const n = failures[reason] ?? 0
    if (n > 0) parts.push(`${n} ${t(`ts.agentReason.${reason}`)}`)
  }
  return parts.length ? ` (${parts.join(" · ")})` : ""
}

/** Satu baris ringkas: `✦ 4 sub agent · 25 tool · 3 gagal (2 abort · 1 timeout)`. */
export function formatAgentProgress(s: AgentProgressSnapshot): string {
  const failed = Object.values(s.failures).reduce((a, b) => a + b, 0)
  return `${glyphs.agentIcon} ${t("ts.agentSummary", {
    agents: Math.max(0, Math.floor(s.agents)),
    tools: Math.max(0, Math.floor(s.tools)),
    failed,
  })}${failed > 0 ? failureDetail(s.failures) : ""}`
}
