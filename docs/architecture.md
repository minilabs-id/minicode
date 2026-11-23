# Arsitektur

Dokumen ini adalah peta struktur dan alur runtime yang aktif untuk kontributor.

Roadmap fase pemilik tidak tersedia di checkout ini; jangan simpulkan status fase atau next action dari changelog maupun kode. `TERMINAL_CONTRACT.md` adalah kontrak terminal FROZEN — baca sebelum mengubah output; perubahan perilaku memerlukan pembaruan kontrak dan peta test. Kontrak output aktif ada di [event model](OUTPUT_EVENT_MODEL.md), [protocol](OUTPUT_PROTOCOL_SPEC.md), [rendering](OUTPUT_RENDERING_SPEC.md), dan [UX rules](OUTPUT_UX_RULES.md). Peta alur rendering ada di [UI Render Pipeline](UI_RENDER_PIPELINE.md).

## Tiga lapisan

```
L1 cli/ + src/ui/   → controller tipis + presentation mandiri
L2 src/ non-ui      → agen: tools, agents, hooks, policy, providers, mcp, lsp, session, skills
L3 vendor/minicore  → kernel STATE/MODEL/ACTION/LOOP (vendored, host-editable, zero-dep, via #minicore)
```

Kernel di-vendor dan **dapat diedit di host** sejak v0.16.0 (lihat
[catatan vendor MiniCore](https://github.com/minilabs-id/minicode/blob/main/vendor/minicore/VENDOR.md));
commit sumber `0d33571` hanya referensi historis provenance, bukan invarian
keras. Impor kernel aplikasi hanya melalui `#minicore`.

Patch host yang diperlukan runtime tersimpan di `scripts/vendor-overlays/` dan
diterapkan saat sinkronisasi vendor. `bun run vendor:check` masih bisa dipakai
sebagai alat diagnosa provenance, tetapi bukan gate: hash yang tercatat di
`VENDOR.md` adalah checkpoint historis dan tidak ikut berubah saat kernel
diedit di host.

- `cli/` boleh impor `src/ui/` + `src/`; `src/` non-ui dilarang impor `src/ui/`; `src/ui/` dilarang impor `cli/`, `src/` non-ui, `#minicore`. Dijaga `test/ui-boundary.test.ts`.
- Satu-satunya jendela UI↔luar: `src/ui/contract.ts` (`UiEvent/UiBus/UiStep/UiExecution`).
- DI dari composition root (`cli/index.ts`, `cli/setup.ts`): `createProviderLayer → loadLastModel → createRagLayer → resume presentation-events + planRecovery + reconcileUndoRedo → setupToolLayer + setAskTextFn → createMinicodeSession → journal + checkpoint + semantic event sink + step-trace + runPromptWithVerify (baseline-first + self-heal 3 siklus + hooks) → logger + turn-status + usage/pricing → persist/finalize → close (kill jobs, mcp/lsp close)`. `setSubAgentSessionFactory` sebelum dispatch agar TUI/one-shot/`mcp serve` tercakup. Tidak ada DI `SidebarModel` lagi: sejak v0.34 sidebar dihapus total, geometri kolom chat dihitung murni dari lebar terminal di `src/ui/render/chat-column.ts` dan dipakai painter TUI di dalam satu frame yang sama.
- `providers → config` satu arah (`src/providers/provision.ts` provisioning, `src/config.ts` murni IO).

## Alur satu prompt

Steering: `Session.steer(text)` (dipanggil host saat user menekan Enter selagi
turn berjalan) menaruh teks di antrean kernel, dan loop menyuntiknya sebagai
pesan `user` di **batas step** — sebelum request provider berikutnya — bukan di
tengah stream. Tanpa turn aktif `steer()` mengembalikan `false` (tidak menampung
diam-diam); host lalu menjalankannya sebagai turn berikutnya.

`prompt → permission check → validateArgs (kernel) → executor (order/cap/abort-aware) → P2.10 canonical tool wrapper (await EffectIntent → execute → await EffectReceipt) → tool realpath+atomic → checkpoint shadow-git + journal + step-trace → compaction (mekanikal sinkron; LLM async via seam `compactAsync`) → usage/pricing per-segmen longest-key → trace`.

## Rekap footer & label aktivitas tool (v0.35)

Sejak v0.35 rekap tool **bukan state live**: ia ditulis sebagai **baris
committed statis** di transkrip, bukan baris transient yang berubah-ubah saat
tool masuk. Urutan footer tiap narasi adalah
`tool → narasi → rekap(tool sebelum narasi)` — baris rekap mendarat tepat
setelah narasi dan menghitung tool yang terjadi **sebelum** narasi itu. Rekap
**AKHIR turn** bersifat kumulatif untuk **semua** tool selama turn (bukan
potongan per segmen yang di-reset), dengan format satu baris
`2 command · 118 read · 1 other` (sejak v0.41 tanpa prefix simbol). Klausa lama
— rekap dua baris saat live,
`flushActivityFold` net-nol, `liveSummaryRows()` mengikuti ekor, dan jeda
antar narasi sebagai baris melayang — adalah **arsip v0.33/v7.x yang ditimpa
v0.35**; rincian presedensi ada di [Kontrak Terminal](TERMINAL_CONTRACT.md).

Alur ringkas:

```text
tool selesai ─► narasi model ─► rekap(tool sebelum narasi)     [committed, statis]
                                      │
                                      └─ akhir turn: kumulatif seluruh tool turn
```

Label aktivitas tool `› …` memakai **bahasa sistem/OS** — resolusi locale
lewat `Intl`, dipetakan ke `id`/`en` — di **semua permukaan**: painter TUI,
printer linear `src/ui/assistant/simple.ts` untuk one-shot/`exec`, dan ACP.
Narasi/progres/jawaban model TETAP memakai bahasa pengguna (`/lang`, fallback
`MINICODE_LANG`). Ini pengecualian sempit dari prioritas i18n lama
(`/lang` > `MINICODE_LANG` > state.json > OS > en): khusus label `› …`,
**locale OS yang menang** demi kosakata tool yang konsisten lintas permukaan.
Resolusi ada di modul `src/ui/render/tool-label.ts`, dipakai bersama TUI dan
`simple.ts` (bukan dua implementasi yang bisa divergen).

## Konteks & state durable

Konteks model adalah **working memory**, bukan state. Tiga lapis yang berbeda
dutinya:

| Lapis | Isi | Authoritatif untuk |
|---|---|---|
| Kernel `ContextStore` | history yang dikirim ke model, bisa lossy saat kompaksi | window berjalan |
| Tabel `messages` (durable) | `role, content, toolCalls, toolCallId, name, reasoning, is_error`; dapat diganti saat shrink kompaksi | continuity/resume dari bentuk tersimpan saat ini |
| Vektor memory + `presentation_events` | ringkasan memory best-effort dan event semantik terpilih | RAG & audit UI; bukan salinan lengkap percakapan |

Kompaksi bersifat lossy, termasuk setelah restart. `persistCurrent` mengirim
history yang sudah dipadatkan ke `shrinkThreadHistory`, yang menghapus lalu
menulis ulang baris `messages`; fold mekanis meringkas pesan lama sambil
**mempertahankan** hasil tool (head-terpotong per peran) — bukan membuangnya.
Ringkasan ke vector memory hanya dibuat di jalur LLM, dibatasi, opt-out, dan
best-effort. Karena itu jangan menganggap
semua fakta lama tetap dapat dipulihkan dari sesi atau vector store; state
penting harus dicatat di task, file, atau artefak verifikasi yang otoritatif.

Fidelity resume: `reasoning` (thinking) dan `is_error` (tool gagal) adalah
field kernel `Message` yang ikut dibawa ke history. Semula keduanya tidak punya
kolom, sehingga resume menghasilkan konteks buta. Keduanya kini jadi kolom
`messages` dan **wajib ikut prefix comparison** di `saveSession` — kalau tidak,
perubahan hanya pada `reasoning`/`is_error` dianggap "tak berubah" dan
incremental append melewatkannya (kelas bug F-05). Kolom ditambahkan additive,
jadi DB lama tetap terbaca dan turn lama resume dengan field absen.

Penulisan tetap incremental: `saveSession` hanya insert baris baru saat prefix
sama, bukan menulis ulang seluruh history. Ini alasannya sidecar JSON per-turn
pernah ditolak — history 400 pesan terukur 62 ms encode + 53 ms blob write tiap
turn (O(history)), jadi ~115 ms per turn, sementara jalur `messages` bersama
prefix-compare 10 ms.

## Task system (state kerja durable)

Task state **bukan** chat history dan **bukan** tool trace. Sumber kebenaran durable adalah `TaskStore` di SQLite lokal workspace (`.minicode/tasks.db`, `src/task/store.ts` + `src/task/db/{types,schema}.ts`), sedangkan `src/tools/todo.ts` menjadi adapter model/tool (memperbarui `.minicode/todos/<id>.json` + menyinkronkan ke `TaskStore` via `synchronizeCanonicalTasks` di `src/task/sync.ts`), dan `plan.updated` (event durable untuk ACP/`exec --json`) adalah proyeksi downstream (`syncTodoViewsFromTaskStore`).

```text
todo_write (model) ─► normalizeTodos ─► .minicode/todos/<id>.json (snapshot proyeksi)
                            │                    │
                            │                    ▼
                            │         synchronizeCanonicalTasks ─► .minicode/tasks.db (TaskStore: authority)
                            │                                            ▲
                            ▼                                            │ setCompletionEvidence
                     plan.updated (proyeksi downstream SETELAH sukses) ─┘
```

Tiga aturan yang menjaga domain ini:

1. **Identitas sesi kanonik (P2.1) & ID kanonik TaskStore (P4A).** Todo terikat ke `sid` kanonik dari
    `resolveSessionIdentity` (`src/session/identity.ts`), bukan id volatil
    proses (`bootId`). `--resume` tanpa `--session` tidak lagi menempa id
    acak; `--resume` tak dikenal gagal eksplisit (`SESSION_NOT_FOUND`). Alokasi `taskId` kanonik sepenuhnya milik `TaskStore`.
2. **Completion butuh bukti.** `setCompletionEvidence()` menyuntikkan verdict (`unverified` | `passed` | `failed` | `stale`) dari composition root. `failed` menolak
   `completed` → task jadi `blocked` + alasannya, dan hasilnya dilaporkan ke
   model; `requireVerified && unverified` menahan klaim di `VERIFYING` / menurunkannya sesuai gerbang verifikasi. Default `unverified` menjaga pemakaian tanpa `--verify` tetap berjalan; yang dilarang adalah completion diam-diam tanpa jejak.
3. **Satu otoritas status, satu jalur proyeksi.** `TaskStore` adalah satu-satunya otoritas mutasi/reconcile/claim (`TaskAuthority`: `LEGACY` vs `SCHEDULER`), sementara `TaskGraph` dan `ProductionScheduler` di `src/task/` beroperasi di atas `.minicode/tasks.db`; `todo_write` dan `/openwork` membaca serta menyinkronkan melalui adapter `src/task/sync.ts` dan `syncTodoViewsFromTaskStore` — dan `plan.updated` hanya terbit di `execution:completed`, bukan dari argumen sebelum tool jalan. (`/undo` memulihkan berkas + percakapan dengan membuat sesi cabang, tetapi tidak membalik status task durable).

## Bukti verifikasi (P2.10)

`src/session/verification.ts` + `src/tools/evidence.ts` menulis identitas
invokasi, intent pra-efek, receipt pasca-eksekusi, dan observasi eksplisit ke
jurnal mutasi yang sama (`src/session/journal.ts`). `committed` berarti return
tool terobservasi, bukan efek eksternal terbukti; `pending` tetap UNKNOWN.
Verifikasi tak menulis `messages`, proyeksi, presentasi, Run, atau kursor.

## UI/UX terminal (kontrak FROZEN)

Sesi interaktif (`minicode` di TTY mampu) SELALU membuka TUI **fullscreen alternate screen**: transkrip ala shell + status bar satu baris + popup komposit di atas transkrip yang tetap terlihat (redup). Sejak v0.34 **sidebar kanan dihapus total**: chat menjadi kolom tengah — `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)` dengan padding kiri/kanan (maks 50% lebar terminal), footer/composer ikut ter-centre; di bawah ambang itu chat memakai lebar penuh. Popup/modal tetap full-screen ter-centre pada `cols` (I20 tidak berubah), satu frame / satu `stdout.write` (I1) tidak berubah. Sejak v0.36 composer dibatasi **maksimal 2 baris** (draft panjang = jendela geser, tanpa menambah baris / menggeser transkrip), dropdown `/` jadi **overlay di dalam frame yang sama** tanpa mengurangi `viewH` (tanpa `paintRegion()` terpisah agar tak ada dua write/flicker saat steer), lebar prompt/kursor memakai satu helper `composerWidth()` (cap v0.36 =
`min(100, chatWidth())`, **diganti v0.37** dengan cap progresif
`min(chatCols, 100 + floor(max(0, chatCols-100)/4))`), dan prefix adaptif
`minicode › ` (v0.36: ≥60 kolom; **v0.37: `w−14 ≥ 24`**) / `› ` dengan lanjutan
`· `. Sejak v0.37 pula bracketed paste aktif, `Ctrl+A` = select-all transkrip
bila composer kosong & dropdown tertutup, dan resize stabilizer. Jalur non-interaktif (one-shot prompt, `exec`, pipe/redirect/CI, `TERM=dumb`, layar < 10 baris) tetap shell-first: cetak polos append-only ke scrollback tanpa cursor control.

| Stream | Isi |
|---|---|
| stdout | Output program: teks model, receipt perubahan (`› write_file …`), daftar/artefak perintah. Bersih dari cursor-control saat non-TTY |
| stderr | Progress/diagnostik: ledger tool (`› …` hijau/merah), reasoning (verbose), warning, error. Boleh transient bila TTY |
| Keduanya | Warna hanya bila TTY (`stdout.isTTY`); `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe |

Satu-satunya arbitrator transient: `src/ui/runtime/statusline.ts` (`acquireTransientPaint` + `paintWrite`). Painter aktif (garis status turn vs spinner wizard vs bar loading) mutually exclusive; overlap = signal `[transient-paint]`, bukan crash. Foreign stderr writer (non-UI) boleh mentah — arbitrator mengkomitnya sebagai baris permanen bersih. `beginInteractiveScreen` menahan semua painter itu selama layar interaktif memegang terminal; tulis asing saat alt-screen hidup juga menandai terminal "kotor" (`consumeScreenDrift`) agar layar memaksa repaint penuh pada paint berikutnya. Bar loading startup (`src/ui/runtime/loading-bar.ts`) adalah painter transient jenis kedua: single-line blok `▓░` + persen + label, digambar ulang hanya saat `update(label, percent)` dipanggil, TTY-only (non-TTY = no-op nol byte), label disanitasi. Diagnostik fase startup (identity/writer/resume/recovery/context) didefer saat REPL ke `ctx.startupNotices` dan di-flush ke transcript TUI; non-interaktif tetap mencetak langsung. 37 invariant (I1–I37; I36 = jendela output command, I37 = recovery/approval — bukan invariant sidebar) + peta test (`tui-app`, `screen-buffer`, `tui-popup`, `transient-arbitration`, `loading-bar`, `input-resize`, `exit-codes`, `acp`, `ui-boundary`, `chat-column` untuk geometri kolom tengah v0.34, serta `retry-visibility`, `perf-no-quadratic`, `shell-tokenize`, `subagent-budget`) ada di `TERMINAL_CONTRACT.md`. Test lama `sidebar-invariants`, `sidebar-model`, `sidebar-width`, `thinking-truncation` sudah dicabut dari klaim aktif bersama sidebar. Kontrak itu juga memuat **peta gap proteksi** — klaim yang implementasinya benar tetapi belum punya assertion penjaga; itu daftar pekerjaan, bukan daftargreens.

Tujuh primitif tampilan (semuanya di dalam TUI fullscreen saat interaktif): transkrip chat `minicode ›` tampil saat boot/idle dan kembali otomatis setelah turn selesai — isinya narasi, rekap kategori (mis. `3 command · 2 read · 5 subagent`), baris tool/`✦`/finding, marker `+ thinking` (kembali sejak v0.34), dan jawaban akhir; ledger per-tool, agregat `✦`, dan `finding.detected` KEMBALI ke chat (v0.33 memindahkannya ke sidebar — sekarang dicabut); baris `Tool:` dan `/expand` tetap dihapus; status bar satu baris (`✦ 00.00.00 Discuss  model  cwd … context  Auto ●` — nilai mode saja, label produk `Work Mode:`/`Permission Mode:` dihapus v0.24; titik `●` kuning=allow-list aktif, abu=nonaktif, `○` merah=unrestricted, badge `◷ N` bila job background hidup) dengan sesi baru `DISCUSS`+`AUTO`, pilihan Work Mode hanya Discuss/Build dan Permission Mode hanya Auto/Ask; Work Mode di kiri dan Permission Mode cyan rata kanan dekat konteks (timer redup idle, saat aktif hanya detik putih, menit ikut terang setelah 60 dtk, jam setelah 1 jam; sparkle proses; tanpa bullet separator; `src/ui/tui/app.ts` merender composer dots dan satu spacer di atas footer per frame); popup komposit satu kotak (`/model`, `/provider`, `/sessions`, form, approval) via `openAltScreen`/`paintRegion`; thinking memakai marker `+ thinking` di chat, dikontrol `MINICODE_SHOW_THINKING` (composer dots; detail lengkap di jurnal); `MINICODE_ACTIVITY_PANEL` kini legacy/deprecate (D3), `MINICODE_MINIMIZE_ACTIVITY` tetap fold; error `pesan actionable` berwarna merah sekali per kegagalan (`takePendingError`); chat kolom tengah (v0.34): `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)` dengan padding kiri/kanan (maks 50% lebar terminal), footer/composer ikut ter-centre, di bawah ambang chat penuh lebar; dihitung di `src/ui/render/chat-column.ts` dan merupakan bagian dari frame `paint()` yang sama (bukan scrollback, I1 tidak berubah). Shortcut pane (`Alt/Ctrl+PgUp/PgDn`, wheel per-pane, `Ctrl+O` detail Live) dihapus. Status/konfirmasi perintah (sync, auth, config, spinner) memakai warna saja tanpa icon; retry tampil sebagai satu micro-toast footer `retry n/total · Ns` dengan TTL 4 dtk dan counter langsung.

Alur composer/menu sejak v0.36–v0.37: `composerWidth()` dan `chatWidth()`
adalah dua helper dari **satu sumber geometri** di `src/ui/render/chat-column.ts`
— `composerWidth()` dipakai painter composer, `composer-wrap.ts`, dan pemetaan
kursor/klik mouse. Cap lebar prompt v0.37 = progresif:
`min(chatCols, 100 + floor(max(0, chatCols-100)/4))` (100→100, 200→125,
300→150, 500→200; menggantikan `min(100, chatWidth())`), prefix `minicode › `
bila ruang isi `w−14 ≥ 24` (`w ≥ 38`), else `› `, lanjutan `· `. Composer
maksimal 2 baris — draft panjang memakai jendela geser tanpa mengubah tinggi
frame maupun posisi transkrip. Dropdown `/` bukan popup `paintRegion`: ia
digambar di dalam frame `paint()` yang sama (satu `stdout.write`, I1), menimpa
baris transkrip bawah sebagai overlay tanpa mengurangi `viewH`, dan klik di area
dropdown memetakan ke item menu; sejak v0.37 dropdown ditutup saat transisi
busy/abort. Lihat kontrak I14/I17/I19/I1 dan entri `## Perubahan v0.37` (yang
meng-override cap/ambang v0.36) di `TERMINAL_CONTRACT.md`.

Sejak v0.43 **baris aktivitas tool live** kembali transien seperti v0.40.0:
ia ikut tail transkrip dan hilang setelah tool selesai. Saat baris live muncul,
`total` bertambah dan sticky-tail menggeser jendela (history boleh naik); saat
ia hilang dan `total` menyusut, jendela tidak bergeser balik — posisi baris
committed tetap, ruang di bawah boleh kosong. Mekanismenya = **ratchet
`scrollBack` per turn** (hanya naik), di-reset pada `turn:started` / prompt baru
/ `/clear`; bukan overlay, bukan `liveRegion`, bukan commit-in-place baris live.
History committed tetap kebal; I1 (satu write/frame) utuh tanpa writer/region
baru. Hanya aspek transiensi dari butir v0.42 "commit-in-place /
never-shrink by id" yang ditimpa (klausa v0.42 lain tetap berlaku). Lihat entri
`## Perubahan v0.43` di `TERMINAL_CONTRACT.md`.

## Alur paste & seleksi (v0.37)

Tiga alur input baru yang menyentuh boundary controller/painter:
`src/ui/input/{ask-line,prompt-engine}.ts` mengaktifkan **bracketed paste**
(`?2004h` masuk / `?2004l` keluar) di TUI, `askLine`/`askSecret`, dan
`src/ui/screens/output-window.ts`. Sequence itu ditulis **di luar frame
`paint()`** — bukan sel grid dan bukan diff per-repaint — sehingga I1 (satu
`write` per frame) tetap utuh; CR dalam paste menjadi newline draft, bukan submit
bertingkat (alasan: paste multi-baris merusak draft). `src/ui/tui/app.ts` memetakan
`Ctrl+A` ke `selectAll` bila composer kosong & dropdown tertutup (pilih seluruh
baris logis transkrip via `src/ui/tui/transcript.ts`), dan tetap `Home` bila ada
draft/menu; `Ctrl+C` meng-finalisasi drag yang masih aktif menjadi seleksi lalu
menyalin via OSC 52. Resize menstabilkan state: auto-scroll dihentikan, drag
dibatalkan, kolom preferensi kursor di-reset, dan anchor gulir di-rebase walau
seleksi aktif; klik pasca-resize memakai geometri baru dari `chat-column.ts`.
Gema prompt user disimpan satu baris logis dan di-wrap sekali selebar kolom chat
di proyektor (bukan lebar terminal penuh — padding centre bisa membuat
double-wrap).

## Modul kunci

- `src/session/verification.ts` + `src/tools/evidence.ts`: identitas invokasi milik aplikasi, intent/receipt yang di-await, observasi eksplisit, idempotency, dan korelasi efek anak — semuanya di jurnal mutasi yang sama.

- `src/ui/render/`: `theme.ts` (getter `c`/`glyphs`, palet level-aware 16/256/truecolor), `width.ts` (kolom), `sanitize.ts` (hanya SGR lewat), `ledger.ts` (status word/glyph/paint + run-marker bersama untuk TUI & linear), `hint.ts` (grammar hint `kunci label` spasi-only), `list.ts` (`listRow` marker `›` + kolom tetap), `notice.ts` (notice sukses/error/info), `markdown.ts`, `markdown-layout.ts` (layout markdown untuk kolom chat terpusat), `markdown-table.ts` (parser pipe-table streaming), `table-grid.ts` (grid budget terminal), `cells.ts` (framebuffer sel grapheme+SGR + diff "tulis-ulang ekor" untuk penulisan inkremental), `composer-wrap.ts` (wrap composer inkremental), `chat-column.ts` (geometri kolom tengah v0.34: `chatCols = floor(cols/2)` bila `cols ≥ 120 && rows ≥ 20`, padding kiri/kanan, di bawah ambang chat penuh; footer/composer mengikuti; sejak v0.36 satu-satunya sumber `composerWidth()`/`chatWidth()` untuk lebar prompt, kursor, dan prefix adaptif — cap v0.37 = `min(chatCols, 100 + floor(max(0, chatCols-100)/4))`, prefix `minicode › ` bila `w−14 ≥ 24`), `agent-progress.ts` (format agregat `✦` progres sub-agent di chat), `tool-label.ts` (resolusi locale OS via `Intl` → label aktivitas tool `› …`, sumber tunggal untuk TUI dan `src/ui/assistant/simple.ts`; narasi/model tetap memakai `/lang`), `highlight.ts diff.ts table.ts wrap.ts money.ts errors.ts`. Modul sidebar lama (`sidebar-layout.ts`, `sidebar.ts`, `sidebar-model.ts`, `activity-format.ts`) dan view `window.ts` tidak lagi dipakai untuk panel samping sejak v0.34; parsing reasoning inkremental tetap dijaga `test/perf-no-quadratic.test.ts`.
- `src/presentation/`: `events.ts` mendefinisikan event presentasi dan registry durability; `adapter.ts` memetakan runtime ke `DomainEvent`; `reducer.ts`/`model.ts` membangun state replayable dan ringkasan turunan; `store.ts` menyimpan referensi konten; `projection.ts` membentuk envelope `minicode.output.v1` dan kategori error machine. `src/session/persistence.ts` dibantu `src/session/db/{schema,runs}.ts` menyimpan log `presentation_events`, `runs`, dan `messages` dengan fidelity `reasoning`/`is_error`; `src/session/rewind.ts` merangkai restore checkpoint + `branchSession` + record rewind agar `/undo` memindahkan percakapan dan workspace bersama. `src/task/store.ts` dibantu `src/task/db/{types,schema}.ts` mengelola `.minicode/tasks.db`. `cli/setup.ts` (delegating bridge presentasi via `cli/bootstrap/presentation-bridge.ts`) memiliki bridge exhaustive `toPresentationEvent()`; renderer TUI/linear/machine memakai keputusan policy via injeksi `PresentationPolicy`.
- `src/policy/`: `context.ts` (estimator sadar-densitas kode/JSON + kalibrasi usage), `context-window.ts` + `context-window-catalog.ts` (resolve window: config → katalog → models.dev → default 128K alias → 32K), `bpe.ts` + `tokenizer-registry.ts` (tokenizer BPE presisi on-demand dari HuggingFace, cache lokal, fallback densitas), `compaction.ts` (kompaksi LLM + mekanikal, anti-drift/anti-thrash, prefer provider sesi), `usage.ts`/`pricing.ts` (estimas biaya + models.dev).
- `src/ui/input/`: `askLine`, `prompt-engine` (grapheme `Intl.Segmenter`, streaming decoder, bracket-paste, mouse X10/SGR press/drag/release + wheel dinormalisasi; selection app-level di TUI). Sejak v0.37 bracketed paste aktif (`?2004h`/`?2004l`, di luar frame I1) di TUI, `askLine`/`askSecret`, dan output-window; `Ctrl+A` = `selectAll` bila composer kosong & dropdown tertutup (else Home); `Ctrl+C` menyalin juga saat drag aktif. Sejak v0.34 tidak ada pane: wheel selalu meng-scroll chat; `PgUp/PgDn` scroll chat, `Shift+PgUp/PgDn` setengah halaman, `Home/End` (prompt kosong) ke top/ekor chat. Shortcut pane lama (`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, `Ctrl+O` detail Live, wheel per-pane) dihapus bersama sidebar — alasannya: tidak ada lagi target visual untuk di-scroll atau dibuka.
- `src/ui/screens/`: view murni `picker/wizard/model-manager/provider-manager/form/dialog/output-window`; `output-window.ts` = jendela readout command ber-scroll di atas chat (v7.18).
- `src/ui/assistant/simple.ts`: printer linier + clipboard OSC52. `turn-status.ts`: garis transient. `approval/prompt.ts`: `promptAsk/promptAskText`.
- `src/daemon/`: hosted-session runtime, discovery, framed IPC/capabilities, replay, approval brokerage, child supervision, dan ordered shutdown; composition melalui `cli/commands/daemon.ts`.
- `src/runtime/`: admission dan execution kernel aplikasi (`dispatch.ts`, `execution-kernel.ts`, `production-execution.ts`) serta recovery (`recovery.ts`).
- Kualitas: `bench/`, `scripts/` (coverage/pack/telemetry/vendor), `experiments/` (adversarial).
