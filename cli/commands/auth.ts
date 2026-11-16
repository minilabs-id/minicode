import { loadConfig } from "../../src/config.ts"
import { authFilePath, listAuth, removeAuth } from "../../src/providers/auth-store.ts"
import { detectModels } from "../../src/providers/detect.ts"
import {
  findOAuthProvider,
  loginWithDeviceFlow,
  OAUTH_PROVIDERS,
} from "../../src/providers/oauth.ts"
import { saveProvider } from "../../src/providers/provision.ts"
import { formatError } from "../../src/ui/render/errors.ts"
import { sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { c } from "../../src/ui/render/theme.ts"
import { hasHelpFlag, positionalSubArg } from "../args.ts"

function usage(code = 0): never {
  console.log(`minicode auth — OAuth login (no API key)

  minicode auth login [provider]   sign in via device code
  minicode auth status             show stored credentials
  minicode auth logout <provider>  remove credentials
  minicode auth list               list providers with OAuth support

Tokens are stored at ${authFilePath()} (chmod 600), NOT in config.json.`)
  process.exit(code)
}

export async function handleAuth(args: string[]): Promise<never> {
  const sub = (args[1] ?? "").toLowerCase()

  if (!sub || sub === "help" || hasHelpFlag(args)) usage()

  if (sub === "list") {
    console.log(`\n${c.bold("Providers with OAuth support")}`)
    for (const p of OAUTH_PROVIDERS) {
      console.log(`  ${c.cyan(p.id.padEnd(12))} ${p.label}`)
      if (p.note) console.log(`  ${" ".repeat(12)} ${c.dim(p.note)}`)
    }
    console.log(`\n  ${c.dim("login:")} minicode auth login ${OAUTH_PROVIDERS[0]?.id ?? "<id>"}\n`)
    process.exit(0)
  }

  if (sub === "status") {
    const rows = await listAuth()
    if (rows.length === 0) {
      console.log(`\n(no OAuth credentials yet — ${c.dim("minicode auth login")})\n`)
      process.exit(0)
    }
    console.log(`\n${c.bold("OAuth Credentials")}  ${c.dim(authFilePath())}`)
    for (const r of rows) {
      const exp = r.expiresAt ? new Date(r.expiresAt).toLocaleString() : "-"
      const state = r.expired
        ? r.hasRefresh
          ? c.yellow("expired (auto-refresh)")
          : c.red("expired (re-login required)")
        : c.green("active")
      console.log(
        `  ${c.cyan(sanitizeAnsiLine(r.providerId).padEnd(12))} ${state}  ${c.dim(`exp ${exp}`)}`,
      )
    }
    console.log("")
    process.exit(0)
  }

  if (sub === "logout") {
    const id = positionalSubArg(args, 2)
    if (!id) {
      console.error("usage: minicode auth logout <provider>")
      process.exit(2)
    }
    const ok = await removeAuth(id)
    const safeId = sanitizeAnsiLine(id)
    console.log(
      ok ? `${c.green("ok")} credentials "${safeId}" removed` : `(no credentials for "${safeId}")`,
    )
    process.exit(0)
  }

  if (sub !== "login") {
    console.error(`unknown auth subcommand: ${sanitizeAnsiLine(sub)}`)
    usage(2)
  }

  // ── login ──
  if (!process.stdin.isTTY) {
    console.error(
      "auth login needs an interactive terminal (device-code approval happens in a browser)",
    )
    process.exit(1)
  }
  const requested = positionalSubArg(args, 2) ?? OAUTH_PROVIDERS[0]?.id
  if (!requested) {
    console.error("no OAuth providers registered")
    process.exit(1)
  }
  const spec = findOAuthProvider(requested)
  if (!spec) {
    console.error(
      `provider "${sanitizeAnsiLine(requested)}" does not support OAuth. Available: ${OAUTH_PROVIDERS.map((p) => p.id).join(", ")}`,
    )
    process.exit(1)
  }

  console.log(`\n${c.bold(`Login ${spec.label}`)}`)
  if (spec.note) console.log(c.dim(`  ${spec.note}`))

  // Ctrl+C harus membatalkan polling, bukan meninggalkan proses menggantung.
  const ac = new AbortController()
  const onSigint = () => {
    console.log(`\n${c.yellow("canceled")}`)
    ac.abort()
  }
  process.once("SIGINT", onSigint)

  try {
    const creds = await loginWithDeviceFlow(spec, {
      signal: ac.signal,
      onPrompt: (info) => {
        console.log(`\n  1. Open: ${c.cyan(info.verificationUriComplete ?? info.verificationUri)}`)
        if (!info.verificationUriComplete) {
          console.log(`  2. Enter code: ${c.bold(info.userCode)}`)
        }
        console.log(`\n  ${c.dim("waiting for approval… (Ctrl+C to cancel)")}`)
      },
      onPoll: (elapsed) => {
        // satu baris yang di-overwrite, bukan spam per-poll
        process.stderr.write(`\r  ${c.dim(`${elapsed}s…`)}   `)
      },
    })
    process.stderr.write("\r                    \r")
    console.log(`${c.green("ok")} login successful`)

    // Daftarkan provider bila belum ada. apiKey dibiarkan kosong: tokennya
    // hidup di auth.json dan diambil saat runtime oleh buildProviderListAsync.
    const cfg = await loadConfig()
    const existing = cfg.providers.find((p) => p.id === spec.id)
    let models = existing?.models ?? []
    if (models.length === 0) {
      try {
        const detected = await detectModels(spec.apiBaseUrl, creds.accessToken)
        models = detected.models.length ? detected.models : spec.fallbackModels
      } catch {
        models = spec.fallbackModels
      }
    }
    await saveProvider(
      {
        id: spec.id,
        baseUrl: spec.apiBaseUrl,
        apiKey: "",
        auth: "oauth",
        models,
        // Login ulang tak boleh me-reset knob user (thinking effort).
        ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}),
      },
      { global: true },
    )
    console.log(
      `${c.green("ok")} provider "${c.bold(spec.id)}" ready (${models.length} models)\n` +
        `  ${c.dim(`try: minicode --provider ${spec.id} "hello"`)}\n`,
    )
    process.exit(0)
  } catch (e) {
    process.stderr.write("\r                    \r")
    console.error(c.red(formatError(e)))
    process.exit(1)
  } finally {
    process.off("SIGINT", onSigint)
  }
}
