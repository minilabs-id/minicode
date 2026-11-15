import { expect, test } from "bun:test"
import { FakeProvider, finish, text, toolCall } from "#minicore/test/fakes.ts"
import { createMinicodeSession } from "../src/app/session.ts"

for (const axis of ["work-mode", "permission-mode"] as const) {
  for (const phase of ["preparation", "started"] as const) {
    for (const restore of [false, true]) {
      test(`A1: ${axis} revocation at ${phase} invalidates grants (restore=${restore})`, async () => {
        let revoke = () => {}
        let executions = 0
        const session = await createMinicodeSession({
          provider: new FakeProvider([
            {
              events: [
                toolCall("write_file", { path: "audit-placeholder.txt" }),
                finish("tool_calls"),
              ],
            },
            { events: [text("done"), finish("stop")] },
          ]),
          tools: [
            {
              name: "write_file",
              description: "in-memory effect counter",
              parameters: { type: "object", additionalProperties: true },
              async execute() {
                executions++
                return "ok"
              },
            },
          ],
          cwd: process.cwd(),
          workMode: "EXECUTE",
          permissionMode: "auto",
          noProgress: false,
          onWorkMode: (control) => {
            if (axis === "work-mode")
              revoke = () => {
                control.setWorkMode("DISCUSS")
                if (restore) control.setWorkMode("EXECUTE")
              }
          },
          onPermissions: (control) => {
            if (axis === "permission-mode")
              revoke = () => {
                control.setMode("readonly")
                if (restore) control.setMode("auto")
              }
          },
          beforeToolEffect: async () => {
            await Promise.resolve()
            if (phase === "preparation") revoke()
          },
        })
        if (phase === "started") session.events.on("execution:started", revoke)
        await session.run("verify revocation")
        expect(executions).toBe(0)
      })
    }
  }
}
