# Audit kode working tree (pasca-0.43.3) — 2026-11-24

- **HEAD:** `2c7649c` (`release: 0.43.3`)
- **Status tree:** belum di-commit (58 file termodifikasi, +3922 / -847 baris; 5 file sumber/test baru + 4 artefak `.audit/`).
- **Sifat audit:** read-only atas kode, dokumen, dan test; tidak ada file sumber/test yang diubah. Gate penuh (`gate:fast`) **tidak** dijalankan sesuai `AGENTS.md`.
- **Verifikasi lokal yang dijalankan (terarah):**
  - `bun x tsc --noEmit` → **exit 0** (bersih).
  - `bun test test/ui-boundary.test.ts` → **5 pass / 0 fail**.
  - Test baru Stream A (`audit-fix-hang-and-harness`, `audit-fix-subagent-provider-transient`, `compaction-fidelity`) → **hijau** (seluruh kasus lulus).
  - `test/acp.test.ts` → **1 fail** (`:257`).
  - `test/composer-box-and-paste.test.ts` → **2 fail** (`:160`, `:513`).
  - 14 file test UI/error terkait (`composer-wrap`, `tui-app`, `tui-transcript`, `chat-column`, `audit-fix-clean-composer`, `audit-fix-live-inline-status`, `activity-fold`, `activity-panel`, `tui-lang`, `cli-command-audit-regressions`, `work-mode-runtime`, `tui-scroll-width`, `errors-usage`, `markdown-table`) → **268 pass / 48 fail** (37 fail murni drift/regresi kode+test; 11 fail tambahan karena `supportsUtf8() === false` di pipe non-TTY Windows).
- **Batasan klaim:** laporan ini **tidak** menyatakan repo hijau atau siap rilis. Hanya ruang lingkup di atas yang diverifikasi.

## Ruang lingkup

- **Stream A (runtime, policy, kompaksi, tool):** `vendor/minicore/src/core/executor.ts`, `cli/setup.ts`, `src/app/tool-layer.ts`, `src/constants.ts`, `src/runtime/execution-backend.ts`, `src/presentation/{adapter,events}.ts`, `src/session/context-projection.ts`, `src/policy/{compaction,compaction-validate,consequence-engine,context,executor,tool-contract}.ts`, `src/tools/{bash,edit,git,grep,read_file,task,todo}.ts`.
- **Stream B (UI, composer, error, kontrak):** `src/ui/render/{composer-wrap,errors,markdown-layout,theme}.ts`, `src/ui/input/prompt-engine.ts`, `src/ui/tui/{app,transcript}.ts`, `src/ui/assistant/simple.ts`, `src/ui/i18n/{en,id}.ts`, `docs/TERMINAL_CONTRACT.md`.

---

## P1 — `formatError()` / `friendlyError()` menelan pesan error pada protokol mesin (ACP & CLI non-TUI)

**Bukti:** `src/ui/render/errors.ts:379-395` (`friendlyError`) dan cabang `default` `friendlyFromCategory()` (`:211`) kini mengganti pesan error tak-terklasifikasi menjadi narasi generik:
`"An unexpected problem occurred\n  → Try again, or run with --verbose to see technical details."`

**Skenario & bukti gagal:** `cli/commands/acp.ts:531` meneruskan hasil `formatError(e)` ke payload JSON-RPC `error.message`. Hasil `bun test test/acp.test.ts`:
- `test/acp.test.ts:257` **GAGAL** — expected to contain `"model meledak"`, received narasi generik di atas (lengkap dengan saran flag manusia `--verbose` yang tidak bermakna bagi klien ACP).
- Pemanggil non-TUI lain (`cli/index.ts:705`, `cli/commands/exec.ts:380`, `cli/commands.ts:641,693,749,788`) juga kehilangan pesan error konkret saat teks tidak cocok kata kunci `classifyGenericError()`.

**Rekomendasi:** Perlu keputusan owner — kecualikan jalur mesin (ACP / `--json`) dari fallback generik (tetap redaksi secret + sanitasi ANSI, tanpa menyembunyikan pesan error konkret), atau pisahkan formatter khusus TUI vs mesin.

---

## P1 — Suite test UI merah (termasuk 2 test di file baru `composer-box-and-paste.test.ts`)

**Bukti:**
- `test/composer-box-and-paste.test.ts:160`: komentar menulis `47+6=53 > 50 tetap wrap`, tetapi assertion tetap mengharapkan `"terpot"` tertarik kembali ke baris 0 (salah hitung lebar setelah margin kanan simetris 3 mempersempit `innerW` dari 53 ke 50).
- `test/composer-box-and-paste.test.ts:508-513`: drag `"satu\ndua"` memakai `x=9` (interior 3 = `'u'`, bukan `'t'` di interior 2 / `x=8`), sehingga hasil salin adalah `"u\ndua"` padahal test mengharapkan `"tu\ndu"`.
- 37 kegagalan di 6 file UI (`tui-app.test.ts`: 29, `cli-command-audit-regressions.test.ts`: 3, `tui-lang.test.ts`: 2, `tui-scroll-width.test.ts`: 1, `work-mode-runtime.test.ts`: 1, `markdown-table.test.ts`: 1). Mayoritas disebabkan perubahan desain composer (garis tunggal `───` → kotak `╭─╮│╰╯`, margin kanan 3 → `contentCols = chatCols - 6`, dan guard popup lama `!f.some(l => l.includes("│"))` yang kini selalu gagal karena bingkai composer memakai `│`).

**Rekomendasi:** Perbaiki 2 bug hitungan di `composer-box-and-paste.test.ts` dan selaraskan assertion test UI setelah owner mengonfirmasi bentuk akhir UI composer & kebijakan error ACP.

---

## P1 — `errors.ts` mengganti `t()` menjadi `tSystem()` sehingga `/lang` diabaikan pada pesan error UI

**Bukti:** `src/ui/render/errors.ts:148-395` mengganti seluruh `t("err.*")` menjadi `tSystem("err.*")`.

**Dampak:** Pengguna yang mengubah bahasa sesi lewat `/lang id` atau `/lang en` tetap menerima semua error UI dalam bahasa OS. Ini bergeser dari kontrak `docs/TERMINAL_CONTRACT.md` (v0.35: `tSystem()` hanya untuk label tool/ledger, sedangkan narasi/pesan UI mengikuti `/lang`).

**Rekomendasi:** Konfirmasi ke owner apakah pesan error memang sengaja diikat ke locale OS, atau kembalikan `friendlyFromCategory`/`friendlyError` ke `t()` dan pertahankan `tSystem()` hanya di `friendlyToolError*`.

---

## P2 — `validateCompactionSummary` false-reject pada prefix pendek (XML > input), file terhapus, dan path Windows `\`

**Bukti:**
1. `src/policy/compaction-validate.ts:67-69`: `if (normalized.length >= prefixText.length)` menolak ringkasan. Sementara prompt baru (`src/policy/compaction.ts:1036-1045`) mewajibkan 8 tag XML (`<goal>`…`<open>`) + `"unknown"` (~220+ char boilerplate). Untuk prefix pendek (<~300 char), ringkasan LLM yang patuh akan lebih panjang daripada `prefixText` → ditolak deterministik (`InvalidCompactionSummaryError`) lalu dipaksa fallback mekanikal.
2. `src/policy/compaction-validate.ts:81-85`: path yang dihapus (`status=deleted`, diminta eksplisit di prompt `<files>`) atau path Windows `src\tools\bash.ts` di `prefixText` yang dinormalisasi LLM jadi `src/tools/bash.ts` gagal di `prefixText.includes(path)` dan gagal di `existsSync()` (saat file sudah dihapus atau `cwd` kosong) → ditolak sebagai `hallucinated-path`.
3. `src/policy/compaction-validate.ts:45`: regex `/\b[0-9a-f]{6,40}\b/gi` menangkap kata Inggris biasa berhuruf `a-f` (`decode`, `decade`, `facade`, `accede`, `defaced`, `bedded`, `beaded`) → memicu flag `needs-verification` palsu (soft).

**Rekomendasi:** Longgarkan cek panjang untuk prefix sangat pendek (atau ukur tanpa tag XML boilerplate), normalisasi `\` → `/` saat mencocokkan `prefixText` untuk path, dan wajibkan minimal satu digit `[0-9]` pada pola hash hex.

---

## P2 — Bracketed paste lintas-chunk / overflow menghasilkan placeholder ganda

**Bukti:** `src/ui/tui/app.ts:159-170` hanya menggabungkan (`coalesce`) item `pasted: true` di dalam satu panggilan `handleKeys(keys)`. Pada `src/ui/input/prompt-engine.ts:635-735`, mode `pasteOverflow` (> `MAX_PASTE_BYTES`) memancarkan event `{ type: "char", pasted: true }` di beberapa chunk stdin terpisah.

**Dampak:** Satu paste besar menciptakan beberapa placeholder terpisah (`{paste text N lines}` + `{paste text M lines #2}`) di composer. Selain itu, di `src/ui/tui/app.ts:284-325`, saat `pasted === true` namun `shouldCollapsePaste(cleaned)` bernilai `false` (paste 1 baris pendek), kontrol jatuh ke `this.applyEngine(key)` dengan `key.ch` mentah alih-alih `cleaned` (melewati normalisasi `\u2028/\u2029` dan byte C1).

**Rekomendasi:** Tandai batas `pasteStart`/`pasteEnd` (atau akumulasi buffer paste lintas-chunk di `TuiApp` hingga terminator `ESC[201~`), dan teruskan `{ type: "char", ch: cleaned }` pada cabang paste pendek.

---

## P2 — Tabel markdown di TUI kehilangan 3 kolom lebar ekstra & strip `^ {3}` rapuh di layar sempit

**Bukti:** `src/ui/tui/transcript.ts:1357-1363` memanggil `renderMarkdownTable(table, Math.max(1, width), renderInline)` dengan `width = contentCols = chatCols - 6`, lalu membuang margin lewat `.replace(/^ {3}/, "")`.

**Dampak:** `renderGridTable()` (`src/ui/render/table-grid.ts:319-321`) masih mengurangi `budget` sebesar `effectiveAssistantMargin(width)` sehingga tabel di TUI kehilangan 3 kolom ganda (total 9 kolom margin). Pada lebar sempit saat `effectiveAssistantMargin(width)` bernilai 1 atau 2 (bukan 3), `.replace(/^ {3}/, "")` gagal menghapus margin sehingga baris tabel bergeser.

**Rekomendasi:** Tambah opsi `outerMargin?: number` (default tetap `effectiveAssistantMargin(width)`) pada `renderMarkdownTable` / `renderGridTable`, dan kirim `outerMargin: 0` dari `Transcript.projectTable`.

---

## P2 — `WORKSPACE_MUTATING_TOOLS` di `cli/setup.ts` daftar manual kedua (drift dari `TOOL_CONTRACTS`)

**Bukti:** `cli/setup.ts:1911-1917` membuat `Set(["edit", "write_file", "apply_patch", "delete_file", "move_file"])` secara manual. Di `src/policy/tool-contract.ts:196-206`, `WRITE_TOOLS` juga mencakup `git_restore`, `git_checkout`, dan `lsp_rename`.

**Dampak:** Mutasi workspace melalui `git_restore`, `git_checkout`, atau `lsp_rename` tidak menaikkan `workspaceMutationEpoch`, sehingga verifikasi ulang `bash` identik dalam turn yang sama tetap ditolak idempotency.

**Rekomendasi:** Pakai `WRITE_TOOLS` langsung dari `src/policy/tool-contract.ts` sebagai satu sumber kebenaran.

---

## P2 — `detectWindowsCmdQuotingHazard` salah membaca `\"` di dalam kutip ganda `cmd.exe`

**Bukti:** `src/tools/bash.ts:36-42` menghitung backslash sebelum `"` untuk mengabaikan `\"` di dalam `"..."`. Di `cmd.exe`, backslash bukan escape untuk kutip ganda — path Windows berujung backslash seperti `dir "C:\foo\" && awk 'a>b'` benar-benar menutup kutip ganda pada `"` kedua, namun scanner tetap mengira `inDoubleQuote = true` dan melewatkan bahaya `'a>b'` di belakangnya.

**Rekomendasi:** Pertimbangkan perlakuan khusus atau catat batasannya (karena `bun -e "write(\"x\")"` memang melewati arg parser runtime di dalam kutip ganda, perlu keseimbangan antara false-positive runtime quote vs false-negative trailing backslash).

---

## P3 — Kontradiksi dokumen & bookkeeping minor

1. **`docs/TERMINAL_CONTRACT.md:38-65`**: baris `46` masih menulis `Lebar isi = chatCols - 3` dan baris `48-50` menulis prefix `minicode ›` tanpa spasi trailing, tepat di atas amendemen baris `54-62` yang menetapkan `chatCols - 6` dan tanpa prefix di composer. Baris `38` dan `64` juga masih menyebut `13 pola` (kode `src/ui/render/errors.ts:436` kini `21 pola`).
2. **`AGENTS.md`**: masih mencatat `HEAD 42a35a6` dan kandidat `0.43.2`, padahal HEAD sekarang `2c7649c` (`0.43.3`).
3. **`src/ui/tui/transcript.ts:2632,3127`**: saat retry sukses menimpa baris ledger gagal via `replaceEntry()`, teks/warna berubah menjadi sukses tetapi `meta.status` pada baris tersebut tetap `"failed"`.
4. **`src/ui/tui/app.ts:461-464`**: `composerBoxWidth()` berlantai `Math.max(6, ...)`; jika pernah dipanggil di bawah `contentCols < 6` (`cols < 12`, di bawah `MIN_COLS = 20`), sisi kanan bingkai terpotong oleh `truncateToWidth(..., contentCols)`.

---

## Area yang bersih pada audit ini

- **Typecheck & batas lapisan:** `tsc --noEmit` bersih; `test/ui-boundary.test.ts` hijau (5/5).
- **Anti-hang bash/git/backend:** `stdio: ["ignore", "pipe", "pipe"]` konsisten di foreground `bash.ts`, background `startBackground`, `git.ts`, dan `execution-backend.ts`; watchdog idle + `settleTimer` mencegah promise menggantung.
- **Sub-agent transient + ACE retry cap:** klasifikasi `401`/`429`, cooldown 60 dtk, dan `SUB_AGENT_MAX_ATTEMPTS = 4` + `ACE_REPEATED_FAILURE_LIMIT = 5` terhubung rapi dan seluruh testnya hijau.
- **Grep single-file & `contextLines`:** pengecekan `isPathOutsideRoot` + `isRealPathOutsideRoot` + `isSensitive` (termasuk target symlink via `realpath`) dan `redosGuardMessage` lengkap.
- **Hidden built-in tool message:** seam aditif di `vendor/minicore/src/core/executor.ts` tidak melebarkan izin dan menjaga `INV-WM1`; `mcp_call` bertitik dikecualikan eksplisit.
