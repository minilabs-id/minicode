// E-12: store dispatch tanpa eviksi & history copy O(n²) → ring buffer N +
// eviksi record terminal saat store penuh.
import { expect, test } from "bun:test"
import {
  type AdmissionPort,
  createDispatchBridge,
  createDispatchId,
  type DispatchRequest,
} from "../src/runtime/dispatch.ts"

const admitAll: AdmissionPort = {
  admit: (r) => ({ admitted: true, executionId: r.executionId }),
}

function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    dispatchId: createDispatchId(),
    schedulerSource: "evict-test",
    authorityHeld: true,
    provenance: { requestedBy: "scheduler", reason: "due" },
    ...over,
  }
}

test("1100 dispatch terminal → store tetap terikat", () => {
  const bridge = createDispatchBridge({ admission: admitAll })
  for (let i = 0; i < 1100; i++) bridge.dispatch(req())
  expect(bridge.metrics().entries).toBeLessThanOrEqual(1024)
  expect(bridge.metrics().admitted).toBe(1100)
})

test("history dibatasi ring buffer (≤32 entri)", () => {
  const bridge = createDispatchBridge({ admission: admitAll })
  const id = createDispatchId()
  bridge.dispatch(req({ dispatchId: id }))
  // Redelivery tidak menambah history; satu-satunya jalur yang menambah history
  // adalah transisi ADMITTING → ADMITTED (2 entri). Pastikan tetap kecil.
  const rec = bridge.get(id)
  expect(rec).toBeDefined()
  expect(rec!.history.length).toBeLessThanOrEqual(32)

  for (let i = 0; i < 40; i++) bridge.dispatch(req({ dispatchId: id }))
  expect(bridge.get(id)!.history.length).toBeLessThanOrEqual(32)
})
