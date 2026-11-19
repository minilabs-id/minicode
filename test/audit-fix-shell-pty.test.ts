// Audit runtime /shell lewat PTY NYATA — menutup celah yang ditinggalkan
// `test/audit-fix-shell-handoff.test.ts`.
//
// [KENAPA FILE INI ADA] Test lama hanya membuktikan dua hal:
//   1. command layer meneruskan argumen ke hook `withShell` yang disuntikkan
//      (spy), dan
//   2. URUTAN simbol `releaseTerminal() → spawn(stdio:inherit) →
//      reacquireTerminal()` di `cli/tui.ts` lewat grep struktural.
// Keduanya BUKAN verifikasi runtime: hook aslinya (arrow inline di composition
// root) tak pernah benar-benar dispawn di bawah terminal. File ini menjalankan
// CLI sungguhan di pseudo-terminal, mengetik `/shell`, lalu mengamati byte
// stream untuk membuktikan handoff terjadi.
//
// [DUA TEST, JANGAN DISAMAKAN]
//   - Test E2E penuh: HANYA jalan di platform yang input PTY-nya bisa sampai ke
//     child cooked-mode (POSIX). Di win32 test di-SKIP dengan alasan eksplisit.
//   - Test PARTIAL (nama memuat "PARTIAL, bukan E2E"): jalan di win32 juga,
//     tapi HANYA membuktikan releaseTerminal + spawn shell prompt. Ia TIDAK
//     membuktikan eksekusi perintah maupun reacquire — lihat komentar di test.
//
// [KENAPA WIN32 DI-SKIP] Terbukti secara empiris di mesin ini: setelah `/shell`,
// prompt `C:\...\minicode-pty-XXX>` MUNCUL di byte stream (anak cmd.exe hidup,
// spawn + release berhasil), tetapi byte yang diketik (`echo <marker>\r`) TAK
// PERNAH sampai ke anak — 3x retry / 15 dtk tetap tak ada echo. Ini persis
// fragilitas ConPTY yang dicatat `test/helpers/pty-harness.ts`. Menulis test
// yang "lulus" dengan mengabaikan marker = hijau palsu; karena itu skip
// TERLIHAT lewat `test.skipIf`, bukan `return` diam-diam.

import { expect, test } from "bun:test"
import { ptyAvailable, spawnTui, type TuiPtyHandle } from "./helpers/pty-harness.ts"

// Konstanta `runtime/screen.ts`: ENTER = 1049h, EXIT = 1049l. `releaseTerminal()`
// menutup screen → EXIT; `reacquireTerminal()` membuka screen baru → ENTER.
// Keduanya tertulis di byte stream PTY sehingga bisa dihitung, bukan ditebak
// dari state internal.
const ALT_ENTER = "\x1b[?1049h"
const ALT_EXIT = "\x1b[?1049l"

const pty = await ptyAvailable()
const runsPty = pty.ok
const skipReason = pty.reason

/**
 * Input cooked-mode ke child stdio:inherit hanya dianggap dapat diverifikasi
 * di POSIX. Di win32 ConPTY, byte yang diketik tak sampai (bukti di header).
 * Ini BUKAN pelonggaran assertion: test E2E tidak dijalankan sama sekali bila
 * gate ini false — ia di-SKIP dengan nama yang memuat alasannya.
 */
const shellInputReliable = process.platform !== "win32"
const shellInputSkipReason =
  "win32 ConPTY: byte input ke child stdio:inherit tak sampai (prompt muncul tapi echo tak pernah tiba)"

function skipped(name: string, reason: string): string {
  return `${name} [skip: ${reason}]`
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let from = 0
  for (;;) {
    const i = haystack.indexOf(needle, from)
    if (i < 0) return n
    n++
    from = i + needle.length
  }
}

/**
 * Tunggu sampai jumlah `needle` melebihi `baseline`.
 *
 * [KENAPA BUKAN `raw.includes`] Stream append-only dan TUI sudah menulis ENTER
 * sekali saat boot. `includes` akan langsung benar karena byte lama → test
 * lulus tanpa handoff terjadi. Membandingkan jumlah terhadap baseline hanya
 * menerima SEKUENS BARU hasil aksi `/shell` / `exit`.
 */
async function waitForNewOccurrence(
  tui: TuiPtyHandle,
  needle: string,
  baseline: number,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const start = Date.now()
  for (;;) {
    const raw = tui.raw()
    if (countOccurrences(raw, needle) > baseline) return raw
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `${label} tak teramati dalam ${timeoutMs}ms — ` +
          `jumlah "${JSON.stringify(needle)}" = ${countOccurrences(raw, needle)} (baseline ${baseline}); ` +
          `ekor stream: ${JSON.stringify(raw.slice(-500))}`,
      )
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Spawn TUI di PTY hermetic + bersihkan di semua jalur (sukses/gagal/timeout).
 * `SHELL` dipaksa ke /bin/sh di POSIX supaya `exec "$SHELL"` di `cli/tui.ts`
 * menghasilkan shell interaktif deterministik yang menerima `echo` / `exit`.
 */
async function withTui(fn: (tui: TuiPtyHandle) => Promise<void>): Promise<void> {
  const tui = await spawnTui({
    cols: 100,
    rows: 30,
    env: process.platform === "win32" ? {} : { SHELL: "/bin/sh" },
  })
  try {
    await fn(tui)
  } finally {
    try {
      tui.kill()
    } catch {}
    // Anak cmd.exe ikut tertutup saat PTY induk diputus (terverifikasi: tak ada
    // proses cmd nyasar setelah beberapa kali run).
    await Promise.race([tui.exit(), new Promise((r) => setTimeout(r, 3000))])
    tui.dispose()
  }
}

/** Tunggu TUI siap: timer idle + alt-screen dari frame awal (pola pty.test.ts). */
async function waitForBoot(tui: TuiPtyHandle): Promise<void> {
  await tui.waitFor((raw) => raw.includes("00.00.00") && raw.includes(ALT_ENTER), 20_000)
}

const e2eName = "/shell E2E (PTY): release alt-screen → shell inherit jalankan perintah → reacquire"

test.skipIf(!runsPty || !shellInputReliable)(
  runsPty && shellInputReliable
    ? e2eName
    : skipped(e2eName, runsPty ? shellInputSkipReason : skipReason),
  async () => {
    await withTui(async (tui) => {
      await waitForBoot(tui)
      const enterBefore = countOccurrences(tui.raw(), ALT_ENTER)
      const exitBefore = countOccurrences(tui.raw(), ALT_EXIT)

      // Slash command diketik seperti test PTY lain (Enter = "\r").
      tui.send("/shell\r")
      // Tanpa releaseTerminal, listener TUI masih aktif dan perintah berikutnya
      // masuk ke composer, BUKAN ke shell — marker tak akan pernah muncul.
      const rawAfterRelease = await waitForNewOccurrence(
        tui,
        ALT_EXIT,
        exitBefore,
        15_000,
        "alt-screen keluar setelah /shell (releaseTerminal)",
      )
      const baseLen = rawAfterRelease.length
      const afterRelease = (raw: string): string => raw.slice(baseLen)

      // [KENAPA RETRY] PTY bisa membuang byte yang ditulis sebelum anak attach
      // ke stdin. Retry BUKAN pelonggaran assertion: marker unik tetap wajib
      // muncul di byte stream atau test GAGAL dengan diagnosa.
      const token = Math.random().toString(36).slice(2, 10).toUpperCase()
      const marker = `MINICODE_PTY_SHELL_OK_${token}`
      let markerSeen = false
      let lastError = ""
      for (let attempt = 1; attempt <= 3 && !markerSeen; attempt++) {
        tui.send(`echo ${marker}\r`)
        try {
          await tui.waitFor((raw) => afterRelease(raw).includes(marker), 5000)
          markerSeen = true
        } catch (error) {
          lastError = (error as Error).message
        }
      }
      if (!markerSeen) {
        throw new Error(
          `marker "${marker}" tak pernah muncul di byte PTY setelah 3x echo — ` +
            `shell anak mungkin tak attach ke stdin; ${lastError}`,
        )
      }

      // `exit` menutup shell → waitChildExit selesai → finally memanggil
      // reacquireTerminal() yang menulis ENTER baru dan me-repaint composer.
      tui.send("exit\r")
      const rawAfterExit = await waitForNewOccurrence(
        tui,
        ALT_ENTER,
        enterBefore,
        20_000,
        "alt-screen masuk lagi setelah exit (reacquireTerminal)",
      )

      // ENTER baru = reacquire; teks `minicode` = composer sungguhan di-repaint.
      expect(countOccurrences(rawAfterExit, ALT_ENTER)).toBeGreaterThan(enterBefore)
      expect(afterRelease(rawAfterExit)).toContain(ALT_ENTER)
      expect(afterRelease(rawAfterExit)).toContain("minicode")
    })
  },
  60_000,
)

// ── Test partial untuk platform yang inputnya tak bisa diverifikasi ──
// Nama dan komentar ini SENGAJA menyatakan batas klaim. Test ini TIDAK boleh
// disebut E2E: ia hanya melihat dua fakta yang memang teramati di win32.
const partialName =
  "[PARTIAL, bukan E2E] /shell (win32): releaseTerminal + prompt shell muncul di byte PTY"

test.skipIf(!runsPty || process.platform !== "win32")(
  runsPty ? partialName : skipped(partialName, skipReason),
  async () => {
    await withTui(async (tui) => {
      await waitForBoot(tui)
      const exitBefore = countOccurrences(tui.raw(), ALT_EXIT)

      tui.send("/shell\r")
      const rawAfterRelease = await waitForNewOccurrence(
        tui,
        ALT_EXIT,
        exitBefore,
        15_000,
        "alt-screen keluar setelah /shell (releaseTerminal)",
      )
      const releaseEnd = rawAfterRelease.lastIndexOf(ALT_EXIT) + ALT_EXIT.length

      // Dua fakta yang DIBUKTIKAN:
      //  1. EXIT baru → TUI benar-benar meninggalkan alt-screen (releaseTerminal).
      //  2. Path cwd hermetic muncul setelahnya → child shell (cmd.exe /K)
      //     menulis prompt ke terminal yang sama (spawn stdio:inherit jalan).
      expect(countOccurrences(rawAfterRelease, ALT_EXIT)).toBeGreaterThan(exitBefore)
      // [KENAPA waitFor] ConPTY kadang menunda byte prompt beberapa ratus ms;
      // assert seketika pernah merah padahal prompt akhirnya tiba.
      await tui.waitFor((raw) => raw.slice(releaseEnd).includes(tui.cwd), 15_000)
      expect(tui.raw().slice(releaseEnd)).toContain(tui.cwd)

      // Yang TIDAK dibuktikan (sengaja tidak di-assert di sini):
      //  - perintah yang diketik TAK pernah sampai ke child (ConPTY), jadi
      //    eksekusi `echo`/`exit` TIDAK diverifikasi;
      //  - karenanya reacquireTerminal() TIDAK diverifikasi di platform ini.
      // Keduanya hanya diverifikasi test E2E penuh di platform POSIX.
    })
  },
  45_000,
)
