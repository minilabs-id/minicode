// Preset ukuran jendela konteks untuk model yang providernya TIDAK melaporkan
// kapasitas. Tanpa ini, satu-satunya jalan adalah mengedit JSON config manual
// dan menebak angka — padahal salah tebak ke atas berarti request ditolak 400
// di tengah turn, dan salah tebak ke bawah berarti kompaksi prematur.
//
// ── Kenapa preset dan bukan satu angka default ──────────────────────────────
// Riset ukuran produksi (Nov 2026, 448 model terindeks) menunjukkan jendela
// konteks MENGELOMPOK, tidak kontinu. Median ada di 262K, 93% model ≥128K, 71%
// ≥200K, 40% ≥1M. Jadi memberi pilihan kelompok nyata lebih akurat daripada
// memaksa pengguna mengetik angka hasil terkaan.
//
// ── Kenapa ada TIGA varian untuk 1M ─────────────────────────────────────────
// Ini bukan kelebihan. "1M" di dunia nyata adalah tiga angka berbeda:
//   1.000.000   Anthropic (Claude), DeepSeek, xAI, Qwen
//   1.048.576   Google (Gemini), Moonshot (Kimi), Z.ai (GLM)  = 1024×1024
//   1.050.000   OpenAI (GPT-4.1/5.x/6.x)
// Selisihnya sampai ~50K token. Memilih yang salah membuat calon pemakai
// kehilangan ~5% jendela (kompaksi terlalu cepat) atau melampaui batas asli
// (request ditolak). Karena itu ketiganya diberi nama sendiri.
//
// ── Kenapa `auto` tetap default ─────────────────────────────────────────────
// Perilaku sekarang (metadata endpoint → config → katalog → models.dev →
// fallback konservatif) sudah benar dan tidak boleh berubah diam-diam. `auto`
// berarti "pakai rantai itu"; preset hanya dipakai bila pengguna MEMILIH.

/** Satu preset bernama: nilai eksak + label ringkas untuk UI. */
export interface ContextWindowPreset {
  /** Token eksak yang dipakai sebagai nilai jendela. */
  readonly tokens: number
  /** Label pendek yang ditampilkan di picker (mis. `200K`). */
  readonly label: string
  /** Model/penyedia yang biasanya memakai angka ini — membantu pengguna
   * memilih tanpa menghafal, mis. `128K` → GPT-4o, Llama 3.x, Mistral. */
  readonly examples: string
}

/**
 * Preset terurut menaik. Nilai TIDAK boleh diubah tanpa alasan kuat: setiap
 * angka di sini adalah ukuran yang benar-benar dipakai minimal satu model
 * produksi (diverifikasi dari dokumentasi penyedia, Nov 2026).
 */
export const CONTEXT_WINDOW_PRESETS: readonly ContextWindowPreset[] = [
  { tokens: 16_384, label: "16K", examples: "GPT-4o mini (output), Phi-4" },
  { tokens: 32_768, label: "32K", examples: "model kecil/legacy" },
  { tokens: 65_536, label: "64K", examples: "Gemini max output, Qwen3 kecil" },
  { tokens: 131_072, label: "128K", examples: "GPT-4o, Llama 3.x, Mistral Large 2" },
  { tokens: 200_000, label: "200K", examples: "Claude Haiku 4.5, OpenAI o3/o4-mini" },
  { tokens: 262_144, label: "256K", examples: "Kimi K2.x, Grok 4, Mistral Large 3" },
  { tokens: 400_000, label: "400K", examples: "GPT-5 / GPT-5 mini" },
  { tokens: 500_000, label: "500K", examples: "Grok 4.5–4.7" },
  { tokens: 1_000_000, label: "1M", examples: "Claude 5.x, DeepSeek V4, Qwen3.x Max" },
  { tokens: 1_048_576, label: "1M (1024²)", examples: "Gemini, Kimi K3, GLM 5.x" },
  { tokens: 1_050_000, label: "1.05M", examples: "OpenAI GPT-4.1 / 5.x / 6.x" },
  { tokens: 2_000_000, label: "2M", examples: "Grok 4.20, Gemini 1.5 Pro (lama)" },
  { tokens: 4_000_000, label: "4M", examples: "Groq Kimi/GPT-OSS (host besar)" },
  { tokens: 10_000_000, label: "10M", examples: "Llama 4 Scout" },
] as const

/** Nilai `auto`: pakai rantai resolusi normal (bukan angka). */
export const CONTEXT_WINDOW_AUTO = "auto"

/**
 * Normalisasi masukan pengguna menjadi token eksak, atau `undefined` bila
 * masukan berarti "auto" / tidak dikenali.
 *
 * Menerima:
 *   - nama preset: `128k`, `1M`, `1024x1024`, `1.05m`
 *   - angka biasa: `131072`, `131_072`, `131 072`
 *   - singkatan: `128k`, `128K`, `1.5m`
 *
 * KENAPA banyak bentuk: pengguna menulis apa yang ia ingat dari dokumentasi
 * penyedia. Menolak `128k` karena harus `131072` hanya memindahkan pekerjaan
 * mengetik ke pekerjaan membaca error.
 */
export function parseContextWindowInput(input: string): number | undefined {
  const raw = input.trim().toLowerCase()
  if (!raw || raw === CONTEXT_WINDOW_AUTO) return undefined

  // Bentuk khusus `1024x1024` / `1024*1024` → nilai Gemini/Kimi (1048576).
  const product = /^(\d+(?:[._]\d+)?)\s*[x*]\s*(\d+(?:[._]\d+)?)$/.exec(raw)
  if (product) {
    const a = Number(product[1]!.replace(/[._]/g, ""))
    const b = Number(product[2]!.replace(/[._]/g, ""))
    const value = a * b
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }

  // Bentuk singkat `128k`, `1m`, `1.5m`, `1.05m`.
  const scaled = /^(\d+(?:\.\d+)?)\s*([km])$/.exec(raw)
  if (scaled) {
    // Desimal diperlakukan sebagai PECAHAN (`1.5m` = 1,5 juta), bukan pemisah
    // ribuan. Sebelumnya nilai desimal dibersihkan dari titiknya lebih dulu,
    // sehingga `1.05m` dihitung sebagai 105 × 1e6 ÷ 100 — kebetulan benar,
    // tetapi bergantung pada matematika yang tak terucap. `Number()` langsung
    // membaca bentuk desimal sesuai maksud pengguna.
    const base = Number(scaled[1])
    const mult = scaled[2] === "k" ? 1_000 : 1_000_000
    const value = Math.round(base * mult)
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }

  // Angka biasa dengan pemisah ribuan/underscore/spasi.
  //
  // KENAPA pola ditulis ketat: sebelumnya `[\d._\s]*` menerima `1.2.3` dan
  // diam-diam menghasilkan 123. Salah ketik harus DITOLAK, bukan ditebak —
  // jendela 123 token akan membuat setiap turn langsung dikompaksi dan
  // penyebabnya tak terlihat dari pesan apa pun. Bentuk sah yang diterima:
  // `131072`, `131 072`, `131_072`, `131.072` (satu pemisah, bukan beruntun).
  const plain = /^\d{1,3}(?:[._ ]\d{3})+$|^\d+$/.test(raw)
    ? Number(raw.replace(/[._\s]/g, ""))
    : Number.NaN
  if (Number.isSafeInteger(plain) && plain > 0) return plain
  return undefined
}

/**
 * Cari preset yang nilainya sama persis (untuk menampilkan label di UI).
 * Mengembalikan undefined untuk nilai manual yang tidak termasuk preset.
 */
export function findPresetByTokens(tokens: number): ContextWindowPreset | undefined {
  return CONTEXT_WINDOW_PRESETS.find((p) => p.tokens === tokens)
}

/**
 * Label ringkas untuk sebuah nilai jendela, mis. `128K`, `1M (1024²)`, atau
 * `~137K` untuk nilai manual. Dipakai footer/`/status`/picker.
 */
export function describeContextWindow(tokens: number): string {
  const preset = findPresetByTokens(tokens)
  if (preset) return preset.label
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
  return `${Math.round(tokens / 1_000)}K`
}

/**
 * Daftar pilihan untuk picker UI. `auto` selalu baris pertama karena itu
 * perilaku default: pengguna yang tidak memilih tidak berubah apa pun.
 *
 * Baris `auto` sengaja TIDAK menyertakan angka: nilai aktualnya baru diketahui
 * saat resolusi berjalan (bisa dari endpoint, katalog, atau fallback). Menulis
 * angka di sini akan berbohong untuk sebagian model.
 */
export function contextWindowChoices(): readonly { value: string; label: string; hint: string }[] {
  return [
    {
      value: CONTEXT_WINDOW_AUTO,
      label: "auto",
      hint: "deteksi otomatis (endpoint → config → katalog → models.dev → fallback)",
    },
    ...CONTEXT_WINDOW_PRESETS.map((p) => ({
      value: String(p.tokens),
      label: p.label,
      hint: p.examples,
    })),
  ]
}

/**
 * Apakah nilai ini tampak seperti jendela yang masuk akal. Batas atas 20 juta
 * sama dengan `validWindow` di context-window.ts (Llama 4 Scout = 10M, jadi 20M
 * memberi ruang), dan batas bawah 1.000 menolak salah ketik seperti `128`.
 */
export function isValidContextWindowValue(tokens: number): boolean {
  return Number.isSafeInteger(tokens) && tokens >= 1_000 && tokens <= 20_000_000
}
