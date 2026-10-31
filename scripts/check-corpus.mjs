import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  convertEpubToKepubBlob,
  KEPUB_CONVERTER_VERSION,
} from "../dist/index.js"

const inputs = process.argv.slice(2)
if (!inputs.length) {
  console.error(
    "Usage: node scripts/check-corpus.mjs book.epub [another.epub ...]"
  )
  process.exit(1)
}
const endpoint = process.env.KEPUB_WORKER_URL
const jar = process.env.EPUBCHECK_JAR
const temp = await mkdtemp(join(tmpdir(), "kepub-corpus-"))
try {
  for (const path of inputs) {
    const report = {
      file: basename(path),
      converterVersion: KEPUB_CONVERTER_VERSION,
      runtime: endpoint ? "worker-http" : `node ${process.version}`,
      epubcheck: jar ? "pending" : "not_run",
    }
    try {
      const input = new Uint8Array(await readFile(path))
      report.sha256 = createHash("sha256").update(input).digest("hex")
      report.inputBytes = input.byteLength
      if (jar) execFileSync("java", ["-jar", jar, path], { stdio: "pipe" })
      const cpu = process.cpuUsage()
      const start = performance.now()
      let output
      if (endpoint) {
        const response = await fetch(endpoint, { method: "POST", body: input })
        if (!response.ok)
          throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        output = new Uint8Array(await response.arrayBuffer())
      } else {
        output = new Uint8Array(
          await (await convertEpubToKepubBlob(input)).arrayBuffer()
        )
      }
      report.elapsedMs = Number((performance.now() - start).toFixed(2))
      if (!endpoint) {
        const used = process.cpuUsage(cpu)
        report.nodeCpuMs = Number(((used.user + used.system) / 1000).toFixed(2))
      }
      report.outputBytes = output.byteLength
      if (jar) {
        const resultPath = join(temp, "output.kepub.epub")
        await writeFile(resultPath, output)
        execFileSync("java", ["-jar", jar, resultPath], { stdio: "pipe" })
        report.epubcheck = "passed_input_and_output"
      }
      report.status = "passed"
    } catch (error) {
      report.status = "failed"
      report.error = error instanceof Error ? error.message : String(error)
      if (jar && report.epubcheck === "pending") report.epubcheck = "incomplete"
      process.exitCode = 1
    }
    console.log(JSON.stringify(report))
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
