# Changelog

## Unreleased

## 0.1.0 - 2026-10-31

- Extract the converter into the standalone `kepub-edge` project, under MIT.
- Stream EPUB 2/3 conversion using standard Web APIs, preserving compressed media.
- Support navigation documents in the spine and prefixed XHTML namespaces.
- Preserve typed conversion errors across Cloudflare's native compression streams.
- Default collected output to 35 MiB and bound XML nesting and token size.
- Provide built ESM, TypeScript declarations, a local Worker example, and
  independent ZIP/XML and package validation.

Initial public preview. Converter output semantics are version `2`.
Real-book coverage, deployed resource benchmarks, and physical Kobo acceptance
remain incomplete; see `VALIDATION.md`.
