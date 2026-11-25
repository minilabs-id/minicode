// Error yang TIDAK cocok dengan pola kanonik TIDAK boleh membocorkan pesan mentah.
// `friendlyToolErrorCanonical()` mengembalikan "" agar pemanggil punya kesempatan
// jatuh ke `formatError`/`formatProviderError`, sedangkan `friendlyToolError()` dan
// renderer baris tool menampilkan narasi fallback aman OS-locale (`msg.unknownToolError`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { friendlyToolError, friendlyToolErrorCanonical } from "../src/ui/render/errors.ts"
import { __setSystemLocaleForTest, tSystem } from "../src/ui/render/tool-label.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { createFakeBus, type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined

beforeEach(() => {
  __setSystemLocaleForTest("en")
  setSessionLocale("en")
})

afterEach(() => {
  tty?.restore()
  tty = undefined
  __setSystemLocaleForTest(null)
  resetLocaleState()
})

describe("friendlyToolErrorCanonical", () => {
  test("fallback (tak dikenal) → string kosong pada canonical, narasi aman pada friendlyToolError", () => {
    expect(friendlyToolErrorCanonical("boom")).toBe("")
    const fallback = friendlyToolError("boom")
    expect(fallback).toBe(tSystem("msg.unknownToolError"))
    expect(fallback).not.toContain("boom")
  })

  test("sub-agent memakai redaksi kanonik locale OS", () => {
    expect(
      friendlyToolErrorCanonical(
        "[sub-agent explore error] turn aborted | partial: belum terverifikasi",
      ),
    ).toBe(tSystem("msg.subagentFailed"))
  })

  test("minimal 4 pola kanonik lain tetap menghasilkan redaksi non-kosong", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["duplicate idempotency key abc-123", tSystem("msg.duplicateAction")],
      ["bash-guard internal error: blocked rm", tSystem("msg.guardError")],
      ["failed: exit 1", tSystem("msg.cmdFailed", { target: "-" })],
      ["read failed: EIO: something", tSystem("msg.toolFailed")],
      ["unknown tool: do_thing", tSystem("msg.toolNotFound")],
      ["permission denied: outside workspace", tSystem("msg.permissionDenied")],
      ["read_file timed out after 5000ms", tSystem("msg.toolTimeout")],
      ["ENOENT: no such file or directory", tSystem("msg.targetNotFound")],
    ]
    for (const [raw, expected] of cases) {
      expect(friendlyToolErrorCanonical(raw), `raw: ${raw}`).toBe(expected)
      expect(friendlyToolErrorCanonical(raw), `raw: ${raw}`).not.toBe("")
    }
  })

  test("target disanitasi & redaksi satu baris ≤120 kolom seperti friendlyToolError", () => {
    const out = friendlyToolErrorCanonical("exit 2", "bash")
    expect(out).toBe(tSystem("msg.cmdFailed", { target: "bash" }))
    expect(out).not.toContain("\n")
  })
})

/**
 * Jalankan printer linear sungguhan (bukan string builder) dengan bus tiruan,
 * lalu kembalikan apa yang benar-benar ditulis ke stderr.
 *
 * `execution:started` sengaja tidak dipancarkan: baris awal memuat argumen tool
 * dan akan mengganggu assertion "boom tak boleh muncul di output". Fokus test
 * ini adalah baris error pada `execution:completed`.
 */
function renderLinearError(content: string): string {
  tty = installFakeTty({ isTTY: false, columns: 100, rows: 24 })
  const bus = createFakeBus()
  const detach = attachSimpleLogger(bus as never, { uiState: new UiSessionState({}) })
  try {
    const call = { id: "c1", name: "bash", args: { cmd: "echo hi" } }
    bus.emit("execution:completed", {
      execution: { call, result: { isError: true, content } },
    })
    return tty.allErr()
  } finally {
    detach()
  }
}

describe("supresi redaksi error di printer linear", () => {
  test("isError:true + 'boom' → error mentah tak tampil, tampil narasi aman OS-locale", () => {
    const out = renderLinearError("boom")
    expect(out).not.toContain("boom")
    expect(out).not.toContain(": \n")
    expect(out).not.toContain(":  ")
    expect(out).toContain(tSystem("msg.unknownToolError"))
    // Baris ledger/status tool TETAP ada; humanToolLabel("bash") → "run command" (locale OS).
    expect(out).toContain("run command")
  })

  test("isError:true + sub-agent → kanonik tampil, detail mentah tak tampil", () => {
    const out = renderLinearError("[sub-agent error] turn exceeded 180000ms")
    expect(out).toContain(tSystem("msg.subagentFailed"))
    expect(out).not.toContain("turn exceeded")
  })
})
