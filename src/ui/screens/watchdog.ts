// Batas waktu aksi jaringan (deteksi model, save/delete provider/model, submit
// wizard). Provider/tool non-kooperatif yang gantung selamanya membuat popup
// mati (suspend tanpa listener/timer, raw-mode digenggam) — timeout = error
// jujur + UI pulih; aksi telat yang akhirnya selesai diabaikan hasilnya.
//
// Dipakai bersamaan oleh picker/model-manager/provider-manager/wizard sehingga
// semantik timeout TIDAK drift antar jendela (dulu tiga salinan nyaris identik
// yang berisiko melenceng per permukaan — kelas OAP-001).
import { t } from "../i18n/locale.ts"

export function withTimeout<T>(
  fn: () => Promise<T> | T,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"))
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = Promise.resolve().then(fn)
  // Rejection telat TANPA handler = unhandledRejection (Bun: crash proses).
  pending.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const finish = (cb: () => void) => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      signal?.removeEventListener("abort", onAbort)
      cb()
    }
    const onAbort = () => finish(() => reject(new DOMException("aborted", "AbortError")))
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => finish(() => reject(new Error(t("ntc.timeout")))), ms)
    try {
      ;(timer as unknown as { unref?: () => void }).unref?.()
    } catch {}
    pending.then(
      (v) => finish(() => resolve(v)),
      (err) => finish(() => reject(err)),
    )
  })
}
