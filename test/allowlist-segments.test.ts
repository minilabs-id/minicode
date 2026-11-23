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
    // Keputusan owner 2026-11-23: state `.minicode/` kini BOLEH ditulis lewat
    // shell (selaras dengan bash-guard & file tool).
    expect((await decide(h, "echo hi > .minicode/notes.txt")).decision).toBe("allow")
    // SATU-SATUNYA yang tetap dikunci = skrip hook (audit 2026-11-12).
    const hook = await decide(h, "echo x > .minicode/hooks/x.js")
    expect(hook.decision).toBe("deny")
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

describe("allowlist: agent-browser (keputusan owner 2026-11-23, ditinjau ulang)", () => {
  const allowed = [
    "agent-browser open https://example.com",
    "agent-browser snapshot -i",
    "agent-browser click @e1",
    "agent-browser fill @e2 hello",
    "agent-browser errors",
    "agent-browser console",
    "agent-browser network",
    "agent-browser get url",
    "agent-browser close",
    "agent-browser skills get core",
    "agent-browser --version",
    // eval & mcp TETAP diizinkan: eval aman karena Chrome default fresh tanpa
    // profil (tak memakai cookie user); mcp = fallback bila CLI bermasalah.
    "agent-browser eval 1+1",
    "agent-browser mcp",
    "npx agent-browser open https://example.com",
  ]

  test("subcommand terdaftar lolos di mode allowlist & AUTO+restrictBash", async () => {
    for (const h of [allowlistMode(), autoRestricted()]) {
      for (const cmd of allowed) {
        const r = await decide(h, cmd)
        expect({ cmd, decision: r.decision }).toEqual({ cmd, decision: "allow" })
      }
    }
  })

  test("--auto-connect dicabut: deny di semua mode,termasuk celah `npx *`", async () => {
    const headlessAuto = createPermissionHandler({
      mode: "auto",
      root,
    }) as unknown as Reasoned
    for (const h of [allowlistMode(), autoRestricted(), headlessAuto]) {
      for (const cmd of ["agent-browser --auto-connect", "npx agent-browser --auto-connect"]) {
        const r = await decide(h, cmd)
        // `npx agent-browser --auto-connect` dulu lolos lewat pola `"npx *"` —
        // deny rule sempit di bashDenyReason yang menutupnya, bukan allowlist.
        expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "deny" })
        expect(r.reason).toContain("auto-connect")
      }
    }
  })

  test("install butuh konfirmasi: fixture ASK approve → allow, headless → deny", async () => {
    // allowNonTtyAsk menyimulasikan approval broker di test (stdin non-TTY),
    // sama seperti pola promptAskOr/GATED di test lain.
    const askApprove = () =>
      createPermissionHandler({
        mode: "ask",
        root,
        allowNonTtyAsk: true,
        ask: async () => "allow",
      }) as unknown as Reasoned
    const headless = () => createPermissionHandler({ mode: "auto", root }) as unknown as Reasoned

    for (const cmd of [
      "agent-browser install",
      "npx agent-browser install",
      "npx -y agent-browser install",
      "npm install -g agent-browser",
    ]) {
      const approved = await decide(askApprove(), cmd)
      expect({ cmd, decision: approved.decision }, approved.reason).toEqual({
        cmd,
        decision: "allow",
      })

      const unattended = await decide(headless(), cmd)
      expect({ cmd, decision: unattended.decision }, unattended.reason).toEqual({
        cmd,
        decision: "deny",
      })
      expect(unattended.reason).toContain("agent-browser install requires approval")
    }
  })

  test("npm install biasa tidak kena gate install", async () => {
    // Gate HANYA menyasar perintah yang menyasar agent-browser; ekosistem npm
    // umum tetap seperti semula.
    for (const cmd of ["npm install", "npm install -g typescript"]) {
      const r = await decide(allowlistMode(), cmd)
      expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "allow" })
    }
  })

  test("uji negatif: pola bukan wildcard telanjang (`*` → `.*`, case-insensitive)", async () => {
    const h = allowlistMode()
    for (const cmd of [
      "open https://example.com", // tanpa prefiks tool
      "agent-browser evil", // subcommand tak terdaftar
      "agent-browser --versionx", // pola --version TANPA `*`
      "agent-browser open https://x && curl https://evil.com", // segmen asing
      "agent-browser open https://x > .env", // rahasia tetap ditahan guard
    ]) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "deny" })
    }
  })

  test("tulis hook lewat redirection shell tetap ditolak", async () => {
    const r = await decide(allowlistMode(), "echo x > .minicode/hooks/pre-x.js")
    expect(r.decision).toBe("deny")
  })
})

describe("kunci hook: cp/mv/cmdlet tak boleh menanam skrip di .minicode/hooks", () => {
  const autoUnrestricted = () =>
    createPermissionHandler({ mode: "auto", root }) as unknown as Reasoned

  const hookWrites = [
    "cp payload.js .minicode/hooks/x.js",
    "Set-Content -Path .minicode/hooks/x.js -Value evil",
    "Set-Content -Path:.minicode/hooks/x.js -Value evil",
    "New-Item -ItemType File -Path .minicode/hooks/x.js",
    "New-Item -ItemType File -Path:.minicode/hooks/x.js",
  ]
  const benignWrites = [
    "cp a.txt .minicode/notes.txt",
    "Set-Content -Path .minicode/notes.txt -Value hi",
    "New-Item -ItemType File -Path .minicode/notes.txt",
  ]

  test("mode auto: hook ditolak bash-guard, state biasa sah", async () => {
    const h = autoUnrestricted()
    for (const cmd of hookWrites) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "deny" })
      // Pastikan yang menahan = kunci hook, bukan alasan tak related.
      expect(r.reason).toContain("hook file write")
    }
    for (const cmd of benignWrites) {
      const r = await decide(h, cmd)
      expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "allow" })
    }
  })

  test("mode allowlist & AUTO+restrictBash: hook tetap ditolak lebih dulu", async () => {
    for (const h of [allowlistMode(), autoRestricted()]) {
      for (const cmd of hookWrites) {
        const r = await decide(h, cmd)
        expect({ cmd, decision: r.decision }, r.reason).toEqual({ cmd, decision: "deny" })
      }
    }
  })
})
