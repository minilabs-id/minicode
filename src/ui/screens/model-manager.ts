// View model registry — pola popup komposit yang konsisten dengan picker/// provider-manager. Tetap shell-like: overlay sementara, hasil aksi tetap inline.

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { formatError } from "../render/errors.ts"
import type { HintItem } from "../render/hint.ts"
import { highlightMatch, tailFilterWindow } from "../render/list.ts"
import { type NoticeKind, paintNoticeLines } from "../render/notice.ts"
import { cleanUntrusted, sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { boxLeftPad, canRenderModal, dialogBox } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS, runForm } from "./form.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { runPicker } from "./picker.ts"
import { withTimeout } from "./watchdog.ts"
import { windowMaxHeight, windowSpec, windowWidth } from "./window.ts"

const dim = (s: string): string => c.dim(s)

export interface ModelRow {
  /** Format "providerId::model". */
  id: string
  active: boolean
  /** Effort tersimpan provider ini; absen/"default" = tanpa badge. */
  effort?: string
}

export interface ModelManagerViewOptions {
  initialRows: ModelRow[]
  /** Filter awal (dari `/model <cari>`) — null/"" = tanpa filter. */
  initialFilter?: string
  onSelect(id: string): void | Promise<void>
  /** Ambil baris terbaru setelah mutasi. */
  loadRows(): Promise<ModelRow[]>
  onDelete(id: string): Promise<ModelRow[]>
  onSetEffort?(id: string, effort: "default" | "low" | "medium" | "high"): Promise<ModelRow[]>
  /**
   * Opsi effort per model id ("provider::model" atau nama mentah) — untuk
   * picker yang jujur: keluarga tanpa thinking hanya ["default"] sehingga
   * picker dilewati dan effort tersimpan tak disentuh. Default (tanpa
   * injeksi): semua opsi, perilaku lama.
   */
  getEfforts?: (id: string) => ("default" | "low" | "medium" | "high")[]
  /**
   * Batas waktu aksi jaringan (ms) — DI untuk test (default 60 dtk).
   * Tanpa ini test watchdog menunggu semenit.
   */
  actionTimeoutMs?: number
}

/** Saring baris berdasarkan substring id, case-insensitive. Murni agar bisa diuji. */
export function filterModelRows(rows: ModelRow[], q: string): ModelRow[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => r.id.toLowerCase().includes(needle))
}

// v0.33: lebar/tinggi jendela diambil dari aturan seragam `window.ts`, bukan
// angka kaku milik /model. `windowSpec` membangun DialogSpec-nya supaya frame
// (judul + footer + ukuran) identik dengan /provider dan jendela lain — satu
// rumus, satu hierarki visual. Tetap dibaca saat render agar resize terasa.

export async function runModelManagerView(opts: ModelManagerViewOptions): Promise<void> {
  let rows = opts.initialRows // Mode cari: ketikan apa pun langsung jadi query. Hapus = tombol Del.
  // Esc keluar dari mode cari, bukan tutup manager. null = tak memfilter.
  let filter: string | null = null
  const initial = opts.initialFilter?.trim()
  if (initial) filter = initial
  const viewRows = (): ModelRow[] => (filter == null ? rows : filterModelRows(rows, filter))
  const clampSel = () => {
    sel = Math.min(Math.max(0, sel), Math.max(0, viewRows().length - 1))
  }
  let sel = Math.max(
    0,
    rows.findIndex((r) => r.active),
  )
  clampSel()
  let scroll = 0
  // Struk aksi transient: hasil delete/Canceled/error tampil sebagai baris
  // redup DALAM popup, bukan console.log ke scrollback. Dibersihkan tiap
  // keypress baru — terlihat sampai tombol berikut ditekan.
  let notice: string | null = null
  let noticeKind: NoticeKind = "info"
  let idleWarned = false

  return new Promise<void>((resolve) => {
    const width = () => Math.max(8, windowWidth(screen.cols || 80) - 4)
    const renderedNoticeLines = (): string[] =>
      notice ? paintNoticeLines(noticeKind, notice).flatMap((l) => wrapByWidth(l, width())) : []
    const visibleRows = () => {
      // windowMaxHeight = tinggi kotak maksimum (termasuk border+judul+jeda+footer).
      // Chrome = 6 baris: 2 border + judul + baris cari + jeda footer + footer.
      const maxBody = windowMaxHeight(screen.rows || 24) - 6
      return Math.max(1, Math.min(maxBody - renderedNoticeLines().length, 12))
    }

    // Isi MINIMAL dialog /model; footer dipin lewat `windowFooter` (windowSpec)
    // agar aman dari pemotongan saat notice error panjang membungkus banyak baris.
    const bodyLinesModal = (): { lines: string[]; filterShown: string; title: string } => {
      const list = viewRows()
      const v = visibleRows()
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const view = list.slice(scroll, scroll + v)
      const baseTitle = t("out.titleModels")
      const title =
        list.length > v
          ? `${baseTitle} (${scroll + 1}-${scroll + view.length}/${list.length})`
          : baseTitle
      const lines: string[] = []
      // Caret glyph blok statis dihapus — caret bar terminal (DECSCUSR `6 q`)
      // jadi satu-satunya penanda. `w - 3` = budget lama tanpa lebar glyph;
      // total lebar baris tetap w-1 dengan ruang caret di ujung filter.
      const filterBudget = Math.max(4, w - 3)
      const filterShown = tailFilterWindow(filter ?? "", filterBudget)
      lines.push(cut(`${dim(">")} ${c.brightCyan(filterShown)}`))
      if (!list.length) {
        lines.push(cut(dim(`  ${filter == null ? t("model.empty") : t("model.noMatch")}`)))
      } else {
        for (let i = 0; i < view.length; i++) {
          const row = view[i]!
          const picked = i === sel - scroll
          const badge = row.effort && row.effort !== "default" ? ` [${row.effort}]` : ""
          // Penanda effort & aktif ditaruh bersama di luar truncasi nama agar
          // status maupun badge thinking selamat di terminal sempit.
          const active = row.active ? ` (${t("common.active")})` : ""
          const suffix = `${badge}${active}`
          const iconPart = `${glyphs.modelIcon} `
          const avail = Math.max(0, w - 4 - displayWidth(iconPart))
          const nameBudget = Math.max(1, avail - displayWidth(suffix))
          const baseName = `${iconPart}${truncateToWidth(sanitizeAnsiLine(row.id), nameBudget, glyphs.ellipsis)}`
          // Kolom marker dipakai bersama (highlightMatch / listRow): sorot filter
          // di nama model tanpa merusak suffix effort/active.
          lines.push(highlightMatch(baseName, filter ?? "", picked, suffix))
        }
      }
      for (const line of renderedNoticeLines()) lines.push(cut(line))
      return { lines, filterShown, title }
    }

    const render = () => {
      const cols = screen.cols || 80
      const rows = screen.rows || 24
      // Jaga layar ekstrem (< 20×4) agar tak menggambar kotak korup; baris ≥ 5
      // tetap dirender dengan footer ter-pin (dikunci model-manager-flows.test).
      if (cols < 20 || rows < 4) {
        screen.paintRegion(
          [c.warning(truncateToWidth(tSystem("msg.tooSmall"), Math.max(1, cols - 2)))],
          Math.max(1, Math.floor(rows / 2)),
        )
        screen.setCursorVisible(false)
        return
      }
      const { lines, filterShown, title } = bodyLinesModal()
      // Navigasi (↑↓ / Enter / Esc) disuplai windowFooter; hanya aksi khusus
      // /model yang dikirim sebagai extraHints. Saat filter aktif Del dipakai
      // untuk mengedit query, jadi jangan diiklankan sebagai hapus model.
      const extraHints: HintItem[] = [
        ...(idleWarned
          ? [{ key: "!", label: t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }) }]
          : []),
        { key: "Tab", label: t("hint.effort") },
        ...(filter == null ? [{ key: "Del", label: t("hint.delete") }] : []),
      ]
      // Region kotak di atas transkrip; lebar/tinggi mengikuti terminal saat
      // resize lewat aturan seragam windowSpec.
      const box = dialogBox(
        windowSpec({
          title,
          body: lines,
          cols: screen.cols,
          rows: screen.rows,
          extraHints,
        }),
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Parkir caret bar tepat di ujung filter di dalam kotak dan blok sync-update.
      try {
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
      } catch {}
    }

    // Popup butuh layar mampu; selain itu tolak BERSUARA + batal.
    const screen: AltScreen = openAltScreen()
    const useModal =
      screen.ok && canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiModel")}`)
      } catch {}
      // Tutup layar sebelum batal: openAltScreen sudah menulis ENTER fisik —
      // bail tanpa close membocorkan alt-screen + hold painter (I27).
      try {
        screen.close()
      } catch {}
      resolve()
      return
    }

    let busy = false
    let done = false
    /** Listener stdin terpasang? Menjaga resume() idempoten (anti-ganda). */
    let attached = false
    // Bun Windows: raw-mode yang ditahan tanpa input rawan digenggam selamanya
    // (lihat idleTimer 90 dtk di picker.ts — segfault setelah 133 dtk idle).
    // Manager ini sebelumnya TANPA idleTimer: bila stdin 'data' tak pernah
    // datang (ConPTY macet/fokus hilang/busy bocor), Promise tak pernah settle
    // dan raw-mode dipegang selamanya = "masuk list model macet". Samakan
    // dengan picker: idle 90 dtk = batal otomatis (helper bersama, audit D1).
    // `finish` dirujuk sebagai closure — dievaluasi saat timer fire.
    const idle = createIdleTimer({
      warnMs: IDLE_WARN_MS,
      cancelMs: IDLE_CANCEL_MS,
      onWarn: () => {
        idleWarned = true
        render()
      },
      onCancel: () => finish(),
    })

    const suspend = () => {
      idle.clear()
      attached = false
      // Hapus kotak induk sebelum sub-modal (effort picker / form konfirmasi)
      // tampil agar bingkai tidak tumpang-tindih; saat finish `done` sudah true.
      if (!done) {
        try {
          screen.clearRegion()
        } catch {}
        screen.setCursorVisible(false)
      }
      // TANPA pause — stdin mengalir seumur proses (lihat cleanup askLine).
      try {
        process.stdin.setRawMode(false)
      } catch {}
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize)
      } catch {}
    }

    const resume = () => {
      if (done) return
      // Idempoten: tanpa garda, resume ganda (mis. watchdog timeout lalu
      // aksi telat selesai) memasang listener stdin DUA kali → tiap tombol
      // diproses ganda. Gagal-di-kode-lama.
      if (!attached) {
        process.stdin.setMaxListeners(0)
        try {
          process.stdin.setRawMode(true)
        } catch {
          // Raw-mode gagal (ConPTY Windows) = tak bisa baca tombol; lebih baik
          // tutup jujur daripada gantung dengan layar mati.
          finish()
          return
        }
        process.stdin.resume()
        process.stdin.on("data", onData)
        process.stdout.on("resize", onResize)
        attached = true
      }
      // Sub-dialog (runForm / runPicker) mematikan bracketed paste saat selesai;
      // aktifkan lagi saat kendali kembali ke manager.
      try {
        screen.setBracketedPaste?.(true)
      } catch {}
      render()
      idle.reset()
    }

    const finish = () => {
      if (done) return
      done = true
      idle.dispose()
      // Kembalikan batas listener warisan (lihat prevMaxListeners): warning
      // MaxListenersExceeded kembali berguna setelah sesi ini selesai.
      try {
        managerPump.dispose()
      } catch {}
      try {
        process.stdin.setMaxListeners(prevMaxListeners)
      } catch {}
      // Hapus region popup sendiri sebelum pemilik me-repaint (App.resume).
      try {
        screen.setBracketedPaste?.(false)
      } catch {}
      try {
        screen.clearRegion()
      } catch {}
      try {
        screen.close()
      } catch {}
      // suspend() tak boleh menggagalkan resolve: setRawMode bisa melempar
      // di Windows bila handle sudah rusak — tanpa try/finally Promise gantung
      // selamanya (resolve tak tercapai).
      try {
        suspend()
      } catch {
      } finally {
        resolve()
      }
    }

    const runAction = (fn: () => Promise<void>) =>
      (async () => {
        if (busy) return
        busy = true
        suspend()
        try {
          await fn()
        } catch (e) {
          // Formatter kanonik: redaksi credential + saran tindakan. Notice
          // error dirender merah oleh paintNoticeLines (bukan teks redup).
          notice = formatError(e)
          noticeKind = "error"
        } finally {
          busy = false
          await loadRowsSafe()
          resume()
        }
      })()

    /**
     * Batas waktu aksi jaringan (onDelete/onSelect/onSetEffort): provider/tool
     * non-kooperatif yang gantung selamanya membuat popup mati (suspend tanpa
     * listener/timer). Timeout = notice jujur + UI pulih; aksi telat yang
     * akhirnya selesai diabaikan hasilnya (tanpa resolve ganda — resolve
     * hanya lewat finish alur normal). Bisa dioverride test via opts.
     */
    const withWatchdog = <T>(fn: () => Promise<T> | T): Promise<T> =>
      withTimeout(fn, opts.actionTimeoutMs ?? 60_000)

    const loadRowsSafe = async () => {
      try {
        rows = await opts.loadRows()
      } catch {}
      clampSel()
    }

    const deleteModel = () => {
      const row = viewRows()[sel]
      if (!row) return
      return runAction(async () => {
        // Model AKTIF yang dihapus membuat prompt berikutnya kehilangan model
        // tanpa sebab yang terlihat — sebutkan. Konfirmasi dalam popup.
        const form = await runForm(
          {
            title: t("model.deleteTitle"),
            fields: [
              {
                id: "ok",
                label: row.active
                  ? t("model.delActive", { id: row.id })
                  : t("model.del", { id: row.id }),
                kind: "confirm",
              },
            ],
            footerHints: [
              { key: `${glyphs.leftRight}/y/n`, label: t("hint.select") },
              { key: "Enter", label: t("hint.delete") },
            ],
          },
          screen,
        )
        if (!form.cancelled && form.values?.ok === "y") {
          rows = await withWatchdog(() => opts.onDelete(row.id))
          notice = t("ntc.deleted", { id: row.id })
          noticeKind = "success"
        } else {
          notice = t("common.canceled")
          noticeKind = "info"
          rows = await withWatchdog(() => opts.loadRows())
        }
        clampSel()
      })
    }

    // Picker effort dipakai alur Enter — HANYA bila modelnya mendukung
    // (lihat callback `opts.getEfforts`): model tanpa thinking langsung select tanpa
    // picker dan tanpa menyentuh effort tersimpan. Dipanggil saat manager
    // di-suspend, sehingga raw mode/lisener milik picker, bukan manager.
    const pickEffort = (
      modelId: string,
    ): Promise<"default" | "low" | "medium" | "high" | null | "skip"> => {
      const options = opts.getEfforts?.(modelId) ?? ["default", "low", "medium", "high"]
      if (options.length <= 1) return Promise.resolve("skip")
      return new Promise<string | null>((resolvePick) => {
        // Fail-closed: runPicker non-TTY kini memanggil onCancel, tapi bila
        // runPicker melempar/menolak sebelum itu, resolve null agar busy tak
        // bocor true selamanya (= manager terkunci, terlihat hang).
        try {
          void runPicker({
            title: t("effort.title"),
            showTitle: true,
            screen,
            items: options.map((name) => ({ name, provider: "", value: name })),
            onPick: (v) => resolvePick(v),
            onCancel: () => resolvePick(null),
          }).catch(() => resolvePick(null))
        } catch {
          resolvePick(null)
        }
      }).then((picked) =>
        picked && ["default", "low", "medium", "high"].includes(picked)
          ? (picked as "default" | "low" | "medium" | "high")
          : null,
      )
    }

    const decoder: DecoderState = createDecoderState()
    // Batas listener warisan SEBELUM dimatikan: setMaxListeners(0) menutupi
    // kebocoran listener masa depan secara global — simpan & kembalikan di
    // finish agar warning Node kembali berguna setelah sesi ini.
    // Guard typeof: stdin bisa stub (test) tanpa API ini — anggap default 10.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    const handleManagerKeys = (keys: DecodedKey[]): boolean => {
      if (busy || done) return true
      if (!keys.length) return false
      try {
        // Struk lama dibersihkan tiap keypress baru (transient, bukan arsip).
        notice = null
        noticeKind = "info"
        for (const item of keys) {
          // Mode cari: semua ketikan masuk ke query, Esc keluar dari mode
          // cari — bukan tutup manager.
          if (filter != null) {
            if (item.key.type === "esc") {
              filter = null
              sel = 0
              scroll = 0
              continue
            }
            if (item.key.type === "char") {
              filter += item.key.ch
              sel = 0
              scroll = 0
              continue
            }
            if (item.key.type === "ctrl-u") {
              // Ctrl+U = kosongkan query tapi TETAP di mode saring (paritas
              // readline kill-line + picker). Dulu null (keluar mode) — beda
              // dari picker yang tetap di mode filter setelah Ctrl+U.
              filter = ""
              sel = 0
              scroll = 0
              continue
            }
            // Backspace & Del sama-sama memangkas query (tanpa kursor,
            // Del maju = grapheme terakhir juga). Query habis = keluar mode.
            // toGraphemes: emoji/flag utuh (paritas picker/form/askLine).
            if (item.key.type === "backspace" || item.key.type === "delete") {
              const g = toGraphemes(filter)
              g.pop()
              filter = g.join("")
              if (!filter) filter = null
              sel = 0
              scroll = 0
              continue
            }
          } else if (
            item.key.type === "esc" ||
            item.key.type === "ctrl-c" ||
            item.key.type === "ctrl-d"
          ) {
            finish()
            return true
          }
          if (item.key.type === "up" || item.key.type === "wheelup") sel = Math.max(0, sel - 1)
          else if (item.key.type === "down" || item.key.type === "wheeldown") {
            const n = viewRows().length
            sel = n ? Math.min(n - 1, sel + 1) : 0
          } else if (item.key.type === "home") {
            // Home/End = lompat atas/bawah daftar (paritas picker/App).
            sel = 0
            scroll = 0
          } else if (item.key.type === "end") {
            const n = viewRows().length
            sel = n ? Math.max(0, n - 1) : 0
          } else if (item.key.type === "pageup" || item.key.type === "pagedown") {
            // Scroll daftar per halaman (paritas picker/App). Gagal-di-kode-lama:
            // memakai panjang LIST sebagai jatah visible → kondisi tak pernah
            // benar → PgUp/PgDn mati total.
            const list = viewRows()
            const v = visibleRows()
            if (list.length > v) {
              const page = Math.max(1, v - 1)
              const dir = item.key.type === "pageup" ? -page : page
              scroll = Math.max(0, Math.min(Math.max(0, list.length - v), scroll + dir))
              sel = Math.max(0, Math.min(list.length - 1, sel))
              if (sel < scroll) sel = scroll
              if (sel >= scroll + v) sel = scroll + v - 1
            }
          } else if (item.key.type === "enter") {
            const row = viewRows()[sel]
            if (!row) return true // daftar kosong: jangan tutup (footer bilang select)
            if (busy) return true
            busy = true
            suspend()
            // B4 (audit UI/UX): Enter = SATU langkah — pilih & simpan model
            // langsung. Picker effort tidak lagi langkah wajib tiap Enter
            // (dulu: Esc di effort = batal total, dua tekan untuk ganti model).
            // Effort kini aksi terpisah lewat Tab (lihat cabang `tab` di bawah).
            ;(async () => {
              try {
                await withWatchdog(() => opts.onSelect(row.id))
                finish()
              } catch (e) {
                // Pilih model yang gagal HARUS terlihat dan kembali ke daftar
                // untuk retry (pola resume() seperti a/d/e provider-manager),
                // bukan menutup manager dan kehilangan konteks daftar.
                notice = formatError(e)
                noticeKind = "error"
                busy = false
                await loadRowsSafe()
                resume()
              }
            })()
            return true
          } else if (item.key.type === "tab") {
            // B4: ubah thinking effort TANPA mengganti model. Tab = aksi
            // eksplisit (bukan langkah wajib), Esc pada picker = batal dan
            // kembali ke daftar — manajer tidak pernah menutup diri di sini.
            const row = viewRows()[sel]
            if (!row || busy || !opts.onSetEffort) return true
            if (!canRenderModal(screen.cols || 80, screen.rows || 24)) {
              // Sub-picker butuh ukuran modal minimum; tanpa garda ini error
              // terminal sempit tertelan captureConsole dan tampak membisu.
              notice = t("gate.tuiModel")
              noticeKind = "error"
              render()
              return true
            }
            busy = true
            suspend()
            ;(async () => {
              try {
                const picked = await pickEffort(row.id)
                if (picked === "skip") {
                  // Keluarga tanpa thinking: sebelumnya cabang ini diam total —
                  // user menekan Tab, layar tak berubah, dan itu terbaca sebagai
                  // "minicode macet". Nyatakan alasannya, tetap di daftar.
                  notice = t("effort.noThinking")
                  noticeKind = "info"
                } else if (picked) {
                  await withWatchdog(() => opts.onSetEffort!(row.id, picked))
                  // Notice terlihat di daftar (manager tetap terbuka) —
                  // inilah kehidupan baru `effort.saved` setelah A5.
                  notice = t("effort.saved", { effort: picked })
                  noticeKind = "success"
                }
                busy = false
                await loadRowsSafe()
                resume()
              } catch (e) {
                notice = formatError(e)
                noticeKind = "error"
                busy = false
                await loadRowsSafe()
                resume()
              }
            })()
            return true
          } else if (item.key.type === "delete") {
            // Di sini filter selalu null (mode cari ditangani di atas):
            // hapus model ter-highlight (dengan konfirmasi di deleteModel).
            void deleteModel()
            return true
          } else if (item.key.type === "char") {
            // Ketik langsung menyaring — tanpa awalan apa pun.
            filter = item.key.ch
            sel = 0
            scroll = 0
          }
        }
        render()
        return false
      } catch {
        finish()
        return true
      }
    }
    const managerPump = createKeyStreamPump({ state: decoder, onKeys: handleManagerKeys })
    const onData = (chunk: Buffer) => {
      idleWarned = false
      idle.reset()
      try {
        managerPump.push(chunk)
      } catch {
        finish()
      }
    }

    const onResize = () => render()

    screen.setCursorVisible(false)
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setMaxListeners(0)
      screen.setBracketedPaste?.(true)
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      attached = true
      idle.reset()
      render()
    } catch (e) {
      // Setup gagal = tutup + BERSUARA (Fase D): jendela kosong bisu adalah
      // kelas bug yang hanya bisa diburu bila terlihat.
      try {
        finish()
      } catch {}
      try {
        // Pesan error bisa memuat body jaringan (tak-terpercaya): sanitasi
        // sebelum ditulis ke stdout agar escape tak membersihkan layar.
        console.log(
          `⚠ ${t("model.failOpen", {
            msg: cleanUntrusted(String((e as Error)?.message ?? e), !!process.stdout.isTTY),
          })}`,
        )
      } catch {}
    }
  })
}
