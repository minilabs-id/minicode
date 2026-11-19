// View persetujuan tool — murni presentasi.
// Lapisan policy tidak mengimpor file ini; ia di-inject sebagai callback dari
// composition root (cli/setup.ts -> createMinicodeSession -> permission).
//
// Warga TUI: bila approval sink terdaftar (cli/tui.ts saat App aktif), blok
// pertanyaan dicatat ke transkrip. Sejak v0.24 prompt dirender sebagai MODAL:
// backdrop redup (App.suspend) + kotak dialog terpusat (dialogBox+paintRegion),
// input raw-mode di-echo ke kotak (bukan askLine inline yang bertabrakan dengan
// painter alt-screen). Tanpa sink (one-shot/exec) = tulis langsung warisan.

import { t } from "../i18n/locale.ts"
import { askLine } from "../input/input.ts"
import {
  applyKey,
  createDecoderState,
  createKeyStreamPump,
  createState,
  type PromptState,
  toGraphemes,
} from "../input/prompt-engine.ts"
import { hintLine } from "../render/hint.ts"
import { listRow } from "../render/list.ts"
import { sanitizeAnsiLine } from "../render/sanitize.ts"
import { c, glyphs, stripAnsi } from "../render/theme.ts"
import { displayWidth, truncateToWidth } from "../render/width.ts"
import { boxLeftPad, canRenderModal, dialogBox, popupBoxWidth } from "../screens/dialog.ts"
import { IDLE_CANCEL_MS, IDLE_WARN_MS } from "../screens/form.ts"
import { createIdleTimer } from "../screens/lifecycle.ts"
import { type ApprovalSink, getApprovalSink } from "../tui/transcript.ts"

/** Subset struktural tool call yang dibutuhkan view — tanpa tipe kernel. */
export interface ApprovalRequest {
  name: string
  args?: unknown
  /** F-APPROVAL-1: tier risiko efek samping (dari policy, sudah dikanonkan). */
  riskTier?: string
  /** F-APPROVAL-1: pratinjau diff ringkas (dari policy, sudah di-scrub secret). */
  diffPreview?: string
  /**
   * P1.2: apakah `always` benar-benar dapat dipersist untuk call ini. Policy
   * menolak menyimpan args > 2 KB (allowlist tidak boleh menjadi blanket-allow);
   * UI wajib menyembunyikan opsi yang no-op.
   */
  canAlways?: boolean
}

// F-APPROVAL-1: label tier risiko yang terlokalisasi — view TIDAK import policy,
// jadi cuma memetakan string tier kanonik → kunci i18n. Tier tak dikenal =
// undefined (tidak menebak label palsu; baris risiko dihilangkan).
function tierLabel(riskTier?: string): string | undefined {
  switch (riskTier) {
    case "PURE_READ":
      return t("appr.tier.pure")
    case "WORKSPACE_MUTATION":
      return t("appr.tier.workspace")
    case "LOCAL_ENV_MUTATION":
      return t("appr.tier.localenv")
    case "EXTERNAL_IRREVERSIBLE":
      return t("appr.tier.external")
    case "UNKNOWN":
      return t("appr.tier.unknown")
    default:
      return undefined
  }
}

// ── Modal input bersama (approval & ask_user) ──────────────────────────────
// Baca SATU baris raw-mode sambil me-render ulang kotak tiap ketikan (echo).
// Enter = submit; Esc/Ctrl+C = batal (null). Idle dua-fase (80s warn / 10s
// batal) mencegah raw-mode digenggam selamanya (segfault Bun Windows).

/** Keputusan approval. */
type Decision = "allow" | "always" | "deny"

interface ModalRenderState {
  sel: number
  typed: string
  cursor: number
  warned: boolean
}

type ModalCursor =
  | { kind: "choice"; selected: number }
  | { kind: "line"; typed: string; cursor: number }

/**
 * Potong jendela teks 1-baris mengikuti posisi kursor agar teks ketik panjang
 * di promptAskText tetap terlihat dan kursor tidak keluar border kotak.
 */
function windowLineInput(
  typed: string,
  cursor: number,
  maxCols: number,
): { visible: string; cursorOffsetCols: number } {
  const safe = sanitizeAnsiLine(typed)
  const pts = toGraphemes(safe)
  const safeCursor = Math.max(0, Math.min(cursor, pts.length))
  const budget = Math.max(6, maxCols)
  let start = 0
  while (start < safeCursor && displayWidth(pts.slice(start, safeCursor).join("")) > budget - 1) {
    start++
  }
  const out: string[] = []
  let w = 0
  for (let i = start; i < pts.length; i++) {
    const gw = displayWidth(pts[i] ?? "")
    if (w + gw > budget) break
    out.push(pts[i]!)
    w += gw
  }
  return {
    visible: out.join(""),
    cursorOffsetCols: displayWidth(pts.slice(start, safeCursor).join("")),
  }
}

/**
 * Baca satu jawaban dari kotak modal. `line` = teks bebas; `choice` = daftar
 * dengan `↑↓`/home/end + Enter (I25) dan ketik-cepat huruf pertama (AUD-005).
 * Satu pembaca untuk dua mode: salinan kedua pasti menyimpang (kelas AUD-003).
 */
function readModalInput<T extends "line" | "choice">(
  mode: T,
  render: (state: ModalRenderState) => void,
  opt: T extends "choice" ? { count: number; quick: Readonly<Record<string, number>> } : object,
  signal?: AbortSignal,
): Promise<T extends "choice" ? number | null : string | null> {
  type R = T extends "choice" ? number | null : string | null
  return new Promise((resolve, reject) => {
    const o = opt as { count?: number; quick?: Record<string, number> }
    const count = o.count ?? 0
    const quick = o.quick ?? {}
    let done = false
    let sel = 0
    let lineState: PromptState = createState()
    let warned = false
    let onData!: (chunk: Buffer) => void
    let onResize!: () => void
    const redraw = () => {
      try {
        render({ sel, typed: lineState.line, cursor: lineState.cursor, warned })
      } catch {}
    }
    const pump = createKeyStreamPump({
      state: createDecoderState(),
      onKeys: (keys) => {
        // Tiap keypress/chunk — termasuk tombol yang tak memetakan ke aksi apa
        // pun — adalah bukti user masih aktif. Reset di sini (bukan di dalam
        // `if (changed)`) supaya tombol tak bertujuan tak membiarkan idle guard
        // membatalkan modal di tengah interaksi (temuan M1).
        idle.reset()
        let changed = false
        for (const k of keys) {
          const key = k.key
          if (key.type === "esc" || key.type === "ctrl-c" || key.type === "ctrl-d") {
            finish(null as R)
            return true
          }
          // Layar menyusut di bawah ambang aman: cegah setujui/submit membuta;
          // hanya Esc/Ctrl+C/Ctrl+D di atas yang keluar aman sampai dibesarkan.
          if (!canRenderModal()) continue
          if (key.type === "enter") {
            finish((mode === "choice" ? sel : lineState.line) as R)
            return true
          }
          if (mode === "choice") {
            if (key.type === "up" || key.type === "wheelup") {
              sel = Math.max(0, sel - 1)
              changed = true
            } else if (key.type === "down" || key.type === "wheeldown") {
              sel = Math.min(count - 1, sel + 1)
              changed = true
            } else if (key.type === "home") {
              sel = 0
              changed = true
            } else if (key.type === "end") {
              sel = count - 1
              changed = true
            } else if (key.type === "char") {
              // Ketik-cepat: huruf cocok langsung submit. Indeks -1 = sinonim
              // tanpa opsi (mis. `s` saat Always disembunyikan) — abaikan,
              // JANGAN menutup modal sebagai deny.
              const hit = quick[key.ch.toLowerCase()]
              if (hit != null && hit >= 0 && hit < count) {
                finish(hit as R)
                return true
              }
            }
          } else {
            if (key.type === "mouse" || key.type === "wheelup" || key.type === "wheeldown") {
              continue
            }
            const safeKey =
              key.type === "char"
                ? { type: "char" as const, ch: key.ch.replace(/[\r\n]/g, " ") }
                : key
            const next = applyKey(lineState, safeKey, () => [])
            if (next.action !== "none" || next.state !== lineState) {
              lineState = next.state
              changed = true
            }
          }
        }
        if (changed) {
          warned = false
          redraw()
        }
        return false
      },
    })
    const idle = createIdleTimer({
      warnMs: IDLE_WARN_MS,
      cancelMs: IDLE_CANCEL_MS,
      onWarn: () => {
        warned = true
        redraw()
      },
      onCancel: () => finish(null as R),
    })
    const finish = (v: R) => {
      if (done) return
      done = true
      try {
        pump.dispose()
      } catch {}
      idle.dispose()
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize)
      } catch {}
      // v7.32: lepas abort listener saat modal selesai supaya tak bocor.
      if (signal) signal.removeEventListener("abort", onAbort)
      try {
        process.stdin.setRawMode(false)
      } catch {}
      resolve(v)
    }
    // v7.32: turn yang dibatalkan harus memutus penungguan jawaban manusia —
    // tanpa ini modal hanya punya idle-cancel (80+10 dtk) dan abort terasa macet.
    const onAbort = () => {
      if (done) return
      done = true
      try {
        pump.dispose()
      } catch {}
      idle.dispose()
      try {
        process.stdin.removeListener("data", onData)
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize)
      } catch {}
      try {
        process.stdin.setRawMode(false)
      } catch {}
      reject(new DOMException("aborted", "AbortError"))
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    onData = (chunk: Buffer) => pump.push(new Uint8Array(chunk))
    onResize = () => redraw()
    try {
      process.stdin.setRawMode(true)
    } catch {}
    process.stdin.on("data", onData)
    process.stdout.on("resize", onResize)
    // Timer HARUS mulai saat modal dibuka — bukan menunggu keypress pertama.
    // Tanpa ini raw-mode bisa digenggam selamanya bila ConPTY berhenti mengirim
    // input (kelas hang yang sama dengan picker/manager).
    idle.reset()
    redraw()
  })
}

/** Render kotak modal + baris ekstra (echo / daftar bersorot) + parkir kursor. */
function paintModal(
  sink: ApprovalSink,
  spec: { title: string; body: string[]; footer?: string },
  extra: readonly string[],
  cursor?: ModalCursor,
): void {
  if (!sink.paintRegion) return
  const cols = process.stdout.columns || 80
  const rows = process.stdout.rows || 24
  if (!canRenderModal(cols, rows)) {
    sink.paintRegion([c.warning(truncateToWidth(t("tui.tooSmall"), Math.max(1, cols)))], 1)
    return
  }
  const safeRows = Math.max(5, rows)
  // Lebar popup SERAGAM (AUD-007): dulu selebar layar, melanggar I20.
  const boxW = popupBoxWidth(cols)
  const innerW = Math.max(10, Math.min(boxW - 4, Math.max(20, cols) - 6))
  let modalExtra = extra
  let lineCursorOffset = 0
  if (cursor?.kind === "line") {
    const win = windowLineInput(cursor.typed, cursor.cursor, innerW - 4)
    modalExtra = [`  ${c.dim(">")} ${c.info(win.visible)}`]
    lineCursorOffset = win.cursorOffsetCols
  }
  const focusRow =
    cursor?.kind === "choice"
      ? spec.body.length + 1 + cursor.selected
      : cursor?.kind === "line"
        ? spec.body.length
        : undefined
  const box = dialogBox(
    {
      title: spec.title,
      body: [...spec.body, ...modalExtra],
      footer: spec.footer,
      minWidth: boxW,
      maxWidth: boxW,
      ...(focusRow != null ? { focusRow } : {}),
    },
    Math.max(20, cols),
    safeRows,
  )
  sink.paintRegion(box.lines, box.topRow)
  if (!cursor) return
  const focus = cursor.kind === "choice" ? focusRow! : spec.body.length
  const visible = focus - box.bodyStart
  if (visible < 0 || box.bodyTop + visible >= box.lines.length) return
  const row = box.topRow + box.bodyTop + visible
  const stripped = stripAnsi(box.lines[box.bodyTop + visible] ?? "")
  const leftPad = boxLeftPad(stripped)
  let col = leftPad + 3
  if (cursor.kind === "line") {
    const maxCol = leftPad + 2 + innerW + 1
    col = Math.min(maxCol, leftPad + 7 + lineCursorOffset)
  }
  try {
    sink.moveCursor?.(row, Math.max(1, Math.min(cols, col)))
  } catch {}
}

export async function promptAsk(call: ApprovalRequest): Promise<"allow" | "deny" | "always"> {
  if (!process.stdin.isTTY) return "deny"
  const sink = getApprovalSink()
  // Tanpa sink (one-shot/exec) + stdout pipe: prompt tak terlihat dan blok
  // mencemari stdout program → fail-closed (kontrak I23).
  if (!sink && !process.stdout.isTTY) return "deny"
  // Bell hanya bila stdout TTY: `\x07` di stdout pipe mengotori output program.
  if (process.env.MINICODE_BELL !== "0" && process.stdout.isTTY) process.stdout.write("\x07")
  // Live-region screen reader: teks polos, bukan escape mentah.
  if (process.env.MINICODE_A11Y === "1")
    process.stderr.write(`${t("appr.a11y", { name: sanitizeAnsiLine(call.name) })}\n`)

  // toolName/actionSummary dari model/MCP (tak terpercaya): `\x1b[2J` di args
  // bisa membersihkan layar saat prompt tampil → sanitasi wajib.
  const toolName = sanitizeAnsiLine(call.name)
  const args = (call.args ?? {}) as Record<string, unknown>

  // Sanitasi DULU, potong SESUDAH: `slice` mentah bisa membelah surrogate pair
  // dan memotong sekuens ANSI di tengah (audit 2026-11-12, MEDIUM-1).
  const summarize = (value: unknown, max: number): string =>
    truncateToWidth(sanitizeAnsiLine(String(value)), max, glyphs.ellipsis)
  let actionSummary = ""
  if (args.command) actionSummary = `${t("appr.cmdLabel")} ${summarize(args.command, 100)}`
  else if (args.path) actionSummary = `${t("appr.fileLabel")} ${summarize(args.path, 100)}`
  else if (args.query) actionSummary = `${t("appr.queryLabel")} ${summarize(args.query, 100)}`
  else {
    let json = ""
    try {
      json = JSON.stringify(args)
    } catch {
      json = String(args)
    }
    actionSummary = `${t("appr.argsLabel")} ${summarize(json, 100)}`
  }
  actionSummary = sanitizeAnsiLine(actionSummary)

  // F-APPROVAL-1: pratinjau diff dari policy (sudah dibasuh secret) lebih jujur
  // dari ringkasan args; jalur tanpa diff tetap memakai ringkasan args.
  const diffPreview = call.diffPreview ? sanitizeAnsiLine(call.diffPreview) : ""
  const riskText = tierLabel(call.riskTier)

  const alwaysAvailable = call.canAlways !== false
  const summary = diffPreview ? `${t("appr.diff")} ${diffPreview}` : actionSummary

  const info = [
    `${c.bold(t("appr.tool"))} ${c.info(toolName)}`,
    ...(riskText ? [`${c.dim(t("appr.risk"))} ${c.info(riskText)}`] : []),
  ]
  const summaryLine = `  ${summary}`
  const modalBody = [...info, summaryLine]
  // Transkrip menyertakan batang judul; modal memakai bar title kotak.
  const block = [``, c.warning(c.bold(t("appr.title"))), ...info.map((l) => `  ${l}`), summaryLine]

  // Daftar opsi = sumber tunggal untuk footer, sorotan, dan ketik-cepat.
  // `keys`: huruf pembeda unik agar sinonim dwibahasa panjang cukup 1 ketukan.
  const choices: { label: string; keys: string[]; value: Decision }[] = [
    { label: t("appr.allowOnce"), keys: ["y", "e"], value: "allow" },
    ...(alwaysAvailable
      ? [{ label: t("appr.always"), keys: ["a", "l"], value: "always" as const }]
      : []),
    { label: t("appr.deny"), keys: ["n", "i"], value: "deny" },
  ]
  const quickMap: Record<string, number> = {}
  for (const [i, ch] of choices.entries()) for (const k of ch.keys) quickMap[k] = i
  // `selalu`→s, `tidak`→t: tak berbagi huruf pertama dengan label.
  quickMap.s = choices.findIndex((ch) => ch.value === "always")
  quickMap.t = choices.findIndex((ch) => ch.value === "deny")

  const choiceHint = hintLine([
    { key: glyphs.upDown, label: t("hint.move") },
    { key: "Enter", label: t("hint.select") },
    { key: "Esc", label: t("hint.cancel") },
  ])
  const idleHint = c.error(t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }))
  let pickedIndex: number | null = null
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    sink.suspend()
    try {
      pickedIndex = await readModalInput(
        "choice",
        ({ sel, warned }) => {
          const rendered = choices.map((ch, i) => listRow(ch.label, i === sel))
          paintModal(
            sink,
            {
              title: t("appr.title"),
              body: modalBody,
              footer: warned ? idleHint : choiceHint,
            },
            ["", ...rendered],
            { kind: "choice", selected: sel },
          )
        },
        { count: choices.length, quick: quickMap },
      )
    } finally {
      try {
        sink.clearRegion?.()
      } catch {}
      sink.resume()
    }
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
    const labels = choices.map((ch) => c.bold(ch.label)).join("  ")
    const raw = (await askLine({ prompt: `${labels}: ` })) ?? ""
    // Non-TUI tetap ketik (tak ada panah).
    const hit = quickMap[raw.trim().toLowerCase().slice(0, 1)]
    pickedIndex = hit != null && hit >= 0 ? hit : null
  }

  // Batal/indeks di luar rentang = deny (fail-closed).
  const chosen = pickedIndex != null ? choices[pickedIndex] : undefined
  const decisionKey =
    chosen?.value === "allow"
      ? ("appr.decAllow" as const)
      : chosen?.value === "always"
        ? ("appr.decAlways" as const)
        : ("appr.decDeny" as const)
  const decision = t(decisionKey)
  // Keputusan dicatat di transkrip (jejak audit); warisan mengandalkan
  // scrollback askLine yang terhapus repaint.
  if (sink) {
    sink.pushBlock([c.muted(`  ${glyphs.arrow} ${decision}`)])
    sink.repaint()
  }
  return decisionKey === "appr.decAlways"
    ? "always"
    : decisionKey === "appr.decAllow"
      ? "allow"
      : "deny"
}

/** View pertanyaan ask_user — di-inject ke src/tools/ask_user.ts dari cli/setup.ts.
 * Pertanyaan dari model (tak terpercaya) disanitasi sebelum tampil. Return null
 * bila user membatalkan (Esc/Ctrl+C) atau jawaban kosong. */
export async function promptAskText(
  question: string,
  options?: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const textSink = getApprovalSink()
  // Paritas promptAsk: tanpa sink + stdout pipe = jawab tak terlihat & pipe
  // tercemar → batal fail-closed.
  if (!textSink && !process.stdout.isTTY) return null
  // Potong SESUDAH sanitasi lewat truncateToWidth (bukan `slice`): `slice`
  // bisa menyisakan `\x1b[` menggantung di ekor potongan.
  const q = truncateToWidth(sanitizeAnsiLine(question), 2000, glyphs.ellipsis)
  const optionLines = options?.length
    ? options.map((o, i) => `  ${c.dim(`${i + 1}.`)} ${sanitizeAnsiLine(o)}`)
    : []
  const block = [``, `${c.warning(c.bold(t("appr.askTitle")))}`, `  ${q}`, ...optionLines]
  const modalBody = [`  ${q}`, ...optionLines]
  const lineHint = hintLine([
    { key: "Enter", label: t("hint.submit") },
    { key: "Esc", label: t("hint.cancel") },
  ])
  const idleHint = c.error(t("form.idleWarning", { s: Math.ceil(IDLE_CANCEL_MS / 1000) }))
  const sink = textSink
  let ans: string | null = null
  if (sink) {
    sink.pushBlock(block)
    sink.repaint()
    sink.suspend()
    try {
      ans = await readModalInput(
        "line",
        ({ typed, cursor, warned }) =>
          paintModal(
            sink,
            {
              title: t("appr.askTitle"),
              body: modalBody,
              footer: warned ? idleHint : lineHint,
            },
            [],
            { kind: "line", typed, cursor },
          ),
        {},
        signal,
      )
    } finally {
      try {
        sink.clearRegion?.()
      } catch {}
      sink.resume()
    }
  } else {
    for (const l of block) process.stdout.write(`${l}\n`)
    ans = await askLine({ prompt: `${c.bold(t("appr.answerPrompt"))}` })
  }
  if (ans == null || !ans.trim()) return null
  const out = ans.trim()
  // Opsi bernomor: petakan "1".."n" ke teks (AUD-008); teks bebas diteruskan.
  const pick = options?.length ? /^\s*(\d+)\s*$/.exec(out) : null
  const mapped = pick ? options?.[Number(pick[1]) - 1] : undefined
  const finalAnswer = mapped ?? out
  if (sink) {
    // Gema jawaban juga dipotong lewat truncateToWidth: `slice` bisa membelah
    // surrogate pair (emoji → U+FFFD) atau menyisakan escape menggantung.
    sink.pushBlock([
      c.muted(
        `  ${glyphs.arrow} ${truncateToWidth(sanitizeAnsiLine(finalAnswer), 200, glyphs.ellipsis)}`,
      ),
    ])
    sink.repaint()
  }
  return finalAnswer
}
