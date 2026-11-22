# Audit MiniCode — Konsolidasi Temuan (pra-eksekusi)

- Tanggal audit: 2026-11-21
- Checkout: HEAD `643f4b399bc19c334f2e8c1d1584c672095c12f6` (`643f4b3`, `v0.33.0`)
- Working tree saat audit: bersih untuk file terlacak. Artefak audit untracked:
  `.audit/AUDIT-ROUND2.md`, `.audit/temuan.md`, `scripts/audit-scroll-probe.ts`, dll.
  (Catatan koreksi: `.audit/SCROLL-PERF.md` **tidak lagi ada** — sesi Minicode global
  memindahkannya ke `.minicode/.trash/2685fe12-SCROLL-PERF.md` pukul 20:23. Rujukan
  historis memakai `.audit/temuan.md`, checkpoint `1aaca14`.)
- Mode: **baca-saja**. Belum ada perbaikan yang diterapkan. File ini adalah satu-satunya
  ringkasan kerja sebelum eksekusi; dua artefak lama tetap disimpan sebagai data mentah.
- Metode: inspeksi kode langsung + 3 agen audit paralel (UI/render, core non-UI,
  correctness lintas modul) + pengukuran nyata memakai `scripts/audit-scroll-probe.ts`
  + baseline `bun x tsc --noEmit` (0 error) dan `bun run lint` (852 file, 0 error).
- Gate penuh oleh auditor utama **tidak dijalankan ulang**. Namun sesi `AUDIT-ROUND2.md`
  pernah menjalankannya pada checkout `643f4b3`: **6626 pass / 33 skip / 1 fail**
  (flake hook `phase6z` under load), `gate:pack` 23/23, `audit:harness` 73 pass. Jadi
  klaim "gate hijau" **tidak berlaku** checkout ini. Angka `AGENTS.md` (coverage
  90,22%/91,07% dll.) tetap hasil historis kandidat rilis v0.33.0, bukan hasil di sini.

## Ruang klaim

- Temuan **PERF-1**, **BUG-1**, **BUG-2**, **BUG-3** dan seluruh angka pada §2 diverifikasi
  langsung oleh auditor utama (kode + eksekusi probe).
- Temuan lain berasal dari inspeksi statis agen: mekanismenya dibaca dari kode, dampak
  waktu (ms) masih penalaran, bukan pengukuran. Ditandai demikian di masing-masing entri.
- Jangan menulis laporan status yang menyatakan repository hijau berdasarkan file ini.

---

## 1. Ringkasan eksekutif

Ada satu cacat performa **kritis dan terukur**: pada terminal ≥100 kolom (sidebar kanan
aktif), satu frame TUI butuh **~784 ms** dengan 5000 baris history, dibanding ~1–18 ms
pada 80 kolom dengan history sama. Penyebabnya bukan ukuran history, melainkan **dua lebar
berbeda yang dipakai bergantian untuk transkrip yang sama**, sehingga cache proyeksi
single-slot selalu miss. Ini sekaligus bug correctness: batas gulir dihitung dari lebar
yang salah dan ~5000 baris tidak bisa dicapai.

Selain itu ada: N+1 `spawnSync("git show")` per berkas tes yang diubah (mem-blok event
loop tiap completion `todo_write`), `spawnSync git status` di startup, replay O(turns ×
activities) saat resume, bug substitusi argumen skill yang bisa merusak prompt, dan drift
dokumentasi (`--max-steps` 50 vs 200; `AGENTS.md` menyebut HEAD lama).

---

## 2. Pengukuran performa (hasil eksekusi nyata, checkout ini)

Perintah: `bun run scripts/audit-scroll-probe.ts` (cols=120, rows=40, fake TTY, paint
sinkron, tanpa PTY/jaringan). Latensi = press → frame tertulis, p50 dalam ms.

| Skenario | 0 baris | 500 | 2000 | 5000 |
|---|---|---|---|---|
| Ketik 1 char | 2.05 | 89.68 | 350.28 | **784.07** |
| Wheel −3 baris | 19.08 | 109.65 | 362.29 | **778.18** |
| PgUp 1 halaman | 2.10 | 91.00 | 348.28 | **786.92** |
| Append 1 baris + paint | 2.14 | 5.47 | 6.43 | 10.51 |

Atribusi CPU kumulatif (total semua skenario):

```
wrappedLength   39164.8ms / 126 calls
committedRows   39115.8ms / 106 calls
paint           20101.2ms /  58 calls
buildLayout     19922.1ms /  58 calls
composerLayout     11.9ms / 281 calls
composerRows        6.7ms / 116 calls
viewportHeight      4.0ms / 107 calls
viewport            0.5ms /  58 calls
```

Lebar yang diminta (bukti cache miss dua arah):

```
wrappedLength@w=120 ×196      <- jalur navigasi (lebar terminal)
wrappedLength@w=81  ×347      <- jalur render (lebar chat)
committedRows@w=120 ×196
committedRows@w=81  ×228
viewport@w=81       ×232
```

Kebenaran batas gulir (5000 baris, sidebar aktif):

```
wrappedLength(120 = lebar terminal) = 5000
wrappedLength(81  = lebar chat)     = 10000
maxBack yang dipakai                = 4967
maxBack yang benar                  = 9967
baris yang tak bisa dicapai         = 5000
```

Perbandingan historis dari `.audit/temuan.md` (checkpoint `1aaca14`, data mentah
dipindahkan dari `SCROLL-PERF.md`): 73–846 ms @120 kolom vs 1–18 ms @80 kolom.
Mekanisme dan besaran masih sama pada checkout ini. **Catatan metodologi:** tabel
"Atribusi CPU kumulatif" di atas sebenarnya hanya mencakup skenario **5000 baris**
(skenario terakhir; `acc.clear()` tiap skenario), sedangkan tabel "Lebar yang diminta"
adalah akumulasi keempat ukuran history. Itu sebabnya jumlah panggilan di dua tabel
tidak sama. Instrumentasi `wrapProto` aktif saat pengukuran, sehingga angka adalah
batas bawah CPU dengan overhead profiler, bukan angka produksi murni.

---

## 3. Temuan performa — UI / render

### PERF-1 — HIGH (terverifikasi) — Dua lebar per frame, proyeksi penuh 2×, cache selalu miss

**Lokasi:** `src/ui/tui/app.ts`

Navigasi memakai lebar terminal penuh:

- `scrollBy:1577-1581` → `const cols = process.stdout.columns || 80` → `wrappedLength(cols)`
- `scrollRows:1606-1610` → sama
- `jumpEdge:1629-1633` → sama
- `followTail:1664-1667` → sama

Render memakai lebar chat:

- `buildLayout:2473-2475` → `const chatCols = geom.chatCols`
- `buildLayout:2502-2505` → `wrappedLength(chatCols)` dan `viewport(chatCols, viewH, scrollBack)`

`wrappedLength()` (`transcript.ts:1731-1733`) = `projectAll(width).length`, bukan lookup
murah. Cache bersifat single-slot per lebar:

```ts
// transcript.ts:1573-1580
private committedRows(w: number): TranscriptRow[] {
  if (this.committedProjection && this.committedProjection.width === w &&
      this.committedProjection.totalAppended === this.totalAppended) {
    return this.committedProjection.rows
  }
  // ... loop seluruh this.lines, rowCache.get(id) dengan syarat cached.width === w
}
```

`projectedBase` (`transcript.ts:1492-1500`) dan `rowCache` (`transcript.ts:1591-1619`,
satu `width` per id) mengikuti pola sama. Akibatnya perpindahan 120↔81 membuat
`projectText`/`projectTable` (markdown, wrap, `displayWidth`) diulang untuk seluruh
history. `pendingRowMemo` (`transcript.ts:1639,1691`) justru sudah multi-width — bukan
sumber masalah.

**Amplifier:** `projectAll()` melewati cache sama sekali saat ada thinking/running/panel/
activity (`transcript.ts:1514-1561`). Saat turn berjalan, satu frame bisa memicu 3–4
proyeksi penuh di dua lebar.

**Dampak correctness:** `maxBack = wrappedLength(cols) - viewH` memakai lebar terminal,
padahal chat lebih sempit → batas terlalu kecil; `buildLayout` menarik ke ekor benar lalu
`scrollRows` meng-clamp balik → gulir "lompat/kaku" dan ekor tengah tak tercapai.

**Perbaikan:** simpan `lastChatCols` dari `buildLayout`, pakai di keempat fungsi navigasi
dan di `app.ts:2436`; ganti `committedProjection`/`projectedBase`/`rowCache` dengan cache
multi-lebar (LRU 2–3 entri). Estimasi: 784 ms → ±1–3 ms/frame.

### PERF-2 — MED — `composerCache` dua lebar dalam satu frame

`app.ts:2436` mengukur composer dengan `width` (terminal) untuk indikator; `app.ts:2476`
memakai `chatCols` untuk layout akhir. Cache `app.ts:1928-1941` single-slot di-key `cols`,
dan jalur inkrementalnya menolak lebar beda (`app.ts:1995`) → `layoutComposer` penuh
dipanggil 2× per frame saat sidebar aktif.

### PERF-3 — MED — Regex di-compile per baris di `stripSgr`

`src/ui/render/sanitize.ts:197-200`:
```ts
return s.replace(new RegExp(`${ESC_CH}\\[[0-9;:]*m`, "g"), "")
```
Dipanggil per baris pending di `transcript.ts:1698`. Kontras dengan `theme.ts:552`
(`ANSI_STRIP = new RegExp(ANSI_PATTERN, "g")`) yang statis. Memperparah jalur miss.

### PERF-4 — MED-LOW — `setSidebarActive` tak membatalkan cache

`app.ts:2495` mengubah flag yang dipakai `runningRows()` (`transcript.ts:2627-2629`,
`if (this.sidebarActive) return []`), tetapi `projectedBase` tidak menyertakan flag dalam
kunci cache dan tidak di-invalidate → proyeksi basi saat resize melintasi ambang 100
kolom / 20 baris.

### LOW — alokasi per-frame minor

`sidebarGeometry()` dipanggil dua kali per frame (`app.ts:2423-2428` dan `:2473`),
`bodyRows.map()` tiap frame (`app.ts:2518`), `" ".repeat()` + `truncateToWidth` per baris
(`app.ts:2684-2689`). Skala kecil dibanding proyeksi history; `screen.ts:209-259` sudah
merakit satu string per frame dan mendiff per sel, jadi bukan penyumbang utama.

---

## 4. Temuan performa — lapisan core non-UI

### PERF-5 — MED-HIGH — N+1 `spawnSync("git show")` per berkas tes yang diubah

**Lokasi:** `src/session/verification.ts:1817-1833` (`gitBaselineContent`), dipanggil
dalam loop `:1852` pada `:1873` (package.json) dan `:1894` (test/**/*.ts).

```ts
const result = spawnSync(resolveTrustedExecutable("git"),
  [...GIT_SAFE_BASE, "show", `HEAD:${rel}`],
  { cwd: root, encoding: "utf8", timeout: GIT_OBSERVE_TIMEOUT_MS, maxBuffer: ... })
```

`GIT_OBSERVE_TIMEOUT_MS = 10_000` (`:56`). Pemanggil produksi: `tools/todo.ts:157,217`
(setiap klaim completion lewat `todo_write`) dan `cli/setup.ts:2643`. Turn yang menyentuh
20–30 berkas tes → puluhan `spawnSync` berurutan yang mem-blok event loop TUI (Windows
~30–100 ms per spawn). Seam `opts.baselineContentByFile` sudah ada tetapi production
tidak mengisinya. **Perbaikan:** satu `git cat-file --batch` / `git show` multi-path, atau
`execFile` async konkurensi-terikat dengan timeout ~2 dtk. (Inspeksi statis; dampak ms
belum diukur.)

### PERF-6 — MED — `git status` sinkron di startup/checkpoint

- `src/session/verification.ts:1653-1688` (`listDirtyEvaluationPaths`,
  `spawnSync git status --porcelain --untracked-files=all`, timeout 10 dtk), dipanggil
  `:1712` oleh `captureSessionEvaluationBaseline` dari `cli/setup.ts:2571`, dan `:1784`.
- `src/session/checkpoint.ts:309-319` (`spawnSync git status --porcelain`, timeout 2 dtk,
  di dalam fungsi `async`).

Startup TUI mem-blok sampai git status selesai; `spawnSync` juga mewarisi stdin raw-mode
TUI (masalah sejenis sudah diperbaiki di `repomap.ts:334-345`). Helper git async sudah ada
di `src/session/shadow-git.ts:52-60`.

### PERF-7 — MED — Replay O(turns × activities) di `rebuildFromDurable`

`src/presentation/reducer.ts:967` memanggil `refreshTurnSummary` untuk setiap turn;
`deriveTurnSummary` (`:228-237`) memindai dan mengalokasikan array dari **semua**
activities:

```ts
const activities = [...state.activities.values()].filter(
  (a) => a.sessionId === sessionId && a.turnId === turnId)
```

Cap `MAX_STATE_ENTRIES = 4096` (`presentation/model.ts:25`). `reduce()` juga memanggil
`refreshTurnSummary` berulang untuk event yang sama (`:512,639,652,815,836`), dan
`deriveSupersedes` (`:212-220`) memindai semua activity pada tiap `tool.started` (`:447`).
**Perbaikan:** indeks `Map<turnKey, ActivityEntry[]>` inkremental; hitung ringkasan dalam
satu pass saat replay.

### PERF-8 — MED-LOW — DB dibuka ulang + 3× `chmodSync` per operasi persistence

`src/session/persistence.ts:41` mengimpor `openSessionHandle as open`; ~20+ situs
`open(cwd) … db.close()`. Tiap open menjalankan `chmodSessionDbSync(p)`
(`db/schema.ts:340-345`) yang menyentuh file + WAL + SHM. Di Windows chmod relatif mahal;
bisa puluhan kali per turn. `chmod` memang disengaja (komentar `:341-343`, sidecar dibuat
ulang SQLite) — jangan dihapus, cukup kurangi frekuensi / cache koneksi per cwd.

### PERF-9 — MED — Dua `spawnSync` git per approval

`src/policy/approval-binding.ts:129-148` (`captureGitDigest`: `rev-parse HEAD` +
`status --porcelain`, timeout 2 dtk masing-masing), dipanggil sebelum prompt approval.
Catatan positif: `fingerprintTarget` (`:92-127`) sudah TOCTOU-aware (`lstatSync` →
`openSync(O_NOFOLLOW)` → `fstatSync` → `closeSync` di `finally`), jadi ini murni blocking.

### PERF-10 — LOW-MED — MMR O(n²) di vector memory

`src/memory/vector.ts:1096-1117`: `rest.splice(best, 1)[0]` di dalam `while` (O(n) shift)
dan similarity terhadap `selected` dihitung ulang dari awal tiap putaran. Dibatasi batas
kandidat, jadi dampak menengah. **Perbaikan:** tukar-with-last + simpan `maxSim[i]`
inkremental.

### PERF-11 — LOW — Estimasi teks dihitung ulang tiap iterasi binary-search kompaksi

`src/policy/compaction.ts:479-500`: `estimateMessages(candidate, ...)` mengulang seluruh
`tail` tiap iterasi; `tailTokens` konstan sudah dihitung di `:479`.

### PERF-12 — LOW — `selectNodes` O(n²), tapi hanya dipanggil dari test

`src/presentation/projection.ts:342-417` memakai `.find()` per entri `order` (cap 4096);
fallback `findActivity` (`:325-330`) mengalokasikan `[...state.activities.values()]`.
Grep seluruh repo: pemanggil hanya `test/presentation-policy.test.ts` — bukan latensi
hari ini, tapi akan menjadi O(n²) bila dipasang per-frame.

---

## 5. Temuan correctness

### BUG-1 — MED (terverifikasi) — Argumen skill diperlakukan sebagai replacement pattern

`src/skills/loader.ts:201-203`:
```ts
export async function renderSkill(skill: Skill, args: string): Promise<string> {
  return skill.body.replace(/\{\{args\}\}/g, args).replace(/\$ARGUMENTS/g, args)
}
```
`String.replace` dengan string replacement menginterpretasi `$&`, `` $` ``, `$'`, `$1`.
Contoh: argumen `$&` membuat placeholder tetap tertulis `{{args}}`; `$'…` menyisipkan
sisa template ke posisi replacement. Skill di-invoke dari prompt user (`cli/index.ts:583-585`)
→ input tak terpercaya menghasilkan prompt final yang salah. **Perbaikan:** replacer fungsi
`() => args`.

### BUG-2 — MED (terverifikasi) — `--max-steps` default 50 di help, 200 di kode

- `cli/index.ts:150` dan `:354`: `"max tool steps (default 50)"`
- `src/constants.ts:199`: `DEFAULT_MAX_STEPS: 200`
- `src/policy/step-escalation.ts:38`: `DEFAULT_SESSION_MAX_STEPS = 200`
- Pemakai: `cli/setup.ts:2476`, `src/app/session.ts:1080-1083`
- `docs/cli.md:56` benar (200); `docs/getting-started.md:88` salah (50).

Dampak: operator mengira batas 50, sesi bisa berjalan 200 langkah (200 panggilan model).
**Perbaikan:** bangun string help dari konstanta yang sama.

### BUG-3 — MED (terverifikasi) — `AGENTS.md` menyebut HEAD lama

`AGENTS.md:24`: "HEAD adalah commit v0.33 (`1aaca14`)" — aktual `643f4b3`. Instruksi
agent di dalam repo menyesatkan soal status checkout.

### BUG-4 — MED-LOW — Drift geometri indikator "N baris di bawah"

`app.ts:2436` menghitung tinggi composer dengan `composerRows(width, ...)` (lebar
terminal), sedangkan frame akhir memakai `composerRows(chatCols, ...)` (`:2476`).
`indicatorGeom` di `:2423-2428` juga memakai `viewportHeight(height, width)`.
Akibatnya `maxBackForIndicator` (`:2429-2438`) bisa salah saat sidebar aktif.

### BUG-5 — MED-LOW — `childCount` di Live adalah kode mati

`transcript.ts:2080-2086` menghitung `childCount` sekali saat `tool.started`, anteseden
anak belum ada → selalu 0. Meta `· Nc` di `sidebar-model.ts:227` tidak pernah muncul di
produksi (hanya di test). Catatan: hipotesis lama "baris induk tercoret saat anak selesai"
sudah dibantah — `aggregateAgent` meneruskan id anak (`transcript.ts:2309`).

### BUG-6 — MED-LOW — Kontrak abort-before-start beda antar runner sandbox

- `src/sandbox/os.ts:166`: `return Promise.reject(opts.signal.reason)` — `reason` bisa
  `undefined` pada `abort()` biasa → error tanpa konteks.
- `src/sandbox/docker.ts:170-172`: `return Promise.resolve({ code: null, output: "[docker] aborted before container start" })`

Keduanya dipakai di `src/tools/bash.ts:345,375`. **Perbaikan:** samakan bentuk hasil dan
pastikan `signal.reason ?? new Error("aborted")`.

### BUG-7 — LOW — `catch {}` kosong menyembunyikan degradasi

- `src/app/rag-layer.ts:81,104,106,113`: kegagalan embedding (kredensial keystore,
  endpoint mati) ditelan; sesi jatuh ke keyword search tanpa diagnostik.
- `src/hooks/run.ts:94-96`: penulisan observability hook ke stderr gagal diam-diam
  (EPIPE), menghilangkan satu-satunya jejak eksekusi hook.

**Perbaikan:** minimal satu baris stderr per sesi/candidate, tanpa secret.

### BUG-8 — LOW — Cache baseline evaluasi tanpa eviksi

`src/session/verification.ts:1631`: `const sessionEvaluationBaselines = new Map<string, Map<string, string>>()`
— hanya `.get`/`.set`, tidak ada `delete`. Daemon panjang menyimpan struktur ini selamanya;
hash lama bisa dipakai ulang pada id sesi yang sama. **Perbaikan:** hapus saat sesi dihapus
atau LRU/TTL.

### BUG-9 — LOW — Predikat prefix legacy tidak konsisten di `saveSession`

`src/session/persistence.ts:732-733` memakai `(got.content ?? "") !== (want[1] ?? "")`,
tetapi cabang `grewBeyondBuffer` di `:799-800` memakai `got.content !== want[1]` (tanpa
coalesce). Hanya mengubah field diskriminan `RefusedHistoryRewriteError`, bukan data yang
ditulis. Komentar `:696-701` memang meminta sinkronisasi kedua loop.

### BUG-10 — LOW — Dead branch

`src/app/tool-layer.ts:175-181`: kedua cabang `if (scope === "explore")` identik —
`return applyWorkModeFilter(candidates, wm, pm)`. Menyesatkan pembaca/auditor.

### BUG-11 — LOW (design tradeoff) — Celah seq pada marker kompaksi

`src/session/context-adapter.ts:231-249`: `const eventSeq = seq++` (`:240`) terjadi sebelum
`void bridgeCompactionToDurable(...)` (`:241`) yang fire-and-forget. Bila tulis gagal,
marker `context.compacted` hilang tapi counter seq tetap maju. Disengaja best-effort
(komentar `:155-160`) — dicatat agar konsumen seq mengetahui kemungkinan celah.

### HIPOTESIS — False tamper alert saat baseline capture gagal

`cli/setup.ts:2571` memanggil `captureSessionEvaluationBaseline(...).catch(() => {})`;
bila `spawnSync git status` timeout/gagal, baseline kosong, lalu `verification.ts:1788`
`if (!baseline) combined.add(rel)` menganggap semua path kotor sebagai tamper. Belum ada
bukti eksekusi pada kondisi normal — perlu repro dengan git timeout / repo tanpa git.

---

## 6. Kesenjangan proteksi test

- `test/perf-no-quadratic.test.ts` hanya **static scan 27 baris** (pola `Array.from(this.thinkingRaw + text)`,
  `thinkingCodePoints`, `maxPendingChars`, dll.). Tidak ada `wrappedLength`, `committedRows`,
  `chatCols`, `cols=120`, atau penghitung panggilan proyeksi. Grep lintas `test/*perf*`
  untuk pola tersebut → nol hasil.
- `scripts/bench-render.ts:84-91` memakai satu lebar tetap per objek `Transcript`
  (`view 80`, `resize 40`, `resize 120`) → cache selalu HIT, cacat tak terlihat.
- `scripts/bench-typing.ts:33` benar-benar memakai `COLS = 100` (sidebar aktif), tetapi
  eksplisit tanpa ambang (komentar `:16-17`) dan tidak masuk `gate:fast` (`package.json:61`).
- Proteksi yang perlu ditambah: (a) uji geometri `maxBack` harus memakai `chatCols` saat
  `cols=120` + sidebar aktif; (b) assertion `committedRows` dipanggil ≤2× per frame saat
  lebar bergantian; (c) benchmark performa masuk gate terpisah.

---

## 7. Rencana eksekusi (urutan dianjurkan)

1. **Patch tunggal PERF-1…4**: `lastChatCols` + pakai `chatCols` di navigasi/indikator
   (`app.ts:1581,1610,1632,1667,2436`) + cache multi-lebar di `transcript.ts`
   (`committedProjection`, `projectedBase`, `rowCache`) + invalidate `setSidebarActive`
   + regex statis di `sanitize.ts:199`. Sertakan test regresi §6. Dampak terukur:
   ~784 ms → ±1–3 ms/frame, batas gulir benar.
2. **PERF-5, PERF-6, PERF-9**: batch/async-kan `spawnSync` git di `verification.ts`,
   `checkpoint.ts`, `approval-binding.ts` (helper async sudah ada di `shadow-git.ts`).
3. **BUG-1, BUG-2, BUG-3**: perbaikan murah, dampak nyata (prompt corruption, biaya tak
   terduga, instruksi menyesatkan).
4. **PERF-7, PERF-8**: indeks activities-per-turn di reducer; koneksi DB per-cwd.
5. Sisanya: PERF-10…12, BUG-4…11, HIPOTESIS (butuh repro).

Setiap perubahan perilaku UI/terminal wajib mengikuti kontrak FROZEN
(`docs/TERMINAL_CONTRACT.md`, invariant I1–I37, peta test) dan memperbarui
`docs/architecture.md` bila struktur/dependensi antarlapisan berubah.

## 8. Catatan gate (untuk laporan status nanti)

- Baseline checkout ini: `tsc --noEmit` 0 error, `biome check` 852 file 0 error.
- Angka historis v0.33.0 di `AGENTS.md` (coverage 90.22%/91.07%, 6627 pass, paket
  4903 KB, dll.) adalah hasil pada kandidat rilis, **bukan** hasil checkout ini.
- Sebelum menyatakan release-ready/quality final, jalankan ulang seluruh gate pada satu
  kandidat final yang sama: urutan 5 perintah + `audit:harness`, smoke build/package,
  dan CI relevan. Ambang `scripts/coverage-gate.ts` dan budget `scripts/pack-budget.ts`
  tidak boleh diturunkan/naikkan untuk membuat hasil hijau.

---

# Lanjutan — Audit konten sidebar (elastis & responsif)

Checkpoint sama (`643f4b3`). Metode: inspeksi kode + 2 agen audit paralel (geometri vs
pipeline konten) + pengukuran nyata dengan `.audit/sidebar-content-probe.ts` (artefak
audit, bukan kode runtime). Belum ada perbaikan yang diterapkan.

## 9. Pengukuran konten sidebar (hasil eksekusi, checkout ini)

```
biaya SidebarModel.snapshot (tanpa cache di dalam model), p50:
  activity=100   thinking=10k    20.014 ms
  activity=500   thinking=50k    80.769 ms
  activity=2000  thinking=200k  329.945 ms

3x syncFollow -> maxScroll -> snapshot (jalur App, per frame), p50:
  activity=100   thinking=10k    47.781 ms
  activity=500   thinking=50k   238.490 ms
  activity=2000  thinking=200k  964.543 ms  (max 1033 ms)

split 168 kolom: width=84, chatCols=80, liveWidth=41, logWidth=41
  baris sumber wrap@84 = 84 char -> baris Log setelah render = 37 char  => TERPOTONG
  split tanpa live tool: baris Activity = 84 kolom, 41 kolom kiri kosong
```

Angka di atas adalah batas bawah CPU in-process (tanpa PTY/jaringan).

## 10. Temuan HIGH

### S-1 — HIGH (terukur) — `snapshot()` tanpa cache, 3–6× per frame

`SidebarModel.snapshot()` (`src/ui/render/sidebar-model.ts:191-236`) baru membungkus
ulang seluruh thinking (≤200k char) + activity (2000 baris) setiap dipanggil.
`maxScroll()` (`:246-250`) memanggilnya, dan `syncFollow()` (`:261-263`) memanggil
`maxScroll()` — `app.ts:2643-2645` menjalankan ini **3× setiap frame**. Saat `sourceKey`
berubah, ada 3 snapshot penuh lagi (`:2636-2638`), termasuk `snapshot(liveWidth)` yang
membungkus thinking+activity pada lebar ketiga yang tidak dipakai. Total 6× rewrap per
frame dengan data baru. Wheel sidebar juga memicu `maxScroll()` per event.

Dampak: ~965 ms/frame pada ukuran maksimal, ~238 ms pada 500 baris, ~48 ms pada 100
baris. Repaint busy tiap 400 ms (`app.ts:1714`) membuat ini berulang terus.

**Perbaikan:** memo `snapshotLines(width)` per `(rev, width)`; `maxScroll()` menerima
array baris yang sudah dihitung, bukan memanggil `snapshot()`; pisahkan `liveLines` dengan
kunci detik. `rev` sudah naik di semua mutasi → invalidation murah.

### S-2 — HIGH (terukur) — Activity di-wrap di `sideWidth`, dirender di `logWidth`

`app.ts:2637` memanggil `transcript.sidebarActivity(..., sideWidth)`; `transcript.ts:1015`
→ `snapshot(sideWidth)` menghasilkan baris sampai 84 kolom. Saat split, `sidebar.ts:131`
merender pane Log pada `logWidth` (41) dan `fit()` (`sidebar.ts:32-34`) memotong, bukan
membungkus ulang. Terukur: 84 char → 37 char (ellipsis). Target path/status di suku kanan
hilang, pemotongan di tengah kata.

Scroll ikut salah: `app.ts:2644`, wheel `:927-930`, Alt+PgUp `:967-968`, Home/End
`:1650-1651` semuanya memakai `geom.width` untuk pane `"activity"`, padahal yang tampil
`logWidth`. Thinking & Live tidak terkena.

**Perbaikan:** hasilkan sumber Activity terpisah yang di-wrap di `logWidth`; teruskan
`logWidth` ke `syncFollow`/`scrollPane`/`jumpToEdge` untuk `"activity"`; masukkan
`logWidth` ke `sourceKey` (`app.ts:2633`).

### S-3 — HIGH — Live hilang total di bawah 168 kolom

`sidebar.ts:115-126` hanya membuat pane Live bila `activitySplit` (`>=168` kolom).
Di 100–167 kolom data Live tetap dihitung (`app.ts:2638`) lalu dibuang. Jalur cadangan
juga diputus: `transcript.ts:2627-2629` `runningRows()` mengembalikan `[]` saat sidebar
aktif. Jadi tool yang sedang berjalan tidak terlihat di mana pun sampai selesai.
`TERMINAL_CONTRACT.md:48` memang menyebut "di bawah threshold Activity satu kolom seperti
biasa" — ini **gap desain/kontrak**, bukan sekadar typo.

**Perbaikan:** sisipkan bagian Live (1 baris/tool + `↑ n live`) di kepala Activity saat
split off, atau jangan matikan `runningRows()` saat sidebar aktif.

### S-4 — HIGH — Scroll keyboard pakai lebar terminal, render pakai `chatCols`

`app.ts:1577-1581,1606-1611,1629-1634,1664-1667` dan `viewportHeight()` (`:1914-1919`)
memakai `process.stdout.columns`, sedangkan render memakai `chatCols`/`viewH`
(`:2492,2505`). Ini PERF-1 dari audit umum; dampaknya di sidebar: kombinasi keduanya
membuat seluruh frame terasa berat dan batas gulir chat tidak sinkron dengan geometri
sidebar. Gunakan `lastLayout.chatCols`/`lastLayout.viewH` sebagai satu-satunya sumber.

## 11. Temuan MEDIUM

- **S-5 — Split tanpa live tool menyisakan setengah sidebar kosong.** Mekanisme yang
  tepat: `pane()` selalu mengembalikan `height` baris, jadi `livePane` tidak pernah
  kosong; yang terjadi adalah Live always-on saat split, sementara Activity tetap
  dirender di `logWidth`. Saat tidak ada tool berjalan, 41 dari 84 kolom berisi judul
  Live + baris kosong. **Perbaikan:** `splitLive = activitySplit && live.length > 0`;
  bila false,Activity memakai `geom.width` penuh.
- **S-6 — Off-by-one indent memotong 1 kolom tiap baris.** `snapshot()` wrap di `w`, lalu
  `sidebar.ts:85` menambah spasi dan `fit()` ke `width` yang sama → baris penuh jadi
  `w+1` dan ter-ellipsis. Di 100–110 kolom (sidebar 30–33) konten efektif tinggal 29–32.
  **Perbaikan:** wrap pada `width-1` atau kurangi budget konten `pane()` satu kolom.
- **S-7 — Waktu/durasi beku.** `·Ns` dan `12s` dihitung di `snapshot()`
  (`sidebar-model.ts:200-205,217-234`), tetapi `sourceKey` (`app.ts:2633`) hanya
  `[version, sideWidth, liveWidth]` — tanpa detik. Angka tidak pernah naik sampai ada
  event lain. **Perbaikan:** masukkan `Math.floor(Date.now()/1000)` ke `sourceKey`, atau
  hitung di renderer dari `activityTimes`/`startedAt`.
- **S-8 — Scroll/follow tidak di-rebase saat resize atau cap trim.** `scroll[pane]`
  adalah indeks baris mentah (`sidebar-model.ts:57-58`); saat lebar berubah (jumlah
  baris wrap berubah) atau head dibuang (`:88-97` + marker `:208-213`), user yang sedang
  manual-scroll (`follow=false`) melompat ke teks lain. **Perbaikan:** anchor logis
  `(logicalLineIndex, intraLineOffset)` atau koreksi offset saat perubahan lebar/trim.
- **S-9 — Ringkasan `✦` di Activity melanggar kontrak.** `transcript.ts:1005-1014`
  me-prepend `formatAgentProgress()` per turn, padahal `TERMINAL_CONTRACT.md:65` menyatakan
  Activity "HANYA log detail per-tool, tanpa rekap". Child tool sudah masuk log via
  `:2303-2310`, `agentProgress` di-clear per turn sementara log kumulatif → urutan
  kronologis terbalik. **Perbaikan:** hapus loop itu dari `sidebarActivity()`.
- **S-10 — `childCount` mati.** Dihitung sekali di `tool.started` sebelum child ada
  (`transcript.ts:2080-2086`), tidak pernah di-update. `· Nc` dan `child: N` di modal
  tidak pernah tampil. **Perbaikan:** hitung turunan di render dari `liveRecords()`, atau
  `updateLiveChildCount()` dari `aggregateAgent()` (`:2280-2324`).
- **S-11 — Composer layout dua lebar.** `app.ts:2476` `composerRows(chatCols, …)` versus
  `:2562` `composerLayout(width)`; cache single-slot (`:1928-1941`). `cursor.visIdx/col`
  dari layout lebar penuh dipakai untuk mengiris `shownComposer` dari layout `chatCols`
  → caret bisa masuk separator/sidebar pada draft yang wrap beda. **Perbaikan:** pakai
  ulang layout `:2476`.
- **S-12 — Diskontinuitas ambang.** Rasio `sidebar-layout.ts:71`: 150→151 `width` 45→48
  tapi `chatCols` turun 101→99; gap `:26-28` meloncat di 140/180; 168 mengaktifkan split
  seketika + mengubah mapping keyboard (wheel pane, Alt+PgUp menggeser `liveSelected`,
  Home/End `jumpToEdge("live")`) tanpa rebase offset. Test `sidebar-invariants.test.ts:59-66`
  hanya mengecek `width` monoton, bukan `chatCols`.

## 12. Temuan LOW / dokumentasi

- **S-13 — Nama parameter helper menyesatkan.** `sidebar-layout.ts:54-58` menyebut argumen
  ke-3 `viewH` (area transkrip), tetapi `app.ts:2473` mengirim `height` (frame penuh).
  Ini **disengaja** (sidebar full-height, `renderSidebar({viewH: height})` di `:2663`);
  yang salah adalah dokumentasi/nama. Jangan "perbaiki" `:2473` dengan `viewH` transkrip —
  itu akan memecah kontrak dan I1.
- **S-14 — Komentar kontradiktif.** `app.ts:2628` "Footer & composer tetap full-width"
  versus `:2679` "footer & composer juga ikut tersempitkan". Kontrak `:45` benar:
  "footer & composer **selebar chat**"; klausa v7.42 "footer full-width" (`:104-105`)
  kalah oleh v0.33.
- **S-15 — Indikator/posisi.** `positionBar()` dihitung sebelum collapse idle
  (`sidebar.ts:66` vs `:70-75`), sehingga batang menggambarkan `capacity` penuh padahal
  idle hanya menampilkan 3 baris ekor. Dua marker "more lines" memakan 2 baris isi saat
  scroll manual (`:79-83`).
- **S-16 — Format durasi tidak seragam.** Live/Activity pakai `s` (`sidebar-model.ts:224`),
  modal `app.ts:901` pakai `d` dan string literal tanpa i18n. Satu helper
  `formatElapsedCompact(ms, locale)` untuk ketiganya.
- **S-17 — Peta proteksi tidak sesuai isi.** `TERMINAL_CONTRACT.md:66` mencantumkan
  `test/tui-geometry.test.ts` sebagai proteksi sidebar, tapi file itu menguji geometri
  popup dan tidak meng-import `sidebar-layout.ts`. Tidak ada unit test `renderSidebar()`;
  `sidebar-invariants.test.ts` hanya cek statis jumlah baris, flag split 167/168, dan
  monotonic `width`.

## 13. Kritik desain (mengapa sidebar belum elastis)

1. **Wrap terjadi di ingestion, bukan di render.** Konten dibungkus pada lebar pasti di
   `snapshot()`, lalu dipaksa muat di pane yang lebarnya bisa berbeda. Ini akar S-2/S-6:
   satu konten, tiga lebar (wrap, scroll, render). Model yang benar: simpan **baris
   logis** + metadata (id, role, timestamp), dan lakukan wrap di render dengan memo
   `Map<width, LogicalLine[]>` per pane.
2. **Alokasi ruang buta.** `topHeight/bottomHeight` = rasio tetap 60:40 (30–80%) dan
   Live|Log = 50:50 terlepas dari isi. Saat idle Thinking yang hanya berisi 3 baris tetap
   menyita 60% tinggi; saat banyak tool, Live yang penuh tetap dapat 41 kolom. Elastis
   berarti alokasi fungsi `allocatePanes(contentStats, geom)` dengan minimum 2 baris per
   pane dan proportional-to-content.
3. **Live diperlakukan sebagai pane, bukan lapisan.** Akibatnya hilang total di bawah
   168 kolom (S-3) dan menyisakan setengah sidebar saat kosong (S-5). Seharusnya Live
   adalah bagian prioritas di dalam Activity yang muncul bila ada data, dan melebur saat
   tidak ada.
4. **Scroll berbasis indeks rapuh.** Tanpa anchor logis, resize/trim merusak posisi baca
   (S-8). Responsivitas menuntut offset yang mengikuti konten, bukan angka baris.
5. **Waktu dipanggang ke string.** `·Ns`/`12s` tidak bisa hidup tanpa rewrap (S-7).
6. **Biaya proyeksi tidak diminimalisir.** 3–6× rewrap penuh per frame (S-1) mengubah
   "responsif" menjadi "menunggu" pada sesi panjang.

## 14. Saran urutan eksekusi sidebar

1. **Fondasi (S-1):** cache `snapshotLines(rev, width)` + ubah `maxScroll()` menerima
   baris jadi; ulang pengukuran dengan probe yang sama → target <5 ms/frame.
2. **Konsistensi lebar (S-2, S-5, S-6, S-11):** satu `contentWidth` per pane dipakai untuk
   wrap, scroll, dan render; split adaptif saat Live kosong; wrap di `width-1`.
3. **Kehidupan data (S-3, S-7, S-10):** Live fallback di bawah 168, detik di `sourceKey`,
   childCount turunan saat render.
4. **Konten & anchor (S-8, S-9):** anchor logis, hapus `✦` dari Activity.
5. **Elastisitas (S-12 + alokasi dinamis):** smooth-kan ambang, uji `chatCols` monoton,
   alokasi tinggi berbasis konten.
6. **Proteksi (S-17):** unit test `renderSidebar()` pada 100/120/150/167/168/200 kolom:
   tanpa truncation, keyboard mapping, refresh detik, anchor saat resize, dan budget
   jumlah `snapshot()` per frame. Perubahan perilaku terminal wajib update
   `docs/TERMINAL_CONTRACT.md` + peta test.

---

# Lanjutan — Audit efisiensi sumber daya (tanpa efisiensi token/biaya)

Checkpoint sama (`643f4b3`). Ruang lingkup: **CPU, memori, disk I/O, syscall, subprocess,
startup, konkurensi, IPC, lifecycle**. Eksklusi tegas: token, context window, pricing/biaya
model, kompaksi untuk hemat token, ukuran prompt. Temuan lama di bagian 1–14 tidak diulang.
Metode: 3 agen audit paralel (startup, runtime/tools, I/O-penyimpanan) + pengukuran langsung.

## 15. Pengukuran langsung (checkout ini)

```
bun --version                          ~13 ms  (baseline runtime)
bun cli/index.ts --version             ~125 ms warm   -> ~110 ms biaya import graph
bun cli/index.ts --help                ~125 ms warm
discoverSandboxMaskTargets()           15.44 ms per call (30 iterasi, repo ini)
                                       -> sinkron, tiap bash/code_run, tanpa cache
```

## 16. Efisiensi startup & bootstrap

| ID | Sev | Lokasi | Masalah |
|---|---|---|---|
| E-1 | MED | `cli/index.ts:4-38,291-299` | `--help`/`--version` mengevaluasi seluruh graph modul berat (`setup.ts`, theme, telemetry, skills) karena static import ESM; router sudah lazy tapi tidak membantu. Terukur ~125 ms vs baseline 13 ms. **Perbaikan:** entrypoint ringan `cli/entry.ts` + dynamic import `index.ts` untuk jalur lain. |
| E-2 | MED | `cli/index.ts:534-568` | REPL **men-await `maybeAutoUpdate` sampai 1800 ms** sebelum `createCliSession` (`:612`). Jalur non-interaktif sudah fire-and-forget (`:212-221`). **Perbaikan:** jalankan paralel dengan session creation atau turunkan budget. |
| E-3 | MED | `src/providers/build.ts:104-113` → `src/lib/keystore.ts:645-654,583-590,68-80` | Resolusi `keystore:` mem-spawn PowerShell `spawnSync` **berurutan per provider** (200–600 ms cold start, timeout 15 dtk). **Perbaikan:** `Promise.all` atau cache lintas proses. |
| E-4 | MED-LOW | `cli/index.ts:605` | `createStartupProgress` mengimpor penuh `cli/tui.ts` (79 KB) **sebelum** cabang `if (enterRepl)` (`:673`) — jalur one-shot/CI tetap membayar. **Perbaikan:** pindahkan helper progress ke `cli/startup-progress.ts` bebas UI. |
| E-5 | LOW-MED | `src/ui/i18n/locale.ts:9-15` | Kamus `en.ts` + `id.ts` (~45 KB) dibuat saat import walau satu sesi pakai satu locale. **Perbaikan:** lazy-load locale non-default. |
| E-6 | LOW | `cli/setup.ts:1981-1982` vs `cli/tui.ts:807-810` | `state.json` dibaca dua kali via `loadLang()` dalam satu startup. **Perbaikan:** baca sekali di composition root. |
| E-7 | LOW-MED | `cli/index.ts:501` → `src/policy/sandbox-policy.ts:48-49` → `src/sandbox/os.ts:37-46` | Probe sandbox `spawnSync bwrap --version` (timeout 2 dtk) saat startup, walau di-cache per proses. **Perbaikan:** tunda sampai `bash` pertama. |
| E-8 | LOW | `cli/index.ts` (puluhan `hasFlag`/`getArg`) + `cli/router.ts:8-22,31-46,80-106` + `src/ui/render/theme.ts:50-70,264-285` | Scan argv berulang + `colorLevel()` dihitung tiap akses warna. Mikrodetik; prioritas rendah. |

## 17. Efisiensi runtime / tool / konkurensi

| ID | Sev | Lokasi | Masalah |
|---|---|---|---|
| E-9 | **HIGH** | `src/sandbox/mask.ts:48-91`, dipanggil `sandbox/os.ts:184` + `docker.ts:174` | Scan `readdirSync`/`lstatSync` hingga 500 direktori **tanpa cache tiap tool call**. Terukur 15,44 ms/call, sinkron di event loop. **Perbaikan:** cache per `cwd` + stamp root, invalidasi saat `.env` ditulis. |
| E-10 | MED | `src/hooks/run.ts:88-99` | `baseKillEnv` sudah disanitasi, lalu tiap hook menyanitasi ulang `process.env` (3× iterasi objek di `scrub.ts:184-189`); hook juga serial (`await` per file) → worst case 5N dtk. **Perbaikan:** `{...baseKillEnv, MINICODE_HOOK_CTX}`; paralelisasi hanya bila aman. |
| E-11 | MED | `src/app/session.ts:78-95` | `hasAuthorizedTool()` memanggil `refresh()` (clear + loop semua tool) per panggilan; setter mode sudah refresh (`:889,912`). **Perbaikan:** hapus refresh per-call atau dirty-flag. |
| E-12 | MED | `src/runtime/recovery.ts:242,419-426`; `src/runtime/dispatch.ts:280,301-315` | Cache recovery tanpa eviksi (kunci memuat frontier+ctx); dispatch `store` tanpa eviksi + tiap `save()` menyalin seluruh history array → O(n²). **Perbaikan:** LRU/TTL + ring buffer history. |
| E-13 | MED | `src/tools/bash.ts:305`, `src/policy/jail.ts:164-172`, `src/tools/context.ts:108` | `realpath(root)` dihitung ulang tiap cek jail; dua predikat jail dipanggil bersamaan; `safeOpenRead` 3 realpath + 2 stat/file. **Perbaikan:** cache realpath root per sesi (hati-hati jalur TOCTOU — jangan hapus pengecekan). |
| E-14 | LOW-MED | `src/tools/bash.ts:427` vs `:54` | Output di-`scrubSecrets` per chunk (~18 regex) lalu di-scrub lagi di akhir. **Perbaikan:** scrub sekali; atau jangan scrub chunk UI (scrub per-chunk juga bisa memotong secret di batas chunk). |
| E-15 | LOW | `src/tools/grep.ts:263-276` | `resolve(root)` + jail + 18 regex scrub per baris hasil ripgrep. **Perbaikan:** hoist `absRoot`, scrub hanya body. |
| E-16 | LOW | `src/runtime/production-execution.ts:339-340` | `kernel.get()` dua kali berturut (tiap call membuat salinan frozen). **Perbaikan:** simpan `rec` sekali. |
| E-17 | LOW | `src/policy/executor.ts:108-119,139` | `registry.list().find()` + wrapper closure baru per pemanggilan tool. **Perbaikan:** `Map<name, Tool>` sekali per batch. |
| E-18 | LOW | `src/tools/bash.ts:539-540` | `job.chunks.slice(cursor)` tidak membuang chunk lama → array lama ditahan sampai job dihapus. **Perbaikan:** `splice(0, cursor)`. |
| HIP-1 | — | `src/agents/pool.ts:36-40` | Race: listener abort dihapus sebelum `resolve()`, bisa menjalankan `fn()` dengan signal sudah aborted. Perlu `signal.aborted` check. |
| HIP-2 | — | `src/policy/executor.ts:203-211` | Satu bash unkeyed memaksa seluruh batch serial — disengaja untuk safety, trade-off. |

## 18. Efisiensi I/O, penyimpanan & layanan panjang

| ID | Sev | Lokasi | Masalah |
|---|---|---|---|
| E-19 | **HIGH** | `src/telemetry/trace.ts:164-177,194-210` | `writeTrace`/`writeStepTrace`: append → `chmod` → `rotateFile` yang **membaca seluruh JSONL** tiap event. Sesi 500 tool = 500× baca penuh (O(N²)); `TRACE_MAX_LINES=1000` berarti 999/1000 pembacaan sia-sia. **Perbaikan:** counter baris in-memory, chmod sekali saat file dibuat. |
| E-20 | **MED-HIGH** | `src/daemon/host.ts:174-177,198-209` → `discovery.ts:91-109,142-146` | Heartbeat 5 dtk menulis lease + `execFileSync("icacls", …)` **sinkron** tiap kali → ~12 subprocess/menit mem-blok event loop. **Perbaikan:** ACL sekali per path (Set) atau async. |
| E-21 | MED | `src/session/checkpoint.ts:183-185,212-220,471-507` | Manifest dibaca+JSON.parse lalu `JSON.stringify(...,null,2)` ditulis ulang penuh tiap checkpoint + fsync + chmod. **Perbaikan:** JSONL append-only / indeks inkremental. |
| E-22 | MED | `src/repo/repomap.ts:451-463,244-257,425-443,272-283` | Cache-miss: file yang sama dibaca dua kali (`signature()` lalu `readSourceContents()`), `new RegExp` per pasangan file×basename, 17× `statSync` per `loadRepoMap`. **Perbaikan:** kembalikan contents dari signature; cache regex per basename. |
| E-23 | **HIGH** | `src/memory/vector.ts:166-278` | Hanya `journal_mode` yang di-guard `initializedPaths`; DDL + `PRAGMA table_info` + ~15 pengecekan kolom + index + FTS + trigger + 2 count + chmod **dijalankan ulang tiap open**. Hampir semua fungsi ekspor membuka DB baru. **Perbaikan:** pindahkan blok `:194-268` ke dalam guard (seperti `task/db/schema.ts`). |
| E-24 | MED | `src/mcp/client.ts:158-170,184-190,201-208,594-643` | `verify()` per tool saat discover → `persist()` tulis+sort+rename seluruh file pin tiap tool baru → O(N²) byte. **Perbaikan:** bulk-pin + satu `persist()`. |
| E-25 | MED (biaya disengaja) | `src/session/journal.ts:660-678` | 2 fsync per tool mutasi (intent + terminal) + 1 saat finalize. **Jangan dihapus** tanpa keputusan kontrak §10; opsi: group-commit dua baris dalam satu sync. |
| E-26 | MED | `src/session/shadow-git.ts:299-314` | Restore: `git ls-tree` **satu subprocess per path** (2N untuk rename). **Perbaikan:** satu `git ls-tree -r` + Set. |
| E-27 | MED | `src/session/shadow-git.ts:129-169,226-243,280` | Snapshot checkpoint ≈5 git spawn; `ephemeralTree` mengulang 4, restore menambah 5–8. `gitDir`/`gitFilterNeutralizers` stabil → cache per cwd. |
| E-28 | MED | `src/daemon/framing.ts:46-58`; `src/lsp/client.ts:374-390` | `Buffer.concat` per chunk → frame 8 MiB dalam potongan 64 KiB ≈500 MB salinan/frame. **Perbaikan:** chunk-list + satu concat saat frame lengkap. |
| E-29 | MED | `src/daemon/subscription.ts:158-164` → `server.ts:638` | `takeFirst()` drain seluruh antrean lalu push ulang N-1 per event → O(N²) (512 item ≈130k operasi/siklus). **Perbaikan:** ring buffer / head index. |
| E-30 | LOW (hipotesis) | `src/lsp/client.ts:88-90,241-257,411-421` | `opened`/`diagnostics` tanpa cap, dibersihkan hanya di `stop()`/`restart()`. Perlu profil memori sebelum diubah. |

## 19. Kritik efisiensi lintas lapisan

1. **Biaya dibayar di tempat yang salah.** Startup membayar graph modul penuh untuk perintah ringan (E-1), one-shot membayar TUI (E-4), tiap tool call membayar scan sandbox (E-9) dan jail realpath (E-13). Pola umum: inisialisasi eager + tidak ada cache per-sesi.
2. **Rotasi/validasi tanpa counter.** Telemetry (E-19), MCP pins (E-24), manifest checkpoint (E-21) membaca/menulis ulang seluruh file hanya untuk menambah satu baris. Solusinya seragam: hitungan in-memory + append-only.
3. **Migrasi DB tidak diguard konsisten.** `task/db/schema.ts` dan `session/db/schema.ts` sudah benar; `memory/vector.ts` (E-23) belum — ini inkonsistensi arsitektur, bukan sekadar optimasi mikro.
4. **Subprocess sinkron di jalur hangat.** `icacls` tiap heartbeat (E-20), PowerShell DPAPI per provider (E-3), `ls-tree` per path (E-26), probe sandbox (E-7). Semua mem-blok event loop yang sama dengan TUI.
5. **Struktur data O(n²) yang tersembunyi.** `Buffer.concat` framing (E-28), `takeFirst` (E-29), history dispatch (E-12), pin MCP (E-24), telemetry (E-19) — semuanya terlihat "satu operasi" di level API.
6. **Trade-off sadar perlu dibedakan dari bug.** 2 fsync journal (E-25) dan serialisasi batch karena bash (HIP-2) adalah keputusan durabilitas/safety — jangan dioptimasi tanpa keputusan kontrak.

## 20. Urutan eksekusi efisiensi (dampak per usaha)

1. **E-19** (counter telemetry) + **E-9** (cache mask) + **E-23** (guard DDL vector) — tiga perbaikan kecil, dampak harian terbesar, semua Hot path.
2. **E-2** (jangan await update) + **E-3** (secret paralel) + **E-1** (entrypoint ringan) — startup interaktif.
3. **E-20** (ACL sekali) + **E-26** (batch ls-tree) + **E-27** (cache git stabil) — kurangi spawn sinkron.
4. **E-11, E-10, E-12** — otorisasi, hook, cache unbounded.
5. **E-24, E-21, E-28, E-29** — rewrite file & struktur data O(n²).
6. **E-13…E-18, E-22, E-30** — mikro-optimalisasi; lakukan hanya jika profil menunjukkan.
7. Jangan menyentuh **E-25** / **HIP-2** tanpa keputusan kontrak durabilitas/safety.

Catatan klaim: angka ms di §15 adalah hasil eksekusi nyata; sisanya estimasi dari inspeksi statis. Gate belum dijalankan ulang pada checkout ini.

---

# Evaluasi ulang & Rencana Remediasi Lengkap (setelah riset putaran kedua)

Checkpoint evaluasi: `643f4b3`. Metode: 4 agen riset paralel — evaluasi artefak historis,
perancang perbaikan UI, perancang perbaikan I/O-startup, dan **red team** yang menguji
klaim audit saya sendiri — plus pengukuran skalabilitas transkrip (`.audit/transcript-scale-probe.ts`).
Tidak ada kode runtime yang diubah. Bagian ini **mengoreksi** bagian 1–20 di atas; bila
bertentangan, pakai bagian ini.

## 21. Inventarisasi & evaluasi artefak `.audit/`

| Artefak | Checkpoint | Status evaluasi |
|---|---|---|
| `code-audit-e6e50a7.md` | `e6e50a7`, v0.25.0 | **Historis.** Temuan A1–A8 sudah diperbaiki di `643f4b3` (rincian §21.1). Jangan dimasukkan ke rencana eksekusi sebagai bug aktif. |
| `audit-remediation-plan.md` | v0.25 → v0.33 | **Historis, klaim sebagian terverifikasi.** Struktur kode + test regresi A1–A8 memang ada. Angka "97 pass" adalah klaim dokumen, bukan hasil eksekusi agen. A3 native macOS/Linux tetap belum terverifikasi. |
| `OBSERVATION.md` | sesi `17b6a5ff`, 15 Nov | **Historis/catatan sesi.** T-003/004/005/008/009 sudah FIXED; T-001/006/007 stale atau by-design; T-002/T-010 di luar scope. T-007 (context window) dan T-010 (token) **eksplisit di luar scope** efisiensi sumber daya. |
| `AUDIT-ROUND2.md` | `643f4b3` | **Valid dengan koreksi.** 3 temuan putaran 1 ditarik (workflows, tool registry, gate 5-vs-9). Satu flake `phase6z` tercatat. Detail scroll §8 menjadi dasar S-3. |
| `temuan.md` | `1aaca14` | **Data mentah scroll, valid historis.** Angka §2 bukan hasil checkout ini. Berisi detail tambahan: `getStatus()` berulang per frame (§5.3), draft 5000 char = 2,94 ms/ketikan (§5.2), rw 16 ms benar (§5.5). |
| `SCROLL-PERF.md` | — | **Tidak ada lagi.** Dipindah ke `.minicode/.trash/2685fe12-SCROLL-PERF.md` oleh sesi Minicode global 20:23. Rujukan diganti ke `temuan.md`. |
| `AUDIT-CONSOLIDATED.md` | `643f4b3` | Dokumen ini. Koreksi red team tercantum di §21.3. |

### 21.1 Status A1–A8 (audit v0.25) — semua FIXED di `643f4b3`

| ID | Bukti perbaikan | Test penjaga |
|---|---|---|
| A1 revokasi izin | `session.ts:792,800,837-859,885,908` `authorizationVersion`; re-check final di `executor.ts:100-117` tepat sebelum `tool.execute` | `authorization-revocation.test.ts:5-61` (8 kasus) |
| A2 cwd background | `bash.ts:307-308,335,411` `effectiveCwd` | `background-cwd.test.ts:12-49` |
| A3 abort OS sandbox | `os.ts:67,166,189,198,211-292` signal + killGroup + cleanup | `os-sandbox-abort.test.ts` — **test turunan `skipIf(!osSandboxAvailable())` terlewat di Windows** |
| A4 input CSI rusak | `prompt-engine.ts:410,432,781-799,843,858-864` | `input-recovery.test.ts:26-108` |
| A5 modified key → Escape | `prompt-engine.ts:1067-1068,815` → `ignore` | `input-recovery.test.ts:110-137` |
| A6 abort executor | `executor.ts:184-211,275-335` rantai `drained` (ekuivalen dengan "karantina") | `executor-abort-matrix.test.ts:13-62` |
| A7 kompaksi feasibility | `compaction.ts:284-303,328-353` final estimate + error eksplisit | `compaction-audit.test.ts:25-58,266-285` |
| A8 tokenizer opt-out | `tokenizer-registry.ts:20-23,48,75` guard sebelum cache/fetch/disk | `tokenizer-registry.test.ts:50-61` |

### 21.2 Status T-001…T-010 (observasi lama)

| ID | Status | Catatan |
|---|---|---|
| T-001 loop guard | STALE sbg bug | Guard 15 read-only masih ada (`no-progress.ts:241-246`) tapi diperkuat sub-agent 8 + eskalasi. Perilaku model, bukan defect kode. |
| T-002 path artefak karangan | STALE | One-off agent error, bukan kontrak produk. |
| T-003 tool result dipangkas | FIXED | `compaction.ts:307-325` mempertahankan hasil tool; sentinel lama tetap di `microcompact.ts` (opt-out token). |
| T-004 timeline `ts` identik | FIXED | `persistence.ts:751-776` stamp per baris + monoton. |
| T-005 `updated_at` mandek | FIXED | `persistence.ts:2656-2661`. |
| T-006 jurnal sub-agent kosong | BY DESIGN | File dibuat eager; jurnal mencatat mutasi, bukan semua tool call (`journal-child.test.ts:350-378,439-477`). |
| T-007 context window 131k | STALE + OUT OF SCOPE | Konstanta `context-window.ts:16` masih 131072; overlay + `capacityHint` sudah ada. Masuk workstream token, bukan rencana ini. |
| T-008 50 langkah | FIXED | `constants.ts:199` = 200; sub-agent 50 disengaja; tangga eskalasi 200→6400. Ini menjelaskan BUG-2: "50" kini cap kernel/sub-agent, bukan default. |
| T-009 503 mati tanpa restart | FIXED | `cli/setup.ts:2829-2929` auto-resume + `recovery-budget.ts` (default on, opt-out env). |
| T-010 metrik historis | OUT OF SCOPE | Baseline, bukan bug tunggal. |

### 21.3 Koreksi red team terhadap temuan saya (wajib dipakai)

| ID | Verdict | Koreksi |
|---|---|---|
| PERF-1 | BENAR, 2 koreksi | (a) angka 1–3 ms adalah **target**, bukan hasil; (b) bug batas gulir hanya untuk baris dengan panjang antara `chatCols` dan `cols` — dua dataset berbeda di probe (baris pendek untuk latensi, baris panjang untuk batas gulir). |
| S-1 | BENAR, detail salah | `live` **sudah punya** cache internal (`sidebar-model.ts:217-234`); yang tak ter-cache = rewrap thinking+activity. Detik Live beku justru karena `sourceKey` App tanpa detik (S-7), bukan karena tak ada cache. |
| S-3 | BENAR, dampak diremehkan | `runningRows()` mati **kapan pun sidebar aktif (≥100 kolom)**, jadi 100–167 kolom (default laptop) = tool in-flight tak terlihat di chat maupun sidebar. Naikkan ke HIGH; gabung dengan ROUND2 §8 (opsi A–D masih menunggu keputusan pemilik). |
| E-9 | PERLU KOREKSI scope | Hanya berlaku saat `MINICODE_SANDBOX` = docker/os/seatbelt/bwrap (`bash.ts:343-375`). Default tanpa sandbox tidak memanggilnya. Tetap P0 bila sandbox wajib di deployment Anda. |
| E-19 | PERLU KOREKSI dua arah | Fire-and-forget (`void`, async) → contention I/O, **bukan blocking sinkron**. Tapi ada **2 write per step** (`execution:completed` + `step:completed`), jadi ~2N read, bukan N. Opt-out `MINICODE_TELEMETRY=0`. O(N²) `rotateFile` benar. |
| E-3 | PERLU KOREKSI desain | `Promise.all` atas `spawnSync` tetap serial — harus async `spawn`/`execFile` atau satu spawn PowerShell untuk semua provider. Secret wajib lewat stdin, bukan argv. |
| E-20 | PERLU KOREKSI desain | `writeAtomic` pakai `tmp + renameSync` → inode baru, jadi ACL lama tak melekat. `Set` saja tidak cukup; opsi aman: jangan `hardenAcl` untuk lease (bukan secret), tetap untuk endpoint. |
| BUG-2 | BENAR, cakupan lebih luas | Salah juga di `docs/concepts.md:15`, `docs-en/cli.md:57`, `docs/getting-started.md:88`; `docs*/exec.md` sudah menandai known-stale. Bangun help dari konstanta + sinkronkan 4 doc. |
| HIPOTESIS tamper | Naikkan prioritas | BUG-8 + `.catch(() => {})` di `cli/setup.ts:2571` + `if (!baseline) combined.add(rel)` di `verification.ts:1788` = false positive integritas. Perlu repro (repo tanpa git / git timeout). |
| PERF-4 | Koreksi ruang | Hanya berisiko saat `projectAll` memakai jalur cache idle (thinking/running/panel/activityFold/sidebarTurnNames kosong) — turunkan ke LOW-MED. |

Duplikat yang digabung: **S-4 ≡ PERF-1**, **S-10 ≡ BUG-5**, **S-11 ≡ PERF-2 ≡ BUG-4**
(satu cacat "composer dua-lebar" di `app.ts:2436 / 2476 / 2562`), **BUG-2 ≡ HIGH-1**,
**BUG-3 ≡ HIGH-2**, **BUG-10 ≡ LOW-13**, **S-3 ≡ ROUND2 §8**, **PERF-1 ≡ `temuan.md` §3–4**.

### 21.4 Pengukuran tambahan putaran kedua

```
bun run .audit/transcript-scale-probe.ts   (lebar 120/81 bergantian)
  1000 baris : 129,11 ms/panggilan
  5000 baris : 683,43 ms/panggilan
 20000 baris : 743,99 ms/panggilan   <- plateau karena TRANSCRIPT_CAP=5000
 50000 baris : 750,88 ms/panggilan      (transcript.ts:225)
```

Artinya: pada sesi macet Anda, satu frame ≈ 2×750 ms (dua lebar) + sidebar ≈1 s.
Dengan repaint 400 ms, event loop tidak pernah idle → timer 15 dtk ripgrep baru jalan
~13 menit kemudian. Ini ** Penyebab langsung** gejala "audit 1 jam belum selesai".

## 22. Status temuan aktif setelah evaluasi

**AKTIF — P0 (dampak besar, aman dikerjakan):**
`PERF-1` (+S-4), `S-1`, `S-2`, `S-3`(HIGH), `E-19`, `E-23`, `BUG-1`, `BUG-2`, `BUG-3`.
`E-9` masuk P0 **bila** sandbox aktif; default tidak.

**AKTIF — P1/P2:** `E-1`, `E-3` (async runner), `E-11`, `E-10`, `E-12`, `E-24` bulk-pin,
`E-26`, `E-27`, `E-28`, `E-29`, `S-5…S-9`, `S-11`, `S-12`, `E-4…E-8`, `E-13…E-18`, `E-21`, `E-22`, `E-30`.

**BUTUH KEPUTUSAN OWNER (jangan eksekusi dulu):**
- `E-2` — urutan auto-update vs sesi, timeout 1800 ms, restart di tengah TUI. Menyentuh output ⇒ update `TERMINAL_CONTRACT.md` + peta test.
- `E-20` — hapus ACL lease ⇒ mengubah klaim `docs/security.md` (perlu tanda tangan owner).
- `P1.6` — Live fallback di Activity untuk 100–167 kolom ⇒ perubahan FROZEN kontrak.
- `P2.2` — positionBar/marker sidebar ⇒ perubahan visual FROZEN kontrak.
- `E-24` opsi lanjut (JSONL+fsync untuk pin) ⇒ perubahan durabilitas.

**JANGAN DISENTUH:** `E-25` (2 fsync jurnal) dan `HIP-2` (serialisasi batch karena bash) —
keputusan durabilitas/safety sadar. Juga jangan turunkan ambang `coverage-gate.ts` / naikkan
budget `pack-budget.ts`.

**OUT OF SCOPE (workstream token/biaya, sesuai instruksi):** T-007, T-010, context window,
pricing, kompaksi hemat token.

## 23. Rencana eksekusi — tiga jalur, satu kandidat akhir

### Jalur A — Render TUI / transkrip / sidebar (prioritas utama; ini yang menyembuhkan sesi macet)

**A-P0 — hilangkan penggandaan kerja per frame** (tanpa perubahan kontrak)
1. `app.ts`: tambah `chatWidth()` → `lastChatCols ?? lastLayout?.chatCols ?? fallback`;
   ganti `wrappedLength(process.stdout.columns)` di `scrollBy:1581`, `scrollRows:1610`,
   `jumpEdge:1632`, `followTail:1667`, `setLine`, `clearView`. **Lakukan sebelum cache.**
2. `transcript.ts`: `projectedBase`/`committedProjection` → `Map<width, Entry>` LRU 2–3;
   `rowCache` → per `(id,width)`; hapus entri saat evict. **Jangan sentuh `pendingRowMemo`.**
3. `transcript.ts:setSidebarActive` — masukkan flag ke kunci cache / invalidate.
4. `app.ts:paint` — `frameStatus` memo per frame; `isBusy()` baca memo; teruskan `busy`
   eksplisit ke `viewportHeight`, `menuRows`, `menuHeight`, cache-key sidebar.
5. `app.ts:2436` — pakai `indicatorGeom.chatCols` untuk `composerRows`; satukan dua
   `sidebarGeometry()` jadi satu.
6. `sidebar-model.ts` — cache `thinking` per `(rev,w)`, `activity` per `(rev,w,detik)`;
   `maxScroll`/`syncFollow` jangan memicu rewrap.

Gate A-P0: `tsc && lint && bun test test/tui-* test/sidebar-* test/perf-no-quadratic.test.ts`
+ `bun run scripts/audit-scroll-probe.ts --cols=120`; target 784 → ~1–3 ms/frame,
lebar log hanya `w=81`, ekor gulir tercapai. Lalu `gate:fast`.

**A-P1 — sidebar benar & data hidup** (tanpa perubahan kontrak)
1. Sumber per pane: thinking→`geom.width`, activity→`logWidth` saat split, live→`liveWidth`.
   `sourceKey` memuat `logWidth`+split.
2. `SidebarModel.frame()` sekali per frame mengembalikan baris + `maxScrollByPane`;
   `syncFollow` terima nilai hitung. Target 1 snapshot-equivalent/frame.
3. `childCount` turunan: `childLinks: Map<parentId,Set<childId>>` + `linkLiveChild()`;
   hapus `new Set(...)` di `tool.started`; naikkan `rev` saat child masuk.
4. Detik hidup: `sourceKey` memuat detik ATAU App pakai `liveRows()` (lebih rapi).
5. Rebase scroll: chat = anchor `(id,offset)` via `pointAt`/`indexOfPoint`; sidebar =
   fraksi `scroll/maxScroll`; evict mengurangi `scrollBack` via hook `onEviction`
   (inject lewat `TranscriptOptions`, tetap patuh batas lapisan).

Gate A-P1: `gate:fast` + `bun run bench:typing` (debit ketikan pulih dari 4 tombol/dtk).

**A-P2 — proyeksi inkremental (satu-satunya yang benar-benar menyelesaikan sesi raksasa)**
Struktur baru `WidthProjection` di `transcript.ts`: `{width, rows, counts[], fence, blankRun,
appendsSeen}` dalam `committedByWidth = Map<width, WidthProjection>` LRU 2–3.
- `applyAppend()` / `applyEvict()` / `replaceAt()` / `projection(width)`;
  `advanceFence()` diekstrak dari `fenceTracker()` (satu sumber logika).
- `wrappedLength()` → O(1); `viewport()` → O(height); `projectAll()` dipertahankan
  untuk kompatibilitas test/bench tapi bukan dipanggil viewport.
- Risiko: fence di batas replace, blank-run normalize, anchor setelah resize, counts vs rows
  saat evict — semuanya masuk test wajib.

Gate A-P2: `bun test test/transcript-incremental.test.ts test/tui-transcript.test.ts`
+ `bun run bench:render` + probe skala. Target: frame <50 ms, CPU idle <0,2 core,
cold projection ≤500 ms sekali.

### Jalur B — I/O, startup, subprocess

**B-P0 (aman sekarang):** `E-19` counter rotasi (counter hanya pemicu; rotasi tetap baca file
nyata & `slice(-1000)` karena `purgeSessionTraces` bisa mengubah file; slack 64–128 baris;
chmod 1×/file/proses; `rotationLocks` dipertahankan) · `E-9` Tahap 1 `readdirSync(withFileTypes)`
(target ≤3 ms/call; **Tahap 2 cache baru dengan TTL pendek + invalidasi `.env` + fail-closed**)
· `E-23` guard DDL vector via `PRAGMA user_version` (jangan hapus WAL retry/chmod 0600) ·
`BUG-1` replacer fungsi · `BUG-2` help dari konstanta + 4 doc.

**B-P1 (startup):** `E-1` entry ringan/`--help` dari modul ringan (**index.ts tetap entry**,
jangan ganti `bin`; jaga urutan `dispatch` sebelum help; test parity `--help/--json/-v`)
· `E-3` `SecretRunner` async + `Promise.allSettled`, urutan provider dipertahankan, secret
via stdin, lock & timeout 15 dtk tetap · `E-11` hapus `refresh()` per-call · `E-10` sanitasi
env sekali · `E-12` LRU untuk recovery/dispatch.

**B-P2 (subprocess & struktur data):** `E-26` batch `git ls-tree -r -z` per 200 path
(jail check tetap sebelum lookup; chunk gagal = throw) · `E-27` cache `gitDir` &
`gitFilterNeutralizers` per cwd (jangan cache `write-tree`/`GIT_INDEX_FILE`; `GIT_SAFE_BASE`
tiap spawn) · `E-24` bulk-pin + satu `persist()` · `E-28` chunk-list framing + batas `len`
LSP · `E-29` ring buffer `BoundedQueue` · `BUG-3` (paling akhir, setelah SHA final).

Gate tiap jalur: 5 gate minimum, lalu `gate:fast` penuh pada P1/P2.

### Jalur C — keputusan owner (blokir sebelum eksekusi)

`E-2`, `E-20`, `P1.6`, `P2.2`, `E-24` lanjutan. Jangan mulai tanpa tanda tangan.

## 24. Test & pengukuran

| Area | File | Assertion kunci |
|---|---|---|
| Scroll width | `test/tui-scroll-width.test.ts` (baru) | `End` → `scrollBack === wrappedLength(chatCols)-viewH` @120 kol; source-scan tanpa `wrappedLength(process.stdout.columns)` |
| Perf regresi | `test/perf-no-quadratic.test.ts` (modifikasi) | ≤2 `committedRows`/frame saat 120↔81; 1× `getStatus`/frame; cache sidebar ada; `pendingRowMemo` tidak dihapus |
| Sidebar width | `test/sidebar-width.test.ts` (baru) | split 168 kol: 84/84 char tidak terpotong (bukan 37/84); `sourceKey` berubah saat split toggle |
| Sidebar model | `test/sidebar-model.test.ts` | 2× `snapshot(81)` tanpa `rev` → wrap 1×; `syncFollow` tak menaikkan hitungan snapshot; `childCount` muncul setelah `linkLiveChild` |
| Inkremental | `test/transcript-incremental.test.ts` (baru) | 1000 append → rebuild penuh ≤1; `wrappedLength === view().length`; evict di cap 5000; selection anchor selamat; fence + blank run |
| Telemetry | `test/telemetry*.test.ts` | 500 event → `readFile` rotasi ≤5× (bukan ~1000×), chmod 1/file; baris akhir ≤1000+slack; scrub tetap |
| Vector | `test/memory-vector*.test.ts` | 10× open → DDL/`table_info`/FTS sekali; DB lama termigrasi; chmod 0600 tetap |
| Skill/help | `test/skills.test.ts`, `test/cli-*.test.ts` | `$&`, `` $` ``, `$'`, `$1` literal; help == `DEFAULT_SESSION_MAX_STEPS` |
| Mask | `test/sandbox.test.ts` | `withFileTypes` hasil sama; symlink `.env` terdeteksi; invalidasi bila cache dipakai |
| Git/MCP/daemon | `test/shadow-git*.test.ts`, `test/mcp*.test.ts`, `test/daemon-*.test.ts` | `ls-tree` 1/chunk; pin persist 1×/discover; frame 8 MiB dari chunk 64 KiB benar; `takeFirst` N=512 urutan sama & O(N) |

Probe: pakai `scripts/audit-scroll-probe.ts`, `.audit/sidebar-content-probe.ts`,
`.audit/transcript-scale-probe.ts`; tambah `.audit/render-scale-probe.ts` (di luar `files[]`,
tidak mengubah `gate:pack`) dengan argumen `--messages=2395 --events=16333 --chars=6170000`.

Target angka (**target, belum terukur** — verifikasi dengan probe yang sama):

| Metrik | Baseline | Target |
|---|---|---|
| Ketik @120 kol, 5000 baris | 784 ms | ≤3 ms |
| Sidebar 3× snapshot/frame | ~965 ms | ≤1 ms |
| `bun cli/index.ts --version` | ~125 ms | ≤30 ms |
| Mask scan (sandbox aktif) | 15,44 ms | ≤3 ms |
| Telemetry rotasi / 500 event | ~1000× baca | ≤5× |
| `icacls` heartbeat | ~12/menit | 0 (lease), 1/start (endpoint) |
| `ls-tree` restore | 2N spawn | 1/chunk(200) |
| Frame sesi raksasa | >1 s | <50 ms |

## 25. Definition of done & batas klaim

1. Satu kandidat akhir, **semua gate dijalankan ulang pada commit yang sama**:
   urutan 5 perintah + `gate:fast` (`audit:harness`, smoke build/package, CI relevan).
2. Ulangi test flake yang gagal secara terpisah sebelum menyimpulkan regresi; rujuk daftar
   flake di `AGENTS.md` dan flake `phase6z` di `AUDIT-ROUND2.md`.
3. Jangan klaim "hijau/release-ready" berdasarkan angka historis v0.33.0 atau hasil sesi lain.
4. Jangan menurunkan ambang `scripts/coverage-gate.ts` atau menaikkan budget
   `scripts/pack-budget.ts`.
5. Setiap perubahan perilaku terminal (P1.6, P2.2, E-2) wajib update
   `docs/TERMINAL_CONTRACT.md` + peta test; perubahan dependensi antarlapisan wajib update
   `docs/architecture.md`.
6. A3 native macOS/Linux tetap **terbuka** — host Windows tidak bisa membuktikannya.
7. Rencana ini **bukan roadmap pemilik**; `ROADMAP.md` tidak tersedia di checkout.

---

# Eksekusi remediasi — catatan hasil (kandidat gabungan)

Status: **dikerjakan** oleh 3 agen implementasi paralel + integrasi auditor. Belum di-commit.
`gate:fast` final sedang dijalankan pada kandidat yang sama; jangan klaim hijau sebelum selesai.

## 26. Yang sudah diimplementasikan

### Jalur A — render/transkrip/sidebar (Agen A + integrasi)
- `app.ts`: `chatWidth()`/`lastChatCols` untuk semua navigasi; `frameStatus` 1×/frame
  (integrasi: dikosongkan setelah paint agar handler tidak memakai status basi);
  composer & indikator satu lebar; `sidebarPaneGeom()`, `sidebarActivityExtra()`,
  `rebaseSidebarScroll()`; `SidebarModel.frame()` 1×/frame; `sourceKey` memuat
  `logW`, flag split, detik.
- `transcript.ts`: LRU multi-lebar (`committedByWidth`, `projectedBaseByWidth`),
  `rowCache` per `(id,width)`, `WidthProjection` inkremental dengan `counts[]`,
  `fenceStates[]`, `blankRun`, `applyAppend/applyEvict/replaceAt`, `wrappedLength` O(1),
  `viewport` O(height). **Integrasi menambahkan**: penanganan marker eviction (rebuild
  sekali saat marker pertama) + gate `dirty` hanya bila opener/closer fence ikut terbuang
  — tanpa ini tiap append di cap 5000 memicu rebuild penuh. Test: `sustained cap`.
- `sidebar-model.ts`: cache thinking `(rev,w)`, activity `(rev,w,detik)`, live `(rev,w,detik)`;
  `frame()`, `liveRows()`, `linkLiveChild()`; inset 1 kolom untuk spasi `pane()`.
- `sidebar.ts`: `positionBar` setelah collapse, marker tidak memotong isi, split adaptif.
- **Integrasi menambahkan** `sidebarLiveVisible(geom, liveCount)` di `sidebar-layout.ts`
  — Live hanya dirender bila ada tool berjalan; bila tidak, Activity memakai lebar penuh
  (menghilangkan setengah sidebar kosong). Dipakai konsisten oleh renderer, source wrap,
  scroll, wheel, Alt+PgUp, Home/End.

### Jalur B — I/O/startup (Agen B + integrasi)
- Telemetry: counter rotasi + slack 96; **integrasi** menambah kalibrasi first-touch agar
  file yang sudah berisi 1005 baris tetap terpotong ke 1000 (test C16 lama).
- Mask sandbox `withFileTypes`; vector DDL via `PRAGMA user_version`; otorisasi dirty-check;
  hook env sekali; recovery LRU; dispatch ring buffer; keystore async via `spawn`
  (secret via stdin); provider `Promise.allSettled` berurutan; ACL lease vs endpoint;
  framing chunk-list; LSP frame limit; queue ring buffer; `ls-tree` batch 200;
  cache gitDir/filter; MCP bulk-pin; baseline cache LRU + warning git gagal.

### Jalur C — CLI/docs (Agen C)
- `cli/entry.ts` + `cli/help.ts`; `cli/minicode.js` → entry; help default 200 dari konstanta;
  `renderSkill` replacer fungsi; `AGENTS.md` status HEAD; 4 dokumen max-steps;
  `TERMINAL_CONTRACT.md` (3 klausa baru + peta test); `docs/security.md` ACL lease.
- Auto-update REPL tidak lagi menahan sesi (dipindah setelah `createCliSession`, sebelum input pertama).

**Sengaja tidak dikerjakan:** E-25 (fsync jurnal), HIP-2 (serialisasi batch bash),
pin MCP append-only+fsync, dan penurunan ambang gate.

## 27. Pengukuran pasca-perbaikan (probe nyata)

| Metrik | Sebelum | Sesudah |
|---|---|---|
| Ketik 1 char @120 kol, 5000 baris | 784,07 ms | **6,94 ms** (p95 8,76) |
| Wheel @120 kol, 5000 baris | 778,18 ms | **24,75 ms** (16 ms coalescing + paint) |
| PgUp @120 kol, 5000 baris | 786,92 ms | **7,90 ms** |
| `wrappedLength` 20000/50000 baris | ~750 ms | **0,00 ms** p50 (max 0,06) |
| `snapshot()` sidebar (2000+200k) | 329,95 ms | **0,001 ms** p50 |
| 3× maxScroll/frame | 964,54 ms | **0,002 ms** p50 |
| `bun cli/minicode.js --version` | ~125 ms | **~30 ms** warm |
| Split 168 kol: Activity | 37/84 char terpotong | **40/40 char utuh** (wrap di `logWidth-1`) |
| Split tanpa live tool | setengah sidebar kosong | Activity lebar penuh |
| Lebar yang diminta probe scroll | w=120 + w=81 | **hanya w=81** |

Catatan: probe sidebar lama memakai pola wrap lama; sudah diperbarui ke pola App baru.
Angka adalah batas bawah CPU in-process dengan instrumentasi aktif (bukan angka PTY produksi).

## 28. Gate yang sudah dijalankan pada kandidat gabungan

| Gate | Hasil |
|---|---|
| `bun x tsc --noEmit` | 0 error |
| `bun run lint` | 871 file, 0 error |
| `bun run gate:pack` | 342 file, 4955 KB, 23 pass / 0 fail (budget 5000 KiB) |
| `bun run gate:bash` | 85 pola / 29 perintah, bypass 0/85, over-block 0/29 (dua mode) |
| `bun run bench:smoke` | resolve 13/13 |
| `bun run gate:telemetry` | 12/15, rate 0.80 ≥ 0.3 |
| `bun run audit:harness` | 73 pass / 0 fail / 2 advisory |
| Test terarah UI (8 file) | 141 pass / 0 fail |
| Test terarah I/O (27 file, agen) | 268 pass / 2 skip / 0 fail |
| Test terarah CLI (agen) | 61 pass / 0 fail |
| Suite penuh (putaran sebelum perbaikan akhir) | 6689 pass / 33 skip / 4 fail / 1 error |
| `bun run gate:fast` final | **HIJAU** — lihat §29 |

Kegagalan suite putaran sebelumnya sudah diperbaiki: 3 karena test masih membaca teks HELP
di `cli/index.ts` (kini `cli/help.ts`), 1 karena rotasi telemetry (first-touch), dan 2 flake
`cli-session.test.ts` (timeout 5 dtk under load — lolos 2,4 dtk bila dijalankan sendiri).

## 29. Hasil `gate:fast` final (satu kandidat yang sama)

```
bun x tsc --noEmit                 0 error
bun run lint                       871 file, 0 error
bun test                           6693 pass · 33 skip · 0 fail
                                   434258 expect() · 6726 test / 540 file · 1349,99 s
bun run gate:coverage              funcs 90.38% (min 87) · lines 91.10% (min 86)
                                   lantai per-berkas: 19/19 modul kritis hijau
bun run gate:pack                  342 file, 4955 KB, 23 pass / 0 fail (budget 5000 KiB)
bun run gate:bash                  auto + allowlist: bypass 0/85, over-block 0/29
bun run bench:smoke                resolve 13/13
bun run audit:harness              73 pass / 0 fail / 2 advisory
bun run gate:telemetry             12/15, rate 0.80 (target 0.3)
-> exit 0
```

Catat flake: dua run `gate:fast` sebelumnya gagal karena test subprocess yang **berbeda**
tiap kali (`exit-codes`, `cli-session`, `p14-open-work`) mengenai timeout default Bun
**5000 ms** — `bunfig.toml [test] timeout = 15000` ternyata tidak dipakai Bun 1.4.3 untuk
test individual (diverifikasi: `bun test --help` menyebut default 5000). Perbaikan:
`package.json` script `test` kini `bun test --timeout 15000` (menyamakan niat bunfig &
`coverage-gate.ts` yang sudah memakai `--timeout 30000`). Bukan penurunan ambang gate.
Dengan itu run keempat hijau tanpa flake.

## 30. Putaran stabilitas layout (setelah keluhan jitter Live)

Audit lanjutan: 2 agen riset (sidebar & transkrip) + verifikasi auditor. Semua perubahan di bawah sudah diterapkan dan test terarah 110 pass.

| Sumber geseran | Perbaikan |
|---|---|
| Split diikat ke jumlah live tool → Activity bergeser | `sidebarLiveVisible(geom)` murni geometri; Live dipindah ke KANAN, Activity tetap KIRI; idle = baris `· idle` stabil |
| Marker `↑/↓ N more lines` sebagai baris isi → isi bergeser & baris terbaru hilang saat follow | Marker dipindah ke **baris judul (meta)**; `contentCap = capacity` penuh; baris terbaru selalu tampil |
| `liveOnTop` di 100–167 kolom: jumlah baris Live mengikuti jumlah tool → log naik-turun | Band Live **tetap 1 baris** dengan placeholder idle; `extraActivity = liveBand.length` |
| Prefix umur Activity `·4s` muncul/digit tumbuh → wrap count berubah | Slot prefix **lebar tetap 5 kolom** sejak awal (spasi untuk baris segar) |
| Meta Live `12s`/`·2c` panjangnya berubah → wrap count berubah | Slot durasi 5 + child 4 kolom, selalu ada |
| `liveSummaryRows()` 0↔2 baris & `flushActivityFold()` 3 baris → ekor lompat 1–2 baris tiap transisi tool→narasi | `flushActivityFold()` menulis **tepat 2 baris** (bukan 3). Net perubahan 0. Placeholder permanen **dicoba lalu dibatalkan** — mengotori `view()`/`wrappedLength` dan memecah 4 test dasar; ini pelajaran untuk prinsip minimalis |
| Marker eviction bertambah digit tanpa sinkron proyeksi | `replaceAt(ids[0])` setelah marker diperbarui |
| Composer/menu mengubah `viewH` → transkrip naik-turun | **Belum diubah** — butuh keputusan trade-off (lihat bawah) |

Kontrak FROZEN diperbarui di entri v0.33 poin 2 & 5: Live di kanan, split murni geometri, band 1 baris tetap di 100–167, prefix/meta lebar tetap, marker di judul, slot rekap tetap dua baris. Peta test: `test/sidebar-width.test.ts` (3 test baru: urutan pane, marker overflow, split stabil), `test/activity-fold.test.ts` (slot rekap).

**Keputusan tertunda (composer/menu):** `composerRows` 1–5 baris dan dropdown `/` 1–8 baris mengurangi `viewH`, menggeser transkrip 1–8 baris saat mengetik/paste. Kontrak v7.x baris 1367 menyatakan "Composer memakai tinggi tetap", tetapi implementasi variabel. Opsi: (a) reservasi `MAX_INPUT_ROWS` permanen — stabil tapi mengorbankan 4 baris transkrip; (b) overlay menu via `paintRegion` — stabil tapi menyentuh I20/I21 & mouse handling; (c) biarkan. Belum saya pilih tanpa arahan pemilik.

## 31. Batas klaim

- Belum ada commit. `AGENTS.md` diperbarui ke `643f4b3` + catatan working tree dimodifikasi.
- Jangan menyatakan release-ready sebelum `gate:fast` final selesai dan hijau pada kandidat ini.
- A3 native macOS/Linux tetap belum terverifikasi (host Windows).
- `docs/TERMINAL_CONTRACT.md` sudah diperbarui untuk 3 perubahan perilaku terminal.

