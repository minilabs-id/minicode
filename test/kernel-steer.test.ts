// Seam steering kernel: pesan user yang dikirim selagi turn berjalan masuk ke
// konteks turn AKTIF pada batas step berikutnya (semantik "steer" opencode),
// bukan menunggu turn selesai.
//
// Gagal-di-kode-lama: `Session` tak punya `steer()`; pesan dari UI hanya bisa
// diantrikan sampai turn selesai.

import { expect, test } from "bun:test"
import { createSession, type Session } from "#minicore/core/index.ts"
import { allowAll, FakeProvider, finish, text, tool, toolCall } from "#minicore/test/fakes.ts"

test("steer: pesan user masuk ke turn aktif sebelum request berikutnya", async () => {
  let session: Session | null = null
  let steeredWhileRunning = false
  let steeredWhileIdle = false
  const provider = new FakeProvider([
    // Step 1: model memanggil tool yang lambat — jendela tempat user menyelipkan
    // koreksi (persis seperti tool bash yang sedang berjalan di sesi nyata).
    { events: [toolCall("slow", {}), finish("tool_calls")] },
    // Step 2: setelah steering masuk, model menjawab.
    { events: [text("koreksi diterima"), finish("stop")] },
  ])
  const slow = tool("slow", async () => {
    steeredWhileRunning = session!.steer("pakai jalur B") === true
    return "ok"
  })
  session = createSession({ provider, permissions: allowAll, tools: [slow] })

  const result = await session.run("kerjakan A")
  steeredWhileIdle = session.steer("terlambat") === true

  // Pesan steering muncul sebagai `user` di antara hasil tool step 1 dan
  // request step 2 — bukan sebagai turn terpisah.
  const second = provider.requests[1]
  const roles = second?.messages.map((m) => m.role) ?? []
  expect(roles).toEqual(["user", "assistant", "tool", "user"])
  expect(second?.messages.at(-1)).toMatchObject({ role: "user", content: "pakai jalur B" })
  // Turn tetap satu (satu `run`), dengan satu step tool.
  expect(result.steps).toHaveLength(1)
  expect(result.finalText).toBe("koreksi diterima")
  expect(steeredWhileRunning).toBe(true)
  // Idle menolak: pesan tak ditampung diam-diam saat tak ada turn berjalan.
  expect(steeredWhileIdle).toBe(false)
  // Steering ikut ter-commit sebagai bagian histori turn.
  expect(session.state.history.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
  ])
})

test("steer: pesan yang tiba setelah model selesai tetap dijawab di turn yang sama", async () => {
  let session: Session | null = null
  const provider = new FakeProvider([
    { events: [text("selesai"), finish("stop")] },
    // Turn lanjutan (dipicu steering) harus memakai request BARU yang memuat
    // pesan steering; tanpa balasan, pesan user akan menggantung.
    { events: [text("tambahan diproses"), finish("stop")] },
  ])
  session = createSession({ provider, permissions: allowAll })
  let once = false
  const onText = () => {
    // Tepat saat teks pertama tiba, user menyelipkan informasi tambahan
    // (sekali saja — tiap teks berikutnya bukan input user baru).
    if (once) return
    once = true
    session!.steer("jangan lupa test")
  }
  session.events.on("provider:text", onText)

  const result = await session.run("kerjakan")

  expect(provider.requests).toHaveLength(2)
  expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
    role: "user",
    content: "jangan lupa test",
  })
  expect(result.finalText).toBe("tambahan diproses")
  // Dua request provider = dua langkah yang ditagih; tanpa ini anggaran
  // `maxSteps` dan laporan `usage.steps` mengabaikan request lanjutan.
  expect(result.usage.steps).toBe(1)
  expect(session.state.history.at(-1)).toMatchObject({
    role: "assistant",
    content: "tambahan diproses",
  })
})

test("steer: pesan yang belum terkirim hilang bersama turn yang di-abort", async () => {
  let session: Session | null = null
  const provider = new FakeProvider([
    { events: [toolCall("slow", {}), finish("tool_calls")] },
    { events: [text("turn kedua"), finish("stop")] },
  ])
  const slow = tool("slow", async () => {
    // Pesan diterima kernel, lalu turn dibatalkan sebelum batas step sempat
    // di-drain — persis jendela tempat pesan dulu bocor ke turn berikutnya.
    expect(session!.steer("jangan dipakai")).toBe(true)
    session!.abort()
    return "ok"
  })
  session = createSession({ provider, permissions: allowAll, tools: [slow] })

  await expect(session.run("turn-1")).rejects.toMatchObject({ kind: "aborted" })
  expect(session.steer("telat")).toBe(false)

  const result = await session.run("turn-2")
  expect(result.finalText).toBe("turn kedua")
  // Request turn kedua hanya memuat prompt baru: tidak ada `user` hantu dari
  // turn yang dibatalkan (dua `user` berurutan juga melanggar invariant 400).
  expect(provider.requests[1]?.messages.map((m) => m.content)).toEqual(["turn-2"])
  expect(session.state.history.map((m) => m.content)).toEqual(["turn-2", "turn kedua"])
})

test("steer: request lanjutan menagih anggaran langkah (maxSteps)", async () => {
  let session: Session | null = null
  const provider = new FakeProvider([{ events: [text("jawaban pertama"), finish("stop")] }])
  session = createSession({ provider, permissions: allowAll, maxSteps: 1 })
  let once = false
  session.events.on("provider:text", () => {
    if (once) return
    once = true
    session!.steer("tambahan")
  })

  // Satu langkah sudah dipakai request pertama; request lanjutan untuk
  // menjawab steering harus ditolak anggaran, bukan berjalan gratis.
  await expect(session.run("kerjakan")).rejects.toMatchObject({ kind: "max_steps_exceeded" })
  expect(provider.requests).toHaveLength(1)
  // Progres sah tetap di-commit, tetapi steering yang tak sempat dibalas tidak
  // boleh tertinggal sebagai `user` menggantung di ekor histori.
  expect(session.state.history.map((m) => m.content)).toEqual(["kerjakan", "jawaban pertama"])
})
