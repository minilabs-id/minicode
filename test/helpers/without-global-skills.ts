// Isolasi skill global mesin untuk satu test, TANPA mengubah home/skill asli.
//
// `src/skills/loader.ts` mengunci `GLOBAL_SKILLS = homedir()/.minicode/skills`
// di module scope dan tidak membaca `MINICODE_HOME` (bedanya modul config/db).
// Akibatnya set `HOME`/`USERPROFILE` di fixture terlambat — konstanta sudah
// beku sebelum test berjalan. Alih-alih mengubah API source, kita sembunyikan
// direktori itu dari `readdir` yang dipakai loader selama test berlangsung,
// lalu kembalikan. Test yang menguji SKILL GLOBAL secara eksplisit tidak boleh
// memakai helper ini.
import { spyOn } from "bun:test"
import * as fsp from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { invalidateSkillCache } from "../../src/skills/loader.ts"

const GLOBAL_SKILLS = resolve(join(homedir(), ".minicode", "skills"))

/** Kembalikan fungsi restore; panggil di `finally` agar spy tak bocor. */
export function withoutGlobalSkills(): () => void {
  const realReaddir = fsp.readdir
  invalidateSkillCache()
  const spy = spyOn(fsp, "readdir").mockImplementation(((
    ...args: Parameters<typeof realReaddir>
  ) => {
    if (resolve(String(args[0])) === GLOBAL_SKILLS) return Promise.resolve([]) as never
    return (realReaddir as (...a: unknown[]) => unknown)(...args)
  }) as typeof realReaddir)
  return () => {
    spy.mockRestore()
    invalidateSkillCache()
  }
}
