import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import {
  __resetTokenizerCache,
  getCachedTokenizer,
  loadTokenizer,
} from "../src/policy/tokenizer-registry.ts"

let origFetch: typeof globalThis.fetch
let origHome: string | undefined
let origTokenizers: string | undefined
let diskMocks: Array<{ mockRestore(): void }>

beforeEach(() => {
  origHome = process.env.MINICODE_HOME
  origTokenizers = process.env.MINICODE_TOKENIZERS
  process.env.MINICODE_HOME = "tokenizer-registry-test"
  delete process.env.MINICODE_TOKENIZERS
  origFetch = globalThis.fetch
  diskMocks = [
    spyOn(fs, "existsSync").mockReturnValue(false),
    spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(fakeModel)),
    spyOn(fs, "mkdirSync").mockReturnValue(undefined),
    spyOn(fs, "writeFileSync").mockReturnValue(undefined),
  ]
  __resetTokenizerCache()
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const mock of diskMocks) mock.mockRestore()
  if (origHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = origHome
  if (origTokenizers === undefined) delete process.env.MINICODE_TOKENIZERS
  else process.env.MINICODE_TOKENIZERS = origTokenizers
  __resetTokenizerCache()
})

const fakeModel = { vocab: { t: 0, h: 1, e: 2, the: 3 }, merges: ["t h", "th e"] }

function mockFetch(ok: boolean) {
  return spyOn(globalThis, "fetch").mockImplementation((async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => ({ model: fakeModel }),
  })) as unknown as typeof fetch)
}

describe("tokenizer registry (unduh + cache)", () => {
  test("MINICODE_TOKENIZERS=0 prevents network and disk work", async () => {
    const fetchMock = mockFetch(true)
    process.env.MINICODE_TOKENIZERS = "0"

    expect(await loadTokenizer("deepseek-v4-flash")).toBeNull()
    expect(getCachedTokenizer("deepseek-v4-flash")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  test("model deepseek mengunduh tokenizer lalu cache sinkron", async () => {
    mockFetch(true)
    const tok = await loadTokenizer("deepseek-v4-flash")
    expect(tok).not.toBeNull()
    expect(tok!.countTokens("the")).toBe(1)
    expect(getCachedTokenizer("deepseek-v4-flash")).not.toBeNull()
  })

  test("model tak dikenal -> null (fallback estimator densitas)", async () => {
    mockFetch(true)
    expect(await loadTokenizer("some-unknown-model")).toBeNull()
    expect(getCachedTokenizer("some-unknown-model")).toBeNull()
  })

  test("unduh gagal (404/network) -> null, tidak melempar", async () => {
    mockFetch(false)
    expect(await loadTokenizer("deepseek-x")).toBeNull()
  })

  test("cache disk dipakai ulang antar-proses (tanpa fetch kedua)", async () => {
    const fetchMock = mockFetch(true)
    const first = await loadTokenizer("deepseek-v4-flash")
    expect(first).not.toBeNull()
    __resetTokenizerCache()
    spyOn(fs, "existsSync").mockReturnValue(true)
    const again = await loadTokenizer("deepseek-v4-flash")
    expect(again).not.toBeNull()
    expect(again!.countTokens("the")).toBe(1)
    expect(fs.readFileSync).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
