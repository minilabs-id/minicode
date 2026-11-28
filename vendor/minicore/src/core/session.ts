// Session: configuration binding + lifecycle records. The loop lives in
// loop.ts; this module only composes the parts and exposes a minimal API.

import type { BudgetPolicy } from "./budget.ts";
import { defaultBudgetPolicy } from "./budget.ts";
import type { CompactionStrategy } from "./compact.ts";
import { mechanicalCompaction } from "./compact.ts";
import { AgentError, abortError } from "./errors.ts";
import type { AgentEvent, EventBus } from "./events.ts";
import { createEventBus } from "./events.ts";
import type { ToolExecutor } from "./executor.ts";
import { sequentialExecutor } from "./executor.ts";
import { ContextStore } from "./history.ts";
import type { PermissionHandler } from "./permission.ts";
import type { ModelProvider } from "./provider.ts";
import type { RecoveryPolicy } from "./recovery.ts";
import { defaultRecoveryPolicy } from "./recovery.ts";
import { executeTurn } from "./loop.ts";
import { snapshotState, snapshotTurnResult } from "./snapshot.ts";
import type { Tool, ToolRegistry } from "./tool.ts";
import { createToolRegistry } from "./tool.ts";
import type { TokenEstimator } from "./tokens.ts";
import { defaultTokenEstimator, estimateSessionContext } from "./tokens.ts";
import type { Message, ToolCall, ToolResult } from "./types.ts";

export const DEFAULT_MAX_STEPS = 50;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_TOOL_RESULT_MAX_TOKENS = 4_096;
export const DEFAULT_KEEP_RECENT_TURNS = 3;

export const DEFAULT_TIMEOUT_MS = 600_000;

export interface SessionConfig {
  provider: ModelProvider;
  permissions: PermissionHandler;
  tools?: readonly Tool[];
  system?: string;
  /** Dynamic system prompt for host-controlled per-turn mode hints. */
  systemForContext?: () => string;
  model?: string;
  cwd?: string;
  sessionId?: string;
  /**
   * Session permission mode, forwarded to each turn's ToolContext so tools
   * can adapt their behavior. Plain string or live getter — prefer the
   * getter when the mode can change at runtime. Optional; absent preserves
   * the legacy behavior (ctx.permissionMode undefined).
   */
  permissionMode?: string | (() => string);
  /**
   * Seed history untuk sesi baru (mis. resume dari storage). Messages akan
   * di-append ke ContextStore saat createSession, jadi `session.state.history`
   * langsung memuatnya dan turn berikutnya meneruskan konteks penuh.
   */
  initialMessages?: readonly Message[];
  turnCount?: number;
  stepCount?: number;
  executor?: ToolExecutor;
  budget?: BudgetPolicy;
  estimator?: TokenEstimator;
  /** Skema tool aktual yang dikirim ke wire (mis. pasca filter hiddenWireTools) agar budget loop konsisten. */
  wireTools?: () => readonly import("./tool.ts").ToolSchema[];
  compaction?: CompactionStrategy;
  recovery?: RecoveryPolicy;
  maxSteps?: number;
  contextWindowTokens?: number;
  /** Resolve a model-specific context limit for each run. Additive app seam;
   * the numeric option remains the fallback for existing library callers. */
  contextWindowTokensForModel?: (model?: string) => number;
  /** Resolve the step limit for each run. Additive app seam (mirrors
   * `contextWindowTokensForModel`): the host may raise the limit as the session
   * proves it needs more steps, while `maxSteps` stays the validated fallback. */
  maxStepsForRun?: () => number;
  /** Batas output model (`max_output_tokens`) bila endpoint melaporkannya.
   * Seam aditif: dipakai loop untuk menghitung reserve output proporsional —
   * tanpa ini kernel hanya bisa memakai reserve angka tetap, yang terlalu
   * besar untuk model berbatas output kecil dan terlalu kecil untuk jendela
   * raksasa. `undefined` = tak diketahui (pemanggil memakai default). */
  maxOutputTokensForModel?: (model?: string) => number | undefined;
  toolResultMaxTokens?: number;
  keepRecentTurns?: number;
  /**
   * Hard deadline for a single run() call, in milliseconds. When exceeded, the
   * turn is aborted and run() rejects with AgentError("timeout") — even if the
   * in-flight provider/tool ignores the abort signal. Defaults to
   * DEFAULT_TIMEOUT_MS (10 minutes); set to Infinity to disable.
   */
  timeoutMs?: number;
  /**
   * Inactivity timeout for a single run() call, in milliseconds. Resets
   * whenever steps, tool executions, or provider stream deltas/extensions
   * occur, and grants wake grace across OS sleep jumps. Set to Infinity (or
   * omit) to disable.
   */
  idleTimeoutMs?: number;
  /**
   * Reports errors thrown by event listeners. Observer code must never be able
   * to break a turn (lifecycle/executor events) nor trigger a spurious retry
   * (provider streaming events): emit catches every handler error, reports it
   * here, and continues. Defaults to console.error.
   */
  onHandlerError?: (error: unknown, event: AgentEvent) => void;
}

export interface SessionState {
  readonly history: readonly Message[];
  turnCount: number;
  stepCount: number;
  readonly model?: string;
}

export interface Execution {
  readonly call: ToolCall;
  readonly result: ToolResult;
}

export interface Step {
  readonly index: number;
  readonly toolCalls: readonly ToolCall[];
  readonly results: readonly ToolResult[];
}

export interface TurnResult {
  readonly steps: readonly Step[];
  readonly finalText?: string;
  readonly usage: { readonly turns: number; readonly steps: number };
}

export interface Session {
  /**
   * Point-in-time defensive snapshot of the committed session state.
   *
   * Each access deep-copies the committed history and counters, so a
   * same-process caller that casts away the read-only types and mutates the
   * result can never corrupt the kernel's state (the committed history that
   * feeds the next turn) — the mutation touches only the caller's copy.
   *
   * Semantics: the returned value is a snapshot, not a live view. A reference
   * held across a run stays frozen at the moment it was read; re-access
   * `session.state` for fresh data. Committed state changes only when a turn
   * completes successfully, and for change notification prefer the event bus
   * (`turn:completed`, `step:completed`). Cost is O(history) per access, so
   * read once per turn rather than polling.
   */
  readonly state: Readonly<SessionState>;
  readonly events: EventBus;
  /**
   * Current context size from the same source of truth as the loop's
   * pressure evaluation (messages + system + tools under the session
   * estimator). One number for drivers and UI — no duplicate estimator.
   * O(history) per access (snapshot pattern); recomputed over the
   * committed store on every access.
   */
  readonly contextTokens: number;
  run(input: string, opts?: { signal?: AbortSignal; model?: string }): Promise<TurnResult>;
  abort(): void;
  /**
   * Selipkan pesan user ke TURN YANG SEDANG BERJALAN (steering, seperti
   * "steer" di opencode): pesan menjadi pesan `user` di store turn aktif pada
   * batas step berikutnya — sebelum request provider — sehingga model melihatnya
   * di turn yang sama tanpa menghentikan pekerjaan yang sedang berjalan.
   *
   * `false` = tidak diterima karena tidak ada turn aktif (pesan tidak disimpan
   * diam-diam: pemanggil yang memutuskan menjalankannya sebagai turn berikutnya).
   * Turn bersifat transaksional — pesan steering yang belum sempat masuk store
   * (turn abort/timeout/gagal) hilang bersama turn itu, bukan menumpang ke
   * prompt turn berikutnya.
   */
  steer(text: string): boolean;
}

/** Internal handle consumed by loop.ts. Not part of the public surface. */
export interface SessionInternal {
  readonly provider: ModelProvider;
  readonly permissions: PermissionHandler;
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly system?: string;
  readonly systemForContext?: () => string;
  readonly model?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly permissionMode?: string | (() => string);
  readonly budget: BudgetPolicy;
  readonly estimator: TokenEstimator;
  readonly wireTools?: () => readonly import("./tool.ts").ToolSchema[];
  readonly compaction: CompactionStrategy;
  readonly recovery: RecoveryPolicy;
  readonly maxSteps: number;
  readonly maxStepsForRun?: () => number;
  readonly contextWindowTokens: number;
  readonly contextWindowTokensForModel?: (model?: string) => number;
  readonly maxOutputTokensForModel?: (model?: string) => number | undefined;
  readonly toolResultMaxTokens: number;
  readonly keepRecentTurns: number;
  readonly timeoutMs: number;
  readonly idleTimeoutMs?: number;
  readonly store: ContextStore;
  readonly events: EventBus;
  readonly state: SessionState;
  /**
   * Antrean steering (internal, dipakai loop.ts). Array-nya DIBAGI antara impl
   * sesi dan turn yang berjalan — `{ ...impl }` menyalin referensinya, jadi
   * `steer()` dari host terlihat oleh loop yang sedang menunggu provider/tool.
   */
  readonly pendingSteers: string[];
}

interface SessionImpl extends SessionInternal {
  sessionAbort: AbortController;
  running: boolean;
}

export function createSession(config: SessionConfig): Session {
  const store = new ContextStore();
  if (config.initialMessages?.length) store.appendAll(config.initialMessages);
  const events = createEventBus({ onHandlerError: config.onHandlerError });
  const sessionAbort = new AbortController();
  const state: SessionState = {
    history: store.messages,
    turnCount: config.turnCount ?? 0,
    stepCount: config.stepCount ?? 0,
    model: config.model,
  };

  const impl: SessionImpl = {
    provider: config.provider,
    permissions: config.permissions,
    registry: createToolRegistry(config.tools ?? []),
    executor: config.executor ?? sequentialExecutor(),
    system: config.system,
    systemForContext: config.systemForContext,
    model: config.model,
    cwd: config.cwd,
    sessionId: config.sessionId,
    permissionMode: config.permissionMode,
    budget: config.budget ?? defaultBudgetPolicy,
    estimator: config.estimator ?? defaultTokenEstimator,
    wireTools: config.wireTools,
    compaction: config.compaction ?? mechanicalCompaction,
    recovery: config.recovery ?? defaultRecoveryPolicy,
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    maxStepsForRun: config.maxStepsForRun,
    contextWindowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    contextWindowTokensForModel: config.contextWindowTokensForModel,
    maxOutputTokensForModel: config.maxOutputTokensForModel,
    toolResultMaxTokens: config.toolResultMaxTokens ?? DEFAULT_TOOL_RESULT_MAX_TOKENS,
    keepRecentTurns: config.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    store,
    events,
    state,
    pendingSteers: [],
    sessionAbort,
    running: false,
  };

  return {
    // Public state crosses a host boundary, so it is a defensive snapshot per
    // access (same policy as provider requests, tool ctx.state, and event
    // payloads). The kernel keeps the raw object internally via `impl.state`.
    get state() {
      return snapshotState(state);
    },
    get events() {
      return events;
    },
    // Same source of truth as the loop — estimateSessionContext in
    // tokens.ts — never a duplicate estimator.
    get contextTokens() {
      let system = config.system
      try {
        system = config.systemForContext?.() ?? system
      } catch {}
      let tools: readonly import("./tool.ts").ToolSchema[] = impl.registry.list();
      try {
        tools = impl.wireTools?.() ?? tools;
      } catch {}
      return estimateSessionContext(store, system, tools, impl.estimator);
    },
    async run(input, opts) {
      if (impl.running) throw new AgentError("busy", "session is already running");
      impl.running = true;
      const timeout = createTimeout(impl.timeoutMs);
      const idleTimeout = createActivityTimeout(events, impl.idleTimeoutMs);
      const joined = joinSignals(
        impl.sessionAbort.signal,
        opts?.signal,
        timeout.signal,
        idleTimeout.signal,
      );
      const turnStore = new ContextStore();
      turnStore.appendAll(store.messages);
      const turnState: SessionState = {
        history: turnStore.messages,
        turnCount: state.turnCount,
        stepCount: state.stepCount,
        model: opts?.model ?? config.model,
      };
      const turnImpl: SessionInternal = {
        ...impl,
        store: turnStore,
        state: turnState,
      };
      try {
        const turn = executeTurn(turnImpl, input, joined.signal, opts?.model);
        // The race guarantees run() rejects as soon as the joined signal
        // aborts (user abort, session.abort, or timeout), even if the
        // in-flight provider/tool ignores the signal. Any late work mutates
        // only turnStore and is discarded.
        const result = await withAbort(turn, joined.signal);
        // A run is transactional with respect to model context: failed,
        // aborted, or timed-out turns are discarded instead of leaving orphaned
        // user messages or assistant tool_calls without matching tool results.
        // Non-cooperative providers/tools may still settle after withTimeout
        // rejects, but they mutate only this private turnStore.
        store.replace(0, store.messages.length, turnStore.messages);
        state.turnCount = turnState.turnCount;
        state.stepCount = turnState.stepCount;
        events.emit({ type: "turn:completed", result: snapshotTurnResult(result) });
        return result;
      } catch (error) {
        // B3 (host seam): on abort/timeout/error, the turn is transactional —
        // but a long turn that only reads (no mutations) would otherwise lose
        // all accumulated context on resume. Commit the partUp to a complete
        // step boundary so a later run/resume can continue instead of amnesia.
        const safe = safeTurnBoundary(store.messages.length, turnStore.messages);
        if (safe.length > store.messages.length) {
          store.replace(0, store.messages.length, safe);
          events.emit({ type: "turn:interrupted" });
        }
        throw error;
      } finally {
        timeout.cancel();
        idleTimeout.cancel();
        joined.cleanup();
        impl.running = false;
        // Steering yang belum sempat di-drain terkubur bersama turn ini. Tanpa
        // ini sisa antrean (mis. pesan yang masuk tepat sebelum abort) bocor ke
        // turn berikutnya sebagai `user` di depan prompt baru — percakapan
        // menjadi bohong: model membalas pesan dari turn yang sudah dibatalkan.
        impl.pendingSteers.length = 0;
        if (impl.sessionAbort.signal.aborted) impl.sessionAbort = new AbortController();
      }
    },
    abort() {
      if (impl.running) impl.sessionAbort.abort(new AgentError("aborted", "turn aborted"));
    },
    steer(text) {
      const value = text.trim()
      // Hanya turn AKTIF yang bisa diselipi. Saat idle, pesan tidak ditampung
      // diam-diam: host harus menjalankannya sebagai prompt biasa agar tidak
      // ada pesan yang "hilang" tanpa jejak.
      if (!value || !impl.running) return false
      impl.pendingSteers.push(value)
      return true
    },
  };
}

function joinSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup(): void } {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  if (active.length <= 1) {
    return active[0] ? { signal: active[0], cleanup: noop } : { signal: new AbortController().signal, cleanup: noop };
  }
  const alreadyAborted = active.find((s) => s.aborted);
  if (alreadyAborted) return { signal: alreadyAborted, cleanup: noop };
  const controller = new AbortController();
  const handlers: Array<[AbortSignal, () => void]> = active.map((s) => {
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener("abort", onAbort, { once: true });
    return [s, onAbort];
  });
  return {
    signal: controller.signal,
    cleanup() {
      for (const [signal, onAbort] of handlers) signal.removeEventListener("abort", onAbort);
    },
  };
}

function noop(): void {}

interface Timeout {
  readonly signal: AbortSignal;
  cancel(): void;
}

function createTimeout(ms: number): Timeout {
  const controller = new AbortController();
  const error = new AgentError("timeout", `turn exceeded ${ms}ms`);
  // setTimeout clamps a non-finite delay to 1ms in Node/Bun, so Infinity would
  // abort the turn almost immediately instead of disabling the deadline.
  const timer = Number.isFinite(ms) ? setTimeout(() => controller.abort(error), ms) : undefined;
  return {
    signal: controller.signal,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Watchdog berbasis aktivitas per-turn: hanya membatalkan bila benar-benar
 * tidak ada aktivitas kernel selama `ms`, dengan proteksi sleep/hibernate OS
 * agar lompatan jam dinding tidak memutus turn yang baru bangun.
 */
function createActivityTimeout(events: EventBus, ms?: number): Timeout {
  const controller = new AbortController();
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return { signal: controller.signal, cancel: noop };
  }
  const idleMs = Math.max(1, Math.floor(ms));
  const JS_TIMER_MAX = 2_147_483_647;
  const WAKE_JUMP_MS = 15_000;
  let lastTouchMono = performance.now();
  let lastTouchWall = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const arm = (remainingMs = idleMs) => {
    if (timer !== undefined) clearTimeout(timer);
    if (closed || controller.signal.aborted) return;
    const step = Math.min(remainingMs, JS_TIMER_MAX);
    const leftAfter = remainingMs - step;
    timer = setTimeout(() => {
      if (closed || controller.signal.aborted) return;
      if (leftAfter > 0) {
        arm(leftAfter);
        return;
      }
      const monoDelta = Math.max(0, performance.now() - lastTouchMono);
      const wallDelta = Math.max(0, Date.now() - lastTouchWall);
      if (wallDelta - monoDelta > WAKE_JUMP_MS) {
        lastTouchMono = performance.now();
        lastTouchWall = Date.now();
        arm(idleMs);
        return;
      }
      controller.abort(new AgentError("timeout", `turn inactive for ${idleMs}ms`));
    }, step);
  };

  const touch = () => {
    if (closed || controller.signal.aborted) return;
    lastTouchMono = performance.now();
    lastTouchWall = Date.now();
    arm(idleMs);
  };

  const unsubs = [
    events.on("step:started", touch),
    events.on("step:completed", touch),
    events.on("execution:started", touch),
    events.on("execution:completed", touch),
    events.on("provider:text", touch),
    events.on("provider:extension", touch),
  ];
  arm(idleMs);

  return {
    signal: controller.signal,
    cancel: () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
    },
  };
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Redam unhandled rejection dari promise yang sudah dimulai (mis. executeTurn).
    promise.catch(noop);
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
    function cleanup() {
      signal.removeEventListener("abort", onAbort);
    }
  });
}

/**
 * B3 — batas commit aman untuk turn yang terputus (abort/timeout/error).
 *
 * `executeTurn` selalu memulai turnStore dengan prefix committed + SATU pesan
 * `user` (input), lalu per step menambah assistant(toolCalls) → tool results;
 * steering menambah `user` lain di batas step. Abort bisa meninggalkan (a) `user`
 * yang belum dibalas — input awal maupun steering — atau (b) `assistant(toolCalls)`
 * yang hasilnya belum sempat di-append (orphan). Keduanya HARUS dibuang:
 * (a) karena menyimpannya membuat dua `user` berurutan pada run berikutnya
 * (invariant role bergantian → HTTP 400), (b) karena pasangan tool-call/result
 * yang menggantung akan ditolak dilihat resume. Selain itu, commit sejauh
 * langkah lengkap terakhir.
 */
function safeTurnBoundary(committedLen: number, messages: readonly Message[]): readonly Message[] {
  let end = messages.length
  while (end > committedLen) {
    const last = messages[end - 1]
    if (last?.role === "user") {
      // Input/steering yang belum dibalas model: menyimpannya membuat run
      // berikutnya mengirim dua `user` berurutan (ditolak provider) atau
      // meninggalkan pesan yang tak pernah dijawab di histori.
      end--
      continue
    }
    if (last && last.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length > 0) {
      end-- // orphaned toolCalls tanpa hasil
      continue
    }
    break
  }
  return messages.slice(0, end)
}
