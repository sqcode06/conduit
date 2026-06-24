/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// `env` from "cloudflare:test" is typed as the generated Cloudflare.Env. Augment
// it with the migrations array we inject as a test binding.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
