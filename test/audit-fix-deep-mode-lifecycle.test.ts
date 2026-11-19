// Audit deep-mode — cleanup job background pada jalur keluar proses.
//
// `close()` hanya dipanggil shutdown normal. Handler sinyal di src/ui/tui/app.ts
// memanggil process.exit() langsung, sehingga tanpa hook `exit` proses yatim
// (dev server / watcher / node -e yang di-spawn bash background) tetap hidup.
// Test ini bersifat struktural: memastikan hook terpasang dan callback aman
// dipanggil berulang (close() + exit, atau exit dari dua sumber).

import { describe, expect, test } from "bun:test"
import { backgroundJobExitCleanup, installBackgroundJobExitCleanup } from "../cli/setup.ts"

describe("audit deep-mode — exit-path background job cleanup", () => {
  test("hook `exit` terpasang tepat sekali meski dipanggil berulang", () => {
    const before = process.listenerCount("exit")
    // `cli/setup.ts` memanggil installer sekali saat modul di-load. Di suite
    // besar hook sudah terpasang sebelum test ini jalan; di suite terisolasi
    // belum. Keduanya sah — yang dijaga adalah IDEMPOTENSI, bukan angka absolut.
    const alreadyInstalled = process.listeners("exit").includes(backgroundJobExitCleanup)
    installBackgroundJobExitCleanup()
    const afterFirst = process.listenerCount("exit")
    installBackgroundJobExitCleanup()
    const afterSecond = process.listenerCount("exit")

    expect(afterFirst).toBe(alreadyInstalled ? before : before + 1)
    expect(afterSecond).toBe(afterFirst)
    expect(process.listeners("exit").includes(backgroundJobExitCleanup)).toBe(true)
  })

  test("callback cleanup idempoten: dua pemanggilan tak melempar", () => {
    expect(() => {
      backgroundJobExitCleanup()
      backgroundJobExitCleanup()
    }).not.toThrow()
  })
})
