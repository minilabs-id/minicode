# Plan Perbaikan Lanjutan Minicode (Evaluasi 6 Temuan Audit)

Tanggal: 2026-11-26
Status: Disetujui pemilik untuk riset, evaluasi, perencanaan, dan eksekusi penuh.

## Ringkasan Evaluasi & Batas Test Lock

Semua 6 temuan telah diaudit langsung terhadap kode sumber, batas lapisan (`test/ui-boundary.test.ts`), inventaris writer (`test/writer-inventory.test.ts`), paritas i18n (`test/i18n.test.ts`), dan anggaran distribusi (`scripts/pack-budget.ts`).

| # | Prioritas | Masalah | Risiko / Test Lock | Strategi Mitigasi |
|---|-----------|---------|--------------------|-------------------|
| 1 | P0 UX | Bracketed paste (`?2004h`) mati permanen di `TuiApp` setelah menutup popup/jendela output | `test/writer-inventory.test.ts` mengunci jumlah `process.stdout.write` langsung; `test/tui-app.test.ts` memeriksa pasangan `?2004h`/`?2004l` | Tambah `force = false` pada `TuiApp.setBracketedPaste`; matikan saat `suspend()` dan paksa aktif ulang (`force = true`) saat `resume()` + `reacquireTerminal()`. Simetriskan `picker.ts` saat filterable. |
| 2 | P1 Functional | URL unreachable diam-diam disimpan sukses via fallback dummy; hapus provider/model terakhir tidak membersihkan `activeModel`; onboarding pasca-penghapusan preset minim petunjuk | `test/provision-effort.test.ts` mengunci default `detectAndSave(..., { fallbackModels })` saat fetch throw; `test/provider-manager-flows.test.ts` menguji HTTP 500 fallback; `test/wizard.test.ts` mengunci 2-langkah `[1/2]` → `[2/2]` | Tambah opsi opt-in `rejectUnreachable?: boolean` pada `detectAndSave` (diaktifkan di `cli/wizard.ts` & `cli/provider-manager.ts` `onAdd`): error `unreachable:` (host tak terjangkau) ditolak jujur, sedangkan host terhubung dengan HTTP 404/500 pada `/models` tetap aman memakai `fallbackModels`. Hapus provider/model aktif selalu mereset `setModelOverride` (termasuk `""`). Perjelas pesan kosong `/provider` tanpa mengubah jumlah field form. |
| 3 | P1 UX | Modal progres jaringan (`/provider sync`, `/update`, setup `Detecting models…`) tidak bisa dibatalkan dengan `Esc` | `test/update-command.test.ts` menguji alur `createTuiUpdateHandler`; `test/wizard.test.ts` menguji retry/edit wizard | Teruskan `signal?: AbortSignal` ke `detectAndSave`, `refreshProviderModels`, `checkForUpdateFresh`, `runManualUpdate`, `withUpdate`, `CommandContext`, dan `wizard.onSubmit`. Pasang listener `Esc`/`Ctrl+C`/`Ctrl+D` sementara + tampilkan `escHint: true` di pojok kanan atas selama progres berjalan; lepas listener sebelum fase `install` `/update`. |
| 4 | P1 Core | Adapter `openai-compat` tidak membaca `request.system`; `router.ts` menyuntikkan system prompt sebagai `{ role: "user" }` | `test/context-audit.test.ts` sebelumnya mengunci workaround `{ role: "user" }`; `vendor/minicore/**` berstatus HOST-EDITABLE sejak v0.16.0 | Kirim `request.system` secara native sebagai `{ role: "system", content: request.system }` di `vendor/minicore/src/providers/openai-compat.ts` (+ dukungan defensif `role: "system"` di `toMessages`, serta penanda `kind: "openai-compat"`). `router.ts` melewati injeksi `user` untuk `openai-compat`, sambil mempertahankan pelindung untuk custom provider lama tanpa `kind`. Perbarui & perluas `test/context-audit.test.ts`. |
| 5 | P2 Portability/UX | Salin hanya via OSC-52 (sering gagal di terminal/Windows tertentu dan mentok 256 KB); `runForm` & `onResize` modal belum memproteksi layar `< 20×10`; backdrop statis saat terminal dilebarkan | `test/tui-copy-turn.test.ts`, `test/tui-lang.test.ts`, `test/pty.test.ts`, `test/output-window.test.ts` mengharapkan OSC-52 & batas `MAX_CLIPBOARD_BYTES` pada output window; `test/model-manager-flows.test.ts:685` menguji `resize(110, 5)` | Buat `src/lib/clipboard.ts` (di luar `src/ui/`, nol `stdout.write`) untuk native OS clipboard (`powershell Set-Clipboard`/`clip`, `pbcopy`, `wl-copy`/`xclip`/`xsel`) yang otomatis nonaktif di SSH, `MINICODE_CLIPBOARD=osc52`, dan `installFakeTty` (marker Symbol) agar test tidak menyentuh clipboard OS; `cli/tui.ts` mencoba native + OSC-52 fallback dan mengizinkan salinan lokal > 256 KB. Tambah guard `canRenderModal` pada `runForm` & `onResize` modal (`picker`, `provider-manager`, `output-window`, `wizard`, dan guard ekstrem `cols < 20 \|\| rows < 4` di `model-manager` agar test `110×5` tetap hijau). Re-center horizontal backdrop `paintDimmed` tanpa memutasi state `buildLayout`. |
| 6 | Maintenance | Ruang `gate:pack` (`5128 KB` / `5250 KiB`) cukup ketat (~122 KiB tersisa) | `scripts/pack-budget.ts` melarang menaikkan budget tanpa persetujuan pemilik | Jaga semua modul baru ringkas, hindari duplikasi utilitas, dan verifikasi `bun run gate:pack` tetap hijau di bawah `5250 KiB`. |

## Urutan Eksekusi (3 Gelombang)

### Wave A — Item #1 (Bracketed Paste) & Item #4 (Native System Role `openai-compat`)
1. `src/ui/tui/app.ts`: `setBracketedPaste(on, force = false)`, `suspend()` → `setBracketedPaste(false)`, `resume()` & `reacquireTerminal()` → `setBracketedPaste(true, true)`.
2. `src/ui/screens/picker.ts`: aktifkan/nonaktifkan `setBracketedPaste` secara simetris saat `isFilterable`.
3. `vendor/minicore/src/providers/openai-compat.ts`: native `{ role: "system" }` dari `request.system`, `kind: "openai-compat"`, dan dukungan `case "system"` di `toMessages`.
4. `src/providers/router.ts`: kecualikan `kind === "openai-compat"` dari `needsSystemMessage`.
5. Test: tambahkan regresi bracketed paste di `test/tui-app.test.ts`; perbarui & perluas `test/context-audit.test.ts`.

### Wave B — Item #2 (Provisioning/Lifecycle) & Item #3 (Cancelable Progress Modals)
1. `src/providers/provision.ts`: `signal?: AbortSignal` & `rejectUnreachable?: boolean` pada `detectAndSave`; `signal?: AbortSignal` pada `refreshProviderModels`.
2. `src/policy/update-check.ts`: `signal?: AbortSignal` + flag `aborted?: boolean` pada `checkForUpdateFresh` & `runManualUpdate`.
3. `cli/wizard.ts`, `cli/provider-manager.ts`, `cli/model-manager.ts`: aktifkan `rejectUnreachable: true` + `signal`, reset `setModelOverride` saat hapus provider/model aktif (termasuk `""`).
4. `src/ui/screens/wizard.ts`, `cli/commands.ts`, `cli/tui.ts`, `src/ui/i18n/{en,id}.ts`: tombol `Esc` (dengan `escHint: true`) membatalkan `Detecting models…`, `/provider sync`, dan `/update` (fase cek) secara bersih.
5. Test: tambahkan unit & flow test untuk `rejectUnreachable`, reset `activeModel` saat hapus provider/model terakhir, dan pembatalan `Esc` pada progres modal.

### Wave C — Item #5 (Native Clipboard, `canRenderModal` Resize Guards, Backdrop Resize) & Item #6 (`gate:pack`)
1. `src/lib/clipboard.ts` + marker Symbol di `test/helpers/tui-harness.ts` + wiring di `cli/tui.ts` + unit test `test/clipboard.test.ts`.
2. `src/ui/screens/{form,picker,provider-manager,output-window,wizard,model-manager}.ts`: guard `canRenderModal` pada `form` & `onResize` (tampilkan `msg.tooSmall` dan blokir aksi konfirmasi buta, pulih otomatis saat diperbesar).
3. `src/ui/tui/app.ts`: penyesuaian padding horizontal backdrop `paintDimmed` saat resize lebar tanpa efek samping ke `scrollBack`/`selection`.
4. Verifikasi akhir: `bun x tsc --noEmit`, `bun run lint`, `bun run gate:pack`, dan suite `bun test` terarah untuk seluruh modul terdampak.
