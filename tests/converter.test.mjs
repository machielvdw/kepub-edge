import assert from "node:assert/strict"
import { test } from "node:test"
import {
  convertEpubToKepub,
  convertEpubToKepubBlob,
  KepubError,
  DEFAULT_MAX_BLOB_BYTES,
} from "../dist/index.js"
import { parseZip, readSmallEntry } from "../dist/zip.js"
import { inspectXhtml, transformXhtml } from "../dist/xhtml.js"
import { makeEpub } from "./fixture.mjs"

async function converted(source) {
  const blob = await convertEpubToKepubBlob(source)
  return parseZip(new Uint8Array(await blob.arrayBuffer()))
}

async function text(archive, name) {
  const entry = archive.byName.get(name)
  assert.ok(entry, `missing ${name}`)
  return new TextDecoder().decode(
    await readSmallEntry(archive, entry, 50 * 1024 * 1024)
  )
}

test("preparing an existing KEPUB preserves every entry and its Kobo references", async () => {
  const first = await converted(makeEpub({ withCover: true, navInSpine: true }))
  const second = await converted(first.bytes)
  for (const entry of first.entries) {
    const after = second.byName.get(entry.name)
    assert.ok(after)
    assert.deepEqual(
      second.bytes.subarray(after.dataStart, after.dataEnd),
      first.bytes.subarray(entry.dataStart, entry.dataEnd),
      entry.name
    )
  }
})

test("repeated conversion preserves mixed chapters that do not need Kobo spans", async () => {
  for (const prefix of ["", "x:"]) {
    const bodies = [
      `<${prefix}p>Reading text.</${prefix}p>`,
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="cover.png" width="1" height="1"/></svg>',
      `<${prefix}pre>Preformatted text.</${prefix}pre>`,
      "",
    ]
    let chapterIndex = 0
    const source = makeEpub({
      chapters: bodies,
      withCover: true,
      transformChapter: () =>
        `<${prefix}html xmlns${prefix ? ":x" : ""}="http://www.w3.org/1999/xhtml"><${prefix}head><${prefix}title>Chapter</${prefix}title></${prefix}head><${prefix}body>${bodies[chapterIndex++]}</${prefix}body></${prefix}html>`,
    })
    const first = await converted(source)
    const second = await converted(first.bytes)
    for (let index = 0; index < bodies.length; index++) {
      const name = `OEBPS/chapter-${index + 1}.xhtml`
      const before = first.byName.get(name)
      const after = second.byName.get(name)
      assert.ok(before)
      assert.ok(after)
      assert.deepEqual(
        second.bytes.subarray(after.dataStart, after.dataEnd),
        first.bytes.subarray(before.dataStart, before.dataEnd),
        `${prefix || "default"} ${name}`
      )
      const markup = await text(second, name)
      assert.equal((markup.match(/id="book-columns"/g) ?? []).length, 1)
      assert.equal((markup.match(/id="book-inner"/g) ?? []).length, 1)
      if (index === 0) assert.match(markup, /class="koboSpan"/)
      else assert.doesNotMatch(markup, /class="koboSpan"/)
    }
  }
})

test("existing Kobo wrappers do not prevent text or images from gaining spans", async () => {
  for (const prefix of ["", "x:"]) {
    for (const content of [
      `<${prefix}p>Still needs conversion.</${prefix}p>`,
      `<${prefix}img src="cover.png" alt="Cover"/>`,
      `<${prefix}p> </${prefix}p>`,
    ]) {
      const output = await converted(
        makeEpub({
          withCover: true,
          transformChapter: () =>
            `<${prefix}html xmlns${prefix ? ":x" : ""}="http://www.w3.org/1999/xhtml"><${prefix}head><${prefix}title>Chapter</${prefix}title></${prefix}head><${prefix}body><${prefix}div id="book-columns"><${prefix}div id="book-inner">${content}</${prefix}div></${prefix}div></${prefix}body></${prefix}html>`,
        })
      )
      const markup = await text(output, "OEBPS/chapter-1.xhtml")
      assert.equal((markup.match(/id="book-columns"/g) ?? []).length, 1)
      assert.equal((markup.match(/id="book-inner"/g) ?? []).length, 1)
      assert.match(markup, /class="koboSpan"/)
    }
  }
})

test("wrapper detection requires the complete XHTML body wrapper structure", async () => {
  const pair = '<x:div id="book-columns"><x:div id="book-inner"/></x:div>'
  for (const [body, expected] of [
    [pair, true],
    [`\n<!-- cover -->${pair}\n`, true],
    [pair.replace("book-inner", "book-inn&#101;r"), true],
    [pair.replaceAll("x:div", "foreign:div"), false],
    [pair.replaceAll("x:div", "x:span"), false],
    [`<x:section>${pair}</x:section>`, false],
    [`${pair}<x:p/>`, false],
    [`${pair}Outside`, false],
    [
      pair.replace(
        '<x:div id="book-inner"/>',
        '<x:p/><x:div id="book-inner"/>'
      ),
      false,
    ],
    [
      pair.replace(
        '<x:div id="book-inner"/>',
        '<![CDATA[Outside]]><x:div id="book-inner"/>'
      ),
      false,
    ],
    [`<!-- ${pair} -->`, false],
  ]) {
    const bytes = Buffer.from(
      `<x:html xmlns:x="http://www.w3.org/1999/xhtml" xmlns:foreign="urn:foreign"><x:body>${body}</x:body></x:html>`
    )
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 3)
        yield bytes.subarray(at, at + 3)
    }
    assert.equal((await inspectXhtml(chunks())).hasKoboWrappers, expected, body)
  }
})

test("Kobo wrappers do not bypass validation of later chapter content", async () => {
  await assert.rejects(
    convertEpubToKepubBlob(
      makeEpub({
        transformChapter: () =>
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><div id="book-columns"><div id="book-inner"><svg xmlns="http://www.w3.org/2000/svg"/></div></div><b>Broken</body></html>',
      })
    ),
    { code: "invalid_epub" }
  )
})

test("publisher KEPUB chapters without wrappers are preserved alongside plain chapters", async () => {
  const source = makeEpub({
    chapters: [
      '<span class="extra koboSpan" id="kobo.8.2">Already ready.</span>',
      "Still needs conversion.",
    ],
  })
  const input = parseZip(source)
  const output = await converted(source)
  assert.equal(
    await text(output, "OEBPS/chapter-1.xhtml"),
    await text(input, "OEBPS/chapter-1.xhtml")
  )
  assert.match(await text(output, "OEBPS/chapter-2.xhtml"), /class="koboSpan"/)
})

test("Kobo detection parses real class tokens across tiny chunks", async () => {
  for (const [body, expected] of [
    ['<x:span class="other kobo&#83;pan" id="kobo.1.1">Ready.</x:span>', true],
    ['<!-- <span class="koboSpan"/> --><x:p>Text.</x:p>', false],
    ['<x:span data-class="koboSpan">Text.</x:span>', false],
    ['<x:span class="not-koboSpan">Text.</x:span>', false],
    ['<span xmlns="urn:foreign" class="koboSpan">Text.</span>', false],
  ]) {
    const bytes = Buffer.from(
      `<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:body>${body}</x:body></x:html>`
    )
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 3)
        yield bytes.subarray(at, at + 3)
    }
    assert.equal((await inspectXhtml(chunks())).hasKoboSpans, expected, body)
  }
})

test("a Kobo span does not bypass validation of the rest of a chapter or book", async () => {
  const ready = '<span class="koboSpan" id="kobo.1.1">Ready.</span>'
  for (const chapters of [[ready + "<b>Broken"], [ready, "<b>Broken"]]) {
    await assert.rejects(convertEpubToKepubBlob(makeEpub({ chapters })), {
      code: "invalid_epub",
    })
  }
})

test("EPUB 3 chapters gain Kobo spans while nav and compressed cover are unchanged", async () => {
  const source = makeEpub({
    withCover: true,
    chapters: ["One. Two! Three?", "A second chapter."],
  })
  const input = parseZip(source)
  const output = await converted(source)
  const chapter = await text(output, "OEBPS/chapter-1.xhtml")
  assert.match(chapter, /<div id="book-columns"><div id="book-inner">/)
  assert.match(chapter, /class="koboSpan" id="kobo\.\d+\.1">One\. <\/span>/)
  assert.match(chapter, /Two! <\/span>/)
  assert.match(chapter, /Three\?<\/span>/)
  assert.equal(
    await text(output, "OEBPS/nav.xhtml"),
    await text(input, "OEBPS/nav.xhtml")
  )
  const imageBefore = input.byName.get("OEBPS/cover.png")
  const imageAfter = output.byName.get("OEBPS/cover.png")
  assert.deepEqual(
    Buffer.from(source.subarray(imageBefore.dataStart, imageBefore.dataEnd)),
    Buffer.from(output.bytes.subarray(imageAfter.dataStart, imageAfter.dataEnd))
  )
  assert.equal(output.entries[0].name, "mimetype")
  assert.equal(output.entries[0].method, 0)
})

test("EPUB 2 package and NCX remain valid and intact", async () => {
  const source = makeEpub({ version: 2, withCover: true })
  const input = parseZip(source)
  const output = await converted(source)
  assert.equal(
    await text(output, "OEBPS/content.opf"),
    await text(input, "OEBPS/content.opf")
  )
  assert.equal(
    await text(output, "OEBPS/toc.ncx"),
    await text(input, "OEBPS/toc.ncx")
  )
  assert.match(await text(output, "OEBPS/chapter-1.xhtml"), /class="koboSpan"/)
})

test("converts EPUBs with deflated empty directories to stored empty directories", async () => {
  const source = makeEpub({
    extraEntries: [{ name: "OEBPS/", data: "", method: 8 }],
  })
  const output = await converted(source)
  const directory = output.byName.get("OEBPS/")
  assert.ok(directory)
  assert.equal(directory.method, 0)
  assert.equal(directory.compressedSize, 0)
  assert.equal(directory.uncompressedSize, 0)
  assert.match(await text(output, "OEBPS/chapter-1.xhtml"), /class="koboSpan"/)
})

test("large multi-chapter text converts through the stream without whole-chapter buffering", async () => {
  const sentence = "A long sentence with words. "
  const source = makeEpub({
    chapters: [
      sentence.repeat(12000),
      sentence.repeat(12000),
      sentence.repeat(12000),
    ],
  })
  const stream = await convertEpubToKepub(source)
  const parts = []
  let length = 0
  for await (const chunk of stream) {
    parts.push(chunk)
    length += chunk.byteLength
  }
  assert.ok(parts.length > 10)
  const bytes = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.byteLength
  }
  const output = parseZip(bytes)
  for (let index = 1; index <= 3; index++) {
    const chapter = await text(output, `OEBPS/chapter-${index}.xhtml`)
    assert.match(chapter, /class="koboSpan"/)
    assert.match(chapter, /A long sentence with words\./)
  }
})

test("Blob collection stops at the caller's output limit", async () => {
  await assert.rejects(convertEpubToKepubBlob(makeEpub(), 100), {
    name: "KepubError",
    code: "too_large",
  })
})

test("Blob limits are conservative and reject invalid overrides before conversion", async () => {
  assert.equal(DEFAULT_MAX_BLOB_BYTES, 35 * 1024 * 1024)
  for (const limit of [0, -1, NaN, Infinity, 1.5, 128 * 1024 * 1024 + 1])
    await assert.rejects(
      convertEpubToKepubBlob(new Uint8Array(), limit),
      RangeError
    )
})

test("navigation in the spine gains spans without changing links or package XML", async () => {
  const source = makeEpub({ navInSpine: true })
  const input = parseZip(source)
  const output = await converted(source)
  assert.equal(
    await text(output, "OEBPS/content.opf"),
    await text(input, "OEBPS/content.opf")
  )
  const nav = await text(output, "OEBPS/nav.xhtml")
  assert.match(nav, /<nav epub:type="toc">/)
  assert.match(nav, /<a href="chapter-1.xhtml"><span class="koboSpan"/)
})

async function transform(source, chunkSize = 7) {
  const bytes = new TextEncoder().encode(source)
  async function* chunks() {
    for (let at = 0; at < bytes.length; at += chunkSize)
      yield bytes.subarray(at, at + chunkSize)
  }
  const output = []
  for await (const chunk of transformXhtml(chunks())) output.push(chunk)
  return Buffer.concat(output).toString("utf8")
}

test("prefixed XHTML uses in-scope prefixes for wrappers, text, and images", async () => {
  const source =
    '<x:html xmlns:x="http://www.w3.org/1999/xhtml"><x:head><x:title>Title</x:title></x:head><x:body><x:p>Hello. <y:em xmlns:y="http://www.w3.org/1999/xhtml">World.</y:em> Again.</x:p><z:img xmlns:z="http://www.w3.org/1999/xhtml" src="cover.png"/></x:body></x:html>'
  const output = await transform(source)
  assert.match(
    output,
    /<x:body><x:div id="book-columns"><x:div id="book-inner">/
  )
  assert.match(output, /<y:span class="koboSpan"[^>]*>World\.<\/y:span>/)
  assert.match(output, /<x:span class="koboSpan"[^>]*><z:img/)
  assert.match(output, /<\/x:div><\/x:div><\/x:body>/)
  assert.doesNotMatch(output, /<(?:span|div)\b/)
})

test("foreign namespaces and default namespace changes keep their original content", async () => {
  const foreign =
    '<custom xmlns="urn:example"><body>Foreign text.</body><img/></custom>'
  const source = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Title</title></head><body><p>Before.</p>${foreign}<p xmlns="">Unnamespaced text.</p><p>After.</p></body></html>`
  const output = await transform(source)
  assert.ok(output.includes(foreign))
  assert.ok(output.includes('<p xmlns="">Unnamespaced text.</p>'))
  assert.match(output, /<span class="koboSpan"[^>]*>After\.<\/span>/)
})

test("namespace declarations may use XML character references", async () => {
  const output = await transform(
    '<x:html xmlns:x="http://www.w3.org/1999/&#120;html"><x:head/><x:body><x:p>Text.</x:p></x:body></x:html>'
  )
  assert.match(output, /<x:span class="koboSpan"/)
})

test("deep XHTML and oversized complete tokens are bounded", async () => {
  await assert.rejects(
    transform(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
        "<div>".repeat(256) +
        "Text." +
        "</div>".repeat(256) +
        "</body></html>"
    ),
    { code: "too_large" }
  )
  const source =
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><!--' +
    "x".repeat(65536) +
    "--><p>Text.</p></body></html>"
  await assert.rejects(transform(source, source.length), { code: "too_large" })
})

test("late stream errors surface during consumption and readers can cancel", async () => {
  const stream = await convertEpubToKepub(
    makeEpub({ chapters: ["Broken <b>markup"] })
  )
  await assert.rejects(async () => {
    for await (const chunk of stream) assert.ok(chunk.byteLength)
  }, KepubError)
  const reader = (await convertEpubToKepub(makeEpub())).getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  assert.equal((await reader.read()).done, true)
  reader.releaseLock()
})

test("malformed ZIP references fail before producing a stream", async () => {
  const source = makeEpub()
  const bytes = new Uint8Array(source)
  // The EPUB file starts with the mimetype local header.
  bytes[0] = 0
  await assert.rejects(convertEpubToKepub(bytes), KepubError)
})

test("DRM marker files are rejected before conversion", async () => {
  for (const name of [
    "META-INF/encryption.xml",
    "META-INF/rights.xml",
    "META-INF/license.lcpl",
  ]) {
    const data =
      name === "META-INF/encryption.xml"
        ? '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/><CipherData><CipherReference URI="OEBPS/chapter-1.xhtml"/></CipherData></EncryptedData></encryption>'
        : "protected"
    const source = makeEpub({ extraEntries: [{ name, data, method: 8 }] })
    await assert.rejects(convertEpubToKepub(source), {
      name: "KepubError",
      code: "unsupported_epub",
    })
  }
})

test("converts books with obfuscated fonts and preserves the font data", async () => {
  const encryption =
    '<encryption><EncryptedData><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/><CipherData><CipherReference URI="fonts/book.ttf"/></CipherData></EncryptedData></encryption>'
  const source = makeEpub({
    zipFlags: 0x0816,
    extraEntries: [
      { name: "fonts/book.ttf", data: "obfuscated font", method: 8 },
      { name: "META-INF/encryption.xml", data: encryption, method: 8 },
    ],
  })
  const output = await converted(source)
  assert.equal(await text(output, "META-INF/encryption.xml"), encryption)
  assert.equal(await text(output, "fonts/book.ttf"), "obfuscated font")
  assert.match(await text(output, "OEBPS/chapter-1.xhtml"), /class="koboSpan"/)
})

test("fixed-layout publications are left to the EPUB fallback", async () => {
  for (const version of [2, 3]) {
    await assert.rejects(
      convertEpubToKepub(makeEpub({ version, fixedLayout: true })),
      { name: "KepubError", code: "unsupported_epub" }
    )
  }
})

test("invalid XML in a chapter aborts conversion instead of storing a partial book", async () => {
  const source = makeEpub({ chapters: ["Broken <b>markup"] })
  await assert.rejects(convertEpubToKepubBlob(source), KepubError)
})

test("XHTML streaming keeps entities and inline markup across tiny input chunks", async () => {
  const original =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body><p>Café &amp; tea. More <em>words</em>.</p><pre>Leave this. Alone.</pre><img src="cover.png" alt=""/></body></html>'
  const bytes = new TextEncoder().encode(original)
  async function* tinyChunks() {
    for (let at = 0; at < bytes.length; at += 7)
      yield bytes.subarray(at, at + 7)
  }
  const output = []
  for await (const chunk of transformXhtml(tinyChunks())) output.push(chunk)
  const converted = new TextDecoder().decode(Buffer.concat(output))
  assert.match(converted, /Café &amp; tea\. <\/span>/)
  assert.match(converted, /<em><span class="koboSpan"/)
  assert.match(converted, /<pre>Leave this\. Alone\.<\/pre>/)
  assert.match(
    converted,
    /<span class="koboSpan" id="kobo\.\d+\.1"><img src="cover\.png" alt=""\/><\/span>/
  )
  assert.match(converted, /<\/div><\/div><\/body>/)
})

test("common XHTML doctype and named entities survive conversion", async () => {
  const original = `<?xml version="1.0"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body><p title="A&nbsp;B">A&nbsp;B. C.</p></body></html>`
  async function* input() {
    yield new TextEncoder().encode(original)
  }
  const pieces = []
  for await (const chunk of transformXhtml(input())) pieces.push(chunk)
  const converted = new TextDecoder().decode(Buffer.concat(pieces))
  assert.match(converted, /<!DOCTYPE html PUBLIC/)
  assert.match(converted, /A&nbsp;B\. <\/span>/)
  assert.match(converted, /title="A&nbsp;B"/)
})
