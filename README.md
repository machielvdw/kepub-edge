# kepub-edge

[![CI](https://github.com/machielvdw/kepub-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/machielvdw/kepub-edge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Streaming EPUB-to-KEPUB conversion for Cloudflare Workers and the web.**

Convert reflowable EPUB books for Kobo's enhanced reader using standard Web
APIs. No runtime dependencies, native binaries, Wasm, DOM, or Node compatibility
flag. Images and fonts keep their original compressed bytes; chapters are
transformed and compressed incrementally.

- Cloudflare Workers first, with a complete local Worker example.
- ESM and TypeScript declarations, with a small stream/Blob API.
- Explicit input, output, expansion, and markup limits.
- Browser Web Workers supporting raw-deflate Compression/DecompressionStream can
  use the same library; browser compatibility is not yet covered by CI.

**Early preview:** source is available under MIT; the npm package has not been
published yet. Real-book coverage, deployed CPU/memory benchmarks, and physical
Kobo acceptance are still being established. See [validation](VALIDATION.md).

## Get started from source

Development requires Node 24 (or Node 22.23.4+) and npm.

```sh
git clone https://github.com/machielvdw/kepub-edge.git
cd kepub-edge
npm ci
npm run build
npm run dev
```

POST a book to the local Worker from a second terminal:

```sh
curl --fail-with-body --data-binary @book.epub \
  http://localhost:8791/ --output book.kepub.epub
```

To use the library in another local project, run `npm pack` here and install the
resulting `kepub-edge-0.1.0.tgz` there with `npm install /path/to/the/tarball.tgz`.
The package contains built JavaScript and declarations; consumers do not need
TypeScript to execute it.

## API

```ts
import { convertEpubToKepubBlob, KepubError } from "kepub-edge"

try {
  const kepub = await convertEpubToKepubBlob(epubBytes)
  // Save this Blob as `title.kepub.epub` for Kobo's enhanced renderer.
} catch (error) {
  if (!(error instanceof KepubError)) throw error
  // "invalid_epub" | "unsupported_epub" | "too_large"
  console.error(error.code, error.message)
}
```

`convertEpubToKepub(input: Uint8Array)` resolves to a lazy
`ReadableStream<Uint8Array>`. Metadata errors reject the call; chapter errors can
occur during consumption. Consume it fully before marking an output as stored,
and cancel it when abandoning conversion. Do not mutate the input until finished.

`convertEpubToKepubBlob(input, maxBytes = DEFAULT_MAX_BLOB_BYTES)` collects the
output and rejects on any conversion error. The default is **35 MiB**. Overrides
must be positive safe integers no greater than 128 MiB; invalid values reject
with `RangeError`. Larger overrides require a measured memory budget.

`KEPUB_CONVERTER_VERSION` identifies output semantics for cached variants.
Version `"3"` also recognizes existing Kobo spans and preserves prepared chapters.

## Cloudflare Worker example

[The complete example](examples/worker/worker.ts) counts actual upload bytes and
collects conversion output before responding. Malformed chapters return a
structured 422 response; size-limit failures return 413. It has no R2, D1, or
Node bindings. From this repository root:

```sh
npm run build
npm run dev
```

In a second terminal:

```sh
curl --fail-with-body --data-binary @book.epub \
  http://localhost:8791/ --output book.kepub.epub
```

Add application authentication and concurrency controls before exposing a
conversion endpoint. For R2, use the Blob helper to supply a known body length
and publish the object only after storage completes.

For lower output memory, the streaming API can feed an HTTP response directly:

```ts
import { convertEpubToKepub } from "kepub-edge"

return new Response(await convertEpubToKepub(epubBytes), {
  headers: {
    "Content-Type": "application/epub+zip",
    "Content-Disposition": 'attachment; filename="book.kepub.epub"',
  },
})
```

Once headers are sent, a chapter error terminates the download. An outer
`try/catch` cannot turn that late error into a JSON response.

## Supported input

Reflowable EPUB 2 and 3 with UTF-8 XHTML reading content. Default and prefixed
XHTML namespaces are supported; embedded SVG/MathML are preserved. Kobo sentence
reference spans and body wrappers are added to reading documents. Navigation
receives spans when it appears in the spine; otherwise it is unchanged. Package
XML, NCX, links, and unrelated files are preserved. Images/fonts retain their
compressed bytes, including recognized IDPF/Adobe font obfuscation.

Existing KEPUB chapters are validated and keep their original compressed bytes,
markup, and Kobo reference IDs. Detection uses XHTML content, not filenames.
Chapters without Kobo spans are converted, including in mixed-format books.

DRM/encrypted content, ZIP64, fixed-layout, and non-XHTML-spine books are rejected.
The bounded parser does not repair arbitrary malformed books or resolve external
DTDs. Common XHTML doctypes and their named entities are retained. Keep the
original EPUB available when conversion fails.

## Resource limits

| Resource                       | Limit                   |
| ------------------------------ | ----------------------- |
| Compressed input buffer        | 25 MiB                  |
| ZIP entries                    | 4,096                   |
| Inflated or converted entry    | 50 MiB                  |
| Total declared input expansion | 100 MiB                 |
| Entry expansion ratio          | 1,000:1                 |
| Streaming output               | 128 MiB                 |
| Collected Blob output, default | 35 MiB                  |
| Kobo spans per XHTML document  | 500,000                 |
| XHTML nesting                  | 256 elements            |
| XHTML markup token             | 64 Ki UTF-16 code units |

Streaming retains the input, metadata, nesting state, and a bounded text/tag
window without inflating whole chapters. Chapters are inspected before conversion;
unprepared chapters are read a second time to add spans. The Blob helper also
retains copied output chunks. Blob construction, upload buffering, application state, garbage
collection, and concurrent requests add to peak memory. **The 35 MiB cap is a
conservative default, not a memory-safety guarantee.**

Cloudflare documents 128 MB per isolate (shared across concurrent requests) and
10 ms CPU per Free HTTP request. Do not assume conversion fits the Free plan.
Benchmark representative books on the intended paid configuration and inspect
CPU/memory metrics before choosing concurrency or raising limits. Local request
duration is not deployed Worker CPU time.
See [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/).

## Verification

```sh
npm test
npm run typecheck
npm run test:package
npm run test:worker
npm run format:check
```

The package test requires Python 3 and `tar`. It imports a tarball outside the
workspace, typechecks an independent consumer, and verifies ZIP checksums and
XML namespaces with Python's standard library. CI also runs the standalone
Worker tests. See [validation evidence](VALIDATION.md) for corpus, benchmark,
and physical-device checks that remain necessary before release.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull requests, and
[SECURITY.md](SECURITY.md) to report vulnerabilities privately. Compatibility
reports with small, redistributable fixtures are especially useful.

## License and origins

[MIT](LICENSE). Originally developed as the converter inside Ferry and extracted
into a standalone library. This is an independent project, not affiliated with
Rakuten Kobo or Cloudflare.
