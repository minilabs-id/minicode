# Kontrak Terminal MiniCode (TUI fullscreen — v7.44, unreleased)

> **Status & presedensi (dibaca dulu).** Entri v7.22 di bawah ini adalah
> **catatan sejarah** dan sebagian besar sudah **ditimpa oleh v7.29+** (lihat
> entri v7.29–v7.37): warna kini NYALA by default di TTY (`MINICODE_COLOR=0`
> memaksa monokrom), zero-state KOSONG tanpa logo maupun hint, dan — sejak
> v7.37 — ringkasan status/aktivitas **dipotong per segmen narasi** (bukan
> satu baris akumulatif di ekor). v7.29 yang mengosongkan kolom chat untuk
> status sudah ditimpa. Jangan baca klaim v7.22/v7.29/v7.36 sebagai perilaku
> saat ini.
>
> **Aturan presedensi:** versi tertinggi menang; bila kontradiksi, entri dengan
> nomor versi terbesar yang berlaku. Entri lama tetap dipertahankan sebagai
> sejarah, bukan gambaran tampilan saat ini.

Perubahan v7.44 (unreleased — startup persen & closing block):

1. **Progress startup minimalis.** Tidak ada logo saat start. Satu baris yang
   diperbarui dengan `\r`: `start 57%`, hanya angka yang berubah, area sekitar
   tetap bersih. Sumber = `onPhase` (9 fase `createCliSession`), bukan timer
   palsu; `start 100%\n` ditulis sekali oleh `finish()`. Auto-update memakai
   format yang sama dengan prefix `update` (`update 33%` → `66%` → `95%` →
   `100%\n`), menggantikan `LoadingBar` berlabel. `MINICODE_STARTUP_PROGRESS=0`
   mematikan progress sesi (perilaku lama); resume-history tanpa tambahan
   kalimat.
2. **Blok penutup di scrollback.** Setelah alt-screen ditutup, satu blok rata
   kiri permanen: logo asli (`renderLogoRows()`, 5 baris), `Minicode`,
   `Session : minicode<DDMMYYYYHHMMSS>` (jam saat tutup, bulan angka),
   hitungan `turn/tool/file/other`, `tok · biaya · durasi`, dan `version`.
   Data dari `usage`/`session`/journal — tak ada yang dikarang (cost null →
   `$—`). Transkrip TETAP utuh (append-only). `MINICODE_SESSION_SUMMARY=0`
   mematikan. v7.43 (splash intro/closing frame) dibatalkan sebelum commit.

Peta proteksi: `test/audit-fix-session-summary.test.ts`,
`test/audit-fix-startup-progress.test.ts`, `test/tui-app.test.ts`,
`test/cli-session.test.ts`.

Perubahan v7.42 (unreleased — margin seragam & rekap tool):

1. **Satu tepi untuk semua teks (kecuali footer).** Prompt `minicode ›`,
   echo user, jawaban model, baris tool/finding, dan rekap aktivitas kini
   memakai `ASSISTANT_LEFT_MARGIN = 3` yang sama — tidak ada lagi teks yang
   mepet ke jendela atau "1–2 huruf nyangkut" di tepi kiri. Footer tetap
   full-width. Jeda satu baris antara prompt & jawaban dipertahankan.
2. **Rekap tool tanpa `+`.** Format `+ 2 commands · 1 edit` →
   `2 commands · 1 edit`. Angka memakai `c.info` (lebih terang), label kategori
   `c.gray` (lebih gelap), pemisah `c.faint` — hierarki visual tanpa tanda `+`.
3. **Isolasi warna baris proses.** `paintLedger` mengawali tiap baris dengan
   `\x1b[0m` saat color-on supaya SGR baris tool tidak bocor ke teks tetangga
   (`c.*` hanya reset foreground ke default terminal). Mode mono tidak terkena.

Peta proteksi: `test/tui-app.test.ts`, `test/audit-fix-clean-composer.test.ts`,
`test/audit-fix-live-inline-status.test.ts`, `test/activity-fold.test.ts`,
`test/theme.test.ts`, `test/footer-render.test.ts`.

Perubahan v7.41 (unreleased — narasi progres, auto-recap sub-agent & hardening turn):

- `# Communication`: direktif narasi after-delegasi, manajer saat kerja besar /
  sendiri saat kecil, ganti cara saat tool/browser gagal.
- Auto-recap sub-agent bounded (batch per turn, anti-loop, idle/abort guard,
  `MINICODE_AUTORESUME_CHILD=0`), mirror `bgFinishedAuto`.
- Hardening turn (abort/persist, budget flag, phantom rows, toolsCount live,
  @-mention race, stranded bg job, idempotency produksi, approval argsHash,
  finding render, parallel childLink, bash truncation, dll).

Perubahan v7.40 (unreleased — audit total & remediasi mendalam):

Hasil audit mendalam 8 area (tools, policy, session, app+task, UI+CLI,
docs+gate+CI, test quality, modul remaining). Bug fungsional/keamanan
diperbaiki; yang butuh ADR dicatat sebagai residual di bawah.

1. **Tools.** ReDoS guard menangkap `?`-quantified group (`(a?b?)*$`, runtime-
   proven exponential); `git_restore`/`git_checkout` preflight filter driver
   (fail-closed RCE); `runGit` cap gabungan stdout+stderr; `todo_write` rollback
   tak mengembalikan phantom `taskId`; `[FINDING]` child tahan chunk terbelah +
   flush saat turn tutup; `lsp_rename` batas `newText`, preflight semua target &
   rollback; `delegationKey` = hash FNV-1a.
2. **Storage/policy.** `unknown`/`undefined` state → refuse; `deleteJournalFile`
   benar-benar sinkron; chmod 0600 DB+WAL+SHM tiap open; `epoch-moved-unexpected`
   → `REFUSED_UNEXPECTED_EPOCH_MOVE` + release lease; LSP path-jail dari flag
   (tak double-jail); `ask_user` disembunyikan di EXECUTE×auto; lease floor 75 dtk;
   scrub password pendek + JWT tanpa signature; navy fence scheduler mencakup
   semua transisi pelepas-owner.
3. **App/runtime.** `dispatch-failed` stop value (dead ternary); docker shim
   meneruskan AbortSignal & memetakan exit non-nol → `failed`; estimasi token
   memakai tool wire-visible saja.
4. **UI/CLI/presentation.** `finding.detected` (entri `[EVALUATE]`) kini
   dirender di TUI (dulu cuma di presenter linear); findingId counter monotonic
   per child; `needsEvaluation` dihormati; bus `turn:completed` ikut flush fold;
   `lsp_rename` masuk kategori edit; writer lease dilepas saat startup throw;
   5 kunci i18n mati dihapus.
5. **Docs/gate/test.** Drift tools.md/security.md/mcp-lsp.md/contributing.md/
   CHANGELOG diperbaiki; `phase6y-mutation` exit non-zero saat ada mutant
   survive; test source-text/exact-string diganti assertion struktural; skip
   ReDoS terlihat (`skipIf`).

**Residual butuh ADR (sengaja tidak diubah):**
- `responses.ts`: `input` riwayat penuh + `previous_response_id` → konteks
  terduplikasi di server (biaya/privasi); perlu pilihan stateless vs chaining.
- `db-path.ts`: fallback global `sessions.db` adalah desain test-locked.
- `git-hardening.discoverFilterDrivers` tanpa `--local`: filter global (LFS)
  terhitung repo filter → false-positive pada mesin dengan LFS.

Peta proteksi: `test/audit-fix-deep-audit-*.test.ts`,
`test/audit-fix-writer-startup-leak.test.ts`, `test/audit-fix-live-inline-status.test.ts`,
`test/audit-fix-child-report.test.ts`, `test/phase6y-property-stress-timing.test.ts`.

Perubahan v7.39 (unreleased — remediasi audit storage/TaskStore/konteks):

Hasil audit read-only atas orkestrasi penyimpanan, TaskStore & konteks. Delapan
rekomendasi prioritas dieksekusi (satu skip dengan alasan, lihat bawah).

1. **TaskStore seam (P0).** `todo_write` kini memotret view sebelum tulis;
   `restoreTodoViewFromStore()` menurunkan ulang JSON dari TaskStore (otoritas)
   pada kegagalan sync ATAU tulis merged-id. Phantom `taskId` hilang, pesan
   error menyebut id valid & repair yang benar-benar bekerja. General startup
   repair di-wire di `cli/setup.ts` setelah writer admission.
2. **`unknown` = refuse (P0).** `findIdempotentInvocation` memperlakukan
   `state:"unknown"` seperti `pending` → tool tak pernah dijalankan ulang buta.
3. **Lease leak (P1).** `takeoverEpochUnderLease()` melepas lease saat
   `takeoverSessionEpoch` melempar, lalu me-rethrow error aslinya.
4. **IMMEDIATE + CAS (P1).** `synchronizeCanonicalTasks` pakai transaksi
   IMMEDIATE; `expectedRevision` + `refuseSchedulerRequeue()` mencegah
   `todo_write` basa menimpa task yang di-claim scheduler.
5. **Boundary konteks (P1).** `safeBaseSeq` tak lagi menggeser maju; boundary
   tak aman → fallback histori penuh (nol kehilangan pesan/tool result).
6. **Thrash guard (P1).** Progress kompaksi diukur dari estimasi token
   (`max(token, count)`), bukan `messages.length` — kompaksi content-only tak
   lagi mematikan jalur LLM.
7. **P2 aman.** chmod `-wal`/`-shm` jadi 0600; `context.window` di-wire di
   `onContextWindowEscalated`; katalog GPT-4.1 1M → 1.05M sinkron dengan preset.

**Skip P2-7 (db-path):** global fallback `sessions.db` adalah desain yang
dikunci test (`cli-subcommands.test.ts` "global scope"), bukan bug murni —
menyatukan resolusi = perubahan perilaku observable yang butuh ADR owner.

Peta proteksi: `test/audit-fix-todo-recovery.test.ts`,
`test/audit-fix-verify-unknown-and-lease.test.ts`,
`test/audit-fix-context-boundary-and-thrash.test.ts`, `test/session-epoch.test.ts`,
`test/context-window-catalog.test.ts`, `test/phase4a4-production-sync.test.ts`.

Perubahan v7.38 (unreleased — 3 tool baru, wire parameter seragam, ReDoS guard):

1. **Tool baru (38 → 41).** `git_restore` & `git_checkout` (path-restore
   sempit, argv array + `--`, jail, gated) memakai `runGit` hardened;
   `lsp_rename` menerapkan `WorkspaceEdit` nyata per-file dengan jail &
   `isError` saat server/kapabilitas absen (fail-closed). Semua via `ws(...)`
   → `WORKSPACE_MUTATION`, `jailTarget:"file"`, `gatedByDefault:true`.
2. **Wire parameter disatukan.** Tool LSP `file` → `path`; `move_file`
   `from`/`to` → `path`/`destination` di schema + execute + **semua** call
   site (permission jail, executor, binding, no-progress, journal, test).
   Helper non-wire mempertahankan fallback `from`/`to` hanya untuk args
   historis. `lsp_rename` masuk `LSP_WIRE_TOOLS`.
3. **Grep ReDoS guard (L7).** `isReDosPronePattern()` mendeteksi nested
   quantifier / quantifier-backref di **JS fallback saja** (ripgrep Rust
   regex tetap linear & tak terkena). Pattern berbahaya → `isError`
   eksplisit; `GREP_JS_LINE_MAX_CHARS = 100_000` mencegah hang pada baris
   sangat panjang. Reguler & jalur ripgrep byte-identik.
4. **Derivasi count.** Pin jumlah tool/contract/kelas mutasi diperbarui
   (41 total, 12 explore, 32 plan-anak, 18 read-only, 15 kelas mutasi jurnal).

Peta proteksi: `test/audit-fix-new-tools-and-wire.test.ts`,
`test/audit-fix-grep-redos.test.ts`, `test/grep-security.test.ts`,
`test/audit-fix-governance.test.ts` (path jail pada tool gated baru),
`test/journal-verify.test.ts`, `test/delegate-audit.test.ts`.

Perubahan v7.37 (unreleased — ringkasan DIPOTONG per segmen narasi):

> v7.36 salah tangkap: baris statusnya akumulatif sepanjang turn. v7.37
> menggantinya dengan pola OpenCode — satu baris count **per segmen laporan**,
> di-flush tepat di bawah narasi yang mendahului tool, lalu di-reset.

1. **Segment fold.** `stream()` `src/ui/tui/transcript.ts` mendeteksi transisi
   narasi baru (`pending` kosong setelah tool `commit()` sementara
   `activityFold` masih berisi) → `flushActivityFold()` dipanggil SEKARANG,
   bukan menunggu `turn.completed`. Baris permanen `+ N …` mendarat setelah
   narasi segmen itu, lalu fold dikosongkan untuk segmen berikutnya.
2. **Hitungan per segmen, bukan kumulatif.** `liveSummaryRows()` kini
   membaca fold segmen berjalan saja; tiap update progres model memproduksi
   barisnya sendiri. Contoh: `+ 2 command · 2 read`, lalu segmen berikutnya
   `+ 3 command · 1 edit · 10 subagent`, dst. Turn tutup hanya mem-flush sisa
   segmen terakhir (tanpa dobel).
3. **Kategori `subagent`.** `delegate_task` dipetakan ke kategori baru
   (bukan `other`) dengan token i18n `ts.toolCategory.subagent` di en/id.
   Urutan: `command · edit · read · subagent · thought · other`.
4. **Tool gagal ikut dihitung.** Status apa pun (`completed`/`failed`/…
   ) masuk fold segmen; pesan kegagalan tetap di baris tool individual.
5. **Invariant tak berubah.** Composer `minicode ›`, footer `indicatorLine`,
   alt-screen, warna-by-default/`MINICODE_COLOR=0`, sanitasi, dan `displayWidth`
   tetap seperti v7.36.

Peta proteksi: `test/audit-fix-live-inline-status.test.ts` (cut-off per segmen,
reset hitungan, `subagent`, tool gagal, live-vs-permanen, tanpa duplikasi),
`test/activity-fold.test.ts`, `test/i18n.test.ts` (parity token baru),
`test/audit-fix-clean-composer.test.ts`, `test/tui-app.test.ts`.

Perubahan v7.36 (unreleased — status & daftar tool live di bawah narasi — DITIMPA v7.37):

1. **Ringkasan aktivitas LIVE.** `Transcript.projectAll()` menyisipkan
   `liveSummaryRows()` tepat SETELAH `pendingRows(w)` — jadi baris
   `+ N command · N read · 1 thought` (sumber: `formatFoldSummary`, sama
   persisnya dengan ringkasan permanen) mengikuti ekor narasi yang sedang
   mengalir, bukan baru muncul saat `turn.completed` dan bukan di footer.
   Cache `projectedBase` dipaksa invalidsaat `activityFold` aktif, sehingga
   hitungan ikut berubah tiap tool selesai.
2. **Daftar tool saat per-tool ditahan.** Bila `minimizeActivity`/panel aktif,
   baris kedua `Tool: name1 · name2` ditambahkan (nama lewat `sanitizeAnsiLine`,
   dipotong per lebar kolom). Di mode default baris per-tool sudah live, jadi
   tidak ada duplikasi nama — hanya ringkasan kategori yang ditambah.
3. **Transisi bersih.** `flushActivityFold()` mengosongkan fold saat turn tutup:
   baris live lenyap, baris permanen muncul — tepat satu ringkasan, tanpa
   duplikasi. Detail per-tool tetap di `/expand`.
4. **Invariant tak tersentuh.** Alt-screen, composer `minicode ›`, footer
   `indicatorLine`, warna-by-default/`MINICODE_COLOR=0`, dan aturan
   `displayWidth` tetap seperti sebelumnya; baris baru memakai token `c.*`
   dan `sourceId:-1, selectable:false`.

Peta proteksi: `test/audit-fix-live-inline-status.test.ts` (urutan di bawah
narasi, tanpa duplikasi, gating daftar tool, sanitasi), `test/activity-fold.test.ts`
(baris live saat minimize + satu ringkasan permanen),
`test/audit-fix-clean-composer.test.ts`, `test/tui-app.test.ts`.

Perubahan v7.35 (unreleased — laporan child, atribusi tamper, unifikasi scroll):

1. **Kanal laporan child inkremental.** `delegate_task` menginstruksikan child
   memancarkan baris `[FINDING] <severity> | <file:line> | <ringkasan>`; baris
   pertama dikirim lebih awal sebelum baca mendalam. Tool layer menangkapnya,
   memancarkan `minicode:child-report`, dan adapter menerjemahkannya ke event
   `finding.detected` (entri `[EVALUATE]`) yang sudah ada — UI melihat temuan
   SELAGI child bekerja dan tidak kehilangan hasil saat timeout (dulu yang
   sampai hanya kalimat pembuka). Partial pada jalur error memakai temuan
   terstruktur, bukan teks mentah. Deskripsi tool mengingatkan induk supaya
   **mengevaluasi** temuan (hipotesis, bukan kesimpulan).
2. **Atribusi tamper sadar-sesi.** `collectSessionModifiedFiles` hanya memakai
   fallback git-status bila jurnal sesi/child memuat tool mutasi
   (`write_file`/`edit`/`bash`/`code_run`/…). Audit baca-saja tak lagi divonis
   `EVALUATOR_TAMPER_ATTEMPT` karena perubahan proses lain. Deteksi tetap
   fail-closed untuk sesi yang benar-benar mutate.
3. **Onboarding `todo_write`.** Deskripsi tool kini eksplisit: wajib
   `todo_read` lalu echo `taskId` sebelum mengirim ulang daftar yang sudah ada;
   deklarasi tanpa id ditolak. Sebelumnya model baru tahu lewat error
   `TASK_IDENTITY_REQUIRED`.
4. **`scrollBy` memakai `viewH` yang sama dengan jalur scroll lain.** Sebelumnya
   PgDn menghitung `page = max(1, viewH - 1)`, sementara `scrollRows`/`jumpEdge`/
   `followTail` memakai `wrapped - viewH`. Akibatnya satu PgDn kurang dari satu
   viewport penuh dan ekor butuh satu langkah tambahan yang tak mengubah
   tampilan. Kini `page = viewH` dan `max = max(0, wrapped - viewH)` identik di
   semua jalur, jadi PgDn mencapai ekor sejati tanpa langkah no-op.

Peta proteksi: `test/audit-fix-child-report.test.ts` (ekstraksi `[FINDING]`,
partial saat gagal, adapter → `finding.detected`, penanda `[EVALUATE]`),
`test/audit-fix-tamper-attribution.test.ts` + `test/p2-verification.test.ts`
(atribusi sadar-sesi & fail-closed), `test/audit-fix-todo-onboarding.test.ts`
(deskripsi protokol todo), `test/tui-app.test.ts` (PgDn mencapai ekor tepat
sejumlah halaman penuh), `test/audit-fix-doc-ui-cleanup.test.ts` (penjaga
kontrak dokumen).

Perubahan v7.22 (renderer flat — sejarah, sebagian ditimpa v7.29+):

0. **Posisi historis.** Entri ini mendokumentasikan transisi ke renderer flat.
   Klaim visual di dalamnya TIDAK berlaku lagi; rujuk entri v7.29+ untuk
   keadaan saat ini.
1. **Monokrom penuh (historis).** v7.22 dulu memaksa `colorLevel() === 0`
   (`FORCE_MONO`). Sejak v7.29 warna nyala by default di TTY; hanya
   `MINICODE_COLOR=0` (atau non-TTY/`TERM=dumb`) yang memaksa monokrom.
2. **Zero-state (historis).** v7.22 menghapus logo/hint dari transkrip. v7.29+
   mempertahankan zero-state KOSONG: baris kosong + composer + footer, tanpa
   logo maupun hint idle (kunci `app.idleHint` sudah dihapus dari en/id di
   v7.40).
3. **Transkrip hanya esensial.** Teks user/model, error, dan SATU baris tool
   ringkas tetap tampil. Yang DIHAPUS: activity panel, activity fold/ringkasan
   `/expand`, baris running/thinking, turn summary + `ckpt`, dan baris ledger
   diagnostik untuk `task.status`, `consequence.decided`, `context.window/cutoff`,
   `verification.observed` (event tetap dikonsumsi, tak dirender).
4. **Tanpa outline/garis/kotak di konten.** Code fence tak memakai bar `│` dan
   tak memuat header bahasa (cukup indentasi dua kolom). Tabel markdown memakai
   `box:false` (kolom rata, tanpa bingkai). Dropdown `/` memakai `listRow` tanpa
   border.
5. **Footer tetap satu baris**, disesuaikan ke monokrom (spark/timer/mode/model/
   cwd/konteks/permission). Indikator status sementara tetap menggantikan baris
   footer, bukan menambah tinggi frame.
6. **Kop sesi saat exit dihapus total.** `cli/index.ts` tidak lagi melakukan
   clear-screen + `renderSessionSummary`; scrollback dikembalikan apa adanya.
7. Peta proteksi diperbarui: `test/tui-app.test.ts`, `test/tui-transcript.test.ts`,
   `test/footer-render.test.ts`, `test/activity-panel.test.ts`,
   `test/activity-fold.test.ts`, `test/thinking-area.test.ts`,
   `test/presentation-projections.test.ts`, `test/tui-format.test.ts`,
   `test/render-audit-2026-11.test.ts`, `test/ui-audit-regressions.test.ts`,
   `test/writer-inventory.test.ts` (zero-state, tanpa warna, tanpa panel/fold/
   thinking/diagnostik, fence & tabel flat, tanpa kop exit).

Perubahan v7.22.1 (control-system fixes — tidak mengubah kontrak visual v7.22):

1. **Peringatan recovery menjangkau jalur interaktif.** `cli/index.ts` kini
   memancarkan baris `[recovery]` yang SAMA (lewat helper tunggal
   `emitDelegateRecoveryLines`) baik di `catch` one-shot maupun di pembungkus
   `runPromptWithVerify` yang dipasang sebelum `runTui(ctx)`. Sebelumnya hanya
   one-shot yang memberi peringatan; turn TUI yang gagal setelah anak
   `committed` bisa mendelegasi ulang buta dan menggandakan efek samping
   (docs/AGENTS.md:25). Helper hanya membaca jurnal + memformat, tanpa retry,
   tulis jurnal, atau prompt, dan memakai satu sink stderr yang sama sehingga
   inventaris writer tak bertambah.
2. **Gated tool tetap fail-closed di non-TTY meski broker daemon di-inject.**
   `allowNonTtyAsk` di `src/policy/permission.ts` hanya membuka carve-out untuk
   tool non-gated (mis. `web_fetch`); `delegate_task` dan tool gated lain tetap
   menuntut TTY. Daemon broker tak boleh mengubah ASK non-TTY menjadi jalur
   persetujuan delegasi (docs/AGENTS.md:8, docs/exec.md).
3. **`visible === callable` untuk EXECUTE × allowlist.** `workModeVisible`
   (`src/app/tool-layer.ts`) menyembunyikan `GATED_TOOLS`/MCP saat
   `permissionMode === "allowlist"` karena handler `allowlist` menolak semuanya;
   model tak lagi melihat tool yang tak bisa dipanggil.
4. **"Always" tidak berlaku ulang untuk `delegate_task`.** `canAlwaysForCall`
   menggantikan `canPersistAlways` di `gatedPrompt` (`canAlways: false`), sehingga
   kartu persetujuan tak pernah menawarkannya; broker daemon hanya balas
   allow/deny. Satu approval ASK hanya mencakup satu delegasi (K-1 `saveAlways`
   untuk tool lain tetap utuh).
5. **Dokumentasi:** `docs/exec.md` memuat aturan eksplisit delegasi non-TTY
   (ditolak, fail-closed) yang dirujuk `docs/AGENTS.md`, dan `docs/AGENTS.md`
   memperjelas jangkauan warning recovery serta larangan "Always".

Peta proteksi: `test/audit-fix-agent-control-recovery-interactive.test.ts`,
`test/agent-contract.test.ts`, `test/work-mode-tool-visibility.test.ts`,
`test/p92-recovery-warning-envelope.test.ts`,
`test/p15-phase2-contracts-approval-recovery.test.ts`.

Perubahan v7.34 (adaptive sub-agent hidup + PTY test):

1. **Riwayat anak adaptif benar-benar dipakai.** `task.ts` menyimpan riwayat
   delegasi per-process yang dibatasi (32 entri, best-effort, key
   `${mode}:${prompt[0..64]}`). `prior` (steps/duration/success) kini dilempar
   ke `resolveSubAgentTimeout` — anak sukses cepat (<60s) memotong pagu turn
   berikutnya. Policy tetap murni; riwayat ada di tool layer.
2. **Step-escalation per-delegasi.** Jika anak sebelumnya berakhir
   `max_steps_exceeded`, delegasi berikutnya untuk key sama menaikkan `maxSteps`
   lewat `nextStepLimit(prevCap, observedSteps)` (plafon `SUB_AGENT_MAX_STEPS`).
   Tanpa kegagalan sebelumnya tidak ada kenaikan; `maxSteps` eksplisit caller
   selalu menang.
3. **Test PTY `/shell` jujur.** `test/audit-fix-shell-pty.test.ts` menjalankan
   CLI nyata di PTY: `/shell` → lepas alt-screen (`ESC[?1049l`) → marker unik
   dari `echo` → `exit` → alt-screen masuk lagi (`ESC[?1049h`) + composer.
   E2E penuh hanya di POSIX; di win32 (ConPTY input fragil) test partial yang
   terbatas hanya membuktikan release + prompt shell. Keduanya memakai
   `test.skipIf` — skip terlihat, bukan PASS diam-diam.
4. **Drift test dibetulkan.** `test/p9-admission-boundaries.test.ts` B3 dulu
   memaku timeout 300s tetap; kini membandingkan dengan
   `resolveSubAgentTimeout()` dan memeriksa batas timer — kontrak adaptif
   dipertahankan, bukan diubah.

Peta proteksi: `test/audit-fix-subagent-adaptive-history.test.ts`,
`test/audit-fix-shell-pty.test.ts`, `test/p9-admission-boundaries.test.ts`,
`test/delegate-audit.test.ts`, `test/audit-fix-subagent-adaptive.test.ts`.

Perubahan v7.33 (kritik wire contract & governance):

1. **Otorisasi tool LIVE.** `createLiveAuthorizedTools()` menggantikan snapshot
   statis `authorizedTools` — predicate membaca array `rest.tools` yang di-mutasi
   in-place oleh `setWorkMode`/`setPermissionMode`. Transisi DISCUSS↔EXECUTE kini
   menjaga `visible === callable` juga untuk tool MCP runtime.
2. **Single source of truth benar-benar tunggal.** `ToolContractMetadata`
   memiliki flag `jailTarget`/`internalWrite`/`noPrompt`/`allowedInPlan`; semua
   Set di `permission.ts` (FILE_WRITE, INTERNAL_WRITE, NO_PROMPT, PLAN_EXTRA,
   jail groups) dan `PLAN_EXTRA_TOOL_NAMES` diturunkan dari `TOOL_CONTRACTS`.
   Tool workspace-mutation baru (`ws(...)`) otomatis ter-jail & auto-allowed.
3. **Fail-closed receipt.** Journal tak terbaca → `findIdempotentInvocation`
   mengembalikan `pending` (refuse), bukan `proceed`. Kehilangan receipt durable
   tidak lagi dibuang via `void` — `onReceiptLoss` (production wiring di
   `src/tools/evidence.ts` memakai `throwOnReceiptLoss`) memberi sinyal keras.
   Scope read-only tetap bypass jurnal (mutation-scoped).
4. **Jujurnya test.** Test sandbox/TOCTOU/non-TTY yang dulu `return` diam-diam
   kini `test.skip` terlihat; ada integration test `bash exit 7` nyata,
   `ctx.cwd ≠ process.cwd()` untuk jail, dan test REFUSED_ berbasis perilaku
   (isError), bukan regex sumber. Pin exact-string dilonggarkan.
5. **Wire contract lebih hemat** (lihat deskripsi tool): family tag, aturan
   edit→apply_patch→write_file yang identik, deskripsi `bash`/`web_search`
   dipangkas, empty-result diberi next-step, dan LSP menyatakan posisi 0-based
   vs 1-based.

Peta proteksi: `test/audit-fix-governance.test.ts`,
`test/audit-fix-receipt-failclosed.test.ts`, `test/audit-fix-shell-handoff.test.ts`,
`test/audit-fix-tool-tests-quality.test.ts`, `test/audit-fix-wire-contract.test.ts`,
`test/new-tools.test.ts`, `test/tools.test.ts`, `test/cli-commands.test.ts`.

Perubahan v7.32 (audit per-tool + shell interaktif):

1. **Error semantics per-tool.** 6 tool LSP, `notConnected()` MCP, dan 4 jalur
   `REFUSED_*` sub-agent kini **melempar** error (isError), bukan string sukses;
   sentinel "tidak ada hasil" tetap string. `git` timeout me-reject dengan
   `effective.reason` (bukan `exit null`). `code_run` timeout melempar (paritas
   `bash`). Hasil LSP dibatasi (diagnostics 50, symbols 100).
2. **Efisiensi & konsistensi tool.** `web_search` pasang abort listener sebelum
   cek `aborted`; `bash` membersihkan timer/listener di `error` maupun `close`
   dan menggabungkan cap stdout+stderr (20k total); `bash_kill` membatalkan timer
   lama; `glob`/`grep` mengurutkan hasil; `read_memory` `topK` di-clamp 1..25;
   `grep` membedakan timeout dari "no matches"; `ask_user` meneruskan sinyal
   turn ke modal (abort memutus penungguan jawaban).
3. **Shell interaktif via handoff (`/shell`).** Composition root melepas
   alt-screen + raw mode (`releaseTerminal`), spawn shell asli dengan
   `stdio:"inherit"` (PTY/terminal asli — `vim`, warna, resize jalan), lalu
   `reacquireTerminal()` saat shell selesai. Tidak ada PTY adapter in-TUI,
   sehingga invariant #1/I3 & writer-inventory tetap utuh. Non-TTY/one-shot
   menolak fail-closed. Perintah `bash` untuk model tetap non-interaktif oleh
   desain (model mengirim string perintah, bukan mengetik ke PTY).

Peta proteksi: `test/audit-fix-tool-errors.test.ts`,
`test/audit-fix-tool-efficiency.test.ts`, `test/hardening-boundary.test.ts`,
`test/new-tools.test.ts`, `test/mcp-resources-prompts.test.ts`,
`test/cli-command-audit-regressions.test.ts`, `test/audit-fix-deep-tool-*.test.ts`.

Perubahan v7.31 (audit bug menyeluruh):

1. **Kontrol:** drag-selection auto-scroll dibalik ke arah tepi yang benar
   (anchor atas → tepi atas = ke lama); abort user ditangkap di `runTurnOnce`
   sehingga toast "stopped" tampil dan tak ada error line permanen di transkrip;
   scroll bound memakai `viewportHeight` tanpa `-1` (off-by-one hilang).
2. **Sub-agent:** watchdog liveness kini menghitung `provider:text` sebagai
   bukti hidup (streaming panjang tak lagi salah di-abort); flag
   `maxStepsExceeded` ikut ke receipt durable; `SESSION_RENEW_INTERVAL_MS`
   diturunkan dari lease.
3. **Tool/keamanan:** `isExitCodeFailure` mengenali `exit null/unknown` dan
   `[TOOL_OUTCOME state=UNKNOWN …]`; `mcp_read`/`mcp_prompt` melempar error
   (isError) alih-alih string sukses; OS sandbox meneruskan kredensial git saat
   unrestricted; timer eskalasi `bash_kill` dibersihkan saat job close.
4. **Persistensi/provider:** `activity.label` punya validator replay (self-title
   selamat dari restart); tool events tak lagi lolos dengan `||` (mencegah state
   sesi terhapus); `history_summaries` ikut dihapus saat sesi dihapus; Responses
   API selalu `store:true` agar chaining valid; watchdog first-byte kompaksi tak
   dibatalkan event sintetis `minicode:attempt`.

Peta proteksi: `test/tui-app.test.ts`, `test/delegate-audit.test.ts`,
`test/p92-child-result-envelope.test.ts`, `test/providers-p11.test.ts`,
`test/mcp-resources-prompts.test.ts`, `test/audit-fix-deep-tool-failed-exit.test.ts`.

Perubahan v7.30 (receipt ke footer, ringkasan tool, sub-agent adaptif, caret):

1. **Riwayat percakapan hanya berisi percayakan.** Semua receipt (copy,
   `/mode`, `/view`, `/lang`, steer/queue, unknown command) kini lewat
   `app.showToast()` → footer indicator, bukan `transcript.pushInfo`. Startup
   notices, approval, dan output perintah nyata tetap di transkrip. Prioritas
   indicator: toast > abort hint > baris-baru.
2. **Ringkasan tool satu baris per turn.** `flushActivityFold()` aktif lagi:
   `  + 5 command · 3 edit · 1 thought` (kategori dari nama tool, tanpa kotak/
   grup). Detail lengkap tetap di `/expand`. Baris ini sekaligus jadi pemisah
   antar turn/laporan. Baris tool live saat turn berjalan tetap tampil.
3. **Sub-agent adaptif & diawasi.** Timeout dihitung `resolveSubAgentTimeout`
   dari panjang prompt + riwayat (default 300s, env tetap dihormati). Watchdog
   `step:started`/`execution:started` memperbarui `lastProgressAt`; bila stall
   melebihi `min(timeout/4, 120s)`, child di-abort via `session.abort()` tanpa
   mengganggu turn induk. `max_steps_exceeded` kini mencatat outcome
   (`maxStepsExceeded:true`) → Run INTERRUPTED, bukan COMPLETED, dengan pesan
   `step limit reached (N/M)`.
4. **Caret prompt menempel di `›`.** Spasi trailing dihapus dari `promptFirst()`;
   bar tegak DECSCUSR kini tampil tepat setelah `minicode ›`, bukan setelah
   spasi tak terlihat.

Peta proteksi: `test/audit-fix-footer-receipts.test.ts`,
`test/audit-fix-compact-tool-summary.test.ts`, `test/audit-fix-subagent-adaptive.test.ts`,
`test/p92-child-result-envelope.test.ts`, `test/p92-recovery-warning-envelope.test.ts`,
`test/tui-app.test.ts`, `test/cli-command-audit-regressions.test.ts`.

Perubahan v7.29 (warna, chat bersih, sparkle adaptif, prompt sebagai history):

1. **Prompt jadi history, card dihapus.** `projectRows()` tidak lagi
   menyembunyikan gema user terakhir; `cardRows`/`promptCard`/`lastUserPrompt()`
   dihapus. Prompt yang dikirim tampil langsung di transkrip sebagai baris
   `minicode › …`, bukan band mengambang. Semua turunan `cardH` collapse ke 0
   sehingga tinggi frame & pemetaan mouse tetap konsisten.
2. **Warna menyala by default di TTY.** `FORCE_MONO` dihapus; prioritas:
   `MINICODE_COLOR=0|false|off|no` → monokrom, lalu `NO_COLOR` (0 = nyala),
   lalu non-TTY/`TERM=dumb` → level 0, baru `COLORTERM`/`TERM`/`getColorDepth`.
   Heading memakai `accentBold`, inline code `brightCyan`, keyword/string/angka
   di `highlight.ts` (magenta/hijau/kuning), tool `accentAlt`. `stripAnsi()`
   tetap menghasilkan teks identik — hierarki tidak bergantung pada warna saja.
3. **Kolom chat bersih.** `busyProgressLine`/`activityStatus`/`activityRow`/
   `composerProgressPrefix`/`thinkingActive` dihapus dari `app.ts`. Composer
   SELALU menampil `minicode ›` + draft, siap diketik, walau turn berjalan.
   Status kerja pindah ke footer `indicatorLine` (slot yang sudah ada).
   **Catatan v7.36:** keputusan "chat bersih" ini tetap berlaku untuk
   *composer* dan `app.ts` (tak ada progress row di sana), TAPI ringkasan
   aktivitas kini kembali live di dalam **transkrip** di bawah narasi —
   lihat entri v7.36 yang menimpa bagian "status hanya di footer".
4. **Sparkle adaptif.** `FooterStatus.streamIntervalMs` baru; `app.ts` mengukur
   jeda antar `provider:text` (jendela 6 sampel) → interval 120/150/220/320 ms;
   `sparkFrame` memakai interval itu. Model cepat = kelip cepat & terang-redup
   lebih sering. `MINICODE_MOTION=0` tetap mematikan animasi.
5. **Lingkaran unrestricted** (`glyphs.unlock` `○` / `[OPEN]`) kini benar-benar
   merah via `c.red` saat warna menyala; tetap polos di mode monokrom.
6. **Pemisah narasi→tool.** Satu baris kosong disisipkan sebelum baris tool
   pertama per turn (analog `marginTop=1` OpenCode), bukan tiap tool.

Peta proteksi: `test/audit-fix-color-mode.test.ts`, `test/theme*.test.ts`,
`test/highlight.test.ts`, `test/tui-app.test.ts`, `test/tui-transcript.test.ts`,
`test/footer-render.test.ts`, `test/audit-fix-deep-control-tui.test.ts`,
`test/audit-fix-live-progress.test.ts`.

Perubahan v7.28 (anchor transkrip atas ala OpenCode):

1. **Transkrip di-anchor dari ATAS.** `Transcript.viewport()` kini memakai
   `firstIndex = min(scrollBack, max(0, len - height))` (sebelumnya dihitung
   dari ekor). Saat konten lebih pendek dari viewport, baris kosong ditaruh
   DI BAWAH (`rows.push`), bukan di atas — pesan mulai dari baris pertama,
   ruang kosong berada tepat di atas card/composer yang tetap di bawah.
2. **Makna `scrollBack` berubah.** `0` = kepala/teratas; nilai besar bergerak
   ke bawah; `scrollBack = maks` = ekor (terbaru). PgUp/PgDn dan wheel
   mengikuti arah ini; Home → `0`, End → maks. `followTail()` (dipanggil saat
   ketik/submit) kini men-set `scrollBack` ke maks.
3. **Auto-follow tetap "sticky at tail".** Seperti OpenCode (`stickyStart`
   bottom + toggle saat away), minicode hanya mengikuti ekor bila user sudah
   di ekor. Stream yang masuk saat userscroll ke atas TIDAK merampas posisi;
   indikator `app.newBelow` muncul bila `scrollBack < maks`.
4. **Drift `lastWrapped` dihapus.** Karena baris baru ditambahkan di bawah,
   mereka tidak menggeser baris yang sedang terlihat — koreksi posisi lama
   tidak lagi diperlukan. Tinggi frame, `transcriptTop`, `composerTop`, dan
   pemetaan mouse/seleksi tidak berubah (viewport tetap tepat `viewH` baris).

Peta proteksi: `test/tui-transcript.test.ts` (padding bawah, scrollBack arah,
cap/marker), `test/tui-app.test.ts` (PgUp/PgDn, wheel, indikator baris baru,
kembali ke ekor saat ketik, seleksi lintas jeda).

Perubahan v7.27 (narasi kerja aktif & progres live):

1. **Sistem prompt meminta narasi seimbang.** Blok `# Communication` (sekitar
   700 char, sebelum `opts.extra` dan semua blok DATA agar selamat dari cap
   8000) mengarahkan model: ceritakan kerja dalam kalimat pendek, konfirmasi
   tujuan + pendekatan di awal tugas non-trivial, satu kalimat sebelum tool
   non-rutin, sebut sub-agent yang di-spawn + ringkas temuannya + flag
   ketidaksesuaian, dan tutup dengan catatan/caveat. Delegasi juga didorong
   lebih awal untuk riset/audit paralel (scope kecil, ≤5 temuan) tanpa
   mengubah aturan otorisasi/WorkMode.
2. **Satu baris progres live, flat & monokrom.** Event durable baru
   `step.started` (dari `step:started` kernel) dan `plan.updated` dari
   `todo_write` kini tampil di slot status/composer yang SAMA — tidak
   menambah tinggi frame. Prioritas: abort hint > langkah > rencana `todos
   d/t` > tool berjalan (+elapsed) > dots thinking. Baris ini TETAP tampil
   walau user mengetik draft (draft berbagi baris, prefix progres di depan).
   Tanpa warna, tanpa kotak, tanpa panel/ledger/turn-summary.
3. **Replay progres.** `step.started` divalidasi eksplisit di
   `isValidEventShape` (`src/session/persistence.ts`) agar tidak ditolak saat
   `decodePresentationEvent` saat resume — cache snapshot tetap invalidasi
   via `state.seq` yang naik.

Peta proteksi: `test/audit-fix-communication-prompt.test.ts`,
`test/audit-fix-live-progress.test.ts`, `test/tui-app.test.ts`,
`test/presentation-projections.test.ts`, `test/presentation-bridge.test.ts`,
`test/context-audit.test.ts`, `test/instruction-trust.test.ts`.

Perubahan v7.26 (sub-agent lebih kokoh & bernama):

1. **`delegate_task.timeoutMs` dapat diatur per panggilan.** Skema menerima
   `timeoutMs` opsional (finite, >0, dibatasi `MAX_TIMER_DELAY_MS`); nilai
   invalid ditolak fail-closed. Sebelumnya timeout 120 dtk di-hardwire untuk
   semua child, sehingga fan-out 5 `explore` mudah kena `turn exceeded 120000ms`.
2. **Default timeout 300 dtk + env override.** `SUB_AGENT_TIMEOUT_MS` naik dari
   120_000 ke 300_000 dan bisa diubah lewat `MINICODE_SUB_AGENT_TIMEOUT_MS`
   (divalidasi saat module load). `SESSION_LEASE_MS` diturunkan
   `ceil(timeout * 2.5)` dari konstanta yang sama (tak lagi angka hardcode), dan
   default autonomous mengikuti konstanta itu.
3. **Pool bisa diatur** lewat `MINICODE_SUB_AGENT_POOL_SIZE` (1..16, default 3).
   Fan-out 5 benar-benar paralel bila di-set 5; antrean bukan penyebab timeout
   (clock mulai saat slot didapat), tapi ini membuka opsi tersebut.
4. **Timeout fail-soft dengan hasil parsial.** Teks yang sudah mengalir
   (`provider:text` / extension `text`, reasoning dikecualikan) dikumpulkan
   (cap 1.200 char) dan disertakan di pesan induk + receipt, bukan dibuang.
   Status child tetap `timeout`, ACE FAIL/BLOCKED, efek filesystem tidak
   di-rollback, dan slot pool tetap dilepas (verifikasi `finally` di pool).
5. **Nama sub-agent menggantikan kode opak.** Arg `name` opsional; bila kosong
   dibuat label otomatis `explore-1`, `plan-2`, … Label dinormalisasi (karakter
   kontrol dibuang, maks 40 char) dan disanitasi sekali lagi saat render oleh
   `runMarker()`, yang mengutamakannya di atas fallback `run_<8>`/`sub_<8>`.
   Rantai: `tagForwarded` → `ChildSessionLink` → `Activity` →
   `UiPresentationActivity` → `reducer` → `presentation-bridge` → `cli/setup`
   → marker di TUI & renderer linear.

Peta proteksi: `test/audit-fix-subagent-timeout-name.test.ts`,
`test/delegate-audit.test.ts`, `test/presentation-projections.test.ts`,
`test/p9-admission-boundaries.test.ts`, `test/phase6y-lease-core.test.ts`.

Perubahan v7.25 (audit mendalam kontrol ↔ render ↔ mode ↔ tool):

1. **Kontrol:**
   - flag `awaitingSecondEsc` menggantikan ketergantungan pada `lastAbortAt`
     saja; mengetik draft baru setelah abort melepaskan gesture quit.
   - Card prompt mengikuti `transcript.lastUserPrompt()`, sehingga steering saat
     busy langsung terlihat di card (bukan prompt lama).
   - `buildLayout` tidak lagi dipanggil dari callback backdrop saat popup
     suspended — frame redup dibekukan sekali saat `suspend()`.
   - `abortHintOn` di-reset di `turn:started`.
   - overflow paste >512 KiB tetap dalam mode paste sampai `ESC[201~`; parser
     mouse SGR membatasi pencarian `;` ke dalam rune sequence saat ini.
2. **Mode & permission:**
   - cleanup background job dipasang juga di `process.once("exit")` (selain
     `close()`), jadi SIGTERM/SIGHUP tak meninggalkan child detached.
   - `abortRequested` dibersihkan saat turn baru dibuat, bukan di `submit()`;
     auto-resume background job tetap bisa menerima steering.
   - `code_run` disembunyikan di EXECUTE × allowlist (`visible === callable`).
   - "Always" untuk `delegate_task` diblokir juga di policy (`saveAlways`,
     `matchAllowlist`), bukan hanya di view.
   - footer membaca mode permission live (satu sumber dengan `/status`).
   - `--session <id>` takeover memulihkan WorkMode tersimpan.
   - `readonly`/`plan` kini meng-gate `web_fetch`/`web_search` lewat `ask`
     (headless = deny).
3. **Tool:**
   - `exit N` dari git/bash/code_run diklasifikasikan sebagai `tool.failed`
     dengan pesan exit (tampil di ledger flat & linear), bukan sukses.
   - `isAlreadyFenced()` mewajibkan nonce — pagar start-only dari konten
     eksternal ditolak dan dibungkus ulang.
   - `runGit` menolak saat `signal.aborted`; retry commit cek `throwIfAborted`.
   - error MCP dilempar lagi agar `isError` terdeteksi (bukan string sukses).
   - kredensial git diteruskan ke sandbox docker saat mode `unrestricted`.
   - deskripsi `web_search` tidak lagi mengklaim SSRF guard yang tak dipakai.
   - ID approval unik per permintaan (`randomUUID`), bukan counter global.

Peta proteksi: `test/audit-fix-deep-control-*.test.ts`,
`test/audit-fix-deep-mode-*.test.ts`, `test/audit-fix-deep-tool-*.test.ts`,
`test/tui-queue.test.ts`, `test/work-mode-*.test.ts`, `test/permission-*.test.ts`,
`test/scrub-fence.test.ts`, `test/p15-phase4-context-fence-and-e2e.test.ts`,
`test/phase6s-autonomous-permission-policy.test.ts`,
`test/phase6v-adversarial-audit.test.ts`.

Perubahan v7.24 (ritme spasi transkrip):

1. **Satu baris kosong untuk setiap batas blok.** `pushUser` kini menyisipkan
   jeda SEBELUM dan SESUDAH prompt user; gema user terakhir (yang dipindah ke
   card v7.23) ikut tersaring sebelum normalisasi, sehingga jeda sebelum card
   tetap tepat satu baris. `projectAll` memakai `normalizeBlankRuns` — run dua
   atau lebih baris kosong diruntuhkan jadi satu, baik di jalur cache maupun
   jalur dinamis (streaming/activity).
2. **Card hanya menyimpan jeda bawahnya.** Jeda atas card disuplai baris kosong
   dari viewport yang sudah dinormalisasi (bukan padding card), sehingga tidak
   ada dobel spasi antara jawaban/model dan card prompt.
3. Ritme akhir per turn: `user → (1 kosong) → jawaban/tools → (1 kosong) →
   card prompt berikutnya → (1 kosong) → composer → (1 kosong) → footer`.

Peta proteksi: `test/tui-transcript.test.ts` (jeda antar-turn, prompt mentah
untuk card, seleksi baris terbungkus), `test/tui-app.test.ts` (card tepat di
atas composer tanpa gema dobel), `test/presentation-projections.test.ts`,
`test/activity-panel.test.ts`.

Perubahan v7.23 (card prompt & perbaikan kontrol TUI — melanjutkan v7.22):

1. **Prompt user jadi card transparan di atas composer.** `TuiApp` menyimpan
   prompt terakhir dan merendernya sebagai box yang outline + background-nya
   memakai warna terminal (nyata secara struktural, tak terlihat secara visual:
   tanpa garis, tanpa SGR). Card diposisikan TEPAT di atas composer; seluruh
   teks jawaban, tool, dan aktivitas turn berjalan dirender DI ATAS card.
   Gema inline `minicode › <prompt>` di viewport disembunyikan supaya tak dobel
   (card menggantikannya). Tinggi viewport, posisi kursor composer, dan
   `composerTop` sudah disesuaikan dengan tinggi card.
2. **Kontrol mati dihapus.** `Ctrl+O`/`Ctrl+T` tidak lagi terikat dan tidak
   tercantum di `/help keys`; `/view compact|fold|minimize` dihapus dari
   `VIEW_ACTIONS` (kini hanya `thinking|expand`). Flag lama tetap di `TuiHost`
   sebagai no-op tanpa receipt — tidak ada lagi umpan balik palsu "tool output:
   compact" / "thinking: expanded" di renderer flat yang tak mengonsumsinya.
3. **Decoder input aman untuk Alt/ESC.** `ESC` + byte printable kini menghasilkan
   `ignore` (bukan `esc`), sehingga `Alt+b` di composer tidak meng-abort turn
   sibuk. Lone-ESC dan `Alt+Enter` (`ESC+CR`) tetap dipertahankan, termasuk bila
   terpisah di dua chunk stdin (`pendingLoneEsc`). Overflow bracketed-paste
   mundur ke batas codepoint UTF-8 terakhir (tanpa `U+FFFD`).
4. **Double-Esc quit tidak hilang.** Pen-cekan `lastAbortAt` (1,5 dtk) kini
   dilakukan SEBELUM cabang busy/idle, sehingga abort yang langsung selesai
   tetap bisa diikuti Esc kedua sebagai quit (bukan `/undo`).
5. **Approval & steering.** Idle guard approval di-reset pada SETIAP ketikan/
   chunk (I21), bukan hanya pada perubahan state. Steering fallback menolak
   antrean (`abortRequested`) antara abort unwind dan submit berikutnya — niat
   yang dibatalkan tak boleh hidup lagi sebagai turn baru.

Peta proteksi: `test/tui-app.test.ts` (card, posisi composer, double-Esc),
`test/audit-fix-control-decoder.test.ts`, `test/audit-fix-control-dead-keys.test.ts`,
`test/prompt-engine.test.ts`, `test/input-recovery.test.ts`, `test/tui-queue.test.ts`,
`test/approval-tui.test.ts`, `test/cli-command-audit-regressions.test.ts`.

Perubahan v7.21 (steering transaksional & penagihan langkah):

1. **Steering ikut transaksional dengan turn.** Pesan yang sudah diterima
   kernel tetapi belum masuk konteks (turn abort/timeout/gagal) hilang bersama
   turn itu; ia tidak boleh muncul sebagai `user` di depan prompt turn
   berikutnya. Ekor histori yang ter-commit saat turn terputus juga tidak
   menyisakan `user` yang belum dibalas. Sebelumnya sisa antrean bocor ke turn
   berikutnya sehingga model membalas pesan dari turn yang sudah dibatalkan,
   dan ekor `user` menggantung melanggar invariant role bergantian.
2. **Request lanjutan untuk steering menagih anggaran langkah.** Turn yang
   memakai dua request provider (jawaban + jawaban setelah steering) melaporkan
   `usage.steps` dan dihitung `maxSteps`, sehingga rangkaian steering tidak
   menjadi jalur bebas batas.

Peta proteksi: `test/kernel-steer.test.ts` (steering masuk turn aktif, hilang
saat abort, penagihan langkah), `test/tui-queue.test.ts` (fallback antrean saat
kernel menolak steering).

Perubahan v7.20 (perapian teks render & keterbacaan idle):

1. **Ledger tool memakai chevron + status kondisional.** Baris terminal tool
   kini `  › name target` untuk sukses, dan `  › name target · <status>: <pesan>`
   hanya untuk status non-sukses (`failed`/`denied`/`cancelled`/`interrupted`).
   Sebelumnya setiap baris (termasuk sukses) diakhiri kata status sehingga
   daftar tool panjang menjadi derau, dan baris tanpa chevron tidak sesuai
   grammar kontrak. Baris anak memakai aturan yang sama setelah `↳ run_<8>`.
2. **Ringkasan turn melewati counter nol.** `turn N · <counter non-nol>` +
   `ckpt <id>` hanya bila checkpoint ada + durasi. Baris lama selalu memuat
   `0 ditolak · 0 dibatalkan · 0 terhenti` dan `ckpt —`.
3. **Header code fence memakai bar blok.** Pembuka fence berbahasa tampil
   `│ ts` (bar yang sama dengan isi blok) alih-alih `· ts` yang terbaca seperti
   poin daftar — di TUI maupun renderer linear.
4. **Zero-state idle ramah dibaca.** Logo tetap di pojok kiri atas, plus satu
   baris hint redup (kunci `app.idleHint`, sudah dihapus di v7.40);
   identitas tidak diduplikasi dari footer.
5. **Kop sesi rata kolom.** Lebar label dihitung dari label terpanjang locale
   aktif, bukan `padEnd(7)` mati — `Pemakaian` (9) dulu merusak perataan.

Peta proteksi: `test/tui-transcript.test.ts` (ledger sukses `›`, header fence),
`test/presentation-projections.test.ts` (status non-sukses ber-`·`, baris run
anak, ringkasan turn), `test/activity-panel.test.ts` (alasan gagal tetap tampil),
`test/tui-app.test.ts` (zero-state kosong tanpa logo/hint), `test/session-summary.test.ts`
(kop sesi), `test/i18n.test.ts` (kunci ringkasan turn di kedua locale).

Perubahan v7.19 (remediasi audit & ergonomi UX):

1. **Dropdown `/` mendukung penyelesaian `Tab`.** Ketika menu `/` sedang terbuka
   dan memiliki kandidat, `Tab` melengkapi nama command terpilih (atau kandidat
   teratas) ke composer (`menuOpen` menutup tanpa eksekusi langsung); ketika
   dropdown tertutup atau tidak ada kandidat, `Tab` tetap memutar `WorkMode`
   (`Discuss ↔ Build`).
2. **Jendela output command interaktif penuh.** `runOutputWindow` menghitung ulang
   wrap dan lebar kotak secara dinamis saat `resize`, mempertahankan posisi
   scroll proporsional, menampilkan counter posisi di judul saat scrollable,
   menyembunyikan hint scroll saat pas 1 layar, menerima `wheelup`/`wheeldown`/
   `j`/`k`/`Space`, serta mendukung salin isi jendela via tombol `c` ketika
   `onCopy` disediakan.
3. **Modal & formulir adaptif.** Picker, manager model, dan manager penyedia
   mendukung `wheelup`/`wheeldown` serta menjaga `visibleRows` tetap positif
   meski pesan notice membungkus; form men-stack label panjang di atas baris
   input agar lebar field minimal tetap terjaga, dan menyaring byte kontrol C1
   (`\u0080–\u009f`); wizard menjaga pesan error sampai user menekan Enter/Esc.
4. **Zero-state clean (logo kecil pojok kiri atas), ritme transkrip, seleksi akurat, & ASCII konsisten.**
   Saat transkrip kosong dan idle, logo kecil minicode (`14×9` half-block) tampil
   di pojok kiri atas, diikuti SATU baris hint redup (`app.idleHint` historis,
   dihapus v7.40: mulai /
   `/help` / `Ctrl+D`) satu baris di bawahnya. Identitas (model/CWD) tidak
   diulang karena footer sudah memuatnya; hint hilang begitu user mengetik atau
   transkrip terisi, dan tidak ditambahkan bila tinggi viewport tak cukup (logo
   saja). Jumlah baris frame tidak berubah dan baris spacer tetap. Transkrip
   menambahkan jeda antar-turn sebelum `pushUser`, header bahasa redup pada
   pembuka code fence berbahasa, serta pemetaan `displayStart` dan teks inline
   untuk akurasi `pointAt`/`columnAtOffset`. `Shift+Enter`/`Alt+Enter` modern
   (`\x1b\r`, `\x1b[13;2u`, `\x1b[27;2;13~`) disambungkan ke newline (`ctrl-j`),
   bracketed paste tak-tertutup dibatasi 512 KiB, dan seluruh divider/ellipsis/
   marker mengikuti `glyphs.*` (`MINICODE_ASCII=1`).

5. **Konsistensi penuh Layer 2 overlay & backdrop adaptif (v7.19).**
   - Semua permukaan Layer 2 (`picker`, `model-manager`, `provider-manager`,
     `output-window`, `form`, `approval`, `ask_user`, `/sync`, `wizard`)
     memakai `spec.footer` yang dipin di luar clipping window `dialogBox`, dan
     `dialogBox` tidak membungkus ulang footer ber-SGR agar warna tombol
     `hintLine` / peringatan tetap kontras dan bersih.
   - `runPicker` nested di dalam manager/wizard menerima `screen` induk dan
     induk menghapus regionnya sebelum sub-modal dilukis — meniadakan bingkai
     induk terpotong di belakang anak.
   - `registerScreenBackdrop` + `regionEpoch` memastikan backdrop redup
     Layer 1 dipulihkan saat kotak menyusut/tertutup/resize tanpa `ESC[2J`
     penuh, sekaligus menjamin `TuiApp.resume()` melukis ulang sel tertutup
     meski `NO_COLOR=1`.
   - `form`, `picker`, `approval`, dan `ask_user` kini mengikuti `resize`
     secara dinamis, menjaga batas minimum `canRenderModal` (`20×10`),
     menggunakan `glyphs.arrow` untuk echo approval/`ask_user`, menangani
     `wheel` (di approval & dropdown `/`), menyembunyikan kursor di jendela
     non-ketik (read-only / list-only / progres), serta menampilkan progres
     `/sync` langsung di Layer 2 dan mengarahkan warning reload manager ke
     notice/captured log alih-alih menulis mentah ke `stderr`.

Perubahan v7.18 (jendela output command):

1. **Output command readout tampil sebagai JENDELA di atas chat.** `/help`,
   `/status`, `/context`, `/history`, `/expand`, `/sync`, `/init`, `/scheduler`,
   `/undo list` (dan alias `/cost`/`/usage`) tidak lagi dicetak ke transkrip.
   Output-nya dibuka di overlay read-only `runOutputWindow` (`src/ui/screens/
   output-window.ts`) dengan judul, body, dan hint; transkrip/chat tidak
   tersentuh dan tidak bergeser. Receipt aksi pendek (`/undo`, `/redo`,
   `/copy`, toggle) tetap di transkrip.
2. **Format jendela command seragam.** Output window dan jendela interaktif
   (`/model`, `/provider`, `/sessions`, picker preset/effort) memakai chrome
   yang sama: `dialogBox` (border + judul) dan `hintLine` minimalis; jendela
   interaktif memakai `listRow` untuk baris daftar. Jendela interaktif command
   kini berjudul (Models/Providers/Sessions/…); output window memakai lebar
   lega `outputWindowWidth(cols)` (56–96 kolom) agar tabel/help terbaca.
3. **Scroll & tutup.** Output window mendukung `↑↓`, `PgUp/PgDn`, `Home/End`,
   tutup via `Esc`/`Enter`/`Ctrl+C`/`Ctrl+D`; idle 90 dtk auto-tutup. Bila layar
   tak mampu (non-TTY/terlalu kecil) atau setup gagal, fungsi mengembalikan
   `false` dan pemanggil WAJIB fallback mencetak output ke transkrip — output
   tidak pernah hilang.
4. **Dropdown `/` tetap inline** mengikuti prompt (perilaku v7.8/v7.15); ia
   BUKAN bagian dari perubahan jendela output command.

Perubahan v7.16 (remediasi konsistensi UI/UX):

1. **Grammar hint minimalis diseragamkan.** Semua permukaan (picker, manager
   model/penyedia, form, approval, ask_user, dialog hapus) memakai satu baris
   `kunci label  kunci label` — kunci accent, label redup, **pemisah hanya
   spasi** (tanpa `·`, titik dua, atau awalan/akhiran). Hint mengikuti state:
   picker/manager saat filter terisi menampilkan `Esc kosongkan/kembali`, dan
   form saat field aktif `select`/`confirm` menampilkan `←→` / `←→/y/n`.
   Panah, chevron, caret, dan marker seleksi memakai getter `glyphs` sehingga
   `MINICODE_ASCII=1` tetap menghasilkan teks ASCII.
2. **Footer form dinamis, bukan template ber-placeholder.** `form.footerDefault`
   dengan `{move}`/`{save}`/`{cancel}` dihapus; footer dibangun dari `hintLine`
   (atau `footerHints` untuk dialog hapus). Tidak ada lagi placeholder literal
   di form wizard/provider.
3. **Approval & ask_user:** idle guard 80+10 dtk mulai saat modal DIBUKA (bukan
   setelah keypress), peringatan dirender di footer; kursor diparkir di opsi
   aktif/baris input; opsi terpilih memakai marker `›` dengan kolom marker tetap
   dan `focusRow` menjaga opsi terpilih tetap terlihat; sinonim quick-key tanpa
   opsi (mis. `s` saat Always disembunyikan) diabaikan, bukan deny diam-diam.
   ask_user mendapat hint `Enter kirim  Esc batal`.
4. **Picker wizard menampilkan judul lewat opt-in `showTitle`.** Step
   `Minicode setup [1/3]` kembali terlihat. (v7.18 memperluas judul ke semua
   jendela command: Models/Providers/Sessions/effort/Add provider.)
5. **Palette level-aware:** token semantik memilih SGR 16-warna, 256-warna, atau
   truecolor sesuai `colorLevel()`; terminal 16-warna tidak lagi menerima
   `38;2;...`. Discuss di footer memakai accent (bukan warning) karena mode
   default bukan peringatan.
6. **Notice aksi manager memakai formatter kanonik** (`formatError`, redaksi
   credential) dan dirender sebagai error merah/sukses hijau/info redup; output
   `/sync`/`providers` menyertakan kata status, bukan warna saja.
7. **Registry `/help` lengkap:** command View (`compact`, `thinking`, `expand`,
   `minimize`, `fold`) terdaftar, sehingga `/help full` tidak lagi memuat
   heading grup kosong. Receipt toggle command = receipt hotkey (label state
   terlokalisasi lewat `state.*`).
8. **Seleksi tabel mode ASCII:** baris border fallback `+---+` dikenali sebagai
   border (bukan data), sehingga source mapping seleksi tabel tetap utuh dan
   baris border tidak ikut terseleksi.

Peta proteksi baru: `test/hint-grammar.test.ts` (grammar spasi-only, alignment
`listRow`; ASCII fallback glyph tetap dikunci `test/cli-help-language.test.ts`),
`test/theme-levels.test.ts` (SGR per level),
`test/form.test.ts` (footer tanpa placeholder + hint select), dan
`test/approval-tui.test.ts` (cursor parkir, quick-key guard, hint ask_user).

Perubahan v7.15 (remediasi audit): CSI/SS3 malformed dibuang sampai byte
independen berikutnya; Ctrl+C/Ctrl+D tetap dapat didekode. Prefix kontrol
tertahan dibatasi 64 byte. Sequence lengkap yang tidak didukung (termasuk
Ctrl+panah) menghasilkan `ignore`, bukan Escape; Escape tunggal tetap memakai
flush timer yang ada. Peta proteksi: `test/input-recovery.test.ts` dan
`test/prompt-engine.test.ts`. Cache proyeksi transkrip memakai ID baris stabil;
eviction hanya menghapus cache ID yang hilang, dengan geometri/output tetap.
Peta proteksi: `test/transcript-retention-cache.test.ts`.
Panel aktivitas tetap menghitung semua tool, tetapi error/deny/cancel/interrupted
juga tampil langsung sebagai ledger dengan nama tool dan alasan yang tersedia.
Hitungan denied/cancelled/interrupted dipisahkan dari failed dan tidak disembunyikan.
Peta proteksi: `test/activity-panel.test.ts`, `test/activity-fold.test.ts`.
Warning perbedaan kapasitas katalog/metadata menyatakan angka dan sumber yang dipakai;
metadata model eksak mengalahkan tebakan keluarga katalog, setelah override endpoint/operator.
Prinsip **satu baris per kejadian** (v7.15): satu turn menghasilkan satu baris
ringkasan thinking (angka baris diakumulasi lintas segmen, diperbarui di tempat —
bukan satu baris per segmen reasoning) dan satu baris ringkasan aktivitas tool;
panel aktivitas hidup tidak boleh meninggalkan salinan permanen 10 baris di
belakang setiap turn. Tinggi tata letak TUI tidak bergantung pada status
(indicators mengalah ke baris footer), sehingga transkrip tidak bergeser saat
thinking/tool berjalan. Alasan kegagalan ringkasan kompaksi dipendekkan ke
sebabnya (status + kode + pesan) tanpa payload JSON gateway.
Peta proteksi: `test/tui-render-regressions.test.ts`.


Perubahan v7.14: **geometri & dekorasi popup diseragamkan** (audit Surface
Popup, `AUD-001..AUD-011`). Empat perubahan tampak-pengguna:

1. **Lebar kotak popup diskalakan, bukan angka tetap.** `popupBoxWidth(cols) =
   min(max(40, min(88, floor(cols*0.6))), cols-4)` — dihitung saat *mount* lalu
   **dibekukan** (min=max) agar geometri stabil, tetapi menyesuaikan terminal
   tiap mount. I20 diperbarui. Margin 4 kolom **selalu menang** atas lantai
   40 (AUD-011).
2. **Sudut kotak MELENGKUNG (`╭ ╮ ╰ ╯`) default.** Kill-switch:
   `MINICODE_BOX=square` (`┌┐└┘`), `MINICODE_BOX=ascii`/`MINICODE_ASCII=1`
   (`+-|`). Dibaca lazy tiap render.
3. **Backdrop popup = scrim tiga tingkat** (`scrimMode()`):
   `bg` = dim **+ latar `48;5;236`** (≥256 warna), `faint` = `\x1b[2m` saja
   (16 warna), `none` = nol byte (mono/non-TTY/`TERM=dumb`). Reset SGR
   dalam konten **memulihkan** scrim; bold **dinetralkan** ke scrim.
4. **Kotak approval memakai lebar popup seragam**, bukan selebar layar
   (AUD-007). Opsinya **navigasi daftar**: `↑↓`/`Home`/`End` + `Enter`,
   `Esc` = deny. Ketik-cepat `y`/`a`/`n` (+ sinonim `ya`/`selalu`/`s`/`tidak`/
   `t`) tetap berfungsi — I25 menuntut navigasi daftar, bukan dua langkah wajib.

`MINICODE_SCRIM=none` memaksa `faint` untuk diagnostik. Level warna juga
memakai `process.stdout.getColorDepth()` sesudah env (`COLORTERM`/`TERM`) agar
Windows Terminal/ConPTY yang tak mengisi `TERM` tetap dapat 256 warna/truecolor
(AUD-002). Non-TTY **tidak berubah**: 0 warna, 0 scrim, 0 byte (I6).

Peta proteksi baru: `test/surface-audit-regressions.test.ts` (AUD-007/008/010/011),
`test/dialog.test.ts` (glyph melengkung + kill-switch + geometri skala),
`test/tui-geometry.test.ts` (lebar beku per mount, bukan 64 tetap),
`test/ui-audit-regressions.test.ts` (AUD-003: bold dinetralkan, `[22m`
memulihkan scrim — diuji dengan TTY palsu agar `scrimMode() != none`).

Perubahan v7.13: baris status kompaksi (`context:compacted`) kini **membedakan
hasil** alih-alih mencetak `reason` mentah. Sebelumnya sesi yang konteksnya TIDAK
menyusut tampil sebagai `… dipadatkan: pressure:critical:no-op` — terbaca seolah
berhasil, padahal turn berikutnya tetap kehabisan konteks. Empat kondisi sekarang
punya label berbeda karena tindak lanjut user berbeda: `… dipadatkan: tidak ada
yang bisa dibuang (<sebab>) — konteks tidak menyusut` (no-op), `… kompaksi
berhenti: target tak tercapai meski hanya N pesan tersisa` (fixpoint), `…
kompaksi mustahil: instruksi tetap + skema tool (N) sudah melebihi ambang M`
(biaya tetap), dan `… ringkasan LLM gagal (<sebab>), memakai ringkasan
mekanikal`. Label tetap satu baris redup (`c.muted`) dan tetap melewati
`sanitizeAnsiLine` sebelum tampil — teks sebab berasal dari error provider/model
(input tak terpercaya). Sumber: `src/ui/tui/transcript.ts` (`compactedLabel`),
kunci i18n `ts.compactedNoOp`/`ts.compactedFixpoint`/`ts.compactedImpossible`/
`ts.compactedLlmFailed`, dan emisi `reason` dari `vendor/minicore/src/core/
loop.ts`. Peta proteksi: `test/tui-classic.test.ts` (kontrak render transkrip)
+ `test/compaction-limits.test.ts` (alasan `impossible:`/`fixpoint` yang
mendarat di event) + `test/control-plane.test.ts` (`llm-failed:` dilaporkan).
Nol perubahan pada lebar/geometri: label hanya teks lebih panjang pada jalur
yang sama, tetap dipotong sesuai aturan baris status yang ada.

Perubahan v7.12: footer `context` & `metrics` (window %) kini **live per step**
selama turn berjalan — kernel meng-emit estimasi konteks turn-store via event
`provider:extension` kind `context-window` SETELAH `step:completed`, dan footer
membacanya alih-alih terpaku pada `session.contextTokens` (committed store yang
hanya berubah saat `turn:completed`). Saat idle, footer kembali ke nilai
committed. Estimator sama sekali tidak berubah/berduplikasi — tetap satu sumber
(`estimateSessionContext`), hanya nilai yang dibaca saat turn aktif memakai
turn-store (yang tumbuh), bukan committed store (beku). Sumber: `vendor/minicore/
src/core/loop.ts` (emit) + `cli/tui.ts` (wiring footer).

Perubahan v7.11: thinking & jawaban di TUI dan renderer linear kini membungkus di
batas kata (`wrapByWidth`) — tidak memotong di tengah kata — dan baris diff ikut
wrap (bukan truncate ellipsis). Tabel markdown tetap kotak ber-garis + wrap
(v7.10). Thinking di renderer linear ikut di-indent 2 kolom, konsisten dengan TUI.

Perubahan v7.10: pembatas bash allow-list (fallback "no-sandbox") ditampilkan
sebagai **titik monokrom** `●` di ujung footer (setelah Permission Mode), kuning
saat aktif (mode Auto + restrictBash) dan abu saat nonaktif. Saat mode
`unrestricted` aktif, titik jadi `○` MERAH (terbuka) sebagai penanda satu-satunya.
Fallback ASCII `[LOCK]`/`[OPEN]` untuk terminal tanpa UTF-8. Sumbu persetujuan
tetap Auto/Ask; nilai Permission Mode untuk `--allow-all` sengaja ditampilkan
sebagai `Auto` (auto ≈ allow-all: otonom penuh tanpa izin) — catatan desain,
bukan bug. Angka konteks footer memakai `session.contextTokens` — estimasi
terkalibrasi yang memakai estimator yang SAMA dengan guard cutoff, sehingga
footer dan guard tidak pernah menghasilkan dua angka sumber berbeda.

Perubahan v7.9: input command slash tidak ditambahkan sebagai pesan transkrip;
aksi popup provider/model/sesi dan toggle UI tidak meninggalkan riwayat status
di transkrip. Output command yang informatif, error, dan hasil prompt model tetap
tampil. Jawaban model membuang blank line di tepi dan merapatkan jeda berulang
di luar code fence; isi code fence tetap literal.

Perubahan v7.8: sesi baru dan sesi legacy tanpa WorkMode mulai di `Discuss`;
operator hanya dapat memilih `Discuss` atau `Build` (`Plan` legacy → `Discuss`). Permission Mode
awal `Auto` dan kontrolnya hanya `Auto`/`Ask`. Dropdown `/` menampilkan nama
command tanpa slash, judul, deskripsi, atau baris tambahan. (Sejak v7.18
jendela command memakai judul konteks; dropdown `/` tetap tanpa judul.) Baris
provider/model dibuat ringkas.

Perubahan v7.7 (diperbarui v0.24): footer menampilkan nilai Work Mode di sisi
kiri dan nilai Permission Mode di sisi kanan dekat pemakaian konteks. Label
`Work Mode:`/`Permission Mode:` dihapus agar footer satu baris lebih lega —
pembeda sumbu tinggal warna (Work Mode semantik, Permission Mode cyan). Nilai
kedua mode memakai title case; pada terminal sempit nilai dipadatkan sebelum
mode atau konteks dihilangkan.

Perubahan v7.6: sinkronisasi kontrak WorkMode ke mode produk 0.14.1 — label
`BUILD` untuk identitas runtime `EXECUTE`, footer dua sumbu yang selalu tampil,
dan pintasan `Tab`/`Shift+Tab` untuk WorkMode/PermissionMode.

Perubahan v7.5: kepemilikan frame stdout interaktif diperjelas; cleanup `TuiApp.run()`
berpasangan melalui `finally`; gap proteksi teardown, startup, spacer, layar kecil,
dan writer ownership ditutup dengan test app/subprocess/PTY.

Perubahan v7.4 (P12 S2.2 WorkMode): invarian I35 — WorkMode runtime
`DISCUSS`/`PLAN`/`EXECUTE` terpisah dari PermissionMode. Nama produk `BUILD`
adalah alias input dan label tampilan untuk identitas runtime `EXECUTE`; nilai
persisten tetap `EXECUTE`. Command `/work-mode <DISCUSS|PLAN|BUILD>` juga
menerima `EXECUTE` sebagai alias kompatibilitas. Footer menampilkan pasangan
`<WorkMode>·<PermissionMode>`; defaultnya `BUILD · AUTO`. `Tab` memutar WorkMode,
sedangkan `Shift+Tab` dan `/mode` mengubah PermissionMode. Rincian di I35.

Perubahan v7.3 (P11 Presentation & UX): invarian baru I34 — subcommand `exec`
dan `daemon` menerima argv SCOPE dari router (flag global dikenal yang
mendahului token subcommand tetap berlaku; token subcommand tidak ikut ke
handler). Kalimat lama I28 "Flag `exec` diparse dari argv SESUDAH token
subcommand" sudah tidak lengkap sejak P11.2 menerima bentuk flag-mendahului,
diganti rujukan ke I34. Registrasi peta proteksi: `test/cli-subcommands.test.ts`
sudah ada SEBELUM P11.3 — yang ditambahkan hanya describe `cli: daemon scoped
argv (P11.3)` di dalamnya, BUKAN file baru; `test/exec-json-envelope.test.ts`
+ `test/cli-session.test.ts` melindungi kontrak exec scoping (P11.2) dan
verification summary (P11.1). Nol perubahan perilaku runtime — dokumen mengejar
kontrak yang sudah diterima + diuji.

Perubahan v7.2 (2026-09-25): mouse tracking `?1002h + ?1006h`, drag selection
app-level, `Ctrl+C` copy selection, wheel tetap scroll, popup turun ke `?1000h`,
dan `MINICODE_MOUSE_SELECTION=0` sebagai kill switch.

Perubahan v7.1 (2026-09-25): mouse wheel X10/SGR untuk scroll transkrip; klik
mouse tetap diabaikan; mouse tracking dibatasi pada lifecycle TUI; `/copy [n]`
menyalin 1–10 turn terakhir; abort turn TUI memakai Esc.

Perubahan v7 (temuan audit `audit-tui`): penanganan sinyal fatal
SIGTERM/SIGHUP (I31), navigasi transkrip Home/End + Shift+PgUp/PgDn (I14),
hint abort sekali saat busy (I14), idle guard form dua-tahap (I21), spark
statis via `MINICODE_MOTION=0` (I13), parkir kursor di dalam blok
sync-update (I25).

Satu-satunya tampilan interaktif adalah **TUI fullscreen**: transkrip ala
shell + status bar + popup komposit. REPL linier, footer lengket (chrome),
overlay inline, dan jendela info **DIHAPUS** — tak ada mode, tak ada flag
(`--tui` usang = no-op). Popup = satu kotak: daftar DAN input teks/pilihan
terjadi di dalamnya (form); tak ada ketikan di luar kotak. Bahasa UI
dwibahasa (en/id) via i18n nol-dependensi. Perubahan perilaku apa pun di
bawah wajib: update dokumen ini + test yang menjaganya (lihat "Peta
proteksi").

## Sifat produk

- **Interaktif (TTY mampu)**: aplikasi fullscreen alternate-screen dari start
  sampai quit. Area transkrip FLAT & MONOKROM: prompt `minicode ›`, jawaban
  model, dan satu baris tool ringkas `› nama target`; tanpa panel, kotak, garis,
  atau warna. Status bar satu baris di bawah. Popup masih melukis regionnya
  sendiri di atas transkrip. Keluar = buffer utama kembali persis; kop sesi
  tidak dicetak (transkrip sesi tidak di-dump ke scrollback).
- **Non-interaktif** (one-shot prompt, `exec`, pipe/redirect/CI): cetak polos,
  tak pernah membuka TUI.
- Tanpa panel/sidebar; mouse app-level untuk wheel scroll dan drag-selection
  transkrip (bukan native terminal selection); tanpa animasi dekoratif
  (pulse spark status bar dapat dimatikan `MINICODE_MOTION=0` — I13).

## Contract stdout/stderr

| Stream | Isi | Catatan |
|---|---|---|
| stdout | Permanent output pada non-interaktif; frame TUI saat sesi interaktif | `App` satu-satunya pemilik frame interaktif; machine output tetap murni |
| stderr | Human-facing progress/diagnostic: satu baris tool `› …`, warning, error Reasoning tidak dirender di transkrip flat | Boleh transient rendering bila stderr TTY |
| keduanya | **TANPA warna sama sekali** (v7.22): `colorLevel() === 0` dipaksa; `NO_COLOR`/`COLORTERM`/`stdout.isTTY` tak mengubah byte output. Urutan cursor/alt-screen tetap TTY-only | Lihat `src/ui/render/theme.ts` `FORCE_MONO` |

Non-TTY (pipe/redirect/CI/file): **0 cursor control, 0 alternate screen,
0 animasi spinner, 0 ANSI yang tidak diperlukan, output deterministic.**

## Klasifikasi writer (wajib dipatuhi)

1. **permanent user-visible output** — teks model, receipt, hasil perintah → stdout (idle non-interaktif).
2. **frame TUI** — SATU-SATUNYA penulis layar saat interaktif adalah `App`
   (`src/ui/tui/app.ts`): transkrip viewport + prompt + status bar + komposit
   popup, satu repaint sinkron per event. Modul lain DILARANG menulis
   `process.stdout` langsung saat App aktif (popup melukis regionnya via
   `paintRegion`, bukan frame penuh).
3. **diagnostic/logging** — `[warn]`, `[router]`, `[mcp]`, `[vector]`, dst. dari layer non-UI → boleh `process.stderr.write` mentah.
4. **machine-readable output** — mis. `--json`, protokol MCP server → stdout saja, tanpa apa pun yang lain.
5. **debug-only output** — guard `verbose`/env; tidak pernah default.

## Ownership

- `App` pemilik tunggal layar (alt-screen enter saat start, exit saat quit).
  `TuiApp.run()` melepas listener/timer/subscription, memulihkan raw mode, dan
  menutup layar lewat `finally` idempoten pada jalur sukses maupun exception.
  Hook `process.on("exit")` hanya jaring best-effort terakhir, bukan pengganti
  cleanup lifecycle. Turn berjalan = indikator spark pada status bar.
- **Sinyal fatal** (I31): saat sesi TUI hidup, `App.run()` memasang
  `process.on("SIGTERM")`/`process.on("SIGHUP")` (handler terpisah karena Bun
  tak menyampaikan nama sinyal — satu handler bersama tak bisa membedakan)
  → restore terminal (alt-screen exit + raw mode pulih) tepat satu kali walau
  handler sinyal terpanggil ulang, lalu
  `process.exit(128+n)`. Pasangan ketat: keduanya dilepas di cleanup `run()` —
  tanpa sesi TUI, sinyal TIDAK di-intercept (perilaku default proses tetap).
  Tanpa ini SIGTERM meninggalkan terminal di alt-screen + raw mode (user harus
  `reset`).
- App me-repaint live mengikuti event bus (stream teks, ledger, thinking;
  coalesce 30ms) — TANPA ini layar buta selama turn. `?1002h + ?1006h`
  mengaktifkan tracking drag; `?1000h + ?1006h` saat popup; `?1000l/?1002l/?1006l`
  pada quit/child/sinyal. Suspend menahan repaint (popup melukis sendiri);
  quit menahan semua.
- Popup komposit (`/model`, `/provider`, `/sessions`, output command, form,
  approval): controller/view memanggil `app.suspend()` (lepas listener stdin + redupkan
  layar), view melukis HANYA region kotak via `paintRegion` (tanpa clear —
  transkrip di belakang tetap tampil), `app.resume()` repaint penuh saat tutup.
  Tanpa suspend: byte masuk ke dua tempat (App + popup) dan frame App menimpa
  popup — dilarang.
- Saat turn berjalan composer TETAP HIDUP: tombol penyusun teks (karakter,
  Backspace/Delete, panah, Home/End, Ctrl+U/Ctrl+W, Ctrl+J) dilayani, dan
  draft-nya terlihat di slot yang sama (menggantikan baris status aktivitas
  selama draft tak kosong; status tetap terbaca dari `pinnedActivity` + timer
  footer).  Enter saat busy menyelipkan baris itu sebagai **informasi tambahan**
  (`TuiHost.enqueue` → `Session.steer`): kernel menambahkannya sebagai pesan
  `user` pada batas step berikutnya — sebelum request provider selanjutnya —
  sehingga model membacanya di turn yang SAMA (semantik "steer" opencode),
  bukan menunggu turn selesai. Turn yang sudah selesai lebih dulu (balapan)
  membuat kernel menolak steering; baris lalu jatuh ke antrean turn berikutnya
  agar tidak hilang. Baris `/slash` ditolak dengan alasan
  eksplisit (perintah UI butuh idle). Abort (Esc) membatalkan turn DAN
  membuang antrean dengan pemberitahuan jumlahnya — niat user yang dibatalkan
  tak boleh dieksekusi otomatis sesudahnya. Steering yang sudah diterima kernel
  tetapi belum terkirim hilang bersama turn itu (transaksional, tidak bocor ke
  turn berikutnya). Saat busy TANPA draft, slot tetap
  berisi baris status aktivitas (dots + timer), jadi tinggi frame tidak
  berubah. Tab/Shift+Tab/Ctrl+O/Ctrl+T/Ctrl+R tetap ditahan selama busy
  (memutasi mode/membuka overlay di tengah turn = balapan state).
  Abort pertama menampilkan hint "tekan Esc lagi untuk keluar" di slot
  indikator SEKALI (anti keluar sesi tak sengaja saat double-tap "memastikan"
  — I14); abort kedua dalam 1,5 dtk = quit.
- **Checkpoint = milik lifecycle sesi.** Bus kernel memanggil handler `turn:completed`
  secara sinkron dan tak menunggu promise-nya, jadi operasi tulis checkpoint
  (async) harus DIMILIKI: operasi yang dimulai dicatat, kegagalannya
  ditangani saat lahir (bukan unhandled rejection, bukan sukses palsu) dan
  dilaporkan lewat diagnostic `[warn] checkpoint failed: …` ke stderr.
  `close()` = BARRIER: setelah ia kembali, tak ada pekerjaan checkpoint milik
  sesi itu yang masih berjalan (manifest sudah tertulis atau kegagalannya
  sudah tercatat).

## Popup, dialog, form & i18n

- `screen.ts` = pemilik `?1049h/?1049l` + `paintRegion` (cursor-addressed,
  tanpa clear) + `clearRegion`. Refcount nested, idempoten, null-screen
  fail-closed di non-TTY/`TERM=dumb`. Siklus hidup region: render yang
  menyusut/bergeser membersihkan union lama+baru (tanpa baris hantu); tutup
  menghapus region sendiri sebelum pemilik repaint.
- `screen.ts` juga pemilik bentuk kursor: DECSCUSR `6 q` (bar tegak stabil)
  dipancarkan saat caret ditampilkan (`paint`/`moveCursor`) — caret tak
  menutupi karakter di bawahnya dan lebih tenang (clean & minimal). Tetap
  TTY-only: non-TTY = 0 cursor control.
- Isi popup: kotak terpusat (`dialog.ts`: border, judul opsional dalam garis
  atas, TANPA bayangan) di atas konten redup; `dialogBox` untuk komposit,
  `dialogFrame` (backdrop `░` faint) hanya untuk layar yang memiliki buffer
  sendiri.
- **Lebar kotak popup adaptif** di semua permukaan (`popupBoxWidth(cols)`
  untuk popup/form/approval/picker, `outputWindowWidth(cols)` untuk jendela
  output command): dievaluasi dari lebar terminal saat render/resize agar
  selalu center dan tak overflow, sambil menjaga lebar tetap antar frame
  selama lebar terminal sama (tidak "bernapas" saat filter/error muncul).
  Nama/ID di DEPAN label (truncasi memakan ekor — tanggal/konteks boleh
  hilang, id selamat).
- Form dalam popup (`form.ts`): field text/secret(mask `•`)/select/confirm,
  Tab/↑↓ pindah, ←/→ pilih atau geser kursor, Enter validasi+submit, Esc
  dua-tahap (tekan-1 KEMBALIKAN nilai bawaan field aktif — text/secret/select/
  confirm, tekan-2 batal — isi tidak pernah hilang sekali tekan); error
  validasi merah dalam box; kursor terminal diparkir di field aktif dan field
  aktif SELALU terlihat (jendela body digeser via `focusRow` bila kotak
  terpotong). Add/edit provider, delete confirm, dan wizard input WAJIB lewat
  ini (bukan askLine liar di luar kotak).
- Picker ber-filter: Esc-1 mengosongkan filter (= kembali ke nilai bawaan
  pencarian, analogen revert-to-default I21), Esc-2 menutup. Ctrl+U juga
  mengosongkan filter. Tidak ada draft yang hilang tanpa undo.
- Dropdown `/` tetap inline menempel prompt (harus mengikuti kursor ketik):
  berbingkai, terhapus di SEMUA jalur keluar.
- **Kursor konsisten di permukaan ketik vs baca** (`form`/`model-manager`/
  `picker` ber-filter/`approval`/App memarkir kursor via `screen.moveCursor`;
  `output-window`, `provider-manager` list-only, `picker` non-filter, dan
  status progres/error wizard menyembunyikan kursor via `screen.setCursorVisible(false)`
  agar tampilan tetap minimalis dan bersih). Kursor idle App berada tepat
  setelah prompt `minicode ›` (I13).
- **i18n dwibahasa** (`src/ui/i18n/`): kamus statis `en.ts`/`id.ts` (id WAJIB
  kunci = en — tsc mengawal), `t(key, params)` interpolasi `{nama}`, fallback
  kunci hilang → en. Prioritas: `/lang` (sesi) > `MINICODE_LANG` >
  state.json `lang` > locale OS (`LANG`/`LC_ALL` awalan `id`) > en. Semua
  string user-visible TUI lewat `t()` — literal Indonesia hardcode di luar
  dict dilarang (test anti-regresi). Getter runtime, bukan const beku.
  Bahasa balasan model (progres, pertanyaan, jawaban akhir) mengikuti bahasa
  pesan pengguna atau permintaan bahasa eksplisit, termasuk saat berganti bahasa;
  pesan pendek mengikuti bahasa percakapan yang sudah terbentuk. Locale UI/OS
  dan `/lang` hanya mengatur label UI, bukan bahasa balasan. Kutipan, kode, log,
  serta hasil tool bukan penentu bahasa pengguna. Peta proteksi prompt:
  `test/context-audit.test.ts`; kepatuhan model perlu diuji dengan provider nyata.
- **Keybinding konsisten** (kontrak I25): `Esc` dua-tahap di semua input
  teks; `backspace`/`delete` selalu edit teks (aksi hapus-data via `d`/
  `Del` + confirm dalam popup, tercatat); navigasi daftar = `↑↓` + `pgup/
  pgdn` + `home/end` di semua popup ber-daftar; hint footer tiap permukaan
  hanya tombol yang benar-benar berlaku di sana.
- **Hint aksi minimalis** (audit UI/UX 2026-11; diseragamkan v7.16): satu baris
  di dasar body picker/manager/form/approval (`src/ui/render/hint.ts`, satu
  sumber), format `kunci label  kunci label` — kunci accent, label redup,
  **pemisah hanya spasi** (tanpa `·`/titik dua) — tanpa footer dekoratif.
  Judul jendela command mengikuti konteks (Models/Providers/Sessions/Help/…),
  bukan bagian hint. Hint mengikuti state (filter terisi vs kosong;
  select/confirm menampilkan panah/y-n). `/model`: **Enter = pilih model satu
  langkah** (tanpa picker effort); **Tab = ubah thinking effort** terpisah
  (Esc pada picker effort = batal effort, kembali ke daftar — manajer tak
  pernah menutup diri di sana).
- **Jendela output command** (`src/ui/screens/output-window.ts`, v7.18):
  overlay read-only di ATAS transkrip untuk readout command (`/help`, `/status`,
  `/context`, `/history`, `/expand`, `/sync`, `/init`, `/scheduler`, `/undo list`,
  alias `/cost`/`/usage`). Kotak berjudul + body ber-scroll (`↑↓`, `PgUp/PgDn`,
  `Home/End`) + hint `↑↓ gulir  Esc batal`; tutup `Esc`/`Enter`/`Ctrl+C`/
  `Ctrl+D`; idle 90 dtk. Chat/transkrip tidak tersentuh. Non-TTY/terlalu
  kecil/setup gagal → fallback transkrip (output tak hilang). Receipt aksi
  pendek (`/undo`, `/redo`, `/copy`, toggle) tetap di transkrip.
- Approval tool & ask_user: blok pertanyaan + keputusan DICATAT di transkrip
  (jejak audit) dan layar di-repaint sebelum menjawab; input via askLine di
  baris kursor (aman: input App beku saat busy; Esc/Ctrl+C = abort + deny).
- Layar tak mampu (non-TTY, `rows < 10`, `TERM=dumb`): view menolak BERSUARA
  + batal (fail-closed). TAK BOLEH diam.
- `/status`, `/sessions history`, `/help`, `/context`, `/view expand` = jendela output
  command read-only di atas chat (v7.18), bukan dump transkrip; `/help` ringkas
  (terkelompok ≤8 baris, penuh via `/help full`, pintasan via `/help keys`);
  pilihan `/model` persist antar sesi + struk `model: x` di transkrip.

## Invariant (nomor dipakai di peta proteksi)

1. Satu tampilan interaktif: TUI fullscreen; frame penuh tiap repaint (tepat
   `rows` baris); scrollback utama tak tersentuh selama sesi. Frame LOGIS tetap
   penuh `rows` baris (hasil layar identik), namun PENULISAN FISIK ke terminal
   boleh inkremental per SEL dan dikirim sebagai SATU `write` per frame
   (`screen.paint` memakai diff sel terhadap frame sebelumnya; repaint
   pertama/resize/perubahan jumlah kolom tetap `ESC[H`+`ESC[2J` clear penuh)
   — ini murni optimasi menghapus flicker/latensi `ESC[2J` tiap keystroke,
   bukan perubahan perilaku yang terlihat. Diff per sel menyimpan gaya sebagai
   STATE SGR ternormalisasi (urutan kanonik, bukan riwayat sekuens), sehingga
   sel yang identik secara visual tidak pernah ditulis ulang; glyph lebar
   (CJK/emoji) dilindungi sel lanjutan (`cont`) agar diff tidak memotong glyph.
   Penulisan per baris berubah: dari kolom berbeda PERTAMA sampai akhir baris
   (prefix identik dilewati), didahului EL (`ESC[0K`) — ekor dihapus-lalu-ditulis
   ulang supaya sisa glyph lebar / ekor baris lama tidak menempel. Tulis asing ke
   stderr selama alt-screen hidup (mis. `[hooks] skipped …`, warning provider)
   menandai terminal "kotor" (`statusline.consumeScreenDrift`) dan memaksa
   repaint penuh pada paint berikutnya; tanpa ini baris yang kebetulan tak
   berubah akan mempertahankan fragmen asing di atas diff inkremental.
2. stdout/stderr contract seperti tabel di atas (TTY & non-TTY deterministic).
3. Satu kepemilikan layar (`App`); popup satu lifecycle (`suspend`/`resume` +
   `paintRegion`).
4. Permanent output tidak bergantung pada painter TUI.
5. Tidak ada popup yatim / input bocor setelah success / failure /
   cancellation / SIGINT / session end. Tidak ada modal yatim.
6. Non-TTY: 0 cursor control / alternate screen / spinner animation / ANSI
   tak diperlukan.
7. Tool activity default compact; ledger `› nama target` satu baris.
8. Streaming tanpa duplicate output / overlap / stale status.
9. Foreign stderr writers boleh mentah di layer non-UI.
10. (Dilebur ke I3 — nomor dipertahankan agar referensi lama tak patah.)
11. Resize memakai lebar/tinggi SAAT PAINT (bukan saat event) — termasuk
    geometri popup, dialog, dan viewport TUI.
12. Long session tetap readable (cap 5000 baris, tertua dibuang). Proyeksi
    presentasi mempertahankan cap yang sama dan menambahkan satu marker
    `… N baris awal di luar viewport` yang melacak
    jumlah baris yang di-evict; `total()` tetap monotonik. Buffer jawaban
    live dibatasi 1.000.000 karakter dan menampilkan marker truncasi; satu
    layout paint tidak boleh memproyeksikan transcript dua kali.

13. Status bar: 1 baris dasar (`✦ 00.00.00 Discuss  model  cwd … context  Auto`)
     dari sumber yang sama dengan angka sesi.
     Nilai `context` (dan `metrics` window %) saat turn AKTIF memakai occupancy
     LIVE turn-store yang di-emit kernel per step (event `provider:extension`
     kind `context-window`, setelah `step:completed`); saat idle kembali ke
     `session.contextTokens` (committed store). Estimator tetap satu sumber —
     hanya store yang dibaca berganti antara turn-store (tumbuh) vs committed
     (beku), tak ada duplikasi angka sumber (v7.12).
     Titik `●` mengikuti Permission Mode di ujung kanan: kuning bila bash
     allow-list aktif (restrictBash + mode `Auto`), abu bila tidak; `○` merah
     = mode `unrestricted` (fallback ASCII `[LOCK]`/`[OPEN]`). Work Mode berada
     di kiri; Permission Mode cyan berada di kanan dekat konteks (label produk
     `Work Mode:`/`Permission Mode:` dihapus pada v0.24 — nilai saja). Bila ada
     job background hidup, badge `◷ N` (jam berputar pelan, `N` = jumlah job)
     tampil di samping spark; fallback ASCII `[BG:N]`. `✦` tetap
     menjadi indikator proses hidup;
     timer `HH.MM.SS` berada tepat di sebelahnya. Sejak v7.22 semua field
     MONOKROM: tak ada level warna idle/aktif/60 dtk/1 jam; yang berubah hanya
     glyph spark dan format timer. Reasoning memakai dots `...` → `..` → `.`
     → `..` → `...`, sedangkan teks `Working`/`Thinking`/`Running` tidak tampil.
     Bullet separator dihapus; field dipisahkan oleh spasi. Prompt `minicode ›`
     tampil saat boot/idle, hilang saat busy, dan kembali otomatis setelah turn
     selesai; aksi edit/histori tetap dapat membuka composer.
     `MINICODE_MOTION=0` membuat dots dan sparkle statis tetapi tidak
     menghilangkan feedback; satu baris kosong memisahkan composer dari footer.
14. Binding TUI: mouse wheel (X10/SGR) scroll transkrip; drag kiri app-level
     membuat selection transkrip yang kontinu melintasi jeda paragraf, baris
     tabel flat, isi fence kode, serta tepi viewport dan `Ctrl+C` menyalinnya; klik
     pada baris composer manapun memindahkan kursor langsung ke posisi klik;
     PgUp/PgDn scroll; **Shift+PgUp/PgDn (ESC[5;2~/6;2, modifier 2) = setengah
     halaman; Home/End saat prompt KOSONG = lompat baris-teratas/ekor
     transkrip (baris berisi = editing awal/akhir baris; dropdown terbuka =
     jalur engine)**; Up/Down bernavigasi antar-baris visual pada prompt
     terbungkus/multi-baris (menjaga kolom) lalu ke histori saat di baris
     visual pertama/terakhir; Tab WorkMode / Shift+Tab PermissionMode
     (v7.23: `Ctrl+O`/`Ctrl+T` serta `/view compact|fold|minimize` sudah DIHAPUS
     karena tak punya target visual di renderer flat); Ctrl+D baris-kosong
     keluar; Esc membersihkan selection lebih dulu, lalu batal input / abort
     turn (busy: ketikan hidup & Enter menyelipkan informasi tambahan ke turn
     aktif, dengan antrean sebagai fallback; Tab/Shift+Tab ditahan,
     Esc = abort yang juga membuang antrean;
     berlaku juga saat layar MENCIUT: abort+scroll selalu lolos
     agar turn bisa dibatalkan tanpa kill -9; abort pertama menampilkan hint
     `app.abortHint` ("abort sent — press Esc again to quit") sekali, abort kedua
     dalam 1,5 detik menutup sesi — token lama `Stopping` tidak lagi dipakai).
     Saat idle dan composer kosong, dua Esc dalam 500 ms membuka picker `/undo`;
     Esc yang membersihkan teks, selection, atau dropdown tidak ikut gesture ini.
     Ini adalah selection buffer TUI, bukan native terminal selection. Idle
     menampilkan timer redup di footer dan prompt `minicode ›`; prompt hilang
     saat busy, lalu otomatis muncul kembali kosong setelah turn selesai.
     Scroll ke atas + stream masuk = indikator `↓ N baris baru`.
15. (Dihapus bersama jendela info — nomor dipertahankan.)
16. Popup komposit: region tanpa clear + union-clear anti-hantu + clearRegion
    saat tutup + suspend/resume berpasangan; layar tak mampu = tolak bersuara
    + batal.
17. Transkrip append-only di memori (cap 5000), viewport anchor ATAS (v7.28)
     dengan sticky follow ke ekor; ketikan baru kembali ke ekor (`scrollBack`
     = maks); stream turn TIDAK merampas posisi baca;
     repaint live coalesce 30ms dan clock activity 200ms (layar tak buta
     saat turn). Composer memakai tinggi tetap: prompt saat editing, dots saat
     reasoning, atau tool target; satu baris kosong selalu memisahkannya dari
     footer. Proyeksi presentasi (v7.22): tool tampil sebagai SATU baris ringkas
     `› nama target`; status hanya untuk NON-sukses (`failed`/`denied`/
     `cancelled`/`interrupted`, dipisah `·`) dan TANPA warna. Activity panel/
     fold, area thinking, baris running, dan ringkasan turn (counter/`ckpt`)
     TIDAK dirender; event diagnostik non-tool tetap dikonsumsi tanpa baris.
     **Retry provider:** setiap `model.delta`/`reasoning.delta` live membawa
     `attemptId`. Bila attempt gagal setelah mengirim konten, TUI membuang
     ekor attempt yang belum di-commit dan menambah diagnostic invalidasi.
     Sink linear/pipe bersifat append-only: byte yang sudah ditulis tetap ada,
     sehingga sink wajib menulis marker invalidasi sebelum output attempt
     berikutnya. Konten attempt gagal dikeluarkan dari `/copy`, reasoning
     durable, dan jawaban akhir; usage provider tetap dihitung karena request
     tersebut sudah terjadi.
     **Grup anak (F-AGENT-1):** tool anak yang punya identitas run
     (`childSessionId`/`runId` — dari `ChildSessionLink`) tampil sebagai baris
     run sendiri, diindented `↳ <marker> <tool> <target> <status>` dengan
     marker `run_<8>`/`sub_<8>`; anak paralel tak lagi(dir) satukan jadi satu
     hitungan. Tool anak yang HANYA punya `parentToolCallId` (grouping legacy,
     tanpa identitas run) tetap ditelan sebagai hitungan induk `n child tools`
     — `parentToolCallId` = taut ke pemanggil, bukan identitas run, jadi dua
     makna itu tak boleh disamakan. Baris running anak memakai aturan yang
     sama (marker per run).

18. Prompt multiline (Ctrl+J newline), histori memori-sesi (tak persist ke
    berkas histori lama). Draft hasil undo mempertahankan newline dan Unicode,
    tidak otomatis dikirim atau membuka dropdown; escape terminal dibuang.
    Handoff draft/notice dikonsumsi sekali agar tidak diwariskan saat pindah sesi.
    `/copy [n]` menyalin 1–10 turn terakhir (default 1,
    oldest-to-newest) melalui OSC 52.
19. Dropdown `/` inline TANPA bingkai (renderer flat); `listRow` memakai marker
     kolom tetap, Enter pada menu melengkapi + kirim, Tab melengkapi tanpa kirim.
20. Lebar kotak popup **diskalakan dari lebar layar secara dinamis saat resize**:
    `popupBoxWidth(cols) = min(max(40, min(88, floor(cols*0.6))), cols-4)`
    (v7.14; adaptif `resize` di seluruh permukaan sejak v7.19). Semua
    permukaan popup (picker, model, provider, form, wizard, **approval**) memakai
    fungsi yang SAMA — tak ada permukaan yang memakai lebar layar penuh seperti
    approval sebelum v7.14 (AUD-007). Nilai dikirim sebagai `minWidth == maxWidth`
    dari lebar `cols` aktif sehingga kotak tak "bernapas" selama ukuran layar
    konstan, tetapi ikut menyesuaikan bila terminal diperbesar/diperkecil.
    Margin 4 kolom SELALU menang atas lantai 40 (AUD-011). Sudut kotak MELENGKUNG
    `╭ ╮ ╰ ╯` secara default; `MINICODE_BOX=square` mengembalikan lancip,
    `MINICODE_BOX=ascii`/`MINICODE_ASCII=1` ke ASCII.
    Nama/ID di depan label; seleksi murni warna; search selalu tampil.
21. Form dalam popup: semua input teks/pilihan di dalam kotak (text/secret/
     select/confirm + validasi inline + kursor diparkir); tak ada ketikan di
     luar kotak. Esc dua-tahap: tekan-1 KEMBALIKAN nilai bawaan field
     (prefill/edit tak hilang sekali tekan), tekan-2 batal. Idle guard
     dua-tahap (temuan audit TUI-004): 80 dtk tanpa input = peringatan statis
     di footer form ("batal dalam 10 dtk" — bukan countdown hidup), 10 dtk
     berikutnya = auto-batal (cancel), total semantik 90 dtk lama; SATU
     ketikan apa pun me-reset kedua timer.
22. Thinking tersembunyi SECARA DEFAULT (hidden/minimized) agar transkrip
     tetap bersih: composer tetap memakai dots clock saat thinking dan detail
     penuh disimpan ke buffer `/view expand`. User dapat membukanya kapan saja lewat
     `/view thinking`, `Ctrl+T`, `--verbose`, atau `MINICODE_SHOW_THINKING=1`: saat
     dibuka dengan panel aktivitas ON (default TUI; `/view fold`), transkrip
     menampilkan AREA thinking = blok live maks 10 baris visual terakhir
     (header `+ thinking`, penanda `… N baris lagi`), lalu saat fase berakhir
     diringkas SATU baris (`+ thinking · N baris`); dengan panel OFF,
     perilaku legacy = alir thinking ber-warna terbaca (`c.thinking`,
     abu-kebiruan) dan ber-indentasi 2 kolom, dipisah SATU baris kosong dari
     jawaban/ledger — bukan `dim`; saat tetap tersembunyi di TUI, transkrip
     bersih tanpa marker (`… thinking`); fase berakhir = commit (tak ada
     thinking yatim).
23. Approval & ask_user tercatat di transkrip (pertanyaan + keputusan) dan
     terlihat sebelum menjawab; non-TTY = deny/null fail-closed; stdout
     di-pipe tanpa sink TUI = deny/null (prompt tak terlihat + mencemari
     output program bila dipaksa).
24. `/view expand` query Content Store (buka-ulang identik, tidak sekali-habis);
     dengan id membaca satu tool, tanpa id membaca seluruh entry store yang
     masih hidup; miss → durable sqlite → penanda retensi. Pilihan `/model`
     persist antar sesi + struk `model: x`; `/help` ringkas (penuh via
     `/help full`, pintasan via `/help keys`).
25. Keybinding konsisten: Esc dua-tahap (isi tak hilang sekali tekan);
    backspace/delete edit-teks (hapus-data = confirm); navigasi daftar
    (`↑↓`, pgup/pgdn, home/end) di semua popup; hint aksi minimalis
    (`kunci label  kunci label`, kunci accent/label redup, pemisah hanya
    spasi) akurat per state permukaan; kursor diparkir di semua permukaan
    (termasuk approval/ask_user); Enter `/model` = pilih satu langkah,
    Tab = ubah effort.
26. i18n dwibahasa: semua string user-visible lewat `t()`; id kunci = en
     (tsc mengawal); fallback kunci hilang → en; prioritas sesi > env >
     state.json > locale OS > en (di OS: `LC_ALL` > `LANG`, string kosong
     diabaikan); literal Indonesia hardcode dilarang.
31. Sinyal fatal saat TUI hidup (SIGTERM/SIGHUP): restore terminal dulu
    (alt-screen exit + raw mode pulih + handler exit sinkron) lalu exit
    `128+n` (143/129). Pasangan ketat per-run — handler dipasang di
    `run()` dan dilepas di cleanup; tanpa sesi TUI, sinyal tak disentuh.
    (Temuan audit TUI-001: handler `exit` Node tak jalan pada SIGTERM
    default — terminal tertinggal alt-screen + raw.)
32. Proyeksi Presentasi V2.1 TUI memakai snapshot struktural dari composition
    root, bukan parser string. `view`, cap, scroll, approval, transient,
    resize, cursor, dan PTY path tetap memakai kontrak lama.
33. Proyeksi linear dan ACP memakai snapshot/event presentasi yang sama:
    linear menambahkan status/duration/receipt/retry tanpa mengubah
    stdout/stderr split, sedangkan ACP mengirim lifecycle `turn.*`, `tool.*`,
    dan `approval.*` terstruktur plus teks delta. Exit code, pipe safety, dan
    determinisme non-TTY tetap sama.

27. Painter transient stderr (spinner setup/cek-update, bar loading startup,
     garis status turn) DITAHAN selama layar interaktif memegang terminal: `beginInteractiveScreen`
     (`src/ui/runtime/statusline.ts`) membisukan `paintWrite` (nol byte + baris
     painter dibersihkan sekali saat layar mengambil alih), nested dihitung,
     release idempoten. Pemegang: `askLine`/`askSecret`/`runPicker` (raw-mode)
     dan `openAltScreen` (alt-screen, release di `close()`). Tanpa ini tick
     `\r\x1b[2K` spinner menghapus baris prompt wizard (laporan "macet di
     Menyiapkan sesi…"). Bar loading (`src/ui/runtime/loading-bar.ts`) adalah
     painter transient jenis kedua: single-line blok `▓░` + persen + label,
     digambar ulang HANYA saat `update(label, percent)` dipanggil (bukan
     interval), TTY-only (non-TTY = no-op nol byte), label disanitasi, kursor
     direstore di `exit`. Fase startup (update check/install/restart, provider,
     RAG, tool, kernel, resume) memanggil `update`; diagnostik startup
     (resume/recovery/context/dll) DITUNDA saat REPL dan di-flush ke transcript
     TUI (`ctx.startupNotices`), sedangkan non-interaktif tetap mencetak langsung.
     Output npm saat auto-update disembunyikan (`stdio: pipe` dibuang).
28. Kontrak exit code: **0** sukses/help, **1** gagal runtime/lookup, **2**
     salah pakai (argumen hilang/malformed, subcommand asing). Flag sebagai
     positional id = salah pakai (exit 2). `exec --json` yang gagal di fase
     setup (tanpa provider) TETAP memancarkan satu baris `{"type":"summary",
     "ok":false,…}` (di-scrub) di stdout — pipeline CI tak pernah menerima
     stream kosong; jalur manusia (stderr + exit 1) tidak berubah. Flag
     handler `exec`/`daemon` dibaca dari argv scope — lihat I34.
29. `minicode acp` = server JSON-RPC stdio satu-JSON-per-baris untuk IDE
     (subset: `initialize`/`run`/`cancel`/`shutdown`; BUKAN klaim ACP penuh):
     stdout murni mesin (semua di-scrub), diagnostik manusia ke stderr,
     approval `deny-headless`, satu run dalam satu waktu, shutdown/EOF = exit 0.
30. `askLine` (input inline: dropdown `/`, prompt wizard/`ask_user`)
     menginvalidasi jangkar relatifnya saat geometri terminal berubah: render
     pertama sesudah `columns`/`rows` berbeda dari geometri render TERAKHIR
     me-reset `prevRows`/`prevInputRows`/`prevCursorRow` lalu menggambar dari
     kursor saat ini (`lastGeoCols/Rows` di `src/ui/input/input.ts`). Jangkar
     basi pasca-reflow mendarat di baris salah — menimpa area output dan
     menghapus baris yang salah (temuan snap kiri/kanan). SENGAJA tanpa
     listener `resize` baru (frame basi cukup ditimpa render berikutnya), dan
     `printedW` tidak ikut di-reset — nilainya konservatif; dikosongkan justru
     membiarkan ekor lama.
34. Routing argv-scope (P11.2/P11.3): handler `exec` dan `daemon` menerima
     argv SCOPE dari router — flag global dikenal yang mendahului token
     subcommand tetap berlaku, token subcommand dibuang, urutan token
     sisanya utuh. Ditunjukkan tes: `--json exec "t"` identik dengan
     `exec --json "t"` (prompt model = teks user persis, tanpa token
     routing maupun nilai flag); `--json daemon status` mencapai aksi
     `status` alih-alih error subcommand asing; aksi/opsi yang tidak
     dikenal TETAP salah pakai sesuai I28; posisi argumen pertama
     (prompt/aksi) tidak bergeser. Hanya kedua handler itu menerima scope
     — subcommand lain menerima args mentah. Invarian ini tidak mengubah
     semantik, aksi, atau exit code masing-masing aksi; yang berubah hanya
     invokasi flag-mendahului yang dulu salah rute menjadi rute benar.
35. **WorkMode = lapis intent 2-mode di ATAS permission mode (`DISCUSS` | `BUILD`)** — dua
    dimensi yang BERJALAN BERSAMA, bukan pengganti:
    **Nilai runtime:** `DISCUSS` (investigasi baca-saja, diskusi, dan perencanaan:
    16 tool `PURE_READ` lokal + `web_fetch`/`web_search` yang wajib lewat
    pengawasan eksplisit + ekstra rencana `todo_write`/`delegate_task` [explore]/
    `submit_result` bila diizinkan Tool Access Policy) · `EXECUTE` (tanpa ceiling
    tambahan). Nama produk `BUILD` memetakan ke identitas internal `EXECUTE`;
    sesi baru memakai default `DISCUSS`.
    **Gerbang penolakan & side-effect ceiling:** Tool Access Policy menentukan
    capability yang tersedia; PermissionMode menentukan pengawasan persetujuan;
    WorkMode memasang ceiling tambahan. Irisan ketiganya tidak pernah
    memperluas akses (INV-WM1), `visible === callable` terjaga lintas transisi runtime,
    hooks diblokir pada `DISCUSS` untuk semua PM, dan `--verify` ditolak
    fail-closed saat startup bila digabung `DISCUSS` (exit 2) serta dilewati
    otomatis saat mode turun ke `DISCUSS` di TUI.
    **Command `/mode [discuss|build|auto|ask]`:** satu pintu untuk kedua sumbu
    (menggantikan `/work-mode` yang pensiun tanpa alias). Argumen `DISCUSS`/
    `BUILD` mengubah WorkMode; `EXECUTE` hanya nama internal dan ditolak sebagai
    input; `AUTO`/`ASK` mengubah PermissionMode. Tanpa argumen → popup pilihan
    kedua sumbu; nilai invalid → pesan kesalahan dan mode AKTIF TIDAK berubah;
    sesi tanpa kontrol WorkMode
    (handler izin terinjeksi = policy, bukan mode) → ditolak, bukan
    diam-diam tampak berubah. Transisi berlaku pada SESI YANG SEDANG
    BERJALAN: ceiling permission dievaluasi per pemanggilan tool, daftar tool
    dan instruksi system prompt yang dilihat model ikut turun/naik, hooks/verify
    dievaluasi terhadap WorkMode aktif, dan delegasi berikutnya mewarisi
    WorkMode parent yang aktif. WorkMode TIDAK bisa dinaikkan otomatis oleh
    model, anak, atau argumen delegasi.
    **Resume (P0.2 Q5 — menggantikan D-2):** WorkMode DIPERSIST di metadata sesi
    (`sessions.work_mode`) lintas `--resume`. Saat resume tanpa sinyal eksplisit
    (`--work-mode` / `MINICODE_WORK_MODE`), WorkMode dipulihkan dari metadata
    sesi (baris legacy tanpa `work_mode` atau bernilai `PLAN` kembali ke default
    `DISCUSS`; nilai tersimpan `EXECUTE` lama ditampilkan sebagai `BUILD`) dan
    composition root menulis SATU baris stderr human-facing
    (`[resume] WorkMode <MODE> restored from session...` atau notice override/
    legacy) agar otoritas sesi hasil resume selalu terlihat eksplisit. Baris itu
    keluar lewat stderr, BUKAN proyeksi mesin/JSON/ACP — kanal machine tetap
    terstruktur (`summary.workMode` / `result.workMode`), tanpa teks dekoratif.
    **Surfacing lintas-surface (F-DISCUSS-4):** WorkMode terlihat di TUI lewat
    footer (Work Mode kiri; Permission Mode kanan), di one-shot/exec linear
    lewat SATU baris stderr human-facing `[work-mode] <MODE> …`, dan di
    `exec --json` lewat field `summary.workMode` dengan nilai produk `DISCUSS`
    atau `BUILD` — bukan teks dekoratif. ACP memakai `params.workMode`
    (terstruktur) dan tak menambah baris
    dekoratif. WorkMode selalu dibedakan tegas dari PermissionMode (baris
    `[work-mode]` non-TUI vs nilai footer TUI) dan dari status sesi.
    **Pemisahan dari PermissionMode:** `Tab` memutar WorkMode (`Discuss` ↔ `Build`);
    `Shift+Tab` dan `/mode auto|ask` mengubah PermissionMode. PermissionMode menentukan
    pengawasan persetujuan (`AUTO`/`ASK`) dan Tool Access Policy menentukan
    capability. WorkMode memilih postur (diskusi & rencana vs implementasi) dan hanya
    mempersempit akses.
    **Hooks:** gate `shouldRunHooks(permissionMode, workMode)` dievaluasi
    **per pemanggilan** dengan WorkMode dan PermissionMode **AKTIF**. Hooks
    ditahan pada WorkMode `DISCUSS` dan PermissionMode warisan
    `plan`/`readonly`; `Tab` mengubah WorkMode, sedangkan `Shift+Tab` mengubah
    PermissionMode AUTO/ASK.
    **Footer:** Work Mode tampil di kiri (nilai `Build`/`Discuss`; alias
    internal `EXECUTE` ditampilkan `Build`). Permission Mode tampil di kanan dekat
    token konteks sebagai nilai `Auto`/`Ask`. Label produk `Work Mode:` dan
    `Permission Mode:` dihapus v0.24 — nilai saja, lebih lega. Nilai Work Mode
    memakai warna semantik; nilai Permission Mode memakai cyan agar kedua sumbu
    mudah dibedakan. Titik `●` kuning = bash allow-list aktif, abu = nonaktif,
    `○` merah = unrestricted. Bila ada job background hidup, badge `◷ N` tampil
    di samping spark.

36. **Output command readout = jendela overlay di atas chat (v7.18).**
    `/help`, `/status`, `/context`, `/sessions history`, `/view expand`,
    `/provider sync`, `/init`, `/scheduler`, `/undo list`, dan alias `/cost`/`/usage`
    membuka `runOutputWindow`
    (`paintRegion` + `dialogBox` berjudul + body ber-scroll + `hintLine`)
    alih-alih mencetak ke transkrip; chat tidak berubah/bergeser. Navigasi
    `↑↓`/`PgUp/PgDn`/`Home/End`; tutup `Esc`/`Enter`/`Ctrl+C`/`Ctrl+D`; idle
    90 dtk. Jendela interaktif command (`/model`, `/provider`, `/sessions`,
    picker preset/effort) memakai chrome yang sama dan berjudul. Bila layar
    tak mampu/setup gagal, view mengembalikan `false` dan output dicetak ke
    transkrip (fail-open untuk data, fail-closed untuk overlay). Dropdown `/`
    tetap inline dan TIDAK termasuk perubahan ini.

37. **Agent control system (v7.22.1).** (a) Peringatan `[recovery]` pasca anak
    `committed` dipancarkan di JALUR one-shot maupun interaktif/TUI — helper
    tunggal di `cli/index.ts`, display-only, satu writer stderr; (b) tool gated
    (minimum `delegate_task`) tetap hard-deny di non-TTY walau `allowNonTtyAsk`
    / broker daemon di-inject — carve-out hanya untuk tool non-gated; (c) daftar
    tool yang `visible` di wire untuk EXECUTE × `allowlist` hanya memuat tool
    yang benar-benar `callable` (GATED_TOOLS/MCP disembunyikan); (d) opsi
    "Always" tidak tersedia untuk `delegate_task`, sehingga satu approval ASK
    hanya mencakup satu delegasi. Kontrak visual monokrom/flat v7.22 tidak
    diubah oleh invariant ini.

## Grammar (ringkas)

prompt `minicode ›` tampil saat boot/idle dan hilang saat busy (dropdown `/` TANPA bingkai; `Tab` melengkapi command terpilih saat terbuka, dan memutar WorkMode saat tertutup) · transkrip kosong TANPA logo/hint · prompt user terakhir = CARD TRANSPARAN tepat di atas composer (teks/tools dirender di atasnya; gema inline `minicode › <prompt>` disembunyikan) · jeda SATU baris kosong di setiap batas blok (user↔jawaban/tools, antar turn, card↔composer) · status bar `✦ 00.00.00 Discuss  model  cwd … context  Auto ●` FULL MONOKROM (format timer tetap; tanpa level warna; `●`/`○` tetap penanda permission; badge `◷ N` bila job background hidup) + satu spacer sebelum footer · SATU baris tool ringkas `› name target` (` · <status>` hanya untuk non-sukses; tanpa warna) · error `pesan` sekali per kegagalan · pesan error TUI = formatter kanonik (`formatError`, `src/ui/render/errors.ts`): credential di-redaksi (bearer/key/query), escape ANSI dibuang, body provider diringkas + dipotong; `e.message` mentah tak pernah tampil · popup: konten redup di belakang + kotak terpusat (form di dalam) + Esc tutup · approval tercatat · `/status`, `/sessions history`, `/help`, `/context` & `/view expand` tampil di jendela output command di atas chat · `/mode` = satu pintu dua sumbu (`discuss|build` = WorkMode intent layer, `auto|ask` = permission mode) · `/view compact|fold|minimize` dan `Ctrl+O`/`Ctrl+T` sudah DIHAPUS (`VIEW_ACTIONS` = `thinking|expand`; `TuiHost` no-op tanpa receipt) · tabel markdown FLAT tanpa kotak ber-`wrap` (konten panjang tidak kepotong) + margin kiri 3 kolom (adaptif di lebar < 36); fence kode tanpa bar `│` dan tanpa header bahasa; area teks jawaban (paragraf, heading, daftar, blockquote, code block) ber-margin kiri 3 kolom dengan hanging-indent wrap · Projection V2: marker evict tetap; baris running, area thinking, baris diagnostik non-tool, dan ringkasan turn TIDAK dirender ·

`Esc` saat turn = abort (+ hint sekali, antrean dibuang); Esc kedua dalam 1,5 dtk
= quit walau turn langsung selesai; `ESC`+printable (Alt) diabaikan, bukan abort ·
busy = composer hidup, Enter menyelipkan info tambahan ke turn aktif (`steer` di
batas step; fallback antrean ditolak selama `abortRequested`) ·
Mouse wheel = scroll transkrip, PgUp/PgDn = scroll, Shift+PgUp/PgDn = setengah
halaman, Home/End (prompt kosong) = lompat top/ekor · indikator `↓ N baris baru` ·
tab dihitung 8 kolom (batas atas stop
terminal — tak pernah undercount) · C1/bidi/tag dibuang dari teks
tak-terpercaya (sanitasi) · truncate/chunk hanya menyalin SGR (non-SGR
dibuang) · penanda `(aktif)` di luar budget truncasi (tak termakan URL
panjang).

## Residual risk (DISENGAJA — jangan "perbaiki" tanpa keputusan)

1. Foreign partial stderr write tanpa newline (non-interaktif).
2. `kill -9` di tengah sesi: ketik `reset` (pola standar). SIGTERM/SIGHUP
   SUDAH di-handle (I31 — restore + exit 128+n); hanya kill -9/terminal
   close yang masih menyisakan alt-screen.
3. Transkrip TUI hilang saat quit (disengaja — TUI fullscreen).
4. Terminal purba tanpa alternate screen: pesan satu baris + keluar (bukan error).
5. Approval saat user scroll ke atas: blok tercatat di ekor (tak terlihat
   sampai PgDn), tapi prompt jawaban + bell selalu terlihat di bawah.
6. Area backdrop yang terbuka kembali saat kotak Layer 2 menyusut atau resize
   dipulihkan memakai snapshot redup `registerScreenBackdrop` tanpa `ESC[2J`;
   bagian kiri/kanan pada baris yang sejajar secara horizontal dengan kotak
   tetap bersih terpusat hingga `resume()` melakukan repaint penuh.
7. Jalur end-to-end mouse SGR bergantung pada TRANSPORT PTY: kalau byte SGR
   tak sampai ke stdin anak, selection → OSC52 tak bisa diverifikasi lewat
   byte stream nyata. Pada lingkungan diagnostik Windows (ConPTY + node-pty
   1.2.0-beta.15) byte SGR terbukti sampai ke anak yang membaca dalam raw
   mode — kegagalan lama yang disangka "ConPTY membuang SGR" adalah artefak
   line buffering probe, bukan keterbatasan transport. Perilaku platform lain
   belum diuji; capability gate mengukur kemampuannya secara langsung
   (bukan asumsi platform): di luar CI Linux, SGR yang memang tak diantarkan
   → SKIP beralasan; di CI Linux jalur SGR end-to-end WAJIB terverifikasi,
   jadi probe yang verdict-nya bukan "supported" → GAGAL dengan diagnosa
   (bukan skip senyap yang menghapus coverage).

## Peta proteksi (test → invariant)

> **Cara membaca peta ini.** Setiap baris hanya boleh menyatakan perilaku yang
> **benar-benar di-assert** oleh test yang disebut. Kehadiran nama file test
> bukan bukti klaim. Baris yang hanya "nominal" (test ada, tapi assertion-nya
> tak menyentuh perilaku yang diklaim) dipindah ke bagian
> [Gap proteksi](#peta-proteksi-dan-gap-tersisa) di bawah — jangan
> dipoles dengan mengganti kata-kata.

- `test/output-window.test.ts` — I36 (judul/body/hint, scroll ↓/`j`/`k`/wheel +
  counter posisi di judul, sembunyikan hint scroll bila pas 1 layar, salin isi
  dengan `c` lewat `onCopy`, Esc menutup, non-TTY fallback false, lebar outputWindowWidth).
- `test/pty.test.ts` — handoff undo/redo percakapan lewat terminal nyata:
  sesi sumber utuh, cabang kosong, draft tidak otomatis dikirim; exit code Windows
  tetap tidak diklaim.
- `test/cli-commands.test.ts` — picker `/undo` terbaru-dulu, batal mempertahankan
  histori; `/redo` menolak mode baca-saja dan sumber hilang sebelum menulis berkas.
- `test/tui-app.test.ts` — I14 gesture Esc Esc idle; mengetik memutus gesture,
  Esc menghapus draft tidak dihitung, dan abort/quit saat busy tetap terjaga.
- `test/tui-app.test.ts` + `test/tui-lang.test.ts` — I18 draft awal/handoff rewind:
  multiline dan Unicode tetap utuh, escape dibuang, tidak auto-submit, env sekali pakai.
- `test/tui-app.test.ts` — I1/I13/I14/I17-I20 (baris indikator dipotong ke
  lebar frame walau locale id 51 kolom; v7.22: zero-state KOSONG tanpa logo/hint;
  `Tab` autolengkap dropdown `/` vs putar WorkMode saat menu tertutup; klik pada
  baris composer hasil wrap (>5 baris scrolled maupun baris lanjutan) serta
  navigasi visual panah Up/Down pada paragraf panjang; drag seleksi kontinu
  melintasi jeda paragraf, baris tabel flat, isi fence, dan keluar batas viewport;
  prompt idle bertahan setelah Esc;
  `repaint()` tak melukis saat suspended; boot/exit pairing, transcript
  viewport, mouse-wheel/drag-selection/PgUp/PgDn scroll + indikator, prompt
  editing, dots/timer, status bar, Esc-only abort, quit, suspend/resume,
  live repaint, dan busy-composer (draft tampil saat busy, Enter → `enqueue`
  bukan submit kedua, Tab tetap ditahan, Esc membatalkan antrean); I14:
  Home/End jump + Shift+PgUp/PgDn + hint abort
  pertama ada di `test/tui-audit-fixes.test.ts`, bukan di file ini; I17: kunci
  posisi baca saat stream masuk; basis monotonik ada di
  `test/tui-transcript.test.ts` + `test/presentation-projections.test.ts`;
  P0: jalur error TUI meredaksi credential — sentinel bearer tak pernah tampil
  di layar).
- `test/tui-app.test.ts` + `test/audit-fix-control-decoder.test.ts` +
  `test/audit-fix-control-dead-keys.test.ts` — v7.23: card prompt transparan di
  atas composer (tanpa gema inline dobel), teks/tools di atas card; Esc+printable
  tak meng-abort, `Alt+Enter` lintas chunk, batas UTF-8 paste, double-Esc quit,
  Ctrl+O/T dan `/view compact|fold|minimize` tak lagi terikat.
- `test/prompt-engine.test.ts` — decoder streaming CSI/SGR/X10 (`Alt+Enter`,
  CSI-u `Shift+Enter`, `modifyOtherKeys` → `ctrl-j`, batas payload bracketed
  paste 512 KiB, `Tab` complete di menu terbuka), wheel menjadi key scroll,
  klik mouse tidak masuk teks.
- `test/errors-usage.test.ts` — format error UI: `formatError` (kanonik untuk TUI/wizard/one-shot) meredaksi credential (bearer, kunci provider, query, token di batas potong 150 kolom), membuang escape ANSI, memetakan kategori/kind provider, dan menjaga pesan biasa tetap informatif.
- `test/checkpoint-lifecycle.test.ts` — checkpoint = milik lifecycle sesi: manifest tersedia saat `close()` kembali (barrier), tak ada operasi yang tertinggal, kegagalan checkpoint tercatat + dilaporkan tanpa unhandled rejection, dan semua operasi dari beberapa turn selesai saat drain.
- `test/tui-transcript.test.ts` — projection source-mapped: wrap, CJK/ANSI, user
  prefix & jeda antar-turn, akurasi `displayStart`/`pointAt`/`columnAtOffset`
  pada baris user dan markdown inline, tabel TSV, selection text (termasuk border
  ASCII `+---+` yang tidak boleh terseleksi), cap buffer live, dan render
  markdown inline jawaban model (heading/bold/code; tag bahasa fence redup
  ketika berbahasa, delimiter fence disembunyikan, isi fence dan gema user tetap
  literal).
- `test/screen-buffer.test.ts` — parser frame harness (unit).
- `test/tui-transcript.test.ts` — I7/I12/I17/I22 (v7.22: satu baris tool
  ber-chevron `›` tanpa warna, status sukses TIDAK mencetak kata status, fence
  TANPA bar `│`/header bahasa, baris diagnostik non-tool TIDAK dirender, cap
  5000 + marker evict, `total()` monotonik kebal evict, viewport).
- `test/thinking-area.test.ts` — I22 (v7.22: area thinking dan marker
  `+ thinking`/`… N baris lagi` TIDAK dirender, tak ada yang di-commit).
- `test/presentation-projections.test.ts` — I12/I17/I32 (v7.22: projection
  snapshot, marker evict + `total()` monotonik; **ringkasan turn, `ckpt`, dan
  baris status task TIDAK dirender di renderer flat** — test meng-assert
  absensinya; status non-sukses pada baris tool dipisah `·` tanpa warna).
  Jalur linear/ACP untuk status task tetap diuji di
  `test/presentation-linear-acp.test.ts`.
- `test/presentation-linear-acp.test.ts` — I33 (linear projection
  status/duration/receipt dan lifecycle ACP terstruktur; parity policy-vs-legacy)
  + PROMPT 06 Area D (`task.status` → baris ledger linear **dan** envelope ACP
  berfield `taskId`/`status`/`parentId`/`dependsOn`/`revision`).
- `test/presentation-policy.test.ts` — I32/I33 (seleksi node per mode, envelope
  machine, digest divergensi; purity tanpa clock/IO) + PROMPT 06 Area D
  (notice `task.status` **ikut mode `normal`** dengan field terstruktur utuh).
- `test/writer-inventory.test.ts` — OAP-008 (setiap writer langsung terdaftar
  dengan owner; jumlah tak boleh naik diam-diam).
- `test/exec-json-envelope.test.ts` + `test/cli-session.test.ts` (envelope
  machine) — I28/I33/I34 (summary berversi, tanpa ANSI/secret, tanpa raw
  kernel; P11.2 scoping prompt: flag-mendahului vs `exec`-dahulu identik,
  kata `exec` milik user tetap utuh).
- PROMPT 06 Area A — `test/ui-instance-isolation.test.ts`: state renderer
  per-instans (dua sesi nyata; env = bootstrap saja).
- `test/p92-recovery-warning-envelope.test.ts` — I37(a) (baris `[recovery]` dari
  jurnal committed nyata: status/preview amplop, legacy byte-identik, sanitasi
  display, read-only, dan wiring `cli/index.ts`).
- `test/p15-phase2-contracts-approval-recovery.test.ts` — I37(b)/(d) (kontrak
  approval/recovery Phase 2: tidak ada grant persisten lintas delegasi).
- PROMPT 06 Area B — `test/approval-integrity.test.ts`: binding args-hash +
  fingerprint target difoto sebelum prompt dan diverifikasi di barrier efek
  (deny `"stale"` bila berubah), termasuk jalur kernel nyata.
- PROMPT 06 Area C — `test/daemon-stream-phase.test.ts`: `subscribed.phase` +
  `tail_marker.phase` dari latch per-langganan; badge `" [replay]"`.
- PROMPT 06 Area E — `test/memory-consistency.test.ts`: degradasi vector
  terlihat di hasil tool, revoke provenance AND (fail-closed), reconcile
  mengadopsi (bukan menghapus) vector-only, fakta panjang utuh, supersession
  menarik baris lama, lupa menghapus entri multi-chunk utuh, cap per-entri,
  validasi respons embedding.
- PROMPT 06 Area F — `test/ci-glob-expansion.test.ts`: `ci-windows` memakai
  `shell: bash` (pwsh tak mengekspansi glob → suite p15..p24 lolos diam-diam),
  pola mati dihapus, subset p15..p24 hadir di kedua job.

- `test/tui-popup.test.ts` — I16 (komposit di atas transkrip, anti-bocor,
  anti-hantu, `NO_COLOR=1` resume recovery, wheel pada dropdown `/` terbuka
  menggeser menu tanpa menggulir transkrip) + I13 (App.paintRegion/clearRegion
  mendelegasikan region modal ke screen; clock badge memutar `◷` saat idle lalu
  berhenti saat quit).
- `test/form.test.ts` — I21 (field, validasi, secret, select, confirm, batal;
  Esc-1 kembalikan prefill untuk text/secret DAN pilihan bawaan untuk
  select/confirm, Esc-2 batal; Tab+teks dalam satu chunk tidak menulis ke field
  lama; field aktif di luar tinggi kotak tetap terlihat; stack label panjang di
  atas input & sanitasi kontrol C1; adaptasi lebar dinamis saat resize) + I25
  v7.16 (footer dinamis tanpa placeholder `{move}/{save}/{cancel}`; select
  menampilkan hint panah).
- `test/hint-grammar.test.ts` — I25 v7.16 (grammar `kunci label  kunci label`
  tanpa `·`/titik dua; label id/en; `listRow` memakai kolom marker tetap).
  ASCII fallback getter panah/chevron/caret dikunci inventory glyph di
  `test/cli-help-language.test.ts`.
- `test/theme-levels.test.ts` + `test/theme.test.ts` — I6/UI-RENDER (v7.22:
  semua level terminal — 16/256/truecolor — tetap MONOKROM identitas; tidak ada
  SGR warna walau `COLORTERM=truecolor` dan `stdout.isTTY`).
- `test/render-audit-2026-11.test.ts` — audit renderer 2026-11-12 (proyeksi
  pending dimemo per baris → tidak O(n²); SGR majemuk diproses berurutan di
  `truncateToWidth`; indentasi `wordWrap`; SGR opak di highlight; cap input &
  guard LCS diff; lebar tabel untuk grapheme 2 kolom; kop sesi lewat i18n;
  `dialogBox` menggeser jendela ke `focusRow`) **plus penutupan kebocoran**:
  `U+2028/U+2029` jadi spasi di jalur satu-baris, dan paste composer tidak
  bisa menyelundupkan CSI C1 (`U+009B`) — buffer composer dilukis apa adanya,
  jadi gate-nya ada di `prompt-engine` sebelum buffer terbentuk. Jalur pesan
  error layar (`picker`, `model-manager`/`provider-manager` fail-open) dan
  hasil probe jaringan `cli/commands.ts` (`/provider sync`) memakai `cleanUntrusted` /
  `sanitizeAnsiLine`; hook `?25h` loading-bar didaftarkan lazy agar modul yang
  sekadar di-import tidak menulis byte ke alt-screen.
- `test/approval-tui.test.ts` — I23 (blok + keputusan tercatat, deny;
  stdout-pipe tanpa sink = deny; echo memakai `glyphs.arrow` termasuk
  `MINICODE_ASCII=1`) + modal v0.24 (kotak dilukis via `paintRegion`,
  `clearRegion` dipanggil saat selesai, input raw-mode di-echo ke kotak,
  Esc/Ctrl+C = batal fail-closed) + I25 v7.16 (kursor diparkir di opsi aktif,
  quick-key tanpa opsi diabaikan, hint ask_user Enter/Esc, resize dinamis,
  wheel pilihan, dan guard layar sempit `<10` baris).
- `test/background-job-badge.test.ts` — I13 (badge `◷ N` = jumlah job hidup,
  fase berputar dari clock idle, `[BG:n]` fallback ASCII, nol byte saat 0) +
  `onBackgroundJobFinished` emit TEPAT SEKALI per job (error+close tidak dobel).
- `test/footer-render.test.ts` — I13 (nilai mode title case tanpa label produk, Work Mode kiri dan Permission Mode cyan rata kanan dekat konteks, posisi kolom stabil, fallback terminal sempit, titik `●` kuning/abu + `○` merah unrestricted, badge `◷ N`/`[BG:N]`).
- `test/e2e.test.ts` — I13 v7.12 (kernel meng-emit `provider:extension`
  kind `context-window` berisi `usedTokens`/`windowTokens` setelah
  `step:completed` — sumber live-occupancy footer; nilai > 0 terbukti).
- `test/work-mode-runtime.test.ts` — I35 (WorkMode runtime: ceiling permission
  dievaluasi per pemanggilan tool; transisi BUILD/EXECUTE↔DISCUSS↔PLAN pada sesi
  yang sama; daftar tool yang dilihat kernel ikut berubah; hooks mengikuti
  WorkMode aktif; delegasi mewarisi WorkMode parent terbaru; argumen
  delegasi tak bisa menaikkan WorkMode; `/mode` end-to-end lewat TUI (WorkMode
  dan PermissionMode, termasuk nilai invalid dan popup dua sumbu); Shift+Tab
  tak menyentuh WorkMode; footer
  memakai label title case; Tab mengubah WorkMode dan Shift+Tab tidak).
- `test/work-mode-contract.test.ts` — I35 (ceiling handler WorkMode di atas
  handler PM: 18 sel matriks, gerbang approval `PLAN × PM` termasuk `web_fetch`/
  `web_search`, `DISCUSS` memblokir network read, `describeDenial` per pemilik
  keputusan, `always`/K-1 tetap utuh, `__setMode` tak mencabut ceiling).
- `test/work-mode-tool-visibility.test.ts` — I35/I37(c) (visibilitas tool =
  irisan permission mode ∧ WorkMode; `DISCUSS` tepat 16 tool baca lokal tanpa
  network read; `PLAN × readonly/allowlist` tak memperluas di luar 18
  `READONLY_TOOL_NAMES`; tool MCP ikut dibatasi; **EXECUTE × allowlist**
  menyembunyikan `GATED_TOOLS`/MCP yang pasti ditolak handler — `visible ===
  callable`).
- `test/agent-contract.test.ts` — I37(b)/(d) (delegasi headless non-TTY deny
  termasuk broker permissive; satu approval ASK per delegasi).
- `test/audit-fix-agent-control-recovery-interactive.test.ts` — I37(a)/(b)/(d)
  (envelope peringatan recovery di jalur kegagalan interaktif — wiring
  `runPromptWithVerify` + formatter nyata atas jurnal committed — dan regresi
  broker non-TTY / "Always" untuk `delegate_task`).
- `test/work-mode-hooks.test.ts` — I35 (hooks: `DISCUSS` dan `PLAN` menahan
  semua `.minicode/hooks/*` di seluruh `PermissionMode`; hanya `EXECUTE` yang
  mengikuti permission mode; pemanggil lama tanpa WorkMode kompatibel).
- `test/work-mode-subagent.test.ts` — I35 (child mewarisi WorkMode parent;
  tak ada eskalasi lewat mode child; default tanpa WorkMode = perilaku lama).
- `test/work-mode-cli.test.ts` — I35 (`--work-mode`/env: flag > env > persisted
  resume > default DISCUSS; nilai invalid → DISCUSS + peringatan; input operator
  hanya DISCUSS/BUILD (`PLAN` legacy → DISCUSS + peringatan); `--verify`
  ditolak fail-closed pada DISCUSS; ACP `workMode` + fallback env; daemon
  `workMode` parity).
- `test/tui-app.test.ts`, `test/tui-popup.test.ts` — I13/I14/I17 (composer
  editing/busy, dots clock, timer, cursor, resize, popup; teardown saat initial,
  frame, event/timer, dan resize repaint gagal; abort/scroll saat layar menciut;
  spacer composer-footer).
- `test/markdown-table.test.ts` — I8/I11 (pipe-table parser, streaming
  parity, ANSI/CJK width, TTY/non-TTY, TUI resize, machine-output policy).
- `test/terminal-contract.test.ts` — I2/I3/I7/I8/I9 (split stdout/stderr,
  kepemilikan layar tunggal, ledger satu baris per tool, streaming tanpa
  duplikasi, foreign writer boleh mentah).
- `test/provider-retry-output.test.ts`, `test/tui-transcript.test.ts`, dan
  `test/presentation-events.test.ts` — invalidasi attempt provider gagal;
  TUI/transkrip/history/`/copy` tidak menggabungkan teks gagal dengan jawaban
  final, sementara sink linear memberi marker dan usage tetap tercatat.
- `test/transient-arbitration.test.ts` — I3/I9/I27 (hold layar interaktif:
  picker/askLine, nesting, delayMs).
- `test/loading-bar.test.ts` — I27/I6 (bar loading: non-TTY no-op nol byte,
  delay pertama, progres blok+persen+label, sanitasi label, stop idempoten,
  restore kursor, mutual exclusion transient, ditahan layar interaktif).
- `test/statusline-bun-guard.test.ts` — I4 (painter Bun/Windows: painter
  dinonaktifkan sendiri, write asli dipulihkan).
- `test/turn-status.test.ts` — garis status turn lifecycle deterministik
  (grace 250 ms, latch anti-strobe, pembersihan saat `endTurn`).
- `test/tui-format.test.ts` — I2/I7/I8 (preview arg sanitasi satu-baris;
  stdout = output program / stderr = ledger; 20 tool berurutan = 1 baris
  masing-masing tanpa overlap) + **I18** (envelope OSC52 `/copy` benar saat
  TTY, ditolak tanpa TTY, dan 1–10 turn terakhir oldest-to-newest).
- `test/theme.test.ts` — I6 (strip DCS/APC/PM/SOS + final CSI non-huruf).
- `test/ansi-fragmentation.test.ts` — I6/I8 (setiap titik split ≡ string utuh).
- `test/non-tty-output.test.ts` — I6.
- `test/thinking-truncation.test.ts` — I12 (buffer thinking >200 KB → `/view expand`
  membawa marker truncasi).
- `test/collapse.test.ts`, `test/presentation-expand.test.ts`,
  `test/presentation-store.test.ts` — **I24** (semantik `/view expand` pada Content
  Store: buka-ulang identik, dengan id vs tanpa id, miss → durable sqlite +
  penanda retensi).
- `test/ui-combined.test.ts` — DIHAPUS bersama chrome.
- `test/repl-linear.test.ts`, `test/footer-chrome.test.ts`,
  `test/info-window.test.ts` — DIHAPUS bersama REPL/chrome/jendela.
- `test/cli-commands.test.ts` — /status cetak, /sessions popup.
- `test/screen.test.ts` — I16 (pairing + paintRegion + pemulihan backdrop redup
  tanpa `2J` saat menyusut/tutup/resize + `regionEpoch` memaksa repaint penuh
  pada handle induk saat `NO_COLOR=1`; open/paint writer failure mencoba
  memulihkan alt-screen dan reset region) + I1 (satu `write` per frame;
  repaint penuh saat frame pertama / drift stderr / perubahan kolom, dan diff
  inkremental per sel pada paint berikutnya yang setara — bukan clear `ESC[2J`
  tiap keystroke).
- `test/cells.test.ts` — I1 (tokenizer sel grapheme + diff "tulis-ulang ekor":
  prefix identik nol byte, dari kolom berbeda pertama sampai akhir baris ditulis
  ulang setelah EL `ESC[0K`; start mundur ke sel pembawa glyph agar EL tak
  membelah glyph lebar; state SGR ternormalisasi urutan kanonik — `ESC[39m`
  membatalkan bukan menumpuk, `38;5;n`/`38;2;r;g;b` utuh, glyph lebar dilindungi
  `cont`; fuzz 500 kasus paritas output vs referensi).
- `test/composer-wrap.test.ts` — I1 (wrap composer inkremental paritas dengan
  `chunkByWidth` penuh untuk append/backspace di ujung, CJK lebar, multiline;
  pola tak didukung → fallback).
- `test/screen-buffer.test.ts` — parser grid ANSI/CUP dengan pengukuran grapheme
  yang sama dengan renderer (termasuk emoji ZWJ dua kolom).
- `test/tui-startup-failure.test.ts` — UI-COMPAT-01 (CLI subprocess non-TTY:
  diagnostik stderr, stdout kosong, exit 1, provider tidak dipanggil).
- `test/dialog.test.ts` — I11/I16/I20 (geometri, backdrop, box, `canRenderModal`,
  footer ber-SGR tak di-dim ganda).
- `test/tui-overlay.test.ts` — I11/I16 (popup region, gate layar, resize
  dinamis `picker`, serta sharing `screen` agar picker nested membersihkan
  kotak induk tanpa tearing).
- `test/ui-boundary.test.ts` — I1/I3 (src/ui tak impor keluar).
- `test/i18n.test.ts` — I26 (resolusi, fallback, interpolasi, kelengkapan;
  LC_ALL > LANG, string kosong diabaikan).
- `test/i18n-hardcode.test.ts` — I26 (lexer sadar-state: tanpa literal
  Indonesia di luar kamus; kontrol positif id.ts kena, negatif en.ts bersih).
- `test/tui-lang.test.ts` — I26 (locale sesi `/lang` end-to-end + persisten;
  nilai tak dikenal ditolak) + I24 (`/help` satu sumber; `/copy 2` menyalin dua
  turn terakhir) + I36 (`/help` dan `/status` tampil di jendela output command;
  setelah ditutup, readout TIDAK bocor ke transkrip).
- `test/cli-help-language.test.ts` — I26/I25 (label en, kelengkapan /help;
  v7.16: grup View terisi di full help — compact/thinking/expand/minimize/fold
  terdaftar, bukan heading kosong).
- `test/tui-geometry.test.ts` — I20/I25 (lebar tetap per permukaan, step
  wizard, form error).
- `test/sanitize.test.ts` — I2 (C1/bidi/tag dibuang, ZWJ dipertahankan;
  NO_COLOR menang di cleanUntrusted).
- `test/width.test.ts` — I2/I7 + UI-RENDER-01 (VS16, skin tone, ZWJ, regional
  indicator, keycap, combining mark; truncate/chunk tidak memecah grapheme;
  tab 8 kolom; hanya-SGR + auto-reset; chunk(0) kosong).
- `test/exit-codes.test.ts` — I28 (0/1/2 di semua handler; lookup tetap 1;
  hermetic subprocess).
- `test/exec-json-envelope.test.ts` — I28 (summary ok:false di stdout saat
  setup gagal; jalur manusia tak berubah).
- `test/cli-subcommands.test.ts` — I34 (daemon scoped argv: `--json daemon
  status` mencapai aksi `status`, bukan exit 2 palsu; bentuk `daemon`-dahulu
  tidak berubah; aksi asing tetap exit 2; HOME hermetik, exit 3 not-alive
  mengikuti kontrak daemon yang sudah ada — bukan klaim baru I34).
- `test/acp.test.ts` — I29 (parser/framing/params + smoke spawn stdio:
  initialize→shutdown exit 0, tanpa provider).
- `test/input-resize.test.ts` — I30 (gagal di kode lama: CUP `\x1b[1A` ke
  jangkar basi sesudah resize; multiline, dropdown terbuka, resize ganda,
  resize cepat ×10 → nilai submit utuh).
- `test/tui-diff.test.ts` — I2/I7 (path & isi disanitasi).
- `test/highlight.test.ts` — I2/I8 (CR dibuang; escape dibuang di hulu).
- `test/tui-theme-highlight.test.ts` — I2 (section satu-baris; markdown
  buang escape di hulu).
- `test/provider-manager-flows.test.ts` — I21 (Ctrl+C dua-tahap revert
  prefill; penanda aktif anti-truncasi).
- `test/tui-signal.test.ts` — I31 (SIGTERM→143, SIGHUP→129: alt-screen exit
  + raw mode pulih; handler dilepas saat quit — pasangan ketat; tanpa
  `run()` sinyal tak di-intercept).
- `test/tui-audit-fixes.test.ts` — I14 (Home/End jump top/tail saat prompt
  kosong + baris berisi tetap editing; Shift+PgUp/PgDn half-page + dekode
  ESC[5;2~; hint abort pertama), I13 (MINICODE_MOTION=0: spark statis,
  env dibaca saat dipakai), I25 (kursor CUP parkir di dalam blok ?2026 yang
  sama), I21 (konstanta idle form 80+10 dtk + teks peringatan).
- `test/pty.test.ts` — I13/I17/I31/I28 + UI-RENDER-01 via BYTE STREAM NYATA
  (harness PTY `test/helpers/pty-harness.ts`, CLI di pseudo-terminal
  sesungguhan + provider fake hermetic): boot → ?1049h + timer idle, terminal
  terlalu kecil menolak alt-screen, turn penuh, teks Unicode kompleks pada
  frame produksi, drag-selection mouse SGR → Ctrl+C → OSC52 (koordinat mouse
  dihitung dari LAYAR NYATA, bukan hardcoded), resize → repaint, SIGTERM →
  restore + exit 143 (POSIX). *Klausa "exec --json bersih tanpa ANSI" di test ini berjalan
  sebagai proses biasa tanpa PTY (lihat komentar di berkasnya) — jadi ia
  bukan bukti byte stream; bukti envelope ada di `test/exec-json-envelope.test.ts`.*
  Platform tak mampu (ConPTY rusak) = SKIP beralasan, bukan hijau palsu.
  Verifikasi **exit code** (I28) hanya dijalankan di POSIX: Windows ConPTY
  terbukti kadang melaporkan `exitCode: undefined` untuk anak yang keluar via
  PTY interaktif (satu probe sukses TIDAK menjamin run berikutnya), sehingga
  test di-SKIP beralasan di Windows — bukan diluluskan dan bukan dianggap
  "berhasil".
  Jalur mouse SGR punya capability gate (`ptySgrMouseDelivered()`): transport
  yang TAK mengantarkan byte SGR → SKIP beralasan; probe tak konklusif → SKIP
  dengan alasan "tak konklusif" (BUKAN bukti SGR tak didukung); di CI Linux
  verdict WAJIB "supported" — selain itu test SGR GAGAL dengan diagnosa, bukan
  skip senyap. Parser SGR dan selection SGR tetap terverifikasi terpisah di
  `test/prompt-engine.test.ts` dan `test/tui-app.test.ts` (fake TTY).

### Peta proteksi dan gap tersisa

Baris berstatus "ditutup" menunjukkan bukti yang tersedia saat ini. Gap tersisa
tetap UNVERIFIED; keberadaan implementasi saja bukan bukti UAT.

| Klaim | Status implementasi | Yang hilang |
|---|---|---|
| I14 — "berlaku juga saat layar MENCIUT: abort+scroll selalu lolos" | Terimplementasi (`src/ui/tui/app.ts`: PgUp/PgDn dan Esc diintercept sebelum `tooSmall()`) | Ditutup: `test/tui-app.test.ts` membuktikan scroll posisi baca bertahan saat layar dipulihkan dan Esc memanggil abort; `Ctrl+D` tetap jalan keluar terakhir. |
| I13/I17 — "satu baris kosong memisahkan composer dari footer" | Terimplementasi (`src/ui/tui/app.ts` merender satu spacer per frame) | Ditutup: `test/tui-app.test.ts` meng-assert baris spacer dalam frame penuh 14 baris. |
| I20 — lebar kotak popup tetap per permukaan | Terimplementasi | Ditutup: label di `test/tui-app.test.ts` kini bertanda `(I13)`, dan lebar kotak popup diverifikasi di `test/tui-geometry.test.ts` + `test/dialog.test.ts`. |
| I5 — tak ada popup yatim / input bocor setelah success/failure/cancel/SIGINT/session end | Terimplementasi | Ditutup untuk dropdown `/` + submit error + abort/Esc di `test/tui-app.test.ts` (`I5`) dan arbiter transient `test/turn-status.test.ts`; SIGINT/POSIX tetap teruji di `test/tui-signal.test.ts` + `test/pty.test.ts`. |
| I26 pada jalur presentasi | Terimplementasi | Ditutup: `test/presentation-projections.test.ts` kini memverifikasi locale `id` di transcript & logger linier bersama `test/i18n.test.ts` + `test/i18n-hardcode.test.ts`. |
| I2/I6/I28 pada proyeksi linear/ACP | Terimplementasi | Ditutup: `test/presentation-linear-acp.test.ts` kini meng-assert split stdout/stderr non-TTY, bebas CSI/OSC cursor control (`I2/I6`), dan exit code `0` ACP (`I28`). |
| I3 — kepemilikan frame tunggal selama alternate-screen | `App` merender frame ke stdout; `simple` quiet dan transient stderr ditahan selama layar dimiliki TUI | Ditutup untuk jalur yang diuji: `test/terminal-contract.test.ts` memastikan printer linear quiet tetap tidak menulis, `test/pty.test.ts` mengamati frame produksi, dan `test/writer-inventory.test.ts` mengunci daftar writer. Suite PTY berjalan pada CI Linux; Windows ConPTY tidak menjalankan seluruh kasus PTY. |
| UI-COMPAT-01 — startup TUI gagal | Non-TTY/terminal tak mampu menolak fullscreen tanpa fallback linear; diagnostik stderr dan exit 1 | Ditutup: `test/tui-startup-failure.test.ts` menguji CLI produksi via subprocess; `test/pty.test.ts` menguji terminal di bawah minimum tanpa `?1049h`. Exit code PTY hanya diklaim jika platform mengembalikan angka. |
| UI-RENDER-02 — exception render melewati teardown | `TuiApp.run()` melakukan cleanup idempoten di `finally`; write frame melempar ke owner | Ditutup untuk initial paint, writer frame, dan event repaint: `test/tui-app.test.ts` + `test/screen.test.ts` memverifikasi alt-screen, raw mode, listener, subscription, timer dan sync-update. Sinyal POSIX diperiksa terpisah; Windows melewati test sinyal POSIX. |
