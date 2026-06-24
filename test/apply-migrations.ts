import { applyD1Migrations, env } from 'cloudflare:test';

// Runs before each test file, outside per-test storage isolation. applyD1Migrations
// only applies migrations that have not been applied yet, so it is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
