// Provisioning provider: deteksi model, simpan/hapus/sinkron entri provider.
// Dipisah dari src/config.ts supaya lapisan config murni IO (baca/tulis/validasi
// berkas) dan tidak bergantung ke providers/ — arah dependensi jadi satu arah:
// providers → config.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type ContextWindowSource,
  globalConfigPath,
  LOCAL,
  loadConfig,
  type MinicodeConfig,
  normalizeConfig,
  type ProviderEntry,
  updateConfigAtomic,
  withConfigLock,
  writeConfigAtomic,
} from "../config.ts"
import { getSecret } from "../lib/keystore.ts"
import { clearDetectCache, type DetectResult, detectModels } from "./detect.ts"

/**
 * Selesaikan apiKey untuk deteksi model: referensi `keystore:<nama>` menjadi
 * secret OS, sisanya lewat apa adanya. Return null bila entri keystore
 * hilang/tak terbaca — pemanggil harus mencatat failed yang actionable,
 * JANGAN mengirim literal "keystore:..." sebagai Bearer (401 diam-diam).
 */
export async function resolveDetectApiKey(apiKey: string): Promise<string | null> {
  if (!apiKey.startsWith("keystore:")) return apiKey
  return getSecret(apiKey.slice("keystore:".length)).catch(() => null)
}

export async function saveProvider(
  entry: ProviderEntry,
  opts: { global?: boolean; cwd?: string } = {},
) {
  // Provider OAuth sengaja TIDAK butuh apiKey: tokennya hidup di auth.json.
  const needsKey = entry.auth !== "oauth"
  if (!entry.id || !entry.baseUrl || (needsKey && !entry.apiKey))
    throw new Error("provider id/baseUrl/apiKey required")
  // Entri baru menang mutlak agar perintah `auto` bisa menghapus kunci jendela sebelumnya.
  return updateConfigAtomic(opts, (cfg) => {
    const idx = cfg.providers.findIndex((p) => p.id === entry.id)
    if (idx >= 0) cfg.providers[idx] = { ...entry }
    else cfg.providers.push(entry)
  })
}

// 5.1 — id ramah: pakai id eksplisit bila ada, atau slug baseUrl; dedupe
// dengan indeks numerik, BUKAN hash acak.
export function deriveProviderId(baseUrl: string, existingIds: string[], id?: string): string {
  let baseId: string
  if (id) {
    baseId = id
  } else {
    const norm = baseUrl.replace(/\/+$/, "")
    baseId =
      norm
        .replace(/\/v1$/i, "") // OpenAI-compatible gateways: buang akhiran /v1
        .replace(/https?:\/\//, "")
        .replace(/[^a-z0-9]/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24) || "gateway"
  }
  let uniqId = baseId.slice(0, 30)
  if (!id) {
    let n = 2
    while (existingIds.includes(uniqId)) {
      uniqId = `${baseId}-${n}`.slice(0, 30)
      n++
    }
  }
  return uniqId
}

/**
 * Gabungkan metadata kapasitas yang DITEMUKAN endpoint ke entri provider.
 *
 * Aturan presedensi (alasannya sama dengan `resolveContextWindow`):
 * - Nilai ber-`source: "user"` milik operator TIDAK PERNAH ditimpa. Config lama
 *   tanpa catatan asal diperlakukan `user` supaya perilaku tidak berubah diam-diam.
 * - Nilai `endpoint`/`probe` boleh diperbarui oleh deteksi berikutnya — endpoint
 *   yang dipanggil hari ini lebih tahu daripada hasil deteksi kemarin.
 * - Model yang hilang dari `/models` (sudah tak ada) dibuang agar config tidak
 *   mengumpulkan nilai basi untuk model yang tak bisa dipakai lagi.
 *
 * Diekspor untuk test: ini satu-satunya tempat yang menentukan "siapa menang".
 */
export function mergeDiscoveredCapacity(
  previous: ProviderEntry | undefined,
  detected: DetectResult,
): Pick<
  ProviderEntry,
  "contextWindows" | "contextWindowSources" | "maxOutputTokens" | "enablePromptCaching"
> {
  const metadata = detected.modelMetadata
  if (!metadata || Object.keys(metadata).length === 0) return {}
  const prevWindows = previous?.contextWindows ?? {}
  const prevSources = previous?.contextWindowSources ?? {}
  const prevMaxOut = previous?.maxOutputTokens ?? {}
  const windows: Record<string, number> = {}
  const sources: Record<string, ContextWindowSource> = {}
  const maxOut: Record<string, number> = {}
  for (const [model, meta] of Object.entries(metadata)) {
    // Buang entri untuk model yang tak lagi ditawarkan endpoint (basi).
    // Model di luar metadata tetap dipertahankan dari config lama di bawah.
    const prevSource = prevSources[model]
    const userOwned =
      prevSource === undefined ? prevWindows[model] !== undefined : prevSource === "user"
    if (meta.contextLength !== undefined && !userOwned) {
      windows[model] = meta.contextLength
      sources[model] = "endpoint"
    }
    if (meta.maxOutputTokens !== undefined) maxOut[model] = meta.maxOutputTokens
  }
  // Pertahankan yang tak dilaporkan endpoint kali ini (endpoint bisa parsial:
  // sebagian gateway hanya menyertakan kapasitas untuk model yang baru
  // ditambahkan). `live` hanya dipakai untuk membuang model yang endpoint
  // TIDAK menawarkan lagi — bukan untuk membuang nilai yang belum dilaporkan.
  const live = new Set(detected.models)
  for (const [model, tokens] of Object.entries(prevWindows)) {
    if (live.size > 0 && !live.has(model)) continue
    if (windows[model] === undefined) {
      windows[model] = tokens
      sources[model] = prevSources[model] ?? "user"
    }
  }
  for (const [model, tokens] of Object.entries(prevMaxOut)) {
    if (live.size > 0 && !live.has(model)) continue
    if (maxOut[model] === undefined) maxOut[model] = tokens
  }
  // Fase 7.1: satu model mendukung = provider mendukung; false bila semua menolak.
  let caching: boolean | undefined
  for (const meta of Object.values(metadata)) {
    if (meta.promptCaching === true) {
      caching = true
      break
    }
    if (meta.promptCaching === false) caching ??= false
  }

  return {
    ...(Object.keys(windows).length > 0 ? { contextWindows: windows } : {}),
    ...(Object.keys(sources).length > 0 ? { contextWindowSources: sources } : {}),
    ...(Object.keys(maxOut).length > 0 ? { maxOutputTokens: maxOut } : {}),
    ...(caching !== undefined ? { enablePromptCaching: caching } : {}),
  }
}

export async function detectAndSave(
  baseUrl: string,
  apiKey: string,
  id?: string,
  opts: {
    global?: boolean
    cwd?: string
    fallbackModels?: string[]
    allowLocal?: boolean
    signal?: AbortSignal
    /** Tolak endpoint yang tidak terjangkau jaringan (DNS/ECONNREFUSED/timeout)
     * alih-alih menyimpan daftar fallback diam-diam (dipakai wizard & /provider add). */
    rejectUnreachable?: boolean
  } = {},
): Promise<ProviderEntry> {
  // Fallback model dipakai bila provider tidak punya endpoint GET /models
  // (mis. Anthropic) atau deteksi gagal karena JARINGAN — agar wizard tetap
  // berhasil. Key SALAH (401/403) bukan alasan fallback: menyimpannya dengan
  // daftar palsu membuat auth gagal baru ketahuan saat inferensi.
  // Cache 30 menit juga dibuang dulu: retry add dengan key terkoreksi harus
  // re-fetch, bukan menyajikan daftar basi dari percobaan sebelumnya.
  clearDetectCache()
  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
  let detected: DetectResult
  try {
    detected = await detectModels(baseUrl, apiKey, opts.signal)
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
    if (detected.models.length === 0 && !detected.authFailed && opts.fallbackModels?.length) {
      detected = {
        models: opts.fallbackModels,
        providerHint: detected.providerHint,
        authFailed: false,
      }
    }
  } catch (e) {
    if (opts.signal?.aborted || (e as { name?: string })?.name === "AbortError") {
      throw new DOMException("aborted", "AbortError")
    }
    if (opts.rejectUnreachable && e instanceof Error && e.message.startsWith("unreachable:")) {
      throw e
    }
    if (!opts.fallbackModels) throw e
    const hint = baseUrl.includes("anthropic")
      ? "anthropic"
      : baseUrl.includes("deepseek")
        ? "unknown"
        : "unknown"
    detected = {
      models: opts.fallbackModels,
      providerHint: hint as "openai" | "anthropic" | "responses" | "unknown",
      authFailed: false,
    }
  }
  // Key ditolak server (401/403): gagal keras dengan pesan actionable.
  // Menyimpan dengan fallback di sini = "Saved (3 models)" palsu yang baru
  // ketahuan saat inferensi — temuan audit yang sedang diperbaiki.
  if (detected.models.length === 0 && detected.authFailed) {
    throw new Error(
      `unauthorized: ${baseUrl} menolak API key (401/403) — periksa key, provider tidak disimpan`,
    )
  }
  // dedup id: id ramah via preset/slug, tanpa hash acak (lihat deriveProviderId)
  const prevCfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocal })
  const existing = prevCfg.providers.map((p) => p.id)
  const uniqId = deriveProviderId(baseUrl, existing, id)
  // Pertahankan knob user (thinking effort) bila provider sudah ada — tanpa
  // ini tiap add/edit me-reset effort ke default diam-diam ("hilang").
  const previous = prevCfg.providers.find((p) => p.id === uniqId)
  const prevEffort = previous?.reasoningEffort
  // Kapasitas dari metadata endpoint (bila dilaporkan) diutamakan atas tebakan
  // statis, tapi tak pernah menimpa nilai `user` — lihat mergeDiscoveredCapacity.
  const capacity = mergeDiscoveredCapacity(previous, detected)
  const entry: ProviderEntry = {
    id: uniqId,
    baseUrl,
    apiKey,
    models: detected.models,
    providerHint: detected.providerHint,
    ...(previous?.contextWindows ? { contextWindows: previous.contextWindows } : {}),
    ...capacity,
    ...(prevEffort ? { reasoningEffort: prevEffort } : {}),
  }
  await saveProvider(entry, opts)
  return entry
}

export async function removeProvider(id: string, opts: { global?: boolean; cwd?: string } = {}) {
  return updateConfigAtomic(opts, (cfg) => {
    cfg.providers = cfg.providers.filter((p) => p.id !== id)
  })
}

// Re-detect models untuk provider yang ada (model baru otomatis tersinkron).
// Tidak menyentuh apiKey/baseUrl — hanya memperbarui daftar models.
// Membaca MERGED config (local prioritas atas global) dan menulis kembali ke
// KEDUA file tempat provider ternyata disimpan — mirip perilaku loadConfig,
// sehingga `/sync` bekerja walau provider disimpan di local (bukan global).
export interface SyncResult {
  updated: { id: string; from: number; to: number }[]
  /** Provider yang gagal total (network/timeout) — bedakan dari "tak ada
   * perubahan" agar /sync jujur. Catatan: 401/403 dari /models ditelan
   * detectModels sebagai "kosong" (Anthropic memang tak punya endpoint itu),
   * jadi daftar ini hanya untuk kegagalan transport dan keystore yang hilang
   * (keduanya butuh aksi operator), bukan vonis auth. */
  failed: { id: string; reason: string }[]
}

export async function refreshProviderModels(
  opts: { global?: boolean; cwd?: string; allowLocal?: boolean; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  // /sync harus benar-benar re-fetch — tanpa ini detectModels menyajikan cache
  // 30 menit dan /sync menjadi no-op ("from == to") padahal provider punya
  // model baru.
  clearDetectCache()
  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
  const merged = await loadConfig(opts.cwd, { allowLocal: opts.allowLocal })
  const providers: ProviderEntry[] = merged.providers
  if (providers.length === 0 && (opts.global ?? true)) {
    // tidak ada provider di merge — coba file global secara eksplisit
    const g = await readFile(globalConfigPath(), "utf8")
      .then((raw) => normalizeConfig(JSON.parse(raw)).providers)
      .catch(() => [])
    providers.push(...g)
  }
  if (providers.length === 0) return { updated: [], failed: [] }

  const updated = new Map<string, ProviderEntry>()
  const failed: { id: string; reason: string }[] = []
  for (let i = 0; i < providers.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const p = providers[i]!
    if (!p.apiKey || !p.baseUrl) continue
    // Selesaikan referensi keystore SEBELUM deteksi (sama seperti
    // buildProviderListAsync): tanpa ini literal "keystore:..." terkirim
    // sebagai Bearer → 401 → [] → sync diam-diam no-op selamanya — tak masuk
    // updated maupun failed, dan daftar model tak pernah tersinkron.
    const apiKey = await resolveDetectApiKey(p.apiKey)
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
    if (apiKey == null) {
      failed.push({
        id: p.id,
        reason: `keystore entry missing/unreadable — run: minicode config set-key ${p.id}`.slice(
          0,
          120,
        ),
      })
      continue
    }
    try {
      const detected = await detectModels(p.baseUrl, apiKey, opts.signal)
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError")
      if (detected.models.length) {
        // Metadata kapasitas ikut disegarkan: gateway yang menambah/mengubah
        // model akan memperbarui jendela konteksnya tanpa user menyentuh apa pun.
        updated.set(p.id, {
          ...p,
          models: detected.models,
          providerHint: detected.providerHint,
          ...mergeDiscoveredCapacity(p, detected),
        })
      } else if (detected.authFailed) {
        // Key ditolak (401/403): bedakan dari provider tanpa endpoint
        // (Anthropic-style, tetap diam) — operator harus periksa key-nya.
        failed.push({ id: p.id, reason: "unauthorized (401/403) — periksa API key" })
      }
    } catch (e) {
      if (opts.signal?.aborted || (e as { name?: string })?.name === "AbortError") {
        throw new DOMException("aborted", "AbortError")
      }
      // provider offline/timeout — catat, jangan diam. Daftar lama dibiarkan.
      failed.push({ id: p.id, reason: String((e as Error)?.message ?? e).slice(0, 120) })
    }
  }

  // Tulis kembali ke setiap file yang memuat provider yang diupdate — dalam
  // format yang sudah ada di file tersebut (global dan/atau local).
  const results: { id: string; from: number; to: number }[] = []
  // check existence via direct read attempt (no TOCTOU pre-check).
  // Berkas lokal hanya disentuh bila operator opt-in (default deny — /sync
  // tanpa flag tak boleh menghubungi endpoint repo tak dikenal).
  const paths = new Set<string>()
  const checkPaths = opts.allowLocal
    ? [globalConfigPath(), resolve(opts.cwd ?? process.cwd(), LOCAL)]
    : [globalConfigPath()]
  for (const p of checkPaths) {
    try {
      await readFile(p, "utf8")
      paths.add(p)
    } catch {}
  }
  for (const path of paths) {
    // Kunci per-file (audit #07): /sync + saveProvider paralel tanpa ini
    // last-wins dan menelan update satu sama lain.
    await withConfigLock(path, async () => {
      try {
        const cfg: MinicodeConfig = normalizeConfig(JSON.parse(await readFile(path, "utf8")))
        let changed = false
        for (const p of cfg.providers) {
          const nu = updated.get(p.id)
          if (nu) {
            p.models = nu.models
            p.providerHint = nu.providerHint
            // Kapasitas hanya ditulis bila hasil merge memang punya isi — tanpa
            // guard ini provider tanpa metadata akan menghapus nilai lama.
            if (nu.contextWindows) p.contextWindows = nu.contextWindows
            if (nu.contextWindowSources) p.contextWindowSources = nu.contextWindowSources
            if (nu.maxOutputTokens) p.maxOutputTokens = nu.maxOutputTokens
            changed = true
          }
        }
        if (changed) await writeConfigAtomic(path, cfg)
      } catch {
        // file corrupt/unreadable — lewati
      }
    })
  }
  for (const [id, nu] of updated) {
    const orig = providers.find((p) => p.id === id)!
    results.push({ id, from: orig.models.length, to: nu.models.length })
  }
  return { updated: results, failed }
}
