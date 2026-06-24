import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { conduit: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  minify: false,
  sourcemap: false,
  // Shebang so the published bin is directly executable.
  banner: { js: '#!/usr/bin/env node' },
});
