import { findSkill, loadSkills } from "../../src/skills/loader.ts"
import { sanitizeAnsi, sanitizeAnsiLine } from "../../src/ui/render/sanitize.ts"
import { renderTable } from "../../src/ui/render/table.ts"
import { c } from "../../src/ui/render/theme.ts"
import { allowLocalSubcommand, hasHelpFlag, positionalSubArg } from "../args.ts"

const SKILLS_HELP = `minicode skills — markdown skills in .minicode/skills/*.md

  minicode skills list [--allow-local-config]           list installed skills
  minicode skills show <name> [--allow-local-config]    show one skill

  In interactive mode, run a skill with /name [arguments].`

const out = (msg: string): void => console.log(msg)
const err = (msg: string): void => console.error(msg)

export async function handleSkills(
  args: string[],
  getArg: (name: string) => string | undefined,
): Promise<never> {
  const cwdArg = getArg("--cwd")
  const allowLocal = allowLocalSubcommand(args)
  const sub = args[1]
  if (hasHelpFlag(args)) {
    out(SKILLS_HELP)
    process.exit(0)
  }
  if (sub === "list" || sub === undefined) {
    const all = await loadSkills(cwdArg, { allowLocal })
    if (all.length === 0) {
      out(
        c.dim(
          allowLocal
            ? "(no skills yet - add markdown files in .minicode/skills/*.md)"
            : "(no global skills - pass --allow-local-config to include project .minicode/skills)",
        ),
      )
      process.exit(0)
    }
    const tableData = all.map((s) => ({
      skill: c.yellow(`/${sanitizeAnsiLine(s.name)}`),
      desc: sanitizeAnsiLine(s.description || "(no description)"),
    }))
    out(
      `\n${c.bold("Installed Skills")}\n` +
        renderTable(
          [
            { header: "Command", key: "skill", width: 18 },
            { header: "Description", key: "desc", width: 56 },
          ],
          tableData,
        ) +
        "\n",
    )
    process.exit(0)
  }
  if (sub === "show") {
    const name = positionalSubArg(args, 2)
    if (!name) {
      err("usage: minicode skills show <name>")
      process.exit(2)
    }
    const s = await findSkill(name, cwdArg, { allowLocal })
    if (!s) {
      err(`skill "${sanitizeAnsiLine(name)}" not found - see: minicode skills list`)
      process.exit(1)
    }
    out(
      `${c.bold(c.cyan(`/${sanitizeAnsiLine(s.name)}`))} ${c.dim(`- ${sanitizeAnsiLine(s.description)}`)}\n\n${sanitizeAnsi(s.body)}`,
    )
    process.exit(0)
  }
  err(`unknown skills subcommand: ${sanitizeAnsiLine(sub)}\n`)
  out(SKILLS_HELP)
  process.exit(2)
}
