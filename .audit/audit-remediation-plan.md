# Rencana remediasi audit e6e50a7

Kandidat awal: minicode-ai 0.25.0, e6e50a7. Sumber: code-audit-e6e50a7.md. Dokumen ini adalah rencana implementasi audit untuk rilis berikutnya, bukan pengganti roadmap pemilik repo. Nomor versi publik belum diubah.

## Urutan dan kriteria penerimaan

| Temuan | Perbaikan | Verifikasi wajib | Status |
| --- | --- | --- | --- |
| A1 pencabutan izin | Versi otorisasi sesi; tolak grant yang berubah selama await, termasuk perubahan bolak-balik | Dua sumbu mode dan antrean; nol efek setelah pencabutan | Implementasi + regresi dua sumbu/preparation/started lulus; gate penuh berjalan |
| A2 cwd background | Gunakan effectiveCwd pada semua spawn | Root sesi berbeda dari cwd proses; cwd relatif eksplisit | Implementasi + tes terarah lulus |
| A3 abort sandbox OS | Propagasi signal ke semua caller; bunuh process group, cleanup listener, pisahkan abort/timeout | Tes lifecycle terkontrol; tes native bila platform mendukung | Tes terkontrol lulus; native macOS/Linux belum terverifikasi |
| A4 malformed CSI/SS3 | Resinkronisasi prefix rusak, batas buffer, preservasi Ctrl+C/Ctrl+D | Semua batas chunk, input panjang, valid split | Implementasi + tes terarah lulus |
| A5 tombol tak didukung | Ignore sequence lengkap tak didukung, bukan Escape | Modified navigation/report tidak memicu abort | Implementasi + tes terarah lulus |
| A6 konsistensi abort executor | Satu batas pembatalan; karantina executor saat operasi belum berhenti, jangan lepaskan lock prematur | Read/keyed/unkeyed/mixed, antrean, pengulangan batch tanpa overlap | Implementasi + tes matriks lulus |
| A7 kompaksi | Validasi estimasi akhir, padatkan active turn bila perlu; error eksplisit bila mustahil | Tail besar, pasangan tool, instruksi irreducible | Lulus termasuk regresi kontinuitas berulang; lihat handoff |
| A8 opt-out tokenizer | Guard awal sebelum cache/jaringan | Nol operasi fetch/filesystem saat dinonaktifkan | Implementasi + tes terarah lulus |
| DNS/SSRF | DNS tool gagal tertutup; ikat koneksi ke alamat tervalidasi, pertahankan Host/SNI dan decode terkompresi | Lookup gagal, timeout, redirect, alamat privat | 28 tes jaringan lulus; runtime Bun custom lookup terverifikasi |
| Anggaran konteks | Selaraskan kontrak floor reserve dan ambang; hilangkan diskontinuitas | Lingkungan ambang 64000 dan small-window | Implementasi + tes terarah lulus |
| Persistensi | Pertahankan timestamp event yang identitasnya diadopsi; evaluasi identitas retained suffix tanpa migrasi spekulatif | Kompaksi, duplicate messages, atribusi run, backward compatibility | 8 tes event-id lulus; migrasi immutable event store terpisah |
| Transcript | Pertahankan cache proyeksi baris yang tidak berubah saat eviction | Append di retention cap, resize, scroll | Regresi retention cache lulus |

## Batas rancangan

Abort executor berarti pemanggil berhenti menunggu, bukan bukti extension tool yang mengabaikan signal telah berhenti. Executor harus menolak pekerjaan baru selama pekerjaan lama belum selesai. Sandbox OS harus mengirim terminasi ke seluruh process group sebelum mengakui pembatalan proses. Pemisahan event store immutable dari projection adalah migrasi arsitektur terpisah; perbaikan kompatibel harus menjaga kontrak identitas yang sudah diuji, dan rencana migrasi harus mendeskripsikan backfill, recovery, serta kompatibilitas pembaca.

## Verifikasi kandidat

Tes regresi terarah dahulu, lalu typecheck, lint, suite, coverage, pack, bash gate, benchmark smoke, harness audit sesuai manifest kandidat. Hasil dicatat terhadap kode akhir yang sama. Pengujian sandbox native macOS/Linux dan aksesibilitas terminal nyata tidak boleh diklaim dari host Windows saja.

## Catatan berjalan

- Pemeriksaan lanjutan: metadata overlay model dapat kalah oleh tebakan keluarga katalog; cache deteksi `/models` belum dibatasi kredensial dan path case-sensitive. Perbaikan berikutnya mencakup resolusi kapasitas, identitas cache, serta regresi kompaksi.
- Panel TUI melipat error ke hitungan agregat; kegagalan/penolakan/pembatalan akan tetap ditampilkan langsung dengan detail, sementara hitungan grup dipertahankan.
- Dua delegasi review lifecycle/DNS melewati batas waktu; verifikasi area tersebut dilanjutkan langsung melalui diff dan tes. Tidak ada klaim verifikasi tambahan dari delegasi yang timeout.

- A2: startBackground menerima effectiveCwd; test/background-cwd.test.ts 2 pass.
- A8: loader memeriksa opt-out sebelum lookup/cache; test/tokenizer-registry.test.ts 5 pass.
- Rencana belum menyatakan release-ready; hasil lengkap diperbarui setelah integrasi.
- Iterasi lanjutan: 114 tes konteks/deteksi/panel lulus (0 gagal). Metadata eksak kini menang atas keluarga; cache deteksi terisolasi per kredensial dan mempertahankan case path; status gagal panel tetap terlihat beserta alasan. Full gate berjalan sebagai bg_0015403e, log `remediation-gates.log`; typecheck dan lint sudah melewati tahap awal. OS Windows/cmd.exe sudah dikirim dalam prompt harness, tetapi kapasitas token belum dikirim sebagai informasi eksplisit ke model.

## Verifikasi lanjutan transport dan harness

- `web_fetch` kini memakai `src/lib/public-http.ts`: DNS sekali per hop, seluruh jawaban ditolak bila mengandung alamat privat, dan lookup socket hanya menerima alamat tervalidasi. Host/SNI tetap memakai hostname asal. Test runtime Bun 1.4.3 di Windows membuktikan `http.get` menghormati custom lookup menggunakan server lokal dan hostname `.invalid`.
- Regresi jaringan: 21 pass, 0 fail; test custom socket lookup tambahan lulus (5 pass total pada public-http). Type mismatch Node/Bun ReadableStream diperbaiki melalui cast eksplisit pada boundary Response.
- Prompt harness kini mengirim kapasitas resolved saat request berjalan, memperbaruinya bila kapasitas berubah, serta membedakan budget token dari OS/shell. Regresi prompt dan request accounting: 3 pass, 0 fail.
- Review transport menemukan callback Response yang dapat throw di luar promise dan respons terkompresi yang belum didekode. Keduanya diperbaiki; gzip/deflate/Brotli didekode streaming sebelum body cap. Regresi jaringan terbaru: 28 pass, 0 fail, termasuk status 600 asinkron, data kompresi rusak, dan cap terhadap byte hasil dekompresi.
- Suite pertama menemukan fixture kompaksi yang menganggap prefix teks sebagai provenance summary. Fixture kini menghasilkan prior summary melalui compactWithLlm; 21 tes compaction/audit lulus. Tes persistensi/cache transcript: 9 pass, 0 fail. Typecheck kandidat terbaru lulus.
- Run sebelumnya dihentikan karena perubahan transport/fixture. Gate penuh kandidat terbaru berjalan sebagai `bg_866fa3c0`, log `remediation-verified-gates.log`.

## Conversation continuity handoff (current)

- User objective: finish the remaining audit remediation, verify the Windows harness and model context-window reporting, and improve compaction while keeping the work aligned with this conversation. The latest request continues that objective.
- Workspace/host: `D:\Github\minicode`, Windows, cmd.exe. OS context and model token budget are separate. The harness regression confirms both are included and the resolved token budget updates between requests; this is not proof of a provider's advertised capacity.
- Current changes: mechanical summaries preserve bounded original-goal/recent-steering excerpts, latest recorded todo state, and earlier evidence without recursive summary wrappers. Short English/Indonesian continuation messages do not evict substantive corrections. LLM compaction is prompted to distinguish verified completion from plans; its extracted evidence survives a mechanical fallback. Trusted projection construction registers summary provenance without recognizing arbitrary user text prefixes.
- Verification: 145 pass / 0 fail across compaction, limits, projection, selector, assembly, and harness-capacity tests. Network checks earlier in this turn: 28 pass / 0 fail. Full gates launched as `bg_fb785eb6`; log `remediation-continuity-gates.log`. Previous full run `bg_866fa3c0` was stopped because source changes made it stale; it is not a passing gate result.
- Remaining: collect full gate results, repair genuine failures, update final verification status. No release-ready claim, commit, or publish yet. Native macOS/Linux sandbox process-group behavior remains unverified on this Windows host.
- Continuation verification: network tests now 29 pass / 0 fail; harness live-capacity test rerun passes on Windows/cmd.exe. The prior continuity gate ended with exit 1 and an abruptly truncated log at phase6ab process-boundary (no suite summary); it is not a passing result. Isolated process-boundary diagnostic is running as `bg_c6f71178`, log `remediation-process-check.log`. Earlier two reported fixture/output-cap failures were addressed and their targeted regressions pass.
- Limits: compaction remains explicitly lossy and bounded. Goal/request metadata is process-local; trusted durable projections preserve textual evidence, while arbitrary restored canonical user messages are not reclassified by their text. Mechanical selection cannot semantically guarantee every historical constraint survives unlimited substantive steering.

## Pemeriksaan ulang setelah perubahan bahasa chat

Status pada tabel di atas adalah catatan awal implementasi, bukan hasil verifikasi terakhir. Working tree kini memuat perbaikan A1–A8 serta DNS fail-closed, anggaran konteks, timestamp persistensi, dan cache transcript. Tes terarah terbaru: **97 pass, 1 skip, 0 fail** dari 14 berkas (context-audit, i18n, tui-lang, authorization-revocation, background-cwd, os-sandbox-abort, input-recovery, executor-abort-matrix, compaction-audit, tokenizer-registry, context-budget, history-event-id, transcript-retention-cache, web-fetch-dns-failclosed). Typecheck lulus; lint lulus pada 716 berkas dengan 5 saran informasional useTemplate. Format/import pada lima berkas remediasi dirapikan tanpa perubahan perilaku.

Tes native penghentian proses turunan sandbox dilewati pada host Windows. Full suite, coverage, pack, gate bash, benchmark smoke, dan harness audit belum diverifikasi ulang pada kandidat ini. Tes terarah tidak menutup seluruh kriteria penerimaan maupun risiko DNS rebinding/persistensi yang disebut dalam audit.

Bahasa chat kini ditentukan melalui instruksi sistem untuk mengikuti bahasa pesan pengguna atau preferensi bahasa eksplisit, beradaptasi ketika bahasa berubah, dan mempertahankan bahasa percakapan untuk pesan singkat. CLI tidak lagi meneruskan locale UI sebagai bahasa chat; opsi lang lama tetap diterima untuk kompatibilitas tetapi tidak menentukan bahasa prompt. Tes mengunci kontrak prompt yang identik untuk en/id/tanpa lang dan mempertahankan tes locale UI. Kepatuhan model nyata belum diuji melalui provider live.
