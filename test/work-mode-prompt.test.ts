// Guidance system-prompt & wire transition notice untuk WorkMode + PermissionMode:
//
// Membuktikan:
// 1. `workModeHint`: DISCUSS = read-only diskusi/rencana; EXECUTE = direktif
//    positif BUILD MODE (menutup bias histori DISCUSS tanpa minta konfirmasi tertulis).
// 2. `permissionModeHint`: penanda eksplisit untuk auto, ask, unrestricted, plan.
// 3. `buildModeTransitionNote` + injeksi wire per-turn pada `createMinicodeSession`:
//    saat bolak-balik DISCUSS <-> BUILD / AUTO <-> ASK / UNRESTRICTED,
//    `StreamRequest.system` dan pesan wire turn tersebut langsung memuat pembaruan
//    mode tanpa mencemari `session.state.history`.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FakeProvider } from "#minicore/test/fakes.ts"
import {
  buildModeTransitionNote,
  createMinicodeSession,
  permissionModeHint,
  workModeHint,
} from "../src/app/session.ts"
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

describe("workModeHint & permissionModeHint — teks posture & penanda mode", () => {
  test("DISCUSS = investigasi baca-saja berorientasi diskusi & rencana konkret", () => {
    const h = workModeHint("DISCUSS")
    expect(h).toContain("DISCUSS MODE")
    expect(h).toContain("discuss findings, options, and trade-offs")
    expect(h).toContain("concrete implementation plan")
    expect(h).toContain("Do NOT modify files")
    expect(h).toContain("Do not implement or execute")
  })

  test("EXECUTE = BUILD MODE aktif positif tanpa meminta konfirmasi tertulis", () => {
    const h = workModeHint("EXECUTE")
    expect(h).toContain("BUILD MODE")
    expect(h).toContain("ignore prior self-statements")
    expect(h).toContain("without asking for written confirmation")
  })

  test("DISCUSS hint berbeda dari planHint PermissionMode (mandiri)", () => {
    const wm = workModeHint("DISCUSS")
    expect(wm).toContain("investigation, discussion, and planning mode")
    expect(wm).not.toContain("You are in read-only planning mode.")
  })

  test("permissionModeHint menandai AUTO, ASK, dan UNRESTRICTED secara jelas", () => {
    expect(permissionModeHint("auto", "EXECUTE")).toContain("PERMISSION MODE: AUTO")
    const ask = permissionModeHint("ask", "EXECUTE")
    expect(ask).toContain("PERMISSION MODE: ASK")
    expect(ask).toContain("invoke tools directly")
    const unrestricBuild = permissionModeHint("unrestricted", "EXECUTE")
    expect(unrestricBuild).toContain("PERMISSION MODE: UNRESTRICTED")
    expect(unrestricBuild).toContain("lifted")
    const unrestricDiscuss = permissionModeHint("unrestricted", "DISCUSS")
    expect(unrestricDiscuss).toContain("suspended in DISCUSS mode")
  })

  test("buildModeTransitionNote menghasilkan diff bersih saat bolak-balik mode", () => {
    expect(
      buildModeTransitionNote(
        { workMode: "DISCUSS", permissionMode: "auto" },
        { workMode: "DISCUSS", permissionMode: "auto" },
      ),
    ).toBe("")
    const toBuild = buildModeTransitionNote(
      { workMode: "DISCUSS", permissionMode: "auto" },
      { workMode: "EXECUTE", permissionMode: "auto" },
    )
    expect(toBuild).toContain("WorkMode DISCUSS -> BUILD")
    expect(toBuild).toContain("NOW ENABLED")
    const toUnrestric = buildModeTransitionNote(
      { workMode: "DISCUSS", permissionMode: "ask" },
      { workMode: "EXECUTE", permissionMode: "unrestricted" },
    )
    expect(toUnrestric).toContain("WorkMode DISCUSS -> BUILD")
    expect(toUnrestric).toContain("PermissionMode ASK -> UNRESTRICTED")
    const backToDiscuss = buildModeTransitionNote(
      { workMode: "EXECUTE", permissionMode: "unrestricted" },
      { workMode: "DISCUSS", permissionMode: "ask" },
    )
    expect(backToDiscuss).toContain("WorkMode BUILD -> DISCUSS")
    expect(backToDiscuss).toContain("PermissionMode UNRESTRICTED -> ASK")
  })
})

describe("createMinicodeSession — hint WorkMode & PermissionMode mencapai wire", () => {
  async function systemFor(
    workMode: "DISCUSS" | "EXECUTE",
    permissionMode: "auto" | "ask" | "unrestricted" = "auto",
  ): Promise<string> {
    const dir = tmpRoot(`${workMode.toLowerCase()}-${permissionMode}`)
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode,
      workMode,
    })
    await session.run("helm")
    const req = provider.requests[0]
    return typeof req?.system === "string" ? req.system : ""
  }

  test("workMode DISCUSS → system prompt memuat DISCUSS MODE + PERMISSION MODE", async () => {
    const sys = await systemFor("DISCUSS", "auto")
    expect(sys).toContain("DISCUSS MODE")
    expect(sys).toContain("PERMISSION MODE: AUTO")
    expect(sys).toContain("discuss findings, options, and trade-offs")
    expect(sys).toContain("concrete implementation plan")
  })

  test("workMode EXECUTE → system prompt memuat BUILD MODE positif (bukan PLAN)", async () => {
    const sys = await systemFor("EXECUTE", "unrestricted")
    expect(sys).toContain("BUILD MODE")
    expect(sys).toContain("PERMISSION MODE: UNRESTRICTED")
    expect(sys).not.toContain("DISCUSS MODE")
    expect(sys).not.toContain("PLAN MODE")
  })

  test("transisi bolak-balik WorkMode & PermissionMode menyegarkan system prompt & menyisipkan update wire tanpa mencemari history", async () => {
    const dir = tmpRoot("rt-prompt")
    await mkdir(join(dir, ".minicode"), { recursive: true })
    const provider = new FakeProvider([])
    let wmCtl: { setWorkMode(m: "DISCUSS" | "EXECUTE"): void } | undefined
    let pmCtl: { setMode(m: "auto" | "ask" | "unrestricted" | "plan"): void } | undefined
    const session = await createMinicodeSession({
      provider,
      tools: [readFileTool],
      cwd: dir,
      permissionMode: "auto",
      workMode: "DISCUSS",
      onWorkMode: (ctl) => {
        wmCtl = ctl
      },
      onPermissions: (ctl) => {
        pmCtl = ctl as never
      },
    })

    // Turn 1: DISCUSS × auto → tidak ada note transisi di pesan user.
    await session.run("t1")
    const sys1 = String(provider.requests[0]?.system ?? "")
    expect(sys1).toContain("DISCUSS MODE")
    expect(sys1).toContain("PERMISSION MODE: AUTO")
    expect(String(provider.requests[0]?.messages.at(-1)?.content ?? "")).toBe("t1")

    // Turn 2: pindah ke BUILD + ASK → system diperbarui dan wire user message mendapat penanda transisi.
    wmCtl!.setWorkMode("EXECUTE")
    pmCtl!.setMode("ask")
    await session.run("t2")
    const sys2 = String(provider.requests[1]?.system ?? "")
    expect(sys2).toContain("BUILD MODE")
    expect(sys2).toContain("PERMISSION MODE: ASK")
    expect(sys2).not.toContain("DISCUSS MODE")
    const wireMsg2 = String(provider.requests[1]?.messages.at(-1)?.content ?? "")
    expect(wireMsg2).toContain("[Runtime mode update:")
    expect(wireMsg2).toContain("WorkMode DISCUSS -> BUILD")
    expect(wireMsg2).toContain("PermissionMode AUTO -> ASK")
    expect(wireMsg2).toContain("t2")
    // State histori kanonik tetap bersih dari wrapper transisi.
    expect(JSON.stringify(session.state.history)).not.toContain("[Runtime mode update:")

    // Turn 3: mode tidak berubah → tidak ada banner transisi berulang.
    await session.run("t3")
    expect(String(provider.requests[2]?.messages.at(-1)?.content ?? "")).toBe("t3")

    // Turn 4: aktifkan unrestricted lalu kembali DISCUSS + plan → kedua transisi tercermin.
    pmCtl!.setMode("unrestricted")
    await session.run("t4")
    const sys4 = String(provider.requests[3]?.system ?? "")
    expect(sys4).toContain("PERMISSION MODE: UNRESTRICTED")
    expect(String(provider.requests[3]?.messages.at(-1)?.content ?? "")).toContain(
      "PermissionMode ASK -> UNRESTRICTED",
    )

    wmCtl!.setWorkMode("DISCUSS")
    pmCtl!.setMode("plan")
    await session.run("t5")
    const sys5 = String(provider.requests[4]?.system ?? "")
    expect(sys5).toContain("DISCUSS MODE")
    expect(sys5).toContain("read-only planning mode")
    expect(String(provider.requests[4]?.messages.at(-1)?.content ?? "")).toContain(
      "WorkMode BUILD -> DISCUSS",
    )
  })
})
