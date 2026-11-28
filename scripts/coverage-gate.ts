#!/usr/bin/env bun
// Coverage gate agregat.
//
// Kenapa tidak `bunfig.toml` `coverageThreshold`? Bun mengevaluasi threshold
// itu PER FILE, bukan agregat — dengan 0.01 pun run tetap gagal karena ada file
// 0% (mis. src/sandbox/os.ts yang hanya jalan di Linux/macOS). Gate agregat
// harus dihitung dari baris "All files" pada tabel coverage.
//
// Sebelumnya CI memberi label "Test with coverage (threshold 80)" padahal
// `bun test --coverage` tanpa konfigurasi apa pun selalu lulus — gate-nya fiksi.
// Script ini menjadikannya nyata.
//
// Usage: bun scripts/coverage-gate.ts [--lines N] [--funcs N]

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { evaluateGate, gateExitCode } from "./coverage-decision.ts"

function getArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) ? v : fallback
}

// Ambang agregat (funcs/lines) — baseline historis v0.10–P13 tidak lagi ditulis
// panjang lebar; jaga ambang tetap jujur tanpa diturunkan saat ada perubahan.
const MIN_LINES = getArg("--lines", 86)
const MIN_FUNCS = getArg("--funcs", 87)

// Lantai per-berkas modul kritis mencegah rata-rata agregat menyembunyikan
// penurunan drastis pada satu modul keamanan/inti. Berkas yang dipindah/hilang
// menggagalkan gate secara eksplisit.
const CRITICAL_FILES: [string, number, number][] = [
  // [path, min funcs, min lines]
  ["src/policy/permission.ts", 90, 90],
  ["src/policy/jail.ts", 92, 92],
  ["src/policy/bash-guard.ts", 92, 92],
  ["src/policy/executor.ts", 92, 92],
  ["src/policy/scrub.ts", 95, 95],
  ["src/lib/net.ts", 90, 90],
  ["src/lib/trusted-exec.ts", 90, 90],
  ["src/lib/safe-open.ts", 58, 90],
  ["src/session/journal.ts", 85, 90],
  ["src/session/checkpoint.ts", 80, 85],
  ["src/providers/router.ts", 78, 90],
  ["src/ui/render/sanitize.ts", 90, 90],
  ["src/ui/render/width.ts", 90, 90],
  ["src/ui/tui/app.ts", 85, 90],
  ["src/tools/bash.ts", 72, 78],
  // Fase 3 Presentasi V2.1 — lantai 90 untuk modul kritis baru (plan §26 P3).
  ["src/presentation/model.ts", 90, 90],
  ["src/presentation/reducer.ts", 90, 90],
  ["src/presentation/label.ts", 90, 90],
  // Fase 4 Content Store (plan §26 P4) — lantai 90.
  ["src/presentation/store.ts", 90, 90],
]

// Uraian baris per-berkas tinggal di ./coverage-decision.ts (fileCoverage),
// dipakai bersama test gate-nya. Status test dan liputan dievaluasi
// independen: kegagalan test TERCATAT tetapi tak lagi menghentikan evaluasi
// liputan — keduanya dilaporkan dan keduanya menggagalkan gate.

// Opsi `--report <file>`: evaluasi ulang laporan yang SUDAH ada tanpa
// menjalankan suite (4 menit). Dipakai saat CI merah untuk tahu modul mana yang
// jatuh, dan untuk menguji gate ini sendiri tanpa membayar satu run penuh.
const reportIdx = process.argv.indexOf("--report")
const savedReport = reportIdx !== -1 ? process.argv[reportIdx + 1] : undefined

let output: string
let runFailure: string | null = null
if (savedReport) {
  output = readFileSync(savedReport, "utf8")
} else {
  const res = spawnSync(
    process.execPath,
    ["test", "--coverage", "--reporter", "dots", "--timeout", "30000"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    },
  )
  output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
  if (res.status !== 0 && !/\d+ pass/.test(output)) {
    process.stderr.write(output.slice(-4000))
    runFailure = "[coverage-gate] test run failed"
  } else if (res.status !== 0 && !/^\s*[1-9]\d*\s+(?:fail|errors?)\s*$/m.test(output)) {
    process.stderr.write(output.slice(-4000))
    runFailure = `[coverage-gate] test run exited with status ${res.status}`
  }
}

const ev = evaluateGate(
  output,
  { minFuncs: MIN_FUNCS, minLines: MIN_LINES },
  CRITICAL_FILES,
  runFailure,
)
if (ev.runFailure) console.error(ev.runFailure)
if (ev.failCount > 0) {
  console.error(`[coverage-gate] ${ev.failCount} test failing`)
  // Cetak nama test yang gagal — tanpa ini, reporter dots menelan nama dan
  // kegagalan spesifik-coverage jadi mustahil didiagnosis dari log CI.
  for (const name of ev.failNames) {
    console.error(`  ${name}`)
  }
}

// "All files                     |   71.95 |   76.76 |"
if (ev.parseError) {
  console.error(ev.parseError)
} else if (ev.aggregate) {
  console.log(
    `[coverage-gate] funcs ${ev.aggregate.funcs.toFixed(2)}% (min ${MIN_FUNCS}) · lines ${ev.aggregate.lines.toFixed(2)}% (min ${MIN_LINES})`,
  )
}

// Lantai per-berkas modul kritis — dijalankan SEBELUM keputusan agregat agar
// modul yang jatuh sendiri selalu terlihat, walau total masih di atas ambang.
for (const msg of ev.criticalFailures) {
  console.error(msg)
}
console.log(
  `[coverage-gate] lantai per-berkas: ${CRITICAL_FILES.length - ev.criticalFailures.length}/${CRITICAL_FILES.length} modul kritis hijau`,
)
for (const msg of ev.aggregateFailures) {
  console.error(msg)
}
process.exit(gateExitCode(ev))
