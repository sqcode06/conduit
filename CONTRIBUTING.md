# Contributing to CONDUIT

Thanks for your interest. CONDUIT is a self-hostable, single-use secure file-exchange
tool: a Cloudflare Worker backed by R2, D1, and Cloudflare Access, plus a CLI.
Contributions are welcome.

## Ground rules

- Be decent to each other — see the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Read the [AI use policy](./AI-USE.md): code may be AI-assisted, but the words in
  commits, PRs, issues, and releases are owned by a human.
- **Never report a security issue in a public issue** — see [SECURITY.md](./SECURITY.md).

## Development

See the [README](./README.md) for full setup. In short:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Before opening a PR:

```bash
npm test
npm run typecheck
```

Add or update tests when you change routing, the consume/grace logic, Range/streaming,
the admin API, or input sanitization. Security-sensitive changes should come with a test
that pins the invariant they protect.

## Commits

- **Commits must be signed.** This repository requires verified, signed commits;
  unsigned commits are rejected by branch protection. Set up signing once:

  ```bash
  # SSH signing (simplest if you already push over SSH)
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/id_ed25519.pub
  git config commit.gpgsign true
  ```

  Then add that key as a **Signing key** in your GitHub account settings. GPG signing
  is also fine (`git config gpg.format openpgp`); see GitHub's docs on commit signature
  verification.

- Write your own commit messages — clear and imperative
  ("Add Range support to the download path"). A suggested message is only a suggestion;
  make it yours.
- Keep pull requests focused, reference any related issue, and make sure tests and
  typecheck are green.

## Versioning

CONDUIT follows [Semantic Versioning](https://semver.org). Notable changes are recorded
in [CHANGELOG.md](./CHANGELOG.md); add an entry under `[Unreleased]` in your own words.
