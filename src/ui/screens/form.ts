// Form dalam popup — SEMUA input teks/pilihan terjadi DI DALAM kotak.
//
// Latar: popup komposit hanya bisa melukis daftar; tiap input teks memakai
// askLine warisan yang menggambar di kursor terminal (di LUAR kotak).
// Hasilnya jendela yang mengusir user keluar untuk mengetik. Form ini
// menggantikannya: field berlabel + validasi + error inline, satu kotak,
// Tab pindah field, Enter simpan, Esc batal. Secret di-mask `•`.
//
// Pemilik layar (App/popup parent) tetap di luar: form melukis regionnya via
// screen.handle sendiri (openAltScreen nested = paint-through) dan memarkir
// kursor terminal di posisi ketik. Tutup = clearRegion + close.

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import type { HintItem } from "../render/hint.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import type { AltScreen } from "../runtime/screen.ts"
import { boxLeftPad, dialogBox } from "./dialog.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { windowSpec, windowWidth } from "./window.ts"

export interface FormField {
  id: string
  label: string
  kind: "text" | "secret" | "select" | "confirm"
  /** Nilai awal (text/secret) atau indeks opsi (select). Confirm: boolean. */
  initial?: string | number | boolean
  /** Pilihan untuk select (min 1). Confirm memakai Ya/Tidak bawaan. */
  options?: string[]
  /** Validasi: pesan error Indonesia atau null bila sah. */
  validate?: (value: string) => string | null
}

export interface FormSpec {
  title: string
  fields: FormField[]
  /** Override hint (mis. Enter = hapus pada dialog konfirmasi). */
  footerHints?: readonly HintItem[]
}

export interface FormResult {
  cancelled: boolean
  values?: Record<string, string>
}

/** Validasi umum: wajib isi. */
export function validateRequired(v: string): string | null {
  return v.trim() ? null : t("form.required")
}

/** Validasi umum: URL http(s) yang sah. */
export function validateUrl(v: string): string | null {
  if (!v.trim()) return t("form.required")
  try {
    const u = new URL(v.trim())
    if (!["http:", "https:"].includes(u.protocol)) return t("form.httpOnly")
  } catch {
    return t("form.invalidUrl")
  }
  return null
}

interface FieldState {
  def: FormField
  /** Text/secret: nilai ketik. Select: indeks opsi. Confirm: boolean. */
  text: string
  cursor: number // grapheme
  selectIdx: number
  confirmed: boolean
  error: string | null
  /** Offset scroll horizontal nilai (kursor selalu terlihat). */
  viewStart: number
  /** Ctrl+A menandai seluruh isi field untuk ditimpa/hapus pada ketikan berikutnya. */
  selectedAll?: boolean
}

const dim = (s: string): string => c.dim(s)

/**
 * Hint tambahan spesifik-field. Nav/pilih/tutup (↑↓/Enter/Esc) sudah jadi
 * bawaan windowFooter — jangan diduplikasi di sini. v0.33 menyatukan footer
 * semua jendela lewat satu helper.
 */
function defaultExtraHints(st: FieldState | undefined): HintItem[] {
  if (st?.def.kind === "select") {
    return [
      { key: glyphs.leftRight, label: t("hint.select") },
      { key: "Enter", label: t("hint.save") },
    ]
  }
  if (st?.def.kind === "confirm") {
    return [
      { key: `${glyphs.leftRight}/y/n`, label: t("hint.select") },
      { key: "Enter", label: t("hint.save") },
    ]
  }
  return [
    { key: "Tab", label: t("hint.move") },
    { key: "Enter", label: t("hint.save") },
  ]
}

function toState(def: FormField): FieldState {
  if (def.kind === "select") {
    const n = Math.max(1, def.options?.length ?? 1)
    const init = typeof def.initial === "number" ? def.initial : 0
    return {
      def,
      text: "",
      cursor: 0,
      selectIdx: Math.min(Math.max(0, init), n - 1),
      confirmed: false,
      error: null,
      viewStart: 0,
    }
  }
  if (def.kind === "confirm") {
    return {
      def,
      text: "",
      cursor: 0,
      selectIdx: 0,
      confirmed: typeof def.initial === "boolean" ? def.initial : false,
      error: null,
      viewStart: 0,
    }
  }
  // Prefill berasal dari config/berkas (teks tak-terpercaya). Disanitasi di
  // STATE, bukan saat render: kursor di ujung nilai awal agar mudah mengedit.
  const initialText = typeof def.initial === "string" ? sanitizeAnsiLine(def.initial) : ""
  return {
    def,
    text: initialText,
    cursor: toGraphemes(initialText).length,
    selectIdx: 0,
    confirmed: false,
    error: null,
    viewStart: 0,
  }
}

function fieldValue(st: FieldState): string {
  if (st.def.kind === "select") return st.def.options?.[st.selectIdx] ?? ""
  if (st.def.kind === "confirm") return st.confirmed ? "y" : "n"
  return st.text
}

/**
 * Potong deretan grapheme agar muat dalam `maxV` KOLOM (CJK/emoji = 2).
 * Dipakai jendela nilai field: slice grapheme mentah bisa meluap 2×.
 */
function sliceByWidth(pts: string[], start: number, maxV: number): string[] {
  const out: string[] = []
  let w = 0
  for (let i = start; i < pts.length; i++) {
    const cw = displayWidth(pts[i] ?? "")
    if (w + cw > maxV) break
    out.push(pts[i]!)
    w += cw
  }
  return out
}

// Jeda sebelum peringatan idle & jeda peringatan → batal (temuan audit
// TUI-004): raw-mode digenggam tanpa input rawan macet saat ConPTY mati,
// tapi batal diam-diam membuang draft yang sudah diketik. Dua-tahap: 80 dtk
// diam → peringatan di footer kotak; 10 dtk lagi tanpa keypress → batal.
// TOTAL tetap 90 dtk (semantik anti-hang dipertahankan).
export const IDLE_WARN_MS = 80_000
export const IDLE_CANCEL_MS = 10_000

export async function runForm(spec: FormSpec, screen: AltScreen): Promise<FormResult> {
  if (!spec.fields.length) return { cancelled: true }
  return new Promise<FormResult>((resolve) => {
    const fields = spec.fields.map(toState)
    let idx = 0
    let done = false
    let idleWarned = false
    // Idle dua-fase via helper bersama (audit D1): 80 dtk diam → peringatan
    // di footer kotak (draft TIDAK dibuang); 10 dtk lagi hening → batal.
    // TOTAL tetap 90 dtk (semantik anti-hang dipertahankan). `finish`/`render`
    // dirujuk sebagai closure — dievaluasi jauh setelah keduanya terdefinisi.
    const idle = createIdleTimer({
      warnMs: IDLE_WARN_MS,
      cancelMs: IDLE_CANCEL_MS,
      onWarn: () => {
        idleWarned = true
        render()
      },
      onCancel: () => finish(true),
    })
    const resetIdle = () => {
      idleWarned = false
      idle.reset()
    }

    // Lebar dinamis mengikuti terminal saat resize (tetap stabil saat error
    // muncul/hilang). v0.33: pakai aturan SERAGAM windowWidth(cols), bukan
    // popupBoxWidth — satu rumus untuk semua jendela.
    const width = () => windowWidth(screen.cols || 80)
    const innerW = () => Math.max(8, width() - 4)

    // Baris nilai field aktif (indeks dalam body) untuk parkir kursor.
    const render = (): { activeRow: number; activeCol: number } => {
      const w = innerW()
      const cut = (s: string) => truncateToWidth(s, w)
      const body: string[] = []
      let activeRow = -1
      let activeCol = -1
      fields.forEach((st, fi) => {
        const active = fi === idx
        const marker = active ? c.accent(glyphs.arrow) : " "
        const cleanLabel = sanitizeAnsiLine(st.def.label)
        if (st.def.kind === "text" || st.def.kind === "secret") {
          const shown =
            st.def.kind === "secret" ? glyphs.mask.repeat(toGraphemes(st.text).length) : st.text
          const inlinePrefix = `${marker} ${cleanLabel}: `
          const inlineRoom = w - displayWidth(stripAnsi(inlinePrefix))
          // Tata letak bertumpuk saat label panjang menyisakan ruang < 20 kolom
          // (mis. Base URL preset di wizard); pertahankan inline untuk label pendek.
          const stacked = inlineRoom < 20
          const maxV = stacked ? Math.max(8, w - 2) : Math.max(8, inlineRoom)
          const pts = toGraphemes(shown)
          let start = Math.max(0, Math.min(st.viewStart, st.cursor))
          if (st.cursor < start) start = st.cursor
          while (start < st.cursor && displayWidth(pts.slice(start, st.cursor).join("")) > maxV - 1)
            start++
          st.viewStart = start
          const visRaw = sliceByWidth(pts, start, maxV).join("")
          const vis = active && st.selectedAll && visRaw ? `\x1b[7m${visRaw}\x1b[27m` : visRaw
          if (stacked) {
            for (const hl of wrapByWidth(`${marker} ${cleanLabel}`, w)) body.push(cut(hl))
            if (active) {
              activeCol = 2 + displayWidth(pts.slice(start, st.cursor).join("")) + 1
            }
            body.push(cut(`  ${vis}`))
          } else {
            if (active) {
              activeCol =
                displayWidth(stripAnsi(inlinePrefix)) +
                displayWidth(pts.slice(start, st.cursor).join("")) +
                1
            }
            body.push(cut(`${inlinePrefix}${vis}`))
          }
          activeRow = active ? body.length - 1 : activeRow
        } else if (st.def.kind === "select") {
          const opts = st.def.options ?? []
          const cur = sanitizeAnsiLine(opts[st.selectIdx] ?? "")
          const ctrl = `${dim(glyphs.chevronLeft)} ${cur} ${dim(glyphs.chevronRight)}`
          const inline = `${marker} ${cleanLabel}: ${ctrl}`
          if (active) activeCol = -1 // select tanpa kursor ketik
          if (displayWidth(stripAnsi(inline)) > w) {
            for (const hl of wrapByWidth(`${marker} ${cleanLabel}`, w)) body.push(cut(hl))
            body.push(cut(`  ${ctrl}`))
          } else {
            body.push(cut(inline))
          }
          activeRow = active ? body.length - 1 : activeRow
        } else {
          // Confirm: Ya/Tidak toggle (panah/y-n — sama seperti select).
          const val = st.confirmed ? c.accent(t("form.yes")) : t("form.no")
          const ctrl = `${dim(glyphs.chevronLeft)} ${val} ${dim(glyphs.chevronRight)}`
          const inline = `${marker} ${cleanLabel}: ${ctrl}`
          if (active) activeCol = -1
          if (displayWidth(stripAnsi(inline)) > w) {
            for (const hl of wrapByWidth(`${marker} ${cleanLabel}`, w)) body.push(cut(hl))
            body.push(cut(`  ${ctrl}`))
          } else {
            body.push(cut(inline))
          }
          activeRow = active ? body.length - 1 : activeRow
        }
        if (st.error) {
          for (const el of wrapByWidth(sanitizeAnsiLine(st.error), Math.max(8, w - 2))) {
            body.push(cut(c.error(`  ${el}`)))
          }
        }
      })
      // Footer selalu dari windowFooter (nav/pilih/tutup). Aksi khusus form
      // (Tab/Enter/select/confirm) dan peringatan idle (TUI-004: draft tak
      // hilang tanpa jejak 10 dtk sebelum batal) masuk lewat extraHints.
      const extraHints: HintItem[] = [
        ...(idleWarned
          ? [{ key: "!", label: t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }) }]
          : []),
        ...(spec.footerHints ?? defaultExtraHints(fields[idx])),
      ]
      const box = dialogBox(
        windowSpec({
          title: spec.title,
          body,
          cols: screen.cols || 80,
          rows: screen.rows || 24,
          // Field aktif WAJIB terlihat: dialog menggeser jendela body bila
          // muat-tidaknya terpaksa memotong (audit 2026-11-12, HIGH-2).
          focusRow: activeRow >= 0 ? activeRow : undefined,
          extraHints,
        }),
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor terminal di posisi ketik field aktif (select/confirm:
      // sembunyikan di ujung baris). Kolom absolut = padding kiri + border +
      // spasi + offset konten + 1; clamp ke layar. Menghitung ulang center
      // dari lebar baris (yang sudah termasuk padding) terbukti off-by-N.
      try {
        if (activeRow >= 0) {
          // bodyStart = offset jendela body yang benar-benar dirender; tanpa
          // dikurangi, kursor mendarat di baris marker/border saat body dipotong.
          const li = Math.max(
            0,
            Math.min(box.lines.length - 1, box.bodyTop + (activeRow - box.bodyStart)),
          )
          const row = box.topRow + li
          const stripped = stripAnsi(box.lines[li] ?? "")
          const leftPad = boxLeftPad(stripped)
          const contentW = displayWidth(stripped) - leftPad
          const maxCol = leftPad + 2 + w + 1
          const raw =
            activeCol >= 0 ? Math.min(maxCol, leftPad + activeCol + 2) : leftPad + contentW + 1
          const col = Math.max(1, Math.min(screen.cols || 80, raw))
          // Lewat screen.moveCursor agar RESET_ATTRS + `\x1b[6 q` + blok sync konsisten.
          screen.moveCursor(row, col)
        }
      } catch {}
      return { activeRow, activeCol }
    }

    const finish = (cancelled: boolean) => {
      if (done) return
      done = true
      idle.dispose()
      try {
        formPump.dispose()
      } catch {}
      try {
        screen.setBracketedPaste?.(false)
      } catch {}
      try {
        screen.clearRegion()
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      if (onData) process.stdin.removeListener("data", onData)
      if (onResize) process.stdout.removeListener("resize", onResize)
      if (cancelled) resolve({ cancelled: true })
      else {
        const values: Record<string, string> = {}
        for (const st of fields) values[st.def.id] = fieldValue(st)
        resolve({ cancelled: false, values })
      }
    }

    const validateAll = (): boolean => {
      let firstBad = -1
      fields.forEach((st, fi) => {
        st.error = null
        if (st.def.kind === "text" || st.def.kind === "secret") {
          const err = st.def.validate?.(st.text) ?? null
          if (err) {
            st.error = err
            if (firstBad < 0) firstBad = fi
          }
        }
      })
      if (firstBad >= 0) {
        idx = firstBad
        render()
        return false
      }
      return true
    }

    const moveCursor = (st: FieldState, d: number) => {
      const n = toGraphemes(st.text).length
      st.cursor = Math.max(0, Math.min(n, st.cursor + d))
    }

    const insertText = (st: FieldState, ins: string) => {
      const clean = ins
        .replace(/\r\n|\r/g, " ")
        .replace(/\t/g, " ")
        // Kontrol C0 + C1 dibuang (kecuali newline yang sudah jadi spasi).
        // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitasi input form
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      if (!clean) return
      const pts = toGraphemes(st.text)
      const at = Math.max(0, Math.min(st.cursor, pts.length))
      pts.splice(at, 0, ...toGraphemes(clean))
      st.text = pts.join("")
      st.cursor = at + toGraphemes(clean).length
      st.error = null
    }

    const deletePrev = (st: FieldState) => {
      const pts = toGraphemes(st.text)
      const at = Math.max(0, Math.min(st.cursor, pts.length))
      if (at === 0) return
      // Hapus satu grapheme (emoji/ZWJ/flag utuh).
      const head = pts.slice(0, at - 1)
      const tail = pts.slice(at)
      st.text = [...head, ...tail].join("")
      st.cursor = at - 1
      st.error = null
    }

    /**
     * Esc tahap-1: kembalikan nilai bawaan field AKTIF, apa pun jenisnya.
     *
     * Kontrak I21 menyebut "semua input teks/pilihan", tapi dulu hanya
     * text/secret yang di-revert — pada select/confirm Esc langsung menutup
     * seluruh form dan perubahan field lain ikut hilang (audit 2026-11-12,
     * MEDIUM-6). `false` = sudah di nilai bawaan → lanjut ke tahap-2 (batal).
     */
    const revertField = (cur: FieldState): boolean => {
      if (cur.def.kind === "select") {
        const n = Math.max(1, cur.def.options?.length ?? 1)
        const init = typeof cur.def.initial === "number" ? cur.def.initial : 0
        const target = Math.min(Math.max(0, init), n - 1)
        if (cur.selectIdx === target) return false
        cur.selectIdx = target
        cur.error = null
        return true
      }
      if (cur.def.kind === "confirm") {
        const target = typeof cur.def.initial === "boolean" ? cur.def.initial : false
        if (cur.confirmed === target) return false
        cur.confirmed = target
        cur.error = null
        return true
      }
      const initial = typeof cur.def.initial === "string" ? sanitizeAnsiLine(cur.def.initial) : ""
      if (cur.text === initial) return false
      cur.text = initial
      cur.cursor = toGraphemes(initial).length
      cur.viewStart = 0
      cur.error = null
      return true
    }

    const handleKeys = (keys: DecodedKey[]): boolean => {
      if (done) return true
      resetIdle()
      for (const d of keys) {
        const k = d.key
        // Field STATE dibaca ulang tiap iterasi: Tab/↑/↓ di dalam chunk yang
        // sama memindahkan `idx`, dan pointer yang dicapture sebelum loop
        // membuat ketikan masuk ke field SEBELUMNYA (audit 2026-11-12, HIGH-1).
        const st = fields[idx]!
        if (k.type !== "selectAll" && st.selectedAll) {
          // Biarkan char/backspace/delete membaca flag di bawah sebelum dibersihkan.
          if (k.type !== "char" && k.type !== "backspace" && k.type !== "delete") {
            st.selectedAll = false
          }
        }
        // Esc/Ctrl+C dua-tahap (anti-hilang draft): field kotor → kembalikan
        // ke nilai bawaan (prefill edit tak hilang sekali tekan — dulu
        // langsung dikosongkan tanpa undo); sudah bawaan/kosong → batal
        // total. Ctrl+D = batal langsung (konvensi EOF, tidak dipakai
        // menghapus).
        if (k.type === "esc" || k.type === "ctrl-c") {
          if (revertField(fields[idx]!)) {
            render()
            continue
          }
          finish(true)
          return true
        }
        if (k.type === "ctrl-d") {
          finish(true)
          return true
        }
        if (k.type === "enter") {
          if (validateAll()) finish(false)
          return false
        }
        if (k.type === "tab") {
          idx = (idx + 1) % fields.length
          continue
        }
        if (k.type === "shift-tab") {
          idx = (idx - 1 + fields.length) % fields.length
          continue
        }
        if (k.type === "up") {
          idx = (idx - 1 + fields.length) % fields.length
          continue
        }
        if (k.type === "down") {
          idx = (idx + 1) % fields.length
          continue
        }
        if (st.def.kind === "select") {
          const n = Math.max(1, st.def.options?.length ?? 1)
          if (k.type === "left") st.selectIdx = (st.selectIdx - 1 + n) % n
          else if (k.type === "right") st.selectIdx = (st.selectIdx + 1) % n
          continue
        }
        if (st.def.kind === "confirm") {
          if (k.type === "left" || k.type === "right") {
            st.confirmed = !st.confirmed
            continue
          }
          if (k.type === "char") {
            // Terima dwibahasa (label tampil per locale): y/yes/ya, n/no/tidak/t.
            const ch = k.ch.toLowerCase()
            if (ch === "y" || ch === "ya") st.confirmed = true
            else if (ch === "n" || ch === "t") st.confirmed = false
            continue
          }
          continue
        }
        // Text/secret editing.
        if (k.type === "selectAll") {
          st.selectedAll = st.text.length > 0
          st.cursor = toGraphemes(st.text).length
          continue
        }
        const wasSelectedAll = Boolean(st.selectedAll)
        st.selectedAll = false
        if (k.type === "char") {
          if (wasSelectedAll) {
            st.text = ""
            st.cursor = 0
            st.viewStart = 0
          }
          insertText(st, k.ch)
        } else if (k.type === "backspace" || k.type === "delete") {
          if (wasSelectedAll) {
            st.text = ""
            st.cursor = 0
            st.viewStart = 0
            st.error = null
          } else if (k.type === "backspace") {
            deletePrev(st)
          } else {
            const pts = toGraphemes(st.text)
            const at = Math.max(0, Math.min(st.cursor, pts.length))
            if (at < pts.length) {
              pts.splice(at, 1)
              st.text = pts.join("")
              st.error = null
            }
          }
        } else if (k.type === "left") moveCursor(st, -1)
        else if (k.type === "right") moveCursor(st, 1)
        else if (k.type === "home") st.cursor = 0
        else if (k.type === "end") st.cursor = toGraphemes(st.text).length
        else if (k.type === "ctrl-k") {
          const pts = toGraphemes(st.text)
          const at = Math.max(0, Math.min(st.cursor, pts.length))
          if (at < pts.length) {
            st.text = pts.slice(0, at).join("")
            st.error = null
          }
        } else if (k.type === "ctrl-u") {
          st.text = ""
          st.cursor = 0
          st.viewStart = 0
          st.error = null
        } else if (k.type === "ctrl-w") {
          const pts = toGraphemes(st.text)
          const at = Math.max(0, Math.min(st.cursor, pts.length))
          const before = pts.slice(0, at).join("")
          const trimmed = before.replace(/\S+\s*$/, "")
          st.text = trimmed + pts.slice(at).join("")
          st.cursor = toGraphemes(trimmed).length
          st.error = null
        }
      }
      render()
      return false
    }

    const decoder: DecoderState = createDecoderState()
    const formPump = createKeyStreamPump({ state: decoder, onKeys: handleKeys })
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    onData = (chunk: Buffer) => {
      resetIdle()
      try {
        formPump.push(chunk)
      } catch {
        finish(true)
      }
    }
    onResize = () => render()

    // Form berjalan di atas screen milik pemanggil (view membuka
    // openAltScreen sendiri; nested = paint-through). Listener stdin milik
    // form selama hidup — pemanggil wajib suspend dulu (pola popup komposit).
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      screen.setBracketedPaste?.(true)
      resetIdle()
      render()
    } catch {
      finish(true)
    }
  })
}
