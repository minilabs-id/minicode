# Troubleshooting

Mulai selalu dari:

```bash
minicode doctor [--json]   # runtime, provider, pricing, memory, sandbox, config
```

`doctor` memberi warn (bukan ok palsu) untuk provider 0 models + saran `sync`.

## FAQ

- **LSP tidak jalan:** `minicode config lsp add .ts --command typescript-language-server --args --stdio`. Pastikan server terinstall.
- **Docker sandbox:** `docker pull node:22-alpine`. Daemon mati saat `--sandbox docker` → run **DITOLAK** (fail-closed), bukan turun diam-diam; set `MINICODE_SANDBOX_ALLOW_FALLBACK=1` untuk fallback host yang sadar.
- **Perintah aman ditolak?** Kemungkinan default `allowlist` karena tanpa OS sandbox. Pesan `[sandbox]` hanya dicetak untuk request `--sandbox` eksplisit — fallback implicit senyap. Pilih `--allow-all`/`--ask`, atau `bun experiments/bash-bypass-probe.ts` untuk lihat yang dianggap sah.
- **`--sandbox os` tak berefek:** bwrap/seatbelt tidak ada di Windows. Pakai `--sandbox docker`.
- **Env hilang di subprocess:** hanya kata-kunci kredensial di-strip. `GITHUB_WORKSPACE`/`REDIS_HOST`/`AWS_REGION` tetap ada; `GITHUB_TOKEN`/`AWS_SECRET_ACCESS_KEY`/`DATABASE_URL` di-strip. Bila non-rahasia ikut hilang, itu bug — laporkan nama variabelnya.
- **`grep` lambat:** install `rg`. Bandingkan dengan `MINICODE_GREP_ENGINE=js`.
- **`/undo` tak pulihkan file tertentu:** file itu kemungkinan di `.gitignore` (shadow-git hanya snapshot yang dilacak git).
- **MCP HTTP "host privat":** butuh `--allow-private` saat add. Ini penjaga SSRF.
- **MCP "redirect tidak diikuti":** perbaiki URL; redirect sengaja tidak diikuti.
- **`auth login` gagal:** error server ditampilkan apa adanya. Cek `minicode auth list`.
- **Provider OAuth hilang:** belum login / refresh gagal. `minicode auth status` → `auth login <id>`.
- **`git_commit` ditolak:** di-gate. Ditolak di non-TTY pada `ASK`/`readonly`/`plan`/`allowlist`; di `AUTO` yang terotorisasi ia jalan tanpa prompt, dan di `ASK`+TTY ia minta izin sekali. Itu perilaku yang diinginkan.
- **Biaya N/A:** `minicode pricing sync` → `pricing show <model>`.
- **File besar tak terbaca:** pakai `offset`/`limit` (`read_file` >2 MB memang menolak tanpa itu).
- **Background job tak jalan:** `background:true` ditolak saat `--sandbox` aktif.
- **Verify tak jalan:** set `MINICODE_VERIFY_CMD` / `verifyCommand`.
- **Budget tak akurat:** harga estimasi; biaya riil tergantung provider.
- **`bun install` gagal cari minicore:** pastikan `vendor/minicore` ada (ikut repo). Sync ulang butuh sibling `../minicore` + `bun run vendor:minicore`.
- **`/provider sync` bilang restart?** Hanya bila benar ada model baru (sync jujur `{updated,failed}`).
- **`models --match` kosong?** Header noise sudah dibersihkan; kosong = benar tidak match.
- **Warna bocor ke pipe?** Warna di-gate `stdout.isTTY`; `NO_COLOR` menang; `TERM`/`COLORTERM` tidak menyalakan warna di pipe.
- **Sub-agent mentok / tak naik kelas?** Kirim `scope` (`file`/`dir`/`subtree`/`repo`) — runtime menetapkan budget 12/18/26/36 (`plan` ×1,5, clamp `[8,50]`) dan menaikkannya bertahap `[8,12,20,32,50]` bila anak mentok. **Jangan set `maxSteps` sendiri:** nilai eksplisit mematikan eskalasi; tanpa scope fallback 5/15. Untuk fan-out banyak, pecah 2–3 agen per turn, lalu atur `MINICODE_SUB_AGENT_POOL_SIZE` (1..16, default 3) dan `MINICODE_SUB_AGENT_TIMEOUT_MS` (default 300000 ms).
- **Verify gagal padahal `bun test` hijau?** Bedakan assertion dari gangguan infrastruktur: ENOENT/`maxBuffer` (32 MB) → `infraFailure`, timeout → `timedOut`; keduanya transien, bukan bukti kode rusak. Cek lagi `MINICODE_VERIFY_CMD` / `verifyCommand` dan ukur ulang.
- **`/undo` menyisakan berkas?** `rm` yang gagal ditandai `skipped: remove failed: <code>` (bukan `(removed)`) — berkas memang belum terhapus. Baca diff yang gagal juga melempar error (fail-closed, bukan dianggap "identical"). Periksa izin/path lalu ulangi.
- **Progres startup / ringkasan sesi / aktivitas terlalu ramai?** Ada toggle `MINICODE_STARTUP_PROGRESS=0`, `MINICODE_SESSION_SUMMARY=0`, dan `MINICODE_MINIMIZE_ACTIVITY=0` (fold baris tool di chat). `MINICODE_ACTIVITY_PANEL` sudah legacy/deprecate (D3) sejak v0.34 — sidebar dihapus total, jadi variabel itu tidak lagi berpengaruh. Untuk menyembunyikan reasoning pakai `MINICODE_SHOW_THINKING=0` (marker `+ thinking` di chat).
- **`Ctrl+A` tidak lagi ke awal baris?** Sejak v0.37 `Ctrl+A` memilih seluruh transkrip bila composer kosong & dropdown tertutup. Bila ada draft atau menu `/` terbuka, `Ctrl+A` tetap `Home` — kompatibel dengan perilaku lama. `Ctrl+E` tetap akhir baris.
- **Satu paste multi-baris mengirim beberapa turn?** Tidak seharusnya sejak v0.37: bracketed paste (`?2004h`/`?2004l`, di luar frame) membaca CR sebagai newline draft, bukan submit. Jika masih bertingkat, periksa apakah terminal Anda mengirim sequence bracketed paste dengan benar.
- **Seleksi melompat setelah resize / klik salah tempat?** Sejak v0.37 resize menghentikan auto-scroll, membatalkan drag, mereset kolom kursor, dan merebase anchor walau seleksi aktif; klik pasca-resize memakai geometri baru. Dropdown juga ditutup saat transisi busy/abort.

## Bantuan lanjutan

- [CLI](cli.md) untuk flags `--sandbox --budget --tool-scope`.
- [Policy & Sandbox](policy-sandbox.md) untuk batas analisis statis.
- [Memory & Sessions](memory-sessions.md) untuk resume/undo/journal.
- Lapor bug: sertakan `doctor --json`, OS, `bun --version`, dan langkah reproduksi minimal.
