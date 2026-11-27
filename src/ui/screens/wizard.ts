// View wizard setup pertama — murni presentasi: form Base URL + API key
// dalam popup. Penyimpanan provider lewat callback `onSubmit` yang
// di-inject controller (cli/wizard.ts). SEMUA langkah dalam kotak: tak ada
// ketikan di luar popup.
import { formatError } from "../assistant/simple.ts"
import { t } from "../i18n/locale.ts"
import { createDecoderState, createKeyStreamPump } from "../input/prompt-engine.ts"
import type { HintItem } from "../render/hint.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import { truncateToWidth, wrapByWidth } from "../render/width.ts"
import { openAltScreen } from "../runtime/screen.ts"
import { canRenderModal, type DialogSpec, dialogBox } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS, runForm, validateUrl } from "./form.ts"
import { attachProgressCancel, createIdleTimer } from "./lifecycle.ts"
import { withTimeout } from "./watchdog.ts"
import { windowMaxHeight, windowSpec, windowWidth } from "./window.ts"

/**
 * Batas tunggu simpan-provider (audit 2026-11-12, MEDIUM-7).
 *
 * `detect()` sendiri punya timeout, tapi callback controller juga melakukan
 * I/O config (kunci, tulis disk) yang bisa lambat; tanpa batas, kotak
 * "mendeteksi…" bertahan selama proses menggantung dan user tak punya jalan
 * keluar (tak ada Esc di kotak progres). Timeout = pesan jujur, UI pulih.
 * Semantik timeout di-share lewat withTimeout() (paritas picker/manager).
 */

export interface WizardPreset {
  label: string
  baseUrl: string
}

export interface SetupWizardViewOptions {
  presets?: readonly WizardPreset[]
  /** Simpan provider; kembalikan pesan sukses, atau lempar untuk gagal. */
  onSubmit(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string>
}

export interface WizardWindowOptions {
  body: string[]
  cols: number
  rows: number
  /** Judul opsional (default `wiz.title`); dipakai untuk counter gulir saat error panjang. */
  title?: string
  /** Aksi khusus langkah (mis. Enter retry pada dialog gagal). */
  extraHints?: readonly HintItem[]
  /** Tampilkan `Esc` redup di pojok kanan atas judul. */
  escHint?: boolean
}

/**
 * Satu frame untuk kotak wizard yang digambar langsung (deteksi, selesai,
 * gagal). Memakai `windowSpec` — bukan helper lebar popup lama — supaya lebar,
 * tinggi, dan footer identik dengan jendela lain di ukuran terminal yang sama.
 * Judul selalu `wiz.title`: ini kotak status wizard, bukan langkah 1–3 yang
 * judulnya dibawa picker/form. Diekspor sebagai seam test frame seragam.
 */
export function wizardWindowSpec(opts: WizardWindowOptions): DialogSpec {
  return windowSpec({
    title: opts.title ?? t("wiz.title"),
    body: opts.body,
    cols: opts.cols,
    rows: opts.rows,
    role: "progress",
    ...(opts.escHint !== undefined ? { escHint: opts.escHint } : {}),
    ...(opts.extraHints ? { extraHints: opts.extraHints } : {}),
  })
}

/** Tunggu keputusan user pada dialog error wizard (`retry` / `back` / `cancel`). */
async function waitForWizardDismiss(
  renderErr: (idleWarned: boolean) => void,
  onScroll?: (delta: number, page: number) => void,
): Promise<"retry" | "back" | "cancel"> {
  return new Promise<"retry" | "back" | "cancel">((resolve) => {
    let done = false
    let idleWarned = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    const idle = createIdleTimer({
      warnMs: IDLE_WARN_MS,
      cancelMs: IDLE_CANCEL_MS,
      onWarn: () => {
        idleWarned = true
        try {
          renderErr(idleWarned)
        } catch {}
      },
      onCancel: () => finish("cancel"),
    })
    const finish = (choice: "retry" | "back" | "cancel") => {
      if (done) return
      done = true
      idle.dispose()
      try {
        pump.dispose()
      } catch {}
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize)
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      resolve(choice)
    }
    const pump = createKeyStreamPump({
      state: createDecoderState(),
      onKeys: (keys) => {
        const usable = canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)
        for (const d of keys) {
          const k = d.key
          if (k.type === "esc" || k.type === "ctrl-c" || k.type === "ctrl-d") {
            finish("cancel")
            return true
          }
          if (!usable) continue
          if (k.type === "enter") {
            finish("retry")
            return true
          }
          if (k.type === "up" || k.type === "wheelup") {
            onScroll?.(-1, 1)
            continue
          }
          if (k.type === "down" || k.type === "wheeldown") {
            onScroll?.(1, 1)
            continue
          }
          if (k.type === "pageup" || k.type === "pagedown") {
            onScroll?.(k.type === "pageup" ? -1 : 1, 5)
            continue
          }
          if (k.type === "char") {
            const ch = k.ch.toLowerCase()
            if (ch === "j" || ch === "k") {
              onScroll?.(ch === "k" ? -1 : 1, 1)
              continue
            }
            if (ch === "r") {
              finish("retry")
              return true
            }
            if (ch === "b") {
              finish("back")
              return true
            }
          }
        }
        idle.reset()
        return false
      },
    })
    onData = (chunk: Buffer) => {
      idleWarned = false
      idle.reset()
      try {
        pump.push(new Uint8Array(chunk))
      } catch {
        finish("cancel")
      }
    }
    onResize = () => {
      try {
        renderErr(idleWarned)
      } catch {}
    }
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      idle.reset()
      renderErr(idleWarned)
    } catch {
      finish("cancel")
    }
  })
}

function sleepUnref(ms: number): Promise<void> {
  return new Promise((r) => {
    const timer = setTimeout(r, ms)
    try {
      ;(timer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  })
}

/**
 * Tunggu jeda selesai wizard sambil menyerap keystroke di stdin raw-mode
 * supaya ketikan nyasar saat kotak penutup tidak bocor ke shell/TUI induk (T10).
 * Esc/Enter/Space langsung menutup jeda lebih cepat tanpa menunggu penuh.
 */
function waitDonePause(ms: number): Promise<void> {
  if (!process.stdin.isTTY) return sleepUnref(ms)
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pump = createKeyStreamPump({
      state: createDecoderState(),
      onKeys: (keys) => {
        for (const d of keys) {
          const t = d.key.type
          if (
            t === "esc" ||
            t === "enter" ||
            t === "ctrl-c" ||
            t === "ctrl-d" ||
            (t === "char" && d.key.ch === " ")
          ) {
            finish()
            return true
          }
        }
        return false
      },
    })
    const onData = (chunk: Buffer) => {
      try {
        pump.push(new Uint8Array(chunk))
      } catch {}
    }
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        pump.dispose()
      } catch {}
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      resolve()
    }
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onData)
    } catch {}
    timer = setTimeout(finish, ms)
    try {
      ;(timer as unknown as { unref?: () => void }).unref?.()
    } catch {}
  })
}

/**
 * Wizard setup pertama — hal PERTAMA yang dilihat pengguna baru.
 *
 * Langsung membuka form dalam popup untuk Base URL + API key (tanpa memilih
 * preset provider). Esc di langkah mana pun = batal total.
 */
export async function runSetupWizardView(opts: SetupWizardViewOptions): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const screen = openAltScreen()
  let exitMsg: string | null = null
  try {
    if (!screen.ok || !canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)) {
      exitMsg = `${tSystem("msg.tooSmall")}\n`
      return false
    }

    let draftUrl = ""
    let draftKey = ""
    // Loop langkah Base URL + API key agar kegagalan deteksi model mengizinkan
    // Retry atau kembali memperbaiki isian tanpa mengulang wizard dari awal.
    for (;;) {
      const urlForm = await runForm(
        {
          title: t("wiz.stepUrl"),
          fields: [
            {
              id: "url",
              label: t("wiz.urlLabel"),
              kind: "text",
              initial: draftUrl,
              validate: validateUrl,
            },
          ],
        },
        screen,
      )
      if (urlForm.cancelled || !urlForm.values) {
        exitMsg = `${t("wiz.canceled")}\n`
        return false
      }
      const targetUrl = (urlForm.values.url ?? "").trim()
      if (!targetUrl) {
        exitMsg = `${t("wiz.canceled")}\n`
        return false
      }
      draftUrl = targetUrl

      // Endpoint lokal (Ollama/LM Studio) tidak butuh API key; kirim placeholder
      // agar header Authorization tetap terbentuk. Flag /i agar HOST kapital tetap cocok (T10).
      const lokal = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(targetUrl)
      let apiKey = "ollama"
      if (!lokal) {
        const keyForm = await runForm(
          {
            title: t("wiz.stepKey"),
            fields: [
              {
                id: "key",
                label: t("wiz.keyLabel", { url: targetUrl }),
                kind: "secret",
                initial: draftKey,
                validate: (v) => (v.trim() ? null : t("form.required")),
              },
            ],
          },
          screen,
        )
        if (keyForm.cancelled || !keyForm.values) {
          exitMsg = `${t("wiz.canceled")}\n`
          return false
        }
        apiKey = (keyForm.values.key ?? "").trim()
        if (!apiKey) {
          exitMsg = `${t("wiz.keyLater")}\n`
          return false
        }
        draftKey = apiKey
      }

      // Inner loop untuk Retry deteksi langsung dengan URL + key yang sama.
      let goBack = false
      for (;;) {
        const paintDetecting = () => {
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
          const box = dialogBox(
            wizardWindowSpec({
              body: [c.muted(t("wiz.detecting"))],
              cols,
              rows,
              escHint: true,
            }),
            cols,
            rows,
          )
          screen.paintRegion(box.lines, box.topRow)
          screen.setCursorVisible(false)
        }
        const ac = new AbortController()
        paintDetecting()
        const detachCancel = attachProgressCancel(ac, paintDetecting)
        try {
          const message = await withTimeout(
            () => opts.onSubmit(targetUrl, apiKey, ac.signal),
            60_000,
            ac.signal,
          )
          detachCancel()
          screen.clearRegion()
          const doneBox = dialogBox(
            wizardWindowSpec({
              body: [sanitizeAnsiLine(message), "", t("wiz.done")],
              cols: screen.cols || 80,
              rows: screen.rows || 24,
            }),
            screen.cols,
            screen.rows,
          )
          screen.paintRegion(doneBox.lines, doneBox.topRow)
          screen.setCursorVisible(false)
          await waitDonePause(1200)
          return true
        } catch (e) {
          detachCancel()
          screen.clearRegion()
          // Pembatalan eksplisit via Esc/Ctrl+C selama deteksi: kembali ke
          // form Base URL/API key dengan draft utuh (tanpa menumpuk dialog error).
          if (ac.signal.aborted) {
            goBack = true
            break
          }
          const errRaw = t("wiz.detectFail", { msg: formatError(e) })
          let errScroll = 0
          let lastIdleWarned = false
          const buildWrapped = () => {
            const cols = screen.cols || 80
            const rows = screen.rows || 24
            const innerW = Math.max(10, windowWidth(cols) - 4)
            const wrapped = errRaw
              .split("\n")
              .flatMap((line) => (line.trim() ? wrapByWidth(c.error(line), innerW) : [""]))
            const viewH = Math.max(1, windowMaxHeight(rows) - 5)
            return { cols, rows, wrapped, viewH }
          }
          const renderErr = (idleWarned: boolean) => {
            lastIdleWarned = idleWarned
            const { cols, rows, wrapped, viewH } = buildWrapped()
            if (!canRenderModal(cols, rows)) {
              screen.paintRegion(
                [c.warning(truncateToWidth(tSystem("msg.tooSmall"), Math.max(1, cols - 2)))],
                Math.max(1, Math.floor(rows / 2)),
              )
              screen.setCursorVisible(false)
              return
            }
            const maxScroll = Math.max(0, wrapped.length - viewH)
            if (errScroll > maxScroll) errScroll = maxScroll
            if (errScroll < 0) errScroll = 0
            const visible = wrapped.slice(errScroll, errScroll + viewH)
            const title =
              maxScroll > 0
                ? `${t("wiz.title")} (${errScroll + 1}-${errScroll + visible.length}/${wrapped.length})`
                : t("wiz.title")
            const errBox = dialogBox(
              wizardWindowSpec({
                title,
                body: visible,
                cols,
                rows,
                escHint: true,
                extraHints: [
                  ...(idleWarned
                    ? [
                        {
                          key: "!",
                          label: t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }),
                        },
                      ]
                    : []),
                  ...(maxScroll > 0 ? [{ key: glyphs.upDown, label: t("hint.scroll") }] : []),
                  { key: "r/Enter", label: t("hint.retry") },
                  { key: "b", label: t("hint.back") },
                ],
              }),
              screen.cols,
              screen.rows,
            )
            screen.paintRegion(errBox.lines, errBox.topRow)
            screen.setCursorVisible(false)
          }
          const action = await waitForWizardDismiss(renderErr, (dir, mult) => {
            const { viewH } = buildWrapped()
            const step = mult > 1 ? Math.max(1, viewH - 1) : 1
            errScroll += dir * step
            renderErr(lastIdleWarned)
          })
          if (action === "retry") continue
          if (action === "back") {
            goBack = true
            break
          }
          exitMsg = `${t("wiz.canceled")}\n`
          return false
        }
      }
      if (goBack) continue
    }
  } finally {
    try {
      screen.clearRegion()
    } catch {}
    try {
      screen.setBracketedPaste?.(false)
    } catch {}
    try {
      screen.close()
    } catch {}
    if (exitMsg) {
      process.stdout.write(exitMsg)
    }
  }
}
