// Eksekusi `/context`: baca config, resolve jendela efektif, dan (bila diminta)
// tulis penugasan manual.
//
// Dipisah dari `cli/commands.ts` karena butuh `loadConfig` + picker + penulisan
// config — sementara `commands.ts` memanggilnya lewat `import()` dinamis supaya
// jalur satu-shot (yang tak pernah membuka `/context`) tidak membayar biaya
// modul ini. Alasan yang sama dipakai `/model` (`./model-manager.ts`).

import type { MinicodeConfig, ProviderEntry } from "../src/config.ts"
import { hasProviderInLocalConfig, loadConfig } from "../src/config.ts"
import { resolveContextWindow } from "../src/policy/context-window.ts"
import { assignContextWindow } from "../src/policy/context-window-assign.ts"
import {
  CONTEXT_WINDOW_AUTO,
  describeContextWindow,
  parseContextWindowInput,
} from "../src/policy/context-window-presets.ts"
import { t } from "../src/ui/i18n/locale.ts"
import { sanitizeAnsiLine } from "../src/ui/render/sanitize.ts"
import { renderTable } from "../src/ui/render/table.ts"
import { windowWidth } from "../src/ui/screens/window.ts"
import type { CommandContext } from "./commands.ts"
import {
  contextWindowRow,
  contextWindowSavedNotice,
  contextWindowTableHeader,
} from "./context-command.ts"

/** Baris `provider::model` aktif, diturunkan dari id yang dipakai sesi. */
function activeRef(
  ctx: CommandContext,
  cfg?: MinicodeConfig,
): { provider: string; model: string } | undefined {
  const id = ctx.currentModel
  if (!id) return undefined
  if (id.includes("::")) {
    const sep = id.indexOf("::")
    return { provider: id.slice(0, sep), model: id.slice(sep + 2) }
  }
  const owner = cfg?.providers.find((p) => p.models.includes(id))
  return owner ? { provider: owner.id, model: id } : undefined
}

/**
 * Cetak tabel jendela efektif untuk SEMUA model yang dikonfigurasi.
 *
 * Kenapa semua model, bukan hanya yang aktif: pertanyaan "berapa konteks saya"
 * hampir selalu muncul saat memilih model, dan tabel satu baris memaksa buka
 * `/context` berkali-kali. Baris aktif ditandai supaya mata langsung menemukan
 * yang relevan.
 */
async function rowsFor(ctx: CommandContext): Promise<string[]> {
  const cfg = await loadConfig(ctx.cwd, { allowLocal: ctx.allowLocalConfig })
  const active = activeRef(ctx, cfg)
  const rows: { model: string; window: string; origin: string }[] = []
  for (const p of cfg.providers) {
    for (const model of p.models ?? []) {
      const res = resolveContextWindow(cfg, `${p.id}::${model}`)
      const row = contextWindowRow(model, res, describeContextWindow)
      // Angka jendela = data operasional, nama model = input tak terpercaya
      // (bisa datang dari /models jaringan): sanitasi keduanya sebelum tampil.
      rows.push({
        model: `${sanitizeAnsiLine(`${p.id}::${model}`)}${active && active.provider === p.id && active.model === model ? " *" : ""}`,
        window: sanitizeAnsiLine(row.window),
        origin: sanitizeAnsiLine(row.origin),
      })
    }
  }
  if (!rows.length) return [t("ctx.empty")]
  const head = contextWindowTableHeader()
  // Lebar kolom mengikuti inner width jendela output seragam (`windowWidth - 4`)
  // agar tabel tidak meluap atau di-wrap ulang di dalam jendela output.
  const inner = Math.max(20, windowWidth(process.stdout.columns || 80) - 4)
  const windowW = 9
  const originW = Math.min(14, Math.max(10, Math.floor(inner * 0.18)))
  const modelW = Math.max(12, Math.min(40, inner - windowW - originW - 10))
  return [
    "",
    renderTable(
      [
        { header: head.model, key: "model", width: modelW },
        { header: head.window, key: "window", width: windowW, align: "right" },
        { header: head.origin, key: "origin", width: originW },
      ],
      rows,
      { width: inner },
    ),
    `  ${t("ctx.usage")}`,
    "",
  ].flatMap((line) => line.split("\n"))
}

/**
 * Tulis nilai manual untuk model aktif. Mengembalikan baris untuk dicetak.
 *
 * Nilai `auto` MENGHAPUS kunci (lihat `assignContextWindow`), bukan menyimpan
 * penanda — sehingga perilaku kembali persis ke rantai resolusi normal.
 */
async function save(ctx: CommandContext, input: string): Promise<string[]> {
  const cfg = await loadConfig(ctx.cwd, { allowLocal: ctx.allowLocalConfig })
  const active = activeRef(ctx, cfg)
  if (!active) return [`${t("ctx.saveFailed", { msg: "no active model — pick one with /model" })}`]
  const provider = cfg.providers.find((p) => p.id === active.provider)
  if (!provider) return [`${t("ctx.saveFailed", { msg: `provider ${active.provider} not found` })}`]

  const outcome = assignContextWindow(provider as ProviderEntry, active.model, input)
  if (!outcome.ok) return [`${t("ctx.saveFailed", { msg: outcome.error })}`]

  // Sesi ini menyimpan snapshot config saat start; tanpa mendaftarkan nilai
  // baru ke registry live, "saved" di layar tidak mengubah apa pun sampai
  // restart. Daftarkan sebelum/bersamaan dengan tulis disk.
  const { setLiveContextWindow, clearLiveContextWindow } = await import(
    "../src/policy/context-window.ts"
  )
  if (outcome.tokens === null) clearLiveContextWindow(active.provider, active.model)
  else setLiveContextWindow(active.provider, active.model, outcome.tokens)

  const { saveProvider } = await import("../src/providers/provision.ts")
  // Scope tulis = scope tempat provider itu benar-benar didefinisikan, BUKAN
  // hasil merge. Menyimpan entri merge ke file global menduplikat provider ke
  // scope lain, lalu merge memprioritaskan salinan itu sehingga editan di scope
  // asal terlihat "balik lagi" (kelas yang sama dengan `cli/model-manager.ts`).
  // Provider lokal hanya terbaca bila sesi mengizinkannya (`--allow-local-config`)
  // — tanpa opt-in kita tak boleh menyentuh berkas repo.
  const inLocal =
    !!ctx.allowLocalConfig && (await hasProviderInLocalConfig(active.provider, ctx.cwd))
  try {
    await saveProvider(outcome.provider, {
      ...(inLocal ? { global: false, cwd: ctx.cwd ?? process.cwd() } : { global: true }),
    })
  } catch (e) {
    return [t("ctx.saveFailed", { msg: sanitizeAnsiLine(String((e as Error)?.message ?? e)) })]
  }
  return [
    sanitizeAnsiLine(
      contextWindowSavedNotice(outcome.tokens, describeContextWindow).replace(
        "{model}",
        `${active.provider}::${active.model}`,
      ),
    ),
  ]
}

/** Baris yang dicetak sebagai satu blok — dirakit di sini, bukan di
 * `cli/commands.ts`, supaya berkas itu tetap satu penulis untuk perintah ini
 * (inventaris writer OAP-008 menghitung pemanggilan tulis per berkas). */
export function formatContextOutput(lines: string[]): string {
  return lines.join("\n")
}

/** Entri tunggal `/context`: tanpa argumen = tabel, dengan argumen = setel. */
export async function applyContextWindowArg(args: string, ctx: CommandContext): Promise<string[]> {
  const raw = args.trim()
  if (!raw) {
    // Tanpa argumen = HANYA membaca. Sengaja tanpa picker: membuka picker di
    // sini berarti perintah menahan turn sampai pengguna memilih, sehingga
    // `/context` yang diniatkan sebagai "lihat angka" malah mengunci TUI —
    // kelas keluhan "macet" yang justru sedang kita bereskan. Mengubah nilai
    // selalu eksplisit: `/context 200k`.
    return rowsFor(ctx)
  }
  // `auto` diterima apa adanya; selain itu WAJIB terbaca sebagai angka/preset.
  // Menolak tebakan di sini penting: salah ketik yang diterima diam-diam akan
  // memotong konteks model tanpa gejala sampai kompaksi prematur muncul.
  if (raw.toLowerCase() !== CONTEXT_WINDOW_AUTO && parseContextWindowInput(raw) === undefined)
    return [
      t("ctx.saveFailed", {
        msg: `cannot read "${sanitizeAnsiLine(raw)}" as a window (try 128k, 1m, 1024x1024, auto)`,
      }),
    ]
  return save(ctx, raw)
}
