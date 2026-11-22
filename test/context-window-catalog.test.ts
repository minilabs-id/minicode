// Katalog jendela konteks built-in: keluarga model umum dikenali tanpa config,
// sehingga tak langsung jatuh ke fallback 32k.
import { describe, expect, test } from "bun:test"
import type { MinicodeConfig } from "../src/config.ts"
import {
  __overlayScanCount,
  __resetContextWindowOverlay,
  __resetOverlayScanCount,
  __setContextWindowOverlay,
  findContextWindowFromOverlay,
  resolveContextWindow,
} from "../src/policy/context-window.ts"
import {
  findContextWindowFromCatalog,
  normalizeModelId,
} from "../src/policy/context-window-catalog.ts"
import { CONTEXT_WINDOW_PRESETS } from "../src/policy/context-window-presets.ts"
import { extractContextWindows } from "../src/policy/pricing.ts"

describe("context window catalog", () => {
  test("normalisasi versi v- agar tak menggagalkan pencocokan keluarga", () => {
    expect(normalizeModelId("DeepSeek-v-4.1-flash-1017")).toBe("deepseek-v4.1-flash-1017")
  })

  test.each([
    ["deepseek-v-4.1-flash-1017", 1_000_000],
    ["deepseek-v4", 1_000_000],
    ["deepseek-chat", 131_072],
    ["gpt-5-mini", 400_000],
    // v7.39: diselaraskan dengan preset 1.05M (nilai nyata ~1.047M).
    ["gpt-4.1", 1_050_000],
    ["gpt-4o", 128_000],
    ["claude-sonnet-4", 200_000],
    ["gemini-2.5-pro", 2_000_000],
    ["qwen3-coder-plus", 262_144],
  ])("keluarga %s → %d token", (model, expected) => {
    expect(findContextWindowFromCatalog(model as string)).toBe(expected)
  })

  // v7.39: jangan sampai katalog & preset operator beds lagi untuk keluarga
  // yang sama — dulu GPT-4.1 1M vs 1.05M (≈5% window terbuang, drift tak
  // terlapor karena guard hanya cek selisih > 2×).
  test("parity katalog↔preset untuk keluarga dengan preset eksplisit", () => {
    const preset = CONTEXT_WINDOW_PRESETS.find((p) => p.examples.includes("GPT-4.1"))
    expect(preset).toBeDefined()
    expect(findContextWindowFromCatalog("gpt-4.1")).toBe(preset!.tokens)
  })

  test("keluarga tak dikenal → undefined", () => {
    expect(findContextWindowFromCatalog("some-unknown-model")).toBeUndefined()
  })

  test("family matches require model boundaries and ignore namespaces", () => {
    expect(findContextWindowFromCatalog("foo3-bar")).toBeUndefined()
    expect(findContextWindowFromCatalog("gpt-5-proxy/unknown")).toBeUndefined()
    expect(findContextWindowFromCatalog("openai/o3-mini")).toBe(200_000)
  })

  test("longest-family menang: deepseek-v4 mengalahkan deepseek", () => {
    expect(findContextWindowFromCatalog("deepseek-v4-flash")).toBe(1_000_000)
  })
})

describe("resolveContextWindow integrasi katalog", () => {
  const cfg = { providers: [] } as unknown as MinicodeConfig

  test("model dikenal tanpa config → source catalog, bukan safe-default 32k", () => {
    const r = resolveContextWindow(cfg, "deepseek-v-4.1-flash-1017")
    expect(r.source).toBe("catalog")
    expect(r.tokens).toBe(1_000_000)
  })

  test("explicit contextWindows tetap menang atas katalog", () => {
    const cfg2 = {
      providers: [
        {
          id: "p",
          models: ["deepseek-v-4.1-flash-1017"],
          contextWindows: { "deepseek-v-4.1-flash-1017": 12345 },
        },
      ],
    } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg2, "p::deepseek-v-4.1-flash-1017")
    expect(r.source).toBe("model")
    expect(r.tokens).toBe(12345)
  })

  test("model tak dikenal tanpa config → safe-default 131072 (bukan 32k)", () => {
    // D1: fallback terakhir dinaikkan ke 131.072. Nilai lama 32.000 lebih kecil
    // dari ambang reklasifikasi 400 (50k), sehingga model berjendela 32k tak
    // pernah bisa menempuh jalur recovery compact-and-retry.
    const r = resolveContextWindow(cfg, "totally-unknown-model")
    expect(r.source).toBe("safe-default")
    expect(r.tokens).toBe(131_072)
  })
})

describe("alias router (auto/best) → default konservatif 128K", () => {
  const cfg = { providers: [] } as unknown as MinicodeConfig

  test("auto → 131072 (bukan 32K) supaya kompaksi tak prematur", () => {
    const r = resolveContextWindow(cfg, "auto")
    expect(r.source).toBe("safe-default")
    expect(r.tokens).toBe(131_072)
  })

  test("best/default/router/cheapest/auto:reasoning juga dianggap alias", () => {
    for (const m of ["best", "default", "router", "cheapest", "auto:reasoning", "auto-extended"]) {
      expect(resolveContextWindow(cfg, m).tokens).toBe(131_072)
    }
  })

  test("bukan alias (mis. 'automotive') memakai fallback 131072", () => {
    expect(resolveContextWindow(cfg, "automotive").tokens).toBe(131_072)
  })

  test("alias tetap bisa ditimpa contextWindows eksplisit", () => {
    const cfg2 = {
      providers: [{ id: "p", models: ["auto"], contextWindows: { auto: 999 } }],
    } as unknown as MinicodeConfig
    const r = resolveContextWindow(cfg2, "p::auto")
    expect(r.source).toBe("model")
    expect(r.tokens).toBe(999)
  })
})

describe("models.dev overlay (context_length)", () => {
  test("extractContextWindows: number & objek context_length", () => {
    const win = extractContextWindows({
      openai: {
        models: {
          "my-model": { id: "my-model", context_length: 123_456 },
          "obj-model": {
            id: "obj-model",
            context_length: { total: 200_000, max_output_tokens: 32_000 },
          },
          "broken-model": { id: "broken-model", context_length: -1 },
        },
      },
    })
    expect(win["my-model"]).toBe(123_456)
    expect(win["obj-model"]).toBe(200_000)
    expect(win["broken-model"]).toBeUndefined()
  })

  test("resolveContextWindow: overlay models.dev dipakai setelah katalog", () => {
    __resetContextWindowOverlay()
    __setContextWindowOverlay({ "niche-model-xyz": 789_000 })
    const r = resolveContextWindow(cfgEmpty, "niche-model-xyz")
    expect(r.source).toBe("models-dev")
    expect(r.tokens).toBe(789_000)
    __resetContextWindowOverlay()
  })

  test("exact metadata beats family guesses while explicit limits still win", () => {
    __setContextWindowOverlay({ "kimi-example": 1_000_000 })
    try {
      expect(resolveContextWindow(cfgEmpty, "kimi-example")).toMatchObject({
        tokens: 1_000_000,
        source: "models-dev",
      })
      expect(resolveContextWindow(cfgEmpty, "kimi-example", 64_000).tokens).toBe(64_000)
      const configured = {
        providers: [
          { id: "p", models: ["kimi-example"], contextWindows: { "kimi-example": 256_000 } },
        ],
      } as unknown as MinicodeConfig
      expect(resolveContextWindow(configured, "p::kimi-example").tokens).toBe(256_000)
    } finally {
      __resetContextWindowOverlay()
    }
  })

  test("findContextWindowFromOverlay: exact & prefiks segmen", () => {
    __setContextWindowOverlay({ "deepseek-v4-flash": 999_999 })
    expect(findContextWindowFromOverlay("deepseek-v4-flash")).toBe(999_999)
    expect(findContextWindowFromOverlay("p::deepseek-v4-flash-free")).toBe(999_999)
    __resetContextWindowOverlay()
  })
})

// F-07: memo per modelId + invalidasi saat overlay dimuat ulang. Resolusi harus
//-identik dengan algoritma lama (oracle di bawah), termasuk hasil `undefined`.
describe("F-07 memo overlay models.dev", () => {
  const oracle = (map: Record<string, number>, model: string): number | undefined => {
    if (!map || Object.keys(map).length === 0) return undefined
    const m = model.toLowerCase()
    if (map[m] !== undefined) return map[m]
    let best: { k: string; v: number } | undefined
    for (const seg of m.split(/[/:]/)) {
      if (!seg) continue
      for (const [k, v] of Object.entries(map)) {
        if (
          seg === k ||
          seg.startsWith(`${k}.`) ||
          seg.startsWith(`${k}-`) ||
          seg.startsWith(`${k}_`)
        ) {
          if (!best || k.length > best.k.length) best = { k, v }
        }
      }
    }
    return best?.v
  }

  test("hasil resolusi identik dengan algoritma lama (miss & hit)", () => {
    const overlay: Record<string, number> = {
      deepseek: 131_072,
      "deepseek-v4-flash": 999_999,
      "qwen3-coder": 262_144,
      "gpt-5-mini.2026": 400_000,
      kimi_k2: 1_000_000,
    }
    __setContextWindowOverlay(overlay)
    try {
      const models = [
        "deepseek",
        "DeepSeek",
        "deepseek-v4-flash",
        "deepseek-v4-flash-free",
        "p::deepseek-v4-flash-free",
        "vendor/deepseek-v4-flash:free",
        "qwen3-coder-plus",
        "gpt-5-mini.2026-preview",
        "kimi_k2-thinking",
        "unknown-model",
        "p::unknown/also-unknown",
        "",
      ]
      for (const model of models) {
        // Panggil dua kali: cache miss lalu cache hit — keduanya harus cocok.
        expect(findContextWindowFromOverlay(model)).toBe(oracle(overlay, model))
        expect(findContextWindowFromOverlay(model)).toBe(oracle(overlay, model))
      }
    } finally {
      __resetContextWindowOverlay()
    }
  })

  test("memo benar-benar melewati scan overlay pada cache hit (bukan hanya hasil sama)", () => {
    const overlay: Record<string, number> = {}
    for (let i = 0; i < 1000; i++) overlay[`model-${i}`] = 131_072
    __setContextWindowOverlay(overlay)
    try {
      __resetOverlayScanCount()
      expect(findContextWindowFromOverlay("model-42")).toBe(131_072)
      expect(__overlayScanCount()).toBe(1)
      for (let i = 0; i < 50; i++) {
        expect(findContextWindowFromOverlay("model-42")).toBe(131_072)
      }
      // Hit langsung return sebelum OBJECT_KEYS/ENTRIES disentuh.
      expect(__overlayScanCount()).toBe(1)

      // Model baru = scan baru; setelah itu stabil lagi.
      expect(findContextWindowFromOverlay("model-77")).toBe(131_072)
      expect(__overlayScanCount()).toBe(2)
    } finally {
      __resetContextWindowOverlay()
    }
  })

  test("memo dibatalkan saat overlay di-set ulang atau di-reset", () => {
    __setContextWindowOverlay({ "model-x": 100_000 })
    expect(findContextWindowFromOverlay("model-x")).toBe(100_000)
    expect(findContextWindowFromOverlay("model-x")).toBe(100_000) // cache hit

    __setContextWindowOverlay({ "model-x": 200_000 })
    expect(findContextWindowFromOverlay("model-x")).toBe(200_000) // nilai baru

    __setContextWindowOverlay({ "model-y": 300_000 })
    expect(findContextWindowFromOverlay("model-x")).toBeUndefined()
    expect(findContextWindowFromOverlay("model-y")).toBe(300_000)

    __resetContextWindowOverlay()
    expect(findContextWindowFromOverlay("model-y")).toBeUndefined()
  })

  test("hasil undefined ikut di-cache lalu ikut dibatalkan saat overlay berubah", () => {
    __setContextWindowOverlay({ known: 50_000 })
    expect(findContextWindowFromOverlay("missing")).toBeUndefined()
    expect(findContextWindowFromOverlay("missing")).toBeUndefined() // hit dari cache undefined
    __setContextWindowOverlay({ missing: 60_000 })
    expect(findContextWindowFromOverlay("missing")).toBe(60_000)
    __resetContextWindowOverlay()
  })
})

const cfgEmpty = { providers: [] } as unknown as MinicodeConfig
