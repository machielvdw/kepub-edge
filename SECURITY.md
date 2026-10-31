# Security policy

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/machielvdw/kepub-edge/security/advisories/new).
Do not publish exploit EPUBs or sensitive book content in public issues.

Include the affected version/commit, runtime, expected and observed behavior,
and a minimal reproduction you have permission to share. ZIP parsing, resource
limit bypasses, and unexpected network/filesystem access are security concerns.
Ordinary rendering or compatibility problems can use the bug-report template.

During the early preview, fixes target `main` and the latest published `0.1.x`
version. Upgrade to the latest patch release for security fixes. There are no
long-term support branches or guaranteed response times.

Resource limits are defense in depth. Applications should enforce upload limits,
access controls, and concurrency budgets. Conversion does not sanitize active
EPUB content for embedding in a web page, remove DRM, or validate every EPUB rule.
