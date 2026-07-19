# CONDUIT

Single-use file links on Cloudflare's edge. Upload a file, mint a link, send it to
someone. They open it — no account, no password — and the file streams to them once,
at full speed. Then the link is dead, and you have a record of who pulled it, from
where, and when.

CONDUIT is one Cloudflare Worker backed by R2 (files), D1 (metadata), and Cloudflare
Access (admin auth). It's self-hostable: deploy it to your own Cloudflare account and
domain. A companion CLI, [`@sqcode/conduit`](./cli), drives it from the terminal.

## Why

Most "send a file" tools keep the file around, make the recipient sign in, or hand
out links that work forever. CONDUIT treats a link as a single-use capability: it
works once, then it's gone, and every download is audited.

## Features

- **Single-use links** — one successful download, then dead. Per link you can set a
  max download count, a TTL, and a resume grace window.
- **Full-speed streaming** from R2 with HTTP Range support (resumable, parallelizable).
- **Large files** — up to 1 GiB each via R2 multipart upload, under a configurable
  total-storage cap (10 GiB by default).
- **Audited downloads** — IP, geo, device, and time for every pull, shown in the
  dashboard.
- **Access-gated admin** — the dashboard and API sit behind Cloudflare Access and are
  re-verified in the Worker; the download links are public and token-gated.
- **QR codes** for any minted link, rendered in the browser.
- **CLI** for headless use, authenticated with a Cloudflare Access service token.

## How it works

```
operator ─▶ /admin/                           dashboard (static, behind Access)
              POST /admin/api/files            small upload          ─┐
              POST /admin/api/uploads          large file (multipart) ├─▶ R2
              POST /admin/api/files/:id/links  mint a link           ─┘
                                                    │
recipient ─▶ /d/<token>   (public; the token is the only credential)
                                                    │
              atomic single-use consume (D1) ─▶ stream from R2 (Range-aware)
              download logged (geo / device / time → D1)
```

- **`/d/<token>`** — public and token-gated. A valid token streams the file
  (`200`/`206`); anything else returns a neutral "link unavailable" page — never
  `403`/`404`, and byte-identical for every reason, so it can't be used to probe which
  tokens ever existed. Not behind Access.
- **`/admin/`** — the dashboard, served as static assets and gated by Cloudflare Access
  at the edge.
- **`/admin/api/*`** — the JSON API, gated by Access and independently re-verified in
  the Worker with `jose` (deny-by-default).

### Links

Single-use by default, configurable per link:

- `max_downloads` — successful downloads allowed (default `1`).
- `expires_in_seconds` — optional TTL (`null` = no expiry).
- `grace_seconds` — opt-in resume window. Default `0` (strict: exactly one download).
  A positive value lets a dropped or large download resume within that window without
  spending the link.

Consumption is a single atomic `UPDATE … RETURNING` in D1, so two simultaneous hits on
a one-use link can never both succeed.

### Uploads

Files up to the part size (~50 MiB) upload in one request. Larger files — up to 1 GiB
— use R2 multipart: the client splits the file into parts, the Worker streams each into
R2, then completes the upload. The total-storage cap is enforced atomically. Limits
live in `src/lib/limits.ts`.

### Security

- Tokens are 256-bit (`crypto.getRandomValues`), URL-safe base64. Only the SHA-256 hash
  is stored, so a database dump can't reconstruct a working link.
- The admin API is deny-by-default: the Worker verifies the Cloudflare Access JWT
  (signature, issuer, audience) on every request, so a forged header sent straight to
  the origin is still rejected.
- The `/d/<token>` path is timing-uniform on denial and sets `Referrer-Policy:
  no-referrer`, so neither response timing nor the `Referer` header can leak a token.
- Recipient PII (IP / geo / device) lives only in the audit table and is never exposed
  on the public download path.

## Deploy your own

You need a Cloudflare account with a domain on Cloudflare (an active zone), plus R2 and
D1 enabled.

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/sqcode06/conduit && cd conduit
npm install
cp wrangler.example.jsonc wrangler.jsonc     # gitignored; holds your account ids

npx wrangler r2 bucket create conduit-blobs
npx wrangler d1 create conduit-meta          # copy the printed database_id
```

Use the Worker tag matching the installed CLI version: `@sqcode/conduit@0.1.0`
is paired with Worker tag `v0.1.0`. The CLI rejects an incompatible server API.

Fill in `wrangler.jsonc`: the `database_id` (in both `d1_databases` blocks) and your
domain in `[env.production].routes`. Then apply the schema:

```bash
npm run db:migrate:remote
```

### Cloudflare Access (one application, scoped to `/admin`)

This is what keeps `/d/<token>` public while the admin stays locked.

1. Zero Trust → Access → Applications → Add → Self-hosted.
2. Application domain: **your domain**, path **`/admin`** (covers `/admin/` and
   `/admin/api/*`; deliberately not `/d/*`).
3. Policy: **Allow**, rule **Emails = your email**. Access is deny-by-default, so this
   one rule is the whole policy.
4. Copy the **Application Audience (AUD) tag** and your **team name**
   (`<team>.cloudflareaccess.com`) into `wrangler.jsonc` under `[env.production].vars`
   as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.

For the CLI, add a second policy with action **Service Auth** for a service token.

### Deploy

```bash
npm run deploy        # wrangler deploy --env production
```

The first deploy provisions the edge certificate for your domain. `workers_dev` is off
in production, so the Worker is never reachable on an unauthenticated `*.workers.dev`
origin.

Open `https://your-domain/admin/`, sign in through Access, upload a file, mint a link,
and open it in a private window — it downloads once, then reads "link unavailable," and
the pull shows up under Recent pulls.

## Local development

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc     # gitignored local config
cp .dev.vars.example .dev.vars               # DEV_ADMIN_BYPASS=true for local admin
npm run db:migrate:local
npm run dev                                  # http://localhost:8787
```

The dev bypass (in `.dev.vars`) stands in for an Access session locally; it's
double-gated on `ENVIRONMENT !== "production"`, so it's inert in production.

```bash
npm test          # Vitest, Workers pool (real D1 + R2 via Miniflare)
npm run typecheck
```

## CLI

[`@sqcode/conduit`](./cli) pushes files and mints links from the terminal, without the
dashboard. It authenticates with a Cloudflare Access service token.

```bash
npm install -g @sqcode/conduit
conduit login
conduit push report.pdf --expires 24h        # upload + mint, copied to clipboard
conduit pulls --watch                         # live download feed
```

Full command set in [`cli/README.md`](./cli/README.md).

The CLI and Worker are one versioned contract. Install the CLI for a compatible
self-hosted CONDUIT Worker; it is not a standalone file-transfer service.

## Project layout

```
migrations/0001_init.sql   files / links / downloads schema
src/index.ts               Hono app; routes /d/* and /admin/api/*
src/routes/download.ts     public token download: consume → stream → audit
src/routes/admin.ts        admin API: upload, multipart, mint, delete, usage, feed
src/lib/limits.ts          file-size and storage-cap limits
src/lib/tokens.ts          256-bit token generation + SHA-256 hashing
src/lib/consume.ts         atomic single-use consume + grace; non-mutating peek
src/lib/stream.ts          R2 streaming + HTTP Range (200 / 206 / 416)
src/lib/access.ts          Cloudflare Access JWT verification (jose)
src/lib/audit.ts           append-only download audit
src/lib/sanitize.ts        filename / content-type sanitization
src/lib/unavailable.ts     neutral link-unavailable page
public/admin/              dependency-free dashboard (static, behind Access)
cli/                       @sqcode/conduit CLI
```

## License

[MIT](./LICENSE)
