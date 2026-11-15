import { expect, test } from "bun:test"
import {
  createDecoderState,
  decodeKey,
  decodeKeysStream,
  flushLoneEsc,
  hasPendingLoneEsc,
  type PromptKey,
} from "../src/ui/input/prompt-engine.ts"

const encoder = new TextEncoder()

function everySplit(input: string, expected: PromptKey[]) {
  const bytes = encoder.encode(input)
  for (let split = 0; split <= bytes.length; split++) {
    const state = createDecoderState()
    const keys = [
      ...decodeKeysStream(bytes.slice(0, split), state),
      ...decodeKeysStream(bytes.slice(split), state),
    ].map((decoded) => decoded.key)
    expect(keys, `split ${split} of ${JSON.stringify(input)}`).toEqual(expected)
    expect(state.pending).toEqual([])
  }
}

test("A4: malformed CSI/SS3 preserves Ctrl+C at every split", () => {
  for (const prefix of ["\x1b[", "\x1b[1;", "\x1b[ ", "\x1bO", "\x1bO1;", "\x1b[<0;1;"]) {
    everySplit(`${prefix}\x03x`, [
      { type: "ignore" },
      { type: "ctrl-c" },
      { type: "char", ch: "x" },
    ])
  }
})

test("A4: malformed prefixes preserve other independent controls and new sequences", () => {
  for (const prefix of ["\x1b[1;", "\x1bO1;", "\x1b[<0;"]) {
    everySplit(`${prefix}\r\t\x1b[A`, [
      { type: "ignore" },
      { type: "enter" },
      { type: "tab" },
      { type: "up" },
    ])
  }
})

test("A4: pending CSI/SS3 is bounded and Ctrl+C still recovers", () => {
  for (const prefix of ["\x1b[", "\x1bO", "\x1b[<"]) {
    const state = createDecoderState()
    decodeKeysStream(encoder.encode(prefix), state)
    for (let i = 0; i < 4096; i++) {
      decodeKeysStream(encoder.encode("1"), state)
      expect(state.pending.length).toBeLessThanOrEqual(64)
    }
    const keys = decodeKeysStream(encoder.encode("\x03"), state)
    expect(keys.at(-1)?.key).toEqual({ type: "ctrl-c" })
    expect(state.pending).toEqual([])
  }
})

test("A4: overlong CSI/SS3/SGR consumes its suffix through the final at every split", () => {
  for (const [prefix, final] of [
    ["\x1b[", "~"],
    ["\x1bO", "A"],
    ["\x1b[<", "M"],
    ["\x1b[<", "m"],
  ]) {
    for (const length of [63, 64, 65, 130]) {
      const sequence = prefix + "1".repeat(length - prefix!.length) + final
      everySplit(`${sequence}x`, [{ type: "ignore" }, { type: "char", ch: "x" }])
    }
  }
})

test("A4: discard state preserves independent controls, UTF-8 and new sequences", () => {
  const recoveries: [string, PromptKey[]][] = [
    ["\x03x", [{ type: "ctrl-c" }, { type: "char", ch: "x" }]],
    ["\x04x", [{ type: "ctrl-d" }, { type: "char", ch: "x" }]],
    ["\r\t\n", [{ type: "enter" }, { type: "tab" }, { type: "ctrl-j" }]],
    ["\x7fx", [{ type: "backspace" }, { type: "char", ch: "x" }]],
    ["\x1b[A", [{ type: "up" }]],
    ["\x1bOD", [{ type: "left" }]],
    ["\x1b[200~hello\x1b[201~", [{ type: "char", ch: "hello" }]],
    ["😀", [{ type: "char", ch: "😀" }]],
  ]
  for (const prefix of ["\x1b[", "\x1bO", "\x1b[<"]) {
    for (const [suffix, keys] of recoveries) {
      everySplit(`${prefix}${"1".repeat(128)}${suffix}`, [{ type: "ignore" }, ...keys])
    }
    const state = createDecoderState()
    const keys: PromptKey[] = []
    for (const byte of encoder.encode(`${prefix}${"1".repeat(4096)}`)) {
      keys.push(...decodeKeysStream(Uint8Array.of(byte), state).map((decoded) => decoded.key))
      expect(state.pending.length).toBeLessThanOrEqual(64)
    }
    expect(keys).toEqual([{ type: "ignore" }])
    expect(state.pending).toEqual([])
    expect(decodeKeysStream(new Uint8Array(), state)).toEqual([])
    expect(flushLoneEsc(state)).toEqual([])
    expect(decodeKeysStream(encoder.encode("123;456"), state)).toEqual([])
    expect(decodeKeysStream(encoder.encode("\x1b"), state)).toEqual([])
    expect(hasPendingLoneEsc(state)).toBe(true)
    expect(flushLoneEsc(state).map((decoded) => decoded.key)).toEqual([{ type: "esc" }])
    expect(decodeKeysStream(encoder.encode("x"), state).map((decoded) => decoded.key)).toEqual([
      { type: "char", ch: "x" },
    ])
  }
})

test("A5: unsupported modified arrows are ignored at every split", () => {
  for (const prefix of ["\x1b[", "\x1bO"]) {
    for (const arrow of ["A", "B", "C", "D"]) {
      const sequence = `${prefix}1;5${arrow}`
      everySplit(`${sequence}x`, [{ type: "ignore" }, { type: "char", ch: "x" }])
      expect(decodeKey(sequence, 0)).toEqual({ key: { type: "ignore" }, width: sequence.length })
    }
  }
  for (const sequence of ["\x1b[99~", "\x1b[5;34R", "\x1bOP"]) {
    everySplit(sequence, [{ type: "ignore" }])
    expect(decodeKey(`${sequence}x`, 0)).toEqual({
      key: { type: "ignore" },
      width: sequence.length,
    })
  }
})

test("A4/A5: supported CSI/SS3 remains valid at every split", () => {
  const samples: [string, PromptKey][] = [
    ["\x1b[A", { type: "up" }],
    ["\x1bOD", { type: "left" }],
    ["\x1b[3~", { type: "delete" }],
    ["\x1b[5;2~", { type: "pageup", modifier: 2 }],
    ["\x1b[Z", { type: "shift-tab" }],
    ["\x1b[200~hello\x1b[201~", { type: "char", ch: "hello" }],
  ]
  for (const [sequence, key] of samples) everySplit(sequence, [key])
})
