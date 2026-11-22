// E-29: BoundedQueue ring buffer — N=512 urutan FIFO identik, shift O(1),
// overflow/ack/cursor tidak berubah.
import { expect, test } from "bun:test"
import { BoundedQueue } from "../src/daemon/subscription.ts"

test("N=512: push/takeFirst urutan sama, O(1) per pengambilan", () => {
  const N = 512
  const q = new BoundedQueue<number>(N)
  for (let i = 0; i < N; i++) expect(q.push(i)).toBe(true)
  expect(q.size).toBe(N)
  expect(q.full).toBe(true)
  expect(q.push(999)).toBe(false)

  const got: number[] = []
  for (let i = 0; i < N; i++) got.push(q.shift() as number)
  expect(got).toEqual(Array.from({ length: N }, (_, i) => i))
  expect(q.size).toBe(0)
  expect(q.shift()).toBeUndefined()
})

test("shift + drain mempertahankan urutan sisa", () => {
  const q = new BoundedQueue<string>(8)
  for (const s of ["a", "b", "c", "d"]) q.push(s)
  expect(q.shift()).toBe("a")
  expect(q.shift()).toBe("b")
  q.push("e")
  expect(q.drain()).toEqual(["c", "d", "e"])
  expect(q.size).toBe(0)
  expect(q.full).toBe(false)
})

test("maxQueue=0 (seam uji socket tertahan) tetap overflow", () => {
  const q = new BoundedQueue<number>(0)
  expect(q.push(1)).toBe(false)
  expect(q.full).toBe(true)
})
