#!/usr/bin/env bun
// Gerbang bin untuk npm. Bin berupa berkas `.ts` kurang disukai tooling npm,
// dan path bin dengan prefix `./` memicu warning `"bin[...] ... invalid and removed"`
// saat publish. Wrapper `.js` ini memuat entry tipis (cli/entry.ts) yang menjawab
// meta flag lebih awal; argv lain diteruskan ke cli/index.ts (seluruh logika ada
// di sana). package.json bin TETAP menunjuk ke berkas ini.
import "./entry.ts"
