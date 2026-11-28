// Auto-update interaktif: keputusan murni harus fail-closed (tak ada skenario
// yang me-restart loop, menyentuh npm dari checkout source, atau mengganggu
// mode machine/CI). Install runner di-inject agar tanpa efek samping.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkForUpdate,
  classifyInstallSource,
  formatUpdateError,
  formatUpdateMessage,
  getLastUpdateFailure,
  installUpdate,
  isInstalledCopy,
  isNewer,
  readGlobalInstalledVersion,
  runManualUpdate,
  shouldAutoUpdate,
  UPDATE_GUARD_ENV,
  verifyInstalledVersion,
} from "../src/policy/update-check.ts"

const BASE_ENV = {
  PATH: "/usr/bin",
}

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...BASE_ENV }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete e[k]
    else e[k] = v
  }
  return e as NodeJS.ProcessEnv
}

const HAPPY = { stdinTTY: true, env: env(), installed: true }

describe("shouldAutoUpdate", () => {
  test("REPL TTY ter-install = jalan", () => {
    expect(shouldAutoUpdate([], HAPPY)).toEqual({ run: true })
  })

  test("opt-out env selalu menang", () => {
    for (const e of [
      env({ NO_UPDATE_CHECK: "1" }),
      env({ CI: "1" }),
      env({ MINICODE_AUTO_UPDATE: "0" }),
      env({ MINICODE_AUTO_UPDATE: "off" }),
    ]) {
      expect(shouldAutoUpdate([], { ...HAPPY, env: e }).run).toBe(false)
    }
  })

  test("guard restart mencegah loop", () => {
    const d = shouldAutoUpdate([], { ...HAPPY, env: env({ [UPDATE_GUARD_ENV]: "1" }) })
    expect(d).toEqual({ run: false, reason: "already-restarted" })
  })

  test("non-TTY / checkout source / mode machine = skip", () => {
    expect(shouldAutoUpdate([], { ...HAPPY, stdinTTY: false }).run).toBe(false)
    expect(shouldAutoUpdate([], { ...HAPPY, installed: false }).run).toBe(false)
    expect(shouldAutoUpdate(["exec", "x", "--json"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["--json"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["--help"], HAPPY).run).toBe(false)
    expect(shouldAutoUpdate(["-v"], HAPPY).run).toBe(false)
  })

  test("prompt one-shot biasa tetap layak (REPL gate di driver, bukan di sini)", () => {
    // shouldAutoUpdate tidak membedakan REPL vs one-shot — pemanggil
    // (cli/index.ts) hanya memanggilnya di jalur enterRepl.
    expect(shouldAutoUpdate(["kerjakan x"], HAPPY)).toEqual({ run: true })
  })
})

describe("isNewer", () => {
  test("semver 3 segmen", () => {
    expect(isNewer("0.9.8", "0.9.9")).toBe(true)
    expect(isNewer("0.9.9", "0.9.9")).toBe(false)
    expect(isNewer("0.10.0", "0.9.9")).toBe(false)
    expect(isNewer("1.0.0", "0.99.99")).toBe(false)
  })

  test("semver pre-release dan build metadata (SemVer 2.0.0)", () => {
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(false)
    expect(isNewer("1.0.0", "1.0.1-alpha.1")).toBe(true)
    expect(isNewer("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(true)
    expect(isNewer("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(false)
    expect(isNewer("1.0.0-1", "1.0.0-alpha")).toBe(true)
    expect(isNewer("1.0.0-alpha", "1.0.0-1")).toBe(false)
    expect(isNewer("1.0.0-alpha", "1.0.0-alpha.1")).toBe(true)
    expect(isNewer("1.0.0+build1", "1.0.0+build2")).toBe(false)
    expect(isNewer("1.0.0+build1", "1.0.1+build0")).toBe(true)
  })
})

describe("isInstalledCopy", () => {
  test("path node_modules = ter-install; path source = bukan", () => {
    expect(isInstalledCopy("/x/node_modules/minicode/cli/index.ts")).toBe(true)
    expect(isInstalledCopy("C:\\npm\\node_modules\\@miniroom\\minicode\\cli\\index.ts")).toBe(true)
    expect(isInstalledCopy("/repo/minicode/cli/index.ts")).toBe(false)
    expect(isInstalledCopy("")).toBe(false)
  })
})

describe("classifyInstallSource & dukungan package manager", () => {
  test("membedakan npm-global, bun-global, bun-custom, dan dev symlink/git repo", () => {
    expect(classifyInstallSource("/usr/local/lib/node_modules/minicode-ai/cli/index.ts")).toBe(
      "npm-global",
    )
    expect(
      classifyInstallSource("/home/u/.bun/install/global/node_modules/minicode-ai/cli/index.ts"),
    ).toBe("bun-global")
    expect(
      classifyInstallSource(
        "C:\\Users\\u\\.bun\\install\\global\\node_modules\\minicode-ai\\cli\\index.ts",
      ),
    ).toBe("bun-global")
    expect(
      classifyInstallSource(
        "D:\\bun-custom\\install\\global\\node_modules\\minicode-ai\\cli\\index.ts",
        {
          env: env({ BUN_INSTALL: "D:\\bun-custom" }),
        },
      ),
    ).toBe("bun-global")
    // Simulasi symlink/junction bun link ke luar node_modules
    expect(
      classifyInstallSource("/home/u/.bun/install/global/node_modules/minicode-ai/cli/index.ts", {
        realpath: () => "/home/u/src/minicode",
      }),
    ).toBe("source-checkout")
    // Simulasi paket dalam node_modules yang mengandung .git
    expect(
      classifyInstallSource("/x/node_modules/minicode-ai/cli/index.ts", {
        exists: (p) => p.endsWith(".git"),
      }),
    ).toBe("source-checkout")
  })

  test("shouldAutoUpdate mengizinkan bun-global dan npm-global untuk update via Bun", () => {
    expect(
      shouldAutoUpdate([], { stdinTTY: true, env: env(), installSource: "bun-global" }),
    ).toEqual({ run: true })
    expect(
      shouldAutoUpdate([], { stdinTTY: true, env: env(), installSource: "npm-global" }),
    ).toEqual({ run: true })
  })

  test("formatUpdateMessage selalu menyarankan bun update -g minicode-ai --latest", () => {
    expect(formatUpdateMessage("0.50.0", "0.51.0", "npm-global")).toContain(
      "bun update -g minicode-ai --latest",
    )
    expect(formatUpdateMessage("0.50.0", "0.51.0", "bun-global")).toContain(
      "bun update -g minicode-ai --latest",
    )
  })
})

describe("installUpdate", () => {
  test("menjalankan bun update -g minicode-ai --latest --ignore-scripts", () => {
    const seen: { cmd: string; args: string[]; hasCwd: boolean }[] = []
    const ok = installUpdate("1.2.3", (cmd, args, opts) => {
      seen.push({ cmd, args, hasCwd: !!opts?.cwd })
      return { status: 0 }
    })
    expect(ok).toBe(true)
    expect(seen).toEqual([
      {
        cmd: "bun",
        args: ["update", "-g", "minicode-ai", "--latest", "--ignore-scripts"],
        hasCwd: false,
      },
    ])
  })

  test("fallback ke bun add -g minicode-ai@latest bila paket belum ada di bun.lock", () => {
    const calls: string[][] = []
    const ok = installUpdate("1.2.3", (cmd, args) => {
      expect(cmd).toBe("bun")
      calls.push(args)
      if (calls.length === 1) {
        return { status: 1, stderr: 'error: "minicode-ai" is not in bun.lock' }
      }
      return { status: 0 }
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([
      ["update", "-g", "minicode-ai", "--latest", "--ignore-scripts"],
      ["add", "-g", "minicode-ai@latest", "--ignore-scripts"],
    ])
  })

  test("kegagalan update selain not-in-bun.lock tidak fallback ke bun add -g", () => {
    const calls: string[][] = []
    const ok = installUpdate("1.2.3", (_cmd, args) => {
      calls.push(args)
      return { status: 1, stderr: "error: E401 Unauthorized" }
    })
    expect(ok).toBe(false)
    expect(calls).toHaveLength(1)
    expect(getLastUpdateFailure()?.step).toBe("bun update -g")
  })

  test("mode rollback { exact: true } mem-pin versi target via bun add -g --exact", () => {
    const calls: string[][] = []
    const ok = installUpdate(
      "1.2.2",
      (cmd, args) => {
        expect(cmd).toBe("bun")
        calls.push(args)
        return { status: 0 }
      },
      { exact: true },
    )
    expect(ok).toBe(true)
    expect(calls).toEqual([["add", "-g", "minicode-ai@1.2.2", "--ignore-scripts", "--exact"]])
  })

  test("install exit failure or runner error returns false", () => {
    expect(installUpdate("1.2.3", () => ({ status: 1 }))).toBe(false)
    expect(
      installUpdate("1.2.3", () => {
        throw new Error("bun hilang")
      }),
    ).toBe(false)
  })

  test("menolak target non-SemVer sebelum menjalankan bun", () => {
    let called = false
    expect(
      installUpdate("latest; whoami", () => {
        called = true
        return { status: 0 }
      }),
    ).toBe(false)
    expect(called).toBe(false)
  })
})

describe("verifyInstalledVersion", () => {
  test("restart hanya layak bila package.json yang dibaca cocok dengan target", () => {
    expect(verifyInstalledVersion("1.2.3", () => "1.2.3")).toBe(true)
    expect(verifyInstalledVersion("1.2.3", () => "1.2.2")).toBe(false)
    expect(
      verifyInstalledVersion("1.2.3", () => {
        throw new Error("unreadable")
      }),
    ).toBe(false)
  })
})

describe("readGlobalInstalledVersion", () => {
  test("membaca versi dari direktori global Bun maupun stdout bun pm ls -g", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-global-ver-"))
    try {
      const pkgDir = join(root, "node_modules", "minicode-ai")
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "9.8.7" }))
      const v = readGlobalInstalledVersion((cmd, args) => {
        expect(cmd).toBe("bun")
        expect(args).toEqual(["pm", "ls", "-g"])
        return { status: 0, stdout: `${root} node_modules (3 installed)\n└── minicode-ai@9.8.7\n` }
      })
      expect(v).toBe("9.8.7")

      const fromStdout = readGlobalInstalledVersion(() => ({
        status: 0,
        stdout: "/nonexistent/bun/global node_modules (2 installed)\n├── minicode-ai@2.4.1\n",
      }))
      expect(fromStdout).toBe("2.4.1")
      expect(readGlobalInstalledVersion(() => ({ status: 1 }))).toBe("0.0.0")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("formatUpdateError", () => {
  test("ANSI, token, URL kredensial, dan newline diredaksi jadi satu baris", () => {
    const msg = formatUpdateError("bun update -g", {
      status: 1,
      stderr:
        "\u001b[31mE401\u001b[0m token npm_abcdefgh12345678\n" +
        "https://user:sup3rsecret@registry.npmjs.org/path\n" +
        "_authToken=npm_zzzzzzzz99999999\n" +
        "Authorization: Bearer sk_live_abcdefghij\n" +
        "password=hunter2\n",
    })
    expect(msg).toContain("bun update -g (exit 1)")
    expect(msg).toContain("E401")
    for (const secret of [
      "npm_abcdefgh12345678",
      "npm_zzzzzzzz99999999",
      "sup3rsecret",
      "user:sup3rsecret@",
      "hunter2",
      "sk_live_abcdefghij",
      "\u001b",
      "\n",
    ]) {
      expect(msg).not.toContain(secret)
    }
    expect(msg.split("\n")).toHaveLength(1)
    expect(msg.length).toBeLessThanOrEqual(300)
  })

  test("timeout dan error.message ikut jadi alasan", () => {
    const timed = formatUpdateError("bun update -g", {
      status: null,
      timedOut: true,
      error: "spawn bun ETIMEDOUT",
    })
    expect(timed).toContain("bun update -g (timeout)")
    expect(timed).toContain("ETIMEDOUT")
    expect(formatUpdateError("bun update -g", { status: 1 })).toContain("bun tidak memberi detail")
    expect(formatUpdateError("bun pm ls -g", { status: null, timedOut: true })).toContain(
      "melewati batas waktu",
    )
  })

  test("stderr panjang dipangkas ≤300 char (tidak mengembalikan stderr mentah)", () => {
    const msg = formatUpdateError("bun update -g", { status: 1, stderr: "x".repeat(2000) })
    expect(msg.length).toBeLessThanOrEqual(300)
    expect(msg).not.toBe("x".repeat(2000))
    expect(msg).toContain("bun update -g (exit 1)")
  })
})

describe("diagnostik runner bun", () => {
  test("stderr dari bun update -g masuk ke lastFailure (sudah diredaksi)", () => {
    expect(
      installUpdate("1.2.3", () => ({
        status: 1,
        stderr: "\u001b[31mE401 token npm_secrettoken123456\u001b[0m",
      })),
    ).toBe(false)
    const failure = getLastUpdateFailure()
    expect(failure?.step).toBe("bun update -g")
    const text = formatUpdateError(failure!.step, failure!.result)
    expect(text).toContain("E401")
    expect(text).not.toContain("npm_secrettoken123456")
  })

  test("timedOut pada fallback bun add -g tercatat, bukan sekadar status null", () => {
    let calls = 0
    expect(
      installUpdate("1.2.3", () => {
        calls++
        if (calls === 1) return { status: 1, stderr: '"minicode-ai" is not in bun.lock' }
        return { status: null, timedOut: true, error: "spawn bun ETIMEDOUT" }
      }),
    ).toBe(false)
    const failure = getLastUpdateFailure()
    expect(failure?.step).toBe("bun add -g")
    expect(failure?.result.timedOut).toBe(true)
    expect(formatUpdateError(failure!.step, failure!.result)).toContain("timeout")
  })

  test("error.message runner diteruskan ke detail kegagalan", () => {
    expect(installUpdate("1.2.3", () => ({ status: null, error: "spawn EACCES" }))).toBe(false)
    expect(getLastUpdateFailure()?.result.error).toBe("spawn EACCES")
  })
})

describe("runManualUpdate", () => {
  const clean = {
    NO_UPDATE_CHECK: undefined,
    CI: undefined,
    MINICODE_AUTO_UPDATE: undefined,
  }

  async function withEnv(
    over: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const saved = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(over)) {
      saved.set(k, process.env[k])
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      await fn()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  test("sukses: check → install → verify dan tidak restart", async () => {
    await withEnv(clean, async () => {
      const phases: string[] = []
      const result = await runManualUpdate({
        onPhase: (p) => phases.push(p),
        check: async () => "2.0.0",
        install: (v) => {
          expect(v).toBe("2.0.0")
          return true
        },
        getInstalled: () => "2.0.0",
      })
      expect(result).toEqual({ ok: true, latest: "2.0.0" })
      expect(phases).toEqual(["check", "install", "verify"])
    })
  })

  test("already latest: tidak menjalankan install", async () => {
    await withEnv(clean, async () => {
      let called = false
      const result = await runManualUpdate({
        check: async () => null,
        install: () => {
          called = true
          return true
        },
        getInstalled: () => "1.0.0",
      })
      expect(result).toEqual({ ok: true, alreadyLatest: true })
      expect(called).toBe(false)
    })
  })

  test("opt-out: NO_UPDATE_CHECK / CI / MINICODE_AUTO_UPDATE tanpa npm", async () => {
    let called = false
    const check = async () => {
      called = true
      return "2.0.0"
    }
    for (const [k, v] of [
      ["NO_UPDATE_CHECK", "1"],
      ["CI", "1"],
      ["MINICODE_AUTO_UPDATE", "0"],
      ["MINICODE_AUTO_UPDATE", "false"],
      ["MINICODE_AUTO_UPDATE", "off"],
    ]) {
      await withEnv({ ...clean, [k as string]: v }, async () => {
        expect(await runManualUpdate({ check, install: () => true })).toEqual({
          ok: false,
          optedOut: true,
        })
      })
    }
    expect(called).toBe(false)
  })

  test("install gagal: step + reason berasal dari formatter", async () => {
    await withEnv(clean, async () => {
      const result = await runManualUpdate({
        check: async () => "3.0.0",
        install: () => false,
      })
      expect(result.ok).toBe(false)
      expect(result.step).toBe("bun update -g")
      expect(result.reason).toContain("bun update -g")
      expect(result.reason!.length).toBeGreaterThan(0)
      expect(result.reason!.length).toBeLessThanOrEqual(300)
    })
  })

  test("install melempar: error.message jadi alasan", async () => {
    await withEnv(clean, async () => {
      const result = await runManualUpdate({
        check: async () => "3.0.0",
        install: () => {
          throw new Error("EACCES saat menulis prefix global")
        },
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toContain("EACCES saat menulis prefix global")
    })
  })

  test("verify gagal bila versi terpasang tidak cocok", async () => {
    await withEnv(clean, async () => {
      const result = await runManualUpdate({
        check: async () => "4.0.0",
        install: () => true,
        getInstalled: () => "3.9.9",
      })
      expect(result).toMatchObject({ ok: false, step: "verify" })
      expect(result.reason).toContain("3.9.9")
    })
  })

  test("preflight source-checkout ditolak sebelum network check", async () => {
    await withEnv(clean, async () => {
      let checkCalled = false
      const result = await runManualUpdate({
        installSource: "source-checkout",
        check: async () => {
          checkCalled = true
          return "9.9.9"
        },
      })
      expect(checkCalled).toBe(false)
      expect(result.ok).toBe(false)
      expect(result.step).toBe("preflight")
      expect(result.reason).toContain("git pull")
    })
  })

  test("bun-global menjalankan alur penuh check → install → verify tanpa blok preflight", async () => {
    await withEnv(clean, async () => {
      let installCalled = false
      const resNew = await runManualUpdate({
        installSource: "bun-global",
        check: async () => "2.1.0",
        install: () => {
          installCalled = true
          return true
        },
        getInstalled: () => "2.1.0",
      })
      expect(installCalled).toBe(true)
      expect(resNew).toEqual({ ok: true, latest: "2.1.0" })

      const resLatest = await runManualUpdate({
        installSource: "bun-global",
        check: async () => null,
      })
      expect(resLatest).toEqual({ ok: true, alreadyLatest: true })
    })
  })
})

describe("checkForUpdate opt-out dan atomic cache", () => {
  test("MINICODE_AUTO_UPDATE=0 mencegah fetch di checkForUpdate", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mc-upd-optout-"))
    const origFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      throw new Error("should not fetch")
    }) as unknown as typeof fetch
    const saved = {
      MINICODE_HOME: process.env.MINICODE_HOME,
      MINICODE_AUTO_UPDATE: process.env.MINICODE_AUTO_UPDATE,
      NO_UPDATE_CHECK: process.env.NO_UPDATE_CHECK,
      CI: process.env.CI,
    }
    try {
      process.env.MINICODE_HOME = tmpHome
      process.env.MINICODE_AUTO_UPDATE = "0"
      delete process.env.NO_UPDATE_CHECK
      delete process.env.CI
      expect(await checkForUpdate("0.1.0")).toBeNull()
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = origFetch
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  test("writeCache menulis update-check.json secara atomik tanpa sisa file tmp", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "mc-upd-cache-"))
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "9.9.9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const saved = {
      MINICODE_HOME: process.env.MINICODE_HOME,
      MINICODE_AUTO_UPDATE: process.env.MINICODE_AUTO_UPDATE,
      NO_UPDATE_CHECK: process.env.NO_UPDATE_CHECK,
      CI: process.env.CI,
    }
    try {
      process.env.MINICODE_HOME = tmpHome
      delete process.env.MINICODE_AUTO_UPDATE
      delete process.env.NO_UPDATE_CHECK
      delete process.env.CI
      const latest = await checkForUpdate("0.1.0")
      expect(latest).toBe("9.9.9")
      const dir = join(tmpHome, ".minicode")
      const files = readdirSync(dir)
      expect(files).toEqual(["update-check.json"])
    } finally {
      globalThis.fetch = origFetch
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
