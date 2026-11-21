// v0.33 (audit HIGH): allowlist tokenizer harus sadar platform.
// Matriks: `'`, `"`, `\"`, `^`, newline — sesuai GNU Bash manual & cmd.exe docs.
import { expect, test } from "bun:test"
import { isDangerousShellVerb, splitShellSegments } from "../src/policy/shell-tokenize.ts"

test("POSIX: backslash escape mencegah quote palsu", () => {
  // audit finding: `echo hi \" ; rm -f x \"` dulu jadi SATU segmen.
  const parts = splitShellSegments('echo hi \\" ; rm -f x \\"', "posix")
  expect(parts).toContain('echo hi \\"')
  expect(parts[1]).toMatch(/^rm -f x/)
})

test("POSIX: single quote melindungi operator", () => {
  expect(splitShellSegments("grep 'a|b' file", "posix")).toEqual(["grep 'a|b' file"])
  expect(splitShellSegments("echo 'a && b'", "posix")).toEqual(["echo 'a && b'"])
})

test("WIN32: single quote BUKAN quote — & tetap pemisah", () => {
  // exploit asli audit: dulu lolos sebagai satu segmen `echo *`.
  const parts = splitShellSegments("echo hi ' & del penting.txt '", "win32")
  expect(parts.some((p) => /^del\b/i.test(p))).toBe(true)
  expect(parts.length).toBeGreaterThan(1)
})

test("WIN32: caret escape melindungi operator", () => {
  expect(splitShellSegments("echo a ^& b", "win32")).toEqual(["echo a ^& b"])
})

test("keduanya: operator majemuk dipecah", () => {
  for (const p of ["posix", "win32"] as const) {
    expect(splitShellSegments("git status && grep x f | head", p)).toEqual([
      "git status",
      "grep x f",
      "head",
    ])
  }
})

test("deny verba mutasi sebagai defense-in-depth", () => {
  for (const v of ["del a.txt", "rm -f a.txt", "mv a b", "cp a b", "Remove-Item a"]) {
    expect(isDangerousShellVerb(v)).toBe(true)
  }
  expect(isDangerousShellVerb("git status")).toBe(false)
  expect(isDangerousShellVerb("echo hi")).toBe(false)
})
