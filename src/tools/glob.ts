import { stat } from "node:fs/promises"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { loadIgnoreMatchers } from "../lib/ignore.ts"
import { resolveSearchRoot, walkWorkspaceFiles } from "./context.ts"

export function globToRegExp(glob: string): RegExp {
  // Sentinel brace/rekursif dulu memakai NUL byte (`\0`); karakter NUL literal
  // dari input JSON bisa menabrak sentinel dan menyuntik sintaks RegExp. Tolak
  // NUL upfront lalu pakai pemindaian karakter sederhana agar bebas benturan.
  if (glob.includes("\0")) {
    throw new Error("glob pattern must not contain NUL bytes")
  }
  // Lipat rantai `**` / `**/` berulang agar tidak memicu catastrophic backtracking
  // pada regex hasil kompilasi (mis. `**/**/**/**/**/**/**/**/**/x`).
  const collapsed = glob.replace(/\*{2,}/g, "**").replace(/(?:\*\*\/){2,}/g, "**/")
  // Tangani brace expansion {a,b} tanpa sentinel NUL
  const BRACE_START = "\uE000"
  const BRACE_OR = "\uE001"
  const BRACE_END = "\uE002"
  const REC_MARK = "\uE003"
  const cleanCollapsed = collapsed.replace(
    /[\uE000-\uE003]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
  const str = cleanCollapsed.replace(/\{([^{}]+)\}/g, (_m, inner: string) => {
    const alts = inner.split(",").map((s) => s.trim())
    return `${BRACE_START}${alts.join(BRACE_OR)}${BRACE_END}`
  })
  let esc = str.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  esc = esc.replaceAll(BRACE_START, "(")
  esc = esc.replaceAll(BRACE_OR, "|")
  esc = esc.replaceAll(BRACE_END, ")")
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
  esc = esc.replace(/§§\//g, REC_MARK)
  esc = esc.replace(/\*/g, "[^/]*")
  esc = esc.replace(/§§/g, ".*")
  esc = esc.replace(/\?/g, ".")
  esc = esc.replaceAll(REC_MARK, "(?:.*/)?")
  return new RegExp(`^${esc}$`)
}

export const globTool: Tool = {
  name: "glob",
  // v7.33 (wire contract): tag family untuk grouping di model.
  description:
    "FILE SEARCH: Find files by glob pattern (e.g. **/*.ts). Returns relative paths, capped at 100 by default; skips .git, node_modules and dotfiles (set includeDotfiles:true for .github/.eslintrc/etc.).",
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
        preFilter: ({ rel, name }) => re.test(rel) || re.test(name),
      },
      ({ rel }) => {
        out.push(rel)
      },
    )
    // v7.33 (wire contract): beri langkah lanjutan saat kosong, jangan biarkan
    // model mengulang pola/cwd yang sama tanpa perubahan.
    if (out.length === 0) return `no files match ${pattern} in ${rawRoot} — verify pattern and cwd`
    // v7.32 (L4): readdir/context walker mengembalikan urutan tergantung FS —
    // tanpa sort hasil berubah-ubah antar mesin dan limit memotong file yang
    // berbeda. Sort dulu supaya output deterministik sebelum dipotong.
    out.sort()
    return out.slice(0, lim).join("\n")
  },
}
