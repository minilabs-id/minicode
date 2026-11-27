// tool-label.ts — helper label aktivitas tool MURNI.
//
// Kontrak yang diuji:
// - bahasa mengikuti SISTEM/OS (`systemLocale()`), BUKAN sesi /lang;
// - peta ~12 tool umum → kunci `activity.tool.*` di en.ts DAN id.ts;
// - delegate_task langsung menampilkan label peran (intent/label/summary/target) tanpa awalan;
// - fallback nama asli untuk tool tak dikenal;
// - sanitasi + potong 40 kolom; tanpa I/O.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { en } from "../src/ui/i18n/en.ts"
import { id } from "../src/ui/i18n/id.ts"
import { resetLocaleState, setSessionLocale } from "../src/ui/i18n/locale.ts"
import {
  __setSystemLocaleForTest,
  humanToolLabel,
  systemLocale,
  tSystem,
} from "../src/ui/render/tool-label.ts"
import { displayWidth } from "../src/ui/render/width.ts"

afterEach(() => {
  resetLocaleState()
  __setSystemLocaleForTest(null)
})

const dict = () => (systemLocale() === "id" ? id : en)

describe("systemLocale()", () => {
  test("mengembalikan id/en dan stabil (lazy-cache)", () => {
    const first = systemLocale()
    expect(first === "id" || first === "en").toBe(true)
    expect(systemLocale()).toBe(first)
  })
})

describe("cabang locale SISTEM (nilai konkret, bukan turunan systemLocale)", () => {
  test("en: label tool & toast memakai string Inggris", () => {
    __setSystemLocaleForTest("en")
    expect(systemLocale()).toBe("en")
    expect(humanToolLabel("read_file")).toBe("read file")
    expect(humanToolLabel("bash")).toBe("run command")
    expect(tSystem("msg.copied")).toBe("Copied")
    expect(tSystem("msg.tooSmall")).toBe("Terminal too small — enlarge window")
  })

  test("id: label tool & toast memakai string Indonesia", () => {
    __setSystemLocaleForTest("id")
    expect(systemLocale()).toBe("id")
    expect(humanToolLabel("read_file")).toBe("baca berkas")
    expect(humanToolLabel("bash")).toBe("jalankan perintah")
    expect(tSystem("msg.copied")).toBe("Tersalin")
    expect(tSystem("msg.tooSmall")).toBe("Layar terlalu kecil — besarkan jendela")
  })

  test("ganti /lang tak mengubah cabang OS yang dipaksa", () => {
    __setSystemLocaleForTest("id")
    setSessionLocale("en")
    expect(humanToolLabel("read_file")).toBe("baca berkas")
    expect(tSystem("msg.copied")).toBe("Tersalin")
  })
})

describe("tSystem()", () => {
  test("toast/kwitansi mengikuti kamus bahasa SISTEM + interpolasi", () => {
    expect(tSystem("msg.copied")).toBe(dict()["msg.copied"])
    expect(tSystem("msg.retry", { n: 2, total: 6, s: 7 })).toBe(
      dict()["msg.retry"].replace("{n}", "2").replace("{total}", "6").replace("{s}", "7"),
    )
    expect(tSystem("msg.scheduler", { line: "cycle 3" })).toBe(
      dict()["msg.scheduler"].replace("{line}", "cycle 3"),
    )
  })

  test("tak berubah saat sesi /lang diganti (jalur narasi tetap terpisah)", () => {
    const before = tSystem("msg.staleWriter")
    setSessionLocale(systemLocale() === "id" ? "en" : "id")
    expect(tSystem("msg.staleWriter")).toBe(before)
  })

  test("param tak dikenal dibiarkan, bukan crash", () => {
    expect(tSystem("msg.retry", {})).toBe(dict()["msg.retry"])
  })

  test("nilai msg.* berbeda di en/id (bukan netral-locale)", () => {
    for (const k of Object.keys(en).filter((k) => k.startsWith("msg.")) as (keyof typeof en)[]) {
      expect(id[k]).not.toBe(en[k])
    }
  })
})

describe("humanToolLabel()", () => {
  test("tool umum memakai kamus bahasa SISTEM", () => {
    expect(humanToolLabel("read_file")).toBe(dict()["activity.tool.readFile"])
    expect(humanToolLabel("bash")).toBe(dict()["activity.tool.bash"])
    expect(humanToolLabel("grep")).toBe(dict()["activity.tool.grep"])
    expect(humanToolLabel("delegate_task")).toBe(dict()["activity.tool.delegate"])
    expect(humanToolLabel("todo_write")).toBe(dict()["activity.tool.plan"])
  })

  test("label tak berubah saat sesi /lang diganti (jalur narasi tetap terpisah)", () => {
    const before = humanToolLabel("read_file")
    setSessionLocale(systemLocale() === "id" ? "en" : "id")
    expect(humanToolLabel("read_file")).toBe(before)
    expect(humanToolLabel("bash")).toBe(dict()["activity.tool.bash"])
  })

  test("tool tak dikenal jatuh ke nama asli (disanitasi)", () => {
    expect(humanToolLabel("mystery_tool")).toBe("mystery_tool")
    expect(humanToolLabel("ev\x1b[2Il")).not.toContain("\x1b[2J")
  })

  test("delegate_task langsung menampilkan peran (intent/label/summary/target) tanpa awalan", () => {
    expect(humanToolLabel("delegate_task", { label: "audit-fns" })).toBe("audit-fns")
    expect(humanToolLabel("delegate_task", { summary: "selesai" })).toBe("selesai")
    expect(humanToolLabel("delegate_task", { target: "src/app.ts" })).toBe("src/app.ts")
    // Prioritas: intent > label > summary > target.
    expect(humanToolLabel("delegate_task", { label: "L", summary: "S", target: "T" })).toBe("L")
    // Awalan berulang "Delegasi tugas"/"Subagent" ikut dipangkas agar kolom hemat.
    expect(humanToolLabel("delegate_task", { intent: "Delegasi tugas Auditor UI" })).toBe(
      "Auditor UI",
    )
    expect(humanToolLabel("delegate_task", { intent: "Subagent Pencari bug" })).toBe("Pencari bug")
  })

  test("identitas child tak terpercaya disanitasi sebelum disisipkan", () => {
    const out = humanToolLabel("delegate_task", { label: "evil\x1b[2J\nname" })
    expect(out).not.toContain("\x1b[2J")
    expect(out).not.toContain("\n")
  })

  test("keluaran dipotong maksimal 40 kolom", () => {
    const out = humanToolLabel("delegate_task", { label: "x".repeat(100) })
    expect(displayWidth(out)).toBeLessThanOrEqual(40)
    expect(out).toContain("…")
  })

  test("murni: tak ada tulisan ke stdout/stderr", () => {
    const src = readFileSync(new URL("../src/ui/render/tool-label.ts", import.meta.url), "utf8")
    expect(src).not.toContain("process.stdout")
    expect(src).not.toContain("process.stderr")
  })
})
