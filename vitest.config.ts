import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Read the D1 migrations once at config load; the setup file applies them to the
// isolated in-memory D1 of each test worker. (Passed in as a binding because the
// setup file runs inside the Workers runtime, not here.)
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings (DB, BUCKET, ASSETS, vars) are taken from wrangler.jsonc.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Functional tests drive the admin API through SELF; the guarded dev
          // bypass stands in for a Cloudflare Access session. Deny-by-default is
          // covered separately in access.test.ts with explicit env.
          DEV_ADMIN_BYPASS: 'true',
          DEV_ADMIN_EMAIL: 'test@conduit.dev',
          // 5 MiB parts (R2's minimum) so the multipart test stays small.
          UPLOAD_PART_SIZE: '5242880',
        },
      },
    }),
  ],
  test: {
    // Scope to the Worker's own tests (cli/ has its own vitest project).
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
