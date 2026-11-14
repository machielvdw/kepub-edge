# Repository Guidelines

## Project Structure & Module Organization

`kepub-edge` is a zero-runtime-dependency EPUB-to-KEPUB converter targeting
Cloudflare Workers and standard Web APIs.

- `src/`: strict TypeScript; `index.ts` exports the public API, with separate
  publication, XML/XHTML, ZIP-reading, ZIP-writing, and error modules.
- `dist/`: generated JavaScript and declarations; edit source, then rebuild.
- `tests/`: Node tests, synthetic EPUB fixtures (`fixture.mjs`), and independent
  Python output validation.
- `examples/worker/`: local Worker and Wrangler configuration.
- `scripts/`: Worker test orchestration and corpus validation.

## Build, Test, and Development Commands

Use Node 24 (22.23.4+ is also supported), npm, Python 3, and `tar`.

- `npm ci`: install locked development dependencies.
- `npm run build`: compile source and declarations into `dist/`.
- `npm run dev`: serve the local Worker at `http://localhost:8791`; build first
  and rebuild after source changes.
- `npm test`: build and run converter tests.
- `npm run typecheck`: check library and Worker TypeScript.
- `npm run test:package`: validate the packed package, independent consumer
  types, ZIP checksums, and XML namespaces.
- `npm run test:worker`: automatically start, test, and stop local Wrangler.
- `npm run format:check`: check Prettier formatting; `npm run format` fixes it.

## Coding Style & Naming Conventions

Use two-space indentation (four for Python), LF endings, and a final newline.
Prettier enforces double quotes, no semicolons, ES5 trailing commas, and an
80-column target. Use camelCase functions/variables, PascalCase types, and
UPPER_SNAKE_CASE constants. Keep ESM imports with `.js` extensions in TypeScript.
Preserve Web API portability, explicit resource limits, and lazy stream errors.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict` in `tests/*.test.mjs`, with descriptive
behavior-based names. Add small synthetic regression fixtures for behavior
changes; never commit purchased books or private metadata. No numeric coverage
threshold is configured. Run all verification commands above before submitting.

## Commit & Pull Request Guidelines

History uses short imperative subjects such as “Fix package test compiler lookup
for TypeScript 7”; follow that style. Keep PRs focused, describe the problem and
resulting behavior, link related issues, and report validation results using the
PR template. Discuss API changes or new runtime dependencies in an issue first.
Update `CHANGELOG.md` under Unreleased for user-visible changes and bump
`KEPUB_CONVERTER_VERSION` when output semantics change. Report vulnerabilities
privately through `SECURITY.md`.
