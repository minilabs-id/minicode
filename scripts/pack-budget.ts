// Sumber tunggal budget ukuran paket (dipakai `scripts/pack-check.ts` dan `test/pack-integrity.test.ts`).
// Satuan: KiB (1 KiB = 1024 byte), diukur dari `unpackedSize` `npm pack --dry-run --json`.
// Budget 5.500 KiB berfungsi sebagai alarm regresi agar test/artefak/node_modules tak ikut terkemas.
export const PACK_SIZE_BUDGET_KIB = 5500

/**
 * True bila ukuran paket (KiB) masih di dalam budget.
 *
 * Ketat (`<`, bukan `<=`): paket tepat di batas dianggap melimpah, supaya
 * batas berarti "di bawah N" dan tidak ada dua angka yang sama dengan dua
 * makna.
 */
export function withinSizeBudget(
  unpackedKb: number,
  budgetKb: number = PACK_SIZE_BUDGET_KIB,
): boolean {
  return unpackedKb < budgetKb
}
