// Jendela hasil command read-only: SATU layer di atas transkrip, seragam
// dengan jendela command lain (dialogBox + judul + hint minimalis).
// Output command TIDAK dicetak ke transkrip — chat tetap utuh dan tidak
// bergeser. Mendukung scroll (↑↓/PgUp/PgDn/Home/End/wheel/j/k/Space) serta
// salin cepat (`c`) untuk /help full, /status, /context, /history, /expand, dll.
import { clipboardByteLength, MAX_CLIPBOARD_BYTES } from "../assistant/simple.ts"
import { t } from "../i18n/locale.ts"
import { createDecoderState, createKeyStreamPump, type DecodedKey } from "../input/prompt-engine.ts"
import type { HintItem } from "../render/hint.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { canRenderModal, type DialogSpec, dialogBox } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS } from "./form.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { windowMaxHeight, windowSpec, windowWidth } from "./window.ts"

export interface OutputWindowOptions {
  title: string
  /** Baris output command (boleh mengandung SGR dari formatter command). */
  lines: readonly string[]
  /** Callback opsional untuk menyalin teks polos isi jendela dengan tombol `c`. */
  onCopy?: (text: string) => boolean
}

/**
 * Bungkus baris output agar muat di `width` kolom sambil mempertahankan
 * hanging indent pada baris berindentasi (/help, /status, daftar command).
 */
function wrapCommandLines(source: readonly string[], width: number): string[] {
  const out: string[] = []
  for (const line of source) {
    const safe = sanitizeAnsiLine(line)
    if (!safe) {
      out.push("")
      continue
    }
    const direct = wrapByWidth(safe, width)
    if (direct.length <= 1) {
      out.push(...direct)
      continue
    }
    const plain = stripAnsi(safe)
    // Deteksi kolom tabel 2-kolom (/help, /help keys): teks berindentasi + ≥2 spasi pemisah.
    const twoCol = /^(\s*\S+(?:\s\S+)*\s{2,})/.exec(plain)?.[1]
    const twoColW = twoCol ? displayWidth(twoCol) : 0
    const leadW = displayWidth(/^(\s+)/.exec(plain)?.[1] ?? "")
    const hang =
      twoColW > leadW && twoColW <= Math.floor(width * 0.45)
        ? twoColW
        : Math.min(leadW, Math.max(0, Math.floor(width / 3)))
    if (hang <= 0) {
      out.push(...direct)
      continue
    }
    // Bungkus langsung dengan hangingIndent agar baris pertama tetap memakai lebar
    // penuh dan baris sambungan sejajar tepat di awal kolom deskripsi.
    out.push(...wrapByWidth(safe, width, { hangingIndent: " ".repeat(hang) }))
  }
  return out
}

/**
 * LEGACY — jangan dipakai untuk frame lagi. Dipertahankan sebagai shim ekspor
 * agar pemanggil lama tidak crash; jendela sekarang memakai `windowWidth`
 * lewat `outputWindowSpec` (satu aturan ukuran untuk semua popup).
 */
export function outputWindowWidth(cols: number): number {
  const safe = Math.max(10, Math.floor(cols) || 80)
  return Math.min(Math.max(56, safe - 8), 96, Math.max(14, safe - 4))
}

/** Baris chrome `dialogBox`: border atas/bawah + judul + footer. */
const WINDOW_CHROME_ROWS = 4

export interface OutputWindowSpecOptions {
  title: string
  body: string[]
  cols: number
  rows: number
  extraHints?: readonly HintItem[]
}

/**
 * Frame output mengikuti aturan jendela seragam (lebar & footer dari
 * `windowSpec`). `windowMaxHeight` dipakai sebagai anggaran baris ISI yang
 * bisa digulir; chrome ditambahkan kembali supaya jumlah baris tampil tidak
 * menyusut dibanding perilaku lama (isi = rows - 4). Menjaga output tetap
 * terbaca adalah bagian dari kontrak jendela ini.
 */
export function outputWindowSpec(opts: OutputWindowSpecOptions): DialogSpec {
  return windowSpec({
    title: opts.title,
    body: opts.body,
    cols: opts.cols,
    rows: opts.rows,
    role: "viewer",
    ...(opts.extraHints ? { extraHints: opts.extraHints } : {}),
  })
}

/**
 * Tampilkan output command sebagai overlay. Return false bila layar tak mampu
 * (non-TTY/terlalu kecil) — pemanggil WAJIB fallback ke transkrip agar output
 * tidak hilang.
 */
export async function runOutputWindow(opts: OutputWindowOptions): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const screen: AltScreen = openAltScreen()
  const useModal =
    screen.ok && canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)
  if (!useModal) {
    try {
      screen.close()
    } catch {}
    return false
  }
  // Buang blank line tepi (printStatus/help menambahkan padding) agar isi
  // jendela rapi; blank internal dipertahankan.
  const source = [...opts.lines]
  while (source.length && !source[0]?.trim()) source.shift()
  while (source.length && !source[source.length - 1]?.trim()) source.pop()

  let lastCols = 0
  let wrapped: string[] = []
  let scroll = 0
  let done = false
  let idleWarned = false
  let bracketedPasteOn = false
  let copyNotice: string | null = null
  let copyTimer: ReturnType<typeof setTimeout> | null = null
  let onData!: (chunk: Buffer) => void
  let onResize!: () => void

  const clearCopyTimer = (): void => {
    if (copyTimer) {
      clearTimeout(copyTimer)
      copyTimer = null
    }
  }

  const ensureWrapped = (cols: number): void => {
    if (cols === lastCols && (wrapped.length > 0 || source.length === 0)) return
    const prevTotal = wrapped.length
    lastCols = cols
    // Lebar isi mengikuti frame seragam — bukan outputWindowWidth legacy.
    const innerW = Math.max(8, windowWidth(cols) - 4)
    wrapped = wrapCommandLines(source, innerW)
    if (prevTotal > 0 && wrapped.length !== prevTotal) {
      // Pertahankan posisi scroll proporsional saat terminal diubah ukurannya.
      const ratio = scroll / Math.max(1, prevTotal)
      scroll = Math.round(ratio * wrapped.length)
    }
  }

  // Anggaran baris isi menyesuaikan ada-tidaknya footer: tanpa footer = 3 chrome
  // (border+judul); dengan footer = 5 chrome (border+judul+jeda+footer).
  const hasFooterAtBudget = (): boolean => {
    if (opts.onCopy || idleWarned) return true
    const maxH = windowMaxHeight(screen.rows || 24)
    const noFooterBudget = Math.max(1, maxH - 3)
    return wrapped.length > noFooterBudget
  }
  const bodyBudget = (): number => {
    const chrome = hasFooterAtBudget() ? WINDOW_CHROME_ROWS + 1 : WINDOW_CHROME_ROWS - 1
    return Math.max(1, windowMaxHeight(screen.rows || 24) - chrome)
  }
  const maxScroll = (): number => Math.max(0, wrapped.length - bodyBudget())

  const render = (): void => {
    const cols = screen.cols || 80
    const rows = screen.rows || 24
    if (!canRenderModal(cols, rows)) {
      screen.paintRegion(
        [c.warning(truncateToWidth(tSystem("msg.tooSmall"), Math.max(1, cols - 2)))],
        Math.max(1, Math.floor(rows / 2)),
      )
      screen.setCursorVisible(false)
      return
    }
    ensureWrapped(cols)
    const budget = bodyBudget()
    scroll = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - budget)))
    const scrollable = wrapped.length > budget
    const startIdx = scroll + 1
    const endIdx = Math.min(wrapped.length, scroll + budget)
    const rawTitle = scrollable
      ? `${opts.title} (${startIdx}-${endIdx}/${wrapped.length})`
      : opts.title
    // Ikon kategori 1 kolom HANYA di judul: baris isi adalah teks output
    // tak-terpercaya (tabel /help, status, potongan kode) — menghiasinya akan
    // menggeser kolom & mengubah makna. Fallback ASCII ditanggung `glyphs`.
    const titleText = `${glyphs.sessionIcon} ${rawTitle}`
    // Esc berada di pojok kanan atas judul; footer hanya memuat scroll/salin/peringatan.
    const extraHints: HintItem[] = [
      ...(idleWarned
        ? [{ key: "!", label: t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }) }]
        : []),
      ...(scrollable ? [{ key: glyphs.upDown, label: t("hint.scroll") }] : []),
      ...(opts.onCopy ? [{ key: "c", label: t("hint.copy") }] : []),
    ]
    const body = wrapped.slice(scroll, scroll + budget)
    // Konfirmasi salin jadi baris isi, BUKAN footer: footer wajib tetap
    // windowFooter supaya frame identik dengan jendela lain. NOTICE DI DEPAN:
    // dialogBox memotong ekor body bila isi panjang (clipped → baris terakhir
    // tak tampil), jadi meletakkannya di akhir membuat konfirmasi hilang tepat
    // pada output besar — justru saat payload terlalu besar perlu dilaporkan.
    const bodyWithNotice =
      copyNotice == null
        ? body
        : [
            copyNotice === tSystem("msg.copied") ? c.success(copyNotice) : c.warning(copyNotice),
            ...body.slice(0, Math.max(0, budget - 1)),
          ]
    const box = dialogBox(
      outputWindowSpec({
        title: titleText,
        body: bodyWithNotice,
        cols,
        rows,
        extraHints,
      }),
      cols,
      rows,
    )
    screen.paintRegion(box.lines, box.topRow)
    screen.setCursorVisible(false)
  }

  const idle = createIdleTimer({
    warnMs: IDLE_WARN_MS,
    cancelMs: IDLE_CANCEL_MS,
    onWarn: () => {
      idleWarned = true
      render()
    },
    onCancel: () => finish(true),
  })

  const finish = (ok = true): void => {
    if (done) return
    done = true
    clearCopyTimer()
    try {
      pump.dispose()
    } catch {}
    // Bracketed paste dimatikan di semua jalur tutup via writer output yang
    // sama (process.stdout dipakai screen.paintRegion).
    if (bracketedPasteOn) process.stdout.write("\x1b[?2004l")
    idle.dispose()
    try {
      process.stdin.removeListener("data", onData)
    } catch {}
    if (onResize) process.stdout.removeListener("resize", onResize)
    try {
      screen.clearRegion()
    } catch {}
    try {
      screen.close()
    } catch {}
    try {
      process.stdin.setRawMode(false)
    } catch {}
    resolve(ok)
  }

  let resolve!: (v: boolean) => void
  const result = new Promise<boolean>((r) => (resolve = r))

  const handleKeys = (keys: DecodedKey[]): boolean => {
    const usable = canRenderModal(screen.cols || 80, screen.rows || 24)
    if (usable) ensureWrapped(process.stdout.columns || 80)
    let dirty = false
    for (const d of keys) {
      dirty = true
      const k = d.key
      if (
        k.type === "esc" ||
        k.type === "ctrl-c" ||
        k.type === "ctrl-d" ||
        (k.type === "char" && (k.ch === "q" || k.ch === "Q"))
      ) {
        finish(true)
        return true
      }
      if (!usable) continue
      if (k.type === "enter") {
        finish(true)
        return true
      }
      if (k.type === "char" && (k.ch === "c" || k.ch === "C") && opts.onCopy) {
        const text = source.map((l) => stripAnsi(l)).join("\n")
        // Guard byte SAMA dengan /copy (cli/tui.ts): payload OSC 52 raksasa
        // bisa menggantung terminal. Laporkan "terlalu besar", bukan "gagal/
        // butuh TTY" yang keliru, dan jangan panggil onCopy sama sekali.
        if (clipboardByteLength(text) > MAX_CLIPBOARD_BYTES) {
          copyNotice = tSystem("msg.copyTooLarge")
        } else {
          const okCopy = opts.onCopy(text)
          copyNotice = okCopy ? tSystem("msg.copied") : tSystem("msg.copyFailed")
        }
        clearCopyTimer()
        copyTimer = setTimeout(() => {
          copyTimer = null
          copyNotice = null
          if (!done) render()
        }, 2000)
        if (typeof copyTimer === "object" && "unref" in copyTimer) copyTimer.unref()
        continue
      }
      copyNotice = null
      clearCopyTimer()
      if (k.type === "up" || (k.type === "char" && k.ch === "k")) {
        scroll = Math.max(0, scroll - 1)
      } else if (k.type === "down" || (k.type === "char" && k.ch === "j")) {
        scroll = Math.min(maxScroll(), scroll + 1)
      } else if (k.type === "wheelup") {
        scroll = Math.max(0, scroll - 3)
      } else if (k.type === "wheeldown") {
        scroll = Math.min(maxScroll(), scroll + 3)
      } else if (k.type === "pageup") {
        scroll = Math.max(0, scroll - Math.max(1, bodyBudget() - 1))
      } else if (k.type === "pagedown" || (k.type === "char" && k.ch === " ")) {
        scroll = Math.min(maxScroll(), scroll + Math.max(1, bodyBudget() - 1))
      } else if (k.type === "home") {
        scroll = 0
      } else if (k.type === "end") {
        scroll = maxScroll()
      }
    }
    if (dirty) {
      idleWarned = false
      idle.reset()
      render()
    }
    return false
  }
  const pump = createKeyStreamPump({ state: createDecoderState(), onKeys: handleKeys })

  onData = (chunk: Buffer) => {
    idleWarned = false
    idle.reset()
    try {
      pump.push(chunk)
    } catch {
      finish(true)
    }
  }
  onResize = () => render()

  try {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    // Aktifkan bracketed paste sejak jendela tampil; dekoder prompt-engine
    // menerima ESC[200~ … ESC[201~ sehingga CR di paste tak jadi submit.
    process.stdout.write("\x1b[?2004h")
    bracketedPasteOn = true
    process.stdin.on("data", onData)
    process.stdout.on("resize", onResize)
    idle.reset()
    render()
  } catch {
    // Setup gagal = jendela tak pernah tampil. Resolve false agar pemanggil
    // fallback mencetak output ke transkrip (data tidak hilang).
    finish(false)
  }
  return result
}
