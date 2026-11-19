// Audit mendalam — regresi sesi & policy (v7.40).
// Satu file untuk mengunci sembilan perbaikan fail-closed yang saling terkait:
// idempotency, journal unlink, chmod sidecar SQLite, epoch takeover, jail LSP,
// visibilitas ask_user, lantai lease, scrub kredensial, dan komentar network.
//
// Hermetic: tidak memakai jaringan, tidak menjalankan gate penuh.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeUnavailableWireTools, workModeVisible } from "../src/app/tool-layer.ts"
import { LIMITS } from "../src/constants.ts"
import { scrubSecrets } from "../src/policy/scrub.ts"
import { SUB_AGENT_TIMEOUT_MIN_MS } from "../src/policy/subagent-timeout.ts"
import {
  FILE_JAIL_TOOL_NAMES,
  LSP_FILE_JAIL_TOOL_NAMES,
  TOOL_CONTRACTS,
} from "../src/policy/tool-contract.ts"
import { takeoverEpochUnderLease, UnexpectedEpochMoveError } from "../src/session/authority.ts"
import { deleteJournalFile, journalPath } from "../src/session/journal.ts"
import { SESSION_LEASE_MS } from "../src/task/session-authority.ts"

function tmpRoot(prefix = "mc-audit-deep-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows kadang menahan handle sebentar; OS yang membersihkan nanti.
  }
}

describe("F1 — idempotency: state tak dikenal fail-closed", () => {
  test("cabang idempotency memperlakukan SEMUA state non-terminal sebagai pending", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "session", "verification.ts"),
      "utf8",
    )
    const start = src.indexOf("export async function findIdempotentInvocation")
    const end = src.indexOf("const idempotentExecutions", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const loop = src.slice(start, end)
    // KENAPA source-level: `isRecordShape` menolak record mutation tanpa
    // `state` sebelum ia masuk `loaded.records`, jadi skenario `undefined`
    // tak bisa direproduksi lewat file jurnal. Yang dikunci di sini adalah
    // cabang fail-closed-nya: setelah terminal, apa pun state-nya → pending.
    expect(loop).toContain("exactPending = exactPending ?? record")
    expect(loop).not.toContain('record.state === "pending" || record.state === "unknown"')
    expect(loop).toContain("state === undefined")
  })
})

describe("F2 — deleteJournalFile sinkron", () => {
  test("file langsung hilang sebelum fungsi kembali", () => {
    const dir = tmpRoot("mc-audit-f2-")
    try {
      const sid = "audit-f2"
      const p = journalPath(sid, dir)
      writeFileSync(p, '{"v":1}\n', "utf8")
      expect(existsSync(p)).toBe(true)
      deleteJournalFile(sid, dir)
      // Tanpa unlinkSync, import() asinkron membuat pemeriksaan ini race.
      expect(existsSync(p)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})

describe("F3 — chmod sidecar WAL/SHM tiap open", () => {
  test("chmod ada di finally, bukan di dalam guard inisialisasi", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "session", "db", "schema.ts"),
      "utf8",
    )
    const guardStart = src.indexOf("if (!initializedSessionPaths.has(p))")
    const guardEnd = src.indexOf("const needsDdl", guardStart)
    expect(guardStart).toBeGreaterThan(-1)
    expect(guardEnd).toBeGreaterThan(guardStart)
    const guard = src.slice(guardStart, guardEnd)
    expect(guard).not.toContain("chmodSync")
    expect(src).toContain("chmodSessionDbSync(p)")
    const finallyAt = src.indexOf("} finally {")
    expect(finallyAt).toBeGreaterThan(-1)
    expect(src.slice(finallyAt)).toContain("chmodSessionDbSync(p)")
  })
})

describe("F4 — takeover epoch: rival ditolak fail-closed", () => {
  test("epoch-moved-unexpected melempar galat khas & melepas lease", () => {
    let released = 0
    const err = (() => {
      try {
        takeoverEpochUnderLease(
          {
            sessionId: "audit-f4",
            token: "tok-baru",
            cwd: undefined,
            bootId: "boot",
            preOwnerToken: "tok-lama",
          },
          {
            readEpoch: (() => 1) as never,
            takeover: (() => ({ outcome: "epoch-moved-unexpected", epoch: 99 })) as never,
            release: (() => {
              released++
              return true
            }) as never,
          },
        )
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(err).toBeInstanceOf(UnexpectedEpochMoveError)
    expect((err as UnexpectedEpochMoveError).code).toBe("REFUSED_UNEXPECTED_EPOCH_MOVE")
    expect(released).toBe(1)
  })

  test("jalur advanced tetap mengembalikan epoch tanpa release", () => {
    let released = 0
    const out = takeoverEpochUnderLease(
      {
        sessionId: "audit-f4-ok",
        token: "tok-baru",
        bootId: "boot",
        preOwnerToken: "tok-lama",
      },
      {
        readEpoch: (() => 2) as never,
        takeover: (() => ({ outcome: "advanced", epoch: 3 })) as never,
        release: (() => {
          released++
          return true
        }) as never,
      },
    )
    expect(out).toEqual({ epoch: 3, tookOver: true })
    expect(released).toBe(0)
  })
})

describe("F5 — jail LSP satu sumber kebenaran", () => {
  const PATH_TAKING = [
    "lsp_diagnostics",
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_symbols",
    "lsp_workspace_symbols",
  ]

  test("semua LSP pembaca path punya jailTarget file", () => {
    for (const name of PATH_TAKING) {
      const c = TOOL_CONTRACTS.find((x) => x.name === name)
      expect(c, name).toBeDefined()
      expect(c?.jailTarget, name).toBe("file")
      expect(LSP_FILE_JAIL_TOOL_NAMES.has(name), name).toBe(true)
    }
  })

  test("LSP_FILE_JAIL turunan dari flag, lsp_rename tak double-jail", () => {
    const derived = TOOL_CONTRACTS.filter(
      (c) =>
        c.jailTarget === "file" && c.name.startsWith("lsp_") && c.sideEffectTier === "PURE_READ",
    ).map((c) => c.name)
    expect([...LSP_FILE_JAIL_TOOL_NAMES].sort()).toEqual(derived.sort())
    // lsp_rename = WORKSPACE_MUTATION → hanya lewat FILE_JAIL, bukan keduanya.
    expect(LSP_FILE_JAIL_TOOL_NAMES.has("lsp_rename")).toBe(false)
    expect(FILE_JAIL_TOOL_NAMES.has("lsp_rename")).toBe(true)
    for (const name of PATH_TAKING) expect(FILE_JAIL_TOOL_NAMES.has(name), name).toBe(false)
  })
})

describe("F6 — ask_user visible === callable", () => {
  test("EXECUTE × auto menyembunyikan ask_user", () => {
    expect(workModeVisible("ask_user", "EXECUTE", "auto")).toBe(false)
    // Default EXECUTE (tanpa mode) tetap menampilkan ask_user — hanya `auto`
    // yang handler-nya menolak deterministik.
    expect(workModeVisible("ask_user", "EXECUTE")).toBe(true)
    expect(workModeVisible("ask_user", "EXECUTE", "readonly")).toBe(false)
  })

  test("hiding headless tetap di computeUnavailableWireTools", () => {
    const cfg = { mcpServers: [], lspServers: [] }
    expect(computeUnavailableWireTools(cfg, { interactiveAsk: false }).has("ask_user")).toBe(true)
    expect(computeUnavailableWireTools(cfg, { interactiveAsk: true }).has("ask_user")).toBe(false)
  })
})

describe("F7 — lantai lease mengikuti lantai timeout anak", () => {
  test("lease minimal 2.5 × 30 dtk dan mengikuti env", () => {
    expect(SESSION_LEASE_MS).toBeGreaterThanOrEqual(Math.ceil(SUB_AGENT_TIMEOUT_MIN_MS * 2.5))
    expect(SESSION_LEASE_MS).toBe(
      Math.ceil(Math.max(LIMITS.SUB_AGENT_TIMEOUT_MS, SUB_AGENT_TIMEOUT_MIN_MS) * 2.5),
    )
  })
})

describe("F8 — scrub kredensial pendek & JWT tanpa signature", () => {
  test("password/secret alphabetic pendek ter-redaksi", () => {
    expect(scrubSecrets("password=abcdef")).toContain("[REDACTED]")
    expect(scrubSecrets("secret=abcdef")).toContain("[REDACTED]")
    expect(scrubSecrets("password=abc123")).toContain("[REDACTED]")
  })

  test("JWT dengan signature kosong tetap ter-redaksi", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0."
    expect(scrubSecrets(`token=${jwt}`)).toContain("[REDACTED]")
    expect(scrubSecrets(`token=${jwt}`)).not.toContain("eyJhbGciOi")
  })

  test("kode/identifier normal tak ikut tersamarkan", () => {
    expect(scrubSecrets('secret = graphemes.join("")')).toBe('secret = graphemes.join("")')
    expect(scrubSecrets("apiKey: string")).toBe("apiKey: string")
    expect(scrubSecrets("sessionId: string")).toBe("sessionId: string")
    expect(scrubSecrets("WHERE session_id = ?")).toBe("WHERE session_id = ?")
  })
})

describe("F9 — komentar network read sesuai work-mode", () => {
  test("tool-contract tidak lagi mengklaim deny absolut di DISCUSS", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "policy", "tool-contract.ts"),
      "utf8",
    )
    expect(src).not.toContain("ditolak penuh di `DISCUSS`")
    expect(src).toContain("__promptGated")
    expect(src).toContain("headless")
  })
})
