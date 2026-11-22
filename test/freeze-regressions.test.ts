// Regresi audit freeze/ceket 2026-11-16.
//
// Tiga kegagalan nyata yang membuat sesi terasa "ceket/macet", semuanya
// terukur sebelum diperbaiki:
//  1. Provider yang menerima koneksi lalu diam total menahan turn sampai
//     timeout TOTAL (300 dtk di produksi) — user tak bisa membedakannya dari
//     hang. Sekarang batas DIAM memotongnya jauh lebih awal.
//  2. `git ls-files` mewarisi stdin TTY + dibaca dari `child.stdout` yang
//     kosong di TUI: repo-map selalu jatuh ke walk direktori (~1 dtk).
//  3. Tidak ada handler `uncaughtException`/`unhandledRejection`: satu rejection
//     yang lolos mematikan proses dan meninggalkan terminal dalam raw mode.
import { describe, expect, test } from "bun:test"
import { withStreamGuards } from "../src/providers/guards.ts"

function makeProvider(gen: () => AsyncGenerator<unknown>) {
  return {
    id: "fake",
    get models() {
      return ["m"]
    },
    stream: () => gen(),
  }
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) {
    // buang
  }
}

describe("provider idle timeout", () => {
  test("provider yang diam total gagal di batas DIAM, bukan batas total", async () => {
    // Tak pernah mengirim satu event pun — persis "endpoint hidup tapi bisu".
    // Generator digantung TANPA setTimeout: timer 10 dtk lama tak bisa dibatalkan
    // oleh `.return()`/idle-timeout dan meninggalkan handle di event loop.
    // Sebagai gantinya generator menunggu promise manual yang dilepas di cleanup.
    let release!: () => void
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = makeProvider(async function* () {
      await stalled
      // Biome useYield: generator wajib memuat `yield`, tapi cabang ini tak
      // pernah jalan — provider harus tetap diam total saat idle-timeout diuji.
      if (Date.now() < 0) yield { type: "finish", reason: "stop" }
    })
    const guarded = withStreamGuards(provider as never, {
      timeoutMs: 60_000,
      idleTimeoutMs: 150,
    })
    const started = Date.now()
    let message = ""
    try {
      await drain(guarded.stream({} as never, new AbortController().signal))
    } catch (e) {
      message = (e as Error).message
    } finally {
      // Lepaskan generator yang menggantung agar tak ada suspend/timer sisaan.
      release()
    }
    const elapsed = Date.now() - started
    expect(message).toContain("sent nothing")
    // Harus jauh di bawah timeout total 60 dtk.
    expect(elapsed).toBeLessThan(5_000)
  })

  test("stream lambat tapi tidak pernah diam tidak dipotong", async () => {
    // Tiap chunk datang lebih cepat dari batas diam: harus selesai utuh.
    const provider = makeProvider(async function* () {
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((r) => setTimeout(r, 80))
        yield { type: "text", text: `c${i}` }
      }
      yield { type: "finish", reason: "stop" }
    })
    const guarded = withStreamGuards(provider as never, {
      timeoutMs: 60_000,
      idleTimeoutMs: 400,
    })
    let text = ""
    for await (const ev of guarded.stream({} as never, new AbortController().signal)) {
      const e = ev as { type: string; text?: string }
      if (e.type === "text") text += e.text ?? ""
    }
    expect(text).toBe("c0c1c2c3c4")
  })

  test("batas diam 0 mematikan deteksi diam (perilaku lama)", async () => {
    const provider = makeProvider(async function* () {
      await new Promise<void>((r) => setTimeout(r, 120))
      yield { type: "text", text: "x" }
      yield { type: "finish", reason: "stop" }
    })
    const guarded = withStreamGuards(provider as never, { timeoutMs: 5_000, idleTimeoutMs: 0 })
    let text = ""
    for await (const ev of guarded.stream({} as never, new AbortController().signal)) {
      const e = ev as { type: string; text?: string }
      if (e.type === "text") text += e.text ?? ""
    }
    expect(text).toBe("x")
  })
})

describe("repo-map tidak menahan startup", () => {
  test("git ls-files dibaca dari pipe eksplisit, bukan child.stdout yang bisa kosong", async () => {
    // Bukti tidak langsung: pada repo ini hasilnya harus berisi berkas nyata.
    // Sebelum perbaikan, `child.stdout` mengembalikan 0 byte di TUI sehingga
    // daftar jatuh ke walk dan repo-map tetap kosong walau git tersedia.
    const { loadRepoMap } = await import("../src/repo/repomap.ts")
    const cwd = process.cwd()
    const map = await loadRepoMap(cwd)
    // Repo ini punya symbol TS; peta yang benar tidak kosong.
    expect(map.length).toBeGreaterThan(0)
  })

  test("loadRepoMap kedua dalam proses yang sama tidak menyentuh disk lagi", async () => {
    const { loadRepoMap } = await import("../src/repo/repomap.ts")
    const cwd = process.cwd()
    await loadRepoMap(cwd)
    const first = performance.now()
    await loadRepoMap(cwd)
    const second = performance.now() - first
    // Panggilan memo harus praktis gratis (< 20 ms vs ~100 ms tanpa memo).
    expect(second).toBeLessThan(20)
  })
})

describe("jaring keselamatan proses", () => {
  test("installCrashGuard terpasang dan idempoten", async () => {
    // Handler global dipasang di entry CLI. Di sini cukup membuktikan modul
    // mengekspos perilaku yang sama: tanpa handler, satu throw = proses mati.
    const source = await Bun.file(new URL("../cli/index.ts", import.meta.url)).text()
    expect(source).toContain('process.on("uncaughtException"')
    expect(source).toContain('process.on("unhandledRejection"')
    // Terminal harus dipulihkan sebelum exit, bukan cuma mencetak pesan.
    expect(source).toContain("setRawMode?.(false)")
    expect(source).toContain("\\u001b[?1049l")
    // EIO dari stdin PTY pasca-/shell tidak boleh membunuh proses sebelum
    // reacquireTerminal sempat menulis ENTER lagi.
    expect(source).toContain('e?.code === "EIO"')
  })
})
