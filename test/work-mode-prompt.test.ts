// Guidance system-prompt ber-keyed WorkMode (2-mode: DISCUSS | EXECUTE).
//
// Membuktikan:
// 1. `workModeHint` menghasilkan teks posture yang BENAR per WorkMode:
//    - DISCUSS = investigasi baca-saja berorientasi diskusi dan perencanaan
//      (menggabungkan investigasi, diskusi opsi/trade-offs, dan rencana konkret),
//      melarang tulis/eksekusi.
//    - EXECUTE = identitas (tidak menambah apa pun).
// 2. Teks itu BENAR-BENAR mencapai wire (system prompt) lewat createMinicodeSession:
//    FakeProvider merekam StreamRequest.system, jadi hint DISCUSS terbukti
//    terkirim — bukan hanya fungsi mati yang tak dipanggil.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider } from "#minicore/test/fakes.ts"
import { createMinicodeSession, workModeHint } from "../src/app/session.ts"
import { readFileTool } from "../src/tools/read_file.ts"

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tmpRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `mc-wmp-${tag}-`))
  roots.push(root)
  return root
}

describe("workModeHint — teks posture per WorkMode (murni)", () => {
  test("DISCUSS = investigasi baca-saja berorientasi diskusi & rencana konkret", () => {
    const h = workModeHint("DISCUSS")
    expect(h).toContain("DISCUSS MODE")
    expect(h).toContain("discuss findings, options, and trade-offs")
    expect(h).toContain("concrete implementation plan")
    expect(h).toContain("Do NOT modify files")
    expect(h).toContain("Do not implement or execute")
  })

  test("EXECUTE = identitas (tidak menambah apa pun)", () => {
    expect(workModeHint("EXECUTE")).toBe("")
  })

  test("DISCUSS hint berbeda dari planHint PermissionMode (mandiri)", () => {
    const wm = workModeHint("DISCUSS")
    expect(wm).toContain("investigation, discussion, and planning mode")
    expect(wm).not.toContain("You are in read-only planning mode.")
  })
})

describe("createMinicodeSession — hint WorkMode mencapai wire (system prompt)", () => {
  async function systemFor(workMode: "DISCUSS" | "EXECUTE"): Promise<string> {
    const dir = tmpRoot(workMode.toLowerCase())
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode,
    })
    await session.run("helm")
    const req = provider.requests[0]
    return typeof req?.system === "string" ? req.system : ""
  }

  test("workMode DISCUSS → system prompt memuat discusHint terpadu", async () => {
    const sys = await systemFor("DISCUSS")
    expect(sys).toContain("DISCUSS MODE")
    expect(sys).toContain("discuss findings, options, and trade-offs")
    expect(sys).toContain("concrete implementation plan")
  })

  test("workMode EXECUTE → system prompt TANPA hint DISCUSS", async () => {
    const sys = await systemFor("EXECUTE")
    expect(sys).not.toContain("DISCUSS MODE")
    expect(sys).not.toContain("PLAN MODE")
  })

  test("transisi runtime EXECUTE → DISCUSS → EXECUTE menyegarkan StreamRequest.system per turn (G-PROMPT-RT tertutup)", async () => {
    const dir = tmpRoot("rt-prompt")
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    let wmCtl: { setWorkMode(m: "DISCUSS" | "EXECUTE"): void } | undefined
    let pmCtl: { setMode(m: "auto" | "plan" | "readonly"): void } | undefined
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode: "EXECUTE",
      onWorkMode: (ctl) => {
        wmCtl = ctl
      },
      onPermissions: (ctl) => {
        pmCtl = ctl as never
      },
    })

    // Turn 1: EXECUTE × auto → tanpa hint DISCUSS.
    await session.run("t1")
    const sys1 = String(provider.requests[0]?.system ?? "")
    expect(sys1).not.toContain("DISCUSS MODE")

    // Turn 2: pindah ke DISCUSS di tengah sesi → system prompt langsung memuat DISCUSS MODE.
    wmCtl!.setWorkMode("DISCUSS")
    await session.run("t2")
    const sys2 = String(provider.requests[1]?.system ?? "")
    expect(sys2).toContain("DISCUSS MODE")
    expect(sys2).toContain("concrete implementation plan")

    // Turn 3: kembali ke EXECUTE, lalu ganti PermissionMode ke plan → hint WorkMode DISCUSS hilang, planHint PermissionMode aktif.
    wmCtl!.setWorkMode("EXECUTE")
    pmCtl!.setMode("plan")
    await session.run("t3")
    const sys3 = String(provider.requests[2]?.system ?? "")
    expect(sys3).not.toContain("DISCUSS MODE")
    expect(sys3).toContain("read-only planning mode")
  })
})
