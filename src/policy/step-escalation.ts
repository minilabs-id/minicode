/**
 * Eskalasi adaptif batas langkah per turn.
 *
 * KENAPA: batas langkah adalah backstop anti-runaway, bukan anggaran kerja.
 * Angka tunggal (dulu 50) salah di dua arah sekaligus — terlalu kecil untuk
 * kerja nyata (pada sesi `17b6a5ff`, 4 dari 5 `turn.failed` adalah
 * `exceeded 50 steps`), dan terlalu besar bila dipakai sebagai izin kerja
 * tanpa batas. Solusinya bukan memilih satu angka ajaib, melainkan: mulai dari
 * default yang waras, lalu NAIKKAN satu tangga ketika sesi terbukti mentok.
 *
 * KENAPA tangga, bukan "unlimited": tanpa batas atas, agent yang berputar
 * (lihat LOOP_GUARD `READ_ONLY_THRASHING`) membakar token tanpa henti. Sesi
 * yang sama sudah membakar ≈16,7 juta token. Tangga memberi ruang cukup
 * sambil mempertahankan backstop yang terbatas dan dapat diramalkan.
 *
 * KENAPA satu tangga per kejadian: menaikkan langsung ke puncak menghapus
 * sinyal "sesi ini memang rakus". Satu langkah per `max_steps_exceeded`
 * membuat pertumbuhan sebanding dengan kebutuhan nyata.
 *
 * Modul ini murni (tanpa I/O, tanpa state global) agar bisa diuji langsung
 * dan dipakai baik oleh sesi utama maupun sub-agent.
 */

/** Tangga batas langkah. 200 = default kerja nyata; 4× lipat per tangga. */
export const STEP_LIMIT_LADDER: readonly number[] = [200, 400, 800, 1_600, 3_200, 6_400] as const

/** Batas atas absolut. Di atas ini, "mentok langkah" bukan lagi masalah
 * anggaran melainkan tanda agent berputar — harus berhenti, bukan naik. */
export const STEP_LIMIT_CEILING = 6_400

/**
 * Batas langkah default untuk sesi utama.
 *
 * KENAPA 200 dan bukan 50: kerja nyata (baca, edit, jalankan tes, perbaiki)
 * butuh ratusan langkah. 50 memaksa turn terputus di tengah tugas dan
 * membuang langkah yang sudah dipakai.
 */
export const DEFAULT_SESSION_MAX_STEPS = 200

/**
 * Batas langkah default untuk sub-agent.
 *
 * KENAPA tetap 50 sementara sesi utama 200: sub-agent berjalan PARALEL
 * (`SUB_AGENT_POOL_SIZE`) dan tiap langkahnya memicu panggilan model sendiri.
 * Naiknya biaya runaway di sini berlipat dengan jumlah sub-agent, sedangkan
 * tugas sub-agent umumnya lebih sempit. Sub-agent tetap mendapat eskalasi
 * adaptif yang sama ketika benar-benar mentok.
 */
export const DEFAULT_SUB_AGENT_MAX_STEPS = 50

/** Anak tangga berikutnya di atas `current`, atau `undefined` bila sudah di
 * batas atas. Tidak melompat: satu langkah per kejadian. */
export function nextStepLadderStep(current: number): number | undefined {
  const cur = Number.isFinite(current) && current > 0 ? current : 0
  for (const step of STEP_LIMIT_LADDER) {
    if (step > cur) return Math.min(step, STEP_LIMIT_CEILING)
  }
  return undefined
}

/**
 * Hitung batas langkah baru setelah satu `max_steps_exceeded`.
 *
 * `observedSteps` = jumlah langkah yang benar-benar terpakai. Bila pengamatan
 * sudah melampaui batas yang berlaku (mis. operator menaikkan batas manual di
 * tengah jalan), naik dari pengamatan — bukan dari batas lama — supaya
 * tangganya tidak "melewati" kebutuhan nyata.
 *
 * Mengembalikan `undefined` bila tidak ada kenaikan yang sah (sudah di puncak,
 * atau hasilnya tidak lebih besar dari batas sekarang). Pemanggil WAJIB
 * memperlakukan `undefined` sebagai "hentikan, jangan ulang" — bukan sebagai
 * izin melanjutkan tanpa batas.
 */
export function nextStepLimit(currentLimit: number, observedSteps: number): number | undefined {
  const base = Number.isFinite(currentLimit) && currentLimit > 0 ? Math.floor(currentLimit) : 0
  const observed =
    Number.isFinite(observedSteps) && observedSteps > 0 ? Math.floor(observedSteps) : 0
  const from = Math.max(base, observed)
  const next = nextStepLadderStep(from)
  if (next === undefined || next <= base) return undefined
  return next
}
