# Catatan Pengamatan — Proses Minicode (sesi `17b6a5ff`)

- **Pengamat:** MiMo (OpenCode) — read-only, tidak ikut campur ke proses agent.
- **Objek pengamatan:** sesi Minicode `17b6a5ff` (mode `EXECUTE`), remediasi audit harness → UI.
- **Mulai pengamatan:** 2026-11-15 11:37 WIB.
- **Sumber kebenaran linimasa:** `.minicode/journal-17b6a5ff.jsonl` (bukan kolom `ts` di DB — lihat T-004).

## Ringkasan (baca cepat)

1. **Context window asli `gpt-6-astra` (api.xingchiapi.com) ≈921–922 ribu token** —
   diukur empiris lewat probe biseksi langsung ke API: braket
   **[921.135, ≈922.636)**, presisi ±0,16% (metodologi + ledger 16 probe:
   [Metodologi pengukuran context window](#metodologi-pengukuran-context-window-bukan-tebakan)).
   Yang membuat Minicode hanya menampilkan ~100k adalah **fallback internal
   131.072 (`safe-default`)** karena provider tidak punya `contextWindows` —
   **bukan** batas provider. → T-007
2. **"Sering berhenti" karena dua hal berbeda:** batas `50 steps` per turn
   (4×, tapi selalu auto-restart) dan **503 dari provider yang mematikan turn
   TANPA restart** (1×, 12:12:56 WIB → sesi beku sejak itu). → T-008, T-009
3. Rekap: **16 kompaksi** (5 di antaranya timeout LLM compaction), 12 tool
   gagal, 5 tool ditolak, ≈16,7 juta token terbakar. → T-010
4. Temuan lain: loop-guard read-only (T-001), path artefak karangan (T-002),
   hasil tool terpangkas kompaksi (T-003), timeline DB rusak (T-004),
   `updated_at` menyesatkan (T-005), 73% jurnal sub-agent kosong (T-006).
5. **Protokol pengukuran hemat** (M7): presisi 0,16% tidak perlu untuk
   konfigurasi — **biseksi + berhenti di toleransi 5% → ±3% dengan ≈5 probe**
   (bukan 16); atau langsung probe nilai kandidat bulat (Tier 0, 1 probe);
   tangga ukuran umum 128k→1M hanya untuk menyediakan `hi`.

## Kondisi awal (11:37:09 WIB)

- Sesi **AKTIF**: jurnal 94.089 byte / 122 baris, baris terakhir `seq=175` `state=committed`,
  ditulis 11:37:08 (1 detik sebelum sampel).
- Kandidat proses agent: PID bun 16720 (mulai 09:31:09, CPU kumulatif ~270 dtk) —
  4 proses `bun` + 2 `node` berjalan saat sampel.
- DB: 159 pesan, 3 bertanda `is_error`, 5 sesi sub-agent anak `17b6a5ff`.
- Riwayat pesan sudah ter-kompaksi (pesan `seq=0` sudah berisi "Previous context:
  mechanical summary"), sesuai keluhan context window ~100k.

## Temuan

### T-001 — Loop guard terpicu: agent berputar read-only (11:37, dari DB)

`seq=125`: `permission error: [LOOP_GUARD kind=NO_PROGRESS reason=READ_ONLY_THRASHING
count=15] Exceeded 15 consecutive read-only tool calls without updating the plan...`
Dua sisi: **mekanisme proteksi bekerja** (bagus), tapi **agent sempat terjebak 15 call
baca-baca tanpa progres** (buruk) — pemborosan turn & konteks.

### T-002 — Asumsi path artefak salah (11:37, dari DB)

`seq=96`: `file not found: artifacts/remediation-gates.log` — agent membaca log gate
yang tidak ada di worktree (path karangan / artefak belum dibuat / sudah dibersihkan).

### T-003 — Kompaksi memangkas hasil tool dari riwayat (11:37, dari DB)

`seq=34`: `[hasil tool lama dipangkas: read_file 268 char, gagal. Jalankan ulang tool
ini bila isinya masih dibutuhkan.]` — konten asli hilang, agent dipaksa ulang baca.
Konsisten dengan keluhan context window ~100rb → kompaksi sering.

### T-004 — Timeline DB rusak: semua `ts` pesan identik (11:37, dari DB)

159 pesan `17b6a5ff` SEMUANYA ber-stempel `2026-11-15T04:06:15.154Z` (11:06:15 WIB)
sampai milidetik yang sama — termasuk `seq=0`. Ini pola rewrite massal (kompaksi atau
migrasi) yang menimpa waktu asli. **Konsekuensi: urutan waktu asli TIDAK bisa direkonstruksi
dari `messages.ts`; hanya jurnal yang punya linimasa jujur.**

### T-005 — `sessions.updated_at` tertinggal jauh dari aktivitas nyata (11:37, dari DB)

`updated_at` = 10:45:07 WIB, padahal jurnal masih menulis 11:37 WIB. Jangan pakai
`updated_at` / `minicode sessions list` sebagai indikator "sesi terakhir aktif".

### T-006 — 73% jurnal sub-agent kosong (0 byte) (11:41, diverifikasi)

Dari **33** berkas `journal-sub_*.jsonl` sesi ini: **24 berisi 0 byte**, hanya 9 yang
punya isi (2–6 KB). Sub-agent yang jurnalnya kosong tetap punya baris di DB — kalau
sub-agent itu perlu dipulihkan/diaudit, **tidak ada jejak tool call-nya**. Dua hipotesis
belum terpisah: (a) flush jurnal sub hanya terjadi saat exit/sukses tertentu, atau
(b) sub tanpa tool call memang tak menulis apa pun. Catatan: sub baru terus muncul
dengan jurnal 0 byte bahkan saat aktif (`246c5ac7` 11:34, `732ca948` 11:39).

### T-007 — Context window asli ≠ 131.072: fallback `safe-default` yang salah sasaran (12:00–12:31, probe API + kode)

Keluhan "context window ~100k" berasal dari **fallback internal Minicode, bukan provider**:

- `api-xingchiapi-com` di `~/.minicode/config.json` **tidak punya `contextWindows`**,
  katalog `src/policy/context-window-catalog.ts` tidak mengenal keluarga `gpt-6*`,
  dan tidak ada overlay `context-windows.json` → `resolveContextWindow()` jatuh ke
  `DEFAULT_FALLBACK_CONTEXT_WINDOW_TOKENS = 131_072` (`src/policy/context-window.ts:16`),
  `source: safe-default`. **Terverifikasi dengan menjalankan resolver asli:**
  `api-xingchiapi-com::gpt-6-astra → 131072 (safe-default)`, sedangkan
  `gpt-6-astra` tanpa pin → `1050000 (model/endpoint, via tokenharbor-ai)`.
- Jendela kompaksi agresif (`aggressiveBudgetPolicy`, medium ≥65% / high ≥85%,
  `src/app/session.ts:55`) dengan budget 131k → kompaksi mulai di ≈85rb token.
  Itu sebabnya "kompaksi terus-menerus".
- **Ukuran asli: probe empiris langsung ke API** — bukan angka katalog, bukan
  tebakan. Ringkasnya: **diterima sampai 921.135 token** (angka persis dari
  laporan `usage.prompt_tokens` provider), **ditolak mulai ≈922.636 token**
  dengan pesan penolakan provider sendiri
  (`502 "Your input exceeds the context window of this model"`, type
  `upstream_error`). **Jendela asli ∈ [921.135, ≈922.636) — lebar ±1.500 token
  (0,16%).** Mekanisme probe, asumsi, ledger 16 permintaan, dan koreksi label
  ada di seksi
  [Metodologi pengukuran context window](#metodologi-pengukuran-context-window--bukan-tebakan).
  **Untuk pengukuran ulang tidak perlu sedetail itu** — pakai protokol hemat
  [M7](#m7--protokol-hemat-rekomendasi-untuk-pengukuran-berikutnya)
  (≈5 probe, ±3%).
- Catatan: beberapa probe besar justru mengembalikan 503
  (`buffering capacity exhausted` / `Service temporarily unavailable`) —
  gangguan kapasitas provider yang TERPISAH dari limit konteks, **tidak dipakai
  sebagai bukti** (lihat T-009).
- **Perbaikan:** tambahkan `contextWindows` untuk `api-xingchiapi-com`
  (mis. `{"gpt-6-astra": 921000}`) atau jalankan sesi dengan
  `--context-window 921000`. **Angka 921.000 adalah rekomendasi konservatif,
  bukan hasil ukur** — sengaja dibulatkan ke bawah di bawah batas-bawah terukur
  921.135 sebagai margin aman (tokenizer Minicode bisa sedikit beda dari
  tokenizer provider). Jangan pakai 1.050.000 dari katalog tokenharbor untuk
  provider ini: provider ini menolak di ≈922,6k.

### T-008 — "Sering berhenti" #1: batas 50 langkah per turn (`exceeded 50 steps`) (12:00, dari DB)

4 dari 5 `turn.failed` berpesan `"exceeded 50 steps"` (cause `agent`):
03:40:23, 04:06:15, 04:20:18, 04:44:56 UTC (10:40, 11:06, 11:20, 11:44 WIB).
Sumbernya `LIMITS.DEFAULT_MAX_STEPS: 50` (`src/constants.ts:136`).
Tiap kegagalan diikuti `turn.started` baru → sesi **hidup lagi otomatis**, tapi
kerja turn yang terputus harus berjalan ulang (step terpakai sia-sia).
Turn yang panjang + banyak tool call → wajar kena 50 langkah.

### T-009 — "Sering berhenti" #2: provider 503 → turn mati, sesi berhenti total (12:12:56 WIB, dari DB)

`turn.failed` ke-5 (12:12:56 WIB): cause **`provider`**,
`server error (503): {"error":{"message":"Service temporarily unavailable","type":"api_error"}}`.
Didahului 4× `diagnostic.raised PROVIDER_ERROR` (12:12:45–12:12:56, retry berjarak
~2–5 dtk lalu menyerah). **Tidak ada `turn.started` sesudahnya** — berbeda dengan
kegagalan 50-langkah yang selalu di-restart. Sejak 12:12:56 WIB:
**0 event baru, jurnal beku di 116.811 byte (ditulis 12:07:11), 0 kemajuan sampai
12:32+** → sesi tampak "berhenti/mati" di mata user. (503 yang sama juga muncul
dari provider ini pada probe besar T-007 — provider ini memang flaky di bawah beban.)

### T-010 — Rekap kegagalan sesi (12:32, dari DB)

`turn.failed` 5 (4× 50-langkah + 1× provider 503) · `turn.started` 9 ·
`turn.completed` 4 · `context.compacted` **16** (5 di antaranya
`llm-failed: llm compaction timeout` → fallback ringkasan mekanis) ·
`tool.failed` 12 · `tool.denied` 5 (4 LOOP_GUARD + 1 allowlist) ·
`tool.cancelled` 1. Total token kumulatif `step-traces` ≈ 16,7 juta.

## Metodologi pengukuran context window — bukan tebakan

Pertanyaan yang dijawab di sini: **"bagaimana tahu angkanya 921.000?"**
Jawaban pendek: **921.000 bukan hasil ukur — itu rekomendasi konservatif.
Hasil ukurnya adalah braket [921.135, ≈922.636).**

### M1 — Kenapa harus diprobe (tidak ada metadata)

- `/v1/models` dan `/models` hanya mengembalikan `id` + `display_name`
  (`gpt-6-astra`, `gpt-6.1-sol`) — **tanpa context-length**. `/v1/model/info`,
  `/v1/models/{id}` (field detail), endpoint billing → semua 404. Provider ini
  tidak menyediakan cara bertanya langsung.
- Katalog internal Minicode tidak punya keluarga `gpt-6*`, dan angka
  **1.050.000** yang muncul di resolver berasal dari **gateway lain**
  (tokenharbor-ai) — bukan bukti apa pun untuk xingchiapi.

### M2 — Sinyal "oracle": penolakan milik provider, bukan tebakan saya

Setiap probe = `POST /v1/chat/completions` dengan prompt berulang (frasa
identik) dan `max_tokens: 5`:

- **Di bawah limit** → `200 OK`, dan `usage.prompt_tokens` melaporkan jumlah
  token menurut **tokenizer provider itu sendiri** — bukan perkiraan saya.
- **Melewati limit** → `502 {"error":{"message":"Your input exceeds the context
  window of this model","type":"upstream_error"}}` — pesan klasifikasi
  **eksplisit dari provider**, bukan error jaringan atau tebakan status.
- **503** (`Request body buffering capacity is exhausted` /
  `Service temporarily unavailable`) → **TIDAK KONKLUSIF**: provider sedang
  kehabisan kapasitas. Probe jenis ini **dikeluarkan dari perhitungan** dan tidak
  pernah dihitung sebagai "diterima"/"ditolak".

### M3 — Biseksi (binary search) pada predikat monoton

Asumsi: predikat "diterima" monoton (semua prompt < limit diterima, semua
prompt > limit ditolak) — sifat standar limit konteks. Titik awal: 134rb
diterima ↔ ~1,054M ditolak → titik tengah diambil berulang sampai selisih
menyusut ke ±1.500 token.

### M4 — Ledger lengkap 16 permintaan

Token per repeat terukur dari titik yang **diterima**:
(921.135 − 4.121) / 91.700 ≈ **10,0002** token/repeat — konsisten dengan
(134.135 − 4.121)/13.000 ≈ 10,0011. Dasar **4.121 token** = overhead/template
yang disuntikkan provider (terlihat dari probe `"hi"` polos yang tetap
dilaporkan 4.121 token, cached 3.968). Permintaan yang **ditolak** tidak
melaporkan `prompt_tokens`, jadi jumlah tokennya diskalakan linier dari jumlah
repeat identik (galat ±puluhan token).

| # | repeat | Hasil HTTP | prompt_tokens | Verdict |
|---|---|---|---|---|
| 1 | 0 (`hi`) | 200 | 4.121 | overhead dasar provider |
| 2 | 13.000 | 200 | 134.135 | diterima |
| 3 | 105.000 | 502 context window | ≈1.054.138 | ditolak |
| 4 | 104.500 | 503 buffering | — | **TIDAK KONKLUSIF** |
| 5 | 101.300 | 503 service (2×) | — | **TIDAK KONKLUSIF** |
| 6 | 50.000 | 200 | 504.135 | diterima |
| 7 | 75.500 | 200 | 759.135 | diterima |
| 8 | 88.000 | 200 | 884.135 | diterima |
| 9 | 94.000 | 502 context window | ≈944.136 | ditolak |
| 10 | 90.000 | 200 | 904.135 | diterima |
| 11 | 91.700 | 200 | **921.135** | **diterima ← batas bawah** |
| 12 | 91.850 | 502 context window | ≈922.636 | **ditolak ← batas atas** |
| 13 | 92.000 | 502 context window | ≈924.136 | ditolak |
| 14 | 92.350 | 502 context window | ≈927.636 | ditolak |
| 15 | 92.600 | 502 context window | ≈930.136 | ditolak |
| 16 | 92.900 | 502 context window | ≈933.136 | ditolak |

Urutan eksekusi tidak persis terurut ukuran (biseksi melompat-lompat), tapi
**semua titik konsisten monoton**: ≤921.135 selalu 200, ≥≈922.636 selalu 502 —
tidak ada kontradiksi.

### M5 — Presisi & batas kepercayaan

- Braket akhir: **[921.135, ≈922.636)** → lebar ±1.500 token ≈ **0,16%**.
- Batas bawah **persis** (angka dari laporan provider). Batas atas **estimasi
  linier** (±puluhan token). Tidak diketahui apakah limit provider angka bulat
  (922.000? 921.600?) — untuk keperluan konfigurasi hal itu tidak relevan.
- **Yang TIDAK diuji:** `gpt-6.1-sol`, batas output-token, dan perilaku dengan
  tool-schema nyata (probe hanya prompt polos).
- Kesimpulan angka tunggal "~921–922 ribu" adalah **pembacaan braket**, bukan
  satu pengukuran titik.

### M6 — Koreksi label (transparansi)

- Nama berkas probe (`probe-937k.ts`, `probe-946k.ts`, `probe-971k.ts`, dst.)
  memakai perkiraan kasar ±10,32 token/repeat sehingga **melebihkan ukuran
  sekitar 3%**. Yang berlaku adalah `prompt_tokens` pada probe yang diterima dan
  estimasi 10,0002/repeat pada yang ditolak — **sudah dikoreksi di ledger M4**.
- Angka "1,042M" yang pernah disebut untuk probe 101.300 repeat juga salah
  hitung: sebenarnya ≈**1.017.138** — dan tetap **tidak konklusif** (503).
- Probe 1.042–1.049M yang menghasilkan 503 **tidak pernah** dipakai untuk
  menyimpulkan limit; hanya 502 `exceeds the context window` yang dipakai.

## M7 — Protokol hemat (rekomendasi untuk pengukuran berikutnya)

**Masalah protokol M1–M6:** presisi ±0,16% ternyata **tidak dibutuhkan** untuk
konfigurasi — 16 probe (≈5 menit; masing-masing 7–41 detik; memproses ratusan
ribu token) pada akhirnya hanya untuk memilih **satu angka** di
`contextWindows`. Yang benar-benar dibutuhkan cuma dua hal:

1. **Aman** — angka yang provider sudah bukti terima (200 OK).
2. **Dekat limit** — supaya jendela tidak terbuang percuma.

**Prinsip kunci:** batas bawah braket **selalu** aman (sudah diverifikasi
provider). Jadi **berhenti lebih awal tidak pernah membuat angka salah** —
hanya membuatnya sedikit lebih konservatif. Presisi penuh hanya pernah dibutuhkan
kalau butuh angka pasti provider untuk dokumentasi/laporan.

### M7.1 — Empat tier, pilih sesuai kebutuhan

| Tier | Mekanisme | Probe | Presisi | Waktu | Pakai saat |
|---|---|---|---|---|---|
| 2 | Biseksi penuh (M1–M6) | 16 (11 efektif + 5 buang 503) | ±0,16% | ≈5 mnt | butuh angka persis utk laporan/audit |
| **1** | **Biseksi + berhenti di toleransi 5%** | **≈5** | **±3%** | **≈2 mnt** | **konfigurasi `contextWindows` (REKOMENDASI)** |
| 0 | Langsung probe nilai kandidat bulat | 1–3 | tergantung kandidat | ≈30–90 dtk | cuma butuh "cukup besar & aman", buru-buru |
| C | Tangga ukuran umum (128k→256k→512k→1M) | 4 | bracket lebar | ≈1 mnt | sanity check tanpa biseksi |

### M7.2 — Tier 1: algoritma (rekomendasi utama)

```
lo = probe pertama DITERIMA   (134.135; boleh juga pakai prior katalog)
hi = probe pertama DITOLAK    (1.054.138; atau kandidat dari katalog 1.050.000)
selama (hi - lo) > 0.05 × lo:          # ← berhenti di sini, jangan dipaksakan
    mid = (lo + hi) / 2
    r = probe(mid)
    200     → lo = r.prompt_tokens     # angka pasti milik provider
    502 ctx → hi = mid                 # limit terlewati → batas atas turun
    503     → ULANGI mid yang sama     # noise! jangan ubah interval
config = floor(lo / 10_000) × 10_000   # bulatkan ke bawah per 10rb → selalu aman
```

**Simulasi terhadap data yang sudah ada** (predikatnya monoton, jadi boleh
disimulasi ulang — ini bukan probe baru, melainkan "berapa probe kalau tadi
pakai protokol ini"):

| # | mid | Hasil (dari data nyata) | Interval sesudahnya |
|---|---|---|---|
| 1 | 594k | 200 (504k & 759k terbukti diterima) | [594k … 1.054M] |
| 2 | 824k | 200 (884k diterima) | [824k … 1.054M] |
| 3 | 939k | 502 (924k terbukti ditolak) | [824k … 939k] |
| 4 | 882k | 200 (904k diterima) | [882k … 939k] |
| 5 | 910k | 200 (921k diterima) | [910k … 939k] → rasio 1,032 ≤ 1,05 → **STOP** |

Kondisi berhenti terpenuhi setelah **probe ke-5** (lebar 28,75k < 5% × 910k).

**Hasil: 5 probe → `config = 910.000`** (terverifikasi diterima provider).
Protokol penuh: 16 probe → 921.000. Selisih manfaat cuma **1,1% jendela**
(910k vs 921k) dengan **3× lebih sedikit probe**.

### M7.3 — Tier 0: kalau cuma butuh angka yang "cukup"

Probe **langsung nilai kandidat bulat** (mis. `1.000.000` atau `900.000`):

- `200` → **selesai, pakai angka itu (1 probe)**.
- `502` → kandidat kebesaran: turunkan (mis. 500k), atau lanjut Tier 1 dengan
  `hi = kandidat` — bracket langsung menyempit dari awal.

Paling hemat kalau targetnya "jangan kompaksi prematur", bukan "tahu angka
pasti provider".

### M7.4 — Evaluasi usulan "kelipatan / ukuran umum" (Tier C)

Tangga `128k → 256k → 512k → 1M` (kekuatan-2 yang lazim dipakai lintas model)
**valid sebagai sanity check** — 4 probe, nol asumsi aritmetika, langsung
kelihatan "bukan 128k, bukan 1M". Tapi dua catatan:

1. Untuk provider ini hasilnya berhenti di bracket **[512k … 1M]** — kalau
   langsung dipakai, konfigurasi jadi 512k dan **44% jendela terbuang**.
   Jadi tangga umum baik sebagai **titik awal `lo`/`hi`**, bukan jawaban akhir.
2. Pengecualian yang menguntungkan: kalau probe `1M` diterima → **langsung
   selesai** (banyak model modern memang 1M, dan katalog tokenharbor juga
   bilang 1,05M) — dalam 4 probe.

Kombinasi terbaik: **tangga umum untuk `hi`, lalu Tier 1 untuk menyempitkan.**

### M7.5 — Aturan efisiensi lain

- **Prior katalog itu gratis:** angka 1.050.000 dari tokenharbor sudah layak
  jadi `hi` — tidak perlu membuktikan dari nol (di M1–M6 justru kebetulan
  dapat titik awal bagus dari probe 134k & 1,054M).
- **503 ≠ limit:** ulangi probe yang sama, jangan menggeser interval karena
  noise — di protokol penuh, **5 dari 16 probe terbuang** percuma begitu.
- **Sekali ukur, simpan:** tulis hasilnya ke `provider.contextWindows` (atau
  `--context-window`); Minicode men-cache-nya (`context-windows.json`) sehingga
  pengukuran tidak perlu diulang tiap sesi.
- **Biaya nyata:** tiap probe besar memproses ratusan ribu token input dan
  7–41 detik — makin sedikit probe, makin murah. Ini alasan utama Tier 1
  sudah cukup.

**Rekomendasi akhir:** pakai **Tier 1 (≈5 probe, ±3%)** untuk keperluan
konfigurasi; Tier 0 kalau buru-buru; Tier 2 (protokol M1–M6 yang tadi) hanya
kalau butuh angka persis untuk dokumentasi.

## Log pengamatan (berkelanjutan)

| Waktu (WIB) | Peristiwa | Ref |
|---|---|---|
| 11:37 | Baseline: sesi aktif (jurnal 94 KB, seq 175), temuan T-001…T-005 | — |
| 11:41 | Jurnal 103 KB (≈2,4 KB/menit); sub-agent baru `246c5ac7` (11:34) & `732ca948` (11:39) keduanya 0 byte → T-006 dikoreksi jadi 24/33 kosong | T-006 |
| 11:42–11:52 | Pantauan jendela-1 (41 sampel): +6,1 KB, seq 188→194, 35 sampel tanpa kemajuan, 3 sampel dengan 1 entri jurnal belum ter-commit, 0 lock DB, 0 loss/badStates | — |
| 12:00 | Akar "100k" terbongkar: fallback 131.072 (`safe-default`) untuk `api-xingchiapi-com`; resolver asli membuktikan 131072 vs 1050000 (pin lain) | T-007 |
| 12:00 | 4× `turn.failed` = `exceeded 50 steps` (10:40–11:44 WIB), auto-restart oleh `turn.started` | T-008 |
| 12:05–12:08 | Turn 5 jalan: edit `docs/audit-remediation-plan.md` (seq 201), baca `scripts/coverage-gate.ts`; `context.compacted` ke-16 (`pressure:medium`) 12:06:30 | — |
| 12:12:56 | **Turn 5 mati**: 4× 503 `Service temporarily unavailable` → `turn.failed` cause `provider`; TIDAK ada restart | T-009 |
| 12:13–12:32 | Sesi beku: 0 event, jurnal 116.811 byte (mtime 12:07:11) tanpa perubahan ≥20 menit; pantauan jendela-2 (67 sampel) mengonfirmasi 60 stall, 0 dbErr/loss/badStates | T-009 |
| 12:00–12:31 | Biseksi jendela konteks API: 921.135 diterima ↔ ~922,6k ditolak → **jendela asli ≈921–922k token** | T-007 |
| 12:29 | Pantauan jendela-2 selesai (15 mnt, 67 sampel): 60 stall, +11,5 KB total (berhenti di 116.811 byte), 0 dbErr/loss/badStates, 3 entri uncommitted di awal jendela (kembali committed) | T-009 |
| 12:33 | Sesi masih mati: 0 event setelah 12:12:56 WIB, jurnal beku ≥26 menit | T-009 |
| 12:35 | Metodologi pengukuran ditulis (seksi M1–M6): oracle 502 provider, biseksi monoton, ledger 16 probe, koreksi label file probe ±3% dan koreksi "1,042M" → 1.017.138 | T-007 |
| 12:45 | Protokol hemat ditulis (M7): 4 tier (0/1/2/C), simulasi Tier-1 5 probe → `910.000` (±3%) vs protokol penuh 16 probe → 921.000; evaluasi tangga ukuran umum (bracket [512k…1M] = buang 44% bila dipakai mentah) | T-007 |

## Infrastruktur pantauan

- Sampler 15-detik: `C:\Users\zo\AppData\Local\Temp\opencode\minicode-observation\monitor.ts`
  → tulis ke `samples.jsonl` di folder yang sama (ukuran jurnal, seq/tool/state terakhir,
  jumlah pending-tanpa-committed, loss outcome, hitung pesan/error/sub-agent di DB,
  error lock DB bila ada).
- Setiap jendela pantauan (~10 menit) dianalisis, temuan baru ditambahkan ke atas,
  log tabel diperbarui.
