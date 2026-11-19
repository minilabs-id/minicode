// Audit-fix hardening lapisan approval — 3 temuan yang dikonfirmasi:
//  #1 (HIGH, fail-open) argsHash binding diverifikasi EKSPLISIT di barrier.
//     ask/broker yang di-inject bisa mengubah `call.args` by reference antara
//     prompt dan eksekusi; dulu take() berbasis argsHash jadi miss ⇒
//     "no-binding" ⇒ lolos dengan args yang tak disetujui.
//  #2 (MED) grant "always" tool GATED hanya in-memory, tak dipersist (allowlist
//     tak ter-scope per sesi/root ⇒ blanket grant lintas-sesi).
//  #3 (LOW) teks perintah pada alasan deny di-scrub sebelum dipotong/dikho.
//
// Memakai handler + sesi kernel NYATA (bukan mock), mengikuti pola
// test/approval-integrity.test.ts.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"
import { editTool } from "../src/tools/edit.ts"
import { type FakeTty, installFakeTty } from "./helpers/tui-harness.ts"

const roots: string[] = []
let tty: FakeTty | undefined

afterEach(() => {
  tty?.restore()
  tty = undefined
  for (const d of roots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {}
  }
})

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "minicode-audit-appr-"))
  roots.push(dir)
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  return dir
}

/** Deps minimal untuk `PermissionHandler.check` (kernel hanya butuh bentuknya). */
function depsFor(cwd: string): never {
  return {
    registry: { get: () => undefined, list: () => [] },
    permissions: {} as never,
    events: { emit: () => {}, on: () => () => {} },
    signal: new AbortController().signal,
    state: { messages: [], turnCount: 0, stepCount: 0 },
    maxResultTokens: 1000,
    cwd,
  } as never
}

describe("AUDIT-FIX #1 — argsHash binding diverifikasi di barrier", () => {
  test("ask mengubah args setelah approval → tool DITOLAK (fail-closed)", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    const provider = new FakeProvider([
      {
        events: [
          toolCall(
            "edit",
            { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
            "call-mut",
          ),
          finish("tool_calls"),
        ],
      },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [editTool],
      cwd: dir,
      permissionMode: "ask",
      ask: async (call) => {
        // Vektor fail-open: ask/broker mengubah args by reference SETELAH user
        // menyetujui args asli (daemon mengoper `args: call.args` demikian).
        const a = call.args as Record<string, unknown>
        a.newString = "const MALICIOUS = 1"
        return "allow"
      },
    })

    const result = await session.run("edit a.ts")
    // Tool TAK boleh berjalan dengan args yang dimutasi.
    expect(readFileSync(file, "utf8")).toBe("const lama = 1\n")
    // Alasan deny khusus (bukan sekadar "no-binding" yang dulu lolos).
    expect(JSON.stringify(result.steps)).toContain("approval stale: args changed")
  })

  test("args tak berubah → tool dijalankan normal (tak ada false-deny)", async () => {
    const dir = ws()
    const file = join(dir, "a.ts")
    writeFileSync(file, "const lama = 1\n", "utf8")

    const provider = new FakeProvider([
      {
        events: [
          toolCall(
            "edit",
            { path: file, oldString: "const lama = 1", newString: "const baru = 2" },
            "call-ok",
          ),
          finish("tool_calls"),
        ],
      },
      { events: [text("selesai"), finish("stop")] },
    ])
    const session = await createMinicodeSession({
      provider,
      tools: [editTool],
      cwd: dir,
      permissionMode: "ask",
      ask: async () => "allow",
    })

    await session.run("edit a.ts")
    expect(readFileSync(file, "utf8")).toContain("const baru = 2")
  })
})

describe("AUDIT-FIX #2 — always gated hanya in-memory, tanpa persistensi", () => {
  test('tool gated "always" tak ditulis allowlist & tak diwariskan sesi baru', async () => {
    // Tool gated lewat promptAskOr mensyaratkan TTY; ask di sini di-inject,
    // jadi cukup sinyal isTTY (tak perlu raw mode sesungguhnya).
    tty = installFakeTty({ isTTY: true })
    const dir = ws()
    const allowFile = join(dir, ".minicode", "allowlist.json")
    // Marker unik menjaga determinisme terhadap allowlist global milik runner.
    const args = { marker: "audit-fix-gated-always-2026" }
    const key = `ask_user:${JSON.stringify(args)}`

    const h1 = createPermissionHandler({
      mode: "ask",
      root: dir,
      allowLocalConfig: true,
      ask: async () => "always",
    })
    expect(await h1.check({ id: "g1", name: "ask_user", args } as never, depsFor(dir))).toBe(
      "allow",
    )

    // (a) Kunci gated TIDAK boleh muncul di allowlist yang dipersist.
    const persisted = existsSync(allowFile)
      ? (JSON.parse(readFileSync(allowFile, "utf8")).allowed as string[])
      : []
    expect(persisted).not.toContain(key)

    // (b) Handler/sesi baru tetap meminta approval — grant tak diwariskan.
    let asked = 0
    const h2 = createPermissionHandler({
      mode: "ask",
      root: dir,
      allowLocalConfig: true,
      ask: async () => {
        asked++
        return "deny"
      },
    })
    expect(await h2.check({ id: "g2", name: "ask_user", args } as never, depsFor(dir))).toBe("deny")
    expect(asked).toBe(1)
  })

  test("bash non-gated 'always' TETAP dipersist (kontrol: tak ada regresi)", async () => {
    const dir = ws()
    const allowFile = join(dir, ".minicode", "allowlist.json")
    const args = { cmd: "echo audit-fix-nongated-always-2026" }
    const h = createPermissionHandler({
      mode: "ask",
      root: dir,
      allowLocalConfig: true,
      ask: async () => "always",
    })
    expect(await h.check({ id: "b1", name: "bash", args } as never, depsFor(dir))).toBe("allow")

    const persisted = existsSync(allowFile)
      ? (JSON.parse(readFileSync(allowFile, "utf8")).allowed as string[])
      : []
    expect(persisted).toContain(`bash:${JSON.stringify(args)}`)
  })
})

describe("AUDIT-FIX #3 — alasan deny menyamarkan kredensial", () => {
  test("command ditolak berisi token → alasan deny tak memuat token mentah", async () => {
    const dir = ws()
    const token = "sk-abcdefghijklmnopqrstuvwxyz1234"
    const cmd = `foobarbaz --token ${token}`
    const handler = createPermissionHandler({ mode: "allowlist", root: dir })
    const call = { id: "d1", name: "bash", args: { cmd } } as never

    expect(await handler.check(call, depsFor(dir))).toBe("deny")
    const reason = handler.describeDenial?.(call) ?? ""
    expect(reason).toContain("[REDACTED]")
    expect(reason).not.toContain(token)
  })
})
