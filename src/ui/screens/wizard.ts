// View wizard setup pertama — murni presentasi: picker gateway + form
// URL/key dalam popup. Penyimpanan provider lewat callback `onSubmit` yang
// di-inject controller (cli/wizard.ts). SEMUA langkah dalam kotak: tak ada
// ketikan di luar popup.
import { formatError } from "../assistant/simple.ts"
import { t } from "../i18n/locale.ts"
import { createDecoderState, createKeyStreamPump } from "../input/prompt-engine.ts"
import type { HintItem } from "../render/hint.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { tSystem } from "../render/tool-label.ts"
import { wrapByWidth } from "../render/width.ts"
import { openAltScreen } from "../runtime/screen.ts"
import { canRenderModal, type DialogSpec, dialogBox } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS, runForm, validateUrl } from "./form.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { runPicker } from "./picker.ts"
import { withTimeout } from "./watchdog.ts"
import { windowSpec, windowWidth } from "./window.ts"

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
  presets: readonly WizardPreset[]
  /** Simpan provider; kembalikan pesan sukses, atau lempar untuk gagal. */
  onSubmit(baseUrl: string, apiKey: string): Promise<string>
}

export interface WizardWindowOptions {
  body: string[]
  cols: number
  rows: number
  /** Aksi khusus langkah (mis. Enter = tutup pada dialog gagal). */
  extraHints?: readonly HintItem[]
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
    title: t("wiz.title"),
    body: opts.body,
    cols: opts.cols,
    rows: opts.rows,
    ...(opts.extraHints ? { extraHints: opts.extraHints } : {}),
  })
}

/** Tunggu keputusan user pada dialog error wizard (`retry` / `back` / `cancel`). */
async function waitForWizardDismiss(renderErr: () => void): Promise<"retry" | "back" | "cancel"> {
  return new Promise<"retry" | "back" | "cancel">((resolve) => {
    let done = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    const idle = createIdleTimer({
      cancelMs: IDLE_WARN_MS + IDLE_CANCEL_MS,
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
        for (const d of keys) {
          const k = d.key
          if (k.type === "enter") {
            finish("retry")
            return true
          }
          if (k.type === "char") {
            const ch = k.ch.toLowerCase()
            if (ch === "r") {
              finish("retry")
              return true
            }
            if (ch === "b") {
              finish("back")
              return true
            }
          }
          if (k.type === "esc" || k.type === "ctrl-c" || k.type === "ctrl-d") {
            finish("cancel")
            return true
          }
        }
        idle.reset()
        return false
      },
    })
    onData = (chunk: Buffer) => {
      idle.reset()
      try {
        pump.push(new Uint8Array(chunk))
      } catch {
        finish("cancel")
      }
    }
    onResize = () => {
      try {
        renderErr()
      } catch {}
    }
    try {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on("data", onData)
      process.stdout.on("resize", onResize)
      idle.reset()
      renderErr()
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
 * Wizard setup pertama — hal PERTAMA yang dilihat pengguna baru.
 *
 * Memakai `runPicker` (panah + filter) untuk gateway, lalu form dalam popup
 * untuk URL + API key. Esc di langkah mana pun = batal total.
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
    const CUSTOM = "\u0000custom"
    const items = [
      ...opts.presets.map((p) => ({ name: p.label, provider: "", value: p.baseUrl })),
      { name: t("prov.customUrl"), provider: "", value: CUSTOM },
    ]

    let picked: string | null = null
    await runPicker({
      title: t("wiz.gateway"),
      items,
      filterable: true,
      // Step [1/3] butuh judul; picker biasa tetap tanpa judul (kontrak v7.8).
      showTitle: true,
      screen,
      onPick: (v) => {
        picked = v
      },
      onCancel: () => {
        picked = null
      },
    })
    if (picked === null) {
      exitMsg = `${t("wiz.canceled")}\n`
      return false
    }

    let draftUrl = picked === CUSTOM ? "" : (picked as string)
    let draftKey = ""
    // Loop langkah 2–3 agar kegagalan deteksi model mengizinkan Retry atau
    // kembali memperbaiki URL/API key tanpa mengulang wizard dari awal.
    for (;;) {
      const urlForm = await runForm(
        {
          title: t("wiz.stepUrl"),
          fields: [
            {
              id: "url",
              label: picked === CUSTOM ? t("wiz.urlLabel") : `${t("wiz.urlLabel")} [${picked}]`,
              kind: "text",
              initial: draftUrl,
              validate: (v) => {
                const val = v.trim() || (picked === CUSTOM ? "" : (picked as string))
                if (!val) return t("form.required")
                return validateUrl(val)
              },
            },
          ],
        },
        screen,
      )
      if (urlForm.cancelled || !urlForm.values) {
        exitMsg = `${t("wiz.canceled")}\n`
        return false
      }
      const rawUrl = (urlForm.values.url ?? "").trim()
      const targetUrl = rawUrl || (picked === CUSTOM ? "" : (picked as string))
      if (!targetUrl) {
        exitMsg = `${t("wiz.canceled")}\n`
        return false
      }
      draftUrl = targetUrl

      // Endpoint lokal (Ollama/LM Studio) tidak butuh API key; kirim placeholder
      // agar header Authorization tetap terbentuk.
      const lokal = /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(targetUrl)
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
        const box = dialogBox(
          wizardWindowSpec({
            body: [c.muted(t("wiz.detecting"))],
            cols: screen.cols || 80,
            rows: screen.rows || 24,
          }),
          screen.cols,
          screen.rows,
        )
        screen.paintRegion(box.lines, box.topRow)
        screen.setCursorVisible(false)
        try {
          const message = await withTimeout(() => opts.onSubmit(targetUrl, apiKey), 60_000)
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
          await sleepUnref(1200)
          return true
        } catch (e) {
          screen.clearRegion()
          const errRaw = t("wiz.detectFail", { msg: formatError(e) })
          const renderErr = () => {
            const innerW = Math.max(10, windowWidth(screen.cols || 80) - 4)
            const wrapped = errRaw
              .split("\n")
              .flatMap((line) => (line.trim() ? wrapByWidth(c.error(line), innerW) : [""]))
            const errBox = dialogBox(
              wizardWindowSpec({
                body: wrapped,
                cols: screen.cols || 80,
                rows: screen.rows || 24,
                extraHints: [
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
          const action = await waitForWizardDismiss(renderErr)
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
      screen.close()
    } catch {}
    if (exitMsg) {
      process.stdout.write(exitMsg)
    }
  }
}
