import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { dockerAvailable, runInDocker } from "../sandbox/docker.ts"
import { osSandboxAvailable, runInOsSandbox } from "../sandbox/os.ts"
import { capMarked } from "./bash.ts"
import { requireToolCwd } from "./context.ts"

// code_run: snippet python/node dieksekusi LEWAT sandbox runner (docker atau
// OS sandbox), bukan spawn host langsung — versi lama hanya mengecek env flag
// lalu spawn host tanpa isolasi (klaim "sandboxed" yang salah).
//
// Batasan jujur:
// - Backend HARUS tersedia; flag tanpa backend = tolak (fail-closed, tanpa
//   fallback diam-diam ke host).
// - docker image default (node:22-alpine) membawa node, bukan python3 —
//   python butuh MINICODE_SANDBOX_IMAGE yang menyediakannya.
// - Timeout/abort meminta daemon menghapus container bernama; hasil cleanup
//   dilaporkan, tetapi tetap best-effort bila daemon tak merespons.

/** Escape untuk disisip sebagai satu argumen single-quoted di `sh -c`. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export const codeRunTool: Tool = {
  name: "code_run",
  description:
    "Run a code snippet (python -c / node -e) inside the configured sandbox (Docker, Linux bwrap, or macOS seatbelt — network-isolated). Requires MINICODE_SANDBOX=os|docker with an available backend (unavailable natively on Windows without Docker); refuses otherwise. Python needs an image/environment containing python3.",
  parameters: {
    type: "object",
    properties: {
      lang: { type: "string", enum: ["python", "node"], description: "runtime" },
      code: { type: "string", description: "snippet to run" },
      timeout: { type: "number", description: "ms, default 10000" },
    },
    required: ["lang", "code"],
    additionalProperties: false,
  },
  async execute({ lang, code, timeout }, ctx) {
    ctx.signal.throwIfAborted()
    const sandbox = process.env.MINICODE_SANDBOX ?? ""
    if (sandbox !== "os" && sandbox !== "docker" && sandbox !== "bwrap" && sandbox !== "seatbelt") {
      throw new Error(
        `code_run requires MINICODE_SANDBOX=os|docker (current: ${sandbox || "none"})`,
      )
    }
    const src = code as string
    if (src.includes("\0")) throw new Error("code contains NUL byte")
    const root = requireToolCwd(ctx)
    const timeoutMs =
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : 10000
    // Tanpa shell perantara di sisi kita: kode jadi SATU argumen single-quoted
    // untuk `sh -c` runner — $()/backtick milik snippet, bukan shell luar.
    const inner =
      lang === "python" ? `python3 -c ${shSingleQuote(src)}` : `node -e ${shSingleQuote(src)}`
    // Fail-closed: backend yang diminta harus benar-benar ada. Fallback diam
    // ke eksekusi host akan mengkhianati janji sandbox.
    const runSandboxed =
      sandbox === "docker"
        ? () => {
            if (!dockerAvailable()) {
              throw new Error("code_run: MINICODE_SANDBOX=docker but docker is not available")
            }
            return runInDocker(inner, root, { timeoutMs, signal: ctx.signal })
          }
        : () => {
            if (!osSandboxAvailable()) {
              throw new Error(
                `code_run: MINICODE_SANDBOX=${sandbox} but no OS sandbox is available`,
              )
            }
            return runInOsSandbox(inner, root, { timeoutMs, signal: ctx.signal })
          }
    // Both runners own cancellation and remove their abort listeners on completion.
    const settled = await runSandboxed()
    ctx.signal.throwIfAborted()
    const text = capMarked(scrubSecrets(settled.output), LIMITS.BASH_OUTPUT_MAX_CHARS).trim()
    // code=null dari runner berarti proses tidak pernah melaporkan exit sendiri:
    // timeout (dan abort sudah dilempar di atas). Dulu hasil ini tampil sebagai
    // `exit unknown` tanpa menyebut timeout sama sekali — model tak bisa tahu
    // efeknya ambiguous. Sekarang dikembalikan dengan tag outcome yang sama
    // bentuknya dengan jalur bash, bukan sebagai error tak terduga.
    if (settled.code === null) {
      return (
        `[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT side_effect_tier=LOCAL_ENV_MUTATION ` +
        `timeout_ms=${timeoutMs}]\n` +
        `Sandboxed run was cut off by the ${timeoutMs} ms timeout. Its side effects are UNKNOWN ` +
        `(the snippet may have partially run). Do NOT re-run before inspecting workspace state.\n` +
        (text ? `--- partial output ---\n${text}` : "--- partial output ---\n(none)")
      )
    }
    if (settled.code !== 0) return `exit ${settled.code}\n${text}`
    return text
  },
}
