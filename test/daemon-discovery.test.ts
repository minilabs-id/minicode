// E-20: ACL endpoint (bootstrap secret) diperketat, lease (non-secret, tiap
// heartbeat) tidak memanggil icacls. Validasi baca tetap dipertahankan.
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __setDiscoveryAclProbeForTest,
  readEndpoint,
  readLease,
  writeEndpoint,
  writeLease,
} from "../src/daemon/discovery.ts"

const dirs: string[] = []

afterEach(() => {
  __setDiscoveryAclProbeForTest(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function cwd(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-discovery-e20-"))
  dirs.push(d)
  return d
}

test("writeEndpoint harden ACL; writeLease tidak", () => {
  const dir = cwd()
  const acl: string[] = []
  __setDiscoveryAclProbeForTest((p) => acl.push(p))

  const ep = writeEndpoint(
    {
      version: 1,
      port: 12345,
      host: "127.0.0.1",
      incarnation: "inc-1",
      startedAt: Date.now(),
      workspace: "w",
      bootstrap: "a".repeat(43),
    },
    dir,
  )
  expect(acl).toEqual([ep])

  const lease = writeLease(
    { version: 1, incarnation: "inc-1", pid: process.pid, updatedAt: Date.now() },
    dir,
  )
  expect(acl).toEqual([ep])
  expect(lease).not.toBe(ep)
  expect(acl).not.toContain(lease)
})

test("validasi readLease / readEndpoint tetap fail-closed", () => {
  const dir = cwd()
  writeLease({ version: 1, incarnation: "inc", pid: 1, updatedAt: 5 }, dir)
  expect(readLease(dir)?.incarnation).toBe("inc")

  writeEndpoint(
    {
      version: 1,
      port: 1,
      host: "127.0.0.1",
      incarnation: "i",
      startedAt: 0,
      workspace: "w",
      bootstrap: "too-short",
    },
    dir,
  )
  expect(readEndpoint(dir)).toBeNull()
})
