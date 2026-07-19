import { mkdtemp, open, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConduitClient, normalizeEndpoint } from '../src/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeEndpoint', () => {
  it('normalizes HTTPS origins and permits loopback HTTP', () => {
    expect(normalizeEndpoint('https://conduit.example.com/')).toBe('https://conduit.example.com');
    expect(normalizeEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(normalizeEndpoint('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(normalizeEndpoint('http://[::1]:8787')).toBe('http://[::1]:8787');
  });

  it.each([
    'http://conduit.example.com',
    'ftp://conduit.example.com',
    'https://user:secret@conduit.example.com',
    'https://conduit.example.com/admin',
    'https://conduit.example.com/?debug=1',
    'not a url',
  ])('rejects an unsafe or ambiguous endpoint: %s', (endpoint) => {
    expect(() => normalizeEndpoint(endpoint)).toThrow(ApiError);
  });
});

describe('ConduitClient protocol checks', () => {
  it('does not follow redirects carrying service-token headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ConduitClient({
      endpoint: 'https://conduit.example.com',
      accessClientId: 'client-id',
      accessClientSecret: 'client-secret',
    });

    await expect(client.whoami()).rejects.toMatchObject({ auth: true, status: 302 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      headers: {
        'CF-Access-Client-Id': 'client-id',
        'CF-Access-Client-Secret': 'client-secret',
      },
    });
  });

  it('rejects an incompatible API version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: true, identity: 'test', via_bypass: true, api_version: 2 },
          { headers: { 'X-Conduit-Api-Version': '2' } },
        ),
      ),
    );
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    await expect(client.whoami()).rejects.toThrow('expected 1, got 2');
  });

  it('reports an HTML response before checking for an API version header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<!doctype html><title>Cloudflare Access</title>', {
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
        }),
      ),
    );
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    await expect(client.whoami()).rejects.toMatchObject({
      message: expect.stringContaining('expected JSON but got an HTML page'),
      auth: true,
      status: 200,
    });
  });

  it('accepts the supported API version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: true, identity: 'test', via_bypass: true, api_version: 1 },
          { headers: { 'X-Conduit-Api-Version': '1' } },
        ),
      ),
    );
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    await expect(client.whoami()).resolves.toMatchObject({ api_version: 1 });
  });

  it('follows file-list cursors until every page is collected', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const cursor = `1760000000:${firstId}`;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const requestedCursor = url.searchParams.get('cursor');
      return Response.json(
        requestedCursor
          ? {
              files: [
                {
                  id: secondId,
                  name: 'second.txt',
                  size: 2,
                  created_at: '2026-07-18T00:00:00.000Z',
                  link_count: 0,
                },
              ],
              next_cursor: null,
            }
          : {
              files: [
                {
                  id: firstId,
                  name: 'first.txt',
                  size: 1,
                  created_at: '2026-07-19T00:00:00.000Z',
                  link_count: 1,
                },
              ],
              next_cursor: cursor,
            },
        { headers: { 'X-Conduit-Api-Version': '1' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    await expect(client.listFiles()).resolves.toMatchObject([
      { id: firstId },
      { id: secondId },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondRequest.searchParams.get('cursor')).toBe(cursor);
    expect(secondRequest.searchParams.get('limit')).toBe('1000');
  });

  it('accepts a short legacy file page but rejects a full page without a cursor', async () => {
    const row = (index: number) => ({
      id: `file-${index}`,
      name: `file-${index}.txt`,
      size: index,
      created_at: '2026-07-19T00:00:00.000Z',
      link_count: 0,
    });
    const versionedPage = (files: ReturnType<typeof row>[]) =>
      Response.json({ files }, { headers: { 'X-Conduit-Api-Version': '1' } });
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    vi.stubGlobal('fetch', vi.fn(async () => versionedPage([row(1)])));
    await expect(client.listFiles()).resolves.toMatchObject([{ id: 'file-1' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => versionedPage(Array.from({ length: 1000 }, (_, index) => row(index)))),
    );
    await expect(client.listFiles()).rejects.toThrow('invalid file pagination');
  });

  it('rejects an invalid identity body even with a valid version header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({}, { headers: { 'X-Conduit-Api-Version': '1' } }),
      ),
    );
    const client = new ConduitClient({ endpoint: 'https://conduit.example.com' });

    await expect(client.whoami()).rejects.toThrow('invalid identity response');
  });

  it('never sends Access credentials to loopback HTTP', () => {
    expect(
      () =>
        new ConduitClient({
          endpoint: 'http://127.0.0.1:8787',
          accessClientId: 'client-id',
          accessClientSecret: 'client-secret',
        }),
    ).toThrow('may not be sent over HTTP');
  });

  it('rejects a single upload when the source changes during the usage check', async () => {
    const size = 1024 * 1024;
    const partSize = 5 * 1024 * 1024;
    const dir = await mkdtemp(join(tmpdir(), 'conduit-mutating-single-'));
    const path = join(dir, 'payload.bin');
    await writeFile(path, Buffer.alloc(size, 0x61));

    const requests: string[] = [];
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          requests.push(url.pathname);
          if (url.pathname.endsWith('/usage')) {
            await writeFile(path, Buffer.alloc(size, 0x62));
            const future = new Date(Date.now() + 10_000);
            await utimes(path, future, future);
            return Response.json(
              {
                used_bytes: 0,
                total_limit: 20 * 1024 * 1024,
                file_limit: 10 * 1024 * 1024,
                part_size: partSize,
                count: 0,
              },
              { headers: { 'X-Conduit-Api-Version': '1' } },
            );
          }
          if (url.pathname.endsWith('/files')) {
            return Response.json(
              {
                id: '11111111-1111-4111-8111-111111111111',
                name: 'payload.bin',
                size,
                created_at: '2026-07-19T00:00:00.000Z',
              },
              { headers: { 'X-Conduit-Api-Version': '1' } },
            );
          }
          throw new Error(`unexpected request: ${url}`);
        }),
      );

      const client = new ConduitClient({ endpoint: 'http://127.0.0.1:8787' });
      await expect(client.upload(path)).rejects.toThrow('file changed while it was being uploaded');
      expect(requests.some((request) => request.endsWith('/files'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a multipart upload when the source changes without changing size', async () => {
    const partSize = 5 * 1024 * 1024;
    const dir = await mkdtemp(join(tmpdir(), 'conduit-mutating-upload-'));
    const path = join(dir, 'payload.bin');
    await writeFile(path, Buffer.alloc(partSize + 1, 0x61));

    const requests: string[] = [];
    const versionedJson = (body: unknown) =>
      Response.json(body, { headers: { 'X-Conduit-Api-Version': '1' } });

    try {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          requests.push(url.pathname);

          if (url.pathname.endsWith('/usage')) {
            return versionedJson({
              used_bytes: 0,
              total_limit: 20 * 1024 * 1024,
              file_limit: 10 * 1024 * 1024,
              part_size: partSize,
              count: 0,
            });
          }
          if (url.pathname.endsWith('/uploads/parts')) {
            const partNumber = Number(url.searchParams.get('part'));
            if (partNumber === 1) {
              const source = await open(path, 'r+');
              try {
                await source.write(Buffer.from([0x62]), 0, 1, partSize);
              } finally {
                await source.close();
              }
              const future = new Date(Date.now() + 10_000);
              await utimes(path, future, future);
            }
            return versionedJson({ part_number: partNumber, etag: `etag-${partNumber}` });
          }
          if (url.pathname.endsWith('/uploads/abort')) {
            return versionedJson({ ok: true });
          }
          if (url.pathname.endsWith('/uploads/complete')) {
            return versionedJson({
              id: '11111111-1111-4111-8111-111111111111',
              name: 'payload.bin',
              size: partSize + 1,
              created_at: '2026-07-19T00:00:00.000Z',
            });
          }
          if (url.pathname.endsWith('/uploads')) {
            return versionedJson({
              file_id: '11111111-1111-4111-8111-111111111111',
              key: 'blobs/11111111-1111-4111-8111-111111111111',
              upload_id: 'upload-1',
              part_size: partSize,
            });
          }
          throw new Error(`unexpected request: ${url}`);
        }),
      );

      const client = new ConduitClient({ endpoint: 'http://127.0.0.1:8787' });
      await expect(client.upload(path)).rejects.toThrow('file changed while it was being uploaded');
      expect(requests.some((request) => request.endsWith('/uploads/abort'))).toBe(true);
      expect(requests.some((request) => request.endsWith('/uploads/complete'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
