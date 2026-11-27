// Provider Manager window — VS Code palette. Murni presentasi: render daftar,
// loop keyboard, dan dialog a/d/e; semua akses config lewat callback yang
// di-inject controller (cli/provider-manager.ts).

import { t } from "../i18n/locale.ts"
import {
  createDecoderState,
  createKeyStreamPump,
  type DecodedKey,
  type DecoderState,
} from "../input/prompt-engine.ts"
import { formatError } from "../render/errors.ts"
import type { HintItem } from "../render/hint.ts"
import { listRow } from "../render/list.ts"
import { type NoticeKind, paintNoticeLines } from "../render/notice.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import { displayWidth, truncateToWidth, wrapByWidth } from "../render/width.ts"
import { type AltScreen, openAltScreen } from "../runtime/screen.ts"
import { canRenderModal, dialogBox } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS, runForm, validateRequired, validateUrl } from "./form.ts"
import { attachProgressCancel, createIdleTimer } from "./lifecycle.ts"
import { withTimeout } from "./watchdog.ts"
import { windowMaxHeight, windowSpec, windowWidth } from "./window.ts"

const dim = (s: string): string => c.dim(s)

// v0.33: pakai aturan jendela seragam `window.ts` (sama seperti /model).
// Dulu lebar/tinggi dihitung sendiri di sini sehingga /provider bisa beda
// frame dari jendela lain; kini `windowSpec` jadi satu sumber ukuran + footer.

export interface ProviderRow {
  id: string
  baseUrl: string
  models: number
  hint?: string
  firstModel?: string
}

export interface ProviderPresetView {
  id: string
  label: string
  baseUrl: string
}

export interface ProviderActionResult {
  ok?: string
  err?: string
}

export interface ProviderManagerViewOptions {
  initialRows: ProviderRow[]
  presets?: readonly ProviderPresetView[]
  currentModel?: string
  /** Bacaan live model aktif agar penanda `(active)` selalu segar setelah select. */
  getCurrentModel?: () => string | undefined
  /** true bila ada cwd — dialog tambah menawarkan scope global/lokal. */
  askScope: boolean
  onSelect(row: ProviderRow): void
  /** Ambil baris terbaru dari controller setelah tiap aksi. */
  loadRows(): Promise<ProviderRow[]>
  onAdd(
    input: {
      preset?: ProviderPresetView
      baseUrl: string
      apiKey: string
      scope: "global" | "local"
    },
    signal?: AbortSignal,
  ): Promise<ProviderActionResult>
  onDelete(row: ProviderRow): Promise<ProviderActionResult>
  onEditDefaults(row: ProviderRow): Promise<{ baseUrl: string; apiKey: string } | null>
  onEditSave(
    row: ProviderRow,
    input: { baseUrl: string; apiKey: string },
    signal?: AbortSignal,
  ): Promise<ProviderActionResult>
  /**
   * Batas waktu aksi jaringan (ms) — DI untuk test (default 60 dtk).
   * Tanpa ini test watchdog menunggu semenit.
   */
  actionTimeoutMs?: number
}

export async function runProviderManagerView(opts: ProviderManagerViewOptions): Promise<void> {
  let providers: ProviderRow[] = opts.initialRows
  let sel = 0
  let scroll = 0
  // Struk aksi transient: hasil/Canceled/error tampil sebagai baris redup
  // DALAM popup, bukan console.log ke scrollback. Dibersihkan tiap keypress
  // baru. Pengecualian sadar: "Detecting models…" (progres jaringan saat
  // popup tersuspend — tanpa itu tunggu terasa hang).
  let notice: string | null = null
  let noticeKind: NoticeKind = "info"
  let idleWarned = false

  async function reload() {
    providers = await opts.loadRows()
    if (sel >= providers.length) sel = Math.max(0, providers.length - 1)
    if (scroll > sel) scroll = sel
  }

  return new Promise<void>((resolve) => {
    const width = () => Math.max(8, windowWidth(screen.cols || 80) - 4)
    const renderedNoticeLines = (): string[] =>
      notice ? paintNoticeLines(noticeKind, notice).flatMap((l) => wrapByWidth(l, width())) : []
    // Ukuran mengikuti terminal sungguhan; satu baris border atas/bawah dan
    // kemungkinan notice tetap masuk ke perhitungan tinggi.
    const visibleRows = () => {
      // windowMaxHeight = tinggi kotak maksimum. Chrome = 5 baris:
      // 2 border + judul + jeda footer + footer.
      const maxBody = windowMaxHeight(screen.rows || 24) - 5
      return Math.max(1, Math.min(maxBody - renderedNoticeLines().length, 12))
    }

    // Isi popup ringkas: nama provider + host opsional + jumlah model & status aktif.
    const bodyLines = (): { lines: string[]; title: string } => {
      const v = visibleRows()
      if (sel < scroll) scroll = sel
      if (sel >= scroll + v) scroll = sel - v + 1
      const w = width()
      const cut = (s: string) => truncateToWidth(s, w)
      const rows = providers.slice(scroll, scroll + v)
      const baseTitle = t("out.titleProviders")
      const title =
        providers.length > v
          ? `${baseTitle} (${scroll + 1}-${scroll + rows.length}/${providers.length})`
          : baseTitle
      const lines: string[] = []
      if (providers.length === 0) {
        lines.push(cut(dim(`  ${t("prov.empty")}`)))
      } else {
        const curModel = opts.getCurrentModel ? opts.getCurrentModel() : opts.currentModel
        for (let i = 0; i < rows.length; i++) {
          const it = rows[i]!
          const picked = i === sel - scroll
          const aktif = curModel?.startsWith(`${it.id}::`) ? ` (${t("common.active")})` : ""
          const countTag = it.models > 0 && w >= 28 ? ` (${it.models})` : ""
          const suffix = `${countTag}${aktif}`
          // Ikon kategori provider jadi bagian baris yang terlihat (1 kolom,
          // fallback ASCII lewat getter glyphs). Diletakkan di luar budget
          // truncasi seperti suffix agar identitas baris tak pernah hilang;
          // sanitasi tetap pada id/baseUrl yang berasal dari config (tak-terpercaya).
          const iconPart = `${glyphs.providerIcon} `
          const safeId = sanitizeAnsiLine(it.id)
          const rawHost = sanitizeAnsiLine(it.baseUrl).replace(/^https?:\/\//i, "")
          const nameBudget = Math.max(1, w - 4 - displayWidth(suffix) - displayWidth(iconPart))
          const idFit = truncateToWidth(safeId, nameBudget, glyphs.ellipsis)
          // Sisakan ruang minimum setelah id+suffix agar host URL opsional tak pernah
          // memotong nama provider maupun tanda aktif di layar sempit.
          const spare = w - 4 - displayWidth(iconPart) - displayWidth(idFit) - displayWidth(suffix)
          const urlPart =
            rawHost && w >= 48 && spare >= 14
              ? ` · ${truncateToWidth(rawHost, spare - 3, glyphs.ellipsis)}`
              : ""
          const label = `${iconPart}${idFit}${urlPart}${suffix}`
          lines.push(listRow(label, picked))
        }
      }
      // Struk transient (jalur modal — notice dapat di-clip tanpa memotong footer).
      for (const line of renderedNoticeLines()) lines.push(cut(line))
      return { lines, title }
    }

    const render = () => {
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
      const { lines, title } = bodyLines()
      // Navigasi disuplai windowFooter; aksi a/d/e jadi extraHints. Urutan
      // tombol aksi mengikuti alur CRUD yang sudah ada (tambah, ubah, hapus).
      // Popup komposit: HANYA region kotak (tanpa clear) di atas konten.
      const box = dialogBox(
        windowSpec({
          title,
          body: lines,
          cols: screen.cols,
          rows: screen.rows,
          extraHints: [
            ...(idleWarned
              ? [
                  {
                    key: "!",
                    label: t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }),
                  },
                ]
              : []),
            { key: "a", label: t("hint.add") },
            { key: "e", label: t("hint.edit") },
            { key: "d", label: t("hint.delete") },
          ] as HintItem[],
        }),
        screen.cols,
        screen.rows,
      )
      screen.paintRegion(box.lines, box.topRow)
      // Daftar murni (tanpa input ketik) — sembunyikan kursor supaya bersih.
      screen.setCursorVisible(false)
    }

    // Popup butuh layar mampu; selain itu tolak BERSUARA + batal.
    const screen: AltScreen = openAltScreen()
    const useModal =
      screen.ok && canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)
    if (!useModal) {
      try {
        console.log(`⚠ ${t("gate.tuiProvider")}`)
      } catch {}
      // Tutup layar sebelum batal: openAltScreen sudah menulis ENTER fisik —
      // bail tanpa close membocorkan alt-screen + hold painter (I27).
      try {
        screen.close()
      } catch {}
      resolve()
      return
    }

    let done = false
    let busy = false
    // Idle-timeout 90 dtk seperti picker/model-manager: tanpa ini raw-mode
    // digenggam selamanya bila stdin 'data' tak pernah datang di Windows
    // (ConPTY macet) = "masuk list macet". Timer di-unref agar tak menahan
    // exit — satu sumber idle via helper bersama (audit D1). `cleanup`
    // dirujuk sebagai closure (dievaluasi saat timer fire).
    const idle = createIdleTimer({
      warnMs: IDLE_WARN_MS,
      cancelMs: IDLE_CANCEL_MS,
      onWarn: () => {
        idleWarned = true
        render()
      },
      onCancel: () => {
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
      },
    })
    /** Listener stdin terpasang? Menjaga resume() idempoten (anti-ganda). */
    let attached = false

    // Suspend: lepas raw mode + listener sementara (untuk askLine/askSecret
    // di a/d/e). Tidak menyentuh `done` - manager tetap hidup; resume()
    // menggambar ulang region popup.
    const suspend = () => {
      idle.clear()
      attached = false
      // Hapus region kotak induk sebelum sub-popup tampil agar bingkai tak
      // tertinggal terpotong; saat exit final `done` sudah true.
      if (!done) {
        try {
          screen.clearRegion()
        } catch {}
        screen.setCursorVisible(false)
      }
      // setRawMode dibungkus try/catch: di Windows handle bisa rusak dan
      // melempar — tanpa ini suspend melempar lalu Promise tak pernah settle.
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
    // Resume: pasang ulang raw mode + listener + render. Idempoten: tanpa
    // garda, resume ganda (watchdog timeout lalu aksi telat selesai) memasang
    // listener stdin DUA kali → tiap tombol diproses ganda.
    const resume = () => {
      if (done) return
      if (!attached) {
        process.stdin.setMaxListeners(0)
        try {
          process.stdin.setRawMode(true)
        } catch {
          // Raw-mode gagal = tak bisa baca tombol; tutup jujur daripada gantung.
          cleanup()
          resolve()
          return
        }
        process.stdin.resume()
        process.stdin.on("data", onData)
        process.stdout.on("resize", onResize)
        attached = true
      }
      // Pulihkan bracketed paste setelah sub-form / konfirmasi menutup dirinya.
      try {
        screen.setBracketedPaste?.(true)
      } catch {}
      render()
      idle.reset()
    }
    // Close final: suspend + tandai selesai (manager tidak bisa dibuka lagi).
    // Selalu resolve walau suspend melempar — tanpa try/finally Promise gantung.
    const cleanup = () => {
      if (done) return
      done = true
      idle.dispose()
      try {
        providerPump.dispose()
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
      try {
        suspend()
      } catch {}
    }

    // SEMUA aksi a/d/e lewat sini: busy guard + suspend, lalu SELALU resume di
    // finally. Tanpa finally, exception di onAdd/askLine (atau loadRows) membuat
    // busy tetap true → onData menolak semua input → manager terkunci selamanya.
    const runAction = (fn: () => Promise<void>) =>
      (async () => {
        if (busy) return
        busy = true
        suspend()
        try {
          await fn()
        } catch (e) {
          // Formatter kanonik: redaksi credential + saran tindakan.
          notice = formatError(e)
          noticeKind = "error"
        } finally {
          busy = false
          await reload().catch(() => {})
          resume()
        }
      })()

    /**
     * Batas waktu aksi jaringan: provider non-kooperatif yang gantung membuat
     * popup mati (suspend tanpa listener/timer). Timeout = notice jujur + UI
     * pulih; aksi telat yang akhirnya selesai diabaikan hasilnya. Tunggu
     * interaksi user (form/picker) TIDAK dibatasi — hanya await jaringan.
     */
    const withWatchdog = <T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> =>
      withTimeout(fn, opts.actionTimeoutMs ?? 60_000, signal)

    // Render kotak progres dengan tombol batal Esc selama deteksi jaringan
    // berjalan (paritas wizard.ts + attachProgressCancel bersama, T3).
    const runDetectWithCancel = async <T>(
      fn: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ res?: T; canceled: boolean }> => {
      const ac = new AbortController()
      const paintDetecting = () => {
        const cols = screen.cols || 80
        const rows = screen.rows || 24
        if (!canRenderModal(cols, rows)) {
          screen.paintRegion(
            [c.warning(truncateToWidth(tSystem("msg.tooSmall"), Math.max(1, cols - 2)))],
            Math.max(1, Math.floor(rows / 2)),
          )
        } else {
          const box = dialogBox(
            windowSpec({
              role: "progress",
              title: t("ntc.detecting"),
              body: [dim(`  ${t("ntc.detecting")}`)],
              cols,
              rows,
              escHint: true,
            }),
            cols,
            rows,
          )
          screen.paintRegion(box.lines, box.topRow)
        }
        screen.setCursorVisible(false)
      }
      paintDetecting()
      const detachCancel = attachProgressCancel(ac, paintDetecting)
      try {
        const res = await withWatchdog(() => fn(ac.signal), ac.signal)
        return { res, canceled: false }
      } catch (e) {
        if (ac.signal.aborted) return { canceled: true }
        throw e
      } finally {
        detachCancel()
        try {
          screen.clearRegion()
        } catch {}
      }
    }

    const applyActionResult = (res: ProviderActionResult) => {
      if (res.ok) {
        notice = res.ok
        noticeKind = "success"
      } else if (res.err) {
        notice = formatError(res.err)
        noticeKind = "error"
      }
    }

    const doAdd = () => {
      if (busy) return
      return runAction(async () => {
        // Langsung tampilkan form (Base URL + API key + scope opsional) tanpa
        // memilih provider terdaftar terlebih dahulu.
        const fields = [
          {
            id: "url",
            label: t("prov.urlLabel"),
            kind: "text" as const,
            initial: "",
            validate: validateUrl,
          },
          {
            id: "key",
            label: t("prov.keyLabel"),
            kind: "secret" as const,
            validate: validateRequired,
          },
          ...(opts.askScope
            ? [
                {
                  id: "scope",
                  label: t("prov.scopeLabel"),
                  kind: "select" as const,
                  options: ["global", "local"],
                },
              ]
            : []),
        ]
        const form = await runForm({ title: t("prov.addTitle"), fields }, screen)
        if (form.cancelled || !form.values) {
          notice = t("common.canceled")
          noticeKind = "info"
          return
        }
        const baseUrl = (form.values.url ?? "").trim()
        const apiKey = form.values.key ?? ""
        const scope = form.values.scope === "local" ? "local" : "global"
        const detected = await runDetectWithCancel((sig) =>
          opts.onAdd({ baseUrl, apiKey, scope }, sig),
        )
        if (detected.canceled) {
          notice = t("common.canceled")
          noticeKind = "info"
          return
        }
        if (detected.res) applyActionResult(detected.res)
      })
    }

    const doDelete = () => {
      if (providers.length === 0) return
      const target = providers[sel]
      if (!target) return
      return runAction(async () => {
        // Konfirmasi menyebut DAMPAK, bukan hanya nama: berapa model ikut hilang,
        // dan apakah provider ini yang sedang dipakai. Pakai getCurrentModel live
        // agar perubahan aktif via Enter ikut tercermin (T3).
        const curModel = (opts.getCurrentModel ? opts.getCurrentModel() : opts.currentModel) ?? ""
        const active = curModel.startsWith(`${target.id}::`)
        const form = await runForm(
          {
            title: t("prov.deleteTitle"),
            fields: [
              {
                id: "ok",
                label:
                  t("prov.deleteLabel", { id: target.id, n: target.models }) +
                  (active ? t("prov.deleteActive", { model: curModel }) : "") +
                  t("prov.deleteAsk"),
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
        if (form.cancelled || form.values?.ok !== "y") {
          notice = t("common.canceled")
          noticeKind = "info"
          return
        }
        applyActionResult(await withWatchdog(() => opts.onDelete(target)))
      })
    }

    const doEdit = () => {
      if (providers.length === 0) return
      const target = providers[sel]
      if (!target) return
      return runAction(async () => {
        const defaults = await opts.onEditDefaults(target)
        if (!defaults) {
          notice = t("ntc.notFound")
          noticeKind = "error"
          return
        }
        // Form edit dalam popup (prefill defaults). Batal di mana pun =
        // batal total (tanpa jatuh ke "pertahankan nilai lama").
        const form = await runForm(
          {
            title: t("prov.editTitle", { id: target.id }),
            fields: [
              {
                id: "url",
                label: t("prov.urlLabel"),
                kind: "text" as const,
                initial: defaults.baseUrl,
                validate: validateUrl,
              },
              // Key kosong = pertahankan lama (tanpa validate required).
              { id: "key", label: t("prov.keyKeepLabel"), kind: "secret", initial: "" },
            ],
          },
          screen,
        )
        if (form.cancelled || !form.values) {
          notice = t("common.canceled")
          noticeKind = "info"
          return
        }
        // Key kosong = pertahankan lama (placeholder [****] memberi tahu).
        const baseUrl = (form.values.url ?? "").trim() || defaults.baseUrl
        const apiKey = (form.values.key ?? "").trim() || defaults.apiKey
        if (baseUrl === defaults.baseUrl && apiKey === defaults.apiKey) {
          notice = t("ntc.noChange")
          noticeKind = "info"
          return
        }
        const detected = await runDetectWithCancel((sig) =>
          opts.onEditSave(target, { baseUrl, apiKey }, sig),
        )
        if (detected.canceled) {
          notice = t("common.canceled")
          noticeKind = "info"
          return
        }
        if (detected.res) applyActionResult(detected.res)
      })
    }

    const decoder: DecoderState = createDecoderState()
    // Seperti model-manager: simpan batas listener warisan, kembalikan di
    // cleanup agar warning MaxListenersExceeded tetap berguna setelahnya.
    // Guard typeof: stdin bisa stub (test) tanpa API ini — anggap default 10.
    const prevMaxListeners =
      typeof process.stdin.getMaxListeners === "function" ? process.stdin.getMaxListeners() : 10
    // Jalur tunggal key (sinkron + flush lone-ESC 50ms). True = selesai.
    const handleProviderKeys = (keys: DecodedKey[]): boolean => {
      if (busy || done) return true
      if (!keys.length) return false
      const usable = canRenderModal(screen.cols || 80, screen.rows || 24)
      // Struk lama dibersihkan tiap keypress baru (transient, bukan arsip).
      notice = null
      noticeKind = "info"
      try {
        for (const d of keys) {
          if (!usable) {
            if (d.key.type === "esc" || d.key.type === "ctrl-c" || d.key.type === "ctrl-d") {
              cleanup()
              resolve()
              return true
            }
            continue
          }
          switch (d.key.type) {
            case "up":
            case "wheelup":
              sel = Math.max(0, sel - 1)
              render()
              break
            case "down":
            case "wheeldown":
              // Daftar kosong: jangan biarkan sel=-1 (Enter lalu salah tutup).
              sel = providers.length ? Math.min(providers.length - 1, sel + 1) : 0
              render()
              break
            case "home":
              // Home/End = lompat atas/bawah daftar (paritas picker/App).
              sel = 0
              scroll = 0
              render()
              break
            case "end":
              sel = providers.length ? Math.max(0, providers.length - 1) : 0
              render()
              break
            case "pageup":
            case "pagedown": {
              // Scroll daftar per halaman (paritas picker/App). Gagal-di-kode-lama:
              // tombol ini tak ditangani sama sekali padahal ada baris `… more`.
              const v = visibleRows()
              if (providers.length > v) {
                const page = Math.max(1, v - 1)
                scroll = Math.max(
                  0,
                  Math.min(
                    Math.max(0, providers.length - v),
                    scroll + (d.key.type === "pageup" ? -page : page),
                  ),
                )
                sel = Math.max(0, Math.min(providers.length - 1, sel))
                if (sel < scroll) sel = scroll
                if (sel >= scroll + v) sel = scroll + v - 1
                render()
              }
              break
            }
            case "char": {
              const ch = d.key.ch.toLowerCase()
              if (ch === "a") {
                void doAdd()
                return true
              }
              if (ch === "d") {
                void doDelete()
                return true
              }
              if (ch === "e") {
                void doEdit()
                return true
              }
              break
            }
            case "enter": {
              // Footer bilang "select"; daftar kosong atau provider tanpa model
              // tak boleh menutup layar diam-diam tanpa pilihan nyata.
              const p = providers[sel]
              if (!p) return true
              if (!p.firstModel) {
                notice = t("model.empty")
                noticeKind = "info"
                render()
                return true
              }
              try {
                opts.onSelect(p)
              } catch (e) {
                // Error dari onSelect (mis. simpan konfigurasi gagal) harus
                // terlihat sebagai notice di dalam popup, bukan tertelan bisu.
                notice = formatError(e)
                noticeKind = "error"
                render()
                return true
              }
              cleanup()
              resolve()
              return true
            }
            case "esc":
            case "ctrl-c":
            case "ctrl-d":
              cleanup()
              resolve()
              return true
            default:
              break
          }
        }
        render()
        return false
      } catch {
        // Tanpa resolve Promise gantung selamanya (bug: cleanup saja tak cukup).
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
        return true
      }
    }
    const providerPump = createKeyStreamPump({ state: decoder, onKeys: handleProviderKeys })
    const onData = (chunk: Buffer) => {
      idleWarned = false
      idle.reset()
      try {
        providerPump.push(chunk)
      } catch {
        try {
          cleanup()
        } catch {}
        try {
          resolve()
        } catch {}
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
        cleanup()
      } catch {}
      try {
        // Pesan setup gagal (bisa memuat body jaringan) = teks tak-terpercaya.
        console.log(`⚠ ${t("prov.failOpen", { msg: formatError(e) })}`)
      } catch {}
      try {
        resolve()
      } catch {}
    }
  })
}
