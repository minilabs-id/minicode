import { afterEach, describe, expect, test } from "bun:test"
import {
  describeActivity,
  elapsedVisible,
  matchTurnBySummary,
  provenanceMark,
  verificationMark,
} from "../src/presentation/projection.ts"
import { attachSimpleLogger } from "../src/ui/assistant/simple.ts"
import type {
  UiPresentationActivity,
  UiPresentationEvent,
  UiPresentationSnapshot,
} from "../src/ui/contract.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { humanToolLabel } from "../src/ui/render/tool-label.ts"
import { TRANSCRIPT_CAP, Transcript, type TranscriptMeta } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  let snapshot: UiPresentationSnapshot = { activities: [], turns: [] }
  let handler: ((event: UiPresentationEvent) => void) | undefined
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
    bus,
    transcript,
    setSnapshot(next: UiPresentationSnapshot) {
      snapshot = next
    },
    emitPresentation(event: UiPresentationEvent) {
      handler?.(event)
    },
  }
}

function activity(overrides: Partial<UiPresentationActivity> = {}): UiPresentationActivity {
  return {
    toolCallId: "call-1",
    name: "read_file",
    target: "a.ts",
    status: "running",
    tsStart: Date.now(),
    ...overrides,
  }
}

afterEach(() => {
  resetLocaleState()
})

describe("P5 transcript projection", () => {
  test("running row tampil dari snapshot dengan elapsed setelah dua detik", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot } = setup()
    setSnapshot({ activities: [activity({ tsStart: Date.now() - 3000 })], turns: [] })
    const out = transcript.view(100, 4, 0).join("\n")
    expect(out).toContain("› read_file a.ts … running (3s)")
  })

  test("event turn dan approval tidak membuat phantom activity", () => {
    const { transcript, emitPresentation } = setup()
    emitPresentation({ type: "turn.started", turnId: 1 })
    emitPresentation({ type: "approval.requested", approvalId: "a-1" })
    expect(transcript.size()).toBe(0)
  })

  test("terminal event duplikat tidak menggandakan baris", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "completed" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({ type: "tool.completed", toolCallId: entry.toolCallId, status: "completed" })
    emitPresentation({ type: "tool.completed", toolCallId: entry.toolCallId, status: "completed" })
    expect(
      transcript.view(100, 4, 0).filter((line) => line.includes(humanToolLabel("read_file"))),
    ).toHaveLength(1)
  })

  test("terminal status memakai glyph dan kata yang berbeda", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "denied" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({
      type: "tool.denied",
      seq: 4,
      turnId: 1,
      toolCallId: entry.toolCallId,
      status: "denied",
    })
    const out = transcript.view(100, 4, 0).join("\n")
    // Status non-sukses dipisah `·` dari target; sukses tidak mencetak kata
    // status sama sekali (lihat test berikutnya).
    expect(out).toContain(`${humanToolLabel("read_file")} a.ts · denied`)
  })

  test("retry dan grup anak tetap satu baris ledger induk", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-1",
      name: "delegate_task",
      target: undefined,
      status: "completed",
      supersedes: "old-1",
    })
    const child = activity({
      toolCallId: "child-1",
      name: "read_file",
      parentToolCallId: parent.toolCallId,
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({
      type: "tool.completed",
      seq: 8,
      turnId: 1,
      toolCallId: parent.toolCallId,
      status: "completed",
    })
    emitPresentation({
      type: "tool.completed",
      seq: 9,
      turnId: 1,
      toolCallId: child.toolCallId,
      status: "completed",
    })
    const out = transcript.view(100, 4, 0).join("\n")
    expect(out).toContain(`${humanToolLabel("delegate_task")} ↻ retry 1 child tools`)
    expect(out).not.toContain("read_file a.ts")
  })

  // F-AGENT-1: identitas run anak (childSessionId/runId) datang dari
  // ChildSessionLink → ActivityEntry → snapshot. Bila ADA, tool anak dirender
  // sebagai baris run sendiri; kini label manusiawi MENANG atas marker
  // code-derived `run_<8>`/`sub_<8>` (sub-agent audit-fix). Bila hanya
  // `parentToolCallId` (grouping legacy), tetap ditelan hitungan induk (test di
  // atas). Dua makna ini tidak boleh dicampur.
  test("F-AGENT-1: tool anak ber-label dirender per-run dengan nama manusiawi", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-1",
      name: "delegate_task",
      target: undefined,
      status: "completed",
    })
    const child = activity({
      toolCallId: "child-1",
      name: "read_file",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_0123456789abcdef0123456789abcdef",
      runId: "run_abcdef0123456789abcdef0123456789",
      label: "explore-auth",
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({
      type: "tool.completed",
      seq: 8,
      turnId: 1,
      toolCallId: parent.toolCallId,
      status: "completed",
    })
    emitPresentation({
      type: "tool.completed",
      seq: 9,
      turnId: 1,
      toolCallId: child.toolCallId,
      status: "completed",
    })
    const out = transcript.view(120, 20, 0).join("\n")
    // v0.33: semua aktivitas child disatukan jadi SATU baris agregat.
    expect(out).toContain("✦ 1 sub agent · 1 tool · 0 failed")
    expect(out).not.toContain("↳")
    expect(out).not.toContain("run_abcdef01")
    expect(out).not.toContain("explore-auth")
  })

  // Self-title: judul baru menimpa label di snapshot LIVE. Tiga anak paralel
  // tetap terbedakan — hanya anak yang dituju yang berubah markernya.
  test("activity.label: judul baru tampil di baris anak, anak lain tak berubah", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-l",
      name: "delegate_task",
      target: undefined,
      status: "running",
      tsStart: Date.now(),
    })
    const target = activity({
      toolCallId: "child-l",
      name: "read_file",
      target: "config.ts",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_1",
      label: "explore-1",
      status: "running",
      tsStart: Date.now(),
    })
    const other = activity({
      toolCallId: "child-m",
      name: "grep",
      target: "auth.ts",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_2",
      label: "explore-2",
      status: "running",
      tsStart: Date.now(),
    })
    setSnapshot({ activities: [parent, target, other], turns: [] })
    const before = transcript.size()
    // Eventnya sengaja NO-OP di transkrip: label di-read dari snapshot, bukan
    // dari event. Menambah baris di sini akan menduplikasi childLedger.
    emitPresentation({
      type: "activity.label",
      seq: 5,
      turnId: 1,
      toolCallId: "dt_1",
      label: "audit·allowlist",
    })
    expect(transcript.size()).toBe(before)
    // Simulasikan reducer yang menimpa label activity target di snapshot.
    setSnapshot({
      activities: [parent, { ...target, label: "audit·allowlist" }, other],
      turns: [],
    })
    const out = transcript.view(120, 20, 0).join("\n")
    expect(out).toContain("↳ audit·allowlist read_file config.ts")
    expect(out).not.toContain("↳ explore-1")
    expect(out).toContain("↳ explore-2 grep auth.ts")
  })

  // FALLBACK sengaja dipertahankan: event lama / jalur tanpa label tak boleh
  // menampilkan baris kosong — marker code-derived tetap jadi cadangan.
  test("F-AGENT-1: tanpa label dan runId, marker jatuh ke childSessionId sub_<8>", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const parent = activity({
      toolCallId: "parent-2",
      name: "delegate_task",
      target: undefined,
      status: "completed",
    })
    const child = activity({
      toolCallId: "child-2",
      name: "grep",
      parentToolCallId: parent.toolCallId,
      childSessionId: "sub_fedcba9876543210fedcba9876543210",
      status: "completed",
    })
    setSnapshot({ activities: [parent, child], turns: [] })
    emitPresentation({ type: "tool.completed", seq: 3, turnId: 1, toolCallId: child.toolCallId })
    const out = transcript.view(120, 20, 0).join("\n")
    // Identitas run tidak dibocorkan ke layar — cukup hitungan agregat.
    expect(out).toContain("✦ 1 sub agent · 1 tool · 0 failed")
    expect(out).not.toContain("sub_fedcba98")
  })

  test("F-AGENT-1: tiga anak paralel = tiga baris run terpisah, bukan hitungan", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot } = setup()
    const parent = activity({
      toolCallId: "parent-3",
      name: "delegate_task",
      target: undefined,
      status: "running",
      tsStart: Date.now(),
    })
    const kids = (["a", "b", "c"] as const).map((ch, i) =>
      activity({
        toolCallId: `child-${ch}`,
        name: "read_file",
        target: `${ch}.ts`,
        parentToolCallId: parent.toolCallId,
        childSessionId: `sub_${ch.repeat(8)}${i}`,
        runId: `run_${ch.repeat(8)}${i}`,
        // Label unik per anak → 5/3 fan-out tetap bisa dibedakan di layar.
        label: `explore-${ch}`,
        status: "running",
        tsStart: Date.now(),
      }),
    )
    setSnapshot({ activities: [parent, ...kids], turns: [] })
    const out = transcript.view(120, 30, 0).join("\n")
    // Tiap run punya baris sendiri keyed label-nya — bukan "n child tools".
    for (const ch of ["a", "b", "c"] as const) {
      expect(out).toContain(`↳ explore-${ch} read_file ${ch}.ts … running`)
      expect(out).not.toContain(`run_${ch.repeat(8)}`)
    }
    expect(out).not.toContain("child tools")
  })

  test("label dari model (tak-terpercaya) disanitasi sebelum jadi marker", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const child = activity({
      toolCallId: "child-ansi",
      name: "read_file",
      parentToolCallId: "parent-ansi",
      childSessionId: "sub_0123456789abcdef0123456789abcdef",
      // SGR boleh lewat (warna), tapi CSI non-SGR + newline + bidi HARUS dibuang.
      label: "explore\x1b[2J\x1b[1;31m-auth\x1b[0m\nevil\u202E",
      status: "completed",
    })
    setSnapshot({ activities: [child], turns: [] })
    emitPresentation({ type: "tool.completed", seq: 2, turnId: 1, toolCallId: child.toolCallId })
    const out = transcript.view(120, 10, 0).join("\n")
    // Label tak lagi dirender (agregat), jadi CSI non-SGR & bidi tak boleh bocor.
    expect(out).toContain("✦ 1 sub agent · 1 tool · 0 failed")
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\u202E")
    expect(out).not.toContain("evil")
  })

  test("turn summary tidak dirender di renderer flat (ckpt/ringkasan hilang)", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const summary = {
      toolsOk: 5,
      toolsFailed: 1,
      toolsDenied: 1,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 2,
      checkpointId: "t7",
      durationMs: 41000,
    }
    setSnapshot({ activities: [], turns: [{ turnId: 7, status: "completed", summary }] })
    emitPresentation({ type: "turn.completed", seq: 20, turnId: 7, summary })
    const out = transcript.view(120, 4, 0).join("\n")
    // Renderer flat: ringkasan turn (`turn N · ok/failed · files · ckpt`) sengaja
    // dibuang; event tetap dikonsumsi, tapi tak ada baris transkrip.
    expect(out).not.toContain("turn 7")
    expect(out).not.toContain("5 ok")
    expect(out).not.toContain("ckpt t7")
    expect(out).not.toContain("41s")
    // Positif: tidak ada phantom row dari event turn.completed.
    expect(transcript.size()).toBe(0)
  })

  test("evict cap memakai marker dan total tetap monotonik", () => {
    setSessionLocale("en")
    const { transcript } = setup()
    transcript.pushInfo(Array.from({ length: TRANSCRIPT_CAP + 10 }, (_, i) => `line-${i}`))
    expect(transcript.size()).toBe(TRANSCRIPT_CAP + 1)
    expect(transcript.total()).toBe(TRANSCRIPT_CAP + 10)
    // v7.28: anchor ATAS — scrollBack=0 = kepala. Baris lama dibuang dari
    // kepala dan diganti marker evict, jadi marker dibaca dari kepala (dulu
    // dibaca dari ekor lewat scrollBack=TRANSCRIPT_CAP saat anchor di bawah).
    expect(transcript.view(100, 1, 0)[0]).toContain("10 early lines")
    // Ekor (scrollBack besar) tetap baris terbaru, bukan marker.
    expect(transcript.view(100, 1, TRANSCRIPT_CAP)[0]).toContain(`line-${TRANSCRIPT_CAP + 9}`)
    // total() monotonik: append lagi menaikkan total walau cap sudah penuh.
    transcript.pushInfo(["line-baru"])
    expect(transcript.size()).toBe(TRANSCRIPT_CAP + 1)
    expect(transcript.total()).toBe(TRANSCRIPT_CAP + 11)
  })

  test("snapshot exception does not damage viewport", () => {
    const bus = createFakeBus()
    const transcript = new Transcript(bus as never, {
      getSnapshot: () => {
        throw new Error("broken")
      },
    })
    transcript.pushInfo(["safe"])
    expect(transcript.view(40, 2, 0).join("\n")).toContain("safe")
  })

  test("policy bag vs inline legacy: view identik (parity TUI)", () => {
    setSessionLocale("en")
    const summary = {
      toolsOk: 2,
      toolsFailed: 1,
      toolsDenied: 0,
      toolsCancelled: 0,
      toolsInterrupted: 0,
      filesChanged: 1,
      checkpointId: "cp1",
      durationMs: 41000,
    }
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({
          toolCallId: "p1",
          name: "delegate_task",
          target: undefined,
          status: "completed",
          supersedes: "old-1",
        }),
        activity({ toolCallId: "c1", name: "read_file", status: "failed", parentToolCallId: "p1" }),
      ],
      turns: [{ turnId: 3, status: "completed", summary }],
    }
    const events: UiPresentationEvent[] = [
      { type: "tool.completed", seq: 8, turnId: 3, toolCallId: "p1", status: "completed" },
      {
        type: "tool.failed",
        seq: 9,
        turnId: 3,
        toolCallId: "c1",
        status: "failed",
        message: "boom",
      },
      { type: "turn.completed", seq: 20, turnId: 3, summary },
    ]
    const views: string[][] = []
    for (const policy of [
      undefined,
      {
        describeActivity,
        matchTurn: matchTurnBySummary,
        elapsedVisible,
        verificationMark,
        provenanceMark,
      },
    ]) {
      const bus = createFakeBus()
      const transcript = new Transcript(bus as never, {
        getSnapshot: () => snapshot,
        policy,
      })
      const handler = (
        transcript as unknown as {
          presentationEvent: (e: UiPresentationEvent) => void
        }
      ).presentationEvent.bind(transcript)
      for (const event of events) handler(event)
      views.push(transcript.view(120, 20, 0))
    }
    expect(views[1]).toEqual(views[0])
    expect(views[0]!.join("\n")).toContain(
      `› ${humanToolLabel("delegate_task")} ↻ retry 1 child tools`,
    )
  })

  test("marker verifikasi/provenans identik lewat policy vs fallback (B1)", () => {
    setSessionLocale("en")
    const snapshot: UiPresentationSnapshot = {
      activities: [
        activity({
          toolCallId: "v1",
          name: "write_file",
          target: "b.ts",
          status: "completed",
          verification: { invocationId: "i1", verdict: "present", method: "m", observedAt: 1 },
          provenance: "replay",
        }),
        activity({
          toolCallId: "v2",
          name: "read_file",
          target: "c.ts",
          status: "completed",
          verification: { invocationId: "i2", verdict: "absent", method: "m", observedAt: 1 },
          provenance: "reconstructed",
        }),
      ],
      turns: [],
    }
    const events: UiPresentationEvent[] = [
      { type: "tool.completed", seq: 1, turnId: 1, toolCallId: "v1", status: "completed" },
      { type: "tool.completed", seq: 2, turnId: 1, toolCallId: "v2", status: "completed" },
    ]
    const views: string[][] = []
    for (const policy of [
      undefined,
      {
        describeActivity,
        matchTurn: matchTurnBySummary,
        elapsedVisible,
        verificationMark,
        provenanceMark,
      },
    ]) {
      const bus = createFakeBus()
      const transcript = new Transcript(bus as never, {
        getSnapshot: () => snapshot,
        policy,
      })
      const handler = (
        transcript as unknown as {
          presentationEvent: (e: UiPresentationEvent) => void
        }
      ).presentationEvent.bind(transcript)
      for (const event of events) handler(event)
      views.push(transcript.view(120, 20, 0))
    }
    // Policy dan fallback legacy harus byte-identik (dedup tanpa drift).
    expect(views[1]).toEqual(views[0])
    const joined = views[0]!.join("\n")
    expect(joined).toContain("[verified] [replay]")
    expect(joined).toContain("[unverified:absent] [reconstructed]")
  })

  test("projection metadata tetap terikat pada baris ledger", () => {
    setSessionLocale("en")
    const { transcript, setSnapshot, emitPresentation } = setup()
    const entry = activity({ status: "completed" })
    setSnapshot({ activities: [entry], turns: [] })
    emitPresentation({ type: "tool.completed", seq: 12, turnId: 3, toolCallId: entry.toolCallId })
    const meta = (transcript as unknown as { meta: TranscriptMeta[] }).meta
    expect(meta[0]).toMatchObject({ kind: "activity", seq: 12, turnId: 3, toolCallId: "call-1" })
  })
})

// F-TASK-1: event task.status tetap dikonsumsi, tapi renderer flat tidak
// lagi menampilkan baris ledger diagnostiknya (id/status/parent/deps/revisi).
describe("F-TASK-1: status task tidak dirender di renderer flat", () => {
  test("task.status tidak memunculkan baris `t1 completed parent=… dependsOn=[…] r2`", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({
      type: "task.status",
      seq: 7,
      turnId: 1,
      taskId: "t1",
      taskStatus: "COMPLETED",
      parentId: "t0",
      dependsOn: ["t0", "t2"],
      revision: 2,
    })
    const out = transcript.view(120, 10, 0).join("\n")
    // Diagnostik task kini derau di transkrip: event return lebih awal tanpa
    // append, jadi semua field lama harus absen.
    expect(out).not.toContain("t1 completed")
    expect(out).not.toContain("parent=t0")
    expect(out).not.toContain("dependsOn=[t0,t2]")
    expect(out).not.toContain("r2")
    expect(transcript.size()).toBe(0)
  })

  test("task.status tanpa parent/deps juga tidak dirender", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({
      type: "task.status",
      seq: 8,
      turnId: 1,
      taskId: "t9",
      taskStatus: "BLOCKED",
    })
    const out = transcript.view(120, 10, 0).join("\n")
    expect(out).not.toContain("t9 blocked")
    expect(out).not.toContain("t9")
    expect(out).not.toContain("dependsOn=")
    expect(transcript.size()).toBe(0)
  })
})

// F-AGENT-1 di renderer LINEAR (non-TTY): kegagalan tool anak paralel harus
// bisa dibedakan per run — marker `run_<8>` ikut di baris scrollback.
describe("F-AGENT-1: renderer linear (non-TTY) marker run", () => {
  test("tool anak gagal → baris `↳ <label>` keyed label manusiawi", () => {
    setSessionLocale("en")
    const tty = installFakeTty({ columns: 80, rows: 24 })
    try {
      const bus = createFakeBus()
      const child = activity({
        toolCallId: "child-1",
        name: "bash",
        target: "ls",
        parentToolCallId: "parent-1",
        childSessionId: "sub_0123456789abcdef0123456789abcdef",
        runId: "run_abcdef0123456789abcdef0123456789",
        label: "plan-build",
        status: "failed",
      })
      let handler: ((event: UiPresentationEvent) => void) | undefined
      const detach = attachSimpleLogger(bus as never, {
        getSnapshot: () => ({ activities: [child], turns: [] }),
        onPresentationEvent: (h) => {
          handler = h
          return () => {
            handler = undefined
          }
        },
      })
      handler?.({
        type: "tool.failed",
        seq: 5,
        turnId: 1,
        toolCallId: "child-1",
        status: "failed",
        message: "boom",
      })
      detach()
      const raw = tty.allErr()
      expect(raw).toContain("↳ plan-build bash ls")
      expect(raw).not.toContain("run_abcdef01")
      expect(raw).toContain("boom")
    } finally {
      tty.restore()
    }
  })
})

describe("I26: proyeksi presentasi menghormati locale id", () => {
  test("status running/denied & thinking memakai kamus Indonesia saat locale id aktif", () => {
    setSessionLocale("id")
    const { transcript, setSnapshot, emitPresentation } = setup()
    setSnapshot({
      activities: [
        activity({ toolCallId: "c1", status: "running", tsStart: Date.now() - 3000 }),
        activity({ toolCallId: "c2", name: "write_file", target: "b.ts", status: "denied" }),
      ],
      turns: [],
    })
    emitPresentation({
      type: "tool.denied",
      seq: 2,
      turnId: 1,
      toolCallId: "c2",
      status: "denied",
    })
    const view = transcript.view(120, 10, 0).join("\n")
    expect(view).toContain("read_file a.ts … berjalan (3s)")
    expect(view).toContain(`${humanToolLabel("write_file")} b.ts · ditolak`)
  })

  test("attachSimpleLogger memakai status Indonesia saat locale id aktif", () => {
    const tty = installFakeTty({ columns: 100, rows: 24, isTTY: false })
    setSessionLocale("id")
    try {
      const bus = createFakeBus()
      let handler: ((event: UiPresentationEvent) => void) | undefined
      const detach = attachSimpleLogger(bus as never, {
        getSnapshot: () => ({
          activities: [activity({ name: "write_file", target: "x.ts", status: "denied" })],
          turns: [],
        }),
        onPresentationEvent: (h) => {
          handler = h
          return () => {
            handler = undefined
          }
        },
      })
      handler?.({
        type: "tool.denied",
        seq: 1,
        turnId: 1,
        toolCallId: "call-1",
        status: "denied",
      })
      detach()
      expect(tty.allErr()).toContain("write_file x.ts [ditolak]")
    } finally {
      tty.restore()
    }
  })
})

describe("live progress — label datar tanpa baris transkrip", () => {
  test("step.started menghasilkan satu label progres, bukan baris ledger", () => {
    setSessionLocale("id")
    const { transcript, emitPresentation } = setup()
    expect(transcript.size()).toBe(0)
    emitPresentation({ type: "step.started", seq: 1, turnId: 1, step: 1, total: 5 })
    expect(transcript.progressLabelText()).toBe("langkah 2/5")
    // Renderer flat: tak ada baris/grup/kotak baru di transkrip.
    expect(transcript.size()).toBe(0)
    expect(transcript.view(80, 4, 0).join("\n")).not.toContain("langkah 2/5")
  })

  test("step.started tanpa total jujur: langkah N, bukan N/?", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({ type: "step.started", seq: 1, turnId: 1, step: 0 })
    expect(transcript.progressLabelText()).toBe("step 1")
  })

  test("plan.updated (todo_write) menghasilkan SATU baris datar todos d/t", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    expect(transcript.size()).toBe(0)
    emitPresentation({
      type: "plan.updated",
      seq: 2,
      turnId: 1,
      planId: "p1",
      status: "running",
      steps: [
        { stepId: "1", title: "Inspect", status: "completed" },
        { stepId: "2", title: "\x1b[31mShip it\x1b[0m", status: "active" },
        { stepId: "3", title: "Verify", status: "pending" },
      ],
    })
    const label = transcript.planLabelText()
    // Satu baris, punya angka d/t, judul active tersanitasi (tanpa SGR).
    expect(label).toContain("todos 1/3")
    expect(label).toContain("Ship it")
    expect(label).not.toContain("\x1b[")
    expect(transcript.size()).toBe(0)
  })

  test("progres dibersihkan saat turn selesai", () => {
    setSessionLocale("en")
    const { transcript, emitPresentation } = setup()
    emitPresentation({ type: "step.started", seq: 1, turnId: 1, step: 2, total: 4 })
    emitPresentation({
      type: "plan.updated",
      seq: 2,
      turnId: 1,
      planId: "p1",
      status: "running",
      steps: [{ stepId: "1", title: "x", status: "active" }],
    })
    expect(transcript.progressLabelText()).not.toBe("")
    expect(transcript.planLabelText()).not.toBe("")
    emitPresentation({ type: "turn.completed", seq: 3, turnId: 1 })
    expect(transcript.progressLabelText()).toBe("")
    expect(transcript.planLabelText()).toBe("")
  })
})
