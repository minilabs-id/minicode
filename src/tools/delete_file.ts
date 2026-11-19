import { stat } from "node:fs/promises"
import type { Tool } from "#minicore"
import { resolveSafePath } from "../lib/safe-open.ts"
import { trashFile } from "../lib/trash.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

export const deleteFileTool: Tool = {
  name: "delete_file",
  // v7.33 (wire contract): tag family + satukan deskripsi path (workspace).
  description:
    "FILE EDIT: Delete a file (soft-delete to .minicode/.trash/; restore via move_file).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace root" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    // Verifikasi path terpusat (logis + target nyata) — detail di safe-open.ts.
    const { abs, real } = await resolveSafePath(p, root, relaxed)
    const st = await stat(real).catch(() => null)
    if (!st) throw new Error(`file not found: ${p}`)
    if (st.isDirectory())
      throw new Error(`path is a directory, cannot delete directories with delete_file: ${p}`)
    // soft-delete ke .minicode/.trash (gitignored, cap 100) — restore via move_file
    const dest = await trashFile(root, abs)
    return `deleted ${p} -> ${dest} (soft-delete, restore via move_file if needed)`
  },
}
