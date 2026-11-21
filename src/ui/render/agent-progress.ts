// Ringkasan progres sub-agent — helper MURNI (tanpa I/O, tanpa TTY).
//
// v0.33: satu sumber kebenaran untuk angka yang tampil di chat maupun,
// nanti, di kotak "aktivitas" sidebar. Transkrip hari ini memakai
// `formatAgentProgress()` untuk SATU baris yang ditimpa di tempat; sidebar
// nanti memakai state yang sama tanpa menghitung ulang.
//
// Angka WAJIB jujur: agent/tools dihitung dari id unik (retry & replay tak
// boleh menambah), failure dikelompokkan per alasan.

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
