// Audit-fix: lipat chatter kompaksi di transkrip jadi SATU baris ringkas.
//
// Dua lapis yang diuji:
//  1. Klasifikasi murni (microcompact.ts + cermin tampilan di transcript.ts) —
//     tool baca aman diulang, tool stateful TIDAK boleh disuruh diulang.
//  2. Rendering transkrip: deretan sentinel jadi satu baris, margin tetap di
//     sourcePrefix (seleksi/copy tak membawa spasi chrome).
import { describe, expect, test } from "bun:test"
import { replayIsUnsafe } from "../src/policy/microcompact.ts"
import {
  type CompactionTrimItem,
  compactionTrimIsStateful,
  compactionTrimSummary,
  parseCompactionTrimLine,
  Transcript,
} from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

function setup() {
  const bus = createFakeBus()
  const t = new Transcript(bus as never)
  return { bus, t }
}

/** Reproduksi bentuk sentinel asli dari microcompact.ts (model-facing). */
function sentinel(tool: string, chars: number, failed = false): string {
  const hint = compactionTrimIsStateful(tool)
    ? "JANGAN jalankan ulang: tool ini dapat mengubah state (berkas/lingkungan), verifikasi state lebih dulu."
    : "Jalankan ulang tool ini bila isinya masih dibutuhkan."
  return `[hasil tool lama dipangkas: ${tool} ${chars} char${failed ? ", gagal" : ""}. ${hint}]`
}

describe("klasifikasi murni tool kompaksi", () => {
  test("replayIsUnsafe: tool baca aman, tool mutasi/unknown tidak", () => {
    for (const name of [
      "read_file",
      "read_image",
      "grep",
      "glob",
      "git_status",
      "git_diff",
      "git_log",
    ]) {
      expect(replayIsUnsafe(name)).toBe(false)
    }
    for (const name of [
      "bash",
      "code_run",
      "write_file",
      "edit",
      "apply_patch",
      "delete_file",
      "move_file",
      "delegate_task",
    ]) {
      expect(replayIsUnsafe(name)).toBe(true)
    }
    // `todo_write` masuk NEVER_TRIM di policy, jadi tak pernah menghasilkan
    // sentinel; klasifikasinya di policy berbeda dengan cermin tampilan (yang
    // tetap memperlakukannya sebagai stateful).
    expect(replayIsUnsafe("todo_write")).toBe(false)
    // Fail-closed: lupa daftar / nama tak dikenal bukan izin mengulang.
    expect(replayIsUnsafe("unknown_tool")).toBe(true)
    expect(replayIsUnsafe(undefined)).toBe(true)
  })

  test("cermin tampilan menambah ls/stat sebagai baca dan tetap fail-closed", () => {
    for (const name of [
      "read_file",
      "grep",
      "glob",
      "ls",
      "stat",
      "read_image",
      "git_status",
      "git_diff",
      "git_log",
    ]) {
      expect(compactionTrimIsStateful(name)).toBe(false)
    }
    for (const name of ["bash", "write_file", "delegate_task", "todo_write", "mcp_custom"]) {
      expect(compactionTrimIsStateful(name)).toBe(true)
    }
  })

  test("parseCompactionTrimLine hanya menerima sentinel, tahan SGR + margin", () => {
    expect(parseCompactionTrimLine(sentinel("read_file", 5469))).toEqual({
      tool: "read_file",
      chars: 5469,
    })
    expect(parseCompactionTrimLine(`   \x1b[2m${sentinel("bash", 2524, true)}\x1b[0m`)).toEqual({
      tool: "bash",
      chars: 2524,
    })
    expect(parseCompactionTrimLine("baris biasa")).toBeNull()
    expect(parseCompactionTrimLine("[hasil tool lama dipangkas: read_file abc char]")).toBeNull()
  })

  test("ringkasan: read-only boleh diulang, stateful TIDAK pernah disuruh ulang", () => {
    const readonlyItems: CompactionTrimItem[] = [
      { tool: "read_file", chars: 20_000 },
      { tool: "grep", chars: 15_000 },
      { tool: "git_diff", chars: 7_000 },
    ]
    const safe = compactionTrimSummary(readonlyItems)
    expect(safe).toContain("3 tool results dipangkas (42k char)")
    expect(safe).toContain("jalankan ulang bila perlu")
    expect(safe).not.toContain("JANGAN")

    const mixed = compactionTrimSummary([...readonlyItems, { tool: "bash", chars: 1_000 }])
    expect(mixed).toContain("4 tool results dipangkas (43k char)")
    expect(mixed).toContain("1 tool stateful")
    expect(mixed).toContain("JANGAN jalankan ulang")
    expect(mixed).toContain("verifikasi state dulu")
    // Kontradiksi paling berbahaya: jangan pernah menggabungkan keduanya.
    expect(mixed).not.toContain("jalankan ulang bila perlu")
  })
})

describe("Transcript: lipatan sentinel kompaksi", () => {
  test("deretan sentinel jadi SATU baris, bukan dinding per-tool", () => {
    const { t } = setup()
    t.pushInfo([sentinel("read_file", 5469), sentinel("bash", 2524), sentinel("grep", 1000)])
    // SATU baris logis (size=1); lebar 120 dipakai agar tak ter-wrap saat
    // memeriksa isi baris visual.
    expect(t.size()).toBe(1)
    const lines = t.view(120, 8, 0).filter((line) => line.trim() !== "")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("3 tool results dipangkas")
    expect(lines[0]).toContain("JANGAN jalankan ulang")
    expect(t.view(120, 8, 0).join("\n")).not.toContain("[hasil tool lama dipangkas")
  })

  test("batch terpisah dalam satu event tetap menimpa baris yang sama", () => {
    const { t } = setup()
    t.pushInfo([sentinel("read_file", 1000)])
    expect(t.size()).toBe(1)
    t.pushInfo([sentinel("grep", 2000)])
    expect(t.size()).toBe(1)
    const line = t.view(80, 4, 0).find((l) => l.includes("tool results"))!
    expect(line).toContain("2 tool results dipangkas (3k char)")
  })

  test("baris biasa memisahkan event: ringkasan baru dibuat, bukan digabung", () => {
    const { t } = setup()
    t.pushInfo([sentinel("read_file", 1000)])
    t.pushInfo(["catatan biasa"])
    t.pushInfo([sentinel("grep", 2000)])
    const lines = t.view(80, 8, 0).filter((l) => l.trim() !== "")
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l.includes("tool results"))).toHaveLength(2)
    expect(lines.some((l) => l.includes("catatan biasa"))).toBe(true)
  })

  test("push() satu per satu juga terlipat (jalur error/notice)", () => {
    const { t } = setup()
    t.push(sentinel("read_file", 1000))
    t.push(sentinel("edit", 1000))
    expect(t.size()).toBe(1)
    const line = t.view(120, 4, 0).find((l) => l.includes("tool results"))!
    expect(line).toContain("2 tool results dipangkas")
    expect(line).toContain("JANGAN jalankan ulang")
  })

  test("pushCompactionTrims memakai jalur yang sama dengan pushInfo", () => {
    const { t } = setup()
    t.pushCompactionTrims([sentinel("read_file", 1000), sentinel("ls", 1000)])
    const lines = t.view(80, 8, 0).filter((l) => l.trim() !== "")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("2 tool results dipangkas (2k char)")
    expect(lines[0]).toContain("jalankan ulang bila perlu")
  })

  test("margin tetap sourcePrefix: seleksi/copy tak membawa spasi chrome", () => {
    const { t } = setup()
    const expected = "1 tool results dipangkas (1k char) · jalankan ulang bila perlu"
    t.pushInfo([sentinel("read_file", 1000)])
    const row = t.viewport(80, 4, 0).rows.find((r) => r.text.includes("tool results"))!
    expect(row.selectable).toBe(true)
    expect(row.sourceId).toBeGreaterThanOrEqual(0)
    // v0.43: margin 3 milik FRAME, bukan spasi pada teks — kolom 0 adalah
    // karakter pertama baris ini, jadi seleksi mulai dari kolom 0.
    const start = t.pointAt(row, 0)!
    const end = t.pointAt(row, 0 + expected.length)!
    expect(t.selectionText(start, end)).toBe(expected)
  })
})
