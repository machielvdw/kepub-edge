import { invalid } from "./error.js"

export interface XmlElement {
  readonly name: string
  readonly attributes: Map<string, string>
  readonly children: XmlElement[]
  text: string
}

const namePattern = /[A-Za-z_][A-Za-z0-9_.:-]*/uy

function nameAt(source: string, position: number): string | null {
  namePattern.lastIndex = position
  return namePattern.exec(source)?.[0] ?? null
}

function skipSpace(source: string, position: number): number {
  while (position < source.length && /[ \t\r\n]/u.test(source[position]))
    position++
  return position
}

function decodeEntities(value: string): string {
  return value.replace(/&([^;]{1,16});/gu, (whole, entity: string) => {
    const builtIn: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    }
    if (Object.hasOwn(builtIn, entity)) return builtIn[entity]
    if (/^#(?:\d+|x[0-9a-f]+)$/iu.test(entity)) {
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      if (
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff) &&
        !(code < 32 && code !== 9 && code !== 10 && code !== 13)
      )
        return String.fromCodePoint(code)
    }
    invalid("The EPUB contains an unsupported XML entity.")
  })
}

export function xmlAttribute(value: string): string {
  // Reject any ampersand which was not consumed as a complete XML entity.
  const badAmpersand = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu
  if (badAmpersand.test(value))
    invalid("The EPUB contains an invalid XML entity.")
  return decodeEntities(value)
}

/** Parse bounded container and OPF XML without DOMParser or third-party code. */
export function parseXml(bytes: Uint8Array): XmlElement {
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\ufeff/u, "")
  } catch {
    invalid("The EPUB contains invalid UTF-8 XML.")
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source))
    invalid("The EPUB contains invalid XML characters.")
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let position = 0
  let tokens = 0
  while (position < source.length) {
    if (++tokens > 100000) invalid("The EPUB XML is excessively complex.")
    if (source[position] !== "<") {
      const next = source.indexOf("<", position)
      const end = next < 0 ? source.length : next
      const raw = source.slice(position, end)
      if (raw.includes("]]>")) invalid("The EPUB has malformed XML text.")
      if (!stack.length && raw.trim())
        invalid("The EPUB has text outside its XML root.")
      if (stack.length) stack[stack.length - 1].text += xmlAttribute(raw)
      position = end
      continue
    }
    if (source.startsWith("<!--", position)) {
      const end = source.indexOf("-->", position + 4)
      if (end < 0 || source.slice(position + 4, end).includes("--"))
        invalid("The EPUB has a malformed XML comment.")
      position = end + 3
      continue
    }
    if (source.startsWith("<?", position)) {
      if (
        /^<\?xml\b/iu.test(source.slice(position, position + 6)) &&
        position !== 0
      )
        invalid("The EPUB has a misplaced XML declaration.")
      const end = source.indexOf("?>", position + 2)
      if (end < 0) invalid("The EPUB has a malformed XML instruction.")
      position = end + 2
      continue
    }
    if (source.startsWith("<![CDATA[", position)) {
      const end = source.indexOf("]]>", position + 9)
      if (!stack.length || end < 0) invalid("The EPUB has malformed XML CDATA.")
      stack[stack.length - 1].text += source.slice(position + 9, end)
      position = end + 3
      continue
    }
    if (source.startsWith("<!", position))
      invalid("DTD and external XML entities are not supported.")
    if (source.startsWith("</", position)) {
      const name = nameAt(source, position + 2)
      if (!name) invalid("The EPUB has a malformed XML closing tag.")
      const end = skipSpace(source, position + 2 + name.length)
      if (source[end] !== ">" || stack.pop()?.name !== name)
        invalid("The EPUB has mismatched XML tags.")
      position = end + 1
      continue
    }
    const name = nameAt(source, position + 1)
    if (!name) invalid("The EPUB has a malformed XML tag.")
    let at = position + 1 + name.length
    const attributes = new Map<string, string>()
    let selfClosing = false
    while (true) {
      const beforeSpace = at
      at = skipSpace(source, at)
      if (source.startsWith("/>", at)) {
        selfClosing = true
        at += 2
        break
      }
      if (source[at] === ">") {
        at++
        break
      }
      if (beforeSpace === at) invalid("The EPUB has malformed XML spacing.")
      const key = nameAt(source, at)
      if (!key) invalid("The EPUB has a malformed XML attribute.")
      at = skipSpace(source, at + key.length)
      if (source[at] !== "=") invalid("The EPUB has a malformed XML attribute.")
      at = skipSpace(source, at + 1)
      const quote = source[at]
      if (quote !== '"' && quote !== "'")
        invalid("The EPUB has an unquoted XML attribute.")
      const end = source.indexOf(quote, at + 1)
      if (end < 0 || source.slice(at + 1, end).includes("<"))
        invalid("The EPUB has a malformed XML attribute.")
      if (attributes.has(key)) invalid("The EPUB has duplicate XML attributes.")
      attributes.set(key, xmlAttribute(source.slice(at + 1, end)))
      at = end + 1
    }
    if (stack.length >= 64) invalid("The EPUB XML is nested too deeply.")
    const element: XmlElement = {
      name,
      attributes,
      children: [],
      text: "",
    }
    if (stack.length) stack[stack.length - 1].children.push(element)
    else if (root) invalid("The EPUB has multiple XML roots.")
    else root = element
    if (!selfClosing) stack.push(element)
    position = at
  }
  if (!root || stack.length) invalid("The EPUB XML is incomplete.")
  return root
}

export function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1)
}

export function child(
  element: XmlElement,
  name: string
): XmlElement | undefined {
  return element.children.find((part) => localName(part.name) === name)
}
