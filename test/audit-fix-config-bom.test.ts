// Regresi BOM UTF-8 pada config.json (laporan pemilik 2026-11-20): setup wizard
// gagal menyimpan API key karena `JSON.parse` menolak BOM (EF BB BF) yang
// ditulis editor/PowerShell Windows, lalu `updateConfigAtomic` mengira config
// corrupt dan mem-backupnya. File yang ditulis Minicode sendiri TANPA BOM, tapi
// file dari luar sah dibaca. Semua home diisolasi via MINICODE_HOME.

import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globalConfigPath, loadConfig, parseJsonFile, updateConfigAtomic } from "../src/config.ts"

function hermetic() {
  const home = mkdtempSync(join(tmpdir(), "minicode-bom-"))
  const prev = process.env.MINICODE_HOME
  process.env.MINICODE_HOME = home
  mkdirSync(join(home, ".minicode"), { recursive: true })
  return {
    home,
    path: join(home, ".minicode", "config.json"),
    restore() {
      if (prev === undefined) delete process.env.MINICODE_HOME
      else process.env.MINICODE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test("parseJsonFile: BOM di awal dibuang, JSON biasa tak berubah", () => {
  expect(parseJsonFile('\uFEFF{"a":1}')).toEqual({ a: 1 })
  expect(parseJsonFile('  {"a":1}')).toEqual({ a: 1 })
  // BOM di tengah BUKAN BOM awal — tetap error (jangan menyembunyikan kerusakan).
  expect(() => parseJsonFile('{"a":\uFEFF1}')).toThrow()
})

test("updateConfigAtomic: config BOM terbaca, mutasi tersimpan tanpa BOM & tanpa backup corrupt", async () => {
  const h = hermetic()
  try {
    expect(globalConfigPath()).toBe(h.path)
    writeFileSync(
      h.path,
      '\uFEFF{"providers":[{"id":"p1","baseUrl":"https://p.test/v1","apiKey":"k","models":["m"]}]}',
      "utf8",
    )
    await updateConfigAtomic({ global: true }, (cfg) => {
      cfg.providers.push({
        id: "p2",
        baseUrl: "https://q.test/v1",
        apiKey: "k2",
        models: ["m2"],
      })
    })
    const bytes = readFileSync(h.path)
    expect(bytes[0]).not.toBe(0xef) // hasil tulisan Minicode selalu tanpa BOM
    const parsed = JSON.parse(bytes.toString("utf8")) as { providers: { id: string }[] }
    expect(parsed.providers.map((p) => p.id)).toEqual(["p1", "p2"])
    expect(readdirSync(join(h.home, ".minicode")).some((f) => f.includes(".corrupt."))).toBe(false)
    expect(existsSync(`${h.path}.corrupt.1795152881991`)).toBe(false)
  } finally {
    h.restore()
  }
})

test("loadConfig: config global dengan BOM tetap memuat provider", async () => {
  const h = hermetic()
  try {
    writeFileSync(
      h.path,
      '\uFEFF{"providers":[{"id":"bomprov","baseUrl":"https://b.test/v1","apiKey":"k","models":["m"]}]}',
      "utf8",
    )
    const cfg = await loadConfig(process.cwd())
    expect(cfg.providers.map((p) => p.id)).toContain("bomprov")
  } finally {
    h.restore()
  }
})
