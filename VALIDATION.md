# Validation and release evidence

This package is an early preview released under the MIT license. Structural
tests do not establish universal EPUB compatibility or prove a physical Kobo
can import the result. npm publication is tracked separately from this repository.

## Automated evidence

- Converter tests cover EPUB 2/3, navigation inside/outside the spine,
  prefixed/default XHTML namespaces, foreign content, obfuscated fonts,
  compressed media preservation, streaming errors/cancellation, and limits.
- An isolated tarball test exercises public ESM exports and TypeScript
  declarations. Python's independent ZIP/XML implementations verify checksums,
  wrapper/span namespaces, and duplicate span IDs for generated fixtures.
- A standalone Wrangler Worker runs without `nodejs_compat` and exercises
  success, invalid/unsupported EPUBs, late compression errors, chunked upload
  bounds, and HTTP method handling.
- Before extraction, Ferry's D1/R2 integration suite passed, including its
  optional 23 MiB media-heavy case. Those application tests remain in Ferry;
  this repository verifies the standalone library and Worker.

## Real-book corpus and benchmarks

Use books you are allowed to test. Keep private books and output out of this
repository. Include EPUB 2/3, navigation in the spine, nested inline markup,
non-Latin/RTL text, font obfuscation, illustrations, and files near the input
limit. Record provenance, source hash, converter version, runtime, and results.

After building, run the corpus tool with explicit input paths:

```sh
node scripts/check-corpus.mjs /path/to/book.epub /path/to/another.epub
```

Set `EPUBCHECK_JAR=/path/to/epubcheck.jar` to validate original and converted
EPUBs independently with EPUBCheck (requires Java). Otherwise the report marks
EPUBCheck as not run. Temporary converted files are removed.

Set `KEPUB_WORKER_URL=http://127.0.0.1:8791` to send books to the example instead
of converting in Node. Only use an endpoint you trust with those books. The tool
reports sizes and elapsed time; Node CPU time is reported only for in-process
conversion. Neither measures deployed Worker CPU or peak isolate memory.
For production evidence, use an authorized deployed instance and collect
Cloudflare CPU/memory metrics under representative concurrency. Record plan,
compatibility date, runtime, and repeated-run distributions.

There is no checked-in representative real-book corpus or deployed CPU/memory
benchmark. The defaults must not be advertised as guaranteeing Free-plan
compatibility or safe concurrency.

## Physical Kobo acceptance

Record device model, firmware, source hash, converter version, and transfer
method. Check import, cover, chapter navigation, text/image layout, font changes,
highlights across inline markup, bookmarks, reading progress, and reopening.
Include navigation pages in the reading order and both EPUB versions.
Physical-device results remain unverified until recorded here.
