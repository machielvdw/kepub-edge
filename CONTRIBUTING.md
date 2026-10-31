# Contributing

Bug reports, compatibility fixtures, documentation, and focused pull requests
are welcome. Please discuss API changes and new runtime dependencies in an issue
before implementing them. Keep conversion portable across standard Web APIs.

## Development

Use Node 24 (Node 22.23.4+ is also tested), npm, Python 3, and `tar`.
Python and tar are development-only tools for independent package validation.

```sh
npm ci
npm test
npm run typecheck
npm run test:package
npm run test:worker
npm run format:check
```

`test:worker` starts and stops a local Wrangler instance automatically. It does
not deploy or require a Cloudflare account. `npm run dev` starts an interactive
local example after `npm run build`. Rebuild after changing converter source.

## Pull requests

- Keep changes focused and explain the input/behavior being fixed.
- Add a small regression fixture for behavior changes. Synthetic fixtures are
  preferred; do not commit purchased books, private metadata, or unauthorized
  copyrighted content.
- Keep resource limits and lazy stream errors explicit. Preserve compressed
  media and existing book structure wherever possible.
- Bump `KEPUB_CONVERTER_VERSION` when output semantics change, and describe
  user-visible changes under Unreleased in `CHANGELOG.md`.
- Run the checks above. `npm run format` applies formatting.

Contributions are made under this repository's MIT license. By submitting a
contribution, you confirm you have the right to contribute it under that license.
No CLA or signed-off-by trailer is required.

For vulnerabilities, use [private reporting](SECURITY.md), not a public issue.
See [the code of conduct](CODE_OF_CONDUCT.md) for community expectations.
