// Telemetry gate — cek resolve-rate dari traces.jsonl.
// Target: resolved/total >= 0.3 (dari bench baseline).
//
// Data WAJIB ada dan cukup (minimal 3 run): gate GAGAL bila traces.jsonl hilang
// atau sparse. Flag `--allow-missing` mengembalikan perilaku legacy (skip diam-
// diam) hanya untuk integrasi lama yang memang tak pernah menulis trace.
// `--require-min-runs` / `--self-test` tetap diterima sebagai alias, supaya
// pemanggil lama tidak error — strict kini sudah menjadi default.
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const argv = process.argv.slice(2)
const allowMissing = argv.includes("--allow-missing")
const cwd = argv.find((a) => !a.startsWith("--")) ?? "."
const file = resolve(cwd, ".minicode", "traces.jsonl")

function fail(message: string): never {
  console.error(`[gate] ERROR: ${message}`)
  process.exit(1)
}

if (!existsSync(file)) {
  if (allowMissing) {
    console.log("[gate] no traces.jsonl — skipping telemetry gate (--allow-missing)")
    process.exit(0)
  }
  fail("traces.jsonl missing (butuh minimal 3 run; pakai --allow-missing untuk legacy skip)")
}

const rawTraces = readFileSync(file, "utf8")
  .replace(/^\uFEFF/, "") // Strip UTF-8 BOM if present (prevent parse crash)
  .split("\n")
  .filter(Boolean)

let traces: { ok?: boolean }[]
try {
  traces = rawTraces.map((l) => JSON.parse(l))
} catch (e) {
  console.error(`[gate] ERROR: Invalid JSON in traces.jsonl`, (e as Error).message)
  process.exit(1)
}

const ok = traces.filter((t) => t.ok).length
const rate = traces.length ? ok / traces.length : 0
const TARGET = 0.3

console.log(
  `[gate] runs=${traces.length} resolved=${ok}/${traces.length} rate=${rate.toFixed(2)} (target ${TARGET})`,
)
if (traces.length < 3) {
  if (allowMissing) {
    console.log("[gate] too few runs — passing (insufficient data, --allow-missing)")
    process.exit(0)
  }
  fail(`insufficient runs (${traces.length} < 3)`)
}
if (rate < TARGET) {
  console.warn(`[gate] WARN: resolve rate ${rate.toFixed(2)} < ${TARGET}`)
  process.exit(1)
}
process.exit(0)
