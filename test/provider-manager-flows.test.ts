// Interactive `runProviderManager` flows: a (add), d (delete), e (edit).
//
// These paths were previously untested (43% lines) because they run
// `askLine`/`askSecret` INSIDE suspended raw mode: the old harness could only
// send keys to the currently attached listener, while each next prompt installs
// a fresh listener after the previous one finishes.
// `tty.answerSequence()` (see helpers/tui-harness.ts) closes that gap by waiting
// for each new listener attachment.
//
// Global config at `~/.minicode/config.json` is backed up and restored:
// `src/config.ts` computes that path at import time, so it cannot be redirected
// via env inside the same process. This mirrors `test/sync.test.ts`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runProviderManager } from "../cli/provider-manager.ts"
import { clearDetectCache } from "../src/providers/detect.ts"
import { stripAnsi } from "../src/ui/render/theme.ts"
import { type FakeTty, installFakeTty, KEY } from "./helpers/tui-harness.ts"

const globalPath = join(homedir(), ".minicode", "config.json")
const globalBak = `${globalPath}.bak-provider-manager-test`
const hadGlobal = existsSync(globalPath)
if (hadGlobal) await rename(globalPath, globalBak).catch(() => {})
await mkdir(join(homedir(), ".minicode"), { recursive: true }).catch(() => {})

const origFetch = globalThis.fetch
/** Deteksi model berhasil dengan dua model. */
const okFetch = (async (url: unknown) => {
  if (String(url).includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
      status: 200,
    })
  }
  return new Response("nf", { status: 404 })
}) as typeof fetch
/** All endpoints fail — forces fallback/rollback path. */
const failFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch

let tty: FakeTty | undefined
let workspace: string

const tmpRoots: string[] = []

beforeEach(async () => {
  clearDetectCache()
  globalThis.fetch = okFetch
  workspace = mkdtempSync(join(tmpdir(), "minicode-pm-"))
  tmpRoots.push(workspace)
  await mkdir(join(workspace, ".minicode"), { recursive: true })
  await writeFile(globalPath, JSON.stringify({ providers: [] }), "utf8")
})

afterEach(() => {
  tty?.restore()
  tty = undefined
})

afterAll(async () => {
  globalThis.fetch = origFetch
  clearDetectCache()
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
  try {
    if (hadGlobal) await rename(globalBak, globalPath)
    else rmSync(globalPath, { force: true })
  } catch {}
})

const localConfigPath = () => join(workspace, ".minicode", "config.json")

async function writeLocalProviders(providers: unknown[]): Promise<void> {
  await writeFile(localConfigPath(), JSON.stringify({ providers }), "utf8")
}

async function readConfig(
  path: string,
): Promise<{ providers: { id: string; models: string[]; apiKey?: string }[] }> {
  return JSON.parse(await readFile(path, "utf8")) as {
    providers: { id: string; models: string[]; apiKey?: string }[]
  }
}

const visible = (t: FakeTty): string => stripAnsi(t.all())

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("Timed out waiting for condition")
}

interface Manager {
  done: Promise<void>
  /** Close manager and await completion. */
  close(): Promise<void>
}

async function openManager(
  opts: { currentModel?: string; setModelOverride?: (m: string) => void } = {},
): Promise<Manager> {
  const t = tty
  if (!t) throw new Error("installFakeTty must be called first")
  const done = runProviderManager({ cwd: workspace, allowLocalConfig: true, ...opts })
  await t.ready()
  return {
    done,
    async close() {
      // Jangan kirim Esc saat jendela suspend (0 listener): ia hilang dan
      // `await done` gantung sampai timeout test. Tunggu listener kembali.
      await t.waitForListener(2000)
      await t.send(KEY.esc, 30)
      await done
    },
  }
}

describe.serial("provider-manager: add (a)", () => {
  // Alur langsung (tanpa picker preset): "a" → form (Base URL + API key + scope)
  // → Tab navigasi → Enter simpan. SEMUA ketikan di dalam kotak.
  async function addFlow(
    opts: { url?: string; key?: string; local?: boolean } = {},
  ): Promise<void> {
    const t = tty
    if (!t) throw new Error("installFakeTty must be called first")
    await t.send("a")
    await t.waitForOutput((o) => o.includes("Base URL"))
    await t.send(opts.url ?? "https://api.openai.com/v1")
    if (opts.key !== undefined) {
      await t.send(KEY.tab) // URL → key
      await t.send(opts.key)
    }
    await t.send(KEY.tab) // → scope
    if (opts.local) await t.send(KEY.right) // global → local
  }

  test("Base URL + scope local menyimpan provider ke config lokal", async () => {
    tty = installFakeTty({ rows: 24 })
    const t = tty // lokal typed untuk dipakai di dalam callback (narrowing
    // variabel modul tidak bertahan lintas closure).
    const mgr = await openManager()
    await addFlow({ key: "sk-1", local: true })
    await t.send(KEY.enter)
    // Save terjadi SETELAH "Detecting models…" async — tunggu config
    // tertulis sebelum dibaca (kelas race lama).
    await waitFor(
      async () =>
        existsSync(localConfigPath()) &&
        (await readConfig(localConfigPath())).providers.length === 1,
    )
    await waitFor(() => visible(t).includes("saved"))
    const out = visible(tty)
    expect(out).toContain("saved")
    const cfg = await readConfig(localConfigPath())
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.providers[0]?.id).toBe("api-openai-com")
    expect(cfg.providers[0]?.models).toEqual(["model-a", "model-b"])
    // Global remains empty — scope is respected.
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await mgr.close()
  })

  test("global scope (default) saves to ~/.minicode", async () => {
    tty = installFakeTty({ rows: 24 })
    const t = tty
    const mgr = await openManager()
    await addFlow({ key: "sk-1" })
    await tty.send(KEY.enter)
    await waitFor(async () => (await readConfig(globalPath)).providers.length === 1)
    // Tunggu layar daftar dirender ulang (detachCancel + resume selesai) sebelum close().
    await waitFor(() => /saved|tersimpan/i.test(visible(t)))
    await mgr.close()
  })

  test("URL kustom dipakai apa adanya tanpa picker preset", async () => {
    tty = installFakeTty({ rows: 24 })
    const t = tty
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    expect(visible(tty)).not.toContain("Custom URL")
    // Fokus langsung di Base URL: isi URL, Tab ke API key, Tab ke scope.
    await tty.send("https://gw.contoh/v1")
    await tty.send(KEY.tab)
    await tty.send("sk-2")
    await tty.send(KEY.tab)
    await tty.send(KEY.right) // global → local
    await tty.send(KEY.enter)
    // URL kustom juga menjalani detect async sebelum save.
    await waitFor(() => existsSync(localConfigPath()))
    await waitFor(() => /saved|tersimpan/i.test(visible(t)))
    const cfg = JSON.parse(await readFile(localConfigPath(), "utf8")) as {
      providers: { baseUrl: string }[]
    }
    expect(cfg.providers[0]?.baseUrl).toBe("https://gw.contoh/v1")
    await mgr.close()
  })

  test("empty URL -> required message, nothing is saved", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    // URL kosong langsung Enter → error inline, form tetap terbuka.
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("required"))
    await tty.send(KEY.esc, 90)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    expect(existsSync(localConfigPath())).toBe(false)
    await mgr.close()
  })

  test("empty API key -> required message, nothing is saved", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    await tty.send("https://api.openai.com/v1")
    await tty.send(KEY.tab) // URL → key (kosong)
    await tty.send(KEY.tab) // → scope
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("required"))
    await tty.send(KEY.esc, 90)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    expect(existsSync(localConfigPath())).toBe(false)
    await mgr.close()
  })

  test("Ctrl+C in form cancels WITHOUT killing the session", async () => {
    // Field masih kosong/utuh → tekan-1 langsung batal; manager tetap hidup.
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    await tty.send(KEY.ctrlC, 90)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    await mgr.close()
  })

  test("Ctrl+C dua-tahap saat input diubah: tekan-1 kembalikan, tekan-2 batal", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    await tty.send("https://draft.example") // ubah isi awal (dirty)
    await tty.send(KEY.ctrlC, 150)
    // Tekan-1: isian dikembalikan ke awal, form TETAP terbuka (tanpa "Cancelled").
    expect(visible(tty)).not.toContain("Cancelled")
    await tty.send(KEY.ctrlC, 90)
    // Tekan-2: batal total, manager tetap hidup.
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    await mgr.close()
  })

  test("Ctrl+U clears field (not char-by-char)", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    await tty.send("https://api.openai.com/v1")
    await tty.send(KEY.tab)
    await tty.send("sk-1")
    await tty.send(KEY.ctrlU, 30) // hapus semua
    await tty.send(KEY.tab)
    await tty.send(KEY.enter)
    // Isian sudah terhapus → submit = "required", bukan "saved".
    await tty.waitForOutput((o) => o.includes("required"))
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await tty.send(KEY.esc, 90)
    await mgr.close()
  })

  test("Esc at add form cancels", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"))
    await tty.send(KEY.esc, 90)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    expect((await readConfig(globalPath)).providers).toHaveLength(0)
    await mgr.close()
  })

  test("menambah URL yang slug-nya sudah ada otomatis membuat suffix numerik", async () => {
    await writeFile(
      globalPath,
      JSON.stringify({
        providers: [
          {
            id: "api-openai-com",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "lama",
            models: ["lama-1"],
          },
        ],
      }),
      "utf8",
    )
    tty = installFakeTty({ rows: 24 })
    const t = tty
    const mgr = await openManager()
    await addFlow({ key: "k-baru" })
    await tty.send(KEY.enter)
    await waitFor(async () => (await readConfig(globalPath)).providers.length === 2)
    await waitFor(() => /saved|tersimpan/i.test(visible(t)))
    const cfg = JSON.parse(await readFile(globalPath, "utf8")) as {
      providers: { id: string; apiKey: string }[]
    }
    expect(cfg.providers.find((p) => p.id === "api-openai-com")?.apiKey).toBe("lama")
    expect(cfg.providers.find((p) => p.id === "api-openai-com-2")?.apiKey).toBe("k-baru")
    await mgr.close()
  })

  test("model detection failure falls back to default models, not thrown", async () => {
    globalThis.fetch = failFetch
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await addFlow({ key: "sk-3" })
    await tty.send(KEY.enter)
    // Endpoint 500 semua → fallbackModels dipakai, provider TETAP tersimpan.
    await waitFor(async () => (await readConfig(globalPath)).providers.length === 1, 30000)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("saved")
    })
    expect(tty.failures()).toEqual([])
    await mgr.close()
  }, 60000)
})

describe.serial("provider-manager: delete (d)", () => {
  const oneProvider = [
    { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1", "m2", "m3"] },
  ]

  test("'y' confirmation deletes from local and global config", async () => {
    await writeLocalProviders(oneProvider)
    await writeFile(globalPath, JSON.stringify({ providers: oneProvider }), "utf8")
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("d")
    await tty.waitForOutput((o) => o.includes("Delete provider"))
    // Konfirmasi menyebut DAMPAK: berapa model ikut hilang.
    expect(visible(tty)).toContain("(3 models)")
    await tty.send("y")
    await tty.send(KEY.enter)
    await waitFor(async () => {
      const local = await readConfig(localConfigPath())
      const global = await readConfig(globalPath)
      return local.providers.length === 0 && global.providers.length === 0
    })
    await mgr.close()
  }, 5000)

  test("'n' confirmation cancels — provider remains", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("d")
    await tty.waitForOutput((o) => o.includes("Delete provider"))
    await tty.send("n")
    await tty.send(KEY.enter)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    expect((await readConfig(localConfigPath())).providers).toHaveLength(1)
    await mgr.close()
  })

  test("empty Enter equals reject (default N)", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("d")
    await tty.waitForOutput((o) => o.includes("Delete provider"))
    await tty.send(KEY.enter)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("Cancelled")
    })
    expect((await readConfig(localConfigPath())).providers).toHaveLength(1)
    await mgr.close()
  })

  test("deleting active provider shows explicit warning", async () => {
    await writeLocalProviders(oneProvider)
    tty = installFakeTty({ rows: 24 })
    const t = tty
    const mgr = await openManager({ currentModel: "gw::m1" })
    // List marks active provider before user presses d.
    expect(visible(tty)).toContain("(active)")
    await tty.send("d")
    await tty.waitForOutput((o) => o.includes("Delete provider"))
    const out = visible(tty)
    expect(out).toContain("active")
    expect(out).toContain("gw::m1")
    await tty.send("y")
    await tty.send(KEY.enter)
    await waitFor(() => /deleted|dihapus/i.test(visible(t)))
    await mgr.close()
  }, 5000)

  test("empty list: d does nothing", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("d", 40)
    expect(visible(tty)).not.toContain("Continue delete")
    expect(tty.failures()).toEqual([])
    await mgr.close()
  })
})

describe.serial("provider-manager: edit (e)", () => {
  // Alur baru: "e" → form dalam popup (URL prefill + key kosong=tetap).
  async function openEditForm(t: FakeTty): Promise<void> {
    await t.send("e")
    await t.waitForOutput((o) => o.includes("Base URL"))
  }

  test("changing baseUrl triggers re-detection", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://lama.example/v1", apiKey: "k", models: ["lama"] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const t = tty
    if (!t) throw new Error("fake tty is missing")
    await openEditForm(t)
    // URL prefill terfokus di awal: hapus dulu lalu ketik baru.
    await t.send(KEY.ctrlU)
    await t.send("https://baru.example/v1")
    await t.send(KEY.tab)
    await t.send(KEY.tab)
    await t.send(KEY.enter)
    await waitFor(() => {
      const tt = tty
      if (!tt) throw new Error("tty gone")
      return visible(tt).includes("updated")
    }, 2000)
    const out = visible(t)
    expect(out).toContain("updated")
    // Entri updated tetap di scope asal (lokal), tidak menggandakan ke global.
    const cfg = JSON.parse(await readFile(localConfigPath(), "utf8")) as {
      providers: { baseUrl: string; models: string[] }[]
    }
    expect(cfg.providers[0]?.baseUrl).toBe("https://baru.example/v1")
    expect(cfg.providers[0]?.models).toEqual(["model-a", "model-b"])
    const globalCfg = await readConfig(globalPath)
    expect(globalCfg.providers).toHaveLength(0)
    await mgr.close()
  })

  test("both inputs empty -> 'No changes'", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await openEditForm(tty)
    // Enter langsung: URL = defaults (prefill), key kosong = tetap.
    await tty.send(KEY.enter)
    await waitFor(() => {
      const t = tty
      if (!t) throw new Error("tty gone")
      return visible(t).includes("No changes")
    })
    // Config lokal tidak tersentuh.
    expect((await readConfig(localConfigPath())).providers[0]?.models).toEqual(["m1"])
    await mgr.close()
  })

  test("save failure -> error is shown + rollback attempted, without exception", async () => {
    // Provider with no models + failed detect => saveProvider rejects
    // ("provider Update failed"). This is the only doEdit path that reaches
    // catch + rollback.
    globalThis.fetch = failFetch
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: [] },
    ])
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    const t = tty
    if (!t) throw new Error("fake tty is missing")
    await openEditForm(t)
    await t.send(KEY.ctrlU)
    await t.send("https://baru.example/v1")
    await t.send(KEY.tab)
    await t.send(KEY.tab)
    await t.send(KEY.enter)
    await waitFor(() => {
      const tt = tty
      if (!tt) throw new Error("tty gone")
      return visible(tt).includes("updated")
    }, 2000)
    expect(visible(t)).toContain("updated")
    expect(tty.failures()).toEqual([])
    await mgr.close()
  }, 5000)

  test("empty list: e does nothing", async () => {
    tty = installFakeTty({ rows: 24 })
    const mgr = await openManager()
    await tty.send("e", 40)
    expect(visible(tty)).not.toContain("Edit provider")
    await mgr.close()
  })
})

describe.serial("provider-manager: navigasi", () => {
  test("down arrow moves selection, Enter activates first model", async () => {
    await writeLocalProviders([
      { id: "satu", baseUrl: "https://a.example/v1", apiKey: "k", models: ["a1"] },
      { id: "dua", baseUrl: "https://b.example/v1", apiKey: "k", models: ["b1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    let picked: string | undefined
    const mgr = await openManager({
      setModelOverride: (m) => {
        picked = m
      },
    })
    await tty.send(KEY.down)
    await tty.send(KEY.enter, 30)
    await mgr.done
    expect(picked).toBe("dua::b1")
  })

  test("up arrow on first row stays within bounds", async () => {
    await writeLocalProviders([
      { id: "satu", baseUrl: "https://a.example/v1", apiKey: "k", models: ["a1"] },
    ])
    tty = installFakeTty({ rows: 24 })
    let picked: string | undefined
    const mgr = await openManager({
      setModelOverride: (m) => {
        picked = m
      },
    })
    await tty.send(KEY.up)
    await tty.send(KEY.up)
    await tty.send(KEY.enter, 30)
    await mgr.done
    expect(picked).toBe("satu::a1")
  })

  test("Ctrl+C and Ctrl+D close manager like Esc", async () => {
    for (const key of [KEY.ctrlC, KEY.ctrlD]) {
      tty?.restore()
      tty = installFakeTty({ rows: 24 })
      const done = runProviderManager({ cwd: workspace })
      await tty.ready()
      await tty.send(key, 30)
      await done
    }
    expect(true).toBe(true)
  })

  test("PgDn/PgUp/Home/End navigasi daftar panjang (dulu mati total)", async () => {
    // Gagal-di-kode-lama: pageup/pagedown/home/end tak ditangani padahal ada
    // baris `… more`. 20 provider, rows 24 → visible 14? (24-5, cap 14).
    await writeLocalProviders(
      Array.from({ length: 20 }, (_, i) => ({
        id: `gw${String(i).padStart(2, "0")}`,
        baseUrl: "https://a.example/v1",
        apiKey: "k",
        models: ["m1"],
      })),
    )
    tty = installFakeTty({ rows: 24 })
    let picked: string | undefined
    const mgr = await openManager({
      setModelOverride: (m) => {
        picked = m
      },
    })
    await tty.send(KEY.pgDown)
    await tty.send(KEY.enter, 30)
    await mgr.done
    // PgDn menggerakkan seleksi satu halaman dari gw00 → bukan gw00 lagi.
    expect(picked).not.toBe("gw00::m1")
    expect(picked).toMatch(/^gw\d\d::m1$/)
  })

  test("resize redraws without exceeding terminal width", async () => {
    await writeLocalProviders(
      Array.from({ length: 8 }, (_, i) => ({
        id: `provider-dengan-nama-panjang-${i}`,
        baseUrl: `https://contoh-gateway-yang-panjang-sekali-${i}.example/v1`,
        apiKey: "k",
        models: ["m1"],
      })),
    )
    tty = installFakeTty({ columns: 40, rows: 10 })
    const mgr = await openManager()
    tty.clear()
    tty.resize(30, 8)
    await new Promise((r) => setTimeout(r, 20))
    // Popup region cursor-addressed: ukur via parser screen (CUP/EL bukan
    // SGR dan tak di-strip oleh stripAnsi).
    for (const line of tty.screen()) {
      expect(line.replace(/\s+$/, "").length).toBeLessThanOrEqual(30)
    }
    await mgr.close()
  })

  test("list longer than screen stays compact", async () => {
    await writeLocalProviders(
      Array.from({ length: 12 }, (_, i) => ({
        id: `gw${i}`,
        baseUrl: `https://gw${i}.example/v1`,
        apiKey: "k",
        models: ["m1"],
      })),
    )
    // Baris tambahan tidak ditampilkan; daftar tetap dibatasi tinggi terminal.
    tty = installFakeTty({ columns: 80, rows: 12 })
    const mgr = await openManager()
    const screen = tty.screen().join("\n")
    expect(screen).toContain("gw0")
    expect(screen).toContain("(1-7/12)")
    expect(screen).not.toContain("gw11")
    expect(screen).not.toContain("more")
    await mgr.close()
  })
})

describe.serial("provider-manager: non-TTY", () => {
  test("lists providers as-is without raw mode", async () => {
    await writeLocalProviders([
      { id: "gw", baseUrl: "https://gw.example/v1", apiKey: "k", models: ["m1", "m2"] },
    ])
    tty = installFakeTty({ isTTY: false })
    await runProviderManager({ cwd: workspace, allowLocalConfig: true })
    const out = visible(tty)
    expect(out).toContain("gw")
    expect(out).not.toContain("2 models")
  })
})

describe("provider-manager view: aksi gantung → watchdog pulih", () => {
  test("onDelete gantung → notice timeout + UI interaktif lagi", async () => {
    // Gagal-di-kode-lama: network non-kooperatif saat suspend = popup mati.
    const { runProviderManagerView } = await import("../src/ui/screens/provider-manager.ts")
    tty = installFakeTty({ rows: 24 })
    let resolveHung!: () => void
    const hung = new Promise<void>((r) => (resolveHung = r))
    const p = runProviderManagerView({
      initialRows: [{ id: "gw", baseUrl: "https://gw.example/v1", models: 1 }],
      presets: [],
      askScope: false,
      onSelect: () => {},
      loadRows: async () => [{ id: "gw", baseUrl: "https://gw.example/v1", models: 1 }],
      onAdd: async () => ({}),
      onDelete: () => hung.then(() => ({})),
      onEditDefaults: async () => null,
      onEditSave: async () => ({}),
      actionTimeoutMs: 300,
    })
    await tty.ready()
    await tty.send("d")
    await tty.waitForOutput((o) => o.includes("Delete provider"), 2000)
    await tty.send("y")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => /timeout|timed out|batas waktu/i.test(o), 5000)
    // UI pulih: Esc menutup normal (kode lama: gantung selamanya).
    await tty.waitForListener(2000)
    await tty.send(KEY.esc, 30)
    await p
    resolveHung()
  }, 8000)

  test("T3: Esc saat Detecting models membatalkan request, plus onSelect throw tidak tertelan", async () => {
    const { runProviderManagerView } = await import("../src/ui/screens/provider-manager.ts")
    tty = installFakeTty({ rows: 24 })
    let sawAbort = false
    const cur = ""
    const p = runProviderManagerView({
      initialRows: [{ id: "gw", baseUrl: "https://gw.example/v1", models: 1, firstModel: "m1" }],
      presets: [],
      getCurrentModel: () => cur,
      askScope: false,
      onSelect: () => {
        throw new Error("save failed")
      },
      loadRows: async () => [
        { id: "gw", baseUrl: "https://gw.example/v1", models: 1, firstModel: "m1" },
      ],
      onAdd: (_input, signal) =>
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
      onDelete: async () => ({}),
      onEditDefaults: async () => null,
      onEditSave: async () => ({}),
      actionTimeoutMs: 5000,
    })
    await tty.ready()
    await tty.send("a")
    await tty.waitForOutput((o) => o.includes("Base URL"), 2000)
    await tty.send("https://api.example.com/v1")
    await tty.send(KEY.tab)
    await tty.send("sk-test")
    await tty.send(KEY.enter)
    await tty.waitForOutput((o) => o.includes("Detecting models"), 2000)
    await tty.send(KEY.esc, 60)
    await tty.waitForOutput(() => visible(tty!).includes("Cancelled"), 2000)
    expect(sawAbort).toBe(true)
    await tty.waitForListener(2000)
    // Enter pada onSelect yang melempar: popup tetap terbuka dan notice error tampil.
    await tty.send(KEY.enter, 60)
    await tty.waitForOutput(
      () => visible(tty!).includes("save failed") || visible(tty!).includes("unexpected"),
      2000,
    )
    await tty.send(KEY.esc, 30)
    await p
  }, 8000)
})

// Sanity: workspace benar-benar terisolasi dari repo.
test("test workspace stays in temp directory, not repo", () => {
  expect(resolve(workspace).startsWith(resolve(tmpdir()))).toBe(true)
})
