// Regresi kontrol decoder stdin (temuan H3/L2/L3 dari audit read-only):
// Alt+printable tak boleh dibaca Esc (mengabort turn), Alt+Enter yang terbelah
// antar chunk tetap newline, dan paste overflow tak boleh memotong code point.
import { expect, test } from "bun:test"
import { createDecoderState, decodeKeysStream } from "../src/ui/input/prompt-engine.ts"

test("H3: ESC+'b' (Alt+b) bukan esc — turn busy tak diabort", () => {
  const st = createDecoderState()
  const keys = decodeKeysStream(new Uint8Array([0x1b, 0x62]), st)
  expect(keys.some((d) => d.key.type === "esc")).toBe(false)
  expect(keys.map((d) => d.key)).toEqual([{ type: "ignore" }, { type: "char", ch: "b" }])
  expect(st.pending).toEqual([])
})

test("H3: ESC + byte awal Utf-8 juga tak memancarkan esc", () => {
  const st = createDecoderState()
  const bytes = new TextEncoder().encode("b😀")
  const keys = decodeKeysStream(new Uint8Array([0x1b, ...bytes]), st)
  expect(keys.some((d) => d.key.type === "esc")).toBe(false)
  expect(keys.map((d) => d.key)).toEqual([
    { type: "ignore" },
    { type: "char", ch: "b" },
    { type: "char", ch: "😀" },
  ])
})

test("L2: Alt+Enter terbelah [0x1b] lalu [0x0d] = ctrl-j, bukan esc+enter", () => {
  const st = createDecoderState()
  expect(decodeKeysStream(new Uint8Array([0x1b]), st)).toEqual([])
  const second = decodeKeysStream(new Uint8Array([0x0d]), st)
  expect(second.map((d) => d.key.type)).toEqual(["ctrl-j"])
  expect(st.pending).toEqual([])
})

test("L3: paste overflow di batas 512 KiB tak memotong code point Utf-8", () => {
  const st = createDecoderState()
  const marker = new TextEncoder().encode("\x1b[200~")
  const emoji = new TextEncoder().encode("😀")
  const fill = 512 * 1024
  // Emoji mulai tepat di batas; hanya 2 dari 4 byte yang ikut chunk pertama.
  const chunk = new Uint8Array(marker.length + fill + 2)
  chunk.set(marker, 0)
  chunk.fill(0x61, marker.length, marker.length + fill)
  chunk.set(emoji.slice(0, 2), marker.length + fill)

  const keys = decodeKeysStream(chunk, st)
  const text = keys
    .filter((d) => d.key.type === "char")
    .map((d) => (d.key as { ch: string }).ch)
    .join("")
  expect(text).not.toContain("\ufffd")
  expect(text).toBe("a".repeat(fill))
  // Ekor code point ditahan, bukan diubah jadi U+FFFD lalu dibuang.
  expect(st.pending).toEqual(Array.from(emoji.slice(0, 2)))
  // Flag overflow harus tetap menyala lintas chunk; tanpa ini sisa payload
  // (CR / Ctrl-C) akan dibaca sebagai perintah, bukan teks literal.
  expect(st.pasteOverflow).toBe(true)
  const rest = decodeKeysStream(emoji.slice(2), st).map((d) => d.key)
  expect(rest).toEqual([{ type: "char", ch: "😀" }])
  expect(st.pending).toEqual([])
})

test("L3: emoji UTUH di dalam chunk overflow tak berubah jadi U+FFFD", () => {
  // Menjaga akar bug-nya: lastUtf8Boundary dulu berhenti di byte LEAD multibyte
  // walau sekuensnya lengkap (valid di-init false untuk n>1). Tanpa perbaikan,
  // emoji di tengah payload overflow dipancarkan sebagai Character Replacement.
  const st = createDecoderState()
  const marker = new TextEncoder().encode("\x1b[200~")
  const emoji = new TextEncoder().encode("😀")
  const fill = 512 * 1024
  const body = new Uint8Array(fill + emoji.length)
  body.fill(0x61, 0, fill)
  body.set(emoji, fill)
  const chunk = new Uint8Array(marker.length + body.length)
  chunk.set(marker, 0)
  chunk.set(body, marker.length)

  const text = decodeKeysStream(chunk, st)
    .filter((d) => d.key.type === "char")
    .map((d) => (d.key as { ch: string }).ch)
    .join("")
  expect(text).not.toContain("\ufffd")
  expect(text).toBe(`${"a".repeat(fill)}😀`)
  expect(st.pending).toEqual([])
})
