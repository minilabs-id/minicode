# Output Rendering Specification

**Status:** implemented renderer boundary; canonical policy active, with streaming content transport and one ACP compatibility window.
**Tanggal:** 2026-09-25 · **Diperbarui:** 2026-11-22 (v0.37; arsip v0.36/v0.35/v0.34/v0.33, `1aaca14`)  
**Kontrak aktif:** renderer TUI/linear di `src/presentation/` dan `src/ui/`.

## 1. Prinsip boundary

Renderer berubah dari string consumer menjadi consumer dari semantic projection:

```text
PresentationState + ContentStore
        ↓
ProjectionPolicy(mode, viewport, locale)
        ↓
UiPresentationSnapshot / ProjectionNode[]
        ↓
TUI / linear / machine renderer
```

Renderer boleh:

- menghitung layout kolom, wrap, tinggi baris, dan posisi cursor;
- memilih warna, glyph fallback, dan density;
- menangani hover, selection, scroll, popup, dan keyboard;
- memakai `sanitizeAnsi` sebagai defense-in-depth.

Renderer tidak boleh:

- menentukan status dengan `includes("denied")`, regex, atau warna;
- membangun turn summary sendiri;
- menyimpan truth runtime/approval/durasi;
- meng-clip source text berdasarkan pixel/frame yang sudah dirender;
- menentukan bahwa machine consumer boleh membaca human string.

## 2. Inventaris renderer aktual

| Module | Tanggung jawab sekarang | Keterkaitan | Target |
|---|---|---|---|
| `src/ui/tui/transcript.ts` | Streaming content buffer, source map, markdown table, category recap (bukan ledger per-tool), evict, selection | Raw content bus + presentation snapshot/events + policy DI | View adapter; no semantic status parsing |
| `src/ui/tui/app.ts` | Input, viewport, layout, screen ownership, popup lifecycle, clipboard | Controller + painter | Controller/painter boundary unchanged |
| `src/ui/assistant/simple.ts` | Stream sanitizer, answer/tool state, table, copy, stdout/stderr (collapse/`expand` dihapus v0.33) | Presentation events + policy DI + streaming text | Normal/verbose projection writer |
| `src/ui/assistant/turn-status.ts` | Infer active phase dan heartbeat | Policy-derived activity label | Transient view only |
| `src/ui/runtime/screen.ts` | Alternate screen, atomic paint, region | Terminal primitive | Tetap dipertahankan |
| `src/ui/runtime/statusline.ts` | Arbitrasi transient stderr | Transport owner | Tetap, plus writer policy |
| `cli/commands/exec.ts` | Canonical lifecycle JSONL, text delta, versioned summary | Presentation events + text transport | Canonical machine projection |
| `cli/commands/acp.ts` | Canonical lifecycle ACP, sanitized text delta | Presentation events + compatibility fallback | Canonical lifecycle projection |
| `src/ui/approval/prompt.ts` | Human prompt/decision | DI/sink + policy-compatible fallback | Same decision event |
| `src/ui/render/chat-column.ts` | Geometri chat kolom tengah v0.34: `chatCols = floor(cols/2)` bila `cols ≥ 120 && rows ≥ 20`, padding kiri/kanan, footer/composer ter-centre; di bawah ambang chat penuh lebar. Sejak v0.36 satu sumber `composerWidth()`/`chatWidth()`; cap v0.37 = `min(chatCols, 100 + floor(max(0, chatCols-100)/4))` | viewport + policy | Satu sumber geometri kolom (menggantikan `sidebar-layout.ts`) |
| `src/ui/render/agent-progress.ts` | Format agregat `✦` progres sub-agent di chat | child report + tool state | View adapter |
| `src/ui/render/tool-label.ts` | Resolusi locale OS via `Intl` → label aktivitas tool `› …` (id/en), sumber tunggal TUI + linear (`simple.ts`); narasi/model tetap `/lang` | OS locale + view adapter | Label view adapter (v0.35) |
| `src/ui/screens/window.ts` | Jendela/frame view murni untuk popup & picker | props + callback | View murni; controller di `cli/` |

## 3. Kontrak input renderer

Implementasi aktif menggunakan `UiPresentationSnapshot`, `PresentationPolicy` (`src/ui/contract.ts`), dan `ProjectionNode` (`kind: "message" | "turn" | "tool" | "approval" | "reasoning" | "system" | "plan" | "finding" | "result" | "diagnostic"` di `src/presentation/projection.ts`). Snapshot bersifat read-only; resolusi konten lewat `ContentStore` mengembalikan `ContentEntry` beserta penanda retensi (tidak menarik seluruh raw database tanpa batas), dan seluruh waktu tampilan berasal dari parameter/clock terinjeksi agar reducer dan node builder tetap murni.

## 4. Projection policy

| Node/status | Normal | Verbose | Debug | Machine |
|---|---|---|---|---|
| Task running | satu activity/current state | duration + target | event IDs | typed lifecycle |
| Tool completed | receipt singkat | receipt + duration | full metadata | typed completed |
| Tool denied | warning + reason | policy path | raw category redacted | typed denied |
| Reasoning | marker `+ thinking` di chat bila `MINICODE_SHOW_THINKING=1`; detail di jurnal | expanded | raw redacted chunks | structured ref/status |
| Plan | upcoming steps | step status | internal links | typed plan |
| Finding | finding + evidence ringkas | evidence detail | full evidence | typed finding |
| Diagnostic | actionable only | category + next step | trace/counter | typed diagnostic |
| Context compacted | system warning | reason detail | trace | typed event |

Policy tidak boleh mengubah final status. `machine` boleh lebih ringkas secara visual,
tetapi tidak boleh kehilangan terminal state atau category.

## 5. TUI renderer

### Ownership

`TuiApp` tetap memiliki:

- alternate-screen lifecycle;
- keyboard/mouse decoder;
- viewport scroll dan selection;
- popup suspend/resume;
- full-frame paint dan cursor parking.

`TuiApp` tidak lagi menjadi sumber status tool. Ia menerima status dari snapshot/
projection melalui `TuiHost`, dengan fallback deny bila DI tidak tersedia.

### Frame

Frame terdiri dari:

1. chat kolom tengah — `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)`
   dengan padding kiri/kanan (maks 50% terminal); di bawah ambang chat penuh lebar;
2. optional `/` dropdown — sejak v0.36 **overlay di dalam frame yang sama**,
   menimpa baris transkrip bawah dan **tidak mengurangi `viewH`** (bukan region
   terpisah, bukan penambah tinggi frame);
3. composer/prompt atau activity row (ter-centre mengikuti kolom chat), **maksimal
   2 baris** sejak v0.36 — draft panjang memakai jendela geser tanpa menggeser
   transkrip;
4. satu spacer;
5. status bar (ter-centre mengikuti kolom chat).

Semua itu bagian dari **satu `paint()` frame / satu write** (I1), bukan scrollback.
Popup/modal tetap full-screen ter-centre pada `cols` (I20 tidak berubah) dan
memakai `paintRegion()` — kini tidak ada kolom sidebar yang turut dilukis.
**Dropdown `/` adalah pengecualian:** ia bukan popup `paintRegion()`, melainkan
bagian dari frame `paint()` yang sama (I1 ditegaskan v0.36).

**Baris live tool (v0.43) kembali transien seperti v0.40.0:** ia ikut tail dan
hilang saat tool selesai. Munculnya menambah `total` sehingga sticky-tail
menggeser jendela (history boleh naik); saat ia hilang dan `total` menyusut,
jendela tidak bergeser balik — posisi baris committed tetap, ruang di bawah
boleh kosong. Mekanismenya = ratchet `scrollBack` per turn (hanya naik),
di-reset pada `turn:started` / prompt baru / `/clear`. Bukan overlay, bukan
`liveRegion`, bukan commit-in-place; I1 (satu write/frame) utuh tanpa
writer/region baru. History committed tetap kebal; ini hanya menggantikan
aspek transiensi dari klausa v0.42 "commit-in-place / never-shrink by id"
(klausa v0.42 lain tetap berlaku). Lihat entri `## Perubahan v0.43` di
`TERMINAL_CONTRACT.md`.

`screen.ts` tetap satu-satunya alt-screen owner. `paintRegion()` hanya untuk popup;
popup tidak boleh membuat listener stdin kedua.

### TUI semantic projection

- Prompt percakapan: satu entry user dengan source range. Input command slash tetap
  tersedia di composer history, tetapi tidak ditambahkan sebagai pesan transkrip.
- Assistant stream: live buffer yang di-cap; final node dipisah dari stream.
- Whitespace jawaban dirapikan hanya pada layer tampilan: baris kosong tepi dibuang,
  jeda berulang di luar code fence dirapatkan, isi fenced code tetap literal.
- Activity: started → running → terminal, dengan status word (glyph status dihapus;
  bukan lagi penanda `✓`/`✗` — lihat `OUTPUT_UX_RULES.md` §3).
- Tool child: default dikelompokkan ke parent `delegate_task`; child detail tersedia
  pada verbose/debug.
- Chat v0.34: narration + category recap (mis. `3 command · 2 read · 5 subagent`) +
  baris tool, agregat `✦`, finding, marker `+ thinking`, dan final answer. Sidebar
  v0.33 yang menampung detail per-tool sudah dihapus; label `Tool:`, `/expand`, dan
  collapsed buffer tetap DIHAPUS.
- Finding: `finding.detected` (`[EVALUATE]` / temuan sementara child) dicatat ke `/logs` di TUI (bukan ditumpahkan ke chat utama) dan tetap disimpan durable di SQLite serta dikirim pada jalur machine/ACP; jalur linear (`simple.ts`) juga tidak menumpahkan baris `[EVALUATE]` mentah ke output teks.
- Context compaction: system entry, tidak menghapus history.
- Summary: system node dari canonical turn summary, bukan hasil hitung ulang widget.
- Error: node dengan category/cause/hint; tidak hanya string merah.
- Pilihan provider/model dan status selesai dari popup pengelolaan tidak diarsipkan
  ke transkrip; state aktif dibaca dari footer/manager saat ini. Error tetap terlihat.

### Selection dan clipboard

Selection adalah view concern, tetapi sumbernya adalah `SourceRef` semantic:

- anchor/focus menyimpan source ID + logical offset;
- row visual menyimpan source range + display columns;
- wrap, CJK/emoji, SGR, table border, dan evict diuji;
- click prompt hanya memindahkan cursor;
- `Ctrl+C` copy hanya jika selection valid; tanpa selection no-op;
- `Esc` clear selection dulu, lalu abort/batal;
- OSC52 menerima plain sanitized payload dan failure state eksplisit.

Seleksi dan navigasi kini hanya mencakup chat (v0.34, tidak ada pane): wheel mouse
menggulir chat; `PgUp/PgDn` satu halaman, `Shift+PgUp/PgDn` setengah halaman;
`Home`/`End` (prompt kosong) ke top/ekor chat. Shortcut pane lama
(`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, `Ctrl+O` modal Live, wheel per-pane) dihapus.

Selection tidak boleh menyalin terminal control sequence atau table padding. Terminal
native selection bukan acceptance contract karena mouse tracking aktif.

## 5b. Rekap footer & label aktivitas tool (v0.35)

Rekap tool adalah **baris committed statis**, bukan state live: footer tiap
narasi mengikuti `tool → narasi → rekap(tool sebelum narasi)` dengan format
`2 command · 118 read · 1 other` (sejak v0.41 tanpa prefix simbol). Rekap
**akhir turn** kumulatif untuk semua
tool dalam turn, bukan potongan segmen yang di-reset. Klausa lama — rekap dua
baris saat live, `flushActivityFold` net-nol, `liveSummaryRows()` mengikuti
ekor, dan jeda antar narasi sebagai baris melayang — adalah arsip v0.33/v7.x
yang ditimpa v0.35 (lihat `TERMINAL_CONTRACT.md`, aturan presedensi).

Label aktivitas `› …` diambil dari locale OS lewat `Intl` (id/en) dan dipakai
di **semua** renderer: TUI, linear/one-shot/`exec` (`simple.ts`), dan ACP.
Narasi/progres/jawaban model TETAP memakai bahasa user (`/lang`). Ini
pengecualian sempit dari prioritas i18n lama: khusus label `› …`, OS locale
yang menang agar kosakata tool identik lintas permukaan. Resolusi terpusat di
`src/ui/render/tool-label.ts`.

## 5c. Composer & dropdown overlay (v0.43+)

Composer memakai bingkai **kotak tipis bersudut lengkung** (`╭─…─╮` / `│ … │` /
`╰─…─╯`, atau `+-+`/`|` pada `MINICODE_ASCII=1`) dengan tinggi isi **dinamis 1–2
baris** (default 1 baris, otomatis 2 baris bila teks > 1 baris). Draft panjang
menggulir lewat jendela geser (`↑`/`↓` atau wheel, transkrip di atas tetap
utuh):

```text
┌ transkrip (viewH baris, margin simetris 3+3 = chatCols - 6) ─┐
│ … baris lama …                                               │
│ 2 command · 118 read · 1 other                               │
├── composer (kotak tipis 1–2 baris isi, tanpa prefix) ────────┤
╭──────────────────────────────────────────────────────────────╮
│ baris draft pertama yang panjang …                           │
│ lanjutan draft baris kedua ← kursor                          │
╰──────────────────────────────────────────────────────────────╯
│ ✦ 00.00.00 Discuss  model  cwd … context  Auto ●            │
└──────────────────────────────────────────────────────────────┘
```

Lebar isi chat & composer memakai margin simetris frame (`contentCols =
chatCols - 6`), kotak composer selebar `composerBoxWidth()` (area teks
`composerBoxWidth() - 4`), tanpa prefix `minicode ›` di dalam composer; gema
prompt di transkrip tetap memakai `minicode › ` dan di-wrap **sekali** selebar
`contentCols`. Tail live tool pada TUI memakai kuota adaptif
`max(3, floor(viewH * 0.5))` (v0.51).

Saat dropdown `/` atau `@mention` terbuka, menu **menimpa baris transkrip bawah**
di dalam frame yang sama (overlay, `viewH` tidak berubah) — bukan region terpisah:

```text
│ … baris transkrip atas tetap tampil …                        │
│ › /mo  → /model        ← dropdown menimpa 2 baris bawah      │
│ › /mod → /mode                                              │
╭──────────────────────────────────────────────────────────────╮
│ /mo                                                          │
╰──────────────────────────────────────────────────────────────╯
│ ✦ 00.00.00 Discuss  model  cwd … context  Auto ●            │
```

Klik mouse di area dropdown memilih item menu, bukan seleksi transkrip. Tidak
ada `paintRegion()`/`write` kedua — perubahan seleksi cukup lewat diff sel I1,
dan sequence bracketed paste `?2004h`/`?2004l` (v0.37) juga ditulis di luar
frame. Dropdown ditutup saat transisi busy/abort (v0.37). Lihat
`TERMINAL_CONTRACT.md` entri `## Perubahan v0.37` (meng-override cap/ambang
v0.36) dan I1/I14/I17/I19.

## 6. Linear renderer

Linear renderer menerima `ProjectionNode[]`/snapshot yang sama:

- stdout: permanent output dan answer/result;
- stderr: activity, reasoning (verbose), warning, error;
- non-TTY: `stripSgr`, no cursor control, no alternate screen;
- TTY: category recap per turn (bukan ledger per-tool); parallel child group tetap dikelompokkan;
- markdown table: semantic table hanya di TTY; non-TTY mempertahankan source sanitized;
- copy buffer: isi yang benar-benar terlihat, dengan cap dan marker.

- v0.35: baris rekap ditulis sebagai baris committed statis (footer tiap
  narasi; rekap akhir turn kumulatif); sejak v0.41 tanpa prefix simbol `└`.
  Label `› …` memakai locale OS via
  `tool-label.ts` — narasi/jawaban tetap memakai `/lang`.

`simple.ts` tidak lagi menentukan status dari raw result. Ia menerima activity
snapshot/event canonical, lalu hanya memilih glyph, stream, dan disclosure level.

## 7. Machine renderers

### Exec

Exec tidak memakai human renderer. Mapper canonical:

- canonical event → JSON object;
- terminal summary → object `type:summary`;
- scrub sebelum serialize/write;
- setup failure → summary `ok:false` pada stdout + human error stderr;
- tidak ada `console.log` dari builtin selama machine mode.

### ACP

ACP juga tidak mengurai terminal text. Lifecycle projection menggunakan event
canonical, sedangkan `text` delta tetap transport-compatible. Jika lifecycle
subscription tidak tersedia dalam compatibility window, hanya `tool.started`
diemit sebagai `type:"tool"` legacy; consumer harus menandainya sebagai
fallback dan tidak boleh menyusun status terminal dari raw text.

## 8. Diagnostics dan direct writes

Direct write bukan otomatis salah; ia harus diklasifikasi:

| Writer | Kategori | Route target |
|---|---|---|
| `TuiApp`/screen | TUI frame | stdout owner screen |
| `simple` permanent | human | stdout |
| `turn-status`/spinner | transient | statusline owner |
| approval/askLine | human input | prompt/overlay owner |
| CLI setup/recovery/verify | diagnostic | stderr atau transcript |
| exec/ACP | machine | protocol sink |
| debug bus | debug | stderr/trace |

Writer baru harus mendaftarkan category dan owner. `statusline.ts` tetap menjadi
arbitrator untuk transient, tetapi bukan pengganti semantic routing.

## 9. Geometry, text, dan fallback

- `displayWidth()` menghitung kolom terminal per grapheme dengan
  `Intl.Segmenter("und", { granularity: "grapheme" })`. Karakter CJK/fullwidth
  dihitung dua kolom; combining marks tidak menambah kolom. Cluster emoji yang
  ditampilkan sebagai emoji (Emoji_Presentation/VS16), skin-tone, ZWJ, regional
  indicator, dan keycap dihitung dua kolom sebagai satu unit. Kebijakan ini
  mengikuti perilaku terminal umum; MiniCode tidak mengukur lebar glyph per
  terminal, sehingga font/terminal yang menyimpang dapat tetap berbeda.
- Wrapping, truncation/chunking, transcript selection, kursor prompt, dan
  geometri frame memakai helper lebar bersama. `truncateToWidth()` dan
  `chunkByWidth()` tidak memecah grapheme.
- Sanitasi control bytes dilakukan sebelum output; SGR boleh hanya bila color gate.
- Resize dibaca saat paint, bukan saat event.
- `NO_COLOR`/legacy Windows memakai glyph ASCII atau status word.
- Narrow terminal memakai truncation/wrap yang menjaga path/target penting.
- Chat kolom tengah: `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)` dengan
  padding kiri/kanan (maks 50% terminal); di bawah ambang chat penuh lebar.
  Footer/composer ter-centre mengikuti kolom; popup/modal tetap full-screen
  ter-centre pada `cols` (I20). Tidak ada separator/gap pane karena sidebar dihapus.
- TTY table boleh aligned; machine/non-TTY tidak boleh berubah makna.
- Copy/paste tidak bergantung pada warna.

## 10. Visual system dan accessibility

`src/ui/render/theme.ts` menyediakan token semantik (`success`, `error`,
`warning`, `info`, `accent`, `muted`, `faint`) dengan getter runtime. Token
warna hanya menegaskan status dan hierarki; status penting juga memakai kata
atau glyph sehingga tetap dapat dibaca pada `NO_COLOR`/mono. Fallback ASCII
dikendalikan oleh `MINICODE_ASCII` dan capability UTF-8 Windows.

Interaksi tetap keyboard-first: PgUp/PgDn dan Home/End untuk transkrip, Esc
untuk membatalkan/menutup selection, Ctrl+D untuk keluar, dan popup menahan
fokus sampai ditutup. Wheel mouse menggulir chat (v0.34 tidak ada pane);
`PgUp/PgDn` menggulir satu halaman, `Shift+PgUp/PgDn` setengah halaman,
`Home`/`End` (prompt kosong) ke top/ekor chat. Shortcut pane lama
(`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, `Ctrl+O` modal Live) dihapus. Tidak ada mode
screen-reader terpisah karena kontrak
fullscreen terminal dibekukan. Navigasi keyboard dan jalur mono memiliki test;
screen-reader announcement, kontras fisik, dan manual assistive-technology UAT
belum diverifikasi. Tampilan antar terminal tetap dapat berbeda.

## 11. Parity matrix

| Semantic | TUI | Linear | Exec | ACP |
|---|---|---|---|---|
| tool completed | ledger success | ledger success | `tool.completed` | `tool.completed` |
| tool denied | deny glyph/word | warning + reason | `tool.denied` | `tool.denied` |
| turn cancelled | stopped/abort state | stopped/error | `turn.cancelled` + summary | `turn.cancelled`/error |
| file receipt | activity/source | receipt line | typed receipt | typed receipt |
| context compacted | system entry | warning | typed system event | typed system event |
| finding detected | `/logs` (TUI) / tidak di chat linear | `/logs` (TUI) | `finding.detected` | `finding.detected` |
| duration | pinned/summary | suffix | field | field |
| parent/child | grouped | grouped | IDs/link | IDs/link |

Parity diuji pada semantic object sebelum snapshot string. Test output tetap diperlukan
untuk regressions visual dan protocol.

## 12. Migration seams

1. `PresentationAdapter` dapat tetap emit raw-compatible events.
2. `ProjectionBridge` aktif untuk semua surface; flag `MINICODE_PRESENTATION_V2` dihapus di Phase 8.
3. TUI/linear dapat membandingkan canonical projection dengan legacy output pada test.
4. Exec/ACP memakai canonical projection lebih dulu karena machine parity paling mudah
   diukur.
5. Raw EventBus tetap dipakai untuk streaming content, trace, dan sebagian
   lifecycle turn/execution yang dibaca TUI (`src/ui/tui/transcript.ts`,
   `src/ui/tui/app.ts`); keputusan user-facing tetap lewat semantic
   projection/policy. Klaim lama "raw semantic subscriptions dihapus dari TUI"
   tidak akurat: TUI masih melanggan `turn:*`/`execution:*`/`provider:extension`
   untuk transcript dan status.

## 13. Definition of done renderer

- Tidak ada renderer yang meng-status-kan teks.
- TUI/linear/exec/ACP menghasilkan semantic fields yang sama.
- Sanitasi, width, lifecycle, machine stream, dan clipboard invariants tetap hijau.
- Tidak ada direct write baru yang tidak terkategori.
- Legacy path removal tidak mengubah exit code atau terminal contract tanpa update
  `docs/TERMINAL_CONTRACT.md` dan peta test.
