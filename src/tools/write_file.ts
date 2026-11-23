import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { assertSafeWriteTarget, resolveSafePath } from "../lib/safe-open.ts"
import { appendLspDiagnostics } from "../policy/verifier.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

export const writeFileTool: Tool = {
  name: "write_file",
  // v7.33: kalimat keputusan identik dengan edit.ts & patch.ts (wire
  // contract). Catatan jail/cap dipertahankan — hanya aturan pilih-tool yang
  // disatukan supaya model tak melihat tiga nasihat yang saling bertentangan.
  description:
    "FILE EDIT: Create or overwrite a file with full text content (atomic, creates parent dirs, max 5M chars). 1 change → edit; ≥2 changes in one file → apply_patch; full rewrite/new file → write_file. Every search block must match exactly once — add surrounding lines if ambiguous. Cannot write outside the workspace or to secrets (.env, .ssh, node_modules). Writing .minicode/ state is ALLOWED by owner decision (2026-11-23) — be careful not to overwrite sessions.db or config; .minicode/hooks/ stays blocked.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "path relative to the workspace (e.g. src/a.ts)" },
      content: { type: "string", description: "full file content to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute({ path, content }, ctx) {
    ctx.signal.throwIfAborted()
    const p = path as string
    const root = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    // Verifikasi path terpusat (logis + target nyata) — detail di safe-open.ts.
    const { real: realAbs } = await resolveSafePath(p, root, relaxed)
    // Tolak menimpa symlink final (swap antara cek dan tulis gagal tutup).
    await assertSafeWriteTarget(resolve(root, p), root, relaxed)
    // guard large write — chars vs bytes (emoji/CJK 4x)
    const c = content as string
    if (c.length > LIMITS.WRITE_FILE_MAX_CHARS)
      throw new Error(`content too large: ${c.length} chars (max 5M)`)
    if (Buffer.byteLength(c, "utf8") > LIMITS.WRITE_FILE_MAX_CHARS * 4)
      throw new Error(`content too large: ${Buffer.byteLength(c, "utf8")} bytes > ~20M`)
    // atomic: write tmp (O_EXCL + randomUUID) then rename — anti-hijack & atomic
    await atomicWriteText(realAbs, c)
    const st = await stat(realAbs).catch(() => null)
    const base = `wrote ${realAbs} (${st?.size ?? c.length} bytes)`
    return await appendLspDiagnostics(realAbs, c, base, undefined, root)
  },
}
