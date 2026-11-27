// Footer status TUI (src/ui/footer.ts): Work Mode di kiri, Permission Mode
// cyan di kanan dekat konteks, garis hampir tak terlihat, spark pulse/redup.
// Test sengaja agnostik warna (assert via stripAnsi) agar hijau di env apa
// pun; harness fake-TTY dipakai agar columns terkontrol.
//
// Kedua lapis selalu tampil dengan label title case; default Work Mode Discuss
// dan default Permission Mode Auto terlihat tanpa konfigurasi tambahan.

import { afterEach, describe, expect, test } from "bun:test"
import {
  paintBashStrict,
  paintPermissionMode,
  paintWorkMode,
  renderFooter,
  shortenPath,
  shortModel,
} from "../src/ui/footer.ts"
import { c, stripAnsi } from "../src/ui/render/theme.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { installFakeTty } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | undefined
afterEach(() => {
  tty?.restore()
  tty = undefined
})

/**
 * v7.29: warna nyala by default di TTY. Test yang mengunci "tak ada SGR"
 * memaksa MINICODE_COLOR=0 lewat helper ini lalu memulihkannya — jalur mono
 * tetap diuji, bukan dihapus.
 */
function withMono<T>(fn: () => T): T {
  const saved = process.env.MINICODE_COLOR
  process.env.MINICODE_COLOR = "0"
  try {
    return fn()
  } finally {
    if (saved == null) delete process.env.MINICODE_COLOR
    else process.env.MINICODE_COLOR = saved
  }
}

describe("footer render", () => {
  test("shortModel membuang prefix provider", () => {
    expect(shortModel("acme::deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(shortModel("deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(shortModel("")).toBe("")
  })

  test("1 baris: status mode, model, cwd, konteks + spark (tanpa garis)", () => {
    tty = installFakeTty({ columns: 96 })
    const [status] = renderFooter(
      {
        mode: "auto",
        workMode: "EXECUTE",
        model: "acme::deepseek-v4-flash",
        cwd: "C:\\Users\\dokument",
        context: "14.2k",
      },
      96,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("✦")
    expect(plain).toContain("Build")
    expect(plain).toContain("Auto")
    expect(plain.indexOf("14.2k")).toBeLessThan(plain.indexOf("Auto"))
    expect(plain).toContain("deepseek-v4-flash")
    expect(plain).toContain("C:\\Users\\dokument")
    expect(plain).toContain("14.2k")
  })

  test("activity diabaikan: footer hanya mode, model, cwd, konteks, dan spark", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter(
      {
        mode: "auto",
        model: "m1",
        cwd: "cwd",
        context: "1k",
        activity: "Working 12s",
        sparkFrame: 2,
      },
      90,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("Discuss")
    expect(plain).toContain("Auto")
    expect(plain).toContain("m1")
    expect(plain).toContain("cwd")
    expect(plain).toContain("1k")
    expect(plain).not.toMatch(/Working|Thinking|Running|\d+s/)
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
  })

  test("field footer tetap stabil tanpa activity variable-width", () => {
    tty = installFakeTty({ columns: 90 })
    const states = ["Thinking 0s", "Working 10s", "Running tool-with-a-long-name"]
    const lines = states.map((activity) =>
      stripAnsi(renderFooter({ mode: "auto", model: "m1", cwd: "cwd", activity }, 90)[0]!),
    )
    const modelColumn = lines[0]!.indexOf("m1")
    const modeColumn = lines[0]!.indexOf("Discuss")
    for (const line of lines) {
      expect(line).toContain("m1")
      expect(line.indexOf("m1")).toBe(modelColumn)
      expect(line.indexOf("Discuss")).toBe(modeColumn)
      expect(line).not.toMatch(/Thinking|Working|Running|\d+s/)
      expect(displayWidth(line)).toBeLessThanOrEqual(89)
    }
  })

  test("footer tetap stabil di terminal sempit", () => {
    tty = installFakeTty({ columns: 46 })
    const lines = ["Thinking 0s", "Working 10s"].map((activity) =>
      stripAnsi(renderFooter({ mode: "auto", model: "m1", cwd: "cwd", activity }, 46)[0]!),
    )
    const modeColumn = lines[0]!.indexOf("Discuss")
    const modelColumn = lines[0]!.indexOf("m1")
    for (const line of lines) {
      expect(line).toContain("Discuss")
      expect(line.indexOf("Discuss")).toBe(modeColumn)
      expect(line).toContain("Auto")
      expect(line.indexOf("m1")).toBe(modelColumn)
      expect(line).not.toMatch(/Thinking|Working|Running|\d+s/)
      expect(displayWidth(line)).toBeLessThanOrEqual(45)
    }
  })

  test("timer di sebelah sparkle, separator bullet hilang, tanpa level warna (monokrom)", () => {
    // v7.29: warna nyala by default — paksa MINICODE_COLOR=0 untuk mengunci
    // bahwa di mode mono timer tak berubah level warna idle → busy.
    withMono(() => {
      tty = installFakeTty({ columns: 90 })
      const render = (
        timer: string,
        timerActive: boolean,
        timerHighlight?: "seconds" | "minutes" | "hours",
      ) =>
        renderFooter(
          { mode: "auto", model: "m1", cwd: "cwd", timer, timerActive, timerHighlight },
          90,
        )[0]!
      const idle = render("00.00.00", false)
      const seconds = render("00.00.42", true, "seconds")
      const minutes = render("00.01.02", true, "minutes")
      const hours = render("01.00.00", true, "hours")
      expect(stripAnsi(idle)).toMatch(/✦ {2}00\.00\.00 {2}Discuss +m1 +cwd/)
      expect(stripAnsi(seconds)).toMatch(/✦ {2}00\.00\.42 {2}Discuss +m1 +cwd/)
      expect(stripAnsi(minutes)).toMatch(/✦ {2}00\.01\.02 {2}Discuss +m1 +cwd/)
      expect(stripAnsi(hours)).toMatch(/✦ {2}01\.00\.00 {2}Discuss +m1 +cwd/)
      for (const line of [idle, seconds, minutes, hours]) {
        expect(stripAnsi(line)).not.toContain("•")
        // Mode mono: timer tetap di samping spark, tak ada SGR sama sekali.
        expect(line).not.toContain("\x1b[")
        expect(line).toBe(stripAnsi(line))
      }
    })
  })

  test("Work Mode stabil di kiri; Permission Mode tidak menggeser model", () => {
    tty = installFakeTty({ columns: 90 })
    const withMode = (mode: string) =>
      stripAnsi(renderFooter({ mode, workMode: "EXECUTE", model: "m1", cwd: "cwd" }, 90)[0]!)
    const auto = withMode("auto")
    const ask = withMode("ask")
    expect(auto.indexOf("m1")).toBe(ask.indexOf("m1"))
    expect(auto.indexOf("Build")).toBe(ask.indexOf("Build"))
    expect(auto.indexOf("Auto")).toBeGreaterThan(auto.indexOf("cwd"))
    expect(ask.indexOf("Ask")).toBeGreaterThan(ask.indexOf("cwd"))
    expect(auto).not.toContain("•")
  })

  test("konteks rata kanan: di ujung kolom target, kiri tetap utuh", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", context: "14.2k" }, 90)
    const plain = stripAnsi(status!)
    expect(plain.endsWith("●")).toBe(true)
    expect(plain).toContain("Auto")
    expect(plain.indexOf("14.2k")).toBeLessThan(plain.indexOf("Auto"))
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
    expect(plain).toContain("m1")
    expect(plain).toContain("cwd")
  })

  test("mode memakai title case dan warna Work/Permission berbeda", () => {
    tty = installFakeTty({ columns: 60 })
    const build = paintWorkMode("EXECUTE")
    const discuss = paintWorkMode("DISCUSS")
    const plan = paintWorkMode("PLAN")
    const auto = paintPermissionMode("auto")
    const ask = paintPermissionMode("ask")
    expect(stripAnsi(build).trimEnd()).toBe("Build")
    expect(stripAnsi(discuss).trimEnd()).toBe("Discuss")
    expect(stripAnsi(plan).trimEnd()).toBe("Plan")
    expect(stripAnsi(auto)).toBe("Auto")
    expect(stripAnsi(ask)).toBe("Ask")
    expect(build).toContain(c.success("Build"))
    // Discuss = default sesi baru: accent (bukan warning, yang terbaca alarm).
    expect(discuss).toContain(c.accent("Discuss"))
    expect(auto).toContain(c.info("Auto"))
    expect(ask).toContain(c.info("Ask"))
    expect(c.success("Build")).not.toBe(c.info("Auto"))
  })

  test("v7.29: footer memancarkan SGR saat warna aktif (tanpa MINICODE_COLOR)", () => {
    // Pasangan dari test mono: env warna aktif by default di fake TTY.
    tty = installFakeTty({ columns: 90 })
    const line = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 90)[0]!
    expect(line).toContain("\x1b[")
    expect(stripAnsi(line)).toContain("Discuss")
    expect(stripAnsi(line)).toContain("Auto")
  })

  test("badge bash: titik monokrom (kuning aktif, abu nonaktif, merah unrestricted)", () => {
    tty = installFakeTty({ columns: 80 })
    expect(stripAnsi(paintBashStrict(true))).toBe("●")
    expect(stripAnsi(paintBashStrict(false))).toBe("●")
    expect(stripAnsi(paintBashStrict(undefined))).toBe("●")
    // aktif = kuning/terang, nonaktif = redup.
    expect(paintBashStrict(true)).toContain(c.yellow("●"))
    expect(paintBashStrict(false)).toContain(c.gray("●"))
    const [strict] = renderFooter({ mode: "auto", strictBash: true, model: "m1", cwd: "cwd" }, 80)
    const [plain] = renderFooter({ mode: "auto", strictBash: false, model: "m1", cwd: "cwd" }, 80)
    expect(stripAnsi(strict!)).toContain("●")
    expect(stripAnsi(plain!)).toContain("●")
  })

  test("unrestricted: hanya titik terbuka (○ merah) tanpa label permission", () => {
    tty = installFakeTty({ columns: 80 })
    // Titik jadi ○ (terbuka) merah saat unrestricted aktif.
    expect(stripAnsi(paintBashStrict(false, true))).toBe("○")
    expect(stripAnsi(paintBashStrict(true, true))).toBe("○")
    expect(paintBashStrict(true, true)).toContain(c.red("○"))
    // Label permission disembunyikan (cukup titik terbuka).
    expect(paintPermissionMode("unrestricted")).toBe("")
    const [line] = renderFooter({ mode: "unrestricted", model: "m1", cwd: "cwd" }, 80)
    expect(stripAnsi(line!)).not.toContain("Unrestricted")
    expect(stripAnsi(line!)).toContain("○")
  })

  test("terminal sempit: 1 baris visual, spark+mode kekal (cwd/model dibuang)", () => {
    tty = installFakeTty({ columns: 24 })
    const [status] = renderFooter(
      { mode: "ask", model: "acme::model-sangat-panjang-sekali", cwd: "C:\\Users\\dokument" },
      24,
    )
    expect(status).not.toContain("\n")
    expect(displayWidth(stripAnsi(status!))).toBeLessThanOrEqual(23)
    expect(stripAnsi(status!)).toContain("✦")
    const plain = stripAnsi(status!)
    expect(plain).toContain("Discuss")
    expect(plain).toContain("Ask")
  })

  test("spark: glyph statis monokrom, tanpa animasi warna antar frame", () => {
    // v7.29: di mode warna spark berdenyut (faint → gray → white), jadi test
    // "tanpa animasi warna" ini dijalankan dengan MINICODE_COLOR=0.
    withMono(() => {
      tty = installFakeTty({ columns: 80 })
      const idle = renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 80)[0]!
      const busy1 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 1 }, 80)[0]!
      const busy2 = renderFooter({ mode: "auto", model: "m1", cwd: "cwd", sparkFrame: 2 }, 80)[0]!
      for (const line of [idle, busy1, busy2]) {
        expect(stripAnsi(line)).toContain("✦")
        // Mode mono: tak ada SGR yang berubah antar frame.
        expect(line).not.toContain("\x1b[")
      }
      // Tanpa kanal warna, frame idle/busy identik — animasi memang dihapus.
      expect(busy1).toBe(busy2)
      expect(idle).toBe(busy1)
    })
  })

  test("injeksi ANSI dari nama model/cwd/context dinetralkan", () => {
    tty = installFakeTty({ columns: 80 })
    const [status] = renderFooter(
      {
        mode: "auto",
        model: "evil\x1b[2Jm",
        cwd: "C:\\x\x1b[?25lh",
        context: "9k\x1b[2J",
        activity: "Working\x1b[2Jnow",
      },
      80,
    )
    expect(status!).not.toContain("[2J")
    expect(status!).not.toContain("[?25l")
    expect(stripAnsi(status!)).toContain("evilm")
  })

  test("newline di model/cwd/context/mode jadi spasi, tetap 1 baris", () => {
    tty = installFakeTty({ columns: 90 })
    const [status] = renderFooter(
      { mode: "au\nto", model: "m\n1", cwd: "a\nb", context: "9\nk" },
      90,
    )
    expect(status!).not.toContain("\n")
    const plain = stripAnsi(status!)
    expect(plain).toContain("Discuss")
    expect(plain).toContain("Au To")
    expect(plain).toContain("m 1")
    expect(plain).toContain("a b")
    expect(plain).toContain("9 k")
    expect(displayWidth(plain)).toBeLessThanOrEqual(89)
  })

  test("badge job background: ◷ N hanya saat ada job hidup, frame memutar", () => {
    tty = installFakeTty({ columns: 80 })
    const idle = stripAnsi(renderFooter({ mode: "auto", model: "m1", cwd: "cwd" }, 80)[0]!)
    expect(idle).not.toContain("◷")
    const one = stripAnsi(
      renderFooter({ mode: "auto", model: "m1", cwd: "cwd", backgroundJobs: 1 }, 80)[0]!,
    )
    expect(one).toContain("◷ 1")
    const three = stripAnsi(
      renderFooter({ mode: "auto", model: "m1", cwd: "cwd", backgroundJobs: 3 }, 80)[0]!,
    )
    expect(three).toContain("◷ 3")
    // Frame menggeser glyph: penanda "masih hidup", bukan angka statis.
    const f1 = stripAnsi(
      renderFooter(
        { mode: "auto", model: "m1", cwd: "cwd", backgroundJobs: 1, backgroundFrame: 1 },
        80,
      )[0]!,
    )
    const f2 = stripAnsi(
      renderFooter(
        { mode: "auto", model: "m1", cwd: "cwd", backgroundJobs: 1, backgroundFrame: 2 },
        80,
      )[0]!,
    )
    expect(f1).not.toBe(f2)
    expect(f1).toContain("1")
    // Badge tidak boleh menggeser kolom spark: lead tetap ✦ lalu badge.
    expect(one.startsWith("✦")).toBe(true)
  })

  test("badge job background: fallback ASCII nol emoji di terminal non-UTF8", () => {
    tty = installFakeTty({ columns: 80 })
    process.env.MINICODE_ASCII = "1"
    try {
      const line = stripAnsi(
        renderFooter({ mode: "auto", model: "m1", cwd: "cwd", backgroundJobs: 2 }, 80)[0]!,
      )
      expect(line).toContain("[BG:2]")
      expect(line).not.toContain("◷")
      // Glyph mode juga jatuh ke teks ASCII.
      expect(line).toContain("[LOCK]")
    } finally {
      delete process.env.MINICODE_ASCII
    }
  })

  test("shortenPath memperpendek segmen direktori", () => {
    expect(shortenPath("d:\\git\\minicode\\src\\ui")).toBe("...\\src\\ui")
    expect(shortenPath("/home/user/projects/minicode/src")).toBe(".../minicode/src")
    expect(shortenPath("/short/path")).toBe("/short/path")
    expect(shortenPath("")).toBe("")
  })

  test("terminal sedang: menggunakan shortened cwd sebelum dibuang total", () => {
    tty = installFakeTty({ columns: 70 })
    const longCwd = "D:\\very\\long\\nested\\workspace\\directory\\for\\testing\\repo"
    const [status] = renderFooter(
      { mode: "auto", model: "gpt-4o", cwd: longCwd, context: "10k" },
      70,
    )
    const plain = stripAnsi(status!)
    expect(plain).toContain("...\\testing\\repo")
    expect(plain).not.toContain("D:\\very\\long")
    expect(displayWidth(plain)).toBeLessThanOrEqual(69)
  })

  test("cache footer: hasil array tetap baru (env tema tak mengubah output monokrom)", () => {
    // v7.29: warna nyala by default — paksa MINICODE_COLOR=0 supaya env tema
    // (COLORTERM/NO_COLOR) tak bisa mengubah isi footer di jalur mono.
    withMono(() => {
      tty = installFakeTty({ columns: 80 })
      const args = { mode: "auto", model: "m1", cwd: "cwd" } as const
      const plain = renderFooter(args, 80)[0]!
      expect(plain).not.toContain("\x1b[")
      // Mutasi hasil panggilan tidak boleh meracuni cache.
      const mutable = renderFooter(args, 80)
      mutable[0] = "rusak"
      expect(renderFooter(args, 80)[0]).toBe(plain)
      // MINICODE_COLOR=0 mengunci level 0: kunci cache dan isi footer tetap.
      const savedColor = process.env.COLORTERM
      const savedNoColor = process.env.NO_COLOR
      process.env.COLORTERM = "truecolor"
      process.env.NO_COLOR = "1"
      try {
        const afterEnv = renderFooter(args, 80)[0]!
        expect(afterEnv).toBe(plain)
        expect(afterEnv).not.toContain("\x1b[")
      } finally {
        if (savedNoColor === undefined) delete process.env.NO_COLOR
        else process.env.NO_COLOR = savedNoColor
        if (savedColor === undefined) delete process.env.COLORTERM
        else process.env.COLORTERM = savedColor
      }
      expect(renderFooter(args, 80)[0]).toBe(plain)
    })
  })

  test("cache footer invalidates on runningExtra, queuedCount, retryBadge, and scrollBadge", () => {
    withMono(() => {
      tty = installFakeTty({ columns: 100 })
      const base = {
        mode: "auto",
        workMode: "EXECUTE",
        model: "m1",
        cwd: "D:\\Github\\minicode",
        context: "42%",
        timer: "00.00.12",
      }
      const f0 = renderFooter(base, 100)[0]!
      const fExtra = renderFooter({ ...base, runningExtra: 2 }, 100)[0]!
      const fQueue = renderFooter({ ...base, queuedCount: 1 }, 100)[0]!
      const fRetry = renderFooter({ ...base, retryBadge: "Retrying 2/10 · 3s" }, 100)[0]!
      const fScroll = renderFooter({ ...base, scrollBadge: "↓ 4 new · PgDn" }, 100)[0]!
      expect(fExtra).toContain("+2 running")
      expect(fQueue).toContain("1 queued")
      expect(fRetry).toContain("Retrying 2/10 · 3s")
      expect(fRetry).toContain("00.00.12")
      expect(fRetry).toContain("42%")
      expect(fScroll).toContain("↓ 4 new · PgDn")
      expect(fScroll).toContain("00.00.12")
      expect(fScroll).not.toBe(f0)
    })
  })

  test("U3 terminal sempit: memprioritaskan badge operasional daripada metrik angka", () => {
    withMono(() => {
      tty = installFakeTty({ columns: 48 })
      const [status] = renderFooter(
        {
          mode: "ask",
          workMode: "DISCUSS",
          model: "very-long-provider::very-long-model-name",
          cwd: "D:\\Github\\minicode\\deep\\path",
          context: "42% · 84k",
          metrics: "$0.12",
          scrollBadge: "↓ 3 new · PgDn",
        },
        48,
      )
      const plain = stripAnsi(status!)
      expect(plain).toContain("↓ 3 new · PgDn")
      expect(displayWidth(plain)).toBeLessThanOrEqual(47)
    })
  })

  test("timer aktif memakai gray untuk segmen pasif agar kontras setara timer diam", () => {
    const prevColorterm = process.env.COLORTERM
    const prevNoColor = process.env.NO_COLOR
    const prevMinicodeColor = process.env.MINICODE_COLOR
    process.env.COLORTERM = "truecolor"
    delete process.env.NO_COLOR
    delete process.env.MINICODE_COLOR
    try {
      tty = installFakeTty({ columns: 100 })
      const [status] = renderFooter(
        {
          mode: "auto",
          workMode: "DISCUSS",
          model: "test-model",
          cwd: "/workspace",
          timer: "00.00.12",
          timerActive: true,
          timerHighlight: "seconds",
        },
        100,
      )
      expect(status).toContain(
        `${c.gray("00")}${c.gray(".")}${c.gray("00")}${c.gray(".")}${c.white("12")}`,
      )
    } finally {
      if (prevColorterm === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = prevColorterm
      if (prevNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = prevNoColor
      if (prevMinicodeColor === undefined) delete process.env.MINICODE_COLOR
      else process.env.MINICODE_COLOR = prevMinicodeColor
    }
  })
})
