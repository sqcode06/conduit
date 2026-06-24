import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { readJson, waitFor } from './helpers';

// Dev bypass (set in vitest.config.ts) stands in for a Cloudflare Access session.
const API = 'https://conduit.test/admin/api';

describe('admin API', () => {
  it('uploads, lists, mints, downloads once, and logs the pull', async () => {
    const up = await SELF.fetch(`${API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Filename': encodeURIComponent('réport final.txt') },
      body: 'hello world',
    });
    expect(up.status).toBe(201);
    const file = await readJson<{ id: string; name: string; size: number }>(up);
    expect(file.name).toBe('réport final.txt'); // unicode + space preserved
    expect(file.size).toBe(11);

    const list = await readJson<{ files: Array<{ id: string; link_count: number }> }>(
      await SELF.fetch(`${API}/files`),
    );
    expect(list.files.some((f) => f.id === file.id)).toBe(true);

    const mint = await SELF.fetch(`${API}/files/${file.id}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_downloads: 1, grace_seconds: 0 }),
    });
    expect(mint.status).toBe(201);
    const link = await readJson<{ url: string; token: string; expires_at: string | null }>(mint);
    expect(link.url).toContain('/d/');
    expect(link.expires_at).toBeNull();

    // The capability link works once...
    const dl = await SELF.fetch(link.url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('hello world');
    expect(dl.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");

    // ...and only once.
    const again = await SELF.fetch(link.url);
    expect(await again.text()).toContain('no longer available');

    // The pull lands in the audit feed (written via waitUntil).
    const feed = await waitFor(async () => {
      const r = await SELF.fetch(`${API}/downloads?limit=10`);
      const { downloads } = await readJson<{
        downloads: Array<{ status: string; file_name: string | null }>;
      }>(r);
      return downloads.length > 0 ? downloads : null;
    });
    expect(feed.some((d) => d.status === 'ok')).toBe(true);
  });

  it('clamps mint parameters to safe bounds', async () => {
    const up = await readJson<{ id: string }>(
      await SELF.fetch(`${API}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Filename': 'c.txt' },
        body: 'data',
      }),
    );
    const link = await readJson<{ max_downloads: number; grace_seconds: number; expires_at: string | null }>(
      await SELF.fetch(`${API}/files/${up.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_downloads: 0, grace_seconds: -50, expires_in_seconds: 3600 }),
      }),
    );
    expect(link.max_downloads).toBe(1); // clamped up from 0
    expect(link.grace_seconds).toBe(0); // clamped up from -50
    expect(typeof link.expires_at).toBe('string'); // TTL applied
  });

  it('deletes a file and revokes its links', async () => {
    const up = await readJson<{ id: string }>(
      await SELF.fetch(`${API}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Filename': 'temp.txt' },
        body: 'bye',
      }),
    );
    const link = await readJson<{ url: string }>(
      await SELF.fetch(`${API}/files/${up.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );

    const del = await SELF.fetch(`${API}/files/${up.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const res = await SELF.fetch(link.url); // link revoked by the delete
    expect(await res.text()).toContain('no longer available');
  });
});
