// [retry-visibility] Regresi untuk dua keluhan sesi live:
//  1. Badai retry penyedia ("provider sent nothing for 60000ms …", 5–23 kali)
//     tak punya penghitung, lalu kalah dengan `turn.failed` polos.
//  2. Esc saat turn sibuk tak bisa membatalkan (di sesi yang lebih lama).
//
// Yang dijaga di sini: SATU baris status yang ditimpa (bukan satu baris per
// retry), angka berasal dari anggaran pemulihan nyata, teks jujur, dan Esc
// mengabort tanpa keluar sementara Esc saat idle tetap menghapus draft.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ProviderEvent } from "#minicore/core/provider.ts"
import {
  createMinicodeSession,
  RECOVERY_RETRY_EVENT_KIND,
  recoveryQuotaFor,
  stalledMsFromMessage,
} from "../src/app/session.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { altScreenDepth, resetAltScreenDepth } from "../src/ui/runtime/screen.ts"
import { TuiApp, type TuiHost, type TuiStatusSnapshot } from "../src/ui/tui/app.ts"
import { Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const origColor = process.env.MINICODE_COLOR

// ── 1. Telemetri di lapisan app (session.ts) ────────────────────────────────

describe("retry telemetry (session.ts)", () => {
  test("durasi stall dibaca dari pesan error nyata, bukan angka rekaan", () => {
    expect(stalledMsFromMessage("provider sent nothing for 60000ms (connection stalled)")).toBe(
      60_000,
    )
    expect(stalledMsFromMessage("PROVIDER SENT NOTHING FOR 9000ms (connection stalled)")).toBe(
      9_000,
    )
    // Bukan stall → jangan pernah menghasilkan angka detik palsu.
    expect(stalledMsFromMessage("provider request timed out after 120000ms")).toBeUndefined()
    expect(stalledMsFromMessage("TipRouter temporarily unavailable")).toBeUndefined()
    expect(stalledMsFromMessage("sent nothing for 0ms")).toBeUndefined()
    expect(stalledMsFromMessage("sent nothing for NaNms")).toBeUndefined()
  })

  test("kind event retry sesuai kontrak TUI", () => {
    expect(RECOVERY_RETRY_EVENT_KIND).toBe("minicode:retry")
  })

  test("penyebut indikator mengikuti kuota kebijakan yang benar-benar dipakai", () => {
    // server/network → anggaran bersama 6; kategori lain yang masih retry → 3.
    expect(recoveryQuotaFor("server")).toBe(6)
    expect(recoveryQuotaFor("network")).toBe(6)
    expect(recoveryQuotaFor("rate_limit")).toBe(3)
    expect(recoveryQuotaFor("unknown")).toBe(3)
  })

  test("session memancarkan retry saat provider stall lalu pulih", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retry-telemetry-"))
    try {
      let calls = 0
      const provider = {
        id: "stall-test",
        models: ["stall-test"],
        async *stream(): AsyncGenerator<ProviderEvent> {
          calls++
          if (calls === 1) {
            // Kategori "server" + pesan stall → jalur retry yang sama dengan
            // guard produksi (src/providers/guards.ts).
            throw new ProviderError(
              "server",
              "provider sent nothing for 60000ms (connection stalled)",
            )
          }
          yield { type: "text", text: "pulih" }
          yield { type: "finish", reason: "stop" }
        },
      } as never
      const session = await createMinicodeSession({
        provider,
        permissionMode: "allow-all",
        cwd: dir,
      })
      const retries: unknown[] = []
      const off = session.events.on(
        "provider:extension",
        (e: { kind?: unknown; data?: unknown }) => {
          if (e?.kind === RECOVERY_RETRY_EVENT_KIND) retries.push(e.data)
        },
      )
      try {
        const result = await session.run("halo", {})
        expect(result.finalText).toContain("pulih")
        expect(calls).toBe(2)
        expect(retries.length).toBe(1)
        expect(retries[0]).toMatchObject({
          attempt: 1,
          quota: 6,
          category: "server",
          stalledMs: 60_000,
        })
      } finally {
        off()
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ── 2. TUI: indikator retry + Esc saat busy/idle ───────────────────────────

let tty: ReturnType<typeof installFakeTty> | null = null
let lastApp: TuiApp | null = null

beforeEach(() => {
  setSessionLocale("en")
  delete process.env.MINICODE_COLOR
})

afterEach(() => {
  lastApp?.requestQuit()
  lastApp = null
  tty?.restore()
  tty = null
  resetAltScreenDepth()
  resetLocaleState()
  if (origColor == null) delete process.env.MINICODE_COLOR
  else process.env.MINICODE_COLOR = origColor
})

/**
 * Pola baris retry locale-independent: teks diambil dari `tSystem()` (bahasa
 * sistem/OS), detik live diganti `\\d+`. `n`/`total` boleh regex untuk menghitung
 * kemunculan. Tak ada literal "retry"/"coba" yang di-hardcode di test.
 */
function retryPattern(n: string, total: string, flags?: string): RegExp {
  const template = tSystem("msg.retry", { n: "@@N@@", total: "@@TOTAL@@", s: "@@SECS@@" })
  // Escape dulu template-nya, baru sisipkan `\\d+`: kalau di-escape setelah
  // disisip, backslash-nya ikut ter-escape dan tak lagi cocok.
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    escaped.replace("@@N@@", n).replace("@@TOTAL@@", total).replace("@@SECS@@", "\\d+"),
    flags,
  )
}

function setup(locale?: "en" | "id") {
  tty = installFakeTty({ columns: 72, rows: 16 })
  // installFakeTty mengunci en; setter sesi menang (lihat komentar harness).
  if (locale) setSessionLocale(locale)
  const bus = createFakeBus()
  const transcript = new Transcript(bus as never, {
    onPresentationEvent: () => () => {},
  })
  const calls: string[] = []
  let abortCalls = 0
  let gate: (() => void) | null = null
  const host: TuiHost = {
    bus: bus as never,
    getStatus: (): TuiStatusSnapshot => ({
      footer: { mode: "auto", model: "test-model", cwd: "/kerja", context: "1k" },
      busy: false,
    }),
    listCommands: () => [],
    submit: async (text) => {
      calls.push(text)
      if (text === "hold") await new Promise<void>((resolve) => (gate = resolve))
    },
    abort: () => {
      abortCalls++
    },
    copySelection: () => true,
    cycleWorkMode: () => {},
    togglePermissionMode: () => {},
    toggleCompact: () => {},
    toggleReasoning: () => {},
  }
  const app = new TuiApp(transcript, host)
  lastApp = app
  const screenText = () => tty!.screen().join("\n")
  const enterBusy = async () => {
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("hold")
    await tty!.send(KEY.enter)
    const deadline = Date.now() + 2000
    while (!calls.includes("hold")) {
      if (Date.now() > deadline) throw new Error("host tidak menerima submit 'hold'")
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  const retry = (attempt: number, stalledMs = 60_000) =>
    bus.emit("provider:extension", {
      type: "provider:extension",
      kind: RECOVERY_RETRY_EVENT_KIND,
      data: { attempt, quota: 6, category: "server", stalledMs, delayMs: 250 },
    })
  const release = async () => {
    gate?.()
    await new Promise((r) => setTimeout(r, 30))
  }
  return {
    app,
    bus,
    transcript,
    calls,
    screenText,
    enterBusy,
    retry,
    release,
    abortCalls: () => abortCalls,
  }
}

describe("indikator retry di TUI", () => {
  test("badai retry tampil sebagai SATU baris yang ditimpa, bukan satu baris per retry", async () => {
    const h = setup()
    const runP = h.app.run()
    await h.enterBusy()

    for (let attempt = 1; attempt <= 5; attempt++) h.retry(attempt)
    await new Promise((r) => setTimeout(r, 60))

    const text = h.screenText()
    // v0.33: micro-toast minimalis + detik LIVE, footer tetap ada.
    // Pesan mengikuti bahasa SISTEM (tSystem), bukan /lang sesi → pakai pola
    // yang dibangun dari kamus sistem supaya test locale-independent.
    expect(retryPattern("5", "6").test(text)).toBe(true)
    expect(text).toContain("test-model") // footer tidak ditimpa toast
    expect(text).toMatch(retryPattern("5", "6"))
    // Data lama harus hilang — ini yang membuktikan "update in place".
    expect(retryPattern("1", "6").test(text)).toBe(false)
    expect(retryPattern("4", "6").test(text)).toBe(false)
    // Satu kemunculan saja: tidak ada baris transkrip per retry.
    expect(text.match(retryPattern("\\d+", "6", "g"))?.length ?? 0).toBe(1)

    await h.release()
    expect(retryPattern("5", "6").test(h.screenText())).toBe(false)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("teks indikator memakai bahasa SISTEM, bukan sesi /lang", async () => {
    // /lang sesi sengaja dibedakan dari sistem: toast retry tetap memakai
    // kamus sistem (tSystem). Pola di bawah dibangun dari tSystem sehingga
    // benar baik sistem en maupun id.
    const h = setup("id")
    const runP = h.app.run()
    await h.enterBusy()
    h.retry(3)
    await new Promise((r) => setTimeout(r, 60))
    expect(h.screenText()).toMatch(retryPattern("3", "6"))
    await h.release()
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("event retry dengan attempt di luar kuota dibuang (fail-closed)", async () => {
    const h = setup()
    const runP = h.app.run()
    await h.enterBusy()
    h.bus.emit("provider:extension", {
      type: "provider:extension",
      kind: RECOVERY_RETRY_EVENT_KIND,
      data: { attempt: 9, quota: 6, category: "server", stalledMs: 60000, delayMs: 1 },
    })
    h.bus.emit("provider:extension", {
      type: "provider:extension",
      kind: RECOVERY_RETRY_EVENT_KIND,
      data: { attempt: Number.NaN, quota: 6, category: "server", stalledMs: 60000, delayMs: 1 },
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(retryPattern("\\d+", "6").test(h.screenText())).toBe(false)
    await h.release()
    await tty!.send(KEY.ctrlD)
    await runP
  })
})

describe("Esc saat busy vs idle", () => {
  test("Esc saat busy mengabort turn TANPA keluar dan memberi umpan balik", async () => {
    const h = setup()
    const runP = h.app.run()
    await h.enterBusy()

    // Ketik draft selagi busy (diperbolehkan kontrak) lalu Esc.
    await tty!.send("draf")
    await tty!.send(KEY.esc, 90)

    expect(h.abortCalls()).toBe(1)
    // App masih hidup: belum ada EXIT alt-screen.
    expect(tty!.all()).not.toContain("\x1b[?1049l")
    expect(h.screenText()).toContain(tSystem("msg.abortedHint"))
    expect(altScreenDepth()).toBe(1)
    expect(h.calls).toEqual(["hold"])
    expect(h.screenText()).toContain("draf") // Esc = abort, bukan editor

    await h.release()
    // Draft tetap utuh saat idle → bersihkan sebelum keluar.
    for (let i = 0; i < 4; i++) await tty!.send(KEY.backspace)
    await tty!.send(KEY.ctrlD)
    await runP
  })

  test("Esc saat idle menghapus draft tanpa mengirim abort", async () => {
    const h = setup()
    const runP = h.app.run()
    await tty!.ready()
    await tty!.waitForOutput((o) => o.includes("00.00.00"))
    await tty!.send("draf")
    expect(h.screenText()).toContain("draf")

    await tty!.send(KEY.esc, 90)

    expect(h.abortCalls()).toBe(0)
    expect(h.screenText()).not.toContain("draf")
    // Composer v0.43+ memakai bingkai kotak tipis `╭─...╰─` (tanpa label `minicode`).
    expect(h.screenText()).toContain("╭─") // prompt idle tetap ada (I13)
    expect(tty!.all()).not.toContain("\x1b[?1049l")

    await tty!.send(KEY.ctrlD) // draft sudah kosong → quit
    await runP
  })
})
