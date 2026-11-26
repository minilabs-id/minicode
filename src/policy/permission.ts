import { resolve } from "node:path"
import { cwd } from "node:process"
import type { PermissionHandler, ToolCall } from "#minicore"
import type {
  ApprovalEventHook,
  ApprovalHookEvent,
  SideEffectTierDisplay,
} from "../presentation/events.ts"
import { isMcpToolName } from "../presentation/label.ts"
import { loadAllowlist, matchAllowlist, saveAllowlist } from "./allowlist.ts"
// [Area B · PROMPT 06] Binding persetujuan ↔ operasi yang dieksekusi.
import {
  type ApprovalBinding,
  type ApprovalBindingStore,
  captureApprovalBinding,
  verifyApprovalBinding,
} from "./approval-binding.ts"
import { inspectBashCommand, normalizeCommand, stripCaretEscapes } from "./bash-guard.ts"
import {
  isCwdOutsideRoot,
  isOwnedHook,
  isOwnedHookReal,
  isRealPathOutsideRoot,
  isSensitive,
  isSensitiveReal,
} from "./jail.ts"
import { scrubSecrets } from "./scrub.ts"
// Tokenizer sadar-platform (POSIX: `\`/`'`; win32: `^`, `'` literal).
import { isDangerousShellVerb, splitShellSegments } from "./shell-tokenize.ts"
// Klasifikasi tool (read/gated/jail/internal/no-prompt/plan) satu sumber di
// tool-contract.ts; permission.ts hanya mengonsumsi derivasinya.
import {
  CWD_JAIL_TOOL_NAMES,
  contractForTool,
  FILE_JAIL_TOOL_NAMES,
  FILE_WRITE_TOOL_NAMES,
  GATED_TOOLS,
  INTERNAL_WRITE_TOOL_NAMES,
  LSP_FILE_JAIL_TOOL_NAMES,
  NETWORK_READ_TOOL_NAMES,
  NO_PROMPT_TOOL_NAMES,
  PLAN_EXTRA_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from "./tool-contract.ts"

/**
 * Approval policy — DUA nilai yang berhadapan dengan pengguna.
 *
 * `auto` (AUTO) = eksekusi otonom penuh: selama capability & scope diizinkan,
 *     aksi berjalan TANPA henti persetujuan rutin. Bukan "izinkan semuanya" —
 *     hard-deny (jail/owned-state/bash-guard) tetap berlaku di atasnya.
 * `ask` (ASK)  = pengawasan manusia: aksi yang dicakup kebijakan persetujuan
 *     meminta izin sebelum jalan. Hard-deny tetap tak bisa di-override.
 *
 * Ejaan lowercase dipertahankan sebagai identitas internal/kompatibilitas
 * untuk AUTO/ASK (persistence & ToolContext memakai nilai ini).
 */
export type ApprovalMode = "auto" | "ask"

/**
 * Union kompatibilitas selama migrasi arsitektur mode.
 *
 * HANYA `"auto"`/`"ask"` adalah kebijakan persetujuan. Sisanya adalah profil
 * capability WARISAN yang kini menjadi tanggung jawab Tool Access Policy:
 *   - `"readonly"`   → capability read-only internal (bukan permukaan; batas
 *                      scheduler adalah injected AutonomousPermissionHandler,
 *                      BUKAN nilai ini).
 *   - `"plan"`       → ceiling WorkMode PLAN (perencanaan user-facing = PLAN).
 *   - `"allowlist"`  → kebijakan akses bash/tool (flag warisan --allowlist).
 *   - `"allow-all"`  → profil akses privileged (flag warisan --allow-all).
 *   - `"unrestricted"` → full akses tanpa gerbang apa pun (tanpa jail, tanpa
 *     bash-guard, tanpa sandbox/allowlist). Diaktifkan EKSPLISIT oleh operator
 *     via perintah `/unrestric` (per-sesi, tak pernah persist). Bukan default —
 *     satu-satunya gerbangnya adalah kepercayaan operator kepada model.
 */
export type PermissionMode =
  | ApprovalMode
  | "readonly"
  | "plan"
  | "allow-all"
  | "allowlist"
  | "unrestricted"

/**
 * View persetujuan yang di-inject dari composition root (cli/setup.ts memakai
 * src/ui/approval/prompt.ts). Policy layer tidak pernah mengimpor UI langsung;
 * tanpa injeksi jawabannya selalu deny (headless), sama dengan perilaku
 * non-TTY sebelumnya.
 */
export type PermissionAsk = (call: {
  name: string
  args?: unknown
  /** [Fase 2 / LOOP-INV-08] Identitas pemanggilan untuk pengikatan approval. */
  id?: string
  /** F-APPROVAL-1: tier risiko efek samping (dari kontrak tool). */
  riskTier?: SideEffectTierDisplay
  /** F-APPROVAL-1: pratinjau diff ringkas (sudah di-scrub secret). */
  diffPreview?: string
  /** P1.2: `always` tersedia hanya bila args dapat dipersist (≤ 2 KB JSON). */
  canAlways?: boolean
  /** Sinyal abort turn agar dialog approval ikut gugur seketika saat dibatalkan. */
  signal?: AbortSignal
}) => Promise<"allow" | "deny" | "always">

/** Batas args yang boleh dipersist sebagai grant `always` (fail-closed). */
const MAX_ALWAYS_ARGS_JSON = 2000

/** P1.2: satu sumber kebenaran untuk ketersediaan opsi `always`. */
export function canPersistAlways(args: unknown): boolean {
  try {
    return JSON.stringify(args).length <= MAX_ALWAYS_ARGS_JSON
  } catch {
    return false
  }
}

/**
 * "Always" TIDAK boleh dipakai ulang untuk `delegate_task`: satu approval ASK
 * hanya mencakup SATU delegasi (docs/AGENTS.md:8), kalau tidak "Always"
 * menggandakan efek samping anak. `canPersistAlways` tetap murni soal ukuran
 * args; pembatasan di helper ini dipakai gerbang view. Broker inject bisa
 * return "always", jadi `saveAlways` dan `matchAllowlist` ikut memblokir (fail-closed).
 */
export function canAlwaysForCall(call: ToolCall): boolean {
  return call.name !== "delegate_task" && canPersistAlways(call.args)
}

// `READONLY_TOOLS` diturunkan dari registry (`allowedInReadonly`), bukan daftar
// manual yang bisa menyimpang. Membership dipegang test no-drift
// p15-phase2-contracts-approval-recovery.test.ts.
const READONLY_TOOLS: ReadonlySet<string> = READONLY_TOOL_NAMES
// Set diturunkan dari flag kontrak; literal manual bisa menyimpang (fail-open).
// Test no-drift memastikan himpunan identik — refactor, bukan perubahan kebijakan.
//
// Tool yang menulis state internal minicode (bukan file workspace) — aman
// di semua mode kecuali readonly/plan. `bash_kill` menghentikan proses yang
// dimulai agent sendiri, jadi tidak menambah permukaan serangan.
const INTERNAL_WRITE_TOOLS: ReadonlySet<string> = INTERNAL_WRITE_TOOL_NAMES

// Tool tulis workspace (path-serialized) yang dijail path-nya & auto-allowed.
const FILE_WRITE_TOOLS: ReadonlySet<string> = FILE_WRITE_TOOL_NAMES

// Subset internal-write tanpa prompt di mode `ask`. `write_memory`/`forget_memory`
// dikecualikan (MEMORY.md persist lintas sesi); `submit_result` termasuk (tanpa efek samping).
const NO_PROMPT_TOOLS: ReadonlySet<string> = NO_PROMPT_TOOL_NAMES

// Tool yang memperbesar serangan / menembus dunia luar: tidak auto-allowed.
//
// `git_commit` ada di sini karena commit mengubah riwayat yang dibagikan —
// bukan sekadar file kerja. Di mode `auto` ia meminta persetujuan sekali
// (jawab `[a] Always` untuk persist), dan ditolak di readonly/plan/allowlist.
//
// `mcp_read`/`mcp_prompt` juga di-gate meski read-only: keduanya menarik konten
// dari server pihak ketiga langsung ke konteks model, yang merupakan jalur
// prompt-injection. `mcp_list` TIDAK di-gate karena hanya melaporkan metadata
// server yang sudah user daftarkan sendiri.
//
// `ask_user` di-gate: model yang bisa bertanya tanpa batas bisa membanjiri
// user (atau memancing jawaban kredensial) — persetujuan sekali per sesi
// via `[a] Always` tetap tersedia.

// Denylist bash kini di src/policy/bash-guard.ts — pemeriksaan dilakukan pada
// bentuk TERNORMALISASI (quote dibuang, variabel sederhana disubstitusi), bukan
// string mentah. Regex-atas-string-mentah yang lama trivially dilewati oleh
// `cat .e""nv`, `X=.env; cat $X`, `p=python3; $p -c 1`, dan `node --eval`.

// Perintah yang dianggap aman di mode `allowlist` — mode paling ketat, dipakai
// saat menjalankan task tak terpercaya. Isinya sengaja **read-only + build**:
// operasi tulis (`rm`, `mv`, `cp`, `mkdir`) TIDAK di sini, karena tujuan mode
// ini memang menahan efek samping. Agent yang butuh menulis file punya
// `write_file`/`edit` yang ter-jail, bukan shell.
//
// Area node/npm (di bawah) merupakan perluasan SADAR demi menjalankan project
// web npm (keluhan: agent menolak "tidak bisa akses & menjalankan nodejs"):
// `node *` = menjalankan berkas skrip (REPL `node` polos tak cocok, pola butuh
// argumen); bentuk eval inline (`-e`/`--eval`/`--require`/`-r`/`--loader`) tetap
// diblokir bash-guard dulu. `npm install`/`ci` JUGA menjalankan lifecycle
// script (postinstall = kode arbitrer dari registry) — oleh sebab itu kategori
// ini tidak lagi murni read-only, melainkan "trusted project". Chain (`;|&`),
// ekspansi `$()`-backtick, dan redirection tetap ditahan lapisan di bawah.
//
// Perhatikan: allowlist diperiksa SETELAH bash-guard, jadi `cat *` di sini
// tidak berarti `cat .env` lolos — guard menolaknya lebih dulu. Pola di sini
// soal "bentuk perintah apa yang boleh", bukan "target apa yang boleh".
const DEFAULT_BASH_ALLOWLIST = [
  "git status*",
  "git diff*",
  "git log*",
  "git branch*",
  "git show*",
  "git rev-parse*",
  "git ls-files*",
  "bun test*",
  "bun x tsc*",
  "bun run *",
  "npm run *",
  "npm exec *",
  "npx *",
  // Project web npm: install dependensi + jalankan script bare (npm test/start
  // adalah bentuk pendek `npm run test/start` yang TIDAK cocok pola `npm run *`).
  // Package manager JS lain ikut (bun/pnpm/yarn) supaya proyek yang memilih PM
  // selain npm tetap bisa install/run di mode ini — konsisten dengan `npm *`.
  "npm install*",
  "npm ci*",
  "npm test*",
  "npm start*",
  "bun install*",
  "bun add*",
  "bun remove*",
  "pnpm install*",
  "pnpm add*",
  "pnpm i *",
  "pnpm remove*",
  "yarn install*",
  "yarn add*",
  "yarn remove*",
  "echo *",
  "ls*",
  "dir*",
  "pwd",
  "cat *",
  // `type` = padanan `cat` di cmd.exe Windows (deskripsi tool bash menyuruh
  // model memakainya) — tanpanya tiap baca berkas via shell di Windows
  // gagal allowlist walau guard sudah menganggapnya reader aman.
  "type *",
  // `head*`/`tail*` (tanpa spasi wajib): model menulis `... | head` dan
  // `... | tail` tanpa argumen sepanjang waktu; pola `head *` menolak bentuk
  // itu walau maksudnya jelas membaca.
  "head*",
  "tail*",
  "wc *",
  "grep *",
  "rg *",
  "findstr *",
  "find *",
  "which *",
  "where *",
  // Reader tambahan yang dipakai model setiap hari dan dulu TIDAK ada: sesi
  // nyata mencatat 15 penolakan `sed -n '1,260p' file`. `sed -i` sengaja tidak
  // dicantumkan (itu penulisan), dan bash-guard tetap memeriksa targetnya.
  "sed -n *",
  "sed --quiet *",
  "more *",
  "sort*",
  "uniq*",
  "cut *",
  "diff *",
  // Reader inventaris/sistem tambahan yang aman secara baca: `tree`/`du`
  // berguna untuk memetakan struktur & ukuran repo, `df`/`date`/`uname` untuk
  // info lingkungan. `tree /` dan `du /` TETAP ditolak ROOT_SCAN di bash-guard
  // (lihat bash-guard.ts), jadi pola `tree*`/`du*` tidak melemahkan jail scan.
  // Sengaja TIDAK menambah `command -v *`: `command` adalah wrapper yang
  // dibuang `normalizeCommand` (bash-guard :240-259), sehingga allowlist
  // mencocokkan teks mentah sementara guard mengevaluasi bentuk tanpa wrapper —
  // pola itu bergantung pada asimetri rapuh dan redundan dengan `which *`.
  "tree*",
  "du*",
  "df*",
  "date*",
  "uname*",
  // Menjalankan berkas skrip Node (mis. `node server.js`) — bukan REPL polos
  // (pola `*` butuh argumen) dan bukan eval inline (diblokir bash-guard).
  // Subsumes `node --version` (versi lama) sehingga entri itu tak lagi khusus.
  "node *",
  "bun --version",
  // Agent-browser (keputusan owner 2026-11-23, ditinjau ulang hari yang sama):
  // pola SEMPIT per subcommand, bukan wildcard telanjang — `agent-browser`
  // saja tak boleh lolos. Regex matchBashAllowlist mengubah `*` → `.*`
  // case-insensitive, jadi subcommand yang tak terdaftar tetap ditolak.
  //
  // `eval` & `mcp` TETAP diizinkan: eval aman karena default Chrome fresh
  // tanpa profil (tak memakai cookie user), mcp dipakai sebagai fallback bila
  // CLI agent-browser bermasalah (CLI tetap primary).
  //
  // `--auto-connect` DICABUT dari allowlist: flag itu menyambung ke browser /
  // profil user, bukan profil fresh. Celah `npx agent-browser --auto-connect`
  // (pola `"npx *"` mencocokkan seluruh string) ditutup oleh deny rule SEMPIT
  // di bashDenyReason, BUKAN di sini — lihat isAgentBrowserAutoConnect.
  //
  // `install*` TETAP terdaftar di allowlist sebagai bentuk perintah yang
  // dikenal, TETAPI mengunduh/memasang browser butuh konfirmasi user. Gerbang
  // ASK ada di check() lewat gateAgentBrowserInstall supaya AUTO (yang bash-
  // nya hanya lewat deny-list) pun ikut terikat — mencopot pola dari sini
  // saja TIDAK cukup untuk meminta persetujuan di mode AUTO.
  "agent-browser open*",
  "agent-browser snapshot*",
  "agent-browser click*",
  "agent-browser fill*",
  "agent-browser errors*",
  "agent-browser console*",
  "agent-browser network*",
  "agent-browser get*",
  "agent-browser close*",
  "agent-browser skills get core",
  "agent-browser --version",
  "agent-browser install*",
  "agent-browser eval*",
  "agent-browser mcp*",
  // TIDAK ada entri `npx agent-browser ...`: pola `"npx *"` di atas sudah
  // mencakup SEMUA bentuk npx (open/eval/mcp/install/...), jadi entri
  // eksplisit hanya redundan. Kontrak subcommand tetap terlihat lewat deretan
  // `agent-browser ...` di atas — itulah satu-satunya daftar bermakna.
]

// [0.16.x] Allowlist "developer" untuk fallback no-sandbox (restrictBash) —
// sesi TRUSTED pengembang di mesin tanpa isolasi OS (Windows default, atau
// Linux/mac tanpa bwrap/seatbelt + tanpa `--sandbox docker`). DI SINI user
// menjalankan KODE SENDIRI, jadi run/test/build/install ekosistem umum boleh.
// Ini BUKAN pengganti isolasi: untuk repo tak-terpercaya tetap pakai
// `--sandbox docker` / `--allowlist` (daftar narrow di atas) — daftar ini
// hanya menghapus gesekan "kenapa node/pip gak bisa jalan" di mesin sendiri.
//
// Deny-list bash-guard TETAP zirah di semua mode (berjalan SEBELUM allowlist
// apa pun): eksekusi kode inline `-e`/`-c` (`python -c`, `node -e`), baca kredensial, exfiltrasi,
// perintah destruktif, dan tulis di luar workspace tetap ditolak. Verba
// berbahaya (`* publish`, `* login`) sengaja TIDAK dicantumkan.
const DEFAULT_DEV_BASH_ALLOWLIST = [
  ...DEFAULT_BASH_ALLOWLIST, // dasar read + git + node/npm/bun/pnpm/yarn + readers
  // ── Runtime/interpreter (menjalankan berkas skrip; eval inline `-e`/`-c`
  //    tetap ditolak bash-guard). `node *` sudah ada di daftar narrow. ──
  "python *",
  "python3 *",
  "deno run*",
  "deno test*",
  "deno task*",
  "deno lint*",
  "deno fmt*",
  "ruby *",
  "php *",
  "perl *",
  "lua*",
  "luajit*",
  "julia*",
  "Rscript *",
  "elixir*",
  "escript*",
  "erl*",
  "groovy*",
  "scala*",
  "tclsh*",
  "dart*",
  "swift*",
  "dotnet*",
  "java*",
  // ── JS/TS: package manager + framework/bundler + test/lint ──
  "pnpm run *",
  "pnpm test*",
  "pnpm dlx *",
  "pnpm exec *",
  "yarn run *",
  "yarn test*",
  "yarn dlx *",
  "yarn exec *",
  "vite*",
  "vitest*",
  "next*",
  "nuxt*",
  "remix*",
  "astro*",
  "svelte-kit*",
  "webpack*",
  "esbuild*",
  "rollup*",
  "parcel*",
  "swc*",
  "babel*",
  "turbo*",
  "nx *",
  "tsx*",
  "ts-node*",
  "jest*",
  "mocha*",
  "ava*",
  "playwright*",
  "cypress*",
  "eslint*",
  "prettier*",
  "biome*",
  "stylelint*",
  "tsc*",
  // ── Python: package/test/lint ──
  "pip *",
  "pip3 *",
  "uv *",
  "pipx *",
  "poetry*",
  "pipenv*",
  "conda*",
  "mypy*",
  "pytest*",
  "ruff*",
  "black*",
  "flake8*",
  "isort*",
  "pylint*",
  "tox*",
  "nox*",
  "django-admin*",
  // ── Ruby (tanpa `gem push`) ──
  "gem install*",
  "gem list*",
  "gem update*",
  "gem build*",
  "gem outdated*",
  "bundle*",
  "bundler*",
  "rake*",
  "rails*",
  "rspec*",
  "rubocop*",
  // ── PHP ──
  "composer*",
  "phpunit*",
  "artisan*",
  "phpcs*",
  "phpstan*",
  "psalm*",
  // ── Rust (tanpa `cargo publish`/`login`) ──
  "cargo build*",
  "cargo run*",
  "cargo test*",
  "cargo check*",
  "cargo add*",
  "cargo remove*",
  "cargo fmt*",
  "cargo clippy*",
  "cargo bench*",
  "cargo doc*",
  "cargo update*",
  "cargo clean*",
  "cargo install*",
  "cargo fix*",
  "rustc*",
  "rustup*",
  // ── Go ──
  "go *",
  // ── Java/Kotlin/JVM ──
  "javac*",
  "jar*",
  "gradle*",
  "gradlew*",
  "./gradlew*",
  "mvn*",
  "./mvnw*",
  "kotlin*",
  "kotlinc*",
  "sbt*",
  // ── .NET ──
  "msbuild*",
  "nuget restore*",
  // ── C/C++/build ──
  "make*",
  "cmake*",
  "ninja*",
  "meson*",
  "bazel*",
  "gcc*",
  "g++*",
  "clang*",
  "clang++*",
  "cc*",
  "pkg-config*",
  // ── Swift/Dart/Flutter ──
  "xcodebuild*",
  "flutter*",
  "pub*",
  // ── DB / ORM CLI ──
  "psql*",
  "mysql*",
  "sqlite3*",
  "redis-cli*",
  "mongosh*",
  "prisma*",
  "drizzle-kit*",
  "knex*",
  // ── Container (dev lokal; escape di-guard CONTAINER_ESCAPE) ──
  "docker*",
  "docker-compose*",
  "podman*",
  "compose*",
]

// 6.4 — npm exec / npx hanya di-allow bila arg "known-good": tak ada
// ekspansi shell ($/backtick) atau redirection (< >). Chaining ;|& sudah
// diblokir oleh matchBashAllowlist (pattern tak mengandungnya).
// Berlaku juga untuk `bun run`/`bun x`: keduanya menjalankan script/paket
// arbitrer dari package.json repo — tanpa cek ini `bun run test` di repo
// jahat lolos dengan ekspansi shell di argumennya.
function npmNpxSafe(cmd: string): boolean {
  return !/[`$<>]/.test(cmd)
}

function matchBashAllowlist(cmd: string, pattern: string): boolean {
  // F-20: newline adalah chaining juga (`echo hi\nenv`) — pola allowlist tak
  // pernah mengandung newline sehingga multiline selalu deny di sini.
  // Chaining `;`/`&&`/`|` TIDAK lagi ditolak di level ini: pemanggil memecah
  // perintah menjadi segmen lebih dulu (lihat `splitShellSegments`), sehingga
  // aturan lama "ada metakarakter = tolak semua" adalah sumber 81 dari 98
  // penolakan allowlist pada sesi nyata.
  const trimmed = cmd.trim()
  if (/\n/.test(trimmed) && !/\n/.test(pattern)) return false
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    "i",
  )
  return re.test(trimmed)
}

// Redirection NETRAL: hanya memindahkan/menduplikasi output (`2>&1`,
// `2>/dev/null`, `>NUL`). Tidak mengubah perintah dan tidak menyentuh berkas
// baru; `> file` dan `>> file` TIDAK termasuk — itu efek tulis.
const NEUTRAL_REDIRECT_RE = /(?:^|\s)\d?>>?\s*(?:&\d|\/dev\/null\b|NUL\b)/gi

function stripNeutralRedirections(cmd: string): string {
  return cmd.replace(NEUTRAL_REDIRECT_RE, " ").replace(/\s+/g, " ").trim()
}

/**
 * Pecah perintah majemuk pada operator tingkat atas (`;`, `&&`, `||`, `|`, `&`,
 * newline). Kutip tunggal/ganda dihormati supaya `grep "a|b"` tidak terpecah.
 *
 * KENAPA dipecah, bukan ditolak: model menulis `grep -n x file 2>&1 | head`
 * sepanjang hari, dan aturan lama menolak SELURUH perintah karena ada `|`
 * padahal setiap tahapnya ada di allowlist. Memeriksa per segmen memberi
 * keamanan yang sama (setiap tahap tetap harus cocok pola + lolos bash-guard)
 * tanpa memaksa model menulis shell satu tahap.
 */
export { splitShellSegments }

type BashListDecision = { ok: true } | { ok: false; reason: string; command: string }

/**
 * Putuskan SATU perintah bash terhadap allowlist, segmen per segmen.
 *
 * Aturan lama (satu regex atas seluruh string + tolak jika ada `;|&`) membuat
 * `grep -n x f 2>&1 | head` ditolak walau `grep *` dan `head *` keduanya ada
 * di daftar. Hasilnya bukan keamanan tambahan, melainkan model yang buta repo:
 * 81 dari 98 penolakan allowlist pada sesi nyata berasal dari bentuk majemuk
 * yang seluruh tahapnya sudah diizinkan. Di sini setiap tahap diverifikasi
 * sendiri (pola + npx-safety), sementara bash-guard tetap memeriksa perintah
 * UTUH lebih dulu di pemanggil.
 */
// Deteksi subcommand berbahaya `sed` (GNU `e` = eksekusi shell, `w`/`W` = tulis
// berkas arbitrer, `r`/`R` = baca berkas arbitrer, `-f`/`--file` = skrip berkas).
// Dibuat terpisah agar flag sah (`sed -n '1,10p' f`, `sed -r -e 's/a/b/g' f`)
// tidak pernah false-positive.
function isDangerousSed(seg: string): boolean {
  if (!/^sed(?:\.exe)?\b/i.test(seg.trim())) return false
  // Tokenisasi sederhana yang menghormati kutip agar skrip `'...'`/`"..."` utuh.
  const toks: string[] = []
  let i = 0
  const s = seg.trim()
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break
    const q = s[i]
    if (q === "'" || q === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== q) {
        if (q === '"' && s[j] === "\\" && j + 1 < s.length) j++
        j++
      }
      toks.push(s.slice(i + 1, j))
      i = j < s.length ? j + 1 : j
    } else {
      let j = i
      while (j < s.length && !/\s/.test(s[j]!)) j++
      toks.push(s.slice(i, j))
      i = j
    }
  }
  const scripts: string[] = []
  let idx = 1
  let expectExpr = false
  while (idx < toks.length) {
    const t = toks[idx]!
    idx++
    if (expectExpr) {
      scripts.push(t)
      expectExpr = false
      continue
    }
    if (t === "-f" || t === "--file" || t.startsWith("--file=") || /^-[a-zA-Z]*f/.test(t)) {
      return true
    }
    if (t === "-e" || t === "--expression") {
      expectExpr = true
      continue
    }
    if (t.startsWith("--expression=")) {
      scripts.push(t.slice("--expression=".length))
      continue
    }
    if (t.startsWith("-") && t !== "-") continue
    if (scripts.length === 0) scripts.push(t)
    break
  }
  for (const script of scripts) {
    // Flag `e` atau `w` pada substitusi `s/a/b/e` / `s|a|b|w out`
    if (
      /(?:^|[;}\s])(?:\d*(?:,\d*)?\s*)?s([^\w\s])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[0-9gipI]*[ewW]/.test(
        script,
      )
    ) {
      return true
    }
    // Perintah standalone `e` (execute), `w`/`W` (write file), `r`/`R` (read file)
    for (const part of script.split(/[;\n]+/)) {
      const stripped = part
        .trim()
        .replace(
          /^(?:\/(?:\\.|[^/])*\/|\d+|\$)(?:\s*,\s*(?:\/(?:\\.|[^/])*\/|\d+|\$))?\s*!?\s*/,
          "",
        )
      if (/^(?:e(?:\s|$)|[wWrR]\s*\S)/.test(stripped)) return true
    }
  }
  return false
}

function decideBashCommand(cmd: string, list: readonly string[], root: string): BashListDecision {
  const cleaned = stripNeutralRedirections(cmd)
  if (!cleaned) return { ok: false, reason: "empty command", command: cmd }
  // Substitusi perintah / backtick = eksekusi kode di dalam argumen; tak pernah
  // lolos di mode ini (bash-guard juga menolaknya lebih dulu).
  if (/`|\$[()]/.test(cleaned))
    return { ok: false, reason: "shell expansion/chaining unsafe", command: cmd }
  // Redirection yang MASIH tersisa mengarah ke berkas. Menulis di dalam
  // workspace tetap sah (perilaku lama: `echo hi > local.txt`), tetapi target
  // di luar root / sensitif / state milik minicode ditolak — pemeriksaan yang
  // sama dengan bash-guard, dilakukan di sini karena segmen yang dicocokkan
  // tidak boleh membawa redirection. Sesudah diverifikasi, redirection dibuang
  // dari string agar `echo hi` dicocokkan sebagai bentuk perintahnya.
  let stripped = cleaned
  const hadFileRedirection = /[<>]/.test(cleaned)
  if (hadFileRedirection) {
    // `<` ikut diperlakukan sama (baca dari berkas): target di luar root tetap
    // ditolak, sedangkan `cat < file` di dalam workspace tidak boleh jadi
    // regresi dari aturan lama yang tidak memeriksa redirection sama sekali.
    const redirRe = /\d?[<>]{1,2}\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g
    for (const match of cleaned.matchAll(redirRe)) {
      const raw = match[1] ?? ""
      const target = raw.replace(/^(["'])(.*)\1$/, "$2")
      if (!target || target.startsWith("&") || target.startsWith("$"))
        return { ok: false, reason: "redirection unsafe", command: cmd }
      if (
        isCwdOutsideRoot(target, root) ||
        isRealPathOutsideRoot(target, root) ||
        isSensitive(target) ||
        // Keputusan owner 2026-11-23: `.minicode/` kini BOLEH ditulis lewat
        // redirect (selaras dengan bash-guard & file tool). SATU-SATUNYA yang
        // tetap dikunci = skrip hook (audit 2026-11-12) — string + realpath
        // supaya junction/symlink internal tak bisa menyamarkannya.
        isOwnedHook(target) ||
        isOwnedHookReal(target, root)
      )
        return { ok: false, reason: "redirection outside workspace", command: cmd }
    }
    // Operator dibuang, TARGET dipertahankan sebagai argumen. Kalau target ikut
    // dibuang, `cat < local.txt` menyisakan `cat` telanjang dan ditolak pola
    // `cat *` — over-block baru dari perubahan ini. Sebagai argumen biasa,
    // bentuk perintahnya tetap realistis dan pola lama tetap berlaku.
    stripped = cleaned.replace(redirRe, (_m, target: string) => ` ${target}`)
    // Sisa `<`/`>` (operator tak dikenali) tetap ditolak.
    if (/[<>]/.test(stripped)) return { ok: false, reason: "redirection unsafe", command: cmd }
  }
  const segments = splitShellSegments(stripped)
  // Defense-in-depth: même kalau pola allowlist terlalu longgar, verba mutasi
  // berbahaya tak pernah lolos di mode "paling ketat" (audit 2026-11-21).
  for (const seg of segments) {
    if (isDangerousShellVerb(seg))
      return { ok: false, reason: "mutating verb not allowed", command: cmd }
  }
  for (const seg of segments) {
    // `cd` di dalam workspace sah (model memakainya untuk monorepo); target di
    // luar root atau mengandung ekspansi env/tilde ditolak agar segmen berikutnya
    // tidak berjalan di luar jail.
    if (/^cd\b/i.test(seg)) {
      const rawTarget = seg.replace(/^cd\b/i, "").trim()
      // Flag `cd /d <dir>` pada cmd.exe: kupas `/d` agar target aslinya yang dicek.
      const withoutSwitch = rawTarget.replace(/^\/d\s+/i, "").trim()
      const target = stripCaretEscapes(withoutSwitch.replace(/^(["'])(.*)\1$/, "$2"))
      if (!target) return { ok: false, reason: "cd without target", command: cmd }
      if (/%[^%\s]+%/.test(target) || target.includes("$") || target.startsWith("~"))
        return { ok: false, reason: "jail: cd target with shell expansion", command: cmd }
      if (isCwdOutsideRoot(target, root) || isRealPathOutsideRoot(target, root))
        return { ok: false, reason: "jail: cwd outside workspace", command: cmd }
      continue
    }
    // `git branch` di allowlist untuk inspeksi cabang; flag mutasi/hapus
    // (`-D`, `-d`, `-f`, `-m`, `-M`, `--delete`, `--force`, `--move`) ditolak.
    if (
      /^git\s+branch\b/i.test(seg) &&
      /(?:^|\s)(?:-[a-z]*[dDfMm][a-z]*|--(?:delete|force|move|copy))\b/.test(seg)
    ) {
      return { ok: false, reason: "mutating git branch flag not allowed", command: seg }
    }
    // `npx -c` / `npm exec --call` mengeksekusi string shell arbitrer (setara `sh -c`).
    if (
      /^(?:npx|npm\s+exec)\s+(?:(?:-y|--yes|-q|--quiet|--no|--no-install|-p\s+\S+|--package(?:=|\s+)\S+)\s+)*(?:-c|--call)(?:=|\s|$)/i.test(
        seg,
      )
    ) {
      return { ok: false, reason: "npx/npm exec inline shell call not allowed", command: seg }
    }
    // `sed` pada allowlist hanya untuk baca/filter aman; `e`/`w`/`r`/`-f` ditolak.
    if (isDangerousSed(seg)) {
      return { ok: false, reason: "sed exec/file-io command not allowed", command: seg }
    }
    // `-i`/`--in-place` mengubah pembaca menjadi penulis; pola `sed -n *` punya
    // bentuk yang sama setelah normalisasi, jadi ditolak eksplisit di sini.
    // Carve-out agent-browser (keputusan owner 2026-11-23): `-i` di sini adalah
    // flag "interactive elements" milik `snapshot`, BUKAN in-place edit. Sengaja
    // dipersempit ke subcommand `snapshot` saja — carve-out `\bagent-browser\b`
    // yang lama membebaskan SEMUA segmen agent-browser (click/fill/eval/...),
    // padahal hanya snapshot yang memakai `-i` sebagai flag jinak. Tool lain
    // (sed/perl/...) tetap kena aturan lama — korpus gate:bash tak berubah.
    if (
      /(^|\s)(-i|--in-place)\b/.test(seg) &&
      !/^\s*(?:npx\s+)?agent-browser\s+snapshot\b/i.test(seg)
    )
      return { ok: false, reason: "in-place edit", command: cmd }
    const matched = list.filter((pat) => matchBashAllowlist(seg, pat))
    if (matched.length === 0) return { ok: false, reason: "no matching pattern", command: seg }
    // Package runner menjalankan kode arbitrer dari registry, jadi ia tetap
    // dilarang ber-redirection walau targetnya di dalam workspace — kontrak
    // lama `npx tsc > file` = deny, dipertahankan.
    if (
      matched.some((p) => /^(npx|npm exec|bun x|bun run)\b/i.test(p)) &&
      (!npmNpxSafe(seg) || hadFileRedirection)
    )
      return { ok: false, reason: "npm/npx unsafe", command: seg }
  }
  return { ok: true }
}

// F-APPROVAL-1: pratinjau diff ringkas + representatif (satu baris) untuk kartu
// approval. Dikomputasi di policy — satu-satunya lapisan yang BOLEH memakai
// scrubSecrets (view tidak boleh impor src/policy). Bentuknya dipilih per-tool
// agar menggambarkan operasi NYATA (bash → perintah, tulis/edit → path + isi
// baru, hapus/pindah → tujuan, commit → pesan), bukan "ringkasan pendek" fiktif.
// Semua teks dibasuh secret; kegagalan apa pun = undefined (preview hanyalah
// informasi tambahan, bukan jalur keputusan gate).
function buildDiffPreview(name: string, args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined
  const a = typeof args === "object" ? (args as Record<string, unknown>) : {}
  const str = (v: unknown): string => (typeof v === "string" ? v : "")
  const line = (v: unknown, max = 120): string => {
    const s = typeof v === "string" ? v : String(v ?? "")
    const first = s.split(/\r?\n/)[0] ?? ""
    return first.length > max ? `${first.slice(0, max)}…` : first
  }
  const text = (content: unknown): string => {
    if (typeof content === "string") return content
    if (Array.isArray(content))
      return content
        .map((c) =>
          typeof c === "string"
            ? c
            : c && typeof c === "object" && "text" in c
              ? String((c as { text?: unknown }).text ?? "")
              : "",
        )
        .filter(Boolean)
        .join("\n")
    if (content && typeof content === "object" && "text" in content)
      return String((content as { text?: unknown }).text ?? "")
    return ""
  }
  // Basuh secret SEKALI di jalur keluar — path pun bisa memuat token; preview
  // tak pernah boleh membocorkannya ke kartu UI.
  const out = (raw: string): string | undefined => {
    const s = scrubSecrets(raw.trim()).trim()
    return s ? s.slice(0, 500) : undefined
  }
  try {
    switch (name) {
      case "bash": {
        const cmd = (str(a.cmd) || str(a.command)).trim()
        return cmd ? out(`$ ${cmd}`) : undefined
      }
      case "write_file": {
        const p = str(a.path)
        const head = line(text(a.content), 160)
        return p ? out(`→ ${p}${head ? ` · ${head}` : ""}`) : undefined
      }
      case "edit": {
        const p = str(a.path)
        // Skema NYATA tool `edit` = `oldString`/`newString` (src/tools/edit.ts:133-142).
        const oldv = line(str(a.oldString ?? a.old_string), 140)
        const newv = line(str(a.newString ?? a.new_string), 140)
        const delta = `${oldv ? `\n  -${oldv}` : ""}${newv ? `\n  +${newv}` : ""}`
        return p ? out(`→ ${p}${delta}`) : undefined
      }
      case "apply_patch": {
        const p = str(a.path)
        // Skema NYATA tool `apply_patch` = `patches: [{search, replace}]`.
        const patches = Array.isArray(a.patches)
          ? (a.patches as { search?: unknown; replace?: unknown }[])
          : []
        if (patches.length > 0) {
          const first = patches[0] ?? {}
          const oldv = line(str(first.search), 140)
          const newv = line(str(first.replace), 140)
          const more = patches.length > 1 ? ` (+${patches.length - 1} blok)` : ""
          const delta = `${oldv ? `\n  -${oldv}` : ""}${newv ? `\n  +${newv}` : ""}`
          return p ? out(`→ ${p}${more}${delta}`) : undefined
        }
        const head = line(text(a.patch ?? a.diff))
        return p ? out(`→ ${p}${head ? ` · ${head}` : ""}`) : undefined
      }
      case "delete_file":
        return str(a.path) ? out(`- ${str(a.path)}`) : undefined
      case "move_file": {
        // v7.38: wire `path`/`destination`. Fallback lama dipertahankan hanya
        // untuk preview (bukan jalur keputusan) agar args historis tetap terbaca.
        const from = str(a.path ?? a.from)
        const to = str(a.destination ?? a.to)
        return from || to ? out(`${from} → ${to}`) : undefined
      }
      case "git_commit": {
        const m = line(str(a.message), 160)
        return m ? out(`commit ${m}`) : undefined
      }
      case "git_push": {
        const remote = str(a.remote) || "origin"
        const branch = str(a.branch) ? ` ${str(a.branch)}` : ""
        return out(`push ${remote}${branch}`)
      }
      default: {
        // Generic: name + ringkasan key=value yang dibasuh — jangan JSON mentah
        // (struktur/token yang tak dikenal scrub bisa bocor).
        const keys = ["path", "file", "query", "pattern", "prompt", "url", "dir", "id", "name"]
        const parts: string[] = []
        for (const k of keys) {
          const v = a[k]
          if (typeof v === "string" && v) parts.push(`${k}=${line(v, 80)}`)
          else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`)
        }
        return parts.length ? out(`${name} ${parts.join(" ")}`) : undefined
      }
    }
  } catch {
    return undefined
  }
}

export function createPermissionHandler(
  opts: {
    mode?: PermissionMode
    root?: string
    ask?: PermissionAsk
    /** Teruskan flag --allow-local-config: allowlist lokal hanya dibaca bila
     * operator opt-in (default deny — repo tak bisa memberi dirinya always). */
    allowLocalConfig?: boolean
    /** Hook observability persetujuan (Fase 1 presentasi): dipanggil di
     * samping callback keputusan, bukan sebagai pengganti. Tanpa hook =
     * perilaku gate identik seperti dulu. Hook tak boleh melempar ke gate. */
    onApprovalEvent?: ApprovalEventHook
    /**
     * [Area B · PROMPT 06] Penyimpanan binding persetujuan milik SESI.
     *
     * Dipakai untuk dua hal: (1) menyimpan sidik jari args + file target
     * SAAT preview dibuat (sebelum prompt), lalu (2) mengikatkannya ke
     * keputusan "allow". Batas eksekusi (tool wrapper) memverifikasi ulang
     * sidik jari file target dan menolak operasi yang basi.
     *
     * Tanpa store = perilaku lama persis (tanpa verifikasi tambahan).
     */
    approvalBindings?: ApprovalBindingStore
    /**
     * Tool Access Policy — set nama tool yang DIOTORISASI sesi ini (tool yang
     * terlihat/terdaftar, termasuk MCP runtime `server.tool` yang servernya
     * terkonfigurasi). Dipakai `auto` untuk membedakan MCP terotorisasi dari
     * MCP tak-dikenal/tak-terkonfigurasi: hanya nama bertitik yang ADA di set
     * ini yang boleh auto-allow. Absen = fail-closed (semua MCP bertitik deny).
     *
     * Kompatibilitas: jalur baru (composition root) memakai `hasAuthorizedTool`
     * (predikat LIVE). Opsi statis ini dipertahankan untuk pemanggil lama/test.
     * Bila keduanya ada, `hasAuthorizedTool` yang menang.
     */
    authorizedTools?: ReadonlySet<string> | null
    /**
     * Predikat otorisasi LIVE, dibaca per-call dari array tool tool-layer
     * (dimutasi setWorkMode/setPermissionMode) agar `visible === callable`
     * saat transisi mode. Snapshot statis bikin MCP baru tetap deny.
     * Absen = fail-closed (kecuali fallback `authorizedTools`).
     */
    hasAuthorizedTool?: (name: string) => boolean
    /**
     * Pembatas bash terpisah dari sumbu persetujuan: mode `auto` tetap membatasi
     * `bash` ke allow-list. Mode permission tetap `auto`/`ask` (lapis kapabilitas bash).
     */
    restrictBash?: boolean
    /** Pola bash tambahan dari config. Precedence: env MINICODE_BASH_ALLOWLIST
     * > config > default. (Dulu di-parse tapi tak dibaca, jadi edit config tak berefek.) */
    bashAllowlist?: readonly string[]
    /**
     * Callback `ask` non-TTY (ApprovalBroker daemon) HANYA untuk tool non-gated;
     * tool gated (delegate_task, git_commit, MCP) tetap menuntut TTY (fail-closed).
     */
    allowNonTtyAsk?: boolean
  } = {},
): PermissionHandler {
  const state = { mode: (opts.mode ?? "auto") as PermissionMode }
  const restrictBash = opts.restrictBash === true
  const allowNonTtyAsk = opts.allowNonTtyAsk === true
  const root = resolve(opts.root ?? cwd())
  const approvalBindings = opts.approvalBindings
  const askUser = opts.ask
  const allowLocal = opts.allowLocalConfig === true
  const authorizedTools = opts.authorizedTools
  const hasAuthorizedTool = opts.hasAuthorizedTool
  let allowlistCache: string[] | null = null
  // Persetujuan "always" sesi ini — in-memory, bukan dari disk. Tanpa ini,
  // jawaban always yang baru disimpan ke berkas lokal tak terlihat saat local
  // config nonaktif, dan user ditanya berulang untuk call yang sama.
  const sessionGrants: string[] = []
  // bash allowlist di-cache sekali (bukan baca env tiap panggilan)
  const envRaw = process.env.MINICODE_BASH_ALLOWLIST
  const envList = envRaw
    ? envRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
  // Tiga sumber dengan precedence jelas: env operator > config repo/user >
  // default bawaan. Config NARROW menggantikan daftar narrow, tetapi pada
  // daftar developer ia MENAMBAH — kalau menggantikan, satu entri config akan
  // mematikan seluruh ekosistem run/test yang sudah dipercaya.
  const configuredList =
    Array.isArray(opts.bashAllowlist) && opts.bashAllowlist.length > 0
      ? [...opts.bashAllowlist]
      : undefined
  const bashAllowlist = envList ?? configuredList ?? DEFAULT_BASH_ALLOWLIST
  const devBashAllowlist =
    envList ??
    (configuredList
      ? [...DEFAULT_DEV_BASH_ALLOWLIST, ...configuredList]
      : DEFAULT_DEV_BASH_ALLOWLIST)

  async function getAllowlist(): Promise<string[]> {
    if (allowlistCache) return allowlistCache
    try {
      const l = await loadAllowlist(root, { allowLocal: allowLocal })
      allowlistCache = [...l.allowed, ...sessionGrants]
      return allowlistCache
    } catch {
      return [...sessionGrants]
    }
  }

  function isGated(name: string): boolean {
    // Semua tool bertitik (MCP — terdaftar maupun tidak) = gated. Server jahat
    // tidak boleh mendapat auto-allow hanya karena namanya terdaftar.
    return GATED_TOOLS.has(name) || isMcpToolName(name)
  }

  // [NETWORK-READ-GATE] `web_fetch`/`web_search` termasuk READONLY_TOOL_NAMES,
  // tetapi baca jaringan adalah permukaan prompt-injection: responsnya menjadi
  // input model. Di DISCUSS, WorkMode wrapper yang memegang gerbang (memanggil
  // __promptGated) dan menandai base dengan enforceJail=true — base TIDAK boleh
  // prompt kedua kali. Di EXECUTE wrapper = identitas, jadi handler
  // readonly/plan inilah satu-satunya gerbang: headless/tanpa ask ⇒ deny
  // (fail-closed, sesuai kontrak NETWORK_READ_TOOL_NAMES di tool-contract.ts).
  async function gateNetworkRead(
    call: ToolCall,
    signal: AbortSignal | undefined,
    enforceJail: boolean,
  ): Promise<"allow" | "deny" | null> {
    if (!NETWORK_READ_TOOL_NAMES.has(call.name)) return null
    if (enforceJail) return null
    return promptAskOr(call, () => deny(call, "network read requires approval"), signal)
  }

  // [AGENT-BROWSER-AUTO-CONNECT] Owner 2026-11-23 mencabut `--auto-connect`:
  // flag itu menyambung ke browser/profil user (cookie asli), bukan profil
  // fresh seperti default. Deteksi SEMPIT — harus menyebut agent-browser DAN
  // flag auto-connect — supaya `npm install*` umum tak tersentuh. Dipakai di
  // bashDenyReason (semua mode, termasuk celah `npx *` yang mematch seluruh
  // string `npx agent-browser --auto-connect` lewat allowlist).
  function isAgentBrowserAutoConnect(cmd: string): boolean {
    const norm = normalizeCommand(cmd)
    const re = /\bagent-browser\b[\s\S]*--auto-connect\b/i
    return re.test(cmd) || re.test(norm)
  }

  // [AGENT-BROWSER-INSTALL-GATE] Owner 2026-11-23: `install` mengunduh/masang
  // browser → butuh KONFIRMASI USER, bukan allow bebas atau deny permanen.
  // Menyangar bentuk langsung (`agent-browser install`, boleh diawali npx/dlx)
  // maupun package manager (`npm|pnpm|yarn|bun install|i|add ... agent-browser`).
  // Cek bentuk mentah DAN ternormalisasi agar quoting/caret tidak melewatinya.
  function isAgentBrowserInstall(cmd: string): boolean {
    const candidates = [cmd.trim(), normalizeCommand(cmd).trim()]
    for (const c of candidates) {
      if (!/\bagent-browser\b/i.test(c)) continue
      if (/\bagent-browser\s+install(?:\s|$)/i.test(c)) return true
      if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|in)\b[\s\S]*\bagent-browser\b/i.test(c))
        return true
    }
    return false
  }

  // Gerbang ASK untuk install. Mengembalikan null bila perintah bukan install
  // (pemanggil lalu lanjut ke handler mode normal). Bila install: jalankan
  // bash-guard LEBIH DULU supaya persetujuan tak membuka perintah berbahaya
  // yang disisipkan (mis. `agent-browser install && rm -rf /`), lalu arahkan
  // ke promptAskOr — TTY + ask wajib, headless/tanpa ask ⇒ deny (fail-closed),
  // persetujuan "always" tercatat seperti jalur gated lain.
  async function gateAgentBrowserInstall(
    call: ToolCall,
    args: Record<string, unknown> | null,
    signal: AbortSignal | undefined,
  ): Promise<"allow" | "deny" | null> {
    if (call.name !== "bash") return null
    const cmd = (args?.cmd as string) ?? ""
    if (!isAgentBrowserInstall(cmd)) return null
    const br = bashDenyReason(cmd, bashEffectiveCwd(args))
    if (br) return deny(call, `bash-guard: ${br}`)
    return promptAskOr(call, () => deny(call, "agent-browser install requires approval"), signal)
  }

  // Alasan deny per-call untuk seam kernel describeDenial (audit #14):
  // check() TETAP mengembalikan "deny" polos (kontrak Decision + semua
  // assertion tak berubah); alasannya dibaca kernel tepat setelah deny via
  // describeDenial(call) sehingga observasi model menjadi actionable
  // ("permission denied: bash-guard: destructive rm") alih-alih retry buta.
  // Map dibatasi + hapus-saat-baca agar abort di tengah tak bocor memori.
  const denyReasons = new Map<string, string>()
  function noteDeny(call: ToolCall, reason: string): void {
    try {
      const id = (call as { id?: string } | null)?.id
      if (!id) return
      if (denyReasons.size > 500) denyReasons.delete(denyReasons.keys().next().value as string)
      denyReasons.set(id, reason.slice(0, 160))
    } catch {}
  }
  function deny(call: ToolCall, reason: string): "deny" {
    // [AUDIT-FIX] Perkaya HANYA alasan yang punya alternatif aman + counter
    // repeated. Keputusan check() tetap "deny" polos — ini diagnostik saja.
    noteDeny(call, adaptiveReason(call, reason))
    return "deny"
  }
  function takeDenyReason(call: ToolCall): string | undefined {
    try {
      const id = (call as { id?: string } | null)?.id
      if (!id) return undefined
      const r = denyReasons.get(id)
      denyReasons.delete(id)
      return r
    } catch {
      return undefined
    }
  }

  // [AUDIT-FIX / adaptive denial] Alasan deny adalah satu-satunya pengajaran
  // yang dilihat model (`permission denied: <reason>` di kernel). Teks lama
  // "no matching pattern" terlalu panjang untuk batas 160 karakter kernel —
  // ujung saran alternatifnya terpotong — dan tak punya counter, jadi model
  // mengulang `for %f`, `node -e`, `more` empat kali berturut-turut.
  //
  // Kunci counter = KELAS perintah (verba pertama), bukan argumen mentah:
  // variasi `for %f in (...)` tetap satu kelas, tapi `for` vs `node` beda.
  // Hanya DUA kelas yang diperkaya: allowlist miss & inline interpreter —
  // keduanya punya alternatif aman yang concrete. Alasan lain (destructive rm,
  // jail, dll.) sengaja dibiarkan apa adanya supaya kontraknya tak berubah.
  const adaptiveDenials = new Map<string, number>()
  function denialKey(prefix: string, cmd: string): string {
    const verb = cmd.trim().split(/\s+/)[0] ?? ""
    return `${prefix}:${
      verb
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "")
        .slice(0, 16) || "unknown"
    }`
  }
  function bumpDenial(key: string): number {
    const n = (adaptiveDenials.get(key) ?? 0) + 1
    // Sama seperti denyReasons: map dibatasi agar abort di tengah tak bocor memori.
    if (adaptiveDenials.size > 500)
      adaptiveDenials.delete(adaptiveDenials.keys().next().value as string)
    adaptiveDenials.set(key, n)
    return n
  }
  function shortDeniedCommand(raw: string): string {
    return scrubSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 40)
  }
  function adaptiveReason(call: ToolCall, reason: string): string {
    if (call.name !== "bash") return reason
    if (reason.startsWith("allowlist: no matching pattern")) {
      // Ambil SEGMEN yang ditolak dari alasan call-site (bisa beda dari cmd
      // penuh saat perintah majemuk) supaya saran menyebut perintah yang benar.
      const quoted = reason.match(/for "([^"]*)"/)?.[1] ?? ""
      const cmd = shortDeniedCommand(quoted)
      const n = bumpDenial(denialKey("allowlist", quoted))
      return n === 1
        ? `allowlist: no matching pattern for "${cmd}" — read_file/write_file/edit or dir /b / Get-Content; --allow-all`
        : `allowlist: no matching pattern #${n} for "${cmd}" — STOP retry; read_file/write_file/edit or dir /b / Get-Content; --allow-all`
    }
    if (reason.includes("inline interpreter code")) {
      const n = bumpDenial("bash:inline-interpreter")
      return n === 1
        ? "bash-guard: inline interpreter code — write a script file then run node file.js, or use read_file; -e/-c never allowed"
        : `bash-guard: inline interpreter code (#${n}) — STOP retrying -e/-c; write a file and run node file.js or use read_file`
    }
    return reason
  }
  // Guard & shell WAJIB memakai basis cwd sama: guard cek root/link/secret, shell
  // baca root/sub/link/secret → symlink lolos. args.cwd sudah dijail di check().
  // Fail-closed: resolusi gagal → root, bukan mengizinkan.
  function bashEffectiveCwd(args: unknown): string {
    const rel = (args as { cwd?: unknown } | null)?.cwd
    if (typeof rel === "string" && rel) {
      try {
        return resolve(root, rel)
      } catch {
        return root
      }
    }
    return root
  }
  function bashDenyReason(cmd: string, effectiveCwd: string): string | null {
    if (!cmd.trim()) return "empty command"
    // [AGENT-BROWSER-AUTO-CONNECT] Deny rule sempit, jalan di SEMUA mode
    // (allowlist / ask / auto / allow-all) sebelum allowlist dipertimbangkan.
    // Menutup celah `npx agent-browser --auto-connect`: pola `"npx *"` tetap
    // mencocokkannya di allowlist setelah entri eksplisit dicabut.
    if (isAgentBrowserAutoConnect(cmd))
      return "agent-browser --auto-connect is not allowed (use a fresh browser profile)"
    try {
      const v = inspectBashCommand(cmd, effectiveCwd, root)
      return v.denied ? (v.reason ?? "blocked command") : null
    } catch {
      // Fail-closed: guard melempar = bukan bukti aman; `return null` dulu
      // menjadikan error internal ALLOW — satu bug membuka seluruh eksekusi.
      return "bash-guard internal error — command refused (fail-closed)"
    }
  }
  function codeRunMissingSandbox(): boolean {
    const sb = process.env.MINICODE_SANDBOX ?? ""
    return sb !== "os" && sb !== "docker" && sb !== "bwrap" && sb !== "seatbelt"
  }

  // Jawaban prompt yang dilaporkan ke observability. "headless" = jalur
  // tanpa prompt (mantan early-return noTty): pemanggil memetakan ke
  // keputusan deny-nya sendiri agar alasan deny tak berubah.
  // "stale" = user menyetujui, tapi target berubah selama prompt → fail-closed.
  type GatedAnswer = "allow" | "deny" | "always" | "aborted" | "headless" | "stale"

  // Counter id persetujuan per handler (= per sesi): deterministik dan
  // test-friendly (tak perlu randomUUID untuk observability).
  let approvalCounter = 0

  function saveAlways(call: ToolCall): Promise<void> {
    // [AGENT-CONTROL-4] Satu ASK = satu delegasi. Broker yang di-inject bisa
    // mengembalikan "always" walau view tak menawarkannya; menyimpannya akan
    // membuat delegasi identik berikutnya lolos tanpa izin baru. Jadi no-op.
    if (call.name === "delegate_task") return Promise.resolve()
    // Simpan kunci PENUH (tanpa slice) agar simetris dengan matchAllowlist.
    // Arg raksasa (>2KB JSON, mis. write_file 1MB) tidak disimpan sama sekali
    // (fail-closed, minta persetujuan tiap kali) — kalau tidak allowlist.json
    // membengkak dan "always" menjadi blanket-allow untuk konten apa pun.
    if (!canPersistAlways(call.args)) return Promise.resolve()
    const argsJson = JSON.stringify(call.args)
    const rawKey = `${call.name}:${argsJson}`
    // Bila argumen mengandung `*`, bungkus dengan prefix `exact:` agar
    // matchAllowlist tidak mengompilasi `*` menjadi wildcard regex `.*`.
    const key = rawKey.includes("*") ? `exact:${rawKey}` : rawKey
    if (!sessionGrants.includes(key)) sessionGrants.push(key)
    allowlistCache = null
    // [AUDIT-FIX #2] Grant "always" untuk TOOL GATED tinggal di memori sesi
    // (sessionGrants), TIDAK dipersist ke allowlist. Allowlist — baik global
    // maupun repo-lokal — tidak ter-scope ke root/sesi yang sedang aktif:
    // satu klik "always" pada call gated tanpa argumen (mis. `git_commit:{}`,
    // `ask_user:{}`) akan jadi blanket grant yang berlaku di SETIAP sesi dan
    // cwd berikutnya = persetujuan palsu lintas-sesi. Tool gated adalah
    // capability sensitif (commit/push/delegasi/MCP) yang approval-nya wajib
    // segar per sesi. Bash/tool non-gated sengaja TETAP dipersist — perilaku
    // lama ini mungkin diandalkan operator untuk pola perintah rutin — jadi
    // hanya `isGated(name)` yang dikecualikan dari penulisan ke disk.
    if (isGated(call.name)) return Promise.resolve()
    // Eksplisit `allowLocalConfig === false` (sesi runtime tanpa opt-in) menyimpan Always ke global
    // agar tidak mengotori repo, sementara pemanggil langsung tanpa flag mempertahankan K-1 lokal.
    return saveAllowlist(
      key,
      root,
      opts.allowLocalConfig === false ? { global: true } : undefined,
    ).catch(() => {})
  }

  // data-driven: tiap mode = satu fungsi keputusan (tanpa cabang saling tumpang tindih).
  // Param ketiga = signal turn (opsional): prompt yang belum terjawab saat
  // sesi dibatalkan harus kalah oleh abort (deny), bukan menunggu jawaban.
  const handlers: Record<
    PermissionMode,
    (
      call: ToolCall,
      args: Record<string, unknown> | null,
      signal?: AbortSignal,
      enforceJail?: boolean,
    ) => Promise<"allow" | "deny">
  > = {
    "allow-all": async () => "allow",
    // "unrestricted" ditangani di awal check() (short-circuit sebelum jail),
    // jadi entry ini tak pernah ter-capai saat runtime — ada demi kelengkapan
    // Record<PermissionMode, …> (TS exhaustiveness).
    unrestricted: async () => "allow",
    readonly: async (call, _args, signal, enforceJail) => {
      const gated = await gateNetworkRead(call, signal, enforceJail === true)
      if (gated !== null) return gated
      return READONLY_TOOLS.has(call.name) ? "allow" : deny(call, "read-only mode")
    },
    // Plan = readonly + tiga perkecualian aman (PLAN_EXTRA_TOOL_NAMES):
    // todo_write (artefak rencana .minicode/plans, bukan file workspace),
    // delegate_task (penelahan rencana, bukan eksekusi — dipaksa explore/
    // read-only di task.ts bila parent plan/readonly, permission hanya membuka
    // gerbangnya), dan submit_result (singleton memori-proses untuk exec --json).
    plan: async (call, _args, signal, enforceJail) => {
      const gated = await gateNetworkRead(call, signal, enforceJail === true)
      if (gated !== null) return gated
      return READONLY_TOOLS.has(call.name) || PLAN_EXTRA_TOOL_NAMES.has(call.name)
        ? "allow"
        : deny(call, "plan mode")
    },
    allowlist: async (call, args) => {
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd, bashEffectiveCwd(args))
        if (br) return deny(call, `bash-guard: ${br}`)
        const decision = decideBashCommand(cmd, bashAllowlist, root)
        if (decision.ok) return "allow"
        // Alasan actionable (keluhan eval: "no matching pattern" tanpa jalan
        // keluar membuat model retry buta): tulis/baca file = pakai tool file
        // terjail; shell penuh = operator pilih --allow-all/--sandbox docker.
        if (decision.reason === "no matching pattern")
          // [AUDIT-FIX #3] command mentah bisa memuat kredensial (mis. token di
          // argumen). Alasan deny ini sampai ke model DAN log — scrub dulu,
          // sebelum dipotong, agar secret tak terekho bebas ke permukaan itu.
          // [AUDIT-FIX / adaptive] Teks lengkap + counter dirakit adaptiveReason;
          // di sini cukup penanda + segmen yang ditolak.
          return deny(
            call,
            `allowlist: no matching pattern for "${scrubSecrets(decision.command).slice(0, 80)}"`,
          )
        return deny(call, `allowlist: ${decision.reason}`)
      }
      if (isGated(call.name)) return deny(call, "allowlist: gated tool")
      if (FILE_WRITE_TOOLS.has(call.name)) return "allow"
      if (INTERNAL_WRITE_TOOLS.has(call.name)) return "allow"
      return READONLY_TOOLS.has(call.name) ? "allow" : deny(call, "allowlist: not allowed here")
    },
    ask: async (call, args, signal) => {
      if (READONLY_TOOLS.has(call.name)) return "allow"
      // Bookkeeping internal tidak menyentuh workspace: todo list dan kontrol
      // job yang izinnya sudah diberikan saat `bash` dijalankan. Meminta
      // konfirmasi untuk ini hanya melelahkan tanpa menambah keamanan.
      if (NO_PROMPT_TOOLS.has(call.name)) return "allow"
      // Hard-deny (sandbox requirement & bash-guard) WAJIB berjalan SEBELUM
      // allowlist agar entri allowlist / grant "always" tidak pernah mem-bypass
      // zirah bash-guard atau persyaratan sandbox code_run.
      if (call.name === "code_run" && codeRunMissingSandbox()) {
        // Tolak sebelum prompt [y/n] agar operator tidak diminta menyetujui
        // tool yang langsung gagal karena MINICODE_SANDBOX belum aktif.
        return deny(call, "code_run needs sandbox (os|docker)")
      }
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd, bashEffectiveCwd(args))
        if (br) return deny(call, `bash-guard: ${br}`)
      }
      const list = await getAllowlist()
      // [AGENT-CONTROL-4] Grant "always" untuk delegate_task TIDAK boleh
      // dipakai ulang — meski broker menyuntik jawaban always (lihat saveAlways).
      if (call.name !== "delegate_task" && matchAllowlist(call, list)) return "allow"
      if (call.name !== "bash" && isGated(call.name)) {
        return await promptAskOr(call, () => deny(call, "gated approval unavailable"), signal)
      }
      const ans = await gatedPrompt(call, signal, askUser, false)
      if (ans === "headless") return "deny"
      // [Area B] "stale" = target berubah saat prompt → deny; alasan sudah
      // dicatat di `deny()` (jangan timpa dengan "declined by user").
      if (ans === "stale") return "deny"
      if (ans === "always") {
        await saveAlways(call)
        return "allow"
      }
      return ans === "allow" ? "allow" : "deny"
    },
    // AUTO = otonomi penuh. Selama tool diotorisasi oleh Tool Access Policy dan
    // scope mengizinkan, jalankan TANPA prompt persetujuan rutin. Ini berbeda
    // dari `ask` (di bawah) yang menahan tulis/eksekusi untuk izin manusia.
    //
    // Keputusan desain (mode-architecture recon): `gatedByDefault` TIDAK lagi
    // berarti "auto wajib prompt". Tool gated (git_commit, delegate_task,
    // mcp_call/read/prompt) adalah capability yang WAJIB Otorisasi — di ASK
    // mereka butuh izin manusia, tetapi di AUTO mereka jalan bila authorized.
    // Hard-deny (jail/owned-state/bash-guard) tetap berlaku di semua jalur.
    auto: async (call, args, _signal) => {
      if (READONLY_TOOLS.has(call.name)) return "allow"
      // ask_user = interaksi-user, bukan eksekusi. Di AUTO dilarang deterministik
      // (BLOCKED) supaya model memakai asumsi default sendiri — jangan biarkan
      // pergantian tanya-jawab rutin mengubah AUTO jadi ASK.
      if (call.name === "ask_user")
        return deny(call, "ask_user unavailable in AUTO (autonomous mode)")
      // Tool MCP bertitik: hanya diotorisasi bila terdaftar di sesi (server
      // terkonfigurasi). Tak dikenal/tak terkonfigurasi = deny, bukan prompt
      // (AUTO tak boleh bertanya sebagai jalan pintas hard-restriction).
      if (isMcpToolName(call.name)) {
        // v7.33: utamakan predikat LIVE (berasal dari array tool yang dimutasi
        // tool-layer saat Shift+Tab). Fallback ke set statis untuk kompatibilitas
        // pemanggil lama; keduanya absen = fail-closed deny.
        const authorized = hasAuthorizedTool
          ? hasAuthorizedTool(call.name)
          : (authorizedTools?.has(call.name) ?? false)
        if (authorized) return "allow"
        return deny(call, "MCP tool not configured/authorized")
      }
      // Capability gated (git_commit, delegate_task, mcp_call/read/prompt):
      // otonom di AUTO bila authorized. Scope dijaga tool-nya sendiri + jail
      // (git_commit: path/staged dijail; delegate: anak ter-ceiling WorkMode).
      if (GATED_TOOLS.has(call.name)) return "allow"
      if (FILE_WRITE_TOOLS.has(call.name)) return "allow"
      if (INTERNAL_WRITE_TOOLS.has(call.name)) return "allow"
      if (call.name === "code_run") {
        if (codeRunMissingSandbox()) return deny(call, "code_run needs sandbox (os|docker)")
        return "allow"
      }
      if (call.name === "bash") {
        const cmd = (args?.cmd as string) ?? ""
        const br = bashDenyReason(cmd, bashEffectiveCwd(args))
        if (br) return deny(call, `bash-guard: ${br}`)
        // restrictBash: bash hanya boleh pola allow-list (fallback no-sandbox).
        // Pakai daftar DEVELOPER (lebih luas) — sesi trusted di mesin sendiri,
        // bukan task tak-terpercaya (yang memakai daftar narrow via --allowlist).
        if (restrictBash) {
          const decision = decideBashCommand(cmd, devBashAllowlist, root)
          if (!decision.ok) {
            if (decision.reason === "no matching pattern")
              // [AUDIT-FIX #3] Sama seperti cabang allowlist: secret di command
              // tak boleh bocor lewat alasan deny ke model/log (fail-closed).
              // [AUDIT-FIX / adaptive] Penanda + segmen; saran dirakit di deny().
              return deny(
                call,
                `allowlist: no matching pattern for "${scrubSecrets(decision.command).slice(0, 80)}"`,
              )
            return deny(call, `allowlist: ${decision.reason}`)
          }
        }
        return "allow"
      }
      return deny(call, "not authorized in AUTO mode")
    },
  }

  const returned = {
    async check(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      const earlyArgs = call.args as Record<string, unknown> | null
      // Cancellation sebelum eksekusi mengalahkan segalanya: approval yang
      // datang terlambat (atau sesi yang sudah detach) tidak boleh membuka
      // gerbang. Kernel meneruskan signal turn di deps (executor kernel).
      const signal = (_deps as { signal?: AbortSignal } | null | undefined)?.signal
      if (signal?.aborted) return "deny"

      // `unrestricted` = full akses di EXECUTE. Saat dipanggil dari ceiling
      // DISCUSS (`enforceJail = true`), jail path/sensitive tetap ditegakkan
      // sebelum mengizinkan operasi baca di dalam workspace (INV-WM1).
      const enforceJail =
        (_deps as { enforceJail?: boolean } | null | undefined)?.enforceJail === true
      if (state.mode === "unrestricted" && !enforceJail) return "allow"

      // Jail groups dari TOOL_CONTRACTS (tool tulis baru otomatis masuk, tak fail-open).
      // Jail mendahului allow-all, realpath-based: symlink keluar tetap tertangkap.
      if (FILE_JAIL_TOOL_NAMES.has(call.name)) {
        // `move_file` dua ujung (path+destination); fallback from/to = kompatibilitas
        // historis. Fail-closed: dua ujung wajib ada & di dalam root.
        const targets =
          call.name === "move_file"
            ? [
                (earlyArgs?.path as string) ?? (earlyArgs?.from as string) ?? "",
                (earlyArgs?.destination as string) ?? (earlyArgs?.to as string) ?? "",
              ]
            : [(earlyArgs?.path as string) ?? ""]
        if (call.name === "move_file" && (!targets[0] || !targets[1])) return "deny"
        for (const p of targets) {
          if (!p) return "deny"
          if (isRealPathOutsideRoot(p, root)) return deny(call, "jail: outside workspace")
          if (isSensitive(p) || isSensitiveReal(p, root)) return deny(call, "jail: sensitive file")
        }
      }
      if (LSP_FILE_JAIL_TOOL_NAMES.has(call.name)) {
        // Semua tool LSP (termasuk lsp_rename) memakai `path`.
        const f = (earlyArgs?.path as string) ?? (earlyArgs?.file as string) ?? ""
        if (f && isRealPathOutsideRoot(f, root)) return deny(call, "jail: outside workspace")
        if (f && (isSensitive(f) || isSensitiveReal(f, root)))
          return deny(call, "jail: sensitive file")
      }
      const cwdArg = (earlyArgs?.cwd as string) ?? ""
      if (cwdArg && CWD_JAIL_TOOL_NAMES.has(call.name)) {
        if (isCwdOutsideRoot(cwdArg, root) || isRealPathOutsideRoot(cwdArg, root))
          return deny(call, "jail: cwd outside workspace")
      }
      // git_commit: path yang di-stage juga dijail, bukan hanya cwd.
      if (call.name === "git_commit" && Array.isArray(earlyArgs?.paths)) {
        for (const p of earlyArgs.paths as unknown[]) {
          if (typeof p !== "string") continue
          if (isRealPathOutsideRoot(p, root)) return deny(call, "jail: outside workspace")
          if (isSensitive(p) || isSensitiveReal(p, root)) return deny(call, "jail: sensitive file")
        }
      }
      // KEPUTUSAN OWNER 2026-11-23: `.minicode/` kini BOLEH ditulis agen/model,
      // termasuk lewat file tool (write/edit/patch/move/delete). Blok owned-state
      // lama dicabut — cek NAMA tak pernah cukup (`test-write.txt` dulu lolos),
      // tapi sekarang memang tidak ada lagi daftar nama yang perlu dijaga.
      // Pemeriksaan jail workspace (`isRealPathOutsideRoot`) & rahasia
      // (`isSensitive`, termasuk `.minicode/auth.json`) di atas TETAP berlaku.
      // Model tetap harus hati-hati: jangan menimpa sessions.db/config sembarangan.
      //
      // SATU-SATUNYA kunci yang dipertahankan: `.minicode/hooks/**` (audit
      // 2026-11-12) — hook dieksekusi otomatis via scan direktori saat
      // MINICODE_HOOKS=1, jadi menanam skrip = kode jalan di luar permission.
      // Operator membuat hook di luar sesi. Kunci ganda (string + realpath)
      // menutup junction `linkdir → .minicode` yang menyamarkan target hook.
      if (FILE_WRITE_TOOL_NAMES.has(call.name)) {
        const rawTargets =
          call.name === "move_file"
            ? ([
                (earlyArgs?.path as string) ?? (earlyArgs?.from as string) ?? "",
                (earlyArgs?.destination as string) ?? (earlyArgs?.to as string) ?? "",
              ] as const)
            : ([(earlyArgs?.path as string) ?? ""] as const)
        if (rawTargets.some((p) => p !== "" && (isOwnedHook(p) || isOwnedHookReal(p, root)))) {
          return deny(call, "jail: owned state")
        }
      }

      const mode = state.mode
      if (mode === "unrestricted") return "allow"
      // [AGENT-BROWSER-INSTALL-GATE] Jalan SEBELUM cabang mode (termasuk AUTO
      // yang bash-nya hanya lewat deny-list) supaya install selalu butuh
      // konfirmasi. Mode `unrestricted` sengaja dikecualikan di atas — itu
      // sesi full-trust, bukan permukuan agen yang diatur kebijakan ini.
      // Mengembalikan null = bukan install → lanjut ke handler mode normal
      // (bash-guard + allowlist tetap berjalan, tak ada prompt ganda).
      const installVerdict = await gateAgentBrowserInstall(call, earlyArgs, signal)
      if (installVerdict !== null) return installVerdict
      if (mode === "allow-all") {
        // allow-all tetap menolak bash berbahaya — izin penuh bukan berarti
        // mengizinkan `rm -rf /` atau fork bomb. Yang dicek di sini FULL
        // inspectBashCommand (bukan sebagian), sama seperti mode lain.
        if (call.name === "bash") {
          const cmd = (earlyArgs?.cmd as string) ?? ""
          // allow-all + cmd kosong = allow (perilaku lama dipertahankan).
          if (cmd.trim()) {
            const br = bashDenyReason(cmd, bashEffectiveCwd(earlyArgs))
            if (br) return deny(call, `bash-guard: ${br}`)
          }
        }
        return "allow"
      }

      return handlers[state.mode](call, earlyArgs, signal, enforceJail)
    },
    // Kontrol mode runtime (Shift+Tab TUI). Kedua method dulu hanya di type-cast,
    // sehingga pemanggil no-op/TypeError dan mode tak pernah berubah.
    __setMode(m: PermissionMode): void {
      state.mode = m
      allowlistCache = null
    },
    __getMode(): PermissionMode {
      return state.mode
    },
    __getRestrictBash(): boolean {
      return restrictBash
    },
    // Seam kernel describeDenial: alasan deny terakhir call ini (dicatat
    // check() via deny()). Hapus-saat-baca; tak ada catatan = undefined =
    // pesan deny polos seperti dulu.
    describeDenial(call: ToolCall): string | undefined {
      return takeDenyReason(call)
    },
    // Seam P0.2 (Q2): gerbang approval paksaan untuk network read (`web_fetch`,
    // `web_search`) saat WorkMode PLAN aktif. Memakai jalur gated yang SAMA
    // (`promptAskOr`: TTY + ask wajib, allowlist grant berlaku, headless = deny)
    // sehingga observability persetujuan & alasan deny tetap kanonik.
    async __promptGated(call: ToolCall, _deps?: unknown): Promise<"allow" | "deny"> {
      const signal = (_deps as { signal?: AbortSignal } | null | undefined)?.signal
      if (signal?.aborted) return "deny"
      return promptAskOr(call, () => deny(call, "gated approval unavailable"), signal)
    },
  }
  return returned as unknown as PermissionHandler & {
    __setMode(m: PermissionMode): void
    __getMode(): PermissionMode
    __getRestrictBash(): boolean
    describeDenial(call: ToolCall): string | undefined
    __promptGated(call: ToolCall, deps?: unknown): Promise<"allow" | "deny">
  }

  // Balapan prompt melawan abort: jawaban yang tiba SETELAH sesi dibatalkan
  // tidak boleh membuka gerbang (late approval = deny). Tanpa ini, user yang
  // menekan [y] sepersekian detik setelah Ctrl+C tetap mengeksekusi tool.
  function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | "aborted"> {
    if (!signal) return p
    if (signal.aborted) return Promise.resolve("aborted")
    return Promise.race([
      p,
      new Promise<"aborted">((res) =>
        signal.addEventListener("abort", () => res("aborted"), { once: true }),
      ),
    ])
  }

  function emitApprovalSafe(e: ApprovalHookEvent): void {
    try {
      opts.onApprovalEvent?.(e)
    } catch {
      // Observability tak boleh menggagalkan gate.
    }
  }

  // Satu-satunya wrapper prompt: emit requested + settled untuk semua jalur
  // (gated & inline ask). Allowlist-hit tak lewat sini (policy, bukan persetujuan).
  // `requireTTY` hanya untuk jalur GATED: memaksa TTY di ask non-gated membalik
  // keputusan headless-injected-ask.
  async function gatedPrompt(
    call: ToolCall,
    signal: AbortSignal | undefined,
    ask: PermissionAsk | undefined,
    requireTTY: boolean,
  ): Promise<GatedAnswer> {
    // [AGENT-CONTROL-2] Carve-out daemon (allowNonTtyAsk) HANYA untuk tool
    // non-gated (mis. web_fetch yang memang lewat ApprovalBroker). Tool gated
    // — terutama delegate_task — tetap butuh terminal: broker yang di-inject
    // tak boleh mengubah non-TTY jalur persetujuan (docs/AGENTS.md:8 dan
    // docs/exec.md: delegasi non-TTY ditolak fail-closed). Tanpa pagar ini,
    // askUser dari daemon bisa menyetujui delegasi tanpa operator hadir dan
    // menggandakan efek samping anak.
    const brokerReady = allowNonTtyAsk && !isGated(call.name)
    const ttyReady = brokerReady || Boolean(process.stdin.isTTY)
    const headless = signal?.aborted === true || !ask || (requireTTY && !ttyReady)
    const approvalId = `ap_${++approvalCounter}`
    const callInfo = { id: call.id, name: call.name, args: call.args }
    // F-APPROVAL-1: tier risiko efek samping dari kontrak tool — absen/kontrak
    // tak dikenal = UNKNOWN (jelas, bukan tebakan). Tidak mengubah keputusan gate.
    const riskTier = contractForTool(call.name)?.sideEffectTier ?? "UNKNOWN"
    // F-APPROVAL-1: pratinjau diff yang REPRESENTATIF (per-tool) + sudah
    // di-scrub secret — dihitung di policy karena hanya policy yang boleh
    // memanggil scrubSecrets. Absen = tidak ada preview yang layak, kartu UI
    // tetap menampilkan ringkasan args yang ada (fallback tak berubah).
    const diffPreview = buildDiffPreview(call.name, call.args)
    // [Area B · PROMPT 06] TANGKAP sidik jari operasi SEBELUM prompt. Ini
    // "apa yang dilihat user": argumen + isi file target pada saat preview
    // dibuat. Diambil sebelum `ask` karena `ask` bisa mengubah dunia (user
    // sendiri atau proses lain bisa menulis file sementara prompt terbuka) —
    // kalau sidik jari diambil SETELAH prompt, kita memverifikasi state yang
    // tidak pernah dilihat user.
    const capturedBinding: ApprovalBinding | null = approvalBindings
      ? captureApprovalBinding(call.name, call.args, root, call.id)
      : null
    emitApprovalSafe({
      kind: "requested",
      approvalId,
      call: callInfo,
      via: headless ? "system" : "prompt",
      riskTier,
      ...(diffPreview ? { diffPreview } : {}),
    })
    let ans: "allow" | "deny" | "always" | "aborted"
    try {
      // Headless = tanpa prompt (ask tak tersedia / [gated: bukan TTY] / sudah
      // abort): jawaban "deny" tanpa memanggil view — pemanggil memetakan ke
      // keputusan deny-nya sendiri agar alasan deny tak berubah.
      // F-APPROVAL-1: tier + diff diteruskan ke view agar kartu approval
      // menunjukkan bukti yang SAMA dengan yang user setujui (bukan ringkasan
      // terpisah yang bisa menyimpang dari operasi yang benar dieksekusi).
      ans =
        headless || !ask
          ? "deny"
          : await raceAbort(
              ask({
                id: call.id,
                name: call.name,
                args: call.args,
                riskTier,
                diffPreview,
                // [AGENT-CONTROL-4] `delegate_task` tak pernah menawarkan
                // "Always" — tiap delegasi butuh persetujuan tersendiri.
                canAlways: canAlwaysForCall(call),
                ...(signal ? { signal } : {}),
              }),
              signal,
            )
    } catch (e) {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "deny", by: "system", reason: "prompt-error" },
      })
      throw e
    }
    if (ans === "aborted") {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "cancelled", by: "system", reason: "parent-aborted" },
      })
      return ans
    }
    if (headless) {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: {
          decision: "deny",
          by: "system",
          reason: signal?.aborted
            ? "parent-aborted"
            : !ask
              ? "no-ask"
              : requireTTY && !ttyReady
                ? "headless"
                : "no-ask",
        },
      })
      return "headless"
    }
    if (ans === "always" || ans === "allow") {
      // [Area B · PROMPT 06] Verifikasi lapis-1: persetujuan diberikan user
      // untuk state file TERTENTU. Bila target berubah selama prompt
      // terbuka, operasi yang disetujui ≠ operasi yang akan dieksekusi →
      // FAIL-CLOSED: tolak, jangan jalankan.
      //
      // Verifikasi ini terjadi SEBELUM intent jurnal ditulis (barrier efek
      // ada di lapisan app), jadi jurnal tak pernah memuat intent untuk
      // operasi yang memang ditolak.
      if (capturedBinding) {
        const verdict = verifyApprovalBinding(capturedBinding)
        if (verdict.kind === "stale") {
          emitApprovalSafe({
            kind: "settled",
            approvalId,
            call: callInfo,
            outcome: { decision: "deny", by: "system", reason: "approval-stale" },
          })
          deny(call, `approval stale: ${verdict.reason}`)
          return "stale"
        }
      }
    }
    if (ans === "always") {
      emitApprovalSafe({
        kind: "settled",
        approvalId,
        call: callInfo,
        outcome: { decision: "allow-always", by: "user" },
      })
      // [Area B] Grant dibuat untuk call yang SEDANG berjalan: allowlist
      // membuat call berikutnya lolos tanpa prompt, jadi tak ada bukti baru
      // yang bisa diverifikasi — call ini masih terikat ke bukti yang user
      // benar-benar setujui.
      if (capturedBinding) approvalBindings?.grant(capturedBinding)
      return ans
    }
    emitApprovalSafe({
      kind: "settled",
      approvalId,
      call: callInfo,
      outcome:
        ans === "allow"
          ? { decision: "allow", by: "user" }
          : { decision: "deny", by: "user", reason: "declined" },
    })
    // [Area B] Izin berlaku untuk operasi yang disetujui saja.
    if (ans === "allow" && capturedBinding) approvalBindings?.grant(capturedBinding)
    return ans
  }

  async function promptAskOr(
    call: ToolCall,
    noTty: () => "deny",
    signal?: AbortSignal,
  ): Promise<"allow" | "deny"> {
    if (signal?.aborted) return noTty()
    // Headless (tanpa ask / non-TTY) TETAP lewat gatedPrompt agar
    // requested+settled ter-emit (observability Fase 1); keputusan deny
    // dipetakan pemanggil seperti early-return noTty lama. TTY wajib di
    // jalur GATED (requireTTY=true) — pola lama promptAskOr.
    if (!askUser || (!allowNonTtyAsk && !process.stdin.isTTY)) {
      await gatedPrompt(call, signal, askUser, true)
      return noTty()
    }
    const list = await getAllowlist()
    // [AGENT-CONTROL-4] Sama dengan handler `ask`: allowlist tak boleh
    // men-short-circuit delegasi, atau "always" sekali klik berlaku selamanya.
    if (call.name !== "delegate_task" && matchAllowlist(call, list)) return "allow"
    const ans = await gatedPrompt(call, signal, askUser, true)
    if (ans === "headless") return noTty()
    if (ans === "aborted") return "deny"
    // [Area B] "stale" = target berubah saat prompt → deny; alasan sudah
    // dicatat di `deny()` (jangan timpa dengan "declined by user").
    if (ans === "stale") return "deny"
    if (ans === "always") {
      await saveAlways(call)
      return "allow"
    }
    return ans === "allow" ? "allow" : deny(call, "declined by user")
  }
}
