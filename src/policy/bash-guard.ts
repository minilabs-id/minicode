// Analisis perintah shell untuk keputusan permission.
//
// Kenapa modul terpisah? Denylist regex lama diterapkan ke string MENTAH,
// sehingga trivially dilewati oleh hal-hal yang shell anggap setara:
//
//   cat .e""nv          → shell membaca .env, regex melihat `.e""nv`
//   X=.env; cat $X      → shell membaca .env, regex tak pernah melihat ".env"
//   p=python3; $p -c 1  → interpreter jalan, regex tak melihat "python3 -c"
//   node --eval "1"     → sama dengan -e, tapi hanya `-e` yang di-regex
//
// Pendekatan di sini: NORMALISASI dulu (buang quote pemisah kata, substitusi
// assignment variabel sederhana), lalu periksa. Ini menutup seluruh kelas
// bypass, bukan satu-satu polanya.
//
// Batasan yang harus jujur: ini tetap analisis statis atas bahasa yang
// Turing-complete. Command substitution dinamis (`$(curl ...)`), aritmetika,
// dan indirection berlapis tak bisa diselesaikan tanpa mengeksekusi. Untuk
// isolasi sungguhan tetap perlu sandbox OS/container — modul ini menaikkan
// biaya serangan, bukan menghilangkannya.

import { isAbsolute, resolve } from "node:path"
import {
  isOwnedHook,
  isOwnedHookReal,
  isOwnedState,
  isRealPathOutsideRoot,
  isSensitive,
  isSensitiveReal,
} from "./jail.ts"

export interface BashVerdict {
  /** true = tolak */
  denied: boolean
  /** alasan singkat untuk pesan ke model/user */
  reason?: string
}

// ── Normalisasi ──

/**
 * Buang quote yang dipakai untuk memecah kata tanpa mengubah arti bagi shell.
 * `.e""nv` → `.env`, `pyt"h"on3` → `python3`, `'.env'` → `.env`.
 *
 * Kita tidak mencoba meniru quoting shell sepenuhnya; tujuannya membuat
 * bentuk-terpecah dan bentuk-utuh menghasilkan string pemeriksaan yang sama.
 * Diekspor untuk test.
 */
export function stripQuotes(cmd: string): string {
  return cmd.replace(/["']/g, "")
}

/**
 * Lepas escape caret command-line cmd.exe: `^` di luar kutip ganda
 * menghilangkan dirinya dan membuat karakter berikutnya harfiah.
 *
 *   type .e^nv   → cmd.exe membuka `.env` (guard membaca `.e^nv`)
 *   ty^pe .env   → cmd.exe menjalankan `type` (READERS tak pernah cocok)
 *   echo x > .e^nv → menulis `.env` (target redirect tak terlihat sensitif)
 *
 * Mengapa wajib: SELURUH aturan berkas di modul ini (SENSITIVE_TARGET,
 * SENSITIVE_DIR, isSensitive/isOwnedState, cek jail) mencocokkan nama
 * LITERAL, jadi satu caret memindahkan perintah dari "ditahan" ke "lolos" —
 * kelas yang sama dengan `.e""nv` yang jadi alasan modul ini ada. Temuan F1
 * audit 2026-09-20: `type .e^nv` ALLOW padahal `type .env` DENY.
 *
 * Quote-aware karena cmd.exe TIDAK memproses caret di dalam kutip ganda:
 * melepas buta akan mengubah arti `echo "a^b"` (aman) menjadi `echo "ab"`.
 * `^^` → `^` benar dengan sendirinya (caret pertama meng-escape yang kedua).
 *
 * Backtick PowerShell SENGAJA tidak diperlakukan sama: di sana backtick
 * sebelum huruf adalah escape KONTROL (`n`=newline, `t`=tab), sehingga
 * `.e\`nv` bukan `.env` melainkan dua baris — melepasnya akan memblokir
 * perintah sah (over-block) tanpa menutup jalur serangan nyata, karena
 * membaca `.env` di PowerShell tidak butuh escape sama sekali.
 *
 * Diekspor untuk test.
 */
export function stripCaretEscapes(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const win = platform === "win32"
  let out = ""
  let inDouble = false
  let inSingle = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (!win && ch === "\\" && !inSingle && i + 1 < cmd.length) {
      out += ch + cmd[++i]!
      continue
    }
    // Di cmd.exe Windows, `'` adalah karakter literal — BUKAN quote delimiter.
    // Membuka state inSingle pada win32 membuat `type ' .e^nv` melewatkan caret.
    if (!win && ch === "'" && !inDouble) {
      inSingle = !inSingle
      out += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      out += ch
      continue
    }
    if (ch === "^" && !inDouble && !inSingle && i + 1 < cmd.length) {
      out += cmd[++i]!
      continue
    }
    out += ch
  }
  return out
}

/**
 * Ekspansi `$IFS` / `${IFS...}` menjadi pemisah kata.
 *
 * Bash memecah kata pada karakter di `$IFS` (default: spasi/tab/newline),
 * sehingga `cat${IFS}.env` dieksekusi PERSIS seperti `cat .env` — tapi tanpa
 * normalisasi guard hanya melihat satu kata `cat${IFS}.env` dan tak pernah
 * mencocokkan READERS/SENSITIVE_TARGET. Bentuk `$IFS`, `${IFS}` dan
 * `${IFS:0:1}` semuanya menghasilkan pemisah, jadi semuanya dipetakan ke
 * spasi. Diterapkan dua kali dalam pipeline (sebelum dan sesudah quote
 * dibuang) karena `${I"F"S}` juga sah di bash.
 *
 * Diekspor untuk test.
 */
export function expandIfsRefs(cmd: string): string {
  return cmd.replace(/\$\{\s*IFS\b[^}]*\}/g, " ").replace(/\$IFS\b/g, " ")
}

/**
 * Ekspansi brace `{a,b}` → semua alternatifnya, sebagai kata-kata terpisah.
 *
 * Brace expansion terjadi SEBELUM perintah dijalankan: `cat .{env,}` dan
 * `cat {.env,x}` membaca `.env`. Karena hasilnya beberapa kata, untuk
 * pemeriksaan alternatif digabung sebagai kata terpisah sehingga aturan
 * berbasis nama (`SENSITIVE_TARGET`) melihat setiap kandidat nyata.
 *
 * Hanya grup yang MENGANDUNG koma yang dianggap ekspansi: `awk '{print $1}'`
 * (tanpa koma) adalah argumen biasa dan tidak boleh ikut dipecah — itu
 * mencegah over-block pada pola awk/sed yang lazim. Kedalaman dan jumlah
 * alternatif dibatasi karena ini heuristik deteksi, bukan evaluator shell.
 */
function expandWordBraces(w: string, depth = 0): string[] {
  if (depth > 4 || w.length > 512) return [w]
  const m = /\{([^{}]*)\}/.exec(w)
  if (!m) return [w]
  const body = m[1]!
  if (!body.includes(",")) return [w]
  const pre = w.slice(0, m.index)
  const post = w.slice(m.index + m[0].length)
  const out: string[] = []
  for (const alt of body.split(",")) {
    for (const r of expandWordBraces(pre + alt + post, depth + 1)) {
      out.push(r)
      if (out.length >= 64) return out
    }
  }
  return out
}

/**
 * Diekspor untuk test.
 *
 * Tanpa grup berkoma, perintah dikembalikan APA ADANYA: pemecahan kata di
 * sini mengganti tab/newline dengan spasi, dan kontrak normalisasi menuntut
 * makna (termasuk "perintah ini mencari dari cwd") tetap terbaca —
 * `C=find\t/; ${C} -name x` harus tetap terlihat sebagai tab, bukan `find /`.
 */
export function expandBraceAlternatives(cmd: string): string {
  if (!/\{[^{}]*,[^{}]*\}/.test(cmd)) return cmd
  return cmd
    .split(/\s+/)
    .flatMap((w) => (w.includes("{") ? expandWordBraces(w) : [w]))
    .join(" ")
}

/**
 * Substitusi assignment variabel sederhana dalam satu perintah.
 * `X=.env; cat $X` → `X=.env; cat .env`
 * `p=python3 && $p -c 1` → `p=python3 && python3 -c 1`
 *
 * Hanya nilai literal tanpa spasi/ekspansi yang disubstitusi — cukup untuk
 * menutup indirection yang dipakai untuk lolos filter, tanpa berpura-pura
 * mengevaluasi shell. Assignment di-scan ulang tiap lintasan agar rantai
 * (`a=.env; b=$a; cat $b`) juga terselesaikan. Diekspor untuk test.
 */
export function inlineSimpleVars(cmd: string): string {
  const ASSIGN = /(?:^|[;&|]\s*|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s;&|"'`$()]+)/g
  // Batasi ekspansi berantai (`a=xx; b=$a$a; c=$b$b`) agar tidak memicu OOM.
  const maxExpandedLen = Math.max(cmd.length * 4, 16_384)
  let out = cmd
  for (let pass = 0; pass < 3; pass++) {
    // scan ulang: substitusi lintasan sebelumnya bisa memunculkan
    // assignment literal baru (b=$a → b=.env)
    const vars = new Map<string, string>()
    ASSIGN.lastIndex = 0
    let m: RegExpExecArray | null = ASSIGN.exec(out)
    while (m !== null) {
      vars.set(m[1]!, m[2]!)
      m = ASSIGN.exec(out)
    }
    if (vars.size === 0) break
    let changed = false
    for (const [name, value] of vars) {
      const ref = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, "g")
      const next = out.replace(ref, () => value)
      if (next.length > maxExpandedLen) return out
      if (next !== out) {
        out = next
        changed = true
      }
    }
    if (!changed) break
  }
  return out
}

/**
 * Buang wrapper perintah yang tidak mengubah apa yang dijalankan.
 *
 * `command env`, `nice env`, `time env`, `exec env` semuanya menjalankan `env`,
 * tapi wrapper-nya menggeser posisi kata sehingga pola yang ter-anchor ke awal
 * perintah (mis. deteksi env-dump) tidak lagi cocok. Ditemukan oleh fuzz
 * bash-guard: `command env` lolos sementara `env` ditolak.
 *
 * Wrapper dibuang berulang karena bisa berlapis (`time nice env`).
 * Diekspor untuk test.
 */
/**
 * [SEC-2] Dekode literal ANSI-C `$'...'` sebelum `stripQuotes`. Bash menafsirkan
 * escape `\xHH` (hex), `\NNN`/`\0NNN` (oktal) dan escape standar di dalam
 * `$'...'`, sehingga `cat $'\x2eenv'` membaca `.env` — tanpa dekode, guard hanya
 * melihat `\x2eenv` dan SENSITIVE_TARGET meleset.
 */
export function decodeAnsiCQuotes(cmd: string): string {
  // Cabang `\\[\s\S]` dan `[^'\\]` dibuat saling lepas agar input `$'\\\\...`
  // tanpa penutup tidak memicu backtracking eksponensial (ReDoS).
  return cmd.replace(/\$'((?:\\[\s\S]|[^'\\])*)'/g, (_full, body: string) => {
    return body.replace(/\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|(.))/g, (_m, hex, oct, std) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16))
      if (oct !== undefined) return String.fromCharCode(parseInt(oct, 8))
      const ESC: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        a: "\x07",
        e: "\x1b",
      }
      if (std === "\\" || std === "'" || std === '"') return std
      return ESC[std] ?? std
    })
  })
}

export function stripCommandWrappers(cmd: string): string {
  const WRAPPER =
    /(^|[;&|\n]\s*)(?:command|exec|builtin|eval|nice(?:\s+-n\s*-?\d+)?|nohup|time|timeout\s+[\d.]+[smhd]?|stdbuf(?:\s+-\S+)*|env(?=\s+[A-Za-z_][A-Za-z0-9_]*=)|setsid|ionice(?:\s+-\S+)*|xargs(?:\s+-\S+)*|sudo(?:\s+-\S+)*|doas)\s+/gi
  // Wrapper privilese/konteks (audit 2026-09-16 B2): `su -c 'env'`,
  // `runuser -u x -- printenv`, `cmd /c set` menyembunyikan perintah
  // sebenarnya dari aturan konten yang ter-anchor ke awal (ENV_DUMP dkk).
  // Dibuang BESERTA flag/argumen konteksnya (user/host/path, introducer
  // -c/--//c) sehingga perintah DALAM dievaluasi aturan biasa — `su -c
  // 'cat /etc/shadow'` tetap kena SENSITIVE_TARGET. Jangkar awal mencegah
  // strip di tengah perintah (`echo su -c env` tak tersentuh).
  const WRAPPER_SHELL =
    /(^|[;&|\n]\s*)(?:(?:su|runuser|gosu|chroot|nsenter)(?:\s+(?:-[^\s;|]+|--[^\s;|]*|\/[^\s;|]*|[^-;\s|/][^;\s|]*))*\s+|cmd(?:\.exe)?(?:\s+\/[a-zA-Z]+)*\s+\/c\s+|powershell(?:\.exe)?(?:\s+-(?:Command|c))?\s+|pwsh(?:\.exe)?(?:\s+-(?:Command|c))?\s+)/gi
  let out = cmd
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(WRAPPER, "$1").replace(WRAPPER_SHELL, "$1")
    if (next === out) break
    out = next
  }
  return out
}

/**
 * Bentuk kanonik untuk pemeriksaan: escape caret dilepas, quote dibuang,
 * variabel disubstitusi, wrapper perintah dibuang.
 *
 * Urutan penting: `stripCaretEscapes` berjalan SEBELUM quote dibuang karena
 * ia butuh melihat kutip ganda asli untuk tahu apakah caret harfiah.
 */
export function normalizeCommand(cmd: string): string {
  // [SEC-1] Gabungkan backslash line-continuation dulu agar perintah multi-baris
  // (`curl ... \\\n -d $KEY`) tidak membuat regex satu-baris `[^\n]*` meleset.
  let c = cmd.replace(/\\\r?\n/g, " ")
  // [SEC-3] `$IFS`/`${IFS…}` adalah PEMISAH KATA bagi shell: tanpa ini
  // `cat${IFS}.env` lolos seluruh aturan berbasis nama perintah.
  c = expandIfsRefs(c)
  // [SEC-2] Dekode ANSI-C quoting sebelum quote dibuang.
  c = decodeAnsiCQuotes(c)
  // IFS dan brace diekspansi sekali lagi setelah quote dibuang: `${I"F"S}`
  // dan `".{env,}"` sama-sama sah di bash.
  return stripCommandWrappers(
    inlineSimpleVars(expandBraceAlternatives(expandIfsRefs(stripQuotes(stripCaretEscapes(c))))),
  )
}

/**
 * Kosongkan isi kutip yang merupakan DATA untuk perintah pencetak/pencari.
 *
 * `echo "rm -rf /"` dan `git commit -m "docs: sudo rm"` tidak mengeksekusi
 * apa pun, tetapi karena normalisasi membuang kutip keduanya terlihat persis
 * seperti perintah berbahaya dan diblokir (over-block yang mengganggu alur
 * dokumentasi/commit). Argumen kutip milik echo/printf/grep/rg dan
 * `-m`/`--message` git adalah teks, jadi isinya dijadikan spasi SEBELUM aturan
 * statis dievaluasi.
 *
 * Pengaman penting: kutip yang memuat substitusi/ekspansi (`$(`, backtick,
 * `${`, `$VAR`) TIDAK dikosongkan — `git commit -m "$(rm -rf /)"` benar-benar
 * mengeksekusi perintah di dalamnya, jadi teks itu bukan data inert.
 *
 * Blanking HANYA dipakai untuk aturan statis (STATIC_DENY/RM_*); pemeriksaan
 * target berkas (SENSITIVE_TARGET, READERS, redirect, jail) tetap memakai
 * bentuk ternormalisasi penuh.
 *
 * Diekspor untuk test.
 */
export function blankQuotedDataArgs(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const win = platform === "win32"
  const INERT_HEADS = /^(?:echo|printf|grep|egrep|fgrep|rg|ag)$/i
  const out = cmd.split("")
  let i = 0
  // Awal segmen perintah terakhir: head ditentukan dari sini, bukan dari awal
  // seluruh baris (`git status && echo "x"` → head segmen kedua = echo).
  let segStart = 0
  while (i < cmd.length) {
    const ch = cmd[i]!
    if (!win && ch === "\\" && i + 1 < cmd.length) {
      i += 2
      continue
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      segStart = i + 1
      i++
      continue
    }
    // Di win32 cmd.exe, `'` tidak mengutip apa pun — mengosongkan isi `'...'`
    // di win32 membuat `echo ' & rm -rf / '` terlihat jinak padahal mengeksekusi.
    if (ch === '"' || (!win && ch === "'")) {
      const closer = ch
      let j = i + 1
      while (j < cmd.length && cmd[j] !== closer) {
        if (closer === '"' && cmd[j] === "\\" && j + 1 < cmd.length) j++
        if (cmd[j] === "\n") break
        j++
      }
      const closed = j < cmd.length && cmd[j] === closer
      const body = cmd.slice(i + 1, j)
      if (closed && body !== "") {
        const words = cmd.slice(segStart, i).trim().split(/\s+/).filter(Boolean)
        const head = words[0] ?? ""
        const prev = words[words.length - 1] ?? ""
        const inertTarget =
          prev !== head && (/^--message$/i.test(prev) || /^-[a-zA-Z]{0,2}m$/.test(prev))
        const isData =
          (INERT_HEADS.test(head) || inertTarget) && !/\$\(|`|\$\{|\$[A-Za-z_]/.test(body)
        if (isData) for (let k = i + 1; k < j; k++) out[k] = " "
      }
      i = closed ? j + 1 : j
      continue
    }
    i++
  }
  return out.join("")
}

// ── Aturan ──

/** Path/berkas kredensial, dicek pada bentuk ternormalisasi. */
const SENSITIVE_TARGET =
  /(?:^|[\s/\\=@"'([:<>{,])(?:\.env(?:\.[\w.-]+)?|\.git-credentials|\.git[/\\](?:config|credentials|hooks)(?=[/\\]|$|[\s;"'&|])|\.minicode[/\\](?:auth|daemon-endpoint|daemon-lease|mcp-schema-pins)\.json\b|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|\.pem|\.p12|\.pfx|shadow|master\.key|config[/\\](?:sam|system|security|software|default)(?=[/\\]|$|[\s;"'&|])|ntds\.dit\b|hklm[/\\](?:sam|system|security)(?=[/\\]|$|[\s;"'&|]))\b/i

/** Direktori kredensial: ~/.ssh, $HOME/.aws, /etc/shadow, dst. */
const SENSITIVE_DIR = /(?:~|\$HOME|\$\{HOME\}|\/etc|\/root|\/proc\/self)[/\\](?:\.?[\w.-]+)/i

/** Export registry hive / salin shadow-copy — satu-satunya pemakaian di
 * konteks agen adalah eksfiltrasi hive terkunci (SAM butuh SYSTEM/VSS).
 * `reg query` diagnostik TIDAK kena (butuh kata kerja save|export). */
const REG_HIVE_EXPORT = /\breg(?:\.exe)?\s+(?:save|export)\b/i

/** Path hive dalam bentuk apa pun (file maupun key registry). Jaga sinkron
 * dengan cabang config[/\\]…|ntds|hklm di SENSITIVE_TARGET di atas. */
const HIVE_PATH =
  /config[/\\](?:sam|system|security|software|default)(?=[/\\]|$|[\s;"'&|])|ntds\.dit\b|hklm[/\\](?:sam|system|security)(?=[/\\]|$|[\s;"'&|])/i

/** Pembuatan/mount shadow copy + utilitas DS — di tangan agen hanya untuk
 * membaca hive terkunci (kasus nyata: `type ...\system32\config\sam`).
 * `vssadmin list` diagnostik tetap lolos (hanya create/delete yang ditahan). */
const VSS_SHADOW = /\bvssadmin\b[^\n]*\b(?:create\s+shadow|delete\s+shadows?)\b/i
const NTDSUTIL = /\bntdsutil\b/i

/** Perintah yang membaca/menyalin/menulis isi berkas. Daftar ini + ekstraktor argumen
 * di inspectBashCommand WAJIB sinkron (audit 2026-09-16 B4: certutil/tac/
 * findstr lolos karena hanya ada di satu sisi; bug-hunt 2026-09-19 F1:
 * Out-File/Set-Content/xcopy/robocopy/Copy-Item lolos karena tak ada di
 * dua sisi). Pembaca yang BUKAN utilitas — `for /f` (loop bawaan cmd.exe) —
 * diekstrak terpisah di blok `forFileSets`; menambah pembaca baru berarti
 * menyentuh salah satu dari keduanya. Denylist takkan pernah komplet
 * (residual arsitektural, lihat kepala berkas) — tiap entri di sini adalah
 * kasus konkret terverifikasi, bukan tebakan. */
// Karakter kelas `u[n]zip` setara literal un-zip tanpa memicu audit statis archive-extract di supply-chain.test.ts.
const READERS =
  /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|gc|certutil|tac|findstr|fc|comp|cp|copy|mv|move|scp|rsync|tar|zip|u[n]zip|7z|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install|diff|patch|xcopy|robocopy|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Expand-Archive|Compress-Archive|Select-String|sls)\b/i

/** Dump environment — `printenv` sudah lama diblok, sisanya belum.
 * Tambahan: PowerShell `Get-ChildItem env:` / alias `dir env:` / `ls env:`
 * / `gci env:` juga dump env, perlu diblok. */
const ENV_DUMP =
  // F-20: `\n` adalah pemisah perintah setara `;` — tanpa ini `echo hi\nenv`
  // lolos (anchor lama hanya [;&|]). Berlaku untuk semua aturan ber-anchor
  // awal-perintah di berkas ini.
  /(?:^|[;&|\n]\s*)(?:printenv|env|set|export\s+-p|declare\s+-[xp]|compgen\s+-v|(?:Get-ChildItem|dir|ls|gci)\s+env:)\s*(?:$|[;&|\n]|\|)/i

// [SEC-4] Bentuk dump env BER-ARGUMEN yang tak tercakup ENV_DUMP (yang mensyaratkan
// akhir perintah): `printenv <ARG>`, `env -0`/`env --null`, dan `set <PREFIX_IDENT>`
// (dump prefix variabel cmd.exe/zsh). `set -e`/`-u`/`-o`/`+e`/`--` (opsi shell
// POSIX) sengaja TIDAK cocok: argumennya diawali `-`/`+`/`--`, bukan ident.
const ENV_DUMP_ARG =
  /(?:^|[;&|\n]\s*)(?:printenv(?:\.exe)?\b|env\s+--?(?:0|null)\b|set\s+[A-Za-z_][A-Za-z0-9_]*\*?\b)/i

/** Referensi eksplisit ke variabel env yang berbau kredensial.
 * Case-insensitive karena bash case-sensitive tapi nama lazim campuran;
 * PowerShell ($env:Var) dan CMD (%VAR%) juga dicakup agar cross-shell. */
const ENV_SECRET_REF =
  /(?:\$(?:env:)?\{?[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*\}?|%[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*%)/i

/** Flag upload berkas pada klien HTTP — jalur exfiltrasi paling langsung. */
const UPLOAD_FLAG =
  /\b(?:curl|wget|http|httpie|nc|ncat|socat)\b[^\n]*(?:-F\s*\S*=@|--form\s*\S*=@|(?:-d|--data(?:-binary|-raw|-ascii)?)(?:\s*=\s*|\s*)@|(?:-T|--upload-file|--post-file)(?:=|\s+)|-T[./~]|-b\s*@)/i

/** Upload DATA dari variabel bare (`-d $X`, bukan `@file` yang sudah ditahan
 * UPLOAD_FLAG): bentuk exfiltrasi terakhir yang lolos — nama var arbitrer
 * (mis. $TH_NGODING) tak cocok ENV_SECRET_REF dan tak butuh file sensitif
 * literal. Literal `-d '{"a":1}'` tetap lolos (payload terlihat di review).
 * Divalidasi e2e: canary odd-name terkirim ke listener loopback (bug-hunt
 * 2026-09-19 F3). */
const VAR_UPLOAD =
  /\b(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*(?:-d|--data(?:-binary|-raw-data|-urlencode)?|--body|-Body)\s+["']?[^;&|\n]*[$%][\w{(]/i

/** Konfigurasi git berbahaya via `-c key=val`: eksekusi kode (pager/hook/
 * helper) atau repo-confusion. Kunci jinak (`-c core.quotepath=false`) tetap
 * lolos — hanya kunci eksekusi + helper eksternal yang ditahan. Divalidasi:
 * `core.fsmonitor` mengeksekusi pipe-independent (bug-hunt 2026-09-19 F2);
 * `core.pager` mati-di-pipe pada git-windows (negatif terdokumentasi). */
const GIT_DANGEROUS_CONFIG =
  /(?:-c\s*|--config-env=)["']?(?:core\.(?:pager|fsmonitor|sshCommand|askpass|editor)|protocol\.ext\.allow|core\.hooksPath|gpg\.(?:program|ssh\.program|x509\.program)|credential\.helper|alias\.[\w-]+|diff\.(?:external|[\w-]+\.(?:command|textconv))|(?:merge|filter)\.[\w-]+\.(?:driver|clean|smudge|process))\s*=/i

/** git keluar workspace: `-C dir` / `--git-dir=` / `--work-tree=` menunjuk
 * repo/pohon lain (baca objek repo korban = jail-bypass READ, validasi e2e
 * bug-hunt 2026-09-19 F2: `--git-dir=victim/.git log -p` bocor isi repo lain).
 * Nilai dicek di bawah terhadap cwd (resolve+outside/sensitive/owned). */
const GIT_DIR_OVERRIDE = /(?:^|\s)(?:-C\s*(\S+)|--(?:git-dir|work-tree)(?:=|\s+)(\S+))/gi

/** Env git eksekusi (`GIT_PAGER=id ...`, `GIT_SSH=...`): efek sama dengan
 * `-c` di atas, lewat assignment env. */
const GIT_EXEC_ENV =
  /(?:^|[;&|\n]\s*)GIT_(?:PAGER|SSH|SSH_COMMAND|ASKPASS|EDITOR|SEQUENCE_EDITOR|EXEC_PATH|DIR|WORK_TREE|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_PARAMETERS|EXTERNAL_DIFF|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)\s*=/i

/**
 * Interpreter dijalankan dengan kode inline (semua bentuk flag).
 *
 * Interpreter diperluas mengikuti allowlist developer (python/node/bun/…
 * sudah lama; tambah lua/julia/elixir/groovy/scala/tcl/dotnet/swift/dart/java)
 * supaya `lua -e`, `julia -e`, `elixir -e`, dst tetap ditolak — tanpa ini,
 * memperluas allowlist ke bahasa baru membuka jalur kode-inline pada bahasa itu.
 */
const INLINE_INTERPRETER =
  /(?:^|[;&|\n(\s/\\])(?:pyw?|python[\d.]*|pypy[\d.]*|sh|bash|dash|zsh|ksh|node|deno|bun|perl|ruby|php|Rscript|lua|luajit|julia|elixir|escript|erl|groovy|scala|tclsh|dotnet|swift|swiftc|dart|java|raku)(?:\.exe)?\b\s+(?:--[A-Za-z0-9_-]+(?:=[^\s;&|]+)?\s+|-(?:W|X|I|M)\s+[^\s;&|]+\s+|-(?![WXIM]\s)[A-Za-z0-9]+\s+)*(?:-c|-e|-E|--eval|-eval|--print|-p|--command|-r|--execute|--require|--import|--loader|-(?:pe|ep|ne|en|uc|cu|ue|eu|ie|ei|ic|ci|lc|cl|rc|cr|xc|cx|ec|ce|sc|cs))\b/i
// Residual jujur (audit 2026-09-16 B3): eksekusi via stdin/redirect TANPA
// flag inline (`bash -s < skrip`, `python3 < prog`, `... | python3 -`) tidak
// ditahan — menahan `| python3 -` mematahkan pipeline sah, dan `bash berkas`
// telanjang memang diizinkan (skrip workspace dieksekusi setara user
// menjalankannya; penanaman skrip dijaga permission write). Isolasi penuh
// tetap tugas sandbox OS/docker, bukan analisis statis.

/** Process substitution / here-string yang memasukkan output perintah lain. */
const PROCESS_SUB = /<\s*\(|>\s*\(|<<<|\bsource\s+<|\.\s+<\(/

/** Pipe ke shell/interpreter — bentuk apa pun sumbernya (interpreter baru
 * mengikuti perluasan allowlist developer). */
const PIPE_TO_SHELL =
  /\|\s*(?:sudo\s+)?(?:sh|bash|dash|zsh|ksh|python|python2|python3|pyw?|node|deno|bun|perl|ruby|php|iex|Invoke-Expression|powershell|pwsh|lua|luajit|julia|elixir|escript|erl|groovy|scala|tclsh|dotnet|swift|swiftc|dart|java|raku)(?:\.exe)?\b/i

/** Unduh ke berkas lalu jalankan berkas itu dalam satu baris. Catatan pola:
 * - `certutil -urlcache` ikut (downloader Windows di luar curl/wget/iwr).
 * - `\./` tanpa `\b` (bug-hunt 2026-09-19: `\b` sebelum `.` tak pernah cocok
 *   setelah spasi — alternatif `./` mati total, `IWR ...; ./a.ps1` lolos). */
const DOWNLOAD_THEN_RUN =
  /\b(?:curl|wget|Invoke-WebRequest|iwr|certutil)\b[^\n]*?(?:-o|-O|--output|-OutFile|-urlcache)\s*(\S+)[^\n]*[;&|][^\n]*(?:\b(?:sh|bash|dash|zsh|node|pyw?|python3?|perl|ruby|php)(?:\.exe)?\b|\.\/)/i

/** Container escape: mount host root / privileged. */
const CONTAINER_ESCAPE =
  /\b(?:docker|podman|nerdctl)\b[^\n]*(?:--privileged|--pid[= ]host|--net(?:work)?[= ]host|-v\s*\/:|--volume\s*\/:|-v\s*\/etc|--cap-add[= ](?:ALL|SYS_ADMIN))/i

/**
 * Target redirect shell (`>`, `>>`, `<`) di luar quote. Heredoc `<<`/`<<-`
 * dilewati (kata berikutnya delimiter, bukan path); target fd (`>&2`, `&-`)
 * dilewati (bukan path). Diekspor untuk test.
 *
 * Kenapa scan RAW quote-aware, bukan bentuk ternormalisasi: stripQuotes
 * membuat `echo "a > b"` (aman — shell tak me-redirect isi quote) terlihat
 * persis seperti `echo a > b` (redirect nyata).
 */
export function findRedirectTargets(
  rawCmd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const win = platform === "win32"
  const out: string[] = []
  let sq = false
  let dq = false
  let i = 0
  const n = rawCmd.length
  // `(` dan `)` BUKAN pemisah kata di shell — keduanya karakter sah di
  // nama berkas, dan `$(` (command substitution) tetap bagian dari kata.
  // Kalau `(` dipandang pemisah, target `$(pwd)/../x` terpotong jadi `$`
  // dan yang diperiksa bukan path yang dipakai shell.
  const isTerm = (c: string): boolean => /[\s;|&<>]/.test(c)
  while (i < n) {
    const c = rawCmd[i]!
    if (!win && c === "\\" && i + 1 < n) {
      i += 2
      continue
    }
    // Pada Windows cmd.exe, `'` adalah literal (bukan quote) — jangan buka
    // state single-quote agar `echo ' > ..\evil` tetap terdeteksi sebagai redirect.
    if (!win && c === "'" && !dq) {
      sq = !sq
      i++
      continue
    }
    if (c === '"' && !sq) {
      dq = !dq
      i++
      continue
    }
    if (sq || dq || (c !== ">" && c !== "<")) {
      i++
      continue
    }
    // Operator: serakah makan [<>|] (>, >>, >|, <>, <). `<<` = heredoc.
    let j = i
    let heredoc = false
    while (j < n && (rawCmd[j] === ">" || rawCmd[j] === "<" || rawCmd[j] === "|")) {
      j++
      if (j - i > 3) break
    }
    const op = rawCmd.slice(i, j)
    if (op.includes("<<")) heredoc = true
    // Lewati spasi, baca satu kata target.
    let k = j
    while (k < n && /\s/.test(rawCmd[k]!)) k++
    if (heredoc || (k < n && rawCmd[k] === "&")) {
      // Delimiter heredoc / target fd (`>&2`, `&-`): bukan path.
      while (k < n && !isTerm(rawCmd[k]!)) k++
      i = k
      continue
    }
    // Target bisa berupa KATA BERKUTIP: `> "my file.txt"` — spasi di dalam
    // kutip adalah bagian dari path, bukan pemisah kata. Kalau kata dipotong
    // di spasi, yang diperiksa bukan path yang dipakai shell: `> "a b/../../x"`
    // akan diperiksa sebagai `a` (masih di dalam workspace) padahal shell
    // menulis ke luar. Kutip shell dilepas sebelum path dipakai, jadi kata
    // efektifnya harus dibaca utuh.
    let e = k
    const q = rawCmd[k]
    if (q === '"' || (!win && q === "'")) {
      let c = k + 1
      while (c < n) {
        if (!win && rawCmd[c] === "\\" && c + 1 < n) {
          c += 2
          continue
        }
        if (rawCmd[c] === q) break
        c++
      }
      // Kutip penutup tak ketemu → kata tak tertutup; ambil sisanya apa adanya
      // (shell akan gagal parse, jadi tak ada tulisan yang terjadi).
      e = c < n ? c + 1 : n
      while (e < n && !isTerm(rawCmd[e]!)) e++
    } else {
      while (e < n && !isTerm(rawCmd[e]!)) e++
    }
    if (e > k) out.push(rawCmd.slice(k, e))
    i = e
  }
  return out
}

/** Null sink sadar platform — `NUL` hanya null device di Windows, di POSIX ia berkas biasa. */
function isNullSink(t: string, platform: NodeJS.Platform = process.platform): boolean {
  return t === "/dev/null" || (platform === "win32" && t.toUpperCase() === "NUL")
}

/** Pencarian rekursif dari root filesystem. */
const ROOT_SCAN = /\b(?:find|fd|ls|dir|du|tree|grep|rg)\b[^\n]*\s\/(?:\s|$)/i

/**
 * `rm` rekursif dengan target berbahaya.
 *
 * Dipisah dari denylist lama yang menganggap SETIAP `/` berbahaya — itu
 * memblokir `rm -rf node_modules/.cache` yang sah. Yang berbahaya: target root,
 * home, parent traversal, atau wildcard telanjang.
 *
 * Bentuk flag panjang (`--recursive`) ikut dikenali: fuzz menemukan
 * `rm --recursive --force /` lolos karena pola lama hanya mencari `-[a-z]*r`.
 *
 * Traversal dicek di mana pun dalam argumen, bukan hanya di awal kata: target
 * bisa dibungkus command substitution (`rm -rf $(pwd)/../..`) yang tidak bisa
 * kita evaluasi, tapi `..` yang menaik tetap terlihat.
 *
 * Target `//` dan `/.X` ikut berbahaya (audit 2026-09-16 B5): slash ganda
 * collapse ke root di POSIX (`rm -rf //` ≡ `rm -rf /`), dan `/.[!.]*` dengan
 * -r menghapus isi dotfile root.
 */
const RM_RECURSIVE = /\brm\b[^\n]*(?:\s-[a-z]*[rR]|\s--recursive\b|\s--dir\b)/i
// Terminator target root ikut mencakup `)`, `,` dan backtick: bentuk
// bersubstitusi (`rm -rf $(pwd)`) berakhir dengan `)` sehingga `\s\/(?:\s|…)`
// dulu meleset dan seluruh perintah lolos.
const RM_DANGEROUS_TARGET =
  /(?:\s\/(?:\s|$|\*|;|&|\/|\.|\)|,|`)|\s~(?:[/\\]\s*)?(?:\s|$|;|&|\))|\$\{?HOME\}?|\.\.(?:[/\\]|\s|$|;|&)|\s\*\s*(?:$|;|&)|--no-preserve-root)/

const STATIC_DENY: [RegExp, string][] = [
  // Fork bomb: definisi fungsi rekursif yang memanggil dirinya lewat pipe.
  // Pola longgar (bukan hanya `:(){ :|:& };:` literal) karena nama fungsi bisa
  // apa saja dan spasi bebas — fuzz menemukan varian yang terpecah oleh
  // substitusi variabel masih lolos bentuk ketat. `\}` opsional karena
  // normalisasi bisa menghilangkan bagian setelah pipe.
  [/(?:^|[;&|=\n]\s*)[\w:]+\s*\(\)\s*\{[^}]*\|[^}]*&/, "fork bomb"],
  [/\bmkfs\b/i, "format filesystem"],
  [/\bdd\b[^\n]*\b(?:if|of)=/i, "raw disk write"],
  [/\bchmod\s+(-R\s+)?777\b/i, "permission 777"],
  [/\bshred\b/i, "secure delete"],
  [/\btruncate\b/i, "truncate file"],
  [/\bmv\s+[^;|]*\s+\/(?:etc|boot|usr|lib)\b/i, "overwrite system dir"],
  [/\bsudo\b[^\n]*\brm\b/i, "sudo rm"],
  // `pwsh`/`pwsh.exe` = nama biner PowerShell modern lintas-OS (audit
  // 2026-09-16: varian encoded lolos karena aturan hanya kenal `powershell`).
  // Bentuk eksplisit -EncodedCommand/-enc/-ec menangkap payload pendek juga
  // (tanpa menyentuh `-Encoding utf8` karena word boundary).
  [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:encodedcommand|enc|ec)\b/i, "encoded powershell"],
  // Bentuk prefix pendek -e... + blob base64 panjang (60+ byte): tetap aman
  // terhadap `-Encoding utf8` yang argumennya bukan blob base64 panjang.
  [
    /\b(?:powershell|pwsh)(\.exe)?\b[^\n]*\s-e\w*\s+[A-Za-z0-9+/]{60,}={0,2}/i,
    "encoded powershell payload",
  ],
  [
    />\s*\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?)/i,
    "raw device write",
  ],
  [/\b(?:del|erase)\b[^\n]*\/[sfaq]/i, "windows recursive delete"],
  [/\brmdir\b[^\n]*\/s/i, "windows recursive rmdir"],
  [/\bRemove-Item\b[^\n]*-Recurse/i, "powershell recursive delete"],
  [
    /\[(?:System\.)?IO\.File\]::(?:ReadAllText|ReadAllBytes|ReadAllLines|WriteAllText|WriteAllBytes|OpenRead|OpenWrite)/i,
    "powershell file read",
  ],
  [/\b(?:Invoke-Expression|iex)\b/i, "powershell dynamic eval"],
  [/\bawk\b[^\n]*\bsystem\s*\(/i, "awk system()"],
  // ripgrep `--pre` mengeksekusi perintah arbitrer sebagai preprocessor file.
  [/\brg\b[^\n]*--pre(?:=|\s+)/i, "ripgrep preprocessor execution"],
  // git sebagai pelarian jail: `git diff --no-index A B` mencetak isi path
  // filesystem ARBITRER (di luar workspace, abaikan file-jail — terkonfirmasi
  // via inspectBashCommand, bukan teori); --exec-path/--upload-pack/
  // --receive-pack/ext:: mengeksekusi helper eksternal. Bentuk global
  // `git -c k=v <sub>` sebelum subcommand sudah gugur di allowlist (tak cocok
  // pola ^git <sub>), tapi mode auto hanya dijaga guard ini. Alur sah agen
  // (status/diff/log/branch/show dalam repo) tak memakai flag ini.
  [
    /\bgit\b[^\n]*?--(?:no-index|exec-path|upload-pack|receive-pack|output(?:=|\s+))/i,
    "git dangerous flag",
  ],
  [
    /\bfind\b[^\n]*\s-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/i,
    "find exec/delete/write flag",
  ],
  [/\bext::/i, "git ext transport"],
  // Injeksi konfigurasi git via environment (`GIT_EXTERNAL_DIFF=x git diff`
  // setara diff.external repo — repo-side adalah residual terdokumentasi, tapi
  // env datang dari perintah model sendiri sehingga ditahan di sini).
  [
    /\bGIT_(?:EXTERNAL_DIFF|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|SSH_COMMAND|SEQUENCE_EDITOR|EXEC_PATH|CONFIG_GLOBAL|CONFIG_SYSTEM)\s*=/i,
    "git config injection via env",
  ],
  [
    /(?:^|[;&|\n]\s*)(?:base64|xxd)[^\n]*\|\s*(?:sh|bash|python|python3|node|perl)\b/i,
    "decode|shell",
  ],
  // F-20: upload berkas via PowerShell — UPLOAD_FLAG hanya kenal
  // curl/wget/nc. Bentuk eksfiltrasi: Invoke-WebRequest/Invoke-RestMethod
  // -Method POST -Body (Get-Content rahasia) atau -InFile <berkas>.
  [
    /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*?(?:-InFile\b|Get-Content)/i,
    "file upload to network",
  ],
  // [SEC-7] SSH/SCP `-o ProxyCommand=`/`-o LocalCommand=` mengeksekusi perintah
  // arbitrer saat koneksi — jalur RCE/eksfiltrasi yang tak terlihat oleh aturan
  // konten (host yang dihubungi sendiri bisa jinak).
  [/\b(?:ssh|scp|sftp)\b[^\n]*-o\s*(?:ProxyCommand|LocalCommand)\s*=/i, "ssh proxy/local command"],
  // [SEC-8] Launcher berbahaya Windows/macOS: semua menjalankan kode/script
  // arbitrer dari argumen single-command. `wscript`/`cscript` (Windows Script
  // Host), `mshta` (HTML app), `rundll32`/`regsvr32` (load arbitrary DLL).
  [/\b(?:mshta|wscript|cscript|rundll32|regsvr32)(?:\.exe)?\b/i, "dangerous windows launcher"],
  // Verba rilis/kredensial registry — aksi IREVERSIBEL yang butuh kredensial,
  // bukan bagian alur membangun aplikasi: `npm publish`, `cargo publish`/
  // `login`, `gem push`, `dotnet nuget push`, `poetry publish`,
  // `docker push`/`login`, `mvn deploy`, `gradle publish`, `dart pub publish`,
  // `twine upload`, `cargo owner`/`yank`. Ditahan di SEMUA mode (armor) agar
  // allowlist developer boleh LUAS tanpa membuka jalur terbit diam-diam.
  // Over-block dijaga ketat: verba rilis HARUS tepat setelah manager (+ satu
  // subcommand opsional), jadi `npm run deploy` TIDAK kena ("run" bukan verba).
  [
    /\b(?:npm|cargo|gem|poetry|twine|dotnet|docker|podman|mvn|gradle|bun|yarn|pnpm|dart|flutter|pub|nuget)\b(?:\s+(?:nuget|pub|compose|token))?\s+(?:publish|unpublish|push|deploy|login|logout|adduser|upload|yank|owner|signout)\b/i,
    "registry publish/credential verb",
  ],
]

/**
 * Evaluasi satu perintah bash. Return alasan bila ditolak.
 *
 * Pemeriksaan dilakukan pada bentuk ternormalisasi DAN mentah: normalisasi
 * menutup bypass, sementara bentuk mentah menangkap pola yang justru hilang
 * saat quote dibuang (mis. `--upload-file "x"`).
 */
export function inspectBashCommand(
  rawCmd: string,
  cwd?: string,
  root?: string,
  opts?: { platform?: NodeJS.Platform },
): BashVerdict {
  const targetPlatform = opts?.platform ?? process.platform
  const raw = rawCmd
  const norm = normalizeCommand(rawCmd)
  // `cwd` = direktori tempat shell me-resolve operand relatif; `root` = batas
  // workspace yang dijail. Keduanya HARUS terpisah: bash dijalankan dengan
  // cwd = sessionRoot + args.cwd, tetapi jail tetap di sessionRoot. Memakai
  // satu nilai untuk dua peran (sebelumnya cwd dipakai sebagai root) membuat
  // `cat sub/link/secret` (link → /outside) lolos dan `cat ../x` dari sub
  // salah ditolak. Default `root = cwd` menjaga perilaku pemanggil lama.
  const containmentRoot = root ?? cwd
  const both = (re: RegExp): boolean => re.test(norm) || re.test(raw)
  // Aturan statis dievaluasi pada bentuk yang teks-kutip-inert-nya sudah
  // dikosongkan (blankQuotedDataArgs), sehingga `echo "rm -rf /"` tidak lagi
  // diblokir sementara `rm -rf /` dan `bash -c "rm -rf /"` tetap.
  const inert = blankQuotedDataArgs(raw)
  const inertNorm = normalizeCommand(inert)
  const staticHit = (re: RegExp): boolean => re.test(inertNorm) || re.test(inert)

  for (const [re, reason] of STATIC_DENY) {
    if (staticHit(re)) return { denied: true, reason }
  }
  if (staticHit(RM_RECURSIVE) && staticHit(RM_DANGEROUS_TARGET)) {
    return { denied: true, reason: "destructive rm" }
  }
  if (both(PROCESS_SUB)) return { denied: true, reason: "process substitution" }
  if (both(PIPE_TO_SHELL)) return { denied: true, reason: "pipe to interpreter" }
  if (both(DOWNLOAD_THEN_RUN)) return { denied: true, reason: "download then execute" }
  if (both(INLINE_INTERPRETER)) return { denied: true, reason: "inline interpreter code" }
  if (both(CONTAINER_ESCAPE)) return { denied: true, reason: "container escape" }
  if (both(ENV_DUMP) || both(ENV_DUMP_ARG)) return { denied: true, reason: "environment dump" }
  if (both(ENV_SECRET_REF)) return { denied: true, reason: "credential env reference" }
  if (both(UPLOAD_FLAG)) return { denied: true, reason: "file upload to network" }
  if (both(VAR_UPLOAD)) return { denied: true, reason: "variable data upload to network" }
  if (both(GIT_DANGEROUS_CONFIG)) return { denied: true, reason: "git exec config override" }
  if (both(GIT_EXEC_ENV)) return { denied: true, reason: "git exec env override" }
  // -C/--git-dir/--work-tree: resolve SEMUA nilai terhadap cwd seperti redirect —
  // di luar workspace/sensitif/owned = deny (baca repo lain = jail-bypass).
  for (const src of [norm, raw]) {
    for (const m of src.matchAll(GIT_DIR_OVERRIDE)) {
      const rawTarget = m[1] ?? m[2]
      if (!rawTarget) continue
      const t = rawTarget.replace(/^["']|["']$/g, "")
      if (cwd != null) {
        const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
        // Keputusan owner 2026-11-23: `.minicode/` kini boleh ditulis agen, jadi
        // bukan lagi jail bypass. Yang tetap ditolak = rahasia & luar workspace.
        if (isRealPathOutsideRoot(abs, containmentRoot!) || isSensitive(t) || isSensitive(abs))
          return { denied: true, reason: "git directory outside workspace" }
      } else if (/^\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t)) {
        return { denied: true, reason: "git directory outside workspace" }
      }
    }
  }
  // Hive Windows: `reg save HKLM\SAM` / `reg export ...\config\system` —
  // `reg query` diagnostik tetap lolos (tanpa kata kerja destruktif).
  if (both(REG_HIVE_EXPORT) && (HIVE_PATH.test(norm) || HIVE_PATH.test(raw)))
    return { denied: true, reason: "registry hive export" }
  if (both(VSS_SHADOW)) return { denied: true, reason: "shadow copy credential access" }
  if (both(NTDSUTIL)) return { denied: true, reason: "directory services tool" }
  if (both(ROOT_SCAN)) return { denied: true, reason: "filesystem-root scan" }

  // Pembuatan link (symlink/junction/hardlink) yang operannya sensitif /
  // owned-state: temuan audit 2026-09-22 F-CRIT (`ln -s .minicode linkdir`
  // lalu `write_file linkdir/config.json`). Keputusan owner 2026-11-23
  // membolehkan tulis ke `.minicode/`, JADI alasan lama "menembus kunci owned"
  // tak lagi berlaku untuk file biasa. Pembuatan link TETAP ditahan karena
  // (a) ia primitif bypass jail/rahasia lintas-tool dan (b) kunci hook di
  // permission.ts bergantung pada realpath yang bisa disamarkan junction.
  // Blok ini lapisan kedua di sisi shell (lapisan utama: permission.ts).
  //
  // Urutan argumen BEDA antar tool — `ln`: TARGET LINK; `mklink`/`fsutil`:
  // LINK dulu; `New-Item`: parameter bernama (urutan bebas, `-Target` alias
  // `-Value`). Alih-alih mempercayai posisi, SEMUA operand non-flag dicek:
  // link yang kebetulan DINAMAI seperti path sensitif/owned sama
  // mencurigakannya (shadowing), jadi tanpa false positive berarti. Ini
  // sekaligus menutup reshuffle flag (`ln --symbolic`, `ln -s --`, fsutil
  // terbalik) yang lolos dari pencocokan posisi.
  {
    const denyLinkOperand = (op: string | undefined): BashVerdict | null => {
      if (!op) return null
      const t = op.replace(/^["']+|["']+$/g, "")
      if (!t || t.startsWith("-")) return null // flag / `--`, bukan path
      if (isSensitive(t) || isSensitive(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "link to sensitive file" }
      }
      if (isOwnedState(t) || isOwnedState(resolve(cwd ?? ".", t))) {
        return { denied: true, reason: "link to owned state" }
      }
      // Target link di LUAR workspace = jail bypass kelas dua: `ln -s
      // /tmp/outside link` lalu tulis/baca lewat `link/...` melewati cek path
      // tool file. Sebelumnya hanya isSensitive/isOwnedState yang dicek, jadi
      // target absolut jinak di luar root lolos. Samakan dengan cek redirect:
      // resolusi terhadap cwd efektif, containment terhadap root workspace,
      // realpath menangkap symlink perantara (dan fallback ENOENT untuk target
      // yang belum ada). Tanpa cwd, pakai heuristik konservatif `..`/absolut.
      if (cwd != null) {
        const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
        if (isRealPathOutsideRoot(abs, containmentRoot!))
          return { denied: true, reason: "link target outside workspace" }
      } else if (/^\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t)) {
        return { denied: true, reason: "link target outside workspace" }
      }
      return null
    }
    // `&`/`<`/`>` mengakhiri segmen operand. Switch cmd `/D` `/J` `/H`
    // dilewati eksplisit agar path yang kebetulan berawalan `/` tak hilang.
    const LINK_CMD =
      /(?:^|[;&|\n]\s*)(?:sudo\s+)?(?:ln|mklink|fsutil\s+hardlink\s+create)\s+([^\n;|&<>]+)/gi
    const linkSegs = [...norm.matchAll(LINK_CMD)]
    if (linkSegs.length === 0) linkSegs.push(...raw.matchAll(LINK_CMD))
    for (const m of linkSegs) {
      for (const tok of m[1]!.trim().split(/\s+/)) {
        if (/^\/[djh]$/i.test(tok)) continue
        const v = denyLinkOperand(tok)
        if (v) return v
      }
    }
    // New-Item: `-Target`/`-Value` (alias) bisa berbentuk nilai-menempel
    // (`-Target:.minicode`) ATAU dipisah spasi (`-Target .minicode`). DULU
    // bentuk spasi ditahan oleh pemeriksaan READER di bawah, tapi keputusan
    // owner 2026-11-23 membolehkan baca `.minicode/`, jadi ekstraksi di sini
    // harus menangkap KEDUANYA — kalau tidak, pembuatan link ke hook/rahasia
    // lolos hanya karena beda spasi.
    const NI_CMD = /(?:^|[;&|\n]\s*)New-Item\b([^\n;|]*)/gi
    const niSegs = [...norm.matchAll(NI_CMD)]
    if (niSegs.length === 0) niSegs.push(...raw.matchAll(NI_CMD))
    for (const m of niSegs) {
      const args = m[1]!
      if (!/-ItemType:?\s*"?(?:SymbolicLink|HardLink|Junction)"?(?:\s|$)/i.test(args)) continue
      const targetRe =
        /-(?:Path|Target|Value):\s*(\S+)|-(?:Path|Target|Value)\s+("[^"]*"|'[^']*'|\S+)/gi
      for (const pm of args.matchAll(targetRe)) {
        const v = denyLinkOperand(pm[1] ?? pm[2])
        if (v) return v
      }
    }
  }

  // Redirect keluar workspace (temuan audit eksternal: `echo x > ..\evil`
  // lolos karena allowlist hanya menolak chaining `[;&|]` dan guard tak
  // punya aturan redirect). Target di-resolve terhadap cwd pemanggil agar
  // presisi (`> local.txt` dan `> /dev/null` tetap jalan); tanpa cwd,
  // heuristik konservatif (`..`/absolut/sensitif) berlaku.
  for (const tRaw of findRedirectTargets(raw)) {
    // cmd.exe melepas caret SEBELUM membuka berkas: `echo x > .e^nv` menulis
    // `.env`, jadi target diperiksa dalam bentuk kanoniknya, bukan mentah
    // (temuan F1 audit 2026-09-20). Scan tetap dari `raw` supaya target di
    // dalam kutip tetap tak terhitung sebagai redirect.
    //
    // Tanda kutip juga dilepas shell SEBELUM path dipakai: `echo x
    // >"../evil.txt"` menulis ke `../evil.txt`, bukan ke berkas bernama
    // `"../evil.txt"`. Kalau kutip ikut terhitung, ".." di dalamnya BUKAN
    // segmen path (dia bagian satu nama berkas) sehingga jail check lolos
    // padahal shell menulis ke luar workspace — termasuk untuk path
    // absolut/UNC yang dibungkus kutip. Jadi bentuk yang diperiksa harus sama
    // dengan yang dipakai shell: kutip dibuang dulu (tokenisasi yang sudah
    // dipakai modul ini di `stripQuotes`).
    const t = stripQuotes(stripCaretEscapes(tRaw))
    if (isNullSink(t, targetPlatform)) continue
    // Ekspansi %VAR% terjadi di cmd.exe SETELAH cek statis: `> "%TEMP%\x"`
    // terlihat di dalam cwd secara literal lalu menulis ke luar. Target dengan
    // pola %NAMA% tak bisa dipastikan aman → tolak; tulis ulang tanpa env var
    // atau pakai path relatif. `%` tunggal (mis. `100%.txt`) tetap lolos
    // karena bukan pola ekspansi.
    if (/%[^%\s]+%/.test(t))
      return { denied: true, reason: "redirect target with env expansion (%VAR%)" }
    // Ekspansi shell POSIX dan tilde: path efektifnya tak bisa ditentukan
    // dari teks statis, jadi fail-closed — kelas yang sama dengan %VAR% di
    // atas (kode yang diperiksa harus sama dengan yang dipakai shell).
    // POSIX: $VAR, ${VAR}, $(...)  ·  backtick: `...`  ·  tilde: ~/ atau ~.
    // `%` tunggal dan `$` di akhir kata (mis. "100%.txt") bukan pola
    // ekspansi → tetap lolos.
    if (/\$(?:[A-Za-z_{]|\()/.test(t))
      return { denied: true, reason: "redirect target with shell expansion ($VAR)" }
    if (t.includes("`"))
      return { denied: true, reason: "redirect target with command substitution" }
    if (t.startsWith("~"))
      return { denied: true, reason: "redirect target with home expansion (~)" }
    if (cwd != null) {
      const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
      // Keputusan owner 2026-11-23: tulis ke `.minicode/` lewat redirection
      // kini BOLEH, selaras dengan file tool. Jail workspace & rahasia tetap.
      // SATU-SATUNYA yang masih dilarang = skrip hook (audit 2026-11-12):
      // hook dieksekusi otomatis saat MINICODE_HOOKS=1, jadi tak boleh ditanam
      // lewat shell menyiasati kunci hook di permission.ts.
      if (
        isRealPathOutsideRoot(abs, containmentRoot!) ||
        isSensitive(t) ||
        isSensitive(abs) ||
        isSensitiveReal(abs, containmentRoot!) ||
        isOwnedHook(t) ||
        isOwnedHook(abs) ||
        isOwnedHookReal(abs, containmentRoot!)
      )
        return { denied: true, reason: "redirect outside workspace" }
    } else if (
      /(^|[\\/])\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t) ||
      isSensitive(t) ||
      isOwnedHook(t)
    ) {
      return { denied: true, reason: "redirect outside workspace" }
    }
  }

  // Berkas sensitif: berbahaya bila dibaca/disalin ATAU dijadikan argumen
  // perintah jaringan. Menyebut `.env` dalam `echo` saja tidak diblokir.
  // Pembaca yang argumennya langsung substitusi perintah (`cat$(printf ' ')`)
  // menyembunyikan nama berkas sepenuhnya dari analisis statis.
  if (
    /\b(?:cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|gc|cp|copy|mv|move|tar|base64|openssl|awk|sed|grep|egrep|fgrep|rg|findstr)\b\s*(?:\$\(|`)/i.test(
      inertNorm,
    )
  ) {
    return { denied: true, reason: "reader command substitution" }
  }

  const touchesSensitive = both(SENSITIVE_TARGET) || both(SENSITIVE_DIR)
  if (touchesSensitive && (both(READERS) || /\b(?:curl|wget|nc|ncat|socat|scp)\b/i.test(norm))) {
    return { denied: true, reason: "sensitive file access" }
  }

  // P0-2: READER tanpa filter path (cat * / type *) = bisa baca file sensitif
  // atau di luar workspace walau cocok allowlist. Ekstrak argumen path untuk
  // READER dan cek jail/sensitive. Wildcard `*` ditolak bila cwd tersedia
  // (bisa mengembang ke .env / .minicode).
  // `for /f ... in (<set>) do ...` = pembaca berkas bawaan cmd.exe, tanpa
  // utilitas apa pun. Ia loop, bukan pembaca, jadi namanya tidak ada di
  // READERS — ekstraksi terpisah ini yang membuat `for /f %i in (.env) do
  // @echo %i` ikut diperiksa (temuan F3 audit 2026-09-20: `type .env` ditahan
  // tapi `for /f` terhadap berkas yang sama lolos).
  const forFileSets = (() => {
    const out: string[] = []
    // Anchor pada `\bin\s*\(` agar opsi `"eol=("` sebelum `in (.env)` tidak
    // memotong regex sebelum daftar file yang sesungguhnya.
    const re = /\bfor\s+\/[a-z]*f[a-z]*\b[^\n]*?\bin\s*\(\s*([^)\n]*)\)/gi
    for (const m of norm.matchAll(re)) {
      for (const rawTok of m[1]!.split(/[\s,]+/)) {
        const tok = rawTok.trim()
        if (tok && !tok.startsWith("-")) out.push(tok)
      }
    }
    return out
  })()

  if (both(READERS) || forFileSets.length > 0) {
    const readerTargets = (() => {
      const out: string[] = []
      const re =
        /\b(cat|bat|less|more|head|tail|nl|od|xxd|strings|type|Get-Content|gc|certutil|tac|findstr|fc|comp|cp|copy|mv|move|scp|rsync|tar|zip|u[n]zip|7z|gzip|base64|openssl|awk|sed|grep|egrep|fgrep|rg|cut|sort|uniq|tee|dd|install|diff|patch|xcopy|robocopy|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Expand-Archive|Compress-Archive|Select-String|sls)\b\s+([^\n;&|]+)/gi
      const WIN_SWITCH_CMDS = /^(?:findstr|fc|comp|copy|xcopy|robocopy|sort)$/i
      for (const m of norm.matchAll(re)) {
        const cmdName = m[1]!
        const isWinSwitchCmd = process.platform === "win32" || WIN_SWITCH_CMDS.test(cmdName)
        const args = m[2]!.split(/\s+/)
        for (const a of args) {
          if (!a) continue
          // PowerShell menerima bentuk `-Path: nilai` TANPA spasi
          // (`Set-Content -Path:.minicode/hooks/x.js`). Token itu diawali `-`
          // sehingga loop lama melewatinya sebagai flag — hook lolos. Kupas
          // nilai setelah ':' supaya pemeriksaan hook/jail di bawah tetap
          // melihat targetnya, sama seperti bentuk `-Path nilai` (spasi).
          const colonVal = /^-[A-Za-z][A-Za-z0-9]*:(.+)$/.exec(a)
          if (colonVal) {
            const cv = colonVal[1]!.trim()
            if (cv) out.push(cv)
            continue
          }
          // Opsi GNU `--output=../out`, `--file=.env`, `--target-directory=..`:
          // nilai path menempel di kanan `=` — kupas agar tetap kena jail/hook.
          const longEqVal = /^--[A-Za-z0-9_-]+=(.+)$/.exec(a)
          if (longEqVal) {
            const lv = longEqVal[1]!.trim()
            if (
              lv &&
              (/^[.~/\\]|^[A-Za-z]:[\\/]|[/\\]/.test(lv) || isSensitive(lv) || isOwnedHook(lv))
            ) {
              out.push(lv)
            }
            continue
          }
          // Opsi pendek dengan path menempel (`sort -o../out`, `rg -f.env`, `tar -f../a`):
          // hanya dorong jika nilainya berbentuk path / sensitif / hook agar flag
          // biasa (`grep -oE`, `awk -F:`) tidak false-positive.
          const shortAttached = /^-(?:o|O|f|T|w|i)(.+)$/.exec(a)
          if (shortAttached) {
            const sv = shortAttached[1]!.trim()
            if (
              sv &&
              (/^[.~/\\]|^[A-Za-z]:[\\/]|[/\\]/.test(sv) || isSensitive(sv) || isOwnedHook(sv))
            ) {
              out.push(sv)
            }
            continue
          }
          if (a.startsWith("-")) continue
          // `dd if=... of=...` → kupas prefix if=/of= agar targetnya tetap tercek.
          const ddVal = /^(?:if|of)=(.+)$/i.exec(a)
          if (ddVal) {
            const dv = ddVal[1]!.trim()
            if (dv) out.push(dv)
            continue
          }
          // Flag cmd.exe Windows berawalan `/` (mis. `findstr /n /c:err log.txt`,
          // `copy /y`, `fc /b`) bukan path root POSIX — lewati agar tidak ditolak
          // sebagai `outside workspace`, sambil tetap menjaga `/etc/...` atau `/f:...`.
          if (isWinSwitchCmd && /^\/[a-zA-Z]{1,2}$/.test(a)) continue
          if (/^findstr$/i.test(cmdName) && /^\/c:/i.test(a)) continue
          const t = a.trim()
          if (!t) continue
          out.push(t)
        }
      }
      return out
    })()
    for (const t of [...readerTargets, ...forFileSets]) {
      // Argumen berpola %VAR% tak bisa dipastikan menunjuk ke mana: cmd.exe
      // mengekspansi SETELAH cek statis, sementara resolve() melihatnya
      // sebagai jalur relatif DI DALAM cwd — `type %USERPROFILE%\notes.txt`
      // lolos padahal target redirect berpola sama ditahan di blok di atas
      // (temuan F2 audit 2026-09-20). Fail-closed: minta path eksplisit.
      // `%` tunggal (`100%.txt`) tetap lolos karena bukan pola ekspansi.
      if (/%[^%\s]+%/.test(t))
        return { denied: true, reason: "reader target with env expansion (%VAR%)" }
      // Glob `?` dan `[abc]` sama-sama mengembang ke nama lain: `cat .?nv`
      // membaca `.env` walau tak ada `*`. Hanya diperiksa untuk token yang
      // berbentuk path (berawalan `.`/`~`/`/`, drive letter, atau memuat
      // pemisah path) supaya pola grep/awk seperti `a[0-9]` tidak terblokir.
      const pathLike = /^[.~/]|^[A-Za-z]:[\\/]|[/\\]/.test(t)
      if (t.includes("*") || (pathLike && /[*?[]/.test(t))) {
        // Wildcard di READER bisa mengembang ke .env/.minicode — tolak bila
        // cwd tersedia (butuh path eksplisit). Tanpa cwd, heuristik sensitif.
        if (cwd != null) return { denied: true, reason: "reader wildcard" }
        if (isSensitive(t) || isOwnedState(t)) return { denied: true, reason: "reader wildcard" }
      }
      // Nama target yang dihitung shell tak bisa dipastikan statis:
      // `cat$(printf ' ')` membaca `.env` tanpa pernah menampakkan nama itu.
      if (/^\$\(|^`/.test(t)) return { denied: true, reason: "reader command substitution" }
      if (
        isSensitive(t) ||
        isSensitive(resolve(cwd ?? ".", t)) ||
        (cwd != null && isSensitiveReal(resolve(cwd, t), containmentRoot!))
      ) {
        return { denied: true, reason: "sensitive file access" }
      }
      // Keputusan owner 2026-11-23: baca `.minicode/` lewat shell kini BOLEH
      // (pembaca tool sudah mengizinkan sejak awal). SATU-SATUNYA yang tetap
      // dikunci = skrip hook (audit 2026-11-12): READERS mencakup cp/mv/copy/
      // Set-Content/New-Item/... yang bisa MENANAM hook, jadi pemeriksaan ini
      // WAJIB paralel dengan blok redirect di atas. String + realpath dipakai
      // supaya junction/symlink internal tak bisa menyamarkan target hook;
      // bentuk `-Path`/`-Target` dengan spasi sudah tertangkap oleh ekstraksi
      // readerTargets di atas (nilainya jadi token tersendiri).
      // Efek samping `cat .minicode/hooks/x.js` ikut ditahan — fail-closed,
      // sengaja daripada membedakan pembaca murni dari penulis di loop ini.
      if (cwd != null) {
        const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
        if (isOwnedHook(t) || isOwnedHook(abs) || isOwnedHookReal(abs, containmentRoot!))
          return { denied: true, reason: "hook file write" }
        if (isRealPathOutsideRoot(abs, containmentRoot!))
          return { denied: true, reason: "outside workspace" }
      } else {
        if (isOwnedHook(t)) return { denied: true, reason: "hook file write" }
        if (/^\.\.(?:[\\/]|$)|\b[a-zA-Z]:[\\/]|^\/(?!dev\/null$)|^~(?:[\\/]|$)/.test(t)) {
          return { denied: true, reason: "outside workspace" }
        }
      }
    }
  }

  return { denied: false }
}
