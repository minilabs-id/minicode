import { afterEach, describe, expect, test } from "bun:test"
import { validateArgs } from "#minicore"
import { toPresentationEvent } from "../cli/bootstrap/presentation-bridge.ts"
import { createPresentationAdapter } from "../src/presentation/adapter.ts"
import type { DomainEvent } from "../src/presentation/events.ts"
import { createInitialState } from "../src/presentation/model.ts"
import { describeActivity } from "../src/presentation/projection.ts"
import { reduce } from "../src/presentation/reducer.ts"
import { allTools } from "../src/tools/index.ts"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { formatLabeledToolFailure } from "../src/ui/render/errors.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { __setSystemLocaleForTest, formatActivityLabel } from "../src/ui/render/tool-label.ts"
import { UiSessionState } from "../src/ui/session-state.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

afterEach(() => {
  __setSystemLocaleForTest(null)
  resetLocaleState()
})

describe("v0.51 live human-readable tool labels & render", () => {
  test("schema `label` hanya disuntikkan ke tool terbuka, hemat token untuk tool sederhana", () => {
    const bash = allTools.find((t) => t.name === "bash")!
    expect(
      validateArgs(bash.parameters, {
        cmd: "bun test",
        label: "Pengetesan gate sebagian",
      }).ok,
    ).toBe(true)

    const read = allTools.find((t) => t.name === "read_file")!
    expect("label" in (read.parameters.properties ?? {})).toBe(false)

    const delegate = allTools.find((t) => t.name === "delegate_task")!
    expect("name" in (delegate.parameters.properties ?? {})).toBe(true)
    expect("label" in (delegate.parameters.properties ?? {})).toBe(false)
  })

  test("auto-label deterministik 0-token merapikan path & command `cd … &&`", () => {
    __setSystemLocaleForTest("id")
    const bashAuto = formatActivityLabel("bash", {
      target: "$ cd /d D:\\Github\\minicode && grep -n foo src/ui/tui/app.ts",
    })
    expect(bashAuto.isIntent).toBe(false)
    expect(bashAuto.autoText).toContain("jalankan perintah: grep -n foo")
    expect(bashAuto.autoText).not.toContain("cd /d")

    const readAuto = formatActivityLabel("read_file", {
      target: "src/ui/very/deep/nested/folder/component_turn_state.ts",
    })
    expect(readAuto.autoText).toBe("baca berkas component_turn_state.ts")
  })

  test("label mengalir dari adapter -> reducer -> describeActivity -> presentation-bridge", () => {
    const bus = createFakeBus()
    const published: DomainEvent[] = []
    const adapter = createPresentationAdapter(bus as never, { sessionId: "sess-1" })
    adapter.onEvent((e) => published.push(e))

    bus.emit("turn:started", { turn: 1 })
    bus.emit("execution:started", {
      execution: {
        call: {
          id: "call-1",
          name: "bash",
          args: { cmd: "bun test", label: "Pengetesan gate sebagian" },
        },
      },
    })

    const started = published.find((e) => e.type === "tool.started")
    expect(started).toBeDefined()
    expect(started?.type === "tool.started" ? started.argsSummary.intent : undefined).toBe(
      "Pengetesan gate sebagian",
    )

    const state = reduce(createInitialState("sess-1"), started!)
    const entry = [...state.activities.values()][0]!
    expect(entry.intent).toBe("Pengetesan gate sebagian")
    expect(describeActivity(entry).intent).toBe("Pengetesan gate sebagian")

    const uiEvent = toPresentationEvent(started!)
    expect(uiEvent?.intent).toBe("Pengetesan gate sebagian")
  })

  test("jeda anti-kedip 120ms + reveal per kata lalu hilang saat tool selesai", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("id")
    let nowMs = 1_000
    const bus = createFakeBus()
    let emit: ((event: UiPresentationEvent) => void) | undefined
    let activities: UiPresentationActivity[] = [
      {
        toolCallId: "c1",
        name: "bash",
        target: "$ bun test",
        intent: "Pengetesan gate sebagian",
        status: "running",
        tsStart: nowMs,
      },
    ]
    const t = new Transcript(bus as never, {
      getSnapshot: (): UiPresentationSnapshot => ({ activities, turns: [] }),
      animateLive: true,
      now: () => nowMs,
      uiState: new UiSessionState({ activityPanel: true }),
      onPresentationEvent: (fn) => {
        emit = fn
        return () => {}
      },
    })

    emit?.({
      type: "tool.started",
      turnId: 1,
      toolCallId: "c1",
      intent: "Pengetesan gate sebagian",
    })
    // Sebelum 60ms dwell: baris belum muncul (hindari kedipan tool kilat), animasi menunggu.
    const duringDwell = t.view(80, 12, 0).filter((r) => r.trim() !== "")
    expect(duringDwell).toHaveLength(0)
    expect(t.hasLiveAnimation()).toBe(true)

    // Melewati 60ms dwell: kata pertama tampil ("Pengetesan")
    nowMs += 65
    const word1 = stripAnsi(t.view(80, 12, 0)[0] ?? "")
    expect(word1).toContain("Pengetesan")
    expect(word1).not.toContain("sebagian")
    expect(t.hasLiveAnimation()).toBe(true)

    // +60ms: kata kedua ikut tampil ("Pengetesan gate")
    nowMs += 60
    const word2 = stripAnsi(t.view(80, 12, 0)[0] ?? "")
    expect(word2).toContain("Pengetesan gate")
    expect(word2).not.toContain("sebagian")

    // +100ms: seluruh kata tampil lengkap + status berjalan, ticker kembali normal
    nowMs += 100
    const wordDone = stripAnsi(t.view(80, 12, 0)[0] ?? "")
    expect(t.hasLiveAnimation()).toBe(false)
    expect(wordDone).toContain("Pengetesan gate sebagian")

    // Selesai normal -> baris live hilang
    activities = [{ ...activities[0]!, status: "completed" }]
    emit?.({ type: "tool.completed", seq: 1, turnId: 1, toolCallId: "c1", status: "completed" })
    expect(t.view(80, 12, 0).filter((r) => r.trim() !== "")).toHaveLength(0)
  })

  test("semua kegagalan tool memakai format seragam tanpa duplikasi command mentah", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("id")

    expect(
      formatLabeledToolFailure(
        "Sub agent pencari bug",
        "[sub-agent explore error] context window exceeded after recovery compaction",
      ),
    ).toBe("Sub agent pencari bug mengalami kegagalan (context penuh)")

    const bus = createFakeBus()
    let emit: ((event: UiPresentationEvent) => void) | undefined
    const activities: UiPresentationActivity[] = [
      {
        toolCallId: "c-fail-label",
        name: "bash",
        target: "$ cd /d D:\\Github\\minicode && grep -n foo bar",
        intent: "Mencari referensi error",
        status: "failed",
        tsStart: 10,
      },
      {
        toolCallId: "c-fail-auto",
        name: "bash",
        target: "$ cd /d D:\\Github\\minicode && grep -n baz qux",
        status: "failed",
        tsStart: 20,
      },
    ]
    const t = new Transcript(bus as never, {
      getSnapshot: () => ({ activities, turns: [] }),
      uiState: new UiSessionState({ activityPanel: true }),
      onPresentationEvent: (fn) => {
        emit = fn
        return () => {}
      },
    })

    emit?.({ type: "tool.started", turnId: 1, toolCallId: "c-fail-label" })
    emit?.({
      type: "tool.failed",
      seq: 1,
      turnId: 1,
      toolCallId: "c-fail-label",
      status: "failed",
      message: "exit 2",
    })
    emit?.({ type: "tool.started", turnId: 1, toolCallId: "c-fail-auto" })
    emit?.({
      type: "tool.failed",
      seq: 2,
      turnId: 1,
      toolCallId: "c-fail-auto",
      status: "failed",
      message: "exit 2",
    })

    const out = stripAnsi(t.view(120, 12, 0).join("\n"))
    expect(out).toContain("Mencari referensi error mengalami kegagalan (keluar 2)")
    expect(out).toContain("jalankan perintah: grep -n baz qux mengalami kegagalan (keluar 2)")
    expect(out).not.toContain("cd /d")
  })

  test("gangguan provider berat (>=3 retry), turn.cancelled (budget), & compaction llm-failed tercatat ringkas", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("id")
    const bus = createFakeBus()
    const t = new Transcript(bus as never, {
      uiState: new UiSessionState({ activityPanel: true }),
    })

    bus.emit("turn:started", { turn: 1 })
    bus.emit("provider:extension", {
      kind: "minicode:retry",
      data: { attempt: 1, category: "rate_limit" },
    })
    bus.emit("provider:extension", {
      kind: "minicode:retry",
      data: { attempt: 2, category: "rate_limit" },
    })
    bus.emit("provider:extension", {
      kind: "minicode:retry",
      data: { attempt: 3, category: "rate_limit" },
    })
    bus.emit("turn:completed", {})

    const liveOut = stripAnsi(t.view(120, 12, 0).join("\n"))
    expect(liveOut).toContain("gangguan penyedia (terkena batas laju, dicoba ulang 3×)")

    const tReplay = new Transcript(createFakeBus() as never, {
      uiState: new UiSessionState({ activityPanel: true }),
    })
    tReplay.replayHistory([
      {
        type: "context.compacted",
        seq: 1,
        turnId: 1,
        compactionReason: "llm-failed:llm compaction timeout",
      },
      {
        type: "turn.cancelled",
        seq: 2,
        turnId: 1,
        reason: "budget",
      },
    ])
    const replayOut = stripAnsi(tReplay.view(120, 12, 0).join("\n"))
    expect(replayOut).toContain("ringkasan LLM gagal")
    expect(replayOut).toContain("batas anggaran tercapai")
  })

  test("baris fase tunggu transien tampil saat turn aktif menunggu >1.5s & hilang saat teks/tool masuk", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("id")
    let nowMs = 10_000
    let emit: ((event: UiPresentationEvent) => void) | undefined
    const bus = createFakeBus()
    const t = new Transcript(bus as never, {
      now: () => nowMs,
      uiState: new UiSessionState({ activityPanel: true }),
      onPresentationEvent: (fn) => {
        emit = fn
        return () => {}
      },
    })

    emit?.({ type: "turn.started", seq: 1, turnId: 1 })
    emit?.({ type: "step.started", seq: 2, turnId: 1, step: 2 })
    // Awal turn (<1500ms): belum ada baris tunggu
    expect(t.view(80, 10, 0).filter((r) => r.trim() !== "")).toHaveLength(0)

    // Melewati 1500ms tanpa narasi/tool: 1 baris tunggu langkah tampil
    nowMs += 1_600
    const waitingOut = stripAnsi(t.view(80, 10, 0).join("\n"))
    expect(waitingOut).toContain("Menyiapkan langkah 3")

    // Saat retry terjadi: langsung ganti ke pesan tunggu retry
    bus.emit("provider:extension", {
      kind: "minicode:retry",
      data: { attempt: 2, quota: 10, category: "rate_limit" },
    })
    const retryWaitOut = stripAnsi(t.view(80, 10, 0).join("\n"))
    expect(retryWaitOut).toContain("Menunggu penyedia merespons (coba 2/10")

    // Begitu teks streaming masuk: baris tunggu otomatis lenyap
    bus.emit("provider:text", { text: "Hasil analisis:" })
    const afterText = stripAnsi(t.view(80, 10, 0).join("\n"))
    expect(afterText).toContain("Hasil analisis:")
    expect(afterText).not.toContain("Menunggu penyedia")
    expect(afterText).not.toContain("Menyiapkan langkah")
  })

  test("prioritas sub-agent paralel: semua root delegate_task tetap tampil saat child banyak", () => {
    __setSystemLocaleForTest("id")
    const activities: UiPresentationActivity[] = [
      {
        toolCallId: "root-1",
        name: "delegate_task",
        intent: "Subagent audit footer",
        status: "running",
        tsStart: 1,
      },
      {
        toolCallId: "c-1a",
        parentToolCallId: "root-1",
        childSessionId: "sub_1",
        label: "audit-1",
        name: "read_file",
        target: "a.ts",
        status: "running",
        tsStart: 2,
      },
      {
        toolCallId: "c-1b",
        parentToolCallId: "root-1",
        childSessionId: "sub_1",
        label: "audit-1",
        name: "grep",
        target: "b.ts",
        status: "running",
        tsStart: 3,
      },
      {
        toolCallId: "root-2",
        name: "delegate_task",
        intent: "Subagent audit transcript",
        status: "running",
        tsStart: 4,
      },
      {
        toolCallId: "c-2a",
        parentToolCallId: "root-2",
        childSessionId: "sub_2",
        label: "audit-2",
        name: "read_file",
        target: "c.ts",
        status: "running",
        tsStart: 5,
      },
      {
        toolCallId: "c-2b",
        parentToolCallId: "root-2",
        childSessionId: "sub_2",
        label: "audit-2",
        name: "grep",
        target: "d.ts",
        status: "running",
        tsStart: 6,
      },
    ]
    const t = new Transcript(createFakeBus() as never, {
      getSnapshot: () => ({ activities, turns: [] }),
    })
    // viewH=8 -> kap adaptif = max(3, floor(8*0.5)) = 4 baris dari 6 item
    const view = stripAnsi(t.view(80, 8, 0).join("\n"))
    expect(view).toContain("audit footer")
    expect(view).toContain("audit transcript")
    expect(view).not.toContain("Subagent audit")
    expect(t.runningExtraCount(8)).toBe(2)
  })
})
