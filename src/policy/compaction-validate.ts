// Validasi output summarizer LLM sebelum ringkasan dipersist atau di-inject.
//
// Ringkasan adalah teks tak terpercaya: model bisa mengarang path, angka,
// klaim "tes lulus", atau mengulang secret meski input sudah di-scrub. Modul ini
// MURNI — satu-satunya I/O adalah `existsSync` opsional bila `cwd` diberikan,
// dipakai untuk membedakan path nyata dari path karangan.

import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { scrubSecrets } from "./scrub.ts"

export interface CompactionValidation {
  ok: boolean
  /** `needs-verification` = fakta meragukan (klaim ringan, masih disimpan). */
  reason?: string
  normalized: string
}

/** Hitung semua kemunculan pola (regex global dipakai ulang → reset lastIndex). */
function occurrences(re: RegExp, text: string): string[] {
  re.lastIndex = 0
  const found: string[] = []
  let match = re.exec(text)
  while (match !== null) {
    found.push(match[0])
    match = re.exec(text)
  }
  return found
}

// Dua bentuk marker yang dipakai jalur mekanikal maupun LLM. Lebih dari satu
// = ringkasan lama ikut tersalin (penumpukan tiap siklus kompaksi).
const PREVIOUS_CONTEXT_OPEN = /Previous context \(/g
const PREVIOUS_CONTEXT_COLON = /Previous context:\n/g

// Path di direktori source/docs paling sering dikarang model. Sengaja sempit:
// `package.json`, `README.md`, dan path relatif umum lain TIDAK diblokir.
const SOURCE_PATH =
  /\b((?:src|test|docs)\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]+)\b/g

// Token fakta kunci yang jadi klaim verifikasi: versi, hash commit, exit code,
// hasil tes. Tak cocok di prefix = klaim meragukan, ditandai (bukan ditolak).
const FACT_TOKEN_PATTERNS: readonly RegExp[] = [
  /\b\d+\.\d+\.\d+\b/g, // mis. 0.43.3
  // Wajib memuat minimal satu digit agar kata bahasa Inggris berhuruf a–f
  // seperti `decode`, `decade`, `facade`, `accede` tidak memicu flag palsu.
  /\b(?=[0-9a-f]{6,40}\b)(?=[a-f]*\d)[0-9a-f]{6,40}\b/gi, // mis. 9f3a2c
  /\bexit(?:\s+code)?\s+\d+\b/gi, // mis. exit 1 / exit code 2
  /\b(?:PASS|FAIL)\b/g, // hasil tes
]

// Tag XML tetap dari kontrak prompt kompaksi; boilerplate ini bisa lebih
// panjang dari prefix sangat pendek walau isi faktanya ringkas.
const STRUCTURED_XML_RE = /<goal>[\s\S]*<\/open>/i
const XML_BOILERPLATE_RE =
  /<\/?(?:goal|steering|decisions|files|findings|tasks|observations|open)>|\bunknown\b/gi

/**
 * Validasi ringkasan kompaksi terhadap fakta yang benar-benar dikirim ke
 * summarizer. Urutan penting: keamanan (scrub) → keberadaan → penumpukan →
 * path halusinatif → flag fakta meragukan (paling longgar, karena owner minta
 * "jangan terlalu ketat").
 */
export function validateCompactionSummary(
  summary: string,
  prefixText: string,
  cwd?: string,
): CompactionValidation {
  // Gerbang tunggal untuk secret: input sudah di-scrub, tapi model bisa
  // membocorkan/mengarang kredensial dari potongan yang ikut terkirim.
  const normalized = scrubSecrets(summary).trim()

  // Ringkasan kosong atau bukan ringkasan (dump/echo input) = tak ada gunanya.
  // Untuk dokumen XML terstruktur, ukur isi efektif tanpa tag/placeholder
  // "unknown" agar prefix pendek tak ditolak hanya karena boilerplate 8 tag.
  if (normalized.length === 0) return { ok: false, reason: "empty-summary", normalized }
  const effectiveLen = STRUCTURED_XML_RE.test(normalized)
    ? normalized.replace(XML_BOILERPLATE_RE, "").replace(/\s+/g, " ").trim().length
    : normalized.length
  if (effectiveLen >= prefixText.length) {
    return { ok: false, reason: "summary-not-shorter-than-input", normalized }
  }

  // Anti penumpukan marker lintas siklus.
  const markerCount =
    occurrences(PREVIOUS_CONTEXT_OPEN, normalized).length +
    occurrences(PREVIOUS_CONTEXT_COLON, normalized).length
  if (markerCount > 1) {
    return { ok: false, reason: "duplicate-previous-context-marker", normalized }
  }

  // Normalisasi `\` → `/` pada prefix agar path Windows (`src\tools\bash.ts`)
  // yang dinormalisasi model menjadi `src/tools/bash.ts` (termasuk berkas yang
  // sudah dihapus) tidak salah ditolak sebagai path karangan.
  const normalizedPrefix = prefixText.replace(/\\/g, "/")

  // Path karangan: bila tak disebut di prefix DAN (saat cwd ada) tak ada di
  // disk, itu fakta buatan model — jangan sampai dipersist/di-inject.
  for (const path of occurrences(SOURCE_PATH, normalized)) {
    if (normalizedPrefix.includes(path)) continue
    if (cwd && !isAbsolute(path) && existsSync(join(cwd, path))) continue
    return { ok: false, reason: `hallucinated-path:${path}`, normalized }
  }

  // Angka/token kunci yang tak ada di prefix = klaim verifikasi meragukan.
  // Sengaja soft flag: ringkasan tetap dipakai, hanya diberi penanda ringan
  // di bukti (lihat compact.ts) supaya pembaca tahu perlu verifikasi ulang.
  for (const pattern of FACT_TOKEN_PATTERNS) {
    for (const token of occurrences(pattern, normalized)) {
      if (!normalizedPrefix.includes(token)) {
        return { ok: true, reason: "needs-verification", normalized }
      }
    }
  }

  // Tidak ada pemeriksaan struktur XML: prompt belum diubah ke format
  // terstruktur (P1 menyusul). Validasi ini murni fakta & keamanan.
  return { ok: true, normalized }
}
