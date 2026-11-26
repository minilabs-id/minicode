// Test wizard setup — jalur yang paling menentukan kesan pertama dan sebelumnya
// 0% tercakup (nol test, hanya bisa diuji manual).

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSetupWizard } from "../cli/wizard.ts"
import { GATEWAY_PRESETS } from "../src/providers/presets.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { runSetupWizardView } from "../src/ui/screens/wizard.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: FakeTty | undefined
let home: string | undefined
const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE

afterEach(() => {
  tty?.restore()
  tty = undefined
  if (origHome == null) delete process.env.HOME
  else process.env.HOME = origHome
  if (origUserProfile == null) delete process.env.USERPROFILE
  else process.env.USERPROFILE = origUserProfile
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {}
    home = undefined
  }
})

/** HOME sementara supaya wizard tidak menulis ke config asli mesin. */
function isolateHome() {
  home = mkdtempSync(join(tmpdir(), "minicode-wizard-"))
  process.env.HOME = home
  process.env.USERPROFILE = home
}

const visible = (t: FakeTty) => stripAnsi(t.all())

describe("wizard: non-TTY", () => {
  test("mengembalikan false tanpa menulis apa pun", async () => {
    tty = installFakeTty({ isTTY: false })
    isolateHome()
    expect(await runSetupWizard()).toBe(false)
  })
})

describe("wizard: input langsung Base URL + API key", () => {
  test("langsung menampilkan form Base URL [1/2] tanpa picker gateway", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    const out = visible(tty)
    // Langsung form Base URL [1/2]; picker preset OpenAI/gateway tidak ada.
    expect(out).toContain("Minicode setup [1/2]")
    expect(out).toContain("Base URL")
    expect(out).not.toContain("Select gateway")
    expect(out).not.toContain("OpenAI (gpt")
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
  })

  test("Esc pada form Base URL membatalkan setup dengan pesan", async () => {
    tty = installFakeTty()
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
    expect(visible(tty)).toContain("Setup cancelled")
  })

  test("hint aksi minimalis tampil di dasar kotak form", async () => {
    tty = installFakeTty()
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    const out = visible(tty)
    expect(out).toContain("Minicode setup [1/2]")
    expect(out).toContain("Esc")
    expect(out).toContain("Enter save")
    expect(out).not.toContain("Esc cancel")
    await tty.send(KEY.esc, 60)
    await p
  })

  test("form Base URL tidak melebihi lebar terminal", async () => {
    tty = installFakeTty({ columns: 40, rows: 20 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    for (const l of tty.screen()) {
      expect(displayWidth(l)).toBeLessThanOrEqual(40)
    }
    await tty.send(KEY.esc, 60)
    await p
  })

  test("URL lalu API key [2/2] — Esc di API key membatalkan setup", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    const p = runSetupWizard()
    await tty.ready(3000)
    await tty.send("https://api.example.com/v1")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => stripAnsi(o).includes("Minicode setup [2/2]"), 3000)
    expect(visible(tty)).toContain("API key for https://api.example.com/v1")
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
  })

  test("submit Base URL + API key langsung menyimpan provider tanpa preset", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    isolateHome()
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const p = runSetupWizard()
      await tty.ready(3000)
      await tty.send("https://api.contoh.test/v1")
      await tty.send(KEY.enter)
      await tty.waitForOutput((o) => stripAnsi(o).includes("Minicode setup [2/2]"), 3000)
      await tty.send("sk-test-123")
      await tty.send(KEY.enter)
      expect(await p).toBe(true)
      const cfgPath = join(home!, ".minicode", "config.json")
      expect(existsSync(cfgPath)).toBe(true)
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        providers: { id: string; baseUrl: string; models: string[] }[]
      }
      expect(cfg.providers).toHaveLength(1)
      expect(cfg.providers[0]?.baseUrl).toBe("https://api.contoh.test/v1")
      expect(cfg.providers[0]?.models).toEqual(["m-1"])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test("dialog error panjang dapat digulir dengan j/panah di layar pendek", async () => {
    tty = installFakeTty({ columns: 50, rows: 12 })
    const p = runSetupWizardView({
      onSubmit: async () => {
        tty!.resize(28, 10)
        throw new Error("boom")
      },
    })
    await tty.ready(3000)
    await tty.send("https://api.gagal.test/v1")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => stripAnsi(o).includes("Minicode setup [2/2]"), 3000)
    await tty.send("sk-test-123")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f.some((l) => l.includes("Model detection")), 4000)
    expect(tty.screen().join("\n")).not.toContain("--verbose")
    await tty.send("j")
    await tty.waitForScreen((f) => f.some((l) => l.includes("--verbose")))
    await tty.send(KEY.esc, 60)
    expect(await p).toBe(false)
  })

  test("Esc selama Detecting models… membatalkan request dan kembali ke form dengan draft utuh", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    let sawAbort = false
    const p = runSetupWizardView({
      onSubmit: (_url, _key, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true
              reject(new DOMException("aborted", "AbortError"))
            },
            { once: true },
          )
        }),
    })
    await tty.ready(3000)
    await tty.send("https://api.lambat.test/v1")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => stripAnsi(o).includes("Minicode setup [2/2]"), 3000)
    await tty.send("sk-lambat-123")
    await tty.send(KEY.enter)
    await tty.waitForScreen((f) => f.some((l) => l.includes("Detecting models")), 3000)
    expect(tty.screen().join("\n")).toContain("Esc")
    await tty.send(KEY.esc, 90)
    // Kembali ke langkah [1/2] dengan URL draft masih terisi (tidak terbuang).
    await tty.waitForScreen(
      (f) =>
        f.some((l) => l.includes("Minicode setup [1/2]")) &&
        f.some((l) => l.includes("api.lambat.test")),
      3000,
    )
    expect(sawAbort).toBe(true)
    await tty.send(KEY.ctrlD, 60)
    expect(await p).toBe(false)
  })
})

describe("wizard: preset kosong", () => {
  test("tidak ada preset gateway terdaftar", () => {
    expect(GATEWAY_PRESETS).toEqual([])
  })
})
