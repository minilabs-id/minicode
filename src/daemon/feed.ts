// P2.12 — sumber event per sesi untuk konsumen (snapshot + replay + live-tail).
//
// Kenapa sebuah antarmuka kecil: `CliSession` ada di `cli/` dan lapisan
// MELARANG `src/**` non-ui mengimpor `cli/`. Daemon boleh membaca toko durable
// dan memasang listener live, tetapi tidak boleh menarik tipe milik CLI. Yang
// daemon butuh hanya empat hal — kepala, frontier, baca rentang, langganan
// live — sehingga diwakili antarmuka sempit yang bisa diisi dari dua arah.

import type { DomainEvent } from "../presentation/events.ts"
import {
  getActiveRun,
  loadPresentationEventsRange,
  messageHead,
  presentationHead,
  readWriterEpoch,
} from "../session/persistence.ts"
import type { SessionFrontiers, SessionSnapshot } from "./protocol.ts"

/** Batas event dalam satu snapshot — memori daemon tak boleh ikut ukuran sesi. */
const SNAPSHOT_EVENT_LIMIT = 400

/** Batas per halaman replay — konsumen minta lanjut bila masih kurang. */
export const REPLAY_PAGE_LIMIT = 200

export interface SessionFeed {
  readonly sid: string
  /** true bila daemon ini mem-host penulis sesi ini (bukan sekadar pembaca). */
  readonly hosted: boolean
  head(): number
  frontiers(): SessionFrontiers
  /** Baca durable dari `fromSeq` (inklusif), terbatas `limit`. */
  readRange(
    fromSeq: number,
    limit: number,
  ): { events: DomainEvent[]; rejected: number; head: number }
  /** Pasang listener live; kembalikan fungsi lepas. Tak ada live bila !hosted. */
  liveSubscribe(fn: (event: DomainEvent) => void): () => void
}

function durableFrontiers(sid: string, cwd?: string): SessionFrontiers {
  const run = getActiveRun(sid, cwd)
  return {
    writerEpoch: readWriterEpoch(sid, cwd),
    presentationHead: presentationHead(sid, cwd),
    messageHead: messageHead(sid, cwd),
    runId: run?.run_id ?? null,
    runStatus: run?.status ?? null,
  }
}

/**
 * Feed baca-saja: sesi yang TIDAK di-host daemon ini (mis. sedang ditulis
 * proses CLI lain). `liveSubscribe` sengaja no-op — berpura-pura dapat live
 * dari sesi yang bukan milik kita akan membuat konsumen yakin ia melihat
 * sesuatu yang padahal datang dari sumber yang salah.
 */
export function createStoreFeed(sid: string, cwd?: string): SessionFeed {
  return {
    sid,
    hosted: false,
    head: () => presentationHead(sid, cwd),
    frontiers: () => durableFrontiers(sid, cwd),
    readRange: (fromSeq, limit) => loadPresentationEventsRange(sid, fromSeq, limit, cwd),
    liveSubscribe: () => () => {},
  }
}

export interface SnapshotResult {
  snapshot: SessionSnapshot
  /** true bila ada baris tak lolos decode — konsumen HARUS diberi tahu. */
  rejected: number
}

/**
 * Susun snapshot. SENGAJA non-atomik antar toko (kontrak §): frontier diambil
 * dari query terpisah dari baris presentasi, sehingga angka yang dikirim boleh
 * saja satu langkah di depan/di belakang isi `presentation`.
 *
 * Yang dijanjikan hanyalah: setiap angka adalah hasil pembacaan yang jujur
 * beserta provenance-nya. Yang DILARANG menyimpulkan: "snapshot ini = state
 * sesi pada satu titik waktu tunggal" — tidak ada transaksi yang menjamin itu.
 */
export function buildSnapshot(
  feed: SessionFeed,
  now = Date.now(),
  precomputedFrontiers?: SessionFrontiers,
): SnapshotResult {
  // [Audit #2 C.F3] Terima frontier yang sudah dihitung pemanggil (mis.
  // server.ts sudah mengambil feed.frontiers() untuk baris `frontiers`) agar tak
  // menghitung dua kali.
  const frontiers = precomputedFrontiers ?? feed.frontiers()
  const head = feed.head()
  const from = Math.max(0, head - SNAPSHOT_EVENT_LIMIT + 1)
  const { events, rejected, head: durableHead } = feed.readRange(from, SNAPSHOT_EVENT_LIMIT)
  return {
    snapshot: {
      sid: feed.sid,
      // Frontier dan baris bisa berbeda langkah (non-atomik, by design):
      // laporkan kepala durable terbaca supaya konsumen tahu isi `presentation`
      // berhenti di mana, terpisah dari frontier yang lebih baru.
      frontiers: {
        ...frontiers,
        presentationHead: Math.max(frontiers.presentationHead, durableHead),
      },
      presentation: events,
      provenance: "REPLAY",
      capturedAt: now,
    },
    rejected,
  }
}
