import { invalid, tooLarge, unsupported } from "./error.js"
import { xmlAttribute } from "./xml.js"

const encoder = new TextEncoder()
const MAX_MARKUP_CHARS = 64 * 1024
const MAX_SPANS = 500000
const MAX_DEPTH = 256
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"
const skipped = new Set([
  "script",
  "style",
  "pre",
  "audio",
  "video",
  "svg",
  "math",
])
const blocks = new Set([
  "p",
  "ol",
  "ul",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "figure",
  "figcaption",
  "section",
  "article",
  "aside",
  "div",
])

interface Frame {
  qname: string
  local: string
  namespace: string
  declarations: Map<string, string>
}

function xmlName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1)
}

function prefix(name: string): string {
  return name.includes(":") ? name.slice(0, name.indexOf(":") + 1) : ""
}

function validateText(text: string, allowNamedEntities = false): void {
  if (
    text.includes("]]>") ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)
  )
    invalid("The XHTML contains invalid XML text.")
  for (let at = text.indexOf("&"); at >= 0; at = text.indexOf("&", at + 1)) {
    const end = text.indexOf(";", at + 1)
    if (end < 0 || end - at > 17)
      invalid("The XHTML contains an invalid XML entity.")
    const entity = text.slice(at + 1, end)
    if (
      !/^(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-f]+)$/iu.test(entity) &&
      !(allowNamedEntities && /^[A-Za-z][A-Za-z0-9]+$/u.test(entity))
    )
      invalid("The XHTML contains an unsupported XML entity.")
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x"
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (
        !Number.isFinite(code) ||
        code === 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) ||
        (code < 32 && code !== 9 && code !== 10 && code !== 13)
      )
        invalid("The XHTML contains an invalid XML character reference.")
    }
    at = end
  }
}

function markupEnd(buffer: string): number {
  if (buffer.startsWith("<!--")) {
    const end = buffer.indexOf("-->", 4)
    return end < 0 ? -1 : end + 3
  }
  if (buffer.startsWith("<![CDATA[")) {
    const end = buffer.indexOf("]]>", 9)
    return end < 0 ? -1 : end + 3
  }
  if (buffer.startsWith("<?")) {
    const end = buffer.indexOf("?>", 2)
    return end < 0 ? -1 : end + 2
  }
  let quote: string | null = null
  for (let at = 1; at < buffer.length; at++) {
    const char = buffer[at]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === ">") {
      return at + 1
    }
  }
  return -1
}

function validateOpeningTag(
  tag: string,
  qname: string,
  allowNamedEntities: boolean
): { attributes: Map<string, string>; declarations: Map<string, string> } {
  const attributes = new Map<string, string>()
  const declarations = new Map<string, string>()
  let at = 1 + qname.length
  while (at < tag.length) {
    const before = at
    while (/[ \t\r\n]/u.test(tag[at] ?? "")) at++
    if (tag[at] === ">" && at === tag.length - 1)
      return { attributes, declarations }
    if (tag[at] === "/" && tag[at + 1] === ">" && at === tag.length - 2)
      return { attributes, declarations }
    if (at === before) invalid("The XHTML has malformed XML attributes.")
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/u.exec(tag.slice(at))
    if (!match || attributes.has(match[0]))
      invalid("The XHTML has malformed XML attributes.")
    at += match[0].length
    while (/[ \t\r\n]/u.test(tag[at] ?? "")) at++
    if (tag[at] !== "=") invalid("The XHTML has malformed XML attributes.")
    at++
    while (/[ \t\r\n]/u.test(tag[at] ?? "")) at++
    const quote = tag[at]
    if (quote !== '"' && quote !== "'")
      invalid("The XHTML has unquoted XML attributes.")
    const end = tag.indexOf(quote, at + 1)
    if (end < 0 || tag.slice(at + 1, end).includes("<"))
      invalid("The XHTML has malformed XML attributes.")
    validateText(tag.slice(at + 1, end), allowNamedEntities)
    attributes.set(match[0], tag.slice(at + 1, end))
    if (match[0] === "xmlns" || match[0].startsWith("xmlns:"))
      declarations.set(
        match[0] === "xmlns" ? "" : match[0].slice(6),
        xmlAttribute(tag.slice(at + 1, end))
      )
    at = end + 1
  }
  invalid("The XHTML has incomplete XML attributes.")
}

/** Prefer whole sentences; cap a single unpunctuated text run at 32 KiB. */
function safeTextCut(text: string): number {
  const safeEnd = Math.max(0, text.length - 64)
  let cut = 0
  const boundary = /[.!?。！？]["'»”)]*[ \t\r\n]+/gu
  for (const match of text.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length
    if (end > safeEnd) break
    cut = end
  }
  if (!cut && text.length > 32 * 1024) cut = safeEnd
  const amp = text.lastIndexOf("&", cut)
  if (amp >= 0 && text.indexOf(";", amp) >= cut) cut = amp
  return cut
}

function* sentencePieces(raw: string): Generator<string> {
  const boundary = /[.!?。！？]["'»”)]*[ \t\r\n]+/gu
  let start = 0
  for (const match of raw.matchAll(boundary)) {
    const end = (match.index ?? 0) + match[0].length
    yield raw.slice(start, end)
    start = end
  }
  if (start < raw.length) yield raw.slice(start)
}

/**
 * Add Kobo's reference spans while retaining the original XHTML markup.
 * Only a small text/tag window is retained, even for a single huge chapter.
 */
export async function* transformXhtml(
  source: AsyncIterable<Uint8Array>,
  addBodyWrappers = true
): AsyncGenerator<Uint8Array> {
  yield* processXhtml(source, undefined, addBodyWrappers)
}

interface XhtmlInspection {
  hasKoboSpans: boolean
  hasKoboWrappers: boolean
  needsKoboSpans: boolean
}

/** Validate the entire document before deciding whether its markup is ready. */
export async function inspectXhtml(
  source: AsyncIterable<Uint8Array>
): Promise<XhtmlInspection> {
  const inspection = {
    hasKoboSpans: false,
    hasKoboWrappers: false,
    needsKoboSpans: false,
  }
  for await (const _chunk of processXhtml(source, inspection)) {
    // Inspection emits no output and retains only the parser's bounded window.
  }
  return inspection
}

async function* processXhtml(
  source: AsyncIterable<Uint8Array>,
  inspection?: XhtmlInspection,
  addBodyWrappers = true
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const stack: Frame[] = []
  let buffer = ""
  let inBody = false
  let sawBody = false
  let rootOpened = false
  let rootClosed = false
  let doctypeSeen = false
  let allowNamedEntities = false
  let skipDepth = 0
  let paragraph = 0
  let segment = 0
  let spans = 0
  let bodyPrefix = ""
  let wrapperColumns: Frame | undefined
  let wrapperInnerSeen = false
  let wrappersValid = true

  function outsideInnerWrapper(): boolean {
    const parent = stack.at(-1)
    return !!(
      inBody &&
      (parent === wrapperColumns ||
        (parent?.namespace === XHTML_NAMESPACE && parent.local === "body"))
    )
  }

  function namespaceFor(
    qname: string,
    declarations: Map<string, string>
  ): string {
    const key = prefix(qname).replace(/:$/u, "")
    let namespace = declarations.get(key)
    for (let at = stack.length - 1; namespace === undefined && at >= 0; at--)
      namespace = stack[at].declarations.get(key)
    if (key && !namespace)
      invalid("The XHTML contains an undeclared namespace prefix.")
    return namespace ?? ""
  }

  function span(content: string): string {
    if (!paragraph) paragraph = 1
    if (++spans > MAX_SPANS) tooLarge("The XHTML needs too many Kobo spans.")
    const spanPrefix = prefix(stack.at(-1)!.qname)
    return `<${spanPrefix}span class="koboSpan" id="kobo.${paragraph}.${++segment}">${content}</${spanPrefix}span>`
  }

  function textOutput(raw: string): string {
    if (!raw) return ""
    validateText(raw, allowNamedEntities)
    if (!stack.length && raw.trim())
      invalid("The XHTML has text outside its root element.")
    if (inspection && outsideInnerWrapper() && raw.trim()) wrappersValid = false
    if (
      !inBody ||
      skipDepth ||
      stack.at(-1)?.namespace !== XHTML_NAMESPACE ||
      (/^\s+$/u.test(raw) && stack.at(-1)?.local !== "p")
    )
      return raw
    if (inspection) {
      inspection.needsKoboSpans = true
      return raw
    }
    let result = ""
    for (const piece of sentencePieces(raw)) result += span(piece)
    return result
  }

  function tagOutput(tag: string): string {
    if (tag.startsWith("<!")) {
      if (tag.startsWith("<!--")) {
        if (tag.slice(4, -3).includes("--"))
          invalid("The XHTML contains a malformed XML comment.")
        return tag
      }
      if (tag.startsWith("<![CDATA[")) {
        if (!stack.length) invalid("The XHTML has misplaced CDATA.")
        if (inspection && outsideInnerWrapper()) wrappersValid = false
        return tag
      }
      if (/^<!DOCTYPE\s+html\b/iu.test(tag) && !rootOpened && !doctypeSeen) {
        // Preserve a common XHTML 1.x or HTML5 doctype without resolving any
        // external DTD or expanding its entities inside the Worker.
        if (
          tag.length > 4096 ||
          /[\[\]]/u.test(tag) ||
          tag.slice(2, -1).includes("<")
        )
          unsupported("XHTML DTD internal subsets are not supported.")
        doctypeSeen = true
        allowNamedEntities = /\b(?:PUBLIC|SYSTEM)\b[^>]*xhtml/iu.test(tag)
        return tag
      }
      unsupported("XHTML DTD internal subsets are not supported.")
    }
    if (tag.startsWith("<?")) return tag
    const close = tag.startsWith("</")
    const match = /^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(tag)
    if (!match) invalid("The XHTML contains a malformed XML tag.")
    const qname = match[1]
    const name = xmlName(qname)
    if (close) {
      const frame = stack.pop()
      if (
        !/^<\/[A-Za-z_][A-Za-z0-9_.:-]*\s*>$/u.test(tag) ||
        frame?.qname !== qname
      )
        invalid("The XHTML contains mismatched XML tags.")
      if (name === "body" && frame.namespace === XHTML_NAMESPACE) {
        if (!inBody) invalid("The XHTML body is malformed.")
        inBody = false
        return inspection || !addBodyWrappers
          ? tag
          : `</${bodyPrefix}div></${bodyPrefix}div>` + tag
      }
      if (name === "html" && !stack.length) rootClosed = true
      if (inBody && (frame.namespace !== XHTML_NAMESPACE || skipped.has(name)))
        skipDepth--
      return tag
    }
    const { attributes, declarations } = validateOpeningTag(
      tag,
      qname,
      allowNamedEntities
    )
    const namespace = namespaceFor(qname, declarations)
    const isXhtml = namespace === XHTML_NAMESPACE
    const selfClosing = /\/\s*>$/u.test(tag)
    if (
      inBody &&
      isXhtml &&
      name === "span" &&
      attributes
        .get("class")
        ?.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, xmlAttribute)
        .split(/\s+/u)
        .includes("koboSpan")
    ) {
      if (!inspection) unsupported("This EPUB already contains Kobo spans.")
      if (++spans > MAX_SPANS) tooLarge("The XHTML has too many Kobo spans.")
      inspection.hasKoboSpans = true
    }
    if (!stack.length) {
      if (rootOpened || name !== "html" || !isXhtml)
        invalid("The XHTML has an invalid root element.")
      rootOpened = true
    }
    if (stack.length >= MAX_DEPTH) tooLarge("The XHTML is nested too deeply.")
    const frame = { qname, local: name, namespace, declarations }
    if (inspection && outsideInnerWrapper()) {
      const id = attributes
        .get("id")
        ?.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, xmlAttribute)
      // Only reuse the canonical body > columns > inner pair, never IDs on
      // unrelated descendants or a pair with content alongside either div.
      if (stack.at(-1) === wrapperColumns) {
        if (
          wrapperInnerSeen ||
          !isXhtml ||
          name !== "div" ||
          id !== "book-inner"
        )
          wrappersValid = false
        else wrapperInnerSeen = true
      } else if (
        wrapperColumns ||
        !isXhtml ||
        name !== "div" ||
        id !== "book-columns" ||
        selfClosing
      ) {
        wrappersValid = false
      } else wrapperColumns = frame
    }
    if (
      inBody &&
      isXhtml &&
      name === "img" &&
      selfClosing &&
      !skipDepth &&
      stack.at(-1)?.namespace === XHTML_NAMESPACE
    ) {
      if (inspection) inspection.needsKoboSpans = true
      else {
        paragraph++
        segment = 0
        return span(tag)
      }
    }
    if (!selfClosing) stack.push(frame)
    if (isXhtml && name === "body") {
      if (sawBody || selfClosing) invalid("The XHTML body is malformed.")
      inBody = true
      sawBody = true
      bodyPrefix = prefix(qname)
      if (inspection || !addBodyWrappers) return tag
      return (
        tag +
        `<${bodyPrefix}div id="book-columns"><${bodyPrefix}div id="book-inner">`
      )
    }
    if (inBody && isXhtml && blocks.has(name) && !skipDepth) {
      paragraph++
      segment = 0
    }
    if (inBody && (!isXhtml || skipped.has(name)) && !selfClosing) skipDepth++
    return tag
  }

  function* process(final: boolean): Generator<Uint8Array> {
    while (buffer) {
      const markup = buffer.indexOf("<")
      if (markup < 0) {
        const cut = final ? buffer.length : safeTextCut(buffer)
        if (!cut) break
        const chunk = buffer.slice(0, cut)
        buffer = buffer.slice(cut)
        const output = textOutput(chunk)
        if (!inspection) yield encoder.encode(output)
        continue
      }
      if (markup > 0) {
        const chunk = buffer.slice(0, markup)
        buffer = buffer.slice(markup)
        const output = textOutput(chunk)
        if (!inspection) yield encoder.encode(output)
        continue
      }
      const end = markupEnd(buffer)
      if (end > MAX_MARKUP_CHARS)
        tooLarge("An XHTML markup token exceeds the allowed size.")
      if (end < 0) {
        if (buffer.length > MAX_MARKUP_CHARS)
          tooLarge("An XHTML markup token exceeds the allowed size.")
        if (final) invalid("The XHTML contains incomplete markup.")
        break
      }
      const tag = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const output = tagOutput(tag)
      if (!inspection) yield encoder.encode(output)
    }
  }

  try {
    for await (const chunk of source) {
      buffer += decoder.decode(chunk, { stream: true })
      yield* process(false)
    }
    buffer += decoder.decode()
    yield* process(true)
  } catch (error) {
    if (error instanceof Error && error.name === "KepubError") throw error
    invalid("The XHTML could not be decoded.")
  }
  if (stack.length || !sawBody || inBody || !rootClosed)
    invalid("The XHTML is incomplete.")
  if (inspection)
    inspection.hasKoboWrappers =
      wrappersValid && wrapperColumns !== undefined && wrapperInnerSeen
}
