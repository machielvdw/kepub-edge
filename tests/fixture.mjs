import { deflateRawSync } from "node:zlib"

const cover = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
)

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return ~crc >>> 0
}

export function makeEpub({
  version = 3,
  chapters = ["First sentence. Second sentence."],
  withCover = false,
  fixedLayout = false,
  extraEntries = [],
  zipFlags = 0x0800,
  navInSpine = false,
  transformChapter = (xhtml) => xhtml,
} = {}) {
  const isThree = version === 3
  const items = chapters
    .map(
      (_, index) =>
        `<item id="chapter-${index + 1}" href="chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`
    )
    .join("")
  const spine = chapters
    .map((_, index) => `<itemref idref="chapter-${index + 1}"/>`)
    .join("")
  const packageXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${isThree ? "3.0" : "2.0"}" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:594d5589-e411-4990-89e9-f51fa3a52737</dc:identifier><dc:title>kepub-edge fixture</dc:title><dc:language>en</dc:language>${isThree ? '<meta property="dcterms:modified">2026-10-25T00:00:00Z</meta>' : ""}${withCover && !isThree ? '<meta name="cover" content="cover"/>' : ""}${fixedLayout ? (isThree ? '<meta property="rendition:layout">pre-paginated</meta>' : '<meta name="fixed-layout" content="true"/>') : ""}</metadata>
<manifest>${isThree ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}${items}${withCover ? `<item id="cover" href="cover.png" media-type="image/png"${isThree ? ' properties="cover-image"' : ""}/>` : ""}</manifest>
<spine${isThree ? "" : ' toc="ncx"'}>${isThree && navInSpine ? '<itemref idref="nav"/>' : ""}${spine}</spine></package>`
  const entries = [
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    {
      name: "META-INF/container.xml",
      data: '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      method: 8,
    },
    { name: "OEBPS/content.opf", data: packageXml, method: 8 },
    ...(isThree
      ? [
          {
            name: "OEBPS/nav.xhtml",
            data: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter-1.xhtml">Chapter</a></li></ol></nav></body></html>',
            method: 8,
          },
        ]
      : [
          {
            name: "OEBPS/toc.ncx",
            data: `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:594d5589-e411-4990-89e9-f51fa3a52737"/></head><docTitle><text>kepub-edge fixture</text></docTitle><navMap><navPoint id="nav1" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter-1.xhtml"/></navPoint></navMap></ncx>`,
            method: 8,
          },
        ]),
    ...chapters.map((text, index) => ({
      name: `OEBPS/chapter-${index + 1}.xhtml`,
      data: transformChapter(
        `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${index + 1}</title></head><body><h1>Chapter ${index + 1}</h1><p>${text}</p><p><em>Inline</em> content &amp; entities.</p></body></html>`
      ),
      method: 8,
    })),
    ...(withCover ? [{ name: "OEBPS/cover.png", data: cover, method: 8 }] : []),
    ...extraEntries,
  ]
  return writeZip(entries, zipFlags)
}

function writeZip(entries, zipFlags) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const compressed = entry.method === 8 ? deflateRawSync(data) : data
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(zipFlags, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(zipFlags, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, end])
}
