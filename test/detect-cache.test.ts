import { afterAll, expect, test } from "bun:test"
import { clearDetectCache, detectModels } from "../src/providers/detect.ts"

const origFetch = globalThis.fetch
let calls = 0
globalThis.fetch = (async () => {
  calls++
  return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 })
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = origFetch
  clearDetectCache()
})

test("detect cache: panggilan kedua tidak hit jaringan", async () => {
  clearDetectCache()
  calls = 0
  const r1 = await detectModels("https://alpha.test/v1", "k")
  const r2 = await detectModels("https://alpha.test/v1", "k") // same URL → cache hit
  expect(r1.models.join(",")).toBe(r2.models.join(","))
  expect(calls).toBe(1)
})

test("detect cache: baseUrl berbeda & trailing slash dinormalisasi", async () => {
  clearDetectCache()
  calls = 0
  await detectModels("https://alpha.test/v1/", "k") // trailing slash → same key
  await detectModels("https://alpha.test/v1", "k")
  expect(calls).toBe(1)
})

test("detect cache: credentials and case-sensitive paths stay isolated", async () => {
  clearDetectCache()
  calls = 0
  await detectModels("https://alpha.test/TenantA", "first")
  await detectModels("https://ALPHA.test/TenantA/", "first")
  expect(calls).toBe(1)
  await detectModels("https://alpha.test/TenantA", "second")
  await detectModels("https://alpha.test/tenanta", "first")
  expect(calls).toBe(3)
})

test("detect cache: clearDetectCache memaksa re-fetch", async () => {
  clearDetectCache()
  calls = 0
  await detectModels("https://beta.test/v1", "k")
  clearDetectCache()
  await detectModels("https://beta.test/v1", "k")
  expect(calls).toBe(2)
})
