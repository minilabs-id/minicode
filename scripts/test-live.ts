// Wrapper untuk `bun run test:live` — menjalankan bun test dengan MINICODE_LIVE=1.
import { spawn } from "node:child_process"

const child = spawn(process.execPath, ["test", "test/extreme-live.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, MINICODE_LIVE: "1" },
})

// `code === null` berarti child dihentikan sinyal — itu kegagalan, bukan sukses.
child.on("exit", (code) => process.exit(code === null ? 1 : code))
// spawn gagal (mis. runtime tak ditemukan) memancarkan `error`, bukan `exit`.
child.on("error", (err) => {
  console.error("[test-live] gagal menjalankan child:", err)
  process.exit(1)
})
