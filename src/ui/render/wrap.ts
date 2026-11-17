// Word-wrap + justify (rata kanan-kiri) - untuk output teks AI.
//
// Semua pengukuran memakai KOLOM terminal (src/ui/render/width.ts), bukan jumlah
// karakter: CJK/emoji memakan dua kolom, combining mark nol, dan sekuens ANSI
// tidak menempati kolom sama sekali.
//
// stripAnsi di-re-export dari theme.ts: dulu ada dua implementasi terpisah, dan
// yang di sini tidak ikut diperbaiki saat pola ANSI diperluas untuk sekuens
// private-mode (ESC[?25l dsb.).

import { computeHangingIndent } from "./markdown-layout.ts"
import { stripAnsi } from "./theme.ts"
import { chunkByWidthSplit, displayWidth } from "./width.ts"

export { stripAnsi }

/** Lebar tampil dalam kolom terminal. */
export function visibleLen(s: string): number {
  return displayWidth(s)
}

/**
 * Wrap teks ke baris-baris <= `width` KOLOM, dipotong di batas spasi.
 *
 * Kata yang sendirian sudah lebih lebar dari `width` (URL panjang, hash, atau
 * teks CJK yang memang tidak punya spasi) dipecah per kolom — sebelumnya
 * dibiarkan utuh sehingga baris membungkus sendiri di terminal dan merusak
 * frame TUI yang menghitung tinggi per baris.
 */
export function wordWrap(text: string, width: number): string {
  if (width <= 0) return text
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (displayWidth(line) <= width) {
      out.push(line)
      continue
    }
    const hang = computeHangingIndent(line, width)
    const hangWidth = hang ? displayWidth(hang) : 0
    let current = ""
    let lineIndex = 0
    const emitLine = (textOut: string) => {
      out.push(textOut)
      lineIndex++
    }
    const flush = () => {
      if (current !== "" && (lineIndex === 0 || current.trim() !== "")) {
        // Spasi pemisah di ujung tidak ikut tampil.
        emitLine(current.trimEnd())
      }
      current = ""
    }
    // Pisah dengan pemisah tertangkap agar spasi ganda (ASCII art/tabel)
    // tetap utuh — run whitespace menempel ke kata berikut, wrap hanya putus
    // di batas run (spasi di ujung baris dibuang saat flush).
    for (const tok of line.split(/(\s+)/)) {
      if (tok === "") continue
      if (/^\s+$/.test(tok)) {
        // Run whitespace di AWAL baris = indentasi, bukan pemisah: ia harus
        // ikut baris pertama. Dulu run ini dibuang saat `current` masih kosong
        // sehingga indentasi & marker list panjang hilang di jalur linear
        // (audit 2026-11-12, HIGH-6).
        current += tok
        continue
      }
      const word = tok
      const contBudget = Math.max(1, width - hangWidth)
      // Kata tunggal lebih lebar dari sisa lebar baris lanjutan: pecah paksa per kolom.
      if (
        displayWidth(word) > contBudget &&
        (displayWidth(word) > width || current.trim() !== "")
      ) {
        // Indentasi (bila ada) menempel ke potongan PERTAMA dan menyusutkan
        // lebar potongan itu — tanpa ini indentasi hilang atau baris meluap.
        const lead = current.trim() === "" ? current : ""
        // Teks yang sudah terkumpul (bila ada) ditutup dulu; hanya indentasi
        // murni yang ikut menempel ke potongan pertama.
        if (current.trim() !== "") emitLine(current.trimEnd())
        current = ""
        const firstPrefix = lineIndex === 0 ? lead : hang
        const firstPrefixWidth = displayWidth(firstPrefix)
        const availFirst = Math.max(1, width - firstPrefixWidth)
        if (displayWidth(word) <= availFirst) {
          current = firstPrefix + word
          continue
        }
        // Potong bagian pertama sepas `availFirst`, sisanya mengikuti `contBudget`
        // (SGR-safe via chunkByWidthSplit agar warna tetap terbawa utuh).
        const pieces = chunkByWidthSplit(word, availFirst, contBudget)
        if (pieces.length > 0) {
          emitLine(firstPrefix + (pieces[0] ?? ""))
          for (let i = 1; i < pieces.length - 1; i++) {
            emitLine(hang + pieces[i]!)
          }
          current = pieces.length > 1 ? hang + (pieces[pieces.length - 1] ?? "") : ""
        }
        continue
      }
      // `current` sudah memuat run whitespace aslinya; tambah satu spasi
      // hanya bila tidak ada pemisah di antara dua kata.
      const glued = !current || /\s$/.test(current) ? `${current}${word}` : `${current} ${word}`
      if (displayWidth(glued) > width && current.trim() !== "") {
        emitLine(current.trimEnd())
        current = hang && displayWidth(hang) + displayWidth(word) <= width ? hang + word : word
      } else if (displayWidth(glued) > width) {
        // Indentasi + kata tak muat bersama: lepas indentasi berlebih atau pakai hang.
        current = hang && displayWidth(hang) + displayWidth(word) <= width ? hang + word : word
      } else {
        current = glued
      }
    }
    flush()
  }
  return out.join("\n")
}

// Justify satu baris: distribusi spasi ekstra supaya ujung kiri & kanan rata.
// Baris kosong / <2 kata / baris yang sudah penuh dibiarkan.
export function justifyLine(line: string, width: number): string {
  const clean = displayWidth(line)
  if (clean >= width || width <= 0) return line
  const words = line.split(" ")
  if (words.length < 2) return line
  const gaps = words.length - 1
  const extra = width - clean
  const perGap = Math.floor(extra / gaps)
  const extraGap = extra % gaps
  return words
    .map((w, i) => {
      if (i >= gaps) return w
      const spaces = 1 + perGap + (i < extraGap ? 1 : 0)
      return w + " ".repeat(spaces)
    })
    .join("")
}

// Wrap + justify: untuk output streaming per paragraf.
//
// Baris TERAKHIR paragraf tidak dijustify — menjustifikasinya menghasilkan
// "sungai" spasi seperti `dengan      lebar      tertentu`, kesalahan tipografi
// klasik. Justify kini OPT-IN (default OFF, temuan K.2): menjustifikasi
// menyuntik spasi yang mengubah teks asli model saat di-copy/–pipe, dan membuat
// output linear berbeda dari TUI (ragged). `MINICODE_JUSTIFY=1` mengaktifkan.
export function formatWrapped(text: string, width: number, justify = false): string {
  const wrapped = wordWrap(text, width)
  if (!(justify || process.env.MINICODE_JUSTIFY === "1")) return wrapped
  const lines = wrapped.split("\n")
  return lines
    .map((line, i) => {
      const plain = stripAnsi(line)
      if (/^\s*(```|#|[-*] |>\s)/.test(plain) || /^\s*$/.test(plain)) return line
      // Baris dengan spasi ganda (tabel ASCII/art) jangan dijustify —
      // justifyLine akan meratakan ulang run spasi yang disengaja.
      if (plain.includes("  ")) return line
      // Baris terakhir, atau baris tepat sebelum baris kosong (= akhir paragraf).
      const isParagraphEnd = i === lines.length - 1 || /^\s*$/.test(lines[i + 1] ?? "")
      if (isParagraphEnd) return line
      return justifyLine(line, width)
    })
    .join("\n")
}
