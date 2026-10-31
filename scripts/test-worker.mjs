import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL("../", import.meta.url))
const server = createServer()
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const port = server.address().port
await new Promise((resolve) => server.close(resolve))
const url = `http://127.0.0.1:${port}`

const worker = spawn(
  process.execPath,
  [
    resolve(
      dirname(require.resolve("wrangler/package.json")),
      require("wrangler/package.json").bin.wrangler
    ),
    "dev",
    "--config",
    "examples/worker/wrangler.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--local",
  ],
  {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  }
)
let log = ""
let exited = false
let spawnError
const completion = new Promise((resolve) => {
  worker.once("exit", () => {
    exited = true
    resolve()
  })
  worker.once("error", (error) => {
    spawnError = error
    exited = true
    resolve()
  })
})
for (const stream of [worker.stdout, worker.stderr])
  stream.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-65536)
  })

try {
  const deadline = Date.now() + 30_000
  while (true) {
    if (exited)
      throw spawnError ?? new Error("Wrangler exited before becoming ready.")
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the local Worker.")
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      await response.arrayBuffer()
      if (response.status === 405) break
    } catch {
      /* Wait for the server to bind its socket. */
    }
    await delay(200)
  }
  const tests = spawn(process.execPath, ["--test", "tests/worker.test.mjs"], {
    cwd: root,
    env: { ...process.env, KEPUB_WORKER_URL: url },
    stdio: "inherit",
  })
  const code = await new Promise((resolve, reject) => {
    tests.once("error", reject)
    tests.once("exit", (code) => resolve(code ?? 1))
  })
  if (code !== 0) throw new Error(`Worker tests exited with code ${code}.`)
} catch (error) {
  console.error(log)
  console.error(error)
  process.exitCode = 1
} finally {
  worker.kill("SIGTERM")
  await Promise.race([completion, delay(5000, undefined, { ref: false })])
  if (!exited) {
    worker.kill("SIGKILL")
    await completion
  }
}
