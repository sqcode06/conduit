import { readFileSync } from 'node:fs';

interface PackageManifest {
  version: string;
}

// This resolves to cli/package.json from both src/version.ts and dist/conduit.js.
const manifestUrl = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as PackageManifest;

export const VERSION = manifest.version;
