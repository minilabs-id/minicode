// Unit test clipboard OS native (src/lib/clipboard.ts):
// memastikan guard SSH/osc52/non-TTY/fake-TTY bekerja dan urutan kandidat per OS tepat.
import { describe, expect, test } from "bun:test"
import { isAbsolute } from "node:path"
import {
  canUseNativeClipboard,
  nativeClipboardCommands,
  prepareClipboardSpawn,
  writeNativeClipboard,
} from "../src/lib/clipboard.ts"

describe("canUseNativeClipboard", () => {
  test("aktif pada TTY lokal biasa", () => {
    expect(canUseNativeClipboard({ env: {}, isTTY: true, isFakeTty: false })).toBe(true)
  })

  test("nonaktif saat MINICODE_CLIPBOARD=osc52", () => {
    expect(
      canUseNativeClipboard({
        env: { MINICODE_CLIPBOARD: "osc52" },
        isTTY: true,
        isFakeTty: false,
      }),
    ).toBe(false)
  })

  test("nonaktif di sesi SSH remote", () => {
    expect(
      canUseNativeClipboard({
        env: { SSH_CONNECTION: "1.2.3.4 1234 5.6.7.8 22" },
        isTTY: true,
        isFakeTty: false,
      }),
    ).toBe(false)
    expect(
      canUseNativeClipboard({
        env: { SSH_TTY: "/dev/pts/1" },
        isTTY: true,
        isFakeTty: false,
      }),
    ).toBe(false)
  })

  test("nonaktif saat non-TTY atau fake TTY harness", () => {
    expect(canUseNativeClipboard({ env: {}, isTTY: false, isFakeTty: false })).toBe(false)
    expect(canUseNativeClipboard({ env: {}, isTTY: true, isFakeTty: true })).toBe(false)
  })
})

describe("nativeClipboardCommands", () => {
  test("Windows memilih powershell Set-Clipboard UTF-8 lalu fallback clip.exe", () => {
    const cmds = nativeClipboardCommands("win32", {})
    expect(cmds.map((c) => c.cmd)).toEqual(["powershell.exe", "clip.exe"])
  })

  test("macOS memilih pbcopy", () => {
    const cmds = nativeClipboardCommands("darwin", {})
    expect(cmds.map((c) => c.cmd)).toEqual(["pbcopy"])
  })

  test("Linux memilih wl-copy di Wayland dan xclip/xsel di X11", () => {
    expect(
      nativeClipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.cmd),
    ).toEqual(["wl-copy"])
    expect(nativeClipboardCommands("linux", { DISPLAY: ":0" }).map((c) => c.cmd)).toEqual([
      "xclip",
      "xsel",
    ])
    expect(nativeClipboardCommands("linux", {})).toEqual([])
  })
})

describe("writeNativeClipboard", () => {
  test("jatuh ke kandidat kedua saat kandidat pertama gagal", () => {
    const calls: string[] = []
    const ok = writeNativeClipboard("halo dunia 🚀", {
      platform: "win32",
      env: {},
      force: true,
      spawn: (cmd, _args, input) => {
        calls.push(`${cmd}:${input}`)
        return { ok: cmd === "clip.exe" }
      },
    })
    expect(ok).toBe(true)
    expect(calls).toEqual(["powershell.exe:halo dunia 🚀", "clip.exe:halo dunia 🚀"])
  })

  test("tidak menjalankan spawn saat guard nonaktif", () => {
    let called = 0
    const ok = writeNativeClipboard("x", {
      platform: "darwin",
      env: { SSH_CLIENT: "1.2.3.4" },
      isTTY: true,
      isFakeTty: false,
      spawn: () => {
        called++
        return { ok: true }
      },
    })
    expect(ok).toBe(false)
    expect(called).toBe(0)
  })

  test("P0-2: prepareClipboardSpawn menolak biner yang gagal di-resolve absolut (anti CWD hijack)", () => {
    expect(
      prepareClipboardSpawn("clip.exe", [], { platform: "win32", resolveExec: (n) => n }),
    ).toBeNull()
    expect(
      prepareClipboardSpawn("pbcopy", [], { platform: "darwin", resolveExec: (n) => n }),
    ).toBeNull()
    const ok = prepareClipboardSpawn("pbcopy", [], {
      platform: "darwin",
      resolveExec: () =>
        process.platform === "win32" ? "C:\\usr\\bin\\pbcopy" : "/usr/bin/pbcopy",
    })
    expect(ok).not.toBeNull()
    expect(isAbsolute(ok!.command)).toBe(true)

    // Jalur defaultSpawn (tanpa mock spawn) aman terhadap platform tanpa biner: tidak melempar.
    expect(
      writeNativeClipboard("abc", {
        platform: process.platform === "win32" ? "darwin" : "win32",
        env: {},
        force: true,
      }),
    ).toBe(false)
  })
})
