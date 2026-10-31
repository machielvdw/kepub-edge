import { invalid, tooLarge, unsupported } from "./error.js"

export const MAX_INPUT_BYTES = 25 * 1024 * 1024
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 128 * 1024 * 1024

const MAX_ENTRIES = 4096
const CHUNK_BYTES = 32 * 1024
const decoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

export interface ZipEntry {
  readonly name: string
  readonly method: 0 | 8
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly dataStart: number
  readonly dataEnd: number
  readonly localStart: number
  readonly externalAttributes: number
}

export interface ZipArchive {
  readonly bytes: Uint8Array
  readonly entries: ZipEntry[]
  readonly byName: Map<string, ZipEntry>
}

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true)
}

function u32(view: DataView, at: number): number {
  return view.getUint32(at, true)
}

function safeName(name: string, directory: boolean): void {
  const path = directory ? name.slice(0, -1) : name
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(path)
  ) {
    invalid("The EPUB has an unsafe ZIP filename.")
  }
}

function checkExtra(view: DataView, start: number, length: number): void {
  const end = start + length
  for (let at = start; at < end;) {
    if (at + 4 > end) invalid("The EPUB has a malformed ZIP extra field.")
    const kind = u16(view, at)
    const size = u16(view, at + 2)
    at += 4 + size
    if (at > end) invalid("The EPUB has a malformed ZIP extra field.")
    if (kind === 0x0001 || kind === 0x9901)
      unsupported("ZIP64 and encrypted EPUBs are not supported.")
  }
}

/** Parse ZIP32 metadata without inflating images, fonts, or chapters. */
export function parseZip(bytes: Uint8Array): ZipArchive {
  if (bytes.length > MAX_INPUT_BYTES) tooLarge("The EPUB exceeds 25 MiB.")
  if (bytes.length < 22) invalid("The file is not a ZIP archive.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 22 - 65535);
    at--
  ) {
    if (
      u32(view, at) === 0x06054b50 &&
      at + 22 + u16(view, at + 20) === bytes.length
    ) {
      end = at
      break
    }
  }
  if (end < 0) invalid("The ZIP central directory is missing.")
  if (u16(view, end + 4) || u16(view, end + 6))
    unsupported("Multi-disk ZIP archives are not supported.")
  const count = u16(view, end + 10)
  const centralSize = u32(view, end + 12)
  const centralStart = u32(view, end + 16)
  if (
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralStart === 0xffffffff
  )
    unsupported("ZIP64 EPUBs are not supported.")
  if (!count || count > MAX_ENTRIES || count !== u16(view, end + 8))
    invalid("The ZIP entry count is invalid.")
  if (centralStart + centralSize !== end)
    invalid("The ZIP central directory is malformed.")

  const entries: ZipEntry[] = []
  const byName = new Map<string, ZipEntry>()
  const foldedNames = new Set<string>()
  const ranges: Array<[number, number]> = []
  let totalExpanded = 0
  let at = centralStart
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || u32(view, at) !== 0x02014b50)
      invalid("The ZIP central directory is malformed.")
    const flags = u16(view, at + 8)
    const method = u16(view, at + 10)
    const crc = u32(view, at + 16)
    const compressedSize = u32(view, at + 20)
    const uncompressedSize = u32(view, at + 24)
    const nameLength = u16(view, at + 28)
    const extraLength = u16(view, at + 30)
    const commentLength = u16(view, at + 32)
    const localStart = u32(view, at + 42)
    const externalAttributes = u32(view, at + 38)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (!nameLength || next > end || u16(view, at + 34))
      invalid("The ZIP central directory is malformed.")
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localStart === 0xffffffff
    )
      unsupported("ZIP64 EPUBs are not supported.")
    if (flags & (0x0001 | 0x0040 | 0x2000))
      unsupported("Encrypted EPUBs are not supported.")
    // ZIP bit 4 is set by some EPUB producers even on stored entries. Only
    // supported methods are accepted, and inflated entries are CRC-checked.
    if (flags & ~0x081e)
      unsupported("The EPUB uses an unsupported ZIP feature.")
    if (method !== 0 && method !== 8)
      unsupported("The EPUB uses an unsupported ZIP compression method.")
    const fileKind = (externalAttributes >>> 16) & 0xf000
    if (fileKind && fileKind !== 0x8000 && fileKind !== 0x4000)
      invalid("The EPUB contains a special file or symbolic link.")

    let name: string
    try {
      name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    } catch {
      invalid("The EPUB has an invalid UTF-8 ZIP filename.")
    }
    const directory = name.endsWith("/")
    if (
      directory &&
      (uncompressedSize !== 0 ||
        (method === 0 && compressedSize !== 0) ||
        (method === 8 && compressedSize > 64))
    )
      invalid("A ZIP directory contains data.")
    safeName(name, directory)
    const folded = name.toLocaleLowerCase("en-US")
    if (foldedNames.has(folded))
      invalid("The EPUB has duplicate ZIP filenames.")
    foldedNames.add(folded)
    checkExtra(view, at + 46 + nameLength, extraLength)
    if (
      uncompressedSize > MAX_ENTRY_BYTES ||
      uncompressedSize > Math.max(1, compressedSize) * 1000
    )
      tooLarge("An EPUB entry expands beyond the allowed limit.")
    totalExpanded += uncompressedSize
    if (totalExpanded > MAX_EXPANDED_BYTES)
      tooLarge("The EPUB expands beyond the allowed limit.")
    if (method === 0 && compressedSize !== uncompressedSize)
      invalid("A stored ZIP entry has inconsistent sizes.")
    if (localStart + 30 > centralStart || u32(view, localStart) !== 0x04034b50)
      invalid("The EPUB has a malformed local ZIP header.")
    const localFlags = u16(view, localStart + 6)
    const localMethod = u16(view, localStart + 8)
    const localNameLength = u16(view, localStart + 26)
    const localExtraLength = u16(view, localStart + 28)
    const dataStart = localStart + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (
      dataEnd > centralStart ||
      localNameLength !== nameLength ||
      localFlags !== flags ||
      localMethod !== method
    )
      invalid("The EPUB has inconsistent ZIP headers.")
    for (let j = 0; j < nameLength; j++) {
      if (bytes[localStart + 30 + j] !== bytes[at + 46 + j])
        invalid("The EPUB has inconsistent ZIP filenames.")
    }
    if (!(flags & 0x0008)) {
      if (
        u32(view, localStart + 14) !== crc ||
        u32(view, localStart + 18) !== compressedSize ||
        u32(view, localStart + 22) !== uncompressedSize
      )
        invalid("The EPUB has inconsistent ZIP entry sizes.")
    }
    checkExtra(view, localStart + 30 + localNameLength, localExtraLength)
    const entry: ZipEntry = {
      name,
      method: method as 0 | 8,
      crc,
      compressedSize,
      uncompressedSize,
      dataStart,
      dataEnd,
      localStart,
      externalAttributes,
    }
    entries.push(entry)
    byName.set(name, entry)
    ranges.push([localStart, dataEnd])
    at = next
  }
  if (at !== end) invalid("The ZIP central directory has trailing data.")
  ranges.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1])
      invalid("The EPUB contains overlapping ZIP entries.")
  }
  const mime = byName.get("mimetype")
  if (!mime || mime.localStart !== 0 || mime.method !== 0)
    invalid("The EPUB must start with an uncompressed mimetype entry.")
  const mimeBytes = bytes.subarray(mime.dataStart, mime.dataEnd)
  if (decoder.decode(mimeBytes) !== "application/epub+zip")
    invalid("The EPUB mimetype is invalid.")
  if (~updateCrc(0xffffffff, mimeBytes) >>> 0 !== mime.crc)
    invalid("The EPUB mimetype failed its ZIP checksum.")
  return { bytes, entries, byName }
}

const crcTable = new Uint32Array(256)
for (let value = 0; value < 256; value++) {
  let crc = value
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  crcTable[value] = crc >>> 0
}

export function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc >>> 0
}

function chunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) return controller.close()
      const end = Math.min(bytes.length, at + CHUNK_BYTES)
      controller.enqueue(new Uint8Array(bytes.subarray(at, end)))
      at = end
    },
  })
}

/** Inflate one entry lazily and verify its size and checksum while consumed. */
export async function* inflateEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  limit = MAX_ENTRY_BYTES
): AsyncGenerator<Uint8Array> {
  if (entry.uncompressedSize > limit)
    tooLarge("An EPUB entry exceeds the allowed size.")
  const compressed = archive.bytes.subarray(entry.dataStart, entry.dataEnd)
  const stream =
    entry.method === 0
      ? chunkStream(compressed)
      : (chunkStream(compressed) as ReadableStream<BufferSource>).pipeThrough(
          new DecompressionStream("deflate-raw")
        )
  // Both branches emit Uint8Array chunks. BufferSource only widens the writable
  // side of DecompressionStream's TypeScript definition.
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  let size = 0
  let crc = 0xffffffff
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit || size > entry.uncompressedSize)
        tooLarge("An EPUB entry expands beyond the allowed size.")
      crc = updateCrc(crc, value)
      yield value
    }
  } catch (error) {
    if (error instanceof Error && error.name === "KepubError") throw error
    invalid("An EPUB entry could not be decompressed.")
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (size !== entry.uncompressedSize || ~crc >>> 0 !== entry.crc)
    invalid("An EPUB entry failed its ZIP checksum.")
}

export async function readSmallEntry(
  archive: ZipArchive,
  entry: ZipEntry,
  limit: number
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const part of inflateEntry(archive, entry, limit)) {
    size += part.byteLength
    parts.push(part)
  }
  const result = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    result.set(part, at)
    at += part.byteLength
  }
  return result
}

export function encodeName(name: string): Uint8Array {
  return encoder.encode(name)
}
