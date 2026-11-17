import { describe, expect, test } from "bun:test"
import { ProviderError } from "#minicore"
import { cappedRecovery } from "../src/app/session.ts"
import { computeUnavailableWireTools } from "../src/app/tool-layer.ts"
import type { MinicodeConfig } from "../src/config.ts"
import { renameWithRetry } from "../src/lib/atomic-write.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

describe("v0.30.0 hardening regressions", () => {
  test("renameWithRetry retries transient Windows/AV locks and rethrows non-retryable errors", async () => {
    let calls = 0
    await renameWithRetry("a.tmp", "a.txt", {
      maxRetries: 4,
      renameFn: async () => {
        calls++
        if (calls < 3) {
          const err = new Error("busy") as NodeJS.ErrnoException
          err.code = calls === 1 ? "EBUSY" : "EACCES"
          throw err
        }
      },
    })
    expect(calls).toBe(3)

    let enoentCalls = 0
    await expect(
      renameWithRetry("missing.tmp", "a.txt", {
        maxRetries: 4,
        renameFn: async () => {
          enoentCalls++
          const err = new Error("missing") as NodeJS.ErrnoException
          err.code = "ENOENT"
          throw err
        },
      }),
    ).rejects.toThrow("missing")
    expect(enoentCalls).toBe(1)
  })

  test("computeUnavailableWireTools hides unconfigured MCP/LSP and non-interactive ask_user", () => {
    const emptyCfg = {} as Pick<MinicodeConfig, "mcpServers" | "lspServers">
    const hidden = computeUnavailableWireTools(emptyCfg, { interactiveAsk: false })
    expect(hidden.has("mcp_list")).toBe(true)
    expect(hidden.has("mcp_call")).toBe(true)
    expect(hidden.has("lsp_diagnostics")).toBe(true)
    expect(hidden.has("ask_user")).toBe(true)

    const configuredCfg = {
      mcpServers: [{ id: "m1", transport: "stdio", command: "echo" }],
      lspServers: [{ id: "ts", language: "typescript", command: "typescript-language-server" }],
    } as unknown as Pick<MinicodeConfig, "mcpServers" | "lspServers">
    const noneHidden = computeUnavailableWireTools(configuredCfg, {
      sandboxMode: "docker",
      interactiveAsk: true,
    })
    expect(noneHidden.size).toBe(0)
  })

  test("cappedRecovery fails fast on HTTP 402 / quota exceeded", () => {
    expect(
      cappedRecovery.onError(new ProviderError("unknown", "HTTP 402: Payment Required"), 1),
    ).toEqual({
      type: "throw",
    })
    expect(
      cappedRecovery.onError(new ProviderError("unknown", "insufficient_quota on account"), 1),
    ).toEqual({
      type: "throw",
    })
  })

  test("Transcript.clear resets thinkingRowId and replaceEntry updates thinking lines cleanly", () => {
    setSessionLocale("en")
    try {
      const bus = createFakeBus()
      const uiState = new UiSessionState({ activityPanel: true, reasoningVisible: true })
      const transcript = new Transcript(bus as never, { uiState })

      // Turn 1: thinking segment + execution commits thinking row #1, kemudian replaceEntry pada segmen kedua.
      bus.emit("turn:started", {})
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "step 1\n" } })
      bus.emit("execution:started", { call: { id: "c1", name: "read_file", args: {} } })
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "step 2\n" } })
      bus.emit("turn:completed", {})
      expect(transcript.view(80, 10, 0).join("\n")).toContain("thinking · 2 lines")

      // Clear lalu turn baru: thinkingRowId tidak boleh basi dan tetap membentuk baris baru.
      transcript.clear()
      expect(transcript.size()).toBe(0)
      bus.emit("turn:started", {})
      bus.emit("provider:extension", { kind: "reasoning", data: { text: "fresh thought\n" } })
      bus.emit("turn:completed", {})
      const afterClear = transcript.view(80, 10, 0).join("\n")
      expect(afterClear).toContain("thinking · 1 lines")
      expect(afterClear).not.toContain("2 lines")
    } finally {
      resetLocaleState()
    }
  })
})
