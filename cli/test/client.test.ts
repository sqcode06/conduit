import { describe, expect, it, vi } from 'vitest';
import type { ConduitClient, FileRow } from '../src/api';

vi.mock('../src/ui', () => ({
  die(message: string, code = 1): never {
    throw Object.assign(new Error(message), { exitCode: code });
  },
}));

import { resolveFile } from '../src/client';

const files: FileRow[] = [
  {
    id: 'deadbeef-1111-4111-8111-111111111111',
    name: 'report.pdf',
    size: 42,
    created_at: '2026-07-19T00:00:00.000Z',
    link_count: 0,
  },
];

function clientWithFiles(): ConduitClient {
  return { listFiles: async () => files } as unknown as ConduitClient;
}

describe('resolveFile', () => {
  it('resolves exact IDs and exact names when prefixes are disabled', async () => {
    await expect(
      resolveFile(clientWithFiles(), files[0]!.id, { allowIdPrefix: false }),
    ).resolves.toBe(files[0]);
    await expect(
      resolveFile(clientWithFiles(), files[0]!.name, { allowIdPrefix: false }),
    ).resolves.toBe(files[0]);
  });

  it('rejects a unique ID prefix when prefixes are disabled', async () => {
    await expect(
      resolveFile(clientWithFiles(), 'deadbeef', { allowIdPrefix: false }),
    ).rejects.toThrow('no exact file matching');
  });

  it('preserves prefix resolution for non-destructive callers', async () => {
    await expect(resolveFile(clientWithFiles(), 'deadbeef')).resolves.toBe(files[0]);
  });
});
