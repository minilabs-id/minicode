# Rencana Integrasi Browser ke Minicode — keputusan akhir

**Checkpoint:** working tree `0.43.2` (HEAD `42a35a6`). Rilis ditahan owner sampai semua tugas bersih; publish CI untuk tag lama tidak dilanjutkan.
**Status:** TAHAP 0 SELESAI (skill global + lokal + paragraf docs). TAHAP 1 SELESAI (15 pola allowlist). TAHAP 2 **DITUTUP** — uji manual win32 lolos (`npx agent-browser --version` = 0.43.0; `skills get core`; `session id --scope worktree`; `open https://example.com`; `snapshot -i` → `@e1`; `close`), jadi wrapper tool tidak perlu dibuat. Belum ada gate/rilis, bukan roadmap master.
**Riwayat keputusan owner:**
1. Awal: `vercel-labs/agent-browser`.
2. Lalu: `lexmount/moli` ("pakai itu dah").
3. Terakhir: minta riset `agent-browser` + `h4ckf0r0day/obscura` juga.
4. **Terbaru:** `.minicode/` kini **boleh ditulis agen** — salinan skill lokal diizinkan (tetap non-default: tanpa `--allow-local-config` skill lokal tak dimuat, jadi global tetap primer).
5. **Terbaru:** flag `install`, `eval`, `--auto-connect`, `mcp` **kini BOLEH** dipakai agen (sudah masuk allowlist). Tetap sarankan profil fresh & jangan menempel ke sesi login privilesei tanpa alasan.
6. Keputusan akhir integrasi: **agent-browser primary + `--engine obscura` opsional**.

> **Catatan kebijakan (mencabut bagian lama di §0/§4/§7):** poin 4–5 di atas menggantikan larangan lama soal menulis `.minicode/` dan soal `install`/`eval`/`--auto-connect`/`mcp`. Alasan global skill tetap dipakai: pemuatan tanpa flag, bukan lagi karena jail owned-state.

**Kesimpulan riset (3+3 agen baca-sahaja, 23 Nov 2026):** ketiga tool nyata & aktif. `obscura` **adalah engine yang sama** yang dipakai `agent-browser` lewat `--engine obscura` (bukan fork). Dokumen ini merekomendasikan **agent-browser sebagai primary + obscura sebagai opsi ringan tanpa Chrome**, dengan alasan di §2. Keputusan final owner tercatat di riwayat poin 6; Tahap 0–1 selesai, Tahap 2 ditutup setelah uji manual.

---

## 0. Riwayat: klaim ".minicode bisa diubah agen"

**Dulu TIDAK benar, sekarang dicabut owner (23 Nov 2026).** Bukti lama (arsip):
- `src/policy/jail.ts:38-62` — `OWNED_STATE_RE` + `isOwnedState()`.
- `src/policy/permission.ts:1200-1236` — `deny("jail: owned state")` untuk `FILE_WRITE_TOOL_NAMES`, di semua mode approval (sebelum `mode` dibaca di `:1238`).
- `src/tools/write_file.ts:15-16`, `src/tools/edit.ts:141-142` — deskripsi eksplisit.
- `src/policy/bash-guard.ts:743-744,783,873-886,981` — workaround shell tertutup.
- Satu-satunya bypass: mode `unrestricted` (`/unrestric`, `permission.ts:71-74,1158-1160`) — per-sesi, tak persist, mematikan seluruh jail.

Skill lokal `<cwd>/.minicode/skills/` juga default tidak dimuat: `src/skills/loader.ts:160-163,171` (`allowLocal` default false), `cli/args.ts:148-153` (butuh `--allow-local-config`), cache 5 mnt (`:157-175`), katalog saat startup (`cli/setup.ts:1228-1242`).
**Keputusan:** skill di **`~/.minicode/skills/` (global)** — tanpa flag, tidak kena jail, tidak ikut tarball (`pack-check.ts:204`).

**Update owner (23 Nov 2026):** klaim "agen tak boleh ubah `.minicode/`" sudah dicabut — agen kini boleh menulis `.minicode/`. Alasan memakai skill global bergeser dari "jail owned-state" menjadi "dimuat tanpa `--allow-local-config`". Salinan lokal `<cwd>/.minicode/skills/agent-browser.md` dibuat untuk eksperimen bila flag aktif; tetap bukan sumber utama.

---

## 1. Fakta tiga kandidat (terverifikasi web, 23 Nov 2026)

| | `vercel-labs/agent-browser` | `lexmount/moli` | `h4ckf0r0day/obscura` |
|---|---|---|---|
| Star/fork | 53,6k / 3,8k | 24,3k / 701 | 37,1k / 3,0k |
| Arsitektur | CLI+daemon, default **Chrome for Testing** via CDP | kernel Rust mandiri (Stylo/Taffy/V8) | kernel Rust mandiri + render sendiri + V8 |
| Butuh Chrome | **Ya** (`agent-browser install`); alternatif `--engine obscura/lightpanda` | Tidak | Tidak |
| Footprint | launcher 313 KiB + CLI win 19 MB + Chrome ratusan MB | ~42 MB, RAM ~73–92 MiB | ~42–70 MB, RAM ~39 MiB (self) |
| Interaksi | `snapshot -i` + **refs `@e1`**, klik fail-closed | `semantic_tree_text`, tanpa refs → `--eval` | `fetch`/`serve`/`mcp`, **opaque refs** (token, invalid per snapshot) |
| Skill version-matched | **Ya** `skills get core` | statis | statis |
| Security | **Paling lengkap**: allowlist, action policy, confirm, AES-GCM vault, content-boundary, max-output, CVE check | private-network policy, profile | SSRF deny-set agresif, token+origin; **tanpa confirm/allowlist** |
| Windows x64 | Ya (native + npm) | Ya (PowerShell installer) | Ya (zip+Scoop, no admin/WSL) |
| Install-on-demand | **`npx agent-browser open`** (tanpa install) | installer script | unduh manual dulu |
| Kematangan | produksi (Vercel Labs) | "production-ready" (self) | **experimental** — issue shadow-root, hit-testing, AXTree, font (Nov 2026) |
| Hubungan | orkestrator; adapter untuk obscura | independent | **engine yang sama** dipakai agent-browser `--engine obscura` |

Kutipan kunci: https://agent-browser.dev/engines/obscura → *"agent-browser manages Obscura the same way it manages Chrome. It spawns the `obscura serve` process, connects over CDP…"* dan *"Obscura v0.2.2 has known accessibility naming, hidden-element, iframe and screenshot fidelity gaps."*

---

## 2. Rekomendasi akhir (untuk keputusan owner)

**Primary: `vercel-labs/agent-browser`. Opsi ringan: `h4ckf0r0day/obscura` via `--engine obscura`. `moli` tidak dipilih** (kalah di skill version-matched & policy; unggul hanya di RAM, tapi obscura lebih ringan).

Alasan:
1. **Loop deterministik** — `snapshot -i` → `@e1` → klik → re-snapshot, klik **fail-closed** kalau target tertutup banner. Obscura pakai opaque token & punya issue shadow-root/hit-testing; moli pakai `--eval` (rawaSelector).
2. **Keamanan built-in** — allowlist, action policy, confirm, vault, content-boundary, max-output. Untuk agent yang membaca halaman tak terpercaya, ini jauh lebih aman daripada mengandalkan skill saja.
3. **Install-on-demand paling murni** — `npx agent-browser open ...` benar-benar tanpa install; Chrome baru diunduh kalau `install` dipanggil. Sesuai prinsip owner.
4. **Obscura = engine-nya**, jadi kalau nanti butuh ringan tanpa Chrome, tinggal `--engine obscura` — **tidak perlu integrasi kedua**. Ini menjawab permintaan riset owner tanpa menambah permukaan.
5. **Windows x64 resmi** di ketiganya; agent-browser didukung Vercel OSS Program.

Trade-off yang jujur: agent-browser + Chrome ≈ ratusan MB. Kalau RAM menjadi kendala mutlak, fallback `--engine obscura` (experimental, fidelity gaps) — bukan moli, kecuali owner memilih ulang.

---

## 3. Desain integrasi (primary = agent-browser)

| Keputusan | Pilihan |
|---|---|
| Bentuk | **Bash allowlist sempit + skill global** — 0 tool schema, 0 MCP, 0 writer, I1 utuh |
| Skill | `~/.minicode/skills/agent-browser.md` (global, tanpa flag, tidak ikut tarball) |
| Deteksi | `where.exe agent-browser` (win32; `command -v` diblokir di `permission.ts:250-253`, `which *` diizinkan `:234`) |
| Install | Operator manual; agen hanya kasih perintah `npm install -g agent-browser && agent-browser install` (atau `npx` untuk sekali pakai). **Jangan auto-install** (tak ada pola prompt y/n di repo; yang ada = pesan jujur + perintah manual, `update-check.ts:160-164`, `provision.ts:276`) |
| Opsi ringan | `--engine obscura` hanya untuk fetch/eksperimen; skill harus menyatakan engine experimental |
| Fallback | `web_fetch`/`web_search` untuk statis; `agent-browser read <url>` (HTTP tanpa Chrome); jangan klaim interaksi bila Chrome belum ada |
| Pack | Tidak berubah (skill di `~/.minicode/`); `gate:pack` diukur ulang di kandidat final |

---

## 4. Tahap 0 — Skill & docs (nol kode runtime) — ✅ SELESAI

Skill global `~/.minicode/skills/agent-browser.md` (~25–35 baris) + satu paragraf di `docs/tools.md`:
1. Frontmatter `name`, `description` (kapan dipakai: JS-render, klik/form, verifikasi UI).
2. Deteksi `where.exe agent-browser`; bila tak ada → pesan jujur + perintah install manual / `npx agent-browser open …`. **Jangan auto-install.**
3. Urutan hemat token: `agent-browser skills get core` (sekali) → `errors`/`console` dulu → `snapshot -i` → `click @eN` → re-snapshot → `screenshot` **hanya** untuk CSS/layout.
4. Flag wajib: `--allowed-domains`, `--action-policy`, `--confirm-actions`, `--max-output`, `--content-boundaries`.
5. ~~Larangan: `--auto-connect` tanpa izin (cookie/sesi user), `eval` tanpa confirm~~ → **dicabut owner**: `install`/`eval`/`--auto-connect`/`mcp` kini diizinkan; tetap sarankan profil fresh, jangan tempel `network`/`console` mentah ke konteks.
6. Opsi `--engine obscura`: hanya untuk fetch ringan; nyatakan experimental (fidelity gaps).
7. Fallback `web_fetch`/`web_search`; jangan klaim interaksi bila engine belum siap.

**Acceptance:** skill terbaca tanpa flag; tak ada perubahan `package.json`/`allTools`/i18n/`pack-budget`.

**Hasil (23 Nov 2026):** ✅ Dibuat `C:\Users\zo\.minicode\skills\agent-browser.md` (global, 33 baris) + salinan identik `D:\Github\minicode\.minicode\skills\agent-browser.md` (lokal, untuk eksperimen bila `--allow-local-config` aktif) + satu paragraf Web di `docs/tools.md`. Skill memuat frontmatter, deteksi (`where.exe` / `npx --yes`), urutan hemat token, 5 flag keamanan, catatan kebijakan baru, opsi `--engine obscura`, fallback, dan aturan data tak terpercaya. Tidak ada perubahan UI/runtime/`package.json`/CHANGELOG/`src/policy`/`src/tools`/`test`. Belum ada gate (sesuai instruksi).

---

## 5. Tahap 1 — Izin granular (tanpa tool baru)

Tambah ke `DEFAULT_BASH_ALLOWLIST` (`permission.ts:183-264`) pola **sempit**:
```
agent-browser open*
agent-browser snapshot*
agent-browser click*
agent-browser fill*
agent-browser errors*
agent-browser console*
agent-browser network*
agent-browser get*
agent-browser close*
agent-browser skills get core
agent-browser --version
npx agent-browser open*
```
~~**Jangan** tambah: `agent-browser install*`, `agent-browser eval*`, `--auto-connect*`, `agent-browser mcp*`.~~ → **dicabut owner**: keempatnya kini **boleh** masuk allowlist; yang tetap dilarang hanya pola telanjang. Regex `*`→`.*` case-insensitive (`permission.ts:454-468`) → test negatif sudah ditambah di `test/allowlist-segments.test.ts`. **TAHAP 1 SELESAI** — 15 pola masuk `DEFAULT_BASH_ALLOWLIST`, verifikasi lokal 82 test hijau (tsc/lint bersih). Gate/rilis masih ditahan owner.

**Acceptance:** test allowlist hijau; `gate:bash` bypass 0/85 tetap; kontrak tool tak berubah.

---

## 6. Tahap 2 — Wrapper tool (HANYA bila perlu)

Pemicu: butuh validasi flag struktural / pembatasan output dengan `capMarked`.
- `src/tools/agent_browser.ts` baru; daftarkan di `src/tools/index.ts`; kontrak `src/policy/tool-contract.ts`.
- **Perhatian:** `test/audit-fix-new-tools-and-wire.test.ts:70` hardcode 41 tool → update; `docs/architecture.md:39`.
- Probe sekali → cache (`docker.ts:16-34`, `grep.ts:232-255`): `spawnSync(resolveTrustedExecutable("agent-browser"), ["--version"])`, catch → false.
- Gagal → lempar Error, bukan string sukses (`lsp.ts:184-191`): `"agent-browser tidak tersedia — jalankan: npm install -g agent-browser && agent-browser install"`.
- Output: `capMarked(scrubSecrets(...), LIMITS.BASH_OUTPUT_MAX_CHARS)` + `fenceUntrustedToolOutput` (`web_fetch.ts:5`).

**Acceptance:** gate penuh hijau pada satu kandidat final; ambang tidak diturunkan.

---

## 7. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Cookie/sesi bocor via `--auto-connect` | ~~Dilarang~~ → **diizinkan owner**, tapi pakai profil fresh & jangan tempel ke sesi login privilesei tanpa alasan; jangan tempel `network`/`console` mentah ke konteks |
| Token di console/network masuk konteks | `--max-output`, `--content-boundaries`, redaksi manual; jangan tempel mentah |
| SSRF ke localhost lewat bash | `--allowed-domains`; `web_fetch` punya `isPrivateHost` tapi jalur bash tidak |
| Agen auto-install tanpa izin | Kebijakan skill: hanya kasih perintah; tanpa prompt y/n baru |
| Chrome ratusan MB | Opsi `--engine obscura` untuk fetch ringan; nyatakan experimental |
| Agent tulis skill ke `.minicode/` | ~~Dilarang jail owned-state~~ → **diizinkan owner**; salinan lokal dibuat untuk eksperimen, global tetap primer |
| Skill lokal tak termuat tanpa flag | Pakai skill global; `--allow-local-config` default OFF, masih berlaku |

---

## 8. Urutan eksekusi (setelah owner setuju)

1. Selesaikan publish 0.43.2 (CI rerun; flake `concurrency-cross-process`, bukan regresi).
2. Tulis skill global + paragraf docs (Tahap 0) → verifikasi loader tanpa flag.
3. Tambah pola allowlist sempit + test negatif (Tahap 1) → tsc/lint/test allowlist.
4. Uji manual win32: `where agent-browser`, `npx --yes agent-browser --version`, `skills get core`, `open https://example.com` + `snapshot -i`.
5. Uji opsi `--engine obscura` untuk fetch ringan; catat fidelity gaps.
6. Putuskan Tahap 2 berdasarkan hasil uji — jangan langsung dibuat.
7. `gate:fast` penuh pada satu kandidat final sebelum rilis berikutnya.

**Tidak termasuk:** arsitektur lapisan, terminal contract (FROZEN), ambang coverage/pack, roadmap master (milik owner), menurunkan jail owned-state.
