// Controller provider manager — CRUD config + deteksi model; tampilannya di
// src/ui/screens/provider-manager.ts.

import { reloadProviders } from "../src/app/provider-layer.ts"
import { loadConfig, type MinicodeConfig } from "../src/config.ts"
import { GATEWAY_PRESETS } from "../src/providers/presets.ts"
import { detectAndSave, removeProvider } from "../src/providers/provision.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { formatError } from "../src/ui/render/errors.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import {
  type ProviderActionResult,
  type ProviderRow,
  runProviderManagerView,
} from "../src/ui/screens/provider-manager.ts"

const rowsFrom = (cfg: MinicodeConfig): ProviderRow[] =>
  cfg.providers.map((p) => ({
    id: p.id,
    baseUrl: p.baseUrl,
    models: p.models.length,
    hint: p.providerHint,
    firstModel: p.models[0],
  }))

export async function runProviderManager(opts: {
  cwd?: string
  currentModel?: string
  setModelOverride?: (m: string) => void
  /** Flag --allow-local-config sesi (default deny). */
  allowLocalConfig?: boolean
}): Promise<void> {
  if (!process.stdin.isTTY) {
    const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
    for (const p of cfg.providers) console.log(sanitizeAnsiLine(p.id))
    return
  }

  // Simpan kegagalan muat-ulang agar ditampilkan sebagai notice di dalam kotak
  // Layer 2 (bukan menulis mentah ke stderr saat popup masih terbuka).
  const reloadSuffix = async (): Promise<string> => {
    try {
      await reloadProviders(opts.cwd, { allowLocal: opts.allowLocalConfig })
      return ""
    } catch {
      return ` (${t("prov.reloadFail")})`
    }
  }

  let activeModel = opts.currentModel
  const loadViewState = async () =>
    rowsFrom(await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig }))
  await runProviderManagerView({
    initialRows: await loadViewState(),
    presets: GATEWAY_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl })),
    currentModel: activeModel,
    getCurrentModel: () => activeModel,
    askScope: !!opts.cwd,
    onSelect: (row) => {
      if (row.firstModel && opts.setModelOverride) {
        activeModel = `${row.id}::${row.firstModel}`
        opts.setModelOverride(activeModel)
      }
    },
    loadRows: loadViewState,
    onAdd: async ({ preset, baseUrl, apiKey, scope }): Promise<ProviderActionResult> => {
      const full = preset ? GATEWAY_PRESETS.find((p) => p.id === preset.id) : undefined
      const fallbackModels = full?.fallbackModels ?? ["gpt-4o-mini"]
      try {
        const entry = await detectAndSave(baseUrl, apiKey, full?.id, {
          global: scope === "global",
          cwd: opts.cwd,
          fallbackModels,
          allowLocal: opts.allowLocalConfig,
        })
        const warn = await reloadSuffix()
        return {
          ok: `${t("ntc.saved", { id: entry.id, n: entry.models.length, scope })}${warn}`,
        }
      } catch (e) {
        return { err: t("prov.detectFail", { msg: formatError(e) }) }
      }
    },
    onDelete: async (row): Promise<ProviderActionResult> => {
      await removeProvider(row.id, { global: true })
      if (opts.cwd && opts.allowLocalConfig)
        await removeProvider(row.id, { global: false, cwd: opts.cwd })
      const warn = await reloadSuffix()
      return { ok: `${t("prov.deleted", { id: row.id })}${warn}` }
    },
    onEditDefaults: async (row) => {
      const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
      const cur = cfg.providers.find((p) => p.id === row.id)
      if (!cur) return null
      return { baseUrl: cur.baseUrl, apiKey: cur.apiKey }
    },
    onEditSave: async (row, { baseUrl, apiKey }): Promise<ProviderActionResult> => {
      const cfg = await loadConfig(opts.cwd, { allowLocal: opts.allowLocalConfig })
      const cur = cfg.providers.find((p) => p.id === row.id)
      if (!cur) return { err: t("ntc.notFound") }
      const inGlobal = (await loadConfig(undefined, { allowLocal: false })).providers.some(
        (p) => p.id === row.id,
      )
      const saveGlobal = inGlobal || !opts.allowLocalConfig || !opts.cwd
      try {
        if (inGlobal) await removeProvider(row.id, { global: true })
        if (opts.cwd && opts.allowLocalConfig)
          await removeProvider(row.id, { global: false, cwd: opts.cwd })
        const entry = await detectAndSave(baseUrl, apiKey, row.id, {
          global: saveGlobal,
          cwd: opts.cwd,
          fallbackModels: cur.models,
          allowLocal: opts.allowLocalConfig,
        })
        const warn = await reloadSuffix()
        return { ok: `${t("ntc.updated", { id: entry.id, n: entry.models.length })}${warn}` }
      } catch (e) {
        await detectAndSave(cur.baseUrl, cur.apiKey, cur.id, {
          global: saveGlobal,
          cwd: opts.cwd,
          fallbackModels: cur.models,
          allowLocal: opts.allowLocalConfig,
        }).catch(() => {})
        const warn = await reloadSuffix()
        return { err: `${t("prov.updateFail", { msg: formatError(e) })}${warn}` }
      }
    },
  })
}
