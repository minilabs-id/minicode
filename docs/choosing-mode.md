# Memilih Mode

Tiga sumbu terpisah menentukan apa yang bisa/tidak bisa dilakukan agent:

1. **WorkMode** (operating mode) — *bagaimana* agent bekerja: `DISCUSS` (investigasi & perencanaan read-only) atau `BUILD` (implementasi).
2. **PermissionMode** (persetujuan) — *apakah* butuh izin manusia: `AUTO` (otonom) atau `ASK` (diawasi).
3. **Tool Access Policy** — *apa* yang tersedia (read-only set, bash allowlist, delegasi, MCP, scope).

Hard security (path jail luar workspace, sensitive-file, owned-state, bash-guard) selalu berlaku, di atas ketiganya — **kecuali mode `unrestricted`**, yang membuka jail path luar workspace + bash-guard + allowlist, tetapi file sensitif (`.env`, `.ssh`) dan state milik minicode (`.minicode/`) tetap ditolak (lihat baris terakhir tabel).

## Kalau tujuan Anda X → gunakan Y

| Saya ingin… | Gunakan | Karena |
|---|---|---|
| Memahami repo / merencanakan tanpa mutasi | `--work-mode DISCUSS` | Ceiling read-only lokal + artefak rencana; tulis workspace/git/delegasi eksekusi ditolak di gerbang |
| Minta agen membuat perubahan | `--work-mode BUILD` + `AUTO` (Permission Mode default) | Tulis terjail + bash + commit + delegasi + MCP authorized jalan otonom; hard-deny tetap berlaku |
| Menyetujui setiap perubahan | `--work-mode BUILD --ask` (`BUILD` + `ASK`) | Tiap tool non-sepele menunggu jawaban; baca/bookkeeping tak ditanya |
| Otomasi/CI tanpa manusia | One-shot/`exec` + default `DISCUSS` untuk baca; tambah `--work-mode BUILD` bila perlu mutasi | `AUTO` menolak `ask_user` deterministik (BLOCKED) di non-TTY; MCP tak-terkonfigurasi deny; tidak ada prompt yang bisa menggantung |
| Otonom penuh di mesin sendiri | `--work-mode BUILD` + `AUTO` + `--sandbox docker` (atau OS) + `--budget` | Tanpa prompt, TETAPI jail path + bash-guard tetap aktif; sandbox memberi isolasi nyata |
| Full akses tanpa pembatas (VM/VPN tepercaya) | `/unrestric` (perintah TUI tersembunyi, per-sesi) | Melepas jail path luar workspace + bash-guard + allowlist/sandbox; kredensial git sempit (`GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`) diteruskan hanya di mode ini; file sensitif dan state minicode tetap ditolak; footer menampilkan `○` merah |

## Rule of thumb

1. **Sesi baru mulai `DISCUSS`+`AUTO`** untuk investigasi/perencanaan read-only tanpa menyentuh file/git; pilih `BUILD` secara eksplisit saat ingin implementasi. `AUTO` mengatur persetujuan dan tidak memberi capability dengan sendirinya.
2. **`ASK` untuk wilayah asing** — repo orang, perintah yang belum Anda pahami. Jawab `always` hanya untuk pasangan tool+args spesifik yang sudah Anda nilai.
3. **AUTO ≠ allow-all.** Kapabilitas yang tidak diotorisasi (mis. MCP tak-terkonfigurasi, `ask_user` di AUTO, code tanpa sandbox) di-*deny* dengan alasan, bukan di-prompt.
4. **Legacy `--allow-all`/`--allowlist`** dipetakan ke profil akses; path jail + bash-guard tetap menolak.
5. **`/unrestric` hanya untuk lingkungan yang benar-benar Anda percaya** — model bisa menyentuh file apa pun di host (kecuali file sensitif/state minicode), menjalankan shell tanpa allow-list, dan `git_push` ke remote. Sering kali `BUILD`+`AUTO`+sandbox sudah cukup.

## Tradeoff yang jujur

- Semakin otonom → semakin cepat, semakin besar blast radius bila model salah paham. Tidak ada mode yang membuat model lebih bijak — mode hanya mengatur **apa yang boleh terjadi**.
- `allowlist` (otomatis saat tanpa sandbox OS) paling ketat untuk shell, tetapi model tetap bisa menulis file via tool terjail — pahami beda sumbunya: allowlist membatasi *perintah*, jail membatasi *file*.
- Ganti mode kapan pun: flag saat start, `Tab`/`Shift+Tab` atau `/mode`+`/work-mode` saat TUI berjalan.

## Lanjut

- [Keamanan](security.md) — apa yang ditegakkan tiap mode.
- [Policy & Sandbox](policy-sandbox.md) — tabel semantik presisi + bukti guard.
- [Otomasi & CI](exec.md) — batasan headless.
- [CLI](cli.md) — referensi flag WorkMode/PermissionMode.
