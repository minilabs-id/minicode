import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { commitSafeTextEdit, readSafeTextForEdit } from "./context.ts"
import { flexibleMatch } from "./edit.ts"

// Apply SEARCH/REPLACE block (a la Aider) ke file. Search block harus match
// tepat sekali (dengan toleransi fuzzy). Bisa multiple patches.
export const applyPatchTool: Tool = {
  name: "apply_patch",
  // v7.33: kalimat keputusan identik dengan edit.ts & write_file.ts (wire
  // contract). Jangan diubah sendiri-sendiri — test audit membandingkannya.
  description:
    "FILE EDIT: Apply SEARCH/REPLACE block(s) to one file (max 50 blocks, applied sequentially). 1 change → edit; ≥2 changes in one file → apply_patch; full rewrite/new file → write_file. Every search block must match exactly once — add surrounding lines if ambiguous. Cannot edit outside the workspace or secrets (.env, .ssh, node_modules). Editing .minicode/ state is ALLOWED by owner decision (2026-11-23) — be careful not to overwrite sessions.db or config; .minicode/hooks/ stays blocked.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace" },
      patches: {
        type: "array",
        description: "Array of {search, replace} blocks. Applied sequentially to the same content.",
        items: {
          type: "object",
          properties: {
            search: {
              type: "string",
              description: "code block to be replaced (exact or fuzzy match)",
            },
            replace: { type: "string", description: "replacement code block" },
          },
          required: ["search", "replace"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "patches"],
    additionalProperties: false,
  },
  async execute({ path, patches }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    let { root, realAbs, content } = await readSafeTextForEdit(p, ctx)
    const patchList = patches as { search: string; replace: string }[]
    if (patchList.length > 50) throw new Error(`too many patches: ${patchList.length} (max 50)`)
    const applied: string[] = []
    let changedCount = 0

    for (let i = 0; i < patchList.length; i++) {
      ctx.signal.throwIfAborted()
      const { search: oldS, replace: newS } = patchList[i]!
      if (oldS === newS) {
        applied.push(`[${i}] skipped: oldString == newString`)
        continue
      }
      const match = flexibleMatch(content, oldS)
      if (!match) throw new Error(`patch[${i}]: search block not found in ${p}`)
      // ensure uniqueness untuk semua mode
      const second = flexibleMatch(content.slice(match.end), oldS)
      if (second) {
        throw new Error(
          `patch[${i}]: search block found multiple times in ${p} — provide more context`,
        )
      }
      content = content.slice(0, match.start) + newS + content.slice(match.end)
      if (content.length > LIMITS.WRITE_FILE_MAX_CHARS)
        throw new Error(`result too large after patch[${i}]: ${content.length} chars (max 5M)`)
      const note = match.mode !== "exact" ? ` (${match.mode} match)` : ""
      applied.push(`[${i}] replaced ${oldS.length} → ${newS.length} chars${note}`)
      changedCount++
    }

    if (changedCount === 0) {
      return `no changes written to ${realAbs} (all patches skipped):\n${applied.join("\n")}`
    }

    return await commitSafeTextEdit(
      realAbs,
      root,
      content,
      `applied ${applied.length} patch(es) to ${realAbs}:\n${applied.join("\n")}`,
    )
  },
}
