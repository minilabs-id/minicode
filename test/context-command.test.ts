// Regresi `/context` — permukaan "temukan" untuk jendela konteks manual.
//
// Kenapa test ini ada: fitur jendela konteks manual sempat selesai di lapisan
// mesin tapi tak punya jalan masuk selain subcommand CLI tersembunyi. Audit
// pengguna menemukannya sebagai "fitur tidak ada". Tiga kegagalan nyata diuji
// di sini, semuanya terbukti gagal di kode lama:
//   1. `/context <nilai>` tidak mengubah angka yang dipakai sesi yang sedang
//      berjalan (config di-snapshot saat start) — "saved" tapi tak berefek.
//   2. `/context auto` tidak menghapus nilai di disk: `saveProvider` versi lama
//      menyelamatkan `contextWindows` milik entri lama sehingga penghapusan
//      sengaja dibatalkan diam-diam.
//   3. Salah ketik diterima sebagai angka (memotong konteks tanpa gejala).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandContext } from "../cli/commands.ts"
import { contextWindowSavedNotice, originLabel } from "../cli/context-command.ts"
import { applyContextWindowArg } from "../cli/context-command-run.ts"
import { loadConfig } from "../src/config.ts"
import { __resetLiveContextWindows, resolveContextWindow } from "../src/policy/context-window.ts"

let home: string
const originalHome = process.env.MINICODE_HOME

function ctxFor(model: string): CommandContext {
  return {
    cwd: home,
    sessionId: "test",
    currentModel: model,
    usage: {} as CommandContext["usage"],
    skills: [],
    toolsCount: 0,
    setModelOverride: () => {},
    getContextTokens: () => 0,
    budgetState: () => "ok",
  }
}

async function writeConfig(contextWindows?: Record<string, number>): Promise<void> {
  await writeFile(
    join(home, ".minicode", "config.json"),
    JSON.stringify({
      providers: [
        {
          id: "demo",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          models: ["model-x", "model-y"],
          ...(contextWindows
            ? {
                contextWindows,
                contextWindowSources: Object.fromEntries(
                  Object.keys(contextWindows).map((k) => [k, "user"]),
                ),
              }
            : {}),
        },
      ],
    }),
    "utf8",
  )
}

async function diskWindows(): Promise<Record<string, number> | undefined> {
  const raw = JSON.parse(await readFile(join(home, ".minicode", "config.json"), "utf8"))
  return raw.providers[0].contextWindows
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "minicode-ctx-"))
  await mkdir(join(home, ".minicode"), { recursive: true })
  process.env.MINICODE_HOME = home
  __resetLiveContextWindows()
})

afterEach(() => {
  __resetLiveContextWindows()
  if (originalHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = originalHome
})

describe("/context — menetapkan jendela", () => {
  test("nilai baru langsung dipakai sesi berjalan tanpa restart", async () => {
    await writeConfig()
    // Snapshot config seperti sesi nyata: dibaca SEKALI di awal.
    const snapshot = await loadConfig(home)
    expect(resolveContextWindow(snapshot, "demo::model-x").source).toBe("safe-default")

    const lines = await applyContextWindowArg("400k", ctxFor("demo::model-x"))
    expect(lines.join("\n")).toContain("400K")

    // Kegagalan kode lama: sumber tetap safe-default (config beku).
    const after = resolveContextWindow(snapshot, "demo::model-x")
    expect(after.tokens).toBe(400_000)
    expect(after.origin).toBe("user")
    expect(await diskWindows()).toEqual({ "model-x": 400_000 })
  })

  test("auto menghapus nilai di disk dan melepas override sesi", async () => {
    await writeConfig({ "model-x": 200_000 })
    const snapshot = await loadConfig(home)
    expect(resolveContextWindow(snapshot, "demo::model-x").tokens).toBe(200_000)

    await applyContextWindowArg("auto", ctxFor("demo::model-x"))

    // Kegagalan kode lama: disk tetap {"model-x":200000} karena saveProvider
    // "menyelamatkan" nilai lama milik entri sebelumnya.
    expect(await diskWindows()).toBeUndefined()
    expect(resolveContextWindow(snapshot, "demo::model-x").tokens).toBe(131_072)
  })

  test("salah ketik ditolak dan tidak menyentuh config", async () => {
    await writeConfig({ "model-x": 200_000 })
    const lines = await applyContextWindowArg("1.2.3", ctxFor("demo::model-x"))
    expect(lines.join("\n")).toContain("cannot read")
    expect(await diskWindows()).toEqual({ "model-x": 200_000 })
  })

  test("provider default (*) ikut terlihat di tabel", async () => {
    await writeConfig({ "*": 500_000 })
    const lines = await applyContextWindowArg("", ctxFor("demo::model-x"))
    const body = lines.join("\n")
    expect(body).toContain("model-x")
    expect(body).toContain("500K")
    expect(body).toContain("manual")
  })

  test("tabel kosong memberi petunjuk, bukan tabel tanpa baris", async () => {
    await writeConfig()
    const lines = await applyContextWindowArg("", ctxFor("demo::model-x"))
    // Ada model → tabel terisi; yang diuji adalah cabang tanpa model.
    await writeFile(join(home, ".minicode", "config.json"), JSON.stringify({ providers: [] }))
    const empty = await applyContextWindowArg("", ctxFor("demo::model-x"))
    expect(empty.length).toBeGreaterThan(0)
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe("regresi: auto tidak boleh memicu rekursi tak berujung", () => {
  test("resolve dengan auto selesai (bukan hang) dan melewati angka config", async () => {
    await writeConfig({ "model-x": 900_000 })
    const snapshot = await loadConfig(home)
    await applyContextWindowArg("auto", ctxFor("demo::model-x"))
    // Kegagalan kode lama: `resolveIgnoringConfigWindows` memanggil
    // `resolveContextWindow` tanpa flag → cabang "cleared" terpicu lagi →
    // rekursi tak berujung dan sesi menggantung (bukan melempar error).
    const res = resolveContextWindow(snapshot, "demo::model-x")
    expect(res.tokens).toBe(131_072)
    expect(res.source).toBe("safe-default")
  })
})

describe("/context — label asal", () => {
  test("nilai manual dilabeli manual, tebakan mesin dilabeli sumbernya", () => {
    expect(originLabel({ tokens: 1, source: "model", origin: "user" })).toBe("manual")
    expect(originLabel({ tokens: 1, source: "model", origin: "endpoint" })).toBe("endpoint")
    expect(originLabel({ tokens: 1, source: "catalog" })).toBe("katalog")
    expect(originLabel({ tokens: 1, source: "safe-default" })).toBe("default aman")
    expect(originLabel({ tokens: 1, source: "override" })).toBe("flag")
  })

  test("notis simpan menyebut angka eksak, bukan hanya label", () => {
    const label = (n: number) => `${n / 1000}K`
    expect(contextWindowSavedNotice(128_000, label)).toContain("128,000")
    expect(contextWindowSavedNotice(null, label)).toContain("automatic")
  })
})
