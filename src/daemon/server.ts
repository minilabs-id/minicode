// Server IPC daemon (loopback TCP). Loopback dipilih karena lintas-platform:
// Unix socket tak ada di Windows, named pipe tak ada di POSIX. Capability
// bercakupan + endpoint 0600 membatasi akses ke proses mesin ini pemegang secret.
// Alur: hello -> welcome -> subscribe -> frontiers -> snapshot -> replay ->
// tail_marker -> LIVE. Event live yang seq-nya sudah di-replay dibuang (anti-duplikat).

import type { Server } from "node:net"
import { createServer, type Socket } from "node:net"
import type { RuntimeView } from "../runtime/runtime-status.ts"
import type { ApprovalBroker } from "./approvals.ts"
import { type CapabilityPayload, verifyCapability } from "./capability.ts"
import {
  type ControlActions,
  type ControlDeps,
  dispatchControl,
  type IdempotencyStore,
  toControlMessage,
} from "./control.ts"
import { buildSnapshot, REPLAY_PAGE_LIMIT, type SessionFeed } from "./feed.ts"
import { assertProtocol, encodeFrame, FrameDecoder, isRecord } from "./framing.ts"
import type { ApprovalView } from "./protocol.ts"
import {
  DAEMON_PROTOCOL,
  type DaemonScope,
  type HaltReason,
  type RefusalBody,
  type ServerMessage,
  type SubscribeFrom,
} from "./protocol.ts"
import { sanitizeJsonObject, sanitizeLabel } from "./sanitize.ts"
import { readConsumerOffset } from "./store.ts"
import { type Subscription, SubscriptionRegistry } from "./subscription.ts"
import type { Telemetry } from "./telemetry.ts"

export interface FeedRegistry {
  get(sid: string): SessionFeed | undefined
  known(): string[]
}

export interface DaemonServerDeps {
  incarnation: string
  secret: Buffer
  host: string
  port: number
  cwd?: string
  feeds: FeedRegistry
  subscriptions?: SubscriptionRegistry
  approvals: ApprovalBroker
  control: {
    actions: ControlActions | null
    idem: IdempotencyStore
    telemetry: Telemetry
    storageOk: () => boolean
    shuttingDown: () => boolean
    /** Status runtime kanonik; tanpa itu daemon menyajikan view ABSENT. */
    runtimeStatus?: () => RuntimeView
  }
  telemetry: Telemetry
  /** Seam uji batas antrean per langganan (produksi: MAX_QUEUE_PER_CONN). */
  maxQueuePerSubscription?: number
  /** Seam uji: batas antrean per identitas konsumen logis (lihat host). */
  maxQueuePerConsumer?: (consumerId: string) => number | undefined
  /** Batas koneksi pra-handshake bersamaan (anti-slowloris). Default 32. */
  maxPendingHandshakes?: number
  /** Batas waktu menunggu `hello` setelah TCP tersambung. Default 5000 ms. */
  preAuthTimeoutMs?: number
  /** Dipanggil saat daemon menerima koneksi (diagnostik). */
  onConnection?: (info: { remote: string; consumer: string }) => void
}

interface Conn {
  id: number
  socket: Socket
  decoder: FrameDecoder
  state: "new" | "ready"
  authTimer: ReturnType<typeof setTimeout> | null
  /** Identitas logis (`who`) untuk offset durable, idempotensi, dan label wire. */
  consumerId: string | null
  /** Scope langganan per koneksi: dua koneksi dengan `consumerId` sama tetap
   * punya langganan terpisah (teardown satu tak mencabut yang lain). */
  subscriptionScope: string | null
  scopes: DaemonScope[]
  /** Masa berlaku capability & nonce dari handshake — dicek ulang tiap operasi. */
  capExp: number | null
  capNonce: string | null
  subs: Map<string, Subscription>
  paused: boolean
  closed: boolean
  /** P2.3: replay yang berhenti karena socket backpressure; dilanjutkan saat drain. */
  pendingReplay?: { sid: string; consumer: string; fromSeq: number; head: number }
}

let connSeq = 0

// Pemisah mustahil di label (sanitizeLabel membuang kontrol). Scope live =
// identitas logis + id koneksi agar koneksi sama tak berbagi kunci langganan.
const CONSUMER_SCOPE_SEP = String.fromCharCode(1)
const DEFAULT_MAX_PENDING_HANDSHAKES = 32
const DEFAULT_PRE_AUTH_TIMEOUT_MS = 5_000

export class DaemonServer {
  readonly #deps: DaemonServerDeps
  readonly #subs: SubscriptionRegistry
  readonly #conns = new Map<number, Conn>()
  readonly #liveUnsub = new Map<string, () => void>()
  readonly #revokedNonces = new Map<string, number>()
  #server: Server | null = null
  #port = 0
  #closing = false
  #startedAt = 0

  constructor(deps: DaemonServerDeps) {
    this.#deps = deps
    this.#subs = deps.subscriptions ?? new SubscriptionRegistry()
  }

  get port(): number {
    return this.#port
  }

  get connectionCount(): number {
    return this.#conns.size
  }

  get closing(): boolean {
    return this.#closing
  }

  async start(): Promise<{ port: number }> {
    const h = this.#deps.host.trim()
    if (h !== "127.0.0.1" && h !== "::1" && h !== "localhost") {
      throw new Error(`daemon: menolak bind non-loopback host "${h}"`)
    }
    const server = createServer({ noDelay: true }, (socket) => this.#onConnection(socket))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e)
      server.once("error", onErr)
      server.listen(this.#deps.port, this.#deps.host, () => {
        server.off("error", onErr)
        resolve()
      })
    })
    const addr = server.address()
    if (addr === null || typeof addr === "string")
      throw new Error("daemon: alamat loopback tak terbaca")
    this.#port = addr.port
    this.#startedAt = Date.now()
    return { port: this.#port }
  }

  #onConnection(socket: Socket): void {
    const maxPending = this.#deps.maxPendingHandshakes ?? DEFAULT_MAX_PENDING_HANDSHAKES
    let pendingCount = 0
    for (const c of this.#conns.values()) {
      if (!c.closed && c.state === "new") pendingCount++
    }
    if (pendingCount >= maxPending) {
      this.#deps.telemetry.inc("connections.rejected")
      try {
        socket.destroy()
      } catch {}
      return
    }
    this.#deps.telemetry.inc("connections.opened")
    const preAuthMs = this.#deps.preAuthTimeoutMs ?? DEFAULT_PRE_AUTH_TIMEOUT_MS
    const conn: Conn = {
      id: ++connSeq,
      socket,
      decoder: new FrameDecoder(),
      state: "new",
      authTimer: null,
      consumerId: null,
      subscriptionScope: null,
      scopes: [],
      capExp: null,
      capNonce: null,
      subs: new Map(),
      paused: false,
      closed: false,
    }
    conn.authTimer = setTimeout(() => {
      if (conn.closed || conn.state !== "new") return
      this.#deps.telemetry.inc("connections.rejected")
      this.#sendError(conn, "PROTOCOL_ERROR", "timeout menunggu handshake hello")
      this.#halt(conn, "PROTOCOL_ERROR")
    }, preAuthMs)
    conn.authTimer.unref?.()
    this.#conns.set(conn.id, conn)

    socket.on("data", (chunk: Buffer) => {
      try {
        const msgs = conn.decoder.push(chunk)
        for (const m of msgs) this.#onMessage(conn, m)
      } catch (e) {
        this.#sendError(conn, "PROTOCOL_ERROR", String((e as Error).message ?? e))
        this.#halt(conn, "PROTOCOL_ERROR")
      }
    })
    socket.on("drain", () => {
      conn.paused = false
      const pending = conn.pendingReplay
      if (pending) {
        conn.pendingReplay = undefined
        this.#deps.telemetry.inc("replay.resumed")
        if (!this.#replayRange(conn, pending.sid, pending.consumer, pending.fromSeq, pending.head))
          return
      }
      this.#pump(conn)
    })
    const teardown = () => this.#teardown(conn)
    socket.on("close", teardown)
    socket.on("error", teardown)
  }

  #teardown(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.authTimer) {
      clearTimeout(conn.authTimer)
      conn.authTimer = null
    }
    this.#deps.telemetry.inc("connections.closed")
    // Tutup hanya langganan koneksi ini; consumerId logis akan memutus koneksi lain.
    const scope = conn.subscriptionScope ?? conn.consumerId
    if (scope) {
      this.#subs.dropConsumer(scope)
      this.#pruneLive()
    }
    this.#conns.delete(conn.id)
    conn.subs.clear()
    try {
      // `end()` dulu agar frame tertunda (mis. control_result) terkirim;
      // `destroy()` langsung membuangnya → CLI gagal padahal perintah sukses.
      conn.socket.end()
    } catch {
      // Socket sudah mati — bukan kegagalan yang perlu ditangani.
    }
    const sock = conn.socket
    const timer = setTimeout(() => {
      try {
        sock.destroy()
      } catch {
        /* sudah tertutup */
      }
    }, 150)
    timer.unref?.()
  }

  #send(conn: Conn, msg: ServerMessage): boolean {
    if (conn.closed) return false
    try {
      const ok = conn.socket.write(encodeFrame(msg))
      if (!ok) conn.paused = true
      return true
    } catch {
      this.#teardown(conn)
      return false
    }
  }

  #sendError(conn: Conn, code: RefusalBody["code"], message: string): void {
    this.#send(conn, { t: "error", code, message: sanitizeLabel(message, 400) })
  }

  /** Hentikan konsumen dengan alasan tegas + tutup koneksi. */
  #halt(conn: Conn, reason: HaltReason): void {
    if (conn.closed) return
    this.#send(conn, { t: "halt", reason })
    try {
      conn.socket.end()
    } catch {
      /* jatuh ke teardown di bawah */
    }
    // Halt = keputusan, bukan negosiasi: peer yang berhenti membaca bisa
    // menggantung `end()`. `#teardown` sudah menjadwalkan `destroy()` (150 ms).
    setTimeout(() => this.#teardown(conn), 50).unref?.()
  }

  // -------------------------------------------------------------------------
  // Pesan masuk
  // -------------------------------------------------------------------------

  #onMessage(conn: Conn, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.t !== "string") {
      this.#sendError(conn, "PROTOCOL_ERROR", "pesan bukan objek bertipe")
      this.#halt(conn, "PROTOCOL_ERROR")
      return
    }
    switch (raw.t) {
      case "hello":
        this.#onHello(conn, raw)
        return
      case "ping":
        this.#send(conn, { t: "pong", id: String(raw.id ?? "") })
        return
      case "goodbye":
        this.#teardown(conn)
        return
      default:
        break
    }
    if (conn.state !== "ready") {
      this.#sendError(conn, "INVALID_CAPABILITY", "hello diperlukan sebelum operasi lain")
      this.#halt(conn, "PROTOCOL_ERROR")
      return
    }
    switch (raw.t) {
      case "subscribe":
        this.#onSubscribe(conn, raw)
        return
      case "ack":
        this.#onAck(conn, raw)
        return
      case "control":
        this.#onControl(conn, raw)
        return
      default:
        this.#sendError(
          conn,
          "PROTOCOL_ERROR",
          `t tak dikenal: ${sanitizeLabel(String(raw.t), 40)}`,
        )
        this.#halt(conn, "PROTOCOL_ERROR")
    }
  }

  #onHello(conn: Conn, raw: Record<string, unknown>): void {
    try {
      assertProtocol({ protocol: raw.protocol })
    } catch (e) {
      this.#deps.telemetry.inc("connections.rejected")
      this.#sendError(conn, "PROTOCOL_ERROR", (e as Error).message)
      this.#teardown(conn)
      return
    }
    const check = verifyCapability(this.#deps.secret, String(raw.cap ?? ""), {
      incarnation: this.#deps.incarnation,
    })
    if (!check.ok) {
      this.#deps.telemetry.inc("connections.rejected")
      // Bedakan STALE_INCARNATION (daemon berganti) dari INVALID_CAPABILITY (cap tak sah).
      const code = check.reason === "STALE_INCARNATION" ? "STALE_INCARNATION" : "INVALID_CAPABILITY"
      this.#sendError(conn, code, `capability ditolak: ${check.reason}`)
      this.#teardown(conn)
      return
    }
    const payload: CapabilityPayload = check.payload
    this.#pruneRevoked(Date.now())
    if (this.#revokedNonces.has(payload.n)) {
      this.#deps.telemetry.inc("connections.rejected")
      this.#sendError(conn, "INVALID_CAPABILITY", "capability telah dicabut")
      this.#teardown(conn)
      return
    }
    if (conn.authTimer) {
      clearTimeout(conn.authTimer)
      conn.authTimer = null
    }
    conn.state = "ready"
    conn.scopes = payload.scopes
    conn.capExp = payload.exp
    conn.capNonce = payload.n
    conn.consumerId = sanitizeLabel(payload.who, 120) || `consumer-${conn.id}`
    conn.subscriptionScope = `${conn.consumerId}${CONSUMER_SCOPE_SEP}conn-${conn.id}`
    this.#send(conn, {
      t: "welcome",
      protocol: DAEMON_PROTOCOL,
      incarnation: this.#deps.incarnation,
      scopes: payload.scopes,
      consumer: conn.consumerId,
    })
    this.#deps.onConnection?.({
      remote: conn.socket.remoteAddress ?? "?",
      consumer: conn.consumerId,
    })
  }

  /** Verifikasi ulang TTL & pencabutan capability pada koneksi persisten. */
  #ensureCapAlive(conn: Conn): boolean {
    const now = Date.now()
    if (conn.capExp !== null && now > conn.capExp) {
      this.#sendError(conn, "INVALID_CAPABILITY", "capability telah kedaluwarsa")
      this.#teardown(conn)
      return false
    }
    if (conn.capNonce !== null && this.#revokedNonces.has(conn.capNonce)) {
      this.#sendError(conn, "INVALID_CAPABILITY", "capability telah dicabut")
      this.#teardown(conn)
      return false
    }
    return true
  }

  #onSubscribe(conn: Conn, raw: Record<string, unknown>): void {
    if (!this.#ensureCapAlive(conn)) return
    const sid = typeof raw.sid === "string" ? raw.sid : ""
    if (!sid) {
      this.#sendError(conn, "SESSION_MISMATCH", "sid wajib diisi")
      return
    }
    if (!conn.scopes.includes("subscribe")) {
      this.#sendError(conn, "SCOPE_DENIED", "subscribe membutuhkan cakupan subscribe")
      return
    }
    const feed = this.#deps.feeds.get(sid)
    if (!feed) {
      // Sesi tak dikenal = NOT_FOUND (SESSION_MISMATCH hanya untuk beda milik).
      this.#sendError(
        conn,
        "NOT_FOUND",
        `sesi ${sanitizeLabel(sid, 64)} tidak tersedia di daemon ini`,
      )
      return
    }
    const head = feed.head()
    const fromRaw = raw.from
    const from: SubscribeFrom =
      fromRaw === "tail" || fromRaw === "resume"
        ? fromRaw
        : typeof fromRaw === "number" && Number.isFinite(fromRaw)
          ? fromRaw
          : "resume" // default aman: tanpa replay penuh, progres ack tetap terjaga
    const consumer = conn.consumerId ?? `consumer-${conn.id}`
    // Scope live per koneksi; offset memakai identitas logis agar reconnect lanjut dari ack.
    const scope = conn.subscriptionScope ?? consumer
    const consumerQueue = this.#deps.maxQueuePerConsumer?.(consumer)

    const { sub, fromSeq } = this.#subs.attach(
      {
        consumerId: scope,
        offsetConsumerId: consumer,
        sid,
        from,
        head,
        fromSeq: 0,
        ...(consumerQueue !== undefined
          ? { maxQueue: consumerQueue }
          : this.#deps.maxQueuePerSubscription !== undefined
            ? { maxQueue: this.#deps.maxQueuePerSubscription }
            : {}),
        ...(this.#deps.cwd !== undefined ? { cwd: this.#deps.cwd } : {}),
      },
      (c, s) => readConsumerOffset(c, s, this.#deps.cwd),
    )
    conn.subs.set(sid, sub)
    this.#deps.telemetry.inc("subscribe.attached")

    // Pasang listener live sebelum replay: event yang tiba lebih dulu masuk
    // antrean lalu difilter cursor replay (celah replay/langganan mustahil).
    this.#ensureLive(sid)

    // 1) frontiers  2) snapshot  3) cursor
    const frontiers = feed.frontiers()
    this.#send(conn, { t: "frontiers", sid, frontiers })
    const { snapshot, rejected } = buildSnapshot(feed, undefined, frontiers)
    this.#send(conn, { t: "snapshot", sid, consumer, snapshot })
    this.#send(conn, {
      t: "subscribed",
      sid,
      consumer,
      fromSeq,
      cursor: sub.cursor,
      snapshotRejected: rejected,
      // Fase awal stream dari latch subscription (sumber tunggal, dihitung
      // `SubscriptionRegistry.attach` dari fromSeq vs head).
      phase: sub.phase,
    })

    // replay → replay_done → tail_marker → pump. Backpressure menjeda replay;
    // drain melanjutkan dari cursor tersimpan (tanpa ulang/buang sisa).
    if (!this.#replayRange(conn, sid, consumer, fromSeq, head)) return
    this.#pump(conn)
  }

  /** Replay resumable: saat `write()` false, `#send` menandai `conn.paused`;
   * loop berhenti sebelum buffer tak terbatas, `drain` lanjut dari cursor. */
  #replayRange(conn: Conn, sid: string, consumer: string, fromSeq: number, head: number): boolean {
    const sub = conn.subs.get(sid)
    if (!sub) return true
    const feed = this.#deps.feeds.get(sid)
    if (!feed) return true
    let replayTo = sub.cursor
    if (fromSeq <= head) {
      let cursor = fromSeq - 1
      for (;;) {
        const page = feed.readRange(cursor + 1, REPLAY_PAGE_LIMIT)
        if (page.events.length === 0) break
        for (const ev of page.events) {
          const seq = numberOr(ev.eventSeq, -1)
          if (seq < fromSeq) continue
          this.#send(conn, { t: "event", sid, consumer, seq, provenance: "REPLAY", event: ev })
          cursor = seq
          sub.cursor = seq
          this.#deps.telemetry.inc("events.replayed")
          if (conn.paused) {
            conn.pendingReplay = { sid, consumer, fromSeq: cursor + 1, head }
            this.#deps.telemetry.inc("replay.paused")
            return false
          }
        }
        if (page.events.length < REPLAY_PAGE_LIMIT) break
      }
      replayTo = sub.cursor
    }
    this.#send(conn, { t: "replay_done", sid, consumer, upToSeq: replayTo })
    // Penanda live-tail: setelah ini = LIVE (boleh belum durable). Latch diputar
    // sebelum kirim; nilai wire diambil dari latch (sumber tunggal fase).
    sub.markLive()
    this.#send(conn, { t: "tail_marker", sid, consumer, atSeq: replayTo, phase: sub.phase })
    conn.pendingReplay = undefined
    return true
  }

  #onAck(conn: Conn, raw: Record<string, unknown>): void {
    const sid = typeof raw.sid === "string" ? raw.sid : ""
    const seq = typeof raw.seq === "number" ? raw.seq : -1
    const sub = conn.subs.get(sid)
    if (!sub) {
      this.#sendError(conn, "SESSION_MISMATCH", "ack tanpa langganan aktif")
      return
    }
    const res = sub.ack(seq)
    if (!res.ok) {
      this.#deps.telemetry.inc("ack.rejected")
      this.#sendError(
        conn,
        res.reason === "CLOSED" ? "SHUTTING_DOWN" : "PROTOCOL_ERROR",
        res.reason === "CLOSED"
          ? "langganan sudah ditutup"
          : `ack ${seq} di luar jangkauan (cursor ${sub.cursor})`,
      )
      return
    }
    this.#deps.telemetry.inc("ack.accepted")
    this.#send(conn, { t: "ack_ok", sid, consumer: conn.consumerId ?? "", seq: res.persisted })
  }

  #onControl(conn: Conn, raw: Record<string, unknown>): void {
    if (!this.#ensureCapAlive(conn)) return
    const args = isRecord(raw.args) ? (sanitizeJsonObject(raw.args) as Record<string, unknown>) : {}
    const outcome = dispatchControl(
      {
        consumerId: conn.consumerId ?? `consumer-${conn.id}`,
        scopes: conn.scopes,
        op: String(raw.op ?? ""),
        idem: String(raw.idem ?? ""),
        args,
      },
      {
        incarnation: this.#deps.incarnation,
        ...(this.#deps.cwd !== undefined ? { cwd: this.#deps.cwd } : {}),
        actions: this.#deps.control.actions,
        approvals: this.#deps.approvals,
        telemetry: this.#deps.control.telemetry,
        storageOk: this.#deps.control.storageOk,
        shuttingDown: this.#deps.control.shuttingDown,
        ...(this.#deps.control.runtimeStatus
          ? { runtimeStatus: this.#deps.control.runtimeStatus }
          : {}),
      } satisfies ControlDeps,
      this.#deps.control.idem,
    )
    this.#send(conn, toControlMessage(outcome, String(raw.idem ?? "")))
  }

  // -------------------------------------------------------------------------
  // Fan-out live
  // -------------------------------------------------------------------------

  #ensureLive(sid: string): void {
    if (this.#liveUnsub.has(sid)) return
    const feed = this.#deps.feeds.get(sid)
    if (!feed) return
    // Jangan memoize feed non-hosted (liveSubscribe no-op); subscriber saat boot
    // bisa re-bind bila sesi kemudian menjadi hosted.
    if (!feed.hosted) return
    const unsub = feed.liveSubscribe((event) => this.#fanout(sid, event))
    this.#liveUnsub.set(sid, unsub)
  }

  #pruneLive(): void {
    // Lepas live untuk sesi yang tak lagi punya konsumen tertarik.
    for (const [sid, unsub] of [...this.#liveUnsub]) {
      const stillWanted = [...this.#conns.values()].some((c) => !c.closed && c.subs.has(sid))
      if (!stillWanted) {
        unsub()
        this.#liveUnsub.delete(sid)
      }
    }
  }

  #fanout(sid: string, event: { eventSeq?: number }): void {
    const seq = numberOr(event.eventSeq, -1)
    if (seq < 0) return

    // Snapshot target sebelum iterasi: `#halt` → `#teardown` memutasi daftar koneksi.
    for (const conn of [...this.#conns.values()]) {
      if (conn.closed) continue
      const sub = conn.subs.get(sid)
      if (!sub || sub.closed) continue
      // Event yang sudah tercakup replay = duplikat; lewati.
      if (seq <= sub.cursor) continue
      if (!sub.enqueue({ seq, provenance: "LIVE", event })) {
        this.#deps.telemetry.inc("events.dropped.overflow")
        sub.close()
        this.#halt(conn, "QUEUE_OVERFLOW")
        // Hentikan hanya konsumen ini; `return` membuat klien lain kehilangan
        // seq durable yang tak dikirim ulang.
        continue
      }
      this.#pump(conn)
    }
  }

  /** Dorong isi antrean live ke socket; berhenti bila socket menahan tulisan. */
  #pump(conn: Conn): void {
    if (conn.closed || conn.paused) return
    for (const [, sub] of conn.subs) {
      for (;;) {
        if (conn.closed || conn.paused) return
        const item = sub.takeFirst()
        if (!item) break
        if (item.provenance !== "LIVE") continue
        // Sudah terkirim via replay; kirim ulang = duplikat seq.
        if (item.seq <= sub.cursor) continue
        const sent = this.#send(conn, {
          t: "event",
          sid: sub.sid,
          consumer: conn.consumerId ?? "",
          seq: item.seq,
          provenance: item.provenance,
          event: item.event,
        })
        if (!sent) return
        sub.cursor = item.seq
        this.#deps.telemetry.inc("events.delivered")
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast + shutdown
  // -------------------------------------------------------------------------

  /** Usulan persetujuan -> konsumen ber-cakupan approve. */
  broadcastApproval(view: ApprovalView): number {
    let n = 0
    for (const conn of [...this.#conns.values()]) {
      if (conn.closed || !conn.scopes.includes("approve")) continue
      if (this.#send(conn, { t: "approval", consumer: conn.consumerId ?? "", approval: view })) n++
    }
    return n
  }

  /** Beri tahu SEMUA konsumen bahwa daemon berhenti. */
  broadcastHalt(reason: HaltReason): number {
    let n = 0
    for (const conn of [...this.#conns.values()]) {
      if (this.#send(conn, { t: "halt", reason })) n++
    }
    return n
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    this.broadcastHalt("SHUTTING_DOWN")
    for (const unsub of this.#liveUnsub.values()) unsub()
    this.#liveUnsub.clear()
    this.#subs.clear()
    for (const conn of [...this.#conns.values()]) this.#teardown(conn)
    const server = this.#server
    this.#server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Koneksi yang menolak menutup diri tidak boleh menahan shutdown.
      setTimeout(() => resolve(), 500).unref?.()
    })
  }

  /** Cabut nonce capability yang bocor sebelum masa berlaku `exp` habis. */
  revokeCapabilityNonce(nonce: string, expMs = Date.now() + 24 * 60 * 60 * 1000): void {
    if (!nonce) return
    this.#pruneRevoked(Date.now())
    this.#revokedNonces.set(nonce, expMs)
  }

  #pruneRevoked(now: number): void {
    for (const [n, exp] of this.#revokedNonces) {
      if (exp <= now) this.#revokedNonces.delete(n)
    }
  }

  get startedAt(): number {
    return this.#startedAt
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
