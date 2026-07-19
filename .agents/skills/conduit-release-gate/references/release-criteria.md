# Release criteria

## Required evidence

| Surface | Required proof |
| --- | --- |
| Candidate | Clean commit, release tag `v<package.version>`, changelog entry |
| Worker | Fresh install, generated Cloudflare types, hermetic test config, typecheck, complete test suite |
| CLI source | Node 20 and 22 typecheck, tests, and build |
| Tarball | Expected files only, executable `bin`, matching manifest and displayed version |
| Installation | Install the tarball into an empty prefix; run `--help` and `--version` |
| Contract | Packed CLI completes the local Worker journey without source imports |
| Security | HTTPS except loopback development; no credential-bearing redirect follows; config remains `0600` |
| Supply chain | Lockfiles used; Actions pinned to full commits; exact tested tarball published; provenance enabled |
| Documentation | A cold reader can distinguish self-hosted Worker setup from CLI installation |

## Blocking conditions

Treat any of these as `FAIL`:

- The tarball cannot be installed or invoked on a supported Node version.
- `conduit --version` differs from `cli/package.json`.
- The CLI and Worker disagree on the supported API contract.
- A service-token secret can be sent over non-loopback HTTP or forwarded to another origin.
- The tested tarball is not the artifact selected for publication.
- A required Worker, CLI, or black-box test fails.
- Secrets, environment files, source maps containing secrets, or account-specific configuration enter the tarball.
- Documentation presents the CLI as useful without disclosing its compatible Worker requirement.

## Conditional findings

Allow `CONDITIONAL` only for bounded issues that do not break installation, the primary journey, security boundaries, or data integrity. Record an owner and follow-up issue for each accepted item.

## Council evidence format

```text
Severity: blocker | high | medium | low
Confidence: high | medium | low
Claim: one falsifiable sentence
Evidence: path:line plus command or artifact
Reproduction: minimal steps
Impact: concrete user or release consequence
Remediation: smallest credible change
```

Have the verifier mark each finding `confirmed`, `rejected`, or `unresolved`. An unresolved possible blocker keeps the verdict at `FAIL` until resolved.
