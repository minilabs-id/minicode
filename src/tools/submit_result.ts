import type { Tool } from "#minicore"

// Hasil terstruktur akhir task — pengganti response_format:json_schema yang
// tidak didukung semua provider. Tanpa tool ini model "menyimpulkan" dalam
// teks bebas dan CLI (exec --json) harus menebak batas JSON dari prosa.
// State per proses cukup: satu run CLI = satu sesi (seperti todoSession).

export interface SubmittedResult {
  result: unknown
  summary?: string
  at: number
}

const DEFAULT_SESSION_KEY = "__default__"
const submittedBySession = new Map<string, SubmittedResult>()
let latestSessionKey: string | null = null

const scopeKey = (sessionId?: string): string =>
  typeof sessionId === "string" && sessionId.length > 0 ? sessionId : DEFAULT_SESSION_KEY

export function getSubmittedResult(sessionId?: string): SubmittedResult | null {
  if (sessionId !== undefined) {
    return submittedBySession.get(scopeKey(sessionId)) ?? null
  }
  if (latestSessionKey !== null && submittedBySession.has(latestSessionKey)) {
    return submittedBySession.get(latestSessionKey) ?? null
  }
  return submittedBySession.get(DEFAULT_SESSION_KEY) ?? null
}

export function clearSubmittedResult(sessionId?: string): void {
  if (sessionId !== undefined) {
    const key = scopeKey(sessionId)
    submittedBySession.delete(key)
    if (latestSessionKey === key) latestSessionKey = null
    return
  }
  submittedBySession.clear()
  latestSessionKey = null
}

export const submitResultTool: Tool = {
  name: "submit_result",
  // v7.33 (wire contract): tag RESULT; kontrak findings dipertahankan.
  description:
    "RESULT: Submit the final structured result as a JSON object (call once when done; exec --json surfaces it verbatim). A result.findings array of {category, severity, summary, evidence?} is also surfaced as finding.detected events.",
  parameters: {
    type: "object",
    properties: {
      result: {
        type: "object",
        additionalProperties: true,
        description: "final structured result (JSON object, not string)",
      },
      summary: { type: "string", description: "one-line summary for logs" },
    },
    required: ["result"],
    additionalProperties: false,
  },
  async execute({ result, summary }, ctx) {
    ctx.signal.throwIfAborted()
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("result must be a JSON object")
    const s = typeof summary === "string" ? summary.slice(0, 300) : undefined
    const sid = scopeKey((ctx as unknown as { sessionId?: string }).sessionId)
    submittedBySession.set(sid, { result, ...(s ? { summary: s } : {}), at: Date.now() })
    latestSessionKey = sid
    const bytes = JSON.stringify(result).length
    return `submitted (${bytes} bytes)${s ? `: ${s}` : ""}`
  },
}
