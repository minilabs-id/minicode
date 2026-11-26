import { expect, test } from "bun:test"
import {
  allowLocalSubcommand,
  flagsAfterPromptBoundary,
  getArg,
  hasHelpFlag,
  missingValueFlags,
  parseToggleArg,
  positionalSubArg,
  promptFromArgs,
  unknownFlagsBeforePrompt,
} from "../cli/args.ts"

test("getArg returns value after flag", () => {
  expect(getArg(["--cwd", "src", "refactor"], "--cwd")).toBe("src")
  expect(getArg(["refactor", "--cwd", "src"], "--cwd")).toBeUndefined()
  expect(getArg(["refactor", "--cwd"], "--cwd")).toBeUndefined()
  expect(getArg(["refactor"], "--cwd")).toBeUndefined()
})

test("promptFromArgs removes boolean flags", () => {
  expect(promptFromArgs(["--verbose", "refactor", "src"])).toBe("refactor src")
  expect(promptFromArgs(["--allow-all", "--ask", "refactor"])).toBe("refactor")
  expect(promptFromArgs(["refactor", "src", "--verbose"])).toBe("refactor src --verbose")
  expect(promptFromArgs(["refactor", "--allow-all"])).toBe("refactor --allow-all")
  expect(promptFromArgs([])).toBe("")
})

// `--tui`, `--ui`, dan `--plan` dihapus: flag tak dikenal dibiarkan sebagai kata prompt.
// getArg sengaja tetap generik — ia mencari nama apa pun, bukan hanya yang dikenal.
test("flag yang sudah dihapus tidak lagi disaring dari prompt", () => {
  expect(promptFromArgs(["refactor", "--tui"])).toBe("refactor --tui")
  expect(promptFromArgs(["refactor", "--ui", "full"])).toBe("refactor --ui full")
  expect(promptFromArgs(["--plan", "refactor"])).toBe("--plan refactor")
})

test("-v/--version dikenali sebagai flag, bukan prompt", () => {
  expect(promptFromArgs(["--version"])).toBe("")
  expect(promptFromArgs(["-v"])).toBe("")
})

test("promptFromArgs removes value flags + their values", () => {
  expect(promptFromArgs(["--cwd", "src", "refactor", "help"])).toBe("refactor help")
  expect(promptFromArgs(["--model", "gpt-4o-mini", "--timeout", "1000", "build"])).toBe("build")
  expect(promptFromArgs(["refactor", "--max-steps", "5"])).toBe("refactor --max-steps 5")
  expect(promptFromArgs(["--max-steps", "5", "refactor"])).toBe("refactor")
})

test("promptFromArgs keeps prompt words resembling negative numbers", () => {
  expect(promptFromArgs(["-123", "x"])).toBe("-123 x")
})

// ── C12 regressions ──────────────────────────────────────────────────────────

test("--verify is a known boolean flag, not prompt text", () => {
  expect(promptFromArgs(["fix bugs", "--verify"])).toBe("fix bugs --verify")
  expect(promptFromArgs(["--verify", "fix bugs"])).toBe("fix bugs")
})

test("supports --flag=value form in prompt filtering", () => {
  expect(promptFromArgs(["hi", "--model=gpt-4o", "--cwd=src"])).toBe("hi --model=gpt-4o --cwd=src")
  expect(promptFromArgs(["--model=gpt-4o", "--cwd=src", "hi"])).toBe("hi")
})

test("getArg supports --flag=value form", () => {
  expect(getArg(["--model=gpt-4o", "run"], "--model")).toBe("gpt-4o")
  expect(getArg(["--budget=5", "run"], "--budget")).toBe("5")
  expect(getArg(["run", "--model=gpt-4o"], "--model")).toBeUndefined()
  expect(getArg(["run", "--model="], "--model")).toBeUndefined()
})

test("repeated value flags are all filtered from the prompt", () => {
  expect(promptFromArgs(["--cwd", "a", "--cwd", "b", "do it"])).toBe("do it")
  expect(promptFromArgs(["do it", "--cwd", "a"])).toBe("do it --cwd a")
  // last occurrence wins (konsisten dgn getArg baru)
  expect(getArg(["--cwd", "a", "--cwd", "b"], "--cwd")).toBe("b")
  expect(getArg(["do it", "--cwd", "a"], "--cwd")).toBeUndefined()
})

// Regresi: `exec` dulu menyaring prompt dengan `a !== getArg("--model")`, yang
// hanya membuang NILAI dari dua flag. Nilai flag lain ikut terkirim ke model:
// `exec "tes" --provider gorouter --timeout 60000` benar-benar mengirim
// "tes gorouter 60000", dan model membalas menebak-nebak soal "gorouter".
test("nilai SEMUA value flag dibuang dari prompt, bukan hanya --model/--cwd", () => {
  expect(
    promptFromArgs([
      "--provider",
      "gorouter",
      "--session",
      "uji",
      "--timeout",
      "60000",
      "--ratelimit",
      "10",
      "--budget",
      "5",
      "--sandbox",
      "docker",
      "--max-steps",
      "3",
      "--context-window",
      "8000",
      "--resume",
      "abc",
      "ulangi",
      "persis",
    ]),
  ).toBe("ulangi persis")
  expect(promptFromArgs(["ulangi", "persis", "--provider", "gorouter", "--timeout", "60000"])).toBe(
    "ulangi persis --provider gorouter --timeout 60000",
  )
})

test("flag khusus exec (--json, --output-format, --prompt) tidak masuk prompt", () => {
  expect(promptFromArgs(["--json", "tes"])).toBe("tes")
  expect(promptFromArgs(["tes", "--json"])).toBe("tes --json")
  expect(promptFromArgs(["--output-format", "json", "tes"])).toBe("tes")
  expect(promptFromArgs(["tes", "--output-format", "json"])).toBe("tes --output-format json")
  expect(promptFromArgs(["tes", "--output-format=json"])).toBe("tes --output-format=json")
  expect(promptFromArgs(["--prompt", "dari-flag"])).toBe("")
  expect(promptFromArgs(["--output-format=json", "tes"])).toBe("tes")
})

test("bentuk --flag=value juga dibuang untuk semua value flag", () => {
  expect(promptFromArgs(["--provider=gorouter", "--timeout=1000", "kerjakan"])).toBe("kerjakan")
  expect(promptFromArgs(["kerjakan", "--provider=gorouter", "--timeout=1000"])).toBe(
    "kerjakan --provider=gorouter --timeout=1000",
  )
})

// ── [Live Hardening 0.13.x §8.3] flags after prompt boundary ──────────────────

test("flagsAfterPromptBoundary mendeteksi flag dikenal setelah kata prompt pertama", () => {
  // Kasus stage5: prompt paling depan, flag runtime setelahnya → dibuang diam-diam.
  expect(flagsAfterPromptBoundary(["self-repair", "--resume", "minipulse-a4"])).toEqual([
    "--resume",
  ])
  expect(
    flagsAfterPromptBoundary(["self-repair", "--cwd", "src", "--allow-all", "--timeout", "60"]),
  ).toEqual(["--cwd", "--allow-all", "--timeout"])
  expect(flagsAfterPromptBoundary(["self-repair", "--work-mode", "PLAN"])).toEqual(["--work-mode"])
})

test("flagsAfterPromptBoundary kosong bila flag sebelum prompt", () => {
  expect(flagsAfterPromptBoundary(["--resume", "minipulse-a4"])).toEqual([])
  expect(flagsAfterPromptBoundary(["--cwd", "src", "--allow-all", "kerjakan"])).toEqual([])
  expect(flagsAfterPromptBoundary([])).toEqual([])
})

test("flagsAfterPromptBoundary menghargai separator --", () => {
  expect(flagsAfterPromptBoundary(["--work-mode", "PLAN", "--", "--model", "x"])).toEqual([
    "--model",
  ])
})

test("flagsAfterPromptBoundary melewati nilai flag bentuk --flag=value dan dedupe", () => {
  // value flag setelah boundary: nilai berikutnya bukan flag dikenal.
  expect(flagsAfterPromptBoundary(["p", "--model", "gpt-4o"])).toEqual(["--model"])
  // bentuk =value dinormalisasi ke nama flag.
  expect(flagsAfterPromptBoundary(["p", "--model=gpt-4o"])).toEqual(["--model"])
  // flag berulang di-dedupe menjaga urutan.
  expect(
    flagsAfterPromptBoundary(["p", "--model", "x", "--model", "y", "--work-mode", "PLAN"]),
  ).toEqual(["--model", "--work-mode"])
})

test("flag boolean subcommand (--local/--global/--jsonl/--all-tools) tidak memakan argumen berikut", () => {
  expect(promptFromArgs(["--local", "--global", "--jsonl", "--all-tools", "lanjut"])).toBe("lanjut")
  expect(promptFromArgs(["--port", "4040", "--ttl", "60", "jalan"])).toBe("jalan")
})

test("helper subcommand: positionalSubArg, hasHelpFlag, allowLocalSubcommand, parseToggleArg", () => {
  // Router mempartisi positional lebih dulu sebelum memanggil handler subcommand.
  expect(positionalSubArg(["sessions", "export", "id-1", "--cwd", "/tmp"], 0)).toBe("sessions")
  expect(positionalSubArg(["sessions", "export", "id-1", "--cwd", "/tmp"], 1)).toBe("export")
  expect(positionalSubArg(["sessions", "export", "id-1", "--cwd", "/tmp"], 2)).toBe("id-1")
  expect(positionalSubArg(["sessions", "--cwd", "/tmp"], 1)).toBeUndefined()

  expect(hasHelpFlag(["stats", "--help"])).toBe(true)
  expect(hasHelpFlag(["stats", "-h"])).toBe(true)
  expect(hasHelpFlag(["stats", "--json"])).toBe(false)

  expect(allowLocalSubcommand(["providers", "--allow-local-config"])).toBe(true)
  expect(allowLocalSubcommand(["providers"])).toBe(false)

  expect(parseToggleArg("")).toBeUndefined()
  expect(parseToggleArg("on")).toBe(true)
  expect(parseToggleArg("ON")).toBe(true)
  expect(parseToggleArg("1")).toBe(true)
  expect(parseToggleArg("off")).toBe(false)
  expect(parseToggleArg("OFF")).toBe(false)
  expect(parseToggleArg("0")).toBe(false)
  expect(parseToggleArg("bogus")).toBe("invalid")
})

test("missingValueFlags & unknownFlagsBeforePrompt menangkap salah pakai flag sebelum prompt", () => {
  expect(missingValueFlags(["--model"])).toEqual(["--model"])
  expect(missingValueFlags(["--model", "--ask", "tolong"])).toEqual(["--model"])
  expect(missingValueFlags(["--model=gpt-4o", "tolong"])).toEqual([])
  expect(missingValueFlags(["tolong", "--model"])).toEqual([])

  expect(unknownFlagsBeforePrompt(["--bogus", "halo"])).toEqual(["--bogus"])
  expect(unknownFlagsBeforePrompt(["--cwd", "/tmp", "--bogus=1", "halo"])).toEqual(["--bogus"])
  expect(unknownFlagsBeforePrompt(["--", "--bogus", "halo"])).toEqual([])
  expect(unknownFlagsBeforePrompt(["halo", "--bogus"])).toEqual([])
})
