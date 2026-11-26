import { readFile } from "node:fs/promises"
import {
  BUILTIN_PRICING,
  findPrice,
  loadPricingOverlay,
  pricingCachePath,
  pricingOverlayMeta,
  syncPricing,
} from "../../src/policy/pricing.ts"
import { t } from "../../src/ui/i18n/locale.ts"
import { formatError } from "../../src/ui/render/errors.ts"
import { sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { c } from "../../src/ui/render/theme.ts"
import { hasHelpFlag, positionalSubArg } from "../args.ts"

const PRICING_HELP = `minicode pricing — price table for cost estimation

  minicode pricing status        active price sources (default)
  minicode pricing sync          pull from models.dev (explicit, not automatic)
  minicode pricing show <model>  show one model price
  minicode pricing clear         clear cache and use built-in data`

const errLine = (msg: string): void => console.error(msg)

export async function handlePricing(args: string[]): Promise<never> {
  if (hasHelpFlag(args)) {
    console.log(PRICING_HELP)
    process.exit(0)
  }
  const sub = (positionalSubArg(args, 1) ?? "status").toLowerCase()

  if (sub === "sync") {
    process.stderr.write(`${t("cli.pricingFetching")}\n`)
    try {
      const res = await syncPricing()
      console.log(
        `${c.green("ok")} saved ${res.count} models (${Math.round(res.bytes / 1024)} KB)\n  ${c.dim(res.path)}`,
      )
      process.exit(0)
    } catch (e) {
      console.error(c.red(`failed: ${formatError(e)}`))
      console.error(c.dim("  built-in price table is still used — nothing is broken"))
      process.exit(1)
    }
  }

  if (sub === "status") {
    await loadPricingOverlay()
    const meta = pricingOverlayMeta()
    console.log(`\n${c.bold("Model pricing")}`)
    console.log(
      `  built-in     ${Object.keys(BUILTIN_PRICING).length} models (offline, always available)`,
    )
    if (!meta) {
      console.log(`  models.dev   ${c.dim("not synced yet")} — run: minicode pricing sync`)
    } else {
      const age = Math.round((Date.now() - meta.fetchedAt) / 3_600_000)
      console.log(
        `  models.dev   ${meta.count} models, ${age}h ago${meta.stale ? c.yellow(" (stale, still in use)") : ""}`,
      )
      console.log(`  ${c.dim(pricingCachePath())}`)
    }
    console.log(`\n  ${c.dim("No automatic fetch: sync only runs when you ask.")}\n`)
    process.exit(0)
  }

  if (sub === "show") {
    const model = positionalSubArg(args, 2)
    if (!model) {
      errLine("usage: minicode pricing show <model>")
      process.exit(2)
    }
    const overlay = await loadPricingOverlay()
    const p = findPrice(model, overlay)
    const safeModel = sanitizeAnsiLine(model)
    if (!p) {
      console.log(`(price for "${safeModel}" is unknown — cost will show N/A)`)
      process.exit(0)
    }
    const src = findPrice(model, {}) === p ? "built-in" : "models.dev"
    console.log(`\n${c.bold(safeModel)}  ${c.dim(`(${src})`)}`)
    console.log(`  input        $${p.input}/M token`)
    console.log(`  output       $${p.output}/M token`)
    if (p.cacheRead != null) console.log(`  cache read   $${p.cacheRead}/M`)
    if (p.cacheWrite != null) console.log(`  cache write  $${p.cacheWrite}/M`)
    console.log("")
    process.exit(0)
  }

  if (sub === "clear") {
    try {
      await readFile(pricingCachePath(), "utf8")
      const { rm } = await import("node:fs/promises")
      await rm(pricingCachePath(), { force: true })
      console.log(`${c.green("ok")} pricing cache cleared`)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT") {
        console.log("(no pricing cache)")
        process.exit(0)
      }
      errLine(`failed to clear pricing cache: ${(e as Error)?.message ?? e}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // Subcommand asing = salah pakai: exit 2 supaya skrip bisa mendeteksinya
  // dan membedakannya dari gagal runtime (exit 1).
  errLine(`unknown pricing subcommand: ${sanitizeAnsiLine(sub)}\n`)
  console.log(PRICING_HELP)
  process.exit(2)
}
