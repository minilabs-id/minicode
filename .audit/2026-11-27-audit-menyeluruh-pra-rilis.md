# Audit Menyeluruh Pra-Rilis Minicode (v0.52.1 Working Tree)

**Tanggal:** 2026-11-27
**Mode Audit:** Read-only (3 putaran berulang: per-modul → lintas-lapisan & celah → verifikasi verbatim & eliminasi false positive, tanpa modifikasi kode repo)
**Target:** Seluruh bagian Minicode + working tree kotor pra-rilis `v0.52.1` (40 entri `git status --short`)

---

## 1. Ringkasan Eksekutif & Putusan Pra-Rilis

- **Putusan Pra-Rilis:** **TAHAN RILIS (`HOLD`)** sebelum temuan `HIGH` di bawah diperbaiki.
- **Pemeriksaan Read-Only yang Dijalankan pada Working Tree Kini:**
  - `bun x tsc --noEmit`: lulus (`exit 0`, 0 galat tipe).
  - `npm pack --dry-run --json`: `343` berkas, ukuran unpacked **5210 KiB** terhadap budget ketat `< 5250 KiB` di `scripts/pack-budget.ts:188,201` (**headroom tersisa hanya 40 KiB**).
  - Pemeriksaan tautan Markdown pada `README.md` + 30 berkas di `docs/`: 0 tautan `.md` rusak.
  - Pencarian `.skip(` di `test/*.ts`: 7 skip kondisional vendor-freeze (`test/import-convention.test.ts:154,169`, `test/pack-integrity.test.ts:78,121`, `test/phase6ae-vendor-eol.test.ts:243,282,294`); `test.skipIf` lain bersifat kondisional platform/lingkungan.
  - Full gate (`bun run gate:fast`) **tidak dijalankan** sesuai aturan `AGENTS.md` (menunggu aba-aba pemilik).

**Distribusi Temuan Terverifikasi (24 bagian terkelompok):**
- **HIGH (11):** Regresi worktree kotor `agentWaves` (`UI-01`), paste/path `/` & parser command (`UI-02`), fuzz `bash-guard` menguji `command` vs `cmd` (`SEC-02`), kebocoran kredensial vector & local-config (`SEC-01`), eskalasi ganda context window & ledger reset (`CORE-01`), `pricing sync` gagal deterministik (`PROV-01`), kehilangan `extra_content` & EOF prematur di `openai-compat` (`PROV-02`), SSE `error` & string kosong di `anthropic` (`PROV-03`), `response.incomplete` & paralel tool call di `responses` (`PROV-04`), SQLite reader tanpa `busy_timeout`/readonly & transaksi DEFERRED (`STOR-01`), serta headroom paket 40 KiB & celah workflow/coverage/eval/docs (`GATE-01`).
- **MEDIUM-HIGH (2):** Masking `.env*` terhenti depth 3/500 dir & bypass `cd`/subshell (`SEC-03`), serta `move_file` di jurnal & rollback undo non-strict (`STOR-02`).
- **MEDIUM (11):** `inferScope` & komentar `subagent-budget.ts` (`BUDG-01`), scrub setelah pemotongan di trace/approvals (`SEC-04`), lone surrogate & hilangnya `budgetTailPrefix` (`CORE-02`), `sse-bounds` EOF newline (`PROV-05`), `effort` prefix model & `provision`/`detect` metadata (`PROV-06`), konflik tombol `i` modal persetujuan ID (`UX-01`), input/composer/markdown/ANSI (`UI-03`), argumen respawn & orphan keystore di CLI (`CLI-01`), validasi `git`/`ask_user` (`CLI-02`), MCP pins/SSE/shutdown (`INT-01`), serta LSP uncaught frame crash & sync `taskkill` (`INT-02`).

---

## 2. Temuan Baru pada Working Tree Kotor (`v0.52.1`)

Perubahan lokal sebelum rilis yang sudah ada di working tree memunculkan tiga masalah nyata yang perlu segera dirapikan sebelum gate/rilis:

### UI-01 [HIGH] — Bug Akuntansi Baris `✦` Gelombang Sub-Agent (`agentWaves`)
- **Lokasi:**
  - `src/ui/tui/transcript.ts:2766-2768` (`finalizeActivity` memanggil `settleDelegateRoot`)
  - `src/ui/tui/transcript.ts:2984-3002` (`startDelegateWave`, `settleDelegateRoot`)
  - `src/ui/tui/transcript.ts:3008-3048` (`aggregateAgent`)
- **Kelemahan:**
  1. Ketika `delegate_task` gagal atau dibatalkan sebelum tool anak apa pun sempat berjalan, `startDelegateWave` menyisipkan `"pending:${toolCallId}"` ke `wave.agents` (`L2989`), lalu `finalizeActivity` hanya memanggil `settleDelegateRoot(toolId)` (`L2767`) dan mencetak baris kegagalan terpisah — **tanpa menghapus** token `"pending:${toolId}"` dan **tanpa menaikkan** `wave.failures`. Baris agregat di atasnya tetap tercetak `✦ 1 sub agent · 0 tool · 0 failed` walau delegasi tersebut gagal.
  2. Di `aggregateAgent`, `wave.tools` memakai `Set` terdeduplikasi per `toolCallId` (`L3018`), tetapi `wave.failures` di-increment mentah setiap kali `status !== "completed"` (`L3024`) tanpa cek duplikasi `toolId`, dan cabang `supersedes` (`L3026-3034`) hanya mengurangi kegagalan lama bila attempt baru berstatus `"completed"`. Event terminal ganda atau retry yang gagal lagi akan menghitung ganda jumlah `failed`.
  3. Pengecekan `!wave.agents.has(toolCallId)` di `L2988` selalu bernilai `true` karena `wave.agents` menyimpan `childSessionId ?? runId` atau `"pending:${toolCallId}"`, bukan `toolCallId` telanjang.
- **Rekomendasi Perbaikan:**
  - Simpan status kegagalan per tool dalam struktur terdeduplikasi (mis. `Map<string, AgentFailureReason>`) lalu hitung ringkasan `failures` dari nilai unik di map tersebut; tangani `supersedes` untuk semua status terminal (termasuk saat retry tetap gagal).
  - Di `settleDelegateRoot` (atau saat `delegate_task` selesai dengan status non-`completed`), bersihkan `pending:${toolId}` jika belum terisi anak nyata dan refleksikan kegagalan root apabila `wave.tools.size === 0` / anak gagal sejak awal.

### UI-02 [HIGH] — Paste Multi-Baris atau Path Unix Berawalan `/` Disalahartikan Sebagai Slash Command + Inkonsistensi `submit` vs `enqueue`
- **Lokasi:**
  - `src/ui/tui/app.ts:1679` (`if (!expandedLine.startsWith("/"))`)
  - `cli/tui.ts:1920-1927` (`submit`)
  - `cli/tui.ts:2390-2391` (`enqueue`)
- **Kelemahan:**
  1. Setelah placeholder `{paste ...}` diekspansi ke `expandedLine` (`app.ts:1641`), pengecekan hanya menguji `startsWith("/")`. Jika pengguna menempelkan path absolut Unix (mis. `/etc/hosts` atau `/Users/...`) atau prompt multi-baris yang baris pertamanya diawali `/...`, seluruh prompt dianggap slash command: **tidak ditulis** ke transkrip pengguna (`app.ts:1679` terlewati) dan gagal sebagai command tak dikenal (`cli/tui.ts:2410`).
  2. `submit()` mengekstrak nama command dengan `line.indexOf(" ")` (`cli/tui.ts:1925`), sedangkan `enqueue()` memakai `line.split(/\s+/)[0]` (`cli/tui.ts:2391`). Input seperti `/help\nlanjutan` (newline langsung tanpa spasi) ditafsirkan sebagai nama command `"help\nlanjutan"` di `submit` tetapi `"help"` di `enqueue`.
- **Rekomendasi Perbaikan:**
  - Perlakukan `/` sebagai prefix slash command **hanya jika** input awal (atau token pertama sebelum ekspansi paste) memang berformat command satu baris tanpa newline (dan jangan anggap teks hasil ekspansi `{paste ...}` sebagai slash command).
  - Satukan parsing nama command di `submit` dan `enqueue` lewat satu helper yang memisahkan whitespace (`/\s+/`).

### SEC-02 [HIGH] — Fuzzy Test `bash-guard` Menggunakan Nama Properti Salah (`command` vs `cmd`)
- **Lokasi:**
  - `test/bash-guard-fast-fuzz.test.ts:70` (`args: { command: pattern }`)
  - `src/policy/permission.ts:1227,1267,1451` (`(args?.cmd as string) ?? ""`)
- **Kelemahan:**
  - Fuzz test yang ditambahkan di working tree mengirim `{ command: pattern }`, padahal seluruh handler permission `bash` (`allowlist`, `ask`, `allow-all`) membaca `args.cmd`. Akibatnya `permission.ts` selalu mengevaluasi string kosong `""`, menolaknya dengan `no matching pattern`, dan `expect(rejected).toBeGreaterThan(0)` (`L89`) lulus semu tanpa pernah menguji satu pun pola bypass (`type .e^nv`, `ln -s`, `X=.env; cat $X`, dsb.).
- **Rekomendasi Perbaikan:**
  - Ubah properti uji di `test/bash-guard-fast-fuzz.test.ts:70` ke `args: { cmd: pattern }` dan tambahkan kontrol positif (`ls`) serta asersi per kategori agar regresi nyata langsung gagal.

### BUDG-01 [MEDIUM] — Scope Sub-Agent `inferScope` & Komentar Usang di `subagent-budget.ts`
- **Lokasi:** `src/policy/subagent-budget.ts:5-6,33-46`
- **Kelemahan:**
  - Prompt yang menyebut ekstensi berkas (`.ts`, `.md`, dll.) langsung diklasifikasikan `"file"` (`24` langkah) kecuali memuat pola ketat `whole/entire/seluruh` + `repo/project/proyek/codebase` (`L36`). Permintaan seperti `"audit seluruh bagian Minicode"` tidak cocok regex `L36` sehingga jatuh ke `"dir"` (`40` langkah).
  - Komentar di `L5-6` masih menyebut nilai fallback lama `(5)` meskipun batas terbaru memakai `24/40/64/100`.
- **Rekomendasi Perbaikan:**
  - Perluas heuristik `inferScope` (mis. mengenali `"menyeluruh"`, `"seluruh bagian"`, atau nama repo tanpa mengharuskan kata literal `"repo"`/`"project"`) dan perbarui komentar agar akurat.

---

## 3. Temuan Keamanan & Isolasi

### SEC-01 [HIGH] — Bocornya Kredensial OS Keystore Lintas-Origin & Downgrade TLS pada Vector Embeddings
- **Lokasi:**
  - `src/app/rag-layer.ts:62-77`
  - `src/memory/vector.ts:461-502`
- **Kelemahan:**
  - `rag-layer.ts` me-resolve `apiKey.startsWith("keystore:")` lewat `getSecret(...)` untuk semua kandidat provider tanpa mengecek apakah kandidat berasal dari local config repo yang tidak tepercaya.
  - Di `vector.ts:461-502`, loop redirect `fetchEmbeddingsOnce` (maks 2 hop) hanya memeriksa `!isPrivateHostWithDns` dan protokol `http:/https:`, lalu **meneruskan `headers` yang sama persis** (memuat `Authorization: Bearer ...` dan `x-api-key`) ke `Location` redirect baru — rentan mencuri token keystore ke origin eksternal lain atau melalui downgrade `https:` ke `http:`.
- **Rekomendasi Perbaikan:**
  - Blokir resolusi `keystore:` dari kandidat berisiko (`isLocalConfigProvider(c)`), dan pada `fetchEmbeddingsOnce` tolak redirect untuk request ber-kredensial (atau strip `Authorization`/`x-api-key` saat origin atau skema berubah dan tolak downgrade HTTPS→HTTP).

### SEC-03 [MEDIUM-HIGH] — Masking `.env*` Terhenti di Depth 3 / 500 Direktori & Celah Segmentasi `cd`/Subshell
- **Lokasi:**
  - `src/sandbox/mask.ts:28-29,92` (`MAX_SCAN_DIRS = 500`, `MAX_SCAN_DEPTH = 3`)
  - `src/policy/permission.ts:678-689` (`if (/^cd\b/i.test(seg))`)
  - `src/policy/sandbox-policy.ts:84-90` (mode `--sandbox` tak dikenal mengembalikan `{ mode: "none", explicit: false }`)
- **Kelemahan:**
  - Di monorepo dengan struktur dalam (`depth >= 4`, mis. `apps/web/packages/api/.env`) atau lebih dari 500 direktori, `discoverSandboxMaskTargets` berhenti memindai sehingga `.env` sensitif **tidak dimasking** pada OS sandbox (`bwrap`/Seatbelt) maupun Docker sandbox.
  - Pada allowlist bash (`permission.ts:678`), pemeriksaan target `cd` hanya menargetkan segmen yang diawali `/^cd\b/i`. Subshell berawalan kurung `(cd /etc` atau perintah navigasi lain seperti `pushd`/`popd` tidak tertangkap oleh regex awalan tersebut.
  - Flag `--sandbox <typo>` yang tidak dikenali hanya menghasilkan notice dan jatuh ke `mode: "none", explicit: false`, bukan gagal tegas (fail-closed).
- **Rekomendasi Perbaikan:**
  - Perluas batas scan `mask.ts` (atau pindai `.env*` lebih dalam dengan pruning `SKIP_DIRS`), tolak `pushd`/`popd` dan awalan `(` pada segmen allowlist di `permission.ts`, serta jadikan nilai `--sandbox` tak dikenal fail-closed saat parsing opsi.

### SEC-04 [MEDIUM] — Pemotongan Teks Sebelum `scrubSecrets` & Balapan Lock di Trace
- **Lokasi:**
  - `src/telemetry/trace.ts:254` (`scrubSecrets(trace.prompt.slice(0, 2000))`)
  - `src/daemon/approvals.ts:395,410` (`scrubSecrets(summarizeArgs(args))` setelah `sanitizeLabel(text, 300)`)
- **Kelemahan:**
  - Memotong teks ke 2000/300 char **sebelum** menjalankan `scrubSecrets` berisiko membelah pola rahasia tepat di batas potong sehingga awalan kunci rahasia lolos dari sensor ke log trace maupun summary persetujuan daemon.
  - Pada `trace.ts`, operasi `appendFile` dan `purgeSessionTraces` berjalan di luar `rotationLocks`.
- **Rekomendasi Perbaikan:**
  - Terapkan `scrubSecrets(...)` lebih dulu sebelum `.slice(...)` / `sanitizeLabel(..., limit)`, dan bungkus append/purge trace dalam lock rotasi yang sama.

---

## 4. Temuan Core Runtime, Provider & Loop

### CORE-01 [HIGH] — Eskalasi Ganda Context Window Saat Client Overflow & Reset Episode Recovery Terlewat
- **Lokasi:**
  - `src/app/session.ts:905-909,981-1015,1125,1148,1212,1226`
  - `src/app/session.ts:1348-1352` + `vendor/minicore/src/core/loop.ts:288-317,325-341`
- **Kelemahan:**
  1. Ketika batas token prakirawan terlampaui di sisi klien (`session.ts:1148` atau `L1212`), fungsi `overflow(..., clientGuard=true)` memanggil `escalateContextWindow` pada `L1125` (`contextWindowForModel` membaca `escalatedWindows` yang baru dinaikkan), lalu melempar error ke blok `catch` di `L1220` yang memanggil `escalateContextWindow` **untuk kedua kalinya** pada `L1226`. Satu kejadian overflow dapat melompati **2 tangga jendela konteks** dan memancarkan dua event eskalasi.
  2. `activeRecoveryLedger?.resetEpisode()` hanya terpasang di event `step:completed` (`session.ts:1348`), sedangkan `loop.ts` tidak memancarkan `step:completed` saat retry/compaction di tengah percobaan stream (`L288-317`) maupun pada turn murni teks (`toolCalls.length === 0` langsung `break` di `L340`).
- **Rekomendasi Perbaikan:**
  - Jangan panggil `escalateContextWindow` dua kali untuk `clientOverflowErr` (lewatkan eskalasi di `catch` bila `error === clientOverflowErr` karena `overflow()` sudah menanganinya, atau pindahkan seluruh keputusan clamp/eskalasi ke satu titik).
  - Reset `activeRecoveryLedger` di `turn:completed` (atau di akhir respons non-tool).

### CORE-02 [MEDIUM] — Pemotongan UTF-16 Surrogate & Kehilangan `budgetTailPrefix` Saat `microcompact`
- **Lokasi:**
  - `vendor/minicore/src/core/executor.ts:151-161` (`serializeContent`)
  - `cli/setup.ts:3736-3754` (`persistCurrentImpl`)
- **Kelemahan:**
  - `executor.ts:154-158` memotong `text.slice(0, headLen)` dan `text.slice(-tailLen)` tanpa mengecek pasangan surrogate UTF-16, yang dapat meninggalkan lone surrogate di hasil tool (ditolak serializer JSON ketat di sebagian gateway LLM). Pengurangan `- 12` pada `tailLen` (`L156`) juga lebih kecil dari panjang teks notice pemotongan itu sendiri (~140 char), sehingga hasil akhir melewati `maxChars`.
  - Di `cli/setup.ts:3738-3745`, pengecekan `hasBudgetPrefixIntact` menguji kesamaan persis seluruh `budgetTailInitialMessages`. Jika `microcompact` menyingkat satu hasil tool lama di dalam prefix tersebut, `hasBudgetPrefixIntact` menjadi `false`, `budgetTailPrefix` dibuang, dan `shrinkThreadHistory` dapat menghapus riwayat pesan lama dari basis data saat persist.
- **Rekomendasi Perbaikan:**
  - Tambahkan penyesuaian batas surrogate UTF-16 pada pemotongan di `executor.ts` dan kurangi `tailLen` dengan panjang aktual pesan notice.
  - Bedakan antara mutasi isi tool oleh `microcompact` vs penghapusan pesan saat menjaga `budgetTailPrefix` di `cli/setup.ts`.

### PROV-01 [HIGH] — `minicode pricing sync` Gagal Deterministik Terhadap Payload Asli `models.dev`
- **Lokasi:**
  - `src/policy/pricing.ts:302-315` (dan `L109` untuk `JSON.parse` tanpa strip BOM)
  - `src/constants.ts:317` (`WEB_FETCH_BODY_HARD_CAP_CHARS: 2_000_000`)
- **Kelemahan:**
  - `pricing.ts:302` mengakui payload asli `models.dev/api.json` berukuran ~4.4 MB, namun memanggil `await res.text()` seluruhnya terlebih dahulu lalu memotongnya ke `2_000_000` karakter (`L305-307`) sebelum `JSON.parse(text)` (`L312`). JSON 4.4 MB yang dipotong di char 2.000.000 **selalu invalid**, sehingga memicu galat `"models.dev membalas non-JSON"` pada payload nyata sekaligus gagal mencegah download penuh sebelum pemotongan.
- **Rekomendasi Perbaikan:**
  - Baca response body secara streaming bertahap melalui `ReadableStream` dengan batas byte tersendiri yang cukup (mis. `PRICING_FETCH_MAX_BYTES = 10 * 1024 * 1024`) serta strip UTF-8 BOM pada baca cache disk (`L109`).

### PROV-02 [HIGH] — `openai-compat`: Kehilangan `extra_content` pada Retry `stream_options` & EOF Prematur Dianggap `"stop"`
- **Lokasi:** `vendor/minicore/src/providers/openai-compat.ts:88-92,100-141,180,291-295,498-516`
- **Kelemahan:**
  1. `buildBody(true)` memanggil `toMessages(request.messages, takeProviderMeta)` (`L101`). `takeProviderMeta` **menghapus** entri dari `providerMetaByCallId` saat dibaca (`L90`). Bila server membalas `400` untuk `stream_options.include_usage` lalu retry memanggil `buildBody(false)` (`L139`), seluruh metadata tool call (`extra_content` / thought signature) sudah hilang pada request kedua.
  2. Jika koneksi SSE putus di tengah stream tanpa `finish_reason` dan tanpa `[DONE]`, `finished` tetap `false`, dan `L291-295` mensintesis `{ type: "finish", reason: hasCalls ? "tool_calls" : "stop" }` sehingga output terpotong lolos sebagai selesai normal (melewati guard `completed === undefined` di `loop.ts:264`).
  3. `/quota/` dipetakan ke `"rate_limit"` (`L180`), dan parser `sse()` mengukur panjang `line.length` (UTF-16 char, bukan byte) tanpa batas total byte stream.
- **Rekomendasi Perbaikan:**
  - Konsumsi/hapus `providerMetaByCallId` hanya setelah stream berhasil dimulai (`response.ok`), atau pakai mode `peek` saat menyusun body; hanya anggap selesai `"stop"` bila `[DONE]` eksplisit diterima dan lempar `ProviderError("network", ...)` bila EOF terjadi mendadak tanpa penutup/finish_reason.

### PROV-03 [HIGH] — `anthropic`: Error SSE Mid-Stream Diabaikan & Empty String Kena Reject `400`
- **Lokasi:** `src/providers/anthropic.ts:124-127,188-299,336,440-446`
- **Kelemahan:**
  - Loop event SSE (`L188-299`) tidak menangani `evType === "error"`; error streaming dari Anthropic (mis. `overloaded_error`) terabaikan lalu stream selesai kosong.
  - Pada `messagesPayload` (`L124-127`) dan `toAnthropicMessages` (`L336`), konten string kosong `""` diubah menjadi `{ type: "text", text: "" }` (plus `cache_control` jika merupakan pesan stabil terakhir), yang ditolak API Anthropic dengan HTTP `400`.
  - `toAnthropicError` (`L441`) menghitung `Number(retryAfter) * 1000` sehingga gagal mem-parse header `Retry-After` berformat tanggal HTTP.
- **Rekomendasi Perbaikan:**
  - Tambahkan handler `evType === "error"` yang memetakan kode error Anthropic ke `ProviderError`, hindari menyisipkan blok teks kosong ke pesan/cache control, dan gunakan parser `Retry-After` bersama yang mendukung HTTP-date.

### PROV-04 [HIGH] — `responses`: `response.incomplete` Disamarkan Sebagai `"stop"` & Tool Call Paralel Tertukar
- **Lokasi:** `src/providers/responses.ts:287-296,395,413,445,480-488`
- **Kelemahan:**
  - `response.incomplete` digolongkan sebagai `isNonDeltaEvent` dan diabaikan (`L445`), kemudian loop berakhir dengan `if (!finished) yield { type: "finish", reason: "stop" }` (`L487`) alih-alih melaporkan `finish: "length"`/warning atau error.
  - Ketika stream putus sebelum `output_item.done`, sisa `pendingCalls` tetap di-flush (`L482-484`) dengan argumen yang berpotensi belum lengkap lalu ditandai `"stop"`.
  - Saat `item_id`/`item.id` absen pada delta/done, kode mengambil `[...pendingCalls.keys()].pop()` (`L395,413`), yang akan salah menempelkan argumen bila ada beberapa function call paralel; pesan `/quota_exceeded|insufficient_quota|balance/` juga dikategorikan `"unknown"` (`L288`).
- **Rekomendasi Perbaikan:**
  - Tangani `response.incomplete` dengan memetakan alasannya ke `"length"` (beserta warning) atau error jaringan yang dapat di-retry; tolak stream terpotong tanpa event terminasi valid dan pastikan lookup ID tool call konsisten.

### PROV-05 [MEDIUM] — `sse-bounds`: EOF Setelah Satu Newline Menolak Stream Valid
- **Lokasi:** `src/providers/sse-bounds.ts:62-64,91`
- **Kelemahan:**
  - Frame SSE hanya di-reset ke `frameBytes = 0` saat menemukan baris kosong (`lineBytes === 0` sebelum `\n` di `L91`). Bila server/proxy menutup koneksi tepat setelah `data: ...\n` tanpa `\n` penutup kedua, `lineBytes === 0` tetapi `frameBytes > 0`, sehingga `done` di `L62` melempar `ProviderError("network", "... incomplete SSE frame")`.
- **Rekomendasi Perbaikan:**
  - Saat `done` tercapai, tolak hanya bila ada baris tak utuh (`lineBytes !== 0`) — atau pastikan frame yang sudah dibatasi `\n` (terutama jika didahului event penutup) tidak memicu error EOF palsu.

### PROV-06 [MEDIUM] — `effort` & `provision` / `detect`: Prefix Model, Hilangnya Metadata saat Simpan, & BOM
- **Lokasi:**
  - `src/providers/effort.ts:27-28` (`thinkingFamily`)
  - `src/providers/provision.ts:97-98,227,345-357` & `src/providers/detect.ts:176-179`
- **Kelemahan:**
  - `thinkingFamily` gagal mengenali model dengan prefix gateway seperti `anthropic/claude-sonnet-4-6` atau `openai/gpt-5` karena menguji awal string (`^`, `startsWith`).
  - `saveProvider` (`provision.ts:227`) hanya mempertahankan `contextWindows` dari `previous`, menjatuhkan `contextWindowSources`, `maxOutputTokens`, `maxOutputTokensDefault`, dan `enablePromptCaching`; `setModelsMetadata` (`L345-357`) tidak menyalin `enablePromptCaching` ke config; `detect.ts:176` membuang model yang hanya membawa metadata `promptCaching`; `L97-98` dan `L345` tidak strip UTF-8 BOM saat parsing JSON config.
- **Rekomendasi Perbaikan:**
  - Normalisasi prefix sebelum slash terakhir (`id.split("/").pop()`) pada `thinkingFamily`, salin seluruh metadata model di `provision.ts` & `detect.ts`, dan strip `\uFEFF` sebelum `JSON.parse`.

---

## 5. Temuan Storage, Session, Task & Daemon

### STOR-01 [HIGH] — Reader Proyeksi SQLite Tanpa `busy_timeout`/`readonly` + Transaksi DEFERRED Read-Then-Write
- **Lokasi:**
  - `src/session/persistence.ts:1638-1764` (`readSessionMetaRows`, `readSessionInventoryRows`, `readAllPresentationEventsReadOnly`, `readRunRowsReadOnly`)
  - `src/task/store.ts:478,1675,1835-1848`, `src/tools/todo.ts:576`, `src/task/sync.ts:377,404`
  - `src/daemon/store.ts:53,267` (`writeConsumerOffset`, `transitionApproval`)
  - `cli/commands/sessions.ts:97-112` (`sessions purge`)
- **Kelemahan:**
  - Keempat helper read-only di `persistence.ts:1638-1764` membuka `new Database(p)` tanpa `{ readonly: true }` dan tanpa `PRAGMA busy_timeout`, lalu menangkap seluruh error menjadi hasil kosong (`[]` / `{ events: [], rejected: 0 }`) — saat checkpoint WAL atau proses tulis lain aktif, sesi dan event dapat hilang dari tampilan `/openwork` & inventory secara diam-diam.
  - Lima pemanggil `withTransaction` (`task/store.ts`, `tools/todo.ts`, `task/sync.ts`) dan dua transaksi di `daemon/store.ts` membaca baris lalu menulis dalam transaksi **DEFERRED** (tanpa `immediate = true` / `.immediate()`), menyebabkan SQLite langsung mengembalikan `SQLITE_BUSY` tanpa menunggu `busy_timeout`.
  - `cli/commands/sessions.ts:97-112` membuka DB langsung tanpa `busy_timeout` maupun migrasi, lalu menghapus berkas jurnal **sebelum** `purgeExpired(db)` selesai (`L109` vs `L112`).
- **Rekomendasi Perbaikan:**
  - Gunakan `{ readonly: true }` + `PRAGMA busy_timeout` pada semua reader (dengan retry singkat atau propagasi galat non-ENOENT), ubah semua transaksi read-then-write menjadi `BEGIN IMMEDIATE` (`.immediate()`), dan pindahkan `deleteJournalFile` ke *setelah* `purgeExpired(db)` berhasil.

### STOR-02 [MEDIUM-HIGH] — `move_file` Buta di Jurnal Mutasi, Non-Strict Rollback Undo & CAS Epoch Anak
- **Lokasi:**
  - `src/session/journal.ts:287-290` vs `src/tools/move_file.ts:13-29`
  - `src/session/checkpoint.ts:581-584,714-728` & `src/session/shadow-git.ts:475-490`
  - `src/tools/task.ts:941-943,950,1612-1644`
  - `src/session/persistence.ts:1429` & `src/session/verification.ts:1886`
- **Kelemahan:**
  - `journal.ts:288` masih membaca `a.from`/`a.to` padahal `moveFileTool` mengirim `a.path`/`a.destination`, sehingga hash target `move_file` tidak pernah direkam.
  - `undoFilesToTurn` via `applyCheckpoint` (`checkpoint.ts:582`) memanggil `restoreTree(cwd, tree)` tanpa `{ strict: true }`, dan di `shadow-git.ts:475` pemeriksaan `if (opts && skipped.length) throw` berjalan *sebelum* loop penghapusan `toDelete` (`L479-490`), sehingga gagal hapus berkas tidak pernah memicu rollback `restoreWorkspaceSafety`.
  - `task.ts` membaca ulang `readWriterEpoch(childId, parentCwd)` sesaat sebelum `transitionRun`/`completeRun`/`failRun` (`L942,L1612`), mengaburkan fungsi pagar CAS `expectedEpoch` yang seharusnya menggunakan epoch awal sesi anak.
  - `persistence.ts:1429` memanggil `JSON.parse(row.before_messages)` tanpa `try/catch`; `verification.ts:1886` memakai `JSON.parse` tanpa strip BOM.
- **Rekomendasi Perbaikan:**
  - Gunakan `a.path ?? a.from` & `a.destination ?? a.to` di `journal.ts`, pindahkan throw `skipped.length` ke akhir `restoreTree` di `shadow-git.ts` serta aktifkan `strict: true` di `applyCheckpoint`, simpan `expectedEpoch` anak saat akuisisi awal, dan lindungi `JSON.parse` baris DB dengan `try/catch`.

---

## 6. Temuan UI/TUI, Render, CLI & Integrasi (MCP / LSP)

### UX-01 [MEDIUM] — Konflik Hotkey Indonesia (`i` = "Izinkan" memicu "Tolak") pada Modal Persetujuan
- **Lokasi:** `src/ui/approval/prompt.ts:479-490` & `src/ui/i18n/id.ts:90-92`
- **Kelemahan:** Pilihan `deny` mengikat `keys: ["n", "i"]` (`L484`), padahal teks label ID adalah `"[y] Izinkan sekali"`. Pengguna berbahasa Indonesia yang menekan `i` ("Izinkan") tanpa sengaja mengeksekusi penolakan (`deny`).
- **Rekomendasi Perbaikan:** Hapus `"i"` dari `deny.keys` (`["n"]`, plus `"t"` yang sudah ada untuk `"tolak"`).

### UI-03 [MEDIUM] — Kekurangan Konsistensi Input, Composer Cache, Markdown & ANSI Pattern
- **Lokasi:**
  - `src/ui/input/input.ts:60-72` (`appendHistory`: write non-atomik, swallow error, mengabaikan `dirname(file)`)
  - `src/ui/tui/app.ts:2628-2635` (`incrementalComposerLayout`: melewati `appendWordWrapped` saat `pastedBlocks.size > 0`)
  - `src/ui/render/theme.ts:700` (`ANSI_PATTERN` tidak mengenali SGR bertanda `:` seperti `cells.ts:115-129`)
  - `src/ui/render/markdown.ts:24-45,164-170` (`***bold+italic***`, inline backtick ganda, warna reset `\x1b[39m` di dalam heading `c.bold(c.info(...))` / `c.thinking(c.bold(...))`)
- **Rekomendasi Perbaikan:** Gunakan penulisan atomik temp+rename + `dirname(file)` di `appendHistory`; matikan jalur inkremental `appendWordWrapped` saat `pastedBlocks.size > 0` atau pastikan placeholder aman; selaraskan `ANSI_PATTERN` dengan pola `:` di `cells.ts`.

### CLI-01 [MEDIUM] — Flag Hilang pada Auto-Update Respawn & Orphaning Keystore Secret di `config set-key`
- **Lokasi:**
  - `cli/commands.ts:382-397` (`buildResumeSpawnArgs` menjatuhkan `--work-mode`, `--model`, `--sandbox`, `--budget`)
  - `cli/commands/config.ts:354-372,382-393` (`set-key` menyimpan rahasia ke OS keystore di `L354` *sebelum* memvalidasi apakah provider target eksis di `L365-371`; `detect` membaca `--apiKey` dari CLI argv)
  - `cli/commands/acp.ts:351-359,580-603` (`flightActive` mengecek `aborter !== null` yang dihapus sinkron sebelum persist/cleanup turn selesai)
- **Rekomendasi Perbaikan:** Teruskan flag sesi penting di `buildResumeSpawnArgs`; validasi keberadaan provider sebelum memanggil `setSecret` di `config set-key`; dan track status `busy` penuh (termasuk fase cleanup/persist) di `acp.ts`.

### CLI-02 [MEDIUM] — Validasi Input Tool `git` & Pemotongan Surrogate `ask_user`
- **Lokasi:**
  - `src/tools/git.ts:264` (`Math.min(Math.max((limit as number) ?? 20, 1), 100)` membiarkan `NaN` atau float lolos)
  - `src/tools/ask_user.ts:67,133` (`.slice(0, 2000/4000)` tanpa penjagaan surrogate UTF-16)
- **Rekomendasi Perbaikan:** Normalisasi `limit` via `Number.isFinite` + `Math.trunc` dengan fallback `20`, dan gunakan helper pemotong aman batas surrogate.

### INT-01 [MEDIUM] — MCP Client (`pins` Race / Error Scrub), HTTP SSE Join / Char Cap & Server Shutdown
- **Lokasi:**
  - `src/mcp/client.ts:154,172-191,653-656` (baca pin tanpa strip BOM; `persist()` menimpa seluruh berkas tanpa merge konkurensi; pesan error `result.isError` tidak diskrub `scrubSecrets`/`sanitizeIncoming`)
  - `src/mcp/http-transport.ts:328-334,393-406` (`data:` digabung dengan `""` alih-alih `"\n"`; `readCapped` mengecek `out.length` char UTF-16 alih-alih jumlah byte)
  - `src/mcp/server.ts:582-584,700-705` (`completedCache` tidak mengikutsertakan hash argumen; `onEnd` menutup shutdown controller secara sinkron sebelum request terakhir di-`handleLine` selesai)
- **Rekomendasi Perbaikan:** Lakukan read-merge sebelum `persist()` pin MCP + scrub error tool MCP; gabungkan multi-line SSE `data:` dengan `"\n"` serta hitung byte UTF-8 pada `readCapped`; sertakan hash argumen di kunci `completedCache` dan tunggu antrean request sebelum memanggil `done()` pada EOF `mcp server`.

### INT-02 [MEDIUM] — LSP Client Crash Uncaught Exception pada Frame Rusak & Sync `taskkill`
- **Lokasi:** `src/lsp/client.ts:275,527-535,564-570`
- **Kelemahan:** Listener `stdout.on("data")` memanggil `handleData(chunk)` yang melakukan `for (const msg of this.frames.push(chunk))` tanpa `try/catch` di luar `dispatch`; jika LSP server mengeluarkan header Content-Length rusak atau melewati batas frame, exception tidak tertangkap dan mematikan seluruh proses CLI via `uncaughtException`. Selain itu `stop()` di Windows memakai `spawnSync("taskkill", ...)` hingga 2 detik yang membekukan event loop.
- **Rekomendasi Perbaikan:** Bungkus `this.frames.push(chunk)` dalam `try/catch` (reset buffer & fail pending request dengan error LSP terukur), dan ganti `spawnSync("taskkill")` dengan `spawn` berbatas timeout asinkron.

---

## 7. Temuan Gate, Build, Packaging, Benchmark & Dokumentasi

### GATE-01 [HIGH] — Headroom Paket Kritis (40 KiB), Celah Workflow Publish, Coverage, Eval & Docs
1. **Ukuran Paket Nyaris Mentok (`40 KiB` tersisa):** `npm pack --dry-run --json` melaporkan `343` file = `5210 KiB` vs batas `< 5250 KiB` (`scripts/pack-budget.ts:188,201`). Penambahan berkas kecil dapat langsung menggagalkan `gate:pack`. *Rekomendasi:* Audit isi paket via `npm pack --dry-run --json` (mis. file yang tidak diperlukan runtime) sebelum rilis.
2. **Publish Workflow Redundan & Kurang Lengkap:** `.github/workflows/publish.yml:45-55` menjalankan `bun test` lalu `bun run gate:coverage` (menjalankan seluruh test suite 2 kali), dan tidak menjalankan `gate:bash`, `bench:smoke`, `gate:telemetry`, atau `ci-windows` sebelum `npm publish`. *Rekomendasi:* Konsolidasikan ke `bun run gate:fast` (atau pastikan seluruh gate + tes Windows tervalidasi).
3. **Blind Spot `CRITICAL_FILES` di `scripts/coverage-gate.ts:119-142`:** Modul bermasalah nyata seperti `providers/{anthropic,responses,provision,sse-bounds}.ts`, `daemon/{server,store}.ts`, `task/store.ts`, `tools/task.ts`, `mcp/client.ts`, `lsp/client.ts`, `ui/tui/transcript.ts`, dan `cli/commands/{exec,acp}.ts` belum masuk daftar 19 modul berambang ketat. *Rekomendasi:* Tambahkan modul berisiko tinggi tersebut bertahap sesuai keputusan gate.
4. **Eval Gate Mengizinkan Skor Rata (`bench/eval-gate.ts:347-353`):** Docstring `L277-278` mensyaratkan *"harus menurunkan"*, tetapi kode memakai operator `<=` (`unproductiveRetryRate`, `regressionRate`). *Rekomendasi:* Gunakan perbandingan ketat `<` sesuai spesifikasi.
5. **Skrip Sync Vendor Bersifat Destruktif (`scripts/vendor-minicore.ts:290-313`):** Akan menimpa `vendor/minicore/VENDOR.md` dengan `# vendor/minicore — JANGAN EDIT MANUAL`, menghapus catatan status *HOST-EDITABLE* sejak v0.16.0. *Rekomendasi:* Perbarui template generator di `vendor-minicore.ts` agar konsisten dengan status host-editable.
6. **Drift Dokumentasi (`docs/cli.md:56`, `docs/tools.md:100`):** `docs/cli.md` masih menulis batas atas sub-agent `50`, sedangkan `src/constants.ts:227` adalah `SUB_AGENT_MAX_STEPS: 600`; `docs/tools.md` masih menulis kuota & tangga lama (`16/24/40/64`, fallback `5/15`, ladder `[8,12,20,32,50,75,100]`) yang tidak lagi sinkron dengan `src/policy/subagent-budget.ts` (`24/40/64/100`, `[24,40,64,100,150,250,400,600]`). *Rekomendasi:* Sinkronkan kedua bagian dokumentasi tersebut dengan nilai kerja aktif.

---

## 8. Klaim Awal yang Dieliminasi (Terbukti Aman Setelah Verifikasi Verbatim)

1. **`move_file` di `src/policy/permission.ts:1374-1430` vs `bench/harness-audit.ts:59-60`:** Bukan bug — `permission.ts` menangani alias `path ?? from` dan `destination ?? to`.
2. **Jumlah Explore Tools di `docs/cli.md:46`:** Terbukti akurat — `EXPLORE_TOOL_NAMES` di `src/app/tool-layer.ts:139-141` berjumlah 12 tool.
3. **`turn.failed` / `turn.cancelled` pada `src/ui/tui/transcript.ts:2532-2555`:** Aman — keduanya memanggil `flushTurnTotal()` dan mereset `this.turnActive = false`.
4. **Parser SGR bertanda `:` di `src/ui/render/cells.ts:115-129`:** Sudah ditangani dengan benar oleh `cells.ts` (hanya `theme.ts:700` yang tertinggal).
5. **Propagasi Error `pipeline` di `src/lib/public-http.ts:158`, `isPathOutsideRoot` di `src/policy/jail.ts:138`, & `AbortError` `promptAskText` di `src/ui/approval/prompt.ts:611-643`:** Sudah aman dan tidak bermasalah saat dicek langsung.
6. **`lsp/client.ts:509` flag `this.stopping`:** `this.stopping = true` sudah dipasang sebelum `didClose`/`shutdown`, sehingga `exit` akibat `stop()` tidak dilaporkan palsu sebagai crash.

---

## 9. Rencana Tindak Lanjut Prioritas Sebelum Full Gate & Rilis

1. **Prioritas 1 — Keamanan & Kebenaran Test (`P0`):**
   - Perbaiki `test/bash-guard-fast-fuzz.test.ts:70` (`{ cmd }` bukan `{ command }`) dan jalankan ulang test suite keamanan terkait.
   - Tutup kebocoran header kredensial saat redirect lintas-origin/downgrade TLS di `src/memory/vector.ts:461-502` serta blokir resolusi `keystore:` pada config lokal tak tepercaya di `src/app/rag-layer.ts:62-77`.
   - Perdalam scan `.env*` di `src/sandbox/mask.ts:28-29` & jaga `(cd` / `pushd` di `src/policy/permission.ts:678-689`.
2. **Prioritas 2 — Worktree Kotor `v0.52.1` & Regresi TUI/UX (`P1`):**
   - Perbaiki akuntansi kegagalan `agentWaves` & `pending:${toolId}` di `src/ui/tui/transcript.ts:2984-3034`.
   - Lindungi prompt multi-baris / path berawalan `/` (terutama hasil ekspansi paste) agar tidak disalahartikan sebagai slash command di `src/ui/tui/app.ts:1679` & `cli/tui.ts:1925,2391`.
   - Hapus ikatan tombol `i` dari `deny` di `src/ui/approval/prompt.ts:484`.
3. **Prioritas 3 — Runtime, Storage, Pricing & Providers (`P1/P2`):**
   - Naikkan batas baca streaming di `src/policy/pricing.ts:302-315` agar `pricing sync` bekerja terhadap payload live `models.dev`.
   - Hapus double-escalation context window di `src/app/session.ts:1125,1226`, perbaiki `extractTargetPaths("move_file")` di `src/session/journal.ts:288`, tambahkan `busy_timeout`/`{ readonly: true }` + `BEGIN IMMEDIATE` di `persistence.ts`/`task/store.ts`/`daemon/store.ts`, dan perbaiki tiga provider (`openai-compat`, `anthropic`, `responses`) serta parser `sse-bounds.ts`.
4. **Prioritas 4 — Integrasi, Pack Budget & Gate (`P2`):**
   - Bungkus `this.frames.push` di `src/lsp/client.ts:565` dengan `try/catch`, perbaiki `mcp/server.ts:700-705` EOF shutdown & `mcp/client.ts` pin merge/BOM, sinkronkan `docs/cli.md` & `docs/tools.md`, dan periksa isi paket `5210 / 5250 KiB` sebelum menjalankan full gate atas persetujuan pemilik.
