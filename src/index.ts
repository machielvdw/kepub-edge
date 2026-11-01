import { KepubError } from "./error.js"
import { inspectPublication } from "./publication.js"
import {
  inflateEntry,
  MAX_OUTPUT_BYTES,
  parseZip,
  readSmallEntry,
} from "./zip.js"
import { writeZip, type Replacement } from "./write-zip.js"
import { hasKoboSpans, transformXhtml } from "./xhtml.js"

export { KepubError }
export type { KepubErrorCode } from "./error.js"
/** Bump when converted output semantics change; persisted with each variant. */
export const KEPUB_CONVERTER_VERSION = "3"

/** Conservative collection cap; streaming output has a separate 128 MiB cap. */
export const DEFAULT_MAX_BLOB_BYTES = 35 * 1024 * 1024

/**
 * Convert an EPUB 2/3 to Kobo's enhanced EPUB format.
 *
 * The input is a bounded EPUB buffer (at most 25 MiB). The result is lazy: the caller
 * must consume the stream, and errors in a chapter can surface while reading.
 * Only container and package XML are buffered. Chapters are transformed and
 * compressed one at a time; unchanged media retains its compressed bytes.
 */
export async function convertEpubToKepub(
  input: Uint8Array
): Promise<ReadableStream<Uint8Array>> {
  const archive = parseZip(input)
  for (const entry of archive.entries) {
    if (entry.name.endsWith("/")) await readSmallEntry(archive, entry, 0)
  }
  const publication = await inspectPublication(archive)
  const replacements = new Map<string, Replacement>()
  for (const path of publication.contentPaths) {
    const entry = archive.byName.get(path)
    if (!entry)
      throw new KepubError("invalid_epub", "A reading document is missing.")
    replacements.set(path, async () =>
      // Inspect every chapter fully, even after finding a Kobo span. Ready
      // chapters retain their compressed bytes, markup, and reference IDs.
      (await hasKoboSpans(inflateEntry(archive, entry)))
        ? null
        : transformXhtml(inflateEntry(archive, entry))
    )
  }
  return writeZip(archive, replacements)
}

/**
 * Blob accepts output chunks directly, avoiding an additional contiguous
 * Uint8Array copy. The caller can set a lower cap before collecting chunks.
 */
export async function convertEpubToKepubBlob(
  input: Uint8Array,
  maxBytes = DEFAULT_MAX_BLOB_BYTES
): Promise<Blob> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_OUTPUT_BYTES
  )
    throw new RangeError(
      "maxBytes must be a positive integer no greater than 128 MiB."
    )
  const stream = await convertEpubToKepub(input)
  const reader = stream.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes)
        throw new KepubError(
          "too_large",
          "The converted KEPUB exceeds the allowed size."
        )
      // The chunk might view the original EPUB's backing buffer. Own its bytes
      // so a Blob never retains an entire input archive for one small slice.
      chunks.push(new Uint8Array(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return new Blob(chunks, { type: "application/epub+zip" })
}
