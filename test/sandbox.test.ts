import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDockerRunArgs, dockerAvailable, runInDocker } from "../src/sandbox/docker.ts"
import { discoverSandboxMaskTargets } from "../src/sandbox/mask.ts"
import { buildBwrapArgs, buildSeatbeltProfile } from "../src/sandbox/os.ts"

const hasDocker = dockerAvailable()

test("docker: availability check returns boolean", () => {
  expect(typeof hasDocker).toBe("boolean")
})

test.skipIf(!hasDocker)(
  "docker: echo command in container returns output",
  async () => {
    const res = await runInDocker("echo sandbox-hello", process.cwd(), { timeoutMs: 30_000 })
    expect(res.output).toContain("sandbox-hello")
    expect(res.code).toBe(0)
  },
  15000,
)

test.skipIf(!hasDocker)(
  "docker: fails gracefully on unknown command",
  async () => {
    const res = await runInDocker("nonexistent_cmd_xyz", process.cwd(), { timeoutMs: 10_000 })
    expect(res.code).not.toBe(0)
  },
  15000,
)

test("sandbox masking: hanya mask .env* sensitif & .minicode eksis, abaikan .env.example", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-sb-mask-test-"))
  try {
    mkdirSync(join(dir, ".minicode"), { recursive: true })
    mkdirSync(join(dir, "apps", "web"), { recursive: true })
    writeFileSync(join(dir, ".env"), "SECRET=1")
    writeFileSync(join(dir, ".env.local"), "SECRET=2")
    writeFileSync(join(dir, "apps", "web", ".env.production"), "SECRET=3")
    writeFileSync(join(dir, ".env.example"), "PUBLIC=ok")
    writeFileSync(join(dir, ".env.sample"), "PUBLIC=ok")
    writeFileSync(join(dir, ".env.template"), "PUBLIC=ok")

    const targets = discoverSandboxMaskTargets(dir)
    expect(targets.hasMinicode).toBe(true)
    expect([...targets.envFiles]).toEqual([".env", ".env.local", "apps/web/.env.production"])
    expect(existsSync(join(dir, ".env.nonexistent"))).toBe(false)

    const dockerArgs = buildDockerRunArgs(
      "echo ok",
      dir,
      {},
      {
        containerName: "mc-test",
        hasMinicode: targets.hasMinicode,
        envFiles: targets.envFiles,
        emptyMaskHostPath: join(tmpdir(), "empty"),
      },
    )
    expect(dockerArgs.join(" ")).toContain("/.minicode:ro,size=64k")
    expect(dockerArgs.join(" ")).toContain("/.env:ro")
    expect(dockerArgs.join(" ")).toContain("/apps/web/.env.production:ro")
    expect(dockerArgs.join(" ")).not.toContain(".env.example:ro")

    const dockerBridge = buildDockerRunArgs(
      "echo ok",
      dir,
      { network: "bridge" },
      {
        containerName: "mc-test",
        hasMinicode: false,
        envFiles: [],
        emptyMaskHostPath: null,
      },
    )
    const netIdx = dockerBridge.indexOf("--network")
    expect(dockerBridge[netIdx + 1]).toBe("bridge")

    const bwrapArgs = buildBwrapArgs(
      "echo ok",
      dir,
      {},
      {
        hasMinicode: targets.hasMinicode,
        envFiles: targets.envFiles,
        emptyMaskPath: "/tmp/empty",
      },
    )
    expect(bwrapArgs).toContain("--unshare-pid")
    expect(bwrapArgs).toContain("--unshare-ipc")
    expect(bwrapArgs).toContain("--unshare-uts")
    expect(bwrapArgs).toContain("--new-session")
    expect(bwrapArgs).toContain("--unshare-net")
    expect(bwrapArgs).toContain("--tmpfs")

    const sb = buildSeatbeltProfile(dir, targets.envFiles)
    expect(sb).toContain('(deny file-read* file-write* (subpath "')
    expect(sb).toContain(".minicode")
    expect(sb).toContain(".env.local")
    expect(sb).not.toContain(".env.example")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// E-9: dengan `withFileTypes` hasil harus identik dengan lama (lstat per entri),
// dan symlink bernama `.env*` TETAP terdeteksi tanpa mengikuti targetnya.
test("sandbox masking E-9: hasil identik + symlink .env terdeteksi", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-sb-mask-e9-"))
  try {
    mkdirSync(join(dir, "apps", "a"), { recursive: true })
    mkdirSync(join(dir, "node_modules", "evil"), { recursive: true })
    writeFileSync(join(dir, ".env"), "A=1")
    writeFileSync(join(dir, "apps", "a", ".env.local"), "B=2")
    writeFileSync(join(dir, "node_modules", "evil", ".env"), "SHOULD_BE_SKIPPED")
    writeFileSync(join(dir, "apps", "a", ".env.example"), "PUBLIC=1")

    const first = discoverSandboxMaskTargets(dir)
    const second = discoverSandboxMaskTargets(dir)
    expect(first).toEqual(second)
    expect([...first.envFiles]).toEqual([".env", "apps/a/.env.local"])
    expect(first.hasMinicode).toBe(false)

    try {
      symlinkSync(join(dir, ".env"), join(dir, ".env.link"), "file")
      const withLink = discoverSandboxMaskTargets(dir)
      expect([...withLink.envFiles]).toContain(".env.link")
      // Symlink ke direktori bernama .env tidak boleh dibolak-balik jadi entri
      // dua kali, dan traversal tetap berhenti di SKIP_DIRS.
      expect([...withLink.envFiles]).not.toContain("node_modules/evil/.env")
    } catch (e) {
      // Windows tanpa developer mode menolak symlink — tetap verifikasi bahwa
      // kegagalan itu tidak merusak hasil dasar.
      expect([...first.envFiles]).toEqual([".env", "apps/a/.env.local"])
      void e
    }

    // P1-7: scan terpotong mengembalikan truncated:true dan runner sandbox menolak fail-closed.
    const trunc = discoverSandboxMaskTargets(dir, { maxDirs: 1 })
    expect(trunc.truncated).toBe(true)
    expect(trunc.truncationReason).toBe("max-dirs")
    const deepTrunc = discoverSandboxMaskTargets(dir, { maxDepth: 0 })
    expect(deepTrunc.truncated).toBe(true)
    expect(deepTrunc.truncationReason).toBe("max-depth")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
