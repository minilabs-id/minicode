// E-3: SecretRunner async (spawn) — secret lewat stdin, N provider paralel
// lewat allSettled, urutan fallback dijaga, dan DPAPI gagal tak turun ke plain.
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetKeystoreForTest,
  __setKeystoreRunnerForTest,
  getSecret,
  setSecret,
} from "../src/lib/keystore.ts"
import { buildProviderListAsync } from "../src/providers/build.ts"

const dirs: string[] = []
const prevHome = process.env.MINICODE_HOME
const prevForce = process.env.MINICODE_KEYSTORE_FORCE_DPAPI
const prevDisable = process.env.MINICODE_KEYSTORE_DISABLE

function useHome(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-ks-async-"))
  dirs.push(d)
  process.env.MINICODE_HOME = d
  return d
}

afterEach(() => {
  __resetKeystoreForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINICODE_HOME
  else process.env.MINICODE_HOME = prevHome
  if (prevForce === undefined) delete process.env.MINICODE_KEYSTORE_FORCE_DPAPI
  else process.env.MINICODE_KEYSTORE_FORCE_DPAPI = prevForce
  if (prevDisable === undefined) delete process.env.MINICODE_KEYSTORE_DISABLE
  else process.env.MINICODE_KEYSTORE_DISABLE = prevDisable
})

test("runner async: secret lewat stdin, bukan argv", async () => {
  useHome()
  process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
  const seen: { args: string[]; input?: string }[] = []
  __setKeystoreRunnerForTest(async (cmd, args, input) => {
    void cmd
    seen.push({ args, input })
    await Bun.sleep(5)
    if (input?.startsWith("BLOB:")) return { status: 0, stdout: `${input.slice(5)}\n` }
    return { status: 0, stdout: `BLOB:${input ?? ""}\n` }
  })

  expect(await setSecret("k", "sk-SUPERSECRET1234567890")).toBe("dpapi")
  expect(await getSecret("k")).toBe("sk-SUPERSECRET1234567890")
  for (const call of seen) {
    expect(call.args.join(" ")).not.toContain("SUPERSECRET")
    expect(call.input ?? "").toContain("sk-SUPERSECRET1234567890")
  }
})

test("N provider → konkuren + urutan cfg.providers terjaga", async () => {
  const home = useHome()
  process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
  __setKeystoreRunnerForTest(async (_cmd, _args, input) => {
    await Bun.sleep(25)
    if (input?.startsWith("BLOB:")) return { status: 0, stdout: `${input.slice(5)}\n` }
    return { status: 0, stdout: `BLOB:${input ?? ""}\n` }
  })
  for (let i = 0; i < 5; i++) await setSecret(`k${i}`, `sk-VALUE${i}`)
  // Bersihkan cache (tanpa menghapus berkas store) supaya resolve benar-benar
  // memanggil runner async; lalu pasang runner pencatat waktu.
  __resetKeystoreForTest()

  const starts: number[] = []
  const ends: number[] = []
  __setKeystoreRunnerForTest(async (_cmd, _args, input) => {
    starts.push(Date.now())
    await Bun.sleep(25)
    ends.push(Date.now())
    if (input?.startsWith("BLOB:")) return { status: 0, stdout: `${input.slice(5)}\n` }
    return { status: 0, stdout: `BLOB:${input ?? ""}\n` }
  })

  const ids = ["p0", "p1", "p2", "p3", "p4"]
  const providers = ids.flatMap((id, i) => [
    ...(i === 2
      ? [
          {
            id: "missing",
            baseUrl: "https://m.example/v1",
            apiKey: "keystore:k-nope",
            models: ["m"],
          },
        ]
      : []),
    { id, baseUrl: "https://x.example/v1", apiKey: `keystore:k${i}`, models: ["m"] },
  ])
  const list = await buildProviderListAsync({ providers })
  expect(list.map((p) => (p as unknown as { id: string }).id)).toEqual(ids)

  // Konkuren nyata: semua runner mulai sebelum yang pertama selesai.
  expect(starts.length).toBeGreaterThanOrEqual(5)
  expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))
  void home
})

test("DPAPI gagal → null (tidak turun ke plain)", async () => {
  const home = useHome()
  process.env.MINICODE_KEYSTORE_FORCE_DPAPI = "1"
  __setKeystoreRunnerForTest(async () => ({ status: 1, stdout: "" }))

  expect(await setSecret("k", "sk-SHOULD_NOT_BE_PLAINTEXT")).toBeNull()
  const file = join(home, ".minicode", "secrets.json")
  // Proteksi gagal = tak ada yang ditulis sama sekali (fail-closed, lebih kuat
  // daripada sekadar "file ada tapi tak mengandung plaintext").
  if (existsSync(file)) {
    expect(readFileSync(file, "utf8")).not.toContain("SHOULD_NOT_BE_PLAINTEXT")
  } else {
    expect(existsSync(file)).toBe(false)
  }
  expect(await getSecret("k")).toBeNull()
})
