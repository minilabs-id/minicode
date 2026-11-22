#!/usr/bin/env bun
// Entry ringan untuk bin npm (`cli/minicode.js` → entry ini). Meta flag dijawab
// SEBELUM memuat aplikasi penuh: `cli/index.ts` mengimpor seluruh sesi/TUI dan
// membakar ~125 ms sebelum `--version` sempat dicetak. Modul ini sengaja hanya
// mengimpor help.ts (satu sumber HELP + readVersion); tidak mengimpor args.ts,
// router.ts maupun aplikasi supaya jalur meta tetap ringan.
//
// Urutan sengaja DIPERTAHANKAN: untuk argv yang mengandung token posisional
// (subcommand/prompt) kami TIDAK memotong jalannya — `await import("./index.ts")`
// membiarkan `dispatch(args, ...)` di index.ts (:292) tetap berjalan SEBELUM
// pemeriksaan `--help` (:299). Dengan begitu `minicode <subcmd> --help` ditangani
// router dengan crash guard dan wiring sesi anak yang sama seperti sebelumnya.

import { buildHelpJson, HELP, readVersion } from "./help.ts"

const args = process.argv.slice(2)
// Meta murni = semua token adalah flag (tidak ada subcommand/prompt/value).
const metaOnly = args.length > 0 && args.every((a) => a?.startsWith("-"))
// Untuk argv meta murni, `hasFlag(args, "--version")` di index.ts ekuivalen
// dengan includes("--version") (bentuk `--version=<x>` bukan flag bernilai),
// jadi tidak perlu mengimpor args.ts hanya untuk satu pemeriksaan ini.
if (metaOnly && (args.includes("--version") || args.includes("-v"))) {
  console.log(readVersion())
  process.exit(0)
}

if (metaOnly && (args.includes("-h") || args.includes("--help"))) {
  // Peringatan usang TETAP dicetak walau help dicetak: sensitivitas terhadap
  // urutan argumen = alasan klasik flag "diam" tak ketahuan (audit F8).
  if (args.includes("--tui")) {
    process.stderr.write(
      "[deprecated] --tui is a no-op: interactive mode is always the fullscreen TUI\n",
    )
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(buildHelpJson()))
    process.exit(0)
  }
  console.log(HELP)
  process.exit(0)
}

await import("./index.ts")
