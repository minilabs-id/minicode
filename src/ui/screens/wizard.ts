// View wizard setup pertama — murni presentasi: picker gateway + form
// URL/key dalam popup. Penyimpanan provider lewat callback `onSubmit` yang
// di-inject controller (cli/wizard.ts). SEMUA langkah dalam kotak: tak ada
// ketikan di luar popup.
import { formatError } from "../assistant/simple.ts"
import { t } from "../i18n/locale.ts"
import { createDecoderState, createKeyStreamPump } from "../input/prompt-engine.ts"
import { hintLine } from "../render/hint.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c } from "../render/theme.ts"
import { wrapByWidth } from "../render/width.ts"
import { openAltScreen } from "../runtime/screen.ts"
import { canRenderModal, dialogBox, popupBoxWidth } from "./dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS, runForm, validateUrl } from "./form.ts"
import { createIdleTimer } from "./lifecycle.ts"
import { runPicker } from "./picker.ts"
import { withTimeout } from "./watchdog.ts"

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

/** Tunggu tombol tutup (Enter/Esc/Ctrl+C/Ctrl+D) pada dialog error wizard. */
async function waitForWizardDismiss(renderErr: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    const idle = createIdleTimer({
      cancelMs: IDLE_WARN_MS + IDLE_CANCEL_MS,
      onCancel: () => finish(),
    })
    const finish = () => {
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
      resolve()
    }
    const pump = createKeyStreamPump({
      state: createDecoderState(),
      onKeys: (keys) => {
        for (const d of keys) {
          const k = d.key.type
          if (k === "enter" || k === "esc" || k === "ctrl-c" || k === "ctrl-d") {
            finish()
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
        finish()
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
      finish()
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
  if (!screen.ok || !canRenderModal(process.stdout.columns || 80, process.stdout.rows || 24)) {
    try {
      screen.close()
    } catch {}
    return false
  }
  let exitMsg: string | null = null
  try {
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

    // URL via form dalam popup (validasi inline, bukan gagal saat detect).
    const urlForm = await runForm(
      {
        title: t("wiz.stepUrl"),
        fields: [
          {
            id: "url",
            label: picked === CUSTOM ? t("wiz.urlLabel") : `${t("wiz.urlLabel")} [${picked}]`,
            kind: "text",
            initial: picked === CUSTOM ? "" : (picked as string),
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
    }

    const statusWidth = popupBoxWidth(screen.cols || 80)
    // Progres sebagai baris dalam kotak (bukan spinner liar di bawah popup).
    const box = dialogBox(
      {
        title: t("wiz.title"),
        body: [c.muted(t("wiz.detecting"))],
        minWidth: statusWidth,
        maxWidth: statusWidth,
      },
      screen.cols,
      screen.rows,
    )
    screen.paintRegion(box.lines, box.topRow)
    screen.setCursorVisible(false)
    try {
      const message = await withTimeout(() => opts.onSubmit(targetUrl, apiKey), 60_000)
      // Pesan dari jaringan (nama model/gateway) — sanitasi sebelum tampil.
      screen.clearRegion()
      const doneWidth = popupBoxWidth(screen.cols || 80)
      const doneBox = dialogBox(
        {
          title: t("wiz.title"),
          body: [sanitizeAnsiLine(message), "", t("wiz.done")],
          minWidth: doneWidth,
          maxWidth: doneWidth,
        },
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
        const w = popupBoxWidth(screen.cols || 80)
        const innerW = Math.max(10, Math.min(w - 4, (screen.cols || 80) - 6))
        const wrapped = errRaw
          .split("\n")
          .flatMap((line) => (line.trim() ? wrapByWidth(c.error(line), innerW) : [""]))
        const errBox = dialogBox(
          {
            title: t("wiz.title"),
            body: wrapped,
            footer: hintLine([
              { key: "Enter", label: t("hint.close") },
              { key: "Esc", label: t("hint.cancel") },
            ]),
            minWidth: w,
            maxWidth: w,
          },
          screen.cols,
          screen.rows,
        )
        screen.paintRegion(errBox.lines, errBox.topRow)
        screen.setCursorVisible(false)
      }
      await waitForWizardDismiss(renderErr)
      return false
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
