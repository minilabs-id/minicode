import { spawn } from "node:child_process"
import { lstatSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Tool } from "#minicore"
import { LIMITS } from "../constants.ts"
import {
  discoverFilterDrivers,
  GIT_NO_DIFF_DRIVERS,
  GIT_SAFE_BASE,
  gitFilterNeutralizers,
} from "../lib/git-hardening.ts"
import { resolveTrustedExecutable } from "../lib/trusted-exec.ts"
import {
  isCwdOutsideRoot,
  isOwnedState,
  isOwnedStateReal,
  isPathOutsideRoot,
  isRealPathOutsideRoot,
  isSensitive,
  isSensitiveReal,
} from "../policy/jail.ts"
import { sanitizeSpawnEnv, scrubSecrets } from "../policy/scrub.ts"
import { contextUnrestricted, requireToolCwd } from "./context.ts"

// Seam untuk menguji lifecycle abort tanpa bergantung pada biner git/kill OS
// (pola yang sama dengan setDockerSpawnForTest di sandbox/docker.ts).
let gitSpawnForTest: typeof spawn | null = null
export function setGitSpawnForTest(spawner: typeof spawn | null): void {
  gitSpawnForTest = spawner
}

export function runGit(
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
  envPatch?: Record<string, string>,
  relaxed = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // M2: satu sinyal gabungan (induk + timeout) dipakai spawn DAN close handler.
    // AbortSignal.any meneruskan reason dari sinyal yang lebih dulu gugur, jadi
    // timeout maupun pembatalan user sama-sama terdeteksi di bawah.
    const effective = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.GIT_TIMEOUT_MS)])
    // Audit #10 P0: SEMUA pemanggilan git lewat sini membawa netralisasi
    // repo-controlled execution (hooks/fsmonitor/pager via GIT_SAFE_BASE).
    // Executable di-resolve absolut dari PATH terpercaya karena Windows
    // mencari CWD lebih dulu: `git.bat` di repo akan dieksekusi tanpa ini.
    const p = (gitSpawnForTest ?? spawn)(
      resolveTrustedExecutable("git"),
      [...GIT_SAFE_BASE, ...args],
      {
        cwd,
        // Repo hooks (pre-commit/commit-msg/...) berjalan sebagai child dengan
        // Secara default kredensial (API_KEY/TOKEN/...) di-strip agar hook nakal tak
        // bisa memanen secret dari env. Auth tetap via credential helper / agen
        // SSH (SSH_AUTH_SOCK bukan pola secret) — lihat policy/scrub.ts.
        // Unrestricted: kredensial git SEMPIT (GH_TOKEN/GITHUB_TOKEN/SSH_AUTH_SOCK)
        // dilewatkan untuk `git push`/remote.
        env: sanitizeSpawnEnv(process.env, envPatch, relaxed),
        // Timeout dari LIMITS, bukan hardcode: `git_commit` menjalankan beberapa
        // operasi berurutan (rev-parse → add → commit → log), dan di mesin yang
        // sibuk (mis. CI menjalankan test dengan coverage) spawn git bisa jauh
        // lebih lambat dari batas 8s yang dulu dipakai — kegagalannya muncul
        // sebagai flake, bukan bug nyata.
        // M2: simpan handle combined signal. Dulu inline di sini, sehingga close
        // handler hanya bisa memeriksa `signal` induk — timeout mengakhiri child
        // dengan code null lalu di-resolve sebagai `exit null` (palsu-sukses).
        signal: effective,
        // Tutup stdin agar subproses git tidak pernah menggantung menunggu prompt/EOF.
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    // F-15: cap SAAT streaming (bukan slice di akhir): `git diff`/`git log`
    // di repo raksasa bisa ratusan MB — buffer tak terbatas = OOM sebelum
    // truncate kernel sempat jalan. Satu-satunya tool tanpa cap sebelumnya.
    // Audit deep: anggaran dipakai BERSAMA stdout+stderr (sama seperti
    // bash.ts CappedBuffer). Dulu tiap stream punya cap penuh sehingga
    // gabungannya bisa ~2× GIT_OUTPUT_MAX_CHARS — klaim cap jadi bohong.
    const cap = LIMITS.GIT_OUTPUT_MAX_CHARS
    let out = "",
      err = "",
      truncated = false
    const push = (target: "out" | "err", d: Buffer): void => {
      const used = out.length + err.length
      if (used >= cap) {
        truncated = true
        return
      }
      const room = cap - used
      const s = d.toString()
      if (s.length > room) truncated = true
      const piece = s.slice(0, Math.max(0, room))
      if (target === "out") out += piece
      else err += piece
    }
    const onAbort = () => p.kill("SIGTERM")
    p.stdout.on("data", (d) => push("out", d))
    p.stderr.on("data", (d) => push("err", d))
    p.on("error", (e) => {
      effective.removeEventListener("abort", onAbort)
      reject(e)
    })
    p.on("close", (code) => {
      effective.removeEventListener("abort", onAbort)
      // Abort/timeout keduanya menutup child dengan code null. Sebelumnya
      // keduanya di-resolve sebagai `exit null\n…` seolah hasil normal, sehingga
      // pemanggil tak pernah tahu pembatalan terjadi. Periksa sinyal GABUNGAN:
      // bila induk dibatalkan ATAU timeout tercapai, lempar reason-nya supaya
      // kernel menandai isError/abort (bukan "exit null"). M2: dulu yang dicek
      // hanya `signal` induk → timeout tak terdeteksi dan dianggap sukses.
      if (effective.aborted) {
        reject(effective.reason)
        return
      }
      const text = scrubSecrets((out + (err ? `\n${err}` : "")).trim())
      const marked = truncated ? `${text}\n… [git output truncated]` : text
      // Audit: dulu `code !== 0 && !marked` — bila git gagal TAPI sempat
      // menulis stdout/stderr, hasilnya di-resolve sebagai SUKSES. Sekarang
      // mirror bash tool: exit code bukan nol selalu ditandai `exit N\n` di
      // awal hasil (sinyal isError/kegagalan untuk model + jurnal), dengan
      // output tetap dibawa. Teks "nothing to commit" di gitCommitTool tetap
      // terdeteksi karena pencocokannya substring, bukan prefix.
      if (code !== 0) resolve(`exit ${code}\n${marked}`)
      else resolve(marked || "(exit 0)")
    })
    if (effective.aborted) onAbort()
    else effective.addEventListener("abort", onAbort, { once: true })
  })
}

const gitCommitLocks = new Map<string, Promise<void>>()

async function withGitCommitLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(cwd)
  const previous = gitCommitLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => (release = resolvePromise))
  const queued = previous.then(() => current)
  gitCommitLocks.set(key, queued)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (gitCommitLocks.get(key) === queued) gitCommitLocks.delete(key)
  }
}

/** cwd tool harus di dalam workspace — sama seperti bash/glob/grep. */
function assertCwd(cwd: string | undefined, sessionRoot: string, relaxed = false): void {
  if (!cwd || relaxed) return
  const abs = resolve(sessionRoot, cwd)
  if (isCwdOutsideRoot(abs, sessionRoot) || isPathOutsideRoot(abs, sessionRoot)) {
    throw new Error(`cwd outside workspace: ${cwd}`)
  }
}

async function isGitRepo(cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd, signal)
    return out.trim() === "true"
  } catch {
    return false
  }
}

export const gitStatusTool: Tool = {
  name: "git_status",
  // v7.33 (wire contract): tag family. "hardened" dipertahankan karena test
  // repo-git-trust memverifikasi klaim ini, demikian pula preferensi git tool.
  description:
    "GIT READ: git status --porcelain + diff --stat + log --oneline -10 (hardened: ignores repository hooks, filters and diff drivers — prefer over raw `git` in bash)",
  parameters: {
    type: "object",
    properties: { cwd: { type: "string" } },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd }, ctx) {
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(c, sessionRoot, contextUnrestricted(ctx))
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Audit #10 P0: `git diff` menjalankan clean filter pada berkas dirty
    // (banding konten worktree vs index) — netralkan seperti shadow ops.
    // Efek samping: repo dengan filter konversi legitim (mis. LFS) bisa
    // menampilkan phantom diff; itu display-only dan aman.
    const neutral = await gitFilterNeutralizers(resolvedCwd)
    // Audit #13 chain 6: `git status --porcelain` pun menerapkan clean filter
    // untuk entri racy (file baru diubah vs index) — tanpa neutral, review
    // status di repo jahat mengeksekusi perintah repo (reproducer:
    // PWNED-clean.txt muncul dari git_status). Neutral ikut ke status.
    const [a, b, d] = await Promise.all([
      runGit([...neutral, "status", "--porcelain"], resolvedCwd, ctx.signal),
      // Pasangan -c WAJIB sebelum subcommand "diff" (runGit menaruh BASE di
      // depan; neutral di sini tepat setelahnya). Tanpa ini driver konten
      // repo ikut jalan saat diff membandingkan worktree.
      runGit([...neutral, "diff", ...GIT_NO_DIFF_DRIVERS, "--stat"], resolvedCwd, ctx.signal),
      runGit(["log", "--oneline", "-10"], resolvedCwd, ctx.signal),
    ])
    return `status:\n${a || "(clean)"}\n\ndiff --stat:\n${b || "(no diff)"}\n\nlog -10:\n${d || "(no log)"}`
  },
}

export const gitDiffTool: Tool = {
  name: "git_diff",
  // v7.33 (wire contract): tag family; "hardened" dipertahankan (test pin).
  description:
    "GIT READ: git diff (unstaged) or git diff --staged (hardened: ignores repository hooks, filters and diff drivers — prefer over raw `git diff` in bash)",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      staged: { type: "boolean", description: "true = --staged" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd, staged }, ctx) {
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(cwd as string | undefined, sessionRoot, contextUnrestricted(ctx))
    const resolvedCwd = (cwd as string | undefined)
      ? resolve(sessionRoot, cwd as string)
      : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Netralisasi clean seperti git_status (lihat di atas): diff full-content
    // lebih-lebih memicu filter. -c sebelum subcommand.
    const neutral = await gitFilterNeutralizers(resolvedCwd)
    const args = staged
      ? [...neutral, "diff", ...GIT_NO_DIFF_DRIVERS, "--staged"]
      : [...neutral, "diff", ...GIT_NO_DIFF_DRIVERS]
    return await runGit(args, resolvedCwd, ctx.signal)
  },
}

export const gitLogTool: Tool = {
  name: "git_log",
  // v7.33 (wire contract): tag family.
  description: "GIT READ: git log --oneline -n (hardened: ignores repository hooks and pager)",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      limit: { type: "number", description: "number of commits, default 20" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ cwd, limit }, ctx) {
    const sessionRoot = requireToolCwd(ctx)
    assertCwd(cwd as string | undefined, sessionRoot, contextUnrestricted(ctx))
    const resolvedCwd = (cwd as string | undefined)
      ? resolve(sessionRoot, cwd as string)
      : sessionRoot
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    const n = String(Math.min(Math.max((limit as number) ?? 20, 1), 100))
    return await runGit(["log", "--oneline", `-${n}`], resolvedCwd, ctx.signal)
  },
}

// ── Tool tulis ──
//
// `git_commit` di-GATE di permission layer (setara `delegate_task`/`mcp_call`):
// commit mengubah riwayat yang dibagikan, jadi butuh persetujuan sekali per
// pemakaian di mode `auto`, dan ditolak di `readonly`/`plan`/`allowlist`.
//
// Yang SENGAJA tidak disediakan: `push`, `reset --hard`, `rebase`, `checkout`,
// `branch -D`, `stash drop`, dan amend. Semuanya sulit dibalikkan atau
// mempengaruhi remote/repo orang lain — agent tidak perlu itu untuk
// menyelesaikan task, dan menyediakannya memindahkan risiko besar ke tangan
// yang tidak bisa menilai konteksnya.

/** Nama file di argumen `paths` harus di dalam workspace. */
function assertPaths(
  paths: unknown,
  cwd: string | undefined,
  sessionRoot: string,
  relaxed = false,
  rejectDirectories = false,
): string[] {
  if (paths == null) return []
  if (!Array.isArray(paths)) throw new Error("paths must be an array of strings")
  const root = cwd ? resolve(sessionRoot, cwd) : sessionRoot
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) continue
    // Tolak pathspec magic git (`:(glob)`, `:(top)`, `:/`, `:!`, `:^`):
    // bisa mencocokkan file sensitif/direktori luar secara diam-diam.
    if (/^:(?:\(|\/|!|\^)/.test(p)) throw new Error(`pathspec magic is not allowed: ${p}`)
    if (!relaxed && (isPathOutsideRoot(p, root) || isRealPathOutsideRoot(p, root)))
      throw new Error(`path outside workspace: ${p}`)
    const abs = resolve(root, p)
    if (isSensitive(p) || isSensitive(abs) || isSensitiveReal(p, root))
      throw new Error(`blocked sensitive file: ${p}`)
    if (isOwnedState(p) || isOwnedState(abs) || isOwnedStateReal(p, root))
      throw new Error(`blocked owned state: ${p}`)
    if (rejectDirectories) {
      if (p === "." || p === "./" || p === ".\\") {
        throw new Error(`directory path is not allowed; specify a single file path: ${p}`)
      }
      try {
        if (lstatSync(abs).isDirectory()) {
          throw new Error(`directory path is not allowed; specify a single file path: ${p}`)
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("directory path is not allowed")) throw e
      }
    }
    out.push(p)
  }
  return out
}

export const gitCommitTool: Tool = {
  name: "git_commit",
  // v7.33 (wire contract): `GIT WRITE:` (bukan GIT READ) agar model tak
  // mengira commit adalah operasi baca. Batasan authority dipertahankan.
  description:
    "GIT WRITE: Create a git commit. Stage specific paths or all tracked changes (all:true). No push/amend/reset — beyond the agent's authority. Repository hooks never run; custom filters are refused before staging (review them, then commit manually if trusted).",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "commit message (first line = subject)" },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "files to stage; leave empty when using all",
      },
      all: {
        type: "boolean",
        description: "stage all files ALREADY tracked by git (equivalent to git commit -a)",
      },
      cwd: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  async execute({ message, paths, all, cwd }, ctx) {
    ctx.signal.throwIfAborted()
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    assertCwd(c, sessionRoot, relaxed)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    const msg = String(message ?? "").trim()
    if (!msg) throw new Error("message is required")
    if (msg.length > 4000) throw new Error("message terlalu panjang (max 4000 char)")

    const files = assertPaths(paths, c, sessionRoot, relaxed)
    if (files.length === 0 && all !== true) {
      throw new Error(
        "provide `paths` (specific files) or `all: true` — an empty commit is useless",
      )
    }

    // Repo check dulu supaya errornya jelas, bukan "exit 128".
    const inside = await runGit(
      ["rev-parse", "--is-inside-work-tree"],
      resolvedCwd,
      ctx.signal,
    ).catch(() => "")
    if (!inside.startsWith("true")) throw new Error("not a git repository (git rev-parse failed)")

    return await withGitCommitLock(resolvedCwd, async () => {
      ctx.signal.throwIfAborted()
      // Tool authority tidak mencakup eksekusi command dari filter repo.
      // Discovery juga fail-closed: kegagalan membaca config berhenti sebelum
      // temporary index dibuat atau `git add` dapat menjalankan filter.
      const drivers = await discoverFilterDrivers(resolvedCwd)
      if (drivers.length > 0) {
        const names = drivers.map((d) => `filter.${d.name}`).join(", ")
        throw new Error(
          `git_commit blocked before staging: repository Git filters are configured (${names}). ` +
            "Review .gitattributes and Git config, then perform the commit manually if the filters are trusted.",
        )
      }

      const tempIndexDir = await mkdtemp(join(tmpdir(), "minicode-git-index-"))
      const indexEnv = { GIT_INDEX_FILE: join(tempIndexDir, "index") }
      try {
        // Seed a private index from HEAD. Existing staged changes stay in the
        // user's index and can never leak into this scoped commit.
        const headRef = await runGit(
          ["rev-parse", "--verify", "HEAD"],
          resolvedCwd,
          ctx.signal,
        ).catch(() => "")
        await runGit(
          ["read-tree", headRef.trim() ? "HEAD" : "--empty"],
          resolvedCwd,
          ctx.signal,
          indexEnv,
        )
        if (files.length > 0) {
          // `--literal-pathspecs` + `--`: path diperlakukan harfiah (bukan glob/magic/flag).
          await runGit(
            ["--literal-pathspecs", "add", "--", ...files],
            resolvedCwd,
            ctx.signal,
            indexEnv,
          )
        }

        // `-m` satu argumen; --no-verify menonaktifkan hook yang sudah
        // dinetralkan GIT_SAFE_BASE; --no-gpg-sign mencegah eksekusi gpg.program.
        // `-a` hanya berlaku pada index privat.
        const args = ["commit", "--no-verify", "--no-gpg-sign", "-m", msg]
        if (files.length === 0 && all === true) args.push("-a")
        const out = await runGit(args, resolvedCwd, ctx.signal, indexEnv)
        const firstLine = msg.split("\n")[0]?.trim()
        // runGit mengembalikan "(exit 0)" saat stdout+stderr kosong (lihat baris 82).
        const isCleanGitOut = (s: string): boolean => !s || /^\(exit \d+\)$/.test(s)
        if (/nothing to commit|no changes added/i.test(out)) {
          // Jalur retry "already committed" menjalankan beberapa git berurutan.
          // Cek di sini (dan setelah blok try/catch di bawah) supaya abort di
          // tengah retry tidak ditelan lalu dilaporkan sebagai "nothing to
          // commit" — runGit kini melempar saat signal induk gugur.
          ctx.signal.throwIfAborted()
          try {
            if (files.length > 0) {
              // Hanya klaim "already committed" bila file target bersih sekarang,
              // benar-benar tersentuh di HEAD, DAN subjek commit terakhir atas
              // file tersebut cocok — mencegah false positive saat staging gagal.
              const pending = (
                await runGit(
                  ["status", "--porcelain", "--", ...files],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "DIRTY")
              ).trim()
              const inHead = (
                await runGit(
                  [
                    "--literal-pathspecs",
                    "diff-tree",
                    "--root",
                    "--no-renames",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "HEAD",
                    "--",
                    ...files,
                  ],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "")
              ).trim()
              const subject = (
                await runGit(
                  ["log", "-1", "--format=%s", "--", ...files],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "")
              ).trim()
              if (
                isCleanGitOut(pending) &&
                !isCleanGitOut(inHead) &&
                subject &&
                subject === firstLine
              ) {
                const head = await runGit(
                  ["log", "--oneline", "-1"],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "")
                return `already committed (retry aman — tanpa commit baru):\n${out}${head ? `\n\nHEAD: ${head}` : ""}`
              }
            } else {
              const trackedDirty = (
                await runGit(
                  ["status", "--porcelain", "--untracked-files=no"],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "DIRTY")
              ).trim()
              const subject = (
                await runGit(["log", "-1", "--format=%s"], resolvedCwd, ctx.signal).catch(() => "")
              ).trim()
              if (isCleanGitOut(trackedDirty) && subject && subject === firstLine) {
                const head = await runGit(
                  ["log", "--oneline", "-1"],
                  resolvedCwd,
                  ctx.signal,
                ).catch(() => "")
                return `already committed (retry aman — tanpa commit baru):\n${out}${head ? `\n\nHEAD: ${head}` : ""}`
              }
            }
          } catch {}
          // runGit bisa melempar karena abort DAN kelemparan itu tertelan catch
          // di atas — sebelum mengembalikan hasil retry, pastikan sesi masih
          // hidup supaya pembatalan tak berubah jadi "nothing to commit".
          ctx.signal.throwIfAborted()
          let untrackedHint = ""
          if (files.length === 0 && all === true) {
            const untracked = (
              await runGit(
                ["ls-files", "--others", "--exclude-standard"],
                resolvedCwd,
                ctx.signal,
              ).catch(() => "")
            ).trim()
            if (!isCleanGitOut(untracked)) {
              untrackedHint =
                "\n(note: `all: true` only stages modified tracked files; pass `paths` explicitly to commit untracked files)"
            }
          }
          return `nothing to commit:\n${out}${untrackedHint}`
        }
        let indexWarning = ""
        const newHead = await runGit(
          ["rev-parse", "--verify", "HEAD"],
          resolvedCwd,
          ctx.signal,
        ).catch(() => "")
        if (newHead.trim() && newHead.trim() !== headRef.trim()) {
          try {
            const committedPaths = await runGit(
              [
                "--literal-pathspecs",
                "diff-tree",
                "--root",
                "--no-renames",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                "HEAD",
              ],
              resolvedCwd,
              ctx.signal,
            )
            const paths = committedPaths.split("\0").filter(Boolean)
            if (paths.length > 0) {
              // Reconcile only committed entries in the shared index. This
              // leaves unrelated staged paths intact while keeping the normal
              // post-commit status clean for files this operation authorized.
              await runGit(
                ["--literal-pathspecs", "reset", "--quiet", "HEAD", "--", ...paths],
                resolvedCwd,
                ctx.signal,
              )
            }
          } catch {
            indexWarning =
              "\n\n[warn] commit succeeded, but the shared index could not be reconciled; review `git status` before the next commit."
          }
        }
        const head = await runGit(["log", "--oneline", "-1"], resolvedCwd, ctx.signal).catch(
          () => "",
        )
        return `${out}${head ? `\n\nHEAD: ${head}` : ""}${indexWarning}`
      } finally {
        await rm(tempIndexDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  },
}

export const gitPushTool: Tool = {
  name: "git_push",
  // v7.33 (wire contract): tag GIT WRITE (operasi mengubah remote).
  description:
    "GIT WRITE: Push a local branch to a remote (hardened: repo hooks/filters neutralized; gated like git_commit). In unrestricted mode git credentials (GH_TOKEN/GITHUB_TOKEN/SSH agent) pass through.",
  parameters: {
    type: "object",
    properties: {
      remote: { type: "string", description: "remote name (default: git config)" },
      branch: { type: "string", description: "branch to push (default: current upstream)" },
      setUpstream: {
        type: "boolean",
        description: "set the pushed branch as the upstream tracking branch (-u)",
      },
      cwd: { type: "string" },
    },
    required: [],
    additionalProperties: false,
  },
  async execute({ remote, branch, setUpstream, cwd }, ctx) {
    ctx.signal.throwIfAborted()
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    assertCwd(c, sessionRoot, relaxed)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    // Tolak nilai berawalan "-" (mis. `--receive-pack=...`): argv diteruskan
    // apa adanya ke git, jadi opsi dari argumen model = eksekusi di remote.
    const refArg = (v: unknown, field: string): string | undefined => {
      const s = typeof v === "string" ? v.trim() : ""
      if (!s) return undefined
      if (s.startsWith("-") || s.includes("\0")) throw new Error(`${field} must not start with '-'`)
      return s
    }
    const remoteName = refArg(remote, "remote")
    if (remoteName && (/[:/\\@]/.test(remoteName) || remoteName.includes(".."))) {
      throw new Error("remote must be a configured remote name (not a URL, path, or ext:: helper)")
    }
    const branchName = refArg(branch, "branch")
    if (branchName && (branchName.startsWith("+") || branchName.startsWith(":"))) {
      throw new Error("force-push (+) and remote branch deletion (:) refspecs are not allowed")
    }
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Netralisasi hook: pre-push repo tak boleh dieksekusi. Kredensial hanya
    // lewat saat unrestricted (relaxed).
    const neutral = await gitFilterNeutralizers(resolvedCwd)
    const args: string[] = [...neutral, "push"]
    if (remoteName) args.push(remoteName)
    if (branchName) args.push(branchName)
    else if (setUpstream === true) throw new Error("branch is required when setUpstream:true")
    if (setUpstream === true) args.push("--set-upstream")
    const out = await runGit(args, resolvedCwd, ctx.signal, undefined, relaxed)
    return out.trim() || "(push finished)"
  },
}

/**
 * v7.38: `git_restore`/`git_checkout` sengaja SEMPIT — satu path, tanpa
 * branch switching, tanpa `--force`, tanpa hapus ref. Commit/push sudah
 * di-gate karena mengubah riwayat bersama; restore juga merusak kerja user
 * (menimpa perubahan belum tersimpan), jadi dapat perlakuan gate yang sama.
 * Argumen dibangun sebagai ARRAY (bukan string shell) dan lewat `runGit`
 * yang menetralkan hook/filter repo — persis pola `git_commit`/`git_push`.
 */

/**
 * Audit deep: `git restore`/`git checkout` menulis worktree dan menjalankan
 * SMUDGE filter repo — beda dari status/diff yang hanya kena CLEAN filter.
 * Netralisasi (`filter.<d>.smudge=cat`) mengubah konten hasil restore, jadi
 * bukan jalan yang benar. Seperti `git_commit`, kami TOLAK bila ada driver
 * filter terkonfigurasi: menjalankan perintah dari .git/config = RCE.
 * Fail-closed: discoverFilterDrivers melempar saat config tak bisa dibaca.
 */
async function refuseRepoFilters(cwd: string): Promise<void> {
  const drivers = await discoverFilterDrivers(cwd)
  if (drivers.length > 0) {
    const names = drivers.map((d) => `filter.${d.name}`).join(", ")
    throw new Error(
      `git restore/checkout blocked before running: repository Git filters are configured (${names}). ` +
        "Review .gitattributes and Git config, then restore manually if the filters are trusted.",
    )
  }
}

export const gitRestoreTool: Tool = {
  name: "git_restore",
  // v7.38 (wire contract): tag GIT WRITE agar model tak mengira ini operasi baca.
  description:
    "GIT WRITE: Restore ONE file path from the index or a ref (git restore). Narrow: no branch/ref deletion, no force. `--staged` unstages (index ← HEAD); `ref` sets --source. Repository hooks/filters are neutralized; gated like git_commit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "single file path relative to the workspace root" },
      ref: { type: "string", description: "restore source ref (e.g. HEAD~1); default = index" },
      staged: {
        type: "boolean",
        description: "true = restore the index entry from HEAD (unstage)",
      },
      cwd: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path, ref, staged, cwd }, ctx) {
    ctx.signal.throwIfAborted()
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    assertCwd(c, sessionRoot, relaxed)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    // Fail-closed: path luar root / sensitif / owned-state / direktori ditolak sebelum git jalan.
    const [target] = assertPaths([path], c, sessionRoot, relaxed, true)
    if (!target) throw new Error("path is required")

    // Nilai `--source=` tetap satu argumen argv, tapi tolak awalan '-' dan NUL
    // supaya ref tak bisa menyisipkan opsi git lain (pola `refArg` di git_push).
    const source = typeof ref === "string" ? ref.trim() : ""
    if (source.startsWith("-") || source.includes("\0"))
      throw new Error("ref must not start with '-' or contain NUL")

    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Audit deep: tolak sebelum smudge filter repo sempat dieksekusi.
    await refuseRepoFilters(resolvedCwd)

    // `--literal-pathspecs` + `--`: path satu berkas harfiah, tanpa glob/magic/flag.
    const args: string[] = ["--literal-pathspecs", "restore"]
    if (staged === true) args.push("--staged")
    if (source) args.push(`--source=${source}`)
    args.push("--", target)
    const out = await runGit(args, resolvedCwd, ctx.signal)
    return out.trim() || `restored ${target}${source ? ` from ${source}` : ""}`
  },
}

export const gitCheckoutTool: Tool = {
  name: "git_checkout",
  // v7.38 (wire contract): tag GIT WRITE; ruang lingkup dipadatkan di deskripsi.
  description:
    "GIT WRITE: Restore ONE file path from the index via `git checkout -- <path>`. Narrow path-restore ONLY — no branch switching, no ref, no --force. Repository hooks/filters are neutralized; gated like git_commit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "single file path relative to the workspace root" },
      cwd: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute({ path, cwd }, ctx) {
    ctx.signal.throwIfAborted()
    const c = cwd as string | undefined
    const sessionRoot = requireToolCwd(ctx)
    const relaxed = contextUnrestricted(ctx)
    assertCwd(c, sessionRoot, relaxed)
    const resolvedCwd = c ? resolve(sessionRoot, c) : sessionRoot
    const [target] = assertPaths([path], c, sessionRoot, relaxed, true)
    if (!target) throw new Error("path is required")
    if (!(await isGitRepo(resolvedCwd, ctx.signal))) return "not a git repository"
    // Audit deep: tolak sebelum smudge filter repo sempat dieksekusi.
    await refuseRepoFilters(resolvedCwd)
    // Sengaja TIDAK ada bentuk `git checkout <branch>`: switch branch mengubah
    // seluruh working tree dan bisa menimpa kerja user di luar satu path.
    const out = await runGit(
      ["--literal-pathspecs", "checkout", "--", target],
      resolvedCwd,
      ctx.signal,
    )
    return out.trim() || `restored ${target} from index`
  },
}
