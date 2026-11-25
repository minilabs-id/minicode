import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { productionIdempotencyKey } from "../cli/setup.ts"
import { TaskError } from "../src/task/model.ts"
import { resetTaskStoreHandles, TaskStore } from "../src/task/store.ts"
import {
  bashTool,
  detectWindowsCmdQuotingHazard,
  setBashIdleTimeoutForTest,
} from "../src/tools/bash.ts"
import { buildEditNotFoundHint, editTool } from "../src/tools/edit.ts"
import { grepTool } from "../src/tools/grep.ts"
import { todoSession, todoWriteTool } from "../src/tools/todo.ts"

const ownedDirs: string[] = []
async function tmpWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  ownedDirs.push(dir)
  return dir
}

afterEach(async () => {
  setBashIdleTimeoutForTest(null)
  todoSession.id = "default"
  todoSession.cwd = undefined
  try {
    resetTaskStoreHandles()
  } catch {}
  delete process.env.MINICODE_GREP_ENGINE
  while (ownedDirs.length > 0) {
    await rm(ownedDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

describe("Tahap 1: anti-hang bash & guard cmd.exe Windows", () => {
  test("detectWindowsCmdQuotingHazard menolak single quote operator & heredoc di win32", () => {
    expect(detectWindowsCmdQuotingHazard("awk 'NR>=340 && NR<=380' src/a.ts", "win32")).toContain(
      "cmd.exe quoting hazard",
    )
    expect(detectWindowsCmdQuotingHazard("grep -E 'foo|bar' src/a.ts", "win32")).toContain(
      "cmd.exe quoting hazard",
    )
    expect(detectWindowsCmdQuotingHazard("python - <<'PY'\nprint(1)\nPY", "win32")).toContain(
      "POSIX heredoc",
    )
    // Aman: single quote di dalam double quote, tanpa operator, atau POSIX.
    expect(detectWindowsCmdQuotingHazard("bun -e \"const s = 'a > b & c'\"", "win32")).toBeNull()
    expect(detectWindowsCmdQuotingHazard("echo 'hello world'", "win32")).toBeNull()
    expect(detectWindowsCmdQuotingHazard("echo it's fine & echo it's ok", "win32")).toBeNull()
    expect(detectWindowsCmdQuotingHazard("awk 'NR>=340 && NR<=380' src/a.ts", "linux")).toBeNull()
    // Path Windows berujung backslash menutup kutip ganda di cmd.exe; hazard di belakangnya tetap tertangkap.
    expect(
      detectWindowsCmdQuotingHazard("dir \"C:\\foo\\\" && awk 'a>b' x.txt", "win32"),
    ).toContain("cmd.exe quoting hazard")
    // Kutip escaped di dalam argumen runtime tetap aman.
    expect(detectWindowsCmdQuotingHazard('bun -e "write(\\"a > b\\")"', "win32")).toBeNull()
  })

  test("bash foreground menutup stdin sehingga pembaca stdin menerima EOF segera", async () => {
    const dir = await tmpWorkspace("mc-stdin-")
    const rt = JSON.stringify(process.execPath)
    const out = (await bashTool.execute(
      {
        cmd: `${rt} -e "process.stdin.resume(); process.stdin.on('end', () => console.log('EOF_OK'))"`,
        timeoutMs: 8000,
      },
      { signal: new AbortController().signal, cwd: dir } as never,
    )) as string
    expect(out).toContain("EOF_OK")
  })

  test("bash idle watchdog memutus perintah diam tanpa timeout eksplisit (unrestricted)", async () => {
    const dir = await tmpWorkspace("mc-idle-")
    setBashIdleTimeoutForTest(350)
    const rt = JSON.stringify(process.execPath)
    const started = Date.now()
    const err = (await bashTool
      .execute({ cmd: `${rt} -e "setTimeout(() => {}, 10000)"` }, {
        signal: new AbortController().signal,
        cwd: dir,
        permissionMode: "unrestricted",
      } as never)
      .catch((e: unknown) => e)) as Error
    const elapsed = Date.now() - started
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("[TOOL_OUTCOME state=UNKNOWN reason=TIMEOUT")
    expect(err.message).toContain("idle_ms=350")
    expect(elapsed).toBeLessThan(6000)
  }, 15_000)
})

describe("Tahap 2: perbaikan celah harness (edit, grep, idempotency, todo)", () => {
  test("edit error menampilkan baris terdekat + tip read_file saat oldString tidak cocok", async () => {
    const dir = await tmpWorkspace("mc-edit-hint-")
    const file = join(dir, "sample.ts")
    await writeFile(
      file,
      [
        "export function alpha() {",
        "  return 1",
        "}",
        "",
        "export function computeTotal(items: number[]) {",
        "  return items.reduce((acc, x) => acc + x, 0)",
        "}",
      ].join("\n"),
      "utf8",
    )
    const err = (await editTool
      .execute(
        {
          path: "sample.ts",
          oldString: "export function computeTotal(items: number[]) {\n  return 999\n}",
          newString: "export function computeTotal() { return 0 }",
        },
        { signal: new AbortController().signal, cwd: dir } as never,
      )
      .catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("oldString not found in sample.ts")
    expect(err.message).toContain("Closest match around line 5")
    expect(err.message).toContain("read_file")
    expect(buildEditNotFoundHint("abc\ndef", "zzz_nonexistent_token", "a.ts")).toContain(
      "read_file",
    )
  })

  test("grep mendukung path satu berkas dan contextLines + jaga jail sensitif", async () => {
    const dir = await tmpWorkspace("mc-grep-ctx-")
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(
      join(dir, "src", "a.ts"),
      ["line 1", "line 2", "const TARGET_KEY = 42", "line 4", "line 5", "line 6"].join("\n"),
      "utf8",
    )
    await writeFile(join(dir, ".env"), "TARGET_KEY=secret\n", "utf8")
    const ctx = { signal: new AbortController().signal, cwd: dir } as never

    for (const engine of ["js", "auto"] as const) {
      if (engine === "js") process.env.MINICODE_GREP_ENGINE = "js"
      else delete process.env.MINICODE_GREP_ENGINE
      const single = (await grepTool.execute(
        { pattern: "TARGET_KEY", path: "src/a.ts", contextLines: 1 },
        ctx,
      )) as string
      expect(single).toContain("src/a.ts:2- line 2")
      expect(single).toContain("src/a.ts:3: const TARGET_KEY = 42")
      expect(single).toContain("src/a.ts:4- line 4")
      expect(single).not.toContain("line 1")

      const dirCtx = (await grepTool.execute(
        { pattern: "TARGET_KEY", contextLines: 1 },
        ctx,
      )) as string
      expect(dirCtx).toContain("src/a.ts:3: const TARGET_KEY = 42")
      expect(dirCtx).not.toContain(".env")
    }

    await expect(grepTool.execute({ pattern: "TARGET_KEY", path: ".env" }, ctx)).rejects.toThrow(
      /sensitive/,
    )
    await expect(grepTool.execute({ pattern: "x", path: "../outside.ts" }, ctx)).rejects.toThrow(
      /outside workspace/,
    )
  })

  test("productionIdempotencyKey membedakan bash sebelum dan sesudah mutasi workspace", () => {
    const k0 = productionIdempotencyKey("bash", { cmd: "bun test" }, 2)
    const k0Explicit = productionIdempotencyKey("bash", { cmd: "bun test" }, 2, 0)
    const k1 = productionIdempotencyKey("bash", { cmd: "bun test" }, 2, 1)
    expect(k0Explicit).toBe(k0)
    expect(k1).not.toBe(k0)
  })

  test("todo_write TASK_IDENTITY_REQUIRED memberi daftar id + panduan lintas topik", async () => {
    const dir = await tmpWorkspace("mc-todo-topic-")
    const sid = "topic-shift-session"
    const s = new TaskStore(dir)
    s.createTask(sid, {
      title: "Tugas lama",
      status: "COMPLETED",
      order: 0,
      provenance: { origin: "runtime", source: "test" },
    })
    const err = (await todoWriteTool
      .execute({ todos: [{ content: "Tugas topik baru", status: "in_progress" }] }, {
        signal: new AbortController().signal,
        cwd: dir,
        sessionId: sid,
      } as never)
      .catch((e: unknown) => e)) as TaskError
    expect(err).toBeInstanceOf(TaskError)
    expect(err.code).toBe("TASK_IDENTITY_REQUIRED")
    expect(err.message).toContain("t1(completed)")
    expect(err.message).toContain("todo_read")
    expect(err.message).toContain("never reopen completed/cancelled")
  })
})
