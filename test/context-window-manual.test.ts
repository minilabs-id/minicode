// Jendela konteks MANUAL untuk model yang providernya tidak melaporkan kapasitas.
//
// Kenapa ini ada: tanpa jalur manual, satu-satunya cara adalah mengedit JSON
// config dan menebak angka. Salah tebak ke atas = request ditolak 400 di tengah
// turn (biaya token sudah keluar); ke bawah = kompaksi prematur yang membuang
// histori yang sebenarnya muat.

import { describe, expect, test } from "bun:test"
import type { ProviderEntry } from "../src/config.ts"
import { normalizeConfig } from "../src/config.ts"
import { resolveContextWindow } from "../src/policy/context-window.ts"
import {
  assignContextWindow,
  summarizeContextWindows,
} from "../src/policy/context-window-assign.ts"
import {
  CONTEXT_WINDOW_PRESETS,
  contextWindowChoices,
  describeContextWindow,
  findPresetByTokens,
  isValidContextWindowValue,
  parseContextWindowInput,
} from "../src/policy/context-window-presets.ts"

const provider = (extra: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: "fake",
  baseUrl: "http://localhost:9",
  apiKey: "sk-x",
  models: ["m1", "m2"],
  ...extra,
})

describe("parser: bentuk yang ditulis pengguna", () => {
  test("angka biasa, dengan pemisah, dan eksak", () => {
    expect(parseContextWindowInput("131072")).toBe(131_072)
    expect(parseContextWindowInput("131_072")).toBe(131_072)
    expect(parseContextWindowInput("200000")).toBe(200_000)
  })

  test("singkatan k/m", () => {
    expect(parseContextWindowInput("128k")).toBe(128_000)
    expect(parseContextWindowInput("128K")).toBe(128_000)
    expect(parseContextWindowInput("1m")).toBe(1_000_000)
    expect(parseContextWindowInput("1.05m")).toBe(1_050_000)
    expect(parseContextWindowInput("2M")).toBe(2_000_000)
  })

  test("bentuk 1024x1024 = varian Gemini/Kimi", () => {
    expect(parseContextWindowInput("1024x1024")).toBe(1_048_576)
    expect(parseContextWindowInput("1024*1024")).toBe(1_048_576)
  })

  test("auto berarti tanpa nilai (pakai rantai deteksi)", () => {
    expect(parseContextWindowInput("auto")).toBeUndefined()
    expect(parseContextWindowInput("AUTO")).toBeUndefined()
    expect(parseContextWindowInput("")).toBeUndefined()
  })

  test("masukan tak terbaca ditolak, bukan ditebak", () => {
    expect(parseContextWindowInput("besar")).toBeUndefined()
    expect(parseContextWindowInput("1.2.3")).toBeUndefined()
    expect(parseContextWindowInput("-5")).toBeUndefined()
    expect(parseContextWindowInput("abc123")).toBeUndefined()
  })
})

describe("preset: ukuran nyata di produksi", () => {
  test("terurut menaik tanpa duplikat", () => {
    const tokens = CONTEXT_WINDOW_PRESETS.map((p) => p.tokens)
    expect([...tokens].sort((a, b) => a - b)).toEqual(tokens)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  test("1M punya TIGA varian berbeda (ini bukan duplikat)", () => {
    // Anthropic/DeepSeek 1.000.000, Google/Kimi 1.048.576, OpenAI 1.050.000.
    // Selisih ~50K token: memilih yang salah = ~5% jendela meleset.
    expect(parseContextWindowInput("1m")).toBe(1_000_000)
    expect(parseContextWindowInput("1024x1024")).toBe(1_048_576)
    expect(parseContextWindowInput("1.05m")).toBe(1_050_000)
    for (const t of [1_000_000, 1_048_576, 1_050_000]) expect(findPresetByTokens(t)).toBeDefined()
  })

  test("setiap preset adalah ukuran yang dipakai model nyata", () => {
    // Jaga agar tidak ada angka karangan masuk: semuanya ≥16K dan ≤20M.
    for (const p of CONTEXT_WINDOW_PRESETS) {
      expect(isValidContextWindowValue(p.tokens)).toBe(true)
      expect(p.examples.length).toBeGreaterThan(0)
    }
  })

  test("auto selalu pilihan pertama dan tidak mengklaim angka", () => {
    const choices = contextWindowChoices()
    expect(choices[0]!.value).toBe("auto")
    // Angka di baris auto akan berbohong untuk sebagian model.
    expect(choices[0]!.label).not.toMatch(/\d/)
    expect(choices.length).toBe(CONTEXT_WINDOW_PRESETS.length + 1)
  })

  test("label diturunkan dari nilai, termasuk nilai manual", () => {
    expect(describeContextWindow(131_072)).toBe("128K")
    expect(describeContextWindow(1_000_000)).toBe("1M")
    expect(describeContextWindow(1_048_576)).toBe("1M (1024²)")
    expect(describeContextWindow(1_050_000)).toBe("1.05M")
    expect(describeContextWindow(140_000)).toBe("140K")
  })

  test("rentang wajar menolak salah ketik", () => {
    expect(isValidContextWindowValue(128)).toBe(false)
    expect(isValidContextWindowValue(0)).toBe(false)
    expect(isValidContextWindowValue(25_000_000)).toBe(false)
    expect(isValidContextWindowValue(131_072)).toBe(true)
  })
})

describe("assignContextWindow: presedensi dan hapus", () => {
  test("menetapkan nilai memberi sumber user (tak boleh ditimpa sync)", () => {
    const r = assignContextWindow(provider(), "m1", "128k")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.provider.contextWindows).toEqual({ m1: 128_000 })
    // `user` inilah yang membuat provision.ts tidak menimpa nilainya.
    expect(r.provider.contextWindowSources).toEqual({ m1: "user" })
    expect(r.tokens).toBe(128_000)
    expect(r.replaced).toBe(false)
  })

  test("nilai endpoint yang ada ditimpa dan ditandai user", () => {
    const r = assignContextWindow(
      provider({
        contextWindows: { m1: 32_768 },
        contextWindowSources: { m1: "endpoint" },
      }),
      "m1",
      "1m",
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.provider.contextWindows).toEqual({ m1: 1_000_000 })
    expect(r.provider.contextWindowSources).toEqual({ m1: "user" })
    expect(r.replaced).toBe(true)
  })

  test("auto menghapus nilai DAN sumbernya", () => {
    const r = assignContextWindow(
      provider({ contextWindows: { m1: 65_536 }, contextWindowSources: { m1: "user" } }),
      "m1",
      "auto",
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.provider.contextWindows).toBeUndefined()
    expect(r.provider.contextWindowSources).toBeUndefined()
    expect(r.tokens).toBeNull()
  })

  test("model lain tidak tersentuh", () => {
    const r = assignContextWindow(provider({ contextWindows: { m2: 200_000 } }), "m1", "128k")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.provider.contextWindows).toEqual({ m2: 200_000, m1: 128_000 })
  })

  test("wildcard * berlaku sebagai default provider", () => {
    const r = assignContextWindow(provider(), "*", "200k")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.provider.contextWindows).toEqual({ "*": 200_000 })
  })

  test("masukan tidak valid ditolak dengan pesan, bukan disimpan", () => {
    const bad = assignContextWindow(provider(), "m1", "sebesar mungkin")
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain("128k")
    expect(assignContextWindow(provider(), "", "128k").ok).toBe(false)
  })

  test("provider asli tidak dimutasi (pemanggil bebas membatalkan)", () => {
    const p = provider()
    assignContextWindow(p, "m1", "128k")
    expect(p.contextWindows).toBeUndefined()
  })
})

describe("config JSON menerima string preset", () => {
  test("string dan angka sama-sama dinormalisasi ke token", () => {
    const cfg = normalizeConfig({
      providers: [
        {
          id: "p",
          baseUrl: "http://localhost:9",
          apiKey: "k",
          models: ["a", "b", "c", "d"],
          contextWindows: { a: "128k", b: "1M", c: 200_000, d: "auto" },
        },
      ],
    })
    expect(cfg.providers[0]!.contextWindows).toEqual({
      a: 128_000,
      b: 1_000_000,
      c: 200_000,
    })
  })
})

describe("resolusi: nilai manual menang atas tebakan", () => {
  test("nilai user dipakai dan dilaporkan sebagai model", () => {
    const cfg = normalizeConfig({
      providers: [
        {
          id: "p",
          baseUrl: "http://localhost:9",
          apiKey: "k",
          models: ["misterius"],
          contextWindows: { misterius: "524k" },
        },
      ],
    })
    const r = resolveContextWindow(cfg, "misterius")
    expect(r.tokens).toBe(524_000)
    expect(r.source).toBe("model")
    expect(r.origin).toBe("user")
  })

  test("tanpa nilai manual, model tak dikenal tetap jatuh ke fallback", () => {
    const cfg = normalizeConfig({
      providers: [{ id: "p", baseUrl: "http://localhost:9", apiKey: "k", models: ["misterius"] }],
    })
    const r = resolveContextWindow(cfg, "misterius")
    expect(r.source).toBe("safe-default")
  })
})

describe("summarizeContextWindows: ringkasan untuk daftar", () => {
  test("terurut dan membawa asal nilai", () => {
    const rows = summarizeContextWindows(
      provider({
        contextWindows: { z: 1_000_000, a: 131_072 },
        contextWindowSources: { z: "user", a: "endpoint" },
      }),
    )
    expect(rows.map((r) => r.model)).toEqual(["a", "z"])
    expect(rows[0]!.source).toBe("endpoint")
    expect(rows[1]!.source).toBe("user")
  })

  test("entri tanpa catatan sumber dianggap user (config lama)", () => {
    const rows = summarizeContextWindows(provider({ contextWindows: { a: 131_072 } }))
    expect(rows[0]!.source).toBe("user")
  })
})
