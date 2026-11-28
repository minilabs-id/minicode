import { randomUUID } from "node:crypto"
import type { Tool } from "#minicore"
import type { ApprovalEventHook, ApprovalHookEvent } from "../presentation/events.ts"
import { sliceSafeChars } from "./context.ts"

// Tanya user di tengah run — untuk pilihan yang tidak bisa diputuskan model
// sendiri (ambiguitas kebutuhan, kredensial, "lanjut/tidak").
//
// DI seperti delegate_task: view pertanyaan di-inject dari composition root
// (cli/setup.ts), lapisan tool tidak mengimpor src/ui. Tanpa injeksi atau di
// luar TTY tool MENOLAK jalan (fail-closed) — model harus memilih default
// yang aman sendiri, bukan mengarang jawaban user.

export type AskTextFn = (
  question: string,
  options?: string[],
  signal?: AbortSignal,
) => Promise<string | null>

let askTextFn: AskTextFn | undefined

export function setAskTextFn(fn: AskTextFn | undefined): void {
  askTextFn = fn
}

// Hook observability Fase 1 (pola sama seperti setAskTextFn): pertanyaan dan
// hasilnya dilaporkan sebagai approval.requested/settled TANPA mengubah
// perilaku fail-closed tool. toolCallId absen di sini — ToolContext kernel
// tidak membawa id call sendiri, dan pertanyaan ini memang ditujukan ke user
// langsung, bukan gate atas tool lain.
let askApprovalHook: ApprovalEventHook | undefined

export function setAskApprovalHook(fn: ApprovalEventHook | undefined): void {
  askApprovalHook = fn
}

function emitAskApproval(e: ApprovalHookEvent): void {
  try {
    askApprovalHook?.(e)
  } catch {
    // Observability tak boleh menggagalkan tool.
  }
}

export const askUserTool: Tool = {
  name: "ask_user",
  // v7.33 (wire contract): tag INTERACT (interaksi manusia, bukan sub-agent).
  description:
    "INTERACT: Ask the user a clarifying question mid-run and wait for the answer. Use sparingly — only when blocked on a decision you cannot safely make alone. Fails outside an interactive terminal.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "single, clear question (max 2000 chars)" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "suggested choices (may be empty); empty answer cancels",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async execute({ question, options }, ctx) {
    ctx.signal.throwIfAborted()
    const q = sliceSafeChars(String(question ?? "").trim(), 2000)
    if (!q) throw new Error("question empty")
    const opts = Array.isArray(options)
      ? (options as unknown[]).map((o) => sliceSafeChars(String(o), 200)).slice(0, 8)
      : undefined
    // ID unik per pemanggilan, TIDAK bergantung counter modul: counter global
    // bertabrakan ketika beberapa sesi (atau beberapa turn yang di-replay)
    // berjalan di satu proses, sehingga approval.requested/settled dari sesi
    // berbeda bisa saling menimpa di reducer/adaptor. UUID menjamin keunikan
    // lintas sesi tanpa perlu menyentuh permission layer.
    const approvalId = `ap_${randomUUID()}`
    // Tanpa view ter-inject atau di luar TTY: tolak, jangan gantung.
    // Model harus melanjutkan dengan asumsi paling aman, bukan menunggu.
    const callInfo = { name: "ask_user", args: { question: q, options: opts } }
    if (!askTextFn) {
      emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "system" })
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "no-view" },
      })
      throw new Error("ask_user unavailable: no question view injected (headless run?)")
    }
    if (!process.stdin.isTTY) {
      emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "system" })
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "headless" },
      })
      throw new Error("ask_user unavailable: needs an interactive terminal")
    }
    emitAskApproval({ kind: "requested", approvalId, call: callInfo, via: "prompt" })
    let answer: string | null
    try {
      // v7.32: teruskan sinyal turn ke modal — abort memutus penungguan jawaban.
      answer = await askTextFn(q, opts, ctx.signal)
    } catch (e) {
      const aborted = (e instanceof Error && e.name === "AbortError") || ctx.signal.aborted
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: aborted
          ? { decision: "cancelled", by: "system", reason: "parent-aborted" }
          : { decision: "deny", by: "system", reason: "prompt-error" },
      })
      throw e
    }
    if (answer == null || !answer.trim()) {
      emitAskApproval({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "user", reason: "declined" },
      })
      throw new Error("ask_user cancelled (empty answer)")
    }
    emitAskApproval({
      kind: "settled",
      approvalId,
      call: callInfo,
      outcome: { decision: "allow", by: "user" },
    })
    return sliceSafeChars(answer.trim(), 4000)
  },
}
