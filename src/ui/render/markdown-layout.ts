// Layout teks & spasi presentasi asisten (dibagi bersama TUI Transcript dan
// printer linier agar margin kiri, hanging indent multi-tingkat, dan jeda antar
// poin paragraf selalu konsisten).

import { stripSgr } from "./sanitize.ts"
import { displayWidth } from "./width.ts"

export interface FenceMatch {
  char: string
  len: number
  lang: string
}

/**
 * Parse satu baris fence markdown (``` atau ~~~) → info pembuka, atau null.
 */
export function parseFence(line: string): FenceMatch | null {
  // v0.33: tag bahasa boleh memuat `#` (`c#`, `f#`) — dulu fence itu tak
  // dikenali sama sekali sehingga isi kodenya ikut di-render markdown.
  const m = /^\s*(```+|~~~+)([^\s`]+)?(?:\s+[^\r\n]*)?\s*$/.exec(line)
  if (!m) return null
  return { char: m[1]![0]!, len: m[1]!.length, lang: m[2] ?? "" }
}

/** Margin kiri standar area teks asisten agar lega dari tepi kiri terminal. */
export const ASSISTANT_LEFT_MARGIN = 3

/** Margin kiri adaptif: lega (3 kolom) di terminal normal, menyusut di layar sempit. */
export function effectiveAssistantMargin(width: number): number {
  if (width >= 36) return ASSISTANT_LEFT_MARGIN
  if (width >= 20) return 2
  if (width >= 14) return 1
  return 0
}

/**
 * Lebar isi minimum yang wajib disisakan saat mengitung hanging indent agar
 * list/paragraf bersarang dalam di terminal sempit tak memeras teks menjadi 1–2 huruf.
 */
function minReadableContentCols(width: number): number {
  return Math.min(16, Math.max(6, Math.floor(width / 3)))
}

/**
 * Hitung indentasi gantung (kolom spasi pada baris lanjutan wrap) untuk baris
 * teks yang SUDAH memuat margin luarnya.
 *
 * Contoh (margin = 3):
 * - `- item panjang` -> continuation 5 spasi (sejajar tepat di bawah huruf i)
 * - `1. item panjang` -> continuation 6 spasi
 * - `   - sub-poin panjang` -> continuation 8 spasi (tak bablas ke level induk/kolom 0)
 * - `   Paragraf berindentasi` -> continuation 6 spasi (tetap di tingkat paragraf)
 * - `> kutipan panjang` -> continuation 5 spasi (tetap di dalam kutipan)
 */
export function computeHangingIndent(line: string, width: number): string {
  if (width <= 0) return ""
  const plain = stripSgr(line)
  if (plain.trim() === "") return ""

  const maxHangCols = Math.max(0, width - minReadableContentCols(width))
  let desiredCols = 0

  // Heading: tetap sejajar di indentasi awalan barisnya.
  const heading = /^(\s*)#{1,6}\s+/.exec(plain)
  if (heading) {
    desiredCols = displayWidth(heading[1]!)
  } else {
    // Daftar (bullet / bernomor) beserta checkbox opsional `- [x] `:
    // lanjutan teks sejajar di kolom isi, bukan di bawah marker/angka.
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(plain)
    if (listItem) {
      desiredCols =
        displayWidth(listItem[1]!) +
        displayWidth(listItem[2]!) +
        1 +
        displayWidth(listItem[3] ?? "")
    } else {
      // Kutipan bersarang (`> `, `> > `, `  > `): teks lanjutan sejajar di dalam kutipan.
      const blockquote = /^(\s*(?:>\s*)+)/.exec(plain)
      if (blockquote) {
        desiredCols = displayWidth(blockquote[1]!)
      } else {
        // Paragraf biasa atau paragraf berindentasi multi-tingkat:
        // pertahankan seluruh spasi awal sebagai batas kiri tingkatnya.
        const leading = /^(\s+)/.exec(plain)
        if (leading) desiredCols = displayWidth(leading[1]!)
      }
    }
  }

  const clampedCols = Math.min(desiredCols, maxHangCols)
  return clampedCols > 0 ? " ".repeat(clampedCols) : ""
}

export interface AssistantLineLayout {
  firstLead: string
  hangingIndent: string
}

/** Hitung prefix margin baris-1 & hanging indent wrap untuk satu baris logis asisten. */
export function computeAssistantLineLayout(
  rawLine: string,
  outerMargin: number,
  width: number,
  opts: { inFence?: boolean } = {},
): AssistantLineLayout {
  if (rawLine.trim() === "" || outerMargin <= 0) {
    const hangingIndent = opts.inFence ? "" : computeHangingIndent(rawLine, width)
    return { firstLead: "", hangingIndent }
  }
  const firstLead = " ".repeat(outerMargin)
  if (opts.inFence) {
    // Di dalam code fence, pertahankan margin area teks + opsional indentasi
    // kode secukupnya agar potongan kode panjang tak menempel kembali ke tepi kiri.
    return { firstLead, hangingIndent: firstLead }
  }
  const hangingIndent = computeHangingIndent(`${firstLead}${rawLine}`, width)
  return { firstLead, hangingIndent }
}

export type FlowLineKind = "none" | "heading" | "list" | "blockquote" | "fenceClose" | "prose"

export interface MarkdownFlowState {
  prevKind: FlowLineKind
  topListIndent: number | null
  /** Indent bullet TERAKHIR (bukan hanya indent teratas) — dipakai supaya
   *  dua bullet sibling merapat, tetapi lompat dari sub-poin ke induk tetap
   *  dapat satu baris napas. */
  lastListIndent: number | null
  prevWasBlank: boolean
  hasContent: boolean
}

function classifyNonFenceLine(line: string): {
  kind: "heading" | "list" | "blockquote" | "prose"
  indentCols: number
} {
  if (/^#{1,6}\s/.test(line)) return { kind: "heading", indentCols: 0 }
  const listItem = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line)
  if (listItem) return { kind: "list", indentCols: displayWidth(listItem[1]!) }
  if (/^\s*>/.test(line)) return { kind: "blockquote", indentCols: 0 }
  const leading = /^(\s*)/.exec(line)
  return { kind: "prose", indentCols: displayWidth(leading?.[1] ?? "") }
}

/**
 * Mesin status transisi jeda vertikal antar-blok markdown.
 *
 * Menambahkan 1 baris kosong (bila belum ada) agar setiap poin utama daftar,
 * paragraf pengantar/penutup, heading, blockquote, dan code fence punya ruang
 * napas yang nyaman dibaca tanpa menumpuk jadi dinding teks atau menghasilkan
 * baris kosong ganda berlebihan.
 */
export class MarkdownFlowStepper {
  private state: MarkdownFlowState = {
    prevKind: "none",
    topListIndent: null,
    lastListIndent: null,
    prevWasBlank: false,
    hasContent: false,
  }

  get hasEmitted(): boolean {
    return this.state.hasContent
  }

  clone(): MarkdownFlowStepper {
    const copy = new MarkdownFlowStepper()
    copy.state = { ...this.state }
    return copy
  }

  /** Catat baris kosong; return true bila boleh dicetak (mencegah blank berulang/awal). */
  onBlank(): boolean {
    if (!this.state.hasContent || this.state.prevWasBlank) return false
    // v0.33: di dalam blok daftar, baris kosong antar bullet/sub-poin DITELAN.
    // Model sering menulis `\n\n` antar sub-poin; kalau dicetak, sub-poin jadi
    // seluas poin utama dan hierarkinya hilang. Pemisah poin utama ditambahkan
    // oleh `onLine`, bukan oleh blank mentah dari sumber.
    if (this.state.topListIndent !== null) return false
    this.state.prevWasBlank = true
    return true
  }

  /** Transisi ke pembuka code fence; return true bila perlu baris kosong pemisah sebelumnya. */
  onFenceOpen(): boolean {
    const needSpacer = this.state.hasContent && !this.state.prevWasBlank
    this.state.hasContent = true
    this.state.prevWasBlank = false
    this.state.prevKind = "fenceClose"
    this.state.topListIndent = null
    return needSpacer
  }

  /** Tutup code fence agar baris sesudahnya diberi jeda bersih. */
  onFenceClose(): void {
    this.state.hasContent = true
    this.state.prevWasBlank = false
    this.state.prevKind = "fenceClose"
    this.state.topListIndent = null
  }

  /** Catat tabel blok terpisah (paritas pemisah terhadap paragraf di sekitarnya). */
  onTable(): boolean {
    const needSpacer = this.state.hasContent && !this.state.prevWasBlank
    this.state.hasContent = true
    this.state.prevWasBlank = false
    this.state.prevKind = "fenceClose"
    this.state.topListIndent = null
    return needSpacer
  }

  /** Catat satu baris teks markdown non-kosong di luar fence; return true bila perlu jeda sebelumnya. */
  onLine(line: string): boolean {
    const curr = classifyNonFenceLine(line)
    let needSpacer = false

    if (this.state.hasContent && !this.state.prevWasBlank) {
      if (curr.kind === "heading") {
        needSpacer = true
      } else if (this.state.prevKind === "heading" || this.state.prevKind === "fenceClose") {
        needSpacer = true
      } else if (curr.kind === "blockquote") {
        needSpacer = this.state.prevKind !== "blockquote"
      } else if (this.state.prevKind === "blockquote") {
        needSpacer = true
      } else if (curr.kind === "list") {
        if (this.state.topListIndent === null) {
          // Masuk ke blok daftar dari paragraf/elemen lain → pisahkan dengan 1 jeda.
          needSpacer = true
        } else if (curr.indentCols <= this.state.topListIndent) {
          // v0.33: dua bullet SIBLING pada level sama merapat (tak ada blank).
          // Spacer hanya dipakai saat KELUAR dari sub-poin yang lebih dalam
          // kembali ke induknya — itu transisi hierarki yang perlu napas.
          const prev = this.state.lastListIndent
          needSpacer = prev === null || prev > curr.indentCols
        }
      } else {
        // `curr.kind === "prose"`: bila baru keluar dari daftar ke paragraf level
        // terluar (bukan paragraf lanjutan berindentasi di dalam poin), beri jeda.
        if (this.state.topListIndent !== null && curr.indentCols <= this.state.topListIndent) {
          needSpacer = true
        }
      }
    }

    if (curr.kind === "list") {
      this.state.topListIndent =
        this.state.topListIndent === null
          ? curr.indentCols
          : Math.min(this.state.topListIndent, curr.indentCols)
      this.state.lastListIndent = curr.indentCols
    } else {
      this.state.lastListIndent = null
      if (
        curr.kind === "heading" ||
        this.state.topListIndent === null ||
        curr.indentCols <= this.state.topListIndent
      ) {
        this.state.topListIndent = null
      }
    }

    this.state.hasContent = true
    this.state.prevWasBlank = false
    this.state.prevKind = curr.kind
    return needSpacer
  }
}

/**
 * Rapikan spasi presentasi jawaban model: hapus baris kosong di tepi, batasi
 * jeda berulang di luar fence, dan sisipkan jeda 1 baris antar-poin utama /
 * paragraf / heading / blok kode. Isi code fence tetap literal 100%.
 */
export function formatAssistantSpacing(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  const flow = new MarkdownFlowStepper()
  let openFence: { char: string; len: number } | null = null

  for (const line of lines) {
    const fence = parseFence(line)
    if (openFence) {
      out.push(line)
      if (fence && fence.char === openFence.char && fence.len >= openFence.len) {
        openFence = null
        flow.onFenceClose()
      }
      continue
    }
    if (fence) {
      if (flow.onFenceOpen()) out.push("")
      openFence = fence
      out.push(line)
      continue
    }
    if (!line.trim()) {
      if (flow.onBlank()) out.push("")
      continue
    }
    const needSpacer = flow.onLine(line)
    // Hanya bab/poin utama (#..###) yang dapat dua baris; `####` ke bawah
    // tetap satu agar sub-bab tak seluas bab induknya.
    if (/^#{1,3}\s/.test(line) && out.length > 0) {
      // v0.33: antar BAB/poin utama (`### 6)`, `### 7)`, …) beri DUA baris
      // kosong supaya terlihat sebagai pemisah bab. Sub-poin bullet tetap rapat
      // (blank di dalam daftar ditelan oleh `onBlank`).
      let blanks = 0
      for (let i = out.length - 1; i >= 0 && out[i] === ""; i--) blanks++
      for (let i = blanks; i < 2; i++) out.push("")
    } else if (needSpacer) {
      out.push("")
    }
    out.push(line)
  }

  // Jika fence belum ditutup, baris kosong di ekor masih bagian dari contoh
  // kode dan harus tetap literal. Hanya whitespace di luar fence yang dirapatkan.
  if (!openFence) while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}
