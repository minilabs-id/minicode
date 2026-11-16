import { readFile } from "node:fs/promises"
import type { ContextWindowSource, MinicodeConfig } from "../config.ts"
import { findContextWindowFromCatalog } from "./context-window-catalog.ts"
import { contextWindowsCachePath } from "./pricing.ts"

/** App fallback for providers that do not publish model metadata.
 * Operators can set an exact `ProviderEntry.contextWindows` value or use the
 * explicit `--context-window` override when a gateway exposes aliases.
 *
 * KENAPA 131.072 dan bukan 32.000: nilai lama 32k lebih kecil dari ambang
 * reklasifikasi 400 (50k), sehingga model yang jendelanya benar-benar 32k
 * TIDAK PERNAH bisa menempuh jalur recovery `compact-and-retry` — jendelanya
 * penuh jauh sebelum ambangnya tercapai. Nilai ini juga di atas ukuran jendela
 * model yang beredar luas (≥128k), jadi model tak dikenal tidak dikompaksi
 * prematur. Nilai eksak tetap menang bila endpoint/operator memberikannya. */
export const DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS = 131_072

// Alias router (`auto`/`best`/...) model aslinya tak diketahui dari config.
// Default konservatif 128K (bukan 32K) supaya kompaksi tidak prematur; bila
// aktual lebih besar (mis. 1M), jalur recovery 400→compact-and-retry tetap
// menyelamatkan. User bisa set `provider.contextWindows` untuk nilai eksak.
export const DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS = 131_072
const ROUTER_ALIAS_RE = /^(auto|best|default|cheapest|router)([:_-]|$)/i

export interface ContextWindowResolution {
  readonly tokens: number
  readonly source:
    | "override"
    | "model"
    | "provider-default"
    | "catalog"
    | "models-dev"
    | "safe-default"
  /** Asal nilai per lapis ketika config menyimpannya (`user`/`endpoint`/`probe`/
   * `public-directory`/`static-table`). Murni diagnostik: UI memakainya untuk
   * menyatakan apakah angka ini niat operator atau hasil temuan otomatis. */
  readonly origin?: ContextWindowSource
  readonly model?: string
  readonly providerId?: string
  /** R9/T8 — hadir bila katalog built-in dan overlay models.dev saling beda
   * >2× (katalog mungkin ketinggalan zaman). Murni diagnostik: pemanggil boleh
   * memperingatkan user; metadata model eksak diutamakan atas tebakan keluarga. */
  readonly drift?: { catalogTokens: number; overlayTokens: number }
}

function validWindow(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 20_000_000
  )
}

// ── Overlay models.dev (jendela konteks) ────────────────────────────────────
// Diisi dari cache `context-windows.json` saat startup (sync sekali lewat
// `minicode pricing sync`). Bukan sumber wajib — hanya memperluas cakupan di
// luar katalog built-in. State dimuat async lalu dibaca sinkron di bawah.

let contextWindowOverlay: Record<string, number> | null = null

/** Reset state modul — untuk test hermetic. */
export function __resetContextWindowOverlay(): void {
  contextWindowOverlay = null
}

/** Suntik overlay — untuk test (jalur produksi lewat loadContextWindowOverlay). */
export function __setContextWindowOverlay(map: Record<string, number> | null): void {
  contextWindowOverlay = map
}

/** Muat cache jendela konteks dari disk (sekali per proses). */
export async function loadContextWindowOverlay(): Promise<Record<string, number>> {
  if (contextWindowOverlay) return contextWindowOverlay
  try {
    const raw = await readFile(contextWindowsCachePath(), "utf8")
    const parsed = JSON.parse(raw) as { models?: Record<string, unknown> }
    if (parsed && typeof parsed.models === "object" && parsed.models) {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed.models)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0)
          out[k.toLowerCase()] = Math.floor(v)
      }
      contextWindowOverlay = out
      return out
    }
  } catch {
    // tak ada cache = normal
  }
  contextWindowOverlay = {}
  return contextWindowOverlay
}

/** Cari jendela konteks dari overlay models.dev (sinkron, setelah dimuat). */
export function findContextWindowFromOverlay(model: string): number | undefined {
  const map = contextWindowOverlay
  if (!map || Object.keys(map).length === 0) return undefined
  const m = model.toLowerCase()
  if (map[m] !== undefined) return map[m]
  // Segmen (pemisah `/`/`:`) dicocokkan dengan kunci overlay sebagai prefiks —
  // pola sama dengan findPrice sehingga `deepseek-v4-flash` menang atas `deepseek`.
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

/**
 * Nilai jendela yang ditulis operator SELAMA proses berjalan (in-process
 * registry di bawah). Dipisah dari `config` karena `cli/setup.ts` menangkap
 * config sekali di awal; tanpa lapis ini setiap setelan baru butuh restart.
 */
const liveUserWindows = new Map<string, number>()
/**
 * Pasangan yang operator-nya MEMILIH `auto`. Nilai `null` sengaja dipakai
 * sebagai penanda, bukan penghapusan entri: config snapshot muat menahan angka
 * lama (dibaca saat start), jadi menghapus entri live saja membuat angka basi
 * itu muncul kembali — `auto` lalu tampak "balik ke nilai lama" alih-alih ke
 * deteksi otomatis.
 */
const liveAutoClears = new Set<string>()

/** Catat pilihan operator untuk sesi yang sedang berjalan. */
export function setLiveContextWindow(providerId: string, model: string, tokens: number): void {
  const key = `${providerId}::${model}`
  liveAutoClears.delete(key)
  liveUserWindows.set(key, tokens)
}

/** Hapus pilihan operator (`auto`) — resolusi kembali ke rantai normal. */
export function clearLiveContextWindow(providerId: string, model: string): void {
  const key = `${providerId}::${model}`
  liveUserWindows.delete(key)
  liveAutoClears.add(key)
}

/** Reset seluruh registry (test saja). */
export function __resetLiveContextWindows(): void {
  liveUserWindows.clear()
  liveAutoClears.clear()
}

/** `"cleared"` = operator baru saja memilih `auto`; angka di config snapshot
 * harus DILEWATI (bukan dipakai) selama proses ini hidup. */
type LiveOverlay = ContextWindowResolution | "cleared" | undefined

function readLiveWindowOverlay(model: string): LiveOverlay {
  const sep = model.indexOf("::")
  if (sep === -1) return undefined
  const providerId = model.slice(0, sep)
  const modelId = model.slice(sep + 2)
  if (liveAutoClears.has(`${providerId}::${modelId}`)) return "cleared"
  const tokens = liveUserWindows.get(`${providerId}::${modelId}`)
  if (!validWindow(tokens)) return undefined
  return { tokens, source: "model", origin: "user", model: modelId, providerId }
}

/**
 * Lanjutkan rantai resolusi TANPA nilai `contextWindows` di config.
 *
 * Dipakai saat operator memilih `auto` selama sesi hidup: aturan "auto" adalah
 * kembali ke deteksi otomatis, bukan ke angka yang kebetulan masih tersimpan di
 * objek config yang sudah dibaca di awal. Bila `auto` juga sedang tertulis di
 * disk (sesi baru), fungsi ini tidak dipanggil sama sekali — hasilnya identik.
 */
function resolveIgnoringConfigWindows(
  config: MinicodeConfig,
  model?: string,
): ContextWindowResolution {
  const stripped: MinicodeConfig = {
    ...config,
    providers: config.providers.map((p) => {
      const { contextWindows: _w, contextWindowSources: _s, ...rest } = p
      return rest
    }),
  }
  // `ignoreLive` WAJIB: tanpa penanda ini, cabang `cleared` di pemanggilan
  // rekursif membaca kunci yang sama dan memanggil fungsi ini lagi — rekursi
  // tak berujung (satu sesi `auto` langsung menggantung tanpa stack overflow
  // karena Bun hanya menumpuk frame sampai memori habis).
  return resolveContextWindow(stripped, model, undefined, true)
}

/** Resolve a budget in the same order as the router: explicit provider pin,
 * then first provider advertising a bare model, then the provider fallback.
 * Unknown aliases use a conservative budget and remain visible to callers. */
export function resolveContextWindow(
  config: MinicodeConfig,
  model?: string,
  override?: number,
  /** Internal: lewati overlay live (dipakai `resolveIgnoringConfigWindows`). */
  ignoreLive = false,
): ContextWindowResolution {
  if (validWindow(override))
    return { tokens: override, source: "override", ...(model ? { model } : {}) }
  // Nilai operator yang BARU ditulis (`/context`, `config context-window`)
  // menang atas snapshot `config` yang dibekukan saat sesi start: sesi hidup
  // harus langsung memakai pilihan yang baru saja dibuat. Tanpa lapis ini
  // perintah "set 200k" tampak sukses tapi turn berikutnya tetap memakai angka
  // lama sampai restart — persis keluhan "fitur ini tidak berefek".
  const live = model && !ignoreLive ? readLiveWindowOverlay(model) : undefined
  if (live === "cleared") return resolveIgnoringConfigWindows(config, model)
  if (live) return live

  let providerId: string | undefined
  let modelId = model
  let provider = undefined as MinicodeConfig["providers"][number] | undefined
  if (model?.includes("::")) {
    const sep = model.indexOf("::")
    providerId = model.slice(0, sep)
    modelId = model.slice(sep + 2)
    provider = config.providers.find((entry) => entry.id === providerId)
  } else if (model) {
    provider = config.providers.find((entry) => entry.models?.includes(model))
    providerId = provider?.id
  } else {
    provider = config.providers[0]
    providerId = provider?.id
    modelId = provider?.models?.[0]
  }

  const exact = modelId ? provider?.contextWindows?.[modelId] : undefined
  if (validWindow(exact)) {
    return {
      tokens: exact,
      source: "model",
      origin: (modelId ? provider?.contextWindowSources?.[modelId] : undefined) ?? "user",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  const providerDefault = provider?.contextWindows?.["*"]
  if (validWindow(providerDefault)) {
    return {
      tokens: providerDefault,
      source: "provider-default",
      origin: provider?.contextWindowSources?.["*"] ?? "user",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  // Exact public metadata is more specific than a family-wide catalog guess.
  // Explicit endpoint/operator limits above always retain precedence.
  if (modelId) {
    const exactOverlay = contextWindowOverlay?.[modelId.toLowerCase()]
    if (validWindow(exactOverlay)) {
      const catalogTokens = findContextWindowFromCatalog(modelId)
      const drift = validWindow(catalogTokens)
        ? Math.max(exactOverlay / catalogTokens, catalogTokens / exactOverlay)
        : 0
      return {
        tokens: exactOverlay,
        source: "models-dev",
        model: modelId,
        ...(providerId ? { providerId } : {}),
        ...(drift > 2
          ? { drift: { catalogTokens: catalogTokens!, overlayTokens: exactOverlay } }
          : {}),
      }
    }
    const catalogTokens = findContextWindowFromCatalog(modelId)
    if (validWindow(catalogTokens)) {
      // R9/T8 — katalog diutamakan (kurasi manual) tapi bisa basi. Bila overlay
      // models.dev (cache dari `pricing sync`) punya nilai > 2× beda, tandai
      // drift supaya setup memperingatkan user — resolusi tetap katalog (aman:
      // over-estimate turun anggun via compact-and-retry).
      const overlayTokens = findContextWindowFromOverlay(modelId)
      const drift =
        validWindow(overlayTokens) && catalogTokens > 0
          ? Math.max(overlayTokens / catalogTokens, catalogTokens / overlayTokens)
          : 0
      return {
        tokens: catalogTokens,
        source: "catalog",
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
        ...(drift > 2 ? { drift: { catalogTokens, overlayTokens: overlayTokens as number } } : {}),
      }
    }
  }
  // Overlay models.dev (bila user pernah `minicode pricing sync`): mencakup
  // model long-tail di luar katalog built-in. Dibawah katalog karena katalog
  // dikurasi manual dan tak bergantung pada cache yang bisa kedaluwarsa.
  if (modelId) {
    const overlayTokens = findContextWindowFromOverlay(modelId)
    if (validWindow(overlayTokens)) {
      return {
        tokens: overlayTokens,
        source: "models-dev",
        ...(modelId ? { model: modelId } : {}),
        ...(providerId ? { providerId } : {}),
      }
    }
  }
  // Alias router (`auto`, `best`, ...) — model asli tak dapat dipastikan tanpa
  // konfigurasi. Pakai default konservatif 128K (bukan 32K) agar kompaksi tak
  // prematur; sumber tetap "safe-default" supaya warning di cli/setup.ts tetap
  // menyala dan meminta user set nilai eksak.
  if (modelId && ROUTER_ALIAS_RE.test(modelId)) {
    return {
      tokens: DEFAULT_ALIAS_CONTEXT_WINDOW_TOKENS,
      source: "safe-default",
      ...(modelId ? { model: modelId } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }
  return {
    tokens: DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS,
    source: "safe-default",
    ...(modelId ? { model: modelId } : {}),
    ...(providerId ? { providerId } : {}),
  }
}
