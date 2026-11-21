// Model sidebar — SATU sumber kebenaran untuk histori, scroll, dan follow.
//
// v0.33 (audit): dulu data ada di Transcript, scroll/follow di App — dua objek
// yang mudah drift saat resize/toggle. Sekarang state ada di sini; Transkrip
// hanya mengisi, App hanya membaca + menggulir. Murni: tanpa I/O/TTY.

import { t } from "../i18n/locale.ts"
import { normalizeThinkingLine, toolDisplayName } from "./activity-format.ts"
import { c, glyphs } from "./theme.ts"
import { wrapByWidth } from "./width.ts"

export type SidebarPane = "thinking" | "activity" | "live"

/** Tool yang SEDANG berjalan — data terstruktur (bukan string hasil format)
 *  supaya jendela Live bisa menampilkan status, durasi, dan jumlah child. */
export interface LiveToolRecord {
  readonly id: string
  readonly name: string
  readonly target?: string
  readonly startedAt: number
  readonly childCount?: number
  readonly detail?: string
}

export interface LiveToolView extends LiveToolRecord {
  readonly elapsedMs: number
}

export interface SidebarSnapshot {
  /** Baris siap render (sudah di-wrap pada `width`). */
  readonly thinking: readonly string[]
  readonly activity: readonly string[]
  readonly live: readonly string[]
  readonly version: number
}

const MAX_THINKING_CHARS = 200_000
const MAX_ACTIVITY_LINES = 2_000

export class SidebarModel {
  private thinkingRaw = ""
  /** Hitungan code point inkremental — Hindari `Array.from()` seluruh buffer
   *  tiap chunk (O(n²) pada reasoning panjang). */
  private thinkingCodePoints = 0
  /** High surrogate terakhir bisa terpisah antar delta stream — simpan dulu. */
  private pendingHighSurrogate = ""
  private activityLines: string[] = []
  /** Timestamp paralel untuk referensi waktu relatif di jendela Activity. */
  private activityTimes: number[] = []
  /** Memo Live per (rev, detik, lebar) — hindari sort+map tiap paint. */
  private liveCacheKey = ""
  private liveCache: string[] = []
  /** Jumlah data yang dibuang karena cap — ditampilkan jujur, bukan diam-diam. */
  private thinkingDropped = 0
  private activityDropped = 0
  private rev = 0
  private scroll: Record<SidebarPane, number> = { thinking: 0, activity: 0, live: 0 }
  private follow: Record<SidebarPane, boolean> = { thinking: true, activity: true, live: true }
  /** Live tools: id -> record terstruktur. SATU penulis (upsert/remove). */
  private liveTools = new Map<string, LiveToolRecord>()
  /** Porsi tinggi kotak thinking (bisa diubah user; 30–80%). */
  private thinkingRatio = 0.6
  /** Jendela yang baru saja menerima data — dipakai App untuk auto-focus. */
  private lastTouchedPane: SidebarPane = "thinking"

  get version(): number {
    return this.rev
  }

  get lastTouched(): SidebarPane {
    return this.lastTouchedPane
  }

  get ratio(): number {
    return this.thinkingRatio
  }

  /** Ubah rasio kotak atas; dipanggil shortcuts resize. */
  adjustRatio(delta: number): void {
    const next = Math.max(0.3, Math.min(0.8, this.thinkingRatio + delta))
    if (next === this.thinkingRatio) return
    this.thinkingRatio = next
    this.rev++
  }

  /** SATU-SATUNYA penulis activityLines. Semua jalur (termasuk markTurn)
   *  wajib lewat sini supaya cap & marker tak bisa dibypass. */
  private pushActivityLine(line: string): void {
    this.activityLines.push(line)
    this.activityTimes.push(Date.now())
    if (this.activityLines.length > MAX_ACTIVITY_LINES) {
      const dropped = this.activityLines.length - MAX_ACTIVITY_LINES
      this.activityDropped += dropped
      this.activityLines.splice(0, dropped)
      this.activityTimes.splice(0, dropped)
    }
  }

  /** Tandai awal turn: SATU baris jeda + penanda tipis, bukan teks "turn N". */
  markTurn(): void {
    const marker = `   ${glyphs.dot}  ${glyphs.dot}  ${glyphs.dot}`
    const addition = `${this.thinkingRaw ? "\n" : ""}\n${marker}\n`
    this.thinkingRaw += addition
    this.thinkingCodePoints += Array.from(addition).length
    this.pushActivityLine(marker)
    this.rev++
  }

  /**
   * Reasoning masuk sebagai aliran; dibatasi CODE POINT, kelebihan ditandai.
   *
   * v0.33 (audit sesi 91681815): dulu `Array.from(raw + text)` dipanggil tiap
   * delta → O(n²), tiap chunk menyalin seluruh buffer jadi array 200k elemen.
   * Sekarang konkatenasi `+=` (rope V8, murah) + hitungan code point inkremental;
   * konversi ke array HANYA saat memang perlu memangkas head (excess = 1 chunk).
   * High surrogate yang terbelah antar delta ditahan dulu supaya emoji tak jadi
   * lone surrogate.
   */
  ingestThinking(text: string): void {
    if (!text) return
    let chunk = this.pendingHighSurrogate + text
    this.pendingHighSurrogate = ""
    if (chunk.length > 0) {
      const last = chunk.charCodeAt(chunk.length - 1)!
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingHighSurrogate = chunk.slice(-1)
        chunk = chunk.slice(0, -1)
      }
    }
    if (!chunk) return

    const added = Array.from(chunk).length // O(chunk), bukan O(total)
    this.thinkingCodePoints += added
    this.thinkingRaw += chunk

    if (this.thinkingCodePoints > MAX_THINKING_CHARS) {
      const excess = this.thinkingCodePoints - MAX_THINKING_CHARS
      // Potong `excess` code point dari HEAD (bukan UTF-16 unit) — aman untuk emoji.
      let i = 0
      let cut = 0
      while (i < this.thinkingRaw.length && cut < excess) {
        const cp = this.thinkingRaw.codePointAt(i)!
        i += cp > 0xffff ? 2 : 1
        cut++
      }
      this.thinkingRaw = this.thinkingRaw.slice(i)
      this.thinkingCodePoints = MAX_THINKING_CHARS
      this.thinkingDropped += excess
    }
    this.lastTouchedPane = "thinking"
    this.rev++
  }

  /** Satu baris aktivitas (tool/sub-agent/finding) masuk ke log. */
  ingestActivity(line: string): void {
    if (!line) return
    this.pushActivityLine(line)
    this.lastTouchedPane = "activity"
    this.rev++
  }

  // ── Live tools (record terstruktur) ─────────────────────────────────────

  /** Tambah/perbarui tool yang sedang berjalan. */
  upsertLive(record: LiveToolRecord): void {
    this.liveTools.set(record.id, record)
    this.lastTouchedPane = "live"
    this.rev++
  }

  /** Tool selesai → keluar dari Live (pindah ke log lewat ingestActivity). */
  removeLive(id: string): void {
    if (!this.liveTools.delete(id)) return
    this.rev++
  }

  /** Rekaman live untuk modal detail (dipanggil App saat Enter). */
  liveRecord(id: string): LiveToolView | undefined {
    const r = this.liveTools.get(id)
    return r ? { ...r, elapsedMs: Math.max(0, Date.now() - r.startedAt) } : undefined
  }

  /** Daftar live terurut mulai yang terlama. */
  liveRecords(now = Date.now()): readonly LiveToolView[] {
    return [...this.liveTools.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((r) => ({ ...r, elapsedMs: Math.max(0, now - r.startedAt) }))
  }

  /** Wrap sekali di sini — App & renderer menerima baris yang sama persis. */
  snapshot(width: number): SidebarSnapshot {
    const w = Math.max(1, width)
    const thinking = this.thinkingRaw
      .split("\n")
      .map(normalizeThinkingLine)
      .flatMap((l) => wrapByWidth(l, w))
      // Baris kosong beruntun dirapikan jadi SATU — teks tak hilang, cuma
      // napas berlebih dari reasoning model yang dibersihkan.
      .filter((l, i, arr) => l.trim() !== "" || (i > 0 && arr[i - 1]?.trim() !== ""))
    const now = Date.now()
    const activity = this.activityLines.flatMap((l, i) => {
      const age = Math.max(0, Math.round((now - (this.activityTimes[i] ?? now)) / 1000))
      // Referensi waktu HANYA untuk baris yang sudah agak lama (>3s) — baris
      // segar tetap bersih, jadi log tidak Penuh angka.
      const prefix = age > 3 ? c.gray(`·${age}s `) : ""
      return wrapByWidth(`${prefix}${l}`, w).map((line) => line.trimEnd())
    })
    // Marker JUJUR saat histori terpotong — user tahu ada data lama yang tak
    // lagi tampil di sidebar (journal/DB tetap sumber lengkap).
    if (this.thinkingDropped > 0)
      thinking.unshift(t("sidebar.historyTrimmed", { n: this.thinkingDropped }))
    if (this.activityDropped > 0)
      activity.unshift(t("sidebar.historyTrimmed", { n: this.activityDropped }))
    // Live: SATU baris per tool — `› read file.ts · 12s · 2c`. Nama memakai
    // toolDisplayName yang sama dengan Activity (konsisten), detik pakai `s`
    // (bukan `d` yang bisa dibaca "days"), dan segala meta memakai warna muted.
    const second = Math.floor(now / 1000)
    const liveKey = `${this.rev}:${second}:${w}`
    let live: string[]
    if (liveKey === this.liveCacheKey) {
      live = this.liveCache
    } else {
      live = this.liveRecords(now).flatMap((r) => {
        const secs = Math.max(0, Math.round(r.elapsedMs / 1000))
        const name = c.info(toolDisplayName(r.name))
        const target = r.target ? ` ${c.gray(r.target)}` : ""
        const meta = c.gray(`${secs}s${r.childCount != null ? ` · ${r.childCount}c` : ""}`)
        return wrapByWidth(`${glyphs.arrow} ${name}${target} · ${meta}`, w).map((line) =>
          line.trimEnd(),
        )
      })
      this.liveCacheKey = liveKey
      this.liveCache = live
    }
    return { thinking, activity, live, version: this.rev }
  }

  isFollowing(pane: SidebarPane): boolean {
    return this.follow[pane]
  }

  scrollOffset(pane: SidebarPane): number {
    return this.scroll[pane]
  }

  maxScroll(pane: SidebarPane, width: number, capacity: number): number {
    const snap = this.snapshot(width)
    const lines = pane === "thinking" ? snap.thinking : pane === "live" ? snap.live : snap.activity
    return Math.max(0, lines.length - Math.max(1, capacity))
  }

  /** Gulir pane; follow otomatis aktif lagi saat mencapai ekor. */
  scrollPane(pane: SidebarPane, n: number, width: number, capacity: number): void {
    const max = this.maxScroll(pane, width, capacity)
    const next = Math.max(0, Math.min(max, this.scroll[pane] + n))
    this.scroll[pane] = next
    this.follow[pane] = next >= max
  }

  /** Dipanggil tiap frame: follow = ekor, manual = offset tetap. */
  syncFollow(pane: SidebarPane, width: number, capacity: number): void {
    if (this.follow[pane]) this.scroll[pane] = this.maxScroll(pane, width, capacity)
  }

  /** Home/End: lompat ke kepala atau ekor sekaligus mengubah status follow. */
  jumpToEdge(pane: SidebarPane, top: boolean, width: number, capacity: number): void {
    this.scroll[pane] = top ? 0 : this.maxScroll(pane, width, capacity)
    this.follow[pane] = !top
  }

  reset(): void {
    this.thinkingRaw = ""
    this.thinkingCodePoints = 0
    this.pendingHighSurrogate = ""
    this.activityLines = []
    this.activityTimes = []
    this.liveTools.clear()
    this.liveCacheKey = ""
    this.liveCache = []
    this.thinkingDropped = 0
    this.activityDropped = 0
    this.scroll = { thinking: 0, activity: 0, live: 0 }
    this.lastTouchedPane = "thinking"
    this.follow = { thinking: true, activity: true, live: true }
    this.rev++
  }
}
