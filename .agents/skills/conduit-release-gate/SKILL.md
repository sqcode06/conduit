---
name: conduit-release-gate
description: Prove that a Conduit release candidate is safe and useful before publishing the @sqcode/conduit npm CLI or creating a GitHub Release. Use for release preparation, package audits, CLI-and-Worker compatibility checks, packed-artifact smoke tests, adversarial release review, or a publish/no-publish decision in the Conduit repository.
---

# Conduit Release Gate

Treat the publishable product as one contract: the `@sqcode/conduit` tarball plus a compatible self-hosted Worker. Test the artifact users receive, not only the source tree.

## Preserve the release boundary

- Never run `npm publish`, create a GitHub Release, push a tag, or deploy the Worker without explicit user approval for that exact external action.
- Keep the root Worker package private. Publish only `cli/`.
- Record the candidate commit, package version, Node version, and dirty-tree state in the verdict.
- Preserve unrelated user changes. Do not clean or reset the worktree.

## Run the deterministic gate

1. Read `references/release-criteria.md`.
2. Run `npm run release:check -- --allow-dirty` while developing.
3. Run `npm run release:check` on the final clean candidate.
4. Require CI to cover Node 20 and 22 for the CLI. Treat a local run on another Node version as supporting evidence only.
5. Retain the generated tarball path and test that exact tarball before publishing it.

The gate must verify:

- Worker and CLI typechecks and tests; release-mode Worker tests must use a temporary
  configuration and must not load the developer's `.dev.vars`.
- CLI build, package contents, executable mode, and version synchronization.
- Clean installation of the tarball and `conduit --help` / `--version`.
- A black-box local journey through the Worker: `doctor`, `push`, `ls`, one successful download, one rejected reuse, `pulls`, and `rm`.
- Absence of obvious secrets or development-only files in the tarball.
- Full-commit pinning for external GitHub Actions used by CI and publication.

Use `scripts/run-release-gate.mjs` directly only when diagnosing a gate phase. Prefer the package script for normal use.

## Convene an independent council

Use isolated reviewers only after the deterministic checks produce artifacts. Give each reviewer raw paths and one mandate; do not reveal expected findings.

1. Assign an artifact reviewer to inspect the tarball, manifest, executable, and release workflow.
2. Assign an integration reviewer to inspect the packed CLI-to-Worker journey and compatibility behavior.
3. Assign a security reviewer to inspect endpoint handling, redirects, credentials, destructive commands, and supply-chain controls.
4. Assign a cold-user reviewer to follow only the published READMEs.
5. Assign a verifier to reproduce or falsify each surviving finding independently.

When `$lean-swarm` is available, use its terse Simplified-Chinese policy for delegation prompts and internal summaries. Keep code, commands, paths, logs, and shipped artifacts in the repository's English conventions.

Require every finding to include severity, confidence, evidence with file/line references, reproduction steps, and the smallest credible remediation. Reject style-only opinions and unsupported speculation from the release verdict.

## Decide

Return exactly one verdict:

- `PASS`: every required deterministic check passed and no verified blocker remains.
- `CONDITIONAL`: deterministic checks passed, but explicitly listed non-blocking work remains.
- `FAIL`: a required check failed, the tested artifact differs from the publish target, or a verified blocker remains.

Summarize evidence, blockers, accepted risks, and the next authorized action. Never convert a `PASS` into publication authority.
