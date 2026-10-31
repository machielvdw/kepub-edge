"""Independent ZIP/XML checks using Python's standard library, not converter code.

This is a structural check, not a replacement for EPUBCheck or a physical Kobo.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import unquote
from posixpath import dirname, join, normpath

XHTML = "{http://www.w3.org/1999/xhtml}"
OPF = "{http://www.idpf.org/2007/opf}"
CONTAINER = "{urn:oasis:names:tc:opendocument:xmlns:container}"

with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, "ZIP checksum failure"
    first = archive.infolist()[0]
    assert first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED
    assert archive.read("mimetype") == b"application/epub+zip"
    container = ET.fromstring(archive.read("META-INF/container.xml"))
    package_path = container.find(f"{CONTAINER}rootfiles/{CONTAINER}rootfile").attrib["full-path"]
    package = ET.fromstring(archive.read(package_path))
    manifest = {item.attrib["id"]: item for item in package.find(f"{OPF}manifest")}
    for ref in package.find(f"{OPF}spine"):
        item = manifest[ref.attrib["idref"]]
        path = normpath(join(dirname(package_path), unquote(item.attrib["href"].split("#")[0])))
        document = ET.fromstring(archive.read(path))
        body = document.find(f"{XHTML}body")
        assert body is not None, path
        outer = body.find(f"{XHTML}div[@id='book-columns']")
        assert outer is not None, f"Wrong wrapper namespace: {path}"
        assert outer.find(f"{XHTML}div[@id='book-inner']") is not None, path
        ids = set()
        for element in document.iter():
            if "koboSpan" not in element.attrib.get("class", "").split():
                continue
            assert element.tag == f"{XHTML}span", f"Wrong span namespace: {path}"
            span_id = element.attrib["id"]
            assert span_id not in ids, f"Duplicate Kobo span: {path}"
            ids.add(span_id)
        assert ids, f"No Kobo spans: {path}"
print("Independent ZIP checksums, XML namespaces, wrappers, and span IDs passed.")
