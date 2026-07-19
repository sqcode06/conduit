import type { Context, MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from '../types';

// Cloudflare Access authenticates the operator at its edge and injects a signed
// JWT in `Cf-Access-Jwt-Assertion`. We DO NOT trust that header blindly: the
// Worker origin could be hit directly with a forged header, so we re-verify the
// signature + issuer + audience here. Deny-by-default: anything that does not
// verify is 403.

export function normalizeTeamOrigin(teamDomain: string): string | null {
  const value = teamDomain.trim();
  if (/^[a-z0-9-]+$/i.test(value)) return `https://${value}.cloudflareaccess.com`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname)
  ) {
    return null;
  }
  return url.origin;
}

// One JWKS resolver per team URL, kept for the isolate's lifetime. createRemoteJWKSet
// does NOT fetch at construction (fetch is lazy, inside jwtVerify), so this is safe
// to memoize at module scope and it caches keys across requests (no per-request refetch).
const jwksByOrigin = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(origin: string) {
  let jwks = jwksByOrigin.get(origin);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`), {
      cacheMaxAge: 600_000, // 10 min between refreshes
      cooldownDuration: 30_000, // throttle refetch on an unknown kid (key rotation)
    });
    jwksByOrigin.set(origin, jwks);
  }
  return jwks;
}

function deny(c: Context<AppEnv>) {
  return c.text('Forbidden', 403, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function requireAccess(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = c.env;
    const isProd = env.ENVIRONMENT === 'production';

    // Guarded local-dev bypass — needs the explicit flag AND a non-production env.
    // Double-gated so the bypass is structurally impossible in prod even if the
    // var leaks. DEV_ADMIN_BYPASS lives only in .dev.vars, never a prod secret.
    if (!isProd && env.DEV_ADMIN_BYPASS === 'true') {
      c.set('adminEmail', env.DEV_ADMIN_EMAIL || 'dev@localhost');
      c.set('adminViaBypass', true);
      await next();
      return;
    }

    // Fail closed if Access is misconfigured.
    if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return deny(c);

    const token = c.req.header('Cf-Access-Jwt-Assertion');
    if (!token) return deny(c);

    const origin = normalizeTeamOrigin(env.ACCESS_TEAM_DOMAIN);
    if (!origin) return deny(c);
    try {
      const { payload } = await jwtVerify(token, getJwks(origin), {
        issuer: origin, // https://<team>.cloudflareaccess.com
        audience: env.ACCESS_AUD, // Application Audience (AUD) tag
        // jose enforces exp/nbf automatically.
      });
      // Human logins carry `email`; Access service tokens (used by the CLI / other
      // headless clients) carry `common_name` instead. Accept either as the audit
      // identity; deny only if neither is present.
      const email = typeof payload.email === 'string' ? payload.email : '';
      const commonName = typeof payload.common_name === 'string' ? payload.common_name : '';
      const identity = email || commonName;
      if (!identity) return deny(c);
      c.set('adminEmail', identity);
      c.set('adminViaBypass', false);
      await next();
      return;
    } catch {
      // bad signature / wrong iss|aud / expired / malformed
      return deny(c);
    }
  };
}
