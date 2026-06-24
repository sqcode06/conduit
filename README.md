# CONDUIT

**A secure file conduit on the edge.** Upload a file, mint a single-use capability
link, hand it to one person. They open the link — no password, no account — and the
file streams to them at full speed, once. Then the link is dead. Every pull is logged
(who, where, what device, when). The admin surface sits behind Cloudflare Access; the
download links don't.

> Runs as a single Cloudflare Worker: **Workers + R2 + D1 + Cloudflare Access**.
> Domain: `conduit.sqcode.dev`.

---

## How it works

```
 operator ──▶ /admin/  (static UI, behind Cloudflare Access)
                │  POST /admin/api/files          upload → R2
                │  POST /admin/api/files/:id/links mint capability link
                ▼
        conduit.sqcode.dev/d/<token>   ◀── recipient (no Access, token is the credential)
                │
                ▼   atomic single-use consume (D1) ──▶ stream from R2 (Range-aware)
            download logged (geo/device/time → D1)
```

- **`/d/<token>`** — public, token-gated. A valid token streams the file (`200`/`206`),
  anything else returns a neutral _“link unavailable”_ page (**never** `403`/`404`, so it
  can’t be used to probe which tokens existed). **Not** behind Access.
- **`/admin/`** — the dashboard (static assets), gated by **Cloudflare Access** at the edge.
- **`/admin/api/*`** — the JSON API (Worker), gated by Access **and** independently
  re-verified in-Worker with `jose` (deny-by-default).

### Link semantics

Single-use by default, with options per link:

- **`max_downloads`** — successful pulls allowed (default `1`).
- **`expires_in_seconds`** — optional TTL (`null` = no expiry).
- **`grace_seconds`** — opt-in resume window. Default `0` (strict: exactly one download). Set a
  positive value to let a dropped or large download resume within that many seconds without
  burning the link.

Consumption is one atomic `UPDATE … RETURNING` in D1, so two simultaneous hits on a
one-use link can never both succeed.

### Security model

- Tokens are **256-bit** (`crypto.getRandomValues`), URL-safe base64. Only the **SHA-256
  hash** is stored — a database dump cannot reconstruct a working link.
- Admin is **deny-by-default**: the Worker verifies the Cloudflare Access JWT (signature +
  issuer + audience) on every `/admin/api/*` request, so even a direct hit on the origin
  with a forged header is rejected.
- Recipient PII (IP / geo / device) lives only in the `downloads` audit table and is never
  exposed on the public download path.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # sets DEV_ADMIN_BYPASS=true for local admin access
npm run db:migrate:local           # apply migrations to the local D1
npm run dev                        # wrangler dev → http://localhost:8787
```

- Admin UI: `http://localhost:8787/admin/`
- The dev bypass (in `.dev.vars`) stands in for a Cloudflare Access session locally. It is
  double-gated (`ENVIRONMENT !== "production"`), so it is structurally dead in production.

### Tests & checks

```bash
npm test        # vitest (Workers pool: real D1 + R2 in miniflare)
npm run typecheck
```

---

## First-time Cloudflare setup

You need a Cloudflare account with the `sqcode.dev` zone, R2, and D1 enabled.

```bash
# 1. Create the resources
npx wrangler r2 bucket create conduit-blobs
npx wrangler d1 create conduit-meta      # copy the printed database_id ...

# 2. Paste database_id into wrangler.jsonc (both the top-level and [env.production] d1 block)

# 3. Apply migrations to the remote DB
npm run db:migrate:remote
```

### Cloudflare Access (one application, scoped to `/admin`)

This is the part that makes `/d/<token>` public while the admin stays locked:

1. **Zero Trust → Access → Applications → Add → Self-hosted.**
2. Application domain: **`conduit.sqcode.dev`** with path **`/admin`** (this covers
   `/admin/` and `/admin/api/*`; it deliberately does **not** cover `/d/*`).
3. Add a policy: **Allow**, rule **Emails = your operator email**. (Access is
   deny-by-default, so this one Allow is the whole policy.)
4. Copy the **Application Audience (AUD) Tag** and your **team name**
   (`<team>.cloudflareaccess.com`).
5. Put them in `wrangler.jsonc` under `[env.production].vars`:
   `ACCESS_AUD` = the AUD tag, `ACCESS_TEAM_DOMAIN` = your team name.

> A non-interactive client (e.g. the upcoming CLI) authenticates with an **Access service
> token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) — add it as a second policy.

### Deploy

```bash
npm run deploy      # wrangler deploy --env production
```

The first deploy provisions the edge certificate for `conduit.sqcode.dev` (the zone must be
active). `workers_dev` is disabled in production so the Worker is never reachable on an
unauthenticated `*.workers.dev` origin.

### Smoke test

1. Open `https://conduit.sqcode.dev/admin/` → Access login → dashboard.
2. Drop a file, **Mint link**, copy the `…/d/<token>` URL.
3. Open it in a private window (no Access prompt) → file downloads.
4. Open it again → _“link unavailable.”_ The pull appears in **Recent pulls**.

---

## Layout

```
migrations/0001_init.sql   files / links / downloads schema (system of record)
src/index.ts               Hono app: routes /d/* and /admin/api/*
src/routes/download.ts     public token download (consume → stream → audit)
src/routes/admin.ts        admin API (upload / list / mint / delete / downloads)
src/lib/tokens.ts          256-bit token gen + SHA-256 hashing
src/lib/consume.ts         atomic single-use + grace consume (and non-mutating peek)
src/lib/stream.ts          R2 streaming + HTTP Range (200 / 206 / 416)
src/lib/access.ts          Cloudflare Access JWT verification (jose), deny-by-default
src/lib/audit.ts           append-only download audit (geo/device from request.cf)
src/lib/unavailable.ts     neutral link-unavailable page
public/admin/              dependency-free admin dashboard (static, behind Access)
```
