import { expect, spyOn, test } from "bun:test"
import { TRANSCRIPT_CAP, Transcript } from "../src/ui/tui/transcript.ts"
import { createFakeBus } from "./helpers/tui-harness.ts"

test("retention preserves projections of unchanged rows and recomputes on resize", () => {
  const transcript = new Transcript(createFakeBus() as never)
  const internal = transcript as unknown as { projectText: (...args: unknown[]) => unknown }
  const project = spyOn(internal, "projectText")
  try {
    transcript.pushInfo(Array.from({ length: TRANSCRIPT_CAP }, (_, i) => `line-${i}`))
    transcript.view(80, 20, 0)
    project.mockClear()
    for (let i = 0; i < 20; i++) {
      transcript.pushInfo([`new-${i}`])
      transcript.view(80, 20, 0)
    }
    // Each append projects its new row and the changed eviction marker.
    expect(project.mock.calls.length).toBeLessThanOrEqual(40)
    expect(transcript.size()).toBe(TRANSCRIPT_CAP + 1)
    expect(transcript.view(80, 1, 0)[0]).toContain("new-19")
    project.mockClear()
    transcript.view(40, 20, 0)
    expect(project.mock.calls.length).toBeGreaterThanOrEqual(TRANSCRIPT_CAP)
    expect(transcript.view(40, 1, TRANSCRIPT_CAP)[0]).toBeDefined()
  } finally {
    project.mockRestore()
  }
})
