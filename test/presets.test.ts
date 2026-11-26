import { expect, test } from "bun:test"
import { CUSTOM_PRESET_ID, findPreset, GATEWAY_PRESETS } from "../src/providers/presets.ts"

test("presets: daftar gateway terdaftar kosong (langsung BaseURL + API key)", () => {
  expect(GATEWAY_PRESETS).toEqual([])
})

test("presets: custom sentinel + findPreset tidak mengembalikan preset bawaan", () => {
  expect(CUSTOM_PRESET_ID).toBe("custom")
  expect(findPreset("openai")).toBeUndefined()
  expect(findPreset("openrouter")).toBeUndefined()
  expect(findPreset("nope")).toBeUndefined()
})
