import { describe, expect, test } from "bun:test"
import { deriveProviderId } from "../src/providers/provision.ts"

describe("deriveProviderId (5.1 friendly id)", () => {
  test("baseUrl → slug ramah dari host/path (tanpa daftar preset)", () => {
    expect(deriveProviderId("https://openrouter.ai/api/v1", [])).toBe("openrouter-ai-api")
    expect(deriveProviderId("https://api.deepseek.com/v1", [])).toBe("api-deepseek-com")
    expect(deriveProviderId("http://localhost:11434/v1", [])).toBe("localhost-11434")
  })
  test("unknown baseUrl → slug, no random suffix", () => {
    const id = deriveProviderId("https://my.gateway.example.com/v1", [])
    expect(id).not.toMatch(/[0-9a-z]{4}$/) // tidak ada hash acak di ekor
    expect(id).toBe("my-gateway-example-com")
  })
  test("explicit id used as-is", () => {
    expect(deriveProviderId("https://x", [], "my-provider")).toBe("my-provider")
  })
  test("collision → numeric suffix ramah", () => {
    expect(deriveProviderId("https://openrouter.ai/api/v1", ["openrouter-ai-api"])).toBe(
      "openrouter-ai-api-2",
    )
    expect(
      deriveProviderId("https://openrouter.ai/api/v1", [
        "openrouter-ai-api",
        "openrouter-ai-api-2",
      ]),
    ).toBe("openrouter-ai-api-3")
  })
  test("id sliced to 30 chars", () => {
    const long = "a".repeat(40)
    expect(deriveProviderId("https://x", [], long).length).toBe(30)
  })
})
