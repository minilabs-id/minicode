// Audit finding 3: withStrippedRetry/withEffortFallback tak boleh mengulang
// fallback dari awal bila primary sudah menghasilkan konten sebelum melempar
// ProviderError pemicu (SSE error di tengah stream) — itu menggandakan teks.
// Pagar ini mencerminkan hasYieldedContent di router.ts.

import { expect, test } from "bun:test"
import { ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider } from "#minicore/core/provider.ts"
import { withEffortFallback, withStrippedRetry } from "../src/providers/effort.ts"

function provider(
  id: string,
  gen: () => AsyncGenerator<unknown>,
): { p: ModelProvider; calls: () => number } {
  let calls = 0
  const p = {
    id,
    models: ["m"],
    async *stream(): AsyncGenerator<unknown> {
      calls++
      yield* gen()
    },
  } as unknown as ModelProvider
  return { p, calls: () => calls }
}

async function drain(p: ModelProvider): Promise<{ text: string; err?: ProviderError }> {
  const out: string[] = []
  let err: ProviderError | undefined
  try {
    for await (const ev of p.stream(
      { messages: [{ role: "user", content: "hi" }], model: "p::m" },
      new AbortController().signal,
    )) {
      if (ev.type === "text") out.push(ev.text)
    }
  } catch (e) {
    if (e instanceof ProviderError) err = e
    else throw e
  }
  return { text: out.join(""), err }
}

test("primary hasilkan teks lalu lempar server → error diteruskan, fallback tak dipanggil", async () => {
  const primary = provider("p", async function* () {
    yield { type: "text", text: "sebagian" }
    throw new ProviderError("server", "boom tengah stream")
  })
  const fallback = provider("f", async function* () {
    yield { type: "text", text: "dari-fallback" }
  })
  const w = withEffortFallback(primary.p, fallback.p, {
    providerId: "p",
    effort: "medium",
  })
  const { text, err } = await drain(w)
  expect(text).toBe("sebagian")
  expect(err?.category).toBe("server")
  expect(fallback.calls()).toBe(0)
})

test("error sebelum konten tetap memicu fallback (perilaku lama utuh)", async () => {
  const primary = provider("p", async function* () {
    const noEvents: unknown[] = []
    yield* noEvents
    throw new ProviderError("server", "boom sebelum konten")
  })
  const fallback = provider("f", async function* () {
    yield { type: "text", text: "pulih" }
  })
  const w = withStrippedRetry(primary.p, fallback.p, {
    providerId: "p",
    triggerCategories: new Set(["server"]),
  })
  const { text, err } = await drain(w)
  expect(text).toBe("pulih")
  expect(err).toBeUndefined()
  expect(fallback.calls()).toBe(1)
})

test("extension reasoning juga dihitung sebagai konten (cermin router)", async () => {
  const primary = provider("p", async function* () {
    yield { type: "extension", kind: "reasoning", data: { text: "berpikir" } }
    throw new ProviderError("server", "boom")
  })
  const fallback = provider("f", async function* () {
    yield { type: "text", text: "dari-fallback" }
  })
  const w = withStrippedRetry(primary.p, fallback.p, { providerId: "p" })
  const { text, err } = await drain(w)
  expect(text).toBe("")
  expect(err?.category).toBe("server")
  expect(fallback.calls()).toBe(0)
})
