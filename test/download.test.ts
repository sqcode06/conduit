import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { generateToken } from '../src/lib/tokens';
import { nowSeconds } from '../src/lib/tokens';
import { seedFile, seedLink, linkRow } from './helpers';

const BASE = 'https://conduit.test';

describe('GET /d/:token — single-use capability download', () => {
  it('serves the file once, then shows the neutral unavailable page', async () => {
    const { id } = await seedFile({ body: 'payload-A' });
    const token = generateToken();
    await seedLink(id, token, { maxDownloads: 1, graceSeconds: 0 });

    const first = await SELF.fetch(`${BASE}/d/${token}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Disposition')).toContain('attachment');
    expect(first.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await first.text()).toBe('payload-A');

    const second = await SELF.fetch(`${BASE}/d/${token}`);
    expect(second.status).toBe(200); // never 403/404
    expect(await second.text()).toContain('no longer available');
  });

  it('treats an unknown token as unavailable (never 403/404)', async () => {
    const res = await SELF.fetch(`${BASE}/d/this-token-does-not-exist`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('no longer available');
  });

  it('treats an expired link as unavailable', async () => {
    const { id } = await seedFile({ body: 'x' });
    const token = generateToken();
    await seedLink(id, token, { expiresAt: nowSeconds() - 10 });
    const res = await SELF.fetch(`${BASE}/d/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('no longer available');
  });

  it('treats a revoked link as unavailable', async () => {
    const { id } = await seedFile({ body: 'x' });
    const token = generateToken();
    await seedLink(id, token, { revokedAt: nowSeconds() - 1 });
    const res = await SELF.fetch(`${BASE}/d/${token}`);
    expect(await res.text()).toContain('no longer available');
  });

  it('lets a resume within the grace window not burn a use', async () => {
    const { id } = await seedFile({ body: 'resume-me' });
    const token = generateToken();
    const { tokenHash } = await seedLink(id, token, { maxDownloads: 1, graceSeconds: 120 });

    const a = await SELF.fetch(`${BASE}/d/${token}`);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe('resume-me');

    const b = await SELF.fetch(`${BASE}/d/${token}`); // grace resume
    expect(b.status).toBe(200);
    expect(await b.text()).toBe('resume-me');

    const row = await linkRow(tokenHash);
    expect(row?.download_count).toBe(1); // only one use consumed
  });

  it('serves a 206 partial for a Range request', async () => {
    const { id } = await seedFile({ body: 'abcdefghijklmnopqrstuvwxyz' }); // 26 bytes
    const token = generateToken();
    await seedLink(id, token, { maxDownloads: 1, graceSeconds: 120 });

    const res = await SELF.fetch(`${BASE}/d/${token}`, { headers: { Range: 'bytes=5-9' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 5-9/26');
    expect(res.headers.get('Content-Length')).toBe('5');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await res.text()).toBe('fghij'); // bytes 5..9 inclusive
  });

  it('returns 416 for an unsatisfiable Range', async () => {
    const { id } = await seedFile({ body: 'tiny' }); // 4 bytes
    const token = generateToken();
    await seedLink(id, token, { maxDownloads: 1, graceSeconds: 120 });
    const res = await SELF.fetch(`${BASE}/d/${token}`, { headers: { Range: 'bytes=999-1200' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */4');
  });

  it('rejects a concurrent double-pull with grace 0 (no double-spend)', async () => {
    const { id } = await seedFile({ body: 'only-once' });
    const token = generateToken();
    const { tokenHash } = await seedLink(id, token, { maxDownloads: 1, graceSeconds: 0 });

    const [a, b] = await Promise.all([
      SELF.fetch(`${BASE}/d/${token}`),
      SELF.fetch(`${BASE}/d/${token}`),
    ]);
    const bodies = await Promise.all([a.text(), b.text()]);
    const served = bodies.filter((t) => t === 'only-once').length;
    const denied = bodies.filter((t) => t.includes('no longer available')).length;

    expect(served).toBe(1); // exactly one real download
    expect(denied).toBe(1);
    const row = await linkRow(tokenHash);
    expect(row?.download_count).toBe(1); // counter never exceeds max_downloads
  });

  it('does not consume the link on HEAD', async () => {
    const { id, size } = await seedFile({ body: 'head-then-get' });
    const token = generateToken();
    await seedLink(id, token, { maxDownloads: 1, graceSeconds: 0 });

    const head = await SELF.fetch(`${BASE}/d/${token}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(size));
    expect(await head.text()).toBe(''); // HEAD has no body

    const get = await SELF.fetch(`${BASE}/d/${token}`); // still works
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('head-then-get');
  });
});
