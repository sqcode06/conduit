# Security policy

CONDUIT handles file delivery and capability links, so security reports are taken
seriously and handled with priority.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately, either:

- by email to **security@sqcode.dev**, or
- via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab).

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- affected version / commit,
- any suggested remediation.

We aim to acknowledge a report within a few days and to keep you updated as we
investigate and fix. We support coordinated disclosure and will credit reporters
who want it.

## Supported versions

CONDUIT is pre-1.0. Security fixes target the latest `main` and the most recent
`0.x` release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Scope notes

- The `/d/<token>` download path is intentionally public and token-gated — a
  valid capability token is the only credential. Reports about "the link works
  without a login" are expected behavior, not a vulnerability.
- The admin surface is meant to be deny-by-default behind Cloudflare Access **and**
  the Worker's own JWT verification. Any way to reach `/admin/api/*` without a valid
  Access identity is in scope.
- Any way to make a single-use link serve more than its intended number of
  successful downloads (outside the documented grace window) is in scope.
