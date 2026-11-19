// Regresi temuan audit VERIFIED (F5–F6) pada decoder stdin.
// F5: payload paste yang overflow harus tetap literal (CR/0x03 bukan perintah).
// F6: parsing SGR mouse tak boleh mencari semicolon di event berikutnya.
import { expect, test } from "bun:test"
import { createDecoderState, decodeKeysStream } from "../src/ui/input/prompt-engine.ts"

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

test("F5: overflow bracketed paste — sisa payload dibaca literal sampai ESC[201~", () => {
  const st = createDecoderState()
  // Chunk pertama melewati batas 512 KiB tanpa terminator → mode overflow.
  const head = enc(`\x1b[200~${"a".repeat(520 * 1024)}`)
  const first = decodeKeysStream(head, st)
  expect(first.length).toBe(1)
  expect(first[0]!.key.type).toBe("char")
  expect(st.pasteOverflow).toBe(true)
  // Ekornya memuat CR dan 0x03. Kode lama mendeecode keduanya jadi
  // `enter` (submit) dan `ctrl-c` (cancel) — audit VERIFIED.
  const second = decodeKeysStream(enc("TAIL\r\x03AKHIR\x1b[201~"), st)
  expect(second.length).toBeGreaterThan(0)
  expect(second.every((k) => k.key.type === "char")).toBe(true)
  const literal = second.map((k) => (k.key.type === "char" ? k.key.ch : "")).join("")
  expect(literal).toBe("TAIL\r\x03AKHIR")
  // Terminator mengakhiri mode overflow; input normal kembali hidup.
  expect(st.pasteOverflow).toBe(false)
  const normal = decodeKeysStream(enc("\r"), st)
  expect(normal.map((k) => k.key.type)).toEqual(["enter"])
})

test("F5: overflow paste terbelah beberapa chunk tetap konsisten", () => {
  const st = createDecoderState()
  const head = enc(`\x1b[200~${"b".repeat(520 * 1024)}`)
  expect(decodeKeysStream(head, st).map((k) => k.key.type)).toEqual(["char"])
  // Potong terminator di dua chunk: "ESC[" | "201~". Mode overflow harus
  // bertahan dan tak mengeluarkan `esc`/char nyasar dari potongan itu.
  const mid = decodeKeysStream(enc("x\r\x1b["), st)
  expect(mid.every((k) => k.key.type === "char")).toBe(true)
  expect(mid.map((k) => (k.key.type === "char" ? k.key.ch : "")).join("")).toBe("x\r")
  const tail = decodeKeysStream(enc("201~"), st)
  expect(tail.every((k) => k.key.type === "char")).toBe(true)
  expect(st.pasteOverflow).toBe(false)
})

test("F6: dua event SGR mouse bersebelahan ter-parse terpisah", () => {
  const keys = decodeKeysStream(enc("\x1b[<0;12;34M\x1b[<0;56;78M"), createDecoderState())
  const mice = keys.filter((k) => k.key.type === "mouse")
  expect(mice.length).toBe(2)
  expect(mice[0]!.key).toMatchObject({ action: "press", button: 0, x: 12, y: 34 })
  expect(mice[1]!.key).toMatchObject({ action: "press", button: 0, x: 56, y: 78 })
})

test("F6: event SGR dengan ; di unevaluasi event lain tak ikut terseret", () => {
  // Event pertama berformat sah; event kedua memakai 'm' (release). Pencarian
  // semicolon dibatasi ke event masing-masing oleh implementasi baru.
  const keys = decodeKeysStream(enc("\x1b[<32;3;4M\x1b[<0;9;10m"), createDecoderState())
  expect(keys.map((k) => k.key)).toMatchObject([
    { type: "mouse", action: "drag", x: 3, y: 4 },
    { type: "mouse", action: "release", x: 9, y: 10 },
  ])
})
