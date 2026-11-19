// Regresi audit: flag boolean dengan bentuk `--name=value` tidak boleh
// dianggap hadir. `--allow-all=false` dulu menyalakan mode privileged karena
// hasFlag mencocokkan prefix `--allow-all=`.
import { expect, test } from "bun:test"
import { allowLocalConfig, allowLocalSubcommand, hasFlag } from "../cli/args.ts"

test("hasFlag: boolean flag dengan =value = TIDAK hadir", () => {
  expect(hasFlag(["--allow-all=false"], "--allow-all")).toBe(false)
  expect(hasFlag(["--budget-strict=false"], "--budget-strict")).toBe(false)
  expect(hasFlag(["--ask=false"], "--ask")).toBe(false)
  expect(hasFlag(["--verify=0"], "--verify")).toBe(false)
  // Kontrol: bentuk kanonik tetap terdeteksi.
  expect(hasFlag(["--allow-all"], "--allow-all")).toBe(true)
  expect(hasFlag(["--budget-strict"], "--budget-strict")).toBe(true)
  expect(hasFlag(["--verbose", "--allow-all", "fix"], "--allow-all")).toBe(true)
  // Value flag SAH memakai `=` — jangan ikut terkenal.
  expect(hasFlag(["--model=gpt-4o"], "--model")).toBe(true)
  expect(hasFlag(["--budget=1.5"], "--budget")).toBe(true)
})

test("hasFlag: prompt boundary tetap dihormati", () => {
  expect(hasFlag(["fix bug", "--allow-all"], "--allow-all")).toBe(false)
})

test("allowLocalSubcommand menolak =false tetapi menerima flag setelah nama subcommand", () => {
  const prev = process.env.MINICODE_ALLOW_LOCAL_CONFIG
  delete process.env.MINICODE_ALLOW_LOCAL_CONFIG
  try {
    expect(allowLocalSubcommand(["providers", "--allow-local-config"])).toBe(true)
    expect(allowLocalSubcommand(["config", "set", "--allow-local-config"])).toBe(true)
    expect(allowLocalSubcommand(["--allow-local-config"])).toBe(true)
    expect(allowLocalSubcommand(["providers", "--allow-local-config=false"])).toBe(false)
    expect(allowLocalSubcommand(["--allow-local-config=false"])).toBe(false)
    expect(allowLocalSubcommand(["providers"])).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.MINICODE_ALLOW_LOCAL_CONFIG
    else process.env.MINICODE_ALLOW_LOCAL_CONFIG = prev
  }
})

test("allowLocalConfig dan allowLocalSubcommand konsisten untuk =false", () => {
  const prev = process.env.MINICODE_ALLOW_LOCAL_CONFIG
  delete process.env.MINICODE_ALLOW_LOCAL_CONFIG
  try {
    expect(allowLocalConfig(["--allow-local-config=false"])).toBe(false)
    expect(allowLocalSubcommand(["providers", "--allow-local-config=false"])).toBe(false)
    expect(allowLocalConfig(["--allow-local-config"])).toBe(true)
    expect(allowLocalSubcommand(["providers", "--allow-local-config"])).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.MINICODE_ALLOW_LOCAL_CONFIG
    else process.env.MINICODE_ALLOW_LOCAL_CONFIG = prev
  }
})
