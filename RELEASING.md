# Releasing

Repository creation does not publish a package to npm. The initial `0.1.0`
release is prepared but unpublished; npm name availability is not a reservation.

Before the first npm release:

1. Run the full CI suite and review `VALIDATION.md`. Keep real-book, deployed
   CPU/memory, and physical-Kobo limitations explicit in release notes.
2. Confirm the intended npm account can publish `kepub-edge`, enable account
   two-factor authentication, and verify package ownership.
3. Review `npm pack --dry-run` for the exact files being published. Do not include
   book fixtures, credentials, local state, or application code from Ferry.
4. Set the version and move the changelog's Unreleased entry into a dated version
   entry. Use semantic versioning; preview APIs may change between minor releases.
5. Publish only after the maintainer explicitly chooses to make that release.
   Tag the exact tested commit as `vX.Y.Z`, and create matching GitHub release notes.

For subsequent releases, prefer npm trusted publishing with GitHub Actions OIDC
and provenance over a stored long-lived token. Configure the exact repository,
workflow, and optional protected environment in npm before enabling a publishing
workflow. This repository intentionally has no automatic publishing workflow yet.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/).

After a package release is available, consumers such as Ferry can replace their
workspace package with the published dependency in a separately tested change.
