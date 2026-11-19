// AUDIT-FIX — narasi progres ala OpenCode/Codex di system prompt.
// Pastikan blok Communication aktif, berisi direktif kunci, dan diletakkan di
// area inti (SEBELUM blok DATA) agar selamat dari pemotongan budget 8000.
// Hermetic: tmp cwd, tanpa network/API key.
//
// v7.40: direktif prompt dipause lewat REGEX SEMANTIK, bukan string persis —
// copy prompt mudah dirapikan; yang dijaga adalah maknanya, bukan ejaannya.
// Assert budget/urutan (perilaku) tetap dipertahankan apa adanya.

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt } from "../src/policy/context.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mc-comm-"))
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Potong isi satu bagian heading (`# ...`) sampai heading berikutnya. */
function sectionOf(sys: string, heading: string): string {
  const start = sys.indexOf(heading)
  if (start < 0) return ""
  const rest = sys.slice(start + heading.length)
  const next = rest.indexOf("\n# ")
  return next < 0 ? rest : rest.slice(0, next)
}

test("komunikasi: blok Communication memuat direktif narasi utama", async () => {
  const dir = tmpRoot()
  try {
    const sys = await buildSystemPrompt({ cwd: dir })
    expect(sys).toContain("# Communication")
    const comm = sectionOf(sys, "# Communication")

    // Narasi singkat berkelanjutan — pengguna tidak boleh menebak.
    expect(comm).toMatch(/Narrate your work/i)
    expect(comm).toMatch(/should not have to guess/i)
    // Konfirmasi singkat sebelum task non-trivial (bukan dokumen rencana).
    expect(comm).toMatch(/restate the goal and approach/i)
    expect(comm).toMatch(/not a plan/i)
    // Pengumuman sebelum tool call non-rutin, tanpa mengumumkan tiap read.
    expect(comm).toMatch(/non-routine tool calls/i)
    expect(comm).toMatch(/don't announce every read/i)
    // Ringkasan delegasi + penandaan ketidaksesuaian antar agen / dg repo.
    expect(comm).toMatch(/name the sub-agents and why/i)
    expect(comm).toMatch(/summarize their findings/i)
    expect(comm).toMatch(/explicitly flag any disagreement/i)
    // Caveat penutup ("done, but ...").
    expect(comm).toMatch(/caveats or follow-ups/i)
    expect(comm).toMatch(/done, but \.\.\./i)
    // Tidak minta izin untuk langkah biasa.
    expect(comm).toMatch(/blocked on a real decision/i)
    // Narasi mengikuti aturan bahasa yang sama dengan balasan.
    expect(comm).toMatch(/Narrate in the user's language/i)
  } finally {
    await cleanup(dir)
  }
})

test("komunikasi: blok Communication duduk sebelum blok DATA dan tahan truncate 8000", async () => {
  const dir = tmpRoot()
  try {
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    writeFileSync(join(dir, ".minicode", "MEMORY.md"), "MEM-MARKER-KOMUNIKASI\n")
    const sys = await buildSystemPrompt({ cwd: dir })
    const comm = sys.indexOf("# Communication")
    const howto = sys.indexOf("# How to work")
    const mem = sys.indexOf("# MEMORY")
    const env = sys.indexOf("# Environment")
    expect(comm).toBeGreaterThan(-1)
    expect(howto).toBeGreaterThan(-1)
    expect(mem).toBeGreaterThan(-1)
    // Communication tepat setelah area inti How to work, sebelum Environment/DATA.
    expect(comm).toBeGreaterThan(howto)
    expect(comm).toBeLessThan(env)
    expect(comm).toBeLessThan(mem)

    // Saat budget penuh, cutMarked memotong EKOR — blok inti harus selamat.
    const capped = await buildSystemPrompt({ cwd: dir, extra: "x".repeat(50_000) })
    expect(capped.length).toBeLessThanOrEqual(8000)
    expect(capped).toMatch(/# Communication/)
    expect(capped).toMatch(/Narrate your work/i)
    expect(capped).toMatch(/explicitly flag any disagreement/i)
    expect(capped).toMatch(/done, but \.\.\./i)
  } finally {
    await cleanup(dir)
  }
})

test("komunikasi: baris delegasi di How to work mendorong sub-agent awal & paralel", async () => {
  const dir = tmpRoot()
  try {
    const sys = await buildSystemPrompt({ cwd: dir })
    const howto = sectionOf(sys, "# How to work")
    expect(howto).toMatch(/sub-agents EARLY/i)
    expect(howto).toMatch(/≤5 findings each/i)
    expect(howto).toMatch(/instead of doing everything serially/i)
    // fail-safe: aturan wewenang/work-mode tetap disebut, tak dihapus.
    expect(howto).toMatch(/authorization and work-mode rules/i)
  } finally {
    await cleanup(dir)
  }
})
