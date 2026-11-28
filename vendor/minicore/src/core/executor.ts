// Tool executor boundary. The kernel ships a sequential strategy; a parallel
// strategy can be added later by implementing the same interface, without
// changing the kernel. Each call runs the same deterministic pipeline:
// resolve → permission → validate → execute → normalize/truncate.

import { validateArgs } from "./tool.ts";
import type { ToolRegistry } from "./tool.ts";
import type { PermissionHandler } from "./permission.ts";
import type { EventBus } from "./events.ts";
import type { SessionState } from "./session.ts";
import type { Execution } from "./session.ts";
import type { ToolCall, ToolResult } from "./types.ts";
import { DEFAULT_CHARS_PER_TOKEN } from "./tokens.ts";
import { abortError } from "./errors.ts";
import { lazySnapshotState, snapshotExecution, snapshotToolCall } from "./snapshot.ts";

export interface ExecutorDeps {
  readonly registry: ToolRegistry;
  readonly permissions: PermissionHandler;
  readonly events: EventBus;
  readonly signal: AbortSignal;
  readonly state: Readonly<SessionState>;
  readonly maxResultTokens: number;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly permissionMode?: string;
  /**
   * Host seam (additive, optional): jelaskan tool built-in yang sengaja
   * TIDAK terdaftar di registry karena disembunyikan mode runtime (mis.
   * `bash` di WorkMode DISCUSS). Tanpa ini kernel hanya melihat "tak ada di
   * registry" dan mengembalikan `unknown tool`, yang membuat model mengira
   * salah argumen lalu retry buta. Mengembalikan `undefined` = pakai redaksi
   * lama, sehingga perilaku existing caller tak berubah.
   */
  readonly hiddenToolMessage?: (name: string) => string | undefined;
}

export interface ToolExecutor {
  execute(calls: readonly ToolCall[], deps: ExecutorDeps): Promise<readonly ToolResult[]>;
}

const errorResult = (call: ToolCall, message: string): ToolResult => ({
  role: "tool",
  toolCallId: call.id,
  name: call.name,
  content: message,
  isError: true,
});

export async function runCall(call: ToolCall, deps: ExecutorDeps): Promise<ToolResult> {
  throwIfAborted(deps.signal);
  const safeCall = snapshotToolCall(call);
  const tool = deps.registry.get(safeCall.name);
  if (!tool) {
    // Bedakan "tool memang tak ada" dari "tool dikenal tapi disembunyikan
    // mode": host memberi penjelasan lewat seam opsional. Cek ini SENGAJA
    // sebelum permission check (urutan kernel lama tak diubah).
    const hint = deps.hiddenToolMessage?.(safeCall.name);
    return errorResult(safeCall, hint?.trim() ? hint : `unknown tool: ${safeCall.name}`);
  }

  // The permission handler is user/policy code and may throw. Treat a crash
  // exactly like a tool error: a deterministic error result (observation),
  // never a raw rejection that escapes run() without an error taxonomy.
  let decision: Awaited<ReturnType<PermissionHandler["check"]>>;
  const permissionDeps: ExecutorDeps = { ...deps, state: lazySnapshotState(deps.state) };
  try {
    decision = await deps.permissions.check(snapshotToolCall(safeCall), permissionDeps);
  } catch (error) {
    throwIfAborted(deps.signal);
    return errorResult(safeCall, `permission error: ${error instanceof Error ? error.message : String(error)}`);
  }
  throwIfAborted(deps.signal);
  if (decision === "deny") {
    // Optional handler diagnostic, surfaced so the model observes an
    // actionable reason ("permission denied: <reason>"). Diagnostic-only:
    // describeDenial must never fail the denial itself — hence the guard.
    let suffix = "";
    try {
      const r = await deps.permissions.describeDenial?.(snapshotToolCall(safeCall));
      if (typeof r === "string" && r.trim()) suffix = `: ${r.trim().slice(0, 160)}`;
    } catch {
      /* reason is diagnostic-only; the denial stands */
    }
    return errorResult(safeCall, `permission denied${suffix}`);
  }

  const parsed = validateArgs(tool.parameters, safeCall.args);
  if (!parsed.ok) return errorResult(safeCall, `invalid arguments: ${parsed.message}`);
  throwIfAborted(deps.signal);

  const ctx = {
    signal: deps.signal,
    state: lazySnapshotState(deps.state),
    emit: deps.events.emit,
    cwd: deps.cwd,
    sessionId: deps.sessionId,
    permissionMode: deps.permissionMode,
  };
  // Started and completed events carry separate result objects so listeners
  // that retain the execution reference never observe later mutation.
  const started: Execution = { call: safeCall, result: { role: "tool", toolCallId: safeCall.id, name: safeCall.name, content: "" } };
  deps.events.emit({ type: "execution:started", execution: snapshotExecution(started) });
  let result: ToolResult;
  try {
    const content = await tool.execute(parsed.value, ctx);
    throwIfAborted(deps.signal);
    result = { role: "tool", toolCallId: safeCall.id, name: safeCall.name, content: serializeContent(content, deps.maxResultTokens) };
  } catch (error) {
    throwIfAborted(deps.signal);
    result = {
      role: "tool",
      toolCallId: safeCall.id,
      name: safeCall.name,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  deps.events.emit({ type: "execution:completed", execution: snapshotExecution({ call: safeCall, result }) });
  return result;
}

export function sequentialExecutor(): ToolExecutor {
  return {
    async execute(calls, deps) {
      const results: ToolResult[] = [];
      for (const call of calls) {
        throwIfAborted(deps.signal);
        results.push(await runCall(call, deps));
      }
      return results;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function clampHeadEnd(text: string, idx: number): number {
  if (idx <= 0 || idx >= text.length) return Math.max(0, Math.min(idx, text.length))
  const c = text.charCodeAt(idx - 1)
  return c >= 0xd800 && c <= 0xdbff ? idx - 1 : idx
}

function clampTailStart(text: string, idx: number): number {
  if (idx <= 0 || idx >= text.length) return Math.max(0, Math.min(idx, text.length))
  const c = text.charCodeAt(idx)
  return c >= 0xdc00 && c <= 0xdfff ? idx + 1 : idx
}

function serializeContent(value: unknown, maxTokens: number): unknown {
  if (value instanceof Uint8Array) return value;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const maxChars = maxTokens * DEFAULT_CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const noticeHead = "\n…[output dipotong: ";
  const noticeTail =
    " karakter tidak ditampilkan; jalankan ulang tool dengan batas lebih sempit (mis. path/baris/pola spesifik) atau baca bertahap]…\n";
  const noticeBudget = noticeHead.length + String(text.length).length + noticeTail.length;
  const usable = Math.max(0, maxChars - noticeBudget);
  const headEnd = clampHeadEnd(text, Math.floor(usable * 0.7));
  const tailBudget = Math.max(0, usable - headEnd);
  const tailStart = tailBudget > 0 ? clampTailStart(text, Math.max(headEnd, text.length - tailBudget)) : text.length;
  const omitted = Math.max(0, tailStart - headEnd);
  const tail = tailStart < text.length ? text.slice(tailStart) : "";
  return `${text.slice(0, headEnd)}${noticeHead}${omitted}${noticeTail}${tail}`;
}
