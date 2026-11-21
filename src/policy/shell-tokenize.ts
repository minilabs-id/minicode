// Tokenizer perintah shell untuk allowlist — SADAR PLATFORM.
//
// Riset: Node `spawn(cmd,{shell:true})` memakai `/bin/sh` di POSIX dan
// `ComSpec`/cmd.exe di Windows (dokumentasi child_process). Bash manual:
// backslash = escape character; single/double quotes = quoting. Dokumentasi
// cmd.exe: `^` = escape, `"` = quote, dan `'` BUKAN pembatas quote (karakter
// literal yang justru harus di-quote).
//
// Tokenizer lama memakai aturan POSIX di kedua platform → `echo hi ' & del x '`
// terlihat satu segmen di Windows, padahal cmd.exe menjalankan `del x`.
// Modul ini murni (tanpa I/O) dengan platform sebagai parameter agar bisa
// diuji silang.

export type ShellPlatform = "posix" | "win32"

export function currentShellPlatform(): ShellPlatform {
  return process.platform === "win32" ? "win32" : "posix"
}

/** Pecah perintah majemuk pada operator tingkat atas menjadi segmen.
 *  Fail-closed: escape/quote yang tak tertutup menghasilkan segmen utuh apa
 *  adanya — pemanggil tetap memeriksa setiap segmen terhadap allowlist. */
export function splitShellSegments(
  cmd: string,
  platform: ShellPlatform = currentShellPlatform(),
): string[] {
  const parts: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  const isWin = platform === "win32"

  const push = (): void => {
    const seg = cur.trim()
    if (seg) parts.push(seg)
    cur = ""
  }
  const control = (ch: string, next: string | undefined): boolean => {
    // cmd.exe: `&`, `|`, `||`, `&&`, newline. `;` bukan pemisah asli cmd, tapi
    // tetap dipecah (konservatif) supaya segmen tak menyembunyikan operator.
    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
      if ((ch === "&" || ch === "|") && next === ch) return true // && / ||
      return true
    }
    return false
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string
    const next = cmd[i + 1]
    if (quote === '"') {
      cur += ch
      // POSIX: backslash di dalam double-quote escape karakter berikutnya.
      // cmd.exe: backslash BUKAN escape di dalam quote (literal path separator).
      if (ch === "\\" && !isWin && next !== undefined) cur += cmd[++i] as string
      else if (ch === '"') quote = null
      continue
    }
    if (quote === "'") {
      // Hanya bisa terjadi di POSIX (win32 tak pernah membuka single quote).
      cur += ch
      if (ch === "\\" && next !== undefined) cur += cmd[++i] as string
      else if (ch === "'") quote = null
      continue
    }
    // Escape character di luar quote.
    if (ch === "\\" && !isWin && next !== undefined) {
      cur += ch + next
      i++
      continue
    }
    if (ch === "^" && isWin && next !== undefined) {
      cur += ch + next
      i++
      continue
    }
    // Quote: `'` hanya di POSIX; `"` di keduanya.
    if (ch === '"' || (ch === "'" && !isWin)) {
      quote = ch
      cur += ch
      continue
    }
    if (control(ch, next)) {
      if ((ch === "&" || ch === "|") && next === ch) i++
      push()
      continue
    }
    cur += ch
  }
  push()
  return parts
}

/** Verba mutasi berbahaya yang tak boleh lolos sebagai segmen allowlist,
 *  mesmo kalau ada pola allowlist yang kelewat longgar. Defense-in-depth. */
const DANGEROUS_VERBS =
  /^(?:del|erase|rm|rd|rmdir|mv|move|cp|copy|remove-item|move-item|copy-item)\b/i

export function isDangerousShellVerb(segment: string): boolean {
  const verb = segment.trim().replace(/^["'^]+/, "")
  return DANGEROUS_VERBS.test(verb)
}
