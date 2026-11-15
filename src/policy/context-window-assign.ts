// Menetapkan / menghapus jendela konteks per model pada config provider.
//
// ── Kenapa modul terpisah ───────────────────────────────────────────────────
// Yang sulit di sini bukan menulis JSON, melainkan PRESEDENSI. Model yang
// providernya sudah melaporkan kapasitas lewat `/models` menyimpan nilai dengan
// sumber `endpoint`; nilai itu boleh ditimpa ulang oleh sync berikutnya. Nilai
// yang kita tulis dari perintah pengguna HARUS berlabel `user`, karena
// `provision.ts` memperlakukan `user` sebagai milik operator yang tidak boleh
// ditimpa otomatis. Tanpa label itu, satu `minicode sync` akan menghapus
// keputusan pengguna secara diam-diam.
//
// Fungsi di sini murni (tanpa I/O) supaya presedensi itu bisa diuji langsung.

import type { ContextWindowSource, ProviderEntry } from "../config.ts"
import {
  CONTEXT_WINDOW_AUTO,
  isValidContextWindowValue,
  parseContextWindowInput,
} from "./context-window-presets.ts"

/** Hasil penugasan; `error` menjelaskan penolakan untuk ditampilkan CLI. */
export type AssignOutcome =
  | {
      ok: true
      provider: ProviderEntry
      tokens: number | null
      /** True bila model ini sebelumnya punya nilai (dihapus/diubah). */
      replaced: boolean
    }
  | { ok: false; error: string }

/**
 * Terapkan pilihan jendela konteks untuk satu model pada satu provider.
 *
 * @param provider entri provider (tidak dimutasi — hasil disalin)
 * @param model model id persis, atau `"*"` untuk default seluruh provider
 * @param input nilai dari pengguna: angka, string preset (`128k`, `1M`,
 *   `1024x1024`), atau `"auto"` untuk menghapus dan kembali ke deteksi otomatis
 *
 * KENAPA `"auto"` MENGHAPUS dan bukan menyimpan penanda: rantai resolusi sudah
 * punya konsep "tidak ada nilai pengguna" — itulah `auto`. Menyimpan string
 * `"auto"` di config akan menambah keadaan keempat yang harus ditafsirkan di
 * mana-mana. Menghapus kuncinya membuat perilaku kembali persis ke default.
 */
export function assignContextWindow(
  provider: ProviderEntry,
  model: string,
  input: string,
): AssignOutcome {
  const modelId = model.trim()
  if (!modelId) return { ok: false, error: "model id required (use * for the whole provider)" }

  const isAuto = input.trim().toLowerCase() === CONTEXT_WINDOW_AUTO
  const tokens = isAuto ? undefined : parseContextWindowInput(input)
  if (!isAuto && tokens === undefined)
    return {
      ok: false,
      error: `cannot read "${input}" as a window (try 128k, 200k, 1m, 1024x1024, or an exact number)`,
    }
  if (tokens !== undefined && !isValidContextWindowValue(tokens))
    return {
      ok: false,
      error: `${tokens} is outside the plausible range (1000–20000000 tokens)`,
    }

  const windows: Record<string, number> = { ...(provider.contextWindows ?? {}) }
  const sources: Record<string, ContextWindowSource> = { ...(provider.contextWindowSources ?? {}) }
  const replaced = windows[modelId] !== undefined

  if (tokens === undefined) {
    // `auto`: hapus nilai DAN sumbernya. Kalau sumbernya `endpoint` dibiarkan
    // tanpa nilai, sync berikutnya boleh mengisinya lagi; kalau dibiarkan
    // `user` tanpa nilai, entri kosong yang membingungkan.
    delete windows[modelId]
    delete sources[modelId]
  } else {
    windows[modelId] = tokens
    // `user` = milik operator. Inilah kunci yang mencegah endpoint/sync
    // menimpa pilihan manual (lihat shouldPreserveUserValue di provision.ts).
    sources[modelId] = "user"
  }

  const next: ProviderEntry = { ...provider }
  if (Object.keys(windows).length > 0) next.contextWindows = windows
  else delete next.contextWindows
  if (Object.keys(sources).length > 0) next.contextWindowSources = sources
  else delete next.contextWindowSources

  return { ok: true, provider: next, tokens: tokens ?? null, replaced }
}

/**
 * Rangkum nilai efektif per model untuk ditampilkan (`minicode model context-window`
 * tanpa argumen). Menggabungkan nilai manual dengan catatan sumbernya supaya
 * pengguna tahu mana yang ia tetapkan sendiri dan mana hasil deteksi.
 */
export function summarizeContextWindows(provider: ProviderEntry): {
  model: string
  tokens: number
  source: ContextWindowSource
}[] {
  const windows = provider.contextWindows ?? {}
  const sources = provider.contextWindowSources ?? {}
  return Object.entries(windows)
    .filter(([, tokens]) => typeof tokens === "number")
    .map(([model, tokens]) => ({
      model,
      tokens,
      // Entri tanpa catatan sumber diperlakukan sebagai `user` (kompatibel ke
      // belakang: config lama dari sebelum field ini ada = niat operator).
      source: sources[model] ?? "user",
    }))
    .sort((a, b) => a.model.localeCompare(b.model))
}
