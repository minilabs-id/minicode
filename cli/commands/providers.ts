import { loadConfig, type MinicodeConfig } from "../../src/config.ts"
import { refreshProviderModels } from "../../src/providers/provision.ts"
import { readTraceRows } from "../../src/telemetry/trace.ts"
import { t } from "../../src/ui/i18n/locale.ts"
import { sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c } from "../../src/ui/render/theme.ts"
import { allowLocalSubcommand, guardSubcommand, positionalSubArg } from "../args.ts"

const PROVIDERS_HELP = `minicode providers | models | sync — inspect & refresh configured LLM providers

  minicode providers [--allow-local-config] [--cwd <dir>]
  minicode models [provider] [--match <q>] [--allow-local-config] [--cwd <dir>]
  minicode sync [--allow-local-config] [--cwd <dir>]`

interface TraceRow {
  model?: string
  ok?: boolean
  error?: string
  timestamp?: string
}

const out = (msg: string): void => console.log(msg)
const err = (msg: string): void => console.error(msg)

export function providerOfTrace(cfg: MinicodeConfig, t: TraceRow): string | undefined {
  const m = t.model ?? ""
  if (m.includes("::")) return m.slice(0, m.indexOf("::"))
  const byModel = cfg.providers.find((p) => p.models.includes(m))
  if (byModel) return byModel.id
  const byId = cfg.providers.find((p) => p.id === m)
  if (byId) return byId.id
  return undefined
}

export function healthMap(
  cfg: MinicodeConfig,
  traces: TraceRow[],
): Map<string, { ok: boolean; model: string; ts: string }> {
  const out = new Map<string, { ok: boolean; model: string; ts: string }>()
  for (const t of traces) {
    const pid = providerOfTrace(cfg, t)
    if (!pid) continue
    const prev = out.get(pid)
    if (prev && prev.ts > (t.timestamp ?? "")) continue
    out.set(pid, { ok: t.ok !== false, model: t.model ?? "-", ts: t.timestamp ?? "" })
  }
  return out
}

export async function handleProviders(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const firstArg = args[0]
  if (firstArg !== "providers" && firstArg !== "models" && firstArg !== "sync") {
    process.exit(0)
  }
  guardSubcommand(args, firstArg, PROVIDERS_HELP, out, err, firstArg === "models" ? -1 : 1)
  const cwdArg = getArg("--cwd")
  // Audit #07: local hanya bila operator opt-in (aturan universal — sync
  // tanpa flag tak boleh menghubungi endpoint repo tak dikenal).
  const allowLocal = allowLocalSubcommand(args)
  const cfg = await loadConfig(cwdArg, { allowLocal })
  if (firstArg === "providers") {
    if (cfg.providers.length === 0) {
      out(
        "(no providers yet - run `minicode` for the wizard, `minicode auth login` (free, no API key),\nor `minicode config add --baseUrl <url> --apiKey <key>`)",
      )
      process.exit(0)
    }
    const health = healthMap(cfg, readTraceRows<TraceRow>(cwdArg, "traces.jsonl"))
    const rows = cfg.providers.map((p) => {
      const h = health.get(p.id)
      const status = !h
        ? c.dim("not used yet")
        : `${h.ok ? c.green("ok") : c.red("ERR")} ${c.dim(
            h.ts ? new Date(h.ts).toISOString().slice(0, 10) : "-",
          )}`
      return {
        id: c.cyan(sanitizeAnsiLine(p.id)),
        models: String(p.models.length),
        url: sanitizeAnsiLine(p.baseUrl),
        status,
      }
    })
    out(
      `\n${c.bold("LLM Providers")}\n` +
        renderTable(
          [
            { header: "ID", key: "id", width: 24 },
            { header: "Models", key: "models", width: 6, align: "right" },
            { header: "Base URL", key: "url", width: 34 },
            { header: "Status", key: "status", width: 18 },
          ],
          rows,
        ) +
        "\n",
    )
    out(
      `  ${c.dim("next: minicode models | minicode sync | minicode config add --baseUrl <url> --apiKey <key>")}\n`,
    )
    process.exit(0)
  }
  if (firstArg === "models") {
    const pid = positionalSubArg(args, 1)
    const filter = (getArg("--match") ?? "").toLowerCase()
    const match = (s: string) => (filter ? s.toLowerCase().includes(filter) : true)
    if (pid) {
      const p = cfg.providers.find((x) => x.id === pid)
      if (!p) {
        err(t("cli.providerNotFound", { id: sanitizeAnsiLine(pid) }))
        process.exit(1)
      }
      const list = p.models.filter(match)
      if (!list.length) out(`  ${t("cli.noMatches", { q: sanitizeAnsiLine(filter) })}`)
      for (const [i, m] of list.entries()) out(`  [${i}] ${sanitizeAnsiLine(m)}`)
    } else {
      if (cfg.providers.length === 0) out(t("prov.empty"))
      let shown = 0
      for (const p of cfg.providers) {
        const list = p.models.filter(match)
        if (!list.length) continue
        out(
          `${sanitizeAnsiLine(p.id)} (${sanitizeAnsiLine(p.baseUrl)})${filter ? ` - matches "${sanitizeAnsiLine(filter)}"` : ""}`,
        )
        shown += list.length
        for (const m of list.slice(0, 10)) out(`  ${sanitizeAnsiLine(m)}`)
        if (filter && list.length > 10) out(`  ${t("ask.more", { n: list.length - 10 })}`)
        if (!filter && p.models.length > 10) out(`  ${t("ask.more", { n: p.models.length - 10 })}`)
      }
      if (filter && shown === 0) out(`  ${t("cli.noMatches", { q: sanitizeAnsiLine(filter) })}`)
    }
    process.exit(0)
  }
  if (firstArg === "sync") {
    out(t("cmd.syncing"))
    const { updated, failed } = await refreshProviderModels({ cwd: cwdArg, allowLocal })
    for (const r of updated)
      out(`  ${c.green("ok")} ${sanitizeAnsiLine(r.id)}: ${r.from} -> ${r.to} model`)
    for (const f of failed)
      out(`  ${c.red("failed")} ${sanitizeAnsiLine(f.id)}: ${sanitizeAnsiLine(f.reason)}`)
    if (!updated.length && !failed.length) {
      const cfgHere = await loadConfig(cwdArg, { allowLocal })
      if (cfgHere.providers.length === 0) out(`  ${t("cli.noProvidersHint")}`)
      else out(t("cmd.noChanges"))
    }
    process.exit(0)
  }
  process.exit(0)
}
