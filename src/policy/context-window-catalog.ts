// Katalog jendela konteks built-in (offline, tanpa fetch) — jaring pengaman
// saat `provider.contextWindows` tidak dikonfigurasi. Menjawab keluhan "model
// sudah dipilih tapi jendela konteks jatuh ke fallback 32k".
//
// Desain: pencocokan per-KELUARGA pada id model (bukan persis), karena context
// window hampir selalu sama dalam satu keluarga (semua GPT-5, semua Claude-4,
// dst). Longest-family-menang supaya `deepseek-v4` mengalahkan `deepseek`.
//
// Nilai SENGAJA generous ke atas: over-estimasi menurun WP dengan anggun lewat
// jalur recovery provider `context_length_exceeded → compact-and-retry`,
// sedangkan under-estimasi justru memicu pemotongan dini ("context window
// exceeded") yang sedang kita hilangkan. Bila salah, user bisa menimpa lewat
// `provider.contextWindows` atau `--context-window` (selalu lebih diutamakan).

export interface ContextWindowCatalogEntry {
  /** Substring pencocokan pada id model yang sudah dinormalisasi (lowercase). */
  family: string
  /** Jendela konteks dalam token. */
  tokens: number
}

const CONTEXT_WINDOW_CATALOG: ContextWindowCatalogEntry[] = [
  { family: "deepseek-v4", tokens: 1_000_000 },
  { family: "deepseek-v3.2", tokens: 1_000_000 },
  { family: "deepseek", tokens: 131_072 },
  // v7.39: GPT-4.1 = 1_047_576 token nyata ≈ 1.05M. Catalog dulu 1_000_000
  // (rounded-down) sementara preset operator 1_050_000 → keduanya kini sama,
  // menghilangkan ~5% under-use (kompaksi terlalu awal) & drift yang tak
  // pernah terlapor karena guard hanya memeriksa selisih > 2×.
  { family: "gpt-4.1", tokens: 1_050_000 },
  { family: "gpt-5", tokens: 400_000 },
  { family: "gpt-4o", tokens: 128_000 },
  { family: "gpt-4", tokens: 128_000 },
  { family: "o3", tokens: 200_000 },
  { family: "o1", tokens: 200_000 },
  { family: "claude", tokens: 200_000 },
  { family: "gemini", tokens: 2_000_000 },
  { family: "llama-4", tokens: 1_000_000 },
  { family: "llama", tokens: 131_072 },
  { family: "qwen3", tokens: 262_144 },
  { family: "qwen", tokens: 131_072 },
  { family: "mistral", tokens: 131_072 },
  { family: "grok", tokens: 131_072 },
  { family: "glm", tokens: 131_072 },
  { family: "kimi", tokens: 131_072 },
  { family: "moonshot", tokens: 131_072 },
]

/**
 * Normalisasi id model supaya tanda baca versi tak menggagalkan pencocokan:
 * `deepseek-v-4.1-flash-1017` → `deepseek-v4.1-flash-1017` (dash setelah
 * `v` dihapus), sehingga cocok dengan keluarga `deepseek-v4`.
 */
export function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/v-/g, "v")
}

/** Jendela konteks dari katalog, atau undefined bila keluarga tak dikenal. */
export function findContextWindowFromCatalog(model: string): number | undefined {
  const m = normalizeModelId(model)
  let best: ContextWindowCatalogEntry | undefined
  for (const entry of CONTEXT_WINDOW_CATALOG) {
    const leaf = m.split(/[/:]/).at(-1) ?? m
    const suffix = leaf.slice(entry.family.length)
    const matches = leaf.startsWith(entry.family) && (suffix === "" || /^[._-]/.test(suffix))
    if (matches && (!best || entry.family.length > best.family.length)) {
      best = entry
    }
  }
  return best?.tokens
}
