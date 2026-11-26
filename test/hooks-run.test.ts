import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRunHooks, runRunHooks } from "../src/hooks/run.ts"

const dir = join(tmpdir(), `minicode-hooks-test-${process.pid}`)
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {}
})

test("findRunHooks: fail-closed untuk .minicode/hooks lokal tanpa allowLocal", () => {
  const hooks = join(dir, ".minicode", "hooks")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, "pre-run.js"), "// pre")
  writeFileSync(join(hooks, "post-deploy.js"), "// post")
  writeFileSync(join(hooks, "not-prefix-pre.js"), "// should not match prefix")
  writeFileSync(join(hooks, "notes.txt"), "ignore me")

  const blocked = findRunHooks(dir)
  expect(blocked.pre.some((f) => f.includes(dir))).toBe(false)
  expect(blocked.post.some((f) => f.includes(dir))).toBe(false)

  const found = findRunHooks(dir, { allowLocal: true })
  expect(found.pre.some((f) => f.endsWith("pre-run.js"))).toBe(true)
  expect(found.post.some((f) => f.endsWith("post-deploy.js"))).toBe(true)
  expect(found.pre.some((f) => f.endsWith("not-prefix-pre.js"))).toBe(false)
  expect(found.pre.filter((f) => f.includes(dir)).length).toBe(1)
  expect(found.post.filter((f) => f.includes(dir)).length).toBe(1)
})

test("findRunHooks: symlink keluar direktori hook lokal ditolak", () => {
  const base = join(dir, "jail-test")
  const hooks = join(base, ".minicode", "hooks")
  const outside = join(base, "outside-hook.js")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(outside, "// outside")
  let linked = false
  try {
    symlinkSync(outside, join(hooks, "pre-link.js"))
    linked = true
  } catch {}
  if (!linked) return
  const found = findRunHooks(base, { allowLocal: true })
  expect(found.pre.some((f) => f.endsWith("pre-link.js"))).toBe(false)
})

test("runRunHooks: abort signal menghentikan hook yang menggantung segera", async () => {
  const base = join(dir, "abort-test")
  const hooks = join(base, ".minicode", "hooks")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, "pre-hang.js"), "setInterval(() => {}, 1000)\n")
  const prev = process.env.MINICODE_HOOKS
  process.env.MINICODE_HOOKS = "1"
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 100)
  const started = Date.now()
  try {
    await runRunHooks("pre", { phase: "pre", cwd: base }, ac.signal, { allowLocal: true })
    expect(Date.now() - started).toBeLessThan(3_500)
  } finally {
    clearTimeout(timer)
    if (prev === undefined) delete process.env.MINICODE_HOOKS
    else process.env.MINICODE_HOOKS = prev
  }
})

test("findRunHooks: tanpa dir → kosong", () => {
  const found = findRunHooks(join(dir, "nonexistent"), { allowLocal: true })
  expect(found.pre.length).toBe(0)
  expect(found.post.length).toBe(0)
})

test("runRunHooks: onNotice menerima notice hook tanpa menulis ke stderr mentah", async () => {
  const base = join(dir, "notice-test")
  const hooks = join(base, ".minicode", "hooks")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(join(hooks, "pre-ok.js"), "process.exit(0)\n")
  const prev = process.env.MINICODE_HOOKS
  process.env.MINICODE_HOOKS = "1"
  const notices: string[] = []
  try {
    await runRunHooks("pre", { phase: "pre", cwd: base }, undefined, {
      allowLocal: true,
      onNotice: (line) => notices.push(line),
    })
    expect(notices).toEqual(["[hooks] pre: pre-ok.js"])
  } finally {
    if (prev === undefined) delete process.env.MINICODE_HOOKS
    else process.env.MINICODE_HOOKS = prev
  }
})
