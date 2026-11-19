// Audit #2 — regresi state per-turn yang ditimpa run "busy" yang ditolak.
// Run kedua yang dipanggil selagi run pertama aktif dulu menimpa
// activeTurnTransitionNote / turnSentStream, lalu finally-nya menghapus catatan
// milik turn pertama (lastTurnMode jadi salah). Sekarang cleanup milik pemilik
// state saja, dan run busy tidak menyentuh state sama sekali.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore"
import { createMinicodeSession, type WorkModeControl } from "../src/app/session.ts"

class GatedProvider implements ModelProvider {
  readonly id = "gated"
  readonly models = ["gated-1"]
  readonly requests: StreamRequest[] = []
  private callCount = 0
  private releaseGate!: () => void
  private gate = new Promise<void>((res) => (this.releaseGate = res))

  constructor(private readonly gatedCall: number) {}

  async *stream(req: StreamRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    if (this.callCount++ === this.gatedCall) await this.gate
    yield { type: "text", text: "oke" }
    yield { type: "finish", reason: "stop" }
  }

  release(): void {
    this.releaseGate()
  }
}

function lastUserContent(req: StreamRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i]!
    if (msg.role === "user")
      return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
  }
  return ""
}

describe("audit #2: penolakan busy tak merusak state turn aktif", () => {
  test("lastTurnMode hanya diupdate oleh turn pemilik", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mc-runown-"))
    // Provider dipanggil sekali per run; run ke-2 (indeks 1) digate supaya
    // tetap aktif saat run ke-3 dipanggil. Run busy tak memanggil provider.
    const provider = new GatedProvider(1)
    let wm!: WorkModeControl
    try {
      const s = await createMinicodeSession({
        provider,
        cwd,
        onWorkMode: (ctl) => {
          wm = ctl
        },
      })

      // Run 1: EXECUTE → finally mencatat lastTurnMode = EXECUTE.
      await s.run("satu")
      expect(provider.requests).toHaveLength(1)

      // Run 2: pindah ke DISCUSS. Anotasi BUILD -> DISCUSS menempel pada
      // request run 2. Provider digate jadi run 2 masih berjalan.
      wm.setWorkMode("DISCUSS")
      const active = s.run("dua")
      expect(provider.requests).toHaveLength(2)
      expect(lastUserContent(provider.requests[1]!)).toContain("WorkMode BUILD -> DISCUSS")

      // Run 3 ditolak busy. Kode lama menimpa turnSentStream dan finally-nya
      // menggagalkan update lastTurnMode milik run 2 yang masih aktif.
      await expect(s.run("tiga")).rejects.toThrow()

      provider.release()
      await active

      // Kembali ke EXECUTE. Bila lastTurnMode benar (DISCUSS, ditulis run 2),
      // run 4 menyisipkan anotasi DISCUSS -> BUILD. Kode lama meninggalkan
      // EXECUTE sehingga tak ada anotasi transisi sama sekali.
      wm.setWorkMode("EXECUTE")
      await s.run("empat")
      expect(lastUserContent(provider.requests[2]!)).toContain("WorkMode DISCUSS -> BUILD")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20000)
})
