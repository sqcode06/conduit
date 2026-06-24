import { defineConfig } from 'vitest/config';

// Isolated from the Worker's vitest config (which uses the Workers pool). The CLI
// tests are plain Node unit tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
