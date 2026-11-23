// Host daemon: siklus hidup, endpoint/lease, dan shutdown berurutan. Urutan
// salah menyisakan konsumen "terhubung", approval menggantung, dan lease basi;
// langkah bernomor diekspos agar bisa diuji, bukan sekadar dikomentari.

import { randomBytes, randomUUID } from "node:crypto"
import { currentRuntimeView } from "../runtime/runtime-status-provider.ts"
import { ApprovalBroker } from "./approvals.ts"
import { mintCapability } from "./capability.ts"
import { ChildSupervisor } from "./children.ts"
import { type ControlActions, IdempotencyStore } from "./control.ts"
import { clearDiscovery, type DaemonEndpoint, writeEndpoint, writeLease } from "./discovery.ts"
import type { DaemonScope } from "./protocol.ts"
import { ResourceMonitor } from "./resource.ts"
import { sanitizeLabel } from "./sanitize.ts"
import { DaemonServer, type FeedRegistry } from "./server.ts"
import { markPendingApprovalsUnknown } from "./store.ts"
import { Telemetry } from "./telemetry.ts"

export type ShutdownStep =
  | "mark-closing"
  | "halt-consumers"
  | "settle-approvals"
  | "close-hosted-session"
  | "stop-monitors"
  | "close-connections"
  | "retire-children"
  | "clear-discovery"

export interface DaemonHostOptions {
  cwd?: string
  host?: string
  /** 0 = port ephemeral (dipilih OS) — dipakai test & starter yang tak tahu port. */
  port?: number
  feeds: FeedRegistry
  actions?: ControlActions | null
  /** Label workspace untuk diagnosis (dibasuh). */
  workspace?: string
  leaseIntervalMs?: number
  /** TTL default capability yang diterbitkan host. */
  capabilityTtlMs?: number
  /** Kanal diagnostik host: test/pengendali non-interaktif menangkap pesan
   * tanpa menempel di stderr proses; satu kanal = semua tulis diaudit. */
  warn?: (msg: string) => void
  /** Seam penutup sesi yang di-host (bukan dependensi `cli/`): daemon hanya
   * tahu ada lifecycle yang harus ditunggu. Tanpa ini, anak proses bisa yatim
   * dan jurnal tak ditutup rapi saat daemon berhenti. */
  closeHostedSession?: (() => Promise<void>) | null
  /** Seam uji batas antrean per langganan; `0` = overflow deterministik. */
  maxQueuePerSubscription?: number
  /** Seam uji batas antrean per konsumen logis (tertahan tanpa efek ke lain). */
  maxQueuePerConsumer?: (consumerId: string) => number | undefined
}

export class DaemonHost {
  readonly incarnation: string
  readonly telemetry = new Telemetry()
  readonly approvals: ApprovalBroker
  readonly children: ChildSupervisor
  readonly idem = new IdempotencyStore()
  readonly server: DaemonServer
  readonly resource: ResourceMonitor

  readonly #secret: Buffer
  readonly #opts: DaemonHostOptions
  readonly #warn: (msg: string) => void
  #leaseTimer: ReturnType<typeof setInterval> | null = null
  #closing = false
  #shutdownSteps: ShutdownStep[] = []
  /** Kegagalan shutdown tercatat; cleanup tak boleh dilewati diam-diam. */
  #shutdownErrors: Error[] = []
  #endpointPath: string | null = null
  #port = 0

  private constructor(opts: DaemonHostOptions) {
    this.#opts = opts
    this.#warn = opts.warn ?? ((msg) => process.stderr.write(`${msg}\n`))
    this.incarnation = `inc_${randomUUID()}`
    // Secret hanya di memori: berkas yang bocor = siapa pun bisa menerbitkan capability admin.
    this.#secret = randomBytes(32)
    this.children = new ChildSupervisor({ telemetry: this.telemetry })
    this.approvals = new ApprovalBroker({
      incarnation: this.incarnation,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      propose: (view) => {
        this.telemetry.inc("approval.requested")
        this.server.broadcastApproval(view)
      },
      warn: (msg) => this.#warn(msg),
    })
    this.server = new DaemonServer({
      incarnation: this.incarnation,
      secret: this.#secret,
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 0,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      feeds: opts.feeds,
      approvals: this.approvals,
      control: {
        actions: opts.actions ?? null,
        idem: this.idem,
        telemetry: this.telemetry,
        storageOk: () => this.resource.state === "ok",
        shuttingDown: () => this.#closing,
        // Status runtime dari seam yang sama dengan CLI; tanpa runtime → view
        // ABSENT kanonik (bukan status karangan).
        runtimeStatus: () => currentRuntimeView(),
      },
      telemetry: this.telemetry,
      ...(opts.maxQueuePerSubscription !== undefined
        ? { maxQueuePerSubscription: opts.maxQueuePerSubscription }
        : {}),
      ...(opts.maxQueuePerConsumer !== undefined
        ? { maxQueuePerConsumer: opts.maxQueuePerConsumer }
        : {}),
    })
    this.resource = new ResourceMonitor({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      onPressure: (state, snap) => {
        if (state === "storage") {
          this.telemetry.inc("storage.pressure")
          this.#warn(
            `[daemon] tekanan penyimpanan: ${snap.reason ?? "unknown"} — pekerjaan baru ditahan`,
          )
        }
      },
    })
  }

  static async start(opts: DaemonHostOptions): Promise<DaemonHost> {
    const host = new DaemonHost(opts)
    await host.#boot()
    return host
  }

  async #boot(): Promise<void> {
    const { port } = await this.server.start()
    this.#port = port

    const ep: DaemonEndpoint = {
      version: 1,
      port,
      host: this.#opts.host ?? "127.0.0.1",
      incarnation: this.incarnation,
      startedAt: Date.now(),
      workspace: sanitizeLabel(this.#opts.workspace ?? "", 120),
      // Akar kepercayaan bagi klien menerbitkan capability sendiri (lihat endpoint).
      bootstrap: this.#secret.toString("base64url"),
    }
    this.#endpointPath = writeEndpoint(ep, this.#opts.cwd)
    this.#beatLease()
    const interval = Math.max(1_000, this.#opts.leaseIntervalMs ?? 5_000)
    this.#leaseTimer = setInterval(() => this.#beatLease(), interval)
    this.#leaseTimer.unref?.()

    // Tandai approval menggantung = UNKNOWN sebelum konsumen melihat (jangan
    // biarkan mereka membaca "pending" yang tak akan dijawab).
    const unknown = this.approvalsUnknownOnStart()
    if (unknown > 0) {
      this.#warn(`[daemon] ${unknown} persetujuan tak terjawab dari generasi sebelumnya -> UNKNOWN`)
    }

    this.resource.start()
  }

  /** Transisi persetujuan lama ke UNKNOWN saat start. Jumlah baris berpindah. */
  approvalsUnknownOnStart(): number {
    const n = markPendingApprovalsUnknown(this.incarnation, this.#opts.cwd)
    if (n > 0) this.telemetry.inc("approval.unknown.onRestart", n)
    return n
  }

  #beatLease(): void {
    if (this.#closing) return
    writeLease(
      {
        version: 1,
        incarnation: this.incarnation,
        pid: process.pid,
        updatedAt: Date.now(),
      },
      this.#opts.cwd,
    )
  }

  get port(): number {
    return this.#port
  }

  get closing(): boolean {
    return this.#closing
  }

  get shutdownSteps(): readonly ShutdownStep[] {
    return this.#shutdownSteps
  }

  /** Kegagalan shutdown tercatat; kosong = bersih. Kegagalan membuat
   * `shutdown()` menolak agar tak hilang tanpa jejak. */
  get shutdownErrors(): readonly Error[] {
    return [...this.#shutdownErrors]
  }

  get endpointPath(): string | null {
    return this.#endpointPath
  }

  /** Terbitkan capability bercakupan untuk konsumen. Secret tak pernah ikut. */
  issueCapability(opts: { scopes: DaemonScope[]; who: string; ttlMs?: number }): string {
    return mintCapability(this.#secret, {
      incarnation: this.incarnation,
      scopes: opts.scopes,
      ttlMs: opts.ttlMs ?? this.#opts.capabilityTtlMs ?? 10 * 60_000,
      who: opts.who,
    })
  }

  /** Shutdown berurutan, idempoten (dipanggil ulang = langkah sama).
   *  1 mark-closing         -> kontrol baru ditolak SHUTTING_DOWN
   *  2 halt-consumers       -> konsumen berhenti mengirim kerja
   *  3 settle-approvals     -> approval menggantung = DENY
   *  4 close-hosted-session -> jurnal ditutup, anak proses dibersihkan
   *  5 stop-monitors        -> lease + resource berhenti
   *  6 close-connections    -> socket ditutup
   *  7 retire-children      -> anak tak teronfirmasi = lost
   *  8 clear-discovery      -> berkas endpoint/lease dilepas
   */
  async shutdown(reason: string): Promise<ShutdownStep[]> {
    if (this.#closing) return [...this.#shutdownSteps]
    this.#closing = true
    this.#track("mark-closing")

    this.server.broadcastHalt("SHUTTING_DOWN")
    this.#track("halt-consumers")

    this.approvals.shutdownAll()
    this.#track("settle-approvals")

    // Tutup dan tunggu sesi yang di-host (jurnal + anak proses) sebelum daemon
    // menutup diri; tanpa ini proses anak bisa yatim.
    const closeSession = this.#opts.closeHostedSession
    if (closeSession) {
      try {
        await closeSession()
      } catch (e) {
        this.#shutdownErrors.push(e instanceof Error ? e : new Error(String(e)))
      }
      this.#track("close-hosted-session")
    }

    if (this.#leaseTimer) clearInterval(this.#leaseTimer)
    this.#leaseTimer = null
    this.resource.stop()
    this.#track("stop-monitors")

    await this.server.close()
    this.#track("close-connections")

    this.children.shutdown()
    this.#track("retire-children")

    clearDiscovery(this.incarnation, this.#opts.cwd)
    this.#track("clear-discovery")

    this.telemetry.inc("shutdown.ordered")
    void reason
    // Laporkan kegagalan sesudah semua cleanup: sisa langkah tak boleh dilewati,
    // tapi kegagalan juga tak boleh hilang (klaim "beres" yang palsu).
    if (this.#shutdownErrors.length > 0) {
      throw new AggregateError(
        this.#shutdownErrors,
        `daemon: shutdown selesai dengan ${this.#shutdownErrors.length} kegagalan`,
      )
    }
    return [...this.#shutdownSteps]
  }

  #track(step: ShutdownStep): void {
    if (!this.#shutdownSteps.includes(step)) this.#shutdownSteps.push(step)
  }
}
