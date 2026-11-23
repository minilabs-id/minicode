// Allowlist bash SADAR-SEGMEN.
//
// Regresi nyata (sesi `1bfbcc50`): 98 dari 113 penolakan adalah
// "allowlist: no matching pattern", dan 81 di antaranya berupa perintah
// majemuk yang SELURUH tahapnya sudah ada di daftar (`grep ... | head`,
// `ls -la && echo`, `cat ... 2>&1 | sed -n`). Aturan lama menolak seluruh
// perintah begitu melihat `;`/`|`/`&&`, sehingga model buta repo lalu
// mengulang read_file besar sampai konteks membengkak.
//
// Kontrak baru: setiap SEGMEN diverifikasi sendiri (pola + npx-safety), `cd`
// dalam workspace sah, dan redirection netral (`2>&1`, `2>/dev/null`) tidak
// mengubah bentuk perintah. bash-guard tetap memeriksa perintah UTUH lebih dulu.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import type { PermissionHandler } from "../vendor/minicore/src/core/permission.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"

const root = mkdtempSync(join(tmpdir(), "mc-al-seg-"))
mkdirSync(join(root, "sub"), { recursive: true })
process.on("exit", () => rmSync(root, { recursive: true, force: true }))

type Reasoned = PermissionHandler & { describeDenial(c: ToolCall): string | undefined }

let seq = 0
const bash = (cmd: string): ToolCall => ({ id: `al-${++seq}`, name: "bash", args: { cmd } })

async function decide(
  h: Reasoned,
  cmd: string,
): Promise<{ decision: string; reason: string | undefined }> {
  const c = bash(cmd)
  const decision = (await h.check(c, {} as never)) as string
  return { decision, reason: await h.describeDenial(c) }
}

const allowlistMode = (extra: Record<string, unknown> = {}) =>
  createPermissionHandler({ mode: "allowlist", root, ...extra }) as unknown as Reasoned

const autoRestricted = () =>
  createPermissionHandler({ mode: "auto", root, restrictBash: true }) as unknown as Reasoned

describe("allowlist: perintah majemuk diperiksa per segmen", () => {
  test("pipe ke reader allowlisted lolos (dulu ditolak karena `|`)", async () => {
    const h = allowlistMode()
    for (const cmd of [
      'grep -n "x" f 2>&1 | head',
      "cat a.txt | wc -l",
      'ls -la && echo "---"',
      "git diff --stat && git status",
      "find . -name '*.ts' | sort | head -20",
    ]) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }).toEqual({ cmd, decision: "allow" })
    }
  })

  test("newline juga pemisah, bukan alasan menolak semua", async () => {
    const r = await decide(allowlistMode(), "echo a\necho b")
    expect(r.decision).toBe("allow")
  })

  test("redirection netral (2>&1 / /dev/null) tidak mengubah bentuk perintah", async () => {
    const h = allowlistMode()
    expect((await decide(h, "cat f 2>/dev/null")).decision).toBe("allow")
    expect((await decide(h, "cat f 2>&1 | tail -5")).decision).toBe("allow")
  })

  test("redirection ke berkas: di dalam workspace sah, di luar/state ditolak", async () => {
    const h = allowlistMode()
    // Perilaku lama yang dipertahankan: menulis berkas kerja lewat redirect.
    expect((await decide(h, "echo hi > local.txt")).decision).toBe("allow")
    // bash-guard memeriksa target lebih dulu — alasannya yang menang.
    const outside = await decide(h, "cat f > ../outside.txt")
    expect(outside.decision).toBe("deny")
    expect(outside.reason).toMatch(/redirect outside workspace|redirection outside workspace/)
    // Baca dari berkas di dalam workspace tidak jadi regresi.
    expect((await decide(h, "cat < local.txt")).decision).toBe("allow")
    // State milik minicode tidak boleh ditimpa lewat shell.
    const owned = await decide(h, "echo '{}' > .minicode/allowlist.json")
    expect(owned.decision).toBe("deny")
  })

  test("satu segmen tak dikenal menolak seluruh perintah", async () => {
    const r = await decide(allowlistMode(), "ls && curl http://example.com")
    expect(r.decision).toBe("deny")
    expect(r.reason).toContain("no matching pattern")
    expect(r.reason).toContain("curl")
  })

  test("substitusi perintah tidak pernah lolos", async () => {
    const r = await decide(allowlistMode(), "echo $(whoami)")
    expect(r.decision).toBe("deny")
    expect(r.reason).toContain("shell expansion/chaining unsafe")
  })

  test("sed pembaca boleh, sed in-place ditolak", async () => {
    const h = allowlistMode()
    expect((await decide(h, "sed -n '1,40p' f | head")).decision).toBe("allow")
    const inPlace = await decide(h, "sed -i 's/a/b/' f")
    expect(inPlace.decision).toBe("deny")
    expect(inPlace.reason).toContain("in-place edit")
  })
})

describe("allowlist: cd hanya di dalam workspace", () => {
  test("cd ke subdirektori workspace lolos", async () => {
    const r = await decide(allowlistMode(), "cd sub && ls")
    expect(r.decision).toBe("allow")
  })

  test("cd ke luar workspace ditolak dengan alasan jail", async () => {
    const r = await decide(allowlistMode(), "cd .. && ls")
    expect(r.decision).toBe("deny")
    expect(r.reason).toContain("jail: cwd outside workspace")
  })
})

describe("allowlist: AUTO + restrictBash memakai aturan yang sama", () => {
  test("pipeline lolos, perintah asing ditolak", async () => {
    const h = autoRestricted()
    expect((await decide(h, "bun test 2>&1 | tail -20")).decision).toBe("allow")
    const denied = await decide(h, "curl http://example.com")
    expect(denied.decision).toBe("deny")
    expect(denied.reason).toContain("no matching pattern")
  })
})

describe("allowlist: reader inventaris/sistem (tree, du, df, date, uname)", () => {
  const benign = ["uname -a", "date", "df -h .", "du -sh src", "tree -L 1 src"]

  test("diterima di mode allowlist", async () => {
    const h = allowlistMode()
    for (const cmd of benign) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }).toEqual({ cmd, decision: "allow" })
    }
  })

  test("diterima di AUTO + restrictBash", async () => {
    const h = autoRestricted()
    for (const cmd of benign) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }).toEqual({ cmd, decision: "allow" })
    }
  })

  test("tree / dan du / tetap ditolak bash-guard (ROOT_SCAN)", async () => {
    for (const h of [allowlistMode(), autoRestricted()]) {
      for (const cmd of ["tree /", "du /"]) {
        const r = await decide(h, cmd)
        expect({ cmd, decision: r.decision }).toEqual({ cmd, decision: "deny" })
        expect(r.reason).toContain("bash-guard: filesystem-root scan")
      }
    }
  })
})

describe("allowlist: config `bashAllowlist` benar-benar dipakai", () => {
  test("pola dari config menambah daftar (dulu key mati)", async () => {
    const h = allowlistMode({ bashAllowlist: ["mycmd *"] })
    expect((await decide(h, "mycmd --flag")).decision).toBe("allow")
    // Segmen lain tetap harus cocok pola — config bukan blanket-allow.
    expect((await decide(h, "mycmd --flag && othercmd")).decision).toBe("deny")
  })
})
