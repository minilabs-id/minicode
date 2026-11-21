import type { Message } from "#minicore/core/types.ts"
import { classifyContractTool, TOOL_CONTRACTS } from "./tool-contract.ts"

/**
 * Microcompact — pangkas ISI hasil tool lama jadi sentinel pendek: tanpa
 * membuang pesan, tanpa LLM, tanpa menyentuh pasangan `assistant(toolCalls)`
 * → `tool` yang masih berlangsung.
 *
 * KENAPA: pada sesi panjang hasil tool adalah penyumbang payload terbesar
 * (>90% karakter konteks di lapangan). Kompaksi penuh mahal + lossy; memangkas
 * isi lama jauh lebih murah dan mempertahankan struktur percakapan. Lapisan
 * pertama sebelum kompaksi penuh, bukan penggantinya.
 *
 * KENAPA keepRecent=5: model masih butuh hasil terakhir untuk menyimpulkan
 * langkah berikutnya; 5 = titik kumpul lintas implementasi harness produksi.
 *
 * KENAPA gating tiga syarat: memangkas hasil kecil tak menghemat apa pun tapi
 * membuang informasi. Sepadan hanya bila (a) hemat berarti, (b) hasil tool
 * mendominasi, (c) bukan di tengah batch tool yang belum selesai.
 */

/**
 * Tool yang isinya adalah KEBENARAN yang tak dapat direkonstruksi: hasilnya
 * keadaan sesi (rencana, memori, hasil tugas), bukan observasi filesystem.
 * Memangkasnya membuat model kehilangan fakta tanpa cara memulihkannya.
 *
 * Diletakkan SEBELUM daftar turunan di bawah: `const` bersifat TDZ, jadi
 * membacanya dari initializer yang lebih awal akan melempar ReferenceError.
 */
const MICROCOMPACT_NEVER_TRIM: ReadonlySet<string> = new Set([
  "todo_read",
  "todo_write",
  "write_memory",
  "read_memory",
  "forget_memory",
  "submit_result",
  "ask_user",
])

/**
 * Tool yang hasilnya boleh dipangkas meskipun TIDAK `PURE_READ`.
 *
 * KENAPA ada: `bash`/`code_run` bertier `LOCAL_ENV_MUTATION` (bisa menulis
 * berkas), jadi tidak bisa dimasukkan lewat predikat baca-murni. Tetapi
 * keduanya penyumbang token TERBESAR di lapangan; mengeluarkannya berarti
 * konteks tak pernah menyusut justru di bagian yang paling gemuk. Mereka aman
 * dipangkas karena sentinel-nya memakai varian "JANGAN jalankan ulang" — model
 * diberi tahu untuk memverifikasi state, bukan mengulang efek sampingnya.
 */
const MICROCOMPACT_TRIMMABLE_MUTATORS: ReadonlySet<string> = new Set(["bash", "code_run"])

/** Tool yang hasilnya DAPAT dipulihkan (dibaca ulang kapan saja). Tool
 * bisa direkonstruksi dari filesystem — memangkasnya menghapus kebenaran.
 *
 * [Perbaikan microcompact] Daftar ini DITURUNKAN dari kontrak tool, bukan
 * diketik manual. Daftar manual sebelumnya menyimpang dua arah sekaligus: memuat
 * tool yang TIDAK PERNAH ADA (`list_dir`, `view_file`) dan melewatkan tool baca
 * nyata yang outputnya besar (`git_diff` sampai 500k karakter, `git_log`,
 * `read_image`, `lsp_diagnostics`). Itu berarti hasil terbesar di sesi tidak
 * pernah bisa dipangkas; sekarang himpunan ini mengikuti registry yang sama
 * dengan jurnal dan permission.
 *
 * Kriteria: tier `PURE_READ` ATAU baca jaringan yang `allowedInReadonly` ATAU
 * pemutasi yang hasilnya dominan (`bash`, `code_run`), DAN BUKAN tool
 * kontrol-sesi (yang keadaannya tak dapat direkonstruksi). */
export const MICROCOMPACT_RECOVERABLE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CONTRACTS.filter(
    (c) =>
      !MICROCOMPACT_NEVER_TRIM.has(c.name) &&
      (MICROCOMPACT_TRIMMABLE_MUTATORS.has(c.name) ||
        (c.journalMutation === false && (c.sideEffectTier === "PURE_READ" || c.allowedInReadonly))),
  ).map((c) => c.name),
)

/** Awalan sentinel. Stabil supaya bisa dikenali ulang (idempoten) dan supaya
 * model tahu isinya dipangkas, bukan kosong. */
export const MICROCOMPACT_SENTINEL_PREFIX = "[hasil tool lama dipangkas"

/**
 * Apakah mengulang tool ini berbahaya?
 *
 * KENAPA ini ada: sentinel menyuruh model "jalankan ulang tool ini", instruksi
 * yang BENAR untuk tool baca (idempoten, hasilnya bisa dipulihkan) tetapi
 * SALAH untuk tool yang memutasi. `bash` ada di daftar recoverable karena ia
 * penyumbang token terbesar, padahal isinya bisa `rm`, migrasi, atau tulis file:
 * mengulangnya menduplikasi efek samping. `unknown` diperlakukan sama dengan
 * `mutation` (fail-closed) — tool yang lupa didaftarkan tidak boleh dianggap
 * aman untuk diulang.
 *
 * Diekspor murni (tanpa I/O) supaya konsumen lain bisa mengklasifikasikan tool
 * dengan aturan yang SAMA tanpa menyalin logika. Catatan batas lapisan:
 * `src/ui/**` dilarang mengimpor modul non-ui ini (ui-boundary.test.ts), jadi
 * renderer transkrip memakai cermin lokal untuk klasifikasi tampilannya.
 */
export function replayIsUnsafe(toolName: string | undefined): boolean {
  if (toolName === undefined) return true
  return classifyContractTool(toolName) !== "none"
}

export interface MicrocompactOptions {
  /** Hasil tool TERBARU yang dipertahankan utuh. Default 5. */
  keepRecent?: number
  /** Estimator token (disuntik agar modul tetap murni). */
  estimateTokens: (text: string) => number
  /** Hemat minimum agar pemangkasan sepadan. Default 20.000 token. */
  minSavingTokens?: number
  /** Porsi total hasil tool agar pemangkasan dipertimbangkan (default 40%). */
  minToolShare?: number
  /** Budget konteks efektif (jendela - reserve). Wajib untuk syarat (b). */
  budgetTokens?: number
}

export interface MicrocompactResult {
  readonly messages: readonly Message[]
  readonly clearedCount: number
  readonly savedTokens: number
  /** Diisi bila tak memangkas — dibedakan dari "tak ada yang bisa dipangkas"
   * supaya pemanggil tidak melaporkan no-op palsu. */
  readonly skippedReason?: "below-saving" | "below-share" | "no-candidates" | "in-flight-batch"
}

/** Konten pesan → teks untuk diukur. Objek bersarang di-stringify aman. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (content === null || content === undefined) return ""
  if (content instanceof Uint8Array) return `[binary ${content.byteLength} bytes]`
  try {
    return JSON.stringify(content) ?? ""
  } catch {
    return String(content)
  }
}

/**
 * Indeks hasil tool yang berada dalam batch AKTIF (toolCall terakhir dari
 * assistant terakhir yang belum punya hasil lengkap).
 *
 * KENAPA penting: memangkas sebagian hasil dari satu batch multi-tool membuat
 * model melihat observasi setengah jadi — lebih menyesatkan daripada konteks
 * penuh. Batch dianggap aktif selama ia adalah grup `tool` terakhir.
 */
function activeBatchIds(messages: readonly Message[]): Set<string> {
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i
    return -1
  })()
  if (lastAssistantIdx < 0) return new Set()
  // Semua hasil tool SETELAH assistant terakhir (bila ada) adalah batch aktif.
  const ids = new Set<string>()
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role === "tool") ids.add(m.toolCallId)
  }
  return ids
}

/**
 * Murni (input tak dimutasi). Semua syarat harus lulus, jika tidak pesan
 * dikembalikan apa adanya: (1) kandidat = hasil tool yang dapat dipulihkan di
 * luar batch aktif, (2) melebihi `keepRecent`, (3) hemat ≥ `minSavingTokens`,
 * (4) total hasil tool ≥ `minToolShare` × budget.
 */
export function applyMicrocompact(
  messages: readonly Message[],
  opts: MicrocompactOptions,
): MicrocompactResult {
  const keepRecent = Math.max(1, opts.keepRecent ?? 5)
  const minSaving = Math.max(0, opts.minSavingTokens ?? 20_000)
  const minShare = opts.minToolShare ?? 0.4
  const inFlight = activeBatchIds(messages)

  // Dari belakang: `keepRecent` terbaru dipertahankan.
  const candidates: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "tool") continue
    if (!MICROCOMPACT_RECOVERABLE_TOOLS.has(m.name)) continue
    if (inFlight.has(m.toolCallId)) continue
    const text = contentText(m.content)
    if (text.startsWith(MICROCOMPACT_SENTINEL_PREFIX)) continue // sudah dipangkas
    candidates.push(i)
  }
  if (candidates.length === 0)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "no-candidates" }
  // `candidates` terurut dari belakang; `keepRecent` pertama = terbaru.
  const victims = candidates.slice(keepRecent)
  if (victims.length === 0)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "no-candidates" }

  // (b): hasil tool harus mendominasi budget, kalau tidak ia hanya membuang
  // informasi demi sedikit token.
  const toolTokens = candidates.reduce(
    (sum, i) => sum + opts.estimateTokens(contentText(messages[i]!.content)),
    0,
  )
  if (opts.budgetTokens !== undefined && opts.budgetTokens > 0) {
    if (toolTokens < opts.budgetTokens * minShare)
      return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "below-share" }
  }

  let clearedCount = 0
  let savedTokens = 0
  const out = messages.slice()
  for (const idx of victims) {
    const m = messages[idx] as Extract<Message, { role: "tool" }>
    const original = contentText(m.content)
    const wasError = m.isError === true
    // Dua teks berbeda untuk dua situasi berbeda. Tool baca: aman diulang.
    // Tool bermutasi: JANGAN diulang — verifikasi dulu, karena mengulang bisa
    // menduplikasi efek (`rm`, tulis file, migrasi). Tanpa pemisahan ini model
    // menerima instruksi berbahaya hanya karena hasilnya panjang.
    const hint = replayIsUnsafe(m.name)
      ? `JANGAN jalankan ulang${wasError ? " (panggilan ini sudah gagal)" : ""}: tool ini dapat mengubah state (berkas/lingkungan), mengulangnya bisa menduplikasi efek. Verifikasi state lebih dulu (mis. baca berkas/hasil) sebelum mengulang.`
      : "Jalankan ulang tool ini bila isinya masih dibutuhkan."
    const sentinel = `${MICROCOMPACT_SENTINEL_PREFIX}: ${m.name} ${original.length} char${wasError ? ", gagal" : ""}. ${hint}]`
    // Hemat = token asli - token sentinel; lewati jika sentinel justru lebih panjang.
    const saving = opts.estimateTokens(original) - opts.estimateTokens(sentinel)
    if (saving <= 0) continue
    out[idx] = { ...m, content: sentinel }
    clearedCount++
    savedTokens += saving
  }

  // (c): hemat harus berarti. Bila tidak, batalkan seluruh operasi.
  if (savedTokens < minSaving)
    return { messages, clearedCount: 0, savedTokens: 0, skippedReason: "below-saving" }

  return { messages: out, clearedCount, savedTokens }
}
