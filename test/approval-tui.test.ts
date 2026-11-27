// Approval sebagai warga TUI: blok tercatat di transkrip + repaint sebelum
// menjawab; keputusan tercatat. Tanpa sink = tulis langsung warisan.
import { afterEach, describe, expect, test } from "bun:test"
import { promptAsk, promptAskText } from "../src/ui/approval/prompt.ts"
import { glyphs, stripAnsi } from "../src/ui/render/theme.ts"
import { tSystem } from "../src/ui/render/tool-label.ts"
import { displayWidth } from "../src/ui/render/width.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS } from "../src/ui/screens/form.ts"
import { windowWidth } from "../src/ui/screens/window.ts"
import { getApprovalSink, setApprovalSink } from "../src/ui/tui/transcript.ts"
import { installFakeTty, KEY } from "./helpers/tui-harness.ts"

let tty: ReturnType<typeof installFakeTty> | null = null
afterEach(() => {
  tty?.restore()
  tty = null
  setApprovalSink(null)
})

describe("approval sink TUI", () => {
  test("jawaban y → allow + blok dan keputusan tercatat + repaint", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    let repaints = 0
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => repaints++,
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({ name: "bash", args: { command: "rm -rf /" } })
    await tty.ready()
    await tty.send("y")
    await tty.send(KEY.enter)
    expect(await p).toBe("allow")
    expect(blocks.length).toBe(2)
    const q = stripAnsi(blocks[0]!.join("\n"))
    expect(q).toContain("Approval required")
    expect(q).toContain("bash")
    expect(q).toContain("rm -rf /")
    expect(stripAnsi(blocks[1]!.join("\n"))).toContain("allow")
    // Repaint sebelum menjawab + sesudah keputusan.
    expect(repaints).toBeGreaterThanOrEqual(2)
    expect(getApprovalSink()).not.toBeNull()
  })
  test("Esc → deny (fail-closed)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({ name: "write_file", args: { path: "a.ts" } })
    await tty.ready()
    await tty.send(KEY.esc, 90)
    expect(await p).toBe("deny")
    expect(stripAnsi(blocks.flat().join("\n"))).toContain("deny")
  })
  test("tanpa sink = tulis langsung ke stdout (warisan)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    expect(getApprovalSink()).toBeNull()
    const p = promptAsk({ name: "bash", args: {} })
    await tty.ready()
    await tty.send("a")
    await tty.send(KEY.enter)
    expect(await p).toBe("always")
    expect(stripAnsi(tty.all())).toContain("Approval required")
  })
  test("promptAskText tercatat + jawabannya (dipotong)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAskText("Apa warna langit?", ["biru", "hijau"])
    await tty.ready()
    await tty.send("biru")
    await tty.send(KEY.enter)
    expect(await p).toBe("biru")
    const all = stripAnsi(blocks.flat().join("\n"))
    expect(all).toContain("Agent asks")
    expect(all).toContain("biru")
  })
  test("App dibekukan selama menunggu jawaban (anti double-handling)", async () => {
    // Gagal-di-kode-lama: listener App + repaint live berlomba dengan askLine
    // — prompt tak terlihat, user mengetik buta.
    tty = installFakeTty({ columns: 80, rows: 24 })
    let suspended = 0
    let resumed = 0
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => suspended++,
      resume: () => resumed++,
    })
    const p = promptAsk({ name: "bash", args: {} })
    await tty.ready()
    // Sinkron: suspend dipanggil SEBELUM askLine menunggu jawaban.
    await tty.waitForOutput(() => suspended > 0)
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    expect(suspended).toBe(1)
    expect(resumed).toBe(1)
  })
  test("jawaban dwibahasa: ya/tidak/selalu diterima", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    for (const [ans, want] of [
      ["ya", "allow"],
      ["tidak", "deny"],
      ["t", "deny"],
      ["selalu", "always"],
      ["s", "always"],
    ] as const) {
      const p = promptAsk({ name: "bash", args: {} })
      await tty.ready()
      await tty.send(ans)
      await tty.send(KEY.enter)
      expect(await p, ans).toBe(want)
    }
  })
  test("tanpa sink + stdout pipe → deny tanpa tanya (F-09, anti-cemar pipe)", async () => {
    // stdin TTY (user bisa jawab) tapi stdout di-pipe: prompt tak terlihat dan
    // askLine/blok mencemari output program → fail-closed deny.
    tty = installFakeTty({ columns: 80, rows: 24 })
    expect(getApprovalSink()).toBeNull()
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    try {
      await expect(promptAsk({ name: "bash", args: { command: "ls" } })).resolves.toBe("deny")
      await expect(promptAskText("apa ini?")).resolves.toBeNull()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
    }
  })
  test("riskTier + diffPreview dirender di kartu approval (F-APPROVAL-1)", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    const blocks: string[][] = []
    setApprovalSink({
      pushBlock: (lines) => blocks.push(lines),
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    const p = promptAsk({
      name: "delete_file",
      args: { path: "secret.txt" },
      riskTier: "EXTERNAL_IRREVERSIBLE",
      diffPreview: "- secret.txt",
    })
    await tty.ready()
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    const q = stripAnsi(blocks[0]!.join("\n"))
    expect(q).toContain("Effect:")
    expect(q).toContain("irreversible external effect")
    expect(q).toContain("Diff:")
    expect(q).toContain("- secret.txt")
  })
  test("modal: paintRegion melukis kotak (bukan tulis inline) + clearRegion saat selesai", async () => {
    tty = installFakeTty({ columns: 80, rows: 24 })
    let painted = 0
    let cleared = 0
    let paintedText = ""
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => {
        painted++
        paintedText = lines.join("\n")
      },
      clearRegion: () => cleared++,
    })
    const p = promptAsk({ name: "bash", args: { command: "rm -rf /" } })
    await tty.ready()
    await tty.waitForOutput(() => painted >= 1)
    // Kotak dialog ter-render (konten tool tampil), dan bukan tulis stdout polos.
    expect(painted).toBeGreaterThanOrEqual(1)
    expect(stripAnsi(paintedText)).toContain("bash")
    expect(stripAnsi(paintedText)).toContain("rm -rf /")
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
    expect(cleared).toBe(1)
  })
})

describe("approval: navigasi daftar opsi (AUD-005, kontrak I25)", () => {
  // I25 mewajibkan `↑↓`/home/end di SEMUA permukaan berdaftar. Sebelumnya tiga
  // opsi approval hanya bisa DIKETIK (y/a/n) walau tampil sebagai daftar.
  const setupSink = () => {
    const paints: string[] = []
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => paints.push(lines.join("\n")),
      clearRegion: () => {},
    })
    return paints
  }

  test("↓ memilih Always, ↑ kembali ke Allow", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paints = setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    // Sorotan awal di opsi pertama (allow).
    expect(stripAnsi(paints.at(-1) ?? "")).toContain("Allow once")
    await tty.send(KEY.down)
    await tty.send(KEY.enter)
    expect(await p).toBe("always")
  })

  test("End memilih opsi terakhir (Deny) lalu Enter", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send(KEY.end)
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
  })

  test("tanpa canAlways daftar hanya dua opsi; End = deny, bukan always", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paints = setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: false })
    await tty.ready()
    // Opsi Always tidak boleh muncul sama sekali.
    expect(stripAnsi(paints.at(-1) ?? "")).not.toContain("Always")
    await tty.send(KEY.end)
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
  })

  test("klik-cepat tetap bekerja: `a` langsung selalu-izinkan", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("a")
    expect(await p).toBe("always")
  })

  test("`s` (selalu) memilih Always, `t` (tidak) memilih Deny", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p1 = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("s")
    expect(await p1).toBe("always")
    tty.restore()
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p2 = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send("t")
    expect(await p2).toBe("deny")
  })

  test("Esc = deny (batal hanya tool ini, bukan abort turn)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.send(KEY.esc)
    expect(await p).toBe("deny")
  })

  test("kursor diparkir di baris opsi aktif (modal tidak membiarkan kursor liar)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const moves: { row: number; col: number }[] = []
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: () => {},
      moveCursor: (row, col) => moves.push({ row, col }),
      clearRegion: () => {},
    })
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    await tty.waitForOutput(() => moves.length > 0)
    expect(moves.at(-1)!.row).toBeGreaterThan(0)
    expect(moves.at(-1)!.col).toBeGreaterThan(0)
    await tty.send("n")
    await tty.send(KEY.enter)
    expect(await p).toBe("deny")
  })

  test("sinonim `s` tanpa opsi Always diabaikan (bukan deny diam-diam)", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    setupSink()
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: false })
    await tty.ready()
    await tty.send("s") // quickMap.s = -1 → harus diabaikan
    await tty.send(KEY.enter)
    expect(await p).toBe("allow")
  })
})

describe("ask_user modal: hint & echo", () => {
  test("footer menampilkan Enter submit / Esc cancel", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paints: string[] = []
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => paints.push(stripAnsi(lines.join("\n"))),
      clearRegion: () => {},
    })
    const p = promptAskText("Apa warna langit?", ["biru"])
    await tty.ready()
    const frame = paints.at(-1) ?? ""
    expect(frame).toMatch(/Enter (submit|kirim)/)
    expect(frame).toContain("Esc")
    expect(frame).not.toMatch(/Esc (cancel|batal)/)
    await tty.send("biru")
    await tty.send(KEY.enter)
    expect(await p).toBe("biru")
  })

  test("resize + wheel navigasi + batas minimum layar (<10 baris) di Layer 2", async () => {
    tty = installFakeTty({ columns: 100, rows: 24 })
    const paintedWidths: number[] = []
    let latest = ""
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => {
        latest = stripAnsi(lines.join("\n"))
        const border = lines[0]?.trim() ?? ""
        if (border) paintedWidths.push(displayWidth(stripAnsi(border)))
      },
      clearRegion: () => {},
    })
    const p = promptAsk({ name: "bash", args: { command: "ls" }, canAlways: true })
    await tty.ready()
    expect(paintedWidths.at(-1)).toBe(windowWidth(100))

    // Resize menyempit -> modal repainted pada lebar baru.
    tty.resize(50, 16)
    await tty.send("", 40)
    expect(paintedWidths.at(-1)).toBe(windowWidth(50))

    // Layar menciut di bawah 10 baris -> tampilkan peringatan dan tahan Enter buta.
    tty.resize(50, 8)
    await tty.send("", 40)
    expect(latest.toLowerCase()).toContain(tSystem("msg.tooSmall").toLowerCase())
    await tty.send(KEY.enter, 30) // harus tetap belum resolve!

    // Dibesarkan kembali -> modal penuh kembali, wheel memilih Always + Enter.
    tty.resize(80, 24)
    await tty.send("", 40)
    await tty.send(KEY.mouseWheelDownSgr, 20)
    await tty.send(KEY.enter)
    expect(await p).toBe("always")
  })

  test("MINICODE_ASCII=1 memakai glyphs.arrow pada echo keputusan & jawaban", async () => {
    // Tetapkan env SETELAH installFakeTty agar harness tidak menyimpan "1" ke
    // snapshot ambient lalu memulihkannya untuk file test berikutnya.
    tty = installFakeTty({ columns: 80, rows: 24 })
    const prev = process.env.MINICODE_ASCII
    process.env.MINICODE_ASCII = "1"
    try {
      const blocks: string[][] = []
      setApprovalSink({
        pushBlock: (lines) => blocks.push(lines),
        repaint: () => {},
        suspend: () => {},
        resume: () => {},
      })
      const p1 = promptAsk({ name: "bash", args: { command: "ls" } })
      await tty.ready()
      await tty.send("n")
      await tty.send(KEY.enter)
      await p1
      const p2 = promptAskText("Pertanyaan?")
      await tty.ready()
      await tty.send("ok")
      await tty.send(KEY.enter)
      await p2
      const echoText = stripAnsi(blocks.flat().join("\n"))
      expect(echoText).toContain(glyphs.arrow)
      expect(echoText).not.toContain("→")
    } finally {
      if (prev === undefined) delete process.env.MINICODE_ASCII
      else process.env.MINICODE_ASCII = prev
    }
  })
})

describe("M1: idle guard approval di-reset tiap keypress", () => {
  test("tombol tak dikenal (tak mengubah pilihan) tetap mereset timer idle", async () => {
    // Idle timer form = 80 dtk + 10 dtk (waktu nyata terlalu lama untuk test).
    // Hanya timer dengan delay itu yang kita tangkap; timer lain (flush Esc)
    // tetap memakai setTimeout asli.
    type Captured = {
      id: ReturnType<typeof setTimeout>
      fn: () => void
      delay: number
      cleared: boolean
    }
    const targets = new Set([IDLE_WARN_MS, IDLE_CANCEL_MS])
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    let caps: Captured[] = []
    let seq = 1
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms != null && targets.has(ms)) {
        const id = seq++ as unknown as ReturnType<typeof setTimeout>
        caps.push({ id, fn: () => fn(...args), delay: ms, cleared: false })
        return id
      }
      return realSet(fn as never, ms, ...(args as []))
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      const hit = caps.find((x) => x.id === id)
      if (hit) {
        hit.cleared = true
        return
      }
      realClear(id)
    }) as typeof clearTimeout
    const active = (delay: number) => caps.filter((x) => !x.cleared && x.delay === delay).length
    const fire = (delay: number) => {
      const t = caps.find((x) => !x.cleared && x.delay === delay)
      if (!t) throw new Error(`tidak ada timer idle aktif ${delay}`)
      t.cleared = true
      t.fn()
    }

    tty = installFakeTty({ columns: 80, rows: 24 })
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
    })
    let p!: Promise<string | null>
    try {
      p = promptAsk({ name: "bash", args: {} })
      await tty.ready()
      // Waktu berjalan 80 dtk → warning, masuk fase batal 10 dtk.
      fire(IDLE_WARN_MS)
      expect(active(IDLE_CANCEL_MS)).toBe(1)
      // `q` bukan quick key dan tak mengubah seleksi: changed = false.
      // Kode lama tak memanggil idle.reset() di sini → timer batal tetap aktif.
      await tty.send("q")
      expect(active(IDLE_CANCEL_MS)).toBe(0)
      expect(active(IDLE_WARN_MS)).toBe(1)
      // Selesaikan modal normal supaya tak menggantung lintas test.
      await tty.send("y")
      expect(await p).toBe("allow")
    } finally {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      caps = []
    }
  })

  test("ask_user dengan options[]: navigasi ↑↓ memilih opsi, ketik bebas tetap bekerja", async () => {
    tty = installFakeTty({ columns: 90, rows: 24 })
    const paints: string[] = []
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => paints.push(stripAnsi(lines.join("\n"))),
      clearRegion: () => {},
    })
    const p1 = promptAskText("Pilih warna:", ["merah", "biru", "hijau"])
    await tty.ready()
    expect(paints.at(-1)).toContain("move")
    await tty.send(KEY.down)
    await tty.send(KEY.down)
    await tty.send(KEY.enter)
    expect(await p1).toBe("biru")

    // Pilih dengan panah lalu mengetik teks baru beralih kembali ke input bebas.
    const p2 = promptAskText("Pilih lagi:", ["merah", "biru"])
    await tty.ready()
    await tty.send(KEY.down)
    await tty.send("ungu")
    await tty.send(KEY.enter)
    expect(await p2).toBe("ungu")
  })

  test("ask_user panjang di-wrap rapi tanpa menggeser input box keluar dialog", async () => {
    tty = installFakeTty({ columns: 50, rows: 16 })
    const paints: string[] = []
    let lastCursor: { row: number; col: number } | null = null
    setApprovalSink({
      pushBlock: () => {},
      repaint: () => {},
      suspend: () => {},
      resume: () => {},
      paintRegion: (lines) => paints.push(stripAnsi(lines.join("\n"))),
      clearRegion: () => {},
      moveCursor: (row, col) => {
        lastCursor = { row, col }
      },
    })
    const q = "Apakah Anda yakin ingin melanjutkan migrasi konfigurasi produksi sekarang?"
    const p = promptAskText(q)
    await tty.ready()
    await tty.send("ya")
    expect(paints.at(-1)).toContain("> ya")
    expect(lastCursor).not.toBeNull()
    await tty.send(KEY.enter)
    expect(await p).toBe("ya")
  })
})
