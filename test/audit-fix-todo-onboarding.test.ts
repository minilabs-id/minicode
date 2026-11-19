// v7.35 — protokol todo_write diajarkan di wire contract, bukan hanya lewat
// error. Sesi audit ef40d265 mengirim full-declaration tanpa taskId dan kena
// TASK_IDENTITY_REQUIRED; deskripsi lama hanya bilang "Omit for a new task"
// tanpa mengatakan WAJIB todo_read dulu untuk item yang sudah ada.

import { expect, test } from "bun:test"
import { todoWriteTool } from "../src/tools/todo.ts"

test("todo_write: deskripsi mengajarkan todo_read + echo taskId sebelum re-send", () => {
  const d = todoWriteTool.description
  expect(d).toContain("todo_read")
  expect(d).toContain("taskId")
  expect(d).toContain("REJECTED")
  expect(d.toLowerCase()).toContain("never invented")
})

test("todo_write: tetap menyatakan aturan full-declaration & verification gate", () => {
  const d = todoWriteTool.description
  expect(d).toContain("full list, never a delta")
  expect(d).toContain("REFUSED")
})
