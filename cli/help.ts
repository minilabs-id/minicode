// Sumber TUNGGAL teks help CLI + pembacaan versi. Modul ini sengaja ringan:
// hanya `node:fs` dan `src/constants.ts` (tanpa impor aplikasi), supaya
// `minicode --help/--version` bisa dijawab entry tipis tanpa memuat seluruh
// sesi/TUI. Jangan menambah impor berat ke sini.

import { readFileSync } from "node:fs"
import { LIMITS } from "../src/constants.ts"

/** Versi dibaca dari package.json — satu sumber, tidak di-hardcode dua tempat. */
export function readVersion(): string {
  try {
    // URL relatif terhadap modul ini: tanpa node:path, tetap benar saat Bun
    // meng-transpile/meng-cache modul ke lokasi lain.
    const pkgUrl = new URL("../package.json", import.meta.url)
    return (JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string }).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

/** Default global = LIMITS (200); angka 50 adalah cap sub-agent, bukan default CLI. */
export const HELP = `Minicode - coding agent on frozen MiniCore
Usage:
  minicode                        # interactive chat
  minicode "prompt" [options]     # one-shot run
  minicode exec "prompt" [--json] # headless CI mode (JSON stream)
  minicode acp                  # JSON-RPC stdio server for IDEs (minimal subset)
  minicode daemon <cmd>         # daemon host / status / stop / issue / sessions
  echo "prompt" | minicode        # via pipe
  minicode sync                   # refresh models from all providers
  minicode openwork               # cross-session unfinished work (P14, read-only)
Options:
  -h, --help          show help
  -v, --version       show version
  --verbose           show reasoning & usage
  --cwd <dir>         workspace root (default .)
  --allow-local-config trust .minicode/config.json in workspace (default: ignore)
  --resume <id>       resume session id
  --adopt-task <source>/<taskId>
                      P14: adopt one unfinished task from another session into this
                      session (explicit authority; scheduler is NOT started)
  --model <name>      override model (provider::model)
  --provider <id>     force provider id
  --session <id>      session id (default random)
  --allow-all         allow all tools (privileged access profile; hard jail/guard still apply)
  --ask               ask per tool (y/n/a) — human-supervised execution
  --allowlist         bash allowlist only (see MINICODE_BASH_ALLOWLIST)
  --max-steps <n>     max tool steps (default ${LIMITS.DEFAULT_MAX_STEPS})
  --context-window <n> context window tokens
  --timeout <ms>      hard deadline per run (default 3600000 = 1h, 0 = off)
  --interactive       interactive TUI (default bila tanpa prompt di TTY)
  --verify            auto-verify + self-heal (typecheck/test/tsconfig)
  --sandbox <mode>    bash sandbox: docker (ephemeral, no network) | os (bwrap/seatbelt)
  --ratelimit <rpm>   LLM requests per minute
  --budget <usd>      session cost limit
  --budget-strict     unknown cost + spend counts as over budget (fail-closed default)
  --tool-scope <s>    full (default) | explore (read-only subset)
  --work-mode <m>     DISCUSS | BUILD (default: DISCUSS). Operating mode: DISCUSS =
                      read-only investigation, discussion & planning, BUILD = implementation.
  --tui               deprecated no-op (interactive mode is always the fullscreen TUI)
  --enable-scheduler  EXPERIMENTAL: opt in to the autonomous scheduler (default: off).
                      Manual only - run /scheduler run. No timer; autonomous turns are
                      readonly. Inspect with /scheduler status; release with /scheduler stop.
  --runtime <mode>    off (default) | constructed | owned. Execution architecture:
                      off = current behaviour, unchanged. constructed = runtime + durable
                      journal built, turns still run the legacy way. owned = every turn is
                      admitted through the runtime (kernel + durable journal); a rejected
                      admission runs nothing. Unknown value = off.

TUI: /help /provider /model /context /status /sessions /init /update /exit /mode /undo /redo /clear /copy /view /lang /scheduler
Keys: Enter submit · Tab work-mode · Shift+Tab permission · Up/Down history · Mouse wheel/PgUp/PgDn scroll (Shift = half page)
      Home/End jump to transcript top/tail · Ctrl+R search · Esc abort turn (twice = quit) · Ctrl+D exit
Subcommand flags (config/mcp/sessions/skills/exec/...): see 'minicode <cmd> --help'.
`

/** Versi machine-readable dari help yang sama (dipakai entry tipis & index.ts). */
export function buildHelpJson(): object {
  return {
    name: "minicode",
    version: readVersion(),
    usage: [
      "minicode",
      'minicode "prompt" [options]',
      'minicode exec "prompt" [--json]',
      "minicode acp",
      "minicode daemon <start|status|stop|issue|sessions>",
      "minicode providers|models|sync|config|mcp|skills|sessions|stats|memory",
      "minicode openwork — cross-session unfinished work portfolio (P14)",
    ],
    options: [
      { flag: "--version", desc: "show version" },
      { flag: "--verbose", desc: "show reasoning & usage" },
      { flag: "--cwd <dir>", desc: "workspace root" },
      {
        flag: "--allow-local-config",
        desc: "trust .minicode/config.json in workspace (default: ignore)",
      },
      { flag: "--resume <id>", desc: "resume session id" },
      {
        flag: "--adopt-task <source>/<taskId>",
        desc:
          "P14: explicitly adopt ONE unfinished task from another session into this " +
          "session (workspace-local; requires both sessions' writer authority; " +
          "does not start the scheduler)",
      },
      {
        flag: "--enable-scheduler",
        // [PHASE 6AB] Teks ini sengaja menjelaskan bahwa pemicuan MANUAL dan
        // tidak ada loop latar belakang (audit menemukan klaim lama menyesatkan).
        desc:
          "EXPERIMENTAL: opt in to the autonomous scheduler for this session (default: off). " +
          "Runs on manual /scheduler run only — no background timer, no recurring polling. " +
          "Autonomous turns are readonly. Use /scheduler status|stop inside the session.",
      },
      { flag: "--model <name>", desc: "override model (provider::model)" },
      { flag: "--provider <id>", desc: "force provider id" },
      { flag: "--session <id>", desc: "session id" },
      { flag: "--max-steps <n>", desc: `max tool steps (default ${LIMITS.DEFAULT_MAX_STEPS})` },
      { flag: "--context-window <n>", desc: "context window tokens" },
      {
        flag: "--timeout <ms>",
        desc: "hard deadline per run (default 3600000 = 60min; 0 = Infinity)",
      },
      { flag: "--allow-all", desc: "allow all tools (privileged access profile)" },
      { flag: "--ask", desc: "ask per tool (human-supervised)" },
      { flag: "--allowlist", desc: "bash allowlist only" },
      { flag: "--interactive", desc: "interactive TUI" },
      { flag: "--verify", desc: "auto-verify + self-heal" },
      { flag: "--sandbox <docker|os>", desc: "bash sandbox" },
      { flag: "--ratelimit <rpm>", desc: "LLM requests/min" },
      { flag: "--budget <usd>", desc: "session cost limit" },
      { flag: "--budget-strict", desc: "unknown cost + spend counts as over budget (default)" },
      { flag: "--tool-scope <full|explore>", desc: "tool subset (explore = read-only)" },
      {
        flag: "--work-mode <DISCUSS|BUILD>",
        desc: "operating mode: DISCUSS (default, read-only), BUILD",
      },
      { flag: "--json", desc: "JSON output (help/exec)" },
      { flag: "--tui", desc: "deprecated no-op (interactive is always the fullscreen TUI)" },
    ],
  }
}
