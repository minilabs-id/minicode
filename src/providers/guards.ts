// Penjaga stream provider (F-11 timeout, F-16 text-cap).
//
// Dua lubang yang ditutup di SATU titik (buildProviderList) sehingga berlaku
// untuk SEMUA adapter termasuk vendor openai-compat yang tak boleh disentuh:
//  1. Tanpa fetch timeout, server hung = turn hung sampai timeout turn.
//  2. Akumulasi `text` provider tanpa cap = OOM pada stream raksasa.
//
// Bentuk wrapper meniru pola withStrippedRetry, DITAMBAH preservasi properti
// (`...provider`: kind untuk router, clearResponsesChain untuk responses).
// Abort parent diteruskan apa adanya (tak pernah ditelan/dikonversi); hanya
// timeout MILIK guard yang diklasifikasikan ulang menjadi ProviderError
// "server" agar tak dikira network-putus atau abort-user.
import { Buffer } from "node:buffer"
import { abortError, ProviderError } from "#minicore/core/errors.ts"
import type { ModelProvider, ProviderEvent, StreamRequest } from "#minicore/core/provider.ts"
import { LIMITS } from "../constants.ts"

export function withStreamGuards(
  provider: ModelProvider,
  opts: {
    timeoutMs?: number
    /** Batas diam (tanpa byte) sebelum request dianggap mati. 0 = nonaktif. */
    idleTimeoutMs?: number
    maxTextChars?: number
    maxReasonChars?: number
    maxToolArgBytes?: number
    maxTotalToolArgBytes?: number
  } = {},
): ModelProvider {
  const configuredTimeout = opts.timeoutMs
  const timeoutMs =
    typeof configuredTimeout === "number" &&
    Number.isFinite(configuredTimeout) &&
    configuredTimeout > 0
      ? Math.min(LIMITS.MAX_TIMER_DELAY_MS, Math.max(1, Math.floor(configuredTimeout)))
      : LIMITS.PROVIDER_REQUEST_TIMEOUT_MS
  const configuredIdle = opts.idleTimeoutMs
  const idleTimeoutMs =
    typeof configuredIdle === "number" && Number.isFinite(configuredIdle) && configuredIdle >= 0
      ? Math.min(LIMITS.MAX_TIMER_DELAY_MS, Math.floor(configuredIdle))
      : LIMITS.PROVIDER_IDLE_TIMEOUT_MS
  const maxTextChars = opts.maxTextChars ?? LIMITS.PROVIDER_TEXT_MAX_CHARS
  // Reasoning = bukan bagian jawaban; cap agresif (2MB logis ≈ 500k token —
  // jauh di atas reasoning sah mana pun, jauh di bawah OOM).
  const maxReasonChars = opts.maxReasonChars ?? LIMITS.PROVIDER_REASON_MAX_CHARS
  const maxToolArgBytes = opts.maxToolArgBytes ?? LIMITS.PROVIDER_TOOL_ARGS_MAX_BYTES
  const maxTotalToolArgBytes =
    opts.maxTotalToolArgBytes ?? LIMITS.PROVIDER_TOOL_ARGS_PENDING_MAX_BYTES
  let nextAttemptId = 0
  return {
    ...provider,
    id: provider.id,
    get models() {
      return provider.models
    },
    async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (signal.aborted) throw abortError(signal)
      const attemptId = ++nextAttemptId
      const attemptEvent = (
        phase: "started" | "completed" | "invalidated",
        fields: { hadVisibleOutput?: boolean; reason?: string } = {},
      ): ProviderEvent => ({
        type: "extension",
        kind: "minicode:attempt",
        data: { phase, attemptId, ...fields },
      })
      yield attemptEvent("started")
      const ctl = new AbortController()
      const onParentAbort = () => ctl.abort(signal.reason)
      if (signal.aborted) ctl.abort(signal.reason)
      else signal.addEventListener("abort", onParentAbort, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        ctl.abort(new Error(`provider request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // Timeout DIAM (audit freeze 2026-11-16): timer total di atas membiarkan
      // provider yang tak pernah mengirim byte menahan turn sampai 5 menit —
      // user tak bisa membedakannya dari hang. Timer ini di-reset setiap ada
      // frame masuk, jadi hanya koneksi yang benar-benar berhenti bicara yang
      // dipotong; stream panjang (reasoning, output besar) tidak tersentuh.
      const idleMs = idleTimeoutMs > 0 ? idleTimeoutMs : 0
      let idleFired = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const armIdle = () => {
        if (!idleMs) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          idleFired = true
          ctl.abort(new Error(`provider sent nothing for ${idleMs}ms (connection stalled)`))
        }, idleMs)
      }
      armIdle()
      const stopTimers = () => {
        clearTimeout(timer)
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = undefined
      }
      let textChars = 0
      let reasonChars = 0
      let toolArgumentBytes = 0
      let marked = false
      let reasonMarked = false
      let finishReason: "stop" | "tool_calls" | "length" | "abort" | "error" | undefined
      let hadVisibleOutput = false
      let invalidated = false
      let streamEnded = false
      let iterator: AsyncIterator<ProviderEvent> | undefined
      try {
        iterator = provider.stream(request, ctl.signal)[Symbol.asyncIterator]()
        while (true) {
          const next = await nextOrAbort(iterator, ctl.signal)
          if (next.done) {
            streamEnded = true
            break
          }
          // Ada frame masuk = koneksi masih hidup; jadwal diam dimulai ulang.
          armIdle()
          const ev = next.value
          if (
            finishReason !== undefined &&
            (ev.type === "text" || ev.type === "tool_call" || ev.type === "finish")
          ) {
            throw new ProviderError("network", "provider emitted content after finish")
          }
          if (ev.type === "finish") {
            finishReason = ev.reason
            if (ev.reason !== "stop" && ev.reason !== "tool_calls") {
              invalidated = true
              yield attemptEvent("invalidated", {
                hadVisibleOutput,
                reason: `finish:${ev.reason}`,
              })
            }
            yield ev
            continue
          }
          if (ev.type === "tool_call") {
            let serialized: string
            try {
              serialized = JSON.stringify(ev.args ?? {}) ?? ""
            } catch {
              throw new ProviderError(
                "invalid_request",
                "provider returned unserializable tool arguments",
              )
            }
            const argBytes = Buffer.byteLength(serialized, "utf8")
            toolArgumentBytes += argBytes
            if (argBytes > maxToolArgBytes || toolArgumentBytes > maxTotalToolArgBytes) {
              const error = new ProviderError(
                "invalid_request",
                "provider tool arguments exceed configured byte limits",
              )
              ctl.abort(error)
              throw error
            }
          }
          // F-16 diperluas (investigasi Phase 5): extension "reasoning" juga
          // diakumulasi kernel (loop `reasoning += ev.data.text` TANPA cap) —
          // dulu hanya ev.type "text" yang dipotong, sehingga reasoning stream
          // adalah satu-satunya jalur akumulasi tak terbatas (terbukti probe
          // E-2: 200MB+ chars, heap tumbuh, tanpa cap). Cap terpisah karena
          // reasoning bukan bagian jawaban — boleh dipotong agresif tanpa
          // merusak konten hasil.
          if (ev.type === "text" && typeof ev.text === "string" && ev.text) {
            if (textChars >= maxTextChars) continue
            textChars += ev.text.length
            if (textChars > maxTextChars) {
              const keep = ev.text.slice(0, ev.text.length - (textChars - maxTextChars))
              if (keep) {
                hadVisibleOutput = true
                yield { type: "text", text: keep }
              }
              if (!marked) {
                marked = true
                hadVisibleOutput = true
                yield { type: "text", text: "\n… [provider text truncated: turn cap exceeded]" }
              }
              continue
            }
            hadVisibleOutput = true
          } else if (ev.type === "extension" && ev.kind === "reasoning") {
            const d = ev.data as { text?: unknown } | undefined
            if (typeof d?.text === "string" && d.text) {
              if (reasonChars >= maxReasonChars) continue
              reasonChars += d.text.length
              if (reasonChars > maxReasonChars) {
                const keep = d.text.slice(0, d.text.length - (reasonChars - maxReasonChars))
                if (keep) {
                  hadVisibleOutput = true
                  yield { type: "extension", kind: "reasoning", data: { text: keep } }
                }
                if (!reasonMarked) {
                  reasonMarked = true
                  hadVisibleOutput = true
                  yield {
                    type: "extension",
                    kind: "reasoning",
                    data: { text: "\n… [reasoning truncated: cap exceeded]" },
                  }
                }
                continue
              }
              hadVisibleOutput = true
            }
          }
          yield ev
        }
        if (finishReason === "stop" || finishReason === "tool_calls") {
          yield attemptEvent("completed", { hadVisibleOutput })
        } else if (!invalidated) {
          invalidated = true
          yield attemptEvent("invalidated", {
            hadVisibleOutput,
            reason: "missing-finish",
          })
        }
      } catch (e) {
        if (!invalidated) {
          invalidated = true
          yield attemptEvent("invalidated", {
            hadVisibleOutput,
            reason: timedOut ? "timeout" : idleFired ? "stalled" : "stream-error",
          })
        }
        if (timedOut)
          throw new ProviderError("server", `provider request timed out after ${timeoutMs}ms`)
        // Diam total = kegagalan sisi server yang bisa diulang, bukan abort user.
        // Diklasifikasikan "server" supaya jalur pemulihan bersama (anggaran
        // T-009) yang menanganinya, dengan pesan yang menyebut SEBABNYA.
        if (idleFired)
          throw new ProviderError(
            "server",
            `provider sent nothing for ${idleTimeoutMs}ms (connection stalled)`,
          )
        throw e
      } finally {
        stopTimers()
        signal.removeEventListener("abort", onParentAbort)
        if (!streamEnded && !ctl.signal.aborted) {
          ctl.abort(new DOMException("Provider stream closed", "AbortError"))
        }
        // Selalu tutup generator dalam bila belum EOF (termasuk consumer break
        // tepat di `finish` pada kompaksi / judul sub-agent) agar reader & soket
        // HTTP langsung dilepas, bukan bocor menggantung.
        if (!streamEnded && iterator?.return) {
          try {
            void Promise.resolve(iterator.return()).catch(() => {})
          } catch {}
        }
      }
    },
  }
}

function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    let next: Promise<IteratorResult<T>>
    try {
      next = Promise.resolve(iterator.next())
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    next.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    function cleanup() {
      signal.removeEventListener("abort", onAbort)
    }
  })
}
