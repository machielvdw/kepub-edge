import { invalid, unsupported } from "./error.js"
import { readSmallEntry, type ZipArchive } from "./zip.js"
import { child, localName, parseXml, type XmlElement } from "./xml.js"

const CONTAINER_LIMIT = 256 * 1024
const OPF_LIMIT = 2 * 1024 * 1024

function onlyObfuscatedFonts(
  document: XmlElement,
  archive: ZipArchive
): boolean {
  if (localName(document.name) !== "encryption" || !document.children.length)
    return false
  const seen = new Set<string>()
  for (const data of document.children) {
    if (localName(data.name) !== "EncryptedData" || data.children.length !== 2)
      return false
    const method = child(data, "EncryptionMethod")
    const cipher = child(data, "CipherData")
    const reference = cipher?.children[0]
    const algorithm = method?.attributes.get("Algorithm")
    const path = reference?.attributes.get("URI")
    if (
      !method ||
      !cipher ||
      !reference ||
      cipher.children.length !== 1 ||
      localName(reference.name) !== "CipherReference" ||
      method.children.length !== 0 ||
      reference.children.length !== 0 ||
      (algorithm !== "http://ns.adobe.com/pdf/enc#RC" &&
        algorithm !== "http://www.idpf.org/2008/embedding") ||
      !path ||
      !/\.(?:otf|ttf|woff2?)$/iu.test(path) ||
      !archive.byName.has(path) ||
      seen.has(path)
    )
      return false
    seen.add(path)
  }
  return true
}

export interface Publication {
  /** XHTML content documents, including navigation when it is in the spine. */
  readonly contentPaths: Set<string>
}

function pathFromHref(packagePath: string, href: string): string {
  const raw = href.split("#", 1)[0]
  if (!raw || raw.includes("?") || /%2f|%5c/iu.test(raw))
    invalid("The EPUB manifest has an unsafe reference.")
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    invalid("The EPUB manifest has a malformed reference.")
  }
  const parts = decoded.split("/")
  if (parts.some((part) => !part || part === ".."))
    invalid("The EPUB manifest has an unsafe reference.")
  const normalized = parts.filter((part) => part !== ".").join("/")
  const base = packagePath.slice(0, packagePath.lastIndexOf("/") + 1)
  return base + normalized
}

/** Resolve EPUB 2/3 manifest and spine. Only package/container XML is buffered. */
export async function inspectPublication(
  archive: ZipArchive
): Promise<Publication> {
  let encryptionEntry: ZipArchive["entries"][number] | undefined
  for (const entry of archive.entries) {
    const lower = entry.name.toLowerCase()
    if (lower === "meta-inf/encryption.xml") encryptionEntry = entry
    if (
      lower === "meta-inf/rights.xml" ||
      lower === "meta-inf/license.lcpl" ||
      lower.startsWith("meta-inf/licenses/")
    )
      unsupported("DRM-protected EPUBs cannot be converted.")
  }
  if (
    encryptionEntry &&
    !onlyObfuscatedFonts(
      parseXml(await readSmallEntry(archive, encryptionEntry, CONTAINER_LIMIT)),
      archive
    )
  )
    unsupported("DRM-protected EPUBs cannot be converted.")
  const containerEntry = archive.byName.get("META-INF/container.xml")
  if (!containerEntry) invalid("The EPUB has no container.xml.")
  const container = parseXml(
    await readSmallEntry(archive, containerEntry, CONTAINER_LIMIT)
  )
  if (
    localName(container.name) !== "container" ||
    container.attributes.get("version") !== "1.0"
  )
    invalid("The EPUB container.xml is invalid.")
  const rootfile = child(container, "rootfiles")?.children.find(
    (item) =>
      localName(item.name) === "rootfile" &&
      item.attributes.get("media-type") === "application/oebps-package+xml"
  )
  const packagePath = rootfile?.attributes.get("full-path")
  if (
    !packagePath ||
    !packagePath.toLowerCase().endsWith(".opf") ||
    packagePath.startsWith("/") ||
    packagePath.includes("\\") ||
    packagePath
      .split("/")
      .some((part) => !part || part === ".." || part === ".")
  )
    invalid("The EPUB has no valid package document.")
  const packageEntry = archive.byName.get(packagePath)
  if (!packageEntry) invalid("The EPUB package document is missing.")
  const packageXml = parseXml(
    await readSmallEntry(archive, packageEntry, OPF_LIMIT)
  )
  if (localName(packageXml.name) !== "package")
    invalid("The EPUB package document is invalid.")
  const version = packageXml.attributes.get("version")
  if (version !== "2.0" && version !== "3.0")
    unsupported("Only EPUB 2 and EPUB 3 packages are supported.")
  const metadata = child(packageXml, "metadata")
  if (!metadata) invalid("The EPUB has no publication metadata.")
  const metadataFields = [
    ...metadata.children,
    ...(child(metadata, "dc-metadata")?.children ?? []),
    ...(child(metadata, "x-metadata")?.children ?? []),
  ]
  const uniqueId = packageXml.attributes.get("unique-identifier")
  if (
    !uniqueId ||
    !metadataFields.some(
      (item) =>
        localName(item.name) === "identifier" &&
        item.attributes.get("id") === uniqueId &&
        item.text.trim()
    )
  )
    invalid("The EPUB has no primary publication identifier.")
  for (const required of ["title", "language"]) {
    if (
      !metadataFields.some(
        (item) => localName(item.name) === required && item.text.trim()
      )
    )
      invalid(`The EPUB has no ${required} metadata.`)
  }
  if (
    version === "3.0" &&
    !metadata.children.some(
      (item) =>
        localName(item.name) === "meta" &&
        item.attributes.get("property") === "dcterms:modified" &&
        item.text.trim()
    )
  )
    invalid("The EPUB 3 modification date is missing.")
  if (
    metadataFields.some(
      (item) =>
        localName(item.name) === "meta" &&
        ((item.attributes.get("property") === "rendition:layout" &&
          item.text.trim() === "pre-paginated") ||
          (item.attributes.get("name") === "fixed-layout" &&
            item.attributes.get("content") === "true"))
    )
  )
    unsupported("Fixed-layout EPUBs need a separate Kobo conversion path.")
  const manifest = child(packageXml, "manifest")
  const spine = child(packageXml, "spine")
  if (!manifest || !spine) invalid("The EPUB has no manifest or reading order.")
  const items = new Map<string, { element: XmlElement; path: string }>()
  let navigation = ""
  for (const item of manifest.children) {
    if (localName(item.name) !== "item") continue
    const id = item.attributes.get("id")
    const href = item.attributes.get("href")
    if (!id || !href || items.has(id)) invalid("The EPUB manifest is invalid.")
    const path = pathFromHref(packagePath, href)
    if (!archive.byName.has(path))
      invalid("The EPUB manifest references a missing file.")
    items.set(id, { element: item, path })
    if (item.attributes.get("properties")?.split(/\s+/u).includes("nav")) {
      if (navigation) invalid("The EPUB has multiple navigation documents.")
      navigation = path
    }
  }
  if (version === "3.0" && !navigation)
    invalid("The EPUB 3 navigation document is missing.")
  if (
    version === "3.0" &&
    ![...items.values()].some(
      (item) =>
        item.path === navigation &&
        item.element.attributes.get("media-type") === "application/xhtml+xml"
    )
  )
    invalid("The EPUB 3 navigation document is invalid.")
  if (version === "2.0" && spine.attributes.has("toc")) {
    const toc = items.get(spine.attributes.get("toc") ?? "")
    if (
      toc?.element.attributes.get("media-type") !== "application/x-dtbncx+xml"
    )
      invalid("The EPUB 2 table of contents reference is invalid.")
  }

  const contentPaths = new Set<string>()
  let readable = false
  for (const itemref of spine.children) {
    if (localName(itemref.name) !== "itemref") continue
    const id = itemref.attributes.get("idref")
    const item = id ? items.get(id) : undefined
    if (!item) invalid("The EPUB reading order is invalid.")
    if (item.element.attributes.get("media-type") !== "application/xhtml+xml") {
      unsupported("Only XHTML reading content can be converted to KEPUB.")
    }
    contentPaths.add(item.path)
    if (itemref.attributes.get("linear") !== "no") readable = true
  }
  if (!readable) invalid("The EPUB has no primary reading content.")
  // Some reflowable content is linked from the spine but not listed there.
  // Include all XHTML resources except navigation so such pages have Kobo spans.
  for (const { element, path } of items.values()) {
    if (
      element.attributes.get("media-type") === "application/xhtml+xml" &&
      path !== navigation
    )
      contentPaths.add(path)
  }

  return { contentPaths }
}
