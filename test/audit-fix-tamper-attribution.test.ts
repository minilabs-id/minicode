// Audit fix (v7.35) — atribusi EVALUATOR_TAMPER_ATTEMPT sadar-sesi.
//
// Bug yang diperbaiki: `collectSessionModifiedFiles` menggabungkan (a) file dari
// jurnal sesi+child dengan (b) fallback git-status yang membandingkan hash path
// kotor terhadap baseline awal sesi. Bila proses/SESI LAIN mengubah file saat
// sesi ini berjalan, hash berubah dan file disalahatribusikan ke sesi baca →
// `EVALUATOR_TAMPER_ATTEMPT` salah bunyi. Sekarang fallback git-status hanya
// aktif bila sesi/child benar-benar menjalankan tool mutating; deteksi tamper
// tetap fail-closed untuk sesi yang memang memutasi workspace.
//
// Hermetik: git repo lokal di direktori temp, jurnal in-memory/file, tanpa jaringan.

import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTrustedExecutable } from "../src/lib/trusted-exec.ts"
import {
  appendMutationIntent,
  appendMutationTerminal,
  type JournalRecord,
} from "../src/session/journal.ts"
import {
  captureSessionEvaluationBaseline,
  collectSessionModifiedFiles,
} from "../src/session/verification.ts"

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-tamper-attr-"))
  mkdirSync(join(dir, ".minicode"), { recursive: true })
  dirs.push(dir)
  return dir
}

/**
 * Buat repo dengan `test/eval.ts` yang KOTOR sejak awal sesi (baseline merekam
 * hash V1), lalu disimulasikan diubah proses lain menjadi V2. Tanpa perbaikan,
 * V2 berbeda dari baseline → fallback git-status menambahkan path ini.
 */
function dirtyEvalRepo(): { dir: string; rel: string; file: string } {
  const dir = tmpRoot()
  const rel = "test/eval.ts"
  const file = join(dir, rel)
  mkdirSync(join(dir, "test"), { recursive: true })
  writeFileSync(file, "export const v = 0\n", "utf8")
  const git = resolveTrustedExecutable("git")
  spawnSync(git, ["init"], { cwd: dir, stdio: "ignore" })
  spawnSync(git, ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" })
  spawnSync(git, ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" })
  spawnSync(git, ["add", "."], { cwd: dir, stdio: "ignore" })
  spawnSync(git, ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" })
  // Kotor sebelum sesi dimulai → masuk baseline.
  writeFileSync(file, "export const v = 1\n", "utf8")
  return { dir, rel, file }
}

function rec(
  session: string,
  seq: number,
  tool: string,
  cwd: string,
  opts: {
    state?: JournalRecord["state"]
    paths?: string[]
    childSessionId?: string
  } = {},
): JournalRecord {
  return {
    v: 1,
    id: `${session}:${seq}`,
    session,
    seq,
    tool,
    cwd,
    ts: Date.now(),
    state: opts.state ?? "committed",
    ...(opts.paths ? { paths: opts.paths } : {}),
    ...(opts.childSessionId ? { childSessionId: opts.childSessionId } : {}),
  }
}

test("sesi baca-only: path kotor yang hash-nya berubah TIDAK diatribusikan lewat fallback git", async () => {
  const sid = "ro-session"
  const { dir, rel, file } = dirtyEvalRepo()
  await captureSessionEvaluationBaseline(sid, dir)
  // Proses/sesi lain mengubah file; sesi ini sendiri hanya baca.
  writeFileSync(file, "export const v = 2\n", "utf8")

  const parent = [rec(sid, 0, "read_file", dir, { paths: [rel] }), rec(sid, 1, "grep", dir)]
  const modified = await collectSessionModifiedFiles(sid, dir, parent)

  expect(modified).not.toContain(rel)
})

test("sesi dengan bash: path kotor yang sama TETAP diatribusikan (fail-closed)", async () => {
  const sid = "bash-session"
  const { dir, rel, file } = dirtyEvalRepo()
  await captureSessionEvaluationBaseline(sid, dir)
  writeFileSync(file, "export const v = 2\n", "utf8")

  const parent = [rec(sid, 0, "bash", dir, { paths: ["out.txt"] })]
  const modified = await collectSessionModifiedFiles(sid, dir, parent)

  expect(modified).toContain(rel)
})

test("sesi dengan write_file: path kotor yang sama TETAP diatribusikan (fail-closed)", async () => {
  const sid = "write-session"
  const { dir, rel, file } = dirtyEvalRepo()
  await captureSessionEvaluationBaseline(sid, dir)
  writeFileSync(file, "export const v = 2\n", "utf8")

  // write_file menyasar path lain supaya kehadiran `rel` benar-benar berasal
  // dari fallback git-status, bukan dari koleksi jurnal.
  const parent = [rec(sid, 0, "write_file", dir, { paths: ["src/notes.ts"] })]
  const modified = await collectSessionModifiedFiles(sid, dir, parent)

  expect(modified).toContain("src/notes.ts")
  expect(modified).toContain(rel)
})

test("child pakai tool mutating: path kotor diatribusikan ke sesi induk", async () => {
  const sid = "parent-session"
  const child = "mutating-child"
  const { dir, rel, file } = dirtyEvalRepo()
  await captureSessionEvaluationBaseline(sid, dir)
  writeFileSync(file, "export const v = 2\n", "utf8")

  const parent = [rec(sid, 0, "delegate_task", dir, { childSessionId: child })]
  const intent = await appendMutationIntent({
    session: child,
    cwd: dir,
    tool: "write_file",
    paths: ["src/child.ts"],
  })
  await appendMutationTerminal(child, dir, intent.id, intent.seq, "write_file", "committed")

  const modified = await collectSessionModifiedFiles(sid, dir, parent)

  expect(modified).toContain("src/child.ts")
  expect(modified).toContain(rel)
})

test("koleksi berbasis jurnal tetap aktif terlepas dari fallback git-status", async () => {
  const sid = "journal-session"
  const dir = tmpRoot()
  // Tidak ada git repo sama sekali → fallback git-status tak punya apa-apa.
  const journalPath = "src/journal-only.ts"
  const parent = [rec(sid, 0, "write_file", dir, { paths: [journalPath] })]

  const modified = await collectSessionModifiedFiles(sid, dir, parent)

  expect(modified).toContain(journalPath)
})
