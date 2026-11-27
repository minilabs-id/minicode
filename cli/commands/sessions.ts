import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homeDir } from "../../src/lib/db-path.ts"
import { resolveSessionDisplayTarget } from "../../src/session/identity.ts"
import { deleteJournalFile, findOrphanJournals } from "../../src/session/journal.ts"
import {
  getSessionTtlDays,
  listSessions,
  loadSession,
  purgeExpired,
} from "../../src/session/persistence.ts"
import { t } from "../../src/ui/i18n/locale.ts"
import { sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c } from "../../src/ui/render/theme.ts"
import { hasHelpFlag, positionalSubArg } from "../args.ts"

const SESSIONS_HELP = `minicode sessions — session history

  minicode sessions list                 list recent sessions
  minicode sessions export <id> [--jsonl]  export message history
  minicode sessions purge                remove expired sessions (TTL)`

const out = (msg: string): void => console.log(msg)
const err = (msg: string): void => console.error(msg)

export async function handleSessions(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const sub = args[1]
  if (hasHelpFlag(args)) {
    out(SESSIONS_HELP)
    process.exit(0)
  }
  if (sub === "list" || !sub) {
    const cwdArg = getArg("--cwd")
    const rows = listSessions(cwdArg)
    // resolveDbPath jatuh ke global ~/.minicode bila workspace tanpa
    // .minicode/ — umumkan scope agar daftar lintas-workspace tak dibaca
    // sebagai isi workspace ini (temuan F-C audit terminal UI/UX).
    const base = cwdArg ?? process.cwd()
    const usesLocal =
      existsSync(resolve(base, ".minicode", "sessions.db")) ||
      existsSync(resolve(base, ".minicode"))
    if (!usesLocal)
      out(c.dim(`(global scope — no local .minicode/sessions.db in ${sanitizeAnsiLine(base)})`))
    if (rows.length === 0) out(c.dim("(no recorded sessions yet)"))
    else {
      const tableData = rows.map((r) => ({
        id: c.cyan(sanitizeAnsiLine(r.id)),
        date: new Date(r.created_at).toLocaleString(),
        cwd: c.dim(sanitizeAnsiLine(r.cwd)),
      }))
      out(
        `\n${c.bold("Recent Sessions")}\n` +
          renderTable(
            [
              { header: "Session ID", key: "id", width: 14 },
              { header: "Created", key: "date", width: 22 },
              { header: "Workspace", key: "cwd", width: 40 },
            ],
            tableData,
          ) +
          "\n",
      )
    }
    process.exit(0)
  } else if (sub === "export") {
    const id = positionalSubArg(args, 2)
    const asJsonl = args.includes("--jsonl")
    if (!id) {
      err("usage: minicode sessions export <id> [--jsonl]")
      process.exit(2)
    }
    // P2.1 read-compat: alias eksak resolve ke kanonik; selain itu input
    // apa adanya (lenien untuk baca; tulis tetap jalur kanonik tunggal).
    const sess = loadSession(resolveSessionDisplayTarget(id, getArg("--cwd")), getArg("--cwd"))
    if (!sess) {
      err(`session "${sanitizeAnsiLine(id)}" not found - see: minicode sessions list`)
      process.exit(1)
    }
    if (asJsonl) for (const m of sess.messages) out(JSON.stringify(m))
    else out(JSON.stringify(sess, null, 2))
    process.exit(0)
  } else if (sub === "purge") {
    const cwdArg = getArg("--cwd")
    const localPath = resolve(cwdArg ?? process.cwd(), ".minicode", "sessions.db")
    const dbPath = existsSync(localPath)
      ? localPath
      : (() => {
          const g = join(homeDir(), ".minicode")
          mkdirSync(g, { recursive: true })
          return join(g, "sessions.db")
        })()
    const db = new Database(dbPath)
    try {
      // Jurnal mengikuti lifecycle sesi: hapus file jurnal milik sesi yang
      // akan di-purge (best-effort) sebelum baris DB-nya hilang.
      try {
        const days = getSessionTtlDays()
        if (days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          const stale = db
            .prepare("SELECT id FROM sessions WHERE COALESCE(updated_at, created_at) < ?")
            .all(cutoff) as { id: string }[]
          const journalCwd = existsSync(localPath) ? (cwdArg ?? process.cwd()) : homeDir()
          for (const s of stale) deleteJournalFile(s.id, journalCwd)
        }
      } catch {}
      const removed = purgeExpired(db)
      // Yatim: jurnal milik sesi yang sudah tak ada di tabel (termasuk anak
      // yang tak pernah persist) + tak dirujuk parent hidup + lebih tua dari
      // TTL. Unreadable tak pernah dihapus (tak terbukti yatim).
      let orphans = 0
      try {
        const journalDir = join(dirname(dbPath), "")
        const alive = new Set(
          (
            db.prepare("SELECT id FROM sessions").all() as {
              id: string
            }[]
          ).map((r) => r.id),
        )
        const { unlinkSync } = await import("node:fs")
        for (const f of await findOrphanJournals(journalDir, alive, getSessionTtlDays())) {
          try {
            unlinkSync(f)
            orphans += 1
          } catch {}
        }
      } catch {}
      const ttl = getSessionTtlDays()
      out(t("cli.purgeSessions", { n: removed, days: ttl }))
      if (orphans > 0) out(t("cli.purgeOrphans", { n: orphans }))
    } finally {
      db.close()
    }
    process.exit(0)
  } else {
    err(`unknown sessions subcommand: ${sanitizeAnsiLine(sub)}\n`)
    out(SESSIONS_HELP)
    process.exit(2)
  }
}
