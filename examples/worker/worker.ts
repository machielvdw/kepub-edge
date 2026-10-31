import { convertEpubToKepubBlob, KepubError } from "kepub-edge"

const MAX_INPUT_BYTES = 25 * 1024 * 1024

// Count actual bytes: Content-Length alone is not an upload limit.
async function readInput(request: Request): Promise<Uint8Array> {
  if (!request.body)
    throw new KepubError("invalid_epub", "An EPUB body is required.")
  const declared = Number(request.headers.get("Content-Length"))
  if (declared > MAX_INPUT_BYTES)
    throw new KepubError("too_large", "The EPUB exceeds 25 MiB.")
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_INPUT_BYTES)
        throw new KepubError("too_large", "The EPUB exceeds 25 MiB.")
      parts.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const input = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    input.set(part, offset)
    offset += part.byteLength
  }
  return input
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("POST an EPUB body to convert it.", {
        status: 405,
        headers: { Allow: "POST" },
      })
    try {
      // Collect before sending headers so late chapter errors return JSON,
      // rather than a truncated download with an already-sent 200 response.
      const output = await convertEpubToKepubBlob(await readInput(request))
      return new Response(output, {
        headers: {
          "Content-Type": "application/epub+zip",
          "Content-Disposition": 'attachment; filename="book.kepub.epub"',
          "Cache-Control": "no-store",
        },
      })
    } catch (error) {
      if (!(error instanceof KepubError)) throw error
      return Response.json(
        { code: error.code, error: error.message },
        { status: error.code === "too_large" ? 413 : 422 }
      )
    }
  },
}
