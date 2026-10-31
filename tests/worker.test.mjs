import assert from "node:assert/strict"
import { test } from "node:test"
import { makeEpub } from "./fixture.mjs"

const base = process.env.KEPUB_WORKER_URL
const workerTest = (name, fn) => test(name, { skip: !base }, fn)
const convert = (body) => fetch(base, { method: "POST", body })

workerTest(
  "standalone Worker converts a navigation page in the spine",
  async () => {
    const response = await convert(makeEpub({ navInSpine: true }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("Content-Type"), "application/epub+zip")
    assert.match(
      response.headers.get("Content-Disposition"),
      /book\.kepub\.epub/
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.deepEqual([...bytes.subarray(0, 4)], [80, 75, 3, 4])
  }
)

workerTest(
  "standalone Worker reports malformed, unsupported, and late failures",
  async () => {
    for (const [body, code] of [
      [new Uint8Array([1, 2, 3]), "invalid_epub"],
      [makeEpub({ fixedLayout: true }), "unsupported_epub"],
      [makeEpub({ chapters: ["Broken <b>markup"] }), "invalid_epub"],
    ]) {
      const response = await convert(body)
      assert.equal(response.status, 422)
      assert.equal((await response.json()).code, code)
    }
  }
)

workerTest(
  "standalone Worker bounds chunked uploads without trusting Content-Length",
  async () => {
    let count = 0
    const body = new ReadableStream({
      pull(controller) {
        if (count++ === 26) return controller.close()
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const response = await fetch(base, { method: "POST", body, duplex: "half" })
    assert.equal(response.status, 413)
    assert.equal((await response.json()).code, "too_large")
  }
)

workerTest("standalone Worker rejects methods other than POST", async () => {
  const response = await fetch(base)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get("Allow"), "POST")
})
