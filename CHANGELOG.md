# Changelog

All notable changes to CONDUIT are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

Initial release: a single-use file-exchange Worker, an admin dashboard, and a CLI.

### Added

- **Single-use download links** (`/d/<token>`): one successful download by default,
  with per-link `max_downloads`, an optional TTL, and an opt-in resume grace window.
  Consumption is a single atomic `UPDATE … RETURNING`, so concurrent hits on a one-use
  link can't both succeed.
- **R2 streaming** with HTTP Range support (`200` / `206` / `416`), zero buffering.
- **Large-file uploads** via R2 multipart (up to 1 GiB per file), under a configurable
  total-storage cap (10 GiB by default), with a `/usage` endpoint.
- **Admin API** behind Cloudflare Access and re-verified in the Worker (deny-by-default):
  upload, multipart upload, list, mint link, delete, usage, and a recent-downloads feed.
- **Admin dashboard** (dependency-free): drag-and-drop and chunked uploads with progress,
  a storage-usage bar, a recent-pulls feed, and QR codes for minted links.
- **Append-only download audit** — IP, geo, device, and time from `request.cf`.
- **`@sqcode/conduit` CLI**: `login`, `doctor`, `push`, `ls`, `link`, `pulls`, `rm`, `qr`,
  and an interactive menu; authenticates with a Cloudflare Access service token.
- Vitest (Workers pool) test suite and a CI pipeline.

### Security

- 256-bit CSPRNG tokens (`crypto.getRandomValues`); only the SHA-256 hash is stored.
- Timing-uniform `/d` denials on `GET` and `HEAD`; the "link unavailable" page is
  byte-identical for every reason (never `403`/`404`).
- `Referrer-Policy: no-referrer` on download responses and hardened static-asset headers.
- Atomic storage-cap enforcement and multipart part validation.

[Unreleased]: https://github.com/sqcode06/conduit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sqcode06/conduit/releases/tag/v0.1.0
