// Regresi audit: guard bash me-resolve operand relatif terhadap DIRECTORI SAMA
// dengan shell (sessionRoot + args.cwd), bukan terhadap sessionRoot saja.
// Dulu: `sub/link -> /outside` lolos bila argumen cwd="sub", dan `cat ../x`
// dari sub salah ditolak.
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectBashCommand } from "../src/policy/bash-guard.ts"
import { createPermissionHandler } from "../src/policy/permission.ts"

const verdict = async (cmd: string, cwd: string, root: string) =>
  await createPermissionHandler({ mode: "allow-all", root }).check(
    { id: "1", name: "bash", args: { cmd, cwd } } as never,
    {} as never,
  )

test("cwd efektif dipakai: `../shared.txt` dari sub = file di dalam workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-cwd-ok-"))
  try {
    const sub = join(root, "sub")
    mkdirSync(sub)
    writeFileSync(join(root, "shared.txt"), "shared\n")
    // Diferensial: basis lama (root) melihat `../` sebagai keluar workspace.
    expect(inspectBashCommand("cat ../shared.txt", root, root).denied).toBe(true)
    // Basis efektif (root/sub) melihat file yang sama → aman.
    expect(inspectBashCommand("cat ../shared.txt", sub, root).denied).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("integrasi permission: relative read lintas sub tidak lagi false-deny", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-cwd-perm-"))
  try {
    mkdirSync(join(root, "sub"))
    writeFileSync(join(root, "shared.txt"), "shared\n")
    expect(await verdict("cat ../shared.txt", "sub", root)).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("symlink sub -> luar workspace menembus jail bila guard pakai root", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-cwd-link-"))
  const outside = mkdtempSync(join(tmpdir(), "audit-outside-"))
  try {
    const sub = join(root, "sub")
    mkdirSync(sub)
    const payload = join(outside, "payload.txt")
    writeFileSync(payload, "RAHASIA\n")
    const link = join(sub, "link")
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
    } catch {
      // Lingkungan tanpa hak symlink: lewati (kasus ini butuh symlink nyata).
      return
    }
    // Basis lama: root/link tidak ada → lolos (itulah bypass-nya).
    expect(inspectBashCommand("cat link/payload.txt", root, root).denied).toBe(false)
    // Basis efektif: root/sub/link/... → realpath keluar root → ditolak.
    expect(inspectBashCommand("cat link/payload.txt", sub, root).denied).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("integrasi permission: `cat link/payload.txt` di sub ditolak", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-cwd-jail-"))
  const outside = mkdtempSync(join(tmpdir(), "audit-outside2-"))
  try {
    const sub = join(root, "sub")
    mkdirSync(sub)
    writeFileSync(join(outside, "payload.txt"), "RAHASIA\n")
    try {
      symlinkSync(outside, join(sub, "link"), process.platform === "win32" ? "junction" : "dir")
    } catch {
      return
    }
    expect(await verdict("cat link/payload.txt", "sub", root)).toBe("deny")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("positive: relative read biasa di dalam sub tetap diizinkan", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-cwd-pos-"))
  try {
    const sub = join(root, "sub")
    mkdirSync(sub)
    writeFileSync(join(sub, "note.txt"), "ok\n")
    expect(await verdict("cat note.txt", "sub", root)).toBe("allow")
    expect(await verdict("cat sub/note.txt", "", root)).toBe("allow")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("denyLinkOperand: link ke luar root ditolak, link internal jinak lolos", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-link-"))
  const outside = mkdtempSync(join(tmpdir(), "audit-link-out-"))
  try {
    writeFileSync(join(root, "note.txt"), "ok\n")
    writeFileSync(join(outside, "secret.txt"), "x\n")
    // Absolut keluar workspace.
    expect(inspectBashCommand(`ln -s "${outside}" link`, root, root).denied).toBe(true)
    // Relatif keluar workspace.
    expect(inspectBashCommand("ln -s ../escape link", root, root).denied).toBe(true)
    // Tanpa cwd: heuristik konservatif tetap menahan `..`.
    expect(inspectBashCommand("ln -s ../escape link").denied).toBe(true)
    // Kontrol: target di dalam root tidak ikut terblokir.
    expect(inspectBashCommand("ln -s note.txt link", root, root).denied).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
