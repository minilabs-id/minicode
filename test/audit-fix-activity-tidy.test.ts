// v0.33 — transkrip audit yang rapi: SEMUA aktivitas child disatukan menjadi
// SATU baris agregat `✦ N sub agent · M tool · K gagal`. Tidak ada baris `↳`,
// tidak perlu /expand — detail tetap ada di journal/presentation events.
import { expect, test } from "bun:test"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { setSessionLocale } from "../src/ui/i18n/locale.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  let snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  let handler: ((e: UiPresentationEvent) => void) | undefined
  const transcript = new Transcript(bus as never, {
    getSnapshot: () => snapshot,
    onPresentationEvent: (next) => {
      handler = next
      return () => {
        handler = undefined
      }
    },
  })
  return {
    transcript,
    setSnapshot(next: UiPresentationSnapshot) {
      snapshot = next
    },
    emit(e: UiPresentationEvent) {
      handler?.(e)
    },
    screen() {
      return transcript.view(120, 20, 0).join("\n")
    },
  }
}

const child = (
  id: string,
  name = "read_file",
  target = "functions/index.js",
  status: UiPresentationActivity["status"] = "completed",
): UiPresentationActivity => ({
  toolCallId: id,
  name,
  target,
  status,
  tsStart: Date.now(),
  parentToolCallId: "parent-1",
  childSessionId: "sub_0123456789abcdef0123456789abcdef",
  runId: "run_abcdef0123456789abcdef0123456789",
  label: "audit-functions",
})

test("tiga tool child identik jadi satu baris agregat, bukan tiga baris ↳", () => {
  setSessionLocale("en")
  const { setSnapshot, emit, screen } = setup()
  const kids = [child("c1"), child("c2"), child("c3")]
  setSnapshot({ activities: kids, turns: [] })
  for (const [i, k] of kids.entries()) {
    emit({
      type: "tool.completed",
      seq: i + 1,
      turnId: 1,
      toolCallId: k.toolCallId,
      status: "completed",
    })
  }
  const out = screen()
  expect(out).toContain("✦ 1 sub agent · 3 tool · 0 failed")
  expect(out).not.toContain("↳")
  expect(out.match(/✦/g)?.length).toBe(1)
})

test("target berbeda tetap satu baris agregat (tool dihitung unik)", () => {
  setSessionLocale("en")
  const { setSnapshot, emit, screen } = setup()
  const kids = [child("c1"), child("c2", "read_file", "firestore.rules")]
  setSnapshot({ activities: kids, turns: [] })
  kids.forEach((k, i) => {
    emit({
      type: "tool.completed",
      seq: i + 1,
      turnId: 1,
      toolCallId: k.toolCallId,
      status: "completed",
    })
  })
  const out = screen()
  expect(out).toContain("✦ 1 sub agent · 2 tool · 0 failed")
  expect(out).not.toContain("functions/index.js")
  expect(out).not.toContain("firestore.rules")
})

test("turn.started mengosongkan agregat — toolCallId dipakai ulang tak menumpuk", () => {
  setSessionLocale("en")
  const { setSnapshot, emit, screen } = setup()
  const k = child("reused")
  setSnapshot({ activities: [k], turns: [] })
  emit({ type: "turn.started", turnId: 1 })
  emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: k.toolCallId, status: "completed" })
  emit({ type: "turn.started", turnId: 2 })
  emit({ type: "tool.completed", seq: 2, turnId: 2, toolCallId: k.toolCallId, status: "completed" })
  const out = screen()
  // Satu baris per turn (transkrip append-only), tetapi hitungan turn kedua
  // di-reset — tidak mewarisi "2 tool" dari turn pertama.
  expect(out.match(/✦/g)?.length).toBe(2)
  expect(
    out
      .split("\n")
      .filter((l) => l.includes("✦"))
      .at(-1),
  ).toContain("✦ 1 sub agent · 1 tool · 0 failed")
})

test("sidebar aktif: chat hanya narasi, semua aktivitas pindah ke sidebar bawah", () => {
  setSessionLocale("en")
  const { transcript, setSnapshot, emit, screen } = setup()
  transcript.setSidebarActive(true)
  const parent = child("parent-1", "delegate_task", undefined, "failed")
  const kid = child("kid-1", "read_file", "jail.ts", "failed")
  setSnapshot({ activities: [parent, kid], turns: [] })
  emit({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "kid-1", status: "completed" })
  emit({
    type: "tool.failed",
    seq: 2,
    turnId: 1,
    toolCallId: "parent-1",
    status: "failed",
    message: "step limit reached (14/14)",
  })
  const chat = screen()
  // Tidak boleh ada baris per-tool (› / ✦ / ↳) di chat — cuma indeks ringkas.
  expect(chat).not.toContain("delegate_task")
  expect(chat).not.toContain("✦")
  expect(chat).not.toContain("↳")
  // v0.33: rekap kategori TAMPIL di chat sebagai indeks + jeda antar narasi.
  expect(chat).toContain("subagent")
  expect(chat).toContain("read")
  // Sidebar HANYA log detail — tak mengulang rekap kategori.
  const side = transcript.sidebarActivity(20, 40).join("\n")
  expect(side).toContain("read jail.ts")
  expect(side).toContain("agent")
})

test("kegagalan dikelompokkan per alasan di satu baris", () => {
  setSessionLocale("en")
  const { setSnapshot, emit, screen } = setup()
  const kids = [
    child("c1", "read_file", "a.ts", "failed"),
    child("c2", "read_file", "b.ts", "failed"),
  ]
  const reasons = ["turn aborted", "step timeout"]
  setSnapshot({ activities: kids, turns: [] })
  kids.forEach((k, i) => {
    emit({
      type: "tool.failed",
      seq: i + 1,
      turnId: 1,
      toolCallId: k.toolCallId,
      status: "failed",
      message: reasons[i],
    })
  })
  const out = screen()
  expect(out).toContain("✦ 1 sub agent · 2 tool · 2 failed")
  expect(out).toContain("1 abort")
  expect(out).toContain("1 timeout")
})
