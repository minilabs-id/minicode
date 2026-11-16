// Modal picker - searchable, VS Code palette

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { hintLine } from "../render/hint.ts"
import { listRow, tailFilterWindow } from "../render/list.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, canRenderModal, dialogBox, popupBoxWidth } from "./dialog.ts"
import { createIdleTimer } from "./lifecycle.ts"

export interface PickerItem {
  name: string
  provider: string
  value: string
}

export interface PickerOptions {
  title: string
  items: PickerItem[]
  onPick: (value: string) => void
  onCancel: () => void
  filterable?: boolean
  /** Tampilkan judul di kotak (khusus wizard yang butuh indikator step). */
  showTitle?: boolean
  /** Screen induk (nested popup memakai handle yang sama — anti-tearing). */
  screen?: AltScreen
}

const dim = (s: string): string => c.dim(s)

// Tandai substring query di label agar user tahu KENAPA item cocok.
// Pakai warna foreground saja (bukan bold \x1b[22m) agar atribut bold/dim dari
// pemanggil tidak padam untuk sisa teks setelah bagian yang cocok.
function highlightMatch(label: string, query: string, selected: boolean): string {
  const paintBase = (s: string): string => (selected ? c.accent(c.bold(s)) : c.dim(s))
  const paintHit = (s: string): string => (selected ? c.brightCyan(c.bold(s)) : c.dim(c.info(s)))
  const idx = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1
  const prefix = selected ? `  ${c.accent(glyphs.arrow)} ` : "    "
  if (idx < 0) return `${prefix}${paintBase(label)}`
  const before = label.slice(0, idx)
  const hit = label.slice(idx, idx + query.length)
  const after = label.slice(idx + query.length)
  return `${prefix}${before ? paintBase(before) : ""}${paintHit(hit)}${after ? paintBase(after) : ""}`
}

export async function runPicker(opts: PickerOptions): Promise<void> {
  if (!process.stdin.isTTY) {
    // Pipe/redirect: item dari config (tak-terpercaya) disanitasi agar ANSI
    // mentah tak mencemari output program (kontrak stdout non-TTY).
    for (const it of opts.items) {
      const provider = sanitizeAnsiLine(it.provider)
      const name = sanitizeAnsiLine(it.name)
      console.log(provider ? `${provider}::${name}` : name)
    }
    // Fail-closed: pemanggil nested (mis. pickEffort di /model) menunggu
    // onPick/onCancel — tanpa ini await-nya gantung selamanya (busy=true)
    // saat isTTY flip di tengah. Non-TTY = tak ada pilihan = batal.
    try {
      opts.onCancel()
    } catch {}
    return
  }

  return new Promise<void>((resolve) => {
    let sel = 0
    let scroll = 0
    let filter = ""
    const isFilterable = opts.filterable ?? false
    const showTitle = opts.showTitle === true
    const ownScreen = !opts.screen
    const screen: AltScreen = opts.screen ?? openAltScreen()
    // Lebar dinamis terhadap terminal saat render/resize (tetap stabil saat filter).
    const boxWidth = () => popupBoxWidth(screen.cols || 80)

    const filteredItems = (): PickerItem[] => {
      if (!isFilterable || !filter) return opts.items
      const q = filter.toLowerCase()
      return opts.items.filter(
        (it) => it.name.toLowerCase().includes(q) || it.provider.toLowerCase().includes(q),
      )
    }

    // Lebar/tinggi mengikuti terminal SUNGGUHAN.
    //
    // Sebelumnya keduanya punya lantai minimum (`Math.max(44, …)` dan
    // `Math.max(4, …)`) yang MENGABAIKAN terminal lebih kecil: pada 40 kolom
    // label 55 kolom tetap digambar, dan pada rows=3 overlay 6 baris tetap
    // dicetak — keduanya membungkus dan merusak tampilan.
    const visibleRows = () => {
      const rows = process.stdout.rows || 24
      // Modal: border + (judul bila diminta) + baris pencarian (bila ada) +
      // satu baris hint aksi di dasar.
      const titleRows = showTitle ? 1 : 0
      if (useModal) {
        const chrome = (isFilterable ? 4 : 3) + titleRows
        return Math.max(1, Math.min(rows - chrome, 12))
      }
      const chrome = (isFilterable ? 4 : 3) + titleRows
      return Math.max(1, Math.min(rows - chrome, 12))
    }
    // Lebar konten = lebar kotak (dibekukan saat mount) dikurangi chrome dialog
    // (border+padding = 4 kolom) agar dialogBox tak memotong ulang label.
    const width = () => Math.max(8, boxWidth() - 4)

    // Isi untuk dialog popup (hint dipasung di `spec.footer` agar tak pernah
    // ikut terpotong clipping dialogBox saat terminal menyusut).
    const bodyLines = (): { lines: string[]; footer: string; filterShown: string } => {
      const items = filteredItems()
      const v = visibleRows()
      // Hint akurat per mode: Esc pertama mengosongkan filter (bukan menutup).
      const footer = hintLine([
        { key: glyphs.upDown, label: t("hint.move") },
        { key: "Enter", label: t("hint.select") },
        {
          key: "Esc",
          label: filter ? t("hint.clear") : t("hint.cancel"),
        },
      ])
      if (sel >= items.length) sel = Math.max(0, items.length - 1)
      if (sel < 0) sel = 0
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      if (items.length === 0) scroll = 0
      const rows = items.slice(scroll, scroll + v)
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const lines: string[] = []
      let filterShown = ""
      if (isFilterable) {
        // Filter = input user tak terpercaya — sanitasi + windowing agar muat.
        const budget = Math.max(4, w - 3 - displayWidth(glyphs.caret))
        filterShown = filter ? tailFilterWindow(filter, budget) : ""
        const display = filterShown ? c.brightCyan(filterShown) : ""
        lines.push(cut(`${dim(">")} ${display}${c.accent(glyphs.caret)}`))
      }
      if (items.length === 0) {
        lines.push(cut(dim(`  ${t("pick.noMatch", { q: sanitizeAnsiLine(filter) })}`)))
        return { lines, footer, filterShown }
      }
      for (let i = 0; i < rows.length; i++) {
        const it = rows[i]!
        const picked = i === sel - scroll
        // Label provider::model ringkas; teks tetap disanitasi sebelum truncate.
        const safeProvider = sanitizeAnsiLine(it.provider)
        const rawLabel = safeProvider
          ? `${safeProvider}::${sanitizeAnsiLine(it.name)}`
          : sanitizeAnsiLine(it.name)
        // Marker `…` agar pemotongan tidak diam-diam (kontrak OUTPUT_UX §10).
        const truncated = truncateToWidth(rawLabel, Math.max(4, w - 4), glyphs.ellipsis)
        lines.push(filter ? highlightMatch(truncated, filter, picked) : listRow(truncated, picked))
      }
      return { lines, footer, filterShown }
    }

    const render = () => {
      const { lines, footer, filterShown } = bodyLines()
      const w = boxWidth()
      // Popup komposit: HANYA region kotak yang dilukis (tanpa clear) di atas
      // konten pemilik layar (transkrip App / alt-buffer wizard).
      const box = dialogBox(
        {
          title: showTitle ? opts.title : "",
          body: lines,
          footer,
          minWidth: w,
          maxWidth: w,
        },
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir kursor pada input filter; picker tanpa ketikan sembunyikan kursor.
      try {
        if (isFilterable) {
          const li = Math.min(box.lines.length - 1, box.bodyTop)
          const row = box.topRow + li
          const leftPad = boxLeftPad(stripAnsi(box.lines[li] ?? ""))
          const maxCol = leftPad + 2 + width() + 1
          const col = Math.max(
            1,
            Math.min(
              screen.cols || 80,
              maxCol,
              leftPad + 4 + displayWidth(stripAnsi(filterShown)) + 1,
            ),
          )
          screen.moveCursor(row, col)
        } else {
          screen.setCursorVisible(false)
        }
      } catch {}
    }

    let done = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    // Bun 1.4.0 Windows: raw-mode yang ditahan >60 dtk rawan segfault
    // (lihat laporan `panic: Segmentation fault at address 0xA0D` setelah
    // 133 dtk idle di picker). Timer idle 90 dtk auto-batal agar raw-mode
    // tidak digenggam selamanya — tanpa ini picker bisa crash Bun sebelum
    // user menekan apa pun. Bukan perubahan perilaku: idle sepanjang itu
    // memang harusnya batal. Satu sumber idle via helper bersama (audit D1).
    // `cleanup`/`resolve` dirujuk sebagai closure (dievaluasi saat timer fire).
    const idle = createIdleTimer({
      cancelMs: 90_000,
      onCancel: () => {
        cleanup()
        opts.onCancel()
        resolve()
      },
    })
    const decoder: DecoderState = createDecoderState()
    // Seperti manager: simpan batas listener warisan (guard: stdin stub test
    // tak punya getMaxListeners), kembalikan di cleanup agar warning Node
    // tetap berguna setelah sesi ini.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    // Popup komposit: layar HARUS mampu (alt-screen + cukup tinggi). Tanpa
    // itu tak ada permukaan popup — tolak BERSUARA + batal (fail-closed).
    // Jalur overlay inline dihapus: satu-satunya tampilan interaktif adalah
    // TUI fullscreen (atau alt-buffer wizard first-run).
    const useModal =
      screen.ok && canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiPicker", { title: opts.title })}`)
      } catch {}
      try {
        opts.onCancel()
      } catch {}
      // Tutup layar sebelum batal hanya bila picker membukanya sendiri:
      // screen milik pemanggil tetap menjadi tanggung jawab pemanggil.
      if (ownScreen) {
        try {
          screen.close()
        } catch {}
      }
      resolve()
      return
    }
    const cleanup = () => {
      if (done) return
      done = true
      try {
        pickerPump.dispose()
      } catch {}
      try {
        process.stdin.setMaxListeners(prevMaxListeners)
      } catch {}
      idle.dispose()
      // Hapus region popup sendiri; pemilik layar (App.resume) repaint penuh,
      // standalone membuang alt-buffer + memulihkan kursor via close().
      try {
        screen.clearRegion()
      } catch {}
      if (ownScreen) {
        try {
          screen.close()
        } catch {}
      }
      // TIDAK menulis \r\n di sini: \r\n membuat baris kosong permanen tiap
      // picker dipakai — terlihat sebagai gap saat picker nested di dalam
      // manager (mis. Enter → Thinking effort di /model).
      try {
        process.stdin.setRawMode(false)
      } catch {}
      // Tanpa pause — stdin mengalir seumur proses (lihat cleanup askLine).
      if (onData) process.stdin.removeListener("data", onData)
      if (onResize) process.stdout.removeListener("resize", onResize)
    }

    // Jalur tunggal key (sinkron + flush lone-ESC 50ms via pump): panah split
    // tak lagi jadi esc (filter terhapus + picker tertutup). True = selesai.
    const handlePickerKeys = (keys: DecodedKey[]): boolean => {
      for (const d of keys) {
        const items = filteredItems()
        switch (d.key.type) {
          case "up":
          case "wheelup":
            sel = Math.max(0, sel - 1)
            render()
            break
          case "down":
          case "wheeldown":
            // Daftar kosong: jangan biarkan sel=-1 (Enter setelah Down lalu
            // filter menghadirkan 1 item akan menunjuk items[-1]=undefined →
            // onCancel padahal ada hasil ter-highlight).
            sel = items.length ? Math.min(items.length - 1, sel + 1) : 0
            render()
            break
          case "char": {
            if (isFilterable) {
              filter += d.key.ch
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "backspace": {
            if (isFilterable && filter.length > 0) {
              // Hapus satu grapheme (filter bisa berisi emoji/flag).
              const graphemes = toGraphemes(filter)
              graphemes.pop()
              filter = graphemes.join("")
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "delete": {
            // Del = edit-teks di semua permukaan (paritas Backspace).
            if (isFilterable && filter.length > 0) {
              const graphemes = toGraphemes(filter)
              graphemes.pop()
              filter = graphemes.join("")
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "ctrl-u": {
            // Ctrl+U = clear filter (paritas editor).
            if (isFilterable && filter.length > 0) {
              filter = ""
              sel = 0
              scroll = 0
              render()
            }
            break
          }
          case "home": {
            // Home/End = lompat atas/bawah daftar (paritas daftar App).
            sel = 0
            scroll = 0
            render()
            break
          }
          case "end": {
            sel = items.length ? Math.max(0, items.length - 1) : 0
            render()
            break
          }
          case "pageup":
          case "pagedown": {
            // Scroll daftar (… N more) per halaman memakai visibleRows() konsisten.
            const vis = visibleRows()
            if (items.length > vis) {
              const page = Math.max(1, vis - 1)
              const maxScroll = Math.max(0, items.length - vis)
              scroll = Math.max(
                0,
                Math.min(maxScroll, scroll + (d.key.type === "pageup" ? -page : page)),
              )
              sel = Math.max(0, Math.min(items.length - 1, sel))
              if (sel < scroll) sel = scroll
              if (sel >= scroll + vis) sel = scroll + vis - 1
              render()
            }
            break
          }
          case "enter": {
            const item = items[sel]
            // Perilaku dipertahankan: tanpa hasil, Enter = batal (dikunci
            // test). Bug yang diperbaiki adalah sel=-1 setelah Down di
            // daftar kosong — item "phantom" yang batal padahal ada hasil.
            cleanup()
            if (item) opts.onPick(item.value)
            else opts.onCancel()
            resolve()
            return true
          }
          case "esc": {
            // Esc pertama membersihkan filter; Esc kedua (filter kosong) keluar.
            if (isFilterable && filter.length > 0) {
              filter = ""
              sel = 0
              scroll = 0
              render()
              break
            }
            cleanup()
            opts.onCancel()
            resolve()
            return true
          }
          case "ctrl-c":
          case "ctrl-d":
            cleanup()
            opts.onCancel()
            resolve()
            return true
          default:
            break
        }
      }
      return false
    }
    const pickerPump = createKeyStreamPump({ state: decoder, onKeys: handlePickerKeys })

    onData = (chunk: Buffer) => {
      idle.reset()
      try {
        pickerPump.push(chunk)
      } catch (e) {
        // Tanpa onCancel+resolve, await runPicker gantung selamanya dan
        // busy=true bocor di pemanggil nested (= manager terkunci, terlihat
        // hang). Batal adalah satu-satunya jawaban jujur saat render rusak.
        // Kegagalan ikut BERSUARA (prinsip Fase D: tak ada jendela bisu).
        try {
          cleanup()
        } catch {}
        try {
          console.log(
            `⚠ ${t("pick.fail", {
              msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
            })}`,
          )
        } catch {}
        try {
          opts.onCancel()
        } catch {}
        resolve()
      }
    }

    onResize = () => render()

    screen.setCursorVisible(false)
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setMaxListeners(0)
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      idle.reset()
      render()
    } catch (e) {
      // Sama seperti di atas: setup gagal (raw-mode ConPTY rusak) harus
      // settle, bukan gantung. Kegagalan BERSUARA (satu baris scrollback),
      // bukan bisu — kelas bug "jendela kosong" hanya bisa diburu bila terlihat.
      try {
        cleanup()
      } catch {}
      try {
        console.log(
          `⚠ ${t("pick.failOpen", {
            msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
          })}`,
        )
      } catch {}
      try {
        opts.onCancel()
      } catch {}
      resolve()
    }
  })
}
