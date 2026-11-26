// Byte-level BPE tokenizer murni TS (tanpa dependensi) — kompatibel dengan
// `tokenizer.json` HuggingFace (keluarga GPT-2/llama/deepseek/qwen/mistral).
//
// Ini replikasi algoritma tiktoken/HF `tokenizers`: byte-to-unicode mapping,
// regex pre-tokenizer, dan greedy pair merge. Dipakai sebagai pengukur token
// AKURAT (bukan chars/4) untuk model open yang mempublikasikan vocab-nya —
// menutup celah under-count yang membuat konteks meledak tanpa disadari.

export interface BpeData {
  vocab: Record<string, number>
  merges: Array<string | [string, string]>
}

/** Map byte -> unicode (sama dengan tiktoken/HF): printable = dirinya, non-
 * printable -> ␀..ÿ (256+n). Byte 32 (spasi) -> Ġ, byte 10 -> Ċ, dst. */
function byteEncoder(): Map<number, string> {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i) // !..~
  for (let i = 161; i <= 172; i++) bs.push(i) // ¡..¬
  for (let i = 174; i <= 255; i++) bs.push(i) // ®..ÿ
  const cs: number[] = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }
  const map = new Map<number, string>()
  for (let i = 0; i < bs.length; i++) map.set(bs[i]!, String.fromCodePoint(cs[i]!))
  return map
}

const BYTE_TO_UNICODE = byteEncoder()
// Satu instance TextEncoder di level modul — hindari alokasi per-kata.
const TEXT_ENCODER = new TextEncoder()
const MAX_PIECE_CACHE = 8_192
const MAX_EXACT_PIECE_LEN = 512

// Regex pre-tokenizer persis tiktoken (keluarga GPT-2 BPE).
const PAT =
  /(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu

function byteEncode(text: string): string[] {
  const bytes = TEXT_ENCODER.encode(text)
  const out = new Array<string>(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = BYTE_TO_UNICODE.get(bytes[i]!) ?? ""
  return out
}

/** Terapkan BPE merge pada satu "kata" (string unicode) memakai rank merge. */
function bpeMerge(token: string[], mergeRanks: Map<string, number>): string[] {
  const parts = token.slice()
  // Greedy: gabungkan pasangan ber-rank terendah (tertinggi) selama ada.
  for (;;) {
    let bestIdx = -1
    let bestRank = Infinity
    for (let i = 0; i + 1 < parts.length; i++) {
      const rank = mergeRanks.get(`${parts[i]!} ${parts[i + 1]!}`)
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    parts[bestIdx] = parts[bestIdx]! + parts[bestIdx + 1]!
    parts.splice(bestIdx + 1, 1)
  }
  return parts
}

export class BpeTokenizer {
  private mergeRanks: Map<string, number>
  private pieceCache = new Map<string, number>()

  constructor(data: BpeData) {
    // merges = urutan rank (indeks pertama = prioritas tertinggi).
    // Gunakan kunci berpemisah spasi ("a b") agar pasangan berbeda seperti
    // ("ab","c") vs ("a","bc") tidak bertabrakan; dukung juga format tuple HF v2.
    this.mergeRanks = new Map()
    data.merges.forEach((pair, index) => {
      if (Array.isArray(pair)) {
        if (typeof pair[0] === "string" && typeof pair[1] === "string") {
          this.mergeRanks.set(`${pair[0]} ${pair[1]}`, index)
        }
      } else if (typeof pair === "string") {
        this.mergeRanks.set(pair, index)
      }
    })
  }

  /** Jumlah token (ID unik) dalam teks. */
  countTokens(text: string): number {
    if (!text) return 0
    let total = 0
    for (const piece of text.match(PAT) ?? []) {
      if (!piece) continue
      // Potongan raksasa tanpa pemisah (base64/minified) bisa membuat merge O(L²)
      // membeku; pakai estimasi konservatif agar admission budget tetap aman & cepat.
      if (piece.length > MAX_EXACT_PIECE_LEN) {
        total += Math.ceil(piece.length / 3)
        continue
      }
      const cached = this.pieceCache.get(piece)
      if (cached !== undefined) {
        total += cached
        continue
      }
      const token = byteEncode(piece)
      const count = bpeMerge(token, this.mergeRanks).length
      if (this.pieceCache.size >= MAX_PIECE_CACHE) {
        let drop = MAX_PIECE_CACHE >>> 2
        for (const key of this.pieceCache.keys()) {
          this.pieceCache.delete(key)
          if (--drop <= 0) break
        }
      }
      this.pieceCache.set(piece, count)
      // Setiap bagian jadi satu token; vocab lookup (>0 selalu ada di BPE terlatih).
      total += count
    }
    return total
  }
}

/** Bangun tokenizer dari objek tokenizer.json (model.vocab + model.merges). */
export function loadBpeTokenizer(model: {
  vocab: Record<string, number>
  merges: Array<string | [string, string]>
}): BpeTokenizer {
  return new BpeTokenizer({ vocab: model.vocab, merges: model.merges })
}
