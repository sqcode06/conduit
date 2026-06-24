# Changelog

All notable changes to CONDUIT are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Release notes are owned by a human — the entries below are factual stubs you can
> rewrite to taste.

## [Unreleased]

## [0.1.0] - 2026-06-24

### Added

- Single-use capability-link download path (`/d/<token>`): atomic consume with an
  optional TTL and a configurable grace window for resumed downloads.
- R2 streaming with HTTP Range support (200 / 206 / 416), zero buffering.
- Admin API behind Cloudflare Access + in-Worker JWT verification (deny-by-default):
  upload, list, mint link, delete, recent-downloads feed.
- Append-only download audit (geo / device / time from `request.cf`).
- Neutral "link unavailable" page for all denial reasons (never 403/404).
- Dependency-free admin dashboard.
- Vitest (Workers pool) test suite.

[Unreleased]: https://github.com/sqcode06/conduit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sqcode06/conduit/releases/tag/v0.1.0
