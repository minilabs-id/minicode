// P2.12 — pembasuh teks masuk IPC (label konsumen, pesan penolakan, ringkasan
// tool dari jaringan/lokal).
//
// Kenapa ada salinan lokal: `src/ui/render/sanitize.ts` berada di lapisan UI dan
// batas lapisan (test/ui-boundary.test.ts) MELARANG `src/**` non-ui mengimpor
// `src/ui/**`. Daemon tetap wajib membasuh input tak terpercaya sebelum
// disimpan/diteruskan — sanitizer lokal yang sederhana lebih baik daripada
// membiarkan ANSI/jalur kendali mengalir ke konsumen.
//
// Cakupannya disengaja sempit (satu string, tanpa state): cukup untuk label dan
// pesan, bukan stream teks model — stream itu tidak melewati jalur ini.
//
// Pola dibangun lewat String.fromCharCode(27) bukan literal ESC: berkas yang
// memuat byte kontrol mentah merusak tooling teks dan sering tak sengaja
// ter-strip oleh formatter — siluman yang paling sulit dicari.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

// OSC/DCS/APC/PM/SOS (termasuk yang tidak diakhiri terminator di akhir string).
// Dicek SEBELUM CSI agar payload di dalamnya tidak menyisakan teks nyasar.
const STR_SEQ = new RegExp(`${ESC}[\\]PX^_][\\s\\S]*?(?:${BEL}|${ESC}\\\\|$)`, "g")
// CSI: ESC [ params intermediate final.
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
// Escape lain (ESC SP F …) — cukup buang dua-byte-nya.
const OTHER_ESC = new RegExp(`${ESC}[ -/]*[@-~]`, "g")
// C0 (termasuk \r, kecuali \n \t) + DEL + C1 (0x80–0x9F, termasuk 8-bit CSI 0x9B)
// + kontrol BiDi/format tak terlihat.
// biome-ignore lint/complexity/useRegexLiterals: lihat alasan di atas.
const CTRL = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u000D\\u000E-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]",
  "g",
)

export function sanitizeIncoming(s: string): string {
  if (typeof s !== "string" || s.length === 0) return ""
  return s.replace(STR_SEQ, "").replace(CSI, "").replace(OTHER_ESC, "").replace(CTRL, "")
}

/** Batasi panjang + basuh — untuk field yang nanti ikut dicetak/disimpan. */
export function sanitizeLabel(s: unknown, max = 120): string {
  if (typeof s !== "string" || s.length === 0) return ""
  return sanitizeIncoming(s).slice(0, max)
}

/** Basuh rekursif — untuk payload JSON yang datang dari peer. */
export function sanitizeJsonObject(value: unknown): unknown {
  if (typeof value === "string") return sanitizeIncoming(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonObject)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeLabel(k, 64)] = sanitizeJsonObject(v)
    }
    return out
  }
  return value
}
