import { stat } from "node:fs/promises"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { loadIgnoreMatchers } from "../lib/ignore.ts"
import { resolveSearchRoot, walkWorkspaceFiles } from "./context.ts"

export function globToRegExp(glob: string): RegExp {
  // Tangani brace expansion {a,b} tanpa double-escape
  const str = glob.replace(/\{([^{}]+)\}/g, (_m, inner: string) => {
    const alts = inner.split(",").map((s) => s.trim())
    return `\0BRACE_START\0${alts.join("\0BRACE_OR\0")}\0BRACE_END\0`
  })
  let esc = str.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  esc = esc.replace(/\0BRACE_START\0/g, "(")
  esc = esc.replace(/\0BRACE_OR\0/g, "|")
  esc = esc.replace(/\0BRACE_END\0/g, ")")
  esc = esc.replace(/\*\*/g, "§§")
  // **/ di awal/pola rekursif harus cocok file root juga: **/* sekarang jadi
  // (?:.*/)?[^/]*, bukan .*/[^/]* yang butuh slash dan membuat root kosong.
  //
  // Penting: fragmen rekursif HARUS dipasang SESUDAH substitusi `*`→`[^/]*`
  // dan `?`→`.` di bawah. Kalau dipasang lebih awal, `*` di dalamnya ikut
  // ditulis ulang jadi `[^/]*` dan `?` (quantifier) jadi `.` — hasilnya
  // `(.[^/]*\/)`: grup WAJIB yang butuh satu karakter tambahan. Akibatnya
  // `**/*.ts` tak lagi cocok file di root maupun direktori depth >= 2, dan
  // `src/**/*.ts` tak lagi cocok file langsung di `src/`. Placeholder yang
  // sama seperti brace expansion di atas.
  esc = esc.replace(/§§\//g, "\0REC\0")
  esc = esc.replace(/\*/g, "[^/]*")
  esc = esc.replace(/§§/g, ".*")
  esc = esc.replace(/\?/g, ".")
  esc = esc.replace(/\0REC\0/g, "(?:.*/)?")
  return new RegExp(`^${esc}$`)
}

export const globTool: Tool = {
  name: "glob",
  description:
    "Search files with a glob pattern (e.g. **/*.ts, src/**/*.js). Returns relative paths, capped at 100 by default. Skips .git, node_modules, and dotfiles by default (set includeDotfiles:true for .github/.eslintrc/etc.).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob pattern (e.g. **/*.ts)" },
      cwd: { type: "string", description: "root directory (default: workspace root)" },
      limit: { type: "number", description: "max results (default 100)" },
      includeDotfiles: {
        type: "boolean",
        description: "include dotfiles/dotdirs like .github or .eslintrc (default false)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute({ pattern, cwd, limit, includeDotfiles }, ctx) {
    const { root, rawRoot, relaxed } = resolveSearchRoot(cwd, ctx)
    const st = await stat(root).catch(() => null)
    if (!st?.isDirectory()) return `cwd not found: ${rawRoot}`
    const rawLim = limit as number | undefined
    const lim = Number.isFinite(rawLim)
      ? Math.min(Math.max(Math.floor(rawLim!), 1), LIMITS.SEARCH_MAX_LIMIT)
      : LIMITS.SEARCH_DEFAULT_LIMIT
    const re = globToRegExp(pattern as string)
    const ignoreMatchers = await loadIgnoreMatchers(root)
    const out: string[] = []
    await walkWorkspaceFiles(
      {
        dir: root,
        root,
        signal: ctx.signal,
        ignoreMatchers,
        relaxed,
        includeDotfiles: includeDotfiles === true,
        shouldStop: () => out.length >= lim,
      },
      ({ rel, name }) => {
        if (re.test(rel) || re.test(name)) out.push(rel)
      },
    )
    if (out.length === 0) return `no files match ${pattern} in ${rawRoot}`
    return out.slice(0, lim).join("\n")
  },
}
