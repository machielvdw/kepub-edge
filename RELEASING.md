# Releasing

The initial public preview is `0.1.0`. Publishing is a separate, explicit action
from merging a commit or creating a GitHub release.

For each npm release:

1. Run the full CI suite and review `VALIDATION.md`. Keep real-book, deployed
   CPU/memory, and physical-Kobo limitations explicit in release notes.
2. Confirm the intended npm account can publish `kepub-edge` using `npm whoami`,
   complete any required two-factor authentication, and verify package ownership.
3. Build and run `npm pack`, then review the exact tarball being published. Do not include
   book fixtures, credentials, local state, or application code from Ferry.
4. Set the version and move the changelog's Unreleased entry into a dated version
   entry. Use semantic versioning; preview APIs may change between minor releases.
5. Merge the release preparation through a pull request after all required checks
   pass. Pack from that exact clean `main` commit, and publish only after the
   maintainer explicitly chooses to make that release:

   ```sh
   npm publish ./kepub-edge-X.Y.Z.tgz --access public --registry=https://registry.npmjs.org/
   ```

6. Verify the registry version/integrity and install it in a clean test project.
   Tag the exact tested commit as `vX.Y.Z`, and create matching GitHub release notes.
   Never overwrite a release tag or attempt to reuse a published version.

For subsequent releases, prefer npm trusted publishing with GitHub Actions OIDC
and provenance over a stored long-lived token. Configure the exact repository,
workflow, and optional protected environment in npm before enabling a publishing
workflow. This repository intentionally has no automatic publishing workflow yet.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[provenance](https://docs.npmjs.com/generating-provenance-statements/).

After a package release is available, consumers such as Ferry can replace their
workspace package with the published dependency in a separately tested change.
