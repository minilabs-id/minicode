# UI Render Pipeline — peta jalur provider stream → terminal

Dokumen ini hasil audit stabilitas UI/UX terminal 2026-09-18 (baseline v0.9.27).
Sumber kebenaran perilaku tetap `docs/TERMINAL_CONTRACT.md` (FROZEN); dokumen
ini memetakan IMPLEMENTASI aktual per tahap beserta kontrak event dan temuan
audit. Angka test di bawah adalah **historical**, diukur di Windows + Bun 1.4.2 pada
checkpoint audit 2026-09-18 (baseline v0.9.27); di sini tidak ada klaim hijau untuk
v0.33 (`1aaca14`).

Konvensi: `file:line` menunjuk simbol yang dimaksud. Aturan repo tetap berlaku:
`cli/` boleh impor `src/ui/` dan `src/`; `src/` non-ui DILARANG impor
`src/ui/`; `src/ui/` DILARANG impor `cli/`, `src/` non-ui, `#minicore`
(dijaga `test/ui-boundary.test.ts`).

## 1. Jalur pipeline (9 tahap)

Tahap A — provider stream mentah: `src/providers/router.ts` (fallback +
`provider:text` + `provider:extension`), `src/providers/guards.ts:32`
(timeout + text-cap + stream-guard tunggal), adapter `anthropic.ts`,
`responses.ts`, `effort.ts`. Dirakit di `src/app/provider-layer.ts`.

Tahap B — kernel emit ke `session.events`: `vendor/minicore/src/core/loop.ts`
(`turn:started`, `provider:text` per chunk, `provider:extension`
reasoning/usage/error, `context:compacted` reason `pressure:*`/`recovery`,
`step:started/completed`), `executor.ts` (`execution:started/completed`),
`session.ts` (`turn:completed` HANYA di jalur sukses).

Tahap C — raw runtime/content contract: `src/ui/contract.ts` (`UiEvent`) masih
mencerminkan bentuk event kernel untuk streaming konten dan transport. Ledger,
status, lifecycle, dan keputusan user-facing melalui `PresentationEvent` +
`PresentationPolicy` dari `cli/setup.ts`; `attachSimpleLogger` dan
`attachTurnStatus` tetap memasang listener runtime per turn dan melepasnya di
`finally` agar event telat hening.

Tahap C2 — semantic presentation bridge: `cli/setup.ts` membuat
`PresentationAdapter`, mengurangi event ke `PresentationState` lengkap
(conversation, reasoning, system, plan, finding, result, diagnostic), menghitung
summary dari evidence, dan memuat ulang `presentation_events` saat resume. Bridge
memprojection seluruh `DomainEventType` melalui `toPresentationEvent()`;
`src/presentation/projection.ts` menyediakan keputusan policy murni (deskripsi
activity/turn, running pin, envelope machine) yang di-inject ke renderer sebagai
`PresentationPolicy`. Lihat kontrak aktif di `docs/OUTPUT_EVENT_MODEL.md`.

Tahap D — logger utama `src/ui/assistant/simple.ts` (`attachSimpleLogger`):
append-only
scrollback, tanpa alternate screen. `provider:text` → `sanitizeAnsi` PER CHUNK
→ `streamBuffer` → `flushBuf` (line-buffered) → `flushLine` (fence-state +
`decorateMarkdown` + `formatWrapped`) → `stdout`. Jawaban bisa diringkas
(cap 1MB + marker); sejak v0.33 collapsed buffer dan `/view expand` dihapus — ringkasan
hanya melaporkan ukuran, bukan buffer yang dibuka lagi.

Tahap E — garis status transient `src/ui/assistant/turn-status.ts`: satu baris
`stderr` untuk shell/linier, hidup hanya di fase sunyi (latch
`turnOn && !textOn`), hilang saat teks mengalir, hidup lagi saat tool
berikut. `endTurn()` deterministik dari driver `finally` (kernel tak emit
`completed` saat gagal/abort). TUI fullscreen tidak memakai painter transient
ini karena alternate screen dimiliki `TuiApp`.

Tahap F — arbitrator `src/ui/runtime/statusline.ts`: satu pemilik transient
(`turn` vs `spinner`); tulis asing saat painter aktif dikomit
(clear → tulis → repaint) sehingga diagnostik tak hilang; overlap = signal,
bukan crash. `paintWrite` tak pernah melempar (fail-closed Bun Windows).

Tahap G — status bar `src/ui/footer.ts` dirender `src/ui/tui/app.ts` sebagai
baris dasar frame fullscreen. `TuiApp` memiliki clock activity 200ms untuk
menggambar `✦`, timer `HH.MM.SS` di sebelah sparkle, dan dots reasoning
`...` → `..` → `.` tanpa label `Working`/`Thinking`/`Running`. Timer redup saat
idle dan putih saat aktif. Composer hanya menampilkan `minicode ›` setelah
Prompt tampil saat boot/idle, hilang saat busy, dan kembali otomatis setelah
turn selesai; aksi edit/histori tetap dapat membuka composer. Bullet separator
footer dihapus; field dipisahkan dengan spasi dan warna. Satu baris kosong memisahkan composer
dari footer; layout normal dan popup memakai helper geometri yang sama.
`TuiApp` mengaktifkan mouse tracking `?1002h + ?1006h` selama TUI; wheel
menggeser viewport transkrip, drag kiri membuat selection app-level, dan
`Ctrl+C` menyalin selection melalui DI/OSC52. Popup menurunkan ke mode
`?1000h`; tracking dimatikan pada quit, release, dan sinyal fatal.
Footer/chrome lama (`src/ui/runtime/chrome.ts`, DECSTBM scroll-region,
`MINICODE_FOOTER`) DIHAPUS bersama lapisan TUI lama — alternate screen
menggantikannya; nol byte di non-TTY. Footer baca `session.contextTokens` kernel
(bukan spend kumulatif). Warna footer/sparkle di-gate oleh kemampuan warna
(`MINICODE_COLOR=0`/`NO_COLOR` → mono, tanpa SGR bermakna). Sejak v0.33 footer juga
menampilkan satu micro-toast retry `retry n/total · Ns` (TTL 4 dtk, counter live dari
`minicode:retry`, UI-transient) — bukan baris ledger. Mouse wheel menggulir pane di
bawah kursor, termasuk pane sidebar Thinking/Activity/Live/Log, bukan hanya viewport
transkrip.

Tahap H — primitif render `src/ui/render/`: `sanitize.ts` (hanya SGR lolos),
`markdown.ts` + `highlight.ts` (fence-state per baris, konten utuh),
`width.ts` (kolom: CJK/emoji 2, potong aman-SGR), `wrap.ts` (lebar dibaca
per baris → aman resize), `theme.ts` (getter warna/glyph, jangan di-`const`),
`errors.ts` (pesan actionable + redact), `collapse.ts` (delegator state collapse
per-sesi; buffer `/view expand` 200KB/entry + 500KB total sudah tidak ditulis di v0.33), `markdown-table.ts`/`table-grid.ts` (pipe-table
model), `diff.ts`/`table.ts`/`money.ts`/`format.ts`,
`activity-group.ts`/`activity-panel.ts` (panel aktivitas: klasifikasi tool →
keluarga `explore|edit|execute|feed|other` + satu baris ringkas per keluarga,
maks 10 baris; murni, dipakai TUI + linear).

Modul v0.33: `src/ui/render/sidebar.ts` (painter sidebar), `sidebar-layout.ts`
(geometri: aktif `cols ≥ 100`/`rows ≥ 20`, lebar 30%→50%, chat floor 36, tinggi
60:40, split `Live|Log` ≥168), `sidebar-model.ts` (state + ingest thinking
inkremental), `agent-progress.ts` (progres sub-agent di pane Live), dan
`activity-format.ts` (format Activity log). Semua dilukis dalam satu frame `paint()`.

Tahap H2 — tabel Markdown model: `src/ui/render/markdown-table.ts` memvalidasi
header/delimiter, escaped pipe, code span, alignment, dan fence; stream block
di-buffer sampai batas tabel. `table-grid.ts` menghitung lebar kolom dan budget
terminal, sedangkan linear/TUI me-render semantic block yang sama pada TTY dan
mempertahankan source sanitized pada non-TTY. `exec --json`/ACP tidak melewati
renderer ini.
Tahap I — view murni vs controller: `src/ui/screens/` (props + callback,
tanpa IO) digerakkan `cli/` (`tui.ts`, `commands.ts`, `wizard.ts`,
`model-manager.ts`, `provider-manager.ts`, `src/ui/approval/prompt.ts` via DI `ask`,
`setupWhenEmpty`, `setSubAgentSessionFactory`). Readout command (`/help`,
`/status`, `/context`, `/sessions history`, `/provider sync`, `/scheduler`) dirender
`output-window.ts` sebagai jendela ber-scroll di atas chat (v7.18–v7.19, reflow saat
resize, counter judul, scroll wheel/`j`/`k`/`Space`, dan salin `c` opsional); jendela
interaktif command (`/model`, `/provider`, `/sessions`, picker) berbagi
`dialogBox`/`hintLine` (dan `listRow` untuk daftar) yang sama serta mendukung scroll mouse
wheel. TUI fullscreen **tidak** menampilkan logo maupun hint pada zero-state saat
transkrip kosong/idle (tanpa identitas/hint di atas prompt). `Ctrl+O` membuka modal
detail live-tool; `/view expand`, `/expand`, dan collapsed buffer dihapus di v0.33.
`Alt+PgUp/PgDn` menggulir kedua pane dan memindahkan seleksi Live, `Home`/`End`
membawa chat dan sidebar ke tepi, `PgUp/PgDn` tetap khusus chat. `Tab` pada dropdown
`/` untuk autocomplete, jeda antar-turn dan label bahasa fence redup, serta fallback
glyph `MINICODE_ASCII=1` konsisten hingga garis tabel dan ellipsis.

## 2. Kontrak Event → UI

Kolom: S = bisa di-stream, D = bisa duplikat, O = bisa out-of-order,
I = bisa diinterupsi, L = bisa tiba setelah completion.

| Event | Producer | Representasi UI | S | D | O | I | L |
|---|---|---|---|---|---|---|---|
| assistant text | provider stream | stdout/TUI wrap ber-indentasi gantung (margin kiri 3 kolom adaptif, jeda antar-poin/heading/blok) + code fence 3-spasi; pipe-table-aligned di TTY, source sanitized di non-TTY | ya | tidak (E1) | tidak | ya (abort) | tidak (detach flush 1x, E6) |
| tool call | model → kernel | `› nama target` muted (compact: diam) | tidak | tidak | tidak | ya | tidak |
| tool result | tool → executor | v0.33: ringkasan kategori di chat (`3 command · 2 read · 5 subagent`), bukan ledger per-tool/`Tool:`/`/expand`; detail di Activity log sidebar | tidak | tidak | tidak | ya | tidak |
| reasoning | provider extension | v0.33: dirender penuh di pane Thinking sidebar bila aktif; di-ingest inkremental via `SidebarModel.ingestThinking` sebagai session history dengan marker trim; TIDAK masuk transkrip chat. Jalur linear: stderr/verbose | ya | tidak | tidak | ya | tidak |
| thinking effort | picker `/model` | badge + level per model | tidak | tidak | tidak | tidak | tidak |
| usage | provider extension | verbose saja; masuk budget watcher | ya | tidak | ya (tail pasca-finish) | ya | ya (diabaikan aman) |
| compaction | kernel loop | `… compacted: <reason>` dengan reason dibedakan (`pressure:*`, `…:no-op`, `recovery`, serta `fixpoint`/`impossible`/`llm-failed`); tidak menghapus history | tidak | tidak | tidak | tidak | tidak |
| finding | `submit_result` / child `[FINDING]` | Activity log sidebar bila aktif; transkrip di jalur linear; machine typed `finding.detected` | tidak | tidak | tidak | ya | tidak |
| retry | recovery policy (`minicode:retry`) | satu micro-toast footer `retry n/total · Ns`, TTL 4 dtk, counter live; UI-transient, bukan envelope machine | ya | ya | tidak | ya | tidak |
| permission request | executor → `ask` DI | header stdout + `askLine y/a/n`, fail-closed non-TTY | tidak | tidak | tidak | ya (deny) | tidak |
| permission denied | executor | error tool penuh, tak pernah minimize + reason | tidak | tidak | tidak | tidak | tidak |
| sub-agent | delegate_task → bus parent | v0.33: progres tampil di pane Live sidebar (via `agent-progress.ts`); temuan `[FINDING]` → `minicode:child-report` → `finding.detected` → Activity log; jalur linear tetap ledger | tidak | tidak (jurnal skip forward) | tidak | ya | tidak |
| error provider | provider extension | `pendingError` consume-once → satu pesan error berwarna oleh driver | tidak | tidak (E15) | tidak | ya | tidak |
| warning | budget/recovery/verify | `[budget]`/`[recovery]`/`[verify]` kuning stderr | tidak | tidak (warned80 sekali) | tidak | tidak | tidak |
| completion | kernel loop | flush + `finalizeAnswer` + footer idle | tidak | tidak | tidak | tidak | tidak |
| abort | user/Esc | `(stopped)` + cleanup `finally` | tidak | tidak | tidak | — | tidak |
| timeout | kernel `createTimeout` | `timeout` (berwarna) + turn dibuang transaksional | tidak | tidak | tidak | — | ya (late work ke turnStore privat, dibuang) |
| budget exceeded | watcher/driver | `[budget] … stopping turn` + abort ber-kind | tidak | tidak (fire-once) | tidak | — | tidak |
| provider failure | recovery policy | retry/compact/throw deterministik; cap retryAfter 30 dtk | tidak | tidak | tidak | tidak | tidak |

Mismatch yang dicari, hasil: raw EventBus tetap ada untuk konten/streaming,
tetapi keputusan user-facing kini membaca policy yang sama (raw ledger TUI
dihapus di Phase 8). Buffer jawaban live TUI dibatasi 1.000.000 karakter;
layout paint memakai satu proyeksi transcript dan cache render jawaban.
`cli/setup.ts` (`toPresentationEvent()`) memproyeksikan seluruh `DomainEventType` secara
exhaustive; TUI memakai `describeActivity`/`matchTurn`/`elapsedVisible` via
injeksi, linear memakai deskripsi + `activityFor` untuk label turn-status, dan
machine memakai `toMachineEnvelope`. `bus-debug.ts` hanya debug subscription.
Lihat kontrak aktif di `docs/OUTPUT_EVENT_MODEL.md`,
`docs/OUTPUT_PROTOCOL_SPEC.md`, dan `docs/OUTPUT_RENDERING_SPEC.md`. State
turunan yang disengaja tetap footer memakai `contextTokens` (estimasi jendela), sedangkan `/status`
memisahkan Context/Input/Output/Total/Cost/Budget di
`docs/CONTROL-PLANE-MAP.md`.

Ringkasan v0.33: chat = narration + category recap + final answer. Ledger per-tool,
`Tool:`, `/expand`, dan collapsed buffer tidak lagi dirender; detail berpindah ke
Activity log sidebar (atau transkrip pada jalur linear).

## 3. State machine TUI (tidak eksplisit)

Tidak ada `enum` state; fase disimpulkan: `abort !== null` (busy),
`turnOn/textOn` (painter), `regionOn/detached` (chrome), plus ~14 flag
(`mode`, `escTimer`, `pending`, `nullStreak`, `warned80`, `activeSection`,
minimize toggles, buffer, `pendingError`, raw-mode listener). Invarian dijaga
`finally`/`detachUI`/`endTurn`, bukan type-state. Transisi ilegal yang
terbukti dicegah: painter saat teks mengalir, `endTurn` ganda, error ganda,
`+`/`-` di pipe, decoder bocor antar prompt, Tab membajak search.
Satu lubang nyata: listener approval `askLine` menempel DI ATAS `onBusyKey`
selama busy (byte Ctrl+C diterima keduanya) — aman fail-closed
(`raceAbort` → deny) tetapi observabilitas ganda. Lihat §5 temuan O1.

## 4. Temuan audit 2026-09-18 (eksperimen di /tmp, repo tak diubah)

F1 HIGH — SGR terbelah antar-chunk merusak output model. `sanitizeAnsi`
diterapkan PER CHUNK (`simple.ts:287`): `["\x1b[", "32mHello"]` tampil
literal `32mHello`. Bukti: harness E3 `out="32mHellom\n"`. Kelas sama untuk
OSC tak-terminasi (menelan sisa chunk). Perbaikan terkecil: tahan ekor
escape tak-lengkap di buffer dan sambung ke chunk berikut sebelum sanitasi.

F2 MEDIUM — SGR model bocor mentah ke stdout non-TTY. `"\x1b[31mRed\x1b[0m"`
satu chunk lolos `sanitizeAnsi` (by-design) lalu ditulis ke pipe apa adanya
(`out="\u001b[31mRed\u001b[0m\n"`), melanggar kontrak non-TTY deterministik.
Perbaikan terkecil: strip SGR (atau render via `c.*`) saat `!isTTY`.

F3 LOW — buffer thinking `/view expand` membuang kepala diam-diam
(`thinkingBuf.slice(-200_000)` tanpa marker seperti `, capped 1MB` pada
answer). Informasi diagnostik hilang tanpa jejak.

O1 LOW — listener ganda approval vs busy-key (§3). Fail-closed, catat saja.

Status hardening (sesudah audit): F1 diperbaiki via `createStreamSanitizer`
+ `splitTrailingEscape` di `src/ui/render/sanitize.ts` (dipakai jalur teks
model/reasoning/bash di `simple.ts`, flush deterministik saat
completed/detach); F2 via kebijakan `stripSgr` non-TTY di `wOut`/`wErr` +
`rememberTurn` (cerminan `colorLevel` → `stdout.isTTY`); F3 via marker
`… (earlier thinking truncated)`; O1 didokumentasikan di `src/ui/tui/app.ts`
(busy-freeze + abort, tanpa refactor). Snap kiri/kanan: render pertama sesudah
geometri berubah
me-reset jangkar relatif askLine (`lastGeoCols/Rows` di `input.ts`) —
geometri lebar tak dilacak footer karena erase baris-absolut tak sound
pasca-reflow (terbukti model + ConPTY: reflow milik konsumen).
Dijaga `test/ansi-fragmentation.test.ts`
(termasuk properti semua-titik-belah ≡ whole-string),
`test/non-tty-output.test.ts`, `test/thinking-truncation.test.ts`,
`test/tui-format.test.ts` (stdout/stderr + ledger tool), `test/footer-render.test.ts`
(footer),
`test/input-resize.test.ts` (gagal di kode lama: CUP ke anchor basi).

Batas yang TERVERIFIKASI BENAR (bukti harness + 178 test UI hijau — **historical**,
checkpoint 2026-09-18, bukan angka v0.33):
token-by-token tepat-1x (E1), chunk 50KB utuh (E2), fence terbelah benar
termasuk yatim saat abort (E4/E4b), abort flush tepat-1x tanpa bocor ke turn
berikut (E6), urutan teks>tool>hasil (E7), permission fail-closed (E8),
kontrak budget murni vs gate (E9), tiga reason kompaksi tampil beda (E10),
forward sub-agent sebagai ledger biasa (E11), tool 5000-baris dipotong +
ANSI jahat dibuang (E12), decoder UTF-8 per-byte + ESC-split + paste 100KB
(E13), soak 50 turn tepat-1x 38ms +4.6MB tanpa ESC mentah (E14),
error consume-once + format actionable (E15), resize 120→20 mid-stream aman
(E5b), 10k events 151k ev/s tepat-1x (E17), CJK/emoji/wrap/truncate/fence
(E5), emphasis tak-seimbang lewat literal + tabel konten-tetap (fidelitas).

## 5. Residual risk (jujur, belum dibuktikan di audit ini)

Jalur TTY-live (painter denyut, footer sticky DECSTBM, overlay picker,
tombol busy) hanya tercakup harness fake-TTY + 178 test (angka **historical**
checkpoint 2026-09-18); tidak ada sesi TTY nyata di audit ini. Chaos kombinasi
(stream+resize+abort serentak di TTY) dan soak 100+ turn multitool belum dijalankan.
Catatan v0.33: sub-agent kini punya representasi di pane Live/Activity sidebar
(`agent-progress.ts`), jadi tidak lagi "tanpa view khusus"; delegasi bertingkat tetap
dilarang (tanpa nesting). Representasi visual ini belum diuji pada sesi TTY nyata
dalam audit historical ini.

## 6. Optimasi latensi ketik & biaya salin (fase 1–4, pasca-audit)

Ringkasan: TUI tetap penuh `rows` baris secara LOGIS; yang diperkecil hanyalah
byte FISIK yang ditulis. Kontrak perilaku user-visible tidak berubah, jadi
`TERMINAL_CONTRACT.md` I1 adalah sumber kebenaran.

- **Fase 1 — satu `write` per frame.** `screen.paint` merakit seluruh frame
  (masuk blok sinkronis `ESC[?2026h`/`ESC[?2026l`) menjadi SATU string lalu
  menulisnya sekali ke `process.stdout`. Menghapus sejumlah `write` kecil per
  frame yang membuat ConPTY membangun ulang potongan.
- **Fase 2 — diff per sel.** `src/ui/render/cells.ts` memecah baris menjadi sel
  (grapheme + STATE SGR ternormalisasi) dan menghasilkan byte minimal:
  prefix identik dilewati (nol byte), lalu dari kolom berbeda PERTAMA sampai
  akhir baris ditulis ulang setelah EL `ESC[0K`. Start mundur ke sel pembawa
  glyph agar EL tidak membelah glyph lebar; kolom lanjutan ditandai `cont`.
  Frame pertama / resize / perubahan jumlah kolom tetap `ESC[H`+`ESC[2J`.
- **Fase 2b — invalidasi drift.** Tulis asing ke stderr selama alt-screen hidup
  (mis. `[hooks] skipped …`, warning provider) mengotori buffer di balik
  pelacakan diff; `statusline` menandainya (`consumeScreenDrift`) dan layar
  memaksa repaint penuh sekali. `beginInteractiveScreen` memasang wrapper
  stderr saat depth 0→1 supaya sinyal ini terpasang bahkan tanpa owner transient.
  Tanpa ini baris yang kebetulan tak berubah akan mempertahankan fragmen asing.
- **Fase 3 — hot path editor.** `screen.moveCursor` untuk fast-path kursor-saja
  (tanpa merakit ulang frame); `prompt-engine.ts` memakai memo grapheme 1-entri
  + fast path ASCII; `composer-wrap.ts` melakukan wrap inkremental saat append/
  backspace di ujung, jatuh ke `chunkByWidth` penuh bila pola tak didukung.
- **Fase 4 — biaya salin.** `transcript.selectionText` memakai binary search
  (`orderLowerBound`) + `selectionIsEmpty` murah; guard OSC 52 berbasis byte
  (`MAX_CLIPBOARD_BYTES`/`MAX_SELECTION_BYTES` = 256 KiB) di `simple.ts` dan
  `app.ts`; `/copy` dibatasi total byte dan melaporkan `tui.copyTooLarge`.

- **Fase 5 — ingest reasoning inkremental (v0.33).** `SidebarModel.ingestThinking`
  menambah potongan reasoning ke session history tanpa rebuild O(n²) tiap delta;
  entri lama dipangkas dengan marker `… N older items trimmed`. Guard
  `test/perf-no-quadratic.test.ts` menjaga kompleksitas. Reasoning tampil penuh di
  pane Thinking sidebar bila aktif, bukan di chat.

Penjaga: `test/cells.test.ts` (paritas diff vs tulis-penuh + minimalitas),
`test/composer-wrap.test.ts` (paritas wrap inkremental), `test/screen.test.ts`
(satu `write`/frame, repaint penuh pada drift/frame pertama, diff setara),
`test/perf-no-quadratic.test.ts` (ingest reasoning inkremental),
plus `test/pty.test.ts` / `test/screen-buffer.test.ts` untuk verifikasi buffer
nyata. Angka hasil historis (laporan sebelumnya, termasuk 178 test UI di atas)
tetap berstatus historical pada checkpoint-nya; tidak ada klaim hijau v0.33 di sini.
