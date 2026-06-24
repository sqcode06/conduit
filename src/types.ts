import type { Context } from 'hono';

// Worker bindings + vars (see wrangler.jsonc). R2Bucket/D1Database/Fetcher are
// global from @cloudflare/workers-types.
export interface Bindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Dev-only, from .dev.vars (never a production secret):
  DEV_ADMIN_BYPASS?: string;
  DEV_ADMIN_EMAIL?: string;
}

// Set by the Access middleware for downstream handlers / audit trail.
export interface Variables {
  adminEmail: string;
  adminViaBypass: boolean;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type AppContext = Context<AppEnv>;
