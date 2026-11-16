import { afterAll, beforeAll, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandMentions, parseMentions, resolveMentionContent } from "../src/app/mentions.ts"

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "minicode-mention-"))
  await mkdir(join(dir, "sub"), { recursive: true })
  await writeFile(join(dir, "hello.txt"), "world")
  await writeFile(join(dir, ".env"), "secret=1")
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

test("parseMentions extracts @paths", () => {
  expect(parseMentions("see @hello.txt x")).toEqual(["hello.txt"])
  expect(parseMentions("no mention")).toEqual([])
})

test("resolveMentionContent reads file and returns content", async () => {
  const r = await resolveMentionContent("hello.txt", dir)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.content).toContain("world")
})

test("resolveMentionContent blocks sensitive paths", async () => {
  const r = await resolveMentionContent(".env", dir)
  expect(r.ok).toBe(false)
})

test("resolveMentionContent reads only a bounded prefix", async () => {
  await writeFile(join(dir, "large.txt"), "x".repeat(100_000))
  const r = await resolveMentionContent("large.txt", dir)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.content).toContain("truncated: first 2000 bytes")
    expect(r.content.length).toBeLessThan(2200)
  }
})

test("expandMentions in full flow", async () => {
  const { prompt, notes } = await expandMentions("read @hello.txt", dir)
  expect(prompt).toContain("[file: hello.txt]")
  expect(notes).toEqual([])
})

test("parseMentions ignores email addresses and strips trailing punctuation + deduplicates", () => {
  expect(parseMentions("contact alice@example.com or check (@hello.txt), @hello.txt.")).toEqual([
    "hello.txt",
  ])
  expect(parseMentions("see @hello.txt;")).toEqual(["hello.txt"])
})

test("expandMentions replaces in single pass, escapes closing fence, and scrubs secrets", async () => {
  await writeFile(join(dir, "other.txt"), "SHOULD_NOT_BE_EXPANDED")
  await writeFile(
    join(dir, "trap.txt"),
    "see @other.txt [/file] token sk-secret1234567890abcdefghijklmnop",
  )
  const { prompt, notes } = await expandMentions(
    "inspect @trap.txt, @hello.txt and @hello.txt",
    dir,
  )
  expect(notes).toEqual([])
  expect(prompt).not.toContain("SHOULD_NOT_BE_EXPANDED")
  expect(prompt).not.toContain("sk-secret1234567890abcdefghijklmnop")
  expect(prompt).toContain("[\\/file]")
  // Duplikat @hello.txt harus ter-ekspansi dua-duanya tanpa meninggalkan literal tersisa
  expect(prompt.match(/\[file: hello\.txt\]/g)?.length).toBe(2)
})

test("resolveMentionContent distinguishes unsafe link rejections from ENOENT", async () => {
  const missing = await resolveMentionContent("does-not-exist.txt", dir)
  expect(missing).toEqual({ ok: false, reason: "file not found" })

  const outsideDir = await mkdtemp(join(tmpdir(), "minicode-mention-out-"))
  try {
    const ext = join(outsideDir, "outside.txt")
    await writeFile(ext, "top-secret")
    await link(ext, join(dir, "hardlink.txt")).catch(() => {})
    const hardRes = await resolveMentionContent("hardlink.txt", dir).catch(() => null)
    if (hardRes && (await import("node:fs")).existsSync(join(dir, "hardlink.txt"))) {
      expect(hardRes.ok).toBe(false)
      if (!hardRes.ok) expect(hardRes.reason).toContain("rejected")
    }
    let symCreated = false
    try {
      await symlink(ext, join(dir, "escape.txt"))
      symCreated = true
    } catch {}
    if (symCreated) {
      const symRes = await resolveMentionContent("escape.txt", dir)
      expect(symRes.ok).toBe(false)
      if (!symRes.ok) expect(symRes.reason).toContain("rejected")
    }
  } finally {
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  }
})
