// `/context` — jendela konteks: LIHAT kapasitas efektif, lalu UBAH bila perlu.
//
// ── Kenapa perintah ini ada ────────────────────────────────────────────────
// Fitur jendela konteks manual sebelumnya hanya hidup di `minicode config
// context-window <provider> <model> <nilai>`: subcommand CLI yang tak muncul di
// `/help`, tak punya tombol di `/model`, dan tak punya umpan balik di UI. Hasil
// audit pengguna: "fitur ini tidak ada". Mesinnya benar; penemuannya nol.
//
// `/context` menutup celah itu di tempat pengguna sudah melihat model: satu
// perintah yang (a) MENAMPILKAN angka efektif beserta asalnya, dan (b) membuka
// picker preset untuk menimpanya. Tabel tidak dikarang di sini — `resolveContextWindow`
// adalah rantai yang sama yang dipakai router/kernel, jadi angka yang tampil
// tidak bisa menyimpang dari angka yang benar-benar dipakai turn berikutnya.

import type { ContextWindowResolution } from "../src/policy/context-window.ts"
import { t } from "../src/ui/i18n/locale.ts"

/** Satu baris tabel: model, kapasitas efektif, dan dari mana angka itu datang. */
export interface ContextWindowRow {
  model: string
  window: string
  /** Label asal yang jujur (bukan tebakan): lihat `originLabel`. */
  origin: string
  /** True bila angka ini berasal dari pilihan operator (boleh diubah/dihapus). */
  manual: boolean
}

/**
 * Label asal resolusi. Sengaja dibedakan antara "manual" (operator memilih) dan
 * "endpoint"/"catalog"/"models-dev" (temuan otomatis yang bisa berubah) karena
 * satu-satunya pertanyaan yang berguna bagi pengguna adalah: apakah angka ini
 * keputusan saya atau tebakan mesin?
 */
export function originLabel(res: ContextWindowResolution): string {
  switch (res.source) {
    case "override":
      return "flag"
    case "model":
    case "provider-default":
      // `origin` membedakan nilai `user` (dikunci operator) dari `endpoint`
      // (ditemukan dari /models, boleh ditimpa sync berikutnya).
      return res.origin === "user" ? "manual" : (res.origin ?? "config")
    case "catalog":
      return t("ctx.originCatalog")
    case "models-dev":
      return "models.dev"
    case "safe-default":
      return t("ctx.originSafeDefault")
  }
}

/** Baris tabel untuk satu model. `describe` disuntik agar modul ini bebas dari
 * format angka (dan mudah diuji tanpa tabel preset). */
export function contextWindowRow(
  model: string,
  res: ContextWindowResolution,
  describe: (tokens: number) => string,
): ContextWindowRow {
  return {
    model,
    window: describe(res.tokens),
    origin: originLabel(res),
    manual: res.source === "model" || res.source === "provider-default",
  }
}

/** Judul baris tabel — satu sumber untuk /context. */
export function contextWindowTableHeader(): { model: string; window: string; origin: string } {
  return {
    model: t("ctx.colModel"),
    window: t("ctx.colWindow"),
    origin: t("ctx.colOrigin"),
  }
}

/**
 * Teks hasil setelah operator memilih nilai: menyebutkan ANGKA, bukan hanya
 * label. `describe` memberi label pendek ("128K"); angka eksak disertakan
 * karena satu-satunya sumber kebingungan adalah "128K" genap atau 128.000.
 */
export function contextWindowSavedNotice(
  tokens: number | null,
  describe: (tokens: number) => string,
): string {
  if (tokens === null) return t("ctx.savedAuto")
  return t("ctx.saved", { label: describe(tokens), tokens: tokens.toLocaleString("en-US") })
}
