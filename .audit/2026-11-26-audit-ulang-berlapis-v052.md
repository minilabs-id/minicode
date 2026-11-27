# Audit Ulang Berlapis — v0.52.0 (`9f39300`)

Tanggal: 2026-11-26  
Status: read-only, tidak ada kode yang diubah. Test/gate tidak dijalankan (bash inline ditolak bash-guard; gate menunggu aba-aba pemilik sesuai `AGENTS.md`). Artefak ini menyimpan seluruh hasil audit berlapis sesi sebelumnya sebelum babak lanjutan dimulai.

## 1. Strategi yang dipakai

Sumber riset:
- Fagan inspection / change-based review — Wikipedia *Code review*: inspeksi formal sangat teliti; review berbasis perubahan mendominasi praktik industri.
- Perspective-Based Reading (PBR) — Basili dkk., *Empirical investigation of Perspective-Based Reading* (1996, Crossref `10.1007/bf00368702`) dan replikasi 2006 (`10.1007/s10664-006-5967-6`): pembaca memakai lensa berbeda secara eksplisit.
- OWASP Code Review Guide (proyek resmi): lensa keamanan berbasis risiko.
- QuickCheck / property-based testing (Wikipedia): tetapkan properti/invarian, lalu coba falsifikasi dengan generator input; kecilkan failing case.

Enam pass yang dijalankan:
1. Inventaris permukaan risiko & peta perubahan v0.52.0 (`CHANGELOG.md:3-16`).
2. Invarian lifecycle/state/resource (owner stdin, raw mode, bracketed paste, `suspended`/`released`, idle timer, backdrop).
3. Skenario antagonis: abort, resize, race, input ekstrem, platform.
4. Verifikasi silang test-lock, i18n, kontrak terminal, dokumentasi.
5. Audit ulang temuan dengan lensa berbeda.
6. Sintesis & prioritas.

Eksekusi: lima sub-agent `explore`; dua gagal autentikasi upstream, satu habis langkah tanpa verdict. Semua klaim yang dipakai di bawah diverifikasi ulang langsung oleh parent dengan `read_file`/`grep`.

## 2. Temuan terverifikasi

### P1-1 — Input macet permanen setelah paste besar dengan terminator terbelah

- Bukti: `src/ui/input/prompt-engine.ts:670-691` menyimpan awalan terminator `ESC[201~` yang terpotong di `state.pending`. `hasPendingLoneEsc()` (`:952-954`) hanya mengecek `pending.length === 1 && pending[0] === 0x1b`, **tanpa memeriksa `state.pasteOverflow`**. Pompa (`:1004-1013`) memasang timer 50 ms lalu `flushLoneEsc()` (`:960-965`) memancarkan `esc` asli.
- Interleaving: paste > `MAX_PASTE_BYTES` (512 KiB, `:471`) tanpa terminator → mode overflow; chunk berikutnya berisi ESC saja → timer 50 ms; `[201~` tiba setelah timer → ESC sudah hilang, sisa terminator dibaca literal, `pasteOverflow` tak pernah clear; CR/Ctrl-C berikutnya ditelan sebagai payload paste.
- Dampak: prompt tak bisa submit/cancel. `src/ui/input/input.ts:676-682` juga meng-cancel dialog bila Esc terjadi pada baris kosong.
- Arah perbaikan: `hasPendingLoneEsc()` harus returning false saat `state.pasteOverflow === true` (atau pompa tidak meng-arm timer dalam mode overflow); regresi test untuk terminator terbelah dengan jeda >50 ms.

### P1-2 — Bypass `bash-guard` POSIX via backslash-newline

- Bukti: `normalizeCommand()` di `src/policy/bash-guard.ts:289` mengganti `/\\\r?\n/g` dengan **spasi**; POSIX shell menghapus pasangan backslash-newline seluruhnya.
- Contoh: `cat .e\<LF>nv` dieksekusi shell sebagai `cat .env`, tetapi guard melihat `cat .e nv`.
- Scanner redirect `:528-530` melompati `\`+newline tanpa membangun ulang target; `findRedirectTargets` mengambil `rawCmd.slice(k, e)` sehingga `tRaw` tetap mengandung backslash/newline; `:890` (`stripQuotes(stripCaretEscapes(...))`) tidak menghapusnya pada POSIX (`:88-90` justru mempertahankan pasangan itu).
- `SENSITIVE_TARGET`/`READERS` di `:949-950`, jail/redirect `:911-934`, dan readerTargets `:977+` karenanya meleset.
- Jalur: `src/policy/permission.ts:1122-1132` (`inspectBashCommand`) → allow → `src/tools/bash.ts:494-495` `spawn(shell:true)`.
- Khusus POSIX; win32 tidak terkena. Arah perbaikan: normalisasi backslash-newline = `""` pada POSIX, dan terapkan penghapusan yang sama sebelum `isSensitive(t)` pada target redirect.

### P2-1 — Salin dari jendela output masih mentok 256 KB

- `src/ui/screens/output-window.ts:295-303` menolak `c` bila `clipboardByteLength(text) > MAX_CLIPBOARD_BYTES` **sebelum** memanggil `opts.onCopy`.
- `cli/tui.ts:1509-1513` dan `:1894-1901` sudah mendukung clipboard native >256 KB lewat `writeNativeClipboard`.
- `test/output-window.test.ts:97-113` mengunci callback tak dipanggil untuk payload besar. Perbaikan perlu update test.

### P2-2 — Metadata `prompt_caching` hilang bila berdiri sendiri

- `src/providers/detect.ts:154-159` mengekstrak `promptCaching`, tetapi `mapEntries()` `:175-179` hanya membuat `modelMetadata` saat `contextLength` atau `maxOutputTokens` ada.
- `mergeDiscoveredCapacity()` `src/providers/provision.ts:133-148` sudah mampu membaca `meta.promptCaching`; metadata itu tidak pernah sampai bila endpoint hanya melaporkan caching.

### P2-3 — Referensi `keystore:` tidak di-resolve saat add

- `src/providers/provision.ts:176,223-232`: `detectAndSave` meneruskan `apiKey` mentah ke `detectModels` dan menyimpannya.
- Helper `resolveDetectApiKey` tersedia di `:28-30` dan dipakai `refreshProviderModels` di `:287`; runtime `src/providers/build.ts:118-132` juga me-resolve.
- Dampak: endpoint yang mengabaikan auth menerima literal `keystore:nama` sebagai Bearer lalu penyimpanan tampak sukses; deteksi auth gagal palsu pada endpoint ketat.

### P2-4 — Dua daemon dapat start bersamaan

- `cli/commands/daemon.ts:226-227`: port default `0` (ephemeral); `:480-493` `startDaemon` tidak melakukan `probeDaemon`.
- `src/daemon/host.ts:135-153` langsung `server.start()` lalu `writeEndpoint` + `writeLease`.
- `src/daemon/discovery.ts:143-147` menulis endpoint tanpa compare-and-swap; dua proses bisa bind port berbeda dan menimpa file discovery—proses pertama tetap hidup tetapi tak discoverable.

### P2-5 — Kontradiksi schema & dokumentasi

- `src/tools/task.ts:667-670`: deskripsi `timeoutMs` masih `default 300000`; runtime `src/constants.ts:235` = `3_600_000`.
- `docs-en/agents.md:7`: `600,000 ms`; `docs/agents.md:8` dan kode = 3.600.000.
- `docs/environment.md:28-29`: timeout 300000 / pool 3; kode = 3.600.000 / 5 (`constants.ts:215,235`).
- `docs-en/environment.md:23` dan `docs-en/cli.md:84,103`: `MINICODE_WORK_MODE=PLAN` valid; `cli/args.ts:249-255` menolak selain DISCUSS/BUILD; `test/work-mode-cli.test.ts:63` mengunci PLAN invalid.
- `docs-en/SUMMARY.md:52` menautkan `TERMINAL_CONTRACT.md` yang tidak ada di `docs-en/`.
- `docs/TERMINAL_CONTRACT.md:1` masih v0.51; perubahan v0.52 (clipboard native, paste, progress modal) belum tercatat.
- Clipboard native & `MINICODE_CLIPBOARD=osc52` tidak didokumentasikan; docs masih menyebut OSC 52 saja.

### P3 — Lainnya

- Notifikasi salin di `output-window.ts:299,302-303` memakai `tSystem()`, sedangkan `/copy` di `cli/tui.ts:1903` memakai `t()`—bisa beda bahasa setelah `/lang`.
- Keputusan pemilik yang masih terbuka dari rencana sebelumnya: prefiks `/` di dropdown (`app.ts:2803`, dikunci test), Ctrl+U `/model` sengaja `filter=""` (`model-manager.ts:467-471`), penanda sesi aktif di `/sessions`, cooldown `delegate_task` masih `provider|cwd`.

## 3. Hipotesis yang ditolak setelah verifikasi

- Tidak ada pelanggaran invarian `suspended`/`released`/`attached`/raw-mode pada `TuiApp` dan modal; cleanup konsisten, termasuk nested popup.
- `Scheduler.start()` saat `STOPPING`: sebagian besar fail-closed karena token baru ditolak `acquireSessionAuthority` (`store.ts:1909-1935`); bukan bug yang dikonfirmasi.
- Expiry approval: `approvals.ts:263-279` memeriksa tenggat sebelum transisi; transisi gagal bila timer expiry menang → fail-closed.
- Future-skew lease: `discovery.ts:255-270` menandai `stale`, tetapi `probeDaemon` (`client.ts:35-51`) sengaja menjadikan probe koneksi satu-satunya bukti `alive`; ini by design, bukan bug.
- Klaim sub-agent bahwa `test/context-command.test.ts:159-160` masih mengunci literal lama: **salah**—test sudah memakai `t("ctx.originCatalog")` / `t("ctx.originSafeDefault")`.
- Raw-mode listener progres aman: `attachProgressCancel` mematikan raw mode saat detach, lalu `app.resume()` menyalakan ulang.
- Duplikasi system prompt `openai-compat` tidak mungkin dari jalur produk: tidak ada produsen `role: "system"` di `messages` selain adapter itu sendiri.

## 4. Keterbatasan

Audit ini statis. Tidak ada test, `tsc`, lint, maupun gate yang dijalankan. Temuan P1/P2 perlu regresi test sebelum perbaikan. Dua sub-agent gagal autentikasi dan satu habis langkah; hasilnya tidak dijadikan bukti tanpa verifikasi parent.
