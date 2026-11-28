# Sub-Agents & Tasks


## Konsep

Sub-agent = instans agent dengan **context terpisah** dari parent: memory, signal, dan budget sendiri. Pool concurrency **5** — maksimum 5 sub-agent hidup sekaligus — dan abort-aware (mewarisi AbortSignal parent; parent batal → anak berhenti). Ukuran pool dapat diubah lewat `MINICODE_SUB_AGENT_POOL_SIZE` (1..16) bila fan-out lebih besar memang diperlukan.

**Anggaran & tampilan child.** `delegate_task` menerima `timeoutMs` opsional per delegasi (finite, >0, dibatasi batas timer internal); defaultnya `MINICODE_SUB_AGENT_TIMEOUT_MS` = **3.600.000 ms (1 jam)** — naik dari 300.000 ms karena 4 explorer paralel dengan ~38–51 tool call masih kehabisan waktu (prompt pendek kena ratio 0,6 ⇒ 180 dtk). Aman karena watchdog liveness membunuh anak yang benar-benar diam dalam 120 dtk; pagu panjang hanya membantu anak sehat yang lambat. Saat timeout, child berstatus `timeout`, ACE verdict FAIL/BLOCKED, dan teks yang sudah mengalir dikembalikan sebagai **bagian hasil** (fail-soft, tanpa rollback efek berkas). Beri `name` agar child tampil dengan nama manusiawi (`explore-1`, `plan-2`, … bila tidak diisi) di transkrip alih-alih kode `run_<8>`/`sub_<8>`; nama dari model tetap disanitasi sebelum ditampilkan. Untuk fan-out banyak, pecah scope per agen (**2–5** bila scope benar-benar terpisah). Kirim `scope` (`file`|`dir`|`subtree`|`repo`) — runtime **tetapkan** budget (**24/40/64/100**, `plan` ×1,5, di-clamp ke **`[24,600]`** sehingga `repo`+`plan` = 150) dan menaikkannya bertahap **`[24,40,64,100,150,250,400,600]`** bila anak mentok. **Jangan set `maxSteps` sendiri:** nilai eksplisit mematikan eskalasi. Tanpa `scope`, fallback kontrak lama tetap 5/15. Setelah `max_steps_exceeded`, mendelegasikan ulang scope yang sama adalah cara memakai eskalasi adaptif — jangan mengulang scope yang TIDAK berubah secara buta.

`delegate_task` meminta persetujuan di **ASK** (TTY); non-TTY menolak, termasuk bila broker persetujuan daemon di-inject — pengecualian `allowNonTtyAsk` hanya untuk tool non-gated. Di **AUTO**, delegasi berjalan tanpa prompt jika capability telah diotorisasi. Anak mewarisi WorkMode parent; `DISCUSS` membatasi tool anak ke subset eksplorasi baca-saja. **Satu approval di ASK hanya mencakup satu delegasi:** opsi "Always" tidak tersedia untuk `delegate_task`, jadi delegasi identik berikutnya tetap butuh izin baru.

## Mode anak: `explore` / `plan`

| Mode anak | Kemampuan |
|---|---|
| `explore` | Subset tool eksplorasi baca-saja untuk mencari dan memahami kode |
| `plan` | Tidak mendapat `todo_write`, mutasi memory, commit, nesting, atau job background. Parent PermissionMode `ASK`, `plan`, atau `readonly` memaksa mode anak menjadi `explore`. WorkMode parent `DISCUSS` juga membatasi daftar tool anak ke subset eksplorasi; pada `BUILD`, mode `plan` dapat memakai tool dasar yang tersedia, tetap tunduk pada PermissionMode anak |

Restriksi anak yang **selalu** berlaku: `delegate_task`, `git_commit`, memory/todo writes, `submit_result`, `bash_output`, dan `bash_kill` tidak tersedia. Background shell ditolak agar tidak membuat job yatim. Daftar tool dinamis MCP tidak diteruskan ke anak. WorkMode `BUILD` adalah label produk untuk identitas runtime `EXECUTE`.

## Kenapa dibatasi

Sub-agent menjalankan task tanpa Anda di depan layar. Karena itu kemampuan commit dan tool dinamis MCP tidak diteruskan; mode `explore` dan WorkMode ketat hanya memberi tool eksplorasi (tool MCP built-in pun tersaring). Mode `plan` di bawah `BUILD` tetap dapat mengubah file, menjalankan tool dasar, dan memakai tool MCP built-in bila diotorisasi, sehingga hasilnya harus ditinjau parent.

## Laporan inkremental & evaluasi parent

Sejak v7.35, child **mengirim temuan selagi bekerja**, bukan hanya satu string di akhir. Instruksi bawaan meminta baris `[FINDING] <severity> | <file:line> | <ringkasan>`; baris pertama dikirim lebih awal sebelum baca mendalam. Adaptor tetap menerjemahkannya menjadi event `finding.detected` berpenanda `[EVALUATE]` (durable di SQLite & tersedia di ACP), dan di TUI catatan mentah ini masuk `/logs` (tidak ditumpahkan ke chat utama agar percakapan tetap rapi) serta dipakai sebagai `partial` terformat bila child timeout/gagal. Induk **wajib mengevaluasi** temuan itu (hipotesis, bukan kesimpulan) sebelum memakainya; deskripsi `delegate_task` menyatakan hal ini eksplisit.

**Audit self-repo yang reproducible.** Sebelum mendelegasikan audit, pin `git rev-parse HEAD` dan `git diff --stat` di prompt/laporan. Tanpa itu temuan bisa jadi stale saat working tree berubah karena sesi/proses lain — persis yang terjadi pada sesi `ef40d265`, di mana perubahan paralel memicu `EVALUATOR_TAMPER_ATTEMPT` pada audit baca-saja. Guard kini hanya menyalahkan sesi yang benar-benar memakai tool mutasi (`write_file`, `edit`, `bash`, `code_run`, …); namun mencatat checkpoint tetap kebiasaan yang baik.

## Recovery

Turn parent gagal **setelah** anak `committed`: jurnal menandai delegasi; warning `[recovery]` (status anak + ringkasan tervalidasi) dipancarkan baik pada kegagalan one-shot maupun pada kegagalan turn interaktif/TUI sebelum turn berikutnya dimulai, agar tidak mendelegasi ulang buta (efek anak sudah terjadi — yang benar adalah verifikasi hasilnya). Lihat [Keamanan](security.md) untuk jurnal recovery lengkap.

## Lanjut

- [Tools](tools.md) — semua tool yang boleh dipakai anak.
- [Policy & Sandbox](policy-sandbox.md) — mode permission parent vs anak.
- [Otomasi & CI](exec.md) — delegasi di non-TTY (ditolak, fail-closed).
