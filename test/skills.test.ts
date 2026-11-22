// BUG-1: argumen skill adalah DATA, bukan pola replacement String.replace.
// `$&`, `` $` ``, `$'` dan `$1` harus muncul apa adanya di prompt yang dirender.

import { describe, expect, test } from "bun:test"
import { renderSkill, type Skill } from "../src/skills/loader.ts"

const bodyWith = (placeholder: string): Skill => ({
  name: "probe",
  description: "probe",
  body: `SEBELUM ${placeholder} SESUDAH`,
  path: "/probe.md",
  manualOnly: false,
  assets: { scripts: [], references: [] },
})

describe("renderSkill: argument interpolation literal", () => {
  const literals = ["$&", "$`", "$'", "$1"]

  for (const placeholder of ["{{args}}", "$ARGUMENTS"]) {
    for (const arg of literals) {
      test(`${placeholder} dengan argumen ${JSON.stringify(arg)} tetap literal`, async () => {
        const rendered = await renderSkill(bodyWith(placeholder), arg)
        expect(rendered).toBe(`SEBELUM ${arg} SESUDAH`)
      })
    }

    test(`${placeholder} dengan keempat pola sekaligus`, async () => {
      const arg = literals.join(" ")
      const rendered = await renderSkill(bodyWith(placeholder), arg)
      expect(rendered).toBe(`SEBELUM ${arg} SESUDAH`)
    })
  }

  test("semua placeholder pada satu body menghasilkan teks yang sama", async () => {
    const skill: Skill = {
      name: "probe",
      description: "probe",
      body: "{{args}} | $ARGUMENTS",
      path: "/probe.md",
      manualOnly: false,
      assets: { scripts: [], references: [] },
    }
    const arg = "$& $` $' $1"
    expect(await renderSkill(skill, arg)).toBe(`${arg} | ${arg}`)
  })
})
