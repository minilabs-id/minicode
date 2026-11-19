// v7.38 (L7): pagar ReDoS pada fallback JS grep.
// Seam yang dipakai: MINICODE_GREP_ENGINE=js memaksa walker JS (lihat grep.ts).
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "#minicore"
import {
  GREP_JS_LINE_MAX_CHARS,
  grepTool,
  isReDosPronePattern,
  redosGuardMessage,
  ripgrepAvailable,
} from "../src/tools/grep.ts"

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "minicode-grep-redos-"))
  const ctx = {
    cwd: root,
    signal: new AbortController().signal,
    emit() {},
  } as unknown as ToolContext
  return { root, ctx, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function saveEngine(): string | undefined {
  return process.env.MINICODE_GREP_ENGINE
}

function restoreEngine(prev: string | undefined): void {
  if (prev === undefined) delete process.env.MINICODE_GREP_ENGINE
  else process.env.MINICODE_GREP_ENGINE = prev
}

/** Jalankan execute dengan race timeout supaya hang terdeteksi sebagai gagal. */
async function runBounded(
  promise: Promise<unknown>,
  ms = 2000,
): Promise<
  { kind: "value"; value: unknown } | { kind: "error"; message: string } | { kind: "timeout" }
> {
  return Promise.race([
    promise.then(
      (value) => ({ kind: "value" as const, value }),
      (e) => ({ kind: "error" as const, message: String((e as Error).message) }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), ms),
    ),
  ])
}

describe("L7: pagar ReDoS fallback JS grep", () => {
  test("deteksi statis menangkap bentuk rawan, tak menandai pola normal", () => {
    for (const p of ["(a+)+$", "(a*)*", "(a|aa)+", "(?:a+)+", "(a+)\\1", "(a)\\1+"]) {
      expect(isReDosPronePattern(p), p).toBe(true)
    }
    for (const p of ["foo.*Error", "export function", "[+*]+", "(foo|bar)+", "a+b", "MARKER_EFF"]) {
      expect(isReDosPronePattern(p), p).toBe(false)
    }
    expect(redosGuardMessage("foo.*Error")).toBeNull()
    expect(redosGuardMessage("(a+)+$")).toContain("ReDoS-prone")
  })

  test("(a+)+$ dengan fallback JS ditolak sebelum re.test (tak menggantung)", async () => {
    const { root, ctx, cleanup } = await setup()
    const prev = saveEngine()
    const originalTest = RegExp.prototype.test
    let riskyTestCalls = 0
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      // Baris ini akan menggantung regex katasropik SEBELUM '$' bila re.test
      // benar-benar dijalankan — dipakai untuk membuktikan pagar fail-closed.
      await writeFile(join(root, "bad.txt"), `${"a".repeat(60)}X\n`, "utf8")

      RegExp.prototype.test = function (this: RegExp, s: string): boolean {
        if (this.source === "(a+)+$") riskyTestCalls++
        return originalTest.call(this, s)
      }

      const result = await runBounded(
        grepTool.execute({ pattern: "(a+)+$", cwd: root, limit: 5 }, ctx),
      )
      expect(result.kind).not.toBe("timeout")
      expect(result.kind).toBe("error")
      if (result.kind === "error") expect(result.message).toContain("ReDoS-prone")
      expect(riskyTestCalls).toBe(0)
    } finally {
      RegExp.prototype.test = originalTest
      restoreEngine(prev)
      await cleanup()
    }
  })

  test("(a*)* dan (a|aa)+ juga ditolak lewat jalur execute", async () => {
    const { root, ctx, cleanup } = await setup()
    const prev = saveEngine()
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      await writeFile(join(root, "bad.txt"), `${"a".repeat(60)}X\n`, "utf8")
      for (const pattern of ["(a*)*", "(a|aa)+"]) {
        const result = await runBounded(grepTool.execute({ pattern, cwd: root, limit: 5 }, ctx))
        expect(result.kind).not.toBe("timeout")
        expect(result.kind).toBe("error")
        if (result.kind === "error") expect(result.message).toContain("ReDoS-prone")
      }
    } finally {
      restoreEngine(prev)
      await cleanup()
    }
  })

  test("regex normal (foo.*Error) tetap menghasilkan match di fallback", async () => {
    const { root, ctx, cleanup } = await setup()
    const prev = saveEngine()
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      await writeFile(join(root, "app.log"), "INFO start\nfoo bar Error occurred\n", "utf8")
      const out = (await grepTool.execute(
        { pattern: "foo.*Error", cwd: root, limit: 10 },
        ctx,
      )) as string
      expect(out).toContain("app.log:2:")
      expect(out).toContain("foo bar Error")
    } finally {
      restoreEngine(prev)
      await cleanup()
    }
  })

  test("baris sangat panjang dilewati di fallback (tak menggantung)", async () => {
    const { root, ctx, cleanup } = await setup()
    const prev = saveEngine()
    try {
      process.env.MINICODE_GREP_ENGINE = "js"
      expect(isReDosPronePattern("NEEDLE")).toBe(false)
      const longLine = `${"x".repeat(GREP_JS_LINE_MAX_CHARS + 10)}NEEDLE`
      await writeFile(join(root, "long.txt"), `${longLine}\nshort NEEDLE here\n`, "utf8")
      const result = await runBounded(
        grepTool.execute({ pattern: "NEEDLE", cwd: root, limit: 10 }, ctx),
      )
      expect(result.kind).not.toBe("timeout")
      expect(result.kind).toBe("value")
      if (result.kind === "value") {
        const out = String(result.value)
        expect(out).toContain("long.txt:2:")
        expect(out).not.toContain("long.txt:1:")
      }
    } finally {
      restoreEngine(prev)
      await cleanup()
    }
  })

  // v7.39: skip terlihat, bukan `return` diam-diam yang dilaporkan pass walau
  // nol assertion. Checkout ini tak punya binary rg & tak ada seam memaksanya;
  // pagar dipasang tepat SETELAH cabang ripgrep di grep.ts, jadi jalur rg tak
  // pernah menyentuhnya.
  test.skipIf(!ripgrepAvailable())(
    "dengan ripgrep tersedia pola yang sama tak diblokir pagar",
    async () => {
      const { root, ctx, cleanup } = await setup()
      const prev = saveEngine()
      try {
        delete process.env.MINICODE_GREP_ENGINE // auto -> ripgrep
        await writeFile(join(root, "ok.txt"), "aaaa\n", "utf8")
        const out = (await grepTool.execute(
          { pattern: "(a+)+$", cwd: root, limit: 5 },
          ctx,
        )) as string
        expect(out).not.toContain("ReDoS-prone")
      } finally {
        restoreEngine(prev)
        await cleanup()
      }
    },
  )
})
