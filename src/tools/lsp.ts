import { isAbsolute, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Tool } from "#minicore"
import { LIMITS, LSP_SYMBOL_KINDS } from "../constants.ts"
import { atomicWriteText } from "../lib/atomic-write.ts"
import { assertSafeWriteTarget, resolveSafePath, safeReadFile } from "../lib/safe-open.ts"
import {
  findSymbolPosition,
  getConfiguredExts,
  lspCall,
  lspDiagnostics,
  workspaceSymbols,
} from "../lsp/client.ts"
import {
  isOwnedState,
  isOwnedStateReal,
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
} from "../policy/jail.ts"
import { scrubSecrets } from "../policy/scrub.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

const SEVERITY = ["Error", "Warn", "Info", "Hint"]

/**
 * v7.33 (wire contract): satu kalimat posisi untuk definition/references/hover.
 * Verifikasi terhadap implementasi: argumen `line`/`character` = 0-based
 * (diteruskan apa adanya sebagai LSP `position`), sedangkan `formatPos()`
 * menambah +1 pada line dan character → keluaran 1-based. Jadi klaim ini jujur.
 */
const POSITION_NOTE =
  "Supply `symbol` for name lookup, or 0-based `line`/`character` for a precise position. Output positions are 1-based."

// Balapan request LSP melawan abort: server daemon tetap hidup (seperti MCP
// stdio), tetapi tool berhenti menunggu — late result tidak kembali sebagai
// success ke turn yang sudah dibatalkan.
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"))
  let onAbort: (() => void) | undefined
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      onAbort = () => rej(signal.reason ?? new Error("aborted"))
      signal.addEventListener("abort", onAbort, { once: true })
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  })
}

function toUri(abs: string): string {
  return pathToFileURL(abs).href
}

// v7.38 (wire contract): argumen `file` DISATUKAN menjadi `path` di semua tool
// LSP. Nama helper internal ikut diganti supaya tak ada call site yang masih
// mengira field wire-nya `file`. Pesan error sengaja mempertahankan substring
// "outside workspace" agar test jail lama tetap hijau.
async function readTarget(
  path: string,
  cwd: string,
  relaxed = false,
): Promise<{ abs: string; text: string }> {
  if (!relaxed && isPathOutsideRoot(path, cwd)) throw new Error(`path outside workspace: ${path}`)
  if (isSensitive(path)) throw new Error(`blocked sensitive file: ${path}`)
  const abs = isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path)
  if (!relaxed && isRealPathOutsideRoot(abs, cwd))
    throw new Error(`path outside workspace: ${path}`)
  // Baca via safeReadFile (O_NOFOLLOW + verifikasi ulang target saat open):
  // readFile biasa membuka hasil realpath LAMA sehingga swap symlink di
  // antara cek dan baca lolos + membaca target sensitif. relevan ganda di
  // jalur MCP yang permission handler-nya minim (tanpa pre-check jail).
  const text = await safeReadFile(abs, cwd, relaxed)
  return { abs, text }
}

function formatPos(p: unknown): string {
  const r = p as {
    range?: { start?: { line?: number; character?: number } }
    uri?: string
    targetUri?: string
  }
  const uri = r.uri ?? r.targetUri ?? "?"
  const line =
    r.range?.start?.line != null
      ? `:${(r.range.start.line ?? 0) + 1}:${(r.range.start.character ?? 0) + 1}`
      : ""
  return `${uri}${line}`
}

interface PosArgs {
  path: string
  symbol?: string
  line?: number
  character?: number
}

async function resolvePosition(
  args: PosArgs,
  cwd: string,
  relaxed = false,
): Promise<{ abs: string; text: string; position: { line: number; character: number } } | string> {
  if (getConfiguredExts().length === 0)
    return "(no LSP servers configured — add via minicode config lsp add)"
  const { abs, text } = await readTarget(args.path, cwd, relaxed)
  let position: { line: number; character: number } | null = null
  if (args.line != null) position = { line: args.line, character: args.character ?? 0 }
  else if (args.symbol) position = findSymbolPosition(text, args.symbol)
  if (!position) return `[lsp] symbol '${args.symbol}' not found in ${args.path}`
  return { abs, text, position }
}

export function formatHover(result: unknown): string {
  const c = (result as { contents?: unknown })?.contents
  const txt =
    typeof c === "object" && c !== null && "value" in (c as Record<string, unknown>)
      ? String((c as Record<string, unknown>).value)
      : typeof c === "string"
        ? c
        : JSON.stringify(c)
  // Temuan audit #02: slice diam-diam tampak utuh — tandai bila dipotong.
  return txt.length > 4_000
    ? `${txt.slice(0, 4_000)}\n… [truncated: hover too long]`
    : txt || "(empty hover)"
}

// Potong daftar lokasi dengan penanda (def/refs tak boleh tampak lengkap).
// Diekspor untuk test (perilaku cap adalah kontrak audit #02).
export function capLocations(lines: string[], limit: number): string {
  if (lines.length <= limit) return lines.join("\n")
  return `${lines.slice(0, limit).join("\n")}\n… [truncated: showing first ${limit} of ${lines.length}]`
}

function posTool(
  name: string,
  method: string,
  describe: string,
  extraParams: Record<string, unknown> = {},
  limit = 50,
): Tool {
  return {
    name,
    description: describe,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path relative to the workspace root" },
        symbol: {
          type: "string",
          description: "symbol name in the file (alternative to line/character)",
        },
        line: { type: "number", description: "0-based line (optional)" },
        character: { type: "number", description: "0-based column (optional)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      ctx.signal.throwIfAborted()
      const cwd = requireToolCwd(ctx)
      try {
        const resolved = await resolvePosition(args as PosArgs, cwd, contextUnrestricted(ctx))
        if (typeof resolved === "string") return resolved
        const { abs, text, position } = resolved
        const result = await raceAbort(
          lspCall(
            abs,
            text,
            method,
            {
              textDocument: { uri: toUri(abs) },
              position,
              ...extraParams,
            },
            cwd,
          ),
          ctx.signal,
        )
        if (!result || (Array.isArray(result) && result.length === 0)) return "(not found)"
        if (method === "textDocument/hover") return scrubSecrets(formatHover(result))
        if (Array.isArray(result)) return scrubSecrets(capLocations(result.map(formatPos), limit))
        return scrubSecrets(formatPos(result))
      } catch (e) {
        // v7.32: kegagalan (abort/head-of-penjara) WAJIB jadi isError. Dulu
        // setiap catch dibungkus string `[lsp] …` sehingga kernel menandainya
        // sukses (isError=false) dan model mengira panggilan berhasil. Sentinel
        // "not found"/"(not found)" di atas sengaja tetap string sukses.
        ctx.signal.throwIfAborted()
        throw e
      }
    },
  }
}

export const lspDiagnosticsTool: Tool = {
  name: "lsp_diagnostics",
  // v7.33 (wire contract): tag family + hapus pengulangan "Params: file".
  description:
    "LSP: Diagnostics (errors/warnings) for one file from the language server. Requires a registered LSP server for the file extension.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path relative to the workspace root" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = requireToolCwd(ctx)
    try {
      const { abs, text } = await readTarget(String(path), cwd, contextUnrestricted(ctx))
      const { items } = await raceAbort(lspDiagnostics(abs, text, undefined, cwd), ctx.signal)
      // v7.33 (wire contract): sentinel kosong dibubuhi langkah lanjutan.
      // CATATAN: test lama `audit-fix-tool-errors.test.ts` mem-pin teks persis
      // "(no diagnostics)" — pemilik test perlu mengupdate ke `toContain`.
      if (!items.length)
        return "(no diagnostics) — confirm an LSP server is configured for this extension; cross-check with project typechecker"
      const lines = items.map((d) => {
        const dd = d as {
          range?: { start?: { line?: number; character?: number } }
          severity?: number
          message?: string
          source?: string
        }
        const sev = SEVERITY[(dd.severity ?? 1) - 1] ?? "?"
        const pos = `${(dd.range?.start?.line ?? 0) + 1}:${(dd.range?.start?.character ?? 0) + 1}`
        return `${pos} [${sev}] ${dd.message}${dd.source ? ` (${dd.source})` : ""}`
      })
      // M3: cap seperti def/refs — daftar diagnostik raksasa tak boleh
      // tampak utuh (kontrak cap #02). 50 sejajar batas definitions.
      return scrubSecrets(capLocations(lines, 50))
    } catch (e) {
      // v7.32: error wajib isError; jangan kembali sebagai string sukses.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}

export const lspDefinitionTool = posTool(
  "lsp_definition",
  "textDocument/definition",
  `LSP: Location of a symbol definition (file + line). ${POSITION_NOTE}`,
)

export const lspReferencesTool = posTool(
  "lsp_references",
  "textDocument/references",
  `LSP: All references to a symbol in the repo (file + line). ${POSITION_NOTE}`,
  { context: { includeDeclaration: true } },
  100,
)

export const lspHoverTool = posTool(
  "lsp_hover",
  "textDocument/hover",
  `LSP: Hover info and type signature for a symbol. ${POSITION_NOTE}`,
)

export const lspSymbolsTool: Tool = {
  name: "lsp_symbols",
  // v7.33: nomor baris keluaran sudah di-+1 di bawah (1-based).
  description:
    "LSP: Document symbol outline (functions/classes/variables) for one file; output lines are 1-based.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path relative to the workspace root" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = requireToolCwd(ctx)
    try {
      const { abs, text } = await readTarget(String(path), cwd, contextUnrestricted(ctx))
      const result = await raceAbort(
        lspCall(
          abs,
          text,
          "textDocument/documentSymbol",
          {
            textDocument: { uri: toUri(abs) },
          },
          cwd,
        ),
        ctx.signal,
      )
      // v7.33 (wire contract): sentinel kosong dibubuhi langkah lanjutan.
      if (!result || !Array.isArray(result) || result.length === 0)
        return "(no symbols) — confirm an LSP server is configured for this extension; cross-check with project typechecker"
      const KIND = LSP_SYMBOL_KINDS
      const lines = result.map((s) => {
        const sym = s as { name?: string; kind?: number; range?: { start?: { line?: number } } }
        const kind = KIND[(sym.kind ?? 1) - 1] ?? "?"
        const line = (sym.range?.start?.line ?? 0) + 1
        return `${line}: [${kind}] ${sym.name}`
      })
      // M3: outline simbol pun ikut cap (100, sejajar references) supaya
      // pemotongan selalu ditandai — bukan join penuh yang tampak lengkap.
      return scrubSecrets(capLocations(lines, 100))
    } catch (e) {
      // v7.32: error wajib isError; jangan kembali sebagai string sukses.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}

export const lspWorkspaceSymbolsTool: Tool = {
  name: "lsp_workspace_symbols",
  // v7.33 (wire contract): tag family LSP, isi dipadatkan.
  description:
    "LSP: Search symbols across the workspace (workspace/symbol); an empty query returns popular symbols. Requires a configured LSP server.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "symbol keyword, empty for all" } },
    required: [],
    additionalProperties: false,
  },
  async execute({ query }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = requireToolCwd(ctx)
    if (getConfiguredExts().length === 0)
      return "(no LSP servers configured — add via minicode config lsp add)"
    try {
      const symbols = await raceAbort(
        workspaceSymbols((query as string) ?? "", 5000, cwd),
        ctx.signal,
      )
      // v7.33 (wire contract): samakan petunjuk dengan lsp_symbols.
      if (!symbols.length)
        return "(no symbols) — confirm an LSP server is configured for this extension; cross-check with project typechecker"
      const KIND = LSP_SYMBOL_KINDS
      const rows = symbols.map((s) => {
        const kind = KIND[(s.kind ?? 1) - 1] ?? "?"
        const uri = s.location.uri ?? "?"
        return `[${kind}] ${s.name}${s.containerName ? ` (${s.containerName})` : ""} — ${uri}`
      })
      return scrubSecrets(capLocations(rows, 50))
    } catch (e) {
      // v7.32: error wajib isError; jangan kembali sebagai string sukses.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}

/**
 * v7.38: offset LSP (line/character 0-based, UTF-16) → offset string JS.
 * `\r` dari CRLF ikut terhitung karena tiap baris dipecah hanya pada `\n`.
 */
function renameOffset(text: string, line: number, character: number): number {
  const lines = text.split("\n")
  if (line < 0 || line >= lines.length)
    throw new Error(`lsp_rename: edit line ${line} di luar jangkauan`)
  if (character < 0 || character > lines[line]!.length)
    throw new Error(`lsp_rename: edit character ${character} di luar jangkauan`)
  let off = 0
  for (let i = 0; i < line; i++) off += lines[i]!.length + 1
  return off + character
}

// Audit deep: WorkspaceEdit berasal dari server LSP = input tak terpercaya.
// `newName` pengguna sudah dibatasi 200 char, tapi `newText` per edit bisa
// disuntik sampai ~5MB oleh server. Batasi per edit SEBELUM apply; total per
// file memakai pagu tulis yang sama dengan pemeriksaan hasil akhir.
const RENAME_MAX_EDIT_NEWTEXT = LIMITS.LSP_RENAME_MAX_NAME_CHARS * 4

interface RenameTextEdit {
  range?: {
    start?: { line?: number; character?: number }
    end?: { line?: number; character?: number }
  }
  newText?: string
}

interface RenameBatch {
  real: string
  text: string
  edits: { start: number; end: number; newText: string }[]
}

/**
 * v7.38: `lsp_rename` = SATU-SATUNYA tool LSP yang menulis workspace.
 * Klien TIDAK pernah mengklaim kapabilitas rename secara statis: ia memanggil
 * `textDocument/rename`, lalu hanya menulis bila server benar-benar mengirim
 * WorkspaceEdit. Tanpa server / tanpa edit / operasi selain edit → isError
 * (fail-closed). Kontrak WORKSPACE_MUTATION + jail per-file dipakai (lihat
 * tool-contract.ts); `LSP_WIRE_TOOLS` menyembunyikannya saat tak ada server.
 */
export const lspRenameTool: Tool = {
  name: "lsp_rename",
  description:
    "LSP: WRITE — Rename a symbol across the workspace via textDocument/rename and apply the returned WorkspaceEdit. Requires a configured LSP server that supports rename; if the server returns no edit the call FAILS rather than faking success. Gated like git_commit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "file path relative to the workspace root" },
      symbol: {
        type: "string",
        description: "symbol name to rename (alternative to line/character)",
      },
      newName: { type: "string", description: "replacement symbol name" },
      line: { type: "number", description: "0-based line (optional)" },
      character: { type: "number", description: "0-based column (optional)" },
    },
    required: ["path", "newName"],
    additionalProperties: false,
  },
  async execute({ path, symbol, newName, line, character }, ctx) {
    ctx.signal.throwIfAborted()
    const cwd = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    // H1 (v7.32): tanpa server terdaftar, lemparkan error — jangan pernah
    // mengembalikan string "renamed" yang dibaca model sebagai keberhasilan.
    if (getConfiguredExts().length === 0)
      throw new Error("lsp_rename: no LSP servers configured — add via minicode config lsp add")
    try {
      const target = String(path ?? "")
      const next = String(newName ?? "").trim()
      if (!next) throw new Error("lsp_rename: newName is required")
      if (next.length > LIMITS.LSP_RENAME_MAX_NAME_CHARS)
        throw new Error(
          `lsp_rename: newName terlalu panjang (max ${LIMITS.LSP_RENAME_MAX_NAME_CHARS})`,
        )
      if (/[\0\r\n]/.test(next))
        throw new Error("lsp_rename: newName mengandung karakter terlarang")

      const { abs, text } = await readTarget(target, cwd, relaxed)
      let position: { line: number; character: number } | null = null
      if (line != null) position = { line: Number(line), character: Number(character ?? 0) }
      else if (symbol) position = findSymbolPosition(text, String(symbol))
      if (!position)
        throw new Error(`lsp_rename: symbol '${String(symbol)}' not found in ${target}`)

      const result = await raceAbort(
        lspCall(
          abs,
          text,
          "textDocument/rename",
          { textDocument: { uri: toUri(abs) }, position, newName: next },
          cwd,
        ),
        ctx.signal,
      )
      // Server tak mengembalikan WorkspaceEdit = rename tak didukung untuk
      // simbol ini. Jangan mengarang kapabilitas atau mengembalikan sukses.
      if (!result || typeof result !== "object")
        throw new Error("lsp_rename: server returned no WorkspaceEdit (rename not supported)")
      const we = result as {
        changes?: Record<string, RenameTextEdit[]>
        documentChanges?: {
          kind?: string
          textDocument?: { uri?: string }
          edits?: RenameTextEdit[]
        }[]
      }
      const byUri = new Map<string, RenameTextEdit[]>()
      if (we.changes && typeof we.changes === "object") {
        for (const [uri, edits] of Object.entries(we.changes)) {
          if (Array.isArray(edits)) byUri.set(uri, edits)
        }
      }
      for (const dc of Array.isArray(we.documentChanges) ? we.documentChanges : []) {
        // create/delete/move file di luar authority tool — tolak, jangan
        // diam-diam mengabaikan (itu akan menyisakan workspace setengah rename).
        if (dc?.kind !== undefined && dc.kind !== "edit")
          throw new Error(`lsp_rename: unsupported WorkspaceEdit operation '${dc.kind}'`)
        const uri = dc?.textDocument?.uri
        if (uri && Array.isArray(dc.edits)) byUri.set(uri, [...(byUri.get(uri) ?? []), ...dc.edits])
      }
      if (byUri.size === 0)
        throw new Error("lsp_rename: empty WorkspaceEdit (rename not supported for this symbol)")

      const batches: RenameBatch[] = []
      let totalEdits = 0
      for (const [uri, edits] of byUri) {
        ctx.signal.throwIfAborted()
        if (!uri.startsWith("file:")) throw new Error(`lsp_rename: unsupported URI '${uri}'`)
        const absTarget = fileURLToPath(uri)
        // WorkspaceEdit berasal dari server (input tak terpercaya): setiap
        // target WAJIB lolos jail path/logis sebelum boleh ditulis.
        const { real } = await resolveSafePath(absTarget, cwd, relaxed)
        if (!relaxed && (isOwnedState(absTarget) || isOwnedStateReal(absTarget, cwd)))
          throw new Error(`lsp_rename: blocked owned state: ${absTarget}`)
        // Audit deep: validasi target tulis di FASE PERSIAPAN untuk SEMUA file.
        // Dulu pengecekan ini ada di loop tulis, sehingga file sebelumnya
        // sudah tertimpa saat file berikutnya ternyata tak bisa ditulis.
        await assertSafeWriteTarget(real, cwd, relaxed)
        const current = await safeReadFile(real, cwd, relaxed)
        const prepared: RenameBatch["edits"] = []
        let fileNewTextTotal = 0
        for (const e of edits) {
          const s = e?.range?.start
          const en = e?.range?.end
          if (!s || !en) throw new Error("lsp_rename: edit tanpa range ditolak")
          const start = renameOffset(current, Number(s.line), Number(s.character))
          const end = renameOffset(current, Number(en.line), Number(en.character))
          if (end < start) throw new Error("lsp_rename: range terbalik")
          // Audit deep: server bisa mengirim newText sebesar apa pun. Batasi
          // per edit dan akumulasi per file SEBELUM ada satu pun tulisan.
          const newText = typeof e.newText === "string" ? e.newText : ""
          if (newText.length > RENAME_MAX_EDIT_NEWTEXT)
            throw new Error(
              `lsp_rename: newText terlalu panjang (max ${RENAME_MAX_EDIT_NEWTEXT}) per edit`,
            )
          fileNewTextTotal += newText.length
          if (fileNewTextTotal > LIMITS.WRITE_FILE_MAX_CHARS)
            throw new Error("lsp_rename: total newText per file terlalu besar")
          prepared.push({ start, end, newText })
        }
        // Terapkan dari belakang supaya offset awal tak bergeser; tolak overlap.
        prepared.sort((a, b) => b.start - a.start || b.end - a.end)
        let lastStart = Number.POSITIVE_INFINITY
        for (const e of prepared) {
          if (e.end > lastStart) throw new Error("lsp_rename: edit saling overlap — ditolak")
          lastStart = e.start
        }
        totalEdits += prepared.length
        if (totalEdits > LIMITS.LSP_RENAME_MAX_EDITS)
          throw new Error(`lsp_rename: terlalu banyak edit (max ${LIMITS.LSP_RENAME_MAX_EDITS})`)
        batches.push({ real, text: current, edits: prepared })
      }
      // Audit deep: tulis file satu per satu, tapi bila ada yang gagal
      // kembalikan file yang sudah tertulis ke isi semula. Rename setengah
      // jadi (sebagian file berubah) lebih berbahaya daripada tak berubah
      // sama sekali — model mengira operasi atomik padahal tidak.
      const written: { real: string; text: string }[] = []
      try {
        for (const b of batches) {
          ctx.signal.throwIfAborted()
          let out = b.text
          for (const e of b.edits) out = out.slice(0, e.start) + e.newText + out.slice(e.end)
          if (out.length > LIMITS.WRITE_FILE_MAX_CHARS)
            throw new Error("lsp_rename: hasil rename terlalu besar")
          await atomicWriteText(b.real, out)
          written.push({ real: b.real, text: b.text })
        }
      } catch (e) {
        // Rollback best-effort: kegagalan restore tak boleh menimpa error
        // asli yang lebih informatif bagi pemanggil.
        for (const w of written) await atomicWriteText(w.real, w.text).catch(() => {})
        throw e
      }
      return `renamed ${String(symbol ?? "symbol")} -> ${next} in ${batches.length} file(s), ${totalEdits} edit(s)`
    } catch (e) {
      // v7.32: error wajib isError; abort di tengah tak boleh jadi sukses.
      ctx.signal.throwIfAborted()
      throw e
    }
  },
}
