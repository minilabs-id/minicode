# Output UX Rules

**Status:** contract grammar untuk normal/verbose/debug/machine output  
**Tanggal:** 2026-09-25 · **Diperbarui:** 2026-11-22 (v0.35; arsip 2026-11-21 v0.33, `1aaca14`)  
**Kontrak aktif:** proyeksi output di `src/presentation/projection.ts` dan formatter di `src/ui/render/`.

## 1. North star

Output harus membuat tiga pertanyaan user mudah dijawab:

1. Apa yang sedang dikerjakan?
2. Apa yang sudah terjadi dan bukti apa yang tersedia?
3. Apa yang harus saya lakukan berikutnya?

Output bukan tempat menaruh seluruh kompleksitas internal. Runtime boleh berkembang,
tetapi menambah kompleksitas tidak boleh otomatis menambah noise, warna, atau dump.

## 2. Grammar blok

Urutan default:

```text
USER INTENT
    ↓
TASK
    ↓
PROGRESS
    ↓
ACTIVITY / EVIDENCE
    ↓
FINDINGS
    ↓
PLAN
    ↓
RESULT
```

Tidak semua task membutuhkan semua section. Short task boleh:

```text
Updated src/router.ts
Tests passed

Done.
```

Task audit boleh:

```text
AUDIT
──────────────
Workspace
Progress
Findings
Plan
Result
```

### Section

```text
AUDIT
────────────────────
```

### Activity

```text
Analyzed 18 files
```

### Active operation

```text
› Analyzing source files…
```

### Warning

```text
⚠ Dependencies are not installed
  Run the project install command, then retry.
```

### Error

```text
Build failed
  TypeScript compilation failed in src/app.ts.
  → Fix the reported errors and retry.
```

### Finding

```text
⚠ Missing dependency installation

  package.json exists, but node_modules/ is absent.
```

Sejak v0.34 temuan tampil di badan chat (TUI) dan sebagai entri transkrip tersendiri
pada jalur linear — klaim lama "Activity log sidebar" sudah dicabut bersama sidebar.

### Plan

```text
PLAN
────────────────────
01  Install dependencies
02  Run tests
03  Review failing modules
```

Plan hanya future work. “Read file”, “run grep”, dan “think” adalah activity, bukan plan.

### Completion

```text
Audit complete · 18 files · 42s
```

## 2b. Chat kolom tengah (v0.34 — menggantikan split sidebar v0.33)

Sidebar kanan DIHAPUS total. Chat berisi narration + category recap (mis.
`3 command · 2 read · 5 subagent`) + baris tool, agregat `✦`, marker
`+ thinking`, dan jawaban akhir (catatan mentah `finding.detected` / `[EVALUATE]`
masuk `/logs`, bukan chat utama). Label `Tool:`, `/expand`, dan collapsed
buffer tetap DIHAPUS.

Chat adalah kolom tengah: `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)`
dengan padding kiri/kanan (maks 50% terminal), footer/composer ikut ter-centre;
di bawah ambang chat memakai lebar penuh. Popup/modal tetap full-screen ter-centre
pada `cols` (I20 tidak berubah). Semuanya dilukis dalam **satu frame `paint()` /
satu write** (I1), bukan scrollback.

Kunci: wheel mouse menggulir chat (tidak ada pane); `PgUp/PgDn` satu halaman,
`Shift+PgUp/PgDn` setengah halaman, `Home`/`End` (prompt kosong) ke top/ekor chat.
Shortcut pane lama (`Alt+PgUp/PgDn`, `Ctrl+PgUp/PgDn`, `Ctrl+O` modal Live, wheel
per-pane) dihapus. Reasoning memakai marker `+ thinking` di chat bila diaktifkan
(`MINICODE_SHOW_THINKING=1`), dengan marker trim (`… N older items trimmed`) pada
history dan detail lengkap di jurnal — bukan pane Thinking.

Retry hanya satu micro-toast footer `retry n/total · Ns` dengan TTL 4 detik dan counter
live — bukan baris ledger, bukan durasi backoff, dan bukan envelope machine.

**v0.35 — rekap footer & label aktivitas.** Rekap tool adalah **baris committed
statis**, bukan state live: footer tiap narasi
`tool → narasi → rekap(tool sebelum narasi)`, format
`2 command · 118 read · 1 other` (sejak v0.41 tanpa prefix simbol). Rekap akhir
turn kumulatif seluruh tool selama turn disertai lama turn berjalan
(`2 command · 118 read · 14s` atau `1m 05s` dengan spasi antar unit, dan tetap
menampilkan durasi saja bila turn tanpa tool). Klausa lama (rekap dua baris saat live, `flushActivityFold`
net-nol, `liveSummaryRows` mengikuti ekor, jeda antar narasi melayang) adalah
arsip v0.33/v7.x yang ditimpa v0.35. Label aktivitas `› …` memakai **locale OS**
lewat `Intl` (id/en) di semua permukaan (TUI, one-shot/`exec`, ACP via
`simple.ts`; resolver `src/ui/render/tool-label.ts`), sementara narasi/jawaban
model tetap memakai bahasa user (`/lang`).

**v0.36 — composer & dropdown overlay.** Composer tinggi **maksimal 2 baris**
(dulu hingga 5): draft panjang memakai jendela geser, tanpa menambah baris di
frame dan tanpa menggeser transkrip; satu baris kosong pemisah footer tetap.
Lebar prompt/kursor = `composerWidth() = min(100, chatWidth())` (bukan
`chatWidth()` penuh), prefix `minicode › ` bila ≥60 kolom else `› `, lanjutan
`· `. Dropdown `/` digambar **di dalam frame `paint()` yang sama** (satu
`stdout.write`, I1) sebagai overlay yang menimpa baris transkrip bawah, **tanpa
mengurangi `viewH`** dan tanpa `paintRegion()` terpisah (menghindari dua write &
flicker saat steer). Klik di area dropdown memilih item menu, bukan seleksi
transkrip. Klausa lama (composer 5 baris, dropdown memotong `viewH`, kursor
mengikuti `chatWidth()` penuh) adalah arsip yang ditimpa v0.36.

**v0.37 — bracketed paste, select-all, resize & geometri progresif.** TUI,
`askLine`/`askSecret`, dan output-window memakai `?2004h`/`?2004l` di luar frame
(I1 tetap satu `write` per frame); CR dalam paste = newline draft, bukan submit
bertingkat. `Ctrl+A` = `selectAll` seluruh baris logis transkrip bila composer
kosong & dropdown tertutup (Home bila ada draft/menu); `Ctrl+C` menyalin juga
saat drag aktif. Resize menghentikan auto-scroll, membatalkan drag, mereset
kolom kursor, dan merebase anchor gulir walau seleksi aktif; dropdown ditutup
saat busy/abort; klik pasca-resize memakai geometri baru. Gema prompt disimpan
satu baris logis dan di-wrap sekali selebar kolom chat. Cap prompt progresif
`min(chatCols, 100 + floor(max(0, chatCols-100)/4))` dengan prefix `minicode › `
bila `w−14 ≥ 24`, else `› `; composer 2 baris & dropdown overlay tetap.

**v0.43 — baris live tool transien, ratchet `scrollBack` per turn (amandemen
v0.42).** Yang tidak boleh hilang adalah **history chat yang sudah committed**
(tetap berlaku sejak v0.42). Baris aktivitas tool **live kembali transien**
seperti v0.40.0: ikut tail, hilang setelah tool selesai. Saat baris live muncul,
`total` bertambah dan sticky-tail menggeser jendela — history boleh naik. Saat
baris live hilang dan `total` menyusut, jendela **tidak bergeser balik**: posisi
baris committed di layar tetap, ruang di bawah boleh kosong. Mekanismenya =
**ratchet `scrollBack` per turn** (hanya naik, tidak turun), di-reset pada
`turn:started` / prompt baru / `/clear` — bukan overlay, bukan `liveRegion`,
bukan commit-in-place baris live. I1 (satu write/frame) utuh; tidak ada
writer/region baru. Butir v0.42 "commit-in-place / never-shrink by id"
**ditimpa hanya pada aspek transiensi baris live**; klausa v0.42 lain (teks
gagal ringkas, rekap tanpa `└`) tetap berlaku. Arsip tidak dihapus/direnomor.

## 3. Status vocabulary

Sejak v0.17.0 ikon status (`✓`/`✗`/`⊘`/`◌`) DIHAPUS — `glyphs.check/cross/denied/circle`
mengembalikan `""` (`src/ui/render/theme.ts`) karena bising dan tak konsisten antar
terminal. Status disampaikan lewat KATA + struktur teks; warna dan glyph hanya aksen
hierarki, karena mode mono (`MINICODE_COLOR=0`) dan `NO_COLOR` tetap harus terbaca.
Operasi aktif memakai chevron `›` (lihat `TERMINAL_CONTRACT.md` invariant #7). Contoh di
dokumen ini sudah mengikuti format tanpa ikon status.

| Status | Glyph | ASCII fallback | Teks default | Arti |
|---|---|---|---|---|
| active | `›` | `>` | `running` atau `active` | operasi masih berjalan |
| completed | — | — | `completed` | sukses terminal |
| warning | `⚠` | `!` | `warning` | perlu perhatian, belum terminal failure |
| failed | — | — | `failed` | operasi/turn gagal |
| denied | — | — | `denied` | policy/permission menolak |
| cancelled | — | — | `cancelled` | dibatalkan user/system |
| interrupted | — | — | `interrupted` | proses berhenti sebelum terminal |
| retrying | `↻` | `~` | `retry n/total · Ns` | recovery sedang berjalan (toast footer 4 dtk) |
| transition | `→` | `->` | `next` | tindakan berikutnya |
| info | `ℹ` | `i` | `info` | informasi non-actionable |

Glyph tidak pernah menjadi satu-satunya makna. Kolom ASCII fallback dipakai saat
`MINICODE_ASCII=1`, `NO_COLOR`, atau Windows legacy — teks default tetap menjadi
pembawa makna utama. Warna hanya membantu hierarki, bukan encode status.

## 4. Progressive disclosure

### Normal

Tampilkan:

- task/intent aktif;
- progress yang bermakna;
- important finding dan result;
- actionable error;
- receipt singkat untuk efek yang penting;
- cancellation/partial state.

Sembunyikan:

- raw args lengkap;
- internal event/tool IDs;
- provider implementation details;
- raw tool output;
- repetitive file lists;
- token counters tanpa relasi dengan task;
- event trace.

### Verbose

Tambahkan:

- tool name, target, duration;
- important file/command details;
- reasoning jika user meminta;
- retry chain;
- test/result detail;
- recovery strategy dan next action.

### Debug

Tambahkan:

- event ID/correlation/parent;
- timestamps dan transition;
- redacted payload;
- anomaly counters;
- checkpoint/journal references;
- renderer/source trace.

### Machine

Tidak bergantung pada human text. Memberikan typed event, final summary, dan correlation
fields. Tidak mengirim raw kernel shape sebagai public contract.

## 5. Tool dan parallel operations

> Contoh ledger di bawah ini berlaku untuk TUI maupun linear sejak v0.34 (sidebar
> sudah dihapus): detail per-tool, agregat `✦`, dan finding kembali dicetak di chat
> bersama narration, category recap, dan jawaban akhir. Klaim lama "detail pindah ke
> Activity log sidebar" sudah dicabut.

Activity menjelaskan apa yang sedang dikerjakan, bukan internal implementation dump.
Satu baris ledger default:

```text
› read_file src/config.ts
```

Completion:

```text
read_file src/config.ts · completed
```

Failure:

```text
read_file src/config.ts · failed
  File does not exist.
```

Denial:

```text
bash · denied
  Permission denied by mode=plan.
```

Receipt:

```text
write_file src/router.ts · 1 file · 34ms
```

### Parallel

Gaya collapsed/aggregated lama (blok `+ explore · N tools · N ok` dan buffer yang bisa
dibuka) DIHAPUS. Ringkasan kini satu baris category recap; detail per-tool kembali ke
chat sejak v0.34 (v0.33 memindahkannya ke Activity log sidebar — dicabut).

Jangan interleave raw output. Kelompokkan:

```text
› Analyzing 11 source files…

  app.ts
  config.ts
  index.ts
  router.ts
  …
Source analysis complete · 11 files
```

Untuk batch besar:

```text
Analyzed 11 files
```

### Rekap tool & durasi turn (v0.35 + amandemen durasi turn)

Satu baris rekap per narasi, committed dan statis: `tool → narasi → rekap(tool
sebelum narasi)`. Contoh `2 command · 118 read · 1 other` (sejak v0.41 tanpa
prefix simbol). Rekap akhir turn = kumulatif semua tool turn ditambah durasi
turn berjalan (`2 command · 118 read · 14s` atau `1m 05s` dengan spasi antar
menit dan detik); turn tanpa tool tetap menuliskan durasinya (`14s`). Label
`› …` pada baris tool memakai locale OS (`Intl`, id/en), berbeda dari narasi
yang memakai `/lang`.

### Retry

Retry adalah call baru dengan link `supersedes`, bukan attempt number buatan. Sejak
v0.33 satu-satunya representasi normal adalah satu micro-toast footer:
`retry n/total · Ns` — TTL 4 detik, counter diperbarui live di tempat. Tidak ada baris
ledger baru dan tidak ada angka backoff yang ditampilkan; event sumber
`minicode:retry` bersifat UI-transient (bukan envelope machine). Normal tidak
menampilkan tool ID; debug dapat menampilkan `correlationId`.

## 6. Progress

Progress harus menunjukkan perubahan state, bukan heartbeat spam:

```text
Processing…
Processing…
Processing…
```

Dihindari. Gunakan:

```text
› Reading 18 files…
› Running tests…
› Applying migration…
```

Untuk long-running tool:

```text
› Running integration tests… (2m 14s)
```

Progress yang tidak berubah setelah stall dapat menjadi warning/timeout sesuai policy;
renderer tidak mengarang fake progress. TUI memakai sparkle/dots pada composer/status,
linear memakai transient heartbeat, dan machine memakai duration/status field.

## 7. Findings, activity, dan evidence

Activity:

```text
Read src/app.ts · completed
```

Finding:

```text
⚠ Router initialization has no error boundary
```

Evidence:

```text
  src/app.ts:42
```

Recommendation:

```text
→ Add explicit initialization failure handling
```

Keempat konsep tersebut adalah node semantic yang berbeda. Node boleh ditampilkan
bersama, tetapi tidak boleh digabung menjadi satu string generik.

## 8. Error UX

Setiap error attempt menjawab:

- apa yang terjadi?
- apa yang sedang dilakukan?
- mengapa gagal?
- apa next step?
- apakah user perlu bertindak?

Kategori minimum:

- `WARNING`: perlu perhatian, operasi masih dapat berjalan.
- `ERROR`: operasi gagal, tindakan atau retry dapat membantu.
- `DENIED`: policy sengaja memblokir tindakan.
- `CANCELLED`: user/system sengaja menghentikan operasi.
- `TIMEOUT`: deadline terlampaui.
- `PARTIAL`: sebagian pekerjaan selesai, belum semuanya.
- `RECOVERED`: fallback/retry berhasil.
- `UNAVAILABLE`: informasi/backend tidak dapat dijangkau.

Error example:

```text
Provider request failed
  Rate limit reached while running the model.
  → Retry after the provider cooldown, or choose another provider.
```

Jangan mencetak objek JSON/error provider sebagai pesan utama. Letakkan detail mentah
yang sudah disanitasi di verbose/debug dan pertahankan kategori/next action yang stabil.

## 9. Cancellation, timeout, partial, recovery

Cancellation harus punya state, bukan hanya hilang:

```text
↻ Cancelling…

Task cancelled
```

Timeout:

```text
Operation timed out after 15m
  → Retry with a smaller scope or increase the timeout.
```

Partial:

```text
⚠ Completed 3 of 5 files
  Two files failed; review the errors before retrying.
```

Recovery:

```text
↻ Provider unavailable; retrying with fallback…
Recovered using fallback provider.
```

TUI harus mencegah live stream/foreign painter menimpa state terminal. Linear harus
flush buffer secara deterministic once pada settle/abort. Machine harus mengirim
terminal task event dan summary tepat satu kali.

## 10. Terminal geometry

- Target lebar 80, 100, dan 120+ columns.
- Chat kolom tengah: `cols ≥ 120 && rows ≥ 20` → `chatCols = floor(cols/2)` dengan
  padding kiri/kanan (maks 50% terminal), footer/composer ter-centre; di bawah
  ambang chat penuh lebar. Popup/modal tetap full-screen ter-centre pada `cols`
  (I20). Tidak ada sidebar/pane sejak v0.34.
- Semua ukuran memakai display columns; CJK/emoji dua kolom.
- Composer maksimal 2 baris (v0.36, tetap): lebar prompt/kursor v0.37 =
  `composerWidth() = min(chatCols, 100 + floor(max(0, chatCols-100)/4))`, prefix
  `minicode › ` bila `w−14 ≥ 24` / `› `, lanjutan `· `; dropdown `/` = overlay
  dalam frame yang sama, tidak mengurangi `viewH`, tanpa region terpisah. Klik
  area dropdown = item menu; dropdown ditutup saat busy/abort.
- Long path/command wrap atau truncate dengan marker, tidak pernah dipotong tanpa
  petunjuk.
- Resize terjadi saat paint; cursor selalu diparkir di input/overlay aktif.
- TUI frame selalu memiliki tinggi valid; terminal kecil menolak layar interaktif
  secara fail-closed, bukan menampilkan frame setengah.
- TTY dapat memakai aligned table; non-TTY dan machine mempertahankan source sanitized.
- Border/padding adalah chrome, bukan evidence/data.

## 11. Windows, PowerShell, dan ANSI

- ANSI/Cursor control tidak diasumsikan selalu tersedia.
- `NO_COLOR` dan pipe/redirect menang atas `TERM`/`COLORTERM`.
- Windows legacy memakai ASCII glyph dan no-color-friendly words.
- ConPTY limitation harus diuji atau di-skip transparan; tidak boleh dianggap hijau
  palsu.
- CRLF dan paste bracketed harus aman.
- Ctrl+C/EOF harus menghasilkan state yang koheren dan mengembalikan raw mode.
- Alternate-screen harus paired pada quit, error, fatal signal, dan child release.

## 12. Copy/paste dan selection

Output harus berguna bila disalin ke issue, log, chat, atau docs:

- status tidak bergantung pada warna saja;
- status word dan path tetap terlihat;
- source text, bukan terminal escape, masuk ke clipboard;
- app-level selection dipetakan ke source melalui wrap/CJK/SGR/table;
- prompt/popup/footer tidak selectable kecuali dirancang eksplisit;
- `Ctrl+C` menyalin selection jika ada, tanpa selection no-op — sejak v0.37
  juga saat drag masih aktif (drag di-finalisasi dulu, bukan no-op/abort);
- `Esc` membersihkan selection sebelum behavior cancel apa pun;
- kegagalan OSC52 terlihat dan `/copy` tetap menjadi fallback;
- v0.37: `Ctrl+A` = select-all seluruh baris logis transkrip bila composer
  kosong & dropdown tertutup (Home bila ada draft/menu); paste multi-baris
  memakai bracketed paste `?2004h`/`?2004l` di luar frame, CR bukan submit;
  resize merebase anchor walau seleksi aktif.

Native terminal drag selection is not promised while the app owns mouse tracking.

## 13. Accessibility dan i18n

- Semua user-visible UI text memakai dictionary `t()` pada TUI/linear surface yang
  aktif.
- UI tidak bergantung pada warna atau glyph saja.
- A11y live-region/terminal bell harus opsional dan tidak mencemari machine stdout.
- Prioritas locale: session command > environment > persisted state > OS locale
  > English fallback.
- Translation key yang hilang fallback ke English, bukan mencetak key secara diam-diam.
- **Pengecualian v0.35 (label aktivitas tool):** prioritas di atas TETAP berlaku
  untuk label UI dan untuk narasi/jawaban model (`/lang`), tetapi khusus prefix
  aktivitas tool `› …` **OS locale yang menang** (`Intl`, id/en) di semua
  permukaan — TUI, one-shot/`exec`, dan ACP via `simple.ts` — demi konsistensi
  kosakata tool lintas permukaan. Dua bahasa ini sengaja dibedakan: `/lang`
  mengubah narasi, locale OS mengubah label `› …`.

## 14. Anti-patterns

- `if (text.includes("denied"))` menentukan status.
- Raw tool stdout langsung menjadi normal UI.
- Normal mode == debug mode.
- Semua detail disembunyikan sampai final dump.
- Model narration dipakai menggantikan runtime state.
- Renderer menyimpan state kedua yang berbeda dengan reducer.
- `eventSeq` dianggap causality.
- Context compaction menghapus presentation history.
- Selection menyalin frame bytes/ANSI/padding.
- Direct stdout/stderr write baru tanpa owner dan category.

## 15. UX acceptance checklist

- [ ] User dapat melihat task, status, dan next action tanpa membaca debug.
- [ ] Tool denied/failed/cancelled/interrupted berbeda secara tekstual.
- [ ] Parallel work aggregated, tidak raw interleaved.
- [ ] Progress menunjukkan perubahan state, bukan spam.
- [ ] Plan bukan replay activity.
- [ ] Finding dan evidence terpisah secara semantic.
- [ ] Copy/paste tetap berguna tanpa color.
- [ ] 80-column/narrow/Unicode/resize/Windows fallback teruji.
- [ ] Chat kolom tengah: `cols ≥ 120`/`rows ≥ 20` → `chatCols = floor(cols/2)` (padding, maks 50%), penuh lebar di bawah ambang; satu frame dengan popup ter-centre.
- [ ] Chat memuat recap + narration + answer + baris tool/`✦`/finding/`+ thinking`; tanpa `Tool:`, `/expand`, atau collapsed buffer.
- [ ] Finding tampil di chat (TUI) / transkrip (linear) dan tetap typed di machine.
- [ ] Retry hanya satu micro-toast footer 4 dtk, bukan baris ledger atau envelope machine.
- [ ] (v0.35, amendemen v0.41) Rekap = baris committed statis di footer tiap narasi, sejak v0.41 tanpa prefix simbol; rekap akhir turn kumulatif; label `› …` memakai locale OS, narasi memakai `/lang`.
- [ ] (v0.36) Composer maks 2 baris (jendela geser, transkrip tidak bergeser); lebar `composerWidth() = min(100, chatWidth())`; dropdown `/` overlay dalam satu frame tanpa mengurangi `viewH` dan tanpa `paintRegion()` terpisah; klik area dropdown = item menu.
- [ ] (v0.37) Bracketed paste `?2004h`/`?2004l` di luar frame tanpa submit bertingkat; `Ctrl+A` select-all (Home bila draft/menu) & `Ctrl+C` saat drag aktif; resize stabilizer (auto-scroll/drag/kursor/anchor, dropdown busy/abort); echo prompt satu baris logis di-wrap sekali selebar chat; cap prompt progresif `min(chatCols, 100 + floor(max(0, chatCols-100)/4))`.
- [ ] (v0.43) Baris live tool transien ikut tail (v0.40.0): history committed utuh; `total` naik saat live muncul → jendela boleh naik; saat live hilang & `total` menyusut jendela tidak geser balik (posisi committed tetap, ruang bawah boleh kosong) via ratchet `scrollBack` per turn yang di-reset pada `turn:started`/prompt baru/`/clear`; bukan overlay/`liveRegion`/commit-in-place; I1 satu write/frame; aspek transiensi v0.42 ditimpa, klausa v0.42 lain tetap.
- [ ] Machine output tidak bergantung pada scraping human text.
