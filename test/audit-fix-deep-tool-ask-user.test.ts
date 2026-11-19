// Audit finding 7: approval ID memakai counter modul global, sehingga dua sesi
// di satu proses bisa saling menimpa approval.requested/settled. Regresi: dua
// pemanggilan menghasilkan ID unik.
import { afterEach, expect, test } from "bun:test"
import type { ApprovalHookEvent } from "../src/presentation/events.ts"
import { askUserTool, setAskApprovalHook, setAskTextFn } from "../src/tools/ask_user.ts"

afterEach(() => {
  setAskTextFn(undefined)
  setAskApprovalHook(undefined)
})

test("dua pemanggilan ask_user menghasilkan approvalId berbeda", async () => {
  setAskTextFn(undefined) // jalur no-view: tetap emit requested+settled lalu throw
  const events: ApprovalHookEvent[] = []
  setAskApprovalHook((e) => events.push(e))
  const ctx = { signal: new AbortController().signal } as never

  await expect(askUserTool.execute({ question: "a" }, ctx)).rejects.toThrow()
  await expect(askUserTool.execute({ question: "b" }, ctx)).rejects.toThrow()

  const ids = events.filter((e) => e.kind === "requested").map((e) => e.approvalId)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
  expect(ids[0]).toMatch(/^ap_/)
  // Settled memakai ID yang sama dengan requested dari pemanggilan yang sama.
  const settledIds = events.filter((e) => e.kind === "settled").map((e) => e.approvalId)
  expect(settledIds).toEqual(ids)
})
