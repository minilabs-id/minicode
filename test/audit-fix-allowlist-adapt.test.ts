// [AUDIT-FIX / adaptive denial] Sesi DISCUSS/allowlist nyata mencatat empat
// penolakan berturut-turut (`for %f`, `node -e`, `more`) tanpa adaptasi.
//
// YANG DIUJI: pesan deny yang SAMA dengan yang dilihat model (seam
// `describeDenial`, dipanggil kernel menjadi "permission denied: <reason>")
// memberi alternatif Windows yang konkret dan counter saat kelas perintah yang
// sama ditolak berulang. Keputusan allowlist ITU SENDIRI tidak berubah — ini
// murni diagnostik, bukan pelonggaran izin.

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionHandler } from "../src/policy/permission.ts"
import type { PermissionHandler } from "../vendor/minicore/src/core/permission.ts"
import type { ToolCall } from "../vendor/minicore/src/core/types.ts"

type Reasoned = PermissionHandler & { describeDenial(c: ToolCall): string | undefined }
const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-allowlist-adapt-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

let seq = 0
const call = (name: string, args: unknown): ToolCall => ({ id: `adapt-${++seq}`, name, args })
function handler(opts: { mode?: "allowlist" | "auto"; restrictBash?: boolean } = {}): Reasoned {
  return createPermissionHandler({
    root: root(),
    mode: opts.mode ?? "allowlist",
    ...(opts.restrictBash !== undefined ? { restrictBash: opts.restrictBash } : {}),
  }) as unknown as Reasoned
}
async function decide(h: Reasoned, name: string, args: unknown) {
  const c = call(name, args)
  const decision = await h.check(c, {} as never)
  // describeDenial di vendor boleh async; await membuat helper ini seragam.
  return { decision: decision as string, reason: (await h.describeDenial(c)) ?? "" }
}

test("a. allowlist FOR-loop denial teaches a concrete Windows-safe alternative", async () => {
  const { decision, reason } = await decide(handler(), "bash", {
    cmd: "for %f in (a b) do echo %f",
  })
  expect(decision).toBe("deny")
  expect(reason).toContain("allowlist: no matching pattern")
  expect(reason).toContain("read_file")
  expect(reason).toContain("dir /b")
  expect(reason).toContain("Get-Content")
  expect(reason).toContain("--allow-all")
  // Kernel memotong alasan ke 160 char — saran harus masuk sebelum terpotong.
  expect(reason.length).toBeLessThanOrEqual(160)
})

test("b. inline node -e denial teaches the file-based alternative", async () => {
  const { decision, reason } = await decide(handler(), "bash", {
    cmd: `node -e "console.log(1)"`,
  })
  expect(decision).toBe("deny")
  expect(reason).toContain("bash-guard")
  expect(reason).toContain("inline interpreter code")
  expect(reason).toContain("node file.js")
  expect(reason).toContain("read_file")
  expect(reason.length).toBeLessThanOrEqual(160)
})

test("c. repeating one command class escalates the hint with an explicit counter", async () => {
  const h = handler()
  const reasons: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await decide(h, "bash", { cmd: "for %f in (%a) do echo %f" })
    expect(r.decision).toBe("deny")
    reasons.push(r.reason)
  }
  expect(reasons[0]).not.toContain("#2")
  expect(reasons[1]).toContain("#2")
  expect(reasons[1]).toContain("STOP")
  expect(reasons[2]).toContain("#3")
  for (const r of reasons) expect(r.length).toBeLessThanOrEqual(160)
  // Kelas lain tak mewarisi counter kelas `for`.
  const other = await decide(h, "bash", { cmd: "curl http://example.com" })
  expect(other.decision).toBe("deny")
  expect(other.reason).not.toContain("#2")
})

test("d. repeating inline code denial is counted too", async () => {
  const h = handler()
  const first = await decide(h, "bash", { cmd: `node -e "1"` })
  const second = await decide(h, "bash", { cmd: `node -e "2"` })
  expect(first.decision).toBe("deny")
  expect(second.decision).toBe("deny")
  expect(first.reason).not.toContain("#2")
  expect(second.reason).toContain("#2")
  expect(second.reason).toContain("STOP")
})

test("e. allowlist decisions are unchanged after adaptive denials", async () => {
  const h = handler()
  expect((await decide(h, "bash", { cmd: "for %f in (a) do echo %f" })).decision).toBe("deny")
  expect((await decide(h, "bash", { cmd: `node -e "1"` })).decision).toBe("deny")
  // Perintah yang memang diizinkan tetap izin — pesan deny tak mengubah gate.
  expect((await decide(h, "bash", { cmd: "type readme.txt" })).decision).toBe("allow")
  expect((await decide(h, "bash", { cmd: "dir /b" })).decision).toBe("allow")
  expect((await decide(h, "bash", { cmd: "echo hi" })).decision).toBe("allow")
  expect((await decide(h, "bash", { cmd: "node server.js" })).decision).toBe("allow")
  expect((await decide(h, "bash", { cmd: "curl http://example.com" })).decision).toBe("deny")
})

test("f. AUTO + restrictBash path teaches the same alternative and counter", async () => {
  const h = handler({ mode: "auto", restrictBash: true })
  expect((await decide(h, "bash", { cmd: "bun test 2>&1 | tail -20" })).decision).toBe("allow")
  const first = await decide(h, "bash", { cmd: "curl http://example.com" })
  const second = await decide(h, "bash", { cmd: "curl http://example.org" })
  expect(first.decision).toBe("deny")
  expect(second.decision).toBe("deny")
  expect(first.reason).toContain("dir /b")
  expect(first.reason).not.toContain("#2")
  expect(second.reason).toContain("#2")
})
