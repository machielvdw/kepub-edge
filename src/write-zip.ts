import { tooLarge } from "./error.js"
import {
  encodeName,
  MAX_OUTPUT_BYTES,
  updateCrc,
  type ZipArchive,
  type ZipEntry,
} from "./zip.js"

export type Replacement = () => AsyncIterable<Uint8Array>

interface WrittenEntry {
  name: Uint8Array
  method: 0 | 8
  descriptor: boolean
  crc: number
  compressedSize: number
  uncompressedSize: number
  offset: number
  externalAttributes: number
}

function header(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length)
  return { bytes, view: new DataView(bytes.buffer) }
}

function localHeader(entry: WrittenEntry, descriptor: boolean): Uint8Array {
  const { bytes, view } = header(30)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x0800 | (descriptor ? 0x0008 : 0), true)
  view.setUint16(8, entry.method, true)
  view.setUint16(12, 33, true) // 1980-01-01, the DOS ZIP epoch.
  if (!descriptor) {
    view.setUint32(14, entry.crc, true)
    view.setUint32(18, entry.compressedSize, true)
    view.setUint32(22, entry.uncompressedSize, true)
  }
  view.setUint16(26, entry.name.byteLength, true)
  return bytes
}

function descriptor(entry: WrittenEntry): Uint8Array {
  const { bytes, view } = header(16)
  view.setUint32(0, 0x08074b50, true)
  view.setUint32(4, entry.crc, true)
  view.setUint32(8, entry.compressedSize, true)
  view.setUint32(12, entry.uncompressedSize, true)
  return bytes
}

function centralHeader(entry: WrittenEntry): Uint8Array {
  const { bytes, view } = header(46)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, 0x0800 | (entry.descriptor ? 0x0008 : 0), true)
  view.setUint16(10, entry.method, true)
  view.setUint16(14, 33, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, entry.compressedSize, true)
  view.setUint32(24, entry.uncompressedSize, true)
  view.setUint16(28, entry.name.byteLength, true)
  view.setUint32(38, entry.externalAttributes, true)
  view.setUint32(42, entry.offset, true)
  return bytes
}

function endRecord(count: number, size: number, start: number): Uint8Array {
  const { bytes, view } = header(22)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, size, true)
  view.setUint32(16, start, true)
  return bytes
}

function iterableStream(
  source: AsyncIterable<Uint8Array>
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}

/**
 * Write a fresh ZIP32 archive. Unchanged entries keep their compressed data;
 * replacements are deflated and checksummed incrementally.
 */
export function writeZip(
  archive: ZipArchive,
  replacements: Map<string, Replacement>
): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const entries = [...archive.entries].sort(
      (a, b) => a.localStart - b.localStart
    )
    const written: WrittenEntry[] = []
    let offset = 0
    function account(chunk: Uint8Array): Uint8Array {
      offset += chunk.byteLength
      if (offset > MAX_OUTPUT_BYTES || offset > 0xffffffff)
        tooLarge("The converted KEPUB exceeds the allowed size.")
      return chunk
    }
    for (const original of entries) {
      const directory = original.name.endsWith("/")
      const replacement = directory
        ? undefined
        : replacements.get(original.name)
      const entry: WrittenEntry = {
        name: encodeName(original.name),
        method: directory ? 0 : replacement ? 8 : original.method,
        descriptor: !!replacement,
        crc: directory || replacement ? 0 : original.crc,
        compressedSize: directory || replacement ? 0 : original.compressedSize,
        uncompressedSize:
          directory || replacement ? 0 : original.uncompressedSize,
        offset,
        externalAttributes: original.externalAttributes,
      }
      if (entry.name.byteLength > 65535)
        tooLarge("A ZIP filename exceeds the allowed size.")
      yield account(localHeader(entry, !!replacement))
      yield account(entry.name)
      if (replacement) {
        let crc = 0xffffffff
        let size = 0
        let sourceError: unknown
        const counted = async function* (): AsyncGenerator<Uint8Array> {
          try {
            for await (const chunk of replacement()) {
              size += chunk.byteLength
              if (size > 50 * 1024 * 1024)
                tooLarge("A converted KEPUB entry exceeds the allowed size.")
              crc = updateCrc(crc, chunk)
              yield chunk
            }
          } catch (error) {
            // workerd's native CompressionStream can clone an Error and lose
            // its subclass prototype. Preserve the original public KepubError.
            sourceError = error
            throw error
          }
        }
        const compressed = (
          iterableStream(counted()) as ReadableStream<BufferSource>
        )
          .pipeThrough(new CompressionStream("deflate-raw"))
          .getReader()
        try {
          while (true) {
            const { done, value } = await compressed.read()
            if (done) break
            entry.compressedSize += value.byteLength
            yield account(value)
          }
        } catch (error) {
          throw sourceError ?? error
        } finally {
          await compressed.cancel().catch(() => undefined)
          compressed.releaseLock()
        }
        entry.uncompressedSize = size
        entry.crc = ~crc >>> 0
        yield account(descriptor(entry))
      } else if (!directory) {
        yield* copyCompressed(archive.bytes, original, account)
      }
      written.push(entry)
    }
    const centralStart = offset
    for (const entry of written) {
      yield account(centralHeader(entry))
      yield account(entry.name)
    }
    yield account(
      endRecord(written.length, offset - centralStart, centralStart)
    )
  }
  return iterableStream(chunks())
}

function* copyCompressed(
  bytes: Uint8Array,
  entry: ZipEntry,
  account: (chunk: Uint8Array) => Uint8Array
): Generator<Uint8Array> {
  for (let at = entry.dataStart; at < entry.dataEnd; at += 32 * 1024) {
    yield account(bytes.subarray(at, Math.min(entry.dataEnd, at + 32 * 1024)))
  }
}
