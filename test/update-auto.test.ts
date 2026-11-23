// Auto-update interaktif: keputusan murni harus fail-closed (tak ada skenario
// yang me-restart loop, menyentuh npm dari checkout source, atau mengganggu
// mode machine/CI). Install runner di-inject agar tanpa efek samping.

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatUpdateError,
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
})

describe("isInstalledCopy", () => {
  test("path node_modules = ter-install; path source = bukan", () => {
    expect(isInstalledCopy("/x/node_modules/minicode/cli/index.ts")).toBe(true)
    expect(isInstalledCopy("C:\\npm\\node_modules\\@miniroom\\minicode\\cli\\index.ts")).toBe(true)
    expect(isInstalledCopy("/repo/minicode/cli/index.ts")).toBe(false)
    expect(isInstalledCopy("")).toBe(false)
  })
})

describe("installUpdate", () => {
  test("verifikasi signature/provenance dahulu, lalu memasang versi tepat", () => {
    const seen: { args: string[]; cwd?: string }[] = []
    const ok = installUpdate("1.2.3", (cmd, args, opts) => {
      expect(cmd).toBe("npm")
      seen.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
      if (args[0] === "install" && opts?.cwd) {
        writeFileSync(
          join(opts.cwd, "package-lock.json"),
          JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
        )
      }
      return { status: 0 }
    })
    expect(ok).toBe(true)
    expect(seen).toHaveLength(3)
    expect(seen[0]?.args).toContain("minicode-ai@1.2.3")
    expect(seen[0]?.args).toContain("--ignore-scripts")
    expect(seen[1]?.args.slice(0, 2)).toEqual(["audit", "signatures"])
    expect(seen[2]?.args).toContain("-g")
    expect(seen[2]?.args).toContain("minicode-ai@1.2.3")
    expect(seen[0]?.cwd).toBeDefined()
    expect(seen[1]?.cwd).toBe(seen[0]?.cwd)
    expect(seen[0]?.cwd && existsSync(seen[0].cwd)).toBe(false)
  })

  test("signature failure blocks global install; temp verification root is cleaned", () => {
    const seen: { args: string[]; cwd?: string }[] = []
    let calls = 0
    expect(
      installUpdate("1.2.3", (cmd, args, opts) => {
        expect(cmd).toBe("npm")
        seen.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
        calls++
        if (args[0] === "install" && opts?.cwd) {
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
          )
        }
        return { status: calls === 2 ? 1 : 0 }
      }),
    ).toBe(false)
    expect(seen).toHaveLength(2)
    expect(seen[0]?.cwd).toBeDefined()
    expect(seen[1]?.cwd).toBe(seen[0]?.cwd)
    expect(seen[1]?.args.slice(0, 2)).toEqual(["audit", "signatures"])
    expect(seen[0]?.cwd && existsSync(seen[0].cwd)).toBe(false)
  })

  test("unexpected runtime dependency graph blocks global install", () => {
    let calls = 0
    const roots: string[] = []
    expect(
      installUpdate("1.2.3", (_cmd, _args, opts) => {
        calls++
        if (opts?.cwd) {
          roots.push(opts.cwd)
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({
              packages: {
                "": {},
                "node_modules/minicode-ai": {},
                "node_modules/new-runtime-dependency": {},
              },
            }),
          )
        }
        return { status: 0 }
      }),
    ).toBe(false)
    expect(calls).toBe(1)
    expect(roots[0] && existsSync(roots[0])).toBe(false)
  })

  test("install exit failure or runner error returns false", () => {
    expect(installUpdate("1.2.3", () => ({ status: 1 }))).toBe(false)
    expect(
      installUpdate("1.2.3", () => {
        throw new Error("npm hilang")
      }),
    ).toBe(false)
  })

  test("global install failure is reported after successful signature verification", () => {
    let calls = 0
    expect(
      installUpdate("1.2.3", (_cmd, args, opts) => {
        calls++
        if (args[0] === "install" && opts?.cwd) {
          writeFileSync(
            join(opts.cwd, "package-lock.json"),
            JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
          )
        }
        return { status: calls < 3 ? 0 : 1 }
      }),
    ).toBe(false)
    expect(calls).toBe(3)
  })

  test("menolak target non-SemVer sebelum menjalankan npm", () => {
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
  test("membaca versi dari prefix npm global (bukan modul yang sedang jalan)", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-global-ver-"))
    try {
      const pkgDir = join(root, "minicode-ai")
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "9.8.7" }))
      const v = readGlobalInstalledVersion((cmd, args) => {
        expect(cmd).toBe("npm")
        expect(args).toEqual(["root", "-g"])
        return { status: 0, stdout: `${root}\r\n` }
      })
      expect(v).toBe("9.8.7")
      expect(readGlobalInstalledVersion(() => ({ status: 1 }))).toBe("0.0.0")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("formatUpdateError", () => {
  test("ANSI, token, URL kredensial, dan newline diredaksi jadi satu baris", () => {
    const msg = formatUpdateError("npm audit signatures", {
      status: 1,
      stderr:
        "\u001b[31mE401\u001b[0m token npm_abcdefgh12345678\n" +
        "https://user:sup3rsecret@registry.npmjs.org/path\n" +
        "_authToken=npm_zzzzzzzz99999999\n" +
        "Authorization: Bearer sk_live_abcdefghij\n" +
        "password=hunter2\n",
    })
    expect(msg).toContain("npm audit signatures (exit 1)")
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
    const timed = formatUpdateError("npm install -g", {
      status: null,
      timedOut: true,
      error: "spawn npm ETIMEDOUT",
    })
    expect(timed).toContain("npm install -g (timeout)")
    expect(timed).toContain("ETIMEDOUT")
    expect(formatUpdateError("npm install", { status: 1 })).toContain("npm tidak memberi detail")
    expect(formatUpdateError("npm root -g", { status: null, timedOut: true })).toContain(
      "melewati batas waktu",
    )
  })

  test("stderr panjang dipangkas ≤300 char (tidak mengembalikan stderr mentah)", () => {
    const msg = formatUpdateError("npm install", { status: 1, stderr: "x".repeat(2000) })
    expect(msg.length).toBeLessThanOrEqual(300)
    expect(msg).not.toBe("x".repeat(2000))
    expect(msg).toContain("npm install (exit 1)")
  })
})

describe("diagnostik runner npm", () => {
  const writeLock = (cwd: string) =>
    writeFileSync(
      join(cwd, "package-lock.json"),
      JSON.stringify({ packages: { "": {}, "node_modules/minicode-ai": {} } }),
    )

  test("stderr dari audit signatures masuk ke lastFailure (sudah diredaksi)", () => {
    expect(
      installUpdate("1.2.3", (_cmd, args, opts) => {
        if (args[0] === "install" && opts?.cwd) writeLock(opts.cwd)
        if (args[0] === "audit")
          return { status: 1, stderr: "\u001b[31mE401 token npm_secrettoken123456\u001b[0m" }
        return { status: 0 }
      }),
    ).toBe(false)
    const failure = getLastUpdateFailure()
    expect(failure?.step).toBe("npm audit signatures")
    const text = formatUpdateError(failure!.step, failure!.result)
    expect(text).toContain("E401")
    expect(text).not.toContain("npm_secrettoken123456")
  })

  test("timedOut pada install -g tercatat, bukan sekadar status null", () => {
    expect(
      installUpdate("1.2.3", (_cmd, args, opts) => {
        if (args[0] === "install" && opts?.cwd) {
          writeLock(opts.cwd)
          return { status: 0 }
        }
        if (args[0] === "audit") return { status: 0 }
        return { status: null, timedOut: true, error: "spawn npm ETIMEDOUT" }
      }),
    ).toBe(false)
    const failure = getLastUpdateFailure()
    expect(failure?.step).toBe("npm install -g")
    expect(failure?.result.timedOut).toBe(true)
    expect(formatUpdateError(failure!.step, failure!.result)).toContain("timeout")
  })

  test("error.message runner diteruskan ke detail kegagalan", () => {
    expect(
      installUpdate("1.2.3", (_cmd, args, opts) => {
        if (args[0] === "install" && opts?.cwd) writeLock(opts.cwd)
        if (args[0] === "install" && !opts?.cwd) return { status: null, error: "spawn EACCES" }
        return { status: 0 }
      }),
    ).toBe(false)
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
      expect(result.step).toBe("npm install")
      expect(result.reason).toContain("npm install")
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
})
